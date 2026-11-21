// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    normalizeToOAI as wireNormalizeToOAI,
    normalizeToAAI as wireNormalizeToAAI,
    normalizeToGAI as wireNormalizeToGAI,
    createToolResultMessage,
    createAssistantMessage,
    createToolCallMessage,
    createUserMessage,
} from '../lib/messaging/messages.mjs';

// This suite asserts on raw wire JSON, so it views normalized rows as open
// records; the library's own declarations stay strict.
/** @type {(arg0: {model?: string, msgs?: Array<Record<string, any>>, opts?: Object}) => Array<Record<string, any>>} */
const normalizeToOAI = wireNormalizeToOAI;
/** @type {(arg0?: {msgs?: Array<Record<string, any>>}) => {messages: Array<Record<string, any>>, system: string|Array<Record<string, any>>|null}} */
const normalizeToAAI = wireNormalizeToAAI;
/** @type {(arg0?: {msgs?: Array<Record<string, any>>, effectiveThoughtSignature?: string|null}) => {contents: Array<Record<string, any>>, systemInstruction: string|null}} */
const normalizeToGAI = wireNormalizeToGAI;import { extractAndParseJson } from '../lib/support/json.mjs';
import { compileCondition } from '../lib/agentic/state-machine/machine.mjs';
import { MemoryManager } from '../lib/agentic/memory/manager.mjs';
import { LocalFileMemoryProvider } from '../lib/agentic/memory/providers.mjs';
import { isOSeries } from '../lib/core/constants/models.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { SSEParser, TaskSSEParserV5 } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { createContextTools } from '../lib/tools/context-tools.mjs';
import { createShellTool } from '../lib/tools/shell-tools.mjs';

// ─── H1: cross-backend history reuse never 400s or drops rows ────────────────

test('H1: GAI-shaped rows convert to the OAI wire instead of leaking `parts`', () => {
    const out =  (normalizeToOAI({ model: undefined, msgs: [
        { role: 'user', parts: [{ text: 'go' }] },
        { role: 'model', parts: [{ text: 'calling' }, { functionCall: { id: 'c1', name: 'f', args: { x: 1 } } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'c1', response: { output: 'ok' } } }] },
    ] }));
    const roles = out.map(( m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool'], `foreign rows must map to native roles, got ${roles}`);
    assert.equal(out[1].tool_calls?.[0]?.function.name, 'f');
    assert.equal(out[1].parts, undefined, 'parts must never reach the OAI wire');
    assert.equal(out[2].tool_call_id, 'c1');
});

test('H1: AAI never drops GAI model rows nor empties GAI user text', () => {
    const { messages } =  (normalizeToAAI({ msgs: [
        { role: 'user', parts: [{ text: 'the prompt' }] },
        { role: 'model', parts: [{ text: 'the answer' }] },
    ] }));
    const texts = messages.flatMap(( m) => m.content).map(( b) => b.text).join('');
    assert.ok(texts.includes('the prompt'), 'GAI user text must survive (not become empty)');
    assert.ok(texts.includes('the answer'), 'GAI model rows must survive (not be dropped)');
});

test('H1: AAI content blocks map to OAI tool rows', () => {
    const out =  (normalizeToOAI({ model: undefined, msgs: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    ] }));
    assert.equal(out[0].role, 'assistant');
    assert.equal(out[0].tool_calls?.[0]?.id, 'c1');
    assert.equal(out[1].role, 'tool');
    assert.equal(out[1].tool_call_id, 'c1');
});

// ─── H2/H7: tool result message hardening ────────────────────────────────────

test('H2: an undefined tool result still produces a valid OAI tool message', () => {
    const msg =  (createToolResultMessage({ provider: ProviderType.OPENAI, result: { id: 'c1', name: 'f', success: true, result: undefined } }));
    assert.equal(typeof msg.content, 'string', 'content must be a present string (not JSON.stringify(undefined))');
});

