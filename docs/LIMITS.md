# Limits — every bounded number is a setting

The SDK ships 321 bounded numbers: loop turns, tool timeouts, prompt caps, retry
budgets, body sizes, retention windows, log widths. Every declared limit lives
once in `lib/core/constants/limits/`, is resolved per call, and is overridable
without a rebuild. The CI gate keeps new limit-shaped declarations out of the
code that uses them (see "Adding a limit" for exactly what it scans).

## Precedence

Later layers win:

| # | Layer | Source |
|---|-------|--------|
| 1 | Code default | `lib/core/constants/limits/*.mjs` |
| 2 | Project file | `merci-limits.json` (or `MERCI_LIMITS_FILE`) |
| 3 | Environment | `secret.env` / the real process environment |
| 4 | Programmatic | `setLimits({ values })` |
| 5 | Kill switch | `MERCI_LIMITS=limits_off` or `setLimits({ disabled: true })` |

The switch sits above the data, not inside it: it suspends enforcement and never
erases the configured value, so turning it off restores exactly the value that
won before.

`unbounded` is the value the switch hands out. It equals the **default** when
lifting would crash, stall, or invert a meaning: concurrency, depth, fan-out and
redirect caps; poll, interval, delay, backoff and jitter cadence; and any key
whose default `0` means "none", "disabled" or "off". It equals the **max** only
when lifting relaxes a bound without those effects: retention rows, memory and
size ceilings, timeouts without a zero sentinel, retry and turn counts, and
thresholds. `unbounded` is never below the default or above the max.

Both halves have a visible reason. `scheduler_poll_interval_ms` lifted to its
`max` is one wake-up a day, so the SDK looks hung; `tool_timeout_ms` lifted from
its `0` sentinel adds a 24 h timeout that nothing asked for, turning "none" into
"some". Jitter is the third shape: `1` is maximum jitter, not "no jitter", so
`transient_backoff_jitter` holds `0.2`.

A bound that exists to break a hang *inside* the SDK — a drain wait, a lock
acquisition ceiling, a stall detector — also holds its default, because lifting
it means the hang happens. Only a bound on waiting for something external (a
human, a probe, a page) may lift to the ceiling.

A guard keeps its default even under the switch, unless
`MERCI_LIMITS_ALLOW_GUARD_OFF=1`. A guard that is also a concurrency or fan-out
cap (`mcp_http_sessions_max`, `workflow_alias_max`) declares `unbounded = max`
so a deliberate guard-off still has a ceiling, but the blanket switch never
lifts it.

## Environment

Each key has one env name, `MERCI_LIMIT_<KEY>`:

```ini
# one value
MERCI_LIMIT_MAX_ITERATIONS=8
MERCI_LIMIT_STREAM_TIMEOUT_MS=240000

# suspend one limit (it becomes unbounded, not zero)
MERCI_LIMIT_READ_MAX_BYTES=off

# suspend everything
MERCI_LIMITS=limits_off
MERCI_LIMITS=limits_on

# suspend a list
MERCI_LIMITS_DISABLED=max_iterations,tool_output_max_chars
```

`off`, `none`, `unlimited`, `disabled` and `null` are accepted for one limit.
`limits_off`/`limits_on`/`off`/`on`/`0`/`1` are accepted for the switch.

A value that is not a number falls back to the default and warns once. A value
outside the declared `min..max` is clamped and warns once. A misspelled key in
the config file or in `MERCI_LIMITS_DISABLED` warns and is ignored, so a typo
never fails open silently.

Older names are still accepted for compatibility, with `MERCI_LIMIT_*` winning
when both are set.

## Project file

`merci-limits.json` in the working directory, or any path in
`MERCI_LIMITS_FILE`:

```json
{
  "values": {
    "max_iterations": 8,
    "read_max_bytes": 102400,
    "browser_max_urls": "off"
  },
  "disabled": ["tool_output_max_chars"]
}
```

An unknown key warns and is ignored. A malformed file warns and behaves as if
absent. `reloadLimits()` re-reads it without a restart.

## Programmatic

