import test from 'node:test';
import assert from 'node:assert/strict';
import { createManuscriptSnapshot, reviewManuscript, reviseManuscript } from '../../extensions/StoryReview/workflow-review.js';

const settings = { model: 'synthetic/reviewer', maxOutput: 4096 };
const manuscript = 'Mara entered the archive.\n\nThe archivist handed her a sealed letter.\n\nShe left before dawn.';
const report = () => ({ summary: 'The letter handoff is clear.', strengths: ['The setting is specific.'],
    issues: [{ severity: 'low', category: 'prose', paragraphs: [2], problem: 'The gesture could be more specific.',
        suggestion: 'Describe the archivist sliding the letter across the desk.' }] });
const valid = () => JSON.stringify(report());
const missingIssueClose = () => valid().replace(/}\]}$/, ']}');
const briefReference = '[The complete author brief is supplied in latestBrief in this same request.]';

function fixture(answers = [{}], snapshotSettings = settings) {
    const source = { latestBrief: 'Mara must receive the sealed letter and leave before dawn. ' + 'Keep the established archive details. '.repeat(1200),
        messages: [{ role: 'system', content: 'Complete synthetic reference. '.repeat(900) },
            { role: 'assistant', content: 'The archivist waits beside a green lamp.' }],
        requestTemplate: { secret_id: 'synthetic-active-secret-id' } };
    source.messages.push({ role: 'user', content: `Before the full brief.\n${source.latestBrief}\nAfter the full brief.` });
    const snapshot = createManuscriptSnapshot(manuscript, source, snapshotSettings);
    const f = { source, snapshot, calls: [], requests: [], usage: [], tokenChecks: 0, current: true, controller: new AbortController() };
    f.transport = { models: [{ id: settings.model, context_length: 262144, top_provider: { max_completion_tokens: 32768 } }],
        signal: f.controller.signal, headers: { 'X-CSRF-Token': 'synthetic-csrf' }, assertCurrent: () => f.current,
        countTokens: async () => { f.tokenChecks++; return 1000; },
        onRequest: value => f.requests.push(value), onUsage: value => f.usage.push(value),
        fetcher: async (url, options) => {
            const index = f.calls.length, body = JSON.parse(options.body);
            f.calls.push({ url, options, body });
            const answer = answers[index] ?? answers.at(-1);
            if (answer.throw) throw answer.throw;
            return { ok: answer.status === undefined || answer.status < 400, status: answer.status ?? 200,
                json: async () => {
                    if (answer.jsonError) throw answer.jsonError;
                    if (answer.error) return { error: answer.error };
                    return { choices: [{ finish_reason: answer.finishReason ?? 'stop', message: {
                        content: answer.content ?? valid(), ...(answer.refusal ? { refusal: answer.refusal } : {}) } }],
                    usage: { prompt_tokens: 100 + index, completion_tokens: 40 + index, cost: .01 + index * .001 } };
                } };
        } };
    f.review = (focus = 'continuity') => reviewManuscript(snapshot, focus, settings, f.transport);
    return f;
}

test('a valid first editorial report makes exactly one billed request', async () => {
    const f = fixture(), before = structuredClone(f.snapshot);
    assert.deepEqual(await f.review(), report());
    assert.equal(f.calls.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.tokenChecks, 1);
    assert.deepEqual(f.usage, [{ prompt_tokens: 100, completion_tokens: 40, cost: .01 }]);
    assert.deepEqual(f.snapshot, before);
});

