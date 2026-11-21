// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { SkillsLibrary } from '../lib/tools/index.mjs';
import {
    MemoryComponent,
    ProviderMemoryEngine,
    LocalFileMemoryProvider
} from '../lib/agentic/memory/index.mjs';
import { LoadableComponent } from '../lib/core/loadable.mjs';
import { isInjection } from '../lib/messaging/unified-message.mjs';
import {
    CAPABILITY,
    LOAD_SKILLS_TOOL_NAME,
    LOAD_MEMORY_TOOL_NAME,
    SAVE_MEMORY_TOOL_NAME
} from '../lib/core/constants/index.mjs';

class MinimalSession extends AbstractChatSession {
    constructor() { super({ provider: CAPABILITY ? 'oai' : 'oai', model: 'm', eventEmitter: null, client: null }); }
}

const tempFile = () => join(tmpdir(), `loadable-test-${randomBytes(6).toString('hex')}.json`);
/** @param {string} fp */
/** @param {{fp: *}} arg0 */
/** @param {{fp: *}} arg0 */
const cleanup = async ({ fp }) => { try { await fs.unlink(fp); } catch { /* ignore */ } };

// ─── SkillsLibrary (F14) ──────────────────────────────────────────────────────

test('SkillsLibrary.load surfaces name and description, never the SKILL.md body (F14)', async () => {
    const lib = new SkillsLibrary({ skills: [
        { name: 'deploy', description: 'Deploy the app', instructions: 'Run `make deploy`.' },
        { name: 'lint', description: 'Lint the code' }
    ] });
    const listing = await lib.load();
    assert.ok(listing.includes('deploy') && listing.includes('Deploy the app'));
    assert.equal(listing.includes('Run `make deploy`.'), false, 'the body is loaded only when the skill is chosen');
    assert.ok(listing.includes('lint'));
});

test('SkillsLibrary.toLoadTool() returns the listing as a tool result', async () => {
    const lib = new SkillsLibrary({ skills: [{ name: 'deploy', description: 'Deploy' }] });
    const tool = /** @type {any} */ (lib.toLoadTool());
    assert.equal(tool.name, LOAD_SKILLS_TOOL_NAME);
    const result = await tool.execute({ args: {} });
    assert.ok(result.includes('deploy'));
});

// ─── MemoryComponent + engine ──────────────────────────────────────────────────

test('MemoryComponent (default ProviderMemoryEngine) saves then loads a block', async () => {
    const fp = tempFile();
    try {
        const provider = new LocalFileMemoryProvider({ options: { filePath: fp } });
        const mc = new MemoryComponent({ provider });
        const saved = await mc.save({ args: { content: 'User prefers TypeScript.' } });
        assert.equal(saved.success, true);
        const block = await mc.load({ query: 'typescript' });
        assert.ok(block && block.includes('TypeScript'), 'load returns a block containing the saved fact');
    } finally {
        await cleanup({ fp });
    }
});

test('MemoryComponent.toLoadTool / toSaveTool expose the load_memory / save_memory tools', () => {
    const fp = tempFile();
    const mc = new MemoryComponent({ provider: new LocalFileMemoryProvider({ options: { filePath: fp } }) });
    assert.equal((/** @type {any} */ (mc.toLoadTool())).name, LOAD_MEMORY_TOOL_NAME);
    assert.equal((/** @type {any} */ (mc.toSaveTool())).name, SAVE_MEMORY_TOOL_NAME);
});

test('a custom LoadableComponent works as a standalone load surface', async () => {
    class Greeter extends LoadableComponent {
        constructor() { super({ id: 'greeter', loadToolName: 'load_greeting' }); }
        async load(/** @type {Record<string, any>} */ args = {}) { return `Hello, ${args.name || 'world'}.`; }
    }
    const g = new Greeter();
    assert.equal(await g.load({ name: 'Ada' }), 'Hello, Ada.');
    assert.equal(await (/** @type {any} */ (g.toLoadTool())).execute({ args: { name: 'Ada' } }), 'Hello, Ada.');
});

