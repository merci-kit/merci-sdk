// @ts-check
/**
 * Real-I/O tools for the examples — every tool here performs genuine work
 * (HTTP requests, filesystem reads/writes, environment lookups) instead of
 * returning canned JSON. They replace the old mock tools whose `execute`
 * ignored their args and hardcoded `recordsAffected: 42`-style answers.
 *
 * Each tool stays hermetic: writes go under `scratchpad/examples/`, HTTP
 * targets are local servers the example spawns itself — no external
 * dependencies, no network egress, but real bytes and real status codes.
 *
 * @version 0.12.0
 */

/**
 * Real-I/O tools for the examples — every tool here performs genuine work
 * (HTTP requests, filesystem reads/writes, environment lookups) instead of
 * returning canned JSON. They replace the old mock tools whose `execute`
 * ignored their args and hardcoded `recordsAffected: 42`-style answers.
 *
 * Each tool stays hermetic: writes go under `scratchpad/examples/`, HTTP
 * targets are local servers the example spawns itself — no external
 * dependencies, no network egress, but real bytes and real status codes.
 *
 * @version 0.12.0
 */

/**
 * Real-I/O tools for the examples — every tool here performs genuine work
 * (HTTP requests, filesystem reads/writes, environment lookups) instead of
 * returning canned JSON. They replace the old mock tools whose `execute`
 * ignored their args and hardcoded `recordsAffected: 42`-style answers.
 *
 * Each tool stays hermetic: writes go under `scratchpad/examples/`, HTTP
 * targets are local servers the example spawns itself — no external
 * dependencies, no network egress, but real bytes and real status codes.
 *
 * @version 0.12.0
 */

/**
 * Real-I/O tools for the examples — every tool here performs genuine work
 * (HTTP requests, filesystem reads/writes, environment lookups) instead of
 * returning canned JSON. They replace the old mock tools whose `execute`
 * ignored their args and hardcoded `recordsAffected: 42`-style answers.
 *
 * Each tool stays hermetic: writes go under `scratchpad/examples/`, HTTP
 * targets are local servers the example spawns itself — no external
 * dependencies, no network egress, but real bytes and real status codes.
 *
 * @version 0.12.0
 */


/**
 * Real-I/O tools for the examples — every tool here performs genuine work
 * (HTTP requests, filesystem reads/writes, environment lookups) instead of
 * returning canned JSON. They replace the old mock tools whose `execute`
 * ignored their args and hardcoded `recordsAffected: 42`-style answers.
 *
 * Each tool stays hermetic: writes go under `scratchpad/examples/`, HTTP
 * targets are local servers the example spawns itself — no external
 * dependencies, no network egress, but real bytes and real status codes.
 *
 * @version 0.12.0
 */
