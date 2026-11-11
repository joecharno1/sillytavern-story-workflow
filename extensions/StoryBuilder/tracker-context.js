const ORIGINAL_FIELDS = ['mes', 'content', 'role', 'is_user', 'is_system'];
const TOOL_FIELDS = ['tools', 'tool_calls', 'tool_call_id', 'tool_choice', 'functions', 'function_call', 'function_calls'];
let sequence = 0;

function abortIfNeeded(signal) {
    if (signal?.aborted) throw new DOMException('Story context preparation was paused.', 'AbortError');
}
function fail(message) { throw new Error(`Tracker context was not included: ${message}`); }

/**
 * Run only the supplied official zTracker hook on a private copy of raw chat.
 * Its configured modules/roles decide which snapshots appear. Original turns
 * never enter the result, even when each vendor module clones the entire array.
 */
export async function collectTrackerContext({ chat, interceptor, signal } = {}) {
    abortIfNeeded(signal);
    if (chat == null || (Array.isArray(chat) && chat.length === 0) || interceptor == null) return [];
    if (!Array.isArray(chat) || typeof interceptor !== 'function') fail('the tracker hook or source is unavailable.');
    let copy;
    try { copy = structuredClone(chat); }
    catch { fail('the source could not be copied safely.'); }
    const nonce = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID() : `${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`;
    const marker = `__storyBuilderTrackerSource_${nonce}`;
    const originals = [];
    copy = copy.map((message, index) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) fail('the source contains an invalid message.');
        if (Object.hasOwn(message, marker)) fail('source markers collided.');
        if ((message.mes !== undefined && typeof message.mes !== 'string')
            || (message.content !== undefined && typeof message.content !== 'string')
            || (typeof message.mes !== 'string' && typeof message.content !== 'string')) fail('the source contains non-text message content.');
        // Separate top-level rows even if an input array reused one object.
        const row = { ...message, [marker]: `${nonce}:${index}` };
        originals.push({ marker: row[marker], fields: ORIGINAL_FIELDS.map(key => ({ key, own: Object.hasOwn(message, key), value: message[key] })) });
        return row;
    });
    abortIfNeeded(signal);
    try { await interceptor(copy); }
    catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw new DOMException('Story context preparation was paused.', 'AbortError');
        fail('the tracker hook failed.');
    }
    abortIfNeeded(signal);

    const injected = [];
    let originalIndex = 0;
    for (const row of copy) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) fail('the tracker hook returned a malformed message.');
        if (Object.hasOwn(row, marker)) {
            const expected = originals[originalIndex];
            if (!expected || row[marker] !== expected.marker) fail('original messages were duplicated, reordered, or replaced.');
            for (const field of expected.fields) {
                if (Object.hasOwn(row, field.key) !== field.own || row[field.key] !== field.value) fail('the tracker hook changed original conversation text or roles.');
            }
            originalIndex++;
            continue;
        }
        if (!['system', 'user', 'assistant'].includes(row.role)) fail('an inserted snapshot has an invalid role.');
        if (TOOL_FIELDS.some(key => Object.hasOwn(row, key))) fail('an inserted snapshot contains unsupported tool data.');
        if ((row.content !== undefined && typeof row.content !== 'string')
            || (row.mes !== undefined && typeof row.mes !== 'string')) fail('an inserted snapshot is not text.');
        if (typeof row.content === 'string' && typeof row.mes === 'string' && row.content !== row.mes) fail('an inserted snapshot has ambiguous text.');
        const content = typeof row.content === 'string' ? row.content : row.mes;
        if (typeof content !== 'string' || !content.trim()) fail('an inserted snapshot has no text.');
        if ((row.is_user !== undefined && row.is_user !== (row.role === 'user'))
            || (row.is_system !== undefined && row.is_system !== (row.role === 'system'))) fail('an inserted snapshot has inconsistent role flags.');
        if (row.name !== undefined && (typeof row.name !== 'string' || !row.name.trim())) fail('an inserted snapshot has an invalid name.');
        injected.push({ role: row.role, content, ...(row.name !== undefined ? { name: row.name } : {}) });
    }
    if (originalIndex !== originals.length) fail('the tracker hook removed original conversation messages.');
    abortIfNeeded(signal);
    return injected;
}
