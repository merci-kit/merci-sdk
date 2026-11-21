// @ts-check
/**
 * @file Unified `ParameterBuilder` for the Merci SDK.
 * @version 0.12.0
 *
 * @description
 * A single fluent builder that exposes the union of the four backend
 * `ParameterBuilder` APIs (OAI / AAI / GAI / JAI). The builder stores a
 * unified spec (camelCase keys, semantic values) regardless of the target
 * backend. Per-backend translator functions convert the spec to wire format
 * at `_build()` time. This is the unified-core + domain-adapter pattern
 * established in the Phase 0–5 backend unification work, applied to the
 * fluent `withParameters(...)` API.
 *
 * The unified spec keys and the wire-format keys are deliberately separated
 * so that:
 *   - The same fluent API works for all four backends.
 *   - Each backend's wire-shape quirks (OAI `top_p` vs GAI `topP` vs AAI
 *     `top_p`; AAI `stop_sequences` always array vs OAI `stop` string-or-array;
 *     JAI V9 keys `TEMPERATURE` / `TOP_P` / `LENGTH`; GAI `maxOutputTokens`
 *     vs OAI `max_tokens`; etc.) are localized to the translator.
 *   - The `withParameters` call sites in each backend shrink to a 5-line
 *     instantiator + translator call.
 *
 * Methods that are unsupported on a given backend emit a `parameter_warning`
 * event on the session's `EventEmitter` and return `this` (no-op). The set
 * of supported methods per backend matches the pre-Phase-10 per-backend
 * builders, so warning behavior is wire-equivalent.
 */

import { ProviderType, StandardType, standardFor } from '../core/constants/index.mjs';
import { sdkWarn, emitParameterWarning } from '../support/utils.mjs';
import { findWireHostileKeywords, isZodSchema, zodSchemaToJsonSchema } from '../support/json.mjs';
/**
 * A named tool-choice directive (the "force this tool" form). The union with
 * `string` covers the 'auto' | 'required' | 'none' shortcuts.
 * @typedef {{ type: 'named', name: string } | string} ToolChoice
 */



/**
 * The unified spec built by `UnifiedParameterBuilder` and consumed by the
 * per-backend translators. All keys are optional — a builder may set only a
 * subset before `_build()`.
 *
 * @typedef {Object} UnifiedSpec
 * @property {number} [temperature]
 * @property {number} [topP]
 * @property {number} [topK]
 * @property {number} [maxTokens]
 * @property {string|string[]} [stop]
 * @property {number} [seed]
 * @property {boolean} [stream]
 * @property {number} [presencePenalty]
 * @property {number} [frequencyPenalty]
 * @property {string} [user]
 * @property {ResponseFormat} [responseFormat]
 * @property {Array<Tool>} [tools]
 * @property {ToolChoice} [toolChoice]
 * @property {boolean} [parallelToolCalls]
 * @property {string} [reasoningEffort]
 * @property {number|'adaptive'} [thinkingBudget] - Token budget, or `'adaptive'` (Anthropic: let the model decide).
 * @property {'low'|'medium'|'high'} [thinkingLevel]
 * @property {string} [reasoningSummary]
 * @property {string} [predictedOutput]
 * @property {number|Record<string, unknown>} [cachePoints] - Prompt-cache breakpoints (Anthropic) — a count, or `{ count, type }`.
 * @property {number} [numberOfChoices]
 * @property {string} [serviceTier] - The vendor's service tier (`auto`, `standard_only`, `priority`, …).
 * @property {boolean} [logprobs] - Ask the vendor for token log probabilities.
 * @property {number} [logprobsTopK] - How many log probabilities per token to return.
 * @property {string} [previousResponseId] - Continue from a stored response (OpenAI Responses).
 * @property {boolean} [store] - Ask the vendor to store the response.
 * @property {string} [cachedContent] - The name of a Gemini cached-content resource to answer from.
 * @property {string} [verbosity]
 * @property {string} [promptCacheKey]
 * @property {Record<string, unknown>} [metadata]
 * @property {string} [_asTool]
 */

/**
 * @typedef {Object} ResponseFormat
 * @property {'text'|'json_object'|'json_schema'|'json'} [type]
 * @property {{name?: string, schema?: import('../support/json.mjs').SchemaLike}} [json_schema]
 * @property {import('../support/json.mjs').SchemaLike} [schema]
 */

/**
 * @typedef {Object} Tool
 * @property {string} [name]
 * @property {string} [description]
 * @property {import('../support/json.mjs').SchemaLike} [parameters]
 * @property {import('../support/json.mjs').SchemaLike} [input_schema]
 * @property {Object} [_structured]
 * @property {Function} [execute] - Present on a tool the SDK runs itself (the wire translators ignore it).
 * @property {boolean} [deferLoading] - Keep the tool out of the model's request until `tool_search` finds it. Execution and permissions still see it.
 */


