import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { applyWorkflowDefaults, PUBLIC_BUILDER_DEFAULTS, PUBLIC_REVIEW_DEFAULTS } from '../../extensions/StoryBuilder/setup-config.js';
import { normalizeSettings } from '../../extensions/StoryBuilder/builder-core.js';

test('public setup fills only missing own-extension preferences and preserves all existing choices', () => {
    const settings = { unrelated: { retain: true }, StoryBuilder: { writerModel: 'custom/writer', chatWorkflowEnabled: false, spendLimitUsd: .5 },
        StoryReview: { model: 'custom/reviewer', autoReview: true }, connectionManager: { profiles: [{ id: 'custom' }] },
        zTracker: { modules: [{ id: 'my-tracker' }] }, StoryWorkflow: { setupVersion: 3 } };
    const external = JSON.stringify([settings.unrelated, settings.connectionManager, settings.zTracker, settings.StoryWorkflow]);
    assert.equal(applyWorkflowDefaults(settings), true);
    assert.equal(settings.StoryBuilder.writerModel, 'custom/writer');
    assert.equal(settings.StoryBuilder.spendLimitUsd, .5);
    assert.equal(settings.StoryBuilder.chatWorkflowEnabled, false);
    assert.equal(settings.StoryReview.autoReview, true); assert.equal(settings.StoryReview.model, 'custom/reviewer');
    assert.equal(JSON.stringify([settings.unrelated, settings.connectionManager, settings.zTracker, settings.StoryWorkflow]), external);
    const after = structuredClone(settings);
    assert.equal(applyWorkflowDefaults(settings), false); assert.deepEqual(settings, after);
});

test('fresh public installation keeps interception, automatic standalone reviews and external trackers opt-in', () => {
    const settings = {};
    applyWorkflowDefaults(settings);
    assert.deepEqual(settings.StoryBuilder, PUBLIC_BUILDER_DEFAULTS);
    assert.deepEqual(settings.StoryReview, PUBLIC_REVIEW_DEFAULTS);
    assert.equal(settings.StoryBuilder.chatWorkflowEnabled, false);
    assert.equal(settings.StoryBuilder.updateTracker, false);
    assert.equal(settings.StoryReview.autoReview, false);
    assert.deepEqual(Object.keys(settings).sort(), ['StoryBuilder', 'StoryReview']);
});

test('invalid existing own-extension settings are rejected before any defaults are changed', () => {
    const settings = { StoryReview: 'not an object', unrelated: { retain: true } }, before = structuredClone(settings);
    assert.throws(() => applyWorkflowDefaults(settings), /not replaced/);
    assert.deepEqual(settings, before);
});

test('public starter profile survives runtime normalization with its spending and revision limits intact', () => {
    const settings = {};
    applyWorkflowDefaults(settings);
    const actual = normalizeSettings(settings.StoryBuilder);
    for (const [key, value] of Object.entries(PUBLIC_BUILDER_DEFAULTS)) assert.deepEqual(actual[key], value, key);
    assert.equal(actual.spendLimitUsd, 1);
    assert.equal(actual.maxRevisionPassages, 2);
    assert.equal(actual.sectionCount, 4);
    assert.equal(actual.revisionCycles, 1);
    assert.equal(actual.updateTracker, false);
});

test('public setup contains no preset patch, connection/profile setup or local configuration fetch', async () => {
    const builder = await fs.readFile(new URL('../../extensions/StoryBuilder/workflow-setup.js', import.meta.url), 'utf8');
    const review = await fs.readFile(new URL('../../extensions/StoryReview/index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(builder, /fetch\(|aion-workflow\.json|connectionManager/);
    assert.doesNotMatch(review, /setup-patch\.json|savePreset\(|getPresetManager|getChatCompletionPreset|getPresetApplicationPromise/);
    for (const file of ['../../extensions/StoryBuilder/aion-workflow.json', '../../extensions/StoryReview/setup-patch.json']) {
        await assert.rejects(fs.access(new URL(file, import.meta.url)), { code: 'ENOENT' });
    }
});
