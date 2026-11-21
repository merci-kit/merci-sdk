// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import { jaiAdapter } from '../lib/backends/adapters/jai-adapter.mjs';

const SID = 'sid-abc-123';

describe('merci session headers', () => {
    describe('AAI', () => {
        it('sends x-merci-session-id when sessionId present', async () => {
            /** @type {any} */ const captured = {};
            const vc = { messages: { stream: async (/** @type {any} */ body, /** @type {any} */ opts) => { captured.body = body; captured.opts = opts; return {}; } } };
            await (/** @type {any} */ (aaiAdapter)).executeVendorRequest({ vendorClient: vc, request: { model: 'x' }, signal: undefined, session: { sessionId: SID, _sessionRunCtx: { runId: 'other' } } });
            assert.equal(captured.opts.headers['x-merci-session-id'], SID);
        });

        it('falls back to _sessionRunCtx.runId when sessionId absent', async () => {
            /** @type {any} */ const captured = {};
            const vc = { messages: { stream: async (/** @type {any} */ body, /** @type {any} */ opts) => { captured.opts = opts; return {}; } } };
            await (/** @type {any} */ (aaiAdapter)).executeVendorRequest({ vendorClient: vc, request: { model: 'x' }, signal: undefined, session: { _sessionRunCtx: { runId: 'run-123' } } });
            assert.equal(captured.opts.headers['x-merci-session-id'], 'run-123');
        });

        it('sends no headers when sid absent', async () => {
            /** @type {any} */ const captured = {};
            const vc = { messages: { stream: async (/** @type {any} */ body, /** @type {any} */ opts) => { captured.opts = opts; return {}; } } };
            await (/** @type {any} */ (aaiAdapter)).executeVendorRequest({ vendorClient: vc, request: { model: 'x' }, signal: undefined, session: {} });
            assert.equal('headers' in captured.opts, false);
        });
    });

    describe('GAI', () => {
        it('threads sid via config.httpOptions, body unchanged', async () => {
            /** @type {any} */ const captured = {};
            const vc = { models: { generateContentStream: async (/** @type {any} */ params) => { captured.params = params; return {}; } } };
            const request = {
                model: 'm',
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                config: { temperature: 0.5 }
            };
            await (/** @type {any} */ (gaiAdapter)).executeVendorRequest({ vendorClient: vc, request, signal: undefined, session: { sessionId: SID } });
            assert.equal(captured.params.config.httpOptions.headers['X-Merci-Session-Id'], SID);
            assert.deepEqual(captured.params.contents, request.contents);
            assert.equal(captured.params.config.temperature, 0.5);
            assert.equal(JSON.stringify(captured.params.contents).includes(SID), false);
        });

        it('sends no httpOptions when sid absent', async () => {
            /** @type {any} */ const captured = {};
            const vc = { models: { generateContentStream: async (/** @type {any} */ params) => { captured.params = params; return {}; } } };
            await (/** @type {any} */ (gaiAdapter)).executeVendorRequest({ vendorClient: vc, request: { model: 'm', contents: [], config: {} }, signal: undefined, session: {} });
            assert.equal(captured.params.config.httpOptions, undefined);
        });
    });

    describe('JAI', () => {
        it('forwards X-Merci-Session-Id in stream options', async () => {
            /** @type {any} */ const captured = {};
            const session = {
                /** @param {{initialInput: any, options: any}} arg0 */
                stream: async function* ({ initialInput, options }) { captured.opts = options; }
            };
            const request = { session, messages: [{ type: 'user_message', content: 'hi' }], isLastIteration: true, runContext: null };
            const gen = await (/** @type {any} */ (jaiAdapter)).executeVendorRequest({ vendorClient: null, request, signal: undefined, session: { sessionId: SID } });
            assert.equal(captured.opts.headers['X-Merci-Session-Id'], SID);
            assert.equal(captured.opts.isLastIteration, true);
        });

        it('sends no headers when sid absent', async () => {
            /** @type {any} */ const captured = {};
            const session = {
                /** @param {{initialInput: any, options: any}} arg0 */
                stream: async function* ({ initialInput, options }) { captured.opts = options; }
            };
            const request = { session, messages: [], isLastIteration: false, runContext: null };
            await (/** @type {any} */ (jaiAdapter)).executeVendorRequest({ vendorClient: null, request, signal: undefined, session: {} });
            assert.equal('headers' in captured.opts, false);
        });
    });
});
