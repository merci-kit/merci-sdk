// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { MerciClient as OAIClient } from '../lib/backends/oai.mjs';
import { ChatSession as JaiAgenticChatSession } from '../lib/backends/jai.mjs';
import { createUnifiedMediaMessages } from '../lib/backends/media.mjs';
import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import { jaiAdapter } from '../lib/backends/adapters/jai-adapter.mjs';
import { SSEParser, TaskSSEParserV5, readSSELines } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { ChatSession as JaiVendorChatSession } from '../lib/backends/jai-vendor/chat-session.mjs';
import { InternalHttpClient } from '../lib/backends/jai-vendor/http-client.mjs';
import { TaskAPI, QuotaAPI } from '../lib/backends/jai-vendor/api.mjs';
import { ProfileManager } from '../lib/backends/jai-vendor/profiles.mjs';
import { formatJaiMessages } from '../lib/backends/jai-vendor/messages.mjs';
import { SSEError, APIError } from '../lib/backends/jai-vendor/types.mjs';
import { ConfigurationError, BackendError } from '../lib/core/errors.mjs';
import {
    ProviderType,
    EnvKey,
    DEFAULT_OPENAI_URL,
    DEFAULT_OPENROUTER_URL,
    DEFAULT_OPENCODE_URL,
    DEFAULT_LOCAL_URL,
} from '../lib/core/constants/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/**
 * @param {{events: Array<any>}} arg0
 */
const feed = ({ events }) => (async function* () { for (const e of events) yield e; })();

/**
 * @param {{gen: AsyncIterable<any>}} arg0
 */
const collect = async ({ gen }) => {
    const out = [];
    for await (const e of gen) out.push(e);
    return out;
};

/**
 * @param {{assign: Record<string, string|undefined>, fn: () => any}} arg0
 */
