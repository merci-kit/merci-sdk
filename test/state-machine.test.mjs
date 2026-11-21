// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StateContext, StateMachine, createStateMachineTool } from '../lib/agentic/state-machine/index.mjs';
import { compileCondition } from '../lib/agentic/state-machine/machine.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { SM_PLAN_PROMPT } from '../lib/core/prompts.mjs';

const CHAIN_GRAPH = {
  entry: 'a',
  nodes: [
    { id: 'a', execute: /** @type {(ctx: any) => any} */ ((ctx) => { ctx.set({ k: 'seen', v: [...(ctx.get({ k: 'seen' }) || []), 'a'] }); }) },
    { id: 'b', execute: /** @type {(ctx: any) => any} */ ((ctx) => { ctx.set({ k: 'seen', v: [...(ctx.get({ k: 'seen' }) || []), 'b'] }); }), terminal: true },
  ],
  edges: [{ from: 'a', to: 'b' }],
};

// ─── StateContext ────────────────────────────────────────────────────────────

test('StateContext: get/set/push/increment round-trip', () => {
  const c = new StateContext({ initial: { x: 1 } });
  assert.equal(c.get({ k: 'x' }), 1);
  c.set({ k: 'y', v: 2 });
  assert.equal(c.get({ k: 'y' }), 2);
  c.increment({ k: 'x' });
  assert.equal(c.get({ k: 'x' }), 2);
  c.push({ k: 'list', v: 'a' }).push({ k: 'list', v: 'b' });
  assert.deepEqual(c.get({ k: 'list' }), ['a', 'b']);
});

test('StateContext: patch merges', () => {
  const c = new StateContext({ initial: { a: 1 } });
  c.patch({ obj: { b: 2, a: 99 } });
  assert.equal(c.get({ k: 'a' }), 99);
  assert.equal(c.get({ k: 'b' }), 2);
});

test('StateContext: toPayloadString / fromPayloadString round-trip', () => {
  const c1 = new StateContext({ initial: { name: 'test', count: 42 } });
  const s = c1.toPayloadString();
  const c2 = new StateContext();
  c2.fromPayloadString({ str: s });
  assert.equal(c2.get({ k: 'name' }), 'test');
  assert.equal(c2.get({ k: 'count' }), 42);
});

test('StateContext: toJSON / fromJSON', () => {
  const c1 = new StateContext({ initial: { a: 1, b: { nested: true } } });
  const j = c1.toJSON();
  const c2 = StateContext.fromJSON(j);
  assert.equal(c2.get({ k: 'a' }), 1);
  assert.deepEqual(c2.get({ k: 'b' }), { nested: true });
});

test('StateContext: getAll returns a copy', () => {
  const c = new StateContext({ initial: { x: 1 } });
  const all = c.getAll();
  (/** @type {any} */ (all)).x = 99;
  assert.equal(c.get({ k: 'x' }), 1);
});

// ─── StateMachine — basic execution ──────────────────────────────────────────

test('StateMachine: executes linear chain', async () => {
  const sm = new StateMachine({ graph: CHAIN_GRAPH, options: { context: { seen: [] } } });
  const ctx = await sm.run();
  assert.deepEqual(ctx.get({ k: 'seen' }), ['a', 'b']);
  assert.equal(sm.phase, 'done');
});

test('StateMachine: step() returns intermediate state', async () => {
  const sm = new StateMachine({ graph: CHAIN_GRAPH, options: { context: { seen: [] } } });
  const r1 = await sm.step();
  assert.equal(r1.done, false);
  assert.equal(r1.from, 'a');
  assert.equal(r1.to, 'b');
  const r2 = await sm.step();
  assert.equal(r2.done, true);
  assert.equal(r2.from, 'b');
  assert.equal(r2.to, null);
});

test('StateMachine: throws on unknown node in graph', async () => {
  assert.throws(() => new StateMachine({ graph: { entry: 'ghost', nodes: [{ id: 'real' }], edges: [] } }),
    { message: /entry.*ghost.*not found/ });
});

// ─── Cycle guard ─────────────────────────────────────────────────────────────

test('StateMachine: cycle guard stops after maxVisits', async () => {
  const graph = {
    entry: 'loop',
    nodes: [{ id: 'loop', execute: /** @type {(ctx: any) => any} */ ((ctx) => ctx.increment({ k: 'n' })), maxVisits: 3 }],
    edges: [{ from: 'loop', to: 'loop' }],
  };
  const sm = new StateMachine({ graph: graph, options: { context: { n: 0 }, maxSteps: 20 } });
  await assert.rejects(() => sm.run(), { message: /visited 4 times/ });
  assert.equal(sm.context.get({ k: 'n' }), 3);
});

test('StateMachine: the removed machine-wide "maxIterations" option throws (renamed to maxSteps)', () => {
  const graph = {
    entry: 'n',
    nodes: [{ id: 'n', execute: /** @type {(ctx: any) => any} */ (() => 1) }],
    edges: [],
  };
  assert.throws(
    () => new StateMachine({ graph: graph, options: { maxIterations: 2 } }),
    (/** @type {any} */ err) => err instanceof ConfigurationError && err.option === 'maxSteps'
  );
});

test('StateMachine: default maxVisits is 10', async () => {
  const graph = {
    entry: 'loop',
    nodes: [{ id: 'loop', execute: /** @type {(ctx: any) => any} */ ((ctx) => ctx.increment({ k: 'n' })) }],
    edges: [{ from: 'loop', to: 'loop' }],
  };
  const sm = new StateMachine({ graph: graph, options: { context: { n: 0 }, maxSteps: 20 } });
  await assert.rejects(() => sm.run(), { message: /visited 11 times/ });
  assert.equal(sm.context.get({ k: 'n' }), 10);
});

test('StateMachine: start event carries the machine step budget (maxSteps)', async () => {
  const sm = new StateMachine({ graph: CHAIN_GRAPH, options: { maxSteps: 7 } });
  let start = /** @type {any} */ (null);
  sm.on('state_machine:start', (/** @type {any} */ e) => { start = e; });
  await sm.run();
  assert.ok(start, 'start event fired');
  assert.equal(start.entry, 'a');
  assert.equal(start.nodeCount, 2);
  assert.equal(start.maxSteps, 7, 'the renamed machine budget is observable');
});

