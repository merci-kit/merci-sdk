// @ts-check


/**
 * @file Strict `WORKFLOW.md` discovery: one read, a fenced front-matter parse,
 * and the one-shot load the policy starts from.
 * @version 0.12.0
 *
 * @description
 * Front matter is YAML, but the reader is not lenient: a missing close fence,
 * a YAML error, an unknown tag, or a non-mapping block fails the load instead
 * of degrading to text. `yaml.parse` is never used because it prints the
 * offending source line (and a line can hold a secret) to stderr;
 * `parseDocument` keeps every diagnostic in memory.
 */
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { PolicyError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { parseYamlMapping } from '../../support/yaml-mapping.mjs';
import { resolveWorkflowConfig } from './config.mjs';

/** The opening fence is recognized only at byte 0, after one optional BOM. */
const OPENING_FENCE = /^---\r?\n/;

/** A closing fence is a whole line: `---`, with at most a trailing `\r`. */
const CLOSING_FENCE = /^---\r?$/m;

/**
 * @param {{reason: string, message: string, path?: string|null, line?: number|null, column?: number|null}} arg0
 * @returns {PolicyError}
 */
function policyError({ reason, message, path = null, line = null, column = null }) {
    return new PolicyError({ message, options: { reason, path, line, column } });
}

/**
 * @param {{err: unknown}} arg0
 * @returns {boolean}
 */
function isMissingError({ err }) {
    return typeof err === 'object' && err !== null && /** @type {{code?: unknown}} */ (err).code === 'ENOENT';
}

/**
 * Parses the fenced block. The error never carries the parser message or the
 * YAML text: a YAML error quotes the offending line.
 * @param {{rawYaml: string, path: string|null}} arg0
 * @returns {Record<string, unknown>}
 */
function parseFrontMatter({ rawYaml, path }) {
    const parsed = parseYamlMapping({ text: rawYaml, path });
    if (parsed.ok) return parsed.value;
    if (parsed.reason === 'yaml_not_a_map') {
        throw policyError({
            reason: 'workflow_front_matter_not_a_map',
            message: 'Workflow front matter must be a YAML mapping',
            path
        });
    }
    if (parsed.reason === 'yaml_unsupported_tag') {
        throw policyError({
            reason: 'workflow_parse_error',
            message: 'Workflow front matter uses an unsupported YAML tag',
            path,
            line: parsed.line,
            column: parsed.column
        });
    }
    throw policyError({
        reason: 'workflow_parse_error',
        message: 'Workflow front matter is not valid YAML',
        path,
        line: parsed.line,
        column: parsed.column
    });
}

/**
 * Parses a `WORKFLOW.md` string. The returned config is inert, unfrozen data:
 * feed it to `resolveWorkflowConfig` and never merge it with `Object.assign`.
 * @param {{markdown: string, path?: string|null}} arg0
 * @returns {{config: Record<string, unknown>, promptTemplate: string}}
 */
export function parseWorkflowMarkdown({ markdown, path = null }) {
    const raw = typeof markdown === 'string' ? markdown : '';
    const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;

    const opening = OPENING_FENCE.exec(text);
    if (!opening) {
        return { config: {}, promptTemplate: text.trim() };
    }

    const afterOpening = text.slice(opening[0].length);
    const closing = CLOSING_FENCE.exec(afterOpening);
    if (!closing) {
        throw policyError({
            reason: 'workflow_parse_error',
            message: 'Workflow front matter has no closing --- line',
            path,
            line: 1,
            column: 1
        });
    }
    const rawYaml = afterOpening.slice(0, closing.index);
    const promptTemplate = afterOpening.slice(closing.index + closing[0].length).trim();
    const config = parseFrontMatter({ rawYaml, path });
    return { config, promptTemplate };
}

/**
 * Reads the file behind `path`. Internal: the policy owns caching and reload.
 * A missing file is `missing_workflow_file`; any other stat/read failure is
 * `workflow_read_error`; both a stat and a post-read byte check enforce the cap.
 * @param {{path?: string, maxFileBytes?: number}} [arg0]
 * @returns {Promise<{text: string, stat: {ino: number, mtimeMs: number, size: number}}>}
 */
export async function readWorkflowFile({
    path = join(process.cwd(), 'WORKFLOW.md'),
    maxFileBytes = LIMITS.workflow_max_file_bytes
} = {}) {
    const resolvedPath = resolve(path);
    /** @type {import('node:fs').Stats} */
    let stats;
    try {
        stats = await fs.stat(resolvedPath);
    } catch (err) {
        if (isMissingError({ err })) {
            throw policyError({
                reason: 'missing_workflow_file',
                message: 'Workflow file not found',
                path: resolvedPath
            });
        }
        throw policyError({
            reason: 'workflow_read_error',
            message: 'Workflow file could not be read',
            path: resolvedPath
        });
    }
    if (!stats.isFile()) {
        throw policyError({
            reason: 'workflow_read_error',
            message: 'Workflow path is not a regular file',
            path: resolvedPath
        });
    }
    if (stats.size > maxFileBytes) {
        throw policyError({
            reason: 'workflow_too_large',
            message: 'Workflow file is too large',
            path: resolvedPath
        });
    }
    /** @type {string} */
    let text;
    try {
        text = await fs.readFile(resolvedPath, 'utf8');
    } catch {
        throw policyError({
            reason: 'workflow_read_error',
            message: 'Workflow file could not be read',
            path: resolvedPath
        });
    }
    // The file may have grown between the stat and the read.
    if (Buffer.byteLength(text) > maxFileBytes) {
        throw policyError({
            reason: 'workflow_too_large',
            message: 'Workflow file is too large',
            path: resolvedPath
        });
    }
    return { text, stat: { ino: stats.ino, mtimeMs: stats.mtimeMs, size: stats.size } };
}

/**
 * Resolves one parsed file body into the effective config and prompt, plus the
 * warnings a caller reports as-is. The caller freezes the array and adds any
 * state of its own (the policy's sticky `watch_failed`).
 * @param {{markdown: string, path: string, env: Record<string, string|undefined>}} arg0
 * @returns {{
 *   baseDir: string,
 *   config: import('./config.mjs').ResolvedWorkflowConfig,
 *   promptTemplate: string,
 *   warnings: string[]
 * }}
 */
export function buildEffective({ markdown, path, env }) {
    const baseDir = dirname(path);
    const { config: rawConfig, promptTemplate } = parseWorkflowMarkdown({ markdown, path });
    const { config, warnings } = resolveWorkflowConfig({ config: rawConfig, baseDir, env });
    // An empty body still yields the fallback prompt; the host is told so.
    return {
        baseDir,
        config,
        promptTemplate,
        warnings: promptTemplate === '' ? [...warnings, 'empty_prompt'] : [...warnings]
    };
}

/**
 * Reads, parses, and resolves one workflow file. It does not parse the prompt
 * template; `WorkflowPolicy` does that once and keeps the AST.
 * @param {{path?: string, env?: Record<string, string|undefined>, maxFileBytes?: number, now?: () => number}} [arg0]
 * @returns {Promise<{
 *   path: string,
 *   baseDir: string,
 *   config: import('./config.mjs').ResolvedWorkflowConfig,
 *   promptTemplate: string,
 *   warnings: readonly string[],
 *   loadedAt: number
 * }>}
 */
export async function loadWorkflowFile({
    path = join(process.cwd(), 'WORKFLOW.md'),
    env = process.env,
    maxFileBytes = LIMITS.workflow_max_file_bytes,
    now = Date.now
} = {}) {
    const resolvedPath = resolve(path);
    const { text } = await readWorkflowFile({ path: resolvedPath, maxFileBytes });
    const { baseDir, config, promptTemplate, warnings } = buildEffective({
        markdown: text,
        path: resolvedPath,
        env
    });
    return Object.freeze({
        path: resolvedPath,
        baseDir,
        config,
        promptTemplate,
        warnings: Object.freeze(warnings),
        loadedAt: now()
    });
}
