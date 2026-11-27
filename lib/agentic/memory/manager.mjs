// @ts-check
import { randomUUID } from 'node:crypto';
import {
    DISTILLATION_ERROR_CODE,
    LOG_PREFIX_MEMORY,
    MEMORY_DISTILLATION_SCHEMA
} from '../../core/constants/index.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { EVENTS, emitEvent } from '../../core/events.mjs';
import { COGNITIVE_MEMORY_PROMPTS } from '../../core/prompts.mjs';
import { extractAndParseJson } from '../../support/json.mjs';
import { countConversationTurns, isGenuineUserTurn, isInjection, stripInjectionMeta } from '../../messaging/unified-message.mjs';
import { isUserRow } from '../../messaging/row-shape.mjs';
import { sdkLog, sdkError, truncateForPrompt } from '../../support/utils.mjs';
import { AbortedError, MemoryError, wrapError } from '../../core/errors.mjs';
import { CompositeMemoryProvider, assertProvider, formatFactBullets, buildMemoryBlock } from './providers.mjs';
import { utilitySession } from '../planning/planner-utils.mjs';
import { noulQuestion } from '../../messaging/decision.mjs';

/**
 * A provider's stored facts, when it keeps a bank the block renderer can show.
 * Structural: the base contract has no `facts`; the local/bank providers do.
 * @param {{provider: Object}} arg0
 * @returns {Array<import('./providers.mjs').MemoryFact>|null}
 */
function providerFacts({ provider }) {
    const facts = /** @type {{facts?: Array<import('./providers.mjs').MemoryFact>}} */ (provider).facts;
    return Array.isArray(facts) ? facts : null;
}



/**
 * @file MemoryManager — delta distillation + sync checkpointing.
 * @version 0.12.0
 *
 * @description
 * Bridges the agentic loop and the memory providers: decides WHEN to distill
 * (turn-delta vs syncInterval), funnels distill failures into a typed
 * MemoryError surfaced as `memory:distill_error` + lastDistillError, and
 * renders the pre-step memory block. The sync checkpoint is per-manager so
 * concurrent sessions sharing one provider never clamp each other's progress.
 */


/**
 * How the manager distils: the one-shot knobs a host may override. `signal`,
 * `emitter` and `runContext` are bookkeeping; `context` is the model identity
 * the error envelope reports.
 * @typedef {Object} DistillOptions
 * @property {AbortSignal|null} [signal]
 * @property {import('node:events').EventEmitter<Record<string, unknown[]>>|null} [emitter]
 * @property {import('../../core/events.mjs').RunContext|null} [runContext]
 * @property {{model?: string|null, provider?: string|null}} [context]
 */

/**
 * The provider surface the manager drives — exactly what `assertProvider`
 * guarantees (load/save/query/store + the bank descriptions) plus the sync
 * cursor. The hooks stay `Function`: a duck-typed provider is legal, and its
 * own method signatures are its business.
 * @typedef {Object} ManagerProvider
 * @property {Function} load
 * @property {Function} save
 * @property {Function} query
 * @property {Function} store
 * @property {Function} [delete]
 * @property {Function} getBankDescriptions
 * @property {number} [lastSyncedTurnIndex]
 */

/**
 * The options `new MemoryManager(...)` takes.
 * @typedef {Object} MemoryManagerOptions
 * @property {string|(() => string|null|undefined)} [sessionId] - A fixed conversation id, or a live getter.
 * @property {Function|null} [embedder]
 * @property {number} [syncInterval] - Turn delta before a distill.
 * @property {string|null} [distillationModel]
 * @property {string|((banks: string) => string)|null} [distillationSystemPrompt] - A prompt, or a factory over the bank descriptions.
 * @property {import('../decision-gate.mjs').DecisionGate|null} [admissionGate] - Optional System One filter before a distilled fact is stored and embedded.
 */

/**
 * Coordinates long-term memory: sync-gap detection, fire-and-forget distillation
 * of new conversation turns, and per-step memory block rendering. Distillation
 * never rejects — every failure funnels through handleDistillError.
 */
export class MemoryManager {
    #distillInFlight = false;
    #lastAttemptedTurns = -1;
    #syncCheckpoint;
    // B4: a manager is rebuilt on every resume, so a manager-scoped random key made the
    // bank treat a resumed conversation as a new one and duplicate every fact. The key
    // is the conversation id when the host has one; the random id is the fallback for a
    // manager used outside a session.
    /** @type {string|null} */
    #sessionId = null;
    /** @type {null | (() => string|null|undefined)} */
    #sessionIdProvider = null;
    #fallbackSessionKey = randomUUID();

    
    /**
     * The session key a fact is deduped against: the conversation id when the host
     * supplied one (directly or through the session), else this manager's random id.
     * @returns {string}
     */
    #sessionKey() {
        if (this.#sessionId) return this.#sessionId;
        const dynamic = this.#sessionIdProvider ? this.#sessionIdProvider() : null;
        return (typeof dynamic === 'string' && dynamic.trim()) ? dynamic : this.#fallbackSessionKey;
    }

