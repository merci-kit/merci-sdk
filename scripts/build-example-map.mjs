#!/usr/bin/env node

/**
 * @file Generates `examples/SYMBOL-MAP.md` — an AST symbol map of the progressive
 * example set: which public SDK entry point each example imports from, the
 * exact symbols it exercises, and the shared example helpers it uses.
 * @version 0.7.2
 *
 * Parses every `examples/*.mjs` with acorn and pairs it with the public export
 * surface of `lib/index.mjs` (the `merci-sdk` barrel). Run via
 * `pnpm build:example-map`.
 */
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(ROOT, 'examples');
const OUT = join(EXAMPLES, 'SYMBOL-MAP.md');

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();


/** Top-level numbered example modules (plus their server children); `_shared` and scratch `_*` are excluded. */
function exampleFiles() {
    return readdirSync(EXAMPLES)
        .filter((n) => /^\d{2}_[a-z0-9_]+\.mjs$/.test(n))
        .map((n) => join(EXAMPLES, n))
        .sort();
}

function sharedFiles() {
    const dir = join(EXAMPLES, '_shared');
    try { return readdirSync(dir).filter((n) => n.endsWith('.mjs')).map((n) => join(dir, n)).sort(); }
    catch { return []; }
}


/** @param {{ src: string }} args @returns {import('acorn').ProgramNode|null} */
function parseModule({ src }) {
    try { return parse(src, { ecmaVersion: 2023, sourceType: 'module', locations: true }); }
    catch { return null; }
}


/** Extracts the module's scenario from its leading JSDoc block. @param {{ src: string }} args */
function extractRole({ src }) {
    const block = src.match(/\/\*\*[\s\S]*?\*\//)?.[0] ?? '';
    const lines = block
        .replace(/^\/\*\*/, '')
        .replace(/\*\/$/, '')
        .split('\n')
        .map((l) => l.replace(/^\s*\*?\s?/, '').trim())
        .filter(Boolean);
    const at = lines.findIndex((l) => l.startsWith('@file'));
    const start = at !== -1 ? at + 1 : 0;
    const role = lines.slice(start).find((l) => !l.startsWith('@')) ?? '';
    return collapse(role).replace(/^Example\s+\d+\s*[—-]\s*/i, '');
}


/** Collects import declarations from a parsed module. @param {{ ast: any }} args */
function importsOf({ ast }) {
    
    /** @type {Array<{ source: string, names: string[] }>} */
        const out = [];
    for (const node of ast.body) {
        if (node.type === 'ImportDeclaration') {
            const source = node.source.value;
            const names = node.specifiers.map(( s) => (s.type === 'ImportDefaultSpecifier' ? 'default' : s.imported?.name ?? s.local?.name ?? s.local?.name));
            out.push({ source, names });
        } else if (node.type === 'ExportNamedDeclaration' && node.source) {
            out.push({ source: node.source.value, names: node.specifiers.map(( s) => s.exported?.name ?? s.local?.name) });
        }
    }
    return out;
}

const PUBLIC_SOURCES = new Set(['merci-sdk', 'merci-sdk/tools', 'merci-sdk/planning', 'merci-sdk/json', 'merci-sdk/messaging', 'merci-sdk/oai', 'merci-sdk/jai', 'merci-sdk/gai', 'merci-sdk/aai', 'merci-sdk/workspace', 'merci-sdk/scheduler', 'merci-sdk/operator', 'merci-sdk/workflow-policy', 'merci-sdk/orchestration', 'merci-sdk/agents', 'merci-sdk/knowledge']);


/**
 * Walks every node of a parsed module.
 *
 * A visitor that returns `false` skips the node's children — that is how the
 * import statements are kept out of the "used" evidence: the specifiers of an
 * import are not a USE of the imported name, they are the import itself.
 *
 * @param {any} node - the AST node (or any value inside it).
 * @param {(node: any) => void|boolean} visit - called for every node with a `type`; return `false` to skip its children.
 * @returns {void}
 */
function walk({ node, visit }) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const child of node) walk({ node: child, visit });
        return;
    }
    let descend = true;
    if (typeof node.type === 'string') descend = visit(node) !== false;
    if (descend === false) return;
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
        walk({ node: node[key], visit });
    }
}


