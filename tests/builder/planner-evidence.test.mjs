import test from 'node:test';
import assert from 'node:assert/strict';
import { indexBrief, resolvePlanEvidence } from '../../extensions/StoryBuilder/planner-evidence.js';

function assertIndex(brief, { allowWhitespace = false } = {}) {
    const passages = indexBrief(brief);
    assert.equal(passages.map(passage => passage.text).join(''), brief);
    assert.ok(passages.length > 0);
    for (const [index, passage] of passages.entries()) {
        assert.deepEqual(Object.keys(passage), ['id', 'text']);
        assert.equal(passage.id, `p${String(index + 1).padStart(4, '0')}`);
        assert.ok(passage.text.length > 0 && passage.text.length <= 1800);
        if (!allowWhitespace) assert.ok(passage.text.trim());
        if (index + 1 < passages.length) {
            const before = passage.text.charCodeAt(passage.text.length - 1), after = passages[index + 1].text.charCodeAt(0);
            assert.ok(!(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff), 'a surrogate pair cannot cross passage boundaries');
        }
    }
    assert.deepEqual(indexBrief(brief), passages, 'indexing is deterministic');
    return passages;
}
function plan(requiredBeats) {
    return { fixedFacts: ['The compass remains brass.'], requiredBeats,
        sections: [{ id: 1, title: 'Departure', beatIds: ['b1'], direction: 'Follow the supplied order.' }], finalRequirements: [] };
}
function evidenceError(action, expected) {
    assert.throws(action, error => {
        assert.equal(error.name, 'PlannerEvidenceError');
        if (expected) assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /PRIVATE_BRIEF_MARKER|UNTRUSTED_MODEL_MARKER/);
        return true;
    });
}

test('short and multilingual briefs retain every byte of whitespace and source text', () => {
    for (const brief of ['  Departure\r\n\r\nMeet the courier.\n', '序章\n港へ向かう。\n\n手紙を渡す。',
        'План\nВстретить курьера.\n', 'الفصل الأول\nتسليم الرسالة.\n', '👩🏽‍🚀 Meet the courier.\t']) {
        assert.deepEqual(assertIndex(brief), [{ id: 'p0001', text: brief }]);
    }
});

test('long briefs are lossless without truncating headings, repeated paragraphs, or source order', () => {
    const brief = 'TITLE\r\n\r\n' + Array.from({ length: 150 }, (_, index) => `Section ${index + 1}\n${'Keep the established event. '.repeat(35)}\n\n`).join('') + 'ENDING\n';
    const passages = assertIndex(brief);
    assert.ok(passages.length > 80); assert.match(passages[0].text, /^TITLE/); assert.match(passages.at(-1).text, /ENDING\n$/);
    assert.ok(passages.some(passage => passage.text.endsWith('\n\n')));
});

test('long passages prefer available paragraph, newline, sentence, and whitespace boundaries after 900 characters', () => {
    for (const separator of ['\r\n\r\n', '\n', '。 ', ' ']) {
        const head = 'a'.repeat(1000) + separator, brief = head + 'b'.repeat(1700);
        const passages = assertIndex(brief);
        assert.equal(passages[0].text, head);
    }
});

test('unbroken Unicode text is split within 1,800 UTF-16 characters without splitting surrogate pairs', () => {
    for (const brief of ['a'.repeat(1799) + '😀' + '文'.repeat(5000), '🧭'.repeat(5001), '界'.repeat(10001),
        'e\u0301'.repeat(3000) + '👩‍🚀'.repeat(1000)]) assertIndex(brief);
});

test('avoidable trailing whitespace-only passages are merged or rebalanced without losing text', () => {
    const brief = 'AB' + ' '.repeat(1799), passages = assertIndex(brief);
    assert.deepEqual(passages, [{ id: 'p0001', text: 'A' }, { id: 'p0002', text: 'B' + ' '.repeat(1799) }]);
    assertIndex('word '.repeat(700) + '\n\t '.repeat(200));
});

test('large whitespace spans remain lossless but their whitespace-only anchors cannot be cited', () => {
    const brief = 'Start.' + ' '.repeat(9000) + 'Finish.' + '\n'.repeat(4000);
    const passages = assertIndex(brief, { allowWhitespace: true });
    const blank = passages.find(passage => !passage.text.trim()); assert.ok(blank);
    evidenceError(() => resolvePlanEvidence(plan([{ id: 'b1', passageId: blank.id }]), brief), /without usable/);
    const usable = passages.find(passage => passage.text.includes('Finish.'));
    assert.equal(resolvePlanEvidence(plan([{ id: 'b1', passageId: usable.id }]), brief).requiredBeats[0].briefQuote, usable.text);
    assertIndex(' '.repeat(4000) + 'End.', { allowWhitespace: true });
});

test('empty, whitespace-only, and non-string briefs return fixed typed diagnostics', () => {
    for (const brief of ['', ' \t\r\n', ' '.repeat(4000), null, undefined, {}, 42]) evidenceError(() => indexBrief(brief), /nonempty author brief/);
});

test('passage references resolve to canonical exact quotations in a detached plan clone', () => {
    const brief = '  Meet the courier.\n\nCross the river.\n', input = plan([{ id: 'b1', passageId: 'p0001', metadata: 'Unused extra value.' }]);
    const before = structuredClone(input), result = resolvePlanEvidence(input, brief, { requirePassageIds: true });
    assert.deepEqual(result.requiredBeats, [{ id: 'b1', passageId: 'p0001', briefQuote: brief }]);
    assert.deepEqual(input, before); assert.deepEqual(result.sections, input.sections); assert.notEqual(result.sections, input.sections);
    result.sections[0].direction = 'Changed clone.'; assert.equal(input.sections[0].direction, before.sections[0].direction);
});

