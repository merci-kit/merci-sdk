// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ChatSession } from '../lib/backends/jai-vendor/chat-session.mjs';
import { declaresParam } from '../lib/backends/jai-vendor/profiles.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { ProviderType, DEFAULT_SYSTEM_PROMPT } from '../lib/core/constants/index.mjs';

/** @param {{content: *}} arg0 */
/** @param {{content: *}} arg0 */
const jaiUser = ({ content }) => /** @type {any} */ (createUserMessage({ provider: ProviderType.JAI, content }));

const emptyStream = () => new ReadableStream({
    start(controller) { controller.close(); }
});

const buildCapture = () => {
    const captured = /** @type {{ path: any, body: any }} */ ({ path: null, body: null });
    const httpClient = {
        streamTimeout: 1000,
        /** @param {{path: *, options: *}} arg0 */
        _fetchWithRetry: async ({ path, options }) => {
            captured.path = path;
            captured.body = JSON.parse(options.body);
            return { body: emptyStream() };
        },
        getEventEmitter: () => new EventEmitter()
    };
    return { httpClient, captured };
};

/**
 * @param {any} httpClient
 * @param {any} [profileManager]
 */
/** @param {{httpClient: *, profileManager?: *}} arg0 */
/** @param {{httpClient: *, profileManager?: *}} arg0 */
const buildSession = ({ httpClient, profileManager = null }) =>
    new ChatSession({ httpClient, profile: 'jai-gpt-4o', profileManager });

// ponytail: system content is a native system_message row on the wire
/**
 * @param {any} body
 */
/** @param {{body: *}} arg0 */
/** @param {{body: *}} arg0 */
const firstUserContent = ({ body }) => {
    const msgs = body?.chat?.messages || [];
    const user = msgs.find((/** @type {any} */ m) => m.type === 'user_message');
    return user ? user.content : '';
};

/** @param {any} body @returns {string} */
/** @param {{body: *}} arg0 */
/** @param {{body: *}} arg0 */
const systemContent = ({ body }) => {
    const msgs = body?.chat?.messages || [];
    return msgs.filter((/** @type {any} */ m) => m.type === 'system_message').map((/** @type {any} */ m) => String(m.content)).join('\n');
};

/**
 * @param {any} session
 * @param {any} messages
 */
/** @param {{session: *, messages: *}} arg0 */
/** @param {{session: *, messages: *}} arg0 */
const runStream = async ({ session, messages }) => {
    const gen = session.stream({ initialInput: messages });
    for await (const _event of gen) { /* drain */ }
};

test('JAI: buildRequestBody sends directive + DEFAULT_SYSTEM_PROMPT as a system_message row', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient }).withSystemMessage('You are a careful engineer.').withSDKDescriptorMessage();
    await runStream({ session, messages: [jaiUser({ content: 'Hello.' })] });
    const sys = systemContent({ body: captured.body });
    assert.ok(sys.includes(DEFAULT_SYSTEM_PROMPT));
    assert.ok(sys.includes('You are a careful engineer.'));
    assert.equal(firstUserContent({ body: captured.body }), 'Hello.');
    assert.equal(captured.body.chat.messages.filter((/** @type {any} */ m) => m.type === 'system_message').length, 1);
});

test('JAI: buildRequestBody sends no system content by default (no SDK descriptor)', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient });
    await runStream({ session, messages: [jaiUser({ content: 'Hello.' })] });
    assert.equal(firstUserContent({ body: captured.body }), 'Hello.');
    assert.equal(systemContent({ body: captured.body }), '');
    assert.equal(captured.body.chat.messages.length, 1);
});

test('JAI: buildRequestBody emits the default SDK descriptor when opted in', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient }).withSDKDescriptorMessage();
    await runStream({ session, messages: [jaiUser({ content: 'Hello.' })] });
    assert.ok(systemContent({ body: captured.body }).includes(DEFAULT_SYSTEM_PROMPT));
    assert.equal(firstUserContent({ body: captured.body }), 'Hello.');
});

test('JAI: buildRequestBody replaces stale system with fresh context', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient }).withSystemMessage('SHOULD_REPLACE').withSDKDescriptorMessage();
    const merged = { type: 'system_message', content: 'sessionSys\n\nmemoryBlock' };
    await runStream({ session, messages: [merged, jaiUser({ content: 'Hello.' })] });
    const sys = systemContent({ body: captured.body });
    assert.ok(sys.includes(DEFAULT_SYSTEM_PROMPT));
    assert.ok(sys.includes('SHOULD_REPLACE'));
    assert.equal(sys.includes('sessionSys'), false);
    assert.equal(firstUserContent({ body: captured.body }), 'Hello.');
    assert.equal(captured.body.chat.messages.filter((/** @type {any} */ m) => m.type === 'system_message').length, 1);
});

