import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeSettings, createJob, validatePlan, updatePlan, planJob, runJob,
    sectionBudget, sectionMarkers, parseSection, buildSectionRequest, assembledStory, totals,
} from '../../extensions/StoryBuilder/builder-core.js';

const brief = 'Meet beneath the market clock. Repair the compass before crossing.';
const settings = { wordMin: 500, wordMax: 600, paragraphMin: 5, paragraphMax: 8, sectionCount: 2, maxRetries: 1, strictParagraphs: true };
const source = () => ({
    latestBrief: brief, model: 'test/writer', contextLimit: 131072, responseLimit: 32768,
    snapshot: { id: 'synthetic-only' },
    messages: [
        { role: 'system', content: 'FF MAX reasoning stays exactly as supplied. {{unchanged-marker}}' },
        { role: 'assistant', content: 'Earlier accepted context.' },
        { role: 'user', content: brief },
    ],
    requestTemplate: { temperature: 0.95, reasoning_effort: 'high', include_reasoning: false,
        secret_id: 'synthetic-key-reference', tools: [{ type: 'function' }], tool_choice: 'auto',
        functions: [{ name: 'synthetic' }], function_call: 'auto', n: 3, logprobs: true,
        top_logprobs: 5, plugins: [{ id: 'test-plugin' }], middleout: 'on',
    },
});
const plan = () => ({
    fixedFacts: ['The compass is mechanical.'],
    requiredBeats: [{ id: 'b1', briefQuote: 'Meet beneath the market clock.' }, { id: 'b2', briefQuote: 'Repair the compass before crossing.' }],
    sections: [
        { id: 1, title: 'Market', beatIds: ['b1'], startState: 'At the clock', endState: 'Leaving the market', direction: 'Dramatize the meeting.' },
        { id: 2, title: 'Crossing', beatIds: ['b2'], startState: 'At the river', endState: 'Across the river', direction: 'Show the practical repair.' },
    ],
    finalRequirements: ['Finish the crossing.'],
});
function job() { const value = createJob(source(), settings); updatePlan(value, plan()); return value; }
function prose(words, paragraphs) {
    let used = 0;
    return Array.from({ length: paragraphs }, (_, i) => {
        const count = Math.floor(words / paragraphs) + (i < words % paragraphs ? 1 : 0);
        used += count;
        return Array.from({ length: count }, (_, n) => n === 0 ? 'Mara' : 'walked').join(' ') + '.';
    }).join('\n\n');
}
function envelope(value, text, prefix = '[PLANNING_START]Private model planning.[PLANNING_END]') {
    const m = sectionMarkers(value, value.sections.length);
    return `${prefix}\n${m.start}\n${text}\n${m.end}`;
}
const ffAuxiliary = (closeInternal = true) => `<!-- GFX_START -->
<internal_states>
<details><summary>INTERNAL STATES (Turn: 2)</summary>
<details><summary>NPC AGENDAS</summary>Mara wants to finish the repair.</details>
<details><summary>INV & SKILLS</summary>The green lantern remains with Mara.</details>
</details>
${closeInternal ? '</internal_states>' : ''}
<!-- GFX_END -->`;
function mockTransport(responder, overrides = {}) {
    const requests = [];
    const transport = {
        models: [
            { id: 'test/writer', context_length: 131072, top_provider: { max_completion_tokens: 32768 } },
            { id: 'test/alternate', context_length: 262144, top_provider: { max_completion_tokens: 32768 } },
            { id: 'z-ai/glm-5.3', context_length: 200000, top_provider: { max_completion_tokens: 32768 } },
        ],
        countTokens: async () => 1000,
        isCurrent: async () => true,
        fetcher: async (url, request) => {
            const body = JSON.parse(request.body);
            requests.push({ url, body });
            const answer = await responder(body, requests.length, request.signal);
            return { ok: answer.httpStatus ? answer.httpStatus < 400 : true, status: answer.httpStatus || 200,
                json: async () => answer.data || { choices: [{ message: { content: answer.text, ...(answer.message || {}) }, finish_reason: answer.finishReason || 'stop' }], usage: answer.usage || { prompt_tokens: 100, completion_tokens: 200, cost: 0.01 } } };
        },
        ...overrides,
    };
    return { transport, requests };
}
function successfulTransport(value, overrides = {}) {
    return mockTransport(() => {
        const b = sectionBudget(value);
        return { text: envelope(value, prose(b.wordTarget, b.paragraphTarget)) };
    }, overrides);
}

