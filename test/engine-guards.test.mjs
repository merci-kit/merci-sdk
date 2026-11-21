// @ts-check
/**
 * Packet 04-engine-hardening: focused checks for the three shared engine
 * guards (`assertNotInFlight`, `assertVerifyVerdict`, `assertUsableOutput`) and
 * the wiring that preserves each engine's current error wording.
 */

import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';

import { assertNotInFlight, assertVerifyVerdict, assertUsableOutput, runAgenticLoop, runCriteriaChecks } from '../lib/agentic/agentic-core.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { MerciError, ConfigurationError } from '../lib/core/errors.mjs';
import { ERROR_CODES, FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';

describe('assertNotInFlight', () => {
    test('passes when the flag is falsy', () => {
        assert.doesNotThrow(() => assertNotInFlight({ flag: false, label: 'x' }));
        assert.doesNotThrow(() => assertNotInFlight({ flag: undefined, label: 'x' }));
        assert.doesNotThrow(() => assertNotInFlight({ flag: 0, label: 'x' }));
    });

    test('throws a MerciError (CONCURRENT_RUN) carrying the label verbatim', () => {
        const label = 'Engine.run() is already in flight; concurrent runs are not supported.';
        assert.throws(() => assertNotInFlight({ flag: true, label }), (/** @type {any} */ err) => {
            assert.ok(err instanceof MerciError);
            assert.equal(err.code, ERROR_CODES.CONCURRENT_RUN);
            assert.equal(err.message, label);
            return true;
        });
    });
});

describe('assertVerifyVerdict', () => {
    test('accepts a verdict with a boolean passed', () => {
        assert.doesNotThrow(() => assertVerifyVerdict({ verdict: { passed: true, evidence: 'e' }, label: 'Step [a]' }));
        assert.doesNotThrow(() => assertVerifyVerdict({ verdict: { passed: false }, label: 'Step [a]' }));
    });

    test('rejects an object verdict with no boolean passed', () => {
        // Inverted in 2.7 (D-2): `{}` used to be accepted, so a verify that
        // returned no decision at all was recorded as a pass. A verdict that
        // does not say `true` or `false` must fail closed.
        for (const verdict of [{}, { passed: undefined }, { passed: 'false' }, { passed: 1 }, { passed: Promise.resolve(false) }]) {
            assert.throws(() => assertVerifyVerdict({ verdict, label: 'Step [a]' }), (/** @type {any} */ err) => {
                assert.ok(err instanceof ConfigurationError);
                assert.equal(err.code, ERROR_CODES.CONFIG);
                assert.equal(err.option, 'verify');
                return true;
            });
        }
    });

    test('rejects null / non-object verdicts with a ConfigurationError (option: verify)', () => {
        for (const bad of [null, undefined, 42, 'x', true]) {
            assert.throws(() => assertVerifyVerdict({ verdict: bad, label: 'Step [a]' }), (/** @type {any} */ err) => {
                assert.ok(err instanceof ConfigurationError);
                assert.equal(err.code, ERROR_CODES.CONFIG);
                assert.equal(err.option, 'verify');
                assert.equal(err.message, 'Step [a] verify must return { passed, evidence }');
                return true;
            });
        }
    });
});

test('D-2: a non-boolean passed is a configuration error, not a pass', async () => {
    for (const passed of ['false', 1, Promise.resolve(false)]) {
        assert.throws(() => assertVerifyVerdict({ verdict: { passed }, label: 'Step [a]' }), (/** @type {any} */ err) => {
            assert.ok(err instanceof ConfigurationError, 'a non-boolean passed must be a configuration error');
            assert.equal(err.option, 'verify');
            return true;
        });
    }
    // The same verdict from a completion criterion or a custom judge is refused.
    await assert.rejects(
        runCriteriaChecks({ ctx: {}, criteria: [{ name: 'c', check: /** @type {any} */ (() => ({ passed: 'false' })) }] }),
        (/** @type {any} */ err) => err instanceof ConfigurationError
    );
    await assert.rejects(
        runCriteriaChecks({ ctx: {}, criteria: [], judge: /** @type {any} */ (async () => ({ passed: Promise.resolve(false) })) }),
        (/** @type {any} */ err) => err instanceof ConfigurationError
    );
});

describe('assertUsableOutput', () => {
    test('returns usable text unchanged', () => {
        assert.equal(assertUsableOutput({ text: 'hello', what: 'x' }), 'hello');
        assert.equal(assertUsableOutput({ text: '  pad  ', what: 'x' }), '  pad  ');
    });

    test('throws EMPTY_OUTPUT_CODE for an SDK fallback sentinel, message = what', () => {
        for (const sentinel of [FALLBACK_MESSAGE.MAX_ITERATIONS, FALLBACK_MESSAGE.SCHEMA_VALIDATION, FALLBACK_MESSAGE.EMPTY_RESPONSE]) {
            assert.throws(() => assertUsableOutput({ text: sentinel, what: 'agent produced no usable text' }), (/** @type {any} */ err) => {
                assert.equal(err.code, 'EMPTY_OUTPUT');
                assert.equal(err.message, 'agent produced no usable text');
                return true;
            });
        }
    });

    test('throws EMPTY_OUTPUT_CODE for empty / whitespace / nullish text', () => {
        for (const text of ['', '   ', '\n\t', null, undefined]) {
            assert.throws(() => assertUsableOutput({ text, what: 'empty' }), (/** @type {any} */ err) => err.code === 'EMPTY_OUTPUT' && err.message === 'empty');
        }
    });
});

describe('engine wiring preserves the current wording', () => {
    test('runAgenticLoop refuses a session with a run already in flight', async () => {
        await assert.rejects(
            () => runAgenticLoop({ session: /** @type {any} */ ({ _runInFlight: true }), messages: [] }),
            (/** @type {any} */ err) => {
                assert.equal(err.code, ERROR_CODES.CONCURRENT_RUN);
                assert.equal(err.message, 'This session already has a run in flight; concurrent runs on one session are not supported.');
                return true;
            }
        );
    });

    test('WorkflowExecutor.execute refuses a second concurrent execution', async () => {
        const executor = new WorkflowExecutor({ options: { client: { session: () => ({}) }, defaultModel: 'm' } });
        /** @type {any} */ (executor)._executing = true;
        await assert.rejects(
            () => executor.execute({ userGoal: 'g' }),
            (/** @type {any} */ err) => {
                assert.equal(err.code, ERROR_CODES.CONCURRENT_RUN);
                assert.equal(err.message, 'WorkflowExecutor.execute() is already in flight on this instance; concurrent executions are not supported.');
                return true;
            }
        );
    });

    test('StateMachine.run refuses a concurrent run', async () => {
        /** @type {any} */ let release;
        const gate = new Promise((r) => { release = r; });
        const sm = new StateMachine({ graph: {
            entry: 'a',
            nodes: [{ id: 'a', terminal: true, execute: async () => { await gate; return 'x'; } }],
            edges: [],
        } });
        const first = sm.run();
        const second = sm.run();
        release();
        await first;
        await assert.rejects(second, (/** @type {any} */ err) => {
            assert.equal(err.code, ERROR_CODES.CONCURRENT_RUN);
            assert.equal(err.message, 'StateMachine.run() is already in flight; concurrent runs are not supported.');
            return true;
        });
    });
});
