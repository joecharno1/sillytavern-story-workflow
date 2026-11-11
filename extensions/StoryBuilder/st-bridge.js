/**
 * Native SillyTavern 1.19 bridge. Source material never leaves this module except
 * through the return value consumed by the builder; there is no content logging.
 * Capture is explicit. It uses ST's normal macro/lore preparation in dry-run mode.
 */
import { collectTrackerContext } from './tracker-context.js';

let captureInProgress = false;
const snapshotDependencies = new WeakMap();
const sourceRevisionTrackers = new WeakMap();

/** Observe invalidation only; never retain lorebook/persona event payloads. */
export function sourceRevisionTracker(eventSource, eventTypes) {
    if (sourceRevisionTrackers.has(eventSource)) return sourceRevisionTrackers.get(eventSource);
    let revision = 0;
    const changed = () => { revision++; };
    for (const name of ['WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'PERSONA_CHANGED',
        'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED']) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], changed);
    }
    const current = () => revision;
    sourceRevisionTrackers.set(eventSource, current);
    return current;
}

const WRITING_SETTINGS = [
    'chat_completion_source', 'preset_settings_openai', 'openrouter_model',
    'openai_max_context', 'openai_max_tokens', 'prompts', 'prompt_order',
    'temp_openai', 'freq_pen_openai', 'pres_pen_openai', 'top_p_openai',
    'top_k_openai', 'min_p_openai', 'repetition_penalty_openai', 'top_a_openai',
    'openrouter_use_fallback', 'openrouter_providers', 'openrouter_quantizations',
    'openrouter_allow_fallbacks', 'openrouter_middleout', 'show_thoughts',
    'reasoning_effort', 'custom_prompt_post_processing', 'squash_system_messages',
    'names_behavior', 'continue_prefill', 'impersonation_prompt',
];

// Source fields owned by SillyTavern. Extension-owned metadata is also used for
// transient preparation state, so it cannot all be treated as an author edit.
const SOURCE_METADATA_FIELDS = new Set([
    'note_prompt', 'note_interval', 'note_position', 'note_depth', 'note_role',
    'scenario', 'system_prompt', 'mes_example', 'world_info', 'persona', 'main_chat',
    'script_injects', 'attachments', 'pick_reroll_seed', 'narrator_name',
]);
const PREPARATION_CACHE_FIELDS = new Set(['variables', 'chat_id_hash', 'timedWorldInfo']);

/** Observe actions only while assembling a source; never read any input value. */
export function watchPreparationEdits(onEdit, target = document) {
    const edited = event => {
        if (!event.isTrusted || event.target?.closest?.('#story-builder-dialog')) return;
        // Input/change covers text, selects and toggles. Click additionally covers
        // extension buttons whose handlers update custom metadata without an event.
        if (event.type === 'click' && !event.target?.closest?.('button, input, textarea, select, [role="button"], [contenteditable="true"], .menu_button')) return;
        onEdit();
    };
    for (const type of ['input', 'change', 'click']) target.addEventListener(type, edited, true);
    return () => { for (const type of ['input', 'change', 'click']) target.removeEventListener(type, edited, true); };
}

function aborted(signal) {
    if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
}