test('H7: failed tool detail (stderr/exitCode) reaches the model on every backend', () => {
    const result = {
        id: 'c1', tool_call_id: 'c1', name: 'ls', success: false,
        error: 'Command exited with code 1',
        result: { success: false, error: 'Command exited with code 1', exitCode: 1, stderr: 'boom: no such file', stdout: '' }
    };
    const oai = /** @type {Record<string, any>} */ (createToolResultMessage({ provider: ProviderType.OPENAI, result }));
    assert.ok(oai.content.includes('boom: no such file'), `OAI lost stderr: ${oai.content}`);
    const aai = /** @type {Record<string, any>} */ (createToolResultMessage({ provider: ProviderType.ANTHROPIC, result }));
    assert.ok(aai.content[0].content.includes('boom: no such file'), `AAI lost stderr: ${aai.content[0].content}`);
    const gai = /** @type {Record<string, any>} */ (createToolResultMessage({ provider: ProviderType.GOOGLE_GENAI, result }));
    assert.ok(JSON.stringify(gai.parts[0].functionResponse.response).includes('boom: no such file'));
});

test('H2/H7: OAI passes string results through unquoted (no double-encoding)', () => {
    const msg =  (createToolResultMessage({ provider: ProviderType.OPENAI, result: { id: 'c1', name: 'f', success: true, result: 'plain' } }));
    assert.equal(msg.content, 'plain');
});

// ─── H3: AAI thinking signature re-emission ──────────────────────────────────

test('H3: an AAI tool-call turn echoes the captured thinking signature', () => {
    const { messages } =  (normalizeToAAI({ msgs: [
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }], thoughtSignature: 'sig-xyz' },
    ] }));
    const blocks = messages[0].content;
    assert.equal(blocks[0].type, 'thinking', 'the thinking block must lead the tool turn');
    assert.equal(blocks[0].thinking, '', 'the echoed thinking block is empty with the signature');
    assert.equal(blocks[0].signature, 'sig-xyz');
    assert.ok(blocks.some(/** @type {(...args: any[]) => any} */ (( b) => b.type === 'tool_use')), 'tool_use blocks follow the thinking block');
});

// ─── H4/H5: memory manager isolation + never-reject ──────────────────────────

test('H4: two managers sharing one provider keep independent checkpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-regr-'));
    const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'm.json') } });
    const managerA = new MemoryManager({ provider, options: { syncInterval: 1 } });
    const managerB = new MemoryManager({ provider, options: { syncInterval: 1 } });
    managerB.shouldSync({ messages: [{ role: 'user', content: 'hi' }] });
    const aLong = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `turn ${i}` }));
    assert.equal(managerA.shouldSync({ messages: aLong }), true, 'A must still want to sync after B advanced the shared provider');
    rmSync(dir, { recursive: true, force: true });
});

test('H5: distill never rejects when session creation fails before the try', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-regr-'));
    const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'm.json') } });
    const manager = new MemoryManager({ provider, options: { syncInterval: 1 } });
    const badClient = { session: () => { throw new Error('boom before try'); } };
    await manager.distill({ messages: [{ role: 'user', content: 'hi' }], client: badClient, modelToUse: 'm', options: {} });
    assert.ok(manager.lastDistillError, 'the pre-try failure must be funneled into lastDistillError');
    rmSync(dir, { recursive: true, force: true });
});

test('H5b: a prose-only distill output is retried fresh with a correction hint, then stored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-regr-'));
    const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'm.json') } });
    const manager = new MemoryManager({ provider, options: { syncInterval: 1 } });
    const fakeClient = {
        calls: 0,
        session() {
            const self = this;
            return {
                withSystemMessage() { return this; },
                withParameters() { return this; },
                async run() {
                    self.calls++;
                    if (self.calls === 1) {
                        return 'No new facts here — the conversation was a simple Q&A.';
                    }
                    return '```json\n{"newFacts":[{"content":"the sky is green","category":"fact","targetBanks":[]}],"obsoleteFactIds":[]}\n```';
                }
            };
        }
    };
    await manager.distill({ messages: [{ role: 'user', content: 'what color is the sky' }], client: fakeClient, modelToUse: 'm', options: {} });
    assert.equal(manager.lastDistillError, null, 'a prose-then-JSON sequence must distill successfully');
    assert.equal(fakeClient.calls, 2, 'the prose output must trigger exactly one fresh retry');
    assert.equal(provider.facts.length, 1);
    assert.equal(provider.facts[0].content, 'the sky is green');
    rmSync(dir, { recursive: true, force: true });
});

