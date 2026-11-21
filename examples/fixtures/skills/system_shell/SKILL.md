---
name: system_shell
description: Generic, sandbox-friendly shell command executor. Runs a single executable with a bounded argv array and returns stdout, stderr, and the exit code as JSON.
parameters: {"type":"object","properties":{"command":{"type":"string","description":"The base executable to run, e.g. 'ls', 'grep', 'find', 'cat'. Must be the bare command name, never a shell pipeline, redirect, or quoted expression."},"args":{"type":"array","items":{"type":"string"},"description":"Argument vector. Each entry is passed as a separate argv element (no shell parsing). Example: ['-rIl', 'TODO', './lib']."},"cwd":{"type":"string","description":"Optional working directory for the command. Must be an absolute or workspace-relative path."}},"required":["command","args"]}
---
You are a sandbox-friendly shell command executor. Use this tool to run a single
executable with a bounded argv array. Never embed shell operators (|, &&, ;, >,
$(), backticks) in the command or its arguments. The bash runner enforces its
own blocklist as a final safety net.
