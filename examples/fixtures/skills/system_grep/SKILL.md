---
name: system_grep
description: Recursively finds file paths in a directory where file contents contain a pattern.
parameters: {"type":"object","properties":{"directory":{"type":"string","description":"The path to the directory to search in, e.g. './lib'"},"pattern":{"type":"string","description":"The regex or string pattern to search for"}},"required":["directory","pattern"]}
---
You are a system assistant. When requested to search for code or text in files, use this tool to return file paths that contain the pattern.
