import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULTS, INPUT_CHARACTER_LIMIT, safeSettings, snapshotDraft, snapshotCurrent,
    reviewPayload, buildRequest, complete, reviewDraft, reviseDraft, appendRevision,
} from '../../extensions/StoryReview/review-service.js';

const planning = '[PLANNING_START]Private model planning.[PLANNING_END]';
const draftText = `${planning}\n\nMara entered the archive.\n\nThe archivist handed her a sealed letter.\n\nShe left before dawn.`;
const settings = safeSettings();
function fixture() {
    const earlier = { mes: '<think>Earlier planning.</think>The archivist promised to wait until sunrise.', is_user: false, swipe_id: 1,
        swipes: ['REJECTED HISTORY ALTERNATIVE', 'The archivist promised to wait until sunrise.'] };
    const brief = { mes: 'Write a story with Mara, the archive, and the letter. Preserve all my instructions exactly.', is_user: true };
    const message = { mes: draftText, is_user: false, swipe_id: 0, swipes: [draftText, 'REJECTED DRAFT ALTERNATIVE'],
        swipe_info: [{ extra: { reasoning: 'Original FF reasoning.' } }, { extra: { rejected: true } }],
        extra: { reasoning: 'Original FF reasoning.', token_count: 55, api: 'openrouter', model: 'hermes', display_text: 'STALE DISPLAY TEXT' },
        send_date: '2026-01-01', gen_started: 100, gen_finished: 200 };
    const context = { chat: [earlier, brief, message], getCurrentChatId: () => 'synthetic-chat',
        saveChat: async () => {}, updateMessageBlock: () => {}, eventSource: { emit: async () => {} },
        eventTypes: { MESSAGE_SWIPED: 'message_swiped' } };
    return { context, message, earlier, brief, snapshot: snapshotDraft(context, 2, settings) };
}
function transport(content, overrides = {}) {
    return { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'synthetic-test-token' },
        fetcher: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }], ...overrides }) }) };
}

test('settings are constrained and ignore unrelated fields', () => {
    assert.deepEqual(safeSettings({ bogus: 'ignored' }), DEFAULTS);
    assert.equal(safeSettings({ model: 'bad model name', maxOutput: 999999 }).model, DEFAULTS.model);
    assert.equal(safeSettings({ maxOutput: 999999 }).maxOutput, 16384);
    assert.equal(safeSettings({ enabled: false, autoReview: false }).enabled, false);
    assert.throws(() => safeSettings({ wordMin: 14000, wordMax: 12000 }), /targets/);
});

test('snapshot and payload use selected history only, preserve the complete user brief, and remove planning', () => {
    const { context, snapshot, brief } = fixture();
    const payload = reviewPayload(snapshot);
    assert.equal(snapshotCurrent(context, snapshot), true);
    assert.equal(payload.latestBrief, brief.mes);
    assert.equal(payload.acceptedEarlierConversation.length, 1);
    assert.equal(payload.acceptedEarlierConversation[0].content, 'The archivist promised to wait until sunrise.');
    assert.equal(payload.draft.length, 3);
    assert.equal(payload.counts.paragraphs, 3);
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /REJECTED|Private model planning|Earlier planning|Original FF reasoning/);
    assert.equal(context.chat[2].swipes.length, 2);
});

test('long latest brief is transmitted without silent truncation', () => {
    const { context, brief } = fixture();
    brief.mes = 'START ' + 'Specific requirements. '.repeat(5000) + ' IMPORTANT END';
    const snapshot = snapshotDraft(context, 2, settings);
    const request = buildRequest('Reviewer', reviewPayload(snapshot), settings);
    const data = JSON.parse(request.messages[1].content);
    assert.equal(data.latestBrief, brief.mes);
    assert.ok(data.latestBrief.endsWith('IMPORTANT END'));
});

for (const [name, mutate] of [
    ['user prompt edit', ({ brief }) => { brief.mes += ' Changed requirement.'; }],
    ['earlier accepted text edit', ({ earlier }) => { earlier.mes += ' Changed past.'; }],
    ['earlier swipe', ({ earlier }) => { earlier.swipe_id = 0; }],
    ['current draft edit', ({ message }) => { message.mes += ' Changed draft.'; }],
    ['current swipe', ({ message }) => { message.swipe_id = 1; }],
    ['chat switch', ({ context }) => { context.getCurrentChatId = () => 'different-chat'; }],
    ['new message', ({ context }) => { context.chat.push({ mes: 'Continue', is_user: true }); }],
    ['replaced message object', ({ context, message }) => { context.chat[2] = { ...message }; }],
    ['history visibility changed', ({ earlier }) => { earlier.is_system = true; }],
]) {
    test(`snapshot is invalidated by ${name}`, () => {
        const f = fixture(); mutate(f);
        assert.equal(snapshotCurrent(f.context, f.snapshot), false);
    });
}

test('snapshot rejects user/system/incomplete planning messages', () => {
    const { context } = fixture();
    assert.throws(() => snapshotDraft(context, 1, settings), /completed story/);
    context.chat[2].mes = '[PLANNING_START]Unfinished';
    assert.throws(() => snapshotDraft(context, 2, settings), /unclosed planning block/);
});

