import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, planJob, validatePlan, updatePlan, parsePlannerResponse, PLANNER_SYSTEM } from '../../extensions/StoryBuilder/builder-core.js';

const BRIEF = 'Mara says, “Keep the blue case sealed.”\r\n\tCross by the marked bridge—not the closed span.\n\nReturn the brass key to its tray, then obtain the clerk’s receipt.';
const SETTINGS = { plannerModel: 'test/planner', writerModel: 'test/writer', wordMin: 500, wordMax: 600,
    paragraphMin: 5, paragraphMax: 20, sectionCount: 2, maxRetries: 1, continuityEnabled: false };
const legacyPlan = () => ({ fixedFacts: ['The case is blue.'],
    requiredBeats: [{ id: 'b1', briefQuote: 'Keep the blue case sealed.' }, { id: 'b2', briefQuote: 'Return the brass key to its tray' }],
    sections: [{ id: 1, title: 'Crossing', beatIds: ['b1'], startState: 'At the bridge', endState: 'Across the bridge', direction: 'Use the marked route.' },
        { id: 2, title: 'Return', beatIds: ['b2'], startState: 'At the clerk’s desk', endState: 'Receipt obtained', direction: 'Return the key first.' }],
    finalRequirements: ['Obtain the receipt.'] });

function referencePlan(payload) {
    const passages = payload.briefPassages.filter(passage => passage.text.trim());
    return { ...legacyPlan(), requiredBeats: [
        { id: 'b1', passageId: passages[0].id },
        { id: 'b2', passageId: passages.at(-1).id },
    ] };
}

function fixture({ brief = BRIEF, settings, respond, countTokens } = {}) {
    const source = { latestBrief: brief, model: 'test/writer', snapshot: { id: 'planner-synthetic' },
        messages: [{ role: 'system', content: 'Synthetic prose instructions remain unchanged.' },
            { role: 'assistant', content: 'Earlier synthetic context stays in the reference.' },
            { role: 'user', content: `Before the full brief.\n${brief}\nAfter the full brief.` }], requestTemplate: {} };
    const job = createJob(source, { ...SETTINGS, ...settings });
    const calls = [], progress = [], controller = new AbortController();
    let current = true;
    const transport = { signal: controller.signal, isCurrent: async () => current,
        models: [{ id: 'test/planner', context_length: 131072, top_provider: { max_completion_tokens: 32768 } }],
        countTokens: countTokens || (async () => 1000),
        fetcher: async (url, request) => {
            const body = JSON.parse(request.body), payload = JSON.parse(body.messages[1].content);
            const call = { url, body, payload }; calls.push(call);
            const answer = await respond?.(call, calls.length, { job, controller, setCurrent: value => current = value })
                ?? { text: JSON.stringify(referencePlan(payload)) };
            if (answer.throw) throw answer.throw;
            return { ok: answer.ok ?? true, status: answer.status ?? 200,
                json: async () => answer.data ?? { choices: [{ message: { content: answer.text, ...answer.message },
                    finish_reason: answer.finishReason ?? 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 22, cost: .001 } } };
        } };
    return { job, calls, progress, transport, controller, setCurrent: value => current = value,
        run: options => planJob(job, transport, { onProgress: event => progress.push(event), ...options }) };
}

test('planner resolves code-owned source IDs without asking the model to reproduce punctuation', async () => {
    const f = fixture(), before = structuredClone(f.job.source);
    await f.run();
    assert.equal(f.calls.length, 1);
    assert.equal(f.job.status, 'ready');
    assert.deepEqual(f.job.source, before);
    const payload = f.calls[0].payload;
    assert.equal(payload.briefPassages.map(p => p.text).join(''), BRIEF);
    assert.equal(Object.hasOwn(payload, 'latestBrief'), false, 'do not duplicate a huge brief');
    assert.deepEqual(payload.sourceMessages.slice(0, 2), before.messages.slice(0, 2));
    assert.ok(!payload.sourceMessages.at(-1).content.includes(BRIEF));
    assert.match(payload.sourceMessages.at(-1).content, /briefPassages/);
    assert.match(payload.sourceMessages.at(-1).content, /^Before the full brief\./);
    assert.match(payload.sourceMessages.at(-1).content, /After the full brief\.$/);
    const indexed = new Map(payload.briefPassages.map(p => [p.id, p.text]));
    for (const beat of f.job.plan.requiredBeats) assert.equal(beat.briefQuote, indexed.get(beat.passageId));
    assert.ok(f.progress.some(event => event.stage === 'planning'));
    assert.equal(f.progress.at(-1).stage, 'planning_ready');
});

test('a paraphrased legacy quote gets one source-ID correction request and each request is accounted', async () => {
    const f = fixture({ respond(call, attempt) {
        if (attempt === 1) { const bad = legacyPlan(); bad.requiredBeats[0].briefQuote = 'Mara says to keep the blue box unopened.'; return { text: JSON.stringify(bad) }; }
        return { text: JSON.stringify(referencePlan(call.payload)) };
    } });
    await f.run();
    assert.equal(f.calls.length, 2); assert.equal(f.job.calls, 2);
    assert.deepEqual(f.job.usage, { inputTokens: 22, outputTokens: 44, cost: .002 });
    assert.deepEqual(f.calls[1].payload, f.calls[0].payload, 'retry must preserve the full source payload');
    assert.ok(f.calls[0].body.messages[0].content.startsWith(PLANNER_SYSTEM));
    assert.match(JSON.stringify(f.calls[1].body.messages), /passageId/);
    assert.equal(f.progress.filter(event => event.stage === 'planning_retry').length, 1);
    assert.equal(f.job.status, 'ready');
});

test('unknown passage IDs never fall back to a valid legacy quotation and stop after one retry', async () => {
    const f = fixture({ respond() { const bad = legacyPlan(); bad.requiredBeats[0].passageId = 'p999999'; return { text: JSON.stringify(bad) }; } });
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 2); assert.equal(f.job.calls, 2);
    assert.equal(f.job.plan, null); assert.deepEqual(f.job.sections, []);
    assert.equal(f.job.status, 'failed');
    assert.equal(f.progress.filter(event => event.stage === 'planning_retry').length, 1);
});