/**
 * Collects the public SDK surface an example actually EXERCISES.
 *
 * The imports alone are not the demonstrated surface: an example that calls
 * `session.withBudget(...)` demonstrates `withBudget`, and an example that
 * calls `mcpClient.listResources()` demonstrates `listResources` — neither name
 * ever appears in an import statement. Four shapes are recognised, each with a
 * precise, one-hop rule:
 *
 *   - the BUILDER methods: a `with*` call (the SDK's builder convention).
 *   - the SESSION methods: a call on a session (`client.session(...)` and
 *     everything derived from it) — `run`, `step`, `forkCheckpoint`, …
 *   - the PARAMETER methods: a call on the builder handed to
 *     `withParameters({ params: (b) => … })` — `serviceTier`, `cachePoints`, …
 *   - the OBJECT methods: a call on an SDK object the example constructs
 *     (`new McpClient(...)` → `listResources`, `new LocalFileSessionStore(...)`
 *     → `fork`, …).
 *
 * Every other member call is still collected in `calls` — the coverage gate
 * uses it as the fallback evidence, because a method can only be a public
 * method of a public object if it is CALLED somewhere.
 *
 * @param {{ ast: any, importedNames: string[], sharedNames?: string[] }} arg0
 * @returns {{ builder: string[], session: string[], parameter: string[], object: string[], calls: string[] }}
 */
