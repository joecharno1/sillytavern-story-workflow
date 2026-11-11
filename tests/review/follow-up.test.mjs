import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFollowUpSettings, createFollowUpSession, updateSessionOptions, advanceSession,
    reviewFollowUp, reviseFollowUp, followUpSpend, assertFollowUpCurrent } from '../../extensions/StoryReview/follow-up.js';

const source = 'Mara reached the courtyard.\n\nShe kept the brass compass sealed.\n\nThe gate opened at dawn.';
const validReport = JSON.stringify({ summary: 'The passage follows the supplied brief.', strengths: [], issues: [] });
const models = ['fixture/review', 'fixture/revision', 'fixture/other'].map(id => ({ id, context_length: 262144,
    top_provider: { max_completion_tokens: 16384 }, pricing: { prompt: '0.000001', completion: '0.000002' } }));
const reply = (content = validReport, usage = { cost: 0.002, prompt_tokens: 1000, completion_tokens: 50 }, choice = {}) => ({
    ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content }, ...choice }], ...(usage === undefined ? {} : { usage }) }),
});
const snapshot = () => ({ source, brief: 'Reach the courtyard with the sealed brass compass.',
    history: [{ role: 'user', content: 'The compass must remain sealed.' }, { role: 'assistant', content: 'Mara approached the courtyard.' }],
    requestTemplate: { secret_id: 'synthetic-secret-selection' } });
const options = (followUp = {}) => resolveFollowUpSettings({ model: 'fixture/review', maxOutput: 100,
    wordMin: 1, wordMax: 1000, paragraphMin: 1, paragraphMax: 30, followUp },
{ reviewerModel: 'fixture/review', revisionModel: 'fixture/revision', strictParagraphs: false });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture({ followUp = {}, generate, catalog = models, tokenizer = 1000, onSpend } = {}) {
    const controller = new AbortController(), requests = [], usage = [], spends = [], original = snapshot();
    const session = createFollowUpSession(original, options(followUp));
    let current = true;
    const transport = {
        headers: { 'X-CSRF-Token': 'synthetic-csrf' }, signal: controller.signal, models, countTokens: async () => 1000,
        assertCurrent: value => { assert.equal(value, original); return current; },
        onUsage: value => usage.push(value),
        onSpend: value => { spends.push(value); onSpend?.(value, controller); },
        fetcher: async (url, request) => {
            const body = JSON.parse(request.body); requests.push({ url, body, signal: request.signal, headers: request.headers });
            if (url.endsWith('/status')) return { ok: true, json: async () => ({ data: catalog }) };
            if (url.startsWith('/api/tokenizers/')) return { ok: true, json: async () => ({ token_count: tokenizer }) };
            if (url.endsWith('/generate')) return generate ? generate(body) : reply();
            throw new Error('Unexpected synthetic endpoint.');
        },
    };
    return { session, original, transport, controller, requests, usage, spends, stale() { current = false; },
        paid: () => requests.filter(item => item.url.endsWith('/generate')) };
}

test('session creation is local, retains native identity, and exposes no source in spending metadata', () => {
    const original = snapshot(), session = createFollowUpSession(original, options());
    assert.equal(session.snapshot, original);
    assert.equal(session.revision, 0);
    assert.equal(followUpSpend(session).remainingUsd, 1);
    assert.equal(session.effectiveReviewModel, 'fixture/review');
    assert.equal(session.effectiveRevisionModel, 'fixture/revision');
    assert.ok(!JSON.stringify(followUpSpend(session)).includes('compass'));
    assert.ok(Object.isFrozen(session.preferences));
});

test('review uses one general focus and accounts usage with secret selection preserved only in requests', async () => {
    const f = fixture(); const result = await reviewFollowUp(f.session, f.transport);
    assert.equal(result.issues.length, 0);
    assert.equal(f.paid().length, 1);
    assert.equal(JSON.parse(f.paid()[0].body.messages[1].content).focus, 'general');
    assert.equal(f.paid()[0].body.secret_id, 'synthetic-secret-selection');
    assert.equal(f.requests.find(item => item.url.endsWith('/status')).body.secret_id, 'synthetic-secret-selection');
    assert.ok(f.requests.every(item => item.signal === f.controller.signal && item.headers === f.transport.headers));
    assert.equal(followUpSpend(f.session).reportedUsd, 0.002);
    assert.equal(followUpSpend(f.session).reservedUsd, 0);
    assert.equal(f.usage.length, 1);
    assert.ok(!JSON.stringify(f.spends).includes('synthetic-secret-selection'));
});

test('a malformed report retries once under the same allowance and counts both paid responses', async () => {
    let attempts = 0;
    const f = fixture({ generate: () => reply(++attempts === 1 ? '{"summary":"missing brace"' : validReport) });
    await reviewFollowUp(f.session, f.transport);
    assert.equal(f.paid().length, 2);
    assert.equal(followUpSpend(f.session).reportedUsd, 0.004);
    assert.equal(f.usage.length, 2);
    assert.deepEqual(f.paid()[0].body.messages[1], f.paid()[1].body.messages[1]);
});

