// @ts-check
/**
 * @file One parity observation for one case.
 * @version 0.21.0
 *
 * @description
 * Runs a case against a supplied transport and returns a JSON-safe observation:
 * `{ kind: 'chunks', chunks, events?, ended? }` for stream cases (raw transport
 * chunks, plus the unified events the real adapter consumes), `{ kind: 'events',
 * events }` for a non-streaming response driven through the adapter,
 * `{ kind: 'value', value, requestId? }` for a non-streaming transport value or
 * the MerciClient result, and `{ kind: 'error', error }` for a thrown failure.
 *
 * `MerciClient.embed()` / `.getProfiles()` are the real methods, invoked on an
 * object built from the class prototype and given the supplied transport, so
 * the client path never constructs or calls the OpenAI SDK. The
 * `transport-embeddings` / `transport-models` kinds call the raw transport.
 */

import { MerciClient } from '../../lib/backends/oai.mjs';
import { oaiAdapter } from '../../lib/backends/adapters/oai-adapter.mjs';
import { ExponentialBackoffPolicy } from '../../lib/support/retry-policy.mjs';
import { ProviderType } from '../../lib/core/constants/index.mjs';

/**
 * Marks a top-level `undefined` so a fixture can round-trip it (JSON drops it).
 * @param {any} value
 * @returns {any}
 */
function encodeValue(value) {
    return value === undefined ? { $undefined: true } : value;
}

/**
 * Reduces an error to the comparable wire fields. `requestID` and
 * `retryAfterMs` are recorded only when the error carries them, so the older
 * fixtures stay byte-identical.
 * @param {any} error
 * @returns {{kind: 'error', error: Record<string, any>}}
 */
function errorOutcome(error) {
    const e = error && typeof error === 'object' ? error : {};
    /** @param {string} name */
    const header = (name) => (typeof e.headers?.get === 'function' ? e.headers.get(name) : null);
    /** @type {string|null} */
    const retryAfter = e.retryAfter ?? header('retry-after') ?? null;
    const retryAfterMs = header('retry-after-ms');
    return {
        kind: 'error',
        error: {
            message: String(e.message ?? error),
            status: typeof e.status === 'number' ? e.status : null,
            code: e.code ?? null,
            type: e.type ?? null,
            param: e.param ?? null,
            retryAfter,
            ...(e.requestID != null ? { requestID: e.requestID } : {}),
            ...(retryAfterMs != null ? { retryAfterMs } : {}),
            causeName: e.cause?.name ?? null,
        },
    };
}

/**
 * Wraps a non-streaming value, adding the case-declared `_request_id`
 * assertions: its value and whether the parsed object exposes it enumerably.
 * @param {{case: any, value: any}} arg0
 * @returns {any}
 */
function valueOutcome({ case: caseDef, value }) {
    const target = value && typeof value === 'object' ? value : {};
    return {
        kind: 'value',
        value: encodeValue(value),
        ...(caseDef.compare?.requestId
            ? { requestId: { value: target._request_id ?? null, enumerable: Object.prototype.propertyIsEnumerable.call(target, '_request_id') } }
            : {}),
    };
}

/**
 * Builds a MerciClient-shaped receiver over the supplied transport without
 * running the constructor (which would build an OpenAI SDK client).
 * @param {{transport: any, case: any}} arg0
 * @returns {any}
 */
function clientOverTransport({ transport, case: caseDef }) {
    const client = Object.create(MerciClient.prototype);
    client.provider = ProviderType.OPENAI;
    client.transport = transport;
    client.embedRetryPolicy = new ExponentialBackoffPolicy({ maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, jitterMs: 0 });
    return client;
}

/**
 * Runs the client-level call surfaces.
 * @param {{case: any, transport: any}} arg0
 * @returns {Promise<any>}
 */
async function observeClient({ case: caseDef, transport }) {
    const client = clientOverTransport({ transport, case: caseDef });
    const action = caseDef.client?.action ?? (caseDef.kind === 'models' ? 'getProfiles' : 'embed');
    if (action === 'getProfiles') {
        return { kind: 'value', value: encodeValue(await client.getProfiles()) };
    }
    const { model, input } = caseDef.request?.body ?? {};
    return { kind: 'value', value: encodeValue(await client.embed({ model, input })) };
}

/**
 * Collects one stream, honouring the case's abort/break variant.
 * @param {{case: any, transport: any}} arg0
 * @returns {Promise<any>}
 */
