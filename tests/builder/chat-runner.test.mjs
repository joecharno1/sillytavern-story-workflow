import test from 'node:test';
import assert from 'node:assert/strict';
import { runChatWorkflow } from '../../extensions/StoryBuilder/chat-runner.js';

function fixture(initial = {}) {
    const state = { hasJob: false, hasPlan: false, writingComplete: false, editorialReady: false,
        applied: false, memoryRequired: true, memoryComplete: false, sourceCurrent: false, canTrack: false, ...initial };
    const calls = [], stages = [], controller = new AbortController();
    const actions = {
        getState: () => ({ ...state }),
        prepare: async () => { calls.push('prepare'); Object.assign(state, { hasJob: true, hasPlan: true, sourceCurrent: true }); },
        generate: async () => { calls.push('generate'); Object.assign(state, { writingComplete: true, editorialReady: true }); },
        apply: async () => { calls.push('apply'); Object.assign(state, { applied: true, sourceCurrent: false, canTrack: true }); },
        updateMemory: async () => { calls.push('updateMemory'); state.memoryComplete = true; },
        onStage: stage => { stages.push(stage); },
    };
    return { state, actions, calls, stages, controller, run: () => runChatWorkflow(actions, { signal: controller.signal }) };
}

test('complete workflow runs each stage exactly once and publication changes the source safely', async () => {
    const f = fixture();
    assert.deepEqual(await f.run(), { status: 'complete', stage: 'complete' });
    assert.deepEqual(f.calls, ['prepare', 'generate', 'apply', 'updateMemory']);
    assert.deepEqual(f.stages, ['planning', 'writing', 'applying', 'tracking']);
    assert.equal(f.state.sourceCurrent, false);
    assert.deepEqual(await f.run(), { status: 'complete', stage: 'complete' });
    assert.equal(f.calls.length, 4);
});

test('planning is retried even when a job exists without a completed plan', async () => {
    const f = fixture({ hasJob: true });
    assert.equal((await f.run()).status, 'complete');
    assert.equal(f.calls[0], 'prepare');
});

for (const action of ['prepare', 'generate']) {
    test(`an unfinished ${action} preserves the specific model error and remains resumable`, async () => {
        const f = fixture(), original = f.actions[action];
        const message = 'The model returned no story text. Completed sections are preserved.';
        f.actions[action] = async () => { f.state.error = message; };
        assert.equal((await f.run()).error, message);
        assert.ok(!f.calls.includes('apply'));
        f.actions[action] = async () => { f.state.error = ''; await original(); };
        assert.equal((await f.run()).status, 'complete');
        assert.equal(f.calls.filter(name => name === 'apply').length, 1);
    });
}

test('a ready draft bypasses planning and writing', async () => {
    const f = fixture({ hasJob: true, hasPlan: true, sourceCurrent: true, writingComplete: true, editorialReady: true });
    assert.equal((await f.run()).status, 'complete');
    assert.deepEqual(f.calls, ['apply', 'updateMemory']);
});

test('finished writing with unfinished editorial work resumes generation/review only', async () => {
    const f = fixture({ hasJob: true, hasPlan: true, sourceCurrent: true, writingComplete: true });
    assert.equal((await f.run()).status, 'complete');
    assert.deepEqual(f.calls, ['generate', 'apply', 'updateMemory']);
});

test('applied entry bypasses all source checks and retries only tracking', async () => {
    const f = fixture({ applied: true, sourceCurrent: false, canTrack: true });
    f.actions.prepare = f.actions.generate = f.actions.apply = async () => { throw new Error('Must not repeat publication work.'); };
    assert.equal((await f.run()).status, 'complete');
    assert.deepEqual(f.calls, ['updateMemory']);
});

test('memory-disabled and previously tracked stories need no tracker request', async () => {
    for (const initial of [{ memoryRequired: false }, { applied: true, memoryComplete: true }]) {
        const f = fixture(initial);
        assert.equal((await f.run()).status, 'complete');
        assert.ok(!f.calls.includes('updateMemory'));
    }
});

