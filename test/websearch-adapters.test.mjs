// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { WEB_SEARCH_TOOL_NAME } from '../lib/core/constants/index.mjs';
import { ProviderType, StandardType } from '../lib/core/constants/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';

const NATIVE = { mode: 'native' };
const FALLBACK = { mode: 'native_with_tavily_fallback' };

/** @param {{emitter: any, name?: any}} arg0 */
/** @param {{emitter: *, name?: *}} arg0 */
/** @param {{emitter: *, name?: *}} arg0 */
const warnings = ({ emitter, name = EVENTS.CLIENT.PARAMETER_WARNING }) => {
    /** @type {any[]} */
    const out = [];
    emitter.on(name, (/** @type {any} */ e) => out.push(e));
    return out;
};

/** @param {{provider: any, ws: any, protocol?: any}} arg0 */
/** @param {{provider: *, ws: *, protocol?: *}} arg0 */
/** @param {{provider: *, ws: *, protocol?: *}} arg0 */
const nativeSession = ({ provider, ws, protocol = 'responses' }) => ({
    protocol,
    provider,
    _webSearch: ws,
    eventEmitter: new EventEmitter(),
});


/** @param {any} session */
/** @param {{session: *}} arg0 */
/** @param {{session: *}} arg0 */
const oaiResponses = ({ session }) => (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
    model: 'gpt-4o', parameters: {}, tools: [], preparedMessages: [],
    forceTextResponse: false, toolChoiceRequired: false, session,
});

test('OAI responses: OpenAI-native web_search appended verbatim (filters + user_location)', () => {
    const session = nativeSession({ provider: ProviderType.OPENAI, ws: {
        ...NATIVE, allowedDomains: ['a.com'], location: { type: 'approximate' },
    } });
    const { request } = oaiResponses({ session });
    const tool = request.tools.find((/** @type {any} */ t) => t.type === 'web_search');
    assert.deepEqual(tool, {
        type: 'web_search',
        filters: { allowed_domains: ['a.com'] },
        user_location: { type: 'approximate' },
    });
});

test('OAI responses: web_search omits filters/location when not set', () => {
    const { request } = oaiResponses({ session: nativeSession({ provider: ProviderType.OPENAI, ws: NATIVE }) });
    const tool = request.tools.find((/** @type {any} */ t) => t.type === 'web_search');
    assert.deepEqual(tool, { type: 'web_search' });
});

test('OAI responses: OPENCODE injects nothing', () => {
    const { request } = oaiResponses({ session: nativeSession({ provider: ProviderType.OPENCODE, ws: NATIVE }) });
    assert.ok(!request.tools || !request.tools.some((/** @type {any} */ t) => t.type === 'web_search'));
});

test('OAI responses: OpenRouter gets openrouter:web_search with nested parameters', () => {
    const session = nativeSession({ provider: ProviderType.OPENROUTER, ws: { ...NATIVE, maxResults: 7 } });
    const { request } = oaiResponses({ session });
    assert.deepEqual(request.tools.find((/** @type {any} */ t) => t.type === 'openrouter:web_search'), {
        type: 'openrouter:web_search', parameters: { max_results: 7 },
    });
});

test('OAI responses: OpenRouter maps domain filters to allowed/excluded parameters', () => {
    const session = nativeSession({
        provider: ProviderType.OPENROUTER,
        ws: { ...NATIVE, allowedDomains: ['a.com'], blockedDomains: ['b.com'] },
    });
    const warned = warnings({ emitter: session.eventEmitter });
    const { request } = oaiResponses({ session });
    assert.deepEqual(request.tools.find((/** @type {any} */ t) => t.type === 'openrouter:web_search'), {
        type: 'openrouter:web_search',
        parameters: { allowed_domains: ['a.com'], excluded_domains: ['b.com'] },
    });
    assert.equal(warned.length, 0, 'the domains are injected, not warned about');
});

test('OAI responses: force=true sets tool_choice required', () => {
    const { request } = oaiResponses({ session: nativeSession({ provider: ProviderType.OPENAI, ws: { ...NATIVE, force: true } }) });
    assert.equal(request.tool_choice, 'required');
});

