// @ts-check

/**
 * @file Abort detection has one implementation: `core/errors.mjs`.
 * @version 0.12.0
 *
 * @description
 * The scheduler's normalization, the workspace hooks, and the agentic loop all
 * expose their own `{ error }`/run surface, but the matching itself is the
 * canonical cause-walking check. Every abort shape must therefore agree at all
 * four call sites, and a hostile getter must read as "not an abort" rather than
 * reject the settle path or suppress `run:end`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { FailureClass } from '../lib/agentic/loops/policy.mjs';
import { normalizeRunResult } from '../lib/agentic/scheduler/retry.mjs';
import { isAbortError as hooksIsAbortError } from '../lib/agentic/workspace/hooks.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { isAbortError as coreIsAbortError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

/**
 * The session throws the shape before any stream event, so the run catch sees it.
 * @param {{thrown: unknown}} arg0
 */
async function runLoopWith({ thrown }) {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const ends = [];
    emitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
    /** @type {any} */
    const session = {
        provider: ProviderType.OPENAI,
        model: 'test-model',
        _tools: [],
        eventEmitter: emitter,
        async *step() {
            throw thrown;
        }
    };
    /** @type {any} */
    let error = null;
    try {
        await runAgenticLoop({ session, messages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'go' })] });
    } catch (e) {
        error = e;
    }
    return { ends, error };
}

/** @param {{name?: string, code?: string}} arg0 */
const shaped = ({ name, code }) => Object.assign(new Error('stop'), { ...(name ? { name } : {}), ...(code ? { code } : {}) });

/** The abort shapes the SDK sees from vendored SDKs, DOMExceptions, and itself. */
const ABORT_SHAPES = [
    ['AbortError name', shaped({ name: 'AbortError' })],
    ['CanceledError name', shaped({ name: 'CanceledError' })],
    ['AbortedError name', shaped({ name: 'AbortedError' })],
    ['ABORT_ERR code', shaped({ code: 'ABORT_ERR' })],
    ['ERR_CANCELED code', shaped({ code: 'ERR_CANCELED' })],
    ['MERCI-ABORTED-ERR code', shaped({ code: 'MERCI-ABORTED-ERR' })],
    ['nested cause', new Error('outer', { cause: shaped({ name: 'AbortError' }) })]
];

for (const [label, error] of ABORT_SHAPES) {
    test(`abort parity: ${label} is cancelled at every call site`, async () => {
        assert.equal(coreIsAbortError({ err: error }), true, 'core/errors');
        assert.equal(normalizeRunResult({ error }).status, 'canceled', 'scheduler/retry via normalizeRunResult');
        assert.equal(hooksIsAbortError({ error }), true, 'workspace/hooks');
        const { ends } = await runLoopWith({ thrown: error });
        assert.equal(ends[0].finishReason, 'aborted', 'agentic loop');
        assert.equal('failureClass' in ends[0], false, 'the loop makes no class claim for an abort');
    });
}

test('a plain error and a timeout are failures at every call site', async () => {
    const plain = new Error('vendor exploded');
    const timedOut = shaped({ code: 'STEP_TIMEOUT' });
    for (const error of [plain, timedOut]) {
        assert.equal(coreIsAbortError({ err: error }), false, 'core/errors');
        assert.equal(normalizeRunResult({ error }).status, 'failed', 'scheduler/retry');
        assert.equal(hooksIsAbortError({ error }), false, 'workspace/hooks');
        const { ends } = await runLoopWith({ thrown: error });
        assert.equal(ends[0].finishReason, 'error', 'agentic loop');
        assert.equal('failureClass' in ends[0], true, 'the loop classifies a failure');
    }
});

test('a hostile name/code getter reads as not-aborted instead of throwing', async () => {
    const hostile = /** @type {any} */ ({
        get name() { throw new Error('boom'); },
        get code() { throw new Error('boom'); }
    });
    assert.equal(hooksIsAbortError({ error: hostile }), false);
    assert.equal(normalizeRunResult({ error: hostile }).status, 'failed');
    const { ends, error } = await runLoopWith({ thrown: hostile });
    assert.equal(ends.length, 1, 'run:end is still emitted');
    assert.equal(ends[0].finishReason, 'error');
    assert.equal(ends[0].failureClass, FailureClass.UNKNOWN, 'the fallback class is unknown');
    assert.equal(error, hostile, 'the same error is rethrown');
});
