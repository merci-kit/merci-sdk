// @ts-check
/**
 * An OTLP POST had no timeout: a collector that accepts the connection and
 * never answers kept the flush promise (and a `close()`) pending forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOtlpExporter } from '../lib/support/otel-exporter.mjs';

test('the OTLP POST carries a 10 s abort signal', async () => {
    /** @type {any} */
    let init = null;
    /** @type {number|null} */
    let timeoutMs = null;
    const original = AbortSignal.timeout;
    // Pinned so the test proves the DELAY, not just that a signal exists.
    /** @type {any} */ (AbortSignal).timeout = (/** @type {number} */ ms) => { timeoutMs = ms; return original.call(AbortSignal, ms); };
    try {
        const exporter = createOtlpExporter({
            endpoint: 'http://otel.test/v1/traces',
            flushIntervalMs: 0,
            batchSize: 1000,
            fetchImpl: /** @type {any} */ (async (/** @type {any} */ _url, /** @type {any} */ options) => { init = options; return { ok: true, status: 200 }; }),
        });
        exporter.onEvent({ name: 'run:start', payload: { runId: 'r1', event: 'run:start' } });
        exporter.onEvent({ name: 'run:end', payload: { runId: 'r1', event: 'run:end' } });
        await exporter.flush();
        await exporter.close();
    } finally {
        AbortSignal.timeout = original;
    }

    assert.ok(init, 'the exporter POSTed');
    assert.ok(init.signal instanceof AbortSignal, 'the request has an abort signal');
    assert.equal(init.signal.aborted, false, 'a live request is not aborted');
    assert.equal(timeoutMs, 10_000, 'the timeout is 10 s');
});
