// @ts-check
/**
 * The A2A HTTP handler had no caller identity: one client listed every task,
 * read another's input, replaced a live task and cancelled a stranger's run.
 * These tests pin the tenant boundary the handler now enforces through an
 * `authorize` hook, and the task-id reuse rules that go with it.
 *
 * Without `authorize` nothing changes: one principal (`null`) owns every task,
 * which is today's single-tenant peer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

import { createA2AServer, createA2AHttpHandler } from '../lib/tools/a2a-server.mjs';
import { A2A_TASK_STATES } from '../lib/core/constants/index.mjs';

/** @param {any} execute */
const skill = (execute) => ({ id: 'work', name: 'work', description: 'd', execute });

/** The handler hook under test: a bearer-ish header names the tenant. */
const authorizeFromHeader = (/** @type {{req: any}} */ { req }) => {
    const principal = String(req.headers?.['x-principal'] ?? '');
    if (!principal) throw new Error('missing principal');
    return principal;
};

/** @param {{handler: (req: any, res: any) => any}} arg0 */
async function listen({ handler }) {
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {any} */ (server.address()).port;
    return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * One JSON-RPC call over real HTTP.
 * @param {{port: number, principal?: string, method: string, params?: any}} arg0
 * @returns {Promise<{status: number, body: any}>}
 */
function rpc({ port, principal, method, params = {} }) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    /** @type {Record<string, string>} */
    const headers = {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
    };
    if (principal !== undefined) headers['x-principal'] = principal;
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/a2a', headers }, (res) => {
            /** @type {Buffer[]} */
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                /** @type {any} */
                let parsed = {};
                try { parsed = JSON.parse(text || '{}'); } catch { /* keep empty */ }
                resolve({ status: res.statusCode ?? 0, body: parsed });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

/** @param {{taskId?: string, text: string}} arg0 */
const sendParams = ({ taskId, text }) => ({
    message: {
        role: 'ROLE_USER',
        messageId: `m-${text}`,
        ...(taskId ? { taskId } : {}),
        parts: [{ kind: 'text', text: JSON.stringify({ value: text }) }],
    },
});

test('tasks/list shows only the caller\'s tasks', async () => {
    const server = createA2AServer({ skills: [skill(async (/** @type {any} */ args) => `echo:${args.value}`)] });
    const handler = createA2AHttpHandler({ server, authorize: authorizeFromHeader });
    const srv = await listen({ handler });
    try {
        const sent = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ text: 'A-secret' }) });
        const aTaskId = sent.body.result.task.id;
        assert.ok(aTaskId);

        const listedByB = await rpc({ port: srv.port, principal: 'tenant-B', method: 'ListTasks', params: {} });
        assert.deepEqual(listedByB.body.result.tasks, [], 'B sees none of A\'s tasks');

        const readByB = await rpc({ port: srv.port, principal: 'tenant-B', method: 'GetTask', params: { id: aTaskId } });
        assert.equal(readByB.body.error?.code, -32001, 'a foreign task is unknown, not forbidden');

        const cancelByB = await rpc({ port: srv.port, principal: 'tenant-B', method: 'CancelTask', params: { id: aTaskId } });
        assert.equal(cancelByB.body.error?.code, -32001);

        const listedByA = await rpc({ port: srv.port, principal: 'tenant-A', method: 'ListTasks', params: {} });
        assert.deepEqual(listedByA.body.result.tasks.map((/** @type {any} */ t) => t.id), [aTaskId]);
        assert.equal(listedByA.body.result.tasks[0].status.state, A2A_TASK_STATES.COMPLETED);
        assert.equal(JSON.stringify(listedByA.body.result).includes('tenant-A'), false, 'the principal never reaches the wire');
    } finally { await srv.close(); }
});

test('a foreign principal cannot reuse a live task id', async () => {
    // Runs for 150ms unless cancelled, so a rejected request in this test can
    // never leave a run that outlives the assertion that failed.
    const server = createA2AServer({
        skills: [skill((/** @type {any} */ _args, /** @type {any} */ { signal }) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve('late'), 150);
            signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('canceled')); }, { once: true });
        }))],
    });
    const handler = createA2AHttpHandler({ server, authorize: authorizeFromHeader });
    const srv = await listen({ handler });
    /** @type {ReturnType<typeof rpc>} */
    let pendingA = Promise.resolve({ status: 0, body: null });
    try {
        pendingA = rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'run-1', text: 'A-live' }) });
        for (let i = 0; i < 100; i += 1) {
            if (server.getTask({ id: 'run-1' })) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        const reuseByB = await rpc({ port: srv.port, principal: 'tenant-B', method: 'SendMessage', params: sendParams({ taskId: 'run-1', text: 'B-overwrote' }) });
        assert.equal(reuseByB.body.error?.code, -32003, 'B must not overwrite A\'s task id');
        const live = /** @type {any} */ (server.getTask({ id: 'run-1' }));
        assert.equal(live?.history?.[0]?.parts?.[0]?.text, JSON.stringify({ value: 'A-live' }), 'A\'s history is intact');
        assert.equal(JSON.stringify(live).includes('B-overwrote'), false);

        const reuseByA = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'run-1', text: 'A-again' }) });
        assert.equal(reuseByA.body.error?.code, -32002, 'even the owner cannot overwrite a live task');

        const canceled = await rpc({ port: srv.port, principal: 'tenant-A', method: 'CancelTask', params: { id: 'run-1' } });
        assert.equal(canceled.body.result.status.state, A2A_TASK_STATES.CANCELED);

        const finished = await pendingA;
        assert.equal(finished.body.result.task.status.state, A2A_TASK_STATES.CANCELED, 'A cancelled its own run, not B\'s');
    } finally {
        // A refused request must not leave the peer's run dangling: in a
        // broken build it may still be the task that owns the id.
        await rpc({ port: srv.port, principal: 'tenant-A', method: 'CancelTask', params: { id: 'run-1' } }).catch(() => {});
        await pendingA.catch(() => {});
        await srv.close();
    }
});

