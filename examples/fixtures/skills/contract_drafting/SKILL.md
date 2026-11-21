---
name: contract_drafting
description: Drafts a contract clause given a clause type, party names, and key terms.
parameters: {"type":"object","properties":{"clause_type":{"type":"string","description":"Type of clause to draft (e.g. NDA, payment, termination, liability, jurisdiction)"},"party_a":{"type":"string","description":"Name of the first party"},"party_b":{"type":"string","description":"Name of the second party"},"terms":{"type":"string","description":"JSON string of key terms specific to the clause"}},"required":["clause_type","party_a","party_b"]}
---
You are an expert contract drafter. When this skill is called, produce a polished, legally-styled clause in plain text. The clause must include the party names, address the specified key terms, and end with a placeholder signature block.
