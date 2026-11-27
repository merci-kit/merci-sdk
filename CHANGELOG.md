# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.25.0] - 2026-11-27

### Added

- **Data-driven nested wikis.** `hierarchyOf()`, `hierarchyPath()`,
  `levelKindsFor()`, and `HIERARCHY_RELATIONS` derive navigation from existing
  `contains`/`part_of` edges. `buildGraph()` and `wikiSurface()` accept optional
  level descriptions; nested directory corpora produce book/chapter/article (or
  arbitrary-depth) navigation without persisting parent/depth fields.
- **Wiki navigation.** `renderNodePage()` renders breadcrumbs, parent and child
  links; wiki indexes carry hierarchy paths; Mermaid includes every hierarchy
  participant. `KnowledgeComponent.load({ id, page: true })` returns the same
  navigation view within its budget.
- **Focused `merci-sdk/acp` entry point.** `createAcpAgent`,
  `permissionAllowed`, `ACP_STOP_REASONS`, and `ACP_AGENT_VERSION` now load from
  their own subpath instead of the root façade.
- **Public fallback classifier.** `fallbackKind()`, `isSdkFallbackOutput()`,
  `isTransientFallbackKind()`, and `FALLBACK_MESSAGE` are exported from the main
  entry, so a consumer can tell an SDK sentinel from model text without matching
  the English sentence or deep-importing `lib/agentic/agentic-core.mjs`.
- **Run outcome on `getLastRun()`.** It now returns `finishReason`, `truncated`,
  `truncatedBy`, `contentFiltered`, and `fallbackKind` beside the text, rows,
  usage, citations, and sources. `run()` keeps its string return.
- **`createToolCallMessages({ provider, calls })`.** One model turn's tool calls
  in every wire shape: one assistant row for OAI/AAI, one model turn for
  GAI/Vertex, and one row per call for JAI. Returns an array, so a caller
  spreads it without branching on the provider.

### Fixed

- **Heading depth is preserved.** Level-3+ headings now use `subsection` by
  default instead of falling back to `document`; explicit level descriptions can
  name any declared structural kinds.
- **Wiki path collisions and links.** Nested pages use relative-path ids;
  duplicate basenames no longer collide, ambiguous wikilinks stay unresolved,
  and page navigation links resolve beside the page rather than `nodes/nodes/`.
- **Hierarchy validation is non-destructive.** Cycles and multiple parents are
  warnings; read-time projection terminates and remains navigable.
- **`getLastRun()` no longer returns a stale deliverable after failure.** Each
  attempt clears prior text/rows/usage/metadata, and a thrown attempt reports
  `finishReason: 'error'` with only that attempt's data.
- **`createToolCallMessage({ calls })` is provider-neutral.** A parallel tool
  round on the OAI/Anthropic row shapes now keeps every call's id, name, and
  arguments instead of producing one anonymous `arguments: "{}"` call.
- **The JAI vendor session accepts the `withParameters` function form**, so
  every concrete session offers one parameter contract.

### Changed

- **Leaner root import.** MCP, A2A, shell, skills, and tool-execution exports now
  live only on `merci-sdk/tools`; ACP lives on `merci-sdk/acp`. The root no longer
  loads those optional protocol stacks for consumers that do not use them.
- **Lazy MCP SDK loading.** MCP client/server modules import
  `@modelcontextprotocol/*` only when a transport or server is created.
- **Unused import cleanup.** Removed 13 runtime-unused import bindings without
  changing behavior.
- **Decision usage reader deduplicated.** OpenAI and keyed decision adapters now
  share the existing `decisions-common.mjs` helper instead of carrying identical
  copies.
- **Dead code removed.** Deleted four unused private executor wrappers, the
  unreferenced `briefWithObjective`, two dead constants, and the orphan
  `webscrape/index.mjs` barrel plus its self-referential test.
- **Existing helpers reused.** Knowledge vector scoring uses
  `cosineSimilarity`; agent-spec validation uses `isRecordObject`; scheduler
  ownership checks use `Object.hasOwn`.
- **Token estimation hot path.** `estimateMessageTokens()` resolves the live
  character-per-token limit once per call rather than once per row. A local
  500-row × 1,000-iteration benchmark improved from 334.5 ms to 10.6 ms with
  identical output; live limit changes between calls still apply.
- `DEFAULT_SYSTEM_PROMPT` no longer names a version, so it cannot go stale.

### Compatibility

- One-dimensional corpora remain flat. Nested output is inferred only when the
  data contains hierarchy, or when `nested: true`/a level description is supplied.
- `KNOWLEDGE_BUILD_VERSION` is now 2, so existing corpus caches rebuild once.
- Tool/MCP/A2A imports move from `merci-sdk` to `merci-sdk/tools`; ACP imports move
  to `merci-sdk/acp`. The APIs remain available on those focused entry points.

## [0.24.0] - 2026-11-26

### Added

- **Precision retrieval without replacing the graph engine.** `tokensOf()` now
  accepts opt-in Unicode diacritic folding and n-grams, and `bm25Scores()` adds
  deterministic BM25 scoring. `seedNodes()` and `retrieveSubgraph()` accept a
  caller-supplied `scorer`; scores are normalised before fusion with explicit-ID,
  lexical, or vector similarity.
- **Caller-controlled graph traversal.** `expandSubgraph()`, `queryGraph()`, and
  `retrieveSubgraph()` accept `edgeFilter` and `direction` (`both`, `outgoing`,
  `incoming`). `rankNodes()` and `retrieveSubgraph()` accept `hubDamping: false`
  when the caller's ranking is already calibrated. `queryGraph()` defaults to
  `knowledge_query_max_nodes` and accepts an explicit `maxNodes` override.
- **Read-only curated knowledge.** `withKnowledge()` and `KnowledgeComponent`
  accept `access: 'read-only'` and `persist: false`. A supplied or loaded graph is
  validated, cloned, and deep-frozen; direct `save()`, `ingest()`, and `adopt()`
  calls are refused, not merely hidden from the model. `view: 'wiki'` remains a compatible
  read-only alias.
- **Opt-in strict source validation.** `validateGraph()` accepts
  `sourcePolicy: 'none' | 'warn' | 'error'`. Strict mode checks source-registry
  membership, span bounds, required source text when a source map is supplied,
  evidence source IDs, and salience/confidence/tier/origin vocabularies.
- **Custom corpus builders.** `syncCorpus()` accepts `build` and `buildVersion`,
  so structured corpora can keep the SDK's manifest, cache, delta, and re-anchor
  behavior without using the generic Markdown builder. A custom builder must
  supply an explicit `buildVersion`; source nodes may omit `key` and are aligned
  by the SDK's deterministic content key.

### Changed

- `view: 'wiki'` now refuses direct component mutation as well as omitting
  `knowledge_patch`. Mutable ASG remains the default for existing consumers.
- `queryGraph()` defaults to the same node cap as the other knowledge query
  paths. Existing small-neighbourhood calls are unchanged.
- A custom relation already declared in `profileDefinition.relations` no longer
  emits the “promote this relation” warning; it still requires a note.

### Compatibility

- Existing tokenization, lexical scoring, seed fusion, traversal direction,
  hub damping, validation, and persistence defaults are unchanged.
- New lexical behavior is opt-in. A custom scorer must return a `Map` of node ID
  to finite numeric scores; positive values are ranked and normalised so the
  maximum is `1`, while zero and negative values are ignored. With a custom
  scorer, its positive hits win score ties against other channels before the
  seed cap is applied.

## [0.23.2] - 2026-11-23

### Fixed

- **The README quickstart is model-agnostic and verified end to end.** It now
  imports `getDefaultModel`, resolves the model from the selected provider, and
  passes it to `client.session()`, so the block no longer pins the obsolete
  `gpt-4o` id. Switching `PROVIDER` alone changes the backend. The exact
  snippet was executed against the published package and streamed a real
  answer before this release.
- **A docs gate stops the literal from returning.** `check-docs` rule D9 reads
  the quickstart block in `README.md` and fails when it does not call
  `getDefaultModel()`, or when it passes a quoted model to `client.session()`.
- **The discussion example follows the same rule.** `docs/PROVIDERS.md` builds
  both agents from the provider default instead of a pinned model id.

## [0.23.1] - 2026-11-23

### Added

- **Commercial services and a separate Rust license are documented.** Support,
  development and professional services are offered as paid engagements, and a
  Rust implementation of the SDK is available under a separate commercial
  license. The TypeScript/JavaScript SDK remains Apache-2.0.

### Changed

- **The public repository ships the library, the examples and the docs.** The
  test suite and internal tooling stay in the private workspace; the npm
  tarball surface is unchanged.

### Fixed

- **A JAI `PrematureEnd` is no longer reported as content moderation.** The V9
  gateway sends `PrematureEnd` with a reason: only `content_filter` is
  moderation, while `Unknown` is any other early stop (the shipped JetBrains
  client models exactly those two reasons). The step now carries
  `truncatedBy: 'premature_end'` for a premature end and `'length'` for a real
  token-limit cut, so an unclassified early stop gets the provider-truncation
  note instead of the moderation notice or the token-limit note.
- **A JAI premature end no longer burns two retries on a result that cannot
  change.** A `content_filter` stop is not retried, and a second attempt cut at
  exactly the same offset as the first is treated as deterministic and not
  retried a third time (`STREAM_PREMATURE_NO_RETRY`). Empty cuts still use the
  full `MAX_PREMATURE_ATTEMPTS` budget.
- **A content-filtered fragment is removed from the transcript and the
  deliverable.** When the provider says `content_filter`, every assistant-text
  row the step appended is stripped from the transcript (so the next turn and
  any checkpoint never re-send it), and the run returns the prior good answer
  or the moderation fallback (JetBrains AI Platform doc 031). Text deltas
  already streamed to `onEvent` cannot be un-sent; the `content_filtered` event
  marks them for a live consumer.
- **`run:end` reports `finishReason: 'premature_end'`** for a provider-closed
  stream instead of folding it into `'length'`.
- **JAI request headers now match the shipped gateway contract.** Debug info is
  requested with `Grazie-Provide-Debug-Info` (was `X-Provide-Debug-Info`), and
  impersonation uses `Grazie-Original-User-JWT`, `Grazie-Original-Service-JWT`,
  `Grazie-Original-Application-JWT` and `Grazie-Application-User-ID` (were the
  `-Token`/`-User` spellings). Both old and new names stay redacted in
  telemetry.
- **A JAI stream that ends without `FinishMetadata` is a truncation.** The
  vendor stream synthesizes `PrematureEnd(reason: missing_finish)` when content
  arrived and the terminal event never did, instead of reporting a partial
  answer as complete.
- **Premature-end diagnostics survive.** The parser now carries the gateway's
  `message` and `event_type`, and the retry warning and final event carry
  `Grazie-Trace-Id`, so an incident can be handed to JetBrains support with the
  id that matches its logs.
- **`getProfiles()` publishes the profile's limits.** The JAI roster now returns
  `contextLimit` and `maxOutputTokens` alongside `id`/`name` (both `null` when
  the gateway omits them).

## [0.23.0] - 2026-11-21

### Added

- **Agent definition files (`merci-sdk/agents`).** A non-coder can define an
  agent in `agents/<name>.agent.yaml` (`apiVersion: merci.dev/v1alpha1`,
  `kind: Agent`) and load it with `loadAgentFile` / `loadAgentDirectory`. The
  loader is strict: an unknown key is a hard error with its line and column, the
  document is built field by field (never merged), every failure is collected in
  one `AgentFileError` (`MERCI-AGENT-FILE-ERR`), symlinks are refused, and the
  file is capped before it is parsed. A loaded spec is deep-frozen and carries
  the YAML hash plus each script's hash.
- **One tool model: groups for beginners, selectors for power users.**
  `spec.tools.use` names catalog groups (`files`, `shell`, `artifacts`, `todos`,
  `memory`, `knowledge`, `skills`, `search`, `scrape`, `browser`, `delegate`,
  `state_machine`; `web` is an alias). `allow`/`deny` take selectors
  (`native:`, `host:`, `skill:`, `script:`, `mcp:`, `acp:`, `a2a:`), and `deny`
  always wins. MCP/ACP/A2A tools are renamed at the boundary
  (`mcp__github__issues_list`) so a remote catalog cannot shadow a native tool.
  `resolveToolset` is the one resolver both consumers use, so a file cannot grant
  different tools depending on how it is run.
