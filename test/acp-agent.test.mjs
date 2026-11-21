// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { client, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable';
import { createAcpAgent, ACP_AGENT_VERSION } from '../lib/agentic/acp-agent.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

/** @returns {any} */
function fakeSession() {
    return {
        /** @param {{initialInput?: any, options?: {onEvent?: Function}}|undefined} [arg0] */
        run: async ({ initialInput, options: { onEvent } = {} } = {}) => {
            const out = `echo:${initialInput}`;
            onEvent?.({ type: 'text', content: out });
            return out;
        },
    };
}

describe('createAcpAgent', () => {
    it('requires a merci ChatSession', () => {
        assert.throws(() => createAcpAgent({}), ConfigurationError);
        assert.throws(() => createAcpAgent(/** @type {any} */ ({ session: {} })), ConfigurationError);
    });

    it('negotiates v1 and streams a prompt turn as session updates', async () => {
        const agentApp = createAcpAgent({ session: fakeSession() });
        const clientApp = client({ name: 'test-editor' });
        const updates = /** @type {any[]} */ ([]);
        clientApp.onNotification(methods.client.session.update, (ctx) => { updates.push(ctx.params); });

        await clientApp.connectWith(agentApp, async (ctx) => {
            const init = /** @type {any} */ (await ctx.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {},
            }));
            assert.equal(init.protocolVersion, PROTOCOL_VERSION);
            assert.equal(init.agentInfo.name, 'merci-sdk');
            assert.equal(init.agentInfo.version, ACP_AGENT_VERSION);

            const { sessionId } = await ctx.request(methods.agent.session.new, {
                cwd: process.cwd(),
                mcpServers: [],
            });
            assert.ok(sessionId);

            const res = await ctx.request(methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: 'text', text: 'hello' }],
            });
            assert.equal(res.stopReason, 'end_turn');
        });

        assert.equal(updates.length, 1);
        assert.equal(updates[0].sessionId.startsWith('merci-'), true);
        const chunk = updates[0].update;
        assert.equal(chunk.sessionUpdate, 'agent_message_chunk');
        assert.deepEqual(chunk.content, { type: 'text', text: 'echo:hello' });
    });

    it('B: createSession gives each ACP id its own session; concurrent prompts finish and see only their own context', async () => {
        /** @type {string[]} */
        const created = [];
        const agentApp = createAcpAgent({
            createSession: ({ sessionId }) => {
                created.push(sessionId);
                /** @type {any} */
                const own = {
                    _agentContext: null,
                    running: false,
                    /** @param {{initialInput: string, options: {onEvent?: Function}}} arg0 */
                    async run({ initialInput, options: { onEvent } }) {
                        if (own.running) throw new Error('CONCURRENT_RUN');
                        own.running = true;
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        onEvent?.({ type: 'text', content: `${initialInput}|${own._agentContext?.objective ?? 'none'}` });
                        own.running = false;
                    },
                };
                return own;
            },
        });
        const clientApp = client({ name: 'test-editor' });
        /** @type {Map<string, string>} */
        const seen = new Map();
        clientApp.onNotification(methods.client.session.update, (ctx) => {
            seen.set(ctx.params.sessionId, /** @type {any} */ (ctx.params.update).content.text);
        });

        await clientApp.connectWith(agentApp, async (ctx) => {
            await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            const a = (await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })).sessionId;
            const b = (await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })).sessionId;
            const results = await Promise.all([
                ctx.request(methods.agent.session.prompt, /** @type {any} */ ({ sessionId: a, prompt: [{ type: 'text', text: 'one' }], _meta: { merci: { objective: 'goal-a' } } })),
                ctx.request(methods.agent.session.prompt, /** @type {any} */ ({ sessionId: b, prompt: [{ type: 'text', text: 'two' }], _meta: { merci: { objective: 'goal-b' } } })),
            ]);
            assert.deepEqual(results.map((/** @type {any} */ r) => r.stopReason), ['end_turn', 'end_turn'], 'both finish');
            assert.equal(seen.get(a), 'one|goal-a');
            assert.equal(seen.get(b), 'two|goal-b');
            // A later prompt with no envelope does not inherit the previous turn's context.
            await ctx.request(methods.agent.session.prompt, { sessionId: a, prompt: [{ type: 'text', text: 'three' }] });
            assert.equal(seen.get(a), 'three|none');
            assert.deepEqual(created, [a, b], 'one session per ACP id, made once');
        });
    });

    it('B: a shared session queues concurrent prompts instead of failing, and scopes context and bridge per prompt', async () => {
        /** @type {string[]} */
        const log = [];
        /** @type {any} */
        const shared = {
            _agentContext: null,
            running: false,
            /** @param {{initialInput: string}} arg0 */
            async run({ initialInput }) {
                if (shared.running) throw new Error('CONCURRENT_RUN');
                shared.running = true;
                await new Promise((resolve) => setTimeout(resolve, 10));
                log.push(`${initialInput}:${shared._agentContext?.objective ?? 'none'}:${activeBridge}`);
                shared.running = false;
            },
        };
        /** @type {string|null} */
        let activeBridge = null;
        const agentApp = createAcpAgent({
            session: shared,
            onTurnContext: ({ sessionId }) => {
                const previous = activeBridge;
                activeBridge = sessionId;
                return () => { activeBridge = previous; };
            },
        });
        const clientApp = client({ name: 'test-editor' });
        await clientApp.connectWith(agentApp, async (ctx) => {
            await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            const a = (await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })).sessionId;
            const b = (await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })).sessionId;
            const results = await Promise.all([
                ctx.request(methods.agent.session.prompt, /** @type {any} */ ({ sessionId: a, prompt: [{ type: 'text', text: 'one' }], _meta: { merci: { objective: 'goal-a' } } })),
                ctx.request(methods.agent.session.prompt, { sessionId: b, prompt: [{ type: 'text', text: 'two' }] }),
            ]);
            assert.deepEqual(results.map((/** @type {any} */ r) => r.stopReason), ['end_turn', 'end_turn']);
            assert.deepEqual(log, [`one:goal-a:${a}`, `two:none:${b}`], 'serialized, each with its own context and bridge');
            assert.equal(shared._agentContext, null, 'the context is restored after the turn');
            assert.equal(activeBridge, null, 'the bridge cleanup ran');
        });
    });

    it('B: a cancel reaches a prompt still waiting in the queue', async () => {
        /** @type {(() => void)|null} */
        let release = null;
        let runs = 0;
        const agentApp = createAcpAgent({
            session: {
                async run() {
                    runs += 1;
                    if (runs === 1) await new Promise((resolve) => { release = () => resolve(undefined); });
                },
            },
        });
        const clientApp = client({ name: 'test-editor' });
        await clientApp.connectWith(agentApp, async (ctx) => {
            await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            const a = (await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })).sessionId;
            const b = (await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })).sessionId;
            const first = ctx.request(methods.agent.session.prompt, { sessionId: a, prompt: [{ type: 'text', text: 'one' }] });
            const second = ctx.request(methods.agent.session.prompt, { sessionId: b, prompt: [{ type: 'text', text: 'two' }] });
            await new Promise((resolve) => setTimeout(resolve, 10));
            await ctx.notify(methods.agent.session.cancel, { sessionId: b });
            await new Promise((resolve) => setTimeout(resolve, 10));
            /** @type {any} */ (release)?.();
            assert.equal((await first).stopReason, 'end_turn');
            assert.equal((await second).stopReason, 'cancelled');
            assert.equal(runs, 1, 'the cancelled prompt never ran');
        });
    });

    it('B review: a cancel stops the running turn and the one queued behind it on the same id', async () => {
        /** @type {string[]} */
        const ran = [];
        const agentApp = createAcpAgent({
            createSession: () => ({
                /** @param {any} arg0 */
                run: ({ initialInput, options: { signal } }) => new Promise((resolve, reject) => {
                    ran.push(initialInput);
                    const timer = setTimeout(resolve, 2000);
                    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
                }),
            }),
        });
        const clientApp = client({ name: 'test-editor' });
        await clientApp.connectWith(agentApp, async (ctx) => {
            await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            const a = (await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })).sessionId;
            const started = Date.now();
            const first = ctx.request(methods.agent.session.prompt, { sessionId: a, prompt: [{ type: 'text', text: 'one' }] });
            const second = ctx.request(methods.agent.session.prompt, { sessionId: a, prompt: [{ type: 'text', text: 'two' }] });
            await new Promise((resolve) => setTimeout(resolve, 20));
            await ctx.notify(methods.agent.session.cancel, { sessionId: a });
            assert.deepEqual([(await first).stopReason, (await second).stopReason], ['cancelled', 'cancelled']);
            assert.ok(Date.now() - started < 1000, 'the running turn was interrupted, not waited out');
            assert.deepEqual(ran, ['one'], 'the queued turn never ran');
        });
    });

    it('B review: a throwing onTurnContext still restores the context', async () => {
        /** @type {any} */
        const shared = { _agentContext: 'base', run: async () => {} };
        const agentApp = createAcpAgent({ session: shared, onTurnContext: () => { throw new Error('hook exploded'); } });
        const clientApp = client({ name: 'test-editor' });
        await clientApp.connectWith(agentApp, async (ctx) => {
            await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            const a = (await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })).sessionId;
            await assert.rejects(() => ctx.request(methods.agent.session.prompt, /** @type {any} */ ({ sessionId: a, prompt: [{ type: 'text', text: 'x' }], _meta: { merci: { objective: 'g' } } })));
            assert.equal(shared._agentContext, 'base');
        });
    });

    it('B review: a cancel while the factory builds the session is a cancel, and the turn never runs', async () => {
        /** @type {(() => void)|null} */
        let finishFactory = null;
        let runs = 0;
        const agentApp = createAcpAgent({
            createSession: () => new Promise((resolve) => { finishFactory = () => resolve({ run: async () => { runs += 1; } }); }),
        });
        const clientApp = client({ name: 'test-editor' });
        await clientApp.connectWith(agentApp, async (ctx) => {
            await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            const a = (await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })).sessionId;
            const prompt = ctx.request(methods.agent.session.prompt, { sessionId: a, prompt: [{ type: 'text', text: 'x' }] });
            await new Promise((resolve) => setTimeout(resolve, 10));
            await ctx.notify(methods.agent.session.cancel, { sessionId: a });
            await new Promise((resolve) => setTimeout(resolve, 10));
            /** @type {any} */ (finishFactory)?.();
            assert.equal((await prompt).stopReason, 'cancelled');
            assert.equal(runs, 0);
        });
    });

    it('B review: a fork builds its session when the fork is answered, naming its parent', async () => {
        /** @type {Array<{sessionId: string, parentSessionId: string|null}>} */
        const built = [];
        const agentApp = createAcpAgent({
            createSession: ({ sessionId, parentSessionId }) => { built.push({ sessionId, parentSessionId }); return { run: async () => {} }; },
        });
        const clientApp = client({ name: 'test-editor' });
        await clientApp.connectWith(agentApp, async (ctx) => {
            await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            const a = (await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })).sessionId;
            const forked = /** @type {any} */ (await ctx.request(methods.agent.session.fork, /** @type {any} */ ({ sessionId: a, cwd: process.cwd(), mcpServers: [] }))).sessionId;
            assert.deepEqual(built, [{ sessionId: forked, parentSessionId: a }], 'built at fork time, before any prompt');
        });
    });

    it('rejects a prompt for an unknown session', async () => {
        const agentApp = createAcpAgent({ session: fakeSession() });
        const clientApp = client({ name: 'test-editor' });
        await clientApp.connectWith(agentApp, async (ctx) => {
            await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            await assert.rejects(
                () => ctx.request(methods.agent.session.prompt, {
                    sessionId: 'nope',
                    prompt: [{ type: 'text', text: 'hi' }],
                }),
                /Unknown ACP session/
            );
        });
    });
});
