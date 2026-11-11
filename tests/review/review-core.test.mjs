import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDraft, applyParagraphReplacement, parseReviewReport, countWords } from '../../extensions/StoryReview/review-core.js';

test('counts blank-line prose paragraphs and Unicode words with contractions and compounds', () => {
    const raw = 'Élodie’s well-lit café opened.\nA soft bell rang.\n\n“Don’t wait,” she said.';
    const a = analyzeDraft(raw);
    assert.equal(a.words, 12);
    assert.equal(a.paragraphs, 2);
    assert.deepEqual(a.countedParagraphs.map(p => p.id), [1, 2]);
    for (const p of a.countedParagraphs) assert.ok(raw.slice(p.start, p.end).trim());
    assert.equal(a.wordStatus, 'below');
    assert.equal(countWords('one-two one—two 12,000 naïve'), 5);
});

test('excludes both planning formats and recognizes a large synthetic target', () => {
    const story = Array.from({ length: 125 }, () => Array(100).fill('word').join(' ')).join('\n\n');
    const a = analyzeDraft(`[PLANNING_START]\nPlan the entire story.\n[PLANNING_END]\n<think>More planning.</think>\n\n${story}`);
    assert.equal(a.words, 12500);
    assert.equal(a.paragraphs, 125);
    assert.equal(a.wordStatus, 'within');
    assert.equal(a.paragraphStatus, 'within');
    assert.equal(a.blocked, false);
});

for (const raw of ['[PLANNING_START]unfinished', '<think>unfinished', '[PLANNING_END] orphan', '<think><think>nested</think></think>', '### Internal Monologue\nNo response marker']) {
    test(`fails closed for malformed reasoning: ${raw.slice(0, 30)}`, () => {
        const a = analyzeDraft(raw);
        assert.equal(a.blocked, true);
        assert.equal(a.words, null);
        assert.equal(a.paragraphs, null);
        assert.deepEqual(a.countedParagraphs, []);
        assert.ok(a.warnings.length);
    });
}

test('legacy monologue, headings, known nested FF details and graphics are excluded', () => {
    const raw = '### Internal Monologue\nA lot of planning.\n### Response\n\n# Chapter One\n\nA quiet morning.\n\n<details><summary>INTERNAL STATES</summary>state\n<details><summary>NPC AGENDAS</summary>more state</details></details>\n\n<!-- GFX_START --><div>map words</div><!-- GFX_END -->\n\nThe door opened.';
    const a = analyzeDraft(raw);
    assert.equal(a.blocked, false);
    assert.equal(a.words, 6);
    assert.equal(a.paragraphs, 2);
    assert.equal(a.narrativeText, 'A quiet morning.\n\nThe door opened.');
});

test('unrecognized details remain visible and emit a warning', () => {
    const a = analyzeDraft('<details><summary>Letter</summary>A hidden message.</details>');
    assert.equal(a.words, 4);
    assert.equal(a.paragraphs, 1);
    assert.ok(a.warnings.some(w => /unrecognized details/.test(w)));
});

test('unclosed FF panel is blocked', () => {
    const a = analyzeDraft('Story first.\n\n<details><summary>QUESTS</summary>unfinished');
    assert.equal(a.blocked, true);
});

test('numbered prose counts, whereas bullets, numbered lists, tables, and code are excluded', () => {
    const raw = '1. First prose paragraph.\n\n2. Second prose paragraph.\n\n- Current location\n- Current quest\n\n1. List item\n2. Other item\n\n| Name | Value |\n| --- | --- |\n\n```text\nnot story\n```\n\nFinal prose paragraph.';
    const a = analyzeDraft(raw);
    assert.equal(a.words, 9);
    assert.equal(a.paragraphs, 3);
    assert.ok(a.warnings.some(w => /List or table/.test(w)));
});

test('HTML paragraph tags and entities count without changing source offsets', () => {
    const raw = '<h2>A heading</h2><p>A &amp; B.</p><p>Caf&#233; opened.</p>';
    const a = analyzeDraft(raw);
    assert.equal(a.paragraphs, 2);
    assert.equal(a.words, 4);
    assert.equal(a.countedParagraphs[0].text, 'A & B.');
    assert.equal(raw.slice(a.countedParagraphs[1].start, a.countedParagraphs[1].end), 'Caf&#233; opened.');
});