- **Script-backed tools.** A definition names a contained `.sh`/`.mjs`/`.cjs`/
  `.js`/`.py` file with JSON-Schema parameters. The interpreter comes from the
  extension (no `sh` fallback), the child environment is an explicit allowlist,
  output and runtime are capped, the tool is `runsCode: true` and never
  idempotent, and approval defaults on (`requiresApproval: false`,
  `bypassPermissions`, bare `*` and `mcp:*` require the host's `allowDangerous`).
- **`withAdditionalTools`** on the chat-session builder appends tools after
  `withTools` set the list, replacing a same-name tool instead of dropping the
  host's belt. `applyAgentSpec` and `toTaskAgent` are the two consumers: a
  runnable session and a delegated profile.
- **The session inbox is a host API (`getPendingInputs`, `cancelInput`,
  `setInputDelivery`).** A message a user submits while a turn is running is
  already delivered as OpenCode does it — `enqueueInput({ input, delivery })`
  with `steer` (the default, claimed at the running turn's next step boundary) or
  `queue` (claimed at the TURN boundary, so it never interrupts a running step
  but still gets its own turn inside the same `run()` before it returns — a
  one-shot caller never has to run again). The three new methods are the same
  operations OpenCode's `session.inbox.list|cancel|update` expose, so a host can
  render the pending queue beside the composer, withdraw a message before it is
  claimed, and toggle steer/queue while it waits. A cancelled message returns the
  removed row; a delivered one returns `null`. Enqueueing the same row twice is
  now one message, so a retried request cannot duplicate it, and an unknown
  `delivery` is a `ConfigurationError` instead of a silently inert row. A row
  with no `delivery` (a background delegation result) keeps the SP3 rule and
  still waits for the next run.
- **The same inbox rule covers a streamed run and the return path.**
  `run({ initialInput: asyncIterable })` now drains the inbox into the next
  chunk's turn and answers a message sent after the last chunk before resolving;
  a message that lands during an output guardrail or the checkpoint write is
  claimed by the run instead of settling the promise with it pending. A row that
  was already on the inbox before `run()` is claimed **before** the turn, so it
  is no longer delivered twice (once by `run()`, once by the loop's first step
  boundary).
- **`maxInboxTurns` (`MERCI_LIMIT_MAX_INBOX_TURNS`, default 8)** bounds the
  inbox-driven turns one run may add. The rows over the cap stay pending and
  visible, and a `client:warning` (`INBOX_TURNS_EXHAUSTED`) names how many wait,
  so a host that enqueues on every token cannot keep a single `run()` alive.
  OpenCode has no such cap (its step ceiling is per turn and resets on every
  promoted item); this one is deliberate hardening for hosts that expose the
  inbox to untrusted clients.
- **`pnpm run check:agents`** fails when a `CAPABILITY` id, a `*_TOOL_NAME`
  constant or a workspace include group is missing from the agent catalog, so
  the format cannot silently fall behind the SDK.
- **`examples/07_agent_loop.mjs` demonstrates in-flight input live.** Sections G
  and H submit messages from a running turn: the steer joins it, the queued
  message is answered by a later turn of that same `run()`, the withdrawn row is
  never sent, the pending queue drains, and on a streamed input a message sent
  between chunks rides the next chunk while one sent after the last chunk still
  gets its turn.
- **The inbox is a queue of record: `drainInbox()`, `isRunning()`, four events,
  and `withInboxStore()`.** A host no longer has to invent a prompt to run what
  the user queued: `drainInbox()` claims the waiting rows and answers them, one
  queued message per turn (all steers ride), returning
  `{ answers: [{ inboxId, text }], text }` or `null` when empty. `isRunning()`
  lets a send handler choose between `run()` and `enqueueInput()` instead of
  catching `CONCURRENT_RUN`. `session:input_enqueued`, `session:input_delivered`,
  `session:input_cancelled` and `session:input_delivery_changed` carry the row's
  `merciId` so a queue panel is live without polling. `withInboxStore({ store,
  threadId })` makes the queue durable across a restart with
  `LocalFileInboxStore` (one atomic JSON file per thread, corrupt files
  quarantined) or `InMemoryInboxStore`; delivery stays at-least-once. The turn
  rule is now OpenCode's `promote`: each queued message gets its own turn instead
  of being batched, so three messages sent during one turn produce three answers.
  `examples/07_agent_loop.mjs` section I runs the live end-to-end: two queued
  messages answered with per-message ids, then a message queued before a reopen
  replayed by the next session and the durable queue emptied.
- **One drainer per thread (lease) and a subagent idle gate.** `drainInbox()`
  leases the thread through the scheduler's claim store, so two workers over one
  durable inbox cannot answer the same message: the key is an O_EXCL file under
  `<dir>/leases/`, a stopped drainer's lease is reclaimed through the documented
  dead-pid/stale path, a running drain renews it
  (`MERCI_LIMIT_INBOX_LEASE_RENEW_MS` inside `…_LEASE_STALE_MS`) and a loser
  returns `{ skipped: 'lease' }`. A lease lost mid-drain is reported
  (`INBOX_LEASE_LOST`) and the turn finishes — at-least-once, never a silent
  duplicate. And a queued message no longer runs into a working spawn tree: the
  drain reads the spawn registry before every turn, waits for background
  subagents this session started (`hasLiveBackgroundWork()`,
  `waitForBackgroundWork()`, bounded by `MERCI_LIMIT_INBOX_BACKGROUND_WAIT_MS`)
  and returns `{ skipped: 'background' }` with the queue intact, mirroring
  OpenChamber's `hasWorkingDescendants` rule. Four knobs join the registry:
  `inbox_lease_stale_ms`, `inbox_lease_renew_ms`,
  `inbox_background_recheck_ms`, `inbox_background_wait_ms`.
- **`examples/48_agent_files.mjs` runs the format live.** It writes the
  definition on screen, loads it, and then a real model reads a note, runs the
  declared script tool against the file, consults a host tool and answers; the
  same spec registers as a subagent and a parent session delegates to it.

### Fixed

- **Security sandbox and shell.** A state-machine string condition can no longer
  reach host code through the sandbox (the sandbox value's `then` was invoked
  with a host function), and a host condition function that returns a thenable
  is now refused with a `ConfigurationError` naming `condition` instead of
  reading as true. A string condition also runs in a child process with its own
  `--max-old-space-size` (`condition_memory_mb`, 128 MB default), so a
  model-authored allocation aborts that child, not the host; the child is started
  lazily and reused (one start, then ~1 ms per condition) and is replaced when a
  condition leaves its heap above half the cap. The child inherits the host's own
  `--permission`/`--allow-*` flags (on both the reused and the one-shot paths), so
  it cannot exceed the host's permission scope. A host that denies child
  processes now gets a typed refusal instead of silently losing the memory bound;
  `MERCI_LIMIT_CONDITION_UNISOLATED_VM=1` opts into in-process evaluation with a
  one-time warning. Windows and `MERCI_CONDITION_ONESHOT=1` take the portable
  one-shot child path. Host-function conditions stay in-process and are
  unaffected. Safe-tier expansion covers directory operands (`diff -N dir`
  and the search family), wrapper commands are unwrapped before the blocklist
  check, service-worker and WebSocket constructs are blocked, and an oversized
  command result is truncated instead of killing the command.
- **Money and token budgets.** The USD cap is decremented by what a turn
  actually spent, and every delegated child is checked against its ancestor
  pools, so a child budget cannot exceed the tree cap. A discussion group holds
  one ledger for the group, failed attempts are charged, the projection includes
  system and tool tokens, and a backend that reports no cost emits
  `BUDGET_UNREPORTED` (`cost_unreported_calls`) instead of spending zero
  silently.
- **Durability and the journal.** A tool call's intent row is written before
  `execute()`, so a crash fails closed instead of re-running the side effect, and
  a completed side effect whose post-execute hook throws is recorded done, not
  failed. `save()` uses strict serialization and throws rather than truncating a
  checkpoint above `safe_stringify_max_nodes`; an unreadable checkpoint is an
  error, not a silent restart; a crashed attempt consumes one retry; scheduler
  claims are heartbeated and recovered; a reload heals only when the content
  matches.
- **Transport and streaming.** Model, token and JAI calls no longer follow
  redirects; the Vertex token exchange is bounded and abortable; caller options
  reach the client constructors; all three adapters share one stream-completion
  contract, including error frames and a non-stream 2xx that is not an event
  stream. SSE line caps count UTF-8 bytes on both scanners, a parallel Gemini
  tool round is one turn, and a project `secret.env` is never rewritten with a
  refreshed token.
- **Tenancy and telemetry.** `createA2AHttpHandler({ authorize })` derives a
  caller key per JSON-RPC request and scopes tasks to it, MCP sessions are
  bounded, and one redactor covers telemetry attributes, debug logs and error
  text.
- **Planning and scheduler.** One session group runs per wave; a rejected step
  never feeds a dependent (a replan or a plan-evaluator patch may declare
  `replaces: '<id>'` and the executor rewires the dependents onto the replacement
  in the same patch); a
  verify gate lost by a checkpoint fails closed; the
  scheduler reads the state machine's phase and names an implicit terminal. A
  multi-agent discussion aggregates the group's answer instead of shipping the
  last speaker's entry, consensus is judged per round, a shared replan budget is
  reserved rather than counted after the fact, an SDK fallback sentinel is not
  accepted as an answer, the output guardrail runs before memory distillation,
  and a non-boolean verdict is refused.
- **Limits and the kill switch.** All limits resolve at call time through one
  registry, so an override reaches every caller (knowledge promotion, the shell
  safe-option table and the MCP-server fallback included).
  `MERCI_LIMITS=limits_off` lifts only bounds whose "unbounded" value relaxes
  rather than breaks: concurrency, depth, fan-out and redirect caps, poll and
  backoff cadence, jitter and zero sentinels hold their default, while retention
  windows and external timeouts still lift to the documented ceiling. A guard
  keeps its configured value or the default, and a plain override cannot raise
  it.
- **`WorkflowExecutor.resolveApproval` requires `approved: boolean`.** A missing
  field used to default to `true`, so a malformed call approved the gate. A
  non-boolean now throws a `ConfigurationError` before any gate is touched.
- **A scheduler attempt that ends on an implicit terminal is `failed`.** The
  state machine still finishes a dead end as `done` with its warning for direct
  callers, but a scheduled item no longer ships an unmet goal as `completed`.
- **A shared-pool turn waits for capacity instead of answering short.** A turn
  that overlaps a sibling waits for the sibling's reservation to free a usable
  share (`budget_admission_wait_ms`, now `0` = until capacity or abort; a positive
  value is an optional cap) and fails with `BudgetExceededError` before the call
  when the pool is genuinely spent, instead of running on a 16-token allowance.
  Reservations record their run, so a delegated child never waits on its own
  ancestor's in-flight step (which is blocked on it) and is no longer clamped by
  it either; that child may then land a second step past the cap, which the
  ancestor's post-charge check reports loudly instead of deadlocking or
  shortening the answer. A turn that was never contended keeps the whole remainder and, at or
  below `step_min_output_tokens`, emits `run:budget_starved` so a one-token answer
  cannot pass for a real one.
- **Unreadable checkpoints fail typed.** A store file that cannot be read now
  emits `session:store_corrupt` and throws a `ConfigurationError` naming the
  thread and fs code instead of a raw error; corrupt JSON still quarantines.
- **Truncated error bodies are retryable only when the status is.** A cut 4xx
  body stays non-retryable; 408/409/429 and 5xx keep their retry/`retry-after`
  path. A Gemini 2xx JSON `{error}` body now raises a typed API error with the
  vendor status and message instead of a JSON parse failure.
- **SSRF ranges are classified with `net.BlockList`.** IPv4-compatible, mapped
  and SIIT IPv6 forms are reduced to their embedded IPv4 and checked against the
  reserved ranges (site-local, `192.0.0.0/24`, Teredo, NAT64, 6to4), while a
  public embedded address still passes.
- **Telemetry no longer exports user text.** Artifact filenames and other
  user-controlled `name` values are not span attributes; tool names pass a
  conservative technical pattern. A malformed tool error can mark itself
  retryable (`markToolErrorRetryable`) when it knows the effect never started.
- **A partial host `scheduler.limits` override merges with the file.**
  `scheduler: { limits: { maxTotalUsd: 1 } }` used to replace the file's whole
  limits object at construction and reload, so the other values vanished (and
  `applyConfig` refused the patch). `limits`, `concurrency`, `retry` and
  `continuation` now merge key by key.

### Changed

- **Internal deduplication pass, no public API change.** About seventy
  duplicate implementations now have one home each: a single token-budget
  kernel for the discussion, state-machine and wave-executor bounds; shared
  validation, option, abort and process-liveness primitives; one bounded
  body reader, `asRecord`, data-URL and MIME helper; one A2A wire vocabulary
  (`tools/a2a-dialect.mjs`) and one MCP unknown-task wire mapping; one
  workspace hook/path-probe set and one workflow-policy effective-config
  builder; one adapter tool-merge/identity/session/quota mapper; one attempt
  tail for the four planning engines; one inbox claim/restore protocol
  (`claimInboxRows` / `restoreInboxRows` / `claimSteerRows`) behind the three
  delivery paths (`runStep`, `ChatSession.run`, the steer claim) and one home
  for the two row predicates (`messaging/row-shape.mjs`); one executor abort
  guard and one `failedOutputs` builder, which now reuse the existing
  `throwIfAborted`. Three degenerate-input canonicalizations are named: git's
  `realpath` now treats `ENOTDIR` as absent, so a race surfaces as typed
  `not_repo`/`not_worktree` instead of a raw fs error; a cancelled MCP tool
  call rejects with `AbortedError` (`Tool execution aborted.`) instead of a
  bare `Error` named `AbortError`; and the memory block skips a non-object
  history row instead of reading `.role` off it — observable only as one fewer
  `sdkError` line before the `TypeError` the same row raises in
  `_normalizeMessageSequence`.

## [0.22.2] - 2026-11-16

### Fixed

- **`withMemory()` now binds `client.embed`, so the vector tier works on every
  provider.** The builder stored the method unbound and the memory engine called
  it as a plain function; `MerciClient.embed` reads `this.provider` and
  `this.transport`, so the call threw `TypeError: Cannot read properties of
  undefined (reading 'provider')`. `safeEmbed()` in the memory provider swallows
  that error by design (lexical recall is the fallback), so the fact was
  persisted without a vector and nothing surfaced except the example's
  `dim=0` check. The embedder is now bound to the client, the backfill persists
  the vector, and a regression test asserts both the receiver and the stored
  embedding. Verified live against Vertex: `gemini-embedding-2` persists a
  3072-dimension vector.

## [0.22.1] - 2026-11-16

### Fixed

- **Vertex no longer rejects the request after a tool round when a live-state
  block follows the tool result.** Vertex (and the Gemini 3 models behind it)
  answers `400 Requests ending with a model turn are not supported.` when a
  user turn contains a `functionResponse` part followed by text. The trailing
  live-state row (todos, preloaded memory, skills) is merged into the tool
  result turn, which produced exactly that order — so a session with
  `withTodos()` failed on the synthesis step after `manage_todos`. The GAI
  normalizer now keeps `functionResponse` parts last inside a user turn: the
  live-state text comes first and the responses follow. Turns that contain only
  function responses are unchanged, and the Gemini API tier gets the same
  (accepted) order.

## [0.22.0] - 2026-11-15

### Changed

- **The Anthropic wire standard (`aai`) now runs on the SDK's built-in native
  `fetch` connector.** The `@anthropic-ai/sdk` dependency is gone; no vendor SDK
  is installed or required for the `anthropic` provider. The connector
  (`lib/backends/transport/aai-client.mjs`) carries the call surface the AAI
  adapter used from the vendor client — `messages.stream(body, opts)` and
  `models.list()` — on the same wire: `Authorization: Bearer <apiKey>`,
  `anthropic-version: 2026-10-21`, and `POST /v1/messages` / `GET /v1/models`
  under `baseURL`. `client.transport` is that connector.
- **The shared transport moved out of the OAI client.** What 0.21.1 fixed inside
  `oai-client.mjs` — `joinUrl`, header layering, the bounded error body, the
  linear SSE scanner, abort classification — is now the shared layer in
  `lib/backends/transport/http.mjs`, `sse.mjs`, `errors.mjs`, `abort.mjs`,
  `stream.mjs` and `options.mjs`, and the Anthropic connector uses it too. OAI
  behaviour is byte-identical: the 81 OAI parity cases replay at zero diffs. An
  install on 0.21.1 upgrading to 0.22.0 sends the same requests on every OAI
  provider.
- **26 recorded Anthropic oracle fixtures** (`test/fixtures/aai-parity/`,
  manifest pinned to `@anthropic-ai/sdk@1.5.0`) are the parity contract: the
  native connector replays every response body, stream event and error shape at
  zero diffs.
- **Retries are still Merci's.** The connector never retries; the session's
  retry policy and `embedRetryPolicy` own backoff exactly as before.
- **The Google wire standard (`gai`) now runs on the SDK's built-in native
  `fetch` connector.** `@google/genai` is gone; no vendor SDK is installed or
  required for the `google_genai` or `vertex` provider. The connector
  (`lib/backends/transport/gai-client.mjs`) carries the call surface the GAI
  adapter used from the vendor client — `models.generateContentStream`,
  `models.list()` and `models.embedContent` — over the shared transport
  (`http.mjs`, `sse.mjs`, `options.mjs`). `client.transport` is that connector.
- **Vertex authentication is native too.**
  `lib/backends/transport/google-auth.mjs` resolves application default
  credentials in the vendor library's order — explicit `credentials`, explicit
  `keyFile`, `GOOGLE_APPLICATION_CREDENTIALS`, the well-known ADC file, then the
  GCE/GKE metadata server — and exchanges a `service_account` (RS256 JWT
  assertion) or `authorized_user` (refresh-token grant) for an access token at
  `oauth2.googleapis.com/token`. Tokens are cached with a 60-second refresh skew
  behind one in-flight refresh; no token, key or credential value is logged or
  put into an error.
- **Vertex URL and embedding routing follow the vendor client.** The root comes
  from `location` (`global` → `aiplatform.googleapis.com`, `us`/`eu` →
  `aiplatform.{us,eu}.rep.googleapis.com`, otherwise
  `https://{location}-aiplatform.googleapis.com`), the API version is `v1beta1`
  on Vertex and `v1beta` on the Gemini Developer API, and a Vertex model path is
  `projects/{project}/locations/{location}/<model resource>`. `models.list()`
  reads `publishers/google/models`; Gemini embeds through
  `:batchEmbedContents`, Vertex through `:embedContent` for a Gemini embed model
  and `:predict` otherwise.
- **The two Vertex embedding endpoints answer different shapes, and each is read
  as the vendor client read it.** `:embedContent` answers
  `{embedding: {values}, usageMetadata?, truncated?}` and maps to a single
  embedding carrying `statistics` (`tokenCount`, `tokensDetails`, `truncated`
  when present); only `:predict` answers `predictions[].embeddings`, and each
  instance is the first text of its content (an input without text is dropped).
  Reading `predictions` on `:embedContent` returned no vector for the default
  Vertex embedding model (`gemini-embedding-2`); `embed()` now returns it.
- **Embed `config` reaches the wire per endpoint.** Gemini puts `taskType`,
  `title` and `outputDimensionality` on every `:batchEmbedContents` entry;
  Vertex sends them as `embedContentConfig` on `:embedContent`, and as
  `instances[].task_type` / `.title` plus `parameters.outputDimensionality` on
  `:predict`. The Vertex-only embed keys (`mimeType`, `autoTruncate`,
  `documentOcr`, `audioTrackExtraction`) are refused in Gemini mode.
- **`contents` is normalised the vendor client's way.** A bare part is one
  `user` content, a list of parts is ONE content carrying all of them, a list of
  Content objects passes through, and a mixed list or a bare
  `functionCall`/`functionResponse` part is refused before any request. Gemini
  embedding groups a string list into one content for `gemini-embedding-2`
  (one request, one vector) and keeps one request per string for every other
  embed model.
- **`responseSchema` is normalised; `responseJsonSchema` is passed through.**
  A string `type` and a `type` array are normalised (`OBJECT`, `STRING`, …): a
  one-member array becomes that `type`, a `null` member merges into `nullable`,
  and several members become an `anyOf` of single-type members. It recurses
  through `properties`, `items` and `anyOf` members, a two-member `anyOf` with a
  `null` branch becomes `nullable` on the other branch, `additionalProperties` is
  dropped, and an unknown type becomes `TYPE_UNSPECIFIED`. A schema carrying both
  `type` and `anyOf` is refused with the vendor client's wording
  (`type and anyOf cannot be both populated.`); `allOf`/`oneOf` members are left
  untouched, as the vendor client left them. A `responseSchema` that carries
  `$schema` is a JSON Schema, so it is sent as `responseJsonSchema` verbatim and
  `responseSchema` is dropped (a caller-supplied `responseJsonSchema` wins);
  `responseJsonSchema` itself is never touched.
- **`config: {}` now emits `generationConfig: {}`**, so a call that passes an
  empty config object sends the same body the vendor client did; a call with no
  config still omits the key.
- **Vertex Express works without `project`.** With `vertexai: true` and no
  `project`, the connector addresses `publishers/google/models/<model>` directly
  (`:streamGenerateContent`, `models.list()`, `:embedContent`, `:predict`)
  instead of throwing; with a project it keeps the
  `projects/{project}/locations/{location}/` prefix.
- **The Gemini SSE reader is strict in the vendor client's way.** Frames split
  on `\r\n\r\n`, `\n\n` or `\r\r` (earliest wins), each `data:` payload is
  parsed on its own, a frame carrying an `error` with a numeric HTTP code throws
  `ApiError` with that `status`, and a leftover tail at EOF throws `Incomplete
  JSON segment at the end` — so a bare JSON body fails exactly as it did
  through the SDK.
- **A JSON error body is read without a `content-type` header (deliberate
  divergence).** The vendor client parsed a non-2xx body as JSON only when the
  response declared `application/json`; this connector parses any body that is
  JSON, and a malformed JSON body raises the typed `ApiError` carrying the raw
  text instead of letting a raw `SyntaxError` escape. A gateway that answers
  JSON with `text/plain` therefore still yields the typed error with its message
  and `status`.
- **51 recorded Google oracle fixtures** (`test/fixtures/gai-parity/`, manifest
  pinned to `@google/genai@2.32.0`) are the parity contract: the native
  connector replays every stream chunk, list page, embedding request and vector,
  embed `config` mapping, schema normalisation and error shape at zero diffs.
  Re-recording the matrix twice from the vendor package produces byte-identical
  fixtures.
- **The audited production dependency tree drops from 75 packages to 67** when
  `@anthropic-ai/sdk` leaves and **to 26** once `@google/genai` leaves (the
  vendor package listed `@modelcontextprotocol/sdk` as an optional peer, so its
  removal also drops that package's subtree from the audited production graph);
  `pnpm audit --prod` reports no advisory at either step.
- `transportOptions` is validated by one shared function
  (`lib/backends/transport/options.mjs`), so `oai`, `aai` and `gai` accept and
  refuse the same keys with the same messages.

### Breaking

- **`anthropicOptions` is removed.** It was the vendor SDK's option bag.
  Constructing a client with it now throws a `ConfigurationError` that names the
  option. Pass the endpoint as `options.baseURL` and the transport values as
  `options.transportOptions` (`fetch`, `defaultHeaders`, `timeout`).
  `maxRetries` is not accepted: Merci owns retries.
- **`@anthropic-ai/sdk` is no longer a dependency.** Nothing in `lib/` imports
  it. A host that relied on it arriving transitively must install it itself.
- **The Anthropic `client.transport` is the connector, not the vendor client.**
  `messages.stream` keeps its name, arguments and events, and `models.list()`
  keeps the page surface (awaiting gives one page, iterating the promise
  auto-paginates). Streaming returns a plain `AsyncIterable`: the vendor
  client's `.on(...)`, `.done()` and `.finalMessage()` helpers are gone.
- **Anthropic headers.** Requests no longer send the vendor client's
  `User-Agent` or `X-Stainless-*` headers, and the API key travels as
  `Authorization: Bearer` on every request. A gateway that routed or logged on
  those headers sees this SDK's user agent instead.
- **`genaiOptions` is now a closed bag.** Supported keys are `vertexai` (or its
  historical alias `enterprise`), `project`, `location`, `apiVersion`, and
  `googleAuthOptions` with `credentials`, `keyFile` and `scopes`. Any other key
  throws a `ConfigurationError` naming the supported ones.
- **`genaiOptions.httpOptions` is refused.** It was the vendor client's HTTP
  seam; pass `options.baseURL` and `options.transportOptions` (`fetch`,
  `defaultHeaders`, `timeout`) instead. A per-call `config.httpOptions` still
  works because it belongs to the call shape, not the client.
- **Vertex auth no longer uses `google-auth-library`.** It refuses
  `external_account` (workload identity federation), impersonation and GDCH
  credentials with a `ConfigurationError`; `service_account` (including a
  `subject` for domain-wide delegation), `authorized_user` and the metadata
  server are supported.
- **The GAI error surface is `ApiError` with `status`**, as the vendor client
  raised it: the message is the JSON error body and `status` is the HTTP code.
- **Automatic function-call continuation is not performed.** A response that
  asks for a function call goes back to the adapter; the connector does not
  re-send the turn with the tool result on its own.
- **`@google/genai` is no longer a dependency.** Nothing in `lib/` imports it. A
  host that relied on it arriving transitively must install it itself, and it
  no longer brings `google-auth-library` or `protobufjs` into the tree.

## [0.21.1] - 2026-11-15

### Fixed

- **The Anthropic endpoint is no longer silently dropped.**
  `initializeClient({ provider: 'anthropic', options: { baseURL } })` used to
  leave `client.transport.baseURL` at `https://api.anthropic.com`. The `aai`
  backend now forwards the flat `baseURL` option to the Anthropic client, so a
  proxy or gateway endpoint is reached.
- **`OPENAI_BASE_URL` now applies to `initializeClient({ provider: 'openai' })`
  without `loadCredentials`.** It used to be ignored unless the credentials
  object already carried the URL, so an env-only call sent traffic to
  `api.openai.com` while `loadCredentials` reported the env URL.
  `ANTHROPIC_BASE_URL`, `OPENROUTER_URL`, `LM_STUDIO_URL` and `OPENCODE_URL`
  resolve the same way through one shared resolver, and direct client
  construction (`new OaiClient`, `new AaiClient`) honours its env key too.
  Resolution order is `options.baseURL` → the provider's URL env key → the
  descriptor (or `OPENCODE_TIER=zen`) default → the vendor SDK default. `null`
  means "unset".
- **A padded or blank URL env value is normalised everywhere.** The value is
  trimmed, and a blank one is ignored, including through `loadCredentials`: it
  returns `baseURL: undefined` instead of the raw blank string, so spreading
  its result into `initializeClient` does not trip base-URL validation.
- **An explicit `baseURL` is validated.** `baseURL: ''`, `baseURL: '   '` and a
  non-string value such as `baseURL: 42` now throw `ConfigurationError` instead
  of being stored and failing later with a raw `TypeError`. `baseURL: null` is
  treated as "unset".
- **Hosts with a stray URL env key in the environment now route that provider
  there.** Before 0.21.1 the OpenAI one was ignored (and the Anthropic one only
  applied because the vendor SDK read it itself), so an endpoint variable
  exported for another tool silently retargets these providers' traffic until
  it is unset. A no-provider OAI client still falls back to
  `OPENROUTER_API_KEY` in this case.
- **A `baseURL` that carries a query string now keeps it.** `joinUrl` splits the
  base query off before joining the path and re-appends it, so an Azure-style
  `?api-version=…` is not corrupted. A base URL that is not absolute throws
  `ConfigurationError` instead of producing a malformed URL.
- **An error response body is bounded.** The transport reads at most
  `LIMITS.max_error_body_bytes` and cancels the remainder, so a huge or endless
  error body cannot be buffered; the message keeps the first bytes verbatim.
- **SSE frames are bounded and scanned once.** A line or event above
  `LIMITS.sse_max_line_bytes` stops the read with the non-retryable
  `code: 'SSE_LINE_TOO_LONG'`. The line scanner resumes at the last index
  instead of rescanning the buffer.
- **The request no longer creates `AbortSignal.any` dependents.** It adds one
  `{ once: true }` listener to the caller's signal and removes it on every
  path, so a long-lived signal does not accumulate listeners across requests. A
  pre-aborted signal throws before `fetch` and before the deadline timer is
  armed.
- **Abort errors are classified by name.** A caller abort carries
  `name: 'AbortError'` and keeps the reason as `cause`, so `isAbortError`
  recognises it even when the signal reason is a plain `Error`.
- **Transformed responses keep `_request_id`.** `output_text`, embedding
  decoding and the model-list default are applied in place, so the
  non-enumerable request id the transport added survives.
- **Chat requests drop what the schema does not define.** `reasoning_summary`
  is no longer sent (it was warned about and still spread into the body);
  `verbosity` is kept for the other `oai` providers and dropped with a warning
  for `openrouter`.
- **Responses requests follow each provider's schema.** `stop` and `seed` are
  dropped for `openai`; `stop` is kept and `seed` dropped for `openrouter`; a
  user image part becomes
  `{ type: 'input_image', image_url: <string>, detail: 'auto' }`.
- **OpenRouter chat no longer receives OpenAI's `store`.** `ChatRequest` does
  not define it, so it is removed from that body only; the OpenAI chat body
  keeps it.
- **Only OpenAI's Responses body asks for the logprobs include.** OpenRouter's
  `include` enum has no `message.output_text.logprobs`, so the value is dropped
  there with a warning and `reasoning.encrypted_content` is still requested.
- **Responses function tools carry `strict`.** `FunctionTool.required` names
  it, so the adapter emits `strict: false` when the caller set none and keeps a
  caller-provided value; the chat path forwards a caller value and invents
  none, since that schema does not require it.
- **Assistant history uses `input_text`.** `output_text` belongs to
  `ResponseOutputMessage`, an output item that requires `id`, `status` and
  annotated parts; `EasyInputMessage` accepts only `input_text`.
  `responsesAssistantPartType` still selects the other shape for a host that
  needs it.
- **Reasoning deltas are consumed.** `response.reasoning_text.delta` and
  OpenRouter's `reasoning_details[].text` now surface as thought output instead
  of being ignored.
- **Anthropic stop reasons are explicit.** `pause_turn` emits one `error` with
  `error_type: 'pause_turn'`; `model_context_window_exceeded` emits one
  `truncated` instead of ending as a normal completion.
- **Gemini request fields match the Discovery schema.** `thinkingLevel` goes on
  the wire uppercase; `googleSearch.excludeDomains` is dropped with a warning
  on `google_genai` and kept on `vertex`.

### Changed

- **Retry statuses now match the OpenAI SDK.** 408, 409, 429 and every status
  >= 500 (501 included) are retried; other 4xx are not. A server
  `x-should-retry: true|false` is obeyed before the status check.
- **A rate-limit hint outside `(0, 60 s]` is ignored, not clamped.** A
  `retry-after` / `retry-after-ms` value that is <= 0, non-finite or above
  `LIMITS.retry_after_max_ms` falls back to the policy's exponential backoff.
  Vendor reset headers accept compound durations such as `6m0s`, but a parsed
  reset is still subject to the same window: `6m0s` is ignored under the
  default 60 s limit.
- **The SDK's own deadline is retryable.** `createTimeoutError()` carries
  `code: 'HEADER_TIMEOUT'`, so a request that misses its first-headers deadline
  is retried. A caller abort stays non-retryable.
- **`null` / `undefined` header values delete the header.** `defaultHeaders`
  and per-call headers follow vendor semantics instead of sending the strings
  `"null"` / `"undefined"`.
- **A non-JSON 2xx body now fails loudly.** A non-streaming call whose body is
  typed as a non-JSON media type (for example `text/html`) throws
  `BackendError` with status 400; a JSON-typed body that does not parse still
  throws the raw `SyntaxError`. A stream whose body is HTML throws
  `code: 'NON_JSON_STREAM'`. A `/models` body that is a string, number or
  array throws `code: 'NON_OBJECT_MODELS_BODY'`; a JSON `null` keeps the
  recorded `TypeError`. Each message includes at most 120 characters of the
  body prefix.
- **Stream media types are tolerated.** A `stream: true` request accepts
  `text/event-stream` (with or without parameters), `text/plain`, `*/*` and a
  missing content type as SSE. An `application/json` answer is read as one
  complete response and consumed through the non-streaming path instead of
  failing.
- **A stream result is single-use.** A second iteration throws
  `Cannot iterate over a consumed stream.` instead of silently yielding
  nothing.
- **A stream that ends without a terminal signal is flagged.** Output followed
  by neither a finish reason nor `[DONE]` now emits exactly one `truncated`
  event on the adapter stream (chat and Responses); the session records it as
  `state.truncated` rather than re-emitting it as a step event. The transport
  exposes `[DONE]` as `streamState.sawDone`, so a normal completion is not
  flagged.

## [0.21.0] - 2026-11-15

### Changed

- The OAI wire standard (`openai`, `openrouter`, `opencode`, `local`) now runs
  on a built-in native `fetch` connector. The `openai` dependency is gone; no
  vendor SDK is required for the four OAI providers.
- The connector carries the same call surface the OAI adapter used from the
  vendor SDK: `chat.completions.create`, `responses.create`,
  `embeddings.create` and `models.list`. `client.transport` is that connector.
- The first-headers deadline stays 600 s by default. `transportOptions.timeout`
  overrides it (a non-positive value uses the default, a non-finite value
  throws `ConfigurationError`); `MERCI_LIMIT_OAI_REQUEST_TIMEOUT_MS` also sets
  it, clamped to the limit registry's bounds like every other limit.
- 81 recorded oracle fixtures (`test/fixtures/oai-parity/`) are the parity
  contract: the connector and the former SDK were driven through the same
  loopback scenarios, and the connector matches on every case.
- The transitive `hono` and `@hono/node-server` overrides are pinned at their
  patched releases (4.13.16 / 2.1.6, resolving to 4.13.18 / 2.1.8), so
  `pnpm audit:deps` reports zero advisories across the production tree.

### Breaking

- `openaiOptions` is renamed `transportOptions` and accepts only `fetch`,
  `defaultHeaders`, `timeout` and `maxRetries`. A positive `maxRetries` and an
  unknown key throw `ConfigurationError`.
- Requests now send `User-Agent: merci-sdk/<version>` instead of the OpenAI
  SDK's `User-Agent` and `X-Stainless-*` headers; `OpenAI-Organization` and
  `OpenAI-Project` are not sent.
- `client.transport` is the fetch connector, not the vendor SDK object. The
  four method namespaces (`chat.completions.create`, `responses.create`,
  `embeddings.create`, `models.list`) are unchanged.

## [0.20.0] - 2026-11-14

### Breaking

- `BackendType` is removed. `ProviderType` names the eight providers
  (`jetbrains`, `openrouter`, `openai`, `local`, `google_genai`, `vertex`,
  `anthropic`, `opencode`) and `StandardType` names the four wire standards
  (`oai`, `aai`, `gai`, `jai`); the `PROVIDERS` and `STANDARDS` registries hold
  one descriptor per entry.
- `resolveBackend({ backend })` is removed. `resolveProvider()` reads `PROVIDER`
  from `secret.env` and has no `DEFAULT` sentinel.
- The `BACKEND=` env key is renamed `PROVIDER=`. The provider id strings are
  unchanged.
- `backend` parameters, fields and event payloads are renamed `provider`; a
  session and a client expose `.provider`, and a session also exposes
  `.standard`.
- `client.openai`, `client.genai` and `client.anthropic` are replaced by
  `client.transport`.
- `NATIVE_BACKENDS` is renamed `NATIVE_PROVIDERS` and `PDF_MEDIA_BACKENDS` is
  renamed `PDF_MEDIA_PROVIDERS`; `isGaiBackend` is replaced by
  `isStandard({ provider, standard })`.
- `renderTransfer` takes `targetProvider` instead of `targetBackend`; the
  `task:fork_degraded` payload carries `parentProvider`/`childProvider`
  instead of `parentBackend`/`childBackend`.

### Fixed

- OpenRouter and Local reported `backend: 'openai'`; each provider now reports
  its own id, which makes OpenRouter's native server tools and PDF path
  reachable.
- OpenRouter `openrouter:web_search` and `openrouter:web_fetch` send the
  documented nested `parameters` object (`max_results`, `allowed_domains`,
  `excluded_domains`, `user_location` / `max_content_tokens`,
  `allowed_domains`, `blocked_domains`) instead of flat fields.
- OpenRouter accepts PDFs through the OpenAI `file` part.
- Local and OpenCode refuse PDFs with a `ConfigurationError`; they previously
  accepted them only because they were labelled `openai`.
- A registered native row sidecar writes `provider` and still reads a legacy
  `backend` key, so rows persisted before the rename replay.

### Added

- **The SDK's own todo list can feed the scheduler.** `merci-sdk/scheduler` now
  exports `createTodoWorkSource({ store, includeInternal?, eventEmitter? })`, a
  read-only adapter
  over the `TodoComponent` shared `Map` (or any store whose `values()` returns an
  iterator and whose `size` is a number; the probe runs at construction).
  `dispatchable` is true for every todo with a valid non-terminal status and
  false for `completed` / `failed`, so the component's `pending` → `in_progress`
  lifecycle flip is not
  reconciled as inactive and does not abort a live attempt; pass
  `activeStates: ['pending', 'in_progress']` and
  `terminalStates: ['completed', 'failed']`. The list path filters with the
  caller's `states`, exactly like `createMemoryWorkSource`, and the store is read
  live on every call, so a completed todo leaves the next tick. `dag:<id>` rows
  are `PlanningExecutor`'s internal step mirrors and are skipped unless
  `includeInternal: true` is passed. An id is a
  trimmed non-empty string or a finite number, so numeric `1` and string `'1'`
  are one id and `undefined`, `null`, `true`, an array, or a bigint is a
  malformed row instead of a false id. Malformed rows keep the shared
  list/refresh asymmetry, whitespace-only id differences report `duplicate_id`,
  and a status is trimmed and lowercased once. No scheduler change and no new
  dependency.
- **A plain session can bind a workspace in one call.** `ChatSessionBuilder.withWorkspace({ workspace, ... })`
  appends the same context, shell and artifact tools the orchestration facade
  binds, resolving the gate from `withApproval()` when no explicit
  `approvalCallback` is given and following the session's `withPermissions()`
  mode unless one is passed. The default include fails closed without a gate;
  under `bypassPermissions` the toolbox now binds an ungated shell without a
  callback (it previously required one in every mode) and announces it, while
  every other mode still refuses. That shell-target announcement is per
  constructed shell tool — once per attempt under the facade, not once per
  orchestration — and it carries `runId: null` because it fires at construction,
  so it is not attempt-correlated. A second call replaces a tool by name,
  and a later `withTools()` clears the handle. Path containment now has one
  implementation: `isInsideRoot` lives in `lib/support/path-safety.mjs`
  (re-exported from the workspace path), and the context tools, `save_artifact`,
  and `ingestDocument({ root })` use it; ingestion also resolves and
  realpath-checks the document inside the root before reading it.
- **Operator ring visibility for the old layer.** `createEventRing` projects
  `parentRunId`, `sessionId`, `name`, and `success`, so a host that passes
  `prefixes` can see `run:*`, `session:*`, `tool:*`, and `artifact:*` records
  without weakening the allowlist. `name` is a tool name for `tool:*` only (capped
  at 128 chars), `success` is a boolean, and `sessionId` is a bounded non-empty
  string when present. `prefixes` replaces the default set, so spread the newly
  exported `DEFAULT_PREFIXES` to keep it. `createOrchestration` accepts a
  top-level `ring: { limit?, prefixes? }` and rejects a malformed one with
  `ConfigurationError` and option `ring`; `operator.ringLimit` remains the limit
  when `ring.limit` is absent. The correlation rule is documented in
  `docs/OPERATOR_API.md` §3.4 and `docs/ORCHESTRATION.md` §3: there is no
  automatic session-to-work-item mapping, and `parentRunId` is the executable
  join.
- **Scheduler restart resume.** `merci-sdk/scheduler` now exports
  `createMemoryAttemptStore()` and `createFileAttemptStore({ dir })`, and
  `WorkScheduler`/`createOrchestration` accept `attemptStore`. The store
  persists one atomic record per identifier and source `id`; `start()` hydrates
  it only for active items, so a restart keeps a non-retryable park and
  continues a retry budget instead of resetting it, while a re-created
  identifier starts fresh. The persisted `attempts` is a failure count, so the
  dispatch ordinal restarts at 1, and a hydrated count at `maxAttemptsPerItem`
  parks without an extra dispatch. Queued retries and in-flight attempts are
  not persisted; `checks` resets to 0 while `nextCheckAt` survives; a write
  failure is only a `scheduler:internal_error` event. One store directory
  belongs to one scheduler process, and a corrupt record degrades to a fresh
  attempt count.
- **One thread-id rule and a joinable workspace identity.** `threadIdFor({ kind,
  id })` is shared by `workThreadId` and `spawnThreadId`; `createEngineRunner`
  accepts an optional `threadId` (a string or `({ item, attempt }) => string`)
  and a scheduler attempt's own thread wins at the run boundary. `workspace:*`
  events gain an optional `identifier`, normalized to one trimmed value per key
  and remembered for one manager instance over one root; a failed creation never
  records one. `workThreadId`/`spawnThreadId` now reject empty or non-string
  ids with `invalid_thread_id` (previously they produced `work:undefined`).
- **One composition root for the coordination layer.** `createOrchestration`
  binds the policy, the scheduler, the workspace manager and the operator
  around one client, one read-only work source and one `WORKFLOW.md`, so the
  five seams between them are owned (and tested) once: the policy resolves
  before the scheduler is built, a healthy changed reload applies through
  `applyConfig`, the workspace manager comes from the same file, the operator
  serves the scheduler's own snapshot, and one `approval` callback is both the
  session gate and the workspace shell gate. Without an approval the shell tool
  is not bound at all. `start()`, `reload()`, `listen()`, `stop()` and `close()`
  own the lifecycle order; boot is strict on an unloadable file, and a live
  break keeps the last good config. Published on `merci-sdk/orchestration`.
- **A repo-owned workflow contract.** `WORKFLOW.md` holds YAML front matter plus
  a Markdown prompt, validated into one frozen config and rendered strictly per
  work item. Unsupported Liquid constructs fail at parse with line/column, and an
  unknown variable fails the attempt instead of rendering empty text; `~` and
  `$VAR` expand in workspace paths while `tracker.provider` rewrites only a
  whole-value reference, so a URL or command is never touched. A watcher keeps
  the last known good config when an edit is broken, `preflight()` blocks new work
  (and due retries) until it is fixed, and a `workflow_policy:reloaded`
  subscription applies scheduler settings live. The mapped `preflight` closure
  is memoized per policy instance, so a reload that changed only the prompt
  applies nothing (`applyConfig` returns `applied: false`) instead of reporting
  a scheduler reconfiguration; workspace root, strategy, and
  hooks stay construction-bound and config validation reports every invalid field
  in one `PolicyError`. The surface is published on
  `merci-sdk/workflow-policy`, with `PolicyError` on the main entry. The
  renderer maps the scheduler's 1-based attempt to the contract's retry index,
  so `{% if attempt %}` is false on the first attempt.
- **A durable MCP task store.** `FileMcpTaskStore({ dir })` persists one JSON
  record per task and reloads it on construction, so a completed task and its
  result survive a restart. A task that was still `working` when the process
  ended loads as `failed` with a restart message, because a run cannot resume
  without its process; a record past its retention window is removed instead
  of loaded. The file write is atomic (tmp + fsync + rename), and one process
  owns a directory. Both `McpTaskStore` and `FileMcpTaskStore` are exported
  from the main entry.
- **Per-item workspaces.** `WorkspaceManager` gives each work item its own
  directory, created once and reused, under a path that can never resolve
  outside the configured root. Two strategies: `directory` for a plain
  per-item folder, and `git-worktree` for a real `git worktree` on
  `merci/<key>`, so the item's edits land on its own branch instead of the
  host checkout. Four
  constructor-supplied lifecycle hooks (`afterCreate`, `beforeRun`, `afterRun`,
  `beforeRemove`) run with the workspace as `cwd`, a safe child environment and
  a timeout; only `afterCreate` and `beforeRun` are fatal. Isolation here is
  path confinement plus the existing approval gates, not an OS sandbox.
  `createWorkspaceTools` binds the context tools, the shell tool and the
  artifact tool to one workspace, and the whole surface is published on the
  `merci-sdk/workspace` subpath.
- **A work-item scheduler.** `WorkScheduler` polls a read-only work source,
  claims an item, and dispatches one engine run per attempt through
  `createEngineRunner` (`agentic`, `dag`, `stateMachine`, or `discussion`). The
  claim is held for the item's whole active life across capped exponential
  retries, bounded continuations, and parking; reconciliation and a stall
  watchdog end attempts whose item moved or went quiet. Claims are an
  in-process map or a file store with a second-process guard, concurrency is
  global and per lane, and `limits` stop new work at an attempt cap, a dispatch
  count, a token total, or a USD total. A duck-typed workspace manager gives
  each item its own directory or worktree and is cleaned only on a terminal
  state, never forced. `applyConfig` reconfigures dispatch-facing options live,
  the snapshot carries the last tick's `lastOutcome` so a blocked scheduler is
  not mistaken for an idle one, and the workspace lifecycle runs under each
  attempt's `RunContext` so `workspace:*` events join the dispatch that caused
  them. Twenty-one scheduler and work-item leaves report state without carrying
  prompt text. The surface is published on the `merci-sdk/scheduler` subpath
  with 12 names, and the two error types are on the main entry.
- **An operator API.** `createOperatorHttpHandler` answers a mountable
  `(req, res)` handler for `GET /` (a plain-text status page), `GET
  /api/v1/state`, `GET /api/v1/items/<identifier>` (plus the `/api/v1/<id>`
  alias), and `POST /api/v1/refresh`. The state is an explicit field-by-field
  projection of `WorkScheduler.snapshot()` with camelCase names and ISO 8601
  timestamps, and never carries an item's description or provider payload. An
  optional `getPolicySnapshot` adds the policy's health projection (`healthy`,
  `watch`, `reasons`, `warnings`, timestamps) to the state and a `Policy:` line
  to the status page, so a malformed `WORKFLOW.md` that blocks dispatch is
  visible instead of looking idle; the projection carries codes, never the
  effective config or the prompt. The
  refresh route checks the provider, the `application/json` media type, the body
  cap, and the scheduler lifecycle before it awaits one tick, and coalesces
  concurrent requests. A loopback Host allowlist is the security boundary; the
  handler never adds CORS and never copies a provider message or a stack.
  `createEventRing` keeps a bounded, allowlisted feed of scheduler, work-item,
  workspace and `workflow_policy` events, and `formatStatus` renders the same
  snapshot for a terminal.
  The surface is published on the `merci-sdk/operator` subpath with five names,
  and the three functions are also on the main entry.
- **`session.getLastRun()`.** The last completed run in one object: the
  deliverable `run()` returned, the final message rows, and the usage,
  citations, and sources the `RUN_END` event carries. `run()` keeps its string
  return, and a host no longer reads the internal `_lastStepMessages` to get
  the rows.
- **Structured shell pipelines.** `execute_shell_command` accepts
  `pipeline: [{ command, args }, …]` (up to five stages) as an alternative to
  `command` + `args`. The tool still has no shell: each stage is an argv array,
  stages are connected through stdout, and the exit code is the last stage's.
  Every stage passes the blocklist, the read-only tier, the option policy, and
  root confinement before anything spawns; the chain asks for approval once,
  with every stage named in the prompt. A closed downstream pipe is a normal
  pipeline event, not a tool failure.
- **`createShellPolicyTool`.** `describe_shell_policy` returns the effective
  tier of its shell-tool instance as JSON — safe commands, blocked commands,
  roots, timeout, output cap, and the pipeline stage cap — so a model reads the
  host's real policy instead of guessing from the defaults.
- **Cancel one item.** `WorkScheduler.cancelItem({ identifier })` aborts one
  running attempt or parks a queued retry under reason `canceled`. The claim is
  kept, so an active tracker item is not redispatched on the next scan;
  `resetItem` un-parks it. `stop()` still aborts every attempt.
- **A skill can be read by name.** `SkillsLibrary.load({ name })` returns that
  skill's instructions, so a progressive-disclosure catalog stays usable for a
  plain `SkillEntry` list; `load()` still lists names and descriptions.

### Changed

- **Every engine reports the attempt's tree spend.** For a budgeted `dag`,
  `stateMachine` or `discussion` attempt the engine runner creates one cap-less
  ledger per `run()` and gives every session the engine creates that same
  ledger; those engines now report its growth, so their own model calls and
  every delegated child land in the scheduler's `totals` exactly like
  `agentic`. A failed or canceled attempt reports what it spent. The ledger is
  reporting only: its caps stay `null`, a session's `withBudget()` cannot move
  them, and the per-attempt budget still reaches each step/node/agent. An
  unbudgeted run creates no ledger and keeps the old per-engine numbers byte for
  byte. Folded: step/node/turn sessions, nested engines, objective (including the
  session-level restatement), judge and aggregate sessions, task children on a
  profile's own client, and a discussion agent's own client. A host hook or a
  code-agent `execute` that spends through the client it is given is folded too,
  since the ledger and its snapshot predate every hook. One
  session object per live attempt is required: a session that still carries
  another attempt's ledger is refused with `session_reused_across_attempts`.
- **A budgeted subtree reports its spend without losing its cap.** A session that
  joins an attempt already carrying `_budget` keeps its own capped ledger — the
  cap binds its subtree exactly as before — and that ledger links to the attempt
  ledger as a child, so each charge is folded into the attempt's totals once. A
  budget applied after the session joins stays a run-local cap and still cannot
  move the attempt ledger. A budgeted session reused sequentially is re-linked to
  the new attempt ledger and each attempt reports only its own delta; a session
  whose budgeted ledger still has a live foreign parent is refused with
  `session_reused_across_attempts`. The discussion subagent pseudo-parent is the
  in-repo case.
- **Host hooks and code agents report through the attempt ledger.** A budgeted
  `dag`, `stateMachine` or `discussion` attempt now takes its cap-less ledger and
  the `before` snapshot before any host callback runs, so spend a hook makes
  through the client it is given is inside the attempt's total. Each hook gets its
  own bag: `tools` and `agents` get
  `{ item, attempt, workspace, client, budgetPool, runContext }`; `planFor` and
  `graphFor` get `{ item, attempt, signal, client, budgetPool, runContext }`;
  `prompt`, `objective` and `threadId` get `{ item, attempt }`. `budgetPool` is
  the live attempt ledger and is read-only: a hook charges it by calling
  `client`, never by writing it. A callback that ignores the keys behaves as
  before, and the `agentic` engine keeps its own session pool, so `client` and
  `budgetPool` are null there. `graphFor` may return a Promise; a graph object
  that carries a `then` transition verb is passed through as is, not awaited.
  A code-agent profile's `execute` is called with
  `{ prompt, signal, session, client, budgetPool }` (`session` is the parent
  session object); a session it opens through `client` charges the attempt and is
  detached when it returns. A non-LLM discussion agent's `execute` keeps its
  turn bag and gains the same pair:
  `{ instruction, type, signal, ledger, agent, objective, agentContext, _merci, handoff, runContext, client, budgetPool }`.
  The SDK still cannot see a call
  made through a client the host built and kept itself. A client a host kept past
  `run()` joins nothing: the released ledger stays closed, so the host's later
  call is simply unreported and the next attempt is not refused as a reused
  session.
- **Failure classification and abort detection each have one implementation.**
  The old agentic loop now labels a failed run with `classifyFailure` and the
  scheduler's own `failureEvidence`, so both layers agree on `ENOENT`,
  `TimeoutError`, guardrail, rate-limit, and plain errors; the class rides
  `run:end` and the thrown error (nothing for an abort), and it stays
  diagnostic because the scheduler still reclassifies from the error code.
  `scheduler/retry.mjs` and `workspace/hooks.mjs` delegate to the canonical
  `isAbortError` from `core/errors.mjs`, so a `CanceledError`, an
  `ABORT_ERR`/`ERR_CANCELED` code, or an abort nested in `cause` is recognized
  at the scheduler, the hooks, and the loop. A canceled attempt that carries an
  error now counts in `totals.failures` (a host stop or `cancelItem` does not),
  and a hostile getter still reads as "not aborted". `WORK_SOURCE_CATEGORIES` now
  lives once in `lib/core/constants/work-sources.mjs` (re-exported on
  `merci-sdk/scheduler`), and the policy/guardrail code strings compare against
  `ERROR_CODES`.
- **The skill catalog is name + description only.** `SkillsLibrary.load()` no
  longer inlines SKILL.md bodies; `maxCatalogChars` (default 4000) bounds the
  listing, whole entries are dropped instead of truncated mid-word, and the
  omission is stated. The body is returned by the skill's own tool.
- **Reading a skill no longer runs its script.** A skill that ships `scripts/`
  returns its instructions plus the runnable script names when the call has no
  `script` argument; `{ "script": "<name>" }` executes one. `requiresApproval`
  became a per-call predicate, so reading is ungated and running stays gated.
  The tool schema advertises the script names in an `enum`.
- **A stopped scheduler restarts in-process.** `start()` after `stop()` clears
  the stop flag and resumes the same instance, so a dev reload, an admin pause,
  or a test does not need a new scheduler. `stop()` still aborts running
  attempts and releases queued claims; calling `start()` on a running scheduler
  still throws `already_started`.

### Fixed

- **A memoized task-profile child no longer mis-attributes spend.** The task
  path now attaches its child through the same ledger helper as the scheduler
  views: a sequentially reused child session joins the current attempt ledger
  and each attempt reports its own spend (it used to keep the closed ledger of
  the attempt that built it, so the next attempt reported `0`). A child's own
  budget (its `profile.budget`, or a budget its session already carried) caps its
  per-spawn subtree with a fresh ledger, so a memoized child neither accumulates
  nor escapes through a wider descendant; a step or node budget caps that unit's
  subtree, and a budget applied **after** joining creates its own capped child
  ledger under the attempt. Charges fold once while the attempt's own caps stay
  `null`. A child session live in two concurrent attempts is refused with
  `session_reused_across_attempts`, a released ledger never accepts a new child,
  and a configuration error surfaces unchanged so `option` stays branchable and
  no retry hint is appended. A `continueWith` turn still charges the same open
  ledger. Host hooks and `execute` bags now receive a frozen read-only view of
  the ledger (a frozen copy of the live totals) instead of the live object, and
  `tools`, `agents`, `planFor` and `graphFor` factories may return a Promise and
  are awaited.
- **One timeout vocabulary.** `TIMEOUT_CODES` (now on the main entry) holds
  every code the SDK raises
  (`HEADER_TIMEOUT`, `BODY_TIMEOUT`, `STEP_TIMEOUT`, `STREAM_TIMEOUT`, plus
  `ETIMEDOUT`/`TIMEOUT`), and `hasTimeoutCode`, the retry policy, and the
  scheduler read that one set. A stream inactivity timeout no longer normalizes
  as `canceled`: it is a `failed` attempt with `timedOut: true`, so it counts as
  a failure and retries. The error keeps its `AbortError` name so adapters still
  destroy the vendor request, and a caller abort still wins over the code.
- **A failed result can carry its evidence.** `normalizeRunResult` reads
  `error`, `errorCode`, `errorName`, and `nonRetryable` from a returned
  `{ status: 'failed' }` result; it used to null all of them, so the failure
  taxonomy saw `unknown` and retried an application error to
  `maxAttemptsPerItem`. A result flagged `nonRetryable` now parks on its first
  failure, the same way a thrown error with `nonRetryable` already did.
- **The operator resolves a row by `workItemId` too.** Every event payload
  carries the provider's `workItemId`, never the scheduler's `identifier`, so
  the detail route returned `404` for an id a UI had just rendered. Lookup tries
  `identifier` first, then `workItemId`, and `recentEvents` is keyed by the
  matched row's `identifier`.
- **`ConfigurationError` keeps `context`** like the other typed errors, and
  `ingestDocument` tags its refusals with `option: 'unsupported_document_type'`,
  `'pdf_backend_unsupported'`, `'client'`, or `'path'`, so a host maps an
  unsupported upload to its own status code without matching prose.
- **A stream timeout keeps its code through the session.** `step()` used to
  replace an abort-shaped error with a plain `Error`, dropping `STREAM_TIMEOUT`
  before the scheduler saw it. The timeout error is now rethrown intact, so the
  attempt is `failed` with `timedOut: true` instead of an anonymous failure.
  `structuredLlmCall` still retries its own deadline on a fresh session, and a
  caller abort still rethrows.
- **The shell pipeline no longer deadlocks on a closed reader.** When a stage
  exits before consuming its input, the parent now destroys the upstream read
  end; a large producer (`cat big.txt | head -1`) used to block on a full pipe
  until the tool timeout. A pre-aborted signal rejects before any stage spawns,
  a last stage killed by a signal is a failure even when stderr was capped, and
  the stdout cap is a byte ceiling that sets `truncated`.
- **A failed resume leaves the scheduler stopped.** Clearing the stop flag now
  happens after validation, so a failing `preflight()` on `start()` after
  `stop()` no longer reports `started: true` with no timer and refuses to start.
- **A canceled result keeps its evidence.** A `{status:'canceled'}` result that
  still carries `PERMISSION_DENIED` or `MERCI-GUARDRAIL-ERR` parks on the first
  failure instead of retrying to `maxAttemptsPerItem`.
- **The skill gate survives broken references and covers `merci-sdk@x.y.z`.** A
  broken `references/*.md` symlink or a directory named `*.md` no longer crashes
  or misreports, and the version check sees pin-style citations.

## [0.12.0] - 2026-11-05

### Added

- **Structured shell pipelines.** `execute_shell_command` accepts
  `pipeline: [{ command, args }, ...]` (up to 5 stages): each stage reads the
  previous stage's stdout, so `rg ... | sort | head` works without a shell.
  Every stage gets the same blocklist, safe-option policy and root
  confinement, the exit code is the last stage's, and the chain asks for
  approval at most once — the prompt names the whole chain, never a partial
  view. The single-command form is unchanged, except that a stderr overflow is
  now capped and flagged (`truncated: true`) instead of aborting the command;
  a stdout overflow still aborts, because stdout is the answer.
- **`cli-search` and `shell-scripting` skills.** Two consumer skills for the
  shell contract: which forms run without a prompt, when to prefer the native
  `grep`/`glob`/`read` tools, and how to package multi-step work as one
  approved script. `scripts/check-skill.mjs` now gates every skill directory,
  and `pnpm test` runs the gate.
- **Modern stdio MCP server mode.**
  `createMcpServer({ mcpProtocolVersion: '2026-07-28' })` wraps the SDK's
  `serveStdio`: the opening exchange selects the era, one instance is pinned
  per connection, and 2025 traffic is still served. The handle keeps
  `setRequestHandler` (queued until the instance exists) and
  `getClientVersion`; `connect` throws because the SDK owns the transport.
  The default stdio mode keeps the connected server handle.
- **Pluggable MCP task store.** `createMcpServer` and a stateful
  `createMcpHttpHandler` accept `taskStore` (an `McpTaskStoreLike`) so a
  caller can persist the legacy task vocabulary; `McpTaskStore` is exported as
  the reference implementation. A supplied store is shared and owned by its
  caller: the server cancels the tasks its own session started but does not
  close the store. `taskStore` is refused in the stateless and modern modes,
  where a task cannot outlive the request that created it.
- **MCP task status and pagination on the client.** `McpClient` accepts
  `onTaskStatus` and emits `mcp:task_status` for every
  `notifications/tasks/status` the server publishes. `tasks/list` now pages by
  cursor, and `McpTaskStore` returns one page at a time.
- **A modern-only MCP stdio mode.** Pass `legacy: 'reject'` alongside
  `mcpProtocolVersion: '2026-07-28'` to refuse a 2025 client instead of
  serving it; the default remains `legacy: 'serve'`.

### Changed

- **Skill loading is progressive by default.** `SkillsLibrary.load()` lists
  name and description only, inside an 8000-character catalog budget; bodies
  load when the model calls the skill. Previously each body was inlined into
  the listing (up to 8000 characters per skill), which pushed the trigger text
  out of the model's view at three or more skills.
- **A skill with scripts is readable again.** Calling a skill with no
  `script` selector returns its instructions and names the runnable scripts;
  only an explicit `{ script: "<name>" }` executes code. Before, the first
  script ran on every call, so a scripted skill's instructions were
  unreachable.
- **MCP Tasks were revisited and are marked deprecated.** `taskSupport:
  'required'` now rejects a plain `tools/call`; `ttl` is retention from the
  last update, so a working task no longer expires mid-run; closing the
  server aborts a task still in flight; and `McpClient.waitForTask` polls to
  a terminal state. The 2025-11-25 vocabulary stays for peers that serve it.
  The lifecycle now lives in `McpTaskStore`, so a durable store can replace it
  without touching the protocol handlers.
- **`McpClient.listTasks` returns a page.** It now resolves
  `{ tasks, nextCursor }` instead of a bare array, so a caller can continue
  with `listTasks({ cursor })`. An unknown task rejects with the
  `ERROR_CODES.MCP_UNKNOWN_TASK` code instead of a message-only error.


## [0.11.0] - 2026-11-05

### Added

- **Stateless 2026-07-28 MCP server mode.**
  `createMcpHttpHandler({ mcpProtocolVersion: '2026-07-28' })` serves the
  modern era through `createMcpHandler` + `toNodeHandler`: one server per
  request, no `Mcp-Session-Id`, and 2025 traffic served statelessly. The
  default stateful handler is unchanged.
- **MCP Tasks interop (legacy era).** A tool with `taskSupport` advertises the
  2025-11-25 task vocabulary; `tools/call` with `task` returns a task, and
  `McpClient` gains `startToolTask`, `getTask`, `getTaskResult`, `listTasks`
  and `cancelTask`.
- **SQLite memory bank.** `SqliteMemoryProvider` stores the same bank shape in
  one transaction on `node:sqlite`; the engine floor moves to Node ≥22.13.

### Changed

**The engine floor is Node ≥22.13**, the first release with `node:sqlite`.
`SqliteMemoryProvider` is the only consumer; the file bank still works on the
same floor.

### Fixed

- **The curl scrape leg pins the resolved address.** The DNS guard and the
  socket no longer resolve the name twice, so a 0-TTL answer cannot flip
  between the check and the connect; each redirect hop resolves again. The
  browser leg keeps Playwright's resolver and stays check-then-connect.

## [0.10.0] - 2026-11-05

### Added

- **Model cascade.** A workflow step may set `escalateModel`: the first attempt
  uses `model`, and a retry that follows a schema or verifier failure uses the
  escalated model (a transient empty response does not escalate). The escalated
  attempt is charged to the same budget and tree pool.
- **A scripted cassette.** `createCassette({ script })` replays hand-written
  normalized event arrays — one per vendor call, the last repeating — so a test
  needs no vendor client at all.
- **MCP process options.** `McpClientOptions.cwd` and `stderr: 'pipe'` reach the
  stdio server; `listResourceTemplates()` lists URI templates; tool
  `annotations` are kept, and `approveDestructive` gates every loaded tool that
  is not read-only.
- **A2A continuation.** Passing back a `needsInput` result's `taskId`/`contextId`
  continues that task; an abort or deadline cancels the remote task.
- **Context editing.** `compaction.clearToolResults: { keepRecent, placeholder }`
  clears old tool payloads before the LLM fold.
- **Run provenance.** A run's citations and web-search URLs are deduped into
  `session._lastRunCitations` / `_lastRunSources` and the `run:end` payload.
- **`withMaxParallelTools({ max })`** caps how many tool calls from one turn run
  at once.
- **`ERROR_CODES`** is exported from the entry point with its literal type.
- **Subpath exports** `./evals`, `./cassette`, `./sessions` and `./otel`.
- **`LoopOptions`** names the run options `run()` accepts, so editors
  autocomplete them.
- **Deferred tools.** A tool with `deferLoading: true` is kept out of the
  model's request until the built-in `tool_search` tool finds it and loads the
  matches for the next turn. `_tools` still carries the full list for execution
  and permissions.
- **Multimodal tool results.** An MCP or local image block survives on
  Anthropic, Gemini/Vertex and the OpenAI Responses API; every other backend
  gets a note that the image was dropped, and base64 never leaks into a text
  field.

### Changed

**MCP on the TypeScript SDK v2.** The MCP client and server run on
`@modelcontextprotocol/client`, `/server` and `/node` v2 instead of the v1
`@modelcontextprotocol/sdk`, which stays a devDependency for the cross-version
interop tests. merci's wrapper API is unchanged. A new `mcpProtocolVersion`
option selects the wire era: `'legacy'` (default, the 2025 `initialize`
handshake), `'auto'` (probe `server/discover`, then fall back), or a pinned
date such as `'2026-07-28'`. On the modern era a tool's `input_required`
answer is fulfilled through the registered `onElicit`/`onSampling` handlers.
The `server/discover` probe is capped at 10 s (`MCP_PROBE_TIMEOUT_MS`) instead
of the SDK's 60 s request timeout, so a silent legacy server does not stall a
connect for a minute. See MIGRATION §15.

### Fixed

- **Compaction triggers on the prompt size the backend reported** (cache tokens
  included) instead of a row estimate, and the summary call is charged to the
  run's budget and the tree pool.
- **The memory bank is written once per distill batch**, not once per fact, and
  an unreadable bank rejects instead of being overwritten. `writeJsonAtomic`
  fsyncs before the rename.
- **The web, scrape and browser preload blocks mark their content as untrusted
  data, not instructions.**
- **Anthropic structured output uses the native `output_config.format`.** A
  `json_schema` response format no longer forces a `json_output` tool, which
  the API rejected as unknown when the caller declared no tools. The answer
  arrives as text that matches the schema, so validation is unchanged, and a
  caller-supplied `output_config` (e.g. `effort`) is merged rather than
  overwritten.
- **Anthropic accepts `reasoningEffort`.** It maps to `output_config.effort`
  and never implies adaptive thinking; `thinkingBudget('adaptive')` maps to
  `thinking: { type: 'adaptive' }` and is Anthropic-only.
- **OpenAI Responses carries the reasoning controls.** `reasoningSummary` →
  `reasoning.summary`, `verbosity` → `text.verbosity` (merged beside a
  `json_schema` format), and `store: false` requests
  `include: ['reasoning.encrypted_content']` so reasoning items can be
  replayed. The chat-completions branch warns and drops both fields.
- **`createMcpHttpHandler({ sessionIdGenerator: undefined })` now really
  serves statelessly.** A destructuring default replaced the explicit
  `undefined` with a UUID generator, so the documented stateless switch
  silently ran stateful and kept a session per client. The key's presence now
  decides, and the conformance test asserts that no session is minted.
- **An aborted MCP tool call rejects as an abort again.** The v2 client
  reports a caller cancellation as a request timeout, indistinguishable from a
  real timeout by code; `executeTool` now maps its own aborted signal back to
  `AbortedError`.

## [0.9.0] - 2026-11-05

Security and data-integrity wave (R1 of the library-upgrade plan). One change
is breaking: a server bound to a non-local interface must now name its hosts.

### Changed — breaking

**HTTP servers refuse a foreign `Host`.** `createMcpHttpHandler` and
`createA2AHttpHandler` answer `403` (a JSON-RPC error) when the `Host` header
does not name a loopback host — `localhost`, `127.0.0.1`, `::1`; the port is
ignored. A server bound to a non-local interface passes the names it serves
(`allowedHosts`) or opts out (`allowAnyHost: true`). The default is
fail-closed: an absent or unparseable `Host` is refused. See MIGRATION §13.

### Security

- **SSRF through DNS (scrape).** `fetchGuarded` resolves every host it is about
  to fetch and refuses the request when any answer is private or reserved. The
  check runs before each hop of a redirect, so a public host that redirects to
  a name resolving to loopback no longer bypasses the literal-host check.
  IPv4-mapped IPv6 answers are normalized first. The guard is
  check-then-connect: pinning the resolved address is later hardening.
- **Browser SSRF.** A Playwright session routes every request — navigation,
  click, evaluate, subresource — through the same DNS and domain policy before
  it leaves the process.
- **Request body caps.** The MCP HTTP handler lets the SDK read the body, so its
  4 MiB cap answers `413`; A2A caps a request at `A2A_REQUEST_MAX_BODY_BYTES`
  (10 MB). Both servers keep serving afterwards.
- **A skill that runs code is never auto-approved.** `acceptEdits` no longer
  approves a skill that carries scripts: `runsCode` is declared on the tool and
  `stillRequiresApproval` reads it.

### Fixed

- **A blocked answer is no longer persisted.** A guardrail trip on the output
  phase drops the refused assistant text from the session and the checkpoint,
  while the run's tool rows — whose side effects already happened — stay.
- **A failed run keeps its journal.** The checkpoint is saved in a `finally`,
  so a run that throws after a tool round leaves its DONE rows in the store.
- **Identical tool calls in one round get distinct journal keys**, counted on
  the parsed arguments, so two identical calls both run and both replay.
- **A tool that dies on its timeout signal is `interrupted`**, not re-executed.
- **The journal boundary grows across a compaction fold** (and compensates a
  dedupe shrink), so an identical call after a fold gets a fresh key while a
  retry of the same turn reuses its own.
- **A subagent delegation's journal keys are scoped to its spawn**, so two
  delegations to the same agent no longer replay each other.
- **A retry policy's `nonRetryable` is honored** by `runWithRetry`, so an open
  breaker or a cassette miss is tried once.
- **The JAI reasoning effort is restored** after a synthesis retry instead of
  staying lowered for the next run.
- **`withSystemMessage({content})` is unwrapped** into the string or block form
  instead of storing `[object Object]`; any other shape is a
  `ConfigurationError`.
- **A state-machine condition cannot hang the process.** The vm context runs
  microtasks with `microtaskMode: 'afterEvaluate'`, so `while(1) await 0` times
  out.
- **The JSON validator cache** is keyed by object identity and by text, and a
  duplicate `$id` recompiles on a fresh Ajv instance, so two distinct schemas
  with the same `$id` both validate and the strict and non-strict caches stay
  independent.
- **The child environment keeps the locale** (`LANG`, `LC_ALL`, `LC_CTYPE`,
  `TZ`, `TMPDIR`) on top of the MCP SDK's allowlist, for `runCommand` and for
  stdio MCP servers.
- **`runEvals` checks the abort signal** before each limiter task starts.
- **The OTLP export POST is bounded** at 10 s, so a hung collector cannot hold
  a shutdown open.

### Added

- **MCP tool progress.** An MCP tool call defaults to 60 s (the SDK default)
  instead of 5 s; a progress notification resets the timeout and emits
  `mcp:call_progress` (`EVENTS.MCP.CALL_PROGRESS`).
- **`createMcpHttpHandler` returns `close()`**, which closes every live session
  and its server; a client `DELETE` or a transport close removes its session.
- **ACP session capabilities.** `initialize` advertises
  `{list: {}, delete: {}, close: {}, fork: {}}`; `session/close` is handled and,
  like `session/delete`, cancels the running turn first.
- **A2A task lifecycle.** A running skill receives the task's abort signal and
  `tasks/cancel` cancels it; a terminal state is never overwritten;
  `tasks/list` pages by decimal offset; terminal tasks are pruned after one hour
  or above 1000 entries, and new work is refused (`-32000`) rather than grow
  without bound.

## [0.8.0] - 2026-11-04

### Added

**Mid-run input steering (SP7)**

- `session.enqueueInput({input, delivery})` puts a message on the session inbox from
  outside the run. `delivery: 'steer'` (the default) reaches the model at the next
  step boundary of the running turn — including after a final answer, where it starts
  another turn instead of being returned unread — while `'queue'` waits for the next
  turn, as background delegation results already did. A steer claimed by a turn that
  then fails is restored, so delivery is at-least-once. Placement reuses the pending
  inbox rule, so a `tool_use`/`tool_result` pair is never split.

**Agentic spawning (wave 6 of the agentic debt audit — spawning)**

- **A spawn is a session with an identity.** `getSpawnRegistry({client})` owns the
  roster, the transport registry, the depth cap, the counter, the in-flight
  background map and one record per delegation (id, `parentId`, `lineage`, status,
  the winning session, a usage ledger summed across retries and hedges);
  `listSpawns`/`getSpawn` are the read API. The registry lives in a `WeakMap` keyed
  by the transport client (SP5 later removed the temporary `client._task*` view).
- **A host delegation envelope.** `withAgentDelegation({client, agents, models,
  transports, system, tools, maxDepth})` grants each dimension independently, with
  the most restrictive default; the task tool's schema is derived from the envelope,
  so an ungranted dimension is absent rather than present-and-ignored.
- **A spawn can be continued.** `continueWith(prompt)` / `sendToSpawn(id, prompt)`
  runs another turn on the same child session, with its history and configuration;
  turns on one spawn are serialized and each settles once.

**Subagents — a foreground child streams its work to the parent (wave 10 / E4)**

- The `task` tool now forwards a child's text, thoughts and tool calls to the parent
  emitter as `workflow:step_text` / `step_thought` / `step_tool_call_start|end`, with
  `subagent` naming the child, the spawning node's id and the step's run correlation.
  Before, a caller watching events saw `task:start` and `task:finish` only, while the
  discussion/MAA path already forwarded the same stream. A throwing listener cannot
  abort the child.
- A child run now hangs off the spawning step (`runContext: RunContext.child(stepRun)`),
  so `parentRunId` is set and the tree is readable; a child context also inherits the
  step id (`RunContext.child`). E1 (code-agent depth), E2 (tree budget) and E5
  (background results) were already closed by wave 6 — the findings ledger now says so
  with the evidence.

**Subagents — a continued turn streams too (wave 11 / N5)**

- `continueSpawn` / `continueWith` / `client.send` now forward the continued turn's
  text, thoughts and tool calls to the parent emitter through the same forwarder the
  first turn uses (`workflow:step_*`), named by the spawn id (a continuation has no
  spawning node). The continued run also hangs off the step that spawned it
  (`parentRunId`), so its lineage survives a second turn, and a throwing listener
  cannot break the continuation.

**Ledger — journal rows say what they are, and the event stream can be a durable ledger (wave 9 / B6 + B8)**

- A journal row now carries `boundary` (the step or branch), `args`, a monotonic
  `seq` that survives a checkpoint, `sessionId`/`parentRunId`, and `usage` when the
  caller knows it. The key still hashes boundary + args, so replay isolation is
  unchanged — the row no longer discards what the hash was made of. `seq` replaces a
  millisecond timestamp that collides inside a parallel wave.
- `log.event({ …, fields })` lets a caller put structured data on the NDJSON record, and
  `attachEventLogger`'s `trace` level now logs the **full envelope as fields**
  (`{ event, payload }`) instead of a pretty-printed text box. `log.configure({
  format: 'json', sink, level: 'trace' })` is therefore the durable ledger shape;
  below `trace` the summary behaviour is unchanged.

**Memory — the bank keeps an audit trail (wave 9 / B3)**

- Every add, rewrite, forget and clear appends a bounded `history` row to the bank:
  `{ event, id, old, new, actor, ts }`. A deleted fact's content and the session that
  deleted it are recoverable from the file (before, only the id survived). The trail is
  persisted, capped at `MEMORY_MAX_HISTORY_ROWS`, merged under the bank's file lock, and
  readable through `provider.history`.

**Memory — facts dedupe against the conversation, not a manager UUID (wave 9 / B4)**

- `MemoryManager` and `withMemory()` take a `sessionId`: facts dedupe against the
  conversation id, so a resumed session (which builds a new manager) no longer stores a
  second copy of every fact. `withMemory()` defaults it to the session's own id — even
  when that id is set after `withMemory()` — and a manager used outside a session keeps
  the old random key as a fallback.
- The stored fact carries the real session key (`sessionKey`), which is what the bank
  and the provider persist.

**DAG workflows — a template reference to a non-ancestor is a plan-time error (wave 7 / C1, closing slice)**

- `{{step_id.output}}` must name one of the step's transitive `dependencies`. A
  reference to a sibling, a descendant or the step itself is now rejected by
  `setSteps()` with the edge named (`'{{x.output}}' in step 'b' — add the dependency`),
  and on every rewrite and plan patch — before, it passed the existence check and
  rendered `[UNRESOLVED: …]` mid-run. A self-reference is caught by the same rule.
- Context roots (`{{context.topic}}`, a host-supplied root) are not steps and are left
  to the execute-time existence check, so a plan can still be installed before its
  context keys are known. The runtime warning path remains the backstop for a plan
  installed with `validateTemplateRefs: false` or restored without re-validation.

**DAG workflows — progressive decomposition (wave 7 / PL1c of the agentic debt audit)**

- A step with `expansion: 'decompose'` is planned when it becomes runnable, not when the
  plan is installed. The planner sees the node's brief (`## Acceptance`), its ancestors'
  outputs and `## Remaining plan`, and the sub-plan runs on the nested engine — the
  depth limit, child checkpoint and shared journal are the existing ones. The sub-plan's
  leaf is the node's output, so `verify`/schema gates run on the real result, and
  `workflow:step_decomposed` names the sub-steps (forwarded out of nested children).
  The learned sub-plan is kept on the node and rides the checkpoint, so a verify/schema
  retry, a resume, or re-supplying the same plan reuses it; an explicit `subSteps` still
  wins and is never planned, an invalid sub-plan is not cached, and a changed definition
  or a plain re-execution plans again.
- `step.expansion` is honoured by `Plan.fromDag` (`decompose` is no longer flattened to
  `atomic`), and `step.kind: 'gate'` survives the projection.
- An empty replan response (no steps) no longer deletes the run — it is refused with a
  warning and the current plan is kept.

**DAG workflows — a plan evaluator, and replanning by patch (wave 7 / PL2b of the agentic debt audit)**

- `planEvaluator` sees the whole plan plus `progress` (completed with outputs, pending,
  failed) and answers `continue`, `replan` (with a patch), `done` or `abort`. It runs
  at a wave boundary, every `planEvaluateEvery` completed nodes, and after a `kind:
  'gate'` node. Without one, behaviour is unchanged.
- A replan is a patch — `add`, `remove`, `rewire`, `replace`, `split`, `expand` —
  applied through `setSteps()` and all-or-nothing. Untouched nodes keep their live
  definition, so a replan no longer drops tools, HITL, timeouts or `verify` functions
  from steps it did not mean to touch. A completed node cannot be removed by an
  evaluator patch, and only a pending node can be split.
- Every attempt is journaled as `plan:patched { ops, applied, rejected, reason,
  verdict }`; an invalid, cyclic or no-op patch is a warning and the current plan
  continues (a capped attempt is journaled too). `maxPlanReplans` caps applied patches,
  two consecutive no-ops stop the evaluator, and a `done` verdict settles the plan —
  `plan:settled` names the skipped nodes, they stay pending, and `workflow:end` reports
  `planSettled`/`pendingSteps`. An `abort` verdict fails the run loudly.
- The existing whole-list `replan()` response is converted to a patch by diff, so
  nodes the planner re-describes identically keep their fields.
- `usage`, `deltaMessages` and `_sessionGroupKey` are excluded from a step's definition
  fingerprint — re-supplying a node that has already run is not a definition change.

**Discussion — `planForEach` validates its plan before running it (wave 7 / C8 of the agentic debt audit)**

- `planForEach` used to warn on a planned dependency that names no step and carry on,
  so the dependent ran with an `[UNRESOLVED: …]` reference — a second, fail-open DAG
  interpreter. It now validates every agent's plan through the shared `Plan` type plus
  the template-reference check **before any step runs**: duplicate ids, unknown
  dependencies, cycles and unknown `{{step.output}}` references reject that agent's plan
  with a `ConfigurationError`, and in a multi-agent group no agent has run yet when a
  later plan is rejected. Execution stays sequential in dependency order, and a failed
  prerequisite still skips its dependent.

**DAG workflows — a dangling dependency is rejected at plan time (wave 7 / C7 of the agentic debt audit)**

- `setSteps()` (and every replan rewrite) rejects a step whose dependency names no step
  in the plan and no already-completed step, naming the edge (`b→ghost`). Before, the
  plan was accepted and the scheduler failed only after other branches had spent tokens.
  Nothing is installed on rejection, so a bad rewrite leaves the working plan intact.
  The rejection is a `ConfigurationError` thrown from `setSteps()` (previously a
  `GraphError` at run time) and emits `workflow:failed` even outside a run; the runtime
  deadlock check remains as a typed `GraphError` backstop.
- A dependency on a *failed* step is rejected as well — its output is an error string,
  not a prerequisite. The runtime deadlock check remains as a backstop for a checkpoint
  restored without validation.

**Session granularity for DAG workflows (wave 7 / PL2a of the agentic debt audit)**

- **`sessionScope`** picks how steps share a conversation: `'step'` (default — one
  session per step attempt, so retries stay isolated), `'plan'` (one session and one
  cache prefix for the whole plan) or `'branch'` (per branch root). A per-node
  `session: 'inherit' | 'new' | '<group>'` annotation covers everything in between.
- **A shared group is a contract.** It owns one system prompt, one tool set, one model
  and one cache policy; a step that changes any of them opens a boundary group and the
  run emits `workflow:session_boundary` (node + field) instead of corrupting the prefix.
  `sessionSystemPrompt` gives the plan a stable prompt and turns each step's own prompt
  into a `[Step focus]` block.
- **Inheritance is bounded.** A step inherits only its **ancestors** (the same rule as
  intake, so a sibling branch cannot leak), in **plan order** (reproducible under
  `maxConcurrency`), only from **accepted** outputs (a rejected attempt contributes
  nothing), capped by `sessionHistoryMaxChars` (oldest rows dropped, an oversized row
  truncated, both with a visible marker). A step dropped by a replan stops contributing
  rows.
- **`executor.cacheGroups`** reports the distinct conversations a run produced, so "one
  prefix per plan" is measurable. Sessions are not checkpointed; a resume starts fresh
  groups.

**A shared `Plan` with two executor views (wave 7 / PL1 of the agentic debt audit)**

- **`Plan` is one artifact for both executors.** `Plan.fromDag()` normalizes a step
  list into a DAG of intents (`{ id, brief, dependsOn }` + the step payload), with
  fail-closed validation (duplicate ids, unknown/self dependencies, cycles) and a
  JSON round trip.
- **Projections are explicit about what they lose.** `toDag()` is faithful;
  `toStateMachine()` runs a topological chain and reports `join`/`sequence`;
  `Plan.fromStateMachine()` keeps ordering as dependencies and reports `condition`,
  `cycle`, `node-execute`, `early-terminal`, `reentry`, `entry`, `fan-out`,
  `unreachable`, `timeout` and template losses. The two engines' template dialects
  (`{{id.output}}` vs `{{context.id}}`) are translated where unambiguous and reported
  otherwise. `toJSON`/`fromJSON` fail closed on a newer version or a malformed
  document.

**DAG workflows — the checkpoint contract, and retrying a failed checkpoint (wave 7 / C5+C6 of the agentic debt audit)**

- **The checkpoint contract is documented and pinned.** `save()`/`load()` persist
  the objective, context, AgentContext, every step, outputs, replans, pending
  evaluations, token spend and the journal; verification marks, the failure ledger
  and the approval sequence are not persisted (recomputed). Resume is step-granular
  — completed steps are not re-run, an interrupted `running` step re-runs
  (at-least-once), and the restored journal replays recorded tool calls. A plain
  `execute()` on an already-run instance is a fresh run, not a resume.
- **A checkpoint carrying a failed step can now be retried.**
  `executor.retryFailedSteps()` resets the failed steps to `pending`, clears their
  outputs, and leaves completed siblings untouched — instead
  of the load-then-execute path dead-ending on `OrchestrationFailedError`. A failed
  run leaves the instance resumable, so the retry continues the restored run
  instead of restarting it.
- **A dropped verification gate is no longer silent.** Function-valued step fields
  (`verify`, per-step `tools`) cannot be serialized; a resume whose step had one now
  logs `WORKFLOW-RESTORE` and emits `workflow:restore_warning`, and
  `setSteps({ stepsList })` re-attaches the gate while keeping the restored status.
  A live step `AbortSignal` is no longer written into the snapshot (it broke a
  resumed tool call).

**DAG workflows — an unhandled step rejection becomes a step failure (wave 7 / C4 of the agentic debt audit)**

- **A rejection that escapes a step engine is no longer discarded.** The engines
  catch their own errors, so this is a guard rather than an active bug — but if one
  ever threw outside its catch, the node stayed `running` and the scheduler spun.
  The executor now records any unexpected rejection as a step failure, so the run
  names the step and ends. A node its engine already recorded (including a timed-out
  step) is not recorded twice.

**DAG workflows — a step reads only its ancestors (wave 7 / C1 of the agentic debt audit)**

- **A parallel branch can no longer leak into another step's input.** Template
  interpolation (`{{step_id.output}}`) and the intake modes (`intakeMode: 'all' |
  'some'`) were resolved against the *live* completed set, so a retry absorbed
  whatever sibling happened to finish while it was waiting — the same step saw
  different inputs depending on timing. Both are now bounded by the step's
  transitive `dependencies`: a non-ancestor reference renders `[UNRESOLVED: …]`
  with a `workflow:template_warning`, and a non-ancestor `intakeSteps` entry is
  dropped with a visible warning. The default mode (`dependencies`) and the
  evaluator/host-`verify` view are unchanged.

**Agentic spawning — the contract in one place (wave 6 / SP9 of the agentic debt audit)**

- **`docs/SPAWNING.md`** documents the whole delegation contract: the roster and
  what a profile may carry, the delegation envelope (each dimension granted
  independently, the schema derived from it, fail-closed on a forced argument),
  role templates and the per-spawn adaptation, the per-tree budget pool, depth and
  the spawn cap, spawn identity/handles/continuation, opt-in durability, and the
  trust boundary between the host and the model.
- **`examples/26_spawning_contract.mjs`** is the runnable version: offline and
  deterministic, 14 checks covering the schema-vs-envelope rule, the fail-closed
  refusal, the roster-as-menu, depth 1 by default and `maxDepth: 2`, the per-tree
  `maxSpawns` cap, spawn identity, and why a code-agent spawn has no durable
  thread. `createTaskTool` is now exported for hosts that build the tool
  themselves.

**Agentic spawning — opt-in child persistence (wave 6 / SP8 of the agentic debt audit)**

- **A child is durable only when the host asks.** Attach a `SessionStore` to the
  parent and every child it spawns is checkpointed under its own deterministic
  thread, `spawn:<spawn id>` — never the parent's thread, which it would otherwise
  overwrite. The spawn handle exposes `threadId`; `forkSpawn()` branches a child's
  conversation; a fresh session with `withSessionStore({ store, threadId })` plus
  `loadCheckpoint()` resumes it in another process, and `store.list()` reports the
  caller's thread id rather than the sanitized file name. A child that fails still
  saves its last turn; a turn that fails before its first snapshot keeps the stored
  conversation instead of erasing it, and a failed durability write never loses the
  answer (`handle.checkpointError` says why). A code-agent spawn (no conversation) writes
  nothing. The switch is per tree — every descendant persists — and checkpoints
  are not pruned automatically.

**Agentic spawning — the spawn tree is bounded (wave 6 / SP7 of the agentic debt audit)**

- **Depth 2+ is allowed; the tree is what is capped.** `maxDepth` stays 1 by
  default and `withAgentDelegation({ maxDepth: 2 })` lets a child spawn a
  grandchild. Every tree now also has a spawn cap — `maxSpawns`, default **128** —
  enforced on the `task` tool, the MAA planner and direct `runTaskChild` calls
  alike. The counter is a shared object carried by the tree's sessions and records,
  so a grandchild on another transport counts in the same tree and the count
  survives record eviction. A second root keeps its own budget.
- **A code-agent profile counts toward the depth.** An `execute` profile used to
  bypass the depth counter (it builds no child session), so a recursive profile
  recursed past `maxDepth`. The profile now runs inside an async frame at the depth
  its spawn occupies: recursive, sibling and concurrent code spawns each get their
  own frame, the parent session is never mutated, and a background code spawn does
  not hold the parent's depth. A host's own depth-0 direct call still runs under
  `maxDepth: 0`; only nested calls are capped.

**Agentic spawning — role templates (wave 6 / SP6 of the agentic debt audit)**

- **A role template is shared; a spawn adapts it.** A profile's `systemPrompt` is
  the reusable template and a granted per-spawn `system` is now an adaptation
  **appended** after it (it used to replace the template, which threw away the
  house style). On Anthropic with `withPromptCache()` the child's system is emitted
  as a split system: the template as a cacheable block, the adaptation and the
  per-spawn objective as an unmarked block — two spawns share the cached prefix
  byte for byte. `normalizeToAAI` no longer merges system blocks into one string;
  other backends and uncached Anthropic sessions keep the single joined string.
  A child inherits the parent's cache policy through the session policy.

**Agentic spawning — budget (wave 6 / SP4 of the agentic debt audit)**

- **One budget pool per spawn tree.** A session with `withBudget({budget})` owns a
  pool that every spawn shares, so a cap binds the tree rather than each child
  (N children no longer mean N × the cap). `getBudgetPool({session})` reads the cap
  and the tree's spend; each spawn record keeps its own ledger. Only the pool's
  owner can move the cap; a child may set a tighter local budget. A step that
  reports no usage is charged as an estimate, so a silent backend cannot hide
  spend. `BudgetExceededError` now carries `maxBudgetUsd` and `costUsd`, and a
  delegation failure keeps the budget facts (code, usage, cap) on the wrapped
  error.

### Added

**Closeout wave 2 — the ACP terminal bridge**

- **The client bridge exposes ACP's terminal capability.** `createTerminal`,
  `terminalOutput`, `waitForTerminalExit`, `killTerminal` and `releaseTerminal`
  (ACP `terminal/create|output|wait_for_exit|kill|release`) ride the turn-context
  bridge next to `readFile` / `writeFile`, scoped to the ACP session. Every method
  refuses with a named error when the connected client did not announce
  `terminal: true`, so an unadvertised capability is never called. The bridge does
  not add a shell tool: it is the seam a caller's tools use to run a command on
  the editor's side.

### Added

**Production loop (0.8.0 plan)**

- **`SessionStore` contract and `InMemorySessionStore`.** The typedef names what the
  builder, the task tool and the spawn registry call: `save({threadId, data})`, a
  positional `load(threadId)` (kept positional so third-party stores keep working)
  and an optional `fork`. `InMemorySessionStore` implements it over a `Map`, copying
  through JSON like the file store persists; `withSessionStore` accepts any
  `SessionStore`. Saves are last-write-wins. One conformance suite runs against both
  stores.
- **Evals in core.** `runEvals({ cases, makeSession, scorers, concurrency })` runs
  each case on a fresh session and returns `{ results, passRate }`. A run is
  observed — output, tool calls (`tool:call_end`), usage (`run:end`), latency, and a
  thrown error tagged with `classifyFailure` — and scored by every scorer; a case
  passes when all pass. `EVAL_SCORERS`: `outputMatches`, `outputSchema`,
  `toolsCalled`, `toolSequence`, `withinBudget` (expectations read from
  `case.expected`, absent ones skipped) and `judge` (a `createLlmJudge` /
  `createScoredJudge` judge, with a threshold). A throwing scorer fails its case
  instead of the suite. With a cassette, a suite runs offline and deterministically.
- **Record / replay (cassettes).** `createCassette({ path })` and
  `session.withCassette({ cassette, mode })`: `record` runs the real vendor call and
  stores its normalized stream events, keyed by the sha256 of the canonical vendor
  request (data only — a run context and the per-row `merciId` are left out);
  `replay` answers from the recording and never calls the vendor (a miss is a
  non-retryable `ConfigurationError`, an unreadable cassette is refused). Identical
  requests replay in order; only completed streams are recorded. Tools still run on
  replay, at most once through the journal. The journal's canonical serializer moved
  to `support/utils.mjs` (`canonicalJson`), its keys unchanged.
- **Guardrail predicates and tool phases.** A rule may be a predicate
  `test: (text) => boolean | Promise<boolean>` instead of a pattern (a moderation or
  classifier call from user code), and two phases watch tool calls: `tool_input` (the
  arguments, checked as the last `tool:before` hook — a block stops the tool before it
  runs) and `tool_output` (the result, the last `tool:after` hook — a block replaces
  it with a failure the model sees instead). Matches announce the same
  `guardrail:tripped` event, now with `tool`. `both` still means input and output.
  `check` is now async (see MIGRATION).

### Fixed (a stream that never finishes)

- **A structured utility call can no longer wait forever on a stream that never
  ends.** The planner, replanner and evaluator run through `structuredLlmCall`,
  which had no total deadline. A provider stuck repeating itself (every chunk
  arrives, so the stream's inactivity timeout is reset each time) kept such a
  call — and the whole DAG workflow behind it — open indefinitely. Each attempt
  is now bounded by a total deadline (default: the stream-timeout budget), and
  a deadline hit is retried on a fresh session exactly like a parse failure, so
  a single degenerate response is recoverable instead of fatal. The budget is
  overridable per call (`timeoutMs`) and from `WorkflowPlanner` /
  `WorkflowEvaluator` options. Found live: example 16 locked at a planner call
  in ~half of its runs.

### Fixed (0.8.0 review)

From an independent adversarial review of `1b90855..2c33a2b` (21 findings, each
reproduced, each fix pinned by a test that fails without it):

- **`runCommand` decodes through a StringDecoder**: a multibyte character split
  across pipe chunks no longer turns into U+FFFD (shell tool, skills, obscura).
- **The obscura engine takes `inheritEnv` / `env`** (also via the browser config),
  so proxy and TLS variables can reach it under the env allowlist.
- **OTel**: an aborted tool call's span ends with its run; an open run stays a parent
  after the parent index's bound evicts it; an evicted open span is exported
  (UNSET) instead of dropped; a run that threw to its caller (`budget`,
  `max_turns`, …) is an error (`run:end` carries `failed: true`).
- **Cassettes**: concurrent first recordings to one file no longer lose each other
  (one shared load, serialized writes); SDK-minted `call_<uuid>` ids are keyed by
  order, so text-recovered tool calls replay; in record mode the session's
  inactivity timeout watches the vendor's raw chunks again.
- **Evals**: concurrent cases on one client's shared emitter no longer read each
  other's tool calls and usage (each case's session gets an id and its events are
  filtered); an unobserved usage fails a token budget; a `/g` output pattern
  matches on every run.
- **Guardrails**: a session `tool:after` hook returning `STOP` no longer bypasses a
  `tool_output` rule; a `tool:before` value without `args` no longer hides the
  arguments the tool runs with; a truthy predicate result trips the rule.

### Changed

**Production loop (0.8.0 plan) — breaking**

- **A child process no longer inherits the parent's environment.** `runCommand` — the
  one spawn point, now also behind the obscura browser engine — gives a child the MCP
  stdio transport's safe allowlist (`getDefaultEnvironment()`: `HOME`, `LOGNAME`,
  `PATH`, `SHELL`, `TERM`, `USER`) plus an explicit `env`, so a model-chosen command
  never sees an API key. `inheritEnv: true` (on `runCommand`, `createShellTool` and
  `loadSkillsFromDirectory`) restores the old behaviour.
- **OTel spans follow the gen_ai semantic conventions.** The exporter builds a span
  tree instead of one zero-length span per event: `invoke_agent` (run:start →
  run:end), `chat {model}` (a CLIENT span per vendor call, opened at `onRequest` and
  closed at the end of the stream), `execute_tool {name}` (tool:call_start → end),
  parented by span. Attributes `gen_ai.operation.name`, `gen_ai.provider.name`,
  `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`. Every other
  event is a span event on its run's open span; prompt content stays off. To feed the
  chat span, the session now reports a call's end (`onResponse`, `api_response`) when
  the stream ends, with the stream's `usage`, and passes `backend` in `onRequest`.

**Type surface, stage B (1/n) — the public entry stops accepting everything**

- **`initializeClient` returns the concrete client, not an index signature.** The
  four backends share no base class, so the type is their union
  (`MerciClientInstance`); `client.session(model).withSystemMessage(…).step(…)`
  now type-checks and a typo is an error instead of a silent `any`.
- **The fluent builder keeps its type.** 30 `with*`/`approve*` methods returned
  `ChatSessionBuilder`, which erased the concrete session type at the first
  chained call (and hid `step()`); they return `this` now. The JAI and
  `BaseChatSession` overrides follow.
- **`step()`'s event and final-state shapes are named** (`StepEvent`,
  `StepFinalState`) instead of `Object`; `runUsage`-style loose access still works,
  but `event.type` / `event.content` / `event.calls` are typed.
