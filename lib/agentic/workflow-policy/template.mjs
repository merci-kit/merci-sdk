// @ts-check


/**
 * @file Strict `WORKFLOW.md` prompt template: parse once, render per item.
 * @version 0.12.0
 *
 * @description
 * A dependency-free subset of Liquid: outputs (`{{ issue.identifier }}`),
 * `if`/`elsif`/`else`, `raw`, and the four trim markers. Every other construct
 * is a parse error, because an authoring mistake must invalidate a reload
 * instead of silently rendering nothing. Resolution is own-property only, so
 * `__proto__`, `constructor`, and `prototype` cannot be reached (they are
 * rejected while parsing), and a path that is absent is an error while a path
 * present with `null` renders as `''`.
 *
 * The DAG's `interpolateTemplate` is deliberately not reused: it warns and
 * substitutes `[UNRESOLVED: …]` for a different dialect (`{{step.output}}`).
 * Two dialects are a smaller blast radius than making the DAG strict.
 *
 * Parse errors use `template_parse_error:<detail>` and carry 1-based
 * `line`/`column`; render errors use `template_render_error:<path>` and carry
 * `field`. No message or reason ever includes the template text or a value.
 */
import { PolicyError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { WORKFLOW_POLICY_DEFAULTS } from './config.mjs';

/**
 * @typedef {{type: 'text', value: string, offset: number}} TextNode
 * @typedef {{type: 'output', path: string, segments: string[], offset: number}} OutputNode
 * @typedef {{path: string, segments: string[], body: TemplateNode[]}} TemplateBranch
 * @typedef {{type: 'if', branches: TemplateBranch[], alternate: TemplateNode[]|null, offset: number}} IfNode
 * @typedef {{type: 'raw', value: string, offset: number}} RawNode
 * @typedef {TextNode|OutputNode|IfNode|RawNode} TemplateNode
 * @typedef {{type: 'root', nodes: TemplateNode[]}} TemplateAst
 */

/**
 * @typedef {{template: string, index: number, nextOutputAt?: number|null, nextTagAt?: number|null}} TemplateState
 * @typedef {{path: string, segments: string[]}} TemplateExpression
 * @typedef {{kind: 'output', path: string, segments: string[], leftTrim: boolean, offset: number}
 *   | {kind: 'if', path: string, segments: string[], leftTrim: boolean, offset: number}
 *   | {kind: 'elsif', path: string, segments: string[], leftTrim: boolean, offset: number}
 *   | {kind: 'else', leftTrim: boolean, offset: number}
 *   | {kind: 'endif', leftTrim: boolean, offset: number}
 *   | {kind: 'raw', leftTrim: boolean, offset: number}
 *   | {kind: 'endraw', leftTrim: boolean, offset: number}} TemplateToken
 * @typedef {{kind: 'elsif', path: string, segments: string[], leftTrim: boolean, offset: number}
 *   | {kind: 'else', leftTrim: boolean, offset: number}
 *   | {kind: 'endif', leftTrim: boolean, offset: number}
 *   | {kind: 'endraw', leftTrim: boolean, offset: number}} TemplateTerminator
 * @typedef {{nodes: TemplateNode[], terminator: TemplateTerminator|null}} ParsedBlock
 * @typedef {{chars: number, maxRenderedChars: number, parts: string[]}} RenderContext
 */

/** Segments that can never be read from an issue or an attempt. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** `path := ident ('.' ident)*`; one leading dash is a trim marker, not part of it. */
const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

/** A tag name is the first identifier in the tag body. */
const TAG_NAME_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*)/;

/** Liquid uses these for comparisons; this dialect has none. */
const COMPARISON_PATTERN = /[=<>]/;

/**
 * @param {{char: string}} arg0
 * @returns {boolean}
 */