test('the owner may continue an interrupted task and a stranger may not', async () => {
    const server = createA2AServer({
        skills: [skill(async (/** @type {any} */ args) => (args.value === 'first'
            ? { state: A2A_TASK_STATES.INPUT_REQUIRED, text: 'which city?' }
            : `answer:${args.value}`))],
    });
    const handler = createA2AHttpHandler({ server, authorize: authorizeFromHeader });
    const srv = await listen({ handler });
    try {
        const asked = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'ask-1', text: 'first' }) });
        assert.equal(asked.body.result.task.status.state, A2A_TASK_STATES.INPUT_REQUIRED);

        const foreign = await rpc({ port: srv.port, principal: 'tenant-B', method: 'SendMessage', params: sendParams({ taskId: 'ask-1', text: 'lisbon' }) });
        assert.equal(foreign.body.error?.code, -32003, 'a stranger cannot answer A\'s question');

        const resumed = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'ask-1', text: 'lisbon' }) });
        assert.equal(resumed.body.result.task.status.state, A2A_TASK_STATES.COMPLETED, 'input-required is a continuation, not a live run');
        assert.equal(resumed.body.result.task.status.message.parts[0].text, 'answer:lisbon');
    } finally { await srv.close(); }
});

test('after the terminal state the owner may reuse its task id and a stranger may not', async () => {
    const server = createA2AServer({ skills: [skill(async (/** @type {any} */ args) => `echo:${args.value}`)] });
    const handler = createA2AHttpHandler({ server, authorize: authorizeFromHeader });
    const srv = await listen({ handler });
    try {
        const first = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'reused', text: 'one' }) });
        assert.equal(first.body.result.task.status.state, A2A_TASK_STATES.COMPLETED);

        const second = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'reused', text: 'two' }) });
        assert.equal(second.body.result.task.status.state, A2A_TASK_STATES.COMPLETED);
        assert.deepEqual(second.body.result.task.history.map((/** @type {any} */ m) => m.parts[0].text), [JSON.stringify({ value: 'two' })]);

        const foreign = await rpc({ port: srv.port, principal: 'tenant-B', method: 'SendMessage', params: sendParams({ taskId: 'reused', text: 'three' }) });
        assert.equal(foreign.body.error?.code, -32003, 'a finished id still belongs to its principal');
    } finally { await srv.close(); }
});

test('without authorize the peer stays single-tenant', async () => {
    const server = createA2AServer({ skills: [skill(async (/** @type {any} */ args) => `echo:${args.value}`)] });
    const handler = createA2AHttpHandler({ server });
    const srv = await listen({ handler });
    try {
        const sent = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'shared', text: 'A' }) });
        assert.equal(sent.body.result.task.status.state, A2A_TASK_STATES.COMPLETED);

        const read = await rpc({ port: srv.port, principal: 'tenant-B', method: 'GetTask', params: { id: 'shared' } });
        assert.equal(read.body.result.id, 'shared', 'no hook means one principal, as before');

        const listed = await rpc({ port: srv.port, principal: 'tenant-B', method: 'ListTasks', params: {} });
        assert.equal(listed.body.result.tasks.length, 1);
    } finally { await srv.close(); }
});

test('a throwing authorize hook is a 403', async () => {
    const server = createA2AServer({ skills: [skill(async () => 'ok')] });
    const handler = createA2AHttpHandler({ server, authorize: () => { throw new Error('no token'); } });
    const srv = await listen({ handler });
    try {
        const res = await rpc({ port: srv.port, principal: 'tenant-A', method: 'ListTasks', params: {} });
        assert.equal(res.status, 403);
        assert.equal(res.body.error?.code, -32000);
        assert.deepEqual(server.listTasks(), [], 'a denied request starts nothing');
    } finally { await srv.close(); }
});