```js
import { getLimits, setLimits, resetLimits, LIMIT_DEFAULTS } from 'merci-sdk';

getLimits();                              // [{ key, value, source, default, env, guard, mutable, timer, disabled, doc }]
setLimits({ values: { max_iterations: 8 } });
setLimits({ disabledKeys: ['tool_output_max_chars'] });
setLimits({ disabled: true });             // kill switch on
setLimits({ disabled: false });            // restore the prior winner
resetLimits();                             // drop programmatic state; env and file still apply
```

`getLimits()` and `LIMIT_DEFAULTS` are read-only views. Assigning to a key is a
configuration error, not a silent no-op.

## CLI

```
/limits                 # effective values that differ from their defaults
/limits all             # every key, value and source
/limits off | on        # the kill switch
/limits <key> <value>   # this session only; not persisted
```

## Safety guards

Thirty-one keys are marked `guard: true`: the DoS caps (SSE line size, error-body
size, raw-body, file-read, live MCP HTTP sessions (`mcp_http_sessions_max`),
A2A/MCP request-body and run-command buffer caps, YAML alias bomb,
template-depth ceiling, recursion depth, tool image size,
`safe_stringify` node cap, sandbox condition timeout and its
`condition_memory_mb` heap cap) and the 13 shell safe-tier
positional caps, which decide whether a command still needs approval. A blanket
switch leaves them at their configured value, and a configured raise falls back to
the default, because a config toggle that disables a denial-of-service or an
approval boundary is itself a vulnerability.
Switching one off explicitly — by env value or by `MERCI_LIMITS_DISABLED` — also
needs the opt-in:

```ini
MERCI_LIMITS_ALLOW_GUARD_OFF=1
MERCI_LIMITS=limits_off
```

The same opt-in governs a raise: a numeric value may tighten a guard freely, but
a value above its default is refused with a warning and the default is kept
unless `MERCI_LIMITS_ALLOW_GUARD_OFF=1` is set.

## Fixed identity lengths

A few numeric constants are fixed by a protocol or by on-disk identity: hash
suffix and slug lengths, journal keys, and the provider's four-breakpoint cache
ceiling. They are in the catalog with `mutable: false`: visible through
`getLimits()` and `/limits`, but an override is rejected with a configuration
error. Changing one would silently orphan existing files or break the vendor
contract.

## Adding a limit

1. Declare it in the matching domain file under `lib/core/constants/limits/`
   with `defineLimit({ env, default, min, max, unbounded, timer?, guard?, doc })`.
2. Read it as `LIMITS.<key>` inside the function that uses it — never in a
   module-scope `const`, which would freeze the value at import, and never as
   `LIMIT_REGISTRY.<key>.default`, which pins the code default and ignores every
   override; `scripts/check-limits.mjs` fails on the latter (rule L7).
3. Run `pnpm run check:limits`. It fails on a numeric limit declared outside the
   registry and on a `LIMITS.<key>` typo. The baseline in
   `scripts/limits-budget.json` records the offences that predate the
   comparison/call-argument rules: a name it already lists may repeat in its
   file, while a new name, or a listed name used in a file that does not list
   it, fails. A stale entry — a listed name whose shape no longer exists — does
   not fail; only `--update` removes it, and only ever removes entries.

The gate is a static scan of `lib/**/*.mjs`. It sees limit-shaped declarations
(any casing), numeric values in known cap properties, a numeric literal compared
against `.length`/`.size`, the end argument of `slice`/`substring`, the arguments
of `Math.min`/`Math.max`, `AbortSignal.timeout` deadlines, `setTimeout`/
`setInterval` delays and `setMaxListeners` in both bare and member-call form, and
`LIMITS` reads including destructuring and string-literal computed access. It does
not evaluate a variable, an aliased object, or code outside `lib/` — those stay a
review obligation.

`unbounded` is per key because consumers disagree: `.slice(0, n)` wants a huge
number, `runCommand` wants `0` for "no timeout", and a timer must stay under
`2_147_483_647` — Node fires a larger `setTimeout` delay after 1 ms. The
registry validates that bound on import.
