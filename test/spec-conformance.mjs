// @ts-check
/**
 * @file Compiles the pinned vendor API descriptions in `specs/providers/raw/`
 * into one JSON Schema per (provider, operation) root and reports what the
 * vendor's own document says about a request body.
 * @version 0.1.0
 *
 * @description
 * Test-only: nothing under `lib/` reads these documents. The raw snapshots are
 * OpenAPI 3.1 (two of them gzipped), and ajv compiles per ROOT, never a whole
 * document: the root is wrapped with its `components.schemas` so `$ref`s
 * resolve locally.
 *
 * Two compilation rules keep the gate meaningful:
 *   - `unevaluatedProperties: false` on the wrapper. The pinned OpenAI and
 *     OpenRouter request roots do not close their objects, so without it any
 *     unknown key validates and the gate is vacuous. Anthropic and the
 *     embedding root already close themselves; the keyword is then a no-op.
 *   - Known snapshot defects are patched, and each patch asserts that it still
 *     applies. A refreshed snapshot therefore fails loudly when the shim has to
 *     be removed instead of silently validating less.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import Ajv from 'ajv';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = join(HERE, '..', 'specs', 'providers', 'raw');
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

/**
 * The pinned snapshots this gate reads. The `yaml.gz` suffix is the only YAML
 * document; the rest are JSON (gzipped or not).
 * @type {Record<string, {file: string, yaml?: boolean}>}
 */
const SOURCES = {
    openai: { file: 'openai.openapi.yaml.gz', yaml: true },
    openrouter: { file: 'openrouter.openapi.json.gz' },
    anthropic: { file: 'anthropic.openapi.json' },
};

/**
 * The request schema of every operation the adapters build. OpenRouter's
 * `/responses` is `ResponsesRequest` in its document (`ChatRequest` is the
 * `/chat/completions` body); everything else is named by the vendor.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const ROOT_SCHEMAS = Object.freeze({
    openai: Object.freeze({
        chat: 'CreateChatCompletionRequest',
        responses: 'CreateResponse',
        embeddings: 'CreateEmbeddingRequest',
    }),
    openrouter: Object.freeze({
        chat: 'ChatRequest',
        responses: 'ResponsesRequest',
    }),
    anthropic: Object.freeze({
        messages: 'CreateMessageParams',
    }),
});

/**
 * `$ref`s that point at a schema the snapshot does not contain, per provider.
 * Each is replaced with `true` (unconstrained) so the rest of the document
 * compiles; an entry here is a reviewed gap, not a licence to send anything.
 * A refreshed snapshot that adds or removes one fails `patchSchema`, so the
 * list cannot rot silently.
 */
const DANGLING_REFS = /** @type {Readonly<Record<string, ReadonlyArray<string>>>} */ (Object.freeze({
    openai: Object.freeze([]),
    openrouter: Object.freeze([]),
    anthropic: Object.freeze([]),
}));

/**
 * Reads and parses one snapshot.
 * @param {{provider: string}} arg0
 * @returns {Record<string, any>} The parsed OpenAPI document.
 */
function readDocument({ provider }) {
    const source = SOURCES[provider];
    assert.ok(source, `unknown provider '${provider}' (known: ${Object.keys(SOURCES).join(', ')})`);
    const bytes = readFileSync(join(RAW_DIR, source.file));
    const text = (source.file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
    return source.yaml ? YAML.parse(text) : JSON.parse(text);
}

/**
 * Collects every `$ref` whose last segment is not a `components.schemas` name.
 * @param {{schemas: Record<string, any>}} arg0
 * @returns {Set<string>} The dangling `$ref` strings.
 */
function findDanglingRefs({ schemas }) {
    /** @type {Set<string>} */
    const found = new Set();
    /** @param {any} node */
    const walk = (node) => {
        if (Array.isArray(node)) {
            for (const child of node) walk(child);
            return;
        }
        if (!node || typeof node !== 'object') return;
        if (typeof node.$ref === 'string' && !(node.$ref.split('/').pop() in schemas)) found.add(node.$ref);
        for (const value of Object.values(node)) walk(value);
    };
    walk(schemas);
    return found;
}

/**
 * Rewrites the two schema shapes ajv cannot compile: a `$ref` to a schema the
 * snapshot omits, and Discovery-style `type: 'any'`. Both become `true`
 * (unconstrained), in place, so the rest of the document still validates.
 * @param {{node: any, dangling: Set<string>}} arg0
 * @returns {any} The node, or `true` where it was replaced.
 */
function normalizeNode({ node, dangling }) {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) node[i] = normalizeNode({ node: node[i], dangling });
        return node;
    }
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string' && dangling.has(node.$ref)) return true;
    if (node.type === 'any') return true;
    for (const key of Object.keys(node)) node[key] = normalizeNode({ node: node[key], dangling });
    return node;
}

