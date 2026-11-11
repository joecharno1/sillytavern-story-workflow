import test from 'node:test';
import assert from 'node:assert/strict';
import { captureSource, snapshotCurrent, watchPreparationEdits } from '../../extensions/StoryBuilder/st-bridge.js';

// No browser, network, real files, or saved chats are used in these tests.
function transactionFixture() {
    const handlers = new Map();
    const eventTypes = Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED',
        'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'CHARACTER_EDITED', 'OAI_PRESET_CHANGED_AFTER',
        'GENERATION_STARTED', 'GENERATE_AFTER_DATA'].map(key => [key, key.toLowerCase()]));
    const eventSource = {
        on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
        removeListener(type, fn) { handlers.get(type)?.delete(fn); },
        async emit(type, ...args) { for (const fn of handlers.get(type) || []) await fn(...args); },
    };
    const brief = 'SYNTHETIC TRANSACTION BRIEF: deliver the sealed ledger before six.';
    const reasoningPrompt = 'SYNTHETIC FF REASONING: preserve the entire supplied writing process.';
    const settings = { chat_completion_source: 'openrouter', openrouter_model: 'synthetic/writer',
        openai_max_context: 131072, openai_max_tokens: 16384, reasoning_effort: 'max',
        prompts: [{ identifier: 'ff-reasoning', content: reasoningPrompt }],
        prompt_order: [{ order: [{ identifier: 'ff-reasoning', enabled: true }] }], function_calling: true };
    let saves = 0, dryRuns = 0, nonDryRuns = 0, watchStarts = 0, watchStops = 0, watchedEdit;
    const context = {
        chat: [{ name: 'Archivist', is_user: false, mes: 'Synthetic greeting.', extra: {} },
            { name: 'Author', is_user: true, mes: brief, extra: {} },
            { name: 'Archivist', is_user: false, mes: 'SYNTHETIC REJECTED DRAFT', extra: { reasoning: 'Rejected planning.' } }],
        characterId: 0, groupId: null, name1: 'Author', name2: 'Archivist',
        characters: [{ name: 'Archivist', avatar: 'synthetic.png', description: 'A neutral test archivist.', data: {} }],
        chatMetadata: { variables: {} }, extensionPrompts: {}, getCurrentChatId: () => 'synthetic-transaction',
        saveChat: async () => { saves++; },
    };
    const f = { context, settings, brief, reasoningPrompt, eventTypes, eventSource, handlers,
        onGenerate: async () => {}, onParameters: async () => {},
        notifyUserEdit: () => { assert.equal(typeof watchedEdit, 'function'); watchedEdit(); },
        stats: () => ({ saves, dryRuns, nonDryRuns, watchStarts, watchStops, watching: Boolean(watchedEdit) }),
    };
    f.dependencies = {
        getContext: () => context, getSettings: () => settings, getModel: copy => copy.openrouter_model,
        mainApi: () => 'openai', isGenerating: () => false, composerText: () => '', eventSource, eventTypes,
        watchSourceEdits: onEdit => {
            watchStarts++;
            assert.equal(watchedEdit, undefined, 'only one edit observer may be active');
            watchedEdit = onEdit;
            let disposed = false;
            return () => { assert.equal(disposed, false, 'observer is disposed exactly once'); disposed = true; watchStops++; watchedEdit = undefined; };
        },
        generate: async (type, options, dryRun) => {
            if (dryRun) dryRuns++; else nonDryRuns++;
            await eventSource.emit(eventTypes.GENERATION_STARTED, type, options, dryRun);
            const selected = type === 'swipe' ? context.chat.slice(0, -1) : context.chat;
            await eventSource.emit(eventTypes.GENERATE_AFTER_DATA, { prompt: [
                { role: 'system', content: reasoningPrompt },
                ...selected.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes })),
            ] }, dryRun);
            await f.onGenerate();
        },
        createParameters: async (copy, model, type, messages) => {
            assert.equal(copy.function_calling, false);
            await f.onParameters();
            return { generate_data: { model, type, messages, reasoning_effort: copy.reasoning_effort, stream: true } };
        },
    };
    return f;
}

