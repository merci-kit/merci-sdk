// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ClientFactory } from '@a2a-js/sdk/client';
import { JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server';
import { Role, TaskState } from '@a2a-js/sdk';

import { loadA2ATool, getA2ATask, cancelA2ATask, A2A_COMPLETED_STATES } from '../lib/tools/a2a.mjs';
import { createA2AServer } from '../lib/tools/a2a-server.mjs';
import { A2A_TASK_STATES, A2A_METHODS } from '../lib/core/constants/index.mjs';

/**
 * Mounts an A2A peer on a loopback HTTP server.
 * @param {{ card?: ((opts: { baseUrl: string }) => any)|null, handle?: ((opts: { method: string, params?: any, id?: any }) => any)|null }} arg0
 * @returns {Promise<{ url: string, requests: Array<any>, close: () => Promise<void> }>}
 */
async function serveA2A({ card = null, handle = null } = {}) {
    /** @type {Array<any>} */
    const requests = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', async () => {
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            if (req.url?.includes('agent-card.json')) {
                const address = /** @type {any} */ (server.address());
                const resolved = /** @type {any} */ (card)({ baseUrl: `http://127.0.0.1:${address.port}` });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(resolved));
                return;
            }
            /** @type {any} */
            let parsed = {};
            try { parsed = JSON.parse(body || '{}'); } catch { /* keep empty */ }
            const out = handle
                ? await handle({ method: parsed.method, params: parsed.params, id: parsed.id })
                : { jsonrpc: '2.0', id: parsed.id, result: {} };
            if (out?.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                for (const event of out.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = /** @type {any} */ (server.address());
    const port = address.port;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((resolve) => server.close(() => resolve(undefined)))
    };
}

/**
 * A v1.0 agent card.
 * @param {{ baseUrl: string }} arg0
 * @returns {any}
 */
function v1Card({ baseUrl }) {
    return {
        name: 'oracle-peer',
        description: 'A peer that speaks the A2A v1.0 dialect.',
        version: '1.0.0',
        supportedInterfaces: [{ url: `${baseUrl}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: { streaming: false, pushNotifications: false },
        securitySchemes: {},
        securityRequirements: [],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [{ id: 'echo', name: 'echo', description: 'echo back', tags: [], examples: [], inputModes: [], outputModes: [], securityRequirements: [] }],
        signatures: []
    };
}

// ── The official client drives OUR server ────────────────────────────────────

test('A2A conformance: the official client can call our server', async () => {
    const server = createA2AServer({
        name: 'merci-peer',
        description: 'Merci as an A2A peer.',
        version: '1.0.0',
        skills: [{
            id: 'echo',
            name: 'echo',
            description: 'echo back',
            execute:
                /** @param {Record<string, any>} args */
                async (args) => `echo:${JSON.stringify(args)}`,
        }]
    });
    const peer = await serveA2A({
        card: ({ baseUrl }) => server.agentCard({ baseUrl }),
        handle: ({ method, params, id }) => server.handle({ method, params, id })
    });
    try {
        const client = await new ClientFactory().createFromUrl(peer.url);
        const card = await client.getAgentCard();
        assert.equal(card.name, 'merci-peer');
        assert.equal(card.skills[0].id, 'echo');

        const result = /** @type {any} */ (await client.sendMessage(/** @type {any} */ ({
            message: { messageId: 'm-1', role: Role.ROLE_USER, parts: [{ text: 'hello there' }] }
        })));
        assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED);
        assert.match(String(result.status.message.parts[0].content.value), /echo:/);

        const taskId = result.id;
        const fetched = /** @type {any} */ (await client.getTask(/** @type {any} */ ({ id: taskId })));
        assert.equal(fetched.id, taskId);
        assert.equal(fetched.status.state, TaskState.TASK_STATE_COMPLETED);

        const listed = /** @type {any} */ (await client.listTasks(/** @type {any} */ ({ contextId: '' })));
        assert.ok((/** @type {any[]} */ (listed.tasks)).some((t) => t.id === taskId));
    } finally {
        await peer.close();
    }
});

test('A2A conformance: the official client can cancel a task that is still running', async () => {
    const server = createA2AServer({
        name: 'merci-peer',
        description: 'Merci as an A2A peer.',
        version: '1.0.0',
        skills: [{
            id: 'slow',
            name: 'slow',
            description: 'stays working',
            execute: async () => ({ state: A2A_TASK_STATES.WORKING, text: 'still working' })
        }]
    });
    const peer = await serveA2A({
        card: ({ baseUrl }) => server.agentCard({ baseUrl }),
        handle: ({ method, params, id }) => server.handle({ method, params, id })
    });
    try {
        const client = await new ClientFactory().createFromUrl(peer.url);
        const result = /** @type {any} */ (await client.sendMessage(/** @type {any} */ ({
            message: { messageId: 'm-1', role: Role.ROLE_USER, parts: [{ text: 'go' }] }
        })));
        assert.equal(result.status.state, TaskState.TASK_STATE_WORKING);

        const canceled = /** @type {any} */ (await client.cancelTask(/** @type {any} */ ({ id: result.id })));
        assert.equal(canceled.status.state, TaskState.TASK_STATE_CANCELED);
    } finally {
        await peer.close();
    }
});

// ── The official server validates OUR client's wire format ───────────────────

test('A2A conformance: the official request handler accepts our client request', async () => {
    /** @type {any} */
    /** @type {{ params: any }} */
    const seen = { params: null };
    /** @type {Record<string, any>} */
    const handler = {
        getAgentCard: async () => ({}),
        getAuthenticatedExtendedAgentCard: async () => ({}),
        sendMessage:
            /** @param {any} params */
            async (params) => {
            seen.params = params;
            return {
                id: 'task-1',
                contextId: 'ctx-1',
                status: {
                    state: TaskState.TASK_STATE_COMPLETED,
                    message: {
                        messageId: 'm-1',
                        contextId: 'ctx-1',
                        taskId: 'task-1',
                        role: Role.ROLE_AGENT,
                        parts: [{ content: { $case: 'text', value: 'pong' } }]
                    },
                    timestamp: new Date().toISOString()
                },
                artifacts: [],
                history: []
            };
        },
        sendMessageStream: async function* () { /* not used */ },
        getTask: async () => ({}),
        cancelTask: async () => ({}),
        createTaskPushNotificationConfig: async () => ({}),
        getTaskPushNotificationConfig: async () => ({}),
        listTaskPushNotificationConfigs: async () => ({}),
        deleteTaskPushNotificationConfig: async () => ({}),
        resubscribe: async function* () { /* not used */ },
        listTasks: async () => ({ tasks: [] })
    };
    const transport = new JsonRpcTransportHandler(/** @type {any} */ (handler));

    const peer = await serveA2A({
        card: v1Card,
        handle: async ({ method, params, id }) => {
            const response = await transport.handle(/** @type {any} */ ({ jsonrpc: '2.0', id: id ?? 1, method, params }), new ServerCallContext());
            return response;
        }
    });
    try {
        const tools = await loadA2ATool({ agentUrl: peer.url });
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, 'echo');

        const out = await tools[0].execute({ args: { ping: 'pong' }, signal: null, context: {} });
        assert.match(String(out), /pong/);

        // The reference implementation parsed and validated our request.
        assert.ok(seen.params, 'the reference handler must have received our request');
        assert.equal(seen.params.message.role, Role.ROLE_USER);
        assert.equal(seen.params.message.parts[0].content.value, JSON.stringify({ ping: 'pong' }));

        const sent = /** @type {any} */ (peer.requests.find((r) => r.method === 'POST'));
        assert.equal(sent.headers['a2a-version'], '1.0');
        assert.equal(sent.headers['content-type'], 'application/json');
        const body = JSON.parse(sent.body);
        assert.equal(body.method, 'SendMessage');
        assert.equal(body.params.message.role, 'ROLE_USER');
        assert.ok(!('kind' in body.params.message.parts[0]), 'v1.0 parts are protobuf-JSON, not kind-tagged');
    } finally {
        await peer.close();
    }
});

// ── The legacy (v0.3) dialect ────────────────────────────────────────────────

test('A2A conformance: a v0.3 card makes the client speak the legacy dialect', async () => {
    /** @type {any[]} */
    const calls = [];
    const peer = await serveA2A({
        card: ({ baseUrl }) => ({
            name: 'legacy-peer',
            description: 'A peer that speaks the A2A v0.3 dialect.',
            version: '0.3.0',
            url: `${baseUrl}/a2a`,
            preferredTransport: 'JSONRPC',
            capabilities: { streaming: false },
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
            skills: [{ id: 'echo', name: 'echo', description: 'echo back', tags: [], examples: [], inputModes: [], outputModes: [] }]
        }),
        handle: ({ method, params, id }) => {
            calls.push({ method, params });
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    kind: 'task',
                    id: 'task-legacy',
                    contextId: 'ctx-legacy',
                    status: {
                        state: 'completed',
                        message: { role: 'agent', parts: [{ kind: 'text', text: 'legacy pong' }] }
                    },
                    artifacts: [],
                    history: []
                }
            };
        }
    });
    try {
        const tools = await loadA2ATool({ agentUrl: peer.url });
        const out = await tools[0].execute({ args: { ping: 'pong' }, signal: null, context: {} });
        assert.match(String(out), /legacy pong/);

        assert.equal(calls[0].method, 'message/send');
        assert.equal(calls[0].params.configuration.blocking, true);
        assert.equal(calls[0].params.message.role, 'user');
        assert.equal(calls[0].params.message.parts[0].kind, 'text');
    } finally {
        await peer.close();
    }
});

// ── Task states ──────────────────────────────────────────────────────────────

test('A2A conformance: an interrupted task reports needsInput instead of failing', async () => {
    const peer = await serveA2A({
        card: v1Card,
        handle: ({ id }) => ({
            jsonrpc: '2.0',
            id,
            result: {
                task: {
                    id: 'task-input',
                    contextId: 'ctx-1',
                    status: {
                        state: A2A_TASK_STATES.INPUT_REQUIRED,
                        message: { messageId: 'm-2', contextId: 'ctx-1', taskId: 'task-input', role: Role.ROLE_AGENT, parts: [{ text: 'which city?' }] }
                    },
                    artifacts: [],
                    history: []
                }
            }
        })
    });
    try {
        const tools = await loadA2ATool({ agentUrl: peer.url });
        const out = await tools[0].execute({ args: {}, signal: null, context: {} });
        assert.equal(out.success, false);
        assert.equal(out.needsInput, true);
        assert.equal(out.taskId, 'task-input');
        assert.match(out.prompt, /which city/);
    } finally {
        await peer.close();
    }
});

test('A2A conformance: a failed task raises an error naming the task', async () => {
    const peer = await serveA2A({
        card: v1Card,
        handle: ({ id }) => ({
            jsonrpc: '2.0',
            id,
            result: {
                task: {
                    id: 'task-failed',
                    contextId: 'ctx-1',
                    status: {
                        state: A2A_TASK_STATES.FAILED,
                        message: { messageId: 'm-3', contextId: 'ctx-1', taskId: 'task-failed', role: Role.ROLE_AGENT, parts: [{ text: 'upstream exploded' }] }
                    },
                    artifacts: [],
                    history: []
                }
            }
        })
    });
    try {
        const tools = await loadA2ATool({ agentUrl: peer.url });
        await assert.rejects(
            tools[0].execute({ args: {}, signal: null, context: {} }),
            /task-failed[\s\S]*upstream exploded/
        );
    } finally {
        await peer.close();
    }
});

// ── Task inspection and cancellation ─────────────────────────────────────────

test('A2A conformance: the official client consumes our A2A v1.0 event stream', async () => {
    const server = createA2AServer({
        name: 'stream-peer',
        skills: [{ id: 'echo', name: 'echo', description: 'echo', execute: async () => 'streamed' }]
    });
    const peer = await serveA2A({
        card: ({ baseUrl }) => server.agentCard({ baseUrl }),
        handle: ({ method, params, id }) => server.handle({ method, params, id })
    });
    try {
        const client = await new ClientFactory().createFromUrl(peer.url);
        /** @type {any[]} */
        const events = [];
        for await (const event of client.sendMessageStream(/** @type {any} */ ({
            message: { messageId: 'm-1', role: Role.ROLE_USER, parts: [{ text: 'hi' }] }
        }))) {
            events.push(event);
        }
        assert.ok(events.length >= 1, 'the stream must carry at least one event');
        const cases = events.map((/** @type {any} */ e) => e.payload?.$case);
        assert.ok(cases.includes('statusUpdate'), 'the v1.0 stream carries the statusUpdate frame; a bare status is not the dialect');
        const update = events.find((/** @type {any} */ e) => e.payload?.$case === 'statusUpdate');
        assert.equal(update.payload.value.status.state, TaskState.TASK_STATE_COMPLETED, 'the status update carries the task state');
        const last = events[events.length - 1];
        assert.equal(last.payload?.$case, 'task', 'the final event carries the task');
        assert.equal(last.payload.value.status.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal(last.payload.value.status.message.parts[0].content.value, 'streamed');
    } finally {
        await peer.close();
    }
});

test('A2A conformance: the v1.0 response encoding is role, part and state', async () => {
    /** @type {any[]} */
    const bodies = [];
    const peer = await serveA2A({
        card: v1Card,
        handle: ({ method, params, id }) => {
            bodies.push({ method, params });
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    task: {
                        id: 'task-1',
                        contextId: 'ctx-1',
                        status: {
                            state: 'TASK_STATE_COMPLETED',
                            message: { messageId: 'm-1', contextId: 'ctx-1', taskId: 'task-1', role: 'ROLE_AGENT', parts: [{ text: 'encoded' }] }
                        },
                        artifacts: [],
                        history: []
                    }
                }
            };
        }
    });
    try {
        const tools = await loadA2ATool({ agentUrl: peer.url });
        const out = await tools[0].execute({ args: {}, signal: null, context: {} });
        assert.equal(out, 'encoded');
        // The request must use the v1.0 role and the protobuf-JSON part shape.
        assert.equal(bodies[0].params.message.role, 'ROLE_USER');
        assert.equal(bodies[0].params.message.parts[0].text, '{}');
        assert.ok(!('kind' in bodies[0].params.message.parts[0]));
    } finally {
        await peer.close();
    }
});

test('A2A conformance: every advertised skill is individually reachable', async () => {
    const server = createA2AServer({
        name: 'multi',
        skills: [
            { id: 'alpha', name: 'alpha', description: 'a', execute: async () => 'ran ALPHA' },
            { id: 'beta', name: 'beta', description: 'b', execute: async () => 'ran BETA' }
        ]
    });
    const peer = await serveA2A({
        card: ({ baseUrl }) => server.agentCard({ baseUrl }),
        handle: ({ method, params, id }) => server.handle({ method, params, id })
    });
    try {
        const tools = await loadA2ATool({ agentUrl: peer.url });
        assert.equal(tools.length, 2);
        const alphaTool = tools.find((t) => t.name === 'alpha');
        const betaTool = tools.find((t) => t.name === 'beta');
        assert.ok(alphaTool && betaTool, 'both skills must be materialized');
        const alpha = await alphaTool.execute({ args: {}, signal: null, context: {} });
        const beta = await betaTool.execute({ args: {}, signal: null, context: {} });
        assert.equal(String(alpha), 'ran ALPHA');
        assert.equal(String(beta), 'ran BETA');
    } finally {
        await peer.close();
    }
});

test('A2A conformance: a skill that throws becomes a failed task, not a crash', async () => {
    const peer = await serveA2A({
        card: v1Card,
        handle: async ({ method, params, id }) => {
            const server = createA2AServer({
                name: 'failing',
                skills: [{ id: 'boom', name: 'boom', description: 'always fails', execute: async () => { throw new Error('kaboom'); } }]
            });
            return server.handle({ method, params, id });
        }
    });
    try {
        const tools = await loadA2ATool({ agentUrl: peer.url });
        await assert.rejects(
            tools[0].execute({ args: {}, signal: null, context: {} }),
            /did not complete[\s\S]*kaboom/
        );
    } finally {
        await peer.close();
    }
});

test('A2A conformance: a task can be read and cancelled', async () => {
    /** @type {any[]} */
    const calls = [];
    const peer = await serveA2A({
        card: v1Card,
        handle: ({ method, params, id }) => {
            calls.push({ method, params });
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    id: params?.id ?? 'task-9',
                    contextId: 'ctx-1',
                    status: { state: method === 'CancelTask' ? A2A_TASK_STATES.CANCELED : A2A_TASK_STATES.WORKING, timestamp: new Date().toISOString() },
                    artifacts: [],
                    history: []
                }
            };
        }
    });
    try {
        const task = await getA2ATask({ agentUrl: peer.url, taskId: 'task-9' });
        assert.equal(task.taskId, 'task-9');
        assert.equal(task.state, A2A_TASK_STATES.WORKING);
        assert.equal(calls[0].method, 'GetTask');

        const canceled = await cancelA2ATask({ agentUrl: peer.url, taskId: 'task-9' });
        assert.equal(canceled, true);
        assert.equal(calls[1].method, 'CancelTask');
    } finally {
        await peer.close();
    }
});

// ── The agent card we publish ────────────────────────────────────────────────

test('A2A conformance: our agent card is a v1.0 card', async () => {
    const server = createA2AServer({
        name: 'card-agent',
        description: 'A card.',
        version: '2.1.0',
        skills: [{ id: 's1', name: 's1', description: 'a skill', execute: async () => 'ok' }]
    });
    const card = /** @type {Record<string, any>} */ (server.agentCard({ baseUrl: 'http://127.0.0.1:1234' }));
    assert.equal(card.name, 'card-agent');
    assert.equal(card.version, '2.1.0');
    assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
    assert.equal(card.supportedInterfaces[0].url, 'http://127.0.0.1:1234/a2a');
    assert.equal(card.capabilities.streaming, true);
    assert.equal(card.skills[0].id, 's1');
    assert.ok(Array.isArray(card.securityRequirements));
});

test('A2A conformance: the v1.0 wire methods are the proto names', () => {
    // The v1.0 JSON-RPC binding uses the proto method names; the slash names
    // are the v0.3 dialect and are only used when the card says so.
    assert.equal(A2A_METHODS.SEND_MESSAGE, 'message/send');
    assert.equal(A2A_METHODS.STREAM_MESSAGE, 'message/stream');
    assert.equal(A2A_METHODS.GET_TASK, 'tasks/get');
    assert.equal(A2A_METHODS.LIST_TASKS, 'tasks/list');
    assert.equal(A2A_METHODS.CANCEL_TASK, 'tasks/cancel');
});

test('A2A: the exported terminal-state list is immutable', () => {
    // A shared mutable export could be changed for every consumer in the
    // process; the type says `readonly`, and the value must agree.
    assert.equal(Object.isFrozen(A2A_COMPLETED_STATES), true);
    assert.throws(() => { /** @type {any} */ (A2A_COMPLETED_STATES).push('TASK_STATE_BOGUS'); }, TypeError);
    assert.equal(A2A_COMPLETED_STATES.includes('TASK_STATE_BOGUS'), false);
});

// ── Continuation and cancellation ────────────────────────────────────────────

test('A2A client: a needsInput result is continued with its taskId/contextId', async () => {
    /** @type {Array<any>} */
    const sent = [];
    const peer = await serveA2A({
        card: ({ baseUrl }) => v1Card({ baseUrl }),
        handle: ({ method, params, id }) => {
            if (method === 'SendMessage') {
                sent.push(params);
                if (params?.message?.taskId) {
                    return { jsonrpc: '2.0', id, result: {
                        id: params.message.taskId,
                        contextId: params.message.contextId,
                        status: { state: 'TASK_STATE_COMPLETED', message: { parts: [{ text: 'done' }] } },
                        artifacts: []
                    } };
                }
                return { jsonrpc: '2.0', id, result: {
                    id: 't1',
                    contextId: 'ctx',
                    status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { parts: [{ text: 'need more' }] } },
                    artifacts: []
                } };
            }
            return { jsonrpc: '2.0', id, result: {} };
        }
    });
    try {
        const [tool] = await loadA2ATool({ agentUrl: peer.url });
        const first = /** @type {any} */ (await tool.execute({ args: {}, signal: null, context: {} }));
        assert.equal(first.needsInput, true);
        assert.equal(first.taskId, 't1');
        assert.equal(first.contextId, 'ctx');

        const second = await tool.execute({ args: { taskId: first.taskId, contextId: first.contextId }, signal: null, context: {} });
        assert.equal(second, 'done');
        const continuation = sent.find((p) => p?.message?.taskId === 't1');
        assert.equal(continuation?.message?.contextId, 'ctx', 'the context travels with the continuation');
        assert.equal(/** @type {any} */ (tool.parameters).properties.taskId.type, 'string', 'the schema advertises the continuation');
    } finally {
        await peer.close();
    }
});

test('A2A client: aborting a delegation cancels the remote task', async () => {
    /** @type {any} */
    let cancelParams = null;
    const working = { id: 't1', contextId: 'ctx', status: { state: 'TASK_STATE_WORKING' }, artifacts: [] };
    const peer = await serveA2A({
        card: ({ baseUrl }) => v1Card({ baseUrl }),
        handle: ({ method, params, id }) => {
            if (method === 'CancelTask') {
                cancelParams = params;
                return { jsonrpc: '2.0', id, result: { ...working, status: { state: 'TASK_STATE_CANCELED' } } };
            }
            if (method === 'GetTask') return { jsonrpc: '2.0', id, result: working };
            if (method === 'SendMessage') return { jsonrpc: '2.0', id, result: working };
            return { jsonrpc: '2.0', id, result: {} };
        }
    });
    try {
        const [tool] = await loadA2ATool({ agentUrl: peer.url, timeoutMs: 10_000 });
        const controller = new AbortController();
        const call = tool.execute({ args: {}, signal: controller.signal, context: {} });
        setTimeout(() => controller.abort(new Error('stop')), 150);
        await assert.rejects(call, (/** @type {any} */ err) => err?.name === 'AbortError');
        assert.equal(cancelParams?.id, 't1', 'the remote task was cancelled');
    } finally {
        await peer.close();
    }
});
