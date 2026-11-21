# Portable bash template

Ship this to the user's repo or CI. The agent cannot run it: `bash` and `sh`
are on the blocklist.

```bash
#!/usr/bin/env bash
# rename-tmp.sh — rename *.tmp to *.bak under a root.
# Usage: ./rename-tmp.sh [--root DIR] [--apply]
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'EOF'
Usage: rename-tmp.sh [--root DIR] [--apply]

  --root DIR   Directory to scan (default: .)
  --apply      Perform the rename. Without it, this is a dry run.
  -h, --help   Show this help.
EOF
}

root='.'
apply=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)  [[ $# -ge 2 ]] || { echo "--root needs a value" >&2; exit 2; }; root="$2"; shift 2 ;;
    --apply) apply=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -d "$root" ]] || { echo "Not a directory: $root" >&2; exit 2; }

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

count=0
while IFS= read -r -d '' file; do
  target="${file%.tmp}.bak"
  printf '%s -> %s\n' "$file" "$target"
  count=$((count + 1))
  if [[ "$apply" -eq 1 ]]; then
    mv -- "$file" "$target"
  fi
done < <(find "$root" -type f -name '*.tmp' -print0)

if [[ "$apply" -eq 0 ]]; then
  printf 'dry run: %d file(s). Re-run with --apply.\n' "$count"
else
  printf 'renamed %d file(s).\n' "$count"
fi
```

## Why each line

- `set -euo pipefail` — an unset variable or a failed stage is an error, not a
  silent empty string.
- `IFS=$'\n\t'` — filenames with spaces survive `for`/`read` loops.
- `-print0` + `read -d ''` — filenames with newlines survive.
- `mv --` — a file named `-rf` is not read as a flag.
- `mktemp -d` + `trap` — no leaked temp directory on failure.
- `--apply` — the dry run is the default, so a wrong invocation prints a plan.
- `exit 2` for usage errors, distinct from `1` for a failed operation.

## Checks before shipping

- [ ] `shellcheck rename-tmp.sh` is clean
- [ ] `bash -n rename-tmp.sh` parses
- [ ] the dry run on a real tree prints the expected pairs
- [ ] `--help` exits 0
