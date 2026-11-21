// @ts-check
/**
 * Phase A logger-core proofs: JSON/NDJSON records, correlation, levels/fatal,
 * redaction, child scoping, timers, namespace gating, and LOG_LEVEL env wiring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Logger, log } from '../lib/support/logger.mjs';
import { configureSdkLog } from '../lib/support/utils.mjs';
import { RunContext, runWithRunContext } from '../lib/core/events.mjs';

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

test('Logger(A): json format emits one parseable NDJSON record per line', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, format: 'json' });
    l.info({ m: 'hello' });
    l.warn({ m: 'careful' });
    assert.equal(lines.log.length, 2);
    const first = JSON.parse(lines.log[0]);
    assert.equal(first.level, 'info');
    assert.equal(first.kind, 'log');
    assert.match(first.text, /\[INFO\] hello/);
    assert.equal(JSON.parse(lines.log[1]).level, 'warn');
});

test('Logger(A): json records carry ambient run correlation from the ALS', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, format: 'json' });
    const ctx = new RunContext({ runId: 'run-abcdef123456', sessionId: 'sess-1' });
    runWithRunContext({ runContext: ctx, fn: () => { l.info({ m: 'inside' }); } });
    const record = JSON.parse(lines.log[0]);
    assert.equal(record.correlation.runId, 'run-abcdef123456');
    assert.equal(record.correlation.sessionId, 'sess-1');
    assert.equal(record.correlation.parentRunId, undefined);
});

test('Logger(A): fatal prints loudly; isLevelEnabled reflects the threshold', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, level: 'warn' });
    l.fatal({ m: 'boom', d: 'context' });
    assert.ok(lines.error.some(x => x.includes('[FATAL] boom')));
    assert.ok(lines.error.some(x => x.includes('context')));
    assert.equal(l.isLevelEnabled({ level: 'info' }), false);
    assert.equal(l.isLevelEnabled({ level: 'error' }), true);
    assert.equal(l.isLevelEnabled({ level: 'fatal' }), true);
});

test('Logger(A): LOG_LEVEL env lifts the gate when no explicit level is passed', () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    try {
        const { sink, lines } = capture();
        const l = new Logger();
        l.configure({ colors: false, sink });
        l.debug({ m: 'from-env' });
        assert.ok(lines.log.some(x => x.includes('[DEBUG] from-env')));
    } finally {
        if (prev === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prev;
    }
});

test('Logger(A): redaction masks secret keys in dump and _str, nested included', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    const inline = l.dump({ label: '', value: { apiKey: 'sk-123', nested: { authorization: 'Bearer x' }, client_secret: 'cs-7', openai_api_key: 'sk-9', keep: 'ok' }, inline: true });
    assert.doesNotMatch(String(inline), /sk-123|Bearer x|cs-7|sk-9/);
    assert.match(String(inline), /\[REDACTED\]/);
    assert.match(String(inline), /"keep": "ok"/);
    l.info({ m: { refresh_token: 'rt-9', visible: 1 } });
    assert.doesNotMatch(lines.log[0], /rt-9/);
    assert.match(lines.log[0], /\[REDACTED\]/);
});

test('Logger(A): child binds context fields onto every JSON record', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, format: 'json' });
    const scoped = l.child({ module: 'TOOLS' });
    scoped.info({ m: 'x' });
    const record = JSON.parse(lines.log[0]);
    assert.deepEqual(record.context, { module: 'TOOLS' });
});

test('Logger(A): timer logs the elapsed time and returns ms', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    const t = l.timer({ label: 'op' });
    const ms = t.done({ fields: { n: 1 } });
    assert.equal(typeof ms, 'number');
    assert.ok(lines.log.some(x => /\[TIMER\] op/.test(x)));
});

test('Logger(A): namespace globs gate sdkLog by prefix', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, extended: true, namespaces: ['SDK', 'WORKFLOW-*'] });
    l.sdkLog({ prefix: 'SDK', args: ['kept'] });
    l.sdkLog({ prefix: 'WORKFLOW-EXECUTOR', args: ['kept-too'] });
    l.sdkLog({ prefix: 'TOOLS', args: ['dropped'] });
    assert.ok(lines.log.some(x => x.includes('[SDK] kept')));
    assert.ok(lines.log.some(x => x.includes('[WORKFLOW-EXECUTOR] kept-too')));
    assert.equal(lines.log.filter(x => x.includes('dropped')).length, 0);
});

test('Logger(A): wire prints a metadata brief; full redacted bodies at trace', () => {
    const meta = { method: 'POST', url: 'https://x/v1', model: 'gpt', messages: [{ role: 'user', content: 'secret-body' }], params: { apiKey: 'sk-1', temperature: 0 } };

    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, level: 'info' });
    l.wire({ kind: 'request', meta });
    assert.ok(lines.log.some(x => x.includes('POST') && x.includes('msgs=1') && x.includes('params=apiKey,temperature')));
    assert.ok(lines.log.every(x => !x.includes('secret-body')), 'bodies hidden at info');
    assert.ok(lines.log.every(x => !x.includes('sk-1')), 'params hidden at info');

    const { sink: s2, lines: l2 } = capture();
    const t = new Logger();
    t.configure({ colors: false, sink: s2, level: 'trace' });
    t.wire({ kind: 'request', meta });
    assert.ok(l2.log.some(x => x.includes('secret-body')), 'full body at trace');
    assert.ok(l2.log.every(x => !x.includes('sk-1')), 'full body still redacted');
    assert.ok(l2.log.some(x => x.includes('[REDACTED]')));
});

test('Logger(A): toolResult truncates by default, expands (redacted) at trace', () => {
    const long = 'A'.repeat(400);
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, level: 'info' });
    l.toolResult({ n: 'read', r: { blob: long, apiKey: 'sk-2' } });
    assert.ok(lines.log.every(x => !x.includes(long)), 'truncated at info');
    assert.ok(lines.log.every(x => !x.includes('sk-2')), 'tool args redacted');

    const { sink: s2, lines: l2 } = capture();
    const t = new Logger();
    t.configure({ colors: false, sink: s2, level: 'trace' });
    t.toolResult({ n: 'read', r: { blob: long } });
    assert.ok(l2.log.some(x => x.includes(long)), 'full at trace');
});

test('configureSdkLog: applies level/format/colors to the shared singleton', () => {
    const L = /** @type {any} */ (log);
    const snap = { level: L._level, extended: L._extended, quiet: L._quiet, colors: L._colors, format: L._format, namespaces: L._namespaces, fields: L._fields };
    const prevLevel = process.env.LOG_LEVEL;
    const prevFormat = process.env.LOG_FORMAT;
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FORMAT;
    try {
        configureSdkLog({ level: 'warn', format: 'json', colors: false });
        assert.equal(log.level, 'warn');
        assert.equal(log.format, 'json');
        assert.equal(L._colors, false);
        configureSdkLog({ extended: true });
        assert.equal(log.level, 'warn', 'unpassed level is left alone');
        assert.equal(log.format, 'json', 'unpassed format is left alone');
        assert.equal(log.extended, true);
    } finally {
        Object.assign(L, { _level: snap.level, _extended: snap.extended, _quiet: snap.quiet, _colors: snap.colors, _format: snap.format, _namespaces: snap.namespaces, _fields: snap.fields });
        if (prevLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prevLevel;
        if (prevFormat === undefined) delete process.env.LOG_FORMAT; else process.env.LOG_FORMAT = prevFormat;
    }
});

