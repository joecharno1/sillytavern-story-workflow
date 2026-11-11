import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DEFAULTS, normalizeSettings } from '../../extensions/StoryBuilder/builder-core.js';
import { createChatProgress, formatSpendSummary } from '../../extensions/StoryBuilder/chat-progress.js';
import { createSpendLedger, prepareReservation, settleRequest, failRequest, cancelReservation, spendSummary } from '../../extensions/StoryBuilder/spend-budget.js';
import { createChatInterceptor } from '../../extensions/StoryBuilder/chat-interceptor.js';
import { runChatWorkflow } from '../../extensions/StoryBuilder/chat-runner.js';
import { createRegenerateAction, storyTicketCurrent } from '../../extensions/StoryBuilder/regenerate-action.js';

const sourceCode = (await fs.readFile(new URL('../../extensions/StoryBuilder/index.js', import.meta.url), 'utf8')).replace(/^import .+?;\s*$/gm, '');

class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this._text = ''; this.open = false; this.disabled = false; this.hidden = false; }
    set textContent(text) { this._text = String(text); this.children = []; }
    get textContent() { return this._text + this.children.map(n => typeof n === 'string' ? n : n.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this._text = ''; this.children = [...nodes]; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    setAttribute(name, value) { this.attributes[name] = value; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() {}
    click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn({ target: this }); }
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const GENERATE = '/api/backends/chat-completions/generate';
const paidOptions = transport => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: transport.signal,
    body: JSON.stringify({ model: 'fixture/planner', messages: [{ role: 'user', content: 'PRIVATE SYNTHETIC PROMPT' }], max_tokens: 100, secret_id: 'PRIVATE SECRET IDENTIFIER' }) });
function budgetFetcher(generate, metadata = async () => ({ token_count: 10 })) {
    return async (url, options) => {
        if (url === '/api/backends/chat-completions/status') return { ok: true, status: 200, json: async () => ({ data: [{ id: 'fixture/planner', pricing: { prompt: '0.0001', completion: '0.0001' } }] }) };
        if (url.startsWith('/api/tokenizers/openai/count?')) return { ok: true, status: 200, json: () => metadata(options) };
        assert.equal(url, GENERATE); return generate(options);
    };
}
async function activityExport(f) { f.action('download-activity').click(); return JSON.parse(await f.metrics.downloadBlob.text()); }

function fixture({ run, plan: customPlan, fetcher, settings = {}, applyReturn, editorial, track, workflow = false, automatic = false, apply: customApply, capture: customCapture } = {}) {
    if (workflow && !applyReturn) applyReturn = { index: 2, swipeId: 1, saveRequested: true, rendered: true };
    const nodes = [], body = new Node('body'), documentListeners = {};
    const document = { body, createElement(tag) { const n = new Node(tag); nodes.push(n); return n; }, createTextNode(text) { return String(text); }, getElementById(id) { return nodes.find(n => n.id === id) || null; },
        addEventListener(name, fn, capture) { (documentListeners[name] ||= []).push({ fn, capture }); },
        querySelector() { return metrics.unsavedEdit ? {} : null; } };
    for (const id of ['extensions_settings2', 'extensionsMenu']) { const n = document.createElement('div'); n.id = id; body.append(n); }
    const listeners = {}, eventSource = { on(name, fn) { (listeners[name] ||= []).push(fn); }, emit(name, ...args) { for (const fn of listeners[name] || []) fn(...args); } };
    const event_types = Object.fromEntries(['APP_READY', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_SENT', 'OAI_PRESET_CHANGED_AFTER', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CONNECTION_PROFILE_LOADED', 'CHARACTER_EDITED', 'WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'PERSONA_CHANGED', 'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED', 'GENERATION_STARTED', 'GENERATION_STOPPED'].map(x => [x, x]));
    const metrics = { capture: 0, plan: 0, run: 0, apply: 0, saved: 0, reads: 0, sourceCurrent: true, generating: false, now: 1700000000000, fetchCalls: 0 };
    const timers = new Map(); let timerSequence = 0;
    class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [metrics.now])); } static now() { return metrics.now; } }
    const extension_settings = workflow ? { StoryBuilder: { editorialEnabled: true } } : {};
    if (automatic) extension_settings.StoryBuilder = { ...extension_settings.StoryBuilder, chatWorkflowEnabled: true };
    extension_settings.StoryBuilder = { ...extension_settings.StoryBuilder, ...settings };
    const context = { chatId: 'synthetic-chat', characterId: 0, groupId: null, chat: [], getCurrentChatId: () => context.chatId,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), saveSettingsDebounced: () => metrics.saved++ };
    const globals = {};
    const source = { snapshot: { fixture: true }, latestBrief: 'Carry the sealed ledger to the harbor.', model: 'fixture/current-model', messages: [{ role: 'user', content: 'Carry the sealed ledger to the harbor.' }], requestTemplate: {}, contextLimit: 131072, responseLimit: 16384 };
    const createJob = (s, settings) => ({ id: 'fixture', source: s, settings, plan: null, sections: [], status: 'new' });
    const planJob = async (job, transport, options) => { metrics.plan++; assert.equal(typeof transport.isCurrent, 'function'); if (customPlan) return customPlan(job, transport, options); job.plan = { requiredBeats: [{ id: 'b1', briefQuote: source.latestBrief }], fixedFacts: ['The ledger remains sealed until arrival.'], finalRequirements: ['Reach the harbor.'], sections: Array.from({ length: job.settings.sectionCount }, (_, i) => ({ id: i + 1, title: `Journey ${i + 1}`, beatIds: i ? [] : ['b1'], startState: 'Continue the journey.', endState: 'Reach the next landmark.', direction: '' })) }; job.status = 'ready'; };
    const assembledStory = job => job.sections.map(s => s.text).join('\n\n');
    const totals = job => {
        const words = job.sections.reduce((n, s) => n + s.words, 0), paragraphs = job.sections.reduce((n, s) => n + s.paragraphs, 0);
        return { words, paragraphs, wordTargetMet: words >= job.settings.wordMin && words <= job.settings.wordMax, paragraphTargetMet: paragraphs >= job.settings.paragraphMin && paragraphs <= job.settings.paragraphMax, completedSections: job.sections.length, totalSections: job.settings.sectionCount };
    };
    const runJob = async (job, transport, options) => {
        metrics.run++; assert.equal(typeof transport.isCurrent, 'function'); job.status = 'running';
        if (run) return run(job, transport, options);
        job.sections = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, text: `Synthetic section ${i + 1}.`, words: 1562, paragraphs: 18 })); job.status = 'complete'; options.onProgress({ stage: 'complete', message: 'Synthetic complete.' });
    };
    const deps = { document, extension_settings, eventSource, event_types, isGenerating: () => metrics.generating, DEFAULTS, normalizeSettings, createJob, planJob, runJob, assembledStory, totals, updatePlan(job, plan) { job.plan = plan; }, captureSource: async options => { metrics.capture++; if (customCapture) await customCapture(options); return source; }, snapshotCurrent: () => { metrics.reads++; return metrics.sourceCurrent; }, applyResult: async (_snapshot, text, options) => { metrics.apply++; metrics.appliedText = text; metrics.appliedOptions = options; if (customApply) await customApply(); metrics.sourceCurrent = false; return applyReturn; }, URL: { createObjectURL(blob) { metrics.downloadBlob = blob; return 'blob:synthetic-download'; }, revokeObjectURL() {} }, setTimeout: callback => { callback(); return 0; }, SillyTavern: { getContext: () => context }, globalThis: globals,
        createChatProgress, formatSpendSummary, createSpendLedger, prepareReservation, settleRequest, failRequest, cancelReservation, spendSummary,
        createChatInterceptor: options => createChatInterceptor({ ...options, schedule: callback => setImmediate(callback) }), runChatWorkflow,
        bindChatProgressLayout: () => ({ refresh() {} }), createRegenerateAction, storyTicketCurrent };
    Object.assign(deps, {
        Date: TestDate, setInterval: callback => { const id = ++timerSequence; timers.set(id, callback); return id; }, clearInterval: id => timers.delete(id),
        fetch: async (url, options) => { metrics.fetchCalls++; if (!fetcher) throw new Error('No synthetic fetch response was configured.'); return fetcher(url, options); },
        loadReviewServices: async () => ({}),
        runEditorialWorkflow: async (job, _services, transport, options) => {
            metrics.editorial = (metrics.editorial || 0) + 1;
            if (editorial) return editorial(job, transport, options);
            job.editorial = { text: 'Revised synthetic final story.', status: 'ready', changes: [{ before: 'old', after: 'new' }], unresolved: [], reports: [], analysis: { words: 12500, paragraphs: 144 }, targetChecks: { formatValid: true } };
        },
        createAcceptedTarget: (_context, result, text) => ({ index: result?.index || 0, text, status: 'pending' }),
        refreshAcceptedTrackers: async (target, options) => { metrics.track = (metrics.track || 0) + 1; if (track) await track(target, options); else target.status = 'complete'; },
    });
    new Function(...Object.keys(deps), sourceCode)(...Object.values(deps));
    eventSource.emit('APP_READY');
    return { metrics, nodes, body, eventSource, extension_settings, context, globals, timers,
        advance(milliseconds) { metrics.now += milliseconds; for (const callback of [...timers.values()]) callback(); },
        regenerate() {
            const button = { id: 'option_regenerate' };
            const event = { target: { closest: selector => selector === '#option_regenerate' ? button : null },
                defaultPrevented: false, stopped: false,
                preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
            for (const listener of documentListeners.click || []) { assert.equal(listener.capture, true); listener.fn(event); if (event.stopped) break; }
            if (!event.stopped) metrics.nativeRegenerate = (metrics.nativeRegenerate || 0) + 1;
            return event;
        },
        send(text = 'A synthetic new story prompt.') {
            metrics.sourceCurrent = true; metrics.generating = true;
            eventSource.emit('GENERATION_STARTED', 'normal', {}, false);
            context.chat.push({ is_user: true, mes: text }); eventSource.emit('MESSAGE_SENT', context.chat.length - 1);
            globals.StoryBuilder_Intercept([], 128000, value => { metrics.nativeAbort = value; metrics.nativeAbortCount = (metrics.nativeAbortCount || 0) + 1; }, 'normal');
            metrics.generating = false;
        },
        action: name => nodes.find(n => n.className === `story-builder-progress-${name}`),
        byText: text => nodes.find(n => n.tagName === 'button' && n.textContent === text), status: () => nodes.find(n => n.className === 'sb-status').textContent, preview: () => nodes.find(n => n.className === 'sb-preview'), dialog: () => nodes.find(n => n.id === 'story-builder-dialog') };
}