/**
 * Methods that are not supported on each wire standard, in the shape:
 *   { [standardType]: Set<string> }
 * Methods in this set emit `parameter_warning` and become a no-op when
 * called on a builder constructed with the corresponding `standard`.
 *
 * The sets reflect the pre-Phase-10 per-backend behavior:
 *   - OAI: topK, length, predictedOutput are unsupported. verbosity and
 *     reasoningSummary reach the Responses API; the chat-completions branch
 *     warns and drops them.
 *   - AAI: presencePenalty, frequencyPenalty, seed, length, predictedOutput
 *     are unsupported (reasoningEffort maps to output_config.effort).
 *   - GAI: parallelToolCalls, reasoningEffort, length, predictedOutput are unsupported.
 *     thinkingLevel ('low'|'medium'|'high') is GAI-only (Gemini 3 thinking_level).
 *   - JAI: no methods are unsupported (JAI supports the union).
 */
const THINKING_LEVELS = new Set(['low', 'medium', 'high']);

const _UNSUPPORTED_METHODS = {
    [StandardType.OAI]: new Set([
        'topK', 'length', 'predictedOutput', 'thinkingBudget', 'thinkingLevel',
        'cachePoints', 'numberOfChoices', 'metadata', 'cachedContent'
    ]),
    [StandardType.AAI]: new Set([
        'presencePenalty', 'frequencyPenalty', 'seed',
        'length', 'predictedOutput', 'thinkingLevel', 'reasoningSummary',
        'stream', 'user', 'numberOfChoices', 'verbosity', 'promptCacheKey',
        'logprobs', 'logprobsTopK', 'previousResponseId', 'store', 'cachedContent'
    ]),
    [StandardType.GAI]: new Set([
        'parallelToolCalls', 'reasoningEffort', 'length', 'predictedOutput', 'reasoningSummary',
        'stream', 'user', 'cachePoints', 'numberOfChoices', 'verbosity', 'promptCacheKey', 'metadata',
        'serviceTier', 'previousResponseId', 'store'
    ]),
    [StandardType.JAI]: new Set([
        'stream', 'user', 'metadata', 'thinkingLevel',
        'serviceTier', 'logprobs', 'logprobsTopK', 'previousResponseId', 'store', 'cachedContent'
    ])
};

/**
 * Emits one `parameter_warning` per key of an object-form spec that the
 * configured standard refuses, so `withParameters({ params })` keeps the same
 * contract as the fluent builder (it refused these keys and never let them
 * reach the wire). Keys are matched against the same `_UNSUPPORTED_METHODS`
 * list the builder reads.
 *
 * Every label is optional: the abstract builder may have no standard, model or
 * provider at all (a bare `ChatSessionBuilder`), and an absent label is simply
 * omitted from the warning rather than invented.
 * @param {{standard?: string|undefined, spec?: Record<string, unknown>|null, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, model?: string|undefined, provider?: string|undefined}} arg0
 * @returns {void}
 */
export function warnRefusedSpecKeys({ standard, spec, eventEmitter = null, model = '', provider = '' }) {
    const unsupported = typeof standard === 'string' ? _UNSUPPORTED_METHODS[/** @type {string} */ (standard)] : undefined;
    if (!unsupported || !spec) return;
    for (const [key, value] of Object.entries(spec)) {
        // A spread-built spec carries absent keys as `undefined`; that is not a
        // refusal, it is an unset parameter.
        if (value === undefined || !unsupported.has(key)) continue;
        emitParameterWarning({ emitter: eventEmitter, model, parameter: key, message: `Parameter '${key}' is ignored in ${standard} standard.`, provider, standard });
    }
}

/**
 * Unified `ParameterBuilder`. Stores a single unified spec (see the
 * `UnifiedSpec` typedef for the key/value surface) and emits
 * `parameter_warning` events for methods that are unsupported on the
 * configured backend. Always returns `this` from fluent setters so callers
 * can chain.
 */
export class UnifiedParameterBuilder {
    /**
 * @param {{model: string, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, provider?: string, standard?: string}} arg0
 */
    constructor({ model, eventEmitter = null, provider = ProviderType.OPENAI, standard = standardFor({ provider }) ?? '' }) {
        this.model = model;
        /** @type {import('node:events').EventEmitter<Record<string, unknown[]>>|null} */
        this.eventEmitter = eventEmitter;
        this.provider = provider;
        this.standard = standard;
        /** @type {UnifiedSpec} */
        this._spec = {};
    }

    /**
 * @param {{methodName: string}} arg0
 * @private
 */
    _unsupported({ methodName }) {
        const unsupported = _UNSUPPORTED_METHODS[/** @type {string} */ (this.standard)];
        if (unsupported && unsupported.has(methodName)) {
            this._warn({ parameter: methodName, message: `Parameter '${methodName}' is ignored in ${this.standard} standard.` });
            return true;
        }
        return false;
    }

