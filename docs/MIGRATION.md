# Migration guide

This guide covers the move to `0.7.2` — **the first published release of the
SDK**. There is no previous published state to migrate from: the versions
before it (`7.0.0`, `0.7.0`, `0.7.1`) existed only in the repository's
`package.json`.

So the **"Before" column below describes the repository as it stood before
this release**, not a released API. For a consumer installing from npm there
is nothing to migrate — this is version one. For a consumer tracking the
repository (or a fork of it), the "Before" column is the state you may be on,
and the "What to do" column says what to change.

**What changed and why.** `0.7.2` is a delivery-and-conformance release. The
protocol layer now speaks the current specifications instead of a private
dialect (A2A v1.0.0, MCP with resources and prompts, ACP v1), the agentic
layer gained the policy controls every incumbent ships (guardrails,
permissions, per-tool timeouts, tool output schemas, telemetry), and the
release engineering around it was put in order (typed declarations, a clean
dependency tree, a CI matrix, a package surface that matches what is
published). One removal comes with it: the SDK no longer prices a model. A
static price table is a dated snapshot of public list prices; it drifts, and a
budget computed from it silently under- or over-states itself. The SDK now
follows the amount the backend reports itself, and never guesses a price.

Most of the change is additive. **If you do not use the price table, the money
budget, `stream: false`, SKILL.md frontmatter, or `request:after` hooks, you
have nothing to edit** — see [No action needed](#no-action-needed). The
releases after it (0.7.3, 0.8.0) have their own list in
[section 12](#12-after-072--the-production-loop-releases-073-080).

## The breaking and behaviour-changing items

| # | Change | Before | After | What to do |
|---|--------|--------|-------|------------|
| 1 | The price table is gone | `MODEL_PRICING` and `withPricing({ table })` shipped a dated price table; the SDK priced every usage snapshot from it | no price table; the SDK never computes a price | remove the import and the `withPricing` call |
| 2 | The money budget follows the backend | `maxBudgetUsd` was priced from the table; a model with no price entry refused the run with `ConfigurationError` | `maxBudgetUsd` is enforced only when the backend reports an amount; otherwise `run:budget_unreported` is emitted and the run continues | keep `maxTotalTokens` as the cap that always works |
| 3 | `stream: false` | threw `ConfigurationError` on the OpenAI-compatible backend | supported; the complete response is mapped onto the same unified events | nothing |
| 4 | SKILL.md frontmatter | a hand-rolled `key: value` reader | YAML, with the legacy reader as a fallback and a warning | fix any frontmatter that is not valid YAML (optional) |
| 5 | `request:after` hooks | declared in `HOOKS`, never invoked | the chain fires after the vendor call | nothing |
| 6 | Vendor-call retry | doubled: a session that already retried the call got a second policy, so one failure cost up to nine calls | one owner: a session that opens the call itself runs it once | nothing |
| 7 | Citations | per-vendor shapes on the stream, and the event was dropped before the caller saw it | one shape on the Gemini and Anthropic backends: `{ type: 'citations', data: { citations: [{ uri, title, text }] } }` | read the unified shape |
| 8 | A2A wire | the card's skill name was called as a JSON-RPC method | the A2A v1.0.0 binding: `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask` | see [A2A, MCP and ACP](#10-a2a-v100-the-mcp-server--client-callbacks-and-the-acp-v1-lifecycle) |
| 9 | MCP client capabilities | the client registered `capabilities: {}` and answered nothing | `sampling`, `elicitation` and `roots` are declared and answered | nothing |
| 10 | ACP session lifecycle | a partial method set | the full v1 lifecycle, `session/new` … `session/cancel` | nothing |
| 11 | Tool contract | a tool could hang the turn; oversized results were capped as strings only | a per-tool `timeoutMs`, a tool `outputSchema`, and object output capping | nothing |
| 12 | The unpoliced browser read leg | `withBrowser()` defaulted to the obscura engine, which follows redirects and reports no final URL — a public URL could land on a private one after the pre-fetch guard passed | an unpoliced read uses the curl leg (redirects checked hop by hop); obscura requires `allowUnpolicedObscura: true`, and a configured domain policy still selects curl | pass `allowUnpolicedObscura: true` if you need the obscura engine without a policy |
| 13 | `getLedger()` | returned a copy whose `push` wrote back into the session (a mutation disguised as a read) | returns a plain copy; `appendLedger({ entries })` appends, refusing a malformed row loudly | replace `getLedger().push(row)` with `appendLedger({ entries: [row] })` |
| 14 | Web preload | the web search / scrape / browser orientation block was injected whenever the mode was on, with no knob | `withWebSearch` / `withWebScrape` / `withBrowser` accept `preload: false`, which keeps the tool and drops the block | nothing (the default is unchanged) |
| 15 | A thrown state-machine node | its usage was never charged: the budget could not see an attempt that failed after reporting tokens | the attempt is charged before the node fails | nothing |
| 16 | Journal attempts | a re-begun key grew its `attempts` history forever | the history is flat per attempt and refuses the 101st attempt with `OrchestrationError` | a retry should use a new boundary/key, as every production path already does |

> The "Before" column is the **repository** state before this release, not a
> published one: `0.7.1` was never published. Items 1, 2, 5, 6 and 7 describe
> changes that landed inside this release cycle — a consumer on npm never saw
> them, a consumer tracking the repository may have.

---

## 1. The price table is gone

The static table — `MODEL_PRICING`, `PRICING_SNAPSHOT_DATE`, `PRICING_CURRENCY`,
`estimateCostUsd`, `resolveModelPricing`, `mergePricingTable` — and
`withPricing({ table })` are removed. `lib/support/pricing.mjs` no longer
exists.

**Before**

```js
import { MODEL_PRICING, estimateCostUsd, mergePricingTable } from 'merci-sdk';

const session = client.session(model)
    .withPricing({ table: mergePricingTable({ table: MY_CONTRACT_PRICES }) });

const cost = estimateCostUsd({ usage, model: 'gpt-4o' });
// → { input, output, cacheWrite, cacheRead, total, currency }
```

**After**

```js
const session = client.session(model)
    .withBudget({ budget: { maxTotalTokens: 200_000 } });

// The run's usage snapshot carries the amount the BACKEND reported:
//   usage.cost_usd   — the reported cost in USD, or null when none was reported
//   usage.cost_unreported_calls — how many calls spent tokens but reported no
//                      amount (also on the budget-pool usage). While this is
//                      non-zero the dollar figure is a lower bound, not a total.
// There is no breakdown any more: the SDK does not decompose a price it never
// computed.
```

**What to do**

- Delete the import of the removed names and the `withPricing({ table })` call.
- If you computed a cost yourself, take it from the run's usage snapshot
  (`usage.cost_usd`) or from your own vendor invoice. The SDK does not
  decompose the amount into input, output and cache components any more.
- If you need a price per model, keep your own table in your application. The
  SDK will not ship one and will not blend yours into its accounting.

## 2. The money budget follows the backend

`withBudget({ budget })` still accepts `maxBudgetUsd`, and the token budget
`maxTotalTokens` is unchanged. What changed is what the money cap is measured
against.

**Before**

```js
session.withBudget({ budget: { maxBudgetUsd: 5 } });
// A model with no price entry refused the run with a ConfigurationError —
// BEFORE the first vendor call, so the model was never billed.
```

**After**

```js
session.withBudget({ budget: { maxTotalTokens: 200_000, maxBudgetUsd: 5 } });
// maxTotalTokens  — always enforced.
// maxBudgetUsd    — enforced only when the backend's usage carries an amount.
//                   A gateway reports the money it charged in its usage
//                   (`usage.cost`); the direct vendor APIs report tokens
//                   only. When no amount is reported — or only some calls
//                   carry one — the cap cannot be enforced: the SDK emits
//                   `run:budget_unreported` once, logs a warning, and the run
//                   continues under the token budget. A child bound to an
//                   ancestor's `maxBudgetUsd` gets the same notice for it.
```

The two failure modes are different on purpose. A missing price is not a
refusal any more: a run that cannot be priced in dollars is not a run that
must be stopped, and a budget that silently does nothing is worse than one
that says it cannot be enforced.

**What to do**

- Keep `maxTotalTokens` as the cap that always works. Treat `maxBudgetUsd` as
  an extra stop that applies only against a backend that reports a cost.
- Subscribe to `run:budget_unreported` if you need to know that the money cap
  was inert for a run.

## 3. `stream: false` is now supported

**Before**

```js
session.withParameters({ params: (b) => { b.stream(false); } });
// ConfigurationError: The OpenAI-compatible backend requires streaming —
// stream:false is not supported by the agentic loop.
```

**After**

```js
session.withParameters({ params: (b) => { b.stream(false); } });
// The vendor call is issued without the `stream` flag and the complete
// response object is mapped onto the same unified events the streaming path
// produces: first_token, text, thought, tool_calls, quota, truncated, error.
```

`stream` still defaults to `true`. On the chat-completions branch the
usage-bearing `stream_options` field is dropped, because the vendor rejects it
next to `stream: false`.

**What to do** — nothing. The call that used to throw now works.

## 4. The SKILL.md frontmatter is YAML

`loadSkillsFromDirectory` parses the frontmatter with the `yaml` package. A
frontmatter block is YAML by specification, and the old hand-rolled
`key: value` splitter silently mis-parsed real frontmatter (a value with a
colon, a list, a nested map).

**Before**

```markdown
---
name: my-skill
description: A skill
allowed-tools: read_file, write_file
---
```

**After** — the same file still loads. A list, a nested map, a quoted string
and a block scalar now survive into `tool.metadata.frontmatter`.

Two fallbacks keep a working skill working:

- A frontmatter that **YAML rejects but the legacy reader understands** still
  loads, and the SDK logs `Frontmatter is not valid YAML (…) — parsed with the
  legacy reader.`
- A file **neither reader understands** is skipped, and the SDK emits
  `skills:load_error` for it. The rest of the directory still loads.

**What to do** — nothing, unless you want to silence the warning: quote the
value that YAML rejects.

### The skill's `parameters` schema is no longer dropped

The frontmatter's `parameters` field is the skill's tool schema. The loader
accepted it only as a JSON **string**, so a schema written as a YAML
**mapping** — the natural spelling, since the frontmatter is YAML — was
dropped, and the skill was advertised with an **empty schema**:

```markdown
---
name: my-skill
description: A skill
parameters:
  type: object
  properties:
    target:
      type: string
---
```

**Before** — the tool was advertised with `parameters: { type: 'object',
properties: {} }`: the model had no idea which arguments the skill takes.

**After** — both spellings work: the YAML mapping above, and the JSON string
(`parameters: '{"type":"object",...}'`) the loader used to accept. The skill is
advertised with its real schema. A schema must be a **mapping**: a YAML list, a
JSON-string list or a scalar is ignored with a warning, and the empty schema is
advertised.

**What to do** — nothing. If your skill relied on the empty schema, the model
now sees the real one (that is the point).

## 5. `request:after` hooks now fire

`HOOKS.REQUEST_AFTER` was declared and never invoked. It now runs after the
vendor call.

```js
import { createHooks, HOOKS } from 'merci-sdk';

const hooks = createHooks();
hooks.add({
    name: HOOKS.REQUEST_AFTER,
    fn: ({ request, response, error }) => {
        console.log('vendor round trip', response.durationMs, error?.message ?? 'ok');
    }
});

const session = client.session(model).withHooks({ hooks });
```

The chain is **serial and observational**: it sees the request, the round-trip
duration and the error, but it cannot transform the response — the stream is
already being consumed. A hook that throws is reported and ignored; an
observer never breaks a run. The event `hook:request_after` is emitted with
`{ hooks, durationMs, ok }`.

**What to do** — nothing, unless you had a `request:after` hook that silently
never ran and depended on it not running.

## 6. The vendor-call retry has one owner

The session already retries the vendor call. The adapter-level policy retried
it again, so one failure could cost up to nine calls.

**After** — the session is the owner. A session that opens the vendor call
itself runs it once; an adapter used directly (no session) still retries under
the session's policy, bounded by `maxElapsedMs` and honouring the abort
signal.

**What to do** — nothing. If you counted vendor calls to size a rate limit,
the count is now the number of attempts, not its square.

## 7. The citations shape

**Before** — the citations arrived in per-vendor shapes, and the step's event
switch had no case for the event, so they were dropped before the caller saw
them.

**After** — one shape, for Gemini grounding and Anthropic citations alike:

```js
{
    type: 'citations',
    data: {
        citations: [
            { uri: 'https://example.com/doc', title: 'Doc', text: 'the quoted passage' }
        ]
    }
}
```

`text` is the quoted passage when the vendor provides one, otherwise an empty
string. The plain `{ type: 'sources', data: { sources: [{ title, url }] } }`
tail is emitted next to it.

A refusal is not a citation. On the Gemini and Anthropic backends it arrives
as a `type: 'error'` event with `refusal: true` and the vendor's own reason in
`refusal_reason`:

```js
{ type: 'error', error_type: 'refusal', refusal: true, refusal_reason: 'SAFETY', error_message: '…' }
```

The OpenAI-compatible backend reports a refusal as `type: 'error'` with
`error_type: 'refusal'` and no `refusal` flag.

**What to do** — if you parsed the old per-vendor citation shapes, read
`event.data.citations[]` instead. If you detected a refusal by string-matching
the error text, match `refusal === true` instead.

## 8. New builder methods

These are additive. They are on the session builder, so they chain the same way
as the existing `with*` methods.

```js
const session = client.session(model)
    // The input/output tripwire. A `block` rule refuses the run with
    // GuardrailViolationError; a `warn` rule reports the match.
    .withGuardrails({
        rules: [
            { name: 'no-secrets', phase: 'input', pattern: /AKIA[0-9A-Z]{16}/, action: 'block' },
            { name: 'no-secrets-out', phase: 'output', pattern: 'sk-ant-', action: 'warn' }
        ]
    })
    // Which tools the model may call, and how a gated tool is approved.
    .withPermissions({ allow: ['read_*', 'write_*'], deny: ['execute_shell_command'], mode: 'acceptEdits' })
    // The round-wide tool timeout. A tool may override it with its own timeoutMs.
    .withToolTimeout({ ms: 30_000 })
    // OTLP export of the session's events and vendor calls.
    .withTelemetry({ exporter: createOtlpExporter({ endpoint: 'http://collector:4318/v1/traces' }) })
    // The budget. maxTotalTokens always works; maxBudgetUsd needs a backend
    // that reports the amount.
    .withBudget({ budget: { maxTotalTokens: 200_000 } });
```

| Method | Effect |
|--------|--------|
| `withGuardrails({ rules })` | `{ name, phase, pattern, action, message }` per rule; `phase` is `input`, `output` or `both`; `pattern` is a `RegExp` or a case-insensitive substring; `action` is `block` or `warn` |
| `withPermissions({ allow, deny, mode })` | tool names or globs; the deny list always wins; `mode` is `default`, `acceptEdits` or `bypassPermissions` |
| `withToolTimeout({ ms })` | the round unblocks with a timeout error and the turn continues; the tool keeps running (at-least-once) |
| `withTelemetry({ exporter })` | the exporter is attached to the session's event emitter and, unless `observer: false`, runs next to the default observer through `CompositeApiObserver` |
| `withBudget({ budget })` | `maxTotalTokens` and `maxBudgetUsd` — see item 2 |

`withPricing({ table })` is **removed** — see item 1.

**What to do** — nothing. All five are new.

## 9. New events

The canonical names live in `EVENTS` (`lib/core/events.mjs`). The new ones
against the previous public state:

| Event | Group | Payload |
|-------|-------|---------|
| `hook:request_after` | `EVENTS.HOOKS.REQUEST_AFTER` | `{ hooks, durationMs, ok }` |
| `guardrail:tripped` | `EVENTS.GUARDRAIL.TRIPPED` | `{ rule, phase, action, blocked }` |
| `permissions:bypass` | `EVENTS.PERMISSIONS.BYPASS` | `{ mode: 'bypassPermissions' }` |
| `session:store_fork` | `EVENTS.SESSION.STORE_FORK` | `{ threadId, path, forkedFrom }` |
| `run:budget_unreported` | `EVENTS.CLIENT.BUDGET_UNREPORTED` | `{ maxBudgetUsd, model, unreportedCalls }` — `unreportedCalls` counts the calls that spent tokens with no amount; the run's `usage.cost_unreported_calls` carries the same count |
| `run:budget_starved` | `EVENTS.CLIENT.BUDGET_STARVED` | `{ maxTotalTokens, remainingTokens, minOutputTokens }` — a turn that was never contended runs with an allowance at or below the minimum usable output (the documented one-call overshoot); the event is the notice that its answer may be cut short. A contended turn waits instead (`budget_admission_wait_ms`) and either gets a usable share or fails with `run:budget_exceeded` |
| `citations` | `EVENTS.STEP.CITATIONS` | a stream event: `{ type: 'citations', data: { citations: [{ uri, title, text }] } }` |
| `a2a:stream_update` | `EVENTS.A2A.STREAM_UPDATE` | `{ url, id, state }` — the A2A streaming frame the client consumed |
| `mcp:tools_changed` | `EVENTS.MCP.TOOLS_CHANGED` | `{}` — the server's tool list changed |
| `mcp:resources_fetched` | `EVENTS.MCP.RESOURCES_FETCHED` | `{ count }` |
| `mcp:resource_read` | `EVENTS.MCP.RESOURCE_READ` | `{ uri }` |
| `mcp:prompts_fetched` | `EVENTS.MCP.PROMPTS_FETCHED` | `{ count }` |
| `mcp:prompt_fetched` | `EVENTS.MCP.PROMPT_FETCHED` | `{ name }` |
| `mcp:server_retry` | `EVENTS.MCP.SERVER_RETRY` | `{ attempt, delayMs, error }` — a reconnect attempt |

```js
import { EVENTS } from 'merci-sdk';

client.on(EVENTS.GUARDRAIL.TRIPPED, (e) => {
    console.log(e.rule, e.phase, e.action, e.blocked);
});
```

**What to do** — nothing. The additions are observable, not behavioural: no
existing event name or envelope changed. (The one payload that changed is the
run's `usage` snapshot — see item 1.) Note that the step-stream type
`citations` is a stream event (`{ type, ... }`), not an emitter event —
subscribe to it on the `onEvent` stream, not on the client emitter.

## 10. A2A v1.0.0, the MCP server / client callbacks, and the ACP v1 session lifecycle

This is the section to read if you used the pre-v1 wire shapes.

### A2A

The client used to call the agent card's **skill name as a JSON-RPC method** —
a private dialect no A2A peer speaks. It now speaks the specification.

- The **v1.0** binding uses the proto method names (`SendMessage`,
  `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`), the role
  `ROLE_USER`, the uppercase task states (`TASK_STATE_COMPLETED`) and a
  protobuf-JSON message part (`{"text":"…"}`).
- The **v0.3** dialect (slash names, `{"kind":"text"}`) is still detected from
  the card and still works.
- `SendMessage` answers with `{ task: … }`; `GetTask` and `CancelTask` answer
  with a bare task.
- The event stream carries JSON-RPC responses: a `statusUpdate`, an
  `artifactUpdate` or a `task`. The client also reads the legacy flat frames.
- A2A v1.0 has **no skill field**. The selector travels in
  `params.metadata.skillId`; the server resolves the skill from it and strips
  the selector from the arguments.

```js
import { loadA2ATool } from 'merci-sdk';

const tool = await loadA2ATool({ agentUrl: 'http://peer.local' });
// The tool's arguments may carry { skillId: 'review' }; the SDK sends it as
// params.metadata.skillId and the peer resolves the skill.
```

`createA2AServer` and `createA2AHttpHandler` (new, `lib/tools/a2a-server.mjs`)
expose a Merci agent as an A2A v1.0 peer over `node:http`.

### MCP

- The **client** now declares `sampling`, `elicitation` and `roots` and
  answers them. A handler may only be registered for a capability the client
  declared — the MCP SDK rejects the other case. Roots and sampling are
  **deprecated by MCP `2026-07-28`** (SEP-2577, with Logging, which merci does
  not implement); they stay functional until the first spec revision released
  on or after 2027-07-28 at the earliest, so do not build new features on them.
- Resources and prompts are readable: `listResources`, `readResource`,
  `listPrompts`, `getPrompt`.
- The **server** can serve tools, resources and prompts over the Streamable
  HTTP transport with `createMcpHttpHandler`. A stateless server creates one
  transport per request; a stateful server keeps one per session.
- A server tool may declare an `outputSchema`; the result is returned as
  `structuredContent` and validated against the schema.

```js
import { createMcpHttpHandler } from 'merci-sdk';

const handler = await createMcpHttpHandler({
    name: 'my-tools',
    tools: [readFileTool],
    resources: [{ uri: 'file:///README.md', name: 'README', read: () => '…' }],
    prompts: [{ name: 'review', render: ({ args }) => `Review ${args.target}` }]
});
```

### ACP

`createAcpAgent` implements the full ACP v1 method set: `initialize`,
`authenticate`, `session/new`, `session/load`, `session/list`, `session/delete`,
`session/fork`, `session/prompt` and `session/cancel` (a **notification** in
ACP v1, not a request). `session/update` carries message chunks, thought
chunks, tool calls, tool-call updates and plan entries.

A capability the client did not advertise at `initialize` is never called:
`readFile` and `writeFile` refuse when the client did not offer them. A
permission decision for an option id the agent never offered **denies**.

`loadSession` is advertised **false**: the agent keeps no transcript, so
`session/load` validates the id but cannot replay a conversation. With
`createAcpAgent({ createSession })` each ACP id gets its own merci session
(`{ sessionId, cwd, parentSessionId }`; `session/fork` passes its source as
`parentSessionId`); with a single `session`, every id shares it and its prompts
are queued (see [section 12](#12-after-072--the-production-loop-releases-073-080)).
A client that needs a replay must keep its own transcript.

**What to do** — if you called an A2A peer by skill name as a method, or
parsed a bespoke A2A frame, change the call and the parse. Everything else in
this section is additive.

## 11. The tool contract

Three additions to the tool definition, all optional:

```js
const tool = {
    name: 'read_notes',
    description: 'Read a note.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    // A per-tool timeout. It overrides the session's withToolTimeout({ ms }).
    timeoutMs: 5_000,
    // A schema the result must satisfy. A violating result fails the call
    // instead of reaching the model as a wrong answer.
    outputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' } },
        required: ['title', 'body']
    },
    execute: async ({ args }) => ({ title: 'n', body: 'b' })
};
```

Oversized results are capped in **any** shape now. `capToolOutput` bounds a
string; `capToolOutputValue` bounds an object or an array, keeping the
top-level shape and eliding what does not fit with a `'[…]'` marker. The keys
count against the budget, and an exhausted budget shortens a key.

```js
import { capToolOutputValue } from 'merci-sdk';

const { value, truncated } = capToolOutputValue({ value: someObject, maxLength: 8_000 });
```

**What to do** — nothing, unless a tool of yours was hanging the turn or
returning a payload you want bounded. Then add `timeoutMs`.

---

## 12. After 0.7.2 — the production-loop releases (0.7.3, 0.8.0)

| Change | Before | After | What to do |
|--------|--------|-------|------------|
| Argument patterns in permission rules | `withPermissions({ deny: ['Bash(rm:*)'] })` was accepted and matched nothing (rules match tool names, and a name never contains `(`) | a pattern containing `(` throws `ConfigurationError` | name the tool (`execute_shell_command`) or a glob (`write_*`); gate arguments with an approval handler or a guardrail |
| ACP prompt context | read from a top-level `_merci`, which the ACP SDK strips | read from `_meta.merci` (ACP's extension slot), `_merci` as the fallback | send the envelope in `_meta.merci` |
| **0.8.0** — OTel span names | every event was a zero-length span named after the event, and a vendor call was one `api.call` span | a gen_ai span tree: `invoke_agent` (run:start → run:end), `chat {model}` (CLIENT, one per vendor call, closed at the end of the stream with `gen_ai.usage.input_tokens`/`output_tokens`), `execute_tool {name}`; children are parented by span. Every other event is a **span event** on its run's open span (a loose event with no open span still becomes a zero-length span) | rename dashboards and queries: `api.call` → `chat {model}` (or `gen_ai.operation.name = chat`), `run:start` → `invoke_agent`, `tool:call_start` → `execute_tool {name}` |
| **0.8.0** — `api_response` timing | `onResponse` / `api_response` fired at the stream's first event | they fire when the response has fully arrived (the stream's end), with `usage`; a stream stopped early reports `{ ok: false, aborted: true }`; a failed call's `onError` follows the `request:after` chain | a consumer that read `api_response.durationMs` as time-to-first-token should read `stream:first_token.latencyMs` |
| **0.8.0** — `createGuardrails().check` is async | `check({ phase, text })` returned the verdict | it returns a `Promise` of the verdict, so a rule may be an async predicate (`test: async (text) => …`, e.g. a moderation call); new phases `tool_input` / `tool_output` watch tool calls | `await guardrails.check(…)` (sessions using `withGuardrails` need no change) |
| **0.8.0** — child process environment | every child (`createShellTool`, skill scripts, `runCommand`, the obscura browser binary, the `rg` behind `createContextTools`' grep/glob) inherited the whole `process.env`, API keys included | a child gets the safe allowlist (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`; the Windows equivalents) plus, where offered, an explicit `env` | for the old behaviour pass `inheritEnv: true` to `createShellTool({ options })`, `loadSkillsFromDirectory`, `runCommand` or the browser config (`withBrowser({ … inheritEnv })`, or `obscura: { inheritEnv }`); to pass only a few variables (e.g. `HTTPS_PROXY`), give `runCommand` or the browser config an `env`. `rg` needs only `PATH` |

---

## No action needed

The public API is additive in this release. If you do not use the price table,
the money budget, `stream: false`, SKILL.md frontmatter or `request:after`
hooks, **the code that worked on `0.7.1` still works, unchanged**. For 0.8.0
the same holds unless you rely on a child process inheriting `process.env`,
call `createGuardrails().check` directly, read `api_response` as the first
event, or query the old OTel span names — [section 12](#12-after-072--the-production-loop-releases-073-080)
lists each.

Specifically, all of this is unaffected:

- `client.session(model)`, `session.step(...)` and `session.run(...)` — same
  call shapes, same unified event stream.
- Every message factory (`createUserMessage`, `createSystemMessage`,
  `createAssistantMessage`, `createToolCallMessage`, `createToolResultMessage`)
  and `normalizeHistory`.
- The orchestration engines: `WorkflowExecutor` (from `merci-sdk/planning`),
  `StateMachine` and `DiscussionSession` (from `merci-sdk`).
- The protocol helpers: `loadMcpTools`, `loadMcpToolsFrom`, `createMcpServer`,
  `loadA2ATool`, `getA2ATask`, `cancelA2ATask`, `createAcpAgent`.
- The `transfer` presets, the typed `stateSchema`, the context processors and
  the per-agent transport routing.
- The existing `with*` builder methods: `withTools`, `withParameters`,
  `withSystemMessage`, `withObjective`, `withRetryPolicy`, `withTimeout`,
  `withApproval`, `withMemory`, `withSkills`, `withTaskAgents`,
  `withSessionStore`, `withExecutionJournal`, `withCompaction`,
  `withWebSearch`, `withWebScrape`, `withBrowser`, `withCapability`,
  `withStateMachine`, `withPlan`, `withExecute`, `withTodos`, `withHooks`.

The only edits a consumer may need are the ones in the table above, and each
one names the API to change.

## 13. 0.9.0 — HTTP server host allowlist and body caps

`createMcpHttpHandler` and `createA2AHttpHandler` now answer `403` when the
request's `Host` header does not name a loopback host (`localhost`, `127.0.0.1`,
`::1`; the port is ignored). A server bound to a non-local interface must pass
the names it serves:

```js
const handler = await createMcpHttpHandler({ tools, allowedHosts: ['api.example.com'] });
const a2a = createA2AHttpHandler({ server, allowedHosts: ['api.example.com'] });
```

`allowAnyHost: true` restores the previous behavior. This is a DNS-rebinding
fix; prefer the allowlist.

The MCP HTTP handler now lets the SDK read the request body, so the SDK's 4 MiB
cap answers `413`. The A2A handler caps a request body at 10 MB
(`A2A_REQUEST_MAX_BODY_BYTES`) with `413`. Both servers keep serving after an
oversized request.

## 14. 0.9.0 — protocol server lifecycle and MCP tool timeouts

`createMcpHttpHandler` now returns a third member, `close()`, which closes every
live session and its server. A `DELETE` from the client, or a transport that
closes itself, removes its session from `sessions`; the map no longer grows for
the life of the process. Shut an HTTP server down with:

```js
const handler = await createMcpHttpHandler({ tools });
const http = createServer(handler.handle);
http.on('close', () => { void handler.close(); });
```

An MCP tool call now defaults to a **60 s** timeout (`MCP_DEFAULT_TIMEOUT_MS`,
the SDK's own default) instead of 5 s. Progress notifications reset the
timeout while the tool reports it is alive, and each one emits the new
`mcp:call_progress` event (`EVENTS.MCP.CALL_PROGRESS`).

ACP: `initialize` advertises `agentCapabilities.sessionCapabilities` as
`{ list: {}, delete: {}, close: {}, fork: {} }`. `session/close` is handled and,
like `session/delete`, cancels the session's running turn before freeing the
record.

The A2A server now cancels a running skill on `tasks/cancel`, keeps the
CANCELED state when the skill finishes anyway, pages `tasks/list` by decimal
offset, and prunes terminal tasks after one hour or above 1000 entries.

## 15. 0.10.0 — MCP TypeScript SDK v2

The MCP client and server now run on the official **v2** packages
(`@modelcontextprotocol/client`, `/server`, `/node`) instead of
`@modelcontextprotocol/sdk`. merci's own API is unchanged: `McpClient`,
`loadMcpTools`, `loadMcpToolsFrom`, `createMcpServer` and
`createMcpHttpHandler` keep their signatures. The v1 SDK remains a
devDependency so the test suite keeps checking a v1 client against merci's
server (and a v1 server against merci's client).

One new option selects the wire era:

```js
const mcp = new McpClient({ command: 'npx', args: ['@some/mcp-server'], options: {
    mcpProtocolVersion: 'auto', // 'legacy' (default) | 'auto' | '2026-07-28'
} });
```

- `'legacy'` (the default) is the plain 2025 `initialize` handshake,
  byte-identical to before. No action needed.
- `'auto'` probes `server/discover` first and falls back to the 2025
  handshake. On a stdio transport the SDK spawns one short-lived sibling
  process for the probe; the real child starts once.
- A date string (for example `'2026-07-28'`) pins the modern era to that
  revision and fails loudly if the server does not offer it.

On the modern era, a tool that answers `input_required` (multi-round-trip)
is fulfilled automatically through the registered `onElicit` / `onSampling` /
roots handlers, then retried; `executeTool` returns the plain result.

Two R1 controls are deliberately kept as merci code. The host allowlist stays
`requestHostAllowed`, because the SDK's `validateHostHeader` requires a
bracketed `[::1]` allowlist entry and refuses a trailing-dot host, so
switching would break an existing `allowedHosts: ['::1']` and tighten a
loopback host spelling. (The SDK helper is hostname-only and port-agnostic,
like `requestHostAllowed`; the difference is the IPv6 spelling and the
trailing dot.) The 4 MiB MCP request cap is unchanged: the v2
transport enforces its own `maxRequestBodySize` default of 4 MiB, and merci
still hands it no pre-parsed body.

Server-side handlers now read the abort signal from `ctx.mcpReq.signal`
instead of `extra.signal`; this only matters if you call the SDK directly.

Three behaviours differ on purpose:

- The `server/discover` probe is capped at **10 s**
  (`MCP_PROBE_TIMEOUT_MS`). The SDK inherits its 60 s request timeout
  otherwise, and a legacy server that silently ignores an unknown
  pre-`initialize` request would stall every `'auto'` connect — and every
  reconnect attempt — for a minute before falling back. On stdio a silent
  probe means a legacy server; on HTTP it means an outage and the connect
  rejects.
- An aborted `executeTool` rejects with `AbortedError` (the repo's abort
  type, `isAbortError` recognises it) instead of the SDK's
  `SdkError('REQUEST_TIMEOUT')`, which cannot be told apart from a real
  timeout by code.
- A list call now uses the SDK's auto-aggregating path. That aggregates every
  page (previously only `getTools` paged), but it is capped at 64 pages and
  **throws** `ListPaginationExceeded` rather than truncating at merci's old
  100-page guard. A server with more than 64 pages of tools, resources or
  prompts needs the explicit pagination work scheduled for R3.

`createMcpHttpHandler` now takes its options as a single object (the same call
shape as before) because an explicit `sessionIdGenerator: undefined` must be
distinguishable from an omitted one: the former is stateless, the latter
stateful with a random UUID. The previous default parameter made the stateless
switch unreachable.

## 16. 0.11.0 — the DNS guard pins the curl scrape leg

`web_scrape` and the browser tool's curl read leg now resolve the hostname
once per redirect hop and connect to that exact address. The URL hostname
still supplies the `Host` header, the TLS SNI name and the certificate
check, so a hostname that resolves to loopback or a private range cannot
slip through between the check and the socket. `resolvesToPublicHost`
keeps its boolean result; `resolvePublicAddress` is the new helper that
returns the address to pin.

The browser (Playwright) leg cannot pin the address the same way: it uses
Playwright's own resolver, so it remains check-then-connect. The literal
host guard and the per-hop policy check still apply there.

This is a **known residual, not a fix**: a CDP-connected browser is a *remote*
browser, so the client has no launch arguments and no resolver rules to hand it.
A name that resolves to a public address for the policy check and to a private
one for Chromium therefore reaches the private host. Closing it needs a local
proxy in front of the browser, which this release does not build. What the leg
does enforce: every HTTP request passes one context route (literal host, DNS
and the session domain policy); service-worker *registration* is blocked
(`serviceWorkers: 'block'`), so a page cannot install one — a registration that
already exists in a reused CDP profile still controls its origin and its fetches
bypass the route, which is a residual this release cannot close; and WebSockets —
which `route` never sees — pass the same policy through `routeWebSocket` and are
closed when refused. A context that exposes only one of the two routing legs
fails closed rather than running one leg unpoliced.

No API changes: the engines, `web_scrape` and the browser tool keep their
signatures. `CurlEngine` accepts an optional `fetch` in its options bag as
a test seam; production uses the pinned request.

## 17. 0.11.0 — stateless 2026-07-28 MCP server mode

`createMcpHttpHandler({ mcpProtocolVersion: '2026-07-28' })` serves the
2026-07-28 era through the SDK's `createMcpHandler` + `toNodeHandler`: one
server per request, no `Mcp-Session-Id`, and 2025-era traffic served
statelessly from the same factory. The default is unchanged: the stateful
2025 handler still mints a session on `initialize`.

A 2025 client that needs `Mcp-Session-Id`, GET streams or DELETE must keep
the default handler; the modern mode answers GET and DELETE with 405 and
sends JSON bodies. The host allowlist, the tool/resource/prompt surface and
the 4 MiB request cap are the same in both modes.

`createMcpServer({ mcpProtocolVersion: '2026-07-28' })` is the stdio
counterpart: it wraps the SDK's `serveStdio`, which selects the era from the
opening exchange and pins one instance per connection. A 2026-07-28 opening
gets the modern era; a 2025 `initialize` is still served (`legacy: 'serve'`).
The modern handle keeps the default handle's shape where it can:
`setRequestHandler` queues a registration until the first message pins the
instance and then replays it (a handler registered after the handshake goes
straight to the instance), and `getClientVersion` answers once the handshake
has happened. `connect` is the one member it cannot honour — `serveStdio` owns
the transport — so it throws a `ConfigurationError`. The default (`'legacy'`)
keeps the connected server handle unchanged.

## 18. 0.11.0 — MCP Tasks interop (legacy era only)

The v2 SDK marks the 2025-11-25 task vocabulary deprecated and ships no
runtime, but some deployed servers still serve it. merci speaks it directly
on the legacy era:

- A tool definition may set `taskSupport: 'optional' | 'required'`. The
  server then advertises `capabilities.tasks`, lists the tool with
  `execution.taskSupport`, and answers a `tools/call` that carries `task`
  with a task object immediately.
- `McpClient.startToolTask`, `getTask`, `getTaskResult`, `listTasks` and
  `cancelTask` poll and cancel that task. A cancelled task stays cancelled;
  a late tool result cannot revive it.

Tasks are not available on the 2026-07-28 era (the spec removed the
vocabulary) or on the stateless legacy HTTP mode (a task needs a live server
between requests). The task-creation result also carries an empty `content`
array, because the v2 client's `tools/call` decoder requires `content` even
when the body is a task.

The follow-up revisit tightened the shim:

- A tool with `taskSupport: 'required'` rejects a plain `tools/call` with an
  error result; the client must send a task.
- `ttl` is retention from the last update, not a run deadline: a working task
  no longer expires while its tool is still running, and a finished task is
  kept for `ttl` before it is dropped.
- Closing the server aborts every task still in flight, so a tool that waits
  on its signal cannot outlive the connection.
- `McpClient.waitForTask` polls to a terminal state with its own budget.
- The whole surface is marked `@deprecated`: the vocabulary is deprecated in
  the v2 SDK and will be removed with the 2025-11-25 peers that still serve
  it.

## 19. 0.11.0 — SQLite memory bank; Node ≥22.13

`SqliteMemoryProvider` stores the same bank shape as
`LocalFileMemoryProvider` in a `memory_bank` table (`node:sqlite`): one
transaction per save, WAL plus a busy timeout, and the same read-merge-write
so two writers keep both facts and both audit rows. The public methods are
the same (`load`, `save`, `query`, `store`, `delete`, `clear`) plus
`close()`.

`node:sqlite` is imported lazily, so a file-backed user never sees its
ExperimentalWarning; a SQLite user does, on the first load or save. That is
the API's own warning, not merci's.

The engine floor moves from `>=22.0.0` to `>=22.13.0`, the first Node
release with `node:sqlite`. Node 22.0–22.12 users stay on the file bank.

## 21. 0.12.0 — MCP tasks: a pluggable store and a modern-only stdio mode

The legacy 2025-11-25 task vocabulary can now outlive the server that created
it: `createMcpServer` and a stateful `createMcpHttpHandler` accept a
`taskStore` implementing `McpTaskStoreLike` (`start`, `get`, `result`, `list`,
`cancel`, `close`). `McpTaskStore` is exported as the reference
implementation. A supplied store is shared and closed by its caller; the
server still cancels the tasks its own session started. `taskStore` is refused
in the stateless and 2026-07-28 modes, where a task cannot be reached from the
request that polls it.

`McpClient` gains `onTaskStatus` (and the `mcp:task_status` event) for
`notifications/tasks/status`. `tasks/list` pages by cursor, so `listTasks`
now resolves `{ tasks, nextCursor }` instead of a bare array:

| Before | After |
| --- | --- |
| `const tasks = await client.listTasks()` | `const { tasks, nextCursor } = await client.listTasks()` |
| an unknown task rejected with a message | rejects with `ERROR_CODES.MCP_UNKNOWN_TASK` |

`createMcpServer({ mcpProtocolVersion: '2026-07-28', legacy: 'reject' })`
refuses a 2025 client instead of serving it. The default stays
`legacy: 'serve'`.

## 22. 0.12.0 — the coordination layer (additive)

Four subpaths join the published surface, and one new one composes them:

| Subpath | Primary names |
| --- | --- |
| `merci-sdk/workspace` | `WorkspaceManager`, `createWorkspaceTools`, `workspaceKeyFor`, … |
| `merci-sdk/scheduler` | `WorkScheduler`, `createEngineRunner`, the work sources and claim stores |
| `merci-sdk/operator` | `createOperatorHttpHandler`, `createEventRing`, `formatStatus` |
| `merci-sdk/workflow-policy` | `WorkflowPolicy`, `policyToSchedulerOptions`, `policyToWorkspaceOptions`, `createPolicyRenderer` |
| `merci-sdk/orchestration` | `createOrchestration` — the four, wired |

The primary classes of all four modules are also re-exported from the main
entry, beside `MemoryManager` and `StateMachine`; the constants and defaults
(`SCHEDULER_DEFAULTS`, `CLAIM_STATES`, `WORK_SOURCE_CATEGORIES`,
`WORKFLOW_POLICY_DEFAULTS`, `OPERATOR_DEFAULTS`, `OPERATOR_API_VERSION`) stay on
their subpath. Four error types are on the main entry: `WorkspaceError`,
`WorkSourceError`, `SchedulerError`, `PolicyError`.

Two behaviour notes for anyone who wired the primitives by hand:

- `policyToSchedulerOptions` memoizes its `preflight` closure per policy
  instance. A reload that changed only the prompt now returns
  `applyConfig(…) → { applied: false, changed: [] }` instead of reporting a
  `preflight` change.
- `WorkspaceManager` events emitted during a scheduler attempt now carry that
  attempt's `runId`, and the operator's event ring records `workflow_policy:*`
  by default. A parser that assumed the old three ring prefixes should read
  `OPERATOR_API.md` §9.

**No existing call is removed or changed in meaning.** A consumer that does not
use the coordination layer has nothing to edit.

## 0.23.2 — Docs truth

No API change. `0.23.2` fixes the README quickstart: the model now comes from
`getDefaultModel({ provider })` instead of a stale literal, the discussion
example follows the same rule, and a docs gate rejects a hardcoded model in
that block. Nothing to edit.

## 0.23.1 — Packaging, docs and licensing

No API change. `0.23.1` ships the JAI premature-end behaviour fixes listed in
`CHANGELOG.md` together with the public package layout, regenerated docs and
the licensing note: the TypeScript/JavaScript SDK is Apache-2.0, a Rust
implementation is licensed separately, and support, development and
professional services are paid engagements. Nothing to edit.

## 0.23.0 — Agent definition files

No API is removed or renamed. `0.23.0` is additive plus the behaviour fixes
listed in `CHANGELOG.md`: agent definition files (`merci-sdk/agents`,
`*.agent.yaml`), catalog groups and `native:`/`host:`/`skill:`/`script:`/
`mcp:`/`acp:`/`a2a:` selectors for tool selection, script-backed tools,
`withAdditionalTools`, and the session inbox (`getPendingInputs`,
`cancelInput`, `setInputDelivery`, `drainInbox`, `isRunning`).

## 0.22.2 — Memory embedder binding

No action needed. `0.22.2` binds the `client.embed` method that
`withMemory()` hands to the memory provider. On `0.22.0`/`0.22.1` that method
was called unbound, so it threw before reaching the provider and the vector
tier silently fell back to lexical recall (the fact was stored without an
embedding). Existing banks backfill their embeddings on the next recall.

## 0.22.1 — Vertex tool-round tail fix

No action needed. `0.22.1` fixes a Vertex-only request shape: after a tool
round, a trailing live-state block (todos, preloaded memory, skills) merged
into the tool result turn as `[functionResponse, text]`, which Vertex rejects
with `400 Requests ending with a model turn are not supported.` The GAI
normalizer now sends `[text, functionResponse]` in that turn. Sessions without
a trailing live-state block send the same bytes as `0.22.0`.

## 0.22.0 — The Anthropic and Google transports are fetch connectors

The `aai` standard (`anthropic`) no longer uses `@anthropic-ai/sdk`, and the
`gai` standard (`google_genai`, `vertex`) no longer uses `@google/genai`. Both
run on the SDK's built-in native `fetch` connector — the shared layer the `oai`
standard moved to in 0.21.0, with the 0.21.1 fixes to it. Request and response
bodies are unchanged, pinned by the 26 Anthropic and 51 Google recorded parity
fixtures in `test/fixtures/aai-parity/` and `test/fixtures/gai-parity/`.

### Anthropic migration

| Before (0.21.1) | After (0.22.0) |
| --- | --- |
| `options.anthropicOptions` | refused with `ConfigurationError` |
| `anthropicOptions.baseURL` | `options.baseURL` |
| `anthropicOptions.fetch` / `.defaultHeaders` / `.timeout` | `options.transportOptions.fetch` / `.defaultHeaders` / `.timeout` |
| `anthropicOptions.maxRetries` | not available — Merci owns retries |
| `@anthropic-ai/sdk` as a dependency | not a dependency |

```js
// before
new MerciClient({ options: { apiKey, anthropicOptions: { baseURL: 'https://gw', timeout: 5_000 } } });
// after
new MerciClient({ options: { apiKey, baseURL: 'https://gw', transportOptions: { timeout: 5_000 } } });
```

`baseURL` still resolves as `options.baseURL` → `ANTHROPIC_BASE_URL` (trimmed,
blank ignored) → `https://api.anthropic.com`.

### Google migration

| Before (0.21.1) | After (0.22.0) |
| --- | --- |
| `options.genaiOptions` with any key outside the closed list | refused with `ConfigurationError` |
| `genaiOptions.vertexai` / `.enterprise` | unchanged (`enterprise` is an alias of `vertexai`) |
| `genaiOptions.project` / `.location` / `.apiVersion` | unchanged |
| `genaiOptions.googleAuthOptions.credentials` / `.keyFile` / `.scopes` | unchanged |
| `genaiOptions.httpOptions` | refused — `options.baseURL` + `options.transportOptions.fetch` / `.defaultHeaders` / `.timeout` |
| `genaiOptions.httpOptions.timeout` (per call) | still works as `config.httpOptions.timeout` on the call |
| `@google/genai` as a dependency | not a dependency |
| `google-auth-library` as a transitive dependency | not a dependency |

`genaiOptions` is **a closed bag**: `vertexai` (or `enterprise`), `project`,
`location`, `apiVersion`, and `googleAuthOptions` with `credentials`, `keyFile`
and `scopes`. An unknown key throws a `ConfigurationError` that names the
supported ones, instead of being silently ignored.

```js
// before
new MerciClient({ options: { genaiOptions: {
    vertexai: true, project, location: 'us-central1',
    httpOptions: { timeout: 5_000, baseUrl: 'https://gw' },
} } });
// after
new MerciClient({ options: {
    baseURL: 'https://gw',
    transportOptions: { timeout: 5_000 },
    genaiOptions: { vertexai: true, project, location: 'us-central1',
        googleAuthOptions: { keyFile: '/secrets/sa.json' } },
} });
```

**Vertex auth is native.** `genaiOptions` no longer routes into
`google-auth-library`. `lib/backends/transport/google-auth.mjs` resolves
application default credentials in the same order the vendor library did:
explicit `googleAuthOptions.credentials`, explicit
`googleAuthOptions.keyFile`, `GOOGLE_APPLICATION_CREDENTIALS`, the well-known ADC
file, then the GCE/GKE metadata server. `service_account` and
`authorized_user` credentials are exchanged for an access token; **`external_account`
(workload identity federation), impersonation and GDCH credentials are refused**
with a `ConfigurationError`. A `service_account` key may still carry a
`subject` for domain-wide delegation.

**The GAI error surface is `ApiError` with `status`**, as the vendor client
raised it: the message is the JSON error body and `status` is the HTTP code.

**Automatic continuation is not performed.** A response that asks for a function
call is returned to the adapter; the connector never re-sends the turn with the
tool result on its own. Keep driving the loop explicitly.

### The wire

- **Anthropic auth and version.** `Authorization: Bearer <apiKey>` and
  `anthropic-version: 2026-10-21` on every request. That is the wire
  `@anthropic-ai/sdk@1.5.0` already sent — the vendor client authenticates with
  the bearer header, not `x-api-key` — so a gateway in front of the provider
  sees no change.
- **Headers.** No `User-Agent: Anthropic/JS …`, no `X-Stainless-*`; this SDK's
  `User-Agent: merci-sdk/<version>` replaces them. A gateway that routed or
  logged on the vendor headers must key on the path instead.
- **Anthropic paths.** `POST /v1/messages` and `GET /v1/models` (plus
  `?after_id=`) under `baseURL`, unchanged.
- **Google routing.** The Gemini Developer API root is
  `https://generativelanguage.googleapis.com` at `v1beta`; Vertex derives its
  root from `location` (`global` → `aiplatform.googleapis.com`, `us`/`eu` →
  `aiplatform.{us,eu}.rep.googleapis.com`, otherwise
  `https://{location}-aiplatform.googleapis.com`) at `v1beta1`, and a model
  path is `projects/{project}/locations/{location}/<model resource>`.
  `models.list()` reads `publishers/google/models` on Vertex and `models` on
  Gemini.
- **Vertex Express needs no `project`.** With `vertexai: true` and no
  `project`, the connector addresses `publishers/google/models/<model>`
  directly (`:streamGenerateContent`, `models.list()`, `:embedContent`,
  `:predict`) instead of refusing the call; with a `project` it keeps the
  `projects/{project}/locations/{location}/` prefix. Set `project` when you
  have one.
- **Google embeddings.** Gemini batches through `:batchEmbedContents`; Vertex
  uses `:embedContent` for a Gemini embed model and `:predict` otherwise.
  `:embedContent` answers `{embedding: {values}, usageMetadata?, truncated?}`
  and becomes one embedding with `statistics` (`tokenCount`, `tokensDetails`,
  `truncated`); only `:predict` answers `predictions[].embeddings`, one per
  input, and each instance is the first text of its content (an input with no
  text is dropped).
- **`models.embedContent` accepts a `config` mapping, per endpoint.** Gemini
  puts `taskType`, `title` and `outputDimensionality` on every
  `:batchEmbedContents` request; Vertex sends them as `embedContentConfig` on
  `:embedContent`, and as `instances[].task_type` / `.title` plus
  `parameters.outputDimensionality` on `:predict`. `mimeType`, `autoTruncate`,
  `documentOcr` and `audioTrackExtraction` are Vertex-only and refused on
  Gemini. `MerciClient.embed()` does not pass a config; it always sends Content
  objects, so the contents rules below are the transport surface.
- **`contents` rules.** A bare part is one `user` content, a list of parts is
  one content carrying all of them, a list of Content objects passes through,
  and a mixed list or a bare `functionCall`/`functionResponse` part is refused
  before any request. For Gemini embedding, a string list becomes one content
  (one request, one vector) on `gemini-embedding-2` and one request per string
  on every other embed model.
- **`responseSchema` is normalised, `responseJsonSchema` is not.** String types
  and `type` arrays are uppercased (`['string', 'null']` becomes
  `{type: 'STRING', nullable: true}`, `['string', 'number']` becomes an `anyOf`
  of both) through `properties`, `items` and `anyOf` members, a two-member
  `anyOf` with a `null` branch becomes `nullable` on the other branch,
  `additionalProperties` is dropped and an unknown type becomes
  `TYPE_UNSPECIFIED`. A schema carrying both `type` and `anyOf` is refused before
  the request (`type and anyOf cannot be both populated.`), `allOf`/`oneOf`
  members travel untouched, and a `responseSchema` with `$schema` is sent as
  `responseJsonSchema` instead — a schema built by a JSON-schema generator
  belongs in `responseJsonSchema` either way.
- **`config: {}` sends `generationConfig: {}`.** A call that passes an empty
  config object emits the key; a call with no config omits it.
- **Google streams.** The SSE reader parses each `data:` frame on its own and
  refuses a leftover tail at EOF (`Incomplete JSON segment at the end`), so a
  bare JSON body fails as it did through the vendor client.
- **`client.transport`** is the connector. For Anthropic,
  `messages.stream(body, { signal, headers })` returns a plain `AsyncIterable`
  of the same events — the vendor client's `.on('error')`, `.done()` and
  `.finalMessage()` helpers are not part of it. `models.list()` keeps the page
  surface: awaiting gives one page (`data`, `has_more`, `hasNextPage()`,
  `getNextPage()`), and iterating the promise auto-paginates. For Google,
  `models.generateContentStream`, `models.list()` and `models.embedContent`
  keep their names and arguments.
- **Anthropic errors** are unchanged: a non-2xx answer raises the same
  `message`, `status`, `type`, `requestID`, `error`, `errorCode` and `details`;
  a caller abort is `Request was aborted.`; a stream that never started is
  `request ended without sending any chunks`; a malformed frame is a plain
  `Error`.
- **Retries.** No connector retries. The session's retry policy still owns
  backoff, and a `retry-after` hint is read exactly as before.

### Re-recording the oracles

The committed fixtures and `manifest.json` (`sdkVersion`) are the oracle of
record; replay never needs the packages. To record again:

```sh
pnpm add -D @anthropic-ai/sdk@1.5.0
AAI_ORACLE_RECORD=1 node --test test/aai-oracle-record.test.mjs
pnpm remove @anthropic-ai/sdk

pnpm add -D @google/genai@2.32.0
GAI_ORACLE_RECORD=1 node --test test/gai-oracle-record.test.mjs
pnpm remove @google/genai
```

Review the fixture diff before committing it.

## 0.21.1 — Provider base URLs are honoured

Two endpoint paths that used to be ignored now work. One input that used to be
accepted silently is now rejected, so a caller that passed an invalid
`baseURL` must fix it. `null` stays "unset".

- **`baseURL` passed to `initializeClient` is no longer dropped for
  `anthropic`.** `initializeClient({ provider: 'anthropic', options: { apiKey,
  baseURL } })` now reaches the URL you gave it. Before, the URL was silently
  discarded and `client.transport.baseURL` stayed `https://api.anthropic.com`,
  so a proxy endpoint was unreachable through the option.
- **`OPENAI_BASE_URL` and the other URL env keys are honoured.**
  `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENROUTER_URL`, `LM_STUDIO_URL`
  and `OPENCODE_URL` apply to `initializeClient`, `loadCredentials` and direct
  client construction. For `opencode`, `OPENCODE_TIER=zen` selects the zen
  default. `loadCredentials` returns a `baseURL` key for a provider whose
  descriptor has a URL key: the trimmed env value, or `undefined` when the env
  var is unset or blank (`opencode` falls back to its tier URL instead). A
  blank `OPENAI_BASE_URL=` therefore never reaches a backend as an empty
  string.
- **An explicit `baseURL` must be a non-empty string.** `baseURL: ''`,
  `baseURL: '   '` and a non-string value such as `baseURL: 42` now throw
  `ConfigurationError` instead of being ignored or failing later with a raw
  `TypeError`. The value is trimmed. `null` means "unset", not an empty value.
  A blank env value is ignored on every path, including through
  `loadCredentials`.
- **Precedence** is `options.baseURL` → the provider's URL env key → the
  descriptor (or opencode-tier) default → the vendor SDK default. On
  `anthropic`, `anthropicOptions.baseURL` (the vendor SDK's own option bag)
  wins when an `AaiClient` is constructed directly; `initializeClient` does not
  forward that bag.
- **Hosts:** a stray URL env key exported into the environment for another tool
  now routes that provider to it. Unset it, or pass the endpoint explicitly, if
  that is not what you want.

Known residuals after this release: a stream iterable that is created and never
consumed keeps one `abort` listener on the caller signal until the process ends;
and the body read for an `application/json` answer to a `stream: true` request
sits outside the first-headers deadline and outside any byte cap (the time and
the size are both unbounded). Only the short HTML error prefix is byte-capped.

### Behaviour changes

Host-visible:

- **Retry set.** 408, 409, 429 and every status >= 500 (501 included) are
  retried; other 4xx are not. `x-should-retry: true|false` is obeyed before the
  status check, in both directions.
- **Retry timing.** A `retry-after`, `retry-after-ms` or vendor reset hint is
  used only inside `(0, 60 s]` (`LIMITS.retry_after_max_ms`). A hint that is
  <= 0, non-finite or above 60 s is ignored and exponential backoff applies; it
  is no longer clamped to 60 s. Vendor reset headers accept compound durations
  such as `6m0s`, but the parsed value still goes through that same window, so
  `6m0s` falls back to exponential backoff under the default limit.
- **Own deadline.** A request that misses the first-headers deadline now carries
  `code: 'HEADER_TIMEOUT'` and is retryable. A caller abort stays non-retryable.
- **`null` header deletes.** A `defaultHeaders` or per-call header with a
  `null` / `undefined` value deletes that header instead of sending
  `"null"` / `"undefined"`.
- **Non-JSON responses throw.** A 2xx body typed as a non-JSON media type no
  longer becomes an empty success: a non-streaming call throws `BackendError`
  with status 400 and a stream whose body is HTML throws
  `code: 'NON_JSON_STREAM'`. A JSON-typed body that does not parse keeps the
  raw `SyntaxError`. A `/models` body that is a string, number or array throws
  `code: 'NON_OBJECT_MODELS_BODY'`; a JSON `null` keeps the recorded
  `TypeError`.
- **Stream media types.** A `stream: true` request accepts `text/event-stream`
  (with parameters), `text/plain`, `*/*` and a missing content type as SSE. An
  `application/json` answer is consumed as one complete response.
- **Streams are single-use.** A second iteration throws
  `Cannot iterate over a consumed stream.`; read a stream once.
- **`truncated` at EOF.** A stream that delivered output but ended without a
  finish reason or `[DONE]` now emits one `truncated` on the adapter stream, in
  chat and Responses. The session exposes it as `state.truncated`; it is not
  re-emitted as a step event. A host that treats a clean end as success must
  read that field.
- **`_request_id` is preserved.** It survives the `output_text`, embedding and
  `/models` transforms.
- **Chat reasoning parameters.** `reasoningSummary` is dropped with a warning
  on the chat-completions branch; `verbosity` is kept for the other `oai`
  providers and dropped with a warning for `openrouter`.
- **Responses fields and images.** `stop` and `seed` are dropped for `openai`
  (`stop` is kept and `seed` dropped for `openrouter`); a user image part is
  sent as `input_image` with a string `image_url` and `detail: 'auto'`.
- **Reasoning deltas.** `response.reasoning_text.delta` and OpenRouter's
  `reasoning_details[].text` now produce thought output.
- **Anthropic stop reasons.** `pause_turn` emits one `error` with
  `error_type: 'pause_turn'`; `model_context_window_exceeded` emits one
  `truncated`.
- **`thinkingLevel` casing.** It is sent uppercase on the Gemini wire; the
  unified parameter value is unchanged.
- **Gemini `excludeDomains`.** On `google_genai`, `webSearch.blockedDomains` is
  dropped with a `parameter_warning` (Vertex keeps it). A host that relied on
  Gemini-tier domain filtering must filter elsewhere.
- **Query-bearing `baseURL`.** A base URL such as
  `https://gw/openai?api-version=1` keeps its query after the joined path; a
  non-absolute base URL throws `ConfigurationError`.

Internal (no host action):

- Error bodies are capped by `LIMITS.max_error_body_bytes`, SSE lines and events
  by `LIMITS.sse_max_line_bytes`, and the SSE scanner is linear.
- The transport uses one `{ once: true }` abort listener instead of
  `AbortSignal.any`, removes it on every path, and throws on a pre-aborted
  signal before `fetch` and before arming the timer.
- Abort errors carry `name: 'AbortError'`; the signal reason stays `cause`.

## 0.21.0 — The OAI transport is a fetch connector

The `oai` wire standard (`openai`, `openrouter`, `opencode`, `local`) no longer
uses the `openai` Node.js package. It runs on the SDK's built-in native `fetch`
connector (`lib/backends/transport/`). Request and response bodies are
unchanged, pinned by the recorded parity fixtures in
`test/fixtures/oai-parity/`; only headers differ (this SDK's `User-Agent`, no
`X-Stainless-*`, no `OpenAI-Organization` / `OpenAI-Project`). The differential
suite compares the connector against those fixtures.

### Rename

| Before | After (0.21.0) |
| --- | --- |
| `openaiOptions` | `transportOptions` |

`transportOptions` accepts four keys: `fetch` (a fetch implementation),
`defaultHeaders`, `timeout` (the first-headers deadline in ms) and
`maxRetries`. A positive `maxRetries` throws `ConfigurationError` — Merci owns
retries and the connector never retries. An unknown key throws
`ConfigurationError`.

### Behaviour notes

- **Headers.** Requests carry `User-Agent: merci-sdk/<version>`. The OpenAI
  SDK's `User-Agent` and `X-Stainless-*` headers are gone, and
  `OpenAI-Organization` / `OpenAI-Project` are not sent. A gateway that routed
  or logged on those headers sees this SDK's user agent instead.
- **Deadline.** The first-headers deadline stays 600 s by default.
  `transportOptions.timeout` overrides it; `0` or a negative value uses the
  default, a non-finite value is a `ConfigurationError`.
- **`client.transport`.** It is the fetch connector, not the vendor SDK object.
  It exposes the same four namespaces: `chat.completions.create`,
  `responses.create`, `embeddings.create` and `models.list`.
- **No vendor SDK.** The four OAI providers need no vendor SDK installed.
  `aai` and `gai` still expose their vendor SDK object on `client.transport`.

### What stays compatible

- Wire request and response bodies for chat completions, Responses, embeddings
  and model lists.
- Streaming and error semantics: SSE chunk normalisation, the `finish_reason`
  default, aggregated `output_text` and base64 embedding decoding.
- The error fields the recorded oracle pins: `status`, `message`, `code`, `type`
  and `headers`. No oracle case carries a non-null `param`; that value is
  covered by unit tests.
- `client.transport` method names. The call shape is unchanged — a positional
  `create(body, opts)` / `list(opts)` — but two return surfaces are narrower:
  streaming returns a plain `AsyncIterable` (no `.controller` / `.tee()`), and
  `models.list()` returns a plain object (no `.withResponse()` or page helpers)
  whose `data` is always an array, even for an object body without one.
- Provider ids (`openai`, `openrouter`, `opencode`, `local`) and their base
  URLs.

The recorded parity fixtures are the compatibility oracle: a change to the
connector must keep `test/oai-fetch-parity.test.mjs` at zero diffs.

### Re-recording the oracle

The committed fixtures and `manifest.json` (`sdkVersion`) are the oracle of
record; replay never needs the `openai` package. To record again:

```sh
pnpm add -D openai@7.51.0
OAI_ORACLE_RECORD=1 node --test test/oai-oracle-record.test.mjs
pnpm remove openai
```

Review the fixture diff before committing it.

## 0.20.0 — Standards, providers, and the provider vocabulary

Two axes replace the one `BackendType` enum:

- **Standard** — the wire contract: `oai`, `aai`, `gai`. It decides the
  request/response shape, the protocol set and the prompt-cache slot.
- **Provider** — the endpoint, the credentials and the model catalogue:
  `openai`, `openrouter`, `opencode`, `local`, `anthropic`, `google_genai`,
  `vertex`. Two providers on one standard differ in tier and
  capability, not in wire shape.

| Standard | `openai` | `openrouter` | `opencode` | `local` | `anthropic` | `google_genai` | `vertex` |
|---|---|---|---|---|---|---|---|
| `oai` — chat completions / Responses | ● | ● | ● | ● | | | |
| `aai` — Messages | | | | | ● | | |
| `gai` — `generateContent` | | | | | | ● | ● |

`PROVIDERS` holds one descriptor per provider (standard, protocols, base URL
and its env key, credential env keys, model-tier env keys, capability flags);
`STANDARDS` holds the protocol superset and the prompt-cache flag per standard.
`initializeClient` picks the client module from the standard, so a provider is
data, not a branch.

### What to rename

| Before (0.12.0 and earlier) | After (0.20.0) |
| --- | --- |
| `BackendType` | `ProviderType` (the eight providers) plus `StandardType` (`oai`, `aai`, `gai`, `jai`) |
| `resolveBackend({ backend })` | `resolveProvider()` — no `DEFAULT` sentinel; reads `PROVIDER` |
| `initializeClient({ backend })` | `initializeClient({ provider })` |
| `loadCredentials`, `getDefaultModel`, `getToolModel`, `getAvailableModels`, `protocolsFor`, `resolveProtocol`, `getEmbeddingModel` with `{ backend }` | the same calls with `{ provider }` |
| `session.backend` | `session.provider` (and `session.standard`) |
| `agent.backend` | `agent.provider` |
| event payload `backend` | `provider` (and `standard` where the standard is reported) |
| `client.openai` / `client.genai` / `client.anthropic` | `client.transport` |
| `NATIVE_BACKENDS` | `NATIVE_PROVIDERS` |
| `PDF_MEDIA_BACKENDS` | `PDF_MEDIA_PROVIDERS` |
| `isGaiBackend({ backend })` | `isStandard({ provider, standard: StandardType.GAI })` |
| `BACKEND=` in `secret.env` | `PROVIDER=` |
| `renderTransfer({ targetBackend })` | `renderTransfer({ targetProvider })` |
| `task:fork_degraded` payload `parentBackend` / `childBackend` | `parentProvider` / `childProvider` |
| `BackendError.backend` | `BackendError.provider` (the class keeps its name) |

`initializeClient` returns the resolved `provider` beside the client, and
`client.session(model)` inherits it. A session's `.standard` is derived from the
provider, so a caller that needs the wire family reads it instead of comparing
provider ids.

Native message rows persisted by 0.19 or earlier are still read: their sidecar
keeps the legacy `backend` key as a fallback. One transcript does not replay
across the rename — an OpenRouter Responses row stamped `openai` (the old
mislabel) is no longer treated as the same provider, so its encrypted reasoning
items are dropped rather than replayed into an OpenRouter session.

### What you must change

- Replace the `BackendType` import and every `BackendType.X` with
  `ProviderType.X`. There is no `DEFAULT`: `resolveProvider()` takes its value
  from `PROVIDER`, or from the `provider` argument.
- Rename `backend` to `provider` in your options, profile/agent fields, and
  event-payload readers. A payload that carried `backend` now carries
  `provider`, and usually `standard` beside it.
- Rename `BACKEND=` to `PROVIDER=` in `secret.env`. A file that still says
  `BACKEND=` now fails with `No provider selected`; other env key names are
  unchanged.
- Replace `client.openai`, `client.genai` and `client.anthropic` with
  `client.transport` when you reach for the vendor SDK object.
- Replace `isGaiBackend` with `isStandard`; replace the two capability-set
  names with `NATIVE_PROVIDERS` and `PDF_MEDIA_PROVIDERS`.

### What stays compatible

- Provider id strings (`openai`, `openrouter`, `opencode`, `local`,
  `anthropic`, `google_genai`, `vertex`) and protocol strings
  (`completions`, `responses`, `messages`, `generateContent`, `chat`, `task`).
- Env key names other than `BACKEND`: `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `JAI_TOKEN`,
  `VERTEX_CREDENTIALS`, the `LM_STUDIO_URL` / `OPENROUTER_URL` / `OPENCODE_URL`
  overrides and the `DEFAULT_*_MODEL` tiers.
- Event names, including `task:fork_degraded`.
- `client.session(model)` and the fluent session API.
- A native row sidecar persisted before the rename: the reader accepts its
  legacy `backend` key, and new writes use `provider`.

## 20. Unreleased — shell pipelines and progressive-disclosure skills

**Shell tool: `pipeline`.** `execute_shell_command` accepts `command` + `args`
or a `pipeline` of stages:

```json
{ "pipeline": [
  { "command": "rg", "args": ["-l", "-F", "capToolOutput", "lib"] },
  { "command": "head", "args": ["-n", "20"] }
] }
```

No shell is involved: each stage is an argv array, the stages are connected
through stdout, and the exit code is the last stage's. Every stage passes the
same blocklist, read-only tier, option policy, and root confinement before
anything spawns; the chain asks for approval once and the prompt names every
stage. Up to five stages. A call with both `command` and `pipeline`, or with
top-level `args` beside a pipeline, is refused.

**Shell policy: `describe_shell_policy`.** `createShellPolicyTool({ options })`
builds a read-only tool that returns the instance's effective tier as JSON:
`safeCommands`, `blockedCommands`, `roots`, `timeoutMs`, `maxOutputLength`,
`maxPipelineStages`.

**Skills: the catalog is name + description only.** `SkillsLibrary.load()` no
longer inlines SKILL.md bodies. `maxCatalogChars` (default 4000) is a hard
ceiling; over budget, whole entries are dropped and the omission is stated. The
catalog tool takes `{ "name": "<skill>" }` to return one skill's instructions,
so a plain `SkillsLibrary` entry stays readable. A preloading session now
injects the catalog, not the bodies: add a read step if you relied on
`withSkills({ options: { preload: true } })` to show instructions.

**Skills: reading no longer runs code.** A skill that ships `scripts/` returns
its instructions plus the runnable names when the call has no `script`
argument; only `{ "script": "<name>" }` executes one. `requiresApproval` is now
a per-call predicate, so the instruction read is not gated and a script run is.
The tool schema lists the script names in an `enum`.

**`session.getLastRun()`.** The last completed run in one object: the
deliverable, the message rows, and the usage, citations, and sources from
`RUN_END`. Empty before a run and after a failed one; `run()` still returns the
string.

**`TIMEOUT_CODES` is exported.** The single timeout vocabulary
(`HEADER_TIMEOUT`, `BODY_TIMEOUT`, `STEP_TIMEOUT`, `STREAM_TIMEOUT`,
`ETIMEDOUT`, `TIMEOUT`, `timeout`) is now on the main entry, so a host classifier
and `hasTimeoutCode` share one set.

**`validateStrict` still inserts schema defaults.** "Strict" means it never
repairs malformed input; the parser runs with `useDefaults: true`, so read
`result.data`, not the input object, and use `validateValue` when a check must
not rewrite the value it checks.

**Scheduler: `cancelItem({ identifier })`.** Ends one running, retrying, or
parked item without `stop()`. A running or queued attempt is aborted and parked
under reason `canceled`; the claim is kept, so an active tracker item is not
redispatched on the next scan. `resetItem({ identifier })` un-parks it.

**`WorkflowExecutor.resolveApproval` needs a boolean.** The call no longer
defaults `approved` to `true`; a missing or non-boolean value throws a
`ConfigurationError` (`option: 'approved'`) before any gate is touched. Pass
`approved: true` or `approved: false`.

**State-machine string conditions fail closed when child processes are denied.**
A host running under Node's permission model without `--allow-child-process` used
to evaluate conditions in-process with a warning, losing the memory bound. It now
gets a typed `ConfigurationError` naming both remedies. Set
`MERCI_LIMIT_CONDITION_UNISOLATED_VM=1` to keep the old in-process behaviour
explicitly, accepting that a condition can exhaust the host heap.

**A shared-pool turn waits for a sibling, not for a clock.**
`budget_admission_wait_ms` defaults to `0`: a turn that overlaps a sibling waits
for the reservation to free a usable share or for the run to abort, and a positive
value is an optional cap. A nested loop started from a tool must pass the caller's
`runContext` so its ancestor's in-flight reservation is not mistaken for a
competing sibling; the SDK's task path always does.

**Not shipped in this release (tracked deferrals).** Per-item token/USD budget
(`limits.*` are scheduler-wide), a run-level wall-clock deadline
(`withTimeout.totalMs` bounds one step), a durable queue, and
`snapshot().limits` reporting unset global caps as `null`.

## Durability — thread ids on a case-insensitive filesystem (unreleased)

A checkpoint file is still named after the thread id **verbatim**, so a store
written before this change keeps loading: `Thread-A.json` is read by
`load('Thread-A')` again, and `list()` still reports it. What changed is that
the alias is refused on **both** paths. `Thread-A` and `thread-a` are one file
on a case-insensitive volume, so `load('thread-a')` refuses with a
`ConfigurationError` whose `option` is `thread-case-collision` instead of
returning the other thread's checkpoint or `null` (a miss would restart the
thread and replay its effects), and `save('thread-a')` refuses with the same
error instead of overwriting `Thread-A.json` (last-write-wins would destroy the
other thread's checkpoint and leave its owner with a hard error). A file that
already exists and parses is compared; a fresh save writes straight away, and an
unreadable one keeps the overwrite behaviour it had. Two thread ids that differ
only in case therefore cannot share a store: rename one, or give each its own
store directory.

## Where to look next

- `docs/PROVIDERS.md` — which provider, which engine, which protocol.
- `docs/api_reference.html` — the full export surface.
- `docs/capability_matrix.html` — the per-capability provider table.
- `CHANGELOG.md` — the complete change list.
