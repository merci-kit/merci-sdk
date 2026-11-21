// @ts-check
/**
 * @file Request-conformance gate: every request body the OAI and AAI adapters
 * put on the wire is validated against the vendor's own pinned API description
 * (`specs/providers/raw/`), so a field the vendor does not define fails here
 * instead of reaching production.
 * @version 0.1.0
 *
 * @description
 * Item 1 of `specs/providers/ANALYSIS.md` "Application design". The bodies are
 * not hand-written: `buildVendorRequest` builds them and `executeVendorRequest`
 * (or, for embeddings, `createOaiTransport`) hands them to a fake transport
 * that captures exactly what would have been sent. Fields the vendor defines
 * nowhere at the reported path are suppressed only by an `ALLOWLIST` row with a
 * reason and a review date; the list is monotone — when the pinned document
 * starts defining the field, the row becomes stale and the test fails asking
 * for it to be removed.
 */

import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';

import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { buildParameterMapForOai, buildParameterMapForAai } from '../lib/messaging/unified-parameter.mjs';
import { createOaiTransport } from '../lib/backends/transport/oai-client.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { validateRequest, definesField, schemaNodesAt, patchSchema, ROOT_SCHEMAS } from './spec-conformance.mjs';

/**
 * @typedef {Object} AllowRow
 * @property {string} provider
 * @property {string} operation
 * @property {string} path - JSON path in the body; `*` is any array index, `''` the root.
 * @property {string} field - A property name, or a union member's `type` value.
 * @property {string} reason - Why we deliberately send a shape the pinned document lacks.
 * @property {string} reviewDate - ISO date the row was last read against the document.
 */

/** The date this review was made; bump a row only after re-reading the document. */
const REVIEW_DATE = '2026-11-15';

/**
 * Everything we deliberately send although the pinned document does not define
 * it there. Anthropic dominates: its snapshot is a community extraction that
 * trails `@anthropic-ai/sdk@1.5.0` (see `specs/providers/ANALYSIS.md`).
 * @type {Array<AllowRow>}
 */
const ALLOWLIST = [
    {
        provider: ProviderType.ANTHROPIC,
        operation: 'messages',
        path: '',
        field: 'thinking',
        reason: 'Extended thinking is a top-level `{type, budget_tokens}` object; the pinned extraction has no `thinking` parameter (trails @anthropic-ai/sdk).',
        reviewDate: REVIEW_DATE,
    },
    {
        provider: ProviderType.ANTHROPIC,
        operation: 'messages',
        path: '',
        field: 'output_config',
        reason: 'Structured output (`output_config.format`) and `output_config.effort` are newer than the pinned extraction.',
        reviewDate: REVIEW_DATE,
    },
    {
        provider: ProviderType.ANTHROPIC,
        operation: 'messages',
        path: '',
        field: 'service_tier',
        reason: 'Service tiers postdate the pinned extraction; the parameter is omitted unless the caller asks for a tier.',
        reviewDate: REVIEW_DATE,
    },
    {
        provider: ProviderType.ANTHROPIC,
        operation: 'messages',
        path: '/messages/*/content/*',
        field: 'cache_control',
        reason: 'Prompt caching marks a request content block (`{type:"ephemeral", ttl}`); the pinned request blocks define no `cache_control`.',
        reviewDate: REVIEW_DATE,
    },
    {
        provider: ProviderType.ANTHROPIC,
        operation: 'messages',
        path: '/messages/*/content/*',
        field: 'document',
        reason: 'The extraction has no `document` (PDF) request block; `_mediaBlockToAai` emits the documented `{type:"document", source}` shape.',
        reviewDate: REVIEW_DATE,
    },
    {
        provider: ProviderType.ANTHROPIC,
        operation: 'messages',
        path: '/tools/*',
        field: 'web_search_20260209',
        reason: 'Server-tool types are not in the extraction — it defines the custom tool (`input_schema`) only.',
        reviewDate: REVIEW_DATE,
    },
    {
        provider: ProviderType.ANTHROPIC,
        operation: 'messages',
        path: '/tools/*',
        field: 'web_fetch_20260209',
        reason: 'Server-tool types are not in the extraction — it defines the custom tool (`input_schema`) only.',
        reviewDate: REVIEW_DATE,
    },
];

