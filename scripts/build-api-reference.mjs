// @ts-check


/**
 * @file Generates the export-surface block of docs/api_reference.html from the built TypeScript declarations.
 * @version 0.7.2
 *
 * The API reference is generated, not hand-written. The export names, the
 * module each export is declared in, the declared signature and the one-line
 * summary all come from the declarations `pnpm run build:types` emits into
 * `dist/types/lib/**\/*.d.mts` — never from a hand-kept list.
 *
 * Usage:
 *   node scripts/build-api-reference.mjs           # rewrite the generated block
 *   node scripts/build-api-reference.mjs --check   # exit 1 when the block is stale
 *
 * Exit 1 when `dist/types` is missing, when the block markers are absent, or
 * when `--check` finds a difference between the committed and the generated block.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DOC_REL = 'docs/api_reference.html';
const TYPES_REL = 'dist/types';
const START_MARKER = '<!-- api-reference:generated:start -->';
const END_MARKER = '<!-- api-reference:generated:end -->';
const MAX_SIGNATURE = 220;
const MAX_SUMMARY = 240;

/**
 * @typedef {Object} Decl
 * @property {string} signature - The declared signature, whitespace-collapsed.
 * @property {string} summary - The one-line summary from the JSDoc description.
 *
 * @typedef {Object} ApiEntry
 * @property {string} name - The exported name.
 * @property {string} module - The module the export is declared in.
 * @property {string} signature - The declared signature.
 * @property {string} summary - The one-line summary.
 *
 * @typedef {Object} ApiGroup
 * @property {string} spec - The import specifier ('merci-sdk', 'merci-sdk/tools', …).
 * @property {boolean} main - True for the package entry.
 * @property {ApiEntry[]} entries - The exports of that entry point.
 *
 * @typedef {Object} ApiModel
 * @property {ApiGroup[]} groups - One group per entry point.
 *
 * @typedef {Object} FileModel
 * @property {string} rel - Path under dist/types/lib.
 * @property {Map<string, Decl>} declared - Locally declared exports.
 * @property {Map<string, {source: string, local: string}>} reexport - `export { a } from './x.mjs'`.
 * @property {string[]} star - `export * from './x.mjs'` targets.
 * @property {Map<string, string>} localExport - `export { a };` — exported name to local name.
 * @property {Map<string, string>} importMap - Local binding to the module it came from.
 */

/** @param {string} p */
const toPosix = (p) => p.split(sep).join('/');
/** @param {string} s */
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** @param {string} s */
const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** @param {{ a: string, b: string }} arg0 */
const byName = ({ a, b }) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
};
/** @param {string} p */
const posixDir = (p) => {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
};
/** @param {{ dir: string, rel: string }} arg0 */
const posixJoin = ({ dir, rel }) => {
    /** @type {string[]} */
    const out = [];
    for (const part of (dir ? dir.split('/') : []).concat(rel.split('/'))) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return out.join('/');
};

/**
 * Finds the index of the bracket that closes the one at `start`, skipping strings.
 * @param {{ text: string, start: number }} arg0
 * @returns {number} The closing index, or -1.
 */
function matchBracket({ text, start }) {
    const open = text[start];
    const close = open === '{' ? '}' : open === '(' ? ')' : ']';
    let depth = 0;
    let i = start;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            i += 1;
            while (i < text.length && text[i] !== ch) i += text[i] === '\\' ? 2 : 1;
            i += 1;
            continue;
        }
        if (ch === open) depth += 1;
        else if (ch === close) {
            depth -= 1;
            if (depth === 0) return i;
        }
        i += 1;
    }
    return -1;
}

/**
 * Splits a declaration file into top-level statements, each with the JSDoc block that precedes it.
 * @param {string} src
 * @returns {Array<{text: string, jsdoc: string}>}
 */