// ─── Conditional edges ───────────────────────────────────────────────────────

test('StateMachine: condition routes correctly', async () => {
  const graph = {
    entry: 'decide',
    nodes: [
      { id: 'decide', execute: /** @type {(ctx: any) => any} */ ((ctx) => ctx.set({ k: 'score', v: ctx.get({ k: 'val' }) })) },
      { id: 'high', execute: /** @type {(ctx: any) => any} */ ((ctx) => ctx.set({ k: 'result', v: 'high' })), terminal: true },
      { id: 'low',  execute: /** @type {(ctx: any) => any} */ ((ctx) => ctx.set({ k: 'result', v: 'low' })), terminal: true },
    ],
    edges: [
      { from: 'decide', to: 'high', condition: /** @type {(ctx: any) => any} */ ((ctx) => ctx.get({ k: 'score' }) > 5) },
      { from: 'decide', to: 'low',  condition: /** @type {(ctx: any) => any} */ ((ctx) => ctx.get({ k: 'score' }) <= 5) },
    ],
  };

  const sm1 = new StateMachine({ graph: graph, options: { context: { val: 10 } } });
  await sm1.run();
  assert.equal(sm1.context.get({ k: 'result' }), 'high');

  const sm2 = new StateMachine({ graph: graph, options: { context: { val: 2 } } });
  await sm2.run();
  assert.equal(sm2.context.get({ k: 'result' }), 'low');
});

test('StateMachine: halts when no edge condition matches', async () => {
  const graph = {
    entry: 'a',
    nodes: [
      { id: 'a', execute: /** @type {(ctx: any) => any} */ ((ctx) => ctx.set({ k: 'x', v: 1 })) },
      { id: 'b', terminal: true },
    ],
    edges: [{ from: 'a', to: 'b', condition: /** @type {(ctx: any) => any} */ ((ctx) => ctx.get({ k: 'x' }) > 10) }],
  };
  const sm = new StateMachine({ graph: graph, options: { context: { x: 1 } } });
  const { done } = await sm.step();
  assert.equal(done, true);
});

// ─── Save / Load (checkpointing) ─────────────────────────────────────────────

test('StateMachine: save/load round-trip and continue', async () => {
  const graph = {
    entry: 'first',
    nodes: [
      { id: 'first', execute: /** @type {(ctx: any) => any} */ ((ctx) => { ctx.set({ k: 'phase', v: 'mid' }); }) },
      { id: 'second', execute: /** @type {(ctx: any) => any} */ ((ctx) => { ctx.set({ k: 'phase', v: 'done' }); }), terminal: true },
    ],
    edges: [{ from: 'first', to: 'second' }],
  };

  const sm1 = new StateMachine({ graph: graph, options: { context: { phase: 'start' } } });
  await sm1.step();
  const saved = sm1.save();

  const sm2 = StateMachine.load({ json: saved, graph: graph });
  assert.equal(sm2.context.get({ k: 'phase' }), 'mid');
  assert.equal(sm2.current, 'second');

  await sm2.run();
  assert.equal(sm2.context.get({ k: 'phase' }), 'done');
  assert.equal(sm2.phase, 'done');
});

test('StateMachine: load() restores the per-node attempt budget', async () => {
  const graph = {
    entry: 'work',
    nodes: [
      { id: 'work', execute: () => 'output', terminal: true, verify: () => ({ passed: false, evidence: 'bad', fingerprint: 'fp1' }) },
    ],
    edges: [],
  };
  const sm1 = new StateMachine({ graph: graph, options: { contract: { maxRetries: 2 } } });
  await assert.rejects(() => sm1.run(), /failed verification/);
  const saved = sm1.save();
  assert.equal(JSON.parse(saved).verifyAttempts[0][1], 3, 'attempts persisted (maxRetries 2 → 3)');

  const sm2 = StateMachine.load({ json: saved, graph: graph, options: { contract: { maxRetries: 2 } } });
  const attemptsBefore = sm2.visited.get('work') ?? 0;
  await assert.rejects(() => sm2.run(), /failed verification/);
  assert.ok(/** @type {any} */ (sm2.visited).get('work') <= attemptsBefore + 1,
    `resumed machine must not grant a fresh retry budget (visits ${attemptsBefore} → ${sm2.visited.get('work')})`);
});

test('StateMachine: a step() throw leaves phase error, not running', async () => {
  const graph = {
    entry: 'boom',
    nodes: [
      { id: 'boom', execute: () => { throw new Error('node blew up'); } },
      { id: 'end', execute: () => {}, terminal: true },
    ],
    edges: [{ from: 'boom', to: 'end' }],
  };
  const sm = new StateMachine({ graph: graph });
  await assert.rejects(() => sm.run(), /node blew up/);
  assert.equal(sm.phase, 'error', 'phase must not stay stuck at running');
});

test('StateMachine: default context view in the LLM prompt is windowed', async () => {
  const prompts = /** @type {any[]} */ ([]);
  const client = {
    session: () => ({
      provider: 'openai',
      withSystemMessage() { return this; },
      withTools() { return this; },
      /**
 * @param {{initialInput: *}} arg0
 */
      async run({ initialInput: input }) { prompts.push(JSON.stringify(input)); return 'ok'; }
    })
  };
  const nodes = /** @type {any[]} */ ([]);
  for (let i = 0; i < 30; i++) {
    nodes.push({ id: `n${i}`, model: 'm', execute: /** @type {(ctx: any) => any} */ ((ctx) => { ctx.set({ k: `n${i}`, v: i }); }) });
  }
  nodes.push({ id: 'llm', model: 'm', terminal: true });
  const edges = nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));
  const sm = new StateMachine({ graph: { entry: 'n0', nodes, edges }, options: { client, defaultModel: 'm' } });
  await sm.run();
  assert.equal(prompts.length, 1);
  const body = prompts[0];
  assert.equal((body.match(/Current working state:/g) || []).length, 1);
  assert.ok(!body.includes('\\"n0\\":'), 'oldest context entry must be windowed out');
  assert.ok(body.includes('\\"n29\\":'), 'most recent context entry stays visible');
});