test('budget denial makes zero generation calls and resumes with the same ledger and limit', async () => {
    let paid = 0, captured, firstLedger;
    const f = fixture({ settings: { spendLimitUsd: 0.01 }, fetcher: budgetFetcher(async () => { paid++; throw new Error('Unexpected paid request'); }),
        plan: async (job, transport) => { captured = job; firstLedger ||= job.spend; try { await transport.fetcher(GENERATE, paidOptions(transport)); } catch (error) { job.status = 'failed'; throw error; } } });
    f.byText('Prepare outline from current prompt').click(); await settle();
    assert.equal(paid, 0); assert.equal(captured.spend.entries.length, 0);
    assert.match(f.status(), /spending limit/); assert.match(f.body.textContent, /Remaining \$0\.0100/);
    let saved = await activityExport(f);
    assert.equal(saved.entries.filter(entry => entry.type === 'request').length, 0);
    assert.equal(saved.entries.filter(entry => entry.type === 'blocked').length, 1);
    f.extension_settings.StoryBuilder.spendLimitUsd = 100;
    f.action('resume').click(); await settle();
    assert.equal(paid, 0); assert.equal(captured.spend, firstLedger); assert.equal(captured.spend.limitUsd, 0.01);
    saved = await activityExport(f); assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|secret_id|messages|headers/);
    assert.equal(f.timers.size, 0);
});

test('parallel requests reserve the shared balance atomically and retain the funded response', async () => {
    let paid = 0, release, captured, outcomes;
    const pending = new Promise(resolve => { release = resolve; });
    const payload = { choices: [{ message: { content: 'PRIVATE OUTPUT' }, finish_reason: 'stop' }], usage: { cost: 0.03, prompt_tokens: 10, completion_tokens: 5 } };
    const f = fixture({ settings: { spendLimitUsd: 0.3 }, fetcher: budgetFetcher(async () => { paid++; await pending; return { ok: true, status: 200, json: async () => payload }; }),
        plan: async (job, transport) => { captured = job; outcomes = await Promise.allSettled([transport.fetcher(GENERATE, paidOptions(transport)), transport.fetcher(GENERATE, paidOptions(transport))]); job.status = 'failed'; throw outcomes.find(result => result.status === 'rejected').reason; } });
    f.byText('Prepare outline from current prompt').click(); await settle();
    assert.equal(paid, 1); assert.equal(captured.spend.entries.length, 1); assert.equal(spendSummary(captured.spend).reservedUsd, 0.216);
    release(); await settle();
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(await outcomes.find(result => result.status === 'fulfilled').value.json(), payload);
    assert.equal(spendSummary(captured.spend).reportedUsd, 0.03); assert.equal(spendSummary(captured.spend).reservedUsd, 0);
    const saved = await activityExport(f), request = saved.entries.find(entry => entry.type === 'request');
    assert.equal(request.maxOutputTokens, 100); assert.equal(request.reservedCostUsd, 0.216); assert.equal(request.costUsd, 0.03);
    assert.equal(saved.entries.filter(entry => entry.type === 'blocked').length, 1); assert.equal(f.timers.size, 0);
});

test('cancellation after dispatch retains unknown spend and Resume cannot reset it', async () => {
    let paid = 0, captured, savedLedger;
    const f = fixture({ settings: { spendLimitUsd: 0.3 }, fetcher: budgetFetcher(async options => { paid++; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })); }),
        plan: async (job, transport) => { captured = job; savedLedger ||= job.spend; try { await transport.fetcher(GENERATE, paidOptions(transport)); } catch (error) { job.status = 'paused'; throw error; } } });
    f.byText('Prepare outline from current prompt').click(); await settle(); assert.equal(paid, 1);
    f.action('pause').click(); await settle();
    assert.equal(spendSummary(captured.spend).unknownUsd, 0.216); assert.equal(spendSummary(captured.spend).reservedUsd, 0);
    assert.match(f.nodes.find(node => node.className === 'story-builder-progress-budget').textContent, /Unknown-charge allowance \$0\.2160/);
    f.action('resume').click(); await settle(); assert.equal(paid, 1); assert.equal(captured.spend, savedLedger);
    assert.equal(spendSummary(captured.spend).unknownUsd, 0.216); assert.equal(f.timers.size, 0);
});