test('settings reject impossible paragraph and section counts', () => {
    assert.throws(() => normalizeSettings({ ...settings, paragraphMin: 5, paragraphMax: 5, sectionCount: 6, wordMin: 1500, wordMax: 1600 }), /paragraph for every section/);
    assert.throws(() => normalizeSettings({ ...settings, maxRetries: 3 }), /retry limit/);
    assert.throws(() => normalizeSettings({ ...settings, wordMin: 501.5 }), /whole numbers/);
    assert.equal(normalizeSettings().strictParagraphs, false);
    assert.throws(() => normalizeSettings({ ...settings, strictParagraphs: 'false' }), /on or off/);
});

test('spending limits accept fractional dollars, reject invalid amounts, and exclude native tracker requests', () => {
    assert.equal(normalizeSettings({ spendLimitUsd: '0.75' }).spendLimitUsd, 0.75);
    assert.equal(normalizeSettings({ spendLimitUsd: 1, updateTracker: true }).updateTracker, false);
    assert.equal(normalizeSettings({ spendLimitUsd: 0, updateTracker: true }).updateTracker, true);
    assert.equal(normalizeSettings().spendLimitUsd, 0);
    for (const spendLimitUsd of [-1, Infinity, NaN, 1001, '', null, true, {}]) {
        assert.throws(() => normalizeSettings({ spendLimitUsd }), /spending limit/);
    }
    assert.equal(normalizeSettings({ maxRevisionPassages: 2 }).maxRevisionPassages, 2);
    for (const maxRevisionPassages of [0, 7, 1.5, NaN]) {
        assert.throws(() => normalizeSettings({ maxRevisionPassages }), /passages|whole numbers/);
    }
    assert.equal(normalizeSettings({ wordMin: 10000, wordMax: 12000, sectionCount: 4 }).sectionCount, 4);
});

test('a source without its complete brief or with tool/image messages fails before any request', () => {
    const missing = source(); missing.messages.at(-1).content = 'Brief was truncated';
    assert.throws(() => createJob(missing, settings), /full latest brief is missing/);
    const image = source(); image.messages.push({ role: 'user', content: [{ type: 'image_url' }] });
    assert.throws(() => createJob(image, settings), /text-only/);
});

test('planner requirements must be traceable, unique, assigned once, and structurally complete', () => {
    const value = job();
    for (const mutate of [
        p => { p.requiredBeats[0].briefQuote = 'Invent a secret conspiracy.'; },
        p => { p.requiredBeats[1].id = 'b1'; },
        p => { p.sections[1].beatIds = ['b1']; },
        p => { p.sections[1].beatIds = []; },
        p => { p.sections[1].beatIds = ['unknown']; },
        p => { p.sections[1].id = 3; },
        p => { p.sections[0].startState = ''; },
        p => { p.fixedFacts = ['']; },
    ]) {
        const invalid = plan(); mutate(invalid);
        assert.throws(() => validatePlan(invalid, value));
    }
    const original = plan(), checked = validatePlan(original, value);
    checked.sections[0].title = 'Edited';
    assert.equal(original.sections[0].title, 'Market');
});

test('every writer request preserves all FF/native messages and includes full original brief', () => {
    const value = job(), original = structuredClone(value.source);
    value.sections.push({ id: 1, text: prose(275, 3), words: 275, paragraphs: 3 });
    const { body } = buildSectionRequest(value);
    assert.deepEqual(body.messages.slice(0, original.messages.length), original.messages);
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.temperature, 0.95);
    const payload = JSON.parse(body.messages.at(-1).content);
    assert.match(payload.originalBriefLocation, /source user messages above/);
    assert.equal(Object.hasOwn(payload, 'fullOriginalBrief'), false);
    assert.ok(body.messages.some(message => message.role === 'user' && message.content === brief));
    assert.equal(payload.completedStory, value.sections[0].text);
    assert.deepEqual(payload.wholeOutline, value.plan.sections);
    assert.deepEqual(value.source, original);
    body.messages[0].content = 'Do not mutate source';
    assert.equal(value.source.messages[0].content, original.messages[0].content);
    assert.equal(body.middleout, 'off'); assert.equal(body.use_fallback, false);
    assert.deepEqual(body.plugins, []);
    for (const key of ['tools', 'tool_choice', 'functions', 'function_call', 'n', 'logprobs', 'top_logprobs']) assert.equal(Object.hasOwn(body, key), false, key);
});