/** Per-provider model ids, as the backends would send them. */
const MODELS = {
    [ProviderType.OPENAI]: 'gpt-4o',
    [ProviderType.OPENROUTER]: 'openai/gpt-4o',
    [ProviderType.ANTHROPIC]: 'claude-sonnet-4-5',
};

const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const PDF_DATA_URL = 'data:application/pdf;base64,JVBERi0=';

/**
 * The conversation every cell carries: text, an image, an assistant turn with
 * a tool call, its tool result, and a PDF attachment. Shapes are the unified
 * rows the session hands the adapter, not pre-normalized wire bodies.
 */
const PREPARED_MESSAGES = [
    { role: 'system', content: 'You are a careful engineer.' },
    { role: 'user', content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image_url', image_url: { url: IMAGE_DATA_URL } },
    ] },
    {
        role: 'assistant',
        content: 'A small red square.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"merci"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    { role: 'user', content: [
        { type: 'text', text: 'Summarize the attached document.' },
        { type: 'file', file: { filename: 'doc.pdf', file_data: PDF_DATA_URL } },
    ] },
];

const TOOLS = [{
    name: 'lookup',
    description: 'Look up a record.',
    parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
        additionalProperties: false,
    },
}];

/**
 * The maximal unified spec every cell starts from: every parameter the unified
 * builder can translate, so the adapters' conditional branches all run.
 * @type {import('../lib/messaging/unified-parameter.mjs').UnifiedSpec}
 */
const MAX_SPEC = {
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    maxTokens: 1024,
    stop: ['END'],
    seed: 7,
    presencePenalty: 0.1,
    frequencyPenalty: 0.1,
    user: 'user-1',
    responseFormat: {
        type: 'json_schema',
        json_schema: {
            name: 'answer',
            schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
        },
    },
    tools: TOOLS,
    toolChoice: 'auto',
    parallelToolCalls: true,
    reasoningEffort: 'medium',
    thinkingBudget: 2048,
    reasoningSummary: 'auto',
    cachePoints: 2,
    serviceTier: 'auto',
    logprobs: true,
    logprobsTopK: 2,
    previousResponseId: 'resp_123',
    store: false,
    verbosity: 'medium',
    promptCacheKey: 'cache-key',
    metadata: { user_id: 'u1' },
};

/**
 * The OAI request `buildVendorRequest` produces for one cell.
 * @param {{provider: string, protocol: string, stream: boolean}} arg0
 * @returns {Record<string, any>} The vendor request.
 */
function buildOaiRequest({ provider, protocol, stream }) {
    const parameters = buildParameterMapForOai({ spec: structuredClone({ ...MAX_SPEC, stream }) });
    return oaiAdapter.buildVendorRequest({
        model: MODELS[provider],
        parameters,
        tools: structuredClone(TOOLS),
        preparedMessages: structuredClone(PREPARED_MESSAGES),
        session: { provider, protocol },
    }).request;
}

/**
 * The body `executeVendorRequest` really hands the transport — the chat path
 * adds `stream_options`, the non-streaming path drops it, and the Responses
 * path strips `__merciProtocol`.
 * @param {{provider: string, protocol: string, stream: boolean}} arg0
 * @returns {Promise<Record<string, any>>} The captured wire body.
 */
async function captureOaiWireBody({ provider, protocol, stream }) {
    /** @type {Array<Record<string, any>>} */
    const captured = [];
    const vendorClient = {
        chat: { completions: { create: async (/** @type {any} */ body) => { captured.push(body); return (async function* () {})(); } } },
        responses: { create: async (/** @type {any} */ body) => { captured.push(body); return (async function* () {})(); } },
    };
    await oaiAdapter.executeVendorRequest({
        vendorClient,
        request: buildOaiRequest({ provider, protocol, stream }),
        session: {},
    });
    assert.equal(captured.length, 1, 'executeVendorRequest must issue exactly one vendor call');
    return captured[0];
}

