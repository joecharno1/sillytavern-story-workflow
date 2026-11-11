import test from 'node:test';
import assert from 'node:assert/strict';
import { captureSource, makeSnapshot, isSnapshotCurrent, snapshotCurrent, containsFullBrief, applyResult, sourceRevisionTracker, snapshotChangeCategories } from '../../extensions/StoryBuilder/st-bridge.js';

function fixture({ reply = true } = {}) {
    const handlers = new Map();
    const eventSource = {
        on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
        removeListener(type, fn) { handlers.get(type)?.delete(fn); },
        async emit(type, ...args) { for (const fn of handlers.get(type) || []) await fn(...args); },
    };
    const eventTypes = Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED',
        'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'CHARACTER_EDITED', 'OAI_PRESET_CHANGED_AFTER',
        'GENERATION_STARTED', 'GENERATE_AFTER_DATA', 'WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED',
        'PERSONA_CHANGED', 'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED'].map(key => [key, key.toLowerCase()]));
    const settings = { chat_completion_source: 'openrouter', openrouter_model: 'synthetic/model',
        openai_max_context: 131072, openai_max_tokens: 32768, reasoning_effort: 'max',
        prompts: [{ identifier: 'reasoning', content: 'Keep this intact.' }], prompt_order: [{ order: [1] }],
        function_calling: true, openrouter_middleout: 'on' };
    let saves = 0, render = 0, generationType, generationDryRun, generationSignal;
    const chat = [{ name: 'Example', is_user: false, mes: 'Hello {{user}}.', extra: {} },
        { name: 'Author', is_user: true, mes: 'SYNTHETIC BRIEF: deliver the sealed ledger before six.' }];
    if (reply) chat.push({ name: 'Example', is_user: false, mes: 'Rejected story.', extra: { reasoning: 'old thought' } });
    const context = { chat, characterId: 0, groupId: null, name2: 'Example',
        characters: [{ name: 'Example', avatar: 'example.png', description: 'A clockmaker.', data: {} }],
        chatMetadata: { variables: {} }, getCurrentChatId: () => 'synthetic-chat',
        saveChat: async () => { saves++; }, updateMessageBlock: () => { render++; },
        addOneMessage: () => { render++; }, refreshSwipeButtons: () => {} };
    const dependencies = { getContext: () => context, getSettings: () => settings,
        mainApi: () => 'openai', isGenerating: () => false, eventSource, eventTypes,
        composerText: () => '', getTimestamp: () => '2026-11-10T12:00:00Z',
        getModel: copy => copy.openrouter_model,
        createParameters: async (copy, model, type, messages) => {
            assert.equal(copy.function_calling, false);
            return { generate_data: { model, type, messages, temperature: .95,
                reasoning_effort: copy.reasoning_effort, stream: true, middleout: 'on' } };
        },
        generate: async (type, options, dryRun) => {
            generationType = type; generationDryRun = dryRun; generationSignal = options.signal;
            await eventSource.emit(eventTypes.GENERATION_STARTED, type, options, dryRun);
            context.chat[0].mes = 'Hello Author.';
            context.chatMetadata.variables.prepareCount = 1;
            const selected = type === 'swipe' ? chat.slice(0, -1) : [...chat];
            await eventSource.emit(eventTypes.GENERATE_AFTER_DATA, { prompt: [
                { role: 'system', content: 'Keep this intact.' },
                ...selected.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes })),
            ] }, true);
        },
    };
    return { context, settings, dependencies, handlers, eventSource, eventTypes,
        stats: () => ({ saves, render, generationType, generationDryRun, generationSignal }) };
}

test('native capture preserves FF, excludes only rejected reply, restores first greeting, sends no draft', async () => {
    const f = fixture(); const originalSettings = JSON.stringify(f.settings);
    const source = await captureSource({ dependencies: f.dependencies });
    assert.equal(source.messages[0].content, 'Keep this intact.');
    assert.ok(!source.messages.some(message => message.content.includes('Rejected story.')));
    assert.equal(source.latestBrief, f.context.chat[1].mes);
    assert.equal(source.metadata.fullBriefIncluded, true);
    assert.equal(f.context.chat[0].mes, 'Hello {{user}}.');
    assert.equal(JSON.stringify(f.settings), originalSettings);
    assert.equal(source.requestTemplate.reasoning_effort, 'max');
    assert.equal(source.requestTemplate.middleout, 'off');
    assert.equal(source.requestTemplate.stream, false);
    assert.equal(source.requestTemplate.messages, undefined);
    assert.deepEqual(f.stats(), { saves: 0, render: 0, generationType: 'swipe', generationDryRun: true, generationSignal: undefined });
    assert.equal(snapshotCurrent(source.snapshot), true);
    assert.ok([...f.handlers.values()].every(set => set.size === 0));
});

