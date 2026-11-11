import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcceptedTarget, refreshAcceptedTrackers } from '../../extensions/StoryBuilder/tracker-bridge.js';

function fixture() {
    const text = 'The finished story ends at dawn.';
    const message = { mes: text, is_user: false, is_system: false, swipe_id: 1 };
    const calls = [], events = [];
    const context = {
        chat: [{ mes: 'Author brief.', is_user: true }, message], getCurrentChatId: () => 'synthetic-chat',
        eventSource: { emit: (...args) => events.push(args) },
        executeSlashCommandsWithOptions: async (command, options) => { calls.push({ command, options }); return { pipe: 'true' }; },
    };
    const applied = { index: 1, swipeId: 1, saveRequested: true, rendered: true };
    const target = createAcceptedTarget(context, applied, text);
    return { text, message, context, applied, target, calls, events };
}

test('accepted target captures exact immutable identity and reuses completion state', () => {
    const f = fixture();
    assert.equal(f.target.chat, f.context.chat);
    assert.equal(f.target.message, f.message);
    assert.equal(f.target.text, f.text);
    assert.equal(f.target.index, 1);
    assert.equal(f.target.swipeId, 1);
    assert.ok(Object.isFrozen(f.target));
    assert.equal(f.target.status, 'pending');
    f.target.completedModules.add('scene-tracker');
    assert.equal(createAcceptedTarget(f.context, f.applied, f.text), f.target);
    assert.deepEqual([...f.target.completedModules], ['scene-tracker']);
});

for (const [label, mutate] of [
    ['not saved', f => { f.applied.saveRequested = false; }],
    ['not rendered in current chat', f => { f.applied.rendered = false; }],
    ['wrong text', f => { f.message.mes += ' A later edit.'; }],
    ['wrong swipe', f => { f.message.swipe_id = 0; }],
    ['user message', f => { f.message.is_user = true; }],
    ['system message', f => { f.message.is_system = true; }],
    ['not last message', f => { f.context.chat.push({ mes: 'Continue.', is_user: true }); }],
    ['missing chat identity', f => { f.context.getCurrentChatId = () => undefined; }],
]) {
    test(`target capture refuses ${label}`, () => {
        const f = fixture(); mutate(f);
        assert.throws(() => createAcceptedTarget(f.context, f.applied, f.text));
        assert.equal(f.calls.length, 0);
    });
}

test('refresh runs scene then plot, emits no generic events, and is idempotent', async () => {
    const f = fixture(), progress = [];
    const result = await refreshAcceptedTrackers(f.target, { getContext: () => f.context, onProgress: data => progress.push(data) });
    assert.deepEqual(f.calls, [
        { command: '/ztracker-generate module=scene-tracker 1', options: { showOutput: false, handleExecutionErrors: true } },
        { command: '/ztracker-generate module=plot-log 1', options: { showOutput: false, handleExecutionErrors: true } },
    ]);
    assert.deepEqual(result, { complete: true, completedModules: ['scene-tracker', 'plot-log'] });
    assert.equal(f.target.status, 'complete');
    assert.deepEqual(progress.map(item => [item.stage, item.moduleId]), [
        ['starting', 'scene-tracker'], ['completed', 'scene-tracker'], ['starting', 'plot-log'], ['completed', 'plot-log'],
    ]);
    await refreshAcceptedTrackers(f.target, { getContext: () => f.context });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.events, []);
    assert.equal(f.message.mes, f.text);
});

for (const [label, result] of [
    ['false pipe', { pipe: 'false' }], ['empty result', null], ['missing pipe', {}],
    ['execution error', { pipe: 'true', isError: true, errorMessage: 'Synthetic error' }],
    ['aborted command', { pipe: 'true', isAborted: true }],
]) {
    test(`${label} preserves prior success and retries only unfinished module`, async () => {
        const f = fixture();
        f.context.executeSlashCommandsWithOptions = async (command) => {
            f.calls.push(command);
            return command.includes('plot-log') ? result : { pipe: 'true' };
        };
        await assert.rejects(refreshAcceptedTrackers(f.target, { getContext: () => f.context }), /plot-log/);
        assert.equal(f.target.status, 'failed');
        assert.deepEqual([...f.target.completedModules], ['scene-tracker']);
        f.context.executeSlashCommandsWithOptions = async command => { f.calls.push(command); return { pipe: 'true' }; };
        await refreshAcceptedTrackers(f.target, { getContext: () => f.context });
        assert.deepEqual(f.calls, [
            '/ztracker-generate module=scene-tracker 1', '/ztracker-generate module=plot-log 1', '/ztracker-generate module=plot-log 1',
        ]);
    });
}

test('thrown command error releases the lock without recording success or exposing provider text', async () => {
    const f = fixture();
    f.context.executeSlashCommandsWithOptions = async () => { throw new Error('PRIVATE_PROVIDER_ECHO'); };
    await assert.rejects(refreshAcceptedTrackers(f.target, { getContext: () => f.context }), error => {
        assert.match(error.message, /scene-tracker/); assert.doesNotMatch(error.message, /PRIVATE/); return true;
    });
    assert.equal(f.target.completedModules.size, 0);
    f.context.executeSlashCommandsWithOptions = async () => ({ pipe: 'true' });
    assert.equal((await refreshAcceptedTrackers(f.target, { getContext: () => f.context })).complete, true);
});