test('JAI: buildRequestBody replaces role:system with fresh context', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient }).withSystemMessage('SHOULD_REPLACE').withSDKDescriptorMessage();
    await runStream({ session, messages: [
        { role: 'system', content: 'sessionSys\n\nmemoryBlock' },
        jaiUser({ content: 'Hello.' })
    ] });
    const sys = systemContent({ body: captured.body });
    assert.ok(sys.includes(DEFAULT_SYSTEM_PROMPT));
    assert.ok(sys.includes('SHOULD_REPLACE'));
    assert.equal(sys.includes('sessionSys'), false);
});

test('JAI: buildRequestBody replaces role:developer with fresh context', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient }).withSystemMessage('SHOULD_REPLACE').withSDKDescriptorMessage();
    await runStream({ session, messages: [
        { role: 'developer', content: 'sessionSys\n\nmemoryBlock' },
        jaiUser({ content: 'Hello.' })
    ] });
    const sys = systemContent({ body: captured.body });
    assert.ok(sys.includes(DEFAULT_SYSTEM_PROMPT));
    assert.ok(sys.includes('SHOULD_REPLACE'));
    assert.equal(sys.includes('sessionSys'), false);
});

test('JAI: buildRequestBody replaces stale system with directive', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient }).withSystemMessage('You are a careful engineer.').withSDKDescriptorMessage();
    const merged = { type: 'system_message', content: 'Stale memory content.' };
    await runStream({ session, messages: [merged, jaiUser({ content: 'Hi.' })] });
    const sys = systemContent({ body: captured.body });
    assert.ok(sys.includes(DEFAULT_SYSTEM_PROMPT));
    assert.ok(sys.includes('You are a careful engineer.'));
    assert.equal(sys.includes('Stale memory content.'), false);
    assert.equal(firstUserContent({ body: captured.body }), 'Hi.');
});

test('JAI: buildRequestBody does not mutate the input', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient }).withSystemMessage('session');
    const input = [jaiUser({ content: 'Hello.' })];
    const snapshot = JSON.parse(JSON.stringify(input));
    await runStream({ session, messages: input });
    assert.deepEqual(input, snapshot);
    assert.equal(input[0].type, 'user_message');
    assert.equal(input[0].content, 'Hello.');
});

test('JAI: buildRequestBody rebuilds fresh context (no duplicate system)', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient }).withSystemMessage('persona').withSDKDescriptorMessage();
    await runStream({ session, messages: [
        { type: 'system_message', content: 'INPUT_SYSTEM' },
        jaiUser({ content: 'Hello.' })
    ] });
    const systems = captured.body.chat.messages.filter((/** @type {any} */ m) => m.type === 'system_message');
    assert.equal(systems.length, 1, 'exactly one fresh system row');
    assert.ok(String(systems[0].content).includes(DEFAULT_SYSTEM_PROMPT));
    assert.ok(String(systems[0].content).includes('persona'));
    assert.equal(String(systems[0].content).includes('INPUT_SYSTEM'), false);
    assert.equal(firstUserContent({ body: captured.body }), 'Hello.');
});

test('JAI: buildRequestBody writes wire payload with profile and prompt', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient });
    await runStream({ session, messages: [jaiUser({ content: 'Hello.' })] });
    assert.equal(captured.path, '/llm/chat/stream/v9');
    assert.equal(captured.body.profile, 'jai-gpt-4o');
    assert.ok(captured.body.prompt?.startsWith('js-sdk-prompt-'));
    assert.ok(Array.isArray(captured.body.chat.messages));
});

