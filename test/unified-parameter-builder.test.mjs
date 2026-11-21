// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { ProviderType } from '../lib/core/constants/index.mjs';
import {
    UnifiedParameterBuilder,
    buildParameterMapForOai as wireOai,
    buildParameterMapForAai as wireAai,
    buildParameterMapForGai as wireGai,
    buildParameterMapForJai as wireJai
} from '../lib/messaging/unified-parameter.mjs';

// The wire maps are open records — each backend has its own keys — so this
// suite reads them loosely; the library's own return type stays strict.
/** @type {(arg0: {spec: import('../lib/messaging/unified-parameter.mjs').UnifiedSpec}) => Record<string, any>} */
const buildParameterMapForOai = wireOai;
/** @type {(arg0: {spec: import('../lib/messaging/unified-parameter.mjs').UnifiedSpec}) => Record<string, any>} */
const buildParameterMapForAai = wireAai;
/** @type {(arg0: {spec: import('../lib/messaging/unified-parameter.mjs').UnifiedSpec}) => Record<string, any>} */
const buildParameterMapForGai = wireGai;
/** @type {(arg0: {spec: import('../lib/messaging/unified-parameter.mjs').UnifiedSpec}) => Record<string, any>} */
const buildParameterMapForJai = wireJai;

import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { ChatSession as AaiChatSession } from '../lib/backends/aai.mjs';
import { ChatSession as GaiChatSession } from '../lib/backends/gai.mjs';
import { ChatSession as JaiChatSession } from '../lib/backends/jai.mjs';

// ==================================================================================
// ==================================================================================

describe('UnifiedParameterBuilder — fluent API', () => {
    it('exposes the common fluent surface (chainable)', () => {
        const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI });
        assert.equal(typeof b.temperature, 'function');
        assert.equal(typeof b.topP, 'function');
        assert.equal(typeof b.maxTokens, 'function');
        assert.equal(typeof b.stop, 'function');
        assert.equal(typeof b.asText, 'function');
        assert.equal(typeof b.asJson, 'function');
        assert.equal(typeof b.toolChoiceAuto, 'function');
        assert.equal(typeof b.toolChoiceRequired, 'function');
        assert.equal(typeof b.toolChoiceNone, 'function');
        assert.equal(typeof b.toolChoiceNamed, 'function');
        assert.equal(typeof b._build, 'function');
    });

    it('every setter returns the builder for chaining', () => {
        const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI });
        for (const m of ['temperature', 'topP', 'maxTokens', 'stop', 'asText', 'asJson']) {
            assert.strictEqual((/** @type {any} */ (b))[m](0.5), b, `${m} should return the builder`);
        }
        for (const m of ['toolChoiceAuto', 'toolChoiceRequired', 'toolChoiceNone']) {
            assert.strictEqual((/** @type {any} */ (b))[m](), b, `${m} should return the builder`);
        }
        assert.strictEqual(b.toolChoiceNamed({ name: 'search' }), b, 'toolChoiceNamed should return the builder');
    });

    it('_build() returns a copy of the spec (no internal-state aliasing)', () => {
        const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI }).temperature({ v: 0.5 });
        const built = b._build();
        built.temperature = 999;
        const built2 = b._build();
        assert.equal(built2.temperature, 0.5, 'mutating the result of _build() should not affect the builder');
    });

    it('writes temperature / topP / maxTokens / stop to the unified spec', () => {
        const spec = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI })
            .temperature({ v: 0.5 }).topP({ v: 0.9 }).maxTokens({ v: 100 }).stop('END')._build();
        assert.equal(spec.temperature, 0.5);
        assert.equal(spec.topP, 0.9);
        assert.equal(spec.maxTokens, 100);
        assert.equal(spec.stop, 'END');
    });

    it('asText / asJson / asJsonSchema / withSchema set responseFormat with the expected shape', () => {
        const text = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI }).asText()._build();
        assert.deepEqual(text.responseFormat, { type: 'text' });

        const json = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI }).asJson()._build();
        assert.deepEqual(json.responseFormat, { type: 'json_object' });

        const schema = { type: 'object', properties: { x: { type: 'number' } } };
        const js = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI }).asJsonSchema({ config: { schema } })._build();
        assert.equal((/** @type {any} */ (js)).responseFormat.type, 'json_schema');
        assert.deepEqual((/** @type {any} */ (js)).responseFormat.json_schema.schema, schema);

        const w = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI }).withSchema({ schema })._build();
        assert.equal((/** @type {any} */ (w)).responseFormat.type, 'json_schema');
        assert.deepEqual((/** @type {any} */ (w)).responseFormat.json_schema.schema, schema);
    });

    it('toolChoiceAuto / toolChoiceRequired / toolChoiceNone set the string sentinel', () => {
        const a = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI }).toolChoiceAuto()._build();
        assert.equal(a.toolChoice, 'auto');
        const r = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI }).toolChoiceRequired()._build();
        assert.equal(r.toolChoice, 'required');
        const n = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI }).toolChoiceNone()._build();
        assert.equal(n.toolChoice, 'none');
    });

    it('toolChoiceNamed(name) sets the unified { type: "named", name } shape', () => {
        const s = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI }).toolChoiceNamed({ name: 'search' })._build();
        assert.deepEqual(s.toolChoice, { type: 'named', name: 'search' });
    });
});

