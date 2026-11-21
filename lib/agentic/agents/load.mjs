// @ts-check


/**
 * @file Read and load `*.agent.yaml` files: one file, or one flat directory.
 * @version 0.12.0
 *
 * @description
 * The reader owns the bytes, the caps and the aggregation; `normalizeAgentSpec`
 * owns the schema. A file is refused before it is parsed when it is a symlink,
 * not a regular file, or above `agent_file_max_bytes`, and the bytes are hashed
 * once and handed to the spec as `source.hash`.
 *
 * The directory loader is intentionally flat and host-named: no walk-up, no
 * home directory, no watcher. Every per-file failure is collected and thrown as
 * one `AgentFileError`, so a directory with two broken files reports both.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { AgentFileError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { parseYamlMapping } from '../../support/yaml-mapping.mjs';
import { normalizeAgentSpec } from './spec.mjs';


/** The suffix a loadable definition must carry. */
const AGENT_FILE_SUFFIX = '.agent.yaml';


/**
 * @param {{reason: string, message: string, path?: string|null, line?: number|null, column?: number|null}} arg0
 * @returns {AgentFileError}
 */
function agentError({ reason, message, path = null, line = null, column = null }) {
    return new AgentFileError({ message, options: { reason, path, line, column } });
}


/**
 * Reads, caps and parses one file. Returns the inert value plus its positions
 * and byte hash; the caller normalizes or aggregates.
 * @param {{path: string}} arg0
 * @returns {Promise<{resolvedPath: string, value: Record<string, unknown>, positions: Map<string, {line: number, column: number}>, hash: string}>}
 */
async function readAgentSource({ path }) {
    const resolvedPath = resolve(path);
    const maxBytes = LIMITS.agent_file_max_bytes;

    /** @type {import('node:fs').Stats} */
    let entry;
    try {
        entry = await fs.lstat(resolvedPath);
    } catch {
        throw agentError({ reason: 'agent_read_error', message: 'Agent definition file could not be read.', path: resolvedPath });
    }
    if (entry.isSymbolicLink()) {
        throw agentError({ reason: 'agent_symlink', message: 'Agent definition file is a symlink.', path: resolvedPath });
    }
    if (!entry.isFile()) {
        throw agentError({ reason: 'agent_read_error', message: 'Agent definition path is not a regular file.', path: resolvedPath });
    }
    if (entry.size > maxBytes) {
        throw agentError({ reason: 'agent_too_large', message: 'Agent definition file is too large.', path: resolvedPath });
    }

    /** @type {Buffer} */
    let bytes;
    try {
        bytes = await fs.readFile(resolvedPath);
    } catch {
        throw agentError({ reason: 'agent_read_error', message: 'Agent definition file could not be read.', path: resolvedPath });
    }
    // The file may have grown between the stat and the read.
    if (bytes.length > maxBytes) {
        throw agentError({ reason: 'agent_too_large', message: 'Agent definition file is too large.', path: resolvedPath });
    }

    const parsed = parseYamlMapping({
        text: bytes.toString('utf8'),
        path: resolvedPath,
        maxAlias: LIMITS.agent_file_alias_max
    });
    if (!parsed.ok) {
        const reason = parsed.reason === 'yaml_not_a_map' ? 'agent_not_a_map' : 'agent_parse_error';
        throw agentError({
            reason,
            message: reason === 'agent_not_a_map'
                ? 'Agent definition must be a YAML mapping.'
                : 'Agent definition is not valid YAML.',
            path: resolvedPath,
            line: parsed.line,
            column: parsed.column
        });
    }

    return {
        resolvedPath,
        value: parsed.value,
        positions: parsed.positions,
        hash: createHash('sha256').update(bytes).digest('hex')
    };
}


/**
 * Loads one `*.agent.yaml` file into a deep-frozen spec. `root` defaults to the
 * file's directory, so a script may live beside the definition but not above it.
 * @param {{path?: string, allowDangerous?: boolean, root?: string|null}} [arg0]
 * @returns {Promise<import('./spec.mjs').AgentSpec>}
 */
export async function loadAgentFile({ path, allowDangerous = false, root = null } = {}) {
    if (typeof path !== 'string' || !path) {
        throw agentError({ reason: 'agent_read_error', message: 'loadAgentFile requires a path.' });
    }
    const source = await readAgentSource({ path });
    const baseDir = dirname(source.resolvedPath);
    return normalizeAgentSpec({
        value: source.value,
        path: source.resolvedPath,
        positions: source.positions,
        baseDir,
        root: typeof root === 'string' && root ? root : baseDir,
        allowDangerous,
        hash: source.hash
    });
}


