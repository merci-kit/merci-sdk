// @ts-check
/**
 * @file One parity observation for one AAI case, through the native transport.
 * @version 0.22.0
 *
 * @description
 * The counterpart of `observe.mjs` (which drives `@anthropic-ai/sdk`): same
 * JSON-safe shapes, but every call goes to `createAaiTransport`. The caller
 * supplies the transport and a `statusOf` reader, so a recording `fetch` can
 * report the status the SDK exposed as `stream.response.status` — the native
 * connector keeps no response on the stream.
 */

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
 * Projects an error onto the comparable wire fields; a field the error does not
 * have is left out entirely.
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
 * @param {{transport: any, case: any, statusOf: () => number|null}} arg0
 * @returns {Promise<{kind: 'messages', mode: string, status: number|null, events: Array<any>, ended: 'clean'|'threw', error?: Record<string, any>}>}
 */
async function observeMessages({ transport, case: caseDef, statusOf }) {
    const { body, headers } = caseDef.request;
    const controller = caseDef.mode === 'abort' ? new AbortController() : null;
    const stream = transport.messages.stream(body, {
        ...(controller ? { signal: controller.signal } : {}),
        ...(headers ? { headers } : {}),
    });

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
    } catch (thrown) {
        ended = 'threw';
        error = projectError(thrown);
    }
    return {
        kind: 'messages',
        mode: caseDef.mode,
        status: statusOf(),
        events,
        ended,
        ...(error ? { error } : {}),
    };
}

/**
 * Iterates the paginated models list to its end, recording the items and how
 * many pages the explicit page walk fetched.
 * @param {{transport: any}} arg0
 * @returns {Promise<{kind: 'models', mode: 'models', models: Array<any>, pages: number}>}
 */
async function observeModels({ transport }) {
    /** @type {Array<any>} */
    const models = [];
    let pages = 0;
    let page = await transport.models.list();
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
 * Runs one case through the native transport and returns its observation.
 * @param {{case: any, transport: any, statusOf: () => number|null}} arg0
 * @returns {Promise<any>}
 */
export async function observeNative({ case: caseDef, transport, statusOf }) {
    if (caseDef.kind === 'models') {
        try {
            return await observeModels({ transport });
        } catch (error) {
            return { kind: 'error', error: projectError(error) };
        }
    }

    const observed = await observeMessages({ transport, case: caseDef, statusOf });
    if (caseDef.mode === 'error') return { kind: 'error', error: observed.error ?? null };
    return observed;
}
