# The workflow contract — `WORKFLOW.md`

A repository can own the prompt and the runtime settings of an unattended
MerciSDK run: `WORKFLOW.md` holds inert YAML front matter and a Markdown prompt,
and one **workflow policy** validates the file into a single frozen config,
renders the prompt strictly per work item, watches the file, and keeps the last
known good state when an edit is broken.

```js
import { WorkflowPolicy } from 'merci-sdk/workflow-policy';

const policy = new WorkflowPolicy({ path: 'WORKFLOW.md' });
await policy.start();                       // load + validate + parse + watch
const prompt = policy.renderPrompt({ issue, attempt: null });
```

This page is the whole contract: the file format, the schema, the defaults and
the deviations from Symphony, environment and path expansion, the template
subset, reload and last-known-good, what is live and what is construction-bound,
the wiring, the security boundary, the honest limits, and the errors and events.

---

## 1. What it is — and is not

| The policy owns | The host owns |
|---|---|
| reading and parsing `WORKFLOW.md`, validating the front matter, rendering the prompt, the watcher, last-known-good, `preflight()` and the operator `snapshot()` | the scheduler, the workspace manager, the engine runner, the work source, the model session, and applying a reload to a live scheduler |

- **Not a workflow engine.** It drives none of the four engines. It supplies a
  prompt/objective to an engine that already exists (`agentic`, `dag`,
  `stateMachine`, `discussion`).
- **Not a tracker adapter.** `tracker.kind` and `tracker.provider` are validated
  and passed through; no Linear, Jira, or GitHub client is built, and no default
  active or terminal states are supplied.
- **Not a sandbox.** The file is repository-owned and trusted, like `AGENTS.md`.
  A literal secret in it is already exposed to the agent child (§10).
- **No durable state.** The last known good config is in memory. After a restart
  the file must load or `start()` fails.
- **No remote file.** A local path only; no HTTP, includes, or inheritance.

The subpath `merci-sdk/workflow-policy` exports eleven names:

`WorkflowPolicy`, `loadWorkflowFile`, `parseWorkflowMarkdown`,
`resolveWorkflowConfig`, `renderPromptTemplate`, `createPolicyRenderer`,
`policyToSchedulerOptions`, `policyToWorkspaceOptions`,
`WORKFLOW_POLICY_DEFAULTS`, `WORKFLOW_POLICY_REASONS`,
`WORKFLOW_POLICY_WARNINGS`.

`PolicyError` is exported from the main entry. Everything else stays on the
subpath, matching the scheduler and workspace posture.

---

## 2. File format

```
---
tracker:
  kind: linear
polling:
  interval_ms: 30000
---
You are working on `{{ issue.identifier }}`.
```

The fence rules are exact:

- One optional leading BOM (`\uFEFF`) is stripped before anything else.
- The opening fence is `---` **at the first byte** (after the BOM) followed by
  `\n` or `\r\n`. A leading blank line means there is no front matter: the whole
  file is the prompt body, `---` included.
- With no opening fence the config is `{}` and the body is the whole file,
  trimmed.
- The block ends at the **next line that is exactly `---`**, with at most a
  trailing `\r`. The scan is textual, not YAML-aware: a `---` at column 0 inside
  a YAML block scalar closes the block early. Authors should not put a bare
  `---` line in the front matter.
- No close fence is `workflow_parse_error` (`line: 1, column: 1`).
- The body is everything after the close fence, `trim()`ed. An empty body is
  allowed and adds the `empty_prompt` warning; the policy then returns
  `WORKFLOW_POLICY_DEFAULTS.promptFallback`.
- YAML `null` (`---\n---`) is `{}`. A sequence or scalar block is
  `workflow_front_matter_not_a_map`.

### The strict parse path

Parsing uses `yaml.parseDocument(raw, { maxAliasCount: 50, logLevel: 'silent' })`.
`yaml.parse` is never used: it prints the offending source line — which can hold
a secret — to stderr.

- `doc.errors` (malformed YAML, duplicate keys) is `workflow_parse_error`.
- A `doc.warnings` entry with `code: 'TAG_RESOLVE_FAILED'` (an unknown tag,
  including `!!js/function`) is `workflow_parse_error`. Other parser warnings are
  ignored.
- `doc.toJS({ maxAliasCount: 50 })` is capped, so an alias bomb is a parse error.
- Parse errors carry `line`/`column` when the parser reports them. They carry
  **no `cause` and no parser message**, because a YAML error quotes the offending
  line.
- There is **no fallback reader**. The lenient front-matter reader in
  `lib/tools/skills.mjs` is deliberately not reused: its legacy `key: value`
  fallback is right for `SKILL.md` and wrong for a runtime contract.
