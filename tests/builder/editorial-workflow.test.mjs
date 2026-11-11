import test from 'node:test';
import assert from 'node:assert/strict';
import { runEditorialWorkflow } from '../../extensions/StoryBuilder/editorial-workflow.js';
import { analyzeDraft, applyParagraphReplacement } from '../../extensions/StoryBuilder/story-counts.js';

const prose = (count = 8) => Array.from({ length: count }, (_, i) => `Mara crossed the quiet courtyard at bell ${i + 1}.`).join('\n\n');
function makeJob(text = prose(), settings = {}) {
    return {
        source: { snapshot: { id: 'synthetic-source' }, latestBrief: 'Keep the compass brass and finish the crossing.',
            messages: [{ role: 'user', content: 'Keep the compass brass and finish the crossing.' }] },
        settings: { sectionCount: 1, wordMin: 1, wordMax: 10000, paragraphMin: 1, paragraphMax: 100,
            strictParagraphs: true, ...settings },
        sections: [{ text, auxiliary: 'synthetic retained auxiliary', reasoning: 'synthetic retained planning' }],
        pending: null, status: 'complete', calls: 5, usage: { inputTokens: 30, outputTokens: 50, cost: 0.1 }, _busy: false,
    };
}
const issue = (paragraphs, extras = {}) => ({ severity: 'high', category: 'continuity', paragraphs,
    problem: `The compass detail is inconsistent in paragraph ${paragraphs.join(', ')}.`,
    suggestion: 'Restore the established brass compass.', ...extras });
