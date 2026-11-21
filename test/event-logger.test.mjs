// @ts-check
/**
 * Phase B proofs: the event→logger bridges, the extended defaultDisplay, and
 * the request:before hook observability event.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Logger, log } from '../lib/support/logger.mjs';
import { attachEventLogger, createStreamLogger, canonicalEventNames } from '../lib/support/event-logger.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { defaultDisplay } from '../lib/agentic/agentic-core.mjs';
import { BaseChatSession } from '../lib/agentic/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { createHooks, HOOKS, STOP } from '../lib/core/hooks.mjs';

function capture() {
    /** @type {{ log: any[], error: any[], write: any[] }} */
    const lines = { log: [], error: [], write: [] };
    const sink = {
        log: (/** @type {string} */ t) => { lines.log.push(t); },
        error: (/** @type {string} */ t) => { lines.error.push(t); },
        write: (/** @type {string} */ t) => { lines.write.push(t); return true; },
    };
    return { sink, lines };
}

test('canonicalEventNames: full registry, unique, and without the bare error name', () => {
    const names = canonicalEventNames();
    assert.ok(names.length > 80, 'covers the registry');
    assert.equal(new Set(names).size, names.length, 'unique');
    assert.ok(names.includes(EVENTS.CLIENT.RUN_START));
    assert.ok(names.includes(EVENTS.TOOL.CALL_START));
    assert.ok(names.includes(EVENTS.PHASE.START));
    assert.equal(names.includes(EVENTS.CLIENT.ERROR), false, 'bare error stays Node-conventional');
});

test('attachEventLogger: logs every canonical event on a plain emitter, and unsubscribes', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, level: 'debug' });
    const em = new EventEmitter();
    const off = attachEventLogger({ emitter: em, log: l, level: 'debug' });

    em.emit(EVENTS.CLIENT.RUN_START, { event: EVENTS.CLIENT.RUN_START, runId: 'r1', provider: 'openai', model: 'm', ts: 1 });
    em.emit(EVENTS.TOOL.CALL_START, { event: EVENTS.TOOL.CALL_START, id: 'c1', name: 'echo' });
    assert.ok(lines.log.some(x => x.includes('run:start') && x.includes('openai') && x.includes('m')));
    assert.ok(lines.log.some(x => x.includes('tool:call_start') && x.includes('echo')));
    assert.ok(lines.log.every(x => !x.includes('r1')), 'correlation meta is not duplicated into the summary');

    off();
    const before = lines.log.length;
    em.emit(EVENTS.CLIENT.RUN_START, { event: EVENTS.CLIENT.RUN_START, provider: 'openai' });
    assert.equal(lines.log.length, before, 'unsubscribed');
});

test('attachEventLogger: uses onAny on a MerciEventEmitter (glob-aware catch-all)', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, level: 'debug' });
    const em = new MerciEventEmitter();
    const off = attachEventLogger({ emitter: em, log: l, level: 'debug' });
    em.emit(EVENTS.CLIENT.RUN_START, { event: EVENTS.CLIENT.RUN_START, provider: 'openai' });
    assert.ok(lines.log.some(x => x.includes('run:start') && x.includes('openai')));
    off();
});

test('attachEventLogger: level-gated and filterable; trace dumps the full redacted envelope', () => {
    const { sink, lines } = capture();
    const quiet = new Logger();
    quiet.configure({ colors: false, sink, level: 'info' });
    const em = new EventEmitter();
    attachEventLogger({ emitter: em, log: quiet, level: 'debug' });
    em.emit(EVENTS.CLIENT.RUN_START, { event: EVENTS.CLIENT.RUN_START, provider: 'openai' });
    assert.equal(lines.log.length, 0, 'debug bridge is silent at info');

    const trace = new Logger();
    trace.configure({ colors: false, sink, level: 'trace' });
    const em2 = new EventEmitter();
    attachEventLogger({ emitter: em2, log: trace, level: 'trace', filter: ({ name }) => name === EVENTS.CLIENT.API_REQUEST });
    em2.emit(EVENTS.CLIENT.API_REQUEST, { event: EVENTS.CLIENT.API_REQUEST, model: 'm', params: { apiKey: 'sk-secret' } });
    em2.emit(EVENTS.CLIENT.RUN_START, { event: EVENTS.CLIENT.RUN_START });
    assert.ok(lines.log.some(x => x.includes('api_request')));
    assert.ok(lines.log.some(x => x.includes('[REDACTED]')), 'full trace dump is redacted');
    assert.ok(lines.log.every(x => !x.includes('sk-secret')));
    assert.equal(lines.log.filter(x => x.includes('run:start')).length, 0, 'filter excludes');
});

test('createStreamLogger: logs non-rendered stream events, skips text/thought, level-gated', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, level: 'debug' });
    const stream = createStreamLogger({ log: l, level: 'debug' });
    stream({ type: EVENTS.STEP.TEXT, content: 'hello' });
    stream({ type: EVENTS.STEP.THOUGHT, content: 'hmm' });
    stream({ type: EVENTS.STEP.QUOTA, data: { prompt_tokens: 5, completion_tokens: 2 } });
    stream({ type: EVENTS.STEP.TRUNCATED });
    assert.equal(lines.log.length, 2, 'text/thought are not double-logged');
    assert.ok(lines.log.some(x => x.includes('stream:quota') && x.includes('prompt_tokens')));
    assert.ok(lines.log.some(x => x.includes('stream:truncated')));

    const quiet = new Logger();
    quiet.configure({ colors: false, sink, level: 'info' });
    const before = lines.log.length;
    createStreamLogger({ log: quiet, level: 'debug' })({ type: EVENTS.STEP.QUOTA, data: {} });
    assert.equal(lines.log.length, before);
});

