// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable';
import { createAcpAgent, ACP_AGENT_VERSION, ACP_STOP_REASONS, permissionAllowed } from '../lib/agentic/acp-agent.mjs';

/**
 * A Merci session that emits a scripted stream of events.
 * @param {Array<any>} events
 * @returns {any}
 */
function scriptedSession(events) {
    return {
        /**
         * @param {{initialInput?: any, options?: {onEvent?: Function, signal?: any}}} arg0
         * @returns {Promise<string>}
         */
        run: async ({ initialInput, options: { onEvent } = {} } = {}) => {
            for (const event of events) onEvent?.(event);
            return `echo:${initialInput}`;
        }
    };
}

/**
 * Runs a body against a connected ACP client/agent pair.
 * @param {{ agent: any, fn: (ctx: any) => Promise<void> }} arg0
 * @returns {Promise<void>}
 */
async function withConnection({ agent, fn }) {
    const clientApp = client({ name: 'test-editor' });
    await clientApp.connectWith(agent, async (ctx) => { await fn(ctx); });
}

test('ACP conformance: the agent implements the full session lifecycle', async () => {
    const agent = createAcpAgent({ session: scriptedSession([]) });
    await withConnection({
        agent,
        fn: async (ctx) => {
            const init = await ctx.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {}
            });
            assert.equal(init.protocolVersion, PROTOCOL_VERSION);
            assert.equal(init.agentInfo.version, ACP_AGENT_VERSION);

            await ctx.request(methods.agent.authenticate, { methodId: 'token' });

            const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
            assert.ok(sessionId.startsWith('merci-'));

            const loaded = await ctx.request(methods.agent.session.load, { sessionId, cwd: process.cwd(), mcpServers: [] });
            assert.equal(typeof loaded, 'object');

            const listed = await ctx.request(methods.agent.session.list, {});
            assert.equal(listed.sessions.length, 1);
            assert.equal(listed.sessions[0].sessionId, sessionId);
            assert.equal(typeof listed.sessions[0].cwd, 'string');

            const forked = await ctx.request(methods.agent.session.fork, { sessionId, cwd: process.cwd() });
            assert.ok(forked.sessionId);
            assert.notEqual(forked.sessionId, sessionId);

            const afterFork = await ctx.request(methods.agent.session.list, {});
            assert.equal(afterFork.sessions.length, 2);

            await ctx.request(methods.agent.session.delete, { sessionId: forked.sessionId });
            const afterDelete = await ctx.request(methods.agent.session.list, {});
            assert.equal(afterDelete.sessions.length, 1);

            // Every session must get its own id.
            const second = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
            assert.notEqual(second.sessionId, sessionId, 'every session must get its own id');
        }
    });
});

test('ACP conformance: loading an unknown session is rejected', async () => {
    const agent = createAcpAgent({ session: scriptedSession([]) });
    await withConnection({
        agent,
        fn: async (ctx) => {
            // The v2 client refuses any request before initialize.
            await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            await assert.rejects(
                () => ctx.request(methods.agent.session.load, { sessionId: 'nope', cwd: process.cwd(), mcpServers: [] }),
                /Unknown ACP session/
            );
        }
    });
});

test('ACP conformance: text, thought, tool and plan events become session updates', async () => {
    const agent = createAcpAgent({
        session: scriptedSession([
            { type: 'thought', content: 'thinking about it' },
            { type: 'text', content: 'hello there' },
            { type: 'tool_call', tool_call_id: 'call-1', name: 'search', args: { q: 'x' } },
            { type: 'tool_call_end', tool_call_id: 'call-1', content: 'result' },
            { type: 'plan', entries: [{ content: 'step one', priority: 'high', status: 'pending' }] }
        ])
    });
    /** @type {any[]} */
    const updates = [];
    const clientApp = client({ name: 'test-editor' });
    clientApp.onNotification(methods.client.session.update, (ctx) => { updates.push(ctx.params.update); });

    await clientApp.connectWith(agent, async (ctx) => {
        await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
        const res = await ctx.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'hi' }]
        });
        assert.equal(res.stopReason, ACP_STOP_REASONS.END_TURN);
    });

    const kinds = updates.map((u) => u.sessionUpdate);
    assert.deepEqual(kinds, ['agent_thought_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'plan']);
    assert.equal(updates[2].toolCallId, 'call-1');
    assert.equal(updates[2].title, 'search');
    assert.equal(updates[2].status, 'pending');
    assert.equal(updates[3].status, 'completed');
    assert.equal(updates[4].entries[0].content, 'step one');
});

