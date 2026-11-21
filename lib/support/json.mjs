// @ts-check
/**
 * merci.0.7.2.json.mjs
 *
 * A robust utility for handling structured JSON output from LLMs.
 * Integrates @freakynit/json-healer for structural repair and Ajv for schema validation.
 * A schema may be plain JSON Schema (validated with Ajv) or a Zod schema (validated with
 * `safeParse`); Zod schemas are converted to JSON Schema only at the wire boundary.
 *
 * @version 0.12.0
 * @license Apache-2.0 — see the LICENSE file at the repository root.
 */
import JsonHealer from '@freakynit/json-healer';
import { Ajv } from 'ajv';
import { toJSONSchema } from 'zod';

const _ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
/**
 * A second validator for checks that must not mutate what they check (see
 * `validateValue`): no defaults are filled in and no types are coerced.
 */
const _ajvStrict = new Ajv({ allErrors: true, useDefaults: false, coerceTypes: false, strict: false });
const _healerOptions = { aggressive: true };
/** Identity fast path, then a text key so an equal schema in a new object reuses the compile. */
const _validatorCache = new WeakMap();
const _validatorTextCache = new Map();
const _strictValidatorCache = new WeakMap();
const _strictValidatorTextCache = new Map();

/**
 * One compile per schema per strictness.
 *
 * - The WeakMap hit is free for the same object.
 * - The text cache catches the same schema in a new object.
 * - Ajv refuses a second DISTINCT schema with an `$id` already compiled on the
 *   instance ("schema with key or id ... already exists"), so that case is
 *   compiled on a fresh instance with the same options and cached.
 * @param {{schema: *, strict: boolean}} arg0
 * @returns {*} The compiled Ajv validator.
 */
function _compileCached({ schema, strict }) {
    const instance = strict ? _ajvStrict : _ajv;
    if (typeof schema !== 'object' || schema === null) return instance.compile(schema);
    const identityCache = strict ? _strictValidatorCache : _validatorCache;
    const textCache = strict ? _strictValidatorTextCache : _validatorTextCache;
    const known = identityCache.get(schema);
    if (known) return known;
    let key = null;
    try { key = JSON.stringify(schema); } catch { key = null; }
    if (key !== null) {
        const byText = textCache.get(key);
        if (byText) {
            identityCache.set(schema, byText);
            return byText;
        }
    }
    let validate;
    try {
        validate = instance.compile(schema);
    } catch (err) {
        const message = String(/** @type {any} */ (err)?.message ?? '');
        if (!message.includes('already exists')) throw err;
        validate = new Ajv(strict
            ? { allErrors: true, useDefaults: false, coerceTypes: false, strict: false }
            : { allErrors: true, useDefaults: true, strict: false }).compile(schema);
    }
    identityCache.set(schema, validate);
    if (key !== null) textCache.set(key, validate);
    return validate;
}

/** @param {{schema: *}} arg0 */
function _getValidator({ schema }) {
    return _compileCached({ schema, strict: false });
}

/**
 * A JSON Schema — any JSON object of keywords. Deliberately open: the schema is
 * the caller's, and its keywords are not the SDK's to enumerate.
 * @typedef {Record<string, unknown>} JsonSchema
 */

/**
 * A Zod schema, seen structurally: `safeParse` is the contract; the version
 * markers only say which converter can read it.
 * @typedef {Object} ZodSchema
 * @property {(value: unknown) => {success: boolean, data?: unknown, error?: unknown}} safeParse
 * @property {Object} [_def]
 * @property {Object} [_zod]
 */

/**
 * What the parser can validate against: a JSON Schema object or a Zod schema.
 * `isZodSchema` discriminates; every other reader treats it as JSON.
 * @typedef {JsonSchema|ZodSchema} SchemaLike
 */

/**
 * One validation failure, from Ajv or normalized from Zod.
 * @typedef {Object} ValidationDetail
 * @property {string} [instancePath]
 * @property {string} [message]
 * @property {string} [code]
 * @property {string} [keyword]
 * @property {string} [schemaPath]
 * @property {Record<string, unknown>} [params]
 */

/**
 * The parse/validation result both entry points share.
 * @typedef {Object} ParseResult
 * @property {boolean} success
 * @property {unknown} data - The parsed JSON value, when `success`.
 * @property {string|null} error
 * @property {Array<ValidationDetail>|null} details
 * @property {boolean} healed
 * @property {boolean} originalValid
 */

