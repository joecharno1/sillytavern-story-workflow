import test from 'node:test';
import assert from 'node:assert/strict';
import { WRITING_ASPECTS, WRITING_PRESETS, normalizePresetLibrary, normalizeWritingStyles, buildWritingGuidance, specialistPasses } from '../../extensions/StoryBuilder/writing-tuning.js';
import { normalizeSettings } from '../../extensions/StoryBuilder/builder-core.js';

const selected = { preset: 'custom', custom: 'Use clipped exchanges with distinct voices.', model: 'fixture/dialogue-editor' };
const settings = overrides => normalizeSettings({ editorialEnabled: true, tuningEnabled: true, writingStyles: { dialogue: selected }, ...overrides });

test('existing settings acquire dormant tuning without changing models or enabling extra work', () => {
    const before = { plannerModel: 'fixture/planner', reviewerModel: 'fixture/reviewer', writerModel: 'fixture/writer', chatWorkflowEnabled: true };
    const value = normalizeSettings(before);
    for (const [key, expected] of Object.entries(before)) assert.equal(value[key], expected);
    assert.equal(value.tuningEnabled, false); assert.equal(value.continuityModel, ''); assert.equal(value.revisionModel, '');
    assert.equal(buildWritingGuidance(value), ''); assert.deepEqual(specialistPasses(value), []);
});

test('each category offers an inherit option and distinct usable built-in preferences', () => {
    assert.deepEqual(WRITING_ASPECTS.map(row => row.id), ['dialogue', 'physical', 'character', 'atmosphere']);
    for (const { id } of WRITING_ASPECTS) {
        assert.equal(WRITING_PRESETS[id][0].id, 'inherit');
        assert.equal(new Set(WRITING_PRESETS[id].map(row => row.id)).size, WRITING_PRESETS[id].length);
        for (const preset of WRITING_PRESETS[id].slice(1)) {
            const value = settings({ writingStyles: { [id]: { preset: preset.id } } });
            assert.ok(buildWritingGuidance(value).includes(preset.instruction));
            assert.deepEqual(specialistPasses(value), []);
        }
    }
});

test('custom guidance is preserved exactly and only selected library text reaches instructions', () => {
    const text = 'Keep the chosen wording.\n  Preserve intentional spacing and {{literal}} markers.';
    const value = settings({ writingStyles: { dialogue: { preset: 'custom-chosen' } }, writingPresetLibrary: {
        dialogue: [{ id: 'custom-chosen', name: 'My dialogue', text }, { id: 'custom-dormant', name: 'PRIVATE_UNUSED_NAME', text: 'PRIVATE_UNUSED_PRESET' }],
        atmosphere: [{ id: 'custom-unselected', name: 'Unused atmosphere', text: 'PRIVATE_ATMOSPHERE' }],
    } });
    const guidance = buildWritingGuidance(value);
    assert.ok(guidance.includes(text)); assert.doesNotMatch(guidance, /PRIVATE_|custom-chosen|My dialogue/);
    assert.match(guidance, /explicit brief.*take priority/);
    assert.deepEqual(specialistPasses(value), []);
});

test('disabling tuning retains preferences while excluding all custom guidance and specialists', () => {
    const value = settings({ tuningEnabled: false });
    assert.deepEqual(value.writingStyles.dialogue, selected);
    assert.equal(buildWritingGuidance(value), ''); assert.deepEqual(specialistPasses(value), []);
    assert.equal(normalizeSettings({ ...value, tuningEnabled: true }).writingStyles.dialogue.custom, selected.custom);
});

test('separate settings snapshots cannot mutate each other or frozen defaults', () => {
    const a = normalizeSettings(), b = normalizeSettings();
    a.writingStyles.dialogue.custom = 'Only in one snapshot';
    a.writingPresetLibrary.dialogue.push({ id: 'custom-one', name: 'One', text: 'One preference.' });
    assert.equal(b.writingStyles.dialogue.custom, ''); assert.equal(b.writingPresetLibrary.dialogue.length, 0);
    assert.equal(normalizeSettings().writingStyles.dialogue.custom, '');
});

test('specialist models are opt-in, category-scoped, and receive selected instructions only', () => {
    const value = settings({ writingStyles: { dialogue: selected, physical: { model: 'fixture/physical' } } });
    const passes = specialistPasses(value);
    assert.equal(passes.length, 2);
    assert.deepEqual(Object.keys(passes[0]).sort(), ['id', 'instruction', 'label', 'model']);
    assert.equal(passes[0].model, selected.model); assert.equal(passes[0].instruction, selected.custom);
    assert.equal(passes[1].model, 'fixture/physical'); assert.match(passes[1].instruction, /brief/);
    assert.deepEqual(specialistPasses(settings({ writingStyles: { dialogue: { ...selected, model: '' } } })), []);
});

test('specialist settings require editorial checks only when tuning is enabled', () => {
    assert.throws(() => settings({ editorialEnabled: false }), /Enable story reviews/);
    assert.doesNotThrow(() => settings({ editorialEnabled: false, tuningEnabled: false }));
    assert.doesNotThrow(() => settings({ editorialEnabled: false, writingStyles: { dialogue: { ...selected, model: '' } } }));
});

test('invalid models and oversized instructions are rejected before requests', () => {
    for (const model of ['bad model', '../bad?model', 'a'.repeat(121), 123, null]) {
        if (model === null) continue; // Missing optional fields use defaults.
        assert.throws(() => normalizeWritingStyles({ dialogue: { model } }), /model ID/);
    }
    for (const key of ['continuityModel', 'revisionModel']) {
        assert.equal(normalizeSettings({ [key]: ' fixture/override ' })[key], 'fixture/override');
        assert.throws(() => normalizeSettings({ [key]: 1 }), /model ID/);
        assert.throws(() => normalizeSettings({ [key]: 'bad model' }), /model ID/);
    }
    assert.throws(() => settings({ writingStyles: { dialogue: { custom: 'x'.repeat(8001) } } }), /8,000/);
    assert.throws(() => settings({ writingStyles: { dialogue: { preset: 'missing' } } }), /available writing preset/);
    assert.throws(() => normalizeSettings({ tuningEnabled: 'true' }), /on or off/);
});

test('custom preset libraries enforce names, text, unique IDs, and bounded storage', () => {
    const good = { id: 'custom-one', name: ' One ', text: 'Keep this exactly.\n' };
    assert.deepEqual(normalizePresetLibrary({ dialogue: [good] }).dialogue, [{ ...good, name: 'One' }]);
    for (const rows of [[good, good], [{ ...good, id: 'inherit' }], [{ ...good, name: '' }], [{ ...good, name: 'x'.repeat(81) }],
        [{ ...good, text: '' }], [{ ...good, text: 'x'.repeat(8001) }], Array.from({ length: 21 }, (_, i) => ({ ...good, id: `custom-${i}` }))]) {
        assert.throws(() => normalizePresetLibrary({ dialogue: rows }), /custom preset|writing preset/);
    }
    assert.throws(() => normalizePresetLibrary([]), /library/);
    assert.throws(() => normalizeWritingStyles([]), /preferences/);
});

test('all four maximum-size selected notes stay inside editorial guidance bounds', () => {
    const value = settings({ writingStyles: Object.fromEntries(WRITING_ASPECTS.map(({ id }) => [id, { preset: 'custom', custom: 'x'.repeat(8000) }])) });
    assert.ok(buildWritingGuidance(value).length < 40000);
});
