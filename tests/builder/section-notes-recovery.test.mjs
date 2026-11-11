import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInitialState, parseInitialStateReport, parseContinuityCheck, parseContinuityCheckReport,
    buildContinuityCheckRequest } from '../../extensions/StoryBuilder/continuity-checks.js';
import { createJob, updatePlan, runJob, sectionBudget, sectionMarkers } from '../../extensions/StoryBuilder/builder-core.js';

const brief = 'Mara waits at the gate with the compass. Mara must keep the compass in her hand throughout. Meet the courier, then cross the river.';
const known = { fact: 'Mara has the compass at the gate.', evidence: 'Mara waits at the gate with the compass.' };
const unmatched = { fact: 'UNSUPPORTED_FACT_MARKER', evidence: 'A quotation absent from every supplied narrative.' };
const state = () => ({ summary: 'Mara waits at the gate with the compass.', facts: [{ ...known }], openThreads: [], unknowns: [] });
const mixedState = () => ({ summary: 'UNSUPPORTED_SUMMARY_MARKER', facts: [{ ...known }, { ...unmatched }],
    openThreads: ['UNSUPPORTED_THREAD_MARKER'], unknowns: ['UNSUPPORTED_UNKNOWN_MARKER'] });
const candidate = () => ({ id: 1, text: 'Mara met the courier beside the gate. She kept the compass in her hand.' });
const check = (endState = state(), issues = []) => ({ issues, endState });
const outline = () => ({ fixedFacts: ['Mara must retain the compass.'],
    requiredBeats: [{ id: 'meet', briefQuote: 'Meet the courier' }, { id: 'cross', briefQuote: 'cross the river' }],
    sections: [{ id: 1, title: 'Meeting', beatIds: ['meet'], startState: 'At the gate', endState: 'Ready to leave', direction: '' },
        { id: 2, title: 'Crossing', beatIds: ['cross'], startState: 'On the road', endState: 'Across the river', direction: '' }], finalRequirements: [] });
function jobFixture() {
    const job = createJob({ latestBrief: brief, model: 'test/writer', snapshot: {}, requestTemplate: { secret_id: 'synthetic-key-id' },
        messages: [{ role: 'system', content: 'Complete synthetic source remains exact. '.repeat(1500) },
            { role: 'assistant', content: 'The compass is brass.' }, { role: 'user', content: `<brief>${brief}</brief>` }] },
    { wordMin: 500, wordMax: 600, paragraphMin: 5, paragraphMax: 8, sectionCount: 2, maxRetries: 1,
        plannerModel: 'test/planner', reviewerModel: 'test/checker', continuityEnabled: true });
    updatePlan(job, outline());
    job.continuity = { version: 1, initialState: state(), acceptedFrames: [] };
    return job;
}
const parse = (value, job = jobFixture(), proposed = candidate()) => parseContinuityCheckReport(JSON.stringify(value), job, proposed);
const issue = (severity = 'high') => ({ severity, problem: 'Mara leaves the compass despite the explicit instruction.',
    evidenceBefore: 'Mara must keep the compass in her hand throughout.', evidenceAfter: 'Mara left the compass behind.',
    suggestion: 'Keep the compass in Mara’s hand while preserving the meeting.' });

function runFixture({ respond, maxRetries = 1 } = {}) {
    const f = { job: jobFixture(), calls: [], progress: [] };
    f.job.settings.maxRetries = maxRetries;
    f.count = kind => f.calls.filter(call => call.kind === kind).length;
    f.transport = { models: ['test/writer', 'test/checker'].map(id => ({ id, context_length: 262144 })),
        countTokens: async () => 1000, isCurrent: () => true,
        fetcher: async (_path, request) => {
            const body = JSON.parse(request.body), kind = body.model === 'test/checker' ? 'check' : 'write';
            const payload = JSON.parse(kind === 'write' ? body.messages.at(-1).content : body.messages[1].content);
            const call = { kind, body, payload, candidate: f.job.pending }; f.calls.push(call);
            let content = await respond?.(call, f);
            if (content === undefined && kind === 'check') content = JSON.stringify(check());
            if (content === undefined) {
                const start = f.count('write') === 1 ? 'Mara left the compass behind.' : 'Mara kept the compass in her hand.';
                const budget = sectionBudget(f.job), markers = sectionMarkers(f.job, f.job.sections.length);
                const words = start.split(' ');
                while (words.length < budget.wordTarget) words.push('walked');
                const size = Math.floor(words.length / 3);
                const prose = [words.slice(0, size), words.slice(size, size * 2), words.slice(size * 2)]
                    .map(row => row.join(' ') + '.').join('\n\n');
                content = `${markers.start}\n${prose}\n${markers.end}`;
            }
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 20, cost: .001 } }) };
        } };
    f.run = (options = {}) => runJob(f.job, f.transport, { stopAfterSections: 1,
        onProgress: progress => f.progress.push(progress), ...options });
    return f;
}