test('separate beats may share a passage and repeated passage text still receives distinct positional IDs', () => {
    const text = 'The repeated source paragraph. '.repeat(40) + '\n\n', brief = text.repeat(4);
    const passages = assertIndex(brief);
    assert.equal(passages[0].text, passages[1].text); assert.notEqual(passages[0].id, passages[1].id);
    const result = resolvePlanEvidence(plan([{ id: 'b1', passageId: passages[0].id }, { id: 'b2', passageId: passages[0].id }]), brief);
    assert.equal(result.requiredBeats[0].briefQuote, result.requiredBeats[1].briefQuote);
    assert.deepEqual(result.requiredBeats.map(beat => beat.id), ['b1', 'b2']);
});

test('beats sharing one passage preserve their distinct optional requirements without rewriting the source quote', () => {
    const brief = 'Meet the courier, obtain the sealed letter, then cross the river.';
    const input = plan([{ id: 'b1', passageId: 'p0001', requirement: '  Obtain the sealed letter from the courier.  ' },
        { id: 'b2', passageId: 'p0001', requirement: 'Cross the river after the handoff.' }]);
    const before = structuredClone(input), result = resolvePlanEvidence(input, brief, { requirePassageIds: true });
    assert.deepEqual(result.requiredBeats, input.requiredBeats.map(beat => ({ id: beat.id, passageId: beat.passageId,
        briefQuote: brief, requirement: beat.requirement })));
    assert.deepEqual(Object.keys(result.requiredBeats[0]), ['id', 'passageId', 'briefQuote', 'requirement']);
    assert.deepEqual(resolvePlanEvidence(result, brief), result, 'cached normalization preserves requirements exactly');
    assert.deepEqual(input, before);
});

test('optional requirement descriptions remain bounded text and older ID beats need no new field', () => {
    const brief = 'Meet the courier.';
    for (const requirement of ['', ' \n\t ', null, undefined, [], {}, 42, 'x'.repeat(1001)]) {
        evidenceError(() => resolvePlanEvidence(plan([{ id: 'b1', passageId: 'p0001', requirement }]), brief), /invalid or oversized requirement/);
    }
    const atLimit = resolvePlanEvidence(plan([{ id: 'b1', passageId: 'p0001', requirement: 'x'.repeat(1000) }]), brief);
    assert.equal(atLimit.requiredBeats[0].requirement.length, 1000);
    assert.equal(atLimit.requiredBeats[0].briefQuote, brief);
    const old = resolvePlanEvidence(plan([{ id: 'b1', passageId: 'p0001' }]), brief);
    assert.deepEqual(Object.keys(old.requiredBeats[0]), ['id', 'passageId', 'briefQuote']);
});

test('legacy beats are preserved alongside canonical references, but new planning can require every ID', () => {
    const brief = 'Meet the courier. Cross the river.', legacy = { id: 'b1', briefQuote: 'Meet the courier.', legacyField: 'Preserved' };
    const input = plan([legacy, { id: 'b2', passageId: 'p0001' }]), result = resolvePlanEvidence(input, brief);
    assert.deepEqual(result.requiredBeats[0], legacy); assert.notEqual(result.requiredBeats[0], legacy);
    evidenceError(() => resolvePlanEvidence(input, brief, { requirePassageIds: true }), /missing/);
    const invalidLegacyQuote = plan([{ id: 'b1', briefQuote: 'Not present in the brief.' }]);
    assert.deepEqual(resolvePlanEvidence(invalidLegacyQuote, brief), invalidLegacyQuote, 'legacy quote validation belongs to the existing core validator');
});

test('unknown or malformed owned passage IDs never fall back to a valid legacy quote', () => {
    const brief = 'Meet the courier.';
    for (const passageId of ['p9999', 'p1', ' p0001', '', null, undefined, 1, {}]) {
        evidenceError(() => resolvePlanEvidence(plan([{ id: 'b1', passageId, briefQuote: brief }]), brief), /unknown/);
    }
});

test('supplied quotations cannot override canonical source and cached plans cannot silently rebind', () => {
    const brief = 'PRIVATE_BRIEF_MARKER Meet the courier.\n';
    const cached = resolvePlanEvidence(plan([{ id: 'b1', passageId: 'p0001' }]), brief);
    assert.deepEqual(resolvePlanEvidence(cached, brief), cached, 'revalidation is idempotent');
    for (const briefQuote of ['UNTRUSTED_MODEL_MARKER', brief.trim(), null, undefined, 42]) {
        evidenceError(() => resolvePlanEvidence(plan([{ id: 'b1', passageId: 'p0001', briefQuote }]), brief), /no longer matches/);
    }
    evidenceError(() => resolvePlanEvidence(cached, brief.replace('courier', 'sailor')), /no longer matches/);
});

test('malformed plan shapes fail with safe diagnostics rather than mutating inputs', () => {
    for (const input of [null, [], {}, { requiredBeats: null }, { requiredBeats: {} },
        plan([null]), plan([[]]), plan([{}]), plan([{ id: '' }]), plan([{ id: 3 }]), plan([{ id: 'x'.repeat(61) }])]) {
        evidenceError(() => resolvePlanEvidence(input, 'Meet the courier.'), /invalid required-beat structure/);
    }
    evidenceError(() => resolvePlanEvidence(plan([{ id: 'b1', passageId: 'p0001' }]), 'Meet the courier.', { requirePassageIds: 'yes' }), /invalid/);
    const uncloneable = plan([{ id: 'b1', passageId: 'p0001' }]); uncloneable.callback = () => {};
    evidenceError(() => resolvePlanEvidence(uncloneable, 'Meet the courier.'), /copied safely/);
});
