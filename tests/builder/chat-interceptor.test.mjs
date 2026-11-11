import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatInterceptor } from '../../extensions/StoryBuilder/chat-interceptor.js';

function fixture(overrides = {}) {
    const f = {
        enabled: true, busy: false, generating: true, chatId: 'synthetic-chat',
        queue: [], starts: [], blocked: [], errors: [], aborts: [], delays: [],
    };
    f.context = {
        characterId: 0, groupId: null, chat: [{ is_user: false, mes: 'An empty road.' }],
        getCurrentChatId: () => f.chatId,
    };
    f.api = createChatInterceptor({
        getContext: () => f.context, isGenerating: () => f.generating,
        isEnabled: () => f.enabled, isBusy: () => f.busy,
        onStart: ticket => f.starts.push(ticket), onBlocked: reason => f.blocked.push(reason),
        onError: error => f.errors.push(error),
        schedule: (callback, delay) => { f.queue.push(callback); f.delays.push(delay); },
        ...overrides,
    });
    f.save = (text = 'Write the next chapter.') => {
        const message = { is_user: true, is_system: false, mes: text, swipe_id: 0 };
        f.context.chat.push(message);
        f.api.messageSent(f.context.chat.length - 1);
        return message;
    };
    f.intercept = (type = 'normal') => f.api.intercept([], 100000, value => f.aborts.push(value), type);
    f.send = () => { f.api.generationStarted('normal', {}, false); f.save(); return f.intercept(); };
    f.tick = async () => { const task = f.queue.shift(); if (task) await task(); };
    f.drain = async () => {
        for (let count = 0; f.queue.length && count < 100; count++) await f.tick();
        assert.equal(f.queue.length, 0, 'handoff must never schedule forever');
    };
    return f;
}

test('saved normal Send aborts native generation and starts once after deferred idle', async () => {
    const f = fixture();
    assert.equal(f.send(), true);
    assert.deepEqual(f.aborts, [true]);
    assert.equal(f.starts.length, 0);
    assert.deepEqual(f.delays, [1]);
    await f.tick();
    assert.equal(f.starts.length, 0);
    assert.deepEqual(f.delays, [1, 25]);
    f.generating = false;
    await f.tick();
    assert.equal(f.starts.length, 1);
    const ticket = f.starts[0];
    assert.equal(ticket.chat, f.context.chat);
    assert.equal(ticket.message, f.context.chat[1]);
    assert.equal(ticket.text, 'Write the next chapter.');
    assert.equal(ticket.chatId, f.chatId);
    assert.equal(ticket.characterId, 0);
    assert.equal(ticket.index, 1);
    assert.ok(Object.isFrozen(ticket));
    assert.deepEqual(f.errors, []);
});

test('duplicate message events and interceptor calls cannot duplicate starts', async () => {
    const f = fixture(); f.send();
    f.api.messageSent(1); f.intercept(); f.intercept();
    assert.equal(f.queue.length, 1);
    f.generating = false; await f.drain(); f.intercept(); await f.drain();
    assert.equal(f.starts.length, 1);
    assert.deepEqual(f.aborts, [true, true, true, true]);
});

for (const type of [undefined, null, 'quiet', 'swipe', 'regenerate', 'continue', 'impersonate']) {
    test(`generation type ${String(type)} is never claimed`, async () => {
        const f = fixture(); f.api.generationStarted(type, {}, false); f.save();
        assert.equal(f.api.intercept([], 1, value => f.aborts.push(value), type), false);
        await f.drain(); assert.deepEqual(f.aborts, []); assert.deepEqual(f.starts, []);
    });
}

for (const options of [
    { automatic_trigger: true }, { quiet_prompt: 'A hidden instruction.' },
    { quietToLoud: true }, { quietImage: 'synthetic-image' }, { force_chid: 0 },
]) {
    test(`helper generation options ${Object.keys(options)[0]} are excluded`, () => {
        const f = fixture(); f.api.generationStarted('normal', options, false); f.save();
        assert.equal(f.intercept(), false); assert.deepEqual(f.aborts, []);
    });
}