test('Logger(A): LOG_FORMAT env selects json when no explicit format is passed', () => {
    const prev = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = 'json';
    try {
        const { sink, lines } = capture();
        const l = new Logger();
        l.configure({ colors: false, sink });
        l.info({ m: 'x' });
        assert.equal(JSON.parse(lines.log[0]).level, 'info');
    } finally {
        if (prev === undefined) delete process.env.LOG_FORMAT; else process.env.LOG_FORMAT = prev;
    }
});

test('Logger(A): wire covers every backend request shape (gai contents/config, jai body) and the response/retry field names', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, level: 'info' });
    l.wire({ kind: 'request', meta: { model: 'gemini', contents: [{ role: 'user' }], config: { temperature: 0, apiKey: 'sk-g' } } });
    assert.ok(lines.log.some(x => x.includes('contents=1') && x.includes('config=temperature,apiKey')));
    assert.ok(lines.log.every(x => !x.includes('sk-g')), 'config not dumped at info');
    l.wire({ kind: 'response', meta: { status: 200, ok: true, durationMs: 12 } });
    assert.ok(lines.log.some(x => x.includes('200') && x.includes('12ms')), 'durationMs is read');
    l.wire({ kind: 'retry', meta: { attempt: 2, nextDelayMs: 500 } });
    assert.ok(lines.log.some(x => x.includes('attempt=2') && x.includes('in 500ms')), 'nextDelayMs is read');

    const { sink: s2, lines: l2 } = capture();
    const t = new Logger();
    t.configure({ colors: false, sink: s2, level: 'trace' });
    t.wire({ kind: 'request', meta: { url: 'https://gw', method: 'POST', body: JSON.stringify({ token: 'tok-1', chat: { messages: [{ role: 'user', content: 'hi' }] } }) } });
    assert.ok(l2.log.some(x => /body=\d+b/.test(x)), 'body length in the brief');
    assert.ok(l2.log.some(x => x.includes('hi')), 'full body at trace');
    assert.ok(l2.log.every(x => !x.includes('tok-1')), 'parsed body is redacted');
    assert.ok(l2.log.some(x => x.includes('[REDACTED]')));
});
