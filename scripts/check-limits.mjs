#!/usr/bin/env node
// @ts-check

/**
 * @file The hardcoded-limit gate.
 * @version 0.12.0
 *
 * @description
 * Fails when a numeric limit is declared outside the registry, or when code
 * reads a `LIMITS.<key>` that does not exist. The registry
 * (`lib/core/constants/limits/**`) is the only place a default may live.
 *
 * Detection is structural, not textual:
 *   L1  an all-caps declaration whose name reads like a limit, initialised with
 *       a numeric expression (`MAX_BYTES = 50 * 1024`).
 *   L2  a numeric literal in a bounding call position: a timer delay >= 1000,
 *       or a known cap property (`maxBuffer`, `timeoutMs`, `maxItems`,
 *       `maxChars`, `maxLength`, `maxResults`, `pageSize`, `limit`, `maxDepth`,
 *       `maxRetries`, `pollIntervalMs`).
 *   L3  a `LIMITS.<key>` read whose key is absent from the registry.
 *   L4  a limit-shaped default parameter with a numeric value >= 100.
 *   L5  a numeric literal >= 50 compared against `.length` / `.size`
 *       (`rows.length > 800`).
 *   L6  a numeric cap passed to a bounding call: the end argument of
 *       `slice`/`substring` (>= 50), an argument of `Math.min`/`Math.max`
 *       (>= 50), or the deadline of `AbortSignal.timeout` (`text.slice(0, 90)`).
 *   L7  a `LIMIT_REGISTRY.<key>.default` or `LIMIT_DEFAULTS.<key>` read used
 *       as a value instead of reading `LIMITS.<key>` where it is used, a
 *       `const { … } = LIMIT_DEFAULTS` at any scope, or a bare-map read of
 *       `LIMIT_DEFAULTS` (`{ ...LIMIT_DEFAULTS }`, `Object.values`,
 *       `Object.entries`, `Object.assign(x, …)`, `Reflect.get`,
 *       `JSON.stringify`, `structuredClone`). Both doors reach the same frozen
 *       default at any scope; the registry is the only place it may live. L7 is
 *       always fatal: it bypasses the budget, and `--update` refuses while one
 *       exists. The only sanctions are `LIMIT_DEFAULT_ALLOWLIST` entries whose
 *       top-level `export const <name>` initialiser is that very read.
 *   L8  a `LIMITS` read a module runs at import: a declaration initialiser
 *       (`const X = LIMITS.<key>`, `LIMITS['<key>']`, `const { <key> } =
 *       LIMITS`, nested in an object, array or logical expression),
 *       `export default <read>`, a module-scope block or `if`/loop/`switch`/
 *       `try` body, a `static` field or `static {}` block, or a bare-map copy
 *       (`{ ...LIMITS }`, `Object.values(LIMITS)`, `Object.entries(LIMITS)`,
 *       `Object.assign(x, LIMITS)`, `Reflect.get(LIMITS, k)`,
 *       `JSON.stringify(LIMITS)`, `structuredClone(LIMITS)`). `LIMITS` is a
 *       lazy getter object, so a module-scope read still freezes the value at
 *       import and ignores an override. A block at module scope runs at
 *       import, so its reads freeze too; only function and arrow bodies,
 *       methods, getters/setters and instance fields defer to a later call.
 *       L8 is always fatal like L7, and has no allowlist: read `LIMITS.<key>`
 *       inside the function that uses it.
 *
 * Known offenders are recorded per file in `scripts/limits-budget.json`. A name
 * that is already baselined may repeat in its file; a new name, or a baselined
 * name in a file that does not list it, fails the gate. `--update` rewrites
 * the baseline after a reviewed reduction and only ever removes entries.
 *
 * Run: `node scripts/check-limits.mjs [--json] [--update]`
 * Exit 1 when a limit is unregistered, a `LIMITS` key is unknown, a registry
 * default is frozen into a value (L7), a module-scope `LIMITS` read freezes a
 * limit at import (L8), or a file exceeds its baseline.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

import { LIMIT_REGISTRY } from '../lib/core/constants/limits.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const LIB = join(ROOT, 'lib');
const BUDGET_FILE = join(HERE, 'limits-budget.json');
/** The registry itself is where defaults belong. */
const REGISTRY_PREFIX = 'lib/core/constants/limits/';
const REGISTRY_BARREL = 'lib/core/constants/limits.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const update = argv.includes('--update');