test('ordinary false/undefined options remain eligible', () => {
    const f = fixture();
    f.api.generationStarted('normal', { automatic_trigger: false, quiet_prompt: '', quietToLoud: false, force_chid: undefined }, false);
    f.save(); assert.equal(f.intercept(), true);
});

test('dry runs cannot establish a handoff or cancel a pending native handoff', async () => {
    const f = fixture(); f.api.generationStarted('normal', {}, true); f.save();
    assert.equal(f.intercept(), false);
    f.send(); f.api.generationStarted('swipe', {}, true);
    f.generating = false; await f.drain();
    assert.equal(f.starts.length, 1); assert.equal(f.starts[0].index, 2);
});

test('a dry run during onStart does not cause reentry', async () => {
    let f;
    f = fixture({ onStart: ticket => { f.starts.push(ticket); f.api.generationStarted('normal', {}, true); f.intercept(); } });
    f.send(); f.generating = false; await f.drain();
    assert.equal(f.starts.length, 1);
});

for (const [label, mutate] of [
    ['chat ID changed', f => { f.chatId = 'other-chat'; }],
    ['chat array replaced', f => { f.context.chat = [...f.context.chat]; }],
    ['message replaced', f => { f.context.chat[1] = { ...f.context.chat[1] }; }],
    ['message edited', f => { f.context.chat[1].mes += ' New edit.'; }],
    ['message swiped', f => { f.context.chat[1].swipe_id++; }],
    ['message deleted', f => { f.context.chat.pop(); }],
    ['later message appended', f => { f.context.chat.push({ is_user: true, mes: 'A later instruction.' }); }],
    ['role changed', f => { f.context.chat[1].is_user = false; }],
    ['system flag changed', f => { f.context.chat[1].is_system = true; }],
    ['character changed', f => { f.context.characterId = 2; }],
    ['group selected', f => { f.context.groupId = 'group'; }],
    ['disabled', f => { f.enabled = false; }],
]) {
    test(`pending handoff stops when ${label}`, async () => {
        const f = fixture(); f.send(); mutate(f); f.generating = false; await f.drain();
        assert.deepEqual(f.starts, []); assert.deepEqual(f.errors, []);
    });
    test(`native request is not claimed when ${label} before interception`, () => {
        const f = fixture(); f.api.generationStarted('normal', {}, false); f.save(); mutate(f);
        assert.equal(f.intercept(), false); assert.deepEqual(f.aborts, []);
    });
}

for (const groupId of ['group', 0]) {
    test(`group ${String(groupId)} is unsupported`, () => {
        const f = fixture(); f.context.groupId = groupId; f.send();
        assert.deepEqual(f.aborts, []); assert.deepEqual(f.queue, []);
    });
}

test('missing character or chat identity prevents interception', () => {
    for (const mutate of [f => { f.context.characterId = undefined; }, f => { f.chatId = ''; }]) {
        const f = fixture(); mutate(f); f.send(); assert.deepEqual(f.aborts, []);
    }
});

test('saved-message event must belong to this generation and a newly appended user message', () => {
    const f = fixture(); f.save();
    f.api.generationStarted('normal', {}, false); f.api.messageSent(1);
    assert.equal(f.intercept(), false);
    f.context.chat.push({ is_user: false, mes: 'A helper reply.' }); f.api.messageSent(2);
    assert.equal(f.intercept(), false);
    f.api.messageSent(-1); f.api.messageSent(99); f.api.messageSent('2');
    assert.deepEqual(f.aborts, []); assert.deepEqual(f.errors, []);
});

test('message from another chat cannot be recorded in an earlier generation', () => {
    const f = fixture(); f.api.generationStarted('normal', {}, false); f.chatId = 'another-chat'; f.save();
    assert.equal(f.intercept(), false);
});