// ==================================================================================
// SECTION 2: parameter_warning events
// ==================================================================================

describe('UnifiedParameterBuilder — parameter_warning events', () => {
    it('OAI: topK, length, predictedOutput emit warnings and are no-ops', () => {
        const emitter = new EventEmitter();
        const warnings = /** @type {any[]} */ ([]);
        emitter.on('parameter_warning', w => warnings.push(w));
        const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: emitter, provider: ProviderType.OPENAI });
        b.topK({ v: 40 }).length({ v: 100 }).predictedOutput({ v: 'text' });
        const spec = b._build();
        assert.equal(spec.topK, undefined, 'topK should be skipped on OAI');
        assert.equal(spec.maxTokens, undefined, 'length (alias of maxTokens) should be skipped on OAI');
        assert.equal(spec.predictedOutput, undefined, 'predictedOutput should be skipped on OAI');
        assert.equal(warnings.length, 3);
        assert.deepEqual(warnings.map(w => w.parameter), ['topK', 'length', 'predictedOutput']);
    });

    it('AAI: presencePenalty, frequencyPenalty, seed, length, predictedOutput emit warnings; reasoningEffort is kept', () => {
        const emitter = new EventEmitter();
        const warnings = /** @type {any[]} */ ([]);
        emitter.on('parameter_warning', w => warnings.push(w));
        const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: emitter, provider: ProviderType.ANTHROPIC });
        b.presencePenalty({ v: 0.1 }).frequencyPenalty({ v: 0.2 }).seed({ v: 42 }).reasoningEffort({ v: 'high' }).length({ v: 100 }).predictedOutput({ v: 'text' });
        const spec = /** @type {Record<string, any>} */ (b._build());
        for (const k of ['presencePenalty', 'frequencyPenalty', 'seed', 'maxTokens', 'predictedOutput']) {
            assert.equal(spec[k], undefined, `${k} should be skipped on AAI`);
        }
        assert.equal(spec.reasoningEffort, 'high', 'reasoningEffort maps to output_config.effort');
        assert.equal(warnings.length, 5);
    });

    it('GAI: parallelToolCalls, reasoningEffort, length, predictedOutput emit warnings', () => {
        const emitter = new EventEmitter();
        const warnings = /** @type {any[]} */ ([]);
        emitter.on('parameter_warning', w => warnings.push(w));
        const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: emitter, provider: ProviderType.GOOGLE_GENAI });
        b.parallelToolCalls({ v: true }).reasoningEffort({ v: 'high' }).length({ v: 100 }).predictedOutput({ v: 'text' });
        const spec = b._build();
        for (const k of ['parallelToolCalls', 'reasoningEffort', 'maxTokens', 'predictedOutput']) {
            assert.equal((/** @type {Record<string, any>} */ (spec))[k], undefined, `${k} should be skipped on GAI`);
        }
        assert.equal(warnings.length, 4);
    });

    it('JAI: no methods are unsupported (no warnings emitted for any fluent call)', () => {
        const emitter = new EventEmitter();
        let count = 0;
        emitter.on('parameter_warning', () => { count += 1; });
        new UnifiedParameterBuilder({ model: 'm', eventEmitter: emitter, provider: ProviderType.JAI })
            .temperature({ v: 0.5 })
            .topP({ v: 0.9 })
            .topK({ v: 40 })
            .maxTokens({ v: 100 })
            .stop('END')
            .seed({ v: 42 })
            .asText()
            .toolChoiceAuto()
            .parallelToolCalls({ v: true })
            .reasoningEffort({ v: 'low' })
            .predictedOutput({ v: 'text' })
            .cachePoints({ v: { type: 'default' } })
            .thinkingBudget({ v: 0 })
            .numberOfChoices({ v: 1 })
            .verbosity({ v: 'low' })
            .promptCacheKey({ v: 'k' });
        assert.equal(count, 0, 'JAI supports the union, so no warnings should be emitted');
    });

    it('no event emitter → no warning (silent no-op)', () => {
        const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.OPENAI });
        assert.doesNotThrow(() => b.topK({ v: 40 }));
        assert.equal(b._build().topK, undefined);
    });
});

