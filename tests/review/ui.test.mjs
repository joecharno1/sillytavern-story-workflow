import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DEFAULTS, safeSettings, snapshotDraft, snapshotCurrent, appendRevision } from '../../extensions/StoryReview/review-service.js';
import { resolveFollowUpSettings, createFollowUpSession, updateSessionOptions, advanceSession, reviewFollowUp, reviseFollowUp, followUpSpend, assertFollowUpCurrent } from '../../extensions/StoryReview/follow-up.js';
import { WRITING_ASPECTS, WRITING_PRESETS } from '../../extensions/StoryBuilder/writing-tuning.js';
import { formatSpendSummary } from '../../extensions/StoryBuilder/chat-progress.js';

const code = (await fs.readFile(new URL('../../extensions/StoryReview/index.js', import.meta.url), 'utf8')).replace(/^import .+?;\s*$/gm, '');
class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this._text = ''; this.hidden = false; this.disabled = false; this.open = false; }
    set innerHTML(_value) { throw new Error('Never parse HTML from a report or preference.'); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(node => typeof node === 'string' ? node : node.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
    addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    click() { if (!this.disabled) for (const handler of this.listeners.click || []) handler({ target: this }); }
    showModal() { this.open = true; } close() { this.open = false; } focus() {}
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const report = { summary: 'The scene is consistent.', strengths: [], issues: [] };
const reply = (content, usage = { cost: 0.01, prompt_tokens: 100, completion_tokens: 25 }) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage }) });
function fixture({ builder = {}, preferences = {}, generate, review = {} } = {}) {
    const nodes = [], body = new Node('body'), metrics = { chatReads: 0, paid: [], metadata: [], saves: 0, preferencesSaved: 0, memory: 0 };
    const document = { body, createElement(tag) { const node = new Node(tag); nodes.push(node); return node; }, createTextNode: text => String(text), getElementById: id => nodes.find(node => node.id === id) || null };
    for (const id of ['extensions_settings2', 'extensionsMenu']) { const node = document.createElement('div'); node.id = id; body.append(node); }
    const handlers = {}, eventSource = { on(name, handler) { (handlers[name] ||= []).push(handler); }, async emit(name, ...args) { for (const handler of handlers[name] || []) await handler(...args); } };
    const event_types = Object.fromEntries(['APP_READY', 'GENERATION_STARTED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED', 'GENERATION_ENDED', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED'].map(name => [name, name]));
    const original = 'Mara entered the courtyard.\n\nShe kept the compass sealed.\n\nThe gate opened at dawn.';
    const chat = [{ is_user: true, mes: 'Carry the sealed compass to the courtyard before dawn.' }, { is_user: false, mes: original, swipe_id: 0, swipes: [original], swipe_info: [{}], extra: {}, gen_finished: 10 }];
    let chatId = 'synthetic-editor-chat', generating = false;
    const context = { get chat() { metrics.chatReads++; return chat; }, getCurrentChatId: () => chatId, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        saveSettingsDebounced: () => metrics.preferencesSaved++, saveChat: async () => { metrics.saves++; }, updateMessageBlock() {}, eventSource, eventTypes: event_types,
        executeSlashCommandsWithOptions: async () => { metrics.memory++; return {}; } };
    const extension_settings = { StoryReview: { ...DEFAULTS, model: 'fixture/base', maxOutput: 100, wordMin: 1, wordMax: 1000, paragraphMin: 1, paragraphMax: 30, ...review, followUp: { ...preferences } },
        StoryBuilder: { reviewerModel: 'fixture/review', revisionModel: 'fixture/revision', strictParagraphs: false, ...builder } };
    const catalog = ['fixture/base', 'fixture/review', 'fixture/revision', 'fixture/dialogue', 'fixture/other'].map(id => ({ id, context_length: 262144, top_provider: { max_completion_tokens: 16384 }, pricing: { prompt: '0.000001', completion: '0.000002' } }));
    const deps = { extension_settings, eventSource, event_types, oai_settings: { stream_openai: false }, isGenerating: () => generating,
        DEFAULTS, safeSettings, snapshotDraft, snapshotCurrent, appendRevision, resolveFollowUpSettings, createFollowUpSession, updateSessionOptions, advanceSession, reviewFollowUp, reviseFollowUp, followUpSpend, assertFollowUpCurrent,
        WRITING_ASPECTS, WRITING_PRESETS, formatSpendSummary, document, SillyTavern: { getContext: () => context }, setTimeout: callback => { callback(); return 0; },
        fetch: async (url, options) => {
            const request = JSON.parse(options.body);
            if (url.endsWith('/status')) { metrics.metadata.push(url); return { ok: true, status: 200, json: async () => ({ data: catalog }) }; }
            if (url.startsWith('/api/tokenizers/')) { metrics.metadata.push(url); return { ok: true, status: 200, json: async () => ({ token_count: 100 }) }; }
            assert.equal(url, '/api/backends/chat-completions/generate'); metrics.paid.push(request);
            return generate ? generate(request, options, metrics) : reply(JSON.stringify(report));
        } };
    new Function(...Object.keys(deps), code)(...Object.values(deps));
    void eventSource.emit('APP_READY');
    return { nodes, body, metrics, chat, original, extension_settings, eventSource,
        field: id => nodes.find(node => node.id === `story-review-${id}`),
        button: text => nodes.find(node => node.tagName === 'button' && node.textContent === text),
        status: () => nodes.find(node => node.className === 'sr-status').textContent,
        spend: () => nodes.find(node => node.className === 'sr-spending').textContent,
        async open() { await eventSource.emit('story_workflow_open_editor'); await flush(); },
        async change(id, value, event = 'change') { const input = this.field(id); if (input.type === 'checkbox') input.checked = value; else input.value = value; for (const handler of input.listeners[event] || []) handler({ target: input }); await flush(); },
        async changeSource() { chat[0].mes += ' Changed instruction.'; await eventSource.emit('MESSAGE_EDITED', 0); await flush(); },
        async switchChat() { chatId = 'different-synthetic-chat'; await eventSource.emit('CHAT_CHANGED'); await flush(); },
        setGenerating(value) { generating = value; } };
}

test('mount, both entry points, and completed-reply counts are free; standalone auto review stays off', async () => {
    const f = fixture({ review: { autoReview: true }, builder: { chatWorkflowEnabled: false } }); await flush();
    assert.equal(f.metrics.chatReads, 0); assert.equal(f.metrics.paid.length, 0); assert.equal(f.metrics.metadata.length, 0);
    assert.equal(f.extension_settings.StoryReview.autoReview, false);
    await f.open(); f.button('Open follow-up editor').click(); await flush();
    assert.equal(f.field('dialog').open, true); assert.match(f.body.textContent, /v1\.3\.0/);
    const advanced = f.nodes.find(node => node.className === 'sr-advanced-preferences');
    assert.equal(advanced.open, false); assert.equal(advanced.children[0].textContent, 'Styles, models, and spending limit');
    const contains = (node, target) => node === target || node.children?.some(child => typeof child === 'object' && contains(child, target));
    assert.equal(contains(advanced, f.field('focus')), false);
    assert.equal(contains(advanced, f.nodes.find(node => node.className === 'sr-effective')), false);
    assert.equal(contains(advanced, f.nodes.find(node => node.className === 'sr-spending')), false);
    assert.equal(contains(advanced, f.field('reviewModel')), true);
    assert.equal(f.field('focus').value, 'general'); assert.equal(f.field('useBuilderStyles').checked, true); assert.equal(f.field('spendLimitUsd').value, 1);
    await f.eventSource.emit('GENERATION_STARTED', 'normal', {}, false); await f.eventSource.emit('MESSAGE_RECEIVED', 1, 'normal'); await f.eventSource.emit('GENERATION_ENDED'); await flush();
    assert.equal(f.metrics.paid.length, 0); assert.equal(f.metrics.metadata.length, 0);
});

test('focus presets and model overrides are local, read Builder library without modifying it, and load catalog only explicitly', async () => {
    const f = fixture({ builder: { tuningEnabled: true, writingStyles: { dialogue: { preset: 'natural', custom: '', model: 'fixture/dialogue' } }, writingPresetLibrary: { dialogue: [{ id: 'custom-soft', name: '<script>Soft</script>', text: 'Use brief, warm replies.' }] } } });
    const originalBuilder = JSON.stringify(f.extension_settings.StoryBuilder); await f.open(); await f.change('focus', 'dialogue');
    assert.match(f.body.textContent, /Review: fixture\/dialogue.*Revision: fixture\/dialogue/);
    await f.change('preset', 'custom-soft'); assert.match(f.body.textContent, /Style: <script>Soft<\/script>/);
    const option = f.field('preset').children.find(node => node.value === 'custom-soft'); assert.equal(option.children.length, 0);
    await f.change('preset', 'custom'); await f.change('custom', 'Keep this one-off instruction exactly.');
    await f.change('reviewModel', 'fixture/other'); await f.change('revisionModel', 'fixture/revision');
    assert.equal(f.metrics.paid.length, 0); assert.equal(f.metrics.metadata.length, 0); assert.equal(JSON.stringify(f.extension_settings.StoryBuilder), originalBuilder);
    f.button('Load available model IDs').click(); await flush(); assert.equal(f.metrics.metadata.length, 1); assert.equal(f.metrics.paid.length, 0);
    assert.equal(f.field('reviewModel').value, 'fixture/other'); assert.equal(f.extension_settings.StoryReview.followUp.custom, 'Keep this one-off instruction exactly.');
});

test('review and repeated previews share allowance; only explicit apply creates a version attributed to actual revision model', async () => {
    const f = fixture({ generate: async request => JSON.parse(request.messages[1].content).selectedParagraphs
        ? reply('She carried the sealed compass carefully.') : reply(JSON.stringify(report)) }); await f.open();
    f.button('Review current draft').click(); await flush(); assert.equal(f.metrics.paid.length, 1); assert.match(f.spend(), /Reported \$0\.0100/);
    await f.change('range', '2', 'input'); await f.change('instruction', 'Clarify the movement.', 'input');
    f.button('Preview targeted revision').click(); await flush();
    assert.equal(f.metrics.paid.length, 2); assert.equal(f.chat[1].mes, f.original); assert.equal(f.metrics.saves, 0); assert.equal(f.button('Apply as new reply version').disabled, false);
    assert.match(f.field('preview').textContent, /Original passage.*She kept the compass sealed\..*Proposed replacement.*carried the sealed compass carefully/s);
    assert.match(f.field('preview').textContent, /Revision model: fixture\/revision/);
    f.button('Apply as new reply version').click(); await flush();
    assert.equal(f.metrics.saves, 1); assert.deepEqual(f.chat[1].swipes, [f.original, 'Mara entered the courtyard.\n\nShe carried the sealed compass carefully.\n\nThe gate opened at dawn.']);
    assert.equal(f.chat[1].extra.model, 'Story Review (fixture/revision)'); assert.equal(f.metrics.memory, 0); assert.match(f.spend(), /Reported \$0\.0200/);
    f.button('Close').click(); await f.open(); assert.match(f.spend(), /Reported \$0\.0200/);
    f.button('Preview targeted revision').click(); await flush(); assert.match(f.spend(), /Reported \$0\.0300/);
    assert.equal(f.field('spendLimitUsd').disabled, true);
});

test('preference, instruction, and external source changes invalidate pending proposals without resetting spending', async () => {
    const f = fixture({ generate: async () => reply('She carried the sealed compass carefully.') }); await f.open();
    await f.change('range', '2', 'input'); await f.change('instruction', 'Clarify movement.', 'input');
    f.button('Preview targeted revision').click(); await flush(); assert.equal(f.button('Apply as new reply version').disabled, false);
    await f.change('revisionModel', 'fixture/other'); assert.equal(f.button('Apply as new reply version').disabled, true); assert.equal(f.field('preview').textContent, ''); assert.match(f.spend(), /Reported \$0\.0100/);
    f.button('Preview targeted revision').click(); await flush(); await f.change('instruction', 'New intended change.', 'input'); assert.equal(f.button('Apply as new reply version').disabled, true);
    f.button('Preview targeted revision').click(); await flush(); await f.changeSource(); assert.equal(f.button('Apply as new reply version').disabled, true); assert.equal(f.field('preview').textContent, ''); assert.match(f.spend(), /Reported \$0\.0300/);
    await f.open(); assert.match(f.spend(), /Reported \$0\.0300/); f.button('New editing session').click(); assert.match(f.spend(), /Remaining \$1\.0000/); assert.match(f.spend(), /Previous session: \$0\.0300/);
    assert.equal(f.field('spendLimitUsd').disabled, false); assert.equal(f.metrics.saves, 0);
});

test('cancelled paid request holds unknown cost and locks preferences until it ends', async () => {
    const f = fixture({ generate: async (_request, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })) }); await f.open();
    f.button('Review current draft').click(); await flush(); assert.equal(f.metrics.paid.length, 1); assert.equal(f.field('focus').disabled, true); assert.equal(f.button('New editing session').disabled, true);
    f.button('Cancel request').click(); await flush(); assert.equal(f.field('focus').disabled, false); assert.match(f.spend(), /Unknown-charge allowance \$0\.0024/);
    await f.change('reviewModel', 'fixture/other'); assert.match(f.spend(), /Unknown-charge allowance \$0\.0024/); assert.equal(f.metrics.saves, 0);
});

