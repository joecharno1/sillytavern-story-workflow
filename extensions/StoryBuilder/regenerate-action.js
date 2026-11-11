function hasIdentity(value) {
    return value !== undefined && value !== null && value !== '';
}

function singleCharacter(context) {
    return context && Array.isArray(context.chat) && !hasIdentity(context.groupId)
        && hasIdentity(context.characterId) && hasIdentity(context.getCurrentChatId?.());
}

/** Accept both a normal Send ticket and a saved brief with one existing reply. */
export function storyTicketCurrent(context, ticket) {
    try {
        if (!ticket || !singleCharacter(context) || !Number.isInteger(ticket.index) || ticket.index < 0) return false;
        const tail = ticket.tail;
        if (tail !== undefined && (!tail || typeof tail !== 'object')) return false;
        if (context.chat !== ticket.chat || context.getCurrentChatId() !== ticket.chatId
            || context.characterId !== ticket.characterId
            || context.chat.length !== ticket.index + (tail ? 2 : 1)) return false;
        const message = context.chat[ticket.index];
        if (message !== ticket.message || message?.is_user !== true || message.is_system
            || typeof message.mes !== 'string' || message.mes !== ticket.text
            || message.swipe_id !== ticket.swipeId) return false;
        if (!tail) return true;
        const reply = context.chat[ticket.index + 1];
        return reply === tail.message && reply?.is_user === false && !reply.is_system
            && typeof reply.mes === 'string' && reply.mes === tail.text && reply.swipe_id === tail.swipeId;
    } catch { return false; }
}

function captureTicket(context) {
    const chat = context.chat, last = chat.at(-1);
    if (!last || last.is_system || typeof last.mes !== 'string' || !last.mes.trim()) {
        throw new Error('Save a nonempty story brief or finish the current reply before regenerating.');
    }
    const index = last.is_user === true ? chat.length - 1 : chat.length - 2;
    const message = chat[index];
    if (message?.is_user !== true || message.is_system || typeof message.mes !== 'string' || !message.mes.trim()
        || (index !== chat.length - 1 && last.is_user !== false)) {
        throw new Error('The saved story brief must be the last message or immediately before the current reply.');
    }
    const ticket = {
        chat, chatId: context.getCurrentChatId(), characterId: context.characterId,
        message, index, text: message.mes, swipeId: message.swipe_id,
    };
    if (index !== chat.length - 1) ticket.tail = Object.freeze({ message: last, text: last.mes, swipeId: last.swipe_id });
    return Object.freeze(ticket);
}

/** Claim only the explicit native Regenerate click, before ST removes a reply. */
export function createRegenerateAction({
    getContext, isEnabled, isBusy, isGenerating, hasUnsavedEdit,
    onStart, onBlocked = () => {}, onError = () => {},
}) {
    const claimedEvents = new WeakSet();

    function reportError(error) {
        try { Promise.resolve(onError(error)).catch(() => {}); }
        catch { /* A failed error display must not resume native generation. */ }
    }

    function invoke(callback, value) {
        try { Promise.resolve(callback(value)).catch(reportError); }
        catch (error) { reportError(error); }
    }

    function suppress(event) {
        claimedEvents.add(event);
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function handleClick(event) {
        let matched = false;
        try {
            matched = Boolean(event?.target?.closest?.('#option_regenerate'));
            if (!matched) return false;
            if (claimedEvents.has(event)) return true;
            if (!isEnabled()) return false;
            const context = getContext();
            if (!singleCharacter(context)) return false;
            // There must be no await before this: the native click deletes the
            // previous reply before manifest generation interceptors run.
            suppress(event);
            if (hasUnsavedEdit()) {
                invoke(onBlocked, 'Save or cancel the open message edit before regenerating.');
                return true;
            }
            if (isGenerating()) {
                invoke(onBlocked, 'SillyTavern is still generating. Stop or finish that reply before regenerating.');
                return true;
            }
            if (isBusy()) {
                invoke(onBlocked, 'A story is already running or has unfinished work. Resume or discard it before regenerating.');
                return true;
            }
            let ticket;
            try { ticket = captureTicket(context); }
            catch (error) { invoke(onBlocked, error.message); return true; }
            if (!storyTicketCurrent(getContext(), ticket)) {
                invoke(onBlocked, 'The saved prompt changed before regeneration could start. Try again from the current chat.');
                return true;
            }
            // Invoke synchronously so the owner can reserve its controller
            // before a second click arrives. Promise failures remain handled.
            invoke(onStart, ticket);
            return true;
        } catch (error) {
            if (matched && !claimedEvents.has(event)) {
                try { suppress(event); } catch { /* Report the original failure. */ }
            }
            reportError(error);
            return matched;
        }
    }

    return Object.freeze({ handleClick });
}
