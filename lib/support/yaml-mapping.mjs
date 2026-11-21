// @ts-check


/**
 * @file Safe YAML mapping parse shared by the workflow and agent loaders.
 * @version 0.12.0
 *
 * @description
 * One strict mapping reader, returned as a result instead of thrown: a caller
 * maps the reason to its own error type and wording. `yaml.parse` is never
 * used because it prints the offending source line (and a line can hold a
 * secret) to stderr; `parseDocument` with `logLevel: 'silent'` keeps every
 * diagnostic in memory. `maxAliasCount` bounds alias expansion both while
 * composing and on `toJS`. The value is inert, unfrozen data: never merge it
 * with `Object.assign`.
 *
 * `positions` answers "where was this key?" for a caller that must report a
 * line and column on a semantic error (an unknown key, a bad enum value). It is
 * a best-effort map: a node with no range is simply absent.
 */
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';

import { LIMITS } from '../core/limit-config.mjs';

/**
 * @typedef {'yaml_parse_error'|'yaml_unsupported_tag'|'yaml_not_a_map'} YamlMappingReason
 */

/**
 * @typedef {object} YamlPosition
 * @property {number} line - 1-based line of the key or index.
 * @property {number} column - 1-based column of the key or index.
 */

/**
 * @typedef {object} YamlMappingFailure
 * @property {false} ok
 * @property {YamlMappingReason} reason
 * @property {string|null} path
 * @property {number|null} line
 * @property {number|null} column
 */

/**
 * Records the position of one node when it carries a source range.
 * @param {{node: unknown, path: string, lineCounter: LineCounter, positions: Map<string, YamlPosition>}} arg0
 * @returns {void}
 */
function recordPosition({ node, path, lineCounter, positions }) {
    const range = /** @type {{range?: [number, number, number]}} */ (node)?.range;
    if (!range) return;
    const position = lineCounter.linePos(range[0]);
    positions.set(path, { line: position.line, column: position.col });
}

/**
 * Walks a parsed node, recording the dotted path of every mapping key and
 * sequence index. Only scalar keys become path segments: a complex key is not
 * addressable from a config error.
 * @param {{node: unknown, lineCounter: LineCounter, prefix: string, positions: Map<string, YamlPosition>}} arg0
 * @returns {void}
 */
function collectPositions({ node, lineCounter, prefix, positions }) {
    if (isMap(node)) {
        for (const pair of node.items) {
            const keyNode = pair.key;
            const key = isScalar(keyNode) ? String(keyNode.value) : '';
            const path = prefix ? `${prefix}.${key}` : key;
            recordPosition({ node: keyNode, path, lineCounter, positions });
            collectPositions({ node: pair.value, lineCounter, prefix: path, positions });
        }
        return;
    }
    if (isSeq(node)) {
        node.items.forEach((item, index) => {
            const path = prefix ? `${prefix}.${index}` : String(index);
            recordPosition({ node: item, path, lineCounter, positions });
            collectPositions({ node: item, lineCounter, prefix: path, positions });
        });
    }
}

/**
 * Parses one YAML text into a mapping. YAML null is `{}`; a sequence or scalar
 * is `yaml_not_a_map`; an unknown tag is `yaml_unsupported_tag`; malformed
 * YAML, a duplicate key, an alias bomb or a parser failure is
 * `yaml_parse_error`. The parser message is dropped: it quotes the source line.
 * @param {{text?: string, path?: string|null, maxAlias?: number}} [arg0]
 * @returns {{ok: true, value: Record<string, unknown>, positions: Map<string, YamlPosition>}|YamlMappingFailure}
 */
export function parseYamlMapping({ text, path = null, maxAlias = LIMITS.workflow_alias_max } = {}) {
    if (typeof text !== 'string') {
        return { ok: false, reason: 'yaml_parse_error', path, line: null, column: null };
    }
    /** Pinned option shape: `maxAliasCount` is inert while composing but is
     * part of the contract; `DocumentOptions` alone does not declare it. */
    const lineCounter = new LineCounter();
    const options = /** @type {{maxAliasCount: number, logLevel: 'silent', lineCounter: LineCounter}} */ ({
        maxAliasCount: maxAlias,
        logLevel: 'silent',
        lineCounter
    });
    /** @type {ReturnType<typeof parseDocument>} */
    let document;
    try {
        document = parseDocument(text, options);
    } catch {
        return { ok: false, reason: 'yaml_parse_error', path, line: null, column: null };
    }
    const firstError = document.errors[0];
    if (firstError) {
        const position = firstError.linePos?.[0];
        return {
            ok: false,
            reason: 'yaml_parse_error',
            path,
            line: position?.line ?? null,
            column: position?.col ?? null
        };
    }
    const tagWarning = document.warnings.find((warning) => warning.code === 'TAG_RESOLVE_FAILED');
    if (tagWarning) {
        const position = tagWarning.linePos?.[0];
        return {
            ok: false,
            reason: 'yaml_unsupported_tag',
            path,
            line: position?.line ?? null,
            column: position?.col ?? null
        };
    }

    /** @type {unknown} */
    let parsed;
    try {
        parsed = document.toJS({ maxAliasCount: maxAlias });
    } catch {
        return { ok: false, reason: 'yaml_parse_error', path, line: null, column: null };
    }
    if (parsed === null) return { ok: true, value: {}, positions: new Map() };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'yaml_not_a_map', path, line: null, column: null };
    }
    /** @type {Map<string, YamlPosition>} */
    const positions = new Map();
    collectPositions({ node: document.contents, lineCounter, prefix: '', positions });
    return { ok: true, value: /** @type {Record<string, unknown>} */ (parsed), positions };
}
