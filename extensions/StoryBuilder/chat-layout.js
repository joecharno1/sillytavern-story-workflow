const GAP_PROPERTY = '--story-builder-composer-gap';

/** Reserve space above NastyTavern's fixed native composer; never alter its layout. */
export function bindChatProgressLayout({ element, document: doc = globalThis.document, window: win = globalThis.window } = {}) {
    if (!element?.style || typeof element.getBoundingClientRect !== 'function') {
        throw new TypeError('A story progress element is required.');
    }
    let destroyed = false, frame = null, parent = null, composer = null;
    const Resize = win?.ResizeObserver ?? globalThis.ResizeObserver;
    const Mutation = win?.MutationObserver ?? globalThis.MutationObserver;
    const resizeObserver = typeof Resize === 'function' ? new Resize(() => refresh()) : null;
    const mutationObserver = typeof Mutation === 'function' ? new Mutation(() => refresh()) : null;
    const styleOf = node => win?.getComputedStyle?.(node) ?? {};

    function setGap(value) {
        const current = element.style.getPropertyValue(GAP_PROPERTY);
        if (value === null) {
            if (current) element.style.removeProperty(GAP_PROPERTY);
        } else if (current.trim() !== value) element.style.setProperty(GAP_PROPERTY, value);
    }

    function visible(node, style, rect) {
        if (!node || node.hidden || node.isConnected === false || style.display === 'none'
            || ['hidden', 'collapse'].includes(style.visibility)
            || (style.opacity !== undefined && style.opacity !== '' && Number(style.opacity) === 0)
            || (typeof node.getClientRects === 'function' && node.getClientRects().length === 0)) return false;
        return Number.isFinite(rect?.top) && Number.isFinite(rect?.bottom)
            && Number.isFinite(rect?.width) && Number.isFinite(rect?.height) && rect.width > 0 && rect.height > 0;
    }

    function observeCurrentNodes() {
        const nextParent = element.parentElement;
        const nextComposer = doc?.getElementById?.('send_form') ?? null;
        if (nextParent === parent && nextComposer === composer) return;
        parent = nextParent; composer = nextComposer;
        resizeObserver?.disconnect();
        for (const node of new Set([parent, composer].filter(Boolean))) resizeObserver?.observe(node);
        mutationObserver?.disconnect();
        const body = doc?.body;
        if (body) mutationObserver?.observe(body, { attributes: true, attributeFilter: ['class', 'style'] });
        for (const node of new Set([element, parent, composer].filter(node => node && node !== body))) {
            mutationObserver?.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
        }
    }

    function measure() {
        frame = null;
        if (destroyed) return;
        observeCurrentNodes();
        if (!doc?.body?.classList?.contains('mt-enabled') || !parent || !composer) return setGap(null);
        const composerStyle = styleOf(composer), composerRect = composer.getBoundingClientRect();
        if (composerStyle.position !== 'fixed' || !visible(composer, composerStyle, composerRect)
            || !visible(element, styleOf(element), element.getBoundingClientRect())) return setGap(null);
        const parentRect = parent.getBoundingClientRect();
        if (!Number.isFinite(parentRect.bottom)) return setGap(null);

        // Only this following sibling occupies flow below the panel. A similarly
        // named wrapper elsewhere must not reduce the space reserved here.
        const wrapper = doc?.getElementById?.('form_sheld');
        let flowHeight = 0;
        if (wrapper && wrapper.parentElement === parent && element.nextElementSibling === wrapper) {
            const style = styleOf(wrapper), rect = wrapper.getBoundingClientRect();
            if (!wrapper.hidden && style.display !== 'none' && !['fixed', 'absolute'].includes(style.position)
                && Number.isFinite(rect.height)) flowHeight = Math.max(0, rect.height);
        }
        const gap = Math.max(8, Math.ceil(parentRect.bottom - composerRect.top - flowHeight + 8));
        setGap(`${gap}px`);
    }

    function refresh() {
        if (destroyed || frame !== null) return;
        if (typeof win?.requestAnimationFrame === 'function') frame = win.requestAnimationFrame(measure);
        else measure();
    }

    win?.addEventListener?.('resize', refresh);
    win?.visualViewport?.addEventListener?.('resize', refresh);
    win?.visualViewport?.addEventListener?.('scroll', refresh);
    // Observe before the first frame so hidden panels still respond to activation.
    observeCurrentNodes();
    refresh();
    return Object.freeze({
        refresh,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            if (frame !== null) win?.cancelAnimationFrame?.(frame);
            frame = null;
            resizeObserver?.disconnect(); mutationObserver?.disconnect();
            win?.removeEventListener?.('resize', refresh);
            win?.visualViewport?.removeEventListener?.('resize', refresh);
            win?.visualViewport?.removeEventListener?.('scroll', refresh);
            setGap(null);
        },
    });
}