const report = (issues = []) => ({ summary: 'Synthetic report.', strengths: ['Clear viewpoint.'], issues });
function services(overrides = {}) {
    const calls = { reviews: [], revisions: [] };
    return { calls, api: {
        createManuscriptSnapshot(text, source, settings) {
            return { source: text, analysis: analyzeDraft(text, settings), brief: source.latestBrief,
                history: structuredClone(source.messages), requestTemplate: {} };
        },
        async reviewManuscript(snapshot, focus, settings, transport) {
            calls.reviews.push({ text: snapshot.source, focus });
            return overrides.review ? await overrides.review(snapshot, focus, settings, transport) : report();
        },
        async reviseManuscript(snapshot, ids, instruction, settings, transport) {
            calls.revisions.push({ text: snapshot.source, ids, instruction });
            if (overrides.revise) return overrides.revise(snapshot, ids, instruction, settings, transport);
            const replacement = 'Mara held the brass compass steady.';
            return { updated: applyParagraphReplacement(snapshot.source, snapshot.analysis, ids, replacement), replacement };
        },
    } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

for (const strictParagraphs of [false, true]) test(`every editorial snapshot preserves strictParagraphs=${strictParagraphs}`, async () => {
    const job = makeJob(prose(), { strictParagraphs });
    const original = job.sections[0].text;
    const mock = services({ review: async (snapshot, focus) => report(
        focus === 'prose' && snapshot.source === original ? [issue([2], { severity: 'medium', category: 'prose' })] : []),
    });
    const captured = [];
    const createSnapshot = mock.api.createManuscriptSnapshot;
    mock.api.createManuscriptSnapshot = (text, source, settings) => {
        captured.push({ ...settings });
        return createSnapshot(text, source, settings);
    };
    const state = await runEditorialWorkflow(job, mock.api, {}, {
        settings: { model: 'test/editor', strictParagraphs: !strictParagraphs },
    });
    assert.equal(state.status, 'ready');
    assert.equal(mock.calls.revisions.length, 1);
    assert.ok(captured.length >= 5, 'initial reviewers, revision and fresh reviewers must receive snapshots');
    assert.ok(captured.every(settings => settings.strictParagraphs === strictParagraphs));
    assert.ok(captured.every(settings => settings.model === 'test/editor'));
});

test('both full-manuscript reviewers start independently and final analysis is local', async () => {
    const job = makeJob(), gates = { continuity: deferred(), prose: deferred() }, bothStarted = deferred();
    const mock = services({ review: async (snapshot, focus) => {
        assert.equal(snapshot.source, job.sections[0].text);
        if (mock.calls.reviews.length === 2) bothStarted.resolve();
        return gates[focus].promise;
    } });
    const running = runEditorialWorkflow(job, mock.api);
    await bothStarted.promise;
    gates.prose.resolve(report()); gates.continuity.resolve(report());
    const state = await running;
    assert.equal(state.status, 'ready');
    assert.equal(state.analysis.words, analyzeDraft(job.sections[0].text).words);
    assert.deepEqual(state.targetChecks, { wordTargetMet: true, paragraphTargetMet: true, formatValid: true });
    assert.equal(state.reports.length, 2);
    assert.equal(state.passed, true);
    assert.equal(mock.calls.revisions.length, 0);
    assert.equal(job.status, 'complete');
    assert.equal(job._busy, false);
});

test('a failed reviewer awaits its sibling and resumes only the failed call', async () => {
    const job = makeJob(), gate = deferred(), started = deferred();
    let failedOnce = false, finished = false;
    const mock = services({ review: async (_snapshot, focus) => {
        if (focus === 'continuity' && !failedOnce) { failedOnce = true; throw new Error('Temporary provider failure.'); }
        if (focus === 'prose') { started.resolve(); return gate.promise; }
        return report();
    } });
    const running = runEditorialWorkflow(job, mock.api).catch(error => { finished = true; return error; });
    await started.promise;
    await Promise.resolve();
    assert.equal(finished, false, 'allSettled waits for the surviving request');
    gate.resolve(report());
    assert.match((await running).message, /Temporary provider/);
    assert.equal(job.editorial.status, 'failed');
    assert.equal(job.editorial.reports.length, 1);
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.status, 'ready');
    assert.deepEqual(mock.calls.reviews.map(call => call.focus), ['continuity', 'prose', 'continuity']);
});

test('only actionable high and medium findings become local patches; originals survive', async () => {
    const job = makeJob(), before = structuredClone(job.sections), original = job.sections[0].text;
    const findings = [issue([2]), issue([5], { severity: 'medium' }), issue([7], { severity: 'low' }), issue([], { problem: 'General concern.' })];
    const mock = services({ review: async (snapshot, focus) => focus === 'continuity' && snapshot.source === original ? report(findings) : report() });
    const state = await runEditorialWorkflow(job, mock.api);
    assert.deepEqual(mock.calls.revisions.map(call => call.ids), [[5], [2]]);
    assert.equal(mock.calls.reviews.length, 4, 'both focuses re-review the revised manuscript');
    assert.deepEqual(job.sections, before);
    assert.equal(state.originalText, original);
    assert.equal(state.versions[0].text, original);
    assert.equal(state.versions.length, 3);
    assert.equal(state.changes.length, 2);
    assert.ok(state.unresolved.some(item => item.severity === 'low'));
    assert.ok(state.unresolved.some(item => item.problem === 'General concern.'));
    assert.equal(state.status, 'ready');
    assert.equal(state.hasUnresolved, true);
    assert.equal(state.passed, false);
});

test('overlapping findings merge into one contiguous range while unrelated bytes stay exact', async () => {
    const original = prose(8).replace(/\n\n/g, '\r\n\r\n');
    const job = makeJob(original);
    const mock = services({ review: async (snapshot, focus) => snapshot.source === original
        ? report(focus === 'continuity' ? [issue([2, 3])] : [issue([3, 4], { severity: 'medium' })]) : report() });
    const state = await runEditorialWorkflow(job, mock.api);
    assert.deepEqual(mock.calls.revisions.map(call => call.ids), [[2, 3, 4]]);
    const range = analyzeDraft(original).countedParagraphs;
    assert.equal(state.text, original.slice(0, range[1].start) + 'Mara held the brass compass steady.' + original.slice(range[3].end));
    assert.equal(state.changes[0].issues.length, 2);
});

test('later patches run first so paragraph splits do not invalidate earlier paragraph anchors', async () => {
    const job = makeJob(), original = job.sections[0].text;
    const mock = services({ review: async (snapshot, focus) => focus === 'prose' && snapshot.source === original
        ? report([issue([2]), issue([6])]) : report(),
    revise: async (snapshot, ids) => {
        const replacement = ids[0] === 6 ? 'Mara held the compass.\n\nRain tapped the brass.' : 'The compass pointed north.';
        return { replacement, updated: applyParagraphReplacement(snapshot.source, snapshot.analysis, ids, replacement) };
    } });
    const state = await runEditorialWorkflow(job, mock.api);
    assert.deepEqual(mock.calls.revisions.map(call => call.ids), [[6], [2]]);
    assert.equal(state.analysis.paragraphs, 9);
    assert.ok(state.text.includes('The compass pointed north.'));
    assert.ok(state.text.includes('Mara held the compass.\n\nRain tapped the brass.'));
});

test('revision cycles are capped at two and both reviewers run after each changed pass', async () => {
    const job = makeJob(); let revision = 0;
    const mock = services({ review: async (_snapshot, focus) => report(focus === 'continuity' ? [issue([2])] : []),
        revise: async (snapshot, ids) => {
            const replacement = `Mara steadied the compass for repair ${++revision}.`;
            return { replacement, updated: applyParagraphReplacement(snapshot.source, snapshot.analysis, ids, replacement) };
        } });
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(mock.calls.revisions.length, 2);
    assert.equal(mock.calls.reviews.length, 6);
    assert.equal(state.cycles.length, 3);
    assert.equal(state.status, 'ready');
    assert.equal(state.unresolved.length, 1);
    assert.equal(state.passed, false);
});

test('review-only mode completes with findings and no patches', async () => {
    const job = makeJob(), mock = services({ review: async () => report([issue([2])]) });
    const state = await runEditorialWorkflow(job, mock.api, {}, { maxCycles: 0 });
    assert.equal(mock.calls.reviews.length, 2);
    assert.equal(mock.calls.revisions.length, 0);
    assert.equal(state.status, 'ready');
    assert.equal(state.unresolved.length, 2);
});

test('no pass can schedule more than six groups and deferred findings remain visible', async () => {
    const job = makeJob(prose(16)), original = job.sections[0].text;
    const mock = services({ review: async (snapshot, focus) => report(snapshot.source === original && focus === 'continuity'
        ? Array.from({ length: 8 }, (_, i) => issue([i * 2 + 1])) : []) });
    const state = await runEditorialWorkflow(job, mock.api, {}, { maxCycles: 1 });
    assert.equal(mock.calls.revisions.length, 6);
    assert.equal(state.cycles[0].groups.length, 6);
    assert.equal(state.unresolved.filter(item => item.reason.includes('group limit')).length, 2);
});

test('ranges exceeding twelve paragraphs or 2500 words are reported instead of rewritten', async () => {
    const longParagraph = Array(2501).fill('word').join(' ') + '.';
    const job = makeJob(`${longParagraph}\n\n${prose(16)}`), original = job.sections[0].text;
    const mock = services({ review: async (_snapshot, focus) => report(focus === 'continuity'
        ? [issue([1]), issue([2, 14])] : []) });
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(mock.calls.revisions.length, 0);
    assert.equal(state.text, original);
    assert.equal(state.unresolved.length, 2);
});

test('neither one large range nor disjoint patches may cover the entire manuscript', async () => {
    for (const findings of [[issue([1, 2, 3])], [issue([1]), issue([2]), issue([3])]]) {
        const job = makeJob(prose(3)), original = job.sections[0].text;
        const mock = services({ review: async (snapshot, focus) => report(focus === 'continuity' && snapshot.source === original ? findings : []) });
        const state = await runEditorialWorkflow(job, mock.api, {}, { maxCycles: 1 });
        assert.ok(mock.calls.revisions.length <= 2);
        assert.ok(state.unresolved.length > 0);
    }
    const job = makeJob(prose(1)), mock = services({ review: async () => report([issue([1])]) });
    await runEditorialWorkflow(job, mock.api);
    assert.equal(mock.calls.revisions.length, 0);
});

test('pause after one saved patch resumes the remaining patch without repeating reviews or revisions', async () => {
    const job = makeJob(), original = job.sections[0].text, controller = new AbortController();
    const mock = services({ review: async (snapshot, focus) => report(snapshot.source === original && focus === 'continuity'
        ? [issue([2]), issue([6])] : []) });
    await assert.rejects(runEditorialWorkflow(job, mock.api, {}, { signal: controller.signal, onProgress(event) {
        if (event.stage === 'editorial_change') controller.abort();
    } }), { name: 'AbortError' });
    assert.equal(job.editorial.status, 'paused');
    assert.equal(job.editorial.changes.length, 1);
    assert.equal(job.sections[0].text, original);
    const saved = job.editorial.text;
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.status, 'ready');
    assert.equal(state.changes.length, 2);
    assert.equal(mock.calls.revisions.length, 2);
    assert.equal(mock.calls.reviews.length, 4);
    assert.equal(state.versions[1].text, saved);
});