function assertObserversReleased(f) {
    const stats = f.stats();
    assert.equal(stats.watching, false);
    assert.equal(stats.watchStarts, stats.watchStops);
    assert.ok([...f.handlers.values()].every(set => set.size === 0));
}

test('unknown extension bookkeeping can change in both preparation stages on repeated captures', async () => {
    const f = transactionFixture();
    const originalChat = structuredClone(f.context.chat), originalSettings = structuredClone(f.settings);
    let revision = 0;
    f.onGenerate = async () => {
        revision++;
        f.context.chatMetadata.unregistered_extension_cache = { revision, stage: 'native' };
        f.context.chatMetadata.temporary_extension_marker = revision;
        delete f.context.chatMetadata.finished_extension_marker;
    };
    f.onParameters = async () => {
        f.context.chatMetadata.unregistered_extension_cache.stage = 'parameters';
        delete f.context.chatMetadata.temporary_extension_marker;
        f.context.chatMetadata.finished_extension_marker = revision;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
        const source = await captureSource({ dependencies: f.dependencies });
        assert.equal(source.metadata.fullBriefIncluded, true);
        assert.equal(source.metadata.rejectedReplyExcluded, true);
        assert.equal(source.messages[0].content, f.reasoningPrompt);
        assert.equal(source.latestBrief, f.brief);
        assert.ok(source.messages.some(message => message.role === 'user' && message.content === f.brief));
        assert.ok(source.messages.every(message => !message.content.includes('SYNTHETIC REJECTED DRAFT')));
        assert.equal(source.requestTemplate.reasoning_effort, 'max');
        assert.equal(snapshotCurrent(source.snapshot), true, 'baseline follows both preparation stages');
        assertObserversReleased(f);
    }
    assert.deepEqual(f.context.chat, originalChat);
    assert.deepEqual(f.settings, originalSettings);
    assert.equal(f.stats().dryRuns, 3);
    assert.equal(f.stats().nonDryRuns, 0);
    assert.equal(f.stats().saves, 0);
});

test('source-bearing metadata changes are rejected even without a UI edit observer', async () => {
    const fields = ['note_prompt', 'note_interval', 'note_position', 'note_depth', 'note_role',
        'scenario', 'system_prompt', 'mes_example', 'world_info', 'persona', 'main_chat',
        'script_injects', 'attachments', 'cfg_negative_prompt'];
    for (const stage of ['onGenerate', 'onParameters']) {
        for (const field of fields) {
            const f = transactionFixture();
            delete f.dependencies.watchSourceEdits;
            const initial = field === 'attachments' ? [{ name: 'original.txt', url: '/synthetic/original.txt' }]
                : field === 'script_injects' ? { guide: { value: 'Original synthetic guide.' } } : 'Original synthetic value';
            f.context.chatMetadata[field] = initial;
            f[stage] = async () => { f.context.chatMetadata[field] = field === 'attachments'
                ? [{ name: 'changed.txt', url: '/synthetic/changed.txt' }]
                : field === 'script_injects' ? { guide: { value: 'Changed synthetic guide.' } } : 'Changed synthetic value'; };
            await assert.rejects(captureSource({ dependencies: f.dependencies }), /changed/i, `${stage}: ${field}`);
            assert.equal(f.stats().saves, 0);
            assertObserversReleased(f);
        }
    }
});

test('an observed user edit to unknown extension metadata rejects both preparation stages', async () => {
    for (const stage of ['onGenerate', 'onParameters']) {
        const f = transactionFixture();
        f[stage] = async () => {
            f.context.chatMetadata.unregistered_extension_option = 'Synthetic user edit';
            f.notifyUserEdit();
        };
        await assert.rejects(captureSource({ dependencies: f.dependencies }), /changed/i);
        assert.equal(f.context.chatMetadata.unregistered_extension_option, 'Synthetic user edit');
        assertObserversReleased(f);
    }
});

