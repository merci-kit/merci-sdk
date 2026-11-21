// @ts-check


/**
 * @file Built-in context tools — read / grep / glob.
 * @version 0.12.0
 *
 * @description
 * Mirrors opencode's on-demand file retrieval tools so the model can pull
 * project context without caller-supplied mocks. `createContextTools` returns
 * three tools bound to a workspace `root`:
 *
 *   read  — line-window file reads (offset/limit, per-line truncation, 50KB cap,
 *           directory listing, binary guard, did-you-mean on missing files)
 *   grep  — regex search over file contents via ripgrep (grouped, capped)
 *   glob  — file-path matching via ripgrep --files
 *
 * `grep`/`glob` shell out to the system `rg` (ripgrep). Presence is probed
 * lazily once per factory; a missing binary surfaces a clear error instead of a
 * cryptic spawn failure.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { extname, isAbsolute, join, dirname, basename, relative, resolve } from 'node:path';
import { EVENTS, emitEvent } from '../core/events.mjs';
import { runCommand as runBoundedCommand } from '../support/run-command.mjs';
import { isInsideRoot } from '../support/path-safety.mjs';
import { markBuiltIn } from '../core/builtin-brand.mjs';
import { LIMITS } from '../core/limit-config.mjs';

const RG_MISSING_MESSAGE =
    'ripgrep (rg) is not installed or not in your PATH. Install it to use the grep/glob tools.';

const BINARY_EXTS = new Set([
    '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.class', '.jar', '.war', '.7z',
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
    '.bin', '.dat', '.obj', '.o', '.a', '.lib', '.wasm', '.pyc', '.pyo'
]);

const SENSITIVE_BASENAMES = new Set([
    'secret.env', '.env', 'vertex-sa.json', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519'
]);

const SAFE_ENV_BASENAMES = new Set([
    '.env.example', '.env.sample', '.env.template'
]);

/**
 * Checks whether a path references a sensitive credential/key file by basename or path segment.
 * @param {{filePath?: string}} [arg0]
 * @returns {boolean}
 */
export function isSensitivePath({ filePath = '' } = {}) {
    if (typeof filePath !== 'string' || !filePath) return false;
    const norm = filePath.replace(/\\/g, '/').toLowerCase();
    if (/(?:^|\/)\.git(?:\/|$)/.test(norm) || /(?:^|\/)\.aws\/credentials(?:\/|$)/.test(norm)) {
        return true;
    }
    const segments = norm.split('/').filter(Boolean);
    for (const seg of segments) {
        if (SAFE_ENV_BASENAMES.has(seg)) continue;
        if (SENSITIVE_BASENAMES.has(seg)) return true;
        if (seg.startsWith('.env') || seg.endsWith('.env')) return true;
        if (seg.endsWith('.pem') || seg.endsWith('.key')) return true;
    }
    return false;
}


/**
 * The context tools — read, grep and glob over the working directory, as one tool set.
 * @param {{options?: {root?: string, spawn?: Function, allowOutsideRoot?: boolean, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null}}} arg0 -
 * @returns {Array<import('./tool-execution.mjs').ReadyTool>} [read, grep, glob] tool definitions.
 */
