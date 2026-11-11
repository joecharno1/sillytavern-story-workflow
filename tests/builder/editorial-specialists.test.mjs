import test from 'node:test';
import assert from 'node:assert/strict';
import { runEditorialWorkflow } from '../../extensions/StoryBuilder/editorial-workflow.js';
import { analyzeDraft, applyParagraphReplacement } from '../../extensions/StoryBuilder/story-counts.js';

const report = (issues = []) => ({ summary: 'Synthetic review.', strengths: [], issues });
const issue = (paragraph, problem) => ({ severity: 'medium', category: 'prose', paragraphs: [paragraph], problem, suggestion: 'Clarify the existing passage without adding events.' });
const text = Array.from({ length: 9 }, (_, index) => `Mara carried the sealed compass past courtyard gate ${index + 1}.`).join('\n\n');
const specialist = id => ({ id, label: id, instruction: `Check the existing ${id} details.`, model: `fixture/${id}` });
const preferences = () => ({ model: 'fixture/reviewer', revisionModel: 'fixture/reviser', maxOutput: 16384,
    writingGuidance: 'Keep the requested point of view.', specialists: [specialist('dialogue'), specialist('physical')] });
function job() {
    return { source: { snapshot: { id: 'synthetic' }, latestBrief: 'Carry the sealed compass to the harbor.',
        messages: [{ role: 'system', content: 'Keep the agreed world facts.' }, { role: 'user', content: 'Carry the sealed compass to the harbor.' }] },
    settings: { sectionCount: 1, wordMin: 1, wordMax: 10000, paragraphMin: 1, paragraphMax: 100, strictParagraphs: false },
    sections: [{ text }], pending: null, status: 'complete', _busy: false };
}
function service(overrides = {}) {
    const calls = { reviews: [], revisions: [] };
    return { calls, api: {
        createManuscriptSnapshot(source, context, settings) { return { source, history: structuredClone(context.messages), analysis: analyzeDraft(source, settings) }; },
        async reviewManuscript(snapshot, focus, settings, transport) {
            calls.reviews.push({ focus, model: settings.model, text: snapshot.source });
            return overrides.review?.(snapshot, focus, settings, transport) ?? report();
        },
        async reviseManuscript(snapshot, ids, instruction, settings, transport) {
            calls.revisions.push({ ids, instruction, settings: structuredClone(settings) });
            if (overrides.revise) return overrides.revise(snapshot, ids, instruction, settings, transport);
            const replacement = 'Mara kept the sealed compass steady while crossing the courtyard.';
            return { replacement, updated: applyParagraphReplacement(snapshot.source, snapshot.analysis, ids, replacement) };
        },
    } };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('all configured specialists start independently and use the same complete manuscript', async () => {
    const current = job(), gates = new Map(), started = deferred(), settings = preferences();
    settings.specialists.push(specialist('character'), specialist('atmosphere'));
    const mock = service({ review: (snapshot, focus) => {
        assert.equal(snapshot.source, text);
        assert.deepEqual(snapshot.history, current.source.messages);
        const gate = deferred(); gates.set(focus, gate);
        if (gates.size === 6) started.resolve();
        return gate.promise;
    } });
    const running = runEditorialWorkflow(current, mock.api, {}, { settings });
    await started.promise;
    for (const gate of gates.values()) gate.resolve(report());
    const result = await running;
    assert.deepEqual(result.cycles[0].focuses, ['continuity', 'prose', 'dialogue', 'physical', 'character', 'atmosphere']);
    assert.equal(result.reports.length, 6);
    assert.equal(result.text, text);
    assert.equal(mock.calls.revisions.length, 0);
    assert.deepEqual(mock.calls.reviews.map(call => call.model), ['fixture/reviewer', 'fixture/reviewer', 'fixture/dialogue', 'fixture/physical', 'fixture/character', 'fixture/atmosphere']);
});

test('a denied specialist preserves successful reviewers and resumes only that focus', async () => {
    const current = job(), settings = preferences(); let blocked = true;
    const mock = service({ review: (_snapshot, focus) => {
        if (focus === 'physical' && blocked) { const error = new Error('Synthetic spending stop.'); error.name = 'SpendLimitError'; throw error; }
        return report();
    } });
    await assert.rejects(runEditorialWorkflow(current, mock.api, {}, { settings }), { name: 'SpendLimitError' });
    assert.equal(current.editorial.reports.length, 3);
    assert.equal(current.editorial.text, text);
    assert.equal(current.editorial.phase, 'review');
    blocked = false;
    await runEditorialWorkflow(current, mock.api, {}, { settings });
    assert.deepEqual(mock.calls.reviews.map(call => call.focus), ['continuity', 'prose', 'dialogue', 'physical', 'physical']);
    assert.equal(current.editorial.status, 'ready');
});

for (const [label, change] of [
    ['review model', settings => { settings.model = 'fixture/other'; }],
    ['revision model', settings => { settings.revisionModel = 'fixture/other'; }],
    ['selected guidance', settings => { settings.writingGuidance += ' A changed preference.'; }],
    ['specialist model', settings => { settings.specialists[0].model = 'fixture/other'; }],
    ['specialist instruction', settings => { settings.specialists[0].instruction += ' Changed.'; }],
    ['enabled focuses', settings => { settings.specialists.pop(); }],
]) test(`a saved checkpoint rejects changed ${label} without making another request`, async () => {
    const current = job(), settings = preferences(), mock = service();
    await runEditorialWorkflow(current, mock.api, {}, { settings });
    const reports = structuredClone(current.editorial.reports), source = structuredClone(current.source.messages);
    change(settings);
    await assert.rejects(runEditorialWorkflow(current, mock.api, {}, { settings }), /editorial models or writing guidance changed/);
    assert.equal(mock.calls.reviews.length, 4);
    assert.deepEqual(current.editorial.reports, reports);
    assert.deepEqual(current.source.messages, source);
    assert.equal(current.editorial.text, text);
});

test('legacy two-focus checkpoints resume without adding specialist calls', async () => {
    const current = job(), mock = service();
    await runEditorialWorkflow(current, mock.api);
    delete current.editorial.configuration;
    for (const cycle of current.editorial.cycles) delete cycle.focuses;
    current.editorial = JSON.parse(JSON.stringify(current.editorial));
    await runEditorialWorkflow(current, mock.api);
    assert.equal(mock.calls.reviews.length, 2);
    assert.deepEqual(current.editorial.configuration.specialists, []);
    assert.equal(current.editorial.status, 'ready');
});

test('legacy checkpoints cannot silently add a newly enabled specialist', async () => {
    const current = job(), mock = service();
    await runEditorialWorkflow(current, mock.api);
    delete current.editorial.configuration;
    await assert.rejects(runEditorialWorkflow(current, mock.api, {}, { settings: preferences() }), /older editorial checkpoint/);
    assert.equal(mock.calls.reviews.length, 2);
    assert.equal(current.editorial.text, text);
});

test('source changes after specialist receipt prevent patching and cache the received report', async () => {
    const current = job(), settings = preferences(), gate = deferred(), started = deferred(); let isCurrent = true;
    const mock = service({ review: (_snapshot, focus) => {
        if (focus === 'dialogue') { started.resolve(); return gate.promise; }
        return report();
    } });
    const running = runEditorialWorkflow(current, mock.api, { isCurrent: () => isCurrent }, { settings });
    await started.promise;
    isCurrent = false; gate.resolve(report([issue(2, 'Dialogue speaker unclear.')]));
    await assert.rejects(running, /source changed/);
    assert.equal(current.editorial.text, text);
    assert.equal(mock.calls.revisions.length, 0);
    assert.equal(current.editorial.cycles[0].reviews.dialogue.state, 'received');
    isCurrent = true;
    // Resume validates the cached report, then makes one patch and fresh reviews.
    await runEditorialWorkflow(current, mock.api, { isCurrent: () => isCurrent }, { settings, maxCycles: 2 });
    assert.equal(mock.calls.reviews.filter(call => call.focus === 'dialogue' && call.text === text).length, 1);
    assert.ok(current.editorial.changes.length >= 1);
});

test('changing guidance while a specialist is pending prevents accepting that report', async () => {
    const current = job(), settings = preferences(), gate = deferred(), started = deferred();
    const mock = service({ review: (_snapshot, focus) => {
        if (focus === 'dialogue') { started.resolve(); return gate.promise; }
        return report();
    } });
    const running = runEditorialWorkflow(current, mock.api, {}, { settings });
    await started.promise;
    settings.writingGuidance = 'Changed while waiting.';
    gate.resolve(report());
    await assert.rejects(running, /models or writing guidance changed/);
    assert.equal(current.editorial.text, text);
    assert.equal(current.editorial.cycles[0].reviews.dialogue.state, 'received');
    assert.equal(mock.calls.revisions.length, 0);
});

test('specialist and general findings share one per-round revision limit', async () => {
    const current = job(), settings = preferences();
    const mock = service({ review: (snapshot, focus) => snapshot.source !== text ? report()
        : report(focus === 'dialogue' ? [issue(2, 'Dialogue issue.')] : focus === 'physical' ? [issue(4, 'Physical issue.')] : focus === 'prose' ? [issue(6, 'Prose issue.')] : []) });
    const result = await runEditorialWorkflow(current, mock.api, {}, { settings, maxCycles: 1, maxGroupsPerCycle: 2 });
    assert.equal(mock.calls.revisions.length, 2);
    assert.deepEqual(mock.calls.revisions.map(call => call.settings.model), ['fixture/physical', 'fixture/dialogue']);
    assert.ok(result.unresolved.some(item => item.focus === 'prose' && /limit/.test(item.reason)));
    assert.equal(mock.calls.reviews.length, 8);
});

for (const [label, change] of [
    ['unknown focus', settings => { settings.specialists[0].id = 'other'; }],
    ['duplicate focus', settings => { settings.specialists.push({ ...settings.specialists[0] }); }],
    ['empty model', settings => { settings.specialists[0].model = ''; }],
    ['missing instruction', settings => { delete settings.specialists[0].instruction; }],
    ['oversized guidance', settings => { settings.writingGuidance = 'x'.repeat(40001); }],
    ['invalid revision model type', settings => { settings.revisionModel = 0; }],
]) test(`invalid ${label} cannot start model work`, async () => {
    const current = job(), settings = preferences(), mock = service(); change(settings);
    await assert.rejects(runEditorialWorkflow(current, mock.api, {}, { settings }), /configuration is invalid/);
    assert.equal(mock.calls.reviews.length, 0);
    assert.equal(current.editorial, undefined);
});