- A file over `maxFileBytes` (default 1 MiB) is `workflow_too_large`, checked
  both on `stat` and on the byte length after the read.
- A missing file is `missing_workflow_file`; any other stat/read failure, or a
  non-regular path (directory, FIFO), is `workflow_read_error`.

`parseWorkflowMarkdown({ markdown, path })` returns `{ config, promptTemplate }`
with the **inert, unfrozen** raw config. Feed it to `resolveWorkflowConfig()`
and never merge it with `Object.assign`; a `__proto__` own key can poison a
merge. `loadWorkflowFile()` is the one-shot read + parse + resolve; it does not
parse the template — the policy parses it once and keeps the AST.

---

## 3. Schema

The file uses snake_case. The resolved config uses camelCase. Unknown keys
inside a known section produce an `unknown_key` warning and are ignored; unknown
top-level sections are ignored (an extension point), except `codex`, which gets
one warning because a Symphony user may expect it to work. An unknown child of
`merci` other than the three known sections is ignored silently. A `merci.*`
section that is not a map is `invalid_config:merci` (or
`invalid_config:merci.workspace`).

### `tracker` — optional section; no adapter is built

| File key | Type | Default | Meaning |
|---|---|---|---|
| `tracker.kind` | non-empty string | required when `tracker` is present | The tracker kind; validated and passed through, never instantiated. |
| `tracker.provider` | map of JSON-safe leaves | `{}` | Provider settings. A string leaf expands only when the **whole** value is `$VAR` or `${VAR}`; depth ≤ 8; no cycles, functions, or non-finite numbers. May contain secrets. |
| `tracker.required_labels` | string[] | `[]` | Trimmed, lowercased, blank-dropped, deduped. |
| `tracker.active_states` | string[] | `[]` | Trimmed, blank-dropped, deduped case-insensitively; original case kept. |
| `tracker.terminal_states` | string[] | `[]` | Same normalization. Case-insensitive overlap with `active_states` is `invalid_config:tracker.terminal_states`. |

Both state lists empty is the `no_active_states` warning: the file is valid, but
the host must supply the states. The scheduler's own validation is authoritative.

### `polling`

| File key | Type | Default | Meaning |
|---|---|---|---|
| `polling.interval_ms` | integer ≥ 1 | `30000` | Map to `pollIntervalMs`. |

### `workspace` and `merci.workspace`

| File key | Type | Default | Meaning |
|---|---|---|---|
| `workspace.root` | non-empty string | `<tmpdir>/merci-workspaces` | Absolute after expansion; `~`, `~/`, embedded `$VAR`/`${VAR}` allowed; relative resolves against the file's directory. |
| `merci.workspace.strategy` | `directory` \| `git-worktree` | `directory` | Workspace strategy. |
| `merci.workspace.repo_root` | string \| null | `null` | Required for `git-worktree`; resolved like `root`; a missing value is `invalid_config:workspace.repo_root`. |
| `merci.workspace.base_ref` | non-empty string | `HEAD` | Base ref for a worktree. |
| `merci.workspace.branch_prefix` | string | `merci/` | Branch prefix; an empty string is accepted. |

`merci.workspace` exists so the core keys stay Symphony-compatible. It is
flattened into `config.workspace`.

### `hooks`

| File key | Type | Default | Meaning |
|---|---|---|---|
| `hooks.after_create` | string \| null | `null` | Shell script, preserved **verbatim** (the shell expands `$`); a non-empty string or null. |
| `hooks.before_run` | string \| null | `null` | Same. |
| `hooks.after_run` | string \| null | `null` | Same. |
| `hooks.before_remove` | string \| null | `null` | Same. |
| `hooks.timeout_ms` | integer ≥ 1 | `60000` | Per-hook timeout. |

### `agent`

| File key | Type | Default | Meaning |
|---|---|---|---|
| `agent.max_concurrent_agents` | integer ≥ 1 | `1` | Maps to `concurrency.global`. |
| `agent.max_turns` | integer ≥ 1 | `20` | Exposed as `config.agent.maxTurns`; **not consumed** by the scheduler mapping. |
| `agent.max_retry_backoff_ms` | integer ≥ 0 | `300000` | Maps to `retry.maxMs`. A value below `merci.scheduler.retry_base_ms` is refused at load with `invalid_config:scheduler.retry_base_ms`. |
| `agent.max_concurrent_agents_by_state` | map state → positive integer | `{}` | Keys trimmed and lowercased; an invalid entry is dropped with `invalid_by_state:<state>`; maps to `concurrency.byLane`. |

### `merci.scheduler`

