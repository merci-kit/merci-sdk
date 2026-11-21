# Agent definition files — `*.agent.yaml`

A repository can own the prompt, the tool set and the limits of an agent in one
YAML file. The loader validates it into a single deep-frozen spec, resolves the
declared groups and selectors against objects the host already built, and hands
the result to one of two consumers: a runnable session, or a subagent profile.

```js
import { applyAgentSpec, createAgentToolbox, loadAgentFile } from 'merci-sdk/agents';

const spec = await loadAgentFile({ path: 'agents/reviewer.agent.yaml' });
const toolbox = createAgentToolbox({ workspace });
applyAgentSpec({ session: client.session('gpt-5-mini'), spec, toolbox })
    .run({ initialInput: 'Review the staged changes.' });
```

This page is the contract: what the file owns and what the host owns, the format,
the tool model, the toolbox, the two consumers, the trust boundary, the limits,
the errors, and the honest limits.

---

## 1. What it is — and is not

| The file and its loader own | The host owns |
|---|---|
| the schema and every validation rule, the prompt text, the group/selector tool model, script containment and hashing, and the error reasons | the model session, the workspace, every MCP/ACP/A2A client, the approval callback, all credentials, and when to load or restart |

- **Inert data.** `loadAgentFile()` returns a deep-frozen plain object: no tool
  instance, no callback, no session. Adapters build those later, from a toolbox
  the host passes in.
- **A selector, not a definition.** The file may select a tool source the host
  already registered (`mcp:github/issues_*`). It can never create one: no server
  command, no URL, no `cwd`, no environment value.
- **Not a sandbox.** A script tool runs code under the interpreter its extension
  selects, with `cwd` set to the directory of the definition. It gets a short
  environment allowlist plus the parent keys the file names, and nothing else
  bounds what it does: network, filesystem and every privilege of the process
  are available to it.
- **Trusted, like `AGENTS.md`.** The file is repository-owned input, reviewed
  like code. A literal secret written in it is already exposed to the process
  that reads it; the format has no secret or environment expansion.
- **Two audiences.** A prompt and a group list are readable by a non-coder. The
  script and the MCP client behind a selector are not: someone must own them.

---

## 2. File location and format

```
agents/
├── reviewer.agent.yaml      # name: reviewer
└── scripts/
    └── word-count.mjs       # contained under agents/
```

- The directory is the host's choice. It passes a path to `loadAgentFile({ path })`
  or a directory to `loadAgentDirectory({ directory })`. There is **no walk-up,
  home-directory, package or remote discovery** and no file watcher.
- `apiVersion` must be exactly `merci.dev/v1alpha1`; `kind` must be exactly
  `Agent`. Anything else is `agent_unsupported_api_version` /
  `agent_unsupported_kind`.
- `metadata.name` must equal the file stem: `reviewer.agent.yaml` declares
  `reviewer`. The pattern is `^[a-z0-9][a-z0-9_-]{0,63}$`. A mismatch is
  `agent_name_mismatch`.
- A directory load is flat and sorted: `.agent.yaml` files only, no recursion,
  at most `agent_file_max_count` files. Two files declaring one name is
  `agent_duplicate_name`.

| Field | Required | Rule |
|---|---|---|
| `apiVersion` | yes | exactly `merci.dev/v1alpha1` |
| `kind` | yes | exactly `Agent` |
| `metadata.name` | yes | `^[a-z0-9][a-z0-9_-]{0,63}$`, equals the file stem |
| `metadata.description` | yes | one line, at most 500 chars; it is the roster description |
| `spec.instructions` | yes | non-empty after trim, at most 200,000 chars |
| `spec.model` | no | `default`, `tool`, `decision`, or a bare model id; `provider/model` is `agent_unknown_model` |
| `spec.tools.use` | no | catalog group or alias; `all` needs `allowDangerous` |
| `spec.tools.allow` / `deny` | no | selectors only; bare `*` needs `allowDangerous` |
| `spec.tools.mode` | no | `default`, `acceptEdits`, `bypassPermissions`; the last needs `allowDangerous` |
| `spec.tools.definitions[]` | no | unique name, not a catalog tool name, contained regular script with a supported extension |
| `spec.limits` | no | `maxIterations`, `maxDepth`, `timeoutMs`, `maxElapsedMs`; integers, clamped |

