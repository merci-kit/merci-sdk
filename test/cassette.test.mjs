// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCassette, cassetteKey } from '../lib/support/cassette.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { NoRetryPolicy } from '../lib/support/retry-policy.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { RunContext } from '../lib/core/events.mjs';

// 0.8.0 item H: record a run's vendor calls once, replay them without the vendor.

/**
 * A fake provider: round 1 calls `lookup`, round 2 answers with what the tool said.
 * `consumeStream` normalizes a raw "vendor" chunk list, as a real adapter does.
 * @param {{onCall?: () => void}} [arg0]
 */
function fakeAdapter({ onCall = () => {} } = {}) {
    return {
        vendorName: 'FAKE',
        buildVendorRequest: (/** @type {any} */ { model, preparedMessages }) => ({ request: { model, messages: preparedMessages, runContext: new RunContext() }, observability: { model } }),
        executeVendorRequest: async (/** @type {any} */ { request }) => {
            onCall();
            const tool = request.messages.find((/** @type {any} */ m) => m.role === 'tool');
            return tool ? [{ kind: 'text', text: `the answer is ${tool.content}` }, { kind: 'usage', in: 9, out: 2 }]
                : [{ kind: 'call', id: 'c1', name: 'lookup' }];
        },
        consumeStream: (/** @type {any} */ { rawStream }) => (async function* () {
            for (const chunk of rawStream) {
                if (chunk.kind === 'text') yield { type: 'text', content: chunk.text };
                if (chunk.kind === 'usage') yield { type: 'quota', data: { prompt_tokens: chunk.in, completion_tokens: chunk.out } };
                if (chunk.kind === 'call') yield { type: 'tool_calls', calls: [{ id: chunk.id, name: chunk.name, args: {} }] };
            }
        })(),
        formatToolCall: (/** @type {any} */ { call }) => call,
    };
}

/** @param {{adapter: any}} arg0 */
function session({ adapter }) {
    const s = /** @type {any} */ (new AbstractChatSession({ provider: ProviderType.OPENAI, model: 'm', eventEmitter: new EventEmitter(), client: /** @type {any} */ ({ session() {} }), retryPolicy: new NoRetryPolicy() }));
    s._streamTimeoutPolicy = {};
    s._adapter = adapter;
    /** @type {string[]} */
    const toolRuns = [];
    s.withTools({ tools: [{ name: 'lookup', description: 'l', parameters: { type: 'object', properties: {} }, execute: async () => { toolRuns.push('lookup'); return '42'; } }] });
    return { s, toolRuns };
}

/** @param {{s: any}} arg0 */
async function runAndCollect({ s }) {
    /** @type {any[]} */
    const events = [];
    const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'what is it?' }], opts: { onEvent: (/** @type {any} */ e) => events.push({ type: e.type, content: e.content, data: e.data, calls: e.calls }) } });
    return { out, events };
}