- **`getProfiles()` says what it returns** (`{id, name}[]`), and both
  `getAvailableModels` and `loadCheckpoint` take/return structural shapes instead
  of records of anything.
- **The ratchet went down:** 1249 → **1245** `any` across 100 of 122 declarations;
  `lib/index.d.mts` is at zero and its budget entry is pruned.
- Consumer-visible: a caller that reads a vendor handle (`client.openai`,
  `client.genai`) or assigns one must narrow first — that member was never on all
  four backends, the type just used to hide it.

**Agentic spawning — the client is a transport (wave 6 / SP5 of the agentic debt audit)**

- **The client no longer carries spawn state.** The roster, the backend→client
  map, the resolver, the depth cap, the background counter and map, the delegation
  envelope and the spawn records all live in the spawn registry
  (`getSpawnRegistry({client})`); the circuit-breaker health view moved to a
  module-level `WeakMap` keyed by the client. A frozen client now works. The
  `client._taskAgents` / `_taskClients` / `_taskClientResolver` / `_taskMaxDepth` /
  `_taskCounter` / `_backgroundTasks` / `_agentDelegation` fields are removed: a
  value preset before the first SDK call is adopted once (with a deprecation
  notice) and deleted; a later write is ignored. Spawn ids and background task ids
  now count independently.

