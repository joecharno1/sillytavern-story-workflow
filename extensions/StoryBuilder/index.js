import { extension_settings } from '/scripts/extensions.js';
import { eventSource, event_types } from '/scripts/events.js';
import { isGenerating } from '/script.js';
import './workflow-setup.js';
import { DEFAULTS, normalizeSettings, createJob, planJob, runJob, assembledStory, totals, updatePlan } from './builder-core.js';
import { captureSource, snapshotCurrent, applyResult } from './st-bridge.js';
import { runEditorialWorkflow } from './editorial-workflow.js';
import { loadReviewServices } from './review-loader.js';
import { createAcceptedTarget, refreshAcceptedTrackers } from './tracker-bridge.js';
import { createChatProgress, formatSpendSummary } from './chat-progress.js';
import { createSpendLedger, prepareReservation, settleRequest, failRequest, cancelReservation, spendSummary } from './spend-budget.js';
import { createChatInterceptor } from './chat-interceptor.js';
import { runChatWorkflow } from './chat-runner.js';
import { bindChatProgressLayout } from './chat-layout.js';
import { createRegenerateAction, storyTicketCurrent } from './regenerate-action.js';
import { WRITING_ASPECTS, WRITING_PRESETS, normalizePresetLibrary, buildWritingGuidance, specialistPasses } from './writing-tuning.js';

const KEY = 'StoryBuilder';
const VERSION = '0.6.0';
const ctx = () => SillyTavern.getContext();
let job = null, controller = null, operation = 0, applying = false;
let dialog, status, counts, usage, outline, draftPreview, pendingPreview, notices, panelStatus;
let prepareButton, runButton, pauseButton, applyButton, downloadButton, discardButton;
let settingsFields = [], outlineFields = [], planControls, previewDetails, pendingDetails;
let applied = false, stale = false, mounted = false;
let editorialPanel, editorialDetails, memoryButton, acceptedTarget = null, continuityPanel, continuityDetails;
let chatRunController = null, chatProgress, chatLayout, automaticVisible = false, progressStage = '', chatToggle, chatTicket = null;
let modeButton, modeNote, catalogButton, catalogNote, modelList, catalogLoading = false;
let styleControls = [], preferenceButtons = [], presetLibrary = {};
let activityEntries = [], activityEpoch = 0, activitySequence = 0, activityTimer = null;
const activityWaiters = new Map();
const ACTIVITY_STAGES = Object.freeze({
    preparing: 'Preparing story context', capture: 'Preparing story context', planning: 'Planning the story',
    planning_retry: 'Retrying the outline format', planning_ready: 'Outline accepted',
    starting_state: 'Preparing starting notes', starting_state_ready: 'Starting notes ready',
    writing: 'Writing a section', running: 'Writing a section', section_complete: 'Section accepted',
    section_rejected: 'Section needs attention', checking_section: 'Checking section continuity', section_check_complete: 'Section check received',
    reviewing: 'Reviewing the manuscript', editorial_review: 'Reviewing the manuscript', editorial_report: 'Review report accepted',
    editorial_revise: 'Revising a passage', editorial_change: 'Passage revision accepted', editorial_change_rejected: 'Previous passage kept',
    editorial_ready: 'Editorial work finished', applying: 'Adding the finished story', tracking: 'Updating story memory',
    paused: 'Workflow paused', failed: 'Workflow stopped', needs_attention: 'Workflow needs attention',
    complete: 'Workflow stage completed', ready: 'Ready to continue',
});
const activityLabel = stage => Object.hasOwn(ACTIVITY_STAGES, stage) ? ACTIVITY_STAGES[stage] : 'Story workflow';
function updateActivityTimer() {
    const waiting = activityEntries.some(entry => entry.type === 'request' && entry.status === 'waiting');
    if (waiting && activityTimer === null) activityTimer = setInterval(refreshChatProgress, 1000);
    else if (!waiting && activityTimer !== null) { clearInterval(activityTimer); activityTimer = null; }
}
function resetActivity() {
    finishPendingActivity('cancelled');
    activityEpoch++; activityEntries = []; activitySequence = 0; progressStage = '';
    if (activityTimer !== null) clearInterval(activityTimer);
    activityTimer = null;
}
function finishPendingActivity(status = 'stopped') {
    for (const finish of [...activityWaiters.values()]) finish(status);
}
function recordActivity(label, type = 'stage') {
    if (activityEntries.at(-1)?.type === type && activityEntries.at(-1)?.label === label) return;
    activityEntries.push({ id: ++activitySequence, type, label, startedAt: Date.now() });
}
function recordDiagnostic(error) {
    const message = typeof error === 'string' ? error : error?.message || '';
    let label = 'Workflow stopped. Review its status before resuming.';
    if (error?.name === 'AbortError' || /paused|cancelled|interrupted/i.test(message)) label = 'Workflow paused; completed work is preserved.';
    else if (/source.*changed|prompt.*changed|settings changed/i.test(message)) label = 'Source changed; the current work was preserved.';
    else if (/spend|budget|pricing|tokenizer/i.test(message)) label = 'The spending check stopped this request before sending. Completed work is preserved.';
    else if (/output limit|truncat/i.test(message)) label = 'The model response reached its output limit.';
    else if (/planned requirement|original brief|brief passage|source reference/i.test(message)) label = 'Outline source references could not be validated.';
    else if (/outline|planned sections|planner/i.test(message)) label = 'Outline structure or formatting could not be validated.';
    else if (/insufficient (?:credits?|funds|balance)|payment required|negative balance|request failed\s*\(402\)|HTTP\s+402\b/i.test(message)) label = 'The provider reported insufficient credit.';
    else if (/rate.limit|too many requests/i.test(message)) label = 'The provider rate limited the request.';
    else if (/prompt.{0,80}(?:too long|exceeds)|(?:do(?:es)? not|did not|no longer|cannot) fit.{0,80}(?:context|model)|exceed.{0,80}(?:context|input limit)|request failed\s*\(413\)|HTTP\s+413\b/i.test(message)) label = 'The request did not fit the model context limit.';
    else if (/continuity|quotation|evidence/i.test(message)) label = 'A continuity check could not be validated.';
    else if (/editor|review.*report/i.test(message)) label = 'An editorial response could not be validated.';
    else if (/fetch|network|connection/i.test(message)) label = 'The model connection failed.';
    else if (/request failed\s*\([45]\d\d\)|model.{0,40}(?:unavailable|no available endpoint)/i.test(message)) label = 'The provider request failed.';
    const lastDiagnostic = activityEntries.findLastIndex(entry => entry.type === 'diagnostic');
    if (lastDiagnostic >= 0 && activityEntries[lastDiagnostic].label === label
        && activityEntries.slice(lastDiagnostic + 1).every(entry => entry.type === 'stage')) return;
    recordActivity(label, 'diagnostic');
}