/**
 * Applies the snapshot-defect patches to a `components.schemas` map and
 * asserts that every expected defect is still there.
 * @param {{schemas: Record<string, any>, expectedDanglingRefs?: ReadonlyArray<string>}} arg0
 * @returns {Record<string, any>} The same (mutated) schemas map.
 */
export function patchSchema({ schemas, expectedDanglingRefs = /** @type {ReadonlyArray<string>} */ ([]) }) {
    const dangling = findDanglingRefs({ schemas });
    const found = [...dangling].sort();
    const expected = [...expectedDanglingRefs].sort();
    assert.deepEqual(found, expected,
        'spec snapshot: the dangling-$ref patch no longer matches — a refreshed document added or removed a $ref, so the `true` replacement (and this list) must be reviewed');
    return normalizeNode({ node: schemas, dangling });
}

/**
 * The community Anthropic extraction writes `type: null` on `Model`, which ajv
 * rejects outright ("type value must be [string, array]"). `model` is a
 * `$ref Model` in every request and response schema, so nothing compiles.
 * @param {{schemas: Record<string, any>}} arg0
 * @returns {void}
 */
function patchAnthropicModel({ schemas }) {
    const model = schemas.Model;
    assert.equal(model?.type, null,
        'anthropic snapshot: schemas.Model.type is no longer null — remove the Model type shim from test/spec-conformance.mjs');
    model.type = 'string';
}

/**
 * The JSON Schema dialect an OpenAPI document declares, or the one its version
 * implies.
 * @param {{document: Record<string, any>}} arg0
 * @returns {string} A dialect URI.
 */
function dialectUriFor({ document }) {
    const declared = document.jsonSchemaDialect ?? document.$schema;
    if (typeof declared === 'string') return declared;
    const openapi = String(document.openapi ?? '');
    if (openapi.startsWith('3.1')) return DRAFT_2020_12;
    if (openapi.startsWith('3.0')) return DRAFT_07;
    throw new Error(`spec snapshot: cannot tell the JSON Schema dialect (openapi '${openapi || 'none'}')`);
}

/**
 * The ajv build that speaks the document's dialect.
 * @param {{document: Record<string, any>}} arg0
 * @returns {any} The ajv class (the two builds are not one constructable type).
 */
function ajvClassFor({ document }) {
    const uri = dialectUriFor({ document });
    if (uri.includes('2020-12')) return Ajv2020;
    if (uri.includes('draft-07') || uri.includes('draft-06') || uri.includes('draft-04')) return Ajv;
    throw new Error(`spec snapshot: unsupported JSON Schema dialect '${uri}'`);
}

/**
 * The vendor's `oneOf` unions describe alternatives, not exclusive choices: a
 * body that satisfies two branches (a message that is both an
 * `EasyInputMessage` and an `InputMessage`, say) is one the vendor accepts, but
 * ajv rejects the ambiguity. Validation therefore compiles a copy whose
 * `oneOf` keywords are `anyOf`. Every other keyword is untouched, so a value
 * that matches no branch still fails. The original tree is kept for
 * `schemaNodesAt` / `definesField`.
 * @param {{node: any}} arg0 - A schema (or any JSON value) to copy.
 * @returns {any} The copy, with union exclusivity relaxed.
 */
function relaxUnionExclusivity({ node }) {
    if (Array.isArray(node)) return node.map((child) => relaxUnionExclusivity({ node: child }));
    if (!node || typeof node !== 'object') return node;
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, value] of Object.entries(node)) {
        out[key === 'oneOf' ? 'anyOf' : key] = relaxUnionExclusivity({ node: value });
    }
    return out;
}

/**
 * Loads, patches and compiles one provider's roots. Called once per process
 * per provider (compilation is the expensive part).
 * @param {{provider: string}} arg0
 * @returns {{schemas: Record<string, any>, validators: Record<string, {root: string, validate: any}>}} Compiled roots.
 */
function compileProvider({ provider }) {
    const document = readDocument({ provider });
    assert.ok(document?.components?.schemas, `spec snapshot '${provider}' has no components.schemas`);
    const schemas = patchSchema({ schemas: document.components.schemas, expectedDanglingRefs: DANGLING_REFS[provider] });
    if (provider === 'anthropic') patchAnthropicModel({ schemas });
    const compiledSchemas = relaxUnionExclusivity({ node: schemas });

    const AjvClass = ajvClassFor({ document });
    const dialect = dialectUriFor({ document });
    // `logger: false` silences the vendor's unknown formats (`uri`, `int64`,
    // `double`, `float`, `date`); `validateFormats: false` skips them outright,
    // since this gate is about shape and membership, not byte-level syntax.
    const ajv = new AjvClass({ strict: false, allErrors: true, logger: false, validateFormats: false });
    /** @type {Record<string, {root: string, validate: any}>} */
    const validators = {};
    for (const [operation, root] of Object.entries(ROOT_SCHEMAS[provider])) {
        assert.ok(schemas[root], `spec snapshot '${provider}' has no '${root}' schema for operation '${operation}'`);
        validators[operation] = {
            root,
            validate: ajv.compile({
                $schema: dialect,
                $ref: `#/components/schemas/${root}`,
                unevaluatedProperties: false,
                components: { schemas: compiledSchemas },
            }),
        };
    }
    return { schemas, validators };
}