export function demonstratedSurface({ ast, importedNames, sharedNames = [] }) {
    /** @type {Set<string>} */
    const builder = new Set();
    /** @type {Set<string>} */
    const session = new Set();
    /** @type {Set<string>} */
    const parameter = new Set();
    /** @type {Set<string>} */
    const object = new Set();
    /** @type {Set<string>} */
    const calls = new Set();
    /** The OPTION keys an example passes: `outputSchema`, `maxBudgetUsd`, … @type {Set<string>} */
    const keys = new Set();
    /** The identifiers the body USES (the import statements themselves do not count). @type {Set<string>} */
    const used = new Set();
    /** The async generator functions the example declares: `async function* feed()`. @type {Set<string>} */
    const asyncGenerators = new Set();
    /** The dotted member paths: `methods.agent.session.new`, … @type {Set<string>} */
    const paths = new Set();

    const imported = new Set(importedNames);
    // The repo-internal helpers (`examples/_shared/*`) are NOT the SDK's API:
    // an audit descriptor or a log payload handed to them mentions a key, it
    // does not configure anything.
    const sharedHelpers = new Set(sharedNames);
    /** Locals built from an SDK object: `const mcpClient = new McpClient(...)`. @type {Map<string, string>} */
    const constructed = new Map();
    /** Locals that hold a session: `const session = client.session(model)`. @type {Set<string>} */
    const sessions = new Set();
    /** Locals that hold a repo-internal helper: `const audit = createAudit(…)`. @type {Set<string>} */
    const sharedLocals = new Set();
    /** The parameter of the `withParameters` callback: `params: (b) => ...`. @type {Set<string>} */
    const parameterNames = new Set();

    // ── pass 0: the identifiers the body uses ───────────────────────────────
    // The import statements do NOT count: a symbol that is imported and never
    // used is not demonstrated by anything — the example would not even run.
    walk({
        node: ast,
        visit: (node) => {
            if (node.type === 'ImportDeclaration') return false;
            if (node.type === 'Identifier') used.add(node.name);
            return undefined;
        },
    });

    // ── pass 1: what the locals hold ────────────────────────────────────────
    walk({
        node: ast,
        visit: (node) => {
            if (node.type !== 'VariableDeclarator') return;
            if (node.id?.type !== 'Identifier') return;
            const init = node.init;
            if (!init) return;
            // `const store = new LocalFileSessionStore({ ... })`
            if (init.type === 'NewExpression' && init.callee?.type === 'Identifier' && imported.has(init.callee.name)) {
                constructed.set(node.id.name, init.callee.name);
                return;
            }
            // `const audit = createAudit({ ... })` — the repo-internal helper. Its
            // option objects are NOT the SDK's API: an audit descriptor that
            // mentions `outputSchema` configures nothing.
            if (init.type === 'CallExpression' && init.callee?.type === 'Identifier' && sharedHelpers.has(init.callee.name)) {
                sharedLocals.add(node.id.name);
                return;
            }
            // `const session = client.session(model).withTools({ ... })` — the
            // chain is unwrapped to its BASE, so a session behind any number
            // of builder calls is still a session. The chain mixes member
            // accesses and calls, so both are unwrapped.
            if (isSessionChain({ node: init })) sessions.add(node.id.name);
        },
    });

    // ── pass 2: the `withParameters` callback parameter ──────────────────────
    walk({
        node: ast,
        visit: (node) => {
            if (node.type !== 'CallExpression') return;
            const callee = node.callee;
            if (callee?.type !== 'MemberExpression' || callee.property?.name !== 'withParameters') return;
            const options = node.arguments?.[0];
            const params = options?.type === 'ObjectExpression'
                ? options.properties?.find((/** @type {any} */ p) => p.key?.name === 'params')?.value
                : null;
            if (params?.type !== 'ArrowFunctionExpression' && params?.type !== 'FunctionExpression') return;
            const first = params.params?.[0];
            if (first?.type === 'Identifier') parameterNames.add(first.name);
        },
    });

    // ── pass 3: the option keys the SDK receives, and the dotted paths ──────
    // An option key is evidence only when the SDK RECEIVES it: the keys of the
    // object literals handed to an SDK call (or to a tool definition). A key
    // that only appears in an audit descriptor or a log payload is a MENTION,
    // not a use — and a mention must never satisfy a capability.
    /**
     * Collects the property keys of an object literal (at any depth).
     * @param {{ node: any, into: Set<string> }} arg0 - the AST node and the set to fill.
     * @returns {void}
     */
    const collectKeys = ({ node, into }) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const child of node) collectKeys({ node: child, into });
            return;
        }
        if (node.type === 'Property' && !node.computed) {
            const key = node.key?.name ?? node.key?.value;
            if (typeof key === 'string') into.add(key);
        }
        for (const key of Object.keys(node)) {
            if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
            collectKeys({ node: node[key], into });
        }
    };

    walk({
        node: ast,
        visit: (node) => {
            // An async generator is how the SDK's STREAMED INPUT is fed — the
            // public surface has no symbol of its own, so the marker is the
            // evidence.
            if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression')
                && node.async === true && node.generator === true) {
                keys.add('asyncGenerator');
                if (node.id?.name) asyncGenerators.add(node.id.name);
                return undefined;
            }
            // A TOOL DEFINITION — the SDK's tool shape — carries its schema
            // with it (`outputSchema`), and it is not a call argument.
            if (node.type === 'ObjectExpression') {
                const isTool = node.properties?.some((/** @type {any} */ p) => p.key?.name === 'execute' && !p.computed);
                if (isTool) collectKeys({ node, into: keys });
                return undefined;
            }
            // The SDK's own calls: their option objects are what the SDK
            // receives. The logger only PRINTS, and the repo-internal helpers
            // are not the API — neither configures anything.
            if (node.type === 'CallExpression' || node.type === 'NewExpression') {
                const callee = node.callee;
                const target = callee?.type === 'Identifier' ? callee.name
                    : callee?.type === 'MemberExpression' && callee.object?.type === 'Identifier' ? callee.object.name
                        : null;
                if (target && target !== 'log' && !sharedHelpers.has(target) && !sharedLocals.has(target)) {
                    for (const argument of node.arguments ?? []) collectKeys({ node: argument, into: keys });
                }
                return undefined;
            }
            // The dotted member paths: `methods.agent.session.new`.
            if (node.type === 'MemberExpression' && !node.computed) {
                const path = memberPath({ node });
                if (path) paths.add(path);
            }
            return undefined;
        },
    });

    // ── pass 4: the calls ───────────────────────────────────────────────────
    walk({
        node: ast,
        visit: (node) => {
            if (node.type !== 'CallExpression') return;
            const callee = node.callee;
            if (callee?.type !== 'MemberExpression') return;
            const name = callee.property?.name;
            if (!name) return;
            calls.add(name);
            if (/^with[A-Z]/.test(name)) builder.add(name);
            // The STREAMED INPUT: `run({ initialInput: feed({ chunks }) })` where
            // `feed` is an async generator. An async generator alone is not
            // enough — a fake vendor stream is one too. The receiver of the
            // call is usually a CHAIN (`client.session(m).withTools(…).run(…)`),
            // so this runs before the receiver is inspected.
            if (name === 'run') {
                const options = node.arguments?.[0];
                const initialInput = options?.type === 'ObjectExpression'
                    ? options.properties?.find((/** @type {any} */ p) => p.key?.name === 'initialInput')?.value
                    : null;
                const feed = initialInput?.type === 'CallExpression' ? initialInput.callee : initialInput;
                if (feed?.type === 'Identifier' && asyncGenerators.has(feed.name)) keys.add('streamedInput');
            }
            // The receiver is resolved through its chain: a builder call is
            // usually `b.temperature(…).serviceTier(…)`, and the method belongs
            // to the object the chain is rooted at.
            const receiver = callee.object;
            const rooted = chainRoot({ node: receiver });
            if (rooted && sessions.has(rooted)) session.add(name);
            if (rooted && parameterNames.has(rooted)) parameter.add(name);
            if (rooted && constructed.has(rooted)) object.add(name);
            // A session built inline: `client.session(model).run({ … })`.
            if (!rooted || !sessions.has(rooted)) {
                if (isSessionChain({ node: receiver })) session.add(name);
            }
        },
    });

    const sorted = (/** @type {Set<string>} */ set) => [...set].sort();
    return {
        builder: sorted(builder),
        session: sorted(session),
        parameter: sorted(parameter),
        object: sorted(object),
        calls: sorted(calls),
        keys: sorted(keys),
        paths: sorted(paths),
        used: sorted(used),
    };
}