test('H5c: the persisted checkpoint advances after a restart distill (delta re-distilled safely)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-regr-'));
    const filePath = join(dir, 'm.json');
    writeFileSync(filePath, JSON.stringify({ facts: [], lastSyncedTurnIndex: 2 }), 'utf8');
    const provider = new LocalFileMemoryProvider({ options: { filePath } });
    const manager = new MemoryManager({ provider, options: { syncInterval: 1 } });
    let lastPrompt = '';
    const fakeClient = {
        session() {
            return {
                withSystemMessage() { return this; },
                withParameters() { return this; },
                /** @param {{initialInput: *}} arg0 */
                async run({ initialInput: prompt }) {
                    lastPrompt = prompt;
                    return '{"newFacts":[{"content":"turn 3 fact","category":"fact","targetBanks":[]}],"obsoleteFactIds":[]}';
                }
            };
        }
    };
    const turns = Array.from({ length: 4 }, (_, i) => ({ role: 'user', content: `turn ${i}` }));
    await manager.distill({ messages: turns, client: fakeClient, modelToUse: 'm', options: {} });
    assert.equal(manager.lastDistillError, null);
    assert.ok(lastPrompt.includes('"turn 3"'), 'the fresh session distills its own turns');
    assert.deepEqual(provider.facts.map(f => f.content), ['turn 3 fact']);
    const reloaded = new LocalFileMemoryProvider({ options: { filePath } });
    await reloaded.load();
    assert.equal(reloaded.lastSyncedTurnIndex, 4, 'the persisted checkpoint must advance past the distilled turns');
    assert.equal(manager.shouldSync({ messages: turns }), false, 'nothing new to distill');
    assert.equal(manager.shouldSync({ messages: [...turns, { role: 'user', content: 'turn 4' }] }), true);
    rmSync(dir, { recursive: true, force: true });
});

test('H5d: a failed save() during distill restores the staged checkpoint and the delta is recovered on retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-regr-'));
    const filePath = join(dir, 'm.json');
    writeFileSync(filePath, JSON.stringify({ facts: [], lastSyncedTurnIndex: 2 }), 'utf8');
    const provider = new LocalFileMemoryProvider({ options: { filePath } });
    const manager = new MemoryManager({ provider, options: { syncInterval: 1 } });
    let saveCalls = 0;
    const origSave = provider.save.bind(provider);
    provider.save = async () => {
        saveCalls++;
        // One save per distill batch (deferSave), so the batch write is the
        // first call and the one that must fail here.
        if (saveCalls === 1) throw new Error('disk full');
        return origSave();
    };
    const fakeClient = {
        session() {
            return {
                withSystemMessage() { return this; },
                withParameters() { return this; },
                async run() {
                    return '{"newFacts":[{"content":"turn 3 fact","category":"fact","targetBanks":[]}],"obsoleteFactIds":[]}';
                }
            };
        }
    };
    const turns = Array.from({ length: 4 }, (_, i) => ({ role: 'user', content: `turn ${i}` }));
    await manager.distill({ messages: turns, client: fakeClient, modelToUse: 'm', options: {} });
    assert.ok(manager.lastDistillError, 'a failed checkpoint save must surface via the distill error channel');
    assert.equal(provider.lastSyncedTurnIndex, 2, 'the staged checkpoint must be restored — a fresh manager must not seed past a failed write');
    provider.save = origSave;
    manager.lastDistillError = null;
    await manager.distill({ messages: turns, client: fakeClient, modelToUse: 'm', options: {} });
    assert.equal(manager.lastDistillError, null, 'a retry after the disk recovers must distill successfully');
    const reloaded = new LocalFileMemoryProvider({ options: { filePath } });
    await reloaded.load();
    assert.equal(reloaded.lastSyncedTurnIndex, 4, 'the recovered run must persist the advanced checkpoint');
    rmSync(dir, { recursive: true, force: true });
});