// ==================================================================================
// SECTION 3: Per-backend translator unit tests
// ==================================================================================

describe('buildParameterMapForOai — OAI translator', () => {
    it('maps camelCase unified spec to OAI snake_case wire names', () => {
        const spec = {
            temperature: 0.5,
            topP: 0.9,
            maxTokens: 100,
            stop: 'END',
            seed: 42,
            presencePenalty: 0.1,
            frequencyPenalty: 0.2,
            user: 'u-1',
            parallelToolCalls: true
        };
        const out = buildParameterMapForOai({ spec });
        assert.equal(out.temperature, 0.5);
        assert.equal(out.top_p, 0.9);
        assert.equal(out.max_tokens, 100);
        assert.equal(out.stop, 'END');
        assert.equal(out.seed, 42);
        assert.equal(out.presence_penalty, 0.1);
        assert.equal(out.frequency_penalty, 0.2);
        assert.equal(out.user, 'u-1');
        assert.equal(out.parallel_tool_calls, true);
    });

    it('passes responseFormat through unchanged', () => {
        const out = buildParameterMapForOai({ spec: { responseFormat: { type: 'json_object' } } });
        assert.deepEqual(out.response_format, { type: 'json_object' });
    });

    it('maps tools to the OAI `{ type: "function", function: { name, description, parameters } }` shape', () => {
        const out = buildParameterMapForOai({ spec: {
            tools: [{ name: 'search', description: 'd', parameters: { type: 'object' } }]
        } });
        assert.equal(out.tools.length, 1);
        assert.equal(out.tools[0].type, 'function');
        assert.equal(out.tools[0].function.name, 'search');
        assert.deepEqual(out.tools[0].function.parameters, { type: 'object' });
    });

    it('maps toolChoice="auto"/"required"/"none" to the same string', () => {
        assert.equal(buildParameterMapForOai({ spec: { toolChoice: 'auto' } }).tool_choice, 'auto');
        assert.equal(buildParameterMapForOai({ spec: { toolChoice: 'required' } }).tool_choice, 'required');
        assert.equal(buildParameterMapForOai({ spec: { toolChoice: 'none' } }).tool_choice, 'none');
    });

    it('maps unified { type: "named", name } to OAI { type: "function", function: { name } }', () => {
        const out = buildParameterMapForOai({ spec: { toolChoice: { type: 'named', name: 'search' } } });
        assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'search' } });
    });
});