/**
 * The Anthropic body as `executeVendorRequest` passes it to the SDK.
 * @returns {Promise<Record<string, any>>} The captured wire body.
 */
async function captureAaiWireBody() {
    const parameters = buildParameterMapForAai({ spec: structuredClone(MAX_SPEC) });
    // The session hands the adapter the last cached-prefix block; the adapter
    // marks it only when one is present, so the matrix supplies it.
    parameters._cacheAnchor = { text: 'Describe this image.' };
    const request = aaiAdapter.buildVendorRequest({
        model: MODELS[ProviderType.ANTHROPIC],
        parameters,
        tools: structuredClone(TOOLS),
        preparedMessages: structuredClone(PREPARED_MESSAGES),
        session: {
            provider: ProviderType.ANTHROPIC,
            protocol: 'messages',
            _webSearch: { mode: 'native', maxUses: 3 },
            _webScrape: { mode: 'native', maxUses: 2 },
        },
    }).request;
    /** @type {Array<Record<string, any>>} */
    const captured = [];
    await aaiAdapter.executeVendorRequest({
        vendorClient: { messages: { stream: (/** @type {any} */ body) => { captured.push(body); return (async function* () {})(); } } },
        request,
        session: {},
    });
    assert.equal(captured.length, 1, 'executeVendorRequest must issue exactly one vendor call');
    return captured[0];
}

/**
 * Mutable body tree with one named path deleted: a property, or — inside a
 * union — a whole member whose `type` matches the field.
 * @param {{parent: any, key: string|number, segments: Array<string>, field: string}} arg0
 * @returns {void}
 */
function pruneAtPath({ parent, key, segments, field }) {
    const value = parent[key];
    if (segments.length === 0) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (Object.hasOwn(value, field)) delete value[field];
            else if (value.type === field && Array.isArray(parent)) parent.splice(/** @type {number} */ (key), 1);
        }
        return;
    }
    const [head, ...rest] = segments;
    if (head === '*' && Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) pruneAtPath({ parent: value, key: i, segments: rest, field });
    } else if (value && typeof value === 'object' && Object.hasOwn(value, head)) {
        pruneAtPath({ parent: value, key: head, segments: rest, field });
    }
}

/**
 * A deep copy of the body with every allowlisted field removed, so the rest of
 * it is still validated. Suppression is only ever granted to a `ALLOWLIST` row
 * whose field the document does not define (asserted separately).
 * @param {{body: Record<string, any>, rows: Array<AllowRow>}} arg0
 * @returns {Record<string, any>} The pruned body.
 */
function pruneAllowlisted({ body, rows }) {
    const pruned = structuredClone(body);
    for (const row of rows) {
        pruneAtPath({ parent: { body: pruned }, key: 'body', segments: row.path.split('/').filter(Boolean), field: row.field });
    }
    return pruned;
}

/**
 * The property a keyword complains about; ajv names it differently per
 * keyword (`unevaluatedProperty` vs `additionalProperty`).
 * @param {{error: any}} arg0
 * @returns {string}
 */
function offendingField({ error }) {
    return String(error.params?.unevaluatedProperty ?? error.params?.additionalProperty ?? '?');
}

/**
 * One readable line per ajv error: provider and operation are added by the
 * caller, the JSON path and the keyword's meaning are here.
 * @param {{error: any, root: string}} arg0
 * @returns {string}
 */
function describeFinding({ error, root }) {
    const at = error.instancePath || '/';
    switch (error.keyword) {
        case 'unevaluatedProperties':
        case 'additionalProperties':
            return `${at}: field '${offendingField({ error })}' is not defined by ${root} (no ALLOWLIST row covers it)`;
        case 'required':
            return `${at}: ${root} requires '${error.params.missingProperty}'`;
        case 'enum':
            return `${at}: value is not one of ${JSON.stringify(error.params.allowedValues)}`;
        case 'const':
            return `${at}: value must be ${JSON.stringify(error.params.allowedValue)}`;
        case 'type':
            return `${at}: value must be ${JSON.stringify(error.params.type)}`;
        case 'oneOf':
        case 'anyOf':
            return `${at}: no ${error.keyword} branch of ${root} accepts this value`;
        default:
            return `${at}: ${error.keyword} ${error.message}`;
    }
}