test('unsafe separation errors explain the issue without including prompt or draft text', () => {
    const { context, brief } = fixture();
    brief.mes = 'PRIVATE_BRIEF_SENTINEL';
    for (const draft of [
        'PRIVATE_PREFIX_SENTINEL\n\n[PLANNING_START]PRIVATE_REASONING_SENTINEL[PLANNING_END]\n\nPRIVATE_STORY_SENTINEL',
        '[PLANNING_START]PRIVATE_UNFINISHED_SENTINEL',
    ]) {
        context.chat[2].mes = draft;
        assert.throws(() => snapshotDraft(context, 2, settings), error => {
            assert.match(error.message, /Reasoning and story could not be separated safely/);
            assert.match(error.message, /Unmarked text appears before the planning block|unclosed planning block/);
            assert.doesNotMatch(error.message, /PRIVATE|SENTINEL/);
            return true;
        });
    }
});

test('zero-story snapshots allow local counts but cannot make a paid review request', async () => {
    const { context } = fixture();
    let calls = 0;
    const never = { fetcher: async () => { calls++; throw new Error('should not call'); } };
    for (const draft of ['', '[PLANNING_START]PRIVATE_PLAN_SENTINEL[PLANNING_END]', '<think>PRIVATE_PLAN_SENTINEL</think>']) {
        context.chat[2].mes = draft;
        const snapshot = snapshotDraft(context, 2, settings);
        assert.equal(snapshot.analysis.words, 0);
        assert.equal(snapshot.analysis.paragraphs, 0);
        assert.equal(snapshot.analysis.blocked, false);
        await assert.rejects(reviewDraft(snapshot, settings, never), error => {
            assert.match(error.message, /No story prose was found/);
            assert.match(error.message, /Nothing was sent/);
            assert.doesNotMatch(error.message, /PRIVATE|SENTINEL/);
            return true;
        });
    }
    assert.equal(calls, 0);
});

test('request budget refuses oversized input and never truncates silently', () => {
    assert.throws(() => buildRequest('Reviewer', { text: 'x'.repeat(INPUT_CHARACTER_LIMIT) }, settings), /nothing was sent/);
    assert.throws(() => buildRequest('Reviewer', { text: '漢'.repeat(Math.ceil(INPUT_CHARACTER_LIMIT / 3)) }, settings), /nothing was sent/);
    const request = buildRequest('Reviewer', { text: 'short' }, settings);
    assert.equal(request.model, settings.model);
    assert.equal(request.chat_completion_source, 'openrouter');
    assert.equal(request.stream, false);
    assert.equal(request.include_reasoning, false);
    assert.equal(request.middleout, 'off');
});

test('transport uses local proxy, carries headers and signal, and omits API keys', async () => {
    const controller = new AbortController();
    const headers = { 'X-CSRF-Token': 'synthetic-token' };
    let observed;
    const raw = await complete(buildRequest('Editor', { text: 'synthetic' }, settings), {
        headers, signal: controller.signal,
        fetcher: async (url, options) => {
            observed = { url, options };
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'result' }, finish_reason: 'stop' }] }) };
        },
    });
    assert.equal(raw, 'result');
    assert.equal(observed.url, '/api/backends/chat-completions/generate');
    assert.equal(observed.options.headers, headers);
    assert.equal(observed.options.signal, controller.signal);
    assert.doesNotMatch(observed.options.body, /api_key|Authorization|Bearer/);
});

for (const [name, response, expected] of [
    ['HTTP error', { ok: false, status: 429, json: async () => ({ error: { code: 429, message: 'PRIVATE PROVIDER ECHO' } }) }, /failed \(429\)/],
    ['HTTP200 provider error', { ok: true, status: 200, json: async () => ({ error: { code: 503, message: 'PRIVATE PROVIDER ECHO' } }) }, /failed \(503\)/],
    ['truncation', { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }) }, /output limit/],
    ['refusal', { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { refusal: 'no', content: '' } }] }) }, /declined/],
    ['filter', { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }) }, /declined/],
    ['empty output', { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: ' ' } }] }) }, /no text/],
    ['invalid wire JSON', { ok: true, status: 200, json: async () => { throw new Error('PRIVATE JSON ERROR'); } }, /readable response/],
    ['null JSON', { ok: true, status: 200, json: async () => null }, /readable response/],
    ['non-object JSON', { ok: true, status: 200, json: async () => 'PRIVATE PROVIDER ECHO' }, /readable response/],
]) {
    test(`transport safely rejects ${name}`, async () => {
        await assert.rejects(complete({}, { fetcher: async () => response }), error => {
            assert.match(error.message, expected);
            assert.doesNotMatch(error.message, /PRIVATE/);
            return true;
        });
    });
}

