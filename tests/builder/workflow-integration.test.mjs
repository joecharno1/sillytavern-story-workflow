import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, assembledStory } from '../../extensions/StoryBuilder/builder-core.js';
import { runEditorialWorkflow } from '../../extensions/StoryBuilder/editorial-workflow.js';
import { makeSnapshot, isSnapshotCurrent, applyResult } from '../../extensions/StoryBuilder/st-bridge.js';
import { createAcceptedTarget, refreshAcceptedTrackers } from '../../extensions/StoryBuilder/tracker-bridge.js';
import * as editorialServices from '../../extensions/StoryReview/workflow-review.js';

function fixture(mode = 'success') {
    const latestBrief = 'SYNTHETIC COMPLETE BRIEF: Mara carries a brass compass. Preserve every established event and finish at the river. END OF COMPLETE BRIEF.';
    const writingSettings = { chat_completion_source: 'openrouter', openrouter_model: 'test/writer', reasoning_effort: 'high' };
    const chat = [
        { name: 'Author', is_user: true, mes: latestBrief, extra: {} },
        { name: 'Narrator', is_user: false, mes: 'Earlier story reply stays available.', extra: { reasoning: 'Earlier synthetic planning.' } },
    ];
    const stats = { saves: 0, renders: 0, commands: [], requests: [], requested: 0, usage: [] };
    const context = {
        chat, characterId: 0, groupId: null, name1: 'Author', name2: 'Narrator',
        characters: [{ name: 'Narrator', avatar: 'synthetic.png', description: 'A synthetic narrator.', data: {} }],
        chatMetadata: { variables: {} }, extensionPrompts: {}, getCurrentChatId: () => 'integration-synthetic-chat',
        saveChat: async () => { stats.saves++; },
        updateMessageBlock: () => { stats.renders++; }, refreshSwipeButtons: () => {},
        executeSlashCommandsWithOptions: async (command, options) => {
            assert.equal(stats.saves, 1, 'the final story must already be saved');
            assert.equal(context.chat.at(-1).mes, job.editorial.text, 'memory sees only the accepted final story');
            assert.equal(context.chat.at(-1).swipes.at(-2), original, 'the original draft remains available');
            stats.commands.push({ command, options, text: context.chat.at(-1).mes });
            return { pipe: 'true' };
        },
    };
    const dependencies = { getContext: () => context, getSettings: () => writingSettings,
        isGenerating: () => false, getTimestamp: () => '2026-11-11T12:00:00Z' };
    const source = {
        snapshot: makeSnapshot(context, writingSettings), latestBrief, model: 'test/writer',
        contextLimit: 131072, responseLimit: 16384,
        messages: [
            { role: 'system', content: 'Synthetic full preset. Keep {{unchanged-marker}} and all original instructions intact.' },
            { role: 'assistant', content: 'Synthetic earlier accepted reference: the compass is brass and the river lies east.' },
            { role: 'user', content: latestBrief },
        ],
        requestTemplate: { secret_id: 'synthetic-reference-only', reasoning_effort: 'high' },
    };
    const paragraphs = Array.from({ length: 10 }, (_, index) => Array(7).fill(
        `Mara carried the ${index === 2 ? 'bronze' : 'brass'} compass past marker${index + 1} beside the river.`,
    ).join(' '));
    const job = createJob(source, { wordMin: 600, wordMax: 800, paragraphMin: 10, paragraphMax: 10,
        sectionCount: 2, strictParagraphs: true, editorialEnabled: true, reviewerModel: 'test/editor' });
    job.sections = [
        { text: paragraphs.slice(0, 5).join('\n\n'), reasoning: 'First synthetic writer planning.' },
        { text: paragraphs.slice(5).join('\n\n'), reasoning: 'Second synthetic writer planning.' },
    ];
    job.status = 'complete';
    const original = assembledStory(job);
    const sourceMessages = structuredClone(source.messages);
    const transport = {
        models: [{ id: 'test/editor', context_length: 131072, top_provider: { max_completion_tokens: 16384 } }],
        countTokens: async () => 2000,
        assertCurrent: async () => isSnapshotCurrent(context, source.snapshot, writingSettings),
        isCurrent: async snapshot => isSnapshotCurrent(context, snapshot, writingSettings),
        onRequest: async () => { stats.requested++; },
        onUsage: async usage => { stats.usage.push(usage); },
        fetcher: async (url, options) => {
            assert.equal(url, '/api/backends/chat-completions/generate');
            const body = JSON.parse(options.body), payload = JSON.parse(body.messages[1].content);
            assert.equal(payload.latestBrief, latestBrief, 'each real service request carries the complete latest brief');
            const restoredMessages = payload.sourceMessages.map(message => ({ ...message, content: message.role === 'user'
                ? message.content.replaceAll('[The complete author brief is supplied in latestBrief in this same request.]', payload.latestBrief)
                : message.content }));
            assert.deepEqual(restoredMessages, sourceMessages, 'only the exact duplicate brief is replaced by its complete same-request reference');
            assert.equal(body.secret_id, 'synthetic-reference-only');
            assert.equal(body.model, 'test/editor');
            assert.equal(body.middleout, 'off');
            assert.equal(payload.draft.length, 10);
            stats.requests.push({ body, payload });
            if (mode === 'failed' && payload.focus === 'continuity') {
                return { ok: false, status: 503, json: async () => ({ error: { code: 503 } }) };
            }
            let content;
            if (payload.selectedParagraphs) {
                assert.deepEqual(payload.selectedParagraphs, [3]);
                assert.match(payload.revisionInstruction, /local corrections/);
                content = payload.draft[2].text.replaceAll('bronze', 'brass');
            } else {
                const hasProblem = payload.focus === 'continuity' && payload.draft[2].text.includes('bronze');
                content = JSON.stringify({ summary: 'Synthetic editorial report.', strengths: ['Clear river setting.'], issues: hasProblem ? [{
                    severity: 'high', category: 'continuity', paragraphs: [3],
                    problem: 'Paragraph three changes the established compass material to bronze.',
                    suggestion: 'Restore brass in paragraph three while preserving the passage.',
                }] : [] });
            }
            return { ok: true, status: 200, json: async () => {
                if (mode === 'stale' && payload.focus === 'continuity') context.chat[0].mes += ' A new author edit.';
                return { choices: [{ message: { content }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 2000, completion_tokens: 100, cost: 0.001 } };
            } };
        },
    };
    const runReview = () => runEditorialWorkflow(job, editorialServices, transport,
        { settings: { model: 'test/editor', maxOutput: 4096 }, maxCycles: 2 });
    const acceptFinal = async () => {
        const state = job.editorial;
        assert.equal(state.status, 'ready');
        assert.equal(state.passed, true);
        const result = await applyResult(source.snapshot, state.text, { dependencies, model: 'test/writer',
            originalDraft: state.originalText, workflow: { editorial: true, changes: state.changes.length } });
        const target = createAcceptedTarget(context, result, state.text);
        const refresh = await refreshAcceptedTrackers(target, { getContext: () => context });
        return { result, refresh };
    };
    return { job, original, sourceMessages, context, stats, runReview, acceptFinal };
}

test('actual editorial services integrate with safe swipe application and explicit final-only memory refresh', async () => {
    const f = fixture(), originalSections = structuredClone(f.job.sections), oldReply = f.context.chat.at(-1).mes;
    const state = await f.runReview();
    assert.equal(state.status, 'ready');
    assert.equal(state.analysis.words, 700);
    assert.equal(state.analysis.paragraphs, 10);
    assert.equal(state.changes.length, 1);
    assert.deepEqual(state.targetChecks, { wordTargetMet: true, paragraphTargetMet: true, formatValid: true });
    assert.deepEqual(f.stats.requests.map(request => request.payload.focus || 'revision'), ['continuity', 'prose', 'revision', 'continuity', 'prose']);
    assert.equal(f.stats.requested, 5);
    assert.equal(f.stats.usage.length, 5);
    assert.equal(f.stats.saves, 0, 'reviewing never applies a draft');
    assert.equal(f.stats.commands.length, 0, 'reviewing never refreshes memory');
    assert.equal(f.context.chat.at(-1).mes, oldReply);
    assert.deepEqual(f.job.sections, originalSections);
    assert.deepEqual(f.job.source.messages, f.sourceMessages);
    assert.equal(state.originalText, f.original);
    assert.equal(state.text, f.original.replaceAll('bronze', 'brass'));

    const { result, refresh } = await f.acceptFinal();
    const accepted = f.context.chat.at(-1);
    assert.deepEqual(accepted.swipes, [oldReply, f.original, state.text]);
    assert.equal(accepted.mes, state.text);
    assert.equal(accepted.swipe_id, 2);
    assert.equal(accepted.swipe_info[0].extra.reasoning, 'Earlier synthetic planning.');
    assert.equal(accepted.swipe_info[1].extra.storyWorkflow.draftBeforeRevision, true);
    assert.equal(result.rendered, true);
    assert.equal(f.stats.saves, 1);
    assert.equal(f.stats.renders, 1);
    assert.deepEqual(f.stats.commands.map(call => call.command), ['/ztracker-generate module=scene-tracker 1', '/ztracker-generate module=plot-log 1']);
    assert.ok(f.stats.commands.every(call => call.text === state.text));
    assert.deepEqual(refresh, { complete: true, completedModules: ['scene-tracker', 'plot-log'] });
});

test('an actual provider review failure preserves the completed draft and never reaches apply or memory', async () => {
    const f = fixture('failed'), oldReply = f.context.chat.at(-1).mes;
    await assert.rejects((async () => { await f.runReview(); await f.acceptFinal(); })(), /editorial request failed \(503\)/);
    assert.equal(f.job.editorial.status, 'failed');
    assert.equal(f.job.editorial.text, f.original);
    assert.equal(f.job.status, 'complete');
    assert.equal(f.context.chat.at(-1).mes, oldReply);
    assert.equal(f.stats.saves, 0);
    assert.equal(f.stats.commands.length, 0);
    assert.equal(f.stats.requests.filter(request => request.payload.selectedParagraphs).length, 0);
});

test('a source edit during an actual review response blocks revisions, application, and memory refresh', async () => {
    const f = fixture('stale'), oldReply = f.context.chat.at(-1).mes;
    await assert.rejects((async () => { await f.runReview(); await f.acceptFinal(); })(), /source.*changed/i);
    assert.equal(f.job.editorial.status, 'failed');
    assert.equal(f.job.editorial.text, f.original);
    assert.equal(f.context.chat.at(-1).mes, oldReply);
    assert.match(f.context.chat[0].mes, /A new author edit\.$/);
    assert.equal(f.stats.saves, 0);
    assert.equal(f.stats.commands.length, 0);
    assert.equal(f.stats.requests.filter(request => request.payload.selectedParagraphs).length, 0);
});
