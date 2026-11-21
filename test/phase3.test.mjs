// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { ExecutionJournal, JOURNAL_STATUS, toolJournalKey } from '../lib/agentic/journal.mjs';
import { StateMachine } from '../lib/agentic/state-machine/index.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/** @param {{store?: any[]}} [arg0] */
function recordingClient({ store = [] } = {}) {
    return {
        session: () => {
            /** @type {any} */
            const session = /** @type {any} */ (new Proxy({ provider: 'openai', model: 'm', eventEmitter: { emit() {} }, _tools: [] }, {
                get(target, prop) {
                    if (prop === 'run') return /** @param {{initialInput: any, options: any}} arg0 */ async ({ initialInput: input, options: opts }) => { session._runOpts = opts; return isObjectiveRestatePrompt({ input }) ? '' : 'answer'; };
                    if (typeof prop === 'string' && prop.startsWith('with')) return () => session;
                    return (/** @type {any} */ (target))[prop];
                },
                set(target, prop, value) { (/** @type {any} */ (target))[prop] = value; return true; },
            }));
            store.push(session);
            return session;
        },
    };
}

describe('P3: journal durability', () => {
    it('a checkpoint round-trip restores the journal (done entries included)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-p3-'));
        try {
            const store = new LocalFileSessionStore({ dir });
            const journal = new ExecutionJournal();
            const key = toolJournalKey({ runId: journal.runId, boundary: 'b1', name: 'count', args: { n: 1 } });
            journal.begin({ key, meta: { name: 'count' } });
            journal.complete({ key, outcome: { success: true, result: 'count=1' } });

            const writer = new ChatSessionBuilder();
            writer.withSessionStore({ store, threadId: 'thread-1' }).withExecutionJournal({ journal });
            await writer.saveCheckpoint();

            const reader = new ChatSessionBuilder();
            reader.withSessionStore({ store, threadId: 'thread-1' });
            const saved = await reader.loadCheckpoint();
            assert.ok(saved, 'the checkpoint must load');
            const restored = /** @type {any} */ (reader)._journal;
            assert.ok(restored instanceof ExecutionJournal, 'the journal must be restored');
            assert.equal(restored.get({ key })?.status, JOURNAL_STATUS.DONE);
            assert.equal(restored.get({ key })?.outcome?.result, 'count=1', 'the recorded outcome is replayed on resume');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('P3: builder auto-compaction', () => {
    it('withCompaction(true) opts the session in with defaults', () => {
        const builder = new ChatSessionBuilder();
        assert.equal(/** @type {any} */ (builder)._compaction, null);
        builder.withCompaction({ options: true });
        assert.deepEqual(/** @type {any} */ (builder)._compaction, {});
    });

    it('withCompaction(options) forwards the threshold/summarizer', () => {
        const builder = new ChatSessionBuilder();
        builder.withCompaction({ options: { thresholdTokens: 1234 } });
        assert.equal(/** @type {any} */ (builder)._compaction.thresholdTokens, 1234);
    });
});

describe('P3: engine token budgets', () => {
    it('StateMachine forwards its budget to node sessions', async () => {
        /** @type {any[]} */
        const sessions = [];
        const sm = new StateMachine({ graph: {
            entry: 'a',
            nodes: [{ id: 'a', userPromptTemplate: 'do', terminal: true }],
            edges: [],
        }, options: { client: recordingClient({ store: sessions }), defaultModel: 'm', budget: { maxTotalTokens: 42 } } });
        await sm.run();
        assert.ok(sessions.length >= 1);
        assert.deepEqual(sessions[0]._runOpts?.budget, { maxTotalTokens: 42 });
    });

    it('DiscussionSession forwards its budget to agent turns', async () => {
        /** @type {any[]} */
        const sessions = [];
        const group = new DiscussionSession({ client: recordingClient({ store: sessions }), options: { budget: { maxTotalTokens: 7 } } });
        group.addAgent({ name: 'A', model: 'm', provider: 'openai', persona: 'p' });
        await group.runTasks({ tasks: [{ title: 't', description: 'd', assignee: 'A' }] });
        assert.ok(sessions.length >= 1);
        assert.deepEqual(sessions[0]._runOpts?.budget, { maxTotalTokens: 7 });
    });
});