test('H: a replay reproduces the recorded run — output and events — without calling the vendor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-cassette-'));
    try {
        const path = join(dir, 'run.cassette.json');
        let liveCalls = 0;
        const recording = session({ adapter: fakeAdapter({ onCall: () => { liveCalls += 1; } }) });
        recording.s.withCassette({ cassette: createCassette({ path }), mode: 'record' });
        const recorded = await runAndCollect({ s: recording.s });
        assert.equal(recorded.out, 'the answer is 42');
        assert.equal(liveCalls, 2);

        // A new process: a fresh cassette object on the same file, and a vendor that must not be called.
        const replaying = session({ adapter: fakeAdapter({ onCall: () => { throw new Error('the vendor was called during replay'); } }) });
        replaying.s.withCassette({ cassette: createCassette({ path }), mode: 'replay' });
        const replayed = await runAndCollect({ s: replaying.s });
        assert.equal(replayed.out, recorded.out);
        assert.deepEqual(replayed.events, recorded.events, 'the same events, in the same order');
        assert.deepEqual(replaying.toolRuns, ['lookup'], 'tools still run on replay');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('H: a request with no recording fails without a retry; an unreadable cassette is refused', async () => {
    const s = session({ adapter: fakeAdapter({ onCall: () => { throw new Error('vendor called'); } }) }).s;
    s.withCassette({ cassette: createCassette(), mode: 'replay' });
    await assert.rejects(() => runAndCollect({ s }), (/** @type {any} */ err) => err instanceof ConfigurationError && /** @type {any} */ (err).nonRetryable === true && /no recording/.test(err.message));

    const dir = mkdtempSync(join(tmpdir(), 'merci-cassette-'));
    try {
        const path = join(dir, 'broken.json');
        writeFileSync(path, '{ not json');
        const broken = session({ adapter: fakeAdapter() }).s;
        broken.withCassette({ cassette: createCassette({ path }), mode: 'record' });
        await assert.rejects(() => runAndCollect({ s: broken }), /unreadable/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    assert.throws(() => session({ adapter: fakeAdapter() }).s.withCassette({ cassette: createCassette(), mode: 'live' }), ConfigurationError);
});

test('H: identical requests replay in recorded order; a broken stream is never recorded', async () => {
    const cassette = createCassette();
    let n = 0;
    const live = cassette.wrap({ mode: 'record', adapter: {
        executeVendorRequest: async () => { n += 1; return n; },
        consumeStream: (/** @type {any} */ { rawStream }) => (async function* () {
            if (rawStream === 3) { yield { type: 'text', content: 'partial' }; throw new Error('cut'); }
            yield { type: 'text', content: `answer ${rawStream}` };
        })(),
    } });
    /** @param {any} adapter */
    const drain = async (adapter) => {
        const out = [];
        const raw = await adapter.executeVendorRequest({ request: { q: 1 } });
        for await (const e of adapter.consumeStream({ rawStream: raw })) out.push(/** @type {any} */ (e).content);
        return out;
    };
    assert.deepEqual(await drain(live), ['answer 1']);
    assert.deepEqual(await drain(live), ['answer 2']);
    await assert.rejects(() => drain(live), /cut/);
    const replay = cassette.wrap({ mode: 'replay', adapter: { executeVendorRequest: async () => { throw new Error('no'); }, consumeStream: () => (async function* () {})() } });
    assert.deepEqual([await drain(replay), await drain(replay), await drain(replay)], [['answer 1'], ['answer 2'], ['answer 2']], 'in order, the last repeats, the broken one is absent');
});

test('H: the key is the request data — a run context or a row id riding on it does not change it', () => {
    assert.equal(cassetteKey({ request: { messages: [{ role: 'user', content: 'x', merciId: 'a' }] } }), cassetteKey({ request: { messages: [{ role: 'user', content: 'x', merciId: 'b' }] } }));
    const base = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
    assert.equal(cassetteKey({ request: { ...base, runContext: new RunContext() } }), cassetteKey({ request: { messages: base.messages, model: 'm', runContext: new RunContext() } }));
    assert.notEqual(cassetteKey({ request: base }), cassetteKey({ request: { ...base, model: 'n' } }));
});

test('H review: concurrent first recordings to one file all survive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-cassette-'));
    try {
        const path = join(dir, 'c.json');
        const cassette = createCassette({ path });
        /** @param {number} i */
        const adapterFor = (i) => cassette.wrap({ mode: 'record', adapter: {
            executeVendorRequest: async (/** @type {any} */ _args) => i,
            consumeStream: (/** @type {any} */ { rawStream }) => (async function* () { yield { type: 'text', content: `answer ${rawStream}` }; })(),
        } });
        await Promise.all([0, 1, 2, 3].map(async (i) => {
            const adapter = adapterFor(i);
            const raw = await adapter.executeVendorRequest({ request: { q: i } });
            for await (const _ of adapter.consumeStream({ rawStream: raw })) { /* drain */ }
        }));
        const { readFileSync } = await import('node:fs');
        assert.equal(Object.keys(JSON.parse(readFileSync(path, 'utf8')).entries).length, 4, 'every recording reached the file');
        assert.equal(await cassette.size(), 4);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('H review: an SDK-minted tool-call id does not change the key; record mode hands the session the raw stream', async () => {
    const a = { messages: [{ role: 'assistant', tool_calls: [{ id: 'call_11111111-2222-4333-8444-555555555555' }] }, { role: 'tool', tool_call_id: 'call_11111111-2222-4333-8444-555555555555' }] };
    const b = { messages: [{ role: 'assistant', tool_calls: [{ id: 'call_99999999-8888-4777-8666-555555555555' }] }, { role: 'tool', tool_call_id: 'call_99999999-8888-4777-8666-555555555555' }] };
    assert.equal(cassetteKey({ request: a }), cassetteKey({ request: b }));
    const two = { messages: [{ id: 'call_11111111-2222-4333-8444-555555555555' }, { id: 'call_99999999-8888-4777-8666-555555555555' }] };
    const same = { messages: [{ id: 'call_99999999-8888-4777-8666-555555555555' }, { id: 'call_99999999-8888-4777-8666-555555555555' }] };
    assert.notEqual(cassetteKey({ request: two }), cassetteKey({ request: same }), 'distinct ids stay distinct');

    const raw = { vendor: 'chunks' };
    const wrapped = createCassette().wrap({ mode: 'record', adapter: { executeVendorRequest: async (/** @type {any} */ _args) => raw, consumeStream: () => (async function* () {})() } });
    assert.equal(await wrapped.executeVendorRequest({ request: {} }), raw, 'the inactivity timeout wraps the vendor stream, not the events');
});

// ─── the scripted test double ──────────────────────────────────────────────

/** @param {{stream: AsyncIterable<unknown>}} arg0 @returns {Promise<any[]>} */
async function collect({ stream }) {
    const out = [];
    for await (const event of stream) out.push(event);
    return out;
}

test('a scripted cassette replays hand-written events and never calls the vendor', async () => {
    const script = [
        [{ type: 'tool_calls', calls: [{ id: 'c1', name: 'lookup', args: {} }] }],
        [{ type: 'text', content: 'scripted answer' }, { type: 'quota', data: { prompt_tokens: 1, completion_tokens: 1 } }],
    ];
    const cassette = createCassette({ script });
    assert.equal(await cassette.size(), 2);
    const s = session({ adapter: fakeAdapter({ onCall: () => { throw new Error('the vendor was called'); } }) });
    s.s.withCassette({ cassette, mode: 'replay' });

    const { out, events } = await runAndCollect({ s: s.s });
    assert.equal(out, 'scripted answer');
    assert.deepEqual(s.toolRuns, ['lookup'], 'a replayed turn still runs its tools');
    assert.equal(events.some((e) => e.type === 'text' && e.content === 'scripted answer'), true);
});

test('a scripted cassette repeats its last entry and needs no request key', async () => {
    const cassette = createCassette({ script: [[{ type: 'text', content: 'first' }], [{ type: 'text', content: 'second' }]] });
    const wrapped = cassette.wrap({ mode: 'replay', adapter: fakeAdapter() });
    const one = await collect({ stream: /** @type {any} */ (await wrapped.executeVendorRequest({ request: { anything: 1 } })) });
    const two = await collect({ stream: /** @type {any} */ (await wrapped.executeVendorRequest({ request: { anything: 2 } })) });
    const three = await collect({ stream: /** @type {any} */ (await wrapped.executeVendorRequest({ request: { anything: 3 } })) });
    assert.equal(one[0].content, 'first');
    assert.equal(two[0].content, 'second');
    assert.equal(three[0].content, 'second', 'the last entry repeats');
});

test('an empty script answers with the non-retryable missing-recording error', async () => {
    const cassette = createCassette({ script: [] });
    assert.equal(await cassette.size(), 0);
    const wrapped = cassette.wrap({ mode: 'replay', adapter: fakeAdapter() });
    await assert.rejects(
        () => wrapped.executeVendorRequest({ request: {} }),
        (/** @type {any} */ err) => err instanceof ConfigurationError && /** @type {any} */ (err).nonRetryable === true && /no recording/.test(err.message)
    );
});

test('a scripted cassette is replay-only and exclusive with a path', () => {
    assert.throws(() => createCassette({ path: 'x.json', script: [] }), ConfigurationError);
    assert.throws(() => createCassette({ script: /** @type {any} */ ('not-an-array') }), ConfigurationError);
    assert.throws(() => createCassette({ script: /** @type {any} */ ([{}]) }), ConfigurationError);
    const cassette = createCassette({ script: [] });
    assert.throws(() => cassette.wrap({ mode: 'record', adapter: fakeAdapter() }), /replay-only/);
});