/**
 * Loads every regular `*.agent.yaml` in one directory. Symlinked entries are
 * refused, names may not repeat, and all failures are thrown together.
 * @param {{directory?: string, allowDangerous?: boolean}} [arg0]
 * @returns {Promise<import('./spec.mjs').AgentSpec[]>}
 */
export async function loadAgentDirectory({ directory, allowDangerous = false } = {}) {
    if (typeof directory !== 'string' || !directory) {
        throw agentError({ reason: 'agent_read_error', message: 'loadAgentDirectory requires a directory.' });
    }
    const root = resolve(directory);

    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        throw agentError({ reason: 'agent_read_error', message: 'Agent definition directory could not be read.', path: root });
    }

    const files = entries
        .filter((entry) => entry.name.endsWith(AGENT_FILE_SUFFIX))
        .sort((left, right) => left.name.localeCompare(right.name));
    if (files.length > LIMITS.agent_file_max_count) {
        throw agentError({ reason: 'agent_too_large', message: 'Agent definition directory holds too many files.', path: root });
    }

    /** @type {import('./spec.mjs').AgentSpec[]} */
    const specs = [];
    /** @type {Array<{relative: string, error: AgentFileError}>} */
    const failures = [];
    /** @type {Map<string, string>} */
    const declaredNames = new Map();

    for (const entry of files) {
        const absolute = join(root, entry.name);
        if (entry.isSymbolicLink()) {
            failures.push({
                relative: entry.name,
                error: agentError({ reason: 'agent_symlink', message: 'Agent definition file is a symlink.', path: absolute })
            });
            continue;
        }
        if (!entry.isFile()) {
            failures.push({
                relative: entry.name,
                error: agentError({ reason: 'agent_read_error', message: 'Agent definition path is not a regular file.', path: absolute })
            });
            continue;
        }
        try {
            const source = await readAgentSource({ path: absolute });
            const metadata = source.value.metadata;
            const declared = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
                && typeof (/** @type {Record<string, unknown>} */ (metadata).name) === 'string'
                ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (metadata).name)
                : null;
            if (declared !== null) {
                const previous = declaredNames.get(declared);
                if (previous !== undefined) {
                    failures.push({
                        relative: entry.name,
                        error: agentError({
                            reason: 'agent_duplicate_name',
                            message: `Agent definition name duplicates ${previous}.`,
                            path: absolute
                        })
                    });
                } else declaredNames.set(declared, entry.name);
            }
            specs.push(await normalizeAgentSpec({
                value: source.value,
                path: source.resolvedPath,
                positions: source.positions,
                baseDir: root,
                root,
                allowDangerous,
                hash: source.hash
            }));
        } catch (error) {
            failures.push({
                relative: entry.name,
                error: error instanceof AgentFileError
                    ? error
                    : agentError({ reason: 'agent_read_error', message: 'Agent definition failed to load.', path: absolute })
            });
        }
    }

    if (failures.length > 0) {
        /** @type {string[]} */
        const reasons = [];
        let field = null;
        let line = null;
        let column = null;
        for (const { relative, error } of failures) {
            const fileReasons = error.reasons.length > 0 ? error.reasons : [error.reason ?? 'agent_read_error'];
            reasons.push(...fileReasons);
            if (field === null) {
                field = error.field === null ? relative : `${relative}:${error.field}`;
                line = error.line;
                column = error.column;
            }
        }
        const fileCount = new Set(failures.map((failure) => failure.relative)).size;
        /** @type {Array<{reason: string, field: string|null, line: number|null, column: number|null}>} */
        const issues = [];
        for (const { relative, error } of failures) {
            const fileIssues = error.issues.length > 0
                ? error.issues
                : [{ reason: String(error.reason ?? 'agent_read_error'), field: error.field, line: error.line, column: error.column }];
            for (const issue of fileIssues) {
                issues.push({
                    reason: issue.reason,
                    field: issue.field === null ? relative : `${relative}:${issue.field}`,
                    line: issue.line,
                    column: issue.column
                });
            }
        }
        throw new AgentFileError({
            message: `Agent definition directory has ${fileCount} invalid file${fileCount === 1 ? '' : 's'}.`,
            options: { reason: reasons[0], reasons, field, path: root, line, column, issues }
        });
    }

    return /** @type {import('./spec.mjs').AgentSpec[]} */ (Object.freeze(specs));
}
