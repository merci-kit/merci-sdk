# argv recipes

The shell tool never sees a shell. These are the rewrites that matter.

| Shell idiom | argv / pipeline |
| --- | --- |
| `ls *.mjs` | `glob({ pattern: "**/*.mjs" })` |
| `find . -name '*.md'` | `glob({ pattern: "**/*.md" })` |
| `grep -rn x .` | `grep({ pattern: "x" })` |
| `grep -rn x . \| head -20` | `grep({ pattern: "x" })`, then read the hits |
| `rg x lib \| sort \| uniq -c` | pipeline: `rg -o x <file>` → `sort -u` → `wc -l` |
| `cat a b > c` | a script |
| `echo $HOME` | `pwd` (echo prints the literal text) |
| `cd dir && cmd` | absolute paths, or `process.chdir` in a script |
| `cmd 2>&1` | the tool already returns `stderr` separately |
| `xargs rm` | a script with an explicit list; `rm` is blocked |
| `sed -i s/a/b/ f` | a script, or the editor's edit tool |
| `awk '{print $2}'` | `cut -f2` (allowlisted), or a script |
| `jq .key f` | a script (`node -e` is gated), or `read` the JSON |

## Tiers (generated)

The lists below are generated from the SDK constants. Per-option behaviour is
not: see the limits after them.

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

Notable limits:

- `rg` on a **directory** prompts; on a file, or with `--files`, it does not.
- `grep -r` prompts: recursion is not in its allowlist.
- `sort -o FILE`, `uniq IN OUT` and `rg --pre CMD` prompt: they write or execute.
- `head -n 5` and `head -5` are both accepted.

## Gated examples

`node`, `git`, `python3`, `sed`, `awk`, `jq`, `yq`, `find`, `fd`, `rg --hidden`,
`rg --no-ignore`, `rg -L`, `sort -o`, anything with an unknown flag, and any
path outside the workspace roots or naming a sensitive file.

## Blocked (no override)

The generated list above is the blocklist. It is checked for **every** pipeline
stage before anything runs, and there is no approval override.

## Why this shape

- `spawn` with an argv array has no metacharacter surface: `; rm -rf /` is one
  argument, not a command.
- The allowlist is decidable per option, so the gate can be exact instead of
  heuristic.
- The price is that the model must speak argv, not bash. That price is paid
  once, here.
