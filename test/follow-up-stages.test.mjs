// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { DEFAULT_MAX_FOLLOW_UPS, FALLBACK_MESSAGE, ProviderType } from '../lib/core/constants/index.mjs';
import { AbortedError } from '../lib/core/errors.mjs';

/**
 * @param {{replies: any[], provider?: *}} arg0
 * @returns {any}
 */
function scriptedSession({ replies, provider = ProviderType.OPENAI }) {
    /** @type {any[]} */
    const seen = [];
    let n = 0;
    return {
        provider,
        _tools: [],
        seen,
        /** @param {{messages: *}} arg0 */
        async *step({ messages }) {
            seen.push(messages);
            const content = replies[Math.min(n++, replies.length - 1)];
            return { done: true, content, messages: [...messages, { role: 'assistant', content }] };
        }
    };
}

/** @param {any[]} msgs */
/** @param {{msgs: *}} arg0 */
/** @param {{msgs: *}} arg0 */
const userTurns = ({ msgs }) => msgs.filter(/** @type {(...args: any[]) => any} */ (m => m.role === 'user' || m.type === 'user_message')).map(/** @type {(...args: any[]) => any} */ (m => m.content));

test('no followUp: returns the first answer, one step only', async () => {
    const s = scriptedSession({ replies: ['first'] });
    assert.equal(await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }] }), 'first');
    assert.equal(s.seen.length, 1);
});

test('followUp: each stage is appended as the next user turn, in order', async () => {
    const s = scriptedSession({ replies: ['a1', 'a2', 'a3'] });
    const stages = ['review it', 'now verify'];
    const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: {
        followUp: /** @type {(info: any) => any} */ (({ round }) => stages[round] ?? null)
    } });
    assert.equal(out, 'a3', 'returns the last stage answer');
    assert.equal(s.seen.length, 3, 'one step per stage');
    assert.deepEqual(userTurns({ msgs: s.seen[2] }), ['go', 'review it', 'now verify']);
});

test('followUp: returning null stops immediately', async () => {
    const s = scriptedSession({ replies: ['only'] });
    assert.equal(await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: { followUp: () => null } }), 'only');
    assert.equal(s.seen.length, 1);
});

test('followUp: sees the answer so it can stop on a sentinel', async () => {
    const s = scriptedSession({ replies: ['working', 'DONE', 'should not run'] });
    const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: {
        followUp: /** @type {(info: any) => any} */ (({ content }) => (content.endsWith('DONE') ? null : 'keep going'))
    } });
    assert.equal(out, 'DONE');
    assert.equal(s.seen.length, 2);
});

test('followUp: capped by maxFollowUps, and by the default cap', async () => {
    const s = scriptedSession({ replies: ['x'] });
    await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: { followUp: () => 'again', maxFollowUps: 2 } });
    assert.equal(s.seen.length, 3, '1 initial + 2 stages');

    const s2 = scriptedSession({ replies: ['x'] });
    await runAgenticLoop({ session: s2, messages: [{ role: 'user', content: 'go' }], opts: { followUp: () => 'again' } });
    assert.equal(s2.seen.length, DEFAULT_MAX_FOLLOW_UPS + 1, 'runaway followUp cannot bill forever');
});

test('followUp: a stage that burns its budget on tool calls still queues the next stage', async () => {
    /** @type {any[]} */
    const seen = [];
    let calls = 0;
    const s = {
        provider: ProviderType.OPENAI,
        _tools: [],
        seen,
        /** @param {{messages: *}} arg0 */
        async *step({ messages }) {
            seen.push(messages);
            calls++;
            if (calls < 3) {
                return {
                    done: false,
                    messages: [...messages, { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }] }]
                };
            }
            return { done: true, content: 'final', messages: [...messages, { role: 'assistant', content: 'final' }] };
        }
    };
    const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: {
        maxIterations: 2,
        followUp: /** @type {(info: any) => any} */ (({ round }) => (round === 0 ? 'keep going' : null))
    } });
    assert.equal(out, 'final');
    assert.equal(seen.length, 3, 'stage 1 burns both tool iterations, stage 2 answers');
});

test('followUp: a tool-burning stage hands followUp ITS content, not the previous stage text', async () => {
    /** @type {any[]} */
    const contents = [];
    const s = {
        provider: ProviderType.OPENAI,
        _tools: [],
        /** @param {{messages: *}} arg0 */
        async *step({ messages }) {
            if (contents.length === 0) {
                return { done: true, content: 'first answer', messages: [...messages, { role: 'assistant', content: 'first answer' }] };
            }
            return {
                done: false,
                messages: [...messages, { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }] }]
            };
        }
    };
    const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: {
        maxIterations: 1,
        followUp: /** @type {(info: any) => any} */ (({ content }) => {
            contents.push(content);
            return contents.length === 1 ? 'review stage 2' : null;
        })
    } });
    assert.equal(contents[0], 'first answer', 'stage 1 handoff carries stage 1 content');
    assert.equal(contents[1], '', 'tool-burning stage must hand followUp an empty content, not stale stage-1 text');
    assert.equal(out, 'first answer', 'final fallback still prefers the best answer');
});

test('followUp: a stage gets a fresh iteration budget (not the leftovers)', async () => {
    const s = scriptedSession({ replies: ['a1', 'a2'] });
    const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: {
        maxIterations: 1,
        followUp: /** @type {(info: any) => any} */ (({ round }) => (round === 0 ? 'review' : null))
    } });
    assert.equal(out, 'a2');
});

test('followUp: an empty later stage returns the last good answer, not the fallback string', async () => {
    const s = scriptedSession({ replies: ['good', '', ''] });
    const out = await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: { followUp: () => 'again' } });
    assert.equal(out, 'good');
    assert.notEqual(out, FALLBACK_MESSAGE.EMPTY_RESPONSE);
});

test('followUp: the stage turn is shaped for the session backend (JAI)', async () => {
    const s = scriptedSession({ replies: ['a1', 'a2'], provider: ProviderType.JAI });
    await runAgenticLoop({ session: s, messages: [{ type: 'user_message', content: 'go' }], opts: {
        followUp: /** @type {(info: any) => any} */ (({ round }) => (round === 0 ? 'review' : null))
    } });
    const added = s.seen[1][s.seen[1].length - 1];
    assert.equal(added.type, 'user_message');
    assert.equal(added.content, 'review');
});

test('signal: an already-aborted signal rejects before any step', async () => {
    const s = scriptedSession({ replies: ['x'] });
    const c = new AbortController();
    c.abort();
    await assert.rejects(
        () => runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: { signal: c.signal } }),
        (e) => e instanceof AbortedError
    );
    assert.equal(s.seen.length, 0);
});

test('signal: aborting between stages stops the loop', async () => {
    const s = scriptedSession({ replies: ['a1', 'a2', 'a3'] });
    const c = new AbortController();
    await assert.rejects(
        () => runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: {
            signal: c.signal,
            followUp: () => { c.abort('enough'); return 'again'; }
        } }),
        (e) => e instanceof AbortedError
    );
    assert.equal(s.seen.length, 1, 'the queued stage must not run');
});
