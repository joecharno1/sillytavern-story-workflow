import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpendLedger, reserveRequest, settleRequest, failRequest, cancelReservation,
    spendSummary, prepareReservation } from '../../extensions/StoryBuilder/spend-budget.js';

const request = (overrides = {}) => ({ model: 'test/writer', estimatedInputTokens: 100, maxOutputTokens: 200,
    pricing: { prompt: '0.001', completion: '0.002', request: '0.01' }, ...overrides });
const namedError = name => error => { assert.equal(error.name, name); assert.doesNotMatch(error.message, /PRIVATE/); return true; };

test('a reservation accounts for uncached input, maximum output, and a fixed request fee', () => {
    const ledger = createSpendLedger(1), ticket = reserveRequest(ledger, request());
    assert.equal(ticket.reservedUsd, .51);
    assert.deepEqual(spendSummary(ledger), { limitUsd: 1, reportedUsd: 0, estimatedUsd: 0, unknownUsd: 0,
        reservedUsd: .51, remainingUsd: .49, accountedUsd: .51, overLimit: false });
    ticket.reservedUsd = 0; ticket.rates.prompt = 0;
    assert.equal(spendSummary(ledger).reservedUsd, .51, 'the caller ticket cannot mutate authoritative accounting');
});

test('shared synchronous reservations prevent parallel reviewers from spending the same remaining balance', async () => {
    const ledger = createSpendLedger(.8);
    const attempts = await Promise.allSettled([Promise.resolve().then(() => reserveRequest(ledger, request())),
        Promise.resolve().then(() => reserveRequest(ledger, request()))]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.find(result => result.status === 'rejected').reason.name, 'SpendLimitError');
    assert.equal(ledger.entries.length, 1); assert.equal(spendSummary(ledger).accountedUsd, .51);
});

test('real reported cost replaces its reservation exactly once, including a valid reported zero', () => {
    const ledger = createSpendLedger(1), first = reserveRequest(ledger, request());
    settleRequest(ledger, first, { cost: .12, prompt_tokens: 100000, completion_tokens: 100000 });
    settleRequest(ledger, first, { cost: .9 }); failRequest(ledger, first);
    assert.equal(spendSummary(ledger).reportedUsd, .12); assert.equal(spendSummary(ledger).reservedUsd, 0);
    const second = reserveRequest(ledger, request());
    settleRequest(ledger, second, { cost: 0 });
    assert.equal(spendSummary(ledger).reportedUsd, .12); assert.equal(spendSummary(ledger).unknownUsd, 0);
    assert.equal(ledger.entries[1].state, 'reported'); assert.equal(ledger.entries[1].amountUsd, 0);
});

test('missing reported cost is estimated only from complete numeric token usage and retained prices', () => {
    const ledger = createSpendLedger(1), ticket = reserveRequest(ledger, request());
    settleRequest(ledger, ticket, { prompt_tokens: 20, completion_tokens: 10 });
    assert.deepEqual(spendSummary(ledger), { limitUsd: 1, reportedUsd: 0, estimatedUsd: .05, unknownUsd: 0,
        reservedUsd: 0, remainingUsd: .95, accountedUsd: .05, overLimit: false });
    settleRequest(ledger, ticket, { prompt_tokens: 300, completion_tokens: 300 });
    assert.equal(spendSummary(ledger).estimatedUsd, .05);
});

test('partial, missing, malformed, or string-only usage never becomes a free request', () => {
    for (const usage of [undefined, {}, { cost: '0' }, { cost: null }, { cost: -1 }, { cost: Infinity },
        { prompt_tokens: 0 }, { completion_tokens: 0 }, { prompt_tokens: '10', completion_tokens: 10 },
        { prompt_tokens: 10, completion_tokens: NaN }, { prompt_tokens: 1.5, completion_tokens: 10 }]) {
        const ledger = createSpendLedger(1), ticket = reserveRequest(ledger, request());
        settleRequest(ledger, ticket, usage);
        assert.equal(spendSummary(ledger).unknownUsd, .51); assert.equal(spendSummary(ledger).accountedUsd, .51);
        assert.equal(spendSummary(ledger).reportedUsd, 0); assert.equal(spendSummary(ledger).estimatedUsd, 0);
    }
});