| File key | Type | Default | Meaning |
|---|---|---|---|
| `merci.scheduler.max_attempts_per_item` | integer ≥ 1 | `5` | The retry cap, counting the initial attempt. |
| `merci.scheduler.retry_base_ms` | integer ≥ 0 | `10000` | The scheduler's own base delay; must not exceed `agent.max_retry_backoff_ms` (`invalid_config:scheduler.retry_base_ms`). |
| `merci.scheduler.continuation_delay_ms` | integer ≥ 0 | `1000` | Delay before a continuation. |
| `merci.scheduler.continuation_max` | integer ≥ 0 | `3` | Continuations per claim lifetime; `0` disables them. |
| `merci.scheduler.stall_timeout_ms` | integer ≥ 0 | `900000` | Stall watchdog; `0` disables it. |
| `merci.scheduler.max_total_tokens` | positive integer \| null | `null` | Token limit. |
| `merci.scheduler.max_total_usd` | positive finite number \| null | `null` | USD limit. |
| `merci.scheduler.max_dispatches` | positive integer \| null | `null` | Dispatch limit. A value set in the file survives a reload; an omitted cap is cleared from the mapped limits. |

### `merci.engine`

| File key | Type | Default | Meaning |
|---|---|---|---|
| `merci.engine.kind` | `agentic` \| `dag` \| `stateMachine` \| `discussion` | `agentic` | Which engine the host should build. |
| `merci.engine.model` | non-empty string \| null | `null` | Exposed as data. The policy never switches the session's model. |

Validation is strict about types: integers must be integers (no floats, numeric
strings, booleans, `NaN`, or `Infinity`), and every error is collected, so one
edit reports all of them in one `PolicyError`. The message is
`Workflow policy is invalid: N error(s)` — it never includes a value. The input
is not mutated; the output is deep-frozen, with `Object.prototype` as its
prototype.

---

## 4. Defaults and deviations from Symphony

Loader defaults (`WORKFLOW_POLICY_DEFAULTS`):

| Option | Default |
|---|---|
| `path` | `WORKFLOW.md` |
| `watch` | `true` |
| `debounceMs` | `100` |
| `maxFileBytes` | `1_048_576` |
| `maxTemplateDepth` | `32` |
| `maxRenderedChars` | `1_000_000` |
| `promptFallback` | `You are working on an issue from the configured tracker.` |

Config defaults, and where they deviate from Symphony:

| Field | Default | Source / deviation |
|---|---|---|
| `agent.maxConcurrentAgents` | `1` | SDK-safe. Symphony defaults to 10; concurrency above 1 also requires a workspace manager or `allowSharedWorkspace: true`. |
| `tracker.activeStates` / `terminalStates` | `[]` | No tracker adapters here, so no adapter defaults; the host supplies them. Both empty warns `no_active_states`. |
| `agent.maxTurns` | `20` | Accepted and exposed, but no layer consumes it: turns inside one session are not re-dispatches. |
| `scheduler.retryBaseMs` | `10_000` | The scheduler's own base delay (Symphony has no equivalent field). |
| `polling.intervalMs` | `30_000` | Symphony and `SCHEDULER_DEFAULTS`. |
| `workspace.root` | `<tmpdir>/merci-workspaces` | Workspace layer. |
| `workspace.strategy` | `directory` | Workspace layer. |
| `workspace.baseRef` / `branchPrefix` | `HEAD` / `merci/` | Workspace layer. |
| `hooks.timeoutMs` | `60_000` | Workspace layer and Symphony. |
| `agent.maxRetryBackoffMs` | `300_000` | Symphony and `SCHEDULER_DEFAULTS`. |
| `scheduler.maxAttemptsPerItem` | `5` | Scheduler. |
| `scheduler.continuationMax` / `continuationDelayMs` | `3` / `1_000` | Scheduler. |
| `scheduler.stallTimeoutMs` | `900_000` | Scheduler. |
| `scheduler.maxTotalTokens` / `maxTotalUsd` / `maxDispatches` | `null` | Scheduler; omitted from the mapped `limits`, which clears a removed limit on `applyConfig`. |
| `merci.engine.kind` / `model` | `agentic` / `null` | SDK extension. |

Two deviations worth stating outright: concurrency defaults to **1**, not 10,
and there are **no tracker adapter defaults**.

---

## 5. Environment and paths

Expansion is deliberately asymmetric:

- **`workspace.root` and `merci.workspace.repo_root`** expand `~` and `~/…`
  (`~user` is `invalid_config:<field>`), plus embedded `$VAR`/`${VAR}` anywhere
  in the string. A missing or empty variable is `missing_env:<field>:<NAME>`.
  A `$` not followed by an identifier stays literal. The result is resolved
  against `baseDir` — the directory of the workflow file, not the process cwd —
  and is always absolute.