test('ending-note recovery filters only unmatched facts and removes their unsupported auxiliary claims', () => {
    const job = jobFixture(), before = structuredClone(job.source), value = check(mixedState());
    const result = parse(value, job);
    assert.deepEqual(result.endStateValidation, { proposedFacts: 2, verifiedFacts: 1, omittedFacts: 1 });
    assert.deepEqual(result.report.issues, []); assert.deepEqual(result.report.endState.facts, [known]);
    assert.equal(result.report.endState.summary, known.fact);
    assert.deepEqual(result.report.endState.openThreads, []); assert.deepEqual(result.report.endState.unknowns, []);
    assert.doesNotMatch(JSON.stringify(result), /UNSUPPORTED_|A quotation absent/);
    assert.deepEqual(job.source, before); assert.equal(value.endState.facts.length, 2);
    result.report.endState.facts[0].fact = 'Changed returned clone';
    assert.equal(value.endState.facts[0].fact, known.fact);
});

test('all unmatched ending notes yield neutral optional notes without claiming the story has no facts', () => {
    const proposed = mixedState(); proposed.facts = [{ ...unmatched }];
    const result = parse(check(proposed));
    assert.deepEqual(result.endStateValidation, { proposedFacts: 1, verifiedFacts: 0, omittedFacts: 1 });
    assert.deepEqual(result.report.endState.facts, []);
    assert.deepEqual(result.report.endState.openThreads, []); assert.deepEqual(result.report.endState.unknowns, []);
    assert.match(result.report.endState.summary, /matching source quotations/i);
    assert.match(result.report.endState.summary, /consult.*complete original source.*prose/i);
    assert.doesNotMatch(result.report.endState.summary, /source contains no|no facts exist|no established facts|UNSUPPORTED_/i);
});

test('matching ending notes and advisory findings remain unchanged, while strict parsing still rejects unmatched notes', () => {
    const proposed = { ...state(), openThreads: ['The crossing remains ahead.'], unknowns: ['The weather is unspecified.'] };
    const advisory = { severity: 'low', problem: 'The courier meeting remains unresolved.', evidenceBefore: 'Meet the courier',
        evidenceAfter: 'Mara met the courier', suggestion: 'Retain the meeting context in the next section.' };
    const value = check(proposed, [advisory]), result = parse(value);
    assert.deepEqual(result.report, value);
    assert.deepEqual(result.endStateValidation, { proposedFacts: 1, verifiedFacts: 1, omittedFacts: 0 });
    assert.deepEqual(parseContinuityCheck(JSON.stringify(value), jobFixture(), candidate()), value);
    assert.throws(() => parseContinuityCheck(JSON.stringify(check(mixedState())), jobFixture(), candidate()), /source evidence/);
});