test('post-dispatch cancellation or failure holds the reservation and late real usage can reconcile it', () => {
    const ledger = createSpendLedger(.6), ticket = reserveRequest(ledger, request());
    failRequest(ledger, ticket); failRequest(ledger, ticket); cancelReservation(ledger, ticket);
    assert.equal(spendSummary(ledger).unknownUsd, .51); assert.equal(spendSummary(ledger).reservedUsd, 0);
    assert.throws(() => reserveRequest(ledger, request()), namedError('SpendLimitError'));
    settleRequest(ledger, ticket, { cost: .08 }); settleRequest(ledger, ticket, { cost: .08 });
    assert.equal(spendSummary(ledger).reportedUsd, .08); assert.equal(spendSummary(ledger).unknownUsd, 0);
    assert.doesNotThrow(() => reserveRequest(ledger, request()));
});

test('a late response can replace an unknown hold with token-based estimated usage', () => {
    const ledger = createSpendLedger(1), ticket = reserveRequest(ledger, request());
    failRequest(ledger, ticket); settleRequest(ledger, ticket, { prompt_tokens: 10, completion_tokens: 5 });
    assert.equal(spendSummary(ledger).unknownUsd, 0); assert.equal(spendSummary(ledger).estimatedUsd, .03);
});

test('known pre-dispatch cancellation releases the hold without inventing a provider charge', () => {
    const ledger = createSpendLedger(.6), ticket = reserveRequest(ledger, request());
    cancelReservation(ledger, ticket); cancelReservation(ledger, ticket); failRequest(ledger, ticket);
    assert.equal(ledger.entries[0].state, 'released');
    assert.equal(spendSummary(ledger).accountedUsd, 0); assert.equal(spendSummary(ledger).remainingUsd, .6);
    assert.doesNotThrow(() => reserveRequest(ledger, request()));
});

test('actual charges exceeding the reservation remain recorded and block subsequent requests', () => {
    const ledger = createSpendLedger(.6), ticket = reserveRequest(ledger, request());
    settleRequest(ledger, ticket, { cost: .8 });
    assert.equal(spendSummary(ledger).reportedUsd, .8); assert.equal(spendSummary(ledger).overLimit, true);
    assert.equal(spendSummary(ledger).remainingUsd, 0);
    assert.throws(() => reserveRequest(ledger, request()), namedError('SpendLimitError'));
});

test('serialized ledgers preserve reservations and unknown holds across Resume', () => {
    const original = createSpendLedger(2), first = reserveRequest(original, request()), second = reserveRequest(original, request());
    failRequest(original, first);
    const resumed = JSON.parse(JSON.stringify(original));
    assert.deepEqual(spendSummary(resumed), spendSummary(original));
    settleRequest(resumed, first, { cost: .1 }); settleRequest(resumed, second, { cost: .2 });
    assert.equal(spendSummary(resumed).reportedUsd, .3); assert.equal(spendSummary(resumed).remainingUsd, 1.7);
    assert.equal(reserveRequest(resumed, request()).id, `${resumed.id}:3`);
    assert.equal(spendSummary(original).unknownUsd, .51, 'resumed state is a detached JSON copy');
});

test('a ticket from another ledger cannot release or settle this job’s reservation', () => {
    const a = createSpendLedger(1), b = createSpendLedger(1), ticket = reserveRequest(a, request());
    reserveRequest(b, request());
    assert.throws(() => settleRequest(b, ticket, { cost: 0 }), namedError('BudgetMetadataError'));
    assert.throws(() => cancelReservation(b, ticket), namedError('BudgetMetadataError'));
    assert.equal(spendSummary(b).reservedUsd, .51);
});

test('zero pricing is valid while missing, negative, blank, and nonfinite pricing block authorization', () => {
    const free = createSpendLedger(0), ticket = reserveRequest(free, request({ pricing: { prompt: '0', completion: 0 } }));
    assert.equal(ticket.reservedUsd, 0);
    settleRequest(free, ticket, { prompt_tokens: 100, completion_tokens: 200 }); assert.equal(spendSummary(free).accountedUsd, 0);
    for (const pricing of [undefined, {}, { prompt: 0 }, { completion: 0 },
        { prompt: '', completion: 0 }, { prompt: ' ', completion: 0 }, { prompt: '-1', completion: 0 },
        { prompt: null, completion: 0 }, { prompt: NaN, completion: 0 }, { prompt: 0, completion: Infinity },
        { prompt: 0, completion: 0, request: null }, { prompt: 0, completion: 0, request: -1 }]) {
        const ledger = createSpendLedger(1);
        assert.throws(() => reserveRequest(ledger, request({ pricing })), namedError('BudgetMetadataError'));
        assert.equal(ledger.entries.length, 0);
    }
});

