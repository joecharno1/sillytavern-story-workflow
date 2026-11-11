import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, createJob, updatePlan, sectionBudget, sectionMarkers, parseSection, runJob, totals } from '../../extensions/StoryBuilder/builder-core.js';

const settings = { wordMin: 500, wordMax: 600, paragraphMin: 5, paragraphMax: 8, sectionCount: 2,
    strictParagraphs: false, maxRetries: 0, continuityEnabled: false };
function budgetJob(overrides = {}, previousWords = []) {
    return { settings: normalizeSettings({ ...settings, ...overrides }),
        sections: previousWords.map((words, index) => ({ id: index + 1, words, paragraphs: 3, text: `Accepted section ${index + 1}.` })) };
}
function prose(words, paragraphs = 3) {
    return Array.from({ length: paragraphs }, (_, index) => {
        const count = Math.floor(words / paragraphs) + (index < words % paragraphs ? 1 : 0);
        return Array.from({ length: count }, (_, word) => word ? 'walked' : 'Mara').join(' ') + '.';
    }).join('\n\n');
}
const markers = { start: '[STORY_TEST_1_START]', end: '[STORY_TEST_1_END]' };
const rawSection = words => `${markers.start}\n${prose(words)}\n${markers.end}`;
const parsed = (words, budget, finish = 'stop') => parseSection(rawSection(words), markers, budget, finish, false);

test('the actual uneven long-story allocation accepts 1,667 words as feasible with a guide warning', () => {
    const job = budgetJob({ wordMin: 10000, wordMax: 12000, sectionCount: 8, paragraphMin: 80, paragraphMax: 120 }, [1400, 1533]);
    const before = structuredClone(job), budget = sectionBudget(job), result = parsed(1667, budget);
    assert.equal(budget.wordMax, 1614); assert.ok(budget.feasibleWordMin <= 1667); assert.ok(budget.feasibleWordMax >= 1667);
    assert.deepEqual(result.issues, []); assert.equal(result.words, 1667);
    assert.ok(result.warnings.some(warning => /1667.*words/i.test(warning)));
    assert.deepEqual(job, before);
});

test('a section below its local guide remains acceptable when the rest of the requested story can still fit', () => {
    const budget = sectionBudget(budgetJob({ wordMin: 10000, wordMax: 12000, sectionCount: 8 }, [1400, 1533]));
    const words = budget.wordMin - 1, result = parsed(words, budget);
    assert.ok(words >= budget.feasibleWordMin); assert.deepEqual(result.issues, []);
    assert.ok(result.warnings.some(warning => warning.includes(`${words} words`)));
});

test('feasible bounds reserve 150 to 4,000 words for every later section', () => {
    const job = budgetJob({ wordMin: 7000, wordMax: 12000, sectionCount: 3 }, [150]);
    const budget = sectionBudget(job);
    assert.equal(budget.feasibleWordMin, 2850); assert.equal(budget.feasibleWordMax, 4000);
    assert.equal(budget.wordTarget, 4000, 'a feasible minimum is not rejected because the unconstrained average exceeds 4,000');
    assert.deepEqual(parsed(2850, budget).issues, []); assert.deepEqual(parsed(4000, budget).issues, []);
    assert.ok(parsed(2849, budget).issues.some(issue => /words/.test(issue)));
    assert.ok(parsed(4001, budget).issues.some(issue => /words/.test(issue)));
});

test('impossible remaining intervals fail instead of weakening the whole-story bounds', () => {
    const cases = [
        budgetJob({ wordMin: 10000, wordMax: 12000, sectionCount: 3 }, [150]),
        budgetJob({ wordMin: 1000, wordMax: 1200, sectionCount: 4 }, [500, 500]),
        budgetJob({}, [500]),
    ];
    for (const job of cases) {
        const before = structuredClone(job);
        assert.throws(() => sectionBudget(job), /remaining.*(?:budget|target)/); assert.deepEqual(job, before);
    }
});

test('the final section uses the actual remaining whole-story range as both its guide and hard bounds', () => {
    const budget = sectionBudget(budgetJob({}, [350]));
    assert.equal(budget.wordMin, 150); assert.equal(budget.wordMax, 250);
    assert.equal(budget.feasibleWordMin, 150); assert.equal(budget.feasibleWordMax, 250);
    for (const words of [150, 200, 250]) assert.deepEqual(parsed(words, budget).issues, []);
    for (const words of [149, 251]) assert.ok(parsed(words, budget).issues.some(issue => issue.includes(`${words} words`)));
});

test('legacy parse budgets without feasible fields retain their former hard word range', () => {
    const current = sectionBudget(budgetJob()), legacy = { ...current };
    delete legacy.feasibleWordMin; delete legacy.feasibleWordMax;
    assert.deepEqual(parsed(350, current).issues, []);
    assert.ok(parsed(350, legacy).issues.some(issue => issue.includes('350 words')));
    assert.deepEqual(parsed(275, legacy).issues, []);
});

