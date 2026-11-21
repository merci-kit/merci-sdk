# Merci SDK — Examples: 32 live showcases

Thirty-two numbered programs (plus two server children) that take you from a
first streamed turn to an unattended multi-item system. Every one is **live**:
it runs a real model against the provider in `secret.env`, does real work, and
ends with a scoreboard of what it actually observed.

There is no `--offline` mode and no stubbed client here. Deterministic,
backend-free proofs are tests, not demonstrations, and they live under
[`test/examples/`](../test/examples/) — run them with `pnpm test:examples`.

Every example:

- imports **only public entry points** (`merci-sdk` and its published subpaths,
  such as `merci-sdk/tools`, `merci-sdk/planning`, `merci-sdk/workspace`,
  `merci-sdk/scheduler`, `merci-sdk/orchestration`) — never `lib/**` internals;
- selects its provider from `secret.env` via `resolveProvider()`
  (`PROVIDER=openrouter | openai | local | google_genai | vertex | anthropic | opencode`);
- degrades gracefully on closed stdin (a piped/CI run completes instead of hanging);
- writes a full run log under `examples/.logs/<example>/`.

The machine-readable **example → SDK symbol map** lives in
[`SYMBOL-MAP.md`](./SYMBOL-MAP.md) (regenerate with `pnpm build:example-map`).

## The curriculum

### 1. First contact

| # | Example | You learn |
|---|---------|-----------|
| 01 | [`01_quickstart.mjs`](./01_quickstart.mjs) | initialize a client, discover models, stream one turn, read usage |
| 02 | [`02_conversation.mjs`](./02_conversation.mjs) | one carried history, request parameters, the vendor knobs, prompt caching, a stdin-safe REPL |
| 03 | [`03_structured_output.mjs`](./03_structured_output.mjs) | JSON Schema and Zod output with bounded corrections |
| 04 | [`04_judgment.mjs`](./04_judgment.mjs) | discriminative models: `noul`/`choice`/`score`, the typed read, role clients, one decision gate |

### 2. Tools and control

| # | Example | You learn |
|---|---------|-----------|
| 05 | [`05_tool_calling.mjs`](./05_tool_calling.mjs) | autonomous, parallel and manual tool calls, output schemas, the object cap |
| 06 | [`06_approvals_and_safety.mjs`](./06_approvals_and_safety.mjs) | guardrails, permission rules, approval modes, per-tool timeout, money budget |
| 07 | [`07_agent_loop.mjs`](./07_agent_loop.mjs) | the agentic loop, staged follow-ups, streamed input, in-flight steering, a leased durable inbox (`drainInbox`), abort, budgets, limits |
| 08 | [`08_resilience.mjs`](./08_resilience.mjs) | retries, fan-out limits, the circuit breaker, stream timeouts |

### 3. Context, memory, knowledge

| # | Example | You learn |
|---|---------|-----------|
| 09 | [`09_memory_and_todos.mjs`](./09_memory_and_todos.mjs) | a persistent memory bank with embeddings, lazy vs preloaded recall, durable todos |
| 10 | [`10_multimodal.mjs`](./10_multimodal.mjs) | vision and document ingestion into structured output |
| 11 | [`11_web_tools.mjs`](./11_web_tools.mjs) | web search, scrape, and the headless browser |
| 12 | [`12_knowledge_graph.mjs`](./12_knowledge_graph.mjs) | the typed graph: mechanical pass, model enrichment, negative/conditional/evidenced edges, the decision gate, a budgeted answer |
| 13 | [`13_knowledge_corpus.mjs`](./13_knowledge_corpus.mjs) | one corpus → surfaces → wiki projection → adopted ontology → a cache that survives an edit |

### 4. Agent patterns