function linkSignal(parent, child) {
    const abort = () => child.abort(parent.reason);
    if (parent?.aborted) abort();
    else parent?.addEventListener('abort', abort, { once: true });
    return () => parent?.removeEventListener('abort', abort);
}
function memoryRequired() { return Boolean(job?.settings.editorialEnabled && job.settings.updateTracker && !(job.settings.spendLimitUsd > 0)); }
function currentSpend() {
    if (job?.spend) return spendSummary(job.spend);
    const requests = activityEntries.filter(entry => entry.type === 'request' && entry.status !== 'waiting');
    const reported = requests.filter(entry => Number.isFinite(entry.costUsd) && entry.costUsd >= 0);
    return { limitUsd: job?.settings.spendLimitUsd || 0, reportedUsd: reported.reduce((sum, entry) => sum + entry.costUsd, 0),
        reportedRequests: reported.length, unreportedRequests: requests.length - reported.length };
}
function workflowFinished() { return applied && (!memoryRequired() || acceptedTarget?.status === 'complete'); }
function ticketCurrent() {
    return !chatTicket || storyTicketCurrent(ctx(), chatTicket);
}
function workflowState() {
    return { hasJob: Boolean(job), hasPlan: Boolean(job?.plan), writingComplete: job?.status === 'complete',
        editorialReady: editorialReady(), error: job?.error || '', applied, memoryRequired: memoryRequired(),
        memoryComplete: acceptedTarget?.status === 'complete', canTrack: Boolean(acceptedTarget),
        sourceCurrent: job ? !applied && sourceCurrent() : !stale && ticketCurrent() };
}
function refreshChatProgress() {
    if (!chatProgress) return;
    const busy = Boolean(controller || chatRunController || applying);
    chatProgress.update({ visible: automaticVisible, busy, stage: progressStage,
        message: status?.textContent || '', counts: job ? { ...safeTotals(),
            completedReviews: job.editorial?.reports?.length || 0, completedRevisions: job.editorial?.changes?.length || 0,
            completedChecks: job.settings.continuityEnabled ? job.continuity?.acceptedFrames?.length || 0 : undefined } : '',
        canResume: !busy && !workflowFinished() && (applied ? Boolean(acceptedTarget) : job ? sourceCurrent() : !stale && ticketCurrent()),
        canDownload: Boolean(safeTotals().completedSections), canDismiss: !busy,
        activity: activityEntries, now: Date.now(), spend: currentSpend() });
    syncGenerationMode();
    chatLayout?.refresh();
}
function setStage(stage) {
    if (stage !== progressStage) recordActivity(activityLabel(stage));
    progressStage = stage; refreshChatProgress();
}
function pauseWorkflow() {
    chatInterceptor.cancel(); chatRunController?.abort(); controller?.abort();
    setStage('paused'); say('Pausing. Completed sections and reviews are kept in this tab.');
}
function syncGenerationMode() {
    const enabled = getSettings().chatWorkflowEnabled;
    if (chatToggle) { chatToggle.checked = enabled; chatToggle.disabled = false; }
    if (modeButton) {
        modeButton.textContent = enabled ? 'Generation: Story Builder' : 'Generation: Standard';
        modeButton.setAttribute('aria-pressed', String(enabled));
        modeButton.title = enabled ? 'Switch to standard SillyTavern generation. Running story work will pause.' : 'Switch to the Story Builder workflow for your next Send or Regenerate.';
        modeButton.dataset.ntTopbarLabel = modeButton.textContent;
    }
    if (modeNote) modeNote.textContent = job && !workflowFinished()
        ? 'Your staged story is kept. A new message or changed chat can prevent resuming it; download completed work first.'
        : enabled ? 'Paste your prompt in chat, then Send. Story Builder plans, writes, and reviews.' : 'Send and Regenerate use your usual SillyTavern generation.';
}
function setGenerationMode(enabled) {
    extension_settings[KEY] = { ...getSettings(), chatWorkflowEnabled: enabled === true };
    ctx().saveSettingsDebounced();
    if (!enabled) {
        chatInterceptor.cancel();
        if (controller || chatRunController) {
            chatRunController?.abort(); controller?.abort(); automaticVisible = true;
            setStage('paused'); say('Switching to Standard. Pausing story work; completed sections remain available. The next Send or Regenerate uses ordinary generation.');
        }
    }
    syncGenerationMode(); refreshControls();
}
async function automaticStory({ fresh = false, ticket } = {}) {
    if (chatRunController || controller || applying) return;
    if (fresh && workflowFinished()) discard();
    if (fresh) { chatTicket = ticket; stale = false; }
    automaticVisible = true;
    const run = new AbortController(); chatRunController = run;
    try {
        const outcome = await runChatWorkflow({ getState: workflowState,
            prepare: () => prepare({ signal: run.signal }), generate: () => generate({ signal: run.signal }),
            apply: () => apply({ signal: run.signal, deferMemory: true }), updateMemory: () => updateMemory(run.signal),
            onStage: setStage }, { signal: run.signal });
        setStage(outcome.status === 'complete' ? 'complete' : outcome.status);
        if (outcome.error) { recordDiagnostic(outcome.error); say(typeof outcome.error === 'string' ? outcome.error : outcome.error.message || 'The workflow needs attention. View details, then resume.'); }
        else if (outcome.status === 'paused') say(applied
            ? memoryRequired() ? 'Your story is saved in chat. Resume to finish its continuity update.' : 'Your story is saved in chat. Automatic continuity updating is off.'
            : 'Paused. Resume continues from the unfinished stage. Completed work is kept in this tab.');
    } finally {
        finishPendingActivity(run.signal.aborted ? 'cancelled' : 'stopped');
        if (chatRunController === run) chatRunController = null;
        refreshControls();
    }
}
const chatInterceptor = createChatInterceptor({ getContext: ctx, isGenerating,
    isEnabled: () => mounted && getSettings().chatWorkflowEnabled,
    isBusy: () => Boolean(chatRunController || controller || applying || (job && !workflowFinished())),
    onStart: ticket => automaticStory({ fresh: true, ticket }),
    onBlocked: reason => { automaticVisible = true; setStage('needs_attention'); say(`${reason} Your new prompt is saved. View details to download or discard the unfinished job before starting another story.`); refreshControls(); },
    onError: error => { automaticVisible = true; setStage('needs_attention'); say(error.message || 'Story Builder could not start. View details to retry.'); refreshControls(); },
});
const regenerateAction = createRegenerateAction({ getContext: ctx, isGenerating,
    isEnabled: () => mounted && getSettings().chatWorkflowEnabled,
    isBusy: () => Boolean(chatRunController || controller || applying || (job && !workflowFinished())),
    hasUnsavedEdit: () => Boolean(document.querySelector?.('#chat .edit_textarea, #chat .reasoning_edit_textarea')),
    onStart: ticket => { chatInterceptor.cancel(); return automaticStory({ fresh: true, ticket }); },
    onBlocked: reason => { automaticVisible = true; setStage('needs_attention'); say(reason); refreshControls(); },
    onError: error => { automaticVisible = true; setStage('needs_attention'); say(error.message || 'Story Builder could not start. View details to retry.'); refreshControls(); },
});
globalThis.StoryBuilder_Intercept = (...args) => chatInterceptor.intercept(...args);

