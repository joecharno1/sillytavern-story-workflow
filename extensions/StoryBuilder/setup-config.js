/** Public defaults only. Never reads or changes presets, profiles, trackers, or chats. */
export const PUBLIC_BUILDER_DEFAULTS = Object.freeze({
    writerModel: 'aion-labs/aion-3.5', plannerModel: 'aion-labs/aion-3.5-mini', reviewerModel: 'aion-labs/aion-3.5-mini',
    wordMin: 10000, wordMax: 12000, paragraphMin: 120, paragraphMax: 160, strictParagraphs: false,
    sectionCount: 4, maxRetries: 1, editorialEnabled: true, continuityEnabled: true,
    revisionCycles: 1, maxRevisionPassages: 2, spendLimitUsd: 1,
    chatWorkflowEnabled: false, updateTracker: false,
});
export const PUBLIC_REVIEW_DEFAULTS = Object.freeze({
    model: 'aion-labs/aion-3.5-mini', enabled: true, autoReview: false,
    wordMin: 10000, wordMax: 12000, paragraphMin: 120, paragraphMax: 160,
});

export function applyWorkflowDefaults(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('Extension settings are required.');
    for (const key of ['StoryBuilder', 'StoryReview']) {
        if (settings[key] !== undefined && (!settings[key] || typeof settings[key] !== 'object' || Array.isArray(settings[key]))) throw new TypeError('Existing story preferences are invalid; they were not replaced.');
    }
    let changed = false;
    for (const [key, defaults] of [['StoryBuilder', PUBLIC_BUILDER_DEFAULTS], ['StoryReview', PUBLIC_REVIEW_DEFAULTS]]) {
        if (settings[key] === undefined) { settings[key] = {}; changed = true; }
        for (const [name, value] of Object.entries(defaults)) {
            if (!Object.hasOwn(settings[key], name)) { settings[key][name] = value; changed = true; }
        }
    }
    return changed;
}
