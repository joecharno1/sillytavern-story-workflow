import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInitialState, parseInitialStateReport, buildContinuityCheckRequest, parseContinuityCheck } from '../../extensions/StoryBuilder/continuity-checks.js';
import { createJob, planJob, PLANNER_SYSTEM } from '../../extensions/StoryBuilder/builder-core.js';

const brief = 'Mara waits at the gate. Meet the courier, then cross the river.';
const known = { fact: 'Mara is at the gate.', evidence: 'Mara waits at the gate.' };
const unmatched = { fact: 'UNSUPPORTED_FACT_MARKER', evidence: 'This quotation does not occur in the captured source.' };
const proposal = () => ({ summary: 'UNSUPPORTED_SUMMARY_MARKER', facts: [structuredClone(known), structuredClone(unmatched)],
    openThreads: ['UNSUPPORTED_THREAD_MARKER'], unknowns: ['UNSUPPORTED_UNKNOWN_MARKER'] });
function jobFixture() {
    return createJob({ latestBrief: brief, model: 'test/writer', snapshot: {}, requestTemplate: { secret_id: 'synthetic-key-id' },
        messages: [{ role: 'system', content: 'Complete synthetic reference remains available. '.repeat(1000) },
            { role: 'assistant', content: 'The compass was on a wooden table.' }, { role: 'user', content: `<brief>${brief}</brief>` }] },
    { plannerModel: 'test/planner', reviewerModel: 'test/checker', continuityEnabled: true,
        wordMin: 500, wordMax: 600, paragraphMin: 5, paragraphMax: 8, sectionCount: 2, maxRetries: 1 });
}
const counts = report => ({ proposedFacts: report.proposedFacts, verifiedFacts: report.verifiedFacts, omittedFacts: report.omittedFacts });
const parse = (value, job = jobFixture()) => parseInitialStateReport(JSON.stringify(value), job);

test('mixed starting-state quotations retain matching facts and remove unsupported auxiliary claims', () => {
    const input = proposal(), result = parse(input);
    assert.deepEqual(counts(result), { proposedFacts: 2, verifiedFacts: 1, omittedFacts: 1 });
    assert.deepEqual(result.state.facts, [known]);
    assert.ok(result.state.summary.includes(known.fact)); assert.ok(result.state.summary.length <= 1800);
    assert.deepEqual(result.state.openThreads, []); assert.deepEqual(result.state.unknowns, []);
    assert.doesNotMatch(JSON.stringify(result.state), /UNSUPPORTED_/);
    assert.equal(input.facts.length, 2, 'the caller-owned proposal is not mutated');
});

test('all unmatched quotations yield an empty fact list and a neutral source-authority summary', () => {
    const input = proposal(); input.facts = [unmatched];
    const result = parse(input);
    assert.deepEqual(counts(result), { proposedFacts: 1, verifiedFacts: 0, omittedFacts: 1 });
    assert.deepEqual(result.state.facts, []); assert.deepEqual(result.state.openThreads, []); assert.deepEqual(result.state.unknowns, []);
    assert.match(result.state.summary, /source/i); assert.match(result.state.summary, /authoritative|consult the complete original source/i);
    assert.match(result.state.summary, /no|none|not/i); assert.ok(result.state.summary.length <= 1800);
    assert.doesNotMatch(JSON.stringify(result.state), /UNSUPPORTED_|This quotation/);
});

test('a fully matching report is unchanged including its threads and unknowns, and supports JSON fences', () => {
    const job = jobFixture(), input = { summary: 'Mara waits at the gate.', facts: [known],
        openThreads: ['The courier has not yet arrived.'], unknowns: ['The weather is unspecified.'] };
    const result = parseInitialStateReport('```json\n' + JSON.stringify(input) + '\n```', job);
    assert.deepEqual(result.state, input);
    assert.deepEqual(counts(result), { proposedFacts: 1, verifiedFacts: 1, omittedFacts: 0 });
    assert.deepEqual(result.state, parseInitialState(JSON.stringify(input), job));
    result.state.facts[0].fact = 'Modified returned clone'; assert.equal(input.facts[0].fact, known.fact);
});

test('the original strict starting-state parser still rejects unmatched evidence', () => {
    assert.throws(() => parseInitialState(JSON.stringify(proposal()), jobFixture()), /source evidence/);
});

test('unmatched evidence cannot mask a malformed later fact or malformed state field', () => {
    const missingEvidence = proposal(); missingEvidence.facts = [unmatched, { fact: 'Missing required evidence.' }];
    assert.throws(() => parse(missingEvidence), /invalid|oversized/i);
    const extraField = proposal(); extraField.facts = [unmatched, { ...known, extra: 'Disallowed extra property.' }];
    assert.throws(() => parse(extraField), /invalid|oversized/i);
    const malformedUnknowns = proposal(); malformedUnknowns.unknowns = [7];
    assert.throws(() => parse(malformedUnknowns), /invalid|oversized/i);
    assert.throws(() => parseInitialStateReport('{malformed', jobFixture()), /valid JSON/);
});

test('missing, blank, non-string, and oversized evidence are schema errors rather than recoverable omissions', () => {
    for (const evidence of [undefined, '', '   ', null, 7, 'x'.repeat(1201)]) {
        const input = proposal(); input.facts = [{ fact: 'A structurally invalid proposed fact.', evidence }];
        assert.throws(() => parse(input), /invalid|oversized/i);
    }
});

