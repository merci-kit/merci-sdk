// @ts-check
/**
 * @file fs-store — the single durable-JSON file primitive.
 * @version 0.12.0
 *
 * @description
 * One place for the load/validate/version-guard and the atomic tmp+rename
 * write that the memory, todos, artifacts and session stores all hand-rolled.
 * `readStoredJson` returns a discriminated status and leaves the store-specific
 * quarantine message to the caller; `quarantineFile` performs the shared
 * rename; `writeJsonAtomic` performs the shared write. Nothing here knows
 * about a particular store's schema, version or warning prefix.
 */

import { promises as fs, chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { LIMITS } from '../core/limit-config.mjs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_UTF8_ENCODING, FS_ENOENT_CODE } from '../core/constants/index.mjs';
import { validateStrict } from './json.mjs';

/**
 * Atomically writes `data` as 2-space JSON: a pid/uuid tmp sibling, then a
 * rename. Preserves existing file permissions when overwriting and ensures
 * parent directory exists.
 * @param {{filePath: string, data: unknown, encoding?: BufferEncoding}} arg0 -
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic({ filePath, data, encoding = DEFAULT_UTF8_ENCODING }) {
    await fs.mkdir(dirname(filePath), { recursive: true });
    const existingStat = await fs.stat(filePath).catch(() => null);
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        // Write, then fsync before the rename: without the sync a crash after
        // the rename can leave a zero-length or truncated file, which defeats
        // the point of the atomic write.
        const handle = await fs.open(tmpPath, 'w');
        try {
            await handle.writeFile(JSON.stringify(data, null, 2), encoding);
            await handle.sync();
        } finally {
            await handle.close();
        }
        if (existingStat && typeof existingStat.mode === 'number') {
            await fs.chmod(tmpPath, existingStat.mode & 0o777).catch(() => {});
        }
        await fs.rename(tmpPath, filePath);
    } catch (err) {
        await fs.unlink(tmpPath).catch(() => {});
        throw err;
    }
}

/**
 * Synchronous `writeJsonAtomic`, for a caller whose own API is synchronous.
 * Same tmp+fsync+rename contract and permission preservation.
 * @param {{filePath: string, data: unknown, encoding?: BufferEncoding}} arg0 -
 * @returns {void}
 */
export function writeJsonAtomicSync({ filePath, data, encoding = DEFAULT_UTF8_ENCODING }) {
    mkdirSync(dirname(filePath), { recursive: true });
    let existingMode = null;
    try {
        existingMode = statSync(filePath).mode & 0o777;
    } catch {
        // A new file keeps the umask default.
    }
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd = null;
    try {
        fd = openSync(tmpPath, 'w');
        writeFileSync(fd, JSON.stringify(data, null, 2), encoding);
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        if (existingMode !== null) {
            try { chmodSync(tmpPath, existingMode); } catch { /* permission copy is best-effort */ }
        }
        renameSync(tmpPath, filePath);
    } catch (err) {
        if (fd !== null) {
            try { closeSync(fd); } catch { /* already closed */ }
        }
        try { unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
        throw err;
    }
}

/**
 * The synchronous read half of a durable-JSON file: `readFileSync` + `JSON.parse`
 * with the missing file and the parse failure reported as a status instead of a
 * throw. No schema and no version guard — the caller that owns those applies
 * them to `value`, and keeps its own wording for what it skips.
 * @param {{filePath: string, encoding?: BufferEncoding}} arg0 -
 * @returns {{status: 'missing'|'ok'|'corrupt', kind?: 'parse', reason?: string, value?: unknown}}
 */
export function readStoredJsonSync({ filePath, encoding = DEFAULT_UTF8_ENCODING }) {
    let raw;
    try {
        raw = readFileSync(filePath, encoding);
    } catch (error) {
        if (/** @type {any} */ (error).code === FS_ENOENT_CODE) return { status: 'missing' };
        throw error;
    }
    try {
        return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
        return { status: 'corrupt', kind: 'parse', reason: (/** @type {any} */ (error))?.message ?? String(error) };
    }
}

/**
 * Moves a corrupt file aside to a timestamped `.corrupt-` sibling so its bytes
 * are preserved, then reports the outcome. Never throws: a failed quarantine
 * still lets the caller start fresh.
 * @param {{filePath: string, reason: string, onQuarantine?: ((arg0: {path: string, ok: boolean, error?: Error}) => void)|null}} arg0 -
 * @returns {Promise<string>} the quarantine path
 */
export async function quarantineFile({ filePath, reason, onQuarantine = null }) {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}-${process.pid}-${randomUUID().slice(0, LIMITS.fs_quarantine_suffix_chars)}`;
    try {
        await fs.rename(filePath, quarantinePath);
        onQuarantine?.({ path: quarantinePath, ok: true });
    } catch (err) {
        onQuarantine?.({ path: quarantinePath, ok: false, error: /** @type {Error} */ (err) });
    }
    return quarantinePath;
}

/**
 * Reads and validates a durable JSON file. A missing file is `missing`; a
 * parse, schema or version failure is `corrupt`. `kind` lets each caller keep
 * its own warning wording: `parse`/`schema` carry the raw error as `reason`,
 * `version` carries the offending version as `reason`. Quarantine stays at the
 * call site so each store keeps its own message.
 * @template T
 * @param {{filePath: string, schema?: Record<string, unknown>|null, version?: string|number|null, encoding?: BufferEncoding}} arg0 -
 * @returns {Promise<{status: 'missing'|'ok'|'corrupt'|'version_mismatch', value?: T, data?: unknown, actualVersion?: unknown, kind?: 'parse'|'schema'|'version', reason?: string}>}
 */
export async function readStoredJson({ filePath, schema = null, version = null, encoding = DEFAULT_UTF8_ENCODING }) {
    let raw;
    try {
        raw = await fs.readFile(filePath, encoding);
    } catch (error) {
        if (/** @type {any} */ (error).code === FS_ENOENT_CODE) return { status: 'missing' };
        throw error;
    }
    // Both paths go through the strict parser: a corrupt persisted payload is
    // rejected, never healed, and the reason never quotes the file content.
    const parsed = schema ? validateStrict({ input: raw, schema }) : validateStrict({ input: raw });
    if (!parsed.success) {
        return {
            status: 'corrupt',
            kind: schema ? 'schema' : 'parse',
            reason: parsed.error || (schema ? 'schema validation failed' : 'parse failed')
        };
    }
    /** @type {any} */
    const data = parsed.data;
    if (version != null && data?.version !== version) {
        if (!(data?.version === undefined && version === 1 && Array.isArray(data?.facts))) {
            return { status: 'corrupt', kind: 'version', reason: String(data?.version), data, actualVersion: data?.version };
        }
    }
    return { status: 'ok', value: data };
}
