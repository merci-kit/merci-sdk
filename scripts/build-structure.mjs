#!/usr/bin/env node


/**
 * @file Generates STRUCTURE.md — a tree + symbol map of lib/.
 * @version 0.7.2
 *
 * Parses every lib/**\/*.mjs with acorn, extracts the exported symbols
 * (signatures sliced from the real declarations), @file roles, @typedef
 * types and cross-area import counts, then writes a deterministic markdown
 * document. Run via `pnpm build:structure`.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const LIB_DIR = join(ROOT, 'lib');
const OUT_FILE = join(ROOT, 'STRUCTURE.md');

const AREA_INFO = [
    ['core', 'Foundation: constant tables, typed errors, events, prompt text, loadable component base'],
    ['messaging', 'Unified message model, factories and per-backend history normalizers'],
    ['backends', 'Provider clients (JAI, OAI, GAI, AAI) and their protocol adapters'],
    ['support', 'Cross-cutting utilities: retry, timeouts, JSON, logger, limits'],
    ['tools', 'Tool system: execution, MCP client/server, A2A, shell, skills, context tools'],
    ['agentic', 'Orchestration: sessions, loops, planning, memory, state machine, web components'],
    ['root', 'Public barrel that defines the package entry surface (lib/index.mjs)'],
];

const DIR_NOTES = {
    'lib': 'Library root',
    'lib/core': 'Foundation: constants, errors, events, prompts, loadable base',
    'lib/core/constants': 'Immutable constant tables (backends, protocols, limits, models, capabilities)',
    'lib/core/prompts': 'Prompt text fragments (conversation, DAG, memory, state machine)',
    'lib/messaging': 'Unified message model and normalizers',
    'lib/backends': 'Provider clients and public backend entrypoints',
    'lib/backends/adapters': 'Per-provider wire adapters shared by the backend clients',
    'lib/backends/jai-vendor': 'Vendored JAI task/HTTP transport (vendor boundary)',
    'lib/support': 'Cross-cutting utilities (retry, timeouts, JSON, logger, limits)',
    'lib/tools': 'Tool system: execution, MCP client/server, A2A, shell, skills, context tools',
    'lib/agentic': 'Agentic orchestration layer',
    'lib/agentic/cli': 'CLI-facing helpers (launcher, suggestion source)',
    'lib/agentic/loops': 'Supervisory loop policy and judges',
    'lib/agentic/memory': 'Memory providers, engine, manager and component',
    'lib/agentic/plan': 'Plan/execute stage components',
    'lib/agentic/planning': 'DAG planning, graph, executor, evaluator, checkpoints, task state',
    'lib/agentic/state-machine': 'State machine context and execution engine',
    'lib/agentic/todos': 'Todo component',
    'lib/agentic/webscrape': 'Web scrape component and engines',
    'lib/agentic/websearch': 'Web search component and engines',
    'lib/agentic/browser': 'Browser component and engines',
};

const toPosix = (p) => p.split(sep).join('/');
const relFromRoot = (abs) => toPosix(relative(ROOT, abs));
const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) out.push(...walk(abs));
        else if (name.endsWith('.mjs')) out.push(abs);
    }
    return out.sort();
}

function areaOf(abs) {
    const parts = toPosix(relative(LIB_DIR, abs)).split('/');
    return parts.length === 1 ? 'root' : parts[0];
}

function resolveImport({ fromAbs, spec } = {}) {
    if (typeof spec !== 'string' || !spec.startsWith('.')) return null;
    const abs = resolve(dirname(fromAbs), spec);
    return existsSync(abs) ? abs : null;
}

function mdCode(s) {
    s = String(s ?? '');
    const runs = s.match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(1, ...runs.map((r) => r.length + 1)));
    const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
    return fence + pad + s + pad + fence;
}

const mdEscape = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const row = (cells) => '| ' + cells.join(' | ') + ' |';
const head = (cells) => row(cells) + '\n' + row(cells.map(() => '---'));

function extractRole(src) {
    const block = src.match(/\/\*\*[\s\S]*?\*\//);
    if (!block) return '';
    const body = block[0].replace(/^\/\*\*/, '').replace(/\*\/$/, '');
    const lines = body.split('\n').map((l) => l.replace(/^\s*\* ?/, '').trim());
    const idx = lines.findIndex((l) => l.startsWith('@file'));
    let role = '';
    if (idx !== -1) {
        const parts = [lines[idx].replace(/^@file\s+/, '')];
        for (let i = idx + 1; i < lines.length && !lines[i].startsWith('@'); i++) {
            if (!lines[i]) break;
            parts.push(lines[i]);
        }
        role = collapse(parts.join(' '));
    } else {
        role = lines.find((l) => l && !l.startsWith('@') && !/\.mjs$/.test(l)) || '';
        role = firstSentence(role);
    }
    role = role.replace(/\s+@version\b.*$/, '').replace(/\s*\*\/\s*$/, '').trim();
    return role.length > 110 ? role.slice(0, 110).trimEnd() + ' …' : role;
}

