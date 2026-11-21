// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { MerciClient } from '../lib/backends/oai.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

function stubVendorClient() {
    /** @type {any[]} */
    const captured = [];
    const vendorClient = {
        chat: { completions: { create: async (/** @type {any} */ body, /** @type {any} */ opts) => { captured.push({ path: 'completions', opts }); return {}; } } },
        responses: { create: async (/** @type {any} */ body, /** @type {any} */ opts) => { captured.push({ path: 'responses', opts }); return {}; } }
    };
    return { vendorClient, captured };
}

describe('oaiAdapter.executeVendorRequest opencode session header', () => {
    it('sends x-opencode-session on both protocol paths', async () => {
        const { vendorClient, captured } = stubVendorClient();
        const session = { provider: 'opencode', sessionId: 'sess-123', _sessionRunCtx: { runId: 'run-abc' } };
        const vendor = /** @type {any} */ (oaiAdapter);
        await vendor.executeVendorRequest({ vendorClient, request: { model: 'm', messages: [] }, signal: undefined, session });
        await vendor.executeVendorRequest({ vendorClient, request: { __merciProtocol: 'responses', model: 'm', input: [] }, signal: undefined, session });
        assert.equal(captured.length, 2);
        for (const { opts } of captured) {
            assert.equal(opts.headers['x-opencode-session'], 'sess-123');
        }
    });

    it('falls back to _sessionRunCtx.runId when sessionId is absent', async () => {
        const { vendorClient, captured } = stubVendorClient();
        const session = { provider: 'opencode', _sessionRunCtx: { runId: 'run-abc' } };
        const vendor = /** @type {any} */ (oaiAdapter);
        await vendor.executeVendorRequest({ vendorClient, request: { model: 'm', messages: [] }, signal: undefined, session });
        assert.equal(captured[0].opts.headers['x-opencode-session'], 'run-abc');
    });

    it('sends no header for a non-opencode session', async () => {
        const { vendorClient, captured } = stubVendorClient();
        const session = { provider: ProviderType.OPENAI, sessionId: 'sess-123' };
        const vendor = /** @type {any} */ (oaiAdapter);
        await vendor.executeVendorRequest({ vendorClient, request: { model: 'm', messages: [] }, signal: undefined, session });
        assert.equal(captured[0].opts.headers, undefined);
    });
});

describe('MerciClient opencode session id', () => {
    it('generates an opencodeSessionId and builds the OpenAI client', () => {
        const client = new MerciClient({ options: { provider: 'opencode', apiKey: 'x', baseURL: 'https://x' } });
        assert.equal(typeof (/** @type {any} */ (client)).opencodeSessionId, 'string');
        assert.ok((/** @type {any} */ (client)).opencodeSessionId.length > 0);
        assert.ok((/** @type {any} */ (client)).transport);
    });
});
