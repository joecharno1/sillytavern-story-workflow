import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInitialStateRequest, parseInitialState, buildContinuityCheckRequest, parseContinuityCheck } from '../../extensions/StoryBuilder/continuity-checks.js';

function fixture() {
    const brief = 'Continue from the west gate. Keep the ledger sealed. Reach the harbor only in the final section.';
    const initial = { summary: 'Mira waits beside the west gate.', facts: [
        { fact: 'Mira has a sealed ledger.', evidence: 'Mira carried the sealed ledger to the west gate.' },
    ], openThreads: ['The harbor meeting has not happened.'], unknowns: ['The weather is unspecified.'] };
    const job = {
        source: { latestBrief: brief, requestTemplate: { secret_id: 'synthetic-secret-id', tools: [{ invalid: true }], temperature: 0.95 },
            messages: [{ role: 'system', content: 'Preserve the original FF preset exactly.\n<!-- GFX_START -->a prop<!-- GFX_END -->' },
                { role: 'assistant', content: 'Mira carried the sealed ledger to the west gate.', name: 'Narrator' },
                { role: 'user', content: `<brief>\n${brief}\n</brief>` },
                { role: 'assistant', content: '<FF-prefill>' }],
        },
        settings: { plannerModel: 'synthetic/planner', reviewerModel: 'synthetic/checker' },
        plan: null, sections: [], continuity: { initialState: initial, acceptedFrames: [] },
    };
    const candidate = { id: 1, text: 'Mira opened the ledger beside the west gate. She read the first page.', ignored: 'not part of the prose' };
    const check = { issues: [{ severity: 'high', problem: 'The explicit sealed-ledger requirement was violated.',
        evidenceBefore: 'Keep the ledger sealed.', evidenceAfter: 'Mira opened the ledger', suggestion: 'Keep the ledger sealed during this section.' }],
        endState: { summary: 'Mira stands at the west gate with the opened ledger.', facts: [
            { fact: 'Mira opened the ledger.', evidence: 'Mira opened the ledger beside the west gate.' },
        ], openThreads: [], unknowns: ['The weather is unspecified.'] } };
    return { job, brief, initial, candidate, check };
}

test('initial request preserves every source role and byte without a second brief copy', () => {
    const f = fixture(), original = structuredClone(f.job);
    const request = buildInitialStateRequest(f.job), payload = JSON.parse(request.messages[1].content);
    assert.deepEqual(payload.sourceMessages, f.job.source.messages);
    assert.equal(request.messages[1].content.split(f.brief).length - 1, 1);
    assert.match(payload.latestBriefLocation, /sourceMessages/);
    assert.equal(Object.hasOwn(payload, 'latestBrief'), false);
    assert.equal(Object.hasOwn(payload, 'existingOutlineAsFutureConstraints'), false);
    assert.deepEqual(f.job, original);
    assert.equal(request.model, 'synthetic/planner');
});

test('request bodies use existing credentials and bounded helper settings without writer tools', () => {
    const f = fixture();
    for (const request of [buildInitialStateRequest(f.job), buildContinuityCheckRequest(f.job, f.candidate)]) {
        assert.equal(request.secret_id, 'synthetic-secret-id');
        assert.equal(request.chat_completion_source, 'openrouter');
        assert.equal(request.max_tokens, 32768); assert.equal(request.temperature, 0.1);
        assert.equal(request.reasoning_effort, 'low'); assert.equal(request.middleout, 'off');
        assert.equal(request.stream, false); assert.deepEqual(request.plugins, []);
        assert.equal(Object.hasOwn(request, 'tools'), false); assert.equal(Object.hasOwn(request, 'tool_choice'), false);
    }
});

test('an existing outline is explicitly future constraints in initial preparation', () => {
    const f = fixture(); f.job.plan = { sections: [{ id: 1, endState: 'Arrive at the harbor.' }] };
    const payload = JSON.parse(buildInitialStateRequest(f.job).messages[1].content);
    assert.deepEqual(payload.existingOutlineAsFutureConstraints, f.job.plan);
    assert.equal(Object.hasOwn(payload, 'establishedState'), false);
});

test('initial state accepts exact source evidence, empty collections and unspecified facts', () => {
    const f = fixture();
    assert.deepEqual(parseInitialState(JSON.stringify(f.initial), f.job), f.initial);
    const empty = { summary: 'The starting location is unknown.', facts: [], openThreads: [], unknowns: ['No location was specified.'] };
    assert.deepEqual(parseInitialState(JSON.stringify(empty), f.job), empty);
});

