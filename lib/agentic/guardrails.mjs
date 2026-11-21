// @ts-check

/**
 * @file Guardrails — the input/output tripwire.
 * @version 0.12.0
 *
 * @description
 * A hook can veto a tool call, but a **guardrail** is a policy about the
 * conversation itself: what may enter the model, and what may leave it. The
 * incumbents ship this as a first-class feature (OpenAI's moderation, the
 * Claude Agent SDK's hook-based tripwires, Guardrails AI's validators); a hook
 * chain is the wrong shape for it, because a hook sees a tool call, not the
 * prompt or the answer.
 *
 * A rule is:
 *
 * ```js
 * { name: 'no-secrets', phase: 'input', pattern: /AKIA[0-9A-Z]{16}/, action: 'block' }
 * ```
 *
 *   - `phase` — `input`, `output` or `both` (default `both`: input and
 *     output), or a tool phase: `tool_input` (a tool call's arguments, checked
 *     before the tool runs) or `tool_output` (its result, checked before the
 *     model sees it).
 *   - `pattern` — a `RegExp`, or a string (matched case-insensitively as a
 *     substring) — or `test`, a predicate `(text) => boolean | Promise<boolean>`
 *     (a moderation call, a classifier), so `check` is async.
 *   - `action` — `block` (the default: the run is refused with a typed
 *     error) or `warn` (the run continues and the match is reported).
 *
 * A rule that matches several times still reports once — the first match
 * wins, so the report names the rule that tripped.
 *
 * The tool phases run as the last `tool:before` / `tool:after` hooks (see
 * `withToolGuardrails`): a blocking `tool_input` rule stops the tool before it
 * runs; a blocking `tool_output` rule replaces the result with a failure, so
 * the model never sees it. `tool_output` judges what a tool *returns*: the
 * message of a tool that *throws* reaches the model unchecked (keep secrets out
 * of tool error messages).
 */
import { HOOKS, STOP, createHooks } from '../core/hooks.mjs';
import { EVENTS, emitEvent } from '../core/events.mjs';
import { sdkWarn } from '../support/utils.mjs';
import { isUserRow } from '../messaging/row-shape.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { ConfigurationError } from '../core/errors.mjs';
import { createDecisionGate } from './decision-gate.mjs';

/**
 * @typedef {Object} GuardrailRule
 * @property {string} [name] - A human-readable name for the rule.
 * @property {GuardrailPhase|'both'} [phase] - Which side of the conversation (or of a tool call) the rule watches.
 * @property {RegExp|string} [pattern] - What trips the rule (or use `test`).
 * @property {(text: string) => unknown} [test] - A predicate (sync or async) that trips the rule when it answers a truthy value.
 * @property {'block'|'warn'} [action] - What happens when it trips.
 * @property {string} [message] - The message shown when it trips.
 */

/**
 * @typedef {'input'|'output'|'tool_input'|'tool_output'} GuardrailPhase
 */

/**
 * @typedef {Object} GuardrailVerdict
 * @property {boolean} blocked - Whether the run must be refused.
 * @property {GuardrailRule|null} rule - The rule that tripped.
 * @property {string} phase - The side that was checked.
 * @property {string} [message] - The message for the report.
 */

const DEFAULT_BLOCK_MESSAGE = 'The guardrail blocked this content.';

/** @type {ReadonlyArray<string>} */
const PHASES = Object.freeze(['input', 'output', 'tool_input', 'tool_output']);


/**
 * Tests a pattern without letting it carry state between checks. `test` advances
 * `lastIndex` on a `/g` or `/y` pattern, so a guardrail written `/AKIA[0-9]{4}/g`
 * would trip on one call and silently miss the next. A stateful pattern is
 * matched with a throwaway copy, so the caller's object is not mutated on the normal
 * path (the exotic-subclass fallback resets `lastIndex` instead).
 * @param {{pattern: RegExp, subject: string}} arg0 -
 * @returns {boolean}
 */
function statelessTest({ pattern, subject }) {
    if (!pattern.global && !pattern.sticky) return pattern.test(subject);
    try {
        return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(subject);
    } catch {
        // An exotic RegExp subclass can throw while its source or flags are read;
        // fall back to a state reset so the check still runs (fail closed).
        pattern.lastIndex = 0;
        return pattern.test(subject);
    }
}

/**
 * Normalizes a caller-supplied rule into the canonical shape.
 * @param {{ rule: GuardrailRule }} arg0 -
 * @returns {GuardrailRule|null} `null` when the rule is unusable.
 */
