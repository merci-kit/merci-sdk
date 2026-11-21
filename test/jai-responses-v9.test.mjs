// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { SSEParser } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { jaiAdapter } from '../lib/backends/adapters/jai-adapter.mjs';
import { ChatSession as JaiSession } from '../lib/backends/jai.mjs';
import { ChatSession as JaiVendorSession } from '../lib/backends/jai-vendor/chat-session.mjs';
import { normalizeHistory, createAssistantMessage, createUserMessage, attachNative, getNative } from '../lib/messaging/messages.mjs';
import { ProviderType, ProtocolType, EVENTS } from '../lib/core/constants/index.mjs';

const JAI = ProviderType.JAI;

// ── Probe-captured wire events ──────────────────────────────────────────────
const CONTENT = { type: 'Content', event_type: 'data', content: 'OK', choiceIndex: 0 };
const TOOL_FIRST = { type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: 'fc_1', name: 'get_weather' };

/** @param {string} c */
/** @param {{c: *}} arg0 */
const TOOL_FRAG = ({ c }) => ({ type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: null, name: null, content: c });
const FINISH_TOOL = { type: 'FinishMetadata', event_type: 'data', reason: 'tool_call' };
const FINISH_STOP = { type: 'FinishMetadata', event_type: 'data', reason: 'stop' };
const REASONING = { type: 'ReasoningData', event_type: 'data', id: 'rs_1', encryptedContent: 'gAAAA-enc' };
const QUOTA = { type: 'QuotaMetadata', event_type: 'data', updated: {}, spent: { amount: '1.0' } };


/** @param {{events: *}} arg0 */
async function* feed({ events }) {
    for (const e of events) yield `data: ${JSON.stringify(e)}\n`;
    yield 'data: end\n';
}


/** @param {{stream: *, parser: *}} arg0 */
async function collectEvents({ stream, parser }) {
    const { readSSELines } = await import('../lib/backends/jai-vendor/sse-parser.mjs');
    const out = [];
    for await (const e of readSSELines({ stream, parser })) out.push(e);
    return out;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

describe('SSEParser (responses protocol)', () => {
    it('maps Content to text with choiceIndex and no thoughtSignature', async () => {
        const events = await collectEvents({ stream: feed({ events: [CONTENT, FINISH_STOP] }), parser: new SSEParser({ protocol: ProtocolType.RESPONSES }) });
        const text = events.find((e) => e.type === 'text');
        assert.ok(text);
        assert.equal(text.content, 'OK');
        assert.equal(text.choiceIndex, 0);
        assert.equal(text.thoughtSignature, undefined, 'responses Content carries no signature');
    });

    it('assembles tool-call fragments and finalizes on FinishMetadata(tool_call)', async () => {
        const parser = new SSEParser({ protocol: ProtocolType.RESPONSES });
        const events = await collectEvents({ stream: feed({ events: [
            TOOL_FIRST, TOOL_FRAG({ c: '{"' }), TOOL_FRAG({ c: 'city' }), TOOL_FRAG({ c: '":"' }), TOOL_FRAG({ c: 'Paris' }), TOOL_FRAG({ c: '"}' }),
            FINISH_TOOL,
        ] }), parser });
        const deltas = events.filter((e) => e.type === 'tool_call_delta');
        assert.equal(deltas.length, 6, 'every fragment is surfaced');
        assert.equal(deltas[0].id, 'fc_1');
        assert.equal(deltas[0].name, 'get_weather');
        const { toolCalls, thoughtSignature } =  (parser.getFinalResult());
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].id, 'fc_1');
        assert.equal(toolCalls[0].name, 'get_weather');
        assert.equal(toolCalls[0].arguments, '{"city":"Paris"}');
        assert.equal(thoughtSignature, null);
    });

    it('does not duplicate a finalized call re-sent after FinishMetadata (malformed stream)', async () => {
        const parser = new SSEParser({ protocol: ProtocolType.RESPONSES });
        await collectEvents({ stream: feed({ events: [
            TOOL_FIRST, TOOL_FRAG({ c: '{"city":"Paris"}' }), FINISH_TOOL,
            { type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: 'fc_1', name: 'get_weather', content: '{"city":"Paris"}' },
        ] }), parser });
        const { toolCalls } =  (parser.getFinalResult());
        assert.equal(toolCalls.length, 1, 'the post-finish duplicate is not swept in');
    });

    it('maps ReasoningData to a replayable snake_case reasoning_item', async () => {
        const events = await collectEvents({ stream: feed({ events: [CONTENT, REASONING, FINISH_STOP] }), parser: new SSEParser({ protocol: ProtocolType.RESPONSES }) });
        const item = /** @type {any} */ (events.find((e) => e.type === 'reasoning_item'));
        assert.ok(item, 'ReasoningData must surface as reasoning_item on responses');
        assert.equal(item.item.type, 'reasoning_message');
        assert.equal(item.item.id, 'rs_1');
        assert.equal(item.item.encrypted_content, 'gAAAA-enc', 'request-side spelling is snake_case (probed live)');
        assert.equal(item.item.role, undefined, 'a role field 400s the gateway (probed live)');
        assert.equal(item.content, undefined, 'no summary text on this capture');
    });

    it('passes summary text through as content (display + replay)', async () => {
        const withSummary = { ...REASONING, summary: [{ type: 'summary_text', text: 'multiply' }], status: 'completed' };
        const events = await collectEvents({ stream: feed({ events: [withSummary, FINISH_STOP] }), parser: new SSEParser({ protocol: ProtocolType.RESPONSES }) });
        const item = /** @type {any} */ (events.find((e) => e.type === 'reasoning_item'));
        assert.deepEqual(item.item.summary, [{ type: 'summary_text', text: 'multiply' }]);
        assert.equal(item.item.status, 'completed');
        assert.equal(item.content, 'multiply');
    });

    it('keeps the legacy reasoning event on the chat protocol (no responses leakage)', async () => {
        const events = await collectEvents({ stream: feed({ events: [REASONING, FINISH_STOP] }), parser: new SSEParser({ protocol: ProtocolType.CHAT }) });
        assert.ok(events.some((e) => e.type === 'reasoning' && e.data?.id === 'rs_1'));
        assert.ok(!events.some((e) => e.type === 'reasoning_item'));
    });

    it('surfaces quota and unknown events identically to chat', async () => {
        const events = await collectEvents({ stream: feed({ events: [QUOTA, { type: 'MysteryMetadata', event_type: 'data' }, FINISH_STOP] }), parser: new SSEParser({ protocol: ProtocolType.RESPONSES }) });
        assert.ok(events.some((e) => e.type === 'quota'));
        assert.ok(events.some((e) => e.type === 'unknown'));
        assert.ok(events.some((e) => e.type === 'finish' && e.reason === 'stop'));
    });
});

