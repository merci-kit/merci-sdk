// @ts-check

/**
 * Wave 9 / B8 — the event stream is a ledger when it is pointed at a durable sink.
 *
 * The audit's complaint is not that the layer cannot be durable — `log.configure({
 * format: 'json', sink })` and `attachEventLogger()` exist — but that the bridge
 * summarises payloads below `trace`, so the "ledger" lost the values it was meant to
 * preserve. At `trace` the full envelope reaches the sink, one JSON record per line,
 * which is the shape an audit reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Logger } from '../lib/support/logger.mjs';
import { attachEventLogger } from '../lib/support/event-logger.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { EVENTS, RunContext, runWithRunContext } from '../lib/core/events.mjs';

/** A sink that keeps every written line. */
function capture() {
    /** @type {string[]} */
    const log = [];
    /** @param {string} line */
    const push = (line) => { log.push(line); return true; };
    // The logger's sink is a `{ log, error, write }` triple; all three land here.
    return { sink: { log: push, error: push, write: push }, log };
}

test('B8/ledger: at trace the full envelope reaches a JSON sink, one record per line', () => {
    const { sink, log } = capture();
    const logger = new Logger();
    logger.configure({ colors: false, sink, format: 'json', level: 'trace' });
    const emitter = new MerciEventEmitter();
    attachEventLogger({ emitter, log: logger, level: 'trace' });

    const ctx = new RunContext({ runId: 'run-ledger', sessionId: 'conv-7' });
    runWithRunContext({ runContext: ctx, fn: () => {
        ctx.emit({ emitter, name: EVENTS.PLAN.PATCHED, payload: { ops: [{ op: 'add' }], applied: 1, reason: 'more evidence' } });
        ctx.emit({ emitter, name: EVENTS.WORKFLOW.STEP_COMPLETE, payload: { stepId: 'build', ok: true } });
    } });

    assert.equal(log.length, 2, 'one record per event');
    const [first, second] = log.map((line) => JSON.parse(line));
    assert.equal(first.event, EVENTS.PLAN.PATCHED, 'the record names the event');
    assert.deepEqual(first.payload.ops, [{ op: 'add' }], 'payload values survive, not `{n}`');
    assert.equal(first.payload.reason, 'more evidence');
    assert.equal(first.correlation.runId, 'run-ledger');
    assert.equal(first.correlation.sessionId, 'conv-7');
    assert.equal(typeof first.payload.ts, 'number');
    assert.equal(second.event, EVENTS.WORKFLOW.STEP_COMPLETE);
    assert.equal(second.payload.stepId, 'build');
});

test('B8/ledger-summary: below trace the same bridge summarises — which is why the ledger uses trace', () => {
    const { sink, log } = capture();
    const logger = new Logger();
    logger.configure({ colors: false, sink, format: 'json', level: 'debug' });
    const emitter = new MerciEventEmitter();
    attachEventLogger({ emitter, log: logger, level: 'debug' });
    const ctx = new RunContext({ runId: 'run-summary' });
    runWithRunContext({ runContext: ctx, fn: () => {
        ctx.emit({ emitter, name: EVENTS.PLAN.PATCHED, payload: { ops: [{ op: 'add' }, { op: 'remove' }], reason: 'x' } });
    } });

    const record = JSON.parse(log[0]);
    assert.ok(record.text.includes(EVENTS.PLAN.PATCHED), 'the summary names the event');
    assert.ok(record.text.includes('[2]'), 'collections collapse to their size');
    assert.equal(record.event, undefined, 'no structured payload below trace');
    assert.equal(record.correlation.runId, 'run-summary');
});

test('B8/correlation: the record carries parentRunId and sessionId from a child context', () => {
    const { sink, log } = capture();
    const logger = new Logger();
    logger.configure({ colors: false, sink, format: 'json', level: 'trace' });
    const emitter = new MerciEventEmitter();
    attachEventLogger({ emitter, log: logger, level: 'trace' });
    const child = RunContext.child(new RunContext({ runId: 'parent-run', sessionId: 'conv-8' }));
    runWithRunContext({ runContext: child, fn: () => {
        child.emit({ emitter, name: EVENTS.TOOL.CALL_START, payload: { name: 'write_file' } });
    } });

    const record = JSON.parse(log[0]);
    assert.equal(record.correlation.parentRunId, 'parent-run');
    assert.equal(record.correlation.sessionId, 'conv-8');
    assert.ok(typeof record.payload.runId === 'string' && record.payload.runId !== 'parent-run');
});
