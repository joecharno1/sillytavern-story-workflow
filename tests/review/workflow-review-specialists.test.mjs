import test from 'node:test';
import assert from 'node:assert/strict';
import { createManuscriptSnapshot, reviewManuscript, reviseManuscript } from '../../extensions/StoryReview/workflow-review.js';

const text = 'Mara entered the archive.\n\nThe archivist handed her a sealed letter.\n\nShe left before dawn.';
const guidance = 'Prefer concrete sensory details and natural speaker breaks.';
const briefReference = '[The complete author brief is supplied in latestBrief in this same request.]';
const descriptors = [
    { id: 'dialogue', label: 'Dialogue', instruction: 'Keep exchanges concise while preserving distinct speaker voices.', model: 'synthetic/dialogue' },
    { id: 'physical', label: 'Physical detail', instruction: 'Keep hand positions and carried objects physically consistent.', model: 'synthetic/physical' },
    { id: 'character', label: 'Character', instruction: 'Preserve established motives and differences in what characters know.', model: 'synthetic/character' },
    { id: 'atmosphere', label: 'Atmosphere', instruction: 'Keep sensory details consistent with the established archive.', model: 'synthetic/atmosphere' },
];
const validReport = () => ({ summary: 'The handoff is clear.', strengths: ['The archive is specific.'], issues: [
    { severity: 'low', category: 'prose', paragraphs: [2], problem: 'The gesture could be clearer.', suggestion: 'Specify how the letter is passed.' },
] });
const settings = () => ({ model: 'synthetic/general', revisionModel: 'synthetic/revision', maxOutput: 4096,
    writingGuidance: guidance, specialists: structuredClone(descriptors) });

function fixture(answers = [{}]) {
    const source = { latestBrief: 'Mara must receive the sealed letter and leave before dawn.',
        messages: [{ role: 'system', content: 'Preserve the established archive and the requested narrative voice.' },
            { role: 'assistant', content: 'The archivist promised to wait beside the green lamp.' },
            { role: 'user', content: 'Mara must receive the sealed letter and leave before dawn.' }],
        requestTemplate: { secret_id: 'synthetic-secret-selection' } };
    const snapshot = createManuscriptSnapshot(text, source, { ...settings(), strictParagraphs: false });
    const f = { source, snapshot, requests: [], notifications: [], usage: [], current: true, controller: new AbortController(), counted: [] };
    f.transport = {
        signal: f.controller.signal, headers: { 'X-CSRF-Token': 'synthetic' }, assertCurrent: () => f.current,
        models: ['synthetic/general', 'synthetic/revision', ...descriptors.map(item => item.model)].map(id => ({ id,
            context_length: 262144, top_provider: { max_completion_tokens: 32768 } })),
        countTokens: async (messages, model) => { f.counted.push({ messages: structuredClone(messages), model }); return 1000; },
        onRequest: value => f.notifications.push(value), onUsage: value => f.usage.push(value),
        fetcher: async (url, options) => {
            const index = f.requests.length;
            f.requests.push({ url, options, body: JSON.parse(options.body) });
            const answer = answers[index] ?? answers.at(-1);
            if (answer.error) throw answer.error;
            answer.onFetch?.(f);
            return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: answer.finishReason ?? 'stop',
                message: { content: answer.content ?? JSON.stringify(validReport()), ...(answer.refusal ? { refusal: 'Declined.' } : {}) } }],
            usage: { prompt_tokens: 100 + index, completion_tokens: 30 + index, cost: .01 + index * .001 } }) };
        },
    };
    return f;
}

function assertFullSource(body, source) {
    const payload = JSON.parse(body.messages[1].content);
    assert.equal(payload.latestBrief, source.latestBrief);
    assert.deepEqual(payload.sourceMessages.slice(0, 2), source.messages.slice(0, 2));
    assert.equal(payload.sourceMessages[2].content.replaceAll(briefReference, payload.latestBrief), source.messages[2].content);
    assert.equal(payload.draft.map(item => item.text).join('\n\n'), text);
    assert.equal(body.secret_id, source.requestTemplate.secret_id);
    assert.equal(body.middleout, 'off');
    assert.deepEqual(body.plugins, []);
    assert.equal(payload.counts.paragraphRangeRequired, false);
    return payload;
}

