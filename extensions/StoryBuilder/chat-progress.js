/** A status panel only: this module never reads or writes chat messages. */
const STAGE_LABELS = Object.freeze({
    preparing: 'Preparing your story', capture: 'Preparing your story', planning: 'Planning your story',
    planning_retry: 'Retrying the outline format', planning_ready: 'Outline accepted',
    starting_state: 'Preparing starting state', starting_state_ready: 'Starting state prepared',
    checking_section: 'Checking section continuity', section_check_complete: 'Section check complete',
    ready: 'Ready to continue', writing: 'Writing your story', running: 'Writing your story',
    section: 'Writing your story', section_start: 'Writing your story', section_complete: 'Writing your story',
    reviewing: 'Checking continuity and prose', editorial_review: 'Checking continuity and prose',
    editorial_report: 'Checking continuity and prose', revising: 'Revising a passage', editorial_revise: 'Revising a passage',
    editorial_change: 'Revising a passage', editorial_change_rejected: 'Keeping the previous passage',
    editorial_ready: 'Story review finished', applying: 'Adding your finished story',
    tracking: 'Updating story memory', memory: 'Updating story memory', tracker: 'Updating story memory',
    paused: 'Story paused', failed: 'Your story needs attention', needs_attention: 'Your story needs attention',
    complete: 'Story finished', finished: 'Story finished',
});

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => value.toLocaleString('en-US');
const quantity = (value, singular, plural = `${singular}s`) => `${number(value)} ${value === 1 ? singular : plural}`;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const dollars = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `$${value.toFixed(4)}` : 'unavailable';

/** Only numeric aggregate metadata is formatted; this is not a provider bill. */
export function formatSpendSummary(value) {
    if (!value || typeof value !== 'object') return '';
    if (value.limitUsd > 0) return `Estimated spending limit ${dollars(value.limitUsd)} · Reported ${dollars(value.reportedUsd)} · Estimated ${dollars(value.estimatedUsd)} · Unknown-charge allowance ${dollars(value.unknownUsd)} · Reserved ${dollars(value.reservedUsd)} · Remaining ${dollars(value.remainingUsd)}. Estimates are not a guaranteed billing ceiling; unknown allowances may include cancelled requests.`;
    const reported = count(value.reportedRequests), unreported = count(value.unreportedRequests);
    return `No spending limit · ${reported === 0 ? 'No API usage cost reported yet' : `Reported ${dollars(value.reportedUsd)}${reported !== null ? ` from ${quantity(reported, 'request')}` : ''}`}${unreported !== null ? ` · ${quantity(unreported, 'request')} without reported cost` : ''}. This is not a final bill.`;
}

function formatCounts(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const parts = [];
    for (const [completed, total, noun, action] of [
        ['completedSections', 'totalSections', 'section', 'finished'],
        ['completedReviews', 'totalReviews', 'review', 'finished'],
        ['completedRevisions', 'totalRevisions', 'passage', 'revised'],
    ]) {
        const done = count(value[completed]), target = count(value[total]);
        if (done !== null && target !== null && target > 0 && done <= target) {
            parts.push(`${number(done)} of ${quantity(target, noun)} ${action}`);
        } else if (done !== null) parts.push(`${quantity(done, noun)} ${action}`);
    }
    if (count(value.words) !== null) parts.push(quantity(value.words, 'word'));
    if (count(value.completedChecks) !== null) parts.push(`${quantity(value.completedChecks, 'section check')} passed`);
    if (count(value.paragraphs) !== null) parts.push(quantity(value.paragraphs, 'paragraph'));
    const cycle = count(value.cycle), maxCycles = count(value.maxCycles);
    if (cycle !== null && cycle > 0) {
        parts.push(maxCycles !== null && maxCycles >= cycle ? `Revision round ${number(cycle)} of ${number(maxCycles)}` : `Revision round ${number(cycle)}`);
    }
    return parts.join(' · ');
}