    /**
 * @param {{parameter: string, message: string}} arg0
 * @private
 */
    _warn({ parameter, message }) {
        emitParameterWarning({ emitter: this.eventEmitter, model: this.model, parameter, message, provider: this.provider, standard: this.standard });
    }

    /**
 * @param {{schema: any, label: string}} arg0
 * @private
 * Normalizes a caller-supplied schema for the wire.
 *
 */
    _toWireSchema({ schema, label }) {
        if (!schema) return schema;
        let wire = schema;
        if (isZodSchema({ schema })) {
            wire = zodSchemaToJsonSchema({ zodSchema: schema });
            if (!wire) {
                this._warn({ parameter: label, message: 'Zod schema could not be converted to JSON Schema (Zod v3 is not supported here) — pass a Zod v4 schema or plain JSON Schema.' });
                return null;
            }
        }
        const hostile = findWireHostileKeywords({ node: wire });
        if (hostile.size > 0) {
            this._warn({ parameter: label, message: `Schema uses ${[...hostile].join(', ')}, which JAI/Gemini reject — express it without unions or nullable fields.` });
        }
        return wire;
    }

    /**
 * @param {{key: string, value: unknown}} arg0
 * @private
 */
    _set({ key, value }) {
        /** @type {Record<string, unknown>} */ (this._spec)[key] = value;
        return this;
    }

    /**
 * @param {{methodName: string, specKey: string, value: unknown}} arg0
 * @private
 * Fluent setter: no-op with a `parameter_warning` when the backend does not
 * support `methodName`, otherwise stores `value` under `specKey`.
 */
    _supportedSet({ methodName, specKey, value }) {
        if (this._unsupported({ methodName })) return this;
        return this._set({ key: specKey, value });
    }

    /**
 * @param {{v: number}} arg0
 */
    temperature({ v }) { this._set({ key: 'temperature', value: v }); return this; }
    /**
 * @param {{v: number}} arg0
 */
    topP({ v }) { this._set({ key: 'topP', value: v }); return this; }

    /**
 * @param {{v: number}} arg0
 */
    topK({ v }) { return this._supportedSet({ methodName: 'topK', specKey: 'topK', value: v }); }

    /**
 * @param {{v: number}} arg0
 */
    maxTokens({ v }) { this._set({ key: 'maxTokens', value: v }); return this; }

    /** @param {string|string[]} v */
    stop(v) { this._set({ key: 'stop', value: v }); return this; }

    /**
 * @param {{v: number}} arg0
 */
    seed({ v }) { return this._supportedSet({ methodName: 'seed', specKey: 'seed', value: v }); }

    /** @param {boolean} v */
    stream(v) { return this._supportedSet({ methodName: 'stream', specKey: 'stream', value: v }); }

    /**
 * @param {{v: number}} arg0
 */
    presencePenalty({ v }) { return this._supportedSet({ methodName: 'presencePenalty', specKey: 'presencePenalty', value: v }); }

    /**
 * @param {{v: number}} arg0
 */
    frequencyPenalty({ v }) { return this._supportedSet({ methodName: 'frequencyPenalty', specKey: 'frequencyPenalty', value: v }); }

    /** @param {string} v */
    user(v) { return this._supportedSet({ methodName: 'user', specKey: 'user', value: v }); }

    /**
 * @param {{v: number}} arg0
 */
    length({ v }) { return this._supportedSet({ methodName: 'length', specKey: 'maxTokens', value: v }); }

    /**
 * @param {{v: string}} arg0
 */
    stopToken({ v }) { return this._set({ key: 'stop', value: v }); }

    /**
 * @param {{v: ResponseFormat}} arg0
 */
    responseFormat({ v }) {
        this._set({ key: 'responseFormat', value: v });
        return this;
    }

    asText() {
        this._set({ key: 'responseFormat', value: { type: 'text' } });
        return this;
    }

    asJson() {
        this._set({ key: 'responseFormat', value: { type: 'json_object' } });
        return this;
    }

    /** @param {{config: {name?: string, schema?: import('../support/json.mjs').SchemaLike}|import('../support/json.mjs').SchemaLike}} arg0 */
    asJsonSchema({ config }) {
        const cfg = /** @type {{name?: string, schema?: import('../support/json.mjs').SchemaLike}} */ (config);
        const wrapped = config && cfg.schema !== undefined;
        this._set({ key: 'responseFormat', value: {
            type: 'json_schema',
            json_schema: {
                name: (wrapped && cfg.name) || 'response',
                schema: wrapped ? cfg.schema : config
            }
        } });
        return this;
    }

    /**
     * JAI-style alias for `asJsonSchema(config)`. Sets response format to
     * `json` and attaches the schema.
     */
    /**
 * @param {{schema: import('../support/json.mjs').SchemaLike}} arg0
 */
    withSchema({ schema }) {
        return this.asJsonSchema({ config: schema });
    }

