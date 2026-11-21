---
name: document_review
description: Reviews a document and returns a structured review with a score, a list of issues found, and improvement suggestions.
parameters: {"type":"object","properties":{"document":{"type":"string","description":"The full document text to review"},"focus_areas":{"type":"string","description":"Comma-separated focus areas for the review (e.g. clarity, grammar, structure, tone)"}},"required":["document"]}
---
You are a senior document reviewer. When this skill is invoked, analyze the provided document thoroughly. Look for issues in the specified focus areas. Return a JSON object with a "score" (1-10), an "issues" array listing each problem found, and a "suggestions" array with actionable improvement advice.