test('a received revision is cached on pause but is not applied until guards pass on resume', async () => {
    const job = makeJob(), original = job.sections[0].text, controller = new AbortController();
    const mock = services({ review: async (snapshot, focus) => report(snapshot.source === original && focus === 'continuity' ? [issue([2])] : []),
        revise: async (snapshot, ids) => {
            const replacement = 'Mara gripped the brass compass.';
            const updated = applyParagraphReplacement(snapshot.source, snapshot.analysis, ids, replacement);
            controller.abort();
            return { updated, replacement };
        } });
    await assert.rejects(runEditorialWorkflow(job, mock.api, {}, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(job.editorial.text, original);
    assert.equal(job.editorial.cycles[0].groups[0].state, 'received');
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.status, 'ready');
    assert.equal(state.changes.length, 1);
    assert.equal(mock.calls.revisions.length, 1);
});

test('received review results survive cancellation without a paid repeat', async () => {
    const job = makeJob(), controller = new AbortController(), gate = deferred(), both = deferred();
    const mock = services({ review: async () => {
        if (mock.calls.reviews.length === 2) both.resolve();
        await gate.promise;
        return report();
    } });
    const running = runEditorialWorkflow(job, mock.api, {}, { signal: controller.signal });
    await both.promise; controller.abort(); gate.resolve();
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal(job.editorial.status, 'paused');
    assert.equal(job.editorial.reports.length, 0);
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.reports.length, 2);
    assert.equal(mock.calls.reviews.length, 2);
});

