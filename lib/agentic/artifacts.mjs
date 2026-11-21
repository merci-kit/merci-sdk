// @ts-check


/**
 * @file Artifact tool — persist large subagent outputs to files.
 * @version 0.12.0
 *
 * @description
 * Persist large subagent outputs to files and return a lightweight path
 * reference. SOTA pattern (Anthropic multi-agent research): "pass lightweight
 * references, not token copies" — the coordinator reads the artifact path
 * instead of carrying megabytes through the conversation.
 */
import { promises as fs } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { EVENTS, emitEvent } from '../core/events.mjs';
import { ConfigurationError } from '../core/errors.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { readStoredJson, writeJsonAtomic, quarantineFile } from '../support/fs-store.mjs';
import { isInsideRoot } from '../support/path-safety.mjs';
import { sdkWarn } from '../support/utils.mjs';
import { markBuiltIn } from '../core/builtin-brand.mjs';
/**
 * @typedef {Object} ArtifactEntry
 * @property {string} name
 * @property {number} bytes
 * @property {number} version
 * @property {string} ts
 * @property {string} path
 */

/**
 * @typedef {Object} SaveArtifactTool
 * @property {string} name
 * @property {boolean} [builtIn] - SDK confined-tool tier stamp (wins name collisions).
 * @property {string} description
 * @property {import('../support/json.mjs').JsonSchema} parameters
 * @property {boolean} [editsFiles] - Writes files: `acceptEdits` auto-approves it (G2-3).
 * @property {(arg0: {args: {name?: string, content?: string}, signal?: AbortSignal|null, context?: {runContext?: import('../core/events.mjs').RunContext|null}|null}) => Promise<string>} execute
 */



/** Manifest filename (version index) inside the artifact directory. */
const ARTIFACT_MANIFEST = '.artifacts.json';

const MANIFEST_SCHEMA = {
    type: 'object',
    properties: {
        entries: { type: 'array' }
    }
};




/**
 * A missing manifest is an empty index. A corrupt or wrong-typed one is moved
 * aside (never left to be silently overwritten by the next save) and still
 * degrades the caller to an empty index, so the documented policy (safe restart
 * at v1) holds without losing the original bytes.
 * @param {{root: string}} arg0 -
 * @returns {Promise<Array<ArtifactEntry>>}
 */
async function readManifest({ root }) {
    const file = join(root, ARTIFACT_MANIFEST);
    const read = await readStoredJson({ filePath: file, schema: MANIFEST_SCHEMA });
    if (read.status === 'missing') return [];
    if (read.status === 'corrupt' || !Array.isArray(read.value?.entries)) {
        const reason = read.status === 'corrupt' ? (read.reason ?? 'is corrupt') : 'entries is not an array';
        await quarantineFile({ filePath: file, reason, onQuarantine: ({ path, ok, error }) => {
            if (ok) {
                sdkWarn({ prefix: 'Artifacts', args: [`Artifact manifest '${file}' is corrupt (${reason}); quarantined to '${path}' — starting a fresh index.`] });
            } else {
                sdkWarn({ prefix: 'Artifacts', args: [`Artifact manifest '${file}' is corrupt (${reason}); quarantine failed: ${error?.message} — starting a fresh index.`] });
            }
        } });
        return [];
    }
    return read.value.entries.filter((/** @type {any} */ e) => e && typeof e === 'object' && typeof e.name === 'string');
}


/**
 * @param {{root: string, entries: Array<ArtifactEntry>}} arg0 -
 * @returns {Promise<void>}
 */
async function writeManifest({ root, entries }) {
    await writeJsonAtomic({ filePath: join(root, ARTIFACT_MANIFEST), data: { entries } });
}




/**
 * A tool that saves a file the run produced into the artifact directory.
 * @param {{dir?: string, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null}} arg0
 * @returns {SaveArtifactTool} a standard Merci SDK tool definition.
 */
export function createSaveArtifactTool({ dir = 'artifacts', eventEmitter = null } = {}) {
    const root = normalize(dir);
    /** @param {{name: *, payload: *, runContext?: *}} arg0 */
    /** @param {{name: *, payload: *, runContext?: *}} arg0 */
    const emit = ({ name, payload, runContext = null }) => {
        emitEvent({ emitter: eventEmitter, name, payload, runContext });
    };
    let saveChain = Promise.resolve();
    
    /**
     * @param {{name?: string, content?: string}} args
     * @param {any} signal
     * @param {{runContext?: any}} context
     * @returns {Promise<string>}
     */
        /** @param {{args: *, signal: *, context?: *}} arg0 */
        /** @param {{args: *, signal: *, context?: *}} arg0 */
        const saveOne = async ({ args, signal, context = {} }) => {
        const { name, content } = args;
        const safe = String(name ?? '').replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!safe || safe === ARTIFACT_MANIFEST) throw new ConfigurationError({ message: 'save_artifact: invalid artifact name', options: { option: 'name' } });
        await fs.mkdir(root, { recursive: true });

        const entries = await readManifest({ root });
        let version = entries.reduce((max, e) => (e.name === safe ? Math.max(max, e.version ?? 1) : max), 0) + 1;
        const ext = extname(safe);
        const baseName = safe.slice(0, safe.length - ext.length);
        const contentStr = String(content ?? '');
        /** @type {string} */
        let target;
        for (;;) {
            const fileName = version === 1 ? safe : `${baseName}.v${version}${ext}`;
            target = normalize(join(root, fileName));
            if (!isInsideRoot({ root, path: target })) throw new ConfigurationError({ message: 'save_artifact: name escapes the artifact directory', options: { option: 'name' } });
            try {
                await fs.writeFile(target, contentStr, { encoding: 'utf8', flag: 'wx' });
                break;
            } catch (error) {
                if ((/** @type {any} */ (error)).code !== 'EEXIST' || version >= LIMITS.artifacts_collision_retries) throw error;
                version += 1;
            }
        }
        await writeManifest({ root, entries: [
            ...entries,
            { name: safe, bytes: Buffer.byteLength(contentStr, 'utf8'), version, ts: new Date().toISOString(), path: target },
        ] });
        emit({ name: EVENTS.ARTIFACT.SAVED, payload: { name: safe, path: target, bytes: Buffer.byteLength(contentStr, 'utf8'), version }, runContext: context?.runContext ?? null });
        return target;
    };
    return markBuiltIn({ tool: {
        name: 'save_artifact',
        // The one brand `acceptEdits` trusts: this tool writes a file and runs no code.
        editsFiles: true,
        description: [
            'Persist a large output (report, code, structured data) to a file and return its absolute path.',
            'Use for outputs too large or too important to carry as plain text — return the PATH to the caller instead of the full content.',
            'The caller can reference the path in later prompts; the content survives outside the conversation.',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Artifact file name (e.g. "research_findings.md", "patch.diff").' },
                content: { type: 'string', description: 'The full artifact content to persist.' },
            },
            required: ['name', 'content'],
        },
        /** @param {{args: *, signal?: *, context?: *}} arg0 */
        execute({ args, signal = null, context = {} }) {
            const task = saveChain.then(() => saveOne({ args, signal, context }), () => saveOne({ args, signal, context }))
                .catch((error) => {
                    emit({ name: EVENTS.ARTIFACT.SAVE_ERROR, payload: {
                        name: String(args?.name ?? ''), error: (/** @type {any} */ (error))?.message ?? String(error)
                    }, runContext: context?.runContext ?? null });
                    throw error;
                });
            saveChain = task.then(() => {}, () => {});
            return task;
        },
    } });
}