/**
 * The base identifier of a call/member chain: `b.temperature(…).serviceTier(…)`
 * is rooted at `b`.
 * @param {{ node: any }} arg0
 * @returns {string|null} the identifier, or null when the chain has none.
 */
function chainRoot({ node }) {
    let current = node;
    while (current) {
        if (current.type === 'CallExpression') { current = current.callee; continue; }
        if (current.type === 'MemberExpression') { current = current.object; continue; }
        break;
    }
    return current?.type === 'Identifier' ? current.name : null;
}


/**
 * Whether an expression is a session: a chain that starts at `… .session(…)`.
 * @param {{ node: any }} arg0
 * @returns {boolean}
 */
function isSessionChain({ node }) {
    let current = node;
    while (current) {
        if (current.type === 'CallExpression') {
            if (current.callee?.type === 'MemberExpression' && current.callee.property?.name === 'session') return true;
            current = current.callee;
            continue;
        }
        if (current.type === 'MemberExpression') {
            current = current.object;
            continue;
        }
        return false;
    }
    return false;
}


/**
 * The dotted path of a member expression: `methods.agent.session.new`.
 * @param {{ node: any }} arg0
 * @returns {string|null} the dotted path, or null when it is not a plain chain.
 */
function memberPath({ node }) {
    const parts = [];
    let current = node;
    while (current?.type === 'MemberExpression') {
        if (current.computed) return null;
        const name = current.property?.name;
        if (!name) return null;
        parts.unshift(name);
        current = current.object;
    }
    if (current?.type !== 'Identifier') return null;
    parts.unshift(current.name);
    return parts.join('.');
}


/**
 * Collects every example with the public surface it demonstrates.
 *
 * The `evidence` set is what the coverage gate reasons about: the imported
 * public names, the methods the example CALLS, the option keys it passes and
 * the dotted member paths it reads. A comment that merely mentions a symbol is
 * not evidence — a call is.
 *
 * @returns {Array<{ name: string, role: string, public: string[], imported: string[], builder: string[], session: string[], parameter: string[], object: string[], calls: string[], keys: string[], paths: string[], used: string[], shared: string[], offline: boolean, dual: boolean, evidence: Set<string> }>}
 */
