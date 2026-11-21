# Workspaces — the contract

A workspace is **one work item's own directory**, and the directory an agent run
uses as its working directory. `WorkspaceManager` creates it once, hands it to a
run, and removes it at the end:

```
ensure → beforeRun → work → afterRun → remove
```

Two items that run at the same time cannot reach each other **through the bound
tools**, and every bound coding tool defaults inside that item's workspace; an
approved shell operand can still leave. This page is the whole contract: what
isolation means here, the two strategies, the lifecycle, the hook trust
boundary, the worktree caveats, the artifact boundary, and the wiring.

---

## 1. What isolation is — and is not

**It is a path invariant.** The manager never creates, runs a hook in, or
deletes a path outside its configured root. The binder builds every tool with
the workspace path it owns:

| Tool | Confinement |
|---|---|
| `read` / `grep` | a path outside the root is denied (`tool:path_denied`) |
| `glob` | resolves inside the root only; a pattern pointing outside returns no matches |
| shell | `cwd` and `roots` are the workspace; an operand outside it escalates to the approval callback |
| artifacts | the directory must resolve inside the workspace root |

**It is not an OS sandbox.** It is path confinement plus the approval gates the
SDK already has. An approved shell command can leave the workspace — a
`cd /` or an absolute operand that the operator approves is allowed by design.
Hooks are host code and run with the host's authority (§4). A host that needs
OS-level isolation needs a container, a VM, or a separate user; this layer does
not pretend to provide one.

---

## 2. The two strategies

| Strategy | What it creates | Use it when |
|---|---|---|
| `directory` *(default)* | a plain directory, `<root>/<key>` | the work item does not need git history, or the host manages versions itself |
| `git-worktree` | a real `git worktree` at `<root>/<key>`, on branch `merci/<key>` (or detached) | an agent edits code that must be isolated on its own branch and must never touch the host checkout |

`git-worktree` needs `repoRoot`; the constructor refuses the strategy without
it. Each creation probes the repository, and the common git dir is cached for
the identity checks that follow, so `repoRoot` may itself be a linked worktree.
Branch and base ref are per-call options: `ensure({ workItemId, branch, baseRef })`;
`branch: null` opts into a detached worktree.

`directory` is cheaper and works outside git. `git-worktree` is the right
default for coding agents, because the work survives as commits on a named
branch.

Next to each `<root>/<key>` the manager keeps one sibling,
`<root>/<key>.merci-owner.json` — the owner and readiness marker described in
§5. It is never inside the workspace, so it does not show up in the worktree's
git status or in a plain directory's emptiness check.

---

## 3. Lifecycle

| Step | Method | What it does |
|---|---|---|
| **ensure** | `ensure({ workItemId, branch?, baseRef? })` | derives the key, creates the workspace (or reuses it), runs `afterCreate` on creation — and again on a reuse that has no `ready` marker — returns a frozen handle with `createdNow` |
| **beforeRun** | `beforeRun({ workspace })` | validates the handle, runs `beforeRun`, then marks the key active |
| **work** | — | the host runs the session with `workspace.path` as its root |
| **afterRun** | `afterRun({ workspace, outcome? })` | runs `afterRun`, clears the active guard; never throws except a caller abort |
| **remove** | `remove({ workspace, force? })` | runs `beforeRemove`, removes the directory or worktree, prunes stale worktree metadata, drops the owner marker |

`afterRun` accepts `outcome` for scheduler symmetry; it is not passed to the
hook today.

The methods that take a handle — `beforeRun`, `afterRun`, and `remove` —
re-validate it before any IO: the `lstat` and `realpath` checks are the
validation itself, proving the root is this manager's root, the path is the one
it derives for that key, and it is an existing directory inside the root (not a
symlink) before a hook runs in it. `afterRun` and `remove` tolerate a missing
path instead of throwing.

`remove` refuses without `force: true` when the workspace is active, dirty, or
non-empty, and for a detached worktree whose HEAD has a commit reachable from no
ref. **Dirty includes git-ignored files**: a worktree holding only `out/` or a
generated report is work, so `git status --porcelain --ignored=matching` reports
it and the non-forced path refuses (`dirty`) instead of deleting it with the
worktree. For a workspace this manager owns, `remove` returns a reason instead
of throwing:

| Reason | Meaning |
|---|---|
| `in_use` | `beforeRun` ran and `afterRun` has not cleared the guard |
| `missing` | the path was already gone; worktree metadata is pruned |
| `dirty` | the worktree has uncommitted or git-ignored changes |
| `not_empty` | the plain directory contains entries |
| `unreachable_head` | detached worktree HEAD holds commits no ref can reach |

A foreign or forged handle is rejected with `WorkspaceError` before any IO, not
reported as a reason. `afterRun` is the lenient counterpart: a forged handle is
skipped and reported as `invalid_handle`.

