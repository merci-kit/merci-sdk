// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LoadableComponent } from '../lib/core/loadable.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { CAPABILITY, CAPABILITY_REGISTRY } from '../lib/core/constants/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { EventEmitter } from 'node:events';

class MinimalSession extends AbstractChatSession {
    constructor() { super({ provider: 'oai', model: 'm', eventEmitter: null, client: null }); }
}

// ─── base defaults (existing subclasses unaffected) ──────────────────────────

test('base hooks default to off: no announce, no per-step block', async () => {
    class Plain extends LoadableComponent {
        constructor() { super({ id: 'plain', loadToolName: 'load_plain' }); }
        async load() { return 'payload'; }
    }
    const c = new Plain();
    assert.equal(c.startupAnnounce(), null);
    assert.equal(await c.shouldInjectStep(), false);
    assert.equal(await c.stepBlock(), null);
    assert.equal(await (/** @type {any} */ (c.toLoadTool())).execute({ args: {} }), 'payload');
});

test('constructor announce is returned by startupAnnounce()', () => {
    const c = new LoadableComponent({ id: 'x', announce: 'You have X.' });
    assert.equal(c.startupAnnounce(), 'You have X.');
});

// ─── custom per-step injection ───────────────────────────────────────────────

test('subclass can gate a per-step block on shouldInjectStep', async () => {
    class Gated extends LoadableComponent {
        /**
 * @param {{items: any[]}} arg0
 */
        constructor({ items }) {
            super({ id: 'gated' });
            this.items = items;
        }
        async shouldInjectStep() { return this.items.length > 0; }
        async stepBlock() { return `Items: ${this.items.join(', ')}`; }
    }
    const empty = new Gated({ items: [] });
    assert.equal(await empty.shouldInjectStep(), false);
    const full = new Gated({ items: ['a', 'b'] });
    assert.equal(await full.shouldInjectStep(), true);
    assert.equal(await full.stepBlock(), 'Items: a, b');
});

// ─── builder _announceCapability ─────────────────────────────────────────────

test('_announceCapability prefers the component override over the registry', () => {
    const s = new MinimalSession();
    const before = s.getSystemMessage();
    s._announceCapability({ capId: CAPABILITY.MEMORY, announceOverride: 'Custom memory announce.' });
    assert.ok((/** @type {string} */ (s.getSystemMessage())).includes('Custom memory announce.'));
    assert.ok(!(/** @type {string} */ (s.getSystemMessage())).includes(CAPABILITY_REGISTRY[CAPABILITY.MEMORY].announce) || before === null);
});

test('_announceCapability falls back to the registry when no override', () => {
    const s = new MinimalSession();
    s._announceCapability({ capId: CAPABILITY.TODOS });
    assert.ok((/** @type {string} */ (s.getSystemMessage())).includes(CAPABILITY_REGISTRY[CAPABILITY.TODOS].announce));
});

// ─── Phase 2: migrated components (skills / todos / memory) ──────────────────

test('SkillsLibrary declares the registry announce and gates on preload', async () => {
    const { SkillsLibrary } = await import('../lib/tools/index.mjs');
    const lib = /** @type {any} */ (new SkillsLibrary({ skills: [{ name: 'a', description: 'A' }] }));
    assert.equal(lib.startupAnnounce(), CAPABILITY_REGISTRY[CAPABILITY.SKILLS].announce);
    assert.equal(await lib.shouldInjectStep({ preload: false }), false);
    assert.equal(await lib.shouldInjectStep({ preload: true }), true);
    assert.ok((await lib.stepBlock({ preload: true })).includes('a'));
});

test('TodoComponent declares the registry announce and gates on preload', async () => {
    const { TodoComponent } = await import('../lib/agentic/todos/component.mjs');
    const store = new Map();
    const todos = /** @type {any} */ (new TodoComponent({ store }));
    assert.equal(todos.startupAnnounce(), CAPABILITY_REGISTRY[CAPABILITY.TODOS].announce);
    assert.equal(await todos.shouldInjectStep({ preload: false }), false);
    assert.equal(await todos.shouldInjectStep({ preload: true }), true);
    assert.equal(await todos.stepBlock({ preload: true }), null, 'empty store renders nothing');
    await todos.save({ args: { action: 'add', title: 'Write tests' } });
    assert.ok((await todos.stepBlock({ preload: true })).includes('Write tests'));
});

