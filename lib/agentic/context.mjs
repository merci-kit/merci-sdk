// @ts-check


/**
 * @file Auto-context sources — environment block + AGENTS.md instructions.
 * @version 0.12.0
 *
 * @description
 * Two opt-in context blocks for `_prepareStepMessages`, mirroring opencode's
 * `core/environment` and `core/instructions` system-context sources (without
 * the diff/epoch machinery): a small `<env>` block and the contents of every
 * `AGENTS.md` discovered from the workspace root up to a stop directory.
 */
import { promises as fs } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { EVENTS, stampEvent } from '../core/events.mjs';
import { LIMITS } from '../core/limit-config.mjs';
/**
 * @typedef {Object} InstructionFile
 * @property {string} path
 * @property {string} content
 * @property {number} mtimeMs
 */


const SKIP_DIRS = new Set(['node_modules', '.git']);




/**
 * @typedef {Object} CachedInstructions
 * @property {Map<string, InstructionFile>} files
 * @property {string|null} rendered
 */
const _instructionCache = new Map();


/**
  * @param {{key: *, value: *}} arg0
 */
function cacheInstructions({ key, value }) {
    if (_instructionCache.size >= LIMITS.instruction_cache_max) {
        _instructionCache.delete(_instructionCache.keys().next().value);
    }
    _instructionCache.set(key, value);
}


/**
  * @param {{key: *, cached: *}} arg0
 */
function touchInstructions({ key, cached }) {
    _instructionCache.delete(key);
    _instructionCache.set(key, cached);
    return cached;
}


/**
 * Formats the current date for a model-visible prompt line. Shared by the env
 * block ('native' = Date#toDateString, byte-identical to before) and the
 * web-search context injection ('full' localized / 'iso').
 * @param {{locale?: string, timezone?: string, format?: 'native'|'full'|'iso', includeTime?: boolean, now?: Date}} arg0
 * @returns {string}
 */
export function formatPromptDate({ locale, timezone, format = 'native', includeTime = false, now = new Date() } = {}) {
    if (format === 'iso') return includeTime ? now.toISOString() : now.toISOString().slice(0, 10);
    if (format === 'full') {
        try {
            return new Intl.DateTimeFormat(locale, {
                dateStyle: 'full',
                ...(includeTime ? { timeStyle: 'short' } : {}),
                timeZone: timezone,
            }).format(now);
        } catch {   }
    }
    return includeTime ? `${now.toDateString()} ${now.toTimeString().slice(0, 5)}` : now.toDateString();
}


/**
 * Renders the environment block: working directory, git repo, platform, date.
 * @param {{root?: string}} arg0
 * @returns {Promise<string>}
 */
export async function buildEnvironmentBlock({ root = process.cwd() } = {}) {
    let git = 'no';
    try {
        await fs.access(join(root, '.git'));
        git = 'yes';
    } catch {   }
    return [
        'Here is some useful information about the environment you are running in:',
        '<env>',
        `  Working directory: ${root}`,
        `  Is directory a git repo: ${git}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${formatPromptDate()}`,
        '</env>',
    ].join('\n');
}


/**
 * Discovers and renders AGENTS.md instruction files from `root` up to `stopAt`
 * (inclusive). The nearest (root) file renders FIRST, ancestors after — root
 * reads like the workspace's own rules, ancestors as progressively higher-level
 * context.
 * Cached per (root, stopAt): each call stats the candidate files and only
 * re-reads the ones whose mtime changed, so an unchanged workspace costs a few
 * stats instead of full tree reads on every step.
 * @param {{root?: string, stopAt?: string, eventEmitter?: import('node:events').EventEmitter|null}} arg0
 * @returns {Promise<string|null>} The rendered instructions block, or null when nothing found.
 */
export async function discoverInstructions({ root = process.cwd(), stopAt = root, eventEmitter = null } = {}) {
    let rroot = root;
    let rstop = stopAt;
    try {
        rroot = await fs.realpath(root);
        rstop = await fs.realpath(stopAt);
    } catch {   }

    /** @type {string[]} */
    const targets = [];
    let current = rroot;
    for (;;) {
        if (current) targets.push(current);
        if (current === rstop) break;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }

    const boundary = rroot.startsWith(rstop === sep ? sep : `${rstop}${sep}`) ? rstop : rroot;
    const withinBoundary = (/** @type {string} */ candidate) =>
        candidate === boundary
        || candidate.startsWith(boundary === sep ? sep : `${boundary}${sep}`)
        || targets.some((t) => candidate === join(t, 'AGENTS.md') || candidate.startsWith(t === sep ? sep : `${t}${sep}`));

    const key = `${rroot}|${rstop}`;
    const cached = _instructionCache.get(key);
    const files = [];
    let changed = false;
    for (const dir of targets) {
        if (SKIP_DIRS.has(basename(dir))) continue;
        const path = join(dir, 'AGENTS.md');
        let stat = null;
        try { stat = await fs.stat(path); } catch {   }
        if (stat && (!stat.isFile() || stat.size > LIMITS.instruction_file_max_bytes)) stat = null;
        if (stat) {
            try {
                const realPath = await fs.realpath(path);
                if (!withinBoundary(realPath)) stat = null;
            } catch {
                stat = null;
            }
        }
        const prev = cached?.files.get(path);
        if (stat && prev && prev.mtimeMs === stat.mtimeMs) {
            files.push(prev);
        } else {
            changed = true;
            if (stat) {
                try {
                    const content = await fs.readFile(path, 'utf8');
                    if (content && content.trim()) {
                        const entry = { path, content, mtimeMs: stat.mtimeMs };
                        files.push(entry);
                    }
                } catch {   }
            }
        }
    }

    if (!changed) return touchInstructions({ key, cached }).rendered;
    if (files.length === 0) {
        cacheInstructions({ key, value: { files: new Map(), rendered: null } });
        return null;
    }
    const rendered = files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join('\n\n');
    if (eventEmitter && typeof eventEmitter.emit === 'function') {
        eventEmitter.emit(EVENTS.CONTEXT.INSTRUCTIONS_LOADED, stampEvent({ name: EVENTS.CONTEXT.INSTRUCTIONS_LOADED, payload: {
            root,
            stopAt,
            files: files.map((f) => f.path),
            chars: files.reduce((n, f) => n + f.content.length, 0)
        } }));
    }
    const fileMap = new Map();
    for (const f of files) fileMap.set(f.path, f);
    cacheInstructions({ key, value: { files: fileMap, rendered } });
    return rendered;
}
