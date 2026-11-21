# Native tools — exact behaviour

These are the tools the model calls directly. They are not the shell, and they
have hard limits worth knowing before you plan a search.

## `grep`

Builds this command and parses the output into `file:` / `Line N: text` groups:

```
rg --line-number --no-heading --color never --max-count 100 --no-follow [-g <include>] -- <pattern> <dir>
```

- **100 matches maximum.** `(more matches available)` in the footer means the
  cap fired — narrow the pattern or add `include`.
- `path` defaults to the workspace root; `include` is a glob (`*.js`,
  `*.{ts,tsx}`).
- Rows whose file is sensitive are dropped from the output silently.
- Exit code 1 (no match) becomes the string `No files found`, not an error.
- No context lines, no files-only mode, no counts, no case toggle, no type
  filter, no multiline, no PCRE2. Those need shell `rg`.

## `glob`

```
rg --files --no-follow [-g <pattern>] <dir>
```

- **100 paths maximum**, with a truncation notice.
- Returns paths relative to the workspace root.
- Sensitive paths are filtered out.

## `read`

- Files: numbered lines, `offset` is 1-based, `limit` defaults to **2000** and
  the output is capped at **50 KB** (the footer says which cap fired). A file
  over 8 MB is read through a window.
- Directories: one entry per line, `name/` for directories, alphabetical.
- Refuses binary files (`Cannot read binary file`) and sensitive paths
  (`Access to sensitive file is not allowed`).
- Out-of-range `offset` is an error, not an empty result.

## Choosing between them

| Situation | Tool |
| --- | --- |
| "Where is X used?" | `grep` |
| "Which files exist?" | `glob` |
| "Show me lines 40–80 of that file" | `read` |
| "How many hits?" / "which files only?" / "with context" | shell `rg` |
| "Search a directory" with flags the tool lacks | shell `rg` (asks) |
