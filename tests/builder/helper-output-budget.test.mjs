import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, planJob, runJob, updatePlan, sectionBudget, sectionMarkers, PLANNER_SYSTEM } from '../../extensions/StoryBuilder/builder-core.js';

const brief = 'Mara waits at the gate. Meet the courier, then cross the river.';
const state = () => ({ summary: 'Mara waits at the gate.', facts: [{ fact: 'Mara is at the gate.', evidence: 'Mara waits at the gate.' }], openThreads: [], unknowns: [] });
const outline = () => ({ fixedFacts: ['Mara is at the gate.'], finalRequirements: [],
    requiredBeats: [{ id: 'meet', briefQuote: 'Meet the courier' }, { id: 'cross', briefQuote: 'cross the river' }],
    sections: [{ id: 1, title: 'Meeting', beatIds: ['meet'], startState: 'At the gate', endState: 'Ready to leave', direction: '' },
        { id: 2, title: 'Crossing', beatIds: ['cross'], startState: 'On the road', endState: 'Across the river', direction: '' }] });

function fixture({ planned = false, tokens = 1000, caps = {}, countTokens } = {}) {
    const source = { latestBrief: brief, model: 'test/writer', snapshot: {}, requestTemplate: { secret_id: 'synthetic-secret-id', max_tokens: 50000 },
        messages: [{ role: 'system', content: 'Synthetic preset and full reference. '.repeat(1000) },
            { role: 'assistant', content: 'Prior accepted source remains unchanged.' }, { role: 'user', content: brief }] };
    const job = createJob(source, { plannerModel: 'test/planner', reviewerModel: 'test/checker', continuityEnabled: true,
        wordMin: 500, wordMax: 600, paragraphMin: 5, paragraphMax: 8, sectionCount: 2, maxRetries: 1 });
    if (planned) { updatePlan(job, outline()); job.continuity = { version: 1, initialState: state(), acceptedFrames: [] }; }
    const calls = [], estimates = [];
    const transport = {
        models: ['test/planner', 'test/checker', 'test/writer'].map(id => ({ id, context_length: 262144,
            top_provider: { max_completion_tokens: caps[id] ?? 32768 } })),
        isCurrent: () => true,
        countTokens: async (messages, model) => {
            estimates.push({ messages: structuredClone(messages), model });
            return countTokens ? countTokens(messages, model) : tokens;
        },
        fetcher: async (_path, request) => {
            const body = JSON.parse(request.body);
            const kind = body.messages[0].content === PLANNER_SYSTEM ? 'plan' : body.model === 'test/checker' ? 'check'
                : body.model === 'test/planner' ? 'initial' : 'write';
            calls.push({ kind, body });
            let content;
            if (kind === 'initial') content = JSON.stringify(state());
            if (kind === 'plan') content = JSON.stringify(outline());
            if (kind === 'check') content = JSON.stringify({ issues: [], endState: state() });
            if (kind === 'write') {
                const budget = sectionBudget(job), markers = sectionMarkers(job, job.sections.length);
                const words = Array.from({ length: budget.wordTarget }, (_, index) => index === 0 ? 'Mara' : 'walked');
                const split = Math.floor(words.length / 3);
                const prose = [words.slice(0, split), words.slice(split, split * 2), words.slice(split * 2)]
                    .map(row => row.join(' ') + '.').join('\n\n');
                content = `${markers.start}\n${prose}\n${markers.end}`;
            }
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 20 } }) };
        },
    };
    return { job, calls, estimates, transport };
}

test('planJob uses 32768 for both initial state and planner with the full source retained', async () => {
    const f = fixture(), before = structuredClone(f.job.source);
    await planJob(f.job, f.transport);
    assert.deepEqual(f.calls.map(call => [call.kind, call.body.max_tokens]), [['initial', 32768], ['plan', 32768]]);
    assert.deepEqual(JSON.parse(f.calls[0].body.messages[1].content).sourceMessages, before.messages);
    const planner = JSON.parse(f.calls[1].body.messages[1].content);
    assert.equal(planner.briefPassages.map(passage => passage.text).join(''), before.latestBrief);
    assert.deepEqual(planner.sourceMessages.slice(0, 2), before.messages.slice(0, 2));
    assert.equal(f.calls[0].body.stream, false); assert.equal(f.calls[1].body.stream, false);
    assert.equal(f.calls[0].body.secret_id, 'synthetic-secret-id'); assert.deepEqual(f.job.source, before);
});