for (const severity of ['high', 'medium', 'low']) {
    test(`${severity} findings preserve schema checks while only unmatched advisories may be omitted`, () => {
        const good = issue(severity), proposed = { id: 1, text: good.evidenceAfter };
        for (const field of ['evidenceBefore', 'evidenceAfter']) {
            for (const invalid of ['Unmatched exact quotation', '', ' ', null, 'x'.repeat(1201)]) {
                const bad = { ...good, [field]: invalid };
                const value = check(mixedState(), [bad]);
                if (severity !== 'high' && invalid === 'Unmatched exact quotation') {
                    const result = parse(value, jobFixture(), proposed);
                    assert.deepEqual(result.report.issues, []); assert.equal(result.omittedAdvisories, 1);
                } else assert.throws(() => parse(value, jobFixture(), proposed), /finding/);
                assert.throws(() => parseContinuityCheck(JSON.stringify(value), jobFixture(), proposed), /finding/);
            }
        }
        assert.deepEqual(parse(check(mixedState(), [good]), jobFixture(), proposed).report.issues, [good]);
    });
}

test('bad ending quotations never conceal malformed report, issue, state, or later fact schema', () => {
    const mutations = [
        value => { value.issues = null; },
        value => { value.issues = [{ ...issue(), severity: 'critical' }]; },
        value => { value.endState.summary = 'x'.repeat(1801); },
        value => { value.endState.unknowns = [null]; }, value => { value.endState.openThreads = Array(21).fill('Thread'); },
        value => { value.endState.facts.push({ fact: 'Missing evidence' }); },
        value => { value.endState.facts.push({ fact: 'Oversized evidence', evidence: 'x'.repeat(1201) }); },
        value => { value.endState.facts.push({ fact: 'x'.repeat(701), evidence: known.evidence }); },
        value => { value.endState.facts = Array.from({ length: 41 }, () => ({ ...unmatched })); },
    ];
    for (const mutate of mutations) {
        const value = check(mixedState()); mutate(value);
        assert.throws(() => parse(value, jobFixture(), { id: 1, text: issue().evidenceAfter }), /invalid|oversized/i);
    }
});

test('unknown fields remain rejected by the legacy strict section parser', () => {
    const mutations = [value => { value.extra = 'invalid'; }, value => { value.issues = [{ ...issue(), extra: 'invalid' }]; },
        value => { value.endState.extra = 'invalid'; }];
    for (const mutate of mutations) {
        const value = check(state()); mutate(value);
        assert.throws(() => parseContinuityCheck(JSON.stringify(value), jobFixture(), { id: 1, text: issue().evidenceAfter }), /invalid|oversized/);
    }
});

test('ending notes may cite one complete source, prior section, or current candidate, but never future or joined evidence', () => {
    const job = jobFixture(), proposed = candidate();
    job.sections = [{ id: 1, text: 'Mara reached the gate before sunrise.' }]; proposed.id = 2;
    job.plan.sections[1].direction = 'Mara will reach the northern bank at sunset.';
    const matching = [known.evidence, job.sections[0].text, proposed.text];
    const absent = [job.plan.sections[1].direction, 'The compass is brass.<brief>', 'mara waits at the gate with the compass.',
        `${job.sections[0].text}${proposed.text}`];
    const value = check({ summary: 'Proposal requiring filtering.', facts: [...matching, ...absent].map((evidence, index) =>
        ({ fact: `Proposed observation ${index + 1}.`, evidence })), openThreads: [], unknowns: [] });
    const result = parse(value, job, proposed);
    assert.deepEqual(result.endStateValidation, { proposedFacts: 7, verifiedFacts: 3, omittedFacts: 4 });
    assert.deepEqual(result.report.endState.facts.map(fact => fact.evidence), matching);
});

test('a concrete high finding still blocks acceptance and spends the rewrite allowance, not a format retry', async () => {
    const f = runFixture({ respond(call, run) {
        if (call.kind === 'check' && run.count('check') === 1) return JSON.stringify(check(mixedState(), [issue()]));
        if (call.kind === 'write' && run.count('write') === 2) {
            assert.equal(run.job.sections.length, 0); assert.equal(run.job.continuity.acceptedFrames.length, 0);
            assert.deepEqual(call.payload.continuityState, state());
            assert.ok(call.payload.repair); assert.match(JSON.stringify(call.payload.repair), /compass/);
        }
    } });
    await f.run();
    assert.equal(f.count('write'), 2); assert.equal(f.count('check'), 2);
    const rejected = f.calls.find(call => call.kind === 'check').candidate;
    assert.equal(rejected.phase, 'rejected'); assert.deepEqual(rejected.endStateValidation, { proposedFacts: 2, verifiedFacts: 1, omittedFacts: 1 });
    assert.equal(f.job.sections.length, 1); assert.equal(f.job.sections[0].attempts, 2);
    assert.match(f.job.sections[0].text, /Mara kept the compass in her hand/);
    assert.equal(f.job.continuity.acceptedFrames.length, 1);
    assert.notEqual(f.job.continuity.acceptedFrames[0].candidateId, rejected.candidateId);
    assert.ok(f.calls.filter(call => call.kind === 'check').every(call => call.body.messages.length === 2));
    assert.ok(f.progress.every(progress => !/Retrying/.test(progress.message)));
});

