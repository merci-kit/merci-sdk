# Safety

Defaults are deny-first. Loosen a guard only for a stated reason, and say
which one. Runnable proof: `examples/06_approvals_and_safety.mjs`
(guardrails, permissions, approval modes, per-tool timeout, output schema),
`examples/14_coding_agent.mjs` (shell gate), `examples/22_telemetry.mjs`
(export + redaction).

## Tool permissions

`withPermissions({ allow, deny, mode })`:

- `allow`: tool names or globs (`read_*`). Names only: an argument pattern
  such as `Bash(rm:*)` throws `ConfigurationError`. Empty = no restriction;
  non-empty = only matches reach the model.
- `deny`: never exposed. Deny always wins over allow.
- `mode`: `default` asks on every gated tool; `acceptEdits` auto-approves
  edit-like tools; `bypassPermissions` approves everything — an explicit,
  dangerous opt-in (it warns and emits when used).

`handoff.tools` on delegated children is an authority boundary, not a hint:
`'none'`/`[]` denies everything, an array narrows, nested delegation cannot
widen it, and a child that cannot enforce it fails closed.

## Guardrails (tripwire)

`withGuardrails({ rules })`, rule = `{ name, phase, pattern | test, action, message }`.
`phase` is `'input'`, `'output'`, `'both'` (input and output), `'tool_input'`
(a tool's arguments) or `'tool_output'` (its result); `pattern` a RegExp or
case-insensitive substring, or `test: (text) => boolean | Promise<boolean>`
(a moderation call). `action: 'block'` (default) refuses the run with
`GuardrailViolationError` — on a tool phase it stops the tool, or withholds
its result from the model; `'warn'` reports and continues. `tool_output`
judges what a tool returns; a tool that throws reaches the model with its
error message unchecked.

## Human approval

Gated tools (`requiresApproval`) pause for a human via
`withApproval({ fn })`. Durable plan/execute approval gates
(`approvePlanExit`, `AGENT_PLAN` / `AGENT_EXECUTE`) survive checkpoints —
the gate is not re-asked after a restore. `bypassPermissions` is never the
answer to "the gate fires too often": narrow the tool set instead.

## Budgets that mean something

- `withBudget({ budget: { maxTotalTokens } })` — the cap that always works.
  A step that reports no usage is charged an estimate, so silent providers
  cannot hide spend; a thrown attempt's reported usage is still charged.
- `withBudget({ budget: { maxBudgetUsd } })` — enforced only when the
  provider reports an amount (`usage.cost` on a gateway). Otherwise the run
  emits `run:budget_unreported` once and continues on the token cap. The SDK
  never prices models itself — there is no price table to consult.
- `BudgetExceededError` carries `maxBudgetUsd` and `costUsd`. One pool per
  spawn tree: children share the cap, they do not each get one.

## Tool-call integrity

- Every tool accepts `timeoutMs` (or `withToolTimeout({ ms })` for the
  round) — one hanging tool never stalls a turn.
- A tool may declare `outputSchema`; a violating result fails the call.
- Oversized results are capped (`capToolOutput` / `capToolOutputValue`),
  for objects and arrays — not just strings.
- Side effects replay through the `ExecutionJournal` (at-most-once): a
  recorded outcome replays instead of re-executing, and a missing/malformed
  outcome replays as failure, never as silent success.

## Shell, browser, web

- Shell runs behind a Safe / Blocked / HITL gate with secret redaction.
- A child process (shell, skill script, browser binary, `rg`) gets only the
  safe env allowlist (`PATH`, `HOME`, …); `runCommand` and the browser config
  also take an explicit `env` (e.g. `HTTPS_PROXY`). `inheritEnv: true` (shell
  tool, skills, `runCommand`, browser) passes the whole parent environment,
  API keys included.
  Blocked stays blocked; HITL stays human.
- `withBrowser()`: an unpoliced read uses the curl leg (redirects checked
  hop by hop, max five hops); the obscura engine is opt-in
  (`allowUnpolicedObscura: true`). A configured domain policy selects curl
  and refuses redirects outright.
- `withWebSearch` / `withWebScrape` / `withBrowser` accept
  `preload: false`: keeps the tool, drops the per-step orientation block.
- Telemetry export (`createOtlpExporter`) redacts credentials before
  shipping spans. Spans follow the OpenTelemetry gen_ai conventions:
  `invoke_agent` per run, `chat {model}` per vendor call (closed at stream
  end, with `gen_ai.usage.*`), `execute_tool {name}` per tool call; other
  events are span events. Message bodies, tool arguments and results and file
  contents (the exporter's redacted keys) never become attributes; other
  scalar fields, such as a search `query` or a scraped `url`, are exported,
  capped at 256 characters.
