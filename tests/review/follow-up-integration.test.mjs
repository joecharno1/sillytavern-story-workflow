import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSettings, snapshotDraft, snapshotCurrent, appendRevision } from '../../extensions/StoryReview/review-service.js';
import { resolveFollowUpSettings, createFollowUpSession, reviewFollowUp, reviseFollowUp,
    updateSessionOptions, advanceSession, assertFollowUpCurrent, followUpSpend } from '../../extensions/StoryReview/follow-up.js';

const selected = 'ACTIVE_BUILDER_DIALOGUE: keep the speakers distinct and preserve established knowledge.';
const savedOverride = 'ACTIVE_FOLLOWUP_OVERRIDE: use short exchanges with purposeful pauses.';
const unused = 'DORMANT_LIBRARY_TEXT: this unused synthetic preference must stay local.';
const original = 'Mara carried the brass compass to the gate.\n\nThe courier spoke in a stilted voice beside the river.\n\nThey crossed the bridge before dusk.';

function fixture({ preferences = {}, builder = {}, requestCost = '.01', failGeneration = false, mutateResponse } = {}) {
    const builderSettings = { reviewerModel: 'test/reviewer', revisionModel: 'test/revision', tuningEnabled: true,
        writingStyles: { dialogue: { preset: 'custom-selected', custom: unused, model: 'test/dialogue' } },
        writingPresetLibrary: { dialogue: [
            { id: 'custom-selected', name: 'Selected voice', text: selected },
            { id: 'custom-override', name: 'Editing voice', text: savedOverride },
            { id: 'custom-unused', name: 'DORMANT_LIBRARY_NAME', text: unused },
        ] }, ...builder };
    const reviewSettings = { ...safeSettings({ model: 'test/standalone', wordMin: 1, wordMax: 1000,
        paragraphMin: 1, paragraphMax: 20, maxOutput: 4096 }),
        followUp: { focus: 'dialogue', preset: 'builder', custom: unused, useBuilderStyles: true,
            reviewModel: '', revisionModel: '', spendLimitUsd: 1, ...preferences } };
    const earlier = { is_user: false, mes: '<think>OMITTED_EARLIER_REASONING</think>The compass is brass.', swipe_id: 0,
        swipes: ['The compass is brass.', 'OMITTED_ALTERNATIVE_HISTORY'] };
    const brief = { is_user: true, mes: 'Have Mara meet the courier and cross the river before dusk. Keep the compass brass.' };
    const message = { is_user: false, mes: original, swipe_id: 0, swipes: [original, 'OMITTED_ALTERNATIVE_STORY'],
        swipe_info: [{ extra: { model: 'test/writer', reasoning: 'OMITTED_ORIGINAL_REASONING' } }, { extra: { rejected: true } }],
        extra: { model: 'test/writer', reasoning: 'OMITTED_ORIGINAL_REASONING', token_count: 22, display_text: 'OLD_RENDER_CACHE' } };
    const stats = { saves: 0, renders: 0, events: [], requests: [], metadata: [] };
    const context = { chat: [earlier, brief, message], getCurrentChatId: () => 'synthetic-follow-up-chat',
        saveChat: async () => { stats.saves++; }, updateMessageBlock: () => { stats.renders++; },
        eventSource: { emit: async (...args) => { stats.events.push(args); } }, eventTypes: { MESSAGE_SWIPED: 'message_swiped' } };
    const takeSnapshot = () => snapshotDraft(context, 2, reviewSettings);
    const resolved = resolveFollowUpSettings(reviewSettings, builderSettings);
    const session = createFollowUpSession(takeSnapshot(), resolved);
    const models = ['reviewer', 'revision', 'dialogue', 'standalone', 'custom-review', 'custom-revision'].map(name => ({
        id: `test/${name}`, context_length: 131072, top_provider: { max_completion_tokens: 16384 },
        pricing: { prompt: '0', completion: '0', request: requestCost },
    }));
    const transport = { models, countTokens: async () => 100, assertCurrent: snapshot => snapshotCurrent(context, snapshot),
        fetcher: async (url, options) => {
            if (url.endsWith('/status') || url.includes('/tokenizers/')) {
                stats.metadata.push(url);
                return { ok: true, status: 200, json: async () => url.endsWith('/status') ? { data: models } : { token_count: 100 } };
            }
            assert.equal(url, '/api/backends/chat-completions/generate');
            const body = JSON.parse(options.body), payload = JSON.parse(body.messages.at(-1).content);
            stats.requests.push({ body, payload });
            if (failGeneration) throw new Error('Synthetic connection failure after dispatch');
            const content = payload.selectedParagraphs
                ? payload.draft.filter(row => payload.selectedParagraphs.includes(row.id)).map(row => row.text.replace('stilted', 'measured')).join('\n\n')
                : JSON.stringify({ summary: 'A local wording change would help.', strengths: ['The compass remains brass.'], issues: [{
                    severity: 'low', category: 'prose', paragraphs: [2], problem: 'The courier description is vague.',
                    suggestion: 'Use a more precise description of the courier’s voice.',
                }] });
            return { ok: true, status: 200, json: async () => {
                mutateResponse?.({ context, brief, message });
                return { choices: [{ message: { content }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 100, completion_tokens: 100, cost: Number(requestCost) } };
            } };
        } };
    return { builderSettings, reviewSettings, resolved, session, context, message, brief, stats, transport, takeSnapshot };
}

test('opening a follow-up session is local and its actual review receives only active inherited style and accepted context', async () => {
    const f = fixture(), builderBefore = structuredClone(f.builderSettings);
    assert.equal(f.stats.requests.length, 0);
    assert.equal(f.stats.metadata.length, 0);
    const report = await reviewFollowUp(f.session, f.transport);
    assert.equal(report.issues.length, 1);
    assert.equal(f.stats.requests.length, 1);
    const { body, payload } = f.stats.requests[0];
    assert.equal(body.model, 'test/dialogue');
    assert.equal(payload.focus, 'dialogue');
    assert.equal(payload.latestBrief, f.brief.mes);
    assert.equal(payload.draft.map(row => row.text).join('\n\n'), original);
    const serialized = JSON.stringify(body);
    assert.ok(serialized.includes(selected));
    assert.ok(serialized.includes('The compass is brass.'));
    assert.doesNotMatch(serialized, /DORMANT_LIBRARY|OMITTED_|OLD_RENDER_CACHE|writingPresetLibrary/);
    assert.equal(f.message.mes, original);
    assert.equal(f.stats.saves, 0);
    assert.deepEqual(f.builderSettings, builderBefore);
});

test('a saved focus override and independent models reach actual review and revision without changing Builder preferences', async () => {
    const f = fixture({ preferences: { preset: 'custom-override', reviewModel: 'test/custom-review', revisionModel: 'test/custom-revision' } });
    const builderBefore = structuredClone(f.builderSettings);
    await reviewFollowUp(f.session, f.transport);
    const proposal = await reviseFollowUp(f.session, [2], 'Replace stilted with measured and preserve the events.', f.transport);
    assert.deepEqual(f.stats.requests.map(call => call.body.model), ['test/custom-review', 'test/custom-revision']);
    for (const call of f.stats.requests) {
        assert.ok(JSON.stringify(call.body).includes(savedOverride));
        assert.doesNotMatch(JSON.stringify(call.body), /ACTIVE_BUILDER_DIALOGUE|DORMANT_LIBRARY|writingPresetLibrary/);
        assert.equal(call.payload.draft.map(row => row.text).join('\n\n'), original);
    }
    assert.equal(proposal.model, 'test/custom-revision');
    assert.equal(proposal.sessionRevision, f.session.revision);
    assert.equal(proposal.updated, original.replace('stilted', 'measured'));
    assert.equal(f.message.mes, original, 'a preview does not write to chat');
    assert.deepEqual(f.builderSettings, builderBefore);
});

test('explicit custom focus works with Builder styles disabled, while general review remains one manual request', async () => {
    const custom = 'FOLLOWUP_CUSTOM_ONLY: prefer direct, clearly attributed speech.';
    const f = fixture({ preferences: { useBuilderStyles: false, preset: 'custom', custom } });
    await reviewFollowUp(f.session, f.transport);
    assert.equal(f.stats.requests[0].body.model, 'test/reviewer');
    assert.ok(JSON.stringify(f.stats.requests[0].body).includes(custom));
    assert.doesNotMatch(JSON.stringify(f.stats.requests[0].body), /ACTIVE_BUILDER_DIALOGUE|DORMANT_LIBRARY/);
    const general = resolveFollowUpSettings({ ...f.reviewSettings,
        followUp: { ...f.reviewSettings.followUp, focus: 'general', preset: 'builder', useBuilderStyles: false } }, f.builderSettings);
    updateSessionOptions(f.session, general);
    await reviewFollowUp(f.session, f.transport);
    assert.equal(f.stats.requests.length, 2);
    assert.equal(f.stats.requests[1].payload.focus, 'general');
});

test('applying the actual proposal preserves original swipes, records its revision model, and keeps the session spend for further editing', async () => {
    const f = fixture({ preferences: { revisionModel: 'test/custom-revision' } });
    await reviewFollowUp(f.session, f.transport);
    const proposal = await reviseFollowUp(f.session, [2], 'Replace stilted with measured.', f.transport);
    const beforeSpend = followUpSpend(f.session), beforeRevision = f.session.revision;
    await assertFollowUpCurrent(f.session, f.transport);
    await appendRevision(f.context, f.session.snapshot, proposal.updated, proposal.model);
    assert.equal(f.stats.requests.length, 2, 'applying makes no provider request');
    assert.deepEqual(f.message.swipes, [original, 'OMITTED_ALTERNATIVE_STORY', proposal.updated]);
    assert.equal(f.message.mes, proposal.updated);
    assert.equal(f.message.extra.model, 'Story Review (test/custom-revision)');
    assert.equal(f.message.swipe_info[0].extra.model, 'test/writer');
    assert.equal(f.stats.saves, 1);
    assert.equal(f.stats.renders, 1);
    advanceSession(f.session, f.takeSnapshot());
    assert.ok(f.session.revision > beforeRevision);
    assert.deepEqual(followUpSpend(f.session), beforeSpend);
    await reviewFollowUp(f.session, f.transport);
    assert.equal(f.stats.requests.at(-1).payload.draft.map(row => row.text).join('\n\n'), proposal.updated);
    assert.equal(followUpSpend(f.session).reportedUsd, .03);
});

test('an edited brief blocks applying an otherwise valid preview without erasing the charge or original story', async () => {
    const f = fixture();
    const proposal = await reviseFollowUp(f.session, [2], 'Replace stilted with measured.', f.transport);
    const beforeSpend = followUpSpend(f.session), originalSwipes = [...f.message.swipes];
    f.brief.mes += ' A new requirement arrived.';
    await assert.rejects(assertFollowUpCurrent(f.session, f.transport), /changed|current|source/i);
    await assert.rejects(appendRevision(f.context, f.session.snapshot, proposal.updated, proposal.model), /changed/);
    assert.equal(f.message.mes, original);
    assert.deepEqual(f.message.swipes, originalSwipes);
    assert.equal(f.stats.saves, 0);
    assert.deepEqual(followUpSpend(f.session), beforeSpend);
});

test('a source edit during the actual review response still records its charge without accepting a result', async () => {
    const f = fixture({ mutateResponse: ({ brief }) => { brief.mes += ' Changed while the model was responding.'; } });
    await assert.rejects(reviewFollowUp(f.session, f.transport), /changed|current|source/i);
    assert.equal(f.stats.requests.length, 1);
    assert.equal(followUpSpend(f.session).reportedUsd, .01);
    assert.equal(f.message.mes, original);
    assert.equal(f.stats.saves, 0);
});

test('unknown charges survive model, focus, allowance preference and selected-draft changes', async () => {
    const f = fixture({ requestCost: '.6', failGeneration: true });
    await assert.rejects(reviewFollowUp(f.session, f.transport), /failure|failed|connection/i);
    assert.equal(f.stats.requests.length, 1);
    assert.equal(followUpSpend(f.session).unknownUsd, .6);
    const enlarged = resolveFollowUpSettings({ ...f.reviewSettings, followUp: { ...f.reviewSettings.followUp,
        focus: 'prose', reviewModel: 'test/custom-review', spendLimitUsd: 10 } }, f.builderSettings);
    assert.throws(() => updateSessionOptions(f.session, enlarged), /limit.*fixed/i);
    const changed = resolveFollowUpSettings({ ...f.reviewSettings, followUp: { ...f.reviewSettings.followUp,
        focus: 'prose', reviewModel: 'test/custom-review' } }, f.builderSettings);
    updateSessionOptions(f.session, changed);
    advanceSession(f.session, f.takeSnapshot());
    assert.equal(followUpSpend(f.session).limitUsd, 1);
    assert.equal(followUpSpend(f.session).unknownUsd, .6);
    await assert.rejects(reviewFollowUp(f.session, f.transport), { name: 'SpendLimitError' });
    assert.equal(f.stats.requests.length, 1, 'the same allowance stops another dispatch');
    assert.equal(f.message.mes, original);
});
