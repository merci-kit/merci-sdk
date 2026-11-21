// @ts-check
/**
 * @file One GAI parity observation for one case.
 * @version 0.21.1
 *
 * @description
 * Drives the real `@google/genai` SDK against a loopback server and returns a
 * JSON-safe observation. The package is imported through a runtime string
 * specifier, so this module still loads after the dependency is removed: only
 * `loadSdk()` fails, and only when a case is actually observed.
 *
 * The client is built with `apiKey` and `httpOptions.baseUrl` and nothing else.
 * `googleAuthOptions` is never passed, so google-auth-library never refreshes a
 * token, and `retryOptions` is never passed, so one case issues exactly one
 * request per expected response.
 *
 * Observations:
 *   `{ kind: 'chunks', chunks, ended, error? }` — `chunks[i]` is
 *   `{ json, text, functionCalls }`, where `json` is the parsed vendor object
 *   the chunk carries and `text`/`functionCalls` are the derived getters our
 *   adapter reads (an absent getter is `null`, never `undefined`). `ended` is
 *   `'clean'` for a normal end and `'threw'` when the iteration raised, with the
 *   error projection alongside.
 *   `{ kind: 'value', value }` — a returned SDK value, reduced the same way; the
 *   models list adds `pages`, the embed response adds `embeddings` and
 *   `embedding`.
 *   `{ kind: 'error', error }` — a call that rejected before yielding anything.
 *
 * `projectError` keeps exactly `{name, message, status, code, error, causeName}`
 * and never dumps the rest of the object. It reads inherited accessors on
 * purpose: `AbortError` is a DOMException whose `name`/`message` live on the
 * prototype, and losing them would hide what the adapter must handle.
 */

/** @type {string} */
const SDK_SPECIFIER = '@google/genai';
const DEFAULT_API_KEY = 'test-api-key';

/**
 * Loads the SDK on demand, so the module itself has no static dependency on it.
 * @returns {Promise<any>}
 */
export async function loadSdk() {
    return import(SDK_SPECIFIER);
}

/**
 * The own properties the SDK attaches to a parsed vendor response. 2.32.0 sets
 * exactly one — `sdkHttpResponse: { headers }` — in the generateContent stream
 * mapping and in every unary response. It is SDK bookkeeping (transport
 * headers, not vendor JSON), so it is removed before anything is recorded: a
 * native connector has no equivalent, and keeping it would make every fixture
 * depend on the response headers and the node version.
 */
const SDK_BOOKKEEPING = ['sdkHttpResponse'];

/**
 * The vendor JSON a response carries, without the SDK's own bookkeeping keys.
 * @param {any} value
 * @returns {any}
 */
function jsonValue(value) {
    if (value === undefined) return null;
    const projected = JSON.parse(JSON.stringify(value));
    if (projected !== null && typeof projected === 'object') {
        for (const key of SDK_BOOKKEEPING) delete projected[key];
    }
    return projected;
}

/**
 * Reduces a thrown value to the comparable wire fields.
 * @param {any} error
 * @returns {{name: string|null, message: string|null, status: any, code: any, error: any, causeName: string|null}}
 */
export function projectError(error) {
    const e = error && typeof error === 'object' ? error : {};
    return {
        name: e.name ?? null,
        message: typeof e.message === 'string' ? e.message : (e.message == null ? null : String(e.message)),
        status: e.status ?? null,
        code: e.code ?? null,
        error: e.error === undefined ? null : jsonValue(e.error),
        causeName: e.cause?.name ?? null,
    };
}

/**
 * Builds the API-key-only client. Every endpoint is the loopback server.
 * @param {{GoogleGenAI: any, case: any, baseUrl: string}} arg0
 * @returns {any}
 */