`force: true` overrides those guards **only for a path the manager owns**. It
never deletes outside the root. It deletes uncommitted work — that is the point,
and it is unrecoverable.

`pathFor({ workItemId })` previews the path and `handleFor({ workItemId })`
builds a fully populated handle without creating anything. Neither does IO.

The per-key lock is **in-process only**. Two processes can `ensure()` the same
key and race on the filesystem or on `git worktree add`; cross-process claiming
belongs to the scheduler, not this manager.

---

## 4. Hooks and their trust boundary

Four hooks, all supplied to the **constructor**:

```js
new WorkspaceManager({ hooks: {
  afterCreate: 'pnpm install --frozen-lockfile',
  beforeRun: 'git fetch origin --quiet',
  afterRun: null,
  beforeRemove: null,
  timeoutMs: 120_000,
  env: { CI: '1' },
} });
```

- **Trusted host configuration only.** A hook is a shell script the host passes
  in. It is never read from the workspace, from `AGENTS.md`, or from any other
  repo content. A repo-controlled hook would be arbitrary code execution from a
  checkout, so the SDK does not load one.
- **Environment.** Each hook gets the SDK's safe child environment plus
  `MERCI_WORKSPACE`, `MERCI_WORKSPACE_KEY`, and `MERCI_WORK_ITEM_ID`. Parent
  secrets are not inherited; `hooks.env` can add values but cannot shadow the
  `MERCI_*` identity variables.
- **cwd.** The workspace path. `afterCreate` runs after creation, the other
  three run against the existing workspace.
- **Timeout.** `hooks.timeoutMs` (default 60 s) is enforced per hook; a
  non-positive or non-integer value is a `ConfigurationError`. The output buffer
  is capped (`run_command_max_buffer_bytes`); a hook that prints more is
  truncated, not killed, so its exit code stays real. A non-zero exit after a
  truncation is reported as `hook_output_limit` — the cap is the cause, not the
  script's exit.
- **`afterCreate` also runs on an unfinished reuse.** Its success is recorded in
  the key's owner marker (`ready: true`). A directory whose marker is missing or
  not `ready` — a crash during the hook, a cleanup that could not remove the
  partial tree — is reused only after the hook runs again, and the
  `workspace:reused` payload carries `hooksRun: 'recovered'`. The directory is
  not wiped: the hook is the host's to make idempotent, which it already had to
  be across a crash.
- **Failure policy.** `afterCreate` and `beforeRun` are **fatal** — `ensure`
  and `beforeRun` reject with a `WorkspaceError`. A failing `afterCreate` also
  removes the workspace it just created. `afterRun` and `beforeRemove` failures
  are **ignored** — the run and the removal proceed, and the failure is reported
  as `workspace:hook_failed` when an emitter is attached. The SDK itself logs
  nothing.
- **Events.** `workspace:hook_started` names the hook; `workspace:hook_finished`
  adds the duration and exit code; `workspace:hook_failed` adds the duration,
  exit code, `timedOut`, and `fatal`. Events never carry the script text and
  never stderr. The thrown error for a non-zero exit carries a truncated
  `stderrTail`; a timeout (`hook_timeout`) and an over-cap exit
  (`hook_output_limit`) do not.

---

## 5. Keys and handles

`workspaceKeyFor({ workItemId })` derives `<sanitized>-<hash>`: a readable
prefix (up to 48 characters, non-ASCII runs replaced by `_`), then 16 hex
characters of SHA-256 (64 bits). The hash is always present so `Foo`/`foo`,
`a/b`/`a b`, and two long ids sharing a prefix cannot share a workspace. The id
is NFC-normalized first, and `string | number` are accepted; empty, `.`, `..`,
and any other type throw `ConfigurationError`.

`handleFor({ workItemId })` returns a handle with `path`, `key`, `root`,
`strategy`, and a **preview** `branch`. It is the entry point for a host that
reconciles an item this process never ensured. The `branch` field is
informational: `remove` reads the actual HEAD from git, so a handle that claims
a named branch while the worktree was detached or rebased is still protected by
the `unreachable_head` guard.

**Identity.** When an `identifier` is supplied and the manager is the SDK
`WorkspaceManager`, its `workspace:*` events carry it; a duck-typed manager may
ignore the option. A host that passes only `workItemId` gets no identifier on
first use; a later reuse of the same key inherits the first identifier. Pass
`identifier` to `ensure`/`handleFor` to join workspace events to the work item.
Under the scheduler the supplied identifier is the item's scheduling identifier,
and `workItemId` equals it. A handle reports `identifier: null` when it is
unknown while an event omits the field: treat an absent field as unknown, not as
a different identity.

**The owner marker.** Beside each directory the manager keeps one sibling file,
`<root>/<key>.merci-owner.json`:

