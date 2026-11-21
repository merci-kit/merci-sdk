# Spawning — the contract

A spawn is a **delegation**: one agent hands a focused task to another agent and
gets an answer back. This page is the whole contract — the roster, the envelope,
what a spawn may adapt, how deep and how wide a tree may grow, what is durable,
and where the trust boundary sits. The short version lives in
[`PROVIDERS.md`](./PROVIDERS.md); the runnable version is
[`examples/15_delegation.mjs`](../examples/15_delegation.mjs).

```
host                          model                          child
────                          ─────                          ─────
withTaskAgents(roster)   →    the task tool appears     →    a fresh session
withAgentDelegation(env) →    its schema IS the env     →    a spawn record
                              task({prompt, …})              (id, lineage, usage)
```

---

## 1. The roster — who may be spawned

`withTaskAgents({ client, agents })` registers agent **profiles** on the client's
spawn registry. Registering a profile is what makes the `task` tool appear: with
an empty roster the tool is not advertised at all.

```js
withTaskAgents({ client, agents: [
  { name: 'researcher', model: 'cheap-model',
    systemPrompt: 'You are a research specialist. Return findings under 150 words.',
    tools: [webSearchTool] },
  { name: 'writer', model: 'strong-model', fallbackModel: 'cheap-model',
    systemPrompt: 'You are a concise technical writer.' },
  { name: 'auditor', execute: async ({ prompt }) => runLocalAudit(prompt) },  // code agent
] });
```

A profile may carry:

| field | meaning |
|---|---|
| `name` | the `subagent_type` the model asks for |
| `description` | one line shown in the roster the model reads |
| `model`, `provider`, `client` | the transport for this role (defaults to the parent's) |
| `systemPrompt` | the **role template** (see §4) |
| `tools` / `toolNames` | the role's belt (tool objects) and host-set allowlist layers |
| `execute` | a **code agent**: host code instead of a model run |
| `maxIterations`, `maxDepth`, `timeoutMs`, `maxElapsedMs`, `retryPolicy`, `circuitBreaker`, `fallbackModel`, `hedgeAfterMs`, `approval`, `budget`, `handoff`, `transfer` | per-role bounds and behaviour |

The roster is **live**: it is read from the registry at call time, so a profile
registered after the session was built is still available. A session (or a DAG
node, or a graph node) may carry its **own** roster with `_taskAgents`; it wins
over the client registry for that session only.

With an empty roster the tool is not advertised. `withAgentDelegation({ agents:
'any' })` is the one exception: it makes `subagent_type` optional, so the model may
spawn an **ad-hoc** agent (`custom`) from the brief alone. A roster **array** is
the strict menu — the model may only name what is in it.

The same delegation machinery is used by the `task` tool, the MAA planner
(`runTasks`) and a direct `runTaskChild(...)` call, so all three produce the same
spawn record.

## 2. The envelope — what a spawn may ask for

`withAgentDelegation({ client, … })` declares what the **model** may vary per
spawn. Every dimension is granted independently, and every default is the most
restrictive one:

```js
withAgentDelegation({ client,
  agents: 'any',        // or a roster array — which IS the menu
  models: 'any',        // per-spawn `model`
  transports: 'any',    // per-spawn `provider`
  system: 'any',        // per-spawn `system` (an adaptation, §4)
  tools: 'inherit',     // per-spawn `tools` (an allowlist narrowing)
  maxDepth: 2,          // how deep the tree may nest (default 1)
  maxSpawns: 128,       // how many spawns one tree may open (default 128)
});
```

The tool's **schema is derived from the envelope**: a dimension the host did not
grant is *absent* from `parameters`, so the model cannot ask for it at all. A
forced argument (the model hallucinating `model` when `models: 'fixed'`) is
refused with a `ConfigurationError` — the boundary fails closed. The same is true
of the roster: an array is the whole menu, and an unknown `subagent_type` is an
error that lists what *is* registered.

`maxDepth` and `maxSpawns` are **not** per-spawn dimensions: the model cannot ask
for more room, only the host grants it.

## 3. A spawn is an identity, not a call

Every delegation opens one **spawn record** before the work starts:

```js
const handle = listSpawns({ client })[0];
handle.id;          // sub_…            (independent of the background task_N counter)
handle.parentId;    // the spawning session or spawn
handle.lineage;     // [root, …, this]  — the public chain, this spawn included
handle.status;      // 'running' | 'done' | 'error'
handle.agent; handle.model; handle.provider;
handle.result; handle.error; handle.usage;
handle.threadId;    // the durable thread, or null (see §8)
await handle.wait();
await handle.continueWith('one more turn');
```

- **Usage** is summed across retries and hedges (a primary that spent tokens and
  then failed still cost money), read at settle time, and flagged `estimated`
  when a provider reported none.
- **Continuation** (`continueWith` / `continueSpawn`) runs one more turn on the
  *same* session, one turn at a time per conversation.
- **Background** (`background: true`) returns immediately; the result arrives as a
  `task:finish` event carrying the background id.
- The registry keeps at most **100 spawn records**; a settled record is evicted
  before a running one, so running spawns are never dropped (a client with more
  than 100 concurrent spawns keeps them all). `getSpawn({ client, id })` reads one.

## 4. Role templates and the per-spawn adaptation

A role's `systemPrompt` is a **reusable template**; a spawn may **adapt** it. When
the host grants `system: 'any'`, a per-spawn `system` is appended after the
template — it never replaces it, so the house style survives:

```
ROLE TEMPLATE: you review code.
THIS SPAWN: focus on the payments module.
```

On Anthropic with `withPromptCache()`, the child's system is emitted as a **split
system**: the SDK descriptor plus the role template as one cacheable block, then
the adaptation and the per-spawn objective as an unmarked block. Two spawns with
the same role share the cached prefix byte for byte; the brief rides the user
message, not the system. The system marker spends one of the vendor's four cache
breakpoints. Every other provider (and uncached Anthropic) receives one joined
string.

## 5. The budget — one pool per tree

`withBudget({ budget })` on the parent is **one pool for the spawn tree**, shared
by reference with every descendant: children draw from the same tokens, they do
not each inherit a fresh cap. A `profile.budget` is a **local** cap layered on top.
A child that reports no usage is charged an estimate (`estimated_tokens`), so an
unreported call is never free. The budget stops a run at the next step boundary
(at most one step of overshoot). A delegated child admitted while an ancestor's
step is still in flight may spend into that ancestor's reservation: the child is
not allowed to wait on the step that is blocked on it, so the ancestor's own
charge then fails the cap. That is the one case where two steps can land past
the cap, and it fails loudly rather than deadlocking or silently shortening the
child's answer.

## 6. Depth and the tree

- Depth is **1 by default**: a session may spawn a child, and that child may not
  spawn again. `maxDepth: 2` allows orchestrator-of-orchestrators work. A profile
  may carry its own `maxDepth`, which raises the *implicit* default when the host
  declared no envelope; a depth the host actually named — an envelope `maxDepth`,
  or `session.withTaskAgents({ agents, options: { maxDepth } })` — is always a
  ceiling over it. Naming `maxDepth: 1` therefore hides a profile that asks for
  more, while leaving it out lets the profile be the default.
- Every **tree** also has a spawn cap (`maxSpawns`, default 128), counted per root
  conversation and shared by nested spawns — including a grandchild routed to a
  different transport. A second root has its own budget. The cap **value** is read
  from the envelope of the client that opens each spawn, so a tree crossing
  transports is capped by the caller's declaration at that point.
- A **code agent** (`execute`) counts toward the depth: it runs inside an async
  frame at the depth its spawn occupies, so a recursive profile stops at the same
  cap as an LLM child. Sibling and concurrent code spawns each get their own
  frame; the parent session is never mutated.
- A **depth-0 direct call** (`runTaskChild` from the MAA planner or a host) is the
  host's own action and runs under any `maxDepth`; only nested calls are capped.

## 7. What a spawn inherits

A child is a **fresh conversation**. It inherits the parent's policy — permissions,
tool allowlists, guardrails, hooks, context processors, timeouts, compaction,
retry/stream/header/elapsed policies, approval, budget pool, prompt-cache policy
and session store — but not the parent's messages (unless the handoff's `context`
axis replays them), not the parent's thread id, and not the parent's transcript.