test('a smaller parallel review may finish after its larger peer is blocked', async () => {
    let paid = 0, captured, outcomes;
    const f = fixture({ settings: { spendLimitUsd: 0.3 }, fetcher: budgetFetcher(async options => {
        paid++; assert.equal(JSON.parse(options.body).max_tokens, 100);
        return { ok: true, status: 200, json: async () => ({ usage: { cost: 0.03 } }) };
    }), plan: async (job, transport) => {
        captured = job; const smaller = paidOptions(transport), larger = { ...smaller, body: JSON.stringify({ ...JSON.parse(smaller.body), max_tokens: 1000 }) };
        outcomes = await Promise.allSettled([transport.fetcher(GENERATE, larger), transport.fetcher(GENERATE, smaller)]);
        job.status = 'failed'; throw outcomes[0].reason;
    } });
    f.byText('Prepare outline from current prompt').click(); await settle();
    assert.deepEqual(outcomes.map(result => result.status), ['rejected', 'fulfilled']);
    assert.equal(paid, 1); assert.equal(spendSummary(captured.spend).reportedUsd, 0.03);
    assert.equal(captured.spend.entries.length, 1); assert.equal(f.timers.size, 0);
});

test('cancelled or stale preflight makes no paid request and holds no money', async () => {
    for (const stop of ['cancelled', 'stale']) {
        let release, paid = 0, captured;
        const waiting = new Promise(resolve => { release = resolve; });
        const f = fixture({ settings: { spendLimitUsd: 0.3 }, fetcher: budgetFetcher(async () => { paid++; }, async () => { await waiting; return { token_count: 10 }; }),
            plan: async (job, transport) => { captured = job; try { await transport.fetcher(GENERATE, paidOptions(transport)); } catch (error) { job.status = 'paused'; throw error; } } });
        f.byText('Prepare outline from current prompt').click(); await settle();
        if (stop === 'cancelled') f.action('pause').click(); else f.metrics.sourceCurrent = false;
        release(); await settle();
        assert.equal(paid, 0); assert.equal(captured.spend.entries.length, 0); assert.equal(spendSummary(captured.spend).accountedUsd, 0);
        assert.equal(f.timers.size, 0);
    }
});

test('late usage reconciles a cancelled hold once before caller rejects stale source', async () => {
    let release, captured, reads = 0;
    const waiting = new Promise(resolve => { release = resolve; });
    const f = fixture({ settings: { spendLimitUsd: 0.3 }, fetcher: budgetFetcher(async () => ({ ok: true, status: 200,
        json: async () => { reads++; await waiting; return { usage: { cost: 0.07, prompt_tokens: 10, completion_tokens: 5 } }; } })),
        plan: async (job, transport) => { captured = job; const response = await transport.fetcher(GENERATE, paidOptions(transport)); await response.json(); await response.json(); job.status = 'paused'; throw new Error('The source changed before acceptance.'); } });
    f.byText('Prepare outline from current prompt').click(); await settle();
    f.action('pause').click(); assert.equal(spendSummary(captured.spend).unknownUsd, 0.216);
    f.metrics.sourceCurrent = false; release(); await settle();
    assert.equal(reads, 1); assert.equal(spendSummary(captured.spend).reportedUsd, 0.07); assert.equal(spendSummary(captured.spend).unknownUsd, 0);
    const saved = await activityExport(f), request = saved.entries.find(entry => entry.type === 'request');
    assert.equal(request.status, 'cancelled'); assert.equal(request.costUsd, 0.07); assert.equal(f.timers.size, 0);
});

test('uncapped activity includes numeric zero cost, reasoning and cache counts without retaining private fields', async () => {
    let paid = 0;
    const f = fixture({ fetcher: async url => { assert.equal(url, GENERATE); paid++; return { ok: true, status: 200, json: async () => ({ usage: paid === 1
        ? { cost: 0, prompt_tokens: 100, completion_tokens: 15, completion_tokens_details: { reasoning_tokens: 10, private: 'PRIVATE DETAIL' }, prompt_tokens_details: { cached_tokens: 90 } }
        : { cost: 'PRIVATE COST', completion_tokens_details: { reasoning_tokens: 'PRIVATE REASONING' }, prompt_tokens_details: { cached_tokens: -1 } } }) }; },
        plan: async (job, transport) => { for (let i = 0; i < 2; i++) await transport.fetcher(GENERATE, paidOptions(transport)); job.status = 'failed'; throw new Error('Synthetic stop'); } });
    f.byText('Prepare outline from current prompt').click(); await settle();
    assert.equal(paid, 2); const saved = await activityExport(f), requests = saved.entries.filter(entry => entry.type === 'request');
    assert.equal(requests[0].costUsd, 0); assert.equal(requests[0].reasoningTokens, 10); assert.equal(requests[0].cachedInputTokens, 90);
    for (const key of ['costUsd', 'reasoningTokens', 'cachedInputTokens']) assert.equal(requests[1][key], undefined);
    assert.equal(saved.spend.reportedRequests, 1); assert.equal(saved.spend.unreportedRequests, 1);
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|secret_id|messages|headers/);
    assert.match(f.nodes.find(node => node.className === 'story-builder-progress-activity-list').textContent, /Reported cost \$0\.0000/);
});

test('positive spending cap blocks tracker dispatch and passes the chosen revision passage limit', async () => {
    const f = fixture({ workflow: true, automatic: true, settings: { spendLimitUsd: 0.3, maxRevisionPassages: 2, updateTracker: true },
        run: async job => { job.settings.updateTracker = true; job.sections = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, text: 'Synthetic prose.', words: 1562, paragraphs: 18 })); job.status = 'complete'; },
        editorial: async (job, _transport, options) => { assert.equal(options.maxGroupsPerCycle, 2); job.editorial = { text: 'Final synthetic prose.', status: 'ready', changes: [], unresolved: [], reports: [], analysis: { words: 12500, paragraphs: 144 }, targetChecks: { formatValid: true } }; } });
    const limit = f.nodes.find(node => node.tagName === 'input' && node.max === '1000');
    assert.equal(limit.value, 0.3); assert.equal(limit.step, '0.01'); assert.equal(limit.min, '0');
    f.send(); await settle(); assert.equal(f.metrics.apply, 1); assert.equal(f.metrics.track || 0, 0);
    f.byText('Update continuity').click(); await settle(); assert.equal(f.metrics.track || 0, 0);
    assert.match(f.status(), /spending limit/);
});

test('mount and opening the panel never load a chat or make model calls', () => {
    const f = fixture();
    assert.equal(f.metrics.capture, 0); assert.equal(f.metrics.plan, 0); assert.equal(f.metrics.run, 0); assert.equal(f.metrics.reads, 0);
    f.byText('Open Story Builder').click();
    assert.equal(f.dialog().open, true); assert.equal(f.metrics.capture, 0); assert.equal(f.metrics.reads, 0);
});

