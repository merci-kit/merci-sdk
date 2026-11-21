// @ts-check
/**
 * The executor's stateless seams. These used to be private methods; the
 * extraction must keep their exact behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { capSessionRow, schemaViolation, danglingDependencies } from '../lib/agentic/planning/executor-helpers.mjs';

test('capSessionRow caps string content and text blocks, and leaves other blocks', () => {
    const long = 'x'.repeat(500);
    const capped = capSessionRow({ row: { role: 'user', content: long }, cap: 200 });
    const cappedContent = /** @type {string} */ (capped.content);
    assert.ok(cappedContent.startsWith('x'.repeat(200)));
    assert.match(cappedContent, /\[truncated/);
    assert.equal(capped.role, 'user');

    const blocks = capSessionRow({
        row: { role: 'assistant', content: [{ type: 'text', text: long }, { type: 'image', data: 'abc' }] },
        cap: 200,
    });
    const blockContent = /** @type {any[]} */ (blocks.content);
    assert.ok(blockContent[0].text.startsWith('x'.repeat(200)));
    assert.deepEqual(blockContent[1], { type: 'image', data: 'abc' });
    assert.equal(capSessionRow({ row: /** @type {any} */ ({ role: 'user', content: 42 }), cap: 200 }).content, 42);
});

test('schemaViolation is null without a schema, and flags a real mismatch', () => {
    assert.equal(schemaViolation({ schema: null, node: { id: 'a' }, result: 'anything' }), null);
    const schema = z.object({ ok: z.boolean() });
    assert.equal(schemaViolation({ schema, node: { id: 'a' }, result: '{"ok":true}' }), null);
    const bad = schemaViolation({ schema, node: { id: 'a' }, result: '{"ok":"no"}' });
    assert.ok(bad instanceof Error);
    assert.match(bad.message, /Step \[a\]/);
});

test('danglingDependencies names missing deps and accepts completed ones', () => {
    const known = new Map([['done', { status: 'completed' }], ['failed', { status: 'failed' }]]);
    const dangling = danglingDependencies({
        steps: [
            { id: 'a', dependencies: ['done', 'missing'] },
            { id: 'b', dependencies: ['failed'] },
            { id: 'c', dependencies: ['a'] },
        ],
        knownSteps: known,
    });
    assert.deepEqual(dangling, ['a→missing', 'b→failed']);
});

test('danglingDependencies treats Set membership as satisfied', () => {
    const dangling = danglingDependencies({
        steps: [{ id: 'a', dependencies: ['kept', 'ghost'] }],
        knownSteps: new Set(['kept']),
    });
    assert.deepEqual(dangling, ['a→ghost']);
});