// ─── outputKey ───────────────────────────────────────────────────────────────

test('StateMachine: output stored at ctx[node.id]', async () => {
  const graph = {
    entry: 'gen',
    nodes: [
      { id: 'gen', execute: () => 'hello world' },
      { id: 'end', execute: () => {}, terminal: true },
    ],
    edges: [{ from: 'gen', to: 'end' }],
  };
  const sm = new StateMachine({ graph: graph });
  await sm.run();
  assert.equal(sm.context.get({ k: 'gen' }), 'hello world');
});

// ─── Events ──────────────────────────────────────────────────────────────────

test('StateMachine: emits node_start and node_end', async () => {
  const sm = new StateMachine({ graph: CHAIN_GRAPH, options: { context: { seen: [] } } });
  const events = /** @type {any[]} */ ([]);
  sm.on('state_machine:node_start', (e) => events.push(['start', e.nodeId]));
  sm.on('state_machine:node_end', (e) => events.push(['end', e.nodeId, e.terminal]));
  await sm.run();
  assert.deepEqual(events, [
    ['start', 'a'],
    ['end', 'a', false],
    ['start', 'b'],
    ['end', 'b', true],
  ]);
});

test('StateMachine: a non-terminal dead-end node is flagged as implicitTerminal', async () => {
  const graph = { entry: 'a', nodes: [{ id: 'a', execute: () => 'x' }], edges: [] };
  const sm = new StateMachine({ graph: graph });
  /** @type {any[]} */ const ends = [];
  sm.on('state_machine:node_end', (e) => ends.push(e));
  await sm.run();
  assert.equal(ends[0].terminal, true);
  assert.equal(ends[0].implicitTerminal, true, 'a non-terminal dead end must be surfaced, not silent');
  assert.equal(sm.implicitTerminal, 'a', 'the public getter names the node the dead end happened on');
});

test('StateMachine: an explicitly terminal node is not flagged implicit', async () => {
  const graph = { entry: 'a', nodes: [{ id: 'a', execute: () => 'x', terminal: true }], edges: [] };
  const sm = new StateMachine({ graph: graph });
  /** @type {any[]} */ const ends = [];
  sm.on('state_machine:node_end', (e) => ends.push(e));
  await sm.run();
  assert.equal(ends[0].implicitTerminal, false);
  assert.equal(sm.implicitTerminal, null, 'an explicit terminal is not a dead end');
});

// ─── createStateMachineTool ──────────────────────────────────────────────────

test('createStateMachineTool: returns tool with expected shape', () => {
  const tool = createStateMachineTool({ graph: CHAIN_GRAPH });
  assert.equal((/** @type {any} */ (tool)).name, 'run_state_machine');
  assert.ok((/** @type {any} */ (tool)).description.includes('2-node'));
  assert.ok((/** @type {any} */ (tool)).parameters.properties.context);
});

test('createStateMachineTool: execute returns final context JSON', async () => {
  const tool = createStateMachineTool({ graph: CHAIN_GRAPH });
  const result = await (/** @type {any} */ (tool)).execute({ args: { context: { seen: [] } } });
  const parsed = JSON.parse(result);
  assert.deepEqual(parsed, { seen: ['a', 'b'] });
});

test('createStateMachineTool: execute without context still works', async () => {
  const graph = {
    entry: 'single',
    nodes: [{ id: 'single', execute: () => 'ok', terminal: true }],
    edges: [],
  };
  const tool = createStateMachineTool({ graph });
  const result = await (/** @type {any} */ (tool)).execute({ args: {} });
  const ctx = JSON.parse(result);
  assert.equal(ctx.single, 'ok');
});

// ─── injectPayload ──────────────────────────────────────────────────────────

// ─── Graph mutation API ─────────────────────────────────────────────────

test('StateMachine: addNode adds and runs', async () => {
  const sm = new StateMachine({ graph: { entry: 'a', nodes: [{ id: 'a', execute: /** @type {(ctx: any) => any} */ ((ctx) => ctx.set({ k: 'x', v: 1 })) }], edges: [] } });
  sm.addNode({ nodeDef: { id: 'b', execute: /** @type {(ctx: any) => any} */ ((ctx) => ctx.set({ k: 'x', v: 2 })), terminal: true } });
  sm.addEdge({ edgeDef: { from: 'a', to: 'b' } });
  await sm.run();
  assert.equal(sm.context.get({ k: 'x' }), 2);
});

test('StateMachine: addNode throws on duplicate id', () => {
  const sm = new StateMachine({ graph: CHAIN_GRAPH });
  assert.throws(() => sm.addNode({ nodeDef: { id: 'a' } }), { message: /already exists/ });
});

test('StateMachine: removeNode throws on current node', async () => {
  const sm = new StateMachine({ graph: CHAIN_GRAPH, options: { context: { seen: [] } } });
  await sm.step();
  assert.equal(sm.current, 'b');
  assert.throws(() => sm.removeNode({ nodeId: 'b' }), { message: /cannot remove current/ });
});

test('StateMachine: removeNode removes associated edges', () => {
  const sm = new StateMachine({ graph: CHAIN_GRAPH });
  sm.addNode({ nodeDef: { id: 'c', execute: () => {} } });
  sm.addEdge({ edgeDef: { from: 'b', to: 'c' } });
  sm.removeNode({ nodeId: 'c' });
  assert.equal(sm.graph.edges.length, CHAIN_GRAPH.edges.length);
});

test('StateMachine: addEdge validates source and target', () => {
  const sm = new StateMachine({ graph: CHAIN_GRAPH });
  assert.throws(() => sm.addEdge({ edgeDef: { from: 'ghost', to: 'b' } }), { message: /source.*ghost/ });
  assert.throws(() => sm.addEdge({ edgeDef: { from: 'a', to: 'ghost' } }), { message: /target.*ghost/ });
});

test('StateMachine: removeEdge throws on missing edge', () => {
  const sm = new StateMachine({ graph: CHAIN_GRAPH });
  assert.throws(() => sm.removeEdge({ from: 'a', to: 'z' }), { message: /not found/ });
});

