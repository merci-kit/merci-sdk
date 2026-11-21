# Orchestration

Four engines, one model: a step runs, produces rows, hands context onward.
Pick by task shape (table in `SKILL.md`). Runnable proofs:
`examples/07_agent_loop.mjs` (loop), `examples/17_dag_workflow.mjs` (DAG),
`examples/18_state_machine.mjs` (machine), `examples/19_discussion.mjs`
(discussion), `examples/15_delegation.mjs` + `examples/15_delegation.mjs`
(spawning), `examples/16_plan_and_execute.mjs` (durable approval),
`examples/15_delegation.mjs` (transfer), `examples/20_durability.mjs`
(checkpoints, journal, fork), `examples/09_memory_and_todos.mjs` (memory, todos).

## Agentic loop

`session.step({ messages })` streams unified events (`text`, tool calls,
`error`, ...); `runStep({ step })` runs one documented step through the loop
and maps its fields (`model`, `systemPrompt`, `userPromptTemplate`, `tools`,
`handoff`, `messages`, `maxIterations`, `autoExtend`, `errorHandlers`) —
fill the shape, not an opaque bag. `session.run({ initialInput })` consumes
a streamed input, one turn per chunk.

## DAG (`merci-sdk/planning`, `WorkflowExecutor`)

- Plans are installed via `setSteps()`, which fails closed
  (`ConfigurationError`, nothing installed) on duplicate ids, unknown or
  self dependencies, cycles, and template refs to non-ancestors.
- `{{step_id.output}}` must name one of the step's transitive dependencies;
  a sibling/descendant/self reference renders `[UNRESOLVED: ...]` only on
  paths that skip validation — treat it as a bug, not a feature.
  `validateTemplateRefs` is on by default; context roots (`{{context.key}}`)
  may resolve later and are exempt.
- `sessionScope`: `'step'` (default, one session per step attempt),
  `'plan'` (one conversation for the whole plan), `'branch'` (per branch
  root). A step that changes system/tools/model/cache opens a visible
  `workflow:session_boundary` instead of corrupting a shared prefix.
- A step reads only its ancestors (inputs and intake are dependency-bounded).
- Failure: a failed run stays resumable — `retryFailedSteps()` resets only
  failed steps, completed siblings are kept. Checkpoints persist objective,
  context, steps, outputs, replans, spend and the journal (not function
  fields like `verify`: re-attach them after restore and heed
  `workflow:restore_warning`).
- `stateSchema` (Zod, on executor/machine/discussion): a violating output
  enters the bounded corrective-retry loop and surfaces a typed
  `VerificationError` only when retries are exhausted.
- Evaluator: `planEvaluator` answers `continue` | `replan` (patch ops: `add`,
  `remove`, `rewire`, `replace`, `split`, `expand`) | `done` | `abort`;
  capped by `maxPlanReplans`, journaled as `plan:patched`. Completed nodes
  cannot be removed by a patch.
- Context processors: `withContextProcessor({ name, order, process })`
  inserts an ordered hook into step-message preparation.

## State machine

Nodes with a `verify` gate retry with the failed transcript attached (the
model revises an output it can see). A node that throws after reporting
usage is still charged. Attach via `withStateMachine({ graph, options })`
or drive the machine directly (`examples/18_state_machine.mjs`).

## Discussion

Multi-agent turns with an LLM judge (`createLlmJudge` / `createScoredJudge`,
`compareProgress`). `planForEach` validates every agent's plan (dupes,
unknown deps, cycles, bad template refs) before any step runs — a rejected
plan throws `ConfigurationError` with no agent having run yet.

## Spawning (subagents)

- Register rosters with `withTaskAgents({ client, agents, options })` on the
  session (preferred — cascades to children) or the client. The `task` tool
  (`TASK_TOOL_NAME === 'task'`) is advertised only while a profile is
  reachable, and its description lists the snapshot roster so the model
  picks only names that exist.
- Shape grants with `withAgentDelegation(...)`: each dimension (agents,
  models, transports, system, tools, depth) is granted independently, and
  the tool schema is derived from the envelope — ungranted means absent.
- Bounds: `maxDepth` defaults to 1 (children cannot spawn further);
  `maxSpawns` defaults to 128 per tree. Budget pools (`withBudget`) are
  shared per tree. Inspect via `getSpawnRegistry({ client })` /
  `listSpawns` / `getSpawn`; continue turns with `continueSpawn` /
  `sendToSpawn(id, prompt)`; branch a child conversation with `forkSpawn()`.
- Handoff honesty: `handoff.context` is `clean` (default) | `moderated`
  (compacted digest) | `fork` (real rows, same provider) | `full` (whole
  conversation). On a different provider `fork`/`full` degrade to visible
  digest rows + a `task:fork_degraded` event — never silent. `handoff.tools`
  is an authority boundary: nested delegation narrows, never widens; an
  unenforceable child fails closed. Rows travel in-process only; across A2A
  only the `merciEnvelope` (objective/directive/refs) travels.
- Durability is opt-in: attach a `SessionStore` (`LocalFileSessionStore`,
  `InMemorySessionStore` for tests and evals, or your own `save` /
  positional `load` / optional `fork`) and each child checkpoints under its
  own `spawn:<id>` thread. Saves are last-write-wins. A code-agent spawn has no
  conversation and persists nothing.

## Memory, sessions, journal

- Memory: `withMemory({ provider })` with `LocalFileMemoryProvider`
  (file bank, locked read-merge-write, auditable history) or composed
  providers. Facts dedupe per session; distillation is non-blocking.
- Sessions: `withSessionStore({ store, threadId })` persists threads;
  `store.fork({ threadId, newThreadId })` branches one. `runStep`-level
  `loadCheckpoint()` resumes a thread in another process.
- Evals: `runEvals({ cases, makeSession, scorers, concurrency })` →
  `{ results, passRate }`; scorers from `EVAL_SCORERS` (`outputMatches`,
  `outputSchema`, `toolsCalled`, `toolSequence`, `withinBudget`, `judge`)
  read `case.expected`. Record the suite once into a cassette, then replay it
  in CI with no key.
- Cassettes: `session.withCassette({ cassette: createCassette({ path }), mode })`
  records a run's vendor calls (`'record'`) or replays them offline without
  the vendor (`'replay'`), keyed by the canonical request. Tools still run on
  replay; pair it with the journal for at-most-once effects.
- Journal: `withExecutionJournal({ journal })` gives at-most-once tool
  effects — recorded outcomes replay instead of re-executing. Rows are
  fail-closed (a missing/malformed outcome replays as failure). A re-begun
  key keeps a flat attempt history and refuses the 101st attempt
  (`OrchestrationError`) — retry under a new key. Large subagent outputs go
  through `createSaveArtifactTool` (artifact paths, not prompt stuffing).
- `transfer` (one policy, every engine): `stringify` (default, rendered
  text) | `ledger` (real rows) | `ledger-selected` / `ledger-compact` /
  `ledger-selected-compact` (windowed to the `tail` last units, optionally
  summarized via `foldContext`). A window never splits a tool call from its
  result; without a summarizer the dropped prefix becomes a visible marker.
  Configure per engine (`WorkflowExecutor`/`StateMachine`/`DiscussionSession`
  `options.transfer`, per-step/per-node/per-agent `transfer`) or per
  delegation profile.