    /**
      * @param {{provider: ManagerProvider, options?: MemoryManagerOptions}} arg0
     */
        constructor({ provider, options = {} }) {
        assertProvider({ provider, owner: 'MemoryManager' });
        /** @type {ManagerProvider} */
        this.provider = provider;
        this.#syncCheckpoint = 0;
        if (typeof options.sessionId === 'function') this.#sessionIdProvider = options.sessionId;
        else if (typeof options.sessionId === 'string' && options.sessionId.trim()) this.#sessionId = options.sessionId;
        /** @type {Function|null} */
        this.embedder = options.embedder || null;
        /** @type {number} */
        this.syncInterval = options.syncInterval ?? LIMITS.memory_sync_interval;
        /** @type {string|null} */
        this.distillationModel = options.distillationModel || null;
        /** @type {string|((banks: string) => string)|null} */
        this.distillationSystemPrompt = options.distillationSystemPrompt ?? null;
        /** @type {import('../decision-gate.mjs').DecisionGate|null} */
        this.admissionGate = options.admissionGate ?? null;
        this.lastDistillError = null;
    }

    
    /**
     * returns undefined while another distill is in flight (single in-flight
     * latch). Failures go through handleDistillError.
     * @param {{messages: Array<import('../chat-session.mjs').ChatRow>, client: Object, modelToUse: string, options?: DistillOptions}} arg0 -
     * @returns {Promise<void>}
     */
        async distill({ messages, client, modelToUse, options = {} }) {
        if (this.#distillInFlight) return;
        this.#distillInFlight = true;
        try {
            await this.#doDistill({ messages, client, modelToUse, options });
        } catch (error) {
            this.handleDistillError({ err: error, ctx: {
                context: { model: modelToUse ?? null, provider: options.context?.provider ?? null },
                emitter: options.emitter ?? null,
                runContext: options.runContext ?? null
            } });
        } finally {
            this.#distillInFlight = false;
        }
    }

    
    /**
     * stores it on lastDistillError, logs via sdkError and emits
     * `memory:distill_error`.
     * @param {{err: unknown, ctx?: DistillOptions}} arg0 -
     */
        handleDistillError({ err, ctx = {} }) {
        const error = wrapError({ err, hints: { provider: ctx.context?.provider ?? undefined } });
        const memoryError = (error instanceof MemoryError)
            ? error
            : new MemoryError({ message: error.message, options: {
                layer: 'L2',
                code: DISTILLATION_ERROR_CODE,
                cause:  (error.cause ?? error),
                context: {
                    model: ctx.context?.model ?? null,
                    provider: ctx.context?.provider ?? null
                }
            } });
        this.lastDistillError = memoryError;
        sdkError({ prefix: DISTILLATION_ERROR_CODE, args: [`[Memory Distill Error] ${memoryError.message}`, { cause: memoryError.cause }] });
        emitEvent({ emitter: ctx.emitter ?? null, name: EVENTS.MEMORY.DISTILL_ERROR, payload: {
            error: memoryError,
            model: ctx.context?.model ?? null,
            provider: ctx.context?.provider ?? null
        }, runContext: ctx.runContext ?? null });
    }

    
    /**
     * relevant facts exist. The block carries the lag/gap metadata for the
     * memory:injected event.
     * @param {{messages: Array<import('../chat-session.mjs').ChatRow>}} arg0 -
     * @returns {Promise<{block: string, factCount: number}|null>}
     */
        async buildMemoryBlock({ messages }) {
        await this.provider.load();
        this.#adoptRestoredCursor();

        let lastUserText = '';
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (isInjection({ m })) continue;
            if (isUserRow({ m })) {
                lastUserText = typeof m.content === 'string'
                    ? m.content
                    : (Array.isArray(m.parts) ? m.parts.map((/** @type {{text?: string}} */ p) => p.text || '').join(' ') : '');
                break;
            }
        }

        const relevantFacts = await this.provider.query({ text: lastUserText, embedder: this.embedder });
        if (relevantFacts.length === 0) return null;

        const realTurns = countConversationTurns({ messages });
        const lastSync = this.#syncCheckpoint;
        const block = buildMemoryBlock({ facts: relevantFacts, gap: realTurns - lastSync, lastSync, currentCount: realTurns });
        return { block, factCount: relevantFacts.length };
    }

    
    /**
     * Deliberately a no-op. The persisted cursor is bank-global, while turn
     * indices are session-local: adopting another session's restored cursor made
     * a fresh session skip its own turns (locked by audit-p0-residual F1), so the
     * restart seed is intentionally not adopted. Kept as a named seam for a
     * future per-session checkpoint.
     */
        #adoptRestoredCursor() {
    }

    
    /**
     * trigger a distill. Attempts once per delta (a failed distill re-fires
     * only when new turns arrive).
     * @param {{messages: Array<import('../chat-session.mjs').ChatRow>}} arg0 -
     * @returns {boolean}
     */
        shouldSync({ messages }) {
        const turns = countConversationTurns({ messages });
        if (this.#syncCheckpoint > turns) this.#syncCheckpoint = turns;
        if (this.#lastAttemptedTurns === turns) return false;
        return turns - this.#syncCheckpoint >= this.syncInterval;
    }

    
    /**
     * @returns {Promise<void>}
      * @param {{messages: *, client: *, modelToUse: *, options?: *}} arg0
     */
        async #doDistill({ messages, client, modelToUse, options = {} }) {
        /** @param {{name: *, payload: *}} arg0 */
        const emitMem = ({ name, payload }) => {
            emitEvent({ emitter: options?.emitter, name, payload, runContext: options.runContext ?? null });
        };
        if (options.signal && options.signal.aborted) {
            this.lastDistillError = new AbortedError({ message: 'distill aborted before start.', options: { cause: options.signal.reason } });
            return;
        }
        await this.provider.load();
        this.#adoptRestoredCursor();
        const lastSync = this.#syncCheckpoint;
        const realMessages = messages.filter(/** @type {(...args: any[]) => any} */ (m => !isInjection({ m })));
        let turnIdx = 0;
        let start = realMessages.length;
        for (let i = 0; i < realMessages.length; i++) {
            if (isGenuineUserTurn({ m: realMessages[i] })) {
                if (turnIdx >= lastSync) { start = i; break; }
                turnIdx++;
            }
        }
        const delta = realMessages.slice(start);
        if (delta.length === 0) return;

        sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`Triggering delta distillation over turns ${lastSync + 1} to ${realMessages.length}`] });

        const targetModel = this.distillationModel || modelToUse;
        emitMem({ name: EVENTS.MEMORY.DISTILL_START, payload: { deltaTurns: delta.length, model: targetModel ?? null } });

        const banksInfo = /** @type {string} */ (this.provider.getBankDescriptions());
        const defaultDistiller = /** @type {(...args: any[]) => any} */ (( banks) => ( (COGNITIVE_MEMORY_PROMPTS)).SYSTEM_MEMORY_DISTILLER(banks));
        const promptFactory = typeof this.distillationSystemPrompt === 'function'
            ? this.distillationSystemPrompt
            : typeof this.distillationSystemPrompt === 'string'
                ? () => this.distillationSystemPrompt
                : defaultDistiller;

        let factHistory = '=== Active Memory Facts ===\n';
        if (this.provider instanceof CompositeMemoryProvider) {
            for (const p of this.provider.providers.values()) {
                const facts = providerFacts({ provider: p }) ?? [];
                factHistory += formatFactBullets({ facts, bank: p.name });
            }
        } else {
            const facts = providerFacts({ provider: this.provider });
            if (facts) factHistory += formatFactBullets({ facts });
        }

        const serializedDelta = truncateForPrompt({ text: JSON.stringify(stripInjectionMeta({ messages: delta }), null, 2), maxChars: LIMITS.memory_distill_transcript_chars });
        const prompt = `${truncateForPrompt({ text: factHistory, maxChars: LIMITS.memory_distill_fact_history_chars })}\n=== Delta Conversation Transcript ===\n${serializedDelta}`;

        try {
            let result =  (null);
            for (let attempt = 1; attempt <= LIMITS.memory_parse_attempts; attempt++) {
                /** @param {{b: *}} arg0 */
                const attemptSession = utilitySession({ client, model: targetModel, systemMessage: promptFactory(banksInfo), parameters: ( /** @type {(...args: any[]) => any} */ (({ b }) => b.asJsonSchema({ config: {
                        name: "memory_distillation",
                        strict: true,
                        schema: MEMORY_DISTILLATION_SCHEMA
                    } }))) });
                const attemptPrompt = attempt === 1
                    ? prompt
                    : `${prompt}\n\n=== Correction ===\nYour previous response did not contain valid JSON for the requested schema. Output ONLY the JSON object — no prose, no markdown code fences.`;
                const rawResponse = await attemptSession.run({ initialInput: attemptPrompt, options: { maxSchemaRetries: 0 } });
                if (options.signal && options.signal.aborted) {
                    this.lastDistillError = new AbortedError({ message: 'distill aborted mid-run.', options: { cause: options.signal.reason } });
                    return;
                }
                result = extractAndParseJson({ input: /** @type {string|import('../../support/json.mjs').JsonSchema} */ (rawResponse), schema: MEMORY_DISTILLATION_SCHEMA });
                if (result.success && result.data) break;
                sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`Distill JSON parse failed (attempt ${attempt}/${LIMITS.memory_parse_attempts}): ${result.error} — retrying with a correction hint`] });
            }

            if (/** @type {any} */ (result).success && /** @type {any} */ (result).data) {
                const { newFacts = [], obsoleteFactIds = [] } = /** @type {any} */ (result).data;

                let purgedCount = 0;
                let storedCount = 0;
                let skippedCount = 0;
                // Built once: the bank policy is part of the judgment, so a fact
                // routed to a long-retention bank is not judged by the default.
                const admissionQuestion = this.admissionGate?.available
                    ? noulQuestion({
                        instructions: `Is this fact durable, self-contained, and worth recalling in a future conversation? Target banks and their policy: ${String(this.provider.getBankDescriptions() ?? '')}`,
                        criteria: {
                            true: 'The fact is a lasting preference, decision, constraint, or fact about the user or task, and fits its target bank.',
                            false: 'The fact is transient chatter, a restatement, too context-bound to help later, or wrong for its target bank.',
                        },
                    })
                    : null;
                for (const f of newFacts) {
                    // Admission runs before store(): a rejected fact costs no
                    // embedding and never enters the bank. An escalation admits.
                    // A rejection is final; `skippedFacts` makes it observable.
                    if (this.admissionGate?.available && admissionQuestion) {
                        const admitted = await this.admissionGate.gate({
                            state: { fact: f.content, category: f.category ?? null, banks: f.targetBanks ?? [] },
                            question: admissionQuestion,
                            signal: options.signal ?? null,
                        });
                        if (!admitted.escalated && admitted.verdict === false && admitted.certainty !== null && admitted.certainty >= LIMITS.decision_skip_certainty) {
                            skippedCount++;
                            sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`Admission gate skipped a low-value fact: ${f.content}`] });
                            continue;
                        }
                    }
                    const fact = await this.provider.store({ content: f.content, category: f.category, targetBanks: f.targetBanks, embedder: this.embedder, opts: { sessionKey: this.#sessionKey(), deferSave: true } });
                    if (fact) {
                        storedCount++;
                        sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`Stored new fact: ${fact.content}`] });
                        // ponytail: store() silently refreshes an existing same-session fact, so this can fire on refresh; bank is unknown here.
                        emitMem({ name: EVENTS.MEMORY.FACT_ADDED, payload: {
                            id: fact.id, content: fact.content, category: fact.category ?? null, targetBanks: f.targetBanks ?? []
                        } });
                    }
                }

                if (typeof this.provider.delete === 'function') {
                    for (const fid of obsoleteFactIds) {
                        const deleted = await this.provider.delete({ id: fid, opts: { deferSave: true } });
                        if (deleted) {
                            purgedCount++;
                            sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`Purged obsolete fact ${fid}`] });
                            // ponytail: provider.delete returns only a boolean; the bank is unknown at this layer.
                            emitMem({ name: EVENTS.MEMORY.FACT_OBSOLETE, payload: { id: fid } });
                        }
                    }
                }

                const toTurn = countConversationTurns({ messages: realMessages });
                const prevPersisted = this.provider.lastSyncedTurnIndex ?? 0;
                this.provider.lastSyncedTurnIndex = Math.max(prevPersisted, toTurn);
                try {
                    await this.provider.save();
                } catch (error) {
                    this.provider.lastSyncedTurnIndex = prevPersisted;
                    throw error;
                }
                this.#syncCheckpoint = toTurn;
                sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`Incremental distillation complete. Next sync checkpoint at index ${realMessages.length}`] });
                emitMem({ name: EVENTS.MEMORY.DISTILL_SUCCESS, payload: {
                    newFacts: storedCount,
                    skippedFacts: skippedCount,
                    obsoleteFacts: purgedCount,
                    fromTurn: lastSync,
                    toTurn,
                    model: targetModel ?? null
                } });
            } else {
                this.handleDistillError({ err: new Error(`Memory distillation parsing failed: ${/** @type {any} */ (result).error}`), ctx: {
                    context: { model: targetModel },
                    emitter: options.emitter ?? null,
                    runContext: options.runContext ?? null
                } });
            }
        } catch (error) {
            this.handleDistillError({ err: error, ctx: {
                context: { model: targetModel },
                emitter: options.emitter ?? null,
                runContext: options.runContext ?? null
            } });
        } finally {
            this.#lastAttemptedTurns = countConversationTurns({ messages: realMessages });
        }
    }
}