test('already-aborted work records a resumable pause without sending requests', async () => {
    const job = makeJob(), controller = new AbortController(), mock = services(); controller.abort();
    await assert.rejects(runEditorialWorkflow(job, mock.api, {}, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(job.editorial.status, 'paused');
    assert.equal(mock.calls.reviews.length, 0);
    assert.equal(job._busy, false);
    assert.equal((await runEditorialWorkflow(job, mock.api)).status, 'ready');
});

test('stale source prevents calls, and source changes after a returned candidate prevent mutation', async () => {
    const job = makeJob(), original = job.sections[0].text; let current = false;
    const mock = services({ review: async (snapshot, focus) => report(snapshot.source === original && focus === 'continuity' ? [issue([2])] : []),
        revise: async (snapshot, ids) => {
            const replacement = 'Mara held the compass.';
            const updated = applyParagraphReplacement(snapshot.source, snapshot.analysis, ids, replacement);
            current = false;
            return { updated, replacement };
        } });
    const transport = { assertCurrent: async () => current };
    await assert.rejects(runEditorialWorkflow(job, mock.api, transport), /source changed/);
    assert.equal(mock.calls.reviews.length, 0);
    current = true;
    await assert.rejects(runEditorialWorkflow(job, mock.api, transport), /source changed/);
    assert.equal(job.editorial.text, original);
    assert.equal(job.editorial.changes.length, 0);
    current = true;
    const state = await runEditorialWorkflow(job, mock.api, transport);
    assert.equal(state.status, 'ready');
    assert.equal(mock.calls.revisions.length, 1);
});

test('a guard failure immediately after mutation rolls the uncommitted patch back for safe resume', async () => {
    const job = makeJob(), original = job.sections[0].text; let failMutation = true;
    const mock = services({ review: async (snapshot, focus) => report(snapshot.source === original && focus === 'continuity' ? [issue([2])] : []) });
    const transport = { assertCurrent: async () => {
        if (failMutation && job.editorial?.changes.length) { failMutation = false; throw new Error('Synthetic source changed.'); }
    } };
    await assert.rejects(runEditorialWorkflow(job, mock.api, transport), /Synthetic source changed/);
    assert.equal(job.editorial.text, original);
    assert.equal(job.editorial.versions.length, 1);
    assert.equal(job.editorial.cycles[0].nextGroup, 0);
    const state = await runEditorialWorkflow(job, mock.api, transport);
    assert.equal(state.changes.length, 1);
    assert.equal(mock.calls.revisions.length, 1);
});

test('malformed reports retry only the affected reviewer', async () => {
    const job = makeJob(); let bad = true;
    const mock = services({ review: async (_snapshot, focus) => {
        if (bad && focus === 'continuity') { bad = false; return report([issue([99])]); }
        return report();
    } });
    await assert.rejects(runEditorialWorkflow(job, mock.api), /invalid issue references/);
    await runEditorialWorkflow(job, mock.api);
    assert.deepEqual(mock.calls.reviews.map(call => call.focus), ['continuity', 'prose', 'continuity']);
});

test('revisions that alter bytes outside the selected range are retained only as rejected proposals', async () => {
    const job = makeJob(), original = job.sections[0].text;
    const mock = services({ review: async (_snapshot, focus) => report(focus === 'continuity' ? [issue([2])] : []),
        revise: async () => ({ updated: 'Entirely replaced manuscript.', replacement: 'Mara repaired the compass.' }) });
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.text, original);
    assert.equal(state.changes.length, 0);
    assert.equal(state.status, 'ready');
    assert.equal(state.cycles[0].groups[0].state, 'rejected');
    assert.match(state.cycles[0].groups[0].error, /outside its selected range/);
});

test('planning, headings, script markup, empty and oversized replacement output cannot regress the manuscript', async () => {
    for (const replacement of ['<think>Hidden reasoning.', '# New heading\n\nMara crossed.', '<script>alert(1)</script>Mara crossed.', '', Array(2501).fill('word').join(' ')]) {
        const job = makeJob(), original = job.sections[0].text;
        const mock = services({ review: async (_snapshot, focus) => report(focus === 'continuity' ? [issue([2])] : []),
            revise: async (snapshot) => {
                const paragraph = snapshot.analysis.countedParagraphs[1];
                return { replacement, updated: snapshot.source.slice(0, paragraph.start) + replacement + snapshot.source.slice(paragraph.end) };
            } });
        const state = await runEditorialWorkflow(job, mock.api);
        assert.equal(state.text, original);
        assert.equal(state.changes.length, 0);
        assert.equal(state.status, 'ready');
        assert.ok(state.unresolved.length);
    }
});

test('preexisting blocked or non-story output is reported without sending ambiguous text to reviewers', async () => {
    for (const text of ['<think>Unclosed planning.', '# Unexpected heading\n\nMara crossed the courtyard.']) {
        const job = makeJob(text), mock = services();
        const state = await runEditorialWorkflow(job, mock.api);
        assert.equal(state.status, 'ready');
        assert.equal(state.targetChecks.formatValid, false);
        assert.equal(state.passed, false);
        assert.equal(mock.calls.reviews.length, 0);
        assert.ok(state.unresolved.some(item => item.category === 'format'));
    }
});

test('a revision cannot move a valid manuscript outside its required word range', async () => {
    const original = prose(), counts = analyzeDraft(original);
    const job = makeJob(original, { wordMin: counts.words, wordMax: counts.words, paragraphMin: 8, paragraphMax: 8 });
    const mock = services({ review: async (snapshot, focus) => report(snapshot.source === original && focus === 'continuity' ? [issue([2, 3])] : []) });
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.status, 'ready');
    assert.deepEqual(state.targetChecks, { wordTargetMet: true, paragraphTargetMet: true, formatValid: true });
    assert.equal(state.text, original);
    assert.ok(state.unresolved.some(item => item.reason.includes('required whole-manuscript word target')));
    assert.equal(state.passed, false);
});

