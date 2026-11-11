import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, updatePlan, planJob, runJob, sectionBudget, sectionMarkers, buildSectionRequest, PLANNER_SYSTEM } from '../../extensions/StoryBuilder/builder-core.js';
import { buildInitialStateRequest } from '../../extensions/StoryBuilder/continuity-checks.js';

const brief = 'Mara waits at the gate with the compass. Meet the courier, then cross the river.';
const state = () => ({ summary: 'Mara is waiting before the journey.', facts: [{ fact: 'Mara has the compass.', evidence: 'Mara waits at the gate with the compass.' }], openThreads: [], unknowns: ['The weather is unspecified.'] });
const outline = () => ({ fixedFacts: ['Mara has the compass.'], requiredBeats: [{ id: 'meet', briefQuote: 'Meet the courier' }, { id: 'cross', briefQuote: 'cross the river' }],
    sections: [{ id: 1, title: 'Meeting', beatIds: ['meet'], startState: 'At the gate', endState: 'Ready to travel', direction: '' }, { id: 2, title: 'Crossing', beatIds: ['cross'], startState: 'Travel begins', endState: 'River crossed', direction: '' }], finalRequirements: ['Finish the crossing.'] });
function fixture({ planned = true, respond, isCurrent } = {}) {
    const job = createJob({ latestBrief: brief, model: 'test/writer', snapshot: {}, requestTemplate: { temperature: .9, reasoning_effort: 'high' },
        messages: [{ role: 'system', content: 'Synthetic FF formatting instructions stay intact.' }, { role: 'user', content: brief }] },
    { wordMin: 500, wordMax: 600, paragraphMin: 5, paragraphMax: 8, sectionCount: 2, maxRetries: 1,
        plannerModel: 'test/planner', reviewerModel: 'test/checker', continuityEnabled: true });
    if (planned) updatePlan(job, outline());
    const calls = [], initialSystem = buildInitialStateRequest(job).messages[0].content;
    const transport = { models: ['test/planner', 'test/checker', 'test/writer'].map(id => ({ id, context_length: 131072 })),
        countTokens: async () => 1000, isCurrent: isCurrent || (() => true),
        fetcher: async (_path, request) => {
            const body = JSON.parse(request.body), payload = JSON.parse(body.messages.at(-1).content);
            const kind = body.messages[0].content === initialSystem ? 'initial' : body.messages[0].content === PLANNER_SYSTEM ? 'plan' : body.model === 'test/checker' ? 'check' : 'write';
            const call = { kind, body, payload, signal: request.signal }; calls.push(call);
            let answer = await respond?.(call, job, calls);
            if (!answer) {
                if (kind === 'initial') answer = { text: JSON.stringify(state()) };
                if (kind === 'plan') answer = { text: JSON.stringify(outline()) };
                if (kind === 'check') answer = { text: JSON.stringify({ issues: [], endState: state() }) };
                if (kind === 'write') {
                    const budget = sectionBudget(job), markers = sectionMarkers(job, job.sections.length);
                    const words = Array.from({ length: budget.wordTarget }, (_, i) => i === 0 ? 'Mara' : 'walked');
                    const middle = Math.floor(words.length / 3);
                    const text = [words.slice(0, middle), words.slice(middle, middle * 2), words.slice(middle * 2)].map(row => row.join(' ') + '.').join('\n\n');
                    answer = { text: `${markers.start}\n${text}\n${markers.end}` };
                }
            }
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: answer.text }, finish_reason: answer.finishReason || 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: .001 } }) };
        } };
    return { job, calls, transport, count: kind => calls.filter(call => call.kind === kind).length };
}

test('starting state precedes planning and every section is checked before the next writer runs', async () => {
    const f = fixture({ planned: false });
    await planJob(f.job, f.transport); await runJob(f.job, f.transport);
    assert.deepEqual(f.calls.map(call => call.kind), ['initial', 'plan', 'write', 'check', 'write', 'check']);
    assert.equal(f.job.status, 'complete'); assert.equal(f.job.continuity.acceptedFrames.length, 2);
    assert.equal(f.job.calls, 6); assert.equal(f.job.usage.inputTokens, 60);
    const writers = f.calls.filter(call => call.kind === 'write');
    assert.deepEqual(writers[0].body.messages.slice(0, 2), f.job.source.messages);
    assert.equal(writers[1].payload.completedStory, f.job.sections[0].text);
    assert.deepEqual(writers[1].payload.continuityState, f.job.continuity.acceptedFrames[0].endState);
});

test('failed planning reuses the completed starting state', async () => {
    let failed = false;
    const f = fixture({ planned: false, respond(call) { if (call.kind === 'plan' && !failed) { failed = true; return { text: 'not JSON' }; } } });
    f.job.settings.maxRetries = 0;
    await assert.rejects(planJob(f.job, f.transport), /readable outline/);
    await planJob(f.job, f.transport); assert.equal(f.count('initial'), 1); assert.equal(f.count('plan'), 2);
});