### Fixed

**Production-loop fixes (0.7.3 plan)**

- **OTel API spans pair with their own call.** The exporter keys open calls by the
  step's `runId` (FIFO only for a caller with no `runContext`), so an aborted call
  no longer lends its start time and model to the next one, and two sessions on one
  exporter interleave safely. A cancelled call now reports `onResponse({ok: false,
  aborted: true})`; a failed call reports one terminal `onError` carrying `status`
  and `durationMs` (the default observer still emits `api_response` then
  `api_error`); `onError` and `onRetry` carry the step's `runContext`; an `onError`
  with no open call makes no span, unless it names a run whose call already ended: a
  stream that fails after its response gets an `api.stream_error` span. A failed call's
  `onError` precedes the `request:after` chain, as a success's `onResponse` does.
- **ACP sessions are isolated.** `createAcpAgent({createSession})` gives each ACP id
  its own merci session (`{sessionId, cwd, parentSessionId}`; a fork passes its
  source), so concurrent prompts on different ids run in parallel. With a single
  `session`, prompts are queued instead of failing with `CONCURRENT_RUN`. A cancel
  stops the running turn and every turn queued behind it on that id, including one
  whose session the factory is still building; a fork's session is built when the
  fork is answered. A prompt's context and its `onTurnContext` bridge
  (which may now return a cleanup) are scoped to the turn and restored after it.
  The context is read from `_meta.merci`, ACP's extension slot: the ACP SDK strips
  a top-level `_merci`, so it never arrived over a real connection.