test('a captured source remains strict about later unknown extension metadata edits', async () => {
    const f = transactionFixture();
    f.onGenerate = async () => { f.context.chatMetadata.unregistered_extension_cache = { revision: 1 }; };
    const source = await captureSource({ dependencies: f.dependencies });
    assert.equal(snapshotCurrent(source.snapshot), true);
    f.context.chatMetadata.unregistered_extension_cache.revision = 2;
    assert.equal(snapshotCurrent(source.snapshot), false);
    assertObserversReleased(f);
});

test('source edit observers are released after cancellation and generation or parameter failure', async () => {
    for (const outcome of ['abort', 'generate-error', 'parameters-error']) {
        const f = transactionFixture(), controller = new AbortController();
        if (outcome === 'abort') f.onGenerate = async () => { controller.abort(); };
        if (outcome === 'generate-error') f.onGenerate = async () => { throw new Error('Synthetic generation error'); };
        if (outcome === 'parameters-error') f.onParameters = async () => { throw new Error('Synthetic parameter error'); };
        await assert.rejects(captureSource({ dependencies: f.dependencies, signal: controller.signal }), outcome === 'abort' ? { name: 'AbortError' } : /Synthetic/);
        assert.equal(f.stats().watchStarts, 1);
        assertObserversReleased(f);
        assert.equal(f.stats().nonDryRuns, 0);
        assert.equal(f.stats().saves, 0);
    }
});

function watchedDocument() {
    const listeners = new Map(), registrations = [], removals = [];
    return {
        registrations, removals, listeners,
        addEventListener(type, handler, capture) {
            registrations.push({ type, handler, capture });
            listeners.set(type, handler);
        },
        removeEventListener(type, handler, capture) {
            removals.push({ type, handler, capture });
            if (listeners.get(type) === handler) listeners.delete(type);
        },
        emit(type, target, isTrusted = true) { listeners.get(type)?.({ type, target, isTrusted }); },
    };
}

function privateElement({ builder = false, interactive = true } = {}) {
    const element = {
        closest(selector) {
            if (selector === '#story-builder-dialog') return builder ? this : null;
            return interactive ? this : null;
        },
    };
    for (const property of ['value', 'textContent', 'innerText', 'innerHTML', 'outerHTML']) {
        Object.defineProperty(element, property, { get() { throw new Error(`The observer must not read ${property}`); } });
    }
    return element;
}

test('real preparation watcher catches trusted input and change without reading field contents', () => {
    const target = watchedDocument();
    let edits = 0;
    const dispose = watchPreparationEdits(() => edits++, target);
    const privateInput = privateElement();
    target.emit('input', privateInput);
    target.emit('change', privateInput);
    assert.equal(edits, 2);
    target.emit('input', privateInput, false);
    target.emit('change', privateInput, false);
    target.emit('click', privateInput, false);
    assert.equal(edits, 2, 'programmatic preparation events are not mistaken for human edits');
    dispose();
});

test('real preparation watcher recognizes external interactive clicks and ignores builder controls', () => {
    const target = watchedDocument();
    let edits = 0;
    const dispose = watchPreparationEdits(() => edits++, target);
    target.emit('click', privateElement({ interactive: false }));
    target.emit('click', null);
    assert.equal(edits, 0, 'noninteractive page navigation is ignored');
    target.emit('click', privateElement());
    assert.equal(edits, 1, 'external extension buttons may change custom metadata');
    for (const type of ['input', 'change', 'click']) target.emit(type, privateElement({ builder: true }));
    assert.equal(edits, 1, 'Story Builder controls are handled by the builder itself');
    dispose();
});

test('real preparation watcher uses capture listeners and removes every handler on disposal', () => {
    const target = watchedDocument();
    let edits = 0;
    const dispose = watchPreparationEdits(() => edits++, target);
    assert.deepEqual(target.registrations.map(({ type, capture }) => ({ type, capture })), [
        { type: 'input', capture: true }, { type: 'change', capture: true }, { type: 'click', capture: true },
    ]);
    assert.equal(target.listeners.size, 3);
    dispose();
    assert.deepEqual(target.removals, target.registrations, 'remove the same callbacks with the same capture mode');
    assert.equal(target.listeners.size, 0);
    for (const type of ['input', 'change', 'click']) target.emit(type, privateElement());
    assert.equal(edits, 0, 'no observer remains after preparation');
});
