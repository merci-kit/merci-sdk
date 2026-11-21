// @ts-check
/**
 * @file Loopback HTTP server for one GAI wire-parity case.
 * @version 0.21.1
 *
 * @description
 * Binds `127.0.0.1:0`, records every incoming request in order, and writes the
 * case's response exactly as declared: status, headers, then each chunk with a
 * `setImmediate` turn between writes. `hang` leaves the socket open after the
 * last write (the mid-stream abort), `destroy` closes it before answering (a
 * refused socket), and `responses` gives one spec per sequential request (the
 * paginated list).
 *
 * Response headers are not part of a recorded observation: the SDK copies them
 * onto every chunk as `sdkHttpResponse`, and the observation drops that key, so
 * nothing here has to be pinned against the clock.
 *
 * `normalizeRequests` projects a recording into the comparable request shape.
 * It keeps the wire surface the connector must reproduce and drops the
 * per-process noise (`host` carries the random port, `content-length` follows
 * the body, and `accept-language`/`sec-fetch-mode`/`accept-encoding` come from
 * Undici, not from the SDK).
 */

import { createServer } from 'node:http';

/** The request headers the SDK itself sets, plus any header a case declares. */
export const BASE_REQUEST_HEADERS = ['accept', 'content-type', 'user-agent', 'x-goog-api-client', 'x-goog-api-key'];

/** @returns {Promise<void>} */
const nextTurn = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * Reads a request body to its end.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
    return new Promise((resolve) => {
        let text = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { text += chunk; });
        req.on('end', () => resolve(text));
    });
}

/**
 * Splits one chunk into the byte slices the case asks for.
 * @param {{text: string, splits?: Array<number>}} arg0
 * @returns {Array<Buffer>}
 */
function slicesOf({ text, splits = [] }) {
    const bytes = Buffer.from(text, 'utf8');
    if (splits.length === 0) return bytes.length === 0 ? [] : [bytes];
    /** @type {Array<Buffer>} */
    const parts = [];
    let offset = 0;
    for (const at of splits) {
        if (at > offset) parts.push(bytes.subarray(offset, at));
        offset = at;
    }
    if (offset < bytes.length) parts.push(bytes.subarray(offset));
    return parts;
}

/**
 * Writes one response spec.
 * @param {{res: import('node:http').ServerResponse, spec: any}} arg0
 * @returns {Promise<void>}
 */
async function writeResponse({ res, spec }) {
    res.on('error', () => { /* the client may abort mid-write */ });
    res.writeHead(spec.status, spec.headers ?? {});
    res.flushHeaders();
    const chunks = spec.chunks ?? [];
    for (let index = 0; index < chunks.length; index += 1) {
        for (const part of slicesOf({ text: chunks[index], splits: spec.byteSplits?.[index] })) {
            try {
                res.write(part);
            } catch {
                return;
            }
            await nextTurn();
        }
    }
    if (spec.hang) return;
    res.end();
}

/**
 * Keeps only the comparable request headers, in allowlist order.
 * @param {{headers?: Record<string, any>, extra?: Array<string>}} arg0
 * @returns {Record<string, string>}
 */
export function pickRequestHeaders({ headers = {}, extra = [] } = {}) {
    /** @type {Record<string, string>} */
    const picked = {};
    for (const name of [...BASE_REQUEST_HEADERS, ...extra]) {
        if (headers[name] !== undefined) picked[name] = String(headers[name]);
    }
    return picked;
}

/**
 * Projects recorded requests into the comparable shape.
 * @param {{requests: Array<{method: string, url: string, headers: Record<string, any>, body: string}>, extra?: Array<string>}} arg0
 * @returns {Array<{method: string, url: string, headers: Record<string, string>, body: string}>}
 */
export function normalizeRequests({ requests, extra = [] } = { requests: [] }) {
    return requests.map((request) => ({
        method: request.method,
        url: request.url,
        headers: pickRequestHeaders({ headers: request.headers, extra }),
        body: request.body,
    }));
}

/**
 * Starts the one-case server.
 * @param {{case: any}} arg0
 * @returns {Promise<{port: number, baseURL: string, requests: Array<{method: string, url: string, headers: Record<string, any>, body: string}>, close: () => Promise<void>}>}
 */
export async function startServer({ case: caseDef }) {
    /** @type {Array<{method: string, url: string, headers: Record<string, any>, body: string}>} */
    const requests = [];
    const specs = caseDef.responses ?? [caseDef.response];

    const server = createServer((req, res) => {
        const spec = specs[Math.min(requests.length, specs.length - 1)];
        /** @type {{method: string, url: string, headers: Record<string, any>, body: string}} */
        const record = { method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers }, body: '' };
        requests.push(record);
        /** @returns {Promise<void>} */
        const handle = async () => {
            if (spec?.destroy) {
                req.socket.destroy();
                return;
            }
            record.body = await readBody(req);
            await writeResponse({ res, spec });
        };
        handle().catch(() => {
            try { res.destroy(); } catch { /* already gone */ }
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { resolve(undefined); });
    });
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    return {
        port: address.port,
        baseURL: `http://127.0.0.1:${address.port}`,
        requests,
        /**
         * Closes the listener and every socket it owns, including a hanging one.
         * @returns {Promise<void>}
         */
        close: async () => {
            server.closeAllConnections();
            await new Promise((resolve) => { server.close(() => { resolve(undefined); }); });
        },
    };
}