- **Argument patterns in permission rules throw.** `Bash(rm:*)` in `allow`/`deny`
  matched nothing — a deny rule that denied nothing. A pattern containing `(` now
  throws `ConfigurationError` from `normalizePermissionRules` (so from
  `withPermissions` and every policy copy).
- **A failed checkpoint read no longer erases the checkpoint.** When a turn had no
  rows to save, `saveCheckpoint` re-read the stored conversation and treated a failed
  read (EACCES, a broken store) as "nothing stored", saving the empty list over it.
  The read error now propagates (the run paths already catch and warn); a missing
  thread still loads as `null` and saves.


**Closeout wave 1 — the security residual, the uncharged attempt, and the ledger seams**

- **A1-F3 — the unpoliced browser read is guarded.** The obscura read leg follows
  redirects and reports no final URL, so a public URL that passed the pre-fetch
  guard could land on a private one. An unpoliced read now uses the curl leg
  (redirects checked hop by hop); obscura is opt-in with
  `allowUnpolicedObscura: true`, and a configured domain policy still selects
  curl. Pinned by `A1-F3: an unpoliced read resolves to curl…` and a deletion
  mutant of the selection.
- **A thrown state-machine node is charged.** `step.mjs` attaches the session's
  usage to the error before rethrowing, and the machine adds it to its token
  counter, so a node that fails after reporting tokens no longer under-counts the
  budget. Pinned by "a state-machine node that throws after reporting usage is
  still charged".