for (const focus of ['continuity', 'prose']) {
    test(`a missing final issue brace retries only the ${focus} focus against the same complete source`, async () => {
        assert.throws(() => JSON.parse(missingIssueClose()), SyntaxError);
        const f = fixture([{ content: missingIssueClose() }, {}]), before = structuredClone(f.snapshot);
        assert.deepEqual(await f.review(focus), report());
        assert.equal(f.calls.length, 2); assert.equal(f.requests.length, 2); assert.equal(f.tokenChecks, 2);
        const [first, second] = f.calls.map(call => call.body);
        assert.equal(second.messages[1].content, first.messages[1].content);
        assert.ok(second.messages[0].content.startsWith(first.messages[0].content));
        assert.match(second.messages[0].content, /complete JSON object.*required field.*closing brace/i);
        const payload = JSON.parse(second.messages[1].content);
        assert.equal(payload.focus, focus); assert.equal(payload.latestBrief, f.source.latestBrief);
        assert.deepEqual(payload.sourceMessages.slice(0, 2), f.source.messages.slice(0, 2));
        assert.equal(payload.sourceMessages[2].content.replaceAll(briefReference, payload.latestBrief), f.source.messages[2].content);
        assert.equal(payload.draft.map(row => row.text).join('\n\n'), manuscript);
        assert.equal(first.secret_id, 'synthetic-active-secret-id'); assert.equal(second.secret_id, first.secret_id);
        assert.equal(first.model, settings.model); assert.equal(second.model, settings.model);
        assert.ok(f.calls.every(call => call.options.signal === f.controller.signal && call.options.headers === f.transport.headers));
        assert.deepEqual(f.usage, [{ prompt_tokens: 100, completion_tokens: 40, cost: .01 },
            { prompt_tokens: 101, completion_tokens: 41, cost: .011 }]);
        assert.equal(f.usage.reduce((sum, usage) => sum + usage.prompt_tokens, 0), 201);
        assert.equal(f.usage.reduce((sum, usage) => sum + usage.completion_tokens, 0), 81);
        assert.deepEqual(f.snapshot, before);
    });
}

for (const [label, mutate] of [
    ['schema', value => { value.issues = null; }],
    ['paragraph reference', value => { value.issues[0].paragraphs = [4]; }],
    ['severity', value => { value.issues[0].severity = 'critical'; }],
]) {
    test(`a ${label} validation failure receives one fresh report rather than locally altering its findings`, async () => {
        const invalid = report(); mutate(invalid);
        const f = fixture([{ content: JSON.stringify(invalid) }, {}]);
        assert.deepEqual(await f.review(), report()); assert.equal(f.calls.length, 2);
        assert.equal(f.calls[0].body.messages[1].content, f.calls[1].body.messages[1].content);
    });
}

test('two malformed reports stop after exactly one retry with a fixed error and no manuscript changes', async () => {
    const f = fixture([{ content: '{INVALID_PROVIDER_TEXT_MUST_NOT_BE_ECHOED' }]), before = structuredClone(f.snapshot);
    await assert.rejects(f.review(), error => {
        assert.match(error.message, /invalid report.*after one automatic retry/i);
        assert.doesNotMatch(error.message, /INVALID_PROVIDER_TEXT/); return true;
    });
    assert.equal(f.calls.length, 2); assert.equal(f.requests.length, 2); assert.equal(f.usage.length, 2);
    assert.doesNotMatch(JSON.stringify(f.calls[1].body), /INVALID_PROVIDER_TEXT/);
    assert.deepEqual(f.snapshot, before); assert.equal(f.snapshot.source, manuscript);
});

for (const [label, answer, expected] of [
    ['refusal', { content: missingIssueClose(), refusal: 'Synthetic refusal.' }, /declined/],
    ['output limit', { content: missingIssueClose(), finishReason: 'length' }, /output limit/],
    ['network failure', { throw: new Error('Synthetic connection failure.') }, /connection failure/],
    ['authentication failure', { status: 401, error: { code: 401, message: 'Do not expose this provider text.' } }, /401/],
    ['credit failure', { status: 402, error: { code: 402 } }, /402/],
    ['context rejection', { status: 413, error: { code: 413 } }, /413/],
    ['empty content', { content: '' }, /no text/],
    ['unreadable service envelope', { jsonError: new SyntaxError('Invalid HTTP JSON') }, /readable response/],
    ['provider cancellation', { throw: new DOMException('Synthetic cancellation.', 'AbortError') }, { name: 'AbortError' }],
]) {
    test(`${label} is never retried as a report-format failure`, async () => {
        const f = fixture([answer]), before = structuredClone(f.snapshot);
        await assert.rejects(f.review(), expected);
        assert.equal(f.calls.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.tokenChecks, 1);
        assert.deepEqual(f.snapshot, before);
    });
}

