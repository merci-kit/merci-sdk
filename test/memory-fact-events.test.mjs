// @ts-check
/** Direct repro for the Phase B memory fact events (no network, no LLM). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { MemoryManager } from '../lib/agentic/memory/manager.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/** @returns {{provider: any, stored: any[], deleted: string[]}} */
function makeProvider() {
    /** @type {any[]} */
    const stored = [];
    /** @type {string[]} */
    const deleted = [];
    const provider = {
        name: 'workspace',
        description: 'test bank',
        async load() {},
        async save() {},
        async query() { return []; },
        async getBankDescriptions() { return '- "workspace": test bank\n'; },
        async store(/** @type {any} */ { content, category }) {
            const fact = { id: 'fact_test_1', content, category: category ?? null };
            stored.push(fact);
            return fact;
        },
        async delete(/** @type {any} */ { id }) {
            deleted.push(id);
            return true;
        },
        async clear() {},
    };
    return { provider, stored, deleted };
}

/** @param {string} json */
function makeClient(json) {
    return {
        session() {
            return {
                withSystemMessage() { return this; },
                withParameters() { return this; },
                async run() { return json; },
            };
        },
    };
}

test('memory:fact_added and memory:fact_obsolete fire on distill', async () => {
    const { provider, deleted } = makeProvider();
    const client = makeClient(JSON.stringify({
        newFacts: [{ content: 'the sky is green', category: 'fact', targetBanks: [] }],
        obsoleteFactIds: ['fact_old_1'],
    }));
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const added = [];
    /** @type {any[]} */
    const obsolete = [];
    emitter.on(EVENTS.MEMORY.FACT_ADDED, (/** @type {any} */ e) => added.push(e));
    emitter.on(EVENTS.MEMORY.FACT_OBSOLETE, (/** @type {any} */ e) => obsolete.push(e));

    const manager = new MemoryManager({ provider, options: { syncInterval: 1 } });
    await manager.distill({
        messages: [{ role: 'user', content: 'what color is the sky' }],
        client,
        modelToUse: 'm',
        options: { emitter },
    });

    assert.equal(manager.lastDistillError, null);
    assert.equal(added.length, 1);
    assert.deepEqual(
        { id: added[0].id, content: added[0].content, category: added[0].category, targetBanks: added[0].targetBanks },
        { id: 'fact_test_1', content: 'the sky is green', category: 'fact', targetBanks: [] },
    );
    assert.equal(added[0].event, EVENTS.MEMORY.FACT_ADDED);
    assert.equal(obsolete.length, 1);
    assert.equal(obsolete[0].id, 'fact_old_1');
    assert.equal(obsolete[0].event, EVENTS.MEMORY.FACT_OBSOLETE);
    assert.deepEqual(deleted, ['fact_old_1']);
});

test('a distill with no obsolete ids fires only memory:fact_added', async () => {
    const { provider } = makeProvider();
    const client = makeClient(JSON.stringify({
        newFacts: [{ content: 'a', category: 'fact', targetBanks: [] }],
        obsoleteFactIds: [],
    }));
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const obsolete = [];
    emitter.on(EVENTS.MEMORY.FACT_OBSOLETE, (/** @type {any} */ e) => obsolete.push(e));

    const manager = new MemoryManager({ provider, options: { syncInterval: 1 } });
    await manager.distill({ messages: [{ role: 'user', content: 'x' }], client, modelToUse: 'm', options: { emitter } });

    assert.equal(manager.lastDistillError, null);
    assert.equal(obsolete.length, 0);
});