| # | Example | You learn |
|---|---------|-----------|
| 14 | [`14_coding_agent.mjs`](./14_coding_agent.mjs) | a workspace-scoped coding agent: context tools, the shell gate, YAML skills |
| 15 | [`15_delegation.mjs`](./15_delegation.mjs) | the `task` tool, the spawn roster and registry, one context-transfer policy for every hand-off |
| 16 | [`16_plan_and_execute.mjs`](./16_plan_and_execute.mjs) | plan → approve → execute with a durable handoff |
| 17 | [`17_dag_workflow.mjs`](./17_dag_workflow.mjs) | DAG plan → execute → evaluate, a replan, a nested child DAG |
| 18 | [`18_state_machine.mjs`](./18_state_machine.mjs) | a node graph with a completion contract |
| 19 | [`19_discussion.mjs`](./19_discussion.mjs) | a decision group: task DAG → debate → judge → conclude |

### 5. Durability and operations

| # | Example | You learn |
|---|---------|-----------|
| 20 | [`20_durability.mjs`](./20_durability.mjs) | session checkpoints, the at-most-once execution journal, the session fork |
| 21 | [`21_observability.mjs`](./21_observability.mjs) | correlation (`runId`/`parentRunId`), hooks, phases, custom observers, typed errors, abort |
| 22 | [`22_telemetry.mjs`](./22_telemetry.mjs) | the OTLP envelope, the gen_ai span tree, redaction, batching |
| 23 | [`23_evals.mjs`](./23_evals.mjs) | a scored suite, a recorded cassette, an LLM judge, the failure taxonomy |

### 6. Interop

| # | Example | You learn |
|---|---------|-----------|
| 24 | [`24_mcp_client.mjs`](./24_mcp_client.mjs) + [`24_mcp_server.mjs`](./24_mcp_server.mjs) | an MCP stdio server's tools, sampling/elicitation/roots, resources and prompts |
| 25 | [`25_mcp_server_http.mjs`](./25_mcp_server_http.mjs) | your SDK as an MCP server over Streamable HTTP, capabilities, artifacts, loadable components |
| 26 | [`26_a2a.mjs`](./26_a2a.mjs) + [`26_a2a_server.mjs`](./26_a2a_server.mjs) | discover an A2A peer, delegate to it, drive its task lifecycle |
| 27 | [`27_acp_agent.mjs`](./27_acp_agent.mjs) | the ACP v1 agent: session lifecycle, updates, the fail-closed permission model |

### 7. The coordination layer

| # | Example | You learn |
|---|---------|-----------|
| 28 | [`28_workspace_isolation.mjs`](./28_workspace_isolation.mjs) | one directory or git worktree per item, hooks, path confinement, `withWorkspace`, a todo store as a work source |
| 29 | [`29_workflow_contract.mjs`](./29_workflow_contract.mjs) | a repo-owned `WORKFLOW.md`: strict parsing, the template subset, last-known-good reload |
| 30 | [`30_scheduler.mjs`](./30_scheduler.mjs) | work sources, normalization, claims, the single-flight tick, retry/park, the durable attempt store, four engines |
| 31 | [`31_orchestration.mjs`](./31_orchestration.mjs) | one `createOrchestration` call binding policy, scheduler, workspace and operator; the spend ledger |
| 32 | [`32_agent_files.mjs`](./32_agent_files.mjs) | `*.agent.yaml` definitions: load, freeze, resolve the toolset, run live, delegate live |

## Run

```bash
# any showcase by path
node examples/01_quickstart.mjs
node examples/31_orchestration.mjs

# the deterministic audits (tests, no provider needed)
pnpm test:examples            # == node scripts/run-examples.mjs
node scripts/run-examples.mjs --list
```

Copy `secret.env.example` to `secret.env` at the repo root and fill in one provider:

```ini
PROVIDER=google_genai
GEMINI_API_KEY=...            # whichever provider you pick
# openrouter | openai | local | google_genai | vertex | anthropic | opencode
# three standards (oai, aai, gai) over these seven providers
```

