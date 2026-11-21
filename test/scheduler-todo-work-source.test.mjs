// @ts-check

/**
 * @file P6 contract tests for the todo-store work source.
 * @version 0.12.0
 *
 * @description
 * The SDK's own `TodoComponent` store already holds `{ id, title, status }`
 * records, so a host should not have to write an adapter to feed the scheduler.
 * These tests pin the status mapping (every non-terminal todo is dispatchable),
 * the live read on every call, id normalization and rejection, the shared
 * list/refresh asymmetry, dedupe by trimmed id, cancellation, the caller-
 * `states` filter, and two end-to-end scheduler ticks: dispatch, and a
 * `pending` → `in_progress` lifecycle flip that must not abort the attempt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    WorkScheduler,
    createTodoWorkSource
} from '../lib/agentic/scheduler/index.mjs';
import { AbortedError, ConfigurationError, WorkSourceError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/** Envelope fields `emitEvent` stamps on every event. */
const ENVELOPE_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/**
 * A plain emitter `emitEvent` accepts: it only needs `emit`.
 * @typedef {Object} CapturingEmitter
 * @property {Array<{event: string, [key: string]: unknown}>} events
 * @property {(arg0: string, arg1: Record<string, unknown>) => void} emit
 * @property {() => void} on
 */

/**
 * @returns {CapturingEmitter}
 */
function createEmitter() {
    /** @type {Array<{event: string, [key: string]: unknown}>} */
    const events = [];
    return {
        events,
        emit: (name, payload) => { events.push({ event: name, ...payload }); },
        on: () => {}
    };
}

/**
 * An emitter that aborts the signal the first time a record is skipped, inside
 * the adapter's own loop.
 * @param {{controller: AbortController}} arg0 -
 * @returns {CapturingEmitter}
 */
function createAbortingEmitter({ controller }) {
    /** @type {Array<{event: string, [key: string]: unknown}>} */
    const events = [];
    return {
        events,
        emit: (name, payload) => {
            events.push({ event: name, ...payload });
            if (name === EVENTS.WORK_ITEM.SKIPPED) controller.abort();
        },
        on: () => {}
    };
}

/**
 * @param {{value: CapturingEmitter, name: string}} arg0 -
 * @returns {Array<{event: string, [key: string]: unknown}>}
 */
function eventsNamed({ value, name }) {
    return value.events.filter((entry) => entry.event === name);
}

/**
 * Strip the envelope so a test can compare the documented four-field payload.
 * @param {{event: string, [key: string]: unknown}} entry -
 * @returns {Record<string, unknown>}
 */
function payloadOf(entry) {
    return Object.fromEntries(Object.entries(entry).filter(([key]) => !ENVELOPE_KEYS.has(key)));
}

/**
 * A `TodoComponent`-shaped shared store.
 * @param {Array<Record<string, unknown>>} todos -
 * @returns {Map<unknown, Record<string, unknown>>}
 */
function storeOf(todos) {
    return new Map(todos.map((todo) => [todo.id, todo]));
}

/**
 * @param {{error: unknown, option: string}} arg0 -
 * @returns {boolean}
 */
function isConfigurationError({ error, option }) {
    assert.ok(error instanceof ConfigurationError);
    assert.equal(/** @type {ConfigurationError} */ (error).option, option);
    return true;
}

/**
 * @returns {{promise: Promise<unknown>, resolve: (value: unknown) => void}}
 */
