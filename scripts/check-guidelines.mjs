#!/usr/bin/env node


/**
 * @file GUIDELINES.md conformance gate for `lib/**`.
 * @version 0.7.2
 *
 * Encodes each clause of GUIDELINES.md as a structural check over the AST:
 *   R1 destructured named args — no named function / method / constructor /
 *      object-method with >1 parameter unless it takes a single `{ ... } = {}`.
 *      Anonymous inline callbacks are not callables-with-a-name and are exempt.
 *   R2 fluent chaining — `*Builder` classes: each fluent method (with, add,
 *      register, use, as prefixes) returns `this` (directly or via a
 *      `this.*(...)` delegation), and the builder exposes a terminal method.
 *   R3 event-driven — `emit` names come from the EVENTS registry, never bare
 *      string literals (except the Node `'error'` convention).
 *   R4 core/adapters separation — no forbidden cross-area import edges.
 *
 * Run: `node scripts/check-guidelines.mjs [--json] [--all]`
 * Exit 1 when any non-allowlisted violation remains.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EXCEPTIONS_FILE = join(HERE, 'guideline-exceptions.json');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const scanAll = argv.includes('--all');
const SCAN_ROOTS = scanAll ? ['lib', 'examples', 'apps', 'scripts'] : ['lib'];


/** Areas that may only import from themselves and lower layers. */
const FORBIDDEN_EDGES = new Set([
    'core → tools', 'core → agentic', 'core → backends', 'core → messaging', 'core → support',
    'support → agentic', 'support → backends', 'support → tools',
    'messaging → agentic', 'messaging → backends', 'messaging → tools',
]);

const toPosix = (p) => p.split(sep).join('/');
const relRoot = (abs) => toPosix(relative(ROOT, abs));

function walk({ dir, out = [] } = {}) {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) walk({ dir: abs, out });
        else if (name.endsWith('.mjs')) out.push(abs);
    }
    return out;
}

const isSingleObjectPattern = (params) =>
    params.length === 1 &&
    (params[0].type === 'ObjectPattern' ||
        (params[0].type === 'AssignmentPattern' && params[0].left.type === 'ObjectPattern'));

const violatesR1 = (params) => params.length > 1 && !isSingleObjectPattern(params);

const isFn = (n) =>
    n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');


/** Walk with parent + property key so we can name every declared callable. */
function eachNode({ node, parent = null, key = null, cb } = {}) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const child of node) eachNode({ node: child, parent, key, cb });
        return;
    }
    if (typeof node.type !== 'string') return;
    cb({ node, parent, key });
    for (const k of Object.keys(node)) {
        if (k === 'start' || k === 'end' || k === 'loc' || k === 'type') continue;
        eachNode({ node: node[k], parent: node, key: k, cb });
    }
}


/** Resolve the declared name of a callable node, or null when anonymous. */
function callableName({ node, parent, key } = {}) {
    if (node.type === 'FunctionDeclaration') return node.id ? node.id.name : null;
    if (!parent) return null;
    if (parent.type === 'VariableDeclarator' && key === 'init' && parent.id.type === 'Identifier') return parent.id.name;
    if (parent.type === 'AssignmentExpression' && key === 'right' && parent.left.type === 'Identifier') return parent.left.name;
    if (parent.type === 'Property' && key === 'value' && !parent.computed && parent.key.type === 'Identifier') return parent.key.name;
    if (parent.type === 'Property' && key === 'value' && !parent.computed && parent.key.type === 'Literal') return String(parent.key.value);
    return null;
}

function methodReturnsThis(method) {
    const body = method.value.body;
    if (!body || body.type !== 'BlockStatement') return false;
    let ok = false;
    eachNode({
        node: body, parent: method.value, key: 'body',
        cb: ({ node }) => {
            if (node.type !== 'ReturnStatement' || !node.argument) return;
            if (node.argument.type === 'ThisExpression') { ok = true; return; }
            if (node.argument.type === 'CallExpression' &&
                node.argument.callee.type === 'MemberExpression' &&
                node.argument.callee.object.type === 'ThisExpression') {
                ok = true;
            }
        }
    });
    return ok;
}

const FLUENT_METHOD = /^(with|add|register|use|as)[A-Z]/;
const TERMINAL_METHOD = /^(build|execute|run|toResult|toJSON|start|close|complete|finalize|finish|step|drain|resolve)$/;