test('targeted replacement preserves everything outside selected paragraph exactly', () => {
    const raw = '[PLANNING_START]Keep this.[PLANNING_END]\r\n\r\nFirst story paragraph.\r\n\r\nSecond story paragraph.\r\n\r\n<details><summary>QUESTS</summary>Keep this too.</details>';
    const a = analyzeDraft(raw);
    const result = applyParagraphReplacement(raw, a, [2], 'Revised second paragraph.');
    assert.equal(result, raw.replace('Second story paragraph.', 'Revised second paragraph.'));
    assert.ok(!JSON.stringify(a).includes('Keep this.'));
});

test('replacing contiguous paragraphs preserves outer formatting', () => {
    const raw = '  First paragraph.\n\nSecond paragraph.\n\nThird paragraph.  ';
    const a = analyzeDraft(raw);
    assert.equal(applyParagraphReplacement(raw, a, [1, 2], 'One merged paragraph.'), '  One merged paragraph.\n\nThird paragraph.  ');
});

test('stale, invalid, noncontiguous, metadata-crossing revisions are rejected', () => {
    const raw = 'First paragraph.\n\nSecond paragraph.\n\n# Heading\n\nThird paragraph.';
    const a = analyzeDraft(raw);
    assert.throws(() => applyParagraphReplacement(raw + ' edited', a, [1], 'New'), /draft changed/);
    assert.throws(() => applyParagraphReplacement(raw, a, [1, 3], 'New'), /contiguous/);
    assert.throws(() => applyParagraphReplacement(raw, a, [2, 3], 'New'), /excluded/);
    assert.throws(() => applyParagraphReplacement(raw, a, [1, 1], 'New'), /unique/);
    assert.throws(() => applyParagraphReplacement(raw, a, [1], '<think>Thoughts</think>New'), /prose only/);
    assert.throws(() => applyParagraphReplacement(raw, a, [1], '   '), /empty/);
});

test('review parser accepts bounded typed data, strips markup, and ignores model counts', () => {
    const obj = { summary: '<b>Useful draft.</b>', strengths: ['Clear voice'], words: 999999, issues: [{ severity: 'medium', category: 'continuity', paragraphs: [2, 1, 2], problem: 'The door changes state.', suggestion: 'Preserve the established state.' }] };
    const report = parseReviewReport('```json\n' + JSON.stringify(obj) + '\n```', 3);
    assert.equal(report.summary, 'Useful draft.');
    assert.deepEqual(report.issues[0].paragraphs, [1, 2]);
    assert.ok(!('words' in report));
});

test('review parser rejects made-up paragraph references and unstructured output', () => {
    const base = { summary: 'Report.', strengths: [], issues: [{ severity: 'high', category: 'prose', paragraphs: [4], problem: 'Issue.', suggestion: 'Fix.' }] };
    assert.throws(() => parseReviewReport(JSON.stringify(base), 3), /paragraph references/);
    base.issues[0].paragraphs = ['1'];
    assert.throws(() => parseReviewReport(JSON.stringify(base), 3), /paragraph references/);
    base.issues[0].paragraphs = [];
    base.issues[0].severity = 'critical';
    assert.throws(() => parseReviewReport(JSON.stringify(base), 3), /severity/);
    assert.throws(() => parseReviewReport('Here is your report: {}', 3));
    assert.throws(() => parseReviewReport('{"summary":"x","strengths":[],"issues":null}', 3));
});

test('target bounds are validated', () => {
    assert.throws(() => analyzeDraft('Text.', { wordMin: 100, wordMax: 50 }), /Minimum/);
    assert.throws(() => analyzeDraft('Text.', { paragraphMin: 0 }), /positive integer/);
});

test('plain text before a planning marker fails closed even if it quotes the required ending', () => {
    const raw = 'I must finish with the required final line: The lantern reached the harbor.\n\n[PLANNING_START]\nPlan all six scenes.\n[PLANNING_END]';
    const a = analyzeDraft(raw);
    assert.equal(a.blocked, true);
    assert.equal(a.words, null);
    assert.equal(a.paragraphs, null);
    assert.equal(a.narrativeText, '');
    assert.deepEqual(a.countedParagraphs, []);
    assert.ok(a.warnings.some(w => /Unmarked text appears before the planning block/.test(w)));
    assert.throws(() => applyParagraphReplacement(raw, a, [1], 'A replacement.'), /cannot be revised/);
});

