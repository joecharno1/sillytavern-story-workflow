import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, planJob, runJob, sectionBudget, sectionMarkers, assembledStory } from '../../extensions/StoryBuilder/builder-core.js';
import { buildWritingGuidance, specialistPasses } from '../../extensions/StoryBuilder/writing-tuning.js';
import { runEditorialWorkflow } from '../../extensions/StoryBuilder/editorial-workflow.js';
import * as editorialServices from '../../extensions/StoryReview/workflow-review.js';
import { createSpendLedger, prepareReservation, settleRequest, spendSummary } from '../../extensions/StoryBuilder/spend-budget.js';

const brief = 'Mara waits at the gate with a brass compass. Meet the courier, then cross the river before dusk.';
const selectedText = 'SELECTED_DIALOGUE_GUIDANCE: give each speaker a distinct vocabulary and preserve their established knowledge.';
const unusedText = 'UNSELECTED_LIBRARY_TEXT: this invented saved preference must never leave local settings.';
const unusedCustom = 'UNSELECTED_CUSTOM_FIELD: dormant free text is not active guidance.';
const initialState = () => ({ summary: 'Mara waits at the gate.', facts: [
    { fact: 'Mara has a brass compass.', evidence: 'Mara waits at the gate with a brass compass.' },
], openThreads: [], unknowns: [] });
const selectedStyles = (model = '') => ({
    dialogue: { preset: 'custom-dialogue', custom: unusedCustom, model },
    atmosphere: { preset: 'inherit', custom: unusedCustom, model: '' },
});
const library = () => ({ dialogue: [
    { id: 'custom-dialogue', name: 'Selected dialogue', text: selectedText },
    { id: 'custom-unused', name: 'UNSELECTED_LIBRARY_NAME', text: unusedText },
] });

