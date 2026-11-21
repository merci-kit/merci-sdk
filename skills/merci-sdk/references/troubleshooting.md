# Troubleshooting

Read the typed error first — it names the fix. The family
(`lib/core/errors.mjs`): `MerciError`, `BackendError`, `ConfigurationError`,
`MemoryError`, `AbortedError`, `BudgetExceededError`, `MaxTurnsExceededError`,
`OrchestrationError`, `OrchestrationExhaustedError`, `OrchestrationFailedError`,
`GraphError`, `VerificationError`, `GuardrailViolationError`
(`isAbortError`, `wrapError` helpers).

## Startup (`ConfigurationError`)

| Symptom | Cause → fix |
| --- | --- |
| `No provider selected. Set PROVIDER in secret.env (BACKEND was renamed to PROVIDER in 0.20).` | `PROVIDER` missing/empty → set it (`openai`, `anthropic`, `google_genai`, `vertex`, `openrouter`, `opencode`, `local`). |
| `Unknown provider: "X"` | typo or unsupported value → use a `ProviderType` value. |
| `Unsupported provider: X` | `initializeClient` got a value no client implements → same fix. |
| Missing-token error per provider | `loadCredentials({ provider })` found nothing → check `secret.env` names (see `providers.md`). |
| Cross-provider delegation throws | a profile names a `provider` with no registered transport → register via `withTaskAgents({ options: { clients, resolveClient } })` or pass an explicit `client`. Failing loudly is the design. |

## Plans (`ConfigurationError` at install, `GraphError` at runtime)

- `setSteps()` rejects (nothing is installed, the working plan survives):
  duplicate ids, a dependency naming no step, a self-dependency, a cycle, or
  a `{{step.output}}` ref to a non-ancestor. Name the edge, fix the plan.
- A `GraphError` mid-run is the deadlock backstop for plans that skipped
  validation (e.g. restored without re-validation) — re-supply through
  `setSteps()`.
- `[UNRESOLVED: ...]` in an output means a template ref escaped validation —
  treat as a plan bug, not filler text.
- A restored checkpoint whose step redefined tools/limits/handoff/intake/
  `verify` re-runs that step by design (definition fingerprint changed). A
  durable HITL approval still survives — the gate is not re-asked.
- Load-then-`execute()` on a checkpoint with a failed step dead-ends with
  `OrchestrationFailedError` — that path is a fresh run. Call
  `retryFailedSteps()` to continue the restored run instead.
- `workflow:restore_warning` (+ `WORKFLOW-RESTORE` log) means a resumed step
  lost a function field (`verify`, per-step tools): re-attach it with
  `setSteps()`.

## Runs

- `BudgetExceededError` carries `maxBudgetUsd` and `costUsd` — read both
  before raising the cap. If money was the surprise, check for
  `run:budget_unreported`: without provider-reported cost only the token cap
  binds.
- `VerificationError` surfaces only after the bounded corrective-retry loop
  is exhausted — fix the producer (schema or prompt), not the retry count.
- `GuardrailViolationError` is a `block` tripwire firing — change the input
  or the rule, not the phase wiring.
- Cancels: expect `AbortedError` (test with `isAbortError`); an abort during
  backoff rejects fast, it does not hang the sleep.
- `getLedger()` returns a plain copy — mutating it does nothing. Append with
  `appendLedger({ entries })`, which refuses malformed rows loudly.
- `task:fork_degraded` means a cross-provider `fork`/`full` handoff arrived
  as digest rows — expected degradation, not data loss.
- `stream: false` is supported (full response mapped onto the same unified
  events) — do not work around it.
- `require()` of the package needs Node 22.12+; plain `import` works on any
  Node 22+. Mixed `import`/`require` dual-package setups are not supported —
  stay ESM.
- A `SKILLS`-prefixed warning about frontmatter means a `SKILL.md` is not
  valid YAML — fix the frontmatter (legacy `key: value` still loads, once,
  with a warning).
