# Which provider, which engine, which protocol

A decision guide. The SDK speaks three wire standards (`oai`, `aai`, `gai`)
through seven providers, runs four execution engines, and ships three
protocol clients. This page says which one to reach for and when not to.

- [Part 1 — which provider?](#part-1--which-provider)
- [Part 2 — which engine?](#part-2--which-engine)
- [Part 3 — the protocol layer](#part-3--the-protocol-layer)
- [Part 4 — the combination rules](#part-4--the-combination-rules)

The per-capability provider table is generated from the live code:
[`docs/capability_matrix.html`](capability_matrix.html). The full export
surface is in [`docs/api_reference.html`](api_reference.html).

## Part 1 — which provider?

Two axes decide a call. The **standard** is the wire contract — the request and
response shape a client module speaks. The **provider** is the endpoint, the
credentials and the model catalogue. Seven providers share the three standards,
so two providers on one standard differ in tier and capability, not in wire
shape.

### The two axes

| Standard | `openai` | `openrouter` | `opencode` | `local` | `anthropic` | `google_genai` | `vertex` |
|---|---|---|---|---|---|---|---|
| `oai` — chat completions / Responses | ● | ● | ● | ● | | | |
| `aai` — Messages | | | | | ● | | |
| `gai` — `generateContent` | | | | | | ● | ● |

| Standard | Client module | Session protocols |
|---|---|---|
| `oai` | `lib/backends/oai.mjs`, `lib/backends/adapters/oai-adapter.mjs` | `completions` (chat completions, the default) or `responses` (the Responses API); `local` is `completions` only |
| `aai` | `lib/backends/aai.mjs`, `lib/backends/adapters/aai-adapter.mjs` | `messages` |
| `gai` | `lib/backends/gai.mjs`, `lib/backends/adapters/gai-adapter.mjs` | `generateContent` |

Each provider has one descriptor in `lib/core/constants/providers.mjs`: its
standard, its protocol list, its default base URL and URL env key, its
credential env keys, its model-tier env keys and its capability flags.
`PROVIDERS` is that registry; `STANDARDS` is the protocol superset per standard.
`initializeClient` chooses the client module from the standard and reads the
rest from the descriptor.

Five providers take their endpoint from a URL env key as well as from the
option:

| Provider | URL env key | Default |
|---|---|---|
| `openai` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `anthropic` | `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` |
| `openrouter` | `OPENROUTER_URL` | `https://openrouter.ai/api/v1` |
| `local` | `LM_STUDIO_URL` | `http://localhost:1234/v1` |
| `opencode` | `OPENCODE_URL` | `https://opencode.ai/zen/go/v1` |

A base URL resolves in this order, highest first: `options.baseURL` (a non-empty
string), the provider's URL env key (trimmed; a blank value is ignored), the
descriptor default, then the backend's built-in default. `null` means
"unset" and takes the same path as an omitted option. For `opencode`,
`OPENCODE_TIER=zen` selects `https://opencode.ai/zen/v1` as the descriptor
default; `OPENCODE_URL` still wins over it. This precedence holds for
`initializeClient`, `loadCredentials` and direct client construction;
`loadCredentials` keeps a `baseURL` key whose value is `undefined` when the env
var is unset or blank (except `opencode`, which resolves to its tier URL). Any
other explicit value — an empty or whitespace-only string, or a non-string —
throws `ConfigurationError`. On `anthropic`, `options.anthropicOptions` (the old
vendor-SDK option bag) is refused with a `ConfigurationError` that names it:
pass the endpoint as `baseURL` and the transport values as
`options.transportOptions`.

The protocol is selected with `withProtocol({ protocol })` on the session, or
with the `protocol` option of `initializeClient`. A protocol the provider does
not speak is refused with a `ConfigurationError` that names the supported ones.

```js
import { initializeClient, loadCredentials, resolveProvider } from 'merci-sdk';

const provider = resolveProvider();          // PROVIDER from secret.env
const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
```

Start from the shipped template — copy `secret.env.example` to `secret.env` and
fill in one provider. `secret.env` is resolved once per process: `MERCI_ENV_FILE`
if set, otherwise `./secret.env` in the process's working directory, otherwise
the package's own checkout. A refreshed `JAI_TOKEN` is written back only to
`MERCI_ENV_FILE` or the package's own file — never to a project `secret.env` the
SDK merely found, so a committed template or shared checkout cannot receive a
live token.

`resolveProvider()` has no `DEFAULT` sentinel: it returns the `provider`
argument when given, otherwise the `PROVIDER` env value. The env value is
validated (an unknown one throws a `ConfigurationError`); an explicit argument
is passed through, and `initializeClient` rejects an unknown provider.
`initializeClient` returns the resolved `provider` beside the client.

### The deciding factors

Every row below is a parameter the unified builder accepts on one standard and
refuses on another. A refused parameter is a no-op with a
`parameter_warning` event — it never reaches the wire.

| | `oai` (OpenAI-compatible) | `aai` (Anthropic) | `gai` (Google GenAI) |
|---|---|---|---|
| **Native protocol** | chat completions **or** the Responses API | Messages API | `generateContent` |
| **Tools / function calling** | yes | yes | yes (the `toolConfig` modes) |
| **Non-streaming call** (`stream: false`) | **yes** — the only standard that supports it | no | no |
| **Thinking / reasoning** | `reasoningEffort`; on the Responses API also `reasoningSummary` → `reasoning.summary` and `verbosity` → `text.verbosity` (the chat-completions branch drops `reasoningSummary` with a warning and keeps `verbosity` except on OpenRouter, where it is dropped with a warning) | `thinkingBudget` → `thinking.budget_tokens` (clamped to ≥ 1024 and below `max_tokens`), `thinkingBudget('adaptive')` → `thinking: { type: 'adaptive' }`, and `reasoningEffort` → `output_config.effort` (never implies thinking) | `thinkingBudget` and `thinkingLevel` (`low`/`medium`/`high`) |
| **Prompt caching** | `promptCacheKey` → `prompt_cache_key` (both branches) | `cachePoints` → wire-level `cache_control` breakpoints — **the only standard that writes them** | `cachedContent` (a cached-content resource) |
| **Citations** | `sources` from the response annotations | `citations` (the unified shape) | `citations` (the unified shape, from grounding metadata) |
| **Refusal** | `type: 'error'`, `error_type: 'refusal'` | `type: 'error'`, `error_type: 'refusal'`, `refusal: true`, `refusal_reason: 'refusal'` (Anthropic `stop_reason: 'refusal'`) | `type: 'error'`, vendor reason in `error_type` (`SAFETY`, `BLOCKLIST`, `IMAGE_RECITATION`, … or the prompt `blockReason`), `refusal: true` and the same reason in `refusal_reason` |
| **Embeddings** | yes (`/embeddings`) | **none** — `embed()` always throws a typed `ConfigurationError` that names the providers that do embed | yes (`embedContent`) |
| **Server-side state** | `previousResponseId` (Responses branch), `store` | — | — |
| **Log probabilities** | `logprobs`, `logprobsTopK` | — | `logprobs` → `responseLogprobs` on the wire |
| **Service tier** | `serviceTier` | `serviceTier` | — |
| **PDF media** | `openai` and `openrouter` (the OpenAI `file` part); `local` and `opencode` refuse it | yes | yes |
| **Native web legs** | `openai`: search on the **Responses** protocol only (the chat schema's `web_search_options` carries just `user_location` and `search_context_size`); `openrouter`: search and fetch on both — the others have no native leg and fall back to Tavily | search and fetch | search and fetch |

### The parameters each standard refuses

This is the refusal list of the unified parameter builder
(`lib/messaging/unified-parameter.mjs`), keyed by standard. A refused parameter
is a no-op and emits a `parameter_warning`; it never reaches the wire.

| Standard | Refused parameters |
|---|---|
| `oai` | `topK`, `length`, `predictedOutput`, `thinkingBudget`, `thinkingLevel`, `cachePoints`, `numberOfChoices`, `metadata`, `cachedContent` |
| `aai` | `presencePenalty`, `frequencyPenalty`, `seed`, `length`, `predictedOutput`, `thinkingLevel`, `reasoningSummary`, `stream`, `user`, `numberOfChoices`, `verbosity`, `promptCacheKey`, `logprobs`, `logprobsTopK`, `previousResponseId`, `store`, `cachedContent` |
| `gai` | `parallelToolCalls`, `reasoningEffort`, `length`, `predictedOutput`, `reasoningSummary`, `stream`, `user`, `cachePoints`, `numberOfChoices`, `verbosity`, `promptCacheKey`, `metadata`, `serviceTier`, `previousResponseId`, `store` |

Two of those entries are exclusive by construction: `stream` is refused on
every standard except `oai`, and `cachedContent` on every standard except
`gai`. `cachePoints` is refused on `oai` and `gai`, and `aai` is the only
standard that turns it into wire-level `cache_control` breakpoints.

The refusal list is the practical summary: the four standards are not four
skins over one wire, and the list is what keeps a parameter from reaching an
endpoint that would answer 400.

### Decisions — the judgment surface

A **discriminative** (or *System One*) model does not generate text. You send it
one `state` and named, typed questions, and it returns one typed answer per
question with calibrated probabilities:

| Question | Answers | Use it for |
|---|---|---|
| `noul` | `probability` that a statement is true | yes/no checks, gates, policy rules |
| `choice` | the most likely option plus the probability of every option | routing, classification, triage |
| `score` | a probability-weighted position on an ordered rubric | severity, relevance, grading |

This is not a session protocol: there is no history, no tools, no streaming and
no text. `client.decisions.ask()` sits beside `client.embed()` — one request in,
one typed answer out. `client.session()` is unaffected, and the decision model
never drives an agent turn.

```javascript
import { MerciClient } from 'merci-sdk/oai';
import { noulQuestion, choiceQuestion, readDecisionAnswer } from 'merci-sdk';

const client = new MerciClient({ options: { provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY } });

const { answers } = await client.decisions.ask({
    model: 'typesafe/jev-1.14',                      // pin a version; aliases move
    state: { ticket: 'I was charged twice for my subscription.' },
    questions: {
        refund: noulQuestion({ instructions: 'Is the customer asking for money back?' }),
        team: choiceQuestion({
            instructions: 'Which team should own this ticket?',
            criteria: { billing: 'Charges and refunds.', account: 'Login and profile.' },
        }),
    },
});

const refund = readDecisionAnswer({ answers, name: 'refund', type: 'noul' });
if (refund.probability >= 0.9) refundTicket();       // the threshold is your policy
```

Every answer carries `type`; read it before a field. `confidence` is always
present and may be `null`: OpenAI's `predicate` and the keyed `noul` report no
confidence, so `confidence ?? probability` is not a portable substitute.

Three wires are translated by `lib/backends/decisions/adapters/`, one file per
wire, so a caller writes one shape. OpenCode sells the keyed wire on its own
path, so it shares that adapter's body and answer reader:

| Provider | Endpoint | Envelope | Yes/no type |
|---|---|---|---|
| `openai` | `POST /v1/decisions` (`gpt-6-luna`) | `input` + `questions[]`, `answers[]` | `predicate` |
| `openrouter` | `POST /api/alpha/decisions` (Jev, Clef, Mercury Decide, D1, `gpt-6-luna-decisions`, …) | `state` + `questions{}`, `answers{}` | `noul` |
| `opencode` | `POST /zen/v1/systemone` (`jev-1.13`, `jev-1.13-free`, `gpt-6-luna-decision`, `gemini-decision-1`); Console root `POST /inference/systemone/v1/systemone` | `state` + `questions{}`, `answers{}` | `noul` |
| `google_genai` | `POST /v1beta/decisions` (`gemini-decision-1`) | `input` + `questions{}`, `answers{}` | `noul` |

OpenCode's chat base is the Go tier (`/zen/go/v1`), which sells no decision
model, so a client built on that base targets the documented Zen path; a base
under `/zen/v1` or `/inference/systemone/v1` keeps its own root.

`local`, `vertex` and `anthropic` have no decision wire;
`ask()` names the supported providers instead of failing at construction.
Vertex is a valid chat tier but not a decision one yet: Gemini Decision 1 runs
on the Gemini Developer API (`PROVIDER=google_genai`), and Google lists Vertex
support as coming soon — `ask()` on a Vertex client says so. The
TypeSafe `/v1/systemone` body is the keyed shape, so a direct TypeSafe provider
is a descriptor, not a translator — it is not wired yet; reach Jev through
OpenRouter.

The model comes from the provider descriptor's `DEFAULT_<PROVIDER>_DECISION_MODEL`
in `secret.env` (`DEFAULT_OPENROUTER_DECISION_MODEL`,
`DEFAULT_OPENAI_DECISION_MODEL`, `DEFAULT_OPENCODE_DECISION_MODEL`,
`DEFAULT_GOOGLE_GENAI_DECISION_MODEL`); there is no generic fallback and no id
hardcoded in the source, because a decision model id is version-specific — pin
it in `.env` and change it there. `ask({ model })` overrides for one call, and
an unset key fails with the key's name instead of a silent default. A gateway
mounted somewhere other than the default path can pass `ask({ url })` to name the
endpoint outright. Media (images, audio, PDF, video) is
not part of this surface yet — `state` is a string or a JSON object — so the
multimodal decision path stays out until it has a shape the three wires agree
on. Thresholds, cascades and retries stay in your code: a schema-valid answer
can still be the wrong answer.

### Client roles — one provider and model per surface

A process normally needs three clients, and they need not share a backend: the
**generative** client runs chat, the **embedding** client builds vectors, and
the **decision** client answers System One questions. A role names its own
backend and model; nothing is inferred across roles and no fallback moves data
to a vendor you did not name.

| Role | Provider key | Model key | Model default | Required surface |
|---|---|---|---|---|
| `generative` | `GENERATIVE_PROVIDER` | `GENERATIVE_MODEL` | `DEFAULT_<PROVIDER>_MODEL` | `session()` |
| `embedding` | `EMBEDDING_PROVIDER` | `EMBEDDING_MODEL` | `DEFAULT_<PROVIDER>_EMBEDDING_MODEL` | `embed()` |
| `decision` | `DECISION_PROVIDER` | `DECISION_MODEL` | `DEFAULT_<PROVIDER>_DECISION_MODEL` | `decisions.ask()` |

Resolution order: the role's provider key, else `PROVIDER`; the role's model
key, else the provider's tier key. The backend must support the surface before
a model is resolved — a decision role on `vertex` fails on the provider, not on
a missing model id.

```dotenv
GENERATIVE_PROVIDER=vertex
GENERATIVE_MODEL=gemini-3.5-flash-lite
EMBEDDING_PROVIDER=vertex
EMBEDDING_MODEL=gemini-embedding-2
DECISION_PROVIDER=google_genai     # vertex has no decision wire
DECISION_MODEL=gemini-decision-1
```

```javascript
import { createRoleClients, createDecisionGate, noulQuestion } from 'merci-sdk';

const roles = await createRoleClients();          // generative + embedding + decision
const gate = createDecisionGate({ ask: roles.decision.ask, seam: 'triage' });

const check = await gate.gate({
    state: { ticket: 'I was charged twice.' },
    question: noulQuestion({ instructions: 'Does this request need a human now?' }),
});
if (!check.escalated && check.verdict === true) pageOnCall();   // the threshold is your policy
else await runTheLlmPath();                                     // escalate, never guess
```

`createRoleClients()` builds one client per distinct provider and reuses it;
per-role `options` (a fetch, a timeout) opt a role out of sharing. A role that
cannot resolve — an unknown name, a backend without the surface, an empty model
— fails at construction with the env key to set; a `roles` subset simply omits
the roles you did not ask for. `resolveRole({ role })` answers the same question
without building a client.

The gate is the shared adapter between a decision surface and an agentic flow:
`gate()` is a `noul`, `choose()` a closed-world pick (the escape option must be
declared, and an undeclared answer escalates), `score()` an ordered rubric.
Certainty is `confidence` when the wire reports it, else `max(p, 1 - p)` for a
`noul`, the top probability for a `choice`, and the top probability of the
rubric map for a `score`. Below the threshold, a wrong answer type, an
out-of-range probability, a backend error or no surface at all escalate — the
flow keeps its LLM path. An abort rethrows.

`createDecisionReranker({ ask })` shapes the same gate as a memory `reranker`:
one `noul` per top candidate (five by default), ordered by probability; an
escalated fact keeps its original slot.

### Session-level wiring

`createAgenticRuntime({ seams })` is the composition root: it resolves the three
roles once and returns the gate, a per-seam gate factory, and the option
fragments each flow already accepts (`sessionOptions`,
`dag.evaluatorOptions`, `dag.executorOptions`, `sm.options`,
`discussion.options`) plus the guardrail, memory and eval factories. It wires
nothing implicitly — pass a fragment where you construct the flow.

```javascript
const runtime = await createAgenticRuntime({ seams: ['dag.evaluator', 'sm.verify'] });
const session = client.session(model).withDecisionGate({ gate: runtime.gate });

await session.run({ initialInput: '…' });          // the loop seam
const executor = new WorkflowExecutor({ options: { client, defaultModel, ...runtime.dag.executorOptions } });
```

`withDecisionGate({ gate })` is the session default; an explicit
`run({ options: { decisionGate } })` wins for one call (and is not charged to
the session pool). Every engine's `runStep` forwards the gate into the per-step
loop, so a gate set on a DAG, state-machine or discussion flow also governs its
inner turns. The step never mutates the session's budget: a session with a
budget of its own charges its pool, and every step's decision tokens ride the
usage the step returns. Usage is charged as `prompt_tokens` /
`completion_tokens` / `cost_usd`, and a wire that reports no numeric tokens is
estimated from the state size instead of charged zero.

A step's usage carries `decision_tokens` (a subset of `total_tokens`; never add
the two). The decision cost is folded into `cost_usd` only when the LLM cost is
known — an unknown LLM cost stays unknown — and is reported separately as
`decision_cost_usd` otherwise. The executor's `remainingBudget()` therefore
sees step-loop decision spend, and
the executor's own outage and replan classifier calls are charged directly. A
derived gate belongs to one session (a copy or a `withUsage()` derivation keeps
the owner): passing it to another session is refused rather than charging both
pools. The evaluator, the state machine's node verify and the discussion
judge/assign gates are separate components: their calls are reported through
`createAgenticRuntime({ onDecisionUsage })` (or `createDecisionGate({ onUsage })`)
and are not part of the executor's cap. Memory admission calls follow the same
rule.

### Memory admission and threshold calibration

Two judgment points sit outside the turn loop:

```javascript
import { createDecisionGate, decisionCalibration, noulQuestion } from 'merci-sdk';

// Admission: a distilled fact costs an embedding and bank space. A confident
// "not durable" drops it before store(); an escalation admits it. The gate
// rides in `options` (withMemory spreads that object into MemoryManager).
session.withMemory({ provider, options: { admissionGate: runtime.gate } });

// Calibration: the thresholds are policy. Measure them on your own labels.
const report = decisionCalibration({ samples: [{ probability: 0.93, expected: true }] });
console.log(report.ece, report.brier, report.sweep);
```

`decisionCalibration({ samples, bins, thresholds })` returns expected
calibration error, the Brier score, per-bin observed frequencies, and a
coverage/accuracy/escalation point per candidate threshold. Use it to pick
`DECISION_GATE_THRESHOLD` and `DECISION_SKIP_CERTAINTY` instead of inheriting
the defaults. A miscalibrated model either escalates constantly or, at the skip
bar, replaces an LLM verifier with a confident wrong verdict.

### Choose this when

**OpenAI-compatible (`oai`)** — you want the Responses API (`withProtocol({
protocol: 'responses' })`), the only standard that carries
`previous_response_id` or `store`, a non-streaming call, `prompt_cache_key`,
log probabilities, or a gateway that is not OpenAI itself (OpenRouter,
OpenCode, a local LM Studio). It is also one of two families with an embeddings
endpoint besides Google.

The four `oai` providers differ in the parts the wire does not cover:
`openai` and `openrouter` accept PDFs and carry native search legs, `openrouter`
also carries a native fetch leg, and `local` and `opencode` do neither, so a
PDF on those two is refused with a `ConfigurationError`.

Every `oai` provider speaks through the SDK's built-in native `fetch` connector
(`lib/backends/transport/`); no vendor SDK is installed or required for
`openai`, `openrouter`, `opencode` or `local`. `client.transport` is that
connector, configured with `transportOptions` (`fetch`, `defaultHeaders`,
`timeout`, `maxRetries`).

OpenRouter attribution is optional and this SDK sends none of it by default.
Set it yourself through `transportOptions.defaultHeaders`:
`HTTP-Referer` (the app URL), `X-OpenRouter-Title` (the app name) and
`X-OpenRouter-Categories` (the app category). `X-Title` is **not** an
OpenRouter header name; the category header uses the `X-OpenRouter-` prefix
even though the schema that types its values is called `AppCategories`.

```js
import { initializeClient, ProviderType } from 'merci-sdk';

const { client } = await initializeClient({
    provider: ProviderType.OPENAI,
    options: { apiKey: process.env.OPENAI_API_KEY }
});

const session = client.session('gpt-4.1')
    .withProtocol({ protocol: 'responses' })
    .withParameters({ params: (b) => { b.previousResponseId({ v: 'resp_…' }); } });
```

**Anthropic (`aai`)** — you want Anthropic extended thinking, cache breakpoints
on the message content blocks, Anthropic web-search citations, or the
`messages` protocol's own semantics. It has **no embeddings endpoint**; the
client says so with a typed `ConfigurationError` instead of silently
degrading, and the memory layer treats a throwing embedder as "no vector tier"
and keeps working with lexical recall.

The `aai` standard runs on the SDK's built-in native `fetch` connector
(`lib/backends/transport/aai-client.mjs`); no vendor SDK is installed or
required. `client.transport` is that connector, configured with
`transportOptions` (`fetch`, `defaultHeaders`, `timeout`, `maxRetries`), and it
speaks the same wire as before: `Authorization: Bearer <apiKey>`,
`anthropic-version: 2026-10-21`, and `POST /v1/messages` / `GET /v1/models`
under `baseURL`. A positive `maxRetries` is refused — Merci owns retries and the
connector never retries. `models.list()` keeps the vendor client's page
surface: awaiting it gives one page (`data`, `has_more`, `hasNextPage()`,
`getNextPage()`), and iterating the promise itself walks every page with
`?after_id=`.

```js
const session = client.session('claude-sonnet-4-5')
    .withParameters({ params: (b) => {
        b.thinkingBudget({ v: 8_000 });
        b.cachePoints({ v: 2 });       // → cache_control on the last two messages
    } });
```

**Google GenAI (`gai`)** — you want Gemini grounding citations, a
cached-content resource, `thinkingLevel`, or Vertex AI. The same standard
serves both `google_genai` and `vertex`; only the endpoint and the credentials
differ. `cachedContent` exists on Gemini `v1beta` (the Google client's default,
and the version this SDK relies on) and on Vertex; Gemini `v1`'s
`GenerateContentRequest` does not define it, so an SDK-level
`apiVersion: 'v1'` override drops the field and the request answers 400.

```js
const session = client.session('gemini-2.5-pro')
    .withParameters({ params: (b) => {
        b.thinkingLevel({ v: 'high' });
        b.cachedContent({ v: 'cachedContents/abc123' });
    } });
```

The `gai` standard runs on the SDK's built-in native `fetch` connector
(`lib/backends/transport/gai-client.mjs`, with `google-auth.mjs` for Vertex);
no vendor SDK is installed or required for `google_genai` or `vertex`.
`client.transport` is that connector and carries the same call surface the
vendor client exposed — `models.generateContentStream`, `models.list()` and
`models.embedContent`. Configure it with the flat `options.baseURL` and
`options.transportOptions` (`fetch`, `defaultHeaders`, `timeout`); a positive
`maxRetries` is refused because Merci owns retries. `genaiOptions` is a closed
bag for the wire mode only — `vertexai` (or `enterprise`), `project`, `location`,
`apiVersion` and `googleAuthOptions` (`credentials`, `keyFile`, `scopes`). The
old `genaiOptions.httpOptions` is refused: it was the vendor client's HTTP seam
and now points at `baseURL` plus `transportOptions`. `googleAuthOptions.scopes`,
when given, must be a non-empty array of strings that includes
`https://www.googleapis.com/auth/cloud-platform`: these credentials are only
granted that scope for Vertex calls, so any other set is refused before a
request — the same rule the vendor client applied.

**A tool round ends with its responses, not with text.** Vertex rejects a user
turn whose `functionResponse` part is followed by text
(`400 Requests ending with a model turn are not supported.`). A trailing
live-state block (todos, preloaded memory, skills) is merged into the tool
result turn, so the GAI normalizer keeps `functionResponse` parts **last**:
the live-state text precedes them in the same turn. A turn that is only
function responses is unchanged.

**Vertex Express needs no `project`.** With `vertexai: true` and no `project`
the connector addresses `publishers/google/models/<model>` directly — streams,
`models.list()`, `:embedContent` and `:predict` all work — instead of refusing
the call. With a `project` the model path keeps its
`projects/{project}/locations/{location}/` prefix.

**Embeddings.** Gemini embeds through one `:batchEmbedContents` call; Vertex
uses `:embedContent` for a Gemini embed model (`gemini-embedding-2`) and
`:predict` otherwise, and the two answers are read differently:
`:embedContent` returns `{embedding: {values}, usageMetadata?, truncated?}` (one
embedding with `statistics`) while only `:predict` returns
`predictions[].embeddings`. `models.embedContent` accepts a `config` mapping and
puts it where each endpoint expects it: `taskType`, `title` and
`outputDimensionality` go on every Gemini `:batchEmbedContents` request, into
`embedContentConfig` on Vertex `:embedContent`, and into
`instances[].task_type` / `.title` plus `parameters.outputDimensionality` on
`:predict`. `mimeType`, `autoTruncate`, `documentOcr` and
`audioTrackExtraction` are Vertex-only. `client.embed()` does not pass a
config, and it always sends Content objects (one per input), so a string list's
grouping rules are a transport-surface detail rather than an `embed()` one.

**Structured output.** `responseSchema` is normalised on the way out — string
types and `type` arrays are uppercased (a `null` member becomes `nullable`, a
multi-member array an `anyOf`) through `properties`, `items` and `anyOf`
members, a two-member `anyOf` with a `null` branch becomes `nullable`,
`additionalProperties` is dropped — while `responseJsonSchema` is passed through
untouched. A schema carrying both `type` and `anyOf` is refused before the
request, and a `responseSchema` with `$schema` is sent as `responseJsonSchema`.
Put a schema from a JSON-schema generator in `responseJsonSchema`.

**Vertex credentials** resolve without `google-auth-library`, in this order:
`googleAuthOptions.credentials`, `googleAuthOptions.keyFile`,
`GOOGLE_APPLICATION_CREDENTIALS`, the well-known ADC file, then the GCE/GKE
metadata server. `service_account` (with an optional `subject` for domain-wide
delegation) and `authorized_user` are exchanged for an access token;
`external_account` (workload identity federation), impersonation and GDCH
credentials are **refused** with a `ConfigurationError`. A Vertex client with an
API key uses Vertex Express instead, and `options.baseURL` still overrides the
location-derived root.

### Timeouts and the retried POST

`transportOptions.timeout` (and the `MERCI_LIMIT_OAI_REQUEST_TIMEOUT_MS`
default on `oai`) bounds connect plus response headers, and for a non-streaming
call the body too. Its expiry is retryable and typed — `HEADER_TIMEOUT` on the
error — exactly like a dropped connection.

A retry re-sends the whole POST, body included. No idempotency key is sent on
either attempt, so a gateway that had already accepted the first request may
process both. That is fine for a chat call and wrong for anything billed per
request. Two safe options: pass an `Idempotency-Key` through
`transportOptions.defaultHeaders` where the endpoint supports one, or turn the
session's retries off (`withRetryPolicy({ policy: new NoRetryPolicy() })` — the
transport's own `maxRetries` is 0, and a positive value is refused because Merci
owns retries). A shorter timeout does not help: it only makes the retry more
likely.

### Adding a provider

A provider on an existing standard is one descriptor. Add an entry to
`PROVIDERS` in `lib/core/constants/providers.mjs` with its `standard`, its
`protocols`, its base URL and URL env key, its credential env key, its
model-tier env keys and its capability flags, then add the env keys to
`EnvKey` in `lib/core/constants/sdk.mjs` and a row to the tables above. No
switch and no new module: `initializeClient` reads the descriptor and loads the
standard's client.

A provider with a new wire shape is a new standard: one descriptor in
`STANDARDS` (`standards.mjs`), a client module under `lib/backends/`, its entry
in `CLIENT_MODULES` in `lib/index.mjs`, and a protocol translator. The registry
tests in `test/provider-registry.test.mjs` pin the protocol table, the
credential and model keys, and the capability sets, so a new descriptor without
a test row fails the suite.

## Part 2 — which engine?

The SDK ships four execution engines. They are different shapes of control
flow, not different levels of quality: pick the one whose control flow matches
the problem.

| Engine | Shape | Module | Entry point |
|---|---|---|---|
| The agentic loop | the model decides its own next step | `lib/agentic/agentic-core.mjs` (`runAgenticLoop`) | `client.session(model).run({ initialInput })` |
| The DAG / workflow engine | a fixed graph of steps | `lib/agentic/planning/executor.mjs` (`WorkflowExecutor`) | `new WorkflowExecutor({ options })` — from `merci-sdk/planning` |
| The state machine | a modelled transition machine | `lib/agentic/state-machine/machine.mjs` (`StateMachine`) | `new StateMachine({ graph, options })` |
| The discussion engine | several agents conversing | `lib/agentic/discussion-session.mjs` (`DiscussionSession`) | `new DiscussionSession({ client, options })` |

### The agentic loop

A model with tools that keeps working until it answers: it calls a tool, reads
the result, decides what to do next, and stops when it has an answer. The
conversation lives in your array; every step returns an immutable row.

```js
const answer = await client.session(model)
    .withTools({ tools: [searchTool, readFileTool] })
    .run({ initialInput: 'What changed in lib/agentic/agentic-core.mjs?' });
```

**Reach for it when** the path is not known in advance and the tools are what
make the answer possible.

**Do not reach for it when** the steps are known. A loop that rediscovers a
fixed pipeline costs tokens on every run and cannot be reviewed as a
workflow.

### The DAG / workflow engine

A planned graph of steps, Kahn-sorted and parallel-ready. Each step runs
through one of three step engines — `naive` (a fresh session), `stateMachine`
(verified nodes) or `discussion` (a swarm) — and the executor owns the
failure handling, the evaluator-driven replan loop (bounded by
`maxReplanCount`), the operator HITL gates, and the template references
between steps.

```js
import { WorkflowExecutor } from 'merci-sdk/planning';

const executor = new WorkflowExecutor({
    options: { client, defaultModel: model, tools: [readFileTool] }
});

executor.setSteps({ stepsList: [
    { id: 'scan', title: 'Scan', description: 'List the files under lib/' },
    { id: 'review', title: 'Review', description: 'Review the scan output for defects.', dependencies: ['scan'] }
] });

const outputs = await executor.execute({ userGoal: 'Review the agentic core.' });
```

A step's prompt is its `userPromptTemplate` when it has one, and its
`description` otherwise; `dependencies` names the parent steps, and
`{{step_id.output}}` interpolates their results.

**A step failure cannot vanish.** The engines catch their own errors and record a
failed node; if one ever throws *outside* that catch, the executor converts the
escaped rejection into a step failure, so the run reports the step and ends instead
of leaving it `running` forever.

**A step reads only its ancestors.** `{{step_id.output}}` resolves against the
step's transitive `dependencies`, and a reference to a step that is **not** an ancestor
— a sibling, a descendant, or the step itself — is rejected when the plan is installed
(`Plan rejected: Template reference(s) to a non-ancestor: '{{x.output}}' in step 'b' —
add the dependency`), on every rewrite, and for every plan patch. A checkpoint restored
without re-validation is caught at execute time (it fails closed, naming the reference),
and with validation switched off entirely (`validateTemplateRefs: false`) the reference
renders `[UNRESOLVED: …]` and warns instead of silently picking up whatever finished
first. `intakeMode: 'all' | 'some'` is bounded by the same ancestor
set, so a retry sees exactly what its first attempt saw — never a sibling that
completed while it was waiting. (The evaluator and host `verify` functions still see
the whole run; only a step's own prompt and intake are bounded.)

**Evaluating the plan, and replanning by patch.** The per-step `evaluator` only ever
sees one node. A `planEvaluator` — `{ evaluate({ plan, progress, objective, context,
signal }) }` — sees the guiding plan (a `Plan`, PL1) plus where the run actually is:
which nodes completed and with what output, which are pending, which failed. It
answers `continue`, `replan` (with a patch), `done` or `abort`. The gate runs at a
wave boundary, every `planEvaluateEvery` completed nodes (default 1), and always
after a node whose `kind` is `'gate'`; with no evaluator configured nothing changes.

A replan is a **patch**, not a rewrite: `{ ops: [...] }` over `add`, `remove`,
`rewire`, `replace`, `split`, `expand`. Only named nodes change — an untouched node
keeps the definition it had (tools, HITL, timeouts, a `verify` function), which is
exactly what a whole-list rewrite dropped. Patches go through the same `setSteps()`
machinery, so historical retention, fingerprint invalidation and dangling-dependency
rejection all apply; a patch is **all-or-nothing**, so one bad op installs none of it.
A **completed** node cannot be removed by an evaluator patch (its evidence is the
run's history), and only a pending node can be `split`. Every attempt is journaled as
`plan:patched { ops, applied, rejected, reason, verdict, noop?, capped? }` — an invalid
or no-op patch is a warning and the current plan continues, never a corrupt run.
`maxPlanReplans` caps applied patches (independent of `maxReplanCount`), and two
consecutive no-op verdicts stop asking the evaluator, so a replan verdict cannot spin.
A `done` verdict emits `plan:settled { reason, trigger, pending }`, leaves the remaining
nodes pending, and `workflow:end` then carries `planSettled` plus `pendingSteps` — a
settled plan is visible, not silent.

A patch cannot drop a step the evaluator rejected while a **surviving** step still
names it in `dependencies`, `intakeSteps`, or a `{{id.output}}` template reference.
The rejected output is the one the run refused, so letting the dependent read it
would re-install it. A planner declares the replacement instead: add the step with
`replaces: '<rejected id>'` (`replaces: ['x', …]` for several) and the executor
rewires every surviving reference onto it in the same patch, journals
`plan:patched { applied, rewired: [{ from, to, steps: [<dependent ids>] }], verdict, source }`
and re-runs the dependents against it. A plan-evaluator patch may use the same
`replaces` directive on a step it `add`s or `replace`s, under the same rules: exactly
one candidate, and it must name a step this patch removes (naming any other step is a
visible no-op). Without a declaration (or with two
candidates) the patch is refused as a visible no-op — `plan:patched` with the
reason in `rejected[]`, `step 'x' was rejected, but the new plan still makes
dependent step(s) read it (y→x); rewire them or keep the step (a replacement step
may declare replaces: 'x')` — and a malformed declaration (unknown id, itself, a
completed step) fails the replan with a `ConfigurationError`. The current plan
continues in the no-op case: the run re-runs the rejected step, each attempt spends
one replan, and when `maxReplanCount` is reached the run fails with `Replan limit
(N) reached — the evaluator still rejects step [x]. Shipping the unverified output
is not allowed.` Example: `{ steps: [ …kept steps…, { id: 'scan2', title: 'Scan again', replaces: 'scan', dependencies: [] } ] }`.

A whole-list planner response (the existing `replan()`) is still supported: it is
converted to a patch by diff, so the nodes the planner re-describes identically keep
their live definition. `executor.currentPlan()` returns the plan as a `Plan`.

**Progressive planning.** A node can say that its own steps are not known yet:
`expansion: 'decompose'` makes the executor plan it **when it becomes runnable**, on
the nested engine (so the existing depth limit, child checkpoint and shared journal
apply). The planner sees the node's resolved prompt plus `## Acceptance` (its `brief`),
the ancestors' outputs, and `## Remaining plan` — the nodes still pending with their
briefs, and the tools the sub-plan will run with. The sub-plan's leaf output is the
node's output, so the node's `verify` gate and schema check run on the real result, and
`workflow:step_decomposed { stepId, subSteps, depth }` makes the decision visible (it is
forwarded out of a nested child). The learned sub-plan is kept on the node
(`_decomposedSteps`) and rides the checkpoint, so a verify/schema retry or a resume reuses
it instead of planning the same node again; a *changed* definition clears it and plans
anew. `expansion: 'static'` (an explicit `subSteps`) wins over the `decompose` label and
behaves exactly as before, `atomic` is the default, and a node that sets its own `engine`
keeps it.

A re-supplied identical plan keeps the learned sub-plan (the documented restore path);
a changed definition, an explicit `retryFailedSteps()`, or a plain re-execution plans
again. An invalid sub-plan is never cached, so a retry cannot replay it.

Three limits: a sub-step cannot read a *parent* step's output (`{{outer.output}}` is
invalid inside the child — its known ids are the child's own); the HITL gate runs before
decomposition, so an operator approving the node sees it before its sub-plan exists; and
a verify/schema retry's corrective feedback reaches the child's objective, so the
sub-steps see it only when the child's handoff forwards the goal.

**Dangling dependencies are a plan error.** `setSteps()` rejects a step whose
`dependencies` name no step in the plan and no already-completed step — with the edge
named (`b→ghost`) and nothing installed, so a rejected rewrite leaves the working plan
intact. A dependency on a *failed* step is rejected too: its output is an error string.
The scheduler's deadlock check stays as a backstop for a checkpoint restored without
validation.

**The checkpoint contract.** `executor.save()` returns one JSON snapshot and
`WorkflowExecutor.load({ json })` restores it. Nothing saves automatically.

- **Persisted:** the objective, the shared context, the AgentContext, every step
  (status, output, messages, HITL state, child state), the outputs, the replan
  count, pending evaluations, the token spend and the execution journal.
- **Not persisted:** the verification marks, the failure ledger, the approval
  sequence (recomputed from the restored gates), the engine options (re-supplied
  on restore) and **function-valued step fields** — a step's `verify` gate and its
  per-step `tools` are functions and JSON drops them. The checkpoint records *that*
  the gate existed (`hasVerify`), and that record is **sticky**: it survives every
  later save, so a chain of resumes cannot quietly forget the gate. A resumed step
  that would run without its gate **fails closed**: `execute()` throws a
  `ConfigurationError` naming the step, before any of the plan runs. Call
  `setSteps({ stepsList })` with the same plan before resuming to re-attach the
  functions (the restored statuses and outputs survive when the plan matches); the
  marker is cleared when the function is back. The one opt-out is explicit:
  `allowLostStepFunctions: true` on the executor options runs the plan ungated and
  keeps the `WORKFLOW-RESTORE` warning. A resumed run re-verifies completed steps
  only when both an evaluator and a planner are supplied.
- **Resume is step-granular:** completed steps are not re-run; a step that was
  `running` when the snapshot was taken becomes `pending` and runs again
  (at-least-once for that step). The journal replays a **done** tool call, so a
  restored side effect is not charged twice; an **in-flight** tool call is recorded
  as intent and fails closed (`side-effect state is unknown`) — at-most-once for the
  tool. With a session store attached, the intent row is written to a
  `<threadId>.journal` sibling **before** `tool.execute()` runs, so this holds
  across a process crash, not only a graceful stop. A restored node carries no live
  abort signal, so supply `stepTimeoutMs` again if you need per-step timeouts.
- **A failed tool call is unknown state unless the tool says otherwise.** A tool that
  throws after its effect may have started is journaled `failed`, and a resume refuses
  to re-run it (the effect may have landed). A tool that knows the effect did **not**
  start marks the error before throwing:

  ```js
  import { markToolErrorRetryable } from 'merci-sdk/tools';

  // validate first, then act; nothing was written yet
  throw markToolErrorRetryable(new Error('invalid input'));
  ```

  `Object.assign(err, { retryable: true })` is the same contract without the import.
  A tool registered with `idempotent: true` is always safe to retry. Anything else —
  including a plain `throw` — is treated as an unknown-outcome side effect and is
  never re-executed.
- **A journal row is auditable.** Each row carries the step/branch it belongs to
  (`boundary`), the call's `args`, a monotonic `seq` (a millisecond timestamp collides
  inside a parallel wave), `sessionId`/`parentRunId`, and — when the caller knows it —
  `usage`. The key still hashes boundary + args, so two steps can never replay each
  other's tool result; the row now also says what that key meant.
- **A plain `execute()` on an already-run instance is a fresh run**, not a resume:
  the steps are reset and every one runs again. Use a checkpoint to resume.
- **A checkpoint carrying a failed step aborts before scheduling** (the failure is
  part of the snapshot) — unless the plan evaluator had already settled the plan, in
  which case the settled run ends without re-running anything. Call `executor.retryFailedSteps()` to reset those steps —
  it clears their outputs (the replan count survives) — then resume; completed
  siblings stay untouched. A restored run starts with a fresh failure ledger, so
  the fingerprint replay budget is per process, not per checkpoint. The abort leaves
  the instance resumable, so the retry continues the restored run instead of
  restarting it.
- **Nested sub-DAG children** keep their checkpoint in the parent's step state
  (in memory), not as a separate file.
- **A record that exists but is not restorable is an error, not a fresh start.**
  `restoreCheckpoint` returns `null` only when there is no record; a record with
  no envelope, another kind, or a non-string payload throws a
  `ConfigurationError` naming the mismatch. `LocalFileSessionStore.load` returns
  `null` only for an absent file (`session:store_miss`); a present but
  unparseable or non-object file is quarantined, emits one
  `session:store_corrupt`, and throws `ConfigurationError { option:
  'checkpoint_corrupt' }` instead of hydrating as an empty thread, so the
  completed side effects in it are never replayed. `ExecutionJournal.fromJSON`
  throws on a non-object, a non-array `entries`, or a version other than 1 (a
  live `ExecutionJournal` is returned as is) — a checkpoint that silently lost
  its journal replays completed side effects.
- **The checkpoint thread belongs to one engine.** A record written by another
  runtime under the runner's thread id fails the attempt with `kind mismatch:
  expected 'stateMachine', record is 'chat'; use a fresh thread id`. Switching
  `engine` for an existing work item therefore needs a fresh thread id (or a
  cleared checkpoint); a retry cannot convert a chat row into a
  workflow/state-machine row.
- **A state-machine checkpoint resumes what it can.** A `failed`/`error` phase is
  a retryable attempt: it restarts from the entry node with a fresh visit budget,
  while the journal (at-most-once for tool effects) and the history stay. A
  `done` checkpoint returns `completed` without stepping, because the saved
  `current` is `null` after a terminal node.

**The event stream is a ledger when it is pointed at a sink.** `log.configure({
format: 'json', sink, level: 'trace' })` writes one NDJSON record per event, and
`attachEventLogger({ emitter, log })` subscribes to every registered name (so a new
event is logged the day it is registered). At `trace` the record carries the full
envelope as structured fields — `{ event, payload }` — plus the ambient correlation
(`runId`, `parentRunId`, `sessionId`); below `trace` the payload is summarised
(collections become `[n]`, long strings are truncated), which is what you want on a
console and not what an audit reads. Wrap the emit in `runWithRunContext` if the
emitter is not already inside a run — the logger takes correlation from the ambient
context, not from the envelope.

**Reach for it when** the pipeline is known, the steps are reviewable, and you
want a gate, a replan or a human in the loop between them.

**Do not reach for it when** the model has to invent the steps. A plan you
write yourself cannot adapt to what the model finds.

### One plan, two views

`Plan` (from `merci-sdk/planning`) is the artifact both executors read: a DAG of
**intents** — `{ id, brief, dependsOn }` plus the step payload that will carry it out.
A node's `brief` says what must be true when it is done; how it is done stays an
execution detail.

```js
import { Plan } from 'merci-sdk/planning';

const plan = Plan.fromDag({ steps, objective: 'ship the release' });
const { steps: dagSteps, lossy } = plan.toDag();          // for WorkflowExecutor
const { graph, lossy: smLossy } = plan.toStateMachine();  // for StateMachine
```

Projections are explicit and **never silently lossy** — both directions return a
`lossy` list naming what could not travel:

| direction | lossy when | reported as |
|---|---|---|
| DAG → StateMachine | a node has several dependencies | `join` — the projection runs a topological chain, so ordering holds and only parallelism is lost |
| DAG → StateMachine | independent branches exist | `sequence` |
| StateMachine → DAG | an edge carries a condition | `condition` — the ordering is kept as a dependency, the branch predicate is dropped |
| StateMachine → DAG | the graph cycles | `cycle` — the back edge is cut (`lossyCycles: false` refuses instead) |
| StateMachine → DAG | a node uses a JS `execute` function | `node-execute` |
| StateMachine → DAG | `terminal`, `maxVisits` re-entry, several roots, an unsatisfiable entry | `early-terminal`, `reentry`, `entry` |
| StateMachine → DAG | a node is not reachable from the entry; a node fans out to several edges | `unreachable`, `fan-out` |
| either | a step deadline (`timeoutMs` vs `stepTimeoutMs`) | `timeout` |
| either | a template reference the projection cannot translate | `template-dialect`, `shared-context` |

The engines do not share a template dialect: `{{step_id.output}}` in the DAG and
`{{context.step_id}}` in the machine. The unambiguous refs are translated both ways;
a machine variable (`{{context.score}}`) or a non-output ref is reported, never
guessed.

`plan.toJSON()` / `Plan.fromJSON()` round-trip the document and fail closed (a newer
version, a missing node list or a malformed graph is rejected). Like a workflow
checkpoint, function-valued step fields do not travel.

### One conversation, or many

A step does not have to run in its own conversation. `sessionScope` decides how the
steps of one plan share a session — and therefore a prompt-cache prefix:

| `sessionScope` | one session per | prefix reuse |
|---|---|---|
| `'step'` (default) | step attempt — retries stay isolated | none |
| `'plan'` | plan | one prefix for the whole plan, as long as no member changes the prompt/tools/model |
| `'branch'` | branch root (a root or a node with several dependants) | per branch |

A per-node annotation overrides the scope: `session: 'inherit'` (default), `'new'`
(open a group at this node) or a group id (share that group with other nodes). Any
grouping in between the presets is expressed with that one rule. A chosen group
(plan, branch or a named one) also spans that step's retries; an isolated step does
not.

```js
const executor = new WorkflowExecutor({ options: {
    client,
    sessionScope: 'plan',
    sessionSystemPrompt: 'You are the release agent. Shared context lives here.',
} });
```

A group owns the system prompt, the tool set, the model and the prompt-cache policy.
A member that changes any of them would silently break the cached prefix, so it opens a
**boundary group** and the run emits `workflow:session_boundary` naming the node and the
field (`systemPrompt`, `tools`, `model`, `promptCache`) — once per node and field. A
plan-level `sessionSystemPrompt` avoids *prompt* boundaries: each node's own prompt is
appended to its user turn as `[Step focus]` (a tool or model change still splits).

What a member inherits is bounded on purpose:

- **Ancestors only.** Sharing follows the same rule as intake: a step never reads a
  sibling branch's conversation, so a parallel branch cannot leak into it (C1). Two
  peers joined into one named group therefore share the *prompt and the session*, not
  each other's rows — only an ancestor's exchange is inherited.
- **Plan order, not completion order.** A run with `maxConcurrency > 1` composes the
  same history a serial run would, so the prefix is reproducible. Members of one group
  therefore run **one at a time** in plan order (a shared session refuses a second
  concurrent run; the others wait their turn). Different groups, and the per-step
  default, stay fully parallel — `maxConcurrency` still bounds the wave.
- **Accepted outputs only.** A rejected or failed attempt contributes nothing; a
  requeued step's rows are dropped before its dependent runs.
- **Capped.** `sessionHistoryMaxChars` (default 8000) bounds the inherited text: the
  oldest rows are dropped, and a single row larger than the budget is truncated — both
  with a visible marker rather than a silent overflow.

`executor.cacheGroups` reports how many conversations the last run used — `1` is the
"one prefix per plan" claim, measured rather than asserted. Boundaries and per-visit
groups count separately.

Sessions are not part of a checkpoint: a resumed run starts fresh groups (the per-step
`messages` in the snapshot still carry each step's own transcript). The dial applies to
the LLM step engine; a step that delegates to a state machine, a discussion or a nested
DAG runs those engines' own sessions.

### The memory bank

Long-term memory is a bank of facts the loop distils from a conversation and reads back
through `withMemory()`. Two things are worth knowing:

- **Facts dedupe against the conversation.** The dedupe key is the session id
  (`withMemory()` defaults it to the session's own id, and the provider persists it on
  the fact), so a resumed session — which builds a fresh manager — refreshes its own
  fact instead of storing a second copy. Two different conversations keep their own row
  for the same text; a manager used outside a session falls back to a random key.
- **The bank keeps an audit trail.** Every add, rewrite, forget, clear and
  cap-eviction appends one bounded `history` row — `{ event, id, old, new, actor, ts }` —
  so "what did the agent forget or rewrite, and from which session" is answerable from
  the bank file itself. The row cap is `MEMORY_MAX_HISTORY_ROWS`; a clear larger than
  that keeps a final `clear` row with `id: '*'` naming how many facts it forgot, and a
  concurrent writer's rows are merged under the same file lock that protects the facts.
  `delete({ id, opts })` and `clear({ opts })` take the session as the actor; a call
  without one records `actor: null`.

`SqliteMemoryProvider` implements the same contract on `node:sqlite` (Node
≥22.13): the bank is one row, a save is one transaction, and WAL plus a busy
timeout let two writers keep both facts. `node:sqlite` is imported lazily, so
a file-backed user never sees its ExperimentalWarning.

**Reach for it when** the work spans sessions and a fact should outlive one of them.
**Do not reach for it when** the conversation is one run — the ledger already carries
its turns, and a bank adds a distillation call.

### The state machine

A modelled machine: nodes, conditional transitions, cycles, and a shared
`StateContext` across the steps. A node is an LLM call or a JavaScript
`execute` function; an optional `verify` gate re-runs a node by failure
fingerprint. `plan()` lets the model design the graph, `replan()` regenerates
it after a failed hypothesis while preserving the context.

```js
import { StateMachine } from 'merci-sdk';

const machine = new StateMachine({
    graph: {
        entry: 'draft',
        nodes: [
            { id: 'draft', userPromptTemplate: 'Draft the migration note.' },
            { id: 'check', execute: () => ({ ok: true }) },
            { id: 'done', terminal: true }
        ],
        edges: [
            { from: 'draft', to: 'check' },
            { from: 'check', to: 'done', condition: 'check.ok === true' },
            { from: 'check', to: 'draft', condition: 'check.ok === false' }
        ]
    }
});
```

A node's result is stored in the shared context under the node's id, so a
transition condition reads it as `check.ok`. A `condition` is a string
expression evaluated against the context (synchronously), or a function that
receives the `StateContext`.

**Reach for it when** the transitions are part of the requirement — a contract
that must be satisfied, a loop that must terminate, a state that must be
visible.

**Do not reach for it when** the work is a straight line. A linear pipeline in
a state machine is a machine with no branches: use the DAG, which has fewer
concepts and a plainer result.

### The discussion engine

Several agents conversing over a shared ledger. Each agent is stateless per
turn: the turn runs in a fresh session rebuilt from the ledger — the agent's
own entries become assistant rows, its peers' become `[author]: …` user rows.
The engine adds a judge, a self-termination rule and a turn DAG.

```js
import { DiscussionSession, getDefaultModel } from 'merci-sdk';

const model = getDefaultModel({ provider: 'openai' });
const group = new DiscussionSession({ client, options: { objective: 'Should we ship it?' } });
group.addAgent({ name: 'analyst', persona: 'Argues the case for shipping.', model, provider: 'openai' });
group.addAgent({ name: 'critic', persona: 'Argues the case against.', model, provider: 'openai' });

const conclusion = await group.conclude({ instruction: 'Should we ship the price-table removal?' });
```

`conclude` runs the whole shape: the agents discuss, a judge weighs the
rounds, and the group aggregates a conclusion. The individual stages are
available on their own — `discuss`, `judge`, `aggregate`, `runTasks` — and the
conversation is readable through `getLedger()`.

`planForEach` runs a per-agent plan as a DAG of subagent steps. Every agent's plan is
planned and validated **before any step runs**, through the shared `Plan` type plus the
template-reference check: duplicate ids, a dependency on a step that does not exist, a
cycle and a `{{step.output}}` that names no step all reject that agent's plan with a
`ConfigurationError` (`planForEach: agent "…" planned an invalid DAG — …`). In a
multi-agent group that means agent A has not spent a single turn when agent B's plan
turns out invalid. Steps run **sequentially** in dependency order (a discussion turn is
ordered by nature); a step whose prerequisite failed is skipped and recorded in the
ledger. Its validation is existence-only (the C8 shape): a plan may reference an
earlier step it does not depend on, because every earlier step's output is already in
hand when it runs — a deliberate divergence from the DAG engine's ancestor rule.

**Reach for it when** the answer is a judgement, and one model's first answer
is not enough — a review group, an adversarial check, a decision that benefits
from stated disagreement.

**Do not reach for it when** one agent with the right tools would do. A
discussion costs one turn per agent per round.

## Part 3 — the protocol layer

Three protocols, each with a client and (where it makes sense) a server.
The API reference has the signatures:
[`api_reference.html#tools-protocols`](api_reference.html#tools-protocols).

### MCP — Model Context Protocol

Tools, resources and prompts, in both directions. The **client**
(`lib/tools/mcp-client.mjs`) wraps the official MCP TypeScript SDK **v2**
(`@modelcontextprotocol/client`): `McpClient` for the lifecycle,
`loadMcpTools({ mcpClient })` to turn a server's catalogue into SDK tool
definitions, `loadMcpToolsFrom({ command, args })` for the one-call form. The
transport is stdio by default, Streamable HTTP by URL, and the deprecated SSE
transport on request. The client declares the three callbacks a server may
make — `sampling`, `elicitation` and `roots` — and answers them.
The wire era is selectable with `mcpProtocolVersion`: the default `'legacy'`
is the plain 2025 `initialize` handshake, `'auto'` probes `server/discover`
and falls back to it, and a date string (e.g. `'2026-07-28'`) pins the modern
era. On the modern era a tool that answers `input_required` (multi-round-trip)
is fulfilled through the same `onElicit` / `onSampling` handlers.
**Roots and sampling are deprecated by MCP `2026-07-28`** (SEP-2577; Logging
too, which merci does not implement): they stay fully functional during the
deprecation window, and the earliest removal is the first spec revision
released on or after 2027-07-28. New code should pass directories as tool
parameters or server configuration instead of roots, and call the model
directly instead of serving sampling. The client keeps answering both for the
servers that still use them.
The **server** (`lib/tools/mcp-server.mjs`) serves the same tool definitions
over stdio (`createMcpServer`) or Streamable HTTP (`createMcpHttpHandler`),
optionally with resources and prompts, and a tool may declare an
`outputSchema` whose result is returned as `structuredContent`. The HTTP
handler keeps the 2025-era session model by default; pass
`mcpProtocolVersion: '2026-07-28'` to serve the modern era statelessly
through the SDK's `createMcpHandler` (no `Mcp-Session-Id`, one server per
request, 2025 traffic also stateless). `createMcpServer` (stdio) keeps the
2025 handshake by default; pass `mcpProtocolVersion: '2026-07-28'` to wrap
the SDK's `serveStdio`, which selects the era from the opening exchange and
pins one instance per connection. The handle's `setRequestHandler` queues a
registration until that instance exists and then replays it; `connect` throws,
because `serveStdio` owns the transport. Pass `legacy: 'reject'` to refuse a
2025 client on that mode instead of serving it.

A tool may also set `taskSupport: 'optional' | 'required'` on the legacy
era: the server advertises the 2025-11-25 task vocabulary and a
`tools/call` with `task` returns a task; a `required` tool rejects a plain
call. `McpClient.startToolTask`, `waitForTask`, `getTask`, `getTaskResult`,
`listTasks` and `cancelTask` drive it, and closing the server aborts a task
still in flight. `listTasks` returns one page (`{ tasks, nextCursor }`); pass
the previous page's `nextCursor` back to continue. An unknown task rejects
with `ERROR_CODES.MCP_UNKNOWN_TASK`, and `onTaskStatus` receives every
`notifications/tasks/status` the server publishes.

The store behind the vocabulary is pluggable: pass `taskStore` (an
`McpTaskStoreLike`) to `createMcpServer` or to a stateful
`createMcpHttpHandler` to persist tasks, or subclass the exported
`McpTaskStore`. `FileMcpTaskStore({ dir })` is the durable implementation:
one JSON record per task, reloaded on construction, so a completed task and
its result survive a restart. A task that was still `working` when the process
ended loads as `failed`, because a run cannot resume without its process; an
expired record is removed instead of loaded. A supplied store is shared and
closed by its caller; the server still cancels the tasks its own session
started. The modern era removed tasks, and the stateless modes cannot keep a
task alive between requests, so `taskStore` is refused there.

```js
import { loadMcpToolsFrom } from 'merci-sdk';

const tools = await loadMcpToolsFrom({ command: 'npx', args: ['@some/mcp-server'] });
const session = client.session(model).withTools({ tools });
```

### A2A v1.0.0 — agent-to-agent delegation

A remote agent's skills arrive as ordinary SDK tools. The **client**
(`lib/tools/a2a.mjs`) reads the agent card, chooses the dialect from it (v1.0
or the older v0.3) and calls the peer over the A2A JSON-RPC binding;
`loadA2ATool`, `getA2ATask` and `cancelA2ATask` are the entry points. The
**server** (`lib/tools/a2a-server.mjs`) publishes a Merci agent as a peer:
`createA2AServer` and `createA2AHttpHandler`.

```js
import { loadA2ATool } from 'merci-sdk';

const tool = await loadA2ATool({ agentUrl: 'http://peer.local' });
const session = client.session(model).withTools({ tools: [tool] });
```

### ACP v1 — Agent Client Protocol

The editor↔agent protocol, in the other direction: the SDK is the **agent**,
the editor is the client. `createAcpAgent({ session })` exposes a Merci
session over the full ACP v1 method set — `initialize`, `authenticate`,
`session/new`, `session/load`, `session/list`, `session/delete`,
`session/fork`, `session/prompt`, `session/cancel` — and reports every delta
as a `session/update` notification: message chunks, thought chunks, tool
calls, tool-call updates and plan entries.

```js
import { createAcpAgent } from 'merci-sdk/acp';

const app = createAcpAgent({ session: client.session(model) });
// Mount `app` on the editor's transport.
```

## Part 4 — the combination rules

### What the SDK already wires

- **The agentic loop over MCP tools.** `loadMcpTools` returns SDK tool
  definitions; `session.withTools({ tools })` registers them; the loop calls
  them. Nothing else is needed — see `examples/24_mcp_client.mjs`.
- **A2A delegation as a tool inside the agentic loop.** `loadA2ATool` is
  ordinary tool-shaped: the model calls it like any other tool. See
  `examples/26_a2a.mjs`.
- **A DAG step that is a discussion, and a discussion that runs a DAG.** The
  executor's step engine can be `discussion`, and a discussion agent can be
  given a tool that calls a `WorkflowExecutor`. Both directions go through the
  ordinary tool system; there is no bridge code. See
  `examples/17_dag_workflow.mjs` and `examples/19_discussion.mjs`.
- **The agentic loop over a state machine.** `withStateMachine({ graph })` on
  the session registers the machine as the `run_state_machine` tool, so the
  model can enter the machine from a turn.
- **Sub-agent delegation.** `withTaskAgents({ agents })` registers profiles;
  the `task` tool is advertised only while at least one profile is reachable,
  and its description lists the session's roster snapshot (a menu that changes
  mid-session is visible to the next session, which keeps the tools level stable).
  A foreground child is not a black box: its text, thoughts and tool calls are
  re-emitted on the parent emitter (`workflow:step_text` / `step_thought` /
  `step_tool_call_*`) with `subagent` naming the child, the spawning node's id and a
  run context that hangs off the step (`parentRunId`), so a reader can follow the tree.
  A throwing listener cannot abort the child. A continued turn streams the same way,
  named by the spawn id. A background child's result is queued into the parent's next
  turn; when that turn ended mid tool round, the unanswered call is closed with a
  synthetic result first, so the notification never splits a `tool_use`/`tool_result`
  pair.

### The constraints

- **The A2A skill selector travels in `params.metadata.skillId`.** A2A v1.0
  has no skill field, so the selector is metadata. The server resolves the
  skill from `metadata.skillId` (then `skillId`, then the data part) and
  strips the selector from the arguments.
- **Roots and sampling are deprecated (MCP `2026-07-28`, SEP-2577).** They
  work until the first spec revision released on or after 2027-07-28 at the
  earliest; do not build new features on them. MCP logging is deprecated in the
  same SEP and merci does not implement it.
- **The MCP client may only register a handler for a capability it declared.**
  Declaring `sampling` without a callback is a protocol-level refusal, not a
  silent success — and registering a handler for an undeclared capability is
  rejected by the MCP SDK itself.
- **The MCP client's callbacks are registered before `connect()`.** The
  official client sends `notifications/initialized` while `connect()` resolves,
  so a server that samples during the handshake must already be answerable.
- **A stateless MCP transport is not reused across requests.** A stateless
  server creates one transport per request and answers with JSON; a stateful
  server keeps one transport per session. The 2026-07-28 HTTP mode is
  stateless for both eras, so it answers GET and DELETE with 405; use the
  default handler when a 2025 client needs sessions or server-sent events.
- **A permission decision for an option id the agent never offered denies.**
  The same applies to the ACP client capabilities: a capability the client did
  not announce at `initialize` is never called.
- **`session/cancel` is a notification in ACP v1**, not a request.
- **The A2A endpoint is pinned to the agent card's origin.** A cross-origin
  endpoint yields no tools at all, and redirects are refused.
- **The A2A endpoint guard runs at load time.** A peer with a bad endpoint
  produces an empty tool list, not tools that fail on every call.
- **A fork across providers degrades visibly.** `handoff.context: 'fork'`
  replays the parent's real message rows; on a different provider the rows
  cannot be replayed on a foreign wire, so they render as visible digest rows
  and the run emits `task:fork_degraded` with `parentProvider` and
  `childProvider` (also when a replay degrades units within one provider) —
  never a silent empty handoff.
  `'full'` replays the whole parent conversation as rows (on a foreign provider it
  degrades like `fork`); `'moderated'` carries a compacted digest block; `'clean'`
  carries nothing. Cross-process (A2A), only
  the envelope's objective/directive/refs travel — never conversation rows — and
  the receiving skill sees them as `ctx.agentContext`.
- **One transport per provider, shared by every session.** A `MerciClient` builds one transport
  (the built-in `fetch` connector for the `oai`, `aai` and `gai` standards) and every session, subagent and DAG node of that provider
  reuses it; sessions themselves are cheap. The exception to know about: `opencodeSessionId` is set
  **per client**, so every child and every concurrent DAG node of one client shares a single remote
  OpenCode session id — a gateway that keys state by it will see one conversation. This is a decision,
  not a defect: the remote id identifies the *transport session* the connector opened. A caller that
  needs per-agent isolation constructs one client per session (the clients are cheap; the transport
  object, not the conversation, is what is shared).
- **The client is a transport.** The spawn registry holds the roster, the
  provider→client map, the resolver, the depth cap, the background counter and map,
  the delegation envelope, the spawn records and the circuit-breaker health view;
  the client carries none of it (a frozen client works). `withTaskAgents`,
  `withAgentDelegation` and `getSpawnRegistry({client})` are the API. The old
  `client._task*` / `client._agentDelegation` fields are **deprecated**: if a host
  presets one before the first SDK call, the registry adopts it once, says so, and
  deletes it from the client.
- **The budget is a tree budget.** A session with `withBudget({budget})` owns one
  pool; every spawn of that session (and of its spawns) draws from it, so the cap
  binds the whole tree instead of each child separately (`getBudgetPool({session})`
  reads the cap and the tree's spend; `spawn.usage` stays the child's own ledger).
  A child may set a tighter budget of its own — a local cap — but only the pool's
  owner can move the tree's cap. A step that reports no usage is charged as an
  estimate, so a silent provider cannot hide spend from the cap. The pool is created
  by `withBudget` (the documented tree mechanism); a per-run `budget` option caps
  that run and that session only and does not bound children. A step that reports
  usage and then throws is still charged: the partial usage rides the error, is
  charged to the run and to the pool before the retry, and `RUN_END` reports the
  accumulated run usage. (`steps` counts completed steps only, so a retried
  attempt reports one step and the usage of both.)
- **The whole spawn contract is on one page.** Roster, envelope, role templates,
  the budget pool, depth and the tree, durability and the trust boundary are
  documented in [`SPAWNING.md`](./SPAWNING.md); the runnable version is
  [`examples/15_delegation.mjs`](../examples/15_delegation.mjs).
- **Child persistence is opt-in.** A spawn is in memory by default — nothing is
  written. Attach a `SessionStore` to the parent
  (`session.withSessionStore({ store, threadId })`) and every child it spawns is
  durable under its **own** deterministic thread, `spawn:<spawn id>`
  (`spawnThreadId({ id })`), never the parent's thread. The spawn handle exposes
  `threadId`. `forkSpawn({ client, id, newThreadId })` branches a child's
  conversation and leaves the original; across processes pass
  `{ store, threadId, newThreadId }`. To resume in a new process, build a session
  with `withSessionStore({ store, threadId })` and call `loadCheckpoint()`. A
  failed child still saves its last turn; a turn that fails before its first
  transcript snapshot keeps the stored conversation instead of writing an empty
  one over it. If the durability write itself fails, the answer still returns and
  `handle.checkpointError` says why. A code-agent spawn
  has no conversation, so it has no thread and writes nothing. The switch is
  **per tree**: attaching a store persists every descendant's conversation for as
  long as the tree lives, and checkpoints are never deleted automatically — a
  long-lived client that delegates a lot should prune the store itself.
- **The tree is the unit that is bounded, not the depth.** Depth stays **1 by
  default**; `withAgentDelegation({ maxDepth })` raises it, so an orchestrator can
  spawn an orchestrator. Because a fixed depth only limits one axis, every spawn
  tree also has a spawn cap: `withAgentDelegation({ maxSpawns })`, default **128**.
  The count is a shared object carried by the tree's sessions and spawn records, so
  a grandchild routed to another transport still counts against the same tree, and
  the count survives settled-record eviction. A tree that hits the cap fails with
  an explicit error naming the cap; a second root has its own budget. The shared
  budget pool (SP4) bounds the money in the same tree.
- **A code-agent profile counts toward the depth.** A profile with `execute`
  builds no child session, so it used to leave the parent's depth untouched and a
  recursive `execute` profile could recurse past `maxDepth`. The profile now runs
  inside an async frame at the depth its spawn occupies, so a recursive code agent
  stops at the same cap as an LLM child — and sibling or concurrent code spawns
  each get their own frame, so the parent session is never mutated and a background
  code spawn never holds the parent's depth.
- **A depth-0 direct call is the host's own action.** The envelope bounds the
  model's delegation. `runTaskChild` called directly (the MAA planner, a host) at
  depth 0 still runs even with `maxDepth: 0`; only a *nested* direct call is
  capped. The tree counter lives on the session object (and travels with its
  spawns), so a re-created root starts a fresh count; a discussion session shares
  one tree across all its stages. The cap is read from the envelope of the client
  that opens each spawn, so a tree that crosses transports is capped by the
  caller's declaration at that point. `maxSpawns` is absolute: `maxSpawns: 0`
  refuses even a host's depth-0 direct call, because the host said "no spawns".
- **A role prompt is a template, and a spawn adapts it.** A profile's
  `systemPrompt` is the shared role template; a granted per-spawn `system` is an
  adaptation **appended** after it (SP6/D11 — it no longer replaces the template,
  so the house style survives). On Anthropic with `withPromptCache()` the child's
  system goes out as **two blocks**: the template (with `cache_control`) and the
  adaptation plus the per-spawn objective block (unmarked), so two spawns share the
  cached prefix byte for byte. Other providers receive one joined system string
  , and Anthropic without
  the cache policy also stays on one joined string.
- **A spawn is a live session, not a call.** `continueWith(prompt)` (or the
  `sendToSpawn` export) runs another turn on the **same** child session, keeping its
  history and its configuration. Turns on one spawn are serialized by a chain, so a
  continuation queued while the first turn is still running waits for it and both
  settle exactly once; usage is banked per turn. A code-agent spawn has no chat
  session and cannot be continued.
- **A background result reaches the parent's next turn.** It waits in
  `session._pendingInputRows` and is placed after the history and before the new
  prompt; with no history it folds into the prompt, so a request never starts with an
  assistant row. A failed turn puts it back (delivery is at-least-once, never
  retracted). A parent turn that ended mid tool round is closed with a synthetic
  result for the unanswered call before the notification lands, so the pair is never
  split and the result is never dropped.
- **Spawn records are capped.** `getSpawnRegistry({client})` keeps at most 100
  spawn records per client; a settled record is evicted before a running one, so a
  long-lived client does not accumulate child sessions (more than 100 *running*
  spawns are all kept). `listSpawns`/`getSpawn` are the read API.
  A frozen client works: the registry keeps everything, so nothing has to be
  written to the client (the removed `_taskAgents`/… fields are adopted once if a
  host preset them, and deleted).
- **`handoff.tools` is an authority boundary.** `'none'` denies every tool;
  a code-configured array is an allowlist intersected with the parent's rules,
  so a child can never gain a tool the parent denied (capability tools included).
- **The token budget is the budget mechanism.** `maxTotalTokens` always works;
  `maxBudgetUsd` is enforced only against a provider that reports the amount
  itself. See `docs/MIGRATION.md`.