async function withEnv({ assign, fn }) {
    const saved = /** @type {Record<string, string|undefined>} */ ({});
    for (const k of Object.keys(assign)) {
        saved[k] = process.env[k];
        if (assign[k] === undefined) delete process.env[k];
        else process.env[k] = assign[k];
    }
    try {
        return await fn();
    } finally {
        for (const k of Object.keys(assign)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

describe('1. OpenAI Backend Default baseURL & Credential Routing', () => {
    test('derives default baseURL from options.provider before resolving API key', async () => {
        await withEnv({
            assign: {
                [EnvKey.OPENAI_API_KEY]: 'sk-oa-env',
                [EnvKey.OPENROUTER_API_KEY]: 'sk-or-env',
                [EnvKey.OPENCODE_API_KEY]: 'sk-oc-env',
            },
            fn: () => {
                const oa = /** @type {any} */ (new OAIClient({ options: { provider: ProviderType.OPENAI } }));
                assert.equal(oa.provider, ProviderType.OPENAI);
                assert.equal(oa.transport.baseURL, DEFAULT_OPENAI_URL);
                assert.equal(oa.transport.apiKey, 'sk-oa-env');

                const or = /** @type {any} */ (new OAIClient({ options: { provider: ProviderType.OPENROUTER } }));
                assert.equal(or.provider, ProviderType.OPENROUTER);
                assert.equal(or.transport.baseURL, DEFAULT_OPENROUTER_URL);
                assert.equal(or.transport.apiKey, 'sk-or-env');

                const oc = /** @type {any} */ (new OAIClient({ options: { provider: ProviderType.OPENCODE } }));
                assert.equal(oc.provider, ProviderType.OPENCODE);
                assert.equal(oc.transport.baseURL, DEFAULT_OPENCODE_URL);
                assert.equal(oc.transport.apiKey, 'sk-oc-env');

                const local = /** @type {any} */ (new OAIClient({ options: { provider: ProviderType.LOCAL, apiKey: 'local' } }));
                assert.equal(local.provider, ProviderType.LOCAL);
                assert.equal(local.transport.baseURL, DEFAULT_LOCAL_URL);
            }
        });
    });

    test('resolves OPENAI_API_KEY when backend is openai and baseURL has a trailing slash', async () => {
        await withEnv({
            assign: {
                [EnvKey.OPENAI_API_KEY]: 'sk-oa-slash',
                [EnvKey.OPENROUTER_API_KEY]: undefined,
            },
            fn: () => {
                const oa = /** @type {any} */ (new OAIClient({
                    options: { provider: ProviderType.OPENAI, baseURL: `${DEFAULT_OPENAI_URL}/` }
                }));
                assert.equal(oa.transport.apiKey, 'sk-oa-slash');
            }
        });
    });

    test('preserves explicit opencodeSessionId on session and uses it for x-opencode-session header', async () => {
        const client = new OAIClient({
            options: {
                provider: ProviderType.OPENCODE,
                apiKey: 'sk-oc',
                opencodeSessionId: 'explicit-oc-session-42',
            }
        });
        const session = client.session('gpt-4o');
        assert.equal(session.opencodeSessionId, 'explicit-oc-session-42');
        assert.notEqual(session.sessionId, 'explicit-oc-session-42');

        /** @type {any[]} */
        const captured = [];
        const vendorClient = {
            chat: { completions: { create: async (/** @type {any} */ _b, /** @type {any} */ opts) => { captured.push(opts); return {}; } } },
            responses: { create: async (/** @type {any} */ _b, /** @type {any} */ opts) => { captured.push(opts); return {}; } },
        };
        await oaiAdapter.executeVendorRequest({
            vendorClient,
            request: { model: 'm', messages: [] },
            signal: undefined,
            session,
        });
        assert.equal(captured[0].headers['x-opencode-session'], 'explicit-oc-session-42');
    });
});

describe('2. JAI SSE Parser Termination, Line Cap & Multi-Choice Tool Calls', () => {
    test('rejects a single >1 MiB line ending with \\n with SSEError before parsing', async () => {
        const huge = `data: {"type":"Content","content":"${'a'.repeat(1024 * 1024 + 32)}"}\n`;
        const stream = feed({ events: [huge] });
        await assert.rejects(
            async () => {
                for await (const _ of readSSELines({ stream, parser: new SSEParser() })) {
                    // should throw before yielding
                }
            },
            (err) => err instanceof SSEError && /exceeds/.test(err.message)
        );
    });

    test('terminates immediately on data: end and data: [DONE] without hanging on keep-alive streams', async () => {
        for (const marker of ['data: end\n', 'data: [DONE]\n']) {
            let hungReached = false;
            const keepAliveStream = (async function* () {
                yield 'data: {"type":"Content","content":"hello"}\n';
                yield marker;
                await new Promise((resolve) => setTimeout(resolve, 60_000));
                hungReached = true;
            })();
            const out = await collect({ gen: readSSELines({ stream: keepAliveStream, parser: new SSEParser() }) });
            assert.equal(out.length, 1);
            assert.equal(out[0].content, 'hello');
            assert.equal(hungReached, false);
        }
    });

    test('multi-choice ToolCall streams with parallelToolIndex: 0 on choice 0 and choice 1 do not collide or flush prematurely', () => {
        const parser = new SSEParser();
        const d0 = parser.parseLine({
            line: 'data: {"type":"ToolCall","choiceIndex":0,"parallelToolIndex":0,"id":"call_c0","name":"alpha","content":"{\\"a\\":1}"}'
        });
        const d1 = parser.parseLine({
            line: 'data: {"type":"ToolCall","choiceIndex":1,"parallelToolIndex":0,"id":"call_c1","name":"beta","content":"{\\"b\\":"}'
        });
        assert.equal(d0?.choiceIndex, 0);
        assert.equal(d1?.choiceIndex, 1);
        // Choice 0 finishes while Choice 1 is still streaming
        parser.parseLine({ line: 'data: {"type":"FinishMetadata","choiceIndex":0,"reason":"tool_call"}' });
        parser.parseLine({
            line: 'data: {"type":"ToolCall","choiceIndex":1,"parallelToolIndex":0,"id":"call_c1","content":"2}"}'
        });
        parser.parseLine({ line: 'data: {"type":"FinishMetadata","choiceIndex":1,"reason":"tool_call"}' });
        const { toolCalls } = parser.getFinalResult();
        assert.equal(toolCalls.length, 2);
        assert.deepEqual(toolCalls.map((c) => c.id), ['call_c0', 'call_c1']);
        assert.deepEqual(toolCalls.map((c) => c.name), ['alpha', 'beta']);
        assert.deepEqual(toolCalls.map((c) => c.arguments), ['{"a":1}', '{"b":2}']);

        // Out-of-order choice completion still returns deterministic (choiceIndex, parallelToolIndex) order
        const outOfOrder = new SSEParser();
        outOfOrder.parseLine({
            line: 'data: {"type":"ToolCall","choiceIndex":1,"parallelToolIndex":0,"id":"c1_0","name":"second","content":"{}"}'
        });
        outOfOrder.parseLine({ line: 'data: {"type":"FinishMetadata","choiceIndex":1,"reason":"tool_call"}' });
        outOfOrder.parseLine({
            line: 'data: {"type":"ToolCall","choiceIndex":0,"parallelToolIndex":0,"id":"c0_0","name":"first","content":"{}"}'
        });
        outOfOrder.parseLine({ line: 'data: {"type":"FinishMetadata","choiceIndex":0,"reason":"tool_call"}' });
        assert.deepEqual(outOfOrder.getFinalResult().toolCalls.map((c) => c.id), ['c0_0', 'c1_0']);
    });
});

describe('3. JAI Transport & Session Fixes', () => {
    test('premature-end backoff rethrows when signal aborts during sleep', async () => {
        const ac = new AbortController();
        const httpClient = {
            streamTimeout: 5000,
            getEventEmitter: () => new EventEmitter(),
            _fetchWithRetry: async () => {
                setTimeout(() => ac.abort(new Error('user cancelled during backoff')), 30);
                return {
                    body: new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode('data: {"type":"PrematureEnd","reason":"Unknown"}\ndata: end\n'));
                            controller.close();
                        }
                    })
                };
            }
        };
        const session = new JaiVendorChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'test-profile' });
        await assert.rejects(
            async () => {
                for await (const _ of session.stream({ initialInput: 'hi', options: { signal: ac.signal } })) {
                    // consume
                }
            },
            /aborted|cancelled/i
        );
    });

    test('non-Error rejection without .message in stream loop does not throw TypeError', async () => {
        const httpClient = {
            streamTimeout: 5000,
            getEventEmitter: () => new EventEmitter(),
            _fetchWithRetry: async () => ({
                body: {
                    pipeThrough: () => (async function* () {
                        yield 'data: {"type":"Content","content":"part"}\n';
                        throw 'raw timeout string without message prop';
                    })()
                }
            })
        };
        const session = new JaiVendorChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'test-profile' });
        const out = await collect({ gen: session.stream({ initialInput: 'hi' }) });
        assert.ok(out.some((e) => e.type === 'error' && e.error_type === 'timeout'));
    });

    test('forwards X-Merci-Session-Id from jaiAdapter.executeVendorRequest through chat-session.stream into _fetchWithRetry', async () => {
        /** @type {any[]} */
        const captured = [];
        const httpClient = {
            streamTimeout: 5000,
            getEventEmitter: () => new EventEmitter(),
            _fetchWithRetry: async (/** @type {any} */ req) => {
                captured.push(req);
                return {
                    body: new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode('data: {"type":"Content","content":"ok"}\ndata: end\n'));
                            controller.close();
                        }
                    })
                };
            }
        };
        const vendorSession = new JaiVendorChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'test-profile' });
        /** @type {any} */ (vendorSession).sessionId = 'merci-sess-99';
        const raw = await jaiAdapter.executeVendorRequest({
            vendorClient: {},
            request: { session: vendorSession, messages: [{ type: 'user_message', content: 'hi' }], isLastIteration: false, runContext: null },
            signal: undefined,
            session: /** @type {any} */ (vendorSession),
        });
        await collect({ gen: /** @type {any} */ (raw) });
        assert.equal(captured.length, 1);
        assert.equal(captured[0].options.headers['X-Merci-Session-Id'], 'merci-sess-99');
    });

    test('InternalHttpClient: emitter-less operation, header redaction, streamTimeout validation, token & key validation', async () => {
        const client = new InternalHttpClient({ options: { token: 'initial-tok', streamTimeout: 0 } });
        assert.equal(client.streamTimeout, 150_000);
        const negClient = new InternalHttpClient({ options: { token: 'initial-tok', streamTimeout: -50 } });
        assert.equal(negClient.streamTimeout, 150_000);

        assert.throws(
            () => new InternalHttpClient({ options: { token: 't', tokenPersistKey: 'BAD-KEY\nINJECT=1' } }),
            ConfigurationError
        );

        const emitter = new EventEmitter();
        /** @type {any[]} */
        const reqEvents = [];
        emitter.on(EVENTS.CLIENT.API_REQUEST, (e) => reqEvents.push(e));
        const clientWithEmitter = new InternalHttpClient({ options: { token: 'initial-tok' }, eventEmitter: emitter });

        const origFetch = globalThis.fetch;
        try {
            globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
            await client._fetchWithRetry({ path: '/test', options: { method: 'GET' } });
            await clientWithEmitter._fetchWithRetry({
                path: '/test',
                options: {
                    method: 'GET',
                    headers: {
                        Authorization: 'Bearer secret',
                        Cookie: 'sid=123',
                        'Set-Cookie': 'sid=123',
                        'X-API-Key': 'k-123',
                    }
                }
            });
            assert.equal(reqEvents.length, 1);
            assert.equal(reqEvents[0].headers.Authorization, '[REDACTED]');
            assert.equal(reqEvents[0].headers.Cookie, '[REDACTED]');
            assert.equal(reqEvents[0].headers['Set-Cookie'], '[REDACTED]');
            assert.equal(reqEvents[0].headers['X-API-Key'], '[REDACTED]');

            globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({ token: 'bad\ntoken' }), { status: 200 }));
            await assert.rejects(() => client.refreshToken(), APIError);
            assert.equal(client.token, 'initial-tok');

            // Invalid JSON on 200 OK refresh throws APIError and emits TOKEN_REFRESH_FAILURE exactly once
            let failures = 0;
            emitter.on(EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, () => { failures++; });
            globalThis.fetch = /** @type {any} */ (async () => new Response('not-json', { status: 200 }));
            await assert.rejects(
                () => clientWithEmitter.refreshToken(),
                (err) => err instanceof APIError && /Invalid JSON/.test(err.message)
            );
            assert.equal(failures, 1);

            // 401 cancels the 401 response body before refreshing and does not arm bodyTimeoutMs on 401
            let cancelled401 = false;
            let callNum = 0;
            globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url) => {
                if (String(url).includes('/auth/jwt/refresh/v3')) {
                    return new Response(JSON.stringify({ token: 'fresh-tok' }), { status: 200 });
                }
                callNum++;
                if (callNum === 1) {
                    const body = new ReadableStream({
                        cancel() { cancelled401 = true; }
                    });
                    return new Response(body, { status: 401 });
                }
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            });
            const res = await clientWithEmitter._fetchWithRetry({ path: '/test', options: { method: 'GET', bodyTimeoutMs: 50 } });
            assert.equal(res.status, 200);
            assert.equal(cancelled401, true);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test('ProfileManager, TaskAPI.roster, and QuotaAPI.get pass headerTimeoutMs alongside bodyTimeoutMs', async () => {
        /** @type {any[]} */
        const seenOpts = [];
        const httpClient = {
            streamTimeout: 1000,
            _fetchWithRetry: async (/** @type {any} */ { options }) => {
                seenOpts.push(options);
                return { json: async () => ({ profiles: [], current: { quotaID: 'q1' } }) };
            }
        };
        const pm = new ProfileManager({ httpClient: /** @type {any} */ (httpClient), cacheTTL: 0 });
        await pm.getProfiles();
        const tasks = new TaskAPI({ httpClient: /** @type {any} */ (httpClient) });
        await tasks.roster();
        const quota = new QuotaAPI({ httpClient: /** @type {any} */ (httpClient) });
        await quota.get();
        assert.equal(seenOpts.length, 3);
        for (const opts of seenOpts) {
            assert.equal(typeof opts.headerTimeoutMs, 'number');
            assert.ok(opts.headerTimeoutMs > 0);
            assert.equal(opts.headerTimeoutMs, opts.bodyTimeoutMs);
        }
    });

    test('TaskSSEParserV5 and TaskAPI: PrematureEnd, parse_error, typed BackendError, and :tag split in executeJson', async () => {
        const taskParser = new TaskSSEParserV5();
        assert.deepEqual(
            taskParser.parseLine({ line: 'data: {"type":"PrematureEnd","reason":"QuotaExceeded"}' }),
            { type: 'PrematureEnd', reason: 'QuotaExceeded' }
        );

        /** @type {any[]} */
        const seenCalls = [];
        const makeTaskApi = (/** @type {string[]} */ lines) => new TaskAPI({
            httpClient: {
                streamTimeout: 5000,
                _fetchWithRetry: async (/** @type {any} */ req) => {
                    seenCalls.push(req);
                    return {
                        body: new ReadableStream({
                            start(c) {
                                c.enqueue(new TextEncoder().encode(lines.join('\n') + '\n'));
                                c.close();
                            }
                        })
                    };
                }
            }
        });

        await assert.rejects(
            () => makeTaskApi(['data: {"type":"PrematureEnd","reason":"Interrupted"}', 'data: end']).execute({ id: 't1', parameters: {} }),
            (err) => err instanceof BackendError && /prematurely/i.test(err.message)
        );
        await assert.rejects(
            () => makeTaskApi(['data: {corrupt', 'data: end']).execute({ id: 't1', parameters: {} }),
            (err) => err instanceof BackendError && /Failed to parse/i.test(err.message)
        );
        await assert.rejects(
            () => makeTaskApi(['data: {"type":"PrematureEnd","reason":"Interrupted"}', 'data: end']).executeJson({ taskId: 'web-search', parameters: {} }),
            (err) => err instanceof BackendError && /prematurely/i.test(err.message)
        );
        await assert.rejects(
            () => makeTaskApi(['data: {corrupt', 'data: end']).executeJson({ taskId: 'web-search', parameters: {} }),
            (err) => err instanceof BackendError && /Failed to parse/i.test(err.message)
        );

        seenCalls.length = 0;
        const taggedApi = makeTaskApi([`data: ${JSON.stringify({ type: 'Content', content: '{"ok":true}' })}`, 'data: end']);
        const res = await taggedApi.executeJson({ taskId: 'web-search:canary', parameters: { query: 'test' } });
        assert.equal(res.ok, true);
        assert.equal(seenCalls[0].path, '/task/stream/v4/web-search');
        assert.equal(seenCalls[0].options.headers['Grazie-Task-Tag'], 'canary');
    });

    test('ProfileManager: cacheTTL: 0 disables caching and Object.create(null) prevents prototype pollution', async () => {
        let calls = 0;
        const httpClient = {
            _fetchWithRetry: async () => {
                calls++;
                return {
                    json: async () => ({
                        profiles: [
                            { id: 'gpt-4o', parameters: ['temperature'] },
                            { id: '__proto__', parameters: ['polluted'] },
                        ]
                    })
                };
            }
        };
        const pm = new ProfileManager({ httpClient: /** @type {any} */ (httpClient), cacheTTL: 0 });
        const first = await pm.getProfiles();
        const second = await pm.getProfiles();
        assert.equal(calls, 2);
        assert.equal(Object.getPrototypeOf(first), null);
        assert.equal((/** @type {any} */ ({})).polluted, undefined);
        assert.equal(pm.isSupported({ profileId: 'constructor', paramKey: 'anything' }), true);
        void second;
    });

    test('TaskAPI: validates version in execute and executeJson to prevent path traversal', async () => {
        const tasks = new TaskAPI({
            httpClient: {
                streamTimeout: 1000,
                _fetchWithRetry: async () => { throw new Error('must not reach network'); }
            }
        });
        await assert.rejects(
            () => tasks.execute({ id: 'my-task', parameters: {}, options: { version: '../v4/admin' } }),
            ConfigurationError
        );
        await assert.rejects(
            () => tasks.executeJson({ taskId: 'web-search', parameters: {}, options: { version: '../v4' } }),
            ConfigurationError
        );
    });

    test('formatJaiMessages: strips stale snake_case thought_signature when camelCase thoughtSignature is present', () => {
        const shaped = formatJaiMessages({
            messages: [
                {
                    type: 'assistant_message_tool',
                    id: 'c1',
                    name: 'f',
                    arguments: '{}',
                    thoughtSignature: 'camel-sig',
                    thought_signature: 'stale-snake-sig',
                },
                {
                    type: 'assistant_message_text',
                    content: 'hi',
                    thoughtSignature: 'camel-text',
                    thought_signature: 'stale-snake-text',
                }
            ]
        });
        for (const msg of shaped) {
            assert.equal('thought_signature' in msg, false);
            assert.ok(String(msg.thoughtSignature).startsWith('camel-'));
        }
    });
});