test('StateMachine: getGraph returns a shallow copy', () => {
  const sm = new StateMachine({ graph: CHAIN_GRAPH });
  const g = sm.graph;
  assert.notEqual(g.nodes, CHAIN_GRAPH.nodes);
  assert.deepEqual(g.nodes, CHAIN_GRAPH.nodes);
});

test('StateMachine: graph mutation emits events', () => {
  const sm = new StateMachine({ graph: CHAIN_GRAPH });
  const events = /** @type {any[]} */ ([]);
  sm.on('state_machine:node_added', (e) => events.push(['added', e.nodeId]));
  sm.on('state_machine:node_removed', (e) => events.push(['removed', e.nodeId]));
  sm.on('state_machine:edge_added', (e) => events.push(['edge_added', e.from, e.to]));
  sm.addNode({ nodeDef: { id: 'c', execute: () => {} } });
  sm.addEdge({ edgeDef: { from: 'a', to: 'c' } });
  sm.removeEdge({ from: 'a', to: 'c' });
  sm.removeNode({ nodeId: 'c' });
  assert.deepEqual(events, [
    ['added', 'c'],
    ['edge_added', 'a', 'c'],
    ['removed', 'c'],
  ]);
});

// ─── plan() ──────────────────────────────────────────────────────────────

test('StateMachine: plan throws without client', async () => {
  const sm = new StateMachine({ graph: { entry: 'x', nodes: [{ id: 'x', execute: () => {} }], edges: [] } });
  await assert.rejects(() => sm.plan({ objective: 'do something' }), { message: /client is required/ });
});

test('StateMachine: plan throws without model', async () => {
  const sm = new StateMachine({ graph: { entry: 'x', nodes: [{ id: 'x', execute: () => {} }], edges: [] }, options: { client: {} } });
  await assert.rejects(() => sm.plan({ objective: 'do something' }), { message: /model is required/ });
});

test('StateMachine: plan keeps model on planned nodes (schema-advertised override)', async () => {
  const fakeClient = {
    session: () => ({
      /** @param {{fn: *}} arg0 */
      withSystemMessage: /** @param {any} m */ (m) => ({ withParameters: /** @param {any} fn */ ({ fn }) => ({ run: async () => JSON.stringify({
        summary: 'test',
        entry: 'a',
        nodes: [{ id: 'a', model: 'gpt-5', systemPrompt: 'do x' }],
        edges: []
      }) }) })
    })
  };
  const sm = new StateMachine({ graph: { entry: 'x', nodes: [{ id: 'x', execute: () => {} }], edges: [] }, options: { client: fakeClient, defaultModel: 'my-model' } });
  await sm.plan({ objective: 'test' });
  const plannedModel = (/** @type {any} */ ((await sm.graph).nodes.find(n => n.id === 'a'))).model;
  assert.equal(plannedModel, 'gpt-5');
});

test('StateMachine: plan retries when the first graph fails validation', async () => {
  let calls = 0;
  const fakeClient = {
    session: () => ({
      withSystemMessage: () => ({ withParameters: () => ({ run: async () => {
        calls++;
        if (calls === 1) {
          return JSON.stringify({
            summary: 'bad', entry: 'a',
            nodes: [{ id: 'a', model: 'gpt-5', systemPrompt: 'do x' }],
            edges: [{ from: 'a', to: 'ghost' }]
          });
        }
        return JSON.stringify({
          summary: 'good', entry: 'a',
          nodes: [{ id: 'a', model: 'gpt-5', systemPrompt: 'do x' }],
          edges: []
        });
      } }) })
    })
  };
  const sm = new StateMachine({ graph: { entry: 'x', nodes: [{ id: 'x', execute: () => {} }], edges: [] }, options: { client: fakeClient, defaultModel: 'my-model' } });
  await sm.plan({ objective: 'test' });
  assert.equal(calls, 2);
  assert.equal((await sm.graph).entry, 'a');
});

test('StateMachine: plan validation retries exhaust and throw the last error', async () => {
  const badPlan = JSON.stringify({
    summary: 'bad', entry: 'a',
    nodes: [{ id: 'a', systemPrompt: 'do x' }],
    edges: [{ from: 'a', to: 'ghost' }]
  });
  const fakeClient = {
    session: () => ({
      withSystemMessage: () => ({ withParameters: () => ({ run: async () => badPlan }) })
    })
  };
  const sm = new StateMachine({ graph: { entry: 'x', nodes: [{ id: 'x', execute: () => {} }], edges: [] }, options: { client: fakeClient, defaultModel: 'my-model' } });
  await assert.rejects(() => sm.plan({ objective: 'test', options: { maxPlanAttempts: 2 } }), { message: /edge to "ghost" not in nodes/ });
});

test('StateMachine: #callLLM falls back to defaultModel when node has none', async () => {
  let usedModel = null;
  const fakeSession = {
    withSystemMessage: () => fakeSession,
    withTools: () => fakeSession,
    withOutputCapture: () => fakeSession,
    run: async () => 'ok',
    provider: 'openai',
    eventEmitter: { emit: () => {} },
    getSystemMessage: () => 'test',
    _tools: []
  };
  const fakeClient = { session: /** @type {(m: any) => any} */ ((m) => { usedModel = m; return fakeSession; }) };
  const sm = new StateMachine({ graph: {
    entry: 'a',
    nodes: [{ id: 'a', systemPrompt: 'test' }],
    edges: []
  }, options: { client: fakeClient, defaultModel: 'fallback-model' } });
  await sm.step();
  assert.equal(usedModel, 'fallback-model');
});

test('StateMachine: #callLLM throws when no model and no defaultModel', async () => {
  const fakeClient = { session: () => { throw new Error('should not be called'); } };
  const sm = new StateMachine({ graph: {
    entry: 'a',
    nodes: [{ id: 'a', systemPrompt: 'test' }],
    edges: []
  }, options: { client: fakeClient } });
  await assert.rejects(() => sm.step(), { message: /no model and no defaultModel/ });
});

// ─── compileCondition (LLM-authored edge conditions) ─────────────────────────

