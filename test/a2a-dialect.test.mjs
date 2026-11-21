// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { A2A_METHODS, A2A_TASK_STATES } from '../lib/core/constants/index.mjs';
import { canonicalState, legacyState, messageText, partText, resolveDialect, rpcError, rpcResult } from '../lib/tools/a2a-dialect.mjs';
import { readStoredJsonSync } from '../lib/support/fs-store.mjs';

/** Each handled operation's wire name in both dialects: [v1.0 proto name, v0.3 slash name]. */
const WIRE_NAMES = {
    [A2A_METHODS.SEND_MESSAGE]: ['SendMessage', 'message/send'],
    [A2A_METHODS.STREAM_MESSAGE]: ['SendStreamingMessage', 'message/stream'],
    [A2A_METHODS.GET_TASK]: ['GetTask', 'tasks/get'],
    [A2A_METHODS.LIST_TASKS]: ['ListTasks', 'tasks/list'],
    [A2A_METHODS.CANCEL_TASK]: ['CancelTask', 'tasks/cancel'],
};

/** Each canonical state's v0.3 spelling. */
const LEGACY_SPELLINGS = {
    [A2A_TASK_STATES.SUBMITTED]: 'submitted',
    [A2A_TASK_STATES.WORKING]: 'working',
    [A2A_TASK_STATES.COMPLETED]: 'completed',
    [A2A_TASK_STATES.FAILED]: 'failed',
    [A2A_TASK_STATES.CANCELED]: 'canceled',
    [A2A_TASK_STATES.INPUT_REQUIRED]: 'input-required',
    [A2A_TASK_STATES.REJECTED]: 'rejected',
    [A2A_TASK_STATES.AUTH_REQUIRED]: 'auth-required',
};

describe('a2a-dialect: resolveDialect', () => {
    for (const [op, [v1Name, legacyName]] of Object.entries(WIRE_NAMES)) {
        it(`reads ${op} in both dialects`, () => {
            assert.deepEqual(resolveDialect({ method: v1Name }), { dialect: 'v1', op });
            assert.deepEqual(resolveDialect({ method: legacyName }), { dialect: 'legacy', op });
        });
    }

    it('an unknown method keeps v1 with an empty operation', () => {
        assert.deepEqual(resolveDialect({ method: 'tasks/unknown' }), { dialect: 'v1', op: '' });
        assert.deepEqual(resolveDialect({ method: '' }), { dialect: 'v1', op: '' });
    });

    // The server has no resubscribe handler, so both of its wire names keep
    // today's answer: the default, which `handle` reports as method-not-found.
    it('resubscribe has no branch and falls to the default in both dialects', () => {
        assert.deepEqual(resolveDialect({ method: 'SubscribeToTask' }), { dialect: 'v1', op: '' });
        assert.deepEqual(resolveDialect({ method: 'tasks/resubscribe' }), { dialect: 'v1', op: '' });
    });
});

describe('a2a-dialect: partText', () => {
    it('reads a v1 text part and a legacy kind-tagged one', () => {
        assert.equal(partText({ part: { text: 'hello' } }), 'hello');
        assert.equal(partText({ part: { kind: 'text', text: 'legacy' } }), 'legacy');
    });

    it('falls back to content.text, then to a JSON data part', () => {
        assert.equal(partText({ part: { content: { text: 'nested' } } }), 'nested');
        assert.equal(partText({ part: { kind: 'data', data: { a: 1 } } }), '{"a":1}');
        assert.equal(partText({ part: { kind: 'data' } }), 'null');
    });

    it('a non-object or unreadable part is empty', () => {
        assert.equal(partText({ part: null }), '');
        assert.equal(partText({ part: 'plain string' }), '');
        assert.equal(partText({ part: 42 }), '');
        assert.equal(partText({ part: {} }), '');
        /** @type {any} */
        const cyclic = { kind: 'data', data: {} };
        cyclic.data.self = cyclic;
        assert.equal(partText({ part: cyclic }), '');
    });

    it('joins every readable part with a newline', () => {
        const message = { parts: [{ text: 'a' }, { content: { text: 'b' } }, { kind: 'data', data: 1 }, {}] };
        assert.equal(messageText({ message }), 'a\nb\n1');
        assert.equal(messageText({ message: {} }), '');
        assert.equal(messageText({ message: null }), '');
    });
});

describe('a2a-dialect: task state spellings', () => {
    for (const [canonical, legacy] of Object.entries(LEGACY_SPELLINGS)) {
        it(`${canonical} round-trips through its v0.3 spelling`, () => {
            assert.equal(legacyState({ state: canonical }), legacy);
            assert.equal(canonicalState({ rawState: legacy }), canonical);
        });
    }

    it('accepts every alias a peer may send', () => {
        assert.equal(canonicalState({ rawState: 'cancelled' }), A2A_TASK_STATES.CANCELED);
        assert.equal(canonicalState({ rawState: 'input_required' }), A2A_TASK_STATES.INPUT_REQUIRED);
        assert.equal(canonicalState({ rawState: 'auth_required' }), A2A_TASK_STATES.AUTH_REQUIRED);
    });

    it('an unknown state passes through unchanged', () => {
        assert.equal(canonicalState({ rawState: 'TASK_STATE_FUTURE' }), 'TASK_STATE_FUTURE');
        assert.equal(legacyState({ state: 'TASK_STATE_FUTURE' }), 'TASK_STATE_FUTURE');
    });
});

describe('a2a-dialect: JSON-RPC envelopes', () => {
    it('rpcResult is { jsonrpc, id, result } in that order', () => {
        const envelope = rpcResult({ id: 7, result: { task: { id: 't1' } } });
        assert.deepEqual(Object.keys(envelope), ['jsonrpc', 'id', 'result']);
        assert.equal(envelope.jsonrpc, '2.0');
        assert.equal(envelope.id, 7);
        assert.deepEqual(envelope.result, { task: { id: 't1' } });
    });

    it('rpcError is { jsonrpc, id, error: { code, message } } in that order', () => {
        const envelope = rpcError({ id: null, code: -32601, message: 'Not found' });
        assert.deepEqual(Object.keys(envelope), ['jsonrpc', 'id', 'error']);
        assert.equal(envelope.jsonrpc, '2.0');
        assert.equal(envelope.id, null);
        assert.deepEqual(Object.keys(envelope.error), ['code', 'message']);
        assert.deepEqual(envelope.error, { code: -32601, message: 'Not found' });
    });
});

describe('fs-store: readStoredJsonSync', () => {
    it('reports missing, corrupt and ok', () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-a2a-dialect-'));
        try {
            const file = join(dir, 'task.json');
            assert.deepEqual(readStoredJsonSync({ filePath: file }), { status: 'missing' });

            writeFileSync(file, '{"version":1,"task":{"taskId":"a"}}', 'utf8');
            assert.deepEqual(readStoredJsonSync({ filePath: file }), { status: 'ok', value: { version: 1, task: { taskId: 'a' } } });

            writeFileSync(file, '{not json at all', 'utf8');
            const bad = readStoredJsonSync({ filePath: file });
            assert.equal(bad.status, 'corrupt');
            assert.equal(bad.kind, 'parse');
            assert.ok(bad.reason, 'a parse failure carries a reason');
            assert.equal(bad.value, undefined);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