An **unknown key is a hard error at every level**, carrying the dotted field and
its source `line`/`column`, and every unknown key in the document is reported in
the same error. Nothing is merged into another object: each field is copied into
a new one, so `__proto__`, `constructor` and `prototype` are refused and never
reach a prototype.

---

## 3. A complete example

`agents/reviewer.agent.yaml`:

```yaml
apiVersion: merci.dev/v1alpha1          # the only version v1 reads
kind: Agent                             # the only kind v1 reads

metadata:
  name: reviewer                        # must equal the stem of reviewer.agent.yaml
  description: Reviews changes and counts words in a file.

spec:
  model: default                        # default | tool | decision | a bare model id
  instructions: |
    You review changes for correctness and regressions.
    List findings in severity order. Do not modify files.

  tools:
    use: [files]                        # a group: read, grep, glob (needs a workspace)
    allow: ["mcp:tickets/ticket_*"]     # a selector: only these tools, from a source the host registered
    deny: ["mcp:tickets/ticket_delete"] # deny wins, matched against the final advertised name
    definitions:
      - name: word_count                # advertised to the model as `word_count`
        description: Counts words in a path and returns JSON.
        script: scripts/word-count.mjs  # resolved at load, contained to this directory
        timeoutMs: 10000                # clamped to the agent_script_timeout_ms ceiling
        parameters:                     # JSON Schema; the model's arguments are validated before spawn
          type: object
          properties:
            path:
              type: string
          required: [path]
```

`agents/scripts/word-count.mjs` — the argument object arrives as one JSON argv:

```js
import { readFileSync } from 'node:fs';

const args = JSON.parse(process.argv[2] ?? '{}');
const text = readFileSync(args.path, 'utf8');
process.stdout.write(JSON.stringify({ words: text.trim().split(/\s+/).filter(Boolean).length }));
```

Host side:

```js
import { createAgentToolbox, loadAgentFile, resolveToolset } from 'merci-sdk/agents';

const spec = await loadAgentFile({ path: 'agents/reviewer.agent.yaml' });
const toolbox = createAgentToolbox({
    workspace: { path: 'workspace', root: 'workspace', key: 'demo' },
    mcp: { tickets: ticketTools },
});
const resolved = resolveToolset({ spec, toolbox });

resolved.names;    // as a set: read, grep, glob, mcp__tickets__ticket_list, word_count
resolved.denied;   // ['mcp__tickets__ticket_delete']
resolved.aliases;  // { 'mcp__tickets__ticket_list': { source: 'mcp', owner: 'tickets', original: 'ticket_list' } }
```

Every definition the file declares is granted; `deny` removed the one tool the
author excluded. The script was proven at load time (regular file, inside the
directory, known extension, under the size cap) and its bytes were hashed into
`spec.tools.definitions[0].scriptHash`.

---

## 4. The tool model

Three concepts, one namespace:

| Concept | Written where | Written by |
|---|---|---|
| **Group** (`files`, `web`, `todos`) | `spec.tools.use` | the file author — the beginner surface |
| **Selector** (`mcp:github/issues_*`, `host:write_file`) | `spec.tools.allow` / `deny` | the file author — the power surface |
| **Source** (a live MCP client, ACP agent, A2A peer, workspace) | `createAgentToolbox({ ... })` | the host, in code |

### Groups

The catalog is fixed. Each group yields exactly these runtime tool names and
needs exactly this toolbox key.

