import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInitialState, parseInitialStateReport, parseContinuityCheck, parseContinuityCheckReport } from '../../extensions/StoryBuilder/continuity-checks.js';
import { createJob, updatePlan, runJob, sectionBudget, sectionMarkers } from '../../extensions/StoryBuilder/builder-core.js';

const brief = 'Mara must keep the compass in her hand throughout. Meet the courier, then cross the river.';
const candidate = () => ({ id: 1, text: 'Mara left the compass behind.' });
const state = () => ({ summary: 'Mara must retain the compass.', facts: [{ fact: 'The compass must stay with Mara.',
    evidence: 'Mara must keep the compass in her hand throughout.' }], openThreads: [], unknowns: [] });
const issue = (severity = 'high') => ({ severity, problem: 'Mara leaves the compass contrary to the explicit instruction.',
    evidenceBefore: brief.split(' Meet')[0], evidenceAfter: candidate().text, suggestion: 'Keep the compass in her hand.' });
const report = (severity) => ({ issues: severity ? [issue(severity)] : [], endState: state() });
const withMetadata = (severity = 'low') => {
    const value = report(severity);
    value.suggestions = ['UNUSED_TOP_METADATA'];
    value.issues[0].confidence = 'UNUSED_ISSUE_METADATA';
    value.endState.explanation = 'UNUSED_STATE_METADATA';
    value.endState.facts[0].sourceMessageIndex = 'UNUSED_FACT_METADATA';
    return value;
};
function jobFixture() {
    const job = createJob({ model: 'test/writer', latestBrief: brief, snapshot: {}, requestTemplate: { secret_id: 'synthetic-key-id' },
        messages: [{ role: 'system', content: 'Complete source reference. '.repeat(1200) },
            { role: 'assistant', content: 'The gate is open.' }, { role: 'user', content: `<brief>${brief}</brief>` }] },
    { wordMin: 500, wordMax: 600, paragraphMin: 5, paragraphMax: 8, sectionCount: 2, maxRetries: 0,
        plannerModel: 'test/planner', reviewerModel: 'test/checker', continuityEnabled: true });
    updatePlan(job, { fixedFacts: [], finalRequirements: [],
        requiredBeats: [{ id: 'meet', briefQuote: 'Meet the courier' }, { id: 'cross', briefQuote: 'cross the river' }],
        sections: [{ id: 1, title: 'Meeting', beatIds: ['meet'], startState: 'At gate', endState: 'With courier', direction: '' },
            { id: 2, title: 'Crossing', beatIds: ['cross'], startState: 'At river', endState: 'Across river', direction: '' }] });
    job.continuity = { version: 1, initialState: state(), acceptedFrames: [] };
    return job;
}
const parse = value => parseContinuityCheckReport(JSON.stringify(value), jobFixture(), candidate());
const note = 'Note: The checks above compare this candidate with the supplied source. The ending notes remain secondary references; the complete source and accepted prose remain authoritative.';

test('a complete section report followed by a simple Note is accepted without incorporating commentary', () => {
    const job = jobFixture(), value = report(), raw = JSON.stringify(value);
    for (const suffix of [note, 'Note: ' + 'x'.repeat(402), 'x'.repeat(2000)]) {
        const response = `  ${raw}\n\n${suffix}  `;
        const result = parseContinuityCheckReport(response, job, candidate());
        assert.deepEqual(result.report, value); assert.equal(result.ignoredFields, 0);
        assert.deepEqual(result.endStateValidation, { proposedFacts: 1, verifiedFacts: 1, omittedFacts: 0 });
        assert.deepEqual(parseContinuityCheck(response, job, candidate()), value);
        assert.doesNotMatch(JSON.stringify(result), /checks above|Note:/);
    }
});

test('shared wrapper cleanup also accepts a complete initial object followed by bounded plain commentary', () => {
    const job = jobFixture(), raw = `${JSON.stringify(state())}\n${note}`;
    assert.deepEqual(parseInitialState(raw, job), state());
    assert.deepEqual(parseInitialStateReport(raw, job).state, state());
});

