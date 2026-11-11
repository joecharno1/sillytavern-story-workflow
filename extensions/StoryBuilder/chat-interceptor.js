const IDLE_RECHECKS = 20;
const IDLE_RECHECK_DELAY = 25;

function hasIdentity(value) {
    return value !== undefined && value !== null && value !== '';
}

function singleCharacter(context) {
    return context && Array.isArray(context.chat) && !hasIdentity(context.groupId)
        && hasIdentity(context.characterId) && hasIdentity(context.getCurrentChatId?.());
}

function normalSend(type, options = {}) {
    // sendTextareaMessage explicitly calls Generate('normal'). Quiet and
    // impersonation requests have their own types; group calls can force a chid.
    return type === 'normal' && !options.automatic_trigger && !options.quiet_prompt
        && !options.quietToLoud && !options.quietImage && !hasIdentity(options.force_chid);
}

/**
 * Hand off a newly saved native Send after Generate has released its UI state.
 * All dependencies are injected; this module reads no settings or chat storage.
 * schedule has the same (callback, delayMs) signature as setTimeout.
 * onStart receives the captured user-message identity, not a prompt copy.
 */
export function createChatInterceptor({
    getContext, isGenerating, isEnabled, isBusy, onStart,
    onBlocked = () => {}, onError = () => {},
    schedule = (callback, delay) => setTimeout(callback, delay),
}) {
    let serial = 0;
    let current = null;
    let destroyed = false;

    function reportError(error) {
        try {
            // A failing error display must never leak an unhandled rejection.
            Promise.resolve(onError(error)).catch(() => {});
        } catch { /* The caller owns error presentation. */ }
    }

    function invoke(callback, value) {
        try { return Promise.resolve(callback(value)).catch(reportError); }
        catch (error) { reportError(error); }
    }

    function cancel() {
        serial++;
        current = null;
    }

    function matchesGeneration(context, generation) {
        return singleCharacter(context) && context.chat === generation.chat
            && context.getCurrentChatId() === generation.chatId
            && context.characterId === generation.characterId;
    }

    function matchesMessage(context, ticket) {
        return matchesGeneration(context, ticket) && context.chat.length === ticket.index + 1
            && context.chat[ticket.index] === ticket.message
            && ticket.message.is_user === true && !ticket.message.is_system
            && ticket.message.mes === ticket.text && ticket.message.swipe_id === ticket.swipeId;
    }

    function generationStarted(type, options, dryRun) {
        // Source capture performs its own dry run. It must not cancel a handoff.
        if (destroyed || dryRun) return;
        cancel();
        try {
            if (!isEnabled() || !normalSend(type, options || {})) return;
            const context = getContext();
            if (!singleCharacter(context)) return;
            current = {
                serial, chat: context.chat, chatId: context.getCurrentChatId(),
                characterId: context.characterId, initialLength: context.chat.length,
                sent: null, claimed: false, started: false, rechecks: 0,
            };
        } catch (error) { reportError(error); }
    }

    function messageSent(index) {
        const generation = current;
        if (destroyed || !generation || generation.claimed) return;
        try {
            const context = getContext();
            if (!isEnabled() || !matchesGeneration(context, generation)) { cancel(); return; }
            const message = context.chat[index];
            // Native Send appends a new message. Replaying MESSAGE_SENT for an
            // older user message must not turn a helper request into a story.
            if (!Number.isInteger(index) || index < generation.initialLength
                || index !== context.chat.length - 1 || message?.is_user !== true
                || message.is_system || typeof message.mes !== 'string') return;
            generation.sent = Object.freeze({
                serial: generation.serial, chat: generation.chat, chatId: generation.chatId,
                characterId: generation.characterId, message, index,
                text: message.mes, swipeId: message.swipe_id,
            });
        } catch (error) { cancel(); reportError(error); }
    }

    function defer(generation, delay) {
        try { schedule(() => handoff(generation), delay); }
        catch (error) { generation.started = true; reportError(error); }
    }

    function handoff(generation) {
        if (destroyed || current !== generation || generation.serial !== serial || generation.started) return;
        try {
            if (!isEnabled() || !matchesMessage(getContext(), generation.sent)) { cancel(); return; }
            if (isBusy()) {
                generation.started = true;
                return invoke(onBlocked, 'A story is already running or has unfinished work. Resume or discard it before starting another.');
            }
            if (isGenerating()) {
                if (generation.rechecks++ < IDLE_RECHECKS) {
                    defer(generation, IDLE_RECHECK_DELAY);
                    return;
                }
                generation.started = true;
                return invoke(onBlocked, 'SillyTavern is still generating. Wait for it to finish, then retry the story.');
            }
            generation.started = true;
            return invoke(onStart, generation.sent);
        } catch (error) { generation.started = true; reportError(error); }
    }

    function intercept(_coreChat, _contextSize, abort, type) {
        const generation = current;
        if (destroyed || !generation?.sent || type !== 'normal') return false;
        let nativeAborted = false;
        try {
            if (!isEnabled() || !matchesMessage(getContext(), generation.sent)) { cancel(); return false; }
            // Abort before callbacks: a failing workflow must not fall through
            // into an unexpected native model request. Repeated hooks only abort.
            abort(true);
            nativeAborted = true;
            if (generation.claimed) return true;
            generation.claimed = true;
            if (isBusy()) {
                generation.started = true;
                invoke(onBlocked, 'A story is already running or has unfinished work. Resume or discard it before starting another.');
            } else {
                defer(generation, 1);
            }
            return true;
        } catch (error) {
            generation.claimed = true;
            generation.started = true;
            reportError(error);
            return nativeAborted;
        }
    }

    return Object.freeze({
        generationStarted, messageSent, intercept, cancel,
        destroy() { destroyed = true; cancel(); },
    });
}
