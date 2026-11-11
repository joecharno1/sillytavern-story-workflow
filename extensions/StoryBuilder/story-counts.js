/** Pure story analysis. No DOM, network, chat storage, or model calls. */
export const DEFAULT_TARGETS = Object.freeze({ wordMin: 12000, wordMax: 13000, paragraphMin: 120, paragraphMax: 160 });

const FF_PANEL = /\b(?:INTERNAL STATES|QUESTS|CHEKHOV(?:['’]S GUN| SEEDS)|INTERNAL THOUGHTS|INV\s*&\s*SKILLS|INVENTORY\s*&\s*STATUS|GM(?:['’]S)? NOTEBOOK|NPC AGENDAS|NPC LOCATIONS|FACTIONS|BONDS|BOND TRACKER|PLOT MOMENTUM|DND TASK SIM|WORLD SIM|PHYSICS,? ENGINE\s*&\s*WORLD)\b/i;
const WORD_PATTERN = /\p{N}+(?:[,.]\p{N}+)+|[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*(?:[-‐‑][\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*)*/gu;
const SEVERITIES = new Set(['low', 'medium', 'high']);
const CATEGORIES = new Set(['continuity', 'instructions', 'characterization', 'pacing', 'prose', 'repetition', 'length', 'format', 'other']);

/** Stable identifier only; exact string equality, not this hash, guards revisions. */
export function fingerprint(text) {
    let a = 2166136261;
    let b = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 16777619);
        b = Math.imul(b ^ c, 0x85ebca6b);
    }
    return `${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

function decodeEntities(text) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, code) => {
        if (code[0] !== '#') return named[code.toLowerCase()] ?? whole;
        const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ' ';
    });
}

/** Counts lexical words; hyphenated words and apostrophes stay together. */
export function countWords(text) {
    return (text.match(WORD_PATTERN) || []).length;
}

function readableText(text) {
    return decodeEntities(text
        .replace(/<!--[^]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s*\d+[.)][\t ]+/, '')
        .replace(/^\s*>[\t ]?/gm, '')
        .replace(/[*_~`]/g, '')).replace(/\s+/g, ' ').trim();
}

function targetOptions(options) {
    const result = {};
    for (const [key, fallback] of Object.entries(DEFAULT_TARGETS)) {
        const value = options[key] ?? fallback;
        if (!Number.isInteger(value) || value < 1) throw new TypeError(`${key} must be a positive integer.`);
        result[key] = value;
    }
    if (result.wordMin > result.wordMax || result.paragraphMin > result.paragraphMax) {
        throw new RangeError('Minimum targets must not exceed maximum targets.');
    }
    return result;
}

function mergeRanges(ranges) {
    const sorted = ranges.filter(r => r.end > r.start).sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const range of sorted) {
        const last = merged.at(-1);
        if (last && range.start <= last.end) {
            last.end = Math.max(last.end, range.end);
            if (!last.kind.includes(range.kind)) last.kind += `,${range.kind}`;
        } else merged.push({ ...range });
    }
    return merged;
}

function maskRanges(raw, ranges) {
    let cursor = 0;
    let result = '';
    for (const { start, end } of mergeRanges(ranges)) {
        result += raw.slice(cursor, start) + raw.slice(start, end).replace(/[^\r\n]/g, ' ');
        cursor = end;
    }
    return result + raw.slice(cursor);
}

function collectPaired(raw, tokenPattern, isOpening, kind, ranges, warnings, failClosed = true) {
    const stack = [];
    let invalid = false;
    for (const match of raw.matchAll(tokenPattern)) {
        if (isOpening(match[0])) {
            if (stack.length && failClosed) {
                warnings.push(`Nested ${kind} markers make the story boundary ambiguous.`);
                invalid = true;
            }
            stack.push(match.index);
        } else if (stack.length) {
            const start = stack.pop();
            if (!stack.length) ranges.push({ start, end: match.index + match[0].length, kind });
        } else {
            warnings.push(`A closing ${kind} marker has no opening marker.`);
            invalid ||= failClosed;
        }
    }
    if (stack.length) {
        ranges.push({ start: stack[0], end: raw.length, kind });
        warnings.push(`An unclosed ${kind} block was found. Counts and revision are unavailable until it is closed.`);
        invalid ||= failClosed;
    }
    return invalid;
}

/**
 * Blank-line-delimited prose/dialogue paragraphs are counted. Standalone Markdown
 * headings, fenced code, HTML headings, FF panels, planning, and bullet-list blocks
 * are excluded. Numbered prose paragraphs separated by blank lines are included.
 * Unknown HTML details remain in the count, with a warning. No user regex is run.
 */