`handoff` decides how much context travels. It is an **object**, and its three
axes are independent:

```js
handoff: {
  goal:    'clean' | 'full' | 'moderated',            // the global objective block (default 'full')
  context: 'clean' | 'full' | 'moderated' | 'fork',   // the parent's rows (default: 'clean')
  tools:   'inherit' | 'none',                        // the parent's tool scope (default 'inherit')
}
```

`context: 'fork'` seeds the child with the tail of the parent's real conversation
rows (cache-friendly continuation), `'full'` replays the whole parent conversation,
`'moderated'` carries a compacted digest, `'clean'` carries none. A profile may set
`inherit: 'history'` as its default context mode. `transfer` is the separate
policy for *how* real rows are selected and rendered. The child's brief is the
`prompt` plus whatever `context`, `outputFormat` and `constraints` the model wrote,
plus the global objective the `goal` mode allows.

## 8. Durability — opt-in, per tree

A spawn is **in memory by default**; nothing is written. Attach a `SessionStore`
to the parent (`session.withSessionStore({ store, threadId })`) and every child is
checkpointed under its own deterministic thread:

```js
const handle = listSpawns({ client })[0];
handle.threadId;                                   // 'spawn:sub_…'
await forkSpawn({ client, id: handle.id, newThreadId: 'branch-1' });
// another process:
await forkSpawn({ store, threadId: handle.threadId, newThreadId: 'branch-2' });
const resumed = client.session(model).withSessionStore({ store, threadId: handle.threadId });
await resumed.loadCheckpoint();
```

- The child never writes the parent's thread.
- A failed child still saves its last turn; a turn that fails before its first
  transcript snapshot keeps the stored conversation instead of erasing it.
- A failed write never loses the answer: `handle.checkpointError` says why, and a
  later successful write clears it.
- A **code agent** has no conversation, so it has no thread and writes nothing.
- The switch is **per tree**: every descendant persists for as long as the tree
  lives, and checkpoints are not pruned automatically.

## 9. The trust boundary