| Group | Runtime tools | Toolbox key | Notes |
|---|---|---|---|
| `files` | `read`, `grep`, `glob` | `workspace` | read-only: no write/edit tool exists in the SDK |
| `shell` | `execute_shell_command` | `workspace` + `approval` | the `approval` key is required, so a file cannot grant shell alone |
| `artifacts` | `save_artifact` | `workspace` | |
| `todos` | `load_todos`, `manage_todos` | `todos` | session-only |
| `memory` | `load_memory`, `save_memory` | `memory` | session-only |
| `knowledge` | `knowledge_query`, `knowledge_patch` | `knowledge` | session-only |
| `skills` | `load_skills` (+ the tools a loaded skill adds) | `skills` | session-only |
| `search` | `web_search` | `search` | session-only |
| `scrape` | `web_scrape` | `scrape` | session-only |
| `browser` | `browser` | `browser` | session-only |
| `delegate` | `task` | `delegation` | session-only |
| `state_machine` | `run_state_machine` | `stateMachine` | session-only |
| `web` | alias for `search` + `scrape` | both | expands at load |
| `all` | every catalog group | everything | needs `allowDangerous` |

### Selectors

```
native:<tool>            read, grep, execute_shell_command
host:<tool>              a tool the host passed in toolbox.tools
skill:<name>             one loaded skill tool
script:<name>            a tools.definitions entry
mcp:<server>[/<glob>]    mcp:github/issues_*
acp:<agent>[/<glob>]     acp:editor/format_*
a2a:<peer>[/<glob>]      a2a:researcher
*                        every tool; needs allowDangerous
```

- `use` takes groups only. `allow` and `deny` take selectors only, plus the bare
  `*`. A group name in `allow` is `agent_invalid_field`.
- The effective set is `(groups ∪ resolved allow ∪ declared definitions) − deny`.
  **Deny always wins**, order-independent, and patterns are matched against the
  final advertised names.
- `mcp:github` with no `/glob` means `mcp:github/*` — the whole source. `mcp:*`
  means "every registered server": it needs `allowDangerous` and expands over
  the servers the host registered at load time. A server registered later is
  not covered.
- Every bare namespace wildcard (`native:*`, `host:*`, `skill:*`, `script:*`,
  `mcp:*`, `acp:*`, `a2a:*`) needs `allowDangerous`; `host:*` in particular
  grants every host tool, including ones added later.
- `native:<tool>` grants the **whole group that owns the tool** — the workspace
  builds its tools together. `native:read` therefore also enables `grep` and
  `glob`. Use a group in `use:` when that is what you mean, and a deny rule when
  it is not.
- Any `script:` selector narrows which declared definitions are created. With no
  `script:` selector, every definition is granted because the file declared it.
- A selector that matches nothing is an error when the source can be enumerated:
  `native:`, `host:`, `skill:` and `script:` always; MCP/ACP/A2A naming an
  unregistered server (`agent_missing_group`); and a registered source with a
  non-empty catalog that the pattern misses. A registered source that
  advertises nothing yet is skipped, and an unregistered A2A peer is skipped,
  unless `options.strictDynamic: true` makes every miss an error.
- **A deny selector that matches nothing is also an error.** A typo in `deny`
  would otherwise grant the very tool the author meant to remove — the OpenCode
  failure this format exists to avoid. Only an unenumerated dynamic source is
  exempt, and it produces `warnings[]` on the result instead.
- No `use`, no `allow` and no `definitions` grants **zero** tools. That is not
  "inherit the session's tools": on a session with no resolved name,
  the session's own permission rules stay as the host set them, and
  `applyAgentSpec` adds an allowlist layer of `['__none__']` so no tool passes.

### External names are prefixed at load

```
mcp:github/issues_*  →  mcp__github__issues_list, mcp__github__issues_get
acp:editor/*         →  acp__editor__format
a2a:researcher       →  a2a__researcher__<skill>
```

