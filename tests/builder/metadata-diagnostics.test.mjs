import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSnapshot, metadataChangeLabels } from '../../extensions/StoryBuilder/st-bridge.js';

function fixture() {
    return { chat: [{ is_user: true, mes: 'Synthetic brief.' }], chatMetadata: {}, extensionPrompts: {}, getCurrentChatId: () => 'test' };
}

test('metadata diagnostic names only known application fields and never their contents', () => {
    const context = fixture(), snapshot = makeSnapshot(context);
    context.chatMetadata.note_prompt = 'PRIVATE_STORY_VALUE';
    context.chatMetadata.PRIVATE_CUSTOM_KEY = 'PRIVATE_OTHER_VALUE';
    context.chatMetadata.SECOND_PRIVATE_KEY = { PRIVATE_NESTED_KEY: 'PRIVATE_NESTED_VALUE' };
    context.chatMetadata.timedWorldInfo = { sticky: { PRIVATE_LORE_ENTRY: {} } };
    context.extensionPrompts.PRIVATE_INJECTION_KEY = { value: 'PRIVATE_PROMPT_VALUE' };
    const labels = metadataChangeLabels(context, snapshot);
    assert.deepEqual(labels, ['note_prompt', 'other extension metadata', 'timedWorldInfo', 'prepared extension prompts']);
    assert.ok(!JSON.stringify(labels).includes('PRIVATE'));
});

test('unchanged metadata and reordered keys produce no diagnostic', () => {
    const context = fixture();
    context.chatMetadata.note_depth = 4;
    context.chatMetadata.variables = { a: 1, b: 2 };
    const snapshot = makeSnapshot(context);
    context.chatMetadata = { variables: { b: 2, a: 1 }, note_depth: 4 };
    assert.deepEqual(metadataChangeLabels(context, snapshot), []);
});
