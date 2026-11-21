// @ts-check
/**
 * Run-level provenance: the citations and web-search URLs a run produced are
 * gathered once, deduped, and exposed on `run:end` and on the session, so a
 * caller does not have to scrape the step events.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { EVENTS } from '../lib/core/events.mjs';

test('a run gathers its citations and sources, deduped', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const ends = [];
    emitter.on(EVENTS.CLIENT.RUN_END, (e) => ends.push(e));
    let calls = 0;
    const session = /** @type {any} */ ({
        provider: 'OAI',
        model: 'm',
        _tools: [],
        eventEmitter: emitter,
        async *step() {
            calls += 1;
            return {
                done: true,
                content: 'answer',
                messages: [{ role: 'assistant', content: 'answer' }],
                citations: [
                    { uri: 'https://example.com/a', title: 'A' },
                    { uri: 'https://example.com/a', title: 'A' },
                ],
                sources: [{ url: 'https://example.com/b', title: 'B' }],
            };
        },
    });
    const out = await runAgenticLoop({ session, messages: [{ role: 'user', content: 'q' }], opts: {} });
    assert.equal(out, 'answer');
    assert.equal(calls, 1);
    assert.deepEqual(session._lastRunCitations, [{ uri: 'https://example.com/a', title: 'A' }]);
    assert.deepEqual(session._lastRunSources, [{ url: 'https://example.com/b', title: 'B' }]);
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0].citations, session._lastRunCitations);
    assert.deepEqual(ends[0].sources, session._lastRunSources);
});

test('a run with no provenance omits both fields', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const ends = [];
    emitter.on(EVENTS.CLIENT.RUN_END, (e) => ends.push(e));
    const session = /** @type {any} */ ({
        provider: 'OAI', model: 'm', _tools: [], eventEmitter: emitter,
        async *step() { return { done: true, content: 'plain', messages: [{ role: 'assistant', content: 'plain' }] }; },
    });
    await runAgenticLoop({ session, messages: [{ role: 'user', content: 'q' }], opts: {} });
    assert.deepEqual(session._lastRunCitations, []);
    assert.deepEqual(session._lastRunSources, []);
    assert.equal('citations' in ends[0], false);
    assert.equal('sources' in ends[0], false);
});
