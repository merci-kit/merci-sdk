// @ts-check
/**
 * @file body — the bounded response-body reader the transports share.
 * @version 0.12.0
 *
 * @description
 * One reader for an error body: it stops at the cap, cancels the rest so a huge
 * or endless body cannot be buffered, and falls back to `response.text()` for a
 * body without a stream (a mock). The transports had two copies that differed
 * in one byte at the boundary (see `>=` below); the cap itself is the caller's,
 * read per request so `setLimits()` still takes effect.
 *
 * Two entry points share that reader: `readBodyTextCapped` keeps the historical
 * string shape, and `readBodyTextCappedResult` also reports whether the body
 * was really cut — it spends one extra read when a chunk lands exactly on the
 * cap, so a complete body that fills the cap is not mistaken for a truncated
 * one.
 */

/**
 * Reads a response body as text up to `maxBytes`.
 *
 * The legacy boundary is `>=`: a chunk that would reach or pass the cap is cut
 * to the remaining bytes and the stream is cancelled, so the result is exactly
 * `maxBytes` long at most. (The JAI copy tested `>`, which kept the whole chunk
 * that landed one byte short of the cap — one chunk past the limit.) With
 * `probe`, a chunk that lands exactly ON the cap is kept whole and one more
 * read decides whether the body was complete; that read is what tells a cut
 * body from a full one.
 *
 * @param {{response: Response, maxBytes: number, probe: boolean}} arg0 -
 *   `maxBytes` is read by the caller per request so a runtime limit change
 *   takes effect.
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
async function readBodyCapped({ response, maxBytes, probe }) {
    const body = /** @type {ReadableStream<Uint8Array>|null} */ (response.body);
    // No stream to bound (a mock): the text is what the mock returns, and
    // nothing was cancelled, so it is never called truncated.
    if (!body || typeof body.getReader !== 'function') return { text: await response.text(), truncated: false };
    const reader = body.getReader();
    /** @type {Array<Uint8Array>} */
    const chunks = [];
    let total = 0;
    let truncated = false;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = /** @type {Uint8Array} */ (value);
            const reachesCap = total + chunk.length >= maxBytes;
            if (probe ? total + chunk.length > maxBytes : reachesCap) {
                chunks.push(chunk.subarray(0, maxBytes - total));
                total = maxBytes;
                truncated = true;
                await reader.cancel().catch(() => { /* the body is already gone */ });
                break;
            }
            chunks.push(chunk);
            total += chunk.length;
            if (probe && total === maxBytes) {
                // Exactly full: only the next read (or its end) says whether
                // anything was left, and one probe read is cheaper than calling
                // a complete body truncated.
                for (;;) {
                    const next = await reader.read();
                    if (next.done) break;
                    if (next.value && next.value.length > 0) { truncated = true; break; }
                }
                if (truncated) await reader.cancel().catch(() => { /* the body is already gone */ });
                break;
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* a pending read still owns the lock */ }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    return { text: new TextDecoder().decode(merged), truncated };
}

/**
 * Reads a response body as text up to `maxBytes`, cancelling the rest.
 * @param {{response: Response, maxBytes: number}} arg0 - `maxBytes` is read by
 *   the caller per request so a runtime limit change takes effect.
 * @returns {Promise<string>}
 */
export async function readBodyTextCapped({ response, maxBytes }) {
    return (await readBodyCapped({ response, maxBytes, probe: false })).text;
}

/**
 * The same read, reporting whether the body was actually cut. `truncated` is
 * true only when bytes remained beyond `maxBytes`: a body that ends exactly at
 * the cap is complete.
 * @param {{response: Response, maxBytes: number}} arg0 -
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
export async function readBodyTextCappedResult({ response, maxBytes }) {
    return readBodyCapped({ response, maxBytes, probe: true });
}
