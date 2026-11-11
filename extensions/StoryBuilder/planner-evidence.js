const MAX_PASSAGE = 1800;
const PREFERRED_MINIMUM = 900;

function fail(message) {
    const error = new Error(message);
    error.name = 'PlannerEvidenceError';
    throw error;
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeBoundary(text, end) {
    const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? end - 1 : end;
}

function preferredBoundary(text, start, limit) {
    const fragment = text.slice(start, limit);
    for (const pattern of [/\r?\n[\t ]*\r?\n+/g, /\r\n|[\r\n\u2028\u2029]/g,
        /[.!?。！？…]["'”’»\])]*\s+/gu, /\s+/gu]) {
        let boundary = 0;
        for (const match of fragment.matchAll(pattern)) {
            const end = match.index + match[0].length;
            if (end >= PREFERRED_MINIMUM) boundary = end;
        }
        if (boundary) return start + boundary;
    }
    return limit;
}

/** Lossless source anchors, not event/scene boundaries. Long whitespace runs
 * sometimes require a whitespace-only passage; those anchors cannot be cited.
 */
export function indexBrief(brief) {
    if (typeof brief !== 'string' || !brief.trim()) {
        fail('The planner needs the complete nonempty author brief.');
    }
    const passages = [];
    let start = 0;
    while (start < brief.length) {
        const limit = safeBoundary(brief, Math.min(brief.length, start + MAX_PASSAGE));
        let end = limit === brief.length ? limit : preferredBoundary(brief, start, limit);
        // Do not choose a pleasant earlier break if the larger allowed chunk
        // would avoid leaving a needless whitespace-only following passage.
        if (end < limit && !brief.slice(end, Math.min(brief.length, end + MAX_PASSAGE)).trim()
            && brief.slice(limit, Math.min(brief.length, limit + MAX_PASSAGE)).trim()) end = limit;
        const passage = brief.slice(start, end);
        if (!passage.trim() && passages.length) {
            const previous = passages.at(-1), combined = previous + passage;
            if (combined.length <= MAX_PASSAGE) passages[passages.length - 1] = combined;
            else if (end === brief.length) {
                // Rebalance trailing whitespace around the final actual text
                // when both resulting passages can still contain source text.
                const lastText = [...combined.matchAll(/\S/gu)].at(-1);
                const split = lastText?.index;
                if (split > 0 && split <= MAX_PASSAGE && combined.length - split <= MAX_PASSAGE
                    && combined.slice(0, split).trim()) {
                    passages[passages.length - 1] = combined.slice(0, split);
                    passages.push(combined.slice(split));
                } else passages.push(passage);
            } else passages.push(passage);
        } else passages.push(passage);
        start = end;
    }
    return passages.map((text, index) => ({ id: `p${String(index + 1).padStart(4, '0')}`, text }));
}

/** Canonicalize source-backed beats without changing the outline. Legacy
 * quote-only beats are left for the existing strict plan validator.
 */
export function resolvePlanEvidence(plan, brief, { requirePassageIds = false } = {}) {
    if (!record(plan) || !Array.isArray(plan.requiredBeats) || typeof requirePassageIds !== 'boolean') {
        fail('The planner returned an invalid required-beat structure.');
    }
    const passages = new Map(indexBrief(brief).map(passage => [passage.id, passage.text]));
    let result;
    try { result = structuredClone(plan); }
    catch { fail('The planner outline could not be copied safely.'); }
    result.requiredBeats = result.requiredBeats.map(beat => {
        if (!record(beat) || typeof beat.id !== 'string' || !beat.id.trim() || beat.id.length > 60) {
            fail('The planner returned an invalid required-beat structure.');
        }
        if (!Object.hasOwn(beat, 'passageId')) {
            if (requirePassageIds) fail('A planned requirement is missing its author-brief passage reference.');
            return beat;
        }
        if (typeof beat.passageId !== 'string' || !passages.has(beat.passageId)) {
            fail('A planned requirement refers to an unknown author-brief passage.');
        }
        const briefQuote = passages.get(beat.passageId);
        if (!briefQuote.trim() || briefQuote.length > 2000) {
            fail('A planned requirement refers to a passage without usable author instructions.');
        }
        if (Object.hasOwn(beat, 'briefQuote') && beat.briefQuote !== briefQuote) {
            fail('A planned requirement no longer matches its author-brief passage.');
        }
        const hasRequirement = Object.hasOwn(beat, 'requirement');
        if (hasRequirement && (typeof beat.requirement !== 'string' || !beat.requirement.trim() || beat.requirement.length > 1000)) {
            fail('The planner returned an invalid or oversized requirement description.');
        }
        return { id: beat.id, passageId: beat.passageId, briefQuote,
            ...(hasRequirement ? { requirement: beat.requirement } : {}) };
    });
    return result;
}
