// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { z } from 'zod';

import {
    findWireHostileKeywords,
    isZodSchema,
    zodSchemaToJsonSchema,
} from '../lib/support/json.mjs';
import { UnifiedParameterBuilder } from '../lib/messaging/unified-parameter.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import {
    CONVERSATION_SUMMARY_SCHEMA,
    DAG_WORKFLOW_EVAL_SCHEMA,
    DAG_WORKFLOW_PLAN_SCHEMA,
    DAG_WORKFLOW_REPLAN_SCHEMA,
    SM_PLAN_SCHEMA,
} from '../lib/core/prompts.mjs';
import { MEMORY_DISTILLATION_SCHEMA } from '../lib/core/constants/memory.mjs';
import { JUDGE_SCHEMA } from '../lib/agentic/loops/judge.mjs';

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/internal-schema-wire.golden.json', import.meta.url), 'utf8'));

/** @type {Record<string, any>} */
const LIVE = {
    plan: DAG_WORKFLOW_PLAN_SCHEMA,
    replan: DAG_WORKFLOW_REPLAN_SCHEMA,
    eval: DAG_WORKFLOW_EVAL_SCHEMA,
    sm: SM_PLAN_SCHEMA,
    summary: CONVERSATION_SUMMARY_SCHEMA,
    memory: MEMORY_DISTILLATION_SCHEMA,
    judge: JUDGE_SCHEMA,
};

// ─── wire parity ─────────────────────────────────────────────────────────────

for (const name of Object.keys(GOLDEN)) {
    test(`${name} schema still emits its frozen wire shape`, () => {
        assert.deepEqual(zodSchemaToJsonSchema({ zodSchema: LIVE[name] }), GOLDEN[name]);
    });
}

test('replan differs from plan only in the step floor', () => {
    const plan = /** @type {any} */ (zodSchemaToJsonSchema({ zodSchema: DAG_WORKFLOW_PLAN_SCHEMA }));
    const replan = /** @type {any} */ (zodSchemaToJsonSchema({ zodSchema: DAG_WORKFLOW_REPLAN_SCHEMA }));
    assert.equal(plan.properties.steps.minItems, 2);
    assert.equal(replan.properties.steps.minItems, 1);
    assert.deepEqual(replan.properties.steps.items, plan.properties.steps.items);
    assert.deepEqual(replan.required, plan.required);
});

test('no internal schema emits a wire-hostile construct', () => {
    for (const [name, schema] of Object.entries(LIVE)) {
        const hostile = [...findWireHostileKeywords({ node: zodSchemaToJsonSchema({ zodSchema: schema }) })];
        assert.deepEqual(hostile, [], `${name} must stay JAI/Gemini-safe`);
    }
});

// ─── the rewrite did not change validation behaviour ─────────────────────────

test('each schema validates a conforming payload', async () => {
    const { extractAndParseJson } = await import('../lib/support/json.mjs');
    const payloads = {
        plan: { summary: 's', steps: [{ id: 'a', title: 't', systemPrompt: 'sp', userPromptTemplate: 'up', dependencies: [] }, { id: 'b', title: 't2', systemPrompt: 'sp2', userPromptTemplate: 'up2', dependencies: ['a'] }] },
        replan: { summary: 's', steps: [{ id: 'a', title: 't', systemPrompt: 'sp', userPromptTemplate: 'up', dependencies: [] }] },
        eval: { replanRequired: false, reason: 'ok' },
        sm: { summary: 's', entry: 'a', nodes: [{ id: 'a' }], edges: [] },
        summary: { summary: 'text' },
        memory: { newFacts: [{ content: 'c', category: 'k', targetBanks: ['workspace'] }], obsoleteFactIds: [] },
        judge: { passed: true, evidence: 'e' },
    };
    for (const [name, payload] of Object.entries(payloads)) {
        const r = /** @type {any} */ (extractAndParseJson({ input: JSON.stringify(payload), schema: LIVE[name] }));
        assert.equal(r.success, true, `${name} should accept a conforming payload: ${r.error}`);
    }
});