test('strict paragraph regression is rejected even when word count stays in range', async () => {
    const original = prose(), job = makeJob(original, { paragraphMin: 8, paragraphMax: 8 });
    const mock = services({ review: async (snapshot, focus) => report(snapshot.source === original && focus === 'continuity' ? [issue([2, 3])] : []) });
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.text, original);
    assert.equal(state.targetChecks.paragraphTargetMet, true);
    assert.ok(state.unresolved.some(item => item.reason.includes('required whole-manuscript paragraph target')));
});

test('preexisting required target mismatches remain explicit in final checks', async () => {
    const job = makeJob(prose(), { wordMin: 1000, wordMax: 1100, paragraphMin: 10, paragraphMax: 12 }), mock = services();
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.status, 'ready');
    assert.deepEqual(state.targetChecks, { wordTargetMet: false, paragraphTargetMet: false, formatValid: true });
    assert.ok(state.unresolved.some(item => item.id === 'final:words' && item.severity === 'high'));
    assert.ok(state.unresolved.some(item => item.id === 'final:paragraphs' && item.severity === 'high'));
    assert.equal(state.passed, false);
});

test('an already outside target manuscript can improve but cannot worsen its measured distance', async () => {
    for (const improves of [false, true]) {
        const original = prose(), job = makeJob(original, { wordMin: 100, wordMax: 120 });
        const mock = services({ review: async (snapshot, focus) => report(snapshot.source === original && focus === 'continuity' ? [issue([2])] : []),
            revise: async (snapshot, ids) => {
                const replacement = improves ? Array(20).fill('compass').join(' ') + '.' : 'Mara crossed.';
                return { replacement, updated: applyParagraphReplacement(snapshot.source, snapshot.analysis, ids, replacement) };
            } });
        const state = await runEditorialWorkflow(job, mock.api);
        assert.equal(state.changes.length, improves ? 1 : 0);
        assert.equal(state.targetChecks.wordTargetMet, false);
        assert.equal(state.status, 'ready');
    }
});

