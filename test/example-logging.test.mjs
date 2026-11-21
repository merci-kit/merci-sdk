// @ts-check
/**
 * Phase C proof: the shared example logging CLI parser. The wiring itself
 * (wireClient/wireAllEvents/defaultDisplay) delegates to `attachEventLogger` /
 * `createStreamLogger`, already covered by test/event-logger.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { parseLogArgs, wireClient } from '../examples/_shared/example-utils.mjs';
import { log } from '../lib/support/logger.mjs';

const NONE = { level: null, format: null, colors: null, extended: false };

function capture() {
    /** @type {{ log: any[], error: any[], write: any[] }} */
    const lines = { log: [], error: [], write: [] };
    const sink = {
        log: (/** @type {string} */ t) => { lines.log.push(t); },
        error: (/** @type {string} */ t) => { lines.error.push(t); },
        write: (/** @type {string} */ t) => { lines.write.push(t); return true; },
    };
    return { sink, lines };
}

test('parseLogArgs: no flags → no overrides, not extended', () => {
    assert.deepEqual(parseLogArgs({ argv: [] }), NONE);
});

test('parseLogArgs: verbosity flags map to levels and extended', () => {
    assert.deepEqual(parseLogArgs({ argv: ['-v'] }), { level: 'debug', format: null, colors: null, extended: true });
    assert.deepEqual(parseLogArgs({ argv: ['--verbose'] }), { level: 'debug', format: null, colors: null, extended: true });
    assert.deepEqual(parseLogArgs({ argv: ['--debug'] }), { level: 'debug', format: null, colors: null, extended: true });
    assert.deepEqual(parseLogArgs({ argv: ['--trace'] }), { level: 'trace', format: null, colors: null, extended: true });
    assert.deepEqual(parseLogArgs({ argv: ['-q'] }), { level: 'warn', format: null, colors: null, extended: false });
    assert.deepEqual(parseLogArgs({ argv: ['--quiet'] }), { level: 'warn', format: null, colors: null, extended: false });
    assert.deepEqual(parseLogArgs({ argv: ['--silent'] }), { level: 'silent', format: null, colors: null, extended: false });
});

test('parseLogArgs: format, color, and explicit overrides; last flag wins', () => {
    assert.deepEqual(parseLogArgs({ argv: ['--json', '--no-color'] }), { level: null, format: 'json', colors: false, extended: false });
    assert.deepEqual(parseLogArgs({ argv: ['--log-level=error'] }), { level: 'error', format: null, colors: null, extended: false });
    assert.deepEqual(parseLogArgs({ argv: ['--log-format=json'] }), { level: null, format: 'json', colors: null, extended: false });
    assert.deepEqual(parseLogArgs({ argv: ['-v', '-q'] }), { level: 'warn', format: null, colors: null, extended: false });
});

test('parseLogArgs: unknown flags and positionals are ignored', () => {
    assert.deepEqual(parseLogArgs({ argv: ['--offline', 'somefile.txt', '-x'] }), NONE);
});

test('wireClient: catch-all logs canonical events but not the api_* rendered as wire briefs', () => {
    const { sink, lines } = capture();
    const originalSink = /** @type {any} */ (log)._sink;
    log.configure({ colors: false, sink, level: 'info' });
    try {
        const emitter = new EventEmitter();
        wireClient({ client: /** @type {any} */ (emitter) });
        emitter.emit('run:start', { event: 'run:start', provider: 'openai' });
        emitter.emit('api_request', { model: 'm', messages: [{ role: 'user', content: 'hi' }], params: { temperature: 0 } });
        assert.ok(lines.log.some(x => x.includes('run:start') && x.includes('openai')), 'catch-all logs run:start');
        assert.ok(lines.log.some(x => x.includes('→') && x.includes('m')), 'api_request is rendered by log.wire');
        assert.equal(lines.log.filter(x => x.includes('•') && x.includes('api_request')).length, 0,
            'the catch-all must not duplicate the api_request brief');
    } finally {
        log.configure({ colors: false, sink: originalSink });
    }
});