- **`tracker.provider` string leaves** expand only when the whole value is
  `$VAR` or `${VAR}`. An embedded reference stays literal, so a URL, query
  string, or command is never rewritten. A missing/empty variable is
  `missing_env:<path>:<NAME>`, where `<path>` is dotted and indexed
  (`tracker.provider.headers[0]`).
- **Hook scripts never expand.** The shell owns their `$`.
- **Reads are own-property only** (`Object.hasOwn`), never through the prototype
  chain. `__proto__`, `constructor`, and `prototype` are refused as env names
  even when they are own keys (`$__proto__` would otherwise resolve to
  `Object.prototype` and freeze it globally), and as keys at any depth in the
  config (`invalid_config:<path>`).
- A missing or empty env value is an error, never `''`. There is no silent
  empty-string fallback.

---

## 6. The template subset

The prompt body is parsed once per load into an AST and rendered per attempt.
The supported grammar is exactly:

```
template := (text | output | if-block | raw-block)*
output   := '{{' ['-'] ws path ws ['-'] '}}'
if-block := '{%' ['-'] ws 'if' ws path ws ['-'] '%}' template
            ('{%' ['-'] ws 'elsif' ws path ws ['-'] '%}' template)*
            ('{%' ['-'] ws 'else' ws ['-'] '%}' template)?
            '{%' ['-'] ws 'endif' ws ['-'] '%}'
raw-block:= '{%' ['-'] ws 'raw' ws ['-'] '%}' <literal until endraw>
            '{%' ['-'] ws 'endraw' ws ['-'] '%}'
path     := ident ('.' ident)*
ident    := [A-Za-z_][A-Za-z0-9_-]*
```

- **Four trim markers.** `{{-` / `{%-` strip trailing whitespace from the text
  before the tag; `-}}` / `-%}` strip leading whitespace after it. Whitespace is
  space, tab, CR, and LF only.
- **`raw`** emits its content literally up to the first `{% endraw %}`; raw does
  not nest, and a missing close is an error.
- **Only `issue.*` and `attempt`** are resolvable roots. A path with another root
  parses, then fails at render.
- **Strict variables.** A path that is **absent** is
  `template_render_error:<path>`. A **leaf** that is present with `null` or
  `undefined` renders as `''`; an **intermediate** `null` or non-object
  (`issue.metadata.source` when `metadata` is null) is a render error. This
  distinction is the point: a typo fails, a legitimately empty field does not.
- **`attempt` is always injected** (`null` when omitted), so `{% if attempt %}`
  is a defined path. Through `createPolicyRenderer()` the scheduler's dispatch
  and kind become the contract's retry index: `null` on the first dispatch, `1`
  on the first failure retry (dispatch 2), and `1` on a continuation (which
  re-runs as dispatch 1), so the branch is false only for a first run and
  `{{ attempt }}` renders the retry number — matching Symphony's retry-index
  semantics. `WorkflowPolicy.renderPrompt()` itself passes the value through
  unchanged, so a direct caller passes exactly what it means.
- **JS-like truthiness**, a documented deviation from Liquid: `null`,
  `undefined`, `false`, `''`, `0`, `NaN`, and an empty array are falsy;
  everything else (including `{}`) is truthy. Liquid would call an empty array
  truthy and would render the wrong branch for an empty description.
- **Rendering.** A leaf `null`/`undefined` → `''`; strings as-is; numbers and
  booleans via `String`; arrays render each element and join with `', '`; any
  other value is `non_scalar`. No HTML escaping — this is a prompt.
- **No filters, comparisons, loops, `assign`, `include`, or `capture`.** A `|`
  is `unsupported_filter`, `= < >` is `unsupported_comparison`, an unknown tag is
  `unsupported_tag:<name>`; all are parse errors with 1-based `line`/`column`.
  `__proto__`, `constructor`, and `prototype` path segments are **parse** errors,
  so a bad template invalidates a reload instead of failing per item.
- **Caps.** Nesting deeper than `maxDepth` (default 32) is `too_deep`; the cap is
  itself bounded at 512 because a larger one can exhaust the JS stack before the
  check fires. A cap that is not a positive integer (a string, `NaN`, `0`, a
  negative, or a float) is `invalid_option:<name>`, and so is a `maxDepth` above
  512 — never a silently disabled guard. Output over `maxRenderedChars` is
  `prompt_too_large`; it fails, it is not truncated.

### Template dialects

The DAG's `interpolateTemplate` stays what it is; the policy adds a second,
strict dialect.

| | policy prompt (`renderPromptTemplate`) | DAG `interpolateTemplate` |
|---|---|---|
| Syntax | `{{ issue.identifier }}`, `{% if attempt %}` | `{{step.output}}`, `{{context.key}}` |
| Unknown variable | `template_render_error` | warns and substitutes `[UNRESOLVED: …]` |
| Missing reference | fails the attempt | renders a visible marker |
| Data source | the `issue` view and `attempt` | step outputs and the DAG context |