test('model override changes only request model and leaves chat source intact', () => {
    const value = job(); value.settings.writerModel = 'test/alternate';
    assert.equal(buildSectionRequest(value).body.model, 'test/alternate');
    assert.equal(value.source.model, 'test/writer');
});

test('story envelope excludes marked and unmarked leading planning from counts', () => {
    const value = job(), b = sectionBudget(value), markers = sectionMarkers(value, 0), text = prose(275, 3);
    const parsed = parseSection(envelope(value, text, 'Unmarked reasoning.\n[PLANNING_START]More reasoning.[PLANNING_END]'), markers, b);
    assert.deepEqual(parsed.issues, []); assert.equal(parsed.words, 275); assert.equal(parsed.paragraphs, 3);
    assert.equal(parsed.text, text); assert.match(parsed.reasoning, /Unmarked reasoning/);
});

test('missing, duplicate, inline and reversed story boundaries fail closed', () => {
    const value = job(), b = sectionBudget(value), m = sectionMarkers(value, 0), text = prose(275, 3);
    for (const raw of [text, `${m.start}\n${text}`, `${m.end}\n${text}\n${m.start}`, `${m.start}\n${m.start}\n${text}\n${m.end}`, `Mention ${m.start}\n${text}\n${m.end}`, `${m.start}\n${text}\n${m.end} extra`]) {
        const parsed = parseSection(raw, m, b);
        assert.ok(parsed.issues.length); assert.equal(parsed.text, '');
    }
});

test('planning, headings, lists, trailing material and output exhaustion cannot pass as a section', () => {
    const value = job(), b = sectionBudget(value), m = sectionMarkers(value, 0), text = prose(275, 3);
    for (const badText of [`[PLANNING_START]Reasoning[PLANNING_END]\n\n${text}`, `# Heading\n\n${text}`, `- Checklist\n\n${text}`]) assert.ok(parseSection(envelope(value, badText), m, b).issues.length);
    assert.match(parseSection(`${envelope(value, text)}\nUnrequested epilogue.`, m, b).issues.join(' '), /after the story boundary/);
    assert.match(parseSection(envelope(value, text), m, b, 'length').issues.join(' '), /output limit/);
    assert.match(parseSection(envelope(value, text), m, b, 'tool_calls').issues.join(' '), /did not finish/);
});

test('bounded inline FF illustrated props remain byte-exact but do not inflate prose counts', () => {
    const value = job(), budget = sectionBudget(value), markers = sectionMarkers(value, 0);
    const paragraphs = prose(275, 3).split('\n\n');
    const prop = '<!-- GFX_START -->\n<div style="color:green"><b>Bridge Works Tally</b>\n\nRequired quoted receipt: "Keep this original wording."\n<!-- graphic annotation -->\n</div>\n<!-- GFX_END -->';
    const text = `${paragraphs[0]}\n\n${prop}\n\n${paragraphs.slice(1).join('\n\n')}`;
    const parsed = parseSection(envelope(value, text), markers, budget);
    assert.deepEqual(parsed.issues, []); assert.equal(parsed.text, text);
    assert.equal(parsed.words, 275); assert.equal(parsed.paragraphs, 3);
    assert.ok(parsed.text.includes('Required quoted receipt: "Keep this original wording."'));
});

test('recognized FF time/day/location headers stay present without affecting prose counts', () => {
    const value = job(), budget = sectionBudget(value), markers = sectionMarkers(value, 0);
    const header = '[🕰️ 16:20 | 🗓️ Day 1 | 📍 Market]';
    const text = `${header}\n\n${prose(275, 3)}`;
    const parsed = parseSection(envelope(value, text), markers, budget);
    assert.deepEqual(parsed.issues, []); assert.equal(parsed.text, text);
    assert.equal(parsed.words, 275); assert.equal(parsed.paragraphs, 3);
});