test('repeated previews share one spending record and never mutate the selected manuscript', async () => {
    const f = fixture({ followUp: { spendLimitUsd: 0.01 }, generate: () => reply('She carried the sealed brass compass carefully.', { cost: 0.004 }) });
    const first = await reviseFollowUp(f.session, [2], 'Clarify the movement.', f.transport);
    const second = await reviseFollowUp(f.session, [2], 'Try a shorter sentence.', f.transport);
    assert.equal(first.model, 'fixture/revision'); assert.equal(second.sessionRevision, f.session.revision);
    assert.equal(f.session.snapshot.source, source);
    assert.equal(followUpSpend(f.session).reportedUsd, 0.008);
    await assert.rejects(reviseFollowUp(f.session, [2], 'Another variation.', f.transport), { name: 'SpendLimitError' });
    assert.equal(f.paid().length, 2);
    assert.equal(f.session.snapshot.source, source);
});

test('unknown model prices block before any paid request', async () => {
    const f = fixture({ catalog: models.map(({ pricing: _pricing, ...rest }) => rest) });
    await assert.rejects(reviewFollowUp(f.session, f.transport), { name: 'BudgetMetadataError' });
    assert.equal(f.paid().length, 0);
    assert.equal(followUpSpend(f.session).accountedUsd, 0);
});

test('bad tokenizer metadata cannot authorize a paid request', async () => {
    const f = fixture({ tokenizer: '1000' });
    await assert.rejects(reviewFollowUp(f.session, f.transport), { name: 'BudgetMetadataError' });
    assert.equal(f.paid().length, 0);
});

test('cancelling immediately after reservation releases a known undispatched request', async () => {
    const f = fixture({ onSpend: (value, controller) => { if (value.reservedUsd > 0) controller.abort(); } });
    await assert.rejects(reviewFollowUp(f.session, f.transport), { name: 'AbortError' });
    assert.equal(f.paid().length, 0);
    assert.equal(followUpSpend(f.session).accountedUsd, 0);
});

test('a cancelled dispatched request holds unknown cost, then reconciles late real usage exactly once', async () => {
    const gate = deferred(), started = deferred();
    const f = fixture({ generate: () => { started.resolve(); return gate.promise; } });
    const running = reviewFollowUp(f.session, f.transport);
    await started.promise; f.controller.abort();
    assert.ok(followUpSpend(f.session).unknownUsd > 0);
    gate.resolve(reply());
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal(followUpSpend(f.session).unknownUsd, 0);
    assert.equal(followUpSpend(f.session).reportedUsd, 0.002);
    assert.equal(f.paid().length, 1);
});

test('a provider connection failure retains a charge allowance and does not retry', async () => {
    const f = fixture({ generate: () => { throw new Error('Synthetic connection failure.'); } });
    await assert.rejects(reviewFollowUp(f.session, f.transport), /connection failure/);
    assert.equal(f.paid().length, 1);
    assert.ok(followUpSpend(f.session).unknownUsd > 0);
});

test('malformed service JSON never exposes the provider text in an error and retains its unknown cost', async () => {
    const marker = 'SYNTHETIC PRIVATE PROVIDER RESPONSE';
    const f = fixture({ generate: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(`Unexpected token in ${marker}`); } }) });
    await assert.rejects(reviewFollowUp(f.session, f.transport), error => {
        assert.equal(error.message, 'The model service did not return a readable response. No revision was applied.');
        assert.ok(!error.message.includes(marker)); return true;
    });
    assert.equal(f.paid().length, 1);
    assert.ok(followUpSpend(f.session).unknownUsd > 0);
});

test('usage settles before a stale-source response is rejected', async () => {
    const f = fixture({ generate: () => ({ ok: true, status: 200, json: async () => {
        f.stale(); return { choices: [{ finish_reason: 'stop', message: { content: validReport } }], usage: { cost: 0.003 } };
    } }) });
    await assert.rejects(reviewFollowUp(f.session, f.transport), { name: 'StaleFollowUpError' });
    assert.equal(followUpSpend(f.session).reportedUsd, 0.003);
    assert.equal(f.paid().length, 1);
    assert.equal(f.usage.length, 0, 'the caller must not accept stale content merely to account its charge');
});

for (const [label, choice] of [
    ['truncation', { finish_reason: 'length' }],
    ['refusal', { message: { content: '', refusal: 'Synthetic refusal.' } }],
]) test(`${label} is charged once and never retried as a malformed report`, async () => {
    const f = fixture({ generate: () => reply(validReport, { cost: 0.005 }, choice) });
    await assert.rejects(reviewFollowUp(f.session, f.transport));
    assert.equal(f.paid().length, 1);
    assert.equal(followUpSpend(f.session).reportedUsd, 0.005);
});