- **B2 (provenance phase 2) — every engine hands the hook registry to its step
  session.** Four per-engine checks pin the `sessionPolicy → _hooks` chain; each
  fails when that engine's policy wiring is deleted (four mutants caught).
- **m11 — the ledger has a public append seam.** `getLedger()` returns a plain
  copy; `appendLedger({ entries })` appends and refuses a malformed row with
  `ConfigurationError` instead of silently dropping it. The `push`-redefining
  copy is gone; 17 seeding call sites migrated.
- **m18 — web preload is configurable.** `withWebSearch` / `withWebScrape` /
  `withBrowser` accept `preload: false`: the tool stays, the per-step orientation
  block is dropped.
- **B2 (journal) — the attempt history has a loud ceiling.** A re-begun key keeps
  a flat attempt history and refuses the 101st attempt with
  `OrchestrationError` (`MAX_JOURNAL_ATTEMPTS`) instead of growing a row without
  limit.

**Provenance phase 4 — the deferred findings (B2, E8, F1, F2, G4, G5)**

- **F1/F2 — one conversation id.** A DAG step session was built with `client.session(model)`, so
  `session:start` announced an auto uuid and the executor adopted the run id afterwards (announced ≠
  in use); the state machine never adopted it at all. Both now create the session with the run id
  (`createSession({sessionId})`), so a `sessionId`-correlating consumer sees one conversation.
