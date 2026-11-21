// @ts-check
/** Phase D proofs: enterPhase umbrella + the run/step/workflow wirings. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { enterPhase, PHASES } from '../lib/core/lifecycle.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { runStep } from '../lib/agentic/step.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';

test('PHASES names the wired units', () => {
    assert.deepEqual(PHASES, { RUN: 'run', STEP: 'step', WORKFLOW: 'workflow' });
});

test('enterPhase emits phase:start then phase:end with duration and returns the value', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const seen = [];
    emitter.on('phase:start', (/** @type {any} */ e) => seen.push(['start', e.phase, e.event]));
    emitter.on('phase:end', (/** @type {any} */ e) => seen.push(['end', e.phase, e.status, typeof e.durationMs]));
    const out = await enterPhase({ ctx: { emitter }, phase: PHASES.STEP, fn: async () => 42 });
    assert.equal(out, 42);
    assert.deepEqual(seen, [['start', 'step', 'phase:start'], ['end', 'step', 'success', 'number']]);
});

test('enterPhase emits status:error and rethrows', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const ends = [];
    emitter.on('phase:end', (/** @type {any} */ e) => ends.push(e));
    await assert.rejects(
        () => enterPhase({ ctx: { emitter }, phase: PHASES.RUN, fn: async () => { throw new Error('boom'); } }),
        /boom/,
    );
    assert.equal(ends.length, 1);
    assert.equal(ends[0].status, 'error');
    assert.equal(ends[0].phase, 'run');
    assert.match(ends[0].error, /boom/);
});

test('a throwing phase listener never breaks the wrapped work (isolation)', async () => {
    const emitter = new MerciEventEmitter();
    /** @type {any[]} */
    const errors = [];
    emitter.on('phase:start', () => { throw new Error('listener'); });
    emitter.on(EVENTS.ERRORS.LISTENER_ERROR, (/** @type {any} */ e) => errors.push(e));
    const out = await enterPhase({ ctx: { emitter }, phase: PHASES.STEP, fn: async () => 'ok' });
    assert.equal(out, 'ok');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].sourceEvent, 'phase:start');
});

test('runStep wraps the shared step primitive in a phase:step umbrella', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const phases = [];
    emitter.on('phase:start', (/** @type {any} */ e) => phases.push(['start', e.phase]));
    emitter.on('phase:end', (/** @type {any} */ e) => phases.push(['end', e.phase, e.status]));
    const fakeSession = { provider: 'test', run: async () => 'done' };
    const res = await runStep({ step: {}, deps: {
        session: fakeSession,
        messages: [{ role: 'user', content: 'hi' }],
        emitter,
        configureSession: false,
    } });
    assert.equal(res.result, 'done');
    assert.deepEqual(phases, [['start', 'step'], ['end', 'step', 'success']]);
});

test('WorkflowExecutor.execute wraps the run in a phase:workflow umbrella', async () => {
    const exec = new WorkflowExecutor({});
    /** @type {any[]} */
    const phases = [];
    exec.on('phase:start', (/** @type {any} */ e) => phases.push(['start', e.phase]));
    exec.on('phase:end', (/** @type {any} */ e) => phases.push(['end', e.phase, e.status]));
    await assert.rejects(() => exec.execute({ userGoal: 'no steps' }), /empty plan/);
    assert.deepEqual(phases, [['start', 'workflow'], ['end', 'workflow', 'error']]);
});