test('JAI: buildRequestBody lesson-12 parallel replay (4 tool calls, native system row first)', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient }).withSDKDescriptorMessage();
    const interceptedCalls = [
        { id: 'call_0_aaa', name: 'extract_single_action_item', arguments: '{"task":"draft spec","assigned_to":"Frank","due_date":"2024-11-04","priority":"High"}' },
        { id: 'call_1_bbb', name: 'extract_single_action_item', arguments: '{"task":"branding assets","assigned_to":"Eve","due_date":"2024-11-08","priority":"Medium"}' },
        { id: 'call_2_ccc', name: 'extract_single_action_item', arguments: '{"task":"book venue","assigned_to":"David","due_date":"2024-11-15","priority":"Low"}' },
        { id: 'call_3_ddd', name: 'extract_single_action_item', arguments: '{"task":"Q3 budget","assigned_to":"Frank","due_date":"2024-11-01","priority":"High"}' }
    ];
    const messages = [jaiUser({ content: 'Analyze the notes…' })];
    for (const call of interceptedCalls) {
        messages.push({
            type: 'assistant_message_tool', id: call.id, toolName: call.name,
            content: call.arguments, thought_signature: 'sig_parallel'
        });
        messages.push({
            type: 'tool_message', id: call.id, toolName: call.name,
            result: JSON.stringify({ status: 'intercepted' })
        });
    }
    await runStream({ session, messages });

    const wire = captured.body.chat.messages;
    assert.equal(wire.length, 2 + interceptedCalls.length * 2);
    assert.equal(wire[0].type, 'system_message');
    assert.ok(String(wire[0].content).includes(DEFAULT_SYSTEM_PROMPT), 'system content rides the native row');
    assert.equal(wire[1].type, 'user_message');
    assert.equal(wire[1].content, 'Analyze the notes…');
    for (let i = 0; i < interceptedCalls.length; i++) {
        const call = interceptedCalls[i];
        const asstIdx = 2 + i * 2;
        const toolIdx = asstIdx + 1;
        assert.equal(wire[asstIdx].type, 'assistant_message_tool');
        assert.equal(wire[asstIdx].id, call.id);
        assert.equal(wire[asstIdx].thoughtSignature, 'sig_parallel');
        assert.equal(wire[asstIdx].thought_signature, undefined);
        assert.equal(wire[asstIdx].content, call.arguments);
        assert.equal(wire[toolIdx].type, 'tool_message');
        assert.equal(wire[toolIdx].id, call.id);
        assert.equal(wire[toolIdx].toolName, call.name);
        assert.equal(wire[toolIdx].thoughtSignature, undefined);
        assert.equal(wire[toolIdx].thought_signature, undefined);
        assert.equal(typeof wire[toolIdx].result, 'string');
        assert.equal(wire[toolIdx].result, JSON.stringify({ status: 'intercepted' }));
    }
});

test('JAI: buildRequestBody surfaces missing-id bug class (tool_message at index 2 now)', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient });
    await runStream({ session, messages: [
        jaiUser({ content: 'Analyze the notes…' }),
        { type: 'assistant_message_tool', id: 'call_x', toolName: 'extract', content: '{}', thought_signature: 'sig' },
        { type: 'tool_message', toolName: 'extract', result: JSON.stringify({ status: 'intercepted' }) }
    ] });
    const toolMsg = captured.body.chat.messages[2];
    assert.equal(toolMsg.id, undefined);
});

test('JAI: buildRequestBody keeps toolChoice when profile declares dotted paths only', async () => {
    const { httpClient, captured } = buildCapture();
    const profileManager = {
        getProfiles: async () => {},
        /** @param {{paramKey: *}} arg0 */
        isSupported: ({ paramKey }) => declaresParam({ params: new Set(['toolConfig.toolChoice.named', 'toolConfig.tools']), key: paramKey })
    };
    const session = buildSession({ httpClient, profileManager }).withTools({ tools: [{
        name: 'search',
        description: 'Search',
        parameters: { type: 'object', properties: {} }
    }] });
    session._parameters = { toolConfig: { toolChoice: { named: 'search' } } };
    await runStream({ session, messages: [jaiUser({ content: 'Hi.' })] });
    assert.equal(captured.body.parameters.toolConfig.toolChoice.named, 'search');
    assert.equal(captured.body.parameters.toolConfig.toolChoice.auto, undefined);
});

// ponytail: a leading media_message must not silence the system prompt — the
test('JAI: buildRequestBody keeps system content when the first message is a media_message', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient }).withSystemMessage('You are a careful engineer.').withSDKDescriptorMessage();
    await runStream({ session, messages: [
        { type: 'media_message', mediaType: 'image/png', data: 'base64...' },
        jaiUser({ content: 'Describe this image.' })
    ] });
    const msgs = captured.body.chat.messages;
    assert.equal(msgs[0].type, 'system_message', 'system is a native row ahead of the media');
    assert.ok(msgs[0].content.includes(DEFAULT_SYSTEM_PROMPT));
    assert.ok(msgs[0].content.includes('You are a careful engineer.'));
    assert.equal(msgs[1].type, 'media_message', 'media message preserved at index 1');
    assert.equal(msgs[2].type, 'user_message');
});

test('JAI: buildRequestBody splits array user content into media_message + user_message', async () => {
    const { httpClient, captured } = buildCapture();
    const session = buildSession({ httpClient }).withSystemMessage('You are a careful engineer.').withSDKDescriptorMessage();
    await runStream({ session, messages: [
        { type: 'user_message', content: [{ type: 'text', text: 'see this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
    ] });
    const msgs = captured.body.chat.messages;
    assert.equal(msgs[0].type, 'system_message');
    assert.ok(msgs[0].content.includes(DEFAULT_SYSTEM_PROMPT));
    assert.deepEqual(msgs[1], { type: 'media_message', mediaType: 'image/png', data: 'AAAA' },
        'array content is split — the gateway 400s on arrays (probed live)');
    assert.deepEqual(msgs[2], { type: 'user_message', content: 'see this' });
});