// ─── T1: DeepSeek reasoning_content continuity ───────────────────────────────

test('T1: reasoning_content persists on the assistant message and re-emits to OAI', () => {
    const msg =  (createAssistantMessage({ provider: ProviderType.OPENAI, content: 'the answer', thoughtSignature: null, reasoningContent: 'chain of thought' }));
    assert.equal(msg.reasoning_content, 'chain of thought');
    const out =  (normalizeToOAI({ model: undefined, msgs: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'the answer', reasoning_content: 'chain of thought' },
    ] }));
    assert.equal(out[1].reasoning_content, 'chain of thought', 'the reasoning must ride back to the reasoner');
});

// ─── P1/P2: malformed AAI tool args surface as errors, never silent {} ───────

test('P1: a malformed <tool_call> argument is passed raw so executeTools reports it', async () => {
    const calls = [{ id: 'c1', name: 'f', arguments: '{oops' }];
    const library = [{ name: 'f', parameters: { type: 'object', properties: {} }, execute: () => 'should-not-run' }];
    const results =  (await executeTools({ toolCalls: calls, toolLibrary: library }));
    assert.equal(/** @type {any} */ (results[0]).success, false);
    assert.ok(/** @type {any} */ (results[0]).error.includes('Invalid tool arguments'));
});

test('P2: malformed native AAI input_json becomes an error result, not empty args', async () => {
    const calls = [{ id: 'c1', name: 'f', input: '{bad json' }];
    const library = [{ name: 'f', parameters: { type: 'object', properties: {} }, execute: () => 'should-not-run' }];
    const results =  (await executeTools({ toolCalls: calls, toolLibrary: library }));
    assert.equal(/** @type {any} */ (results[0]).success, false);
    assert.ok(/** @type {any} */ (results[0]).error.includes('Invalid tool arguments'));
});

// ─── P3/P4: JAI SSE hardening ────────────────────────────────────────────────

test('P3: a `data: null` heartbeat no longer kills the SSE stream', () => {
    const parser = new SSEParser();
    assert.equal(parser.parseLine({ line: 'data: null' }), null);
    assert.equal(( (/** @type {any} */ (parser.parseLine({ line: 'data: {"type":"Content","content":"hi"}' })))).content, 'hi');
});

test('P3: Task V5 parser survives a null heartbeat too', () => {
    const parser = new TaskSSEParserV5();
    assert.equal(parser.parseLine({ line: 'data: null' }), null);
});

test('P4: a later chunk of a parallel call that omits the index still lands on its call', () => {
    const parser = new SSEParser();
    parser.parseLine({ line: 'data: {"type":"ToolCall","parallelToolIndex":1,"id":"call_b","name":"fb","content":"{\\"x\\":1}"}' });
    parser.parseLine({ line: 'data: {"type":"ToolCall","id":"call_b","content":",\\"y\\":2}"}' });
    parser.parseLine({ line: 'data: {"type":"FinishMetadata","reason":"tool_calls"}' });
    const { toolCalls } =  (parser.getFinalResult());
    assert.equal(toolCalls.length, 1, `exactly one call, got ${JSON.stringify(toolCalls)}`);
    assert.equal(toolCalls[0].id, 'call_b');
    assert.equal(toolCalls[0].name, 'fb');
    assert.equal(toolCalls[0].arguments, '{"x":1},"y":2}');
});

// ─── A3: judge verdict without a score is not accepted ───────────────────────