function cleanDoc(raw) {
    const body = raw.replace(/^\/\*\*/, '').replace(/\*\/$/, '');
    const desc = [];
    for (const rawLine of body.split('\n')) {
        const line = rawLine.replace(/^\s*\* ?/, '').trimEnd();
        if (/^\s*@/.test(line)) continue;
        desc.push(line);
    }
    return collapse(desc.join(' '));
}

function firstSentence(text) {
    if (!text) return '';
    const m = text.match(/^.*?[.!?](?=\s|$)/s);
    return (m ? m[0] : text).trim();
}

function docOf({ src, start } = {}) {
    const prefix = src.slice(0, start);
    const m = prefix.match(/(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*$/);
    if (!m || /@file\b/.test(m[1])) return '';
    return firstSentence(cleanDoc(m[1]));
}

function preview({ src, node } = {}) {
    const raw = collapse(src.slice(node.start, node.end));
    return raw.length > 60 ? raw.slice(0, 60).trimEnd() + ' …' : raw;
}

function signatureOf({ decl, src } = {}) {
    return collapse(src.slice(decl.start, decl.body.start));
}

function mkSymbol({ name, kind, signature, summary } = {}) {
    return { name, kind, signature, summary, source: null, local: null, definedIn: null };
}

function collectDeclarators({ decl, src, doc, file } = {}) {
    for (const d of decl.declarations) {
        const name = d.id.type === 'Identifier' ? d.id.name : d.id.type;
        const init = d.init;
        if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
            const body = init.body.type === 'BlockStatement' ? ' { … }' : ' => …';
            const sig = 'const ' + collapse(src.slice(d.start, init.body.start)) + body;
            file.symbols.push(mkSymbol({ name, kind: 'function', signature: sig, summary: doc }));
        } else if (init) {
            file.symbols.push(mkSymbol({ name, kind: 'const', signature: 'const ' + name + ' = ' + preview({ src, node: init }), summary: doc }));
        } else {
            file.symbols.push(mkSymbol({ name, kind: 'const', signature: 'const ' + name, summary: doc }));
        }
    }
}

function handleExport({ node, src, abs, file, importMap, declMap } = {}) {
    if (node.type === 'ExportNamedDeclaration') {
        const doc = docOf({ src, start: node.start });
        const decl = node.declaration;
        if (decl && decl.type === 'FunctionDeclaration') {
            file.symbols.push(mkSymbol({ name: decl.id ? decl.id.name : 'default', kind: 'function', signature: signatureOf({ decl, src }), summary: doc }));
        } else if (decl && decl.type === 'ClassDeclaration') {
            const name = decl.id ? decl.id.name : 'default';
            file.symbols.push(mkSymbol({ name, kind: name.endsWith('Error') ? 'error class' : 'class', signature: signatureOf({ decl, src }), summary: doc }));
        } else if (decl && decl.type === 'VariableDeclaration') {
            collectDeclarators({ decl, src, doc, file });
        } else {
            for (const spec of node.specifiers) {
                const local = spec.local.name;
                if (node.source || importMap.has(local)) {
                    const symbol = mkSymbol({ name: spec.exported.name, kind: 're-export', signature: '', summary: '' });
                    symbol.local = local;
                    symbol.source = node.source ? resolveImport({ fromAbs: abs, spec: node.source.value }) : importMap.get(local);
                    file.symbols.push(symbol);
                } else {
                    const decl = declMap.get(local);
                    file.symbols.push(decl
                        ? mkSymbol({ name: spec.exported.name, kind: decl.kind, signature: decl.signature, summary: decl.summary })
                        : mkSymbol({ name: spec.exported.name, kind: 'export', signature: '', summary: '' }));
                }
            }
        }
    } else if (node.type === 'ExportDefaultDeclaration') {
        file.symbols.push(mkSymbol({ name: 'default', kind: 'default', signature: '', summary: docOf({ src, start: node.start }) }));
    } else if (node.type === 'ExportAllDeclaration') {
        const target = resolveImport({ fromAbs: abs, spec: node.source.value });
        const symbol = mkSymbol({ name: '*', kind: 'barrel', signature: '', summary: 'Re-exports every symbol from the target module' });
        symbol.source = target;
        file.symbols.push(symbol);
    }
}