A remote catalog is flat and controlled by the remote: a server tool named
`read` would shadow the native `read` and make `allow`/`deny` ambiguous.
Prefixing at load makes every name unique, makes the patterns match the name the
model actually sees, and follows the `mcp__server__tool` convention. Segments
are sanitized to `[A-Za-z0-9_-]` and capped at `agent_tool_name_max` with a
deterministic suffix. Native and host tools keep their names, so existing
prompts and skills keep working. `resolved.aliases` maps every granted name back
to `{ source, owner, original }` for errors, traces and logs.

---

## 5. The toolbox: `createAgentToolbox`

Every key is optional. A key is demanded only when the file asks for the group
that needs it, and the error names the group **and the missing key**.

```js
import { createAgentToolbox } from 'merci-sdk/agents';

const toolbox = createAgentToolbox({
    workspace,                        // files + artifacts; shell also needs approval
    approval,                         // the callback a gated tool asks before it runs
    tools: [writeFile],               // host tools, unprefixed; `host:write_file` selects one
    mcp: { github: githubTools },     // server id → the tools a client already loaded
    options: { strictDynamic: true }, // a dynamic miss is an error, not a skip
});
```

| Key | Enables | Error when a file needs it and it is absent |
|---|---|---|
| `workspace` | `files`, `artifacts`, and half of `shell` | `agent_missing_group` — `Group "files" needs workspace on the toolbox.` |
| `approval` | `shell` | `agent_missing_group` — `… needs approval …` |
| `todos: { store }` | `todos` | `agent_missing_group` — `… needs todos: { store } …` |
| `memory: { provider }` | `memory` | `agent_missing_group` — `… needs memory: { provider } …` |
| `knowledge: { dir }` | `knowledge` | `agent_missing_group` — `… needs knowledge: { dir } …` |
| `skills: [...]` | `skills` (at least one entry) | `agent_missing_group` — `… needs skills: [...] …` |
| `search` / `scrape` / `browser` | the three web groups | `agent_missing_group` naming the key |
| `stateMachine: { graph }` | `state_machine` | `agent_missing_group` — `… needs stateMachine: { graph } …` |
| `delegation: { agents }` | `delegate` (a non-empty agent list) | `agent_missing_group` — `… needs delegation: { agents } …` |
| `tools` | `host:` selectors | `agent_invalid_field` — `host:write_file matches no host tool.` |
| `mcp` / `acp` / `a2a` | the matching selectors | `agent_missing_group` — `mcp:github names no registered source. Registered: tickets.` |
| `options.strictDynamic` | turns a tolerated dynamic miss into an error | not applicable |

`createAgentToolbox` validates nothing itself: it is a plain bag holding live
host objects. One toolbox serves any number of agent files, and it is the only
place those objects live. An external tool is renamed and passed through; its
approval posture is whatever the loader that built it set.

---

## 6. The two consumers

```js
import { applyAgentSpec, loadAgentFile, toTaskAgent } from 'merci-sdk/agents';
import { withTaskAgents } from 'merci-sdk';

const spec = await loadAgentFile({ path: 'agents/reviewer.agent.yaml' });

// A. a runnable session (toolbox from §5)
const session = applyAgentSpec({ session: client.session('gpt-5-mini'), spec, toolbox });
const result = await session.run({ initialInput: 'Review the staged changes.' });

// B. a subagent profile
withTaskAgents({ client, agents: [toTaskAgent({ spec, toolbox })] });
```

|  | `applyAgentSpec({ session, spec, toolbox, allowDangerous })` | `toTaskAgent({ spec, toolbox, allowDangerous, model })` |
|---|---|---|
| Returns | the same session, fluent | a profile object for `withTaskAgents` |
| Applies | `withSystemMessage(instructions)`, keeps the host's `withPermissions` rules (mode only narrows), intersects the grant with `withToolAllowlist`, then component wiring, then `withAdditionalTools({ tools, replace: false })` | `name`, `description`, `model`, `systemPrompt`, `tools`, `toolNames`, the limits the file declared, and `definitionHash` / `scriptHashes` |
| Requires | a session with `withSystemMessage`, `withPermissions`, `withToolAllowlist` and `withAdditionalTools`; otherwise `ConfigurationError` | a loaded spec; otherwise `ConfigurationError` |
| Model | never changed — the session keeps the model it was built with | `spec.model`, or the `model` argument |