function normalizeRule({ rule }) {
    if (!rule || typeof rule !== 'object') return null;
    const pattern = rule.pattern;
    const test = typeof rule.test === 'function' ? rule.test : null;
    if (!test && !(pattern instanceof RegExp) && typeof pattern !== 'string') return null;
    const phase = PHASES.includes(/** @type {string} */ (rule.phase)) ? rule.phase : 'both';
    const action = rule.action === 'warn' ? 'warn' : 'block';
    return {
        name: typeof rule.name === 'string' && rule.name ? rule.name : (test ? 'predicate' : String(pattern)),
        phase,
        ...(test ? { test } : { pattern }),
        action,
        message: typeof rule.message === 'string' ? rule.message : DEFAULT_BLOCK_MESSAGE
    };
}

/**
 * Creates the guardrail engine for a set of rules.
 *
 * @param {{ rules?: GuardrailRule[]|null }} arg0 -
 * @returns {Guardrails}
 */
export function createGuardrails({ rules = null } = {}) {
    /** @type {GuardrailRule[]} */
    const normalized = (Array.isArray(rules) ? rules : [])
        .map((rule) => normalizeRule({ rule }))
        .filter((rule) => rule !== null);

    /**
     * Tests one side of the conversation (or of a tool call) against the rules.
     * A predicate that throws propagates: the content is refused, never waved through.
     * @param {{ phase: GuardrailPhase, text: string }} arg0 -
     * @returns {Promise<GuardrailVerdict>}
     */
    const check = async ({ phase, text }) => {
        const subject = typeof text === 'string' ? text : '';
        for (const rule of normalized) {
            const watches = rule.phase === phase || (rule.phase === 'both' && (phase === 'input' || phase === 'output'));
            if (!watches) continue;
            const hit = rule.test
                ? Boolean(await rule.test(subject))
                : rule.pattern instanceof RegExp
                    ? statelessTest({ pattern: rule.pattern, subject })
                    : subject.toLowerCase().includes(String(rule.pattern).toLowerCase());
            if (!hit) continue;
            return {
                blocked: rule.action === 'block',
                rule,
                phase,
                message: rule.message
            };
        }
        return { blocked: false, rule: null, phase };
    };

    /** The tool-phase hooks, or null when no rule watches a tool. */
    let hooks = null;
    if (normalized.some((rule) => rule.phase === 'tool_input' || rule.phase === 'tool_output')) {
        // A waterfall hook is called (value, ctx) by HookRegistry.runWaterfall.
        /** @param {any} call @param {any} ctx */
        const guardToolInput = async (call, ctx) => {
            const verdict = await check({ phase: 'tool_input', text: toolText({ value: call?.args }) });
            return reportToolVerdict({ verdict, tool: call?.name, ctx }) ? STOP : undefined;
        };
        /** @param {any} out @param {any} ctx */
        const guardToolOutput = async (out, ctx) => {
            const verdict = await check({ phase: 'tool_output', text: toolText({ value: out }) });
            if (!reportToolVerdict({ verdict, tool: ctx?.name, ctx })) return undefined;
            return { success: false, error: `Guardrail "${verdict.rule?.name}" blocked the output of tool '${ctx?.name}': ${verdict.message ?? DEFAULT_BLOCK_MESSAGE}` };
        };
        hooks = createHooks();
        hooks.add({ name: HOOKS.TOOL_BEFORE, fn: guardToolInput });
        hooks.add({ name: HOOKS.TOOL_AFTER, fn: guardToolOutput });
    }

    return { rules: normalized, check, hooks };
}

/**
 * The guardrail engine.
 * @typedef {Object} Guardrails
 * @property {GuardrailRule[]} rules
 * @property {(opts: { phase: GuardrailPhase, text: string }) => Promise<GuardrailVerdict>} check
 * @property {import('../core/hooks.mjs').HookRegistry|null} hooks - The tool-phase hooks (null without tool rules).
 */

/**
 * A guardrail predicate backed by the decision gate: `true` only when the gate
 * is certain enough to skip the LLM path. Pair it with `action: 'warn'` by
 * default — a decision model is not the only gate on untrusted input; it trails
 * dedicated injection classifiers rather than replacing them. A gate that
 * escalates answers `false` (the content passes, the dedicated gate still sees
 * it). No new event type: the gate emits `decision_gate` on `emitter`.
 * @param {{ask?: Function|null, question?: import('../messaging/decision.mjs').DecisionQuestion|null, threshold?: number, seam?: string, emitter?: import('node:events').EventEmitter|null}} [arg0]
 *   `ask` is the bound decision surface; `question` is a `noulQuestion`.
 * @returns {(text: string) => Promise<boolean>}
 */
export function decisionTest({ ask = null, question = null, threshold = LIMITS.decision_gate_threshold, seam = 'guardrail', emitter = null } = {}) {
    if (typeof ask !== 'function') throw new ConfigurationError({ message: 'decisionTest requires an ask function from the decision surface.', options: { option: 'ask' } });
    if (question === null) throw new ConfigurationError({ message: 'decisionTest requires a noul question.', options: { option: 'question' } });
    const gate = createDecisionGate({ ask: /** @type {any} */ (ask), threshold, seam, emitter });
    return async (text) => {
        const result = await gate.gate({ state: String(text ?? ''), question });
        return !result.escalated && result.verdict === true && result.certainty !== null && result.certainty >= threshold;
    };
}