test('a budget denial is zero paid calls and does not silently start a new allowance', async () => {
    const f = fixture({ preferences: { spendLimitUsd: 0.0001 } }); await f.open();
    f.button('Review current draft').click(); await flush(); assert.equal(f.metrics.paid.length, 0); assert.match(f.status(), /spending limit/);
    await f.change('reviewModel', 'fixture/other'); f.button('Review current draft').click(); await flush(); assert.equal(f.metrics.paid.length, 0);
    assert.equal(f.field('spendLimitUsd').disabled, true); assert.match(f.spend(), /Remaining \$0\.0001/);
});

test('source changes abort an in-flight review and discard its late result while retaining returned usage', async () => {
    let release, signal;
    const waiting = new Promise(resolve => { release = resolve; });
    const f = fixture({ generate: async (_request, options) => { signal = options.signal; await waiting; return reply(JSON.stringify({ ...report, summary: 'LATE PRIVATE REPORT' }), { cost: 0.04 }); } });
    await f.open(); f.button('Review current draft').click(); await flush();
    await f.changeSource(); assert.equal(signal.aborted, true); assert.equal(f.field('focus').disabled, true);
    release(); await flush();
    assert.equal(f.field('focus').disabled, false); assert.equal(f.field('issues').textContent, ''); assert.equal(f.button('Apply as new reply version').disabled, true);
    assert.doesNotMatch(f.body.textContent, /LATE PRIVATE REPORT/); assert.match(f.spend(), /Reported \$0\.0400/); assert.equal(f.metrics.saves, 0);
});
