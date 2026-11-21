#!/bin/bash
# examples/skills/system_shell/scripts/run.sh
#
# Generic shell command executor. Receives a JSON payload as $1:
#   { "command": "<exe>", "args": ["<argv1>", ...], "cwd": "<optional>" }
#
# Returns a single line of JSON on stdout:
#   { "success": <bool>, "stdout": "...", "stderr": "...", "exitCode": <int> }
#
# This script is the LAST line of defense. The JS layer calling this script
# is the primary policy gate (blocklist, safelist, HITL), but we re-apply a
# hard blocklist here so the script is safe to invoke directly from any
# caller (including non-Node code, MCP, A2A, future adapters).
#
# Hard blocklist (kept in sync with SHELL_TOOL_DEFAULT_BLOCKED_COMMANDS in
# lib/core/constants/shell-tool-lists.mjs):
#   rm rmdir unlink shred truncate mv cp mkdir touch chmod chown chflags chattr
#   ln mknod mkfifo mount umount diskutil
#   sudo su doas passwd visudo
#   kill killall pkill pgrep
#   dd mkfs mkfs.ext4 mkfs.apfs fdisk gdisk parted
#   shutdown reboot halt poweroff init
#   crontab at batch anacron systemctl service
#   launchctl sysctl
#   curl wget nc ncat netcat telnet ssh scp rsync ftp sftp ping traceroute mtr
#   useradd userdel usermod groupadd groupdel groupmod adduser deluser addgroup delgroup
#   apt apt-get dpkg rpm yum dnf pacman brew pip pip3 npm pnpm yarn
#   eval exec source . bash sh zsh fish csh env xargs

set -u

PAYLOAD="${1:-}"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------
# 1. Parse the JSON payload via Node and write each field to its
#    own file. This avoids fragile argv quoting in nested node
#    invocations and keeps the bash script readable.
# ---------------------------------------------------------------
node - "$PAYLOAD" "$WORK" <<'NODE'
const fs = require('fs');
const raw = process.argv[2] || '{}';
const work = process.argv[3];
let obj;
try { obj = JSON.parse(raw); }
catch (e) { fs.writeFileSync(work + '/error', 'Invalid JSON payload: ' + e.message); process.exit(0); }
const command = (typeof obj.command === 'string') ? obj.command.trim() : '';
const argsIn = Array.isArray(obj.args) ? obj.args : [];
const args = argsIn.filter(a => typeof a === 'string');
const cwd = (typeof obj.cwd === 'string') ? obj.cwd.trim() : '';
if (!command) { fs.writeFileSync(work + '/error', "Field 'command' is required and must be a non-empty string."); process.exit(0); }
fs.writeFileSync(work + '/command', command);
// Trailing newline is required: a bash `while read` loop that does NOT see
// the terminating newline drops the final element. We always append one.
fs.writeFileSync(work + '/args', args.length > 0 ? args.join('\n') + '\n' : '');
fs.writeFileSync(work + '/cwd', cwd);
NODE

# Surface parse / validation errors as JSON and exit cleanly.
if [ -s "$WORK/error" ]; then
  ERR=$(cat "$WORK/error")
  printf '{"success": false, "error": %s}\n' \
    "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$ERR")"
  exit 0
fi

# ---------------------------------------------------------------
# 2. Resolve bare command name (strip any /path/to/ prefix).
# ---------------------------------------------------------------
COMMAND=$(cat "$WORK/command")
COMMAND_BASE="${COMMAND##*/}"

# ---------------------------------------------------------------
# 3. Defense-in-depth blocklist. Hard reject, no HITL override.
#    This regex MUST stay in sync with
#    SHELL_TOOL_DEFAULT_BLOCKED_COMMANDS in
#    lib/core/constants/shell-tool-lists.mjs.
# ---------------------------------------------------------------
BASH_BLOCKLIST_REGEX='^(rm|rmdir|unlink|shred|truncate|mv|cp|mkdir|touch|chmod|chown|chflags|chattr|ln|mknod|mkfifo|mount|umount|diskutil|sudo|su|doas|passwd|visudo|kill|killall|pkill|pgrep|dd|mkfs|mkfs\.ext4|mkfs\.apfs|fdisk|gdisk|parted|shutdown|reboot|halt|poweroff|init|crontab|at|batch|anacron|systemctl|service|launchctl|sysctl|curl|wget|nc|ncat|netcat|telnet|ssh|scp|rsync|ftp|sftp|ping|traceroute|mtr|useradd|userdel|usermod|groupadd|groupdel|groupmod|adduser|deluser|addgroup|delgroup|apt|apt-get|dpkg|rpm|yum|dnf|pacman|brew|pip|pip3|npm|pnpm|yarn|eval|exec|source|\.|bash|sh|zsh|fish|csh|env|xargs)$'

if [[ "$COMMAND_BASE" =~ $BASH_BLOCKLIST_REGEX ]]; then
  MSG="Command '$COMMAND_BASE' is blocked at the bash layer."
  printf '{"success": false, "error": %s}\n' \
    "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$MSG")"
  exit 0
fi

# ---------------------------------------------------------------
# 4. Materialize the argv array from the file (one arg per line,
#    no shell parsing, no eval). Uses a portable `while` loop
#    because macOS /bin/bash 3.2 does not implement `mapfile`.
# ---------------------------------------------------------------
ARGV=()
while IFS= read -r line; do
  ARGV+=("$line")
done < "$WORK/args"
CWD=$(cat "$WORK/cwd")

# ---------------------------------------------------------------
# 5. Execute the command with stdout/stderr captured to temp
#    files, then emit a single JSON line.
# ---------------------------------------------------------------
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  if [ "${#ARGV[@]}" -gt 0 ]; then
    ( cd "$CWD" && "$COMMAND_BASE" "${ARGV[@]}" ) \
      > "$WORK/stdout" 2> "$WORK/stderr"
  else
    ( cd "$CWD" && "$COMMAND_BASE" ) \
      > "$WORK/stdout" 2> "$WORK/stderr"
  fi
else
  if [ "${#ARGV[@]}" -gt 0 ]; then
    "$COMMAND_BASE" "${ARGV[@]}" > "$WORK/stdout" 2> "$WORK/stderr"
  else
    "$COMMAND_BASE" > "$WORK/stdout" 2> "$WORK/stderr"
  fi
fi
EXIT_CODE=$?

node - "$WORK" "$EXIT_CODE" <<'NODE'
const fs = require('fs');
const work = process.argv[2];
const code = parseInt(process.argv[3], 10);
const stdout = fs.readFileSync(work + '/stdout', 'utf8');
const stderr = fs.readFileSync(work + '/stderr', 'utf8');
const result = { success: code === 0, stdout, stderr, exitCode: code };
process.stdout.write(JSON.stringify(result));
NODE
