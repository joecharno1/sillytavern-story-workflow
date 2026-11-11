import test from 'node:test';
import assert from 'node:assert/strict';
import { bindChatProgressLayout } from '../../extensions/StoryBuilder/chat-layout.js';

const PROPERTY = '--story-builder-composer-gap';
class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    emit(type) { for (const callback of this.listeners.get(type) || []) callback(); }
    count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
class Element {
    constructor(rect = { top: 0, bottom: 800, height: 800, width: 600 }) {
        this.rect = rect; this.hidden = false; this.isConnected = true; this.hasRects = true;
        this.parentElement = null; this.nextElementSibling = null;
        this.computed = { position: 'static', display: 'block', visibility: 'visible', opacity: '1' };
        this.classes = new Set(); this.classList = { contains: name => this.classes.has(name) };
        this.values = new Map(); this.writes = [];
        this.style = {
            getPropertyValue: name => this.values.get(name) || '',
            setProperty: (name, value) => { this.values.set(name, value); this.writes.push(['set', name, value]); },
            removeProperty: name => { this.values.delete(name); this.writes.push(['remove', name]); },
        };
    }
    getBoundingClientRect() { return { ...this.rect }; }
    getClientRects() { return this.hasRects ? [this.getBoundingClientRect()] : []; }
    get textContent() { throw new Error('Layout must not inspect document content.'); }
}
function fixture() {
    const body = new Element(); body.classes.add('mt-enabled');
    const parent = new Element();
    const element = new Element({ top: 600, bottom: 640, height: 40, width: 600 }); element.parentElement = parent;
    const composer = new Element({ top: 650, bottom: 800, height: 150, width: 600 }); composer.computed.position = 'fixed';
    const wrapper = new Element({ top: 760, bottom: 800, height: 40, width: 600 }); wrapper.parentElement = parent;
    element.nextElementSibling = wrapper;
    const nodes = new Map([['send_form', composer], ['form_sheld', wrapper]]);
    const document = { body, getElementById: id => nodes.get(id) || null };
    const window = new Events(); window.visualViewport = new Events();
    const frames = new Map(), resizeObservers = [], mutationObservers = [];
    let frameId = 0;
    window.requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id; };
    window.cancelAnimationFrame = id => frames.delete(id);
    window.getComputedStyle = node => node.computed;
    window.ResizeObserver = class {
        constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); }
        observe(node) { this.targets.add(node); }
        disconnect() { this.targets.clear(); }
        fire() { this.callback([]); }
    };
    window.MutationObserver = class {
        constructor(callback) { this.callback = callback; this.targets = new Map(); mutationObservers.push(this); }
        observe(node, options) { this.targets.set(node, options); }
        disconnect() { this.targets.clear(); }
        fire() { this.callback([]); }
    };
    const layout = bindChatProgressLayout({ element, document, window });
    const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
    return { body, parent, element, composer, wrapper, nodes, document, window, frames, resizeObservers, mutationObservers,
        layout, flush, gap: () => element.style.getPropertyValue(PROPERTY) };
}

test('fixed NastyTavern composer reserves its overlap minus the following native wrapper flow height', () => {
    const f = fixture(); assert.equal(f.frames.size, 1); f.flush();
    assert.equal(f.gap(), '118px');
    assert.deepEqual(f.element.writes, [['set', PROPERTY, '118px']]);
    assert.equal(f.composer.writes.length, 0); assert.equal(f.parent.writes.length, 0); assert.equal(f.wrapper.writes.length, 0);
});

test('resize measurements round up and keep a minimum gap', () => {
    const f = fixture(); f.flush();
    f.composer.rect.top = 600.3; f.composer.rect.height = 199.7; f.resizeObservers[0].fire(); f.flush();
    assert.equal(f.gap(), '168px');
    f.parent.rect.bottom = 600; f.layout.refresh(); f.flush();
    assert.equal(f.gap(), '8px');
});

for (const [label, mutate] of [
    ['different parent', f => { f.wrapper.parentElement = new Element(); }],
    ['not the immediate following sibling', f => { f.element.nextElementSibling = new Element(); }],
    ['fixed wrapper', f => { f.wrapper.computed.position = 'fixed'; }],
    ['absolute wrapper', f => { f.wrapper.computed.position = 'absolute'; }],
    ['hidden wrapper', f => { f.wrapper.hidden = true; }],
]) {
    test(`does not subtract wrapper height for ${label}`, () => {
        const f = fixture(); mutate(f); f.flush(); assert.equal(f.gap(), '158px');
    });
}