// ─── Adapter ────────────────────────────────────────────────────────────────

describe('jaiAdapter.consumeStream (responses)', () => {
    it('forwards reasoning_item and surfaces summary text as thought', async () => {
        
        /** @type {Array<any>} */
                const raw = [
            { type: 'reasoning_item', item: { type: 'reasoning_message', id: 'rs_1', encrypted_content: 'enc' }, content: 'why' },
            { type: 'text', content: 'OK' },
        ];
        const out = [];
        for await (const e of ( (jaiAdapter)).consumeStream({ rawStream:  (raw) })) out.push(e);
        const thought = out.find((e) => e.type === 'thought');
        assert.equal(thought.content, 'why');
        const item = out.find((e) => e.type === 'reasoning_item');
        assert.equal(item.item.encrypted_content, 'enc');
    });
});

// ─── Request body ───────────────────────────────────────────────────────────


/** @param {{configure: *}} arg0 */
async function captureBody({ configure }) {
    const captured = { path:  (null), body:  (null) };
    const httpClient = {
        streamTimeout: 1000,
        getEventEmitter: () => new EventEmitter(),
        /** @param {{path: *, options: *}} arg0 */
        _fetchWithRetry: async ({ path, options }) => {
            captured.path = path;
            captured.body = JSON.parse(options.body);
            return { body: new ReadableStream({ start(c) { c.close(); } }) };
        },
    };
    const session = new JaiVendorSession({ httpClient: /** @type {any} */ (httpClient), profile: 'openai-gpt-5-4', profileManager: null });
    configure({ s: session });
    for await (const _e of session.stream({ initialInput: [createUserMessage({ provider: JAI, content: 'hi' })] })) { /* drain */ }
    return captured;
}

describe('JAI responses request body', () => {
    it('posts to the responses endpoint with native system + user rows', async () => {
        /** @param {{s: *}} arg0 */
        const { path, body } = await captureBody({ configure: /** @type {(...args: any[]) => any} */ (({ s }) => {
            s.withProtocol({ protocol: 'responses' });
            s._parameters = { reasoningSummary: 'auto' };
        }) });
        assert.equal(path, '/llm/responses/stream/v9');
        assert.equal(/** @type {any} */ (body).parameters.reasoningSummary, 'auto');
        assert.equal(/** @type {any} */ (body).chat.messages[0].type, 'user_message');
    });

    it('never sends the responses parameter on the chat protocol (buildParametersV9 gate)', () => {
        const emitter = new EventEmitter();
        
        /** @type {Array<any>} */
        const warnings = [];
        emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (e) => warnings.push(e));
        const chat = new JaiSession({
            httpClient: /** @type {any} */ ({
                streamTimeout: 1000,
                getEventEmitter: () => emitter,
                _fetchWithRetry: async () => ({ body: new ReadableStream({ start(c) { c.close(); } }) }),
            }),
            profile: 'm',
            eventEmitter: emitter,
            profileManager: /** @type {any} */ (null),
        });
        chat.withParameters({ params: /** @type {(...args: any[]) => any} */ ((b) => b.reasoningSummary({ v: 'auto' })) });
        assert.equal(chat._parameters?.reasoningSummary, undefined, 'chat must not carry reasoningSummary');
        assert.ok(warnings.some((w) => w.parameter === 'reasoningSummary'), 'a warning names the dropped parameter under its public name');
    });

    it('keeps the responses parameter on a responses session', () => {
        const emitter = new EventEmitter();
        const session = new JaiSession({
            httpClient: /** @type {any} */ ({
                streamTimeout: 1000,
                getEventEmitter: () => emitter,
                _fetchWithRetry: async () => ({ body: new ReadableStream({ start(c) { c.close(); } }) }),
            }),
            profile: 'm',
            eventEmitter: emitter,
            profileManager: /** @type {any} */ (null),
            protocol: 'responses',
        });
        session.withParameters({ params: /** @type {(...args: any[]) => any} */ (( b) => b.reasoningSummary({ v: 'auto' })) });
        assert.equal(session._parameters?.reasoningSummary, 'auto');
    });
});