/**
 * A union that accepted nothing explains itself through its branches, and ajv
 * emits one error per branch — a hundred lines for one wrong part. Collapse
 * each failed union to a single finding that lists its branch objections, and
 * drop the branch errors it produced. Unions nest (an input item's content
 * lives inside the item union), so the deepest union is reported first.
 * @param {{errors: Array<any>, root: string}} arg0
 * @returns {Array<string>} Findings, most direct first.
 */
function summarizeFindings({ errors, root }) {
    /** @type {Map<string, any>} */
    const unions = new Map();
    for (const error of errors) {
        if (error.keyword !== 'oneOf' && error.keyword !== 'anyOf') continue;
        if (!unions.has(error.instancePath)) unions.set(error.instancePath, error);
    }
    const isUnionBranchNoise = (/** @type {any} */ error) => [...unions.keys()].some((path) => (
        error.instancePath === path ? unions.get(path) !== error : error.instancePath.startsWith(`${path}/`)
    ));

    /** @type {Array<{depth: number, line: string, signature: string}>} */
    const unionLines = [];
    for (const [path, union] of unions) {
        const objections = [];
        const seen = new Set();
        for (const error of errors) {
            const under = error.instancePath === path ? error.keyword === 'required' : error.instancePath.startsWith(`${path}/`);
            if (!under || error.keyword === 'oneOf' || error.keyword === 'anyOf') continue;
            const line = describeFinding({ error, root });
            if (seen.has(line)) continue;
            seen.add(line);
            objections.push(line);
        }
        const hint = objections.length > 0 ? ` — branch objections: ${objections.slice(0, 4).join('; ')}` : '';
        unionLines.push({
            depth: path.split('/').length,
            line: `${describeFinding({ error: union, root })}${hint}`,
            signature: objections.join('|'),
        });
    }

    // Nested unions report the same inner objections; keep the deepest of each.
    unionLines.sort((a, b) => b.depth - a.depth);
    const signatures = new Set();
    const lines = [];
    for (const entry of unionLines) {
        if (signatures.has(entry.signature)) continue;
        signatures.add(entry.signature);
        lines.push({ depth: entry.depth, line: entry.line });
    }

    for (const error of errors) {
        if (error.keyword === 'oneOf' || error.keyword === 'anyOf') continue;
        if (isUnionBranchNoise(error)) continue;
        lines.push({ depth: error.instancePath.split('/').length, line: describeFinding({ error, root }) });
    }

    lines.sort((a, b) => (b.depth - a.depth) || a.line.localeCompare(b.line));
    const unique = [...new Set(lines.map((entry) => entry.line))];
    const out = unique.slice(0, 12).map((line) => `  • ${line}`);
    if (unique.length > out.length) out.push(`  … ${unique.length - out.length} more finding(s)`);
    return out;
}

/**
 * Validates one captured body, after the reviewed suppressions, and fails with
 * the provider, the operation, every JSON path the vendor objects to, and the
 * document that objects.
 * @param {{provider: string, operation: string, body: Record<string, any>, label: string}} arg0
 * @returns {void}
 */
function assertConforms({ provider, operation, body, label }) {
    const rows = ALLOWLIST.filter((row) => row.provider === provider && row.operation === operation);
    const { ok, root, errors } = validateRequest({ provider, operation, body: pruneAllowlisted({ body, rows }) });
    if (ok) return;
    const findings = summarizeFindings({ errors, root });
    assert.fail([
        `request conformance: provider=${provider} operation=${operation} root=${root} cell=${label}`,
        ...findings,
        'An unrecognised field is either an adapter defect or needs an ALLOWLIST row (provider, operation, path, field, reason, reviewDate) in test/spec-request-conformance.test.mjs.',
    ].join('\n'));
}

/**
 * Every adapter cell this gate drives.
 * @type {Array<{provider: string, operation: 'chat'|'responses', protocol: string, stream: boolean}>}
 */