function fixture({ settings = {}, issueFocus, mixed = false, cap = false } = {}) {
    const source = { latestBrief: brief, model: 'test/writer', snapshot: {},
        requestTemplate: { secret_id: 'synthetic-reference-only', temperature: .8 },
        messages: [{ role: 'system', content: 'SYNTHETIC_SOURCE_PRESET: preserve the complete author brief.' },
            { role: 'user', content: brief }] };
    const sourceBefore = structuredClone(source);
    const job = createJob(source, { writerModel: 'test/writer', plannerModel: 'test/planner', reviewerModel: 'test/reviewer',
        wordMin: 500, wordMax: 600, paragraphMin: 6, paragraphMax: 6, sectionCount: 2,
        editorialEnabled: true, continuityEnabled: true, revisionCycles: 1, maxRevisionPassages: 2,
        updateTracker: false, ...settings });
    const calls = [], metadataCalls = [], requested = [], usage = [];
    const catalog = ['writer', 'planner', 'reviewer', 'continuity', 'revision', 'dialogue', 'atmosphere'].map(name => ({
        id: `test/${name}`, context_length: 131072, top_provider: { max_completion_tokens: 16384 },
        pricing: { prompt: '0', completion: cap && name === 'dialogue' ? '1' : '0', request: '0' },
    }));
    if (cap) job.spend = createSpendLedger(job.settings.spendLimitUsd);
    let current = true;
    const transport = { models: catalog, countTokens: async () => 100,
        isCurrent: async () => current, assertCurrent: async () => current,
        onRequest: async event => requested.push(event), onUsage: async value => usage.push(value),
        fetcher: async (url, options) => {
            assert.equal(url, '/api/backends/chat-completions/generate');
            const body = JSON.parse(options.body), payload = JSON.parse(body.messages.at(-1).content);
            let ticket;
            if (cap) ticket = await prepareReservation(job.spend, body, { assertCurrent: () => current,
                fetcher: async path => {
                    metadataCalls.push(path);
                    return { ok: true, json: async () => path.endsWith('/status') ? { data: catalog } : { token_count: 100 } };
                } });
            const kind = payload.briefPassages ? 'plan' : payload.currentSection ? 'write' : payload.candidate ? 'check'
                : payload.draft ? payload.selectedParagraphs ? 'revision' : 'review' : 'initial';
            calls.push({ kind, body, payload });
            let content;
            if (kind === 'initial') content = JSON.stringify(initialState());
            else if (kind === 'plan') content = JSON.stringify({ fixedFacts: ['The compass is brass.'],
                requiredBeats: [{ id: 'meet', passageId: payload.briefPassages[0].id, requirement: 'Meet the courier.' },
                    { id: 'cross', passageId: payload.briefPassages[0].id, requirement: 'Cross the river before dusk.' }],
                sections: [{ id: 1, title: 'Courier', beatIds: ['meet'], startState: 'At the gate', endState: 'Ready to cross', direction: 'Meet the courier.' },
                    { id: 2, title: 'River', beatIds: ['cross'], startState: 'Ready to cross', endState: 'Across the river', direction: 'Finish the crossing.' }],
                finalRequirements: ['Finish before dusk.'] });
            else if (kind === 'write') {
                const target = sectionBudget(job).wordTarget, markers = sectionMarkers(job, job.sections.length);
                const words = Array.from({ length: target }, (_, index) => index === 0 ? 'Mara' : index === 100 ? 'scarlet' : 'walked');
                const third = Math.floor(words.length / 3);
                content = `${markers.start}\n${[words.slice(0, third), words.slice(third, third * 2), words.slice(third * 2)].map(row => row.join(' ') + '.').join('\n\n')}\n${markers.end}`;
            } else if (kind === 'check') content = JSON.stringify({ issues: [], endState: initialState() });
            else if (kind === 'revision') content = payload.draft.filter(row => payload.selectedParagraphs.includes(row.id))
                .map(row => row.text.replaceAll('scarlet', 'red')).join('\n\n');
            else {
                const finding = payload.draft[1].text.includes('scarlet') && (payload.focus === issueFocus || mixed && payload.focus === 'prose');
                content = JSON.stringify({ summary: 'Synthetic focused review.', strengths: ['The compass remains brass.'], issues: finding ? [{
                    severity: 'medium', category: payload.focus === 'continuity' ? 'continuity' : 'prose', paragraphs: [2], problem: 'The selected phrase needs a local wording change.',
                    suggestion: 'Replace scarlet with red in the selected paragraph and preserve the surrounding prose.',
                }] : [] });
            }
            const result = { choices: [{ message: { content }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 100, completion_tokens: 100, cost: cap ? 0 : .001 } };
            if (ticket) settleRequest(job.spend, ticket, result.usage);
            return { ok: true, status: 200, json: async () => result };
        } };
    const write = async () => { await planJob(job, transport); await runJob(job, transport); };
    const review = () => runEditorialWorkflow(job, editorialServices, transport, {
        maxCycles: job.settings.revisionCycles, maxGroupsPerCycle: job.settings.maxRevisionPassages,
        settings: { model: job.settings.reviewerModel, revisionModel: job.settings.revisionModel,
            writingGuidance: buildWritingGuidance(job.settings), specialists: specialistPasses(job.settings), maxOutput: 4096 },
    });
    return { job, sourceBefore, calls, metadataCalls, requested, usage, write, review,
        invalidate: () => { current = false; } };
}

test('Easy mode retains legacy stage routing and the ordinary request count', async () => {
    const f = fixture(); await f.write(); await f.review();
    assert.deepEqual(f.calls.map(call => [call.kind, call.body.model]), [
        ['initial', 'test/planner'], ['plan', 'test/planner'], ['write', 'test/writer'], ['check', 'test/reviewer'],
        ['write', 'test/writer'], ['check', 'test/reviewer'], ['review', 'test/reviewer'], ['review', 'test/reviewer'],
    ]);
    assert.deepEqual(f.calls.filter(call => call.kind === 'review').map(call => call.payload.focus), ['continuity', 'prose']);
    assert.equal(f.job.editorial.status, 'ready');
    assert.deepEqual(f.job.source, f.sourceBefore);
});

test('selected named guidance crosses writer and reviewer stages without exposing other saved styles', async () => {
    const f = fixture({ settings: { tuningEnabled: true, writingStyles: selectedStyles(), writingPresetLibrary: library() } });
    await f.write(); await f.review();
    assert.equal(f.calls.length, 8, 'style guidance alone adds no specialist request');
    for (const call of f.calls) {
        const serialized = JSON.stringify(call.body);
        assert.doesNotMatch(serialized, /UNSELECTED_LIBRARY_TEXT|UNSELECTED_LIBRARY_NAME|UNSELECTED_CUSTOM_FIELD|writingPresetLibrary/);
        if (call.kind === 'write' || call.kind === 'review') assert.ok(serialized.includes(selectedText), call.kind);
    }
    for (const call of f.calls.filter(call => call.kind === 'write')) assert.deepEqual(call.body.messages.slice(0, 2), f.sourceBefore.messages);
    assert.deepEqual(f.job.source, f.sourceBefore);
});

test('switching tuning off leaves saved specialist choices dormant across every stage', async () => {
    const f = fixture({ settings: { tuningEnabled: false, writingStyles: selectedStyles('test/dialogue'), writingPresetLibrary: library() } });
    await f.write(); await f.review();
    assert.equal(f.calls.length, 8);
    for (const call of f.calls) {
        assert.notEqual(call.body.model, 'test/dialogue');
        assert.doesNotMatch(JSON.stringify(call.body), /SELECTED_DIALOGUE_GUIDANCE|UNSELECTED_|writingPresetLibrary/);
    }
});

test('explicit continuity and revision models route independently of writing tuning', async () => {
    const f = fixture({ issueFocus: 'prose', settings: { tuningEnabled: false, continuityModel: 'test/continuity', revisionModel: 'test/revision' } });
    await f.write(); const original = assembledStory(f.job); await f.review();
    assert.ok(f.calls.filter(call => call.kind === 'initial' || call.kind === 'check').every(call => call.body.model === 'test/continuity'));
    assert.equal(f.calls.find(call => call.kind === 'plan').body.model, 'test/planner');
    assert.equal(f.calls.find(call => call.kind === 'revision').body.model, 'test/revision');
    assert.equal(f.job.editorial.changes.length, 1);
    assert.equal(assembledStory(f.job), original, 'editorial changes never overwrite accepted writer sections');
    assert.equal(f.job.editorial.text, original.replace('scarlet', 'red'));
});

for (const mixed of [false, true]) test(`${mixed ? 'mixed' : 'category-only'} findings route their bounded patch to the intended model`, async () => {
    const f = fixture({ issueFocus: 'dialogue', mixed, settings: { tuningEnabled: true, revisionModel: 'test/revision',
        writingStyles: selectedStyles('test/dialogue'), writingPresetLibrary: library() } });
    await f.write(); const original = assembledStory(f.job); await f.review();
    const reviews = f.calls.filter(call => call.kind === 'review'), revision = f.calls.find(call => call.kind === 'revision');
    assert.deepEqual(reviews.map(call => call.payload.focus), ['continuity', 'prose', 'dialogue', 'continuity', 'prose', 'dialogue']);
    assert.ok(reviews.filter(call => call.payload.focus === 'dialogue').every(call => call.body.model === 'test/dialogue'));
    assert.equal(revision.body.model, mixed ? 'test/revision' : 'test/dialogue');
    assert.deepEqual(revision.payload.selectedParagraphs, [2]);
    assert.equal(f.job.editorial.text, original.replace('scarlet', 'red'));
    for (const [index, call] of reviews.entries()) {
        assert.equal(call.payload.latestBrief, brief);
        assert.equal(call.payload.draft.length, 6);
        assert.equal(call.payload.draft.map(row => row.text).join('\n\n'), index < 3 ? original : f.job.editorial.text,
            'every enabled focus sees the same complete draft version');
        assert.ok(JSON.stringify(call.body).includes(selectedText));
    }
    assert.equal(revision.payload.draft.map(row => row.text).join('\n\n'), original,
        'a specialist patch sees the full coherent draft, even though only one passage may change');
    assert.equal(f.job.editorial.changes.length, 1);
    assert.equal(f.job.editorial.status, 'ready');
    assert.ok(f.calls.every(call => !JSON.stringify(call.body).includes(unusedText)));
});

test('specialist budget denial preserves completed draft and ordinary reports on the same ledger when resumed', async () => {
    const f = fixture({ cap: true, settings: { spendLimitUsd: 1, tuningEnabled: true,
        writingStyles: selectedStyles('test/dialogue'), writingPresetLibrary: library() } });
    await f.write(); const original = assembledStory(f.job), ledger = f.job.spend;
    await assert.rejects(f.review(), { name: 'SpendLimitError' });
    assert.equal(f.job.editorial.text, original);
    assert.equal(f.job.editorial.changes.length, 0);
    assert.deepEqual(f.job.editorial.reports.map(report => report.focus), ['continuity', 'prose']);
    assert.equal(f.calls.some(call => call.body.model === 'test/dialogue'), false, 'reservation stops specialist generation before dispatch');
    const ordinaryCalls = f.calls.length, reservations = ledger.entries.length;
    await assert.rejects(f.review(), { name: 'SpendLimitError' });
    assert.equal(f.calls.length, ordinaryCalls, 'completed ordinary reviews are not paid for again');
    assert.equal(f.job.spend, ledger);
    assert.equal(ledger.entries.length, reservations);
    assert.equal(spendSummary(ledger).limitUsd, 1);
    assert.equal(f.job.editorial.text, original);
});