test('cancel and destroy invalidate already scheduled work', async () => {
    for (const method of ['cancel', 'destroy']) {
        const f = fixture(); f.send(); f.api[method](); f.generating = false; await f.drain();
        assert.deepEqual(f.starts, []);
        if (method === 'destroy') { f.send(); assert.equal(f.queue.length, 0); }
    }
});

test('a newer generation cancels the older handoff and starts only its own saved user message', async () => {
    const f = fixture(); f.send(); f.send(); f.generating = false; await f.drain();
    assert.equal(f.starts.length, 1); assert.equal(f.starts[0].index, 2);
});

test('a new unsupported native generation also cancels the pending handoff', async () => {
    const f = fixture(); f.send(); f.api.generationStarted('quiet', {}, false);
    f.generating = false; await f.drain(); assert.deepEqual(f.starts, []);
});

test('busy unfinished work aborts native Send and reports the block promptly without overlap', async () => {
    const f = fixture(); f.busy = true; assert.equal(f.send(), true);
    assert.deepEqual(f.aborts, [true]); assert.equal(f.blocked.length, 1);
    assert.match(f.blocked[0], /unfinished/); assert.deepEqual(f.queue, []);
    f.intercept(); await f.drain(); assert.equal(f.blocked.length, 1); assert.deepEqual(f.starts, []);
});

test('becoming busy during handoff prevents starting another workflow', async () => {
    const f = fixture(); f.send(); f.busy = true; f.generating = false; await f.drain();
    assert.equal(f.blocked.length, 1); assert.deepEqual(f.starts, []);
});

test('native generation is rechecked only a bounded number of times', async () => {
    const f = fixture(); f.send(); await f.drain();
    assert.equal(f.delays.length, 21); assert.equal(f.blocked.length, 1);
    assert.match(f.blocked[0], /still generating/); assert.deepEqual(f.starts, []);
});

for (const asyncFailure of [false, true]) {
    test(`${asyncFailure ? 'async' : 'sync'} start failure reaches onError without retry or native fallback`, async () => {
        const error = new Error('Synthetic start failure');
        const f = fixture({ onStart: () => { if (asyncFailure) return Promise.reject(error); throw error; } });
        f.send(); f.generating = false; await f.drain(); f.intercept();
        assert.deepEqual(f.errors, [error]); assert.deepEqual(f.aborts, [true, true]);
    });
    test(`${asyncFailure ? 'async' : 'sync'} blocked callback failure reaches onError`, async () => {
        const error = new Error('Synthetic blocked failure');
        const f = fixture({ onBlocked: () => { if (asyncFailure) return Promise.reject(error); throw error; } });
        f.busy = true; f.send(); await Promise.resolve();
        assert.deepEqual(f.errors, [error]); assert.deepEqual(f.aborts, [true]);
    });
}

test('scheduling failure remains aborted and reports an error', () => {
    const error = new Error('Synthetic scheduler failure');
    const f = fixture({ schedule: () => { throw error; } }); f.send();
    assert.deepEqual(f.aborts, [true]); assert.deepEqual(f.errors, [error]);
});

test('busy-check failure after native abort cannot be mistaken for an unclaimed request', () => {
    const error = new Error('Synthetic busy-check failure');
    const f = fixture({ isBusy: () => { throw error; } });
    assert.equal(f.send(), true);
    assert.deepEqual(f.aborts, [true]); assert.deepEqual(f.errors, [error]);
    assert.deepEqual(f.queue, []);
});

test('dependency failures are contained, including a throwing error reporter', async () => {
    const error = new Error('Synthetic dependency failure');
    const f = fixture({ isGenerating: () => { throw error; } }); f.send(); await f.drain();
    assert.deepEqual(f.errors, [error]);
    for (const onError of [() => { throw error; }, async () => { throw error; }]) {
        const broken = fixture({ getContext: () => { throw error; }, onError });
        assert.doesNotThrow(() => broken.api.generationStarted('normal', {}, false));
        await Promise.resolve();
    }
});