test('OAI responses: force text response wins over web search force', () => {
    const session = nativeSession({ provider: ProviderType.OPENAI, ws: { ...NATIVE, force: true } });
    const { request } = (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'gpt-4o', parameters: {}, tools: [], preparedMessages: [],
        forceTextResponse: true, toolChoiceRequired: false, session,
    });
    assert.equal(request.tool_choice, 'none');
});

test('OAI completions: OpenRouter gets openrouter:web_search (its native wire)', () => {
    const session = nativeSession({ provider: ProviderType.OPENROUTER, ws: { ...NATIVE, maxResults: 7 }, protocol: 'completions' });
    const warned = warnings({ emitter: session.eventEmitter });
    const { request } = (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'gpt-4o', parameters: {}, tools: [], preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false, session,
    });
    assert.deepEqual(request.tools.find((/** @type {any} */ t) => t.type === 'openrouter:web_search'), {
        type: 'openrouter:web_search', parameters: { max_results: 7 },
    });
    assert.equal(warned.length, 0);
});

test('OAI completions: non-OpenRouter backends warn and inject nothing', () => {
    const session = nativeSession({ provider: ProviderType.OPENAI, ws: NATIVE, protocol: 'completions' });
    const warned = warnings({ emitter: session.eventEmitter });
    const { request } = (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'gpt-4o', parameters: {}, tools: [], preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false, session,
    });
    assert.equal(warned.length, 1);
    assert.equal(warned[0].parameter, 'web_search');
    assert.equal(warned[0].standard, StandardType.OAI);
    assert.ok(!request.tools, 'no tools injected on completions wire');
});

test('OAI completions: the search warning names the measured schema limit', () => {
    const session = nativeSession({ provider: ProviderType.OPENAI, ws: NATIVE, protocol: 'completions' });
    const warned = warnings({ emitter: session.eventEmitter });
    (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'gpt-4o', parameters: {}, tools: [], preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false, session,
    });
    const message = String(warned[0]?.message ?? '');
    assert.match(message, /web_search_options/, 'names the chat field the warning is about');
    assert.match(message, /user_location/, 'names the only fields the chat schema carries');
    assert.match(message, /search_context_size/);
    assert.match(message, /domain filters/i, 'says why the leg cannot honour the SDK knobs');
    assert.match(message, /deprecated/, 'names the model-status reason');
});

test('OAI completions: parameters.web_search_options passes through (the documented escape hatch)', () => {
    const session = nativeSession({ provider: ProviderType.OPENAI, ws: undefined, protocol: 'completions' });
    const { request } = (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'gpt-4o',
        parameters: { web_search_options: { search_context_size: 'low' } },
        tools: [], preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false, session,
    });
    assert.deepEqual(request.web_search_options, { search_context_size: 'low' });
});

test('OAI: mode off/tavily/absent changes nothing', () => {
    for (const ws of [undefined, { mode: 'off' }, { mode: 'tavily' }]) {
        const session = { protocol: 'responses', provider: ProviderType.OPENAI, _webSearch: ws, eventEmitter: new EventEmitter() };
        const { request } = oaiResponses({ session });
        assert.ok(!request.tools || !request.tools.some((/** @type {any} */ t) => t.type === 'web_search'), `mode ${ws?.mode} must not inject`);
        assert.equal(request.tool_choice, undefined);
    }
});


/** @param {any} session */
/** @param {{session: *}} arg0 */
/** @param {{session: *}} arg0 */
const gaiBuild = ({ session }) => (/** @type {any} */ (gaiAdapter)).buildVendorRequest({
    model: 'gemini', parameters: {}, tools: [], preparedMessages: [],
    forceTextResponse: false, toolChoiceRequired: false, session,
});

test('GAI: Gemini tier drops excludeDomains with a warning', () => {
    const session = nativeSession({ provider: ProviderType.GOOGLE_GENAI, ws: { ...NATIVE, blockedDomains: ['b.com'] } });
    const warned = warnings({ emitter: session.eventEmitter });
    const { request } = gaiBuild({ session });
    assert.deepEqual(request.config.tools.find((/** @type {any} */ t) => t.googleSearch), {
        googleSearch: {},
    });
    assert.equal(warned.length, 1);
    assert.equal(warned[0].parameter, 'webSearch.blockedDomains');
});