const _jsonSchemaCache = new Map();
const _MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const WIRE_HOSTILE_KEYWORDS = ['anyOf', 'oneOf', 'allOf', '$ref'];
const SCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', '$defs', 'definitions'];


/**
 * working when zod is resolved to more than one copy.
 * @param {{schema: unknown}} arg0 -
 * @returns {boolean}
 */
export function isZodSchema({ schema }) {
    return !!schema
        && typeof schema === 'object'
        && typeof (/** @type {ZodSchema} */ (schema)).safeParse === 'function'
        && (typeof (/** @type {ZodSchema} */ (schema))._def === 'object'
            || typeof (/** @type {ZodSchema} */ (schema))._zod === 'object'
            || '~standard' in schema);
}


/** @param {{schema: *}} arg0 */
function _isZodV4({ schema }) {
    return typeof schema?._zod === 'object';
}

/** @param {{schema: *, value: *}} arg0 */
function _ajvVerdict({ schema, value }) {
    const validate = _getValidator({ schema });
    return validate(value) ? { ok: true } : { ok: false, details: validate.errors };
}


/**
 * The non-mutating verdict (no defaults, no coercion).
 * @param {{schema: *, value: *}} arg0
 */
function _ajvStrictVerdict({ schema, value }) {
    const validate = _compileCached({ schema, strict: true });
    return validate(value) ? { ok: true } : { ok: false, details: validate.errors };
}

/** @param {{schema: *, value: *}} arg0 */
function _zodVerdict({ schema, value }) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return { ok: true, data: parsed.data };
    return { ok: false, details: _toZodDetails({ error: parsed.error }) };
}


/** @param {{error: *}} arg0 */
function _toZodDetails({ error }) {
    const issues = Array.isArray(error?.issues) ? error.issues : [];
    return issues.map(/** @type {(...args: any[]) => any} */ (( issue) => ({
        instancePath: issue.path?.length ? `/${issue.path.join('/')}` : '',
        message: issue.message,
        code: issue.code
    })));
}



/**
 * @param {*} node
 * @returns {*}
 */
function _stripSchemaNoise(node) {
    if (Array.isArray(node)) return node.map(_stripSchemaNoise);
    if (node === null || typeof node !== 'object') return node;
    
    /** @type {Record<string, any>} */
        const out = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === '$schema') continue;
        if ((key === 'minimum' && value === -_MAX_SAFE_INTEGER)
            || (key === 'maximum' && value === _MAX_SAFE_INTEGER)) continue;
        out[key] = _stripSchemaNoise(value);
    }
    return out;
}


/**
 * Returns `null` when the argument is not a Zod schema, or is Zod v3 — v4's converter
 * cannot read a v3 instance (it throws), so callers must warn instead of sending a
 * broken schema. Memoized by schema identity; internal schemas are module constants.
 * @param {{zodSchema: unknown}} arg0 -
 * @returns {JsonSchema|null} JSON Schema, or null when not convertible
 */
export function zodSchemaToJsonSchema({ zodSchema }) {
    if (!isZodSchema({ schema: zodSchema }) || !_isZodV4({ schema: zodSchema })) return null;
    const cached = _jsonSchemaCache.get(zodSchema);
    if (cached) return cached;
    const jsonSchema = _stripSchemaNoise(toJSONSchema(/** @type {any} */ (zodSchema), /** @type {any} */ ({ io: 'input', target: 'draft-7' })));
    _jsonSchemaCache.set(zodSchema, jsonSchema);
    return jsonSchema;
}


/**
 * and a union `type` array (`{ type: ['string','null'] }`) — zod emits that form for
 * `.nullable()` and primitive unions, and it is as wire-hostile as `anyOf`.
 * Shared by the wire guard and the schema parity tests so both use one definition.
 * @param {{node: unknown, found?: Set<string>}} arg0 - schema fragment
 * @returns {Set<string>} offending constructs present anywhere in the schema
 */
