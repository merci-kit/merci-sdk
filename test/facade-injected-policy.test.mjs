// @ts-check


/**
 * @file F1-6: an injected policy stays the host's.
 * @version 0.12.0
 *
 * @description
 * The facade points an injected policy at its own emitter so the ring sees
 * `workflow_policy:*`. That takeover is temporary: a rejected construction must
 * not stop a policy it did not create, and `stop()` must hand the emitter back
 * so the host's own subscriber keeps receiving reloads from a policy the host
 * started.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOrchestration } from '../lib/agentic/orchestration/facade.mjs';
import { WorkflowPolicy } from '../lib/agentic/workflow-policy/index.mjs';
import { createMemoryWorkSource } from '../lib/agentic/scheduler/index.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/**
 * @param {{root: string, prompt?: string}} arg0 -
 * @returns {string}
 */
function workflowFile({ root, prompt = 'Work on {{ issue.identifier }}.' }) {
    return [
        '---',
        'tracker:',
        '  kind: memory',
        '  active_states: [Todo]',
        '  terminal_states: [Done]',
        'polling:',
        '  interval_ms: 30000',
        'workspace:',
        `  root: ${JSON.stringify(root)}`,
        '---',
        prompt
    ].join('\n');
}

/**
 * A client whose sessions are never run: the failure happens before one is used.
 * @returns {{session: (model: string) => unknown}}
 */
function createClient() {
    return {
        session: () => {
            /** @type {Record<string, unknown>} */
            const session = {
                withSessionStore: () => session,
                withExecutionJournal: () => session,
                withTools: () => session,
                withBudget: () => session,
                withApproval: () => session,
                loadCheckpoint: async () => null,
                run: async () => 'done'
            };
            return session;
        }
    };
}

/**
 * @returns {Promise<{dir: string, file: string, root: string, cleanup: () => Promise<void>}>}
 */
async function createRepo() {
    const dir = await mkdtemp(join(tmpdir(), 'merci-facade-injected-'));
    const file = join(dir, 'WORKFLOW.md');
    const root = join(dir, 'workspaces');
    await writeFile(file, workflowFile({ root }));
    return {
        dir,
        file,
        root,
        cleanup: async () => { await rm(dir, { recursive: true, force: true }); }
    };
}

test('W1-5 a failed construction stops the policy the facade started', async () => {
    const repo = await createRepo();
    // The default is `watch: true`: a policy left running after the rejection
    // keeps a live filesystem watcher, which is exactly the leak this closes.
    const policy = new WorkflowPolicy({ path: repo.file, watch: true });
    try {
        await assert.rejects(() => createOrchestration({
            client: createClient(),
            model: 'gpt-4o',
            workSource: createMemoryWorkSource({ items: [] }),
            policy,
            // A post-start construction failure: the runner refuses the engine.
            engine: 'not-an-engine',
            emitter: new MerciEventEmitter()
        }));

        assert.equal(policy.snapshot().started, true, 'the facade had started it');
        assert.equal(policy.snapshot().stopped, true, 'the facade started it, so the facade stops it');
        assert.equal(policy.snapshot().watch, 'stopped', 'no watcher is left behind');
        assert.deepEqual(policy.preflight(), ['stopped']);
    } finally {
        policy.stop();
        await repo.cleanup();
    }
});

test('W1-5 a host-started policy survives a rejected construction', async () => {
    const repo = await createRepo();
    const policy = new WorkflowPolicy({ path: repo.file, watch: true });
    await policy.start();
    try {
        await assert.rejects(() => createOrchestration({
            client: createClient(),
            model: 'gpt-4o',
            workSource: createMemoryWorkSource({ items: [] }),
            policy,
            engine: 'not-an-engine',
            emitter: new MerciEventEmitter()
        }));

        assert.equal(policy.snapshot().stopped, false, 'the host started it, so it is left running');
        assert.deepEqual(policy.preflight(), [], 'and it is still healthy');
        const reloaded = await policy.reload();
        assert.equal(reloaded.healthy, true, 'the host can still reload it');
    } finally {
        policy.stop();
        await repo.cleanup();
    }
});

test('F1-6 the host emitter keeps receiving reloads', async () => {
    const repo = await createRepo();
    const hostEmitter = new MerciEventEmitter();
    /** @type {Array<Record<string, unknown>>} */
    const hostEvents = [];
    hostEmitter.onAny((/** @type {Record<string, unknown>} */ envelope) => hostEvents.push(envelope));
    const policy = new WorkflowPolicy({ path: repo.file, watch: false, eventEmitter: hostEmitter });
    await policy.start();
    const facadeEmitter = new MerciEventEmitter();

    const orchestration = await createOrchestration({
        client: createClient(),
        model: 'gpt-4o',
        workSource: createMemoryWorkSource({ items: [] }),
        policy,
        emitter: facadeEmitter
    });
    try {
        await orchestration.start();
    } finally {
        await orchestration.stop();
    }

    assert.equal(policy.snapshot().stopped, false, 'stop() did not stop the host-started policy');
    assert.equal(policy.eventEmitter, hostEmitter, 'and the host emitter was restored');
    await writeFile(repo.file, workflowFile({ root: repo.root, prompt: 'The new prompt.' }));
    const reloaded = await policy.reload();
    assert.equal(reloaded.healthy, true);
    const seen = hostEvents.filter((envelope) => envelope.event === EVENTS.WORKFLOW_POLICY.RELOADED);
    assert.equal(seen.length, 1, 'the host subscriber still sees the reload');
    policy.stop();
    await repo.cleanup();
});
