import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSettings } from '../../extensions/StoryReview/review-service.js';
import { createManuscriptSnapshot, reviewManuscript, reviseManuscript } from '../../extensions/StoryReview/workflow-review.js';

const settings = safeSettings({ model: 'synthetic/reviewer', maxOutput: 4096 });
const models = [{ id: settings.model, context_length: 262144, top_provider: { max_completion_tokens: 32768 } }];
const report = {
    summary: 'Verify the letter handoff.', strengths: ['The setting is specific.'],
    issues: [{ severity: 'medium', category: 'continuity', paragraphs: [2], problem: 'The seal changes.', suggestion: 'Keep the seal intact.' }],
};
const manuscript = 'Mara entered the archive.\n\nThe archivist handed her a sealed letter.\n\nShe left before dawn.';
const briefReference = '[The complete author brief is supplied in latestBrief in this same request.]';

function fixture(text = manuscript) {
    const source = {
        messages: [
            { role: 'system', content: 'Preserve the author’s requested voice and established facts.' },
            { role: 'assistant', content: 'The archivist promised to wait until sunrise.' },
            { role: 'user', content: 'Mara must receive the sealed letter and leave before dawn.' },
        ],
        latestBrief: 'Mara must receive the sealed letter and leave before dawn.',
        requestTemplate: { secret_id: 'synthetic-active-secret-id' },
    };
    return { source, snapshot: createManuscriptSnapshot(text, source, settings) };
}

function response(content = JSON.stringify(report), extra = {}) {
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }], ...extra }) };
}

function transport(overrides = {}) {
    const requests = [], usage = [], notifications = [];
    const controller = new AbortController();
    let current = true;
    const state = {
        requests, usage, notifications, controller,
        stale() { current = false; },
        transport: {
            headers: { 'X-CSRF-Token': 'synthetic-csrf-token' }, signal: controller.signal,
            models, countTokens: async () => 1000, assertCurrent: () => current,
            onRequest: data => notifications.push(data), onUsage: data => usage.push(data),
            fetcher: async (url, options) => {
                requests.push({ url, options, body: JSON.parse(options.body) });
                return response();
            },
            ...overrides,
        },
    };
    return state;
}

test('manuscript snapshot preserves full captured source and clones every history message', () => {
    const { source } = fixture();
    source.latestBrief = `BRIEF START ${'A specific required event. '.repeat(6000)} BRIEF END`;
    source.messages[0].content += ` ${'Earlier world fact. '.repeat(3000)} HISTORY END`;
    source.messages[2].content = source.latestBrief;
    const original = structuredClone(source);
    const snapshot = createManuscriptSnapshot(`  ${manuscript}\n`, source, settings);
    assert.equal(snapshot.source, `  ${manuscript}\n`);
    assert.equal(snapshot.brief, original.latestBrief);
    assert.deepEqual(snapshot.history, original.messages);
    assert.equal(snapshot.analysis.paragraphs, 3);
    assert.equal(snapshot.analysis.blocked, false);
    source.messages[0].content = 'A later edit must not alter the snapshot.';
    source.messages.push({ role: 'user', content: 'New instruction.' });
    source.latestBrief = 'Changed brief.';
    assert.deepEqual(snapshot.history, original.messages);
    assert.equal(snapshot.brief, original.latestBrief);
});