/** @param {string} p */
const toPosix = (p) => p.split(sep).join('/');
/** @param {string} file */
const relLib = (file) => toPosix(relative(ROOT, file));

const LIMIT_NAME_RE = /(MAX|MIN|LIMIT|TIMEOUT|RETRY|DELAY|TTL|CAP|BUDGET|THRESHOLD|CHARS|BYTES|ROWS|ENTRIES|DEPTH|ATTEMPTS|INTERVAL|WINDOW|RETENTION|CONCURRENCY|BACKOFF|GRACE|JITTER|POLL|SIZE|LENGTH|COUNT|RATE)/;
const LIMIT_WORD_RE = /(max|min|limit|timeout|retry|delay|ttl|cap|budget|threshold|chars|bytes|rows|entries|depth|attempts|interval|window|retention|concurrency|backoff|pagesize|batch|poll|chars|length)/i;
const UPPER_RE = /^[A-Z][A-Z0-9_]*$/;
const CAP_PROPS = new Set([
    'maxBuffer', 'timeoutMs', 'maxItems', 'maxChars', 'maxLength', 'maxResults',
    'pageSize', 'limit', 'maxDepth', 'maxRetries', 'pollIntervalMs', 'maxOutputLength',
    'maxBodyBytes', 'timeout', 'retries', 'maxTopics', 'maxTokens', 'batchSize',
    'flushIntervalMs', 'ringLimit', 'statusMaxRows', 'maxConcurrent',
    'maxPositionals', 'maxListeners'
]);
const TIMER_CALLS = new Set(['setTimeout', 'setInterval']);
const LISTENER_CALLS = new Set(['setMaxListeners']);

/**
 * Top-level constants that legitimately freeze a registry default: each one
 * documents the code default of that limit, and nothing else may read it.
 * A hit is sanctioned only when the file, the key and the pure top-level
 * `export const <name> = LIMIT_REGISTRY.<key>.default` (or
 * `LIMIT_DEFAULTS.<key>`) initialiser all agree.
 * @type {ReadonlyArray<Readonly<{file: string, key: string, name: string}>>}
 */
export const LIMIT_DEFAULT_ALLOWLIST = Object.freeze([
    Object.freeze({ file: 'lib/tools/external-capability.mjs', key: 'tool_output_max_chars', name: 'DEFAULT_TOOL_OUTPUT_MAX_LENGTH' }),
    Object.freeze({ file: 'lib/tools/mcp-task-store.mjs', key: 'mcp_task_page_size', name: 'MCP_TASK_PAGE_SIZE' }),
    Object.freeze({ file: 'lib/tools/mcp-client.mjs', key: 'mcp_output_max_chars', name: 'MCP_MAX_OUTPUT_LENGTH' }),
    Object.freeze({ file: 'lib/core/constants/multi-protocol.mjs', key: 'mcp_default_timeout_ms', name: 'MCP_DEFAULT_TIMEOUT_MS' }),
    Object.freeze({ file: 'lib/core/constants/multi-protocol.mjs', key: 'mcp_probe_timeout_ms', name: 'MCP_PROBE_TIMEOUT_MS' }),
    Object.freeze({ file: 'lib/core/constants/multi-protocol.mjs', key: 'a2a_request_max_body_bytes', name: 'A2A_REQUEST_MAX_BODY_BYTES' }),
    Object.freeze({ file: 'lib/core/constants/memory.mjs', key: 'memory_max_history_rows', name: 'MEMORY_MAX_HISTORY_ROWS' }),
    Object.freeze({ file: 'lib/agentic/browser/engines.mjs', key: 'browser_max_urls', name: 'MAX_BROWSER_URLS' })
]);

