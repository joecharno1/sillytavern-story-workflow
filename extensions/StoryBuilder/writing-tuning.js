/** Local writing preferences. Only selected instructions belong in model requests. */
const MODEL = /^[a-zA-Z0-9_.:/-]{1,120}$/;
const CUSTOM_ID = /^custom-[A-Za-z0-9_-]{1,60}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const freeze = rows => Object.freeze(rows.map(row => Object.freeze(row)));

export const WRITING_ASPECTS = freeze([
    { id: 'dialogue', label: 'Dialogue', description: 'Speech, voice, exchanges, and subtext.' },
    { id: 'physical', label: 'Physical and anatomical detail', description: 'Movement, posture, physical traits, and spatial coherence.' },
    { id: 'character', label: 'Character description', description: 'Appearance, behavior, interiority, and individual mannerisms.' },
    { id: 'atmosphere', label: 'Atmosphere and setting', description: 'Environment, sensory details, mood, and descriptive rhythm.' },
]);
const inherit = { id: 'inherit', label: 'Follow my prompt and preset', instruction: '' };
export const WRITING_PRESETS = Object.freeze({
    dialogue: freeze([inherit,
        { id: 'natural', label: 'Natural conversation', instruction: 'Use character-specific speech with varied sentence lengths, believable pauses, and direct responses to what was just said. Let dialogue change the situation rather than recap known facts.' },
        { id: 'subtext', label: 'Subtext and tension', instruction: 'Let desires, hesitation, and disagreements appear through word choice, omissions, and responses. Preserve distinct voices; do not make every exchange cryptic or explain every implication.' },
        { id: 'concise', label: 'Concise exchanges', instruction: 'Prefer purposeful, concise exchanges. Let gestures and immediate consequences carry what speakers need not say, without skipping required conversations or exchanges in the brief.' },
    ]),
    physical: freeze([inherit,
        { id: 'precise', label: 'Precise and grounded', instruction: 'Keep anatomy, posture, balance, reach, and movement physically coherent. Use precise terms where they help the reader follow the action. Preserve established physical traits and track changes in position.' },
        { id: 'kinetic', label: 'Movement and action', instruction: 'Describe movement through clear causes and effects: weight shifts, contact, resistance, effort, and consequences. Keep bodies and objects consistently located, with no impossible transitions.' },
        { id: 'sensory', label: 'Close sensory detail', instruction: 'Use concrete sensations such as pressure, texture, temperature, breath, and muscular effort where relevant to the viewpoint. Anchor detail in observable movement and established physical facts.' },
    ]),
    character: freeze([inherit,
        { id: 'observed', label: 'Observable detail', instruction: 'Reveal character through a few specific visual details, expressions, posture, habits, and reactions. Preserve established appearance and avoid repeatedly cataloguing the same features.' },
        { id: 'interior', label: 'Interior and reflective', instruction: 'Connect description to the viewpoint character’s perceptions, motives, memories, and uncertainty. Keep knowledge within the chosen viewpoint and preserve the brief’s permissions over character thoughts.' },
        { id: 'behavior', label: 'Character through action', instruction: 'Let choices, gestures, speech, and reactions reveal personality. Use recurring mannerisms selectively and allow the unfolding situation to change how familiar traits appear.' },
    ]),
    atmosphere: freeze([inherit,
        { id: 'grounded', label: 'Grounded sensory setting', instruction: 'Establish the environment through concrete light, sound, texture, temperature, and spatial details relevant to the scene. Keep setting details consistent and integrate them with character action.' },
        { id: 'cinematic', label: 'Cinematic and spatial', instruction: 'Give the reader a clear sense of distance, orientation, light, and motion. Shift descriptive focus with the action while preserving viewpoint and physical geography; do not write camera directions.' },
        { id: 'lyrical', label: 'Lyrical atmosphere', instruction: 'Use deliberate rhythm, selective imagery, and varied sensory associations to shape mood. Keep metaphors grounded in the viewpoint and avoid repeating images or obscuring physical events.' },
    ]),
});

