# ripgrep atlas

`rg` is allowlisted, but **a directory target for a content search is
recursive and asks for approval**. `rg --files <dir>` lists paths instead of
contents and runs silently; `rg` on a single file runs silently too.

## Output modes

| Flag | Output | Use |
| --- | --- | --- |
| `-l` | file paths only | "which files mention it" |
| `-c` | count per file | "how many, and where" |
| `--count-matches` | total matches per file | repeated hits on one line |
| `-o` | the match text only | extract identifiers |
| `-n` | `file:line:text` | normal hit list |
| `--json` | one JSON object per event | machine parsing |
| `--stats` | summary block | timing, match totals |
| `-q` | no output, exit code only | "does it exist" |

## Filtering

| Need | Flag |
| --- | --- |
| Case-insensitive | `-i` |
| Smart case | `-S` |
| Whole word / whole line | `-w` / `-x` |
| Literal string | `-F` |
| Invert | `-v` |
| Language type | `-t js`, `-T json` (exclude) |
| Glob | `-g '*.mjs'`, `-g '!vendor/**'` |
| Max per file | `-m 5` |
| Context | `-C 3`, `-A 2`, `-B 2` |
| Multiline | `-U` (`--multiline-dotall` with it) |
| PCRE2 (lookaround) | `-P` |
| Depth | `--max-depth 2` |
| Skip huge files | `--max-filesize 2M` |
| Threads | `-j 4` |

Common types: `js`, `ts`, `tsx`, `json`, `md`, `py`, `rust`, `go`, `sh`,
`yaml`, `toml`, `html`, `css`. `rg --type-list` prints all of them.

## Pipeline recipes

```js
// Files only, bounded
{ pipeline: [
  { command: 'rg', args: ['--files', '-g', '*.mjs'] },
  { command: 'head', args: ['-n', '20'] }
] }

// Count matches across a file set, sorted
{ pipeline: [
  { command: 'rg', args: ['-c', '-F', 'TODO', 'lib/tools/shell-tools.mjs'] },
  { command: 'sort', args: ['-t', ':', '-k2', '-n'] }
] }

// Unique matched identifiers
{ pipeline: [
  { command: 'rg', args: ['-o', '-P', '(?<=EVENTS\\.SHELL\\.)\\w+', '<file>'] },
  { command: 'sort', args: ['-u'] }
] }
```

## Deliberate exclusions

`--hidden`, `--no-ignore` and `-L` are **not** allowlisted: they widen the
search to ignored files, dotfiles and symlink targets. If a task truly needs
one, say why in one line, then call it once. Do not retry a refusal.

## Ignore precedence

`.rgignore` beats `.ignore`, which beats `.gitignore`. `rg --files` shows the
resulting set, which is the fastest way to prove what is in scope.
