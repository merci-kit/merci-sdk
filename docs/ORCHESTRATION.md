# The orchestration layer — one call, four primitives

`createOrchestration` is the composition root of the coordination layer. It
binds four modules that are each usable alone:

| Module | Subpath | It owns |
|---|---|---|
| Workflow policy | `merci-sdk/workflow-policy` | `WORKFLOW.md`: front matter, the strict prompt, reload, last-known-good |
| Workspace | `merci-sdk/workspace` | one directory or `git worktree` per item, lifecycle hooks, confined tools |
| Scheduler | `merci-sdk/scheduler` | claims, the tick, retries, parking, reconciliation, the engine runner, budgets |
| Operator | `merci-sdk/operator` | the HTTP state/detail/refresh surface, the status page, the event ring |

The primitives stay public and independently usable. This page is about the
assembly: the five seams the library owns, so a host does not re-derive them —
and cannot get one of them subtly wrong.

```js
import { initializeClient, loadCredentials, resolveProvider } from 'merci-sdk';
import { createOrchestration } from 'merci-sdk/orchestration';
import { createJsonFileWorkSource } from 'merci-sdk/scheduler';

const provider = resolveProvider();
const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });

const system = await createOrchestration({
    client,
    model: 'gpt-4o',                     // always the host's choice, never the file's
    workSource: createJsonFileWorkSource({ dir: './board' }),
    workflowFile: './WORKFLOW.md',
    // One gate for both layers. The session gate calls (toolName, argsObject);
    // the workspace shell gate calls (commandString, argvArray).
    approval: (target, args) => askTheHuman({ target, args }),
    operator: true,
    scheduler: { concurrency: { global: 2 } }
});

await system.start();
const { url } = await system.listen({ port: 8787 });   // GET /, GET /api/v1/state, …
// … a live edit:
const reload = await system.reload();                  // { healthy, changed, reasons, applied }
await system.stop();                                   // server, scheduler, ring, policy
```

Run the live walkthrough: `node examples/31_orchestration.mjs` (the deterministic audit is `node test/examples/34_orchestration.mjs --offline`). The reverse seam — a plain session using the same capabilities, offline — is `node examples/28_workspace_isolation.mjs`. The money seam — one attempt's ledger folding a hook, the objective restatement and the step — is `node examples/31_orchestration.mjs`.

---

## 1. The five wires

| Wire | What the facade does | Why it matters |
|---|---|---|
| policy → scheduler | `policy.start()` first, then `policyToSchedulerOptions({ policy })` at construction and again after a healthy, changed `reload()` | the scheduler is built from the repo's contract, not from invented defaults; an unstarted policy fails loudly |
| policy → workspace | `policyToWorkspaceOptions({ policy })` at construction | the workspace layer is construction-bound: a reload exposes new root/strategy/hooks but a running manager keeps its own |
| scheduler → workspace | the real `WorkspaceManager` is passed as-is | it already satisfies the scheduler's duck-typed `ensure`/`beforeRun`/`afterRun`/`remove`/`handleFor` contract |
| scheduler → operator | `snapshot()`/`refresh()` feed the handler; `policy.snapshot()` feeds its health projection | one read model, no copied fixture |
| approval → both | one function becomes the session gate **and** the workspace shell gate (every accepted shape — `{ callback, timeoutMs }`, `{ fn, options }` — is normalized to that function) | two callbacks meant one could be strict and one permissive with nothing noticing |

One `MerciEventEmitter` is shared by the policy, the workspace manager, the
scheduler and the operator ring, so `recentEvents` and every other consumer see
the same records.

**Without an approval callback the shell tool is not bound.** The context and
artifact tools still are, so no implicit ungated shell exists. Bypass does not
bind one here either: `permissionMode: 'bypassPermissions'` only removes the
prompt when a callback is supplied, and the facade's default include still
omits the shell without one. The shell-target announcement is per constructed
shell tool, not per orchestration — `createShellTool` emits
`permissions:bypass` once when it is built (one per attempt under the facade),
and that event carries `runId: null` because construction happens outside the
attempt's context, so it is not attempt-correlated. The facade builds these
tools with
`createWorkspaceTools`, the same binder a plain session reaches
through `withWorkspace()`.