    /**
     * Use a forced tool call instead of `response_format` for structured output.
     * Tool-call extraction gives the model a concrete action to produce, which
     * typically yields higher quality than `json_schema` on the same backend.
     * Call BEFORE or AFTER `withSchema` — order doesn't matter.
     */
    /**
 * @param {{toolName?: string}} arg0
 */
    asTool({ toolName = 'structured_output' } = {}) {
        this._set({ key: '_asTool', value: toolName });
        return this;
    }

    /** @param {Array<Tool>} v */
    tools(v) {
        this._set({ key: 'tools', value: v });
        return this;
    }

    /**
 * @param {{v: ToolChoice}} arg0
 */
    toolChoice({ v }) {
        this._set({ key: 'toolChoice', value: v });
        return this;
    }

    toolChoiceAuto() { return this.toolChoice({ v: 'auto' }); }
    toolChoiceRequired() { return this.toolChoice({ v: 'required' }); }
    toolChoiceNone() { return this.toolChoice({ v: 'none' }); }
    /**
 * @param {{name: string}} arg0
 */
    toolChoiceNamed({ name }) {
        return this.toolChoice({ v: { type: 'named', name } });
    }

    /**
 * @param {{v: boolean}} arg0
 */
    parallelToolCalls({ v }) { return this._supportedSet({ methodName: 'parallelToolCalls', specKey: 'parallelToolCalls', value: v }); }

    /**
 * @param {{v: string}} arg0
 */
    reasoningEffort({ v }) {
        if (this.standard === StandardType.JAI && this._spec.thinkingBudget !== undefined) {
            sdkWarn({ prefix: 'PARAMS', args: ['reasoningEffort and thinkingBudget are mutually exclusive (JAI). The translator drops thinkingBudget.'] });
        }
        return this._supportedSet({ methodName: 'reasoningEffort', specKey: 'reasoningEffort', value: v });
    }
    /**
 * Responses-protocol reasoning summary detail (JAI responses / OAI could
 * map it later) — dropped with a warning on chat protocols.
 * @param {{v: string}} arg0
 */

    reasoningSummary({ v }) { return this._supportedSet({ methodName: 'reasoningSummary', specKey: 'reasoningSummary', value: v }); }

    /**
 * @param {{v: number|'adaptive'}} arg0
 */
    thinkingBudget({ v }) {
        if (v === 'adaptive' && this.standard !== StandardType.AAI) {
            this._warn({ parameter: 'thinkingBudget', message: "thinkingBudget 'adaptive' is Anthropic-only and is ignored in this standard." });
            return this;
        }
        if (this.standard === StandardType.GAI && this._spec.thinkingLevel !== undefined) {
            sdkWarn({ prefix: 'PARAMS', args: ['thinkingLevel and thinkingBudget are mutually exclusive (GAI). The translator drops thinkingBudget.'] });
        }
        if (this.standard === StandardType.JAI && this._spec.reasoningEffort !== undefined) {
            sdkWarn({ prefix: 'PARAMS', args: ['reasoningEffort and thinkingBudget are mutually exclusive (JAI). The translator drops thinkingBudget.'] });
        }
        return this._supportedSet({ methodName: 'thinkingBudget', specKey: 'thinkingBudget', value: v });
    }

    /**
 * @param {{v: 'low'|'medium'|'high'}} arg0
 */
    thinkingLevel({ v }) {
        if (this._unsupported({ methodName: 'thinkingLevel' })) return this;
        if (!THINKING_LEVELS.has(v)) {
            sdkWarn({ prefix: 'PARAMS', args: [`thinkingLevel must be one of low | medium | high (got: ${v}). Ignored.`] });
            return this;
        }
        if (this.standard === StandardType.GAI && this._spec.thinkingBudget !== undefined) {
            sdkWarn({ prefix: 'PARAMS', args: ['thinkingLevel and thinkingBudget are mutually exclusive (GAI). The translator drops thinkingBudget.'] });
        }
        return this._set({ key: 'thinkingLevel', value: v });
    }

    /**
 * @param {{v: string}} arg0
 */
    predictedOutput({ v }) { return this._supportedSet({ methodName: 'predictedOutput', specKey: 'predictedOutput', value: v }); }

    /**
 * @param {{v: Record<string, unknown>}} arg0
 */
    cachePoints({ v }) { return this._supportedSet({ methodName: 'cachePoints', specKey: 'cachePoints', value: v }); }

    /**
 * @param {{v: number}} arg0
 */
    numberOfChoices({ v }) { return this._supportedSet({ methodName: 'numberOfChoices', specKey: 'numberOfChoices', value: v }); }

    /**
 * @param {{v: string}} arg0
 */
    verbosity({ v }) { return this._supportedSet({ methodName: 'verbosity', specKey: 'verbosity', value: v }); }

    /**
 * @param {{v: string}} arg0
 */
    promptCacheKey({ v }) { return this._supportedSet({ methodName: 'promptCacheKey', specKey: 'promptCacheKey', value: v }); }