function isWhitespace({ char }) {
    return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

/**
 * @param {{value: string}} arg0
 * @returns {string}
 */
function trimEnd({ value }) {
    let end = value.length;
    while (end > 0 && isWhitespace({ char: value[end - 1] })) end -= 1;
    return value.slice(0, end);
}

/**
 * @param {{template: string, offset: number}} arg0
 * @returns {{line: number, column: number}}
 */
function position({ template, offset }) {
    let line = 1;
    for (let index = 0; index < offset; index += 1) {
        if (template[index] === '\n') line += 1;
    }
    const lineStart = template.lastIndexOf('\n', offset - 1) + 1;
    return { line, column: offset - lineStart + 1 };
}

/**
 * @param {{detail: string, offset: number, template: string}} arg0
 * @returns {PolicyError}
 */
function parseError({ detail, offset, template }) {
    const { line, column } = position({ template, offset });
    return new PolicyError({
        message: 'Workflow prompt template is not valid',
        options: { reason: `template_parse_error:${detail}`, line, column }
    });
}

/**
 * @param {{detail: string, field?: string|null}} arg0
 * @returns {PolicyError}
 */
function renderError({ detail, field = null }) {
    return new PolicyError({
        message: 'Workflow prompt template could not be rendered',
        options: { reason: `template_render_error:${detail}`, field }
    });
}

/**
 * The typed error a failed render reports, and its stable base reason. A raw
 * throw from a hostile view or a host policy becomes the same `PolicyError` the
 * render paths throw, so a caller emits one shape and rethrows one type.
 * @param {{err: unknown}} arg0
 * @returns {{error: PolicyError, reason: string}}
 */
export function renderFailure({ err }) {
    const error = err instanceof PolicyError
        ? err
        : new PolicyError({
            message: 'Workflow prompt template could not be rendered',
            options: { reason: 'template_render_error' }
        });
    const reason = error.reason === null ? 'template_render_error' : error.reason.split(':')[0];
    return { error, reason };
}

/**
 * Validates a numeric cap. A `NaN`, a string, or a non-positive value must fail
 * closed: the cap guards a resource limit, so an unusable value cannot silently
 * disable it. `maxDepth` is also bounded so a host typo cannot turn a deep
 * template into a raw `RangeError` that bypasses the typed error path.
 * @param {{option: 'maxDepth'|'maxRenderedChars', value: unknown}} arg0
 * @returns {number}
 */
function readCap({ option, value }) {
    const beyondCeiling = option === 'maxDepth' && typeof value === 'number' && value > LIMITS.workflow_template_depth_ceiling;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || beyondCeiling) {
        throw new PolicyError({
            message: 'Workflow prompt template option is invalid',
            options: { reason: `invalid_option:${option}` }
        });
    }
    return value;
}

/**
 * Parses a path expression. A filter, a comparison, or a non-path token is a
 * parse error; a forbidden segment is rejected here so a bad template can never
 * parse and reach a per-item render.
 * @param {{expression: string, offset: number, template: string}} arg0
 * @returns {TemplateExpression}
 */
function parseExpression({ expression, offset, template }) {
    const path = expression;
    if (path === '') throw parseError({ detail: 'invalid_path', offset, template });
    if (path.includes('|')) throw parseError({ detail: 'unsupported_filter', offset, template });
    if (COMPARISON_PATTERN.test(path)) throw parseError({ detail: 'unsupported_comparison', offset, template });
    if (!PATH_PATTERN.test(path)) throw parseError({ detail: 'invalid_path', offset, template });
    const segments = path.split('.');
    for (const segment of segments) {
        if (FORBIDDEN_KEYS.has(segment)) {
            throw parseError({ detail: `forbidden_path:${segment}`, offset, template });
        }
    }
    return { path, segments };
}

/**
 * Reads one `{{ … }}` or `{% … %}` tag, advances the cursor past it (and past
 * any whitespace its right trim marker removes), and returns the token. A tag
 * this dialect does not know is an error, never text.
 * @param {{state: TemplateState, at: number}} arg0
 * @returns {TemplateToken}
 */