test('GAI: Vertex tier keeps excludeDomains from blockedDomains', () => {
    const session = nativeSession({ provider: ProviderType.VERTEX, ws: { ...NATIVE, blockedDomains: ['b.com'] } });
    const warned = warnings({ emitter: session.eventEmitter });
    const { request } = gaiBuild({ session });
    assert.deepEqual(request.config.tools.find((/** @type {any} */ t) => t.googleSearch), {
        googleSearch: { excludeDomains: ['b.com'] },
    });
    assert.equal(warned.length, 0);
});

test('GAI: allowedDomains unsupported → parameter_warning, no allow field', () => {
    const session = nativeSession({ provider: ProviderType.GOOGLE_GENAI, ws: { ...NATIVE, allowedDomains: ['a.com'] } });
    const warned = warnings({ emitter: session.eventEmitter });
    const { request } = gaiBuild({ session });
    assert.equal(warned.length, 1);
    assert.equal(warned[0].parameter, 'webSearch.allowedDomains');
    assert.ok(!JSON.stringify(request.config.tools).includes('allowedDomains'));
});

test('GAI: force=true pins toolConfig to ANY', () => {
    const { request } = gaiBuild({ session: nativeSession({ provider: ProviderType.GOOGLE_GENAI, ws: { ...NATIVE, force: true } }) });
    assert.deepEqual(request.config.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
});

test('GAI: absent mode injects nothing', () => {
    const { request } = gaiBuild({ session: { protocol: 'responses', provider: ProviderType.GOOGLE_GENAI, _webSearch: undefined } });
    assert.ok(!request.config.tools, 'no tools when _webSearch absent');
});


/** @param {any} session */
/** @param {{session: *}} arg0 */
/** @param {{session: *}} arg0 */
const aaiBuild = ({ session }) => (/** @type {any} */ (aaiAdapter)).buildVendorRequest({
    model: 'claude', parameters: {}, tools: [], preparedMessages: [],
    forceTextResponse: false, toolChoiceRequired: false, session,
});

/** @param {any} request */
/** @param {{request: *}} arg0 */
/** @param {{request: *}} arg0 */
const aaiWebTool = ({ request }) => request.tools.find((/** @type {any} */ t) => t.type === 'web_search_20260209');

test('AAI: web_search_20260209 appended with max_uses + allowed_domains + user_location', () => {
    const session = nativeSession({ provider: ProviderType.ANTHROPIC, ws: {
        ...NATIVE, maxUses: 3, allowedDomains: ['a.com'], location: { type: 'approximate', city: 'NYC' },
    } });
    const { request } = aaiBuild({ session });
    assert.deepEqual(aaiWebTool({ request }), {
        type: 'web_search_20260209', name: 'web_search',
        max_uses: 3, allowed_callers: ['direct'],
        allowed_domains: ['a.com'], user_location: { type: 'approximate', city: 'NYC' },
    });
});

test('AAI: blocked_domains used when no allowed_domains (never both)', () => {
    const session = nativeSession({ provider: ProviderType.ANTHROPIC, ws: { ...NATIVE, blockedDomains: ['b.com'] } });
    const tool = aaiWebTool({ request: aaiBuild({ session }).request });
    assert.ok(!('allowed_domains' in tool));
    assert.deepEqual(tool.blocked_domains, ['b.com']);
    const both = nativeSession({ provider: ProviderType.ANTHROPIC, ws: { ...NATIVE, allowedDomains: ['a.com'], blockedDomains: ['b.com'] } });
    const tool2 = aaiWebTool({ request: aaiBuild({ session: both }).request });
    assert.deepEqual(tool2.allowed_domains, ['a.com']);
    assert.ok(!('blocked_domains' in tool2));
});

test('AAI: max_uses falls back to maxResults', () => {
    const session = nativeSession({ provider: ProviderType.ANTHROPIC, ws: { ...NATIVE, maxResults: 5 } });
    assert.equal(aaiWebTool({ request: aaiBuild({ session }).request }).max_uses, 5);
});

test('AAI: force=true sets tool_choice any', () => {
    const { request } = aaiBuild({ session: nativeSession({ provider: ProviderType.ANTHROPIC, ws: { ...NATIVE, force: true } }) });
    assert.deepEqual(request.tool_choice, { type: 'any' });
});

test('AAI: absent mode injects nothing', () => {
    const { request } = aaiBuild({ session: { protocol: 'messages', provider: ProviderType.ANTHROPIC, _webSearch: undefined } });
    assert.ok(!request.tools || !aaiWebTool({ request }));
});


/** @param {{session: any, want: any}} arg0 */
/** @param {{session: *, want: *}} arg0 */
/** @param {{session: *, want: *}} arg0 */
const oaiInjected = ({ session, want }) => (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
    model: 'm', parameters: {}, tools: [], preparedMessages: [],
    forceTextResponse: false, toolChoiceRequired: false, session,
}).request.tools?.some((/** @type {any} */ t) => t.type === want) ?? false;

