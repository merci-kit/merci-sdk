// @ts-check
/**
 * Packet 03-adapter-dedup: focused checks for the shared adapter helpers and
 * the adapter `formatToolCall` integration. The full byte-level fidelity matrix
 * lives in the run artifacts; this locks the contract in-repo.
 */

import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { EVENTS } from '../lib/core/events.mjs';
import { hasNativeLeg, createFirstTokenEmitter, hasAnyDeclaredTools, mergeToolsByName, quotaEvent, sessionIdOf, sourcesEvent, toolCallIdentity, warnSession } from '../lib/backends/adapters/adapter-common.mjs';
import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { jaiAdapter } from '../lib/backends/adapters/jai-adapter.mjs';

describe('mergeToolsByName', () => {
    test('session tools first, then spec tools no session tool already names — original entries', () => {
        const a = { name: 'a' };
        const b = { name: 'b' };
        const spec = { name: 'c', input_schema: {} };
        const dup = { name: 'a', description: 'late' };
        const merged = mergeToolsByName({ tools: [a, b], specTools: [spec, dup] });
        assert.deepEqual(merged, [a, b, spec]);
        assert.equal(merged[0], a, 'entries are the originals, not copies');
        assert.equal(merged[2], spec);
    });

    test('the key reads OpenAI function.name; a later duplicate keeps its slot', () => {
        const first = { type: 'function', function: { name: 'f' } };
        const last = { type: 'function', function: { name: 'f' } };
        const merged = mergeToolsByName({ tools: [first, { name: 'g' }, last] });
        assert.deepEqual(merged, [last, { name: 'g' }], 'the last duplicate wins in the first slot');
    });

    test('a nameless entry is skipped (a call cannot address it) and missing lists are empty', () => {
        assert.deepEqual(mergeToolsByName({ tools: [{ description: 'x' }], specTools: [null, { name: 'k' }] }), [{ name: 'k' }]);
        assert.deepEqual(mergeToolsByName(), []);
    });
});

describe('hasAnyDeclaredTools', () => {
    test('a spec tool counts; a session tool counts unless it is the task delegate', () => {
        assert.equal(hasAnyDeclaredTools({ tools: [{ name: 'task', description: 'delegate' }] }), false);
        assert.equal(hasAnyDeclaredTools({ tools: [{ name: 'task', description: 'delegate' }, { name: 'read' }] }), true);
        assert.equal(hasAnyDeclaredTools({ specTools: [{ name: 'spec' }] }), true);
        assert.equal(hasAnyDeclaredTools({ tools: [], specTools: [] }), false);
        assert.equal(hasAnyDeclaredTools(), false);
    });
});

describe('toolCallIdentity', () => {
    test('id falls through call → result → tool_call_id → fallback; name reads any shape', () => {
        assert.deepEqual(toolCallIdentity({ call: { id: 'c1', name: 'n' }, result: { id: 'r1' }, fallbackId: 'f' }), { id: 'c1', name: 'n' });
        assert.deepEqual(toolCallIdentity({ call: {}, result: { tool_call_id: 't1', name: 'rn' }, fallbackId: 'f' }), { id: 't1', name: '' });
        assert.deepEqual(toolCallIdentity({ call: { function: { name: 'fn' } }, fallbackId: 'call_3' }), { id: 'call_3', name: 'fn' });
        assert.deepEqual(toolCallIdentity({ call: {} }), { id: undefined, name: '' });
    });
});

describe('sessionIdOf', () => {
    test('the public session id wins, the run id is the fallback', () => {
        assert.equal(sessionIdOf({ session: { sessionId: 's', _sessionRunCtx: { runId: 'r' } } }), 's');
        assert.equal(sessionIdOf({ session: { _sessionRunCtx: { runId: 'r' } } }), 'r');
        assert.equal(sessionIdOf({ session: {} }), undefined);
        assert.equal(sessionIdOf(), undefined);
    });
});

