// @ts-check


/**
 * @file F2-6: a workspace whose `afterCreate` never finished is finished on reuse.
 * @version 0.12.0
 *
 * @description
 * `afterCreate` ran only when this call created the directory, so a crash
 * during the hook (or a failed cleanup) left a partial directory that every
 * later attempt reused uninitialised. The owner marker records `ready: true`
 * only after the hook succeeded; a reuse without it re-runs the hook and says
 * so in the `workspace:reused` payload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceManager } from '../lib/agentic/workspace/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/**
 * @param {{path: string}} arg0 -
 * @returns {Promise<boolean>}
 */
async function exists({ path }) {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

test('F2-6 a half-created workspace re-runs afterCreate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-workspace-ready-'));
    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    /** A hook that marks the workspace it initialised, relative to its cwd. */
    const manager = new WorkspaceManager({
        root,
        hooks: { afterCreate: 'printf "ran\\n" >> .ready' },
        eventEmitter: { emit: (name, payload) => { events.push({ event: name, ...payload }); } }
    });
    try {
        // What a process killed mid-hook leaves behind: the directory, no marker.
        const path = manager.pathFor({ workItemId: 'MER-HALF-1' });
        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'partial-clone'), 'half\n');

        const workspace = await manager.ensure({ workItemId: 'MER-HALF-1', identifier: 'MER-HALF-1' });
        assert.equal(workspace.createdNow, false, 'the directory existed');
        assert.equal(await exists({ path: join(path, '.ready') }), true,
            'the unfinished hook ran again');
        assert.equal(await exists({ path: join(path, 'partial-clone') }), true,
            'a reuse keeps the directory; only the hook is re-run');

        const reused = events.filter((envelope) => envelope.event === EVENTS.WORKSPACE.REUSED);
        assert.equal(reused.length, 1);
        assert.equal(reused[0].hooksRun, 'recovered',
            'the payload says the setup was recovered, not skipped');

        const marker = JSON.parse(await readFile(join(root, `${workspace.key}.merci-owner.json`), 'utf8'));
        assert.equal(marker.ready, true);

        // A ready workspace reuses without running the hook a third time.
        const again = await manager.ensure({ workItemId: 'MER-HALF-1', identifier: 'MER-HALF-1' });
        assert.equal(again.createdNow, false);
        const later = events.filter((envelope) => envelope.event === EVENTS.WORKSPACE.REUSED);
        assert.equal(later.length, 2);
        assert.equal(later[1].hooksRun, undefined, 'a ready reuse runs no hook');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