test('planning activity ticks at zero sections, records only metadata, and separates response receipt from outline acceptance', async () => {
    let releaseResponse, releaseValidation, sentOptions;
    const responseReady = new Promise(resolve => { releaseResponse = resolve; });
    const validationReady = new Promise(resolve => { releaseValidation = resolve; });
    const payload = { choices: [{ message: { content: 'PRIVATE OUTPUT <script>secret</script>', reasoning: 'PRIVATE REASONING' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1234, completion_tokens: 45, total_tokens: 1279 } };
    const requestOptions = { method: 'POST', headers: { Authorization: 'PRIVATE HEADER' }, body: JSON.stringify({ model: 'fixture/planner', messages: [{ role: 'user', content: 'PRIVATE PROMPT' }] }) };
    const f = fixture({ fetcher: async (url, options) => { assert.equal(url, '/api/backends/chat-completions/generate'); sentOptions = options; await responseReady; return { ok: true, status: 200, json: async () => payload }; },
        plan: async (job, transport, options) => {
            const response = await transport.fetcher('/api/backends/chat-completions/generate', requestOptions);
            assert.equal(await response.json(), payload); await validationReady;
            job.plan = { requiredBeats: [{ id: 'b1', requirement: 'Deliver the ledger.', briefQuote: job.source.latestBrief }], fixedFacts: [], finalRequirements: [], sections: [] }; job.status = 'ready';
            options.onProgress({ stage: 'planning_ready', message: 'Outline accepted.' });
        } });
    f.byText('Prepare outline from current prompt').click(); await settle();
    assert.equal(sentOptions, requestOptions, 'the original request options and JSON body are unchanged');
    assert.equal(f.action('download').disabled, true); assert.equal(f.timers.size, 1);
    f.advance(65000);
    const waiting = f.nodes.find(n => n.className === 'story-builder-progress-waiting');
    assert.match(waiting.textContent, /1:05 elapsed/);
    f.action('download-activity').click(); let log = await f.metrics.downloadBlob.text();
    assert.doesNotMatch(log, /PRIVATE|messages|Authorization|reasoning/);
    releaseResponse(); await settle();
    assert.equal(f.timers.size, 0); assert.equal(waiting.hidden, true);
    const list = f.nodes.find(n => n.className === 'story-builder-progress-activity-list');
    assert.match(list.textContent, /Response received.*HTTP 200.*input tokens/);
    assert.doesNotMatch(list.textContent, /Outline accepted/);
    for (let i = 0; i < 3; i++) f.byText('Open Story Builder').click();
    f.action('download-activity').click(); log = await f.metrics.downloadBlob.text();
    const saved = JSON.parse(log); assert.equal(saved.entries.filter(e => e.type === 'request').length, 1);
    assert.equal(saved.entries.find(e => e.type === 'request').outputCharacters, payload.choices[0].message.content.length);
    assert.doesNotMatch(log, /PRIVATE|messages|Authorization|reasoning/);
    releaseValidation(); await settle(); assert.match(list.textContent, /Outline accepted/);
    assert.equal(f.nodes.find(n => n.className === 'story-builder-progress-title').textContent, 'Story progress · v0.5.0');
    assert.ok(f.nodes.some(n => n.tagName === 'li' && n.textContent.startsWith('Deliver the ledger.')));
    assert.equal(f.context.chat.length, 0);
});

test('failed request activity survives resume once, then clears on discard and a fresh job', async () => {
    let attempt = 0;
    const f = fixture({ fetcher: async () => ({ ok: true, status: 200, json: async () => {
        if (++attempt === 1) throw new SyntaxError('PRIVATE RESPONSE');
        return { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] };
    } }), plan: async (job, transport, options) => {
        try { const r = await transport.fetcher('/api/backends/chat-completions/generate', { body: JSON.stringify({ model: 'fixture/planner' }) }); await r.json(); }
        catch (error) { job.status = 'failed'; throw error; }
        job.plan = { requiredBeats: [], fixedFacts: [], finalRequirements: [], sections: [] }; job.status = 'ready'; options.onProgress({ stage: 'planning_ready', message: 'Outline accepted.' });
    } });
    f.byText('Prepare outline from current prompt').click(); await settle();
    assert.equal(f.timers.size, 0); f.action('download-activity').click();
    let saved = JSON.parse(await f.metrics.downloadBlob.text());
    assert.equal(saved.entries.filter(e => e.type === 'request').length, 1);
    assert.equal(saved.entries.find(e => e.type === 'request').status, 'failed');
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE RESPONSE/);
    f.action('resume').click(); await settle(); f.action('download-activity').click();
    saved = JSON.parse(await f.metrics.downloadBlob.text());
    assert.equal(saved.entries.filter(e => e.type === 'request').length, 2);
    assert.deepEqual(saved.entries.filter(e => e.type === 'request').map(e => e.status), ['failed', 'received']);
    f.byText('Discard this staged job').click(); await settle();
    assert.equal(f.nodes.find(n => n.className === 'story-builder-progress-activity').hidden, true);
    assert.equal(f.timers.size, 0);
    f.metrics.sourceCurrent = true; f.byText('Prepare outline from current prompt').click(); await settle();
    f.action('download-activity').click(); saved = JSON.parse(await f.metrics.downloadBlob.text());
    assert.equal(saved.entries.filter(e => e.type === 'request').length, 1);
});

test('pausing an in-flight request immediately stops its elapsed ticker and records cancellation', async () => {
    const f = fixture({ fetcher: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('PRIVATE ABORT', 'AbortError')), { once: true })),
        plan: async (job, transport) => { try { await transport.fetcher('/api/backends/chat-completions/generate', { signal: transport.signal, body: JSON.stringify({ model: 'fixture/planner' }) }); } catch (error) { job.status = 'paused'; throw error; } } });
    f.byText('Prepare outline from current prompt').click(); await settle(); assert.equal(f.timers.size, 1);
    f.advance(3000); f.action('pause').click(); await settle(); assert.equal(f.timers.size, 0);
    f.action('download-activity').click(); const saved = JSON.parse(await f.metrics.downloadBlob.text());
    assert.equal(saved.entries.find(e => e.type === 'request').status, 'cancelled');
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE ABORT/);
});

test('a source failure after fetch still records the buffered response and closes the ticker', async () => {
    let reads = 0;
    const f = fixture({ fetcher: async () => ({ ok: true, status: 200, json: async () => { reads++; return {}; } }),
        plan: async (job, transport) => {
            await transport.fetcher('/api/backends/chat-completions/generate', { body: JSON.stringify({ model: 'fixture/planner' }) });
            job.status = 'failed'; throw new Error('The source changed before the response was consumed.');
        } });
    f.byText('Prepare outline from current prompt').click(); await settle();
    assert.equal(reads, 1); assert.equal(f.timers.size, 0);
    f.action('download-activity').click(); const saved = JSON.parse(await f.metrics.downloadBlob.text());
    const request = saved.entries.find(e => e.type === 'request');
    assert.equal(request.status, 'received'); assert.equal(request.httpStatus, 200);
    assert.equal(typeof request.elapsedMilliseconds, 'number');
    assert.equal(f.nodes.find(n => n.className === 'story-builder-progress-waiting').hidden, true);
});

test('writer and parallel editorial requests use the same metadata activity observer', async () => {
    const call = async (transport, model) => {
        const response = await transport.fetcher('/api/backends/chat-completions/generate', { body: JSON.stringify({ model, messages: [{ content: 'PRIVATE BODY' }] }) });
        await response.json();
    };
    const f = fixture({ workflow: true, automatic: true, fetcher: async () => ({ ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: 'PRIVATE OUTPUT' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) }),
        run: async (job, transport, options) => { await call(transport, 'fixture/writer');
            job.sections = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, text: 'Synthetic section.', words: 1562, paragraphs: 18 })); job.status = 'complete'; options.onProgress({ stage: 'complete', message: 'Complete.' }); },
        editorial: async (job, transport) => { await Promise.all([call(transport, 'fixture/continuity-review'), call(transport, 'fixture/prose-review')]);
            job.editorial = { text: 'Synthetic final story.', status: 'ready', changes: [], unresolved: [], reports: [], analysis: { words: 12500, paragraphs: 144 }, targetChecks: { formatValid: true } }; } });
    f.send(); await settle(); assert.equal(f.timers.size, 0);
    f.action('download-activity').click(); const text = await f.metrics.downloadBlob.text(), saved = JSON.parse(text);
    const requests = saved.entries.filter(e => e.type === 'request');
    assert.equal(requests.length, 3); assert.equal(new Set(requests.map(e => e.id)).size, 3);
    assert.deepEqual(requests.map(e => e.model), ['fixture/writer', 'fixture/continuity-review', 'fixture/prose-review']);
    assert.ok(requests.every(e => e.status === 'received')); assert.doesNotMatch(text, /PRIVATE|messages/);
});

