/** Manual follow-up editing. No chat reads, DOM, automatic requests, or application of revisions. */
import { fingerprint } from './review-core.js';
import { safeSettings } from './review-service.js';
import { createManuscriptSnapshot, reviewManuscript, reviseManuscript } from './workflow-review.js';
import { WRITING_ASPECTS, WRITING_PRESETS, normalizePresetLibrary, normalizeWritingStyles, buildWritingGuidance } from '../StoryBuilder/writing-tuning.js';
import { createSpendLedger, prepareReservation, settleRequest, failRequest, cancelReservation, spendSummary } from '../StoryBuilder/spend-budget.js';

const MODEL = /^[A-Za-z0-9_.:/-]{1,120}$/;
const FOCUSES = ['general', 'continuity', 'prose', ...WRITING_ASPECTS.map(item => item.id)];
const sessions = new WeakMap();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const clone = value => structuredClone(value);

function model(value, optional = false) {
    if (typeof value !== 'string' || (!value.trim() && !optional) || value.trim() && !MODEL.test(value.trim())) throw new Error('Enter a valid OpenRouter follow-up model ID, or leave the override blank.');
    return value.trim();
}

/** Persist only result.preferences under StoryReview.followUp, never the resolved context. */
export function resolveFollowUpSettings(reviewSettings = {}, builderSettings = {}) {
    if (!record(reviewSettings) || !record(builderSettings) || (reviewSettings.followUp !== undefined && !record(reviewSettings.followUp))) throw new Error('The follow-up editing preferences are invalid.');
    const input = reviewSettings.followUp || {}, focus = input.focus ?? 'general';
    if (!FOCUSES.includes(focus)) throw new Error('Choose an available follow-up review focus.');
    const useBuilderStyles = input.useBuilderStyles ?? true;
    if (typeof useBuilderStyles !== 'boolean') throw new Error('The inherited writing style preference must be on or off.');
    const preset = input.preset ?? 'builder', custom = input.custom ?? '';
    if (typeof preset !== 'string' || typeof custom !== 'string' || custom.length > 8000) throw new Error('Choose a valid follow-up preset and custom instructions of up to 8,000 characters.');
    const reviewModel = model(input.reviewModel ?? '', true), revisionModel = model(input.revisionModel ?? '', true);
    const limit = input.spendLimitUsd ?? 1;
    if (!['number', 'string'].includes(typeof limit) || String(limit).trim() === '' || !nonnegative(Number(limit)) || Number(limit) > 1000) throw new Error('Choose a follow-up spending limit from $0 to $1,000.');
    const preferences = { focus, reviewModel, revisionModel, useBuilderStyles, preset, custom, spendLimitUsd: Number(limit) };
    const base = safeSettings(reviewSettings), aspect = WRITING_ASPECTS.find(item => item.id === focus);
    const library = normalizePresetLibrary(builderSettings.writingPresetLibrary);
    const styles = normalizeWritingStyles(builderSettings.writingStyles, library);
    const inherited = useBuilderStyles && builderSettings.tuningEnabled === true;
    const selected = Object.fromEntries(WRITING_ASPECTS.map(({ id }) => [id, inherited ? { ...styles[id] } : { preset: 'inherit', custom: '', model: '' }]));
    if (aspect) {
        if (preset !== 'builder') {
            if (!['custom', ...WRITING_PRESETS[focus].map(item => item.id), ...library[focus].map(item => item.id)].includes(preset)) throw new Error('Choose an available preset for this follow-up focus.');
            selected[focus] = { ...selected[focus], preset, custom };
        }
    } else if (!['builder', 'inherit', 'custom', ...Object.values(WRITING_PRESETS).flat().map(item => item.id), ...Object.values(library).flat().map(item => item.id)].includes(preset)) {
        throw new Error('Choose an available follow-up preset.');
    }
    const inheritedModel = aspect && inherited ? styles[focus].model : '';
    const effectiveReviewModel = model(reviewModel || inheritedModel || builderSettings.reviewerModel || base.model);
    const effectiveRevisionModel = model(revisionModel || inheritedModel || builderSettings.revisionModel || builderSettings.reviewerModel || base.model);
    const writingGuidance = buildWritingGuidance({ tuningEnabled: true, writingStyles: selected, writingPresetLibrary: library });
    const instruction = aspect ? selected[focus].preset === 'custom' ? selected[focus].custom
        : WRITING_PRESETS[focus].find(item => item.id === selected[focus].preset)?.instruction
            ?? library[focus].find(item => item.id === selected[focus].preset)?.text ?? '' : '';
    const focusInstruction = instruction.trim() ? instruction : aspect
        ? `Review ${aspect.label.toLowerCase()} against the author's brief and established story, preserving intended events and voice.` : '';
    const shared = { ...base, strictParagraphs: typeof builderSettings.strictParagraphs === 'boolean'
        ? builderSettings.strictParagraphs : reviewSettings.strictParagraphs !== false, writingGuidance };
    const forModel = effective => ({ ...shared, model: effective, revisionModel: effective,
        specialists: aspect ? [{ id: focus, label: aspect.label, instruction: focusInstruction, model: effective }] : [] });
    return freeze({ preferences, effectiveReviewModel, effectiveRevisionModel,
        reviewSettings: forModel(effectiveReviewModel),
        revisionSettings: { ...forModel(effectiveRevisionModel), ...(aspect ? { specialistFocus: focus } : {}) } });
}