    /**
     * The vendor's service tier. OpenAI: `auto` | `default` | `flex` |
     * `priority`; Anthropic: `auto` | `standard_only` | `priority`.
     * @param {{v: string}} arg0
     */
    serviceTier({ v }) { return this._supportedSet({ methodName: 'serviceTier', specKey: 'serviceTier', value: v }); }

    /**
     * Asks the vendor for token log probabilities.
     * @param {{v: boolean}} arg0
     */
    logprobs({ v }) { return this._supportedSet({ methodName: 'logprobs', specKey: 'logprobs', value: v }); }

    /**
     * How many log probabilities per token the vendor returns.
     * @param {{v: number}} arg0
     */
    logprobsTopK({ v }) { return this._supportedSet({ methodName: 'logprobsTopK', specKey: 'logprobsTopK', value: v }); }

    /**
     * Continues from a stored response (the OpenAI Responses API).
     * @param {{v: string}} arg0
     */
    previousResponseId({ v }) { return this._supportedSet({ methodName: 'previousResponseId', specKey: 'previousResponseId', value: v }); }

    /**
     * Asks the vendor to store the response so it can be continued later.
     * @param {{v: boolean}} arg0
     */
    store({ v }) { return this._supportedSet({ methodName: 'store', specKey: 'store', value: v }); }

    /**
     * The name of a Gemini cached-content resource the answer may be served
     * from. Gemini's *implicit* caching needs no parameter; this is the
     * explicit cache (a resource the caller created out of band).
     * @param {{v: string}} arg0
     */
    cachedContent({ v }) { return this._supportedSet({ methodName: 'cachedContent', specKey: 'cachedContent', value: v }); }

    /**
 * @param {{v: Record<string, unknown>}} arg0
 */
    metadata({ v }) { return this._supportedSet({ methodName: 'metadata', specKey: 'metadata', value: v }); }

    /**
     * Returns the unified spec. Callers (per-backend `withParameters` methods)
     * pass this to the per-backend translator (`buildParameterMapForXxx`)
     * to obtain the wire-format object that the backend's `step()` consumes.
     *
     * For backwards compat with the pre-Phase-10 per-backend builders
     * (whose `_build()` returned the wire format), each backend's
     * `withParameters` calls the per-backend translator after this.
     * @returns {UnifiedSpec} The unified spec (camelCase keys, semantic values).
     */
    /**
     * Terminal method: finalizes and returns the unified spec. Public alias of
     * the internal `_build()` used by the per-backend translators.
     * @returns {UnifiedSpec}
     */
    build() {
        return this._build();
    }

    _build() {
        /** @type {UnifiedSpec} */
        const spec = { ...this._spec };
        if (spec.responseFormat?.type === 'json_schema') {
            const rawSchema = spec.responseFormat.json_schema?.schema ?? spec.responseFormat.schema;
            const wire = this._toWireSchema({ schema: rawSchema, label: 'schema' });
            if (wire) {
                const { schema: _dropSchema, ...restRf } = spec.responseFormat;
                spec.responseFormat = {
                    ...restRf,
                    json_schema: {
                        name: spec.responseFormat.json_schema?.name || 'response',
                        ...spec.responseFormat.json_schema,
                        schema: wire
                    }
                };
            } else {
                delete spec.responseFormat;
            }
        } else if (spec.responseFormat?.type === 'json' && spec.responseFormat.schema !== undefined) {
            const wire = this._toWireSchema({ schema: spec.responseFormat.schema, label: 'schema' });
            if (wire) {
                spec.responseFormat = { ...spec.responseFormat, schema: wire };
            } else {
                delete spec.responseFormat;
            }
        }
        if (Array.isArray(spec.tools)) {
            /** @type {Tool[]} */
            const kept = [];
            for (const t of spec.tools) {
                if (!t?.parameters) {
                    if (t?.input_schema && typeof t.input_schema === 'object') {
                        const wire = this._toWireSchema({ schema: t.input_schema, label: `tool.parameters[${t.name}]` });
                        if (!wire) continue;
                        kept.push({ ...t, parameters: wire, input_schema: wire });
                        continue;
                    }
                    kept.push(t);
                    continue;
                }
                const wire = this._toWireSchema({ schema: t.parameters, label: `tool.parameters[${t.name}]` });
                if (!wire) continue;
                kept.push({ ...t, parameters: wire });
            }
            spec.tools = kept;
        }
        if (spec._asTool) {
            if (spec.responseFormat?.type === 'json_schema' || (spec.responseFormat?.type === 'json' && spec.responseFormat?.schema)) {
                const schema = spec.responseFormat?.json_schema?.schema ?? spec.responseFormat?.schema;
                const name = spec._asTool;
                if (schema) {
                    spec.tools = [
                        ...(spec.tools || []),
                        { name, description: 'Return structured output matching the schema.', parameters: schema, _structured: true }
                    ];
                    spec.toolChoice = { type: 'named', name };
                }
                delete spec.responseFormat;
            } else {
                this._warn({ parameter: 'asTool', message: "Parameter 'asTool' is ignored without asJsonSchema/withSchema." });
            }
            delete spec._asTool;
        }
        return spec;
    }
}