// Native preparation rebuilds some object properties without changing their
// values. Object insertion order is not a source edit; array order still is.
function canonicalJson(value) {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

function settingsFingerprint(settings) {
    return canonicalJson(Object.fromEntries(WRITING_SETTINGS.map(key => [key, settings?.[key]])));
}

function characterFingerprint(context) {
    const character = context.characters?.[context.characterId];
    return canonicalJson(character ? {
        name: character.name, avatar: character.avatar, description: character.description,
        personality: character.personality, scenario: character.scenario,
        first_mes: character.first_mes, mes_example: character.mes_example, data: character.data,
    } : null);
}

function messageFingerprint(message) {
    return canonicalJson([message?.mes, message?.swipe_id, message?.is_user,
        message?.is_system, message?.name, message?.extra]);
}

export function makeSnapshot(context, settings = {}, sourceRevision = 0) {
    const chat = context.chat;
    if (!Array.isArray(chat) || !chat.length) throw new Error('Open a chat with a saved story brief first.');
    const last = chat.at(-1);
    if (last?.is_system || typeof last?.mes !== 'string') throw new Error('The chat must end with your brief or a story reply.');
    const latestUserIndex = chat.findLastIndex(message => message.is_user && !message.is_system && typeof message.mes === 'string');
    if (latestUserIndex < 0 || !chat[latestUserIndex].mes.trim()) throw new Error('Save your story brief as a user message first.');
    // One saved reply may follow the brief; older accepted conversation remains.
    if (latestUserIndex < chat.length - (last.is_user ? 1 : 2)) throw new Error('The latest brief must immediately precede the current story reply.');
    return {
        chatId: context.getCurrentChatId?.(), characterId: context.characterId,
        groupId: context.groupId, chat, rows: chat.map(message => ({ message, value: messageFingerprint(message) })),
        settings: settingsFingerprint(settings), character: characterFingerprint(context),
        metadata: canonicalJson(context.chatMetadata || {}), latestUserIndex, sourceRevision,
        personaName: context.name1, extensionPrompts: canonicalJson(context.extensionPrompts || {}),
        lastMessage: last, latestBrief: chat[latestUserIndex].mes,
        mode: last.is_user ? 'append' : 'swipe',
    };
}

export function snapshotChangeCategories(context, snapshot, settings = {}, sourceRevision = snapshot?.sourceRevision ?? 0) {
    if (!snapshot) return ['chat'];
    const changes = [];
    if (context.chat !== snapshot.chat || context.getCurrentChatId?.() !== snapshot.chatId
        || context.characterId !== snapshot.characterId || context.groupId !== snapshot.groupId
        || context.chat.length !== snapshot.rows.length) changes.push('chat');
    if (settingsFingerprint(settings) !== snapshot.settings) changes.push('settings');
    if (characterFingerprint(context) !== snapshot.character) changes.push('card');
    if (canonicalJson(context.chatMetadata || {}) !== snapshot.metadata
        || canonicalJson(context.extensionPrompts || {}) !== snapshot.extensionPrompts) changes.push('metadata');
    if (context.name1 !== snapshot.personaName) changes.push('persona');
    if (sourceRevision !== snapshot.sourceRevision) changes.push('lore');
    if (!snapshot.rows.every((row, index) => context.chat[index] === row.message && messageFingerprint(row.message) === row.value)) changes.push('messages');
    return changes;
}

export function isSnapshotCurrent(context, snapshot, settings = {}, sourceRevision = snapshot?.sourceRevision ?? 0) {
    return snapshotChangeCategories(context, snapshot, settings, sourceRevision).length === 0;
}

// These are application-defined field names, never user-defined names or values.
// Unknown extension metadata is deliberately reported without its key.
const DIAGNOSTIC_METADATA_FIELDS = new Set([
    'variables', 'timedWorldInfo', 'chat_id_hash', 'pick_reroll_seed', 'lastInContextMessageId',
    'script_injects', 'note_prompt', 'note_interval', 'note_position', 'note_depth', 'note_role',
    'scenario', 'system_prompt', 'mes_example', 'world_info', 'persona', 'tainted', 'integrity', 'main_chat',
]);

export function metadataChangeLabels(context, snapshot) {
    const expected = JSON.parse(snapshot.metadata), actual = context.chatMetadata || {};
    const labels = new Set();
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
        if (canonicalJson(expected[key]) !== canonicalJson(actual[key])) {
            labels.add(DIAGNOSTIC_METADATA_FIELDS.has(key) ? key : 'other extension metadata');
        }
    }
    if (canonicalJson(context.extensionPrompts || {}) !== snapshot.extensionPrompts) labels.add('prepared extension prompts');
    return [...labels];
}