```json
{ "ownerId": "wi-9", "identifier": "MER-42", "ready": true }
```

It is written atomically (`writeJsonAtomic`) and it is a sibling, not a file
inside the workspace: a plain directory's emptiness check, a worktree's
`git status`, and `git worktree remove` are all about the work, never about the
marker. `ready` is written only after `afterCreate` succeeded (§4).

- **What `ownerId` is.** The item identity, as a **string**. `ensure()` takes it
  as `ownerId` and defaults it to `workItemId` (the key source), so a host that
  passes only an id keeps working. The scheduler passes the real provider id
  (`ensure({ workItemId: identifier, identifier, ownerId: item.id })`), because
  the key derives from the identifier and a tracker can recycle it for different
  work: with the identifier as the owner, two items would compare equal and the
  second would inherit the first's tree — the exact handover the marker exists
  to stop (W1-2).
- **How it is compared.** `String(marker.ownerId) !== String(ownerId)`: one id
  spelled two ways (`42` and `'42'`) is one owner and is never renamed aside.
  A marker that cannot be read, or that predates `ownerId` (its `workItemId` is
  read as the owner), is treated as unknown ownership: the directory is reused,
  `afterCreate` re-runs, and the marker is rewritten.
- **Ownership.** When `ensure()` finds an existing directory whose marker names
  a **different** owner, it renames the directory to
  `<root>/<key>.orphan-<epoch-ms>-<uuid>` and creates a fresh one. The uuid is
  what keeps two renames in the same millisecond apart. For `git-worktree` the
  manager then prunes the stale registration, so the branch is not reported as
  "already checked out" when the fresh tree is created. The new item never
  starts in another item's tree, and the old files are preserved under the
  orphan name rather than deleted.
- **A marker that cannot be written** throws a `WorkspaceError` with reason
  `owner_marker_failed` that names the key — never a raw fs error. Without the
  marker the next reuse cannot tell whose tree it is, and a missing `ready`
  would re-run `afterCreate` on every attempt. The `ready: false` write happens
  before the hook, so a failure there can leave the just-created (empty)
  directory behind; the `ready: true` failure leaves the initialised directory,
  which the next attempt re-runs the hook on.
- **Cleanup.** A successful `remove()` drops the marker. A marker left by a
  disappeared directory is dropped on the next `remove()` that reports
  `missing`.

**Reaping refused workspaces.** Nothing in the SDK deletes a workspace that a
cleanup refused — that is the point of the guard — so a root can accumulate
directories. The orphan rename makes that visible and safe: an orphan directory
carries no marker of its own (the marker at `<root>/<key>.merci-owner.json` now
names the new owner), so a host reaper can list `<root>` and, on its own
schedule, `rm -rf` every `<key>.orphan-*` directory it has decided not to keep.
Workspaces that stayed in place because `remove` returned
`dirty`/`not_empty`/`in_use`/`unreachable_head` belong to items that may come
back, so they are not orphans; inspect them with the handle from
`handleFor({ workItemId })` and remove with `force: true` when the work is no
longer wanted.

---

## 6. The artifact boundary

`createWorkspaceTools` places artifacts in a **sibling** of the workspace by
default: `<root>/<key>.artifacts`. That keeps the worktree clean, so
`git status` keeps meaning something.

The **host** reads the returned absolute path with `fs` — pass references, not
token copies. The agent's context tools cannot read that sibling directory; the
shell tool asks for approval before a command that reaches it. A host that needs
the agent to read artifacts back passes
`artifactsDir: join(workspace.path, '.merci-artifacts')`, which is inside the
workspace and therefore readable; it shows as untracked until the host ignores
it.

---

## 7. Worktree caveats

- **Uncommitted host changes are not copied.** The worktree starts from a
  commit (`baseRef`, default `HEAD`). Nothing else is transferred.
- **No `node_modules`, submodules, or LFS content.** `afterCreate` is the
  explicit bootstrap — install dependencies and initialize submodules there.
- **A reused workspace is not reset.** `ensure` returns the existing one; it
  never resets it to the base ref. A reset would destroy agent work.
- **Remove only when clean.** A dirty worktree, or a detached one holding
  unreachable commits, needs `force: true`.
- **A named branch survives removal.** The worktree goes away; `merci/<key>`
  stays, so the work can become a commit, a PR, or a merge.
- **A root inside the repo works but is not recommended.** The common
  `.worktrees/` layout is supported; add it to `.gitignore` yourself — the SDK
  never edits it.

---

## 8. Wiring a run

`createWorkspaceTools` is **synchronous**. Its default `include` is
`['context', 'shell', 'artifacts']`, and the shell tool requires an
`approvalCallback` — pass one, or narrow `include` (for example
`include: ['context']`). `approvalCallback` accepts a bare function,
`{ callback, timeoutMs }`, or the builder's `{ fn, options: { timeoutMs } }`;
all three normalize to the same gate. `timeoutMs` applies to the session gate
only; the shell gate races the abort signal, not a timer.