export function findWireHostileKeywords({ node, found = new Set() }) {
    if (Array.isArray(node)) {
        for (const item of node) findWireHostileKeywords({ node: item, found });
        return found;
    }
    if (node === null || typeof node !== 'object') return found;
    for (const [key, value] of Object.entries(node)) {
        if (WIRE_HOSTILE_KEYWORDS.includes(key)) found.add(key);
        if (key === 'type' && Array.isArray(value)) found.add('type[]');
        if (SCHEMA_MAP_KEYWORDS.includes(key)) {
            for (const sub of Object.values(value ?? {})) findWireHostileKeywords({ node: sub, found });
            continue;
        }
        findWireHostileKeywords({ node: value, found });
    }
    return found;
}


/**
 * Parses a payload against a schema (JSON Schema or Zod), repairing it when it is nearly valid.
 * Use `validateStrict` instead for persisted state, where a corrupt payload must
 * be rejected rather than repaired.
 * @param {{input: string|object|Array<unknown>, schema?: SchemaLike, options?: {heal?: boolean}}} arg0 - Raw response from the model.
 * @returns {ParseResult}
 */
export function guardedParse({ input, schema, options = {} }) {
    const heal = options?.heal !== false;

    /** @type {ParseResult} */
    const result = {
        success: false,
        data: null,
        error: null,
        details: null,
        healed: false,
        originalValid: false
    };

    let normalizedInput = input;
    if (typeof normalizedInput === 'object' && normalizedInput !== null) {
        try {
            normalizedInput = JSON.stringify(normalizedInput);
        } catch (e) {
            result.error = "Input object cannot be stringified";
            return result;
        }
    }

    if (typeof normalizedInput !== 'string') {
        result.error = "Input is not a string";
        return result;
    }

    let parsedObject = null;

    try {
        parsedObject = JSON.parse(normalizedInput);
        result.originalValid = true;
    } catch (e) {
        result.originalValid = false;
    }

    if (!result.originalValid) {
        if (!heal) {
            result.error = "Failed to parse JSON structure";
            return result;
        }
        parsedObject = JsonHealer.parse(normalizedInput, _healerOptions);
        if (parsedObject !== null) {
            result.healed = true;
        } else {
            result.error = "Failed to parse or heal JSON structure";
            return result;
        }
    }

    if (!schema) {
        result.success = true;
        result.data = parsedObject;
        return result;
    }

    result.data = parsedObject;
    let verdict;
    try {
        verdict = (
            isZodSchema({ schema })
                ? _zodVerdict({ schema, value: parsedObject })
                : _ajvVerdict({ schema, value: parsedObject })
        );
    } catch (schemaErr) {
        result.data = null;
        result.error = (/** @type {any} */ (schemaErr))?.message
            ? `Schema Validation Failed: ${(/** @type {any} */ (schemaErr)).message}`
            : "Schema Validation Failed";
        /** @type {any} */ (result).rawInput = input;
        return result;
    }
    if (verdict.ok) {
        result.success = true;
        if (/** @type {any} */ (verdict).data !== undefined) result.data = /** @type {any} */ (verdict).data;
    } else {
        result.error = "Schema Validation Failed";
        result.details = verdict.details;
    }
    return result;
}


/**
 * Same result contract, except a malformed payload is never repaired: it fails with
 * `"Failed to parse JSON structure"` and `originalValid === false`. Callers keep their
 * own error policy (throw / warn / fall back to empty) — they just get a schema-checked
 * shape instead of hand-rolled `Array.isArray` probes.
 *
 * "Strict" is about repair, not about defaults: the parser runs with
 * `useDefaults: true`, so `result.data` may gain fields the input never had. Read
 * `result.data`, never the input, and use `validateValue` when the check must not
 * rewrite the value it checks.
 * @param {{input: string|object|Array<unknown>, schema?: SchemaLike}} arg0 -
 * @returns {ParseResult}
 */
export function validateStrict({ input, schema }) {
    return guardedParse({ input, schema, options: { heal: false } });
}


/**
 * Validates an **already parsed** value against a JSON Schema without
 * touching it.
 *
 * `guardedParse` compiles with `useDefaults: true` (its parser fills in the
 * schema's defaults — right for parsing an incoming payload, wrong for
 * checking a value the SDK already owns: it would silently rewrite the
 * caller's object). This validator is compiled separately, with defaults and
 * type coercion off, so a check never mutates what it checks.
 *
 * @param {{ value: unknown, schema: SchemaLike }} arg0 -
 * @returns {{ ok: boolean, details: Array<ValidationDetail>|null }}
 */