test('activity diagnostics report explicit failures rather than possible causes in generic errors', async () => {
    for (const [message, expected, absent] of [
        ['The request failed (503). Check model availability, context space, or credit. Completed sections are preserved.', 'The provider request failed.', /insufficient credit|context limit/],
        ['The source chat, prompt, or writing settings changed. Prepare a new outline before continuing.', 'Source changed; the current work was preserved.', /Outline structure|Outline source/],
        ['The outline reached its output limit. It was not accepted.', 'The model response reached its output limit.', /Outline structure/],
    ]) {
        const f = fixture({ automatic: true, plan: async job => { job.status = 'failed'; job.error = message; throw new Error(message); } });
        f.send(); await settle();
        f.action('download-activity').click(); const saved = JSON.parse(await f.metrics.downloadBlob.text());
        const diagnostics = saved.entries.filter(entry => entry.type === 'diagnostic').map(entry => entry.label).join('\n');
        assert.equal(diagnostics, expected); assert.doesNotMatch(diagnostics, absent);
    }
});

test('normal Send automatically plans writes reviews publishes and tracks without opening dialog', async () => {
    const f = fixture({ workflow: true, automatic: true }); f.send(); await settle();
    assert.equal(f.metrics.nativeAbort, true);
    assert.equal(f.metrics.capture, 1); assert.equal(f.metrics.plan, 1); assert.equal(f.metrics.run, 1);
    assert.equal(f.metrics.editorial, 1); assert.equal(f.metrics.apply, 1); assert.equal(f.metrics.track, 1);
    assert.equal(f.metrics.appliedText, 'Revised synthetic final story.'); assert.equal(f.dialog().open, false);
    assert.equal(f.context.chat.length, 1, 'progress never becomes a prompt message');
    assert.equal(f.action('pause').hidden, true); assert.match(f.status(), /continuity are updated/);
});

test('starting-state omissions remain in View details after later stages and notes render as literal text', async () => {
    const literalNote = 'Retained note: <img src="synthetic.invalid" onerror="untrusted()"> stays literal.';
    const f = fixture({ workflow: true, automatic: true, run: async (job, _transport, options) => {
        job.continuity = {
            initialState: { summary: literalNote, facts: [{ fact: literalNote, evidence: job.source.latestBrief }], openThreads: [], unknowns: [] },
            initialStateValidation: { proposedFacts: 3, verifiedFacts: 1, omittedFacts: 2 }, acceptedFrames: [],
        };
        options.onProgress({ stage: 'starting_state_ready', message: 'Starting state prepared. Omitted 2 extracted facts.' });
        job.sections = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, text: `Synthetic section ${i + 1}.`, words: 1562, paragraphs: 18 }));
        job.status = 'complete';
        options.onProgress({ stage: 'complete', message: 'Later drafting stage complete.' });
    } });
    const continuityPreference = f.nodes.find(node => node.tagName === 'label'
        && node.textContent.includes('Prepare starting state and check continuity'));
    continuityPreference.children.find(node => node.type === 'checkbox').checked = true;
    f.send(); await settle();
    assert.match(f.status(), /continuity are updated/);
    assert.doesNotMatch(f.status(), /Omitted 2/, 'the transient progress message has been replaced');
    f.action('details').click();
    assert.equal(f.dialog().open, true);
    const details = f.nodes.find(node => node.tagName === 'details'
        && node.children[0]?.textContent === 'Starting state and section checks');
    assert.equal(details.hidden, false);
    details.open = true; for (const listener of details.listeners.toggle) listener();
    const panel = details.children[1];
    const assertWarning = () => {
        assert.match(panel.textContent, /Kept 1 starting note\(s\) with matching source quotations; omitted 2/);
        assert.match(panel.textContent, /full source remains available to every writing stage/);
        assert.match(panel.textContent, /does not by itself prove the model interpreted it correctly/);
        assert.equal(panel.children.find(node => node.tagName === 'p').textContent, literalNote);
        assert.equal(panel.textContent.split('omitted 2').length - 1, 1);
    };
    assertWarning();
    f.dialog().close(); f.action('details').click(); assertWarning();
    assert.equal(f.nodes.some(node => ['img', 'script'].includes(node.tagName) || Object.hasOwn(node, 'innerHTML')), false);
    assert.equal(f.metrics.capture, 1); assert.equal(f.metrics.run, 1);
});

test('accepted section end-state omission counts remain visible after later stages and reopening details', async () => {
    const f = fixture({ workflow: true, automatic: true, run: async (job, _transport, options) => {
        job.continuity = { initialState: null, acceptedFrames: [{ sectionId: 1,
            endState: { summary: 'The courier has left the depot.', facts: [], openThreads: [], unknowns: [] },
            endStateValidation: { proposedFacts: 9, verifiedFacts: 3, omittedFacts: 6 },
            report: { issues: [] },
        }] };
        job.sections = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, text: `Synthetic section ${i + 1}.`, words: 1562, paragraphs: 18 }));
        job.status = 'complete'; options.onProgress({ stage: 'complete', message: 'Later drafting stage complete.' });
    } });
    f.send(); await settle();
    assert.match(f.status(), /continuity are updated/);
    f.action('details').click();
    const details = f.nodes.find(node => node.tagName === 'details'
        && node.children[0]?.textContent === 'Starting state and section checks');
    details.open = true; for (const listener of details.listeners.toggle) listener();
    const assertWarning = () => {
        const section = details.children[1].children.find(node => node.tagName === 'details'
            && node.children[0]?.textContent === 'Section 1 · continuity checked');
        assert.ok(section);
        section.open = true;
        assert.match(section.textContent, /Kept 3 end-state note\(s\) with matching source quotations; omitted 6\./);
        assert.match(section.textContent, /The full source and accepted prose remain available\./);
        assert.equal(section.textContent.split('omitted 6').length - 1, 1);
    };
    assertWarning();
    f.dialog().close(); f.action('details').click(); assertWarning();
    assert.equal(f.metrics.run, 1); assert.equal(f.metrics.editorial, 1);
});

test('Regenerate after a saved prompt edit runs the full workflow without native regeneration or deleting the prior reply', async () => {
    const f = fixture({ workflow: true, automatic: true });
    const oldReply = { is_user: false, mes: 'The earlier synthetic story.', swipe_id: 0 };
    f.context.chat.push({ is_user: true, mes: 'Original synthetic brief.' }, oldReply);
    f.context.chat[0].mes = 'Edited synthetic brief.'; f.eventSource.emit('MESSAGE_EDITED');
    const event = f.regenerate();
    assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
    assert.equal(f.context.chat.at(-1), oldReply);
    await settle();
    assert.equal(f.metrics.nativeRegenerate, undefined);
    for (const stage of ['capture', 'plan', 'run', 'editorial', 'apply', 'track']) assert.equal(f.metrics[stage], 1, stage);
    assert.equal(f.context.chat.at(-1), oldReply, 'only the existing apply bridge owns replacement');
    assert.match(f.status(), /continuity are updated/);
});

test('Regenerate with an unsaved message edit shows a block without native or model calls', async () => {
    const f = fixture({ workflow: true, automatic: true });
    f.context.chat.push({ is_user: true, mes: 'Saved synthetic brief.' });
    f.metrics.unsavedEdit = true; f.regenerate(); await settle();
    assert.equal(f.metrics.nativeRegenerate, undefined); assert.equal(f.metrics.capture, 0);
    assert.match(f.status(), /edit/i);
});

test('disabled workflow leaves the Regenerate action native', async () => {
    const f = fixture({ workflow: true });
    f.context.chat.push({ is_user: true, mes: 'Saved synthetic brief.' });
    assert.equal(f.regenerate().defaultPrevented, false); await settle();
    assert.equal(f.metrics.nativeRegenerate, 1); assert.equal(f.metrics.capture, 0);
});