/**
 * @param {{dir: string, out?: string[]}} arg0
 * @returns {string[]}
 */
function walkFiles({ dir, out = [] }) {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) walkFiles({ dir: abs, out });
        else if (name.endsWith('.mjs')) out.push(abs);
    }
    return out;
}

/**
 * Evaluates a statically-known numeric expression.
 * @param {any} node
 * @returns {number|null}
 */
function numericValue(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
    if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'Literal' && typeof node.argument.value === 'number') {
        return -node.argument.value;
    }
    if (node.type === 'BinaryExpression' && ['*', '+', '-', '/'].includes(node.operator)) {
        const left = numericValue(node.left);
        const right = numericValue(node.right);
        if (left === null || right === null) return null;
        if (node.operator === '*') return left * right;
        if (node.operator === '+') return left + right;
        if (node.operator === '-') return left - right;
        return right === 0 ? null : left / right;
    }
    if (node.type === 'MemberExpression'
        && node.object?.type === 'Identifier' && node.object.name === 'Number'
        && node.property?.type === 'Identifier' && node.property.name === 'MAX_SAFE_INTEGER') {
        return Number.MAX_SAFE_INTEGER;
    }
    return null;
}

/**
 * @param {{node: any, cb: (node: any) => void, skip?: (node: any) => boolean}} arg0
 */
function eachNode({ node, cb, skip }) {
    if (!node || typeof node !== 'object') return;
    if (skip?.(node)) return;
    cb(node);
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
        const child = node[key];
        if (Array.isArray(child)) {
            for (const item of child) eachNode({ node: item, cb, skip });
        } else if (child && typeof child === 'object') {
            eachNode({ node: child, cb, skip });
        }
    }
}

/**
 * Collects every offence in one parsed module.
 * @param {{ast: any, rel: string, source?: string}} arg0
 * @returns {Array<{rule: string, name: string, line: number}>}
 */