`permissionMode` governs the **workspace shell gate only**; session tools
follow the session's own `withPermissions` rules. Its vocabulary matches that
method: the default asks every gated shell command, `acceptEdits` still asks
(the shell runs code, not an edit), and `bypassPermissions` runs it without
calling the callback — an explicit, dangerous opt-in, announced through
`permissions:bypass` at construction. For session tools, `acceptEdits` approves
only a tool branded `editsFiles: true` — the SDK's `save_artifact`, or a host
tool that sets the flag on its own definition — and never one that also
declares `runsCode`; a tool loaded from an MCP server never carries the brand.

The one callback is called with two shapes, because the two gates ask different
questions:

| Gate | Call | First argument | Second argument |
|---|---|---|---|
| session tool gate | `approval(toolName, argsObject, { tool, id })` | the tool name (`read`, `execute_shell_command`, …) | the tool's argument object |
| workspace shell gate | `approval(commandString, argvArray)` | the command | its argv |

A callback that must tell them apart branches on the third argument or on the
shape of the second. Both paths fail closed: a throw or a `false` denies.

---

## 2. Lifecycle

```
createOrchestration   policy.start() → workspace → runner → scheduler → ring/handler
system.start()        rebuild from the current file if it changed → scheduler.start()
system.reload()       policy.reload() → applyConfig when healthy (no-op when nothing differs)
system.listen()       one loopback node:http server the facade owns
system.stop()         server → scheduler drain → ring.stop() → policy sink restored → policy.stop() when it owns it
system.close()        the server only; idempotent
```

- **The watcher is wired.** The policy's default `watch: true` reloads the file
  itself, and the facade applies every healthy reload, so an edit reaches the
  scheduler without the host calling `reload()`. Applying is deliberately not
  gated on the policy's `changed` flag: by the time the host asks, the watcher
  may already have consumed the edit. `applyConfig` reports
  `{ applied: false, changed: [] }` when nothing differs.
- **An edit before `start()` is not lost.** `start()` rebuilds the scheduler
  from the current file, so the first tick never runs on a stale contract.

- **Boot is strict.** A `WORKFLOW.md` that cannot load rejects the factory with
  the `PolicyError` and its reasons: there is no last good config to serve yet.
  A rejected construction stops the policy the facade itself started, so no
  watcher it opened is left emitting.
- **An injected policy stays the host's.** The facade starts a policy the host
  passed unstarted, borrows its event sink so the ring sees `workflow_policy:*`,
  and gives the sink back on `stop()`. Ownership decides the lifecycle: a policy
  the facade started is stopped by `stop()` and by a rejected construction; one
  the host had already started is left running (F1-6, W1-5). See §5.
- **A live break is not strict.** `reload()` returns `{ healthy: false, reasons,
  applied: null }`, keeps the last good config, and blocks new dispatch through
  `preflight()` until the file is fixed. No restart.
- `stop()` is final, like the primitives it wraps. A stopped orchestration cannot
  be started, reloaded into life, or listened on again; `reload()` answers
  `{ changed: false, healthy: false, reasons: ['stopped'], applied: null }`.
- `listen()` owns one server. A second call closes the first instead of
  orphaning it, and `close()` is the server-only, idempotent half of `stop()`.

---

## 3. What the operator can see

The operator's state carries both halves of the system:

```json
{
  "scheduler": { "started": true, "tickCount": 42, "lastOutcome": "validation_error", "…": "…" },
  "policy": {
    "started": true, "healthy": false, "watch": "active",
    "loadedAt": "2026-11-11T10:00:00.000Z",
    "reasons": ["invalid_config:agent.max_concurrent_agents"],
    "warnings": [],
    "lastErrorAt": "2026-11-11T10:04:11.000Z"
  }
}
```

`policy` is `null` when a host mounts the handler without a policy snapshot, so
a consumer reads one shape. The status page prints the same facts as text
(`Policy: failed | watch active | last error …`), and the event ring records
`workflow_policy:*` by default — a policy that blocks dispatch must not look
like an idle system.