export function analyzeDraft(raw, options = {}) {
    if (typeof raw !== 'string') throw new TypeError('Draft must be a string.');
    const targets = targetOptions(options);
    const warnings = [];
    const ranges = [];
    let blocked = false;

    blocked = collectPaired(raw, /\[PLANNING_(?:START|END)\]/gi, t => /START/i.test(t), 'planning', ranges, warnings) || blocked;
    blocked = collectPaired(raw, /<\/?think\b[^>]*>/gi, t => !/^<\//.test(t), 'think', ranges, warnings) || blocked;

    // Legacy FF monologue delimiters are structural markers, not a prose heuristic.
    const monologue = /^#{1,6}[\t ]*Internal Monologue[^\r\n]*$/gim;
    for (const start of raw.matchAll(monologue)) {
        const following = raw.slice(start.index + start[0].length);
        const response = /^#{1,6}[\t ]*Response[^\r\n]*$/im.exec(following);
        if (response) ranges.push({ start: start.index, end: start.index + start[0].length + response.index + response[0].length, kind: 'monologue' });
        else {
            ranges.push({ start: start.index, end: raw.length, kind: 'monologue' });
            warnings.push('An Internal Monologue heading has no Response heading. Counts and revision are unavailable.');
            blocked = true;
        }
    }

    blocked = collectPaired(raw, /<!--\s*GFX_(?:START|END)\s*-->/gi, t => /START/i.test(t), 'FF graphics', ranges, warnings) || blocked;
    blocked = collectPaired(raw, /<\/?internal_states\b[^>]*>/gi, t => !/^<\//.test(t), 'FF internal states', ranges, warnings) || blocked;

    const details = [];
    for (const tag of raw.matchAll(/<\/?details\b[^>]*>/gi)) {
        if (!/^<\//.test(tag[0])) details.push({ start: tag.index, contentStart: tag.index + tag[0].length });
        else if (details.length) {
            const open = details.pop();
            const end = tag.index + tag[0].length;
            const content = raw.slice(open.contentStart, tag.index);
            const summary = /^\s*<summary\b[^>]*>([^]*?)<\/summary>/i.exec(content);
            if (summary && FF_PANEL.test(readableText(summary[1]))) ranges.push({ start: open.start, end, kind: 'FF panel' });
            else if (!details.length) warnings.push('An unrecognized details panel was counted as content; verify whether it belongs to the story.');
        } else warnings.push('An unmatched closing details tag was found.');
    }
    for (const open of details) {
        const summary = /^\s*<summary\b[^>]*>([^]*?)<\/summary>/i.exec(raw.slice(open.contentStart));
        if (summary && FF_PANEL.test(readableText(summary[1]))) {
            ranges.push({ start: open.start, end: raw.length, kind: 'FF panel' });
            warnings.push('An FF state panel is unclosed. Counts and revision are unavailable until it is closed.');
            blocked = true;
        } else warnings.push('An unclosed, unrecognized details panel was counted as content.');
    }

    // Fences are parsed by line, so a triple-backtick token inside prose is harmless.
    let fence = null;
    for (const line of raw.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
        if (!line[0]) continue;
        const match = /^[\t ]{0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line[0]);
        if (!match) continue;
        if (!fence) fence = { start: line.index, char: match[1][0], length: match[1].length };
        else if (match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) {
            ranges.push({ start: fence.start, end: line.index + line[0].length, kind: 'code' });
            fence = null;
        }
    }
    if (fence) {
        ranges.push({ start: fence.start, end: raw.length, kind: 'code' });
        warnings.push('An unclosed code fence was excluded from the count.');
    }
    for (const match of raw.matchAll(/<!--[^]*?-->|<h[1-6]\b[^>]*>[^]*?<\/h[1-6]>/gi)) {
        ranges.push({ start: match.index, end: match.index + match[0].length, kind: 'metadata' });
    }
    for (const match of raw.matchAll(/^[\t ]{0,3}#{1,6}(?:[\t ]+|$)[^\r\n]*|^[\t ]*(?:[-*_][\t ]*){3,}$/gm)) {
        ranges.push({ start: match.index, end: match.index + match[0].length, kind: 'heading' });
    }
    // FF's single-line status header is distinct from ordinary bracketed prose.
    // Require field separators and at least two independent time/day/location
    // indicators; one emoji or a loose mention of "time" is not sufficient.
    for (const match of raw.matchAll(/^[\t ]*\[([^\r\n[\]]{1,1000})\][\t ]*\r?$/gm)) {
        const content = match[1];
        const indicators = [
            /🕰\uFE0F?|\bTime[\t ]*:?[\t ]*\d{1,2}:\d{2}/iu,
            /🗓\uFE0F?|\bDay[\t ]*:?[\t ]*(?:\d{1,3}\b|Monday\b|Tuesday\b|Wednesday\b|Thursday\b|Friday\b|Saturday\b|Sunday\b)/iu,
            /📍|\bLocation[\t ]*:/iu,
        ].filter(pattern => pattern.test(content)).length;
        if (content.includes('|') && indicators >= 2) {
            ranges.push({ start: match.index, end: match.index + match[0].length, kind: 'FF status header' });
        } else if (indicators > 0) {
            warnings.push('An unrecognized bracketed status line was counted as content; verify whether it belongs to the story.');
        }
    }

    // A mixed response can contain leaked, unmarked planning before the block.
    // Do not mistake that prefix for story prose, even if it quotes story events.
    // Known FF panels/headings are already masked, so harmless headers are allowed.
    let masked = maskRanges(raw, ranges);
    const firstPlanningRange = ranges
        .filter(r => ['planning', 'think', 'monologue'].includes(r.kind))
        .sort((a, b) => a.start - b.start)[0];
    if (firstPlanningRange && masked.slice(0, firstPlanningRange.start).trim()) {
        blocked = true;
        warnings.push('Unmarked text appears before the planning block; story words and paragraphs cannot be counted reliably.');
    }

    // Explicit HTML paragraphs are supported without modifying source offsets.
    const htmlBoundaries = [];
    masked = masked.replace(/<\/?p\b[^>]*>/gi, (tag, index) => {
        htmlBoundaries.push({ start: index, end: index + tag.length, kind: 'HTML paragraph boundary' });
        return '\n'.repeat(tag.length);
    });
    ranges.push(...htmlBoundaries);

    const countedParagraphs = [];
    const blocks = /[^\r\n]*(?:(?:\r\n|\n|\r)(?![\t ]*(?:\r\n|\n|\r))[^\r\n]*)*/g;
    for (const block of masked.matchAll(blocks)) {
        if (!block[0].trim()) continue;
        const left = block[0].search(/\S/);
        const right = block[0].match(/\s*$/)[0].length;
        const start = block.index + left;
        const end = block.index + block[0].length - right;
        const visible = masked.slice(start, end);
        const lines = visible.trim().split(/\r\n|\n|\r/).filter(x => x.trim());
        const bullet = lines.some(line => /^[\t ]*[-+*•][\t ]+/.test(line));
        const numberedList = lines.length > 1 && lines.every(line => /^[\t ]*\d+[.)][\t ]+/.test(line));
        const table = lines.length > 1 && lines.every(line => /^\s*\|.*\|\s*$/.test(line));
        if (bullet || numberedList || table) {
            ranges.push({ start, end, kind: 'list or table' });
            warnings.push('List or table material was excluded; numbered prose separated by blank lines is counted.');
            continue;
        }
        const text = readableText(visible);
        const words = countWords(text);
        if (!words) continue;
        countedParagraphs.push({ id: countedParagraphs.length + 1, start, end, text, words });
    }

    const words = blocked ? null : countedParagraphs.reduce((sum, p) => sum + p.words, 0);
    const paragraphs = blocked ? null : countedParagraphs.length;
    if (!blocked && firstPlanningRange && paragraphs === 0) {
        warnings.push('No story prose was found outside the planning block. The model returned planning without a story.');
    }
    const status = (count, min, max) => count === null ? 'unavailable' : count < min ? 'below' : count > max ? 'above' : 'within';
    const result = {
        words, paragraphs, countedParagraphs: blocked ? [] : countedParagraphs,
        narrativeText: blocked ? '' : countedParagraphs.map(p => p.text).join('\n\n'),
        warnings: [...new Set(warnings)], blocked, targets,
        wordStatus: status(words, targets.wordMin, targets.wordMax),
        paragraphStatus: status(paragraphs, targets.paragraphMin, targets.paragraphMax),
        sourceFingerprint: fingerprint(raw), excludedRanges: mergeRanges(ranges),
        definition: 'Words are Unicode letter/number groups, keeping apostrophes, hyphenated compounds, and formatted numbers together. Paragraphs are prose/dialogue blocks separated by blank lines or HTML paragraph tags. Recognized planning, FF panels, headings, lists, tables, and fenced code are excluded.',
    };
    Object.defineProperty(result, '_source', { value: raw, enumerable: false });
    return result;
}

/** Apply only the selected contiguous story paragraphs; all other source bytes survive. */
export function applyParagraphReplacement(raw, analysis, ids, replacement) {
    if (!analysis || analysis.blocked) throw new Error('This analysis cannot be revised.');
    if (typeof raw !== 'string' || raw !== analysis._source) throw new Error('The draft changed after analysis. Analyze it again before applying a revision.');
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !Number.isInteger(id))) throw new TypeError('Choose paragraph numbers.');
    const selectedIds = [...new Set(ids)].sort((a, b) => a - b);
    if (selectedIds.length !== ids.length) throw new RangeError('Paragraph numbers must be unique.');
    if (selectedIds.some((id, i) => id < 1 || id > analysis.countedParagraphs.length || (i > 0 && id !== selectedIds[i - 1] + 1))) {
        throw new RangeError('Choose one contiguous range of valid story paragraphs.');
    }
    const first = analysis.countedParagraphs[selectedIds[0] - 1];
    const last = analysis.countedParagraphs[selectedIds.at(-1) - 1];
    if (analysis.excludedRanges.some(r => r.start < last.end && r.end > first.start)) {
        throw new Error('The selection crosses excluded planning, headings, or state panels. Revise the story sections separately.');
    }
    if (typeof replacement !== 'string' || !replacement.trim()) throw new TypeError('Replacement prose must not be empty.');
    if (replacement.length > 2000000) throw new RangeError('Replacement prose is too large.');
    if (/\[PLANNING_(?:START|END)\]|<\/?(?:think|internal_states|details|script|style)\b|<!--\s*GFX_(?:START|END)|^#{1,6}\s*Internal Monologue/im.test(replacement)) {
        throw new Error('A targeted revision must contain story prose only, without planning or state panels.');
    }
    return raw.slice(0, first.start) + replacement.trim() + raw.slice(last.end);
}

function cleanReportString(value, name, maxLength, allowEmpty = false) {
    if (typeof value !== 'string') throw new TypeError(`${name} must be text.`);
    const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/<[^>]*>/g, '').trim();
    if ((!allowEmpty && !clean) || clean.length > maxLength) throw new RangeError(`${name} is empty or exceeds its length limit.`);
    return clean;
}

