// @ts-check
/**
 * @file Native Gemini/Vertex wire client rebuilt on the shared fetch transport.
 * @version 0.22.0
 *
 * @description
 * The call surface the GAI adapter consumes from the `@google/genai` SDK —
 * `models.generateContentStream`, `models.list` and `models.embedContent` —
 * over the shared fetch transport (`getJson`/`postJson`/`postStream`, so the
 * error-body cap and the deadline are the shared ones), with the SDK's URL,
 * body and response mapping unchanged (the fixtures in
 * `test/fixtures/gai-parity/` are the oracle).
 *
 * Three behaviours are deliberate and pinned by those fixtures:
 *   - a failed open (non-2xx, dead socket) rejects the call itself; a `fetch`
 *     failure escapes unchanged (`TypeError: fetch failed`), as the SDK's did,
 *     even though the shared transport classifies one for the OpenAI surface;
 *   - the SSE reader parses each `data:` frame on its own and lets a malformed
 *     payload throw the parser's `SyntaxError`, so a bare JSON body is the
 *     SDK's `Incomplete JSON segment at the end` — unless it is a 200 JSON body
 *     carrying `error`, which raises that vendor error typed (A2-3);
 *   - a Vertex `:embedContent` answer is `{embedding, usageMetadata, truncated}`
 *     and maps to one embedding carrying `statistics`; only `:predict` answers
 *     `predictions[].embeddings`.
 * No retry, no `sdkHttpResponse`, no automatic function-call continuation.
 */

import { SDK_VERSION } from '../../core/constants/index.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { ConfigurationError } from '../../core/errors.mjs';
import { asRecord } from '../../support/object.mjs';
import { readBodyTextCappedResult } from '../../support/body.mjs';
import { createGoogleApiError } from './errors.mjs';
import { getJson, joinUrl, postJson, postStream } from './http.mjs';
import { sseLineTooLong } from './sse.mjs';
import { nonJsonStreamError } from './stream.mjs';

