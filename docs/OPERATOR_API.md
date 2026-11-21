# The operator API — the contract

The operator API is a **read-only window** into a running scheduler plus **one
bounded control action**: ask the scheduler to poll and reconcile now. It is a
mountable `(req, res) => Promise<void>` handler, not a server. The host creates
the HTTP server, chooses the bind address, and owns TLS and any reverse proxy.

```js
import { createOperatorHttpHandler } from 'merci-sdk/operator';

const handler = createOperatorHttpHandler({ getSnapshot: () => scheduler.snapshot() });
server.on('request', (req, res) => { void handler(req, res); });
```

This page is the whole contract: the boundary, every route and status code, the
response shapes, the mapping from the scheduler snapshot, refresh semantics, the
error envelope, the security boundary, the honest limits, the terminal renderer,
wiring, and the dependency on the scheduler.

---

## 1. What it is — and is not

| The handler owns | The host owns |
|---|---|
| routing, method checks, the Host allowlist, the JSON envelope, the refresh body cap and media-type check | `node:http` `createServer`, the bind address, TLS, authentication, and any reverse proxy |

- **No `createServer`.** The module imports no HTTP server; `node:http` names are
  type-only JSDoc imports.
- **No authentication, TLS, sessions, cookies, or CORS.** The loopback Host
  allowlist is the boundary (§7).
- **One write action.** `POST <basePath>/refresh` asks the scheduler to tick. It
  never writes to a tracker, mutates an item, or cancels a run.
- **No state of its own** except the in-flight refresh flag (§8).

The subpath exports five names: `createOperatorHttpHandler`, `createEventRing`,
`formatStatus`, `OPERATOR_API_VERSION` (`1`), and `OPERATOR_DEFAULTS`. The main
entry re-exports the three functions, not the constants.

---

## 2. Routes

Defaults: `basePath: '/api/v1'`, `statusPath: '/'`.

| Route | Method | Success | Failure modes |
|---|---|---|---|
| `GET <statusPath>` (`/` by default) | GET | `200 text/plain` status page | `503` text `snapshot unavailable`; `500` text `internal error` |
| `GET <basePath>/state` | GET | `200` JSON state | `503 snapshot_unavailable` |
| `GET <basePath>/items/<identifier>` | GET | `200` JSON detail | `400 invalid_identifier`, `404 item_not_found`, `503 snapshot_unavailable` |
| `GET <basePath>/<identifier>` (alias) | GET | `200` JSON detail | the same as the canonical item route; `state`, `refresh`, and `items` are reserved as alias segments, but below `/items/` they are ordinary identifiers |
| `POST <basePath>/refresh` | POST | `202` JSON refresh | `409 not_started`/`stopped`, `413 payload_too_large`, `415 unsupported_media_type`, `501 refresh_not_supported`, `503 refresh_failed`/`snapshot_unavailable` |

Every request is checked in this order: **Host allowlist → route match → method
→ identifier decode**. Consequently an unknown path with any method is `404`,
while a known path with the wrong method is `405` and carries an exact `Allow`
header (`GET` or `POST`). `HEAD` is `405`; the handler does not mirror `GET`.
Every response carries `cache-control: no-store`.

The table lists each route's own failures. Three statuses are cross-cutting:
`403 forbidden_host` (before routing), `405 method_not_allowed` (a known path
with a wrong method), and `500` (a snapshot whose getter throws, whatever the
route) — `500 internal_error` on the JSON routes, `500 internal error` as text
on the status page. A trailing slash is never ignored: on a fixed JSON route
(`<basePath>/state/`) it is `404`, and on an item route
(`<basePath>/items/<id>/`) it is `400 invalid_identifier`; `<basePath>/` is an
empty alias segment and is also `400`.

Routing details:

- Only the WHATWG-normalized pathname is matched. The query string is ignored.
- `basePath` is normalized at construction: it must start with `/`, must not be
  `/`, must not contain `?`, `#`, or whitespace, and trailing slashes are
  stripped. `'/ops/v1///'` becomes `'/ops/v1'`.
- `statusPath` is `null` (the text route is disabled and `/` is `404`) or a path
  starting with `/`; trailing slashes are stripped, while `/` stays `/`.