test('repeated Regenerate clicks start only one workflow', async () => {
    const f = fixture({ workflow: true, automatic: true });
    f.context.chat.push({ is_user: true, mes: 'Saved synthetic brief.' });
    f.regenerate(); f.regenerate(); await settle();
    assert.equal(f.metrics.capture, 1); assert.equal(f.metrics.apply, 1); assert.equal(f.metrics.nativeRegenerate, undefined);
});

test('Regenerate rejects a silently changed prior reply during capture', async () => {
    let release;
    const f = fixture({ workflow: true, automatic: true, capture: () => new Promise(resolve => { release = resolve; }) });
    f.context.chat.push({ is_user: true, mes: 'Saved synthetic brief.' }, { is_user: false, mes: 'Earlier synthetic story.' });
    f.regenerate(); await settle();
    f.context.chat.at(-1).mes = 'Externally changed synthetic story.'; release(); await settle();
    assert.equal(f.metrics.plan, 0); assert.equal(f.metrics.apply, 0); assert.equal(f.action('resume').hidden, true);
});

test('automatic mode is opt-in and disabled normal Send falls through', async () => {
    const f = fixture({ workflow: true }); f.send(); await settle();
    assert.equal(f.metrics.nativeAbort, undefined); assert.equal(f.metrics.capture, 0);
});

test('duplicate interceptor hooks produce only one automatic workflow', async () => {
    const f = fixture({ workflow: true, automatic: true }); f.send();
    f.globals.StoryBuilder_Intercept([], 128000, () => {}, 'normal'); await settle();
    assert.equal(f.metrics.plan, 1); assert.equal(f.metrics.run, 1); assert.equal(f.metrics.apply, 1);
});

test('the next normal Send starts a fresh story after a completed workflow', async () => {
    const f = fixture({ workflow: true, automatic: true }); f.send(); await settle();
    f.send('A different synthetic prompt.'); await settle();
    assert.equal(f.metrics.plan, 2); assert.equal(f.metrics.run, 2); assert.equal(f.metrics.apply, 2); assert.equal(f.metrics.track, 2);
});

test('automatic planning failure stops and Resume retries planning from captured source', async () => {
    let attempts = 0;
    const f = fixture({ workflow: true, automatic: true, plan: async job => {
        if (++attempts === 1) { job.status = 'failed'; throw Error('Synthetic planning failure.'); }
        job.plan = { sections: [] }; job.status = 'ready';
    } });
    f.send(); await settle(); assert.equal(f.metrics.run, 0); assert.equal(f.metrics.apply, 0);
    assert.equal(f.action('resume').hidden, false); f.action('resume').click(); await settle();
    assert.equal(f.metrics.capture, 1); assert.equal(f.metrics.plan, 2); assert.equal(f.metrics.apply, 1);
});

test('automatic incomplete writing never advances to review or publication', async () => {
    const f = fixture({ workflow: true, automatic: true, run: async job => { job.status = 'needs_attention'; } });
    f.send(); await settle(); assert.equal(f.metrics.editorial, undefined); assert.equal(f.metrics.apply, 0);
    assert.equal(f.action('resume').hidden, false);
});

test('automatic review failure resumes review without repeating writing', async () => {
    let attempts = 0;
    const f = fixture({ workflow: true, automatic: true, editorial: async job => {
        if (++attempts === 1) { job.editorial = { status: 'failed', reports: [] }; throw Error('Synthetic review failure.'); }
        job.editorial = { status: 'ready', text: 'Recovered final.', changes: [], reports: [], analysis: { words: 12500, paragraphs: 144 }, targetChecks: { formatValid: true } };
    } });
    f.send(); await settle(); assert.equal(f.metrics.apply, 0);
    f.action('resume').click(); await settle(); assert.equal(f.metrics.run, 1); assert.equal(f.metrics.editorial, 2); assert.equal(f.metrics.apply, 1);
});

test('automatic tracker retry never republishes or rewrites the saved story', async () => {
    let attempts = 0;
    const f = fixture({ workflow: true, automatic: true, track: async target => {
        if (++attempts === 1) { target.status = 'failed'; throw Error('Synthetic tracker failure.'); } target.status = 'complete';
    } });
    f.send(); await settle(); assert.equal(f.metrics.apply, 1); assert.equal(f.action('resume').hidden, false);
    f.action('resume').click(); await settle(); assert.equal(f.metrics.apply, 1); assert.equal(f.metrics.run, 1); assert.equal(f.metrics.track, 2);
});

test('native Stop cancels automatic writing and never publishes partial text', async () => {
    const f = fixture({ workflow: true, automatic: true, run: async (job, transport) => {
        await new Promise((resolve, reject) => transport.signal.addEventListener('abort', () => { job.status = 'paused'; reject(new DOMException('Paused', 'AbortError')); }, { once: true }));
    } });
    f.send(); await settle(); f.eventSource.emit('GENERATION_STOPPED'); await settle();
    assert.equal(f.metrics.apply, 0); assert.equal(f.action('resume').hidden, false); assert.match(f.status(), /Paused/);
});

test('pause during saving checkpoints publication and Resume only updates memory', async () => {
    let release;
    const f = fixture({ workflow: true, automatic: true, apply: () => new Promise(resolve => { release = resolve; }) });
    f.send(); await settle(); assert.equal(f.metrics.apply, 1);
    f.action('pause').click(); release(); await settle(); assert.equal(f.metrics.track, undefined);
    f.action('resume').click(); await settle(); assert.equal(f.metrics.apply, 1); assert.equal(f.metrics.track, 1);
});

test('failed save allows retry without repeating completed model stages', async () => {
    let attempts = 0;
    const f = fixture({ workflow: true, automatic: true, apply: () => { if (++attempts === 1) throw Error('Synthetic save failure.'); } });
    f.send(); await settle(); assert.equal(f.metrics.track, undefined);
    f.action('resume').click(); await settle(); assert.equal(f.metrics.apply, 2); assert.equal(f.metrics.run, 1); assert.equal(f.metrics.editorial, 1); assert.equal(f.metrics.track, 1);
});

test('a second send preserves an unfinished draft and blocks overlapping work', async () => {
    const f = fixture({ workflow: true, automatic: true, run: async job => { job.sections = [{ id: 1, text: 'Saved section.', words: 1000, paragraphs: 15 }]; job.status = 'needs_attention'; } });
    f.send(); await settle(); f.send('Second saved prompt.'); await settle();
    assert.equal(f.metrics.nativeAbortCount, 2); assert.equal(f.metrics.plan, 1); assert.equal(f.metrics.run, 1);
    assert.equal(f.action('download').hidden, false); assert.match(f.status(), /unfinished job/);
});

test('switching chats while initial source capture awaits never plans for the new chat', async () => {
    let release, capturedSignal;
    const f = fixture({ workflow: true, automatic: true, capture: ({ signal }) => {
        capturedSignal = signal; return new Promise(resolve => { release = resolve; });
    } });
    f.send(); await settle(); f.context.chatId = 'different-synthetic-chat'; f.context.chat = [];
    f.eventSource.emit('CHAT_CHANGED'); release(); await settle();
    assert.equal(capturedSignal.aborted, true); assert.equal(f.metrics.plan, 0); assert.equal(f.metrics.apply, 0);
    assert.equal(f.action('resume').hidden, true);
});

test('a silent source switch during initial capture is rejected by the original Send ticket', async () => {
    let release;
    const f = fixture({ workflow: true, automatic: true, capture: () => new Promise(resolve => { release = resolve; }) });
    f.send(); await settle(); f.context.chatId = 'different-synthetic-chat'; release(); await settle();
    assert.equal(f.metrics.plan, 0); assert.equal(f.metrics.apply, 0); assert.equal(f.action('resume').hidden, true);
});