describe('buildParameterMapForAai — AAI translator', () => {
    it('maps unified spec to AAI snake_case wire names', () => {
        const out = buildParameterMapForAai({ spec: {
            temperature: 0.5,
            topP: 0.9,
            topK: 40,
            maxTokens: 100,
            stop: 'END',
            metadata: { x: 1 }
        } });
        assert.equal(out.temperature, 0.5);
        assert.equal(out.top_p, 0.9);
        assert.equal(out.top_k, 40);
        assert.equal(out.max_tokens, 100);
        assert.deepEqual(out.stop_sequences, ['END']);
        assert.deepEqual(out.metadata, { x: 1 });
    });

    it('asJson sets _jsonMode = true', () => {
        const out = buildParameterMapForAai({ spec: { responseFormat: { type: 'json_object' } } });
        assert.equal(out._jsonMode, true);
    });

    it('asJsonSchema sets _jsonMode = true and attaches the schema to _jsonSchema', () => {
        const schema = { type: 'object', properties: {} };
        const out = buildParameterMapForAai({ spec: { responseFormat: { type: 'json_schema', json_schema: { schema } } } });
        assert.equal(out._jsonMode, true);
        assert.deepEqual(out._jsonSchema, schema);
    });

    it('thinkingBudget > 0 maps to { type: "enabled", budget_tokens }; 0 maps to { type: "disabled" }', () => {
        const on = buildParameterMapForAai({ spec: { thinkingBudget: 1024 } });
        assert.deepEqual(on.thinking, { type: 'enabled', budget_tokens: 1024 });
        const off = buildParameterMapForAai({ spec: { thinkingBudget: 0 } });
        assert.deepEqual(off.thinking, { type: 'disabled' });
    });

    it("thinkingBudget 'adaptive' maps to { type: 'adaptive' }", () => {
        const out = buildParameterMapForAai({ spec: { thinkingBudget: 'adaptive' } });
        assert.deepEqual(out.thinking, { type: 'adaptive' });
    });

    it('reasoningEffort maps to output_config.effort on AAI', () => {
        const out = buildParameterMapForAai({ spec: { reasoningEffort: 'medium' } });
        assert.deepEqual(out.output_config, { effort: 'medium' });
        assert.equal(out.reasoning_effort, undefined);
    });

    it('maps unified { type: "named", name } to AAI { type: "tool", name }', () => {
        const out = buildParameterMapForAai({ spec: { toolChoice: { type: 'named', name: 'search' } } });
        assert.deepEqual(out._toolChoice, { type: 'tool', name: 'search' });
    });

    it('maps unified "required" to AAI "any"', () => {
        const out = buildParameterMapForAai({ spec: { toolChoice: 'required' } });
        assert.equal(out._toolChoice, 'any');
    });

    it('maps tools to the AAI `{ name, description, input_schema }` shape', () => {
        const out = buildParameterMapForAai({ spec: {
            tools: [{ name: 'search', description: 'd', parameters: { type: 'object' } }]
        } });
        assert.equal(out._tools[0].name, 'search');
        assert.deepEqual(out._tools[0].input_schema, { type: 'object' });
    });
});

describe('buildParameterMapForGai — GAI translator', () => {
    it('maps unified spec to GAI camelCase wire names', () => {
        const out = buildParameterMapForGai({ spec: {
            temperature: 0.5,
            topP: 0.9,
            topK: 40,
            maxTokens: 100,
            stop: 'END',
            seed: 42,
            presencePenalty: 0.1,
            frequencyPenalty: 0.2
        } });
        assert.equal(out.temperature, 0.5);
        assert.equal(out.topP, 0.9);
        assert.equal(out.topK, 40);
        assert.equal(out.maxOutputTokens, 100);
        assert.deepEqual(out.stopSequences, ['END']);
        assert.equal(out.seed, 42);
        assert.equal(out.presencePenalty, 0.1);
        assert.equal(out.frequencyPenalty, 0.2);
    });

    it('asText sets responseMimeType to text/plain', () => {
        const out = buildParameterMapForGai({ spec: { responseFormat: { type: 'text' } } });
        assert.equal(out.responseMimeType, 'text/plain');
    });

    it('asJson sets responseMimeType to application/json', () => {
        const out = buildParameterMapForGai({ spec: { responseFormat: { type: 'json_object' } } });
        assert.equal(out.responseMimeType, 'application/json');
    });

    it('asJsonSchema sets responseMimeType and responseJsonSchema', () => {
        const schema = { type: 'object', properties: {} };
        const out = buildParameterMapForGai({ spec: { responseFormat: { type: 'json_schema', json_schema: { schema } } } });
        assert.equal(out.responseMimeType, 'application/json');
        assert.deepEqual(out.responseJsonSchema, schema);
    });

    it('thinkingBudget sets thinkingConfig.thinkingBudget', () => {
        const out = buildParameterMapForGai({ spec: { thinkingBudget: 1024 } });
        assert.equal(out.thinkingConfig.thinkingBudget, 1024);
    });

    it('maps unified { type: "named", name } to GAI { type: "named", name } (passthrough)', () => {
        const out = buildParameterMapForGai({ spec: { toolChoice: { type: 'named', name: 'search' } } });
        assert.deepEqual(out._toolConfig, { type: 'named', name: 'search' });
    });

    it('maps tools to the GAI `{ name, description, parametersJsonSchema }` shape', () => {
        const out = buildParameterMapForGai({ spec: {
            tools: [{ name: 'search', description: 'd', parameters: { type: 'object' } }]
        } });
        assert.equal(out._tools[0].name, 'search');
        assert.deepEqual(out._tools[0].parametersJsonSchema, { type: 'object' });
    });
});