test('A3: a {passed:true} verdict with a missing score is rejected by conclude', async () => {
    const client = {
        session: /** @type {(...args: any[]) => any} */ (( model) => {
            let n = 0;
            return {
                withSystemMessage() { return this; },
                withTools() { return this; },
                withTodos() { return this; },
                withParameters() { return this; },
                /** @param {{initialInput: *, options: *}} arg0 */
                async run({ initialInput: input, options: opts }) {
                    const sys =  (this).sys || '';
                    if (sys.includes('quality evaluator')) return JSON.stringify({ passed: true, reason: 'looks good', revision: 'minor' });
                    if (sys.includes('synthesize diverse inputs')) return 'FINAL';
                    return `answer ${++n}`;
                },
            };
        }),
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', model: 'm', provider: ProviderType.OPENAI });
    const final =  (await group.conclude({ instruction: 'topic', options: { maxRounds: 1 } }));
    assert.equal(/** @type {any} */ (final).accepted, false, 'passed:true without a score must not sail through the minScore gate');
});

// ─── P9: exact-bracket JSON extraction ───────────────────────────────────────

test('P9: extractAndParseJson stops at the MATCHING close, not the last one', () => {
    const text = 'Answer: {"a": 1, "b": {"c": 2}} and then "unrelated } brace" after';
    const parsed =  (extractAndParseJson({ input: text }));
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data, { a: 1, b: { c: 2 } });
});

test('P9: braces inside JSON strings never miscount', () => {
    const parsed =  (extractAndParseJson({ input: '{"url": "https://x.com/{id}", "n": 3} done' }));
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data, { url: 'https://x.com/{id}', n: 3 });
});

// ─── T2: o-series / gpt-5 detection ──────────────────────────────────────────

test('T2: isOSeries covers o4 and gpt-5 families', () => {
    assert.equal(isOSeries({ model: 'o4-mini' }), true);
    assert.equal(isOSeries({ model: 'gpt-5' }), true);
    assert.equal(isOSeries({ model: 'gpt-5.1' }), true);
    assert.equal(isOSeries({ model: 'gpt-4o' }), false);
});

// ─── C1-context: symlink escape blocked in the read tool ─────────────────────

test('C1: read refuses a symlink that resolves outside the workspace root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-regr-'));
    const outside = mkdtempSync(join(tmpdir(), 'merci-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'do not read');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));
    const [readTool] =  (createContextTools({ options: { root: dir } }));
    await assert.rejects(() => readTool.execute({ args: { filePath: 'link.txt' } }), /outside the workspace root/);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

test('C2: a negative read offset clamps instead of crashing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-regr-'));
    const file = join(dir, 'ten.txt');
    writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n'));
    const [readTool] =  (createContextTools({ options: { root: dir } }));
    const out = await readTool.execute({ args: { filePath: 'ten.txt', offset: -5, limit: 3 } });
    assert.ok(out.includes('line0'), `clamped read must start at line 1, got: ${out}`);
    rmSync(dir, { recursive: true, force: true });
});

// ─── Tool-call grouping preserves ALL assistant text ─────────────────────────

test('grouped OAI tool-call rows keep every row\'s text (not just the first)', () => {
    const out =  (normalizeToOAI({ model: undefined, msgs: [
        { role: 'assistant', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'f', arguments: '{}' } }], content: 'first' },
        { role: 'assistant', tool_calls: [{ id: 'a2', type: 'function', function: { name: 'g', arguments: '{}' } }], content: 'second' },
        { role: 'tool', tool_call_id: 'a1', content: 'r1' },
        { role: 'tool', tool_call_id: 'a2', content: 'r2' },
    ] }));
    const assistant = /** @type {Record<string, any>} */ (out.find(( m) => m.role === 'assistant'));
    assert.ok(assistant.content.includes('first') && assistant.content.includes('second'),
        `both assistant texts must survive grouping, got: ${assistant.content}`);
});

// ─── Round-2 fixes from the blind verification loop ──────────────────────────