/**
 * counts accepts display text or { completedSections, totalSections, words, paragraphs,
 * completedReviews, totalReviews, completedRevisions, totalRevisions, cycle, maxCycles }.
 * cycle is one-based. Unknown stage keys are never displayed. The host owns all work,
 * availability flags, and lifecycle changes; callbacks are invoked only for available actions.
 * version identifies the loaded caller's code, not a separately fetched manifest.
 * It is fixed at creation and stays outside the frequently announced live status.
 */
export function createChatProgress({ document: doc = globalThis.document, parent, version,
    onPause, onResume, onDetails, onDownload, onDownloadActivity, onDismiss } = {}) {
    if (typeof doc?.createElement !== 'function') throw new TypeError('A document is required for the story progress panel.');
    const container = parent ?? doc.getElementById?.('chat') ?? doc.body;
    if (typeof container?.append !== 'function') throw new TypeError('Choose a container for the story progress panel.');

    const element = doc.createElement('section');
    element.className = 'story-builder-progress';
    element.setAttribute('role', 'region');
    element.setAttribute('aria-label', 'Story progress');

    const title = doc.createElement('h3');
    title.className = 'story-builder-progress-title';
    title.textContent = typeof version === 'string' && VERSION.test(version)
        ? `Story progress · v${version}` : 'Story progress';

    // Keep actions outside the live region so routine updates do not reannounce every button.
    const status = doc.createElement('div');
    status.className = 'story-builder-progress-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const stage = doc.createElement('p');
    stage.className = 'story-builder-progress-stage';
    const message = doc.createElement('p');
    message.className = 'story-builder-progress-message';
    const counts = doc.createElement('p');
    counts.className = 'story-builder-progress-counts';
    status.append(stage, message, counts);

    const actions = doc.createElement('div');
    actions.className = 'story-builder-progress-actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', 'Story actions');
    const waiting = doc.createElement('p');
    waiting.className = 'story-builder-progress-waiting';
    waiting.setAttribute('aria-live', 'off');
    const budget = doc.createElement('p'); budget.className = 'story-builder-progress-budget'; budget.setAttribute('aria-live', 'off');
    const activity = doc.createElement('details');
    activity.className = 'story-builder-progress-activity';
    const activityTitle = doc.createElement('summary'); activityTitle.textContent = 'Activity log';
    const activityNote = doc.createElement('p');
    activityNote.textContent = 'Request timing and results only. No prompts, story text, or model reasoning are recorded here.';
    const activityList = doc.createElement('ol'); activityList.className = 'story-builder-progress-activity-list';
    activity.append(activityTitle, activityNote, activityList);
    element.append(title, status, waiting, actions, budget, activity);

    let destroyed = false;
    let state = { visible: false, busy: false, canResume: false, canDownload: false, canDismiss: false,
        message: '', counts: '', stage: '', activity: [], now: 0, spend: null };
    const listeners = [];
    const actionFailed = () => {
        if (destroyed || element.hidden) return;
        message.hidden = false;
        message.textContent = 'That action could not be completed. View details and try again.';
    };
    const button = (label, name, callback, parent = actions) => {
        const node = doc.createElement('button');
        node.type = 'button';
        node.className = `story-builder-progress-${name}`;
        node.textContent = label;
        const handler = () => {
            if (destroyed || element.hidden || node.disabled || node.hidden || typeof callback !== 'function') return;
            try {
                const result = callback();
                if (result && typeof result.then === 'function') Promise.resolve(result).catch(actionFailed);
            } catch { actionFailed(); }
        };
        node.addEventListener('click', handler);
        listeners.push({ node, handler });
        parent.append(node);
        return { node, callback };
    };
    const buttons = {
        pause: button('Pause', 'pause', onPause),
        resume: button('Resume', 'resume', onResume),
        details: button('View details', 'details', onDetails),
        download: button('Download', 'download', onDownload),
        activity: button('Download activity log', 'download-activity', onDownloadActivity, activity),
        dismiss: button('Dismiss', 'dismiss', onDismiss),
    };
    const availability = (action, available, show = available) => {
        action.node.hidden = !show;
        action.node.disabled = !state.visible || !available || typeof action.callback !== 'function';
    };
    function update(next = {}) {
        if (destroyed) return;
        if (!next || typeof next !== 'object') return;
        for (const key of ['visible', 'busy', 'canResume', 'canDownload', 'canDismiss']) {
            if (Object.hasOwn(next, key)) state[key] = next[key] === true;
        }
        for (const key of ['message', 'counts', 'stage', 'activity', 'now', 'spend']) if (Object.hasOwn(next, key)) state[key] = next[key];
        element.hidden = !state.visible;
        const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
        setText(stage, typeof state.stage === 'string' && Object.hasOwn(STAGE_LABELS, state.stage)
            ? STAGE_LABELS[state.stage] : state.busy ? 'Working on your story' : 'Story progress');
        setText(message, typeof state.message === 'string' ? state.message : '');
        message.hidden = !message.textContent.trim();
        setText(counts, formatCounts(state.counts));
        counts.hidden = !counts.textContent.trim();
        setText(budget, formatSpendSummary(state.spend)); budget.hidden = !budget.textContent;
        const entries = Array.isArray(state.activity) ? state.activity : [];
        const duration = milliseconds => {
            const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
            return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        };
        const pending = entries.filter(entry => entry?.type === 'request' && entry.status === 'waiting');
        waiting.textContent = pending.map(entry => `Waiting for model response · ${duration(state.now - entry.startedAt)} elapsed${entry.model ? ` · ${entry.model}` : ''}`).join('\n');
        waiting.hidden = !pending.length;
        activityList.textContent = '';
        for (const entry of entries) {
            if (!entry || typeof entry.label !== 'string') continue;
            const row = doc.createElement('li');
            const parts = [entry.label];
            if (entry.type === 'request') {
                parts.push(entry.status === 'waiting' ? 'Waiting for model response' : entry.status === 'received' ? 'Response received' : entry.status === 'cancelled' ? 'Request cancelled' : entry.status === 'stopped' ? 'Request ended before validation' : 'Request failed');
                if (typeof entry.model === 'string') parts.push(entry.model);
                parts.push(`${duration((entry.endedAt ?? state.now) - entry.startedAt)} elapsed`);
                if (count(entry.httpStatus) !== null) parts.push(`HTTP ${entry.httpStatus}`);
                if (count(entry.outputCharacters) !== null) parts.push(`${number(entry.outputCharacters)} output characters`);
                if (typeof entry.finishReason === 'string') parts.push(`Finish: ${entry.finishReason}`);
                if (count(entry.inputTokens) !== null) parts.push(`${number(entry.inputTokens)} input tokens`);
                if (count(entry.outputTokens) !== null) parts.push(`${number(entry.outputTokens)} output tokens`);
                if (count(entry.reasoningTokens) !== null) parts.push(`${number(entry.reasoningTokens)} reasoning tokens`);
                if (count(entry.cachedInputTokens) !== null) parts.push(`${number(entry.cachedInputTokens)} cached input tokens`);
                if (typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) && entry.costUsd >= 0) parts.push(`Reported cost ${dollars(entry.costUsd)}`);
                else if (entry.status !== 'waiting') parts.push('Cost not reported');
            }
            row.textContent = parts.join(' · '); activityList.append(row);
        }
        activity.hidden = !entries.length;
        availability(buttons.pause, state.busy);
        availability(buttons.resume, !state.busy && state.canResume);
        availability(buttons.details, true, true);
        availability(buttons.download, state.canDownload);
        availability(buttons.activity, entries.length > 0);
        availability(buttons.dismiss, !state.busy && state.canDismiss);
    }
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const { node, handler } of listeners) node.removeEventListener('click', handler);
        element.remove();
    }
    update();
    container.append(element);
    return { element, update, destroy };
}