import { mkdir, writeFile, appendFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/**
 * The scratch directory all real-I/O tools write under (repo-root
 * `scratchpad/examples/`), kept out of git.
 * @type {string}
 */
export const SCRATCH_DIR = join(REPO_ROOT, 'scratchpad', 'examples');

async function ensureScratch() {
    await mkdir(SCRATCH_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


/**
 * Spawns a tiny local HTTP server (127.0.0.1, ephemeral port) exposing a
 * REST-ish /legacy/inventory route and a GraphQL-ish /graphql route. The
 * example passes its base URL as the workflow context endpoint, so the probe
 * tool performs a REAL fetch round-trip against a real listening socket.
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>}
 */
export async function startLocalApiServer() {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/graphql') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: { inventory: { __typename: 'InventorySync', records: 42, synced: true } } }));
            return;
        }
        if (url.pathname === '/legacy/inventory') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', recordsAffected: 42, api: 'rest' }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
    const addr =  (server.address());
    const baseUrl = `http://127.0.0.1:${/** @type {any} */ (addr).port}`;
    return { baseUrl, close: () => new Promise((resolve) => { server.close(() => resolve(undefined)); }) };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


/**
 * Creates the `probe_api` tool — a REAL HTTP probe with a fetch timeout and
 * an SSRF guard (loopback hosts only).
 * @param {{ timeoutMs?: number }} [options] - per-request timeout (default 5000ms).
 * @returns {{ name: string, description: string, parameters: Record<string, any>, execute: Function }} the tool object, for withTools.
 */
export function createHttpProbeTool({ timeoutMs = 5000 } = {}) {
    return {
        name: 'probe_api',
        description: 'Probes an HTTP endpoint for API type and metadata. Performs a real HTTP request and reports the real status, content type, and detected API kind. Restricted to loopback hosts (127.0.0.1 / localhost / ::1) — a demo tool must never let the model reach arbitrary network hosts.',
        parameters: { type: 'object', properties: { endpoint: { type: 'string' } }, required: ['endpoint'] },
        /** @param {{args?: *}} arg0 */
        execute: async ({ args: { endpoint } = {} }) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                // ponytail: SSRF guard — the probe is a LOCAL demo tool; only
                let url;
                try { url = new URL(endpoint); } catch {
                    return JSON.stringify({ status: 0, ok: false, error: `invalid URL: ${endpoint}` });
                }
                if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
                    return JSON.stringify({ status: 0, ok: false, error: `refusing to probe non-loopback host "${url.hostname}"` });
                }
                const started = Date.now();
                const res = await fetch(endpoint, { signal: controller.signal, redirect: 'error' });
                const text = await res.text();
                const contentType = (res.headers.get('content-type') ?? '').split(';')[0];
                let detectedType = 'unknown';
                if (text.includes('__typename')) detectedType = 'graphql';
                else if (contentType === 'application/json' || text.trimStart().startsWith('{')) detectedType = 'json';
                else if (contentType === 'text/html') detectedType = 'html';
                return JSON.stringify({
                    status: res.status,
                    ok: res.ok,
                    contentType,
                    detectedType,
                    latencyMs: Date.now() - started,
                    bodyPreview: text.slice(0, 200),
                });
            } catch (error) {
                const e =  (error);
                return JSON.stringify({ status: 0, ok: false, error: /** @type {any} */ (e).name === 'AbortError' ? `timeout after ${timeoutMs}ms` : /** @type {any} */ (e).message });
            } finally {
                clearTimeout(timer);
            }
        },
    };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


/**
 * Creates the `sync_data` tool — persists the payload to a dated JSON file
 * under the scratch dir and reports the real path + written byte count.
 * @param {{ dir?: string }} [options] - target directory (default SCRATCH_DIR).
 * @returns {{ name: string, description: string, parameters: Record<string, any>, execute: Function }} the tool object, for withTools.
 */
export function createSyncDataTool({ dir = SCRATCH_DIR } = {}) {
    return {
        name: 'sync_data',
        description: 'Syncs a data payload by persisting it to a real JSON file under the scratch dir. Returns the real file path and the number of records written.',
        parameters: { type: 'object', properties: { type: { type: 'string', enum: ['rest', 'graphql'] }, payload: { type: 'object' } }, required: ['type', 'payload'] },
        /** @param {{args?: *}} arg0 */
        execute: async ({ args: { type = 'json', payload = {} } = {} }) => {
            await mkdir(dir, { recursive: true });
            const records = Array.isArray(payload) ? payload.length : Object.keys(payload ?? {}).length;
            const file = join(dir, `sync-${type}-${Date.now()}.json`);
            await writeFile(file, JSON.stringify({ syncedAt: new Date().toISOString(), type, records, payload }, null, 2), 'utf8');
            const stat = (await import('node:fs/promises')).stat;
            const { size } = await stat(file);
            return JSON.stringify({ synced: true, recordsAffected: records, file: relative(REPO_ROOT, file), bytes: size });
        },
    };
}

// ---------------------------------------------------------------------------
// insecure patterns, reports genuine file:line findings
// ---------------------------------------------------------------------------

const INSECURE_PATTERNS = [
    { id: 'eval', pattern: /\beval\s*\(/, severity: 'high', label: 'eval() call' },
    { id: 'innerHTML', pattern: /\.innerHTML\s*=/, severity: 'medium', label: 'innerHTML assignment (XSS surface)' },
    { id: 'child_process', pattern: /(?:exec|spawn|fork)\s*\(\s*['"`]/, severity: 'medium', label: 'shell command from string' },
    { id: 'noopener', pattern: /window\.open\s*\(/, severity: 'low', label: 'window.open without noopener' },
    {
        id: 'hardcoded_secret', severity: 'critical', label: 'hardcoded credential',
        // ponytail: a key name echoed as its value (`JAI_TOKEN = 'JAI_TOKEN'`)
        pattern: /(?:^|[^A-Za-z0-9_])(api[_-]?key|secret|password|token)\s*[:=]\s*(['"])(.{8,})\2/i,
        /** @param {{line: *, m: *}} arg0 */
        reject: ({ line, m }) => {
            const key = String(m[1]).toLowerCase().replace(/[^a-z0-9]/g, '');
            const val = String(m[3]).toLowerCase().replace(/[^a-z0-9]/g, '');
            return key.length > 0 && val === key;
        },
    },
];

/** @param {{root: *, maxFiles?: *, skipDirs?: *}} arg0 */
async function walkFiles({ root, maxFiles = 500, skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next']) }) {
    
    /** @type {string[]} */
        const out = [];
    /** @param {{dir: *}} arg0 */
    /** @param {{dir: *}} arg0 */
    const rec = async ({ dir }) => {
        if (out.length >= maxFiles) return;
        let entries = [];
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (out.length >= maxFiles) return;
            if (e.isDirectory()) {
                if (!skipDirs.has(e.name)) await rec({ dir: join(dir, e.name) });
            } else if (/\.(mjs|js|ts|jsx|tsx)$/.test(e.name)) {
                out.push(join(dir, e.name));
            }
        }
    };
    await rec({ dir: root });
    return out;
}


/**
 * Creates the `scan_vulnerabilities` tool — walks a source tree and reports
 * genuine file:line findings for insecure patterns (eval, innerHTML,
 * hardcoded credentials, ...). Targets are clamped to the scan root.
 * @param {{ root?: string, maxFiles?: number }} [options] - scan root (default repo root) and file cap (default 500).
 * @returns {{ name: string, description: string, parameters: Record<string, any>, execute: Function }} the tool object, for withTools.
 */
export function createSecurityScanTool({ root = REPO_ROOT, maxFiles = 500 } = {}) {
    return {
        name: 'scan_vulnerabilities',
        description: 'Scans a source tree for common insecure patterns (eval, innerHTML, hardcoded credentials, ...). Returns real file:line findings with severity.',
        parameters: { type: 'object', properties: { target: { type: 'string', description: 'Directory (relative to repo root) to scan, e.g. "lib" or "examples".' } }, required: ['target'] },
        /** @param {{args?: *}} arg0 */
        execute: async ({ args: { target = '.' } = {} }) => {
            // ponytail: the scan stays inside the repo root — a `../` or
            const base = resolve(root, String(target ?? '.'));
            if (base !== root && !base.startsWith(root + sep)) {
                return JSON.stringify({ scannedFiles: 0, target: String(target), findings: [], bySeverity: {}, error: 'target escapes the scan root' });
            }
            const files = await walkFiles({ root: base });
            const findings = [];
            for (const file of files) {
                const raw = await readFile(file, 'utf8').catch(() => null);
                if (raw === null) continue;
                const lines = raw.split('\n');
                for (let i = 0; i < lines.length && findings.length < 100; i++) {
                    for (const p of INSECURE_PATTERNS) {
                        const m = p.pattern.exec(lines[i]);
                        if (m && !(p.reject && p.reject({ line: lines[i], m }))) {
                            findings.push({ id: p.id, severity: p.severity, label: p.label, file: relative(root, file), line: i + 1 });
                        }
                    }
                }
            }
            const bySeverity = /** @type {Record<string, number>} */ ({});
            for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
            return JSON.stringify({ scannedFiles: files.length, target: relative(root, base), findings, bySeverity });
        },
    };
}

// ---------------------------------------------------------------------------
// persistent log file under the scratch dir
// ---------------------------------------------------------------------------


/**
 * Creates the `apply_patch` tool — appends a remediation decision (CVE +
 * fix) to a persistent audit log under the scratch dir.
 * @param {{ dir?: string }} [options] - log directory (default SCRATCH_DIR).
 * @returns {{ name: string, description: string, parameters: Record<string, any>, execute: Function }} the tool object, for withTools.
 */
export function createApplyPatchTool({ dir = SCRATCH_DIR } = {}) {
    return {
        name: 'apply_patch',
        description: 'Records a remediation decision (CVE + fix) in a persistent audit log under the scratch dir. Returns the log path and the real written length.',
        parameters: { type: 'object', properties: { cve: { type: 'string' }, fix: { type: 'string' } }, required: ['cve', 'fix'] },
        /** @param {{args?: *}} arg0 */
        execute: async ({ args: { cve, fix } = {} }) => {
            await ensureScratch();
            const logFile = join(dir, 'remediations.jsonl');
            const entry = JSON.stringify({ cve, fix, appliedAt: new Date().toISOString() });
            await appendFile(logFile, `${entry}\n`, 'utf8');
            return JSON.stringify({ patched: true, cve, status: 'recorded', log: relative(REPO_ROOT, logFile), bytes: entry.length });
        },
    };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


/**
 * Creates the `resolve_parameter` tool — resolves a config key from
 * process.env first, then a KEY=value dotenv file in the repo root.
 * @returns {{ name: string, description: string, parameters: Record<string, any>, execute: Function }} the tool object, for withTools.
 */
export function createResolveParameterTool() {
    return {
        name: 'resolve_parameter',
        description: 'Resolves a configuration parameter from the environment (process.env) or a KEY=value dotenv file in the repo root. Returns the real value or an explicit miss. WARNING: this is a demo tool — resolving a credential key (JAI_TOKEN etc.) will return the secret value into the conversation; callers must not resolve secrets.',
        parameters: { type: 'object', properties: { param_name: { type: 'string' } }, required: ['param_name'] },
        /** @param {{args?: *}} arg0 */
        execute: async ({ args: { param_name } = {} }) => {
            const key = String(param_name ?? '').trim().toUpperCase();
            if (!key) return JSON.stringify({ param_name, resolved: false, reason: 'no parameter name given' });
            if (process.env[key] !== undefined) {
                return JSON.stringify({ param_name: key, resolved: true, source: 'process.env', resolved_value: process.env[key] });
            }
            for (const file of ['secret.env', '.env']) {
                const raw = await readFile(join(REPO_ROOT, file), 'utf8').catch(() => null);
                if (raw === null) continue;
                for (const line of raw.split('\n')) {
                    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
                    if (m && m[1].toUpperCase() === key) {
                        return JSON.stringify({ param_name: key, resolved: true, source: file, resolved_value: m[2] });
                    }
                }
            }
            return JSON.stringify({ param_name: key, resolved: false, reason: `no value for ${key} in env or secret.env/.env` });
        },
    };
}

// ---------------------------------------------------------------------------
// local equivalent: a persisted, verifiable restart order.)
// ---------------------------------------------------------------------------


/**
 * Creates the `restart_system` tool — persists a timestamped restart-order
 * marker under the scratch dir (the honest local equivalent of a reboot).
 * @param {{ dir?: string }} [options] - marker directory (default SCRATCH_DIR).
 * @returns {{ name: string, description: string, parameters: Record<string, any>, execute: Function }} the tool object, for withTools.
 */
export function createRestartSystemTool({ dir = SCRATCH_DIR } = {}) {
    return {
        name: 'restart_system',
        description: 'Issues a restart order for the target: persists a timestamped restart marker under the scratch dir (the honest local equivalent of a reboot for a demo).',
        parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
        /** @param {{args?: *}} arg0 */
        execute: async ({ args: { target } = {} }) => {
            await ensureScratch();
            const file = join(dir, `restart-${Date.now()}.json`);
            const record = { target, requestedAt: new Date().toISOString(), pid: process.pid };
            await writeFile(file, JSON.stringify(record, null, 2), 'utf8');
            return JSON.stringify({ status: 'restart ordered', target, marker: relative(REPO_ROOT, file), requestedAt: record.requestedAt });
        },
    };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


/**
 * Creates the `validate_remediation` tool — re-runs the vulnerability scan
 * over the same target and reports what genuinely remains.
 * @param {{ root?: string, maxFiles?: number }} [options] - same options as createSecurityScanTool.
 * @returns {{ name: string, description: string, parameters: Record<string, any>, execute: Function }} the tool object, for withTools.
 */
export function createValidateRemediationTool({ root = REPO_ROOT, maxFiles = 500 } = {}) {
    const scan = createSecurityScanTool({ root, maxFiles });
    return {
        name: 'validate_remediation',
        description: 'Re-runs the vulnerability scan over the target and reports what genuinely remains after remediation.',
        parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
        /** @param {{args?: *}} arg0 */
        execute: async ({ args: { target = '.' } = {} }) => await scan.execute({ args: { target } }),
    };
}
