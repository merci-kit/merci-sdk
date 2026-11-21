#!/usr/bin/env node


/**
 * @file Generated shell-tier blocks for the shipped skills.
 * @version 0.7.2
 *
 * @description
 * The skills tell the model which commands run without a prompt. That list is
 * a copy of `SHELL_TOOL_DEFAULT_SAFE_COMMANDS` / `..._BLOCKED_COMMANDS`, and a
 * copy drifts. This generator renders the block from the constants and rewrites
 * it in place, exactly as `build-structure.mjs` does for STRUCTURE.md.
 *
 *   node scripts/build-skill-tables.mjs           rewrite the blocks
 *   node scripts/build-skill-tables.mjs --check   exit 1 when a block is stale
 *
 * The block is delimited by HTML comments so a human can see where generated
 * text starts and stops. `scripts/check-skill.mjs` runs the same check as S9,
 * so `pnpm test` catches a constant change that was not regenerated.
 *
 * Deterministic: sorted, de-duplicated, wrapped to a fixed width, no timestamps.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    SHELL_TOOL_DEFAULT_SAFE_COMMANDS,
    SHELL_TOOL_DEFAULT_BLOCKED_COMMANDS,
} from '../lib/core/constants/shell-tool-lists.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const TIER_BEGIN = '<!-- BEGIN GENERATED: shell-tiers -->';
export const TIER_END = '<!-- END GENERATED: shell-tiers -->';

/** Files whose tier block is generated, relative to the repository root. */
export const SKILL_TIER_TARGETS = Object.freeze([
    'skills/cli-search/SKILL.md',
    'skills/shell-scripting/references/argv-recipes.md',
]);

/**
 * Packs words into lines of at most `width` characters.
 * @param {string[]} words
 * @param {number} width
 * @returns {string[]}
 */
function wrap({ words, width }) {
    /** @type {string[]} */
    const lines = [];
    let line = '';
    for (const word of words) {
        if (line === '') { line = word; continue; }
        if (line.length + 1 + word.length > width) { lines.push(line); line = word; continue; }
        line += ` ${word}`;
    }
    if (line !== '') lines.push(line);
    return lines;
}

/**
 * Renders the generated region (without the markers).
 * @param {{safeCommands?: readonly string[], blockedCommands?: readonly string[], width?: number}} [arg0]
 * @returns {string}
 */
export function renderTierBlock({ safeCommands = SHELL_TOOL_DEFAULT_SAFE_COMMANDS, blockedCommands = SHELL_TOOL_DEFAULT_BLOCKED_COMMANDS, width = 76 } = {}) {
    const safe = [...new Set(safeCommands)].sort();
    const blocked = [...new Set(blockedCommands)].sort();
    return [
        'Read-only, no prompt (the per-option allowlist still applies):',
        '',
        '```text',
        ...wrap({ words: safe, width }),
        '```',
        '',
        'Blocked, no override:',
        '',
        '```text',
        ...wrap({ words: blocked, width }),
        '```',
        '',
        'Everything else asks the human once.',
    ].join('\n');
}

/** @param {{text: string, needle: string}} arg0 @returns {number} */
function countOf({ text, needle }) {
    return text.split(needle).length - 1;
}

/**
 * Replaces the region between the markers.
 *
 * Exactly one pair is required. A quoted marker in an example, a nested pair or
 * a second block would otherwise make the first-marker-wins replacement delete
 * prose that sits between the two — and the gate would then bless the result.
 * @param {{text: string, block: string}} arg0
 * @returns {string|null} The updated text, or null when the markers are not exactly one pair.
 */
export function replaceTierBlock({ text, block }) {
    if (countOf({ text, needle: TIER_BEGIN }) !== 1 || countOf({ text, needle: TIER_END }) !== 1) return null;
    const start = text.indexOf(TIER_BEGIN);
    const end = text.indexOf(TIER_END);
    if (end < start) return null;
    return `${text.slice(0, start + TIER_BEGIN.length)}\n${block}\n${text.slice(end)}`;
}

/**
 * Compares one file's block against the render. Returns a problem string, or
 * null when the file is current.
 * @param {{abs: string, block: string, label?: string}} arg0
 * @returns {string|null}
 */
export function checkTierFile({ abs, block, label = abs }) {
    let text;
    try {
        text = readFileSync(abs, 'utf8');
    } catch {
        return `${label} is missing`;
    }
    const begins = countOf({ text, needle: TIER_BEGIN });
    const ends = countOf({ text, needle: TIER_END });
    if (begins !== 1 || ends !== 1) {
        return `${label} has ${begins} BEGIN and ${ends} END shell-tier markers — expected exactly one pair`;
    }
    const next = replaceTierBlock({ text, block });
    if (next === null) return `${label} has malformed shell-tier markers`;
    if (next !== text) return `${label} has a stale shell-tier block — run \`pnpm run build:skill-tables\``;
    return null;
}

/** @param {{write: boolean}} arg0 */
function run({ write }) {
    const block = renderTierBlock({});
    /** @type {string[]} */
    const problems = [];
    for (const rel of SKILL_TIER_TARGETS) {
        const abs = join(ROOT, rel);
        if (!write) {
            const problem = checkTierFile({ abs, block });
            if (problem) problems.push(problem);
            continue;
        }
        const text = readFileSync(abs, 'utf8');
        const next = replaceTierBlock({ text, block });
        if (next === null) {
            problems.push(`${abs} has no shell-tier markers`);
            continue;
        }
        if (next !== text) writeFileSync(abs, next);
    }
    if (problems.length > 0) {
        for (const problem of problems) process.stderr.write(`skill tables — ${problem}\n`);
        process.exit(1);
    }
    process.stdout.write(`skill tables — ${SKILL_TIER_TARGETS.length} block(s) ${write ? 'written' : 'current'}\n`);
}

/**
 * `argv[1]` may be a symlinked or vanished path; compare real paths without throwing.
 * @type {(p: string) => string}
 */
const canonical = (p) => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };

const invokedDirectly = Boolean(process.argv[1]) && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url));
if (invokedDirectly) run({ write: !process.argv.slice(2).includes('--check') });