describe('hasNativeLeg', () => {
    test('webSearch native modes (fallback still injects the native leg)', () => {
        assert.equal(hasNativeLeg({ session: { _webSearch: { mode: 'native' } }, cap: 'webSearch' }), true);
        assert.equal(hasNativeLeg({ session: { _webSearch: { mode: 'native_with_tavily_fallback' } }, cap: 'webSearch' }), true);
        assert.equal(hasNativeLeg({ session: { _webSearch: { mode: 'tavily' } }, cap: 'webSearch' }), false);
        assert.equal(hasNativeLeg({ session: {}, cap: 'webSearch' }), false);
        assert.equal(hasNativeLeg({ session: undefined, cap: 'webSearch' }), false);
    });

    test('webScrape includes the curl fallback; webSearch does not', () => {
        assert.equal(hasNativeLeg({ session: { _webScrape: { mode: 'native_with_curl_fallback' } }, cap: 'webScrape' }), true);
        assert.equal(hasNativeLeg({ session: { _webSearch: { mode: 'native_with_curl_fallback' } }, cap: 'webSearch' }), false);
    });
});

describe('createFirstTokenEmitter', () => {
    test('emits exactly once with a numeric latency; later generators emit nothing', () => {
        const { maybeFirstToken } = createFirstTokenEmitter();
        const gen = maybeFirstToken();
        const first = gen.next();
        assert.equal(first.done, false);
        assert.equal(first.value.type, 'first_token');
        assert.equal(typeof first.value.latencyMs, 'number');
        assert.equal(gen.next().done, true, 'a single generator yields once');
        assert.equal(maybeFirstToken().next().done, true, 'the one-shot state is shared across generators');
    });
});

describe('quotaEvent', () => {
    test('full payload has the canonical key order', () => {
        const ev = quotaEvent({ amount: 12, prompt: 7, completion: 5, cached: 3, reasoning: 2 });
        assert.deepEqual(ev, { type: 'quota', data: {
            spent: { amount: 12 }, prompt_tokens: 7, completion_tokens: 5, cache_read_input_tokens: 3, reasoning_tokens: 2,
        } });
        assert.deepEqual(Object.keys(ev.data), ['spent', 'prompt_tokens', 'completion_tokens', 'cache_read_input_tokens', 'reasoning_tokens']);
    });

    test('amount defaults to prompt + completion; absent cache/reasoning keys are omitted', () => {
        const ev = quotaEvent({ prompt: 3, completion: 2 });
        assert.deepEqual(ev.data, { spent: { amount: 5 }, prompt_tokens: 3, completion_tokens: 2 });
        assert.equal('cache_read_input_tokens' in ev.data, false);
        assert.equal('reasoning_tokens' in ev.data, false);
    });

    test('cacheCreation precedes cache_read, and no reasoning key when absent', () => {
        const ev = quotaEvent({ prompt: 5, completion: 4, cacheCreation: 2, cached: 3 });
        assert.deepEqual(Object.keys(ev.data), ['spent', 'prompt_tokens', 'completion_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']);
    });
});

describe('sourcesEvent', () => {
    test('normalizes and dedupes; returns null when nothing normalizes', () => {
        const ev = sourcesEvent({ citations: [{ url: 'https://a.test', title: 'A' }, { url: 'https://a.test', title: 'A dup' }] });
        assert.ok(ev);
        assert.equal(ev.type, 'sources');
        assert.deepEqual(ev.data.sources, [{ title: 'A', url: 'https://a.test' }]);
        assert.equal(sourcesEvent({ citations: [] }), null);
    });
});

