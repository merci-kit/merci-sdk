// @ts-check
/**
 * ACP 1.9.0 defines `session/close` and the `sessionCapabilities` object. The
 * agent answered `session/delete` by dropping the record without cancelling a
 * running turn, advertised no lifecycle capability, and had no close handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable';

import { createAcpAgent } from '../lib/agentic/acp-agent.mjs';

/**
 * A session whose run waits until its signal fires.
 * @param {{aborted: boolean}} seen
 */
const hangingSession = (seen) => /** @type {any} */ ({
    /** @param {{options: {signal: AbortSignal}}} arg0 */
    run: async ({ options }) => {
        await new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => { seen.aborted = true; reject(new Error('cancelled')); }, { once: true });
            setTimeout(resolve, 5000);
        });
        return 'done';
    },
});

test('initialize advertises the four session lifecycle capabilities as objects', async () => {
    const agentApp = createAcpAgent({ session: hangingSession({ aborted: false }) });
    const clientApp = client({ name: 'test-editor' });
    await clientApp.connectWith(agentApp, async (ctx) => {
        const init = /** @type {any} */ (await ctx.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
        }));
        const caps = init.agentCapabilities.sessionCapabilities;
        assert.deepEqual(caps, { list: {}, delete: {}, close: {}, fork: {} });
    });
});

test('session/delete drops the session from the list', async () => {
    const agentApp = createAcpAgent({ session: hangingSession({ aborted: false }) });
    const clientApp = client({ name: 'test-editor' });
    await clientApp.connectWith(agentApp, async (ctx) => {
        await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
        const before = /** @type {any} */ (await ctx.request(methods.agent.session.list, {}));
        assert.equal(before.sessions.length, 1);
        await ctx.request(methods.agent.session.delete, { sessionId });
        const after = /** @type {any} */ (await ctx.request(methods.agent.session.list, {}));
        assert.equal(after.sessions.length, 0);
    });
});

test('session/close aborts the in-flight turn and frees the session', async () => {
    /** @type {{aborted: boolean}} */
    const seen = { aborted: false };
    const agentApp = createAcpAgent({ session: hangingSession(seen) });
    const clientApp = client({ name: 'test-editor' });
    await clientApp.connectWith(agentApp, async (ctx) => {
        await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
        const prompt = ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'go' }] });
        await new Promise((resolve) => setTimeout(resolve, 10));
        await ctx.request(methods.agent.session.close, { sessionId });
        assert.equal(seen.aborted, true, 'close cancels the running turn');
        const after = /** @type {any} */ (await ctx.request(methods.agent.session.list, {}));
        assert.equal(after.sessions.length, 0, 'the session record is gone');
        await prompt.catch(() => {});
    });
});