function collectDeclarations({ ast, src } = {}) {
    const map = new Map();
    const add = ({ name, kind, signature, summary } = {}) => {
        if (name && !map.has(name)) map.set(name, { name, kind, signature, summary });
    };
    for (const node of ast.body) {
        const nodes = node.declaration ? [node.declaration] : [node];
        for (const decl of nodes) {
            if (decl.type === 'FunctionDeclaration' && decl.id) {
                add({ name: decl.id.name, kind: 'function', signature: signatureOf({ decl, src }), summary: docOf({ src, start: node.start }) });
            } else if (decl.type === 'ClassDeclaration' && decl.id) {
                add({ name: decl.id.name, kind: decl.id.name.endsWith('Error') ? 'error class' : 'class', signature: signatureOf({ decl, src }), summary: docOf({ src, start: node.start }) });
            } else if (decl.type === 'VariableDeclaration') {
                const doc = docOf({ src, start: node.start });
                for (const v of decl.declarations) {
                    if (v.id.type !== 'Identifier') continue;
                    const init = v.init;
                    if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
                        const body = init.body.type === 'BlockStatement' ? ' { … }' : ' => …';
                        add({ name: v.id.name, kind: 'function', signature: 'const ' + collapse(src.slice(v.start, init.body.start)) + body, summary: doc });
                    } else if (init) {
                        add({ name: v.id.name, kind: 'const', signature: 'const ' + v.id.name + ' = ' + preview({ src, node: init }), summary: doc });
                    } else {
                        add({ name: v.id.name, kind: 'const', signature: 'const ' + v.id.name, summary: doc });
                    }
                }
            }
        }
    }
    return map;
}

/**
 * Counts unmatched `{` in a type expression.
 * @param {{ text: string }} arg0
 * @returns {number}
 */
function braceBalance({ text }) {
    let depth = 0;
    for (const ch of text) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
    }
    return depth;
}

/**
 * Extracts every `@typedef` in a source file. A structural typedef is
 * routinely written across lines (`@typedef {{ … }} Name`); the continuation
 * lines are joined until the braces balance, otherwise the table would show
 * `{{` as the type and no name.
 * @param {{ src: string }} arg0
 * @returns {Array<{ name: string, type: string }>}
 */
export function extractTypedefs({ src } = {}) {
    const out = [];
    const re = /\/\*\*(?:(?!\*\/)[\s\S])*\*\//g;
    let m;
    while ((m = re.exec(src))) {
        if (!/@typedef\b/.test(m[0])) continue;
        const body = m[0].replace(/^\/\*\*/, '').replace(/\*\/$/, '');
        const lines = body.split('\n').map((rawLine) => rawLine.replace(/^\s*\* ?/, '').trim());
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].match(/^@typedef\s+([\s\S]+)$/);
            if (!t) continue;
            let rest = t[1];
            let j = i;
            while (braceBalance({ text: rest }) > 0 && j + 1 < lines.length) {
                j++;
                rest += ` ${lines[j]}`;
            }
            rest = rest.replace(/\*\/\s*$/, '').trim();
            const nm = rest.match(/^([\s\S]+?)\s+([A-Za-z_$][\w$]*)$/);
            if (nm) out.push({ name: nm[2], type: nm[1].replace(/\s+/g, ' ') });
            else out.push({ name: rest, type: '' });
            i = j;
        }
    }
    return out;
}

function collectFile(abs) {
    const src = readFileSync(abs, 'utf8');
    const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    const file = {
        abs,
        rel: relFromRoot(abs),
        area: areaOf(abs),
        role: extractRole(src),
        symbols: [],
        typedefs: extractTypedefs({ src }),
    };
    const importMap = new Map();
    for (const node of ast.body) {
        if (node.type !== 'ImportDeclaration' || !node.source) continue;
        const target = resolveImport({ fromAbs: abs, spec: node.source.value });
        for (const spec of node.specifiers) importMap.set(spec.local.name, target);
    }
    const declMap = collectDeclarations({ ast, src });
    for (const node of ast.body) handleExport({ node, src, abs, file, importMap, declMap });
    return { file, ast };
}