describe('4. OAI, AAI, GAI Adapter & Media Fixes', () => {
    test('oaiAdapter: does not mutate parameters.tools when injecting native web search / scrape tools', () => {
        const originalTools = [{ type: 'function', function: { name: 'my_fn', description: 'd', parameters: {} } }];
        const parameters = { tools: originalTools };
        oaiAdapter.buildVendorRequest({
            model: 'gpt-4o',
            parameters,
            tools: [],
            preparedMessages: [{ role: 'user', content: 'hi' }],
            session: {
                provider: ProviderType.OPENROUTER,
                protocol: 'completions',
                _webSearch: { mode: 'native' },
                _webScrape: { mode: 'native' },
            },
        });
        assert.equal(originalTools.length, 1);
        assert.equal(parameters.tools.length, 1);
    });

    test('oaiAdapter: processes finish_reason without delta, defaults missing tool_call index to 0, surfaces delta.refusal, and computes fallback total_tokens', async () => {
        const out = await collect({
            gen: oaiAdapter.consumeStream({
                rawStream: feed({
                    events: [
                        {
                            choices: [{
                                delta: {
                                    refusal: 'Refused by policy',
                                    tool_calls: [{ id: 'tc_no_idx', function: { name: 'fn', arguments: '{"x":1}' } }],
                                }
                            }]
                        },
                        { choices: [{ finish_reason: 'length' }] },
                        { usage: { prompt_tokens: 4, completion_tokens: 6 } },
                    ]
                }),
                signal: undefined,
            })
        });
        assert.ok(out.some((e) => e.type === 'error' && e.error_type === 'refusal' && e.error_message === 'Refused by policy'));
        assert.ok(out.some((e) => e.type === 'truncated'));
        const tcEvent = out.find((e) => e.type === 'tool_calls');
        assert.equal(tcEvent?.calls.length, 1);
        assert.equal(tcEvent?.calls[0].id, 'tc_no_idx');
        const quota = out.find((e) => e.type === 'quota');
        assert.equal(quota?.data.spent.amount, 10);
    });

    test('W2B-7: an OAI error chunk that is a string or double-wrapped keeps the vendor text', async () => {
        const asString = await collect({
            gen: oaiAdapter.consumeStream({ rawStream: feed({ events: [{ error: 'gateway exploded' }] }), signal: undefined })
        });
        assert.equal(asString.find((e) => e.type === 'error')?.error_message, 'gateway exploded', 'a string error is the message, not the fallback sentence');

        const wrapped = await collect({
            gen: oaiAdapter.consumeStream({ rawStream: feed({ events: [{ error: { error: { message: 'wrapped vendor text' } } }] }), signal: undefined })
        });
        assert.equal(wrapped.find((e) => e.type === 'error')?.error_message, 'wrapped vendor text', 'a double-wrapped error keeps the vendor text');
    });

    test('oaiAdapter: Responses API guards non-array web_search_call sources/results, surfaces response.failed 400 status/message, and computes fallback usage', async () => {
        const out = await collect({
            gen: oaiAdapter.consumeStream({
                rawStream: feed({
                    events: [
                        {
                            type: 'response.output_item.done',
                            item: { type: 'web_search_call', action: { sources: { not: 'an array' } }, results: 'invalid' }
                        },
                        {
                            type: 'response.completed',
                            response: { usage: { input_tokens: 3, output_tokens: 7 } }
                        },
                        {
                            type: 'response.failed',
                            response: { error: { code: 'invalid_json_schema', message: 'Invalid schema for response_format' } }
                        }
                    ]
                }),
                signal: undefined,
            })
        });
        const quota = out.find((e) => e.type === 'quota');
        assert.equal(quota?.data.spent.amount, 10);
        const err = out.find((e) => e.type === 'error');
        assert.equal(err?.error_message, 'Invalid schema for response_format');
        assert.equal(err?.status, 400);
        assert.equal(err?.error_type, 'invalid_json_schema');
    });

    test('oai/aai/gai formatToolCall prefers call.id || result?.id || result?.tool_call_id', () => {
        for (const adapter of [oaiAdapter, aaiAdapter, gaiAdapter]) {
            const formatted = adapter.formatToolCall({
                call: { name: 'fn', arguments: '{}' },
                result: { tool_call_id: 'minted-id-123' },
                index: 0,
            });
            assert.equal(formatted.id, 'minted-id-123');
        }
    });

    test('aaiAdapter: parallelToolCalls(false) without explicit toolChoice and _jsonMode with session tools', () => {
        const sessionTools = [{ name: 'weather', description: 'get weather', parameters: { type: 'object', properties: {} } }];
        const req1 = aaiAdapter.buildVendorRequest({
            model: 'claude',
            parameters: { parallelToolCalls: false },
            tools: sessionTools,
            preparedMessages: [],
        });
        assert.deepEqual(req1.request.tool_choice, { type: 'auto', disable_parallel_tool_use: true });

        const req2 = aaiAdapter.buildVendorRequest({
            model: 'claude',
            parameters: { _jsonMode: true, _jsonSchema: { type: 'object', properties: {} } },
            tools: sessionTools,
            preparedMessages: [],
        });
        assert.equal(req2.request.tools.length, 1);
        assert.equal(req2.request.tools[0].name, 'weather');
        assert.equal(req2.request.tool_choice, undefined);
    });

    test('gaiAdapter: preserves session tools in application/json mode, deduplicates functionCalls by id, and computes fallback totalTokenCount', async () => {
        const sessionTools = [{ name: 'weather', description: 'get weather', parameters: { type: 'object', properties: {} } }];
        const req = gaiAdapter.buildVendorRequest({
            model: 'gemini',
            parameters: { responseMimeType: 'application/json' },
            tools: sessionTools,
            preparedMessages: [],
        });
        assert.equal(req.request.config.toolConfig, undefined);

        const out = await collect({
            gen: gaiAdapter.consumeStream({
                rawStream: feed({
                    events: [
                        { functionCalls: [{ id: 'fc_1', name: 'lookup', args: { q: 'a' } }] },
                        { functionCalls: [{ id: 'fc_1', name: 'lookup', args: { q: 'a' } }] },
                        { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 9 } },
                    ]
                }),
                signal: undefined,
            })
        });
        const tcEvent = out.find((e) => e.type === 'tool_calls');
        assert.equal(tcEvent?.calls.length, 1);
        assert.equal(tcEvent?.calls[0].id, 'fc_1');
        const quota = out.find((e) => e.type === 'quota');
        assert.equal(quota?.data.spent.amount, 20);
    });

    test('createUnifiedMediaMessages: throws ConfigurationError when PDF is passed to unsupported backends', async () => {
        // OpenRouter supports PDFs (the OpenAI file part), so it is no longer in this list.
        for (const provider of [ProviderType.OPENCODE, ProviderType.LOCAL]) {
            await assert.rejects(
                () => createUnifiedMediaMessages({ provider, prompt: 'read this', imagePath: '/tmp/doc.pdf' }),
                ConfigurationError
            );
        }
    });

    test('Defect 4: oaiAdapter strict schema ($defs/definitions/anyOf/oneOf/typeless properties) and tool merging across OAI/AAI/JAI', () => {
        const respReq = oaiAdapter.buildVendorRequest({
            model: 'gpt-4o',
            parameters: {
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'complex',
                        schema: {
                            properties: {
                                item: {
                                    anyOf: [{ properties: { a: { type: 'string' } } }],
                                    oneOf: [{ type: 'object', properties: { b: { type: 'number' } } }],
                                }
                            },
                            $defs: {
                                Sub: { properties: { c: { type: 'boolean' } } }
                            },
                            definitions: {
                                Legacy: { type: 'object', properties: { d: { type: 'string' } } }
                            }
                        }
                    }
                },
                tools: [{ name: 'param_tool', description: 'from params', parameters: {} }],
            },
            tools: [{ name: 'session_tool', description: 'from session', parameters: {} }],
            preparedMessages: [],
            session: { protocol: 'responses', provider: ProviderType.OPENAI },
        });
        const strictSchema = respReq.request.text.format.schema;
        assert.equal(strictSchema.additionalProperties, false);
        assert.deepEqual(strictSchema.required, ['item']);
        assert.equal(strictSchema.properties.item.anyOf[0].additionalProperties, false);
        assert.deepEqual(strictSchema.properties.item.anyOf[0].required, ['a']);
        assert.equal(strictSchema.properties.item.oneOf[0].additionalProperties, false);
        assert.deepEqual(strictSchema.properties.item.oneOf[0].required, ['b']);
        assert.equal(strictSchema.$defs.Sub.additionalProperties, false);
        assert.deepEqual(strictSchema.$defs.Sub.required, ['c']);
        assert.equal(strictSchema.definitions.Legacy.additionalProperties, false);
        assert.deepEqual(strictSchema.definitions.Legacy.required, ['d']);
        assert.deepEqual(respReq.request.tools.map((/** @type {any} */ t) => t.name), ['session_tool', 'param_tool']);

        // Empty parameters.tools with no session tools is omitted, and json_object with session tools does not pin tool_choice: 'none'
        const emptyToolsReq = oaiAdapter.buildVendorRequest({
            model: 'gpt-4o',
            parameters: { tools: [] },
            tools: [],
            preparedMessages: [],
            session: { protocol: 'completions', provider: ProviderType.OPENAI },
        });
        assert.equal(emptyToolsReq.request.tools, undefined);

        const jsonWithSessionTools = oaiAdapter.buildVendorRequest({
            model: 'gpt-4o',
            parameters: { response_format: { type: 'json_object' } },
            tools: [{ name: 'session_tool', description: 'from session', parameters: {} }],
            preparedMessages: [],
            session: { protocol: 'completions', provider: ProviderType.OPENAI },
        });
        assert.equal(jsonWithSessionTools.request.tool_choice, undefined);

        // AAI merges tools and parameters._tools and preserves disable_parallel_tool_use on webSearch force
        const aaiReq = aaiAdapter.buildVendorRequest({
            model: 'claude',
            parameters: {
                parallelToolCalls: false,
                _tools: [{ name: 'param_tool', description: 'p', input_schema: { type: 'object', properties: {} } }],
            },
            tools: [{ name: 'session_tool', description: 's', parameters: { type: 'object', properties: {} } }],
            preparedMessages: [],
            session: { _webSearch: { mode: 'native', force: true } },
        });
        assert.deepEqual(aaiReq.request.tools.map((/** @type {any} */ t) => t.name), ['session_tool', 'param_tool', 'web_search']);
        assert.deepEqual(aaiReq.request.tool_choice, { type: 'any', disable_parallel_tool_use: true });

        // JAI builds toolConfig when only params._tools is provided and merges with session tools
        const emitter = new EventEmitter();
        const jaiSession = /** @type {any} */ (new JaiAgenticChatSession({
            httpClient: /** @type {any} */ ({ streamTimeout: 1000, getEventEmitter: () => emitter, _fetchWithRetry: async () => ({}) }),
            profile: 'jai-model',
            eventEmitter: emitter,
            profileManager: undefined,
        }));
        jaiSession.withParameters({
            params: { tools: [{ name: 'param_tool', description: 'p', parameters: { type: 'object', properties: {} } }] }
        });
        assert.equal(jaiSession._parameters.toolConfig.tools.length, 1);
        assert.equal(jaiSession._parameters.toolConfig.tools[0].name, 'param_tool');

        jaiSession.withTools({ tools: [{ name: 'session_tool', description: 's', parameters: { type: 'object', properties: {} } }] });
        assert.deepEqual(jaiSession._parameters.toolConfig.tools.map((/** @type {any} */ t) => t.name), ['session_tool', 'param_tool']);
    });
});