test('recovery keeps every existing string and collection limit strict', () => {
    const mutations = [
        input => { input.summary = 'x'.repeat(1801); },
        input => { input.summary = ''; },
        input => { input.facts = Array.from({ length: 41 }, () => ({ ...known })); },
        input => { input.facts[0].fact = 'x'.repeat(701); },
        input => { input.facts[0].fact = ''; },
        input => { input.openThreads = Array(21).fill('Thread'); },
        input => { input.unknowns = Array(21).fill('Unknown'); },
        input => { input.openThreads = ['x'.repeat(701)]; },
        input => { input.unknowns = ['x'.repeat(701)]; },
        input => { input.extra = 'Disallowed state key'; },
    ];
    for (const mutate of mutations) { const input = proposal(); mutate(input); assert.throws(() => parse(input), /invalid|oversized/i); }
});

test('rebuilt summary stays bounded while the complete retained fact array remains available', () => {
    const input = proposal();
    const retained = Array.from({ length: 4 }, (_, index) => ({ fact: `${index + 1}: ` + 'Retained fact text. '.repeat(32), evidence: known.evidence }));
    input.facts = [...retained, unmatched];
    const result = parse(input);
    assert.deepEqual(result.state.facts, retained); assert.equal(result.verifiedFacts, 4);
    assert.ok(result.state.summary.length > 0 && result.state.summary.length <= 1800);
    assert.doesNotMatch(result.state.summary, /UNSUPPORTED_/);
});

test('later sections, future outline text, joined messages, and normalized quotations cannot validate initial facts', () => {
    const job = jobFixture();
    job.sections = [{ id: 1, text: 'The courier later handed Mara a sealed note.' }];
    job.plan = { sections: [{ direction: 'Mara will reach the north shore.' }] };
    const evidence = [job.sections[0].text, job.plan.sections[0].direction,
        'The compass was on a wooden table.<brief>', 'mara waits at the gate.', 'Mara waits  at the gate.'];
    const input = { summary: 'Unsupported initial interpretation.', facts: evidence.map(value => ({ fact: 'An unmatched initial claim.', evidence: value })), openThreads: [], unknowns: [] };
    const result = parse(input, job);
    assert.deepEqual(counts(result), { proposedFacts: 5, verifiedFacts: 0, omittedFacts: 5 });
    assert.deepEqual(result.state.facts, []);
});

test('recovery never alters full source, and the later checker still receives the complete source and remains strict', () => {
    const job = jobFixture(), before = structuredClone(job.source);
    const result = parse(proposal(), job);
    job.continuity = { version: 1, initialState: result.state, acceptedFrames: [] };
    const candidate = { id: 1, text: 'Mara left the gate and met the courier.' };
    const request = buildContinuityCheckRequest(job, candidate), payload = JSON.parse(request.messages[1].content);
    assert.deepEqual(job.source, before); assert.deepEqual(payload.sourceMessages, before.messages);
    assert.deepEqual(payload.establishedState, result.state); assert.deepEqual(payload.candidate, candidate);
    assert.doesNotMatch(JSON.stringify(payload.establishedState), /UNSUPPORTED_/);
    assert.throws(() => parseContinuityCheck(JSON.stringify({ issues: [], endState: proposal() }), job, candidate), /source evidence/);
});

test('planJob proceeds after an omitted initial fact without another helper request and stores only count diagnostics', async () => {
    const job = jobFixture(), before = structuredClone(job.source), calls = [], progress = [];
    const outline = { fixedFacts: ['Mara is at the gate.'], finalRequirements: [],
        requiredBeats: [{ id: 'meet', briefQuote: 'Meet the courier' }, { id: 'cross', briefQuote: 'cross the river' }],
        sections: [{ id: 1, title: 'Meeting', beatIds: ['meet'], startState: 'At the gate', endState: 'Met the courier', direction: '' },
            { id: 2, title: 'Crossing', beatIds: ['cross'], startState: 'At the river', endState: 'Across the river', direction: '' }] };
    const transport = { models: [{ id: 'test/planner', context_length: 262144, top_provider: { max_completion_tokens: 32768 } }],
        isCurrent: () => true, countTokens: async () => 1000,
        fetcher: async (_path, request) => {
            const body = JSON.parse(request.body), isPlan = body.messages[0].content === PLANNER_SYSTEM;
            calls.push({ body, isPlan });
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(isPlan ? outline : proposal()) }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 20, cost: .001 } }) };
        } };
    await planJob(job, transport, { onProgress: item => progress.push(item) });
    assert.deepEqual(calls.map(call => call.isPlan), [false, true]); assert.equal(job.calls, 2);
    assert.equal(job.status, 'ready'); assert.deepEqual(job.source, before);
    assert.deepEqual(job.continuity.initialStateValidation, { proposedFacts: 2, verifiedFacts: 1, omittedFacts: 1 });
    assert.deepEqual(job.continuity.initialState.facts, [known]);
    assert.doesNotMatch(JSON.stringify(job.continuity), /UNSUPPORTED_/);
    const plannerPayload = JSON.parse(calls[1].body.messages[1].content);
    assert.deepEqual(plannerPayload.startingState, job.continuity.initialState);
    assert.equal(plannerPayload.briefPassages.map(passage => passage.text).join(''), before.latestBrief);
    assert.equal(job.usage.inputTokens, 20); assert.equal(job.usage.outputTokens, 40);
    const ready = progress.find(item => item.stage === 'starting_state_ready');
    assert.ok(ready); assert.match(ready.message, /1/); assert.match(ready.message, /omitt|left out|skip/i);
    assert.match(ready.message, /full|complete/i); assert.match(ready.message, /source|prompt/i);
    assert.ok(progress.every(item => !/Retrying/.test(item.message)));
});