test('numeric zero is reported, complete token usage estimates, and partial usage retains the full hold', async () => {
    for (const [usage, expected] of [[{ cost: 0 }, 'zero'], [{ prompt_tokens: 1000, completion_tokens: 50 }, 'estimated'], [{ prompt_tokens: 1000 }, 'unknown']]) {
        const f = fixture({ generate: () => reply(validReport, usage) });
        await reviewFollowUp(f.session, f.transport);
        const spending = followUpSpend(f.session);
        if (expected === 'zero') assert.equal(spending.accountedUsd, 0);
        if (expected === 'estimated') assert.equal(spending.estimatedUsd, 0.0011);
        if (expected === 'unknown') assert.ok(spending.unknownUsd > 0);
    }
});

test('uncapped editing skips pricing checks while retaining numeric reported and unknown request counts', async () => {
    let attempt = 0;
    const f = fixture({ followUp: { spendLimitUsd: 0 }, generate: () => reply(validReport, ++attempt === 1 ? { cost: 0 } : {}) });
    await reviewFollowUp(f.session, f.transport); await reviewFollowUp(f.session, f.transport);
    assert.ok(f.requests.every(item => item.url.endsWith('/generate')));
    const spending = followUpSpend(f.session);
    assert.equal(spending.limitUsd, 0); assert.equal(spending.reportedRequests, 1); assert.equal(spending.unreportedRequests, 1);
});

test('settings changes and selecting a new draft preserve the fixed allowance and invalidate old proposals', async () => {
    const f = fixture({ generate: () => reply('Mara kept the sealed brass compass close.') });
    const proposal = await reviseFollowUp(f.session, [2], 'Clarify the action.', f.transport);
    const spent = followUpSpend(f.session).reportedUsd;
    updateSessionOptions(f.session, options({ focus: 'prose', reviewModel: 'fixture/other' }));
    assert.ok(f.session.revision > proposal.sessionRevision);
    assert.equal(f.session.effectiveReviewModel, 'fixture/other');
    assert.equal(followUpSpend(f.session).reportedUsd, spent);
    assert.throws(() => updateSessionOptions(f.session, options({ spendLimitUsd: 2 })), /limit is fixed/);
    const next = { ...snapshot(), source: proposal.updated, brief: 'Keep this accepted version.' };
    advanceSession(f.session, next);
    assert.equal(f.session.snapshot, next);
    assert.equal(followUpSpend(f.session).reportedUsd, spent);
    assert.equal(followUpSpend(f.session).limitUsd, 1);
});

test('an active request pins its draft and options and rejects overlapping editing actions', async () => {
    const gate = deferred(), started = deferred();
    const f = fixture({ generate: () => { started.resolve(); return gate.promise; } });
    const running = reviewFollowUp(f.session, f.transport); await started.promise;
    assert.throws(() => updateSessionOptions(f.session, options({ focus: 'prose' })), /current follow-up request/);
    assert.throws(() => advanceSession(f.session, snapshot()), /current follow-up request/);
    await assert.rejects(reviewFollowUp(f.session, f.transport), /current follow-up request/);
    gate.resolve(reply()); await running;
    assert.equal(f.paid().length, 1);
});

test('captured text/history changes and native message edits are blocked before dispatch', async () => {
    for (const mutate of [f => { f.original.source += ' Changed.'; }, f => { f.original.history[0].content += ' Changed.'; },
        f => { f.original.message = { mes: 'Different draft.', swipe_id: 0 }; f.original.swipeId = 0; }]) {
        const f = fixture(); mutate(f);
        await assert.rejects(reviewFollowUp(f.session, f.transport), { name: 'StaleFollowUpError' });
        assert.equal(f.paid().length, 0);
    }
});

test('already-aborted or externally stale selections cannot make metadata or model calls', async () => {
    const aborted = fixture(); aborted.controller.abort();
    await assert.rejects(reviewFollowUp(aborted.session, aborted.transport), { name: 'AbortError' });
    assert.equal(aborted.requests.length, 0);
    const stale = fixture(); stale.stale();
    await assert.rejects(assertFollowUpCurrent(stale.session, stale.transport), { name: 'StaleFollowUpError' });
    assert.equal(stale.requests.length, 0);
});

test('oversized source is not trimmed to make a small model fit', async () => {
    const f = fixture(); f.transport.models = models.map(item => ({ ...item, context_length: 100 }));
    await assert.rejects(reviewFollowUp(f.session, f.transport), /do not fit/);
    assert.equal(f.requests.length, 0); assert.equal(f.session.snapshot.source, source);
});

for (const followUp of [{ focus: 'unknown' }, { custom: 'x'.repeat(8001) }, { spendLimitUsd: -1 },
    { spendLimitUsd: ' ' }, { useBuilderStyles: 'false' }, { reviewModel: 'invalid model' }]) {
    test(`invalid follow-up preference ${Object.keys(followUp)[0]} is rejected locally`, () => assert.throws(() => options(followUp)));
}
