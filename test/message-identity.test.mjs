// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
    createUserMessage,
    createSystemMessage,
    createAssistantMessage,
    createToolCallMessage,
    createToolResultMessage,
    normalizeToOAI,
    normalizeToAAI,
    normalizeToGAI,
    normalizeHistory,
    dedupeMessages,
} from '../lib/messaging/messages.mjs';
import { formatJaiMessages } from '../lib/backends/jai-vendor/messages.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ProviderType, MERCI_ID_KEY } from '../lib/core/constants/index.mjs';

describe('factory rows carry stable identity', () => {
    it('every factory attaches a unique merciId', () => {
        /** @type {any[]} */
        const rows = [
            createUserMessage({ provider: 'OAI', content: 'hi' }),
            createSystemMessage({ provider: 'OAI', content: 'sys' }),
            createAssistantMessage({ provider: 'OAI', content: 'a' }),
            createToolCallMessage({ provider: 'OAI', id: 'c1', name: 'f', args: '{}' }),
            createToolResultMessage({ provider: 'OAI', result: { id: 'c1', name: 'f', success: true, result: 'ok' } }),
        ];
        for (const row of rows) {
            assert.ok(typeof row[MERCI_ID_KEY] === 'string' && row[MERCI_ID_KEY].length > 0,
                'a merciId is attached');
        }
        const ids = new Set(rows.map(r => r[MERCI_ID_KEY]));
        assert.equal(ids.size, rows.length, 'ids are unique across rows');
    });

    it('the id is stable across prepare copies (same row, same id)', () => {
        const row = /** @type {Record<string, any>} */ (createUserMessage({ provider: 'OAI', content: 'hi' }));
        const copied = /** @type {Record<string, any>} */ ({ ...row, content: 'hi\n\nmore' });
        assert.equal(copied[MERCI_ID_KEY], row[MERCI_ID_KEY], 'spread copies preserve identity');
    });
});

describe('no wire leaks the identity', () => {
    const history = [
        createUserMessage({ provider: 'OAI', content: 'first' }),
        createAssistantMessage({ provider: 'OAI', content: 'answer' }),
        createUserMessage({ provider: 'OAI', content: 'second' }),
    ];

    /** @param {any} wire @returns {any} */
    /** @param {{wire: *}} arg0 */
    /** @param {{wire: *}} arg0 */
    const rowsOf = ({ wire }) => Array.isArray(wire) ? wire : (wire.messages ?? wire.contents ?? []);

    it('OAI / AAI / GAI / JAI wire outputs are id-free', () => {
        for (const normalize of /** @type {any[]} */ ([normalizeToOAI, normalizeToAAI, normalizeToGAI])) {
            const wire = normalize({ model: 'test-model', msgs: history });
            assert.ok(rowsOf({ wire }).every((/** @type {any} */ m) => !(MERCI_ID_KEY in m)),
                `${normalize.name} must strip merciId`);
        }
        const jaiWire = formatJaiMessages({ messages: history });
        assert.ok(jaiWire.every((/** @type {any} */ m) => !(MERCI_ID_KEY in m)), 'formatJaiMessages must strip merciId');
        const hist = normalizeHistory({ provider: ProviderType.JAI, messages: history });
        assert.ok(rowsOf({ wire: hist }).every((/** @type {any} */ m) => !(MERCI_ID_KEY in m)), 'normalizeHistory (JAI) must strip merciId');
    });
});

describe('dedupeMessages: replay safety', () => {
    it('removes duplicate-id rows, keeps the first occurrence', () => {
        const a = createUserMessage({ provider: 'OAI', content: 'a' });
        const b = createAssistantMessage({ provider: 'OAI', content: 'b' });
        const dup = { ...a, content: 'a-again' };
        const out = dedupeMessages({ messages: [a, b, dup, a] });
        assert.equal(out.length, 2, 'duplicates collapse to one row each');
        assert.equal(out[0], a, 'the first occurrence wins');
        assert.equal(out[1], b);
    });

    it('no-ops on unique histories (same reference)', () => {
        const history = [createUserMessage({ provider: 'OAI', content: 'a' }), createAssistantMessage({ provider: 'OAI', content: 'b' })];
        assert.equal(dedupeMessages({ messages: history }), history, 'no allocation when nothing to dedupe');
    });

    it('handles id-less rows defensively', () => {
        const history = [{ role: 'user', content: 'x' }, { role: 'user', content: 'x' }];
        assert.equal(dedupeMessages({ messages: history }), history, 'id-less rows always pass through');
    });
});

describe('runAgenticLoop dedupes on entry and after step updates', () => {
    it('a duplicated row in the input is sent to the model once', async () => {
        /** @type {any[]} */
        const stepCalls = [];
        let calls = 0;
        /** @type {any} */
        const session = {
            provider: 'OAI',
            model: 'm',
            _tools: [],
            eventEmitter: { emit: () => {} },
            /** @param {{messages: any[]}} arg0 */
            async *step({ messages }) {
                stepCalls.push(messages.map((/** @type {any} */ m) => ({ ...m })));
                calls++;
                return { done: true, content: 'answer', messages, thoughtSignature: null };
            },
        };
        const dup = createUserMessage({ provider: 'OAI', content: 'dup' });
        const history = [createUserMessage({ provider: 'OAI', content: 'first' }), { ...dup }];
        await runAgenticLoop({ session, messages: [history[0], { ...dup }], opts: { maxIterations: 3 } });
        const sent = stepCalls[0];
        assert.equal(sent.length, 2, 'one copy of each row reaches the model');
        assert.equal(sent.filter((/** @type {any} */ m) => m.content === 'dup').length, 1, 'the duplicated row is sent once');
    });
});