test('MemoryComponent without a manager never injects; with one it renders + emits', async () => {
    const { MemoryComponent } = await import('../lib/agentic/memory/component.mjs');
    const bare = new MemoryComponent({ provider: { query: async () => [], store: async () => ({}) } });
    assert.equal(bare.startupAnnounce(), CAPABILITY_REGISTRY[CAPABILITY.MEMORY].announce);
    assert.equal(await bare.shouldInjectStep({ preload: true }), false);
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const seen = [];
    emitter.on(EVENTS.MEMORY.INJECTED, (e) => seen.push(e));
    const withManager = new MemoryComponent({
        provider: { query: async () => [], store: async () => ({}) },
        manager: { buildMemoryBlock: async () => ({ block: 'MEM-BLOCK', factCount: 2 }) },
        eventEmitter: emitter
    });
    assert.equal(await withManager.shouldInjectStep({ preload: false }), false);
    assert.equal(await withManager.shouldInjectStep({ preload: true }), true);
    assert.equal(await withManager.stepBlock({ preload: true, messages: [] }), 'MEM-BLOCK');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].factCount, 2);
});

test('session step blocks flow through the unified hooks (skills + todos)', async () => {
    const s = new MinimalSession();
    s.withSkills({ skills: [{ name: 'a', description: 'A' }], options: { preload: true } });
    const store = new Map();
    s.withTodos({ store, options: { preload: true } });
    await (/** @type {any} */ (s._todoComponent)).save({ args: { action: 'add', title: 'Ship it' } });
    const prepared = await s._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }], options: {} });
    const sys = /** @type {any} */ (prepared.find(m => m.type === 'system_message'));
    const tail = String(/** @type {any} */ (prepared[prepared.length - 1]).content ?? '');
    assert.ok(sys.content.includes('a'), 'skills listing injected');
    assert.ok(sys.content.includes(CAPABILITY_REGISTRY[CAPABILITY.SKILLS].announce));
    assert.ok(sys.content.includes(CAPABILITY_REGISTRY[CAPABILITY.TODOS].announce));
    // Wave 4 (4.1): the todo list is live state, so it rides a trailing row after
    // the cache breakpoint instead of the cached system row.
    assert.ok(!sys.content.includes('Ship it'), 'the volatile todo list is not in the cached system row');
    assert.ok(tail.includes('Ship it'), 'the todo list is injected as the trailing volatile block');
});

// ─── Phase 3: web components (mode gate + shared force resolver) ─────────────

test('resolveCapabilityMode pins tool on force, else delegates', async () => {
    const { resolveCapabilityMode } = await import('../lib/agentic/web-shared.mjs');
    const { resolveSearchMode } = await import('../lib/agentic/websearch/engines.mjs');
    assert.equal(resolveCapabilityMode({ resolveMode: resolveSearchMode, sessionProvider: 'openai', config: { force: true, mode: 'native' } }), 'tool');
    assert.equal(resolveCapabilityMode({ resolveMode: resolveSearchMode, sessionProvider: 'openai', config: { mode: 'native' } }), 'native');
    assert.equal(resolveCapabilityMode({ resolveMode: resolveSearchMode, sessionProvider: 'openai', config: { mode: 'off' } }), 'off');
    assert.equal(resolveCapabilityMode({ resolveMode: resolveSearchMode, sessionProvider: 'openai', config: {} }), 'off');
});

test('web components declare announces and gate step blocks on session mode', async () => {
    const { WebSearchComponent } = await import('../lib/agentic/websearch/component.mjs');
    const { WebScrapeComponent } = await import('../lib/agentic/webscrape/component.mjs');
    const search = /** @type {any} */ (new WebSearchComponent({ provider: 'openai', config: { mode: 'tavily' } }));
    const scrape = /** @type {any} */ (new WebScrapeComponent({ provider: 'openai', config: { mode: 'off' } }));
    assert.equal(search.startupAnnounce(), CAPABILITY_REGISTRY[CAPABILITY.WEB_SEARCH].announce);
    assert.equal(scrape.startupAnnounce(), CAPABILITY_REGISTRY[CAPABILITY.WEB_SCRAPE].announce);
    assert.equal(await search.shouldInjectStep({ mode: 'tavily' }), true);
    assert.equal(await search.shouldInjectStep({ mode: 'off' }), false);
    assert.equal(await scrape.shouldInjectStep({ mode: 'off' }), false);
    assert.equal(await scrape.shouldInjectStep({}), false, 'component config fallback (off)');
    assert.ok((await search.stepBlock({})).includes('web_search'));
    assert.ok((await scrape.stepBlock({ mode: 'curl' })).includes('web_scrape'));
});