/** Validate author-owned inputs while native extensions assemble their output. */
function preparationComparison(before, current) {
    const allowedMetadata = JSON.parse(before.metadata);
    const actualMetadata = current.chatMetadata || {};
    // Accept extension-owned preparation state only inside this transaction.
    // Human edits are independently observed; known source inputs remain strict.
    // The final snapshot below captures ALL metadata again for the staged job.
    for (const key of new Set([...Object.keys(allowedMetadata), ...Object.keys(actualMetadata)])) {
        if (SOURCE_METADATA_FIELDS.has(key) || key.startsWith('cfg_') || PREPARATION_CACHE_FIELDS.has(key)) continue;
        if (Object.hasOwn(actualMetadata, key)) Object.defineProperty(allowedMetadata, key, { value: actualMetadata[key], enumerable: true, writable: true, configurable: true });
        else delete allowedMetadata[key];
    }
    // Native attachment enumeration may initialize an empty list while preparing.
    if (!Array.isArray(allowedMetadata.attachments) && Array.isArray(actualMetadata.attachments) && actualMetadata.attachments.length === 0) allowedMetadata.attachments = [];
    if (Object.hasOwn(actualMetadata, 'variables')) allowedMetadata.variables = actualMetadata.variables;
    else delete allowedMetadata.variables;
    // Both legacy and current macro engines can initialize/repair this hash.
    if ((!allowedMetadata.chat_id_hash || typeof allowedMetadata.chat_id_hash !== 'number') && Number.isSafeInteger(actualMetadata.chat_id_hash)) {
        allowedMetadata.chat_id_hash = actualMetadata.chat_id_hash;
    }
    // Unchanged data is not an edit, even when a cache is absent or only partly
    // initialized. If it did change, accept only the native shape normalization.
    // Valid timed-effect state must still match exactly.
    if (canonicalJson(allowedMetadata.timedWorldInfo) !== canonicalJson(actualMetadata.timedWorldInfo)) {
        if (!allowedMetadata.timedWorldInfo) allowedMetadata.timedWorldInfo = {};
        if (typeof allowedMetadata.timedWorldInfo === 'object') {
            for (const kind of ['sticky', 'cooldown']) {
                if (!allowedMetadata.timedWorldInfo[kind] || typeof allowedMetadata.timedWorldInfo[kind] !== 'object') allowedMetadata.timedWorldInfo[kind] = {};
                for (const [key, value] of Object.entries(allowedMetadata.timedWorldInfo[kind])) {
                    if (!value || typeof value !== 'object') delete allowedMetadata.timedWorldInfo[kind][key];
                }
            }
        }
    }
    const rows = before.rows.map((row, index) => {
        const expected = JSON.parse(row.value), expectedExtra = expected[5], actualExtra = current.chat[index]?.extra;
        if (expectedExtra && typeof expectedExtra === 'object' && actualExtra && typeof actualExtra === 'object') {
            // appendFileContent deletes/recomputes this derived length each pass.
            if (!Object.hasOwn(actualExtra, 'fileLength')) delete expectedExtra.fileLength;
            else if (Number.isSafeInteger(actualExtra.fileLength) && actualExtra.fileLength >= 0) expectedExtra.fileLength = actualExtra.fileLength;
        }
        return { ...row, value: canonicalJson(expected) };
    });
    return { ...before, rows, metadata: canonicalJson(allowedMetadata), extensionPrompts: canonicalJson(current.extensionPrompts || {}) };
}

export function containsFullBrief(messages, brief) {
    const exact = String(brief).trim();
    return Boolean(exact) && messages.some(message => message.role === 'user'
        && typeof message.content === 'string' && message.content.includes(exact));
}

async function nativeDependencies() {
    const [script, openai, events, timestamps] = await Promise.all([
        import('/script.js'), import('/scripts/openai.js'),
        import('/scripts/events.js'), import('/scripts/RossAscends-mods.js'),
    ]);
    return {
        getContext: () => globalThis.SillyTavern.getContext(),
        getSettings: () => openai.oai_settings,
        isGenerating: script.isGenerating,
        mainApi: () => script.main_api,
        generate: script.Generate,
        createParameters: openai.createGenerationParameters,
        getModel: openai.getChatCompletionModel,
        getTrackerInterceptor: () => globalThis.ztrackerGenerateInterceptor,
        eventSource: events.eventSource, eventTypes: events.event_types,
        getSourceRevision: sourceRevisionTracker(events.eventSource, events.event_types),
        watchSourceEdits: watchPreparationEdits,
        composerText: () => document.getElementById('send_textarea')?.value || '',
        getTimestamp: timestamps.getMessageTimeStamp,
    };
}