test('mode matrix: builder tool registration agrees with adapter injection', () => {
    /** @type {Array<[string, string|undefined, string, string, boolean, boolean]>} */
    const matrix = [
        [ProviderType.OPENAI, 'responses', 'native', 'native', false, true],
        [ProviderType.OPENAI, 'responses', 'native_with_tavily_fallback', 'native_with_tavily_fallback', true, true],
        [ProviderType.OPENAI, 'responses', 'tavily', 'tavily', true, false],
        [ProviderType.OPENAI, 'responses', 'off', 'off', false, false],
        [ProviderType.OPENAI, 'completions', 'native', 'tavily', true, false],
        [ProviderType.OPENAI, 'completions', 'native_with_tavily_fallback', 'tavily', true, false],
        [ProviderType.OPENROUTER, 'completions', 'native', 'native', false, true],
        [ProviderType.ANTHROPIC, undefined, 'native', 'native', false, true],
        [ProviderType.GOOGLE_GENAI, undefined, 'native', 'native', false, true],
        [ProviderType.LOCAL, 'completions', 'native', 'tavily', true, false],
        [ProviderType.OPENCODE, 'completions', 'native', 'tavily', true, false],
    ];
    for (const [provider, protocol, requested, expectMode, expectTool, expectNative] of matrix) {
        const b = new ChatSessionBuilder();
        b.provider = provider; b.protocol = protocol; b.model = 'm';
        b.withWebSearch({ options: { mode: requested } });
        assert.equal((/** @type {any} */ (b._webSearch)).mode, expectMode, `${provider}/${protocol} ${requested} → mode`);
        assert.equal(b._tools.some((/** @type {any} */ t) => t.name === WEB_SEARCH_TOOL_NAME), expectTool, `${provider}/${protocol} ${requested} → tool leg`);

        const session = { protocol: protocol ?? 'responses', provider, _webSearch: b._webSearch, eventEmitter: new EventEmitter() };
        let native = false;
        if (provider === ProviderType.OPENAI) {
            native = session.protocol === 'responses'
                ? oaiInjected({ session, want: 'web_search' })
                : oaiInjected({ session, want: 'openrouter:web_search' });
        } else if (provider === ProviderType.OPENROUTER) {
            native = oaiInjected({ session, want: 'openrouter:web_search' });
        } else if (provider === ProviderType.ANTHROPIC) {
            native = !!aaiBuild({ session }).request.tools?.some((/** @type {any} */ t) => String(t.type).startsWith('web_search_'));
        } else if (provider === ProviderType.GOOGLE_GENAI) {
            native = !!gaiBuild({ session }).request.config?.tools?.some((/** @type {any} */ t) => t.googleSearch);
        }
        assert.equal(native, expectNative, `${provider}/${protocol} ${requested} → native leg`);
        assert.ok(expectTool || expectNative || requested === 'off', `${provider}/${protocol} ${requested} must have a leg`);
    }
});