for (const descriptor of descriptors) {
    test(`the configured ${descriptor.id} specialist uses its own model and full source`, async () => {
        const f = fixture(), before = structuredClone(f.snapshot), config = settings();
        assert.deepEqual(await reviewManuscript(f.snapshot, descriptor.id, config, f.transport), validReport());
        assert.equal(f.requests.length, 1);
        const body = f.requests[0].body, payload = assertFullSource(body, f.source);
        assert.equal(body.model, descriptor.model);
        assert.equal(payload.focus, descriptor.id);
        assert.equal(payload.writingGuidance, guidance);
        assert.deepEqual(payload.specialist, { id: descriptor.id, label: descriptor.label, instruction: descriptor.instruction });
        assert.equal(f.counted[0].model, descriptor.model);
        assert.equal(f.notifications[0].model, descriptor.model);
        assert.equal(f.usage.length, 1);
        assert.deepEqual(f.snapshot, before);
        assert.deepEqual(config, settings());
    });
}

test('ordinary prose review receives writing preferences without becoming a specialist call', async () => {
    const f = fixture();
    await reviewManuscript(f.snapshot, 'prose', settings(), f.transport);
    const body = f.requests[0].body, payload = assertFullSource(body, f.source);
    assert.equal(body.model, 'synthetic/general');
    assert.equal(payload.writingGuidance, guidance);
    assert.equal(payload.specialist, undefined);
    assert.match(body.messages[0].content, /(?:preference|guidance)[\s\S]*(?:brief|explicit author)/i);
    assert.match(body.messages[0].content, /(?:brief|explicit author)[\s\S]*(?:precedence|override|authoritative|win)/i);
    assert.match(body.messages[0].content, /(?:add|remov)[\s\S]*scenes/i);
});

for (const [label, focus, change] of [
    ['unconfigured specialist', 'dialogue', config => { config.specialists = []; }],
    ['unknown focus', 'invented', () => {}],
    ['duplicate specialist', 'dialogue', config => { config.specialists.push({ ...config.specialists[0] }); }],
    ['unknown specialist ID', 'dialogue', config => { config.specialists[1].id = 'invented'; }],
    ['invalid specialist model', 'dialogue', config => { config.specialists[0].model = 'invalid model with spaces'; }],
    ['missing specialist instruction', 'dialogue', config => { delete config.specialists[0].instruction; }],
    ['invalid specialist label', 'dialogue', config => { config.specialists[0].label = {}; }],
]) {
    test(`${label} is rejected before any model request`, async () => {
        const f = fixture(), config = settings(); change(config);
        await assert.rejects(reviewManuscript(f.snapshot, focus, config, f.transport));
        assert.equal(f.requests.length, 0);
        assert.equal(f.notifications.length, 0);
        assert.equal(f.snapshot.source, text);
    });
}

test('a specialist malformed report retries only that focus, with the same complete payload and accounted usage', async () => {
    const malformed = JSON.stringify(validReport()).replace(/}\]}$/, ']}');
    assert.throws(() => JSON.parse(malformed));
    const f = fixture([{ content: malformed }, {}]);
    assert.deepEqual(await reviewManuscript(f.snapshot, 'physical', settings(), f.transport), validReport());
    assert.equal(f.requests.length, 2);
    const [first, second] = f.requests.map(item => item.body);
    assert.equal(first.model, 'synthetic/physical'); assert.equal(second.model, first.model);
    assert.equal(second.messages[1].content, first.messages[1].content);
    assert.ok(second.messages[0].content.startsWith(first.messages[0].content));
    assert.match(second.messages[0].content, /previous response was not a valid editorial report/i);
    assertFullSource(second, f.source);
    assert.equal(f.notifications.length, 2);
    assert.deepEqual(f.usage, [{ prompt_tokens: 100, completion_tokens: 30, cost: .01 },
        { prompt_tokens: 101, completion_tokens: 31, cost: .011 }]);
    assert.equal(f.snapshot.source, text);
});

