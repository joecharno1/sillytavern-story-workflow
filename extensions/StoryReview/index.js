import { extension_settings } from '/scripts/extensions.js';
import { eventSource, event_types } from '/scripts/events.js';
import { oai_settings } from '/scripts/openai.js';
import { isGenerating } from '/script.js';
import { DEFAULTS, safeSettings, snapshotDraft, snapshotCurrent, appendRevision } from './review-service.js';
import { resolveFollowUpSettings, createFollowUpSession, updateSessionOptions, advanceSession, reviewFollowUp, reviseFollowUp, followUpSpend, assertFollowUpCurrent } from './follow-up.js';
import { WRITING_ASPECTS, WRITING_PRESETS } from '../StoryBuilder/writing-tuning.js';
import { formatSpendSummary } from '../StoryBuilder/chat-progress.js';

const KEY = 'StoryReview';
const VERSION = '1.3.0';
let dialog, counts, status, issues, range, instruction, preview, applyButton, cancelButton, actionButtons = [];
let current = null, report = null, pendingRevision = null, controller = null, job = 0, ownSwipe = false;
let eligibleGeneration = false, generationStopped = false, generationToken = 0, setupComplete = false;
let pendingReceived = null, wasStreaming = false;
let session = null, sessionOptions = '', applying = false, previousSpend = '';
let preferenceFields = {}, effective, spending, presetLabel, customLabel, modelList, catalogButton, catalogNote, newSessionButton, catalogLoading = false;
const FOCUSES = [['general', 'General review'], ['continuity', 'Continuity and instructions'], ['prose', 'Prose and pacing'], ...WRITING_ASPECTS.map(value => [value.id, value.label])];
const settings = () => safeSettings(extension_settings[KEY] || {});
const resolvedSettings = () => resolveFollowUpSettings(extension_settings[KEY] || {}, extension_settings.StoryBuilder || {});
const signature = resolved => JSON.stringify([resolved.preferences, resolved.reviewSettings, resolved.revisionSettings, resolved.effectiveReviewModel, resolved.effectiveRevisionModel]);
const ctx = () => SillyTavern.getContext();
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (text, handler, parent) => { const b = el('button', text, 'menu_button'); b.type = 'button'; b.addEventListener('click', handler); parent?.append(b); return b; };
function say(text) { if (status) status.textContent = text; }
function badge(text) { const b = document.getElementById('story-review-menu'); if (b) b.textContent = text; }
function busy() {
    const on = Boolean(controller || applying);
    for (const b of actionButtons) b.disabled = on;
    for (const input of Object.values(preferenceFields)) input.disabled = on;
    if (preferenceFields.spendLimitUsd) preferenceFields.spendLimitUsd.disabled = on || Boolean(session);
    if (catalogButton) catalogButton.disabled = on || catalogLoading;
    if (newSessionButton) newSessionButton.disabled = on;
    if (range) range.disabled = on; if (instruction) instruction.disabled = on;
    if (cancelButton) cancelButton.disabled = !controller;
    if (applyButton) applyButton.disabled = on || !pendingRevision;
    drawSpending();
}
function clearProposal() { pendingRevision = null; preview?.replaceChildren(); if (applyButton) applyButton.disabled = true; }
function invalidate(message = 'The draft or prompt changed. Open the reviewer again for the current version.') {
    controller?.abort(); job++; current = null; report = null; clearProposal();
    if (issues) issues.replaceChildren();
    if (counts) counts.textContent = 'No current draft selected.';
    if (dialog?.open) say(`${message} The follow-up spending record is retained.`); busy();
    badge('Follow-up editor');
}
function findDraft() {
    const c = ctx(); const index = c.chat.length - 1;
    return snapshotDraft(c, index, resolvedSettings().reviewSettings);
}
function drawCounts(analysis) {
    counts.textContent = `${analysis.words.toLocaleString()} words / ${settings().wordMin.toLocaleString()}–${settings().wordMax.toLocaleString()} target · ${analysis.paragraphs} paragraphs / ${settings().paragraphMin}–${settings().paragraphMax} target`;
    if (analysis.warnings.length) counts.append(el('div', analysis.warnings.join('\n'), 'sr-warning'));
}
function selectCurrent() {
    if (isGenerating()) throw new Error('Wait until the story reply has finished.');
    if (current && !snapshotCurrent(ctx(), current)) { report = null; issues.replaceChildren(); }
    current = findDraft();
    if (session) advanceSession(session, current);
    clearProposal(); drawCounts(current.analysis); busy();
    return current;
}
function drawSpending() {
    if (!spending) return;
    try {
        const limit = resolvedSettings().preferences.spendLimitUsd;
        const summary = session ? followUpSpend(session) : { limitUsd: limit, reportedUsd: 0, estimatedUsd: 0, unknownUsd: 0, reservedUsd: 0, remainingUsd: limit, reportedRequests: 0, unreportedRequests: 0 };
        spending.textContent = `Separate follow-up allowance, additional to Story Builder spending. ${formatSpendSummary(summary)}${previousSpend ? ` Previous session: ${previousSpend}` : ''}`;
    } catch { spending.textContent = 'Check the follow-up preferences to display the allowance.'; }
}
function readySession() {
    if (!current || !snapshotCurrent(ctx(), current)) selectCurrent();
    const resolved = resolvedSettings(), key = signature(resolved);
    if (!session) { session = createFollowUpSession(current, resolved); sessionOptions = key; }
    else {
        if (session.snapshot !== current) advanceSession(session, current);
        if (sessionOptions !== key) { updateSessionOptions(session, resolved); sessionOptions = key; clearProposal(); }
    }
    return session;
}
function editorTransport(active, signal, expected) {
    return { fetcher: fetch, headers: ctx().getRequestHeaders(), signal,
        assertCurrent: () => {
            if (isGenerating() || !snapshotCurrent(ctx(), active.snapshot)) throw new Error('The draft or prompt changed. No revision was applied.');
            if (signature(resolvedSettings()) !== expected) throw new Error('The editing preferences changed. Request a new preview.');
        }, onSpend: drawSpending };
}
function handleError(error, token) {
    if (token !== job) return;
    if (error?.name === 'AbortError') say('Cancelled. The story is unchanged.');
    else say(error?.message || 'The operation could not finish. No revision was applied.');
    badge('Story Review · check status');
}
function drawReport(value) {
    issues.replaceChildren(); issues.append(el('p', value.summary));
    if (value.strengths.length) { const list = el('ul'); for (const item of value.strengths) list.append(el('li', item)); issues.append(list); }
    for (const issue of value.issues) {
        const box = el('div', undefined, 'sr-issue');
        box.append(el('strong', `${issue.severity.toUpperCase()} · ${issue.category}${issue.paragraphs.length ? ` · ¶ ${issue.paragraphs.join(', ')}` : ''}`));
        box.append(el('p', issue.problem), el('p', issue.suggestion));
        if (issue.paragraphs.length) button('Use this revision suggestion', () => { if (controller || applying) return; clearProposal(); range.value = issue.paragraphs.join(', '); instruction.value = issue.suggestion; instruction.focus(); }, box);
        issues.append(box);
    }
    if (value.remaining?.length) {
        issues.append(el('h3', 'Remaining workflow findings'));
        issues.append(el('p', 'These include unresolved findings carried forward from earlier review rounds. Check the current passage before choosing paragraph numbers.'));
        const list = el('ul');
        for (const item of value.remaining) list.append(el('li', `${item.problem} ${item.suggestion || ''} ${item.reason || ''}`));
        issues.append(list);
    }
    if (!value.issues.length && !value.remaining?.length) issues.append(el('p', 'The reviewer found no specific issues. This is an editorial assessment, not a guarantee.'));
}
async function runReview() {
    if (controller || applying) return;
    let token, request;
    try {
        if (!setupComplete) throw new Error('Finish Story Review setup before reviewing.');
        commitPreferences();
        selectCurrent(); const active = readySession(), snapshot = active.snapshot; issues.replaceChildren(); report = null;
        request = new AbortController(); controller = request; token = ++job; busy();
        say('Reviewing the selected draft and earlier conversation. The story will not be changed.'); badge('Story Review · reviewing…');
        const result = await reviewFollowUp(active, editorTransport(active, request.signal, sessionOptions));
        if (token !== job || !snapshotCurrent(ctx(), snapshot)) return;
        report = result; drawReport(result); say(`Review ready. ${result.issues.length} finding(s). Choose a passage to revise, or keep the draft as written.`);
        badge(`Story Review · ${result.issues.length} findings`);
    } catch (error) { handleError(error, token ?? job); }
    finally { if (controller === request) controller = null; busy(); }
}
function parseRange(text) {
    const ids = [];
    for (const part of text.split(',')) {
        const match = part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
        if (!match) throw new Error('Enter paragraph numbers such as 14–16.');
        const a = Number(match[1]), b = Number(match[2] || a);
        if (a < 1 || b < a || b - a > 12) throw new Error('Choose a small, adjacent paragraph range.');
        for (let i = a; i <= b; i++) ids.push(i);
    }
    return [...new Set(ids)].sort((a, b) => a - b);
}
async function revisionPreview() {
    if (controller || applying) return;
    let token, request;
    try {
        commitPreferences();
        if (!current || !snapshotCurrent(ctx(), current)) selectCurrent();
        const active = readySession(), snapshot = active.snapshot, ids = parseRange(range.value);
        request = new AbortController(); controller = request; token = ++job; clearProposal(); busy();
        say('Preparing a replacement for the selected passage. Nothing will change until you apply it.');
        const value = await reviseFollowUp(active, ids, instruction.value, editorTransport(active, request.signal, sessionOptions));
        if (token !== job || !snapshotCurrent(ctx(), snapshot)) return;
        pendingRevision = value;
        preview.append(el('h3', 'Original passage'), el('div', value.original, 'sr-preview'), el('h3', 'Proposed replacement'), el('div', value.replacement, 'sr-preview'));
        preview.append(el('p', `Revision model: ${value.model}. After applying: ${value.analysis.words.toLocaleString()} story words; ${value.analysis.paragraphs} paragraphs.`));
        say('Review the replacement below. Applying creates a new reply version and preserves the original.');
    } catch (error) { handleError(error, token ?? job); }
    finally { if (controller === request) controller = null; busy(); }
}
async function applyRevision() {
    if (!pendingRevision || controller || applying) return;
    const proposal = pendingRevision, active = session, token = ++job;
    applying = true; busy();
    try {
        if (!active || proposal.sessionRevision !== active.revision) throw new Error('The editing preferences changed. Request a new preview.');
        await assertFollowUpCurrent(active, editorTransport(active, undefined, sessionOptions));
        ownSwipe = true;
        await appendRevision(ctx(), active.snapshot, proposal.updated, proposal.model);
        if (token !== job) return;
        if (ctx().getCurrentChatId?.() !== active.snapshot.chatId || ctx().chat?.[active.snapshot.index] !== active.snapshot.message || active.snapshot.message.mes !== proposal.updated) {
            invalidate('The visible chat changed while the revision was saved. Check the source reply before continuing.'); return;
        }
        selectCurrent(); report = null; issues.replaceChildren();
        say('Applied as a new reply version. Use SillyTavern’s swipe arrows to return to the original. Memory was not updated.');
        badge('Story Review · revised');
    } catch (e) { clearProposal(); say(e.message); } finally { ownSwipe = false; applying = false; busy(); }
}
async function acceptMemory() {
    if (controller || applying) return;
    try {
        if (isGenerating()) throw new Error('Wait until generation finishes.');
        if (!current || !snapshotCurrent(ctx(), current)) throw new Error('Select and check the current version before accepting it.');
        if (!ctx().executeSlashCommandsWithOptions) throw new Error('SillyTavern commands are unavailable.');
        const snapshot = current;
        applying = true; busy(); say('Opening MemoryBooks for this accepted reply only. Review its memory preview before saving.');
        dialog.close();
        const result = await ctx().executeSlashCommandsWithOptions(`/scenememory ${snapshot.index}-${snapshot.index}`, { showOutput: false, handleExecutionErrors: true });
        if (result?.isError || result?.isAborted) throw new Error('Memory creation did not complete. Check MemoryBooks.');
        say('The selected reply was sent to MemoryBooks. Its preview controls whether the memory is saved. Future regenerations do not undo saved memory.');
    } catch (e) { say(e.message); if (!dialog.open) dialog.showModal(); } finally { applying = false; busy(); }
}
function openReviewer() {
    if (!dialog.open) dialog.showModal();
    if (controller || applying) return;
    try {
        syncPreferences();
        if (!current || !snapshotCurrent(ctx(), current)) { selectCurrent(); issues.replaceChildren(); say('Counts are local and free. Choose a review or preview a targeted revision. Nothing is applied without your approval.'); }
    } catch (e) { say(e.message); }
}
function presetName(preferences) {
    const aspect = WRITING_ASPECTS.find(value => value.id === preferences.focus), builder = extension_settings.StoryBuilder || {};
    if (!aspect) return preferences.useBuilderStyles && builder.tuningEnabled ? 'Selected Story Builder styles' : 'Follow the prompt and existing writing style';
    let selected = preferences.preset;
    if (selected === 'builder') {
        if (!preferences.useBuilderStyles || !builder.tuningEnabled) return 'Follow the prompt and existing writing style';
        selected = builder.writingStyles?.[aspect.id]?.preset || 'inherit';
    }
    if (selected === 'custom') return 'Custom instructions';
    return WRITING_PRESETS[aspect.id].find(value => value.id === selected)?.label
        || builder.writingPresetLibrary?.[aspect.id]?.find(value => value.id === selected)?.name || 'Follow the prompt and existing writing style';
}
function drawEffective(resolved = resolvedSettings()) {
    effective.textContent = `Review: ${resolved.effectiveReviewModel} · Revision: ${resolved.effectiveRevisionModel} · Style: ${presetName(resolved.preferences)}.`;
}
function renderPresetChoices(focus, selected = 'builder') {
    const select = preferenceFields.preset, aspect = WRITING_ASPECTS.find(value => value.id === focus);
    select.replaceChildren();
    const choices = [{ id: 'builder', label: 'Use this category’s Builder style' }, ...(aspect ? WRITING_PRESETS[aspect.id] : []), { id: 'custom', label: 'Custom instructions for this edit' }];
    if (aspect) for (const saved of extension_settings.StoryBuilder?.writingPresetLibrary?.[aspect.id] || []) choices.push({ id: saved.id, label: `Saved: ${saved.name}` });
    for (const choice of choices) { const option = el('option', choice.label); option.value = choice.id; select.append(option); }
    select.value = choices.some(value => value.id === selected) ? selected : 'builder';
    presetLabel.hidden = !aspect; customLabel.hidden = !aspect || select.value !== 'custom';
}
function syncPreferences() {
    const resolved = resolvedSettings();
    if (session && sessionOptions !== signature(resolved)) {
        updateSessionOptions(session, resolved); sessionOptions = signature(resolved); clearProposal(); report = null; issues.replaceChildren();
    }
    for (const [key, input] of Object.entries(preferenceFields)) {
        if (input.type === 'checkbox') input.checked = resolved.preferences[key]; else input.value = resolved.preferences[key];
    }
    renderPresetChoices(resolved.preferences.focus, resolved.preferences.preset); drawEffective(resolved); busy();
}
function commitPreferences() {
    const values = Object.fromEntries(Object.entries(preferenceFields).map(([key, input]) => [key, input.type === 'checkbox' ? input.checked === true : input.value]));
    const resolved = resolveFollowUpSettings({ ...extension_settings[KEY], followUp: values }, extension_settings.StoryBuilder || {});
    if (session && signature(resolved) !== sessionOptions) { updateSessionOptions(session, resolved); sessionOptions = signature(resolved); clearProposal(); }
    extension_settings[KEY].followUp = { ...resolved.preferences }; ctx().saveSettingsDebounced();
    renderPresetChoices(resolved.preferences.focus, resolved.preferences.preset); drawEffective(resolved); busy();
    return resolved;
}
function preferenceChanged(key) {
    if (controller || applying) return;
    clearProposal(); report = null; issues.replaceChildren();
    if (key === 'focus') renderPresetChoices(preferenceFields.focus.value, 'builder');
    try { commitPreferences(); say('Editing preferences updated. Request a fresh review or revision preview; the current session’s spending is retained.'); }
    catch (error) { say(error.message || 'Check the editing preferences.'); }
}
function newEditingSession() {
    if (controller || applying) return;
    if (session) {
        const value = followUpSpend(session); previousSpend = `$${Number(value.accountedUsd ?? value.reportedUsd ?? 0).toFixed(4)} accounted; earlier provider charges still apply.`;
    }
    session = null; sessionOptions = ''; report = null; clearProposal(); issues.replaceChildren(); job++;
    busy(); say('New editing session ready. Choose its allowance before your next request. This does not remove charges from earlier sessions.');
}
async function loadModelCatalog() {
    if (controller || applying || catalogLoading) return;
    catalogLoading = true; catalogNote.textContent = 'Loading model IDs…'; busy();
    try {
        const response = await fetch('/api/backends/chat-completions/status', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ chat_completion_source: 'openrouter' }) });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data?.data)) throw new Error('Catalog unavailable');
        const ids = [...new Set(data.data.map(value => value?.id).filter(value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/.test(value)))].sort().slice(0, 5000);
        if (!ids.length) throw new Error('Catalog empty');
        modelList.replaceChildren(); for (const id of ids) { const option = el('option'); option.value = id; modelList.append(option); }
        catalogNote.textContent = `Loaded ${ids.length.toLocaleString()} model IDs. Manual OpenRouter IDs still work. No generation request was made.`;
    } catch { catalogNote.textContent = 'The model catalog is unavailable. Enter an OpenRouter model ID directly.'; }
    finally { catalogLoading = false; busy(); }
}
function buildPreferences() {
    const box = el('section', undefined, 'sr-preferences'), fields = el('div', undefined, 'sr-fields');
    const advanced = el('details', undefined, 'sr-advanced-preferences'); advanced.append(el('summary', 'Styles, models, and spending limit'));
    box.append(el('h3', 'Follow-up editing preferences'));
    const focusLabel = el('label', 'Review focus'), focus = el('select'); preferenceFields.focus = focus; focus.id = 'story-review-focus';
    for (const [id, label] of FOCUSES) { const option = el('option', label); option.value = id; focus.append(option); } focusLabel.append(focus); box.append(focusLabel);
    const useLabel = el('label', undefined, 'sr-check'), use = el('input'); use.type = 'checkbox'; use.id = 'story-review-useBuilderStyles'; preferenceFields.useBuilderStyles = use;
    useLabel.append(use, document.createTextNode(' Use Builder writing styles and category model choices')); fields.append(useLabel);
    for (const [key, labelText] of [['reviewModel', 'Review model override — blank inherits'], ['revisionModel', 'Revision model override — blank inherits'], ['spendLimitUsd', 'Separate follow-up allowance in USD (0 disables)']]) {
        const label = el('label', labelText), input = el('input'); input.id = `story-review-${key}`; input.className = 'text_pole';
        input.type = key === 'spendLimitUsd' ? 'number' : 'text';
        if (key === 'spendLimitUsd') { input.min = '0'; input.max = '1000'; input.step = '0.01'; } else input.setAttribute('list', 'story-review-model-catalog');
        preferenceFields[key] = input; label.append(input); fields.append(label);
    }
    presetLabel = el('label', 'Style preset for this focus'); const preset = el('select'); preset.id = 'story-review-preset'; preferenceFields.preset = preset; presetLabel.append(preset); fields.append(presetLabel);
    customLabel = el('label', 'Custom instructions for this edit'); const custom = el('textarea'); custom.id = 'story-review-custom'; custom.maxLength = 8000; custom.className = 'text_pole'; preferenceFields.custom = custom; customLabel.append(custom);
    effective = el('p', undefined, 'sr-effective'); spending = el('p', undefined, 'sr-spending'); spending.setAttribute('aria-live', 'off');
    box.append(effective, spending);
    advanced.append(fields, customLabel, el('p', 'Saved presets are read from Story Builder. These overrides change only follow-up preferences; create reusable named presets in Story Builder. Blank model overrides inherit its applicable category or stage model. Turning off Builder styles also turns off category model inheritance.', 'sr-note'));
    modelList = el('datalist'); modelList.id = 'story-review-model-catalog'; catalogNote = el('p', 'Model IDs can be entered manually. The optional catalog makes no generation request.', 'sr-note');
    const actions = el('div', undefined, 'sr-actions'); catalogButton = button('Load available model IDs', () => void loadModelCatalog(), actions); newSessionButton = button('New editing session', newEditingSession, actions);
    advanced.append(actions, modelList, catalogNote, el('p', 'The allowance stays in this browser tab through reviews, revisions, cancellation, applied changes, and reopening the editor. Changing a model does not reset it. Reloading the page or choosing New editing session starts a separate allowance; earlier provider charges still apply.', 'sr-note'),
        el('p', 'Reviews use the visible accepted conversation, latest user brief, and selected draft; they do not rebuild hidden lorebooks or system presets. This editor works with replies from Standard generation or Story Builder.', 'sr-note'));
    box.append(advanced);
    for (const [key, input] of Object.entries(preferenceFields)) {
        input.addEventListener('change', () => preferenceChanged(key));
        input.addEventListener('input', () => { if (!controller && !applying) clearProposal(); });
    }
    return box;
}
function buildUI() {
    dialog = el('dialog'); dialog.id = 'story-review-dialog';
    const top = el('div', undefined, 'sr-top'); top.append(el('h2', 'Story Review / Follow-up editor'), el('span', `v${VERSION}`, 'sr-note')); button('Close', () => dialog.close(), top);
    counts = el('div', 'Open a completed story reply to count it.', 'sr-counts');
    status = el('div', 'Ready.', 'sr-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); issues = el('div'); issues.id = 'story-review-issues'; preview = el('div'); preview.id = 'story-review-preview';
    const actions = el('div', undefined, 'sr-actions');
    actionButtons.push(button('Count current draft', () => { try { selectCurrent(); say('Counts updated. Planning and recognized FF panels are excluded.'); } catch(e) { say(e.message); } }, actions));
    actionButtons.push(button('Review current draft', () => void runReview(), actions));
    cancelButton = button('Cancel request', () => { controller?.abort(); }, actions); cancelButton.disabled = true;
    const rangeLabel = el('label', 'Paragraphs to revise (for example 14–16)'); range = el('input'); range.id = 'story-review-range'; range.type = 'text'; range.className = 'text_pole'; rangeLabel.append(range);
    const instructionLabel = el('label', 'What should change?'); instruction = el('textarea'); instruction.id = 'story-review-instruction'; instruction.className = 'text_pole'; instructionLabel.append(instruction);
    for (const input of [range, instruction]) input.addEventListener('input', () => { if (!controller && !applying) clearProposal(); });
    const reviseActions = el('div', undefined, 'sr-actions');
    actionButtons.push(button('Preview targeted revision', () => void revisionPreview(), reviseActions));
    applyButton = button('Apply as new reply version', () => void applyRevision(), reviseActions); applyButton.disabled = true;
    const memoryActions = el('div', undefined, 'sr-actions'); actionButtons.push(button('Accept and save memory…', () => void acceptMemory(), memoryActions));
    const paragraphs = el('details'); paragraphs.append(el('summary', 'Show numbered story paragraphs'));
    const paragraphList = el('div'); paragraphs.append(paragraphList);
    paragraphs.addEventListener('toggle', () => { paragraphList.replaceChildren(); if (paragraphs.open && current) for (const p of current.analysis.countedParagraphs) paragraphList.append(el('p', `${p.id}. ${p.text}`)); });
    dialog.append(top, el('p', 'Review or revise the latest completed reply. Opening the editor is free; changes require your approval.', 'sr-note'),
        buildPreferences(), counts, status, actions, issues, paragraphs, rangeLabel, instructionLabel, reviseActions, preview, el('hr'), el('small', 'Reviews and revisions do not write memories. MemoryBooks is a separate manual action with its own costs outside this editing allowance. Accept only a version you intend to keep: later edits do not remove a saved MemoryBooks entry.'), memoryActions);
    document.body.append(dialog);
    const panel = el('div'); panel.id = 'story-review-settings'; panel.append(el('strong', 'Story Review / Follow-up editor'));
    const setupStatus = el('div', 'Preparing setup…', 'sr-note'); setupStatus.id = 'story-review-setup-status'; panel.append(setupStatus);
    for (const [key, labelText] of [['enabled', 'Show local counts for completed replies']]) {
        const label = el('label'); const input = el('input'); input.type = 'checkbox'; input.checked = settings()[key];
        input.addEventListener('change', () => { extension_settings[KEY][key] = input.checked; ctx().saveSettingsDebounced(); if (!input.checked) invalidate(); });
        label.append(input, document.createTextNode(` ${labelText}`)); panel.append(label);
    }
    panel.append(el('p', 'Follow-up reviews are manual. Choose the focus, styles, model overrides, and separate allowance inside the editor. Standard generation remains available.', 'sr-note'));
    button('Open follow-up editor', openReviewer, panel);
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings'); target?.append(panel);
    const menu = el('div', 'Follow-up editor', 'list-group-item flex-container flexGap5'); menu.id = 'story-review-menu'; menu.tabIndex = 0; menu.setAttribute('role', 'button'); menu.addEventListener('click', openReviewer); menu.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReviewer(); } });
    menu.dataset.ntTopbarAction = 'story-review:open'; menu.dataset.ntTopbarLabel = 'Follow-up editor'; menu.dataset.ntTopbarIcon = 'fa-solid fa-pen-to-square';
    document.getElementById('extensionsMenu')?.append(menu);
    syncPreferences();
}
async function setup() {
    if (setupComplete) return;
    // Public distribution: only initialize this extension's own preferences.
    // Never change writing presets, profiles, trackers, or existing stories.
    extension_settings[KEY] = { ...DEFAULTS, ...extension_settings[KEY], autoReview: false };
    extension_settings[KEY].followUp = { ...resolvedSettings().preferences };
    ctx().saveSettingsDebounced();
    if (!dialog) buildUI();
    setupComplete = true;
    document.getElementById('story-review-setup-status').textContent =
        `Ready · story target ${settings().wordMin.toLocaleString()}–${settings().wordMax.toLocaleString()} words · connected to Story Builder`;
}
eventSource.on(event_types.APP_READY, () => { void setup(); });
eventSource.on('story_workflow_open_editor', () => { if (setupComplete) openReviewer(); });
eventSource.on('story_workflow_review_ready', payload => {
    if (!setupComplete || !payload || controller) return;
    const message = ctx().chat?.[payload.index];
    if (!message || message.mes !== payload.text || payload.index !== ctx().chat.length - 1) return;
    try {
        selectCurrent();
        const cycle = Math.max(0, ...(payload.reports || []).map(item => item.cycle || 0));
        const latest = (payload.reports || []).filter(item => (item.cycle || 0) === cycle).map(item => item.report || item);
        report = { summary: `Story Builder completed ${payload.changes || 0} targeted revision(s). ${payload.remaining?.length || 0} workflow finding(s) remain. These are the final independent reviews.`, strengths: latest.flatMap(item => item.strengths || []), issues: latest.flatMap(item => item.issues || []), remaining: payload.remaining || [] };
        drawReport(report); say('The reviewed version is now in chat. The final reports refer to that version; carried-forward findings are marked separately. Further edits require a fresh review.'); badge(`Story Review · ${report.remaining.length || report.issues.length} findings`);
    } catch (error) { say(error.message || 'Open Story Review to inspect the accepted version.'); }
});
eventSource.on(event_types.GENERATION_STARTED, (type, options, dryRun) => {
    invalidate('A new story generation started.'); generationToken++; generationStopped = false;
    pendingReceived = null; wasStreaming = Boolean(oai_settings.stream_openai);
    eligibleGeneration = !dryRun && ['normal', 'swipe', 'regenerate', 'continue'].includes(type);
});
eventSource.on(event_types.GENERATION_STOPPED, () => { generationStopped = true; pendingReceived = null; });
function processCompletedDraft() {
    const pending = pendingReceived;
    if (!pending || isGenerating()) return;
    pendingReceived = null;
    const c = ctx();
    if (pending.gen !== generationToken || generationStopped || pending.index !== c.chat.length - 1 || c.chat[pending.index] !== pending.message) return;
    if (!pending.message.gen_finished || (wasStreaming && c.streamingProcessor?.abortController?.signal?.aborted)) return;
    try { current = findDraft(); drawCounts(current.analysis); badge(`Follow-up editor · ${current.analysis.words.toLocaleString()} words`); } catch(e) { say(e.message); }
}
eventSource.on(event_types.MESSAGE_RECEIVED, (index, type) => {
    if (!setupComplete || !settings().enabled || !eligibleGeneration || generationStopped || ['first_message', 'quiet', 'impersonate'].includes(type)) return;
    eligibleGeneration = false;
    const c = ctx();
    if (wasStreaming && c.streamingProcessor?.abortController?.signal?.aborted) return;
    pendingReceived = { index, gen: generationToken, message: c.chat[index] };
    setTimeout(processCompletedDraft, 150);
});
eventSource.on(event_types.GENERATION_ENDED, () => { setTimeout(processCompletedDraft, 150); });
for (const event of [event_types.CHAT_CHANGED, event_types.MESSAGE_EDITED, event_types.MESSAGE_DELETED, event_types.MESSAGE_SWIPED]) eventSource.on(event, index => {
    if (ownSwipe && event === event_types.MESSAGE_SWIPED && index === current?.index && ctx().chat?.[index]?.mes === pendingRevision?.updated) return;
    invalidate();
});