test('capture after last user uses normal dry-run and preserves full brief', async () => {
    const f = fixture({ reply: false });
    const source = await captureSource({ dependencies: f.dependencies });
    assert.equal(source.snapshot.mode, 'append');
    assert.equal(f.stats().generationType, 'normal');
    assert.equal(f.context.chat.length, 2);
});

test('missing entire brief fails closed and makes no request', async () => {
    const f = fixture();
    f.dependencies.generate = async () => f.eventSource.emit(f.eventTypes.GENERATE_AFTER_DATA, { prompt: [{ role: 'user', content: 'Only part of the brief.' }] }, true);
    await assert.rejects(captureSource({ dependencies: f.dependencies }), /full latest brief was not found/);
    assert.equal(f.stats().saves, 0);
});

test('composer drafts and group chats are never silently ignored', async () => {
    const f = fixture();
    f.dependencies.composerText = () => 'Unsaved prompt edit';
    await assert.rejects(captureSource({ dependencies: f.dependencies }), /Save your prompt edit/);
    f.dependencies.composerText = () => '';
    f.context.groupId = 'group';
    await assert.rejects(captureSource({ dependencies: f.dependencies }), /one-character/);
});

test('abort restores known dry-run mutation and removes listeners', async () => {
    const f = fixture(); const controller = new AbortController();
    const original = f.dependencies.generate;
    f.dependencies.generate = async (...args) => { await original(...args); controller.abort(); };
    await assert.rejects(captureSource({ signal: controller.signal, dependencies: f.dependencies }), { name: 'AbortError' });
    assert.equal(f.context.chat[0].mes, 'Hello {{user}}.');
    assert.ok([...f.handlers.values()].every(set => set.size === 0));
});

test('concurrent user edit is preserved and invalidates capture', async () => {
    const f = fixture(); const original = f.dependencies.generate;
    f.dependencies.generate = async (...args) => {
        await original(...args); f.context.chat[0].mes = 'User edited the greeting.';
        await f.eventSource.emit(f.eventTypes.MESSAGE_EDITED, 0);
    };
    await assert.rejects(captureSource({ dependencies: f.dependencies }), /chat changed/);
    assert.equal(f.context.chat[0].mes, 'User edited the greeting.');
});

test('snapshot detects edits, swipes, settings and character changes', () => {
    for (const mutate of [f => { f.context.chat[1].mes += ' edit'; }, f => { f.context.chat[2].swipe_id = 1; },
        f => { f.settings.reasoning_effort = 'low'; }, f => { f.context.characters[0].description += ' edit'; },
        f => { f.context.chatMetadata.accepted = true; }]) {
        const f = fixture(); const snapshot = makeSnapshot(f.context, f.settings);
        assert.equal(isSnapshotCurrent(f.context, snapshot, f.settings), true);
        mutate(f); assert.equal(isSnapshotCurrent(f.context, snapshot, f.settings), false);
    }
});

test('apply creates a new swipe preserving old text and reasoning without generation events', async () => {
    const f = fixture(); const snapshot = makeSnapshot(f.context, f.settings);
    let events = 0; f.eventSource.emit = async () => { events++; };
    const result = await applyResult(snapshot, 'Finished story.', { dependencies: f.dependencies, model: 'test/model', reasoning: 'New planning' });
    const last = f.context.chat.at(-1);
    assert.deepEqual(last.swipes, ['Rejected story.', 'Finished story.']);
    assert.equal(last.swipe_info[0].extra.reasoning, 'old thought');
    assert.equal(last.extra.reasoning, 'New planning');
    assert.equal(result.swipeId, 1); assert.equal(result.saveRequested, true);
    assert.equal(f.stats().saves, 1); assert.equal(f.stats().render, 1); assert.equal(events, 0);
});

test('apply after a saved user brief appends one new assistant reply', async () => {
    const f = fixture({ reply: false }); const snapshot = makeSnapshot(f.context, f.settings);
    await applyResult(snapshot, 'Finished story.', { dependencies: f.dependencies });
    assert.equal(f.context.chat.length, 3); assert.equal(f.context.chat.at(-1).is_user, false);
    assert.equal(f.context.chat[1].mes, snapshot.latestBrief); assert.equal(f.stats().saves, 1);
});