test('fallback mode (native_with_tavily_fallback) injects native search on all three', () => {
    const oai = oaiResponses({ session: nativeSession({ provider: ProviderType.OPENAI, ws: FALLBACK }) });
    assert.ok(oai.request.tools.some((/** @type {any} */ t) => t.type === 'web_search'));
    const gai = gaiBuild({ session: nativeSession({ provider: ProviderType.GOOGLE_GENAI, ws: FALLBACK }) });
    assert.ok(gai.request.config.tools.some((/** @type {any} */ t) => t.googleSearch));
    const aai = aaiBuild({ session: nativeSession({ provider: ProviderType.ANTHROPIC, ws: FALLBACK }) });
    assert.ok(aaiWebTool({ request: aai.request }));
});


/** @param {{provider: any, wsc: any}} arg0 */
/** @param {{provider: *, wsc: *}} arg0 */
/** @param {{provider: *, wsc: *}} arg0 */
const scrapeSession = ({ provider, wsc }) => ({
    protocol: 'responses',
    provider,
    _webScrape: wsc,
    eventEmitter: new EventEmitter(),
});

/** @param {any} session */
/** @param {{session: *}} arg0 */
/** @param {{session: *}} arg0 */
const oaiScrape = ({ session }) => (/** @type {any} */ (oaiAdapter)).buildVendorRequest({
    model: 'gpt-4o', parameters: {}, tools: [], preparedMessages: [],
    forceTextResponse: false, toolChoiceRequired: false, session,
});

/** @param {any} request */
/** @param {{request: *}} arg0 */
/** @param {{request: *}} arg0 */
const aaiFetchTool = ({ request }) => request.tools?.find((/** @type {any} */ t) => t.type === 'web_fetch_20260209');

test('OAI responses: OpenRouter gets openrouter:web_fetch with nested parameters', () => {
    const session = scrapeSession({ provider: ProviderType.OPENROUTER, wsc: {
        mode: 'native', maxChars: 12000, allowedDomains: ['a.com'], blockedDomains: ['b.com'],
    } });
    const { request } = oaiScrape({ session });
    assert.deepEqual(request.tools.find((/** @type {any} */ t) => t.type === 'openrouter:web_fetch'), {
        type: 'openrouter:web_fetch',
        parameters: { max_content_tokens: 12000, allowed_domains: ['a.com'], blocked_domains: ['b.com'] },
    });
});

test('OAI responses: non-OpenRouter warns and injects no web_fetch', () => {
    const session = scrapeSession({ provider: ProviderType.OPENAI, wsc: { mode: 'native' } });
    const warned = warnings({ emitter: session.eventEmitter });
    const { request } = oaiScrape({ session });
    assert.equal(warned.length, 1);
    assert.equal(warned[0].parameter, 'web_fetch');
    assert.equal(warned[0].provider, ProviderType.OPENAI);
    assert.equal(warned[0].standard, StandardType.OAI);
    assert.ok(!request.tools || !request.tools.some((/** @type {any} */ t) => t.type === 'openrouter:web_fetch'));
});

test('OAI responses: openrouter:web_fetch omits optional fields when unset', () => {
    const { request } = oaiScrape({ session: scrapeSession({ provider: ProviderType.OPENROUTER, wsc: { mode: 'native' } }) });
    assert.deepEqual(request.tools.find((/** @type {any} */ t) => t.type === 'openrouter:web_fetch'), {
        type: 'openrouter:web_fetch',
    });
});

test('AAI: web_fetch_20260209 appended with max_uses + allowed_domains', () => {
    const session = scrapeSession({ provider: ProviderType.ANTHROPIC, wsc: { mode: 'native', maxUses: 3, allowedDomains: ['a.com'] } });
    assert.deepEqual(aaiFetchTool({ request: aaiBuild({ session }).request }), {
        type: 'web_fetch_20260209', name: 'web_fetch',
        allowed_callers: ['direct'], max_uses: 3, allowed_domains: ['a.com'],
    });
});

test('AAI: blocked_domains used when no allowed_domains', () => {
    const tool = aaiFetchTool({ request: aaiBuild({ session: scrapeSession({ provider: ProviderType.ANTHROPIC, wsc: { mode: 'native', blockedDomains: ['b.com'] } }) }).request });
    assert.ok(!('allowed_domains' in tool));
    assert.deepEqual(tool.blocked_domains, ['b.com']);
});