function readTag({ state, at }) {
    const template = state.template;
    const isOutput = template.startsWith('{{', at);
    const close = template.indexOf(isOutput ? '}}' : '%}', at + 2);
    if (close === -1) {
        throw parseError({ detail: isOutput ? 'unclosed_output' : 'unclosed_tag', offset: at, template });
    }
    let inner = template.slice(at + 2, close);
    let leftTrim = false;
    if (inner.startsWith('-')) {
        leftTrim = true;
        inner = inner.slice(1);
    }
    let rightTrim = false;
    if (inner.endsWith('-')) {
        rightTrim = true;
        inner = inner.slice(0, -1);
    }
    state.index = close + 2;
    if (rightTrim) {
        while (state.index < template.length && isWhitespace({ char: template[state.index] })) state.index += 1;
    }

    const body = inner.trim();
    if (isOutput) {
        const { path, segments } = parseExpression({ expression: body, offset: at, template });
        return { kind: 'output', path, segments, leftTrim, offset: at };
    }

    const nameMatch = TAG_NAME_PATTERN.exec(body);
    if (!nameMatch) throw parseError({ detail: 'invalid_tag', offset: at, template });
    const name = nameMatch[1];
    const argument = body.slice(name.length).trim();
    if (name === 'if' || name === 'elsif') {
        const { path, segments } = parseExpression({ expression: argument, offset: at, template });
        return { kind: name, path, segments, leftTrim, offset: at };
    }
    if (name === 'else' || name === 'endif' || name === 'raw' || name === 'endraw') {
        if (argument !== '') throw parseError({ detail: `unexpected_argument:${name}`, offset: at, template });
        return { kind: name, leftTrim, offset: at };
    }
    throw parseError({ detail: `unsupported_tag:${name}`, offset: at, template });
}

/**
 * Captures a raw block's literal content up to the first `{% endraw %}`. A raw
 * block does not nest: the first endraw closes it, and its absence is an error.
 * @param {{state: TemplateState, offset: number}} arg0
 * @returns {RawNode}
 */
function readRawBlock({ state, offset }) {
    const template = state.template;
    const contentStart = state.index;
    const endraw = /\{%(-?)[ \t\r\n]*endraw[ \t\r\n]*(-?)%\}/g;
    endraw.lastIndex = contentStart;
    const match = endraw.exec(template);
    if (!match) throw parseError({ detail: 'unclosed_raw', offset, template });
    let value = template.slice(contentStart, match.index);
    if (match[1] === '-') value = trimEnd({ value });
    state.index = match.index + match[0].length;
    if (match[2] === '-') {
        while (state.index < template.length && isWhitespace({ char: template[state.index] })) state.index += 1;
    }
    return { type: 'raw', value, offset: contentStart };
}

/**
 * Parses one `{% if %}` block (including its `elsif`/`else` chain). Each
 * `elsif` is a branch at the same nesting level, so only a genuinely nested
 * `if` counts toward `maxDepth`.
 * @param {{state: TemplateState, token: {kind: 'if', path: string, segments: string[], offset: number}, depth: number, maxDepth: number}} arg0
 * @returns {IfNode}
 */
function parseIfBlock({ state, token, depth, maxDepth }) {
    const template = state.template;
    /** @type {TemplateBranch[]} */
    const branches = [];
    let current = parseNodes({ state, depth: depth + 1, maxDepth });
    branches.push({ path: token.path, segments: token.segments, body: current.nodes });
    /** @type {TemplateNode[]|null} */
    let alternate = null;
    for (;;) {
        const terminator = current.terminator;
        if (terminator === null) throw parseError({ detail: 'unclosed_if', offset: token.offset, template });
        if (terminator.kind === 'elsif') {
            current = parseNodes({ state, depth: depth + 1, maxDepth });
            branches.push({ path: terminator.path, segments: terminator.segments, body: current.nodes });
            continue;
        }
        if (terminator.kind === 'else') {
            const rest = parseNodes({ state, depth: depth + 1, maxDepth });
            if (rest.terminator === null) throw parseError({ detail: 'unclosed_if', offset: token.offset, template });
            if (rest.terminator.kind !== 'endif') {
                throw parseError({
                    detail: `unexpected_tag:${rest.terminator.kind}`,
                    offset: rest.terminator.offset,
                    template
                });
            }
            alternate = rest.nodes;
            return { type: 'if', branches, alternate, offset: token.offset };
        }
        if (terminator.kind === 'endif') return { type: 'if', branches, alternate, offset: token.offset };
        throw parseError({ detail: `unexpected_tag:${terminator.kind}`, offset: terminator.offset, template });
    }
}

/**
 * Returns the next occurrence of `delimiter` at or after the cursor and caches
 * the result on the shared state: a found index, or `null` for "absent from the
 * rest of the template". Both delimiters are asked for once per node, so a
 * delimiter that never occurs in the tail would otherwise be rescanned once per
 * node (O(n²) on output-only and raw-heavy templates).
 * @param {{state: TemplateState, delimiter: string, cacheKey: 'nextOutputAt'|'nextTagAt'}} arg0
 * @returns {number} The index, or -1 when absent.
 */