test('an advisory paragraph mismatch stays visible without failing an otherwise clean editorial pass', async () => {
    const job = makeJob(prose(8), { paragraphMin: 9, paragraphMax: 10, strictParagraphs: false }), mock = services();
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.targetChecks.paragraphTargetMet, false);
    assert.equal(state.unresolved.find(item => item.id === 'final:paragraphs').severity, 'low');
    assert.equal(state.passed, true);
});

test('serialized checkpoints resume without redoing completed model work', async () => {
    const job = makeJob(), original = job.sections[0].text; let fail = true;
    const mock = services({ review: async (snapshot, focus) => report(snapshot.source === original && focus === 'continuity' ? [issue([2]), issue([6])] : []),
        revise: async (snapshot, ids) => {
            if (ids[0] === 2 && fail) { fail = false; throw new Error('Temporary revision failure.'); }
            const replacement = 'Mara checked her compass.';
            return { replacement, updated: applyParagraphReplacement(snapshot.source, snapshot.analysis, ids, replacement) };
        } });
    await assert.rejects(runEditorialWorkflow(job, mock.api), /Temporary revision/);
    assert.equal(job.editorial.changes.length, 1);
    job.editorial = JSON.parse(JSON.stringify(job.editorial));
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.changes.length, 2);
    assert.deepEqual(mock.calls.revisions.map(call => call.ids), [[6], [2], [2]]);
    assert.equal(mock.calls.reviews.length, 4);
});

