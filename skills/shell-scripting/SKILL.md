---
name: shell-scripting
description: Run commands and write scripts inside the Merci SDK shell tool, which takes one command plus an argv array and has no shell. Use when a task needs several file operations, a batch rename or rewrite, a generated report, a repeatable maintenance job, or when a command was refused or asked for approval. Covers the approval tier, pipelines, JS-first scripts, atomic writes, and dry-run defaults.
version: 0.23.0
---

# Shell scripting

The shell tool spawns `command` with `args` directly, or chains stages through
a `pipeline`. There is no shell to interpret anything, and a default-deny
allowlist decides what runs without a human. Both facts change how you write a
command.

## What the absence of a shell means

| You would write | Write instead |
| --- | --- |
| `ls *.mjs` | `glob({ pattern: "**/*.mjs" })` |
| `grep -rn x . \| head -20` | `grep({ pattern: "x" })`, then `read` |
| `rg x lib \| sort \| uniq -c` | a `pipeline` of three stages |
| `cat a b > c` | a script that reads both and writes `c` |
| `echo $HOME` | prints the literal `$HOME`; use `pwd` |
| `cd dir && cmd` | absolute paths, or a script that calls `process.chdir` |
| `sed -i 's/a/b/' f` | a script, or the editor's own edit tool |
| `xargs rm` | blocked; a script with an explicit file list |

`command` is a bare name or a path. `args` entries are strings and are never
expanded, split, or globbed.

## Pipelines

```js
{ pipeline: [
    { command: 'rg', args: ['--files', '-g', '*.mjs'] },
    { command: 'wc', args: ['-l'] }
] }
```

Each stage reads the previous stage's stdout. Every stage gets the same
blocklist and safe-option policy, the exit code is the last stage's, and the
chain asks for approval at most once. Max 5 stages; past that, write a script.

The chain ends when **every** stage has exited, as in bash. A stage that never
exits holds the pipeline until the tool timeout, so do not pipe a live log into
`head`; cap the producer instead (`rg -m 20`, `head` on a finished file).

A skill written for another harness assumes `bash`, `fd` and `jq`. Map its
commands onto this tier instead of copying them, and call
`describe_shell_policy` when the host exposes it and may have customised the tier.

## One approval, one script

Every command outside the read-only tier prompts the human. Ten `sed` calls
are ten prompts. Package the work instead:

```
node scripts/rename-tmp.mjs --root artifacts --dry-run
```

One prompt, one reviewable artifact, one thing to re-run. The read-only tier
is listed in `cli-search`; assume anything that writes, executes, or reaches
the network is gated.

## JS first

Node 22, ESM, `node:` builtins. Use a real CLI only when the CLI is the point.

```js
#!/usr/bin/env node
import { readdir, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  root: { type: 'string', default: '.' },
  apply: { type: 'boolean', default: false },
}});

const root = resolve(values.root);
const changed = [];
for (const name of await readdir(root)) {
  if (!name.endsWith('.tmp')) continue;
  const from = join(root, name);
  if (!(await stat(from)).isFile()) continue;
  const to = from.slice(0, -4) + '.bak';
  changed.push({ from, to });
  if (values.apply) await rename(from, to);
}

process.stdout.write(JSON.stringify({ applied: values.apply, changed }, null, 2));
```

Rules for every script:

- **Dry run by default.** Mutation needs an explicit `--apply`.
- **JSON on stdout, prose on stderr.** The tool caps stdout at 4000 chars.
- **Non-zero exit on failure**, naming the failing path.
- **Absolute paths.** `resolve` at the edge, never string concatenation.
- **Write to a temp file, then `rename`.** A crash must not leave half a file.
- **No `eval`, no `exec`, no `sh -c`.** They are blocked, and they are how a
  path becomes a command.
- **No secrets in argv.** They land in process listings and logs.

## Environment

The shell tool inherits a safe allowlist (`PATH`, `HOME`, locale) and nothing
else. A key in the parent `process.env` is not visible to the command. Read
`secret.env` explicitly when a task genuinely needs one — that read asks for
approval, and it should. Never print it.

## When it is a real bash script

Only when the artifact is for the user's own repo or CI. In the shell tool
`bash` and `sh` are blocked, so the agent cannot run it there: ship it, do not
execute it.

A skill's own `scripts/*.sh` is a **different path**: it runs under `bash` and
is gated by the `script` selector, not by the shell tier. "Blocked" above means
blocked in `execute_shell_command`, not blocked in the process.

- `#!/usr/bin/env bash` and `set -euo pipefail`
- `IFS=$'\n\t'`
- quote every expansion: `"$var"`, `"$@"`
- `mktemp -d` plus a `trap` cleanup
- `--help`, `--dry-run`, and a usage block
- no parsing of `ls`; no `eval`; no unquoted globs

Template: `references/bash-template.md`.

## Verify

After a mutating script, prove the change: `diff -u old new` is read-only and
allowlisted, or re-read the touched files and show the delta. A script that
exits 0 has told you nothing about what it wrote.

## References

- `references/argv-recipes.md` — shell idiom → argv array, and the read-only
  tier per command.
- `references/node-templates.md` — walker, JSON transform, atomic writer,
  spawn with timeout.
- `references/bash-template.md` — the portable script, with the checks above.