describe('buildParameterMapForJai — JAI translator', () => {
    it('maps unified spec to JAI V9-keyed spec', () => {
        const out = buildParameterMapForJai({ spec: {
            temperature: 0.5,
            topP: 0.9,
            topK: 40,
            maxTokens: 100,
            stop: 'END',
            seed: 42
        } });
        assert.equal(out.TEMPERATURE, 0.5);
        assert.equal(out.TOP_P, 0.9);
        assert.equal(out.TOP_K, 40);
        assert.equal(out.LENGTH, 100);
        assert.equal(out.STOP_TOKEN, 'END');
        assert.equal(out.SEED, 42);
    });

    it('STOP_TOKEN takes the first element when stop is an array', () => {
        const out = buildParameterMapForJai({ spec: { stop: ['A', 'B'] } });
        assert.equal(out.STOP_TOKEN, 'A');
    });

    it('asJson sets RESPONSE_FORMAT = { type: "json" }', () => {
        const out = buildParameterMapForJai({ spec: { responseFormat: { type: 'json_object' } } });
        assert.deepEqual(out.RESPONSE_FORMAT, { type: 'json' });
    });

    it('asJsonSchema attaches the schema to RESPONSE_FORMAT.schema', () => {
        const schema = { type: 'object' };
        const out = buildParameterMapForJai({ spec: { responseFormat: { type: 'json_schema', json_schema: { schema } } } });
        assert.equal(out.RESPONSE_FORMAT.type, 'json');
        assert.deepEqual(out.RESPONSE_FORMAT.schema, schema);
    });

    it('toolChoice mappings: auto/required/none/named', () => {
        const a = buildParameterMapForJai({ spec: { toolChoice: 'auto' } });
        assert.equal(a.TOOL_CHOICE_AUTO, true);
        const r = buildParameterMapForJai({ spec: { toolChoice: 'required' } });
        assert.equal(r.TOOL_CHOICE_REQUIRED, true);
        const n = buildParameterMapForJai({ spec: { toolChoice: 'none' } });
        assert.equal(n.TOOL_CHOICE_NONE, true);
        const named = buildParameterMapForJai({ spec: { toolChoice: { type: 'named', name: 'search' } } });
        assert.equal(named.TOOL_CHOICE_NAMED, 'search');
    });

    it('JAI-specific fields pass through: predictedOutput, cachePoints, thinkingBudget, numberOfChoices, verbosity, promptCacheKey', () => {
        const out = buildParameterMapForJai({ spec: {
            predictedOutput: 'x',
            cachePoints: { type: 'default' },
            thinkingBudget: 1024,
            numberOfChoices: 2,
            verbosity: 'low',
            promptCacheKey: 'k',
            parallelToolCalls: true
        } });
        assert.equal(out.PREDICTED_OUTPUT, 'x');
        assert.deepEqual(out.CACHE_POINTS, { type: 'default' });
        assert.equal(out.THINKING_BUDGET, 1024);
        assert.equal(out.NUMBER_OF_CHOICES, 2);
        assert.equal(out.VERBOSITY, 'low');
        assert.equal(out.PROMPT_CACHE_KEY, 'k');
        assert.equal(out.PARALLEL_TOOL_CALLS, true);
    });
});

// ==================================================================================
// SECTION 4: End-to-end `withParameters` integration
// ==================================================================================

function makeStubClient() {
    return {
        chat: { completions: { create: async () => ({ choices: [{ message: { content: '' } }] }) } },
        messages: { stream: () => (async function* () {})() },
        models: { generateContentStream: async () => (async function* () {})() }
    };
}

function makeStubJaiHttpClient() {
    return {
        streamTimeout: 150_000,
        getEventEmitter: () => null,
        _fetchWithRetry: async () => ({ body: { pipeThrough: () => ({ getReader: () => ({ read: async () => ({ done: true }) }) }) } })
    };
}