test('an unresolved high finding cannot be bypassed by discarding all ending notes', async () => {
    const f = runFixture({ maxRetries: 0, respond: call => call.kind === 'check'
        ? JSON.stringify(check({ ...mixedState(), facts: [{ ...unmatched }] }, [issue()])) : undefined });
    await f.run();
    assert.equal(f.job.status, 'needs_attention'); assert.equal(f.count('write'), 1); assert.equal(f.count('check'), 1);
    assert.equal(f.job.sections.length, 0); assert.equal(f.job.continuity.acceptedFrames.length, 0);
    assert.equal(f.job.pending.phase, 'rejected'); assert.equal(f.job.pending.continuityReport.issues[0].severity, 'high');
    assert.deepEqual(f.job.pending.endStateValidation, { proposedFacts: 1, verifiedFacts: 0, omittedFacts: 1 });
});

test('recovered ending notes keep counts on the accepted frame and all original context reaches the next writer and checker', async () => {
    const f = runFixture({ respond: call => call.kind === 'check'
        ? JSON.stringify(check({ ...mixedState(), facts: [{ ...unmatched }] })) : undefined });
    const before = structuredClone(f.job.source);
    await f.run();
    const first = f.job.sections[0], frame = f.job.continuity.acceptedFrames[0];
    assert.deepEqual(frame.endStateValidation, { proposedFacts: 1, verifiedFacts: 0, omittedFacts: 1 });
    assert.deepEqual(frame.endState.facts, []); assert.equal(f.count('check'), 1);
    await f.run({ stopAfterSections: 2 });
    const nextWriter = f.calls.filter(call => call.kind === 'write')[1];
    const nextChecker = f.calls.filter(call => call.kind === 'check')[1];
    assert.deepEqual(nextWriter.body.messages.slice(0, before.messages.length), before.messages);
    assert.equal(nextWriter.payload.completedStory, first.text);
    assert.deepEqual(nextWriter.payload.continuityState, frame.endState);
    assert.deepEqual(nextChecker.payload.sourceMessages, before.messages);
    assert.deepEqual(nextChecker.payload.acceptedSections, [{ id: first.id, text: first.text }]);
    assert.equal(nextChecker.payload.candidate.text, f.job.sections[1].text);
    assert.deepEqual(nextChecker.payload.establishedState, frame.endState);
    assert.equal(nextChecker.body.secret_id, 'synthetic-key-id');
    assert.deepEqual(f.job.source, before); assert.equal(f.count('write'), 2); assert.equal(f.count('check'), 2);
    assert.equal(f.job.calls, 4); assert.equal(f.job.usage.inputTokens, 40); assert.equal(f.job.usage.outputTokens, 80);
    assert.equal(f.job.continuity.acceptedFrames.length, 2);
    assert.doesNotMatch(JSON.stringify(f.job.continuity.acceptedFrames), /UNSUPPORTED_/);
});

test('pausing after a recovered check preserves its candidate counts and resumes without another paid check', async () => {
    const controller = new AbortController();
    const f = runFixture({ respond: call => call.kind === 'check' ? JSON.stringify(check(mixedState())) : undefined });
    await assert.rejects(f.run({ signal: controller.signal, onProgress(progress) {
        if (progress.stage === 'section_check_complete') controller.abort();
    } }), { name: 'AbortError' });
    const pending = f.job.pending;
    assert.equal(pending.phase, 'checked'); assert.deepEqual(pending.endStateValidation, { proposedFacts: 2, verifiedFacts: 1, omittedFacts: 1 });
    assert.equal(f.job.sections.length, 0); assert.equal(f.job.continuity.acceptedFrames.length, 0);
    await f.run();
    assert.equal(f.count('write'), 1); assert.equal(f.count('check'), 1);
    assert.equal(f.job.sections[0].text, pending.text);
    assert.deepEqual(f.job.continuity.acceptedFrames[0].endStateValidation, pending.endStateValidation);
});