test('a failed checker resumes the same written candidate without repeating the writer', async () => {
    let failed = false;
    const f = fixture({ respond(call) { if (call.kind === 'check' && !failed) { failed = true; return { text: '{malformed' }; } } });
    f.job.settings.maxRetries = 0;
    await assert.rejects(runJob(f.job, f.transport), /valid JSON/);
    const pending = f.job.pending;
    assert.equal(pending.phase, 'checking'); assert.equal(f.job.sections.length, 0);
    await runJob(f.job, f.transport, { stopAfterSections: 1 });
    assert.equal(f.count('write'), 1); assert.equal(f.count('check'), 2); assert.equal(f.count('initial'), 1);
    assert.equal(f.job.sections[0].text, pending.text); assert.equal(f.job.continuity.acceptedFrames.length, 1);
});

test('pause after a validated check retains its receipt and accepts it once on Resume', async () => {
    const f = fixture(), controller = new AbortController();
    await assert.rejects(runJob(f.job, f.transport, { signal: controller.signal,
        onProgress(progress) { if (progress.stage === 'section_check_complete') controller.abort(); } }), { name: 'AbortError' });
    assert.equal(f.job.pending.phase, 'checked'); assert.equal(f.job.sections.length, 0); assert.equal(f.job.continuity.acceptedFrames.length, 0);
    await runJob(f.job, f.transport, { stopAfterSections: 1 });
    assert.equal(f.count('write'), 1); assert.equal(f.count('check'), 1); assert.equal(f.job.continuity.acceptedFrames.length, 1);
});

test('high contradiction triggers bounded repair and rejected state never reaches later writing', async () => {
    let checked = 0;
    const f = fixture({ respond(call) {
        if (call.kind === 'check' && ++checked === 1) return { text: JSON.stringify({ issues: [{ severity: 'high', problem: 'Synthetic continuity contradiction.',
            evidenceBefore: 'Mara waits at the gate with the compass.', evidenceAfter: 'Mara walked', suggestion: 'Keep the compass ownership consistent.' }], endState: { ...state(), summary: 'REJECTED STATE MUST NOT ADVANCE' } }) };
    } });
    await runJob(f.job, f.transport);
    assert.equal(f.count('write'), 3); assert.equal(f.count('check'), 3);
    assert.equal(f.job.continuity.acceptedFrames.length, 2);
    assert.ok(f.calls.filter(c => c.kind === 'write').some(c => c.payload.repair?.measuredProblems.some(issue => issue.includes('compass ownership'))));
    assert.ok(f.calls.filter(c => c.kind === 'write').every(c => c.payload.continuityState.summary !== 'REJECTED STATE MUST NOT ADVANCE'));
});

test('only high findings block; advisory issues are retained without a replacement call', async () => {
    const f = fixture({ respond(call) { if (call.kind === 'check') return { text: JSON.stringify({ issues: [{ severity: 'medium', problem: 'Synthetic advisory note.',
        evidenceBefore: 'Mara waits', evidenceAfter: 'Mara walked', suggestion: 'Check the transition during final review.' }], endState: state() }) }; } });
    await runJob(f.job, f.transport, { stopAfterSections: 1 });
    assert.equal(f.count('write'), 1); assert.equal(f.job.sections[0].warnings.length, 1);
});

test('failed length/format candidates do not spend a continuity-check call', async () => {
    const f = fixture({ respond(call) { if (call.kind === 'write') return { text: 'Too short and unframed.' }; } });
    await runJob(f.job, f.transport);
    assert.equal(f.count('check'), 0); assert.equal(f.count('write'), 2); assert.equal(f.job.status, 'needs_attention');
    updatePlan(f.job, structuredClone(f.job.plan));
    assert.equal(f.job.status, 'needs_attention', 'unchanged UI outline cannot remove retry eligibility');
    await runJob(f.job, f.transport); assert.equal(f.count('write'), 4);
});

test('truncated checks retain prose and never advance state', async () => {
    const f = fixture({ respond(call) { if (call.kind === 'check') return { text: JSON.stringify({ issues: [], endState: state() }), finishReason: 'length' }; } });
    await assert.rejects(runJob(f.job, f.transport), /section check reached/);
    assert.equal(f.job.pending.phase, 'checking'); assert.equal(f.job.sections.length, 0); assert.equal(f.job.continuity.acceptedFrames.length, 0);
});

test('source changes during a checker prevent prose and state acceptance', async () => {
    let current = true;
    const f = fixture({ isCurrent: () => current, respond(call) { if (call.kind === 'check') current = false; } });
    await assert.rejects(runJob(f.job, f.transport), /source chat/);
    assert.equal(f.job.sections.length, 0); assert.equal(f.job.continuity.acceptedFrames.length, 0);
});

test('abort while the asynchronous source guard resolves prevents all paid work', async () => {
    const controller = new AbortController();
    const f = fixture({ isCurrent: async () => { controller.abort(); return true; } });
    await assert.rejects(runJob(f.job, f.transport, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.job.calls, 0); assert.equal(f.count('initial'), 0);
});

test('a changed outline discards the unaccepted candidate before retry', async () => {
    const f = fixture({ respond(call) { if (call.kind === 'check') throw Error('Synthetic request failure'); } });
    await assert.rejects(runJob(f.job, f.transport)); assert.ok(f.job.pending);
    const changed = structuredClone(f.job.plan); changed.sections[0].direction = 'Use the western gate.'; updatePlan(f.job, changed);
    assert.equal(f.job.pending, null); assert.equal(f.job.continuity.acceptedFrames.length, 0);
    assert.equal(buildSectionRequest(f.job).body.messages[0].content, f.job.source.messages[0].content);
});
