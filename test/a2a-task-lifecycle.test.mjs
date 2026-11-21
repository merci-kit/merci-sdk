// @ts-check
/**
 * The A2A server kept tasks forever, never cancelled a running skill, ignored
 * the page token and let a finished task overwrite a cancel. These tests pin
 * the lifecycle: cancel wins over completion, paging is a decimal offset, and
 * terminal tasks expire by count and by age.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createA2AServer } from '../lib/tools/a2a-server.mjs';
import { A2A_TASK_STATES } from '../lib/core/constants/index.mjs';

/** @param {any} execute */
const skill = (execute) => ({ id: 'work', name: 'work', description: 'd', execute });

/** @param {{server: any, taskId: string, text?: string}} arg0 */
const send = ({ server, taskId, text = 'go' }) => server.handle({
    method: 'SendMessage',
    params: {
        message: { role: 'user', taskId, messageId: `m-${taskId}`, parts: [{ kind: 'text', text }] },
    },
});

/** @param {{server: any, taskId: string}} arg0 */
const cancel = ({ server, taskId }) => server.handle({ method: 'CancelTask', params: { id: taskId } });

/** @param {{server: any, params?: any}} arg0 */
const list = ({ server, params = {} }) => server.handle({ method: 'ListTasks', params });

/** @param {{server: any, taskId: string}} arg0 */
const get = ({ server, taskId }) => server.handle({ method: 'GetTask', params: { id: taskId } });

test('a cancel mid-run aborts the skill and the state stays CANCELED', async () => {
    /** @type {{aborted: boolean}} */
    const seen = { aborted: false };
    const server = createA2AServer({ skills: [skill(async (/** @type {any} */ _args, /** @type {any} */ { signal }) => {
        await new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => { seen.aborted = true; reject(signal.reason); }, { once: true });
            setTimeout(resolve, 5000);
        });
        return 'finished anyway';
    })] });

    const pending = send({ server, taskId: 't-cancel' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const canceled = await cancel({ server, taskId: 't-cancel' });
    assert.equal(canceled.result.status.state, A2A_TASK_STATES.CANCELED);

    const sent = await pending;
    assert.equal(seen.aborted, true, 'the skill saw the abort signal');
    assert.equal(sent.result.task.status.state, A2A_TASK_STATES.CANCELED, 'the finished run did not overwrite the cancel');
});

test('cancel treats every terminal state as terminal', async () => {
    const server = createA2AServer({ skills: [skill(async () => ({ text: 'ok', state: A2A_TASK_STATES.REJECTED }))] });
    await send({ server, taskId: 't-rejected' });
    const res = await cancel({ server, taskId: 't-rejected' });
    assert.equal(res.error.code, -32002, 'a rejected task is already finished');
});

test('listTasks pages by decimal offset and reports no token on the last page', async () => {
    const server = createA2AServer({ skills: [skill(async () => 'ok')] });
    for (let i = 0; i < 120; i += 1) await send({ server, taskId: `t-${String(i).padStart(3, '0')}` });

    const first = await list({ server, params: { pageSize: 50 } });
    assert.equal(first.result.tasks.length, 50);
    assert.equal(first.result.nextPageToken, '50');

    const second = await list({ server, params: { pageSize: 50, pageToken: '50' } });
    assert.equal(second.result.tasks.length, 50);
    assert.equal(second.result.nextPageToken, '100');

    const third = await list({ server, params: { pageSize: 50, pageToken: '100' } });
    assert.equal(third.result.tasks.length, 20);
    assert.equal(third.result.nextPageToken, '');

    const ids = [...first.result.tasks, ...second.result.tasks, ...third.result.tasks].map((/** @type {any} */ t) => t.id);
    assert.equal(new Set(ids).size, 120, 'no task repeats across pages');
});

test('an invalid page size is -32602', async () => {
    const server = createA2AServer({ skills: [skill(async () => 'ok')] });
    await send({ server, taskId: 't1' });
    for (const pageSize of ['abc', '0', '2.5']) {
        const res = await list({ server, params: { pageSize } });
        assert.equal(res.error?.code, -32602, `pageSize ${pageSize}`);
    }
});

test('an invalid page token is -32602', async () => {
    const server = createA2AServer({ skills: [skill(async () => 'ok')] });
    await send({ server, taskId: 't1' });
    for (const pageToken of ['abc', '-1', '1.5']) {
        const res = await list({ server, params: { pageToken } });
        assert.equal(res.error?.code, -32602, `token ${pageToken}`);
    }
});