function scanStatements(src) {
    /** @type {Array<{text: string, jsdoc: string}>} */
    const out = [];
    let buf = '';
    let depth = 0;
    let jsdoc = '';
    let i = 0;
    const push = () => {
        const text = buf.trim();
        const doc = jsdoc;
        buf = '';
        jsdoc = '';
        if (text) out.push({ text, jsdoc: doc });
    };
    while (i < src.length) {
        const ch = src[i];
        if (ch === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i += 1;
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end === -1 ? src.length : end + 2;
            if (depth === 0 && buf.trim() === '') {
                const block = src.slice(i, stop);
                jsdoc = block.startsWith('/**') ? block : '';
            }
            i = stop;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (src[j] === ch) {
                    j += 1;
                    break;
                }
                j += 1;
            }
            buf += src.slice(i, j);
            i = j;
            continue;
        }
        if (ch === '{' || ch === '(' || ch === '[') {
            depth += 1;
            buf += ch;
            i += 1;
            continue;
        }
        if (ch === '}' || ch === ')' || ch === ']') {
            depth -= 1;
            buf += ch;
            i += 1;
            if (ch === '}' && depth === 0) {
                let k = i;
                while (k < src.length && /\s/.test(src[k])) k += 1;
                if (src[k] === ';') {
                    buf += ';';
                    i = k + 1;
                    push();
                } else if (/^(?:export\s+declare\s+)?(?:abstract\s+)?(?:class|interface|namespace|enum)\b/.test(buf.trim())) {
                    push();
                }
            }
            continue;
        }
        if (ch === ';' && depth === 0) {
            buf += ch;
            i += 1;
            push();
            continue;
        }
        buf += ch;
        i += 1;
    }
    push();
    return out;
}

/**
 * Extracts the one-line summary from a JSDoc block: the first sentence of its description.
 * The description's first physical line often ends mid-sentence (the sources wrap
 * at ~80 columns), so the first complete sentence is used instead.
 * @param {string} jsdoc
 * @returns {string}
 */
function summaryOf(jsdoc) {
    if (!jsdoc) return '';
    const body = jsdoc.replace(/^\/\*\*/, '').replace(/\*\/$/, '');
    /** @type {string[]} */
    const desc = [];
    for (const raw of body.split('\n')) {
        const line = raw.replace(/^\s*\* ?/, '').trim();
        if (line.startsWith('@')) break;
        desc.push(line);
    }
    while (desc.length && !desc[0]) desc.shift();
    const text = collapse(desc.join(' '));
    if (!text) return '';
    const sentence = firstSentence(text);
    return sentence.length > MAX_SUMMARY ? sentence.slice(0, MAX_SUMMARY).trimEnd() + '…' : sentence;
}

/**
 * Cuts the first complete sentence out of a text.
 * @param {string} text
 * @returns {string}
 */