describe('withParameters — end-to-end integration with all four backends', () => {
    it('OAI: withParameters(b => b.temperature(0.5).topP(0.9).maxTokens(100)) sets _parameters', () => {
        const s = new OaiChatSession({ client: makeStubClient(), model: 'm', eventEmitter: new EventEmitter() });
        s.withParameters({ params: /** @type {(...args: any[]) => any} */ ((b) => b.temperature({ v: 0.5 }).topP({ v: 0.9 }).maxTokens({ v: 100 }).asText()) });
        assert.equal((/** @type {any} */ (s))._parameters.temperature, 0.5);
        assert.equal((/** @type {any} */ (s))._parameters.top_p, 0.9);
        assert.equal((/** @type {any} */ (s))._parameters.max_tokens, 100);
        assert.deepEqual((/** @type {any} */ (s))._parameters.response_format, { type: 'text' });
    });

    it('OAI: withParameters({ temperature: 0.7 }) accepts the unified spec object form', () => {
        const s = new OaiChatSession({ client: makeStubClient(), model: 'm', eventEmitter: new EventEmitter() });
        s.withParameters({ params: { temperature: 0.7 } });
        assert.equal((/** @type {any} */ (s))._parameters.temperature, 0.7);
    });

    it('AAI: withParameters(b => b.temperature(0.5).maxTokens(100).thinkingBudget(1024)) sets _parameters', () => {
        const s = new AaiChatSession({ client: makeStubClient(), model: 'm', eventEmitter: new EventEmitter() });
        s.withParameters({ params: /** @type {(...args: any[]) => any} */ (b => b.temperature({ v: 0.5 }).maxTokens({ v: 100 }).thinkingBudget({ v: 1024 })) });
        assert.equal((/** @type {any} */ (s))._parameters.temperature, 0.5);
        assert.equal((/** @type {any} */ (s))._parameters.max_tokens, 100);
        assert.deepEqual((/** @type {any} */ (s))._parameters.thinking, { type: 'enabled', budget_tokens: 1024 });
    });

    it('GAI: withParameters(b => b.temperature(0.5).maxTokens(100).asJson()) sets _parameters', () => {
        const s = new GaiChatSession({ client: makeStubClient(), model: 'm', eventEmitter: new EventEmitter() });
        s.withParameters({ params: /** @type {(...args: any[]) => any} */ (b => b.temperature({ v: 0.5 }).maxTokens({ v: 100 }).asJson()) });
        assert.equal((/** @type {any} */ (s))._parameters.temperature, 0.5);
        assert.equal((/** @type {any} */ (s))._parameters.maxOutputTokens, 100);
        assert.equal((/** @type {any} */ (s))._parameters.responseMimeType, 'application/json');
    });

    it('JAI: withParameters(b => b.temperature(0.5).maxTokens(100).asText()) sets _parameters via buildParametersV9', () => {
        const s = new JaiChatSession({ httpClient: /** @type {any} */ (makeStubJaiHttpClient()), profile: 'm', eventEmitter: new EventEmitter(), profileManager: /** @type {any} */ (null) });
        s.withParameters({ params: /** @type {(...args: any[]) => any} */ (b => b.temperature({ v: 0.5 }).maxTokens({ v: 100 }).asText()) });
        assert.equal((/** @type {any} */ (s))._parameters.temperature, 0.5);
        assert.equal((/** @type {any} */ (s))._parameters.length, 100);
        assert.deepEqual((/** @type {any} */ (s))._parameters.responseFormat, { type: 'text' });
    });

    it('unsupported methods do not throw and emit parameter_warning on the session emitter', () => {
        const emitter = new EventEmitter();
        const warnings = /** @type {any[]} */ ([]);
        emitter.on('parameter_warning', w => warnings.push(w));
        const s = new OaiChatSession({ client: makeStubClient(), model: 'm', eventEmitter: emitter });
        s.withParameters({ params: /** @type {(...args: any[]) => any} */ (b => b.topK({ v: 40 }).length({ v: 100 }).predictedOutput({ v: 'x' })) });
        assert.equal(warnings.length, 3);
        assert.equal((/** @type {any} */ (s))._parameters.top_k, undefined);
        assert.equal((/** @type {any} */ (s))._parameters.max_tokens, undefined);
    });
});