test('session web blocks flow through the unified hooks (on vs off)', async () => {
    const s = new MinimalSession();
    s.withWebSearch({ options: { mode: 'tavily' } });
    s.withWebScrape({ options: { mode: 'off' } });
    const prepared = await s._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }], options: {} });
    const sys = /** @type {any} */ (prepared.find(m => m.type === 'system_message'));
    assert.ok(sys.content.includes('web_search'), 'search block injected');
    assert.ok(!sys.content.includes('web_scrape') || sys.content.includes('web scrape capability'), 'scrape data block skipped when off');
    assert.ok(sys.content.includes(CAPABILITY_REGISTRY[CAPABILITY.WEB_SEARCH].announce));
});

// ─── Phase 4: external capabilities (MCP/A2A shared cap + ACP seam) ──────────

test('capToolOutput caps with the suffix inside the limit, passes the rest through', async () => {
    const { capToolOutput, TOOL_OUTPUT_TRUNCATION_SUFFIX, DEFAULT_TOOL_OUTPUT_MAX_LENGTH } = await import('../lib/tools/external-capability.mjs');
    assert.equal(capToolOutput({ text: 'short', maxLength: 10 }), 'short');
    assert.equal(capToolOutput({ text: 42, maxLength: 10 }), 42);
    const capped = capToolOutput({ text: 'x'.repeat(DEFAULT_TOOL_OUTPUT_MAX_LENGTH + 1) });
    assert.equal(capped.length, DEFAULT_TOOL_OUTPUT_MAX_LENGTH);
    assert.ok(capped.endsWith(TOOL_OUTPUT_TRUNCATION_SUFFIX));
    const tiny = capToolOutput({ text: 'x'.repeat(100), maxLength: 40 });
    assert.equal(tiny.length, TOOL_OUTPUT_TRUNCATION_SUFFIX.length, 'sub-suffix caps still emit the full marker');
    assert.ok(tiny.endsWith(TOOL_OUTPUT_TRUNCATION_SUFFIX));
});

test('ExternalToolCapability lists tools and exposes them for sessions', async () => {
    const { ExternalToolCapability } = await import('../lib/tools/external-capability.mjs');
    const tools = [{ name: 'remote_add', description: 'Adds remotely.', parameters: {}, execute: async () => ({ success: true }) }];
    const cap = new ExternalToolCapability({ id: 'remote', loadToolName: 'load_remote_tools', tools, announce: 'Remote tools live here.' });
    assert.equal(cap.startupAnnounce(), 'Remote tools live here.');
    assert.equal(await cap.shouldInjectStep({ preload: true }), false, 'tools-first: no system dump by default');
    assert.ok((await cap.load()).includes('remote_add'));
    assert.equal(cap.toSaveTool(), null, 'no save leg');
    assert.deepEqual(cap.tools().map((t) => t.name), ['remote_add']);
});

test('AcpCapability binds a duck-typed client with capped envelopes', async () => {
    const { AcpCapability } = await import('../lib/tools/external-capability.mjs');
    const client = {
        listTools: async () => [{ name: 'acp_run', description: 'Runs it.' }],
        callTool: async (/** @type {string} */ name, /** @type {any} */ args) => ({ ran: name, with: args })
    };
    const cap = new AcpCapability({ client, maxOutputLength: 100 });
    const tools = await cap.connect();
    assert.equal(tools.length, 1);
    assert.ok((await cap.load()).includes('acp_run'));
    const ok = await (/** @type {any} */ (tools[0])).execute({ args: { q: 1 } });
    assert.equal(ok.success, true);
    assert.ok(ok.result.includes('acp_run'));
    const failing = new AcpCapability({ client: { listTools: async () => { throw new Error('down'); }, callTool: async () => { throw new Error('nope'); } } });
    assert.deepEqual(await failing.connect(), [], 'catalog failure goes soft (empty tools)');
});

