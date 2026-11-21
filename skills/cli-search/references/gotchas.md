# Search gotchas

Each entry is a failure you will see, and what it means.

## Empty results

- **`No files found` is not proof of absence.** `rg` honours `.gitignore`,
  skips hidden files and does not follow symlinks. Prove the scope with
  `rg --files -g '<pattern>'` before concluding anything.
- **A directory search that returns nothing** may have been gated and denied
  rather than run. Check the tool result, not just the emptiness.
- **Binary files are skipped silently.** `-a` forces a match; `strings` is
  usually the better tool.

## Patterns

- **Unescaped regex.** `foo(`, `a.b`, `[0]`, `x|y` are regex. Use `-F` for
  literals, or escape.
- **`\b` differs between engines.** `rg` uses Rust regex; `grep -P` uses
  PCRE2. `-P` in `rg` gets you lookaround and backreferences.
- **A leading `-` in a pattern** is read as a flag. Put `--` before it.
- **Multiline needs `-U`.** Without it, `.` never crosses a newline and a
  pattern spanning lines silently misses.

## Files and encoding

- **CRLF files** need `--crlf` for `$` anchors to match.
- **Non-UTF8 files** are skipped unless `--encoding` names the encoding.
- **Huge files** slow the search; cap with `--max-filesize`.
- **Symlinks** are not followed. `read` follows them, `rg` does not.
- **A shell glob never expands.** `rg ["*.mjs"]` searches a file literally
  named `*.mjs`; use `-g`.

## Output

- **Shell output is capped at 4000 chars** and the cut is silent apart from the
  truncation suffix. Count or list first.
- **`--max-count` is per file.** `-m 3` across 400 files is up to 1200 lines.
- **Native `grep` caps at 100 matches** and says so in the footer.
- **`which` exits 1 if any name is missing**, and the whole call is reported
  as failed. Probe one tool at a time, or accept the error and read stdout.

## Costs

- **A directory `rg` prompts.** So does `grep -r`, `find`, `fd`, `sed`, `awk`
  and `jq`. Budget one approval per gated step; prefer the native tools.
- **A pipeline prompts once**, naming the whole chain. If the prompt shows a
  chain you did not intend, deny and rewrite it.
