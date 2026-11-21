// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { ChatSession } from '../lib/backends/jai-vendor/chat-session.mjs';
import { createUserMessage, createAssistantMessage } from '../lib/messaging/messages.mjs';
import { ProviderType, INJECTION_META_KEY, SYNTHETIC_TURN_INJECTION } from '../lib/core/constants/index.mjs';

const JAI = ProviderType.JAI;


/** @param {{history: *}} arg0 */
async function captureBody({ history }) {
    let captured = null;
    
    /** @type {any} */
        const httpClient = {
        streamTimeout: 5000,
        getEventEmitter: () => new EventEmitter(),
        /** @param {{options: *}} arg0 */
        _fetchWithRetry: async ({ options }) => {
            captured = JSON.parse(options.body);
            return { body: new ReadableStream({ start(c) { c.close(); } }) };
        },
    };
    const session = new ChatSession({ httpClient, profile: 'test-model', profileManager: null });
    for await (const _event of session.stream({ initialInput: history })) { /* drain */ }
    return captured;
}

const mixed = () => [
    { role: 'user', content: 'untyped user' },
    { role: 'assistant', content: 'untyped assistant' },
    createUserMessage({ provider: JAI, content: 'typed user' }),
    createAssistantMessage({ provider: JAI, content: 'typed assistant' }),
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: '{"ok":true}' },
    { type: 'media_message', mediaType: 'image/png', data: 'AAAA' },
    { role: 'system', content: 'SYSTEM DIRECTIVE' },
    { role: 'system', content: '[Summarized earlier conversation]\n\nfolded prefix' },
];

describe('JAI wire body: untyped role rows are normalized', () => {
    it('emits only typed JAI rows — no bare {role} row reaches the wire', async () => {
        const body = await captureBody({ history: mixed() });
        const rows = /** @type {any} */ (body).chat.messages;
        for (const m of rows) {
            assert.equal(typeof m.type, 'string', `row missing JAI type: ${JSON.stringify(m)}`);
            assert.ok(!('role' in m), `raw role row leaked to the wire: ${JSON.stringify(m)}`);
        }
    });

    it('converts an untyped assistant row to assistant_message_text', async () => {
        const body = await captureBody({ history: mixed() });
        const a = /** @type {any} */ (body).chat.messages.find(/** @type {(...args: any[]) => any} */ (( m) => m.content === 'untyped assistant'));
        assert.ok(a, 'untyped assistant content survived to the wire');
        assert.equal(a.type, 'assistant_message_text');
    });

    it('preserves typed rows and media, and keeps system rows native on the wire', async () => {
        const rows = (/** @type {any} */ (await captureBody({ history: mixed() }))).chat.messages;
        assert.ok(rows.some(/** @type {(...args: any[]) => any} */ (( m) => m.type === 'media_message')), 'media row preserved');
        assert.ok(rows.some(/** @type {(...args: any[]) => any} */ (( m) => m.type === 'tool_message')), 'tool row preserved');
        const systems = rows.filter(/** @type {(...args: any[]) => any} */ (( m) => m.type === 'system_message'));
        assert.equal(systems.length, 2, 'history system rows stay system_message rows');
        assert.ok(systems.some(/** @type {(...args: any[]) => any} */ (( m) => String(m.content).includes('SYSTEM DIRECTIVE'))));
    assert.equal(rows[0].type, 'user_message');
    assert.equal(rows[0].content, 'untyped user');
});

// ─── post-tool-round synthesis nudge reaches the wire ────────────────────────

describe('JAI wire body: the post-tool-round synthesis nudge survives', () => {
    const nudgeHistory = () => [
        createUserMessage({ provider: JAI, content: 'Delegate the research via the task tool.' }),
        { type: 'assistant_message_tool', id: 'c1', toolName: 'task', content: '{"prompt":"research"}' },
        { type: 'tool_message', id: 'c1', toolName: 'task', result: '### research findings' },
        Object.assign(createUserMessage({ provider: JAI, content: 'The tool results are in. Provide your final answer now.' }), { [INJECTION_META_KEY]: SYNTHETIC_TURN_INJECTION }),
    ];

    it('the marked nudge row reaches the wire as a user_message (marker stripped)', async () => {
        const body = await captureBody({ history: nudgeHistory() });
        const rows = /** @type {any} */ (body).chat.messages;
        const nudge = rows[rows.length - 1];
        assert.equal(nudge.type, 'user_message', `last wire row: ${JSON.stringify(nudge)}`);
        assert.ok(String(nudge.content).includes('Provide your final answer now'), 'nudge content survived');
        assert.ok(!(INJECTION_META_KEY in nudge), 'the non-wire marker never reaches the vendor');
        assert.equal(rows.length, 4, 'tool round rows + nudge, nothing dropped or merged away');
    });
});
});
