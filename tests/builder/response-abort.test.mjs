import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, planJob, runJob, updatePlan } from '../../extensions/StoryBuilder/builder-core.js';

function fixture() {
    const brief = 'Carry the ledger. Arrive at the harbor.';
    const job = createJob({ latestBrief: brief, model: 'fixture/writer', messages: [{ role: 'user', content: brief }], requestTemplate: {}, contextLimit: 131072, responseLimit: 16384 }, { wordMin: 500, wordMax: 600, paragraphMin: 5, paragraphMax: 8, sectionCount: 2 });
    const transport = {
        models: [{ id: 'fixture/writer', context_length: 131072 }, { id: 'z-ai/glm-5.3', context_length: 131072 }],
        countTokens: async () => 500,
        isCurrent: () => true,
        fetcher: async () => ({ ok: true, status: 200, json: async () => { throw new DOMException('Body reading aborted.', 'AbortError'); } }),
    };
    const plan = { fixedFacts: ['The ledger stays sealed.'], requiredBeats: [{ id: 'carry', briefQuote: 'Carry the ledger.' }, { id: 'arrive', briefQuote: 'Arrive at the harbor.' }], sections: [{ id: 1, title: 'Departure', beatIds: ['carry'], startState: 'At home', endState: 'On the road' }, { id: 2, title: 'Arrival', beatIds: ['arrive'], startState: 'On the road', endState: 'At the harbor' }], finalRequirements: ['Reach the harbor.'] };
    return { job, transport, plan };
}

test('aborting while reading an outline response stays a pause', async () => {
    const { job, transport } = fixture();
    await assert.rejects(planJob(job, transport), { name: 'AbortError' });
    assert.equal(job.status, 'paused'); assert.equal(job.plan, null); assert.equal(job._busy, false);
});

test('aborting while reading a section response preserves accepted sections', async () => {
    const { job, transport, plan } = fixture(); updatePlan(job, plan);
    const accepted = { id: 1, text: 'Synthetic previously accepted section.', words: 275, paragraphs: 3 };
    job.sections.push(accepted);
    await assert.rejects(runJob(job, transport), { name: 'AbortError' });
    assert.equal(job.status, 'paused'); assert.equal(job.sections.length, 1); assert.equal(job.sections[0], accepted); assert.equal(job._busy, false);
});

test('a genuinely unreadable body remains a failure without exposing its text', async () => {
    const { job, transport } = fixture();
    transport.fetcher = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('SENSITIVE RESPONSE TEXT'); } });
    await assert.rejects(planJob(job, transport), error => error.name === 'Error' && /unreadable response/.test(error.message) && !error.message.includes('SENSITIVE'));
    assert.equal(job.status, 'failed'); assert.equal(job._busy, false);
});
