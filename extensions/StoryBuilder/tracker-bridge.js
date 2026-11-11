/** Explicit final-story handoff. This module emits no chat/generation events. */
const MODULES = Object.freeze(['scene-tracker', 'plot-log']);
const targets = new WeakSet();
const targetsByMessage = new WeakMap();
const targetStates = new WeakMap();
let activeRefresh = null;

function cancelled(signal) {
    if (signal?.aborted) throw new DOMException('Tracker refresh paused. Confirmed completed modules are preserved.', 'AbortError');
}

function assertTarget(target, context) {
    if (!targets.has(target) || !context || context.getCurrentChatId?.() !== target.chatId
        || context.chat !== target.chat || context.chat.length - 1 !== target.index
        || context.chat[target.index] !== target.message || target.message.is_user || target.message.is_system
        || target.message.mes !== target.text || target.message.swipe_id !== target.swipeId) {
        throw new Error('The accepted story, selected swipe, or chat changed. Tracker refresh stopped.');
    }
    return context;
}

/** Capture exactly the assistant message just saved by Story Builder. */
export function createAcceptedTarget(context, applyResult, text) {
    const index = applyResult?.index;
    const message = context?.chat?.[index];
    const chatId = context?.getCurrentChatId?.();
    if (!applyResult?.saveRequested || applyResult.rendered === false
        || !Number.isSafeInteger(index) || index < 0 || index !== context?.chat?.length - 1
        || chatId === null || chatId === undefined || !message || message.is_user || message.is_system
        || typeof text !== 'string' || !text.trim() || message.mes !== text
        || !Number.isSafeInteger(applyResult.swipeId) || applyResult.swipeId < 0
        || message.swipe_id !== applyResult.swipeId) {
        throw new Error('The final accepted story is not the current assistant reply. No trackers were requested.');
    }
    const existing = targetsByMessage.get(message);
    if (existing && existing.chat === context.chat && existing.chatId === chatId
        && existing.index === index && existing.swipeId === message.swipe_id && existing.text === text) return existing;
    const state = { status: 'pending' };
    const target = Object.freeze({
        chatId, chat: context.chat, message, index, swipeId: message.swipe_id, text,
        completedModules: new Set(),
        get status() { return state.status; },
    });
    targets.add(target);
    targetStates.set(target, state);
    targetsByMessage.set(message, target);
    return target;
}

/**
 * Run only unfinished modules, in order. The local zTracker safety patch listens
 * for the exact-target cancellation event and aborts its provider request. The
 * in-flight command is still awaited; a confirmed success that won the race is
 * remembered before cancellation is reported. That upstream patch also guards
 * chat/message/text/swipe before saving; after-await checks here cannot undo a
 * stale write by an unpatched zTracker installation.
 */
export async function refreshAcceptedTrackers(target, { getContext, signal, onProgress, dispatchCancel } = {}) {
    if (typeof getContext !== 'function') throw new TypeError('A current SillyTavern context is required.');
    cancelled(signal);
    assertTarget(target, getContext());
    if (activeRefresh) throw new Error('A Story Builder tracker refresh is already running.');
    activeRefresh = target;
    const state = targetStates.get(target);
    state.status = 'running';
    const progress = (stage, moduleId) => onProgress?.({
        stage, moduleId, completedModules: [...target.completedModules], totalModules: MODULES.length,
        message: `${stage === 'starting' ? 'Refreshing' : 'Updated'} ${moduleId === 'scene-tracker' ? 'scene continuity' : 'the plot log'}.`,
    });
    try {
        for (const moduleId of MODULES) {
            cancelled(signal);
            assertTarget(target, getContext());
            if (target.completedModules.has(moduleId)) continue;
            progress('starting', moduleId);
            cancelled(signal);
            const context = assertTarget(target, getContext());
            if (typeof context.executeSlashCommandsWithOptions !== 'function') {
                throw new Error('SillyTavern’s slash-command API is unavailable. The story is saved; trackers can be retried.');
            }
            let result;
            const cancel = () => {
                const detail = { messageId: target.index, moduleId, chatId: target.chatId };
                if (dispatchCancel) dispatchCancel(detail);
                else if (typeof globalThis.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
                    globalThis.dispatchEvent(new CustomEvent('ztracker:cancel-generation', { detail }));
                }
            };
            signal?.addEventListener('abort', cancel, { once: true });
            try {
                cancelled(signal);
                result = await context.executeSlashCommandsWithOptions(
                    `/ztracker-generate module=${moduleId} ${target.index}`,
                    { showOutput: false, handleExecutionErrors: true },
                );
            } catch (error) {
                assertTarget(target, getContext());
                cancelled(signal);
                throw new Error(`The ${moduleId} tracker did not complete. Previously completed modules are preserved.`, { cause: error });
            } finally {
                signal?.removeEventListener('abort', cancel);
            }
            // Validate identity before recording success, even when cancellation
            // arrived while zTracker was finishing its own unabortable command.
            assertTarget(target, getContext());
            if (!result || result.isError || result.isAborted || String(result.pipe).trim().toLowerCase() !== 'true') {
                cancelled(signal);
                throw new Error(`The ${moduleId} tracker did not complete. Previously completed modules are preserved.`);
            }
            target.completedModules.add(moduleId);
            progress('completed', moduleId);
            cancelled(signal);
            assertTarget(target, getContext());
        }
        state.status = 'complete';
        return { complete: true, completedModules: [...target.completedModules] };
    } catch (error) {
        state.status = error?.name === 'AbortError' ? 'paused' : 'failed';
        throw error;
    } finally {
        if (activeRefresh === target) activeRefresh = null;
    }
}