for (const [action, stage, previous] of [
    ['prepare', 'planning', []], ['generate', 'writing', ['prepare']],
    ['apply', 'applying', ['prepare', 'generate']], ['updateMemory', 'tracking', ['prepare', 'generate', 'apply']],
]) {
    test(`a resolved but unfinished ${stage} action cannot advance`, async () => {
        const f = fixture(); f.actions[action] = async () => { f.calls.push(action); };
        const outcome = await f.run();
        assert.equal(outcome.status, 'needs_attention'); assert.equal(outcome.stage, stage);
        assert.equal(typeof outcome.error, 'string');
        assert.deepEqual(f.calls, [...previous, action]);
    });
    test(`a throwing ${stage} action stops the chain with its error`, async () => {
        const f = fixture(); f.actions[action] = async () => { f.calls.push(action); throw new Error('Synthetic stage failure'); };
        const outcome = await f.run();
        assert.deepEqual(outcome, { status: 'needs_attention', stage, error: 'Synthetic stage failure' });
        assert.deepEqual(f.calls, [...previous, action]);
    });
    test(`pause before ${stage} prevents the action`, async () => {
        const f = fixture(); f.actions.onStage = async value => { if (value === stage) f.controller.abort(); };
        assert.deepEqual(await f.run(), { status: 'paused', stage });
        assert.deepEqual(f.calls, previous);
    });
    test(`pause after ${stage} preserves effects and never starts the following action`, async () => {
        const f = fixture(); const original = f.actions[action];
        f.actions[action] = async () => { await original(); f.controller.abort(); };
        assert.deepEqual(await f.run(), { status: 'paused', stage });
        assert.deepEqual(f.calls, [...previous, action]);
        const continued = await runChatWorkflow(f.actions);
        assert.equal(continued.status, 'complete');
        assert.equal(f.calls.filter(name => name === action).length, 1);
    });
}

test('already aborted invocation makes no state reads or actions', async () => {
    const f = fixture(); f.controller.abort();
    f.actions.getState = () => { throw new Error('Must not read after cancellation.'); };
    assert.deepEqual(await f.run(), { status: 'paused', stage: 'starting' });
    assert.deepEqual(f.calls, []);
});

test('abort during an asynchronous state read stops before the next action', async () => {
    const f = fixture();
    f.actions.getState = async () => { f.controller.abort(); return { ...f.state }; };
    assert.deepEqual(await f.run(), { status: 'paused', stage: 'starting' });
    assert.deepEqual(f.calls, []);
});

test('AbortError from an action is reported as paused without an externally aborted signal', async () => {
    const f = fixture(); f.actions.prepare = async () => { throw new DOMException('Stopped', 'AbortError'); };
    assert.deepEqual(await f.run(), { status: 'paused', stage: 'planning' });
});

test('source becoming stale after planning or writing never reaches publication', async () => {
    for (const action of ['prepare', 'generate']) {
        const f = fixture(), original = f.actions[action];
        f.actions[action] = async () => { await original(); f.state.sourceCurrent = false; };
        const result = await f.run();
        assert.equal(result.status, 'needs_attention'); assert.match(result.error, /source changed/i);
        assert.ok(!f.calls.includes('apply')); assert.ok(!f.calls.includes('updateMemory'));
    }
});

test('source change inside an asynchronous stage notification is checked before applying', async () => {
    const f = fixture();
    f.actions.onStage = async stage => { if (stage === 'applying') f.state.sourceCurrent = false; };
    const result = await f.run();
    assert.equal(result.status, 'needs_attention'); assert.equal(result.stage, 'applying');
    assert.deepEqual(f.calls, ['prepare', 'generate']);
});

test('target change during tracker-stage notification prevents tracker requests', async () => {
    const f = fixture({ applied: true, canTrack: true });
    f.actions.onStage = async () => { f.state.canTrack = false; };
    const result = await f.run();
    assert.equal(result.status, 'needs_attention'); assert.equal(result.stage, 'tracking');
    assert.deepEqual(f.calls, []);
});

test('completed work observed after a stage notification is not repeated', async () => {
    const f = fixture({ hasJob: true, hasPlan: true, sourceCurrent: true, writingComplete: true, editorialReady: true });
    f.actions.onStage = async stage => {
        if (stage === 'applying') Object.assign(f.state, { applied: true, sourceCurrent: false, canTrack: true });
    };
    assert.equal((await f.run()).status, 'complete');
    assert.deepEqual(f.calls, ['updateMemory']);
});

test('publication success followed by tracker failure retries without duplicate application', async () => {
    const f = fixture();
    f.actions.updateMemory = async () => { f.calls.push('updateMemory'); };
    assert.equal((await f.run()).status, 'needs_attention');
    assert.equal(f.state.applied, true);
    f.actions.updateMemory = async () => { f.calls.push('updateMemory'); f.state.memoryComplete = true; };
    assert.equal((await f.run()).status, 'complete');
    assert.deepEqual(f.calls, ['prepare', 'generate', 'apply', 'updateMemory', 'updateMemory']);
});

test('untrackable accepted story is preserved without regenerating or republishing', async () => {
    const f = fixture({ applied: true, canTrack: false });
    const result = await f.run();
    assert.equal(result.status, 'needs_attention'); assert.equal(result.stage, 'tracking');
    assert.equal(f.state.applied, true); assert.deepEqual(f.calls, []);
});

test('state and stage callback errors are returned without advancing', async () => {
    const f = fixture();
    f.actions.onStage = () => { throw new Error('Synthetic UI callback failure'); };
    assert.deepEqual(await f.run(), { status: 'needs_attention', stage: 'planning', error: 'Synthetic UI callback failure' });
    assert.deepEqual(f.calls, []);
    f.actions.getState = async () => null;
    assert.equal((await f.run()).status, 'needs_attention');
});