function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function button(text, action, parent, className = '') {
    const node = el('button', text, `menu_button ${className}`.trim());
    node.type = 'button'; node.addEventListener('click', action); parent.append(node); return node;
}
function say(text) { if (status) status.textContent = text; if (panelStatus) panelStatus.textContent = text; refreshChatProgress(); }
function safeTotals() {
    if (!job) return { words: 0, paragraphs: 0, completedSections: 0, totalSections: 0 };
    const t = totals(job), a = job.editorial?.analysis;
    return a && Number.isFinite(a.words) ? { ...t, words: a.words, paragraphs: a.paragraphs,
        wordTargetMet: a.words >= job.settings.wordMin && a.words <= job.settings.wordMax,
        paragraphTargetMet: a.paragraphs >= job.settings.paragraphMin && a.paragraphs <= job.settings.paragraphMax } : t;
}
function finalText() { return job?.editorial?.text ?? (job ? assembledStory(job) : ''); }
function editorialReady() {
    const t = safeTotals();
    return !job?.settings.editorialEnabled || (job.editorial?.status === 'ready' && t.wordTargetMet
        && (!job.settings.strictParagraphs || t.paragraphTargetMet) && job.editorial.targetChecks?.formatValid !== false);
}
function sourceCurrent() {
    return Boolean(job && !stale && snapshotCurrent(job.source.snapshot));
}
function getSettings() { return normalizeSettings({ ...DEFAULTS, ...extension_settings[KEY] }); }
function storeSettings() {
    const next = { ...getSettings() };
    for (const { input, key, numeric, checkbox } of settingsFields) next[key] = checkbox ? input.checked : numeric ? Number(input.value) : input.value.trim();
    next.writingPresetLibrary = presetLibrary;
    next.writingStyles = Object.fromEntries(styleControls.map(({ aspect, preset, custom, model }) => [aspect.id,
        { preset: preset.value, custom: custom.value, model: model.value.trim() }]));
    const validated = normalizeSettings(next);
    // Only preferences are saved. Source prompts, outlines, and drafts stay in this tab's memory.
    extension_settings[KEY] = validated;
    ctx().saveSettingsDebounced();
    return validated;
}
function transport(signal) {
    const epoch = activityEpoch, owner = job;
    return { headers: ctx().getRequestHeaders(), signal, isCurrent: snapshotCurrent,
        fetcher: async (url, options) => {
            if (url !== '/api/backends/chat-completions/generate') return fetch(url, options);
            let model, body, ticket, dispatched = false;
            const ledger = owner?.settings.spendLimitUsd > 0 ? (owner.spend ||= createSpendLedger(owner.settings.spendLimitUsd)) : null;
            const assertCurrent = () => {
                signal?.throwIfAborted();
                if (owner !== job || epoch !== activityEpoch || !sourceCurrent()) throw new Error('The source changed. No new request was sent.');
            };
            try { body = JSON.parse(options.body); const value = body.model; if (typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/.test(value)) model = value; } catch { /* No body content is recorded. */ }
            try {
                assertCurrent();
                if (ledger) {
                    recordActivity('Checking the estimated request cost.'); refreshChatProgress();
                    ticket = await prepareReservation(ledger, body, { fetcher: fetch, headers: options.headers, signal, assertCurrent });
                }
                assertCurrent();
            } catch (error) {
                if (ticket) cancelReservation(ledger, ticket);
                if (epoch === activityEpoch && error?.name !== 'AbortError') {
                    recordActivity('Request blocked before sending. Completed work is preserved.', 'blocked');
                    refreshChatProgress();
                }
                throw error;
            }
            const entry = { id: ++activitySequence, type: 'request', label: activityLabel(progressStage),
                model, startedAt: Date.now(), status: 'waiting' };
            if (Number.isSafeInteger(body?.max_tokens) && body.max_tokens >= 0) entry.maxOutputTokens = body.max_tokens;
            if (ticket) { entry.reservedCostUsd = ticket.reservedUsd; entry.estimatedInputTokens = ticket.estimatedInputTokens; }
            if (epoch === activityEpoch) { activityEntries.push(entry); updateActivityTimer(); refreshChatProgress(); }
            let ended = false;
            const finish = (status, metadata = {}) => {
                // Late usage may reconcile a cancellation without accepting its result.
                if (ended) {
                    if (epoch === activityEpoch) { Object.assign(entry, metadata); refreshChatProgress(); }
                    return;
                }
                ended = true;
                if (ticket && status !== 'received') {
                    if (dispatched) failRequest(ledger, ticket); else cancelReservation(ledger, ticket);
                }
                if (activityWaiters.get(entry.id) === finish) activityWaiters.delete(entry.id);
                signal?.removeEventListener('abort', aborted);
                if (epoch !== activityEpoch) return;
                const endedAt = Date.now();
                Object.assign(entry, metadata, { status, endedAt, elapsedMilliseconds: Math.max(0, endedAt - entry.startedAt) });
                updateActivityTimer(); refreshChatProgress();
            };
            const aborted = () => finish('cancelled');
            activityWaiters.set(entry.id, finish);
            signal?.addEventListener('abort', aborted, { once: true });
            if (signal?.aborted) aborted();
            try {
                assertCurrent();
                dispatched = true;
                const response = await fetch(url, options);
                if (!ended && epoch === activityEpoch) entry.httpStatus = response.status;
                const readJson = response.json.bind(response);
                // Buffer once before the caller's source guard, so paid usage
                // survives a stale-source or schema rejection. Replay the exact
                // parsed object, without retaining it in activity or the ledger.
                let data, readError;
                try {
                    data = await readJson();
                    const choice = data?.choices?.[0], usage = data?.usage;
                    if (ticket) settleRequest(ledger, ticket, usage);
                    const metadata = { httpStatus: response.status };
                    if (typeof choice?.message?.content === 'string') metadata.outputCharacters = choice.message.content.length;
                    if (['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(choice?.finish_reason)) metadata.finishReason = choice.finish_reason;
                    for (const [value, target] of [[usage?.prompt_tokens, 'inputTokens'], [usage?.completion_tokens, 'outputTokens'], [usage?.total_tokens, 'totalTokens'],
                        [usage?.completion_tokens_details?.reasoning_tokens, 'reasoningTokens'], [usage?.prompt_tokens_details?.cached_tokens, 'cachedInputTokens']]) {
                        if (Number.isSafeInteger(value) && value >= 0) metadata[target] = value;
                    }
                    if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) metadata.costUsd = usage.cost;
                    finish('received', metadata);
                } catch (error) { readError = error; finish(error?.name === 'AbortError' ? 'cancelled' : 'failed', { httpStatus: response.status }); }
                response.json = async () => { if (readError) throw readError; return data; };
                return response;
            } catch (error) { finish(error?.name === 'AbortError' ? 'cancelled' : 'failed'); throw error; }
        },
    };
}
function acceptedNotes() {
    return (job?.sections || []).map(section => {
        const seen = new Set(), parts = [];
        for (const [label, value] of [['FF planning', section.reasoning], ['Provider reasoning', section.providerReasoning], ['FF state panels', section.auxiliary]]) {
            if (typeof value !== 'string' || !value.trim() || seen.has(value.trim())) continue;
            seen.add(value.trim()); parts.push(`### ${label}\n\n${value.trim()}`);
        }
        return parts.length ? `## Section ${section.id}\n\n${parts.join('\n\n')}` : '';
    }).filter(Boolean).join('\n\n');
}
function refreshControls() {
    const busy = Boolean(controller || chatRunController) || applying, hasPlan = Boolean(job?.plan), t = safeTotals();
    const editingPending = job?.status === 'complete' && job.settings.editorialEnabled && job.editorial?.status !== 'ready';
    const resumable = ['ready', 'paused', 'needs_attention', 'failed'].includes(job?.status) || editingPending;
    prepareButton.disabled = busy || Boolean(job);
    runButton.disabled = busy || !hasPlan || !resumable || !sourceCurrent();
    runButton.textContent = job?.status === 'needs_attention' || (job?.status === 'failed' && hasPlan)
        ? 'Retry unfinished section' : t.completedSections ? 'Resume full story' : 'Generate full story';
    if (editingPending) runButton.textContent = 'Resume review and revisions';
    pauseButton.disabled = !controller && !chatRunController;
    applyButton.disabled = busy || applied || job?.status !== 'complete' || !editorialReady() || !sourceCurrent() || isGenerating();
    if (memoryButton) { memoryButton.hidden = !acceptedTarget || !memoryRequired(); memoryButton.disabled = busy || isGenerating() || acceptedTarget?.status === 'complete'; }
    downloadButton.disabled = !t.completedSections;
    downloadButton.textContent = job?.status === 'complete' ? 'Download plain-text story' : 'Download partial plain-text story';
    discardButton.disabled = busy || !job;
    settingsFields.forEach(({ input }) => { input.disabled = busy || Boolean(job); });
    for (const control of styleControls) for (const input of [control.preset, control.custom, control.model, control.name, control.save, control.remove]) input.disabled = busy || Boolean(job);
    for (const control of styleControls) if (!presetLibrary[control.aspect.id]?.some(value => value.id === control.preset.value)) control.remove.disabled = true;
    preferenceButtons.forEach(input => { input.disabled = busy || Boolean(job); });
    if (catalogButton) catalogButton.disabled = busy || Boolean(job) || catalogLoading;
    const spendingField = settingsFields.find(field => field.key === 'spendLimitUsd');
    const trackerField = settingsFields.find(field => field.key === 'updateTracker');
    if (Number(spendingField?.input.value) > 0 && trackerField) { trackerField.input.checked = false; trackerField.input.disabled = true; }
    outlineFields.forEach(input => { input.disabled = busy || t.completedSections > 0 || job?.status === 'complete'; });
    counts.textContent = job
        ? `${t.completedSections} / ${t.totalSections || job.settings.sectionCount} sections · ${t.words.toLocaleString()} words · ${t.paragraphs} paragraphs`
        : `Target: ${getSettings().wordMin.toLocaleString()}–${getSettings().wordMax.toLocaleString()} words · ${getSettings().paragraphMin}–${getSettings().paragraphMax} paragraphs`;
    if (job?.status === 'complete') {
        counts.append(el('span', t.wordTargetMet ? ' · Word target met' : ' · Word target missed', t.wordTargetMet ? 'sb-success' : 'sb-warning'));
        counts.append(el('span', t.paragraphTargetMet ? ' · Paragraph target met' : job.settings.strictParagraphs === false ? ' · Paragraph target missed (reported only)' : ' · Paragraph target missed', t.paragraphTargetMet ? 'sb-success' : 'sb-warning'));
    }
    const calls = Number.isSafeInteger(job?.calls) && job.calls >= 0 ? job.calls : 0;
    usage.textContent = job
        ? `Workflow requests attempted: ${calls} (includes blocked attempts). ${formatSpendSummary(currentSpend())}`
        : 'No model requests made.';
    planControls.hidden = !hasPlan;
    previewDetails.hidden = !t.completedSections;
    pendingDetails.hidden = !job?.pending;
    notices.replaceChildren();
    if (job?.status === 'complete' && job.settings.strictParagraphs === false && !t.paragraphTargetMet) notices.append(el('p', `The draft has ${t.paragraphs} paragraphs; the suggested range is ${job.settings.paragraphMin}–${job.settings.paragraphMax}. Flexible paragraph mode allows this so dialogue can keep its natural breaks. The word target still applies.`, 'sb-warning'));
    if (!applied && (stale || (job && !snapshotCurrent(job.source.snapshot)))) notices.append(el('p', 'Your chat, prompt, or writing settings changed. This job is paused and cannot be added to that changed source. Download any completed sections, then prepare a fresh outline.', 'sb-warning'));
    if (job?.pending?.issues?.length) {
        const list = el('ul');
        for (const issue of job.pending.issues) list.append(el('li', typeof issue === 'string' ? issue : issue.message || 'This section needs attention.'));
        notices.append(el('p', 'The last attempt did not pass the section checks. It has not been included in the combined story.', 'sb-warning'), list);
    }
    renderPreview();
    renderEditorial();
    renderContinuity();
    refreshChatProgress();
}
function renderContinuity() {
    if (!continuityDetails) return;
    const continuity = job?.continuity;
    continuityDetails.hidden = !continuity;
    continuityPanel.replaceChildren();
    if (!continuity || !continuityDetails.open) return;
    if (continuity.initialState) {
        continuityPanel.append(el('h3', 'Starting state'), el('p', continuity.initialState.summary));
        if (continuity.initialStatePreparation?.status === 'source_only') {
            continuityPanel.append(el('p', continuity.initialStatePreparation.message, 'sb-note'));
        }
        if (continuity.initialStateValidation?.omittedFacts) {
            const validation = continuity.initialStateValidation;
            continuityPanel.append(el('p', `Kept ${validation.verifiedFacts} starting note(s) with matching source quotations; omitted ${validation.omittedFacts} whose quotations could not be matched. The summary was rebuilt from the retained notes and other extracted notes were cleared. Your full source remains available to every writing stage. A matching quotation does not by itself prove the model interpreted it correctly.`, 'sb-note'));
        }
        const facts = el('ul');
        for (const item of continuity.initialState.facts) facts.append(el('li', item.fact));
        continuityPanel.append(facts);
        if (continuity.initialState.unknowns.length) continuityPanel.append(el('p', `Left unspecified: ${continuity.initialState.unknowns.join(' · ')}`));
    }
    for (const frame of continuity.acceptedFrames || []) {
        const details = el('details');
        details.append(el('summary', `Section ${frame.sectionId} · continuity checked`), el('p', frame.endState.summary));
        if (frame.endStateValidation?.omittedFacts) {
            const validation = frame.endStateValidation;
            details.append(el('p', `Kept ${validation.verifiedFacts} end-state note(s) with matching source quotations; omitted ${validation.omittedFacts}. The full source and accepted prose remain available.`, 'sb-note'));
        }
        if (frame.ignoredReviewFields) details.append(el('p', `${frame.ignoredReviewFields} unrequested review field(s) were excluded. All required findings and evidence were still checked.`, 'sb-note'));
        if (frame.omittedAdvisories) details.append(el('p', `${frame.omittedAdvisories} advisory suggestion(s) were omitted because their evidence could not be matched. Serious contradiction findings must still pass validation before the section can advance.`, 'sb-note'));
        const issues = el('ul');
        for (const issue of frame.report.issues) issues.append(el('li', `${issue.severity}: ${issue.problem} ${issue.suggestion}`));
        details.append(issues); continuityPanel.append(details);
    }
    if (job.pending?.continuityReport) {
        continuityPanel.append(el('h3', 'Unfinished section findings'));
        const issues = el('ul');
        for (const issue of job.pending.continuityReport.issues) issues.append(el('li', `${issue.severity}: ${issue.problem} ${issue.suggestion}`));
        continuityPanel.append(issues);
    }
    continuityPanel.append(el('p', 'These notes describe the drafting checkpoints. Final editorial revisions can change the manuscript. Optional tracker updates use the delivered version and stay manual while a spending limit is active.', 'sb-note'));
}
function renderEditorial() {
    if (!editorialPanel) return;
    const edit = job?.editorial; editorialDetails.hidden = !edit; editorialPanel.replaceChildren();
    if (!edit) return;
    editorialPanel.append(el('p', `${edit.changes?.length || 0} targeted revision(s). ${edit.unresolved?.length || 0} finding(s) remain for your judgment.`));
    if (edit.unresolved?.length) {
        editorialPanel.append(el('h3', 'Remaining findings'));
        const list = el('ul');
        for (const issue of edit.unresolved) list.append(el('li', `${issue.severity} · ${issue.category}: ${issue.problem} ${issue.suggestion || ''} ${issue.reason || ''}`));
        editorialPanel.append(list, el('p', 'Some findings were carried forward from an earlier draft. Their original paragraph numbers are available in the historical reports below; review the current passage before editing.', 'sb-note'));
    }
    for (const item of edit.reports || []) {
        const report = item.report || item;
        const label = item.focus === 'continuity' ? 'Continuity and instructions' : item.focus === 'prose' ? 'Prose and pacing'
            : WRITING_ASPECTS.find(aspect => aspect.id === item.focus)?.label || 'Additional review';
        const box = el('details'); box.append(el('summary', `${label} · review ${(item.cycle ?? 0) + 1}`), el('p', report.summary || 'Review complete.'));
        const list = el('ul');
        for (const issue of report.issues || []) list.append(el('li', `${issue.severity} · ${issue.category}: ${issue.problem} ${issue.suggestion}`));
        box.append(list); editorialPanel.append(box);
    }
    if (edit.error) editorialPanel.append(el('p', edit.error, 'sb-warning'));
    if (edit.status === 'ready' && !editorialReady()) editorialPanel.append(el('p', 'The revised draft missed a required length or format check. Download the preview for inspection; it has not been added to chat.', 'sb-warning'));
}
function readableStory(text, labelInserts = true) {
    // Complete FF graphics blocks and known inline formatting become plain text.
    // Do not parse HTML into a DOM: styled inserts may contain arbitrary markup.
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };
    return String(text || '').replace(/<!--\s*GFX_START\s*-->([\s\S]*?)<!--\s*GFX_END\s*-->/gi, (_block, content) => {
        const readable = content
            .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
            .replace(/<br\b[^>]*\/?\s*>/gi, '\n')
            .replace(/<\/(?:div|p|section|article|header|footer|li|tr|h[1-6]|blockquote|table)\s*>/gi, '\n')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g, '')
            .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash);/gi, (entity, code) => {
                if (code[0] !== '#') return named[code.toLowerCase()] ?? entity;
                const value = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
                return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
            })
            .replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        return labelInserts ? `\n[FF formatted insert]\n${readable}\n[/FF formatted insert]\n` : `\n${readable}\n`;
    }).replace(/<\/?(?:font|span|b|strong|i|em|u|s)(?=[\s/>])[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi, '');
}
function renderPreview() {
    draftPreview.textContent = previewDetails.open && job ? readableStory(finalText()) : '';
    pendingPreview.textContent = pendingDetails.open && job?.pending ? readableStory(job.pending.text || '') : '';
}
function readOutlineEdits() {
    const plan = structuredClone(job.plan);
    for (const input of outlineFields) plan.sections[Number(input.dataset.section)][input.dataset.field] = input.value.trim();
    updatePlan(job, plan);
}
function renderOutline() {
    outline.replaceChildren(); outlineFields = [];
    if (!job?.plan) return;
    const intro = el('p', 'Check the section order and directions before generating. Your full original brief remains part of every writing request.', 'sb-note');
    outline.append(intro);
    const requirements = el('details'); requirements.append(el('summary', 'Required beats and fixed facts'));
    const required = el('ol');
    for (const beat of job.plan.requiredBeats || []) {
        const row = el('li', beat.requirement || beat.briefQuote);
        if (beat.requirement && beat.briefQuote) {
            const evidence = el('details'); evidence.append(el('summary', 'Source passage'), el('p', beat.briefQuote)); row.append(evidence);
        }
        required.append(row);
    }
    requirements.append(required);
    if (job.plan.fixedFacts?.length) {
        const facts = el('ul'); for (const fact of job.plan.fixedFacts) facts.append(el('li', fact)); requirements.append(facts);
    }
    if (job.plan.finalRequirements?.length) {
        const ends = el('ul'); for (const fact of job.plan.finalRequirements) ends.append(el('li', fact)); requirements.append(el('strong', 'Ending requirements'), ends);
    }
    outline.append(requirements);
    job.plan.sections.forEach((section, index) => {
        const card = el('section', undefined, 'sb-section');
        card.append(el('h3', `Section ${index + 1}`));
        for (const [key, labelText, multiline] of [['title', 'Section title', false], ['startState', 'Starts with', true], ['endState', 'Ends with', true], ['direction', 'Additional direction (optional)', true]]) {
            const label = el('label', labelText), input = el(multiline ? 'textarea' : 'input');
            if (!multiline) input.type = 'text';
            input.className = 'text_pole'; input.value = section[key] || ''; input.dataset.section = String(index); input.dataset.field = key;
            outlineFields.push(input); label.append(input); card.append(label);
        }
        const beats = (section.beatIds || []).map(id => { const beat = job.plan.requiredBeats.find(b => b.id === id); return beat?.requirement || beat?.briefQuote; }).filter(Boolean);
        if (beats.length) { const list = el('ul'); beats.forEach(beat => list.append(el('li', beat))); card.append(el('strong', 'Brief details assigned here'), list); }
        outline.append(card);
    });
}
async function prepare({ signal } = {}) {
    if (controller || job?.plan) return;
    const token = ++operation;
    controller = new AbortController();
    const detach = linkSignal(signal, controller);
    try {
        controller.signal.throwIfAborted();
        if (isGenerating()) throw new Error('Wait for SillyTavern to finish its current reply.');
        if (!job && (stale || !ticketCurrent())) throw new Error('The saved prompt changed before preparation. Send the prompt again to start a fresh story.');
        if (job && !sourceCurrent()) throw new Error('The source changed. Download any completed work and discard this job before starting again.');
        if (!job) {
            resetActivity(); automaticVisible = true;
            stale = false; applied = false;
            const preferences = storeSettings();
            setStage('preparing'); say('Preparing your current brief with its active preset and context…'); refreshControls();
            const source = await captureSource({ signal: controller.signal });
            if (token !== operation || controller.signal.aborted) return;
            if (!ticketCurrent()) { stale = true; throw new Error('The saved prompt changed during preparation. Send it again to start a fresh story.'); }
            job = createJob(source, preferences);
            if (job.settings.spendLimitUsd > 0) job.spend = createSpendLedger(job.settings.spendLimitUsd);
        }
        setStage('planning');
        say('Planning the story sections. This is a paid model request; no story has been added to chat.');
        await planJob(job, transport(controller.signal), { onProgress(progress) {
            if (token === operation) { setStage(progress.stage || 'planning'); if (progress.stage === 'planning_retry') recordDiagnostic(progress.message); say(progress.message); refreshControls(); }
        } });
        if (token !== operation || controller.signal.aborted) return;
        if (!sourceCurrent()) throw new Error('The source changed during planning. Prepare a new outline.');
        renderOutline();
        say(chatRunController ? 'Outline ready. Starting the story…' : `Outline ready. Writer: ${job.settings.writerModel || job.source.model}. Check the plan, then choose Generate full story.`);
    } catch (error) {
        if (token === operation) { recordDiagnostic(error); say(error?.name === 'AbortError' ? 'Planning paused. Resume to retry the outline.' : error.message || 'The outline could not be prepared.'); }
    } finally {
        detach();
        if (token === operation) { finishPendingActivity(controller?.signal.aborted ? 'cancelled' : 'stopped'); controller = null; refreshControls(); }
    }
}
async function generate({ signal } = {}) {
    if (controller || !job?.plan) return;
    const token = ++operation;
    let detach = () => {};
    try {
        signal?.throwIfAborted();
        if (!sourceCurrent()) throw new Error('The source changed. Download completed sections, then prepare a fresh outline.');
        if (isGenerating()) throw new Error('Wait for SillyTavern to finish its current reply.');
        if (!safeTotals().completedSections) readOutlineEdits();
        controller = new AbortController(); detach = linkSignal(signal, controller); setStage('writing'); refreshControls();
        if (job.status !== 'complete') await runJob(job, transport(controller.signal), {
            signal: controller.signal,
            onProgress(progress) {
                if (token !== operation) return;
                if (!sourceCurrent()) { stale = true; controller?.abort(); return; }
                const section = Number.isInteger(progress.section) ? `Section ${progress.section} of ${progress.total || job.settings.sectionCount}. ` : '';
                setStage(progress.stage || 'writing');
                say(section + (progress.message || 'Writing…'));
                refreshControls();
            },
        });
        if (token !== operation) return;
        controller.signal.throwIfAborted();
        if (job.status === 'complete' && job.settings.editorialEnabled) {
            setStage('reviewing'); say('The draft is written. Starting independent continuity and prose reviews…'); refreshControls();
            const services = await loadReviewServices();
            controller.signal.throwIfAborted();
            const editorialTransport = { ...transport(controller.signal),
                assertCurrent: () => { if (!sourceCurrent()) throw new Error('The source changed. The staged draft is preserved.'); },
                onRequest: () => { job.calls = (job.calls || 0) + 1; refreshControls(); },
                onUsage: value => { job.usage ||= { inputTokens: 0, outputTokens: 0, cost: 0 }; job.usage.inputTokens += Number(value.prompt_tokens) || 0; job.usage.outputTokens += Number(value.completion_tokens) || 0; job.usage.cost += Number(value.cost) || 0; },
            };
            await runEditorialWorkflow(job, services, editorialTransport, {
                signal: controller.signal, maxCycles: job.settings.revisionCycles, maxGroupsPerCycle: job.settings.maxRevisionPassages,
                settings: { model: job.settings.reviewerModel, revisionModel: job.settings.revisionModel || job.settings.reviewerModel,
                    writingGuidance: buildWritingGuidance(job.settings), specialists: specialistPasses(job.settings),
                    maxOutput: 16384, wordMin: job.settings.wordMin, wordMax: job.settings.wordMax, paragraphMin: job.settings.paragraphMin, paragraphMax: job.settings.paragraphMax },
                onProgress(progress) { if (token === operation) { setStage(progress.stage || 'reviewing'); say(progress.message || 'Reviewing the manuscript…'); refreshControls(); } },
            });
            if (token !== operation) return;
        }
        if (!sourceCurrent()) { stale = true; say('The source changed. Completed sections are available to download; applying is disabled.'); }
        else if (job.status === 'complete') {
            const measured = safeTotals();
            if (job.settings.editorialEnabled) say(`Review and revisions finished. ${job.editorial.changes?.length || 0} targeted change(s); ${job.editorial.unresolved?.length || 0} finding(s) remain in View details. ${measured.wordTargetMet ? 'The word target is met.' : 'The word target was missed; adding to chat is disabled.'} ${chatRunController ? 'Preparing the finished story for chat.' : `Preview the draft and reports, then add the version you want to keep. ${memoryRequired() ? 'Continuity updates after you add it.' : 'Automatic continuity updating is off.'}`}`);
            else say(`The combined draft meets the word target. ${measured.paragraphTargetMet ? 'The paragraph target is also met.' : 'The paragraph count is outside the suggested range; flexible paragraph mode allows it.'} Preview it before adding it to chat. These checks do not guarantee every creative instruction was followed. Memory is unchanged.`);
        }
        else if (job.status === 'needs_attention') say('A section did not pass the checks after the bounded attempts. Completed sections are preserved. Check the issue below before retrying; another attempt is a paid request.');
        else if (job.status === 'paused') say('Paused. Completed sections are preserved in this tab. Resume continues from the unfinished section.');
        else say(job.error || 'The job stopped before completion. Completed sections are preserved.');
    } catch (error) {
        if (token === operation) { recordDiagnostic(error); say(error?.name === 'AbortError' ? 'Paused. Completed sections remain in this tab.' : error.message || 'Story generation stopped.'); }
    } finally { detach(); if (token === operation) { finishPendingActivity(controller?.signal.aborted ? 'cancelled' : 'stopped'); controller = null; refreshControls(); } }
}
async function apply({ signal, deferMemory = false } = {}) {
    if (controller || applying || !job || job.status !== 'complete' || !editorialReady() || applied) return;
    try {
        signal?.throwIfAborted();
        if (!sourceCurrent()) throw new Error('The source changed. This draft cannot be added to the changed source.');
        if (isGenerating()) throw new Error('Wait for SillyTavern to finish its current reply.');
        applying = true; setStage('applying'); refreshControls();
        const reasoning = acceptedNotes();
        const text = finalText();
        const result = await applyResult(job.source.snapshot, text, { model: job.settings.writerModel || job.source.model, reasoning,
            originalDraft: job.editorial?.changes?.length ? assembledStory(job) : '',
            workflow: job.editorial ? { version: 1, reviewCount: job.editorial.reports?.length || 0, revisionCount: job.editorial.changes?.length || 0, unresolvedCount: job.editorial.unresolved?.length || 0 } : undefined });
        applied = true;
        if (result?.rendered === false) say('The active chat changed while saving. The preview is still available; download it and check the source chat before closing this tab. No memory was created.');
        else if (job.settings.editorialEnabled) {
            acceptedTarget = createAcceptedTarget(ctx(), result, text.trim());
            await eventSource.emit('story_workflow_review_ready', { index: result.index, text: text.trim(), reports: job.editorial.reports, changes: job.editorial.changes?.length || 0, remaining: job.editorial.unresolved });
            if (memoryRequired() && !deferMemory) await updateMemory(signal);
            else if (memoryRequired()) say('Your finished story is saved in chat. Updating continuity next…');
            else say('Added the reviewed story. Earlier versions are preserved in the swipe arrows. Continuity updating is off.');
        } else say(`Added the combined story to chat. An existing reply is preserved as its earlier swipe. ${reasoning ? 'Accepted planning and FF state panels are preserved in the reply’s reasoning details. ' : ''}No memory was created. You can use Story Review manually when you are ready.`);
    } catch (error) { recordDiagnostic(error); say(error.message || 'The story could not be added to chat. It is still available to download.'); }
    finally { applying = false; refreshControls(); }
}
async function updateMemory(signal) {
    if (!acceptedTarget || controller) return;
    if (job?.settings.spendLimitUsd > 0) { say('Automatic zTracker updates are off while a spending limit is active because those requests cannot use this budget. Your story is preserved.'); refreshControls(); return; }
    if (isGenerating()) { say('Wait for the current reply to finish before updating continuity.'); refreshControls(); return; }
    controller = new AbortController(); const detach = linkSignal(signal, controller); setStage('tracking'); refreshControls();
    try {
        controller.signal.throwIfAborted();
        await refreshAcceptedTrackers(acceptedTarget, { getContext: ctx, signal: controller.signal,
            onProgress(progress) { say(progress.message || 'Updating continuity from the accepted story…'); } });
        say('Finished: the reviewed story is in chat, earlier versions are preserved, and scene and plot continuity are updated.');
    } catch (error) {
        recordDiagnostic(error);
        say(`The story was added, but continuity updating did not finish. ${error.message || 'Retry the continuity update.'} Use Update continuity to retry without adding the story again.`);
    } finally { detach(); controller = null; refreshControls(); }
}
function download() {
    if (!job || !safeTotals().completedSections) return;
    const text = readableStory(finalText(), false), url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = el('a'); link.href = url; link.download = `story-builder-${job.status === 'complete' ? 'story' : 'partial'}-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadActivity() {
    if (!activityEntries.length) return;
    const text = JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(),
        contents: 'Timing, stage labels, model IDs, status, numeric usage and spending metadata, and fixed diagnostics only.',
        spend: currentSpend(),
        entries: activityEntries.map(entry => ({ ...entry, ...(entry.type === 'request' ? { elapsedMilliseconds: Math.max(0, (entry.endedAt ?? Date.now()) - entry.startedAt) } : {}) })) }, null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const link = el('a'); link.href = url; link.download = `story-builder-activity-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function discard() {
    if (controller || chatRunController || applying) return;
    chatInterceptor.cancel(); automaticVisible = false; progressStage = ''; chatTicket = null;
    job = null; stale = false; applied = false; acceptedTarget = null; operation++;
    resetActivity();
    outline.replaceChildren(); outlineFields = []; draftPreview.textContent = ''; pendingPreview.textContent = '';
    previewDetails.open = false; pendingDetails.open = false;
    say('Job discarded. Your chat and memories are unchanged.'); refreshControls();
}
function open() { if (!dialog.open) dialog.showModal(); refreshControls(); }
function changed(force = false) {
    if (!job) {
        if (controller || chatRunController) { stale = true; chatRunController?.abort(); controller?.abort(); }
        return;
    }
    if (!applied && !force && snapshotCurrent(job.source.snapshot)) return;
    if (applied || applying) { chatRunController?.abort(); controller?.abort(); return; }
    stale = true; chatRunController?.abort(); controller?.abort();
    say('The source changed. This job is paused; completed sections remain available to download.'); refreshControls();
}
function renderStyleChoices(control, selected = control.preset.value) {
    control.preset.replaceChildren();
    for (const preset of WRITING_PRESETS[control.aspect.id]) {
        const option = el('option', preset.label); option.value = preset.id; control.preset.append(option);
    }
    const custom = el('option', 'Custom instructions'); custom.value = 'custom'; control.preset.append(custom);
    for (const saved of presetLibrary[control.aspect.id] || []) {
        const option = el('option', `Saved: ${saved.name}`); option.value = saved.id; control.preset.append(option);
    }
    control.preset.value = selected;
}
function selectStylePreset(control) {
    const saved = presetLibrary[control.aspect.id]?.find(value => value.id === control.preset.value);
    const builtin = WRITING_PRESETS[control.aspect.id].find(value => value.id === control.preset.value);
    if (saved || builtin) control.custom.value = saved?.text ?? builtin.instruction;
    control.name.value = saved?.name || '';
    refreshControls();
}
function saveStylePreset(control) {
    if (job || controller || chatRunController || applying) return;
    const oldLibrary = presetLibrary, oldPreset = control.preset.value;
    try {
        const name = control.name.value.trim(), text = control.custom.value;
        const entries = presetLibrary[control.aspect.id] || [], existing = entries.find(value => value.name === name);
        const entry = { id: existing?.id || `custom-${globalThis.crypto.randomUUID()}`, name, text };
        presetLibrary = normalizePresetLibrary({ ...presetLibrary, [control.aspect.id]: existing ? entries.map(value => value.id === entry.id ? entry : value) : [...entries, entry] });
        renderStyleChoices(control, entry.id); storeSettings();
        say(`Saved the ${control.aspect.label.toLowerCase()} preset. It can be selected again in Advanced settings.`);
    } catch (error) {
        presetLibrary = oldLibrary; renderStyleChoices(control, oldPreset); say(error.message || 'The preset could not be saved. Check its name and instructions.');
    }
    refreshControls();
}
function deleteStylePreset(control) {
    if (job || controller || chatRunController || applying) return;
    const selected = presetLibrary[control.aspect.id]?.find(value => value.id === control.preset.value);
    if (!selected) return;
    const oldLibrary = presetLibrary;
    try {
        control.custom.value = selected.text;
        presetLibrary = normalizePresetLibrary({ ...presetLibrary, [control.aspect.id]: presetLibrary[control.aspect.id].filter(value => value.id !== selected.id) });
        renderStyleChoices(control, 'custom'); storeSettings(); control.name.value = '';
        say('Deleted the named preset. Its instructions remain in the current custom field.');
    } catch (error) { presetLibrary = oldLibrary; renderStyleChoices(control, selected.id); say(error.message || 'The preset could not be deleted.'); }
    refreshControls();
}
function mountWritingStyles(parent, values) {
    presetLibrary = normalizePresetLibrary(values.writingPresetLibrary);
    const enableLabel = el('label', undefined, 'sb-check'), enable = el('input'); enable.type = 'checkbox'; enable.checked = values.tuningEnabled;
    enable.id = 'story-builder-setting-tuningEnabled';
    enableLabel.append(enable, document.createTextNode(' Enable writing styles and optional specialist passes'));
    settingsFields.push({ input: enable, key: 'tuningEnabled', checkbox: true }); parent.append(enableLabel);
    parent.append(el('p', 'These preferences shape one coherent story. Leave them off to keep your existing prompt and preset behavior. Specialist models review and revise the shared manuscript; they do not write separate fragments. Each selected specialist adds paid requests, requires manuscript reviews to be on, and shares the story budget and revision limits.', 'sb-note'));
    for (const aspect of WRITING_ASPECTS) {
        const section = el('section', undefined, 'sb-style-section'); section.append(el('h3', aspect.label), el('p', aspect.description, 'sb-note'));
        const preset = el('select'), custom = el('textarea'), model = el('input'), name = el('input');
        preset.className = custom.className = model.className = name.className = 'text_pole';
        preset.id = `story-builder-style-${aspect.id}-preset`; custom.id = `story-builder-style-${aspect.id}-custom`;
        model.id = `story-builder-style-${aspect.id}-model`; name.id = `story-builder-style-${aspect.id}-name`;
        model.type = name.type = 'text'; model.setAttribute('list', 'story-builder-model-catalog');
        model.placeholder = 'No extra specialist'; custom.maxLength = 8000; name.maxLength = 80;
        const value = values.writingStyles[aspect.id]; custom.value = value.custom; model.value = value.model; name.value = '';
        const control = { aspect, preset, custom, model, name };
        renderStyleChoices(control, value.preset);
        const saved = presetLibrary[aspect.id].find(item => item.id === value.preset), builtin = WRITING_PRESETS[aspect.id].find(item => item.id === value.preset);
        if (saved || builtin) custom.value = saved?.text ?? builtin.instruction;
        if (saved) name.value = saved.name;
        for (const [labelText, input] of [['Style preset', preset], ['Style instructions — editing makes a custom style', custom], ['Optional specialist model — blank adds no extra pass', model], ['Name for a reusable preset', name]]) {
            const label = el('label', labelText); label.append(input); section.append(label);
        }
        const actions = el('div', undefined, 'sb-actions');
        control.save = button('Save named preset', () => saveStylePreset(control), actions);
        control.remove = button('Delete selected preset', () => deleteStylePreset(control), actions);
        section.append(actions, el('p', 'Saving an existing name updates that preset. Deleting a selected preset keeps its text as custom instructions.', 'sb-note'));
        preset.addEventListener('change', () => selectStylePreset(control));
        custom.addEventListener('input', () => { preset.value = 'custom'; refreshControls(); });
        styleControls.push(control); parent.append(section);
    }
}
async function loadModelCatalog() {
    if (catalogLoading || job || controller || chatRunController || applying) return;
    catalogLoading = true; catalogNote.textContent = 'Loading model IDs…'; refreshControls();
    try {
        const response = await fetch('/api/backends/chat-completions/status', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ chat_completion_source: 'openrouter' }) });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data?.data)) throw new Error('Catalog unavailable');
        const ids = [...new Set(data.data.map(value => value?.id).filter(value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/.test(value)))].sort().slice(0, 5000);
        if (!ids.length) throw new Error('Catalog empty');
        modelList.replaceChildren();
        for (const id of ids) { const option = el('option'); option.value = id; modelList.append(option); }
        catalogNote.textContent = `Loaded ${ids.length.toLocaleString()} model IDs. You can still enter an OpenRouter model ID directly. No generation request was made.`;
    } catch { catalogNote.textContent = 'Model IDs could not be loaded. You can still enter an OpenRouter model ID directly.'; }
    finally { catalogLoading = false; refreshControls(); }
}
function mount() {
    if (mounted) return; mounted = true;
    try { extension_settings[KEY] = getSettings(); } catch { extension_settings[KEY] = { ...DEFAULTS }; }
    dialog = el('dialog'); dialog.id = 'story-builder-dialog';
    const top = el('div', undefined, 'sb-top'); top.append(el('h2', 'Story Builder'), el('span', `v${VERSION}`, 'sb-note')); button('Close', () => dialog.close(), top);
    const description = el('p', 'Paste your prompt in the chat box, choose Generation: Story Builder beside it, then Send. To replace a reply, save your edited prompt and choose Regenerate. Standard mode keeps your usual SillyTavern generation.');
    const notice = el('p', 'Planning and writing use your OpenRouter connection and make multiple paid requests. Closing this panel keeps work running. Pause stops the current request. Refreshing or closing this browser tab loses the staged job, so download it first.', 'sb-note');
    const preferences = el('section', undefined, 'sb-easy-settings'); preferences.append(el('h3', 'Story settings'));
    const advanced = el('details', undefined, 'sb-advanced-settings'); advanced.append(el('summary', 'Advanced settings and writing styles'));
    const fields = el('div', undefined, 'sb-fields'), advancedFields = el('div', undefined, 'sb-fields');
    const values = getSettings();
    for (const [key, labelText, numeric] of [
        ['writerModel', 'Writer model — blank uses your current model', false],
        ['plannerModel', 'Planner model', false],
        ['reviewerModel', 'Reviewer model', false],
        ['continuityModel', 'Continuity checks model — blank uses stage defaults', false],
        ['revisionModel', 'Revision model — blank uses reviewer', false],
        ['wordMin', 'Minimum story words', true], ['wordMax', 'Maximum story words', true],
        ['paragraphMin', 'Minimum paragraphs', true], ['paragraphMax', 'Maximum paragraphs', true],
        ['sectionCount', 'Number of sections', true], ['maxRetries', 'Automatic retries per section', true],
        ['revisionCycles', 'Maximum review-and-revision rounds (0–2)', true],
        ['maxRevisionPassages', 'Maximum passages revised per round (1–6)', true],
        ['spendLimitUsd', 'Estimated story spending limit in USD (0 disables)', true],
    ]) {
        const label = el('label', labelText), input = el('input'); input.type = numeric ? 'number' : 'text'; input.className = 'text_pole'; input.value = values[key] ?? '';
        input.id = `story-builder-setting-${key}`;
        if (!numeric) input.setAttribute('list', 'story-builder-model-catalog');
        if (numeric) { input.step = '1'; input.min = ['maxRetries', 'revisionCycles'].includes(key) ? '0' : '1'; }
        if (key === 'spendLimitUsd') { input.step = '0.01'; input.min = '0'; input.max = '1000'; input.addEventListener('change', refreshControls); }
        if (key === 'maxRevisionPassages') input.max = '6';
        if (key === 'writerModel') input.placeholder = 'Use current writing model';
        settingsFields.push({ input, key, numeric }); label.append(input);
        (['writerModel', 'wordMin', 'wordMax', 'spendLimitUsd'].includes(key) ? fields : advancedFields).append(label);
    }
    const strictLabel = el('label', undefined, 'sb-check'), strict = el('input'); strict.type = 'checkbox'; strict.checked = values.strictParagraphs === true;
    strictLabel.append(strict, document.createTextNode(' Require paragraph range')); settingsFields.push({ input: strict, key: 'strictParagraphs', checkbox: true });
    const easyActions = el('div', undefined, 'sb-actions');
    preferenceButtons.push(button('Use 10,000–12,000 words', () => {
        if (job || controller || chatRunController || applying) return;
        for (const [key, value] of [['wordMin', 10000], ['wordMax', 12000], ['sectionCount', 4]]) settingsFields.find(field => field.key === key).input.value = value;
        say('Selected 10,000–12,000 words in four sections. Save preferences or prepare your next story to use these targets.');
    }, easyActions));
    preferenceButtons.push(button('Save preferences', () => {
        if (job || controller || chatRunController || applying) return;
        try { storeSettings(); say('Preferences saved for your next story. Paste your prompt in chat, then Send with Story Builder selected.'); }
        catch (error) { say(error.message || 'Check the story preferences.'); }
        refreshControls();
    }, easyActions));
    preferences.append(fields, easyActions, el('p', 'Start with these targets and your writer model. Extra styles and specialist requests are off unless you enable them below.', 'sb-note'));
    advanced.append(advancedFields, strictLabel, el('p', 'With the continuity model blank, starting notes use the planner and section checks use the reviewer. With the revision model blank, revisions use the reviewer.', 'sb-note'));
    for (const [key, labelText] of [['continuityEnabled', 'Prepare starting state and check continuity before keeping each section'], ['editorialEnabled', 'Run two independent reviews and targeted revisions'], ['updateTracker', 'Update zTracker after adding the final reviewed story']]) {
        const label = el('label', undefined, 'sb-check'), input = el('input'); input.type = 'checkbox'; input.checked = values[key]; input.id = `story-builder-setting-${key}`; label.append(input, document.createTextNode(` ${labelText}`)); settingsFields.push({ input, key, checkbox: true }); advanced.append(label);
    }
    advanced.append(el('p', 'Reviews examine the full draft and original context. Each round makes up to your chosen number of targeted edits, then the enabled reviewers check the result. Any remaining findings stay visible.', 'sb-note'),
        el('p', 'A positive spending limit checks estimated input and maximum output cost before each model request. It is an estimate, not a guaranteed provider billing ceiling. Cancelled or failed requests may retain an unknown-charge allowance. Automatic zTracker updates are off because their requests cannot share this budget.', 'sb-note'),
        el('p', 'The limit is fixed for each staged job. If a request would exceed it, download completed work before discarding the job and choosing a different limit for a new job. Resume keeps the same limit and recorded spending.', 'sb-note'),
        el('p', 'Each parallel review is checked separately; a funded review can finish even if its peer is blocked.', 'sb-note'),
        el('p', 'Flexible paragraph counts preserve natural dialogue. Your active writing preset remains in use without changing your chat connection.', 'sb-note'));
    modelList = el('datalist'); modelList.id = 'story-builder-model-catalog';
    catalogNote = el('p', 'All model fields accept an OpenRouter model ID. Loading the catalog is optional and does not generate text.', 'sb-note');
    catalogButton = button('Load available model IDs', () => void loadModelCatalog(), advanced);
    advanced.append(catalogNote, modelList); mountWritingStyles(advanced, values); preferences.append(advanced);
    const prepareActions = el('div', undefined, 'sb-actions'); prepareButton = button('Prepare outline from current prompt', () => void prepare(), prepareActions, 'sb-primary'); discardButton = button('Discard this staged job', discard, prepareActions);
    const setupHelp = el('p', 'With automatic chat workflow on, Send and the Regenerate action run every stage. Confirm message edits before choosing Regenerate; the previous reply stays available until the finished replacement is saved as a new swipe. The buttons below also let you work through individual stages. Preparing runs your normal preset macros.', 'sb-note');
    counts = el('div', undefined, 'sb-counts'); usage = el('div', undefined, 'sb-note sb-usage'); status = el('div', 'Ready. Start by preparing an outline.', 'sb-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    notices = el('div'); outline = el('div', undefined, 'sb-outline');
    const outlineDetails = el('details'); outlineDetails.open = true; outlineDetails.append(el('summary', 'Section plan'), outline);
    planControls = el('div');
    const generationActions = el('div', undefined, 'sb-actions'); runButton = button('Generate full story', () => void generate(), generationActions, 'sb-primary'); pauseButton = button('Pause', pauseWorkflow, generationActions);
    previewDetails = el('details'); previewDetails.append(el('summary', 'Preview combined draft')); draftPreview = el('div', undefined, 'sb-preview'); previewDetails.append(draftPreview); previewDetails.addEventListener('toggle', renderPreview);
    pendingDetails = el('details'); pendingDetails.append(el('summary', 'Inspect last unsuccessful section attempt')); pendingPreview = el('div', undefined, 'sb-preview'); pendingDetails.append(pendingPreview); pendingDetails.addEventListener('toggle', renderPreview);
    editorialDetails = el('details'); editorialDetails.append(el('summary', 'Reviews and revision results')); editorialPanel = el('div'); editorialDetails.append(editorialPanel);
    continuityDetails = el('details'); continuityDetails.append(el('summary', 'Starting state and section checks')); continuityPanel = el('div'); continuityDetails.append(continuityPanel); continuityDetails.addEventListener('toggle', renderContinuity);
    const resultActions = el('div', undefined, 'sb-actions'); applyButton = button('Add finished story to chat', () => void apply(), resultActions); downloadButton = button('Download partial plain-text story', download, resultActions);
    memoryButton = button('Update continuity', () => void updateMemory(), resultActions);
    planControls.append(outlineDetails, continuityDetails, generationActions, previewDetails, editorialDetails, pendingDetails, resultActions, el('p', 'The automatic workflow adds the finished story after its required checks pass. Optional tracker updates use the delivered version and stay manual while a spending limit is active. Unresolved editorial suggestions remain in the reports.', 'sb-note'));
    dialog.append(top, description, notice, preferences, setupHelp, prepareActions, counts, usage, status, notices, planControls); document.body.append(dialog);
    const panel = el('div'); panel.id = 'story-builder-settings'; panel.append(el('strong', 'Story Builder'), el('span', ` · v${VERSION}`, 'sb-note'), el('p', 'Plan, write, review, revise, and deliver one finished story from your prompt.', 'sb-note'));
    const chatLabel = el('label', undefined, 'sb-check'); chatToggle = el('input'); chatToggle.type = 'checkbox'; chatToggle.checked = values.chatWorkflowEnabled;
    chatToggle.addEventListener('change', () => setGenerationMode(chatToggle.checked === true));
    chatLabel.append(chatToggle, document.createTextNode(' Run Story Builder on Send and Regenerate')); panel.append(chatLabel);
    panelStatus = el('div', 'Ready. No source has been loaded.', 'sb-note'); panel.append(panelStatus); button('Open Story Builder', open, panel);
    (document.getElementById('extensions_settings2') || document.getElementById('extensions_settings'))?.append(panel);
    const menu = el('div', 'Story Builder', 'list-group-item flex-container flexGap5'); menu.id = 'story-builder-menu'; menu.tabIndex = 0; menu.setAttribute('role', 'button'); menu.addEventListener('click', open); menu.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    menu.dataset.ntTopbarAction = 'story-builder:open'; menu.dataset.ntTopbarLabel = 'Story Builder'; menu.dataset.ntTopbarIcon = 'fa-solid fa-book-open';
    document.getElementById('extensionsMenu')?.append(menu);
    const chatParent = document.getElementById('sheld') || document.body;
    const modeBar = el('div', undefined, 'story-builder-mode-bar'); modeBar.id = 'story-builder-mode-bar';
    modeButton = button('Generation: Standard', () => setGenerationMode(!getSettings().chatWorkflowEnabled), modeBar, 'story-builder-mode-toggle');
    modeButton.id = 'story-builder-mode-toggle'; modeButton.setAttribute('aria-pressed', String(values.chatWorkflowEnabled));
    modeButton.dataset.ntTopbarAction = 'story-builder:mode'; modeButton.dataset.ntTopbarLabel = 'Generation mode'; modeButton.dataset.ntTopbarIcon = 'fa-solid fa-wand-magic-sparkles';
    button('Story settings', open, modeBar, 'story-builder-mode-settings');
    modeNote = el('span', undefined, 'story-builder-mode-note'); modeBar.append(modeNote);
    const nativeComposer = document.getElementById('send_form');
    if (nativeComposer) nativeComposer.insertBefore(modeBar, nativeComposer.firstChild);
    else (document.getElementById('form_sheld') || chatParent).append(modeBar);
    chatProgress = createChatProgress({ document, version: VERSION, parent: chatParent, onPause: pauseWorkflow,
        onResume: () => { setGenerationMode(true); return automaticStory(); }, onDetails: open, onDownload: download, onDownloadActivity: downloadActivity,
        onDismiss: () => { automaticVisible = false; refreshChatProgress(); } });
    const composer = document.getElementById('form_sheld');
    if (composer?.parentNode === chatParent) chatParent.insertBefore(chatProgress.element, composer);
    chatLayout = bindChatProgressLayout({ element: chatProgress.element, document });
    // Claim explicit regeneration before the native action deletes the old reply.
    document.addEventListener('click', regenerateAction.handleClick, true);
    refreshControls();
}
eventSource.on(event_types.APP_READY, mount);
for (const name of ['CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_SENT', 'OAI_PRESET_CHANGED_AFTER', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CONNECTION_PROFILE_LOADED', 'CHARACTER_EDITED']) {
    if (event_types[name]) eventSource.on(event_types[name], () => changed(false));
}
for (const name of ['WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'PERSONA_CHANGED', 'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED']) {
    if (event_types[name]) eventSource.on(event_types[name], () => changed(true));
}
eventSource.on(event_types.GENERATION_STARTED, (type, options, dryRun) => {
    chatInterceptor.generationStarted(type, options, dryRun);
    if (dryRun || (!controller && !chatRunController)) return;
    chatRunController?.abort(); controller?.abort(); say('Paused because another SillyTavern generation started. Completed sections remain here.');
});
eventSource.on(event_types.MESSAGE_SENT, index => chatInterceptor.messageSent(index));
if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, () => {
    chatInterceptor.cancel();
    if (controller || chatRunController) pauseWorkflow();
});
if (event_types.CHAT_CHANGED) eventSource.on(event_types.CHAT_CHANGED, () => {
    chatInterceptor.cancel(); automaticVisible = false; refreshChatProgress();
});
