// @ts-check
/**
 * @file Unified checkpoint envelope.
 * @version 0.12.0
 *
 * @description
 * One durable format that tags a payload with its runtime kind (chat /
 * stateMachine / workflow) and dispatches to the right rehydrator on restore.
 * Persisted through the LocalFileSessionStore's atomic store, so every kind
 * shares the same tmp-file + rename durability.
 */

import { ConfigurationError } from '../../core/errors.mjs';
import { StateMachine } from '../state-machine/machine.mjs';
import { WorkflowExecutor } from './executor.mjs';

/** Current envelope format version; a mismatched record is refused on restore. */
export const CHECKPOINT_VERSION = 1;

/** Checkpoint payload kinds. */
export const CHECKPOINT_KIND = Object.freeze({
    CHAT: 'chat',
    STATE_MACHINE: 'stateMachine',
    WORKFLOW: 'workflow',
});

const KINDS = /** @type {Set<string>} */ (new Set(Object.values(CHECKPOINT_KIND)));

/**
 * The save envelope a session store persists: the tagged payload.
 * @typedef {Object} CheckpointEnvelope
 * @property {{version: number, kind: string, payload: string}} checkpoint
 */

/**
 * Tags a payload string with its kind.
 * @param {{kind: string, payload: string}} arg0 - `kind` is a CHECKPOINT_KIND value; `payload` is the serialized runtime state.
 * @returns {CheckpointEnvelope} The save envelope.
 */
export function wrapCheckpoint({ kind, payload }) {
    if (!KINDS.has(kind)) throw new ConfigurationError({ message: `Unknown checkpoint kind '${kind}'.` });
    return { checkpoint: { version: CHECKPOINT_VERSION, kind, payload } };
}

/**
 * Reads a checkpoint envelope back out of a saved record.
 * @param {{saved: Record<string, unknown>|null}} arg0 - The record `store.load()` returned.
 * @returns {{version: number, kind: string, payload: string}|null}
 */
export function unwrapCheckpoint({ saved }) {
    const envelope = /** @type {Partial<CheckpointEnvelope>} */ (saved ?? {});
    const c = envelope.checkpoint;
    if (!c || !KINDS.has(c.kind) || typeof c.payload !== 'string') return null;
    return c;
}

/**
 * Saves a tagged checkpoint through a session store.
 * @param {{store: {save: Function}, threadId: string, kind: string, payload: string}} arg0 - `store` is a LocalFileSessionStore.
 * @returns {Promise<string>} the checkpoint file path.
 */
export async function saveCheckpoint({ store, threadId, kind, payload }) {
    return store.save({ threadId, data: wrapCheckpoint({ kind, payload }) });
}

/**
 * Restores a checkpoint of the expected kind. A record that EXISTS but is not
 * restorable (missing or unknown envelope, another kind, non-string payload)
 * throws: treating it as "no checkpoint" restarts the run and replays every
 * completed side effect (G1-3).
 * @param {{saved: Record<string, unknown>|null, kind: string, args?: Array<unknown>}} arg0 - `saved` is the record returned by store.load(); `kind` is the expected CHECKPOINT_KIND; `args` are rehydration args for the kind: workflow → (options); stateMachine → (graph, options); chat → none.
 * @returns {Object|string|null} The rehydrated runtime (workflow executor / state machine / chat payload), or null when there is no record.
 * @throws {ConfigurationError} The record exists but is malformed or of another kind.
 */
export function restoreCheckpoint({ saved, kind, args = [] }) {
    if (saved === null || saved === undefined) return null;
    const c = unwrapCheckpoint({ saved });
    if (!c) {
        const found = /** @type {any} */ (saved).checkpoint;
        const detail = found && typeof found === 'object'
            ? `kind '${String(found.kind)}'${typeof found.payload === 'string' ? '' : ' with a non-string payload'}`
            : 'no checkpoint envelope';
        throw new ConfigurationError({ message: `Checkpoint kind mismatch: expected '${kind}', record has ${detail}; use a fresh thread id (switching engine for an existing work item needs a new thread id or a cleared checkpoint).` });
    }
    if (c.kind !== kind) {
        throw new ConfigurationError({ message: `Checkpoint kind mismatch: expected '${kind}', record is '${c.kind}'; use a fresh thread id (switching engine for an existing work item needs a new thread id or a cleared checkpoint).` });
    }
    if (c.version !== CHECKPOINT_VERSION) {
        throw new ConfigurationError({ message: `Unsupported checkpoint version ${c.version} (expected ${CHECKPOINT_VERSION}).` });
    }
    if (kind === CHECKPOINT_KIND.CHAT) return c.payload;
    if (kind === CHECKPOINT_KIND.WORKFLOW) return WorkflowExecutor.load({ json: c.payload, options: /** @type {Object} */ (args[0] ?? {}) });
    if (kind === CHECKPOINT_KIND.STATE_MACHINE) return StateMachine.load({ json: c.payload, graph: /** @type {Object} */ (args[0] ?? {}), options: /** @type {Object} */ (args[1] ?? {}) });
    return null;
}