test('large briefs are included once with lossless user-message references in both focused requests', async () => {
    const { source } = fixture();
    source.latestBrief = `START ${'Keep this exact instruction. '.repeat(5000)} END`;
    source.messages[2].content = `Surrounding instructions before.\n${source.latestBrief}\nSurrounding instructions after.`;
    const snapshot = createManuscriptSnapshot(manuscript, source, settings);
    const t = transport();
    assert.equal((await reviewManuscript(snapshot, 'continuity', settings, t.transport)).summary, report.summary);
    assert.equal((await reviewManuscript(snapshot, 'prose', settings, t.transport)).summary, report.summary);
    assert.equal(t.requests.length, 2);
    const [continuity, prose] = t.requests.map(item => item.body);
    assert.notDeepEqual(continuity.messages, prose.messages);
    assert.match(continuity.messages[0].content, /continuity/i);
    assert.match(prose.messages[0].content, /prose/i);
    for (const body of [continuity, prose]) {
        const payload = JSON.parse(body.messages.find(message => message.role === 'user').content);
        assert.equal(payload.latestBrief, source.latestBrief);
        assert.deepEqual(payload.sourceMessages.slice(0, 2), source.messages.slice(0, 2));
        assert.equal(payload.sourceMessages[2].content, `Surrounding instructions before.\n${briefReference}\nSurrounding instructions after.`);
        assert.equal(payload.sourceMessages[2].content.replaceAll(briefReference, payload.latestBrief), source.messages[2].content);
        assert.equal(body.messages[1].content.split(source.latestBrief).length - 1, 1);
        assert.deepEqual(snapshot.history, source.messages);
        assert.equal(payload.draft.length, 3);
        assert.equal(body.secret_id, source.requestTemplate.secret_id);
        assert.equal(body.model, settings.model);
        assert.equal(body.chat_completion_source, 'openrouter');
        assert.equal(body.middleout, 'off');
    }
});

test('brief references replace only exact user-string matches and preserve all distinct source content', async () => {
    const { source } = fixture();
    const brief = source.latestBrief;
    source.messages = [
        { role: 'system', content: `System quote: ${brief}` },
        { role: 'assistant', content: `Earlier quotation: ${brief}` },
        { role: 'user', content: `First: ${brief}\nSecond: ${brief}`, name: 'Author' },
        { role: 'user', content: brief.replace('sealed letter', 'open letter') },
        { role: 'user', content: [{ type: 'text', text: brief }] },
    ];
    const snapshot = createManuscriptSnapshot(manuscript, source, settings);
    const t = transport();
    await reviewManuscript(snapshot, 'continuity', settings, t.transport);
    const payload = JSON.parse(t.requests[0].body.messages[1].content);
    assert.equal(payload.latestBrief, brief);
    assert.deepEqual(payload.sourceMessages[2], { role: 'user', content: `First: ${briefReference}\nSecond: ${briefReference}`, name: 'Author' });
    for (const index of [0, 1, 3, 4]) assert.deepEqual(payload.sourceMessages[index], source.messages[index]);
    assert.deepEqual(snapshot.history, source.messages);
});

test('source messages without an exact full brief match are transmitted unchanged', async () => {
    const { source } = fixture();
    source.messages[2].content = 'A different complete instruction stays intact.';
    const snapshot = createManuscriptSnapshot(manuscript, source, settings);
    const t = transport();
    await reviewManuscript(snapshot, 'prose', settings, t.transport);
    const payload = JSON.parse(t.requests[0].body.messages[1].content);
    assert.deepEqual(payload.sourceMessages, source.messages);
    assert.equal(payload.latestBrief, source.latestBrief);
});

test('request and usage callbacks accompany the local proxy request and preserve secret selection', async () => {
    const { source, snapshot } = fixture();
    const expectedUsage = { prompt_tokens: 123, completion_tokens: 45, cost: 0.0067 };
    const t = transport();
    t.transport.fetcher = async (url, options) => {
        t.requests.push({ url, options, body: JSON.parse(options.body) });
        return response(JSON.stringify(report), { usage: expectedUsage });
    };
    await reviewManuscript(snapshot, 'continuity', settings, t.transport);
    assert.equal(t.requests.length, 1);
    assert.equal(t.requests[0].url, '/api/backends/chat-completions/generate');
    assert.equal(t.requests[0].options.headers, t.transport.headers);
    assert.equal(t.requests[0].options.signal, t.controller.signal);
    assert.equal(t.requests[0].body.secret_id, source.requestTemplate.secret_id);
    assert.doesNotMatch(t.requests[0].options.body, /api_key|Authorization|Bearer/);
    assert.equal(t.notifications.length, 1);
    assert.deepEqual(t.usage, [expectedUsage]);
});