test('saved recovered state remains valid input for the next checker without replacing the original source', () => {
    const job = jobFixture(), proposed = candidate(), before = structuredClone(job.source);
    const recovered = parse(check(mixedState()), job, proposed);
    job.sections.push(proposed);
    job.continuity.acceptedFrames.push({ sectionId: 1, endState: recovered.report.endState, endStateValidation: recovered.endStateValidation });
    const next = { id: 2, text: 'Mara and the courier approached the river.' };
    const payload = JSON.parse(buildContinuityCheckRequest(job, next).messages[1].content);
    assert.deepEqual(payload.sourceMessages, before.messages); assert.deepEqual(payload.acceptedSections, [proposed]);
    assert.deepEqual(payload.candidate, next); assert.deepEqual(payload.establishedState, recovered.report.endState);
    assert.deepEqual(job.source, before);
});

const parserCases = [
    ['strict initial state', () => state(), (raw, job) => parseInitialState(raw, job)],
    ['initial report', () => state(), (raw, job) => parseInitialStateReport(raw, job)],
    ['strict section check', () => check(), (raw, job) => parseContinuityCheck(raw, job, candidate())],
    ['section report', () => check(), (raw, job) => parseContinuityCheckReport(raw, job, candidate())],
];
for (const [label, value, parser] of parserCases) {
    test(`${label} accepts exactly identical complete JSON copies separated by whitespace only`, () => {
        const job = jobFixture(), serialized = JSON.stringify(value()), expected = parser(serialized, job);
        for (const separator of [' ', '\n', '\r\n\t   ']) {
            assert.deepEqual(parser(`  ${serialized}${separator}${serialized}  `, job), expected);
        }
        assert.deepEqual(parser(`\`\`\`json\n${serialized}\n${serialized}\n\`\`\``, job), expected);
    });
    test(`${label} rejects different, extra, adjacent, or incomplete JSON instead of choosing a report`, () => {
        const job = jobFixture(), original = value(), serialized = JSON.stringify(original);
        const changed = structuredClone(original);
        if (changed.endState) changed.endState.summary += ' Different.'; else changed.summary += ' Different.';
        const invalid = [`${serialized}\n${JSON.stringify(changed)}`, `${serialized}\n${JSON.stringify(original, null, 2)}`,
            `${serialized}\n${serialized}\ntrailing text`, `${serialized}\n${serialized.slice(0, -1)}`,
            `${serialized}\n${serialized}\n${serialized}`, `${serialized}${serialized}`, `${serialized};\n${serialized}`];
        for (const raw of invalid) assert.throws(() => parser(raw, job), /valid JSON/);
    });
}

test('exact duplicated JSON does not bypass strict findings or optional-note schema validation', () => {
    const job = jobFixture(), proposed = { id: 1, text: issue().evidenceAfter };
    const invalidIssue = check(mixedState(), [{ ...issue(), evidenceBefore: 'Absent quotation.' }]);
    const invalidState = check({ ...mixedState(), unknowns: [null] });
    for (const value of [invalidIssue, invalidState]) {
        const raw = JSON.stringify(value);
        assert.throws(() => parseContinuityCheckReport(`${raw}\n${raw}`, job, proposed), /finding|invalid|oversized/);
    }
    const raw = JSON.stringify(check(mixedState()));
    assert.deepEqual(parseContinuityCheckReport(`${raw}\n${raw}`, job, proposed).endStateValidation,
        { proposedFacts: 2, verifiedFacts: 1, omittedFacts: 1 });
    assert.throws(() => parseContinuityCheck(`${raw}\n${raw}`, job, proposed), /source evidence/);
});