test('unclosed or nested inline graphics and unbounded HTML remain rejected', () => {
    const value = job(), budget = sectionBudget(value), markers = sectionMarkers(value, 0), text = prose(275, 3);
    for (const bad of [
        `${text}\n\n<!-- GFX_START --><div>Unclosed prop</div>`,
        `${text}\n\n<!-- GFX_START --><!-- GFX_START --><div>Nested prop</div><!-- GFX_END --><!-- GFX_END -->`,
        `${text}\n\n<!-- GFX_END -->`,
        `<div>${text}</div>`,
        `${text}\n\n<!-- arbitrary comment outside a graphic -->`,
        `${text}\n\n<!-- GFX_START -->[PLANNING_START]Reasoning[PLANNING_END]<!-- GFX_END -->`,
    ]) assert.ok(parseSection(envelope(value, bad), markers, budget).issues.length);
    assert.deepEqual(parseSection(envelope(value, `<font color="#56B4E9">${text}</font>`), markers, budget).issues, []);
});

test('complete recognized FF state envelope is preserved separately and never counted as prose', () => {
    const value = job(), budget = sectionBudget(value), markers = sectionMarkers(value, 0), text = prose(275, 3);
    for (const closeInternal of [true, false]) {
        const auxiliary = ffAuxiliary(closeInternal);
        const parsed = parseSection(`${envelope(value, text)}\n${auxiliary}`, markers, budget);
        assert.deepEqual(parsed.issues, []); assert.equal(parsed.text, text);
        assert.equal(parsed.words, 275); assert.equal(parsed.paragraphs, 3);
        assert.equal(parsed.auxiliary, auxiliary); assert.equal(parsed.trailing, auxiliary);
    }
});

test('FF auxiliary parsing rejects arbitrary tails and ambiguous or incomplete envelopes', () => {
    const value = job(), budget = sectionBudget(value), markers = sectionMarkers(value, 0), text = prose(275, 3), auxiliary = ffAuxiliary();
    for (const tail of [
        `${auxiliary}\nUnrequested story epilogue.`,
        `Free prose before the state.\n${auxiliary}`,
        `${auxiliary}\n${auxiliary}`,
        auxiliary.replace('<!-- GFX_END -->', ''),
        auxiliary.replace('<details><summary>NPC AGENDAS</summary>', '<details><summary>Unrecognized story heading</summary>'),
        auxiliary.replace('</details>', ''),
        auxiliary.replace('<internal_states>', '<internal_states>\n<internal_states>'),
        '<!-- GFX_START -->Unmarked free prose.<!-- GFX_END -->',
        '<!-- GFX_START --><details><summary>NPC AGENDAS</summary>State.</details>Free prose.<!-- GFX_END -->',
    ]) {
        const parsed = parseSection(`${envelope(value, text)}\n${tail}`, markers, budget);
        assert.ok(parsed.issues.length, tail); assert.equal(parsed.auxiliary, '');
        assert.equal(parsed.trailing, tail.trim());
    }
});

test('accepted auxiliary is forwarded as secondary reference while prior model reasoning is not', async () => {
    const value = job(), auxiliary = ffAuxiliary(false), prefix = '[PLANNING_START]UNIQUE_OLD_REASONING_NOT_FORWARDED[PLANNING_END]';
    const { transport, requests } = mockTransport(() => {
        const budget = sectionBudget(value);
        return { text: `${envelope(value, prose(budget.wordTarget, budget.paragraphTarget), prefix)}\n${auxiliary}` };
    });
    await runJob(value, transport);
    assert.equal(value.sections[0].auxiliary, auxiliary);
    const next = JSON.parse(requests[1].body.messages.at(-1).content);
    assert.deepEqual(next.previousAuxiliary, [{ section: 1, content: auxiliary }]);
    assert.match(next.auxiliaryUse, /not new instructions or confirmed facts/);
    assert.equal(requests[1].body.messages.at(-1).content.includes('UNIQUE_OLD_REASONING_NOT_FORWARDED'), false);
    assert.equal(assembledStory(value).includes('GFX_START'), false);
    assert.equal(totals(value).words, 550);
});