test('a zero retry preference still prevents extra paid outline requests', async () => {
    const f = fixture({ settings: { maxRetries: 0 }, respond: () => ({ text: '{invalid' }) });
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 1); assert.equal(f.job.plan, null);
    assert.ok(!f.progress.some(event => event.stage === 'planning_retry'));
});

test('two allowed retries still cap planner format recovery at one', async () => {
    const f = fixture({ settings: { maxRetries: 2 }, respond: () => ({ text: '{invalid' }) });
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 2); assert.equal(f.job.plan, null);
});

test('long mixed-punctuation briefs remain lossless and every generated quotation is bounded', async () => {
    const middle = ('The adult courier checks the blue case—without opening it. Café lamps reflect on the floor.\u00a0').repeat(45);
    const brief = `\r\n\t“Leave the library.”\n\n${middle}Return the key to the marked tray.\r\n\r\n最後に領収書を受け取る。🙂\t`;
    const f = fixture({ brief }), before = structuredClone(f.job.source);
    await f.run();
    const passages = f.calls[0].payload.briefPassages;
    assert.ok(passages.length > 2);
    assert.equal(passages.map(p => p.text).join(''), brief);
    assert.deepEqual(f.job.source, before);
    assert.ok(passages.every(p => p.text.length <= 1800));
    assert.ok(f.job.plan.requiredBeats.every(b => b.briefQuote.length <= 2000 && brief.includes(b.briefQuote)));
    assert.equal(f.job.plan.requiredBeats.at(-1).briefQuote.includes('領収書'), true);
});

test('legacy exact quotations still validate without silently gaining source IDs', async () => {
    const f = fixture({ respond: () => ({ text: JSON.stringify(legacyPlan()) }) });
    await f.run();
    assert.deepEqual(f.job.plan, legacyPlan());
    assert.equal(f.calls.length, 1);
});

test('cached source-ID plans cannot be rebound to edited brief text', async () => {
    const f = fixture(); await f.run();
    const cached = structuredClone(f.job.plan);
    f.job.source.latestBrief = BRIEF.replace('blue', 'red');
    f.job.source.messages.at(-1).content = f.job.source.latestBrief;
    assert.throws(() => validatePlan(cached, f.job));
    assert.deepEqual(f.job.plan, cached);
});

test('unchanged canonical outline edits preserve a resumable candidate', async () => {
    const f = fixture(); await f.run();
    const pending = { text: 'Synthetic pending prose.', phase: 'checking' };
    f.job.pending = pending;
    updatePlan(f.job, structuredClone(f.job.plan));
    assert.equal(f.job.pending, pending);
});

for (const [name, mutate] of [
    ['null requirement', p => { p.requiredBeats[0] = null; }],
    ['duplicate requirement ID', p => { p.requiredBeats[1].id = p.requiredBeats[0].id; }],
    ['missing assignment', p => { p.sections[1].beatIds = []; }],
    ['duplicate assignment', p => { p.sections[1].beatIds = ['b1', 'b2']; }],
    ['null section', p => { p.sections[0] = null; }],
    ['wrong section count', p => { p.sections.pop(); }],
]) test(`${name} remains a fixed outline failure without partial acceptance`, async () => {
    const f = fixture({ respond(call) { const p = referencePlan(call.payload); mutate(p); return { text: JSON.stringify(p) }; } });
    await assert.rejects(f.run(), error => error instanceof Error && error.name !== 'TypeError');
    assert.equal(f.calls.length, 2); assert.equal(f.job.plan, null);
});