test('section checker gets 32768 while writer stays at 16384 and native source response preference stays unchanged', async () => {
    const f = fixture({ planned: true }), before = structuredClone(f.job.source);
    await runJob(f.job, f.transport, { stopAfterSections: 1 });
    assert.deepEqual(f.calls.map(call => [call.kind, call.body.max_tokens]), [['write', 16384], ['check', 32768]]);
    assert.deepEqual(f.calls[0].body.messages.slice(0, before.messages.length), before.messages);
    assert.deepEqual(JSON.parse(f.calls[1].body.messages[1].content).sourceMessages, before.messages);
    assert.equal(f.calls[1].body.stream, false); assert.equal(f.job.source.requestTemplate.max_tokens, 50000);
    assert.deepEqual(f.job.source, before); assert.equal(f.job.sections.length, 1);
});

test('published lower output ceilings clamp the initial helper, planner, and checker independently', async () => {
    const f = fixture({ caps: { 'test/planner': 12000, 'test/checker': 10000 } });
    await planJob(f.job, f.transport); await runJob(f.job, f.transport, { stopAfterSections: 1 });
    assert.deepEqual(f.calls.map(call => [call.kind, call.body.max_tokens]),
        [['initial', 12000], ['plan', 12000], ['write', 16384], ['check', 10000]]);
    assert.equal(f.job.lastBudget.maxOutputTokens, 10000);
    assert.equal(f.job.source.requestTemplate.max_tokens, 50000);
});

test('helper budget reserves the 32768 output plus the full input estimate, 15 percent margin, and 2048 overhead', async () => {
    const f = fixture({ tokens: 12345 }); await planJob(f.job, f.transport);
    assert.deepEqual(f.job.lastBudget, { estimatedInputTokens: 12345,
        reservedTokens: Math.ceil(12345 * 1.15) + 32768 + 2048,
        contextLimit: 262144, maxOutputTokens: 32768 });
    assert.equal(f.estimates.length, 2);
    assert.deepEqual(JSON.parse(f.estimates[0].messages[1].content).sourceMessages, f.job.source.messages);
});

test('oversized starting-state input stops before any provider request without shortening the captured source', async () => {
    const f = fixture({ tokens: 200000 }), before = structuredClone(f.job.source);
    await assert.rejects(planJob(f.job, f.transport), /no longer fit/);
    assert.equal(f.calls.length, 0); assert.equal(f.job.calls, 0); assert.equal(f.job.plan, null);
    assert.equal(f.job.continuity.initialState, null); assert.deepEqual(f.job.source, before);
    assert.equal(f.estimates.length, 1);
    assert.deepEqual(JSON.parse(f.estimates[0].messages[1].content).sourceMessages, before.messages);
});

test('oversized checker request preserves the complete candidate and state without making a checker call', async () => {
    const f = fixture({ planned: true, countTokens: (_messages, model) => model === 'test/checker' ? 200000 : 1000 });
    const before = structuredClone(f.job.source), initial = structuredClone(f.job.continuity.initialState);
    await assert.rejects(runJob(f.job, f.transport), /no longer fit/);
    assert.deepEqual(f.calls.map(call => call.kind), ['write']); assert.equal(f.job.calls, 1);
    assert.equal(f.job.sections.length, 0); assert.equal(f.job.continuity.acceptedFrames.length, 0);
    assert.equal(f.job.pending.phase, 'checking'); assert.ok(f.job.pending.text.length > 0);
    const checkerPayload = JSON.parse(f.estimates.at(-1).messages[1].content);
    assert.equal(checkerPayload.candidate.text, f.job.pending.text);
    assert.deepEqual(checkerPayload.sourceMessages, before.messages);
    assert.deepEqual(f.job.continuity.initialState, initial); assert.deepEqual(f.job.source, before);
});

test('a lower published ceiling is applied before reserving context and can make the complete input fit', async () => {
    const f = fixture({ tokens: 200000, caps: { 'test/planner': 12000 } });
    await planJob(f.job, f.transport);
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.body.max_tokens === 12000));
    assert.equal(f.job.lastBudget.reservedTokens, Math.ceil(200000 * 1.15) + 12000 + 2048);
    assert.ok(f.job.lastBudget.reservedTokens < f.job.lastBudget.contextLimit);
});
