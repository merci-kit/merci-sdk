// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Logger, log } from '../lib/support/logger.mjs';
import { configureSdkLog, sdkLog, sdkError } from '../lib/support/utils.mjs';

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

test('Logger: backward-compatible surface exists on the shared singleton', () => {
    for (const m of ['header', 'step', 'info', 'success', 'warn', 'error', 'experiment',
        'assistant', 'user', 'thinking', 'toolCall', 'toolResult']) {
        assert.equal(typeof (/** @type {any} */ (log))[m], 'function', `log.${m} must exist`);
    }
});

test('Logger: header renders the legacy format (banner + uppercased title)', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    l.header({ t: 'Example 01' });
    assert.match(lines.log[0], /=== EXAMPLE 01 ===/);
});

test('Logger: toolResult truncates long payloads with an explicit marker', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    l.toolResult({ n: 'fetch', r: 'x'.repeat(500) });
    assert.ok(lines.log[0].length < 250);
    assert.match(lines.log[0], /…/);
});

test('Logger: truncate() leaves short text untouched', () => {
    const l = new Logger();
    assert.equal(l.truncate({ text: 'short', n: 200 }), 'short');
});

test('Logger: debug/trace are gated at the default info level; info prints', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    l.debug({ m: 'hidden' }); l.trace({ m: 'hidden' });
    l.info({ m: 'visible' });
    assert.equal(lines.log.filter(x => x.includes('hidden')).length, 0);
    assert.ok(lines.log.some(x => x.includes('[INFO] visible')));
});

test('Logger: configure({level:"debug"}) lifts the gate', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, level: 'debug' });
    l.debug({ m: 'shown' });
    assert.ok(lines.log.some(x => x.includes('[DEBUG] shown')));
});

test('Logger: error goes to the error sink and warn/error print regardless of level', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, level: 'silent' });
    l.error({ m: 'boom', d: 'detail' });
    l.warn({ m: 'careful' });
    assert.ok(lines.error.some(x => x.includes('[ERROR] boom')));
    assert.ok(lines.error.some(x => x.includes('detail')));
    assert.ok(lines.log.some(x => x.includes('[WARNING] careful')));
});

test('Logger: level "silent" gates info/success/debug/trace but not warn/error', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink, level: 'silent' });
    l.info({ m: 'quiet' }); l.success({ m: 'quiet' }); l.debug({ m: 'quiet' }); l.trace({ m: 'quiet' });
    assert.equal(lines.log.filter(x => x.includes('quiet')).length, 0);
});

test('Logger: dump tolerates undefined/Symbol/numbers and never throws', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    (/** @type {any} */ (l)).dump({ label: 'undef' });
    l.dump({ label: 'sym', value: Symbol('x') });
    l.dump({ label: 'num', value: 42 });
    assert.ok(lines.log.some(x => x.includes('┌─ undef')));
    assert.ok(lines.log.some(x => x.includes('┌─ sym')));
    assert.ok(lines.log.some(x => x.includes('┌─ num')));
});

test('Logger: list tolerates a single non-array item and null', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    l.list({ title: 'one', items: 'item' });
    l.list({ title: 'none', items: null });
    assert.match(lines.log[0], /one \(1\)/);
    assert.match(lines.log[2], /none \(0\)/);
});

test('Logger: style tolerates non-string bg even with colors on', () => {
    const l = new Logger();
    l.configure({ colors: true });
    assert.equal(l.style({ text: 'x', bg: /** @type {any} */ (5) }), 'x');
    assert.doesNotThrow(() => l.style({ text: 'x', bg: /** @type {any} */ (true) }));
});

test('Logger: style() composes colors; disabled colors strip ANSI', () => {
    const l = new Logger();
    l.configure({ colors: true });
    const styled = l.style({ text: 'x', fg: 'green', bold: true });
    assert.ok(styled.includes('\x1b[32m') && styled.includes('\x1b[1m'));
    const plain = new Logger();
    plain.configure({ colors: false });
    assert.equal(plain.style({ text: 'x', fg: 'green', bold: true }), 'x');
});

test('Logger: flow renders from → to with what and why', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    l.flow({ from: 'planner', to: 'executor', what: 'send plan', why: 'objective requires it' });
    assert.match(lines.log[0], /planner → executor: send plan \(objective requires it\)/);
});

test('Logger: wire renders request / response / retry kinds', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    l.wire({ kind: 'request', meta: { method: 'POST', url: '/v1/chat', model: 'm1', messages: [1, 2], params: { temperature: 1 } } });
    l.wire({ kind: 'response', meta: { status: 200, ok: true, latencyMs: 1234 } });
    l.wire({ kind: 'retry', meta: { attempt: 2, delayMs: 100, error: new Error('429') } });
    assert.match(lines.log[0], /POST \/v1\/chat m1 msgs=2 params=temperature/);
    assert.match(lines.log[1], /200.*\(1\.23s\)/);
    assert.match(lines.log[2], /attempt=2.*100ms.*429/);
});

test('Logger: usage renders token totals; empty usage prints nothing', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    l.usage({ u: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    assert.match(lines.log[0], /prompt=10 · completion=5 · total=15/);
    l.usage({ u: null });
    l.usage({ u: {} });
    assert.equal(lines.log.length, 1);
});

test('Logger: dump renders a framed block and stays a plain string inline', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    l.dump({ label: 'RESULT', value: { a: 1 } });
    assert.ok(lines.log[0].includes('┌─ RESULT'));
    assert.match(lines.log[0], /"a": 1/);
    assert.ok(lines.log[0].includes('└'));
    assert.equal(l.dump({ label: '', value: { a: 1 }, inline: true }), '{\n  "a": 1\n}');
});

test('Logger: check/list/totals render PASS-FAIL, counts, and aligned pairs', () => {
    const { sink, lines } = capture();
    const l = new Logger();
    l.configure({ colors: false, sink });
    l.check({ name: 'schema', passed: true, detail: 'all fields present' });
    l.check({ name: 'tokens', passed: false, detail: 'over budget' });
    l.list({ title: 'agents', items: ['a', 'b'] });
    l.totals({ entries: { attempts: 3, passes: 2 } });
    assert.match(lines.log[0], /✓ schema — all fields present/);
    assert.match(lines.log[1], /✗ tokens — over budget/);
    assert.match(lines.log[2], /agents \(2\)/);
    assert.ok(lines.log.some(x => x.includes('attempts')) && lines.log.some(x => x.includes('passes')));
});

test('Logger: configureSdkLog delegation still gates sdkLog and keeps sdkError loud', () => {
    configureSdkLog({ extended: false, quiet: false });
    const { sink, lines } = capture();
    log.configure({ sink });
    sdkLog({ prefix: 'SDK', args: ['verbose line'] });
    sdkError({ prefix: 'SDK', args: ['real failure'] });
    assert.equal(lines.log.filter(x => x.includes('verbose line')).length, 0);
    assert.ok(lines.error.some(x => x.includes('real failure')));

    configureSdkLog({ extended: true });
    const { sink: s2, lines: l2 } = capture();
    log.configure({ sink: s2 });
    sdkLog({ prefix: 'SDK', args: ['now visible'] });
    assert.ok(l2.log.some(x => x.includes('[SDK] now visible')));

    configureSdkLog({ extended: false, quiet: true });
    const { sink: s3, lines: l3 } = capture();
    log.configure({ sink: s3 });
    sdkError({ prefix: 'SDK', args: ['silenced'] });
    assert.equal(l3.error.filter(x => x.includes('silenced')).length, 0);

    configureSdkLog({ extended: false, quiet: false });
});