test('catalog and tokenizer checks precede generation when estimates are not supplied', async () => {
    const { snapshot, source } = fixture();
    const t = transport({ models: undefined, countTokens: undefined });
    t.transport.fetcher = async (url, options) => {
        const body = JSON.parse(options.body);
        t.requests.push({ url, options, body });
        if (url.endsWith('/status')) return { ok: true, status: 200, json: async () => ({ data: models }) };
        if (url.startsWith('/api/tokenizers/')) return { ok: true, status: 200, json: async () => ({ token_count: 1000 }) };
        return response();
    };
    await reviewManuscript(snapshot, 'continuity', settings, t.transport);
    assert.equal(t.requests.length, 3);
    assert.match(t.requests[0].url, /\/status$/);
    assert.equal(t.requests[0].body.secret_id, source.requestTemplate.secret_id);
    assert.match(t.requests[1].url, /^\/api\/tokenizers\//);
    assert.match(t.requests[2].url, /\/generate$/);
});

for (const [label, overrides] of [
    ['insufficient context for input, output, and safety reserve', { models: [{ ...models[0], context_length: 7000 }] }],
    ['unknown model', { models: [] }],
    ['invalid token estimate', { countTokens: async () => NaN }],
]) {
    test(`budget refuses ${label} before generation`, async () => {
        const { snapshot } = fixture();
        const t = transport(overrides);
        await assert.rejects(reviewManuscript(snapshot, 'prose', settings, t.transport));
        assert.equal(t.requests.length, 0);
        assert.equal(t.notifications.length, 0);
    });
}

test('published completion limit is respected before sending a request', async () => {
    const { snapshot } = fixture();
    const t = transport({ models: [{ ...models[0], top_provider: { max_completion_tokens: 2048 } }] });
    await reviewManuscript(snapshot, 'prose', settings, t.transport);
    assert.ok(t.requests[0].body.max_tokens <= 2048);
});

for (const [label, choice] of [
    ['truncated report', { finish_reason: 'length', message: { content: JSON.stringify(report) } }],
    ['refusal', { finish_reason: 'stop', message: { refusal: 'Declined', content: JSON.stringify(report) } }],
    ['content filter', { finish_reason: 'content_filter', message: { content: JSON.stringify(report) } }],
    ['tool calls', { finish_reason: 'stop', message: { content: JSON.stringify(report), tool_calls: [{ id: 'synthetic-call' }] } }],
    ['function call', { finish_reason: 'stop', message: { content: JSON.stringify(report), function_call: { name: 'synthetic' } } }],
]) {
    test(`a ${label} never becomes an accepted review`, async () => {
        const { snapshot } = fixture();
        const t = transport({ fetcher: async () => response('', { choices: [choice] }) });
        await assert.rejects(reviewManuscript(snapshot, 'continuity', settings, t.transport));
        assert.equal(snapshot.source, manuscript);
    });
}

for (const mode of ['stale', 'abort']) {
    for (const phase of ['before request', 'catalog fetch', 'catalog JSON', 'token count', 'tokenizer JSON', 'generation fetch', 'generation JSON']) {
        test(`${mode} during ${phase} prevents a stale report and any subsequent network step`, async () => {
            const { snapshot } = fixture();
            const t = transport();
            const invalidate = () => mode === 'abort' ? t.controller.abort() : t.stale();
            let generateCalls = 0, tokenizerCalls = 0;
            if (phase === 'before request') invalidate();
            if (phase.startsWith('catalog')) t.transport.models = undefined;
            if (phase === 'token count') t.transport.countTokens = async () => { invalidate(); return 1000; };
            if (phase === 'tokenizer JSON') t.transport.countTokens = undefined;
            t.transport.fetcher = async (url) => {
                if (url.endsWith('/status')) {
                    if (phase === 'catalog fetch') invalidate();
                    return { ok: true, status: 200, json: async () => {
                        if (phase === 'catalog JSON') invalidate();
                        return { data: models };
                    } };
                }
                if (url.startsWith('/api/tokenizers/')) {
                    tokenizerCalls++;
                    return { ok: true, status: 200, json: async () => {
                        if (phase === 'tokenizer JSON') invalidate();
                        return { token_count: 1000 };
                    } };
                }
                generateCalls++;
                if (phase === 'generation fetch') invalidate();
                return { ok: true, status: 200, json: async () => {
                    if (phase === 'generation JSON') invalidate();
                    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(report) } }] };
                } };
            };
            await assert.rejects(reviewManuscript(snapshot, 'continuity', settings, t.transport));
            assert.equal(generateCalls, phase.startsWith('generation') ? 1 : 0);
            if (phase === 'before request' || phase.startsWith('catalog')) assert.equal(tokenizerCalls, 0);
            assert.equal(snapshot.source, manuscript);
        });
    }
}