export function inspectModule({ ast, rel, source = '' }) {
    /** @type {Array<{rule: string, name: string, line: number}>} */
    const hits = [];
    /** @type {(node: any) => string} */
    const textOf = (node) => {
        const text = source.slice(node.start, node.end).replace(/\s+/g, ' ');
        return text.length > 60 ? `${text.slice(0, 60).replace(/\s+\S*$/, '')}…` : text;
    };
    /**
     * Recognises `LIMIT_REGISTRY.<key>.default` and its computed forms.
     * @param {any} node
     * @returns {{key: string|null, label: string}|null} the key when static, and the source label
     */
    const frozenDefaultRead = (node) => {
        if (node?.type !== 'MemberExpression' || node.computed) return null;
        if (node.property?.type !== 'Identifier' || node.property.name !== 'default') return null;
        const reader = node.object;
        if (reader?.type !== 'MemberExpression') return null;
        if (reader.object?.type !== 'Identifier' || reader.object.name !== 'LIMIT_REGISTRY') return null;
        if (!reader.computed && reader.property?.type === 'Identifier') {
            return { key: reader.property.name, label: `LIMIT_REGISTRY.${reader.property.name}.default` };
        }
        if (reader.computed && reader.property?.type === 'Literal' && typeof reader.property.value === 'string') {
            return { key: reader.property.value, label: `LIMIT_REGISTRY['${reader.property.value}'].default` };
        }
        return { key: null, label: `LIMIT_REGISTRY[${textOf(reader.property)}].default` };
    };
    /**
     * Recognises `LIMIT_DEFAULTS.<key>` / `LIMIT_DEFAULTS[<expr>]`, the second
     * door to the same frozen default.
     * @param {any} node
     * @returns {{key: string|null, label: string}|null}
     */
    const frozenDefaultsMapRead = (node) => {
        if (node?.type !== 'MemberExpression') return null;
        if (node.object?.type !== 'Identifier' || node.object.name !== 'LIMIT_DEFAULTS') return null;
        if (!node.computed && node.property?.type === 'Identifier') {
            return { key: node.property.name, label: `LIMIT_DEFAULTS.${node.property.name}` };
        }
        if (node.computed && node.property?.type === 'Literal' && typeof node.property.value === 'string') {
            return { key: node.property.value, label: `LIMIT_DEFAULTS['${node.property.value}']` };
        }
        return { key: null, label: `LIMIT_DEFAULTS[${textOf(node.property)}]` };
    };
    /**
     * Any read that freezes a registry default, through either door.
     * @param {any} node
     * @returns {{key: string|null, label: string}|null}
     */
    const frozenDefault = (node) => frozenDefaultRead(node) ?? frozenDefaultsMapRead(node);
    const inRegistry = rel === REGISTRY_BARREL || rel.startsWith(REGISTRY_PREFIX);
    /** @type {Set<any>} Initialisers a `LIMIT_DEFAULT_ALLOWLIST` entry sanctions by identity. */
    const sanctionedDefaults = new Set();
    for (const statement of ast.body ?? []) {
        if (statement?.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') continue;
        if (statement.declaration.kind !== 'const') continue;
        for (const declarator of statement.declaration.declarations) {
            const name = declarator.id?.type === 'Identifier' ? declarator.id.name : '';
            const entry = LIMIT_DEFAULT_ALLOWLIST.find((item) => item.file === rel && item.name === name);
            if (!entry) continue;
            const read = frozenDefault(declarator.init);
            if (read?.key === entry.key) sanctionedDefaults.add(declarator.init);
        }
    }
    const noAllowlist = 'there is no allowlist, so restructure the module';
    /** @type {(node: any) => boolean} */
    const isFunctionNode = (node) => node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
        || node.type === 'ArrowFunctionExpression';
    /** @type {(node: any) => boolean} */
    const isBareLimitsMap = (node) => node?.type === 'Identifier' && (node.name === 'LIMITS' || node.name === 'LIMIT_DEFAULTS');
    /**
     * The shapes that read every value of the bare map at once, and nothing
     * broader (`Object.keys` reads no values). Both dicts have the same shape,
     * so the caller picks L7 for `LIMIT_DEFAULTS` and L8 for `LIMITS`.
     * @param {any} node
     * @returns {{name: string, label: string}|null}
     */
    const bareMapRead = (node) => {
        if (node.type === 'SpreadElement' && isBareLimitsMap(node.argument)) return { name: node.argument.name, label: `...${node.argument.name}` };
        if (node.type !== 'CallExpression') return null;
        const callee = node.callee;
        const [arg0, arg1] = node.arguments ?? [];
        if (callee?.type === 'Identifier' && callee.name === 'structuredClone' && isBareLimitsMap(arg0)) {
            return { name: arg0.name, label: `structuredClone(${arg0.name})` };
        }
        if (callee?.type !== 'MemberExpression' || callee.computed || callee.property?.type !== 'Identifier') return null;
        const owner = callee.object?.type === 'Identifier' ? callee.object.name : '';
        const method = callee.property.name;
        if (owner === 'Object' && (method === 'values' || method === 'entries') && isBareLimitsMap(arg0)) {
            return { name: arg0.name, label: `Object.${method}(${arg0.name})` };
        }
        if (owner === 'Object' && method === 'assign' && isBareLimitsMap(arg1)) return { name: arg1.name, label: `Object.assign(…, ${arg1.name})` };
        if (owner === 'Reflect' && method === 'get' && isBareLimitsMap(arg0)) return { name: arg0.name, label: `Reflect.get(${arg0.name}, …)` };
        if (owner === 'JSON' && method === 'stringify' && isBareLimitsMap(arg0)) return { name: arg0.name, label: `JSON.stringify(${arg0.name})` };
        return null;
    };
    /**
     * A module-scope read freezes the value at import, override included. A
     * block, `if`/loop/`switch` body, `try` block, `static` field and
     * `static {}` block all run at import; only function and arrow bodies,
     * methods, getters/setters and instance fields defer to a later call.
     * shortcut: an IIFE body, a class `extends` clause and an instance field's
     * computed key are pruned with their containers, so a freeze there is
     * missed; upgrade if one turns up in the wild.
     * @param {{node: any, cb: (node: any) => void}} arg0
     */
    const walkImportTime = ({ node, cb }) => {
        eachNode({ node, cb, skip: (current) => {
            if (isFunctionNode(current)) return true;
            if (current.type === 'MethodDefinition') return true;
            if (current.type === 'PropertyDefinition' && current.static !== true) return true;
            if (current.type === 'ClassDeclaration' || current.type === 'ClassExpression') {
                for (const member of current.body?.body ?? []) {
                    if (member.type === 'StaticBlock' || (member.type === 'PropertyDefinition' && member.static === true)) walkImportTime({ node: member, cb });
                }
                return true;
            }
            return false;
        } });
    };
    for (const statement of ast.body ?? []) {
        walkImportTime({ node: statement, cb: (node) => {
            const line = node.loc?.start?.line ?? 0;
            if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && node.init?.type === 'Identifier') {
                if (node.init.name === 'LIMITS') {
                    hits.push({ rule: 'L8', name: `const { … } = LIMITS freezes every limit at import. Read LIMITS.<key> inside the function that uses it; ${noAllowlist}.`, line });
                }
                return;
            }
            if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && node.object.name === 'LIMITS') {
                const staticKey = !node.computed && node.property?.type === 'Identifier' ? node.property.name
                    : node.computed && node.property?.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value
                        : null;
                const label = staticKey === null ? `LIMITS[${textOf(node.property)}]` : `LIMITS${node.computed ? `['${staticKey}']` : `.${staticKey}`}`;
                const remedy = staticKey === null ? 'LIMITS.<key>' : label;
                hits.push({ rule: 'L8', name: `a module-scope ${label} read freezes the limit at import. Read ${remedy} inside the function that uses it; ${noAllowlist}.`, line });
                return;
            }
            const bare = bareMapRead(node);
            if (bare?.name === 'LIMITS') {
                hits.push({ rule: 'L8', name: `a module-scope ${bare.label} read freezes every limit at import. Read LIMITS.<key> inside the function that uses it; ${noAllowlist}.`, line });
            }
        } });
    }
    const registryKeys = new Set(Object.keys(LIMIT_REGISTRY));
    eachNode({ node: ast, cb: (node) => {
        if (node.type === 'BinaryExpression' && ['>', '>=', '<', '<='].includes(node.operator)) {
            for (const [valueNode, memberNode] of [[node.left, node.right], [node.right, node.left]]) {
                const cap = numericValue(valueNode);
                if (cap === null || cap < 50 || memberNode?.type !== 'MemberExpression') continue;
                const prop = !memberNode.computed && memberNode.property?.type === 'Identifier'
                    ? memberNode.property.name
                    : memberNode.computed && memberNode.property?.type === 'Literal' ? String(memberNode.property.value) : '';
                if (prop !== 'length' && prop !== 'size') continue;
                hits.push({ rule: 'L5', name: `${textOf(memberNode)} ${node.operator} ${cap}`, line: node.loc?.start?.line ?? 0 });
            }
        }
        if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
            const name = node.id.name;
            if (LIMIT_WORD_RE.test(name) && (UPPER_RE.test(name) || /[a-z]/.test(name))) {
                const value = numericValue(node.init);
                if (value !== null && value >= 1 && value < Number.MAX_SAFE_INTEGER) {
                    hits.push({ rule: 'L1', name, line: node.loc?.start?.line ?? 0 });
                }
            }
        }
        if (node.type === 'CallExpression') {
            const calleeName = node.callee?.type === 'Identifier'
                ? node.callee.name
                : node.callee?.type === 'MemberExpression' && !node.callee.computed && node.callee.property?.type === 'Identifier'
                    ? node.callee.property.name
                    : '';
            if (TIMER_CALLS.has(calleeName)) {
                const delay = numericValue(node.arguments?.[1]);
                if (delay !== null && delay >= 1000) {
                    hits.push({ rule: 'L2', name: `${calleeName}(${delay})`, line: node.loc?.start?.line ?? 0 });
                }
            }
            if (LISTENER_CALLS.has(calleeName)) {
                const count = numericValue(node.arguments?.[0]);
                if (count !== null && count >= 1) {
                    hits.push({ rule: 'L2', name: `${calleeName}(${count})`, line: node.loc?.start?.line ?? 0 });
                }
            }
            if (calleeName === 'slice' || calleeName === 'substring') {
                const end = numericValue(node.arguments?.[1]);
                if (end !== null && end >= 50) {
                    const start = numericValue(node.arguments?.[0]);
                    hits.push({ rule: 'L6', name: `${textOf(node.callee)}(${start === null ? '…' : start}, ${end})`, line: node.loc?.start?.line ?? 0 });
                }
            }
            if (node.callee?.type === 'MemberExpression' && node.callee.object?.type === 'Identifier' && node.callee.object.name === 'Math' && (calleeName === 'min' || calleeName === 'max')) {
                for (const arg of node.arguments ?? []) {
                    const cap = numericValue(arg);
                    if (cap !== null && cap >= 50) hits.push({ rule: 'L6', name: `Math.${calleeName}(${cap})`, line: node.loc?.start?.line ?? 0 });
                }
            }
            if (node.callee?.type === 'MemberExpression' && node.callee.object?.type === 'Identifier' && node.callee.object.name === 'AbortSignal' && calleeName === 'timeout') {
                const ms = numericValue(node.arguments?.[0]);
                if (ms !== null && ms >= 1) hits.push({ rule: 'L6', name: `AbortSignal.timeout(${ms})`, line: node.loc?.start?.line ?? 0 });
            }
        }
        if (node.type === 'Property') {
            const keyName = node.key?.type === 'Identifier'
                ? node.key.name
                : node.key?.type === 'Literal' && typeof node.key.value === 'string' ? node.key.value : '';
            if (CAP_PROPS.has(keyName)) {
                const value = numericValue(node.value);
                if (value !== null && value >= 1) {
                    hits.push({ rule: 'L2', name: `${keyName}: ${value}`, line: node.loc?.start?.line ?? 0 });
                }
            }
        }
        if (node.type === 'AssignmentPattern' && node.left?.type === 'Identifier') {
            const name = node.left.name;
            const value = numericValue(node.right);
            if (value !== null && value >= 100 && value < Number.MAX_SAFE_INTEGER && LIMIT_WORD_RE.test(name)) {
                hits.push({ rule: 'L4', name: `${name} = ${value}`, line: node.loc?.start?.line ?? 0 });
            }
        }
        if (node.type === 'MemberExpression'
            && node.object?.type === 'Identifier' && node.object.name === 'LIMITS') {
            if (!node.computed && node.property?.type === 'Identifier') {
                const key = node.property.name;
                if (!registryKeys.has(key)) hits.push({ rule: 'L3', name: `LIMITS.${key}`, line: node.loc?.start?.line ?? 0 });
            } else if (node.computed && node.property?.type === 'Literal' && typeof node.property.value === 'string') {
                const key = node.property.value;
                if (!registryKeys.has(key)) hits.push({ rule: 'L3', name: `LIMITS['${key}']`, line: node.loc?.start?.line ?? 0 });
            }
        }
        if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern'
            && node.init?.type === 'Identifier' && node.init.name === 'LIMITS') {
            for (const prop of node.id.properties) {
                const key = prop?.type === 'Property' && prop.key?.type === 'Identifier' ? prop.key.name : '';
                if (key && !registryKeys.has(key)) hits.push({ rule: 'L3', name: `const { ${key} } = LIMITS`, line: node.loc?.start?.line ?? 0 });
            }
        }
        if (!inRegistry) {
            if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern'
                && node.init?.type === 'Identifier' && node.init.name === 'LIMIT_DEFAULTS') {
                hits.push({ rule: 'L7', name: `const { … } = LIMIT_DEFAULTS freezes the code default. Read LIMITS.<key> inside the function that uses it; ${noAllowlist}.`, line: node.loc?.start?.line ?? 0 });
            }
            const bare = bareMapRead(node);
            if (bare?.name === 'LIMIT_DEFAULTS') {
                hits.push({ rule: 'L7', name: `a ${bare.label} read freezes every code default. Read LIMITS.<key> inside the function that uses it; ${noAllowlist}.`, line: node.loc?.start?.line ?? 0 });
            }
            const frozen = frozenDefault(node);
            if (frozen && !sanctionedDefaults.has(node)) {
                const remedy = frozen.key === null
                    ? 'Read the value through LIMITS; a computed default read can never be allowlisted.'
                    : `Read LIMITS.${frozen.key} inside the function, or add the constant to LIMIT_DEFAULT_ALLOWLIST.`;
                hits.push({ rule: 'L7', name: `${frozen.label} freezes the code default. ${remedy}`, line: node.loc?.start?.line ?? 0 });
            }
        }
    } });
    return hits.map((hit) => ({ ...hit, name: `${rel}: ${hit.name}` }));
}