test('the plan floor still rejects a single-step plan and the replan floor accepts it', async () => {
    const { extractAndParseJson } = await import('../lib/support/json.mjs');
    const singleStep = { summary: 's', steps: [{ id: 'a', title: 't', systemPrompt: 'sp', userPromptTemplate: 'up', dependencies: [] }] };
    assert.equal((/** @type {any} */ (extractAndParseJson({ input: JSON.stringify(singleStep), schema: DAG_WORKFLOW_PLAN_SCHEMA }))).success, false);
    assert.equal((/** @type {any} */ (extractAndParseJson({ input: JSON.stringify(singleStep), schema: DAG_WORKFLOW_REPLAN_SCHEMA }))).success, true);
});

// ponytail: flash-tier models add unschema'd keys ("tool") and omit cosmetic
test('flash-tier plan variance (extra keys, missing title/summary/prompts) still validates', async () => {
    const { extractAndParseJson } = await import('../lib/support/json.mjs');
    const flashOutput = {
        goal: 'Create a minimal greet CLI script in this project and verify it runs.',
        steps: [
            { id: 'explore_project_structure', type: 'research', tool: 'glob', description: 'Examine the project root layout.', dependencies: [] },
            { id: 'write_cli', type: 'generation', tool: 'write_file', description: 'Write greet.mjs.', dependencies: ['explore_project_structure'] },
        ],
    };
    const parsed = /** @type {any} */ (extractAndParseJson({ input: JSON.stringify(flashOutput), schema: DAG_WORKFLOW_PLAN_SCHEMA }));
    assert.equal(parsed.success, true, `flash-tier output should validate: ${parsed.error}`);
    assert.equal(parsed.data.steps.length, 2, 'unknown root keys stripped, steps kept');
    assert.equal(parsed.data.goal, undefined, 'unschema\'d keys do not leak into the plan');
    assert.equal(parsed.data.steps[0].description, 'Examine the project root layout.', 'description survives for the alias pass');
    const smParsed = /** @type {any} */ (extractAndParseJson({ input: JSON.stringify({ objective: 'x', entry: 'a', nodes: [{ id: 'a', terminal: true }], edges: [] }), schema: SM_PLAN_SCHEMA }));
    assert.equal(smParsed.success, true, `flash-tier SM plan should validate: ${smParsed.error}`);
});

// ─── wire boundary: convert, never leak ──────────────────────────────────────

/** @param {any} configure @returns {{ spec: any, warnings: any[] }} */
/** @param {{configure: *}} arg0 */
/** @param {{configure: *}} arg0 */
const buildSpec = ({ configure }) => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const warnings = [];
    emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (p) => warnings.push(p));
    const builder = new UnifiedParameterBuilder({ model: 'm', eventEmitter: emitter, provider: 'openai' });
    configure({ b: builder });
    return { spec: /** @type {Record<string, any>} */ (builder._build()), warnings };
};

test('a Zod schema reaches the wire as plain JSON Schema', () => {
    /** @param {{b: *}} arg0 */
    /** @param {{b: *}} arg0 */
    const { spec, warnings } = buildSpec({ configure: /** @type {(...args: any[]) => any} */ (({ b }) => b.asJsonSchema({ config: { name: 'plan', schema: DAG_WORKFLOW_PLAN_SCHEMA } })) });
    assert.deepEqual(spec.responseFormat.json_schema.schema, GOLDEN.plan);
    assert.equal(spec.responseFormat.json_schema.name, 'plan');
    assert.deepEqual(warnings, []);
});

test('asTool + Zod converts the tool parameters too', () => {
    /** @param {{b: *}} arg0 */
    /** @param {{b: *}} arg0 */
    const { spec } = buildSpec({ configure: /** @type {(...args: any[]) => any} */ (({ b }) => b.asJsonSchema({ config: { name: 'plan', schema: DAG_WORKFLOW_PLAN_SCHEMA } }).asTool({ toolName: 'structured_output' })) });
    assert.equal(spec.responseFormat, undefined, 'responseFormat folds into the tool');
    assert.deepEqual(spec.tools[0].parameters, GOLDEN.plan);
    assert.deepEqual(spec.toolChoice, { type: 'named', name: 'structured_output' });
});