- **G4 — no throwaway session per node.** The state machine's ledger path built a real session only to
  read its backend, firing `session:start` twice per node. It reads the client's backend instead (with
  a fallback for stubs that carry none).
- **G5 — the objective restatement names itself.** It opens its own session on the run's emitter; it
  now announces `<runId>:objective` instead of a fresh auto uuid.
- **B2 — a re-begun journal key keeps its history.** `begin()` overwrote the row, destroying the prior
  attempt and its outcome. The row is still the current attempt, but the previous ones now ride in
  `attempts`.
- **E8 — the ACP agent stops advertising a replay it cannot deliver.** `loadSession` is now `false`:
  every id maps onto one `ChatSession` and no per-session history is kept; `session/load` validates the
  id and answers, but cannot replay. Documented in `MIGRATION.md`.
- **F8 — the client-construction model is written down** in `BACKENDS.md`, including the one surprising
  consequence: `opencodeSessionId` is per client, so every child and DAG node of one client shares a
  single remote OpenCode session id.

**Tests — the backoff-abort oracle can no longer pass by racing (provenance phase 3 / H1)**

- `wave2-hardening`'s "an abort during backoff rejects fast" aborted from a 30 ms timer, which raced
  the retry loop: under load the abort landed *before* the sleep was entered, so the test passed even
  with a `sleepAbortable` that ignored the signal. It now aborts from `onRetry` with `jitterMs: 0` — the
  policy jitters by default, so the delay is a random draw and even the repaired test was blind about a
  third of the time — and a second test exercises `sleepAbortable` directly with the abort landing
  mid-sleep.

**Docs — the ACP bridge claimed a `terminal` hook it never exposed (provenance phase 3 / G1)**

- The `createAcpAgent` header listed `terminal` among the client hooks, but the turn context has never
  carried one: `permissions`, `elicit`, `readFile` and `writeFile` are the four that exist. The header
  now says so and marks ACP `terminal/*` as a known gap.
- `docs/BACKENDS.md` still said a step that reports usage and then throws "is charged to neither
  ledger"; the phase-2 fix charges that usage before the retry. The section now describes the real
  contract and what `steps` counts.

**Gates — the coverage gate measures a fixed denominator and the dependency audit has no advisory (provenance phase 3 / F2, F3)**

- `pnpm run check:coverage` measured only the files the suite happened to load, so deleting the
  only test that imports a module removed that module from the report and **raised** the
  percentage. The gate now parses the report's file rows and refuses to pass when any
  `lib/**/*.mjs` file is unmeasured; an empty table (which node prints as `all files | 100.00`)
  is every file missing, not a pass. `--test-coverage-include` is not used: it filters the loaded
  files, so a run with no runtime file loaded passes vacuously.
- The `lib/agentic/webscrape/index.mjs` barrel was imported by nothing, so it was invisible to the
  coverage gate; a test now loads it and pins its re-export list.
- `pnpm run audit:deps` failed: `fast-uri@3.1.8` (4 advisories) and `body-parser@2.3.0` (1) were
  pinned below their patched releases. The overrides now point at `fast-uri@^3.1.9` and
  `body-parser@^2.4.0`; the production tree reports zero advisories.
- `check:examples`, `test:examples` and `check:coverage` are now part of the documented and CI
  gate (they were CI-only or absent from the local list).

**Telemetry — one trace per run, and a delegation links to its parent (provenance phase 2 / B3)**

- The OTLP exporter gave every span a fresh random trace id and never set `parentSpanId`, so one
  run's events arrived at the collector as unrelated traces and a subagent could not be followed
  from its parent. A span now derives its identity from the event's `runId` — one trace per run, one
  span per event — and a run's first span is the parent of its later spans and of any run that names
  it in `parentRunId`. A trace id is the 32 hex characters OTLP allows, an `api.call` span joins the
  run's trace (the exporter reads the RunContext saved at request time), the run index is bounded,
  and an event with no run id keeps the previous unique-trace behaviour.

**Cost — a retried attempt that spent tokens is still charged (provenance phase 2 / B1)**

- A step that reported usage and then threw lost that usage: the per-step usage was folded into the
  run only when the step returned, so a run-level retry chain reported only its last attempt.
  Tokens the vendor had already spent disappeared from `usage`/`cost_usd`, and a retry could walk a
  token or USD budget past its cap. The partial usage now rides the error, is charged before the
  retry, and `RUN_END` reports the accumulated run usage instead of the last attempt's.

**Web scrape — a redirect is checked before it is requested (provenance phase 1 / A1-F1)**

- With no domain policy configured, the curl scrape leg passed `redirect: 'follow'`, so the
  runtime issued the next hop itself: a `302` to `169.254.169.254` reached the metadata endpoint
  as a blind GET before the final-URL check could refuse it. The leg now requests one hop at a time
  (`redirect: 'manual'`) and refuses any hop the SSRF guard or domain policy blocks, capped at five
  hops. A redirect is still followed when no domain policy is configured; with a policy the leg
  keeps refusing redirects outright (`redirect: 'error'`, unchanged), and a chain longer than five
  hops is refused.

**Guardrails — a stateful pattern no longer skips every other check (provenance phase 1 / A3-F1)**

- A guardrail written with a `/g` or `/y` pattern tripped on one call and silently
  passed the next: `RegExp.prototype.test` advances `lastIndex` on a stateful
  pattern, and the same regex object is reused for every check. A stateful pattern
  is now matched with a throwaway copy, so it behaves like any other pattern and the
  caller's regex object is left untouched. Plain patterns take the same path as
  before; a pattern whose source cannot be read (an exotic `RegExp` subclass) falls
  back to a state reset instead of throwing from `check()`.

**Context — a restored chain, an isolated step view, and a window that applies (wave 12 / D7, D6, D2)**

- **A checkpoint restores the delegation chain.** `AgentContext.fromJSON` rebuilt
  only the tail of the context, although the live object — and therefore `parent` —
  is what a checkpoint serializes. It now restores the ancestors recursively, capped
  at 32 nodes, tail included, so a pathological checkpoint cannot exhaust the stack. A
  context with no parent restores exactly as before, and `fromJSON(null)` still returns
  null. The executor (`TaskState`) and state-machine checkpoints now write `parent` too,
  so a resumed workflow keeps the chain, not only a resumed session.
- **A step cannot mutate its siblings' context.** The executor handed the same
  mutable `AgentContext` to every sibling step, so a `refs`/`metadata` mutation in one
  was visible to the others and to the run. Each step now gets
  `AgentContext.snapshot()`: deep-copied `refs`/`metadata`/`objectivePolicy`, `parent`
  pointing at the run context, and the objective fields snapshotted when the step is
  prepared. The objective stays shared: a restatement a step makes inside its session
  is adopted back into the run context (only a newer version wins), so the steps after
  it see it and an older view cannot roll it back. `deepCopyValue` keeps a `Map`/`Set`
  as itself and a function by reference instead of collapsing a mixed payload to `{}`.
- **`transfer`'s window applies in `stringify` mode too.** `renderTransfer` returned
  every unit before the `select`/`tail` window, so
  `{mode:'stringify', select:'tail', tail:1, compact:true}` rendered the whole stream
  and reported `dropped: 0`. The window now runs before the mode branch; a dropped
  unit is summarised into the text when `compact` and a summarizer are configured, and
  otherwise a visible marker says how many were omitted. A summarizer that throws
  degrades to that marker instead of failing the transfer, and the DAG's own
  stringify intake block honours the same window (and marks the drop) — an explicit
  `tail` wins over `handoff.context:'moderated'`'s default of 8.

**Messages — a replay cannot reach a wire, whatever the call order (wave 11 / F7)**

- **Normalizing is replay-safe on its own.** Every normalizer (`normalizeToOAI`,
  `normalizeToAAI`, `normalizeToGAI`, `normalizeHistory`, `formatJaiMessages`) now
  dedupes by row identity *before* it strips `merciId`, which is the boundary where
  that identity leaves. A caller that normalized first and deduped afterwards used to
  find no ids left to compare and silently lost the replay protection. The wire stays
  identity-free: the id is still never sent.

**Agentic spawning (wave 6 of the agentic debt audit — spawning)**

- **A background result reaches the parent's next turn.** It waits in an inbox and is
  placed after the history and before the new prompt; with no history it folds into
  the prompt, so a request never starts with an assistant row. A failed turn keeps
  it, and a parent turn that ended mid tool round no longer drops it: the unanswered
  call is closed with a synthetic result first (wave 11 / N4), so the notification
  never splits a `tool_use`/`tool_result` pair.
- **`isToolResultRow` recognises the Anthropic content-block shape**, so transfer
  grouping and the background tail guard agree on what a tool result is.

**Agentic handoff (wave 5 of the agentic debt audit — handoff honesty)**

- **`handoff.context` delivers what it advertises.** `full` replays every parent unit
  as real rows, `moderated` carries the compacted recent-rows digest, and a replay on
  a different backend degrades to visible digest rows and emits
  `task:fork_degraded` instead of silently dropping the context.
- **The A2A server reads the envelope it is sent.** `metadata.merci` (and the legacy
  `_merci`) is restored as `ctx.agentContext` for the skill; a malformed envelope
  returns JSON-RPC `-32602` instead of rejecting the handler (which killed the stock
  HTTP mount with an unhandled rejection).
- **`handoff.tools` is an authority boundary.** A layered session allowlist composed
  with the inherited permission rules: `'none'`/`[]` deny every tool, an array
  narrows, nested delegation cannot widen it, and a child that cannot enforce it
  fails closed. Capability tools (task, skills, todos, memory) obey it.
- **Documented boundaries.** Conversation rows travel in-process only; across A2A
  the envelope carries objective/directive/refs; a checkpoint restores the
  conversation and AgentContext, not the permission policy.

**Agentic performance (wave 4 of the agentic debt audit — prompt caching)**

- **The cached prefix is stable.** The live-state blocks — the todo list and the
  memory block — no longer change the system row: they ride a **trailing message
  row**, after the breakpoint. A `manage_todos` write used to change the system row
  and invalidate every cache entry — a simulated 0/6 reads, and a real run paid a
  fresh cache write on every iteration. (The final-iteration reminder stays in
  `system`: it is a synthetic nudge, and as a trailing user turn it competes with
  the tool result. The live-state row does follow a tool result — the wire keeps
  `tool_use` → `tool_result` pairing, pinned by `W4/f5-wire`.)
- **The breakpoint is anchored on the prefix, not the tail.** `withPromptCache()`
  enables caching on any session; the Anthropic adapter marks the end of the stable
  block the session computed instead of `messages.slice(-cachePoints)` (the documented
  antipattern: marking the volatile tail costs more than no caching).
- **`promptCache` reaches the engines.** `WorkflowExecutor`, `StateMachine` and a DAG
  step's nested `stateMachine` engine accept `promptCache` (`true`, a count, or
  `{points, type}`) and apply it to the step/node session.
- **Cache level 1 is stable.** The subagent roster in the task tool's description is
  snapshotted per session: a mid-run registration no longer changes the tool
  definitions and the prefix hash from position 0. (Agents registered later are
  visible to the next session.)
- **The counters surface.** A provider-reported `cache_read_input_tokens` /
  `cache_creation_input_tokens` reaches the run usage (`_lastRunUsage`), which it
  already parsed but no agentic path produced.

**Agentic correctness (wave 3 of the agentic debt audit)**

- **A1** — the declared `Step` shape is now the runnable input: `runStep({ step })`
  maps the documented fields (`model`, `systemPrompt`, `userPromptTemplate`, `tools`,
  `handoff`, `messages`, `maxIterations`, `autoExtend`, `errorHandlers`) onto the deps
  bag. Before, 1 of its 16 documented fields was ever read, so a caller who filled the
  published shape got an empty prompt. An explicit `deps` field still wins.
- **A3** — a StateMachine verify retry now carries the answer it is told to revise.
  The failed attempt's transcript is kept for the retry (it is removed from the shared
  context, so no sibling can see it); before, the retry prompt held only the upstream
  context and the feedback, and the model was asked to revise an output it could not
  see.
- **A4** — `verifyFeedback` reaches the model on the explicit-history path too. It was
  applied only when the prompt was built from `userText`.
- **A5** — the handoff is validated once at the step boundary: an invalid
  `handoff.goal`/`context`/`tools` throws a `ConfigurationError` instead of silently
  falling back. The DAG tool list resolves through `resolveHandoffTools`.
- **A6** — `configureSession: false` no longer mutates the caller's session when the
  handoff asks for no tools. The tool-store strip sat outside the flag, so a
  caller-configured child lost the tools it had just been given.
- **A7** — the CLI REPL's exemption from `runStep` is documented at both sites
  (`step.mjs` docblock and the REPL loop): it deliberately drives `stepAgentic` to keep
  one conversational session across turns.

**Agentic correctness (wave 2 of the agentic debt audit)**