/**
 * @returns {{entries: Record<string, Array<string>>}}
 */
function readBudget() {
    if (!existsSync(BUDGET_FILE)) return { entries: {} };
    try {
        const raw = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
        /** @type {Record<string, Array<string>>} */
        const entries = {};
        for (const [file, names] of Object.entries(raw?.entries ?? {})) {
            if (Array.isArray(names)) entries[file] = names.map(String);
        }
        return { entries };
    } catch {
        return { entries: {} };
    }
}

function main() {
    const files = walkFiles({ dir: LIB }).filter((file) => {
        const rel = relLib(file);
        return !rel.startsWith(REGISTRY_PREFIX) && rel !== REGISTRY_BARREL;
    });

    /** @type {Record<string, Array<{rule: string, name: string, line: number}>>} */
    const byFile = {};
    /** @type {Array<{file: string, rule: string, name: string, line: number}>} */
    const fatalReads = [];
    for (const file of files) {
        const rel = relLib(file);
        const source = readFileSync(file, 'utf8');
        let ast;
        try {
            ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
        } catch (error) {
            console.error(`limits: cannot parse ${rel}: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
        const hits = inspectModule({ ast, rel, source });
        for (const hit of hits) if (hit.rule === 'L7' || hit.rule === 'L8') fatalReads.push({ file: rel, ...hit });
        const budgetHits = hits.filter((hit) => hit.rule !== 'L7' && hit.rule !== 'L8');
        if (budgetHits.length > 0) byFile[rel] = budgetHits;
    }

    /** @type {Record<string, Array<string>>} */
    const names = Object.fromEntries(Object.entries(byFile).map(([file, hits]) => [file, hits.map((hit) => hit.name)]));
    const previous = readBudget().entries;

    if (update) {
        if (fatalReads.length > 0) {
            console.error('limits: --update refuses to baseline a frozen limit read (L7/L8). Read LIMITS.<key> inside the function instead.');
            for (const fatal of fatalReads) console.error(`  [${fatal.rule}] ${fatal.file}:${fatal.line}  ${fatal.name.slice(fatal.file.length + 2)}`);
            process.exit(1);
        }
        /** @type {Array<{file: string, name: string}>} */
        const raises = [];
        for (const [file, list] of Object.entries(names)) {
            const known = new Set(previous[file] ?? []);
            for (const name of list) if (!known.has(name)) raises.push({ file, name });
        }
        if (raises.length > 0) {
            console.error('limits: --update refuses to RAISE the ratchet. A new unregistered limit must be registered, not baselined.');
            for (const raise of raises) console.error(`  ${raise.file}: ${raise.name}`);
            console.error('Register the limit in lib/core/constants/limits/.');
            process.exit(1);
        }
        // A name is a floor: identical shapes at two sites share one name, so
        // write each once, in code-point order, and `--update` stays idempotent.
        const ordered = Object.fromEntries(Object.keys(names).sort().map((file) => [file, [...new Set(names[file])].sort()]));
        const comment = 'Known unregistered numeric limits per file, keyed by a stable offence name. The gate fails on an offence not listed here; --update may only lower this list. Two hits with the same shape in one file share one name, so a name is a floor, not a count.';
        writeFileSync(BUDGET_FILE, `${JSON.stringify({ $comment: comment, entries: ordered }, null, 2)}\n`, 'utf8');
        console.error(`limits: baseline written with ${Object.values(ordered).reduce((sum, list) => sum + list.length, 0)} entries in ${Object.keys(ordered).length} files`);
        process.exit(0);
    }

    /** @type {Array<{file: string, rule: string, name: string, line: number, reason: string}>} */
    const findings = [];
    for (const [file, hits] of Object.entries(byFile)) {
        const known = new Set(previous[file] ?? []);
        for (const hit of hits) {
            if (known.has(hit.name)) continue;
            findings.push({ file, ...hit, reason: 'not in scripts/limits-budget.json' });
        }
    }
    for (const fatal of fatalReads) {
        findings.push({ ...fatal, reason: 'a frozen limit read is never budgeted' });
    }

    const unknownReads = findings.filter((finding) => finding.rule === 'L3');
    const frozenDefaults = findings.filter((finding) => finding.rule === 'L7');
    const frozenLimits = findings.filter((finding) => finding.rule === 'L8');
    const status = findings.length === 0 ? 0 : 1;

    if (asJson) {
        console.log(JSON.stringify({ ok: status === 0, findings, entries: names, baseline: previous }, null, 2));
        process.exit(status);
    }

    if (status === 0) {
        const knownTotal = Object.values(previous).reduce((sum, list) => sum + list.length, 0);
        console.log(`limits: ok — ${knownTotal} baselined entries, none new`);
        process.exit(0);
    }

    console.error(`limits: ${findings.length} unregistered numeric limit(s)`);
    if (unknownReads.length > 0) {
        console.error('  unknown LIMITS keys (typos will read undefined at runtime):');
        for (const finding of unknownReads) console.error(`    ${finding.file}:${finding.line}  ${finding.name}`);
    }
    if (frozenDefaults.length > 0) {
        console.error('  registry defaults frozen into a value (read the limit where it is used):');
        for (const finding of frozenDefaults) {
            console.error(`    [L7] ${finding.file}:${finding.line}  ${finding.name.slice(finding.file.length + 2)}`);
        }
    }
    if (frozenLimits.length > 0) {
        console.error('  module-scope LIMITS reads frozen at import (no allowlist; restructure the module):');
        for (const finding of frozenLimits) {
            console.error(`    [L8] ${finding.file}:${finding.line}  ${finding.name.slice(finding.file.length + 2)}`);
        }
    }
    for (const finding of findings) {
        if (finding.rule === 'L3' || finding.rule === 'L7' || finding.rule === 'L8') continue;
        console.error(`  ${finding.file}:${finding.line}  [${finding.rule}] ${finding.name}  (${finding.reason})`);
    }
    console.error('Register it in lib/core/constants/limits/, then read it as LIMITS.<key>. After a reviewed reduction run: node scripts/check-limits.mjs --update');
    process.exit(1);
}

/**
 * `argv[1]` may be a symlinked or vanished path; compare real paths without throwing.
 * @type {(p: string) => string}
 */
const canonical = (p) => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) main();