function nextDelimiter({ state, delimiter, cacheKey }) {
    const cached = state[cacheKey];
    if (cached === null) return -1;
    if (cached !== undefined && cached >= state.index) return cached;
    const found = state.template.indexOf(delimiter, state.index);
    state[cacheKey] = found === -1 ? null : found;
    return found;
}

/**
 * Parses nodes until end of input or a block terminator. Left trim removes
 * trailing whitespace from the text just read; right trim already moved the
 * cursor, so the next slice starts after the whitespace.
 * @param {{state: TemplateState, depth: number, maxDepth: number}} arg0
 * @returns {ParsedBlock}
 */
function parseNodes({ state, depth, maxDepth }) {
    const template = state.template;
    /** @type {TemplateNode[]} */
    const nodes = [];
    for (;;) {
        const outputAt = nextDelimiter({ state, delimiter: '{{', cacheKey: 'nextOutputAt' });
        const tagAt = nextDelimiter({ state, delimiter: '{%', cacheKey: 'nextTagAt' });
        let at = tagAt;
        if (outputAt === -1) at = tagAt;
        else if (tagAt === -1) at = outputAt;
        else at = Math.min(outputAt, tagAt);
        if (at === -1) {
            const tail = template.slice(state.index);
            if (tail !== '') nodes.push({ type: 'text', value: tail, offset: state.index });
            state.index = template.length;
            return { nodes, terminator: null };
        }

        const textStart = state.index;
        const token = readTag({ state, at });
        let text = template.slice(textStart, at);
        if (token.leftTrim) text = trimEnd({ value: text });
        if (text !== '') nodes.push({ type: 'text', value: text, offset: textStart });

        if (token.kind === 'output') {
            nodes.push({ type: 'output', path: token.path, segments: token.segments, offset: token.offset });
            continue;
        }
        if (token.kind === 'if') {
            if (depth + 1 > maxDepth) throw parseError({ detail: 'too_deep', offset: token.offset, template });
            nodes.push(parseIfBlock({ state, token, depth, maxDepth }));
            continue;
        }
        if (token.kind === 'raw') {
            nodes.push(readRawBlock({ state, offset: token.offset }));
            continue;
        }
        // elsif / else / endif / endraw: only the enclosing block can accept it.
        return { nodes, terminator: token };
    }
}

/**
 * Parses a prompt template once. The policy calls this on every load and keeps
 * the AST; a parse error invalidates the load, never one item's render.
 * @param {{template?: string, maxDepth?: number}} [arg0]
 * @returns {TemplateAst}
 */
export function parseTemplate({ template, maxDepth = WORKFLOW_POLICY_DEFAULTS.maxTemplateDepth } = {}) {
    if (typeof template !== 'string') throw parseError({ detail: 'invalid_template', offset: 0, template: '' });
    const depthCap = readCap({ option: 'maxDepth', value: maxDepth });
    const state = { template, index: 0 };
    const root = parseNodes({ state, depth: 0, maxDepth: depthCap });
    if (root.terminator !== null) {
        throw parseError({
            detail: `unexpected_tag:${root.terminator.kind}`,
            offset: root.terminator.offset,
            template
        });
    }
    return { type: 'root', nodes: root.nodes };
}

/**
 * Resolves a path from the two roots, own properties only. A root other than
 * `issue`/`attempt`, a missing property, and a non-object intermediate are
 * errors; a present `null`/`undefined` is not (it renders as `''`).
 * @param {{roots: Record<string, unknown>, path: string, segments: string[]}} arg0
 * @returns {unknown}
 */
function resolvePath({ roots, path, segments }) {
    const rootName = segments[0];
    if (rootName !== 'issue' && rootName !== 'attempt') throw renderError({ detail: path, field: path });
    let current = roots[rootName];
    for (let index = 1; index < segments.length; index += 1) {
        const segment = segments[index];
        if (FORBIDDEN_KEYS.has(segment)) throw renderError({ detail: path, field: path });
        if (current === null || typeof current !== 'object') throw renderError({ detail: path, field: path });
        const record = /** @type {Record<string, unknown>} */ (current);
        // A hostile view can throw from a getter or a Proxy trap; that must be a
        // PolicyError like any other unreadable path, not a raw TypeError.
        let present = false;
        let value;
        try {
            present = Object.hasOwn(record, segment);
            if (present) value = record[segment];
        } catch {
            throw renderError({ detail: path, field: path });
        }
        if (!present) throw renderError({ detail: path, field: path });
        current = value;
    }
    return current;
}