test('prepare, generate, preview, and apply are separate explicit operations', async () => {
    const f = fixture(); f.byText('Prepare outline from current prompt').click(); await settle();
    assert.equal(f.metrics.capture, 1); assert.equal(f.metrics.plan, 1); assert.equal(f.metrics.run, 0); assert.equal(f.metrics.apply, 0);
    assert.equal(f.extension_settings.StoryBuilder.writerModel, '');
    f.byText('Generate full story').click(); await settle();
    assert.equal(f.metrics.run, 1); assert.equal(f.metrics.apply, 0); assert.equal(f.preview().textContent, '');
    const details = f.nodes.find(n => n.tagName === 'details' && n.children[0]?.textContent === 'Preview combined draft');
    details.open = true; for (const fn of details.listeners.toggle) fn();
    assert.match(f.preview().textContent, /Synthetic section 8/);
    f.byText('Add finished story to chat').click(); f.byText('Add finished story to chat').click(); await settle();
    assert.equal(f.metrics.apply, 1); assert.match(f.status(), /No memory was created/);
    assert.ok(!f.body.textContent.includes('Your chat, prompt, or writing settings changed.'));
});

test('a stale source blocks apply without deleting completed sections', async () => {
    const f = fixture(); f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle();
    f.metrics.sourceCurrent = false; f.eventSource.emit('MESSAGE_EDITED');
    assert.equal(f.byText('Add finished story to chat').disabled, true);
    assert.equal(f.byText('Download plain-text story').disabled, false);
    f.byText('Add finished story to chat').click(); await settle(); assert.equal(f.metrics.apply, 0);
});

test('pause preserves completed sections and enables resume', async () => {
    const f = fixture({ run: async (job, transport, options) => {
        job.sections.push({ id: 1, text: 'One completed section.', words: 1562, paragraphs: 18 });
        options.onProgress({ stage: 'section_complete', section: 1, total: 8, message: 'Kept.' });
        await new Promise((resolve, reject) => transport.signal.addEventListener('abort', () => { job.status = 'paused'; reject(new DOMException('Paused.', 'AbortError')); }, { once: true }));
    } });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle();
    assert.equal(f.byText('Pause').disabled, false); f.byText('Pause').click(); await settle();
    assert.equal(f.byText('Resume full story').disabled, false); assert.equal(f.byText('Download partial plain-text story').disabled, false); assert.equal(f.metrics.apply, 0);
});

test('normal generation pauses the builder; native dry runs do not', async () => {
    let aborts = 0;
    const f = fixture({ run: async (job, transport) => { await new Promise((resolve, reject) => transport.signal.addEventListener('abort', () => { aborts++; job.status = 'paused'; reject(new DOMException('Paused.', 'AbortError')); }, { once: true })); } });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle();
    f.eventSource.emit('GENERATION_STARTED', 'swipe', {}, true); await settle(); assert.equal(aborts, 0);
    f.eventSource.emit('GENERATION_STARTED', 'normal', {}, false); await settle(); assert.equal(aborts, 1); assert.equal(f.metrics.apply, 0);
});

test('failed section is never automatically added or marked complete', async () => {
    const f = fixture({ run: async job => { job.pending = { text: 'Too brief.', issues: ['This section has too few words.'] }; job.status = 'needs_attention'; } });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle();
    assert.equal(f.byText('Add finished story to chat').disabled, true); assert.equal(f.byText('Retry unfinished section').disabled, false); assert.match(f.status(), /did not pass/); assert.equal(f.metrics.apply, 0);
    assert.equal(f.nodes.filter(n => n.className === 'sb-preview').at(-1).textContent, '');
});

test('flexible paragraph completion reports the missed target without claiming both passed', async () => {
    const f = fixture({ run: async (job, transport, options) => {
        job.sections = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, text: `Synthetic dialogue section ${i + 1}.`, words: 1562, paragraphs: 35 })); job.status = 'complete';
        options.onProgress({ stage: 'complete', message: 'Synthetic flexible completion.' });
    } });
    const checkbox = f.nodes.find(n => n.tagName === 'input' && n.type === 'checkbox');
    assert.equal(checkbox.checked, DEFAULTS.strictParagraphs === true); checkbox.checked = false;
    f.byText('Prepare outline from current prompt').click(); await settle();
    assert.equal(f.extension_settings.StoryBuilder.strictParagraphs, false);
    f.byText('Generate full story').click(); await settle();
    assert.match(f.status(), /meets the word target/); assert.match(f.status(), /paragraph count is outside/);
    assert.ok(!f.status().includes('word and paragraph targets'));
    assert.match(f.body.textContent, /Paragraph target missed \(reported only\)/);
    assert.equal(f.byText('Add finished story to chat').disabled, false);
});

test('reported cost is labelled as a subtotal and unknown cost is not shown as free', async () => {
    const f = fixture({ fetcher: async () => ({ ok: true, status: 200, json: async () => ({ usage: { cost: 0.0134 } }) }),
        run: async (job, transport) => { await transport.fetcher('/api/backends/chat-completions/generate', { body: JSON.stringify({ model: 'fixture/writer' }) }); job.status = 'paused'; job.calls = 3; job.usage = { cost: 0.0134 }; } });
    f.byText('Prepare outline from current prompt').click(); await settle();
    assert.match(f.body.textContent, /No API usage cost reported yet/); assert.ok(!f.body.textContent.includes('$0.0000'));
    f.byText('Generate full story').click(); await settle();
    assert.match(f.body.textContent, /Workflow requests attempted: 3/); assert.match(f.body.textContent, /Reported \$0\.0134/); assert.match(f.body.textContent, /not a final bill/);
});

test('apply preserves only accepted planning and FF panels separately from story prose', async () => {
    const f = fixture({ run: async job => {
        job.sections = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, text: `Synthetic section ${i + 1}.`, words: 1562, paragraphs: 18, reasoning: i === 0 ? 'Accepted planning.' : '', providerReasoning: i === 0 ? 'Accepted planning.' : '', auxiliary: i === 0 ? '<details><summary>QUESTS</summary>Accepted panel.</details>' : '' }));
        job.pending = { reasoning: 'Rejected planning.', text: 'Rejected draft.' }; job.status = 'complete';
    } });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle(); f.byText('Add finished story to chat').click(); await settle();
    const notes = f.metrics.appliedOptions.reasoning;
    assert.match(notes, /## Section 1/); assert.equal(notes.split('Accepted planning.').length - 1, 1); assert.match(notes, /Accepted panel/); assert.ok(!notes.includes('Rejected'));
    assert.ok(!f.metrics.appliedText.includes('planning')); assert.ok(!f.metrics.appliedText.includes('panel'));
});

test('apply does not claim it updated the visible chat after a save-time context switch', async () => {
    const f = fixture({ applyReturn: { saveRequested: true, rendered: false } });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle(); f.byText('Add finished story to chat').click(); await settle();
    assert.match(f.status(), /active chat changed while saving/); assert.match(f.status(), /check the source chat/); assert.ok(!f.status().startsWith('Added the combined story'));
    assert.equal(f.byText('Download plain-text story').disabled, false); assert.equal(f.byText('Add finished story to chat').disabled, true);
});