test('ACP conformance: the elicitation is a spec-clean form request', async () => {
    // ACP v1.9: `elicitation/create` is a form-mode request tied to a scope.
    // Without `mode` and the session scope a strict client rejects the params
    // (-32602) and the editor never sees the question.
    /** @type {any} */
    let bridge = null;
    const agent = createAcpAgent({
        session: scriptedSession([{ type: 'text', content: 'hi' }]),
        onTurnContext: (opts) => { bridge = opts; }
    });
    /** @type {any[]} */
    const elicitations = [];
    const clientApp = client({ name: 'test-editor' });
    // The STRICT params parser — the request must satisfy the ACP schema.
    clientApp.onRequest(methods.client.elicitation.create, ({ params }) => {
        elicitations.push(params);
        return { action: 'accept', content: { branch: 'main' } };
    });

    await clientApp.connectWith(agent, async (ctx) => {
        await ctx.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { elicitation: { form: {} } }
        });
        const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
        await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
        const answer = await bridge.elicit({
            message: 'which branch?',
            schema: { type: 'object', properties: { branch: { type: 'string' } } }
        });
        assert.equal(answer.action, 'accept');
        assert.deepEqual(answer.content, { branch: 'main' });
    });

    assert.equal(elicitations.length, 1, 'the strict schema must accept the elicitation');
    assert.equal(elicitations[0].mode, 'form');
    assert.equal(typeof elicitations[0].sessionId, 'string');
    assert.equal(elicitations[0].message, 'which branch?');
    assert.deepEqual(elicitations[0].requestedSchema, { type: 'object', properties: { branch: { type: 'string' } } });
});

test('ACP conformance: an elicitation is refused when the client never announced it', async () => {
    /** @type {any} */
    let bridge = null;
    const agent = createAcpAgent({
        session: scriptedSession([{ type: 'text', content: 'hi' }]),
        onTurnContext: (opts) => { bridge = opts; }
    });
    const clientApp = client({ name: 'test-editor' });
    await clientApp.connectWith(agent, async (ctx) => {
        // No `elicitation` capability: the bridge must not call it.
        await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
        await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
        await assert.rejects(
            () => bridge.elicit({ message: 'which branch?', schema: { type: 'object', properties: {} } }),
            /does not offer elicitation\/form/
        );
    });
});

test('ACP conformance: the terminal bridge exposes all five terminal/* methods', async () => {
    /** @type {any} */
    let bridge = null;
    const agent = createAcpAgent({
        session: scriptedSession([{ type: 'text', content: 'hi' }]),
        onTurnContext: (opts) => { bridge = opts; }
    });
    const clientApp = client({ name: 'test-editor' });
    /** @type {any[]} */
    const calls = [];
    clientApp.onRequest(methods.client.terminal.create, (ctx) => {
        calls.push(['create', ctx.params]);
        return { terminalId: 'term-1' };
    });
    clientApp.onRequest(methods.client.terminal.output, (ctx) => {
        calls.push(['output', ctx.params]);
        return { output: 'hello\n', truncated: false };
    });
    clientApp.onRequest(methods.client.terminal.waitForExit, (ctx) => {
        calls.push(['wait', ctx.params]);
        return { exitCode: 0, signal: null };
    });
    clientApp.onRequest(methods.client.terminal.kill, (ctx) => { calls.push(['kill', ctx.params]); return {}; });
    clientApp.onRequest(methods.client.terminal.release, (ctx) => { calls.push(['release', ctx.params]); return {}; });

    await clientApp.connectWith(agent, async (ctx) => {
        await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { terminal: true } });
        const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
        await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'hi' }] });

        assert.ok(bridge.createTerminal, 'the bridge must expose createTerminal');
        const created = await bridge.createTerminal({ command: 'echo', args: ['hello'], cwd: '/tmp', outputByteLimit: 4096 });
        assert.equal(created.terminalId, 'term-1');
        assert.deepEqual(await bridge.terminalOutput({ terminalId: 'term-1' }), { output: 'hello\n', truncated: false });
        assert.equal((await bridge.waitForTerminalExit({ terminalId: 'term-1' })).exitCode, 0);
        await bridge.killTerminal({ terminalId: 'term-1' });
        await bridge.releaseTerminal({ terminalId: 'term-1' });
    });

    assert.deepEqual(calls.map(([kind]) => kind), ['create', 'output', 'wait', 'kill', 'release'], 'all five methods reached the client');
    assert.equal(calls[0][1].sessionId.startsWith('merci-'), true, 'the request is scoped to the session');
    assert.deepEqual(calls[0][1].args, ['hello']);
    assert.equal(calls[0][1].cwd, '/tmp');
    assert.equal(calls[0][1].outputByteLimit, 4096);
    assert.equal(calls[1][1].terminalId, 'term-1');
});