test('a pause during the final notification resumes validation and returns ready without extra reviews', async () => {
    const job = makeJob(), mock = services(), controller = new AbortController();
    await assert.rejects(runEditorialWorkflow(job, mock.api, {}, { signal: controller.signal, onProgress(event) {
        if (event.stage === 'editorial_ready') controller.abort();
    } }), { name: 'AbortError' });
    assert.equal(job.editorial.phase, 'complete');
    assert.equal(job.editorial.status, 'paused');
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.status, 'ready');
    assert.equal(mock.calls.reviews.length, 2);
});

test('transport hooks pass through once and ready replay incurs no new calls', async () => {
    const job = makeJob(), mock = services({ review: async (_snapshot, _focus, settings, transport) => {
        assert.equal(settings.model, 'test/editor');
        await transport.onRequest({ model: settings.model });
        await transport.onUsage({ prompt_tokens: 7, completion_tokens: 9, cost: 0.02 });
        return report();
    } });
    const transport = { onRequest: () => job.calls++, onUsage: usage => {
        job.usage.inputTokens += usage.prompt_tokens; job.usage.outputTokens += usage.completion_tokens; job.usage.cost += usage.cost;
    } };
    const options = { settings: { model: 'test/editor' } };
    const state = await runEditorialWorkflow(job, mock.api, transport, options);
    assert.equal(job.calls, 7);
    assert.equal(job.usage.inputTokens, 44);
    assert.equal(job.usage.outputTokens, 68);
    assert.equal(await runEditorialWorkflow(job, mock.api, transport, options), state);
    assert.equal(job.calls, 7);
    assert.equal(mock.calls.reviews.length, 2);
});

test('changed completed sections, source, snapshot identity or required targets reject saved checkpoints', async () => {
    for (const mutate of [job => { job.sections[0].text += ' Extra.'; }, job => { job.settings.wordMin = 2; },
        job => { job.source.snapshot.id = 'changed'; }, job => { job.source.snapshot = { ...job.source.snapshot }; },
        job => { job.source.messages[0].content += ' Different.'; }]) {
        const job = makeJob(), mock = services();
        await runEditorialWorkflow(job, mock.api);
        mutate(job);
        await assert.rejects(runEditorialWorkflow(job, mock.api), /completed writing or its targets changed/);
        assert.equal(mock.calls.reviews.length, 2);
        assert.equal(job._busy, false);
    }
});

test('invalid limits, incomplete writing and concurrent use never start model work', async () => {
    const mock = services();
    for (const options of [{ maxCycles: 3 }, { maxCycles: -1 }, { maxGroupsPerCycle: 7 }, { maxParagraphsPerGroup: 13 }, { maxWordsPerGroup: 2501 }]) {
        await assert.rejects(runEditorialWorkflow(makeJob(), mock.api, {}, options), /supported editorial limits/);
    }
    const busy = makeJob(); busy._busy = true;
    await assert.rejects(runEditorialWorkflow(busy, mock.api), /already in use/);
    const incomplete = makeJob(); incomplete.settings.sectionCount = 2;
    await assert.rejects(runEditorialWorkflow(incomplete, mock.api), /Finish all manuscript sections/);
    assert.equal(mock.calls.reviews.length, 0);
});

test('complete bounded FF props survive intact and ranges crossing them are deferred', async () => {
    const graphic = '<!-- GFX_START -->\n<div>A drawn brass compass.</div>\n<!-- GFX_END -->';
    const text = `Mara entered the courtyard.\n\n${graphic}\n\nMara checked the compass.\n\nThe river waited beyond the gate.`;
    const job = makeJob(text), mock = services({ review: async () => report([issue([1, 2])]) });
    const state = await runEditorialWorkflow(job, mock.api);
    assert.equal(state.targetChecks.formatValid, true);
    assert.equal(mock.calls.revisions.length, 0);
    assert.equal(state.text, text);
    assert.ok(state.unresolved.length);
});
