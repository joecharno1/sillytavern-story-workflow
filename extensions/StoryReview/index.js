import { extension_settings } from '/scripts/extensions.js';
import { eventSource, event_types } from '/scripts/events.js';
import { oai_settings } from '/scripts/openai.js';
import { isGenerating } from '/script.js';
import { analyzeDraft } from './review-core.js';
import { DEFAULTS, safeSettings, snapshotDraft, snapshotCurrent, reviewDraft, reviseDraft, appendRevision } from './review-service.js';

const KEY = 'StoryReview';
let dialog, counts, status, issues, range, instruction, preview, applyButton, cancelButton, actionButtons = [];
let current = null, report = null, pendingRevision = null, controller = null, job = 0, ownSwipe = false;
let eligibleGeneration = false, generationStopped = false, generationToken = 0, setupComplete = false;
let pendingReceived = null, wasStreaming = false;
const settings = () => safeSettings(extension_settings[KEY] || {});
const ctx = () => SillyTavern.getContext();
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (text, handler, parent) => { const b = el('button', text, 'menu_button'); b.type = 'button'; b.addEventListener('click', handler); parent?.append(b); return b; };
function say(text) { if (status) status.textContent = text; }
function badge(text) { const b = document.getElementById('story-review-menu'); if (b) b.textContent = text; }
function busy(on) { for (const b of actionButtons) b.disabled = on; cancelButton.disabled = !on; applyButton.disabled = on || !pendingRevision; }
function invalidate(message = 'The draft or prompt changed. Open the reviewer again for the current version.') {
    controller?.abort(); controller = null; job++; current = null; report = null; pendingRevision = null;
    if (preview) preview.replaceChildren(); if (issues) issues.replaceChildren(); if (applyButton) applyButton.disabled = true;
    if (counts) counts.textContent = 'No current draft selected.';
    if (dialog?.open) say(message); if (cancelButton) busy(false);
    badge('Story Review');
}
function findDraft() {
    const c = ctx(); const index = c.chat.length - 1;
    return snapshotDraft(c, index, settings());
}
function drawCounts(analysis) {
    counts.textContent = `${analysis.words.toLocaleString()} words / ${settings().wordMin.toLocaleString()}–${settings().wordMax.toLocaleString()} target · ${analysis.paragraphs} paragraphs / ${settings().paragraphMin}–${settings().paragraphMax} target`;
    if (analysis.warnings.length) counts.append(el('div', analysis.warnings.join('\n'), 'sr-warning'));
}
function selectCurrent() {
    if (isGenerating()) throw new Error('Wait until the story reply has finished.');
    if (current && !snapshotCurrent(ctx(), current)) { report = null; issues.replaceChildren(); }
    current = findDraft(); pendingRevision = null; preview.replaceChildren(); applyButton.disabled = true; drawCounts(current.analysis);
    return current;
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
        if (issue.paragraphs.length) button('Use this revision suggestion', () => { range.value = issue.paragraphs.join(', '); instruction.value = issue.suggestion; instruction.focus(); }, box);
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
async function runReview(automatic = false) {
    if (controller) return;
    let token;
    try {
        if (!setupComplete) throw new Error('Finish Story Review setup before reviewing.');
        const snapshot = selectCurrent(); issues.replaceChildren(); report = null;
        controller = new AbortController(); token = ++job; busy(true);
        say('Reviewing the selected draft and earlier conversation. The story will not be changed.'); badge('Story Review · reviewing…');
        const result = await reviewDraft(snapshot, settings(), { headers: ctx().getRequestHeaders(), signal: controller.signal });
        if (token !== job || !snapshotCurrent(ctx(), snapshot)) return;
        report = result; drawReport(result); say(`Review ready. ${result.issues.length} finding(s). Choose a passage to revise, or keep the draft as written.`);
        badge(`Story Review · ${result.issues.length} findings`);
        if (automatic) globalThis.toastr?.info('Your editorial report is ready in Story Review.', 'Story Review');
    } catch (error) { handleError(error, token ?? job); }
    finally { if (token === job) { controller = null; busy(false); } }
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
    if (controller) return;
    let token;
    try {
        if (!current || !snapshotCurrent(ctx(), current)) selectCurrent();
        const snapshot = current, ids = parseRange(range.value);
        controller = new AbortController(); token = ++job; busy(true); pendingRevision = null; preview.replaceChildren();
        say('Preparing a replacement for the selected passage. Nothing will change until you apply it.');
        const value = await reviseDraft(snapshot, ids, instruction.value, settings(), { headers: ctx().getRequestHeaders(), signal: controller.signal });
        if (token !== job || !snapshotCurrent(ctx(), snapshot)) return;
        pendingRevision = value;
        preview.append(el('h3', 'Original passage'), el('div', value.original, 'sr-preview'), el('h3', 'Proposed replacement'), el('div', value.replacement, 'sr-preview'));
        preview.append(el('p', `After applying: ${value.analysis.words.toLocaleString()} story words; ${value.analysis.paragraphs} paragraphs.`));
        say('Review the replacement below. Applying creates a new reply version and preserves the original.');
    } catch (error) { handleError(error, token ?? job); }
    finally { if (token === job) { controller = null; busy(false); } }
}
async function applyRevision() {
    if (!pendingRevision || controller) return;
    try {
        ownSwipe = true;
        await appendRevision(ctx(), current, pendingRevision.updated, settings().model);
        selectCurrent(); report = null; issues.replaceChildren();
        say('Applied as a new reply version. Use SillyTavern’s swipe arrows to return to the original. Memory was not updated.');
        badge('Story Review · revised');
    } catch (e) { say(e.message); } finally { ownSwipe = false; }
}
async function acceptMemory() {
    if (controller) return;
    try {
        if (isGenerating()) throw new Error('Wait until generation finishes.');
        if (!current || !snapshotCurrent(ctx(), current)) throw new Error('Select and check the current version before accepting it.');
        if (!ctx().executeSlashCommandsWithOptions) throw new Error('SillyTavern commands are unavailable.');
        const snapshot = current;
        busy(true); say('Opening MemoryBooks for this accepted reply only. Review its memory preview before saving.');
        dialog.close();
        const result = await ctx().executeSlashCommandsWithOptions(`/scenememory ${snapshot.index}-${snapshot.index}`, { showOutput: false, handleExecutionErrors: true });
        if (result?.isError || result?.isAborted) throw new Error('Memory creation did not complete. Check MemoryBooks.');
        say('The selected reply was sent to MemoryBooks. Its preview controls whether the memory is saved. Future regenerations do not undo saved memory.');
    } catch (e) { say(e.message); if (!dialog.open) dialog.showModal(); } finally { busy(false); }
}
function openReviewer() {
    if (!dialog.open) dialog.showModal();
    if (controller) return;
    try {
        if (!current || !snapshotCurrent(ctx(), current)) { selectCurrent(); issues.replaceChildren(); say('Counts are local and free. Review uses the configured OpenRouter model; revisions require your approval.'); }
    } catch (e) { say(e.message); }
}
function buildUI() {
    dialog = el('dialog'); dialog.id = 'story-review-dialog';
    const top = el('div', undefined, 'sr-top'); top.append(el('h2', 'Story Review')); button('Close', () => dialog.close(), top);
    counts = el('div', 'Open a completed story reply to count it.', 'sr-counts');
    status = el('div', 'Ready.', 'sr-status'); issues = el('div'); preview = el('div');
    const actions = el('div', undefined, 'sr-actions');
    actionButtons.push(button('Count current draft', () => { try { selectCurrent(); say('Counts updated. Planning and recognized FF panels are excluded.'); } catch(e) { say(e.message); } }, actions));
    actionButtons.push(button('Review current draft', () => void runReview(false), actions));
    cancelButton = button('Cancel request', () => { controller?.abort(); }, actions); cancelButton.disabled = true;
    const rangeLabel = el('label', 'Paragraphs to revise (for example 14–16)'); range = el('input'); range.type = 'text'; range.className = 'text_pole'; rangeLabel.append(range);
    const instructionLabel = el('label', 'What should change?'); instruction = el('textarea'); instruction.className = 'text_pole'; instructionLabel.append(instruction);
    const reviseActions = el('div', undefined, 'sr-actions');
    actionButtons.push(button('Preview targeted revision', () => void revisionPreview(), reviseActions));
    applyButton = button('Apply as new reply version', () => void applyRevision(), reviseActions); applyButton.disabled = true;
    const memoryActions = el('div', undefined, 'sr-actions'); actionButtons.push(button('Accept and save memory…', () => void acceptMemory(), memoryActions));
    const paragraphs = el('details'); paragraphs.append(el('summary', 'Show numbered story paragraphs'));
    const paragraphList = el('div'); paragraphs.append(paragraphList);
    paragraphs.addEventListener('toggle', () => { paragraphList.replaceChildren(); if (paragraphs.open && current) for (const p of current.analysis.countedParagraphs) paragraphList.append(el('p', `${p.id}. ${p.text}`)); });
    dialog.append(top, counts, status, actions, issues, paragraphs, rangeLabel, instructionLabel, reviseActions, preview, el('hr'), el('small', 'Automatic reviews never write memories. Accept only a version you intend to keep: editing or regenerating it later does not automatically remove a saved MemoryBooks entry.'), memoryActions);
    document.body.append(dialog);
    const panel = el('div'); panel.id = 'story-review-settings'; panel.append(el('strong', 'Story Review'));
    const setupStatus = el('div', 'Preparing setup…', 'sr-note'); setupStatus.id = 'story-review-setup-status'; panel.append(setupStatus);
    for (const [key, labelText] of [['enabled', 'Enable Story Review'], ['autoReview', 'Automatically review new completed replies']]) {
        const label = el('label'); const input = el('input'); input.type = 'checkbox'; input.checked = settings()[key];
        input.addEventListener('change', () => { extension_settings[KEY][key] = input.checked; ctx().saveSettingsDebounced(); if (!input.checked) invalidate(); });
        label.append(input, document.createTextNode(` ${labelText}`)); panel.append(label);
    }
    const modelLabel = el('label', 'Reviewer and revision model (OpenRouter)'); const model = el('input'); model.type = 'text'; model.className = 'text_pole'; model.value = settings().model;
    model.addEventListener('change', () => { try { const next = safeSettings({ ...settings(), model: model.value.trim() }); extension_settings[KEY].model = next.model; ctx().saveSettingsDebounced(); invalidate(); } catch(e) { model.value = settings().model; globalThis.toastr?.error(e.message); } });
    modelLabel.append(model); panel.append(modelLabel, el('p', 'This model handles standalone editorial reports and targeted revisions. Story Builder can also run two independent reviews and bounded revision rounds before showing its final preview.', 'sr-note'));
    button('Open Story Review', openReviewer, panel);
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings'); target?.append(panel);
    const menu = el('div', 'Story Review', 'list-group-item flex-container flexGap5'); menu.id = 'story-review-menu'; menu.tabIndex = 0; menu.setAttribute('role', 'button'); menu.addEventListener('click', openReviewer); menu.addEventListener('keydown', e => { if (e.key === 'Enter') openReviewer(); });
    document.getElementById('extensionsMenu')?.append(menu);
}
async function setup() {
    if (setupComplete) return;
    // Public distribution: only initialize this extension's own preferences.
    // Never change writing presets, profiles, trackers, or existing stories.
    extension_settings[KEY] = { ...DEFAULTS, ...extension_settings[KEY] };
    if (!dialog) buildUI();
    setupComplete = true;
    document.getElementById('story-review-setup-status').textContent =
        `Ready · story target ${settings().wordMin.toLocaleString()}–${settings().wordMax.toLocaleString()} words · connected to Story Builder`;
}
eventSource.on(event_types.APP_READY, () => { void setup(); });
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
    try { current = findDraft(); drawCounts(current.analysis); badge(`Story Review · ${current.analysis.words.toLocaleString()} words`); if (settings().autoReview) void runReview(true); } catch(e) { say(e.message); }
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
for (const event of [event_types.CHAT_CHANGED, event_types.MESSAGE_EDITED, event_types.MESSAGE_DELETED, event_types.MESSAGE_SWIPED]) eventSource.on(event, () => { if (!ownSwipe) invalidate(); });