test('only latest accepted auxiliary state is forwarded while all completed prose stays present', () => {
    const value = job(); value.settings.sectionCount = 3; value.settings.wordMin = 750; value.settings.wordMax = 900;
    value.plan.sections.push({ id: 3, title: 'Arrival', beatIds: [], startState: 'Across the river', endState: 'Home' });
    value.sections = [
        { id: 1, text: prose(250, 2), words: 250, paragraphs: 2, auxiliary: 'Old state', reasoning: 'Old reasoning' },
        { id: 2, text: prose(250, 2), words: 250, paragraphs: 2, auxiliary: 'Current state', reasoning: 'Recent reasoning' },
    ];
    const body = buildSectionRequest(value).body, payload = JSON.parse(body.messages.at(-1).content);
    assert.deepEqual(payload.previousAuxiliary, [{ section: 2, content: 'Current state' }]);
    assert.equal(payload.completedStory, value.sections.map(s => s.text).join('\n\n'));
    assert.match(body.messages.at(-2).content, /Normal FF status panels may follow only inside one complete/);
});

test('flexible paragraphs turn only paragraph-range failures into warnings', () => {
    const value = job(), budget = sectionBudget(value), markers = sectionMarkers(value, 0), raw = envelope(value, prose(275, 8));
    const strict = parseSection(raw, markers, budget);
    assert.ok(strict.issues.some(issue => issue.includes('8 paragraphs')));
    const flexible = parseSection(raw, markers, budget, 'stop', false);
    assert.deepEqual(flexible.issues, []); assert.equal(flexible.warnings.length, 1);
    assert.equal(flexible.paragraphs, 8); assert.equal(flexible.words, 275);
    assert.match(flexible.warnings[0], /guide/);
    assert.ok(parseSection(envelope(value, prose(100, 8)), markers, budget, 'stop', false).issues.some(issue => issue.includes('100 words')));
    assert.ok(parseSection(envelope(value, `[PLANNING_START]Bad.[PLANNING_END]\n\n${prose(275, 8)}`), markers, budget, 'stop', false).issues.length);
    assert.ok(parseSection(raw, markers, budget, 'length', false).issues.some(issue => issue.includes('output limit')));
});

test('flexible completion reports actual paragraphs without claiming the guide was met', async () => {
    const value = job(); value.settings.strictParagraphs = false;
    const { transport, requests } = mockTransport(() => ({ text: envelope(value, prose(sectionBudget(value).wordTarget, 5)) }));
    const progress = [];
    await runJob(value, transport, { onProgress: update => progress.push(update) });
    assert.equal(value.status, 'complete'); assert.equal(requests.length, 2);
    assert.equal(totals(value).words, 550); assert.equal(totals(value).paragraphs, 10);
    assert.equal(totals(value).wordTargetMet, true); assert.equal(totals(value).paragraphTargetMet, false);
    assert.ok(value.sections.every(section => section.warnings.length));
    assert.match(progress.at(-1).message, /paragraph count is outside the guide/);
    assert.match(requests[0].body.messages.at(-2).content, /Paragraph count is advisory/);
});

test('exhausted paragraph guide does not stop flexible drafting or change word limits', () => {
    const value = job(); value.settings.strictParagraphs = false;
    value.sections.push({ id: 1, text: prose(275, 12), words: 275, paragraphs: 12 });
    const budget = sectionBudget(value);
    assert.equal(budget.wordMin, 225); assert.equal(budget.wordMax, 325);
    assert.ok(budget.paragraphMin >= 1); assert.ok(budget.paragraphMax >= budget.paragraphMin);
    value.settings.strictParagraphs = true;
    assert.throws(() => sectionBudget(value), /remaining length budget/);
});

test('local measurements determine complete status and sections are joined without rewriting', async () => {
    const value = job(), { transport, requests } = successfulTransport(value);
    await runJob(value, transport);
    assert.equal(value.status, 'complete'); assert.equal(requests.length, 2);
    assert.equal(totals(value).words, 550); assert.equal(totals(value).paragraphs, 7);
    assert.equal(assembledStory(value), value.sections.map(s => s.text).join('\n\n'));
    assert.equal(value.pending, null); assert.equal(value.usage.cost, 0.02);
    assert.throws(() => updatePlan(value, plan()), /after drafting/);
});

