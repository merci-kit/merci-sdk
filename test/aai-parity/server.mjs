// @ts-check
/**
 * @file Loopback HTTP server for one AAI wire-parity case.
 * @version 0.21.1
 *
 * @description
 * Binds `127.0.0.1:0`, records every incoming request in order, and writes the
 * case's response exactly as declared: status, headers, then each chunk with a
 * `setImmediate` turn between writes. `hang` leaves the socket open after the
 * last write (a mid-stream abort), `destroy` closes it before answering (a
 * refused socket), and `responses` gives one spec per sequential request.
 *
 * Headers are recorded from `req.rawHeaders`, so the fixture keeps the names in
 * the order and casing they had on the wire. `host` is dropped: it carries the
 * ephemeral loopback port, which would make the recording non-deterministic.
 */

import { createServer } from 'node:http';

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
 * The wire headers, minus the loopback `host`.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Record<string, string>}
 */
function wireHeaders(req) {
    /** @type {Record<string, string>} */
    const headers = {};
    const raw = req.rawHeaders;
    for (let index = 0; index < raw.length; index += 2) {
        const name = raw[index];
        if (name.toLowerCase() === 'host') continue;
        headers[name] = raw[index + 1];
    }
    return headers;
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
 * @param {{req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, spec: any}} arg0
 * @returns {Promise<void>}
 */
async function writeResponse({ req, res, spec }) {
    if (spec.destroy) {
        req.socket.destroy();
        return;
    }
    res.on('error', () => { /* the client may abort mid-write */ });
    res.writeHead(spec.status, spec.headers ?? {});
    res.flushHeaders();
    if (spec.status === 204) {
        res.end();
        return;
    }
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
 * Starts the one-case server.
 * @param {{case: any}} arg0
 * @returns {Promise<{port: number, baseURL: string, requests: Array<{method: string, url: string, headers: Record<string, string>, body: string}>, close: () => Promise<void>}>}
 */
export async function startServer({ case: caseDef }) {
    /** @type {Array<{method: string, url: string, headers: Record<string, string>, body: string}>} */
    const requests = [];
    const specs = caseDef.responses ?? [caseDef.response];

    const server = createServer((req, res) => {
        const spec = specs[Math.min(requests.length, specs.length - 1)];
        /** @type {{method: string, url: string, headers: Record<string, string>, body: string}} */
        const record = { method: req.method ?? '', url: req.url ?? '', headers: wireHeaders(req), body: '' };
        requests.push(record);
        /** @returns {Promise<void>} */
        const handle = async () => {
            if (spec?.destroy) {
                req.socket.destroy();
                return;
            }
            record.body = await readBody(req);
            await writeResponse({ req, res, spec });
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
