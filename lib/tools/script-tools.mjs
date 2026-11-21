// @ts-check


/**
 * @file Script-backed tools — one interpreter map, contained script resolution,
 * and the plain Tool object that runs a script.
 * @version 0.12.0
 *
 * @description
 * A script tool runs a file the host already placed on disk: no shell string,
 * an interpreter chosen by the file's real extension, the call arguments as one
 * JSON argv, a bounded child environment and capped output. `resolveScript`
 * is the trust boundary — it rejects a symlink, a path outside the declared
 * root, a non-file, an unsupported extension and an oversized file before a
 * tool is ever built, and records the bytes' hash so a resume can notice that
 * the script changed.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, resolve } from 'node:path';

import { ConfigurationError } from '../core/errors.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { isInsideRoot } from '../support/path-safety.mjs';
import { runCommand } from '../support/run-command.mjs';
import { capToolOutput } from './external-capability.mjs';


/**
 * Scripts run under the interpreter their extension selects. An extension that
 * is absent here is not a runnable script; nothing falls back to `sh` (F19).
 * @type {Map<string, string>}
 */
export const SCRIPT_INTERPRETERS = new Map([
    ['.js', 'node'], ['.mjs', 'node'], ['.cjs', 'node'],
    ['.sh', 'bash'], ['.bash', 'bash'], ['.zsh', 'zsh'],
    ['.py', 'python3'], ['.rb', 'ruby'], ['.pl', 'perl'],
]);


/**
 * The interpreter for a script path, or `null` when the extension is unknown or
 * absent.
 * @param {{path?: string}} [arg0] -
 * @returns {string|null}
 */
export function resolveScriptInterpreter({ path } = {}) {
    if (typeof path !== 'string' || !path) return null;
    return SCRIPT_INTERPRETERS.get(extname(path).toLowerCase()) ?? null;
}


/**
 * A `ConfigurationError` that also carries the stable reason a caller branches
 * on. `ConfigurationError` names the option; the category travels on `reason`.
 * @param {{reason: string, message: string}} arg0 -
 * @returns {ConfigurationError & {reason: string}}
 */
function scriptError({ reason, message }) {
    const error = new ConfigurationError({ message, options: { option: 'script' } });
    /** @type {ConfigurationError & {reason?: string}} */ (error).reason = reason;
    return /** @type {ConfigurationError & {reason: string}} */ (error);
}


/**
 * Resolves a script path against `baseDir` and proves it is a regular, contained,
 * supported, not oversize file. Symlinks are rejected outright: a link can be
 * repointed after the host reviewed the file it named.
 * @param {{script?: string, baseDir?: string, root?: string, maxBytes?: number}} [arg0] -
 * @returns {Promise<{path: string, interpreter: string, size: number, hash: string}>} The real path, interpreter, byte size and sha256 of the bytes.
 */
export async function resolveScript({ script, baseDir, root, maxBytes = LIMITS.agent_script_max_bytes } = {}) {
    if (typeof script !== 'string' || !script || typeof baseDir !== 'string' || !baseDir || typeof root !== 'string' || !root) {
        throw scriptError({ reason: 'script_missing', message: 'resolveScript requires a script, a baseDir and a root.' });
    }
    const target = resolve(baseDir, script);

    /** @type {import('node:fs').Stats} */
    let entry;
    try {
        entry = await fs.lstat(target);
    } catch {
        throw scriptError({ reason: 'script_missing', message: `Script not found: ${script}` });
    }
    if (entry.isSymbolicLink()) {
        throw scriptError({ reason: 'script_symlink', message: `Script is a symlink: ${script}` });
    }
    if (!entry.isFile()) {
        throw scriptError({ reason: 'script_not_file', message: `Script is not a regular file: ${script}` });
    }

    const realPath = await fs.realpath(target);
    const realRoot = await fs.realpath(resolve(root)).catch(() => null);
    if (!realRoot || !isInsideRoot({ root: realRoot, path: realPath })) {
        throw scriptError({ reason: 'script_outside_root', message: `Script is outside ${root}: ${script}` });
    }

    const interpreter = resolveScriptInterpreter({ path: realPath });
    if (!interpreter) {
        throw scriptError({ reason: 'script_unsupported', message: `Unsupported script extension: ${extname(realPath) || '(none)'}` });
    }
    if (entry.size > maxBytes) {
        throw scriptError({ reason: 'script_too_large', message: `Script ${script} is ${entry.size} bytes (limit ${maxBytes}).` });
    }

    const bytes = await fs.readFile(realPath);
    return { path: realPath, interpreter, size: entry.size, hash: createHash('sha256').update(bytes).digest('hex') };
}


/**
 * Builds the plain Tool object for a normalized script definition. The tool
 * advertises `runsCode: true` and is never idempotent; approval defaults on
 * (F16). Only the parent keys listed in `envKeys` reach the child — never the
 * whole environment.
 * @param {{definition?: {name?: string, description?: string, parameters?: import('../support/json.mjs').JsonSchema, scriptPath?: string, interpreter?: string, timeoutMs?: number, envKeys?: Array<string>, baseDir?: string, requiresApproval?: boolean}}} [arg0] -
 * @returns {import('./tool-execution.mjs').ReadyTool & {runsCode: true, idempotent: false}}
 */
export function createScriptTool({ definition } = {}) {
    const {
        name,
        description = '',
        parameters = { type: 'object', properties: {} },
        scriptPath,
        interpreter,
        timeoutMs = LIMITS.agent_script_timeout_ms,
        envKeys = [],
        baseDir,
        requiresApproval = true
    } = definition ?? {};
    if (typeof name !== 'string' || !name) {
        throw new ConfigurationError({ message: 'createScriptTool requires definition.name.', options: { option: 'name' } });
    }
    if (typeof scriptPath !== 'string' || !scriptPath) {
        throw new ConfigurationError({ message: `Script tool '${name}' requires a resolved scriptPath.`, options: { option: 'script' } });
    }
    if (typeof interpreter !== 'string' || !interpreter) {
        throw new ConfigurationError({ message: `Script tool '${name}' requires an interpreter.`, options: { option: 'interpreter' } });
    }
    const forwarded = Array.isArray(envKeys) ? envKeys.filter((key) => typeof key === 'string' && key.length > 0) : [];
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : LIMITS.agent_script_timeout_ms;

    return {
        name,
        description: String(description ?? ''),
        parameters,
        runsCode: true,
        idempotent: false,
        requiresApproval: Boolean(requiresApproval),
        /**
         * @param {{args?: unknown, signal?: AbortSignal|null, context?: Record<string, unknown>}} arg0 -
         * @returns {Promise<string>}
         */
        execute: async ({ args, signal }) => {
            /** @type {Record<string, string>} */
            const env = {};
            for (const key of forwarded) {
                const value = process.env[key];
                if (value !== undefined) env[key] = value;
            }
            const { code, stdout, stderr } = await runCommand({
                command: interpreter,
                args: [scriptPath, JSON.stringify(args ?? {})],
                signal,
                timeoutMs: budget,
                cwd: baseDir,
                ...(Object.keys(env).length > 0 ? { env } : {})
            });
            if (code === 0) return capToolOutput({ text: stdout.trim(), maxLength: LIMITS.agent_script_output_chars });
            throw new Error(`Script tool '${name}' failed: ${capToolOutput({ text: stderr.trim() || stdout.trim(), maxLength: LIMITS.agent_script_output_chars })}`);
        }
    };
}
