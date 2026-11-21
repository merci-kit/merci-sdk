// @ts-check
/**
 * `maxParallelTools` caps how many tool calls from one model turn run at once.
 * A model that emits a dozen independent calls should not open a dozen sockets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { executeTools } from '../lib/tools/tool-execution.mjs';

/** @param {{peak: {value: number}}} arg0 */
function makeTools({ peak }) {
    let active = 0;
    /** @param {{name: string}} arg0 */
    const tool = ({ name }) => ({
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            active += 1;
            peak.value = Math.max(peak.value, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return `done:${name}`;
        },
    });
    return ['a', 'b', 'c', 'd'].map((name) => tool({ name }));
}

test('executeTools runs every call but caps the concurrency', async () => {
    const peak = { value: 0 };
    const tools = makeTools({ peak });
    const results = await executeTools({
        toolCalls: tools.map((t) => ({ id: t.name, name: t.name, arguments: {} })),
        toolLibrary: tools,
        maxParallelTools: 2,
    });
    assert.equal(results.length, 4);
    assert.deepEqual(results.map((/** @type {any} */ r) => r.name), ['a', 'b', 'c', 'd'], 'results keep the call order');
    assert.equal(peak.value, 2, 'no more than two tools ran at once');
});

test('without the cap every call starts together', async () => {
    const peak = { value: 0 };
    const tools = makeTools({ peak });
    await executeTools({
        toolCalls: tools.map((t) => ({ id: t.name, name: t.name, arguments: {} })),
        toolLibrary: tools,
    });
    assert.equal(peak.value, 4);
});

test('a cap larger than the round is a no-op', async () => {
    const peak = { value: 0 };
    const tools = makeTools({ peak });
    await executeTools({
        toolCalls: tools.map((t) => ({ id: t.name, name: t.name, arguments: {} })),
        toolLibrary: tools,
        maxParallelTools: 50,
    });
    assert.equal(peak.value, 4);
});