const CELL_CASES = [
    { provider: ProviderType.OPENAI, operation: 'chat', protocol: 'completions', stream: true },
    { provider: ProviderType.OPENAI, operation: 'chat', protocol: 'completions', stream: false },
    { provider: ProviderType.OPENAI, operation: 'responses', protocol: 'responses', stream: true },
    { provider: ProviderType.OPENAI, operation: 'responses', protocol: 'responses', stream: false },
    { provider: ProviderType.OPENROUTER, operation: 'chat', protocol: 'completions', stream: true },
    { provider: ProviderType.OPENROUTER, operation: 'chat', protocol: 'completions', stream: false },
    { provider: ProviderType.OPENROUTER, operation: 'responses', protocol: 'responses', stream: true },
    { provider: ProviderType.OPENROUTER, operation: 'responses', protocol: 'responses', stream: false },
];
const CELLS = CELL_CASES.map((cell) => ({ ...cell, label: `${cell.protocol}, stream=${cell.stream}` }));

describe('request conformance: the bodies the adapters send', () => {
    for (const cell of CELLS) {
        test(`${cell.provider} ${cell.operation} (${cell.label}) matches ${ROOT_SCHEMAS[cell.provider][cell.operation]}`, async () => {
            const body = await captureOaiWireBody(cell);
            assertConforms({ provider: cell.provider, operation: cell.operation, body, label: cell.label });
        });
    }

    test(`anthropic messages matches ${ROOT_SCHEMAS[ProviderType.ANTHROPIC].messages}`, async () => {
        const body = await captureAaiWireBody();
        assertConforms({ provider: ProviderType.ANTHROPIC, operation: 'messages', body, label: 'messages' });
    });
});