test('an authorize hook that returns no stable key is a misconfiguration, not a tenant', async () => {
    /** @type {Array<() => any>} */
    const hooks = [
        async () => '',
        async () => '   ',
        async () => null,
        async () => undefined,
        async () => ({ sub: 'tenant-A', scope: 'a2a' }),
        async () => ['tenant-A'],
        async () => true,
    ];
    for (const authorize of hooks) {
        const server = createA2AServer({ skills: [skill(async () => 'ok')] });
        const handler = createA2AHttpHandler({ server, authorize });
        const srv = await listen({ handler });
        try {
            const res = await rpc({ port: srv.port, principal: 'tenant-A', method: 'ListTasks', params: {} });
            assert.equal(res.status, 500, `the hook's answer ${JSON.stringify(await authorize())} is not a principal`);
            assert.match(String(res.body.error?.message ?? ''), /stable/);
            assert.match(String(res.body.error?.message ?? ''), /string/);
            assert.deepEqual(server.listTasks(), []);
        } finally { await srv.close(); }
    }
});

test('a numeric principal is coerced to its string key', async () => {
    const server = createA2AServer({ skills: [skill(async (/** @type {any} */ args) => `echo:${args.value}`)] });
    const handler = createA2AHttpHandler({
        server,
        authorize: async ({ req }) => Number(req.headers['x-principal']),
    });
    const srv = await listen({ handler });
    try {
        const sent = await rpc({ port: srv.port, principal: '8675309', method: 'SendMessage', params: sendParams({ text: 'mine' }) });
        const taskId = sent.body.result.task.id;
        assert.equal(sent.body.result.task.status.state, A2A_TASK_STATES.COMPLETED);

        const sameTenant = await rpc({ port: srv.port, principal: '8675309', method: 'GetTask', params: { id: taskId } });
        assert.equal(sameTenant.body.result.id, taskId, 'the same key resolves to the same owner');
        assert.equal(JSON.stringify(sameTenant.body.result).includes('8675309'), false, 'the key is not serialized');

        const otherTenant = await rpc({ port: srv.port, principal: '8675310', method: 'GetTask', params: { id: taskId } });
        assert.equal(otherTenant.body.error?.code, -32001);
    } finally { await srv.close(); }
});

test('parked tasks do not use up admission capacity', async () => {
    const server = createA2AServer({
        maxTerminalTasks: 2,
        skills: [skill(async (/** @type {any} */ args) => (args.value === 'park'
            ? { state: A2A_TASK_STATES.INPUT_REQUIRED, text: 'which city?' }
            : `ok:${args.value}`))],
    });
    const handler = createA2AHttpHandler({ server, authorize: authorizeFromHeader });
    const srv = await listen({ handler });
    try {
        const first = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'park-1', text: 'park' }) });
        const second = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'park-2', text: 'park' }) });
        assert.equal(first.body.result.task.status.state, A2A_TASK_STATES.INPUT_REQUIRED);
        assert.equal(second.body.result.task.status.state, A2A_TASK_STATES.INPUT_REQUIRED);

        const ordinary = await rpc({ port: srv.port, principal: 'tenant-B', method: 'SendMessage', params: sendParams({ text: 'hello' }) });
        assert.equal(ordinary.body.error, undefined, 'a parked row is not admission capacity');
        assert.equal(ordinary.body.result.task.status.state, A2A_TASK_STATES.COMPLETED);

        const resumed = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'park-1', text: 'lisbon' }) });
        assert.equal(resumed.body.result.task.status.state, A2A_TASK_STATES.COMPLETED, 'the owner can still continue its parked task');
    } finally { await srv.close(); }
});

test('authorize is awaited once per request', async () => {
    let calls = 0;
    const server = createA2AServer({ skills: [skill(async () => 'ok')] });
    const handler = createA2AHttpHandler({
        server,
        authorize: async ({ req }) => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 1));
            return String(req.headers['x-principal'] ?? '');
        },
    });
    const srv = await listen({ handler });
    try {
        await rpc({ port: srv.port, principal: 'tenant-A', method: 'ListTasks', params: {} });
        assert.equal(calls, 1);
    } finally { await srv.close(); }
});

test('continuing a settled task still needs an admission slot', async () => {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    const server = createA2AServer({
        maxTerminalTasks: 1,
        skills: [skill(async (/** @type {any} */ args) => {
            if (args.value === 'park') return { state: A2A_TASK_STATES.INPUT_REQUIRED, text: 'which?' };
            if (args.value === 'hold') { await gate; return 'held'; }
            return `ok:${args.value}`;
        })],
    });
    const handler = createA2AHttpHandler({ server, authorize: authorizeFromHeader });
    const srv = await listen({ handler });
    try {
        const parked = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'park-1', text: 'park' }) });
        assert.equal(parked.body.result.task.status.state, A2A_TASK_STATES.INPUT_REQUIRED);

        const holding = rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ text: 'hold' }) });
        await new Promise((resolve) => setTimeout(resolve, 20));

        const refused = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'park-1', text: 'lisbon' }) });
        assert.equal(refused.body.error?.code, -32000, 'a continuation cannot exceed the running cap');

        release();
        await holding;

        const resumed = await rpc({ port: srv.port, principal: 'tenant-A', method: 'SendMessage', params: sendParams({ taskId: 'park-1', text: 'lisbon' }) });
        assert.equal(resumed.body.result.task.status.state, A2A_TASK_STATES.COMPLETED, 'once a slot frees, the continuation runs');
    } finally { await srv.close(); }
});
