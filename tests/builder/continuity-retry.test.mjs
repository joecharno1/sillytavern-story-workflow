import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, updatePlan, planJob, runJob, sectionBudget, sectionMarkers, PLANNER_SYSTEM } from '../../extensions/StoryBuilder/builder-core.js';

const brief = 'Mara waits at the gate with the compass. Meet the courier, then cross the river.';
const state = () => ({ summary: 'Mara waits before beginning her journey.',
    facts: [{ fact: 'Mara has the compass.', evidence: 'Mara waits at the gate with the compass.' }], openThreads: [], unknowns: [] });
const report = () => ({ issues: [], endState: state() });
const outline = () => ({ fixedFacts: ['Mara has the compass.'],
    requiredBeats: [{ id: 'meet', briefQuote: 'Meet the courier' }, { id: 'cross', briefQuote: 'cross the river' }],
    sections: [{ id: 1, title: 'Meeting', beatIds: ['meet'], startState: 'At the gate', endState: 'Ready to leave', direction: '' },
        { id: 2, title: 'Crossing', beatIds: ['cross'], startState: 'On the road', endState: 'Across the river', direction: '' }], finalRequirements: [] });

function fixture({ initial = false, maxRetries = 1, respond, large = false } = {}) {
    const source = { latestBrief: brief, model: 'test/writer', snapshot: {}, requestTemplate: { secret_id: 'synthetic-key-id' }, messages: [
        { role: 'system', content: 'Synthetic preset. ' + (large ? 'Full reference remains available. '.repeat(2500) : '') },
        { role: 'assistant', content: 'Earlier accepted context remains exact.' },
        { role: 'user', content: `<brief>${brief}</brief>` },
    ] };
    const job = createJob(source, { wordMin: 500, wordMax: 600, paragraphMin: 5, paragraphMax: 8, sectionCount: 2,
        maxRetries, plannerModel: 'test/planner', reviewerModel: 'test/checker', continuityEnabled: true });
    if (!initial) {
        updatePlan(job, outline());
        job.continuity = { version: 1, initialState: state(), acceptedFrames: [] };
    }
    const f = { job, calls: [], progress: [], current: true };
    f.count = kind => f.calls.filter(call => call.kind === kind).length;
    f.transport = { models: ['test/writer', 'test/planner', 'test/checker'].map(id => ({ id, context_length: 262144 })),
        countTokens: async () => 1000, isCurrent: () => f.current,
        fetcher: async (_path, request) => {
            const body = JSON.parse(request.body);
            const kind = body.messages[0].content === PLANNER_SYSTEM ? 'plan' : body.model === 'test/checker' ? 'check'
                : body.model === 'test/planner' ? 'initial' : 'write';
            const payload = JSON.parse(kind === 'write' ? body.messages.at(-1).content : body.messages[1].content);
            const call = { kind, body, payload, candidate: job.pending }; f.calls.push(call);
            let answer = await respond?.(call, f);
            if (answer?.throw) throw answer.throw;
            if (!answer) {
                if (kind === 'initial') answer = { content: JSON.stringify(state()) };
                if (kind === 'plan') answer = { content: JSON.stringify(outline()) };
                if (kind === 'check') answer = { content: JSON.stringify(report()) };
                if (kind === 'write') {
                    const budget = sectionBudget(job), markers = sectionMarkers(job, job.sections.length);
                    const words = Array.from({ length: budget.wordTarget }, (_, index) => index === 0 ? 'Mara' : 'walked');
                    const split = Math.floor(words.length / 3);
                    const prose = [words.slice(0, split), words.slice(split, split * 2), words.slice(split * 2)]
                        .map(row => row.join(' ') + '.').join('\n\n');
                    answer = { content: `${markers.start}\n${prose}\n${markers.end}` };
                }
            }
            return { ok: answer.ok ?? true, status: answer.status ?? 200, json: async () => answer.error ? { error: answer.error }
                : { choices: [{ message: { content: answer.content, refusal: answer.refusal }, finish_reason: answer.finishReason ?? 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 20, cost: .001 } } };
        } };
    f.run = (options = {}) => initial
        ? planJob(job, f.transport, { onProgress: progress => f.progress.push(progress), ...options })
        : runJob(job, f.transport, { stopAfterSections: 1, onProgress: progress => f.progress.push(progress), ...options });
    return f;
}

for (const [label, invalid] of [
    ['JSON', () => '{MODEL_OUTPUT_MUST_NOT_BE_ECHOED'],
    ['schema', () => JSON.stringify({ ...state(), extra: 'MODEL_OUTPUT_MUST_NOT_BE_ECHOED' })],
]) {
    test(`initial-state ${label} failure keeps full source and continues without a second helper request`, async () => {
        const f = fixture({ initial: true, large: true, respond(call, run) {
            if (call.kind === 'initial' && run.count('initial') === 1) return { content: invalid() };
        } });
        const sourceBefore = structuredClone(f.job.source);
        await f.run();
        const requests = f.calls.filter(call => call.kind === 'initial');
        assert.equal(requests.length, 1); assert.equal(f.count('plan'), 1);
        assert.deepEqual(requests[0].payload.sourceMessages, sourceBefore.messages);
        assert.equal(requests[0].body.secret_id, 'synthetic-key-id');
        assert.doesNotMatch(JSON.stringify(f.calls.at(-1).body), /MODEL_OUTPUT_MUST_NOT_BE_ECHOED/);
        assert.deepEqual(f.job.source, sourceBefore); assert.deepEqual(f.job.continuity.initialState.facts, []);
        assert.equal(f.job.continuity.initialStatePreparation.status, 'source_only');
        assert.equal(f.job.continuity.initialStatePreparation.reason, 'invalid_notes');
        assert.equal(f.job.calls, 2); assert.equal(f.job.usage.inputTokens, 20); assert.equal(f.job.usage.outputTokens, 40);
        assert.ok(f.progress.every(progress => !/Retrying/.test(progress.message)));
    });
}

for (const [label, invalid] of [
    ['JSON', () => '{INVALID_CHECKER_OUTPUT'],
    ['schema', () => JSON.stringify({ issues: 'invalid', endState: state() })],
    ['joined evidence', () => JSON.stringify({ issues: [{ severity: 'high', problem: 'Unsupported finding.',
        evidenceBefore: 'Mara waits cross the river', evidenceAfter: 'Mara walked', suggestion: 'Unjustified rewrite.' }],
        endState: { ...state(), summary: 'INVALID STATE MUST NEVER ADVANCE' } })],
]) {
    test(`checker ${label} retry retains exactly the same candidate without another writer call`, async () => {
        const f = fixture({ large: true, respond(call, run) {
            if (call.kind === 'check' && run.count('check') === 1) return { content: invalid() };
            if (call.kind === 'check') {
                assert.equal(run.job.sections.length, 0); assert.equal(run.job.continuity.acceptedFrames.length, 0);
                assert.equal(run.job.pending.continuityReport, undefined); assert.equal(run.job.pending.phase, 'checking');
            }
        } });
        await f.run();
        const checks = f.calls.filter(call => call.kind === 'check');
        assert.equal(checks.length, 2); assert.equal(f.count('write'), 1);
        assert.equal(checks[0].candidate, checks[1].candidate);
        assert.deepEqual(checks[1].body.messages.slice(0, -1), checks[0].body.messages);
        assert.deepEqual(checks[1].payload, checks[0].payload);
        assert.equal(f.job.sections[0].text, checks[0].payload.candidate.text);
        assert.equal(f.job.continuity.acceptedFrames.length, 1);
        assert.deepEqual(f.job.continuity.acceptedFrames[0].report, report());
        assert.doesNotMatch(JSON.stringify(checks[1].body), /INVALID_CHECKER_OUTPUT|INVALID STATE MUST NEVER ADVANCE/);
        assert.equal(f.job.calls, 3); assert.equal(f.job.usage.inputTokens, 30);
        assert.ok(f.progress.some(progress => progress.stage === 'checking_section' && /Retrying/.test(progress.message)));
    });
}

for (const initial of [true, false]) {
    for (const maxRetries of [0, 1, 2]) {
        test(`${initial ? 'initial fallback stays single-call' : 'checker parser retry stays bounded'} with configured maxRetries ${maxRetries}`, async () => {
            const target = initial ? 'initial' : 'check';
            const f = fixture({ initial, maxRetries, respond: call => call.kind === target ? { content: '{malformed' } : undefined });
            if (initial) await f.run(); else await assert.rejects(f.run(), /valid JSON/);
            assert.equal(f.count(target), initial ? 1 : 1 + Math.min(1, maxRetries));
            assert.equal(f.job.sections.length, 0); assert.equal(f.job.continuity.acceptedFrames.length, 0);
            if (initial) { assert.equal(f.job.continuity.initialStatePreparation.status, 'source_only'); assert.equal(f.count('plan'), 1); }
            else { assert.equal(f.count('write'), 1); assert.equal(f.job.pending.phase, 'checking'); assert.equal(f.job.pending.attempts, 1); }
        });
    }
}

test('exhausted checker-format retries preserve the candidate for explicit Resume', async () => {
    let fail = true;
    const f = fixture({ respond: call => fail && call.kind === 'check' ? { content: '{malformed' } : undefined });
    await assert.rejects(f.run(), /valid JSON/); const candidate = f.job.pending;
    fail = false; await f.run();
    assert.equal(f.count('write'), 1); assert.equal(f.count('check'), 3);
    assert.equal(f.job.sections[0].text, candidate.text); assert.equal(f.job.continuity.acceptedFrames.length, 1);
});

for (const initial of [true, false]) {
    for (const [label, answer, expected] of [
        ['network failure', { throw: new Error('Synthetic network failure') }, /network failure/],
        ['provider failure', { ok: false, status: 429, error: { code: 429 } }, /rate limited/],
        ['provider context failure', { ok: false, status: 413, error: { code: 413 } }, /context limit/],
        ['refusal', { content: '{}', refusal: 'Synthetic refusal' }, /declined/],
        ['empty provider content', { content: '' }, /no story text/],
        ['truncation', { content: '{malformed', finishReason: 'length' }, /output limit/],
    ]) {
        if (initial && label === 'truncation') continue; // Initial-only output-limit recovery has dedicated coverage.
        test(`${initial ? 'initial' : 'checker'} ${label} never spends a format retry`, async () => {
            const target = initial ? 'initial' : 'check';
            const f = fixture({ initial, respond: call => call.kind === target ? answer : undefined });
            await assert.rejects(f.run(), expected); assert.equal(f.count(target), 1);
            assert.equal(f.job.sections.length, 0); assert.equal(f.job.continuity.acceptedFrames.length, 0);
            if (!initial) assert.equal(f.job.pending.phase, 'checking');
        });
    }
}

for (const mode of ['abort', 'source change']) {
    test(`${mode} at retry notification prevents the second paid helper call`, async () => {
        const controller = new AbortController();
        const f = fixture({ respond: call => call.kind === 'check' ? { content: '{malformed' } : undefined });
        f.transport.signal = controller.signal;
        await assert.rejects(f.run({ onProgress(progress) {
            if (/Retrying/.test(progress.message)) {
                if (mode === 'abort') controller.abort(); else f.current = false;
            }
        } }), mode === 'abort' ? { name: 'AbortError' } : /source chat/);
        assert.equal(f.count('check'), 1); assert.equal(f.job.calls, 2);
        assert.equal(f.job.sections.length, 0); assert.equal(f.job.pending.phase, 'checking');
    });
}

test('retry rechecks context with the correction included and fails without dropping source', async () => {
    const f = fixture({ respond: call => call.kind === 'check' ? { content: '{malformed' } : undefined });
    f.transport.countTokens = async messages => /previous helper response could not be validated/.test(messages.at(-1).content) ? 999999 : 1000;
    await assert.rejects(f.run(), /no longer fit/);
    assert.equal(f.count('check'), 1); assert.equal(f.job.calls, 2);
    assert.equal(f.job.sections.length, 0); assert.equal(f.job.pending.phase, 'checking');
});

test('a valid high-severity report uses the existing rewrite allowance, not a parser retry', async () => {
    const f = fixture({ respond(call, run) {
        if (call.kind === 'check' && run.count('check') === 1) return { content: JSON.stringify({ issues: [{ severity: 'high',
            problem: 'Synthetic concrete contradiction.', evidenceBefore: 'Mara waits at the gate with the compass.',
            evidenceAfter: 'Mara walked', suggestion: 'Correct the established object ownership.' }], endState: state() }) };
    } });
    await f.run();
    assert.equal(f.count('write'), 2); assert.equal(f.count('check'), 2);
    assert.ok(f.calls.filter(call => call.kind === 'check').every(call => call.body.messages.length === 2));
    assert.equal(f.job.sections[0].attempts, 2); assert.equal(f.job.continuity.acceptedFrames.length, 1);
    assert.ok(f.calls.filter(call => call.kind === 'write')[1].payload.repair);
});
