# Providers

Two axes, one session shape. `ProviderType` (`lib/core/constants/providers.mjs`)
names the seven providers; `StandardType` (`lib/core/constants/standards.mjs`)
names the three wire standards. A provider is an endpoint, its credentials and
its model catalogue; a standard is the wire contract its client speaks. Two
providers on one standard differ in tier and capability, not in wire shape.

| `ProviderType` | Value | Standard | Wire |
| --- | --- | --- | --- |
| `OPENROUTER` | `openrouter` | `oai` | `completions`, `responses` |
| `OPENAI` | `openai` | `oai` | `completions`, `responses` |
| `LOCAL` | `local` | `oai` | `completions` |
| `GOOGLE_GENAI` | `google_genai` | `gai` | `generateContent` |
| `VERTEX` | `vertex` | `gai` | `generateContent` |
| `ANTHROPIC` | `anthropic` | `aai` | `messages` |
| `OPENCODE` | `opencode` | `oai` | `completions`, `responses` |

| Standard | Contract | Providers |
| --- | --- | --- |
| `oai` | OpenAI Chat Completions **and** the Responses API | `openai`, `openrouter`, `opencode`, `local` |
| `aai` | Anthropic Messages | `anthropic` |
| `gai` | Google `generateContent` | `google_genai`, `vertex` |

There is no `DEFAULT` sentinel: `resolveProvider()` reads `PROVIDER` from
`secret.env` and returns the concrete provider value.

## Credentials

```js
const provider = resolveProvider(); // reads PROVIDER from secret.env
const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
```

`resolveProvider()` has no `DEFAULT` sentinel: with no argument it reads
`PROVIDER` and throws `ConfigurationError` when that value is missing or
unknown; its optional `provider` field returns the argument as given.
`initializeClient` returns the resolved `provider` beside the client; that
value is on `client.provider` and `session.provider`, and `session.standard` is
derived from it.

`secret.env` carries `PROVIDER=<one of the values above>` plus that provider's
credentials: `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`),
`ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_BASE_URL`), `GEMINI_API_KEY`,
`OPENROUTER_API_KEY` (+ optional `OPENROUTER_URL`), `OPENCODE_API_KEY` (+
optional `OPENCODE_URL`, `OPENCODE_TIER=zen`), `JAI_TOKEN`,
`VERTEX_CREDENTIALS` (service-account JSON path) + `VERTEX_LOCATION`, and
`LM_STUDIO_URL` for local (no API key). `loadCredentials({ provider })` reads
exactly what `initializeClient` expects — pass its result through, do not
rebuild the options object by hand. Never commit `secret.env`, never log keys.

A base URL resolves in this order, highest first: `options.baseURL` (a non-empty
string) → the provider's URL env key (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`,
`OPENROUTER_URL`, `LM_STUDIO_URL`, `OPENCODE_URL`; trimmed, blank ignored) →
the descriptor default (for `opencode`, `OPENCODE_TIER=zen` picks
`https://opencode.ai/zen/v1`) → the vendor SDK default. `null` means "unset".
This holds for `initializeClient`, `loadCredentials` and direct client
construction; `loadCredentials` keeps a `baseURL` key whose value is
`undefined` when the env var is unset or blank (`opencode` resolves to its tier
URL instead). Any other explicit `baseURL` —
empty, whitespace-only or non-string — throws `ConfigurationError`. On
`anthropic`, `options.anthropicOptions.baseURL` is the vendor SDK's own option
bag: it wins over the flat option for a directly constructed `AaiClient`;
`initializeClient` does not forward it.

## Model tiers (no hardcoded ids)

- Orchestrators, judges, planners: `getDefaultModel({ provider })`.
- Cheap subagents and tool models: `getToolModel({ provider })`.
- Embeddings: `getEmbeddingModel({ provider })` (Anthropic has no embedding
  endpoint).
- Open a conversation: `client.session(model)` (a string) or
  `client.sessionWithId({ model, sessionId })` to pin the conversation id.

## Subpath imports

Import only what the feature needs — each entry has its own `types`:

| Import | Module |
| --- | --- |
| `merci-sdk` | root: clients, sessions, messages, orchestration, memory |
| `merci-sdk/oai` | `oai` standard: `openai`, `openrouter`, `opencode`, `local` |
| `merci-sdk/gai` | `gai` standard: `google_genai`, `vertex` |
| `merci-sdk/aai` | `aai` standard: `anthropic` |
| `merci-sdk/json` | JSON support |
| `merci-sdk/tools` | tools (MCP, A2A, skills, shell) |
| `merci-sdk/acp` | ACP agent |
| `merci-sdk/planning` | DAG planning |
| `merci-sdk/messaging` | unified message shapes |

## Transport seam

The unified methods cover sessions, messages, embeddings and model lists. The
call-level transport seam is `client.transport` (replaceable in tests and
cassettes). For the `oai` standard it is the SDK's built-in `fetch` connector,
not a vendor SDK object — the four `oai` providers need no vendor SDK. Configure
it with `transportOptions` (`fetch`, `defaultHeaders`, `timeout`, `maxRetries`).
The `aai` and `gai` clients expose their vendor SDK object in the same slot. The
Prefer the unified methods; drop
to the seam only for a call no unified method covers.

## Protocol vs provider (do not confuse)

`ProtocolType` (`chat`, `responses`, `task`, `completions`, `messages`,
`generateContent`) is the wire contract a session speaks — not the provider.
Provider tiers (GenAI vs Vertex, OpenRouter vs plain OpenAI) are selected by the
provider/`PROVIDER`, never by `withProtocol()`. `withProtocol()` is for the rare
case of forcing a contract on a compatible endpoint.

## Provider choice heuristics

- Need Responses-API features (`previousResponseId`, `store`) or
  OpenAI-specific knobs (`serviceTier`, `logprobs`, `promptCacheKey`): `openai`.
- Need Anthropic prompt caching (`cachePoints`) or Claude models: `anthropic`.
- Need Gemini/Vertex grounding or `cachedContent`: `google_genai` / `vertex`.
- Need price/usage passthrough for money budgets: a gateway provider
  (`openrouter`) that reports `usage.cost` — the SDK never prices anything
  itself (see `safety.md`).
- Offline/privacy: `local`.
- Unsure: the unified parameter builder (`withParameters({ params })`)
  accepts every knob; a provider ignores what its wire has no shape for.
  `examples/02_conversation.mjs` exercises the knobs end to end.