describe('request conformance: embeddings body', () => {
    test(`the transport's embeddings body matches ${ROOT_SCHEMAS[ProviderType.OPENAI].embeddings}`, async () => {
        /** @type {Array<Record<string, any>>} */
        const sentBodies = [];
        const fakeFetch = async (/** @type {any} */ _url, /** @type {any} */ init) => {
            sentBodies.push(JSON.parse(init.body));
            // A valid base64 float32 vector, which the transport decodes in place.
            const vector = Buffer.from(new Float32Array([1, 2, 3]).buffer).toString('base64');
            return new Response(JSON.stringify({
                object: 'list',
                data: [{ object: 'embedding', index: 0, embedding: vector }],
                model: 'text-embedding-3-small',
                usage: { prompt_tokens: 3, total_tokens: 3 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        const transport = createOaiTransport({ apiKey: 'sk-test', baseURL: 'https://api.openai.com/v1', fetch: fakeFetch });
        await transport.embeddings.create({ model: 'text-embedding-3-small', input: ['alpha', 'beta'], encoding_format: 'float' });
        assert.equal(sentBodies.length, 1, 'the fake fetch must have captured the embeddings request');
        const sent = sentBodies[0];
        assert.equal(sent.encoding_format, 'float', 'the matrix must exercise the caller-chosen encoding');
        assertConforms({ provider: ProviderType.OPENAI, operation: 'embeddings', body: sent, label: 'embeddings.create' });
    });
});

describe('request conformance: the matrix is not vacuous', () => {
    test('the captured body is what executeVendorRequest sends, not the builder output', async () => {
        const streaming = await captureOaiWireBody({ provider: ProviderType.OPENAI, protocol: 'completions', stream: true });
        assert.equal(streaming.stream, true, 'the streaming chat cell must ask for a stream');
        assert.deepEqual(streaming.stream_options, { include_usage: true }, 'the streaming chat body must carry the transport-added stream_options');

        const nonStreaming = await captureOaiWireBody({ provider: ProviderType.OPENAI, protocol: 'completions', stream: false });
        assert.equal(nonStreaming.stream, false, 'the non-streaming chat cell must not ask for a stream');
        assert.equal('stream_options' in nonStreaming, false, 'stream_options must not reach a stream:false call');

        const responses = await captureOaiWireBody({ provider: ProviderType.OPENAI, protocol: 'responses', stream: true });
        assert.equal('__merciProtocol' in responses, false, 'the Merci-internal __merciProtocol marker must never reach the wire');
    });

    test('every content shape the gate claims to cover really reaches the wire', async () => {
        const chat = await captureOaiWireBody({ provider: ProviderType.OPENAI, protocol: 'completions', stream: true });
        const chatParts = chat.messages.flatMap((/** @type {any} */ m) => (Array.isArray(m.content) ? m.content : []));
        assert.ok(chatParts.some((/** @type {any} */ p) => p.type === 'image_url'), 'a chat image part must reach the wire');
        assert.ok(chatParts.some((/** @type {any} */ p) => p.type === 'file'), 'a chat PDF part must reach the wire');
        assert.ok(chat.messages.some((/** @type {any} */ m) => Array.isArray(m.tool_calls)), 'a chat tool call must reach the wire');
        assert.ok(chat.messages.some((/** @type {any} */ m) => m.role === 'tool'), 'a chat tool result must reach the wire');

        const responses = await captureOaiWireBody({ provider: ProviderType.OPENAI, protocol: 'responses', stream: false });
        const itemTypes = responses.input.map((/** @type {any} */ item) => item.type);
        assert.ok(itemTypes.includes('function_call') && itemTypes.includes('function_call_output'), 'Responses must carry the tool pair');
        const partTypes = responses.input.flatMap((/** @type {any} */ item) => (Array.isArray(item.content) ? item.content.map((/** @type {any} */ p) => p.type) : []));
        assert.ok(partTypes.includes('input_image'), 'a Responses image part must reach the wire');
        assert.ok(partTypes.includes('input_file'), 'a Responses PDF part must reach the wire');

        const anthropic = await captureAaiWireBody();
        const blockTypes = anthropic.messages.flatMap((/** @type {any} */ m) => m.content.map((/** @type {any} */ b) => b.type));
        for (const expected of ['text', 'image', 'document', 'tool_use', 'tool_result']) {
            assert.ok(blockTypes.includes(expected), `an Anthropic ${expected} block must reach the wire`);
        }
        assert.ok(anthropic.messages.some((/** @type {any} */ m) => m.content.some((/** @type {any} */ b) => b.cache_control)), 'a cache breakpoint must reach the wire');
        assert.ok(anthropic.tools.some((/** @type {any} */ t) => t.type === 'web_search_20260209'), 'the native search tool must reach the wire');
        assert.ok(anthropic.tools.some((/** @type {any} */ t) => t.type === 'web_fetch_20260209'), 'the native scrape tool must reach the wire');
    });
});

describe('request conformance: the loader stays strict', () => {
    test('required fields are still enforced: an empty body is rejected', () => {
        for (const cell of [
            { provider: ProviderType.OPENAI, operation: 'chat' },
            { provider: ProviderType.ANTHROPIC, operation: 'messages' },
        ]) {
            const { ok, errors } = validateRequest({ provider: cell.provider, operation: cell.operation, body: {} });
            assert.equal(ok, false, `${cell.provider}/${cell.operation}: an empty body must not validate`);
            assert.ok(errors.some((/** @type {any} */ error) => error.keyword === 'required'),
                `${cell.provider}/${cell.operation}: the missing required field must be named`);
        }
    });

    test('a value that matches no union branch still fails after the relaxation', () => {
        const body = { model: 'gpt-4o', input: [{ type: 'message', role: 'user', content: [{ type: 'not_a_content_part' }] }] };
        const { ok, errors } = validateRequest({ provider: ProviderType.OPENAI, operation: 'responses', body });
        assert.equal(ok, false, 'an unrecognised content part must not validate');
        assert.ok(errors.some((/** @type {any} */ error) => error.instancePath === '/input/0/content/0'),
            `the failure must name the part (got: ${errors.map((/** @type {any} */ error) => error.instancePath).join(', ')})`);
    });

    test('a message satisfying two union branches is accepted after the relaxation', () => {
        // The pinned `InputItem` union lets a user message with a content list
        // be both an `EasyInputMessage` and an `Item`; the vendor accepts it.
        const body = { model: 'gpt-4o', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] };
        const { ok, errors } = validateRequest({ provider: ProviderType.OPENAI, operation: 'responses', body });
        assert.equal(ok, true, `an ambiguous-but-valid message must pass (errors: ${JSON.stringify(errors)})`);
    });
});

describe('request conformance: the allowlist stays honest', () => {
    test('every row is well formed and names a path the document can resolve', () => {
        for (const row of ALLOWLIST) {
            assert.ok(ROOT_SCHEMAS[row.provider]?.[row.operation], `allowlist row names an unknown provider/operation: ${row.provider}/${row.operation}`);
            assert.ok(row.reason && row.reason.length > 20, `allowlist row needs a real reason: ${row.provider} ${row.path} ${row.field}`);
            assert.match(row.reviewDate, /^\d{4}-\d{2}-\d{2}$/, `allowlist row needs an ISO review date: ${row.field}`);
            assert.ok(schemaNodesAt({ provider: row.provider, operation: row.operation, path: row.path }).length > 0,
                `allowlist path '${row.path}' resolves to nothing in ${row.provider}/${row.operation} — fix the path, monotonicity is blind without it`);
        }
    });

    test('no row is stale: the pinned documents still do not define any allowlisted field', () => {
        const stale = ALLOWLIST
            .filter((row) => definesField({ provider: row.provider, operation: row.operation, path: row.path, field: row.field }))
            .map((row) => `${row.provider}/${row.operation} ${row.path || '/'} '${row.field}'`);
        assert.deepEqual(stale, [], 'the pinned document now defines these fields — remove their ALLOWLIST rows so they are validated for real');
    });

    test('the gate rejects a field no reviewed row covers', async () => {
        const body = await captureOaiWireBody({ provider: ProviderType.OPENAI, protocol: 'completions', stream: true });
        const { ok, errors } = validateRequest({ provider: ProviderType.OPENAI, operation: 'chat', body: { ...body, reasoning_summary: 'auto' } });
        assert.equal(ok, false, 'an undefined field must fail the gate');
        assert.ok(
            errors.some((/** @type {any} */ error) => error.keyword === 'unevaluatedProperties' && error.params.unevaluatedProperty === 'reasoning_summary'),
            `the failure must name the field (got: ${errors.map((/** @type {any} */ error) => error.instancePath).join(', ')})`,
        );
    });

    test('suppression comes only from ALLOWLIST rows: the unpruned body still fails', async () => {
        const body = await captureAaiWireBody();
        const { ok, errors } = validateRequest({ provider: ProviderType.ANTHROPIC, operation: 'messages', body });
        assert.equal(ok, false, 'without the allowlist the Anthropic body must fail, so the rows are load-bearing');
        const extraFields = errors
            .filter((/** @type {any} */ error) => error.keyword === 'additionalProperties')
            .map((/** @type {any} */ error) => error.params.additionalProperty);
        for (const field of ['thinking', 'output_config', 'service_tier']) {
            assert.ok(extraFields.includes(field), `the raw body must be rejected for '${field}'`);
        }
    });

    test('the dangling-$ref shim replaces a missing target with an unconstrained schema', () => {
        const patched = patchSchema({
            schemas: { RequestDocumentBlock: { $ref: '#/components/schemas/NotInTheDocument' }, Kept: { type: 'string' } },
            expectedDanglingRefs: ['#/components/schemas/NotInTheDocument'],
        });
        assert.equal(patched.RequestDocumentBlock, true, 'a dangling $ref must become unconstrained, never fail the whole compile');
        assert.deepEqual(patched.Kept, { type: 'string' }, 'the rest of the document must survive the shim');
        assert.throws(
            () => patchSchema({ schemas: { A: { $ref: '#/components/schemas/Missing' } }, expectedDanglingRefs: [] }),
            /dangling-\$ref patch no longer matches/,
            'an unreviewed dangling $ref must fail loudly, not be swallowed',
        );
    });

    test('the shim maps Discovery-style type:"any" to an unconstrained schema', () => {
        const patched = patchSchema({ schemas: { Freeform: { type: 'any', description: 'anything' } } });
        assert.equal(patched.Freeform, true, 'JSON Schema has no "any" type, so the node must become unconstrained');
    });
});