/** Model counts are intentionally ignored: deterministic local counts are authoritative. */
export function parseReviewReport(raw, paragraphCount) {
    if (!Number.isInteger(paragraphCount) || paragraphCount < 0) throw new TypeError('Paragraph count must be a nonnegative integer.');
    if (typeof raw !== 'string' || raw.length > 100000) throw new TypeError('Review must be a bounded JSON string.');
    let json = raw.trim();
    const fence = /^```(?:json)?\s*\n?([^]*?)\n?```$/i.exec(json);
    if (fence) json = fence[1].trim();
    const report = JSON.parse(json);
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new TypeError('Review must be a JSON object.');
    if (!Array.isArray(report.issues) || report.issues.length > 30) throw new RangeError('Review issues must be an array of at most 30 items.');
    if (!Array.isArray(report.strengths) || report.strengths.length > 10) throw new RangeError('Review strengths must be an array of at most 10 items.');
    return {
        summary: cleanReportString(report.summary, 'Summary', 2000),
        strengths: report.strengths.map((v, i) => cleanReportString(v, `Strength ${i + 1}`, 700)),
        issues: report.issues.map((issue, index) => {
            if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new TypeError(`Issue ${index + 1} must be an object.`);
            if (!SEVERITIES.has(issue.severity)) throw new TypeError(`Issue ${index + 1} has an invalid severity.`);
            if (!CATEGORIES.has(issue.category)) throw new TypeError(`Issue ${index + 1} has an invalid category.`);
            if (!Array.isArray(issue.paragraphs) || issue.paragraphs.length > 160 || issue.paragraphs.some(p => !Number.isInteger(p) || p < 1 || p > paragraphCount)) {
                throw new RangeError(`Issue ${index + 1} has invalid paragraph references.`);
            }
            return {
                severity: issue.severity, category: issue.category,
                paragraphs: [...new Set(issue.paragraphs)].sort((a, b) => a - b),
                problem: cleanReportString(issue.problem, 'Problem', 2000),
                suggestion: cleanReportString(issue.suggestion, 'Suggestion', 2000),
            };
        }),
    };
}