Reusing the lenient interpolator would have changed the DAG's behavior for every
existing workflow; two dialects with a documented boundary is the smaller blast
radius.

A third dialect is the state-machine engine: it re-runs its own lenient
`{{context.…}}` interpolator over the node prompt, so a literal `{{context.…}}`
emitted from `{% raw %}` can be rewritten (an unresolvable one becomes
`[UNRESOLVED: …]`). Render the prompt with the policy renderer and keep the
engine's own `{{context.…}}` form out of the rendered text, as the §9 wiring
table does.

---

## 7. Reload, last-known-good, and the watcher

`start()` reads, parses, validates, and parses the template; only then does it
swap one effective object (`config`, prompt text, AST, file stat, warnings,
`loadedAt`). The swap is atomic, so a reader never sees a new prompt with an old
config. A failed `start()` emits `workflow_policy:load_failed`, resets `started`
to `false`, and throws, so the host can retry after fixing the file.

`reload({ force = false })`:

- Returns `{ changed, healthy, reasons }`. It is **single-flight**: a concurrent
  call joins the in-flight reload instead of queueing a second read.
- Compares `{ ino, mtimeMs, size }` with the effective stat. An unchanged file is
  a no-op: no parse, no swap, no event; `healthy` is the previous result and
  `reasons` still carry the last error.
- `force: true` skips the stat shortcut but still compares a SHA-256 of the raw
  text. Identical content adopts the fresh stat and reports `changed: false`.
- A write between `stat` and read is retried up to three times; the latest read
  wins and the next watch event corrects the stat if needed.
- A **failure keeps the previous effective state**, records `lastError`, emits
  `workflow_policy:reload_failed`, and returns `{ changed: false, healthy: false,
  reasons }`. It never throws to the watcher.
- A later valid reload clears the error and emits
  `workflow_policy:reloaded`.
- A deleted file is `missing_workflow_file`; the last good state stays.
- A `stop()` during an in-flight reload wins: the reload returns
  `reasons: ['stopped']`, swaps nothing, and emits nothing.

`stop()` is final and idempotent; it may be called before `start()`. It closes
the watcher, clears the debounce, and suppresses every later event. The effective
state stays readable, so `renderPrompt()` and `getConfig()` still work; `reload()`
after `stop()` throws `stopped`, and `start()` after `stop()` also throws
`stopped`.

### The watcher

- It watches the **containing directory**, not the file: an editor that writes a
  temp file and renames it over `WORKFLOW.md` replaces the inode, and a watch on
  the old inode would miss every later edit.
- `change` and `rename` both count; events are filtered by the base name (all
  events count on platforms that omit the filename).
- A burst is debounced by `debounceMs` into one reload.
- Both the watcher and the debounce timer are `unref()`'d, so a forgotten
  `stop()` does not hold the process open.
- A watcher construction failure or an `'error'` event degrades the policy:
  `watch: 'failed'`, a `watch_failed` warning, and no throw. Each watcher error
  emits its own `workflow_policy:watch_failed`; only the **warning** is recorded
  once. The watcher is **not** re-armed, and the failure does not make `healthy`
  false or block dispatch. A later change event still triggers one reload.
- `watch: false` disables the watcher (`watch: 'disabled'`); the host calls
  `reload()` itself on its own schedule.

Two details matter in practice:

1. The stat no-op means a save that keeps the same inode, size **and**
   `mtimeMs` is invisible on a plain `reload()`. The watcher calls `reload()`
   without `force`, so it heals any save whose `{ ino, mtimeMs, size }` differs:
   an in-place write that changes the mtime or the size, and an atomic rename
   that changes the inode. Only an in-place edit that changes none of the three
   leaves the stat identical and needs `reload({ force: true })`. When a read
   matches the last **good** state while `lastError` is set, the reload clears
   the error, reports `{ changed: false, healthy: true }`, and emits
   `workflow_policy:reloaded { changed: false }`. The proof is the content hash
   of the last validated text, not the stat alone: an unchanged stat under a
   stored error is re-hashed, and different bytes take the real parse path
   (which may fail and keep the error). A transient read failure, a permission
   flip, or a move-and-restore therefore heals on the next read, with no edit
   and no restart. A real parse failure still records its error.
2. A watcher failure is sticky: the warning survives every later reload, because
   a successful rebuild would otherwise drop it while `watch` still reads
   `'failed'`.

---

## 8. Live versus restart