function scanFile({ abs, violations } = {}) {
    const src = readFileSync(abs, 'utf8');
    let ast;
    try {
        ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true });
    } catch (error) {
        violations.push({ rule: 'PARSE', file: relRoot(abs), symbol: null, line: 0, detail: String(error && error.message) });
        return;
    }
    const rel = relRoot(abs);
    const area = rel.split('/')[1] || 'root';

    eachNode({
        node: ast,
        cb: ({ node, parent, key }) => {
            if (!isFn(node)) return;
            if (parent && (parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')) return;
            if (parent && parent.type === 'Property' && key === 'value') return;
            const name = callableName({ node, parent, key });
            if (!name || !violatesR1(node.params)) return;
            violations.push({ rule: 'R1', file: rel, symbol: name, kind: 'function', arity: node.params.length, line: node.loc.start.line });
        }
    });

    eachNode({
        node: ast,
        cb: ({ node }) => {
            if (node.type === 'Property' && !node.computed && node.value && isFn(node.value)) {
                const name = node.key.type === 'Identifier' ? node.key.name
                    : node.key.type === 'Literal' ? String(node.key.value) : null;
                if (name && violatesR1(node.value.params)) {
                    violations.push({ rule: 'R1', file: rel, symbol: name, kind: 'object-method', arity: node.value.params.length, line: node.value.loc.start.line });
                }
                return;
            }
            if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') return;
            const cls = node.id ? node.id.name : '(anonymous class)';
            let fluentCount = 0;
            let terminalCount = 0;
            for (const m of node.body.body) {
                if (m.type !== 'MethodDefinition' && m.type !== 'PropertyDefinition') continue;
                const value = m.value;
                if (!value || (value.type !== 'FunctionExpression' && value.type !== 'ArrowFunctionExpression')) continue;
                if (m.kind === 'get' || m.kind === 'set') continue;
                const name = m.key && (m.key.name !== undefined ? m.key.name : m.key.value);
                if (violatesR1(value.params)) {
                    violations.push({
                        rule: 'R1', file: rel,
                        symbol: name === 'constructor' ? `${cls}.constructor` : `${cls}.${name}`,
                        kind: name === 'constructor' ? 'constructor' : 'method',
                        arity: value.params.length, line: value.loc.start.line
                    });
                }
                if (typeof name === 'string' && FLUENT_METHOD.test(name)) {
                    fluentCount += 1;
                    if (m.type === 'MethodDefinition' && !methodReturnsThis(m)) {
                        violations.push({ rule: 'R2', file: rel, symbol: `${cls}.${name}`, line: m.loc.start.line, detail: 'fluent method does not return this' });
                    }
                }
                if (typeof name === 'string' && TERMINAL_METHOD.test(name)) terminalCount += 1;
            }
            if (/Builder$/.test(cls) && fluentCount >= 1 && terminalCount === 0) {
                violations.push({ rule: 'R2', file: rel, symbol: cls, line: node.loc.start.line, detail: 'builder has fluent methods but no terminal method' });
            }
        }
    });

    scanForImportEdges({ ast, area, rel, violations });

    eachNode({
        node: ast,
        cb: ({ node }) => {
            if (node.type === 'ImportExpression' && node.source && node.source.type === 'Literal' && String(node.source.value).startsWith('.')) {
                const targetAbs = resolve(dirname(join(ROOT, rel)), String(node.source.value));
                const targetRel = relRoot(targetAbs);
                const to = targetRel.split('/')[1] || targetRel;
                const edge = `${area} → ${to}`;
                if (FORBIDDEN_EDGES.has(edge)) {
                    violations.push({ rule: 'R4', file: rel, symbol: to, line: node.loc.start.line, detail: `forbidden dynamic import edge ${edge}` });
                }
            }
            if (node.type !== 'CallExpression') return;
            const callee = node.callee;
            if (!callee || callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return;
            if (callee.property.name !== 'emit') return;
            const first = node.arguments[0];
            if (first && first.type === 'Literal' && typeof first.value === 'string' && first.value !== 'error') {
                violations.push({ rule: 'R3', file: rel, symbol: first.value, line: first.loc.start.line, detail: 'bare emit name; use EVENTS' });
            }
        }
    });
}

function scanForImportEdges({ ast, area, rel, violations } = {}) {
    for (const node of ast.body) {
        if (node.type !== 'ImportDeclaration' && node.type !== 'ExportNamedDeclaration' && node.type !== 'ExportAllDeclaration') continue;
        if (!node.source || !String(node.source.value).startsWith('.')) continue;
        const targetAbs = resolve(dirname(join(ROOT, rel)), node.source.value);
        const targetRel = relRoot(targetAbs);
        const to = targetRel.split('/')[1] || targetRel;
        const edge = `${area} → ${to}`;
        if (FORBIDDEN_EDGES.has(edge)) {
            violations.push({ rule: 'R4', file: rel, symbol: to, line: node.loc.start.line, detail: `forbidden import edge ${edge}` });
        }
    }
}

function loadAllowlist() {
    if (!existsSync(EXCEPTIONS_FILE)) return [];
    try {
        const parsed = JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8'));
        return Array.isArray(parsed.exceptions) ? parsed.exceptions : [];
    } catch {
        return [];
    }
}

function main() {
    const files = SCAN_ROOTS.flatMap((r) => walk({ dir: join(ROOT, r) }));
    const violations = [];
    for (const abs of files) scanFile({ abs, violations });

    const allowed = new Set(loadAllowlist().map((e) => `${e.rule}|${e.file}|${e.symbol}`));
    const remaining = violations.filter((v) => !allowed.has(`${v.rule}|${v.file}|${v.symbol}`));
    const byRule = remaining.reduce((acc, v) => { acc[v.rule] = (acc[v.rule] || 0) + 1; return acc; }, {});

    if (asJson) {
        process.stdout.write(JSON.stringify({ roots: SCAN_ROOTS, files: files.length, counts: byRule, total: remaining.length, violations: remaining }, null, 2) + '\n');
    } else {
        process.stdout.write(`guidelines gate — ${files.length} files, ${remaining.length} violation(s)${Object.keys(byRule).length ? ' ' + JSON.stringify(byRule) : ''}\n`);
        for (const v of remaining.slice(0, 200)) {
            process.stdout.write(`  [${v.rule}] ${v.file}:${v.line} ${v.symbol}${v.detail ? ' — ' + v.detail : ''}\n`);
        }
        if (remaining.length > 200) process.stdout.write(`  … ${remaining.length - 200} more\n`);
    }
    process.exit(remaining.length ? 1 : 0);
}

main();