for (const [name, answer, pattern] of [
    ['provider error', { ok: false, status: 503, data: { error: { message: 'Synthetic provider error' } } }, /failed/],
    ['refusal', { text: '{}', message: { refusal: 'Synthetic refusal' } }, /declined/],
    ['truncated output', { text: '{}', finishReason: 'length' }, /output limit/],
    ['network failure', { throw: new Error('Synthetic network failure') }, /Synthetic network failure/],
    ['tool response', { text: '{}', message: { tool_calls: [{ id: 'synthetic' }] } }, /non-story/],
]) test(`${name} is not treated as a planner format retry`, async () => {
    const f = fixture({ respond: () => answer });
    await assert.rejects(f.run(), pattern);
    assert.equal(f.calls.length, 1); assert.equal(f.job.plan, null);
    assert.ok(!f.progress.some(event => event.stage === 'planning_retry'));
});

test('source changes after receipt stop acceptance and do not trigger a format retry', async () => {
    const f = fixture({ respond(call, _attempt, state) { state.setCurrent(false); return { text: JSON.stringify(referencePlan(call.payload)) }; } });
    await assert.rejects(f.run(), /source.*changed/i);
    assert.equal(f.calls.length, 1); assert.equal(f.job.plan, null);
});

test('cancellation after receipt preserves no outline and does not trigger another request', async () => {
    const f = fixture({ respond(call, _attempt, state) { state.controller.abort(); return { text: JSON.stringify(referencePlan(call.payload)) }; } });
    await assert.rejects(f.run(), { name: 'AbortError' });
    assert.equal(f.calls.length, 1); assert.equal(f.job.plan, null); assert.equal(f.job.status, 'paused');
});

test('cancelling during retry notification prevents the second paid request', async () => {
    const f = fixture({ respond: () => ({ text: '{invalid' }) });
    await assert.rejects(f.run({ onProgress(event) { if (event.stage === 'planning_retry') f.controller.abort(); } }), { name: 'AbortError' });
    assert.equal(f.calls.length, 1); assert.equal(f.job.plan, null);
});

test('a retry progress callback failure is not swallowed as malformed model data', async () => {
    const f = fixture({ respond: () => ({ text: '{invalid' }) });
    await assert.rejects(f.run({ onProgress(event) { if (event.stage === 'planning_retry') throw new Error('Synthetic display failure'); } }), /Synthetic display failure/);
    assert.equal(f.calls.length, 1); assert.equal(f.job.plan, null);
});

test('a source edit during the accepted-outline notification still prevents a stale plan commit', async () => {
    const f = fixture();
    await assert.rejects(f.run({ onProgress(event) { if (event.stage === 'planning_ready') f.setCurrent(false); } }), /source.*changed/i);
    assert.equal(f.calls.length, 1); assert.equal(f.job.plan, null);
    assert.equal(f.job.status, 'failed');
});

test('failure of the accepted-outline notification leaves the outline uncommitted', async () => {
    const f = fixture();
    await assert.rejects(f.run({ onProgress(event) { if (event.stage === 'planning_ready') throw new Error('Synthetic accepted-outline display failure'); } }), /Synthetic accepted-outline display failure/);
    assert.equal(f.calls.length, 1); assert.equal(f.job.plan, null);
    assert.equal(f.job._busy, false);
});

test('a budget failure sends no planner request and makes no format retry', async () => {
    const f = fixture({ countTokens: async () => 200000 });
    await assert.rejects(f.run(), /no longer fit/);
    assert.equal(f.calls.length, 0); assert.equal(f.job.plan, null);
});

test('planner reader handles only bounded unambiguous wrappers around complete JSON', () => {
    const value = { note: 'A quoted brace } and an escaped quote " remain data.', nested: { values: [1, 2] } };
    const raw = JSON.stringify(value);
    for (const wrapped of [raw, '```json\n' + raw + '\n```', raw + '\n' + raw,
        raw + '\nNote: the outline is complete.']) assert.deepEqual(parsePlannerResponse(wrapped), value);
});

test('planner reader rejects damaged or ambiguous data rather than repairing it', () => {
    const raw = JSON.stringify({ valid: true });
    for (const invalid of [raw.slice(0, -1), raw + '\n' + JSON.stringify({ valid: false }), raw + raw,
        raw + '\nnull', raw + '\n[]', raw + '\n42', raw + '\n"another value"',
        raw + '\nNote with {structured text}', raw + '\n' + 'x'.repeat(2001),
        'Explanation before the report.\n' + raw]) {
        assert.throws(() => parsePlannerResponse(invalid), /outline|planner/i);
    }
});

test('an incomplete outline receives a new report rather than accepting repaired model data', async () => {
    const f = fixture({ respond(call, attempt) {
        const raw = JSON.stringify(referencePlan(call.payload));
        return { text: attempt === 1 ? raw.slice(0, -1) : raw };
    } });
    await f.run();
    assert.equal(f.calls.length, 2); assert.equal(f.job.status, 'ready');
    assert.equal(f.job.plan.requiredBeats.length, 2);
});
