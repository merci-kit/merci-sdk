#!/usr/bin/env node
// @ts-check

/**
 * @file The example-coverage gate — the curated "must-be-demonstrated" list.
 * @version 0.7.2
 *
 * @description
 * The symbol map shows what the examples demonstrate; this gate decides whether
 * that is ENOUGH. `scripts/example-coverage.config.json` names the public SDK
 * surface that must keep an example — the wave-1/2/3 contracts, one entry per
 * capability. A capability counts as demonstrated when ALL of its proof symbols
 * appear in ONE example: an imported public name, a method the example CALLS, or
 * an option key the example passes.
 *
 * The evidence comes from the same AST walk the symbol map uses
 * (`scripts/build-example-map.mjs`), so there is one source of truth: a comment
 * that merely mentions a symbol does not count, a call does.
 *
 * A capability without an example fails the gate — and therefore CI. That is
 * the point: a feature that loses its example fails loudly instead of rotting
 * silently in a README nobody reads.
 *
 * @example
 * node scripts/check-example-coverage.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectExamples } from './build-example-map.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'scripts', 'example-coverage.config.json');

/**
 * Reads the curated must-demonstrate list.
 * @returns {Array<{ capability: string, proof: string[] }>}
 */
function readConfig() {
    const raw = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const capabilities = Array.isArray(raw?.capabilities) ? raw.capabilities : [];
    return capabilities.map((/** @type {any} */ entry) => ({
        capability: String(entry?.capability ?? '(unnamed capability)'),
        proof: Array.isArray(entry?.proof) ? entry.proof.map((/** @type {any} */ p) => String(p)) : [],
    }));
}

/**
 * Whether an example carries a proof symbol: the exact name, or a dotted
 * member path that ends with it.
 * @param {{ example: { evidence: Set<string> }, proof: string }} arg0
 * @returns {boolean}
 */
function hasProof({ example, proof }) {
    if (example.evidence.has(proof)) return true;
    if (!proof.includes('.')) return false;
    for (const path of example.evidence) {
        if (path.endsWith(`.${proof}`)) return true;
    }
    return false;
}


/**
 * Runs the gate.
 * @returns {{ failed: number, total: number, lines: string[] }}
 */
export function checkExampleCoverage() {
    const capabilities = readConfig();
    const examples = collectExamples();
    /** @type {string[]} */
    const lines = [];
    /** @type {Array<{ capability: string, missing: string[] }>} */
    const failed = [];

    const unreadable = examples.filter((example) => example.role === '(parse failed)').map((example) => example.name);
    if (unreadable.length > 0) {
        lines.push(`  ! ${unreadable.length} example(s) could not be parsed — their coverage is UNKNOWN: ${unreadable.join(', ')}`);
    }

    for (const entry of capabilities) {
        // A capability with no proof would be satisfied by every example —
        // vacuously. That is a mistake in the list, not a pass.
        if (entry.proof.length === 0) {
            failed.push({ capability: entry.capability, missing: ['(no proof — the capability list is broken)'] });
            lines.push(`  ✗ ${entry.capability} — no proof: a capability must name the symbols that demonstrate it`);
            continue;
        }
        // An example demonstrates the capability when it carries EVERY proof.
        // A dotted proof (`session.new`) is satisfied by a dotted member path
        // that ends with it (`methods.agent.session.new`).
        const matches = examples
            .map((example) => ({
                name: example.name,
                has: entry.proof.filter((proof) => hasProof({ example, proof })),
            }))
            .filter((candidate) => candidate.has.length === entry.proof.length);

        if (matches.length > 0) {
            lines.push(`  ✓ ${entry.capability} — ${matches.map((m) => m.name).join(', ')}`);
            continue;
        }
        // The proofs NO example carries — not the ones one example misses:
        // naming a proof that another example does demonstrate would send the
        // reader after the wrong file.
        const missing = entry.proof.filter((proof) => !examples.some((example) => hasProof({ example, proof })));
        failed.push({ capability: entry.capability, missing });
        // When every proof is demonstrated SOMEWHERE, the capability still
        // fails because no SINGLE example carries all of them — say that.
        const detail = missing.length > 0
            ? `missing: ${missing.join(', ')}`
            : `no single example carries all of: ${entry.proof.join(', ')}`;
        lines.push(`  ✗ ${entry.capability} — ${detail}`);
    }

    return { failed: failed.length, total: capabilities.length, lines };
}

const result = checkExampleCoverage();
const summary = `example coverage gate — ${result.total - result.failed}/${result.total} capabilities demonstrated by an example`;
process.stdout.write(`${summary}\n`);
for (const line of result.lines) process.stdout.write(`${line}\n`);
if (result.failed > 0) {
    process.stdout.write(`${summary} — FAIL\n`);
    process.exitCode = 1;
}
