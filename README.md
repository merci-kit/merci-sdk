<p align="center">
  <img src="https://raw.githubusercontent.com/merci-kit/merci-sdk/main/docs/merci-sdk-logo.png" alt="Merci SDK" width="140">
</p>

# Merci SDK

[![npm version](https://img.shields.io/npm/v/merci-sdk.svg?color=brightgreen)](https://www.npmjs.com/package/merci-sdk)

**Agentic SDK for OpenAI, Gemini and Anthropic compatible endpoints.**

Merci is a TypeScript/JavaScript SDK for building agents on OpenAI, Gemini, Anthropic
and any OpenAI-compatible endpoint (OpenRouter, OpenCode, local servers). It ships the
agent runtime: MCP / A2A / ACP, durable human-in-the-loop gates, an
execution journal, DAG planning, state machines, multi-agent discussion, memory, and a
302-event observability spine — with zero runtime orchestration dependencies.

Three API standards (`oai`, `aai`, `gai`) cover seven providers:
`openai`, `openrouter`, `opencode`, `local`, `anthropic`, `google_genai`,
`vertex`.

```bash
npm install merci-sdk
# or
pnpm add merci-sdk
```

ESM only: `import` works on Node 22.13+, `require()` needs Node 22.13+.

---

## Quickstart

```bash
# from an installed package (in a repo checkout: cp secret.env.example secret.env)
cp node_modules/merci-sdk/secret.env.example secret.env
```

```js
import {
    createUserMessage,
    getDefaultModel,
    initializeClient,
    loadCredentials,
    resolveProvider,
} from 'merci-sdk';

// PROVIDER comes from secret.env; the model comes from that provider's descriptor.
const provider = resolveProvider();
const model = getDefaultModel({ provider });
const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });

const session = client.session(model).withSystemMessage('You are terse.');
const stream = session.step({ messages: [createUserMessage({ provider, content: 'Hello!' })] });

for await (const event of stream) {
    if (event.type === 'text') process.stdout.write(String(event.content ?? ''));
}
```

Switch backends by editing `PROVIDER` alone: the session keeps the same code and
`getDefaultModel` resolves that provider's brain tier (`getToolModel` is the
cheap leaf tier for tool sessions). No model name is hardcoded.

`secret.env` is read from `MERCI_ENV_FILE` if set, else from `./secret.env`
in the directory you start the process in, else from the package's own checkout.

Run the full catalogue of **32 live showcases** in `examples/` — from the quickstart above
to subagents, DAG workflows, state machines, MCP, A2A, knowledge graphs and the
unattended coordination layer. Every showcase runs a real model; offline proofs live
under `test/examples/`.

---

## What is in the box

| Area | Capability |
| --- | --- |
| **Providers** | Three standards (`oai`, `aai`, `gai`) over seven providers: OpenAI (Chat Completions **and** Responses), Anthropic Messages, Google GenAI / Vertex, OpenRouter, OpenCode, any local OpenAI-compatible server |
| **Agent runtime** | Tool loop with per-step budgets and compaction, hedging, fallback-model ladder, per-agent transport routing, streaming events |
| **Orchestration** | DAG planner + executor + evaluator (with replan), `StateMachine`, multi-agent `DiscussionSession`, plan/execute stages, subagent delegation |
| **Control** | Durable HITL approval gates (persisted in the checkpoint), tool allow/deny tiers, execution journal with at-most-once side effects, shell sandboxing by default |
| **Protocols** | MCP client **and** server, A2A client, ACP agent, skills (`SKILL.md`), session store, memory banks with optional embeddings |
| **Knowledge** | One typed graph (`merci.knowledge/v1`) with an open relation set, a validator, budgeted subgraph retrieval, and a generated wiki view — attached with `withKnowledge()`, seeded read-only from document, wiki-corpus, memory, todo and plan surfaces (`seed`), rendered as a budgeted prompt block, and cached per corpus by `syncCorpus()` with a source manifest for delta rebuilds |
| **Observability** | 302 typed events, hierarchical run context, hooks, lifecycle phases, event logger, pluggable API observer |
| **Coordination** | A repo-owned `WORKFLOW.md` contract, per-item directory/worktree isolation, a work-item scheduler with claims, retries, parking and budgets, and a read-only operator API — bound by `createOrchestration`, or used as four separate subpaths |
| **Agent files** | `*.agent.yaml` definitions loaded by `merci-sdk/agents`: one frozen spec, catalog groups and `native:`/`host:`/`skill:`/`script:`/`mcp:`/`acp:`/`a2a:` selectors, contained script tools, and one resolved toolset for both a runnable session and a subagent profile |

---

## Documentation

| Where | What |
| --- | --- |
| [`docs/README.md`](https://github.com/merci-kit/merci-sdk/blob/main/docs/README.md) | Documentation index and feature tour |
| [`docs/getting_started.html`](https://merci-kit.github.io/merci-sdk/getting_started.html) | Browser guide |
| [`docs/lessons/`](https://merci-kit.github.io/merci-sdk/tutorials.html) | 42 self-contained lessons |
| [`docs/api_reference.html`](https://merci-kit.github.io/merci-sdk/api_reference.html) | API reference |
| [`docs/ORCHESTRATION.md`](https://github.com/merci-kit/merci-sdk/blob/main/docs/ORCHESTRATION.md) | The coordination layer: one `createOrchestration` call, the five seams, the lifecycle, and the operator view |
| [`docs/WORKSPACES.md`](https://github.com/merci-kit/merci-sdk/blob/main/docs/WORKSPACES.md) | Per-item workspace isolation: strategies, lifecycle, hooks, artifacts |
| [`docs/SCHEDULER.md`](https://github.com/merci-kit/merci-sdk/blob/main/docs/SCHEDULER.md) | The work-item scheduler: tick, claims, retries, parking, workspaces, budgets, events |
| [`docs/WORKFLOW_POLICY.md`](https://github.com/merci-kit/merci-sdk/blob/main/docs/WORKFLOW_POLICY.md) | `WORKFLOW.md`: the repo-owned prompt and runtime contract, strict rendering, live reload, last-known-good |
| [`docs/OPERATOR_API.md`](https://github.com/merci-kit/merci-sdk/blob/main/docs/OPERATOR_API.md) | The operator API: state, item detail, refresh, the status page, and the event ring |
| [`docs/CONTRIBUTING.md`](https://github.com/merci-kit/merci-sdk/blob/main/docs/CONTRIBUTING.md) | Contribution guide |
| [`STRUCTURE.md`](https://github.com/merci-kit/merci-sdk/blob/main/STRUCTURE.md) | Generated module/symbol map |
| [`examples/23_evals.mjs`](https://github.com/merci-kit/merci-sdk/blob/main/examples/23_evals.mjs) | Testing & evals: `runEvals`, scorers, a recorded cassette, and the failure taxonomy |

---

## Development

```bash
pnpm install
pnpm typecheck        # tsc --noEmit
pnpm test             # the offline test suite
pnpm run check:examples   # the curated capability list still has an example
pnpm run test:examples    # the deterministic example audits run end-to-end
pnpm run check:coverage   # the coverage ratchet
pnpm run audit:deps   # production dependency advisories must be zero
pnpm run pack:check   # npm tarball contents must match the published surface
```

`pnpm typecheck` builds the declarations first (`build:types`). `types` resolves
into `dist/`, which is gitignored, so a consumer tracking this repository — or a
`file:`/symlinked install — must run `pnpm run build:types` once before its own
typecheck sees the SDK.

Conventions for generated and contributed code live in
[`GUIDELINES.md`](https://github.com/merci-kit/merci-sdk/blob/main/GUIDELINES.md)
(architecture rules), enforced by `node scripts/check-guidelines.mjs`.

---

## License and commercial services

The TypeScript/JavaScript SDK in this repository is released under
[Apache-2.0](https://github.com/merci-kit/merci-sdk/blob/main/LICENSE). The
**Merci SDK** name and logo are trademarks of Lukáš Michna (Mobeetle); see
[`TRADEMARK.md`](https://github.com/merci-kit/merci-sdk/blob/main/TRADEMARK.md).

A **Rust implementation** of the SDK is available separately under a
**commercial license**. **Support, development and professional services** for
Merci SDK are available as **paid engagements** — contact
[Lukáš Michna (Mobeetle)](https://github.com/mobeetle) to discuss scope.