test('withCapability announces, registers tools, and subscribes the step block', async () => {
    const { ExternalToolCapability } = await import('../lib/tools/external-capability.mjs');
    class Loud extends ExternalToolCapability {
        async shouldInjectStep(/** @type {any} */ ctx = {}) { return !!ctx?.preload; }
        async stepBlock() { return 'LOUD-BLOCK'; }
    }
    const s = new MinimalSession();
    const cap = new Loud({ id: 'loud', loadToolName: 'load_loud_tools', tools: [], announce: 'Loud is here.' });
    s.withCapability({ capability: cap, preload: true });
    assert.ok((/** @type {string} */ (s.getSystemMessage())).includes('Loud is here.'));
    assert.ok(s._tools.some(/** @type {(...args: any[]) => any} */ ((t) => t && t.name === 'load_loud_tools')));
    const prepared = await s._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }], options: {} });
    assert.ok((/** @type {any} */ (prepared.find((m) => m.type === 'system_message'))).content.includes('LOUD-BLOCK'));
});

test('withCapability forwards volatile and extra: the block rides the trailing row', async () => {
    // A per-step block keyed on the live conversation changes every iteration and
    // must NOT sit in the cached prefix. `withCapability` dropped both the
    // volatile flag and the extra context, so a plugin block was always cached
    // and never received its mode. See knowledge-graphs/DESIGN.md §2.2.
    class Live extends LoadableComponent {
        constructor() { super({ id: 'live', loadToolName: 'load_live' }); }
        async shouldInjectStep(/** @type {any} */ ctx = {}) { return ctx.preload === true && ctx.mode === 'per-step'; }
        async stepBlock() { return 'LIVE-STATE-MARKER'; }
    }
    const s = new MinimalSession();
    s.withCapability({ capability: new Live(), preload: true, volatile: true, extra: { mode: 'per-step' } });
    const prepared = await s._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }], options: {} });
    assert.ok(prepared.length > 1, 'extra must reach shouldInjectStep, so a block exists');
    assert.ok(!JSON.stringify(prepared.filter((m) => m.type === 'system_message')).includes('LIVE-STATE-MARKER'), 'a volatile block must not enter the cached prefix');
    assert.ok(String(prepared[prepared.length - 1]?.content ?? '').includes('LIVE-STATE-MARKER'), 'the volatile block must ride the trailing row');
});

test('withCapability without volatile keeps the block in the cached prefix', async () => {
    class Steady extends LoadableComponent {
        constructor() { super({ id: 'steady', loadToolName: 'load_steady' }); }
        async shouldInjectStep() { return true; }
        async stepBlock() { return 'STEADY-BLOCK'; }
    }
    const s = new MinimalSession();
    s.withCapability({ capability: new Steady(), preload: true });
    const prepared = await s._prepareStepMessages({ messages: [{ role: 'user', content: 'hi' }], options: {} });
    assert.ok((/** @type {any} */ (prepared.find((m) => m.type === 'system_message'))).content.includes('STEADY-BLOCK'));
});

test('_announceCapability announces once and ignores unknown caps', () => {
    const s = new MinimalSession();
    s._announceCapability({ capId: CAPABILITY.TODOS });
    const once = s.getSystemMessage();
    s._announceCapability({ capId: CAPABILITY.TODOS, announceOverride: 'Other text.' });
    assert.equal(s.getSystemMessage(), once);
    const s2 = new MinimalSession();
    const before = s2.getSystemMessage();
    s2._announceCapability({ capId: 'no_such_cap' });
    assert.equal(s2.getSystemMessage(), before);
});

test('the web-scrape barrel re-exports exactly what the component and engines declare', async () => {
    // The barrel is a runtime file in the package. Nothing imported it — so it
    // was invisible to the coverage gate and could have rotted silently. Loading
    // it here keeps it in the measured surface and pins its re-export list.
    const barrel = await import('../lib/agentic/webscrape/index.mjs');
    const component = await import('../lib/agentic/webscrape/component.mjs');
    const engines = await import('../lib/agentic/webscrape/engines.mjs');
    assert.deepEqual(
        Object.keys(barrel).sort(),
        ['WebScrapeComponent', 'TavilyExtractEngine', 'JaiScrapeEngine', 'CurlEngine', 'resolveScrapeMode', 'toUnifiedScrape'].sort(),
    );
    for (const name of Object.keys(barrel)) {
        assert.ok(name in component || name in engines, `${name} must come from the component or the engines`);
    }
});