/** Does not return or log any secret. Native dry-run macros still execute. */
export async function captureSource({ signal, dependencies } = {}) {
    const d = dependencies || await nativeDependencies();
    if (captureInProgress || d.isGenerating()) throw new Error('Wait for the current generation or preparation to finish.');
    const context = d.getContext(), settings = d.getSettings();
    if (context.groupId) throw new Error('Story Builder currently supports one-character chats.');
    if (d.mainApi() !== 'openai' || settings.chat_completion_source !== 'openrouter') throw new Error('Choose Chat Completion with OpenRouter first.');
    if (String(d.composerText()).trim()) throw new Error('Save your prompt edit first and leave the message box empty before preparing the story.');
    const before = makeSnapshot(context, settings, d.getSourceRevision?.() ?? 0);
    const first = context.chat[0], originalFirstText = first.mes;
    let captured = null, externalChange = false, sawOwnStart = false;
    const changed = () => { externalChange = true; };
    const started = (_type, _options, dryRun) => {
        if (dryRun && !sawOwnStart) { sawOwnStart = true; return; }
        externalChange = true;
    };
    const afterData = (data, dryRun) => {
        if (dryRun && Array.isArray(data?.prompt)) captured = structuredClone(data.prompt);
    };
    const changeTypes = ['CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED',
        'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'CHARACTER_EDITED', 'OAI_PRESET_CHANGED_AFTER'];
    const watched = changeTypes.map(key => d.eventTypes[key]).filter(Boolean);
    let stopWatchingEdits;
    captureInProgress = true;
    for (const type of watched) d.eventSource.on(type, changed);
    d.eventSource.on(d.eventTypes.GENERATION_STARTED, started);
    d.eventSource.on(d.eventTypes.GENERATE_AFTER_DATA, afterData);
    try {
        stopWatchingEdits = d.watchSourceEdits?.(changed);
        aborted(signal);
        // 'swipe' removes the rejected current reply from the assembled copy.
        // dryRun prevents network generation, chat deletion, or reply insertion.
        await d.generate(before.mode === 'swipe' ? 'swipe' : 'normal', { signal }, true);
        // Native ST substitutes the first greeting even on a dry run. Restore
        // that one known mutation only when no external action was observed.
        if (!externalChange && context.chat === before.chat && context.chat[0] === first) first.mes = originalFirstText;
        aborted(signal);
        if (externalChange || context !== d.getContext() && context.chat !== d.getContext().chat
            || d.isGenerating() || d.getContext().getCurrentChatId?.() !== before.chatId) {
            throw new Error('The chat changed while preparing. Prepare it again after the current action finishes.');
        }
        // Fetch current references: native helpers can replace metadata objects.
        const comparison = preparationComparison(before, d.getContext());
        const changes = snapshotChangeCategories(d.getContext(), comparison, d.getSettings(), d.getSourceRevision?.() ?? 0);
        if (changes.length) {
            const fields = changes.includes('metadata') ? metadataChangeLabels(d.getContext(), comparison) : [];
            const diagnostic = fields.length ? ` Changed fields: ${fields.join(', ')}.` : '';
            throw new Error(`The prompt or settings changed during preparation (${changes.join(', ')}).${diagnostic} Prepare it again.`);
        }
        if (!captured?.length) throw new Error('SillyTavern did not produce a usable Chat Completion prompt.');
        if (captured.some(message => !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) {
            throw new Error('This version of Story Builder accepts text-only story prompts without tool messages or image attachments.');
        }
        if (!containsFullBrief(captured, before.latestBrief)) {
            throw new Error('The full latest brief was not found in the prepared prompt. It may have been changed by a prompt regex or left out by the context limit. Nothing was sent to a model.');
        }
        // Native dry runs skip generation interceptors. Ask only zTracker's
        // local formatter to expose its already saved snapshots on a chat copy.
        // A rejected current reply must not supply continuity for its replacement.
        const trackerMessages = await collectTrackerContext({
            chat: before.mode === 'swipe' ? d.getContext().chat.slice(0, -1) : d.getContext().chat,
            interceptor: d.getTrackerInterceptor?.(), signal,
        });
        aborted(signal);
        if (externalChange || d.isGenerating()
            || !isSnapshotCurrent(d.getContext(), comparison, d.getSettings(), d.getSourceRevision?.() ?? 0)) {
            throw new Error('The source changed while preparing saved continuity. Prepare it again.');
        }
        if (trackerMessages.length) {
            const briefIndex = captured.findLastIndex(message => message.role === 'user'
                && message.content.includes(before.latestBrief.trim()));
            // Preserve every native row and any final assistant prefill. The
            // latest author brief follows the historical continuity references.
            captured = [...captured.slice(0, briefIndex), ...trackerMessages, ...captured.slice(briefIndex)];
        }
        const copy = structuredClone(d.getSettings());
        // This is a writing pipeline; no function tools execute during its calls.
        copy.function_calling = false;
        const model = d.getModel(copy);
        const { generate_data: request } = await d.createParameters(copy, model, 'quiet', captured);
        aborted(signal);
        const finalComparison = preparationComparison(before, d.getContext());
        if (externalChange || d.isGenerating() || !isSnapshotCurrent(d.getContext(), finalComparison, d.getSettings(), d.getSourceRevision?.() ?? 0)) throw new Error('The source changed during preparation. Prepare it again.');
        const requestTemplate = structuredClone(request);
        delete requestTemplate.messages;
        delete requestTemplate.tools; delete requestTemplate.tool_choice;
        requestTemplate.stream = false; requestTemplate.n = 1;
        // Never silently compress a large brief into a different prompt.
        requestTemplate.middleout = 'off';
        const snapshot = makeSnapshot(d.getContext(), d.getSettings(), d.getSourceRevision?.() ?? 0);
        snapshotDependencies.set(snapshot, d);
        return {
            snapshot, messages: captured,
            requestTemplate, latestBrief: before.latestBrief, model,
            contextLimit: Number(settings.openai_max_context), responseLimit: Number(settings.openai_max_tokens),
            metadata: { messageCount: captured.length, promptCharacters: captured.reduce((sum, item) => sum + item.content.length, 0),
                fullBriefIncluded: true, rejectedReplyExcluded: before.mode === 'swipe', nativeMacrosPrepared: true,
                trackerSnapshotCount: trackerMessages.length },
        };
    } finally {
        if (!externalChange && context.chat === before.chat && context.chat[0] === first) first.mes = originalFirstText;
        for (const type of watched) d.eventSource.removeListener(type, changed);
        d.eventSource.removeListener(d.eventTypes.GENERATION_STARTED, started);
        d.eventSource.removeListener(d.eventTypes.GENERATE_AFTER_DATA, afterData);
        stopWatchingEdits?.();
        captureInProgress = false;
    }
}

export function snapshotCurrent(snapshot, { dependencies } = {}) {
    const d = dependencies || snapshotDependencies.get(snapshot);
    if (!d) return false;
    return !d.isGenerating() && isSnapshotCurrent(d.getContext(), snapshot, d.getSettings(), d.getSourceRevision?.() ?? 0);
}

/**
 * Explicit acceptance only. No generation/memory events are emitted. Native
 * saveChat swallows some storage errors, so the return value says saveRequested,
 * never claiming independently verified disk persistence.
 */
export async function applyResult(snapshot, text, { model = '', reasoning = '', originalDraft = '', workflow, dependencies } = {}) {
    const d = dependencies || await nativeDependencies();
    const context = d.getContext();
    if (captureInProgress || d.isGenerating() || !isSnapshotCurrent(context, snapshot, d.getSettings(), d.getSourceRevision?.() ?? 0)) throw new Error('The chat, brief, or writing settings changed. Prepare a new story before applying this result.');
    if (typeof text !== 'string' || !text.trim()) throw new Error('There is no finished story to add.');
    const finished = text.trim();
    const extra = { api: 'manual', model: `Story Builder (${model})`, gen_id: Date.now(), storyBuilder: true,
        reasoning: String(reasoning || ''), reasoning_duration: null };
    if (workflow) extra.storyWorkflow = structuredClone(workflow);
    const original = typeof originalDraft === 'string' ? originalDraft.trim() : '';
    const keepOriginal = original && original !== finished;
    const originalExtra = { ...structuredClone(extra), storyWorkflow: { ...structuredClone(workflow || {}), draftBeforeRevision: true } };
    const now = d.getTimestamp?.() || new Date().toISOString();
    const message = snapshot.lastMessage;
    const targetIndex = snapshot.mode === 'swipe' ? context.chat.length - 1 : context.chat.length;
    const canRender = (target) => {
        const current = d.getContext();
        return !d.isGenerating() && current.getCurrentChatId?.() === snapshot.chatId
            && current.characterId === snapshot.characterId && current.groupId === snapshot.groupId
            && current.chat === snapshot.chat && current.chat[targetIndex] === target;
    };
    if (snapshot.mode === 'swipe') {
        const keys = ['mes', 'swipes', 'swipe_info', 'swipe_id', 'extra', 'gen_started', 'gen_finished', 'send_date'];
        const previous = new Map(keys.map(key => [key, { exists: Object.hasOwn(message, key), value: message[key] }]));
        const swipes = Array.isArray(message.swipes) && message.swipes.length ? [...message.swipes] : [message.mes];
        const info = Array.isArray(message.swipe_info) ? structuredClone(message.swipe_info) : [];
        while (info.length < swipes.length) info.push({});
        const oldId = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
        swipes[oldId] = message.mes;
        info[oldId] = { ...info[oldId], send_date: message.send_date, gen_started: message.gen_started,
            gen_finished: message.gen_finished, extra: structuredClone(message.extra || {}) };
        const newInfo = { send_date: now, gen_started: null, gen_finished: null, extra: structuredClone(extra) };
        if (keepOriginal) {
            swipes.push(original);
            info.push({ send_date: now, gen_started: null, gen_finished: null, extra: originalExtra });
        }
        swipes.push(finished); info.push(newInfo);
        Object.assign(message, { mes: finished, swipes, swipe_info: info, swipe_id: swipes.length - 1,
            extra, gen_started: null, gen_finished: null, send_date: now });
        try { await context.saveChat(); }
        catch (error) {
            if (message.mes === finished && message.swipes === swipes) for (const [key, value] of previous) {
                if (value.exists) message[key] = value.value; else delete message[key];
            }
            throw new Error('SillyTavern could not save the story. The preview is still available.');
        }
        const rendered = canRender(message);
        if (rendered) {
            context.updateMessageBlock?.(targetIndex, message, { rerenderMessage: true });
            context.refreshSwipeButtons?.();
        }
        return { index: targetIndex, swipeId: swipes.length - 1, saveRequested: true, rendered };
    }
    const swipes = keepOriginal ? [original, finished] : [finished];
    const swipeInfo = keepOriginal ? [{ send_date: now, gen_started: null, gen_finished: null, extra: originalExtra }] : [];
    swipeInfo.push({ send_date: now, gen_started: null, gen_finished: null, extra: structuredClone(extra) });
    const added = { name: context.name2, is_user: false, is_system: false, mes: finished, send_date: now,
        gen_started: null, gen_finished: null, extra, swipe_id: swipes.length - 1, swipes, swipe_info: swipeInfo };
    context.chat.push(added);
    try { await context.saveChat(); }
    catch (error) {
        if (context.chat.at(-1) === added && added.mes === finished && added.swipes === swipes
            && added.swipe_info === swipeInfo && added.swipe_id === swipes.length - 1 && added.extra === extra) context.chat.pop();
        throw new Error('SillyTavern could not save the story. The preview is still available.');
    }
    const rendered = canRender(added);
    if (rendered) {
        context.addOneMessage?.(added);
        context.refreshSwipeButtons?.();
    }
    return { index: targetIndex, swipeId: swipes.length - 1, saveRequested: true, rendered };
}