| the host decides | the model may ask (only if granted) |
|---|---|
| which profiles exist and what each can do | which `subagent_type` from the roster |
| `maxDepth`, `maxSpawns`, the budget | `model`, `provider`, `system`, `tools` — each only when granted |
| the parent's tools, permissions, guardrails, hooks | the brief: `prompt`, `objective`, `context`, `outputFormat`, `constraints` |
| whether children persist, and where | `background`, `description`, and `handoff` (it overrides the profile's default) |
| what a profile's `execute` does (host code, host authority) | nothing inside a code agent's own logic |

What the boundary guarantees:

- **Fail-closed.** An ungranted dimension is absent from the schema *and* refused
  if forced. An unknown `subagent_type` is refused with the registered list.
- **A child cannot widen its own scope.** The per-spawn `tools` list is an
  allowlist layer; it composes with the inherited scope and never adds to it.
- **Every delegation is recorded** — id, parent, lineage, status, usage — and a
  background result is delivered as an event, not silently dropped.
- **A code agent runs host code**, not model output. Its `execute` is called with
  `{ prompt, signal }`; it is not given a session, a tool belt or a vendor client
  as arguments. (It is a method on the profile, so `this` is the profile object —
  the profile is host code either way.)

## 10. Steering a running turn

A background result is not the only thing that can reach the model mid-run. A host
that wants to redirect a turn **while it is working** — OpenChamber's "send while
running" — puts a row on the same inbox with `delivery: 'steer'`:

```js
session.enqueueInput({ input: 'also check the logs', delivery: 'steer' });
```

- `'steer'` is the default for `enqueueInput`. The running `run()` claims it at the
  next step boundary, so it joins the very next request; if the model has already
  produced its final answer, the steer starts another turn in the same run instead
  of being returned to the caller unread.
- `'queue'` never interrupts the step that is running, but it DOES get its own turn
  **inside the same `run()`**: when the run would return, it claims every row the
  host submitted and answers that turn first. This is the rule that makes a user
  message deliverable at all — the host may run the agent once and never again, so
  a message that waited for "the next run" would be stranded. OpenCode's runner
  does the same: a queue item keeps the same drain alive (`SessionInbox.has` is
  re-checked after every turn), it never waits for a new client request.
- A row with **no** `delivery` is a background delegation result: conversation
  state, not an instruction. It is the one that waits for the next turn (or the
  next `run()`), per section 7.
- Delivery is **at-least-once**: a row claimed by a turn that then fails is put
  back on the inbox, so nothing is dropped on an error.
- Placement reuses the inbox rule in section 7's neighbours
  (`lib/agentic/pending-inbox.mjs`): the row goes after the history and before the
  new prompt, and a `tool_use`/`tool_result` pair is never split — a history that
  stops mid-round is closed with a synthetic result first.
- An empty answer is still a turn boundary: a message the user sent is answered
  rather than stranded because the previous turn produced nothing.

`enqueueInput` also accepts an already-built message row, replacing its `delivery`
with the one you pass. It returns the row (or `null` when the value is not a row).
The same row enqueued twice is one message, so a host that retries a request
cannot deliver it twice.

The host side of the queue is the same three operations OpenCode exposes as its
session inbox, and they only ever touch rows a running turn has not claimed:

```js
const [pending] = session.getPendingInputs();      // a snapshot, in delivery order
session.setInputDelivery({ input: pending.merciId, delivery: 'queue' }); // the toggle
session.cancelInput({ input: pending });           // withdraw before delivery
```

- `getPendingInputs()` returns the rows that are still waiting — the steers a
  running turn already claimed are not among them.
- `cancelInput({ input })` takes the row `enqueueInput` returned, or its
  `merciId`, and returns the removed row. A message already delivered returns
  `null`: cancelling cannot recall what the model has seen.
- `setInputDelivery({ input, delivery })` flips a pending row between the two
  modes and returns it; a third mode throws `ConfigurationError`.
- A streamed input (`run({ initialInput: asyncIterable })`) drains the same inbox:
  a message sent **between chunks** rides the next chunk's turn, and one sent
  **after the last chunk** still gets a turn of its own before `run()` resolves.
- A message that lands after the loop's last turn boundary — while an output
  guardrail or the checkpoint write is in flight — is claimed by the run before
  its promise resolves, so `run()` never settles with a message it could answer
  still pending.
- `maxInboxTurns` (default `MERCI_LIMIT_MAX_INBOX_TURNS`, 8) bounds the
  inbox-driven turns ONE run may add. Past the cap the rows stay pending and
  visible, the run returns the answer it has, and a `client:warning` with code
  `INBOX_TURNS_EXHAUSTED` names how many wait. That is what keeps a host that
  enqueues on every token from holding one `run()` open forever.

### The queue of record

A host that wants OpenChamber's server-owned queue asks the SDK to be it. Three
calls cover the dispatcher, and one store makes it survive a restart:

```js
session.withInboxStore({ store: new LocalFileInboxStore({ dir: 'inbox' }), threadId });
session.isRunning();            // choose run() vs enqueueInput(), never catch CONCURRENT_RUN
await session.drainInbox();     // the idle handler: run the queue, or null when empty
```

- **`drainInbox({ options })`** is the idle dispatcher. It invents no prompt: it
  claims the waiting rows and runs them, one queued message per turn, with every
  steer riding that turn — OpenCode's `promote` rule. It returns
  `{ answers: [{ inboxId, text }], text }` in delivery order, or `null` when the
  queue is empty (no model call, no events). A waiting background delegation
  result rides the drain too, because the drain IS the "next turn" section 7
  promises it. Inside a drain the loop answers exactly one turn per iteration,
  so each queued message comes back with its own answer; a message that lands
  mid-drain is picked up by the next iteration. It refuses to start while a run
  is in flight (`MERCI-ERR-CONCURRENT_RUN`).
- **`isRunning()`** is the run flag `run()` already enforces, so a host can
  branch without provoking the error.
- **`withInboxStore({ store, threadId })`** makes `enqueueInput` durable. The
  store holds the PENDING rows under the conversation's id — an explicit
  `threadId`, else `withSessionStore()`'s, else the session id — and the
  built-ins are `LocalFileInboxStore` (one atomic JSON file per thread, corrupt
  files quarantined) and `InMemoryInboxStore`. The queue is written after every
  change and loaded before the first turn, so a restarted host replays it;
  `loadInbox()` is the awaitable "load and settle the writes" call, and a
  `store.list()` names the threads a boot dispatcher has work for.
- **The inbox is observable.** `session:input_enqueued`, `session:input_delivered`
  (`{ inboxId, delivery }`), `session:input_cancelled` and
  `session:input_delivery_changed` carry the row's stable `merciId`, so a panel
  moves a message between "pending" and "sent" without polling.
- **One drainer per thread, across processes.** With a store configured,
  `drainInbox()` leases the thread before it claims anything: the built-in stores
  lease through the scheduler's claim store, so the key is an O_EXCL file under
  `<dir>/leases/`, a stopped drainer's lease is reclaimed through the documented
  dead-pid/stale path, and a running drain renews it with a heartbeat
  (`MERCI_LIMIT_INBOX_LEASE_RENEW_MS`, inside `…_LEASE_STALE_MS`). A worker that
  loses the race returns `{ skipped: 'lease', answers: [] }` instead of racing —
  so two servers or two browser workers cannot answer the same message twice.
  A lease lost mid-drain is reported (`client:warning`, code
  `INBOX_LEASE_LOST`) and the turn in flight finishes: that is the at-least-once
  contract, not a silent duplicate. An in-memory store needs no staleness — its
  map dies with the process and a drain always releases in `finally`.
- **A queued message waits for the spawn tree.** `drainInbox()` reads the spawn
  registry before every turn: while a background subagent THIS session started is
  still running (`hasLiveBackgroundWork()`), it waits
  (`waitForBackgroundWork()`, polling every
  `MERCI_LIMIT_INBOX_BACKGROUND_RECHECK_MS` up to
  `MERCI_LIMIT_INBOX_BACKGROUND_WAIT_MS`) and then returns
  `{ skipped: 'background' }` with the queue untouched — the same rule as
  OpenChamber's `hasWorkingDescendants` gate: the turn is only over once no
  subagent runs. `drainInbox({ options: { waitForBackground: false } })` checks
  once instead of waiting; a subagent that starts mid-drain stops the next turn
  and leaves the rest queued. A sibling session's subagent never blocks this one.
- Delivery stays **at-least-once** with a store: a crash between the claim and
  the next write re-delivers the row. A row that was never delivered is still in
  the store for the next process.


## 11. Where to look next

- [`PROVIDERS.md`](./PROVIDERS.md) — the per-feature notes and the wire details.
- [`examples/15_delegation.mjs`](../examples/15_delegation.mjs) — a live delegation
  with a background task and artifact paths.
- [`examples/20_durability.mjs`](../examples/20_durability.mjs) — checkpoints, the
  execution journal and the session fork, offline.
- [`examples/15_delegation.mjs`](../examples/15_delegation.mjs) — the
  roster, the envelope, the depth/tree caps and spawn identity, live.
- `test/wave6-*.test.mjs` and `test/mid-run-steer.test.mjs` — the executable form of every rule above.