test('trailing cleanup tracks strings, escapes, and nested objects rather than stopping at an embedded brace', () => {
    const value = report(); value.endState.summary = 'Mara sees a literal brace } and an escaped "quote" and a backslash \\ in a description.';
    const result = parseContinuityCheckReport(`${JSON.stringify(value)}\n${note}`, jobFixture(), candidate());
    assert.deepEqual(result.report, value);
});

test('trailing cleanup rejects a second JSON value, structured commentary, no separator, or an overlong note', () => {
    const raw = JSON.stringify(report()), job = jobFixture();
    const forbidden = ['null', 'true', 'false', '12', '-2', '1e3', '"another answer"', '[]', '{}',
        'Note: use {another report}', 'Note: see [another value]', 'Note: `code`', 'x'.repeat(2001)];
    for (const tail of forbidden) {
        assert.throws(() => parseContinuityCheckReport(`${raw}\n${tail}`, job, candidate()), /valid JSON/);
    }
    assert.throws(() => parseContinuityCheckReport(`${raw}Note: no separator`, job, candidate()), /valid JSON/);
});

test('trailing cleanup never repairs an incomplete first object or strips a leading explanation', () => {
    const raw = JSON.stringify(report()), job = jobFixture();
    for (const response of [raw.slice(0, -1) + '\n' + note, raw.slice(0, -2) + '\n' + note,
        `Here is the report:\n${raw}`, `[]\n${note}`, `null\n${note}`, `"report"\n${note}`,
        `${raw}\n${JSON.stringify(report())}\n${note}`]) {
        assert.throws(() => parseContinuityCheckReport(response, job, candidate()), /valid JSON/);
    }
});

test('identical-object recovery remains narrow alongside trailing-commentary cleanup', () => {
    const job = jobFixture(), raw = JSON.stringify(report());
    assert.deepEqual(parseContinuityCheckReport(`${raw}\n${raw}`, job, candidate()).report, report());
    assert.throws(() => parseContinuityCheckReport(`${raw}${raw}`, job, candidate()), /valid JSON/);
    assert.throws(() => parseContinuityCheckReport(`${raw}\n${JSON.stringify(report('low'))}`, job, candidate()), /valid JSON/);
});

test('report normalization discards and counts metadata only at the documented four object levels', () => {
    const value = withMetadata(), before = structuredClone(value), job = jobFixture(), sourceBefore = structuredClone(job.source);
    const raw = JSON.stringify(value), result = parseContinuityCheckReport(`${raw}\n${note}`, job, candidate());
    assert.deepEqual(result.report, report('low')); assert.equal(result.ignoredFields, 4);
    assert.deepEqual(result.endStateValidation, { proposedFacts: 1, verifiedFacts: 1, omittedFacts: 0 });
    assert.doesNotMatch(JSON.stringify(result), /UNUSED_|Note:/);
    assert.deepEqual(value, before); assert.equal(raw, JSON.stringify(before)); assert.deepEqual(job.source, sourceBefore);
    result.report.issues[0].problem = 'Modified returned result'; assert.equal(value.issues[0].problem, before.issues[0].problem);
});

test('zero extra fields preserve the report and return an explicit zero metadata count', () => {
    const value = report('medium'), result = parse(value);
    assert.deepEqual(result.report, value); assert.equal(result.ignoredFields, 0); assert.equal(result.omittedAdvisories, 0);
    assert.deepEqual(result.endStateValidation, { proposedFacts: 1, verifiedFacts: 1, omittedFacts: 0 });
});

test('the legacy strict parser still rejects extra fields even with an allowed trailing note', () => {
    const mutations = [value => { value.suggestions = []; }, value => { value.issues[0].confidence = 1; },
        value => { value.endState.confidence = 1; }, value => { value.endState.facts[0].confidence = 1; }];
    for (const mutate of mutations) {
        const value = report('high'); mutate(value);
        assert.throws(() => parseContinuityCheck(`${JSON.stringify(value)}\n${note}`, jobFixture(), candidate()), /invalid|oversized/);
    }
});