export function collectExamples() {
    const records = [];
    for (const abs of exampleFiles()) {
        const src = readFileSync(abs, 'utf8');
        const ast = parseModule({ src });
        const name = abs.slice(EXAMPLES.length + 1);
        if (!ast) { records.push({ name, role: '(parse failed)', public: [], imported: [], builder: [], session: [], parameter: [], object: [], calls: [], keys: [], paths: [], used: [], subpaths: [], shared: [], offline: false, dual: false, evidence: new Set() }); continue; }
        const imports = importsOf({ ast });
        const publicSymbols = [];
        const subpaths = [];
        const shared = [];
        for (const imp of imports) {
            if (PUBLIC_SOURCES.has(imp.source)) {
                for (const s of imp.names) publicSymbols.push(s);
                if (imp.source !== 'merci-sdk') subpaths.push(`${imp.source} → ${imp.names.join(', ')}`);
            } else if (imp.source.startsWith('./_shared/')) {
                shared.push(...imp.names);
            }
        }
        // An example that declares it needs nothing has no backend path, so it
        // is offline by construction and no `--offline` run can make it live.
        const offlineOnly = /^\s*\*\s*Needs:\s*nothing\b/m.test(src);
        const offline = offlineOnly
            || /createAudit\([^)]*offline:\s*true/.test(src) || /offline:\s*true/.test(src.split('\n').slice(0, 60).join('\n'));
        const dual = /process\.argv\.includes\('--offline'\)/.test(src) && !offlineOnly;
        const uniq = (/** @type {any[]} */ a) => [...new Set(a)].sort();
        const surface = demonstratedSurface({ ast, importedNames: publicSymbols, sharedNames: shared });
        // The demonstrated surface: what the example IMPORTS plus what it CALLS
        // on the SDK's own objects.
        const demonstrated = uniq([...publicSymbols, ...surface.builder, ...surface.session, ...surface.parameter, ...surface.object]);
        // An imported symbol that the body never uses is NOT evidence — the
        // example would not even run. The evidence is what the example USES:
        // the methods it calls, the option keys it passes, the member paths it
        // reads and the imported names it actually references.
        const evidence = new Set([
            ...surface.calls,
            ...surface.keys,
            ...surface.paths,
            ...publicSymbols.filter((name) => surface.used.includes(name)),
        ]);
        records.push({
            name,
            role: extractRole({ src }),
            public: demonstrated,
            imported: uniq(publicSymbols),
            builder: surface.builder,
            session: surface.session,
            parameter: surface.parameter,
            object: surface.object,
            calls: surface.calls,
            keys: surface.keys,
            paths: surface.paths,
            used: surface.used,
            subpaths,
            shared: uniq(shared),
            offline,
            dual,
            evidence,
        });
    }
    return records;
}

/** @type {Map<string, string[]>} example -> symbols */
const symbolToExamples = new Map();
const records = [];

for (const record of collectExamples()) {
    records.push(record);
    for (const s of new Set(record.public)) {
        if (!symbolToExamples.has(s)) symbolToExamples.set(s, []);
        /** @type {string[]} */
        (symbolToExamples.get(s)).push(record.name);
    }
}

const sharedApis = [];
for (const abs of sharedFiles()) {
    const src = readFileSync(abs, 'utf8');
    const ast = parseModule({ src });
    const exported = [];
    if (ast) {
        for (const node of ast.body) {
            if (node.type === 'ExportNamedDeclaration') {
                if (node.declaration) {
                    const d = node.declaration;
                    if (d.type === 'FunctionDeclaration' && d.id) exported.push(d.id.name);
                    else if (d.type === 'ClassDeclaration' && d.id) exported.push(d.id.name);
                    else if (d.type === 'VariableDeclaration') for (const dec of d.declarations) if (dec.id.name) exported.push(dec.id.name);
                }
                for (const s of node.specifiers) exported.push(s.exported.name);
            }
        }
    }
    sharedApis.push({ name: abs.slice(EXAMPLES.length + 1), exported: [...new Set(exported)].sort() });
}

