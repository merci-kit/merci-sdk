// @ts-check
/**
 * The journal boundary is `b${currentMessages.length}`. A compaction fold
 * shortens the array, so a later turn can land on a length an earlier turn
 * already used and reuse its keys — an identical call then replays the earlier
 * outcome instead of running. The fix tracks the rows a fold removed as a
 * local offset for the run, so the boundary keeps growing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ExecutionJournal } from '../lib/agentic/journal.mjs';

const CALL = { id: 'c1', name: 'count', arguments: '{"n":1}' };

/** @param {{journal: ExecutionJournal, tool: any, turns: number}} arg0 */
function fakeSession({ journal, tool, turns }) {
    let n = 0;
    return {
        provider: 'OAI',
        model: 'm',
        _tools: [tool],
        _retryPolicy: undefined,
        _journal: journal,
        eventEmitter: { emit() {} },
        withSystemMessage() { return this; },
        withTools() { return this; },
        withMemory() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        withCircuitBreaker() { return this; },
        /** @param {{messages: any}} arg0 @returns {AsyncGenerator<any, any>} */
        async *step({ messages }) {
            n += 1;
            if (n <= turns) {
                /** @type {any} */
                const results = yield { type: 'tool_request', calls: [CALL] };
                // Commit the rows a real step commits: the assistant tool call
                // and its result. Without them the loop sees no new tool call.
                return {
                    done: true,
                    content: '',
                    messages: [...messages,
                        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'count', arguments: '{"n":1}' } }] },
                        { role: 'tool', tool_call_id: 'c1', name: 'count', content: String(results?.[0]?.result ?? '') },
                    ],
                    thoughtSignature: null,
                };
            }
            return { done: true, content: 'done', messages, thoughtSignature: null };
        },
    };
}

function countingTool(/** @type {{n: number}} */ counter) {
    return {
        name: 'count',
        parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        execute: async () => { counter.n += 1; return `count=${counter.n}`; },
    };
}

/** @param {number} count */
const history = (count) => Array.from({ length: count }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `row ${i}` }));

test('an identical call in a later turn is never replayed after a compaction fold', async () => {
    const journal = new ExecutionJournal();
    const counter = { n: 0 };
    const turns = 5;
    const session = fakeSession({ journal, tool: countingTool(counter), turns });
    await runAgenticLoop({
        session: /** @type {any} */ (session),
        messages: /** @type {any} */ (history(12)),
        opts: {
            compaction: { thresholdTokens: 1, keepRecent: 3, summarize: async () => 'summary of earlier turns' },
            maxIterations: 8,
        },
    });
    assert.equal(counter.n, turns, `each turn must run its call; ran ${counter.n} of ${turns}`);
});

test('every turn after a fold gets a distinct journal boundary', async () => {
    const journal = new ExecutionJournal();
    const counter = { n: 0 };
    const session = fakeSession({ journal, tool: countingTool(counter), turns: 5 });
    await runAgenticLoop({
        session: /** @type {any} */ (session),
        messages: /** @type {any} */ (history(12)),
        opts: {
            compaction: { thresholdTokens: 1, keepRecent: 3, summarize: async () => 'summary of earlier turns' },
            maxIterations: 8,
        },
    });
    const boundaries = journal.entries().map((/** @type {any} */ entry) => entry.boundary);
    assert.equal(boundaries.length, 5);
    assert.equal(new Set(boundaries).size, 5, `boundaries repeat: ${JSON.stringify(boundaries)}`);
});

test('a retry of the same turn reuses its boundary, so the call replays', async () => {
    const journal = new ExecutionJournal();
    const counter = { n: 0 };
    const tool = countingTool(counter);
    // Turn one of the first run completes and is recorded.
    const first = fakeSession({ journal, tool, turns: 1 });
    await runAgenticLoop({
        session: /** @type {any} */ (first),
        messages: /** @type {any} */ (history(4)),
        opts: { maxIterations: 4 },
    });
    assert.equal(counter.n, 1);
    // The same first turn in a fresh loop with the same journal replays it.
    const second = fakeSession({ journal, tool, turns: 1 });
    await runAgenticLoop({
        session: /** @type {any} */ (second),
        messages: /** @type {any} */ (history(4)),
        opts: { maxIterations: 4 },
    });
    assert.equal(counter.n, 1, 'the retry reused the recorded outcome');
});