test('review parses structured findings and cannot alter chat', async () => {
    const { context, snapshot } = fixture();
    const before = JSON.stringify(context.chat);
    const report = { summary: 'The timing needs a check.', strengths: ['Clear action.'], issues: [{ severity: 'medium', category: 'continuity', paragraphs: [3], problem: 'Verify the time.', suggestion: 'Compare against the earlier promise.' }] };
    assert.equal((await reviewDraft(snapshot, settings, transport(JSON.stringify(report)))).issues[0].paragraphs[0], 3);
    assert.equal(JSON.stringify(context.chat), before);
    await assert.rejects(reviewDraft(snapshot, settings, transport('not json')));
});

test('targeted revision preserves all planning and unselected prose without mutating chat', async () => {
    const { context, snapshot } = fixture();
    const before = JSON.stringify(context.chat);
    const result = await reviseDraft(snapshot, [2], 'Make the handoff specific.', settings, transport('The archivist slid a wax-sealed letter across the desk.'));
    assert.equal(result.updated, `${planning}\n\nMara entered the archive.\n\nThe archivist slid a wax-sealed letter across the desk.\n\nShe left before dawn.`);
    assert.equal(JSON.stringify(context.chat), before);
    assert.equal(result.analysis.paragraphs, 3);
});

test('invalid targeted ranges are refused before calling the provider', async () => {
    const { snapshot } = fixture();
    let calls = 0;
    const never = { fetcher: async () => { calls++; throw new Error('should not call'); } };
    await assert.rejects(reviseDraft(snapshot, [1, 3], 'Edit.', settings, never));
    await assert.rejects(reviseDraft(snapshot, [], 'Edit.', settings, never));
    await assert.rejects(reviseDraft(snapshot, [1], ' ', settings, never));
    assert.equal(calls, 0);
});

test('revision rejects returned planning or code wrappers', async () => {
    const { snapshot } = fixture();
    for (const text of ['<think>plan</think>prose', '[PLANNING_START]plan[PLANNING_END]prose', '```text\nprose\n```']) {
        await assert.rejects(reviseDraft(snapshot, [2], 'Edit.', settings, transport(text)), /planning or formatting/);
    }
});

test('append revision creates a new swipe and preserves the original metadata', async () => {
    const { context, message, snapshot } = fixture();
    let saves = 0; let renders = 0; const emitted = [];
    context.saveChat = async () => { saves++; };
    context.updateMessageBlock = () => { renders++; };
    context.eventSource.emit = async (...args) => emitted.push(args);
    const id = await appendRevision(context, snapshot, 'Revised version.', 'synthetic/model');
    assert.equal(id, 2);
    assert.equal(message.swipes[0], draftText);
    assert.equal(message.swipes[1], 'REJECTED DRAFT ALTERNATIVE');
    assert.equal(message.swipe_info[0].extra.reasoning, 'Original FF reasoning.');
    assert.equal(message.swipe_info[0].extra.display_text, 'STALE DISPLAY TEXT');
    assert.equal(message.mes, 'Revised version.');
    assert.equal(message.extra.display_text, undefined, 'a revised swipe must not render cached original prose');
    assert.equal(message.extra.token_count, undefined);
    assert.equal(message.extra.storyReviewRevision, true);
    assert.equal(message.swipes.length, message.swipe_info.length);
    assert.equal(saves, 1); assert.equal(renders, 1);
    assert.deepEqual(emitted, [['message_swiped', 2]]);
});

test('append revision rejects stale prompts before any save', async () => {
    const { context, snapshot, brief } = fixture();
    let calls = 0; context.saveChat = async () => { calls++; };
    brief.mes += ' New requirement.';
    await assert.rejects(appendRevision(context, snapshot, 'Revision', 'model'), /changed/);
    assert.equal(calls, 0);
});

test('failed save restores the original message and does not render or emit a new swipe', async () => {
    const { context, message, snapshot } = fixture();
    const before = structuredClone(message);
    let renders = 0; let emissions = 0;
    context.saveChat = async () => { throw new Error('Synthetic save failure'); };
    context.updateMessageBlock = () => { renders++; };
    context.eventSource.emit = async () => { emissions++; };
    await assert.rejects(appendRevision(context, snapshot, 'Revision', 'model'), /save failure/);
    assert.deepEqual(message, before);
    assert.equal(renders, 0); assert.equal(emissions, 0);
});

test('failed save removes fields that were absent on an original unswiped message', async () => {
    const { context, message } = fixture();
    for (const key of ['swipes', 'swipe_info', 'swipe_id', 'extra', 'gen_started', 'gen_finished']) delete message[key];
    const snapshot = snapshotDraft(context, 2, settings);
    const before = structuredClone(message);
    context.saveChat = async () => { throw new Error('Synthetic save failure'); };
    await assert.rejects(appendRevision(context, snapshot, 'Revision', 'model'), /save failure/);
    assert.deepEqual(message, before);
});

test('failed save does not roll back a newer user edit made during the request', async () => {
    const { context, message, snapshot } = fixture();
    context.saveChat = async () => { message.mes = 'Newer user edit'; throw new Error('Synthetic save failure'); };
    await assert.rejects(appendRevision(context, snapshot, 'Revision', 'model'), /save failure/);
    assert.equal(message.mes, 'Newer user edit');
});
