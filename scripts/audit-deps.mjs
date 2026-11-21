#!/usr/bin/env node


/**
 * @file Dependency advisory gate.
 * @version 0.7.2
 *
 * @description
 * Fails when the production dependency tree carries a known advisory. The
 * audit is run in production mode only: dev-only tooling is not shipped to
 * consumers and must not block a release.
 *
 * Patched transitive versions are pinned through `pnpm.overrides` in
 * `pnpm-workspace.yaml` (pnpm 11 reads overrides there, not in package.json).
 *
 * Run: `node scripts/audit-deps.mjs` (or `pnpm run audit:deps`).
 * Exit 1 when any advisory remains.
 */
import { execFileSync } from 'node:child_process';

const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * @param {{command: string, args: string[]}} arg0
 * @returns {string}
 */
function run({ command, args } = {}) {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let raw = '';
try {
    raw = run({ command: PNPM, args: ['audit', '--prod', '--json'] });
} catch (err) {
    // pnpm exits non-zero when advisories are found; the JSON still lands on stdout.
    const stdout = /** @type {any} */ (err)?.stdout;
    if (typeof stdout !== 'string' || stdout.trim() === '') {
        process.stderr.write(`audit-deps gate — audit could not run: ${/** @type {any} */ (err)?.message ?? err}\n`);
        process.exit(1);
    }
    raw = stdout;
}

/** @type {{advisories?: Record<string, any>, metadata?: {vulnerabilities?: Record<string, number>}, vulnerabilities?: Record<string, any>}} */
let parsed;
try {
    parsed = JSON.parse(raw);
} catch {
    process.stderr.write('audit-deps gate — could not parse `pnpm audit --json` output\n');
    process.exit(1);
}

// pnpm reports `advisories` + `metadata.vulnerabilities`; npm reports
// `vulnerabilities`. Read all three so a change of shape cannot silently
// turn this gate into a no-op.
const advisories = Object.values(parsed.advisories ?? {});
const metadataCounts = parsed.metadata?.vulnerabilities ?? {};
const metadataTotal = Object.values(metadataCounts).reduce((sum, n) => sum + Number(n || 0), 0);
const npmVulnerabilities = Object.values(parsed.vulnerabilities ?? {});
const npmTotal = npmVulnerabilities.reduce((sum, v) => sum + Number(v?.severity ? 1 : 0), 0);

if (advisories.length === 0 && metadataTotal === 0 && npmTotal === 0) {
    const dependencies = parsed.metadata?.dependencies ?? 0;
    process.stdout.write(`audit-deps gate — 0 advisories (${dependencies} production dependencies)\n`);
    process.exit(0);
}

/** @type {Record<string, number>} */
const bySeverity = {};
for (const advisory of advisories) {
    const severity = String(advisory.severity ?? 'unknown');
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
}

process.stderr.write(`audit-deps gate — ${advisories.length || metadataTotal || npmTotal} advisories (${JSON.stringify(bySeverity)}):\n`);
for (const advisory of advisories) {
    process.stderr.write(`  [${advisory.severity}] ${advisory.module_name} — ${advisory.title ?? ''}\n`);
    process.stderr.write(`      patched in: ${advisory.patched_versions ?? 'unknown'}\n`);
}
if (!advisories.length) {
    for (const [name, count] of Object.entries(metadataCounts)) {
        if (Number(count) > 0) process.stderr.write(`  [${name}] ${count} advisory/advisories\n`);
    }
    for (const vulnerability of npmVulnerabilities) {
        process.stderr.write(`  [${vulnerability.severity ?? 'unknown'}] ${vulnerability.name ?? vulnerability.module_name ?? 'unknown'}\n`);
    }
}
process.stderr.write('  Fix: bump the direct dependency, or pin a patched version via pnpm.overrides in pnpm-workspace.yaml.\n');
process.exit(1);