test('compileCondition: an expression body returns its value (not undefined)', () => {
  const fn = compileCondition({ src: "ctx.get('score') >= 8" });
  assert.equal(fn({ get: () => 9, getAll: () => ({ score: 9 }) }), true);
  assert.equal(fn({ get: () => 3, getAll: () => ({ score: 3 }) }), false);
});

test('compileCondition: rejects a statement body (arbitrary code from model output)', () => {
  assert.throws(() => compileCondition({ src: "if (ctx.get('n') > 1) { return true; } return false;" }));
});

test('StateMachine: a function condition returning a custom thenable is refused, not read as true', async () => {
  // D-1 removed the host-side `.then` probe for *string* conditions. A host
  // function is trusted, so its return value can still be inspected — and a
  // thenable there is a forgotten `await`, not a satisfied condition.
  const sm = new StateMachine({ graph: {
    entry: 'a',
    nodes: [{ id: 'a', execute: /** @type {(ctx: any) => any} */ (() => {}) }, { id: 'b', terminal: true }],
    edges: [{ from: 'a', to: 'b', condition: /** @type {(ctx: any) => any} */ (() => ({ then() {} })) }],
  } });
  await assert.rejects(() => sm.run(), (/** @type {any} */ err) => err instanceof ConfigurationError && /synchronous/.test(err.message));
  assert.equal(sm.phase, 'error');
});

test('compileCondition: process/globalThis/this are unreachable inside a condition', () => {
  // D-1: a string condition is coerced to a primitive boolean inside the
  // sandbox. `process` is undefined there, so this is true; reading it throws.
  assert.equal(compileCondition({ src: "typeof process === 'undefined'" })({ get: () => 1, getAll: () => ({}) }), true);
  assert.throws(() => compileCondition({ src: "process.version" })({ get: () => 1, getAll: () => ({}) }));
  /** @param {{src: *}} arg0 */
  const throwsNoLeak = /** @type {(arg0: {src: any}) => any} */ (({ src }) => assert.throws(() => compileCondition({ src })({ get: () => 1, getAll: () => ({}) })));
  throwsNoLeak({ src: "this.constructor.constructor('return process')()" });
  throwsNoLeak({ src: "globalThis.constructor.constructor('return process')()" });
  throwsNoLeak({ src: "ctx.get('n').constructor.constructor('return process')()" });
  throwsNoLeak({ src: "ctx.get.constructor('return process')()" });
  throwsNoLeak({ src: "Object.getPrototypeOf(ctx.get).constructor('return process')()" });
  throwsNoLeak({ src: "ctx.constructor.constructor('return process')()" });
  throwsNoLeak({ src: "eval('process.version')" });
  throwsNoLeak({ src: "this.process.exit(1)" });
  assert.equal(compileCondition({ src: "ctx.get('n') > 1" })({ get: () => 2, getAll: () => ({ n: 2 }) }), true);
});

test('compileCondition: a non-string condition is a configuration error', () => {
  assert.throws(() => compileCondition({ src: /** @type {any} */ (true) }));
});

test('compileCondition: async/await/Promise expressions are rejected (sandbox DoS)', () => {
  assert.throws(() => compileCondition({ src: 'Promise.reject(new Error("x"))' }), /synchronous/);
  assert.throws(() => compileCondition({ src: '(async () => { await Promise.resolve(); for(;;){} })()' }), /synchronous/);
  assert.throws(() => compileCondition({ src: 'new Promise(r => {})' }), /synchronous/);
});

test('StateMachine: a non-function verify is rejected, not silently ignored', async () => {
  const graph = {
    entry: 'a',
    nodes: [
      { id: 'a', execute: () => 'out', verify: { criteria: ['must hold'] } },
      { id: 'b', execute: () => 'ok', terminal: true },
    ],
    edges: [{ from: 'a', to: 'b' }],
  };
  const sm = new StateMachine({ graph: graph });
  await assert.rejects(sm.step(), (e) => e instanceof ConfigurationError);
});

test('StateMachine: a planner-shaped expression condition routes the transition', async () => {
  const graph = {
    entry: 'a',
    nodes: [
      { id: 'a', execute: /** @type {(ctx: any) => any} */ ((ctx) => { ctx.set({ k: 'score', v: 9 }); }) },
      { id: 'done', execute: () => 'ok', terminal: true },
      { id: 'retry', execute: () => 'retry' },
    ],
    edges: [
      { from: 'a', to: 'done', condition: compileCondition({ src: "ctx.get('score') >= 8" }) },
      { from: 'a', to: 'retry' },
    ],
  };
  const sm = new StateMachine({ graph: graph });
  const { to } = await sm.step();
  assert.equal(to, 'done', 'expression condition must be truthy, not undefined');
});

// ─── planned() factory + cancellation ────────────────────────────────────────

test('StateMachine.planned: builds from an LLM plan without a throwaway dummy graph', async () => {
  const plan = {
    summary: 's',
    entry: 'first',
    nodes: [{ id: 'first', systemPrompt: 'p', terminal: true }],
    edges: []
  };
  const fakeClient = {
    session: () => ({
      provider: 'openai',
      withSystemMessage() { return this; },
      withParameters() { return this; },
      run: async () => JSON.stringify(plan)
    })
  };
  const sm = await StateMachine.planned({ client: fakeClient, objective: 'do a thing', options: { defaultModel: 'm' } });
  assert.equal(sm.current, 'first');
  assert.deepEqual(sm.graph.nodes.map(n => n.id), ['first']);
});

test('StateMachine: an aborted signal stops run() before the node executes', async () => {
  let ran = false;
  const sm = new StateMachine({ graph: {
    entry: 'a',
    nodes: [{ id: 'a', execute: () => { ran = true; }, terminal: true }],
    edges: []
  } });
  const c = new AbortController();
  c.abort();
  await assert.rejects(() => sm.run({ signal: c.signal }), { name: 'AbortedError' });
  assert.equal(ran, false);
});

