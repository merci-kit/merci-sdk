// @ts-check
/**
 * The JAI synthesis recovery lowers reasoning effort so the retry can produce
 * text. It applied the change to the SESSION, so every later run on that
 * session stayed at `low`: a one-run recovery became a new default. The
 * lowering is undone when the run ends, on success and on failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

const CALL = { id: 'c1', name: 'count', arguments: '{"n":1}' };

/**
 * A JAI session whose model asks for a tool, then answers with empty text once
 * (the synthesis-recovery trigger), then answers with text.
 * @param {{spec: any, parameters: Record<string, any>, failAfterRecovery?: boolean}} arg0
 */
function jaiSession({ spec, parameters, failAfterRecovery = false }) {
    let calls = 0;
    /** @type {{lowerings: number}} */
    const seen = { lowerings: 0 };
    const session = /** @type {any} */ ({
        provider: ProviderType.JAI,
        model: 'm',
        _jaiSpec: spec,
        _parameters: parameters,
        _tools: [{
            name: 'count',
            parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
            execute: async () => 'counted',
        }],
        _retryPolicy: undefined,
        eventEmitter: { emit() {} },
        /** @param {{params: any}} arg0 */
        withParameters({ params }) {
            // Mirrors AbstractChatSession: a new object, not a mutation.
            if (typeof params === 'function') seen.lowerings += 1;
            session._parameters = { ...session._parameters, ...params };
            return session;
        },
        withSystemMessage() { return session; },
        withTools() { return session; },
        withMemory() { return session; },
        withTodos() { return session; },
        withCircuitBreaker() { return session; },
        /** @param {{messages: any}} arg0 @returns {AsyncGenerator<any, any>} */
        async *step({ messages }) {
            calls += 1;
            if (calls === 1) {
                const results = yield { type: 'tool_request', calls: [CALL] };
                return {
                    done: true,
                    content: '',
                    messages: [...messages,
                        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'count', arguments: '{"n":1}' } }] },
                        { role: 'tool', tool_call_id: 'c1', name: 'count', content: String(results?.[0]?.result ?? '') },
                    ],
                };
            }
            if (calls === 2) return { done: true, content: '' };
            if (failAfterRecovery) throw new Error('failed after the recovery');
            return { done: true, content: 'done' };
        },
    });
    return { session, seen };
}

test('the lowered reasoning effort is restored after a successful run', async () => {
    const spec = { reasoningEffort: 'high' };
    const parameters = /** @type {Record<string, any>} */ ({});
    const { session, seen } = jaiSession({ spec, parameters });
    const out = await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 8 } });
    assert.match(String(out), /done/);
    assert.equal(seen.lowerings, 1, 'the recovery lowered the effort during the run');
    assert.equal(session._parameters, parameters, 'the original parameter bag is back');
    assert.equal(session._parameters.params, undefined, 'the lowering did not survive the run');
    assert.equal(session._jaiSpec, spec, 'the spec is the original object');
});

test('the lowered reasoning effort is restored when the run throws', async () => {
    const spec = { reasoningEffort: 'high' };
    const parameters = /** @type {Record<string, any>} */ ({});
    const { session, seen } = jaiSession({ spec, parameters, failAfterRecovery: true });
    await assert.rejects(runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 8 } }), /failed after the recovery/);
    assert.equal(seen.lowerings, 1);
    assert.equal(session._parameters, parameters, 'a failed run restores the effort too');
    assert.equal(session._jaiSpec, spec);
});