for (const [label, mutate] of [
    ['edited prose', f => { f.message.mes += ' An edit.'; }],
    ['swipe change', f => { f.message.swipe_id = 0; }],
    ['chat switch', f => { f.context.getCurrentChatId = () => 'other-chat'; }],
    ['chat replacement', f => { f.context.chat = [...f.context.chat]; }],
    ['message replacement', f => { f.context.chat[1] = { ...f.message }; }],
    ['new message', f => { f.context.chat.push({ mes: 'Continue.', is_user: true }); }],
]) {
    test(`${label} before refresh prevents all requests`, async () => {
        const f = fixture(); mutate(f);
        await assert.rejects(refreshAcceptedTrackers(f.target, { getContext: () => f.context }), /changed/);
        assert.equal(f.calls.length, 0);
    });
    test(`${label} during a request prevents success attribution and the next module`, async () => {
        const f = fixture();
        f.context.executeSlashCommandsWithOptions = async command => { f.calls.push(command); mutate(f); return { pipe: 'true' }; };
        await assert.rejects(refreshAcceptedTrackers(f.target, { getContext: () => f.context }), /changed/);
        assert.equal(f.calls.length, 1);
        assert.equal(f.target.completedModules.size, 0);
    });
}

test('progress-triggered edit is checked again before requesting a tracker', async () => {
    const f = fixture();
    await assert.rejects(refreshAcceptedTrackers(f.target, {
        getContext: () => f.context, onProgress: () => { f.message.mes = 'Changed.'; },
    }), /changed/);
    assert.equal(f.calls.length, 0);
});

test('already cancelled refresh has no side effects', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await assert.rejects(refreshAcceptedTrackers(f.target, { getContext: () => f.context, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.calls.length, 0);
});

test('cancelling an in-flight refresh waits, retains confirmed success, and skips the next module', async () => {
    const f = fixture(), controller = new AbortController();
    f.context.executeSlashCommandsWithOptions = async command => {
        f.calls.push(command); controller.abort(); return { pipe: 'true' };
    };
    await assert.rejects(refreshAcceptedTrackers(f.target, { getContext: () => f.context, signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual([...f.target.completedModules], ['scene-tracker']);
    assert.equal(f.target.status, 'paused');
    assert.equal(f.calls.length, 1);
    f.context.executeSlashCommandsWithOptions = async command => { f.calls.push(command); return { pipe: 'true' }; };
    await refreshAcceptedTrackers(f.target, { getContext: () => f.context });
    assert.equal(f.calls[1], '/ztracker-generate module=plot-log 1');
});

test('concurrent refreshes cannot trigger zTracker cancellation or duplicate generation', async () => {
    const f = fixture();
    let resolveFirst;
    const firstCall = new Promise(resolve => { resolveFirst = resolve; });
    f.context.executeSlashCommandsWithOptions = async command => {
        f.calls.push(command);
        return f.calls.length === 1 ? firstCall : { pipe: 'true' };
    };
    const running = refreshAcceptedTrackers(f.target, { getContext: () => f.context });
    await assert.rejects(refreshAcceptedTrackers(f.target, { getContext: () => f.context }), /already running/);
    const other = fixture();
    await assert.rejects(refreshAcceptedTrackers(other.target, { getContext: () => other.context }), /already running/);
    assert.equal(other.calls.length, 0);
    resolveFirst({ pipe: 'true' });
    await running;
    assert.equal(f.calls.length, 2);
});

test('missing command API rejects without recording completion', async () => {
    const f = fixture(); delete f.context.executeSlashCommandsWithOptions;
    await assert.rejects(refreshAcceptedTrackers(f.target, { getContext: () => f.context }), /unavailable/);
    assert.equal(f.target.completedModules.size, 0);
});

test('cancel event targets only the in-flight chat/message/module and is removed afterward', async () => {
    const f = fixture(), controller = new AbortController(), cancelled = [];
    f.context.executeSlashCommandsWithOptions = async command => {
        f.calls.push(command);
        if (command.includes('plot-log')) controller.abort();
        return { pipe: command.includes('plot-log') ? 'false' : 'true' };
    };
    await assert.rejects(refreshAcceptedTrackers(f.target, {
        getContext: () => f.context, signal: controller.signal, dispatchCancel: detail => cancelled.push(detail),
    }), { name: 'AbortError' });
    assert.deepEqual(cancelled, [{ messageId: 1, moduleId: 'plot-log', chatId: 'synthetic-chat' }]);
    assert.deepEqual([...f.target.completedModules], ['scene-tracker']);
    assert.equal(f.target.status, 'paused');

    const completed = fixture(), later = new AbortController(), lateEvents = [];
    await refreshAcceptedTrackers(completed.target, {
        getContext: () => completed.context, signal: later.signal, dispatchCancel: detail => lateEvents.push(detail),
    });
    later.abort();
    assert.deepEqual(lateEvents, []);
});