test('StateMachine: signal and followUp reach the node session', async () => {
  let seen = /** @type {any} */ (null);
  const fakeClient = {
    session: () => ({
      provider: 'openai',
      withSystemMessage() { return this; },
      withTools() { return this; },
      /** @param {{options: *}} arg0 */
      run: async ({ options }) => { seen = options; return 'ok'; }
    })
  };
  const sm = new StateMachine({ graph: {
    entry: 'a', nodes: [{ id: 'a', systemPrompt: 'p', terminal: true }], edges: []
  }, options: { client: fakeClient, defaultModel: 'm' } });
  const c = new AbortController();
  const followUp = () => null;
  await sm.run({ signal: c.signal, followUp });
  assert.equal(seen.signal, c.signal);
  assert.equal(seen.followUp, followUp);
});

// ─── Scheduler-core routing ──────────────────────────────────────────────────

test('StateMachine: LLM node session carries the client-registry breaker; open breaker fail-fasts with zero backend calls', async () => {
    const { getCircuitBreaker, BREAKER_OPEN_CODE } = await import('../lib/support/retry-policy.mjs');
    const attached = /** @type {any[]} */ ([]);
    let backendCalls = 0;
    const client = {
        session: /** @type {(m: any) => any} */ ((m) => {
            const s = {
                provider: 'openai', model: m,
                withSystemMessage() { return s; },
                /** @param {{breaker: *}} arg0 */
                withCircuitBreaker({ breaker }) { attached.push(breaker); (/** @type {any} */ (s))._breaker = breaker; return s; },
                async run() {
                    if ((/** @type {any} */ (s))._breaker && !(/** @type {any} */ (s))._breaker.canRun()) {
                        throw Object.assign(new Error('Circuit breaker open'), { code: BREAKER_OPEN_CODE });
                    }
                    backendCalls++;
                    (/** @type {any} */ (s))._breaker?.recordSuccess();
                    return 'ok';
                },
            };
            return s;
        }),
    };
    const graph = { entry: 'llm', nodes: [{ id: 'llm', model: 'm', terminal: true }], edges: [] };

    const sm1 = new StateMachine({ graph: graph, options: { client, defaultModel: 'm' } });
    await sm1.run();
    assert.equal(backendCalls, 1);
    assert.equal(attached.length, 1);
    assert.equal(attached[0], getCircuitBreaker({ client, key: 'openai:m' }), 'node shares the client registry breaker');
    assert.equal(attached[0].consecutiveFailures, 0);

    const breaker = getCircuitBreaker({ client, key: 'openai:m' });
    for (let i = 0; i < 5; i++) breaker.recordFailure();
    assert.equal(breaker.canRun(), false);
    const sm2 = new StateMachine({ graph: graph, options: { client, defaultModel: 'm' } });
    await assert.rejects(() => sm2.run(), /Circuit breaker open/);
    assert.equal(backendCalls, 1, 'open breaker made zero additional backend calls');
});

// ─── Scheduler-core branching proofs ─────────────────────────────────────────

test('StateMachine: a conditional cycle runs to terminal (visits > 1, identical post-port behavior)', async () => {
    const graph = {
        entry: 'loop',
        nodes: [
            { id: 'loop', execute: /** @type {(ctx: any) => any} */ ((ctx) => { ctx.set({ k: 'n', v: (ctx.get({ k: 'n' }) || 0) + 1 }); }) },
            { id: 'done', execute: () => 'fin', terminal: true },
        ],
        edges: [
            { from: 'loop', to: 'loop', condition: /** @type {(ctx: any) => any} */ ((ctx) => ctx.get({ k: 'n' }) < 2) },
            { from: 'loop', to: 'done' },
        ],
    };
    const sm = new StateMachine({ graph: graph });
    await sm.run();
    assert.equal(sm.phase, 'done');
    assert.equal(sm.context.get({ k: 'n' }), 2, 'the cycle body ran twice');
    assert.equal(sm.visited.get('loop'), 2, 'both visits recorded');
    assert.equal(sm.context.get({ k: 'done' }), 'fin');
});

// ─── transfer: ledger rows vs the stringified context view ───────────────────

/**
 * Captures each SM node run's full initialInput message array.
 * @param {{backendFor?: ((model: string) => string)|null}} [arg0]
 */
function makeCapturingClient({ backendFor = null } = {}) {
    /** @type {any[]} */
    const inputs = [];
    let n = 0;
    return {
        inputs,
        /** @param {string} model */
        session: (model) => ({
            provider: backendFor ? backendFor(model) : 'openai',
            withSystemMessage() { return this; },
            withTools() { return this; },
            /** @param {{initialInput: any}} arg0 */
            async run({ initialInput }) {
                inputs.push(initialInput);
                n += 1;
                return `answer ${n}`;
            },
        }),
    };
}

test('SM transfer: ledger injects the previous node rows, not the context view', async () => {
    const client = makeCapturingClient();
    const graph = {
        entry: 'a',
        nodes: [
            { id: 'a', model: 'm', userPromptTemplate: 'Ask A.' },
            { id: 'b', model: 'm', transfer: 'ledger', terminal: true },
        ],
        edges: [{ from: 'a', to: 'b' }],
    };
    const sm = new StateMachine({ graph, options: { client, defaultModel: 'm' } });
    await sm.run();
    const bInput = /** @type {any[]} */ (client.inputs[1]);
    assert.deepEqual(
        bInput.map((m) => [m.role, m.content]),
        [['user', 'Ask A.'], ['assistant', 'answer 1'], ['user', 'Execute your task.']],
        "a's rows replay verbatim, then b's own turn",
    );
    assert.ok(!bInput.some((m) => String(m.content).includes('Current working state:')), 'no stringified context view in ledger mode');
});

test('SM transfer: machine-level transfer applies to nodes without their own', async () => {
    const client = makeCapturingClient();
    const graph = {
        entry: 'a',
        nodes: [
            { id: 'a', model: 'm', userPromptTemplate: 'Ask A.' },
            { id: 'b', model: 'm', terminal: true },
        ],
        edges: [{ from: 'a', to: 'b' }],
    };
    const sm = new StateMachine({ graph, options: { client, defaultModel: 'm', transfer: 'ledger' } });
    await sm.run();
    const bInput = /** @type {any[]} */ (client.inputs[1]);
    assert.deepEqual(
        bInput.map((m) => [m.role, m.content]),
        [['user', 'Ask A.'], ['assistant', 'answer 1'], ['user', 'Execute your task.']],
        'the machine default reaches a node that sets no transfer of its own',
    );
});