/**
 * Renders one value as prompt text. No HTML escaping: this is a prompt.
 * @param {{value: unknown, path: string}} arg0
 * @returns {string}
 */
function renderValue({ value, path }) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        return (/** @type {unknown[]} */ (value)).map((item) => renderValue({ value: item, path })).join(', ');
    }
    throw renderError({ detail: `${path}:non_scalar`, field: path });
}

/**
 * Documented deviation from Liquid: JS truthiness, except that an empty array
 * is falsy (Liquid would call it truthy).
 * @param {{value: unknown}} arg0
 * @returns {boolean}
 */
function isTruthy({ value }) {
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
}

/**
 * @param {{context: RenderContext, text: string}} arg0
 */
function pushText({ context, text }) {
    if (text === '') return;
    context.chars += text.length;
    // Stop at the cap instead of building the rest of a giant string.
    if (context.chars > context.maxRenderedChars) throw renderError({ detail: 'prompt_too_large' });
    context.parts.push(text);
}

/**
 * @param {{nodes: TemplateNode[], roots: Record<string, unknown>, context: RenderContext}} arg0
 */
function renderNodes({ nodes, roots, context }) {
    for (const node of nodes) {
        if (node.type === 'text' || node.type === 'raw') {
            pushText({ context, text: node.value });
            continue;
        }
        if (node.type === 'output') {
            const value = resolvePath({ roots, path: node.path, segments: node.segments });
            pushText({ context, text: renderValue({ value, path: node.path }) });
            continue;
        }
        let matched = false;
        for (const branch of node.branches) {
            if (!isTruthy({ value: resolvePath({ roots, path: branch.path, segments: branch.segments }) })) continue;
            renderNodes({ nodes: branch.body, roots, context });
            matched = true;
            break;
        }
        if (!matched && node.alternate !== null) renderNodes({ nodes: node.alternate, roots, context });
    }
}

/**
 * Renders a parsed template for one item. Pure and item-local: the policy keeps
 * the AST across reloads and calls this once per attempt. A missing or malformed
 * AST is rejected as `invalid_template`, never as a destructuring TypeError.
 * @param {{ast?: unknown, issue?: unknown, attempt?: unknown, maxRenderedChars?: number}} [arg0]
 * @returns {string}
 */
export function renderParsedTemplate({
    ast,
    issue,
    attempt = null,
    maxRenderedChars = WORKFLOW_POLICY_DEFAULTS.maxRenderedChars
} = {}) {
    if (ast === null || typeof ast !== 'object'
        || !Array.isArray(/** @type {{nodes?: unknown}} */ (ast).nodes)) {
        throw parseError({ detail: 'invalid_template', offset: 0, template: '' });
    }
    const charsCap = readCap({ option: 'maxRenderedChars', value: maxRenderedChars });
    /** @type {RenderContext} */
    const context = { chars: 0, maxRenderedChars: charsCap, parts: [] };
    /** @type {Record<string, unknown>} */
    const roots = { issue, attempt };
    const parsed = /** @type {TemplateAst} */ (/** @type {unknown} */ (ast));
    renderNodes({ nodes: parsed.nodes, roots, context });
    return context.parts.join('');
}

/**
 * Parses and renders in one call. `WorkflowPolicy` uses the two halves
 * separately so a parse error happens once per load, not once per item.
 * @param {{template?: string, issue?: unknown, attempt?: unknown, maxRenderedChars?: number, maxDepth?: number}} [arg0]
 * @returns {string}
 */
export function renderPromptTemplate({
    template,
    issue,
    attempt = null,
    maxRenderedChars = WORKFLOW_POLICY_DEFAULTS.maxRenderedChars,
    maxDepth = WORKFLOW_POLICY_DEFAULTS.maxTemplateDepth
} = {}) {
    const ast = parseTemplate({ template, maxDepth });
    return renderParsedTemplate({ ast, issue, attempt, maxRenderedChars });
}
