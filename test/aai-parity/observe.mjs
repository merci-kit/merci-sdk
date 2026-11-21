// @ts-check
/**
 * @file One parity observation for one AAI case.
 * @version 0.21.1
 *
 * @description
 * Drives the real `@anthropic-ai/sdk` against the loopback server and returns a
 * JSON-safe observation. The package is imported through a runtime `string`
 * specifier, so this file still loads once the dependency is gone.
 *
 * Shapes:
 *   messages -> { kind: 'messages', mode, status, events, ended, error? }
 *   models   -> { kind: 'models', mode: 'models', models, pages }
 *   error    -> { kind: 'error', error } (the projected error only)
 *
 * `status` is `stream.response?.status ?? null` — the SDK only sets a response
 * on a successful connect, so a request that fails before headers reports null.
 * `ended` is `'clean' | 'threw'`; a stream can throw after yielding events (a
 * malformed frame, an SSE `error` event, a caller abort), and the events it
 * yielded first are what the connector has to reproduce.
 */

/** The own fields of an SDK error worth pinning. */
const ERROR_KEYS = ['name', 'message', 'status', 'type', 'code', 'param', 'error', 'requestID', 'errorCode', 'details'];

/**
 * JSON projection of a value, as a fixture file can carry it.
 * @param {any} value
 * @returns {any}
 */
function jsonValue(value) {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/**
 * Projects an error onto the comparable wire fields. A field the error does not
 * have (Anthropic has no `code` or `param`) is left out entirely.
 * @param {unknown} error
 * @returns {Record<string, any>}
 */
function projectError(error) {
    const source = error && typeof error === 'object' ? /** @type {Record<string, any>} */ (error) : { message: String(error) };
    /** @type {Record<string, any>} */
    const projected = {};
    for (const key of ERROR_KEYS) {
        const value = source[key];
        if (value === undefined) continue;
        projected[key] = value === null ? null : jsonValue(value);
    }
    return projected;
}

/**
 * Collects every event a message stream yields, plus how the iteration ended.
 * @param {{client: any, case: any}} arg0
 * @returns {Promise<{kind: 'messages', mode: string, status: number|null, events: Array<any>, ended: 'clean'|'threw', error?: Record<string, any>}>}
 */
async function observeMessages({ client, case: caseDef }) {
    const { body, headers } = caseDef.request;
    const controller = caseDef.mode === 'abort' ? new AbortController() : null;
    const stream = client.messages.stream(body, {
        ...(controller ? { signal: controller.signal } : {}),
        ...(headers ? { headers } : {}),
    });
    // The SDK rejects a promise nobody listens to when a request fails before
    // iteration starts. One listener keeps that from becoming an unhandled
    // rejection; `done()` below still fails with the error either way.
    stream.on('error', () => {});

    /** @type {Array<any>} */
    const events = [];
    /** @type {'clean'|'threw'} */
    let ended = 'clean';
    /** @type {Record<string, any>|null} */
    let error = null;
    try {
        for await (const event of stream) {
            events.push(jsonValue(event));
            if (controller && event?.type === 'content_block_delta') controller.abort();
        }
        await stream.done();
    } catch (thrown) {
        ended = 'threw';
        error = projectError(thrown);
    }
    return {
        kind: 'messages',
        mode: caseDef.mode,
        status: stream.response?.status ?? null,
        events,
        ended,
        ...(error ? { error } : {}),
    };
}

/**
 * Iterates the paginated models list to its end, recording the items and how
 * many pages the auto-pagination fetched.
 * @param {{client: any}} arg0
 * @returns {Promise<{kind: 'models', mode: 'models', models: Array<any>, pages: number}>}
 */
async function observeModels({ client }) {
    /** @type {Array<any>} */
    const models = [];
    let pages = 0;
    let page = await client.models.list();
    for (;;) {
        pages += 1;
        for (const model of page.data) {
            models.push({
                id: model.id ?? null,
                display_name: model.display_name ?? null,
                type: model.type ?? null,
                created_at: model.created_at ?? null,
            });
        }
        if (!page.hasNextPage()) break;
        page = await page.getNextPage();
    }
    return { kind: 'models', mode: 'models', models, pages };
}

/**
 * Runs one case and returns its observation.
 * @param {{case: any, baseURL: string, logLevel?: string}} arg0
 * @returns {Promise<any>}
 */
export async function observe({ case: caseDef, baseURL, logLevel }) {
    // Runtime specifiers: the SDK is optional, so the import must not be
    // resolved statically when the package is absent.
    /** @type {string} */
    const sdkModule = '@anthropic-ai/sdk';
    const { default: Anthropic } = await import(sdkModule);
    const client = new Anthropic({ apiKey: 'test-key', baseURL, maxRetries: 0, ...(logLevel ? { logLevel } : {}) });

    if (caseDef.kind === 'models') {
        try {
            return await observeModels({ client });
        } catch (error) {
            return { kind: 'error', error: projectError(error) };
        }
    }

    const observed = await observeMessages({ client, case: caseDef });
    if (caseDef.mode === 'error') return { kind: 'error', error: observed.error ?? null };
    return observed;
}