test('SM transfer: a foreign-backend node degrades to a digest (no verbatim replay)', async () => {
    const client = makeCapturingClient({ backendFor: (m) => (m === 'mB' ? 'openai' : 'anthropic') });
    const graph = {
        entry: 'a',
        nodes: [
            { id: 'a', model: 'mA', userPromptTemplate: 'Ask A.' },
            { id: 'b', model: 'mB', transfer: 'ledger', terminal: true },
        ],
        edges: [{ from: 'a', to: 'b' }],
    };
    const sm = new StateMachine({ graph, options: { client, defaultModel: 'mA' } });
    await sm.run();
    const bInput = /** @type {any[]} */ (client.inputs[1]);
    assert.ok(!bInput.some((m) => m.role === 'assistant'), 'foreign rows are not replayed as assistant turns');
    assert.ok(bInput.some((m) => m.role === 'user'
        && String(m.content).includes('[Output from Step "a"]')
        && String(m.content).includes('answer 1')), 'degraded to a user digest');
});

test('SM transfer: ledger-selected windows the tail and marks the dropped prefix', async () => {
    const client = makeCapturingClient();
    const graph = {
        entry: 'a',
        nodes: [
            { id: 'a', model: 'm', userPromptTemplate: 'Ask A.' },
            { id: 'b', model: 'm', userPromptTemplate: 'Ask B.' },
            { id: 'c', model: 'm', transfer: { preset: 'ledger-selected', tail: 1 }, terminal: true },
        ],
        edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    };
    const sm = new StateMachine({ graph, options: { client, defaultModel: 'm' } });
    await sm.run();
    const cInput = /** @type {any[]} */ (client.inputs[2]);
    assert.equal(cInput[0].role, 'user');
    assert.ok(String(cInput[0].content).includes('earlier entries omitted'), 'dropped prefix is visible, not silent');
    assert.ok(cInput.some((m) => m.role === 'assistant' && m.content === 'answer 2'), "b's rows are kept");
    assert.ok(!cInput.some((m) => m.role === 'assistant' && m.content === 'answer 1'), "a's rows are dropped");
});

test('SM transfer: captured node rows survive a save/load checkpoint', async () => {
    const client = makeCapturingClient();
    const graph = {
        entry: 'a',
        nodes: [
            { id: 'a', model: 'm', userPromptTemplate: 'Ask A.' },
            { id: 'b', model: 'm', transfer: 'ledger', terminal: true },
        ],
        edges: [{ from: 'a', to: 'b' }],
    };
    const sm = new StateMachine({ graph, options: { client, defaultModel: 'm' } });
    await sm.step();
    const loaded = StateMachine.load({ json: sm.save(), graph, options: { client, defaultModel: 'm' } });
    await loaded.run();
    const bInput = /** @type {any[]} */ (client.inputs[1]);
    assert.deepEqual(
        bInput.map((m) => [m.role, m.content]),
        [['user', 'Ask A.'], ['assistant', 'answer 1'], ['user', 'Execute your task.']],
        "a's rows were persisted and replay verbatim after resume",
    );
});

// ─── D-5 / D-6 / D-7: a finished machine, an in-flight step, a replan ────────

