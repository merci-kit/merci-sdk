---
name: merci-sdk
description: Build AI agents with the Merci SDK npm package — multi-provider chat sessions (OpenAI, Anthropic, Google, OpenRouter, OpenCode, local), streaming tool loop, DAG workflows, state machines, subagent delegation, MCP/A2A/ACP protocols, memory, and policy guardrails. Use when the user asks to use, integrate, install, or write code with merci-sdk.
version: 0.24.0
---

# Merci SDK

Consumer skill for the `merci-sdk` npm package (ESM only, Node.js >= 22).
This skill is about building *with* the SDK. Contributing *to* the SDK
repository follows that repo's own `AGENTS.md` — not this skill.

## Setup

```bash
pnpm add merci-sdk
# or: npm install merci-sdk
```

`import` works on Node 22+. `require()` needs Node 22.12+.

## The core loop (learn this first)

```js
import { createUserMessage, initializeClient, loadCredentials, resolveProvider } from 'merci-sdk';

const provider = resolveProvider(); // reads PROVIDER from secret.env
const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });

const session = client.session('gpt-4o').withSystemMessage('You are terse.');
const stream = session.step({ messages: [createUserMessage({ provider, content: 'Hello!' })] });

for await (const event of stream) {
    if (event.type === 'text') process.stdout.write(event.content);
}
```

Credentials live in `secret.env` (`PROVIDER=openai` plus the provider key,
e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`JAI_TOKEN`). Never hardcode keys. Details: `references/providers.md`.

The four `oai` providers (`openai`, `openrouter`, `opencode`, `local`) run on
the SDK's built-in `fetch` connector — no vendor SDK is required.
`client.transport` is that connector, configured with `transportOptions`
(`fetch`, `defaultHeaders`, `timeout`, `maxRetries`).

## Five rules that prevent most mistakes

1. **Messages are provider-keyed.** Factories take `{ provider, ... }`
   (`createUserMessage`, `createSystemMessage`, ...). History is normalized
   per wire (`normalizeHistory`); never hand-shape vendor rows.
2. **History is yours (stateless resend).** The app owns the message array.
   Every `step()` returns immutable rows (`finalState.messages`) — carry them
   into the next turn. No server-side conversation to rely on.
3. **Two model tiers.** Orchestrators and judges run on the default model;
   cheap subagents run on the tool model. Resolve both per provider, never
   hardcode ids. See `references/providers.md`.
4. **Named args + fluent builders.** SDK functions take a single
   destructured object (`{ ... } = {}`) — except a few fluent value-setters
   such as `withSystemMessage(content)`. Session configuration chains
   (`client.session(model).withX(...).withY(...)`) and each `with*` returns
   the session. Terminal calls are `step()` / `run()`.
5. **Events come from the registry.** Listen via `EVENTS.*`, never bare
   string literals. Observe runs with `attachEventLogger` or export with
   `createOtlpExporter()` + `CompositeApiObserver`.

## Which engine? (details: `references/orchestration.md`)

| Task | Engine | Runnable proof |
| --- | --- | --- |
| One turn, tools, follow-ups, budgets | agentic loop: `session.step()` / `runStep({ step })` | `examples/07_agent_loop.mjs` |
| Multi-step plan with dependencies | DAG: `WorkflowExecutor` (`merci-sdk/planning`) | `examples/17_dag_workflow.mjs` |
| Gated progression with verify/fix retries | `StateMachine` | `examples/18_state_machine.mjs` |
| Group decision (debate, then judge) | `DiscussionSession` | `examples/19_discussion.mjs` |
| Delegate to a named subagent | `withTaskAgents` / `withAgentDelegation` (`task` tool) | `examples/15_delegation.mjs` |
| Durable approve-then-run | plan/execute stages (`AGENT_PLAN`, `AGENT_EXECUTE`) | `examples/16_plan_and_execute.mjs` |
| Talk to the outside world | MCP / A2A / ACP | `references/protocols.md` |

Template refs (`{{step_id.output}}`) must name the step's own transitive
dependencies — a sibling/descendant/self reference is a plan-time error.
Cross-step context uses the opt-in `transfer` policy (`stringify` default,
`ledger*` presets for real rows), never ad-hoc concatenation.

## Safety baseline (details: `references/safety.md`)

- `withPermissions({ allow, deny, mode })` decides which tools the model may
  call. Nested delegation can narrow it, never widen it.
- `withGuardrails({ rules })` is the input/output tripwire (`block` refuses
  with `GuardrailViolationError`, `warn` continues).
- Budgets: `withBudget` token cap (`maxTotalTokens`) always works; the money
  cap (`maxBudgetUsd`) is enforced only when the provider reports an amount —
  the SDK never estimates prices.
- Tool calls are journaled (`ExecutionJournal`, at-most-once replay) and
  every tool accepts `timeoutMs`. Approval-gated tools pause for a human via
  `withApproval({ fn })` and the gate survives checkpoints.
- Shell, browser and web tools are sandboxed/SSRF-guarded by default; do not
  disable the guards to "make it work" (see `references/safety.md` first).
- On failure, read the typed error (`ConfigurationError`,
  `BudgetExceededError`, `VerificationError`, ...) — see
  `references/troubleshooting.md`. Use `isAbortError` for cancels.

## References

- `references/providers.md` — the 8 providers across 4 standards, credentials,
  model tiers, subpath imports, protocols vs providers.
- `references/orchestration.md` — loop, DAG, state machine, discussion,
  spawning, memory, checkpoints, transfer/handoff.
- `references/protocols.md` — MCP client/server, A2A v1.0, ACP v1.
- `references/safety.md` — permissions, guardrails, budgets, journal,
  sandboxing, network guards.
- `references/troubleshooting.md` — error taxonomy and common fixes.

Example files cited as `examples/<name>.mjs` live in the SDK repository
(`github.com/merci-kit/merci-sdk`), not in the npm tarball.