- `status_path_collision` is rejected at construction when the normalized
  `statusPath` equals `basePath`, `<basePath>/state`, `<basePath>/refresh`, or
  `<basePath>/items`; when it is one segment under `<basePath>/items/`; or when
  it is one segment under `<basePath>/` that is not `state`, `refresh`, or
  `items`.
- The item identifier is one path segment, percent-decoded. An empty segment
  (`<basePath>/items/`), a segment whose decoded value contains `/`
  (`<basePath>/items/a/b`, or `%2F`), and a malformed escape are
  `400 invalid_identifier`. `/items` with no segment is not a route (`404`); a
  deeper alias (`<basePath>/a/b`) is not a route (`404`).

---

## 3. Response shapes

### 3.1 State — `GET <basePath>/state`

```json
{
  "generatedAt": "2026-11-09T18:00:00.000Z",
  "counts": { "running": 1, "retrying": 1, "parked": 1, "claimed": 1, "completed": 1 },
  "running": [],
  "retrying": [],
  "parked": [],
  "totals": {},
  "limits": {},
  "scheduler": {},
  "policy": null,
  "rateLimits": null
}
```

`counts` is `running`, `retrying`, `parked`, `claimed`, `completed`; the first
three are the row-array lengths, and `claimed`/`completed` are the lengths of the
scheduler's id arrays. A terminal item is a count only; it is not a row.

Each row is an explicit projection with exactly these fields:

| List | Fields |
|---|---|
| `running` | `workItemId`, `identifier`, `url`, `state`, `lane`, `attempt`, `startedAt`, `lastProgressAt`, `threadId`, `workspacePath` |
| `retrying` | `workItemId`, `identifier`, `url`, `attempt`, `kind`, `dueAt`, `delayMs`, `errorName`, `errorCode` |
| `parked` | `workItemId`, `identifier`, `url`, `reason`, `since`, `nextCheckAt`, `attempts`, `continuations` |

`totals` carries `inputTokens`, `outputTokens`, `totalTokens`, `costUsd`,
`secondsRunning`, `dispatches`, `attempts`, `failures`, `usageComplete`,
`costComplete`. `costUsd` is `null` when the scheduler has no finite number;
`usageComplete`/`costComplete` default to `false`.

`limits` carries exactly `maxAttemptsPerItem`, `maxDispatches`, `maxTotalTokens`,
`maxTotalUsd`; a missing limit is `null`.

`scheduler` carries `started`, `stopped`, `tickCount`, `lastTickAt`,
`lastOutcome`, `pollIntervalMs`, `activeStates`, `terminalStates`. `lastOutcome`
is the outcome of the most recent tick (`ok`, `validation_error`,
`source_error`, `internal_error`, `in_flight`, `stopped`), or `null` before the
first tick: an operator can tell a blocked scheduler from an idle one.

`policy` is the workflow policy's health projection, or `null` when the host
mounted the handler without `getPolicySnapshot`. The key is always present, so a
consumer reads one shape. It carries `started`, `stopped`, `healthy`, `path`,
`source`, `watch`, `loadedAt`, `lastCheckedAt`, `warnings`, `reasons`, and
`lastErrorAt`. `reasons` are the last load's stable codes plus the field they
name (`invalid_config:agent.max_concurrent_agents`), `warnings` are warning
classes plus the key or state they name (`unknown_key:tracker.mystery`,
`invalid_by_state:Review`), and the effective config, the hook scripts and the
prompt text are **not** included. A throwing or malformed policy provider yields `null` rather than
failing the route: the policy surface never takes the operator API down.

`rateLimits` is always `null`: the field is stable for clients, but the
scheduler does not track provider rate limits. `null` means **not tracked**, not
"no limits".

A structurally incomplete snapshot does not throw: missing arrays become `[]`,
the derived counts become `0`, missing numeric totals become `0`, and missing
flags become `false`.
A snapshot object whose getter throws is the separate `500 internal_error` path
(§6). A `getSnapshot` that throws, returns `null`, returns a non-object (an
array included), or returns a Promise/thenable yields `503 snapshot_unavailable`.