Interactive examples (02, 14, 16) prompt on stdin but **fall back cleanly when
stdin is closed** — CI and piped runs never hang.
`examples/fixtures/skills/` powers 14; `examples/fixtures/image.png` feeds 10.

## Coverage: the curated must-demonstrate gate

`examples/SYMBOL-MAP.md` is generated from the examples: it maps every public SDK
symbol to the examples that demonstrate it — the imported names **and** the
builder, session, parameter and object methods the examples call.

[`scripts/example-coverage.config.json`](../scripts/example-coverage.config.json)
names the capabilities that must keep an example — the wave-1/2/3 contracts plus
the coordination layer, one entry each. The gate fails when one of them has none:

```bash
pnpm run check:examples       # == node scripts/check-example-coverage.mjs
```

The evidence comes from the same AST walk the map uses, so a comment that merely
*mentions* a symbol does not count — a call does. That is what makes the gate
worth running: it fails when a feature loses its example, instead of rotting
silently in a README nobody reads.

## Run logs

Every example writes a complete, untruncated log into its own subdir:

```text
examples/.logs/<example>/latest.log     # full stdout+stderr mirror (ANSI-stripped)
examples/.logs/<example>/latest.json    # structured trail: environment, events
examples/.logs/<example>/<timestamp>.{log,json}
```

## Shared plumbing (`examples/_shared/`)

Repo-internal helpers — not part of the public SDK:

- **`example-utils.mjs`** — provider/model resolution (`resolveExample`), client
  wiring (`wireClient`), token tracking (`trackUsage`/`deltaUsage`/`reportUsage`),
  logging flags (`parseLogArgs`), orchestrator event wiring (`wireWorkflowEvents`,
  `wireDiscussionEvents`, `wireStateMachineEvents`, `wireTaskEvents`,
  `judgeArtifact`) and stdin-safe prompts (`readlineSafe`), child-process spawns
  (`spawnChild`, `childLog`), and the `runMain` footer.
- **`real-tools.mjs`** — genuine I/O tools (HTTP probe against a locally spawned
  API server, a source-tree scanner, real file persistence). All writes stay under
  `scratchpad/examples/`.

## Logging

Every example is wired for maximal visibility with no extra code:

- **LLM I/O** — `wireClient` logs each vendor call as a `log.wire` brief
  (`→ POST … msgs=N params=…`); full request/response bodies appear at
  `--trace` (always redacted — `authorization`/`apiKey`/`token`/… become
  `[REDACTED]`).
- **Every event** — `wireClient` also attaches the registry-driven catch-all
  (`attachEventLogger`), so `run:*`, `session:*`, `tool:*`, `phase:*`,
  `api_error`, … are all logged; a new event is covered the day it is registered.
- **Step stream** — `defaultDisplay` attaches `createStreamLogger`, so `quota`,
  `first_token`, `finish`, `tool_call_delta`, … appear at `-v`.

Controls (parsed by `resolveExample` → `parseLogArgs`):

| Flag / env | Effect |
| --- | --- |
| `-v`, `--verbose`, `--debug` | level `debug` (catch-all + step stream) |
| `--trace` | level `trace` (full redacted bodies, tool I/O) |
| `-q`, `--quiet` | level `warn` (silences the catch-all) |
| `--silent` | level `silent` (warnings/errors only) |
| `--json` | NDJSON records (one JSON object per line) |
| `--no-color` | disable ANSI (also `NO_COLOR=1`) |
| `--log-level=<l>`, `--log-format=<f>` | explicit overrides |
| `LOG_LEVEL`, `LOG_FORMAT` | env equivalents |

Run any example directly to use them: `node examples/07_agent_loop.mjs -v`.

## Conventions

- Single-object (named) arguments throughout; fluent session builder.
- Side effects through events; the logger vocabulary is `log.info({ m })`,
  `log.option({ name, value, source })`, `log.event({ type, payload })`, etc.
- No silent truncation: `log.truncate({ text, n })` marks cuts with `…`, and
  context losses name what was dropped.
