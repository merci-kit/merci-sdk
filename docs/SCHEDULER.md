# The scheduler — the contract

The scheduler turns **external work items** into **one engine run per attempt**.
It polls a read-only work source, claims an item, dispatches a run, and keeps the
claim for as long as the item stays active — across retries, continuations, and
parking. It stops at a budget, reconfigures live, and reports a snapshot an
operator API can serve.

This page is the whole contract: the boundary, the tick, the state machine,
eligibility and ordering, claims, work sources, retries and parking,
reconciliation, the workspace requirement, cost controls, restart semantics,
live reconfiguration, events, wiring, and errors.

---

## 1. What the scheduler is — and is not

| Layer | Unit of work | Owns |
|---|---|---|
| **scheduler** | an external work item | polling, claims, retries, parking, caps, budgets, workspace lifecycle |
| **engines** (`agentic`, `dag`, `stateMachine`, `discussion`) | one attempt's internal steps | step order, verify gates, checkpoints inside a run |
| **spawn** | a delegated context | a child conversation started by an agent |

These are different abstractions, not competing ones. A scheduler attempt *runs*
an engine; an engine may spawn children. None of them replaces another.

Two guarantees define the edge:

- **Work sources are read-only.** The scheduler calls `fetchByStates` and
  `fetchByIds` and nothing else. It never writes to a tracker, moves a board
  column, or opens a pull request.