describe('formatToolCall — native-shape fidelity + canonical name reading', () => {
    test('OAI reads function.name / function.arguments', () => {
        assert.deepEqual(
            oaiAdapter.formatToolCall({ call: { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } } }),
            { id: 'c1', name: 'f', args: '{"a":1}' }
        );
    });

    test('GAI reads name/args, keeps thoughtSignature and string-args', () => {
        assert.deepEqual(
            gaiAdapter.formatToolCall({ call: { id: 'c2', name: 'g', args: { b: 2 }, thoughtSignature: 's' } }),
            { id: 'c2', name: 'g', args: { b: 2 }, thoughtSignature: 's' }
        );
        assert.deepEqual(
            gaiAdapter.formatToolCall({ call: { id: 'c3', name: 'h', args: '{"c":3}' } }),
            { id: 'c3', name: 'h', args: '{"c":3}', thoughtSignature: null }
        );
    });

    test('AAI stringifies object input and preserves string input', () => {
        assert.deepEqual(
            aaiAdapter.formatToolCall({ call: { id: 'c4', type: 'tool_use', name: 'i', input: { d: 4 } } }),
            { id: 'c4', name: 'i', args: '{"d":4}' }
        );
        assert.deepEqual(
            aaiAdapter.formatToolCall({ call: { id: 'c5', name: 'j', input: '{"e":5}' } }),
            { id: 'c5', name: 'j', args: '{"e":5}' }
        );
    });

    test('JAI keeps id/args/thoughtSignature and its index + unknown fallbacks', () => {
        assert.deepEqual(
            jaiAdapter.formatToolCall({ call: { id: 'c6', name: 'k', arguments: '{"x":1}', thoughtSignature: 's' } }),
            { id: 'c6', name: 'k', args: '{"x":1}', thoughtSignature: 's' }
        );
        assert.deepEqual(
            jaiAdapter.formatToolCall({ call: {}, result: null, index: 2 }),
            { id: 'call_2', name: 'unknown', args: undefined, thoughtSignature: null }
        );
    });

    test('name reading is canonical across foreign shapes (getToolCallName honors function.name)', () => {
        assert.equal(aaiAdapter.formatToolCall({ call: { id: 'x', function: { name: 'fn' } } }).name, 'fn');
        assert.equal(jaiAdapter.formatToolCall({ call: { id: 'x', function: { name: 'fn' } } }).name, 'fn');
    });
});

describe('openAIQuota — one precedence across the three wire positions', () => {
    /** @param {Array<any>} chunks */
    const feed = (chunks) => (async function* () { for (const chunk of chunks) yield chunk; })();

    test('a chat chunk: chat names lead, Responses names are only the fallback', async () => {
        /** @type {Array<any>} */
        const events = [];
        for await (const ev of oaiAdapter.consumeStream({ rawStream: feed([{ choices: [], usage: {
            prompt_tokens: 1, input_tokens: 2, completion_tokens: 3, output_tokens: 4, total_tokens: 7,
            prompt_tokens_details: { cached_tokens: 5 }, input_tokens_details: { cached_tokens: 6 },
            completion_tokens_details: { reasoning_tokens: 7 }, output_tokens_details: { reasoning_tokens: 8 },
        } }]), signal: null })) events.push(ev);
        assert.deepEqual(events.filter((e) => e.type === 'quota').map((e) => e.data), [
            { spent: { amount: 7 }, prompt_tokens: 1, completion_tokens: 3, cache_read_input_tokens: 5, reasoning_tokens: 7 },
        ]);
    });

    test('a Responses event keeps its own names; no usage reports no quota', async () => {
        /** @type {Array<any>} */
        const events = [];
        for await (const ev of oaiAdapter.consumeStream({ rawStream: feed([
            { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 4 } } },
            { type: 'response.completed', response: { usage: { total_tokens: 0 } } },
        ]), signal: null })) events.push(ev);
        assert.deepEqual(events.filter((e) => e.type === 'quota').map((e) => e.data), [
            { spent: { amount: 6 }, prompt_tokens: 2, completion_tokens: 4 },
        ]);
    });
});

describe('warnSession', () => {
    test('session backend wins; otherwise the adapter default is used', () => {
        const emitter = new EventEmitter();
        /** @type {Array<any>} */
        const seen = [];
        emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (e) => seen.push(e));
        warnSession({ session: { eventEmitter: emitter, provider: 'custom' }, provider: 'DEFAULT', model: 'm', parameter: 'p', message: 'x' });
        warnSession({ session: { eventEmitter: emitter }, provider: 'DEFAULT', model: 'm', parameter: 'p', message: 'x' });
        assert.deepEqual(
            seen.map((p) => ({ model: p.model, parameter: p.parameter, message: p.message, provider: p.provider, standard: p.standard })),
            [
                { model: 'm', parameter: 'p', message: 'x', provider: 'custom', standard: '' },
                { model: 'm', parameter: 'p', message: 'x', provider: 'DEFAULT', standard: '' },
            ]
        );
    });

    test('a missing emitter is a no-op', () => {
        assert.doesNotThrow(() => warnSession({ session: {}, provider: 'DEFAULT', parameter: 'p', message: 'x' }));
    });
});