test('invalid section retries are bounded and failed drafts never enter completed manuscript', async () => {
    const value = job(), { transport, requests } = mockTransport(() => ({ text: envelope(value, prose(100, 3)) }));
    const progress = [];
    await runJob(value, transport, { onProgress: value => progress.push(value) });
    assert.equal(value.status, 'needs_attention'); assert.equal(requests.length, 2);
    assert.equal(value.sections.length, 0); assert.equal(assembledStory(value), '');
    assert.equal(value.pending.attempts, 2); assert.equal(value.pending.words, 100);
    const repair = JSON.parse(requests[1].body.messages.at(-1).content).repair;
    assert.equal(repair.rejectedSection, value.pending.text);
    assert.match(repair.measuredProblems.join(' '), /100 words/);
    assert.equal(progress.filter(p => p.stage === 'section_rejected').length, 2);
    assert.match(progress.at(-1).message, /exhausted/);
});

test('pause after a completed section resumes without paying to regenerate it', async () => {
    const value = job(), { transport, requests } = successfulTransport(value);
    await runJob(value, transport, { stopAfterSections: 1 });
    assert.equal(value.status, 'paused'); assert.equal(requests.length, 1);
    const accepted = value.sections[0];
    await runJob(value, transport);
    assert.equal(value.status, 'complete'); assert.equal(requests.length, 2);
    assert.equal(value.sections[0], accepted);
    const payload = JSON.parse(requests[1].body.messages.at(-1).content);
    assert.equal(payload.currentSection.id, 2); assert.equal(payload.completedStory, accepted.text);
});

test('cancellation preserves completed sections and prevents the next paid request', async () => {
    const value = job(), control = new AbortController(), { transport, requests } = successfulTransport(value);
    await assert.rejects(runJob(value, transport, { signal: control.signal, onProgress: p => { if (p.stage === 'section_complete') control.abort(); } }), { name: 'AbortError' });
    assert.equal(value.status, 'paused'); assert.equal(value.sections.length, 1); assert.equal(requests.length, 1);
    await runJob(value, transport);
    assert.equal(value.status, 'complete'); assert.equal(requests.length, 2);
});

test('cancellation before starting makes no model request', async () => {
    const value = job(), control = new AbortController(), { transport, requests } = successfulTransport(value);
    control.abort();
    await assert.rejects(runJob(value, transport, { signal: control.signal }), { name: 'AbortError' });
    assert.equal(requests.length, 0);
});

test('stale source before writing prevents a paid request', async () => {
    const value = job(), { transport, requests } = successfulTransport(value, { isCurrent: () => false });
    await assert.rejects(runJob(value, transport), /source chat, prompt, or writing settings changed/);
    assert.equal(requests.length, 0); assert.equal(value.sections.length, 0);
});

test('a response arriving after a source change is rejected while known usage is retained', async () => {
    const value = job(); let current = true;
    const { transport, requests } = mockTransport(() => { current = false; return { text: envelope(value, prose(275, 3)) }; }, { isCurrent: () => current });
    await assert.rejects(runJob(value, transport), /source chat, prompt, or writing settings changed/);
    assert.equal(requests.length, 1); assert.equal(value.sections.length, 0); assert.equal(value.usage.cost, 0.01);
});

test('context overflow pauses without any completion request or source truncation', async () => {
    const value = job(), before = structuredClone(value.source), { transport, requests } = successfulTransport(value, { countTokens: async () => 130000 });
    await assert.rejects(runJob(value, transport), /without dropping or compressing/);
    assert.equal(requests.length, 0); assert.deepEqual(value.source, before);
});

test('catalog capacity is used for coordinated requests without changing native context preference', async () => {
    const value = job(); value.source.contextLimit = 1000;
    const { transport, requests } = successfulTransport(value);
    await runJob(value, transport, { stopAfterSections: 1 });
    assert.equal(requests.length, 1); assert.equal(value.source.contextLimit, 1000);
    assert.equal(value.lastBudget.contextLimit, 131072);
});

test('unknown model is rejected before a paid completion request', async () => {
    const value = job(), { transport, requests } = successfulTransport(value, { models: [] });
    await assert.rejects(runJob(value, transport), /unavailable/);
    assert.equal(requests.length, 0);
});

test('published response cap is honored without mutating source response allowance', async () => {
    const value = job(), { transport, requests } = successfulTransport(value, { models: [{ id: 'test/writer', context_length: 131072, top_provider: { max_completion_tokens: 8192 } }] });
    await runJob(value, transport, { stopAfterSections: 1 });
    assert.equal(requests[0].body.max_tokens, 8192); assert.equal(value.source.responseLimit, 32768);
});