test('a real story after a block does not make an ambiguous planning prefix countable', () => {
    const a = analyzeDraft('First I need to plan.\n\n<think>More planning.</think>\n\nA traveler entered the harbor.');
    assert.equal(a.blocked, true);
    assert.equal(a.words, null);
    assert.equal(a.narrativeText, '');
});

test('planning without a story reports zero and an explicit warning', () => {
    for (const raw of ['[PLANNING_START]A detailed plan.[PLANNING_END]', '<think>A detailed plan.</think>', '### Internal Monologue\nA detailed plan.\n### Response']) {
        const a = analyzeDraft(raw);
        assert.equal(a.blocked, false);
        assert.equal(a.words, 0);
        assert.equal(a.paragraphs, 0);
        assert.ok(a.warnings.some(w => /planning without a story/.test(w)));
    }
});

test('recognized FF panels and headings may precede a planning block', () => {
    const raw = '# Chapter One\n\n<details><summary>INTERNAL STATES</summary>Known metadata.</details>\n\n[PLANNING_START]Plan.[PLANNING_END]\n\nA traveler entered the harbor.';
    const a = analyzeDraft(raw);
    assert.equal(a.blocked, false);
    assert.equal(a.words, 5);
    assert.equal(a.paragraphs, 1);
    assert.equal(a.narrativeText, 'A traveler entered the harbor.');
    assert.ok(!a.warnings.some(w => /Unmarked text/.test(w)));
});

test('normal prose without planning markers remains countable', () => {
    const a = analyzeDraft('A traveler made plans for tomorrow.\n\nThe lantern reached the harbor.');
    assert.equal(a.blocked, false);
    assert.equal(a.words, 11);
    assert.equal(a.paragraphs, 2);
    assert.deepEqual(a.warnings, []);
});

test('standalone FF time/day/location status headers are excluded without changing story offsets', () => {
    const header = '[ 🕰️ Time 3:42 PM | 🗓️ Day 12 - Thursday, April 12 | 📍 Riverstead - Market Square | 🌧️ Heavy rain ]';
    const raw = `${header}\r\n\r\n# The Ledger\r\n\r\nA traveler entered the harbor.`;
    const a = analyzeDraft(raw);
    assert.equal(a.words, 5);
    assert.equal(a.paragraphs, 1);
    assert.equal(a.countedParagraphs[0].start, raw.indexOf('A traveler'));
    assert.ok(a.excludedRanges.some(r => r.kind.includes('FF status header')));
    const withPlanning = analyzeDraft(`${header}\n\n[PLANNING_START]Plan.[PLANNING_END]\n\nA traveler entered the harbor.`);
    assert.equal(withPlanning.blocked, false);
    assert.equal(withPlanning.words, 5);
    assert.equal(withPlanning.paragraphs, 1);
});

test('ordinary bracketed prose and inline status-like text remain counted', () => {
    const raw = '[The traveler kept the letter safe.]\n\n[Time passed | Day broke]\n\nThey saw [Time: 3:42 | Location: Tower] on the sign.';
    const a = analyzeDraft(raw);
    assert.equal(a.paragraphs, 3);
    assert.equal(a.countedParagraphs[0].words, 6);
    assert.equal(a.countedParagraphs[1].words, 4);
    assert.ok(a.countedParagraphs[2].text.includes('Location: Tower'));
    assert.ok(!a.excludedRanges.some(r => r.kind.includes('FF status header')));
});

test('incomplete status recognition stays counted with an ambiguity warning', () => {
    const a = analyzeDraft('[🕰️ Time 3:42 PM | the traveler waited]');
    assert.equal(a.paragraphs, 1);
    assert.ok(a.words > 0);
    assert.ok(a.warnings.some(w => /unrecognized bracketed status line/.test(w)));
    const labeled = analyzeDraft('[Time: 15:42 | Location: Tower]\n\nA traveler waited.');
    assert.equal(labeled.words, 3);
    assert.equal(labeled.paragraphs, 1);
});