function resolvedCopy(options) {
    if (!record(options?.preferences) || !FOCUSES.includes(options.preferences.focus)
        || !nonnegative(options.preferences.spendLimitUsd) || options.preferences.spendLimitUsd > 1000
        || !record(options.reviewSettings) || !record(options.revisionSettings)) throw new Error('Resolve the follow-up preferences before starting an editing session.');
    model(options.effectiveReviewModel); model(options.effectiveRevisionModel);
    return freeze(clone(options));
}

function sourceStamp(snapshot) { return fingerprint(JSON.stringify([snapshot.source, snapshot.brief, snapshot.history])); }
function capture(snapshot, settings) {
    if (!snapshot || typeof snapshot.source !== 'string' || typeof snapshot.brief !== 'string'
        || !Array.isArray(snapshot.history) || snapshot.history.some(item => !item || !['system', 'user', 'assistant'].includes(item.role) || typeof item.content !== 'string')) {
        throw new Error('Select a complete text draft and its earlier conversation before follow-up editing.');
    }
    // Standalone history excludes the latest author brief. Keep every supplied
    // history row and append that exact brief; do not invent compiled lore/preset context.
    const messages = [...clone(snapshot.history), { role: 'user', content: snapshot.brief }];
    return createManuscriptSnapshot(snapshot.source, { messages, latestBrief: snapshot.brief, requestTemplate: snapshot.requestTemplate }, settings);
}
function stateFor(session) {
    const state = sessions.get(session);
    if (!state) throw new Error('Select a draft to start a follow-up editing session.');
    return state;
}
function idle(state) { if (state.busy) throw new Error('Wait for or cancel the current follow-up request before changing this editing session.'); }

export function createFollowUpSession(snapshot, options) {
    const resolved = resolvedCopy(options), manuscript = capture(snapshot, resolved.reviewSettings);
    const state = { snapshot, stamp: sourceStamp(snapshot), manuscript, resolved, revision: 0, busy: false,
        ledger: resolved.preferences.spendLimitUsd > 0 ? createSpendLedger(resolved.preferences.spendLimitUsd) : null, uncapped: [] };
    const session = Object.freeze({
        get snapshot() { return state.snapshot; }, get revision() { return state.revision; },
        get preferences() { return state.resolved.preferences; },
        get effectiveReviewModel() { return state.resolved.effectiveReviewModel; },
        get effectiveRevisionModel() { return state.resolved.effectiveRevisionModel; },
    });
    sessions.set(session, state); return session;
}

export function updateSessionOptions(session, options) {
    const state = stateFor(session); idle(state);
    const resolved = resolvedCopy(options);
    if (resolved.preferences.spendLimitUsd !== state.resolved.preferences.spendLimitUsd) throw new Error('This follow-up session’s spending limit is fixed. Start a new editing session to change its allowance.');
    const manuscript = capture(state.snapshot, resolved.reviewSettings);
    state.resolved = resolved; state.manuscript = manuscript; state.revision++;
    return session;
}

export function advanceSession(session, snapshot) {
    const state = stateFor(session); idle(state);
    const manuscript = capture(snapshot, state.resolved.reviewSettings);
    state.snapshot = snapshot; state.stamp = sourceStamp(snapshot); state.manuscript = manuscript; state.revision++;
    return session;
}