`permissionMode` defaults to `'default'` (ask). `'acceptEdits'` still asks for
the shell, and `'bypassPermissions'` lets a gated command run without calling
the callback — an explicit, dangerous opt-in. For the session's own tools, the
same modes apply through `withPermissions`: `'acceptEdits'` approves only a
tool branded `editsFiles: true` (the SDK's `save_artifact`, or a host tool that
sets the flag) and never one that also declares `runsCode`; a tool loaded from
an MCP server never carries the brand. The default never changes. Under
`'bypassPermissions'` the toolbox no longer requires a callback and may bind an
ungated shell, exactly as `createShellTool` does; every other mode requires
one. Each constructed shell tool emits `permissions:bypass` once, so a binder
called per attempt announces per attempt, not once per orchestration; the event
carries `runId: null` because construction is outside the attempt's context.

```js
import { WorkspaceManager, createWorkspaceTools } from 'merci-sdk/workspace';

const workspaces = new WorkspaceManager({
    strategy: 'git-worktree',
    repoRoot: process.cwd(),
    hooks: { afterCreate: 'pnpm install --frozen-lockfile', timeoutMs: 120_000 },
});

const workspace = await workspaces.ensure({ workItemId: 'MER-42' });
const { contextTools, shellTool, artifactTool } = createWorkspaceTools({
    workspace,
    approvalCallback: approve,   // required by the default include
});

const session = client.session(model)
    .withAutoContext({ options: { root: workspace.path } })
    .withTools({ tools: [...contextTools, shellTool, artifactTool].filter(Boolean) });

await workspaces.beforeRun({ workspace });
try {
    await session.run({ initialInput: 'Fix the failing test.' });
} finally {
    await workspaces.afterRun({ workspace, outcome: 'succeeded' });   // never throws
}

await workspaces.remove({ workspace });   // clean only; force: true discards work
```

The binder never constructs a session and never replaces a host tool: the host
wires `withAutoContext` and `withTools`, and tools it adds itself are outside
this contract. Removing the workspace only when the item reaches a terminal
state is the host's schedule; `remove` is the operation, not the policy.

### Using it from a plain session

A normal `ChatSession` binds the same tools in one builder call:

```js
const session = client.session(model)
    .withApproval({ fn: approve })
    .withWorkspace({ workspace });

await workspaces.beforeRun({ workspace });
try {
    await session.run({ initialInput: 'Fix the failing test.' });
} finally {
    await workspaces.afterRun({ workspace, outcome: 'succeeded' });
}
```

`withWorkspace` appends to the tool list `withTools()` set and replaces a tool
of the same name, so calling it twice with the same workspace does not
duplicate anything; a later `withTools()` replaces the whole list and clears
the bound handle. The shell gate is the explicit `approvalCallback` argument,
else the session's `withApproval()` callback. `permissionMode` follows the
session's `withPermissions()` mode unless passed explicitly. The default
`include` binds the shell tool, so with neither a callback nor
`bypassPermissions` the call **fails closed** with a `ConfigurationError`
(option `approvalCallback`) instead of running an ungated shell. Pass `include`
without `shell` when the session has no gate. `save_artifact` writes to the
artifact directory (`workspace.root` by default), not `workspace.path`.

---

## 9. Errors

`WorkspaceError` (from the main entry) carries `reason`, `workItemId`, `path`,
an optional `stderrTail`, and a `cause`. Reasons: `outside_root`, `symlink`,
`not_directory`, `not_worktree`, `wrong_repo`, `not_repo`, `git_failed`,
`hook_failed`, `hook_timeout`, `invalid_handle` (a forged or malformed handle),
and `path_mismatch` (an in-root path that is not the path this manager derives
for that key). An invalid option (root, strategy, hook timeout, work-item id)
throws `ConfigurationError` instead.

Handle and target rejections emit `workspace:path_rejected` before the throw. A
hook failure emits `workspace:hook_failed` instead. A raw `git` command failure
surfaces as the thrown `WorkspaceError` with `reason: 'git_failed'`; a refusal
derived from git's answer — `not_repo`, `not_worktree`, `wrong_repo` — carries
that reason instead.

---

## Where to look next

- [`docs/ORCHESTRATION.md`](ORCHESTRATION.md) — the composition root that builds this manager from `WORKFLOW.md` and runs its lifecycle under each attempt's `RunContext`, so `workspace:*` events join the dispatch that caused them.
- [`docs/SCHEDULER.md`](SCHEDULER.md) — the loop that accepts this manager as a duck-typed collaborator.
- [`examples/28_workspace_isolation.mjs`](../examples/28_workspace_isolation.mjs) — a real worktree, the bound tools, and the removal guard.