test('lore and persona events invalidate a prepared source even without a basic snapshot difference', async () => {
    for (const event of ['WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'PERSONA_CHANGED', 'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED']) {
        const f = fixture(); f.byText('Prepare outline from current prompt').click(); await settle();
        assert.equal(f.metrics.sourceCurrent, true); f.eventSource.emit(event); await settle();
        assert.equal(f.byText('Generate full story').disabled, true, event); assert.equal(f.metrics.run, 0);
    }
});

test('lore changes abort a planner request after the source has been captured', async () => {
    let aborted = false;
    const f = fixture({ plan: async (job, transport) => {
        job.status = 'planning';
        await new Promise((resolve, reject) => transport.signal.addEventListener('abort', () => { aborted = true; job.status = 'paused'; reject(new DOMException('Paused.', 'AbortError')); }, { once: true }));
    } });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.eventSource.emit('WORLDINFO_UPDATED'); await settle();
    assert.equal(aborted, true); assert.equal(f.metrics.run, 0); assert.equal(f.metrics.apply, 0);
});

test('FF graphics previews show prop text safely while apply preserves the exact source', async () => {
    const before = 'Unknown <mark>outside</mark> stays unchanged.\n\n';
    const graphic = '<!--GFX_START--><div style="color:red" onclick="untrusted()"><style>.secret { display:none }</style><p>HARBOR &amp; CUSTOMS</p><div>Receipt &#35;42<br>Paid: &#x32; coins</div><img src="https://example.invalid/private" onerror="untrusted()"><script>untrusted()</script></div><!--GFX_END-->';
    const after = '\n\nThe courier folded the receipt.';
    const raw = before + graphic + after;
    const f = fixture({ run: async job => {
        job.sections = [{ id: 1, text: raw, words: 12500, paragraphs: 145 }]; job.status = 'complete';
    } });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle();
    const details = f.nodes.find(n => n.tagName === 'details' && n.children[0]?.textContent === 'Preview combined draft');
    details.open = true; for (const fn of details.listeners.toggle) fn();
    const visible = f.preview().textContent;
    assert.ok(visible.startsWith(before)); assert.ok(visible.endsWith(after));
    assert.match(visible, /\[FF formatted insert\]/); assert.match(visible, /HARBOR & CUSTOMS\nReceipt #42\nPaid: 2 coins/);
    assert.ok(!visible.includes('<div')); assert.ok(!visible.includes('onclick')); assert.ok(!visible.includes('untrusted')); assert.ok(!visible.includes('example.invalid'));
    assert.equal(f.nodes.some(n => ['script', 'style', 'img'].includes(n.tagName)), false);
    f.byText('Download plain-text story').click(); const exported = await f.metrics.downloadBlob.text();
    assert.match(exported, /HARBOR & CUSTOMS\nReceipt #42\nPaid: 2 coins/); assert.ok(!exported.includes('[FF formatted insert]')); assert.ok(!exported.includes('<div'));
    f.byText('Add finished story to chat').click(); await settle(); assert.equal(f.metrics.appliedText, raw);
    const failed = fixture({ run: async job => { job.pending = { text: raw, issues: ['Synthetic count failure.'] }; job.status = 'needs_attention'; } });
    failed.byText('Prepare outline from current prompt').click(); await settle(); failed.byText('Generate full story').click(); await settle();
    const pending = failed.nodes.find(n => n.tagName === 'details' && n.children[0]?.textContent === 'Inspect last unsuccessful section attempt');
    pending.open = true; for (const fn of pending.listeners.toggle) fn();
    assert.equal(failed.nodes.filter(n => n.className === 'sb-preview').at(-1).textContent, visible);
});

test('known inline formatting is readable in previews and plain-text exports without changing application', async () => {
    const raw = '<font color="#f00"><b>Red</b> <span>words</span></font> <strong>remain</strong> <i>in</i> <em>their</em> <u>original</u> <s>order</s>. <mark>Unknown tag</mark> <b-custom>also stays</b-custom>.';
    const readable = 'Red words remain in their original order. <mark>Unknown tag</mark> <b-custom>also stays</b-custom>.';
    const f = fixture({ run: async job => { job.sections = [{ id: 1, text: raw, words: 12500, paragraphs: 145 }]; job.status = 'complete'; } });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle();
    const details = f.nodes.find(n => n.tagName === 'details' && n.children[0]?.textContent === 'Preview combined draft'); details.open = true; for (const fn of details.listeners.toggle) fn();
    assert.equal(f.preview().textContent, readable);
    f.byText('Download plain-text story').click(); assert.equal(await f.metrics.downloadBlob.text(), readable);
    f.byText('Add finished story to chat').click(); await settle(); assert.equal(f.metrics.appliedText, raw);
});

test('enabled workflow reviews before apply and updates memory only from final text', async () => {
    const f = fixture({ workflow: true });
    f.byText('Prepare outline from current prompt').click(); await settle();
    f.byText('Generate full story').click(); await settle();
    assert.equal(f.metrics.editorial, 1); assert.equal(f.metrics.apply, 0); assert.equal(f.metrics.track, undefined);
    f.byText('Add finished story to chat').click(); await settle();
    assert.equal(f.metrics.appliedText, 'Revised synthetic final story.');
    assert.match(f.metrics.appliedOptions.originalDraft, /Synthetic section 1/);
    assert.equal(f.metrics.appliedOptions.workflow.revisionCount, 1);
    assert.equal(f.metrics.track, 1); assert.match(f.status(), /continuity are updated/);
    assert.equal(f.byText('Update continuity').disabled, true);
});

test('failed review resumes without rewriting completed sections or applying draft', async () => {
    let attempts = 0;
    const f = fixture({ workflow: true, editorial: async job => {
        attempts++;
        if (attempts === 1) { job.editorial = { status: 'failed', text: 'Staged draft.', reports: [], error: 'Synthetic review failure.' }; throw Error('Synthetic review failure.'); }
        job.editorial = { status: 'ready', text: 'Recovered reviewed draft.', changes: [], unresolved: [], reports: [], analysis: { words: 12500, paragraphs: 144 }, targetChecks: { formatValid: true } };
    } });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle();
    assert.equal(f.byText('Add finished story to chat').disabled, true);
    assert.equal(f.metrics.apply, 0); assert.equal(f.metrics.run, 1);
    f.byText('Resume review and revisions').click(); await settle();
    assert.equal(f.metrics.run, 1); assert.equal(f.metrics.editorial, 2);
    assert.equal(f.byText('Add finished story to chat').disabled, false);
});

test('memory failure retries without applying story a second time', async () => {
    let attempts = 0;
    const f = fixture({ workflow: true, track: async target => { if (++attempts === 1) throw Error('Synthetic tracker failure.'); target.status = 'complete'; } });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle();
    f.byText('Add finished story to chat').click(); await settle();
    assert.equal(f.metrics.apply, 1); assert.match(f.status(), /continuity updating did not finish/);
    f.byText('Update continuity').click(); await settle();
    assert.equal(f.metrics.apply, 1); assert.equal(f.metrics.track, 2); assert.match(f.status(), /continuity are updated/);
});

test('revised story outside word target cannot be applied', async () => {
    const f = fixture({ workflow: true, editorial: async job => { job.editorial = { status: 'ready', text: 'Too short.', reports: [], changes: [], unresolved: [], analysis: { words: 2, paragraphs: 1 }, targetChecks: { formatValid: true } }; } });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle();
    assert.equal(f.byText('Add finished story to chat').disabled, true); assert.match(f.status(), /word target was missed/);
});

test('native generation cancels the initial accepted-story tracker handoff', async () => {
    let aborted = false;
    const f = fixture({ workflow: true, track: async (_target, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Paused.', 'AbortError')); }, { once: true })) });
    f.byText('Prepare outline from current prompt').click(); await settle(); f.byText('Generate full story').click(); await settle();
    f.byText('Add finished story to chat').click(); await settle();
    f.eventSource.emit('GENERATION_STARTED', 'normal', {}, false); await settle();
    assert.equal(aborted, true); assert.equal(f.metrics.apply, 1);
});