function assertLocal(state, revision, signal) {
    if (signal?.aborted) throw new DOMException('The follow-up request was cancelled.', 'AbortError');
    const snapshot = state.snapshot;
    if (state.revision !== revision || sourceStamp(snapshot) !== state.stamp
        || snapshot.message && (snapshot.message.mes !== snapshot.source || snapshot.message.swipe_id !== snapshot.swipeId)
        || snapshot.sourceHistory?.some(([message, text, swipeId, system]) => message.mes !== text || message.swipe_id !== swipeId || message.is_system !== system)) {
        const error = new Error('The selected draft or its source changed. Select the current version before editing.');
        error.name = 'StaleFollowUpError'; throw error;
    }
}
async function guard(state, revision, transport) {
    assertLocal(state, revision, transport.signal);
    if (transport.assertCurrent && await transport.assertCurrent(state.snapshot) === false) {
        const error = new Error('The selected draft or its source changed. Select the current version before editing.');
        error.name = 'StaleFollowUpError'; throw error;
    }
    assertLocal(state, revision, transport.signal);
}
export async function assertFollowUpCurrent(session, transport = {}) {
    const state = stateFor(session); await guard(state, state.revision, transport); return true;
}

export function followUpSpend(session) {
    const state = stateFor(session);
    if (state.ledger) return spendSummary(state.ledger);
    const reported = state.uncapped.filter(item => item.state === 'reported');
    const reportedUsd = reported.reduce((sum, item) => sum + item.cost, 0);
    return { limitUsd: 0, reportedUsd, estimatedUsd: 0, unknownUsd: 0, reservedUsd: 0,
        remainingUsd: 0, accountedUsd: reportedUsd, overLimit: false, reportedRequests: reported.length,
        unreportedRequests: state.uncapped.filter(item => item.state === 'unknown').length,
        pendingRequests: state.uncapped.filter(item => item.state === 'pending').length };
}
function spendingChanged(session, transport) {
    try { Promise.resolve(transport.onSpend?.(followUpSpend(session))).catch(() => {}); } catch { /* Observers cannot authorize or discard charges. */ }
}

function meteredTransport(session, state, revision, transport) {
    const fetcher = transport.fetcher || fetch;
    return { ...transport, assertCurrent: () => guard(state, revision, transport),
        fetcher: async (url, options) => {
            if (url !== '/api/backends/chat-completions/generate') return fetcher(url, options);
            let ticket, dispatched = false, uncapped;
            const failed = () => {
                if (ticket) dispatched ? failRequest(state.ledger, ticket) : cancelReservation(state.ledger, ticket);
                if (uncapped?.state === 'pending') uncapped.state = 'unknown';
                spendingChanged(session, transport);
            };
            try {
                await guard(state, revision, transport);
                if (state.ledger) {
                    let body;
                    try { body = JSON.parse(options.body); } catch { throw new Error('The follow-up request could not be prepared safely.'); }
                    ticket = await prepareReservation(state.ledger, body, { fetcher, headers: options.headers,
                        signal: transport.signal, assertCurrent: () => guard(state, revision, transport) });
                    spendingChanged(session, transport);
                }
                transport.signal?.addEventListener('abort', failed, { once: true });
                await guard(state, revision, transport);
                assertLocal(state, revision, transport.signal);
                dispatched = true;
                if (!state.ledger) { uncapped = { state: 'pending' }; state.uncapped.push(uncapped); }
                const response = await fetcher(url, options);
                // Account for paid responses before the review service rejects
                // a stale source, refusal, malformed report, or truncated output.
                let data;
                try { data = await response.json(); }
                catch (error) {
                    if (error?.name === 'AbortError') throw error;
                    throw new Error('The model service did not return a readable response. No revision was applied.');
                }
                if (ticket) settleRequest(state.ledger, ticket, data?.usage);
                if (uncapped) {
                    if (nonnegative(data?.usage?.cost)) { uncapped.state = 'reported'; uncapped.cost = data.usage.cost; }
                    else uncapped.state = 'unknown';
                }
                spendingChanged(session, transport);
                response.json = async () => data;
                return response;
            } catch (error) { failed(); throw error; }
            finally { transport.signal?.removeEventListener('abort', failed); }
        } };
}

async function operation(session, transport, action) {
    const state = stateFor(session); idle(state);
    const revision = state.revision; state.busy = true;
    try {
        await guard(state, revision, transport);
        const result = await action(state.manuscript, state.resolved, meteredTransport(session, state, revision, transport));
        await guard(state, revision, transport);
        return result;
    } finally { state.busy = false; }
}

export async function reviewFollowUp(session, transport = {}) {
    return operation(session, transport, (snapshot, resolved, metered) =>
        reviewManuscript(snapshot, resolved.preferences.focus, resolved.reviewSettings, metered));
}

export async function reviseFollowUp(session, ids, instruction, transport = {}) {
    return operation(session, transport, async (snapshot, resolved, metered) => ({
        ...await reviseManuscript(snapshot, ids, instruction, resolved.revisionSettings, metered),
        model: resolved.effectiveRevisionModel, sessionRevision: session.revision,
    }));
}