function deferred() {
    /** @type {(value: unknown) => void} */
    let resolve = () => {};
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

/**
 * Let the scheduler drain attempt bookkeeping after a completed run.
 * @param {{rounds?: number}} [arg0] -
 * @returns {Promise<void>}
 */
async function flush({ rounds = 10 } = {}) {
    for (let index = 0; index < rounds; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/**
 * The result every fake workflow returns.
 * @returns {Record<string, unknown>}
 */
function completedResult() {
    return { status: 'completed', usage: { total_tokens: 1, input_tokens: 1, output_tokens: 0, cost_usd: 0 } };
}

test('todo: a todo is dispatchable until it is terminal', () => {
    const store = storeOf([
        { id: 1, title: 'Pending', status: 'pending' },
        { id: 2, title: 'Running', status: 'in_progress' },
        { id: 3, title: 'Done', status: 'completed' },
        { id: 4, title: 'Broken', status: 'failed' },
        { id: 5, title: 'Shouted', status: ' Pending ' }
    ]);
    const source = createTodoWorkSource({ store });

    const listed = source.fetchByStates({ states: ['pending'] });
    assert.deepEqual(listed.map((item) => item.id), ['1', '5']);
    assert.ok(listed.every((item) => item.dispatchable === true));
    assert.equal(listed[0].state, 'pending');
    assert.equal(listed[1].state, 'pending', 'a padded, shouted status normalizes once');

    const refreshed = source.fetchByIds({ ids: ['2', '3', '4'] });
    assert.deepEqual(
        refreshed.map((item) => [item.id, item.state, item.dispatchable]),
        [
            ['2', 'in_progress', true],
            ['3', 'completed', false],
            ['4', 'failed', false]
        ],
        'in_progress is still routable; only completed and failed are terminal'
    );

    assert.deepEqual(source.fetchByIds({ ids: ['missing'] }), [], 'a missing id returns nothing');
});

test('todo: the store is read live, so a status change or a new todo shows on the next call', () => {
    const pending = { id: 1, title: 'One', status: 'pending' };
    const store = storeOf([pending]);
    const source = createTodoWorkSource({ store });

    assert.equal(source.fetchByStates({ states: ['pending'] }).length, 1);

    pending.status = 'completed';
    assert.equal(source.fetchByStates({ states: ['pending'] }).length, 0, 'a completed todo disappears');
    assert.equal(source.fetchByIds({ ids: ['1'] })[0].dispatchable, false);

    store.set(2, { id: 2, title: 'Two', status: 'pending' });
    assert.deepEqual(source.fetchByStates({ states: ['pending'] }).map((item) => item.id), ['2']);
});

test('todo: numeric and string ids both normalize to a string id and identifier', () => {
    const source = createTodoWorkSource({
        store: storeOf([
            { id: 7, title: 'Numeric', status: 'pending' },
            { id: 'M-1', title: 'String', status: 'pending' }
        ])
    });

    const items = source.fetchByStates({ states: ['pending'] });
    assert.deepEqual(items.map((item) => [item.id, item.identifier]), [['7', '7'], ['M-1', 'M-1']]);
    assert.ok(items.every((item) => typeof item.id === 'string'));
});

test('todo: a refresh accepts a finite numeric id', () => {
    const source = createTodoWorkSource({ store: storeOf([{ id: 1, title: 'One', status: 'pending' }]) });

    assert.deepEqual(source.fetchByIds({ ids: [1] }).map((item) => item.id), ['1']);
    assert.deepEqual(source.fetchByIds({ ids: [1, '1'] }).map((item) => item.id), ['1'], 'the ids are a set');
    assert.deepEqual(source.fetchByIds({ ids: [Number.NaN, Number.POSITIVE_INFINITY] }), []);
});

test('todo: numeric 1 and string \'1\' are one id and the extra is a duplicate', () => {
    const emitter = createEmitter();
    const source = createTodoWorkSource({
        store: storeOf([
            { id: 1, title: 'Numeric', status: 'pending' },
            { id: '1', title: 'String', status: 'pending' }
        ]),
        eventEmitter: emitter
    });

    assert.deepEqual(source.fetchByStates({ states: ['pending'] }).map((item) => item.title), ['Numeric']);
    const skipped = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.SKIPPED });
    assert.deepEqual(skipped.map(payloadOf), [
        { source: 'todos', index: 1, file: null, reason: 'duplicate_id' }
    ]);
});

test('todo: a missing or unsupported id is a malformed record, never a false id', () => {
    const emitter = createEmitter();
    const withoutId = { title: 'No id' };
    const source = createTodoWorkSource({
        store: storeOf([
            withoutId,
            { id: null, title: 'Null id', status: 'pending' },
            { id: true, title: 'Boolean id', status: 'pending' },
            { id: [], title: 'Array id', status: 'pending' },
            { id: 1n, title: 'Bigint id', status: 'pending' },
            { id: '   ', title: 'Blank id', status: 'pending' },
            { id: 1, title: 'Fine', status: 'pending' }
        ]),
        eventEmitter: emitter
    });

    assert.deepEqual(source.fetchByStates({ states: ['pending'] }).map((item) => item.id), ['1']);
    assert.deepEqual(
        eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.SKIPPED }).map(payloadOf),
        Array.from({ length: 6 }, (_, index) => ({ source: 'todos', index, file: null, reason: 'malformed' }))
    );
    // A record with no usable id cannot be attributed, so a refresh cannot find it.
    for (const id of ['undefined', 'null', 'true', '']) {
        assert.deepEqual(source.fetchByIds({ ids: [id] }), []);
    }
});

