// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    TRANSFER_MARKER_LABEL,
    normalizeTransfer,
    renderTransfer,
} from '../lib/agentic/transfer.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';
import { createUserMessage, createAssistantMessage } from '../lib/messaging/messages.mjs';

const B = 'openai';

/** @param {string} id @param {string} text */
function unit(id, text) {
    return {
        id,
        output: text,
        provider: B,
        messages: [
            createUserMessage({ provider: B, content: `do ${id}` }),
            createAssistantMessage({ provider: B, content: text }),
        ],
    };
}

test('normalizeTransfer: resolves presets and applies overrides', () => {
    assert.deepEqual(
        normalizeTransfer({ transfer: 'stringify' }),
        { mode: 'stringify', select: 'all', compact: false, tail: LIMITS.transfer_tail_rows, summarize: null, markerLabel: TRANSFER_MARKER_LABEL },
    );
    const sel = normalizeTransfer({ transfer: 'ledger-selected-compact' });
    assert.equal(sel.mode, 'ledger');
    assert.equal(sel.select, 'tail');
    assert.equal(sel.compact, true);

    const over = normalizeTransfer({ transfer: { preset: 'ledger-selected', tail: 3, markerLabel: 'X' } });
    assert.equal(over.mode, 'ledger');
    assert.equal(over.select, 'tail');
    assert.equal(over.tail, 3);
    assert.equal(over.markerLabel, 'X');
});

test('normalizeTransfer: fails loud on unknown preset / mode / select', () => {
    assert.throws(() => normalizeTransfer({ transfer: 'nope' }), /Unknown transfer preset/);
    assert.throws(() => normalizeTransfer({ transfer: { preset: 'nope' } }), /Unknown transfer preset/);
    assert.throws(() => normalizeTransfer({ transfer: /** @type {any} */ ({ mode: 'telepathy' }) }), /transfer\.mode/);
    assert.throws(() => normalizeTransfer({ transfer: /** @type {any} */ ({ select: 'sorted' }) }), /transfer\.select/);
});

test('stringify: renders framed text per unit, no rows', async () => {
    const out = await renderTransfer({ units: [unit('a', 'alpha'), unit('b', 'beta')], transfer: 'stringify' });
    assert.equal(out.rows.length, 0);
    assert.equal(out.text.includes('[Output from Step "a"]: \nalpha'), true);
    assert.equal(out.text.includes('[Output from Step "b"]: \nbeta'), true);
});

test('ledger: same-backend rows replay verbatim with roles preserved', async () => {
    const u = unit('a', 'alpha');
    const out = await renderTransfer({ units: [u], transfer: 'ledger', targetProvider: B });
    assert.equal(out.dropped, 0);
    assert.equal(out.degraded, 0);
    assert.deepEqual(out.rows, u.messages);
    assert.equal(out.rows[1].role, 'assistant');
});

test('ledger: foreign backend degrades the unit to a user digest row', async () => {
    const foreign = { ...unit('a', 'alpha'), provider: 'anthropic' };
    const out = await renderTransfer({ units: [foreign], transfer: 'ledger', targetProvider: B });
    assert.equal(out.degraded, 1);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].role, 'user');
    assert.equal(String(out.rows[0].content ?? '').includes('alpha'), true);
});

test('ledger: a dangling tool-result start degrades instead of replaying', async () => {
    const dangling = {
        id: 'a',
        provider: B,
        messages: [/** @type {any} */ ({ role: 'tool', content: 'orphan result' })],
    };
    const out = await renderTransfer({ units: [dangling], transfer: 'ledger', targetProvider: B });
    assert.equal(out.degraded, 1);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].role, 'user');
});

test('ledger-selected: drops the prefix to a visible marker', async () => {
    const units = ['a', 'b', 'c', 'd', 'e'].map((id) => unit(id, id));
    const out = await renderTransfer({ units, transfer: { preset: 'ledger-selected', tail: 2 }, targetProvider: B });
    assert.equal(out.dropped, 3);
    assert.equal(out.summarized, false);
    assert.equal(out.rows[0].role, 'user');
    assert.equal(String(out.rows[0].content).includes('6 earlier entries omitted'), true);
    // tail = the last two units, in order
    assert.equal(String(out.rows.at(-1)?.content), 'e');
    assert.equal(String(out.rows.at(-3)?.content), 'd');
});

test('ledger-selected-compact: summarizes the dropped prefix when a summarizer is provided', async () => {
    const units = ['a', 'b', 'c', 'd'].map((id) => unit(id, id));
    const out = await renderTransfer({
        units,
        transfer: { preset: 'ledger-selected-compact', tail: 1 },
        targetProvider: B,
        summarize: () => 'SUM',
    });
    assert.equal(out.dropped, 3);
    assert.equal(out.summarized, true);
    assert.equal(String(out.rows[0].content), '[Earlier context omitted]\nSUM');
});

test('ledger-compact preset uses the default window', async () => {
    const units = Array.from({ length: LIMITS.transfer_tail_rows + 2 }, (_, i) => unit(`s${i}`, `t${i}`));
    const out = await renderTransfer({ units, transfer: 'ledger-compact', targetProvider: B, summarize: () => 'SUM' });
    assert.equal(out.dropped, 2);
    assert.equal(out.summarized, true);
});

test('ledger mode requires a targetProvider', async () => {
    await assert.rejects(
        () => renderTransfer({ units: [unit('a', 'alpha')], transfer: 'ledger' }),
        /targetProvider is required/,
    );
});