/** @type {Map<string, ReturnType<typeof compileProvider>>} */
const COMPILED = new Map();

/**
 * The compiled roots for a provider, compiled on first use.
 * @param {{provider: string}} arg0
 * @returns {ReturnType<typeof compileProvider>}
 */
function compiledFor({ provider }) {
    let entry = COMPILED.get(provider);
    if (!entry) {
        entry = compileProvider({ provider });
        COMPILED.set(provider, entry);
    }
    return entry;
}

/**
 * Validates one request body against the provider's root schema.
 * @param {{provider: string, operation: string, body: Record<string, any>}} arg0
 * @returns {{ok: boolean, root: string, errors: Array<any>}} Raw ajv errors.
 */
export function validateRequest({ provider, operation, body }) {
    const { validators } = compiledFor({ provider });
    const entry = validators[operation];
    assert.ok(entry, `no '${operation}' operation for provider '${provider}' (known: ${Object.keys(validators).join(', ')})`);
    const valid = entry.validate(body);
    return { ok: valid, root: entry.root, errors: valid ? [] : (entry.validate.errors ?? []) };
}

/**
 * Every concrete schema node a JSON path can reach. `$ref`, `allOf`, `anyOf`
 * and `oneOf` are flattened (a union contributes all of its branches) and `*`
 * steps into array items, so a path can name a position inside a polymorphic
 * body part.
 * @param {{schemas: Record<string, any>, schema: any, visited?: Set<any>}} arg0
 * @returns {Array<Record<string, any>>}
 */
function expandSchema({ schemas, schema, visited = new Set() }) {
    if (!schema || typeof schema !== 'object' || visited.has(schema)) return [];
    visited.add(schema);
    if (typeof schema.$ref === 'string') {
        return expandSchema({ schemas, schema: schemas[schema.$ref.split('/').pop()], visited });
    }
    const out = [schema];
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
        const branches = schema[keyword];
        if (!Array.isArray(branches)) continue;
        for (const branch of branches) out.push(...expandSchema({ schemas, schema: branch, visited }));
    }
    return out;
}

/**
 * The concrete schema nodes sitting at a JSON path. `''` is the root; a
 * segment of `*` steps into the array items of the node reached so far.
 * @param {{provider: string, operation: string, path: string}} arg0
 * @returns {Array<Record<string, any>>} The nodes, empty when the path resolves to nothing.
 */
export function schemaNodesAt({ provider, operation, path }) {
    const { schemas, validators } = compiledFor({ provider });
    const root = validators[operation];
    assert.ok(root, `no '${operation}' operation for provider '${provider}'`);
    let nodes = expandSchema({ schemas, schema: schemas[root.root] });
    for (const segment of String(path ?? '').split('/').filter(Boolean)) {
        /** @type {Array<Record<string, any>>} */
        const next = [];
        for (const node of nodes) {
            if (segment === '*') {
                if (node.items) next.push(...expandSchema({ schemas, schema: Array.isArray(node.items) ? node.items[0] : node.items }));
            } else if (node.properties?.[segment]) {
                next.push(...expandSchema({ schemas, schema: node.properties[segment] }));
            }
        }
        nodes = next;
    }
    return nodes;
}

/**
 * Whether the provider's own document defines a field at a JSON path. A row is
 * either a property name, or — inside a union — a `type` discriminator value
 * (an unknown block/tool type such as Anthropic's `document`).
 * @param {{provider: string, operation: string, path: string, field: string}} arg0
 * @returns {boolean} `true` when the document defines it (so an allowlist row is stale).
 */
export function definesField({ provider, operation, path, field }) {
    const { schemas } = compiledFor({ provider });
    const nodes = schemaNodesAt({ provider, operation, path });
    return nodes.some((node) => {
        if (node.properties && Object.hasOwn(node.properties, field)) return true;
        const typeSchema = node.properties?.type;
        if (!typeSchema) return false;
        return expandSchema({ schemas, schema: typeSchema })
            .some((typeNode) => typeNode.const === field
                || (Array.isArray(typeNode.enum) && typeNode.enum.includes(field)));
    });
}