| What | After a valid reload | Why |
|---|---|---|
| Rendered prompt | live on the next render | the AST and prompt text are swapped atomically |
| Health, `preflight()`, `snapshot()` | live immediately | `lastError` is cleared or set by the reload |
| Scheduler settings — states, labels, poll cadence, stall timeout, concurrency, retry, continuation, limits | live **only if the host applies them** | the host subscribes to `workflow_policy:reloaded` and calls `scheduler.applyConfig()`; the policy never imports the scheduler |
| `workspace.root`, `strategy`, `repo_root`, `base_ref`, `branch_prefix`, and the four hooks | next `WorkspaceManager` / next process | the workspace layer is construction-bound and has no `applyConfig` |
| `merci.engine.kind` / `merci.engine.model` | visible in `getConfig()` on reload | the engine runner is constructed once; rebuilding it is a host action |

The scheduler itself never reads `WORKFLOW.md`. The policy never constructs a
scheduler, a workspace manager, or a runner.

### Wiring order

1. `await policy.start()`
2. construct the scheduler with `policyToSchedulerOptions({ policy })`
3. `await scheduler.start()`
4. subscribe to `EVENTS.WORKFLOW_POLICY.RELOADED` and call `applyConfig()`

The order is not cosmetic. `policyToSchedulerOptions()` reads `getConfig()` and
throws `PolicyError('not_started')` if the policy has not loaded. `scheduler.start()`
folds the `preflight()` result into its validation, and an unstarted policy
returns `['not_started']`, so starting the scheduler first would fail. Subscribe
last because `applyConfig()` also requires a started scheduler.

---

### `withEventEmitter({ eventEmitter })`

The constructor sets the sink. An already-built policy can be re-pointed at one
sink with `policy.withEventEmitter({ eventEmitter })`; it validates the value the
same way, returns `this`, and takes effect for the next event. The composition
root uses it when a host supplies its own policy, so `workflow_policy:*` reaches
the same event ring as the scheduler and the workspace. That is a **loan**: the
facade reads `policy.eventEmitter` before the switch and restores it in
`stop()`, so the host's own subscriber keeps receiving events from a policy the
host started. `null` disables the sink.

## 9. Wiring

Every snippet below is offline: the work source is empty, so no model call
happens.

```js
import { EVENTS } from 'merci-sdk';
import {
    WorkflowPolicy, createPolicyRenderer,
    policyToSchedulerOptions, policyToWorkspaceOptions,
} from 'merci-sdk/workflow-policy';
// Illustrative, not standalone. The host supplies the scheduler class, the
// eventEmitter, workSource, workflow, claims, and the workspace manager class.
// (Those names are not imported here.)

const policy = new WorkflowPolicy({ path: 'WORKFLOW.md', eventEmitter });
await policy.start();                                   // 1. before anything reads it

const scheduler = new WorkScheduler({
    // The file wins; this fallback fills only what it omits.
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Canceled'],
    ...policyToSchedulerOptions({ policy }),            // 2. live state, labels, caps, limits
    workSource, workflow, claims,
});
await scheduler.start();                                // 3. folds preflight() into validation

eventEmitter.on(EVENTS.WORKFLOW_POLICY.RELOADED, () => { // 4. then live reconfiguration
    scheduler.applyConfig({ options: policyToSchedulerOptions({ policy }) })
        .catch(() => { /* log: a rejected patch leaves the scheduler on its last good config */ });
});

const workspaces = new WorkspaceManager({
    ...policyToWorkspaceOptions({ policy }),            // construction-bound
    eventEmitter,
});
```

The order in that constructor is the rule: **the file wins, and the fallback
fills only what it omits.** Put `activeStates`/`terminalStates` before the
spread. After it, they would override the file's `tracker.active_states` and
`tracker.terminal_states` on every construction, and the file's selectors would
be ignored.

`createPolicyRenderer({ policy })` returns the engine runner's
`({ item, attempt, continuation }) => string` callback. It maps a scheduler
`WorkItem` to a Symphony-compatible issue view, carrying both spellings where
the runtime uses camelCase and a Symphony prompt expects snake_case
(`created_at`/`createdAt`, `blocked_by`/`blockedBy`, `branch_name`,
`assignee_id`), so an author's prompt works unchanged. It also maps the
scheduler's dispatch ordinal and kind to the contract's retry index: `null` on
the first dispatch, `attempt - 1` for a failure retry (`1` on the first retry),
and `attempt` for a continuation (`1`, since it re-runs as dispatch 1). So
`{% if attempt %}` is false only on a first run, and `{{ attempt }}` renders the
retry number. `WorkflowPolicy.renderPrompt()` passes `attempt` through
unchanged.

| Engine | Where the rendered prompt goes |
|---|---|
| `agentic` | `createEngineRunner({ engine: 'agentic', prompt: render })` |
| `dag` | `planFor: ({ item, attempt }) => ({ objective: render({ item, attempt }), steps: [...] })` |
| `stateMachine` | `graphFor: ({ item, attempt }) => graph` with the rendered text in the node prompt |
| `discussion` | `objective: render` (the text becomes the `conclude` instruction) |

