// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShellTool } from '../lib/tools/shell-tools.mjs';
import { formatFactBullets } from '../lib/agentic/memory/providers.mjs';
import { LocalFileMemoryProvider } from '../lib/agentic/memory/providers.mjs';

// ─── schema enforcement no longer mutates the caller's object ────────────────

test('strict-schema enforcement does not mutate the caller schema', async () => {
    const { oaiAdapter } = await import('../lib/backends/adapters/oai-adapter.mjs');
    const schema = {
        type: 'object',
        properties: { a: { type: 'object', properties: { b: { type: 'string' } } } }
    };
    const snapshot = JSON.stringify(schema);
    /** @type {any} */ (oaiAdapter).buildVendorRequest({
        model: 'gpt-4o',
        parameters: { response_format: { type: 'json_schema', name: 'x', json_schema: { schema } } },
        tools: [], preparedMessages: [], forceTextResponse: false,
        toolChoiceRequired: false, thoughtSignature: null, session: { provider: 'openai', protocol: 'responses' }
    });
    const body = /** @type {any} */ (oaiAdapter).buildVendorRequest({
        model: 'gpt-4o',
        parameters: { response_format: { type: 'json_schema', name: 'x', json_schema: { schema: { type: 'object', properties: {} } } } },
        tools: [], preparedMessages: [], forceTextResponse: false,
        toolChoiceRequired: false, thoughtSignature: null, session: { provider: 'openai', protocol: 'responses' }
    }).request;
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.equal(JSON.stringify(schema), snapshot, 'the CALLER schema object must stay byte-identical');
    assert.ok(!('additionalProperties' in schema), 'no additionalProperties leaked onto the caller schema');
    assert.ok(!('additionalProperties' in schema.properties.a), 'no nested container mutation either');
});

// ─── shell tool: string codes no longer leak into exitCode; case bypass closed ──

function denyApproval() { return Promise.resolve(true); }

test('shell timeout exitCode is null, not the string CMD_TIMEOUT', async () => {
    const tool = /** @type {any} */ (createShellTool({ options: { approvalCallback: denyApproval, timeoutMs: 100 } }));
    const result = /** @type {any} */ (await tool.execute({ args: { command: 'sleep', args: ['5'] } }));
    assert.equal(result.success, false);
    assert.equal(result.exitCode, null, 'a timed-out command has no exit code');
    assert.ok(String(result.error).length > 0, 'the message carries the cause');
});

test('blocklist matches case-insensitively (RM cannot bypass rm)', async () => {
    const tool = /** @type {any} */ (createShellTool({ options: { approvalCallback: denyApproval } }));
    const result = /** @type {any} */ (await tool.execute({ args: { command: 'RM', args: ['-rf', '/tmp/merci-should-not-exist'] } }));
    assert.equal(result.success, false);
    assert.match(String(result.error), /blocklist/);
});

// ─── memory: CR escaping + whitespace-padded dedup ───────────────────────────

test('formatFactBullets escapes CR like LF', () => {
    const out = formatFactBullets({ facts: [{ id: 'f1', content: 'line1\r\nline2' }] });
    assert.ok(!out.includes('line1\r'), 'a raw CR must never survive into the prompt block');
    assert.ok(out.includes('line1\\r\\nline2'));
});

test('store() dedups against whitespace-padded persisted facts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-mem-dedup-'));
    try {
        const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'bank.json') } });
        await provider.load();
        await provider.store({ content: 'spaced fact' });
        provider.facts[0].content = '  spaced fact  ';
        const before = provider.facts.length;
        const stored = await provider.store({ content: 'spaced fact' });
        assert.equal(provider.facts.length, before, 'no duplicate may be created');
        assert.ok(stored, 'the re-asserted fact refreshes in place');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ─── P5: signal adoption at the public planner/evaluator/machine-plan APIs ────

test('a pre-aborted signal reaches and cancels plan/replan/evaluate/StateMachine.plan', async () => {
    const { WorkflowPlanner } = await import('../lib/agentic/planning/planner.mjs');
    const { WorkflowEvaluator } = await import('../lib/agentic/planning/evaluator.mjs');
    const { StateMachine } = await import('../lib/agentic/state-machine/index.mjs');
    const aborted = AbortSignal.abort();
    const received = /** @type {any[]} */ ([]);
    const client = {
        provider: 'openai',
        session: () => ({
            withSystemMessage() { return this; },
            withParameters() { return this; },
            withTools() { return this; },
            /** @param {{options?: any}} arg0 */
            run: async ({ options: opts = {} }) => {
                received.push(opts.signal ?? null);
                throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            }
        })
    };
    const planner = new WorkflowPlanner({ options: { client, model: 'm' } });
    await assert.rejects(() => planner.plan({ objective: 'obj', availableTools: [], signal: aborted }), { name: 'AbortError' });
    await assert.rejects(() => planner.replan({ objective: 'obj', failedStepId: 's1', failureReason: 'why', currentOutputs: {}, signal: aborted }), { name: 'AbortError' });
    const evaluator = new WorkflowEvaluator({ options: { client, model: 'm' } });
    await assert.rejects(() => evaluator.evaluate({ node: { id: 's1', output: 'x' }, outputs: {}, objective: null, signal: aborted }), { name: 'AbortError' });
    await assert.rejects(() => StateMachine.planned({ client, objective: 'obj', options: { signal: aborted, defaultModel: 'm' } }), { name: 'AbortError' });
    const smReceived = /** @type {any[]} */ ([]);
    const sm = await StateMachine.planned({ client: {
        provider: 'openai',
        session: () => ({
            withSystemMessage() { return this; },
            withParameters() { return this; },
            /** @param {{options?: any}} arg0 */
            run: async ({ options: opts = {} }) => {
                smReceived.push(opts.signal ?? null);
                if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
                return JSON.stringify({ summary: 's', entry: 'a', nodes: [{ id: 'a', systemPrompt: 'p', terminal: true }], edges: [] });
            }
        })
    }, objective: 'obj', options: { defaultModel: 'm' } });
    await assert.rejects(() => sm.replan({ objective: 'obj', signal: aborted }), { name: 'AbortError' });
    const { createLlmJudge } = await import('../lib/agentic/loops/judge.mjs');
    const judge = createLlmJudge({ client, model: 'm' });
    await assert.rejects(() => judge({ ctx: { getAll: () => ({}) }, signal: aborted }), { name: 'AbortError' });
    assert.equal(received.length, 5, 'planner/evaluator/planned/judge all threaded their signal');
    assert.ok(received.every((s) => s && s.aborted), 'the callers signal arrived (not a fresh one)');
    assert.deepEqual(smReceived, [null, aborted], 'replan forwarded the aborted signal into plan()');
});