test('the 1001st terminal task evicts the oldest terminal task', async () => {
    const server = createA2AServer({ skills: [skill(async () => 'ok')] });
    for (let i = 0; i < 1001; i += 1) await send({ server, taskId: `t-${String(i).padStart(4, '0')}` });
    assert.equal(server.listTasks().length, 1000, 'the store is capped at 1000 terminal tasks');
    const evicted = await get({ server, taskId: 't-0000' });
    assert.equal(evicted.error.code, -32001, 'the oldest task is gone');
    const kept = await get({ server, taskId: 't-0001' });
    assert.equal(kept.result.id, 't-0001');
});

test('a terminal task expires one hour after it finished', async () => {
    /** @type {{value: number}} */
    const clock = { value: 1_000_000 };
    const server = createA2AServer({ skills: [skill(async () => 'ok')], now: () => clock.value });
    await send({ server, taskId: 't-old' });
    clock.value += 60 * 60 * 1000;
    await send({ server, taskId: 't-new' });
    const res = await list({ server });
    const ids = res.result.tasks.map((/** @type {any} */ t) => t.id);
    assert.deepEqual(ids, ['t-new'], 'the expired task was pruned on create');
    assert.equal((await get({ server, taskId: 't-old' })).error.code, -32001);
});

test('continuing a finished id keeps the new run and its cancel path', async () => {
    /** @type {{value: number}} */
    const clock = { value: 2_000_000 };
    let calls = 0;
    /** @type {any} */
    let release = null;
    /** @type {{aborted: boolean}} */
    const seen = { aborted: false };
    const server = createA2AServer({
        now: () => clock.value,
        skills: [skill(async (/** @type {any} */ _args, /** @type {any} */ { signal }) => {
            calls += 1;
            if (calls === 1) return 'first run';
            await new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => { seen.aborted = true; reject(signal.reason); }, { once: true });
                release = resolve;
            });
            return 'second run';
        })],
    });
    await send({ server, taskId: 't-continued' });
    clock.value += 30 * 60 * 1000;
    const pending = send({ server, taskId: 't-continued' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    clock.value += 30 * 60 * 1000 + 1;
    const listed = await list({ server });
    assert.deepEqual(listed.result.tasks.map((/** @type {any} */ t) => t.id), ['t-continued'], 'a running task is not pruned by a stale timestamp');
    const got = await get({ server, taskId: 't-continued' });
    assert.equal(got.result.status.state, A2A_TASK_STATES.WORKING);
    const canceled = await cancel({ server, taskId: 't-continued' });
    assert.equal(canceled.result.status.state, A2A_TASK_STATES.CANCELED, 'the live controller was still there');
    assert.equal(seen.aborted, true);
    release?.();
    await pending;
});

test('the cap holds when terminal and running tasks are mixed', async () => {
    const server = createA2AServer({ maxTerminalTasks: 3, skills: [skill(() => new Promise(() => {}))] });
    const terminal = createA2AServer({ maxTerminalTasks: 3, skills: [skill(async () => 'ok')] });
    for (let i = 0; i < 3; i += 1) await send({ server: terminal, taskId: `done-${i}` });
    // 3 terminal tasks on a 3-slot store: the next creates evict the oldest.
    for (let i = 0; i < 3; i += 1) await send({ server: terminal, taskId: `done-next-${i}` });
    assert.equal(terminal.listTasks().length, 3, 'terminal work stays at the cap');
    assert.equal((await get({ server: terminal, taskId: 'done-0' })).error.code, -32001, 'the oldest went first');

    // A store full of running tasks has nothing to evict.
    for (let i = 0; i < 3; i += 1) void send({ server, taskId: `run-${i}` });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const refused = await send({ server, taskId: 'run-overflow' });
    assert.equal(refused.error?.code, -32000);
});

test('new work is refused when the cap is reached and nothing is terminal', { timeout: 15000 }, async () => {
    const server = createA2AServer({ skills: [skill(() => new Promise(() => {}))] });
    // 1000 runs that never settle: every task is non-terminal.
    for (let i = 0; i < 1000; i += 1) void send({ server, taskId: `p-${String(i).padStart(4, '0')}` });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const res = await send({ server, taskId: 'p-overflow' });
    assert.equal(res.error?.code, -32000, 'the store must not grow without bound');
});