test('stale apply cannot change chat or save', async () => {
    const f = fixture(); const snapshot = makeSnapshot(f.context, f.settings);
    f.context.chat[1].mes = 'Edited brief';
    await assert.rejects(applyResult(snapshot, 'Finished story.', { dependencies: f.dependencies }), /changed/);
    assert.equal(f.context.chat.at(-1).mes, 'Rejected story.'); assert.equal(f.stats().saves, 0);
});

test('save exception rolls back only the tool-created changes', async () => {
    for (const reply of [true, false]) {
        const f = fixture({ reply }); const snapshot = makeSnapshot(f.context, f.settings);
        const original = JSON.stringify(f.context.chat);
        f.context.saveChat = async () => { throw new Error('Synthetic save failure'); };
        await assert.rejects(applyResult(snapshot, 'Finished story.', { dependencies: f.dependencies }), /could not save/);
        assert.equal(JSON.stringify(f.context.chat), original);
    }
});

test('brief inclusion requires full text in a user message', () => {
    assert.equal(containsFullBrief([{ role: 'system', content: 'Full brief' }], 'Full brief'), false);
    assert.equal(containsFullBrief([{ role: 'user', content: 'Wrapped: Full brief\n' }], 'Full brief'), true);
    assert.equal(containsFullBrief([{ role: 'user', content: 'Partial' }], 'Partial missing text'), false);
});