for (const mode of ['abort', 'source change']) {
    test(`${mode} during the retry budget check prevents another request`, async () => {
        const f = fixture([{ content: missingIssueClose() }, {}]);
        f.transport.countTokens = async () => {
            if (++f.tokenChecks === 2) {
                if (mode === 'abort') f.controller.abort(); else f.current = false;
            }
            return 1000;
        };
        await assert.rejects(f.review(), { name: mode === 'abort' ? 'AbortError' : 'StaleReviewError' });
        assert.equal(f.calls.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.usage.length, 1);
        assert.equal(f.snapshot.source, manuscript);
    });
}

test('the correction reminder is budgeted again and an oversized retry stops before spending another request', async () => {
    const f = fixture([{ content: missingIssueClose() }, {}]);
    f.transport.countTokens = async () => ++f.tokenChecks === 1 ? 1000 : 999999;
    await assert.rejects(f.review(), /complete captured context.*do not fit/);
    assert.equal(f.tokenChecks, 2); assert.equal(f.calls.length, 1); assert.equal(f.requests.length, 1);
    assert.equal(f.usage.length, 1); assert.equal(f.snapshot.source, manuscript);
});

test('a failed targeted prose revision remains single-call and does not use report retry rules', async () => {
    const f = fixture([{ content: '<think>Unrequested planning.</think>Replacement prose.' }]);
    await assert.rejects(reviseManuscript(f.snapshot, [2], 'Make the gesture specific.', settings, f.transport), /planning or formatting/);
    assert.equal(f.calls.length, 1); assert.equal(f.snapshot.source, manuscript);
    assert.doesNotMatch(f.calls[0].body.messages[0].content, /previous response was not a valid editorial report/);
});

for (const [label, strictParagraphs, expected] of [['legacy default', undefined, true], ['required', true, true], ['advisory', false, false]]) {
    test(`${label} paragraph preference is captured and sent explicitly to the reviewer`, async () => {
        const f = fixture([{}], { ...settings, ...(strictParagraphs === undefined ? {} : { strictParagraphs }) });
        assert.equal(f.snapshot.paragraphRangeRequired, expected);
        await f.review();
        const body = f.calls[0].body, payload = JSON.parse(body.messages[1].content);
        assert.equal(payload.counts.paragraphRangeRequired, expected);
        assert.match(body.messages[0].content, /counts\.paragraphRangeRequired is false.*paragraph range is advisory/);
        assert.match(body.messages[0].content, /merging dialogue solely to meet/);
    });
}

test('advisory paragraph preference reaches both a format retry and a targeted revision unchanged', async () => {
    const f = fixture([{ content: missingIssueClose() }, {}], { ...settings, strictParagraphs: false });
    await f.review();
    assert.ok(f.calls.every(call => JSON.parse(call.body.messages[1].content).counts.paragraphRangeRequired === false));
    const r = fixture([{ content: 'The archivist slid the sealed letter across the desk.' }], { ...settings, strictParagraphs: false });
    const replacement = await reviseManuscript(r.snapshot, [2], 'Make the gesture specific.', settings, r.transport);
    assert.equal(r.calls.length, 1);
    const body = r.calls[0].body;
    assert.equal(JSON.parse(body.messages[1].content).counts.paragraphRangeRequired, false);
    assert.match(body.messages[0].content, /do not report a paragraph-count deviation alone as a defect/);
    assert.match(replacement.updated, /slid the sealed letter/);
    assert.equal(r.snapshot.source, manuscript);
});