Both resolve through the same `resolveToolset`, so the two consumers cannot
disagree about what the file granted. `applyAgentSpec` never deletes a host
policy: the host's allow/deny lists survive, the file's mode can only narrow
approval, and the grant is an intersection. A resolved tool that would replace
an existing same-name session tool is refused with `agent_duplicate_tool`.
`spec.limits` reaches the profile consumer only; a runnable session keeps the
host's own `run({ options })` limits.

**Component groups are session-only.** `todos`, `memory`, `knowledge`, `skills`,
`search`, `scrape`, `browser`, `state_machine` and `delegate` need a live
session's step blocks and tool registration. In a profile they are refused with
`agent_profile_unsupported` instead of being silently dropped — and because
`web` expands to `search` + `scrape` and `all` expands to every group, both hit
the same refusal there. `files`, `shell` and `artifacts` work in both consumers.

---

## 7. Trust boundary

The file is repository-owned and trusted, like `AGENTS.md`. The loader still
refuses the things a trusted file should never need:

| Refused | Reason |
|---|---|
| a symlinked definition file, in either loader | `agent_symlink` |
| a symlinked script | `agent_symlink` |
| a script resolving outside the agents directory | `agent_script_outside_root` |
| a script with no known extension | `agent_script_unsupported` |
| a definition or script above its byte cap | `agent_too_large` / `agent_script_too_large` |
| a YAML alias bomb | `agent_parse_error` |
| `__proto__`, `constructor`, `prototype` at any depth | `agent_unknown_key` |
| an unknown key at any depth | `agent_unknown_key` |

The containment root is the definition's own directory for `loadAgentFile` (or
the `root` option), and the loaded directory for `loadAgentDirectory`. A script
is therefore under `agents/`, never above it. Its `cwd` is the directory of the
definition. The interpreter map is fixed: `.js`/`.mjs`/`.cjs` → `node`,
`.sh`/`.bash` → `bash`, `.zsh` → `zsh`, `.py` → `python3`, `.rb` → `ruby`,
`.pl` → `perl`. Nothing falls back to `sh`.

The child process does not inherit the parent environment. It gets a short
allowlist (`HOME`, `LOGNAME`, `PATH`, `SHELL`, and the platform basics) plus the
keys the definition names in `env:` — those are **parent key names**, never
values, and a key becomes available only because the file named it. Naming a
secret forwards it.

Each switch below needs `allowDangerous: true` when the file is loaded **and**
when a hand-built spec is resolved; the resolver re-checks the switches that
grant authority, so a caller cannot skip the loader. `deny: ["*"]` is not one of
them: denying everything grants nothing, so it needs no flag at either stage.

| Switch | What it grants |
|---|---|
| `spec.tools.mode: bypassPermissions` | no gated tool asks — only when the host session is already in that mode; a file can narrow, never widen |
| `spec.tools.use: [all]` | every group the toolbox can satisfy |
| `allow: ["*"]` | every tool |
| `allow: ["mcp:*"]` | every registered MCP server |
| `definitions[].requiresApproval: false` | a script tool that runs without asking |

Approval itself:

- A script tool is built with `runsCode: true` and `idempotent: false`.
- `requiresApproval` defaults to `true`. `acceptEdits` does **not** clear it:
  that mode only auto-approves a tool branded `editsFiles` and not `runsCode`.
