import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegenerateAction, storyTicketCurrent } from '../../extensions/StoryBuilder/regenerate-action.js';

function fixture(overrides = {}) {
    const f = { enabled: true, busy: false, generating: false, unsaved: false,
        chatId: 'synthetic-chat', starts: [], blocked: [], errors: [] };
    f.user = { is_user: true, is_system: false, mes: 'An edited synthetic story brief.', swipe_id: 0 };
    f.reply = { is_user: false, is_system: false, mes: 'The previous synthetic story.', swipe_id: 1 };
    f.context = { chat: [{ is_user: false, mes: 'An old greeting.' }, f.user, f.reply],
        characterId: 0, groupId: null, getCurrentChatId: () => f.chatId };
    f.api = createRegenerateAction({
        getContext: () => f.context, isEnabled: () => f.enabled, isBusy: () => f.busy,
        isGenerating: () => f.generating, hasUnsavedEdit: () => f.unsaved,
        onStart: ticket => { f.starts.push(ticket); f.busy = true; },
        onBlocked: reason => f.blocked.push(reason), onError: error => f.errors.push(error),
        ...overrides,
    });
    f.event = (matches = true) => ({
        target: { closest: selector => matches && selector === '#option_regenerate' ? {} : null },
        prevented: 0, stopped: 0,
        preventDefault() { this.prevented++; }, stopImmediatePropagation() { this.stopped++; },
    });
    f.click = event => f.api.handleClick(event ?? f.event());
    return f;
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('explicit regeneration is suppressed synchronously and retains the existing reply', () => {
    const f = fixture(), event = f.event(), original = [...f.context.chat];
    assert.equal(f.click(event), true);
    assert.equal(event.prevented, 1); assert.equal(event.stopped, 1);
    assert.equal(f.starts.length, 1); assert.equal(f.busy, true);
    assert.deepEqual(f.context.chat, original);
    const ticket = f.starts[0];
    assert.equal(ticket.message, f.user); assert.equal(ticket.index, 1);
    assert.equal(ticket.text, f.user.mes); assert.equal(ticket.swipeId, 0);
    assert.equal(ticket.tail.message, f.reply); assert.equal(ticket.tail.text, f.reply.mes);
    assert.equal(ticket.tail.swipeId, 1); assert.equal(ticket.characterId, 0);
    assert.ok(Object.isFrozen(ticket)); assert.ok(Object.isFrozen(ticket.tail));
    assert.equal(storyTicketCurrent(f.context, ticket), true);
});

test('saved user-ending brief creates a ticket compatible with existing normal Send tickets', () => {
    const f = fixture(); f.context.chat.pop(); f.click();
    const ticket = f.starts[0];
    assert.equal(ticket.tail, undefined);
    assert.equal(storyTicketCurrent(f.context, ticket), true);
    assert.equal(storyTicketCurrent(f.context, { ...ticket, serial: 7 }), true);
});

for (const [label, mutate] of [
    ['disabled workflow', f => { f.enabled = false; }],
    ['group chat', f => { f.context.groupId = 'group'; }],
    ['numeric group identity', f => { f.context.groupId = 0; }],
    ['missing character', f => { f.context.characterId = undefined; }],
    ['missing chat identity', f => { f.chatId = ''; }],
]) {
    test(`${label} leaves native regeneration untouched`, () => {
        const f = fixture(), event = f.event(); mutate(f);
        assert.equal(f.click(event), false);
        assert.equal(event.prevented, 0); assert.equal(event.stopped, 0);
        assert.deepEqual(f.starts, []); assert.deepEqual(f.blocked, []);
    });
}

test('unrelated targets and absent target leave the native action untouched', () => {
    const f = fixture(), event = f.event(false);
    assert.equal(f.click(event), false); assert.equal(event.prevented, 0);
    assert.equal(f.click({}), false); assert.equal(f.api.handleClick(null), false);
    assert.deepEqual(f.starts, []);
});

for (const [label, mutate] of [
    ['open edit', f => { f.unsaved = true; }],
    ['native generation', f => { f.generating = true; }],
    ['unfinished workflow', f => { f.busy = true; }],
    ['empty chat', f => { f.context.chat.length = 0; }],
    ['blank brief', f => { f.user.mes = ' \n '; }],
    ['blank reply', f => { f.reply.mes = ''; }],
    ['system ending', f => { f.reply.is_system = true; }],
    ['system brief', f => { f.user.is_system = true; }],
    ['missing user brief', f => { f.user.is_user = false; }],
    ['multiple trailing replies', f => { f.context.chat.push({ is_user: false, mes: 'Another reply.' }); }],
    ['invalid ending text', f => { f.reply.mes = null; }],
    ['invalid assistant role', f => { delete f.reply.is_user; }],
]) {
    test(`${label} is blocked without native fallthrough or starting work`, () => {
        const f = fixture(), event = f.event(); mutate(f);
        assert.equal(f.click(event), true);
        assert.equal(event.prevented, 1); assert.equal(event.stopped, 1);
        assert.deepEqual(f.starts, []); assert.equal(f.blocked.length, 1);
        assert.deepEqual(f.errors, []);
    });
}

test('duplicate delivery of one click cannot repeat its callback', () => {
    const f = fixture(), event = f.event(); f.click(event); f.click(event);
    assert.equal(f.starts.length, 1); assert.equal(f.blocked.length, 0);
    assert.equal(event.prevented, 1); assert.equal(event.stopped, 1);
});

test('a second click observes the owner synchronous busy reservation', () => {
    const f = fixture(); f.click(); const second = f.event(); f.click(second);
    assert.equal(f.starts.length, 1); assert.equal(f.blocked.length, 1);
    assert.equal(second.stopped, 1);
});

for (const [label, mutate] of [
    ['chat identity', f => { f.chatId = 'another-chat'; }],
    ['chat array', f => { f.context.chat = [...f.context.chat]; }],
    ['character', f => { f.context.characterId = 1; }],
    ['group', f => { f.context.groupId = 0; }],
    ['brief identity', f => { f.context.chat[1] = { ...f.user }; }],
    ['brief text', f => { f.user.mes += ' A later edit.'; }],
    ['brief swipe', f => { f.user.swipe_id++; }],
    ['brief role', f => { f.user.is_user = false; }],
    ['brief system flag', f => { f.user.is_system = true; }],
    ['reply identity', f => { f.context.chat[2] = { ...f.reply }; }],
    ['reply text', f => { f.reply.mes += ' A later edit.'; }],
    ['reply swipe', f => { f.reply.swipe_id++; }],
    ['reply role', f => { f.reply.is_user = true; }],
    ['reply system flag', f => { f.reply.is_system = true; }],
    ['reply deleted', f => { f.context.chat.pop(); }],
    ['new row appended', f => { f.context.chat.push({ is_user: true, mes: 'A new instruction.' }); }],
]) {
    test(`regeneration ticket becomes stale after changed ${label}`, () => {
        const f = fixture(); f.click(); const ticket = f.starts[0]; mutate(f);
        assert.equal(storyTicketCurrent(f.context, ticket), false);
    });
}

test('normal ticket cannot accept a new assistant or a stale user message', () => {
    const f = fixture(); f.context.chat.pop(); f.click(); const ticket = f.starts[0];
    f.context.chat.push(f.reply); assert.equal(storyTicketCurrent(f.context, ticket), false);
    f.context.chat.pop(); f.user.mes += ' Changed.'; assert.equal(storyTicketCurrent(f.context, ticket), false);
});

test('malformed tickets and unavailable context fail closed', () => {
    const f = fixture(); f.click(); const ticket = f.starts[0];
    for (const invalid of [null, {}, { ...ticket, index: -1 }, { ...ticket, index: '1' }, { ...ticket, tail: null }]) {
        assert.equal(storyTicketCurrent(f.context, invalid), false);
    }
    assert.equal(storyTicketCurrent(null, ticket), false);
    assert.equal(storyTicketCurrent({ ...f.context, getCurrentChatId() { throw new Error('Unavailable'); } }, ticket), false);
});

test('identity change between initial checks and start blocks the request', () => {
    let f, reads = 0;
    f = fixture({ getContext: () => { if (++reads === 2) f.chatId = 'changed-chat'; return f.context; } });
    const event = f.event(); f.click(event);
    assert.equal(event.stopped, 1); assert.deepEqual(f.starts, []); assert.equal(f.blocked.length, 1);
});

for (const callback of ['onStart', 'onBlocked']) {
    for (const asynchronous of [false, true]) {
        test(`${callback} ${asynchronous ? 'rejection' : 'throw'} is handled without native fallthrough`, async () => {
            const failure = new Error('Synthetic callback failure');
            const f = fixture({ [callback]: () => { if (asynchronous) return Promise.reject(failure); throw failure; } });
            if (callback === 'onBlocked') f.busy = true;
            const event = f.event(); assert.equal(f.click(event), true); await settle();
            assert.equal(event.stopped, 1); assert.deepEqual(f.errors, [failure]);
        });
    }
}

for (const asynchronous of [false, true]) {
    test(`error display ${asynchronous ? 'rejection' : 'throw'} cannot escape`, async () => {
        const f = fixture({ onStart() { throw new Error('Start failed'); }, onError() {
            if (asynchronous) return Promise.reject(new Error('Display failed'));
            throw new Error('Display failed');
        } });
        const event = f.event(); assert.equal(f.click(event), true); await settle();
        assert.equal(event.stopped, 1);
    });
}

test('dependency errors suppress the recognized action and report without starting work', async () => {
    const failure = new Error('Synthetic dependency failure');
    for (const dependency of ['isEnabled', 'getContext', 'isBusy', 'isGenerating', 'hasUnsavedEdit']) {
        const f = fixture({ [dependency]: () => { throw failure; } }), event = f.event();
        assert.equal(f.click(event), true); await settle();
        assert.equal(event.stopped, 1); assert.deepEqual(f.starts, []); assert.deepEqual(f.errors, [failure]);
    }
});