- **D1** — a ledger-mode transfer unit now carries the rows its step
  *contributed* (its own turn), not its whole cumulative transcript. A 3-node
  StateMachine chain used to send 7 rows to the last node where 5 suffice, with
  an earlier node's turn replayed twice; a DAG chain with `intakeMode: 'all'`
  had the same duplication. The downstream history still starts with a user row
  and alternates, so the shape stays wire-valid on every backend.
- **A2** — the step transcript has one writer, after the turn: the agentic loop
  commits `_lastStepMessages` from the rows the turn returned. It used to be
  pre-filled *before* the model call, so a backend that honours the documented
  `step()` return contract but never writes that private field made `runStep`
  return the pre-call transcript with the answer missing. `runStep` now also
  clears the field before a run and keeps its documented fallback for sessions
  that bypass the loop.
- **B7** — a DAG step records its own `usage` (summed across attempts) and the
  field rides the checkpoint, so "what did step X cost" is answerable and a
  restored step keeps its per-token cost. Previously only a workflow-wide
  scalar survived.

**Agentic correctness (wave 1 of the agentic debt audit)**

- **C3** — a restored step whose definition changed (its `tools`, `limits`,
  `handoff`, `intake`, `timeout`, `verify`, `errorHandlers` or `autoExtend`)
  now re-runs instead of shipping the pre-edit output. The resume fingerprint
  covers the whole step definition, and function-valued fields are compared by
  their source text. A plan re-supplied from a checkpoint (which cannot carry
  functions) still matches its saved definition, so a durable HITL approval
  survives the restore and the gate is not re-asked. Across a restore, a
  function the plan no longer carries is indistinguishable from a checkpoint
  that dropped it, so the durable approval wins; on a live re-plan the same
  removal is detected and the step is invalidated.
- **C2** — a parallel wave is authorised inside the workflow token cap: the
  remaining cap is split between the steps of the wave. (When the remaining cap
  is smaller than the wave, each step's share floors at one token, so the wave
  can be authorised up to (wave − 1) tokens past the cap — the cap then fails
  closed with `BudgetExceededError`.)
- **B5** — two writers of one memory bank no longer lose each other's facts:
  the read-merge-write runs under an exclusive lock (a sibling `<bank>.lock`
  file holding the owner's pid). A lock whose owner process is gone is
  reclaimed; a live holder is never displaced.
- **G0** — `ExecutionJournal.begin()` protects its own fields: `meta` can no
  longer manufacture a `done` row, re-key the ledger, or inject an outcome.
- **B1** — a journal row whose outcome cannot be serialized now fails closed:
  it is persisted as a failure and replays as a failure, not as a success with
  no result.

### Changed

- `ExecutionJournal` replay is fail-closed: a recorded tool outcome replays as
  a success only when it explicitly says `success: true`. An outcome that is
  missing, `null` or malformed is an unknown result and replays as a failure.

### Deprecated

- **MCP roots and sampling** are deprecated by the MCP `2026-07-28` specification
  (SEP-2577, with Logging, which merci does not implement). The client keeps
  answering them; the earliest removal is the first spec revision released on or
  after 2027-07-28. The docs say so (`docs/BACKENDS.md`, `docs/MIGRATION.md`, the
  skill's protocol reference).

## [0.7.2] - Unreleased

The first release of the SDK that carries a changelog, and the first version
prepared for publication. It is the sum of three waves of work (baseline and
delivery, protocol conformance, agentic capabilities) plus the
developer-experience pass that documents them.

Earlier versions (`7.0.0`, `0.7.0`, `0.7.1`) existed only in the repository's
`package.json`: they were never published and carried no changelog. The history
therefore starts here.

### Added

**Baseline and delivery**

- TypeScript declarations. `pnpm run build:types` emits `.d.mts` files from the
  existing JSDoc, and `package.json` gained `types` plus a `types` condition on
  every `exports` subpath. All nine published subpaths typecheck for a strict
  consumer.
- `package.json` gained `files` (the published-surface allowlist), `sideEffects:
  false`, `repository` / `bugs` / `homepage` and `engines.node >= 22.0.0`.
- `pnpm run audit:deps` — a new gate: the production dependency tree must have
  zero advisories.
- `pnpm run pack:check` — a new gate: the npm tarball must match the published
  surface.
- The CI matrix runs the suite on Node 22 and Node 24, and runs the
  architecture gate over `lib`, `examples` and `apps` (previously `lib` only,
  and not in CI at all).

**Protocol conformance**

- `loadA2ATool` speaks the **A2A v1.0.0** JSON-RPC binding: the proto method
  names (`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`,
  `CancelTask`), the `ROLE_USER` role, the uppercase task states, and
  protobuf-JSON message parts. The dialect is chosen from the agent card; the
  v0.3 slash-name dialect still works.
- `createA2AServer` and `createA2AHttpHandler` (new module
  `lib/tools/a2a-server.mjs`) publish a Merci agent as an A2A v1.0 peer: an
  agent card, the task lifecycle, the whole method set, and the SSE event
  stream.
- The A2A skill selector travels in `params.metadata.skillId`. The server
  resolves the skill from it and strips the selector from the arguments.
- The MCP client declares and answers the `sampling`, `elicitation` and `roots`
  capabilities. Resources and prompts are reachable: `listResources`,
  `readResource`, `listPrompts`, `getPrompt`.
- `createMcpHttpHandler` serves the **Streamable HTTP** transport next to the
  stdio server. A stateless server creates one transport per request, as the
  protocol requires.
- An MCP tool may declare an `outputSchema`; the result is returned as
  `structuredContent` and validated against the schema.
- `createAcpAgent` implements the full **ACP v1** session lifecycle:
  `initialize`, `authenticate`, `session/new`, `session/load`, `session/list`,
  `session/delete`, `session/fork`, `session/prompt` and `session/cancel`.

**Agentic capabilities**

- `withGuardrails({ rules })` — the input/output tripwire. A rule is
  `{ name, phase, pattern, action, message }`; `block` refuses the run with
  `GuardrailViolationError`, `warn` reports the match and continues.
- `withPermissions({ allow, deny, mode })` — allow/deny globs plus the
  `default`, `acceptEdits` and `bypassPermissions` modes.
- `withToolTimeout({ ms })` — a round-wide tool timeout. A tool may override it
  with its own `timeoutMs`.
- A tool may declare an `outputSchema`; a result that violates it fails the
  call.
- `capToolOutputValue` — the tool output cap now bounds objects and arrays, not
  only strings.
- `withTelemetry({ exporter })` and `createOtlpExporter()` — OTLP/HTTP export
  of the session's events and vendor calls. `CompositeApiObserver` runs the
  exporter next to the default observer.
- `run({ initialInput: asyncIterable })` — a streamed input: one user turn per
  chunk, and the conversation accumulates.
- The vendor request keys `serviceTier`, `logprobs`, `logprobsTopK`,
  `previousResponseId`, `store`, `cachedContent`, `cachePoints` and
  `promptCacheKey` in the unified parameter builder.
- `LocalFileSessionStore.fork({ threadId, newThreadId })` — branch a persisted
  thread into a new one.

**Developer experience**

- `CHANGELOG.md` (this file), `docs/MIGRATION.md` (how to move from the
  previous public state) and `docs/BACKENDS.md` (which backend, which engine,
  which protocol).
- The export surface of `docs/api_reference.html` is **generated** from the
  built TypeScript declarations (`node scripts/build-api-reference.mjs`), and a
  drift gate fails when the committed page and the generated block differ.
- `node scripts/check-coverage.mjs` — a coverage ratchet. The gate fails when a
  coverage metric drops below the floor recorded in
  `scripts/coverage.config.json`, when the suite is red, and when the coverage
  report cannot be parsed.
- A tag-driven release workflow (`.github/workflows/release.yml`) that
  **prepares** a release: it resolves the version, verifies it against
  `package.json`, runs the gates, and gates the publish step behind both the
  `NPM_PUBLISH_AUTHORIZED` repository variable and a protected `npm`
  environment with a human approval.

**Examples coverage**

- Three offline examples, each CI-gated and deterministic: the ACP v1 agent
  (`examples/23_acp_agent.mjs`), the control surface — guardrails, permission
  rules, the approval modes, the per-tool timeout, the tool output schema
  (`examples/24_policy_and_tool_safety.mjs`) and the OpenTelemetry export
  (`examples/25_telemetry_export.mjs`).
- Six existing examples now show the wave-1/2/3 surface: the vendor request
  knobs, `stream: false` and the prompt caching (`02_chat`), the streamed input
  and the money budget (`05_agent_loop`), the MCP client capabilities and the
  resources + prompts path (`11_mcp`), the YAML `SKILL.md` frontmatter and the
  multi-script selection (`12_coding_agent`), the session fork
  (`14_durability`) and the A2A task lifecycle (`20_remote_agents`).
- The telemetry wiring on a session — `.withTelemetry({ exporter })` — has an
  example (`25_telemetry_export`).
- `examples/SYMBOL-MAP.md` now maps the **demonstrated** surface, not only the
  imports: the builder methods, the session methods, the parameter-builder
  methods and the methods of the SDK objects an example constructs.
- `pnpm run check:examples` — a new gate: the curated
  "must-be-demonstrated" list (`scripts/example-coverage.config.json`) names the
  public surface that must keep an example, and the gate fails when one of them
  has none. It runs in CI.
- `A2A_COMPLETED_STATES` is exported. It was declared but unreachable, so a
  consumer polling a remote task could not ask which states end it.

### Changed

**Agentic capabilities**

- The vendor-call retry has **one owner**. A session that opens the vendor
  call itself runs it once; an adapter used directly still retries under the
  session's policy. One failure used to cost up to nine calls.
- The `request:after` hook chain now fires. It was declared and never invoked.
  The chain is serial and observational: it sees the request, the round-trip
  duration and the error, but it cannot transform the response.
- The `SKILL.md` frontmatter is parsed as **YAML** (the `yaml` package). A
  frontmatter that YAML rejects but the legacy `key: value` reader understands
  still loads, with a warning. A file neither reader understands is skipped
  with a `skills:load_error` event.
- The citations shape is unified across the Gemini and Anthropic backends:
  `{ type: 'citations', data: { citations: [{ uri, title, text }] } }`. A
  refusal on those backends arrives as a `type: 'error'` event with
  `refusal: true`.
- `withBudget({ budget })` also accepts `maxBudgetUsd`. The money cap is
  enforced only when the backend reports the amount itself; the token cap
  (`maxTotalTokens`) is the budget mechanism and always works. When the
  backend reports no amount, the SDK emits `run:budget_unreported` once, logs a
  warning, and the run continues under the token budget.
- `stream: false` is supported on the OpenAI-compatible backend. The vendor
  call is issued without the `stream` flag and the complete response object is
  mapped onto the same unified events the streaming path produces. It used to
  throw `ConfigurationError`.

**Protocol conformance**

- The A2A event stream carries JSON-RPC responses — `statusUpdate`,
  `artifactUpdate` and `task` — instead of a bespoke flat frame. The client
  still reads the legacy flat frames.
- The MCP client registers its server-callback handlers **before** `connect()`,
  so a server that samples during the handshake is answered.

**Baseline and delivery**

- `engines.node` moved from `>=18.0.0` to `>=22.0.0`.
- The environment file is loaded with `quiet: true`, so the loader's banner no
  longer pollutes a consumer's stdout.
- `previous_response_id` is carried on the Responses API branch only; the
  chat-completions endpoint answers 400 on an unknown parameter.
- `service_tier` reaches the Anthropic wire.
- Asking for `top_logprobs` now implies `logprobs`, and `logprobs: true` on
  the Responses branch is sent as
  `include: ['message.output_text.logprobs']`.

**Developer experience**

- `run({ initialInput })` now accepts an **async iterable** in its published
  type. The implementation has streamed the input since the agentic-capability
  wave, but the declaration said `string | Array<Object>`, so the streaming
  input mode was unusable from TypeScript.

### Deprecated

- The positional `ChatSession` constructor form — pass one options object
  instead.
- The MCP client's SSE transport — deprecated by the MCP specification. Use
  stdio or Streamable HTTP.
- `AcpCapability` — the wrong role for ACP. ACP is an editor↔agent protocol
  whose agent side is `createAcpAgent`; the class remains as a generic
  `{ listTools, callTool }` tool adapter and will be removed in a future major.

### Removed

**Agentic capabilities**

- The static price table: `MODEL_PRICING`, `PRICING_SNAPSHOT_DATE`,
  `PRICING_CURRENCY`, `estimateCostUsd`, `resolveModelPricing`,
  `mergePricingTable` and `withPricing({ table })`. A dated snapshot of public
  list prices drifts, and a budget priced from it silently under- or
  over-states itself. The SDK no longer prices a model: it never guesses a
  price and never reports `0` for money that was spent.
- The `cost_usd_breakdown` field of the run's usage snapshot. The snapshot
  keeps `cost_usd`, and it is now the amount the backend reported.

**Baseline and delivery**

- The `bin` field and `bin/greet.mjs` — the package installed a demo binary
  into every consumer's `node_modules/.bin`.
- The broken `verify:s14` script.

### Fixed

**Packaging and gates (wave 5)**

- The published declarations no longer import a vendor SDK's types. The MCP
  client exposed the SDK's `Client` alias, which forced the SDK's `.d.ts`
  (and its DOM globals) into every consumer's compile; a Node consumer on
  `lib: ["ES2023"]` with `skipLibCheck: false` failed on `HeadersInit`. The
  alias is now a structural type, and a consumer compile test pins it.
- The architecture gate scans `scripts/` as well as `lib/`, `examples/` and
  `apps/`; the 29 pre-existing R1 violations in the scripts are fixed.
- The docs gate pins the prose event count to the `EVENTS` registry (D7). The
  README claimed 236 events while the registry had 249.
- `STRUCTURE.md` was stale at the previous commit; it is regenerated. The
  structure generator now reads a `@typedef` that spans lines (a structural
  type), instead of losing the typedef row.
- A skill's `parameters` must be a mapping. A YAML list was ignored, and a
  JSON-string list (or scalar) was accepted as the schema; both are now
  rejected with a warning, and the empty schema is advertised instead.

**Baseline and delivery**

- A test fixture asserted on a global `ps -axo | grep "[s]leep 30"` count while
  another test concurrently spawned a process whose command line contained the
  same string. The assertion is now scoped to a per-test marker, so the suite
  is stable under the parallel test runner.
- The dependency tree carried advisories, including a critical one. The
  production tree is now clean.

**Protocol conformance**

- The MCP client registered handlers for capabilities it had not declared, so
  every `McpClient.start()` without callbacks threw.
- `loadMcpTools` lost the transport teardown on a failed load. The teardown is
  restored.
- A stateless MCP transport was reused across requests.
- The A2A endpoint guard ran at call time, so a cross-origin endpoint produced
  tools that always failed. It now runs at load time and yields no tools.
- The A2A client could not select which remote skill runs — every call hit
  `skills[0]`.
- `cancelA2ATask` ignored the card's dialect.
- The ACP agent ignored the capabilities the client announced at `initialize`;
  `readFile` and `writeFile` now refuse when the client did not offer them.

**Agentic capabilities**

- `permissionAllowed` failed open: an option id the agent never offered was
  answered with "allowed". An unknown option id and an empty option list now
  deny.
- The input guardrail inspected only the last user turn, so a secret in an
  earlier turn reached the model unchecked. Every user turn is checked.
- A frontmatter value containing a colon was silently dropped.
- The tool output cap did not bound the key length, so a long key was a payload
  too. The keys now count against the budget.
- The `bypassPermissions` warning was documented but never emitted. The mode
  now announces itself as an event and logs.
- The citations never reached the run stream: the adapters emitted a
  `citations` event that the step's event switch had no case for.
- The streamed input dropped the agent's own turns, so the model never saw its
  previous answer.

**Examples coverage**

- The skills loader accepted the frontmatter's `parameters` only as a JSON
  **string**, so a schema written as a YAML mapping — the natural spelling,
  since the frontmatter is YAML — was dropped and the skill was advertised with
  an **empty schema**, leaving the model with no idea which arguments the
  skill takes. Both spellings are accepted now.
- The ACP bridge sent `elicitation/create` without a mode or a scope, so a
  strict client rejected the request with `-32602` and the editor never saw the
  question. The request is a spec-clean form-mode request tied to the session
  now.
- The bridge called the elicitation on clients that never announced the
  capability. A capability the client did not announce is never called now, the
  way the `fs` methods were already gated.
- The per-tool timeout timer was `unref`ed, so with the hanging tool as the
  only pending work the event loop emptied and node killed the run with exit 13
  before the timeout could report. The timer keeps the process alive while the
  tool is pending and is released when the round is aborted.

### Security

- The production dependency tree has zero advisories, including the MCP
  credential-disclosure advisory.
- The A2A endpoint is pinned to the agent card's origin, and redirects are
  refused.
- An MCP request handler may only be registered for a capability the client
  declared.
- A permission decision for an option id the agent never offered denies — the
  decision fails closed.
- The guardrail tripwire watches what enters and what leaves the model.
- A skill that carries scripts is approval-gated by default; the flag that
  disables the gate lives on the caller, never in the frontmatter.
- The tool output cap bounds a result of any shape, so a runaway tool cannot
  push an unbounded payload into the model's context.

[Unreleased]: https://github.com/merci-kit/merci-sdk/compare/v0.25.0...HEAD
[0.25.0]: https://github.com/merci-kit/merci-sdk/releases/tag/v0.25.0
[0.24.0]: https://github.com/merci-kit/merci-sdk/releases/tag/v0.24.0
[0.23.2]: https://github.com/merci-kit/merci-sdk/releases/tag/v0.23.2
[0.23.1]: https://github.com/merci-kit/merci-sdk/releases/tag/v0.23.1
[0.23.0]: https://github.com/merci-kit/merci-sdk/releases/tag/v0.23.0
[0.12.0]: https://github.com/mobeetle/merci-sdk/releases/tag/v0.12.0
[0.11.0]: https://github.com/mobeetle/merci-sdk/releases/tag/v0.11.0
[0.10.0]: https://github.com/mobeetle/merci-sdk/releases/tag/v0.10.0
[0.9.0]: https://github.com/mobeetle/merci-sdk/releases/tag/v0.9.0
[0.8.0]: https://github.com/mobeetle/merci-sdk/releases/tag/v0.8.0
[0.7.2]: https://github.com/mobeetle/merci-sdk/releases/tag/v0.7.2
