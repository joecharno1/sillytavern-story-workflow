import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialStateFallback, parseInitialState, buildContinuityCheckRequest, parseContinuityCheck } from '../../extensions/StoryBuilder/continuity-checks.js';
import { createJob, planJob, buildSectionRequest, PLANNER_SYSTEM } from '../../extensions/StoryBuilder/builder-core.js';

const brief = 'Mara waits at the gate. Meet the courier, then cross the river.';
const validState = () => ({ summary: 'Mara waits at the gate.', facts: [{ fact: 'Mara is at the gate.', evidence: 'Mara waits at the gate.' }], openThreads: [], unknowns: [] });
const outline = () => ({ fixedFacts: ['Mara is at the gate.'], finalRequirements: [],
    requiredBeats: [{ id: 'meet', briefQuote: 'Meet the courier' }, { id: 'cross', briefQuote: 'cross the river' }],
    sections: [{ id: 1, title: 'Meeting', beatIds: ['meet'], startState: 'At the gate', endState: 'Met the courier', direction: '' },
        { id: 2, title: 'Crossing', beatIds: ['cross'], startState: 'At the river', endState: 'Across the river', direction: '' }] });

function fixture({ answer, respond, tokens = 1000 } = {}) {
    const source = { latestBrief: brief, model: 'test/writer', snapshot: {}, requestTemplate: { secret_id: 'synthetic-key-id' }, messages: [
        { role: 'system', content: 'The complete captured reference is retained. '.repeat(1000) },
        { role: 'assistant', content: 'Earlier accepted context remains exact.' }, { role: 'user', content: `<brief>${brief}</brief>` },
    ] };
    const job = createJob(source, { wordMin: 500, wordMax: 600, paragraphMin: 5, paragraphMax: 8, sectionCount: 2,
        maxRetries: 1, plannerModel: 'test/planner', reviewerModel: 'test/checker', continuityEnabled: true });
    const f = { job, calls: [], progress: [], current: true };
    f.transport = { models: [{ id: 'test/planner', context_length: 262144, top_provider: { max_completion_tokens: 32768 } }],
        countTokens: async () => tokens, isCurrent: () => f.current,
        fetcher: async (_path, request) => {
            const body = JSON.parse(request.body), isPlan = body.messages[0].content === PLANNER_SYSTEM;
            const call = { body, isPlan }; f.calls.push(call);
            const result = await respond?.(call, f) ?? (isPlan ? { content: JSON.stringify(outline()) } : answer ?? { content: JSON.stringify(validState()) });
            if (result.throw) throw result.throw;
            return { ok: result.ok ?? true, status: result.status ?? 200, json: async () => result.envelope ?? (result.error ? { error: result.error } : {
                choices: [{ message: { content: result.content, refusal: result.refusal, tool_calls: result.toolCalls }, finish_reason: result.finishReason ?? 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 20, cost: .001 },
            }) };
        } };
    f.run = options => planJob(job, f.transport, { onProgress: progress => f.progress.push(progress), ...options });
    return f;
}

test('fallback factory produces only a neutral strict four-key state without changing full source', () => {
    const f = fixture(), before = structuredClone(f.job.source), state = createInitialStateFallback(f.job);
    assert.deepEqual(Object.keys(state).sort(), ['facts', 'openThreads', 'summary', 'unknowns']);
    assert.deepEqual(state.facts, []); assert.deepEqual(state.openThreads, []); assert.deepEqual(state.unknowns, []);
    assert.match(state.summary, /source/i); assert.ok(state.summary.length > 0 && state.summary.length <= 1800);
    assert.deepEqual(parseInitialState(JSON.stringify(state), f.job), state);
    assert.deepEqual(f.job.source, before);
    state.facts.push({ fact: 'Synthetic local mutation', evidence: 'Synthetic' });
    assert.deepEqual(createInitialStateFallback(f.job).facts, []);
});

test('fallback factory still rejects missing or invalid captured source', () => {
    const f = fixture();
    for (const source of [null, { latestBrief: brief, messages: [] },
        { latestBrief: brief, messages: [{ role: 'user', content: 'A different brief.' }] },
        { latestBrief: brief, messages: [{ role: 'tool', content: brief }] }]) {
        assert.throws(() => createInitialStateFallback({ ...f.job, source }), /complete captured source|author brief/i);
    }
});

for (const [label, answer, reason] of [
    ['malformed JSON', { content: '{RAW_HELPER_OUTPUT_MUST_NOT_LEAK' }, 'invalid_notes'],
    ['invalid schema', { content: JSON.stringify({ ...validState(), extra: 'RAW_HELPER_OUTPUT_MUST_NOT_LEAK' }) }, 'invalid_notes'],
    ['oversized state', { content: JSON.stringify({ ...validState(), summary: 'x'.repeat(1801) }) }, 'invalid_notes'],
    ['nonempty truncated response', { content: '{RAW_HELPER_OUTPUT_MUST_NOT_LEAK', finishReason: 'length' }, 'output_limit'],
    ['empty truncated response', { content: '', finishReason: 'length' }, 'output_limit'],
    ['null truncated response', { content: null, finishReason: 'length' }, 'output_limit'],
]) {
    test(`${label} uses one initial request, persists a fixed warning, and continues into planning`, async () => {
        const f = fixture({ answer }), before = structuredClone(f.job.source);
        await f.run();
        assert.deepEqual(f.calls.map(call => call.isPlan), [false, true]); assert.equal(f.job.calls, 2);
        assert.equal(f.job.status, 'ready'); assert.deepEqual(f.job.continuity.initialState, createInitialStateFallback(f.job));
        const preparation = f.job.continuity.initialStatePreparation;
        assert.deepEqual(Object.keys(preparation).sort(), ['message', 'reason', 'status']);
        assert.equal(preparation.status, 'source_only'); assert.equal(preparation.reason, reason);
        assert.ok(typeof preparation.message === 'string' && preparation.message.trim());
        assert.equal(Object.hasOwn(f.job.continuity, 'initialStateValidation'), false);
        assert.doesNotMatch(JSON.stringify(f.job.continuity), /RAW_HELPER_OUTPUT_MUST_NOT_LEAK/);
        assert.deepEqual(f.job.source, before); assert.equal(f.job.usage.inputTokens, 20); assert.equal(f.job.usage.outputTokens, 40);
        const initialPayload = JSON.parse(f.calls[0].body.messages[1].content), plannerPayload = JSON.parse(f.calls[1].body.messages[1].content);
        assert.deepEqual(initialPayload.sourceMessages, before.messages); assert.equal(plannerPayload.briefPassages.map(passage => passage.text).join(''), before.latestBrief);
        assert.deepEqual(plannerPayload.startingState, f.job.continuity.initialState);
        assert.doesNotMatch(JSON.stringify(f.calls[1].body), /RAW_HELPER_OUTPUT_MUST_NOT_LEAK/);
        assert.ok(f.progress.some(progress => progress.stage === 'starting_state_ready'));
        assert.ok(f.progress.every(progress => !/Retrying/.test(progress.message)));
    });
}

test('a successful extraction keeps prepared status and the existing validation counts', async () => {
    const f = fixture(); await f.run();
    assert.deepEqual(f.job.continuity.initialStatePreparation, { status: 'prepared' });
    assert.deepEqual(f.job.continuity.initialStateValidation, { proposedFacts: 1, verifiedFacts: 1, omittedFacts: 0 });
    assert.deepEqual(f.job.continuity.initialState, validState());
});

test('an object message without content at the output limit is a valid initial-only fallback signal', async () => {
    const f = fixture({ answer: { envelope: { choices: [{ message: {}, finish_reason: 'length' }] } } });
    await f.run();
    assert.deepEqual(f.calls.map(call => call.isPlan), [false, true]);
    assert.equal(f.job.continuity.initialStatePreparation.reason, 'output_limit');
});

test('missing, primitive, and array message envelopes cannot be treated as an output-limit fallback', async () => {
    for (const message of [undefined, null, 'Malformed message', 1, []]) {
        const f = fixture({ answer: { envelope: { choices: [{ message, finish_reason: 'length' }] } } });
        await assert.rejects(f.run(), /no story text|invalid|unreadable/i);
        assert.equal(f.calls.length, 1); assert.equal(f.job.continuity.initialState, null);
        assert.equal(f.job.continuity.initialStatePreparation, undefined); assert.equal(f.job.plan, null);
    }
});

test('fallback reaches writer and checker as secondary notes while preserving full source and strict section validation', async () => {
    const f = fixture({ answer: { content: '{malformed' } }); await f.run();
    const writer = buildSectionRequest(f.job).body;
    assert.deepEqual(writer.messages.slice(0, f.job.source.messages.length), f.job.source.messages);
    assert.deepEqual(JSON.parse(writer.messages.at(-1).content).continuityState, f.job.continuity.initialState);
    const candidate = { id: 1, text: 'Mara left the gate and met the courier.' };
    const checker = buildContinuityCheckRequest(f.job, candidate), payload = JSON.parse(checker.messages[1].content);
    assert.deepEqual(payload.sourceMessages, f.job.source.messages); assert.deepEqual(payload.establishedState, f.job.continuity.initialState);
    const invalidEndState = { ...validState(), facts: [{ fact: 'Unmatched claim.', evidence: 'Not in any source.' }] };
    assert.throws(() => parseContinuityCheck(JSON.stringify({ issues: [], endState: invalidEndState }), f.job, candidate), /source evidence/);
});

test('saved fallback survives a planner failure and Resume does not repeat initial extraction', async () => {
    let failedPlan = false;
    const f = fixture({ answer: { content: '{malformed' }, respond(call) {
        if (call.isPlan && !failedPlan) { failedPlan = true; return { content: '{invalid plan' }; }
    } });
    f.job.settings.maxRetries = 0;
    await assert.rejects(f.run(), /readable outline/);
    const state = f.job.continuity.initialState, preparation = f.job.continuity.initialStatePreparation;
    await f.run();
    assert.deepEqual(f.calls.map(call => call.isPlan), [false, true, true]);
    assert.equal(f.job.continuity.initialState, state); assert.equal(f.job.continuity.initialStatePreparation, preparation);
});

for (const [label, answer, expected] of [
    ['network failure', { throw: new Error('Synthetic network failure') }, /network failure/],
    ['insufficient credit', { ok: false, status: 402, error: { code: 402 } }, /insufficient credit/],
    ['authentication failure', { ok: false, status: 401, error: { code: 401 } }, /authenticate/],
    ['provider context failure', { ok: false, status: 413, error: { code: 413 } }, /context limit/],
    ['provider error', { ok: false, status: 500, error: { code: 500 } }, /request failed/],
    ['refusal even at output limit', { content: '', refusal: 'Refusal', finishReason: 'length' }, /declined/],
    ['content filter', { content: '', finishReason: 'content_filter' }, /declined/],
    ['empty ordinary completion', { content: '', finishReason: 'stop' }, /no story text/],
    ['malformed provider envelope', { envelope: { choices: [] } }, /no story text/],
    ['tool call even at output limit', { content: '', toolCalls: [{ id: 'synthetic' }], finishReason: 'length' }, /unfinished|non-story/],
]) {
    test(`${label} stops without a fallback or planner request`, async () => {
        const f = fixture({ answer }); await assert.rejects(f.run(), expected);
        assert.equal(f.calls.length, 1); assert.equal(f.job.continuity.initialState, null);
        assert.equal(f.job.continuity.initialStatePreparation, undefined); assert.equal(f.job.plan, null);
    });
}

test('context-budget failure stops before all paid requests and cannot become a fallback', async () => {
    const f = fixture({ tokens: 999999 }); await assert.rejects(f.run(), /no longer fit/);
    assert.equal(f.calls.length, 0); assert.equal(f.job.calls, 0); assert.equal(f.job.continuity.initialState, null);
    assert.equal(f.job.continuity.initialStatePreparation, undefined);
});

for (const mode of ['source change', 'cancellation']) {
    for (const truncated of [false, true]) {
        test(`${mode} immediately after ${truncated ? 'truncated' : 'invalid'} response prevents fallback commit`, async () => {
            const controller = new AbortController();
            const f = fixture({ respond(call, run) {
                if (!call.isPlan) {
                    if (mode === 'source change') run.current = false; else controller.abort();
                    return { content: truncated ? '' : '{malformed', finishReason: truncated ? 'length' : 'stop' };
                }
            } });
            f.transport.signal = controller.signal;
            await assert.rejects(f.run(), mode === 'source change' ? /source chat/ : { name: 'AbortError' });
            assert.equal(f.calls.length, 1); assert.equal(f.job.continuity.initialState, null);
            assert.equal(f.job.continuity.initialStatePreparation, undefined); assert.equal(f.job.plan, null);
        });
    }
}