test('provider errors preserve completed sections and do not trigger repeated paid attempts', async () => {
    const value = job(); value.sections.push({ id: 1, text: prose(275, 3), words: 275, paragraphs: 3 });
    const { transport, requests } = mockTransport(() => ({ httpStatus: 400, data: { error: { code: 400, message: 'synthetic private provider detail' } } }));
    await assert.rejects(runJob(value, transport), e => /failed \(400\)/.test(e.message) && !e.message.includes('private provider detail'));
    assert.equal(value.sections.length, 1); assert.equal(requests.length, 1);
});

test('provider errors receive useful fixed diagnostics without exposing their text', async () => {
    const privateExcerpt = 'Synthetic source excerpt that must never appear in the UI';
    const cases = [
        [{ code: 402, message: privateExcerpt }, /insufficient credit/],
        [{ message: `You can only afford this many tokens. ${privateExcerpt}` }, /insufficient credit/],
        [{ code: 429, message: privateExcerpt }, /rate limited/],
        [{ message: `Rate limit exceeded. ${privateExcerpt}` }, /rate limited/],
        [{ code: 401, message: privateExcerpt }, /could not authenticate/],
        [{ message: `Invalid API key. ${privateExcerpt}` }, /could not authenticate/],
        [{ code: 'context_length_exceeded', message: privateExcerpt }, /context limit/],
        [{ message: `Maximum context length exceeded. ${privateExcerpt}` }, /context limit/],
        [{ message: 'Upstream error', metadata: { raw: `No endpoints found. ${privateExcerpt}` } }, /no available endpoint/],
        [{ message: privateExcerpt }, /failed \(provider error\)/],
    ];
    for (const [error, expected] of cases) {
        const value = job(), { transport, requests } = mockTransport(() => ({ data: { error } }));
        await assert.rejects(runJob(value, transport), e => expected.test(e.message) && !e.message.includes(privateExcerpt) && !e.message.includes('(200)'));
        assert.equal(requests.length, 1); assert.equal(value.sections.length, 0);
    }
});

test('tool calls and refusals are not accepted as prose even when content exists', async () => {
    for (const answer of [
        { finishReason: 'tool_calls' },
        { message: { tool_calls: [{ id: 'synthetic' }] } },
        { message: { function_call: { name: 'synthetic' } } },
        { message: { refusal: 'Synthetic refusal' } },
    ]) {
        const value = job(), { transport, requests } = mockTransport(() => ({ text: envelope(value, prose(275, 3)), ...answer }));
        await assert.rejects(runJob(value, transport));
        assert.equal(value.sections.length, 0); assert.equal(requests.length, 1);
    }
});

test('planner uses separate request and preserves full source while accepting only validated JSON', async () => {
    const value = createJob(source(), settings), before = structuredClone(value.source);
    const { transport, requests } = mockTransport(() => ({ text: JSON.stringify(plan()) }));
    await planJob(value, transport);
    assert.equal(value.status, 'ready'); assert.deepEqual(value.source, before);
    const payload = JSON.parse(requests[0].body.messages[1].content);
    assert.equal(payload.briefPassages.map(passage => passage.text).join(''), brief);
    assert.equal(Object.hasOwn(payload, 'latestBrief'), false);
    assert.deepEqual(payload.sourceMessages.slice(0, -1), before.messages.slice(0, -1));
    assert.match(payload.sourceMessages.at(-1).content, /supplied in briefPassages/);
    assert.equal(payload.sourceMessages.at(-1).content.includes(brief), false);
    assert.equal(value.source.messages.at(-1).content, brief);
    assert.equal(requests[0].body.model, 'z-ai/glm-5.3');
});

test('truncated or untraceable planner output never becomes an accepted outline', async () => {
    for (const answer of [
        { text: JSON.stringify(plan()), finishReason: 'length' },
        { text: '{bad json' },
        { text: JSON.stringify({ ...plan(), requiredBeats: [{ id: 'b1', briefQuote: 'not in brief' }] }) },
    ]) {
        const value = createJob(source(), settings), { transport } = mockTransport(() => answer);
        await assert.rejects(planJob(value, transport));
        assert.equal(value.plan, null); assert.equal(value.sections.length, 0);
    }
});