test('D-5: run() on a done machine refuses instead of re-running or destroying it', async () => {
  /** @type {string[]} */
  const ran = [];
  const graph = {
    entry: 'a',
    nodes: [
      { id: 'a', execute: /** @type {(ctx: any) => any} */ (() => { ran.push('a'); }) },
      // Terminal with an outgoing edge: stopping here must leave nothing to run next.
      { id: 'b', execute: /** @type {(ctx: any) => any} */ (() => { ran.push('b'); }), terminal: true },
      { id: 'c', execute: /** @type {(ctx: any) => any} */ (() => { ran.push('c'); }) },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  };
  const sm = new StateMachine({ graph });
  await sm.run();
  assert.deepEqual(ran, ['a', 'b'], 'the terminal node stops the run');
  assert.equal(sm.phase, 'done');
  assert.equal(JSON.parse(sm.save()).current, null, 'a terminal step leaves no next node to run');

  await assert.rejects(() => sm.run(), /done/, 'a finished machine refuses a second run');
  assert.equal(sm.phase, 'done', 'the terminal phase survives the refused run');
  assert.deepEqual(ran, ['a', 'b'], 'nothing ran again');
});

test('D-6: step() during run() is refused', async () => {
  /** @type {string[]} */
  const ran = [];
  /** @type {() => void} */
  let entered = () => {};
  const inNode = new Promise((resolve) => { entered = () => resolve(undefined); });
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const sm = new StateMachine({ graph: {
    entry: 'a',
    nodes: [{ id: 'a', execute: /** @type {(ctx: any) => any} */ (async () => { ran.push('a'); entered(); await gate; }) }],
    edges: [],
  } });

  const running = sm.run();
  await inNode;
  const concurrent = sm.step().then(() => null, (/** @type {any} */ err) => err);
  release();
  const err = await concurrent;
  await running;

  assert.ok(err, 'a step started during a run is refused');
  assert.match(String(err.message), /already in flight/);
  assert.deepEqual(ran, ['a'], 'the node ran once, not twice');
});

test('D-7: replan keeps the visit guard and history of the nodes the new plan keeps', async () => {
  const revised = {
    summary: 'revised',
    entry: 'a',
    nodes: [{ id: 'a', model: 'm', systemPrompt: 'do a' }, { id: 'c', model: 'm', systemPrompt: 'do c' }],
    edges: [],
  };
  const fakeClient = {
    session: () => ({
      withSystemMessage: () => ({
        withParameters: () => ({ run: async () => JSON.stringify(revised) }),
      }),
    }),
  };
  const sm = new StateMachine({ graph: CHAIN_GRAPH, options: { client: fakeClient, defaultModel: 'm' } });
  await sm.run();
  const visitsOfA = sm.visited.get('a');
  assert.equal(visitsOfA, 1);

  await sm.replan({ objective: 'goal', failedNodeId: 'b', reason: 'b was wrong' });

  const history = /** @type {Array<any>} */ (sm.history);
  assert.equal(sm.visited.get('a'), visitsOfA, 'a surviving node keeps its visit count (the guard still bounds it)');
  assert.equal(sm.visited.has('b'), false, 'a node the new plan dropped loses its visit count');
  assert.ok(history.some((h) => h.nodeId === 'a'), 'the surviving node keeps its history');
  assert.equal(history.some((h) => h.nodeId === 'b'), false, 'the dropped node leaves no history behind');
});

// ─── W4-8 / W4-9 / W4-10: replan against an in-flight run, and its residue ──

test('W4-8: a replan driven from an event listener is refused, not allowed to corrupt the run', async () => {
  const revised = {
    summary: 'revised',
    entry: 'a',
    nodes: [{ id: 'a', model: 'm', systemPrompt: 'do a' }, { id: 'c', model: 'm', systemPrompt: 'do c' }],
    edges: [],
  };
  const fakeClient = {
    session: () => ({
      withSystemMessage: () => ({ withParameters: () => ({ run: async () => JSON.stringify(revised) }) }),
    }),
  };
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const sm = new StateMachine({ graph: {
    entry: 'a',
    nodes: [{ id: 'a', execute: /** @type {(ctx: any) => any} */ (async () => { await gate; }) }],
    edges: [],
  }, options: { client: fakeClient, defaultModel: 'm' } });

  /** @type {{error: Error|null}} */
  const seen = { error: null };
  sm.on('state_machine:node_start', () => {
    sm.replan({ objective: 'goal' }).then(() => {}, (/** @type {any} */ err) => { seen.error = err; });
  });

  const running = sm.run();
  // Let the listener's replan reach its plan call while the node is still in flight.
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await running;

  assert.ok(seen.error, 'the in-flight replan is refused');
  assert.match(String(seen.error?.message), /in flight/);
  assert.equal(sm.phase, 'done', 'the run reaches its own terminal state');
  assert.deepEqual((await sm.graph).nodes.map((n) => n.id), ['a'], 'the graph the run was executing is intact');
});

test('W4-9: a replan keeps the verify budget of a surviving node', async () => {
  const revised = {
    summary: 'revised',
    entry: 'a',
    nodes: [{ id: 'a', model: 'm', systemPrompt: 'do a' }, { id: 'c', model: 'm', systemPrompt: 'do c' }],
    edges: [],
  };
  const fakeClient = {
    session: () => ({
      withSystemMessage: () => ({ withParameters: () => ({ run: async () => JSON.stringify(revised) }) }),
    }),
  };
  const graph = {
    entry: 'a',
    nodes: [
      { id: 'a', execute: /** @type {(ctx: any) => any} */ (() => 'x'), verify: () => ({ passed: false, evidence: 'nope' }) },
      { id: 'b', execute: /** @type {(ctx: any) => any} */ (() => 'y'), terminal: true },
    ],
    edges: [{ from: 'a', to: 'b' }],
  };
  const sm = new StateMachine({ graph, options: { client: fakeClient, defaultModel: 'm', contract: { maxRetries: 1 } } });
  await assert.rejects(() => sm.run(), /failed verification/);
  const before = JSON.parse(sm.save());
  assert.deepEqual(Object.fromEntries(before.verifyAttempts), { a: 2 }, 'the failed attempts were recorded');

  await sm.replan({ objective: 'goal' });

  const after = JSON.parse(sm.save());
  assert.deepEqual(Object.fromEntries(after.verifyAttempts), { a: 2 },
    'a surviving node keeps its spent verify attempts across a replan (a fresh budget per replan defeats the bound)');
});

test('W4-10: a replan drops the transcript of a node it removed', async () => {
  const revised = {
    summary: 'revised',
    entry: 'a',
    nodes: [{ id: 'a', model: 'm', systemPrompt: 'do a' }, { id: 'c', model: 'm', systemPrompt: 'do c' }],
    edges: [],
  };
  let turns = 0;
  const client = {
    session: () => {
      const s = {
        provider: 'openai',
        withSystemMessage() { return s; },
        withTools() { return s; },
        withParameters() { return s; },
        /** @param {{options?: {maxSchemaRetries?: number}}} [arg] */
        async run(arg = {}) {
          // The structured planner call is the one that turns schema repairs off.
          if (arg.options?.maxSchemaRetries !== undefined) return JSON.stringify(revised);
          turns += 1;
          return `answer ${turns}`;
        },
      };
      return s;
    },
  };
  const graph = {
    entry: 'a',
    nodes: [{ id: 'a', model: 'm' }, { id: 'b', model: 'm', terminal: true }],
    edges: [{ from: 'a', to: 'b' }],
  };
  const sm = new StateMachine({ graph, options: { client, defaultModel: 'm' } });
  await sm.run();
  const before = JSON.parse(sm.save());
  assert.deepEqual(before.nodeMessages.map((/** @type {any} */ row) => row[0]).sort(), ['a', 'b'], 'both turns were kept');

  await sm.replan({ objective: 'goal' });

  const after = JSON.parse(sm.save());
  assert.deepEqual(after.nodeMessages.map((/** @type {any} */ row) => row[0]), ['a'],
    'the removed node leaves no transcript behind for a later re-admission');
  assert.deepEqual(after.nodeDelta.map((/** @type {any} */ row) => row[0]), ['a'], 'nor a delta');
});

test('SM_PLAN_PROMPT exposes only advertised tool fields (no internal leakage)', () => {
    const out = SM_PLAN_PROMPT({ objective: 'goal', toolsList: [/** @type {any} */ ({
        name: 'danger',
        description: 'A gated tool.',
        parameters: { type: 'object', properties: {} },
        requiresApproval: true,
        execute: () => {},
    })] });
    assert.match(out, /"name": "danger"/);
    assert.match(out, /=== Available Tools ===/);
    assert.doesNotMatch(out, /requiresApproval|"execute"/);
    assert.doesNotMatch(SM_PLAN_PROMPT({ objective: 'goal', toolsList: [] }), /=== Available Tools ===/);
});