test('malformed model, count, ledger, and limit metadata fail before creating a reservation', () => {
    for (const limit of [undefined, null, '1', -1, NaN, Infinity]) assert.throws(() => createSpendLedger(limit), namedError('BudgetMetadataError'));
    for (const override of [{ model: 'PRIVATE invalid model' }, { estimatedInputTokens: '100' }, { estimatedInputTokens: -1 },
        { estimatedInputTokens: 1.5 }, { maxOutputTokens: 0 }, { maxOutputTokens: Infinity }]) {
        const ledger = createSpendLedger(1);
        assert.throws(() => reserveRequest(ledger, request(override)), namedError('BudgetMetadataError'));
        assert.equal(ledger.entries.length, 0);
    }
    assert.throws(() => spendSummary({}), namedError('BudgetMetadataError'));
});

function preparationFixture({ limit = 1, model = 'test/writer', tokenCount = 1000 } = {}) {
    const f = { ledger: createSpendLedger(limit), calls: [], current: true, controller: new AbortController(), tokenCount };
    f.body = { chat_completion_source: 'openrouter', model, max_tokens: 100, secret_id: 'PRIVATE_SECRET_ID',
        messages: [{ role: 'system', content: 'PRIVATE_SYSTEM_TEXT' }, { role: 'user', content: 'PRIVATE_AUTHOR_TEXT' }] };
    f.catalog = { data: [{ id: model, pricing: { prompt: '0.000001', completion: '0.000002', request: '0.001', cached_prompt: '0' } }] };
    f.deps = { headers: { 'X-CSRF-Token': 'PRIVATE_HEADER' }, signal: f.controller.signal, assertCurrent: () => f.current,
        fetcher: async (path, options) => {
            f.calls.push({ path, options, body: JSON.parse(options.body) });
            assert.ok(!path.endsWith('/generate'), 'preparation never makes a paid model request');
            return { ok: true, status: 200, json: async () => path.endsWith('/status') ? f.catalog : { token_count: f.tokenCount } };
        } };
    f.prepare = () => prepareReservation(f.ledger, f.body, f.deps);
    return f;
}

test('preparation pads tokenizer input, preserves request credentials, and stores metadata only', async () => {
    const f = preparationFixture(), before = structuredClone(f.body), ticket = await f.prepare();
    assert.equal(ticket.estimatedInputTokens, 3198); assert.equal(ticket.maxOutputTokens, 100); assert.equal(ticket.reservedUsd, .004398);
    assert.deepEqual(f.calls.map(call => call.path), ['/api/backends/chat-completions/status', '/api/tokenizers/openai/count?model=gpt-4o']);
    assert.deepEqual(f.calls[0].body, { chat_completion_source: 'openrouter', secret_id: 'PRIVATE_SECRET_ID' });
    assert.deepEqual(f.calls[1].body, before.messages);
    assert.ok(f.calls.every(call => call.options.headers === f.deps.headers && call.options.signal === f.controller.signal));
    assert.deepEqual(f.body, before);
    assert.doesNotMatch(JSON.stringify({ ledger: f.ledger, ticket, summary: spendSummary(f.ledger) }), /PRIVATE|secret_id|messages|cached_prompt/);
    assert.deepEqual(ticket.rates, { prompt: .000001, completion: .000002, request: .001 });
});

test('pricing cache retains numeric rate copies and does not skip per-request token estimates', async () => {
    const f = preparationFixture(), catalogBefore = structuredClone(f.catalog);
    const first = await f.prepare(); assert.deepEqual(f.catalog, catalogBefore);
    f.catalog.data[0].pricing.prompt = '9'; f.tokenCount = 2000;
    const second = await f.prepare();
    assert.equal(f.calls.filter(call => call.path.endsWith('/status')).length, 1);
    assert.equal(f.calls.filter(call => call.path.includes('/count?')).length, 2);
    assert.equal(second.rates.prompt, first.rates.prompt); assert.equal(second.estimatedInputTokens, 4348);
    assert.ok(second.reservedUsd > first.reservedUsd);
});