describe('asJsonSchema — response_format.json_schema.name (OpenAI requires it)', () => {
    it('keeps the caller-supplied schema name', () => {
        const b = new UnifiedParameterBuilder({ model: 'gpt-4o', eventEmitter: null, provider: ProviderType.OPENAI });
        b.asJsonSchema({ config: { name: 'plan', strict: true, schema: { type: 'object' } } });
        const rf = buildParameterMapForOai({ spec: b._build() }).response_format;
        assert.equal(rf.type, 'json_schema');
        assert.equal(rf.json_schema.name, 'plan');
        assert.deepEqual(rf.json_schema.schema, { type: 'object' });
    });

    it('defaults the name for a bare schema and for withSchema()', () => {
        for (const apply of [
            /** @type {(b: any) => any} */ ((b) => b.asJsonSchema({ config: { type: 'object' } })),
            /** @type {(b: any) => any} */ ((b) => b.asJson().withSchema({ schema: { type: 'object' } }))
        ]) {
            const b = new UnifiedParameterBuilder({ model: 'gpt-4o', eventEmitter: null, provider: ProviderType.OPENAI });
            apply(b);
            const rf = buildParameterMapForOai({ spec: b._build() }).response_format;
            assert.equal(rf.json_schema.name, 'response');
            assert.deepEqual(rf.json_schema.schema, { type: 'object' });
        }
    });

    it('AAI and GAI still receive the schema through their own translators', () => {
        const mk = () => {
            const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.ANTHROPIC });
            b.asJsonSchema({ config: { name: 'plan', schema: { type: 'object' } } });
            return b._build();
        };
        assert.deepEqual(buildParameterMapForAai({ spec: mk() })._jsonSchema, { type: 'object' });
        assert.deepEqual(buildParameterMapForGai({ spec: mk() }).responseJsonSchema, { type: 'object' });
    });

    it('OpenCode downgrades response_format.json_schema to json_object (upstream 400s on json_schema), OpenAI keeps it', () => {
        /** @param {{backend?: *}} arg0 */
        const mkSession = (/** @param {any} provider */ ({ provider }) => new OaiChatSession({ client: makeStubClient(), model: 'm', eventEmitter: new EventEmitter(), provider }));
        const openai = mkSession({ provider: ProviderType.OPENAI });
        openai.withParameters({ params: /** @type {(...args: any[]) => any} */ (b => b.asJsonSchema({ config: { name: 'plan', schema: { type: 'object' } } })) });
        assert.equal((/** @type {any} */ (openai))._parameters.response_format.type, 'json_schema');
        const opencode = mkSession({ provider: ProviderType.OPENCODE });
        opencode.withParameters({ params: /** @type {(...args: any[]) => any} */ (b => b.asJsonSchema({ config: { name: 'plan', schema: { type: 'object' } } })) });
        assert.deepEqual((/** @type {any} */ (opencode))._parameters.response_format, { type: 'json_object' });
    });
});

describe('reasoning knobs actually reach the wire', () => {
    it('OAI: reasoningEffort maps to reasoning_effort (was silently dropped)', () => {
        const b = new UnifiedParameterBuilder({ model: 'gpt-5', eventEmitter: null, provider: ProviderType.OPENAI });
        b.reasoningEffort({ v: 'medium' });
        assert.equal(buildParameterMapForOai({ spec: b._build() }).reasoning_effort, 'medium');
    });

    it('GAI: thinkingBudget also sets includeThoughts, else no thought parts are returned', () => {
        const b = new UnifiedParameterBuilder({ model: 'gemini-2.5-pro', eventEmitter: null, provider: ProviderType.GOOGLE_GENAI });
        b.thinkingBudget({ v: 2048 });
        assert.deepEqual(buildParameterMapForGai({ spec: b._build() }).thinkingConfig,
            { thinkingBudget: 2048, includeThoughts: true });
    });

    it('AAI: thinkingBudget enables extended thinking', () => {
        const b = new UnifiedParameterBuilder({ model: 'claude-sonnet-4-5', eventEmitter: null, provider: ProviderType.ANTHROPIC });
        b.thinkingBudget({ v: 1024 });
        assert.deepEqual(buildParameterMapForAai({ spec: b._build() }).thinking,
            { type: 'enabled', budget_tokens: 1024 });
    });

    it('OAI: thinkingBudget warns instead of vanishing (no OpenAI wire field for it)', () => {
        const warnings = /** @type {any[]} */ ([]);
        const em = /** @type {any} */ ({ emit: /** @type {(n: any, p: any) => any} */ ((n, p) => n === 'parameter_warning' && warnings.push(p.parameter)) });
        const b = new UnifiedParameterBuilder({ model: 'gpt-5', eventEmitter: em, provider: ProviderType.OPENAI });
        b.thinkingBudget({ v: 1024 });
        assert.deepEqual(warnings, ['thinkingBudget']);
        assert.equal(buildParameterMapForOai({ spec: b._build() }).thinkingConfig, undefined);
    });
});