export function validateValue({ value, schema }) {
    if (!schema || typeof schema !== 'object') return { ok: true, details: null };
    if (isZodSchema({ schema })) {
        const verdict = _zodVerdict({ schema, value });
        return verdict.ok ? { ok: true, details: null } : { ok: false, details: verdict.details };
    }
    const verdict = _ajvStrictVerdict({ schema, value });
    return verdict.ok ? { ok: true, details: null } : { ok: false, details: verdict.details };
}


/**
 * plain JSON Schema, and an unconvertible (Zod v3) one is emptied rather than leaked.
 * A tool whose parameters are already JSON Schema is returned unchanged.
 * This is the single conversion point for every tool surface — the session tool list
 * (`withTools`) and the MCP advertisement both call it, so a Zod instance can never
 * reach a vendor request or a tool listing.
 * @template {{name?: string, parameters?: unknown}} T
 * @param {{tool: T, onWarn?: (arg0: { message: string }) => void}} arg0 - one call per problem (unconvertible, hostile)
 * @returns {T} the tool, or a copy carrying JSON-Schema parameters
 */
export function toWireToolParameters({ tool, onWarn }) {
    if (!tool?.parameters || !isZodSchema({ schema: tool.parameters })) return tool;
    const wire = zodSchemaToJsonSchema({ zodSchema: tool.parameters });
    if (!wire) {
        onWarn?.({ message: `Tool '${tool.name}' has a Zod schema that could not be converted to JSON Schema (Zod v3 is not supported here) — its parameters were emptied.` });
        return /** @type {T} */ ({ ...tool, parameters: { type: 'object', properties: {} } });
    }
    const hostile = findWireHostileKeywords({ node: wire });
    if (hostile.size > 0) {
        onWarn?.({ message: `Tool '${tool.name}' uses ${[...hostile].join(', ')}, which JAI/Gemini reject — express it without unions or nullable fields.` });
    }
    return /** @type {T} */ ({ ...tool, parameters: wire });
}


/**
 * (from first '{' or '[' to its MATCHING close) to bypass markdown code blocks,
 * backticks, or conversational text, and runs it through guardedParse.
 * The old first-to-last extraction pulled in trailing prose (or a second JSON
 * object) when the answer had a stray brace after it — the healer then had to
 * salvage the garbage. A depth-scanned span is exact.
 * @param {{input: string|JsonSchema, schema?: SchemaLike}} arg0 - Raw text from the LLM or parsed object.
 * @returns {ParseResult} Parse result from guardedParse.
 */
export function extractAndParseJson({ input, schema }) {
    if (typeof input !== 'string') {
        return guardedParse({ input, schema });
    }

    /** @type {ParseResult|null} */
    let firstFailure = null;
    let searchFrom = 0;

    while (searchFrom < input.length) {
        const nextBrace = input.indexOf('{', searchFrom);
        const nextBracket = input.indexOf('[', searchFrom);

        let startIdx = -1;
        let openChar = '';
        let closeChar = '';

        if (nextBrace !== -1 && (nextBracket === -1 || nextBrace < nextBracket)) {
            startIdx = nextBrace;
            openChar = '{';
            closeChar = '}';
        } else if (nextBracket !== -1) {
            startIdx = nextBracket;
            openChar = '[';
            closeChar = ']';
        }

        if (startIdx === -1) break;

        const endIdx = _matchingBracket({ input, startIdx, openChar, closeChar });
        if (endIdx === -1) {
            const tailRes = guardedParse({ input: input.substring(startIdx), schema });
            if (tailRes.success) return tailRes;
            firstFailure = firstFailure ?? tailRes;
            searchFrom = startIdx + 1;
            continue;
        }

        const candidate = input.substring(startIdx, endIdx + 1);
        const res = guardedParse({ input: candidate, schema });
        if (res.success) return res;
        firstFailure = firstFailure ?? res;
        searchFrom = startIdx + 1;
    }

    return firstFailure ?? guardedParse({ input, schema });
}


/** @param {{input: *, startIdx: *, openChar: *, closeChar: *}} arg0 */
function _matchingBracket({ input, startIdx, openChar, closeChar }) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < input.length; i++) {
        const ch = input[i];
        if (inString) {
            if (escape) escape = false;
            else if (ch === '\\') escape = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === openChar) depth++;
        else if (ch === closeChar) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}