The projection is health and codes only: a reason is a stable code plus the
field it names (`invalid_config:agent.max_concurrent_agents`), a warning is a
class plus the key or state it names (`unknown_key:tracker.mystery`,
`invalid_by_state:Review`), and the effective config, the hook scripts and the
prompt text never reach the API. The status page prints at most ten such codes,
then `... +N more`.

The ring is created after the policy's startup load, so `workflow_policy:loaded`
itself is not in `recentEvents`; every later reload, failure, or watch error is.

The facade's top-level `ring` option sets the bound and prefixes. `prefixes`
**replaces** the default set, so spread `DEFAULT_PREFIXES` to keep it:

```js
import { DEFAULT_PREFIXES } from 'merci-sdk/operator';

const system = await createOrchestration({
    // …
    operator: true,
    ring: {
        limit: 500,
        prefixes: [...DEFAULT_PREFIXES, 'run:', 'session:', 'tool:', 'artifact:']
    }
});
```

`ring.limit` wins over `operator.ringLimit`; without either the facade uses
200. Supplying `ring` wires the ring even when the operator handler is off. A
non-object `ring` or an unknown key rejects construction with
`ConfigurationError` and option `ring`. Old-layer `run:*`/`tool:*`/`session:*`
records reach the ring only when the engine session is constructed with the
same `MerciEventEmitter`; the facade does not rebuild the host's client
sessions.

Correlation is by field. A scheduler attempt's records carry `runId`, and its
child `run:*` carries the attempt `runId` as `parentRunId`, which is the
executable join. `work_item:*` and `workspace:*` carry the provider's
`workItemId` and, when the manager remembers it, the human `identifier`.
Session-level events (`session:*`, `run:*`, `tool:*`, `artifact:*`) carry
`sessionId`: an agentic run adopts an auto-minted id the host cannot recognise,
so the value is in-process correlation, not an authentication token. `name` is
a tool name for `tool:*` only (capped at 128 chars), and `success` is a boolean.
SDK-produced old-layer records never carry `identifier`; the ring does not block
a host from adding one, so the item detail route cannot show them by that key.
There is no automatic mapping from a session id to a work item; a host that
needs the join emits its own join event or uses the `runId` that the engine
nests under the attempt.

---

## 4. What it does not do

- **No new engine.** The engine is one of the four existing ones (`agentic`,
  `dag`, `stateMachine`, `discussion`), defaulted from `merci.engine.kind`. The
  model always comes from the host. A non-`agentic` kind still needs its own
  runner options — `runner: { planFor }`, `{ graphFor }`, or `{ agents }` — and
  construction fails with a `ConfigurationError` naming the missing one.
- **No tracker writes.** The board is read-only; moving an item is the host's or
  the agent's job.
- **No sandbox.** Workspace isolation is path confinement plus the approval
  gates. An approved shell command can still leave the workspace.
- **No OS-level or multi-host scheduling.** File claims are a single-machine
  guard, as in `docs/SCHEDULER.md`.
- **No hidden reload of workspace settings.** Root, strategy, refs, and hooks
  stay construction-bound (`docs/WORKFLOW_POLICY.md` §8).
- **No identity of its own over A2A or MCP.** Both servers separate callers only
  as far as the host says who a caller is. `createA2AHttpHandler({ authorize })`
  is the hook: it runs once per JSON-RPC request and must answer a stable,
  non-empty string key (a number is stringified; a decoded-claims object is
  refused with a `ConfigurationError`). That key owns the tasks the caller
  creates — `tasks/list` shows only its tasks, another key's task id answers
  `-32001`, and reusing an id answers `-32003` (foreign, and an existence hint
  for a guessed id) or `-32002` (still running). A hook that throws is a `403`;
  no usable key is a `500`. Without the hook the peer is single-tenant, exactly
  as before. Admission counts only running tasks, so parked `input-required`
  rows do not deny a slot to anyone. On the MCP side a session sees only the
  tasks it started, even through a shared `taskStore`; a reconnect is a new
  session and gets nothing back from the old one, and only a process restart
  (empty claim map) makes a durable store's old tasks readable again. The claim
  map is per handler, so a store shared across handlers or services is outside
  it. Stateful HTTP sessions are bounded by `mcp_http_sessions_max` and
  `mcp_http_session_idle_ms`; a held SSE stream does not protect a session, and
  a session with a live task is never evicted.

