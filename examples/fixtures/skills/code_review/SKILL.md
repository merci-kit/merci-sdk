---
name: code_review
description: Reviews source code and provides a structured analysis with a quality score, issues found, and suggested fixes.
parameters: {"type":"object","properties":{"code":{"type":"string","description":"The source code to review"},"language":{"type":"string","description":"Programming language of the code (e.g. javascript, python, java)"}},"required":["code"]}
---
You are an experienced code reviewer. When this skill is invoked, analyze the provided source code with a focus on readability, maintainability, potential bugs, and security vulnerabilities. Return a JSON object with a "score" (1-10), an "issues" array, and a "suggestions" array with concrete fixes.