export const DEFAULT_WRITING_STYLES = Object.freeze(Object.fromEntries(WRITING_ASPECTS.map(({ id }) =>
    [id, Object.freeze({ preset: 'inherit', custom: '', model: '' })])));
export const DEFAULT_PRESET_LIBRARY = Object.freeze(Object.fromEntries(WRITING_ASPECTS.map(({ id }) => [id, Object.freeze([])])));

export function normalizePresetLibrary(input = {}) {
    if (!record(input)) throw new Error('The custom writing preset library must be an object.');
    const result = {};
    for (const { id } of WRITING_ASPECTS) {
        const rows = input[id] ?? [];
        if (!Array.isArray(rows) || rows.length > 20) throw new Error('Keep at most 20 custom presets in each writing category.');
        const ids = new Set();
        result[id] = rows.map(row => {
            if (!record(row) || typeof row.id !== 'string' || !CUSTOM_ID.test(row.id) || ids.has(row.id)
                || typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 80
                || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 8000) {
                throw new Error('A custom writing preset needs a unique ID, a name of up to 80 characters, and instructions of up to 8,000 characters.');
            }
            ids.add(row.id);
            return { id: row.id, name: row.name.trim(), text: row.text };
        });
    }
    return result;
}

export function normalizeWritingStyles(input = {}, library = {}) {
    if (!record(input)) throw new Error('Writing preferences must be an object.');
    const saved = normalizePresetLibrary(library), result = {};
    for (const { id } of WRITING_ASPECTS) {
        const row = input[id] ?? DEFAULT_WRITING_STYLES[id];
        if (!record(row)) throw new Error('Each writing category needs valid preferences.');
        const preset = row.preset ?? 'inherit', custom = row.custom ?? '', model = row.model ?? '';
        if (typeof preset !== 'string' || ![...WRITING_PRESETS[id].map(value => value.id), 'custom', ...saved[id].map(value => value.id)].includes(preset)) {
            throw new Error('Choose an available writing preset in each category.');
        }
        if (typeof custom !== 'string' || custom.length > 8000) throw new Error('Custom writing instructions must be text of up to 8,000 characters.');
        if (typeof model !== 'string' || (model.trim() && !MODEL.test(model.trim()))) throw new Error('Enter a valid OpenRouter specialist model ID, or leave it blank.');
        result[id] = { preset, custom, model: model.trim() };
    }
    return result;
}

function selectedStyles(settings) {
    const library = normalizePresetLibrary(settings.writingPresetLibrary);
    const styles = normalizeWritingStyles(settings.writingStyles, library);
    return WRITING_ASPECTS.map(aspect => {
        const selected = styles[aspect.id];
        const instruction = selected.preset === 'custom' ? selected.custom
            : WRITING_PRESETS[aspect.id].find(row => row.id === selected.preset)?.instruction
                ?? library[aspect.id].find(row => row.id === selected.preset)?.text ?? '';
        return { ...aspect, instruction, model: selected.model };
    });
}

export function buildWritingGuidance(settings = {}) {
    if (settings.tuningEnabled !== true) return '';
    const selected = selectedStyles(settings).filter(row => row.instruction.trim());
    if (!selected.length) return '';
    return 'Optional writing preferences follow. Apply them where relevant, without adding events or padding the story. The author’s explicit brief, established canon, viewpoint, and required output format take priority if a preference conflicts. These preferences guide style; they are not new story facts.\n\n'
        + selected.map(row => `${row.label}:\n${row.instruction}`).join('\n\n');
}

export function specialistPasses(settings = {}) {
    if (settings.tuningEnabled !== true) return [];
    return selectedStyles(settings).filter(row => row.model).map(({ id, label, instruction, model }) => ({
        id, label, model, instruction: instruction.trim() ? instruction
            : `Review ${label.toLowerCase()} for concrete improvements consistent with the author's brief, viewpoint, established facts, and existing writing preset. Preserve the story's events and voice.`,
    }));
}