### 3.2 Detail — `GET <basePath>/items/<identifier>`

```json
{
  "generatedAt": "2026-11-09T18:00:00.000Z",
  "identifier": "MER-1",
  "workItemId": "wi-1",
  "url": "https://tracker.example/MER-1",
  "status": "running",
  "workspace": { "path": "/tmp/ws/MER-1" },
  "attempts": { "current": 2, "continuations": 0 },
  "running": {},
  "retry": null,
  "parked": null,
  "recentEvents": []
}
```

- Lookup accepts `identifier` first, then `workItemId`, in `running` →
  `retrying` → `parked` order. `identifier` is the scheduler's key, so it wins
  when one value spells both. `workItemId` is the provider's id — the value
  every event payload carries — so a UI built from the feed can open the row it
  just rendered.
- `status` is `running`, `retrying`, or `parked`. There is no terminal status:
  a terminal item is no longer runtime state, the tracker is the source of
  truth, and the route returns `404 item_not_found`. A claimed-only item is
  transient and is also `404`.
- `workspace` is `{ path }` for a running row with a string `workspacePath`,
  otherwise `null`.
- `attempts.current` is the running attempt, else the retrying attempt, else the
  parked attempt count, else `0`. `attempts.continuations` is the parked
  continuations count, else `0`.
- `running`, `retry`, and `parked` are the projected row or `null`.
- `recentEvents` is filtered to this identifier, capped at
  `recentEventsLimit` (default 20), and re-projected through the ring allowlist.
  With no provider it is `[]`; a provider result that is not an array (including
  a Promise) becomes `[]`; a provider that throws **omits the field** and the
  rest of the response still succeeds. The provider is synchronous by contract.