test('ACP conformance: terminal/* is refused when the client never announced it', async () => {
    /** @type {any} */
    let bridge = null;
    const agent = createAcpAgent({
        session: scriptedSession([{ type: 'text', content: 'hi' }]),
        onTurnContext: (opts) => { bridge = opts; }
    });
    const clientApp = client({ name: 'test-editor' });
    await clientApp.connectWith(agent, async (ctx) => {
        // No `terminal` capability: an unadvertised method must never be called.
        await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
        await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
        for (const call of [
            () => bridge.createTerminal({ command: 'ls' }),
            () => bridge.terminalOutput({ terminalId: 't' }),
            () => bridge.waitForTerminalExit({ terminalId: 't' }),
            () => bridge.killTerminal({ terminalId: 't' }),
            () => bridge.releaseTerminal({ terminalId: 't' }),
        ]) {
            await assert.rejects(call, /does not offer terminal\//);
        }
    });
});

test('ACP conformance: the client bridge exposes the client-side methods', async () => {
    /** @type {any} */
    let bridge = null;
    const agent = createAcpAgent({
        session: scriptedSession([{ type: 'text', content: 'hi' }]),
        onTurnContext: (opts) => { bridge = opts; }
    });

    const clientApp = client({ name: 'test-editor' });
    /** @type {any[]} */
    const permissionRequests = [];
    clientApp.onRequest(methods.client.session.requestPermission, (ctx) => {
        permissionRequests.push(ctx.params);
        return { outcome: { outcome: 'selected', optionId: 'opt-allow' } };
    });

    await clientApp.connectWith(agent, async (ctx) => {
        await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
        await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'hi' }] });

        assert.ok(bridge, 'the turn context must be handed to the caller');
        assert.equal(bridge.sessionId.startsWith('merci-'), true);
        assert.ok(bridge.requestPermission, 'the bridge must expose requestPermission');
        assert.ok(bridge.elicit, 'the bridge must expose elicit');
        assert.ok(bridge.readFile, 'the bridge must expose readFile');
        assert.ok(bridge.writeFile, 'the bridge must expose writeFile');
        // The client announced no filesystem capability, so the bridge must refuse.
        await assert.rejects(() => bridge.readFile({ path: '/tmp/x' }), /does not offer fs\/read_text_file/);

        const outcome = await bridge.requestPermission({
            toolCall: { toolCallId: 'call-1', title: 'shell', kind: 'execute', status: 'pending', rawInput: {} },
            options: [{ optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' }]
        });
        assert.equal(outcome.outcome.outcome, 'selected');
        assert.equal(permissionAllowed({ response: outcome, options: [{ optionId: 'opt-allow', kind: 'allow_once' }] }), true);
        assert.equal(permissionAllowed({ response: { outcome: { outcome: 'cancelled' } } }), false);
        assert.equal(permissionAllowed({ response: { outcome: { outcome: 'selected', optionId: 'never-offered' } }, options: [{ optionId: 'opt-allow', kind: 'allow_once' }] }), false, 'an unknown option id must deny');
        assert.equal(permissionAllowed({ response: { outcome: { outcome: 'selected', optionId: 'r' } }, options: [{ optionId: 'r', kind: 'reject_once' }] }), false, 'a reject option must deny');
        assert.equal(permissionAllowed({ response: { outcome: { outcome: 'selected', optionId: 'a' } }, options: [] }), false, 'an empty option list must deny');
    });

    assert.equal(permissionRequests.length, 1);
    assert.equal(permissionRequests[0].toolCall.toolCallId, 'call-1');
    assert.equal(permissionRequests[0].options[0].optionId, 'opt-allow');
});