test('defaultDisplay: surfaces mid-stream errors, truncation, schema failures and compaction', () => {
    const { sink, lines } = capture();
    const originalSink = /** @type {any} */ (log)._sink;
    log.configure({ colors: false, sink, level: 'info' });
    try {
        const d = defaultDisplay();
        d.onEvent({ type: EVENTS.CLIENT.ERROR, error_message: 'content filter', error_type: 'safety' });
        d.onEvent({ type: EVENTS.STEP.TRUNCATED });
        d.onEvent({ type: EVENTS.STEP.SCHEMA_VALIDATION_FAILED, error: 'bad json' });
        d.onEvent({ type: EVENTS.STEP.COMPACTION, dropped: 3, summarized: 1 });
        assert.ok(lines.error.some(x => x.includes('content filter')), 'stream error is visible');
        assert.ok(lines.log.some(x => x.includes('truncated')));
        assert.ok(lines.log.some(x => x.includes('schema validation failed') && x.includes('bad json')));
        assert.ok(lines.log.some(x => x.includes('compaction') && x.includes('dropped')));
    } finally {
        log.configure({ colors: false, sink: originalSink });
    }
});

// ── request:before observability ─────────────────────────────────────────────

/** @returns {any} a stub session whose vendor call is inert. */
function stubSession() {
    const adapter = {
        vendorName: 'STUB',
        buildVendorRequest: () => ({ request: { marker: 'original' }, observability: { model: 'm' } }),
        executeVendorRequest: () => ({}),
        consumeStream: async function* () { yield { type: 'text', content: 'hi' }; },
        extractXmlToolCalls: () => [],
        formatToolCall: (/** @type {any} */ { call }) => ({ id: call.id, name: call.name, args: {} }),
    };
    const emitter = new EventEmitter();
    const session = new (class extends BaseChatSession {})({
        vendorClient: {}, model: 'm', eventEmitter: emitter, provider: ProviderType.OPENAI, adapter,
        buildParameters: (/** @type {any} */ { s }) => s,
    });
    session._onStepShouldPrepare = () => false;
    return { session, emitter };
}

test('defaultDisplay: stream option attaches the step-stream logger, and stream:false disables it', () => {
    const { sink, lines } = capture();
    const originalSink = /** @type {any} */ (log)._sink;
    log.configure({ colors: false, sink, level: 'debug' });
    try {
        defaultDisplay().onEvent({ type: EVENTS.STEP.QUOTA, data: { prompt_tokens: 3 } });
        assert.ok(lines.log.some(x => x.includes('stream:quota')), 'stream logger is on by default at debug');

        const before = lines.log.length;
        defaultDisplay({ stream: false }).onEvent({ type: EVENTS.STEP.QUOTA, data: {} });
        assert.equal(lines.log.length, before, 'stream:false disables the step-stream logger');
    } finally {
        log.configure({ colors: false, sink: originalSink });
    }
});

test('request:before: a registered hook chain emits hook:request_before with its effect', async () => {
    const { session, emitter } = stubSession();
    /** @type {any[]} */
    const seen = [];
    emitter.on(EVENTS.HOOKS.REQUEST_BEFORE, (/** @type {any} */ e) => seen.push(e));
    const hooks = createHooks();
    hooks.add({ name: HOOKS.REQUEST_BEFORE, fn: (/** @type {any} */ v) => ({ ...v, marker: 'transformed' }) });
    session.withHooks({ hooks });

    const gen = session.step({ messages: [] });
    let r = await gen.next();
    while (!r.done) r = await gen.next();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].event, EVENTS.HOOKS.REQUEST_BEFORE);
    assert.equal(seen[0].changed, true);
    assert.equal(seen[0].vetoed, false);
    assert.equal(seen[0].hooks, 1);
});

test('request:before: emits nothing when no hook is registered for the chain', async () => {
    const { session, emitter } = stubSession();
    /** @type {any[]} */
    const seen = [];
    emitter.on(EVENTS.HOOKS.REQUEST_BEFORE, (/** @type {any} */ e) => seen.push(e));
    session.withHooks({ hooks: createHooks() });

    const gen = session.step({ messages: [] });
    let r = await gen.next();
    while (!r.done) r = await gen.next();

    assert.equal(seen.length, 0);
});

test('request:before: STOP veto is recorded as vetoed', async () => {
    const { session, emitter } = stubSession();
    /** @type {any[]} */
    const seen = [];
    emitter.on(EVENTS.HOOKS.REQUEST_BEFORE, (/** @type {any} */ e) => seen.push(e));
    const hooks = createHooks();
    hooks.add({ name: HOOKS.REQUEST_BEFORE, fn: () => STOP });
    session.withHooks({ hooks });

    const gen = session.step({ messages: [] });
    let r = await gen.next();
    while (!r.done) r = await gen.next();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].vetoed, true);
    assert.equal(seen[0].changed, false);
});
