import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatProgress } from '../../extensions/StoryBuilder/chat-progress.js';

class Node {
    constructor(tagName) {
        this.tagName = tagName; this.children = []; this.attributes = {}; this.listeners = new Map();
        this.hidden = false; this.disabled = false; this.parentNode = null; this._text = ''; this.textWrites = 0;
    }
    set innerHTML(_value) { throw new Error('HTML parsing must never be used by the progress panel.'); }
    set textContent(value) { this._text = String(value); this.children = []; this.textWrites++; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    // Deliberately dispatch disabled/hidden buttons too, to test the handler's own guards.
    click() { for (const handler of this.listeners.get('click') || []) handler({ target: this }); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
}
function fixture(options = {}) {
    const nodes = [], document = { body: new Node('body'), createElement(tag) { const node = new Node(tag); nodes.push(node); return node; },
        getElementById(id) { return nodes.find(node => node.id === id) || null; } };
    const chat = document.createElement('div'); chat.id = 'chat'; document.body.append(chat);
    const parent = document.createElement('aside'); document.body.append(parent);
    const clicks = [];
    const panel = createChatProgress({ document, parent,
        onPause: () => clicks.push('pause'), onResume: () => clicks.push('resume'), onDetails: () => clicks.push('details'),
        onDownload: () => clicks.push('download'), onDismiss: () => clicks.push('dismiss'), ...options });
    return { panel, document, nodes, chat, parent, clicks,
        button: label => nodes.find(node => node.tagName === 'button' && node.textContent === label),
        node: suffix => nodes.find(node => node.className === `story-builder-progress-${suffix}`) };
}

test('mounting creates a hidden accessible status panel in the provided container without actions', () => {
    const f = fixture();
    assert.deepEqual(f.parent.children, [f.panel.element]);
    assert.equal(f.chat.children.length, 0);
    assert.equal(f.panel.element.hidden, true);
    assert.equal(f.panel.element.attributes.role, 'region');
    assert.equal(f.panel.element.attributes['aria-label'], 'Story progress');
    assert.equal(f.node('status').attributes.role, 'status');
    assert.equal(f.node('status').attributes['aria-live'], 'polite');
    assert.equal(f.node('status').attributes['aria-atomic'], 'true');
    assert.equal(f.node('actions').attributes['aria-label'], 'Story actions');
    for (const button of f.nodes.filter(node => node.tagName === 'button')) {
        assert.equal(button.type, 'button', 'progress actions cannot submit the composer');
        assert.equal(button.disabled, true);
        button.click();
    }
    assert.deepEqual(f.clicks, []);
});

test('budget breakdown keeps actions first and separates reported, estimated, unknown, and reserved amounts', () => {
    const f = fixture();
    f.panel.update({ visible: true, spend: { limitUsd: 1, reportedUsd: 0, estimatedUsd: 0.12, unknownUsd: 0.2, reservedUsd: 0.1, remainingUsd: 0.58 } });
    const budget = f.node('budget');
    assert.equal(budget.hidden, false); assert.equal(budget.attributes['aria-live'], 'off');
    assert.match(budget.textContent, /limit \$1\.0000.*Reported \$0\.0000.*Estimated \$0\.1200.*Unknown-charge allowance \$0\.2000.*Reserved \$0\.1000.*Remaining \$0\.5800/);
    assert.match(budget.textContent, /not a guaranteed billing ceiling/);
    assert.ok(f.panel.element.children.indexOf(f.node('actions')) < f.panel.element.children.indexOf(budget));
    f.panel.update({ spend: { limitUsd: 0, reportedUsd: 0, reportedRequests: 1, unreportedRequests: 2 }, activity: [
        { type: 'request', label: 'Planning the story', status: 'received', startedAt: 0, endedAt: 1000, costUsd: 0, reasoningTokens: 3, cachedInputTokens: 12 },
        { type: 'request', label: 'Checking the story', status: 'failed', startedAt: 0, endedAt: 1000, costUsd: '<script>bad()</script>', reasoningTokens: 'PRIVATE', cachedInputTokens: -1 },
    ] });
    assert.match(budget.textContent, /No spending limit.*Reported \$0\.0000 from 1 request.*2 requests without reported cost/);
    assert.match(f.node('activity-list').textContent, /3 reasoning tokens.*12 cached input tokens.*Reported cost \$0\.0000/);
    assert.match(f.node('activity-list').textContent, /Cost not reported/);
    assert.doesNotMatch(f.node('activity-list').textContent, /PRIVATE|<script>/);
});

test('loaded version remains in the heading across stages without entering the live status', () => {
    const f = fixture({ version: '0.4.5' });
    assert.equal(f.node('title').textContent, 'Story progress · v0.4.5');
    for (const state of [
        { visible: true, busy: true, stage: 'starting_state', message: 'Preparing starting facts.' },
        { busy: false, stage: 'paused', message: 'Paused.' },
        { busy: true, stage: 'writing', message: 'Writing.' },
        { busy: false, stage: 'complete', message: 'Finished.' },
    ]) {
        f.panel.update(state);
        assert.equal(f.node('title').textContent, 'Story progress · v0.4.5');
        assert.ok(!f.node('status').textContent.includes('0.4.5'));
    }
    assert.equal(f.node('title').children.length, 0);
    assert.equal(f.chat.children.length, 0);
});

test('missing or malformed version keeps the familiar heading without rendering arbitrary input', () => {
    for (const version of [undefined, null, 45, {}, '', 'v0.4.5', '0.4.5\nextra', '<img src=x onerror="bad()">']) {
        const f = fixture({ version });
        assert.equal(f.node('title').textContent, 'Story progress');
        assert.equal(f.node('title').children.length, 0);
    }
    assert.equal(fixture({ version: '0.4.5-preview.1' }).node('title').textContent, 'Story progress · v0.4.5-preview.1');
});

test('writer, reviewer and revision progress stays readable without internal keys or false percentages', () => {
    const f = fixture();
    f.panel.update({ visible: true, busy: true, stage: 'section_complete', message: 'The first passage is saved.',
        counts: { completedSections: 1, totalSections: 8, words: 1500, paragraphs: 15 } });
    assert.equal(f.node('stage').textContent, 'Writing your story');
    assert.equal(f.node('message').textContent, 'The first passage is saved.');
    assert.equal(f.node('counts').textContent, '1 of 8 sections finished · 1,500 words · 15 paragraphs');
    f.panel.update({ stage: 'editorial_report', counts: { completedReviews: 1, totalReviews: 2 } });
    assert.equal(f.node('stage').textContent, 'Checking continuity and prose');
    assert.equal(f.node('counts').textContent, '1 of 2 reviews finished');
    f.panel.update({ stage: 'editorial_revise', counts: { completedRevisions: 2, totalRevisions: 4, cycle: 1, maxCycles: 2 } });
    assert.equal(f.node('stage').textContent, 'Revising a passage');
    assert.equal(f.node('counts').textContent, '2 of 4 passages revised · Revision round 1 of 2');
    assert.ok(!f.panel.element.textContent.includes('editorial_revise'));
    assert.ok(!f.panel.element.textContent.includes('%'));
});

test('busy and resumable states gate actions even when disabled controls receive synthetic events', () => {
    const f = fixture();
    f.panel.update({ visible: true, busy: true, canResume: true, canDownload: true, canDismiss: true });
    for (const label of ['Pause', 'Resume', 'View details', 'Download', 'Dismiss']) f.button(label).click();
    assert.deepEqual(f.clicks, ['pause', 'details', 'download']);
    assert.equal(f.button('Resume').hidden, true);
    assert.equal(f.button('Dismiss').disabled, true);
    f.panel.update({ busy: false, stage: 'paused' });
    for (const label of ['Pause', 'Resume', 'View details', 'Download', 'Dismiss']) f.button(label).click();
    assert.deepEqual(f.clicks, ['pause', 'details', 'download', 'resume', 'details', 'download', 'dismiss']);
    assert.equal(f.button('Pause').hidden, true);
    assert.equal(f.button('Dismiss').hidden, false);
    f.panel.update({ visible: false });
    for (const label of ['Pause', 'Resume', 'View details', 'Download', 'Dismiss']) f.button(label).click();
    assert.equal(f.clicks.length, 7);
});

test('unavailable callbacks and capabilities never invoke an action', () => {
    const f = fixture({ onPause: undefined, onDetails: undefined });
    f.panel.update({ visible: true, busy: true, canResume: false, canDownload: false, canDismiss: false });
    for (const label of ['Pause', 'Resume', 'View details', 'Download', 'Dismiss']) {
        assert.equal(f.button(label).disabled, true);
        f.button(label).click();
    }
    assert.deepEqual(f.clicks, []);
});

test('messages and count text use literal text while unknown stage keys never leak into the UI', () => {
    const f = fixture(), text = '<img src=x onerror="bad()"> & <script>bad()</script>';
    f.panel.update({ visible: true, busy: true, message: text, counts: text, stage: 'provider_internal_untrusted_key' });
    assert.equal(f.node('message').textContent, text);
    assert.equal(f.node('counts').textContent, text);
    assert.equal(f.node('stage').textContent, 'Working on your story');
    assert.equal(f.node('message').children.length, 0);
    assert.equal(f.node('counts').children.length, 0);
    assert.ok(!f.nodes.some(node => ['img', 'script'].includes(node.tagName)));
    f.panel.update({ stage: 'toString' });
    assert.equal(f.node('stage').textContent, 'Working on your story');
    f.panel.update({ counts: { words: NaN, paragraphs: -3, completedReviews: Infinity, secretField: text }, message: null, stage: '', busy: false });
    assert.equal(f.node('counts').hidden, true);
    assert.equal(f.node('message').hidden, true);
    assert.equal(f.node('stage').textContent, 'Story progress');
});

test('callback failures show a fixed helpful message without exposing exception text or unhandled rejection', async () => {
    const f = fixture({ onPause: () => { throw new Error('Sensitive provider payload.'); }, onDetails: async () => { throw new Error('Sensitive source text.'); } });
    f.panel.update({ visible: true, busy: true });
    f.button('Pause').click();
    assert.match(f.node('message').textContent, /could not be completed/);
    f.panel.update({ message: 'Working.' });
    f.button('View details').click();
    await Promise.resolve(); await Promise.resolve();
    assert.match(f.node('message').textContent, /could not be completed/);
    assert.ok(!f.panel.element.textContent.includes('Sensitive'));
});

test('destroy removes the panel and its listeners, and later updates cannot recreate it', () => {
    const f = fixture();
    f.panel.update({ visible: true, busy: true });
    const oldText = f.panel.element.textContent;
    f.panel.destroy(); f.panel.destroy();
    f.panel.update({ message: 'This should not appear.', visible: true });
    f.button('Pause').click();
    assert.equal(f.parent.children.length, 0);
    assert.equal(f.panel.element.textContent, oldText);
    assert.deepEqual(f.clicks, []);
    assert.ok(f.nodes.filter(node => node.tagName === 'button').every(node => node.listeners.get('click').size === 0));
});

test('fallback mounting chooses the chat container and then the document body', () => {
    const document = { body: new Node('body'), createElement: tag => new Node(tag), getElementById: () => chat };
    const chat = new Node('div');
    const inChat = createChatProgress({ document });
    assert.deepEqual(chat.children, [inChat.element]);
    document.getElementById = () => null;
    const inBody = createChatProgress({ document });
    assert.deepEqual(document.body.children, [inBody.element]);
    inChat.destroy(); inBody.destroy();
});

test('activity shows a real elapsed wait at zero sections and distinguishes received output from acceptance', () => {
    const f = fixture({ onDownloadActivity: () => f.clicks.push('activity') });
    const entry = { type: 'request', label: 'Planning the story', model: 'fixture/model', startedAt: 1000, status: 'waiting' };
    f.panel.update({ visible: true, busy: true, stage: 'planning', counts: { completedSections: 0, totalSections: 8 }, activity: [entry], now: 66000 });
    assert.match(f.node('waiting').textContent, /Waiting for model response · 1:05 elapsed/);
    assert.equal(f.node('waiting').attributes['aria-live'], 'off');
    assert.equal(f.node('activity').hidden, false);
    assert.equal(f.button('Download').disabled, true);
    f.button('Download activity log').click(); assert.deepEqual(f.clicks, ['activity']);
    entry.status = 'received'; entry.endedAt = 67000; entry.httpStatus = 200; entry.outputCharacters = 1430;
    f.panel.update({ activity: [entry], now: 68000 });
    f.panel.update({ activity: [entry], now: 69000 });
    assert.equal(f.node('activity-list').children.length, 1);
    assert.match(f.node('activity-list').textContent, /Response received.*HTTP 200.*1,430 output characters/);
    assert.equal(f.node('waiting').hidden, true);
    assert.equal(f.node('stage').textContent, 'Planning your story');
    f.panel.update({ stage: 'planning_ready' }); assert.equal(f.node('stage').textContent, 'Outline accepted');
    f.panel.update({ activity: [] }); assert.equal(f.node('activity').hidden, true);
    assert.equal(f.button('Download activity log').disabled, true);
});

test('activity text stays literal and repeated renders do not duplicate entries or create HTML', () => {
    const f = fixture(); const literal = '<img src=x onerror="bad()">';
    f.panel.update({ visible: true, activity: [{ type: 'diagnostic', label: literal, startedAt: 0 }], now: 1000 });
    f.panel.update({ now: 2000 });
    assert.equal(f.node('activity-list').children.length, 1);
    assert.equal(f.node('activity-list').children[0].textContent, literal);
    assert.equal(f.node('activity-list').children[0].children.length, 0);
    assert.ok(!f.nodes.some(node => ['img', 'script'].includes(node.tagName)));
});

test('elapsed ticks do not rewrite unchanged live-region text', () => {
    const f = fixture();
    f.panel.update({ visible: true, busy: true, stage: 'planning', message: 'Planning the story.', counts: { completedSections: 0, totalSections: 8 },
        activity: [{ type: 'request', label: 'Planning', startedAt: 0, status: 'waiting' }], now: 1000 });
    const nodes = ['stage', 'message', 'counts'].map(name => f.node(name)); const writes = nodes.map(node => node.textWrites);
    for (let now = 2000; now <= 5000; now += 1000) f.panel.update({ now });
    assert.deepEqual(nodes.map(node => node.textWrites), writes);
    assert.match(f.node('waiting').textContent, /0:05 elapsed/);
});