- **`snapshot()` is data only.** It reads in-memory state and returns a plain
  object. It performs no HTTP request, no filesystem read, and no engine call.
  Besides the rows and counts it carries `tickCount`, `lastTickAt`,
  `lastOutcome` (the last tick's outcome, or `null` before the first), and the
  live `pollIntervalMs`/state lists, so a reader can tell a blocked scheduler
  from an idle one.

The scheduler never imports the workspace **manager**. A workspace manager is a
duck-typed collaborator the host passes in (§9). The claim store does import the
pure `workspaceKeyFor` key helper, so claims and workspaces derive the same key
without sharing a lifecycle.

### Queue-shaped hosts

The scheduler polls on `pollIntervalMs` (default 30 s) and continues a clean
completion up to `continuation.max` times (default 3), because its work items
are tracker rows that a human also edits. A host that uses it as a request
queue — one job per HTTP submit, no tracker — wants the opposite of those
defaults. The five settings that make it behave like a queue:

| Need | Setting | Why |
|---|---|---|
| Dispatch a submitted job now, not after a poll | `await scheduler.refresh()` after enqueue, `pollIntervalMs` above the job time | `refresh()` ticks immediately; the poll is the only timer |
| One model call per job | `continuation: { max: 0 }` | otherwise a "completed" job runs again up to three times |
| No silent retry of a deterministic app error | return `{ status: 'failed', errorCode, errorName, nonRetryable: true }` | the result carries the evidence (§7) |
| A cap per job, not for the whole scheduler | `withBudget` on the session, plus a queue cap | `limits.*` are scheduler-wide |
| Cancel one job | `await scheduler.cancelItem({ identifier })` | the attempt is aborted and parked; the claim is kept, so it is not redispatched |

If jobs must survive a process restart, the scheduler is the wrong layer: its
queue is in-process and the tracker is the source of truth. Persist the jobs
yourself and feed them through a work source.

**Not in this layer.** `limits.*` are scheduler-wide, not per item (wrap one
attempt's session with `withBudget` for a per-job cap). There is no run-level
wall-clock deadline: `withTimeout({ totalMs })` bounds one step, so a
multi-step job needs a host `AbortController` passed as the attempt signal.
There is no durable queue.

---

## 2. The tick

`tick()` is single-flight: a second call while one is running emits
`scheduler:tick { outcome: 'in_flight' }` and returns. Every public tick emits
exactly one `scheduler:tick`, on every path. A completing tick re-arms the poll
timer in its `finally`; an immediate `applyConfig` re-arms it too.

The order is deliberate:

1. **Apply a queued config patch** (`applyConfig` during a previous tick).
2. **Reconcile** — the stall pass first, then one tracker refresh of running items.
3. **Re-check due parked items.**
4. **Validate the config and run `preflight`.**
5. **Dispatch due retries** (one batched refresh).
6. **Fetch the active states.**
7. **Fail duplicate identifiers closed** for this tick.
8. **Sort by priority** (see §4).
9. **Scan** — a full global pool stops the scan; a full lane skips that item and
   continues.
10. **Claim and dispatch** — the claim is awaited before the attempt starts, so a
    slot is reserved before the next eligibility check.

Step 4 is a gate for the tick, not a promise about the dispatch: the same
validation plus `preflight()` is read **again** immediately before the claim
(step 10). A `WORKFLOW.md` edit can break the contract after step 4 and before
the scan — the work source's own fetch is a host callback and may block — and
dispatching on the stale answer would run the new prompt under the old config.
A non-empty result there emits `work_item:claim_failed { reason: 'preflight' }`
and no claim is taken; a throwing preflight emits `scheduler:internal_error
{ op: 'preflight' }` and is refused the same way. A **due retry** refused there
is not a lost claim: no claim was taken, so nothing is released and the attempt
is put back with its number intact (re-queued at the base delay, like a busy
slot). After the file is fixed the same retry fires with the same attempt, so
`limits.maxAttemptsPerItem` keeps counting one item's attempts, not one refusal
per tick (W1-9).


Steps 2 and 3 run even when validation will fail, because reaping a finished item
and releasing its claim spend nothing. `start()` is a prerequisite: `tick()`
before it throws `SchedulerError('not_started')`, and `refresh()` revalidates the
config first and then ticks.

---

## 3. State machine and claim lifetime

```
unclaimed → claimed → running ─┬→ retry_queued → running
                               ├→ parked (claim kept) → re-check
                               └→ released
running (completed, no continuation) → parked
retry_queued (terminal, inactive, unroutable, missing, reset, claim_failed, stop) → released
parked (terminal, inactive, missing, reset, stop) → released
```

A **completed** attempt also reaches `parked` when no continuation is scheduled
(§7): it emits `completed`, then `parked`, and keeps the claim. A parked item
that is still **active** stays parked and extends its next check, even when it
is unroutable (`dispatchable: false`, a missing required label, or a failed
host filter); the parked check releases only on terminal, inactive, or missing.

`CLAIM_STATES` is the frozen vocabulary: `unclaimed`, `claimed`, `running`,
`retry_queued`, `parked`, `released`. An item's tracker state is separate from
its claim state.

- **A retry, a continuation, and a park keep the claim.** That is what makes one
  external item one continuous owner for its whole active life.
- **A release ends the claim lifetime.** Counters, queued retries, and parking
  are cleared with it.

Release reasons:

| Reason | When |
|---|---|
| `terminal` | the item reached a terminal state |
| `inactive` | the item left the active states but is not terminal |
| `unroutable` | `dispatchable` is false, a required label is missing, or the host filter failed |
| `missing` | the refresh no longer returns the item |
| `reset` | `resetItem({ identifier })` |
| `claim_failed` | a due retry could not re-acquire its claim |
| `settle_error` | the settle path threw before a decision |
| stop | `stop()`'s reason for queued rows; a running attempt that settles after the abort releases with the literal `stopped` |

`resetItem({ identifier })` clears the counters, the queued retry, and parking,
then releases the claim so the next fetch can re-claim the item. It refuses a
running attempt with `SchedulerError('invalid_attempt')`, and it stays available
after `stop()`.

---

## 4. Eligibility and ordering

The adapter contract requires normalized `WorkItem`s. The scheduler trusts the
records its source returns and itself checks the dispatch-facing fields: state,
`dispatchable`, required labels, identifier uniqueness, claims, and slots. An
item is dispatch-eligible only when all of these hold:

- its state is active and not terminal;
- `dispatchable === true`;
- every `requiredLabels` entry is in `item.labels` (labels are trimmed and
  lowercased on normalization);
- the host `filter({ item })` returns true (a throw means false);
- its identifier is unique in this fetch;
- it is not running, claiming, claimed, or parked;
- its lane and the global pool both have a free slot.

A full lane **skips** the item and continues the scan. Only a full global pool
**stops** the scan.

`sortForDispatch` orders without mutating the input:

1. priority `1..4` ascending;
2. every other integer, `null`, and a non-number share bucket `5`;
3. then `createdAt` oldest first, `null` last;
4. then `identifier` in code-unit order;
5. then the original array index, so the order is stable.

---

## 5. Claims

A claim is the scheduler's one-owner guarantee for an item's active lifetime.
Two stores implement it:

| Store | Survives a process restart | Use |
|---|---|---|
| `createMemoryClaimStore()` | no | the default; tests and one short-lived process |
| `createFileClaimStore({ dir, staleMs?, hostId?, now? })` | yes | a second-process guard on one machine |

The scheduler's owner token is `host:pid:uuid`. A same-owner `acquire` is
idempotent: a retry or continuation never moves the claim's start time.

The file store is one `<key>.json` per identifier, where `<key>` is the same
deterministic workspace key the workspace layer derives. `claims.mjs` imports the
pure `workspaceKeyFor` helper (not the manager), so the two never drift. The
create is `writeFile(..., { flag: 'wx' })` (O_EXCL), which is the lock. A stale
claim is reclaimed with a hard link plus an inode compare-and-swap.

- **A live same-host pid is never displaced**, however old the claim is. A dead
  one is reclaimable at once. A foreign host is governed by age (`staleMs`,
  default six hours).
- **Release requires the exact owner and host token.** A different host can never
  release this host's claim.
- **`isClaimed` is diagnostic only.** Eligibility uses the scheduler's
  in-process set, never a filesystem probe.

**The election bound.** With `N > 2` synchronized reclaimers of one stale claim,
several can each return `true`: each later winner unlinks the previous winner's
fresh claim. The cost is a duplicate dispatch and the displaced owner's claim
file — it can no longer release and may run alongside the last winner. It is
never user-data loss. The measured rate is zero at two processes; the
`stat`→`unlink` pair is not atomic, so a duplicate is not proven impossible even
at two. The stronger fix, out of scope for this slice, is generational `wx` claim
files: the highest generation wins and a takeover creates `gen+1`, which removes
the unlink window entirely.

Hard links are required (POSIX/APFS/ext4). Where `link` is unsupported the
reclaim fails closed and the item is not reclaimed. A torn or partially written
claim is indistinguishable from an unreadable one, so it **blocks until someone
removes it by hand**; nothing here unlinks a file it could not parse.

---

## 6. Work sources

The contract is two methods:

```js
fetchByStates({ states, signal }) → WorkItem[] | Promise<WorkItem[]>
fetchByIds({ ids, signal })       → WorkItem[] | Promise<WorkItem[]>
```

The scheduler awaits both shapes. Four adapters ship:

| Adapter | Storage | Notes |
|---|---|---|
| `createMemoryWorkSource({ items, eventEmitter? })` | a host array, captured by reference | filters by state and dedupes by `id` |
| `createJsonFileWorkSource({ dir, eventEmitter? })` | one `*.json` file per item | async; the directory must exist at construction; the file stem **is** the item `id`; never writes |
| `createFunctionWorkSource({ fetchByStates, fetchByIds, eventEmitter? })` | two host functions | the escape hatch for a real tracker |
| `createTodoWorkSource({ store, includeInternal?, eventEmitter? })` | the SDK's own todo `Map` | maps a todo status to `state`; every todo with a valid non-terminal status is dispatchable; reads the live store |

### SDK todos

The SDK already keeps a task list, so a host with no tracker can feed the
scheduler from a `TodoComponent` store without writing an adapter:

```js
import { TodoComponent } from 'merci-sdk';
import { WorkScheduler, createTodoWorkSource } from 'merci-sdk/scheduler';

const store = new Map();                          // shared with the component
const todos = new TodoComponent({ store });
await todos.save({ args: { action: 'add', title: 'Write the release notes' } });

const workflow = { run: async ({ item }) => ({ status: 'completed' }) };
const scheduler = new WorkScheduler({
    workSource: createTodoWorkSource({ store }),
    workflow,
    activeStates: ['pending', 'in_progress'],     // the status vocabulary lives here
    terminalStates: ['completed', 'failed'],
});
await scheduler.start();
```

The list path filters with the caller's `states`, exactly like
`createMemoryWorkSource`, so the vocabulary stays in the scheduler's own
`activeStates`: use `['pending', 'in_progress']` for the component's documented
lifecycle and `terminalStates: ['completed', 'failed']` to match its statuses.
`dispatchable` is `true` for every todo with a valid non-terminal status
(`pending`, `in_progress`), so the component flipping a todo to `in_progress`
when work starts is not read as an inactive item; `completed` and `failed` are
`false` and are never dispatched, and a missing or blank status is malformed.

The store is read live on every call and never snapshotted, so `TodoComponent`
must have hydrated it first: with a `filePath`, `await todos.load()` (or any
`save()`) before `scheduler.start()`, because the adapter only sees what is in
the map. Numeric and string ids both become the string `id` and `identifier`;
any other id value is skipped as a malformed record on the list path, and an
unreadable requested id is simply not found on refresh rather than a throw. A
status is trimmed and lowercased once, so `' Pending '` lists as `pending`.
Todos whose id starts with `dag:` are `PlanningExecutor`'s internal step mirrors
and are skipped; pass `includeInternal: true` to schedule them.

**List and refresh are asymmetric.** On `fetchByStates`, one malformed record is
skipped and reported as `work_item:skipped`; the scan continues. On
`fetchByIds`, the caller asked for that exact record, so a malformed one throws
`WorkSourceError`. JSON's *missing* file is different from a malformed one: it
means "no longer visible" and is omitted.

**`id` is the refresh key; `identifier` is the scheduling key.** The scheduler
refreshes by `item.id` and keys claims, workspaces, and checkpoint threads by
`identifier`. The JSON adapter makes the **file stem** the record `id` (it must
equal `record.id.trim()`); `identifier` is independent and may differ. So one
JSON record can be refreshed by a stem while its claims and workspace are keyed
by a different scheduling identifier.

**Joining events.** `work_item:*` carries the provider `workItemId` and the
human `identifier`, except `work_item:skipped`, whose payload is the queue
record. The scheduler passes that identifier into the workspace
manager; with the SDK `WorkspaceManager`, `workspace:*` carries the same
`identifier` and a `workItemId` equal to it. A duck-typed manager may ignore the
option. A host that supplies only its own workspace `workItemId` gets no
identifier and must pass one to join the namespaces.

### Identity and list-path skips

Ids are compared after `trim()`: `' MER-1 '` and `'MER-1'` normalize to the
same id, so two records whose ids differ only by surrounding whitespace name
one item (a source that dedupes by id keeps one of them; the function list path
leaves that to the host).

The list path reports a skipped record as `work_item:skipped { source, index,
file, reason }`:

| Reason | Where it applies |
|---|---|
| `malformed` | memory, JSON, function, and todos — an unreadable or corrupt file (JSON: EISDIR/EACCES, a deleted or invalid JSON), or a record `normalizeWorkItem` rejects |
| `id_filename_mismatch` | JSON only — the trimmed record id differs from the file stem |
| `duplicate_id` | the memory list (two in-state records with one id), the todos list and refresh, the memory refresh, and the function refresh (two returned records with one id) |
| `unsafe_id` | JSON only — a stem that cannot name an id on every platform (a separator, NUL, `.`/`..`, an escaping path); emitted on the list path, while the refresh path silently omits such an id because it can never name a file |

Dedupe is per adapter and per path:

- **memory** dedupes its list by `id` after the state filter (first wins, each
  extra is `duplicate_id`), and treats a refresh's ids as a set.
- **JSON** dedupes its list by `id` through the stem rule (one file name is one
  id), and treats a refresh's ids as a set.
- **todos** dedupes its list by `id` after the caller's state filter (first
  wins, each extra is `duplicate_id`), and treats a refresh's ids as a set.
- **function** trusts the host on the list path: it does not dedupe by `id` and
  does not re-filter state. It passes `states` to the host, and the scheduler's
  AC5 eligibility check decides what may dispatch. Its refresh path treats the
  caller's ids as a set (duplicates collapse before the host call), keeps the
  first returned record for an id, and reports each extra as `duplicate_id`.

The function adapter's missing state re-filter is deliberate: the host already
received `states`, so its answer is authoritative, unlike memory, JSON, and
todos, which hold every record and must filter locally.

`WORK_SOURCE_CATEGORIES` is the frozen eight-value vocabulary a
`WorkSourceError.category` may use:

`unsupported_tracker_kind`, `invalid_tracker_config`, `missing_tracker_secret`,
`tracker_request`, `tracker_status`, `tracker_response`, `tracker_pagination`,
`tracker_rate_limited`.

Every operation accepts an optional `AbortSignal` and honours it: an aborted
signal throws `AbortedError` at entry and after each awaited step. Cancellation
is never converted into a `WorkSourceError`.

---

## 7. Retries, continuations, and parking

A failed attempt retries with capped exponential backoff:

```
delay = min(retry.baseMs * 2^(n - 1), retry.maxMs)
```

`n` is the failure ordinal, so the defaults give 10 s, 20 s, 40 s, and so on. A
due retry is evaluated on a tick, never with a timer of its own.

- `limits.maxAttemptsPerItem` (default `5`, counting the initial attempt) parks
  the item when the failure count reaches the bound.
- Three classes park on the first failure: `permission_block`,
  `environment_mismatch`, and `invalid_workflow`. A result flagged
  `nonRetryable: true` parks on its first failure too, whatever its class.
- A timeout is a failure, not a cancel. `TIMEOUT_CODES` covers
  `HEADER_TIMEOUT`, `BODY_TIMEOUT`, `STEP_TIMEOUT`, `STREAM_TIMEOUT`, and the
  host spellings `ETIMEDOUT`, `TIMEOUT`, `timeout`, so a stalled stream retries
  and counts in `totals.failures`. `CMD_TIMEOUT` is deliberately not in the set:
  a shell command timeout is a tool failure, and adding it would change retry
  decisions.
- An attempt is `canceled` when its signal aborted, or when the workflow threw an
  abort-shaped error: `AbortError`, `CanceledError`, `AbortedError`, an
  `ABORT_ERR` / `ERR_CANCELED` / `MERCI-ABORTED-ERR` code, or any of those
  nested in `cause`. A canceled attempt that carries error evidence (an
  `errorCode` or `errorName`) still counts in `totals.failures`, so a vendor
  `CanceledError` is not invisible; a host stop, a host `cancelItem`, and a bare
  `canceled` result do not count. None of them changes the retry or park
  decision, which comes from the class.
- A failed result carries its own evidence: `errorCode`, `errorName`, and a
  nested `error` are read from the returned object, so the taxonomy sees the
  code the workflow chose instead of `unknown`.
- The agentic loop's own `run:end` now carries `failureClass` for a failed run:
  the same evidence and taxonomy the scheduler uses, so the two agree on
  `ENOENT`, `ENOTDIR`, a `TimeoutError` name, a guardrail block, a rate limit,
  and a plain error (`unknown`). A budget or max-turns stop also reports
  `unknown`, while `finishReason` names the stop (`budget` / `max_turns`). It is
  diagnostic — the scheduler still reclassifies from the error code, so a
  workflow's class is never a second gate. One parity boundary is intentional:
  an error that is both abort-shaped (`name: 'AbortError'`) and timeout-coded
  (`STEP_TIMEOUT`, `STREAM_TIMEOUT`, `ETIMEDOUT` — the shape
  `support/stream-timeout.mjs` produces) is reported `aborted` by the loop,
  whose abort check runs first, while the scheduler normalizes it as `failed`
  / `transient_infrastructure` and reclassifies from the code.
- A **source error or no free slot (global or lane)** at a retry fire re-queues
  the *same* attempt number with the base delay. It does not consume the item's
  attempt budget.

A clean completion may schedule **one continuation retry** after
`continuation.delayMs`. `continuation.max` is the number of continuation retries
it may schedule (`0` disables them). A completed attempt with **no continuation
scheduled is parked, not released**: it emits `completed`, then `parked`, and
keeps the claim. That happens for `progress: false` (`no_progress`), for
`continuation.max: 0` (`continuations_disabled`), and when the bound is reached
(`continuations_exhausted`).

Parking keeps the claim and its counters. The park reasons are:
`non_retryable`, `attempts_exhausted`, `no_progress`, `continuations_disabled`,
and `continuations_exhausted`. A parked item is re-checked with
`min(retry.maxMs * 2^checks, 6 h)`; a still-active item extends the backoff, and
anything else releases the claim (a terminal item also gets its workspace
cleaned, §9). `resetItem({ identifier })` un-parks immediately.

`cancelItem({ identifier })` ends one active item without stopping the
scheduler: a running attempt is aborted and parked with reason `canceled`, and
a queued retry is parked. The claim is kept, so an active tracker item is not
redispatched on the next scan; `resetItem({ identifier })` un-parks it.
`stop()` remains the only way to abort every attempt at once.

A continuation runs as attempt `1`, so the dispatched ordinals of one claim
lifetime can read `[1, 2, 1]` — an initial attempt, one failure retry, then a
continuation. That is the documented numbering, not a bug.

`run()` receives the kind as well: `attempt` is the dispatch ordinal and
`continuation: true` marks a continuation. A prompt renderer therefore maps the
pair to the contract's retry index — `null` on the first dispatch, `1` on the
first retry (dispatch 2), and `1` on a continuation (dispatch 1 again). See
[`docs/WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md#6-the-template-subset) for the
template side.


---

## 8. Reconciliation and the stall watchdog

While an item runs, every tick refreshes it by `id`:

| Refresh result | Disposition |
|---|---|
| terminal state | abort, then clean its workspace |
| still active and routable | update the item and keep running |
| active but unroutable | abort without cleanup |
| inactive | abort without cleanup |
| missing | abort without cleanup |

The disposition is written **before** the abort, so a run that settles later
cannot schedule a retry for an item reconciliation already ended. A terminal
disposition is final and is never downgraded to inactive or unroutable.

The stall watchdog aborts an attempt whose `now - lastProgressAt >
stallTimeoutMs` (default 15 min; `0` disables it) and schedules a failure retry —
unless the attempt cap or a non-retryable class parks it.
`reportProgress()` refreshes `lastProgressAt`, and `createEngineRunner` calls it
from engine events: agentic stream events, DAG step events, state-machine node
events, and discussion agent events. A stall is still classified: a permission,
environment, or workflow code parks instead of retrying.

---

## 9. Workspace requirement

A workspace manager is **duck-typed**. The scheduler needs `ensure`,
`beforeRun`, `afterRun`, `remove`, and `handleFor`; it never imports the manager.

`concurrency.global > 1` requires a manager, unless the host explicitly accepts
shared state with `allowSharedWorkspace: true`. Validation refuses the
combination without either.

One attempt runs:

```
ensure({ workItemId, identifier, ownerId }) → beforeRun({ workspace }) → workflow.run({ workspace }) → afterRun({ workspace, outcome })
```

`workItemId` and `identifier` are the item's scheduling identifier — the
workspace key derives from it. `ownerId` is the **real item id** (`item.id`):
a tracker can recycle an identifier for different work, and the manager's owner
marker uses `ownerId`, not the key, to decide whether a kept directory belongs
to this item. Without it a recycled identifier inherits the previous item's
tree (W1-2). A duck-typed manager may ignore `ownerId`; the SDK manager does
not. See [`docs/WORKSPACES.md`](WORKSPACES.md#5-keys-and-handles).

`afterRun` runs whenever `beforeRun` succeeded — including when the workflow
failed — and its failure never fails the attempt. An `ensure` or `beforeRun`
throw is an ordinary attempt failure, so it retries.

Cleanup runs **only for a terminal item**, with `force: false`: a running entry
reconciled to terminal, a retry that fires terminal, a parked item re-checked
terminal, and the startup sweep. A `directory` workspace that is non-empty is
retained; a dirty worktree — uncommitted **or git-ignored** files — is refused.
The refusal emits `work_item:workspace_cleanup_refused` and the workspace is
**never forced** — the work survives for the host to inspect. A kept workspace
whose key is later handed to a different work item is renamed aside by the
manager (`<key>.orphan-<ts>`) rather than reused; see
[`docs/WORKSPACES.md`](WORKSPACES.md#5-keys-and-handles).

`startupCleanup` (default `true`) fetches the configured terminal states once at
`start()` and calls `handleFor` + `remove({ force: false })` per item. It needs a
manager and at least one terminal state; otherwise it does nothing. A failure is
contained so `start()` never rejects for cleanup.

---

### Workspace events in the trace

Every `ensure`/`beforeRun`/`afterRun` and the terminal `remove` for a live
attempt run under that attempt's `RunContext`, so `workspace:created`,
`workspace:hook_*`, and `workspace:removed` carry the same `runId` as the
`work_item:dispatched` that caused them. A cleanup for a parked item, a
reconciliation release, or the startup terminal sweep has no live attempt and
runs under the scheduler's own context (`scheduler:start`/`scheduler:tick`).
A workspace manager passed by the host emits on its own `eventEmitter`; the
facade (`docs/ORCHESTRATION.md`) passes the same emitter to every layer.

---

## 10. Cost controls

`limits.maxDispatches`, `limits.maxTotalTokens`, and `limits.maxTotalUsd` are a
**stop-new-work threshold, not a reservation**. An attempt that was already
running when the limit was crossed keeps running and its spend still lands in the
totals, so the aggregate can overshoot by that attempt's own usage.

- `dispatches` counts every successful start, retries and continuations included.
- `maxTotalTokens` is enforced on the reported token sum; `usageComplete: false`
  means that sum may be incomplete, so the guard is a threshold on what was
  reported, not a proof of total spend.
- `maxTotalUsd` is live once every settled attempt has reported a finite
  `cost_usd` (`costComplete`). `costComplete` is **monotonic**: one attempt
  without a cost disables the USD guard for the instance lifetime.
- The event `scheduler:budget_exhausted` fires when a dispatch is actually
  blocked — after the item is otherwise eligible and a slot is free — and **once
  per scheduler lifetime**. Raising a limit later resumes dispatch without a
  second event, because the operator already has the fact.
- A blocked retry is re-queued at the same attempt, not dropped, so raising a
  limit resumes it on a later tick.

Attempt usage depends on the engine. For a budgeted `dag`, `stateMachine` or
`discussion` attempt the engine runner creates **one cap-less ledger per `run()`
call** and gives every session the engine creates that same ledger, then reports
only the ledger's growth during that attempt, so the attempt's own model calls
and every delegated child are both in the totals. A budgeted `agentic` attempt
reports the delta of the pool its session already owns. A failed or canceled
attempt still reports its growth.

The attempt ledger is a report, never a second gate: it is owned by the runner,
its `maxTotalTokens` and `maxBudgetUsd` stay `null`, and a session's
`withBudget()` cannot move them. A hook or a code-agent `execute` body receives a
frozen read-only view of it (caps as getters, usage as a frozen copy of the live
totals): it charges the ledger by calling the `client` it was given, never by
writing `budgetPool`. The per-attempt budget still reaches each DAG step,
state-machine node, or discussion agent, so a runner-level USD cap is per unit
rather than per attempt.

An unbudgeted runner creates no ledger and keeps the old numbers: `agentic`
reports the session's own usage, `dag` and `stateMachine` their engine's own
accounting, and `discussion` its session's.

The attempt ledger covers what the runner can see, not every possible call.
Folded are the attempt's step, node and turn sessions; nested engines; the
objective (including the session-level restatement), judge and aggregate sessions
those engines create through their client; a host `planFor`, `graphFor`, `tools`
or `agents` factory that spends through the `client` it is given; a code-agent
profile's `execute` body when it uses the `client`/`budgetPool` the SDK passes it;
a non-LLM discussion agent (`execute({ client, budgetPool })`); task children
delegated on a profile's own client (the child inherits the parent session's
ledger); a discussion agent resolved to its own client (the runner wraps that
client in a view over the ledger); and a budgeted subtree (below).

The ledger and its `before` snapshot are taken before any host hook runs, so a
hook's spend is inside the attempt's delta rather than before it. The bags are
per hook: `tools` and `agents` get
`{ item, attempt, workspace, client, budgetPool, runContext }`, `planFor` and
`graphFor` get `{ item, attempt, signal, client, budgetPool, runContext }`, and
`prompt`, `objective` and `threadId` get `{ item, attempt }`. `tools`, `agents`,
`planFor` and `graphFor` may return a Promise and are awaited; a thenable
non-Promise (a graph object with a `then` transition verb) is passed through as
is. A zero-step plan reports exactly the hook's own call; a planned unit adds its
spend, and a first-step objective restatement may add one more model call, so a
one-step plan has no fixed total. What stays out is a call made through a client
the host built itself and kept outside the `client` it was given: the SDK cannot
see that client, so that spend is the host's own. A client a host kept past
`run()` joins nothing either — its ledger is closed, so a later call is
unreported instead of charging a finished report or blocking the next attempt.

A budget present **when the session joins the attempt** (a session handed back by
the client with `_budget` already set) becomes a subtree cap. The exact rule: a
child's own budget (its `profile.budget`, or a budget its own session already
carried) caps that child's per-spawn subtree with a fresh ledger, so a memoized
child neither accumulates nor escapes through a wider descendant; a step, node
or discussion unit's budget caps that unit's subtree. Each such ledger links under
the attempt ledger and each charge also propagates to it, so the spend is
reported once. A budget applied **after joining** creates its own capped ledger
linked under the attempt ledger:
the attempt's caps stay `null`, the unit's descendants are bounded by that cap,
and each charge folds into the attempt once. The discussion subagent
pseudo-parent is the in-repo case of the first rule.

One session object per **live** attempt is required. A session that still carries
another attempt's ledger is refused with `session_reused_across_attempts`, and so
is a session whose budgeted ledger has a live foreign parent. A budgeted session
reused sequentially is re-linked to the new attempt ledger and each attempt
reports its own delta. A task-profile client that memoizes its child is likewise
re-linked for each sequential attempt, so each attempt reports its own spend; a
child live in two attempts at once is refused with
`session_reused_across_attempts`, and a released ledger accepts no new child. A
task child keeps its ledger reference until the attempt releases it, which is
what lets a `continueWith` turn charge the same open ledger; a continuation that
starts after the release is uncharged, because the ledger is closed. The release
also detaches a memoized child, so the next sequential attempt starts clean. A
code agent is the exception: the sessions its `execute` opens through the
provided `client` are detached when it returns.

A budgeted silent provider charges the engine's token estimate into the pool, so
the scheduler counts estimated tokens and `usageComplete` stays true;
`usageComplete` means the attempt reported a usage object, not that the provider
reported exact tokens.

Run `node examples/31_orchestration.mjs` for the offline walkthrough: four
vendor calls, three folded into the attempt's total (a `planFor` session, the
objective restatement, the step), one through the host's own client left out, a
200-token unit budget, and a 360-token attempt total that completes anyway.
Those three are the script's one-step, default-cadence count, not a fixed
formula: the walkthrough names the count so a cadence change is visible.

Duplicate identifiers fail closed for the tick: every duplicated identifier is
excluded and reported as `scheduler:validation_error`; the rest of the fetch is
still considered. A duplicate that appears while one copy is running keeps the
running attempt and blocks the other.

---

## 11. Restart and resume

**The tracker is the source of truth.** The scheduler holds no durable queue of
its own. Retry due times are process-local, and the only scheduling timer is the
poll timer (`stop()` can arm a bounded drain timeout while attempts are running);
file claims survive a restart, and a workspace is reused by `identifier`.

Run `node examples/30_scheduler.mjs` for the offline walkthrough: a failure
written by one process, one more dispatch and a park after the restart, a
no-store control that forgets the failure, and `resetItem` re-arming the item.

**Attempt state survives when you give it a store.** Pass
`attemptStore: createFileAttemptStore({ dir })` (`merci-sdk/scheduler`); one
record per identifier is written atomically. **One store directory belongs to
one scheduler process**: two schedulers over the same directory are
uncoordinated and may clear each other's records.

`start()` hydrates a record only for an item that is currently **active** in the
source. The persisted `attempts` is a **failure count**, not a dispatch ordinal,
so the first attempt after a restart is still dispatched as attempt 1; a count
that already reached `limits.maxAttemptsPerItem` is parked at hydration (reason
`attempts_exhausted`), never given one extra dispatch. `id` is part of the
record: if the source reports the same `identifier` with a different `id`, the
item was re-created, its old record is cleared, and it starts fresh.

| Survives a restart | Does not survive |
|---|---|
| attempt (failure) count; the retry budget continues | a queued retry (`#retries` is never persisted) |
| continuation count | the in-flight attempt itself |
| parked reason, `at`, and `nextCheckAt` | a parked item's claim (released by `stop()`) |

- A crash mid-retry re-queues the item at the same **failure count**, not with a
  fresh retry budget.
- The parked re-check counter (`checks`) resets to 0; `nextCheckAt` is what a
  restart honors.
- `createMemoryAttemptStore()` is the default: it survives only the process, but
  a `start()` after `stop()` on the same instance keeps its parks and counts.
  `attemptStore: null` disables persistence.
- A corrupt, unreadable, mismatch-named, or wrong-version record is skipped with
  a warning and reads as absent; that item restarts at attempt 0. Nothing is
  repaired or quarantined.
- A record for an item that is terminal or missing at every start is never
  garbage-collected by hydration; it is retained and re-adopted as a park if the
  same `identifier` and `id` become active again, and only a terminal release or
  `resetItem` clears it.
- A custom attempt store whose `load` or `list` throws is skipped silently (no
  warning), unlike the file store, which warns and never quarantines.
- A write failure is reported as `scheduler:internal_error` and never crashes a
  tick or fails `stop()`; it is event-only and never retried, so a restart may
  lose that park or count, and `resetItem` waits for an in-flight hydration load
  for its identifier, so a hung store delays the admin path.

- `start()` runs the terminal cleanup sweep, then ticks immediately.
- Calling `start()` after `stop()` resumes the same instance: the stop flag is
  cleared, the claim store is unchanged, and the next tick reconciles. Use it
  for a dev reload or an admin pause; a stopped instance never restarts on its
  own.
- A file claim left by a crash is reclaimed through the dead-pid or stale path.
- `snapshot().completed` is recent bookkeeping (bounded) and never gates
  dispatch.

A resumed engine run is not a resumed *attempt*. The DAG runner restores the
checkpoint with the real executor options, reattaches steps, retries failed
steps, and reports only the attempt's usage. The agentic runner resumes the
conversation from its checkpoint. The scheduler passes the attempt's own thread
id into `run()`, so `snapshot().running[].threadId` is the thread the store saw
for store-backed engines; a custom runner `threadId` resolver must be pure and
unique per item, and reusing one thread id for a different item is refused as
`thread_collision`.

**The caveat:** cross-attempt at-most-once is **not guaranteed for agentic**.
A tool side effect from an earlier attempt can repeat when the conversation is
continued. For side-effecting work, use the DAG or state-machine engine, whose
execution journal and checkpoint are persisted across attempts.

---

## 12. Live reconfiguration

`applyConfig({ options })` merges a partial patch and returns
`{ applied, deferred, changed }`.

It may change: `activeStates`, `terminalStates`, `requiredLabels`,
`pollIntervalMs`, `stallTimeoutMs`, `concurrency`, `retry`, `continuation`,
`limits`, `filter`, and `preflight`.

- An absent key preserves the current value. Scalars and arrays replace.
- A known sub-object (`concurrency`, `retry`, `continuation`, `limits`)
  **replaces** wholesale, so pass the complete sub-object. `limits.*` may be
  `null` to unset.
- Construction-bound options — `workSource`, `workflow`, `workspace`, `claims`,
  `attemptStore`, `clock`, `eventEmitter`, `signal` — throw
  `SchedulerError('bound_option')`.
- The merged config is validated **before** applying. An invalid patch throws
  `ConfigurationError` and leaves the current config and timers untouched.
- A patch during a tick is stored and applied at the start of the next tick,
  never mid-tick; two patches merge. Otherwise it applies immediately and
  reschedules the poll timer.
- `changed` lists the top-level keys whose effective value differs, sorted. No
  change means nothing is applied and no event is emitted. A no-op patch does
  not cancel an already-queued pending patch; that patch still applies at the
  next tick.
- A change emits `scheduler:configured { source: 'reload', changed }` once.
- Running work is never restarted or aborted. A concurrency reduction below the
  current running count takes effect for future dispatches only.

`applyConfig` requires `start()` (`not_started`) and refuses after `stop()`
(`stopped`); call `start()` to resume the instance first (§11).

---

## 13. Events

There are **21 scheduler and work-item leaves in addition to the shared
vocabulary**. Every payload carries identifiers and metadata only: no
description, no prompt, no tool arguments, and never an `err.message`.

| Event | Payload keys |
|---|---|
| `scheduler:start` | `pollIntervalMs`, `concurrency`, `activeStates`, `terminalStates` |
| `scheduler:stop` | `reason`, `running`, `retrying`, `parked`, `drained` |
| `scheduler:tick` | `outcome`, `fetched`, `dispatched`, `running`, `retrying`, `parked`, `claimed` |
| `scheduler:validation_error` | `errors` |
| `scheduler:work_source_error` | `op`, `category` |
| `scheduler:budget_exhausted` | `limit`, `totals` |
| `scheduler:internal_error` | `op`, `errorName`, `errorCode` |
| `scheduler:configured` | `source`, `changed` |
| `work_item:skipped` | `source`, `index`, `file`, `reason` |
| `work_item:claimed` | `workItemId`, `identifier`, `attempt`, `owner` |
| `work_item:claim_failed` | `workItemId`, `identifier`, `reason` |
| `work_item:dispatched` | `workItemId`, `identifier`, `attempt`, `lane`, `state`, `priority`, `runId` |
| `work_item:continued` | `workItemId`, `identifier`, `attempt`, `delayMs` |
| `work_item:retry_scheduled` | `workItemId`, `identifier`, `attempt`, `delayMs`, `dueAtMs`, `failureClass` |
| `work_item:stalled` | `workItemId`, `identifier`, `attempt`, `idleMs` |
| `work_item:reconciled` | `workItemId`, `identifier`, `reason`, `cleanup` |
| `work_item:completed` | `workItemId`, `identifier`, `attempt`, `durationMs`, `usage` |
| `work_item:failed` | `workItemId`, `identifier`, `attempt`, `failureClass`, `errorName`, `errorCode` |
| `work_item:released` | `workItemId`, `identifier`, `reason` |
| `work_item:parked` | `workItemId`, `identifier`, `reason`, `attempts`, `continuations`, `nextCheckAt` |
| `work_item:workspace_cleanup_refused` | `workItemId`, `identifier`, `reason` |

`work_item:skipped` carries the source and position, never an unknown id,
title, or record text. `usage` is numeric only. A `scheduler:tick` with outcome
`stopped` reports `fetched: 0` and `dispatched: 0` even if a fetch had
completed. A stop that lands after the claim is acquired but before
`work_item:claimed` is emitted produces `work_item:released` with no preceding
`work_item:claimed`.

---

## 14. Wiring

Everything below is offline: the source is empty, so `start()` never dispatches a
model call. Swap in a tracker adapter and real items to run work.

```js
import {
    WorkScheduler, createEngineRunner, createMemoryWorkSource, createFileClaimStore,
    createFileAttemptStore,
} from 'merci-sdk/scheduler';
import { WorkspaceManager } from 'merci-sdk/workspace'; // optional

const workSource = createMemoryWorkSource({ items: [] }); // a tracker adapter in real use

const workflow = createEngineRunner({
    engine: 'agentic',
    client,                             // an initialized provider client
    model: 'gpt-4o',
    prompt: ({ item }) => item.title,   // the full item goes to the runner, not to events
    store,                              // optional { load, save } for resume
});

const scheduler = new WorkScheduler({
    workSource,
    workflow,
    workspace: new WorkspaceManager({ strategy: 'directory', root: '/tmp/merci-workspaces' }),
    claims: createFileClaimStore({ dir: '/tmp/merci-claims' }),
    attemptStore: createFileAttemptStore({ dir: '/tmp/merci-attempts' }),
    activeStates: ['in_progress'],
    terminalStates: ['done', 'canceled'],
    pollIntervalMs: 30_000,
    concurrency: { global: 2, byLane: { review: 1 } },
    limits: { maxAttemptsPerItem: 5, maxDispatches: 50, maxTotalTokens: 2_000_000 },
});

await scheduler.start();              // validates, cleans terminal workspaces, ticks once
const view = scheduler.snapshot();    // rows, totals, limits — no IO

await scheduler.applyConfig({ options: { limits: { ...view.limits, maxDispatches: 100 } } });

await scheduler.stop();               // { drained, running, retrying, parked }
```

`limits` is replaced wholesale by `applyConfig`, so the snippet spreads the
current snapshot limits before changing one field.

---

## 15. Errors

`WorkSourceError` (from the main entry) carries `category`, `source`,
`retryable`, and an optional `retryAfterMs`. `category` is one of the eight
`WORK_SOURCE_CATEGORIES` values above. A malformed record uses
`tracker_response`; a host function's plain throw becomes `tracker_request` with
the original error attached as `cause`. The message never copies a field value,
a record title, or a provider payload.

`SchedulerError` (from the main entry) is lifecycle misuse, not work-item data:

| `reason` | Meaning |
|---|---|
| `already_started` | a second `start()` |
| `not_started` | `tick()`, `resetItem()`, or `applyConfig()` before `start()` (`refresh()` validates first, then ticks) |
| `stopped` | `applyConfig()` after `stop()` |
| `invalid_attempt` | `resetItem()` on a running item |
| `bound_option` | `applyConfig()` tried to replace a construction-bound option |

Bad configuration throws `ConfigurationError` instead. A malformed work record
is a `WorkSourceError`; an invalid scheduler option is not.

---

## Where to look next

The workspace lifecycle the scheduler calls is specified in
[`docs/WORKSPACES.md`](WORKSPACES.md); the composition root that builds this
scheduler, its runner and its workspace from one call is
[`docs/ORCHESTRATION.md`](ORCHESTRATION.md). Runnable programs live under `examples/`;
the scheduler's public subpath is `merci-sdk/scheduler`.
