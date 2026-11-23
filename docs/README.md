# Merci SDK v0.23.1

[![View on GitHub](https://img.shields.io/badge/View%20on-GitHub-blue?logo=github)](https://github.com/merci-kit/merci-sdk/)
[![Version](https://img.shields.io/badge/version-0.23.1-blue)](package.json)

**Unified, fluent, multi-provider and multi-standard agentic SDK for Node.js. Minimal dependencies. Streaming, function calling, persistent memory, DAG workflows, and multi-agent swarms.**

Merci SDK covers three API standards (`oai`, `aai`, `gai`) over seven providers: **OpenAI**, **Anthropic Claude**, **Google Gemini**, **Google Vertex AI**, **OpenRouter**, **OpenCode**, and **Local Stack**.

---

## ✨ Key Architectural Features

- **4×8 Provider Matrix**: Four wire standards over eight providers, with one unified `client.session(model)` interface and zero provider quirks leaking into application code.
- **Stateless Resend Chat**: Message history lives in your application array. Every step returns an immutable row (`finalState.messages`) — no server-side vendor lock-in.
- **Model Tiering Rule**: Orchestrators and judges run on `getDefaultModel({ provider })`; cheap subagents run on `getToolModel({ provider })`.
- **Minimal Dependencies**: Pure ES Modules with no orchestration framework underneath. Every capability — agent loop, DAG engine, state machine, memory, events, retry — is first-party; runtime packages are limited to the official protocol SDKs and validators, with the optional browser engine lazily imported. The `oai`, `aai` and `gai` standards run on a built-in native `fetch` connector, so the OAI providers, Anthropic and Google need no vendor SDK.
- **Model Context Protocol (MCP)**: Built-in `McpClient` and `loadMcpTools` for external tool servers, and `createMcpHttpHandler` to serve tools, resources and prompts over Streamable HTTP.
- **Agent-to-Agent (A2A)**: Distributed agent delegation over the **A2A v1.0.0** JSON-RPC binding (`SendMessage`, `GetTask`, `CancelTask`, task states, artifacts) with discoverable agent cards and SSRF origin pinning. `createA2AServer` exposes a Merci agent as an A2A peer.
- **Agent Client Protocol (ACP)**: `createAcpAgent` exposes a session as an ACP v1 agent — the full session lifecycle (`initialize`, `session/new|load|list|delete|fork|prompt|cancel`) with message, thought, tool-call and plan session updates.
- **3-Layer Shell Security Gate**: Strict isolation into Safe, Blocked, and Human-in-the-Loop (HITL) gated commands with secret redaction.
- **Persistent Episodic Memory**: Composite & local file memory providers with non-blocking background distillation and untrusted-fact escaping.
- **Knowledge Graph (ASG) + Wiki**: `withKnowledge()` attaches one typed graph — 25 core relations plus a namespaced `x-<label>` escape that must carry a note — with a validator, a bounded traversal that damps hubs, a budgeted prompt block, and a generated wiki whose index carries the graph hash. Read-only adapters ingest documents, an existing markdown corpus, memory facts, todos and plan steps when given a `seed`; the wiki is a projection of the graph, never a second store. `syncCorpus()` persists a build with a source manifest, reuses it untouched when the corpus has not changed, and after an edit re-anchors the agent's nodes by content key.
- **Orchestration Suites**: DAG workflows with evaluator-driven replan, hierarchical sub-DAGs, StateMachines, and Multi-Agent Discussion swarms.
- **Context Management**: Global objective threading, deterministic `foldContext`, and one opt-in `transfer` policy (text or real rows, windowed, compacted) shared by all four orchestration engines.
- **Enterprise Resilience**: RetryPolicy with abort-aware jittered backoff, sliding-window stream timeouts, and credential scrubbing.
- **Cost Accounting in USD**: The SDK never estimates a price. The money budget follows the amount **the provider reports** with its usage (`usage.cost` on an OpenAI-compatible gateway) and `withBudget({ budget: { maxBudgetUsd } })` stops a run that overspends; a cost the provider did not report stays *unknown*, never zero. The token budget (`maxTotalTokens`) is the budget mechanism.
- **Guardrails & Permissions**: `withGuardrails({ rules })` is the tripwire on what enters and leaves the model; `withPermissions({ allow, deny, mode })` decides which tools the model may call and when a gated tool may skip the approval gate.
- **Record / Replay**: `createCassette({ path })` + `session.withCassette({ cassette, mode: 'record' | 'replay' })` records a run's vendor calls once and replays them offline — deterministic evals and tests, no API key.
- **OpenTelemetry Export**: `createOtlpExporter()` ships a run to an OTLP/HTTP endpoint as a gen_ai span tree (`invoke_agent` › `chat {model}` / `execute_tool {name}`, with token usage; other events are span events), and `CompositeApiObserver` runs it next to the default observer.
- **Prompt Caching & Vendor Keys**: `cachePoints` (Anthropic cache breakpoints), `promptCacheKey` (OpenAI), `serviceTier`, `logprobs`, `previousResponseId` and `store` are one unified builder across the four standards.
- **Bounded Tool Rounds**: A per-tool `timeoutMs` keeps one hanging tool from stalling the turn, a tool may declare an `outputSchema` its result must satisfy, and oversized results — strings *and* objects — are capped.

---

## 🚀 Quick Start

### 1. Installation

```bash
pnpm add merci-sdk
# or: npm install merci-sdk
```

### 2. Configure Credentials

Create `secret.env` in your project root:

```ini
PROVIDER=openai
OPENAI_API_KEY=sk-...

# Optional other providers:
GEMINI_API_KEY=AIzaSy...
ANTHROPIC_API_KEY=sk-ant-...
JAI_TOKEN=your-jwt-token
```

The file is resolved once per process: `MERCI_ENV_FILE` when set, otherwise
`secret.env` in the directory you start the process from, otherwise the one
next to the package's own checkout (the repo's dev run). Keep it out of git.
A refreshed `JAI_TOKEN` is written back only to `MERCI_ENV_FILE` or the
package's own file — never to a project `secret.env` the SDK merely found.

### 3. Stream a Completion

```javascript
import {
    createUserMessage,
    resolveProvider,
    initializeClient,
    loadCredentials,
    getDefaultModel
} from 'merci-sdk';

const provider = resolveProvider();          // PROVIDER from secret.env
const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });

const session = client.session(getDefaultModel({ provider }))
    .withSystemMessage('You are a helpful software architect.');

const stream = session.step({ messages: [
    createUserMessage({ provider, content: 'Explain the benefits of stateless resend agent architecture.' })
] });

for await (const event of stream) {
    if (event.type === 'text') process.stdout.write(event.content);
}
```

The resolved `provider` is on the client and the session, the wire standard is
`session.standard`, and the transport seam is `client.transport` (the built-in
`fetch` connector for the `oai` standard).

---

## 📚 Complete 32 Examples (+ 2 server children, + 29 lesson guides)

A **progressive set of 32 live showcases** that mirrors
[`examples/README.md`](../examples/README.md): first contact → tools and control →
context and knowledge → agent patterns → durability and operations → interop →
the coordination layer. Every one runs a real model against the provider in
`secret.env`; there is no `--offline` mode in `examples/`. The deterministic,
backend-free proofs are tests and live under `test/examples/`.

| # | Example File | Scenario |
|---|--------------|----------|
| **01** | `examples/01_quickstart.mjs` | Init, discover models, stream one turn, system message, usage |
| **02** | `examples/02_conversation.mjs` | One carried history, parameters, vendor knobs, prompt caching, stdin-safe REPL |
| **03** | `examples/03_structured_output.mjs` | Structured output: JSON Schema, Zod, bounded corrections |
| **04** | `examples/04_judgment.mjs` | System One: `noul`/`choice`/`score`, the typed read, role clients, one decision gate |
| **05** | `examples/05_tool_calling.mjs` | Tool calling: autonomous, parallel, manual, output schemas, the object cap |
| **06** | `examples/06_approvals_and_safety.mjs` | Guardrails, permission rules, approval modes, per-tool timeout, money budget |
| **07** | `examples/07_agent_loop.mjs` | The agentic loop: staged follow-ups, streamed input, abort, budgets, limits |
| **08** | `examples/08_resilience.mjs` | Retries, fan-out limits, circuit breaker, stream timeouts |
| **09** | `examples/09_memory_and_todos.mjs` | Persistent state: a memory bank with embeddings + a todo list |
| **10** | `examples/10_multimodal.mjs` | Vision + document ingestion → structured output |
| **11** | `examples/11_web_tools.mjs` | Web search, scrape, and the headless browser |
| **12** | `examples/12_knowledge_graph.mjs` | The typed graph: mechanical pass, model enrichment, edge shapes, the decision gate, a budgeted answer |
| **13** | `examples/13_knowledge_corpus.mjs` | Corpus → surfaces → wiki projection → adopted ontology → a cache that survives an edit |
| **14** | `examples/14_coding_agent.mjs` | A workspace-scoped coding agent (context tools + shell gate + YAML skills) |
| **15** | `examples/15_delegation.mjs` | The `task` tool, the spawn roster and registry, one context-transfer policy |
| **16** | `examples/16_plan_and_execute.mjs` | Plan → approve → execute with a durable handoff |
| **17** | `examples/17_dag_workflow.mjs` | DAG workflow: plan → execute → evaluate → replan → nested child DAG |
| **18** | `examples/18_state_machine.mjs` | State machine: a node verify gate + a contract completion gate |
| **19** | `examples/19_discussion.mjs` | A decision group: task DAG → debate → judge → conclude |
| **20** | `examples/20_durability.mjs` | Checkpoints, the at-most-once execution journal, the session fork |
| **21** | `examples/21_observability.mjs` | Correlation (`runId`/`parentRunId`), hooks, phases, custom observer, typed errors, abort |
| **22** | `examples/22_telemetry.mjs` | OpenTelemetry export: the OTLP envelope, the gen_ai span tree, redaction, batching |
| **23** | `examples/23_evals.mjs` | Evals: a scored suite, a recorded cassette, an LLM judge, the failure taxonomy |
| **24** | `examples/24_mcp_client.mjs` | An MCP stdio server's tools inside a live session: client capabilities, resources, prompts (+ `24_mcp_server.mjs`) |
| **25** | `examples/25_mcp_server_http.mjs` | Your SDK as an MCP server over Streamable HTTP: capabilities, artifacts, loadable components |
| **26** | `examples/26_a2a.mjs` | Discover an A2A v1.0 peer, delegate to it, drive its task lifecycle (+ `26_a2a_server.mjs`) |
| **27** | `examples/27_acp_agent.mjs` | The ACP v1 agent: the session lifecycle, a turn as session updates, the fail-closed permission model |
| **28** | `examples/28_workspace_isolation.mjs` | One worktree per item, path confinement, `withWorkspace`, a todo store as a scheduler source |
| **29** | `examples/29_workflow_contract.mjs` | `WORKFLOW.md`: strict parsing, the template subset, the scheduler/workspace mapping, last-known-good reload |
| **30** | `examples/30_scheduler.mjs` | Work sources, claims, the single-flight tick, retry/park, the durable attempt store, four engines |
| **31** | `examples/31_orchestration.mjs` | `createOrchestration`: policy, scheduler, workspace, operator, and one attempt's spend ledger |
| **32** | `examples/32_agent_files.mjs` | `*.agent.yaml`: load, freeze, resolve the toolset, run live, delegate live |

The **29 lesson guides** (`docs/lessons/lesson_1.html` .. `lesson_29.html`) go
deeper on individual concepts; each references the closest runnable example above.

---

## 🔌 Agent wiring: transport, fork, typed state, context processors

Optional hooks that make the delegation/orchestration layers explicit.

### Per-agent transport
A task profile or discussion agent may name its own `client` or `provider`. A
cross-provider request with no registered transport fails loudly
(`ConfigurationError`) instead of shaping rows for one wire and sending them
over another.

```javascript
import { withTaskAgents, initializeClient } from 'merci-sdk';

const { client: openai } = await initializeClient({ provider: 'openai', options: { apiKey: process.env.OPENAI_API_KEY } });
const { client: anthropic } = await initializeClient({ provider: 'anthropic', options: { apiKey: process.env.ANTHROPIC_API_KEY } });

withTaskAgents({ client: openai, agents: [
  { name: 'review',  model: 'claude-sonnet-4-5', client: anthropic },   // explicit client
  { name: 'extract', model: 'gpt-4.1-mini',      provider: 'openai' },   // resolved via the registry
], options: { clients: { anthropic } } });
```

### Context handoff
`handoff.context` decides what the subagent inherits from the parent conversation:

- `clean` — nothing (the task tool's default; a profile's `inherit: 'history'`
  or `transfer` policy can still add context rows or a digest).
- `moderated` — a compacted digest of the most recent parent rows.
- `fork` — the tail of the parent's real message rows (ids preserved,
  prompt-cache friendly).
- `full` — the whole parent conversation, replayed as real rows.

On a **different provider** `fork` and `full` cannot replay a foreign wire
verbatim: their units render through the ledger renderer as visible digest rows
and the run emits a `task:fork_degraded` event — never a silent empty handoff.

A checkpoint (`save`/`load`) restores the conversation and the AgentContext — its
values **and** its delegation chain (`parent`, …, capped at 32 hops) — not the
permission policy or the tool allowlist: re-apply the session policy when a
restricted session is resumed. A step runs on its own *view* of the run context:
`refs` and `metadata` are deep copies, so a step that mutates them cannot reach a
sibling; the objective is shared — a restatement is adopted back into the run
context, so the steps after it see the new version (an older view cannot roll it
back; the version is the contract). One limit: steps that share a single session
object (`sessionScope: 'plan'`) also share `session._agentContext`, so a parallel step in that
mode can read the view another step installed.

This is the conversation handoff of the task tool. The DAG engine reads
`handoff.context` for `clean`/`moderated` (its default intake is already the full
step context) and takes rows from `transfer`; the StateMachine reads
`clean`/`full` (it defaults to a capped context view; `full` lifts the cap) and
builds ledger rows from `transfer`. `fork` is task-tool only.

Conversation rows travel **in-process only**. Across an A2A boundary the
`merciEnvelope` carries direction — `objective`, `directive`, `refs` — and the
receiving skill reads it as `ctx.agentContext`; the rows themselves are never
serialized onto the wire.

```javascript
// inside a run, the task tool accepts:
//   handoff: { context: 'fork' }   // or 'full', 'moderated', 'clean'
```

### Context transfer (`transfer`)
Every engine that hands context from one instance to the next — DAG steps,
StateMachine nodes, discussion turns, and delegation — accepts one opt-in
`transfer` policy: the single place that decides *what the next instance sees*.
It is the ledger that is canonical; `stringify` is one renderer over it. The
default is unchanged (`stringify`, byte-identical to prior releases), so
existing runs are unaffected until you opt in.

`transfer` is a preset name or `{ preset, mode, select, compact, tail, summarize, markerLabel }`.

| Preset | `mode` | `select` | `compact` |
|--------|--------|----------|-----------|
| `stringify` *(default)* | stringify — rendered text | all | no |
| `ledger` | ledger — real message rows | all | no |
| `ledger-selected` | ledger | tail (`tail`, default 8 units) | no |
| `ledger-compact` | ledger | tail (default 8) | yes |
| `ledger-selected-compact` | ledger | tail (`tail`) | yes |

- **`mode: 'ledger'`** replays the upstream instance's *real* message rows —
  role, type and tool-call/tool-result pairing preserved, ids intact (the
  prompt-cache-friendly `fork` contract). A unit shaped for a *different
  provider* than the target cannot be replayed; it degrades to a visible
  `[Output from Step "<id>"]` digest row instead of silently vanishing.
- **`select: 'tail'`** windows the upstream stream to its last `tail` **units**.
  A unit is a whole step/node/turn's message run, so a window never splits a
  tool call from its result. Order is always preserved — `select` is a window,
  not a sort. The window applies in **every** mode: `{mode:'stringify',
  select:'tail', tail:2}` renders only the last two units (before wave 12 it
  rendered all of them and reported `dropped: 0`).
- **`compact: true`** folds the dropped prefix into a summary via `foldContext`
  (pass a `summarize` function — the Discussion engine also accepts `true` or
  `{ model }`); with no summarizer it degrades to a visible loss marker:
  `[Earlier context omitted]: N earlier entries omitted (no summarizer configured).`
  In `stringify` mode the same rule holds: the dropped units are summarised into
  the text when a summarizer is configured, and otherwise a marker line says how
  many were omitted — the text is never silently shortened. A failing summarizer
  degrades to that marker instead of failing the transfer. The DAG's own intake
  block (per-step text appended to a prompt) applies the same window and marker;
  it reuses the ledger's summaries only in `ledger` mode.

Where it is configured:

| Engine | Option |
|--------|--------|
| DAG | `WorkflowExecutor` `options.transfer`, or per-step `step.transfer` |
| StateMachine | machine `options.transfer`, or per-node `node.transfer` |
| Discussion | session `options.transfer`, or per-agent `agent.transfer` |
| Delegation | task-profile `transfer` (`withTaskAgents` agents) |

```javascript
import { WorkflowExecutor } from 'merci-sdk/planning';
import { withTaskAgents } from 'merci-sdk';

// DAG: hand real rows to each step, window to the last 8 units, summarize the rest
new WorkflowExecutor({ options: {/* … */, transfer: { preset: 'ledger-compact', summarize: mySummarizer } } });

// Delegation profile: replay the parent's rows verbatim (fork-style, provider-guarded)
withTaskAgents({ client, agents: [{ name: 'review', model: 'claude-sonnet-4-5', transfer: 'ledger' }] });
```

Notes: `ledger` mode replaces a StateMachine's auto `Current working state:`
view with the real row ledger (an explicit `userPromptTemplate` is left intact);
Discussion stays on its native builder until a `transfer` is set; a delegation
`handoff.context: 'clean'` still wins over `transfer`; and a code agent
(`execute`) always receives the text digest, since it has no message rows.

See `examples/15_delegation.mjs` for a runnable walkthrough of every preset
above — a deterministic core plus a credential-gated live tail.

### Typed step state
`WorkflowExecutor`, `StateMachine`, and `DiscussionSession` accept
`options.stateSchema` (Zod). A violating output feeds the engine's bounded
corrective-retry loop — every DAG step engine (naive, stateMachine, discussion,
nested), each StateMachine node, and each discussion/MAA turn — and surfaces a
typed `VerificationError` only once the retries are exhausted; state is never
silently malformed.
`options.validateTemplateRefs !== false` (default on) fails a plan whose
`{{stepId…}}` / `{{context…}}` references are unknown — including a nested-DAG
`subObjective`.

### Context processors
`withContextProcessor({ name, order, process })` inserts an ordered hook into
`_prepareStepMessages`; `process({ session, messages, contextParts })` returns
`{ contextParts?, messages? }`. Configure it on a session, or pass
`options.contextProcessors` to `WorkflowExecutor` / `StateMachine` /
`DiscussionSession` so their step sessions inherit it.

### Session-local rosters
`sessions.withTaskAgents({ agents, options })` registers profiles on the session
(preferred over the client registry) and cascades to delegated children. The
`task` tool is advertised only while at least one profile is reachable, and its
description lists the session's roster snapshot (`name — description`) so the model picks
only names that exist. The built-in name `task` shadows a caller tool with the
same name once a profile is registered.

### Migration note
A profile/agent that declares a `provider` different from its client and has no
registered transport now throws `ConfigurationError`. Register it via
`withTaskAgents({ options: { clients, resolveClient } })` or pass an explicit
`client`.

---

## 📖 Web Documentation

Visit the interactive web documentation in the `docs/` folder:
- **`docs/index.html`** — Overview, interactive architecture playground, and feature matrix.
- **`docs/demo.html`** — Full-screen interactive demonstration and live telemetry inspector.
- **`docs/getting_started.html`** — Step-by-step setup and architectural fundamentals.
- **`docs/tutorials.html`** — Searchable curriculum catalog of all 42 lessons.
- **`docs/lessons/lesson_1.html` .. `lesson_29.html`** — In-depth architectural lesson guides.
- **`docs/api_reference.html`** — Complete SDK export and method catalog (its export surface is generated from the built declarations).
- **`docs/PROVIDERS.md`** — Which provider and which engine: the decision guide for the four standards and eight providers, the execution engines and the protocol layer.
- **`docs/ORCHESTRATION.md`** — The coordination layer: the one composition root, the five seams it owns, the lifecycle, and what the operator can see. Start here, then read the four contracts below.
- **`docs/LIMITS.md`** — Every bounded number: the registry, the four-level precedence, `merci-limits.json`, `MERCI_LIMIT_*`, the kill switch, safety guards, and the CI gate that stops a new unregistered limit declaration.
- **`docs/WORKSPACES.md`** — Per-item workspace isolation: the two strategies, the lifecycle, the hook trust boundary, artifacts, and the worktree caveats.
- **`docs/SCHEDULER.md`** — The external work-item scheduler: the tick, claims, retries, parking, reconciliation, workspaces, budgets, and live reconfiguration.
- **`docs/WORKFLOW_POLICY.md`** — The repo-owned `WORKFLOW.md` contract: front matter and schema, the strict template subset, reload and last-known-good, live versus construction-bound settings, and the security boundary.
- **`docs/AGENT_FILES.md`** — The `*.agent.yaml` contract: the schema, the group/selector tool model, `createAgentToolbox`, the two consumers, the trust boundary, limits and errors, and the honest limits.
- **`docs/OPERATOR_API.md`** — The operator API: the read-only state and item detail, the one bounded refresh action, the terminal status page, and the honest limits of the event feed.
- **`docs/MIGRATION.md`** — What changed in the public API and what a consumer has to do about it.
- **`CHANGELOG.md`** — The release history.

---

## 📜 License and commercial services

The TypeScript/JavaScript SDK is released under Apache 2.0. © 2026 Lukáš
Michna (Mobeetle).

A **Rust implementation** is available separately under a **commercial
license**. **Support, development and professional services** are available as
**paid engagements**.