test('word-allocation flexibility never accepts truncated responses or malformed story envelopes', () => {
    const budget = sectionBudget(budgetJob());
    assert.ok(parsed(350, budget, 'length').issues.some(issue => /output limit/.test(issue)));
    assert.ok(parseSection(rawSection(350) + '\nUnrequested epilogue.', markers, budget, 'stop', false).issues.some(issue => /after the story boundary/.test(issue)));
    assert.ok(parseSection(rawSection(350).replace(markers.end, ''), markers, budget, 'stop', false).issues.length);
});

test('deterministic uneven states preserve feasible interval and target invariants', () => {
    let seed = 104729;
    const next = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    let feasible = 0, impossible = 0;
    for (let sample = 0; sample < 1000; sample++) {
        const sectionCount = 2 + next(19), maximum = Math.min(50000, sectionCount * 4000);
        const wordMin = sectionCount * 250 + next(maximum - sectionCount * 250 + 1);
        const wordMax = wordMin + next(maximum - wordMin + 1), done = next(sectionCount);
        const previous = Array.from({ length: done }, () => 150 + next(3851));
        const job = budgetJob({ sectionCount, wordMin, wordMax }, previous), left = sectionCount - done;
        const used = previous.reduce((sum, value) => sum + value, 0);
        const minimum = Math.max(150, wordMin - used - 4000 * (left - 1));
        const maximumCurrent = Math.min(4000, wordMax - used - 150 * (left - 1));
        if (minimum > maximumCurrent) {
            impossible++; assert.throws(() => sectionBudget(job), /remaining.*(?:budget|target)/); continue;
        }
        feasible++;
        const budget = sectionBudget(job);
        assert.equal(budget.feasibleWordMin, minimum); assert.equal(budget.feasibleWordMax, maximumCurrent);
        assert.ok(Number.isSafeInteger(budget.wordTarget));
        assert.ok(budget.wordTarget >= minimum && budget.wordTarget <= maximumCurrent);
        assert.ok(budget.wordMin <= budget.wordTarget && budget.wordMax >= budget.wordTarget);
        assert.ok(budget.wordMin >= minimum && budget.wordMax <= maximumCurrent);
        for (const selected of [minimum, budget.wordTarget, maximumCurrent]) {
            assert.ok(used + selected + 4000 * (left - 1) >= wordMin);
            assert.ok(used + selected + 150 * (left - 1) <= wordMax);
        }
        if (left === 1) { assert.equal(budget.wordMin, minimum); assert.equal(budget.wordMax, maximumCurrent); }
    }
    assert.ok(feasible > 100 && impossible > 100);
});

test('the existing settings guard still limits requested average allocation to 4,000 words per section', () => {
    assert.equal(normalizeSettings({ ...settings, wordMin: 7000, wordMax: 8000 }).wordMax, 8000);
    assert.throws(() => normalizeSettings({ ...settings, wordMin: 7000, wordMax: 8001 }), /4,000/);
    const job = budgetJob({ wordMin: 7000, wordMax: 8000 });
    assert.equal(sectionBudget(job).feasibleWordMax, 4000);
});

function runFixture(wordCounts = [350, 250]) {
    const brief = 'Meet the courier, then cross the river.';
    const job = createJob({ model: 'test/writer', latestBrief: brief, snapshot: {},
        messages: [{ role: 'system', content: 'Complete source remains untouched.' }, { role: 'user', content: brief }] }, settings);
    updatePlan(job, { fixedFacts: [], finalRequirements: [], requiredBeats: [{ id: 'meet', briefQuote: 'Meet the courier' }, { id: 'cross', briefQuote: 'cross the river' }],
        sections: [{ id: 1, title: 'Meeting', beatIds: ['meet'], startState: 'At gate', endState: 'With courier', direction: '' },
            { id: 2, title: 'Crossing', beatIds: ['cross'], startState: 'At river', endState: 'Across', direction: '' }] });
    const f = { job, calls: [] };
    f.transport = { models: [{ id: 'test/writer', context_length: 262144 }], countTokens: async () => 1000, isCurrent: () => true,
        fetcher: async (_path, request) => {
            const body = JSON.parse(request.body), index = f.calls.length; f.calls.push(body);
            const m = sectionMarkers(job, job.sections.length), text = `${m.start}\n${prose(wordCounts[index])}\n${m.end}`;
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 20 } }) };
        } };
    return f;
}