test('todo: a malformed todo is skipped on the list path and fails a refresh', () => {
    const emitter = createEmitter();
    const store = storeOf([
        { id: 9, title: /** @type {any} */ (undefined), status: 'pending' },
        { id: 10, title: 'Fine', status: 'pending' }
    ]);
    const source = createTodoWorkSource({ store, eventEmitter: emitter });

    const listed = source.fetchByStates({ states: ['pending'] });
    assert.deepEqual(listed.map((item) => item.id), ['10'], 'one broken row does not stop the scan');
    const skipped = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.SKIPPED });
    assert.equal(skipped.length, 1);
    assert.deepEqual(payloadOf(skipped[0]), { source: 'todos', index: 0, file: null, reason: 'malformed' });

    assert.throws(() => source.fetchByIds({ ids: ['9'] }), (error) => error instanceof WorkSourceError);
});

test('todo: two ids differing only by whitespace are one id and the extra is a duplicate', () => {
    const emitter = createEmitter();
    const source = createTodoWorkSource({
        store: storeOf([
            { id: 'MER-1', title: 'First', status: 'pending' },
            { id: ' MER-1 ', title: 'Second', status: 'pending' }
        ]),
        eventEmitter: emitter
    });

    const items = source.fetchByStates({ states: ['pending'] });
    assert.deepEqual(items.map((item) => [item.id, item.title]), [['MER-1', 'First']]);
    const skipped = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.SKIPPED });
    assert.equal(skipped.length, 1);
    assert.deepEqual(payloadOf(skipped[0]), { source: 'todos', index: 1, file: null, reason: 'duplicate_id' });

    // The list and refresh paths agree on the trimmed id.
    assert.deepEqual(source.fetchByIds({ ids: [' MER-1 '] }).map((item) => item.id), ['MER-1']);
});

test('todo: an aborted signal throws AbortedError at entry and between records', () => {
    const source = createTodoWorkSource({ store: storeOf([{ id: 1, title: 'One', status: 'pending' }]) });

    const preAborted = new AbortController();
    preAborted.abort();
    const isAborted = (/** @type {unknown} */ error) => error instanceof AbortedError;
    assert.throws(() => source.fetchByStates({ states: ['pending'], signal: preAborted.signal }), isAborted);
    assert.throws(() => source.fetchByIds({ ids: ['1'], signal: preAborted.signal }), isAborted);

    const controller = new AbortController();
    const emitter = createAbortingEmitter({ controller });
    const aborting = createTodoWorkSource({
        store: storeOf([
            { id: 1, title: /** @type {any} */ (undefined), status: 'pending' },
            { id: 2, title: 'Two', status: 'pending' }
        ]),
        eventEmitter: emitter
    });
    assert.throws(() => aborting.fetchByStates({ states: ['pending'], signal: controller.signal }), isAborted);
    assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.SKIPPED }).length, 1);
});

test('todo: the caller\'s states filter the list, like the memory adapter', () => {
    const source = createTodoWorkSource({
        store: storeOf([
            { id: 1, title: 'One', status: 'pending' },
            { id: 2, title: 'Two', status: 'in_progress' },
            { id: 3, title: 'Three', status: 'completed' }
        ])
    });

    const pending = source.fetchByStates({ states: ['pending'] });
    assert.deepEqual(pending.map((item) => item.id), ['1']);
    assert.equal(pending[0].dispatchable, true);

    const inProgress = source.fetchByStates({ states: ['in_progress'] });
    assert.deepEqual(inProgress.map((item) => item.id), ['2']);
    assert.equal(inProgress[0].dispatchable, true);

    assert.deepEqual(source.fetchByStates({ states: ['review'] }), [], 'an unknown state name yields an empty result');
    assert.deepEqual(source.fetchByStates({ states: [] }), [], 'an empty states list asks for nothing');
    assert.deepEqual(
        source.fetchByStates({ states: ['pending', 'in_progress'] }).map((item) => item.id),
        ['1', '2']
    );
});

test('todo: an invalid store is a ConfigurationError', () => {
    const invalidStores = [
        {},
        [],
        null,
        { values: () => undefined, size: 0 },
        { values: () => ({}), size: 0 },
        { values: () => ({ next() {} }), size: 0 },
        { values: () => { throw new Error('broken reader'); }, size: 0 },
        { values: {}, size: 0 },
        { values: () => new Map().values(), size: '0' }
    ];
    for (const store of invalidStores) {
        assert.throws(
            () => createTodoWorkSource({ store: /** @type {any} */ (store) }),
            (error) => isConfigurationError({ error, option: 'store' })
        );
    }
});