/**
 * A tool call's arguments or result as the text a rule tests.
 * @param {{value: unknown}} arg0
 * @returns {string}
 */
function toolText({ value }) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value ?? '') ?? ''; } catch { return String(value); }
}

/**
 * Announces a tool-phase match (the same `guardrail:tripped` event as the
 * conversation phases) and says whether it blocks.
 * @param {{verdict: GuardrailVerdict, tool: unknown, ctx: any}} arg0
 * @returns {boolean} true when the call must be refused
 */
function reportToolVerdict({ verdict, tool, ctx }) {
    if (!verdict.rule) return false;
    const payload = { rule: verdict.rule.name, phase: verdict.phase, action: verdict.rule.action, blocked: verdict.blocked, tool: String(tool ?? '') };
    if (ctx?.runContext?.emit) ctx.runContext.emit({ emitter: ctx.emitter ?? null, name: EVENTS.GUARDRAIL.TRIPPED, payload });
    else emitEvent({ emitter: ctx?.emitter ?? null, name: EVENTS.GUARDRAIL.TRIPPED, payload });
    if (!verdict.blocked) sdkWarn({ prefix: 'GUARDRAIL', args: [`Guardrail "${verdict.rule.name}" matched on the ${verdict.phase} of tool '${String(tool ?? '')}' (${verdict.rule.action}).`] });
    return verdict.blocked;
}

/**
 * The hooks a tool call runs under: the session's own first, then the tool-phase
 * guardrails — so a guardrail sees the arguments and the result the hooks settled
 * on. Neither registry is mutated, so a registry shared with child sessions stays
 * as its owner left it.
 * @param {{guardrails?: Guardrails|null, hooks?: import('../core/hooks.mjs').HookRegistry|null}} arg0
 * @returns {import('../core/hooks.mjs').HookRegistry|null}
 */
export function withToolGuardrails({ guardrails = null, hooks = null }) {
    const guard = guardrails?.hooks ?? null;
    if (!guard) return hooks;
    return /** @type {import('../core/hooks.mjs').HookRegistry} */ (/** @type {unknown} */ ({
        /** @param {{name: string, value: unknown, ctx?: Record<string, unknown>}} arg0 */
        async runWaterfall({ name, value, ctx = {} }) {
            const settled = hooks ? await hooks.runWaterfall({ name, value, ctx }) : value;
            // tool:after STOP means "keep the tool's output": the guard still judges what the model will see.
            if (settled === STOP && name === HOOKS.TOOL_AFTER) return guard.runWaterfall({ name, value, ctx });
            if (settled === STOP) return STOP;
            // A tool:before value without `args` leaves the call's own args in force: judge those.
            const subject = name === HOOKS.TOOL_BEFORE && settled && typeof settled === 'object' && /** @type {any} */ (settled).args === undefined
                ? { .../** @type {Record<string, unknown>} */ (settled), args: /** @type {any} */ (value)?.args }
                : settled;
            return guard.runWaterfall({ name, value: subject, ctx });
        },
        /** @param {{name: string, ctx?: Record<string, unknown>}} arg0 */
        runSerial: ({ name, ctx = {} }) => (hooks ? hooks.runSerial({ name, ctx }) : Promise.resolve([])),
        /** @param {{name: string}} arg0 */
        has: ({ name }) => guard.has({ name }) || !!hooks?.has({ name }),
        /** @param {{name: string}} arg0 */
        count: ({ name }) => guard.count({ name }) + (hooks?.count({ name }) ?? 0),
    }));
}

/**
 * The text of **every** user turn — what a caller typed into the agent.
 *
 * All of it, not just the last turn: a secret in the first turn of a
 * conversation is still on its way to the model in the second turn.
 *
 * @param {{ messages: Array<import('../messaging/unified-message.mjs').MessageRow> }} arg0 -
 * @returns {string}
 */
export function extractUserText({ messages }) {
    const rows = Array.isArray(messages) ? messages : [];
    /** @type {string[]} */
    const turns = [];
    for (const row of rows) {
        // JAI rows are { type: 'user_message' } with no role; every other
        // backend uses role:'user'. Reading only `role` made input guardrails
        // silently inert on the JAI backend.
        if (!isUserRow({ m: row })) continue;
        const content = row.content ?? row.parts ?? null;
        if (typeof content === 'string') {
            if (content) turns.push(content);
            continue;
        }
        if (Array.isArray(content)) {
            const text = content
                .map((part) => (typeof part === 'string' ? part : (part?.type === 'text' ? part.text : '')))
                .filter(Boolean)
                .join('\n');
            if (text) turns.push(text);
        }
    }
    return turns.join('\n');
}