- With no approval handler on the session, a gated tool fails closed.
- Every MCP tool is gated at the boundary even when the client was built
  without `approveDestructive`, because `readOnlyHint` comes from the remote.
  `idempotent: true` stays ungated only when the host sets
  `options.trustReadOnlyHints: true`. ACP and A2A tools are always gated: they
  carry no read-only claim to trust.
- Approval is a human gate, not containment. It decides whether a script runs;
  it does not limit what the script may do once it runs.

---

## 8. Limits

Every bound is a registered limit: `MERCI_LIMIT_<NAME>` in the environment or an
entry in `merci-limits.json` overrides the default (see
[`docs/LIMITS.md`](LIMITS.md)). A value declared in a file is clamped with
`Math.min` against the ceiling; it is never raised, and a declared value is
never rewritten upward to the runtime default.

| Limit key | Default | Bounds |
|---|---|---|
| `agent_file_max_bytes` | 1,048,576 | one definition file, on `stat` and after the read |
| `agent_file_alias_max` | 50 | YAML alias expansions in one document |
| `agent_file_max_count` | 256 | files one directory load reads |
| `agent_name_max` | 64 | `metadata.name` length |
| `agent_description_max_chars` | 500 | `metadata.description`, one line |
| `agent_instructions_max_chars` | 200,000 | `spec.instructions` |
| `agent_max_selectors` | 128 | entries in one `allow` or `deny` list |
| `agent_max_script_tools` | 32 | `definitions[]` entries per file |
| `agent_script_max_bytes` | 1,048,576 | one script file |
| `agent_script_timeout_ms` | 30,000 | one script run, and the ceiling for `definitions[].timeoutMs` |
| `agent_script_output_chars` | 100,000 | text one script tool returns |
| `agent_tool_name_max` | 64 | an advertised tool name, script or external |
| `agent_max_env_keys` | 32 | `env:` keys per definition |
| `agent_max_iterations` | 1,000 | ceiling for `spec.limits.maxIterations` |
| `agent_max_depth` | 16 | ceiling for `spec.limits.maxDepth` |
| `agent_timeout_ms` | 86,400,000 | ceiling for `spec.limits.timeoutMs` |
| `agent_max_elapsed_ms` | 604,800,000 | ceiling for `spec.limits.maxElapsedMs` |

`spec.limits` is passed through to a profile as declared; the runtime still
applies its own configured maximum when it runs the turn.

---

## 9. Errors

`AgentFileError` extends `MerciError` and carries the code
`MERCI-AGENT-FILE-ERR`, plus `reason`, `reasons[]`, `field`, `path`, `line`,
`column`, and `issues[]` — one `{ reason, field, line, column }` per collected
failure, so a document with two unknown keys reports both. `path` is the definition file or directory, never a value; `field` is
the dotted path inside the document; `line`/`column` locate the offending YAML.

- Validation **collects every failure**: one edit reports all of them in one
  error, and a directory load reports every bad file.
- Resolution collects every group and selector failure the same way and builds
  one error whose `reasons` are deduplicated.
- The message never quotes YAML text: a parse error would echo the offending
  line, and a line can hold a secret.

| Reason | Thrown when |
|---|---|
| `agent_read_error` | the file or directory is missing, unreadable, or not a regular file |
| `agent_too_large` | a definition or directory exceeds its byte or count cap |
| `agent_parse_error` | invalid YAML, a duplicate key, an alias bomb |
| `agent_not_a_map` | the document root is a sequence or a scalar |
| `agent_unknown_key` | a key outside the schema, including a prototype-touching one |
| `agent_invalid_field` | a value failed validation; `field` names it |
| `agent_unsupported_api_version` | `apiVersion` is not `merci.dev/v1alpha1` |
| `agent_unsupported_kind` | `kind` is not `Agent` |
| `agent_name_mismatch` | `metadata.name` differs from the file stem |
| `agent_duplicate_name` | two files in one directory declare one name |
| `agent_missing_group` | a group needs a toolbox key the host did not pass; or a selector names no registered source |
| `agent_profile_unsupported` | a component group was requested for a subagent profile |
| `agent_unknown_model` | `spec.model` names a `provider/model` pair |
| `agent_dangerous_mode` | a dangerous switch was used without `allowDangerous` |
| `agent_symlink` | a definition file (the leaf, not its parent directories) or a script is a symlink |
| `agent_script_outside_root` | a script resolves outside the agents directory |
| `agent_script_too_large` | a script exceeds `agent_script_max_bytes` |
| `agent_script_unsupported` | a script extension has no interpreter |
| `agent_duplicate_tool` | a script name collides with another definition or a catalog tool, or two sources resolve one tool name |