A DAG `planFor` must also return `steps`: the runner ignores an empty plan, so an
`objective` without steps runs nothing.

```js
const render = createPolicyRenderer({ policy });   // leave eventEmitter null

// stateMachine: the graph's own node shape, one node for this item
const graphFor = ({ item, attempt }) => ({
    entry: 'work',
    nodes: [{
        id: 'work', terminal: true,
        systemPrompt: 'You are working a tracked item.',
        userPromptTemplate: render({ item, attempt }),
    }],
    edges: [],
});
```

**Pass `eventEmitter: null` to the renderer.** The policy already emits
`workflow_policy:render_failed` for a failed render. `createPolicyRenderer()`
emits it too when it is given an emitter, so passing the same emitter to both
produces two events for one failure. Pass the emitter to exactly one of them.

### Per-state caps and the lane

`agent.max_concurrent_agents_by_state` is mapped to `concurrency.byLane`, with
keys trimmed and **lowercased**. The scheduler compares `item.lane` as-is
(normalization trims it but does not lowercase it). A cap therefore fires only
when the work-source adapter sets `lane` to the lowercased, trimmed provider
state (for example `in progress`). A lane the scheduler does not list is governed
by the global pool only.

Per-state caps are not visible in the scheduler's `snapshot()`: it reports
`limits`, the active/terminal states, and totals, but not `concurrency`. The
policy's `snapshot()` shows the file's map under
`config.agent.maxConcurrentAgentsByState`.

---

## 10. Security

The workflow file is **trusted, repository-owned input**, reviewed like code.
The policy is not a sandbox and does not claim to be one.

- A literal secret in the front matter or the prompt is already exposed: the
  file is read by the process and the prompt is sent to the child. Put secrets
  in the environment and reference them (`tracker.provider.token: "$LINEAR_TOKEN"`).
- `getConfig()` returns the live config, and `tracker.provider` may contain the
  expanded secret values. It is the wiring API; **never serialize it**, never log
  it, never put it in an event.
- `snapshot()` is the operator view. `tracker.provider` is projected to
  `{ redacted: true, keys: [...] }`, hooks are presence booleans plus the
  timeout, and the prompt is `{ chars, hash }` — never text. No prompt text, hook
  script, provider value, file content, or `err.message` appears.
- **Identifiers are echoed; values are not.** Key names (`unknown_key:tracker.foo`),
  state names (`invalid_by_state:review`), environment names
  (`missing_env:workspace.root:WORKSPACES_DIR`), field paths
  (`invalid_config:scheduler.retry_base_ms`), and template variable paths
  (`template_render_error:issue.assignee`) appear in warnings, reasons, and
  events. They are names, not data.

---

## 11. Honest limits

- **Two events for one render failure** when the same emitter is passed to both
  the policy and `createPolicyRenderer()`. Use `eventEmitter: null` on one of
  them.
- **A prompt-only reload still reports a change.** `policyToSchedulerOptions()`
  builds a fresh `preflight` closure on every call, so `applyConfig()` sees
  `preflight` differ and returns `changed: ['preflight']`, re-arming the poll
  timer even though no dispatch setting changed.
- **`blockedBy` entries must be objects** with `identifier`, `id`, or `state`.
  A bare string entry resolves to `''` and is dropped from the issue view.
- **A retry pair is checked across sections.** `merci.scheduler.retry_base_ms`
  greater than `agent.max_retry_backoff_ms` is refused at load with
  `invalid_config:scheduler.retry_base_ms` (a reload of it keeps the
  last-known-good config), because the mapped scheduler `retry` pair
  (`baseMs ≤ maxMs`) would otherwise throw at `scheduler.start()` or
  `applyConfig()`.
- **An in-place edit that keeps the same inode, size and `mtimeMs` needs
  `reload({ force: true })`.** The watcher heals every save whose stat differs —
  a changed mtime or size in place, or a new inode from an atomic rename — and
  it also heals a stored error once the same state reads again.
- **A continuation renders the first-attempt branch.** The scheduler runs a
  continuation as attempt 1, which the renderer maps to the retry index `null`,
  so `attempt` distinguishes retries, not continuations.
- **The last known good state is in memory only.** After a restart, a broken
  file fails `start()`; nothing is durable.
- **Workspace settings and hooks are not live.** A reload exposes them, but a
  running manager keeps its construction-bound root, strategy, refs, and hooks.
- **`agent.max_turns` is exposed, not consumed.** No layer reads it.
- **`fs.watch` is best effort.** A failure is not healed in place; `watch` stays
  `'failed'`. Use `watch: false` and a host `reload()` where the filesystem is
  unreliable.