test('tools() carrying a Zod parameter schema are converted at the boundary', () => {
    /** @param {{b: *}} arg0 */
    /** @param {{b: *}} arg0 */
    const { spec } = buildSpec({ configure: /** @type {(...args: any[]) => any} */ (({ b }) => b.tools([{ name: 't', description: 'd', parameters: z.strictObject({ q: z.string() }) }])) });
    assert.deepEqual(spec.tools[0].parameters, {
        type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false,
    });
});

test('a wire-hostile Zod schema warns instead of failing silently on the provider', () => {
    /** @param {{b: *}} arg0 */
    /** @param {{b: *}} arg0 */
    const { warnings } = buildSpec({ configure: /** @type {(...args: any[]) => any} */ (({ b }) => b.asJsonSchema({ config: z.object({ x: z.string().nullable() }) })) });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].parameter, 'schema');
    assert.match(warnings[0].message, /type\[\]/);
});

test('an unconvertible (Zod v3-shaped) schema is refused and dropped, not leaked', () => {
    /** @param {{b: *}} arg0 */
    /** @param {{b: *}} arg0 */
    const { spec, warnings } = buildSpec({ configure: /** @type {(...args: any[]) => any} */ (({ b }) => b.asJsonSchema({ config: { _def: {}, '~standard': {}, safeParse: () => ({ success: true }) } })) });
    assert.equal(spec.responseFormat, undefined, 'must not carry a Zod instance to the wire');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /Zod v3/);
});

test('a plain JSON Schema is passed through untouched and warning-free', () => {
    const plain = { type: 'object', additionalProperties: false, properties: { a: { type: 'number' } }, required: ['a'] };
    /** @param {{b: *}} arg0 */
    /** @param {{b: *}} arg0 */
    const { spec, warnings } = buildSpec({ configure: /** @type {(...args: any[]) => any} */ (({ b }) => b.asJsonSchema({ config: plain })) });
    assert.deepEqual(spec.responseFormat.json_schema.schema, plain);
    assert.deepEqual(warnings, []);
});

// ─── session tools: normalized at ingestion, NOT at _build() ─────────────────

test('withTools converts a Zod parameter schema at ingestion', () => {
    const builder = new ChatSessionBuilder();
    builder.withTools({ tools: [{ name: 't', description: 'd', parameters: z.strictObject({ q: z.string() }) }] });
    const tool = builder._toolsStore.find((t) => t.name === 't');
    assert.ok(tool);
    assert.deepEqual(tool.parameters, {
        type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false,
    });
    assert.equal(isZodSchema({ schema: tool.parameters }), false, 'a Zod instance must never reach session._tools');
});

test('withTools leaves a plain JSON Schema tool untouched (same reference)', () => {
    const builder = new ChatSessionBuilder();
    const plain = { type: 'object', properties: { a: { type: 'number' } } };
    builder.withTools({ tools: [{ name: 'p', parameters: plain }] });
    const plainTool = builder._toolsStore.find((t) => t.name === 'p');
    assert.ok(plainTool);
    assert.equal(plainTool.parameters, plain);
});

test('the runToolCapture path carries the internal schema as plain JSON Schema', () => {
    const builder = new ChatSessionBuilder();
    builder.withTools({ tools: [{ name: 'plan', description: 'd', parameters: DAG_WORKFLOW_PLAN_SCHEMA }] });
    const tool = builder._tools.find(/** @type {(...args: any[]) => any} */ ((t) => t.name === 'plan'));
    assert.ok(tool);
    assert.equal(isZodSchema({ schema: tool.parameters }), false);
    assert.deepEqual(tool.parameters, GOLDEN.plan);
});

test('an unconvertible tool schema is emptied with a warning, never leaked', () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const warnings = [];
    emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (p) => warnings.push(p));
    const builder = new ChatSessionBuilder();
    builder.eventEmitter = emitter;
    builder.withTools({ tools: [{ name: 'bad', parameters: { _def: {}, '~standard': {}, safeParse: () => ({ success: true }) } }] });
    const tool = builder._toolsStore.find((t) => t.name === 'bad');
    assert.ok(tool);
    assert.deepEqual(tool.parameters, { type: 'object', properties: {} });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /Zod v3/);
});