/**
 * Copies every present unified key to the wire map under its backend wire
 * name. Absent keys are skipped (never emitted as `undefined`).
 * @param {{spec: UnifiedSpec, params: Record<string, any>, mapping: Record<string, string>}} arg0
 */
function mapPresentKeys({ spec, params, mapping }) {
    for (const [unifiedKey, wireKey] of Object.entries(mapping)) {
        if (/** @type {any} */ (spec)[unifiedKey] === undefined) continue;
        if (wireKey === 'THINKING_BUDGET' && spec.reasoningEffort !== undefined) {
            continue;
        }
        params[wireKey] = /** @type {any} */ (spec)[unifiedKey];
    }
}

/**
 * Shared shape of the per-backend tool-choice remap used by OAI/GAI/AAI:
 * a string passes through (except `required` when `requiredValue` is set,
 * e.g. AAI's 'any'), a unified `named` directive maps to the backend's
 * `{ [typeKey]: type, [nameKey]: name }` object, anything else passes
 * through untouched.
 * @param {{toolChoice: ToolChoice, opts?: *}} arg0
 * @returns {any} The backend tool-choice value.
 */
function mapToolChoice({ toolChoice, opts = {} }) {
    if (typeof toolChoice === 'string') {
        return (toolChoice === 'required' && opts.requiredValue !== undefined) ? opts.requiredValue : toolChoice;
    }
    if (toolChoice && toolChoice.type === 'named' && toolChoice.name) {
        return { [opts.typeKey ?? 'type']: opts.namedType ?? 'named', [opts.nameKey ?? 'name']: toolChoice.name };
    }
    return toolChoice;
}

/**
 * Resolves the effective JSON schema out of a unified responseFormat:
 * `json_schema.schema` (the builder's wrapped shape), a raw `json_schema`
 * object, or a legacy top-level `schema`.
 * @param {{rf: ResponseFormat}} arg0
 * @returns {any}
 */
function responseFormatSchema({ rf }) {
    return rf.json_schema?.schema ?? rf.json_schema ?? rf.schema;
}

/**
 * Maps a unified tool to the AAI/JAI `input_schema` wire shape.
 * @param {Tool} t
 * @returns {Record<string, any>}
 */
function toInputSchemaTool(t) {
    return {
        name: t.name,
        description: t.description,
        input_schema: t.parameters || t.input_schema || { type: 'object', properties: {} }
    };
}

/**
 * Translates a unified spec to the OAI wire format. Maps camelCase unified
 * keys to OAI's snake_case wire names and emits the OAI-shaped `tools` array
 * and `tool_choice` field. Fields the OAI `step()` reads but that are not
 * part of the unified spec (e.g. `stream_options`) are added at step time.
 * @param {{spec: UnifiedSpec}} arg0
 * @returns {Record<string, unknown>} The OAI wire-format parameter map.
 */
export function buildParameterMapForOai({ spec }) {
    /** @type {Record<string, any>} */
    const params = {};
    mapPresentKeys({ spec, params, mapping: {
        temperature: 'temperature',
        topP: 'top_p',
        maxTokens: 'max_tokens',
        stop: 'stop',
        seed: 'seed',
        presencePenalty: 'presence_penalty',
        frequencyPenalty: 'frequency_penalty',
        reasoningEffort: 'reasoning_effort',
        reasoningSummary: 'reasoning_summary',
        verbosity: 'verbosity',
        user: 'user',
        stream: 'stream',
        parallelToolCalls: 'parallel_tool_calls',
        responseFormat: 'response_format',
        serviceTier: 'service_tier',
        logprobs: 'logprobs',
        logprobsTopK: 'top_logprobs',
        previousResponseId: 'previous_response_id',
        store: 'store',
        promptCacheKey: 'prompt_cache_key'
    } });
    // OpenAI ignores `top_logprobs` unless `logprobs` is true, so asking for
    // the top-k implies the flag.
    if (spec.logprobsTopK !== undefined && spec.logprobs === undefined) params.logprobs = true;
    if (spec.tools !== undefined) {
        params.tools = spec.tools.map(/** @type {(...args: any[]) => any} */ (t => {
            const p = t.parameters ?? t.input_schema;
            return {
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    ...(p !== undefined ? { parameters: p } : {})
                }
            };
        }));
    }
    if (spec.toolChoice !== undefined) {
        if (typeof spec.toolChoice === 'string') {
            params.tool_choice = spec.toolChoice;
        } else if (spec.toolChoice && spec.toolChoice.type === 'named' && spec.toolChoice.name) {
            params.tool_choice = { type: 'function', function: { name: spec.toolChoice.name } };
        } else {
            params.tool_choice = spec.toolChoice;
        }
    }
    return params;
}