// ── render ───────────────────────────────────────────────────────────────────
const mdEscape = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const lines = [];
lines.push('<!-- GENERATED FILE — do not edit by hand. Run `pnpm build:example-map` to regenerate. -->');
lines.push('');
lines.push('# Merci SDK — Example → SDK symbol map');
lines.push('');
lines.push(`> ${records.length} demo modules (numbered examples + server children), ${symbolToExamples.size} public symbols. Generated from the current \`examples/*.mjs\` by \`scripts/build-example-map.mjs\`.`);
lines.push('> Every example here is **live** (it needs a backend); deterministic, backend-free proofs are tests under `test/examples/`. Every example imports only public entry points.');
lines.push('> The map sees the **demonstrated** surface, not only the imports: the imported symbols plus the builder methods, the session methods, the parameter-builder methods and the methods of the SDK objects the example constructs.');
lines.push('');
lines.push('## 1. Examples');
lines.push('');
lines.push('| # | Example | Scenario | Mode | Public SDK symbols (imported or called) |');
lines.push('| --- | --- | --- | --- | --- |');
for (const r of records) {
    lines.push(`| ${mdEscape(r.name.split('_')[0])} | \`${r.name}\` | ${mdEscape(r.role)} | ${r.dual ? 'live · `--offline`' : (r.offline ? 'offline' : 'live')} | ${r.public.map((s) => `\`${s}\``).join(', ')} |`);
}
lines.push('');
lines.push('## 2. Subpath entry points');
lines.push('');
lines.push('Symbols not on the `merci-sdk` barrel, imported from a published subpath:');
lines.push('');
lines.push('| Example | Import |');
lines.push('| --- | --- |');
for (const r of records) {
    for (const s of r.subpaths) lines.push(`| \`${r.name}\` | \`${mdEscape(s)}\` |`);
}
lines.push('');
lines.push('## 3. Symbol → examples');
lines.push('');
lines.push('| Public symbol | Used by |');
lines.push('| --- | --- |');
for (const [sym, exs] of [...symbolToExamples.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| \`${sym}\` | ${[...new Set(exs)].sort().map((e) => `\`${e}\``).join(', ')} |`);
}
lines.push('');
lines.push('## 4. Builder methods in use');
lines.push('');
lines.push('The `with*` builder methods the examples call — the fluent surface of a session. A method that is missing here is a session feature no example shows.');
lines.push('');
lines.push('| Builder method | Used by |');
lines.push('| --- | --- |');
const builderToExamples = new Map();
for (const r of records) {
    for (const b of r.builder) {
        if (!builderToExamples.has(b)) builderToExamples.set(b, []);
        builderToExamples.get(b).push(r.name);
    }
}
for (const [b, exs] of [...builderToExamples.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| \`${b}\` | ${[...new Set(exs)].sort().map((e) => `\`${e}\``).join(', ')} |`);
}
lines.push('');
lines.push('## 5. Shared example plumbing (`examples/_shared/`)');
lines.push('');
lines.push('Repo-internal helpers; not part of the public SDK. Every example imports its bootstrap/observability from here.');
lines.push('');
lines.push('| Module | Exports |');
lines.push('| --- | --- |');
for (const s of sharedApis) lines.push(`| \`${s.name}\` | ${s.exported.map((e) => `\`${e}\``).join(', ')} |`);
lines.push('');

// The coverage gate imports `collectExamples()` from here — so the file is
// written ONLY when this module is the CLI, never as an import side effect.
/**
 * `argv[1]` may be a symlinked or vanished path; compare real paths without throwing.
 * @type {(p: string) => string}
 */
const canonical = (p) => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };

const isCli = Boolean(process.argv[1]) && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url));
if (isCli) {
    writeFileSync(OUT, lines.join('\n'));
    process.stdout.write(`wrote ${OUT} (${records.length} examples, ${symbolToExamples.size} symbols)\n`);
}