test('AAI: web_fetch_20260209 injected in all fallback modes, none for off/tavily/absent', () => {
    for (const mode of ['native', 'native_with_tavily_fallback', 'native_with_curl_fallback']) {
        assert.ok(aaiFetchTool({ request: aaiBuild({ session: scrapeSession({ provider: ProviderType.ANTHROPIC, wsc: { mode } }) }).request }), mode);
    }
    for (const wsc of [undefined, { mode: 'off' }, { mode: 'tavily' }]) {
        assert.ok(!aaiFetchTool({ request: aaiBuild({ session: scrapeSession({ provider: ProviderType.ANTHROPIC, wsc }) }).request }), `mode ${wsc?.mode}`);
    }
});

test('GAI: urlContext tool appended for native scrape', () => {
    const { request } = gaiBuild({ session: scrapeSession({ provider: ProviderType.GOOGLE_GENAI, wsc: { mode: 'native' } }) });
    assert.ok(request.config.tools.some((/** @type {any} */ t) => t.urlContext));
});

test('GAI: allowedDomains unsupported → parameter_warning, urlContext still injected', () => {
    const session = scrapeSession({ provider: ProviderType.GOOGLE_GENAI, wsc: { mode: 'native', allowedDomains: ['a.com'] } });
    const warned = warnings({ emitter: session.eventEmitter });
    const { request } = gaiBuild({ session });
    assert.ok(request.config.tools.some((/** @type {any} */ t) => t.urlContext));
    assert.equal(warned.length, 1);
    assert.equal(warned[0].parameter, 'webScrape.allowedDomains');
    assert.equal(warned[0].standard, StandardType.GAI);
});

test('AAI: web_fetch max_uses reads maxUses only — maxResults is not a scrape concept', () => {
    const tool = aaiFetchTool({ request: aaiBuild({ session: scrapeSession({ provider: ProviderType.ANTHROPIC, wsc: { mode: 'native', maxResults: 5 } }) }).request });
    assert.ok(tool, 'web_fetch injected');
    assert.ok(!('max_uses' in tool), 'maxResults must not leak into max_uses');
    const withUses = aaiFetchTool({ request: aaiBuild({ session: scrapeSession({ provider: ProviderType.ANTHROPIC, wsc: { mode: 'native', maxResults: 5, maxUses: 2 } }) }).request });
    assert.equal(withUses.max_uses, 2, 'explicit maxUses wins');
});

/** @param {any} gen */
/** @param {{gen: *}} arg0 */
/** @param {{gen: *}} arg0 */
const drain = async ({ gen }) => {
    const events = [];
    for await (const e of gen) events.push(e);
    return events;
};

test('OAI responses: url_citation annotations + web_search_call results yield a sources event', async () => {
    const stream = (async function* () {
        yield { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://a.com', title: 'A' } };
        yield { type: 'response.output_text.delta', delta: 'answer' };
        yield { type: 'response.output_item.done', item: { type: 'web_search_call', action: { sources: [{ url: 'https://b.com', title: 'B' }] } } };
    })();
    const events = await drain({ gen: (/** @type {any} */ (oaiAdapter)).consumeStream({ rawStream: stream }) });
    const sources = events.find(e => e.type === 'sources');
    assert.deepEqual(sources.data.sources, [
        { title: 'A', url: 'https://a.com' },
        { title: 'B', url: 'https://b.com' },
    ]);
});

test('OAI responses: no citations means no sources event', async () => {
    const stream = (async function* () { yield { type: 'response.output_text.delta', delta: 'hi' }; })();
    const events = await drain({ gen: (/** @type {any} */ (oaiAdapter)).consumeStream({ rawStream: stream }) });
    assert.equal(events.some(e => e.type === 'sources'), false);
});

test('AAI: web_search_tool_result blocks + citation deltas yield a sources event', async () => {
    const stream = (async function* () {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A' }] } };
        yield { type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://b.com', title: 'B' } } };
    })();
    const events = await drain({ gen: (/** @type {any} */ (aaiAdapter)).consumeStream({ rawStream: stream }) });
    const sources = events.find(e => e.type === 'sources');
    assert.deepEqual(sources.data.sources, [
        { title: 'A', url: 'https://a.com' },
        { title: 'B', url: 'https://b.com' },
    ]);
});