- **The template is a subset, not Liquid.** Every unsupported construct fails
  loudly; a prompt copied from a full-Liquid setup must be reduced first.
- **A prompt that renders too large fails the attempt** (`prompt_too_large`)
  instead of being truncated. Silent truncation is worse for an unattended run.
- **`preflight()` blocks new work, not in-flight work.** A broken reload blocks
  new dispatches and due retries; running attempts continue on the last good
  prompt.

---

## 12. Errors and events

`PolicyError` extends `MerciError`. It carries the code
`MERCI-WORKFLOW-POLICY-ERR`, `reason`, `reasons`, and the optional `field`,
`path`, `line`, and `column`. `path` is the workflow file path, never a config
value; `field` is a template variable path.

### Reasons

| Reason (prefix) | Thrown when |
|---|---|
| `missing_workflow_file` | the file does not exist |
| `workflow_read_error` | the path is not a regular file, or the stat/read failed |
| `workflow_too_large` | the file exceeds `maxFileBytes` on stat or after the read |
| `workflow_parse_error` | malformed YAML, a duplicate key, an unknown tag, an alias bomb, or a missing close fence |
| `workflow_front_matter_not_a_map` | the front matter is a sequence or a scalar |
| `invalid_config` | a field failed validation; the detail is the flattened field path |
| `invalid_option` | a constructor or template cap option is unusable |
| `missing_env` | `missing_env:<field>:<NAME>`; the variable is missing or empty |
| `template_parse_error` | a syntax or unsupported-construct error; detail after the colon; `line`/`column` |
| `template_render_error` | an absent variable or a non-scalar value; `field` names the template path. An oversized prompt is `template_render_error:prompt_too_large` with **no** `field`. |
| `not_started` | `reload()`, `renderPrompt()`, or a mapping helper before a successful `start()` |
| `already_started` | a second `start()` |
| `stopped` | `reload()` or `start()` after `stop()` |

`WORKFLOW_POLICY_REASONS` lists every prefix. Validation reasons use the
flattened field name (`invalid_config:scheduler.retry_base_ms`); unknown-key
warnings use the file section (`unknown_key:merci.scheduler.bogus`).

### Warnings

| Code | Meaning |
|---|---|
| `unknown_key:<section>.<key>` | a key inside a known section is not recognized; it is ignored |
| `unsupported_section:codex` | the `codex` top-level section is ignored; MerciSDK does not launch a coding-agent subprocess |
| `invalid_by_state:<state>` | a per-state cap entry is not a positive integer; it is dropped |
| `empty_prompt` | the file loaded with an empty body; the fallback prompt is used |
| `no_active_states` | both state lists are empty; the host must supply them |
| `watch_failed` | the watcher failed to construct or errored; `watch: 'failed'`, dispatch is not blocked |

`WORKFLOW_POLICY_WARNINGS` lists every code. Warnings are returned by
`loadWorkflowFile()`, reported in `snapshot().warnings`, and included in the
`workflow_policy:loaded` payload. A reload's event carries the path, the prompt
size, and `changed` only; read `snapshot().warnings` for the current list.

### Events

Six leaves under `EVENTS.WORKFLOW_POLICY`:

| Event | Payload keys |
|---|---|
| `workflow_policy:loaded` | `path`, `source: 'startup'`, `promptChars`, `warnings` |
| `workflow_policy:reloaded` | `path`, `promptChars`, `changed` |
| `workflow_policy:reload_failed` | `path`, `reasons` |
| `workflow_policy:load_failed` | `path`, `reasons` |
| `workflow_policy:watch_failed` | `path`, `reason` |
| `workflow_policy:render_failed` | `reason`, `field` |

`reasons` are stable codes plus field/env names; `field` is a template path;
`reason` is the base reason (for example `template_render_error`). No payload
carries prompt text, a hook script, a provider value, file content, or
`err.message`. A stopped policy emits nothing.

---

## Where to look next

The scheduler the mapped options feed is specified in
[`docs/SCHEDULER.md`](SCHEDULER.md); the workspace lifecycle the construction
options feed is in [`docs/WORKSPACES.md`](WORKSPACES.md); the operator API that
projects `policy.snapshot()` as health (not the whole snapshot) is in
[`docs/OPERATOR_API.md`](OPERATOR_API.md); and the one call that wires the
policy, scheduler, workspace and operator together is
[`docs/ORCHESTRATION.md`](ORCHESTRATION.md).
The public subpath is `merci-sdk/workflow-policy`; a runnable end-to-end walkthrough is [`examples/29_workflow_contract.mjs`](../examples/29_workflow_contract.mjs).