for (const [label, answer, expected] of [
    ['refusal', { refusal: true }, /declined/],
    ['output limit', { finishReason: 'length' }, /output limit/],
    ['spending stop', { error: Object.assign(new Error('Synthetic spending limit.'), { name: 'SpendLimitError' }) }, { name: 'SpendLimitError' }],
    ['source change', { onFetch: f => { f.current = false; } }, { name: 'StaleReviewError' }],
    ['cancellation', { onFetch: f => f.controller.abort() }, { name: 'AbortError' }],
]) {
    test(`specialist ${label} cannot trigger a format retry`, async () => {
        const f = fixture([answer]);
        await assert.rejects(reviewManuscript(f.snapshot, 'character', settings(), f.transport), expected);
        assert.equal(f.requests.length, 1);
        assert.equal(f.snapshot.source, text);
    });
}

test('a specialist with insufficient context is rejected without dropping source or calling a model', async () => {
    const f = fixture();
    f.transport.models.find(item => item.id === 'synthetic/atmosphere').context_length = 5000;
    await assert.rejects(reviewManuscript(f.snapshot, 'atmosphere', settings(), f.transport), /complete captured context.*do not fit/i);
    assert.equal(f.requests.length, 0);
    assert.equal(f.notifications.length, 0);
    assert.equal(f.snapshot.source, text);
});

for (const specialistFocus of [undefined, 'dialogue']) {
    test(`${specialistFocus ?? 'ordinary'} revision uses its routed model and keeps all surrounding prose`, async () => {
        const replacement = 'The archivist slid the sealed letter across the desk.';
        const f = fixture([{ content: replacement }]);
        const config = { ...settings(), ...(specialistFocus ? { specialistFocus } : {}) };
        const result = await reviseManuscript(f.snapshot, [2], 'Make the handoff concrete without changing its outcome.', config, f.transport);
        assert.equal(f.requests.length, 1);
        const body = f.requests[0].body, payload = assertFullSource(body, f.source);
        assert.equal(body.model, specialistFocus ? 'synthetic/dialogue' : 'synthetic/revision');
        assert.equal(payload.writingGuidance, guidance);
        assert.equal(payload.specialist?.id, specialistFocus);
        assert.deepEqual(payload.selectedParagraphs, [2]);
        assert.equal(result.replacement, replacement);
        assert.equal(result.updated, text.replace('The archivist handed her a sealed letter.', replacement));
        assert.equal(f.snapshot.source, text);
    });
}

test('ordinary revision falls back to the reviewer model when no revision model is set', async () => {
    const f = fixture([{ content: 'The archivist offered her the sealed letter.' }]);
    await reviseManuscript(f.snapshot, [2], 'Clarify the handoff.', { ...settings(), revisionModel: '' }, f.transport);
    assert.equal(f.requests[0].body.model, 'synthetic/general');
});

test('an unconfigured revision specialist does not silently fall back to a different model', async () => {
    const f = fixture();
    await assert.rejects(reviseManuscript(f.snapshot, [2], 'Clarify the handoff.',
        { ...settings(), specialistFocus: 'dialogue', specialists: [] }, f.transport));
    assert.equal(f.requests.length, 0);
});

for (const [label, change] of [
    ['writing guidance', config => { config.writingGuidance = 'x'.repeat(40001); }],
    ['specialist instruction', config => { config.specialists[0].instruction = 'x'.repeat(8501); }],
    ['specialist label', config => { config.specialists[0].label = 'x'.repeat(81); }],
]) {
    test(`oversized ${label} is rejected instead of silently shortening the preference`, async () => {
        const f = fixture(), config = settings(); change(config);
        const before = structuredClone(config);
        await assert.rejects(reviewManuscript(f.snapshot, 'dialogue', config, f.transport));
        assert.equal(f.requests.length, 0);
        assert.equal(f.notifications.length, 0);
        assert.deepEqual(config, before);
    });
}

test('allowed large specialist directions and writing guidance are sent intact', async () => {
    const f = fixture(), config = settings();
    config.writingGuidance = 'W'.repeat(40000);
    config.specialists[0].instruction = 'I'.repeat(8500);
    await reviewManuscript(f.snapshot, 'dialogue', config, f.transport);
    const payload = JSON.parse(f.requests[0].body.messages[1].content);
    assert.equal(payload.writingGuidance, config.writingGuidance);
    assert.equal(payload.specialist.instruction, config.specialists[0].instruction);
    assertFullSource(f.requests[0].body, f.source);
});