test('lore and persona revisions invalidate captured sources without retaining event payloads', async () => {
    for (const name of ['WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'PERSONA_CHANGED', 'PERSONA_UPDATED']) {
        const f = fixture();
        f.dependencies.getSourceRevision = sourceRevisionTracker(f.eventSource, f.eventTypes);
        const source = await captureSource({ dependencies: f.dependencies });
        assert.equal(snapshotCurrent(source.snapshot), true);
        await f.eventSource.emit(f.eventTypes[name], 'synthetic-event', { text: 'Synthetic newly edited fact.' });
        assert.equal(snapshotCurrent(source.snapshot), false);
        await assert.rejects(applyResult(source.snapshot, 'New story', { dependencies: f.dependencies }), /changed/);
        assert.equal(f.stats().saves, 0);
    }
});

test('one source revision observer is reused rather than accumulating listeners', async () => {
    const f = fixture();
    const a = sourceRevisionTracker(f.eventSource, f.eventTypes);
    const b = sourceRevisionTracker(f.eventSource, f.eventTypes);
    assert.equal(a, b); assert.equal(a(), 0);
    await f.eventSource.emit(f.eventTypes.WORLDINFO_UPDATED, 'synthetic');
    assert.equal(a(), 1);
    assert.equal(f.handlers.get(f.eventTypes.WORLDINFO_UPDATED).size, 1);
});

test('lore edits during native preparation invalidate that capture', async () => {
    const f = fixture();
    f.dependencies.getSourceRevision = sourceRevisionTracker(f.eventSource, f.eventTypes);
    const original = f.dependencies.generate;
    f.dependencies.generate = async (...args) => { await original(...args); await f.eventSource.emit(f.eventTypes.WORLDINFO_UPDATED, 'synthetic'); };
    await assert.rejects(captureSource({ dependencies: f.dependencies }), /changed during preparation/);
});

test('persona name and extension prompts are part of the source snapshot', () => {
    const f = fixture(); const snapshot = makeSnapshot(f.context, f.settings);
    f.context.name1 = 'Different synthetic author';
    assert.equal(isSnapshotCurrent(f.context, snapshot, f.settings), false);
    delete f.context.name1;
    f.context.extensionPrompts = { note: { value: 'New synthetic note.' } };
    assert.equal(isSnapshotCurrent(f.context, snapshot, f.settings), false);
});

test('native macro variables may change, but author note edits invalidate capture', async () => {
    const f = fixture(); const original = f.dependencies.generate;
    f.dependencies.generate = async (...args) => { await original(...args); f.context.chatMetadata.note_prompt = 'A concurrent synthetic note edit.'; };
    await assert.rejects(captureSource({ dependencies: f.dependencies }), /changed during preparation/);
});

test('switching chats while save awaits never renders the old result into the new chat', async () => {
    for (const reply of [true, false]) {
        const f = fixture({ reply }); const snapshot = makeSnapshot(f.context, f.settings);
        f.context.saveChat = async () => {
            // Native ST commonly reuses the chat array when changing chats.
            f.context.getCurrentChatId = () => 'different-synthetic-chat';
            f.context.chat.splice(0, f.context.chat.length, { is_user: true, mes: 'An unrelated synthetic message.' });
        };
        const result = await applyResult(snapshot, 'Finished old story.', { dependencies: f.dependencies });
        assert.equal(result.rendered, false); assert.equal(result.saveRequested, true);
        assert.equal(f.stats().render, 0);
        assert.equal(f.context.chat.length, 1);
        assert.equal(f.context.chat[0].mes, 'An unrelated synthetic message.');
    }
});

test('starting native generation during save suppresses the delayed builder render', async () => {
    const f = fixture(); const snapshot = makeSnapshot(f.context, f.settings);
    f.context.saveChat = async () => { f.dependencies.isGenerating = () => true; };
    const result = await applyResult(snapshot, 'Finished story.', { dependencies: f.dependencies });
    assert.equal(result.rendered, false); assert.equal(f.stats().render, 0);
});

test('native cache initialization and derived attachment lengths are allowed on repeated preparation', async () => {
    const f = fixture();
    f.context.chat[1].extra = { fileLength: 0, files: [{ text: 'Synthetic attachment.' }], custom: 'preserved' };
    const original = f.dependencies.generate;
    f.dependencies.generate = async (...args) => {
        await original(...args);
        f.context.chatMetadata.chat_id_hash ||= 12345;
        f.context.chatMetadata.timedWorldInfo ||= {};
        f.context.chatMetadata.timedWorldInfo.sticky ||= {};
        f.context.chatMetadata.timedWorldInfo.cooldown ||= {};
        delete f.context.chat[1].extra.fileLength;
        f.context.chat[1].extra.fileLength = 23;
    };
    for (let i = 0; i < 3; i++) {
        const source = await captureSource({ dependencies: f.dependencies });
        assert.equal(source.metadata.fullBriefIncluded, true);
        assert.equal(snapshotCurrent(source.snapshot), true);
    }
    assert.equal(f.context.chat[1].extra.custom, 'preserved');
    assert.equal(f.stats().saves, 0);
});

test('fingerprints ignore object-key order but preserve array order and field values', () => {
    const f = fixture();
    f.context.chat[1].extra = { fileLength: 23, custom: { a: 1, b: 2 }, items: ['a', 'b'] };
    const snapshot = makeSnapshot(f.context, f.settings);
    f.context.chat[1].extra = { items: ['a', 'b'], custom: { b: 2, a: 1 }, fileLength: 23 };
    f.settings.prompts[0] = { content: 'Keep this intact.', identifier: 'reasoning' };
    assert.equal(isSnapshotCurrent(f.context, snapshot, f.settings), true);
    f.context.chat[1].extra.items.reverse();
    assert.deepEqual(snapshotChangeCategories(f.context, snapshot, f.settings), ['messages']);
});

test('native timed metadata shape normalization does not allow real timed-state edits', async () => {
    for (const mutation of ['valid-state', 'existing-hash']) {
        const f = fixture();
        f.context.chatMetadata.chat_id_hash = 123;
        f.context.chatMetadata.timedWorldInfo = { sticky: { valid: { hash: 1, start: 2, end: 6 } }, cooldown: {} };
        const original = f.dependencies.generate;
        f.dependencies.generate = async (...args) => {
            await original(...args);
            if (mutation === 'valid-state') f.context.chatMetadata.timedWorldInfo.sticky.valid.end = 99;
            else f.context.chatMetadata.chat_id_hash = 999;
        };
        await assert.rejects(captureSource({ dependencies: f.dependencies }), /changed during preparation \(metadata\)/);
    }
});

test('native timed metadata repairs invalid shapes without ignoring unrelated metadata', async () => {
    const f = fixture();
    f.context.chatMetadata.timedWorldInfo = { sticky: { invalid: null, valid: { hash: 1, start: 2, end: 6 } }, cooldown: null };
    const original = f.dependencies.generate;
    f.dependencies.generate = async (...args) => {
        await original(...args);
        delete f.context.chatMetadata.timedWorldInfo.sticky.invalid;
        f.context.chatMetadata.timedWorldInfo.cooldown = {};
    };
    const source = await captureSource({ dependencies: f.dependencies });
    assert.equal(snapshotCurrent(source.snapshot), true);
    f.context.chatMetadata.timedWorldInfo.sticky.valid.end = 99;
    assert.equal(snapshotCurrent(source.snapshot), false);
});

test('unchanged partial or uninitialized timed caches never invent a preparation change', async () => {
    const values = [null, false, {}, { cooldown: {} }, { sticky: { invalid: null } },
        { sticky: { valid: { hash: 1, start: 2, end: 6 } } }];
    for (const value of values) {
        const f = fixture(); f.context.chatMetadata.timedWorldInfo = structuredClone(value);
        for (let attempt = 0; attempt < 3; attempt++) {
            const source = await captureSource({ dependencies: f.dependencies });
            assert.equal(snapshotCurrent(source.snapshot), true);
            assert.deepEqual(f.context.chatMetadata.timedWorldInfo, value);
        }
    }
});

test('preparation cannot delete an existing timed metadata field, even when its shape was invalid', async () => {
    for (const value of [null, { sticky: { valid: { hash: 1, start: 2, end: 6 } }, cooldown: {} }]) {
        const f = fixture(); f.context.chatMetadata.timedWorldInfo = value;
        const original = f.dependencies.generate;
        f.dependencies.generate = async (...args) => { await original(...args); delete f.context.chatMetadata.timedWorldInfo; };
        await assert.rejects(captureSource({ dependencies: f.dependencies }), /changed during preparation \(metadata\)/);
    }
});

test('attachment-derived exception does not hide actual attachment edits and stays strict after capture', async () => {
    const f = fixture();
    f.context.chat[1].extra = { fileLength: 1, files: [{ text: 'Original synthetic attachment' }] };
    const original = f.dependencies.generate;
    f.dependencies.generate = async (...args) => { await original(...args); f.context.chat[1].extra.fileLength = 30; };
    const source = await captureSource({ dependencies: f.dependencies });
    f.context.chat[1].extra.fileLength = 31;
    assert.equal(snapshotCurrent(source.snapshot), false);
    f.dependencies.generate = async (...args) => { await original(...args); f.context.chat[1].extra.files[0].text = 'Changed synthetic attachment'; f.context.chat[1].extra.fileLength = 99; };
    await assert.rejects(captureSource({ dependencies: f.dependencies }), /changed during preparation \(messages\)/);
});

test('metadata replacement uses fresh references and diagnostics never expose private keys or values', async () => {
    const f = fixture(); const original = f.dependencies.generate;
    f.dependencies.generate = async (...args) => { await original(...args); f.context.chatMetadata = { ...f.context.chatMetadata, note_prompt: 'DO_NOT_DISCLOSE_SYNTHETIC_TEXT', secret_custom_key: 'DO_NOT_DISCLOSE_SYNTHETIC_TEXT' }; };
    await assert.rejects(captureSource({ dependencies: f.dependencies }), error => {
        assert.match(error.message, /\(metadata\)/);
        assert.ok(!error.message.includes('secret_custom_key'));
        assert.ok(!error.message.includes('DO_NOT_DISCLOSE_SYNTHETIC_TEXT'));
        return true;
    });
});

test('workflow preserves first draft and earlier reply as swipes before selecting final revision', async () => {
    const f = fixture(); const source = await captureSource({ dependencies: f.dependencies });
    const result = await applyResult(source.snapshot, 'Final revised story.', { originalDraft: 'First generated draft.', workflow: { version: 1, revisionCount: 2 }, dependencies: f.dependencies });
    const message = f.context.chat.at(-1);
    assert.deepEqual(message.swipes, ['Rejected story.', 'First generated draft.', 'Final revised story.']);
    assert.equal(result.swipeId, 2); assert.equal(message.extra.storyWorkflow.revisionCount, 2);
    assert.equal(message.swipe_info[1].extra.storyWorkflow.draftBeforeRevision, true);
});

test('workflow appending a new message keeps the generated original as the earlier swipe', async () => {
    const f = fixture({ reply: false }); const source = await captureSource({ dependencies: f.dependencies });
    const result = await applyResult(source.snapshot, 'Final story.', { originalDraft: 'Original story.', workflow: { version: 1 }, dependencies: f.dependencies });
    assert.deepEqual(f.context.chat.at(-1).swipes, ['Original story.', 'Final story.']);
    assert.equal(result.swipeId, 1); assert.equal(f.context.chat.at(-1).swipe_id, 1);
});

test('failed append save preserves a newer user edit made while save awaited', async () => {
    const f = fixture({ reply: false }); const source = await captureSource({ dependencies: f.dependencies });
    f.context.saveChat = async () => { f.context.chat.at(-1).mes = 'Newer user-edited draft.'; throw Error('Synthetic save failure.'); };
    await assert.rejects(applyResult(source.snapshot, 'Finished draft.', { dependencies: f.dependencies }), /could not save/);
    assert.equal(f.context.chat.at(-1).mes, 'Newer user-edited draft.');
});

function installSyntheticTrackerHook(f, hook) {
    let calls = 0, parameterMessages;
    const original = f.dependencies.createParameters;
    f.dependencies.getTrackerInterceptor = () => async chat => { calls++; await hook(chat); };
    f.dependencies.createParameters = async (...args) => {
        parameterMessages = structuredClone(args[3]);
        return original(...args);
    };
    return { calls: () => calls, messages: () => parameterMessages };
}

test('saved trackers are included once before the latest full brief without changing native prompt rows', async () => {
    const f = fixture({ reply: false });
    const brief = f.context.chat[1].mes;
    const scene = 'SYNTHETIC SAVED SCENE: Mira holds the ledger in the west hall.';
    const plot = 'SYNTHETIC SAVED PLOT: the harbor meeting remains unresolved.';
    f.context.chat[0].extra.savedTracker = { scene, plot };
    const originalChat = structuredClone(f.context.chat);
    const nativeRows = [
        { role: 'system', content: 'Keep the entire writing preset intact.' },
        { role: 'user', content: `An older quoted brief: ${brief}` },
        { role: 'assistant', content: 'An accepted earlier story.', name: 'Example' },
        { role: 'user', content: `<current-author-brief>\n${brief}\n</current-author-brief>` },
        { role: 'assistant', content: '<unchanged-assistant-prefill>' },
    ];
    const originalGenerate = f.dependencies.generate;
    f.dependencies.generate = async (...args) => {
        await originalGenerate(...args);
        await f.eventSource.emit(f.eventTypes.GENERATE_AFTER_DATA, { prompt: nativeRows }, true);
    };
    const hook = installSyntheticTrackerHook(f, chat => {
        assert.notEqual(chat, f.context.chat);
        assert.notEqual(chat[0], f.context.chat[0]);
        const saved = chat[0].extra.savedTracker;
        // The real vendor hook also replaces the supplied array with cloned rows.
        const next = structuredClone(chat);
        next.push({ role: 'user', content: saved.scene, is_user: true, mes: saved.scene },
            { role: 'user', content: saved.plot, is_user: true, mes: saved.plot });
        chat.splice(0, chat.length, ...next);
    });
    const source = await captureSource({ dependencies: f.dependencies });
    assert.equal(hook.calls(), 1);
    assert.deepEqual(source.messages, [...nativeRows.slice(0, 3),
        { role: 'user', content: scene }, { role: 'user', content: plot }, ...nativeRows.slice(3)]);
    assert.deepEqual(hook.messages(), source.messages);
    assert.equal(source.messages.filter(row => row.content === scene).length, 1);
    assert.equal(source.messages.filter(row => row.content === plot).length, 1);
    assert.equal(source.messages.at(-1).content, '<unchanged-assistant-prefill>');
    assert.equal(source.latestBrief, brief);
    assert.equal(source.metadata.trackerSnapshotCount, 2);
    assert.equal(source.metadata.messageCount, nativeRows.length + 2);
    assert.equal(source.metadata.fullBriefIncluded, true);
    assert.deepEqual(f.context.chat, originalChat);
    assert.equal(snapshotCurrent(source.snapshot), true);
    assert.equal(f.stats().generationDryRun, true);
    assert.equal(f.stats().saves, 0);
});

test('replacing a rejected reply excludes its tracker while retaining earlier accepted continuity', async () => {
    const f = fixture();
    f.context.chat[0].extra.savedTracker = 'SYNTHETIC ACCEPTED CONTINUITY';
    f.context.chat.at(-1).extra.savedTracker = 'SYNTHETIC REJECTED CONTINUITY';
    const originalChat = structuredClone(f.context.chat);
    const hook = installSyntheticTrackerHook(f, chat => {
        assert.equal(chat.length, 2);
        assert.ok(chat.every(row => row.mes !== 'Rejected story.'));
        const saved = chat.filter(row => row.extra?.savedTracker).map(row => row.extra.savedTracker);
        for (const text of saved) chat.push({ role: 'user', content: text, is_user: true, mes: text });
    });
    const source = await captureSource({ dependencies: f.dependencies });
    assert.equal(hook.calls(), 1);
    assert.equal(source.metadata.rejectedReplyExcluded, true);
    assert.equal(source.metadata.trackerSnapshotCount, 1);
    assert.ok(source.messages.some(row => row.content === 'SYNTHETIC ACCEPTED CONTINUITY'));
    assert.ok(source.messages.every(row => !row.content.includes('SYNTHETIC REJECTED')));
    assert.deepEqual(f.context.chat, originalChat);
    assert.equal(f.stats().saves, 0);
});

test('missing tracker hook or no saved tracker preserves the native prompt exactly', async () => {
    for (const withHook of [false, true]) {
        const f = fixture({ reply: false });
        if (withHook) f.dependencies.getTrackerInterceptor = () => () => {};
        const source = await captureSource({ dependencies: f.dependencies });
        assert.deepEqual(source.messages, [
            { role: 'system', content: 'Keep this intact.' },
            { role: 'assistant', content: 'Hello Author.' },
            { role: 'user', content: f.context.chat[1].mes },
        ]);
        assert.equal(source.metadata.trackerSnapshotCount, 0);
        assert.equal(f.stats().saves, 0);
    }
});

test('aborting tracker collection stops before request parameters and releases preparation observers', async () => {
    const f = fixture({ reply: false }), controller = new AbortController();
    const hook = installSyntheticTrackerHook(f, chat => {
        chat.push({ role: 'user', content: 'Synthetic continuity.', is_user: true, mes: 'Synthetic continuity.' });
        controller.abort();
    });
    await assert.rejects(captureSource({ dependencies: f.dependencies, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(hook.messages(), undefined);
    assert.equal(f.stats().saves, 0);
    assert.ok([...f.handlers.values()].every(set => set.size === 0));
});

for (const [label, mutate] of [
    ['chat ID', f => { f.context.getCurrentChatId = () => 'different-synthetic-chat'; }],
    ['chat array', f => { f.context.chat = [...f.context.chat]; }],
    ['brief text', f => { f.context.chat[1].mes += ' A new instruction.'; }],
    ['saved tracker', f => { f.context.chat[0].extra.savedTracker = 'A changed saved tracker.'; }],
    ['model settings', f => { f.settings.openrouter_model = 'synthetic/changed-model'; }],
    ['native generation', f => { f.dependencies.isGenerating = () => true; }],
]) {
    test(`a concurrent ${label} change during tracker collection rejects capture before request preparation`, async () => {
        const f = fixture({ reply: false });
        const hook = installSyntheticTrackerHook(f, async chat => {
            chat.push({ role: 'user', content: 'Synthetic continuity.', is_user: true, mes: 'Synthetic continuity.' });
            await Promise.resolve();
            mutate(f);
        });
        await assert.rejects(captureSource({ dependencies: f.dependencies }), /source changed/i);
        assert.equal(hook.messages(), undefined);
        assert.equal(f.stats().saves, 0);
        assert.ok([...f.handlers.values()].every(set => set.size === 0));
    });
}

test('an observed source edit during tracker formatting is rejected even if values were restored', async () => {
    const f = fixture({ reply: false });
    const hook = installSyntheticTrackerHook(f, async chat => {
        await f.eventSource.emit(f.eventTypes.MESSAGE_EDITED, 1);
        chat.push({ role: 'user', content: 'Synthetic continuity.', is_user: true, mes: 'Synthetic continuity.' });
    });
    await assert.rejects(captureSource({ dependencies: f.dependencies }), /source changed/i);
    assert.equal(hook.messages(), undefined);
    assert.equal(f.stats().saves, 0);
});

test('tracker formatter failure does not silently continue without saved continuity', async () => {
    const f = fixture({ reply: false });
    const hook = installSyntheticTrackerHook(f, () => { throw Error('Synthetic formatter failure'); });
    await assert.rejects(captureSource({ dependencies: f.dependencies }), /tracker|continuity|formatter/i);
    assert.equal(hook.messages(), undefined);
    assert.equal(f.stats().saves, 0);
    assert.ok([...f.handlers.values()].every(set => set.size === 0));
});