test('Llama-family metadata uses the existing llama3 tokenizer endpoint', async () => {
    const f = preparationFixture({ model: 'test/llama-family' }); await f.prepare();
    assert.equal(f.calls[1].path, '/api/tokenizers/openai/count?model=llama3');
});

test('parallel preparations share atomic holds after asynchronous metadata checks', async () => {
    const f = preparationFixture({ limit: .006 });
    const results = await Promise.allSettled([f.prepare(), f.prepare()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.name, 'SpendLimitError');
    assert.equal(f.ledger.entries.length, 1); assert.equal(spendSummary(f.ledger).reservedUsd, .004398);
});

test('unavailable or invalid pricing stops before tokenizer or generation without mutating the ledger', async () => {
    for (const catalog of [{}, { data: [] }, { data: [{ id: 'test/writer' }] },
        { data: [{ id: 'test/writer', pricing: { prompt: '', completion: 0 } }] }]) {
        const f = preparationFixture(); f.catalog = catalog;
        await assert.rejects(f.prepare(), namedError('BudgetMetadataError'));
        assert.equal(f.calls.length, 1); assert.equal(f.ledger.entries.length, 0);
    }
});

test('malformed tokenizer counts cannot authorize a request or treat unknown input as zero', async () => {
    for (const tokenCount of [undefined, null, '1000', -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
        const f = preparationFixture(); f.tokenCount = tokenCount;
        await assert.rejects(f.prepare(), namedError('BudgetMetadataError'));
        assert.equal(f.ledger.entries.length, 0); assert.equal(f.calls.length, 2);
    }
});

for (const mode of ['abort', 'source change']) {
    for (const phase of ['before', 'catalog fetch', 'catalog JSON', 'tokenizer fetch', 'tokenizer JSON']) {
        test(`${mode} during ${phase} leaves no reservation or later metadata request`, async () => {
            const f = preparationFixture();
            const invalidate = () => mode === 'abort' ? f.controller.abort() : (f.current = false);
            if (phase === 'before') invalidate();
            f.deps.fetcher = async (path, options) => {
                f.calls.push({ path, options });
                const kind = path.endsWith('/status') ? 'catalog' : 'tokenizer';
                if (phase === `${kind} fetch`) invalidate();
                return { ok: true, status: 200, json: async () => {
                    if (phase === `${kind} JSON`) invalidate();
                    return kind === 'catalog' ? f.catalog : { token_count: 1000 };
                } };
            };
            await assert.rejects(f.prepare(), { name: mode === 'abort' ? 'AbortError' : 'StaleBudgetError' });
            assert.equal(f.ledger.entries.length, 0);
            assert.equal(f.calls.length, phase === 'before' ? 0 : phase.startsWith('catalog') ? 1 : 2);
        });
    }
}

test('throwing source guards preserve their own failure and stop before metadata access', async () => {
    const f = preparationFixture(); f.deps.assertCurrent = () => { throw new Error('Synthetic source change'); };
    await assert.rejects(f.prepare(), /Synthetic source change/); assert.equal(f.calls.length, 0);
});

test('metadata network and parse failures use fixed diagnostics without raw service output', async () => {
    for (const fetcher of [async () => { throw new Error('PRIVATE_NETWORK_DETAIL'); },
        async () => ({ ok: true, json: async () => { throw new SyntaxError('PRIVATE_INVALID_JSON'); } }),
        async () => ({ ok: false, json: async () => ({ error: { message: 'PRIVATE_PROVIDER_DETAIL' } }) })]) {
        const f = preparationFixture(); f.deps.fetcher = fetcher;
        await assert.rejects(f.prepare(), namedError('BudgetMetadataError')); assert.equal(f.ledger.entries.length, 0);
    }
});

test('invalid generation metadata blocks before any catalog or tokenizer request', async () => {
    for (const override of [{ model: 'PRIVATE invalid' }, { max_tokens: 0 }, { max_tokens: '100' },
        { messages: [] }, { chat_completion_source: 'other-provider' }]) {
        const f = preparationFixture(); Object.assign(f.body, override);
        await assert.rejects(f.prepare(), namedError('BudgetMetadataError')); assert.equal(f.calls.length, 0);
    }
});