async function observeStream({ case: caseDef, transport }) {
    const controller = caseDef.variant ? new AbortController() : null;
    const body = caseDef.request.body;
    /** @type {Record<string, any>} */
    const callOptions = { ...(caseDef.request.headers ? { headers: caseDef.request.headers } : {}) };
    if (controller) callOptions.signal = controller.signal;
    const iterator = caseDef.kind === 'responses'
        ? await transport.responses.create(body, callOptions)
        : await transport.chat.completions.create(body, callOptions);

    if (caseDef.variant === 'abort-before-chunk') {
        // The headers are in, the body has not produced a chunk: the abort must
        // end the stream cleanly rather than raise.
        controller?.abort();
        /** @type {Array<any>} */
        const empty = [];
        for await (const chunk of iterator) empty.push(chunk);
        return { kind: 'chunks', chunks: empty, ended: 'abort' };
    }

    /** @type {Array<any>} */
    const chunks = [];
    /** @type {'abort'|'break'|undefined} */
    let ended;
    try {
        for await (const chunk of iterator) {
            chunks.push(chunk);
            if (caseDef.variant === 'abort') {
                ended = 'abort';
                controller?.abort();
            } else if (caseDef.variant === 'break') {
                ended = 'break';
                break;
            }
        }
    } catch (error) {
        if (!ended) throw error;
    }
    if (ended) return { kind: 'chunks', chunks, ended };

    const adapterRequest = caseDef.kind === 'responses'
        ? { ...body, __merciProtocol: 'responses' }
        : body;
    const session = {
        provider: ProviderType.OPENAI,
        protocol: caseDef.kind === 'responses' ? 'responses' : 'completions',
        eventEmitter: null,
        _retryPolicy: null,
    };
    const rawStream = await oaiAdapter.executeVendorRequest({ vendorClient: transport, request: adapterRequest, signal: undefined, session });
    /** @type {Array<any>} */
    const events = [];
    for await (const event of oaiAdapter.consumeStream({ rawStream, signal: undefined })) {
        events.push(event?.type === 'first_token' ? { ...event, latencyMs: 0 } : event);
    }
    return { kind: 'chunks', chunks, events };
}

/**
 * Runs a raw transport call, with no MerciClient layer. Models are compared on
 * `.data` only, the surface `MerciClient.getProfiles()` reads.
 * @param {{case: any, transport: any}} arg0
 * @returns {Promise<any>}
 */
async function observeTransportCall({ case: caseDef, transport }) {
    const opts = caseDef.request?.headers ? { headers: caseDef.request.headers } : undefined;
    if (caseDef.kind === 'transport-models') {
        const listed = await transport.models.list(opts);
        return valueOutcome({ case: caseDef, value: { data: listed?.data ?? [] } });
    }
    return valueOutcome({ case: caseDef, value: await transport.embeddings.create(caseDef.request.body, opts) });
}

/**
 * Runs a non-streaming Responses call through the adapter itself, so the
 * `executeVendorRequest` / `consumeFullResponse` path is what gets compared.
 * @param {{case: any, transport: any}} arg0
 * @returns {Promise<any>}
 */
async function observeAdapterJson({ case: caseDef, transport }) {
    const body = caseDef.request.body;
    const request = caseDef.kind === 'responses' ? { ...body, __merciProtocol: 'responses' } : body;
    const session = {
        provider: ProviderType.OPENAI,
        protocol: caseDef.kind === 'responses' ? 'responses' : 'completions',
        eventEmitter: null,
        _retryPolicy: null,
    };
    const rawStream = await oaiAdapter.executeVendorRequest({ vendorClient: transport, request, signal: undefined, session });
    /** @type {Array<any>} */
    const events = [];
    for await (const event of oaiAdapter.consumeStream({ rawStream, signal: undefined })) {
        events.push(event?.type === 'first_token' ? { ...event, latencyMs: 0 } : event);
    }
    return { kind: 'events', events };
}

/**
 * Runs one case and returns its observation.
 * @param {{case: any, transport: any, baseURL?: string}} arg0
 * @returns {Promise<any>}
 */
export async function observe({ case: caseDef, transport, baseURL }) {
    try {
        if (caseDef.kind === 'transport-embeddings' || caseDef.kind === 'transport-models') {
            return await observeTransportCall({ case: caseDef, transport });
        }
        if (caseDef.kind === 'embeddings' || caseDef.kind === 'models' || caseDef.kind === 'client') {
            return await observeClient({ case: caseDef, transport });
        }
        if (caseDef.mode === 'adapter-json') {
            return await observeAdapterJson({ case: caseDef, transport });
        }
        if (caseDef.mode === 'stream') {
            return await observeStream({ case: caseDef, transport });
        }
        const body = caseDef.request.body;
        const callOptions = caseDef.request.headers ? { headers: caseDef.request.headers } : undefined;
        const value = caseDef.kind === 'responses'
            ? await transport.responses.create(body, callOptions)
            : await transport.chat.completions.create(body, callOptions);
        return valueOutcome({ case: caseDef, value });
    } catch (error) {
        return errorOutcome(error);
    }
}