export function createClient({ GoogleGenAI, case: caseDef, baseUrl }) {
    const client = caseDef.client ?? {};
    return new GoogleGenAI({
        apiKey: client.apiKey ?? DEFAULT_API_KEY,
        ...(client.vertexai ? { vertexai: true, project: client.project, location: client.location } : {}),
        ...(client.apiVersion ? { apiVersion: client.apiVersion } : {}),
        httpOptions: { baseUrl },
    });
}

/**
 * Projects one streamed chunk onto the fields our adapter reads: the vendor
 * object it carries plus the two derived getters.
 * @param {any} chunk
 * @returns {{json: any, text: string|null, functionCalls: Array<any>|null}}
 */
function projectChunk(chunk) {
    return {
        json: jsonValue(chunk),
        text: chunk.text ?? null,
        functionCalls: chunk.functionCalls ?? null,
    };
}

/**
 * Collects one generateContentStream, aborting the caller's signal when asked.
 * @param {{ai: any, case: any}} arg0
 * @returns {Promise<any>}
 */
async function observeStream({ ai, case: caseDef }) {
    const { model, contents, config } = caseDef.request;
    // The SDK mutates `params.config` (it moves a `$schema` responseSchema into
    // responseJsonSchema); a clone keeps the recorded case what cases.mjs declares.
    const baseConfig = config === undefined ? undefined : structuredClone(config);
    const abortAfter = caseDef.mode === 'abort' ? (caseDef.abortAfter ?? 1) : 0;
    const controller = abortAfter > 0 ? new AbortController() : null;
    const callConfig = controller ? { ...(baseConfig ?? {}), abortSignal: controller.signal } : baseConfig;
    const stream = await ai.models.generateContentStream({ model, contents, ...(callConfig ? { config: callConfig } : {}) });

    /** @type {Array<any>} */
    const chunks = [];
    /** @type {'clean'|'threw'} */
    let ended = 'clean';
    /** @type {any} */
    let error;
    try {
        for await (const chunk of stream) {
            chunks.push(projectChunk(chunk));
            if (controller && chunks.length >= abortAfter) controller.abort();
        }
    } catch (thrown) {
        ended = 'threw';
        error = projectError(thrown);
    }
    return { kind: 'chunks', chunks, ended, ...(error ? { error } : {}) };
}

/**
 * Walks every page of models.list, so the paging request is part of the record.
 * @param {{ai: any}} arg0
 * @returns {Promise<any>}
 */
async function observeModels({ ai }) {
    const pager = await ai.models.list();
    const pages = [pager.page];
    while (pager.hasNextPage()) pages.push(await pager.nextPage());
    const models = pages.flat().map((model) => jsonValue(model));
    return { kind: 'value', value: { models, pages: pages.length } };
}

/**
 * Runs models.embedContent and records the response plus the derived values.
 * @param {{ai: any, case: any}} arg0
 * @returns {Promise<any>}
 */
async function observeEmbed({ ai, case: caseDef }) {
    const { model, contents, config } = caseDef.request;
    const response = await ai.models.embedContent({ model, contents, ...(config ? { config } : {}) });
    const embeddings = response.embeddings == null
        ? null
        : /** @type {Array<any>} */ (response.embeddings).map((entry) => entry.values);
    return {
        kind: 'value',
        value: jsonValue(response),
        embeddings,
        embedding: embeddings === null || embeddings.length === 0 ? null : embeddings[0],
    };
}

/**
 * Runs one case and returns its observation.
 * @param {{case: any, baseUrl: string}} arg0
 * @returns {Promise<any>}
 */
export async function observe({ case: caseDef, baseUrl }) {
    const sdk = await loadSdk();
    const ai = createClient({ GoogleGenAI: sdk.GoogleGenAI, case: caseDef, baseUrl });
    try {
        if (caseDef.kind === 'models') return await observeModels({ ai });
        if (caseDef.kind === 'embed') return await observeEmbed({ ai, case: caseDef });
        return await observeStream({ ai, case: caseDef });
    } catch (error) {
        return { kind: 'error', error: projectError(error) };
    }
}
