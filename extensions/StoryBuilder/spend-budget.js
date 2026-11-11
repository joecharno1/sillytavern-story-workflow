// An estimate-based spending stop, not a guarantee about provider billing.
// Only numeric pricing/usage metadata is retained; source text and credentials
// are used for the existing metadata endpoints and are never stored here.
const pricingCache = new WeakMap();
const MODEL = /^[a-zA-Z0-9_.:/-]{1,120}$/;
const STATES = new Set(['reserved', 'reported', 'estimated', 'unknown', 'released']);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokens = value => Number.isSafeInteger(value) && value >= 0;
const tidy = value => Number(value.toPrecision(15));

function metadataError(message) {
    const error = new Error(message);
    error.name = 'BudgetMetadataError';
    return error;
}
function validLedger(ledger) {
    if (!ledger || ledger.version !== 1 || typeof ledger.id !== 'string' || !finite(ledger.limitUsd)
        || !Number.isSafeInteger(ledger.nextId) || ledger.nextId < 1 || !Array.isArray(ledger.entries)
        || ledger.entries.some(entry => !entry || typeof entry.id !== 'string' || !STATES.has(entry.state)
            || !finite(entry.reservedUsd) || (['reported', 'estimated'].includes(entry.state) && !finite(entry.amountUsd)))) {
        throw metadataError('The saved spending ledger is invalid. No new request was authorized.');
    }
}
function rate(value) {
    if (typeof value === 'string') {
        const text = value.trim();
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
            throw metadataError('The model has missing or invalid pricing. No request was authorized.');
        }
        value = Number(text);
    }
    if (!finite(value)) throw metadataError('The model has missing or invalid pricing. No request was authorized.');
    return value;
}
function readPricing(pricing) {
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
        throw metadataError('The model has missing or invalid pricing. No request was authorized.');
    }
    return { prompt: rate(pricing.prompt), completion: rate(pricing.completion),
        request: pricing.request === undefined ? 0 : rate(pricing.request) };
}
function price(input, output, rates) {
    const value = input * rates.prompt + output * rates.completion + rates.request;
    if (!finite(value)) throw metadataError('The request cost could not be estimated safely. No request was authorized.');
    return tidy(value);
}

export function createSpendLedger(limitUsd) {
    if (!finite(limitUsd)) throw metadataError('Choose a valid nonnegative spending limit.');
    return { version: 1, id: globalThis.crypto.randomUUID(), limitUsd, nextId: 1, entries: [] };
}

export function spendSummary(ledger) {
    validLedger(ledger);
    const sum = state => tidy(ledger.entries.reduce((total, entry) => total + (entry.state === state
        ? ['reserved', 'unknown'].includes(state) ? entry.reservedUsd : entry.amountUsd : 0), 0));
    const reportedUsd = sum('reported'), estimatedUsd = sum('estimated'), unknownUsd = sum('unknown'), reservedUsd = sum('reserved');
    const accountedUsd = tidy(reportedUsd + estimatedUsd + unknownUsd + reservedUsd);
    return { limitUsd: ledger.limitUsd, reportedUsd, estimatedUsd, unknownUsd, reservedUsd,
        remainingUsd: Math.max(0, tidy(ledger.limitUsd - accountedUsd)), accountedUsd, overLimit: accountedUsd > ledger.limitUsd };
}

/** Synchronous reservation is the shared critical section for parallel calls. */
export function reserveRequest(ledger, { model, estimatedInputTokens, maxOutputTokens, pricing } = {}) {
    validLedger(ledger);
    if (typeof model !== 'string' || !MODEL.test(model) || !tokens(estimatedInputTokens)
        || !tokens(maxOutputTokens) || maxOutputTokens < 1) {
        throw metadataError('The request has invalid model or token metadata. No request was authorized.');
    }
    const rates = readPricing(pricing), reservedUsd = price(estimatedInputTokens, maxOutputTokens, rates);
    const summary = spendSummary(ledger);
    if (tidy(summary.accountedUsd + reservedUsd) > ledger.limitUsd) {
        const error = new Error(`The estimated story spending limit would be exceeded. This request reserves $${reservedUsd.toFixed(6)}; $${summary.remainingUsd.toFixed(6)} remains. Completed work is preserved.`);
        error.name = 'SpendLimitError';
        throw error;
    }
    const entry = { id: `${ledger.id}:${ledger.nextId++}`, model, estimatedInputTokens, maxOutputTokens,
        rates, reservedUsd, state: 'reserved' };
    ledger.entries.push(entry);
    // Ticket metadata is descriptive only. Later operations resolve its ID in
    // the ledger, so mutating a caller's copy cannot erase a reservation.
    return structuredClone(entry);
}