// =============================================================================
// =============================================================================
describe('buildParameterMapForJai json-mode guard', () => {
    it('pins TOOL_CHOICE_NONE for json mode with no caller intent', () => {
        const params = buildParameterMapForJai({ spec: { responseFormat: { type: 'json' } } });
        assert.equal(params.RESPONSE_FORMAT.type, 'json');
        assert.equal(params.TOOL_CHOICE_NONE, true);
    });
    it('pins TOOL_CHOICE_NONE for json_schema with no caller intent', () => {
        const params = buildParameterMapForJai({ spec: { responseFormat: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } } } });
        assert.equal(params.RESPONSE_FORMAT.type, 'json');
        assert.equal(params.RESPONSE_FORMAT.schema.type, 'object');
        assert.equal(params.TOOL_CHOICE_NONE, true);
    });
    it('respects explicit tool choice', () => {
        const params = buildParameterMapForJai({ spec: { responseFormat: { type: 'json' }, toolChoice: 'auto' } });
        assert.equal(params.TOOL_CHOICE_AUTO, true);
        assert.equal(params.TOOL_CHOICE_NONE, undefined);
    });
    it('respects caller-supplied tools', () => {
        const params = buildParameterMapForJai({ spec: {
            responseFormat: { type: 'json' },
            tools: [{ name: 'probe', description: 'd', parameters: {} }],
        } });
        assert.equal(params.TOOL_CHOICE_NONE, undefined);
        assert.ok(params._tools.length === 1);
    });
    it('skips text mode', () => {
        const params = buildParameterMapForJai({ spec: { responseFormat: { type: 'text' } } });
        assert.deepEqual(params.RESPONSE_FORMAT, { type: 'text' });
        assert.equal(params.TOOL_CHOICE_NONE, undefined);
    });
});

// ==================================================================================
// ==================================================================================

describe('thinkingLevel — setter + GAI translator', () => {
    it('chains and stores a valid level (GAI backend)', () => {
        const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.GOOGLE_GENAI });
        assert.strictEqual(b.thinkingLevel({ v: 'high' }), b);
        assert.equal(b._build().thinkingLevel, 'high');
    });

    it('invalid level is ignored (never stored)', () => {
        const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: null, provider: ProviderType.GOOGLE_GENAI });
        b.thinkingLevel({ v: /** @type {any} */ ('minimal') });
        assert.equal(b._build().thinkingLevel, undefined);
    });

    it('maps to thinkingConfig.{ thinkingLevel, includeThoughts } on GAI', () => {
        const out = buildParameterMapForGai({ spec: { thinkingLevel: 'high' } });
        assert.deepEqual(out.thinkingConfig, { thinkingLevel: 'high', includeThoughts: true });
    });

    it('thinkingLevel wins over thinkingBudget (budget dropped)', () => {
        const out = buildParameterMapForGai({ spec: { thinkingLevel: 'medium', thinkingBudget: 1024 } });
        assert.deepEqual(out.thinkingConfig, { thinkingLevel: 'medium', includeThoughts: true });
    });

    it('thinkingBudget alone keeps the legacy numeric shape', () => {
        const out = buildParameterMapForGai({ spec: { thinkingBudget: 1024 } });
        assert.equal(out.thinkingConfig.thinkingBudget, 1024);
    });

    it('non-GAI backends warn and ignore (parameter_warning + no spec)', () => {
        for (const provider of [ProviderType.OPENAI, ProviderType.ANTHROPIC, ProviderType.JAI]) {
            const emitter = new EventEmitter();
            let count = 0;
            emitter.on('parameter_warning', () => { count += 1; });
            const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: emitter, provider });
            b.thinkingLevel({ v: 'high' });
            assert.equal(count, 1, `${provider} should warn`);
            assert.equal(b._build().thinkingLevel, undefined);
        }
    });

    it('GAI: withParameters(b => b.thinkingLevel("low").asText()) sets _parameters', () => {
        const s = new GaiChatSession({ client: makeStubClient(), model: 'm', eventEmitter: new EventEmitter() });
        s.withParameters({ params: /** @type {(...args: any[]) => any} */ (b => b.thinkingLevel({ v: 'low' }).asText()) });
        assert.deepEqual((/** @type {any} */ (s))._parameters.thinkingConfig, { thinkingLevel: 'low', includeThoughts: true });
    });
});