// ─── preload switch (eager) vs lazy (default) ───────────────────────────────────

test('withSkills (lazy default): registers load_skills, does NOT preload the row', async () => {
    const s = new MinimalSession();
    s.withSkills({ skills: [{ name: 'a', description: 'A' }] });
    assert.equal(s._skillsPreload, false);
    assert.ok(s._tools.some(/** @type {(...args: any[]) => any} */ (t => t && t.name === LOAD_SKILLS_TOOL_NAME)));
    const prepared = await s._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }], options: {} });
    assert.ok(!prepared.some(m => isInjection({ m, capId: CAPABILITY.SKILLS })), 'lazy mode must not seed the row');
});

test('withSkills({ preload: true }): seeds the skill listing into the system message', async () => {
    const s = new MinimalSession();
    s.withSkills({ skills: [{ name: 'a', description: 'A' }], options: { preload: true } });
    const prepared = await s._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }], options: {} });
    const sys = prepared.find(m => m.type === 'system_message');
    assert.ok(sys, 'system message must exist');
    assert.ok(String(sys.content).includes('a'), 'skill listing must be in the system message');
    const injected = prepared.filter(m => isInjection({ m, capId: CAPABILITY.SKILLS }));
    assert.equal(injected.length, 0, 'skills are in system message, not as row pairs');
});

test('withMemory (lazy default): registers load_memory/save_memory, no auto-inject', async () => {
    const fp = tempFile();
    try {
        const s = new MinimalSession();
        s.withMemory({ provider: new LocalFileMemoryProvider({ options: { filePath: fp } }) });
        assert.equal(s._memoryPreload, false);
        assert.ok(s._tools.some(/** @type {(...args: any[]) => any} */ (t => t && t.name === LOAD_MEMORY_TOOL_NAME)));
        assert.ok(s._tools.some(/** @type {(...args: any[]) => any} */ (t => t && t.name === SAVE_MEMORY_TOOL_NAME)));
        const prepared = await s._prepareStepMessages({ messages: [{ role: 'user', content: 'typescript' }], options: {} });
        assert.ok(!prepared.some(m => isInjection({ m, capId: CAPABILITY.MEMORY })), 'lazy memory must not auto-inject');
    } finally {
        await cleanup({ fp });
    }
});

test('withMemory({ preload: true }): auto-injects the memory block into the system message', async () => {
    const fp = tempFile();
    try {
        await fs.writeFile(fp, JSON.stringify({
            facts: [{ id: 'fact_1', content: 'User prefers TypeScript.', category: 'general', timestamp: 1 }],
            lastSyncedTurnIndex: 0
        }), 'utf8');
        const s = new MinimalSession();
        s.withMemory({ provider: new LocalFileMemoryProvider({ options: { filePath: fp } }), options: { preload: true } });
        const prepared = await s._prepareStepMessages({ messages: [{ role: 'user', content: 'tell me about typescript' }], options: {} });
        const sys = prepared.find(m => m.type === 'system_message');
        assert.ok(sys, 'system message must exist');
        // Wave 4 (4.1): memory is queried with the last user text, so it is live
        // state — it rides a trailing row after the cache breakpoint.
        assert.ok(!String(sys.content).includes('User prefers TypeScript.'), 'the volatile memory block is not in the cached system row');
        assert.ok(String(prepared[prepared.length - 1].content).includes('User prefers TypeScript.'), 'memory is the trailing volatile block');
        assert.ok(!prepared.some(m => isInjection({ m, capId: CAPABILITY.MEMORY })), 'it is a plain trailing row, not an injection marker');
    } finally {
        await cleanup({ fp });
    }
});

test('withMemory accepts a custom engine via options.engine', async () => {
    const s = new MinimalSession();
    const engine = { load: async () => 'X', save: async () => ({ success: true }) };
    s.withMemory({ provider: new LocalFileMemoryProvider({ options: { filePath: tempFile() } }), options: { engine } });
    assert.equal((/** @type {any} */ (s._memoryComponent)).engine, engine);
});