---

## 5. When not to use it

Use the primitives directly when you need only one of them, when you already own
a scheduler loop, or when the four couplings are genuinely different (for
example, a policy that feeds a scheduler in another process). The facade is
composition, not a policy: nothing in it is required to use the subpaths.

**Precedence: host over file.** A managed scheduler key passed in `scheduler`
(`limits`, `concurrency`, `pollIntervalMs`, `stallTimeoutMs`, `activeStates`,
`terminalStates`, `requiredLabels`, `retry`, `continuation`, `filter`,
`preflight`) wins over the value `WORKFLOW.md` maps, at construction and after
every reload. The same merged mapping feeds `start()` and `applyConfig()`, so a
host-set spend cap such as `limits: { maxTotalUsd: 1 }` survives an edit that
does not mention it. Bound collaborators — `workSource`, `workflow`,
`workspace`, `eventEmitter`, `claims`, `attemptStore`, `clock`, `signal` — are
construction-only: the facade filters a reload patch to the managed keys, so a
bound key in it is ignored, while `WorkScheduler.applyConfig()` called directly
with one throws a `SchedulerError` with reason `bound_option`.

It refuses to be half-wired. `scheduler: { workSource, workflow, workspace,
eventEmitter, claims, preflight }` and `runner: { engine, client, model,
prompt, tools, approval, store, budget }` are construction errors, because
silently replacing one of them is how the policy gate or the model choice
disappears. `runner.budget` accepts the coordination spelling `maxTotalUsd` and
passes it to the engine as `maxBudgetUsd`. A host preflight can be composed
after `start()` with `scheduler.applyConfig({ options: { preflight } })`.

**Who owns an injected policy.** Pass `policy` when the host already owns the
`WorkflowPolicy` — its file, its watcher, its emitter, its lifecycle — and wants
the facade to consume it. The rule is one line: *the facade never ends a
lifecycle it did not begin.*

- The facade **starts** an injected policy that is not started, and then stops it
  in `stop()` like its own: it began that lifecycle.
- An injected policy the host **already started** is left running by `stop()`.
  Stop it yourself after the orchestration is stopped, in that order.
- The event sink is **borrowed**, not taken. The facade records
  `policy.eventEmitter` before pointing the policy at the orchestration emitter,
  and restores it when the orchestration stops or its construction fails, so
  your subscriber keeps receiving `workflow_policy:*` from your policy.
- A failure during construction stops a policy the facade started — including an
  injected one it had just started — and leaves a policy the host started alone.
  Otherwise a failed `createOrchestration({ policy })` would leak the live
  watcher `watch: true` opens.

Do not assume the reverse: an injected policy is still read for
`policyToSchedulerOptions`/`policyToWorkspaceOptions` at construction and after
every reload, so an edit to its file changes this system's scheduler too.

---

## 6. What the old layers now consume

The coordination layer did not replace the session, the loop or the todo store:
each seam is also reachable from the old entry point, through the same
implementation. This table says which one, and where the proof lives.