test('todo: a dag: mirror row is internal and not schedulable by default', () => {
    const emitter = createEmitter();
    const source = createTodoWorkSource({
        store: storeOf([
            { id: 'dag:step-1', title: 'DAG mirror', status: 'pending' },
            { id: 1, title: 'Host work', status: 'pending' }
        ]),
        eventEmitter: emitter
    });

    assert.deepEqual(source.fetchByStates({ states: ['pending'] }).map((item) => item.id), ['1']);
    assert.deepEqual(source.fetchByIds({ ids: ['dag:step-1'] }), []);
    assert.equal(
        eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.SKIPPED }).length,
        0,
        'an internal row is invisible, not malformed'
    );
});

test('todo: includeInternal opts a dag: row back in', () => {
    const source = createTodoWorkSource({
        store: storeOf([
            { id: 'dag:step-1', title: 'DAG mirror', status: 'pending' },
            { id: 1, title: 'Host work', status: 'pending' }
        ]),
        includeInternal: true
    });

    assert.deepEqual(
        source.fetchByStates({ states: ['pending'] }).map((item) => item.id),
        ['dag:step-1', '1']
    );
    assert.deepEqual(source.fetchByIds({ ids: ['dag:step-1'] }).map((item) => item.dispatchable), [true]);
});

test('todo: a running attempt survives a flip to in_progress and is aborted as terminal on completion', async () => {
    const emitter = createEmitter();
    const todo = { id: 1, title: 'One', status: 'pending' };
    const source = createTodoWorkSource({ store: storeOf([todo]) });
    const gate = deferred();
    /** @type {AbortSignal|null} */
    let attemptSignal = null;
    const workflow = {
        run: async (/** @type {{signal: AbortSignal}} */ { signal }) => {
            attemptSignal = signal;
            return gate.promise;
        }
    };
    const scheduler = new WorkScheduler({
        workSource: source,
        workflow,
        eventEmitter: emitter,
        activeStates: ['pending', 'in_progress'],
        terminalStates: ['completed', 'failed'],
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 1 }
    });

    await scheduler.start();
    try {
        assert.equal(scheduler.snapshot().running.length, 1);
        const signal = /** @type {AbortSignal} */ (/** @type {unknown} */ (attemptSignal));

        todo.status = 'in_progress';
        await scheduler.tick();
        assert.equal(signal.aborted, false, 'the component lifecycle flip is not an abort');
        assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RECONCILED }).length, 0);
        assert.equal(scheduler.snapshot().running[0].state, 'in_progress', 'the item stays routable');

        todo.status = 'completed';
        await scheduler.tick();
        assert.equal(signal.aborted, true);
        assert.equal(signal.reason, 'terminal');
        assert.deepEqual(
            payloadOf(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RECONCILED }).at(-1) ?? { event: '' }),
            { workItemId: '1', identifier: '1', reason: 'terminal', cleanup: true }
        );

        gate.resolve(completedResult());
        await flush();
        const released = eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RELEASED });
        assert.equal(payloadOf(released.at(-1) ?? { event: '' }).reason, 'terminal');
        assert.equal(eventsNamed({ value: emitter, name: EVENTS.WORK_ITEM.RETRY_SCHEDULED }).length, 0);
        assert.equal(scheduler.snapshot().running.length, 0);
    } finally {
        await scheduler.stop();
    }
});

test('todo: WorkScheduler dispatches a pending todo and leaves a completed one alone', async () => {
    const emitter = createEmitter();
    const source = createTodoWorkSource({
        store: storeOf([
            { id: 1, title: 'Pending work', status: 'pending' },
            { id: 2, title: 'Finished work', status: 'completed' }
        ])
    });
    /** @type {string[]} */
    const dispatched = [];
    const workflow = {
        run: async (/** @type {{item: {identifier: string}}} */ { item }) => {
            dispatched.push(item.identifier);
            return completedResult();
        }
    };
    const scheduler = new WorkScheduler({
        workSource: source,
        workflow,
        eventEmitter: emitter,
        activeStates: ['pending', 'in_progress'],
        terminalStates: ['completed', 'failed'],
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 1 }
    });

    await scheduler.start();
    try {
        await scheduler.tick();
        assert.deepEqual(dispatched, ['1']);
    } finally {
        await scheduler.stop();
    }
});