test('unknown fields cannot replace, repair, or override missing or invalid mandatory fields', () => {
    const mutations = [
        value => { value.issues = null; value.correctedIssues = []; },
        value => { delete value.endState; value.correctedEndState = state(); },
        value => { value.issues[0].severity = 'critical'; value.issues[0].correctedSeverity = 'low'; },
        value => { delete value.issues[0].problem; value.issues[0].correctedProblem = 'Valid text'; },
        value => { value.issues[0].evidenceBefore = 'Absent quote'; value.issues[0].correctedEvidenceBefore = brief; },
        value => { value.issues[0].evidenceAfter = 'Absent quote'; value.issues[0].correctedEvidenceAfter = candidate().text; },
        value => { value.issues[0].suggestion = 7; value.issues[0].correctedSuggestion = 'Valid text'; },
        value => { delete value.endState.summary; value.endState.correctedSummary = 'Valid text'; },
        value => { value.endState.facts = {}; value.endState.correctedFacts = []; },
        value => { delete value.endState.facts[0].evidence; value.endState.facts[0].quote = brief; },
        value => { value.endState.facts[0].fact = ''; value.endState.facts[0].correctedFact = 'Valid text'; },
        value => { value.endState.openThreads = null; value.endState.correctedOpenThreads = []; },
        value => { value.endState.unknowns = [null]; value.endState.correctedUnknowns = []; },
    ];
    for (const mutate of mutations) {
        const value = withMetadata('high'); mutate(value);
        assert.throws(() => parse(value), /invalid|oversized|finding/);
    }
});

test('normalization preserves all existing limits and never truncates oversized mandatory data', () => {
    const mutations = [value => { value.issues = Array.from({ length: 13 }, () => issue()); },
        value => { value.issues[0].problem = 'x'.repeat(1201); }, value => { value.issues[0].evidenceAfter = 'x'.repeat(1201); },
        value => { value.endState.summary = 'x'.repeat(1801); }, value => { value.endState.facts = Array.from({ length: 41 }, () => state().facts[0]); },
        value => { value.endState.facts[0].fact = 'x'.repeat(701); }, value => { value.endState.facts[0].evidence = 'x'.repeat(1201); },
        value => { value.endState.openThreads = Array(21).fill('Thread'); }, value => { value.endState.unknowns = ['x'.repeat(701)]; }];
    for (const mutate of mutations) {
        const value = withMetadata('high'); mutate(value);
        assert.throws(() => parse(value), /invalid|oversized/);
    }
});

test('metadata stripping and optional-note omission retain separate counts without losing high findings', () => {
    const value = withMetadata('high');
    value.endState.facts.push({ fact: 'Unsupported extra note.', evidence: 'Absent source quotation.', confidence: 1 });
    const result = parse(value);
    assert.equal(result.ignoredFields, 5);
    assert.deepEqual(result.report.issues, [issue('high')]);
    assert.deepEqual(result.endStateValidation, { proposedFacts: 2, verifiedFacts: 1, omittedFacts: 1 });
    assert.deepEqual(result.report.endState.facts, state().facts);
});

test('only structurally valid unmatched medium and low findings are omitted and counted', () => {
    const value = withMetadata('high');
    value.issues.push({ ...issue('medium'), problem: 'UNMATCHED_MEDIUM', evidenceBefore: 'Absent prior quotation.' },
        { ...issue('low'), problem: 'UNMATCHED_LOW', evidenceAfter: 'Absent candidate quotation.' }, issue('low'));
    const before = structuredClone(value), result = parse(value);
    assert.equal(result.omittedAdvisories, 2); assert.equal(result.ignoredFields, 4);
    assert.deepEqual(result.report.issues, [issue('high'), issue('low')]);
    assert.doesNotMatch(JSON.stringify(result), /UNMATCHED_/); assert.deepEqual(value, before);
    assert.throws(() => parseContinuityCheck(JSON.stringify({ ...value, suggestions: undefined }), jobFixture(), candidate()), /invalid|finding/);
    for (const severity of ['medium', 'low']) {
        for (const bad of [{ ...issue(severity), evidenceBefore: '' }, { ...issue(severity), evidenceAfter: null },
            { ...issue(severity), problem: 'x'.repeat(1201) }, { ...issue(severity), suggestion: '' }]) {
            assert.throws(() => parse({ ...report(), issues: [{ ...issue(severity), evidenceBefore: 'Absent quote.' }, bad] }), /finding/);
        }
    }
});