| Old entry point | New capability on it | Proof |
|---|---|---|
| `withApproval()` on a session | the same `withApproval()` policy feeds both gates: `withWorkspace()` applies it to the workspace shell, so one callback covers the session tool gate **and** the shell gate | [`test/chat-session-workspace.test.mjs`](../test/chat-session-workspace.test.mjs) (the approval case) · [`examples/28_workspace_isolation.mjs`](../examples/28_workspace_isolation.mjs) |
| `createEngineRunner({ budget })` / `createOrchestration({ budget })` | `budget` bounds **one attempt**: the runner hands the engine `maxBudgetUsd` (and `maxTotalTokens`), and the coordination spelling `maxTotalUsd` is accepted as that same `maxBudgetUsd` cap. The scheduler's aggregate limits are separate — `limits.maxTotalUsd`, `limits.maxTotalTokens`, `limits.maxDispatches` come from the policy and gate the next dispatch. The attempt's tree spend is folded into the scheduler's `totals` for all four engines: step/node/turn sessions, nested engines, objective restatements, judge/aggregate sessions, a discussion agent's own client, task children on a profile's own client, a host `planFor`/`graphFor`/`tools` factory or code-agent `execute` that uses the `client` it is given, and a budgeted subtree (a session that joins with `_budget` keeps its cap and reports through it) are all measured through one cap-less ledger per attempt. Not folded: a call made through a client the host built and kept itself. A budget applied after the session joins stays a run-local cap. One session object per **live** attempt is required — a session that still carries another attempt's ledger is refused with `session_reused_across_attempts`, and a budgeted session reused sequentially is re-linked so each attempt reports its own delta. The ledger is reporting only — the budget still lands per step/node/agent, so a runner-level USD cap is per unit — as documented in [`docs/SCHEDULER.md`](SCHEDULER.md#10-cost-controls) §10 | [`test/scheduler-limits.test.mjs`](../test/scheduler-limits.test.mjs) · [`test/scheduler-runner.test.mjs`](../test/scheduler-runner.test.mjs) |
| `createEngineRunner({ threadId })`, or the scheduler's attempt thread | `identifier` is the four-way join key: the workspace key (`workspaceKeyFor`), the claim, the snapshot row, and `/items/:identifier`. `threadId` is a different key — it selects the session-store thread. The scheduler passes `work:<identifier>` into `run()`, and that attempt value wins over a configured runner `threadId`, so an override must itself be `work:<identifier>` to name the same thread | [`test/orchestration-identity.test.mjs`](../test/orchestration-identity.test.mjs) |
| an event ring over `scheduler:` and `work_item:` | session `run:*`/`tool:*`/`session:*` records reach the same ring with `sessionId` (and `parentRunId` under an attempt), projected through the same allowlist — only when `prefixes` opts them in **and** the engine session emits on the same `MerciEventEmitter` the facade owns; `prefixes` alone is not enough because the facade does not rebuild the results of `client.session()` | [`test/operator-ring.test.mjs`](../test/operator-ring.test.mjs) · [`examples/28_workspace_isolation.mjs`](../examples/28_workspace_isolation.mjs) |
| a `root` a host passed to every tool by hand | `withWorkspace({ workspace })` binds the context, shell and artifact tools to one handle; it fails closed without an approval callback (or `permissionMode: 'bypassPermissions'`), and the same `isInsideRoot` guards the context tools, artifacts, ingest and the shell | [`test/chat-session-workspace.test.mjs`](../test/chat-session-workspace.test.mjs) · [`test/ingest.test.mjs`](../test/ingest.test.mjs) |
| `createMemoryWorkSource` / `createJsonFileWorkSource` | `createTodoWorkSource` reads a `TodoComponent` store with the same contract: `pending`/`in_progress` routable, `completed`/`failed` terminal, the store read live | [`test/scheduler-todo-work-source.test.mjs`](../test/scheduler-todo-work-source.test.mjs) · [`examples/28_workspace_isolation.mjs`](../examples/28_workspace_isolation.mjs) |
| a per-engine failure check | `run:end` and the thrown error carry the scheduler's `failureClass`, and one `isAbortError` decides "not a failure" for tools, loops and hooks | [`test/agentic-loop-failure-class.test.mjs`](../test/agentic-loop-failure-class.test.mjs) · [`test/abort-detection-single-owner.test.mjs`](../test/abort-detection-single-owner.test.mjs) |

The reverse seam gets its own example because there the old layer is the host:
one `client.session(model)` with no orchestration, a scripted vendor, and the
three capabilities a normal program actually touches — workspace binding, todo
intake, the ring.

---

## Where to look next

- [`docs/WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md) — the file, its schema, reload and last-known-good.
- [`docs/WORKSPACES.md`](WORKSPACES.md) — strategies, hooks, artifacts, the worktree caveats.
- [`docs/SCHEDULER.md`](SCHEDULER.md) — claims, the tick, retries, parking, budgets, events.
- [`docs/OPERATOR_API.md`](OPERATOR_API.md) — routes, projections, the ring allowlist, the Host boundary.
- [`examples/31_orchestration.mjs`](../examples/31_orchestration.mjs) — the end-to-end live walkthrough.
- [`examples/28_workspace_isolation.mjs`](../examples/28_workspace_isolation.mjs) — the reverse seam: a plain session with `withWorkspace`, the todo source and the opt-in ring (offline).
