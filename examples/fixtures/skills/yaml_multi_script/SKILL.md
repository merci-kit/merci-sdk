---
name: yaml_multi_script
description: A skill whose SKILL.md frontmatter is real YAML - a tool list, a nested map and a block scalar - and whose scripts directory holds two runnable scripts.
command: /yaml-multi
allowed-tools:
  - Read
  - Grep
  - Bash
meta:
  author: merci-sdk examples
  tags:
    - yaml
    - multi-script
notes: |
  The loader parses this block as a YAML mapping.
  A list, a nested map and a multi-line block scalar all survive into metadata.frontmatter.
parameters: '{"type":"object","properties":{"script":{"type":"string","description":"Which script to run - first.js (the default) or second.js."}},"required":[]}'
---
You are the yaml_multi_script skill. Your frontmatter is YAML, not a flat
key:value list: `allowed-tools` is a list, `meta` is a nested map and `notes`
is a multi-line block scalar. The skill ships two scripts - `first.js` (the
default) and `second.js` - and the caller picks one with the `script`
argument. Run the selected script and report the single line it printed.