/**
 * Translates a unified spec to AAI's internal `_parameters` shape. AAI's
 * `step()` reads from the underscored fields (`_jsonMode`, `_jsonSchema`,
 * `_tools`, `_toolChoice`, `_parallelToolCalls`) which are set here.
 * The snake_case top-level fields (`temperature`, `top_p`, `top_k`,
 * `max_tokens`, `stop_sequences`, `thinking`, `metadata`) are AAI wire names
 * and pass through directly.
 * @param {{spec: UnifiedSpec}} arg0
 * @returns {Record<string, unknown>} The AAI internal `_parameters` shape.
 */
export function buildParameterMapForAai({ spec }) {
    /** @type {Record<string, any>} */
    const params = {};
    mapPresentKeys({ spec, params, mapping: {
        temperature: 'temperature',
        topP: 'top_p',
        topK: 'top_k',
        maxTokens: 'max_tokens'
    } });
    if (spec.stop !== undefined) params.stop_sequences = Array.isArray(spec.stop) ? spec.stop : [spec.stop];
    if (spec.thinkingBudget !== undefined) {
        // `'adaptive'` is Anthropic-only and stays opt-in: deriving it from an
        // effort level would make an unsupported model answer with a 400.
        params.thinking = spec.thinkingBudget === 'adaptive'
            ? { type: 'adaptive' }
            : (spec.thinkingBudget > 0
                ? { type: 'enabled', budget_tokens: spec.thinkingBudget }
                : { type: 'disabled' });
    }
    // Anthropic carries effort in `output_config.effort`; it is not a
    // top-level `reasoning_effort` and it does not imply adaptive thinking.
    if (spec.reasoningEffort !== undefined) {
        params.output_config = { ...(params.output_config ?? {}), effort: spec.reasoningEffort };
    }
    mapPresentKeys({ spec, params, mapping: { metadata: 'metadata' } });
    mapPresentKeys({ spec, params, mapping: { serviceTier: 'service_tier' } });

    // Anthropic marks cache breakpoints on the **message content blocks**, not
    // on a request parameter. The adapter reads this count and marks the last
    // N messages with `cache_control: { type: 'ephemeral' }`.
    if (spec.cachePoints !== undefined) {
        const raw = spec.cachePoints;
        const count = typeof raw === 'number' ? raw : Number(raw?.count ?? 1);
        params._cachePoints = Number.isFinite(count) && count > 0 ? Math.min(4, Math.floor(count)) : 1;
        params._cachePointType = (typeof raw === 'object' && raw?.type) ? String(raw.type) : 'ephemeral';
    }

    if (spec.responseFormat !== undefined) {
        const rf = spec.responseFormat;
        if (rf.type === 'json_object' || rf.type === 'json') {
            params._jsonMode = true;
        } else if (rf.type === 'json_schema') {
            params._jsonMode = true;
            const schema = responseFormatSchema({ rf });
            if (schema) params._jsonSchema = schema;
        }
    }

    if (spec.tools !== undefined) {
        params._tools = spec.tools.map(toInputSchemaTool);
    }

    if (spec.toolChoice !== undefined) {
        params._toolChoice = mapToolChoice({ toolChoice: spec.toolChoice, opts: { requiredValue: 'any', namedType: 'tool' } });
    }

    if (spec.parallelToolCalls !== undefined) params._parallelToolCalls = spec.parallelToolCalls;

    return params;
}

/**
 * Translates a unified spec to GAI's internal `_parameters` shape. GAI uses
 * camelCase wire names (`topP`, `topK`, `maxOutputTokens`, `stopSequences`,
 * `responseMimeType`, `responseJsonSchema`, `presencePenalty`,
 * `frequencyPenalty`, `thinkingConfig.thinkingBudget`). GAI's `step()` reads
 * from `_tools` and `_toolConfig`.
 * @param {{spec: UnifiedSpec}} arg0
 * @returns {Record<string, unknown>} The GAI internal `_parameters` shape.
 */
