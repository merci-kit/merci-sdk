<!-- GENERATED FILE — do not edit by hand. Run `pnpm build:structure` to regenerate. -->

# Merci SDK v0.23.0 — Library Structure & Symbols

> Structural reference: the `lib/` file tree and the symbols each module exports.
> Generated from the current source by `scripts/build-structure.mjs`.

- **Version:** 0.23.0
- **Files:** 238 `.mjs`
- **Exports:** 1043 declared, 557 re-exported
- **Types:** 553 `@typedef`s

`Kind` is one of `class`, `error class`, `function`, `const`, `default`, `barrel` or a resolved `re-export`. `↩` marks a symbol re-exported from another module.

## 1. Entry points

| Import | Module |
| --- | --- |
| `merci-sdk` | `./lib/index.mjs` |
| `merci-sdk/oai` | `./lib/backends/oai.mjs` |
| `merci-sdk/jai` | `./lib/backends/jai.mjs` |
| `merci-sdk/gai` | `./lib/backends/gai.mjs` |
| `merci-sdk/aai` | `./lib/backends/aai.mjs` |
| `merci-sdk/json` | `./lib/support/json.mjs` |
| `merci-sdk/tools` | `./lib/tools/index.mjs` |
| `merci-sdk/planning` | `./lib/agentic/planning/index.mjs` |
| `merci-sdk/messaging` | `./lib/messaging/unified-message.mjs` |
| `merci-sdk/evals` | `./lib/agentic/evals.mjs` |
| `merci-sdk/cassette` | `./lib/support/cassette.mjs` |
| `merci-sdk/sessions` | `./lib/agentic/sessions.mjs` |
| `merci-sdk/otel` | `./lib/support/otel-exporter.mjs` |
| `merci-sdk/workspace` | `./lib/agentic/workspace/index.mjs` |
| `merci-sdk/scheduler` | `./lib/agentic/scheduler/index.mjs` |
| `merci-sdk/operator` | `./lib/agentic/operator/index.mjs` |
| `merci-sdk/workflow-policy` | `./lib/agentic/workflow-policy/index.mjs` |
| `merci-sdk/orchestration` | `./lib/agentic/orchestration/index.mjs` |
| `merci-sdk/knowledge` | `./lib/agentic/knowledge/index.mjs` |
| `merci-sdk/agents` | `./lib/agentic/agents/index.mjs` |
| `merci-sdk/package.json` | `./package.json` |

## 2. `lib/` tree

```text
lib/
├── agentic/ — Agentic orchestration layer
│   ├── acp-agent.mjs — ACP (Agent Client Protocol) adapter — merci as the AGENT side.
│   ├── agent-context.mjs — Typed context envelope threaded through agentic runs.
│   ├── agentic-core.mjs — Shared agentic loop for all Merci SDK backends.
│   ├── agents/
│   │   ├── apply.mjs — The two agent-definition consumers: a runnable session and a delegated subagent profile.
│   │   ├── catalog.mjs — The agent-definition tool catalog: one frozen table of the groups a `*.agent.yaml` file may request, the concr …
│   │   ├── index.mjs — Public surface of `merci-sdk/agents`: load a `*.agent.yaml`, resolve its tool model against a host toolbox, th …
│   │   ├── load.mjs — Read and load `*.agent.yaml` files: one file, or one flat directory.
│   │   ├── spec.mjs — Normalize one parsed `*.agent.yaml` mapping into a deep-frozen `AgentSpec`.
│   │   └── toolbox.mjs — Agent tool resolution: groups, selectors and sources become concrete tool objects and session actions.
│   ├── approval.mjs — One approval-input normalizer for every boundary that accepts a gate.
│   ├── artifacts.mjs — Artifact tool — persist large subagent outputs to files.
│   ├── browser/ — Browser component and engines
│   │   ├── component.mjs — BrowserComponent — the `browser` function-tool surface (read-only slice).
│   │   └── engines.mjs — Obscura browser engines + mode resolution (read + interactive).
│   ├── budget-accounting.mjs — The token-budget enforcement kernel — pure functions, no state.
│   ├── budget-pool.mjs — The shared budget pool (wave 6 / SP4, D12) — one cap for the whole spawn tree.
│   ├── chat-session-builder.mjs — Fluent ChatSession builder shared by every backend.
│   ├── chat-session.mjs — Abstract backend ChatSession — the step engine + system-context assembly.
│   ├── cli/ — CLI-facing helpers (launcher, suggestion source)
│   │   ├── launcher.mjs — CLI command launcher: dispatch + interactive agent loop.
│   │   └── suggestion-source.mjs — CommandSuggestionSource — UI-agnostic command-completion engine.
│   ├── context-fold.mjs — context-fold — the single row-array folding primitive.
│   ├── context.mjs — Auto-context sources — environment block + AGENTS.md instructions.
│   ├── decision-calibration.mjs — Decision calibration — ECE, Brier, and a threshold sweep.
│   ├── decision-gate.mjs — The shared decision gate — one System One call, one verdict.
│   ├── decision-usage.mjs — Decision usage → the session's budget pool.
│   ├── discussion-session.mjs — Standalone multi-agent discussion session.
│   ├── evals.mjs — Evals — run a suite of cases against a session and score each run.
│   ├── guardrails.mjs — Guardrails — the input/output tripwire.
│   ├── inbox-store.mjs — The inbox store — where a durable queue of submitted messages lives.
│   ├── ingest.mjs — Document ingestion → Markdown (images and PDFs via a model).
│   ├── journal.mjs — Execution journal — at-most-once side effects under retries, replays and resume.
│   ├── knowledge/
│   │   ├── adapters.mjs — Knowledge surface adapters — document, wiki corpus, memory bank, todo store, plan DAG.
│   │   ├── build.mjs — Knowledge graph construction — the mechanical pass.
│   │   ├── cache.mjs — Corpus cache — persist a built graph, detect a delta, rebuild only what moved.
│   │   ├── component.mjs — The knowledge capability component: ASG + wiki as one capability.
│   │   ├── index.mjs — Public surface of the knowledge capability (ASG + wiki).
│   │   ├── model.mjs — Knowledge graph model — node kinds, relation vocabulary, validation, patching and identity. Pure: no I/O, no m …
│   │   ├── profile.mjs — Structure induction — measure the corpus, propose the shape.
│   │   ├── query.mjs — Knowledge retrieval — seed, expand, rank.
│   │   ├── render.mjs — Knowledge rendering — the prompt block and the wiki projection.
│   │   └── store.mjs — Knowledge store — the canonical `graph.json` and the separate `ontology.json`.
│   ├── loops/ — Supervisory loop policy and judges
│   │   ├── index.mjs — Supervisory-loop policy + judge exports.
│   │   ├── judge.mjs — LLM completion judge factory — the "optional model reviewer" half of the verification story. Deterministic cri …
│   │   └── policy.mjs — Supervisory loop policy primitives (pure, no LLM, no IO).
│   ├── memory/ — Memory providers, engine, manager and component
│   │   ├── component.mjs — Memory capability — load/save tool component.
│   │   ├── engine.mjs — ProviderMemoryEngine — the memory component's engine.
│   │   ├── index.mjs — Memory subsystem public exports.
│   │   ├── manager.mjs — A provider's stored facts, when it keeps a bank the block renderer can show.
│   │   ├── providers.mjs — Memory providers + block renderers.
│   │   └── rerank.mjs — Decision-gate reranker for the memory vector tier.
│   ├── objective.mjs — Objective policy + the restatement pass.
│   ├── operator/
│   │   ├── http.mjs — Mountable HTTP handler for the operator API.
│   │   ├── index.mjs — Public surface of the operator API modules.
│   │   ├── ring.mjs — Bounded in-memory ring over the orchestration event namespaces.
│   │   ├── status.mjs — Plain-text status renderer for a terminal or `curl`.
│   │   └── view.mjs — Pure projections from the scheduler snapshot to the operator API shapes.
│   ├── orchestration/
│   │   ├── facade.mjs — `createOrchestration`: the composition root for the coordination layer.
│   │   └── index.mjs — Public surface of the orchestration composition root.
│   ├── pending-inbox.mjs — The parent inbox (wave 6 / SP3) — placing a background result into the next turn.
│   ├── permissions.mjs — Tool permission rules.
│   ├── plan/ — Plan/execute stage components
│   │   └── component.mjs — Plan agent — read-only planning phase with an approval-gated handoff.
│   ├── planning/ — DAG planning, graph, executor, evaluator, checkpoints, task state
│   │   ├── approval.mjs — ApprovalCoordinator — HITL approval gate.
│   │   ├── checkpoint.mjs — Unified checkpoint envelope.
│   │   ├── evaluator.mjs — WorkflowEvaluator — per-step output quality audit.
│   │   ├── executor-helpers.mjs — Pure helpers lifted out of WorkflowExecutor.
│   │   ├── executor-plan.mjs — Plan-lifecycle cluster of WorkflowExecutor.
│   │   ├── executor-session.mjs — Session-group cluster of WorkflowExecutor.
│   │   ├── executor-strategies.mjs — Step-strategy cluster of WorkflowExecutor.
│   │   ├── executor.mjs — WorkflowExecutor — DAG step execution + evaluator replan + HITL gates.
│   │   ├── graph-utils.mjs — DAG graph utilities — sort, interpolation, leaf output.
│   │   ├── index.mjs — DAG workflow planning public exports.
│   │   ├── plan-patch.mjs — Plan patches — a replan edits the plan instead of replacing it.
│   │   ├── plan.mjs — Plan — the guiding artifact both executors project onto.
│   │   ├── planner-utils.mjs — The session surface these helpers drive: configure it, then run one turn.
│   │   ├── planner.mjs — WorkflowPlanner — LLM DAG plan/replan.
│   │   └── task-state.mjs — TaskState — the serializable cross-stage carrier for a DAG run.
│   ├── pooled-client.mjs — A client view that attaches a scheduler attempt's ledger to the sessions an engine creates.
│   ├── scheduler/
│   │   ├── attempt-store.mjs — Attempt stores: the counters and park state a restart must not lose.
│   │   ├── claims.mjs — Claim stores: the in-process map and the O_EXCL claim file.
│   │   ├── index.mjs — Public surface of the scheduler modules.
│   │   ├── normalize.mjs — Normalization and deterministic ordering for external work items.
│   │   ├── reconcile.mjs — The refresh classification shared by the scheduler's refresh paths.
│   │   ├── retry.mjs — Retry delay, run-result normalization, and failure evidence.
│   │   ├── runner.mjs — `createEngineRunner`: adapts one scheduler attempt to an engine.
│   │   ├── scheduler.mjs — `WorkScheduler`: single-flight tick, dispatch, caps, settle, snapshot.
│   │   ├── state.mjs — Scheduler state shapes, defaults, usage accumulation, and the snapshot.
│   │   ├── validate.mjs — Pure configuration validation for `WorkScheduler`.
│   │   └── work-sources/
│   │       ├── function.mjs — Host-function work source.
│   │       ├── index.mjs — Public surface of the work-source adapters.
│   │       ├── json-file.mjs — Read-only JSON directory work source.
│   │       ├── memory.mjs — In-memory work source.
│   │       ├── records.mjs — The list/refresh asymmetry shared by every work source.
│   │       └── todos.mjs — Work source over the SDK's own todo store.
│   ├── session-policy.mjs — Shared session-policy carrier.
│   ├── sessions.mjs — SessionStore — durable conversation checkpoints.
│   ├── spawn-registry.mjs — The spawn registry (wave 6 / SP1).
│   ├── state-machine/ — State machine context and execution engine
│   │   ├── condition-evaluator.mjs — Memory-isolated evaluation of planner-authored string conditions.
│   │   ├── condition-vm.mjs — The one `node:vm` evaluator for a string transition condition.
│   │   ├── condition-worker.mjs — Child-process evaluator for planner-authored string conditions.
│   │   ├── context.mjs — StateContext — the StateMachine's shared key/value context.
│   │   ├── index.mjs — StateMachine public exports.
│   │   └── machine.mjs — StateMachine — verified node graph execution.
│   ├── step.mjs — step — the atomic, engine-agnostic agentic step primitive.
│   ├── task.mjs — Subagent delegation (task tool).
│   ├── thread-ids.mjs — The one thread-id rule shared by the scheduler, the workspace, the engine runner, and spawns.
│   ├── todos/ — Todo component
│   │   └── component.mjs
│   ├── transfer.mjs — transfer — the single cross-instance context-transfer primitive.
│   ├── web-shared.mjs — Shared web tool helpers (search + scrape + browser).
│   ├── webscrape/ — Web scrape component and engines
│   │   ├── component.mjs — WebScrapeComponent — the `web_scrape` function-tool surface.
│   │   ├── engines.mjs — Web-scrape engines + mode resolution.
│   │   └── index.mjs — Web-scrape capability barrel.
│   ├── websearch/ — Web search component and engines
│   │   ├── component.mjs — WebSearchComponent — the `web_search` function-tool surface.
│   │   └── engines.mjs — Web-search engines + mode resolution.
│   ├── workflow-policy/
│   │   ├── config.mjs — Strict `WORKFLOW.md` config resolution: defaults, validation, env/path expansion, and the operator-safe projec …
│   │   ├── file.mjs — Strict `WORKFLOW.md` discovery: one read, a fenced front-matter parse, and the one-shot load the policy starts …
│   │   ├── index.mjs — Public surface of the workflow policy modules.
│   │   ├── integrate.mjs — Integration helpers: a workflow policy to scheduler/workspace options, and the prompt renderer the engine runn …
│   │   ├── policy.mjs — WorkflowPolicy: lifecycle, live reload, last-known-good, preflight.
│   │   ├── template.mjs — Strict `WORKFLOW.md` prompt template: parse once, render per item.
│   │   └── watch.mjs — Debounced `fs.watch` wrapper for the workflow file.
│   └── workspace/
│       ├── git.mjs — Git adapter for the `git-worktree` workspace strategy.
│       ├── hooks.mjs — Lifecycle hooks for per-item workspaces.
│       ├── identity.mjs — The one workspace identifier rule.
│       ├── index.mjs — Public surface of the workspace modules.
│       ├── keys.mjs — Deterministic workspace keys for per-item workspace directories.
│       ├── manager.mjs — Per-item workspace lifecycle: `directory` and `git-worktree`.
│       ├── paths.mjs — Workspace path containment: the root resolver and the guards that keep every workspace path inside it.
│       └── toolbox.mjs — Bind the built-in context, shell, and artifact tools to one workspace.
├── backends/ — Provider clients and public backend entrypoints
│   ├── aai.mjs — Merci SDK 0.7.2 AAI (Anthropic AI)
│   ├── adapters/ — Per-provider wire adapters shared by the backend clients
│   │   ├── aai-adapter.mjs — AAI (Anthropic) backend adapter.
│   │   ├── adapter-common.mjs — Shared helpers for the backend adapters (OAI / GAI / AAI / JAI).
│   │   ├── gai-adapter.mjs — GAI (Google GenAI) backend adapter.
│   │   ├── jai-adapter.mjs — JAI backend adapter.
│   │   └── oai-adapter.mjs — OAI (OpenAI-compatible) backend adapter.
│   ├── decisions/
│   │   ├── adapters/
│   │   │   ├── decisions-common.mjs — Shared helpers for the decision wire adapters.
│   │   │   ├── gemini.mjs — Gemini Decisions wire adapter — `POST /v1beta/decisions`.
│   │   │   ├── keyed.mjs — Keyed decision wire adapter — OpenRouter `POST /api/alpha/decisions`.
│   │   │   └── openai.mjs — OpenAI Decisions wire adapter — `POST /v1/decisions`.
│   │   ├── client.mjs — createDecisionsClient — the stateless judgment surface.
│   │   └── index.mjs — Public surface of the decision (System One) client.
│   ├── gai.mjs — Merci SDK 0.7.2 GAI (Google GenAI)
│   ├── jai-vendor/ — Vendored JAI task/HTTP transport (vendor boundary)
│   │   ├── api.mjs — JAI Task V5 API + quota API clients.
│   │   ├── chat-session.mjs — JAI vendor chat session (standalone transport).
│   │   ├── client.mjs — JAI vendor transport client.
│   │   ├── http-client.mjs — JAI HTTP transport client.
│   │   ├── messages.mjs — JAI wire message shaping and media message creation.
│   │   ├── profiles.mjs — JAI model profile registry.
│   │   ├── sse-parser.mjs — JAI SSE stream parsers.
│   │   └── types.mjs — JAI wire types: parameter keys, SSE event shapes, and error hierarchy.
│   ├── jai.mjs — Agentic annex for the JAI transport.
│   ├── media.mjs — Backend media-message factory — per-backend image/PDF user turns.
│   ├── oai.mjs — Merci SDK 0.7.2 OAI
│   └── transport/
│       ├── aai-client.mjs — Anthropic wire client rebuilt on the native fetch transport.
│       ├── abort.mjs — Abort classification shared by the native OAI transport.
│       ├── errors.mjs — Error factories for the shared fetch transport.
│       ├── gai-client.mjs — Native Gemini/Vertex wire client rebuilt on the shared fetch transport.
│       ├── gai-constants.mjs — The Gemini tool-config enum the GAI adapter emits.
│       ├── google-auth.mjs — Native Google credential flow (ADC) for the Gemini/Vertex connector.
│       ├── http.mjs — Native fetch transport for the shared fetch/SSE layer the OAI, Anthropic and Google connectors use.
│       ├── oai-client.mjs — OAI wire client rebuilt on the native fetch transport.
│       ├── options.mjs — The `transportOptions` validator every native connector shares.
│       ├── sse.mjs — Strict server-sent-event reader for the shared fetch/SSE layer the OAI, Anthropic and Google connectors use.
│       └── stream.mjs — Streaming helpers shared by the transport clients.
├── core/ — Foundation: constants, errors, events, prompts, loadable base
│   ├── builtin-brand.mjs — The built-in tool tier is forged-proof against the DATA: SDK tool factories
│   ├── constants/ — Immutable constant tables (backends, protocols, limits, models, capabilities)
│   │   ├── capability.mjs — Capability registry, tool names, and row-marker keys for the LoadableComponent subsystems (skills, memory, tod …
│   │   ├── commands.mjs — Slash-command constants and CLI exit keywords.
│   │   ├── index.mjs — Constants barrel — re-exports every ./constants/*.mjs.
│   │   ├── limits/
│   │   │   ├── agent.mjs — Agent-loop, compaction, objective, delegation and journal limits.
│   │   │   ├── define.mjs — Limit descriptor factory — the one shape every tunable declares.
│   │   │   ├── planning.mjs — State-machine and planning limits.
│   │   │   ├── presentation.mjs — Log, browser, tool-output and on-disk identity length limits.
│   │   │   ├── runtime.mjs — Scheduler, operator, workspace, memory, web and workflow-runtime limits.
│   │   │   ├── tools.mjs — Shell, read/grep, skill, MCP and A2A tool limits.
│   │   │   └── transport.mjs — Transport, retry, circuit-breaker, embedding and telemetry limits.
│   │   ├── limits.mjs — Tunable numeric limits and the error-code registry.
│   │   ├── memory.mjs — Memory-subsystem constants.
│   │   ├── models.mjs — Model-tier defaults and provider detection helpers.
│   │   ├── multi-protocol.mjs — MCP/A2A protocol wire constants (timeouts, JSON-RPC, agent-card path).
│   │   ├── plan-reminders.mjs — Prompt strings and events for plan-mode agents.
│   │   ├── providers.mjs — Provider registry.
│   │   ├── roles.mjs — Client-role registry.
│   │   ├── sdk.mjs — SDK identity, backend/auth types, endpoints, and env keys.
│   │   ├── shell-tool-lists.mjs — Shell-tool command allow/block lists and truncation suffixes.
│   │   ├── standards.mjs — Wire-standard registry.
│   │   ├── system-message.mjs — Default system prompt and message-merge constants.
│   │   └── work-sources.mjs — The Symphony §11.4 work-source category vocabulary.
│   ├── emitter.mjs — MerciEventEmitter — a drop-in EventEmitter with glob subscriptions, priority ordering, and per-listener isolat …
│   ├── errors.mjs — Typed error hierarchy for the Merci SDK.
│   ├── events.mjs — Unified event layer for the Merci SDK.
│   ├── hooks.mjs — Hook registry — the "intervene" layer of the event system.
│   ├── lifecycle.mjs — Phase lifecycle umbrella.
│   ├── limit-config.mjs — The one resolution layer for every tunable limit.
│   ├── loadable.mjs — LoadableComponent — the dual-mode load/save contract + unified capability ("extension") hooks.
│   ├── prompts/ — Prompt text fragments (conversation, DAG, memory, state machine)
│   │   ├── conversation.mjs — Conversation-history compaction prompts.
│   │   ├── dag.mjs — DAG workflow planning, evaluation, and replan prompts.
│   │   ├── memory.mjs — Cognitive memory prompts (distillation + per-step memory block).
│   │   └── sm.mjs — StateMachine planning schema and prompt.
│   └── prompts.mjs — Prompt constants barrel — re-exports ./prompts/*.mjs.
├── index.mjs — Merci SDK entry point.
├── messaging/ — Unified message model and normalizers
│   ├── decision.mjs — Canonical decision envelope — the question/answer model every discriminative ("System One") wire projects onto …
│   ├── messages.mjs — Unified message factories and per-backend history normalizers.
│   ├── row-shape.mjs — Row-shape predicates shared by the inbox, guardrails and context assembly.
│   ├── unified-message.mjs — Canonical UnifiedMessage typedefs + re-export surface.
│   └── unified-parameter.mjs — Unified `ParameterBuilder` for the Merci SDK.
├── support/ — Cross-cutting utilities (retry, timeouts, JSON, logger, limits)
│   ├── api-observer.mjs — Pluggable API-call observers.
│   ├── body.mjs — body — the bounded response-body reader the transports share.
│   ├── cassette.mjs — Cassette — record a session's vendor calls once, replay them offline.
│   ├── child-env.mjs — The environment a child process may inherit.
│   ├── data-url.mjs — data-url — the base64 data-URL parse and encode the wire layers share.
│   ├── event-logger.mjs — Event→logger bridges — turn the SDK's observe surfaces into log lines.
│   ├── fs-store.mjs — fs-store — the single durable-JSON file primitive.
│   ├── json.mjs — A robust utility for handling structured JSON output from LLMs.
│   ├── limiter.mjs — Concurrency limiter (semaphore) for fan-out calls.
│   ├── logger.mjs — Pretty console logger — the SDK's single logging vocabulary.
│   ├── mime.mjs — mime — the media type for a file path.
│   ├── object.mjs — object — the record coercion the transports share.
│   ├── options.mjs — options — the closed-key options reader.
│   ├── otel-exporter.mjs — OTLP exporter — the SDK event stream as OpenTelemetry spans.
│   ├── path-safety.mjs — Path containment shared by every boundary that accepts a path.
│   ├── redact.mjs — The two redaction helpers every sink shares.
│   ├── retry-policy.mjs — Pluggable retry policies for SDK API calls.
│   ├── run-command.mjs — Bounded child-process runner for the tools layer.
│   ├── stream-timeout.mjs — Pluggable stream timeout policies.
│   ├── utils.mjs — Shared SDK support helpers.
│   ├── validation.mjs — validation — the shape predicates and the named-string assertion.
│   └── yaml-mapping.mjs — Safe YAML mapping parse shared by the workflow and agent loaders.
└── tools/ — Tool system: execution, MCP client/server, A2A, shell, skills, context tools
    ├── a2a-dialect.mjs — A2A (Agent-to-Agent) wire vocabulary.
    ├── a2a-server.mjs — A2A (Agent-to-Agent) server — A2A v1.0.0 peer.
    ├── a2a.mjs — A2A (Agent-to-Agent) remote tool loader — A2A v1.0.0 client.
    ├── context-tools.mjs — Built-in context tools — read / grep / glob.
    ├── external-capability.mjs — External tool capabilities (MCP / A2A / ACP) on the unified capability ("extension") contract.
    ├── index.mjs — Tool-family re-export shim.
    ├── mcp-client.mjs — MCP client and tool loader (Model Context Protocol).
    ├── mcp-server.mjs — MCP server helper (Model Context Protocol).
    ├── mcp-task-store.mjs — The task store behind the legacy MCP Tasks interop.
    ├── script-tools.mjs — Script-backed tools — one interpreter map, contained script resolution, and the plain Tool object that runs a …
    ├── shell-tools.mjs — Shell Tools Integration
    ├── skills.mjs — SkillsLibrary — dual-mode loadable skills component.
    └── tool-execution.mjs — XML tool-call extraction and execution.
```

## 3. Areas at a glance

| Area | Files | Declared | Re-exported | Types | Responsibility |
| --- | --- | --- | --- | --- | --- |
| `core` | 35 | 217 | 4 | 29 | Foundation: constant tables, typed errors, events, prompt text, loadable component base |
| `messaging` | 5 | 36 | 13 | 27 | Unified message model, factories and per-backend history normalizers |
| `backends` | 35 | 87 | 2 | 61 | Provider clients (JAI, OAI, GAI, AAI) and their protocol adapters |
| `support` | 22 | 102 | 1 | 37 | Cross-cutting utilities: retry, timeouts, JSON, logger, limits |
| `tools` | 13 | 53 | 34 | 41 | Tool system: execution, MCP client/server, A2A, shell, skills, context tools |
| `agentic` | 127 | 543 | 196 | 355 | Orchestration: sessions, loops, planning, memory, state machine, web components |
| `root` | 1 | 5 | 307 | 3 | Public barrel that defines the package entry surface (lib/index.mjs) |

## 4. Symbols by area

### 4.1 `core` — Foundation: constant tables, typed errors, events, prompt text, loadable component base

#### `lib/core/builtin-brand.mjs` — The built-in tool tier is forged-proof against the DATA: SDK tool factories

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `BUILTIN_BRAND` | const | `const BUILTIN_BRAND = Symbol('merci.tools.builtIn')` | The built-in tool tier is forged-proof against the DATA: SDK tool factories brand their definitions with a module-scoped Symbol, and `executeTools` trusts ONLY the brand — a caller-supplied plain `builtIn: true` boolean is inert, so a planted plain-object tool can never hijack the tier (and displace a confined built-in at e.g. |
| `markBuiltIn` | function | `function markBuiltIn({ tool })` | Stamps a tool definition as an SDK built-in. |
| `isBuiltIn` | function | `function isBuiltIn({ tool })` |  |

#### `lib/core/constants/capability.mjs` — Capability registry, tool names, and row-marker keys for the LoadableComponent subsystems (skills, memory, tod …

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `CAPABILITY` | const | `const CAPABILITY = Object.freeze({ SKILLS: 'skills', MEMORY: 'memory', TODOS: ' …` | Registry of LoadableComponent capability ids. |
| `LOAD_SKILLS_TOOL_NAME` | const | `const LOAD_SKILLS_TOOL_NAME = 'load_skills'` | Load tool name for the skills capability. |
| `LOAD_MEMORY_TOOL_NAME` | const | `const LOAD_MEMORY_TOOL_NAME = 'load_memory'` | Load tool name for the memory capability. |
| `SAVE_MEMORY_TOOL_NAME` | const | `const SAVE_MEMORY_TOOL_NAME = 'save_memory'` | Save tool name for the memory capability. |
| `LOAD_TODOS_TOOL_NAME` | const | `const LOAD_TODOS_TOOL_NAME = 'load_todos'` | Load tool name for the todos capability. |
| `MANAGE_TODOS_TOOL_NAME` | const | `const MANAGE_TODOS_TOOL_NAME = 'manage_todos'` | Manage (save) tool name for the todos capability. |
| `RUN_STATE_MACHINE_TOOL_NAME` | const | `const RUN_STATE_MACHINE_TOOL_NAME = 'run_state_machine'` | Single tool name that runs a state machine. |
| `KNOWLEDGE_QUERY_TOOL_NAME` | const | `const KNOWLEDGE_QUERY_TOOL_NAME = 'knowledge_query'` | Query tool name for the knowledge (ASG/wiki) capability. |
| `KNOWLEDGE_PATCH_TOOL_NAME` | const | `const KNOWLEDGE_PATCH_TOOL_NAME = 'knowledge_patch'` | Patch (save) tool name for the knowledge capability. |
| `WEB_SEARCH_TOOL_NAME` | const | `const WEB_SEARCH_TOOL_NAME = 'web_search'` | Single tool name that runs a web search. |
| `WEB_SCRAPE_TOOL_NAME` | const | `const WEB_SCRAPE_TOOL_NAME = 'web_scrape'` | Single tool name that scrapes a web page. |
| `BROWSER_TOOL_NAME` | const | `const BROWSER_TOOL_NAME = 'browser'` | Single tool name that loads a web page in the headless browser (read-only slice). |
| `TOOL_SEARCH_TOOL_NAME` | const | `const TOOL_SEARCH_TOOL_NAME = 'tool_search'` | Single tool name that discovers deferred tools. |
| `LOAD_ARTIFACTS_TOOL_NAME` | const | `const LOAD_ARTIFACTS_TOOL_NAME = 'load_artifacts'` | Load tool name for the artifacts capability (lists saved artifact files). |
| `SAVE_ARTIFACT_TOOL_NAME` | const | `const SAVE_ARTIFACT_TOOL_NAME = 'save_artifact'` | Save tool name for the artifacts capability (persists an output to a file). |
| `WEB_SEARCH_MODES` | const | `const WEB_SEARCH_MODES = Object.freeze([ 'off', 'native', 'tavily', 'native_with_tavi …` | Valid web search modes (validated by withWebSearch). |
| `WEB_SCRAPE_MODES` | const | `const WEB_SCRAPE_MODES = Object.freeze([ 'off', 'native', 'tavily', 'curl', 'native_w …` | Valid web scrape modes (validated by withWebScrape). |
| `BROWSER_MODES` | const | `const BROWSER_MODES = Object.freeze([ 'off', 'obscura', 'playwright', 'curl', 'too …` | Valid browser modes (validated by withBrowser). |
| `isNativeMode` | function | `function isNativeMode({ mode })` | Whether a capability mode requests the server-side native leg — the `native` / `native_with_*_fallback` family (`WEB_SEARCH_MODES`, `WEB_SCRAPE_MODES`). |
| `WEB_SEARCH_PRELOAD_BLOCK` | const | `const WEB_SEARCH_PRELOAD_BLOCK = '[Web Search Active]\nWeb search is active in the current mo …` | Short announcement block injected into the system message when web search is active (mode !== 'off'). |
| `WEB_SCRAPE_PRELOAD_BLOCK` | const | `const WEB_SCRAPE_PRELOAD_BLOCK = '[Web Scrape Active]\nWeb scrape is active in the current mo …` | Short announcement block injected into the system message when web scrape is active (mode !== 'off'). |
| `BROWSER_PRELOAD_BLOCK` | const | `const BROWSER_PRELOAD_BLOCK = '[Browser Active]\nBrowser is active in the current mode. Us …` | Short announcement block injected into the system message when the browser is active (mode !== 'off'). |
| `CAPABILITY_REGISTRY` | const | `const CAPABILITY_REGISTRY = Object.freeze({ [CAPABILITY.SKILLS]: { announce: CAPABILITY_ …` | Per-capability metadata: the startup announcement line and the tool names the model uses to load (and optionally save) the capability. |
| `INJECTION_META_KEY` | const | `const INJECTION_META_KEY = 'merciInjection'` | Key stamping the originating capability id on injected rows; stripped by every normalizer. |
| `MERCI_ID_KEY` | const | `const MERCI_ID_KEY = 'merciId'` | Stable non-wire message-id key (LangGraph-style message ids). |
| `MERCI_NATIVE_KEY` | const | `const MERCI_NATIVE_KEY = 'merciNative'` | Stable non-wire key carrying a row's provider-native replay payload (`{ provider, protocol, items }`). |
| `SYNTHETIC_TURN_INJECTION` | const | `const SYNTHETIC_TURN_INJECTION = 'synthetic_turn'` | Marker value for SDK-generated user turns (synthesis nudges, follow-up prompts) so isGenuineUserTurn/countConversationTurns never read them as genuine user input. |
| `DEFAULT_PRELOAD` | const | `const DEFAULT_PRELOAD = false` | Whether loadable subsystems preload their payload at construction. |

#### `lib/core/constants/commands.mjs` — Slash-command constants and CLI exit keywords.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `COMMAND_PREFIX` | const | `const COMMAND_PREFIX = '/'` | Prefix of every interactive slash command. |
| `SystemCommand` | const | `const SystemCommand = { HELP: '/help', RESET: '/reset', HISTORY: '/history', LIMIT …` | The built-in interactive commands. |
| `SYSTEM_COMMAND_DESCRIPTIONS` | const | `const SYSTEM_COMMAND_DESCRIPTIONS = { [SystemCommand.HELP]: 'Displays all available slash comman …` | User-facing help text for each system command. |
| `BASE_EXIT_KEYWORDS` | const | `const BASE_EXIT_KEYWORDS = ['/exit', '/quit', 'exit', 'quit']` | Keywords that terminate a CLI session. |

#### `lib/core/constants/index.mjs` — Constants barrel — re-exports every ./constants/*.mjs.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `*` | barrel | ↩ `lib/core/constants/sdk.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/standards.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/providers.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/roles.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/models.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/limits.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/shell-tool-lists.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/memory.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/capability.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/system-message.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/commands.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/plan-reminders.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/multi-protocol.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/constants/work-sources.mjs` | Re-exports every symbol from the target module |

#### `lib/core/constants/limits.mjs` — Tunable numeric limits and the error-code registry.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `NODE_TIMER_MAX` | const | ↩ `lib/core/constants/limits/define.mjs` | Largest delay Node's timers accept. |
| `LIMIT_ENV_PREFIX` | const | ↩ `lib/core/constants/limits/define.mjs` | Prefix every limit env key carries. |
| `LIMIT_REGISTRY` | const | `const LIMIT_REGISTRY = mergeRegistries([ /** @type {Record<string, LimitDescriptor> …` | Every tunable limit, keyed by its logical name. |
| `LIMIT_DEFAULTS` | const | `const LIMIT_DEFAULTS = Object.freeze(Object.fromEntries( Object.entries(LIMIT_REGIS …` | Default value of every limit, keyed by its logical name. |
| `DEFAULT_MAX_ITERATIONS` | const | `const DEFAULT_MAX_ITERATIONS = defaultValue('max_iterations')` | Max agentic-loop iterations per run()/step() before forcing a final text answer. |
| `EMBED_MAX_RETRIES` | const | `const EMBED_MAX_RETRIES = defaultValue('embed_max_retries')` | Max retries for a single embedding call. |
| `EMBED_INITIAL_DELAY_MS` | const | `const EMBED_INITIAL_DELAY_MS = defaultValue('embed_initial_delay_ms')` | Initial backoff delay (ms) between embedding retries. |
| `MAX_CONSECUTIVE_EMPTY_RESPONSES` | const | `const MAX_CONSECUTIVE_EMPTY_RESPONSES = defaultValue('max_consecutive_empty')` | Consecutive empty model responses tolerated before giving up. |
| `DEFAULT_MAX_SCHEMA_RETRIES` | const | `const DEFAULT_MAX_SCHEMA_RETRIES = defaultValue('max_schema_retries')` | Corrective retries for a schema-invalid structured deliverable. |
| `DEFAULT_MAX_FOLLOW_UPS` | const | `const DEFAULT_MAX_FOLLOW_UPS = defaultValue('max_follow_ups')` | Safety cap on staged follow-up rounds (opts.followUp). |
| `PROFILE_CACHE_TTL_MS` | const | `const PROFILE_CACHE_TTL_MS = defaultValue('profile_cache_ttl_ms')` | TTL (ms) for cached backend profile lookups. |
| `DEFAULT_STREAM_TIMEOUT_MS` | const | `const DEFAULT_STREAM_TIMEOUT_MS = defaultValue('stream_timeout_ms')` | Default per-stream idle timeout (ms). |
| `TIMEOUT_CODES` | const | `const TIMEOUT_CODES = new Set([ // The SDK's own four, each raised by a different …` | Every machine-readable code the SDK raises for a timeout. |
| `SHELL_TOOL_DEFAULT_TIMEOUT_MS` | const | `const SHELL_TOOL_DEFAULT_TIMEOUT_MS = defaultValue('shell_tool_timeout_ms')` | Default shell tool timeout (ms). |
| `SHELL_TOOL_MAX_OUTPUT_LENGTH` | const | `const SHELL_TOOL_MAX_OUTPUT_LENGTH = defaultValue('shell_tool_max_output_chars')` | Truncation cap on shell tool output (characters). |
| `SHELL_TOOL_MAX_PIPELINE_STAGES` | const | `const SHELL_TOOL_MAX_PIPELINE_STAGES = defaultValue('shell_tool_max_pipeline_stages')` | Max stages in one structured shell pipeline. |
| `MAX_INTAKE_OUTPUT_CHARS` | const | `const MAX_INTAKE_OUTPUT_CHARS = defaultValue('max_intake_output_chars')` | Per-output cap when upstream step outputs are inlined into a downstream prompt (characters, visible marker). |
| `DEFAULT_COMPACTION_THRESHOLD_TOKENS` | const | `const DEFAULT_COMPACTION_THRESHOLD_TOKENS = defaultValue('compaction_threshold_tokens')` | Estimated token count at which history compaction kicks in. |
| `DEFAULT_DAG_HITL_TIMEOUT_MS` | const | `const DEFAULT_DAG_HITL_TIMEOUT_MS = defaultValue('dag_hitl_timeout_ms')` | Default timeout (ms) for a DAG step paused on manual approval. |
| `MAX_FOLLOW_UP_EXTENSIONS` | const | `const MAX_FOLLOW_UP_EXTENSIONS = defaultValue('max_follow_up_extensions')` | Max times a followUp stage may extend itself. |
| `DEFAULT_MAX_REPLAN_COUNT` | const | `const DEFAULT_MAX_REPLAN_COUNT = defaultValue('max_replan_count')` | Max workflow replans before failing. |
| `DEFAULT_DAG_MAX_DEPTH` | const | `const DEFAULT_DAG_MAX_DEPTH = defaultValue('dag_max_depth')` | Max nested-DAG depth (a step with engine:'dag' spawning a child executor). |
| `DEFAULT_MAX_VISITS_PER_NODE` | const | `const DEFAULT_MAX_VISITS_PER_NODE = defaultValue('max_visits_per_node')` | Default cycle-guard ceiling on node visits in a state machine / DAG. |
| `DEFAULT_MAX_MACHINE_STEPS` | const | `const DEFAULT_MAX_MACHINE_STEPS = defaultValue('max_machine_steps')` | Global step ceiling for a state machine (max node visits across the run). |
| `DEFAULT_RETRY_LIMIT` | const | `const DEFAULT_RETRY_LIMIT = defaultValue('default_retry_limit')` | Default retry count for transient tool/transport failures. |
| `STREAMING_MAX_RETRIES` | const | `const STREAMING_MAX_RETRIES = defaultValue('streaming_max_retries')` | Streaming/LLM-call retry preset (SOTA scale — matches the OpenAI/Anthropic default of 2): retries past the first call. |
| `STREAMING_INITIAL_DELAY_MS` | const | `const STREAMING_INITIAL_DELAY_MS = defaultValue('streaming_initial_delay_ms')` | Streaming/LLM-call retry preset: base delay before the first retry (ms). |
| `STREAMING_MAX_DELAY_MS` | const | `const STREAMING_MAX_DELAY_MS = defaultValue('streaming_max_delay_ms')` | Streaming/LLM-call retry preset: upper bound on any single backoff (ms). |
| `ERROR_CODES` | const | `const ERROR_CODES = Object.freeze({ BASE: 'MERCI-ERR', BACKEND: 'MERCI-BACKEND-E …` | Stable machine-readable error codes carried by the MerciError hierarchy. |

#### `lib/core/constants/limits/agent.mjs` — Agent-loop, compaction, objective, delegation and journal limits.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `AGENT_LIMITS` | const | `const AGENT_LIMITS = Object.freeze({ max_iterations: defineLimit({ env: 'MAX_ITER …` |  |

#### `lib/core/constants/limits/define.mjs` — Limit descriptor factory — the one shape every tunable declares.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `NODE_TIMER_MAX` | const | `const NODE_TIMER_MAX = 2_147_483_647` | Largest delay Node's timers accept. |
| `LIMIT_ENV_PREFIX` | const | `const LIMIT_ENV_PREFIX = 'MERCI_LIMIT_'` | Prefix every limit env key carries. |
| `defineLimit` | function | `function defineLimit({ env, legacyEnv = [], default: fallback, min, max, unbounded, integer = true, timer = false, guard = false, mutable = true, doc })` | Declares one tunable limit. |

#### `lib/core/constants/limits/planning.mjs` — State-machine and planning limits.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `PLANNING_LIMITS` | const | `const PLANNING_LIMITS = Object.freeze({ max_machine_steps: defineLimit({ env: 'MAX_M …` |  |

#### `lib/core/constants/limits/presentation.mjs` — Log, browser, tool-output and on-disk identity length limits.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `PRESENTATION_LIMITS` | const | `const PRESENTATION_LIMITS = Object.freeze({ log_truncate_chars: defineLimit({ env: 'LOG_ …` |  |

#### `lib/core/constants/limits/runtime.mjs` — Scheduler, operator, workspace, memory, web and workflow-runtime limits.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `RUNTIME_LIMITS` | const | `const RUNTIME_LIMITS = Object.freeze({ scheduler_poll_interval_ms: defineLimit({ en …` |  |

#### `lib/core/constants/limits/tools.mjs` — Shell, read/grep, skill, MCP and A2A tool limits.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `TOOLS_LIMITS` | const | `const TOOLS_LIMITS = Object.freeze({ shell_tool_timeout_ms: defineLimit({ env: 'S …` |  |

#### `lib/core/constants/limits/transport.mjs` — Transport, retry, circuit-breaker, embedding and telemetry limits.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `TRUNCATION_MARKER` | const | `const TRUNCATION_MARKER = '…[truncated]'` | Appended to text the `max_error_message_chars` cap cut, so a cut diagnostic is never mistaken for the vendor's whole words. |
| `TRANSPORT_LIMITS` | const | `const TRANSPORT_LIMITS = Object.freeze({ jai_header_timeout_ms: defineLimit({ env: 'J …` |  |

#### `lib/core/constants/memory.mjs` — Memory-subsystem constants.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `DEFAULT_MEMORY_FILE_PATH` | const | `const DEFAULT_MEMORY_FILE_PATH = './merci-memory.json'` | Default L1 store path. |
| `DEFAULT_MEMORY_SQLITE_PATH` | const | `const DEFAULT_MEMORY_SQLITE_PATH = './merci-memory.sqlite'` | Default L1 SQLite store path. |
| `DEFAULT_UTF8_ENCODING` | const | `const DEFAULT_UTF8_ENCODING = 'utf8'` | Encoding used for memory file reads/writes. |
| `FS_ENOENT_CODE` | const | `const FS_ENOENT_CODE = 'ENOENT'` | Node fs error code for missing files. |
| `LOG_PREFIX_MEMORY` | const | `const LOG_PREFIX_MEMORY = 'Memory'` | Log prefix for memory-subsystem messages. |
| `DEFAULT_MEMORY_CATEGORY` | const | `const DEFAULT_MEMORY_CATEGORY = 'general'` | Fallback category for facts without an explicit one. |
| `MEMORY_FACT_ID_PREFIX` | const | `const MEMORY_FACT_ID_PREFIX = 'fact_'` | Prefix of generated fact ids. |
| `DEFAULT_MEMORY_BANK_NAME` | const | `const DEFAULT_MEMORY_BANK_NAME = 'workspace'` | Default single-bank name. |
| `DEFAULT_MEMORY_BANK_DESC` | const | `const DEFAULT_MEMORY_BANK_DESC = 'Default workspace memory for project-specific configuration …` | Description shown for the default bank. |
| `COMPOSITE_MEMORY_BANK_NAME` | const | `const COMPOSITE_MEMORY_BANK_NAME = 'composite'` | Composite router bank name. |
| `COMPOSITE_MEMORY_BANK_DESC` | const | `const COMPOSITE_MEMORY_BANK_DESC = 'Composite router for multiple memory banks.'` | Description shown for the composite bank. |
| `MEMORY_DISTILLATION_SCHEMA` | const | `const MEMORY_DISTILLATION_SCHEMA = z.strictObject({ newFacts: z.array(z.object({ content: z.str …` | Zod schema constraining the distillation engine's output (newFacts, obsoleteFactIds). |
| `MEMORY_MAX_HISTORY_ROWS` | const | `const MEMORY_MAX_HISTORY_ROWS = LIMIT_REGISTRY.memory_max_history_rows.default` | Rows kept in a memory bank's audit trail (`history`). |

#### `lib/core/constants/models.mjs` — Model-tier defaults and provider detection helpers.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `LOCAL_API_KEY_PLACEHOLDER` | const | `const LOCAL_API_KEY_PLACEHOLDER = 'not-needed'` | API-key placeholder for local backends that require none. |
| `XML_TOOL_CALL_TAGS` | const | `const XML_TOOL_CALL_TAGS = Object.freeze({ START: '<tool_call>', END: '</tool_call>' })` | XML open/close tags wrapping tool calls on raw-text backends. |
| `DEFAULT_ANTHROPIC_MODEL` | const | `const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5'` | Default Anthropic model id. |
| `DEFAULT_OPENCODE_MODEL` | const | `const DEFAULT_OPENCODE_MODEL = 'deepseek-v4-flash'` | Default model id for the opencode backend. |
| `isOSeries` | function | `function isOSeries({ model })` | path pattern) that must use the reasoning-wire shape. |
| `MIME_TYPE_MAP` | const | `const MIME_TYPE_MAP = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image …` | Extension → MIME-type map for media attachments. |
| `isGoogleProvider` | function | `function isGoogleProvider({ modelProfile, profile })` | (Gemini/Vertex). |
| `isAnthropicProvider` | function | `function isAnthropicProvider({ modelProfile, profile })` |  |

#### `lib/core/constants/multi-protocol.mjs` — MCP/A2A protocol wire constants (timeouts, JSON-RPC, agent-card path).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WELL_KNOWN_AGENT_CARD_PATH` | const | `const WELL_KNOWN_AGENT_CARD_PATH = '/.well-known/agent-card.json'` | Well-known path where an A2A agent card is advertised. |
| `MCP_DEFAULT_TIMEOUT_MS` | const | `const MCP_DEFAULT_TIMEOUT_MS = LIMIT_REGISTRY.mcp_default_timeout_ms.default` | Default MCP server call timeout (ms) — the SDK's own default. |
| `MCP_PROBE_TIMEOUT_MS` | const | `const MCP_PROBE_TIMEOUT_MS = LIMIT_REGISTRY.mcp_probe_timeout_ms.default` | Upper bound (ms) on the `server/discover` probe a modern-era connect sends. |
| `A2A_REQUEST_MAX_BODY_BYTES` | const | `const A2A_REQUEST_MAX_BODY_BYTES = LIMIT_REGISTRY.a2a_request_max_body_bytes.default` | Default cap on an A2A request body, in bytes. |
| `JSON_RPC_VERSION` | const | `const JSON_RPC_VERSION = '2.0'` | JSON-RPC version used by MCP transport. |
| `A2A_PROTOCOL_VERSION` | const | `const A2A_PROTOCOL_VERSION = '1.0'` | A2A protocol version implemented by this SDK. |
| `A2A_CONTENT_TYPE` | const | `const A2A_CONTENT_TYPE = 'application/a2a+json'` | Content type of an A2A JSON-RPC request or response. |
| `A2A_VERSION_HEADER` | const | `const A2A_VERSION_HEADER = 'A2A-Version'` | Header carrying the A2A protocol version. |
| `A2A_EXTENSION_HEADER` | const | `const A2A_EXTENSION_HEADER = 'A2A-Extensions'` | Header carrying A2A extension identifiers. |
| `A2A_METHODS` | const | `const A2A_METHODS = Object.freeze({ SEND_MESSAGE: 'message/send', STREAM_MESSAGE …` | The A2A JSON-RPC method set (v1.0.0). |
| `A2A_TASK_STATES` | const | `const A2A_TASK_STATES = Object.freeze({ SUBMITTED: 'TASK_STATE_SUBMITTED', WORKING: …` | A2A task states (v1.0.0 wire values). |
| `A2A_ROLES` | const | `const A2A_ROLES = Object.freeze({ USER: 'ROLE_USER', AGENT: 'ROLE_AGENT' })` | A2A message roles (v1.0.0 wire values). |
| `A2A_TERMINAL_STATES` | const | `const A2A_TERMINAL_STATES = Object.freeze([ A2A_TASK_STATES.COMPLETED, A2A_TASK_STATES.F …` | A2A task states that end a task. |
| `A2A_SSE_HEADERS` | const | `const A2A_SSE_HEADERS = Object.freeze({ 'Content-Type': 'text/event-stream', 'Cache- …` | SSE headers an A2A streaming response must carry. |

#### `lib/core/constants/plan-reminders.mjs` — Prompt strings and events for plan-mode agents.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `DISTILLATION_ERROR_CODE` | const | `const DISTILLATION_ERROR_CODE = 'MEMORY-DISTILL-FAILED'` | Stable code for memory distillation failures. |
| `FINAL_ITERATION_REMINDER` | const | `const FINAL_ITERATION_REMINDER = '[Final turn: stay strictly within your persona. Do not call …` | Appended on the final loop iteration: stop tool calls, stay in persona. |
| `PENULTIMATE_ITERATION_REMINDER` | const | `const PENULTIMATE_ITERATION_REMINDER = '[Notice: one tool round remains — finish any last lookup, t …` | Pushed as a model-visible synthetic user turn after the penultimate tool round: one round remains, next turn must be the final text answer. |
| `REVIEW_STAGE_REMINDER` | const | `const REVIEW_STAGE_REMINDER = [ 'Review what you just produced against the original reques …` | Default followUp stage: review the produced answer, fix gaps, or reply DONE. |
| `DEFAULT_EXTRACTOR_PERSONA` | const | `const DEFAULT_EXTRACTOR_PERSONA = 'You are an exact parameter extraction engine. Extract param …` | System persona for exact parameter extraction. |
| `PLAN_EXIT_TOOL_NAME` | const | `const PLAN_EXIT_TOOL_NAME = 'plan_exit'` | Tool the plan agent must call to finish plan mode. |
| `PLAN_MODE_REMINDER` | const | `const PLAN_MODE_REMINDER = [ 'PLAN MODE: you are in read-only planning mode. Only the t …` | System-context block injected while the plan agent is active. |
| `BUILD_SWITCH_REMINDER` | const | `const BUILD_SWITCH_REMINDER = [ 'Your operational mode changed from plan to execute. You a …` | System-context block injected on the first run after plan → execute. |
| `PLAN_STAGE_REMINDER` | const | `const PLAN_STAGE_REMINDER = [ 'Your last answer did not finalize the plan: plan_exit was …` | Auto-queued followUp stage: refuse plain-text answers until plan_exit is called. |
| `EVENTS` | const | ↩ `lib/core/events.mjs` | Canonical event-name registry. |

#### `lib/core/constants/providers.mjs` — Provider registry.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ProviderType` | const | `const ProviderType = Object.freeze({ JAI: 'jai', OPENROUTER: 'openrouter', OPENAI …` | Every concrete provider the SDK can target. |
| `PROVIDERS` | const | `const PROVIDERS = Object.freeze({ [ProviderType.JAI]: { id: ProviderType.JAI, …` | Descriptors keyed by ProviderType value. |
| `providerDescriptorFor` | function | `function providerDescriptorFor({ provider } = {})` |  |
| `standardFor` | function | `function standardFor({ provider } = {})` |  |
| `providersForStandard` | function | `function providersForStandard({ standard } = {})` |  |

#### `lib/core/constants/roles.mjs` — Client-role registry.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ClientRole` | const | `const ClientRole = Object.freeze({ GENERATIVE: 'generative', EMBEDDING: 'embedd …` | The three client roles a host can resolve. |
| `ROLE_REGISTRY` | const | `const ROLE_REGISTRY = Object.freeze({ [ClientRole.GENERATIVE]: { id: ClientRole.GE …` | Role descriptors keyed by ClientRole value. |

#### `lib/core/constants/sdk.mjs` — SDK identity, backend/auth types, endpoints, and env keys.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `SDK_VERSION` | const | `const SDK_VERSION = (() => { try { return String(createRequire(import.meta.url)( …` | The SDK version string, derived from package.json (three levels up). |
| `AuthType` | const | `const AuthType = { USER: 'user', SERVICE: 'service', APPLICATION: 'applicatio …` | Authentication modes used by the config layer. |
| `ProtocolType` | const | `const ProtocolType = { CHAT: 'chat', RESPONSES: 'responses', TASK: 'task', COMPLE …` | LLM wire protocols — the request/response contract a session speaks. |
| `SUPPORTED_PROTOCOLS` | const | `const SUPPORTED_PROTOCOLS = Object.freeze(Object.fromEntries( Object.entries(PROVIDERS). …` | Protocols each backend recognizes, in default-preference order. |
| `TRANSPORT_PROTOCOLS` | const | `const TRANSPORT_PROTOCOLS = new Set( Object.values(STANDARDS).flatMap((standard) => stan …` | Protocols that are transport surfaces, not session protocols: the JAI Task API takes a roster task id + opaque parameters (no history/system/tools), so it cannot back a chat session — use `client.tasks` for those calls. |
| `protocolsFor` | function | `function protocolsFor({ provider })` |  |
| `sessionProtocolsFor` | function | `function sessionProtocolsFor({ provider })` |  |
| `defaultProtocolFor` | function | `function defaultProtocolFor({ provider })` |  |
| `isStandard` | function | `function isStandard({ provider, standard } = {})` | Whether a provider speaks a given wire standard. |
| `GatewayEndpoint` | const | `const GatewayEndpoint = { PRODUCTION: '', }` | Gateway base URLs. |
| `DEFAULT_OPENROUTER_URL` | const | `const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1'` | Default OpenRouter-compatible base URL. |
| `DEFAULT_OPENAI_URL` | const | `const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1'` | Default OpenAI base URL. |
| `DEFAULT_LOCAL_URL` | const | `const DEFAULT_LOCAL_URL = 'http://localhost:1234/v1'` | Default local (LM Studio) base URL. |
| `DEFAULT_ANTHROPIC_URL` | const | `const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com'` | Default Anthropic base URL (the Messages API lives at `/v1/messages` under it). |
| `DEFAULT_OPENCODE_URL` | const | `const DEFAULT_OPENCODE_URL = 'https://opencode.ai/zen/go/v1'` | Default opencode backend base URL. |
| `ENV_FILE_RELATIVE_PATH` | const | `const ENV_FILE_RELATIVE_PATH = '../../secret.env'` | Path of the secret env file, relative to the config loader. |
| `EnvKey` | const | `const EnvKey = { JAI_TOKEN: 'JAI_TOKEN', OPENROUTER_API_KEY: 'OPENROUTER_AP …` | Canonical environment-variable names for every backend and its default model and tool-tier model. |

#### `lib/core/constants/shell-tool-lists.mjs` — Shell-tool command allow/block lists and truncation suffixes.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `SHELL_TOOL_DEFAULT_SAFE_COMMANDS` | const | `const SHELL_TOOL_DEFAULT_SAFE_COMMANDS = Object.freeze([ 'ls', 'cat', 'head', 'tail', 'wc', 'echo', ' …` | Commands that run without any approval gate. |
| `SHELL_TOOL_DEFAULT_BLOCKED_COMMANDS` | const | `const SHELL_TOOL_DEFAULT_BLOCKED_COMMANDS = Object.freeze([ 'rm', 'rmdir', 'unlink', 'shred', 'truncate' …` | Commands refused outright, even with operator approval. |
| `SHELL_TOOL_WRAPPER_COMMANDS` | const | `const SHELL_TOOL_WRAPPER_COMMANDS = Object.freeze({ nice: Object.freeze({ valueFlags: ['--adjust …` | Commands that only launch another command. |
| `SHELL_TOOL_BLOCKED_COMMAND_ARGS` | const | `const SHELL_TOOL_BLOCKED_COMMAND_ARGS = Object.freeze({ find: Object.freeze(['-exec', '-execdir', '- …` | A `find` argument that runs or deletes — or a launcher argument that carries the command as a shell string: the blocklist cannot see the command inside either, so the expression itself is treated as blocked. |
| `SHELL_TOOL_SAFE_OPTIONS` | const | `const SHELL_TOOL_SAFE_OPTIONS = Object.freeze({ // ── directory / file inspection ────────── …` | Option allowlist for the SAFE tier. |
| `SHELL_TOOL_TRUNCATION_SUFFIXES` | const | `const SHELL_TOOL_TRUNCATION_SUFFIXES = Object.freeze({ OVERFLOW: '\n...[TRUNCATED TO PREVENT TOKEN …` | Suffixes appended to truncated shell output. |

#### `lib/core/constants/standards.mjs` — Wire-standard registry.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `StandardType` | const | `const StandardType = Object.freeze({ OAI: 'oai', AAI: 'aai', GAI: 'gai', JAI: 'ja …` | Every wire standard the SDK speaks. |
| `STANDARDS` | const | `const STANDARDS = Object.freeze({ [StandardType.OAI]: { id: StandardType.OAI, …` | Descriptors keyed by StandardType value. |
| `standardDescriptorFor` | function | `function standardDescriptorFor({ standard } = {})` |  |

#### `lib/core/constants/system-message.mjs` — Default system prompt and message-merge constants.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `FALLBACK_MESSAGE` | const | `const FALLBACK_MESSAGE = { EMPTY_RESPONSE: [ "The model did not generate a response f …` | User-visible fallback messages for degenerate responses. |
| `SYSTEM_MESSAGE_MERGE_SEPARATOR` | const | `const SYSTEM_MESSAGE_MERGE_SEPARATOR = '\n\n'` | Separator between merged system-message parts. |
| `DEFAULT_SYSTEM_PROMPT` | const | `const DEFAULT_SYSTEM_PROMPT = [ '# Merci SDK Agent', '', '## 1. Identity & Operating Model …` |  |

#### `lib/core/constants/work-sources.mjs` — The Symphony §11.4 work-source category vocabulary.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WORK_SOURCE_CATEGORIES` | const | `const WORK_SOURCE_CATEGORIES = Object.freeze(/** @type {const} */ ([ 'unsupported_tracker_k …` | The Symphony §11.4 categories, in their canonical order. |

#### `lib/core/emitter.mjs` — MerciEventEmitter — a drop-in EventEmitter with glob subscriptions, priority ordering, and per-listener isolat …

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `MerciEventEmitter` | class | `class MerciEventEmitter extends EventEmitter` | Per-subscription options: higher `priority` dispatches first, `prepend` jumps the queue, `once` removes after the first dispatch. |

#### `lib/core/errors.mjs` — Typed error hierarchy for the Merci SDK.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `MerciError` | error class | `class MerciError extends Error` | Base class for every SDK-thrown error. |
| `BackendError` | error class | `class BackendError extends MerciError` | A vendor SDK / transport call failed. |
| `MemoryError` | error class | `class MemoryError extends MerciError` | A memory subsystem operation failed (L1 load/store, L2 distillation, L3 skill). |
| `ConfigurationError` | error class | `class ConfigurationError extends MerciError` | The SDK was mis-configured (missing required arg, invalid option, conflicting flags). |
| `configurationError` | function | `function configurationError({ option, message })` | The one way a caller rejects an option: a `ConfigurationError` that also names the option, so a consumer reads `error.option` instead of the message. |
| `PolicyError` | error class | `class PolicyError extends MerciError` | A `WORKFLOW.md` contract failed to load, parse, resolve, or render. |
| `AgentFileError` | error class | `class AgentFileError extends MerciError` | An agent definition file (`*.agent.yaml`) failed validation or loading. |
| `WorkspaceError` | error class | `class WorkspaceError extends MerciError` | A workspace key, path, or lifecycle operation failed. |
| `WorkSourceError` | error class | `class WorkSourceError extends MerciError` | A work source failed to list or refresh items. |
| `SchedulerError` | error class | `class SchedulerError extends MerciError` | The scheduler API was misused: a lifecycle call out of order, a reset of a running item, or an attempt to rebind an option that was fixed at construction. |
| `AbortedError` | error class | `class AbortedError extends MerciError` | The AbortSignal was triggered. |
| `BudgetExceededError` | error class | `class BudgetExceededError extends MerciError` | The run exceeded a token budget configured via `session.withBudget(...)` (or the `budget` run option). |
| `GuardrailViolationError` | error class | `class GuardrailViolationError extends MerciError` | A guardrail refused the content. |
| `MaxTurnsExceededError` | error class | `class MaxTurnsExceededError extends MerciError` | The run exhausted its tool-iteration budget without producing a final text response. |
| `AbstractMethodError` | error class | `class AbstractMethodError extends MerciError` | A subclass failed to implement an abstract method. |
| `OrchestrationError` | error class | `class OrchestrationError extends MerciError` | Base class for orchestration-control failures raised by the DAG executor, the state machine, the discussion engine, and their shared verify gates. |
| `VerificationError` | error class | `class VerificationError extends OrchestrationError` | A node/step output failed its verification or acceptance gate (deterministic criteria, judge, or a user-supplied `verify`). |
| `OrchestrationExhaustedError` | error class | `class OrchestrationExhaustedError extends OrchestrationError` | An orchestration budget/retry/liveness cap was exhausted: step retries, iteration limit, `maxSteps`, `maxVisits`, node timeout, or a run that never produced a usable final answer. |
| `GraphError` | error class | `class GraphError extends OrchestrationError` | The workflow graph is structurally unusable at runtime — a dependency cycle, an unresolved/dangling dependency, or a deadlock with no runnable step. |
| `OrchestrationFailedError` | error class | `class OrchestrationFailedError extends OrchestrationError` | The run ended with unrecovered failed steps (self-heal/replan budget spent). |
| `isAbortError` | function | `function isAbortError({ err, signal })` | Best-effort detection of an AbortSignal-triggered failure. |
| `isAbortErrorSafe` | function | `function isAbortErrorSafe({ error })` | `isAbortError`, guarded for the settle paths: a hostile `name`/`code` getter reads as "not an abort" instead of rejecting the caller's handling. |
| `wrapError` | function | `function wrapError({ err, hints = {} })` | Wraps a thrown error in the most-specific MerciError subclass based on the available hints. |

#### `lib/core/events.mjs` — Unified event layer for the Merci SDK.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `EVENTS` | const | `const EVENTS = Object.freeze({ CLIENT: Object.freeze({ API_REQUEST: 'api_re …` | Canonical event-name registry. |
| `RunContext` | class | `class RunContext` | The run context — the identity (run id, parent run) every event of a run carries. |
| `stampEvent` | function | `function stampEvent({ name, payload = {}, runContext = null })` | Standalone envelope builder for emission points outside any RunContext (parameter building, agent switching). |
| `stampStreamEvent` | function | `function stampStreamEvent({ event, runContext = null })` | Adds the additive correlation fields to an onEvent stream event ({ type, ... |
| `runWithRunContext` | function | `function runWithRunContext({ runContext = null, fn })` | Installs `runContext` as the ambient correlation context for `fn`. |
| `currentRunContext` | function | `function currentRunContext()` | The ambient RunContext of the current async execution, or null outside a run. |
| `emitEvent` | function | `function emitEvent({ emitter, name, payload = {}, runContext = null })` | The single event sink. |

#### `lib/core/hooks.mjs` — Hook registry — the "intervene" layer of the event system.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `STOP` | const | `const STOP = Symbol('merci.hooks.stop')` | The sentinel a hook returns to end a waterfall chain without changing the value. |
| `HOOKS` | const | `const HOOKS = Object.freeze({ TOOL_BEFORE: 'tool:before', TOOL_AFTER: 'too …` | Canonical hook-chain names shared by the built-in pipelines and users of `withHooks` (`hooks.add({ name: HOOKS.TOOL_BEFORE, fn })`). |
| `HookRegistry` | class | `class HookRegistry` | The hook registry — an ordered chain of async hooks that can veto or transform a value. |
| `createHooks` | function | `function createHooks()` | Creates an empty hook registry. |

#### `lib/core/lifecycle.mjs` — Phase lifecycle umbrella.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `PHASES` | const | `const PHASES = Object.freeze({ RUN: 'run', STEP: 'step', WORKFLOW: 'workflo …` | Canonical phase names. |
| `enterPhase` | function | `async function enterPhase({ ctx = {}, phase, fn })` | Runs `fn` inside a named lifecycle phase, emitting `phase:start` before and `phase:end` after. |

#### `lib/core/limit-config.mjs` — The one resolution layer for every tunable limit.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `LIMITS_CONFIG_FILE` | const | `const LIMITS_CONFIG_FILE = 'merci-limits.json'` | Default project config file, relative to `process.cwd()`. |
| `LIMITS_SWITCH_ENV` | const | `const LIMITS_SWITCH_ENV = 'MERCI_LIMITS'` | Env key of the global kill switch. |
| `LIMITS_DISABLED_ENV` | const | `const LIMITS_DISABLED_ENV = 'MERCI_LIMITS_DISABLED'` | Env key listing individually disabled limit keys. |
| `LIMITS_FILE_ENV` | const | `const LIMITS_FILE_ENV = 'MERCI_LIMITS_FILE'` | Env key pointing at a non-default config file. |
| `LIMITS_GUARD_ENV` | const | `const LIMITS_GUARD_ENV = 'MERCI_LIMITS_ALLOW_GUARD_OFF'` | Env key that lets the switch disable a `guard` limit. |
| `setLimitWarningHandler` | function | `function setLimitWarningHandler({ handler })` | Replaces the warning sink (tests and hosts that route SDK warnings). |
| `resolveLimit` | function | `function resolveLimit({ key = '' } = {})` | Resolves one limit for the current process state. |
| `LIMITS` | const | `const LIMITS = {}` | Every limit as a lazy property, so a read sees the current env, file and programmatic state. |
| `getLimits` | function | `function getLimits()` |  |
| `setLimits` | function | `function setLimits({ values = {}, disabled: nextDisabled, disabledKeys: nextDisabledKeys, allowGuardOff: nextAllowGuardOff } = {})` | Applies programmatic overrides. |
| `resetLimits` | function | `function resetLimits()` | Drops every programmatic override and the programmatic switch. |
| `reloadLimits` | function | `function reloadLimits()` | Re-reads `merci-limits.json` on the next resolution. |

#### `lib/core/loadable.mjs` — LoadableComponent — the dual-mode load/save contract + unified capability ("extension") hooks.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `LoadableComponent` | class | `class LoadableComponent` | Base class for operational capabilities (skills, memory, …) that surface a payload to the model. |

#### `lib/core/prompts.mjs` — Prompt constants barrel — re-exports ./prompts/*.mjs.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `*` | barrel | ↩ `lib/core/prompts/memory.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/prompts/conversation.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/prompts/dag.mjs` | Re-exports every symbol from the target module |
| `*` | barrel | ↩ `lib/core/prompts/sm.mjs` | Re-exports every symbol from the target module |

#### `lib/core/prompts/conversation.mjs` — Conversation-history compaction prompts.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `CONVERSATION_SUMMARY_MARKER` | const | `const CONVERSATION_SUMMARY_MARKER = '[Summarized earlier conversation]'` | Marker replacing the folded prefix in a compacted history. |
| `CONVERSATION_SUMMARY_SCHEMA` | const | `const CONVERSATION_SUMMARY_SCHEMA = z.strictObject({ summary: z.string().describe('Concise, rete …` | Zod schema for the summarizer's single-output response. |
| `CONVERSATION_SUMMARY_PROMPT` | const | `const CONVERSATION_SUMMARY_PROMPT = [ 'You are a conversation historian. The following transcrip …` | Summarizer persona: preserve goals, constraints, decisions, facts, unfinished work. |

#### `lib/core/prompts/dag.mjs` — DAG workflow planning, evaluation, and replan prompts.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `DEFAULT_DAG_HITL_TIMEOUT_MS` | const | ↩ `lib/core/constants/limits.mjs` | Default timeout (ms) for a DAG step paused on manual approval. |
| `HANDOFF_OPTION_SCHEMA` | const | `const HANDOFF_OPTION_SCHEMA = z.strictObject({ goal: z.enum(['clean', 'full', 'moderated'] …` | Shared per-step handoff option: goal/context vary independently (clean\|full\|moderated each), tools default to inherit. |
| `DAG_WORKFLOW_PLAN_SCHEMA` | const | `const DAG_WORKFLOW_PLAN_SCHEMA = dagPlanSchema({ minSteps: 2 })` | Zod schema for the initial DAG plan (min 2 steps). |
| `DAG_WORKFLOW_REPLAN_SCHEMA` | const | `const DAG_WORKFLOW_REPLAN_SCHEMA = dagPlanSchema({ minSteps: 1 })` | Replan schema — the plan schema with the step floor relaxed to one. |
| `DAG_WORKFLOW_EVAL_SCHEMA` | const | `const DAG_WORKFLOW_EVAL_SCHEMA = z.strictObject({ replanRequired: z.boolean().describe('True …` | Zod schema for per-step verification output (replan decision). |
| `DAG_WORKFLOW_PLAN_PROMPT` | function | `const DAG_WORKFLOW_PLAN_PROMPT = ({ objective, toolsList }) => => …` | Builds the initial plan-decomposition prompt. |
| `escapeUntrustedFence` | function | `const escapeUntrustedFence = ({ value }) => => …` | Escapes closing `<untrusted_*>` fence tags inside untrusted prompt interpolations. |
| `DAG_WORKFLOW_EVAL_PROMPT` | function | `const DAG_WORKFLOW_EVAL_PROMPT = ({ stepId, output, context, objective = null }) => => …` | Builds the per-step verification prompt. |
| `DAG_WORKFLOW_REPLAN_PROMPT` | function | `const DAG_WORKFLOW_REPLAN_PROMPT = ({ objective, failedStepId, failureReason, currentOutputs }) => => …` | Builds the self-healing replan prompt for a failed or drifted execution. |

#### `lib/core/prompts/memory.mjs` — Cognitive memory prompts (distillation + per-step memory block).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `COGNITIVE_MEMORY_PROMPTS` | const | `const COGNITIVE_MEMORY_PROMPTS = { SYSTEM_MEMORY_DISTILLER: (/** @type {string} */ banksInfo) …` | Memory prompt factory: the distillation system prompt (a function of the bank list) and the static block header/footer / lag-warning strings. |

#### `lib/core/prompts/sm.mjs` — StateMachine planning schema and prompt.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `SM_PLAN_SCHEMA` | const | `const SM_PLAN_SCHEMA = z.object({ summary: z.string().describe('One-sentence summar …` | Zod schema for a state machine plan — nodes/edges, cycles allowed. |
| `SM_PLAN_PROMPT` | function | `const SM_PLAN_PROMPT = ({ objective, toolsList }) => { … }` |  |

### 4.2 `messaging` — Unified message model, factories and per-backend history normalizers

#### `lib/messaging/decision.mjs` — Canonical decision envelope — the question/answer model every discriminative ("System One") wire projects onto …

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `DECISION_QUESTION_TYPE` | const | `const DECISION_QUESTION_TYPE = Object.freeze({ NOUL: 'noul', CHOICE: 'choice', SCORE: 'scor …` | The question types every decision wire recognizes. |
| `noulQuestion` | function | `function noulQuestion({ instructions = '', criteria = null } = {})` | Builds a yes/no question. |
| `choiceQuestion` | function | `function choiceQuestion({ instructions = '', criteria = {} } = {})` |  |
| `scoreQuestion` | function | `function scoreQuestion({ instructions = '', criteria = [] } = {})` |  |
| `buildDecisionRequest` | function | `function buildDecisionRequest({ model, state, questions } = {})` | Validates one request and returns it unchanged. |
| `readDecisionAnswer` | function | `function readDecisionAnswer({ answers = null, name = '', type = null } = {})` | Reads one answer from a result, refusing a missing key or a type the caller did not expect. |

#### `lib/messaging/messages.mjs` — Unified message factories and per-backend history normalizers.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `stripInjectionMeta` | function | `function stripInjectionMeta({ messages, keepNative = false })` | Returns a copy of `messages` with the non-wire keys (INJECTION_META_KEY, MERCI_ID_KEY and — unless `keepNative` — MERCI_NATIVE_KEY) removed from every message. |
| `attachNative` | function | `function attachNative({ row, provider, protocol, items })` | Attaches the provider-native replay payload to a row (non-wire; stripped by every normalizer). |
| `getNative` | function | `function getNative({ row })` | Reads a row's provider-native replay payload, or null when absent. |
| `dedupeMessages` | function | `function dedupeMessages({ messages })` | Removes duplicate rows by their stable merciId. |
| `joinSystemParts` | function | `function joinSystemParts({ acc, part })` | Merges consecutive system parts with the shared separator. |
| `isEmptyAssistantTurn` | function | `function isEmptyAssistantTurn({ m })` | True when a message is an assistant/model turn carrying no payload — such rows must never reach the wire (a trailing one is a 400 on Gemini/JAI); tool-call rows, multimodal content arrays and GAI functionCall parts are never empty turns. |
| `createUserMessage` | function | `function createUserMessage({ provider, content })` | Creates a user message in the backend's wire shape. |
| `createSystemMessage` | function | `function createSystemMessage({ provider, content })` | Creates a system message in the backend's wire shape. |
| `createAssistantMessage` | function | `function createAssistantMessage({ provider, content, thoughtSignature, reasoningContent, redactedThinking })` | Creates an assistant text message, optionally carrying a thought signature (and DeepSeek-style `reasoning_content` for multi-turn continuity). |
| `createToolCallMessage` | function | `function createToolCallMessage({ provider, id, name, args, thoughtSignature, calls })` | Creates an assistant tool-call message in the backend's wire shape. |
| `IMAGE_TOOL_RESULT_BACKENDS` | const | `const IMAGE_TOOL_RESULT_BACKENDS = new Set([ ProviderType.ANTHROPIC, ProviderType.GOOGLE_GENAI, …` | Backends whose tool-result wire can carry an image block. |
| `createToolResultMessage` | function | `function createToolResultMessage({ provider, result, thoughtSignature = null, protocol = null })` | Creates a tool result message in the target backend's wire shape. |
| `PDF_MEDIA_PROVIDERS` | const | `const PDF_MEDIA_PROVIDERS = new Set(Object.values(PROVIDERS).filter((d) => d.capabilitie …` | Backends whose wire can carry an `application/pdf` document as one inline media message: JAI (vendor media part), Gemini/Vertex (`inlineData`), Anthropic (`document` block), OpenAI (`file` part). |
| `normalizeHistory` | function | `function normalizeHistory({ provider, messages, options = {} })` | Normalizes a mixed-shape history to the backend's wire format: the JAI shape for JAI, otherwise the OAI normalizer. |
| `getToolCallName` | function | `function getToolCallName({ call })` | Reads the tool name from a tool call in any shape (OAI/JAI/GAI). |
| `getToolCallArguments` | function | `function getToolCallArguments({ call })` | Reads the tool arguments from a tool call in any shape (OAI/JAI/GAI). |
| `normalizeToAAI` | function | `function normalizeToAAI({ msgs = [] } = {})` | Centralized normalization of JAI/OAI/GAI-style messages to Anthropic format. |
| `normalizeToOAI` | function | `function normalizeToOAI({ model, msgs = [], opts = {} })` | Centralized normalization of JAI-style messages to OpenAI shape. |
| `normalizeToGAI` | function | `function normalizeToGAI({ msgs = [], effectiveThoughtSignature = null } = {})` | Centralized normalization of JAI/OAI messages to Google GenAI Content format. |

#### `lib/messaging/row-shape.mjs` — Row-shape predicates shared by the inbox, guardrails and context assembly.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `isUserRow` | function | `function isUserRow({ m })` | True when `m` is a user turn, whatever wire shape it uses. |
| `isSystemRow` | function | `function isSystemRow({ m })` | True when `m` is a system/developer row. |

#### `lib/messaging/unified-message.mjs` — Canonical UnifiedMessage typedefs + re-export surface.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createUserMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates a user message in the backend's wire shape. |
| `createSystemMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates a system message in the backend's wire shape. |
| `createAssistantMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates an assistant text message, optionally carrying a thought signature (and DeepSeek-style `reasoning_content` for multi-turn continuity). |
| `createToolCallMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates an assistant tool-call message in the backend's wire shape. |
| `createToolResultMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates a tool result message in the target backend's wire shape. |
| `normalizeHistory` | function | ↩ `lib/messaging/messages.mjs` | Normalizes a mixed-shape history to the backend's wire format: the JAI shape for JAI, otherwise the OAI normalizer. |
| `normalizeToOAI` | function | ↩ `lib/messaging/messages.mjs` | Centralized normalization of JAI-style messages to OpenAI shape. |
| `normalizeToAAI` | function | ↩ `lib/messaging/messages.mjs` | Centralized normalization of JAI/OAI/GAI-style messages to Anthropic format. |
| `normalizeToGAI` | function | ↩ `lib/messaging/messages.mjs` | Centralized normalization of JAI/OAI messages to Google GenAI Content format. |
| `stripInjectionMeta` | function | ↩ `lib/messaging/messages.mjs` | Returns a copy of `messages` with the non-wire keys (INJECTION_META_KEY, MERCI_ID_KEY and — unless `keepNative` — MERCI_NATIVE_KEY) removed from every message. |
| `attachNative` | function | ↩ `lib/messaging/messages.mjs` | Attaches the provider-native replay payload to a row (non-wire; stripped by every normalizer). |
| `getNative` | function | ↩ `lib/messaging/messages.mjs` | Reads a row's provider-native replay payload, or null when absent. |
| `dedupeMessages` | function | ↩ `lib/messaging/messages.mjs` | Removes duplicate rows by their stable merciId. |
| `isInjection` | function | `function isInjection({ m, capId })` | True when `m` is an SDK row-injection. |
| `isGenuineUserTurn` | function | `function isGenuineUserTurn({ m })` | True when `m` is a genuine user turn (not a tool-result carrier). |
| `countConversationTurns` | function | `function countConversationTurns({ messages })` | Counts genuine conversation turns (user messages), ignoring SDK row-injections and tool-result carriers (role:'tool' messages, tool_message rows, and tool_result / functionResponse content blocks). |

#### `lib/messaging/unified-parameter.mjs` — Unified `ParameterBuilder` for the Merci SDK.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `warnRefusedSpecKeys` | function | `function warnRefusedSpecKeys({ standard, spec, eventEmitter = null, model = '', provider = '' })` | Emits one `parameter_warning` per key of an object-form spec that the configured standard refuses, so `withParameters({ params })` keeps the same contract as the fluent builder (it refused these keys and never let them reach the wire). |
| `UnifiedParameterBuilder` | class | `class UnifiedParameterBuilder` | Unified `ParameterBuilder`. |
| `buildParameterMapForOai` | function | `function buildParameterMapForOai({ spec })` | Translates a unified spec to the OAI wire format. |
| `buildParameterMapForAai` | function | `function buildParameterMapForAai({ spec })` | Translates a unified spec to AAI's internal `_parameters` shape. |
| `buildParameterMapForGai` | function | `function buildParameterMapForGai({ spec })` | Translates a unified spec to GAI's internal `_parameters` shape. |
| `buildParameterMapForJai` | function | `function buildParameterMapForJai({ spec })` | Translates a unified spec to the JAI V9-keyed spec that `buildParametersV9` consumes. |

### 4.3 `backends` — Provider clients (JAI, OAI, GAI, AAI) and their protocol adapters

#### `lib/backends/aai.mjs` — Merci SDK 0.7.2 AAI (Anthropic AI)

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ChatSession` | class | `class ChatSession extends BaseChatSession` | Manages a chat session with an Anthropic LLM. |
| `MerciClient` | class | `class MerciClient extends EventEmitter` | Main Merci SDK client for Anthropic. |

#### `lib/backends/adapters/aai-adapter.mjs` — AAI (Anthropic) backend adapter.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `aaiCitation` | function | `function aaiCitation({ citation })` | Maps an Anthropic citation onto the unified citation shape (`{ uri, title, text }`). |
| `aaiAdapter` | const | `const aaiAdapter = { vendorName: 'AAI', /** * Builds the Anthropic messages req …` | AAI backend adapter — implements the shared adapter contract for the agentic loop: request building, vendor stream execution, stream consumption, and tool-call extraction / formatting. |

#### `lib/backends/adapters/adapter-common.mjs` — Shared helpers for the backend adapters (OAI / GAI / AAI / JAI).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `hasNativeLeg` | function | `function hasNativeLeg({ session, cap })` | Whether the session's search/scrape capability requested a native leg. |
| `createFirstTokenEmitter` | function | `function createFirstTokenEmitter()` | One-shot first-token prologue for a stream consumer. |
| `truncationCheck` | function | `function truncationCheck({ producedOutput, sawTerminal, sawAbort })` | Whether a stream that ended without its terminal fact was cut short. |
| `vendorCostUsd` | function | `function vendorCostUsd({ usage })` | The cost a vendor **reported** with its usage (USD), or `null` when it reported none. |
| `quotaEvent` | function | `function quotaEvent({ prompt, completion, amount, cached = null, cacheCreation = null, reasoning = null, costUsd = null })` | Builds a unified `quota` stream event. |
| `sourcesEvent` | function | `function sourcesEvent({ citations })` | Builds a unified `sources` stream event from raw vendor citations, or `null` when nothing normalizes (mirrors the `if (sources.length > 0)` guards). |
| `mergeToolsByName` | function | `function mergeToolsByName({ tools, specTools } = {})` | Merges the tools two sources declare, first-wins: every `tools` entry in order, then each `specTools` entry whose name is not already taken. |
| `hasAnyDeclaredTools` | function | `function hasAnyDeclaredTools({ tools, specTools } = {})` | Whether the step declared a tool a tool_choice would bind to: a parameter tool at all, or a session tool other than the built-in `task` delegate. |
| `toolCallIdentity` | function | `function toolCallIdentity({ call, result, fallbackId } = {})` | The display row's identity for a tool call: its own id, else the result's, else a caller fallback; the name read in any vendor shape. |
| `sessionIdOf` | function | `function sessionIdOf({ session } = {})` | The value of the vendor session header: the public session id, else the current run id. |
| `warnSession` | function | `function warnSession({ session, provider, standard, model, parameter, message })` | Emits a session parameter-warning, defaulting the provider to the adapter's own when the session carries none. |

#### `lib/backends/adapters/gai-adapter.mjs` — GAI (Google GenAI) backend adapter.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `groundingCitations` | function | `function groundingCitations({ grounding })` | Maps Gemini's `groundingMetadata` onto the unified citation shape (`{ uri, title, text }`). |
| `gaiAdapter` | const | `const gaiAdapter = { vendorName: 'GAI', /** * Builds the Gemini generateContent …` | GAI backend adapter — implements the shared adapter contract for the agentic loop: request building, vendor stream execution, stream consumption, and tool-call extraction / formatting. |

#### `lib/backends/adapters/jai-adapter.mjs` — JAI backend adapter.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `jaiAdapter` | const | `const jaiAdapter = { vendorName: 'JAI', /** * Builds the vendor stream request …` | JAI backend adapter — implements the shared adapter contract for the agentic loop: request building, vendor stream execution, stream consumption, and tool-call extraction / formatting. |

#### `lib/backends/adapters/oai-adapter.mjs` — OAI (OpenAI-compatible) backend adapter.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `DEFAULT_RESPONSES_ASSISTANT_PART` | const | `const DEFAULT_RESPONSES_ASSISTANT_PART = 'input_text'` | The Responses API assistant text part type used by default. |
| `oaiAdapter` | const | `const oaiAdapter = { vendorName: 'OAI', /** * Builds the OpenAI-compatible requ …` | OAI backend adapter — implements the shared adapter contract for the agentic loop: request building (chat completions + Responses API), vendor stream execution, stream consumption, and tool-call extraction / formatting. |

#### `lib/backends/decisions/adapters/decisions-common.mjs` — Shared helpers for the decision wire adapters.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `serializeState` | function | `function serializeState({ state })` | Wires that take text evidence (OpenAI, Gemini) need the state serialized; OpenRouter takes the object as-is. |
| `numberOrNull` | function | `function numberOrNull(value)` | A vendor number, or `null`. |
| `assertWireLimit` | function | `function assertWireLimit({ count, min, max, what, wire })` | A per-wire request cap, refused before the call instead of by a 400. |
| `readKeyedAnswer` | function | `function readKeyedAnswer({ name, answer })` | Normalizes one answer of a keyed response (`questions` is an object keyed by name, which OpenRouter, TypeSafe and Gemini all return). |

#### `lib/backends/decisions/adapters/gemini.mjs` — Gemini Decisions wire adapter — `POST /v1beta/decisions`.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `geminiDecisionsAdapter` | const | `const geminiDecisionsAdapter = { id: 'google_genai', defaultBaseURL: 'https://generativelan …` |  |

#### `lib/backends/decisions/adapters/keyed.mjs` — Keyed decision wire adapter — OpenRouter `POST /api/alpha/decisions`.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `openrouterDecisionsAdapter` | const | `const openrouterDecisionsAdapter = { id: 'openrouter', defaultBaseURL: 'https://openrouter.ai/a …` |  |
| `opencodeDecisionsAdapter` | const | `const opencodeDecisionsAdapter = { id: 'opencode', defaultBaseURL: 'https://opencode.ai/zen/v …` | OpenCode sells the same keyed wire on its own path (`/zen/v1/systemone`, Console: `/inference/systemone/v1/systemone`) with `jev-1.13`, `jev-1.13-free`, `gpt-6-luna-decision` and `gemini-decision-1`. |

#### `lib/backends/decisions/adapters/openai.mjs` — OpenAI Decisions wire adapter — `POST /v1/decisions`.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `openaiDecisionsAdapter` | const | `const openaiDecisionsAdapter = { id: 'openai', defaultBaseURL: 'https://api.openai.com/v1', …` |  |

#### `lib/backends/decisions/client.mjs` — createDecisionsClient — the stateless judgment surface.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createDecisionsClient` | function | `function createDecisionsClient({ provider, apiKey, baseURL = null, defaultHeaders = null, fetchImpl = undefined, timeoutMs = undefined, emitter = null })` | Creates the decision client for one provider. |

#### `lib/backends/decisions/index.mjs` — Public surface of the decision (System One) client.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createDecisionsClient` | function | ↩ `lib/backends/decisions/client.mjs` | Creates the decision client for one provider. |

#### `lib/backends/gai.mjs` — Merci SDK 0.7.2 GAI (Google GenAI)

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ChatSession` | class | `class ChatSession extends BaseChatSession` | Manages a chat session with an LLM. |
| `MerciClient` | class | `class MerciClient extends EventEmitter` | Main Merci SDK client for Google GenAI. |

#### `lib/backends/jai-vendor/api.mjs` — JAI Task V5 API + quota API clients.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `TaskAPI` | class | `class TaskAPI` | JAI Task V5 API — task roster and streamed task execution. |
| `QuotaAPI` | class | `class QuotaAPI` | JAI quota API — the account's credit snapshot (`/quota/get`). |

#### `lib/backends/jai-vendor/chat-session.mjs` — JAI vendor chat session (standalone transport).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ChatSession` | class | `class ChatSession extends AbstractChatSession` | Wire-level JAI chat session used by the JAI adapter and the agentic client. |

#### `lib/backends/jai-vendor/client.mjs` — JAI vendor transport client.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `MerciClient` | class | `class MerciClient extends EventEmitter` | JAI vendor transport client — assembles the HTTP client, profile manager, task API, and quota API around a single event emitter. |

#### `lib/backends/jai-vendor/http-client.mjs` — JAI HTTP transport client.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `sleepAbortable` | function | ↩ `lib/support/retry-policy.mjs` | when `signal` fires (checked synchronously for pre-aborted signals). |
| `headerTimeoutMs` | function | `function headerTimeoutMs()` | Resolves the effective header timeout: `JAI_HEADER_TIMEOUT_MS` from secret.env when set to a positive number, otherwise the 600s default. |
| `connectTimeoutMs` | function | `function connectTimeoutMs()` | Resolves the effective control-plane connect timeout: `JAI_CONNECT_TIMEOUT_MS` from secret.env when set to a positive number, otherwise the 30s default. |
| `jwtExpiresAt` | function | `function jwtExpiresAt({ token })` | Decodes the `exp` claim (ms epoch) from a JWT. |
| `retryDelayMs` | function | `function retryDelayMs({ retryAfter, fallbackMs })` | Resolves a Retry-After header (seconds or HTTP-date) into a bounded delay. |
| `InternalHttpClient` | class | `class InternalHttpClient` | JAI gateway HTTP client — authenticated fetch with proactive/reactive token refresh, retry policies, redacted telemetry, and header/body timeouts. |

#### `lib/backends/jai-vendor/messages.mjs` — JAI wire message shaping and media message creation.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `formatJaiMessages` | function | `function formatJaiMessages({ messages })` | Shapes unified messages onto the JAI wire format. |
| `createMediaMessage` | function | `async function createMediaMessage({ source, explicitMimeType })` | Builds a base64 media message from a file path or Buffer. |

#### `lib/backends/jai-vendor/profiles.mjs` — JAI model profile registry.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `declaresParam` | function | `function declaresParam({ params, key })` | True when the profile's declared params include `key` (prefix or suffix match on dotted paths). |
| `ProfileManager` | class | `class ProfileManager` | Cached JAI model profile registry. |

#### `lib/backends/jai-vendor/sse-parser.mjs` — JAI SSE stream parsers.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `readSSELines` | function | `async function* readSSELines({ stream, parser })` | Splits an SSE stream on newlines and yields parsed events. |
| `SSEParser` | class | `class SSEParser` | Parses chat V9 / responses V9 SSE lines into unified events, assembling parallel tool calls and capturing thought signatures. |
| `TaskSSEParserV5` | class | `class TaskSSEParserV5` | Parses Task V5 SSE lines into task events, capturing thought signatures. |

#### `lib/backends/jai-vendor/types.mjs` — JAI wire types: parameter keys, SSE event shapes, and error hierarchy.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `LLMParameters` | const | `const LLMParameters = { TEMPERATURE: { key: 'temperature', type: 'number' }, TOP_P …` |  |
| `APIError` | error class | `class APIError extends BackendError` | Base error for JAI transport failures. |
| `APIStatusError` | error class | `class APIStatusError extends APIError` | A JAI gateway request failed with a non-2xx status. |
| `SSEError` | error class | `class SSEError extends APIError` | An SSE stream was malformed or corrupted. |

#### `lib/backends/jai.mjs` — Agentic annex for the JAI transport.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ChatSession` | class | `class ChatSession extends BaseChatSession` | Agentic chat session with automatic tool execution support. |
| `MerciClient` | class | `class MerciClient extends BaseMerciClient` | Main Agentic Merci SDK client for JAI transport. |

#### `lib/backends/media.mjs` — Backend media-message factory — per-backend image/PDF user turns.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createUnifiedMediaMessages` | function | `async function createUnifiedMediaMessages({ provider, prompt, imagePath })` | Creates a user turn carrying an image or PDF plus a prompt, per-backend shaped (JAI shapes it natively; GAI/AAI/OAI embed base64 data — a PDF becomes an Anthropic `document` block / an OpenAI `file` part). |

#### `lib/backends/oai.mjs` — Merci SDK 0.7.2 OAI

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ChatSession` | class | `class ChatSession extends BaseChatSession` | Manages a chat session with an LLM. |
| `MerciClient` | class | `class MerciClient extends EventEmitter` | Main Merci SDK client. |

#### `lib/backends/transport/aai-client.mjs` — Anthropic wire client rebuilt on the native fetch transport.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createAaiTransport` | function | `function createAaiTransport({ apiKey, baseURL, defaultHeaders, fetch: fetchImpl, timeoutMs, maxRetries = 0 })` | Creates the Anthropic transport. |

#### `lib/backends/transport/abort.mjs` — Abort classification shared by the native OAI transport.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `isAbortFailure` | function | `function isAbortFailure({ error, signal })` | Whether a failure is the caller's abort surfacing, not an unrelated error that happened while the signal was already aborted. |

#### `lib/backends/transport/errors.mjs` — Error factories for the shared fetch transport.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `buildApiError` | function | `function buildApiError({ status, headers, errorField, text })` | Assembles the error the SDK's `APIError` constructor produced, own properties included. |
| `createApiErrorFromBody` | function | `function createApiErrorFromBody({ status, headers, body, text } = {})` | Builds the API error a non-2xx response produced: `makeStatusError` wraps a parsed body that has no `error` field as `{ error: body }`, then `APIError` reads `error`, `code`, `type` and `param` from that field. |
| `createStreamApiError` | function | `function createStreamApiError({ error, headers } = {})` | Builds the error a stream error chunk raised, exactly as `new APIError(undefined, data?.error ?? |
| `createAnthropicApiError` | function | `function createAnthropicApiError({ status, headers, body, text, type } = {})` | Builds the error `@anthropic-ai/sdk@1.5.0`'s `APIError` constructor produced: the message from the whole body (a text body is the message, an empty one is `'<status> status code (no body)'`), and the Anthropic-only own properties `apiMessage`, `type`, `errorCode` and `details`. |
| `createGoogleApiError` | function | `function createGoogleApiError({ status, statusText, body, text, message, headers } = {})` | Builds the error `@google/genai@2.32.0`'s `ApiError` produced: `name` `'ApiError'`, the status, and the whole body as JSON in the message. |
| `createConnectionError` | function | `function createConnectionError({ cause } = {})` | Builds the error for a failed `fetch` (DNS, refused connection, reset). |
| `createAbortError` | function | `function createAbortError({ cause } = {})` | Builds the error for a caller abort. |
| `createRedirectRefusedError` | function | `function createRedirectRefusedError({ location, requestUrl } = {})` | Builds the error a 3xx response raises: model calls never follow a redirect, because the request body and header credentials would reach the target origin. |
| `createTimeoutError` | function | `function createTimeoutError()` | Builds the error for the request deadline elapsing before the response headers (or, for a non-streaming call, its body) arrived. |

#### `lib/backends/transport/gai-client.mjs` — Native Gemini/Vertex wire client rebuilt on the shared fetch transport.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `gaiBaseURL` | function | `function gaiBaseURL({ vertexai = false, location = 'global' } = {})` | The root a call uses when no `baseURL` override was passed: the Gemini Developer API, or the Vertex host the SDK derives from the location. |
| `createGaiTransport` | function | `function createGaiTransport({ apiKey, auth, vertexai = false, project, location = 'global', apiVersion, baseURL, defaultHeaders, fetch: fetchImpl = globalThis.fetch, timeoutMs, maxRetries = 0, } = {})` | Builds the native Gemini/Vertex connector: URL, headers, body mapping and the SSE decoder for the four model calls the GAI adapter consumes. |

#### `lib/backends/transport/gai-constants.mjs` — The Gemini tool-config enum the GAI adapter emits.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `FunctionCallingConfigMode` | const | `const FunctionCallingConfigMode = Object.freeze({ MODE_UNSPECIFIED: 'MODE_UNSPECIFIED', AUTO: …` | The `toolConfig.functionCallingConfig.mode` values Gemini accepts. |

#### `lib/backends/transport/google-auth.mjs` — Native Google credential flow (ADC) for the Gemini/Vertex connector.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createGoogleAuth` | function | `function createGoogleAuth({ credentials, keyFile, scopes, fetch: fetchImpl = globalThis.fetch, now = Date.now, } = {})` | Resolves Google application-default credentials on first use and exchanges them for an access token, cached per instance. |

#### `lib/backends/transport/http.mjs` — Native fetch transport for the shared fetch/SSE layer the OAI, Anthropic and Google connectors use.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `defaultRequestTimeoutMs` | function | `function defaultRequestTimeoutMs()` | The first-headers (connect + headers) deadline, not an inactivity timer, read per request so `setLimits()` takes effect. |
| `joinUrl` | function | `function joinUrl({ baseURL, path })` | Joins a base URL and an API path with exactly one slash between them, keeping a query the base URL carries. |
| `buildHeaders` | function | ``function buildHeaders({ apiKey, auth, defaultHeaders, headers, json = true, accept = 'application/json', userAgent = `merci-sdk/${SDK_VERSION}`, sdkHeaders } = {})`` | Builds the request headers: bearer auth (or the vendor's `auth` header), JSON content type (POST only), accept, this SDK's user agent, then any `sdkHeaders`, then the client's default headers, then the per-call headers (last wins). |
| `postJson` | function | `async function postJson({ url, apiKey, auth, body, defaultHeaders, headers, accept, userAgent, sdkHeaders, signal, fetchImpl, timeoutMs, errorFactory })` | Posts a JSON body and returns the parsed answer. |
| `getJson` | function | `async function getJson({ url, apiKey, auth, defaultHeaders, headers, accept, userAgent, sdkHeaders, signal, fetchImpl, timeoutMs, errorFactory })` | Performs a GET and returns the parsed answer. |
| `postStream` | function | `async function postStream({ url, apiKey, auth, body, defaultHeaders, headers, accept, userAgent, sdkHeaders, signal, fetchImpl, timeoutMs, raw = false, errorFactory })` | Posts a JSON body and returns the streaming response after the status check. |

#### `lib/backends/transport/oai-client.mjs` — OAI wire client rebuilt on the native fetch transport.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createOaiTransport` | function | `function createOaiTransport({ apiKey, baseURL, defaultHeaders, fetch: fetchImpl, timeoutMs, maxRetries = 0 })` | Creates the OAI transport. |

#### `lib/backends/transport/options.mjs` — The `transportOptions` validator every native connector shares.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `readTransportOptions` | function | `function readTransportOptions({ value } = {})` | Validates `options.transportOptions`. |

#### `lib/backends/transport/sse.mjs` — Strict server-sent-event reader for the shared fetch/SSE layer the OAI, Anthropic and Google connectors use.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `sseLineTooLong` | function | `function sseLineTooLong({ maxBytes })` | The non-retryable failure for a frame above the `sse_max_line_bytes` cap: the stream is unusable, so a retry would replay the same bytes. |
| `iterateSseEvents` | function | `async function* iterateSseEvents({ stream, cleanup, trace = null })` | Reads server-sent events from a response body. |
| `iterateSseJson` | function | `async function* iterateSseJson({ stream, signal, headers, cleanup, state, doneSentinel = DONE_SENTINEL, isErrorPayload, toError })` | Reads server-sent events and yields their parsed JSON payloads. |

#### `lib/backends/transport/stream.mjs` — Streaming helpers shared by the transport clients.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `singleUse` | function | `function singleUse({ source, state })` | Wraps a stream so it can be consumed once: a second `for await` throws instead of silently yielding nothing. |
| `isStreamIterable` | function | `function isStreamIterable({ value })` | Whether a transport answer is the single-use iterable a JSON gateway reply is wrapped into, rather than the streaming `Response`. |
| `readBodyPrefix` | function | `async function readBodyPrefix({ response, width = 120 })` | Reads at most `width` characters of a response body so a non-SSE page can be named in an error without buffering or yielding the whole page. |
| `nonJsonStreamError` | function | `function nonJsonStreamError({ mediaType, prefix = '' })` | A 2xx stream request answered with something that is not an event stream (a login page, a WAF block, a JSON gateway error). |
| `requireStreamFrames` | function | `async function* requireStreamFrames({ source, mediaType, state = {} })` | Fails a stream that ended after zero frames with no protocol terminal marker and no abort: a 2xx answered with a proxy page, a bodiless gateway reply, or a JSON envelope with no `error`. |

### 4.4 `support` — Cross-cutting utilities: retry, timeouts, JSON, logger, limits

#### `lib/support/api-observer.mjs` — Pluggable API-call observers.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `EventEmitterApiObserver` | class | `class EventEmitterApiObserver` | The default ApiObserver: emits `api_request` and `api_response` on the session's `EventEmitter` and re-throws / re-emits the error via the `error` event. |
| `CompositeApiObserver` | class | `class CompositeApiObserver` | Fans one API-call notification out to several observers. |

#### `lib/support/body.mjs` — body — the bounded response-body reader the transports share.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `readBodyTextCapped` | function | `async function readBodyTextCapped({ response, maxBytes })` | Reads a response body as text up to `maxBytes`, cancelling the rest. |
| `readBodyTextCappedResult` | function | `async function readBodyTextCappedResult({ response, maxBytes })` | The same read, reporting whether the body was actually cut. |

#### `lib/support/cassette.mjs` — Cassette — record a session's vendor calls once, replay them offline.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `CASSETTE_MODES` | const | `const CASSETTE_MODES = Object.freeze(['record', 'replay'])` | The cassette modes. |
| `CASSETTE_VERSION` | const | `const CASSETTE_VERSION = 1` | The on-disk format version. |
| `cassetteKey` | function | `function cassetteKey({ request })` | The cassette key of a vendor request. |
| `createCassette` | function | `function createCassette({ path = null, script = null } = {})` | Creates a cassette. |

#### `lib/support/child-env.mjs` — The environment a child process may inherit.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `safeChildEnv` | function | `function safeChildEnv()` | The environment a child process may inherit. |

#### `lib/support/data-url.mjs` — data-url — the base64 data-URL parse and encode the wire layers share.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `parseBase64DataUrl` | function | `function parseBase64DataUrl({ url })` | The media type and payload of a base64 data URL, or `null` when the URL is not one (a remote URL, a non-base64 data URL, an empty payload). |
| `toBase64DataUrl` | function | `function toBase64DataUrl({ mimeType, data })` | The base64 data URL for a media type and payload. |

#### `lib/support/event-logger.mjs` — Event→logger bridges — turn the SDK's observe surfaces into log lines.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `canonicalEventNames` | function | `function canonicalEventNames()` | Every unique canonical event name in the `EVENTS` registry. |
| `attachEventLogger` | function | `function attachEventLogger({ emitter, log = defaultLog, level = 'debug', filter = null } = {})` | Subscribes a catch-all logger to an emitter. |
| `createStreamLogger` | function | `function createStreamLogger({ log = defaultLog, level = 'debug', ignore = ['text', 'thought'] } = {})` | Returns an `onEvent` handler for the agentic step stream that logs every event except those already rendered (`text`, `thought`). |

#### `lib/support/fs-store.mjs` — fs-store — the single durable-JSON file primitive.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `writeJsonAtomic` | function | `async function writeJsonAtomic({ filePath, data, encoding = DEFAULT_UTF8_ENCODING })` | Atomically writes `data` as 2-space JSON: a pid/uuid tmp sibling, then a rename. |
| `writeJsonAtomicSync` | function | `function writeJsonAtomicSync({ filePath, data, encoding = DEFAULT_UTF8_ENCODING })` | Synchronous `writeJsonAtomic`, for a caller whose own API is synchronous. |
| `readStoredJsonSync` | function | `function readStoredJsonSync({ filePath, encoding = DEFAULT_UTF8_ENCODING })` | The synchronous read half of a durable-JSON file: `readFileSync` + `JSON.parse` with the missing file and the parse failure reported as a status instead of a throw. |
| `quarantineFile` | function | `async function quarantineFile({ filePath, reason, onQuarantine = null })` | Moves a corrupt file aside to a timestamped `.corrupt-` sibling so its bytes are preserved, then reports the outcome. |
| `readStoredJson` | function | `async function readStoredJson({ filePath, schema = null, version = null, encoding = DEFAULT_UTF8_ENCODING })` | Reads and validates a durable JSON file. |

#### `lib/support/json.mjs` — A robust utility for handling structured JSON output from LLMs.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `isZodSchema` | function | `function isZodSchema({ schema })` | working when zod is resolved to more than one copy. |
| `zodSchemaToJsonSchema` | function | `function zodSchemaToJsonSchema({ zodSchema })` | Returns `null` when the argument is not a Zod schema, or is Zod v3 — v4's converter cannot read a v3 instance (it throws), so callers must warn instead of sending a broken schema. |
| `findWireHostileKeywords` | function | `function findWireHostileKeywords({ node, found = new Set() })` | and a union `type` array (`{ type: ['string','null'] }`) — zod emits that form for `.nullable()` and primitive unions, and it is as wire-hostile as `anyOf`. |
| `guardedParse` | function | `function guardedParse({ input, schema, options = {} })` | Parses a payload against a schema (JSON Schema or Zod), repairing it when it is nearly valid. |
| `validateStrict` | function | `function validateStrict({ input, schema })` | Same result contract, except a malformed payload is never repaired: it fails with `"Failed to parse JSON structure"` and `originalValid === false`. |
| `validateValue` | function | `function validateValue({ value, schema })` | Validates an **already parsed** value against a JSON Schema without touching it. |
| `toWireToolParameters` | function | `function toWireToolParameters({ tool, onWarn })` | plain JSON Schema, and an unconvertible (Zod v3) one is emptied rather than leaked. |
| `extractAndParseJson` | function | `function extractAndParseJson({ input, schema })` | (from first '{' or '[' to its MATCHING close) to bypass markdown code blocks, backticks, or conversational text, and runs it through guardedParse. |

#### `lib/support/limiter.mjs` — Concurrency limiter (semaphore) for fan-out calls.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createLimiter` | function | `function createLimiter({ maxConcurrent = LIMITS.limiter_max_concurrent, minDelayMs = LIMITS.limiter_min_delay_ms, shouldDelay = null } = {})` | Creates a limiter. |
| `runBatch` | function | `async function runBatch({ items, worker, maxConcurrent = LIMITS.limiter_max_concurrent, minDelayMs = LIMITS.limiter_min_delay_ms, retryPolicy = null, signal, stopOnError = false, maxTotalTokens = null, usageOf = null })` | per-item retry, returning an index-aligned array of settled outcomes in INPUT order (independent of completion order): `[{status:'fulfilled', value} \| {status:'rejected', reason}]`. |

#### `lib/support/logger.mjs` — Pretty console logger — the SDK's single logging vocabulary.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `Logger` | class | `class Logger` | Pretty-printing console logger. |
| `log` | const | `const log = new Logger()` | The shared logger singleton. |

#### `lib/support/mime.mjs` — mime — the media type for a file path.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `mimeTypeForPath` | function | `function mimeTypeForPath({ path, fallback = 'application/octet-stream', extra = null })` | The media type for a path, from its lowercased extension. |

#### `lib/support/object.mjs` — object — the record coercion the transports share.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `asRecord` | function | `function asRecord({ value })` | The value as a keyed record, or `null` when it is not a non-null, non-array object. |

#### `lib/support/options.mjs` — options — the closed-key options reader.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `readClosedOptions` | function | `function readClosedOptions({ value, allowed, name, label = name })` | Reads a closed-key options object. |

#### `lib/support/otel-exporter.mjs` — OTLP exporter — the SDK event stream as OpenTelemetry spans.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `otelAttribute` | function | `function otelAttribute({ key, value })` | Encodes one OTLP attribute. |
| `createOtlpExporter` | function | `function createOtlpExporter({ endpoint = 'http://localhost:4318/v1/traces', serviceName = 'merci-sdk', serviceVersion = '', headers = {}, batchSize = LIMITS.otel_batch_size, flushIntervalMs = LIMITS.otel_flush_interval_ms, resourceAttributes = {}, fetchImpl = globalThis.fetch } = {})` | Creates an OTLP/HTTP JSON exporter for the SDK event stream. |

#### `lib/support/path-safety.mjs` — Path containment shared by every boundary that accepts a path.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `isInsideRoot` | function | `function isInsideRoot({ root, path })` | True when `path` is `root` itself or sits below it. |

#### `lib/support/redact.mjs` — The two redaction helpers every sink shares.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `redactUrl` | function | `function redactUrl({ url })` | The origin of a URL. |
| `scrubSecrets` | function | `function scrubSecrets({ text })` | Removes the credential shapes that can hide inside a free-text value. |

#### `lib/support/retry-policy.mjs` — Pluggable retry policies for SDK API calls.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `HEADER_TIMEOUT_CODE` | const | `const HEADER_TIMEOUT_CODE = 'HEADER_TIMEOUT'` | Machine-readable code carried by header-timeout abort errors (JAI gateway accepted the connection but sent no response headers in time). |
| `BODY_TIMEOUT_CODE` | const | `const BODY_TIMEOUT_CODE = 'BODY_TIMEOUT'` | Machine-readable code for response-body stalls (headers arrived, body dripped). |
| `NoRetryPolicy` | class | `class NoRetryPolicy` | A retry policy that never retries. |
| `retryAfterFromError` | function | `function retryAfterFromError({ error })` | `retry-after-ms` headers (walking the `cause` chain). |
| `rateLimitDelayFromError` | function | `function rateLimitDelayFromError({ error, status })` | The vendor's rate-limit hint for a failed call, in milliseconds, or null when the error carries none. |
| `ExponentialBackoffPolicy` | class | `class ExponentialBackoffPolicy` | A retry policy that retries on transient errors (connection, rate limit, timeout, HTTP 408, 409, 429 and >= 500) with capped exponential backoff and full jitter (AWS Architecture Blog: sleep = random(0, min(cap, base*2^attempt))). |
| `embedRetryPolicyFrom` | function | `function embedRetryPolicyFrom({ options = {} } = {})` | The `embed()` retry policy every embedding-capable client shares: the caller's own `embedRetryPolicy`, else the `embed_max_retries` / `embed_initial_delay_ms` / `embed_max_delay_ms` budget with a 1s jitter window. |
| `createStreamingRetryPolicy` | function | `function createStreamingRetryPolicy({ overrides = {} } = {})` | 30s, 2 retries — matching the OpenAI/Anthropic default). |
| `BREAKER_OPEN_CODE` | const | `const BREAKER_OPEN_CODE = 'BREAKER_OPEN'` | Machine-readable code for fail-fast rejections while a circuit breaker is open (never retried — the whole point is to stop calling). |
| `EMPTY_OUTPUT_CODE` | const | `const EMPTY_OUTPUT_CODE = 'EMPTY_OUTPUT'` |  |
| `isTransientError` | function | `function isTransientError({ error })` | predicate): true when a fresh default-policy instance would retry the error on attempt 0. |
| `hasTimeoutCode` | function | `function hasTimeoutCode({ error })` | timeout code (`TIMEOUT_CODES`: HEADER_TIMEOUT, BODY_TIMEOUT, STEP_TIMEOUT, STREAM_TIMEOUT, plus the host spellings ETIMEDOUT, TIMEOUT, timeout) — the structural contract that replaces message-substring matching. |
| `isNonRetryable` | function | `function isNonRetryable({ error })` | True when the error must not be retried at any layer: the caller, transport or a spent attempt budget flagged it `nonRetryable` (e.g. |
| `sleepAbortable` | function | `function sleepAbortable({ ms, signal })` | when `signal` fires (checked synchronously for pre-aborted signals). |
| `runWithRetry` | function | `async function runWithRetry({ operation, policy, signal = null, maxElapsedMs = LIMITS.max_elapsed_ms, onRetry = null, vendorName = null })` | gives up. |
| `CircuitBreaker` | class | `class CircuitBreaker` | Consecutive-failure circuit breaker with half-open probing. |
| `circuitKey` | function | `function circuitKey({ provider, model } = {})` | The breaker name for a backend/model pair. |
| `getCircuitBreaker` | function | `function getCircuitBreaker({ client, key, options })` | backend/model (or any caller key). |
| `runGuardedStep` | function | `async function runGuardedStep({ breaker = null, signal = null, run, onBreakerOpen, onFailure })` | Runs `run` behind `breaker`, recording shared backend health. |
| `runVendorCallWithRetry` | function | `async function runVendorCallWithRetry({ operation, session, vendorName = null, signal = null })` | Runs a vendor call under the session's retry policy — the shared entry point for the backend adapters' `executeVendorRequest` (OAI / AAI / GAI). |

#### `lib/support/run-command.mjs` — Bounded child-process runner for the tools layer.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `RUN_COMMAND_TIMEOUT_CODE` | const | `const RUN_COMMAND_TIMEOUT_CODE = 'CMD_TIMEOUT'` | Error `.code` carried by the rejection when a command hits `timeoutMs` (CMD_TIMEOUT). |
| `runCommand` | function | `function runCommand({ command, args = [], signal = null, timeoutMs = 0, maxBuffer = LIMITS.run_command_max_buffer_bytes, spawn = nodeSpawn, cwd, env = null, inheritEnv = false })` | Always resolves with `{ code, stdout, stderr }` — even on non-zero exit — plus `truncated` when the `maxBuffer` cap fired. |
| `runPipeline` | function | `function runPipeline({ stages = [], signal = null, timeoutMs = 0, maxBuffer = LIMITS.run_command_max_buffer_bytes, spawn = nodeSpawn, cwd, env = null, inheritEnv = false })` | Run stages connected through stdout → stdin, like a shell pipeline but with no shell: every stage is an argv array, so `\|`, `>` and `$()` still never reach a process. |

#### `lib/support/stream-timeout.mjs` — Pluggable stream timeout policies.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `InactivityTimeoutPolicy` | class | `class InactivityTimeoutPolicy` | Sliding-window inactivity timeout. |

#### `lib/support/utils.mjs` — Shared SDK support helpers.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `envFilePath` | function | `function envFilePath()` | The `secret.env` this process reads. |
| `persistEnvFilePath` | function | `function persistEnvFilePath()` | The file the SDK may *write* a refreshed token into. |
| `ensureEnvLoaded` | function | `function ensureEnvLoaded()` | Ensures secret.env has been merged into process.env. |
| `resolveProtocol` | function | `function resolveProtocol({ provider, protocol, session = false })` |  |
| `resolveBaseUrl` | function | `function resolveBaseUrl({ explicit, envKey = null, fallback = null, optionName = 'baseURL' } = {})` | Resolves a provider endpoint for every entry point (`initializeClient`, `loadCredentials`, direct client construction). |
| `resolveTieredBaseUrl` | function | `function resolveTieredBaseUrl({ explicit, descriptor })` | Resolves a descriptor's endpoint, including its named tiers (opencode: `OPENCODE_TIER=zen`). |
| `protocolFromEnv` | function | `function protocolFromEnv({ provider })` | backend; the historical OPENAI_PROTOCOL stays an OPENAI-scoped override. |
| `getEmbeddingModel` | function | `function getEmbeddingModel({ provider })` | Resolves the embedding model for a backend from secret.env. |
| `getDecisionModel` | function | `function getDecisionModel({ provider })` | Resolves the decision (System One) model for a backend from secret.env. |
| `getDefaultModel` | function | `function getDefaultModel({ provider })` | The default model id of a backend — the tier the orchestrator and the judges run on. |
| `getToolModel` | function | `function getToolModel({ provider })` | The default tool model id of a backend — the cheap tier the subagents run on. |
| `resolveRole` | function | `function resolveRole({ role })` | Resolves one client role to a provider and model. |
| `CLIENT_VIEW_BASE` | const | `const CLIENT_VIEW_BASE = Symbol('merci.clientViewBase')` | A derived client view (`Object.create`) names the client whose identity-keyed state — spawn registry, circuit breakers — it shares. |
| `baseClientOf` | function | `function baseClientOf({ client } = {})` | The client a view chain bottoms out at. |
| `getEmbeddingDimensions` | function | `function getEmbeddingDimensions({ provider })` | Resolves the JAI embedding output dimensionality from `DEFAULT_JAI_EMBEDDING_DIMENSIONS`, defaulting to 1024. |
| `configureSdkLog` | function | `function configureSdkLog({ extended = false, quiet = false, level, format, colors } = {})` | Configures the SDK logger. |
| `sdkLog` | function | `function sdkLog({ prefix, args = [] })` |  |
| `sdkWarn` | function | `function sdkWarn({ prefix, args = [] })` |  |
| `sdkError` | function | `function sdkError({ prefix, args = [] })` |  |
| `log` | const | ↩ `lib/support/logger.mjs` | The shared logger singleton. |
| `safeStringify` | function | `function safeStringify({ value })` | references (a node that returns the context itself); a plain stringify throws mid-run. |
| `strictStringify` | function | `function strictStringify({ value })` | The strict twin of `safeStringify`: same circular handling, but exceeding `safe_stringify_max_nodes` throws instead of substituting `"[truncated]"`. |
| `truncateForPrompt` | function | `function truncateForPrompt({ text, maxChars })` | data loss from the model). |
| `estimateTokens` | function | `function estimateTokens({ text })` | truncation decisions. |
| `estimateMessageTokens` | function | `function estimateMessageTokens({ messages })` | `estimateTokens` reads only `content ?? |
| `cosineSimilarity` | function | `function cosineSimilarity({ a, b })` | (never NaN) so vector-retrieval fallback tiers can rely on the result. |
| `loadCredentials` | function | `function loadCredentials({ provider })` | Reads a backend's credentials from the environment into the options `initializeClient` expects. |
| `getErrorStatus` | function | `function getErrorStatus({ error })` | the backend used (`status` / `statusCode`). |
| `isProcessAlive` | function | `function isProcessAlive({ pid })` | False only when the process is known to be gone. |
| `isEmbeddingUnsupportedStatus` | function | `function isEmbeddingUnsupportedStatus({ status, message = '' })` | or a 404 that answered with an HTML page (a gateway with no embeddings route, e.g. |
| `grpcToHttpStatus` | function | `function grpcToHttpStatus({ code })` | statuses (NOT_FOUND → 404, UNIMPLEMENTED → 501); anything else maps to null (a genuine failure). |
| `mapProfileListError` | function | `function mapProfileListError({ error })` | BackendError. |
| `emitParameterWarning` | function | `function emitParameterWarning({ emitter, model = '', parameter, message, provider = '', standard = '' })` | envelope). |
| `canonicalJson` | function | `function canonicalJson({ value, plainOnly = false, omitKeys = null, strict = false })` | Deterministic JSON with sorted object keys: logically identical values always serialize alike (the journal's idempotency keys, the cassette's request keys). |
| `requestHostAllowed` | function | `function requestHostAllowed({ req, allowedHosts = ['localhost', '127.0.0.1', '::1'], allowAnyHost = false })` | True when a request's Host header names an allowed host. |

#### `lib/support/validation.mjs` — validation — the shape predicates and the named-string assertion.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `isObjectLike` | function | `function isObjectLike(value)` | Any non-null object, arrays included. |
| `isRecordObject` | function | `function isRecordObject(value)` | A non-null, non-array object: the shape a keyed record has. |
| `isPlainObject` | function | `function isPlainObject(value)` | A record whose prototype is `Object.prototype` or `null`, so a class instance, a Map and a Date are excluded. |
| `assertNonEmptyString` | function | `function assertNonEmptyString({ value, name })` | An empty or non-string value can never identify an owner, an item or a stored record, so it is a caller bug rather than data to normalize. |

#### `lib/support/yaml-mapping.mjs` — Safe YAML mapping parse shared by the workflow and agent loaders.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `parseYamlMapping` | function | `function parseYamlMapping({ text, path = null, maxAlias = LIMITS.workflow_alias_max } = {})` | Parses one YAML text into a mapping. |

### 4.5 `tools` — Tool system: execution, MCP client/server, A2A, shell, skills, context tools

#### `lib/tools/a2a-dialect.mjs` — A2A (Agent-to-Agent) wire vocabulary.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `LEGACY_METHODS` | const | `const LEGACY_METHODS = { [A2A_METHODS.SEND_MESSAGE]: 'message/send', [A2A_METHODS.S …` | Method names accepted per dialect. |
| `V1_METHODS` | const | `const V1_METHODS = { [A2A_METHODS.SEND_MESSAGE]: 'SendMessage', [A2A_METHODS.ST …` |  |
| `A2A_RPC_METHODS` | const | `const A2A_RPC_METHODS = { v1: V1_METHODS, legacy: LEGACY_METHODS }` | The method table of each dialect, keyed by the `A2A_METHODS` operation name. |
| `resolveDialect` | function | `function resolveDialect({ method })` | Reads the dialect and operation a request's method name asks for. |
| `partText` | function | `function partText({ part })` | Extracts the text of a message part in either dialect. |
| `messageText` | function | `function messageText({ message })` | Concatenates the text of every part of a message. |
| `canonicalState` | function | `function canonicalState({ rawState })` | Maps a wire task state to its canonical v1.0 name. |
| `legacyState` | function | `function legacyState({ state })` | Maps a task state to the v0.3 spelling; an unknown state passes through. |
| `rpcResult` | function | `function rpcResult({ id, result })` | A successful JSON-RPC response. |
| `rpcError` | function | `function rpcError({ id, code, message })` | A JSON-RPC error response. |

#### `lib/tools/a2a-server.mjs` — A2A (Agent-to-Agent) server — A2A v1.0.0 peer.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createA2AServer` | function | `function createA2AServer({ name = 'merci-sdk', description = 'Merci SDK agent exposed over the Agent-to-Agent protocol.', version = SDK_VERSION, skills = [], documentationUrl = undefined, provider = undefined, inputModes = ['text/plain'], outputModes = ['text/plain'], now = () => Date.now(), maxTerminalTasks = LIMITS.a2a_terminal_tasks_max, taskRetentionMs = LIMITS.a2a_task_retention_ms } = {})` | Creates an A2A server exposing the given skills. |
| `A2A_RESPONSE_HEADERS` | const | `const A2A_RESPONSE_HEADERS = Object.freeze({ 'Content-Type': A2A_CONTENT_TYPE, [A2A_VERSI …` | The headers an A2A JSON-RPC endpoint must answer with. |
| `A2A_STREAM_RESPONSE_HEADERS` | const | `const A2A_STREAM_RESPONSE_HEADERS = Object.freeze({ ...A2A_SSE_HEADERS, [A2A_VERSION_HEADER]: A2 …` | The headers an A2A streaming endpoint must answer with. |
| `createA2AHttpHandler` | function | `function createA2AHttpHandler({ server, path = '/a2a', cardPath = WELL_KNOWN_AGENT_CARD_PATH, allowedHosts, allowAnyHost = false, authorize = null } = /** @type {{server: ReturnType<typeof createA2AServer>, path?: string, cardPath?: string, allowedHosts?: string[], allowAnyHost?: boolean, authorize?: ((arg0: { req: import('node:http').IncomingMessage }) => unknown\|Promise<unknown>)\|null}} */ ({}))` | Mounts an A2A server on a `node:http` server. |

#### `lib/tools/a2a.mjs` — A2A (Agent-to-Agent) remote tool loader — A2A v1.0.0 client.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `loadA2ATool` | function | `async function loadA2ATool({ agentUrl, eventEmitter = null, agentContext = null, headers = null, timeoutMs = LIMITS.a2a_timeout_ms })` | (returns []) when the agent card cannot be loaded or the URL is invalid. |
| `cancelA2ATask` | function | `async function cancelA2ATask({ agentUrl, taskId, headers = {}, timeoutMs = LIMITS.a2a_timeout_ms, dialect = undefined })` | Cancels a remote A2A task. |
| `getA2ATask` | function | `async function getA2ATask({ agentUrl, taskId, headers = {}, timeoutMs = LIMITS.a2a_timeout_ms })` | Reads a remote A2A task by id. |
| `A2A_COMPLETED_STATES` | const | `const A2A_COMPLETED_STATES = Object.freeze([...A2A_TERMINAL_STATES])` | The A2A task states that mean the task has ended, whichever dialect spelled it. |

#### `lib/tools/context-tools.mjs` — Built-in context tools — read / grep / glob.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `isSensitivePath` | function | `function isSensitivePath({ filePath = '' } = {})` | Checks whether a path references a sensitive credential/key file by basename or path segment. |
| `createContextTools` | function | `function createContextTools({ options = {} } = {})` | The context tools — read, grep and glob over the working directory, as one tool set. |

#### `lib/tools/external-capability.mjs` — External tool capabilities (MCP / A2A / ACP) on the unified capability ("extension") contract.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `TOOL_OUTPUT_TRUNCATION_SUFFIX` | const | `const TOOL_OUTPUT_TRUNCATION_SUFFIX = '\n...[TRUNCATED TO PREVENT TOKEN OVERFLOW]'` | Suffix marking a capped tool result. |
| `DEFAULT_TOOL_OUTPUT_MAX_LENGTH` | const | `const DEFAULT_TOOL_OUTPUT_MAX_LENGTH = LIMIT_REGISTRY.tool_output_max_chars.default` | Default byte cap on a single remote tool result's text. |
| `capToolOutput` | function | `function capToolOutput({ text, maxLength = LIMITS.tool_output_max_chars })` | Non-strings pass through untouched. |
| `capToolOutputValue` | function | `function capToolOutputValue({ value, maxLength = LIMITS.tool_output_max_chars, maxDepth = LIMITS.cap_max_depth })` | Caps a tool result of **any** shape to a character budget, without changing its type. |
| `ExternalToolCapability` | class | `class ExternalToolCapability extends LoadableComponent` | A remote tool family surfaced as a capability: the tool definitions do the work (tools-first), `load()` renders a short catalog listing for the model, and there is no save leg (toSaveTool() is null — no saveToolName passed). |
| `AcpCapability` | class | `class AcpCapability extends ExternalToolCapability` | Agent Client Protocol (ACP) capability — a duck-typed remote-tool adapter. |

#### `lib/tools/index.mjs` — Tool-family re-export shim.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `extractXmlToolCalls` | function | ↩ `lib/tools/tool-execution.mjs` | Malformed blocks are skipped with a warning (the model gets no silent loss). |
| `executeTools` | function | ↩ `lib/tools/tool-execution.mjs` | `{ id, tool_call_id, name, success, result\|error }` envelope; tool errors are returned (not thrown), while AbortError rethrows as cancellation. |
| `flattenContent` | function | ↩ `lib/tools/tool-execution.mjs` | string the other tool families produce. |
| `mapToolsToConfig` | function | ↩ `lib/tools/tool-execution.mjs` | fields (name/description/parameters) and wraps each schema under `parameters.schema`. |
| `markToolErrorRetryable` | function | ↩ `lib/tools/tool-execution.mjs` | Marks a tool error as a **pre-effect** failure: the tool knows its side effect did not start, so a resume may safely run the call again. |
| `raceWithAbort` | function | ↩ `lib/tools/tool-execution.mjs` | ignores the signal can no longer wedge the whole tool round. |
| `withToolTimeout` | function | ↩ `lib/tools/tool-execution.mjs` | Caps a tool call that outlives its budget. |
| `EMPTY_OBJECT_SCHEMA` | const | ↩ `lib/tools/tool-execution.mjs` | Frozen empty JSON schema, used wherever a tool declares no parameters. |
| `McpClient` | class | ↩ `lib/tools/mcp-client.mjs` | Thin lifecycle wrapper around the MCP client. |
| `loadMcpTools` | function | ↩ `lib/tools/mcp-client.mjs` | (schema normalization + output capping). |
| `loadMcpToolsFrom` | function | ↩ `lib/tools/mcp-client.mjs` | Loads a remote MCP server's tools. |
| `MCP_MAX_OUTPUT_LENGTH` | const | ↩ `lib/tools/mcp-client.mjs` | Byte cap on a single MCP tool result's text. |
| `createMcpServer` | function | ↩ `lib/tools/mcp-server.mjs` | Creates an MCP stdio server exposing the given tools, connected to stdin/stdout. |
| `createMcpHttpHandler` | function | ↩ `lib/tools/mcp-server.mjs` | Creates an MCP server over the Streamable HTTP transport and returns a `node:http` request handler that serves it. |
| `McpTaskStore` | class | ↩ `lib/tools/mcp-task-store.mjs` | In-memory task store: a task record, its abort controller and its retention timer. |
| `FileMcpTaskStore` | class | ↩ `lib/tools/mcp-task-store.mjs` | A durable store: one JSON record per task under `dir`, reloaded on construction, so a task and its result survive a restart. |
| `MCP_TASK_PAGE_SIZE` | const | ↩ `lib/tools/mcp-task-store.mjs` | Tasks returned by one `tasks/list` page. |
| `SkillsLibrary` | class | ↩ `lib/tools/skills.mjs` | Loadable component exposing the registered skills to the model via a list-skills load tool. |
| `loadSkillsFromDirectory` | function | ↩ `lib/tools/skills.mjs` | Missing roots and missing SKILL.md files are normal skips; corruption is surfaced via sdkWarn and the SKILLS.LOAD_ERROR event. |
| `loadA2ATool` | function | ↩ `lib/tools/a2a.mjs` | (returns []) when the agent card cannot be loaded or the URL is invalid. |
| `getA2ATask` | function | ↩ `lib/tools/a2a.mjs` | Reads a remote A2A task by id. |
| `cancelA2ATask` | function | ↩ `lib/tools/a2a.mjs` | Cancels a remote A2A task. |
| `A2A_COMPLETED_STATES` | const | ↩ `lib/tools/a2a.mjs` | The A2A task states that mean the task has ended, whichever dialect spelled it. |
| `createA2AServer` | function | ↩ `lib/tools/a2a-server.mjs` | Creates an A2A server exposing the given skills. |
| `createA2AHttpHandler` | function | ↩ `lib/tools/a2a-server.mjs` | Mounts an A2A server on a `node:http` server. |
| `ExternalToolCapability` | class | ↩ `lib/tools/external-capability.mjs` | A remote tool family surfaced as a capability: the tool definitions do the work (tools-first), `load()` renders a short catalog listing for the model, and there is no save leg (toSaveTool() is null — no saveToolName passed). |
| `AcpCapability` | class | ↩ `lib/tools/external-capability.mjs` | Agent Client Protocol (ACP) capability — a duck-typed remote-tool adapter. |
| `capToolOutput` | function | ↩ `lib/tools/external-capability.mjs` | Non-strings pass through untouched. |
| `capToolOutputValue` | function | ↩ `lib/tools/external-capability.mjs` | Caps a tool result of **any** shape to a character budget, without changing its type. |
| `TOOL_OUTPUT_TRUNCATION_SUFFIX` | const | ↩ `lib/tools/external-capability.mjs` | Suffix marking a capped tool result. |
| `DEFAULT_TOOL_OUTPUT_MAX_LENGTH` | const | ↩ `lib/tools/external-capability.mjs` | Default byte cap on a single remote tool result's text. |
| `createShellTool` | function | ↩ `lib/tools/shell-tools.mjs` | The shell tool — runs a command in the working directory, behind the approval gate. |
| `createShellPolicyTool` | function | ↩ `lib/tools/shell-tools.mjs` | `describe_shell_policy`: the effective tier of one shell-tool instance, so a model reads the host's real allowlists instead of guessing from the defaults. |
| `createContextTools` | function | ↩ `lib/tools/context-tools.mjs` | The context tools — read, grep and glob over the working directory, as one tool set. |

#### `lib/tools/mcp-client.mjs` — MCP client and tool loader (Model Context Protocol).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `MCP_MAX_OUTPUT_LENGTH` | const | `const MCP_MAX_OUTPUT_LENGTH = LIMIT_REGISTRY.mcp_output_max_chars.default` | Byte cap on a single MCP tool result's text. |
| `McpClient` | class | `class McpClient` | Thin lifecycle wrapper around the MCP client. |
| `loadMcpTools` | function | `async function loadMcpTools({ mcpClient })` | (schema normalization + output capping). |
| `loadMcpToolsFrom` | function | `async function loadMcpToolsFrom({ command, args = [], options = {} } = {})` | Loads a remote MCP server's tools. |

#### `lib/tools/mcp-server.mjs` — MCP server helper (Model Context Protocol).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createMcpServer` | function | `async function createMcpServer({ name = 'merci-sdk', version = SDK_VERSION, tools, root, resources = [], prompts = [], mcpProtocolVersion = 'legacy', legacy = 'serve', taskStore = null } = {})` | Creates an MCP stdio server exposing the given tools, connected to stdin/stdout. |
| `createMcpHttpHandler` | function | `async function createMcpHttpHandler(options = {})` | Creates an MCP server over the Streamable HTTP transport and returns a `node:http` request handler that serves it. |

#### `lib/tools/mcp-task-store.mjs` — The task store behind the legacy MCP Tasks interop.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `MCP_TASK_PAGE_SIZE` | const | `const MCP_TASK_PAGE_SIZE = LIMIT_REGISTRY.mcp_task_page_size.default` | Tasks returned by one `tasks/list` page. |
| `toWireTaskError` | function | `function toWireTaskError({ err })` | Maps a store error onto the wire: an unknown task is invalid params with the domain code in `data`, so a client can branch without the message. |
| `fromWireTaskError` | function | `function fromWireTaskError({ error })` | The other direction: restores the `data.code` of a task response as a `BackendError` code the caller can branch on, keeping the wire's message and the received error as its cause. |
| `McpTaskStore` | class | `class McpTaskStore` | In-memory task store: a task record, its abort controller and its retention timer. |
| `FileMcpTaskStore` | class | `class FileMcpTaskStore extends McpTaskStore` | A durable store: one JSON record per task under `dir`, reloaded on construction, so a task and its result survive a restart. |

#### `lib/tools/script-tools.mjs` — Script-backed tools — one interpreter map, contained script resolution, and the plain Tool object that runs a …

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `SCRIPT_INTERPRETERS` | const | `const SCRIPT_INTERPRETERS = new Map([ ['.js', 'node'], ['.mjs', 'node'], ['.cjs', 'node' …` | Scripts run under the interpreter their extension selects. |
| `resolveScriptInterpreter` | function | `function resolveScriptInterpreter({ path } = {})` | The interpreter for a script path, or `null` when the extension is unknown or absent. |
| `resolveScript` | function | `async function resolveScript({ script, baseDir, root, maxBytes = LIMITS.agent_script_max_bytes } = {})` | Resolves a script path against `baseDir` and proves it is a regular, contained, supported, not oversize file. |
| `createScriptTool` | function | `function createScriptTool({ definition } = {})` | Builds the plain Tool object for a normalized script definition. |

#### `lib/tools/shell-tools.mjs` — Shell Tools Integration

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createShellTool` | function | `function createShellTool({ options = {} } = {})` | The shell tool — runs a command in the working directory, behind the approval gate. |
| `createShellPolicyTool` | function | `function createShellPolicyTool({ options = {} } = {})` | `describe_shell_policy`: the effective tier of one shell-tool instance, so a model reads the host's real allowlists instead of guessing from the defaults. |

#### `lib/tools/skills.mjs` — SkillsLibrary — dual-mode loadable skills component.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `SkillsLibrary` | class | `class SkillsLibrary extends LoadableComponent` | Loadable component exposing the registered skills to the model via a list-skills load tool. |
| `loadSkillsFromDirectory` | function | `async function loadSkillsFromDirectory({ directory, eventEmitter = null, requireScriptApproval = true, inheritEnv = false })` | Missing roots and missing SKILL.md files are normal skips; corruption is surfaced via sdkWarn and the SKILLS.LOAD_ERROR event. |

#### `lib/tools/tool-execution.mjs` — XML tool-call extraction and execution.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `EMPTY_OBJECT_SCHEMA` | const | `const EMPTY_OBJECT_SCHEMA = Object.freeze({ type: 'object', properties: {} })` | Frozen empty JSON schema, used wherever a tool declares no parameters. |
| `markToolErrorRetryable` | function | `function markToolErrorRetryable(error)` | Marks a tool error as a **pre-effect** failure: the tool knows its side effect did not start, so a resume may safely run the call again. |
| `raceWithAbort` | function | `function raceWithAbort({ promise, signal })` | ignores the signal can no longer wedge the whole tool round. |
| `withToolTimeout` | function | `function withToolTimeout({ promise, timeoutMs = null, signal = null })` | Caps a tool call that outlives its budget. |
| `flattenContent` | function | `function flattenContent({ result })` | string the other tool families produce. |
| `mapToolsToConfig` | function | `function mapToolsToConfig({ tools })` | fields (name/description/parameters) and wraps each schema under `parameters.schema`. |
| `extractXmlToolCalls` | function | `function extractXmlToolCalls({ text })` | Malformed blocks are skipped with a warning (the model gets no silent loss). |
| `executeTools` | function | `async function executeTools({ toolCalls, toolLibrary, signal, emitter = null, runContext = null, approval = null, journal = null, boundary = null, hooks = null, toolTimeoutMs = null, maxParallelTools = null, permissionMode = 'default' })` | `{ id, tool_call_id, name, success, result\|error }` envelope; tool errors are returned (not thrown), while AbortError rethrows as cancellation. |

### 4.6 `agentic` — Orchestration: sessions, loops, planning, memory, state machine, web components

#### `lib/agentic/acp-agent.mjs` — ACP (Agent Client Protocol) adapter — merci as the AGENT side.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ACP_AGENT_VERSION` | const | `const ACP_AGENT_VERSION = SDK_VERSION` | merci version advertised in the ACP initialize handshake. |
| `ACP_STOP_REASONS` | const | `const ACP_STOP_REASONS = Object.freeze({ END_TURN: 'end_turn', MAX_TOKENS: 'max_token …` | The ACP prompt stop reasons. |
| `permissionAllowed` | function | `function permissionAllowed({ response, options = [] } = {})` | Decides whether an ACP `session/request_permission` response grants the permission. |
| `createAcpAgent` | function | `function createAcpAgent({ session, createSession = null, name = 'merci-sdk', version = ACP_AGENT_VERSION, onTurnContext = null } = {})` | Wraps a merci ChatSession as an ACP agent app. |

#### `lib/agentic/agent-context.mjs` — Typed context envelope threaded through agentic runs.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `AgentContext` | class | `class AgentContext` | The context envelope threaded through agentic runs. |
| `contextChainJSON` | function | `function contextChainJSON({ ctx, depth = 0 })` | A plain, depth-capped copy of a context chain — for a checkpoint that is consumed in memory (`new TaskState(saved.toJSON())`) as well as by JSON. |
| `OBJECTIVE_TAG` | const | `const OBJECTIVE_TAG = '[Global Objective]'` |  |
| `OBJECTIVE_AUTHORITY_NOTE` | const | `const OBJECTIVE_AUTHORITY_NOTE = 'Authoritative: deliver what this objective asks; do not sub …` | Fixed suffix appended to the objective part of the model-visible block. |
| `HANDOFF_MODERATED_MARKER` | const | `const HANDOFF_MODERATED_MARKER = '[Handoff: context compacted; goal carried in full]'` | Handoff marker appended after the full goal block when goal:'moderated'. |
| `HANDOFF_GOAL_MODES` | const | `const HANDOFF_GOAL_MODES = ['clean', 'full', 'moderated']` | Valid `goal` modes for a handoff. |
| `HANDOFF_CONTEXT_MODES` | const | `const HANDOFF_CONTEXT_MODES = ['clean', 'full', 'moderated', 'fork']` | Valid `context` modes for a handoff. |
| `objectiveBlock` | function | `function objectiveBlock({ ctx, label = 'Global Objective' })` |  |
| `briefWithObjective` | function | `function briefWithObjective({ prompt, ctx })` |  |
| `normalizeHandoff` | function | `function normalizeHandoff({ handoff = null } = {})` | Free combination: goal and context vary independently; tools defaults to inherit. |
| `resolveHandoffTools` | function | `function resolveHandoffTools({ handoff, fallback })` | empties, `'inherit'`/undefined keeps the fallback. |
| `goalBlockForHandoff` | function | `function goalBlockForHandoff({ ctx, handoff = null, label = 'Global Objective' })` | block when full, the exact full block + marker when moderated. |
| `merciEnvelope` | function | `function merciEnvelope({ ctx })` | `{ objective, directive, refs }`, nulls omitted. |
| `contextFromMerciEnvelope` | function | `function contextFromMerciEnvelope({ env })` | through). |

#### `lib/agentic/agentic-core.mjs` — Shared agentic loop for all Merci SDK backends.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `adjustCutForToolPairs` | function | `function adjustCutForToolPairs({ messages, cut, minCut = 1 })` | Adjusts a candidate cut index so a tool-call message is never separated from its tool-result row(s). |
| `compactHistory` | function | `async function compactHistory({ messages, compaction, session, signal, onEvent, promptTokens = null, onUsage = null })` | a history that already starts with the summary marker is never re-summarized. |
| `applyApprovalPolicy` | function | `function applyApprovalPolicy({ session, policy })` | session. |
| `throwIfAborted` | function | `function throwIfAborted({ signal, message = 'Agentic loop aborted.' })` | silently otherwise. |
| `forwardStreamEvents` | function | `function forwardStreamEvents({ emit, textEvent, thoughtEvent, makePayload, thoughtSignatureEvent, streamEndEvent })` | deltas onto an orchestrator's own event names. |
| `forwardToolEvents` | function | `function forwardToolEvents({ emit, textEvent, thoughtEvent, toolStartEvent, toolEndEvent, thoughtSignatureEvent, makePayload })` | events (tool_call_start/tool_call_end) the agentic loop emits around executeTools — the AutoGen ToolCallRequestEvent/ExecutionEvent analogue. |
| `normalizeAgentOutput` | function | `function normalizeAgentOutput({ raw })` | an object's `content` wins, anything else is JSON-stringified. |
| `EMPTY_FALLBACK_CAUSE` | const | `const EMPTY_FALLBACK_CAUSE = 'empty-response fallback (no text after the tool round)'` | Human-readable cause for an agent turn that ended on the SDK empty-response fallback. |
| `SCHEMA_FALLBACK_CAUSE` | const | `const SCHEMA_FALLBACK_CAUSE = 'schema-validation fallback (no valid JSON after correction …` | Human-readable cause for an agent turn that exhausted its structured-output correction retries. |
| `fallbackKind` | function | `function fallbackKind({ text })` | hard failure), `'empty'` (a transient no-answer — retryable), `'schema'` (an exhausted structured-output correction loop — also transient), `'filtered'` (the provider's content moderation stopped the answer — not retryable), or null for real content. |
| `isTransientFallbackKind` | function | `function isTransientFallbackKind({ kind })` | answer or an exhausted structured-output correction loop. |
| `isSdkFallbackOutput` | function | `function isSdkFallbackOutput({ text })` | iteration-limit or schema-validation, so the `(${msg})` and `+TRUNCATED` variants match). |
| `streamErrorToRetryError` | function | `function streamErrorToRetryError({ error })` | The retryable error for a vendor stream failure. |
| `assertNotInFlight` | function | `function assertNotInFlight({ flag, label })` | Reentrancy guard shared by `runAgenticLoop`, the DAG executor and the state machine: throws a typed `MerciError` (`CONCURRENT_RUN`) when a run is already in flight. |
| `assertVerifyVerdict` | function | `function assertVerifyVerdict({ verdict, label })` | Verifies a `verify` callback returned a verdict object (`{ passed, evidence }`) whose `passed` is a real boolean. |
| `assertUsableOutput` | function | `function assertUsableOutput({ text, what = 'output' })` | Throws an `EMPTY_OUTPUT_CODE` error when `text` is an SDK fallback sentinel or whitespace/empty. |
| `schemaCorrection` | function | `function schemaCorrection({ detail })` | The one correction prompt every engine sends after a stateSchema violation: the executor's four strategies and the discussion group used to spell it themselves and could drift. |
| `resolveExhaustionOpts` | function | `function resolveExhaustionOpts({ source, autoExtend = false, errorHandlers = null })` |  |
| `runCriteriaChecks` | function | `async function runCriteriaChecks({ ctx, criteria = [], judge = null, judgeOnPass = false, signal = null })` | Used by the executor's per-node verify and the StateMachine's completion gate. |
| `runDueSteps` | function | `async function runDueSteps({ steps })` | Runs the steps that are due and returns one settled result per step, in input order. |
| `runAgenticLoop` | function | `async function runAgenticLoop({ session, messages, opts = {} })` | Tool rounds run until the model answers with text. |
| `drainStepWithHooks` | function | `async function drainStepWithHooks({ gen, tools, onEvent, signal, emitter = null, runContext = null, approval = null, journal = null, boundary = null, hooks = null, toolTimeoutMs = null, maxParallelTools = null, permissionMode = 'default' })` | usage across the step's events into `result.usage` so the loop and compaction have real token data. |
| `stepAgentic` | function | `async function* stepAgentic({ session, messages, options = {} })` | callers no longer need to invoke injectMemory themselves; step() does it through `_prepareStepMessages`. |
| `defaultDisplay` | function | `function defaultDisplay({ also, stream = 'debug' } = {})` | Returns the default display `{ onEvent }` for runAgenticLoop consumers: thinking via the logger, text/tool deltas to stdout (the first text delta of each turn is prefixed with `Assistant > ` so the answer is labelled exactly once), newline on stream_end. |

#### `lib/agentic/agents/apply.mjs` — The two agent-definition consumers: a runnable session and a delegated subagent profile.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `applyAgentSpec` | function | `function applyAgentSpec({ session, spec, toolbox = {}, allowDangerous = false })` | Applies a spec to an existing session and returns it (fluent). |
| `toTaskAgent` | function | `function toTaskAgent({ spec, toolbox = {}, allowDangerous = false, model = null })` | Builds the `TaskAgent` profile for `withTaskAgents`. |

#### `lib/agentic/agents/catalog.mjs` — The agent-definition tool catalog: one frozen table of the groups a `*.agent.yaml` file may request, the concr …

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `AGENT_TOOL_GROUPS` | const | `const AGENT_TOOL_GROUPS = Object.freeze({ files: group({ tools: ['read', 'grep', 'glob …` | The groups a file may name in `spec.tools.use`. |
| `AGENT_TOOL_GROUP_ALIASES` | const | `const AGENT_TOOL_GROUP_ALIASES = Object.freeze({ web: Object.freeze(['search', 'scrape']) })` | Beginner aliases: a readable umbrella that expands to real groups. |
| `AGENT_META_GROUPS` | const | `const AGENT_META_GROUPS = Object.freeze(['all'])` | Groups that grant every tool the host can satisfy; dangerous by design. |
| `AGENT_SELECTOR_SOURCES` | const | `const AGENT_SELECTOR_SOURCES = Object.freeze([ 'native', 'host', 'skill', 'script', 'mcp', …` | The selector namespaces a file may use in `allow` / `deny`. |
| `expandAgentGroup` | function | `function expandAgentGroup({ name })` | Expands one `use` entry to real group names. |
| `agentGroupToolNames` | function | `function agentGroupToolNames({ name })` | The tool names a `use` entry yields, after alias expansion. |

#### `lib/agentic/agents/index.mjs` — Public surface of `merci-sdk/agents`: load a `*.agent.yaml`, resolve its tool model against a host toolbox, th …

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `loadAgentFile` | function | ↩ `lib/agentic/agents/load.mjs` | Loads one `*.agent.yaml` file into a deep-frozen spec. |
| `loadAgentDirectory` | function | ↩ `lib/agentic/agents/load.mjs` | Loads every regular `*.agent.yaml` in one directory. |
| `AGENT_API_VERSION` | const | ↩ `lib/agentic/agents/spec.mjs` | The one format version v1 reads. |
| `AGENT_KIND` | const | ↩ `lib/agentic/agents/spec.mjs` | The one document kind v1 reads. |
| `AGENT_FILE_REASONS` | const | ↩ `lib/agentic/agents/spec.mjs` | Every stable reason an `AgentFileError` from this format may carry. |
| `AGENT_META_GROUPS` | const | ↩ `lib/agentic/agents/catalog.mjs` | Groups that grant every tool the host can satisfy; dangerous by design. |
| `AGENT_SELECTOR_SOURCES` | const | ↩ `lib/agentic/agents/catalog.mjs` | The selector namespaces a file may use in `allow` / `deny`. |
| `AGENT_TOOL_GROUPS` | const | ↩ `lib/agentic/agents/catalog.mjs` | The groups a file may name in `spec.tools.use`. |
| `AGENT_TOOL_GROUP_ALIASES` | const | ↩ `lib/agentic/agents/catalog.mjs` | Beginner aliases: a readable umbrella that expands to real groups. |
| `agentGroupToolNames` | function | ↩ `lib/agentic/agents/catalog.mjs` | The tool names a `use` entry yields, after alias expansion. |
| `expandAgentGroup` | function | ↩ `lib/agentic/agents/catalog.mjs` | Expands one `use` entry to real group names. |
| `createAgentToolbox` | function | ↩ `lib/agentic/agents/toolbox.mjs` | Builds the immutable toolbox. |
| `parseSelector` | function | ↩ `lib/agentic/agents/toolbox.mjs` | Splits one selector into `{ source, owner, pattern }`. |
| `prefixExternalPattern` | function | ↩ `lib/agentic/agents/toolbox.mjs` | The same prefixing, but `*` survives so a deny selector can stay a glob. |
| `prefixExternalTool` | function | ↩ `lib/agentic/agents/toolbox.mjs` | The namespaced name of an external tool. |
| `resolveToolset` | function | ↩ `lib/agentic/agents/toolbox.mjs` | Resolves a spec against a toolbox. |
| `sanitizeToolName` | function | ↩ `lib/agentic/agents/toolbox.mjs` | A wire-safe tool name: `[A-Za-z0-9_-]`, at most `agent_tool_name_max`, with a short deterministic suffix when truncation is needed. |
| `applyAgentSpec` | function | ↩ `lib/agentic/agents/apply.mjs` | Applies a spec to an existing session and returns it (fluent). |
| `toTaskAgent` | function | ↩ `lib/agentic/agents/apply.mjs` | Builds the `TaskAgent` profile for `withTaskAgents`. |

#### `lib/agentic/agents/load.mjs` — Read and load `*.agent.yaml` files: one file, or one flat directory.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `loadAgentFile` | function | `async function loadAgentFile({ path, allowDangerous = false, root = null } = {})` | Loads one `*.agent.yaml` file into a deep-frozen spec. |
| `loadAgentDirectory` | function | `async function loadAgentDirectory({ directory, allowDangerous = false } = {})` | Loads every regular `*.agent.yaml` in one directory. |

#### `lib/agentic/agents/spec.mjs` — Normalize one parsed `*.agent.yaml` mapping into a deep-frozen `AgentSpec`.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `AGENT_API_VERSION` | const | `const AGENT_API_VERSION = 'merci.dev/v1alpha1'` | The one format version v1 reads. |
| `AGENT_KIND` | const | `const AGENT_KIND = 'Agent'` | The one document kind v1 reads. |
| `AGENT_FILE_REASONS` | const | `const AGENT_FILE_REASONS = Object.freeze([ 'agent_read_error', 'agent_too_large', 'agen …` | Every stable reason an `AgentFileError` from this format may carry. |
| `normalizeAgentSpec` | function | `async function normalizeAgentSpec({ value, path = null, positions = new Map(), baseDir, root, allowDangerous = false, hash = '' } = {})` | Validates one parsed agent definition into a deep-frozen spec. |

#### `lib/agentic/agents/toolbox.mjs` — Agent tool resolution: groups, selectors and sources become concrete tool objects and session actions.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `sanitizeToolName` | function | `function sanitizeToolName({ value })` | A wire-safe tool name: `[A-Za-z0-9_-]`, at most `agent_tool_name_max`, with a short deterministic suffix when truncation is needed. |
| `prefixExternalTool` | function | `function prefixExternalTool({ source, owner, name })` | The namespaced name of an external tool. |
| `prefixExternalPattern` | function | `function prefixExternalPattern({ source, owner, pattern })` | The same prefixing, but `*` survives so a deny selector can stay a glob. |
| `createAgentToolbox` | function | `function createAgentToolbox({ workspace = null, approval = null, todos = null, memory = null, knowledge = null, skills = null, search = null, scrape = null, browser = null, stateMachine = null, delegation = null, tools = [], mcp = {}, acp = {}, a2a = {}, options = {} } = {})` | Builds the immutable toolbox. |
| `parseSelector` | function | `function parseSelector({ selector })` | Splits one selector into `{ source, owner, pattern }`. |
| `resolveToolset` | function | `function resolveToolset({ spec, toolbox = {}, allowDangerous = false, mode = 'session' })` | Resolves a spec against a toolbox. |

#### `lib/agentic/approval.mjs` — One approval-input normalizer for every boundary that accepts a gate.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `normalizeApproval` | function | `function normalizeApproval({ value, origin = 'createEngineRunner', option = 'invalid_approval' })` | Accept a function, a `{ callback, timeoutMs }` object, or a `{ fn, options: { timeoutMs } }` object. |

#### `lib/agentic/artifacts.mjs` — Artifact tool — persist large subagent outputs to files.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createSaveArtifactTool` | function | `function createSaveArtifactTool({ dir = 'artifacts', eventEmitter = null } = {})` | A tool that saves a file the run produced into the artifact directory. |

#### `lib/agentic/browser/component.mjs` — BrowserComponent — the `browser` function-tool surface (read-only slice).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `INTERACTIVE_ACTIONS` | const | `const INTERACTIVE_ACTIONS = Object.freeze([ 'snapshot', 'click', 'fill', 'type', 'pressK …` | The interactive actions the browser tool understands — the vocabulary of a page interaction. |
| `resolveReadEngine` | function | `function resolveReadEngine({ policy = false, mode, curl = null, allowUnpolicedObscura = false })` | Which read engine `#run` uses. |
| `BrowserComponent` | class | `class BrowserComponent extends LoadableComponent` | Browser capability surfaced as a `browser` function tool: `navigate` (read leg, no action needed) plus the interactive actions (Playwright over `obscura serve` CDP). |

#### `lib/agentic/browser/engines.mjs` — Obscura browser engines + mode resolution (read + interactive).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `MAX_BROWSER_URLS` | const | `const MAX_BROWSER_URLS = LIMIT_DEFAULTS.browser_max_urls` | How many URLs one browser turn may open. |
| `resolveBrowserMode` | function | `function resolveBrowserMode({ _sessionProvider, mode })` | Resolves the browser mode — the strategy the browser tool runs in. |
| `ObscuraEngine` | class | `class ObscuraEngine` | Obscura engine — standalone `obscura fetch <url> --dump <text\|markdown>`. |
| `CurlEngine` | class | ↩ `lib/agentic/webscrape/engines.mjs` | Curl engine — plain `fetch`, strips HTML to text. |
| `PlaywrightSession` | class | `class PlaywrightSession` | Interactive session over `obscura serve` CDP via Playwright. |

#### `lib/agentic/budget-accounting.mjs` — The token-budget enforcement kernel — pure functions, no state.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `remainingBudget` | function | `function remainingBudget({ budget, spent, spentUsd = 0, emit, divisor = 1, floor = 0, round = false })` | The budget the next turn may spend: the cap minus what is already spent. |
| `assertBudgetOverspent` | function | `function assertBudgetOverspent({ budget, spent, spentUsd = 0, emit })` | Fails closed after a charge: a spend that passed the cap emits and throws. |
| `sumNumericUsage` | function | `function sumNumericUsage({ usage, into = {} })` | Adds every finite numeric field of a usage record onto an accumulator. |

#### `lib/agentic/budget-pool.mjs` — The shared budget pool (wave 6 / SP4, D12) — one cap for the whole spawn tree.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `getPoolParent` | function | `function getPoolParent({ pool })` | The pool's parent (a wider session pool or an attempt ledger), if any. |
| `setPoolParent` | function | `function setPoolParent({ pool, parent })` | Re-parents a pool. |
| `ensurePoolLists` | function | `function ensurePoolLists({ pool })` | The two ledger-owned lists on a pool, kept out of JSON and created lazily so a host-shaped ledger (a plain object) works too. |
| `ensureBudgetPool` | function | `function ensureBudgetPool({ session, parent = null })` | The pool of a session, created on first use when the session has a budget. |
| `ATTEMPT_LEDGER` | const | `const ATTEMPT_LEDGER = Symbol('merci.attemptLedger')` | Marks a ledger as an attempt ledger (a session pool is not one). |
| `ATTEMPT_LEDGER_RELEASED` | const | `const ATTEMPT_LEDGER_RELEASED = Symbol('merci.attemptLedgerReleased')` | Marks an attempt ledger the runner has released (a stale view must not re-attach it). |
| `markPoolReleased` | function | `function markPoolReleased({ pool })` | Closes an attempt ledger. |
| `createBudgetPool` | function | `function createBudgetPool()` | A cap-less ledger for one scheduler attempt. |
| `syncBudgetPoolCaps` | function | `function syncBudgetPoolCaps({ session })` | Mirrors the owner's budget onto the pool after `withBudget`. |
| `absorbPoolUsage` | function | `function absorbPoolUsage({ pool, usage = null, estTokens = 0 })` | Charges one model call to the tree and to every ancestor. |
| `poolUsageSnapshot` | function | `function poolUsageSnapshot({ pool })` | The pool's usage in the shape the budget events and errors carry. |
| `attemptPoolView` | function | `function attemptPoolView({ pool })` | A frozen read-only view of a ledger for host hooks: caps are live getters, usage is a frozen copy per read, and the live ledger is never exposed. |
| `getBudgetPool` | function | `function getBudgetPool({ session })` | The public read API: the tree's cap and spend, or null when the session has no budget. |

#### `lib/agentic/chat-session-builder.mjs` — Fluent ChatSession builder shared by every backend.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ChatSessionBuilder` | class | `class ChatSessionBuilder` | Fluent builder for ChatSession configuration. |

#### `lib/agentic/chat-session.mjs` — Abstract backend ChatSession — the step engine + system-context assembly.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `isContentFilterReason` | function | `function isContentFilterReason({ reason })` | True for the JAI `PrematureEnd` reason that means moderation: the gateway sends `content_filter` (or `ContentFilter`); every other reason, notably `Unknown`, is an unclassified early stop, not a moderation block. |
| `AbstractChatSession` | class | `class AbstractChatSession extends ChatSessionBuilder` | The abstract ChatSession: builder configuration plus the step() generator. |
| `BaseChatSession` | class | `class BaseChatSession extends AbstractChatSession` | Shared OAI-family ChatSession (oai/gai/aai). |

#### `lib/agentic/cli/launcher.mjs` — CLI command launcher: dispatch + interactive agent loop.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `CommandDispatcher` | class | `class CommandDispatcher` | Static helpers for /command line detection and parsing. |
| `AgentLauncher` | class | `class AgentLauncher extends EventEmitter` | Interactive agent CLI: system commands, skill-plugin dispatch, and a tool-fed agentic loop over a backend session. |

#### `lib/agentic/cli/suggestion-source.mjs` — CommandSuggestionSource — UI-agnostic command-completion engine.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `CommandSuggestionSource` | class | `class CommandSuggestionSource` | CommandSuggestionSource: UI-agnostic command-completion engine. |

#### `lib/agentic/context-fold.mjs` — context-fold — the single row-array folding primitive.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `foldContext` | function | `async function foldContext({ rows, cut, summarize = null, markerLabel = 'Earlier entries omitted', wrapSummary = null, wrapMarker = null })` | Folds a row array at `cut`: keeps the tail and replaces the prefix with a summary row, or with an explicit loss marker when there is no usable summary. |

#### `lib/agentic/context.mjs` — Auto-context sources — environment block + AGENTS.md instructions.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `formatPromptDate` | function | `function formatPromptDate({ locale, timezone, format = 'native', includeTime = false, now = new Date() } = {})` | Formats the current date for a model-visible prompt line. |
| `buildEnvironmentBlock` | function | `async function buildEnvironmentBlock({ root = process.cwd() } = {})` | Renders the environment block: working directory, git repo, platform, date. |
| `discoverInstructions` | function | `async function discoverInstructions({ root = process.cwd(), stopAt = root, eventEmitter = null } = {})` | Discovers and renders AGENTS.md instruction files from `root` up to `stopAt` (inclusive). |

#### `lib/agentic/decision-calibration.mjs` — Decision calibration — ECE, Brier, and a threshold sweep.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `decisionCalibration` | function | `function decisionCalibration({ samples = [], bins = 10, thresholds = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95] } = {})` |  |

#### `lib/agentic/decision-gate.mjs` — The shared decision gate — one System One call, one verdict.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `certaintyOf` | function | `function certaintyOf({ answer = null } = {})` | The certainty an answer carries, 0..1, or null when it cannot be calibrated. |
| `createDecisionGate` | function | `function createDecisionGate({ ask = null, threshold = LIMITS.decision_gate_threshold, maxStateChars = LIMITS.decision_state_max_chars, seam = 'decision', emitter = null, onUsage = null } = {})` | Builds the gate over a bound decision surface. |

#### `lib/agentic/decision-usage.mjs` — Decision usage → the session's budget pool.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `mergeDecisionGate` | function | `function mergeDecisionGate({ options, gate })` | The per-run options a session hands to the agentic loop: its own gate is the default, and an explicit `options.decisionGate` wins for one call. |
| `decisionTokensFromEvent` | function | `function decisionTokensFromEvent({ usage = null, stateChars = 0 })` | The tokens and cost one usage event represents. |
| `decisionUsageTotal` | function | `function decisionUsageTotal({ session })` | The session's decision spend so far (tokens). |
| `decisionUsageCost` | function | `function decisionUsageCost({ session })` | The session's decision cost so far, in USD. |
| `mergeRunUsage` | function | `function mergeRunUsage({ usage = null, decisionTokens = 0, decisionCost = 0 })` | Merges a step's decision tokens into the usage `runStep` returns. |
| `attachDecisionUsage` | function | `function attachDecisionUsage({ session, gate })` | Wraps `gate` so every answered call is charged to `session`'s pool and to its decision accumulator. |

#### `lib/agentic/discussion-session.mjs` — Standalone multi-agent discussion session.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `EMPTY_FALLBACK_CAUSE` | const | ↩ `lib/agentic/agentic-core.mjs` | Human-readable cause for an agent turn that ended on the SDK empty-response fallback. |
| `isSubstantiveEntry` | function | `function isSubstantiveEntry(entry)` | A substantive ledger entry is real content: not a pass/deferral, not empty, not an SDK fallback, not an `[error: …]` record. |
| `DiscussionSession` | class | `class DiscussionSession extends EventEmitter` | A multi-agent debate group: agents converse on a shared ledger, optionally judged/aggregated into a conclusion. |

#### `lib/agentic/evals.mjs` — Evals — run a suite of cases against a session and score each run.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `runEvals` | function | `async function runEvals({ cases, makeSession, scorers = [], concurrency = LIMITS.evals_concurrency, signal = null })` | Runs a suite: every case on a fresh session, every scorer on every run. |
| `EVAL_SCORERS` | const | `const EVAL_SCORERS = Object.freeze({ /** @returns {EvalScorer} */ outputMatches: …` | The built-in scorers. |

#### `lib/agentic/guardrails.mjs` — Guardrails — the input/output tripwire.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createGuardrails` | function | `function createGuardrails({ rules = null } = {})` | Creates the guardrail engine for a set of rules. |
| `decisionTest` | function | `function decisionTest({ ask = null, question = null, threshold = LIMITS.decision_gate_threshold, seam = 'guardrail', emitter = null } = {})` | A guardrail predicate backed by the decision gate: `true` only when the gate is certain enough to skip the LLM path. |
| `withToolGuardrails` | function | `function withToolGuardrails({ guardrails = null, hooks = null })` | The hooks a tool call runs under: the session's own first, then the tool-phase guardrails — so a guardrail sees the arguments and the result the hooks settled on. |
| `extractUserText` | function | `function extractUserText({ messages })` | The text of **every** user turn — what a caller typed into the agent. |

#### `lib/agentic/inbox-store.mjs` — The inbox store — where a durable queue of submitted messages lives.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `INBOX_STORE_VERSION` | const | `const INBOX_STORE_VERSION = 1` | The on-disk shape every inbox store speaks. |
| `InMemoryInboxStore` | class | `class InMemoryInboxStore` | Process-local inbox. |
| `LocalFileInboxStore` | class | `class LocalFileInboxStore` | File-backed inbox: one JSON file per thread, written atomically (tmp + rename, fsync) so a crash mid-save leaves the previous queue intact. |

#### `lib/agentic/ingest.mjs` — Document ingestion → Markdown (images and PDFs via a model).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `DOCUMENT_INGEST_PROMPT` | const | `const DOCUMENT_INGEST_PROMPT = 'Convert this document to Markdown following the conventions …` | Instruction paired with the document in the user turn. |
| `DOCUMENT_INGEST_SYSTEM_PROMPT` | const | ``const DOCUMENT_INGEST_SYSTEM_PROMPT = `You are an OCR engine. Convert the provided document to cle …`` | System directive that fixes the Markdown output conventions. |
| `ingestDocument` | function | `async function ingestDocument({ client, model, path, root, provider, signal } = {})` | Ingests a document (image or PDF) as Markdown using a vision-capable model. |

#### `lib/agentic/journal.mjs` — Execution journal — at-most-once side effects under retries, replays and resume.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `JOURNAL_STATUS` | const | `const JOURNAL_STATUS = Object.freeze({ INTENT: ('intent'), DONE: ('done'), FAILED: …` | One journal row: its identity, lifecycle, the meta the caller spread in, and the attempt history (flat — each stored attempt drops its own `attempts`). |
| `journalKey` | function | `function journalKey({ parts = [] } = {})` | A stable 16-character key for a journal entry, derived from its parts. |
| `toolJournalKey` | function | `function toolJournalKey({ runId, boundary, name, args })` | The journal key of a tool call — the identity its outcome is recorded under. |
| `ExecutionJournal` | class | `class ExecutionJournal` |  |
| `journalThreadId` | function | `function journalThreadId({ threadId })` | The thread id a run's journal-only sibling file is stored under. |
| `attachJournalSink` | function | `function attachJournalSink({ journal, store, threadId })` | Wires a run's journal to a store, so `begin()` is durable before `execute()`. |
| `restoreJournalSibling` | function | `async function restoreJournalSibling({ journal, store, threadId })` | Folds the sibling journal (written before a side effect, possibly after the last checkpoint) into the journal restored from the checkpoint. |

#### `lib/agentic/knowledge/adapters.mjs` — Knowledge surface adapters — document, wiki corpus, memory bank, todo store, plan DAG.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `readTextFile` | function | `function readTextFile({ path })` | Reads a text-like file. |
| `documentSurface` | function | `function documentSurface({ paths, profile = null, title = '' })` | The `document` surface: one graph from one or more text files. |
| `wikiSurface` | function | `function wikiSurface({ dir, profile = null, title = '' })` | The `wiki` surface: an existing markdown corpus becomes a reference graph. |
| `memorySurface` | function | `function memorySurface({ facts })` | The `memory` surface: bank facts become `fact` nodes. |
| `todosSurface` | function | `function todosSurface({ store })` | The `todos` surface: tasks and their declared dependencies. |
| `planSurface` | function | `function planSurface({ plan })` | The `plan` surface: a task DAG becomes `step` nodes. |
| `surfaceFragment` | function | `function surfaceFragment({ surface, input, profile = null })` | Runs one surface's adapter. |
| `mergeFragment` | function | `function mergeFragment({ graph = null, fragment = null } = {})` | Merges adapter output into a graph, skipping ids that already exist. |

#### `lib/agentic/knowledge/build.mjs` — Knowledge graph construction — the mechanical pass.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `KNOWLEDGE_BUILD_VERSION` | const | `const KNOWLEDGE_BUILD_VERSION = 1` | Bumped whenever the mechanical pass changes what it emits for the same bytes. |
| `normalizeText` | function | `function normalizeText({ text })` | Normalises line endings and strips a BOM. |
| `headingList` | function | `function headingList({ text })` |  |
| `paragraphList` | function | `function paragraphList({ text, headings })` | Blank-line separated blocks, each attributed to the nearest preceding heading. |
| `sentenceList` | function | `function sentenceList({ text })` | Sentences inside a block, by terminal punctuation. |
| `modalityOf` | function | `function modalityOf({ text })` | The modality a sentence states, or null when it is descriptive. |
| `extractDefinitions` | function | `function extractDefinitions({ text })` | `"Term" means …` / `Term (the "Alias")` style definitions. |
| `extractRefs` | function | `function extractRefs({ text })` | Cross-references an agent can anchor: `Section 4.2`, `Clause 7`, `§ 4`, `Annex I`. |
| `buildGraph` | function | `function buildGraph({ sources = [], profile = null, title = '', now = new Date() } = {})` | Builds a graph from one or more documents. |
| `nodeKey` | function | `function nodeKey({ node })` | Stable identity of a node's content, independent of where it sits. |
| `sourceSha` | function | `function sourceSha({ text })` | Content hash of a whole source, for the corpus manifest. |
| `slug` | function | `function slug({ value })` | Lowercase, accent-folded, hyphenated key. |
| `keyOf` | function | `function keyOf({ value })` | Normalised term key: `The Confidential Information` → `confidential information`. |

#### `lib/agentic/knowledge/cache.mjs` — Corpus cache — persist a built graph, detect a delta, rebuild only what moved.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `MANIFEST_FILE` | const | `const MANIFEST_FILE = 'manifest.json'` | The file that records what a build was made from. |
| `manifestPath` | function | `function manifestPath({ dir = DEFAULT_KNOWLEDGE_DIR } = {})` |  |
| `readSources` | function | `function readSources({ paths = [] } = {})` | Reads the sources from disk, in the order given (the order is part of the key). |
| `fingerprintSources` | function | `function fingerprintSources({ sources = [] } = {})` |  |
| `sourceDelta` | function | `function sourceDelta({ stored = [], current = [] } = {})` | What changed between the corpus a graph was built from and the one on disk. |
| `corpusKey` | function | `function corpusKey({ sources = [], profile = null, buildVersion = KNOWLEDGE_BUILD_VERSION } = {})` | The build identity: sources by path and content, plus the vocabulary that shaped them and the extractor version. |
| `loadManifest` | function | `async function loadManifest({ dir = DEFAULT_KNOWLEDGE_DIR } = {})` |  |
| `loadCorpus` | function | `async function loadCorpus({ dir = DEFAULT_KNOWLEDGE_DIR } = {})` | Loads the persisted graph and its manifest. |
| `reanchorDerived` | function | `function reanchorDerived({ stored = null, fresh = null } = {})` | Moves the agent's nodes from an old graph onto a freshly built one. |
| `syncCorpus` | function | `async function syncCorpus({ dir = DEFAULT_KNOWLEDGE_DIR, paths = [], sources = null, profile = null, now = new Date() } = {})` | Load-or-build. |

#### `lib/agentic/knowledge/component.mjs` — The knowledge capability component: ASG + wiki as one capability.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `KnowledgeComponent` | class | `class KnowledgeComponent extends LoadableComponent` | The knowledge capability. |
| `emptyGraph` | function | `function emptyGraph({ profile = null } = {})` |  |

#### `lib/agentic/knowledge/index.mjs` — Public surface of the knowledge capability (ASG + wiki).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `KNOWLEDGE_SCHEMA` | const | ↩ `lib/agentic/knowledge/model.mjs` | Schema id carried by `graph.json`. |
| `LEGAL_GRAPH_SCHEMA` | const | ↩ `lib/agentic/knowledge/model.mjs` | The schema id the legal-skills toolchain writes; accepted on import. |
| `KNOWLEDGE_VERSION` | const | ↩ `lib/agentic/knowledge/model.mjs` | Current model version, bumped when a field changes meaning. |
| `EDGE_SHAPES` | const | ↩ `lib/agentic/knowledge/model.mjs` | The shapes an edge may take beyond "A rel B". |
| `EDGE_POLARITIES` | const | ↩ `lib/agentic/knowledge/model.mjs` | The only values `edge.polarity` may take. |
| `SALIENCE` | const | ↩ `lib/agentic/knowledge/model.mjs` | Salience ladder, most to least load-bearing. |
| `CONFIDENCE` | const | ↩ `lib/agentic/knowledge/model.mjs` | Confidence ladder. |
| `TIERS` | const | ↩ `lib/agentic/knowledge/model.mjs` | Evidence tiers, from the legal corpus (`F`ull-text verified → `P`rovisional). |
| `EDGE_ORIGINS` | const | ↩ `lib/agentic/knowledge/model.mjs` | Where an edge came from: a parse, a formula, or a judgement. |
| `CORE_RELATIONS` | const | ↩ `lib/agentic/knowledge/model.mjs` | Relations a structural/doc parse or an author may use without a note. |
| `SEMANTIC_RELATIONS` | const | ↩ `lib/agentic/knowledge/model.mjs` | Semantic relations assert a reading, so they need a note. |
| `STRUCTURAL_RELATIONS` | const | ↩ `lib/agentic/knowledge/model.mjs` | Relations that expand freely during traversal (structure, not judgement). |
| `GENERIC_PROFILE` | const | ↩ `lib/agentic/knowledge/model.mjs` | Domain-neutral vocabulary: documents, claims, evidence, work items. |
| `LEGAL_PROFILE` | const | ↩ `lib/agentic/knowledge/model.mjs` | The legal vocabulary the existing corpus uses (`legalgraph/v1`). |
| `PROFILES` | const | ↩ `lib/agentic/knowledge/model.mjs` | Every shipped profile by name. |
| `resolveProfile` | function | ↩ `lib/agentic/knowledge/model.mjs` | Resolves a profile by name, or accepts a caller-supplied shape. |
| `isKnownKind` | function | ↩ `lib/agentic/knowledge/model.mjs` |  |
| `isKnownRel` | function | ↩ `lib/agentic/knowledge/model.mjs` |  |
| `isSemanticRel` | function | ↩ `lib/agentic/knowledge/model.mjs` |  |
| `graphSha` | function | ↩ `lib/agentic/knowledge/model.mjs` | Stable hash of the graph's content. |
| `statsOf` | function | ↩ `lib/agentic/knowledge/model.mjs` | Counts nodes, edges, kinds and relation usage. |
| `validateGraph` | function | ↩ `lib/agentic/knowledge/model.mjs` | Validates a graph. |
| `applyPatch` | function | ↩ `lib/agentic/knowledge/model.mjs` | Applies a patch: add nodes/edges, update node fields, remove by id. |
| `sourceSlice` | function | ↩ `lib/agentic/knowledge/model.mjs` | The exact source text a node points at, when the caller supplied the sources. |
| `normalizeText` | function | ↩ `lib/agentic/knowledge/build.mjs` | Normalises line endings and strips a BOM. |
| `headingList` | function | ↩ `lib/agentic/knowledge/build.mjs` |  |
| `paragraphList` | function | ↩ `lib/agentic/knowledge/build.mjs` | Blank-line separated blocks, each attributed to the nearest preceding heading. |
| `sentenceList` | function | ↩ `lib/agentic/knowledge/build.mjs` | Sentences inside a block, by terminal punctuation. |
| `modalityOf` | function | ↩ `lib/agentic/knowledge/build.mjs` | The modality a sentence states, or null when it is descriptive. |
| `extractDefinitions` | function | ↩ `lib/agentic/knowledge/build.mjs` | `"Term" means …` / `Term (the "Alias")` style definitions. |
| `extractRefs` | function | ↩ `lib/agentic/knowledge/build.mjs` | Cross-references an agent can anchor: `Section 4.2`, `Clause 7`, `§ 4`, `Annex I`. |
| `buildGraph` | function | ↩ `lib/agentic/knowledge/build.mjs` | Builds a graph from one or more documents. |
| `nodeKey` | function | ↩ `lib/agentic/knowledge/build.mjs` | Stable identity of a node's content, independent of where it sits. |
| `sourceSha` | function | ↩ `lib/agentic/knowledge/build.mjs` | Content hash of a whole source, for the corpus manifest. |
| `KNOWLEDGE_BUILD_VERSION` | const | ↩ `lib/agentic/knowledge/build.mjs` | Bumped whenever the mechanical pass changes what it emits for the same bytes. |
| `slug` | function | ↩ `lib/agentic/knowledge/build.mjs` | Lowercase, accent-folded, hyphenated key. |
| `keyOf` | function | ↩ `lib/agentic/knowledge/build.mjs` | Normalised term key: `The Confidential Information` → `confidential information`. |
| `DEFAULT_KNOWLEDGE_DIR` | const | ↩ `lib/agentic/knowledge/store.mjs` | Default directory, matching the `.knowledge` convention of the skill corpus. |
| `knowledgePaths` | function | ↩ `lib/agentic/knowledge/store.mjs` |  |
| `loadGraph` | function | ↩ `lib/agentic/knowledge/store.mjs` | Loads the graph. |
| `saveGraph` | function | ↩ `lib/agentic/knowledge/store.mjs` | Writes the graph and stamps its stats + hash. |
| `loadOntology` | function | ↩ `lib/agentic/knowledge/store.mjs` | Loads the vocabulary. |
| `saveOntology` | function | ↩ `lib/agentic/knowledge/store.mjs` | Writes the vocabulary. |
| `promotableRelations` | function | ↩ `lib/agentic/knowledge/store.mjs` | Custom relations that appear in enough distinct notes to deserve promotion into the vocabulary. |
| `adoptOntology` | function | ↩ `lib/agentic/knowledge/store.mjs` | Adopts a proposal as the vocabulary. |
| `adoptedProfile` | function | ↩ `lib/agentic/knowledge/store.mjs` | The adopted vocabulary as a profile a graph can be validated against, or null when nothing was adopted. |
| `tokensOf` | function | ↩ `lib/agentic/knowledge/query.mjs` |  |
| `lexicalScore` | function | ↩ `lib/agentic/knowledge/query.mjs` | Overlap score in [0, 1]: how much of the query the node covers. |
| `salienceWeight` | function | ↩ `lib/agentic/knowledge/query.mjs` |  |
| `confidenceWeight` | function | ↩ `lib/agentic/knowledge/query.mjs` |  |
| `tierWeight` | function | ↩ `lib/agentic/knowledge/query.mjs` | Evidence tier, keeping the corpus's hedging in the ranking. |
| `hubDivisor` | function | ↩ `lib/agentic/knowledge/query.mjs` |  |
| `rankNodes` | function | ↩ `lib/agentic/knowledge/query.mjs` | Ranks candidates by similarity, salience, confidence and tier, damped by inbound degree. |
| `seedNodes` | function | ↩ `lib/agentic/knowledge/query.mjs` | Picks seed nodes from three channels. |
| `expandSubgraph` | function | ↩ `lib/agentic/knowledge/query.mjs` | Bounded BFS. |
| `queryGraph` | function | ↩ `lib/agentic/knowledge/query.mjs` | The undirected neighbourhood of one node, for the explicit-id query form. |
| `retrieveSubgraph` | function | ↩ `lib/agentic/knowledge/query.mjs` | The whole read path: seed → expand → rank. |
| `graphTextSize` | function | ↩ `lib/agentic/knowledge/render.mjs` | Total characters of node text — the size signal the budget tiers read. |
| `renderSectionMap` | function | ↩ `lib/agentic/knowledge/render.mjs` | The map: headings when the graph has them, otherwise the most load-bearing nodes. |
| `renderKnowledgeBlock` | function | ↩ `lib/agentic/knowledge/render.mjs` | Renders a bounded knowledge block for the prompt. |
| `renderWiki` | function | ↩ `lib/agentic/knowledge/render.mjs` | Renders the wiki. |
| `readWikiSha` | function | ↩ `lib/agentic/knowledge/render.mjs` | The graph hash a previously rendered wiki carries, or null. |
| `edgeText` | function | ↩ `lib/agentic/knowledge/render.mjs` | The text form of an edge, shared by the prompt block and the wiki so the two cannot drift. |
| `readTextFile` | function | ↩ `lib/agentic/knowledge/adapters.mjs` | Reads a text-like file. |
| `surfaceFragment` | function | ↩ `lib/agentic/knowledge/adapters.mjs` | Runs one surface's adapter. |
| `documentSurface` | function | ↩ `lib/agentic/knowledge/adapters.mjs` | The `document` surface: one graph from one or more text files. |
| `wikiSurface` | function | ↩ `lib/agentic/knowledge/adapters.mjs` | The `wiki` surface: an existing markdown corpus becomes a reference graph. |
| `memorySurface` | function | ↩ `lib/agentic/knowledge/adapters.mjs` | The `memory` surface: bank facts become `fact` nodes. |
| `todosSurface` | function | ↩ `lib/agentic/knowledge/adapters.mjs` | The `todos` surface: tasks and their declared dependencies. |
| `planSurface` | function | ↩ `lib/agentic/knowledge/adapters.mjs` | The `plan` surface: a task DAG becomes `step` nodes. |
| `mergeFragment` | function | ↩ `lib/agentic/knowledge/adapters.mjs` | Merges adapter output into a graph, skipping ids that already exist. |
| `profileSources` | function | ↩ `lib/agentic/knowledge/profile.mjs` | Measures one or more documents. |
| `proposeOntology` | function | ↩ `lib/agentic/knowledge/profile.mjs` | Turns a measurement into a candidate vocabulary. |
| `ontologySha` | function | ↩ `lib/agentic/knowledge/profile.mjs` | Identity of a proposal: the shape, not the timestamp. |
| `AGENT_KINDS` | const | ↩ `lib/agentic/knowledge/profile.mjs` | Kinds the agent writes and no parse can infer. |
| `MANIFEST_FILE` | const | ↩ `lib/agentic/knowledge/cache.mjs` | The file that records what a build was made from. |
| `manifestPath` | function | ↩ `lib/agentic/knowledge/cache.mjs` |  |
| `readSources` | function | ↩ `lib/agentic/knowledge/cache.mjs` | Reads the sources from disk, in the order given (the order is part of the key). |
| `fingerprintSources` | function | ↩ `lib/agentic/knowledge/cache.mjs` |  |
| `sourceDelta` | function | ↩ `lib/agentic/knowledge/cache.mjs` | What changed between the corpus a graph was built from and the one on disk. |
| `corpusKey` | function | ↩ `lib/agentic/knowledge/cache.mjs` | The build identity: sources by path and content, plus the vocabulary that shaped them and the extractor version. |
| `loadManifest` | function | ↩ `lib/agentic/knowledge/cache.mjs` |  |
| `loadCorpus` | function | ↩ `lib/agentic/knowledge/cache.mjs` | Loads the persisted graph and its manifest. |
| `reanchorDerived` | function | ↩ `lib/agentic/knowledge/cache.mjs` | Moves the agent's nodes from an old graph onto a freshly built one. |
| `syncCorpus` | function | ↩ `lib/agentic/knowledge/cache.mjs` | Load-or-build. |
| `KnowledgeComponent` | class | ↩ `lib/agentic/knowledge/component.mjs` | The knowledge capability. |
| `emptyGraph` | function | ↩ `lib/agentic/knowledge/component.mjs` |  |

#### `lib/agentic/knowledge/model.mjs` — Knowledge graph model — node kinds, relation vocabulary, validation, patching and identity. Pure: no I/O, no m …

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `KNOWLEDGE_SCHEMA` | const | `const KNOWLEDGE_SCHEMA = 'merci.knowledge/v1'` | Schema id carried by `graph.json`. |
| `LEGAL_GRAPH_SCHEMA` | const | `const LEGAL_GRAPH_SCHEMA = 'legalgraph/v1'` | The schema id the legal-skills toolchain writes; accepted on import. |
| `KNOWLEDGE_VERSION` | const | `const KNOWLEDGE_VERSION = 1` | Current model version, bumped when a field changes meaning. |
| `SALIENCE` | const | `const SALIENCE = Object.freeze(['core', 'scope', 'support', 'fluff'])` | Salience ladder, most to least load-bearing. |
| `CONFIDENCE` | const | `const CONFIDENCE = Object.freeze(['high', 'medium', 'low'])` | Confidence ladder. |
| `SAFE_ID` | const | `const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/` | The only ids a node may carry. |
| `isSafeId` | function | `function isSafeId({ id })` |  |
| `TIERS` | const | `const TIERS = Object.freeze(['F', 'A', 'R', 'P'])` | Evidence tiers, from the legal corpus (`F`ull-text verified → `P`rovisional). |
| `EDGE_ORIGINS` | const | `const EDGE_ORIGINS = Object.freeze(['mechanical', 'computed', 'authored'])` | Where an edge came from: a parse, a formula, or a judgement. |
| `EDGE_SHAPES` | const | `const EDGE_SHAPES = Object.freeze(['binary', 'negative', 'conditional', 'evidenc …` | The shapes an edge may take beyond "A rel B". |
| `EDGE_POLARITIES` | const | `const EDGE_POLARITIES = Object.freeze(['positive', 'negative'])` | The only values `edge.polarity` may take. |
| `CORE_RELATIONS` | const | `const CORE_RELATIONS = Object.freeze([ 'contains', 'part_of', 'defines', 'uses', 'm …` | Relations a structural/doc parse or an author may use without a note. |
| `SEMANTIC_RELATIONS` | const | `const SEMANTIC_RELATIONS = Object.freeze([ 'uses', 'obliges', 'permits', 'prohibits', ' …` | Semantic relations assert a reading, so they need a note. |
| `STRUCTURAL_RELATIONS` | const | `const STRUCTURAL_RELATIONS = Object.freeze(['contains', 'part_of', 'defines', 'references …` | Relations that expand freely during traversal (structure, not judgement). |
| `GENERIC_PROFILE` | const | `const GENERIC_PROFILE = Object.freeze({ name: 'generic', kinds: Object.freeze([ 'doc …` | Domain-neutral vocabulary: documents, claims, evidence, work items. |
| `LEGAL_PROFILE` | const | `const LEGAL_PROFILE = Object.freeze({ name: 'legal', kinds: Object.freeze([ 'docum …` | The legal vocabulary the existing corpus uses (`legalgraph/v1`). |
| `PROFILES` | const | `const PROFILES = Object.freeze({ [GENERIC_PROFILE.name]: GENERIC_PROFILE, [LE …` | Every shipped profile by name. |
| `resolveProfile` | function | `function resolveProfile({ profile = null } = {})` | Resolves a profile by name, or accepts a caller-supplied shape. |
| `isKnownKind` | function | `function isKnownKind({ profile, kind })` |  |
| `isKnownRel` | function | `function isKnownRel({ profile, rel })` |  |
| `isCustomRel` | function | `function isCustomRel({ rel })` | `x-` plus a label. |
| `isSemanticRel` | function | `function isSemanticRel({ rel })` |  |
| `hasNote` | function | `function hasNote({ edge })` | A note must say something; `' '` used to satisfy the custom-relation rule. |
| `storedProfile` | function | `function storedProfile({ graph })` | The profile a stored graph declares about itself. |
| `graphSha` | function | `function graphSha({ graph })` | Stable hash of the graph's content. |
| `statsOf` | function | `function statsOf({ nodes, edges })` | Counts nodes, edges, kinds and relation usage. |
| `nodeErrors` | function | `function nodeErrors({ node, ids, profile, sources = null })` | The per-node checks of `validateGraph`, in its order. |
| `edgeErrors` | function | `function edgeErrors({ edge, ids, edgeIds, profile })` | The per-edge checks of `validateGraph`, in its order. |
| `validateGraph` | function | `function validateGraph({ graph = null, profile = null, strict = false, wikiSha = null, sources = null, promoteAfter = LIMITS.knowledge_promote_after } = {})` | Validates a graph. |
| `sourceSlice` | function | `function sourceSlice({ node, sources })` | The exact source text a node points at, when the caller supplied the sources. |
| `applyPatch` | function | `function applyPatch({ graph = null, patch = null, profile = null, now = new Date() } = {})` | Applies a patch: add nodes/edges, update node fields, remove by id. |

#### `lib/agentic/knowledge/profile.mjs` — Structure induction — measure the corpus, propose the shape.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `AGENT_KINDS` | const | `const AGENT_KINDS = Object.freeze(['issue', 'concept', 'evidence', 'note', 'boun …` | Kinds the agent writes and no parse can infer. |
| `profileSources` | function | `function profileSources({ sources = [] } = {})` | Measures one or more documents. |
| `proposeOntology` | function | `function proposeOntology({ profile, minSupport = LIMITS.knowledge_propose_min_support, name = 'derived' } = /** @type {{profile?: DataProfile, minSupport?: number, name?: string}} */ ({}))` | Turns a measurement into a candidate vocabulary. |
| `ontologySha` | function | `function ontologySha({ proposal })` | Identity of a proposal: the shape, not the timestamp. |

#### `lib/agentic/knowledge/query.mjs` — Knowledge retrieval — seed, expand, rank.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `tokensOf` | function | `function tokensOf({ text })` |  |
| `lexicalScore` | function | `function lexicalScore({ query, text })` | Overlap score in [0, 1]: how much of the query the node covers. |
| `salienceWeight` | function | `function salienceWeight({ node })` |  |
| `confidenceWeight` | function | `function confidenceWeight({ node })` |  |
| `tierWeight` | function | `function tierWeight({ node })` | Evidence tier, keeping the corpus's hedging in the ranking. |
| `hubDivisor` | function | `function hubDivisor({ indegree })` |  |
| `rankNodes` | function | `function rankNodes({ graph = null, candidates = [], similarity = new Map(), limit = LIMITS.knowledge_query_max_nodes } = {})` | Ranks candidates by similarity, salience, confidence and tier, damped by inbound degree. |
| `seedNodes` | function | `async function seedNodes({ graph, text = '', ids = [], embedder = null, limit = 12 } = {})` | Picks seed nodes from three channels. |
| `expandSubgraph` | function | `function expandSubgraph({ graph = null, seeds = [], depth = LIMITS.knowledge_query_default_depth, maxNodes = LIMITS.knowledge_query_max_nodes, depths = null } = {})` | Bounded BFS. |
| `queryGraph` | function | `function queryGraph({ graph = null, id = '', depth = 1 } = {})` | The undirected neighbourhood of one node, for the explicit-id query form. |
| `retrieveSubgraph` | function | `async function retrieveSubgraph({ graph, text = '', ids = [], embedder = null, depth, limit } = {})` | The whole read path: seed → expand → rank. |

#### `lib/agentic/knowledge/render.mjs` — Knowledge rendering — the prompt block and the wiki projection.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `graphTextSize` | function | `function graphTextSize({ graph = null } = {})` | Total characters of node text — the size signal the budget tiers read. |
| `edgeText` | function | `function edgeText({ edge, target, arrow })` | The text form of an edge, shared by the prompt block and the wiki so the two cannot drift. |
| `renderSectionMap` | function | `function renderSectionMap({ graph = null, budget = LIMITS.knowledge_query_budget_chars } = {})` | The map: headings when the graph has them, otherwise the most load-bearing nodes. |
| `renderKnowledgeBlock` | function | `function renderKnowledgeBlock({ graph = null, result = null, budget = LIMITS.knowledge_query_budget_chars, query = '' } = {})` | Renders a bounded knowledge block for the prompt. |
| `renderWiki` | function | `function renderWiki({ graph = null, dir = '.knowledge' } = {})` | Renders the wiki. |
| `readWikiSha` | function | `function readWikiSha({ dir = '.knowledge' } = {})` | The graph hash a previously rendered wiki carries, or null. |

#### `lib/agentic/knowledge/store.mjs` — Knowledge store — the canonical `graph.json` and the separate `ontology.json`.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `DEFAULT_KNOWLEDGE_DIR` | const | `const DEFAULT_KNOWLEDGE_DIR = '.knowledge'` | Default directory, matching the `.knowledge` convention of the skill corpus. |
| `knowledgePaths` | function | `function knowledgePaths({ dir = DEFAULT_KNOWLEDGE_DIR } = {})` |  |
| `loadGraph` | function | `async function loadGraph({ dir = DEFAULT_KNOWLEDGE_DIR } = {})` | Loads the graph. |
| `saveGraph` | function | `async function saveGraph({ dir = DEFAULT_KNOWLEDGE_DIR, graph })` | Writes the graph and stamps its stats + hash. |
| `loadOntology` | function | `async function loadOntology({ dir = DEFAULT_KNOWLEDGE_DIR } = {})` | Loads the vocabulary. |
| `saveOntology` | function | `async function saveOntology({ dir = DEFAULT_KNOWLEDGE_DIR, ontology })` | Writes the vocabulary. |
| `adoptOntology` | function | `async function adoptOntology({ dir = DEFAULT_KNOWLEDGE_DIR, proposal = null, expected = null, now = new Date() } = /** @type {{dir?: string, proposal?: import('./profile.mjs').OntologyProposal\|null, expected?: string\|null, now?: Date}} */ ({}))` | Adopts a proposal as the vocabulary. |
| `adoptedProfile` | function | `async function adoptedProfile({ dir = DEFAULT_KNOWLEDGE_DIR } = {})` | The adopted vocabulary as a profile a graph can be validated against, or null when nothing was adopted. |
| `promotableRelations` | function | `function promotableRelations({ graph, promoteAfter })` | Custom relations that appear in enough distinct notes to deserve promotion into the vocabulary. |

#### `lib/agentic/loops/index.mjs` — Supervisory-loop policy + judge exports.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `FailureClass` | const | ↩ `lib/agentic/loops/policy.mjs` | The failure taxonomy: the classification labels returned by classifyFailure(). |
| `failureFingerprint` | function | ↩ `lib/agentic/loops/policy.mjs` | Stable key for "is this the same failed attempt as before?". |
| `RetryLedger` | class | ↩ `lib/agentic/loops/policy.mjs` | Retry budget keyed by failure fingerprint, NOT by a global counter. |
| `classifyFailure` | function | ↩ `lib/agentic/loops/policy.mjs` | permission/environment boundaries are checked before verification outcomes (a failed command may be a blocked path, not a bad patch). |
| `claimReplan` | function | ↩ `lib/agentic/loops/policy.mjs` | budget is spent, else `onClaim(next, label)` with the incremented count and `[replan next/max]` label. |
| `stateFingerprint` | function | ↩ `lib/agentic/loops/policy.mjs` | same fingerprint — used to catch oscillation, not just consecutive stalls. |
| `compareProgress` | function | ↩ `lib/agentic/loops/policy.mjs` | Compares two progress snapshots — a positive score means the run moved forward. |
| `createLlmJudge` | function | ↩ `lib/agentic/loops/judge.mjs` | Returns `(ctx) => ({ passed, evidence })` ready for a LoopContract `judge`. |
| `createScoredJudge` | function | ↩ `lib/agentic/loops/judge.mjs` | A typed, scored grader. |

#### `lib/agentic/loops/judge.mjs` — LLM completion judge factory — the "optional model reviewer" half of the verification story. Deterministic cri …

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `JUDGE_SCHEMA` | const | `const JUDGE_SCHEMA = z.strictObject({ passed: z.boolean(), evidence: z.string() } …` |  |
| `createLlmJudge` | function | `function createLlmJudge({ client, model, criteria = [] })` | Returns `(ctx) => ({ passed, evidence })` ready for a LoopContract `judge`. |
| `createScoredJudge` | function | `function createScoredJudge({ client, model, schema, systemMessage, scoreField = 'score', aggregate })` | A typed, scored grader. |

#### `lib/agentic/loops/policy.mjs` — Supervisory loop policy primitives (pure, no LLM, no IO).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `FailureClass` | const | `const FailureClass = Object.freeze({ TRANSIENT_INFRASTRUCTURE: 'transient_infrast …` | The failure taxonomy: the classification labels returned by classifyFailure(). |
| `failureFingerprint` | function | `function failureFingerprint({ action = '', input = '', signature = '' } = {})` | Stable key for "is this the same failed attempt as before?". |
| `RetryLedger` | class | `class RetryLedger` | Retry budget keyed by failure fingerprint, NOT by a global counter. |
| `claimReplan` | function | `function claimReplan({ used, max, onExhausted, onClaim })` | budget is spent, else `onClaim(next, label)` with the incremented count and `[replan next/max]` label. |
| `classifyFailure` | function | `function classifyFailure({ evidence = {} } = {})` | permission/environment boundaries are checked before verification outcomes (a failed command may be a blocked path, not a bad patch). |
| `failureEvidence` | function | `function failureEvidence({ result })` | Build the evidence `classifyFailure` consumes from a normalized run result. |
| `stateFingerprint` | function | `function stateFingerprint({ snapshot = {} } = {})` | same fingerprint — used to catch oscillation, not just consecutive stalls. |
| `compareProgress` | function | `function compareProgress({ previous = {}, current = {} } = {})` | Compares two progress snapshots — a positive score means the run moved forward. |

#### `lib/agentic/memory/component.mjs` — Memory capability — load/save tool component.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `MemoryComponent` | class | `class MemoryComponent extends LoadableComponent` | The memory capability component: long-term recall/persist exposed as the memory load/save tools. |

#### `lib/agentic/memory/engine.mjs` — ProviderMemoryEngine — the memory component's engine.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ProviderMemoryEngine` | class | `class ProviderMemoryEngine` | Memory engine over a single provider. |

#### `lib/agentic/memory/index.mjs` — Memory subsystem public exports.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `MemoryProvider` | class | ↩ `lib/agentic/memory/providers.mjs` | Base memory provider contract. |
| `LocalFileMemoryProvider` | class | ↩ `lib/agentic/memory/providers.mjs` | File-backed memory bank: one JSON file of facts with atomic saves. |
| `SqliteMemoryProvider` | class | ↩ `lib/agentic/memory/providers.mjs` | SQLite-backed memory bank. |
| `CompositeMemoryProvider` | class | ↩ `lib/agentic/memory/providers.mjs` | Fan-out memory provider across named banks. |
| `MemoryManager` | class | ↩ `lib/agentic/memory/manager.mjs` | Coordinates long-term memory: sync-gap detection, fire-and-forget distillation of new conversation turns, and per-step memory block rendering. |
| `ProviderMemoryEngine` | class | ↩ `lib/agentic/memory/engine.mjs` | Memory engine over a single provider. |
| `MemoryComponent` | class | ↩ `lib/agentic/memory/component.mjs` | The memory capability component: long-term recall/persist exposed as the memory load/save tools. |

#### `lib/agentic/memory/manager.mjs` — A provider's stored facts, when it keeps a bank the block renderer can show.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `MemoryManager` | class | `class MemoryManager` | Coordinates long-term memory: sync-gap detection, fire-and-forget distillation of new conversation turns, and per-step memory block rendering. |

#### `lib/agentic/memory/providers.mjs` — Memory providers + block renderers.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `escapePromptField` | function | `function escapePromptField({ value })` |  |
| `formatFactBullets` | function | `function formatFactBullets({ facts, bank = null })` | distillation history. |
| `buildMemoryBlock` | function | `function buildMemoryBlock({ facts, gap = 0, lastSync = 0, currentCount = 0 })` | unsynced-turns lag warning + footer. |
| `ENGINE_PROVIDER_METHODS` | const | `const ENGINE_PROVIDER_METHODS = ['query', 'store']` |  |
| `assertProvider` | function | `function assertProvider({ provider, owner, requiredMethods = MANAGER_PROVIDER_METHODS })` | methods. |
| `MemoryProvider` | class | `class MemoryProvider` | Base memory provider contract. |
| `LocalFileMemoryProvider` | class | `class LocalFileMemoryProvider extends MemoryProvider` | File-backed memory bank: one JSON file of facts with atomic saves. |
| `SqliteMemoryProvider` | class | `class SqliteMemoryProvider extends LocalFileMemoryProvider` | SQLite-backed memory bank. |
| `CompositeMemoryProvider` | class | `class CompositeMemoryProvider extends MemoryProvider` | Fan-out memory provider across named banks. |

#### `lib/agentic/memory/rerank.mjs` — Decision-gate reranker for the memory vector tier.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createDecisionReranker` | function | `function createDecisionReranker({ ask = null, instructions = 'Is this memory fact relevant to the query?', threshold = LIMITS.decision_gate_threshold, maxCandidates = 5, emitter = null } = {})` | Builds the `reranker` option `LocalFileMemoryProvider` accepts. |

#### `lib/agentic/objective.mjs` — Objective policy + the restatement pass.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `DEFAULT_OBJECTIVE_POLICY` | const | `const DEFAULT_OBJECTIVE_POLICY = Object.freeze({ adaptable: true, hitl: false, // Read throug …` | Cadence + gating defaults. |
| `normalizeObjectivePolicy` | function | `function normalizeObjectivePolicy({ opts = null } = {})` | Merges caller options over the defaults. |
| `shouldRunObjectivePass` | function | `function shouldRunObjectivePass({ policy, turn })` | it (default 1, 11, 21, ...). |
| `OBJECTIVE_RESTATE_HEADER` | const | `const OBJECTIVE_RESTATE_HEADER = 'You maintain the working objective of an ongoing agent run. …` | First line of the restatement prompt — the discriminator for `isObjectiveRestatePrompt`. |
| `isObjectiveRestatePrompt` | function | `function isObjectiveRestatePrompt({ input })` | not a message array). |
| `objectiveRestatePrompt` | function | `function objectiveRestatePrompt({ objective, progress })` | The restatement prompt. |
| `objectiveProgressDigest` | function | `function objectiveProgressDigest({ messages = [] } = {})` | intake on the first pass, the work after it) plus the last assistant text. |
| `runObjectivePass` | function | `async function runObjectivePass({ p })` | runs it before building a step prompt). |
| `restateObjective` | function | `async function restateObjective({ client, model, objective, progress = '', signal = null, sessionId = null, pool = null })` | One bounded restatement call. |

#### `lib/agentic/operator/http.mjs` — Mountable HTTP handler for the operator API.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createOperatorHttpHandler` | function | `function createOperatorHttpHandler({ getSnapshot, getPolicySnapshot = null, refresh = null, recentEvents = null, basePath = '/api/v1', statusPath = '/', allowedHosts = ['localhost', '127.0.0.1', '::1'], allowAnyHost = false, maxBodyBytes = LIMITS.operator_max_body_bytes, recentEventsLimit = LIMITS.operator_recent_events_limit, statusMaxRows = LIMITS.operator_status_max_rows, now = Date.now } = /** @type {never} */ ({}))` | Create a `(req, res) => Promise<void>` operator handler (§3.3). |

#### `lib/agentic/operator/index.mjs` — Public surface of the operator API modules.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `OPERATOR_API_VERSION` | const | `const OPERATOR_API_VERSION = 1` | The operator API response version. |
| `OPERATOR_DEFAULTS` | const | `const OPERATOR_DEFAULTS = Object.freeze({ basePath: '/api/v1', statusPath: '/', get ma …` | The documented defaults for `createOperatorHttpHandler` (§3.8). |
| `createEventRing` | function | ↩ `lib/agentic/operator/ring.mjs` | emitter?: unknown, limit?: number, prefixes?: ReadonlyArray<string>, now?: () => number }} [arg0] |
| `DEFAULT_PREFIXES` | const | ↩ `lib/agentic/operator/ring.mjs` | The orchestrator namespaces the ring records by default. |
| `formatStatus` | function | ↩ `lib/agentic/operator/status.mjs` | Render one snapshot as plain text (§3.7). |
| `createOperatorHttpHandler` | function | ↩ `lib/agentic/operator/http.mjs` | Create a `(req, res) => Promise<void>` operator handler (§3.3). |

#### `lib/agentic/operator/ring.mjs` — Bounded in-memory ring over the orchestration event namespaces.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `DEFAULT_PREFIXES` | const | `const DEFAULT_PREFIXES = Object.freeze(['scheduler:', 'work_item:', 'workspace:', 'wo …` | The orchestrator namespaces the ring records by default. |
| `projectEventRecord` | function | `function projectEventRecord({ envelope, event: eventName, now = Date.now } = {})` | The allowlist projection, applied both at insert and at the API boundary. |
| `createEventRing` | function | `function createEventRing({ emitter, limit = LIMITS.operator_ring_limit, prefixes = DEFAULT_PREFIXES, now = () => Date.now() } = {})` | emitter?: unknown, limit?: number, prefixes?: ReadonlyArray<string>, now?: () => number }} [arg0] |

#### `lib/agentic/operator/status.mjs` — Plain-text status renderer for a terminal or `curl`.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `formatStatus` | function | `function formatStatus({ snapshot, policy = null, now = Date.now, maxRows = LIMITS.operator_status_max_rows } = {})` | Render one snapshot as plain text (§3.7). |

#### `lib/agentic/operator/view.mjs` — Pure projections from the scheduler snapshot to the operator API shapes.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `toIso` | function | `function toIso(value)` | Parse an epoch-ms number, a `Date`, or a date string into an ISO 8601 string. |
| `toStateResponse` | function | `function toStateResponse({ snapshot, policy = null, now = Date.now } = {})` | The state response (§3.4). |
| `toItemResponse` | function | `function toItemResponse({ snapshot, id, now = Date.now, events = null, eventsLimit = LIMITS.operator_recent_events_limit } = {})` | One item's detail (§3.4). |

#### `lib/agentic/orchestration/facade.mjs` — `createOrchestration`: the composition root for the coordination layer.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createItemTools` | function | `function createItemTools({ approval = null, eventEmitter = null, permissionMode = 'default' } = {})` | The default per-item tool binder. |
| `createOrchestration` | function | `async function createOrchestration(options = /** @type {never} */ ({}))` | Build the coordination layer around one client, one board, and one `WORKFLOW.md`. |

#### `lib/agentic/orchestration/index.mjs` — Public surface of the orchestration composition root.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createOrchestration` | function | ↩ `lib/agentic/orchestration/facade.mjs` | Build the coordination layer around one client, one board, and one `WORKFLOW.md`. |

#### `lib/agentic/pending-inbox.mjs` — The parent inbox (wave 6 / SP3) — placing a background result into the next turn.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `interleavePendingRows` | function | `function interleavePendingRows({ rows, pending })` | Places the queued inbox rows into a turn's message list. |
| `claimInboxRows` | function | `function claimInboxRows({ session, rows, onClaim = null })` | Takes `rows` out of the inbox. |
| `restoreInboxRows` | function | `function restoreInboxRows({ session, rows })` | Puts `rows` back at the FRONT of the inbox, so a restored row is delivered before anything that landed while the failed turn was in flight. |
| `normalizeDelivery` | function | `function normalizeDelivery({ delivery })` | The one delivery enum: `steer` reaches a RUNNING turn at its next step boundary, `queue` waits for the next turn. |
| `listInboxRows` | function | `function listInboxRows({ session })` | The rows still waiting, in delivery order — a snapshot, so a caller cannot mutate the queue it is rendering. |
| `cancelInboxRow` | function | `function cancelInboxRow({ session, input })` | Drops one pending row. |
| `setInboxRowDelivery` | function | `function setInboxRowDelivery({ session, input, delivery })` | Switches a pending row between `steer` and `queue`, which is what a queue panel's toggle does before the turn claims it. |
| `claimSteerRows` | function | `function claimSteerRows({ session, onClaim = null })` | Claims the `delivery: 'steer'` rows for a step boundary. |
| `isSubmittedInput` | function | `function isSubmittedInput(row)` | A row the host submitted for this run. |
| `claimTurnRows` | function | `function claimTurnRows({ session, onClaim = null, includeBackground = false })` | Claims the rows for ONE turn: every `steer` row still waiting, plus the FIRST `queue` row. |
| `claimInboxTurn` | function | `function claimInboxTurn({ session, budget, onClaim = null, onExhausted = null, includeBackground = false })` | Claims the rows for ONE inbox-driven turn, or leaves them pending when the run's budget is spent. |

#### `lib/agentic/permissions.mjs` — Tool permission rules.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `PERMISSION_MODES` | const | `const PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'bypassPermissions' …` | The permission modes this SDK understands. |
| `matchesGlob` | function | `function matchesGlob({ name, pattern })` | Matches a name against a glob pattern (`*` matches any run of characters). |
| `isToolPermitted` | function | `function isToolPermitted({ name, allow = [], deny = [] })` | Whether a tool name passes the allow / deny lists. |
| `isEditTool` | function | `function isEditTool({ name })` | Whether a tool name looks like an edit (write / patch / delete / move). |
| `stillRequiresApproval` | function | `function stillRequiresApproval({ name, mode = 'default', requiresApproval, tool = null })` | Whether a gated tool still has to ask under the given permission mode. |
| `normalizePermissionRules` | function | `function normalizePermissionRules({ rules })` | Normalizes a caller-supplied rule bag into the canonical shape. |

#### `lib/agentic/plan/component.mjs` — Plan agent — read-only planning phase with an approval-gated handoff.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `AGENT_PLAN` | const | `const AGENT_PLAN = 'plan'` | Plan-agent identity (read-only). |
| `AGENT_EXECUTE` | const | `const AGENT_EXECUTE = 'execute'` | Execute-agent identity (full tool set). |
| `isToolAllowed` | function | `function isToolAllowed({ name, rules })` | the `*` wildcard is the fallback, and a nameless tool is never allowed. |
| `createPlanExitTool` | function | `function createPlanExitTool({ session })` | emits `plan:exit_requested` before waiting and `plan:exit_resolved` after. |
| `createPlanStageFollowUp` | function | `function createPlanStageFollowUp({ session })` | until plan_exit has been called this run. |

#### `lib/agentic/planning/approval.mjs` — ApprovalCoordinator — HITL approval gate.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ApprovalCoordinator` | class | `class ApprovalCoordinator` | A single HITL approval gate. |

#### `lib/agentic/planning/checkpoint.mjs` — Unified checkpoint envelope.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `CHECKPOINT_VERSION` | const | `const CHECKPOINT_VERSION = 1` | Current envelope format version; a mismatched record is refused on restore. |
| `CHECKPOINT_KIND` | const | `const CHECKPOINT_KIND = Object.freeze({ CHAT: 'chat', STATE_MACHINE: 'stateMachine', …` | Checkpoint payload kinds. |
| `wrapCheckpoint` | function | `function wrapCheckpoint({ kind, payload })` | Tags a payload string with its kind. |
| `unwrapCheckpoint` | function | `function unwrapCheckpoint({ saved })` | Reads a checkpoint envelope back out of a saved record. |
| `saveCheckpoint` | function | `async function saveCheckpoint({ store, threadId, kind, payload })` | Saves a tagged checkpoint through a session store. |
| `restoreCheckpoint` | function | `function restoreCheckpoint({ saved, kind, args = [] })` | Restores a checkpoint of the expected kind. |

#### `lib/agentic/planning/evaluator.mjs` — WorkflowEvaluator — per-step output quality audit.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WorkflowEvaluator` | class | `class WorkflowEvaluator` | Structured LLM verifier for completed workflow steps. |

#### `lib/agentic/planning/executor-helpers.mjs` — Pure helpers lifted out of WorkflowExecutor.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `capSessionRow` | function | `function capSessionRow({ row, cap })` | Caps one conversation row's text without changing its shape. |
| `schemaViolation` | function | `function schemaViolation({ schema, node, result })` | Returns a VerificationError when the step's output violates `schema`, else null. |
| `danglingDependencies` | function | `function danglingDependencies({ steps, knownSteps })` | `stepId→dep` pairs whose dependency names nothing in the new plan and no known step in the run. |
| `retrySchemaViolation` | function | `function retrySchemaViolation({ host, node, attempt, maxRetries, error, stepCtx })` | One schema-violation retry, shared by the four engines: emits the retry notice and returns the correction for the next attempt's prompt. |
| `retryVerification` | function | `function retryVerification({ host, node, attempt, maxRetries, verdict, stepCtx })` | One verify-verdict tail, shared by the four engines. |
| `recordOrRethrow` | function | `function recordOrRethrow({ host, node, err, stepCtx })` | The whole-method catch of every engine: a budget stop and an abort the step did not cause propagate, everything else is recorded as the step's failure so the run can continue. |
| `decisionStepVerdict` | function | `async function decisionStepVerdict({ gate, node, outputs, objective = null, signal = null })` | One decision-gate verdict on a completed step (the evaluator-outage seam). |
| `decisionTokensOf` | function | `function decisionTokensOf({ result = null })` | The tokens one decision-gate call cost, from the wire usage or the state size. |

#### `lib/agentic/planning/executor-plan.mjs` — Plan-lifecycle cluster of WorkflowExecutor.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `rejectPlan` | function | `function rejectPlan({ host, message })` | Rejects a plan with a `workflow:failed` event and a ConfigurationError. |
| `validateStepTemplates` | function | `function validateStepTemplates({ host, steps, knownIds = [], quiet = false, graph = null, ancestryOnly = false })` | Validates every step's template references against known step ids, the run's shared context keys, and the C1 rule: a step id a step reads must be one of its **ancestors**. |
| `cleanOutputs` | function | `function cleanOutputs({ host })` | JSON map of the completed step outputs (the `data` half). |
| `currentPlan` | function | `function currentPlan({ host })` | The guiding plan as the caller can inspect it: every node the run knows, history included (a retained completed node still satisfies dependencies). |
| `completedIds` | function | `function completedIds({ host })` | Ids of completed nodes the run still holds as **accepted** evidence (history included). |
| `liveStepList` | function | `function liveStepList({ host })` |  |
| `planProgress` | function | `function planProgress({ host })` | Where the run actually is — the part the per-step evaluator never sees. |
| `assertPatchIsValid` | function | `function assertPatchIsValid({ host, steps })` | A patch must leave a runnable DAG before it is installed. |
| `evaluatePlan` | function | `async function evaluatePlan({ host, trigger = 'wave' })` | The plan gate (PL2b). |
| `applyEvaluatorPatch` | function | `function applyEvaluatorPatch({ host, result, trigger })` | Applies a plan evaluator's patch through the same machinery as any plan (historical retention, fingerprint invalidation, dangling rejection). |
| `planSnapshot` | function | `function planSnapshot({ host })` |  |
| `assertNoDanglingDependencies` | function | `function assertNoDanglingDependencies({ host, steps })` | Rejects a plan whose dependency names nothing. |
| `validateReplanSteps` | function | `function validateReplanSteps({ host, steps, rejectedId = null })` | Validates a replanned step list: dependencies resolve, `replaces` declarations are sound, and template refs name an ancestor. |
| `applyReplan` | function | `async function applyReplan({ host, node, reason, planner })` |  |
| `requeueStep` | function | `function requeueStep({ host, stepId, status })` | Re-queues a step still in `status` after a plan rewrite so it is re-run and re-verified instead of being shipped. |
| `resetInvalidatedStep` | function | `function resetInvalidatedStep({ host, stepId })` | Resets a step and its already-completed dependents to pending, dropping their outputs and verification marks so they re-run and are re-verified against the new upstream output instead of shipping a stale result. |

#### `lib/agentic/planning/executor-session.mjs` — Session-group cluster of WorkflowExecutor.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `sharedSessionGroupKey` | function | `function sharedSessionGroupKey({ host, node })` | The key of the group a step will join when that group is SHARED — a plan or branch scope, or an explicit group annotation. |
| `sessionGroupKey` | function | `function sessionGroupKey({ host, node, attempt })` | Which session group a step attempt joins. |
| `sessionGroupGate` | function | `async function sessionGroupGate({ host, key })` | One conversation runs one attempt at a time. |
| `branchGroupKey` | function | `function branchGroupKey({ host, node })` | The nearest ancestor (or the node itself) that opens a branch scope: a plan root or a node with more than one dependant. |
| `sessionGroup` | function | `function sessionGroup({ host, key, node, model, boundary = false })` | Looks up (or opens) a session group. |
| `sharedSessionRows` | function | `function sharedSessionRows({ host, group, node })` | The rows a member may inherit from its group: **ancestors only** (the C1 contract — a step never reads a sibling branch), in plan order (so a run with `maxConcurrency > 1` produces the same prompt as a serial one), capped so a long plan cannot blow the context budget. |
| `rememberSessionRows` | function | `function rememberSessionRows({ group, stepId, rows })` | Records a member's completed exchange in the group, replacing its earlier entry (a retry's transcript already contains the rows it had produced). |
| `forgetSessionRows` | function | `function forgetSessionRows({ host, stepId })` | Drops a step's rows from every group. |
| `applySessionContract` | function | `function applySessionContract({ host, group, node, model, systemPrompt, toolsSignature, stepCtx })` | Enforces the group's prompt/tools contract. |
| `lostStepFunctions` | function | `function lostStepFunctions({ node })` | The function-valued fields a checkpoint could not carry and the step no longer has: a `verify` gate and per-step `tools`. |
| `warnLostStepFunctions` | function | `function warnLostStepFunctions({ host })` | Warns when a resumed step had a `verify` gate or per-step `tools` that the checkpoint could not carry (functions are not serializable). |

#### `lib/agentic/planning/executor-strategies.mjs` — Step-strategy cluster of WorkflowExecutor.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `resolveVerify` | function | `function resolveVerify({ host, node })` | One verify resolution for every engine: a step's own `verify` wins, otherwise the executor contract's criteria/judge. |
| `retryEmpty` | function | `function retryEmpty({ host, node, attempt, maxRetries, stepCtx, detail })` |  |
| `classifyFallback` | function | `function classifyFallback({ host, node, result, attempt, maxRetries, stepCtx })` |  |
| `schemaViolation` | function | `function schemaViolation({ host, node, result })` | Returns a VerificationError when the step's output violates `stateSchema`, else null. |
| `executeStepNodeNaive` | function | `async function executeStepNodeNaive({ host, node, stepCtx = host._runCtx })` |  |
| `wireStepSMEvents` | function | `function wireStepSMEvents({ host, sm, node, stepCtx })` |  |
| `executeStepNodeSM` | function | `async function executeStepNodeSM({ host, node, stepCtx = host._runCtx })` |  |
| `wireDiscussionEvents` | function | `function wireDiscussionEvents({ host, group, node, stepCtx })` |  |
| `executeStepNodeDiscussion` | function | `async function executeStepNodeDiscussion({ host, node, stepCtx = host._runCtx })` |  |
| `decompositionObjective` | function | `function decompositionObjective({ host, node, subObjective })` | PL1c: what a `decompose` node's planner sees — its own brief, the outputs its ancestors produced, and the plan that is still pending. |
| `wireNestedEvents` | function | `function wireNestedEvents({ host, child, node, stepCtx })` |  |
| `executeStepNodeDag` | function | `async function executeStepNodeDag({ host, node, stepCtx = host._runCtx })` |  |
| `remainingBudget` | function | `function remainingBudget({ host, stepCtx = host._runCtx })` | Returns the token budget the next step may spend — the remaining cap shared between the step and its wave siblings — or throws `BudgetExceededError` if cumulative tokens have already exhausted it. |
| `recordWorkflowTokens` | function | `function recordWorkflowTokens({ host, tokens, costUsd = 0, stepCtx = host._runCtx })` | Accumulates tokens and USD spent by a step and enforces the workflow-wide caps. |
| `recordStepUsage` | function | `function recordStepUsage({ host, node, usage })` | Adds one attempt's reported usage onto the step record (B7), so "what did step X cost" is answerable per step and survives a checkpoint. |
| `chargeSessionUsage` | function | `function chargeSessionUsage({ host, session, node = null, stepCtx = host._runCtx, err = null })` | Charges the usage a failed session run still consumed. |

#### `lib/agentic/planning/executor.mjs` — WorkflowExecutor — DAG step execution + evaluator replan + HITL gates.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WorkflowExecutor` | class | `class WorkflowExecutor extends EventEmitter` | Executes a DAG of steps to completion, emitting `workflow:*` events on its EventEmitter. |

#### `lib/agentic/planning/graph-utils.mjs` — DAG graph utilities — sort, interpolation, leaf output.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `walkPath` | function | `function walkPath({ value, parts })` | Walks a dotted path through an object (prototype-key safe via Object.hasOwn). |
| `stringifyTemplateValue` | function | `function stringifyTemplateValue({ value })` | Renders a template value as text. |
| `stepFingerprint` | function | `function stepFingerprint({ step })` | Stable identity of a step DEFINITION, **ignoring function-valued fields**. |
| `stepFnSources` | function | `function stepFnSources({ step })` | The source text of every function in a step definition, keyed by its path. |
| `fnSourcesDiffer` | function | `function fnSourcesDiffer({ saved, next, missingIsChange = false })` | True when a function-valued field of the new definition differs from the one the saved fingerprint was taken from — including a function the new definition ADDS. |
| `sortDagNodes` | function | `function sortDagNodes({ steps })` | Kahn's topological sort of the given steps. |
| `ancestorIds` | function | `function ancestorIds({ nodes, dependencies })` | The transitive dependency set of one node — the only steps whose outputs it may read (C1). |
| `interpolateTemplate` | function | `function interpolateTemplate({ template, outputs, stepId, emitter, context = {}, known = null })` | Interpolates `{{expr}}` references in a template against step outputs and run context (dotted paths supported). |
| `collectTemplateRefs` | function | `function collectTemplateRefs({ template })` | Collects `{{expr}}` template references from a string. |
| `validateTemplateRefs` | function | `function validateTemplateRefs({ steps, contextRoots = ['context'], fields = ['userPromptTemplate', 'subObjective'], knownIds = [], ancestorsOnly = false, graph = null })` | Validates that every `{{...}}` reference in each step's `userPromptTemplate` names a known step id or an allowed context root, and — with `ancestorsOnly` — that a step id it names is one of that step's **ancestors**. |
| `assertStateSchema` | function | `function assertStateSchema({ schema, value, label })` | Asserts a step/node output against an optional Zod-like state schema (`safeParse`). |
| `stateSchemaViolation` | function | `function stateSchemaViolation({ schema, value, label })` | Non-throwing form of {@link assertStateSchema}: the `VerificationError` a violation would raise, or null when the value satisfies the schema (or no schema is configured). |
| `getLeafOutput` | function | `function getLeafOutput({ stepsMap, outputs })` | Returns the last (leaf) healthy step output from a completed workflow. |

#### `lib/agentic/planning/index.mjs` — DAG workflow planning public exports.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `sortDagNodes` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Kahn's topological sort of the given steps. |
| `interpolateTemplate` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Interpolates `{{expr}}` references in a template against step outputs and run context (dotted paths supported). |
| `getLeafOutput` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Returns the last (leaf) healthy step output from a completed workflow. |
| `collectTemplateRefs` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Collects `{{expr}}` template references from a string. |
| `validateTemplateRefs` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Validates that every `{{...}}` reference in each step's `userPromptTemplate` names a known step id or an allowed context root, and — with `ancestorsOnly` — that a step id it names is one of that step's **ancestors**. |
| `assertStateSchema` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Asserts a step/node output against an optional Zod-like state schema (`safeParse`). |
| `ApprovalCoordinator` | class | ↩ `lib/agentic/planning/approval.mjs` | A single HITL approval gate. |
| `WorkflowPlanner` | class | ↩ `lib/agentic/planning/planner.mjs` | LLM DAG planner: produces the step plan and the self-healing replan. |
| `WorkflowExecutor` | class | ↩ `lib/agentic/planning/executor.mjs` | Executes a DAG of steps to completion, emitting `workflow:*` events on its EventEmitter. |
| `WorkflowEvaluator` | class | ↩ `lib/agentic/planning/evaluator.mjs` | Structured LLM verifier for completed workflow steps. |
| `Plan` | class | ↩ `lib/agentic/planning/plan.mjs` | One plan, two executor views. |
| `PLAN_VERSION` | const | ↩ `lib/agentic/planning/plan.mjs` |  |
| `TaskState` | class | ↩ `lib/agentic/planning/task-state.mjs` | The serializable state of one workflow (DAG) run. |
| `CHECKPOINT_KIND` | const | ↩ `lib/agentic/planning/checkpoint.mjs` | Checkpoint payload kinds. |
| `wrapCheckpoint` | function | ↩ `lib/agentic/planning/checkpoint.mjs` | Tags a payload string with its kind. |
| `unwrapCheckpoint` | function | ↩ `lib/agentic/planning/checkpoint.mjs` | Reads a checkpoint envelope back out of a saved record. |
| `saveCheckpoint` | function | ↩ `lib/agentic/planning/checkpoint.mjs` | Saves a tagged checkpoint through a session store. |
| `restoreCheckpoint` | function | ↩ `lib/agentic/planning/checkpoint.mjs` | Restores a checkpoint of the expected kind. |

#### `lib/agentic/planning/plan-patch.mjs` — Plan patches — a replan edits the plan instead of replacing it.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `PLAN_PATCH_OPS` | const | `const PLAN_PATCH_OPS = Object.freeze(['add', 'remove', 'rewire', 'replace', 'split' …` | The operations a patch may carry. |
| `applyPlanPatch` | function | `function applyPlanPatch({ steps, patch, allowRemoveCompleted = false, completedIds = [] })` | Applies a patch to a step list, all or nothing. |
| `diffStepsToPatch` | function | `function diffStepsToPatch({ previous, next })` | Converts a whole-list planner response into a patch against the current plan. |

#### `lib/agentic/planning/plan.mjs` — Plan — the guiding artifact both executors project onto.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `PLAN_VERSION` | const | `const PLAN_VERSION = 1` |  |
| `Plan` | class | `class Plan` | One plan, two executor views. |

#### `lib/agentic/planning/planner-utils.mjs` — The session surface these helpers drive: configure it, then run one turn.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `describeParseFailure` | function | `function describeParseFailure({ parsed })` |  |
| `normalizePlanSteps` | function | `function normalizePlanSteps({ steps })` |  |
| `utilitySession` | function | `function utilitySession({ client, model, systemMessage = null, parameters = null, sessionId = null })` |  |
| `structuredLlmCall` | function | `async function structuredLlmCall({ client, model, systemMessage, schema, prompt, label = '', schemaName = 'plan', useToolCapture, maxAttempts = LIMITS.planner_max_attempts, timeoutMs = LIMITS.structured_call_timeout_ms, sessionId, signal, onUsage = null })` | Calls the LLM and returns structured data matching `schema`. |

#### `lib/agentic/planning/planner.mjs` — WorkflowPlanner — LLM DAG plan/replan.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WorkflowPlanner` | class | `class WorkflowPlanner` | LLM DAG planner: produces the step plan and the self-healing replan. |

#### `lib/agentic/planning/task-state.mjs` — TaskState — the serializable cross-stage carrier for a DAG run.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `TASK_STATE_VERSION` | const | `const TASK_STATE_VERSION = 1` | Current snapshot format version; a mismatched payload is rejected on load. |
| `TaskState` | class | `class TaskState` | The serializable state of one workflow (DAG) run. |

#### `lib/agentic/pooled-client.mjs` — A client view that attaches a scheduler attempt's ledger to the sessions an engine creates.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `attachSessionPool` | function | `function attachSessionPool({ session, pool, share = false, ownBudget = false })` | Joins `session` to `pool` (an attempt ledger or a session's owner pool). |
| `pooledClient` | function | `function pooledClient({ client, pool })` | A client view whose sessions join the attempt ledger. |
| `releaseAttemptLedger` | function | `function releaseAttemptLedger({ pool })` | Detaches this attempt's ledger from the sessions it attached and clears the parent links of the owner ledgers it borrowed the report from. |

#### `lib/agentic/scheduler/attempt-store.mjs` — Attempt stores: the counters and park state a restart must not lose.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `ATTEMPT_RECORD_VERSION` | const | `const ATTEMPT_RECORD_VERSION = 1` | The record format discriminator. |
| `createMemoryAttemptStore` | function | `function createMemoryAttemptStore()` | In-process attempt store. |
| `createFileAttemptStore` | function | `function createFileAttemptStore({ dir } = {})` | File-backed attempt store: one `<slug>.<hash>.json` per identifier. |

#### `lib/agentic/scheduler/claims.mjs` — Claim stores: the in-process map and the O_EXCL claim file.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `activateClaimOwner` | function | `function activateClaimOwner({ owner })` | Register an owner token as live. |
| `deactivateClaimOwner` | function | `function deactivateClaimOwner({ owner })` | Drop an owner token: the instance that used it has stopped, so any claim file still naming it is nobody's live claim. |
| `createMemoryClaimStore` | function | `function createMemoryClaimStore()` | In-process claim store. |
| `createFileClaimStore` | function | `function createFileClaimStore({ dir, staleMs = LIMITS.claim_stale_ms, hostId = hostname(), now = Date.now } = {})` | File-backed claim store: one `<key>.json` per identifier. |

#### `lib/agentic/scheduler/index.mjs` — Public surface of the scheduler modules.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `normalizeWorkItem` | function | ↩ `lib/agentic/scheduler/normalize.mjs` | Normalize one raw adapter record into a frozen `WorkItem`. |
| `sortForDispatch` | function | ↩ `lib/agentic/scheduler/normalize.mjs` | Order items for dispatch without mutating the input. |
| `createMemoryWorkSource` | function | ↩ `lib/agentic/scheduler/work-sources/index.mjs` | Create a work source over an in-memory array. |
| `createJsonFileWorkSource` | function | ↩ `lib/agentic/scheduler/work-sources/index.mjs` | Create a read-only work source over a directory of `*.json` files. |
| `createFunctionWorkSource` | function | ↩ `lib/agentic/scheduler/work-sources/index.mjs` | Create a work source backed by two host functions. |
| `createTodoWorkSource` | function | ↩ `lib/agentic/scheduler/work-sources/index.mjs` | Create a read-only work source over a `TodoComponent`-style store. |
| `WORK_SOURCE_CATEGORIES` | const | ↩ `lib/agentic/scheduler/work-sources/index.mjs` | The Symphony §11.4 categories, in their canonical order. |
| `createMemoryClaimStore` | function | ↩ `lib/agentic/scheduler/claims.mjs` | In-process claim store. |
| `createFileClaimStore` | function | ↩ `lib/agentic/scheduler/claims.mjs` | File-backed claim store: one `<key>.json` per identifier. |
| `createMemoryAttemptStore` | function | ↩ `lib/agentic/scheduler/attempt-store.mjs` | In-process attempt store. |
| `createFileAttemptStore` | function | ↩ `lib/agentic/scheduler/attempt-store.mjs` | File-backed attempt store: one `<slug>.<hash>.json` per identifier. |
| `WorkScheduler` | class | ↩ `lib/agentic/scheduler/scheduler.mjs` | The work-item scheduler: claims, dispatch, retries, parking, and a single-flight tick. |
| `createEngineRunner` | function | ↩ `lib/agentic/scheduler/runner.mjs` | Build the one-attempt runner for a scheduler. |
| `CLAIM_STATES` | const | ↩ `lib/agentic/scheduler/state.mjs` | The scheduler's claim-state vocabulary (§3.3). |
| `SCHEDULER_DEFAULTS` | const | ↩ `lib/agentic/scheduler/state.mjs` | The §3.14 construction defaults. |

#### `lib/agentic/scheduler/normalize.mjs` — Normalization and deterministic ordering for external work items.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `toEpochMs` | function | `function toEpochMs({ value })` | Parse a timestamp as epoch milliseconds. |
| `normalizeWorkItem` | function | `function normalizeWorkItem({ raw, source = 'unknown' })` | Normalize one raw adapter record into a frozen `WorkItem`. |
| `sortForDispatch` | function | `function sortForDispatch({ items })` | Order items for dispatch without mutating the input. |
| `isActiveState` | function | `function isActiveState({ state, states })` | Whether `state` is one of the configured states. |
| `isTerminalState` | function | `function isTerminalState({ state, states })` | Whether `state` is one of the terminal states. |

#### `lib/agentic/scheduler/reconcile.mjs` — The refresh classification shared by the scheduler's refresh paths.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `classifyRefresh` | function | `function classifyRefresh({ item, terminalStates, activeStates })` | Classify one refreshed record. |

#### `lib/agentic/scheduler/retry.mjs` — Retry delay, run-result normalization, and failure evidence.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `failureEvidence` | function | ↩ `lib/agentic/loops/policy.mjs` | Build the evidence `classifyFailure` consumes from a normalized run result. |
| `errorFields` | function | `function errorFields({ error })` | Read `name`/`code` without letting a hostile getter or message escape. |
| `retryDelayMs` | function | `function retryDelayMs({ attempt, baseMs, maxMs })` | Capped exponential queue delay: `min(baseMs * 2 ** (attempt - 1), maxMs)`. |
| `normalizeRunResult` | function | `function normalizeRunResult({ result = null, error = null, signal = null } = {})` | Normalize a workflow result or a thrown error into the scheduler's fixed shape. |

#### `lib/agentic/scheduler/runner.mjs` — `createEngineRunner`: adapts one scheduler attempt to an engine.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createEngineRunner` | function | `function createEngineRunner(options = {})` | Build the one-attempt runner for a scheduler. |

#### `lib/agentic/scheduler/scheduler.mjs` — `WorkScheduler`: single-flight tick, dispatch, caps, settle, snapshot.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `MANAGED_KEYS` | const | `const MANAGED_KEYS = Object.freeze([ 'activeStates', 'terminalStates', 'requiredL …` | The keys `applyConfig` may change. |
| `WorkScheduler` | class | `class WorkScheduler` | The work-item scheduler: claims, dispatch, retries, parking, and a single-flight tick. |

#### `lib/agentic/scheduler/state.mjs` — Scheduler state shapes, defaults, usage accumulation, and the snapshot.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `workThreadId` | function | `function workThreadId({ identifier })` | The checkpoint thread for one work item (§3.10). |
| `CLAIM_STATES` | const | `const CLAIM_STATES = Object.freeze({ UNCLAIMED: 'unclaimed', CLAIMED: 'claimed', …` | The scheduler's claim-state vocabulary (§3.3). |
| `SCHEDULER_DEFAULTS` | const | `const SCHEDULER_DEFAULTS = Object.freeze({ get pollIntervalMs() { return LIMITS.schedul …` | The §3.14 construction defaults. |
| `createTotals` | function | `function createTotals()` | A zeroed accumulator. |
| `projectUsage` | function | `function projectUsage({ usage })` | One stream of usage in two spellings: the engine reports `prompt_tokens` / `completion_tokens`, a settled attempt reports `input_tokens` / `output_tokens`, and a cost may arrive as `cost_usd` or `costUsd`. |
| `accumulateUsage` | function | `function accumulateUsage({ totals, usage })` | Fold one settled attempt's usage into `totals`. |
| `buildSnapshot` | function | `function buildSnapshot({ started = false, stopped = false, tickCount = 0, lastTickAt = null, lastOutcome = null, pollIntervalMs = 0, running = new Map(), retrying = [], parked = [], claimed = [], completed = [], totals = createTotals(), limits = {}, activeStates = [], terminalStates = [], now = Date.now() } = {})` | Build the §3.13 snapshot. |

#### `lib/agentic/scheduler/validate.mjs` — Pure configuration validation for `WorkScheduler`.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `collectDuplicateIdentifiers` | function | `function collectDuplicateIdentifiers({ items })` | Collect every duplicated identifier in first-seen order, deduped. |
| `validateSchedulerConfig` | function | `function validateSchedulerConfig({ options = {} } = {})` | Validate the merged scheduler configuration. |

#### `lib/agentic/scheduler/work-sources/function.mjs` — Host-function work source.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createFunctionWorkSource` | function | `function createFunctionWorkSource({ fetchByStates, fetchByIds, eventEmitter = null })` | Create a work source backed by two host functions. |

#### `lib/agentic/scheduler/work-sources/index.mjs` — Public surface of the work-source adapters.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WORK_SOURCE_CATEGORIES` | const | `const WORK_SOURCE_CATEGORIES = CATEGORY_VALUES` | The Symphony §11.4 categories, in their canonical order. |
| `createMemoryWorkSource` | function | ↩ `lib/agentic/scheduler/work-sources/memory.mjs` | Create a work source over an in-memory array. |
| `createJsonFileWorkSource` | function | ↩ `lib/agentic/scheduler/work-sources/json-file.mjs` | Create a read-only work source over a directory of `*.json` files. |
| `createFunctionWorkSource` | function | ↩ `lib/agentic/scheduler/work-sources/function.mjs` | Create a work source backed by two host functions. |
| `createTodoWorkSource` | function | ↩ `lib/agentic/scheduler/work-sources/todos.mjs` | Create a read-only work source over a `TodoComponent`-style store. |

#### `lib/agentic/scheduler/work-sources/json-file.mjs` — Read-only JSON directory work source.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createJsonFileWorkSource` | function | `async function createJsonFileWorkSource({ dir, eventEmitter = null })` | Create a read-only work source over a directory of `*.json` files. |

#### `lib/agentic/scheduler/work-sources/memory.mjs` — In-memory work source.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createMemoryWorkSource` | function | `function createMemoryWorkSource({ items, eventEmitter = null })` | Create a work source over an in-memory array. |

#### `lib/agentic/scheduler/work-sources/records.mjs` — The list/refresh asymmetry shared by every work source.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `emitSkippedRecord` | function | `function emitSkippedRecord({ eventEmitter, source, index, file, reason })` | Emit one `work_item:skipped` event with the documented four-field payload. |
| `normalizeListRecord` | function | `function normalizeListRecord({ raw, source, index, file, eventEmitter })` | Normalize one record on the list path: skip and report on a malformed record, return null. |
| `normalizeRequestedRecord` | function | `function normalizeRequestedRecord({ raw, source })` | Normalize one requested record on the refresh path: throw the `WorkSourceError` unchanged, because the caller asked for this exact id. |

#### `lib/agentic/scheduler/work-sources/todos.mjs` — Work source over the SDK's own todo store.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createTodoWorkSource` | function | `function createTodoWorkSource({ store, includeInternal = false, eventEmitter = null })` | Create a read-only work source over a `TodoComponent`-style store. |

#### `lib/agentic/session-policy.mjs` — Shared session-policy carrier.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `captureSessionPolicy` | function | `function captureSessionPolicy({ session } = {})` | Captures the policy fields of a live session (or a session-like object). |
| `applySessionPolicy` | function | `function applySessionPolicy({ session, policy = null })` | Applies a captured policy to a session (a fresh child or engine session). |
| `createSession` | function | `function createSession({ client, model, sessionId = null })` | Builds a session with an explicit conversation id when the client supports `sessionWithId`. |
| `adoptSessionId` | function | `function adoptSessionId({ session, sessionId = null })` | Fallback for clients that only expose `session(model)`: keep the session fields consistent after construction. |

#### `lib/agentic/sessions.mjs` — SessionStore — durable conversation checkpoints.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `LocalFileSessionStore` | class | `class LocalFileSessionStore` | File-backed checkpoint store. |
| `InMemorySessionStore` | class | `class InMemorySessionStore` | A `SessionStore` in a `Map`: for tests, evals and short-lived processes. |

#### `lib/agentic/spawn-registry.mjs` — The spawn registry (wave 6 / SP1).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `setSpawnContinuation` | function | `function setSpawnContinuation({ fn })` | Registers the continuation implementation (task.mjs owns the step engine, so the registry does not import it and create a cycle). |
| `getSpawnRegistry` | function | `function getSpawnRegistry(arg0 = {})` | The registry for a client (created once). |
| `openSpawn` | function | `function openSpawn({ registry, parent = null, agent = 'custom', model = null, provider = null, prefix = 'sub' })` | Opens a spawn record. |
| `treeSpawnCount` | function | `function treeSpawnCount({ session = null } = {})` | How many spawns this session's tree has already opened. |
| `adoptSpawnIdentity` | function | `function adoptSpawnIdentity({ session, record })` | Stamps a child session with its spawn identity, so a nested spawn knows its parent and the lineage grows instead of restarting. |
| `sumSpawnUsage` | function | `function sumSpawnUsage(list)` | Sums the numeric usage fields of every attempt. |
| `pushAttempt` | function | `function pushAttempt({ record, session })` | Remembers an attempt's session. |
| `finishSpawn` | function | `function finishSpawn({ record, result = null, usage = null })` |  |
| `failSpawn` | function | `function failSpawn({ record, error })` |  |
| `spawnThreadId` | function | `function spawnThreadId({ id })` | The deterministic thread id a durable child is stored under (D10). |
| `spawnHandle` | function | `function spawnHandle({ record, wait = null })` | The handle a caller (or the model) receives: the identity plus a way to wait. |
| `listSpawns` | function | `function listSpawns({ client = null, status = undefined, parentId = undefined } = {})` | Lists the spawns of a client, newest first. |
| `getSpawn` | function | `function getSpawn({ client = null, id })` | One spawn by id. |

#### `lib/agentic/state-machine/condition-evaluator.mjs` — Memory-isolated evaluation of planner-authored string conditions.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `conditionChildArgs` | function | `function conditionChildArgs({ memoryMb, execArgv = process.execArgv, workerPath = WORKER_PATH })` | The argument vector for the evaluator child. |
| `conditionEvaluatorStats` | function | `function conditionEvaluatorStats()` |  |
| `evaluateCondition` | function | `function evaluateCondition({ src, payloadJson })` | Evaluates a string condition in a separate process with a private heap cap. |

#### `lib/agentic/state-machine/condition-vm.mjs` — The one `node:vm` evaluator for a string transition condition.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `CONDITION_THENABLE` | const | `const CONDITION_THENABLE = 'ERR_CONDITION_THENABLE'` | `code` of the error thrown when the expression produced a thenable. |
| `compileConditionScript` | function | `function compileConditionScript({ src })` | Compiles the expression into a sandbox script whose completion value is a primitive boolean (or the thenable sentinel). |
| `runConditionInVm` | function | `function runConditionInVm({ src, payloadJson, timeoutMs })` | Evaluates one condition against `payloadJson` in a fresh hardened context. |

#### `lib/agentic/state-machine/condition-worker.mjs` — Child-process evaluator for planner-authored string conditions.

_No exports._

#### `lib/agentic/state-machine/context.mjs` — StateContext — the StateMachine's shared key/value context.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `StateContext` | class | `class StateContext` | The shared key/value context of a StateMachine run. |

#### `lib/agentic/state-machine/index.mjs` — StateMachine public exports.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `StateContext` | class | ↩ `lib/agentic/state-machine/context.mjs` | The shared key/value context of a StateMachine run. |
| `StateMachine` | class | ↩ `lib/agentic/state-machine/machine.mjs` | A node graph machine with conditional transitions. |
| `createStateMachineTool` | function | ↩ `lib/agentic/state-machine/machine.mjs` | Builds the `run_state_machine` tool definition for a graph. |

#### `lib/agentic/state-machine/machine.mjs` — StateMachine — verified node graph execution.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `StateMachine` | class | `class StateMachine extends EventEmitter` | A node graph machine with conditional transitions. |
| `createStateMachineTool` | function | `function createStateMachineTool({ graph, options = {} })` | Builds the `run_state_machine` tool definition for a graph. |
| `compileCondition` | function | `function compileCondition({ src, expr })` | Compiles a transition condition: passes functions through, parses string expressions into a function that evaluates them against the StateContext in a hardened `node:vm` sandbox (code generation disabled, hard timeout). |

#### `lib/agentic/step.mjs` — step — the atomic, engine-agnostic agentic step primitive.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `runStep` | function | `async function runStep({ step = null, deps = {} })` | Runs ONE agentic step attempt in a fresh session: builds the session with the glue's policy/capabilities, runs the agentic loop, forwards stream events through the glue's event names, and captures the step's full message row + reasoning signature for the next attempt/step. |

#### `lib/agentic/task.mjs` — Subagent delegation (task tool).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `TASK_TOOL_NAME` | const | `const TASK_TOOL_NAME = 'task'` | The `task` tool's wire name. |
| `renderSubagentRoster` | function | `function renderSubagentRoster({ agents, withDescriptions = false })` | Renders the live delegation roster for the `task` tool description (`withDescriptions`) and for the unknown-subagent error (names only). |
| `resolveAgentClient` | function | `function resolveAgentClient({ parent, agent })` | Resolves the client that should execute an agent/profile on. |
| `withTaskAgents` | function | `function withTaskAgents({ client, agents = [], options = {} })` | duplicate name wins) and returns the client for chaining. |
| `withAgentDelegation` | function | `function withAgentDelegation({ client, agents = undefined, models = undefined, transports = undefined, system = undefined, tools = undefined, maxDepth = undefined, maxSpawns = undefined } = /** @type {any} */ ({}))` | Declares the host's delegation envelope (D1a). |
| `normalizeDelegationEnvelope` | function | `function normalizeDelegationEnvelope({ client = null, envelope = null } = {})` | Resolves the effective envelope: the host's declaration over the restrictive defaults. |
| `resolveDelegationMaxDepth` | function | `function resolveDelegationMaxDepth({ profile = null, session = null, envelope = null } = {})` | The one depth cap both the advertisement (`_canDelegate`) and the call use, so a tool that is offered always runs. |
| `createTaskTool` | function | `function createTaskTool({ session })` | on. |
| `forkSpawn` | function | `async function forkSpawn({ client = null, id = null, newThreadId, overwrite = false, store = null, threadId = null } = /** @type {any} */ ({}))` | Branches a durable child's conversation (D10). |
| `continueSpawn` | function | `async function continueSpawn({ client, id, prompt = '', signal })` | Continues a settled spawn's conversation with one more turn (SP3). |
| `sendToSpawn` | function | `function sendToSpawn({ client, id, prompt, signal })` | `client.send({id, prompt})` — the addressing form of `continueWith`. |
| `runTaskChild` | function | `function runTaskChild({ session, profile, args, signal, eventEmitter, stepRun = null, guardOutput = null, onChildEvent = null, runOptions = {} })` | Runs one delegation attempt for a profile against a parent session-like. |
| `runDelegationLadder` | function | `async function runDelegationLadder({ profile, breaker, provider = undefined, signal, eventEmitter, stepRun = null, eventMeta = {}, attempt })` |  |

#### `lib/agentic/thread-ids.mjs` — The one thread-id rule shared by the scheduler, the workspace, the engine runner, and spawns.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `threadIdFor` | function | `function threadIdFor({ kind, id })` | Build the deterministic thread id for one identity. |

#### `lib/agentic/todos/component.mjs`

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `TodoComponent` | class | `class TodoComponent extends LoadableComponent` | The todos capability component: task list management exposed as load/save tools and rendered into the system context. |

#### `lib/agentic/transfer.mjs` — transfer — the single cross-instance context-transfer primitive.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `TRANSFER_MODES` | const | `const TRANSFER_MODES = ['stringify', 'ledger']` | Selectable transfer modes. |
| `TRANSFER_SELECTS` | const | `const TRANSFER_SELECTS = ['all', 'tail']` | Selectable windowing strategies (order is always preserved). |
| `TRANSFER_MARKER_LABEL` | const | `const TRANSFER_MARKER_LABEL = 'Earlier context omitted'` | Default marker label used when a dropped prefix has no summary. |
| `TRANSFER_PRESETS` | const | `const TRANSFER_PRESETS = Object.freeze({ stringify: { mode: 'stringify', select: 'all …` | Named presets. |
| `normalizeTransfer` | function | `function normalizeTransfer({ transfer = null } = {})` | Resolves a preset name or an option object into the canonical policy. |
| `isToolResultRow` | function | `function isToolResultRow(row)` | True when a row is a tool result — the continuation of an assistant tool call. |
| `renderTransfer` | function | `async function renderTransfer({ units = [], transfer = null, targetProvider = null, summarize = null, maxChars = LIMITS.max_intake_output_chars } = {})` | Renders the ordered upstream units into what the next step consumes. |

#### `lib/agentic/web-shared.mjs` — Shared web tool helpers (search + scrape + browser).

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `warnWebUnsupported` | function | `function warnWebUnsupported({ opts, parameter, engine, kind })` |  |
| `resolveWebMode` | function | `function resolveWebMode({ nativeProviders, toolModes, sessionProvider, mode })` |  |
| `resolveCapabilityMode` | function | `function resolveCapabilityMode({ resolveMode, sessionProvider, config })` |  |
| `toUrls` | function | `function toUrls({ input })` | Normalizes a tool's `url`/`urls` argument to the list of non-blank strings a batched engine reads. |
| `webItemError` | function | `function webItemError({ url, err })` | The per-URL failure item every web engine returns: no content, no truncation, and the error message. |
| `preferJaiEngine` | function | `function preferJaiEngine({ provider, config })` | Whether the session provider takes the JAI engine: it is the JAI backend, no Tavily config was given, and the mode is not explicitly `tavily`. |
| `nativeProvidersFor` | function | `function nativeProvidersFor({ capability })` | The provider ids with a native (vendor) leg for one capability flag — `nativeWebSearch` or `nativeWebScrape`. |
| `postJson` | function | `async function postJson({ url, body, signal, provider, label })` | The POST-JSON prologue the Tavily engine legs share: undefined body keys are dropped, the request carries `Content-Type: application/json` and the caller's signal, a thrown `fetch` failure is wrapped with the provider hint, and a non-2xx answer raises a `BackendError` whose message is `"<label> (HTTP <status>)."`. |
| `hasDomainPolicy` | function | `function hasDomainPolicy({ allowedDomains, blockedDomains })` | True when any domain policy was configured (so callers can skip the work). |
| `httpHost` | function | `function httpHost({ url })` | Lowercased hostname of an http(s) URL, or null for an invalid/non-http URL. |
| `hostMatchesDomain` | function | `function hostMatchesDomain({ host, domain })` | Suffix match: `a.example.com` is in `example.com`; `notexample.com` is not. |
| `resolvePublicAddress` | function | `async function resolvePublicAddress({ url, allowPrivateNetwork = false, lookup = /** @type {HostResolver} */ (dnsLookup) })` | Resolves `url`'s hostname once and returns the address a request may pin. |
| `resolvesToPublicHost` | function | `async function resolvesToPublicHost({ url, allowPrivateNetwork = false, lookup = /** @type {HostResolver} */ (dnsLookup) })` | True when `url`'s hostname resolves only to public addresses. |
| `pinnedFetch` | function | `function pinnedFetch({ url, headers = {}, signal = null, address = null, family = 4, request = null })` | A `fetch`-shaped GET over `node:http`/`node:https` that connects to a pinned address while keeping the URL hostname for the Host header, SNI and certificate validation. |
| `isSafeHttpUrl` | function | `function isSafeHttpUrl({ url, allowPrivateNetwork = false })` | Validates that `url` uses `http:` or `https:` and, unless `allowPrivateNetwork === true`, does not target loopback, link-local, private network, or cloud metadata hosts. |
| `urlPermitted` | function | `function urlPermitted({ url, allowedDomains = [], blockedDomains = [], allowPrivateNetwork = false })` | Client-side domain policy for the tool legs (the native legs enforce it vendor-side). |
| `splitUrlsByDomainPolicy` | function | `function splitUrlsByDomainPolicy({ urls, allowedDomains, blockedDomains, allowPrivateNetwork = false })` | Splits URLs into those the domain and SSRF policy permits and those it blocks. |
| `renderWebContextBlock` | function | `function renderWebContextBlock({ baseBlock, inject })` |  |
| `normalizeInject` | function | `function normalizeInject({ inject, label })` |  |

#### `lib/agentic/webscrape/component.mjs` — WebScrapeComponent — the `web_scrape` function-tool surface.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WebScrapeComponent` | class | `class WebScrapeComponent extends LoadableComponent` | Web-scrape capability surfaced as a `web_scrape` function tool. |

#### `lib/agentic/webscrape/engines.mjs` — Web-scrape engines + mode resolution.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `NATIVE_PROVIDERS` | const | `const NATIVE_PROVIDERS = nativeProvidersFor({ capability: 'nativeWebScrape' })` | The providers with a native scrape leg. |
| `resolveScrapeMode` | function | `function resolveScrapeMode({ sessionProvider, mode })` | Resolves the scrape mode — the strategy the web scraper runs in. |
| `toUnifiedScrape` | function | `function toUnifiedScrape({ url, raw, includeVendorMetadata = false })` | Curl plain text) to the unified `{ url, content, truncated, _vendor? |
| `CurlEngine` | class | `class CurlEngine` | Curl engine — plain `fetch`, strips HTML to text. |
| `TavilyExtractEngine` | class | `class TavilyExtractEngine` | Tavily extract engine — raw global `fetch` POST to https://api.tavily.com/extract. |
| `JaiScrapeEngine` | class | `class JaiScrapeEngine` | JAI engine — rides `taskApi.executeJson('web-scrape', { url }, { version:'v4' })`. |

#### `lib/agentic/webscrape/index.mjs` — Web-scrape capability barrel.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WebScrapeComponent` | class | ↩ `lib/agentic/webscrape/component.mjs` | Web-scrape capability surfaced as a `web_scrape` function tool. |
| `TavilyExtractEngine` | class | ↩ `lib/agentic/webscrape/engines.mjs` | Tavily extract engine — raw global `fetch` POST to https://api.tavily.com/extract. |
| `JaiScrapeEngine` | class | ↩ `lib/agentic/webscrape/engines.mjs` | JAI engine — rides `taskApi.executeJson('web-scrape', { url }, { version:'v4' })`. |
| `CurlEngine` | class | ↩ `lib/agentic/webscrape/engines.mjs` | Curl engine — plain `fetch`, strips HTML to text. |
| `resolveScrapeMode` | function | ↩ `lib/agentic/webscrape/engines.mjs` | Resolves the scrape mode — the strategy the web scraper runs in. |
| `toUnifiedScrape` | function | ↩ `lib/agentic/webscrape/engines.mjs` | Curl plain text) to the unified `{ url, content, truncated, _vendor? |

#### `lib/agentic/websearch/component.mjs` — WebSearchComponent — the `web_search` function-tool surface.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WebSearchComponent` | class | `class WebSearchComponent extends LoadableComponent` | Web-search capability surfaced as a `web_search` function tool. |

#### `lib/agentic/websearch/engines.mjs` — Web-search engines + mode resolution.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `normalizeCitations` | function | `function normalizeCitations({ citations })` | `{ title, url }` source shape, deduped by url (annotation events can repeat). |
| `NATIVE_PROVIDERS` | const | `const NATIVE_PROVIDERS = nativeProvidersFor({ capability: 'nativeWebSearch' })` | The providers with a native search leg. |
| `resolveSearchMode` | function | `function resolveSearchMode({ sessionProvider, mode })` | Resolves the search mode — the engine the web search runs on. |
| `toUnified` | function | `function toUnified({ query, raw, includeVendorMetadata = false })` | `{ query, answer?, sources: [{ title, url }] }` shape. |
| `TavilyEngine` | class | `class TavilyEngine` | Tavily engine — raw global `fetch` POST to https://api.tavily.com/search. |
| `JaiEngine` | class | `class JaiEngine` | JAI engine — rides `taskApi.executeJson('web-search', params, { version:'v4' })`. |

#### `lib/agentic/workflow-policy/config.mjs` — Strict `WORKFLOW.md` config resolution: defaults, validation, env/path expansion, and the operator-safe projec …

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WORKFLOW_POLICY_DEFAULTS` | const | `const WORKFLOW_POLICY_DEFAULTS = Object.freeze(Object.defineProperties({}, { path: { value: ' …` |  |
| `WORKFLOW_POLICY_REASONS` | const | `const WORKFLOW_POLICY_REASONS = Object.freeze([ 'missing_workflow_file', 'workflow_read_erro …` | Every error reason this slice can emit; `reasons` entries are `<code>` or `<code>:<detail>`. |
| `WORKFLOW_POLICY_WARNINGS` | const | `const WORKFLOW_POLICY_WARNINGS = Object.freeze([ 'unknown_key', 'unsupported_section', 'inval …` | Every warning code this slice can emit. |
| `resolveWorkflowConfig` | function | `function resolveWorkflowConfig({ config = {}, baseDir = process.cwd(), env = process.env, home = homedir() } = {})` | Resolves the inert front matter into the one validated, frozen config. |
| `redactConfig` | function | `function redactConfig({ config })` | The operator-safe projection: provider keys and hook presence only. |

#### `lib/agentic/workflow-policy/file.mjs` — Strict `WORKFLOW.md` discovery: one read, a fenced front-matter parse, and the one-shot load the policy starts …

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `parseWorkflowMarkdown` | function | `function parseWorkflowMarkdown({ markdown, path = null })` | Parses a `WORKFLOW.md` string. |
| `readWorkflowFile` | function | `async function readWorkflowFile({ path = join(process.cwd(), 'WORKFLOW.md'), maxFileBytes = LIMITS.workflow_max_file_bytes } = {})` | Reads the file behind `path`. |
| `buildEffective` | function | `function buildEffective({ markdown, path, env })` | Resolves one parsed file body into the effective config and prompt, plus the warnings a caller reports as-is. |
| `loadWorkflowFile` | function | `async function loadWorkflowFile({ path = join(process.cwd(), 'WORKFLOW.md'), env = process.env, maxFileBytes = LIMITS.workflow_max_file_bytes, now = Date.now } = {})` | Reads, parses, and resolves one workflow file. |

#### `lib/agentic/workflow-policy/index.mjs` — Public surface of the workflow policy modules.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `parseWorkflowMarkdown` | function | ↩ `lib/agentic/workflow-policy/file.mjs` | Parses a `WORKFLOW.md` string. |
| `loadWorkflowFile` | function | ↩ `lib/agentic/workflow-policy/file.mjs` | Reads, parses, and resolves one workflow file. |
| `WorkflowPolicy` | class | ↩ `lib/agentic/workflow-policy/policy.mjs` | A reload is single-flight, keeps the last good state on failure, and arms a debounced watcher only after the first load succeeds. |
| `resolveWorkflowConfig` | function | ↩ `lib/agentic/workflow-policy/config.mjs` | Resolves the inert front matter into the one validated, frozen config. |
| `WORKFLOW_POLICY_DEFAULTS` | const | ↩ `lib/agentic/workflow-policy/config.mjs` |  |
| `WORKFLOW_POLICY_REASONS` | const | ↩ `lib/agentic/workflow-policy/config.mjs` | Every error reason this slice can emit; `reasons` entries are `<code>` or `<code>:<detail>`. |
| `WORKFLOW_POLICY_WARNINGS` | const | ↩ `lib/agentic/workflow-policy/config.mjs` | Every warning code this slice can emit. |
| `renderPromptTemplate` | function | ↩ `lib/agentic/workflow-policy/template.mjs` | Parses and renders in one call. |
| `createPolicyRenderer` | function | ↩ `lib/agentic/workflow-policy/integrate.mjs` | The engine runner's `({ item, attempt, continuation }) => string` prompt callback. |
| `policyToSchedulerOptions` | function | ↩ `lib/agentic/workflow-policy/integrate.mjs` | The scheduler options from the resolved policy. |
| `policyToWorkspaceOptions` | function | ↩ `lib/agentic/workflow-policy/integrate.mjs` | The construction-bound workspace options. |

#### `lib/agentic/workflow-policy/integrate.mjs` — Integration helpers: a workflow policy to scheduler/workspace options, and the prompt renderer the engine runn …

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `policyToSchedulerOptions` | function | `function policyToSchedulerOptions({ policy })` | The scheduler options from the resolved policy. |
| `policyToWorkspaceOptions` | function | `function policyToWorkspaceOptions({ policy })` | The construction-bound workspace options. |
| `createPolicyRenderer` | function | `function createPolicyRenderer({ policy, eventEmitter = null })` | The engine runner's `({ item, attempt, continuation }) => string` prompt callback. |

#### `lib/agentic/workflow-policy/policy.mjs` — WorkflowPolicy: lifecycle, live reload, last-known-good, preflight.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WorkflowPolicy` | class | `class WorkflowPolicy` | A reload is single-flight, keeps the last good state on failure, and arms a debounced watcher only after the first load succeeds. |

#### `lib/agentic/workflow-policy/template.mjs` — Strict `WORKFLOW.md` prompt template: parse once, render per item.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `renderFailure` | function | `function renderFailure({ err })` | The typed error a failed render reports, and its stable base reason. |
| `parseTemplate` | function | `function parseTemplate({ template, maxDepth = WORKFLOW_POLICY_DEFAULTS.maxTemplateDepth } = {})` | Parses a prompt template once. |
| `renderParsedTemplate` | function | `function renderParsedTemplate({ ast, issue, attempt = null, maxRenderedChars = WORKFLOW_POLICY_DEFAULTS.maxRenderedChars } = {})` | Renders a parsed template for one item. |
| `renderPromptTemplate` | function | `function renderPromptTemplate({ template, issue, attempt = null, maxRenderedChars = WORKFLOW_POLICY_DEFAULTS.maxRenderedChars, maxDepth = WORKFLOW_POLICY_DEFAULTS.maxTemplateDepth } = {})` | Parses and renders in one call. |

#### `lib/agentic/workflow-policy/watch.mjs` — Debounced `fs.watch` wrapper for the workflow file.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createWorkflowWatcher` | function | `function createWorkflowWatcher({ path = 'WORKFLOW.md', debounceMs = LIMITS.workflow_debounce_ms, onEvent = () => {}, watchImpl = watch } = {})` |  |

#### `lib/agentic/workspace/git.mjs` — Git adapter for the `git-worktree` workspace strategy.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `probeRepo` | function | `async function probeRepo({ repoRoot, baseRef = null, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null })` | Probe a repository and, optionally, resolve a base ref to a commit. |
| `assertWorktreeIdentity` | function | `async function assertWorktreeIdentity({ path, managerCommonDir, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null })` | Assert the path is a linked worktree of the manager's repository. |
| `currentBranch` | function | `async function currentBranch({ path, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null })` | The worktree's checked-out branch, or `null` when HEAD is detached. |
| `isWorktreeDirty` | function | `async function isWorktreeDirty({ path, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null })` | True when `git status` reports anything: tracked edits, untracked files, or git-ignored files. |
| `hasUnreachableHead` | function | `async function hasUnreachableHead({ path, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null })` | True when HEAD has commits reachable from no ref (a detached worktree would lose them on removal). |
| `createWorktree` | function | `async function createWorktree({ repoRoot, root, path, key, branchPrefix = 'merci/', branch = undefined, baseRef = 'HEAD', timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null })` | Create one worktree. |
| `removeWorktree` | function | `async function removeWorktree({ repoRoot, path, force = false, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null })` | `git worktree remove`, with `--force` only when asked, then a best-effort prune. |
| `pruneWorktrees` | function | `async function pruneWorktrees({ repoRoot, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null })` | Prune stale worktree metadata. |
| `deleteBranchIfAtBase` | function | `async function deleteBranchIfAtBase({ repoRoot, branch, baseCommit, timeoutMs = LIMITS.workspace_git_timeout_ms, signal = null })` | Delete a branch only while it still points at `baseCommit`. |

#### `lib/agentic/workspace/hooks.mjs` — Lifecycle hooks for per-item workspaces.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WORKSPACE_HOOKS` | const | `const WORKSPACE_HOOKS = Object.freeze({ AFTER_CREATE: 'afterCreate', BEFORE_RUN: 'be …` | The four lifecycle hooks, in call order. |
| `emitWorkspaceEvent` | function | `function emitWorkspaceEvent({ eventEmitter, name, payload })` | Emit one `workspace:*` event on a sink that may be a bare `{ emit }` object. |
| `isAbortError` | function | ↩ `lib/core/errors.mjs` | Best-effort detection of an AbortSignal-triggered failure. |
| `normalizeHooks` | function | `function normalizeHooks({ hooks = {} } = {})` | Normalize and validate the `hooks` constructor option. |
| `runWorkspaceHook` | function | `async function runWorkspaceHook({ hook, script, workspace, timeoutMs, env = {}, signal = null, eventEmitter = null })` | Run one lifecycle hook, emitting start/finish/failure around it. |

#### `lib/agentic/workspace/identity.mjs` — The one workspace identifier rule.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `normalizeIdentifier` | function | `function normalizeIdentifier({ value })` | Normalize an optional workspace identifier. |

#### `lib/agentic/workspace/index.mjs` — Public surface of the workspace modules.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `workspaceKeyFor` | function | ↩ `lib/agentic/workspace/keys.mjs` | Derive the workspace directory name for a work item id. |
| `resolveWorkspacePath` | function | ↩ `lib/agentic/workspace/paths.mjs` | Resolve one workspace path under a root and assert containment, without IO. |
| `isInsideRoot` | function | ↩ `lib/agentic/workspace/paths.mjs` | True when `path` is `root` itself or sits below it. |
| `WORKSPACE_HOOKS` | const | ↩ `lib/agentic/workspace/hooks.mjs` | The four lifecycle hooks, in call order. |
| `WorkspaceManager` | class | ↩ `lib/agentic/workspace/manager.mjs` |  |
| `WORKSPACE_STRATEGIES` | const | ↩ `lib/agentic/workspace/manager.mjs` | The strategies, frozen so a caller cannot mutate the registry. |
| `createWorkspaceTools` | function | ↩ `lib/agentic/workspace/toolbox.mjs` | Bind `read`/`grep`/`glob`, the shell tool, and the artifact tool to one workspace handle. |

#### `lib/agentic/workspace/keys.mjs` — Deterministic workspace keys for per-item workspace directories.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `workspaceKeyFor` | function | `function workspaceKeyFor({ workItemId })` | Derive the workspace directory name for a work item id. |

#### `lib/agentic/workspace/manager.mjs` — Per-item workspace lifecycle: `directory` and `git-worktree`.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WORKSPACE_STRATEGIES` | const | `const WORKSPACE_STRATEGIES = Object.freeze({ DIRECTORY: 'directory', GIT_WORKTREE: 'git-w …` | The strategies, frozen so a caller cannot mutate the registry. |
| `WorkspaceManager` | class | `class WorkspaceManager` |  |

#### `lib/agentic/workspace/paths.mjs` — Workspace path containment: the root resolver and the guards that keep every workspace path inside it.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `isInsideRoot` | function | ↩ `lib/support/path-safety.mjs` | True when `path` is `root` itself or sits below it. |
| `normalizeRoot` | function | `const normalizeRoot = ({ root }) => { … }` | Validate a root option and normalize it to an absolute path. |
| `lstatOrNull` | function | `const lstatOrNull = async ({ path }) => { … }` | `lstat` where a missing path, or a path whose parent component is not a directory, is simply absent instead of an error. |
| `realpathOrNull` | function | `const realpathOrNull = async ({ path }) => { … }` | `realpath` under the same absent-is-null rule as `lstatOrNull`. |
| `realpathAllowingMissing` | function | `const realpathAllowingMissing = async ({ target }) => { … }` | Real path of a target whose trailing components may not exist yet: realpath the nearest existing ancestor and append the missing components. |
| `realpathAllowingMissingSync` | function | `const realpathAllowingMissingSync = ({ target }) => { … }` | Synchronous twin of `realpathAllowingMissing` for callers that must return without yielding — the tool binder validates a workspace before it hands back the tools, and it resolves a not-yet-created artifact directory through its nearest existing ancestor. |
| `resolveWorkspaceRoot` | function | `async function resolveWorkspaceRoot({ root, allowFilesystemRoot = false })` | Create the workspace root when missing and return its real path. |
| `resolveWorkspacePath` | function | `function resolveWorkspacePath({ root, key })` | Resolve one workspace path under a root and assert containment, without IO. |
| `assertDirectoryTarget` | function | `async function assertDirectoryTarget({ root, path })` | Check the target before creation: it must be inside the root and, when it exists, a real directory. |
| `assertRealPathInsideRoot` | function | `async function assertRealPathInsideRoot({ root, path })` | Assert the target's real path is still inside the root. |

#### `lib/agentic/workspace/toolbox.mjs` — Bind the built-in context, shell, and artifact tools to one workspace.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `createWorkspaceTools` | function | `function createWorkspaceTools({ workspace, approvalCallback = null, eventEmitter = null, include = ['context', 'shell', 'artifacts'], artifactsDir = null, context = {}, shell = {}, permissionMode = 'default' })` | Bind `read`/`grep`/`glob`, the shell tool, and the artifact tool to one workspace handle. |

### 4.7 `root` — Public barrel that defines the package entry surface (lib/index.mjs)

#### `lib/index.mjs` — Merci SDK entry point.

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WebSearchComponent` | class | ↩ `lib/agentic/websearch/component.mjs` | Web-search capability surfaced as a `web_search` function tool. |
| `TavilyEngine` | class | ↩ `lib/agentic/websearch/engines.mjs` | Tavily engine — raw global `fetch` POST to https://api.tavily.com/search. |
| `JaiEngine` | class | ↩ `lib/agentic/websearch/engines.mjs` | JAI engine — rides `taskApi.executeJson('web-search', params, { version:'v4' })`. |
| `resolveSearchMode` | function | ↩ `lib/agentic/websearch/engines.mjs` | Resolves the search mode — the engine the web search runs on. |
| `toUnified` | function | ↩ `lib/agentic/websearch/engines.mjs` | `{ query, answer?, sources: [{ title, url }] }` shape. |
| `WebScrapeComponent` | class | ↩ `lib/agentic/webscrape/component.mjs` | Web-scrape capability surfaced as a `web_scrape` function tool. |
| `TavilyExtractEngine` | class | ↩ `lib/agentic/webscrape/engines.mjs` | Tavily extract engine — raw global `fetch` POST to https://api.tavily.com/extract. |
| `JaiScrapeEngine` | class | ↩ `lib/agentic/webscrape/engines.mjs` | JAI engine — rides `taskApi.executeJson('web-scrape', { url }, { version:'v4' })`. |
| `CurlEngine` | class | ↩ `lib/agentic/webscrape/engines.mjs` | Curl engine — plain `fetch`, strips HTML to text. |
| `resolveScrapeMode` | function | ↩ `lib/agentic/webscrape/engines.mjs` | Resolves the scrape mode — the strategy the web scraper runs in. |
| `toUnifiedScrape` | function | ↩ `lib/agentic/webscrape/engines.mjs` | Curl plain text) to the unified `{ url, content, truncated, _vendor? |
| `BrowserComponent` | class | ↩ `lib/agentic/browser/component.mjs` | Browser capability surfaced as a `browser` function tool: `navigate` (read leg, no action needed) plus the interactive actions (Playwright over `obscura serve` CDP). |
| `INTERACTIVE_ACTIONS` | const | ↩ `lib/agentic/browser/component.mjs` | The interactive actions the browser tool understands — the vocabulary of a page interaction. |
| `ObscuraEngine` | class | ↩ `lib/agentic/browser/engines.mjs` | Obscura engine — standalone `obscura fetch <url> --dump <text\|markdown>`. |
| `PlaywrightSession` | class | ↩ `lib/agentic/browser/engines.mjs` | Interactive session over `obscura serve` CDP via Playwright. |
| `resolveBrowserMode` | function | ↩ `lib/agentic/browser/engines.mjs` | Resolves the browser mode — the strategy the browser tool runs in. |
| `MAX_BROWSER_URLS` | const | ↩ `lib/agentic/browser/engines.mjs` | How many URLs one browser turn may open. |
| `loadCredentials` | function | ↩ `lib/support/utils.mjs` | Reads a backend's credentials from the environment into the options `initializeClient` expects. |
| `configureSdkLog` | function | ↩ `lib/support/utils.mjs` | Configures the SDK logger. |
| `ProtocolType` | const | ↩ `lib/core/constants/index.mjs` | LLM wire protocols — the request/response contract a session speaks. |
| `ProviderType` | const | ↩ `lib/core/constants/index.mjs` | Every concrete provider the SDK can target. |
| `StandardType` | const | ↩ `lib/core/constants/index.mjs` | Every wire standard the SDK speaks. |
| `PROVIDERS` | const | ↩ `lib/core/constants/index.mjs` | Descriptors keyed by ProviderType value. |
| `STANDARDS` | const | ↩ `lib/core/constants/index.mjs` | Descriptors keyed by StandardType value. |
| `standardFor` | function | ↩ `lib/core/constants/index.mjs` |  |
| `isStandard` | function | ↩ `lib/core/constants/index.mjs` | Whether a provider speaks a given wire standard. |
| `providersForStandard` | function | ↩ `lib/core/constants/index.mjs` |  |
| `providerDescriptorFor` | function | ↩ `lib/core/constants/index.mjs` |  |
| `CAPABILITY` | const | ↩ `lib/core/constants/index.mjs` | Registry of LoadableComponent capability ids. |
| `REVIEW_STAGE_REMINDER` | const | ↩ `lib/core/constants/index.mjs` | Default followUp stage: review the produced answer, fix gaps, or reply DONE. |
| `ERROR_CODES` | const | ↩ `lib/core/constants/index.mjs` | Stable machine-readable error codes carried by the MerciError hierarchy. |
| `TIMEOUT_CODES` | const | ↩ `lib/core/constants/index.mjs` | Every machine-readable code the SDK raises for a timeout. |
| `getEmbeddingModel` | function | ↩ `lib/support/utils.mjs` | Resolves the embedding model for a backend from secret.env. |
| `getEmbeddingDimensions` | function | ↩ `lib/support/utils.mjs` | Resolves the JAI embedding output dimensionality from `DEFAULT_JAI_EMBEDDING_DIMENSIONS`, defaulting to 1024. |
| `getDecisionModel` | function | ↩ `lib/support/utils.mjs` | Resolves the decision (System One) model for a backend from secret.env. |
| `getDefaultModel` | function | ↩ `lib/support/utils.mjs` | The default model id of a backend — the tier the orchestrator and the judges run on. |
| `getToolModel` | function | ↩ `lib/support/utils.mjs` | The default tool model id of a backend — the cheap tier the subagents run on. |
| `resolveRole` | function | ↩ `lib/support/utils.mjs` | Resolves one client role to a provider and model. |
| `ClientRole` | const | ↩ `lib/core/constants/index.mjs` | The three client roles a host can resolve. |
| `ROLE_REGISTRY` | const | ↩ `lib/core/constants/index.mjs` | Role descriptors keyed by ClientRole value. |
| `createUserMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates a user message in the backend's wire shape. |
| `createSystemMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates a system message in the backend's wire shape. |
| `createAssistantMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates an assistant text message, optionally carrying a thought signature (and DeepSeek-style `reasoning_content` for multi-turn continuity). |
| `createToolCallMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates an assistant tool-call message in the backend's wire shape. |
| `createToolResultMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates a tool result message in the target backend's wire shape. |
| `createUnifiedMediaMessages` | function | ↩ `lib/backends/media.mjs` | Creates a user turn carrying an image or PDF plus a prompt, per-backend shaped (JAI shapes it natively; GAI/AAI/OAI embed base64 data — a PDF becomes an Anthropic `document` block / an OpenAI `file` part). |
| `PDF_MEDIA_PROVIDERS` | const | ↩ `lib/messaging/messages.mjs` | Backends whose wire can carry an `application/pdf` document as one inline media message: JAI (vendor media part), Gemini/Vertex (`inlineData`), Anthropic (`document` block), OpenAI (`file` part). |
| `normalizeHistory` | function | ↩ `lib/messaging/messages.mjs` | Normalizes a mixed-shape history to the backend's wire format: the JAI shape for JAI, otherwise the OAI normalizer. |
| `getToolCallName` | function | ↩ `lib/messaging/messages.mjs` | Reads the tool name from a tool call in any shape (OAI/JAI/GAI). |
| `getToolCallArguments` | function | ↩ `lib/messaging/messages.mjs` | Reads the tool arguments from a tool call in any shape (OAI/JAI/GAI). |
| `ExponentialBackoffPolicy` | class | ↩ `lib/support/retry-policy.mjs` | A retry policy that retries on transient errors (connection, rate limit, timeout, HTTP 408, 409, 429 and >= 500) with capped exponential backoff and full jitter (AWS Architecture Blog: sleep = random(0, min(cap, base*2^attempt))). |
| `NoRetryPolicy` | class | ↩ `lib/support/retry-policy.mjs` | A retry policy that never retries. |
| `createStreamingRetryPolicy` | function | ↩ `lib/support/retry-policy.mjs` | 30s, 2 retries — matching the OpenAI/Anthropic default). |
| `CircuitBreaker` | class | ↩ `lib/support/retry-policy.mjs` | Consecutive-failure circuit breaker with half-open probing. |
| `getCircuitBreaker` | function | ↩ `lib/support/retry-policy.mjs` | backend/model (or any caller key). |
| `runGuardedStep` | function | ↩ `lib/support/retry-policy.mjs` | Runs `run` behind `breaker`, recording shared backend health. |
| `isTransientError` | function | ↩ `lib/support/retry-policy.mjs` | predicate): true when a fresh default-policy instance would retry the error on attempt 0. |
| `HEADER_TIMEOUT_CODE` | const | ↩ `lib/support/retry-policy.mjs` | Machine-readable code carried by header-timeout abort errors (JAI gateway accepted the connection but sent no response headers in time). |
| `BODY_TIMEOUT_CODE` | const | ↩ `lib/support/retry-policy.mjs` | Machine-readable code for response-body stalls (headers arrived, body dripped). |
| `BREAKER_OPEN_CODE` | const | ↩ `lib/support/retry-policy.mjs` | Machine-readable code for fail-fast rejections while a circuit breaker is open (never retried — the whole point is to stop calling). |
| `hasTimeoutCode` | function | ↩ `lib/support/retry-policy.mjs` | timeout code (`TIMEOUT_CODES`: HEADER_TIMEOUT, BODY_TIMEOUT, STEP_TIMEOUT, STREAM_TIMEOUT, plus the host spellings ETIMEDOUT, TIMEOUT, timeout) — the structural contract that replaces message-substring matching. |
| `log` | const | ↩ `lib/support/utils.mjs` | The shared logger singleton. |
| `defaultDisplay` | function | ↩ `lib/agentic/agentic-core.mjs` | Returns the default display `{ onEvent }` for runAgenticLoop consumers: thinking via the logger, text/tool deltas to stdout (the first text delta of each turn is prefixed with `Assistant > ` so the answer is labelled exactly once), newline on stream_end. |
| `compactHistory` | function | ↩ `lib/agentic/agentic-core.mjs` | a history that already starts with the summary marker is never re-summarized. |
| `runDueSteps` | function | ↩ `lib/agentic/agentic-core.mjs` | Runs the steps that are due and returns one settled result per step, in input order. |
| `AgentLauncher` | class | ↩ `lib/agentic/cli/launcher.mjs` | Interactive agent CLI: system commands, skill-plugin dispatch, and a tool-fed agentic loop over a backend session. |
| `DiscussionSession` | class | ↩ `lib/agentic/discussion-session.mjs` | A multi-agent debate group: agents converse on a shared ledger, optionally judged/aggregated into a conclusion. |
| `StateMachine` | class | ↩ `lib/agentic/state-machine/index.mjs` | A node graph machine with conditional transitions. |
| `foldContext` | function | ↩ `lib/agentic/context-fold.mjs` | Folds a row array at `cut`: keeps the tail and replaces the prefix with a summary row, or with an explicit loss marker when there is no usable summary. |
| `AgentContext` | class | ↩ `lib/agentic/agent-context.mjs` | The context envelope threaded through agentic runs. |
| `normalizeHandoff` | function | ↩ `lib/agentic/agent-context.mjs` | Free combination: goal and context vary independently; tools defaults to inherit. |
| `goalBlockForHandoff` | function | ↩ `lib/agentic/agent-context.mjs` | block when full, the exact full block + marker when moderated. |
| `merciEnvelope` | function | ↩ `lib/agentic/agent-context.mjs` | `{ objective, directive, refs }`, nulls omitted. |
| `contextFromMerciEnvelope` | function | ↩ `lib/agentic/agent-context.mjs` | through). |
| `HANDOFF_MODERATED_MARKER` | const | ↩ `lib/agentic/agent-context.mjs` | Handoff marker appended after the full goal block when goal:'moderated'. |
| `HANDOFF_GOAL_MODES` | const | ↩ `lib/agentic/agent-context.mjs` | Valid `goal` modes for a handoff. |
| `HANDOFF_CONTEXT_MODES` | const | ↩ `lib/agentic/agent-context.mjs` | Valid `context` modes for a handoff. |
| `InactivityTimeoutPolicy` | class | ↩ `lib/support/stream-timeout.mjs` | Sliding-window inactivity timeout. |
| `createLimiter` | function | ↩ `lib/support/limiter.mjs` | Creates a limiter. |
| `runBatch` | function | ↩ `lib/support/limiter.mjs` | per-item retry, returning an index-aligned array of settled outcomes in INPUT order (independent of completion order): `[{status:'fulfilled', value} \| {status:'rejected', reason}]`. |
| `EventEmitterApiObserver` | class | ↩ `lib/support/api-observer.mjs` | The default ApiObserver: emits `api_request` and `api_response` on the session's `EventEmitter` and re-throws / re-emits the error via the `error` event. |
| `CompositeApiObserver` | class | ↩ `lib/support/api-observer.mjs` | Fans one API-call notification out to several observers. |
| `createOtlpExporter` | function | ↩ `lib/support/otel-exporter.mjs` | Creates an OTLP/HTTP JSON exporter for the SDK event stream. |
| `otelAttribute` | function | ↩ `lib/support/otel-exporter.mjs` | Encodes one OTLP attribute. |
| `createCassette` | function | ↩ `lib/support/cassette.mjs` | Creates a cassette. |
| `cassetteKey` | function | ↩ `lib/support/cassette.mjs` | The cassette key of a vendor request. |
| `CASSETTE_MODES` | const | ↩ `lib/support/cassette.mjs` | The cassette modes. |
| `runEvals` | function | ↩ `lib/agentic/evals.mjs` | Runs a suite: every case on a fresh session, every scorer on every run. |
| `EVAL_SCORERS` | const | ↩ `lib/agentic/evals.mjs` | The built-in scorers. |
| `attachEventLogger` | function | ↩ `lib/support/event-logger.mjs` | Subscribes a catch-all logger to an emitter. |
| `createStreamLogger` | function | ↩ `lib/support/event-logger.mjs` | Returns an `onEvent` handler for the agentic step stream that logs every event except those already rendered (`text`, `thought`). |
| `canonicalEventNames` | function | ↩ `lib/support/event-logger.mjs` | Every unique canonical event name in the `EVENTS` registry. |
| `createSaveArtifactTool` | function | ↩ `lib/agentic/artifacts.mjs` | A tool that saves a file the run produced into the artifact directory. |
| `ExecutionJournal` | class | ↩ `lib/agentic/journal.mjs` |  |
| `JOURNAL_STATUS` | const | ↩ `lib/agentic/journal.mjs` | One journal row: its identity, lifecycle, the meta the caller spread in, and the attempt history (flat — each stored attempt drops its own `attempts`). |
| `toolJournalKey` | function | ↩ `lib/agentic/journal.mjs` | The journal key of a tool call — the identity its outcome is recorded under. |
| `journalKey` | function | ↩ `lib/agentic/journal.mjs` | A stable 16-character key for a journal entry, derived from its parts. |
| `runStep` | function | ↩ `lib/agentic/step.mjs` | Runs ONE agentic step attempt in a fresh session: builds the session with the glue's policy/capabilities, runs the agentic loop, forwards stream events through the glue's event names, and captures the step's full message row + reasoning signature for the next attempt/step. |
| `createAcpAgent` | function | ↩ `lib/agentic/acp-agent.mjs` | Wraps a merci ChatSession as an ACP agent app. |
| `permissionAllowed` | function | ↩ `lib/agentic/acp-agent.mjs` | Decides whether an ACP `session/request_permission` response grants the permission. |
| `ACP_STOP_REASONS` | const | ↩ `lib/agentic/acp-agent.mjs` | The ACP prompt stop reasons. |
| `ACP_AGENT_VERSION` | const | ↩ `lib/agentic/acp-agent.mjs` | merci version advertised in the ACP initialize handshake. |
| `ingestDocument` | function | ↩ `lib/agentic/ingest.mjs` | Ingests a document (image or PDF) as Markdown using a vision-capable model. |
| `TaskState` | class | ↩ `lib/agentic/planning/task-state.mjs` | The serializable state of one workflow (DAG) run. |
| `CHECKPOINT_KIND` | const | ↩ `lib/agentic/planning/checkpoint.mjs` | Checkpoint payload kinds. |
| `saveCheckpoint` | function | ↩ `lib/agentic/planning/checkpoint.mjs` | Saves a tagged checkpoint through a session store. |
| `restoreCheckpoint` | function | ↩ `lib/agentic/planning/checkpoint.mjs` | Restores a checkpoint of the expected kind. |
| `structuredLlmCall` | function | ↩ `lib/agentic/planning/planner-utils.mjs` | Calls the LLM and returns structured data matching `schema`. |
| `collectTemplateRefs` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Collects `{{expr}}` template references from a string. |
| `validateTemplateRefs` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Validates that every `{{...}}` reference in each step's `userPromptTemplate` names a known step id or an allowed context root, and — with `ancestorsOnly` — that a step id it names is one of that step's **ancestors**. |
| `assertStateSchema` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Asserts a step/node output against an optional Zod-like state schema (`safeParse`). |
| `MemoryManager` | class | ↩ `lib/agentic/memory/index.mjs` | Coordinates long-term memory: sync-gap detection, fire-and-forget distillation of new conversation turns, and per-step memory block rendering. |
| `MemoryProvider` | class | ↩ `lib/agentic/memory/index.mjs` | Base memory provider contract. |
| `LocalFileMemoryProvider` | class | ↩ `lib/agentic/memory/index.mjs` | File-backed memory bank: one JSON file of facts with atomic saves. |
| `SqliteMemoryProvider` | class | ↩ `lib/agentic/memory/index.mjs` | SQLite-backed memory bank. |
| `CompositeMemoryProvider` | class | ↩ `lib/agentic/memory/index.mjs` | Fan-out memory provider across named banks. |
| `ProviderMemoryEngine` | class | ↩ `lib/agentic/memory/index.mjs` | Memory engine over a single provider. |
| `MemoryComponent` | class | ↩ `lib/agentic/memory/index.mjs` | The memory capability component: long-term recall/persist exposed as the memory load/save tools. |
| `KnowledgeComponent` | class | ↩ `lib/agentic/knowledge/index.mjs` | The knowledge capability. |
| `buildGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | Builds a graph from one or more documents. |
| `validateGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | Validates a graph. |
| `applyPatch` | function | ↩ `lib/agentic/knowledge/index.mjs` | Applies a patch: add nodes/edges, update node fields, remove by id. |
| `queryGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | The undirected neighbourhood of one node, for the explicit-id query form. |
| `retrieveSubgraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | The whole read path: seed → expand → rank. |
| `renderKnowledgeBlock` | function | ↩ `lib/agentic/knowledge/index.mjs` | Renders a bounded knowledge block for the prompt. |
| `renderWiki` | function | ↩ `lib/agentic/knowledge/index.mjs` | Renders the wiki. |
| `readWikiSha` | function | ↩ `lib/agentic/knowledge/index.mjs` | The graph hash a previously rendered wiki carries, or null. |
| `loadGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | Loads the graph. |
| `saveGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | Writes the graph and stamps its stats + hash. |
| `loadOntology` | function | ↩ `lib/agentic/knowledge/index.mjs` | Loads the vocabulary. |
| `saveOntology` | function | ↩ `lib/agentic/knowledge/index.mjs` | Writes the vocabulary. |
| `promotableRelations` | function | ↩ `lib/agentic/knowledge/index.mjs` | Custom relations that appear in enough distinct notes to deserve promotion into the vocabulary. |
| `documentSurface` | function | ↩ `lib/agentic/knowledge/index.mjs` | The `document` surface: one graph from one or more text files. |
| `wikiSurface` | function | ↩ `lib/agentic/knowledge/index.mjs` | The `wiki` surface: an existing markdown corpus becomes a reference graph. |
| `memorySurface` | function | ↩ `lib/agentic/knowledge/index.mjs` | The `memory` surface: bank facts become `fact` nodes. |
| `todosSurface` | function | ↩ `lib/agentic/knowledge/index.mjs` | The `todos` surface: tasks and their declared dependencies. |
| `planSurface` | function | ↩ `lib/agentic/knowledge/index.mjs` | The `plan` surface: a task DAG becomes `step` nodes. |
| `GENERIC_PROFILE` | const | ↩ `lib/agentic/knowledge/index.mjs` | Domain-neutral vocabulary: documents, claims, evidence, work items. |
| `LEGAL_PROFILE` | const | ↩ `lib/agentic/knowledge/index.mjs` | The legal vocabulary the existing corpus uses (`legalgraph/v1`). |
| `CORE_RELATIONS` | const | ↩ `lib/agentic/knowledge/index.mjs` | Relations a structural/doc parse or an author may use without a note. |
| `KNOWLEDGE_SCHEMA` | const | ↩ `lib/agentic/knowledge/index.mjs` | Schema id carried by `graph.json`. |
| `graphSha` | function | ↩ `lib/agentic/knowledge/index.mjs` | Stable hash of the graph's content. |
| `profileSources` | function | ↩ `lib/agentic/knowledge/index.mjs` | Measures one or more documents. |
| `proposeOntology` | function | ↩ `lib/agentic/knowledge/index.mjs` | Turns a measurement into a candidate vocabulary. |
| `ontologySha` | function | ↩ `lib/agentic/knowledge/index.mjs` | Identity of a proposal: the shape, not the timestamp. |
| `adoptOntology` | function | ↩ `lib/agentic/knowledge/index.mjs` | Adopts a proposal as the vocabulary. |
| `adoptedProfile` | function | ↩ `lib/agentic/knowledge/index.mjs` | The adopted vocabulary as a profile a graph can be validated against, or null when nothing was adopted. |
| `surfaceFragment` | function | ↩ `lib/agentic/knowledge/index.mjs` | Runs one surface's adapter. |
| `mergeFragment` | function | ↩ `lib/agentic/knowledge/index.mjs` | Merges adapter output into a graph, skipping ids that already exist. |
| `edgeText` | function | ↩ `lib/agentic/knowledge/index.mjs` | The text form of an edge, shared by the prompt block and the wiki so the two cannot drift. |
| `emptyGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` |  |
| `syncCorpus` | function | ↩ `lib/agentic/knowledge/index.mjs` | Load-or-build. |
| `loadCorpus` | function | ↩ `lib/agentic/knowledge/index.mjs` | Loads the persisted graph and its manifest. |
| `loadManifest` | function | ↩ `lib/agentic/knowledge/index.mjs` |  |
| `sourceDelta` | function | ↩ `lib/agentic/knowledge/index.mjs` | What changed between the corpus a graph was built from and the one on disk. |
| `corpusKey` | function | ↩ `lib/agentic/knowledge/index.mjs` | The build identity: sources by path and content, plus the vocabulary that shaped them and the extractor version. |
| `fingerprintSources` | function | ↩ `lib/agentic/knowledge/index.mjs` |  |
| `readSources` | function | ↩ `lib/agentic/knowledge/index.mjs` | Reads the sources from disk, in the order given (the order is part of the key). |
| `nodeKey` | function | ↩ `lib/agentic/knowledge/index.mjs` | Stable identity of a node's content, independent of where it sits. |
| `sourceSha` | function | ↩ `lib/agentic/knowledge/index.mjs` | Content hash of a whole source, for the corpus manifest. |
| `KNOWLEDGE_BUILD_VERSION` | const | ↩ `lib/agentic/knowledge/index.mjs` | Bumped whenever the mechanical pass changes what it emits for the same bytes. |
| `EDGE_SHAPES` | const | ↩ `lib/agentic/knowledge/index.mjs` | The shapes an edge may take beyond "A rel B". |
| `FailureClass` | const | ↩ `lib/agentic/loops/index.mjs` | The failure taxonomy: the classification labels returned by classifyFailure(). |
| `failureFingerprint` | function | ↩ `lib/agentic/loops/index.mjs` | Stable key for "is this the same failed attempt as before?". |
| `RetryLedger` | class | ↩ `lib/agentic/loops/index.mjs` | Retry budget keyed by failure fingerprint, NOT by a global counter. |
| `classifyFailure` | function | ↩ `lib/agentic/loops/index.mjs` | permission/environment boundaries are checked before verification outcomes (a failed command may be a blocked path, not a bad patch). |
| `claimReplan` | function | ↩ `lib/agentic/loops/index.mjs` | budget is spent, else `onClaim(next, label)` with the incremented count and `[replan next/max]` label. |
| `stateFingerprint` | function | ↩ `lib/agentic/loops/index.mjs` | same fingerprint — used to catch oscillation, not just consecutive stalls. |
| `compareProgress` | function | ↩ `lib/agentic/loops/index.mjs` | Compares two progress snapshots — a positive score means the run moved forward. |
| `createLlmJudge` | function | ↩ `lib/agentic/loops/index.mjs` | Returns `(ctx) => ({ passed, evidence })` ready for a LoopContract `judge`. |
| `createScoredJudge` | function | ↩ `lib/agentic/loops/index.mjs` | A typed, scored grader. |
| `WorkspaceManager` | class | ↩ `lib/agentic/workspace/index.mjs` |  |
| `createWorkspaceTools` | function | ↩ `lib/agentic/workspace/index.mjs` | Bind `read`/`grep`/`glob`, the shell tool, and the artifact tool to one workspace handle. |
| `workspaceKeyFor` | function | ↩ `lib/agentic/workspace/index.mjs` | Derive the workspace directory name for a work item id. |
| `resolveWorkspacePath` | function | ↩ `lib/agentic/workspace/index.mjs` | Resolve one workspace path under a root and assert containment, without IO. |
| `isInsideRoot` | function | ↩ `lib/agentic/workspace/index.mjs` | True when `path` is `root` itself or sits below it. |
| `WORKSPACE_STRATEGIES` | const | ↩ `lib/agentic/workspace/index.mjs` | The strategies, frozen so a caller cannot mutate the registry. |
| `WORKSPACE_HOOKS` | const | ↩ `lib/agentic/workspace/index.mjs` | The four lifecycle hooks, in call order. |
| `WorkScheduler` | class | ↩ `lib/agentic/scheduler/index.mjs` | The work-item scheduler: claims, dispatch, retries, parking, and a single-flight tick. |
| `createEngineRunner` | function | ↩ `lib/agentic/scheduler/index.mjs` | Build the one-attempt runner for a scheduler. |
| `WorkflowPolicy` | class | ↩ `lib/agentic/workflow-policy/index.mjs` | A reload is single-flight, keeps the last good state on failure, and arms a debounced watcher only after the first load succeeds. |
| `policyToSchedulerOptions` | function | ↩ `lib/agentic/workflow-policy/index.mjs` | The scheduler options from the resolved policy. |
| `policyToWorkspaceOptions` | function | ↩ `lib/agentic/workflow-policy/index.mjs` | The construction-bound workspace options. |
| `createPolicyRenderer` | function | ↩ `lib/agentic/workflow-policy/index.mjs` | The engine runner's `({ item, attempt, continuation }) => string` prompt callback. |
| `createOrchestration` | function | ↩ `lib/agentic/orchestration/index.mjs` | Build the coordination layer around one client, one board, and one `WORKFLOW.md`. |
| `LoadableComponent` | class | ↩ `lib/core/loadable.mjs` | Base class for operational capabilities (skills, memory, …) that surface a payload to the model. |
| `ChatSessionBuilder` | class | ↩ `lib/agentic/chat-session-builder.mjs` | Fluent builder for ChatSession configuration. |
| `BaseChatSession` | class | ↩ `lib/agentic/chat-session.mjs` | Shared OAI-family ChatSession (oai/gai/aai). |
| `TodoComponent` | class | ↩ `lib/agentic/todos/component.mjs` | The todos capability component: task list management exposed as load/save tools and rendered into the system context. |
| `createPlanStageFollowUp` | function | ↩ `lib/agentic/plan/component.mjs` | until plan_exit has been called this run. |
| `AGENT_PLAN` | const | ↩ `lib/agentic/plan/component.mjs` | Plan-agent identity (read-only). |
| `AGENT_EXECUTE` | const | ↩ `lib/agentic/plan/component.mjs` | Execute-agent identity (full tool set). |
| `buildEnvironmentBlock` | function | ↩ `lib/agentic/context.mjs` | Renders the environment block: working directory, git repo, platform, date. |
| `discoverInstructions` | function | ↩ `lib/agentic/context.mjs` | Discovers and renders AGENTS.md instruction files from `root` up to `stopAt` (inclusive). |
| `createContextTools` | function | ↩ `lib/tools/index.mjs` | The context tools — read, grep and glob over the working directory, as one tool set. |
| `createMcpServer` | function | ↩ `lib/tools/index.mjs` | Creates an MCP stdio server exposing the given tools, connected to stdin/stdout. |
| `createMcpHttpHandler` | function | ↩ `lib/tools/index.mjs` | Creates an MCP server over the Streamable HTTP transport and returns a `node:http` request handler that serves it. |
| `createShellTool` | function | ↩ `lib/tools/index.mjs` | The shell tool — runs a command in the working directory, behind the approval gate. |
| `createShellPolicyTool` | function | ↩ `lib/tools/index.mjs` | `describe_shell_policy`: the effective tier of one shell-tool instance, so a model reads the host's real allowlists instead of guessing from the defaults. |
| `loadMcpTools` | function | ↩ `lib/tools/index.mjs` | (schema normalization + output capping). |
| `loadMcpToolsFrom` | function | ↩ `lib/tools/index.mjs` | Loads a remote MCP server's tools. |
| `McpClient` | class | ↩ `lib/tools/index.mjs` | Thin lifecycle wrapper around the MCP client. |
| `McpTaskStore` | class | ↩ `lib/tools/index.mjs` | In-memory task store: a task record, its abort controller and its retention timer. |
| `FileMcpTaskStore` | class | ↩ `lib/tools/index.mjs` | A durable store: one JSON record per task under `dir`, reloaded on construction, so a task and its result survive a restart. |
| `loadA2ATool` | function | ↩ `lib/tools/index.mjs` | (returns []) when the agent card cannot be loaded or the URL is invalid. |
| `getA2ATask` | function | ↩ `lib/tools/index.mjs` | Reads a remote A2A task by id. |
| `cancelA2ATask` | function | ↩ `lib/tools/index.mjs` | Cancels a remote A2A task. |
| `A2A_COMPLETED_STATES` | const | ↩ `lib/tools/index.mjs` | The A2A task states that mean the task has ended, whichever dialect spelled it. |
| `createA2AServer` | function | ↩ `lib/tools/index.mjs` | Creates an A2A server exposing the given skills. |
| `createA2AHttpHandler` | function | ↩ `lib/tools/index.mjs` | Mounts an A2A server on a `node:http` server. |
| `loadSkillsFromDirectory` | function | ↩ `lib/tools/index.mjs` | Missing roots and missing SKILL.md files are normal skips; corruption is surfaced via sdkWarn and the SKILLS.LOAD_ERROR event. |
| `executeTools` | function | ↩ `lib/tools/index.mjs` | `{ id, tool_call_id, name, success, result\|error }` envelope; tool errors are returned (not thrown), while AbortError rethrows as cancellation. |
| `withToolTimeout` | function | ↩ `lib/tools/index.mjs` | Caps a tool call that outlives its budget. |
| `createOperatorHttpHandler` | function | ↩ `lib/agentic/operator/index.mjs` | Create a `(req, res) => Promise<void>` operator handler (§3.3). |
| `createEventRing` | function | ↩ `lib/agentic/operator/index.mjs` | emitter?: unknown, limit?: number, prefixes?: ReadonlyArray<string>, now?: () => number }} [arg0] |
| `formatStatus` | function | ↩ `lib/agentic/operator/index.mjs` | Render one snapshot as plain text (§3.7). |
| `SkillsLibrary` | class | ↩ `lib/tools/skills.mjs` | Loadable component exposing the registered skills to the model via a list-skills load tool. |
| `ExternalToolCapability` | class | ↩ `lib/tools/external-capability.mjs` | A remote tool family surfaced as a capability: the tool definitions do the work (tools-first), `load()` renders a short catalog listing for the model, and there is no save leg (toSaveTool() is null — no saveToolName passed). |
| `AcpCapability` | class | ↩ `lib/tools/external-capability.mjs` | Agent Client Protocol (ACP) capability — a duck-typed remote-tool adapter. |
| `capToolOutput` | function | ↩ `lib/tools/external-capability.mjs` | Non-strings pass through untouched. |
| `capToolOutputValue` | function | ↩ `lib/tools/external-capability.mjs` | Caps a tool result of **any** shape to a character budget, without changing its type. |
| `withTaskAgents` | function | ↩ `lib/agentic/task.mjs` | duplicate name wins) and returns the client for chaining. |
| `withAgentDelegation` | function | ↩ `lib/agentic/task.mjs` | Declares the host's delegation envelope (D1a). |
| `createTaskTool` | function | ↩ `lib/agentic/task.mjs` | on. |
| `normalizeDelegationEnvelope` | function | ↩ `lib/agentic/task.mjs` | Resolves the effective envelope: the host's declaration over the restrictive defaults. |
| `TASK_TOOL_NAME` | const | ↩ `lib/agentic/task.mjs` | The `task` tool's wire name. |
| `resolveAgentClient` | function | ↩ `lib/agentic/task.mjs` | Resolves the client that should execute an agent/profile on. |
| `getBudgetPool` | function | ↩ `lib/agentic/budget-pool.mjs` | The public read API: the tree's cap and spend, or null when the session has no budget. |
| `getSpawnRegistry` | function | ↩ `lib/agentic/spawn-registry.mjs` | The registry for a client (created once). |
| `listSpawns` | function | ↩ `lib/agentic/spawn-registry.mjs` | Lists the spawns of a client, newest first. |
| `getSpawn` | function | ↩ `lib/agentic/spawn-registry.mjs` | One spawn by id. |
| `sumSpawnUsage` | function | ↩ `lib/agentic/spawn-registry.mjs` | Sums the numeric usage fields of every attempt. |
| `spawnThreadId` | function | ↩ `lib/agentic/spawn-registry.mjs` | The deterministic thread id a durable child is stored under (D10). |
| `continueSpawn` | function | ↩ `lib/agentic/task.mjs` | Continues a settled spawn's conversation with one more turn (SP3). |
| `sendToSpawn` | function | ↩ `lib/agentic/task.mjs` | `client.send({id, prompt})` — the addressing form of `continueWith`. |
| `forkSpawn` | function | ↩ `lib/agentic/task.mjs` | Branches a durable child's conversation (D10). |
| `LocalFileSessionStore` | class | ↩ `lib/agentic/sessions.mjs` | File-backed checkpoint store. |
| `InMemorySessionStore` | class | ↩ `lib/agentic/sessions.mjs` | A `SessionStore` in a `Map`: for tests, evals and short-lived processes. |
| `LocalFileInboxStore` | class | ↩ `lib/agentic/inbox-store.mjs` | File-backed inbox: one JSON file per thread, written atomically (tmp + rename, fsync) so a crash mid-save leaves the previous queue intact. |
| `InMemoryInboxStore` | class | ↩ `lib/agentic/inbox-store.mjs` | Process-local inbox. |
| `INBOX_STORE_VERSION` | const | ↩ `lib/agentic/inbox-store.mjs` | The on-disk shape every inbox store speaks. |
| `PERMISSION_MODES` | const | ↩ `lib/agentic/permissions.mjs` | The permission modes this SDK understands. |
| `isToolPermitted` | function | ↩ `lib/agentic/permissions.mjs` | Whether a tool name passes the allow / deny lists. |
| `isEditTool` | function | ↩ `lib/agentic/permissions.mjs` | Whether a tool name looks like an edit (write / patch / delete / move). |
| `stillRequiresApproval` | function | ↩ `lib/agentic/permissions.mjs` | Whether a gated tool still has to ask under the given permission mode. |
| `normalizePermissionRules` | function | ↩ `lib/agentic/permissions.mjs` | Normalizes a caller-supplied rule bag into the canonical shape. |
| `createGuardrails` | function | ↩ `lib/agentic/guardrails.mjs` | Creates the guardrail engine for a set of rules. |
| `extractUserText` | function | ↩ `lib/agentic/guardrails.mjs` | The text of **every** user turn — what a caller typed into the agent. |
| `decisionTest` | function | ↩ `lib/agentic/guardrails.mjs` | A guardrail predicate backed by the decision gate: `true` only when the gate is certain enough to skip the LLM path. |
| `noulQuestion` | function | ↩ `lib/messaging/decision.mjs` | Builds a yes/no question. |
| `choiceQuestion` | function | ↩ `lib/messaging/decision.mjs` |  |
| `scoreQuestion` | function | ↩ `lib/messaging/decision.mjs` |  |
| `buildDecisionRequest` | function | ↩ `lib/messaging/decision.mjs` | Validates one request and returns it unchanged. |
| `readDecisionAnswer` | function | ↩ `lib/messaging/decision.mjs` | Reads one answer from a result, refusing a missing key or a type the caller did not expect. |
| `DECISION_QUESTION_TYPE` | const | ↩ `lib/messaging/decision.mjs` | The question types every decision wire recognizes. |
| `createDecisionsClient` | function | ↩ `lib/backends/decisions/index.mjs` | Creates the decision client for one provider. |
| `createDecisionGate` | function | ↩ `lib/agentic/decision-gate.mjs` | Builds the gate over a bound decision surface. |
| `certaintyOf` | function | ↩ `lib/agentic/decision-gate.mjs` | The certainty an answer carries, 0..1, or null when it cannot be calibrated. |
| `createDecisionReranker` | function | ↩ `lib/agentic/memory/rerank.mjs` | Builds the `reranker` option `LocalFileMemoryProvider` accepts. |
| `decisionCalibration` | function | ↩ `lib/agentic/decision-calibration.mjs` |  |
| `countConversationTurns` | function | ↩ `lib/messaging/unified-message.mjs` | Counts genuine conversation turns (user messages), ignoring SDK row-injections and tool-result carriers (role:'tool' messages, tool_message rows, and tool_result / functionResponse content blocks). |
| `isInjection` | function | ↩ `lib/messaging/unified-message.mjs` | True when `m` is an SDK row-injection. |
| `stripInjectionMeta` | function | ↩ `lib/messaging/unified-message.mjs` | Returns a copy of `messages` with the non-wire keys (INJECTION_META_KEY, MERCI_ID_KEY and — unless `keepNative` — MERCI_NATIVE_KEY) removed from every message. |
| `dedupeMessages` | function | ↩ `lib/messaging/unified-message.mjs` | Removes duplicate rows by their stable merciId. |
| `MerciError` | error class | ↩ `lib/core/errors.mjs` | Base class for every SDK-thrown error. |
| `BackendError` | error class | ↩ `lib/core/errors.mjs` | A vendor SDK / transport call failed. |
| `ConfigurationError` | error class | ↩ `lib/core/errors.mjs` | The SDK was mis-configured (missing required arg, invalid option, conflicting flags). |
| `MemoryError` | error class | ↩ `lib/core/errors.mjs` | A memory subsystem operation failed (L1 load/store, L2 distillation, L3 skill). |
| `AbortedError` | error class | ↩ `lib/core/errors.mjs` | The AbortSignal was triggered. |
| `BudgetExceededError` | error class | ↩ `lib/core/errors.mjs` | The run exceeded a token budget configured via `session.withBudget(...)` (or the `budget` run option). |
| `MaxTurnsExceededError` | error class | ↩ `lib/core/errors.mjs` | The run exhausted its tool-iteration budget without producing a final text response. |
| `AbstractMethodError` | error class | ↩ `lib/core/errors.mjs` | A subclass failed to implement an abstract method. |
| `OrchestrationError` | error class | ↩ `lib/core/errors.mjs` | Base class for orchestration-control failures raised by the DAG executor, the state machine, the discussion engine, and their shared verify gates. |
| `VerificationError` | error class | ↩ `lib/core/errors.mjs` | A node/step output failed its verification or acceptance gate (deterministic criteria, judge, or a user-supplied `verify`). |
| `OrchestrationExhaustedError` | error class | ↩ `lib/core/errors.mjs` | An orchestration budget/retry/liveness cap was exhausted: step retries, iteration limit, `maxSteps`, `maxVisits`, node timeout, or a run that never produced a usable final answer. |
| `GraphError` | error class | ↩ `lib/core/errors.mjs` | The workflow graph is structurally unusable at runtime — a dependency cycle, an unresolved/dangling dependency, or a deadlock with no runnable step. |
| `OrchestrationFailedError` | error class | ↩ `lib/core/errors.mjs` | The run ended with unrecovered failed steps (self-heal/replan budget spent). |
| `GuardrailViolationError` | error class | ↩ `lib/core/errors.mjs` | A guardrail refused the content. |
| `WorkspaceError` | error class | ↩ `lib/core/errors.mjs` | A workspace key, path, or lifecycle operation failed. |
| `WorkSourceError` | error class | ↩ `lib/core/errors.mjs` | A work source failed to list or refresh items. |
| `SchedulerError` | error class | ↩ `lib/core/errors.mjs` | The scheduler API was misused: a lifecycle call out of order, a reset of a running item, or an attempt to rebind an option that was fixed at construction. |
| `PolicyError` | error class | ↩ `lib/core/errors.mjs` | A `WORKFLOW.md` contract failed to load, parse, resolve, or render. |
| `AgentFileError` | error class | ↩ `lib/core/errors.mjs` | An agent definition file (`*.agent.yaml`) failed validation or loading. |
| `isAbortError` | function | ↩ `lib/core/errors.mjs` | Best-effort detection of an AbortSignal-triggered failure. |
| `wrapError` | function | ↩ `lib/core/errors.mjs` | Wraps a thrown error in the most-specific MerciError subclass based on the available hints. |
| `EVENTS` | const | ↩ `lib/core/events.mjs` | Canonical event-name registry. |
| `RunContext` | class | ↩ `lib/core/events.mjs` | The run context — the identity (run id, parent run) every event of a run carries. |
| `stampEvent` | function | ↩ `lib/core/events.mjs` | Standalone envelope builder for emission points outside any RunContext (parameter building, agent switching). |
| `stampStreamEvent` | function | ↩ `lib/core/events.mjs` | Adds the additive correlation fields to an onEvent stream event ({ type, ... |
| `emitEvent` | function | ↩ `lib/core/events.mjs` | The single event sink. |
| `runWithRunContext` | function | ↩ `lib/core/events.mjs` | Installs `runContext` as the ambient correlation context for `fn`. |
| `currentRunContext` | function | ↩ `lib/core/events.mjs` | The ambient RunContext of the current async execution, or null outside a run. |
| `getLimits` | function | ↩ `lib/core/limit-config.mjs` |  |
| `setLimits` | function | ↩ `lib/core/limit-config.mjs` | Applies programmatic overrides. |
| `resetLimits` | function | ↩ `lib/core/limit-config.mjs` | Drops every programmatic override and the programmatic switch. |
| `reloadLimits` | function | ↩ `lib/core/limit-config.mjs` | Re-reads `merci-limits.json` on the next resolution. |
| `LIMITS` | const | ↩ `lib/core/limit-config.mjs` | Every limit as a lazy property, so a read sees the current env, file and programmatic state. |
| `resolveLimit` | function | ↩ `lib/core/limit-config.mjs` | Resolves one limit for the current process state. |
| `LIMIT_DEFAULTS` | const | ↩ `lib/core/constants/limits.mjs` | Default value of every limit, keyed by its logical name. |
| `LIMIT_REGISTRY` | const | ↩ `lib/core/constants/limits.mjs` | Every tunable limit, keyed by its logical name. |
| `MerciEventEmitter` | class | ↩ `lib/core/emitter.mjs` | Per-subscription options: higher `priority` dispatches first, `prepend` jumps the queue, `once` removes after the first dispatch. |
| `createHooks` | function | ↩ `lib/core/hooks.mjs` | Creates an empty hook registry. |
| `HookRegistry` | class | ↩ `lib/core/hooks.mjs` | The hook registry — an ordered chain of async hooks that can veto or transform a value. |
| `STOP` | const | ↩ `lib/core/hooks.mjs` | The sentinel a hook returns to end a waterfall chain without changing the value. |
| `HOOKS` | const | ↩ `lib/core/hooks.mjs` | Canonical hook-chain names shared by the built-in pipelines and users of `withHooks` (`hooks.add({ name: HOOKS.TOOL_BEFORE, fn })`). |
| `PHASES` | const | ↩ `lib/core/lifecycle.mjs` | Canonical phase names. |
| `enterPhase` | function | ↩ `lib/core/lifecycle.mjs` | Runs `fn` inside a named lifecycle phase, emitting `phase:start` before and `phase:end` after. |
| `resolveProvider` | function | `function resolveProvider({ provider } = {})` | Resolves the active provider: the argument when given, otherwise `PROVIDER` from secret.env (renamed from BACKEND in 0.20). |
| `initializeClient` | function | `async function initializeClient({ provider, options = {} })` | Builds one backend client. |
| `createRoleClients` | function | `async function createRoleClients({ roles = [ClientRole.GENERATIVE, ClientRole.EMBEDDING, ClientRole.DECISION], options = {}, clientFactory = initializeClient } = {})` | Builds one client per distinct provider + per-role options pair and returns one entry per role: the client, its provider and model, and the role's bound surface (`session`, `embed`, or `ask`). |
| `createAgenticRuntime` | function | `async function createAgenticRuntime({ roles = [ClientRole.GENERATIVE, ClientRole.EMBEDDING, ClientRole.DECISION], options = {}, clientFactory = initializeClient, seams = null, onDecisionUsage = null } = {})` | The composition root for the decision layer: resolve the three client roles, then hand back one gate (and a per-seam gate factory) plus the option fragments every flow already accepts. |
| `getAvailableModels` | function | `async function getAvailableModels({ client, provider })` | The models a backend can currently serve. |

## 5. Public API surface

Everything importable from the package entry point (`lib/index.mjs`):

| Symbol | Kind | Signature / Source | Summary |
| --- | --- | --- | --- |
| `WebSearchComponent` | class | ↩ `lib/agentic/websearch/component.mjs` | Web-search capability surfaced as a `web_search` function tool. |
| `TavilyEngine` | class | ↩ `lib/agentic/websearch/engines.mjs` | Tavily engine — raw global `fetch` POST to https://api.tavily.com/search. |
| `JaiEngine` | class | ↩ `lib/agentic/websearch/engines.mjs` | JAI engine — rides `taskApi.executeJson('web-search', params, { version:'v4' })`. |
| `resolveSearchMode` | function | ↩ `lib/agentic/websearch/engines.mjs` | Resolves the search mode — the engine the web search runs on. |
| `toUnified` | function | ↩ `lib/agentic/websearch/engines.mjs` | `{ query, answer?, sources: [{ title, url }] }` shape. |
| `WebScrapeComponent` | class | ↩ `lib/agentic/webscrape/component.mjs` | Web-scrape capability surfaced as a `web_scrape` function tool. |
| `TavilyExtractEngine` | class | ↩ `lib/agentic/webscrape/engines.mjs` | Tavily extract engine — raw global `fetch` POST to https://api.tavily.com/extract. |
| `JaiScrapeEngine` | class | ↩ `lib/agentic/webscrape/engines.mjs` | JAI engine — rides `taskApi.executeJson('web-scrape', { url }, { version:'v4' })`. |
| `CurlEngine` | class | ↩ `lib/agentic/webscrape/engines.mjs` | Curl engine — plain `fetch`, strips HTML to text. |
| `resolveScrapeMode` | function | ↩ `lib/agentic/webscrape/engines.mjs` | Resolves the scrape mode — the strategy the web scraper runs in. |
| `toUnifiedScrape` | function | ↩ `lib/agentic/webscrape/engines.mjs` | Curl plain text) to the unified `{ url, content, truncated, _vendor? |
| `BrowserComponent` | class | ↩ `lib/agentic/browser/component.mjs` | Browser capability surfaced as a `browser` function tool: `navigate` (read leg, no action needed) plus the interactive actions (Playwright over `obscura serve` CDP). |
| `INTERACTIVE_ACTIONS` | const | ↩ `lib/agentic/browser/component.mjs` | The interactive actions the browser tool understands — the vocabulary of a page interaction. |
| `ObscuraEngine` | class | ↩ `lib/agentic/browser/engines.mjs` | Obscura engine — standalone `obscura fetch <url> --dump <text\|markdown>`. |
| `PlaywrightSession` | class | ↩ `lib/agentic/browser/engines.mjs` | Interactive session over `obscura serve` CDP via Playwright. |
| `resolveBrowserMode` | function | ↩ `lib/agentic/browser/engines.mjs` | Resolves the browser mode — the strategy the browser tool runs in. |
| `MAX_BROWSER_URLS` | const | ↩ `lib/agentic/browser/engines.mjs` | How many URLs one browser turn may open. |
| `loadCredentials` | function | ↩ `lib/support/utils.mjs` | Reads a backend's credentials from the environment into the options `initializeClient` expects. |
| `configureSdkLog` | function | ↩ `lib/support/utils.mjs` | Configures the SDK logger. |
| `ProtocolType` | const | ↩ `lib/core/constants/index.mjs` | LLM wire protocols — the request/response contract a session speaks. |
| `ProviderType` | const | ↩ `lib/core/constants/index.mjs` | Every concrete provider the SDK can target. |
| `StandardType` | const | ↩ `lib/core/constants/index.mjs` | Every wire standard the SDK speaks. |
| `PROVIDERS` | const | ↩ `lib/core/constants/index.mjs` | Descriptors keyed by ProviderType value. |
| `STANDARDS` | const | ↩ `lib/core/constants/index.mjs` | Descriptors keyed by StandardType value. |
| `standardFor` | function | ↩ `lib/core/constants/index.mjs` |  |
| `isStandard` | function | ↩ `lib/core/constants/index.mjs` | Whether a provider speaks a given wire standard. |
| `providersForStandard` | function | ↩ `lib/core/constants/index.mjs` |  |
| `providerDescriptorFor` | function | ↩ `lib/core/constants/index.mjs` |  |
| `CAPABILITY` | const | ↩ `lib/core/constants/index.mjs` | Registry of LoadableComponent capability ids. |
| `REVIEW_STAGE_REMINDER` | const | ↩ `lib/core/constants/index.mjs` | Default followUp stage: review the produced answer, fix gaps, or reply DONE. |
| `ERROR_CODES` | const | ↩ `lib/core/constants/index.mjs` | Stable machine-readable error codes carried by the MerciError hierarchy. |
| `TIMEOUT_CODES` | const | ↩ `lib/core/constants/index.mjs` | Every machine-readable code the SDK raises for a timeout. |
| `getEmbeddingModel` | function | ↩ `lib/support/utils.mjs` | Resolves the embedding model for a backend from secret.env. |
| `getEmbeddingDimensions` | function | ↩ `lib/support/utils.mjs` | Resolves the JAI embedding output dimensionality from `DEFAULT_JAI_EMBEDDING_DIMENSIONS`, defaulting to 1024. |
| `getDecisionModel` | function | ↩ `lib/support/utils.mjs` | Resolves the decision (System One) model for a backend from secret.env. |
| `getDefaultModel` | function | ↩ `lib/support/utils.mjs` | The default model id of a backend — the tier the orchestrator and the judges run on. |
| `getToolModel` | function | ↩ `lib/support/utils.mjs` | The default tool model id of a backend — the cheap tier the subagents run on. |
| `resolveRole` | function | ↩ `lib/support/utils.mjs` | Resolves one client role to a provider and model. |
| `ClientRole` | const | ↩ `lib/core/constants/index.mjs` | The three client roles a host can resolve. |
| `ROLE_REGISTRY` | const | ↩ `lib/core/constants/index.mjs` | Role descriptors keyed by ClientRole value. |
| `createUserMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates a user message in the backend's wire shape. |
| `createSystemMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates a system message in the backend's wire shape. |
| `createAssistantMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates an assistant text message, optionally carrying a thought signature (and DeepSeek-style `reasoning_content` for multi-turn continuity). |
| `createToolCallMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates an assistant tool-call message in the backend's wire shape. |
| `createToolResultMessage` | function | ↩ `lib/messaging/messages.mjs` | Creates a tool result message in the target backend's wire shape. |
| `createUnifiedMediaMessages` | function | ↩ `lib/backends/media.mjs` | Creates a user turn carrying an image or PDF plus a prompt, per-backend shaped (JAI shapes it natively; GAI/AAI/OAI embed base64 data — a PDF becomes an Anthropic `document` block / an OpenAI `file` part). |
| `PDF_MEDIA_PROVIDERS` | const | ↩ `lib/messaging/messages.mjs` | Backends whose wire can carry an `application/pdf` document as one inline media message: JAI (vendor media part), Gemini/Vertex (`inlineData`), Anthropic (`document` block), OpenAI (`file` part). |
| `normalizeHistory` | function | ↩ `lib/messaging/messages.mjs` | Normalizes a mixed-shape history to the backend's wire format: the JAI shape for JAI, otherwise the OAI normalizer. |
| `getToolCallName` | function | ↩ `lib/messaging/messages.mjs` | Reads the tool name from a tool call in any shape (OAI/JAI/GAI). |
| `getToolCallArguments` | function | ↩ `lib/messaging/messages.mjs` | Reads the tool arguments from a tool call in any shape (OAI/JAI/GAI). |
| `ExponentialBackoffPolicy` | class | ↩ `lib/support/retry-policy.mjs` | A retry policy that retries on transient errors (connection, rate limit, timeout, HTTP 408, 409, 429 and >= 500) with capped exponential backoff and full jitter (AWS Architecture Blog: sleep = random(0, min(cap, base*2^attempt))). |
| `NoRetryPolicy` | class | ↩ `lib/support/retry-policy.mjs` | A retry policy that never retries. |
| `createStreamingRetryPolicy` | function | ↩ `lib/support/retry-policy.mjs` | 30s, 2 retries — matching the OpenAI/Anthropic default). |
| `CircuitBreaker` | class | ↩ `lib/support/retry-policy.mjs` | Consecutive-failure circuit breaker with half-open probing. |
| `getCircuitBreaker` | function | ↩ `lib/support/retry-policy.mjs` | backend/model (or any caller key). |
| `runGuardedStep` | function | ↩ `lib/support/retry-policy.mjs` | Runs `run` behind `breaker`, recording shared backend health. |
| `isTransientError` | function | ↩ `lib/support/retry-policy.mjs` | predicate): true when a fresh default-policy instance would retry the error on attempt 0. |
| `HEADER_TIMEOUT_CODE` | const | ↩ `lib/support/retry-policy.mjs` | Machine-readable code carried by header-timeout abort errors (JAI gateway accepted the connection but sent no response headers in time). |
| `BODY_TIMEOUT_CODE` | const | ↩ `lib/support/retry-policy.mjs` | Machine-readable code for response-body stalls (headers arrived, body dripped). |
| `BREAKER_OPEN_CODE` | const | ↩ `lib/support/retry-policy.mjs` | Machine-readable code for fail-fast rejections while a circuit breaker is open (never retried — the whole point is to stop calling). |
| `hasTimeoutCode` | function | ↩ `lib/support/retry-policy.mjs` | timeout code (`TIMEOUT_CODES`: HEADER_TIMEOUT, BODY_TIMEOUT, STEP_TIMEOUT, STREAM_TIMEOUT, plus the host spellings ETIMEDOUT, TIMEOUT, timeout) — the structural contract that replaces message-substring matching. |
| `log` | const | ↩ `lib/support/utils.mjs` | The shared logger singleton. |
| `defaultDisplay` | function | ↩ `lib/agentic/agentic-core.mjs` | Returns the default display `{ onEvent }` for runAgenticLoop consumers: thinking via the logger, text/tool deltas to stdout (the first text delta of each turn is prefixed with `Assistant > ` so the answer is labelled exactly once), newline on stream_end. |
| `compactHistory` | function | ↩ `lib/agentic/agentic-core.mjs` | a history that already starts with the summary marker is never re-summarized. |
| `runDueSteps` | function | ↩ `lib/agentic/agentic-core.mjs` | Runs the steps that are due and returns one settled result per step, in input order. |
| `AgentLauncher` | class | ↩ `lib/agentic/cli/launcher.mjs` | Interactive agent CLI: system commands, skill-plugin dispatch, and a tool-fed agentic loop over a backend session. |
| `DiscussionSession` | class | ↩ `lib/agentic/discussion-session.mjs` | A multi-agent debate group: agents converse on a shared ledger, optionally judged/aggregated into a conclusion. |
| `StateMachine` | class | ↩ `lib/agentic/state-machine/index.mjs` | A node graph machine with conditional transitions. |
| `foldContext` | function | ↩ `lib/agentic/context-fold.mjs` | Folds a row array at `cut`: keeps the tail and replaces the prefix with a summary row, or with an explicit loss marker when there is no usable summary. |
| `AgentContext` | class | ↩ `lib/agentic/agent-context.mjs` | The context envelope threaded through agentic runs. |
| `normalizeHandoff` | function | ↩ `lib/agentic/agent-context.mjs` | Free combination: goal and context vary independently; tools defaults to inherit. |
| `goalBlockForHandoff` | function | ↩ `lib/agentic/agent-context.mjs` | block when full, the exact full block + marker when moderated. |
| `merciEnvelope` | function | ↩ `lib/agentic/agent-context.mjs` | `{ objective, directive, refs }`, nulls omitted. |
| `contextFromMerciEnvelope` | function | ↩ `lib/agentic/agent-context.mjs` | through). |
| `HANDOFF_MODERATED_MARKER` | const | ↩ `lib/agentic/agent-context.mjs` | Handoff marker appended after the full goal block when goal:'moderated'. |
| `HANDOFF_GOAL_MODES` | const | ↩ `lib/agentic/agent-context.mjs` | Valid `goal` modes for a handoff. |
| `HANDOFF_CONTEXT_MODES` | const | ↩ `lib/agentic/agent-context.mjs` | Valid `context` modes for a handoff. |
| `InactivityTimeoutPolicy` | class | ↩ `lib/support/stream-timeout.mjs` | Sliding-window inactivity timeout. |
| `createLimiter` | function | ↩ `lib/support/limiter.mjs` | Creates a limiter. |
| `runBatch` | function | ↩ `lib/support/limiter.mjs` | per-item retry, returning an index-aligned array of settled outcomes in INPUT order (independent of completion order): `[{status:'fulfilled', value} \| {status:'rejected', reason}]`. |
| `EventEmitterApiObserver` | class | ↩ `lib/support/api-observer.mjs` | The default ApiObserver: emits `api_request` and `api_response` on the session's `EventEmitter` and re-throws / re-emits the error via the `error` event. |
| `CompositeApiObserver` | class | ↩ `lib/support/api-observer.mjs` | Fans one API-call notification out to several observers. |
| `createOtlpExporter` | function | ↩ `lib/support/otel-exporter.mjs` | Creates an OTLP/HTTP JSON exporter for the SDK event stream. |
| `otelAttribute` | function | ↩ `lib/support/otel-exporter.mjs` | Encodes one OTLP attribute. |
| `createCassette` | function | ↩ `lib/support/cassette.mjs` | Creates a cassette. |
| `cassetteKey` | function | ↩ `lib/support/cassette.mjs` | The cassette key of a vendor request. |
| `CASSETTE_MODES` | const | ↩ `lib/support/cassette.mjs` | The cassette modes. |
| `runEvals` | function | ↩ `lib/agentic/evals.mjs` | Runs a suite: every case on a fresh session, every scorer on every run. |
| `EVAL_SCORERS` | const | ↩ `lib/agentic/evals.mjs` | The built-in scorers. |
| `attachEventLogger` | function | ↩ `lib/support/event-logger.mjs` | Subscribes a catch-all logger to an emitter. |
| `createStreamLogger` | function | ↩ `lib/support/event-logger.mjs` | Returns an `onEvent` handler for the agentic step stream that logs every event except those already rendered (`text`, `thought`). |
| `canonicalEventNames` | function | ↩ `lib/support/event-logger.mjs` | Every unique canonical event name in the `EVENTS` registry. |
| `createSaveArtifactTool` | function | ↩ `lib/agentic/artifacts.mjs` | A tool that saves a file the run produced into the artifact directory. |
| `ExecutionJournal` | class | ↩ `lib/agentic/journal.mjs` |  |
| `JOURNAL_STATUS` | const | ↩ `lib/agentic/journal.mjs` | One journal row: its identity, lifecycle, the meta the caller spread in, and the attempt history (flat — each stored attempt drops its own `attempts`). |
| `toolJournalKey` | function | ↩ `lib/agentic/journal.mjs` | The journal key of a tool call — the identity its outcome is recorded under. |
| `journalKey` | function | ↩ `lib/agentic/journal.mjs` | A stable 16-character key for a journal entry, derived from its parts. |
| `runStep` | function | ↩ `lib/agentic/step.mjs` | Runs ONE agentic step attempt in a fresh session: builds the session with the glue's policy/capabilities, runs the agentic loop, forwards stream events through the glue's event names, and captures the step's full message row + reasoning signature for the next attempt/step. |
| `createAcpAgent` | function | ↩ `lib/agentic/acp-agent.mjs` | Wraps a merci ChatSession as an ACP agent app. |
| `permissionAllowed` | function | ↩ `lib/agentic/acp-agent.mjs` | Decides whether an ACP `session/request_permission` response grants the permission. |
| `ACP_STOP_REASONS` | const | ↩ `lib/agentic/acp-agent.mjs` | The ACP prompt stop reasons. |
| `ACP_AGENT_VERSION` | const | ↩ `lib/agentic/acp-agent.mjs` | merci version advertised in the ACP initialize handshake. |
| `ingestDocument` | function | ↩ `lib/agentic/ingest.mjs` | Ingests a document (image or PDF) as Markdown using a vision-capable model. |
| `TaskState` | class | ↩ `lib/agentic/planning/task-state.mjs` | The serializable state of one workflow (DAG) run. |
| `CHECKPOINT_KIND` | const | ↩ `lib/agentic/planning/checkpoint.mjs` | Checkpoint payload kinds. |
| `saveCheckpoint` | function | ↩ `lib/agentic/planning/checkpoint.mjs` | Saves a tagged checkpoint through a session store. |
| `restoreCheckpoint` | function | ↩ `lib/agentic/planning/checkpoint.mjs` | Restores a checkpoint of the expected kind. |
| `structuredLlmCall` | function | ↩ `lib/agentic/planning/planner-utils.mjs` | Calls the LLM and returns structured data matching `schema`. |
| `collectTemplateRefs` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Collects `{{expr}}` template references from a string. |
| `validateTemplateRefs` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Validates that every `{{...}}` reference in each step's `userPromptTemplate` names a known step id or an allowed context root, and — with `ancestorsOnly` — that a step id it names is one of that step's **ancestors**. |
| `assertStateSchema` | function | ↩ `lib/agentic/planning/graph-utils.mjs` | Asserts a step/node output against an optional Zod-like state schema (`safeParse`). |
| `MemoryManager` | class | ↩ `lib/agentic/memory/index.mjs` | Coordinates long-term memory: sync-gap detection, fire-and-forget distillation of new conversation turns, and per-step memory block rendering. |
| `MemoryProvider` | class | ↩ `lib/agentic/memory/index.mjs` | Base memory provider contract. |
| `LocalFileMemoryProvider` | class | ↩ `lib/agentic/memory/index.mjs` | File-backed memory bank: one JSON file of facts with atomic saves. |
| `SqliteMemoryProvider` | class | ↩ `lib/agentic/memory/index.mjs` | SQLite-backed memory bank. |
| `CompositeMemoryProvider` | class | ↩ `lib/agentic/memory/index.mjs` | Fan-out memory provider across named banks. |
| `ProviderMemoryEngine` | class | ↩ `lib/agentic/memory/index.mjs` | Memory engine over a single provider. |
| `MemoryComponent` | class | ↩ `lib/agentic/memory/index.mjs` | The memory capability component: long-term recall/persist exposed as the memory load/save tools. |
| `KnowledgeComponent` | class | ↩ `lib/agentic/knowledge/index.mjs` | The knowledge capability. |
| `buildGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | Builds a graph from one or more documents. |
| `validateGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | Validates a graph. |
| `applyPatch` | function | ↩ `lib/agentic/knowledge/index.mjs` | Applies a patch: add nodes/edges, update node fields, remove by id. |
| `queryGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | The undirected neighbourhood of one node, for the explicit-id query form. |
| `retrieveSubgraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | The whole read path: seed → expand → rank. |
| `renderKnowledgeBlock` | function | ↩ `lib/agentic/knowledge/index.mjs` | Renders a bounded knowledge block for the prompt. |
| `renderWiki` | function | ↩ `lib/agentic/knowledge/index.mjs` | Renders the wiki. |
| `readWikiSha` | function | ↩ `lib/agentic/knowledge/index.mjs` | The graph hash a previously rendered wiki carries, or null. |
| `loadGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | Loads the graph. |
| `saveGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` | Writes the graph and stamps its stats + hash. |
| `loadOntology` | function | ↩ `lib/agentic/knowledge/index.mjs` | Loads the vocabulary. |
| `saveOntology` | function | ↩ `lib/agentic/knowledge/index.mjs` | Writes the vocabulary. |
| `promotableRelations` | function | ↩ `lib/agentic/knowledge/index.mjs` | Custom relations that appear in enough distinct notes to deserve promotion into the vocabulary. |
| `documentSurface` | function | ↩ `lib/agentic/knowledge/index.mjs` | The `document` surface: one graph from one or more text files. |
| `wikiSurface` | function | ↩ `lib/agentic/knowledge/index.mjs` | The `wiki` surface: an existing markdown corpus becomes a reference graph. |
| `memorySurface` | function | ↩ `lib/agentic/knowledge/index.mjs` | The `memory` surface: bank facts become `fact` nodes. |
| `todosSurface` | function | ↩ `lib/agentic/knowledge/index.mjs` | The `todos` surface: tasks and their declared dependencies. |
| `planSurface` | function | ↩ `lib/agentic/knowledge/index.mjs` | The `plan` surface: a task DAG becomes `step` nodes. |
| `GENERIC_PROFILE` | const | ↩ `lib/agentic/knowledge/index.mjs` | Domain-neutral vocabulary: documents, claims, evidence, work items. |
| `LEGAL_PROFILE` | const | ↩ `lib/agentic/knowledge/index.mjs` | The legal vocabulary the existing corpus uses (`legalgraph/v1`). |
| `CORE_RELATIONS` | const | ↩ `lib/agentic/knowledge/index.mjs` | Relations a structural/doc parse or an author may use without a note. |
| `KNOWLEDGE_SCHEMA` | const | ↩ `lib/agentic/knowledge/index.mjs` | Schema id carried by `graph.json`. |
| `graphSha` | function | ↩ `lib/agentic/knowledge/index.mjs` | Stable hash of the graph's content. |
| `profileSources` | function | ↩ `lib/agentic/knowledge/index.mjs` | Measures one or more documents. |
| `proposeOntology` | function | ↩ `lib/agentic/knowledge/index.mjs` | Turns a measurement into a candidate vocabulary. |
| `ontologySha` | function | ↩ `lib/agentic/knowledge/index.mjs` | Identity of a proposal: the shape, not the timestamp. |
| `adoptOntology` | function | ↩ `lib/agentic/knowledge/index.mjs` | Adopts a proposal as the vocabulary. |
| `adoptedProfile` | function | ↩ `lib/agentic/knowledge/index.mjs` | The adopted vocabulary as a profile a graph can be validated against, or null when nothing was adopted. |
| `surfaceFragment` | function | ↩ `lib/agentic/knowledge/index.mjs` | Runs one surface's adapter. |
| `mergeFragment` | function | ↩ `lib/agentic/knowledge/index.mjs` | Merges adapter output into a graph, skipping ids that already exist. |
| `edgeText` | function | ↩ `lib/agentic/knowledge/index.mjs` | The text form of an edge, shared by the prompt block and the wiki so the two cannot drift. |
| `emptyGraph` | function | ↩ `lib/agentic/knowledge/index.mjs` |  |
| `syncCorpus` | function | ↩ `lib/agentic/knowledge/index.mjs` | Load-or-build. |
| `loadCorpus` | function | ↩ `lib/agentic/knowledge/index.mjs` | Loads the persisted graph and its manifest. |
| `loadManifest` | function | ↩ `lib/agentic/knowledge/index.mjs` |  |
| `sourceDelta` | function | ↩ `lib/agentic/knowledge/index.mjs` | What changed between the corpus a graph was built from and the one on disk. |
| `corpusKey` | function | ↩ `lib/agentic/knowledge/index.mjs` | The build identity: sources by path and content, plus the vocabulary that shaped them and the extractor version. |
| `fingerprintSources` | function | ↩ `lib/agentic/knowledge/index.mjs` |  |
| `readSources` | function | ↩ `lib/agentic/knowledge/index.mjs` | Reads the sources from disk, in the order given (the order is part of the key). |
| `nodeKey` | function | ↩ `lib/agentic/knowledge/index.mjs` | Stable identity of a node's content, independent of where it sits. |
| `sourceSha` | function | ↩ `lib/agentic/knowledge/index.mjs` | Content hash of a whole source, for the corpus manifest. |
| `KNOWLEDGE_BUILD_VERSION` | const | ↩ `lib/agentic/knowledge/index.mjs` | Bumped whenever the mechanical pass changes what it emits for the same bytes. |
| `EDGE_SHAPES` | const | ↩ `lib/agentic/knowledge/index.mjs` | The shapes an edge may take beyond "A rel B". |
| `FailureClass` | const | ↩ `lib/agentic/loops/index.mjs` | The failure taxonomy: the classification labels returned by classifyFailure(). |
| `failureFingerprint` | function | ↩ `lib/agentic/loops/index.mjs` | Stable key for "is this the same failed attempt as before?". |
| `RetryLedger` | class | ↩ `lib/agentic/loops/index.mjs` | Retry budget keyed by failure fingerprint, NOT by a global counter. |
| `classifyFailure` | function | ↩ `lib/agentic/loops/index.mjs` | permission/environment boundaries are checked before verification outcomes (a failed command may be a blocked path, not a bad patch). |
| `claimReplan` | function | ↩ `lib/agentic/loops/index.mjs` | budget is spent, else `onClaim(next, label)` with the incremented count and `[replan next/max]` label. |
| `stateFingerprint` | function | ↩ `lib/agentic/loops/index.mjs` | same fingerprint — used to catch oscillation, not just consecutive stalls. |
| `compareProgress` | function | ↩ `lib/agentic/loops/index.mjs` | Compares two progress snapshots — a positive score means the run moved forward. |
| `createLlmJudge` | function | ↩ `lib/agentic/loops/index.mjs` | Returns `(ctx) => ({ passed, evidence })` ready for a LoopContract `judge`. |
| `createScoredJudge` | function | ↩ `lib/agentic/loops/index.mjs` | A typed, scored grader. |
| `WorkspaceManager` | class | ↩ `lib/agentic/workspace/index.mjs` |  |
| `createWorkspaceTools` | function | ↩ `lib/agentic/workspace/index.mjs` | Bind `read`/`grep`/`glob`, the shell tool, and the artifact tool to one workspace handle. |
| `workspaceKeyFor` | function | ↩ `lib/agentic/workspace/index.mjs` | Derive the workspace directory name for a work item id. |
| `resolveWorkspacePath` | function | ↩ `lib/agentic/workspace/index.mjs` | Resolve one workspace path under a root and assert containment, without IO. |
| `isInsideRoot` | function | ↩ `lib/agentic/workspace/index.mjs` | True when `path` is `root` itself or sits below it. |
| `WORKSPACE_STRATEGIES` | const | ↩ `lib/agentic/workspace/index.mjs` | The strategies, frozen so a caller cannot mutate the registry. |
| `WORKSPACE_HOOKS` | const | ↩ `lib/agentic/workspace/index.mjs` | The four lifecycle hooks, in call order. |
| `WorkScheduler` | class | ↩ `lib/agentic/scheduler/index.mjs` | The work-item scheduler: claims, dispatch, retries, parking, and a single-flight tick. |
| `createEngineRunner` | function | ↩ `lib/agentic/scheduler/index.mjs` | Build the one-attempt runner for a scheduler. |
| `WorkflowPolicy` | class | ↩ `lib/agentic/workflow-policy/index.mjs` | A reload is single-flight, keeps the last good state on failure, and arms a debounced watcher only after the first load succeeds. |
| `policyToSchedulerOptions` | function | ↩ `lib/agentic/workflow-policy/index.mjs` | The scheduler options from the resolved policy. |
| `policyToWorkspaceOptions` | function | ↩ `lib/agentic/workflow-policy/index.mjs` | The construction-bound workspace options. |
| `createPolicyRenderer` | function | ↩ `lib/agentic/workflow-policy/index.mjs` | The engine runner's `({ item, attempt, continuation }) => string` prompt callback. |
| `createOrchestration` | function | ↩ `lib/agentic/orchestration/index.mjs` | Build the coordination layer around one client, one board, and one `WORKFLOW.md`. |
| `LoadableComponent` | class | ↩ `lib/core/loadable.mjs` | Base class for operational capabilities (skills, memory, …) that surface a payload to the model. |
| `ChatSessionBuilder` | class | ↩ `lib/agentic/chat-session-builder.mjs` | Fluent builder for ChatSession configuration. |
| `BaseChatSession` | class | ↩ `lib/agentic/chat-session.mjs` | Shared OAI-family ChatSession (oai/gai/aai). |
| `TodoComponent` | class | ↩ `lib/agentic/todos/component.mjs` | The todos capability component: task list management exposed as load/save tools and rendered into the system context. |
| `createPlanStageFollowUp` | function | ↩ `lib/agentic/plan/component.mjs` | until plan_exit has been called this run. |
| `AGENT_PLAN` | const | ↩ `lib/agentic/plan/component.mjs` | Plan-agent identity (read-only). |
| `AGENT_EXECUTE` | const | ↩ `lib/agentic/plan/component.mjs` | Execute-agent identity (full tool set). |
| `buildEnvironmentBlock` | function | ↩ `lib/agentic/context.mjs` | Renders the environment block: working directory, git repo, platform, date. |
| `discoverInstructions` | function | ↩ `lib/agentic/context.mjs` | Discovers and renders AGENTS.md instruction files from `root` up to `stopAt` (inclusive). |
| `createContextTools` | function | ↩ `lib/tools/index.mjs` | The context tools — read, grep and glob over the working directory, as one tool set. |
| `createMcpServer` | function | ↩ `lib/tools/index.mjs` | Creates an MCP stdio server exposing the given tools, connected to stdin/stdout. |
| `createMcpHttpHandler` | function | ↩ `lib/tools/index.mjs` | Creates an MCP server over the Streamable HTTP transport and returns a `node:http` request handler that serves it. |
| `createShellTool` | function | ↩ `lib/tools/index.mjs` | The shell tool — runs a command in the working directory, behind the approval gate. |
| `createShellPolicyTool` | function | ↩ `lib/tools/index.mjs` | `describe_shell_policy`: the effective tier of one shell-tool instance, so a model reads the host's real allowlists instead of guessing from the defaults. |
| `loadMcpTools` | function | ↩ `lib/tools/index.mjs` | (schema normalization + output capping). |
| `loadMcpToolsFrom` | function | ↩ `lib/tools/index.mjs` | Loads a remote MCP server's tools. |
| `McpClient` | class | ↩ `lib/tools/index.mjs` | Thin lifecycle wrapper around the MCP client. |
| `McpTaskStore` | class | ↩ `lib/tools/index.mjs` | In-memory task store: a task record, its abort controller and its retention timer. |
| `FileMcpTaskStore` | class | ↩ `lib/tools/index.mjs` | A durable store: one JSON record per task under `dir`, reloaded on construction, so a task and its result survive a restart. |
| `loadA2ATool` | function | ↩ `lib/tools/index.mjs` | (returns []) when the agent card cannot be loaded or the URL is invalid. |
| `getA2ATask` | function | ↩ `lib/tools/index.mjs` | Reads a remote A2A task by id. |
| `cancelA2ATask` | function | ↩ `lib/tools/index.mjs` | Cancels a remote A2A task. |
| `A2A_COMPLETED_STATES` | const | ↩ `lib/tools/index.mjs` | The A2A task states that mean the task has ended, whichever dialect spelled it. |
| `createA2AServer` | function | ↩ `lib/tools/index.mjs` | Creates an A2A server exposing the given skills. |
| `createA2AHttpHandler` | function | ↩ `lib/tools/index.mjs` | Mounts an A2A server on a `node:http` server. |
| `loadSkillsFromDirectory` | function | ↩ `lib/tools/index.mjs` | Missing roots and missing SKILL.md files are normal skips; corruption is surfaced via sdkWarn and the SKILLS.LOAD_ERROR event. |
| `executeTools` | function | ↩ `lib/tools/index.mjs` | `{ id, tool_call_id, name, success, result\|error }` envelope; tool errors are returned (not thrown), while AbortError rethrows as cancellation. |
| `withToolTimeout` | function | ↩ `lib/tools/index.mjs` | Caps a tool call that outlives its budget. |
| `createOperatorHttpHandler` | function | ↩ `lib/agentic/operator/index.mjs` | Create a `(req, res) => Promise<void>` operator handler (§3.3). |
| `createEventRing` | function | ↩ `lib/agentic/operator/index.mjs` | emitter?: unknown, limit?: number, prefixes?: ReadonlyArray<string>, now?: () => number }} [arg0] |
| `formatStatus` | function | ↩ `lib/agentic/operator/index.mjs` | Render one snapshot as plain text (§3.7). |
| `SkillsLibrary` | class | ↩ `lib/tools/skills.mjs` | Loadable component exposing the registered skills to the model via a list-skills load tool. |
| `ExternalToolCapability` | class | ↩ `lib/tools/external-capability.mjs` | A remote tool family surfaced as a capability: the tool definitions do the work (tools-first), `load()` renders a short catalog listing for the model, and there is no save leg (toSaveTool() is null — no saveToolName passed). |
| `AcpCapability` | class | ↩ `lib/tools/external-capability.mjs` | Agent Client Protocol (ACP) capability — a duck-typed remote-tool adapter. |
| `capToolOutput` | function | ↩ `lib/tools/external-capability.mjs` | Non-strings pass through untouched. |
| `capToolOutputValue` | function | ↩ `lib/tools/external-capability.mjs` | Caps a tool result of **any** shape to a character budget, without changing its type. |
| `withTaskAgents` | function | ↩ `lib/agentic/task.mjs` | duplicate name wins) and returns the client for chaining. |
| `withAgentDelegation` | function | ↩ `lib/agentic/task.mjs` | Declares the host's delegation envelope (D1a). |
| `createTaskTool` | function | ↩ `lib/agentic/task.mjs` | on. |
| `normalizeDelegationEnvelope` | function | ↩ `lib/agentic/task.mjs` | Resolves the effective envelope: the host's declaration over the restrictive defaults. |
| `TASK_TOOL_NAME` | const | ↩ `lib/agentic/task.mjs` | The `task` tool's wire name. |
| `resolveAgentClient` | function | ↩ `lib/agentic/task.mjs` | Resolves the client that should execute an agent/profile on. |
| `getBudgetPool` | function | ↩ `lib/agentic/budget-pool.mjs` | The public read API: the tree's cap and spend, or null when the session has no budget. |
| `getSpawnRegistry` | function | ↩ `lib/agentic/spawn-registry.mjs` | The registry for a client (created once). |
| `listSpawns` | function | ↩ `lib/agentic/spawn-registry.mjs` | Lists the spawns of a client, newest first. |
| `getSpawn` | function | ↩ `lib/agentic/spawn-registry.mjs` | One spawn by id. |
| `sumSpawnUsage` | function | ↩ `lib/agentic/spawn-registry.mjs` | Sums the numeric usage fields of every attempt. |
| `spawnThreadId` | function | ↩ `lib/agentic/spawn-registry.mjs` | The deterministic thread id a durable child is stored under (D10). |
| `continueSpawn` | function | ↩ `lib/agentic/task.mjs` | Continues a settled spawn's conversation with one more turn (SP3). |
| `sendToSpawn` | function | ↩ `lib/agentic/task.mjs` | `client.send({id, prompt})` — the addressing form of `continueWith`. |
| `forkSpawn` | function | ↩ `lib/agentic/task.mjs` | Branches a durable child's conversation (D10). |
| `LocalFileSessionStore` | class | ↩ `lib/agentic/sessions.mjs` | File-backed checkpoint store. |
| `InMemorySessionStore` | class | ↩ `lib/agentic/sessions.mjs` | A `SessionStore` in a `Map`: for tests, evals and short-lived processes. |
| `LocalFileInboxStore` | class | ↩ `lib/agentic/inbox-store.mjs` | File-backed inbox: one JSON file per thread, written atomically (tmp + rename, fsync) so a crash mid-save leaves the previous queue intact. |
| `InMemoryInboxStore` | class | ↩ `lib/agentic/inbox-store.mjs` | Process-local inbox. |
| `INBOX_STORE_VERSION` | const | ↩ `lib/agentic/inbox-store.mjs` | The on-disk shape every inbox store speaks. |
| `PERMISSION_MODES` | const | ↩ `lib/agentic/permissions.mjs` | The permission modes this SDK understands. |
| `isToolPermitted` | function | ↩ `lib/agentic/permissions.mjs` | Whether a tool name passes the allow / deny lists. |
| `isEditTool` | function | ↩ `lib/agentic/permissions.mjs` | Whether a tool name looks like an edit (write / patch / delete / move). |
| `stillRequiresApproval` | function | ↩ `lib/agentic/permissions.mjs` | Whether a gated tool still has to ask under the given permission mode. |
| `normalizePermissionRules` | function | ↩ `lib/agentic/permissions.mjs` | Normalizes a caller-supplied rule bag into the canonical shape. |
| `createGuardrails` | function | ↩ `lib/agentic/guardrails.mjs` | Creates the guardrail engine for a set of rules. |
| `extractUserText` | function | ↩ `lib/agentic/guardrails.mjs` | The text of **every** user turn — what a caller typed into the agent. |
| `decisionTest` | function | ↩ `lib/agentic/guardrails.mjs` | A guardrail predicate backed by the decision gate: `true` only when the gate is certain enough to skip the LLM path. |
| `noulQuestion` | function | ↩ `lib/messaging/decision.mjs` | Builds a yes/no question. |
| `choiceQuestion` | function | ↩ `lib/messaging/decision.mjs` |  |
| `scoreQuestion` | function | ↩ `lib/messaging/decision.mjs` |  |
| `buildDecisionRequest` | function | ↩ `lib/messaging/decision.mjs` | Validates one request and returns it unchanged. |
| `readDecisionAnswer` | function | ↩ `lib/messaging/decision.mjs` | Reads one answer from a result, refusing a missing key or a type the caller did not expect. |
| `DECISION_QUESTION_TYPE` | const | ↩ `lib/messaging/decision.mjs` | The question types every decision wire recognizes. |
| `createDecisionsClient` | function | ↩ `lib/backends/decisions/index.mjs` | Creates the decision client for one provider. |
| `createDecisionGate` | function | ↩ `lib/agentic/decision-gate.mjs` | Builds the gate over a bound decision surface. |
| `certaintyOf` | function | ↩ `lib/agentic/decision-gate.mjs` | The certainty an answer carries, 0..1, or null when it cannot be calibrated. |
| `createDecisionReranker` | function | ↩ `lib/agentic/memory/rerank.mjs` | Builds the `reranker` option `LocalFileMemoryProvider` accepts. |
| `decisionCalibration` | function | ↩ `lib/agentic/decision-calibration.mjs` |  |
| `countConversationTurns` | function | ↩ `lib/messaging/unified-message.mjs` | Counts genuine conversation turns (user messages), ignoring SDK row-injections and tool-result carriers (role:'tool' messages, tool_message rows, and tool_result / functionResponse content blocks). |
| `isInjection` | function | ↩ `lib/messaging/unified-message.mjs` | True when `m` is an SDK row-injection. |
| `stripInjectionMeta` | function | ↩ `lib/messaging/unified-message.mjs` | Returns a copy of `messages` with the non-wire keys (INJECTION_META_KEY, MERCI_ID_KEY and — unless `keepNative` — MERCI_NATIVE_KEY) removed from every message. |
| `dedupeMessages` | function | ↩ `lib/messaging/unified-message.mjs` | Removes duplicate rows by their stable merciId. |
| `MerciError` | error class | ↩ `lib/core/errors.mjs` | Base class for every SDK-thrown error. |
| `BackendError` | error class | ↩ `lib/core/errors.mjs` | A vendor SDK / transport call failed. |
| `ConfigurationError` | error class | ↩ `lib/core/errors.mjs` | The SDK was mis-configured (missing required arg, invalid option, conflicting flags). |
| `MemoryError` | error class | ↩ `lib/core/errors.mjs` | A memory subsystem operation failed (L1 load/store, L2 distillation, L3 skill). |
| `AbortedError` | error class | ↩ `lib/core/errors.mjs` | The AbortSignal was triggered. |
| `BudgetExceededError` | error class | ↩ `lib/core/errors.mjs` | The run exceeded a token budget configured via `session.withBudget(...)` (or the `budget` run option). |
| `MaxTurnsExceededError` | error class | ↩ `lib/core/errors.mjs` | The run exhausted its tool-iteration budget without producing a final text response. |
| `AbstractMethodError` | error class | ↩ `lib/core/errors.mjs` | A subclass failed to implement an abstract method. |
| `OrchestrationError` | error class | ↩ `lib/core/errors.mjs` | Base class for orchestration-control failures raised by the DAG executor, the state machine, the discussion engine, and their shared verify gates. |
| `VerificationError` | error class | ↩ `lib/core/errors.mjs` | A node/step output failed its verification or acceptance gate (deterministic criteria, judge, or a user-supplied `verify`). |
| `OrchestrationExhaustedError` | error class | ↩ `lib/core/errors.mjs` | An orchestration budget/retry/liveness cap was exhausted: step retries, iteration limit, `maxSteps`, `maxVisits`, node timeout, or a run that never produced a usable final answer. |
| `GraphError` | error class | ↩ `lib/core/errors.mjs` | The workflow graph is structurally unusable at runtime — a dependency cycle, an unresolved/dangling dependency, or a deadlock with no runnable step. |
| `OrchestrationFailedError` | error class | ↩ `lib/core/errors.mjs` | The run ended with unrecovered failed steps (self-heal/replan budget spent). |
| `GuardrailViolationError` | error class | ↩ `lib/core/errors.mjs` | A guardrail refused the content. |
| `WorkspaceError` | error class | ↩ `lib/core/errors.mjs` | A workspace key, path, or lifecycle operation failed. |
| `WorkSourceError` | error class | ↩ `lib/core/errors.mjs` | A work source failed to list or refresh items. |
| `SchedulerError` | error class | ↩ `lib/core/errors.mjs` | The scheduler API was misused: a lifecycle call out of order, a reset of a running item, or an attempt to rebind an option that was fixed at construction. |
| `PolicyError` | error class | ↩ `lib/core/errors.mjs` | A `WORKFLOW.md` contract failed to load, parse, resolve, or render. |
| `AgentFileError` | error class | ↩ `lib/core/errors.mjs` | An agent definition file (`*.agent.yaml`) failed validation or loading. |
| `isAbortError` | function | ↩ `lib/core/errors.mjs` | Best-effort detection of an AbortSignal-triggered failure. |
| `wrapError` | function | ↩ `lib/core/errors.mjs` | Wraps a thrown error in the most-specific MerciError subclass based on the available hints. |
| `EVENTS` | const | ↩ `lib/core/events.mjs` | Canonical event-name registry. |
| `RunContext` | class | ↩ `lib/core/events.mjs` | The run context — the identity (run id, parent run) every event of a run carries. |
| `stampEvent` | function | ↩ `lib/core/events.mjs` | Standalone envelope builder for emission points outside any RunContext (parameter building, agent switching). |
| `stampStreamEvent` | function | ↩ `lib/core/events.mjs` | Adds the additive correlation fields to an onEvent stream event ({ type, ... |
| `emitEvent` | function | ↩ `lib/core/events.mjs` | The single event sink. |
| `runWithRunContext` | function | ↩ `lib/core/events.mjs` | Installs `runContext` as the ambient correlation context for `fn`. |
| `currentRunContext` | function | ↩ `lib/core/events.mjs` | The ambient RunContext of the current async execution, or null outside a run. |
| `getLimits` | function | ↩ `lib/core/limit-config.mjs` |  |
| `setLimits` | function | ↩ `lib/core/limit-config.mjs` | Applies programmatic overrides. |
| `resetLimits` | function | ↩ `lib/core/limit-config.mjs` | Drops every programmatic override and the programmatic switch. |
| `reloadLimits` | function | ↩ `lib/core/limit-config.mjs` | Re-reads `merci-limits.json` on the next resolution. |
| `LIMITS` | const | ↩ `lib/core/limit-config.mjs` | Every limit as a lazy property, so a read sees the current env, file and programmatic state. |
| `resolveLimit` | function | ↩ `lib/core/limit-config.mjs` | Resolves one limit for the current process state. |
| `LIMIT_DEFAULTS` | const | ↩ `lib/core/constants/limits.mjs` | Default value of every limit, keyed by its logical name. |
| `LIMIT_REGISTRY` | const | ↩ `lib/core/constants/limits.mjs` | Every tunable limit, keyed by its logical name. |
| `MerciEventEmitter` | class | ↩ `lib/core/emitter.mjs` | Per-subscription options: higher `priority` dispatches first, `prepend` jumps the queue, `once` removes after the first dispatch. |
| `createHooks` | function | ↩ `lib/core/hooks.mjs` | Creates an empty hook registry. |
| `HookRegistry` | class | ↩ `lib/core/hooks.mjs` | The hook registry — an ordered chain of async hooks that can veto or transform a value. |
| `STOP` | const | ↩ `lib/core/hooks.mjs` | The sentinel a hook returns to end a waterfall chain without changing the value. |
| `HOOKS` | const | ↩ `lib/core/hooks.mjs` | Canonical hook-chain names shared by the built-in pipelines and users of `withHooks` (`hooks.add({ name: HOOKS.TOOL_BEFORE, fn })`). |
| `PHASES` | const | ↩ `lib/core/lifecycle.mjs` | Canonical phase names. |
| `enterPhase` | function | ↩ `lib/core/lifecycle.mjs` | Runs `fn` inside a named lifecycle phase, emitting `phase:start` before and `phase:end` after. |
| `resolveProvider` | function | `function resolveProvider({ provider } = {})` | Resolves the active provider: the argument when given, otherwise `PROVIDER` from secret.env (renamed from BACKEND in 0.20). |
| `initializeClient` | function | `async function initializeClient({ provider, options = {} })` | Builds one backend client. |
| `createRoleClients` | function | `async function createRoleClients({ roles = [ClientRole.GENERATIVE, ClientRole.EMBEDDING, ClientRole.DECISION], options = {}, clientFactory = initializeClient } = {})` | Builds one client per distinct provider + per-role options pair and returns one entry per role: the client, its provider and model, and the role's bound surface (`session`, `embed`, or `ask`). |
| `createAgenticRuntime` | function | `async function createAgenticRuntime({ roles = [ClientRole.GENERATIVE, ClientRole.EMBEDDING, ClientRole.DECISION], options = {}, clientFactory = initializeClient, seams = null, onDecisionUsage = null } = {})` | The composition root for the decision layer: resolve the three client roles, then hand back one gate (and a per-seam gate factory) plus the option fragments every flow already accepts. |
| `getAvailableModels` | function | `async function getAvailableModels({ client, provider })` | The models a backend can currently serve. |

## 6. Types (`@typedef`)

### `core`

| Type | Definition | Defined in |
| --- | --- | --- |
| `LimitDescriptor` | `{Readonly<{env: string, legacyEnv: ReadonlyArray<string>, default: number, min?: number, max?: number, unbounded: number, integer: boolean, timer: boolean, guard: boolean, mutable: boolean, doc: string}>}` | `lib/core/constants/limits.mjs` |
| `ProviderCapabilities` | `{Object}` | `lib/core/constants/providers.mjs` |
| `ProviderDescriptor` | `{Object}` | `lib/core/constants/providers.mjs` |
| `RoleDescriptor` | `{Object}` | `lib/core/constants/roles.mjs` |
| `StandardDescriptor` | `{Object}` | `lib/core/constants/standards.mjs` |
| `Registration` | `{{ fn: Function, once: boolean, priority: number, seq: number }}` | `lib/core/emitter.mjs` |
| `ListenerOptions` | `{Object}` | `lib/core/emitter.mjs` |
| `MerciErrorOptions` | `{Object}` | `lib/core/errors.mjs` |
| `BackendErrorOptions` | `{MerciErrorOptions & {status?: number, vendorCode?: string, provider?: string}}` | `lib/core/errors.mjs` |
| `MemoryErrorOptions` | `{MerciErrorOptions & {layer?: string}}` | `lib/core/errors.mjs` |
| `ConfigurationErrorOptions` | `{MerciErrorOptions & {option?: string}}` | `lib/core/errors.mjs` |
| `WorkspaceErrorOptions` | `{MerciErrorOptions & {reason?: string, workItemId?: string\|number, path?: string, stderrTail?: string}}` | `lib/core/errors.mjs` |
| `WorkSourceCategory` | `{typeof import('./constants/work-sources.mjs').WORK_SOURCE_CATEGORIES[number]}` | `lib/core/errors.mjs` |
| `WorkSourceErrorOptions` | `{MerciErrorOptions & {category?: WorkSourceCategory, source?: string, retryable?: boolean, retryAfterMs?: number}}` | `lib/core/errors.mjs` |
| `SchedulerErrorReason` | `{'already_started'\|'not_started'\|'stopped'\|'invalid_attempt'\|'invalid_identifier'\|'not_active'\|'bound_option'}` | `lib/core/errors.mjs` |
| `SchedulerErrorOptions` | `{MerciErrorOptions & {reason?: SchedulerErrorReason}}` | `lib/core/errors.mjs` |
| `BudgetExceededErrorOptions` | `{MerciErrorOptions & {maxTotalTokens?: number, maxBudgetUsd?: number, costUsd?: number, usage?: Record<string, number>}}` | `lib/core/errors.mjs` |
| `GuardrailViolationErrorOptions` | `{MerciErrorOptions & {rule?: import('../agentic/guardrails.mjs').GuardrailRule\|null, phase?: 'input'\|'output'\|null}}` | `lib/core/errors.mjs` |
| `MaxTurnsExceededErrorOptions` | `{MerciErrorOptions & {maxTurns?: number, iterationsUsed?: number, partialOutput?: string\|null}}` | `lib/core/errors.mjs` |
| `PolicyErrorOptions` | `{MerciErrorOptions & {reason?: string\|null, reasons?: string[], field?: string\|null, path?: string\|null, line?: number\|null, column?: number\|null}}` | `lib/core/errors.mjs` |
| `AgentFileErrorOptions` | `{MerciErrorOptions & {reason?: string\|null, reasons?: string[], field?: string\|null, path?: string\|null, line?: number\|null, column?: number\|null, issues?: Array<{reason: string, field: string\|null, line: number\|null, column: number\|null}>}}` | `lib/core/errors.mjs` |
| `VerificationErrorOptions` | `{MerciErrorOptions & {stepId?: string, nodeId?: string, classification?: string, evidence?: string, fingerprint?: string, attempts?: number, label?: string, issues?: Array<string>}}` | `lib/core/errors.mjs` |
| `OrchestrationExhaustedErrorOptions` | `{MerciErrorOptions & {limit?: string\|number}}` | `lib/core/errors.mjs` |
| `OrchestrationFailedErrorOptions` | `{MerciErrorOptions & {failedSteps?: Array<string>, failedOutputs?: Record<string, Object>}}` | `lib/core/errors.mjs` |
| `ErrorLike` | `{Object}` | `lib/core/errors.mjs` |
| `HookReg` | `{{ fn: Function, priority: number, seq: number }}` | `lib/core/hooks.mjs` |
| `LimitEntry` | `{Object}` | `lib/core/limit-config.mjs` |
| `LoadableTool` | `{Object}` | `lib/core/loadable.mjs` |
| `CognitiveMemoryPrompts` | `{Object}` | `lib/core/prompts/memory.mjs` |

### `messaging`

| Type | Definition | Defined in |
| --- | --- | --- |
| `NoulQuestion` | `{Object}` | `lib/messaging/decision.mjs` |
| `ChoiceQuestion` | `{Object}` | `lib/messaging/decision.mjs` |
| `ScoreQuestion` | `{Object}` | `lib/messaging/decision.mjs` |
| `DecisionQuestion` | `{NoulQuestion\|ChoiceQuestion\|ScoreQuestion}` | `lib/messaging/decision.mjs` |
| `DecisionRequest` | `{Object}` | `lib/messaging/decision.mjs` |
| `DecisionAnswer` | `{Object}` | `lib/messaging/decision.mjs` |
| `DecisionResult` | `{Object}` | `lib/messaging/decision.mjs` |
| `ToolCallShape` | `{Object}` | `lib/messaging/messages.mjs` |
| `GaiFunctionCall` | `{Object}` | `lib/messaging/messages.mjs` |
| `GaiFunctionResponse` | `{Object}` | `lib/messaging/messages.mjs` |
| `MediaSource` | `{Object}` | `lib/messaging/messages.mjs` |
| `CacheControl` | `{Object}` | `lib/messaging/messages.mjs` |
| `MessageRow` | `{Object}` | `lib/messaging/messages.mjs` |
| `JaiNormalizeOptions` | `{Object}` | `lib/messaging/messages.mjs` |
| `OaiNormalizeOptions` | `{Object}` | `lib/messaging/messages.mjs` |
| `MessageRow` | `{Record<string, unknown>}` | `lib/messaging/row-shape.mjs` |
| `UnifiedSystemMessage` | `{Object}` | `lib/messaging/unified-message.mjs` |
| `UnifiedUserMessage` | `{Object}` | `lib/messaging/unified-message.mjs` |
| `UnifiedAssistantTextMessage` | `{Object}` | `lib/messaging/unified-message.mjs` |
| `UnifiedAssistantToolCallMessage` | `{Object}` | `lib/messaging/unified-message.mjs` |
| `UnifiedToolResultMessage` | `{Object}` | `lib/messaging/unified-message.mjs` |
| `UnifiedMessage` | `{UnifiedSystemMessage\|UnifiedUserMessage\|UnifiedAssistantTextMessage\|UnifiedAssistantToolCallMessage\|UnifiedToolResultMessage}` | `lib/messaging/unified-message.mjs` |
| `MessageRow` | `{Record<string, unknown>}` | `lib/messaging/unified-message.mjs` |
| `ToolChoice` | `{{ type: 'named', name: string } \| string}` | `lib/messaging/unified-parameter.mjs` |
| `UnifiedSpec` | `{Object}` | `lib/messaging/unified-parameter.mjs` |
| `ResponseFormat` | `{Object}` | `lib/messaging/unified-parameter.mjs` |
| `Tool` | `{Object}` | `lib/messaging/unified-parameter.mjs` |

### `backends`

| Type | Definition | Defined in |
| --- | --- | --- |
| `AaiSession` | `{{ _webSearch?: AaiWebSearch, _webScrape?: AaiWebScrape, _retryPolicy?: {shouldRetry: Function}\|null, _maxElapsedMs?: number }}` | `lib/backends/adapters/aai-adapter.mjs` |
| `AaiWebSearch` | `{{ mode?: string, maxUses?: number, maxResults?: number, allowedDomains?: Array<string>, blockedDomains?: Array<string>, location?: Object\|null, force?: boolean }}` | `lib/backends/adapters/aai-adapter.mjs` |
| `AaiWebScrape` | `{{ mode?: string, maxUses?: number, allowedDomains?: Array<string>, blockedDomains?: Array<string>, force?: boolean }}` | `lib/backends/adapters/aai-adapter.mjs` |
| `AdapterCore` | `{Object}` | `lib/backends/adapters/adapter-common.mjs` |
| `AdapterContract` | `{Record<string, unknown> & AdapterCore}` | `lib/backends/adapters/adapter-common.mjs` |
| `QuotaData` | `{Object}` | `lib/backends/adapters/adapter-common.mjs` |
| `GaiSession` | `{{ eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>\|null, provider?: string, _webSearch?: GaiWebSearch, _webScrape?: GaiWebScrape, _retryPolicy?: {shouldRetry: Function}\|null, _maxElapsedMs?: number }}` | `lib/backends/adapters/gai-adapter.mjs` |
| `GaiWebSearch` | `{{ mode?: string, maxResults?: number, allowedDomains?: Array<string>, blockedDomains?: Array<string>, force?: boolean }}` | `lib/backends/adapters/gai-adapter.mjs` |
| `GaiWebScrape` | `{{ mode?: string, allowedDomains?: Array<string>, force?: boolean }}` | `lib/backends/adapters/gai-adapter.mjs` |
| `JaiSession` | `{{ sessionId?: string, _sessionRunCtx?: { runId?: string }, _headerTimeoutMs?: number, stream: (messages: Array<import('../../messaging/unified-message.mjs').MessageRow>, opts: Record<string, unknown>) => AsyncGenerator<Record<string, unknown>> }}` | `lib/backends/adapters/jai-adapter.mjs` |
| `JaiRequest` | `{{ isLastIteration: boolean, runContext: unknown \| null }}` | `lib/backends/adapters/jai-adapter.mjs` |
| `JaiToolCall` | `{{ id?: string, name?: string, arguments?: string\|Object, thoughtSignature?: string\|null }}` | `lib/backends/adapters/jai-adapter.mjs` |
| `OaiSession` | `{{ opencodeSessionId?: string, sessionId?: string, _sessionRunCtx?: { runId?: string }, provider?: string, protocol?: string, responsesAssistantPartType?: string, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>\|null, _webSearch?: OaiWebSearch, _webScrape?: OaiWebScrape }}` | `lib/backends/adapters/oai-adapter.mjs` |
| `OaiWebSearch` | `{{ mode?: string, maxResults?: number, maxUses?: number, allowedDomains?: Array<string>, blockedDomains?: Array<string>, location?: Object\|null, force?: boolean }}` | `lib/backends/adapters/oai-adapter.mjs` |
| `OaiWebScrape` | `{{ mode?: string, maxChars?: number, allowedDomains?: Array<string>, blockedDomains?: Array<string>, force?: boolean }}` | `lib/backends/adapters/oai-adapter.mjs` |
| `DecisionsAdapter` | `{Object}` | `lib/backends/decisions/adapters/decisions-common.mjs` |
| `DecisionsClientOptions` | `{Object}` | `lib/backends/decisions/client.mjs` |
| `DecisionsClient` | `{Object}` | `lib/backends/decisions/client.mjs` |
| `GoogleCredential` | `{Record<string, unknown>}` | `lib/backends/gai.mjs` |
| `GoogleAuthOptions` | `{Object}` | `lib/backends/gai.mjs` |
| `GenaiOptions` | `{Object}` | `lib/backends/gai.mjs` |
| `GaiClientOptions` | `{Object}` | `lib/backends/gai.mjs` |
| `TaskHttpClient` | `{Object}` | `lib/backends/jai-vendor/api.mjs` |
| `TaskStreamOptions` | `{Object}` | `lib/backends/jai-vendor/api.mjs` |
| `TaskStreamEvent` | `{Object}` | `lib/backends/jai-vendor/api.mjs` |
| `JaiProfileManager` | `{Object}` | `lib/backends/jai-vendor/chat-session.mjs` |
| `ChatStreamOptions` | `{Object}` | `lib/backends/jai-vendor/chat-session.mjs` |
| `MerciClientOptions` | `{Object}` | `lib/backends/jai-vendor/client.mjs` |
| `HttpOptions` | `{Object}` | `lib/backends/jai-vendor/http-client.mjs` |
| `FetchOptions` | `{Object}` | `lib/backends/jai-vendor/http-client.mjs` |
| `JaiProfile` | `{Object}` | `lib/backends/jai-vendor/profiles.mjs` |
| `ProfileHttpClient` | `{Object}` | `lib/backends/jai-vendor/profiles.mjs` |
| `CachedJaiProfile` | `{JaiProfile & {params?: Set<string>}}` | `lib/backends/jai-vendor/profiles.mjs` |
| `PendingToolCall` | `{Object}` | `lib/backends/jai-vendor/sse-parser.mjs` |
| `SSEEvent` | `{Object}` | `lib/backends/jai-vendor/sse-parser.mjs` |
| `SSELineParser` | `{Object}` | `lib/backends/jai-vendor/sse-parser.mjs` |
| `LLMParamDef` | `{Object}` | `lib/backends/jai-vendor/types.mjs` |
| `LLMParametersDef` | `{Object}` | `lib/backends/jai-vendor/types.mjs` |
| `AaiPagePromise` | `{Promise<AaiPage> & AsyncIterable<Record<string, unknown>>}` | `lib/backends/transport/aai-client.mjs` |
| `AaiTransportOptions` | `{Object}` | `lib/backends/transport/aai-client.mjs` |
| `AaiCallOptions` | `{Object}` | `lib/backends/transport/aai-client.mjs` |
| `ApiErrorShape` | `{Error & {status?: number, headers?: Headers, requestID?: string\|null, error?: unknown, code?: unknown, type?: unknown, param?: unknown}}` | `lib/backends/transport/errors.mjs` |
| `AnthropicApiErrorShape` | `{Error & {status?: number, headers?: Headers, requestID?: string\|null, error?: unknown, apiMessage?: unknown, type?: unknown, errorCode?: string\|null, details?: unknown}}` | `lib/backends/transport/errors.mjs` |
| `GoogleAuth` | `{{getToken: (options?: {signal?: AbortSignal}) => Promise<string>, getAuthHeaders: (options?: {signal?: AbortSignal}) => Promise<Headers>, source?: string\|null}}` | `lib/backends/transport/gai-client.mjs` |
| `GaiTransportOptions` | `{Object}` | `lib/backends/transport/gai-client.mjs` |
| `GaiPager` | `{ReturnType<typeof createPager>}` | `lib/backends/transport/gai-client.mjs` |
| `GaiTransport` | `{Object}` | `lib/backends/transport/gai-client.mjs` |
| `CredentialJson` | `{Record<string, unknown>}` | `lib/backends/transport/google-auth.mjs` |
| `ServiceAccountKey` | `{{email: string, privateKey: string, subject?: string}}` | `lib/backends/transport/google-auth.mjs` |
| `AuthorizedUserKey` | `{{clientId: string, clientSecret: string, refreshToken: string}}` | `lib/backends/transport/google-auth.mjs` |
| `Resolution` | `{{kind: 'service_account', key: ServiceAccountKey, source: string} \| {kind: 'authorized_user', key: AuthorizedUserKey, source: string} \| {kind: 'metadata', base: string, source: string}}` | `lib/backends/transport/google-auth.mjs` |
| `TokenEntry` | `{{accessToken: string, tokenType: string, expiresAt: number}}` | `lib/backends/transport/google-auth.mjs` |
| `GoogleAuth` | `{Object}` | `lib/backends/transport/google-auth.mjs` |
| `AuthHeader` | `{{name: string, value: string}}` | `lib/backends/transport/http.mjs` |
| `OaiTransportOptions` | `{Object}` | `lib/backends/transport/oai-client.mjs` |
| `OaiCallOptions` | `{Object}` | `lib/backends/transport/oai-client.mjs` |
| `TransportOptions` | `{Object}` | `lib/backends/transport/options.mjs` |
| `SseEvent` | `{Object}` | `lib/backends/transport/sse.mjs` |
| `SseState` | `{Object}` | `lib/backends/transport/sse.mjs` |
| `LineScanner` | `{Object}` | `lib/backends/transport/sse.mjs` |
| `SseJsonState` | `{{sawDone: boolean, sawAbort?: boolean, sawBytes?: boolean}}` | `lib/backends/transport/sse.mjs` |

### `support`

| Type | Definition | Defined in |
| --- | --- | --- |
| `ApiRequestMeta` | `{Object}` | `lib/support/api-observer.mjs` |
| `ApiResponseMeta` | `{Object}` | `lib/support/api-observer.mjs` |
| `ApiErrorMeta` | `{Object}` | `lib/support/api-observer.mjs` |
| `ApiRetryMeta` | `{Object}` | `lib/support/api-observer.mjs` |
| `ApiObserver` | `{Object}` | `lib/support/api-observer.mjs` |
| `ObserverRunContext` | `{Object}` | `lib/support/api-observer.mjs` |
| `ObserverEmitter` | `{import('node:events').EventEmitter<Record<string, unknown[]>>}` | `lib/support/api-observer.mjs` |
| `CassetteAdapter` | `{Object}` | `lib/support/cassette.mjs` |
| `Cassette` | `{Object}` | `lib/support/cassette.mjs` |
| `JsonSchema` | `{Record<string, unknown>}` | `lib/support/json.mjs` |
| `ZodSchema` | `{Object}` | `lib/support/json.mjs` |
| `SchemaLike` | `{JsonSchema\|ZodSchema}` | `lib/support/json.mjs` |
| `ValidationDetail` | `{Object}` | `lib/support/json.mjs` |
| `ParseResult` | `{Object}` | `lib/support/json.mjs` |
| `LimitedRun` | `{(fn: () => Promise<T>) => Promise<T>}` | `lib/support/limiter.mjs` |
| `BatchRetryPolicy` | `{{shouldRetry: Function}}` | `lib/support/limiter.mjs` |
| `LogValue` | `{Object\|null\|undefined}` | `lib/support/logger.mjs` |
| `LogSink` | `{Object}` | `lib/support/logger.mjs` |
| `WireMeta` | `{Object}` | `lib/support/logger.mjs` |
| `UsageMeta` | `{Object}` | `lib/support/logger.mjs` |
| `CreditAmount` | `{Object}` | `lib/support/logger.mjs` |
| `CreditsMeta` | `{Object}` | `lib/support/logger.mjs` |
| `OtlpAttributeValue` | `{Object}` | `lib/support/otel-exporter.mjs` |
| `OtlpAttribute` | `{Object}` | `lib/support/otel-exporter.mjs` |
| `OtlpSpan` | `{Object}` | `lib/support/otel-exporter.mjs` |
| `FetchResult` | `{Object}` | `lib/support/otel-exporter.mjs` |
| `OtlpExporter` | `{object}` | `lib/support/otel-exporter.mjs` |
| `OpenSpan` | `{{span: OtlpSpan, startMs: number, attempts: number}}` | `lib/support/otel-exporter.mjs` |
| `ErrWithCode` | `{Error & { code?: string, cause?: unknown }}` | `lib/support/retry-policy.mjs` |
| `RetryDecision` | `{Object}` | `lib/support/retry-policy.mjs` |
| `RetryEvent` | `{Object}` | `lib/support/retry-policy.mjs` |
| `RetrySession` | `{Object}` | `lib/support/retry-policy.mjs` |
| `RetryPolicy` | `{Object}` | `lib/support/retry-policy.mjs` |
| `StreamTimeoutPolicy` | `{Object}` | `lib/support/stream-timeout.mjs` |
| `YamlMappingReason` | `{'yaml_parse_error'\|'yaml_unsupported_tag'\|'yaml_not_a_map'}` | `lib/support/yaml-mapping.mjs` |
| `YamlPosition` | `{object}` | `lib/support/yaml-mapping.mjs` |
| `YamlMappingFailure` | `{object}` | `lib/support/yaml-mapping.mjs` |

### `tools`

| Type | Definition | Defined in |
| --- | --- | --- |
| `A2APartLike` | `{{text?: string, content?: {text?: string}, kind?: string, data?: unknown}}` | `lib/tools/a2a-dialect.mjs` |
| `A2AMessageLike` | `{{parts?: Array<unknown>}}` | `lib/tools/a2a-dialect.mjs` |
| `A2ASkill` | `{Object}` | `lib/tools/a2a-server.mjs` |
| `A2AToolDef` | `{import('./tool-execution.mjs').ReadyTool}` | `lib/tools/a2a.mjs` |
| `RemoteTool` | `{Object}` | `lib/tools/external-capability.mjs` |
| `AcpClient` | `{Object}` | `lib/tools/external-capability.mjs` |
| `McpTransport` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpRequest` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpRequestContext` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpSamplingRequest` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpSamplingResponse` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpElicitRequest` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpElicitResponse` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpRoot` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpClientOptions` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpSdkClient` | `{{ setRequestHandler: (method: string, handler: (request: McpRequest, ctx: McpRequestContext) => Promise<unknown>) => void, setNotificationHandler: (method: string, handler: (notification: McpRequest) => void\|Promise<void>) => void, connect: (transport: McpTransport) => Promise<void>, close: () => Promise<void>, getProtocolEra?: () => string\|undefined, getNegotiatedProtocolVersion?: () => string\|undefined }}` | `lib/tools/mcp-client.mjs` |
| `McpResource` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpResourceContents` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpPrompt` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpPromptResult` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpTool` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpToolSet` | `{Array<McpToolDefinition> & {stop?: () => Promise<void>}}` | `lib/tools/mcp-client.mjs` |
| `McpToolDefinition` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpToolResult` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpTask` | `{Object}` | `lib/tools/mcp-client.mjs` |
| `McpResourceDef` | `{Object}` | `lib/tools/mcp-server.mjs` |
| `McpPromptRender` | `{Object}` | `lib/tools/mcp-server.mjs` |
| `McpPromptDef` | `{Object}` | `lib/tools/mcp-server.mjs` |
| `McpServerHandle` | `{Object}` | `lib/tools/mcp-server.mjs` |
| `McpTransportLike` | `{Object}` | `lib/tools/mcp-server.mjs` |
| `McpHttpSession` | `{Object}` | `lib/tools/mcp-server.mjs` |
| `McpTaskStoreLike` | `{import('./mcp-task-store.mjs').McpTaskStoreLike}` | `lib/tools/mcp-server.mjs` |
| `McpTask` | `{import('./mcp-client.mjs').McpTask}` | `lib/tools/mcp-task-store.mjs` |
| `TaskEntry` | `{Object}` | `lib/tools/mcp-task-store.mjs` |
| `McpTaskStoreLike` | `{Object}` | `lib/tools/mcp-task-store.mjs` |
| `SkillEntry` | `{Object}` | `lib/tools/skills.mjs` |
| `SkillTool` | `{import('./tool-execution.mjs').ToolDefinition & {execute: Function, parameters: import('../support/json.mjs').JsonSchema, command?: string\|null, instructions?: string\|null, scripts?: Array<{name: string, path: string, interpreter: string}>, metadata?: {frontmatter?: Record<string, unknown>, allowedTools?: Array<string>}}}` | `lib/tools/skills.mjs` |
| `RunContext` | `{import('../core/events.mjs').RunContext}` | `lib/tools/tool-execution.mjs` |
| `ToolCallRow` | `{Object}` | `lib/tools/tool-execution.mjs` |
| `ToolDefinition` | `{Object}` | `lib/tools/tool-execution.mjs` |
| `ReadyTool` | `{ToolDefinition & {execute: Function, parameters: import('../support/json.mjs').JsonSchema}}` | `lib/tools/tool-execution.mjs` |

### `agentic`

| Type | Definition | Defined in |
| --- | --- | --- |
| `AcpPermissionRequest` | `{Object}` | `lib/agentic/acp-agent.mjs` |
| `AcpElicitRequest` | `{Object}` | `lib/agentic/acp-agent.mjs` |
| `AcpTerminalCreateRequest` | `{Object}` | `lib/agentic/acp-agent.mjs` |
| `AcpClientBridge` | `{Object}` | `lib/agentic/acp-agent.mjs` |
| `MerciAcpSession` | `{Object}` | `lib/agentic/acp-agent.mjs` |
| `AcpSessionFactory` | `{(arg0: {sessionId: string, cwd: string, parentSessionId: string\|null}) => MerciAcpSession\|Promise<MerciAcpSession>}` | `lib/agentic/acp-agent.mjs` |
| `AcpTurnContextHook` | `{(opts: AcpClientBridge) => (void\|(() => void))}` | `lib/agentic/acp-agent.mjs` |
| `AcpSessionState` | `{{id: string, aborts: Set<AbortController>, parent: string\|null, cwd: string, session: Promise<MerciAcpSession>\|null, tail: Promise<unknown>}}` | `lib/agentic/acp-agent.mjs` |
| `ObjectivePolicy` | `{Object}` | `lib/agentic/agent-context.mjs` |
| `HandoffOptions` | `{Object}` | `lib/agentic/agent-context.mjs` |
| `AgentContextJSON` | `{Object}` | `lib/agentic/agent-context.mjs` |
| `MerciEnvelope` | `{Object}` | `lib/agentic/agent-context.mjs` |
| `DueStep` | `{Object}` | `lib/agentic/agentic-core.mjs` |
| `StepOutcome` | `{Object}` | `lib/agentic/agentic-core.mjs` |
| `StepStreamEvent` | `{Object}` | `lib/agentic/agentic-core.mjs` |
| `Criterion` | `{Object}` | `lib/agentic/agentic-core.mjs` |
| `MessageRow` | `{Object}` | `lib/agentic/agentic-core.mjs` |
| `Session` | `{Object}` | `lib/agentic/agentic-core.mjs` |
| `UsageState` | `{Object}` | `lib/agentic/agentic-core.mjs` |
| `LoopOptions` | `{Object}` | `lib/agentic/agentic-core.mjs` |
| `AgentSpecLike` | `{Object}` | `lib/agentic/agents/apply.mjs` |
| `AgentSessionLike` | `{Object}` | `lib/agentic/agents/apply.mjs` |
| `AgentToolGroup` | `{Object}` | `lib/agentic/agents/catalog.mjs` |
| `AgentScriptDefinition` | `{object}` | `lib/agentic/agents/spec.mjs` |
| `AgentSpec` | `{object}` | `lib/agentic/agents/spec.mjs` |
| `YamlPosition` | `{{line: number, column: number}}` | `lib/agentic/agents/spec.mjs` |
| `AgentIssue` | `{{reason: string, field: string\|null, line: number\|null, column: number\|null}}` | `lib/agentic/agents/spec.mjs` |
| `AgentSpecLike` | `{Object}` | `lib/agentic/agents/toolbox.mjs` |
| `AgentScriptDefinition` | `{Object}` | `lib/agentic/agents/toolbox.mjs` |
| `AgentToolbox` | `{Object}` | `lib/agentic/agents/toolbox.mjs` |
| `ResolvedToolset` | `{Object}` | `lib/agentic/agents/toolbox.mjs` |
| `NormalizedApproval` | `{Object}` | `lib/agentic/approval.mjs` |
| `ArtifactEntry` | `{Object}` | `lib/agentic/artifacts.mjs` |
| `SaveArtifactTool` | `{Object}` | `lib/agentic/artifacts.mjs` |
| `BrowserConfig` | `{Object}` | `lib/agentic/browser/component.mjs` |
| `BrowserFetchResult` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `ObscuraFetchOptions` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `SnapshotElement` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `NetworkEvent` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `ConsoleEvent` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `BrowserLocator` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `BrowserPage` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `BrowserRouteRequest` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `BrowserRoute` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `BrowserSocketRoute` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `BrowserContext` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `BrowserContextOptions` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `BrowserConnection` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `PlaywrightSessionOptions` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `BrowserActionParams` | `{Object}` | `lib/agentic/browser/engines.mjs` |
| `BudgetUsage` | `{{prompt_tokens: number, completion_tokens: number, total_tokens: number}}` | `lib/agentic/budget-accounting.mjs` |
| `TokenBudget` | `{{maxTotalTokens?: number, maxBudgetUsd?: number}}` | `lib/agentic/budget-accounting.mjs` |
| `BudgetCandidate` | `{{maxTotalTokens?: unknown, maxBudgetUsd?: unknown}}` | `lib/agentic/budget-accounting.mjs` |
| `PoolUsage` | `{Object}` | `lib/agentic/budget-pool.mjs` |
| `BudgetPool` | `{Object}` | `lib/agentic/budget-pool.mjs` |
| `PoolUsageInput` | `{Object}` | `lib/agentic/budget-pool.mjs` |
| `BuilderClient` | `{import('./task.mjs').TaskClient & {tasks?: Object}}` | `lib/agentic/chat-session-builder.mjs` |
| `MemoryClient` | `{Object}` | `lib/agentic/chat-session-builder.mjs` |
| `TelemetryExporter` | `{Object}` | `lib/agentic/chat-session-builder.mjs` |
| `StepComponentEntry` | `{Object}` | `lib/agentic/chat-session-builder.mjs` |
| `WebSearchOptions` | `{Object}` | `lib/agentic/chat-session-builder.mjs` |
| `LoopOptions` | `{import('./agentic-core.mjs').LoopOptions}` | `lib/agentic/chat-session-builder.mjs` |
| `WebCapConfig` | `{Object}` | `lib/agentic/chat-session-builder.mjs` |
| `StepEvent` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `StepFinalState` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `ToolCall` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `ChatRow` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `StepOptions` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `StepAdapter` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `SessionClient` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `RetryPolicyLike` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `StreamTimeoutPolicyLike` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `ApiObserverLike` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `VendorRequest` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `NativePayload` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `ToolResult` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `FirstEventResult` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `StepCallContext` | `{Object}` | `lib/agentic/chat-session.mjs` |
| `LauncherSkill` | `{Object}` | `lib/agentic/cli/launcher.mjs` |
| `LauncherStepEvent` | `{Object}` | `lib/agentic/cli/launcher.mjs` |
| `LauncherSession` | `{Object}` | `lib/agentic/cli/launcher.mjs` |
| `LauncherClient` | `{Object}` | `lib/agentic/cli/launcher.mjs` |
| `FoldedContext` | `{Object}` | `lib/agentic/context-fold.mjs` |
| `InstructionFile` | `{Object}` | `lib/agentic/context.mjs` |
| `CachedInstructions` | `{Object}` | `lib/agentic/context.mjs` |
| `CalibrationSample` | `{Object}` | `lib/agentic/decision-calibration.mjs` |
| `CalibrationBin` | `{Object}` | `lib/agentic/decision-calibration.mjs` |
| `ThresholdPoint` | `{Object}` | `lib/agentic/decision-calibration.mjs` |
| `DecisionAnswer` | `{import('../messaging/decision.mjs').DecisionAnswer}` | `lib/agentic/decision-gate.mjs` |
| `DecisionQuestion` | `{import('../messaging/decision.mjs').DecisionQuestion}` | `lib/agentic/decision-gate.mjs` |
| `DecisionUsage` | `{{inputTokens?: number\|null, outputTokens?: number\|null, cost?: number\|null}}` | `lib/agentic/decision-gate.mjs` |
| `SurfaceResult` | `{{model?: string, answers: Record<string, Record<string, unknown>>, usage?: DecisionUsage\|null}}` | `lib/agentic/decision-gate.mjs` |
| `GateVerdict` | `{Object}` | `lib/agentic/decision-gate.mjs` |
| `GateChoice` | `{Object}` | `lib/agentic/decision-gate.mjs` |
| `GateScore` | `{Object}` | `lib/agentic/decision-gate.mjs` |
| `DecisionGate` | `{Object}` | `lib/agentic/decision-gate.mjs` |
| `DecisionUsageSession` | `{{_decisionUsage?: {prompt_tokens: number, completion_tokens: number, total_tokens: number, estimated_tokens: number, cost_usd: number\|null}\|null, _decisionUsageGates?: WeakMap<object, import('./decision-gate.mjs').DecisionGate>}}` | `lib/agentic/decision-usage.mjs` |
| `DiscussionAgent` | `{Object}` | `lib/agentic/discussion-session.mjs` |
| `LedgerEntry` | `{Object}` | `lib/agentic/discussion-session.mjs` |
| `TurnOptions` | `{Object}` | `lib/agentic/discussion-session.mjs` |
| `VerdictEntry` | `{Object}` | `lib/agentic/discussion-session.mjs` |
| `DiscussionTask` | `{Object}` | `lib/agentic/discussion-session.mjs` |
| `PlannedStep` | `{Object}` | `lib/agentic/discussion-session.mjs` |
| `PhaseOptions` | `{Object}` | `lib/agentic/discussion-session.mjs` |
| `ConcludeOptions` | `{Object}` | `lib/agentic/discussion-session.mjs` |
| `DiscussionClient` | `{Object}` | `lib/agentic/discussion-session.mjs` |
| `GroupSession` | `{Object}` | `lib/agentic/discussion-session.mjs` |
| `DiscussionSessionOptions` | `{Object}` | `lib/agentic/discussion-session.mjs` |
| `EvalCase` | `{Object}` | `lib/agentic/evals.mjs` |
| `EvalExpectations` | `{Object}` | `lib/agentic/evals.mjs` |
| `EvalObservation` | `{Object}` | `lib/agentic/evals.mjs` |
| `EvalVerdict` | `{Object}` | `lib/agentic/evals.mjs` |
| `EvalScorer` | `{(arg0: {observation: EvalObservation, signal?: AbortSignal\|null}) => EvalVerdict\|Promise<EvalVerdict>}` | `lib/agentic/evals.mjs` |
| `EvalResult` | `{Object}` | `lib/agentic/evals.mjs` |
| `EvalSession` | `{Object}` | `lib/agentic/evals.mjs` |
| `GuardrailRule` | `{Object}` | `lib/agentic/guardrails.mjs` |
| `GuardrailPhase` | `{'input'\|'output'\|'tool_input'\|'tool_output'}` | `lib/agentic/guardrails.mjs` |
| `GuardrailVerdict` | `{Object}` | `lib/agentic/guardrails.mjs` |
| `Guardrails` | `{Object}` | `lib/agentic/guardrails.mjs` |
| `InboxLease` | `{Object}` | `lib/agentic/inbox-store.mjs` |
| `InboxRow` | `{Record<string, unknown>}` | `lib/agentic/inbox-store.mjs` |
| `InboxStore` | `{Object}` | `lib/agentic/inbox-store.mjs` |
| `IngestClient` | `{Object}` | `lib/agentic/ingest.mjs` |
| `JournalStatus` | `{'intent'\|'done'\|'failed'\|'interrupted'}` | `lib/agentic/journal.mjs` |
| `JournalOutcome` | `{Object}` | `lib/agentic/journal.mjs` |
| `JournalEntry` | `{Object}` | `lib/agentic/journal.mjs` |
| `KnowledgeSource` | `{Object}` | `lib/agentic/knowledge/build.mjs` |
| `SourceFingerprint` | `{Object}` | `lib/agentic/knowledge/cache.mjs` |
| `CorpusManifest` | `{Object}` | `lib/agentic/knowledge/cache.mjs` |
| `KnowledgeGate` | `{Object}` | `lib/agentic/knowledge/component.mjs` |
| `KnowledgeRowLike` | `{Object}` | `lib/agentic/knowledge/component.mjs` |
| `KnowledgeSourceRef` | `{Object}` | `lib/agentic/knowledge/model.mjs` |
| `KnowledgeNode` | `{Object}` | `lib/agentic/knowledge/model.mjs` |
| `KnowledgeEdge` | `{Object}` | `lib/agentic/knowledge/model.mjs` |
| `KnowledgeSourceRecord` | `{Object}` | `lib/agentic/knowledge/model.mjs` |
| `KnowledgeGraph` | `{Object}` | `lib/agentic/knowledge/model.mjs` |
| `KnowledgePatch` | `{Object}` | `lib/agentic/knowledge/model.mjs` |
| `KnowledgeFinding` | `{Object}` | `lib/agentic/knowledge/model.mjs` |
| `KnowledgeProfile` | `{Object}` | `lib/agentic/knowledge/model.mjs` |
| `DataProfile` | `{Object}` | `lib/agentic/knowledge/profile.mjs` |
| `KindProposal` | `{Object}` | `lib/agentic/knowledge/profile.mjs` |
| `RelationProposal` | `{Object}` | `lib/agentic/knowledge/profile.mjs` |
| `OntologyProposal` | `{Object}` | `lib/agentic/knowledge/profile.mjs` |
| `RankedNode` | `{Object}` | `lib/agentic/knowledge/query.mjs` |
| `ProgressSnapshot` | `{Object}` | `lib/agentic/loops/policy.mjs` |
| `MemoryEngine` | `{Object}` | `lib/agentic/memory/component.mjs` |
| `MemoryManagerLike` | `{Object}` | `lib/agentic/memory/component.mjs` |
| `EngineProvider` | `{Object}` | `lib/agentic/memory/engine.mjs` |
| `DistillOptions` | `{Object}` | `lib/agentic/memory/manager.mjs` |
| `ManagerProvider` | `{Object}` | `lib/agentic/memory/manager.mjs` |
| `MemoryManagerOptions` | `{Object}` | `lib/agentic/memory/manager.mjs` |
| `MemoryFact` | `{Object}` | `lib/agentic/memory/providers.mjs` |
| `MemoryStoreOptions` | `{Object}` | `lib/agentic/memory/providers.mjs` |
| `CompositeProvider` | `{Object}` | `lib/agentic/memory/providers.mjs` |
| `LocalFileMemoryProviderOptions` | `{Object}` | `lib/agentic/memory/providers.mjs` |
| `RerankableFact` | `{Object}` | `lib/agentic/memory/rerank.mjs` |
| `ObjectivePolicyOptions` | `{Object}` | `lib/agentic/objective.mjs` |
| `ObjectivePolicy` | `{Object}` | `lib/agentic/objective.mjs` |
| `ObjectiveOutcome` | `{Object}` | `lib/agentic/objective.mjs` |
| `ObjectivePassInput` | `{Object}` | `lib/agentic/objective.mjs` |
| `MatchedRoute` | `{Object}` | `lib/agentic/operator/http.mjs` |
| `SchedulerProjection` | `{Object}` | `lib/agentic/operator/view.mjs` |
| `PolicyProjection` | `{Object}` | `lib/agentic/operator/view.mjs` |
| `ItemResponse` | `{Object}` | `lib/agentic/operator/view.mjs` |
| `ItemToolBinder` | `{(arg0: {item: unknown, attempt: number\|null, workspace: Record<string, unknown>\|null}) => Array<Record<string, unknown>>}` | `lib/agentic/orchestration/facade.mjs` |
| `ApprovalDecision` | `{boolean\|{approved: boolean, reason?: string}\|Promise<boolean>\|Promise<{approved: boolean, reason?: string}>}` | `lib/agentic/orchestration/facade.mjs` |
| `ApprovalCallback` | `{(target: string, args: Record<string, unknown>\|Array<string>, meta?: Record<string, unknown>) => ApprovalDecision}` | `lib/agentic/orchestration/facade.mjs` |
| `SchedulerConstructionOptions` | `{NonNullable<ConstructorParameters<typeof WorkScheduler>[0]>}` | `lib/agentic/orchestration/facade.mjs` |
| `OrchestrationOptions` | `{Object}` | `lib/agentic/orchestration/facade.mjs` |
| `Orchestration` | `{Object}` | `lib/agentic/orchestration/facade.mjs` |
| `MessageRow` | `{import('../messaging/row-shape.mjs').MessageRow}` | `lib/agentic/pending-inbox.mjs` |
| `ParentInboxSession` | `{{_pendingInputRows?: Array<Object>}}` | `lib/agentic/pending-inbox.mjs` |
| `PermissionMode` | `{'default'\|'acceptEdits'\|'bypassPermissions'}` | `lib/agentic/permissions.mjs` |
| `PermissionRules` | `{Object}` | `lib/agentic/permissions.mjs` |
| `PlanSession` | `{Object}` | `lib/agentic/plan/component.mjs` |
| `ApprovalDecision` | `{{approved: boolean, reason?: string} & Record<string, unknown>}` | `lib/agentic/planning/approval.mjs` |
| `CheckpointEnvelope` | `{Object}` | `lib/agentic/planning/checkpoint.mjs` |
| `EvaluatorOptions` | `{Object}` | `lib/agentic/planning/evaluator.mjs` |
| `RunContext` | `{import('../../core/events.mjs').RunContext}` | `lib/agentic/planning/executor-helpers.mjs` |
| `WorkflowStep` | `{import('./executor.mjs').WorkflowStep}` | `lib/agentic/planning/executor-helpers.mjs` |
| `WorkflowStep` | `{import('./executor.mjs').WorkflowStep}` | `lib/agentic/planning/executor-strategies.mjs` |
| `GroupSession` | `{import('./executor.mjs').GroupSession}` | `lib/agentic/planning/executor-strategies.mjs` |
| `RunContext` | `{import('../../core/events.mjs').RunContext}` | `lib/agentic/planning/executor-strategies.mjs` |
| `ExecutorClient` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `PlanVerdict` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `PlanEvaluator` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `StepVerdict` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `StepEvaluator` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `ExecutorPlanner` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `StepVerifyContract` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `WorkflowExecutorOptions` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `GroupSession` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `SessionGroup` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `WorkflowStep` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `WorkflowOutput` | `{Object}` | `lib/agentic/planning/executor.mjs` |
| `StateSchema` | `{{safeParse: Function}}` | `lib/agentic/planning/graph-utils.mjs` |
| `LeafRecord` | `{Object}` | `lib/agentic/planning/graph-utils.mjs` |
| `PlanPatchNode` | `{Partial<Omit<import('./executor.mjs').WorkflowStep, 'dependencies'>> & {dependencies?: string[]\|null}}` | `lib/agentic/planning/plan-patch.mjs` |
| `PlanPatchOp` | `{Object}` | `lib/agentic/planning/plan-patch.mjs` |
| `PlanPatch` | `{Object}` | `lib/agentic/planning/plan-patch.mjs` |
| `PlanPatchResult` | `{Object}` | `lib/agentic/planning/plan-patch.mjs` |
| `PlanLoss` | `{Object}` | `lib/agentic/planning/plan.mjs` |
| `StateMachineNode` | `{Object}` | `lib/agentic/planning/plan.mjs` |
| `StateMachineEdge` | `{Object}` | `lib/agentic/planning/plan.mjs` |
| `PlanNode` | `{Object}` | `lib/agentic/planning/plan.mjs` |
| `UtilitySession` | `{Object}` | `lib/agentic/planning/planner-utils.mjs` |
| `StructuredClient` | `{Object}` | `lib/agentic/planning/planner-utils.mjs` |
| `PlannerOptions` | `{Object}` | `lib/agentic/planning/planner.mjs` |
| `StepRecord` | `{{id: string, messages?: Array<Object>, [key: string]: unknown}}` | `lib/agentic/planning/task-state.mjs` |
| `TaskStateSnapshot` | `{Object}` | `lib/agentic/planning/task-state.mjs` |
| `TaskStateExecutor` | `{Object}` | `lib/agentic/planning/task-state.mjs` |
| `PooledSession` | `{Object}` | `lib/agentic/pooled-client.mjs` |
| `AttemptParked` | `{Object}` | `lib/agentic/scheduler/attempt-store.mjs` |
| `AttemptInFlight` | `{Object}` | `lib/agentic/scheduler/attempt-store.mjs` |
| `AttemptRecord` | `{Object}` | `lib/agentic/scheduler/attempt-store.mjs` |
| `AttemptStore` | `{Object}` | `lib/agentic/scheduler/attempt-store.mjs` |
| `ClaimStore` | `{Object}` | `lib/agentic/scheduler/claims.mjs` |
| `ClaimRecord` | `{Object}` | `lib/agentic/scheduler/claims.mjs` |
| `WorkItemBlockedByRef` | `{Object}` | `lib/agentic/scheduler/normalize.mjs` |
| `WorkItem` | `{Object}` | `lib/agentic/scheduler/normalize.mjs` |
| `IndexedWorkItem` | `{Object}` | `lib/agentic/scheduler/normalize.mjs` |
| `StateList` | `{ReadonlyArray<string>\|ReadonlySet<string>}` | `lib/agentic/scheduler/normalize.mjs` |
| `RefreshOutcome` | `{'missing'\|'terminal'\|'inactive'\|'live'}` | `lib/agentic/scheduler/reconcile.mjs` |
| `RunStatus` | `{'completed'\|'failed'\|'canceled'}` | `lib/agentic/scheduler/retry.mjs` |
| `NormalizedRunResult` | `{Object}` | `lib/agentic/scheduler/retry.mjs` |
| `WorkItem` | `{import('./normalize.mjs').WorkItem}` | `lib/agentic/scheduler/runner.mjs` |
| `WorkflowStep` | `{import('../planning/executor.mjs').WorkflowStep}` | `lib/agentic/scheduler/runner.mjs` |
| `RunnerTool` | `{import('../../messaging/unified-parameter.mjs').Tool\|string}` | `lib/agentic/scheduler/runner.mjs` |
| `RunnerStatus` | `{'completed'\|'failed'\|'canceled'}` | `lib/agentic/scheduler/runner.mjs` |
| `RunnerResult` | `{Object}` | `lib/agentic/scheduler/runner.mjs` |
| `RunnerStore` | `{Object}` | `lib/agentic/scheduler/runner.mjs` |
| `RunnerCheckpoint` | `{Object}` | `lib/agentic/scheduler/runner.mjs` |
| `RunnerSession` | `{Object}` | `lib/agentic/scheduler/runner.mjs` |
| `RunnerClient` | `{Object}` | `lib/agentic/scheduler/runner.mjs` |
| `NormalizedApproval` | `{Object}` | `lib/agentic/scheduler/runner.mjs` |
| `RunnerPlan` | `{Object}` | `lib/agentic/scheduler/runner.mjs` |
| `PoolUsageSnapshot` | `{Object}` | `lib/agentic/scheduler/runner.mjs` |
| `WorkItem` | `{import('./normalize.mjs').WorkItem}` | `lib/agentic/scheduler/scheduler.mjs` |
| `ClaimStore` | `{import('./claims.mjs').ClaimStore}` | `lib/agentic/scheduler/scheduler.mjs` |
| `AttemptStore` | `{import('./attempt-store.mjs').AttemptStore}` | `lib/agentic/scheduler/scheduler.mjs` |
| `Totals` | `{import('./state.mjs').Totals}` | `lib/agentic/scheduler/scheduler.mjs` |
| `NormalizedRunResult` | `{import('./retry.mjs').NormalizedRunResult}` | `lib/agentic/scheduler/scheduler.mjs` |
| `SchedulerClock` | `{Object}` | `lib/agentic/scheduler/scheduler.mjs` |
| `SchedulerEmitter` | `{Object}` | `lib/agentic/scheduler/scheduler.mjs` |
| `SchedulerWorkSource` | `{Object}` | `lib/agentic/scheduler/scheduler.mjs` |
| `SchedulerWorkflow` | `{Object}` | `lib/agentic/scheduler/scheduler.mjs` |
| `SchedulerWorkspaceManager` | `{Object}` | `lib/agentic/scheduler/scheduler.mjs` |
| `SchedulerConfig` | `{Object}` | `lib/agentic/scheduler/scheduler.mjs` |
| `SchedulerEntry` | `{Object}` | `lib/agentic/scheduler/scheduler.mjs` |
| `Disposition` | `{{type: 'retry', reason: string}\|{type: 'release', reason: string, cleanup: boolean}\|{type: 'park', reason: string}\|{type: 'stop'}}` | `lib/agentic/scheduler/scheduler.mjs` |
| `RetryEntry` | `{Object}` | `lib/agentic/scheduler/scheduler.mjs` |
| `ParkedEntry` | `{Object}` | `lib/agentic/scheduler/scheduler.mjs` |
| `SchedulerOptions` | `{Object}` | `lib/agentic/scheduler/scheduler.mjs` |
| `ClaimState` | `{'unclaimed'\|'claimed'\|'running'\|'retry_queued'\|'parked'\|'released'}` | `lib/agentic/scheduler/state.mjs` |
| `Totals` | `{Object}` | `lib/agentic/scheduler/state.mjs` |
| `WorkItem` | `{import('./normalize.mjs').WorkItem}` | `lib/agentic/scheduler/state.mjs` |
| `RunningEntry` | `{Object}` | `lib/agentic/scheduler/state.mjs` |
| `WorkItem` | `{import('../normalize.mjs').WorkItem}` | `lib/agentic/scheduler/work-sources/function.mjs` |
| `WorkSourceEmitter` | `{import('./records.mjs').WorkSourceEmitter}` | `lib/agentic/scheduler/work-sources/function.mjs` |
| `HostFetch` | `{(arg0: {states?: Array<string>, ids?: Array<string>, signal?: AbortSignal}) => unknown}` | `lib/agentic/scheduler/work-sources/function.mjs` |
| `WorkSourceCategory` | `{import('../../../core/errors.mjs').WorkSourceCategory}` | `lib/agentic/scheduler/work-sources/index.mjs` |
| `WorkItem` | `{import('../normalize.mjs').WorkItem}` | `lib/agentic/scheduler/work-sources/json-file.mjs` |
| `WorkSourceEmitter` | `{import('./records.mjs').WorkSourceEmitter}` | `lib/agentic/scheduler/work-sources/json-file.mjs` |
| `WorkItem` | `{import('../normalize.mjs').WorkItem}` | `lib/agentic/scheduler/work-sources/memory.mjs` |
| `WorkSourceEmitter` | `{import('./records.mjs').WorkSourceEmitter}` | `lib/agentic/scheduler/work-sources/memory.mjs` |
| `WorkItem` | `{import('../normalize.mjs').WorkItem}` | `lib/agentic/scheduler/work-sources/records.mjs` |
| `WorkSourceEmitter` | `{Object}` | `lib/agentic/scheduler/work-sources/records.mjs` |
| `SkipReason` | `{'malformed'\|'id_filename_mismatch'\|'duplicate_id'\|'unsafe_id'}` | `lib/agentic/scheduler/work-sources/records.mjs` |
| `WorkItem` | `{import('../normalize.mjs').WorkItem}` | `lib/agentic/scheduler/work-sources/todos.mjs` |
| `WorkSourceEmitter` | `{import('./records.mjs').WorkSourceEmitter}` | `lib/agentic/scheduler/work-sources/todos.mjs` |
| `RawTodoRecord` | `{Object}` | `lib/agentic/scheduler/work-sources/todos.mjs` |
| `SessionPolicy` | `{Object}` | `lib/agentic/session-policy.mjs` |
| `SessionPolicySource` | `{Object}` | `lib/agentic/session-policy.mjs` |
| `SessionClientLike` | `{Object}` | `lib/agentic/session-policy.mjs` |
| `SessionCheckpoint` | `{Object}` | `lib/agentic/sessions.mjs` |
| `SessionStore` | `{Object}` | `lib/agentic/sessions.mjs` |
| `SpawnContinuation` | `{(arg0: {record: SpawnRecord, prompt: string, signal?: AbortSignal\|null}) => Promise<Object>}` | `lib/agentic/spawn-registry.mjs` |
| `SpawnTree` | `{Object}` | `lib/agentic/spawn-registry.mjs` |
| `SpawnSession` | `{Object}` | `lib/agentic/spawn-registry.mjs` |
| `SpawnDelegation` | `{Object}` | `lib/agentic/spawn-registry.mjs` |
| `SpawnRegistry` | `{Object}` | `lib/agentic/spawn-registry.mjs` |
| `SpawnUsage` | `{Object}` | `lib/agentic/spawn-registry.mjs` |
| `SpawnRecord` | `{Object}` | `lib/agentic/spawn-registry.mjs` |
| `SpawnHandle` | `{Object}` | `lib/agentic/spawn-registry.mjs` |
| `SMNode` | `{Object}` | `lib/agentic/state-machine/machine.mjs` |
| `SMEdge` | `{Object}` | `lib/agentic/state-machine/machine.mjs` |
| `SMGraph` | `{Object}` | `lib/agentic/state-machine/machine.mjs` |
| `Step` | `{Object}` | `lib/agentic/step.mjs` |
| `RunStepCapabilities` | `{Object}` | `lib/agentic/step.mjs` |
| `RunStepEvents` | `{Object}` | `lib/agentic/step.mjs` |
| `RunStepUsage` | `{Object}` | `lib/agentic/step.mjs` |
| `StepDeps` | `{Object}` | `lib/agentic/step.mjs` |
| `TaskEventEmitter` | `{Object}` | `lib/agentic/task.mjs` |
| `TaskRunOptions` | `{Object}` | `lib/agentic/task.mjs` |
| `TaskSessionStore` | `{Object}` | `lib/agentic/task.mjs` |
| `TaskAgent` | `{Object}` | `lib/agentic/task.mjs` |
| `DelegationMode` | `{'fixed'\|'any'}` | `lib/agentic/task.mjs` |
| `AgentRosterMode` | `{'roster'\|'any'}` | `lib/agentic/task.mjs` |
| `DelegationEnvelope` | `{Object}` | `lib/agentic/task.mjs` |
| `TaskArgs` | `{Object}` | `lib/agentic/task.mjs` |
| `TaskChildSession` | `{Object}` | `lib/agentic/task.mjs` |
| `TaskClient` | `{Object}` | `lib/agentic/task.mjs` |
| `TaskSession` | `{Object}` | `lib/agentic/task.mjs` |
| `TodoTask` | `{Object}` | `lib/agentic/todos/component.mjs` |
| `TransferUnit` | `{Object}` | `lib/agentic/transfer.mjs` |
| `TransferOptions` | `{Object}` | `lib/agentic/transfer.mjs` |
| `TransferPolicy` | `{Object}` | `lib/agentic/transfer.mjs` |
| `WebInjectOptions` | `{Object}` | `lib/agentic/web-shared.mjs` |
| `HostResolver` | `{(host: string, options: {all: true, verbatim: true}) => Promise<Array<{address: string, family?: number}\|string>>}` | `lib/agentic/web-shared.mjs` |
| `ResolvedHost` | `{{ok: true, host: string, address: string\|null, family: number} \| {ok: false, host: string\|null, reason: string}}` | `lib/agentic/web-shared.mjs` |
| `WebScrapeConfig` | `{Object}` | `lib/agentic/webscrape/component.mjs` |
| `UnifiedScrapeResult` | `{Object}` | `lib/agentic/webscrape/engines.mjs` |
| `ScrapeEngineOptions` | `{Object}` | `lib/agentic/webscrape/engines.mjs` |
| `WebSearchConfig` | `{Object}` | `lib/agentic/websearch/component.mjs` |
| `UnifiedSearchResult` | `{Object}` | `lib/agentic/websearch/engines.mjs` |
| `SearchEngineOptions` | `{Object}` | `lib/agentic/websearch/engines.mjs` |
| `ResolvedTracker` | `{Object}` | `lib/agentic/workflow-policy/config.mjs` |
| `ResolvedPolling` | `{{intervalMs: number}}` | `lib/agentic/workflow-policy/config.mjs` |
| `ResolvedWorkspace` | `{Object}` | `lib/agentic/workflow-policy/config.mjs` |
| `ResolvedHooks` | `{Object}` | `lib/agentic/workflow-policy/config.mjs` |
| `ResolvedAgent` | `{Object}` | `lib/agentic/workflow-policy/config.mjs` |
| `ResolvedScheduler` | `{Object}` | `lib/agentic/workflow-policy/config.mjs` |
| `ResolvedEngine` | `{Object}` | `lib/agentic/workflow-policy/config.mjs` |
| `ResolvedWorkflowConfig` | `{Object}` | `lib/agentic/workflow-policy/config.mjs` |
| `PolicyLike` | `{Object}` | `lib/agentic/workflow-policy/integrate.mjs` |
| `SchedulerOptions` | `{Object}` | `lib/agentic/workflow-policy/integrate.mjs` |
| `WorkspaceOptions` | `{Object}` | `lib/agentic/workflow-policy/integrate.mjs` |
| `WorkflowFileStat` | `{{ino: number, mtimeMs: number, size: number}}` | `lib/agentic/workflow-policy/policy.mjs` |
| `EffectivePolicy` | `{Object}` | `lib/agentic/workflow-policy/policy.mjs` |
| `PolicyFailure` | `{{reasons: string[], at: number}}` | `lib/agentic/workflow-policy/policy.mjs` |
| `ReloadResult` | `{{changed: boolean, healthy: boolean, reasons: string[]}}` | `lib/agentic/workflow-policy/policy.mjs` |
| `WatchState` | `{'active'\|'disabled'\|'failed'\|'stopped'}` | `lib/agentic/workflow-policy/policy.mjs` |
| `WorkflowPolicyOptions` | `{Object}` | `lib/agentic/workflow-policy/policy.mjs` |
| `TextNode` | `{{type: 'text', value: string, offset: number}}` | `lib/agentic/workflow-policy/template.mjs` |
| `OutputNode` | `{{type: 'output', path: string, segments: string[], offset: number}}` | `lib/agentic/workflow-policy/template.mjs` |
| `TemplateBranch` | `{{path: string, segments: string[], body: TemplateNode[]}}` | `lib/agentic/workflow-policy/template.mjs` |
| `IfNode` | `{{type: 'if', branches: TemplateBranch[], alternate: TemplateNode[]\|null, offset: number}}` | `lib/agentic/workflow-policy/template.mjs` |
| `RawNode` | `{{type: 'raw', value: string, offset: number}}` | `lib/agentic/workflow-policy/template.mjs` |
| `TemplateNode` | `{TextNode\|OutputNode\|IfNode\|RawNode}` | `lib/agentic/workflow-policy/template.mjs` |
| `TemplateAst` | `{{type: 'root', nodes: TemplateNode[]}}` | `lib/agentic/workflow-policy/template.mjs` |
| `TemplateState` | `{{template: string, index: number, nextOutputAt?: number\|null, nextTagAt?: number\|null}}` | `lib/agentic/workflow-policy/template.mjs` |
| `TemplateExpression` | `{{path: string, segments: string[]}}` | `lib/agentic/workflow-policy/template.mjs` |
| `TemplateToken` | `{{kind: 'output', path: string, segments: string[], leftTrim: boolean, offset: number} \| {kind: 'if', path: string, segments: string[], leftTrim: boolean, offset: number} \| {kind: 'elsif', path: string, segments: string[], leftTrim: boolean, offset: number} \| {kind: 'else', leftTrim: boolean, offset: number} \| {kind: 'endif', leftTrim: boolean, offset: number} \| {kind: 'raw', leftTrim: boolean, offset: number} \| {kind: 'endraw', leftTrim: boolean, offset: number}}` | `lib/agentic/workflow-policy/template.mjs` |
| `TemplateTerminator` | `{{kind: 'elsif', path: string, segments: string[], leftTrim: boolean, offset: number} \| {kind: 'else', leftTrim: boolean, offset: number} \| {kind: 'endif', leftTrim: boolean, offset: number} \| {kind: 'endraw', leftTrim: boolean, offset: number}}` | `lib/agentic/workflow-policy/template.mjs` |
| `ParsedBlock` | `{{nodes: TemplateNode[], terminator: TemplateTerminator\|null}}` | `lib/agentic/workflow-policy/template.mjs` |
| `RenderContext` | `{{chars: number, maxRenderedChars: number, parts: string[]}}` | `lib/agentic/workflow-policy/template.mjs` |
| `WorkflowWatchHandle` | `{Object}` | `lib/agentic/workflow-policy/watch.mjs` |
| `WorkflowWatchFactory` | `{(directory: string) => WorkflowWatchHandle}` | `lib/agentic/workflow-policy/watch.mjs` |
| `WorkflowWatchEvent` | `{{type: 'change'}\|{type: 'error', reason: string}}` | `lib/agentic/workflow-policy/watch.mjs` |
| `WorkspaceEmitter` | `{Object}` | `lib/agentic/workspace/hooks.mjs` |
| `WorkspaceHookTarget` | `{Object}` | `lib/agentic/workspace/hooks.mjs` |
| `NormalizedHooks` | `{Object}` | `lib/agentic/workspace/hooks.mjs` |
| `OwnerMarker` | `{Object}` | `lib/agentic/workspace/manager.mjs` |
| `WorkspaceHandle` | `{Object}` | `lib/agentic/workspace/manager.mjs` |
| `WorkspaceHandleLike` | `{Object}` | `lib/agentic/workspace/manager.mjs` |

### `root`

| Type | Definition | Defined in |
| --- | --- | --- |
| `RoleClient` | `{{role: string, client: unknown, provider: string, model: string, session?: Function, embed?: Function, ask?: Function}}` | `lib/index.mjs` |
| `AgenticRuntime` | `{{roles: Record<string, RoleClient>, decision: RoleClient\|null, gate: import('./agentic/decision-gate.mjs').DecisionGate, gates: Record<string, import('./agentic/decision-gate.mjs').DecisionGate>, gateFor: (arg0: {seam?: string}) => import('./agentic/decision-gate.mjs').DecisionGate, sessionOptions: {decisionGate: import('./agentic/decision-gate.mjs').DecisionGate}, dag: {evaluatorOptions: {decisionGate: import('./agentic/decision-gate.mjs').DecisionGate}, executorOptions: {decisionGate: import('./agentic/decision-gate.mjs').DecisionGate}}, sm: {options: {decisionGate: import('./agentic/decision-gate.mjs').DecisionGate}}, discussion: {options: {decisionGate: import('./agentic/decision-gate.mjs').DecisionGate}}, guardrails: {decisionTest: Function}, memory: {reranker: Function\|null}, evals: {scorer: Function}}}` | `lib/index.mjs` |
| `MerciClientInstance` | `{import('./backends/jai.mjs').MerciClient\|import('./backends/oai.mjs').MerciClient\|import('./backends/gai.mjs').MerciClient\|import('./backends/aai.mjs').MerciClient}` | `lib/index.mjs` |

## 7. Cross-area imports

Counts of relative import/re-export specifiers between top-level areas. This is an import graph, **not** a strict layering — cycles exist (e.g. `agentic ↔ tools`).

| From → To | Imports |
| --- | --- |
| `agentic → core` | 237 |
| `agentic → support` | 94 |
| `backends → core` | 53 |
| `root → agentic` | 51 |
| `tools → core` | 42 |
| `backends → support` | 40 |
| `agentic → messaging` | 29 |
| `support → core` | 27 |
| `tools → support` | 21 |
| `backends → messaging` | 12 |
| `root → core` | 10 |
| `root → support` | 9 |
| `agentic → tools` | 7 |
| `tools → agentic` | 7 |
| `backends → tools` | 6 |
| `backends → agentic` | 5 |
| `messaging → core` | 5 |
| `messaging → support` | 5 |
| `root → messaging` | 3 |
| `root → tools` | 3 |
| `root → backends` | 2 |
| `agentic → backends` | 1 |

## 8. Regeneration

```bash
pnpm build:structure
```
