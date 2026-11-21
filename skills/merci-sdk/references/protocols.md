# Protocols

The SDK speaks three agent protocols. Runnable proofs:
`examples/24_mcp_client.mjs` (+ `10_mcp_server.mjs`), `examples/25_mcp_server_http.mjs`,
`examples/26_a2a.mjs` (+ `25_a2a_server.mjs`),
`examples/27_acp_agent.mjs`.

## MCP — Model Context Protocol (`merci-sdk/tools`)

- Client: `McpClient` + `loadMcpTools` / `loadMcpToolsFrom` brings a stdio
  server's tools into a session as callable tools. The client declares and
  answers the `sampling`, `elicitation` and `roots` capabilities, and reaches
  resources and prompts (`listResources`, `readResource`, `listPrompts`,
  `getPrompt`).
- Roots and sampling are deprecated by MCP `2026-07-28` (SEP-2577; Logging
  too, not implemented here). They work until the first spec revision on or
  after 2027-07-28 at the earliest: pass directories as tool parameters and
  call the model directly instead of building on them.
- A tool may declare an `outputSchema`: the result arrives as
  `structuredContent` and is validated against the schema.
- Server: `createMcpServer` (stdio) and `createMcpHttpHandler` (Streamable
  HTTP; stateless — one transport per request, as the protocol requires)
  publish tools, resources and prompts.
- Workspace skills (`SKILL.md` frontmatter + optional `scripts/`) load via
  `loadSkillsFromDirectory`: frontmatter is YAML (legacy `key: value` still
  reads, with a warning). Runnable scripts run under their extension's
  interpreter and require approval.

## A2A v1.0.0 — agent-to-agent (`merci-sdk/tools`)

- Client: `loadA2ATool` speaks the v1.0.0 JSON-RPC binding (`SendMessage`,
  `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, uppercase
  task states, protobuf-JSON parts). The dialect is chosen from the agent
  card; the older slash-name dialect still works. Poll task end with
  `getA2ATask` against `A2A_COMPLETED_STATES`; `cancelA2ATask` cancels.
- Server: `createA2AServer` + `createA2AHttpHandler` publish a Merci agent
  as a v1.0 peer (agent card, task lifecycle, SSE stream).
- Skill routing: the selector travels in `params.metadata.skillId` and is
  stripped from the arguments. The Merci envelope (`metadata.merci`) restores
  as `ctx.agentContext` on the receiving skill; across the wire only
  objective/directive/refs travel, never conversation rows.
- Origin pinning: remote-agent URLs are SSRF-guarded — a peer that redirects
  somewhere unexpected fails loudly instead of being followed silently.

## ACP v1 — Agent Client Protocol

- `createAcpAgent` exposes a session as an ACP v1 agent with the full
  session lifecycle: `initialize`, `authenticate`, `session/new`,
  `session/load`, `session/list`, `session/delete`, `session/fork`,
  `session/prompt`, `session/cancel`. A turn surfaces as session updates
  (messages, thoughts, tool calls, plans).
- `permissionAllowed` models the fail-closed permission check for tool calls
  (`ACP_STOP_REASONS` names the stop conditions).
- Sessions: pass `createSession({sessionId, cwd, parentSessionId})` to give
  each ACP id its own merci session (concurrent prompts then run in
  parallel); a single `session` is shared by every id and its prompts are
  queued. A prompt's context arrives in `_meta.merci` and, like the
  `onTurnContext` bridge (which may return a cleanup), is scoped to that turn.
- Known limit: `session/load` validates the id but cannot replay history
  (the agent keeps no transcript) — do not build resume-on-ACP
  assumptions; persist threads with a session store instead.