test('both parsers accept complete JSON code fences', () => {
    const f = fixture();
    assert.deepEqual(parseInitialState(` \n\`\`\`json\n${JSON.stringify(f.initial)}\n\`\`\`\n`, f.job), f.initial);
    assert.deepEqual(parseContinuityCheck(`\`\`\`\n${JSON.stringify(f.check)}\n\`\`\``, f.job, f.candidate), f.check);
});

test('initial grounding cannot use an outline, later section, or candidate as established source', () => {
    const f = fixture(); f.job.plan = { summary: 'At the harbor.' }; f.job.sections = [{ id: 1, text: 'At the harbor.' }];
    f.initial.facts[0].evidence = 'At the harbor.';
    assert.throws(() => parseInitialState(JSON.stringify(f.initial), f.job), /source evidence/);
});

test('grounding is exact and cannot join separate source messages into one quotation', () => {
    const f = fixture();
    for (const evidence of ['mira carried the sealed ledger', 'to the west gate.<brief>', 'Keep   the ledger sealed.', 'Invented fact']) {
        f.initial.facts[0].evidence = evidence;
        assert.throws(() => parseInitialState(JSON.stringify(f.initial), f.job), /source evidence/);
    }
});

test('checker preserves full source, accepted prose, candidate and latest accepted state separately', () => {
    const f = fixture();
    const accepted = 'Mira gave the ledger to Rhea at the west gate.';
    f.job.sections = [{ id: 1, text: accepted, reasoning: 'Unneeded private draft reasoning.' }];
    const endState = { summary: 'Rhea holds the ledger.', facts: [{ fact: 'Rhea received the ledger.', evidence: accepted }], openThreads: [], unknowns: [] };
    f.job.continuity.acceptedFrames.push({ sectionId: 1, candidateId: 'synthetic-candidate-1', report: {}, endState });
    f.job.plan = { sections: [{ id: 2, endState: 'Reach the harbor.' }] };
    f.candidate.id = 2;
    const original = structuredClone(f.job);
    const request = buildContinuityCheckRequest(f.job, f.candidate), payload = JSON.parse(request.messages[1].content);
    assert.equal(request.model, 'synthetic/checker');
    assert.deepEqual(payload.sourceMessages, f.job.source.messages);
    assert.deepEqual(payload.acceptedSections, [{ id: 1, text: accepted }]);
    assert.deepEqual(payload.establishedState, endState);
    assert.deepEqual(payload.candidate, { id: 2, text: f.candidate.text });
    assert.deepEqual(payload.plannedStoryAsFutureConstraints, f.job.plan);
    assert.equal(request.messages[1].content.split(f.brief).length - 1, 1);
    assert.deepEqual(f.job, original);
});

test('first section uses the initial state when there are no accepted frames', () => {
    const f = fixture();
    assert.deepEqual(JSON.parse(buildContinuityCheckRequest(f.job, f.candidate).messages[1].content).establishedState, f.initial);
});

test('check parsing retains severity and validates both sides of concrete evidence', () => {
    const f = fixture();
    for (const severity of ['high', 'medium', 'low']) {
        f.check.issues[0].severity = severity;
        const result = parseContinuityCheck(JSON.stringify(f.check), f.job, f.candidate);
        assert.deepEqual(result, f.check); assert.notEqual(result, f.check);
    }
    const empty = { issues: [], endState: f.initial };
    assert.deepEqual(parseContinuityCheck(JSON.stringify(empty), f.job, f.candidate), empty);
});

test('prior evidence can come from accepted sections and end state can cite all supplied narrative', () => {
    const f = fixture(); f.job.sections = [{ id: 1, text: 'Rhea locked the ledger inside the iron chest.' }]; f.candidate.id = 2;
    f.check.issues[0].evidenceBefore = f.job.sections[0].text;
    f.check.endState.facts.push({ fact: 'The ledger was previously locked away.', evidence: f.job.sections[0].text }, ...f.initial.facts);
    assert.deepEqual(parseContinuityCheck(JSON.stringify(f.check), f.job, f.candidate), f.check);
});

for (const [label, mutate] of [
    ['empty before evidence', f => { f.check.issues[0].evidenceBefore = ''; }],
    ['empty after evidence', f => { f.check.issues[0].evidenceAfter = '  '; }],
    ['candidate used as prior evidence', f => { f.check.issues[0].evidenceBefore = 'She read the first page.'; }],
    ['source used as candidate evidence', f => { f.check.issues[0].evidenceAfter = 'Keep the ledger sealed.'; }],
    ['invented ending state', f => { f.check.endState.facts[0].evidence = 'They reached the harbor.'; }],
    ['invalid severity', f => { f.check.issues[0].severity = 'critical'; }],
    ['missing suggestion', f => { delete f.check.issues[0].suggestion; }],
    ['unexpected report property', f => { f.check.prose = 'An unsolicited replacement story.'; }],
]) {
    test(`check rejects ${label}`, () => {
        const f = fixture(); mutate(f);
        assert.throws(() => parseContinuityCheck(JSON.stringify(f.check), f.job, f.candidate));
    });
}

