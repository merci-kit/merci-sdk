---
name: cli-search
description: Search a repository for a symbol, definition, call site, string, or file. Use when the user says find, search, grep, ripgrep, rg, where is, which files, how many, or before editing code you have not read. Routes between the native grep/glob/read tools and shell ripgrep, and states which forms need human approval.
version: 0.25.0
---

# CLI search

The shell tool takes one command plus an argv array, or a `pipeline` of them.
There is no shell: `|`, `>`, `$(...)` and glob expansion never work. Every
search below is one call.

## What runs without a prompt

This decides the tool before the query does. Read it first. These are the
**shell tool defaults**: a host may pass its own `safeCommands` or
`blockedCommands`, and `describe_shell_policy` — when the host exposes it —
returns that host's exact tier.

<!-- BEGIN GENERATED: shell-tiers -->
Read-only, no prompt (the per-option allowlist still applies):

```text
arch basename cal cat cmp cut date df diff dirname du echo egrep fgrep file
grep groups head hexdump hostname id locale ls man md5sum mdfind mdls od
printf ps pwd readlink realpath rg sha256sum shasum sort spotlight stat
strings sw_vers tail tldr top tput tr type uname uniq uptime wc which whoami
xxd
```

Blocked, no override:

```text
. addgroup adduser anacron apt apt-get at bash batch brew chattr chflags
chmod chown cp crontab csh curl dd delgroup deluser diskutil dnf doas dpkg
env eval exec fdisk fish ftp gdisk groupadd groupdel groupmod halt init kill
killall launchctl ln mkdir mkfifo mkfs mkfs.apfs mkfs.ext4 mknod mount mtr
mv nc ncat netcat npm pacman parted passwd pgrep ping pip pip3 pkill pnpm
poweroff reboot rm rmdir rpm rsync scp service sftp sh shred shutdown source
ssh su sudo sysctl systemctl telnet touch traceroute truncate umount unlink
useradd userdel usermod visudo wget xargs yarn yum zsh
```

Everything else asks the human once.
<!-- END GENERATED: shell-tiers -->

The lists are per command; behaviour is per option. These ask even though the
command is listed above:

- `rg` on a **directory** (recursive content search) — `rg` on a **file**, or
  `rg --files`, is silent.
- `grep -r`, `sort -o FILE`, `uniq IN OUT` and `rg --pre CMD`: they recurse,
  write, or execute.
- A `pipeline` is silent only when **every** stage is.

Two consequences worth memorising:

- **The native `grep` tool is the only silent way to search a directory's
  contents.** Shell `rg -n pattern dir` prompts. `rg --files <dir>` lists paths
  and is silent — it is not a content search.
- **Sensitive paths are gated everywhere.** `cat secret.env`, `rg x secret.env`
  and `rg x .` all prompt, because the path or the recursion is checked.

A skill written for another harness assumes `bash` and a full CLI. Map its
commands onto this tier (`fd` → `glob`, `grep -r` → the `grep` tool, `sed -i` →
a script) instead of copying them.

## Native tools first

| Need | Tool | Limit |
| --- | --- | --- |
| Regex hit in code | `grep` | 100 matches, grouped by file |
| File paths | `glob` | 100 paths |
| Read a known file or dir | `read` | 2000 lines / 50 KB, numbered |

They refuse binary files and sensitive paths and say so. Native `grep` cannot
do context lines, files-only, counts, case toggles, type scoping, multiline,
invert, or PCRE2. For any of those, use shell `rg` — on a file when you can.

## Route by question

| Question | Call |
| --- | --- |
| Where is this symbol used? | `grep({ pattern: "capToolOutput", include: "*.mjs" })` |
| Which files mention it? | `pipeline: [rg -l -F capToolOutput lib, head -n 20]` |
| How many hits? | `rg ["-c", "-F", "capToolOutput", "lib/tools/shell-tools.mjs"]` |
| Whole word | `rg ["-n", "-w", "read", "<file>"]` |
| Case-insensitive | `rg ["-n", "-i", "toolexecution", "<file>"]` |
| With context | `rg ["-n", "-C", "3", "SHELL.BLOCKED", "<file>"]` |
| Literal with regex chars | `rg ["-n", "-F", "a|b", "<file>"]` |
| Multiline construct | `rg ["-n", "-U", "class \\w+ \\{", "<file>"]` |
| Lookaround / backref | `rg ["-n", "-P", "(?<=SHELL_)\\w+", "<file>"]` |
| Extract just the match | `rg ["-n", "-o", "\\w+\\.mjs", "<file>"]` |
| Files, not contents | `glob({ pattern: "lib/**/*.mjs" })` |
| Inside a PDF or docx | `rga` — asks; say why first |

Cost order: native tool → safe `rg` on a file → gated `rg` on a directory.
Never start with the third.

## Pipelines

Chain stages through stdout instead of a shell. Both stages are checked; the
chain asks at most once, and the prompt shows the whole chain.

```js
{ pipeline: [
    { command: 'rg', args: ['--files', '-g', '*.mjs'] },
    { command: 'sort', args: [] },
    { command: 'head', args: ['-n', '5'] }
] }
```

A pipeline is for post-processing output, not for escaping the gate: a gated
stage still prompts. Max 5 stages; beyond that, write a script.

## Rules that prevent most mistakes

1. **Count before you print.** Shell output is capped at 4000 chars. `-c` or
   `-l` first; a match dump on a large repo truncates and hides the answer.
2. **`-F` for literal strings.** `foo(`, `a.b`, `[0]` are regex unless you say
   otherwise, and a broken pattern looks like a clean miss.
3. **One call, one question.** `sort | uniq -c` is a pipeline, not two calls.
4. **Read the hit, not the file.** `read` with the `offset` from the match.
5. **Narrow by `-t` or `-g` before widening by path.** Type filters are free;
   `--no-ignore` is not.

## Gotchas

- **Empty is not absent.** `rg` honours `.gitignore` and skips hidden files.
  Before saying "not found", run `rg --files -g 'pattern'` to see what is in
  scope.
- **`--max-count` is per file**, not per search.
- **Binary files are skipped silently.** `-a` forces them; `strings` is usually
  what you want.
- **Symlinks are not followed** by `rg`; `read` follows them.
- **Shell globs do not expand.** `rg ["*.mjs"]` searches a file named `*.mjs`;
  use `-g '*.mjs'`.
- **`which` exits non-zero when any name is missing**, and the tool reports the
  whole call as failed. Probe one tool at a time.
- **A bare `rg` with no match exits 1**, which the shell tool reports as a
  failure, not an empty result. That is not an error: read `stdout` and treat
  "exited with code 1" on `rg`/`grep` as "no match". The native `grep` tool
  returns `No files found` instead.
- **`rg -r` means replace, `grep -r` means recursive.** Both surprise people.

## Verify a negative

A "not found" answer is a claim. Widen once: drop the type filter, search the
repo root with the native `grep` tool, add `-F`. If it is still empty, say
which paths and ignore rules were excluded.

## References

- `references/native-tools.md` — exact argv, caps, and refusal rules of
  `grep`, `glob`, `read`.
- `references/ripgrep.md` — flag atlas, output modes, `--json`, type list.
- `references/gotchas.md` — encoding, CRLF, ignore precedence, large repos.
