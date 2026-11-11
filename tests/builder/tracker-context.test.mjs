import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTrackerContext } from '../../extensions/StoryBuilder/tracker-context.js';

const original = () => [{ is_user: false, mes: 'Earlier accepted story.', extra: { synthetic: 'saved facts' } }, { is_user: true, mes: 'Continue the journey.' }];
const note = () => ({ role: 'user', content: 'Saved scene: west gate.', mes: 'Saved scene: west gate.', is_user: true, is_system: false });

test('collects snapshots across repeated vendor clones without changing or copying original turns', async () => {
    const chat = original(), before = structuredClone(chat);
    const rows = await collectTrackerContext({ chat, interceptor(copy) {
        let updated = structuredClone(copy); updated.splice(1, 0, note());
        updated = structuredClone(updated); updated.splice(2, 0, { role: 'user', content: 'Saved plot: ledger delivery pending.' });
        copy.splice(0, copy.length, ...updated);
    } });
    assert.deepEqual(rows, [{ role: 'user', content: note().content }, { role: 'user', content: 'Saved plot: ledger delivery pending.' }]);
    assert.deepEqual(chat, before);
});

test('first story and missing hook produce no invented notes', async () => {
    assert.deepEqual(await collectTrackerContext({ chat: original() }), []);
    assert.deepEqual(await collectTrackerContext({ chat: original(), interceptor() {} }), []);
    assert.deepEqual(await collectTrackerContext({ chat: [], interceptor() { throw Error('should not run'); } }), []);
});

for (const [name, change] of [
    ['removed original', rows => rows.pop()],
    ['reordered originals', rows => rows.reverse()],
    ['duplicated original', rows => rows.push(structuredClone(rows[0]))],
    ['changed prose', rows => { rows[0].mes = 'Rewritten story'; }],
    ['changed role', rows => { rows[0].is_user = true; }],
    ['unsupported role', rows => rows.push({ role: 'tool', content: 'Not a snapshot' })],
    ['tool call', rows => rows.push({ ...note(), tool_calls: [] })],
    ['ambiguous content', rows => rows.push({ ...note(), mes: 'Different text' })],
    ['empty note', rows => rows.push({ role: 'user', content: '' })],
]) test(`rejects ${name} without exposing source text`, async () => {
    const chat = original(), before = structuredClone(chat);
    await assert.rejects(collectTrackerContext({ chat, interceptor: change }), error => {
        assert.ok(!error.message.includes('Earlier accepted story')); return /Tracker context/.test(error.message);
    });
    assert.deepEqual(chat, before);
});

test('pause before or during collection prevents notes being used', async () => {
    const before = new AbortController(); before.abort();
    await assert.rejects(collectTrackerContext({ chat: original(), signal: before.signal }), { name: 'AbortError' });
    const during = new AbortController();
    await assert.rejects(collectTrackerContext({ chat: original(), signal: during.signal, async interceptor(rows) {
        rows.push(note()); await Promise.resolve(); during.abort();
    } }), { name: 'AbortError' });
});

test('vendor error is sanitized and never silently loses continuity', async () => {
    await assert.rejects(collectTrackerContext({ chat: original(), interceptor() { throw Error('Private fixture text'); } }), error => {
        assert.ok(!error.message.includes('Private fixture')); return /tracker hook failed/.test(error.message);
    });
});