for (const [label, mutate] of [
    ['summary', value => { value.summary = 'x'.repeat(1801); }],
    ['fact', value => { value.facts[0].fact = 'x'.repeat(701); }],
    ['evidence', value => { value.facts[0].evidence = 'x'.repeat(1201); }],
    ['fact count', value => { value.facts = Array.from({ length: 41 }, () => value.facts[0]); }],
    ['thread count', value => { value.openThreads = Array(21).fill('An unresolved matter.'); }],
    ['unknown count', value => { value.unknowns = Array(21).fill('Weather is unknown.'); }],
    ['thread length', value => { value.openThreads = ['x'.repeat(701)]; }],
    ['unknown length', value => { value.unknowns = ['x'.repeat(701)]; }],
    ['empty fact', value => { value.facts[0].fact = ''; }],
    ['empty evidence', value => { value.facts[0].evidence = ''; }],
    ['unknown state property', value => { value.futureOutcome = 'At the harbor.'; }],
]) {
    test(`state rejects excessive or malformed ${label}`, () => {
        const f = fixture(); mutate(f.initial);
        assert.throws(() => parseInitialState(JSON.stringify(f.initial), f.job));
        f.check.endState = f.initial;
        assert.throws(() => parseContinuityCheck(JSON.stringify(f.check), f.job, f.candidate));
    });
}

test('issue count and finding fields have bounded lengths', () => {
    const f = fixture(); f.check.issues = Array.from({ length: 13 }, () => f.check.issues[0]);
    assert.throws(() => parseContinuityCheck(JSON.stringify(f.check), f.job, f.candidate), /oversized/);
    for (const key of ['problem', 'evidenceBefore', 'evidenceAfter', 'suggestion']) {
        const other = fixture(); other.check.issues[0][key] = 'x'.repeat(1201);
        assert.throws(() => parseContinuityCheck(JSON.stringify(other.check), other.job, other.candidate), /oversized/);
    }
});

test('malformed model output is rejected with sanitized diagnostics', () => {
    const f = fixture();
    for (const raw of ['', 'PRIVATE_SYNTHETIC_RESPONSE {broken', '[]', 'null', '```json\n{}\n```\nPRIVATE_SYNTHETIC_TAIL', 'x'.repeat(200001)]) {
        for (const parse of [() => parseInitialState(raw, f.job), () => parseContinuityCheck(raw, f.job, f.candidate)]) {
            assert.throws(parse, error => error instanceof Error && !error.message.includes('PRIVATE_SYNTHETIC'));
        }
    }
});

test('request builders never shorten a large complete source', () => {
    const f = fixture();
    f.job.source.messages[0].content += '\n' + 'Synthetic full-context reference. '.repeat(18000);
    const original = structuredClone(f.job.source.messages);
    for (const request of [buildInitialStateRequest(f.job), buildContinuityCheckRequest(f.job, f.candidate)]) {
        assert.deepEqual(JSON.parse(request.messages[1].content).sourceMessages, original);
    }
});

test('invalid source roles or a missing full brief fail before producing a request', () => {
    for (const mutate of [
        f => { f.job.source.messages[0].role = 'tool'; },
        f => { f.job.source.messages[0].content = [{ type: 'image_url' }]; },
        f => { f.job.source.messages[2].content = 'Truncated brief.'; },
        f => { f.job.settings.plannerModel = 'bad model'; f.job.settings.reviewerModel = 'bad model'; },
    ]) {
        const f = fixture(); mutate(f);
        assert.throws(() => buildInitialStateRequest(f.job));
        assert.throws(() => buildContinuityCheckRequest(f.job, f.candidate));
    }
});

test('missing initial state and empty or invalid candidate fail closed', () => {
    const f = fixture(); delete f.job.continuity;
    assert.throws(() => buildContinuityCheckRequest(f.job, f.candidate));
    for (const candidate of [{ id: 0, text: 'A candidate.' }, { id: 1, text: '' }, null]) {
        const other = fixture();
        assert.throws(() => buildContinuityCheckRequest(other.job, candidate));
        assert.throws(() => parseContinuityCheck(JSON.stringify(other.check), other.job, candidate));
    }
});