test('uneven but feasible sections finish without a paid rewrite while keeping the whole-story total hard', async () => {
    const f = runFixture(), before = structuredClone(f.job.source);
    await runJob(f.job, f.transport);
    assert.equal(f.job.status, 'complete'); assert.equal(f.calls.length, 2);
    assert.equal(totals(f.job).words, 600); assert.equal(totals(f.job).wordTargetMet, true);
    assert.equal(f.job.sections[0].words, 350); assert.ok(f.job.sections[0].warnings.some(warning => /350.*words/.test(warning)));
    assert.equal(f.job.sections[1].words, 250); assert.deepEqual(f.job.source, before);
});

test('a final section one word beyond the global maximum is preserved as rejected, never marked complete', async () => {
    const f = runFixture([350, 251]); await runJob(f.job, f.transport);
    assert.equal(f.job.status, 'needs_attention'); assert.equal(f.calls.length, 2);
    assert.equal(f.job.sections.length, 1); assert.equal(f.job.sections[0].words, 350);
    assert.equal(f.job.pending.words, 251); assert.equal(f.job.pending.phase, 'rejected');
    assert.equal(totals(f.job).wordTargetMet, false);
});

test('an impossible saved remaining budget blocks the next paid request and preserves accepted prose', async () => {
    const f = runFixture(); f.job.sections.push({ id: 1, text: prose(500), words: 500, paragraphs: 3 });
    const before = structuredClone(f.job.sections);
    await assert.rejects(runJob(f.job, f.transport), /remaining.*(?:budget|target)/);
    assert.equal(f.calls.length, 0); assert.deepEqual(f.job.sections, before);
});

function retainLegacyRejection(f, { finishReason = 'stop', trailing = '' } = {}) {
    const m = sectionMarkers(f.job, 0), raw = `${m.start}\n${prose(350)}\n${m.end}${trailing}`;
    const oldBudget = { ...sectionBudget(f.job) }; delete oldBudget.feasibleWordMin; delete oldBudget.feasibleWordMax;
    f.job.pending = { ...parseSection(raw, m, oldBudget, finishReason, false), id: 1, attempts: 1,
        candidateId: 'synthetic-retained-candidate', phase: 'rejected', rawResponse: raw, finishReason };
    f.job.status = 'needs_attention'; return f.job.pending;
}

test('a retained allocation-only rejection is rechecked for continuity without paying for a replacement writer', async () => {
    const f = runFixture(), pending = retainLegacyRejection(f), before = structuredClone(f.job.source);
    assert.equal(pending.issues.length, 1); assert.match(pending.issues[0], /350 words/);
    f.job.settings.continuityEnabled = true; f.job.settings.reviewerModel = 'test/checker';
    const ending = { summary: 'Refer to the complete source and prose.', facts: [], openThreads: [], unknowns: [] };
    f.job.continuity = { version: 1, initialState: ending, acceptedFrames: [] };
    f.transport.models.push({ id: 'test/checker', context_length: 262144 });
    f.transport.fetcher = async (_path, request) => {
        const body = JSON.parse(request.body); f.calls.push(body);
        assert.equal(body.model, 'test/checker');
        const payload = JSON.parse(body.messages[1].content);
        assert.equal(payload.candidate.text, pending.text); assert.deepEqual(payload.sourceMessages, before.messages);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ issues: [], endState: ending }) }, finish_reason: 'stop' }] }) };
    };
    await runJob(f.job, f.transport, { stopAfterSections: 1 });
    assert.equal(f.calls.length, 1); assert.equal(f.job.sections[0].text, pending.text);
    assert.equal(f.job.continuity.acceptedFrames.length, 1);
    assert.equal(f.job.continuity.acceptedFrames[0].candidateId, pending.candidateId);
    assert.ok(f.job.sections[0].warnings.some(warning => /350.*words/.test(warning)));
    assert.deepEqual(f.job.source, before);
});

test('retained truncation and trailing prose still require replacement instead of becoming accepted by reallocation', async () => {
    for (const options of [{ finishReason: 'length' }, { trailing: '\nUnrequested epilogue.' }]) {
        const f = runFixture([275]), retained = retainLegacyRejection(f, options);
        await runJob(f.job, f.transport, { stopAfterSections: 1 });
        assert.equal(f.calls.length, 1); assert.equal(f.job.sections.length, 1);
        assert.equal(f.job.sections[0].words, 275); assert.notEqual(f.job.sections[0].text, retained.text);
    }
});

test('changed retained prose cannot be replaced by reparsing a different raw response', async () => {
    const f = runFixture(), pending = retainLegacyRejection(f); pending.text += '\n\nA changed sentence.';
    await assert.rejects(runJob(f.job, f.transport), /preserved section.*original response/);
    assert.equal(f.calls.length, 0); assert.equal(f.job.sections.length, 0); assert.equal(f.job.pending, pending);
});