export function createContextTools({ options = {} } = {}) {
    const root = resolve(options.root ?? process.cwd());
    const allowOutsideRoot = options.allowOutsideRoot === true;
    const spawnFn = typeof options.spawn === 'function' ? options.spawn : nodeSpawn;
    const ee =  (options.eventEmitter ?? null);

    const maxLineChars = LIMITS.read_max_line_chars;
    const maxLineSuffix = `... (line truncated to ${maxLineChars} chars)`;
    const maxBytes = LIMITS.read_max_bytes;
    const maxBytesLabel = `${maxBytes / 1024} KB`;

    
    /** @type {(name: string, payload: any) => void} */
        /** @param {{name: *, payload: *}} arg0 */
        /** @param {{name: *, payload: *}} arg0 */
        const emit = ({ name, payload }) => {
        emitEvent({ emitter: /** @type {any} */ (ee), name, payload });
    };

    
    /** @type {(p: string) => string} */
        /** @param {{p: *}} arg0 */
        /** @param {{p: *}} arg0 */
        const confine = ({ p }) => {
        const norm = resolve(isAbsolute(p) ? p : join(root, p));
        if (!allowOutsideRoot && !isInsideRoot({ root, path: norm })) {
            emit({ name: EVENTS.TOOL.PATH_DENIED, payload: { path: norm, reason: 'outside_workspace_root' } });
            throw new Error(`Path outside the workspace root is not allowed: ${norm}`);
        }
        if (isSensitivePath({ filePath: String(p) }) || isSensitivePath({ filePath: relative(root, norm) || basename(norm) })) {
            emit({ name: EVENTS.TOOL.PATH_DENIED, payload: { path: norm, reason: 'sensitive_file' } });
            throw new Error(`Access to sensitive file is not allowed: ${norm}`);
        }
        return norm;
    };
    
    /** @type {(p: string) => Promise<string>} */
        /** @param {{p: *}} arg0 */
        /** @param {{p: *}} arg0 */
        const confineReal = async ({ p }) => {
        const norm = confine({ p });
        const realRoot = await fs.realpath(root).catch(() => root);
        let real = norm;
        try {
            real = await fs.realpath(norm);
        } catch {
            let cur = norm;
            const tailParts = [];
            while (cur && cur !== dirname(cur)) {
                tailParts.unshift(basename(cur));
                cur = dirname(cur);
                try {
                    const realParent = await fs.realpath(cur);
                    real = join(realParent, ...tailParts);
                    break;
                } catch {   }
            }
        }
        if (!allowOutsideRoot) {
            if (!isInsideRoot({ root: realRoot, path: real })) {
                emit({ name: EVENTS.TOOL.PATH_DENIED, payload: { path: norm, reason: 'resolves_outside_workspace_root' } });
                throw new Error(`Path resolves outside the workspace root: ${norm}`);
            }
        }
        if (isSensitivePath({ filePath: relative(realRoot, real) || basename(real) }) || isSensitivePath({ filePath: real })) {
            emit({ name: EVENTS.TOOL.PATH_DENIED, payload: { path: norm, reason: 'sensitive_file' } });
            throw new Error(`Access to sensitive file is not allowed: ${norm}`);
        }
        return real;
    };
    
    /** @type {(p: string) => string} */
        /** @param {{p: *}} arg0 */
        /** @param {{p: *}} arg0 */
        const rel = ({ p }) => relative(root, p) || p;

    
    /** @type {Promise<void>|null} */
        let rgProbe = null;
    let rgProbeFailedAt = 0;
    const ensureRipgrep = () => {
        if (!rgProbe) {
            if (rgProbeFailedAt && Date.now() - rgProbeFailedAt < LIMITS.grep_missing_probe_ms) {
                return Promise.reject(new Error(RG_MISSING_MESSAGE));
            } else {
                rgProbe = /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
                    const child = spawnFn('rg', ['--version']);
                    child.on('error', () => reject(new Error(RG_MISSING_MESSAGE)));
                    child.on('close', /** @type {(...args: any[]) => any} */ (( code) => {
                        if (code === 0) resolve();
                        else reject(new Error(RG_MISSING_MESSAGE));
                    }));
                })).catch(( err) => {
                    rgProbeFailedAt = Date.now();
                    rgProbe = null;
                    throw err;
                });
            }
        }
        return rgProbe;
    };

    
    /** @type {(command: string, args: string[], opts?: {signal?: AbortSignal|null}) => Promise<any>} */
        /** @param {{command: *, args: *, signal: *}} arg0 */
        /** @param {{command: *, args: *, signal: *}} arg0 */
        const runCommand = ({ command, args, signal }) =>
        runBoundedCommand({ command, args, signal, timeoutMs: LIMITS.grep_command_timeout_ms, spawn: spawnFn })
            .catch(( err) => {
                if (err.code === 'ENOENT') throw new Error(RG_MISSING_MESSAGE);
                throw err;
            });

    /**
     * @type {(filepath: string, o: {limit: number, offset: number}) => Promise<any>}
     */
        /** @param {{filepath: *, limit: *, offset: *}} arg0 */
        /** @param {{filepath: *, limit: *, offset: *}} arg0 */
        const readLines = async ({ filepath, limit, offset }) => {
        const start = Math.max(0, offset - 1);
        const stat = await fs.stat(filepath);
        let text;
        let truncatedFile = false;
        const maxReadBytes = LIMITS.read_max_file_bytes;
        if (stat.size > maxReadBytes) {
            truncatedFile = true;
            const handle = await fs.open(filepath, 'r');
            try {
                const buf = Buffer.alloc(maxReadBytes);
                const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
                text = buf.subarray(0, bytesRead).toString('utf8');
            } finally {
                await handle.close();
            }
        } else {
            text = await fs.readFile(filepath, 'utf8');
        }
        const all = text.split('\n');
        const count = all.length;
        const raw = [];
        let bytes = 0;
        let cut = false;
        for (let i = start; i < count && raw.length < limit; i++) {
            const clipped = all[i].length > maxLineChars
                ? all[i].substring(0, maxLineChars) + maxLineSuffix
                : all[i];
            const size = Buffer.byteLength(clipped, 'utf8') + (raw.length > 0 ? 1 : 0);
            if (bytes + size <= maxBytes) {
                raw.push(clipped);
                bytes += size;
            } else {
                cut = true;
                break;
            }
        }
        return { raw, count, cut, more: start + raw.length < count || cut, offset, truncatedFile };
    };

    
    /** @type {(stdout: string) => {lines: string[], truncated: boolean}} */
        /** @param {{stdout: *}} arg0 */
        /** @param {{stdout: *}} arg0 */
        const capLines = ({ stdout }) => {
        const all = stdout.split('\n').filter(Boolean);
        return { lines: all.slice(0, LIMITS.grep_result_limit), truncated: all.length > LIMITS.grep_result_limit };
    };

    
    /** @type {(filepath: string, sample: Uint8Array) => boolean} */
        /** @param {{filepath: *, sample: *}} arg0 */
        /** @param {{filepath: *, sample: *}} arg0 */
        const isBinaryFile = ({ filepath, sample }) => {
        const ext = extname(filepath).toLowerCase();
        if (BINARY_EXTS.has(ext)) return true;
        if (!sample || sample.length === 0) return false;
        let nonPrintable = 0;
        for (const byte of sample) {
            if (byte === 0) return true;
            if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++;
        }
        return nonPrintable / sample.length > LIMITS.read_binary_ratio;
    };

    
    /** @type {(filepath: string, size: number) => Promise<Uint8Array>} */
        /** @param {{filepath: *, size: *}} arg0 */
        /** @param {{filepath: *, size: *}} arg0 */
        const readSample = async ({ filepath, size }) => {
        if (size === 0) return new Uint8Array();
        const handle = await fs.open(filepath, 'r');
        try {
            const buf = Buffer.alloc(Math.min(LIMITS.read_sample_bytes, size));
            const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
            return bytesRead < buf.length ? buf.subarray(0, bytesRead) : buf;
        } finally {
            await handle.close();
        }
    };

    
    /** @type {(filepath: string) => Promise<never>} */
        /** @param {{filepath: *}} arg0 */
        /** @param {{filepath: *}} arg0 */
        const miss = async ({ filepath }) => {
        
        /** @type {string[]} */
                let items = [];
        try {
            const entries = await fs.readdir(dirname(filepath));
            items = entries
                .filter((item) => !isSensitivePath({ filePath: item }))
                .filter((item) => item.toLowerCase().includes(basename(filepath).toLowerCase())
                    || basename(filepath).toLowerCase().includes(item.toLowerCase()))
                .slice(0, LIMITS.did_you_mean_candidates);
        } catch {   }
        if (items.length > 0) {
            throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.map((i) => join(dirname(filepath), i)).join('\n')}`);
        }
        throw new Error(`File not found: ${filepath}`);
    };

    const read = {
        name: 'read',
        // Read-only: a failed row is safe to retry after the underlying cause is fixed (G1-2).
        idempotent: true,
        description: [
            'Read a file or list a directory. For files, returns numbered lines within an',
            'offset/limit window (default limit 2000 lines, capped at 50 KB). Use the offset',
            'parameter to read beyond the first window.',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'The path to the file or directory to read (absolute, or relative to the workspace root).' },
                offset: { type: 'integer', minimum: 1, description: 'The 1-indexed line number to start reading from.' },
                limit: { type: 'integer', minimum: 1, description: 'The maximum number of lines to read (default 2000).' }
            },
            required: ['filePath']
        },
        /** @param {{args: *}} arg0 */
        execute: async ({ args }) => {
            const filepath = await confineReal({ p: args.filePath });
            const stat = await fs.stat(filepath).catch(() => null);
            if (!stat) return miss({ filepath });

            if (stat.isDirectory()) {
                const entries = (await fs.readdir(filepath, { withFileTypes: true }))
                    .filter((e) => !isSensitivePath({ filePath: e.name }))
                    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
                    .sort((a, b) => a.localeCompare(b));
                const limit = args.limit ?? LIMITS.read_default_limit;
                const start = Math.max(0, (args.offset || 1) - 1);
                const sliced = entries.slice(start, start + limit);
                const truncated = start + sliced.length < entries.length;
                return [
                    `<path>${filepath}</path>`,
                    '<type>directory</type>',
                    '<entries>',
                    ...sliced,
                    truncated
                        ? `\n(Showing ${sliced.length} of ${entries.length} entries. Use offset to read beyond entry ${start + sliced.length})`
                        : `\n(${entries.length} entries)`,
                    '</entries>',
                ].join('\n');
            }

            if (stat.isFile()) {
                const sample = await readSample({ filepath, size: stat.size });
                if (isBinaryFile({ filepath, sample })) throw new Error(`Cannot read binary file: ${filepath}`);

                const file = await readLines({ filepath, limit: args.limit ?? LIMITS.read_default_limit, offset: args.offset || 1 });
                if (!file.truncatedFile && file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
                    throw new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`);
                }

                const lines = file.raw.map(( line,  i) => `${i + file.offset}: ${line}`);
                const last = file.offset + file.raw.length - 1;
                const next = last + 1;
                let footer;
                if (file.cut) footer = `\n\n(Output capped at ${maxBytesLabel}. Showing lines ${file.offset}-${last}. Use offset=${next} to continue.)`;
                else if (file.truncatedFile) footer = `\n\n(File exceeds the ${LIMITS.read_max_file_bytes / (1024 * 1024)} MB read window. Showing lines ${file.offset}-${last}. Use offset=${next} to continue.)`;
                else if (file.more) footer = `\n\n(Showing lines ${file.offset}-${last} of ${file.count}. Use offset=${next} to continue.)`;
                else footer = `\n\n(End of file - total ${file.count} lines)`;

                return [
                    `<path>${filepath}</path>`,
                    '<type>file</type>',
                    '<content>',
                    ...lines,
                    `${footer}`,
                    '</content>',
                ].join('\n');
            }

            throw new Error(`Unsupported file type: ${filepath}`);
        },
    };

    const grep = {
        name: 'grep',
        // Read-only: a failed row is safe to retry after the underlying cause is fixed (G1-2).
        idempotent: true,
        description: [
            'Search file contents for a regex pattern using ripgrep. Returns up to 100',
            'matches grouped by file with line numbers. Optionally scope to a directory',
            'or include only files matching a glob.',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The regex pattern to search for in file contents.' },
                path: { type: 'string', description: 'The directory to search in (defaults to the workspace root).' },
                include: { type: 'string', description: 'Glob of files to include, e.g. "*.js" or "*.{ts,tsx}".' }
            },
            required: ['pattern']
        },
        /** @param {{args: *, signal: *}} arg0 */
        execute: async ({ args, signal }) => {
            if (!args.pattern) throw new Error('pattern is required');
            await ensureRipgrep();
            const dir = args.path ? await confineReal({ p: args.path }) : root;
            if (args.include && isSensitivePath({ filePath: String(args.include) })) {
                emit({ name: EVENTS.TOOL.PATH_DENIED, payload: { path: String(args.include), reason: 'sensitive_file' } });
                throw new Error(`Access to sensitive file is not allowed: ${args.include}`);
            }
            const rgArgs = [
                '--line-number', '--no-heading', '--color', 'never', '--max-count', String(LIMITS.grep_max_count_per_file),
                '--no-follow',
                ...(args.include ? ['-g', args.include] : []),
                '--', args.pattern,
                dir,
            ];
            const { code, stdout, stderr } = await runCommand({ command: 'rg', args: rgArgs, signal });
            if (code === 1) return 'No files found';
            if (code !== 0) throw new Error(stderr.trim() || `rg exited with code ${code}`);
            if (!stdout) return 'No files found';

            const { lines, truncated: hasMore } = capLines({ stdout });
            const rows =  (lines.map(/** @type {(...args: any[]) => any} */ ((line) => {
                const m = /^(.+?):(\d+):(.*)$/.exec(line);
                if (!m) return null;
                if (isSensitivePath({ filePath: rel({ p: m[1] }) }) || isSensitivePath({ filePath: basename(m[1]) })) return null;
                return { file: m[1], line: m[2], text: m[3] };
            })).filter(Boolean));
            if (rows.length === 0) return 'No files found';
            const output = [`Found ${rows.length} matches${hasMore ? ' (more matches available)' : ''}`];
            let current = '';
            for (const match of rows) {
                if (current !== match.file) {
                    if (current !== '') output.push('');
                    current = match.file;
                    output.push(`${match.file}:`);
                }
                output.push(`  Line ${match.line}: ${match.text}`);
            }
            if (hasMore) output.push('', '(Results truncated. Consider using a more specific path or pattern.)');
            return output.join('\n');
        },
    };

    const glob = {
        name: 'glob',
        // Read-only: a failed row is safe to retry after the underlying cause is fixed (G1-2).
        idempotent: true,
        description: 'List file paths matching a glob pattern using ripgrep. Returns up to 100 results.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The glob pattern to match file paths against, e.g. "**/*.mjs" or "lib/**".' },
                path: { type: 'string', description: 'The directory to search in (defaults to the workspace root).' }
            },
            required: ['pattern']
        },
        /** @param {{args: *, signal: *}} arg0 */
        execute: async ({ args, signal }) => {
            if (args.pattern && isSensitivePath({ filePath: String(args.pattern) })) {
                emit({ name: EVENTS.TOOL.PATH_DENIED, payload: { path: String(args.pattern), reason: 'sensitive_file' } });
                throw new Error(`Access to sensitive file is not allowed: ${args.pattern}`);
            }
            await ensureRipgrep();
            const dir = args.path ? await confineReal({ p: args.path }) : root;
            const rgArgs = ['--files', '--no-follow', ...(args.pattern ? ['-g', args.pattern] : []), dir];
            const { code, stdout, stderr } = await runCommand({ command: 'rg', args: rgArgs, signal });
            if (code === 1) return 'No files found';
            if (code !== 0) throw new Error(stderr.trim() || `rg exited with code ${code}`);

            const { lines: rawFiles, truncated } = capLines({ stdout });
            const files = rawFiles.filter(/** @type {(...args: any[]) => any} */ ((f) => !isSensitivePath({ filePath: rel({ p: f }) }) && !isSensitivePath({ filePath: basename(f) })));
            const output = files.length === 0 ? ['No files found'] : files.map(/** @type {(...args: any[]) => any} */ ((f) => rel({ p: f })));
            if (truncated) output.push('', `(Results are truncated: showing first ${LIMITS.grep_result_limit} results. Consider using a more specific path or pattern.)`);
            return output.join('\n');
        },
    };

    return [read, grep, glob].map((t) => markBuiltIn({ tool: t }));
}
