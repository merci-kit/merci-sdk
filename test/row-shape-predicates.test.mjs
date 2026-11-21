// @ts-check

/**
 * Characterization baseline for the row-shape predicates.
 *
 * `isUserRow` / `isSystemRow` were duplicated inline in the inbox placement
 * rule, the input guardrail, the context assembly and the memory block. This
 * table pins the exact current answers so the extraction cannot drift — in
 * particular `isSystemRow` must stay FALSE for `developer_message` (that variant
 * is a separate case in `messaging/messages.mjs`) and `isUserRow` must stay
 * TRUE for a tool-result carrier (its exclusion is `isGenuineUserTurn`'s job).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isUserRow, isSystemRow } from '../lib/messaging/row-shape.mjs';

const cases = [
    { name: '{type:user_message}', row: { type: 'user_message' }, user: true, system: false },
    { name: '{role:user}', row: { role: 'user' }, user: true, system: false },
    { name: '{role:user, content:[tool_result]}', row: { role: 'user', content: [{ type: 'tool_result' }] }, user: true, system: false },
    { name: '{role:tool}', row: { role: 'tool' }, user: false, system: false },
    { name: '{type:tool_message}', row: { type: 'tool_message' }, user: false, system: false },
    { name: '{role:system}', row: { role: 'system' }, user: false, system: true },
    { name: '{role:developer}', row: { role: 'developer' }, user: false, system: true },
    { name: '{type:system_message}', row: { type: 'system_message' }, user: false, system: true },
    { name: '{type:developer_message}', row: { type: 'developer_message' }, user: false, system: false },
    { name: '{role:assistant}', row: { role: 'assistant' }, user: false, system: false },
    { name: '{}', row: {}, user: false, system: false },
    { name: 'null', row: null, user: false, system: false },
    { name: 'undefined', row: undefined, user: false, system: false },
    { name: 'a string', row: 'a row-shaped string', user: false, system: false },
];

for (const { name, row, user, system } of cases) {
    test(`row shape ${name}: isUserRow=${user} isSystemRow=${system}`, () => {
        assert.equal(isUserRow({ m: /** @type {any} */ (row) }), user, `isUserRow for ${name}`);
        assert.equal(isSystemRow({ m: /** @type {any} */ (row) }), system, `isSystemRow for ${name}`);
    });
}

test('isSystemRow stays false for developer_message (messages.mjs owns that variant)', () => {
    const row = { type: 'developer_message', content: 'be terse' };
    assert.equal(isSystemRow({ m: row }), false);
    assert.equal(isUserRow({ m: row }), false);
});

test('isUserRow keeps a tool-result carrier (only isGenuineUserTurn excludes it)', () => {
    assert.equal(isUserRow({ m: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1' }] } }), true);
    assert.equal(isUserRow({ m: { role: 'user', parts: [{ functionResponse: { name: 'lookup' } }] } }), true);
});