test('an assertCurrent callback that throws also prevents the request', async () => {
    const { snapshot } = fixture();
    const t = transport({ assertCurrent() { throw new Error('Synthetic source change'); } });
    await assert.rejects(reviewManuscript(snapshot, 'prose', settings, t.transport), /Synthetic source change/);
    assert.equal(t.requests.length, 0);
});

test('targeted revision changes only the selected original byte range', async () => {
    const raw = '[PLANNING_START]Preserved planning.[PLANNING_END]\r\n\r\n  Mara entered the archive.\r\n\r\nThe archivist handed her a sealed letter.\r\n\r\nShe left before dawn.  \r\n';
    const { snapshot } = fixture(raw);
    const replacement = 'The archivist slid the still-sealed letter across the desk.';
    const t = transport({ fetcher: async () => response(replacement) });
    const result = await reviseManuscript(snapshot, [2], 'Make the handoff specific.', settings, t.transport);
    assert.equal(result.updated, raw.replace('The archivist handed her a sealed letter.', replacement));
    assert.equal(result.replacement, replacement);
    assert.equal(result.analysis.paragraphs, 3);
    assert.equal(snapshot.source, raw);
});

test('invalid targeted ranges and oversized selections are rejected without network requests', async () => {
    const { snapshot } = fixture();
    const t = transport();
    for (const ids of [[], [1, 3], [4]]) {
        await assert.rejects(reviseManuscript(snapshot, ids, 'Edit.', settings, t.transport));
    }
    await assert.rejects(reviseManuscript(snapshot, [1], ' ', settings, t.transport));
    const many = fixture(Array.from({ length: 13 }, (_, index) => `Paragraph ${index + 1} contains story prose.`).join('\n\n')).snapshot;
    await assert.rejects(reviseManuscript(many, Array.from({ length: 13 }, (_, i) => i + 1), 'Edit.', settings, t.transport));
    const oversized = fixture('word '.repeat(2501)).snapshot;
    await assert.rejects(reviseManuscript(oversized, [1], 'Edit.', settings, t.transport));
    assert.equal(t.requests.length, 0);
});

test('partial, wrapped, or stale replacement prose is never accepted', async () => {
    const { snapshot } = fixture();
    for (const content of ['<think>Planning</think>Revised prose.', '```text\nRevised prose.\n```']) {
        await assert.rejects(reviseManuscript(snapshot, [2], 'Edit.', settings, transport({ fetcher: async () => response(content) }).transport));
    }
    const truncated = response('', { choices: [{ finish_reason: 'length', message: { content: 'Unfinished replacement.' } }] });
    await assert.rejects(reviseManuscript(snapshot, [2], 'Edit.', settings, transport({ fetcher: async () => truncated }).transport));
    const t = transport();
    t.transport.fetcher = async () => ({ ok: true, status: 200, json: async () => {
        t.stale();
        return { choices: [{ finish_reason: 'stop', message: { content: 'Changed prose.' } }] };
    } });
    await assert.rejects(reviseManuscript(snapshot, [2], 'Edit.', settings, t.transport));
    assert.equal(snapshot.source, manuscript);
});