function entryFor(ledger, ticket) {
    validLedger(ledger);
    const entry = ledger.entries.find(value => value.id === ticket?.id);
    if (!entry) throw metadataError('The spending reservation could not be found.');
    return entry;
}

export function settleRequest(ledger, ticket, usage) {
    const entry = entryFor(ledger, ticket);
    if (entry.state === 'reported' || entry.state === 'estimated') return spendSummary(ledger);
    if (finite(usage?.cost)) {
        entry.amountUsd = usage.cost; entry.state = 'reported';
    } else if (tokens(usage?.prompt_tokens) && tokens(usage?.completion_tokens)) {
        entry.amountUsd = price(usage.prompt_tokens, usage.completion_tokens, readPricing(entry.rates));
        entry.state = 'estimated';
    } else entry.state = 'unknown';
    return spendSummary(ledger);
}

/** Call only after dispatch may have begun. An abort/error does not prove free usage. */
export function failRequest(ledger, ticket) {
    const entry = entryFor(ledger, ticket);
    if (entry.state === 'reserved') entry.state = 'unknown';
    return spendSummary(ledger);
}

/** Release only when the caller knows dispatch never began. Unknown/provider
 * charges cannot be cleared by a later cancellation notification.
 */
export function cancelReservation(ledger, ticket) {
    const entry = entryFor(ledger, ticket);
    if (entry.state === 'reserved') entry.state = 'released';
    return spendSummary(ledger);
}

async function guard({ signal, assertCurrent }) {
    if (signal?.aborted) throw new DOMException('The spending check was cancelled.', 'AbortError');
    if (assertCurrent && await assertCurrent() === false) {
        const error = new Error('The source changed during the spending check. No new request was authorized.');
        error.name = 'StaleBudgetError'; throw error;
    }
    if (signal?.aborted) throw new DOMException('The spending check was cancelled.', 'AbortError');
}

async function metadataPost(path, body, deps) {
    await guard(deps);
    let response;
    try {
        response = await (deps.fetcher || fetch)(path, { method: 'POST', headers: deps.headers,
            signal: deps.signal, body: JSON.stringify(body) });
    } catch (error) {
        await guard(deps);
        if (error?.name === 'AbortError') throw error;
        throw metadataError('The spending metadata service could not be reached. No request was authorized.');
    }
    await guard(deps);
    let data;
    try { data = await response.json(); }
    catch (error) {
        await guard(deps);
        if (error?.name === 'AbortError') throw error;
        throw metadataError('The spending metadata service returned an unreadable response. No request was authorized.');
    }
    await guard(deps);
    if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data) || data.error) {
        throw metadataError('The spending metadata service did not return valid data. No request was authorized.');
    }
    return data;
}

/** Checks metadata only; never dispatches a paid generation request. body has
 * already received the core's provider output-cap clamp. Secret IDs are sent
 * to the catalog endpoint only and never included in cache, ledger or ticket.
 */
export async function prepareReservation(ledger, body, deps = {}) {
    validLedger(ledger);
    await guard(deps);
    if (!body || typeof body.model !== 'string' || !MODEL.test(body.model)
        || !Array.isArray(body.messages) || !body.messages.length || !tokens(body.max_tokens) || body.max_tokens < 1
        || (body.chat_completion_source !== undefined && body.chat_completion_source !== 'openrouter')) {
        throw metadataError('The request has invalid model or token metadata. No request was authorized.');
    }
    let cache = pricingCache.get(ledger);
    if (!cache) { cache = new Map(); pricingCache.set(ledger, cache); }
    let pricing = cache.get(body.model);
    if (!pricing) {
        const catalog = await metadataPost('/api/backends/chat-completions/status', {
            chat_completion_source: 'openrouter', secret_id: body.secret_id,
        }, deps);
        await guard(deps);
        const model = Array.isArray(catalog.data) ? catalog.data.find(value => value?.id === body.model) : null;
        pricing = readPricing(model?.pricing);
        cache.set(body.model, Object.freeze(pricing));
    }
    const family = /hermes|llama/i.test(body.model) ? 'llama3' : 'gpt-4o';
    const counted = await metadataPost(`/api/tokenizers/openai/count?model=${family}`, body.messages, deps);
    await guard(deps);
    if (!tokens(counted.token_count)) throw metadataError('The tokenizer returned invalid token metadata. No request was authorized.');
    const estimatedInputTokens = Math.ceil(counted.token_count * 1.15) + 2048;
    if (!tokens(estimatedInputTokens)) throw metadataError('The tokenizer returned invalid token metadata. No request was authorized.');
    // There is no await between the final source guard and the atomic balance
    // update. Every caller, including parallel reviewers, sees existing holds.
    return reserveRequest(ledger, { model: body.model, estimatedInputTokens, maxOutputTokens: body.max_tokens, pricing });
}