/** The Gemini Developer API root and version. */
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const GEMINI_API_VERSION = 'v1beta';
/** The Vertex root for `global`, the multi-region pattern, and the version. */
const VERTEX_GLOBAL_URL = 'https://aiplatform.googleapis.com';
const VERTEX_API_VERSION = 'v1beta1';
/** Both SDK headers carry this one truthful identity value. */
const USER_AGENT = `merci-sdk/${SDK_VERSION} gl-node/${process.version}`;
/** The three frame delimiters the SDK accepts, earliest wins. */
const SSE_DELIMITERS = ['\r\n\r\n', '\n\n', '\r\r'];
/** Config keys copied to the request body's top level, unchanged. */
const TOP_LEVEL_KEYS = ['serviceTier', 'safetySettings', 'tools', 'toolConfig', 'labels', 'cachedContent', 'continuationToken'];
/** `generationConfig` keys both modes accept, in the SDK's own order. */
const GENERATION_KEYS = [
    'temperature', 'topP', 'topK', 'candidateCount', 'maxOutputTokens', 'stopSequences',
    'responseLogprobs', 'logprobs', 'presencePenalty', 'frequencyPenalty', 'seed',
    'responseMimeType', 'responseSchema', 'responseJsonSchema', 'responseModalities',
    'mediaResolution', 'speechConfig', 'thinkingConfig', 'audioTranscriptionConfig', 'imageConfig',
];
/** `generationConfig` keys only the Gemini Developer API accepts. */
const GEMINI_ONLY_CONFIG_KEYS = ['enableEnhancedCivicAnswers'];
/** Vertex-only config keys, with the wire name each one takes. */
const VERTEX_ONLY_CONFIG_KEYS = [
    ['routingConfig', 'routingConfig'],
    ['modelSelectionConfig', 'modelConfig'],
    ['audioTimestamp', 'audioTimestamp'],
    ['modelArmorConfig', 'modelArmorConfig'],
    ['generationOutputConfig', 'outputConfig'],
];
/** The list query keys, always camelCase on the wire. */
const LIST_QUERY_KEYS = ['pageSize', 'pageToken', 'filter'];
/** The `Type` values the SDK keeps in a schema; anything else is `TYPE_UNSPECIFIED`. */
const SCHEMA_TYPES = ['TYPE_UNSPECIFIED', 'STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'OBJECT', 'NULL'];
/** The embed `config` keys the SDK copies, and `embedContentConfig` takes as is. */
const EMBED_CONTENT_CONFIG_KEYS = ['taskType', 'title', 'outputDimensionality', 'autoTruncate', 'documentOcr', 'audioTrackExtraction'];
/** The embed `config` keys only Vertex accepts, in Gemini mode they are refused. */
const VERTEX_ONLY_EMBED_KEYS = ['mimeType', 'autoTruncate', 'documentOcr', 'audioTrackExtraction'];
/** The part keys that must be wrapped in a Content object. */
const FUNCTION_PART_KEYS = ['functionCall', 'functionResponse'];

/**
 * The return of `createGoogleAuth` the transport authenticates Vertex with.
 * @typedef {{getToken: (options?: {signal?: AbortSignal}) => Promise<string>, getAuthHeaders: (options?: {signal?: AbortSignal}) => Promise<Headers>, source?: string|null}} GoogleAuth
 */

/**
 * The transport's construction options.
 * @typedef {Object} GaiTransportOptions
 * @property {string} [apiKey] - `x-goog-api-key` (Gemini, and Vertex Express when auth is absent).
 * @property {GoogleAuth} [auth] - Vertex bearer source; ignored while `apiKey` is set.
 * @property {boolean} [vertexai] - Select the Vertex wire shape.
 * @property {string} [project] - Vertex project for model resource paths; when absent the transport uses Vertex Express (`publishers/google/models/<id>`).
 * @property {string} [location] - Vertex location; defaults to `global`.
 * @property {string} [apiVersion] - Overrides `v1beta` (Gemini) / `v1beta1` (Vertex).
 * @property {string} [baseURL] - Replaces the vendor root (loopback replay, gateways).
 * @property {Record<string, string|null|undefined>} [defaultHeaders] - Headers under the per-call ones.
 * @property {typeof fetch} [fetch] - Fetch implementation (defaults to the global).
 * @property {number} [timeoutMs] - Per-call deadline default; `config.httpOptions.timeout` wins per call.
 * @property {number} [maxRetries] - Retained for surface parity; this transport never retries.
 */

/**
 * The pager `models.list()` resolves to: `page`/`params`/`pageSize`, the
 * `hasNextPage()` probe, and an async iterator over every page's items.
 * @typedef {ReturnType<typeof createPager>} GaiPager
 */

/**
 * The connector's call surface, as the GAI adapter consumes it.
 * @typedef {Object} GaiTransport
 * @property {string|undefined} apiKey
 * @property {GoogleAuth|undefined} auth
 * @property {string} baseURL
 * @property {boolean} vertexai
 * @property {number} maxRetries
 * @property {{generateContentStream: (arg0: {model?: string, contents?: unknown, config?: unknown}) => Promise<AsyncGenerator<unknown, void, unknown>>, list: (arg0?: {config?: unknown}) => Promise<GaiPager>, embedContent: (arg0: {model?: string, contents?: unknown, config?: unknown}) => Promise<{embeddings?: unknown}>}} models
 */

/**
 * The root a call uses when no `baseURL` override was passed: the Gemini
 * Developer API, or the Vertex host the SDK derives from the location.
 * @param {{vertexai?: boolean, location?: string}} arg0
 * @returns {string}
 */
export function gaiBaseURL({ vertexai = false, location = 'global' } = {}) {
    if (!vertexai) return GEMINI_BASE_URL;
    if (!location || location === 'global') return VERTEX_GLOBAL_URL;
    if (location === 'us' || location === 'eu') return `https://aiplatform.${location}.rep.googleapis.com`;
    return `https://${location}-aiplatform.googleapis.com`;
}

/**
 * The SDK's mode error for a config key the selected API does not accept.
 * @param {{key: string, geminiOnly: boolean}} arg0
 * @returns {ConfigurationError}
 */
function modeError({ key, geminiOnly }) {
    const message = geminiOnly
        ? `${key} parameter is only supported in Gemini Developer API mode, not in Gemini Enterprise Agent Platform mode.`
        : `${key} parameter is only supported in Gemini Enterprise Agent Platform mode, not in Gemini Developer API mode.`;
    return new ConfigurationError({ message, options: { option: key } });
}

/**
 * The SDK's `_isContent`: an object whose `parts` is an array. Anything else on
 * the contents surface is a part (or a list of parts).
 * @param {unknown} value
 * @returns {boolean}
 */
function isContent(value) {
    const record = asRecord({ value });
    return record !== null && Array.isArray(record.parts);
}

/**
 * The SDK's `_isFunctionCallPart` / `_isFunctionResponsePart` pair: a part the
 * wire needs a role for, so the SDK refuses it outside a Content object.
 * @param {unknown} value
 * @returns {boolean}
 */
function isFunctionPart(value) {
    const record = asRecord({ value });
    return record !== null && FUNCTION_PART_KEYS.some((key) => key in record);
}

/**
 * The SDK's `tPart`: a string is a text part, an object is its own part.
 * @param {unknown} item
 * @returns {unknown}
 */
function toPart(item) {
    if (typeof item === 'string') return { text: item };
    if (item !== null && typeof item === 'object') return item;
    throw new Error(`Unsupported part type: ${typeof item}`);
}

/**
 * The SDK's `tParts`: a bare part is a one-item list, a list is mapped, and an
 * empty one is refused.
 * @param {unknown} origin
 * @returns {Array<unknown>}
 */
function toParts(origin) {
    if (origin === null || origin === undefined || (Array.isArray(origin) && origin.length === 0)) {
        throw new Error('PartListUnion is required');
    }
    if (Array.isArray(origin)) return origin.map(toPart);
    return [toPart(origin)];
}

/**
 * The SDK's `tContent`: a Content object passes through, a string or a part list
 * becomes one `user` turn carrying it.
 * @param {unknown} origin
 * @returns {Record<string, unknown>}
 */
function toContent(origin) {
    if (origin === null || origin === undefined) throw new Error('ContentUnion is required');
    if (isContent(origin)) return /** @type {Record<string, unknown>} */ (origin);
    return { role: 'user', parts: toParts(origin) };
}

/**
 * The SDK's `tContents`: a bare part is one content, an array of parts is ONE
 * content with every part, an array of Content objects passes through, and a
 * mixed list or a bare function part is refused with the SDK's own wording.
 * @param {unknown} origin
 * @returns {Array<Record<string, unknown>>}
 */
function toContents(origin) {
    if (origin === null || origin === undefined || (Array.isArray(origin) && origin.length === 0)) {
        throw new Error('contents are required');
    }
    if (!Array.isArray(origin)) {
        if (isFunctionPart(origin)) throw new Error('To specify functionCall or functionResponse parts, please wrap them in a Content object, specifying the role for them');
        return [toContent(origin)];
    }
    /** @type {Array<Record<string, unknown>>} */
    const contents = [];
    /** @type {Array<unknown>} */
    const parts = [];
    const contentsOnly = isContent(origin[0]);
    for (const item of origin) {
        if (isContent(item) !== contentsOnly) {
            throw new Error('Mixing Content and Parts is not supported, please group the parts into a the appropriate Content objects and specify the roles for them');
        }
        if (isContent(item)) contents.push(/** @type {Record<string, unknown>} */ (item));
        else if (isFunctionPart(item)) throw new Error('To specify functionCall or functionResponse parts, please wrap them, and any other parts, in Content objects as appropriate, specifying the role for them');
        else parts.push(item);
    }
    if (!contentsOnly) contents.push({ role: 'user', parts: toParts(parts) });
    return contents;
}

/**
 * One content entry on the wire: the SDK's `contentToMldev`/`contentToVertex`
 * projection, which keeps `parts` and only the `role` the content carried.
 * @param {unknown} content
 * @returns {Record<string, unknown>}
 */
function toWireContent(content) {
    const record = asRecord({ value: content }) ?? {};
    /** @type {Record<string, unknown>} */
    const wire = {};
    if (record.parts !== undefined) wire.parts = record.parts;
    if (record.role !== undefined) wire.role = record.role;
    return wire;
}

/**
 * The `contents` array the wire expects, normalised then projected.
 * @param {unknown} contents
 * @returns {Array<unknown>}
 */
function toWireContents(contents) {
    return toContents(contents).map(toWireContent);
}

/**
 * The SDK's `flattenTypeArrayToAnyOf`: a `type` array becomes one `type` when a
 * single non-null member is left, else an `anyOf` of the members. A `null`
 * member always merges into `nullable`.
 * @param {{types: Array<unknown>, result: Record<string, unknown>}} arg0
 * @returns {void}
 */
function flattenTypeArrayToAnyOf({ types, result }) {
    if (types.includes('null')) result.nullable = true;
    const names = types.filter((type) => type !== 'null');
    /** @param {unknown} type */
    const wireType = (type) => {
        const upper = typeof type === 'string' ? type.toUpperCase() : '';
        return SCHEMA_TYPES.includes(upper) ? upper : 'TYPE_UNSPECIFIED';
    };
    if (names.length === 1) result.type = wireType(names[0]);
    else result.anyOf = names.map((type) => ({ type: wireType(type) }));
}

/**
 * The SDK's `processJsonSchema`, bounded to the fields it normalises: `type`
 * uppercased (an unknown type is `TYPE_UNSPECIFIED`), a `type` array flattened
 * to one `type` or an `anyOf` (a `null` member becomes `nullable`),
 * `items`, `properties` and `anyOf` members recursed, a two-member `anyOf` with
 * a `null` branch collapsed to `nullable` on the other branch,
 * `additionalProperties` dropped, and every other key (`required`, `format`,
 * `enum`, `description`) passed through unchanged. A schema that carries both
 * `type` and `anyOf` is refused with the SDK's wording. The SDK leaves
 * `allOf`/`oneOf` members alone, and so does this.
 * @param {{schema: unknown}} arg0
 * @returns {unknown}
 */
function normaliseSchema({ schema }) {
    const record = asRecord({ value: schema });
    if (!record) return schema;
    if (record.type && record.anyOf) throw new Error('type and anyOf cannot be both populated.');
    /** @type {Record<string, unknown>} */
    const result = {};
    let source = record;
    const anyOf = record.anyOf;
    if (Array.isArray(anyOf) && anyOf.length === 2) {
        const [first, second] = anyOf.map((member) => asRecord({ value: member }));
        if (first?.type === 'null') { result.nullable = true; source = second ?? record; }
        else if (second?.type === 'null') { result.nullable = true; source = first ?? record; }
    }
    if (Array.isArray(source.type)) flattenTypeArrayToAnyOf({ types: source.type, result });
    for (const [key, value] of Object.entries(source)) {
        if (value === null || value === undefined) continue;
        if (key === 'type') {
            if (Array.isArray(value)) continue;
            const upper = typeof value === 'string' ? value.toUpperCase() : '';
            result.type = SCHEMA_TYPES.includes(upper) ? upper : 'TYPE_UNSPECIFIED';
        } else if (key === 'items') {
            result.items = normaliseSchema({ schema: value });
        } else if (key === 'properties') {
            /** @type {Record<string, unknown>} */
            const properties = {};
            for (const [name, member] of Object.entries(asRecord({ value }) ?? {})) {
                properties[name] = normaliseSchema({ schema: member });
            }
            result.properties = properties;
        } else if (key === 'anyOf') {
            /** @type {Array<unknown>} */
            const members = [];
            for (const member of Array.isArray(value) ? value : []) {
                if (asRecord({ value: member })?.type === 'null') { result.nullable = true; continue; }
                members.push(normaliseSchema({ schema: member }));
            }
            result.anyOf = members;
        } else if (key !== 'additionalProperties') {
            result[key] = value;
        }
    }
    return result;
}

/**
 * The hoisted `generationConfig` object, plus the mode-only keys' refusal.
 * `responseSchema` is normalised on the way; `responseJsonSchema` goes through.
 * @param {{config: Record<string, unknown>, vertexai: boolean}} arg0
 * @returns {Record<string, unknown>}
 */
function generationConfigOf({ config, vertexai }) {
    /** @type {Record<string, unknown>} */
    const generation = {};
    for (const key of GENERATION_KEYS) {
        if (config[key] == null) continue;
        generation[key] = key === 'responseSchema' ? normaliseSchema({ schema: config[key] }) : config[key];
    }
    for (const [from, to] of VERTEX_ONLY_CONFIG_KEYS) {
        if (vertexai) {
            if (config[from] != null) generation[to] = config[from];
        } else if (config[from] !== undefined) {
            throw modeError({ key: from, geminiOnly: false });
        }
    }
    for (const key of GEMINI_ONLY_CONFIG_KEYS) {
        if (!vertexai) {
            if (config[key] != null) generation[key] = config[key];
        } else if (config[key] !== undefined) {
            throw modeError({ key, geminiOnly: true });
        }
    }
    return generation;
}

/**
 * The SDK's `maybeMoveToResponseJsonSchema`: a `responseSchema` that carries
 * `$schema` is a JSON Schema, so it travels as `responseJsonSchema` verbatim and
 * `responseSchema` is dropped — unless the caller supplied a
 * `responseJsonSchema`, which wins untouched.
 * @param {{config: Record<string, unknown>}} arg0
 * @returns {Record<string, unknown>}
 */
function moveToResponseJsonSchema({ config }) {
    if (!config.responseSchema || config.responseJsonSchema) return config;
    if (!Object.keys(asRecord({ value: config.responseSchema }) ?? {}).includes('$schema')) return config;
    const { responseSchema, ...rest } = config;
    return { ...rest, responseJsonSchema: responseSchema };
}

/**
 * The `generateContentStream` body: a whitelist, so an unknown config key is
 * dropped and `httpOptions`/`abortSignal` never reach the wire. `contents` is
 * absent (not refused) when the caller passed none, as the SDK does. The SDK
 * emits `generationConfig: {}` whenever the caller supplied a config object at
 * all, an empty one included.
 * @param {{contents: unknown, config: unknown, vertexai: boolean}} arg0
 * @returns {Record<string, unknown>}
 */
function buildGenerateBody({ contents, config, vertexai }) {
    const rawConfig = asRecord({ value: config });
    /** @type {Record<string, unknown>} */
    const body = {};
    if (contents != null) body.contents = toWireContents(contents);
    if (!rawConfig) return body;

    const callConfig = moveToResponseJsonSchema({ config: rawConfig });
    if (callConfig.systemInstruction != null) body.systemInstruction = toWireContent(toContent(callConfig.systemInstruction));
    for (const key of TOP_LEVEL_KEYS) {
        if (callConfig[key] != null) body[key] = callConfig[key];
    }
    if (callConfig.store !== undefined) {
        if (vertexai) throw modeError({ key: 'store', geminiOnly: true });
        if (callConfig.store != null) body.store = callConfig.store;
    }
    body.generationConfig = generationConfigOf({ config: callConfig, vertexai });
    return body;
}

/**
 * The SDK's model-path transform, including the resource ids it passes through
 * and the characters it refuses.
 * @param {{model: unknown, vertexai: boolean}} arg0
 * @returns {string}
 */
function transformModel({ model, vertexai }) {
    if (typeof model !== 'string' || model.length === 0) {
        throw new ConfigurationError({ message: 'model is required and must be a string.', options: { option: 'model' } });
    }
    if (model.includes('..') || model.includes('?') || model.includes('&')) {
        throw new ConfigurationError({ message: `Invalid model parameter '${model}': '..', '?' and '&' are not allowed.`, options: { option: 'model' } });
    }
    if (vertexai) {
        if (model.startsWith('publishers/') || model.startsWith('projects/') || model.startsWith('models/')) return model;
        if (model.includes('/')) {
            const parts = model.split('/', 2);
            return `publishers/${parts[0]}/models/${parts[1]}`;
        }
        return `publishers/google/models/${model}`;
    }
    if (model.startsWith('models/') || model.startsWith('tunedModels/')) return model;
    return `models/${model}`;
}

/**
 * The model resource the Vertex URL carries: a `projects/...` id already names
 * its location, everything else is prefixed with the client's project/location.
 * Vertex Express has no project, and the SDK then sends the bare publisher path
 * (`publishers/google/models/<id>`) instead of a location-scoped resource.
 * @param {{model: unknown, vertexai: boolean, project?: string, location?: string}} arg0
 * @returns {string}
 */
function modelResourcePath({ model, vertexai, project, location = 'global' }) {
    const transformed = transformModel({ model, vertexai });
    if (!vertexai || transformed.startsWith('projects/')) return transformed;
    if (typeof project !== 'string' || project.length === 0) return transformed;
    return `projects/${project}/locations/${location}/${transformed}`;
}

/**
 * The SDK's Vertex embed-endpoint predicate.
 * @param {{model?: string}} arg0
 * @returns {boolean}
 */
function isVertexEmbedContentModel({ model = '' }) {
    return (model.includes('gemini') && model !== 'gemini-embedding-001') || model.includes('maas');
}

/**
 * The texts a Vertex embed instance is built from: each input reduced to its
 * first text, and an input whose first part has no text dropped entirely
 * (`tContentsForEmbed`), so instance count and order follow the text ones only.
 * @param {{contents: unknown}} arg0
 * @returns {Array<unknown>}
 */
function firstTexts({ contents }) {
    if (!contents) return [];
    const list = Array.isArray(contents) ? contents : [contents];
    /** @type {Array<unknown>} */
    const texts = [];
    for (const item of list) {
        const parts = toContent(item).parts;
        const first = Array.isArray(parts) ? asRecord({ value: parts[0] }) : null;
        if (first && first.text !== undefined) texts.push(first.text);
    }
    return texts;
}

/**
 * The Gemini embed contents (`tContentsForEmbed` without Vertex): every input is
 * its own request. `gemini-embedding-2` is grouped by `tContents` first, so a
 * list of strings is one request with one content carrying them all as parts.
 * @param {{contents: unknown, group: boolean}} arg0
 * @returns {Array<Record<string, unknown>>}
 */
function mldevEmbedContents({ contents, group }) {
    if (group) return toContents(contents);
    if (!contents) return [];
    if (Array.isArray(contents)) return contents.map((item) => toContent(item));
    return [toContent(contents)];
}

/**
 * The embed `config` mapping for one endpoint. Gemini puts the three shared keys
 * on every `requests[]` entry; Vertex sends `embedContentConfig` for
 * `:embedContent` and `instances[].task_type` / `parameters` for `:predict`.
 * The Vertex-only keys are refused in Gemini mode, as the SDK does.
 * @param {{config: Record<string, unknown>, endpoint: 'mldev'|'embedContent'|'predict', instances?: Array<Record<string, unknown>>}} arg0
 * @returns {{request: Record<string, unknown>, embedContentConfig?: Record<string, unknown>, parameters?: Record<string, unknown>}}
 */
function embedConfigOf({ config, endpoint, instances = [] }) {
    if (endpoint === 'mldev') {
        /** @type {Record<string, unknown>} */
        const request = {};
        for (const key of ['taskType', 'title', 'outputDimensionality']) {
            if (config[key] != null) request[key] = config[key];
        }
        for (const key of VERTEX_ONLY_EMBED_KEYS) {
            if (config[key] !== undefined) throw modeError({ key, geminiOnly: false });
        }
        return { request };
    }
    /** @type {Record<string, unknown>} */
    const embedContentConfig = {};
    /** @type {Record<string, unknown>} */
    const parameters = {};
    for (const key of EMBED_CONTENT_CONFIG_KEYS) {
        if (config[key] == null) continue;
        if (endpoint === 'embedContent') {
            embedContentConfig[key] = config[key];
        } else if (key === 'outputDimensionality' || key === 'autoTruncate') {
            parameters[key] = config[key];
        }
    }
    if (endpoint === 'predict') {
        for (const instance of instances) {
            for (const key of ['taskType', 'title', 'mimeType']) {
                if (config[key] == null) continue;
                instance[key === 'taskType' ? 'task_type' : key] = config[key];
            }
        }
    }
    return { request: {}, embedContentConfig, parameters };
}

/**
 * The text a chunk exposes on its `text` getter: non-thought text parts joined,
 * `undefined` when it carries none (the fixtures pin `''` for one empty part).
 * @param {{parts?: Array<unknown>}} arg0
 * @returns {string|undefined}
 */
function chunkText({ parts }) {
    /** @type {Array<string>} */
    const texts = [];
    for (const part of parts ?? []) {
        const record = asRecord({ value: part });
        if (record && typeof record.text === 'string' && record.thought !== true) texts.push(record.text);
    }
    return texts.length === 0 ? undefined : texts.join('');
}

/**
 * The `functionCalls` a chunk exposes: `candidates[0].content.parts[].functionCall`,
 * or `undefined` when there is none.
 * @param {{parts?: Array<unknown>}} arg0
 * @returns {Array<unknown>|undefined}
 */
function chunkFunctionCalls({ parts }) {
    /** @type {Array<unknown>} */
    const calls = [];
    for (const part of parts ?? []) {
        const functionCall = asRecord({ value: part })?.functionCall;
        if (functionCall) calls.push(functionCall);
    }
    return calls.length === 0 ? undefined : calls;
}

/**
 * Marks a parsed chunk with the two derived accessors the adapter reads,
 * non-enumerably so a JSON projection stays the vendor object exactly.
 * @param {{parsed: unknown}} arg0
 * @returns {unknown}
 */
function asChunk({ parsed }) {
    const record = asRecord({ value: parsed });
    if (!record) return parsed;
    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    const content = asRecord({ value: asRecord({ value: candidates[0] })?.content });
    const parts = Array.isArray(content?.parts) ? /** @type {Array<unknown>} */ (content?.parts) : undefined;
    Object.defineProperty(record, 'text', { value: chunkText({ parts }), enumerable: false, configurable: true });
    Object.defineProperty(record, 'functionCalls', { value: chunkFunctionCalls({ parts }), enumerable: false, configurable: true });
    return record;
}

/**
 * Splits the first complete frame off the buffer, earliest delimiter wins.
 * @param {{buffer: string}} arg0
 * @returns {{frame: string, rest: string}|null}
 */
function splitFrame({ buffer }) {
    let index = -1;
    let length = 0;
    for (const delimiter of SSE_DELIMITERS) {
        const at = buffer.indexOf(delimiter);
        if (at !== -1 && (index === -1 || at < index)) {
            index = at;
            length = delimiter.length;
        }
    }
    if (index === -1) return null;
    return { frame: buffer.slice(0, index), rest: buffer.slice(index + length) };
}

/**
 * The parsed payload of one frame, or `undefined` for a frame without a
 * `data:` prefix (a comment, `event:`, an Anthropic-style frame). Multiple
 * `data:` lines are deliberately not joined, exactly as the SDK's slice is not.
 * @param {{frame: string}} arg0
 * @returns {unknown}
 */
function parseFrame({ frame }) {
    const trimmed = frame.trim();
    if (!trimmed.startsWith('data:')) return undefined;
    const parsed = JSON.parse(trimmed.slice('data:'.length).trim());
    const error = asRecord({ value: asRecord({ value: parsed })?.error });
    if (error) throw payloadError({ parsed, error });
    return parsed;
}

/**
 * The typed Google error a payload carrying `error` raises: `error.code` when it
 * is a 4xx/5xx number, else 500. The response headers ride along non-enumerably
 * so `retry-after` stays readable (A-5).
 * @param {{parsed: unknown, error: Record<string, unknown>, headers?: Headers}} arg0
 * @returns {Error}
 */
function payloadError({ parsed, error, headers }) {
    const code = error.code;
    const status = typeof code === 'number' && code >= 400 && code < 600 ? code : 500;
    return createGoogleApiError({
        status,
        body: parsed,
        headers,
        message: `got status: ${error.status ?? ''}. ${JSON.stringify(parsed)}`,
    });
}

/**
 * The response media type, lowercased and without its parameters.
 * @param {{response: Response}} arg0
 * @returns {string}
 */
function responseMediaType({ response }) {
    return (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * A parsed JSON body, or `undefined` when it does not parse: a malformed body
 * is not an error payload, so it keeps the reader's leftover-tail refusal.
 * @param {{text: string}} arg0
 * @returns {unknown}
 */
function parseMaybeJson({ text }) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * Reads the response body as the SDK's `processStreamResponse` did: decode,
 * buffer, dispatch each complete frame, and refuse a leftover tail at EOF. Each
 * complete frame is bounded by `sse_max_line_bytes` *before* it is consumed, and
 * the unterminated remainder is bounded after the split loop — the cap measures
 * one frame, never one `read()` (a chunk may carry many small frames). Both are
 * refused with the shared non-retryable `SSE_LINE_TOO_LONG` error.
 * The `dispose` (the request's signal/timer release) runs however the iteration ends.
 * @param {{response: Response, dispose?: () => void}} arg0
 * @returns {AsyncGenerator<unknown, void, unknown>}
 */
async function* decodeSse({ response, dispose }) {
    const body = /** @type {ReadableStream<Uint8Array>} */ (response.body);
    const decoder = new TextDecoder('utf-8');
    const maxBytes = LIMITS.sse_max_line_bytes;
    /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */
    let reader = null;
    let buffer = '';
    let frames = 0;
    try {
        // A2-3: a 2xx JSON body is not a frame stream — a proxy, or the vendor's
        // own JSON mode, can answer that way. A body carrying `error` is the
        // vendor's failure and is raised typed with its headers; any other body
        // keeps the old outcome (the leftover-tail refusal at the end).
        const mediaType = responseMediaType({ response });
        if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
            const capped = await readBodyTextCappedResult({ response, maxBytes });
            if (capped.truncated) throw sseLineTooLong({ maxBytes });
            buffer = capped.text;
            const parsed = parseMaybeJson({ text: buffer });
            const error = asRecord({ value: asRecord({ value: parsed })?.error });
            if (error) throw payloadError({ parsed, error, headers: response.headers });
        }
        reader = body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            for (let split = splitFrame({ buffer }); split; split = splitFrame({ buffer })) {
                if (Buffer.byteLength(split.frame, 'utf8') > maxBytes) throw sseLineTooLong({ maxBytes });
                buffer = split.rest;
                const parsed = parseFrame({ frame: split.frame });
                if (parsed !== undefined) {
                    frames += 1;
                    yield asChunk({ parsed });
                }
            }
            if (Buffer.byteLength(buffer, 'utf8') > maxBytes) throw sseLineTooLong({ maxBytes });
        }
        // A-11: a 2xx answer that produced no frame and no error is not an
        // event stream. A started `data:` line stays the SDK's incomplete
        // segment; anything else is the typed, non-retryable refusal.
        if (buffer.trim().length > 0) {
            const json = mediaType === 'application/json' || mediaType.endsWith('+json');
            if (frames > 0 || json || /^\s*data:/m.test(buffer)) throw new Error('Incomplete JSON segment at the end');
            throw nonJsonStreamError({ mediaType });
        }
        // An empty event stream is a clean empty answer (the session's
        // empty-response retry owns that case); an empty *non-SSE* body is
        // covered above when it carries bytes. A-11's row is a body that is
        // not an event stream, not a valid zero-frame SSE one.
    } finally {
        dispose?.();
        try { await reader?.cancel(); } catch { /* the body is already gone */ }
        try { reader?.releaseLock(); } catch { /* a pending read still owns the lock */ }
    }
}

/**
 * The auth header one request carries: the API key, else the Vertex bearer the
 * credential module resolves (and caches) per request. The call's signal rides
 * along, so a cancelled call never waits on (or is served from) the token.
 * @param {{apiKey?: string, auth?: GoogleAuth, signal?: AbortSignal}} arg0
 * @returns {Promise<{name: string, value: string}|undefined>}
 */
async function resolveAuthHeader({ apiKey, auth, signal }) {
    if (typeof apiKey === 'string' && apiKey.length > 0) return { name: 'x-goog-api-key', value: apiKey };
    if (auth) {
        const authorization = (await auth.getAuthHeaders({ signal })).get('authorization');
        if (authorization) return { name: 'Authorization', value: authorization };
    }
    throw new ConfigurationError({ message: 'Google credentials are not configured: pass options.apiKey or options.genaiOptions.googleAuthOptions.', options: { option: 'credentials' } });
}

/**
 * The error a non-2xx response raises: `@google/genai`'s `ApiError`, whose body
 * is the JSON as parsed or the SDK's synthesized
 * `{error: {message, code, status}}` for anything else — built from the shared
 * transport's already-capped `{status, statusText, headers, body, text}`.
 * `statusText` is the server's own reason phrase for the synthesized body, as
 * the SDK used it; `headers` ride along so `retry-after` stays readable.
 * @param {{status?: number, statusText?: string, headers?: Headers, body?: unknown, text?: string}} arg0
 * @returns {Error}
 */
function gaiErrorFactory({ status, statusText, headers, body, text }) {
    return createGoogleApiError({ status, statusText, headers, body, text });
}

/**
 * The Google SDK let a failed fetch escape unchanged (`TypeError: fetch
 * failed`); the shared transport classifies it as the OpenAI connection error,
 * so undo exactly that one mapping and rethrow its cause.
 * @param {{error: unknown}} arg0
 * @returns {unknown}
 */
function unwrapConnectionError({ error }) {
    const record = asRecord({ value: error });
    if (record?.message === 'Connection error.' && record.cause !== undefined) return record.cause;
    return error;
}

/**
 * A positive finite per-call timeout, else 0.
 * @param {{value: unknown}} arg0
 * @returns {number}
 */
function numericTimeout({ value }) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * One model object as the SDK returned it: the item plus the `tunedModelInfo`
 * default every fixture pins, and Vertex's `versionId` renamed to `version`.
 * @param {{item: unknown, vertexai: boolean}} arg0
 * @returns {Record<string, unknown>}
 */
function mapModel({ item, vertexai }) {
    const record = asRecord({ value: item }) ?? {};
    /** @type {Record<string, unknown>} */
    const mapped = { ...record, tunedModelInfo: record.tunedModelInfo ?? {} };
    if (vertexai && record.versionId !== undefined && record.version === undefined) {
        mapped.version = record.versionId;
        delete mapped.versionId;
    }
    return mapped;
}

/**
 * The SDK's `Pager`: the current page, the params (its `config.pageToken` is
 * the next-page token), and lazy access to every page.
 * @param {{params: {config: Record<string, unknown>}, page: {items: Array<unknown>, nextPageToken?: unknown}, fetchNext: (arg0: {config: Record<string, unknown>}) => Promise<{items: Array<unknown>, nextPageToken?: unknown}>}} arg0
 */
function createPager({ params, page, fetchNext }) {
    /** @type {Array<unknown>} */
    let items = page.items;
    /** @returns {boolean} */
    const hasNextPage = () => params.config.pageToken !== undefined;
    /** @returns {Promise<Array<unknown>>} */
    const nextPage = async () => {
        if (!hasNextPage()) throw new Error('No more pages to fetch.');
        const fetched = await fetchNext({ config: params.config });
        items = fetched.items;
        params.config.pageToken = fetched.nextPageToken;
        return items;
    };
    const pager = {
        get page() { return items; },
        get params() { return params; },
        get pageSize() { return params.config.pageSize ?? items.length; },
        hasNextPage,
        nextPage,
        async *[Symbol.asyncIterator]() {
            for (;;) {
                for (const item of items) yield item;
                if (!hasNextPage()) return;
                await nextPage();
            }
        },
    };
    params.config.pageToken = page.nextPageToken;
    return pager;
}

/**
 * Builds the native Gemini/Vertex connector: URL, headers, body mapping and the
 * SSE decoder for the four model calls the GAI adapter consumes.
 * @param {GaiTransportOptions} [options]
 * @returns {GaiTransport}
 */
export function createGaiTransport({
    apiKey,
    auth,
    vertexai = false,
    project,
    location = 'global',
    apiVersion,
    baseURL,
    defaultHeaders,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs,
    maxRetries = 0,
} = {}) {
    const version = typeof apiVersion === 'string' && apiVersion.length > 0
        ? apiVersion
        : (vertexai ? VERTEX_API_VERSION : GEMINI_API_VERSION);
    const root = baseURL ?? gaiBaseURL({ vertexai, location });

    /**
     * The request surface every call shares: the resolved credential header, no
     * `accept` (the SDK sends none this connector reproduces), the client's
     * default headers under the per-call ones, and the per-call deadline.
     * @param {{config?: unknown}} arg0
     * @returns {Promise<Record<string, unknown>>}
     */
    async function callOptions({ config }) {
        const callConfig = asRecord({ value: config }) ?? {};
        const httpOptions = asRecord({ value: callConfig.httpOptions }) ?? {};
        const signal = /** @type {AbortSignal|undefined} */ (callConfig.abortSignal);
        return {
            auth: await resolveAuthHeader({ apiKey, auth, signal }),
            accept: null,
            userAgent: USER_AGENT,
            sdkHeaders: { 'x-goog-api-client': USER_AGENT },
            defaultHeaders,
            // The SDK sends `content-type: application/json` on every request,
            // the GET list included; the shared builder only adds it to a POST.
            headers: { 'content-type': 'application/json', ...(/** @type {Record<string, string|null|undefined>} */ (httpOptions.headers ?? {})) },
            signal,
            fetchImpl,
            timeoutMs: numericTimeout({ value: httpOptions.timeout }) || timeoutMs,
            errorFactory: gaiErrorFactory,
        };
    }

    /**
     * One shared-transport call, keeping the SDK's own failed-fetch surface.
     * @param {{send: () => Promise<any>}} arg0
     * @returns {Promise<any>}
     */
    async function sendShared({ send }) {
        try {
            return await send();
        } catch (error) {
            throw unwrapConnectionError({ error });
        }
    }

    /**
     * One page of `models.list`. Vertex lists publisher models without the
     * project/location prefix; the query keys are camelCase either way.
     * @param {{config: Record<string, unknown>}} arg0
     * @returns {Promise<{items: Array<unknown>, nextPageToken?: unknown}>}
     */
    async function fetchPage({ config }) {
        const query = new URLSearchParams();
        for (const key of LIST_QUERY_KEYS) {
            if (config[key] != null) query.set(key, String(config[key]));
        }
        const suffix = query.size > 0 ? `?${query.toString()}` : '';
        const listPath = vertexai ? 'publishers/google/models' : 'models';
        const options = await callOptions({ config });
        const parsed = await sendShared({
            send: () => getJson({ url: joinUrl({ baseURL: root, path: `/${version}/${listPath}${suffix}` }), ...options }),
        });
        const record = asRecord({ value: parsed }) ?? {};
        const rawItems = record.models ?? record.tunedModels ?? record.publisherModels;
        return {
            items: (Array.isArray(rawItems) ? rawItems : []).map((item) => mapModel({ item, vertexai })),
            nextPageToken: record.nextPageToken,
        };
    }

    /**
     * The SDK's `models.list()`: the first page is awaited, later pages are lazy.
     * @param {{config?: unknown}} [arg0]
     * @returns {Promise<GaiPager>}
     */
    async function list({ config } = {}) {
        const params = { config: { ...(asRecord({ value: config }) ?? {}) } };
        return createPager({ params, page: await fetchPage({ config: params.config }), fetchNext: fetchPage });
    }

    /**
     * The SDK's `models.generateContentStream`: an eager open, then a lazy
     * generator over the decoded chunks.
     * @param {{model?: string, contents?: unknown, config?: unknown}} arg0
     * @returns {Promise<AsyncGenerator<unknown, void, unknown>>}
     */
    async function generateContentStream({ model, contents, config } = {}) {
        const body = buildGenerateBody({ contents, config, vertexai });
        const path = `/${version}/${modelResourcePath({ model, vertexai, project, location })}:streamGenerateContent?alt=sse`;
        const options = await callOptions({ config });
        const response = /** @type {Response & {body?: ReadableStream<Uint8Array>, _releaseSignal?: () => void}} */ (
            await sendShared({ send: () => postStream({ url: joinUrl({ baseURL: root, path }), body, raw: true, ...options }) })
        );
        if (!response.body) {
            response._releaseSignal?.();
            throw new Error('Response body is empty');
        }
        return decodeSse({ response, dispose: response._releaseSignal });
    }

    /**
     * The SDK's `models.embedContent`: Gemini batches every content into one
     * `:batchEmbedContents` request; Vertex picks `:embedContent` for a Gemini
     * embed model (except the v1 one) and `:predict` otherwise. The two Vertex
     * endpoints answer different shapes: `{embedding, usageMetadata, truncated}`
     * for `:embedContent`, `predictions[].embeddings` for `:predict`.
     * @param {{model?: string, contents?: unknown, config?: unknown}} arg0
     * @returns {Promise<{embeddings?: unknown}>}
     */
    async function embedContent({ model, contents, config } = {}) {
        const transformed = transformModel({ model, vertexai });
        const options = await callOptions({ config });
        if (!vertexai) {
            const grouped = mldevEmbedContents({
                contents,
                group: typeof model === 'string' && model.includes('gemini-embedding-2'),
            });
            const { request } = embedConfigOf({ config: asRecord({ value: config }) ?? {}, endpoint: 'mldev' });
            const requests = grouped.map((content) => ({ ...request, model: transformed, content: toWireContent(content) }));
            const parsed = await sendShared({
                send: () => postJson({
                    url: joinUrl({ baseURL: root, path: `/${version}/${transformed}:batchEmbedContents` }),
                    body: { requests },
                    ...options,
                }),
            });
            return { embeddings: asRecord({ value: parsed })?.embeddings };
        }
        const embedContentEndpoint = isVertexEmbedContentModel({ model });
        const resource = modelResourcePath({ model, vertexai, project, location });
        if (embedContentEndpoint) {
            const contentsList = toContents(contents);
            if (contentsList.length > 1) throw new Error('The embedContent API for this model only supports one content at a time.');
            const { embedContentConfig } = embedConfigOf({ config: asRecord({ value: config }) ?? {}, endpoint: 'embedContent' });
            const answer = await sendShared({
                send: () => postJson({
                    url: joinUrl({ baseURL: root, path: `/${version}/${resource}:embedContent` }),
                    body: {
                        content: toWireContent(contentsList[0]),
                        ...(Object.keys(embedContentConfig ?? {}).length > 0 ? { embedContentConfig } : {}),
                    },
                    ...options,
                }),
            });
            const parsed = asRecord({ value: answer });
            const embedding = asRecord({ value: parsed?.embedding });
            if (!embedding) return { embeddings: undefined };
            const usage = asRecord({ value: parsed?.usageMetadata }) ?? {};
            /** @type {Record<string, unknown>} */
            const statistics = {};
            if (usage.promptTokenCount) statistics.tokenCount = usage.promptTokenCount;
            if (usage.promptTokensDetails) statistics.tokensDetails = usage.promptTokensDetails;
            if (parsed?.truncated) statistics.truncated = parsed.truncated;
            return { embeddings: [{ ...embedding, statistics }] };
        }
        /** @type {Array<Record<string, unknown>>} */
        const instances = firstTexts({ contents }).map((text) => ({ content: text }));
        const { parameters } = embedConfigOf({ config: asRecord({ value: config }) ?? {}, endpoint: 'predict', instances });
        const answer = await sendShared({
            send: () => postJson({
                url: joinUrl({ baseURL: root, path: `/${version}/${resource}:predict` }),
                body: { instances, ...(Object.keys(parameters ?? {}).length > 0 ? { parameters } : {}) },
                ...options,
            }),
        });
        const parsed = asRecord({ value: answer });
        const predictions = parsed?.predictions;
        return {
            embeddings: Array.isArray(predictions)
                ? predictions.map((prediction) => asRecord({ value: prediction })?.embeddings)
                : undefined,
        };
    }

    return {
        apiKey,
        auth,
        baseURL: root,
        vertexai,
        maxRetries,
        models: {
            generateContentStream,
            list,
            embedContent,
        },
    };
}