function collectEdges(parsed) {
    const edges = new Map();
    for (const { file, ast } of parsed) {
        for (const node of ast.body) {
            const target = node.source ? resolveImport({ fromAbs: file.abs, spec: node.source.value }) : null;
            if (!target) continue;
            const to = areaOf(target);
            if (to === file.area) continue;
            const key = `${file.area} → ${to}`;
            edges.set(key, (edges.get(key) || 0) + 1);
        }
    }
    return [...edges.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function annotateReExports(parsed) {
    const direct = new Map();
    const named = new Map();
    const stars = new Map();
    for (const { file } of parsed) {
        const own = new Map();
        const namedMap = new Map();
        const starTargets = [];
        for (const s of file.symbols) {
            if (!s.source) own.set(s.name, s);
            else if (s.name === '*') starTargets.push(relFromRoot(s.source));
            else namedMap.set(s.name, { targetRel: relFromRoot(s.source), local: s.local });
        }
        direct.set(file.rel, own);
        named.set(file.rel, namedMap);
        stars.set(file.rel, starTargets);
    }
    const cache = new Map();
    const resolveIn = ({ rel, name, seen } = {}) => {
        const key = `${rel}::${name}`;
        if (cache.has(key)) return cache.get(key);
        if (seen.has(key)) return null;
        seen.add(key);
        let found = direct.get(rel)?.get(name) || null;
        const link = named.get(rel)?.get(name);
        if (!found && link) found = resolveIn({ rel: link.targetRel, name: link.local, seen });
        if (!found) {
            for (const target of stars.get(rel) || []) {
                found = resolveIn({ rel: target, name, seen });
                if (found) break;
            }
        }
        cache.set(key, found);
        return found;
    };
    for (const { file } of parsed) {
        for (const s of file.symbols) {
            if (!s.source) continue;
            s.definedIn = relFromRoot(s.source);
            if (s.name === '*') continue;
            const target = resolveIn({ rel: s.definedIn, name: s.local, seen: new Set() });
            if (target) {
                s.kind = target.kind;
                s.signature = target.signature;
                s.summary = target.summary;
            }
        }
    }
}

function renderTree({ node, prefix, relDir, lines, roleByRel } = {}) {
    const entries = [];
    for (const [name, child] of node.dirs) entries.push({ kind: 'dir', name, child });
    for (const name of node.files) entries.push({ kind: 'file', name });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    entries.forEach((entry, i) => {
        const last = i === entries.length - 1;
        const branch = last ? '└── ' : '├── ';
        if (entry.kind === 'dir') {
            const note = DIR_NOTES[`${relDir}/${entry.name}`];
            lines.push(prefix + branch + entry.name + '/' + (note ? ' — ' + note : ''));
            renderTree({ node: entry.child, prefix: prefix + (last ? '    ' : '│   '), relDir: `${relDir}/${entry.name}`, lines, roleByRel });
        } else {
            const role = roleByRel.get(`${relDir}/${entry.name}`);
            lines.push(prefix + branch + entry.name + (role ? ' — ' + role : ''));
        }
    });
}

function buildTree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
        const parts = f.rel.replace(/^lib\//, '').split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
            node = node.dirs.get(parts[i]);
        }
        node.files.push(parts[parts.length - 1]);
    }
    return root;
}

function symbolTable(symbols) {
    let md = head(['Symbol', 'Kind', 'Signature / Source', 'Summary']) + '\n';
    for (const s of symbols) {
        const sig = s.source ? '↩ ' + mdCode(s.definedIn || '') : mdCode(mdEscape(s.signature || ''));
        md += row([mdCode(s.name), mdEscape(s.kind), sig, mdEscape(s.summary)]) + '\n';
    }
    return md;
}