function firstSentence(text) {
    const re = /([A-Za-z0-9_"')\]])\.(\s|$)/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const head = text.slice(0, match.index + 2);
        const word = text.slice(0, match.index + 1).match(/([A-Za-z0-9_"')\]]+)$/);
        if (!word) continue;
        const token = word[1];
        if (token.length >= 3 || /^\d+$/.test(token)) return head;
    }
    return text;
}

/**
 * Renders the parameter list of a function declaration.
 * @param {string} params - The raw text between the parentheses.
 * @returns {string}
 */
function renderParams(params) {
    const text = collapse(params);
    if (!text.startsWith('{')) return text;
    const end = matchBracket({ text, start: 0 });
    if (end === -1) return text;
    const after = text.slice(end + 1).trim();
    if (after === '' || after.startsWith(':') || after.startsWith('?')) return text.slice(0, end + 1);
    return text;
}

/**
 * Derives the display signature of a declaration statement.
 * @param {{ text: string, kind: string }} arg0 - The statement text and its kind ('function' | 'class' | 'const').
 * @returns {string}
 */
function signatureOf({ text, kind }) {
    if (kind === 'class') {
        const m = text.match(/^export\s+declare\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([\w$.]+))?/);
        if (!m) return '';
        return m[2] ? `class ${m[1]} extends ${m[2]}` : `class ${m[1]}`;
    }
    const prefix = kind === 'function' ? 'export declare function ' : 'export declare const ';
    if (!text.startsWith(prefix)) return '';
    let body = text.slice(prefix.length).replace(/;\s*$/, '');
    if (kind === 'function') {
        const open = body.indexOf('(');
        if (open !== -1) {
            const close = matchBracket({ text: body, start: open });
            if (close !== -1) {
                body = body.slice(0, open + 1) + renderParams(body.slice(open + 1, close)) + body.slice(close);
            }
        }
    }
    const signature = collapse(body);
    return signature.length > MAX_SIGNATURE ? signature.slice(0, MAX_SIGNATURE).trimEnd() + '…' : signature;
}

/**
 * Parses the specifier list of an import/export clause.
 * @param {string} inner
 * @returns {Array<{typeOnly: boolean, local: string, exported: string}>}
 */
function parseSpecifiers(inner) {
    /** @type {Array<{typeOnly: boolean, local: string, exported: string}>} */
    const out = [];
    for (const raw of inner.split(',')) {
        const spec = raw.trim();
        if (!spec) continue;
        const m = spec.match(/^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!m) continue;
        out.push({ typeOnly: Boolean(m[1]), local: m[2], exported: m[3] || m[2] });
    }
    return out;
}

/**
 * Maps a relative module specifier from a declaration file to its file under dist/types/lib.
 * @param {{ fromRel: string, spec: string }} arg0
 * @returns {string}
 */
function resolveSource({ fromRel, spec }) {
    if (!spec.startsWith('.')) return '';
    return posixJoin({ dir: posixDir(fromRel), rel: spec }).replace(/\.(mjs|js|mts|ts)$/, '.d.mts');
}

/**
 * Parses one declaration file into its export model.
 * @param {{ rel: string, abs: string }} arg0 - Path under dist/types/lib and the absolute path on disk.
 * @returns {FileModel}
 */
function parseFile({ rel, abs }) {
    const src = readFileSync(abs, 'utf8');
    /** @type {FileModel} */
    const model = {
        rel,
        declared: new Map(),
        reexport: new Map(),
        star: [],
        localExport: new Map(),
        importMap: new Map(),
    };
    for (const { text, jsdoc } of scanStatements(src)) {
        if (/^export\s+type\s/.test(text)) continue;
        if (/^export\s*\*/.test(text)) {
            const m = text.match(/^export\s*\*\s*from\s*['"]([^'"]+)['"]/);
            if (m) {
                const source = resolveSource({ fromRel: rel, spec: m[1] });
                if (source) model.star.push(source);
            }
            continue;
        }
        if (/^export\s*\{/.test(text)) {
            const withFrom = text.match(/^export\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/);
            if (withFrom) {
                const source = resolveSource({ fromRel: rel, spec: withFrom[2] });
                for (const spec of parseSpecifiers(withFrom[1])) {
                    if (spec.typeOnly || !source) continue;
                    model.reexport.set(spec.exported, { source, local: spec.local });
                }
                continue;
            }
            const bare = text.match(/^export\s*\{([\s\S]*?)\}\s*;?$/);
            if (bare) {
                for (const spec of parseSpecifiers(bare[1])) {
                    if (spec.typeOnly) continue;
                    model.localExport.set(spec.exported, spec.local);
                }
            }
            continue;
        }
        if (/^export\s+declare\s+(?:async\s+)?function\s/.test(text)) {
            const m = text.match(/^export\s+declare\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
            if (m) {
                model.declared.set(m[1], {
                    signature: signatureOf({ text, kind: 'function' }),
                    summary: summaryOf(jsdoc),
                });
            }
            continue;
        }
        if (/^export\s+declare\s+(?:abstract\s+)?class\s/.test(text)) {
            const m = text.match(/^export\s+declare\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
            if (m) {
                model.declared.set(m[1], {
                    signature: signatureOf({ text, kind: 'class' }),
                    summary: summaryOf(jsdoc),
                });
            }
            continue;
        }
        if (/^export\s+declare\s+(?:const|let|var)\s/.test(text)) {
            const m = text.match(/^export\s+declare\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
            if (m) {
                model.declared.set(m[1], {
                    signature: signatureOf({ text, kind: 'const' }),
                    summary: summaryOf(jsdoc),
                });
            }
            continue;
        }
        if (/^import\s/.test(text)) {
            if (/^import\s+type\s/.test(text)) continue;
            const named = text.match(/^import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/);
            if (named) {
                const source = resolveSource({ fromRel: rel, spec: named[2] });
                if (!source) continue;
                for (const spec of parseSpecifiers(named[1])) {
                    if (spec.typeOnly) continue;
                    model.importMap.set(spec.local, source);
                }
                continue;
            }
            const def = text.match(/^import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/);
            if (def) {
                const source = resolveSource({ fromRel: rel, spec: def[2] });
                if (source) model.importMap.set(def[1], source);
            }
        }
    }
    return model;
}

/**
 * Resolves an exported name to the declaration that defines it.
 * @param {{ files: Map<string, FileModel>, rel: string, name: string, seen: Set<string> }} arg0 -
 *   the file map, the file the name is exported from, the exported name, and the cycle guard.
 * @returns {{decl: Decl, module: string} | null}
 */
function resolveExport({ files, rel, name, seen }) {
    const key = `${rel}::${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const file = files.get(rel);
    if (!file) return null;
    const declared = file.declared.get(name);
    if (declared) return { decl: declared, module: moduleLabel(rel) };
    const reexport = file.reexport.get(name);
    if (reexport) return resolveExport({ files, rel: reexport.source, name: reexport.local, seen });
    const local = file.localExport.get(name);
    if (local) {
        const source = file.importMap.get(local);
        if (source) return resolveExport({ files, rel: source, name: local, seen });
        const own = file.declared.get(local);
        if (own) return { decl: own, module: moduleLabel(rel) };
    }
    for (const source of file.star) {
        const found = resolveExport({ files, rel: source, name, seen });
        if (found) return found;
    }
    return null;
}

/**
 * The module label of a declaration file ('lib/support/utils.mjs').
 * @param {string} rel
 * @returns {string}
 */
function moduleLabel(rel) {
    return `lib/${rel.replace(/\.d\.mts$/, '.mjs')}`;
}

/**
 * The runtime export names of a declaration file (type-only exports excluded).
 * @param {{ files: Map<string, FileModel>, file: FileModel, seen?: Set<string> }} arg0 -
 *   the file map, the declaration file, and the cycle guard.
 * @returns {string[]}
 */
function exportedNames({ files, file, seen = new Set() }) {
    if (seen.has(file.rel)) return [];
    seen.add(file.rel);
    /** @type {Set<string>} */
    const names = new Set();
    for (const name of file.declared.keys()) names.add(name);
    for (const name of file.reexport.keys()) names.add(name);
    for (const name of file.localExport.keys()) names.add(name);
    for (const source of file.star) {
        const target = files.get(source);
        if (!target) continue;
        for (const name of exportedNames({ files, file: target, seen })) names.add(name);
    }
    return [...names].sort((a, b) => byName({ a, b }));
}

/**
 * Lists the entry points of the package and the declaration file behind each.
 * @param {string} root
 * @returns {Array<{spec: string, abs: string, main: boolean}>}
 */
function readEntryPoints(root) {
    /** @type {any} */
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    /** @type {Array<{spec: string, abs: string, main: boolean}>} */
    const out = [];
    for (const [key, value] of Object.entries(pkg.exports || {})) {
        if (!value || typeof value !== 'object') continue;
        const types = value.types;
        if (typeof types !== 'string') continue;
        out.push({
            spec: key === '.' ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, '')}`,
            abs: resolve(root, types),
            main: key === '.',
        });
    }
    out.sort((a, b) => (a.main === b.main ? byName({ a: a.spec, b: b.spec }) : (a.main ? -1 : 1)));
    return out;
}

/**
 * Builds the API reference model from the built declarations.
 * @param {{ root?: string }} [args] - Options.
 * @returns {ApiModel}
 */
function buildApiModel({ root = ROOT } = {}) {
    const typesRoot = join(root, TYPES_REL);
    if (!existsSync(typesRoot)) {
        throw new Error(`${TYPES_REL} is missing — run \`pnpm run build:types\` first.`);
    }
    const libTypes = join(typesRoot, 'lib');
    /** @type {Map<string, FileModel>} */
    const files = new Map();
    /** @param {string} dir */
    const walk = (dir) => {
        for (const name of readdirSync(dir).sort()) {
            const abs = join(dir, name);
            if (statSync(abs).isDirectory()) walk(abs);
            else if (name.endsWith('.d.mts')) {
                const rel = toPosix(relative(libTypes, abs));
                files.set(rel, parseFile({ rel, abs }));
            }
        }
    };
    if (existsSync(libTypes)) walk(libTypes);

    /** @type {ApiGroup[]} */
    const groups = [];
    for (const entry of readEntryPoints(root)) {
        const rel = toPosix(relative(libTypes, entry.abs));
        const file = files.get(rel);
        if (!file) continue;
        /** @type {ApiEntry[]} */
        const entries = [];
        for (const name of exportedNames({ files, file })) {
            const found = resolveExport({ files, rel, name, seen: new Set() });
            entries.push({
                name,
                module: found ? found.module : moduleLabel(rel),
                signature: found ? found.decl.signature : '',
                summary: found ? found.decl.summary : '',
            });
        }
        groups.push({ spec: entry.spec, main: entry.main, entries });
    }
    return { groups };
}

/**
 * Renders the generated block.
 * @param {{ model: ApiModel, indent?: string }} args - The model and the indentation of the marker line.
 * @returns {string}
 */
function renderApiBlock({ model, indent = '' }) {
    /** @type {string[]} */
    const lines = [];
    lines.push(`${indent}<!-- Generated by scripts/build-api-reference.mjs from ${TYPES_REL} — do not edit by hand. Run \`pnpm run docs:api-reference\`. -->`);
    for (const group of model.groups) {
        const heading = group.main ? 'Every named export of' : 'Named exports of';
        lines.push(`${indent}<div class="api-card">`);
        lines.push(`${indent}    <h3 class="font-bold text-[var(--text-primary)] !mt-0">${heading} <code class="inline">${escapeHtml(group.spec)}</code>${group.main ? ' (main entry)' : ''}</h3>`);
        // The export filter (wired by the inline script at the page end) narrows the
        // chips and the table on the main entry.
        if (group.main) lines.push(`${indent}    <input id="export-filter" class="search-input" style="display:block;width:100%;max-width:320px;margin-top:8px;padding:0.375rem 0.75rem;border-radius:0.5rem;font-size:0.8125rem" placeholder="Filter exports… (e.g. withBudget)" aria-label="Filter exports"/>`);
        lines.push(`${indent}    <div class="space-y-4 mt-4 text-sm text-[var(--text-secondary)]">`);
        lines.push(`${indent}        <div class="export-chips">${group.entries.map((e) => `<code class="inline">${escapeHtml(e.name)}</code>`).join('')}</div>`);
        lines.push(`${indent}    </div>`);
        lines.push(`${indent}    <div class="space-y-4 mt-4 text-sm text-[var(--text-secondary)]">`);
        lines.push(`${indent}        <div class="overflow-x-auto">`);
        lines.push(`${indent}            <table class="w-full min-w-[760px] text-left table-fixed">`);
        lines.push(`${indent}                <thead>`);
        lines.push(`${indent}                    <tr class="border-b border-[var(--border-color)]">`);
        lines.push(`${indent}                        <th class="w-[16%] py-2 pr-4 font-bold text-[var(--text-primary)]">Export</th>`);
        lines.push(`${indent}                        <th class="w-[20%] py-2 pr-4 font-bold text-[var(--text-primary)]">Module</th>`);
        lines.push(`${indent}                        <th class="w-[34%] py-2 pr-4 font-bold text-[var(--text-primary)]">Signature</th>`);
        lines.push(`${indent}                        <th class="w-[30%] py-2 font-bold text-[var(--text-primary)]">Summary</th>`);
        lines.push(`${indent}                    </tr>`);
        lines.push(`${indent}                </thead>`);
        lines.push(`${indent}                <tbody>`);
        for (const entry of group.entries) {
            lines.push(`${indent}                    <tr class="border-b border-[var(--border-color)]/60 align-top">`);
            lines.push(`${indent}                        <td class="py-1 pr-4 font-mono font-bold text-[var(--primary-color)] break-words">${escapeHtml(entry.name)}</td>`);
            lines.push(`${indent}                        <td class="py-1 pr-4 font-mono text-xs text-[var(--text-secondary)] break-words">${escapeHtml(entry.module)}</td>`);
            lines.push(`${indent}                        <td class="py-1 pr-4 font-mono text-xs text-[var(--text-primary)] break-words">${escapeHtml(entry.signature)}</td>`);
            lines.push(`${indent}                        <td class="py-1 text-sm">${entry.summary ? escapeHtml(entry.summary) : '—'}</td>`);
            lines.push(`${indent}                    </tr>`);
        }
        lines.push(`${indent}                </tbody>`);
        lines.push(`${indent}            </table>`);
        lines.push(`${indent}        </div>`);
        lines.push(`${indent}    </div>`);
        lines.push(`${indent}</div>`);
    }
    return lines.join('\n');
}

/**
 * Splits a document around the generated block.
 * @param {{ document: string }} args
 * @returns {{ before: string, block: string, after: string, indent: string, endIndent: string }}
 */
export function splitGeneratedBlock({ document }) {
    const start = document.indexOf(START_MARKER);
    const end = document.indexOf(END_MARKER);
    if (start === -1 || end === -1 || end < start) {
        throw new Error(`${DOC_REL} has no ${START_MARKER} / ${END_MARKER} markers — refusing to guess where the generated block belongs.`);
    }
    const startLine = document.lastIndexOf('\n', start) + 1;
    const endLine = document.lastIndexOf('\n', end) + 1;
    const indent = document.slice(startLine, start);
    const endIndent = document.slice(endLine, end);
    const raw = document.slice(start + START_MARKER.length, end);
    return {
        before: document.slice(0, start + START_MARKER.length),
        block: raw.replace(/^\n/, '').replace(/\n[ \t]*$/, ''),
        after: document.slice(end),
        indent,
        endIndent,
    };
}

/**
 * Replaces the generated block in a document.
 * @param {{ document: string, block: string }} args
 * @returns {string}
 */
function applyGeneratedBlock({ document, block }) {
    const split = splitGeneratedBlock({ document });
    return `${split.before}\n${block}\n${split.endIndent}${split.after}`;
}

/**
 * Generates the API reference block from the built declarations.
 * @param {{ root?: string }} [args] - Options.
 * @returns {{ model: ApiModel, block: string, document: string }}
 */
export function generateApiReference({ root = ROOT } = {}) {
    const model = buildApiModel({ root });
    const document = readFileSync(join(root, DOC_REL), 'utf8');
    const split = splitGeneratedBlock({ document });
    const block = renderApiBlock({ model, indent: split.indent });
    return { model, block, document: applyGeneratedBlock({ document, block }) };
}

/**
 * Reports the first difference between the committed block and the generated one.
 * @param {{ committed: string, generated: string }} args
 * @returns {string} A human-readable difference, or '' when they match.
 */
function describeDifference({ committed, generated }) {
    if (committed === generated) return '';
    const a = committed.split('\n');
    const b = generated.split('\n');
    const limit = Math.max(a.length, b.length);
    for (let i = 0; i < limit; i += 1) {
        if (a[i] !== b[i]) {
            return `first difference at line ${i + 1} of the generated block\n    committed: ${shorten(a[i])}\n    generated: ${shorten(b[i])}`;
        }
    }
    return 'the committed and generated blocks differ in length only';
}

/**
 * Shortens a diff line so the report stays readable.
 * @param {string | undefined} line
 * @returns {string}
 */
function shorten(line) {
    if (line === undefined) return '(missing)';
    const trimmed = line.trim();
    return trimmed.length > 160 ? `${trimmed.slice(0, 160)}… (${trimmed.length} chars)` : trimmed;
}

/**
 * Runs the generator.
 * @param {string[]} argv
 * @returns {number} The exit code.
 */
function main(argv) {
    const check = argv.includes('--check');
    try {
        const { block, document } = generateApiReference({});
        const docAbs = join(ROOT, DOC_REL);
        if (check) {
            const committed = readFileSync(docAbs, 'utf8');
            const difference = describeDifference({
                committed: splitGeneratedBlock({ document: committed }).block,
                generated: block,
            });
            if (difference) {
                process.stderr.write(`api reference drift — ${DOC_REL} is stale.\n  ${difference}\n  run: node scripts/build-api-reference.mjs\n`);
                return 1;
            }
            process.stdout.write(`api reference is up to date — ${DOC_REL} matches ${TYPES_REL}.\n`);
            return 0;
        }
        writeFileSync(docAbs, document, 'utf8');
        process.stdout.write(`wrote ${DOC_REL} (${block.split('\n').length} generated lines).\n`);
        return 0;
    } catch (error) {
        process.stderr.write(`api reference generator failed — ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}

/**
 * `argv[1]` may be a symlinked or vanished path; compare real paths without throwing.
 * @type {(p: string) => string}
 */
const canonical = (p) => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };

const invokedDirectly = Boolean(process.argv[1]) && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