// ─── Replay ─────────────────────────────────────────────────────────────────

describe('JAI responses reasoning replay', () => {
    const nativeItem = { type: 'reasoning_message', id: 'rs_1', encrypted_content: 'gAAAA-enc' };
    const historyWithSidecar = () => {
        const row = createAssistantMessage({ provider: JAI, content: 'the answer' });
        attachNative({ row, provider: JAI, protocol: 'responses', items: [nativeItem] });
        return [createUserMessage({ provider: JAI, content: 'go' }), row];
    };

    it('emits a reasoning_message row ahead of the assistant turn (responses)', () => {
        const rows =  (normalizeHistory({ provider: JAI, messages: historyWithSidecar(), options: { protocol: 'responses' } }));
        const types = rows.map((r) => r.type);
        assert.deepEqual(types, ['user_message', 'reasoning_message', 'assistant_message_text']);
        assert.equal(rows[1].id, 'rs_1');
        assert.equal(rows[1].encrypted_content, 'gAAAA-enc');
        for (const r of rows) {
            assert.equal(getNative({ row: r }), null, 'the sidecar must never reach the wire');
        }
    });

    it('does not replay the responses sidecar on the chat protocol', () => {
        const rows =  (normalizeHistory({ provider: JAI, messages: historyWithSidecar(), options: { protocol: 'chat' } }));
        assert.ok(!rows.some((r) => r.type === 'reasoning_message'));
        for (const r of rows) assert.equal(getNative({ row: r }), null);
    });

    it('rejects a foreign-backend sidecar', () => {
        const row = createAssistantMessage({ provider: JAI, content: 'answer' });
        attachNative({ row, provider: ProviderType.OPENAI, protocol: 'responses', items: [nativeItem] });
        const rows =  (normalizeHistory({ provider: JAI, messages: [row], options: { protocol: 'responses' } }));
        assert.ok(!rows.some((r) => r.type === 'reasoning_message'));
    });

    it('concatenates sidecars when consecutive assistant rows merge', () => {
        const emitter = new EventEmitter();
        const session = new JaiSession({
            httpClient: /** @type {any} */ ({
                streamTimeout: 1000,
                getEventEmitter: () => emitter,
                _fetchWithRetry: async () => ({ body: new ReadableStream({ start(c) { c.close(); } }) }),
            }),
            profile: 'm',
            eventEmitter: emitter,
            profileManager: /** @type {any} */ (null),
            protocol: 'responses',
        });

        const a = createAssistantMessage({ provider: JAI, content: 'first' });
        attachNative({ row: a, provider: JAI, protocol: 'responses', items: [{ type: 'reasoning_message', id: 'rs_A', encrypted_content: 'encA' }] });
        const b = createAssistantMessage({ provider: JAI, content: 'second' });
        attachNative({ row: b, provider: JAI, protocol: 'responses', items: [{ type: 'reasoning_message', id: 'rs_B', encrypted_content: 'encB' }] });

        const merged = session._normalizeMessageSequence({ messages: [a, b] });
        assert.equal(merged[0].type, 'assistant_message_text', 'consecutive assistant text rows merge');
        assert.equal(merged[0].content, 'first\n\nsecond');
        const native = getNative({ row: merged[0] });
        assert.deepEqual( (/** @type {any} */ (native)).items.map((/** @type {any} */ i) => i.id), ['rs_A', 'rs_B']);
    });

    it('allowlists replay fields — role/unknown keys are dropped, missing id drops the item', () => {
        const row = createAssistantMessage({ provider: JAI, content: 'answer' });
        attachNative({ row, provider: JAI, protocol: 'responses', items: /** @type {Array<import('../lib/messaging/messages.mjs').MessageRow>} */ ([
            { type: 'reasoning_message', id: 'rs_2', encrypted_content: 'enc', role: 'assistant', junk: 'x' },
            { type: 'reasoning_message', encrypted_content: 'no-id' },
            { type: 'function_call', id: 'forged', name: 'nope' },
        ]) });
        const rows =  (normalizeHistory({ provider: JAI, messages: [row], options: { protocol: 'responses' } }));
        const replay = rows.filter((r) => r.type === 'reasoning_message');
        assert.equal(replay.length, 1, 'only the valid item replays');
        const first = /** @type {Record<string, any>} */ (replay[0]);
        assert.equal(first.role, undefined, 'a role field 400s the gateway (probed live)');
        assert.equal(first.junk, undefined);
        assert.equal(first.encrypted_content, 'enc');
    });
});