function render() {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const parsed = walk(LIB_DIR).map(collectFile);
    annotateReExports(parsed);
    const files = parsed.map((p) => p.file);
    for (const f of files) {
        f.declared = f.symbols.filter((s) => !s.source).length;
        f.reexported = f.symbols.filter((s) => s.source && s.name !== '*').length;
    }

    let md = '<!-- GENERATED FILE — do not edit by hand. Run `pnpm build:structure` to regenerate. -->\n\n';
    md += `# Merci SDK v${pkg.version} — Library Structure & Symbols\n\n`;
    md += '> Structural reference: the `lib/` file tree and the symbols each module exports.\n';
    md += '> Generated from the current source by `scripts/build-structure.mjs`.\n\n';
    md += `- **Version:** ${pkg.version}\n`;
    md += `- **Files:** ${files.length} \`.mjs\`\n`;
    md += `- **Exports:** ${files.reduce((n, f) => n + f.declared, 0)} declared, ${files.reduce((n, f) => n + f.reexported, 0)} re-exported\n`;
    md += `- **Types:** ${files.reduce((n, f) => n + f.typedefs.length, 0)} \`@typedef\`s\n\n`;
    md += '`Kind` is one of `class`, `error class`, `function`, `const`, `default`, `barrel` or a resolved `re-export`. ';
    md += '`↩` marks a symbol re-exported from another module.\n\n';

    md += '## 1. Entry points\n\n';
    md += head(['Import', 'Module']) + '\n';
    for (const [key, target] of Object.entries(pkg.exports || {})) {
        const spec = key === '.' ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, '')}`;
        // An export may be a bare path or a conditions object; the table
        // shows the module the consumer's resolver will load, not the object.
        const moduleTarget = typeof target === 'string'
            ? target
            : (target?.import ?? target?.require ?? target?.default ?? target?.types ?? '');
        md += row([mdCode(spec), mdCode(moduleTarget)]) + '\n';
    }
    md += '\n';

    md += '## 2. `lib/` tree\n\n```text\n';
    const treeLines = ['lib/'];
    const roleByRel = new Map(files.map((f) => [f.rel, f.role]));
    renderTree({ node: buildTree(files), prefix: '', relDir: 'lib', lines: treeLines, roleByRel });
    md += treeLines.join('\n') + '\n```\n\n';

    md += '## 3. Areas at a glance\n\n';
    md += head(['Area', 'Files', 'Declared', 'Re-exported', 'Types', 'Responsibility']) + '\n';
    for (const [area, note] of AREA_INFO) {
        const group = files.filter((f) => f.area === area);
        if (!group.length) continue;
        md += row([
            mdCode(area),
            group.length,
            group.reduce((n, f) => n + f.declared, 0),
            group.reduce((n, f) => n + f.reexported, 0),
            group.reduce((n, f) => n + f.typedefs.length, 0),
            mdEscape(note),
        ]) + '\n';
    }
    md += '\n';

    md += '## 4. Symbols by area\n\n';
    for (const [area, note] of AREA_INFO) {
        const group = files.filter((f) => f.area === area);
        if (!group.length) continue;
        md += `### 4.${AREA_INFO.findIndex(([a]) => a === area) + 1} \`${area}\` — ${note}\n\n`;
        for (const f of group) {
            md += `#### ${mdCode(f.rel)}${f.role ? ` — ${f.role}` : ''}\n\n`;
            md += f.symbols.length ? symbolTable(f.symbols) + '\n' : '_No exports._\n\n';
        }
    }

    const publicFile = files.find((f) => f.rel === 'lib/index.mjs');
    md += '## 5. Public API surface\n\n';
    md += "Everything importable from the package entry point (`lib/index.mjs`):\n\n";
    md += publicFile ? symbolTable(publicFile.symbols) + '\n' : '_Entry point not found._\n\n';

    md += '## 6. Types (`@typedef`)\n\n';
    let anyTypes = false;
    for (const [area] of AREA_INFO) {
        const group = files.filter((f) => f.area === area && f.typedefs.length);
        if (!group.length) continue;
        anyTypes = true;
        md += `### \`${area}\`\n\n`;
        md += head(['Type', 'Definition', 'Defined in']) + '\n';
        for (const f of group) {
            for (const t of f.typedefs) md += row([mdCode(t.name), mdCode(mdEscape(t.type)), mdCode(f.rel)]) + '\n';
        }
        md += '\n';
    }
    if (!anyTypes) md += '_None._\n\n';

    md += '## 7. Cross-area imports\n\n';
    md += 'Counts of relative import/re-export specifiers between top-level areas. ';
    md += 'This is an import graph, **not** a strict layering — cycles exist (e.g. `agentic ↔ tools`).\n\n';
    md += head(['From → To', 'Imports']) + '\n';
    for (const [key, count] of collectEdges(parsed)) md += row([mdCode(key), count]) + '\n';
    md += '\n';

    md += '## 8. Regeneration\n\n```bash\npnpm build:structure\n```\n';

    return md;
}

// Written ONLY when this module is the CLI: a test imports `extractTypedefs`,
// and a check must not rewrite the artifact it checks.
/**
 * `argv[1]` may be a symlinked or vanished path; compare real paths without throwing.
 * @type {(p: string) => string}
 */
const canonical = (p) => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };

const isCli = Boolean(process.argv[1]) && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url));
if (isCli) {
    writeFileSync(OUT_FILE, render(), 'utf8');
    console.log(`wrote ${relFromRoot(OUT_FILE)}`);
}
