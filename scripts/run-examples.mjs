#!/usr/bin/env node
// @ts-check
/**
 * @file CI runner for the deterministic example set.
 * @version 0.12.0
 *
 * Runs the audited examples end-to-end with `--offline` and asserts they finish
 * with a clean audit scoreboard (`[AUDIT-RESULT] … "failed":0,"errors":0`).
 * Every audited example is live by default, or offline by construction: the
 * flag selects the scripted, backend-free path (a no-op for one that has no
 * live path at all), so CI needs no credentials and gets a stable transcript.
 * The remaining examples are live-only and run by path.
 *
 * Used by `pnpm test:examples` and by `test/examples-run.test.mjs`.
 *
 *   node scripts/run-examples.mjs            # run the audited set offline
 *   node scripts/run-examples.mjs --list     # print the audited set
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The deterministic audit set. These are TESTS, not demonstrations, and they
 * live under `test/examples/` — the user-facing `examples/` tree is live-only
 * by design. Every entry takes `--offline`; add a file here only once its
 * offline path runs to completion WITHOUT secret.env, a model, network, or
 * interactive stdin.
 * @type {readonly string[]}
 */
export const OFFLINE_EXAMPLES = Object.freeze([
    'test/examples/27_spawning_contract.mjs',
    'test/examples/28_workspace_isolation.mjs',
    'test/examples/29_workflow_contract.mjs',
    'test/examples/30_work_sources.mjs',
    'test/examples/31_scheduler.mjs',
    'test/examples/32_engine_runner.mjs',
    'test/examples/33_operator_api.mjs',
    'test/examples/34_orchestration.mjs',
    'test/examples/35_capstone.mjs',
    'test/examples/36_connected_layers.mjs',
]);

/**
 * Extra argv for the audited examples: CI selects the deterministic path
 * explicitly; an offline-by-construction example accepts the flag as a no-op.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const OFFLINE_ARGS = Object.freeze(Object.fromEntries(
    OFFLINE_EXAMPLES.map((rel) => [rel, ['--offline']])
));

/**
 * Parses the last `[AUDIT-RESULT] {json}` machine line out of captured output.
 * @param {{ stdout: string }} args - combined stdout+stderr of an example run.
 * @returns {{ example?: string, checks?: number, passed?: number, failed?: number, skipped?: number, errors?: number, log?: string }|null}
 */
export function parseAuditResult({ stdout }) {
    const lines = String(stdout ?? '').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/\[AUDIT-RESULT\]\s*(\{.*\})\s*$/);
        if (m) {
            try { return JSON.parse(m[1]); } catch { return null; }
        }
    }
    return null;
}

/**
 * Runs one example in a child process and evaluates its audit scoreboard.
 * @param {{ rel: string, timeoutMs?: number }} args - `rel` is relative to the repo root.
 * @returns {Promise<{ ok: boolean, reason: string, code: number|null, result: ReturnType<typeof parseAuditResult>, stdout: string }>}
 */
export function runExample({ rel, timeoutMs = 120_000 }) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
        return Promise.resolve({ ok: false, reason: `missing file: ${rel}`, code: null, result: null, stdout: '' });
    }
    return new Promise((resolvePromise) => {
        const proc = spawn(process.execPath, [abs, ...(OFFLINE_ARGS[rel] ?? [])], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { proc.kill('SIGKILL'); }, timeoutMs);
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (err) => {
            clearTimeout(timer);
            resolvePromise({ ok: false, reason: `spawn error: ${err.message}`, code: null, result: null, stdout: stdout + stderr });
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            const combined = stdout + stderr;
            const result = parseAuditResult({ stdout: combined });
            let ok = code === 0;
            let reason = '';
            if (code !== 0) reason = `exit code ${code}`;
            else if (!result) { ok = false; reason = 'no [AUDIT-RESULT] line found'; }
            else if ((result.failed ?? 0) > 0 || (result.errors ?? 0) > 0) { ok = false; reason = `audit reported failed=${result.failed} errors=${result.errors}`; }
            resolvePromise({ ok, reason, code, result, stdout: combined });
        });
    });
}

async function main() {
    if (process.argv.includes('--list')) {
        for (const rel of OFFLINE_EXAMPLES) process.stdout.write(`${rel}\n`);
        return;
    }
    let failed = 0;
    for (const rel of OFFLINE_EXAMPLES) {
        process.stdout.write(`▶ ${rel}\n`);
        const r = await runExample({ rel });
        const score = r.result ? `checks=${r.result.checks} passed=${r.result.passed} failed=${r.result.failed} errors=${r.result.errors}` : 'no audit line';
        if (r.ok) process.stdout.write(`  ✓ ${score}\n`);
        else { failed++; process.stdout.write(`  ✗ ${r.reason} (${score})\n`); process.stdout.write(`${r.stdout.split('\n').slice(-25).join('\n')}\n`); }
    }
    process.stdout.write(`\n${OFFLINE_EXAMPLES.length - failed}/${OFFLINE_EXAMPLES.length} offline examples clean\n`);
    if (failed) process.exitCode = 1;
}

/**
 * `argv[1]` may be a symlinked or vanished path; compare real paths without throwing.
 * @type {(p: string) => string}
 */
const canonical = (p) => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
    main();
}