export function buildParameterMapForGai({ spec }) {
    /** @type {Record<string, any>} */
    const params = {};
    mapPresentKeys({ spec, params, mapping: {
        temperature: 'temperature',
        topP: 'topP',
        topK: 'topK'
    } });
    if (spec.maxTokens !== undefined) params.maxOutputTokens = spec.maxTokens;
    if (spec.stop !== undefined) params.stopSequences = Array.isArray(spec.stop) ? spec.stop : [spec.stop];
    mapPresentKeys({ spec, params, mapping: {
        seed: 'seed',
        presencePenalty: 'presencePenalty',
        frequencyPenalty: 'frequencyPenalty'
    } });
    if (spec.logprobs !== undefined) params.responseLogprobs = spec.logprobs;
    if (spec.logprobsTopK !== undefined) params.logprobs = spec.logprobsTopK;
    if (spec.cachedContent !== undefined) params.cachedContent = spec.cachedContent;

    if (spec.responseFormat !== undefined) {
        const rf = spec.responseFormat;
        if (rf.type === 'json_object' || rf.type === 'json') {
            params.responseMimeType = 'application/json';
        } else if (rf.type === 'json_schema') {
            params.responseMimeType = 'application/json';
            const schema = responseFormatSchema({ rf });
            if (schema) params.responseJsonSchema = schema;
        } else if (rf.type === 'text') {
            params.responseMimeType = 'text/plain';
        }
    }

    if (spec.thinkingLevel !== undefined) {
        params.thinkingConfig = { thinkingLevel: spec.thinkingLevel, includeThoughts: true };
    } else if (typeof spec.thinkingBudget === 'number') {
        params.thinkingConfig = { thinkingBudget: spec.thinkingBudget, includeThoughts: spec.thinkingBudget > 0 };
    }

    if (spec.tools !== undefined) {
        params._tools = spec.tools.map(/** @type {(...args: any[]) => any} */ (t => {
            const p = t.parameters ?? t.input_schema;
            return {
                name: t.name,
                description: t.description,
                ...(p !== undefined ? { parametersJsonSchema: p } : {})
            };
        }));
    }

    if (spec.toolChoice !== undefined) {
        params._toolConfig = mapToolChoice({ toolChoice: spec.toolChoice });
    }

    return params;
}

/**
 * Translates a unified spec to the JAI V9-keyed spec that `buildParametersV9`
 * consumes. V9 keys are uppercase snake (`TEMPERATURE`, `TOP_P`, `TOP_K`,
 * `LENGTH`, `STOP_TOKEN`, `SEED`, `RESPONSE_FORMAT`, `TOOL_CHOICE_*`,
 * `PARALLEL_TOOL_CALLS`, `REASONING_EFFORT`, `REASONING_SUMMARY`, `PREDICTED_OUTPUT`,
 * `CACHE_POINTS`, `THINKING_BUDGET`, `NUMBER_OF_CHOICES`, `VERBOSITY`,
 * `PROMPT_CACHE_KEY`).
 * The JAI's `withParameters` then passes this spec to `buildParametersV9`
 * to produce the wire-format object stored in `session._parameters`.
 * @param {{spec: UnifiedSpec}} arg0
 * @returns {Record<string, unknown>} The JAI V9-keyed spec.
 */
export function buildParameterMapForJai({ spec }) {
    /** @type {Record<string, any>} */
    const params = {};
    mapPresentKeys({ spec, params, mapping: {
        temperature: 'TEMPERATURE',
        topP: 'TOP_P',
        topK: 'TOP_K',
        maxTokens: 'LENGTH'
    } });
    if (spec.stop !== undefined) {
        params.STOP_TOKEN = Array.isArray(spec.stop) ? spec.stop[0] : spec.stop;
    }
    if (spec.seed !== undefined) params.SEED = spec.seed;

    if (spec.responseFormat !== undefined) {
        const rf = spec.responseFormat;
        if (rf.type === 'text') {
            params.RESPONSE_FORMAT = { type: 'text' };
        } else {
            params.RESPONSE_FORMAT = { type: 'json' };
            const schema = responseFormatSchema({ rf });
            if (schema) params.RESPONSE_FORMAT.schema = schema;
            if (!spec.toolChoice && !(spec.tools && spec.tools.length > 0)) {
                params.TOOL_CHOICE_NONE = true;
            }
        }
    }

    if (spec.toolChoice !== undefined) {
        if (spec.toolChoice === 'auto') params.TOOL_CHOICE_AUTO = true;
        else if (spec.toolChoice === 'required') params.TOOL_CHOICE_REQUIRED = true;
        else if (spec.toolChoice === 'none') params.TOOL_CHOICE_NONE = true;
        else if (typeof spec.toolChoice === 'object' && spec.toolChoice.type === 'named' && spec.toolChoice.name) {
            params.TOOL_CHOICE_NAMED = spec.toolChoice.name;
        }
    }

    if (spec.tools !== undefined) {
        params._tools = spec.tools.map(toInputSchemaTool);
    }

    mapPresentKeys({ spec, params, mapping: {
        parallelToolCalls: 'PARALLEL_TOOL_CALLS',
        reasoningEffort: 'REASONING_EFFORT',
        reasoningSummary: 'REASONING_SUMMARY',
        predictedOutput: 'PREDICTED_OUTPUT',
        cachePoints: 'CACHE_POINTS',
        thinkingBudget: 'THINKING_BUDGET',
        numberOfChoices: 'NUMBER_OF_CHOICES',
        verbosity: 'VERBOSITY',
        promptCacheKey: 'PROMPT_CACHE_KEY'
    } });

    return params;
}