test('an unmatched high finding still fails even after omitted advisories and removable metadata', () => {
    const value = withMetadata('high'); value.issues[0].evidenceBefore = 'Absent high-severity quotation.';
    value.issues.unshift({ ...issue('low'), evidenceAfter: 'Absent advisory quotation.' });
    assert.throws(() => parse(value), /finding.*source.*candidate evidence/);
});

function runFixture(response) {
    const f = { job: jobFixture(), calls: [], progress: [] };
    f.transport = { models: ['test/writer', 'test/checker'].map(id => ({ id, context_length: 262144 })),
        countTokens: async () => 1000, isCurrent: () => true,
        fetcher: async (_path, request) => {
            const body = JSON.parse(request.body), kind = body.model === 'test/checker' ? 'check' : 'write';
            f.calls.push({ kind, body });
            let content = response;
            if (kind === 'write') {
                const words = candidate().text.split(' '), budget = sectionBudget(f.job), markers = sectionMarkers(f.job, f.job.sections.length);
                while (words.length < budget.wordTarget) words.push('walked');
                const size = Math.floor(words.length / 3);
                const prose = [words.slice(0, size), words.slice(size, size * 2), words.slice(size * 2)].map(row => row.join(' ') + '.').join('\n\n');
                content = `${markers.start}\n${prose}\n${markers.end}`;
            }
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 20, cost: .001 } }) };
        } };
    f.run = options => runJob(f.job, f.transport, { stopAfterSections: 1, onProgress: progress => f.progress.push(progress), ...options });
    return f;
}

test('a high finding still blocks acceptance with extra metadata and a plain trailing note', async () => {
    const f = runFixture(`${JSON.stringify(withMetadata('high'))}\n${note}`), before = structuredClone(f.job.source);
    await f.run();
    assert.equal(f.job.status, 'needs_attention'); assert.equal(f.job.sections.length, 0); assert.equal(f.job.continuity.acceptedFrames.length, 0);
    assert.equal(f.job.pending.phase, 'rejected'); assert.equal(f.job.pending.continuityReport.issues[0].severity, 'high');
    assert.equal(f.job.pending.ignoredReviewFields, 4); assert.equal(f.job.pending.issues.length, 1);
    assert.deepEqual(f.calls.map(call => call.kind), ['write', 'check']); assert.deepEqual(f.job.source, before);
});

test('ignored-field counts survive a checked-candidate pause and are saved on its accepted frame without another call', async () => {
    const value = withMetadata('low');
    value.issues.push({ ...issue('medium'), problem: 'UNMATCHED_MEDIUM', evidenceBefore: 'Absent source quotation.' },
        { ...issue('low'), problem: 'UNMATCHED_LOW', evidenceAfter: 'Absent candidate quotation.' });
    const f = runFixture(`${JSON.stringify(value)}\n${note}`), before = structuredClone(f.job.source);
    const controller = new AbortController();
    await assert.rejects(f.run({ signal: controller.signal, onProgress(progress) {
        if (progress.stage === 'section_check_complete') controller.abort();
    } }), { name: 'AbortError' });
    assert.equal(f.job.pending.phase, 'checked'); assert.equal(f.job.pending.ignoredReviewFields, 4);
    assert.equal(f.job.pending.omittedAdvisories, 2);
    assert.doesNotMatch(JSON.stringify(f.job.pending.warnings), /UNMATCHED_/);
    assert.equal(f.job.sections.length, 0); assert.equal(f.job.continuity.acceptedFrames.length, 0);
    await f.run();
    assert.equal(f.job.sections.length, 1); assert.equal(f.job.continuity.acceptedFrames[0].ignoredReviewFields, 4);
    assert.equal(f.job.continuity.acceptedFrames[0].omittedAdvisories, 2);
    assert.deepEqual(f.job.continuity.acceptedFrames[0].report, report('low'));
    assert.deepEqual(f.calls.map(call => call.kind), ['write', 'check']); assert.equal(f.job.calls, 2);
    assert.deepEqual(f.job.source, before); assert.doesNotMatch(JSON.stringify(f.job.continuity.acceptedFrames), /UNUSED_|UNMATCHED_|Note:/);
});