- Each `recentEvents` record is `{ at, ...allowlisted fields }`; a record from
  the ring also carries `event`, copied from the envelope. `at` is an
  **epoch-millisecond** number: the envelope's numeric `ts` when it has one,
  else the existing `at` on an already-projected record, else the handler's
  `now()` (which is the ring's insert clock for an event without `ts`). The
  other keys are the fixed allowlist, and nothing else survives:
  `event`, `runId`, `parentRunId`, `sessionId`; `workItemId`, `identifier`,
  `attempt`, `owner`, `lane`, `state`, `priority`, `reason`, `failureClass`,
  `errorName`, `errorCode`; `idleMs`, `delayMs`, `dueAtMs`, `nextCheckAt`,
  `durationMs`; `attempts`, `continuations`, `cleanup`, `outcome`, `fetched`,
  `dispatched`, `running`, `retrying`, `parked`, `claimed`, `drained`; `op`,
  `category`, `source`, `index`, `file`, `name`, `success`; `promptChars`,
  `reasons`, `warnings`; `limit`, `totals`, `usage`, `errors`, `changed`,
  `concurrency`, `activeStates`, `terminalStates`, `pollIntervalMs`,
  `stallTimeoutMs`; and the workspace keys `key`, `path`, `strategy`, `branch`,
  `createdNow`, `forced`, `hook`, `exitCode`, `timedOut`, `fatal`.
  These are event records, not a snapshot projection, so they are not ISO
  strings. `name` is a tool name string, kept only for `tool:*` and capped at
  128 characters; `success` is a boolean; `sessionId` is a non-empty string
  capped at 128 characters, and is absent rather than `null` otherwise.

### 3.3 Timestamps

The fields in the table below are ISO 8601 strings or `null`. `recentEvents[].at`
is the documented exception: it is epoch milliseconds (§3.2).

| Response field | Snapshot source | Conversion |
|---|---|---|
| `generatedAt` (state and detail) | the handler's `now()` | epoch ms → ISO |
| `running[].startedAt` | row `startedAt` | epoch ms → ISO |
| `running[].lastProgressAt` | row `lastProgressAt` | epoch ms → ISO |
| `retrying[].dueAt` | row `dueAtMs` | epoch ms → ISO |
| `parked[].since` | row `since` | epoch ms → ISO |
| `parked[].nextCheckAt` | row `nextCheckAt` | epoch ms → ISO |
| `scheduler.lastTickAt` | snapshot `lastTickAt` | epoch ms → ISO |

The conversion accepts an epoch-ms number, a `Date`, or a parseable date string;
anything else (a non-finite number, an empty or unparseable string) is `null`.
No other field is converted.

### 3.4 Ring prefixes and correlation

The ring records `scheduler:*`, `work_item:*`, `workspace:*`, and
`workflow_policy:*` by default. `prefixes` **replaces** that set, so a host that
wants the old layer as well keeps the defaults explicitly:

```js
import { DEFAULT_PREFIXES } from 'merci-sdk/operator';

const system = await createOrchestration({
    // …
    operator: true,
    ring: {
        limit: 500,
        prefixes: [...DEFAULT_PREFIXES, 'run:', 'session:', 'tool:', 'artifact:']
    }
});
```

`ring.limit` wins over `operator.ringLimit`; without either the facade uses
200. Supplying `ring` wires the ring even when the operator handler is off. A
non-object `ring` or an unknown key rejects construction with
`ConfigurationError` and option `ring`. Old-layer `run:*`/`tool:*`/`session:*`
records reach the ring only when the engine session is constructed with the
same `MerciEventEmitter`; the facade does not rebuild the host's client
sessions.

Correlation is by field, not by a session-to-item mapping:

| Field | Events | Rule |
|---|---|---|
| `runId` | all | the emitting execution |
| `parentRunId` | all | the enclosing execution (`null` at the root); a scheduler attempt's child run carries the attempt's `runId` here, so this is the executable join |
| `workItemId` | `work_item:*`, `workspace:*` | the provider's id |
| `identifier` | `work_item:*`, `workspace:*` | the human key |
| `sessionId` | stored from any event that carries a string; SDK producers set it on `session:*`, `run:*`, `tool:*`, `artifact:*` | a non-empty string capped at 128 chars, absent (not `null`) otherwise. A scheduler attempt's agentic run adopts an auto-minted session id, so its `run:*`/`tool:*` records do carry one the host cannot recognise. In-process correlation only, not an authentication token. |
| `name` | `tool:*` | a tool name string capped at 128 chars; every other event drops it |
| `success` | any event | boolean values only; any other value is dropped |

SDK-produced old-layer records (`run:*`, `session:*`, `tool:*`, `artifact:*`)
never carry `identifier`; the ring does not block a host from adding one. The
item route therefore cannot show them; they are visible in the ring only. There
is no automatic mapping from a session id to a work item. A host that needs the
join emits its own join event or uses the `runId` that the engine nests under
the attempt (and `parentRunId` on the child run).

---

## 4. Field mapping from the Symphony wire format

The parent comparison used Symphony's snake_case payload. The SDK is camelCase,
so this API is camelCase; a client maps names once, and there is no second
snake_case shape.

| Symphony field | Operator API field | Meaning |
|---|---|---|
| `codex_totals` | `totals` | the run totals object |
| `rate_limits` | `rateLimits` | always `null` ("not tracked") |
| `attempts.restart_count` | `attempts.current` | the current attempt number |
| `attempts.current_retry_attempt` | `attempts.continuations` | the parked continuations count |
| `logs` | not exposed | the SDK has a logger and an OTel exporter; the API does not duplicate them |
| `last_error` | not exposed | a retrying row carries `errorName`/`errorCode`; a parked row carries `reason` |

---

## 5. Refresh semantics — `POST <basePath>/refresh`

Checks run in this exact order:

1. **Provider first.** No `refresh` function → `501 refresh_not_supported`,
   before the body or the snapshot is read.
2. **Media type.** The `Content-Type` token must be `application/json`,
   case-insensitive, parameters allowed (`Application/JSON; charset=utf-8` is
   accepted). A missing or different type — including
   `application/json-patch+json` and `application/jsonp` — is
   `415 unsupported_media_type`.
3. **Declared size.** A numeric `Content-Length` greater than `maxBodyBytes`
   (default 1024) is `413 payload_too_large` **without reading the body**.
4. **Body.** The body is drained up to `maxBodyBytes` and ignored (empty or
   `{}` are both fine). Exceeding the cap mid-stream is `413`; an aborted
   request ends the handler with no write.
5. **Snapshot precheck.** An unavailable snapshot is `503
   snapshot_unavailable`; `stopped === true` is `409 stopped`;
   `started === false` is `409 not_started`.
6. **Coalescing.** If this handler instance is already awaiting a refresh, the
   request returns `202 { queued: false, coalesced: true, requestedAt,
   operations }` immediately. A scheduler-internal in-flight tick is invisible:
   `WorkScheduler.refresh()` awaits `tick()` and resolves with `undefined`; a
   stopped or concurrent tick is single-flight and only **emits**
   `scheduler:tick { outcome: 'stopped' | 'in_flight' }`. It therefore has no
   return value that could tell this handler a tick was already running.
   `queued: true` means **this request invoked `refresh()`**.
7. **Await the tick.** Success returns `202 { queued: true, coalesced: false,
   requestedAt, operations: ['poll', 'reconcile'] }`. A throw maps a stable
   `not_started` or `stopped` reason (on `error.options.reason` or
   `error.reason`) to `409`, and anything else to `503 refresh_failed`. The
   thrown message is never copied.

The two `409` sources are distinct in origin but identical on the wire:

- `stopped` normally comes from the snapshot precheck: a stopped scheduler's
  `refresh()` resolves without throwing (the tick emits `outcome: 'stopped'`),
  so the precheck is what produces the `409`. A host wrapper that throws a
  `stopped` reason is mapped to the same code.
- `not_started` comes from the precheck when `started === false`, and may also
  come from a thrown `SchedulerError` with reason `not_started` (for example
  before `start()`).

The coalescing flag is cleared on success **and** on a throw, so one failed
refresh does not wedge the route. A restart loses only the flag; the snapshot
and every work item live in the scheduler.

---

## 6. Error envelope

JSON routes answer `application/json; charset=utf-8`:

```json
{ "error": { "code": "item_not_found", "message": "Work item not found." } }
```

| Code | Status | Message |
|---|---|---|
| `forbidden_host` | 403 | `Forbidden host.` |
| `not_found` | 404 | `Not found.` |
| `method_not_allowed` | 405 | `Method not allowed.` |
| `invalid_identifier` | 400 | `Invalid work item identifier.` |
| `item_not_found` | 404 | `Work item not found.` |
| `snapshot_unavailable` | 503 | `Snapshot unavailable.` |
| `unsupported_media_type` | 415 | `Unsupported media type.` |
| `payload_too_large` | 413 | `Payload too large.` |
| `refresh_not_supported` | 501 | `Refresh is not supported.` |
| `not_started` | 409 | `Scheduler is not started.` |
| `stopped` | 409 | `Scheduler is stopped.` |
| `refresh_failed` | 503 | `Refresh failed.` |
| `internal_error` | 500 | `Internal error.` |

The set is fixed, and these envelopes carry only a fixed code and message: no
`err.message`, stack trace, tracker payload, prompt, or tool argument reaches a
body. That guarantee covers the handler's own output — the item route's
`recentEvents` feed is field-filtered, not content-filtered, which is the
limitation in §8. A `405` additionally carries the exact `Allow` value.

The text status route never returns JSON: its snapshot failure is `503
snapshot unavailable` and an unexpected failure is `500 internal error`.

---

## 7. Security boundary

- **Loopback by default.** `allowedHosts` defaults to `['localhost',
  '127.0.0.1', '::1']`. The check reads the `Host` header, compares the hostname
  only (the port is ignored; IPv6 brackets and a trailing root label are
  stripped), and refuses an absent or unparseable Host with `403
  forbidden_host`. This is DNS-rebinding protection, not authentication.
- **`allowAnyHost: true`** bypasses the allowlist and must be a real boolean
  (`undefined` uses the default; any other value is a construction error). It is
  a **proxy-only** decision: use it only when an authenticating reverse proxy
  already restricts access.
- **No auth, no TLS, no sessions, no CORS.** The handler never sends an
  `access-control-allow-origin` header. Put it behind a proxy if it is not
  loopback.
- **The JSON-only refresh is the CSRF control.** A cross-origin HTML form
  cannot set `application/json` without a CORS preflight, so a simple
  cross-site request reaches `415` instead of starting a tick.
- **Treat the data as sensitive.** The state and item routes expose identifiers,
  tracker URLs, states, workspace paths, lane names, error names, and codes:
  everything the handler's explicit projections take from `snapshot()`, with
  `priority` dropped from the running row and the `claimed`/`completed` arrays
  reduced to counts, plus the event records when a provider is configured.
  Bind to loopback, or place the handler behind the same access control as the
  tracker.
- `HEAD` is `405`, so no route answers a body-less probe implicitly.

---

## 8. Honest limitations

- **The event allowlist is field-level, not content-level.** The ring records
  the default prefixes and projects by key; it is bounded by record count and
  per-field length (`name` and `sessionId` are capped at 128 characters). A
  host-supplied `recentEvents` provider can place arbitrary prose inside an
  allowlisted string field (`reason`, `errorName`, `path`, or an entry of
  `errors`); prompts, tool arguments, and descriptions are dropped by key, not
  by content. A ring fed by the scheduler and workspace emitters cannot leak
  them, because those producers emit scalars; the risk is a host-written
  provider that returns records of its own.
- **The item feed is work-item-scoped.** Old-layer records (`run:*`,
  `session:*`, `tool:*`, `artifact:*`) carry no `identifier`, and a
  `workspace:*` record carries one only when the manager remembers it, so
  filtering the feed by identifier cannot show those records. They are visible
  in the ring, not to `GET <basePath>/items/<identifier>`.
- **Routing uses the WHATWG-normalized pathname.** `./` and `../` segments
  normalize before matching, and a percent-encoded segment is decoded after
  routing (`%C3%BC` reaches the identifier as `ü`); a literal `%2F` decodes to
  `/` and is an invalid identifier. Node's HTTP parser rejects a raw non-ASCII
  byte in the request target with its own `400` before the handler runs, so
  clients must percent-encode. If a reverse proxy rewrites the path, the
  rewritten, normalized pathname is what matches.
- **The handler holds no state except the refresh coalescing flag.** A restart
  loses the flag, never data: the snapshot and the items belong to the
  scheduler. The flip side is that two handler instances do not coalesce with
  each other; one handler per scheduler is the intended mount.
- **`getSnapshot` is synchronous by contract.** The handler reads it inline on
  every route, so a slow provider blocks that request (and, in one process, the
  event loop). Implement it as the scheduler's in-memory `snapshot()`; cache an
  asynchronous source before exposing it here. `getPolicySnapshot` follows the
  same rule, is read on the status and state routes only, and is optional.

---

## 9. Terminal status renderer

`formatStatus({ snapshot, policy, now, maxRows })` returns deterministic plain
text and is the same renderer `GET <statusPath>` serves. `policy` is optional: a
host without one gets exactly the output below.

```
MerciSDK operator | running | tick 12 | poll 30s
Running (1)
  MER-1  attempt 2  In Progress  0:04:12  /tmp/ws/MER-1
Retrying (0)
  (none)
Parked (1)
  MER-3  attempts_exhausted  since 2026-11-09T18:00:00.000Z  attempts 5
Totals: 7400 tokens | $0.4200 | 0:30:34 | 12 dispatches | 2 failures | usage complete | cost complete
```

- The header says `running` only when `started` is true and `stopped` is not;
  otherwise `stopped`. `poll` prints `pollIntervalMs / 1000` seconds (a fraction
  is kept, for example `1.5s`). A known `lastOutcome` appends ` | last <outcome>`,
  so a `validation_error` is visible in one line.
- With a policy, a `Policy:` line follows the header and its reason and warning
  codes print as indented `reason:`/`warning:` lines:
  `Policy: healthy | watch active | loaded <ISO>` or
  `Policy: failed | watch active | last error <ISO>` plus the codes. At most ten
  codes print, then `  ... +N more` (`maxRows` may lower the cap, never raise it
  past ten). Without a policy the line is absent, so existing output is
  unchanged.
- Sections are `Running`, `Retrying`, `Parked`; each prints its row count and
  `(none)` when empty.
- Running rows print the sanitized identifier, `attempt`, state, and duration
  `H:MM:SS` from `now - startedAt`; a missing start prints `-`. A workspace path
  is appended when it is a non-empty string.
- Retrying rows print `due in Ns` from `dueAtMs - now`, rounded up and clamped
  at `0`, plus `errorName`.
- Parked rows print the reason, then `since <ISO>` (or `-`), then the attempt
  count — `MER-3  attempts_exhausted  since …  attempts 5`.
- Totals print tokens, cost as four decimals (`$0.4200`) or `$unknown`, running
  time, dispatches, failures, and the `usage`/`cost` completeness flags.
- More than `maxRows` rows in a section prints `  ... +N more`; `maxRows`
  defaults to 50 and must be an integer ≥ 1.
- Every tracker-controlled string (`identifier`, `state`, `reason`,
  `errorName`, `workspacePath`) passes through a sanitizer: control characters
  (`\x00`–`\x1f`, `\x7f`, including ANSI escapes and `\r`) become `?`, and a
  non-string or empty value becomes `-`. The renderer adds no ANSI.
- There is no per-row token field because the snapshot does not carry one; only
  the totals line has tokens. No line ends in whitespace.
- `now` may be a number or a function and is resolved once.

---

## 10. Wiring

Everything below is offline. No model call is made; the source snapshot is the
scheduler's own in-memory read.

```js
import { createServer } from 'node:http';
import { createOperatorHttpHandler, createEventRing } from 'merci-sdk/operator';

const ring = createEventRing({ emitter: schedulerEvents, limit: 200 });

const handler = createOperatorHttpHandler({
    getSnapshot: () => scheduler.snapshot(),          // required, synchronous
    getPolicySnapshot: () => policy.snapshot(),       // optional; policy health
    refresh: () => scheduler.refresh(),               // optional; absent → 501
    recentEvents: ({ identifier, limit }) => ring.list({ identifier, limit }), // optional
    basePath: '/api/v1',
    statusPath: '/',                                  // null disables the text page
    allowedHosts: ['localhost', '127.0.0.1', '::1'],
});

const server = createServer((req, res) => { void handler(req, res); });
server.listen(0, '127.0.0.1');
```

- The host owns the server, its bind address, and TLS. Mount the handler on an
  existing server with `server.on('request', ...)` if the host already has one.
- `recentEvents` is optional; without it the detail route reports `[]`.
- `getPolicySnapshot` is optional; without it `state.policy` is `null` and the
  status page prints no `Policy:` line. Pass `WorkflowPolicy.snapshot()` — the
  handler projects health and codes only.
- `createEventRing` needs an emitter with `onAny` (a `MerciEventEmitter`), keeps
  the last `limit` records, and subscribes when it is created. **Stop the ring
  when the scheduler stops** (`ring.stop()`), or the subscription outlives the
  work.
- The host closes its own server; the handler has no `close()` and nothing else
  to release.

---

## 11. Dependencies

- **The scheduler is the source.** The handler consumes `snapshot()`, whose
  shape is specified in §3 of this page, and `refresh()`, the tick specified in
  [`docs/SCHEDULER.md`](SCHEDULER.md). It does not import the scheduler module;
  a fake `{ snapshot, refresh }` drives the whole contract in the tests, so any
  provider of that shape works.
- **No new runtime dependency.** The implementation uses the standard library
  and two existing SDK modules (`ConfigurationError`, `requestHostAllowed`).
- **The ring is created after the policy's startup load**, so a hand-wired ring
  never holds `workflow_policy:loaded`; it holds every later reload, failure,
  and watch error. The facade has the same order.
- **Wiring all four** is `createOrchestration` in
  [`docs/ORCHESTRATION.md`](ORCHESTRATION.md). This page documents the handler;
  the facade is what feeds it, the policy projection included.

---

## Where to look next

The scheduler contract is [`docs/SCHEDULER.md`](SCHEDULER.md); the workspace
lifecycle it drives is [`docs/WORKSPACES.md`](WORKSPACES.md); the composition
root that wires all four is [`docs/ORCHESTRATION.md`](ORCHESTRATION.md). The public subpath
is `merci-sdk/operator`, and the three functions are also on the main entry.
A runnable live walkthrough is
[`examples/31_orchestration.mjs`](../examples/31_orchestration.mjs).