**Reasons are the contract; messages are not.** Branch on `reason` and
`reasons[]`; treat every message as prose that may change.

---

## 10. Honest limits

- **No write or edit tool exists in the SDK.** `files` is `read`, `grep`,
  `glob`. An agent file cannot grant file editing; a host that wants it must
  pass a write tool in `toolbox.tools` and select it with `host:`. "A coding
  agent from YAML" is not achievable today.
- **No reload and no watcher.** Unlike `WORKFLOW.md`, a definition is loaded
  once by the host. Edit it, then load it again (in practice: restart the run).
  There is no last-known-good state.
- **Dynamic selectors cannot be validated offline.** A tool list the host has
  not loaded cannot be checked. `options.strictDynamic: true` is the honest
  switch; without it, an empty dynamic source and an unregistered A2A peer are
  skipped instead of failing.
- **Profiles cannot wire components.** The nine component groups are
  session-only, and so are the `web` and `all` aliases that expand into them;
  a profile refuses them with `agent_profile_unsupported`.
- **`mcp:*` is not "every server".** It needs `allowDangerous` and still
  resolves only against registered server names. List the servers.
- **`spec.model` does not change a session.** `applyAgentSpec` keeps the model
  the session was constructed with; the field is used by `toTaskAgent`.
- **A file with no tools grants nothing.** When no group, selector or
  definition resolves to a name, the session gets an allowlist layer of
  `['__none__']`; it never means
  "inherit".
- **Approval is a human gate, not a sandbox.** A script runs with the process's
  privileges and is not idempotent, so a retry re-runs it.
- **The name rule implies the suffix.** The single-file loader does not check
  `.agent.yaml` itself, but `metadata.name` must equal the stem, so the file must
  be named `<name>.agent.yaml` in practice.
- **Containment is a directory, not a policy.** A script inside `agents/` may
  still read anything the process can read.

---

## Where to look next

[`examples/32_agent_files.mjs`](../examples/32_agent_files.mjs) is the live
walkthrough — it needs `PROVIDER` and its credentials in `secret.env`, and every
model call is real. It writes the file on screen, loads it, resolves
`use: [files]` + `host:lookup_policy` + the declared `word_count` script, then:
the model reads a note, runs the script tool for the real count, consults the
host tool, and answers; the same spec becomes a subagent through `toTaskAgent`,
and a parent session delegates to it live.
The public subpath `merci-sdk/agents` exports `loadAgentFile`,
`loadAgentDirectory`, `AGENT_API_VERSION`, `AGENT_KIND`, `AGENT_FILE_REASONS`,
the catalog (`AGENT_TOOL_GROUPS`, `AGENT_TOOL_GROUP_ALIASES`,
`AGENT_META_GROUPS`, `AGENT_SELECTOR_SOURCES`, `expandAgentGroup`,
`agentGroupToolNames`), the toolbox (`createAgentToolbox`, `resolveToolset`,
`parseSelector`, `prefixExternalTool`, `prefixExternalPattern`,
`sanitizeToolName`) and the two adapters (`applyAgentSpec`, `toTaskAgent`).
For the sibling contract that *does* watch and reload, see
[`docs/WORKFLOW_POLICY.md`](WORKFLOW_POLICY.md).