for (const [label, mutate] of [
    ['NastyTavern disabled', f => f.body.classes.delete('mt-enabled')],
    ['normal-flow composer', f => { f.composer.computed.position = 'relative'; }],
    ['hidden composer attribute', f => { f.composer.hidden = true; }],
    ['display-none composer', f => { f.composer.computed.display = 'none'; }],
    ['invisible composer', f => { f.composer.computed.visibility = 'hidden'; }],
    ['transparent composer', f => { f.composer.computed.opacity = '0'; }],
    ['zero-height composer', f => { f.composer.rect.height = 0; }],
    ['composer without rendered rectangles', f => { f.composer.hasRects = false; }],
    ['missing composer', f => f.nodes.delete('send_form')],
    ['hidden panel', f => { f.element.hidden = true; }],
    ['display-none panel', f => { f.element.computed.display = 'none'; }],
    ['detached panel', f => { f.element.isConnected = false; }],
    ['missing panel parent', f => { f.element.parentElement = null; }],
]) {
    test(`clears the custom property when ${label}`, () => {
        const f = fixture(); f.flush(); assert.equal(f.gap(), '118px');
        mutate(f); f.layout.refresh(); f.flush(); assert.equal(f.gap(), '');
        assert.deepEqual(f.element.writes.at(-1), ['remove', PROPERTY]);
    });
}

test('body class/style, panel visibility, and composer attributes are observed without reading chat content', () => {
    const f = fixture(); f.flush();
    const observer = f.mutationObservers[0];
    assert.deepEqual(observer.targets.get(f.body), { attributes: true, attributeFilter: ['class', 'style'] });
    assert.ok(observer.targets.get(f.element).attributeFilter.includes('hidden'));
    assert.ok(observer.targets.get(f.composer).attributeFilter.includes('style'));
    f.body.classes.delete('mt-enabled'); observer.fire(); f.flush(); assert.equal(f.gap(), '');
    f.body.classes.add('mt-enabled'); observer.fire(); f.flush(); assert.equal(f.gap(), '118px');
});

test('window and visual viewport resize/scroll schedule a coalesced refresh', () => {
    const f = fixture(); f.flush();
    f.composer.rect.top = 620;
    f.window.emit('resize'); f.window.visualViewport.emit('resize'); f.window.visualViewport.emit('scroll');
    f.layout.refresh(); f.resizeObservers[0].fire(); f.mutationObservers[0].fire();
    assert.equal(f.frames.size, 1); f.flush(); assert.equal(f.gap(), '148px');
    const writes = f.element.writes.length;
    f.layout.refresh(); f.flush(); assert.equal(f.element.writes.length, writes, 'unchanged measurements must not mutate style');
    assert.equal(f.frames.size, 0, 'measurement must not create a polling loop');
});

test('replacement composer and panel parent are observed on the next refresh', () => {
    const f = fixture(); f.flush();
    const composer = new Element({ top: 600, bottom: 800, height: 200, width: 600 }); composer.computed.position = 'fixed';
    const parent = new Element({ top: 0, bottom: 900, height: 900, width: 600 });
    f.nodes.set('send_form', composer); f.element.parentElement = parent;
    f.layout.refresh(); f.flush();
    assert.equal(f.gap(), '308px');
    assert.deepEqual([...f.resizeObservers[0].targets], [parent, composer]);
    assert.ok(!f.mutationObservers[0].targets.has(f.composer));
});

test('destroy removes the reserved gap, queued frame, observers, and viewport listeners exactly once', () => {
    const f = fixture(); f.flush(); f.layout.refresh();
    assert.equal(f.frames.size, 1); f.layout.destroy();
    assert.equal(f.gap(), ''); assert.equal(f.frames.size, 0);
    assert.equal(f.resizeObservers[0].targets.size, 0); assert.equal(f.mutationObservers[0].targets.size, 0);
    assert.equal(f.window.count(), 0); assert.equal(f.window.visualViewport.count(), 0);
    const writes = f.element.writes.length;
    f.layout.destroy(); f.layout.refresh(); f.resizeObservers[0].fire(); f.mutationObservers[0].fire();
    f.window.emit('resize'); f.window.visualViewport.emit('scroll'); f.flush();
    assert.equal(f.element.writes.length, writes); assert.equal(f.frames.size, 0);
});

test('initially hidden panel still binds observers and measures when shown', () => {
    const f = fixture(); f.element.hidden = true; f.flush(); assert.equal(f.gap(), '');
    assert.ok(f.mutationObservers[0].targets.has(f.element));
    f.element.hidden = false; f.mutationObservers[0].fire(); f.flush(); assert.equal(f.gap(), '118px');
});