test('R2: DeepSeek reasoning_content survives a grouped tool-call turn', () => {
    const out =  (normalizeToOAI({ model: undefined, msgs: [
        { role: 'assistant', content: 'reasoning here', reasoning_content: 'chain of thought', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ] }));
    assert.equal(out[0].reasoning_content, 'chain of thought', 'reasoning must ride through tool rounds');
});

test('R2: GAI functionCall parts keep their per-part thought signature on the wire', () => {
    const { contents } =  (normalizeToGAI({ msgs: [
        { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'f', args: {} }, thoughtSignature: 'sig-a' }] },
        { role: 'model', parts: [{ functionCall: { id: 'c2', name: 'g', args: {} }, thoughtSignature: 'sig-b' }] },
    ] }));
    const sigs = contents[0].parts.filter((/** @type {Record<string, any>} */ p) => p.functionCall).map((/** @type {Record<string, any>} */ p) => p.thoughtSignature);
    assert.deepEqual(sigs, ['sig-a', 'sig-b'], 'per-call signatures must survive the merge');
});

test('R2: a turn-level GAI thought signature is re-attached to functionCall parts', () => {
    const { contents } =  (normalizeToGAI({ msgs: [
        { role: 'assistant', thoughtSignature: 'turn-sig', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ], effectiveThoughtSignature: 'turn-sig' }));
    assert.equal(contents[0].parts[0].thoughtSignature, 'turn-sig');
});

test('R2: AAI-sourced tool rows carry the tool name on the OAI wire', () => {
    const out =  (normalizeToOAI({ model: undefined, msgs: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', name: 'my_tool', content: 'ok' }] },
    ] }));
    assert.equal(out[0].role, 'tool');
    assert.equal(out[0].name, 'my_tool');
});

test('R2: a big command output is a truncated SUCCESS, not a fake failure', async () => {
    const tool =  (createShellTool({ options: { approvalCallback: async () => true, maxOutputLength: 4000 } }));
    const res =  (await tool.execute({ args: { command: 'python3', args: ['-c', "print('x' * 20000)"] } }));
    assert.equal(res.success, true, `a >16KB output must not become a failure: ${JSON.stringify(res).slice(0, 120)}`);
    assert.ok(res.stdout.length > 0, 'partial output is still returned');
});

test('R2: read/grep/glob never follow a workspace symlink outside the root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-regr-'));
    const outside = mkdtempSync(join(tmpdir(), 'merci-out-'));
    mkdirSync(join(outside, 'sub'));
    writeFileSync(join(outside, 'sub', 'secret.txt'), 'TOP SECRET TOKEN');
    symlinkSync(join(outside, 'sub'), join(dir, 'linkdir'));
    const [readTool, grepTool, globTool] =  (createContextTools({ options: { root: dir } }));
    await assert.rejects(() => grepTool.execute({ args: { pattern: 'SECRET', path: 'linkdir' } }), /outside the workspace root|No files found/);
    await assert.rejects(() => globTool.execute({ args: { pattern: '**', path: 'linkdir' } }), /outside the workspace root|No files found/);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

// ─── Round-3 fixes (second verification loop) ────────────────────────────────

test('R3: circular StateContext state serializes instead of throwing', async () => {
    const { StateContext } = await import('../lib/agentic/state-machine/context.mjs');
    const ctx = new StateContext();
    ctx.set({ k: 'self', v: ctx });
    assert.doesNotThrow(() => ctx.toPayloadString());
    assert.ok(ctx.toPayloadString().includes('[circular]'));
});

test('R3: AAI thinking-only rows map to OAI text instead of leaking thinking blocks', () => {
    const out =  (normalizeToOAI({ model: undefined, msgs: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'answer' }] },
    ] }));
    assert.equal(out[0].role, 'assistant');
    assert.ok(out[0].content.includes('answer'), 'the text survives');
    assert.ok(!JSON.stringify(out).includes('type:"thinking"'), 'thinking blocks must never reach the OpenAI wire');
});

test('R3: a failed A2A-side check (glob no-match) returns No files found, not an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-regr-'));
    const [, , globTool] =  (createContextTools({ options: { root: dir } }));
    const out = await globTool.execute({ args: { pattern: 'does-not-exist-*' } });
    assert.match(out, /No files found/);
    rmSync(dir, { recursive: true, force: true });
});
