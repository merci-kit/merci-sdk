// @ts-check

/**
 * @file Stage 2 contract tests for the four read-only work sources.
 * @version 0.12.0
 *
 * @description
 * The adapters share one asymmetry: a malformed record is skipped with a
 * `work_item:skipped` event on the list path and throws on the refresh path.
 * These tests pin that asymmetry per adapter, the exact event payload, the
 * empty-input short-circuit (no normalization, no host call, no filesystem
 * read), and the JSON directory's read-only, one-file-per-item contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    createFunctionWorkSource,
    createJsonFileWorkSource,
    createMemoryWorkSource,
    createTodoWorkSource,
    WORK_SOURCE_CATEGORIES
} from '../lib/agentic/scheduler/work-sources/index.mjs';
import * as schedulerBarrel from '../lib/agentic/scheduler/index.mjs';
import * as constantsBarrel from '../lib/core/constants/index.mjs';
import { AbortedError, ConfigurationError, WorkSourceError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { readStoredJson } from '../lib/support/fs-store.mjs';

const { normalizeWorkItem, sortForDispatch } = schedulerBarrel;

/** Envelope fields `emitEvent` stamps on every event. */
const ENVELOPE_KEYS = new Set(['event', 'runId', 'parentRunId', 'sessionId', 'ts']);

/** The eight Symphony §11.4 work-source categories. */
const EXPECTED_CATEGORIES = [
    'unsupported_tracker_kind',
    'invalid_tracker_config',
    'missing_tracker_secret',
    'tracker_request',
    'tracker_status',
    'tracker_response',
    'tracker_pagination',
    'tracker_rate_limited'
];

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
 * An emitter that aborts the signal the first time a skipped record is
 * reported, inside the adapter's own loop.
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
 * @param {{emitter: CapturingEmitter, name: string}} arg0 -
 * @returns {Array<{event: string, [key: string]: unknown}>}
 */
function eventsNamed({ emitter, name }) {
    return emitter.events.filter((entry) => entry.event === name);
}

/**
 * The domain payload of a captured event, with the envelope removed.
 * @param {{event: string, [key: string]: unknown}} entry -
 * @returns {Record<string, unknown>}
 */
function payloadOf(entry) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of Object.entries(entry)) {
        if (!ENVELOPE_KEYS.has(key)) out[key] = value;
    }
    return out;
}

/**
 * A raw memory/function record with valid defaults.
 * @param {Record<string, unknown>} [overrides] -
 * @returns {Record<string, unknown>}
 */
function rawItem(overrides = {}) {
    return { id: '1', identifier: 'MER-1', title: 'One', state: 'Todo', dispatchable: true, ...overrides };
}

/**
 * Run a body in a fresh temp directory and always clean it up.
 * @param {{fn: (arg0: {dir: string}) => Promise<void>}} arg0 -
 * @returns {Promise<void>}
 */
async function withTempDir({ fn }) {
    const dir = await mkdtemp(join(tmpdir(), 'merci-work-source-'));
    try {
        await fn({ dir });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * A byte-level view of a directory: names plus every regular file's text.
 * @param {{dir: string}} arg0 -
 * @returns {Promise<string[]>}
 */
async function snapshotDir({ dir }) {
    /** @type {string[]} */
    const out = [];
    for (const name of (await readdir(dir)).sort()) {
        const stats = await lstat(join(dir, name));
        if (stats.isDirectory()) out.push(`${name}/`);
        else out.push(`${name}:${await readFile(join(dir, name), 'utf8')}`);
    }
    return out;
}

/**
 * Write one item file named after its id.
 * @param {{dir: string, id: string, overrides?: Record<string, unknown>}} arg0 -
 * @returns {Promise<void>}
 */
async function writeItemFile({ dir, id, overrides = {} }) {
    await writeFile(join(dir, `${id}.json`), JSON.stringify(rawItem({ id, identifier: id, ...overrides })));
}

/**
 * Assert a call rejects with a `WorkSourceError` of the given category/source.
 * Takes a thunk so a synchronous adapter throw is captured too.
 * @param {{run: () => unknown, category: string, source: string}} arg0 -
 * @returns {Promise<WorkSourceError>}
 */
async function rejectsAs({ run, category, source }) {
    /** @type {WorkSourceError[]} */
    const captured = [];
    await assert.rejects(async () => { await run(); }, (error) => {
        assert.ok(error instanceof WorkSourceError, `expected WorkSourceError, got ${String(error)}`);
        captured.push(error);
        return true;
    });
    const error = captured[0];
    assert.equal(error.category, category);
    assert.equal(error.source, source);
    return error;
}

/**
 * @param {{states: Array<string>}} arg0 -
 * @returns {{states: Array<string>}}
 */
function listArg({ states }) {
    return { states };
}

/**
 * @param {{ids: Array<string>}} arg0 -
 * @returns {{ids: Array<string>}}
 */
function refreshArg({ ids }) {
    return { ids };
}

/**
 * Assert a rejection/throw is the cancellation error and not a work-source one.
 * @param {unknown} error -
 * @returns {boolean}
 */
function isAbortedError(error) {
    assert.ok(error instanceof AbortedError, `expected AbortedError, got ${String(error)}`);
    assert.equal(error.code, 'MERCI-ABORTED-ERR');
    assert.equal(error instanceof WorkSourceError, false);
    return true;
}

// ---------------------------------------------------------------------------
// Memory work source
// ---------------------------------------------------------------------------

test('memory: the captured array is by reference, so a host mutation between calls is visible', () => {
    const emitter = createEmitter();
    /** @type {Array<Record<string, unknown>>} */
    const items = [rawItem({ id: '1', identifier: 'MER-1' })];
    const source = createMemoryWorkSource({ items, eventEmitter: emitter });

    assert.deepEqual(source.fetchByStates(listArg({ states: ['todo'] })).map((item) => item.identifier), ['MER-1']);

    items[0].state = 'Done';
    items.push(rawItem({ id: '2', identifier: 'MER-2', state: 'Todo' }));

    assert.deepEqual(source.fetchByStates(listArg({ states: ['todo'] })).map((item) => item.identifier), ['MER-2']);
});

test('memory: the state filter trims and lowercases both sides', () => {
    const source = createMemoryWorkSource({ items: [rawItem({ state: ' TODO ' })] });
    const items = source.fetchByStates(listArg({ states: ['  todo  '] }));
    assert.equal(items.length, 1);
    assert.equal(items[0].state, 'TODO');
});

test('memory: dispatchable false items are full snapshots on both paths', () => {
    const source = createMemoryWorkSource({
        items: [
            rawItem({ id: '1', identifier: 'MER-1', dispatchable: false }),
            rawItem({ id: '2', identifier: 'MER-2', dispatchable: true })
        ]
    });
    const listed = source.fetchByStates(listArg({ states: ['todo'] }));
    assert.deepEqual(listed.map((item) => item.dispatchable), [false, true]);
    const refreshed = source.fetchByIds(refreshArg({ ids: ['1'] }));
    assert.deepEqual(refreshed.map((item) => item.dispatchable), [false]);
});

test('memory: a malformed record is skipped in list mode with exactly one four-key event', () => {
    const emitter = createEmitter();
    const source = createMemoryWorkSource({
        items: [
            rawItem({ id: '1', identifier: 'MER-1' }),
            { id: 'BAD', identifier: 'BAD', title: 'SECRET TITLE', description: 'SECRET DESC' }
        ],
        eventEmitter: emitter
    });

    const items = source.fetchByStates(listArg({ states: ['todo'] }));
    assert.deepEqual(items.map((item) => item.identifier), ['MER-1']);

    const skipped = eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED });
    assert.equal(skipped.length, 1);
    assert.deepEqual(payloadOf(skipped[0]), { source: 'memory', index: 1, file: null, reason: 'malformed' });
    assert.deepEqual(Object.keys(payloadOf(skipped[0])).sort(), ['file', 'index', 'reason', 'source']);
    const serialized = JSON.stringify(skipped[0]);
    assert.equal(serialized.includes('SECRET TITLE'), false);
    assert.equal(serialized.includes('SECRET DESC'), false);
    assert.equal(serialized.includes('BAD'), false);
});

test('memory: a malformed requested record throws tracker_response', async () => {
    const source = createMemoryWorkSource({ items: [{ id: 'BAD', identifier: 'BAD' }] });
    await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: ['BAD'] })), category: 'tracker_response', source: 'memory' });
});

test('memory: a malformed unrequested record never fails the refresh', () => {
    const emitter = createEmitter();
    const source = createMemoryWorkSource({
        items: [rawItem({ id: '1', identifier: 'MER-1' }), { id: 'BAD', identifier: 'BAD' }],
        eventEmitter: emitter
    });
    assert.deepEqual(source.fetchByIds(refreshArg({ ids: ['1'] })).map((item) => item.identifier), ['MER-1']);
    assert.equal(emitter.events.length, 0);
});

test('memory: a listed trimmed id is the id refresh matches, with or without padding', () => {
    const source = createMemoryWorkSource({ items: [rawItem({ id: ' MER-1 ', identifier: 'MER-1' })] });

    assert.deepEqual(source.fetchByStates(listArg({ states: ['todo'] })).map((item) => item.id), ['MER-1']);
    const byTrimmed = source.fetchByIds(refreshArg({ ids: ['MER-1'] }));
    assert.deepEqual(byTrimmed.map((item) => item.id), ['MER-1']);
    assert.deepEqual(source.fetchByIds(refreshArg({ ids: [' MER-1 '] })), byTrimmed);
});

test('memory: three records sharing an id keep the first on both paths and report each extra', () => {
    const records = [
        rawItem({ id: '1', identifier: 'MER-1' }),
        rawItem({ id: '1', identifier: 'MER-1-B' }),
        rawItem({ id: '1', identifier: 'MER-1-C' })
    ];

    const listEmitter = createEmitter();
    const listSource = createMemoryWorkSource({ items: records, eventEmitter: listEmitter });
    assert.deepEqual(listSource.fetchByStates(listArg({ states: ['todo'] })).map((item) => item.identifier), ['MER-1']);
    assert.deepEqual(eventsNamed({ emitter: listEmitter, name: EVENTS.WORK_ITEM.SKIPPED }).map(payloadOf), [
        { source: 'memory', index: 1, file: null, reason: 'duplicate_id' },
        { source: 'memory', index: 2, file: null, reason: 'duplicate_id' }
    ]);

    const refreshEmitter = createEmitter();
    const refreshSource = createMemoryWorkSource({ items: records, eventEmitter: refreshEmitter });
    assert.deepEqual(refreshSource.fetchByIds(refreshArg({ ids: ['1'] })).map((item) => item.identifier), ['MER-1']);
    assert.equal(eventsNamed({ emitter: refreshEmitter, name: EVENTS.WORK_ITEM.SKIPPED }).length, 2);
});

test('memory: an out-of-state record does not shadow a later in-state record with the same id', () => {
    const emitter = createEmitter();
    const source = createMemoryWorkSource({
        items: [
            rawItem({ id: '1', identifier: 'MER-1-DONE', state: 'Done' }),
            rawItem({ id: '1', identifier: 'MER-1-LIVE', state: 'Todo' })
        ],
        eventEmitter: emitter
    });

    const items = source.fetchByStates(listArg({ states: ['todo'] }));
    assert.deepEqual(items.map((item) => item.identifier), ['MER-1-LIVE']);
    // The Done record was never part of the result set, so it is not a duplicate.
    assert.equal(eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED }).length, 0);
});

test('memory: only in-state records sharing an id are reported as duplicates', () => {
    const emitter = createEmitter();
    const source = createMemoryWorkSource({
        items: [
            rawItem({ id: '1', identifier: 'MER-1-DONE', state: 'Done' }),
            rawItem({ id: '1', identifier: 'MER-1-A', state: 'Todo' }),
            rawItem({ id: '1', identifier: 'MER-1-B', state: 'Todo' })
        ],
        eventEmitter: emitter
    });

    assert.deepEqual(source.fetchByStates(listArg({ states: ['todo'] })).map((item) => item.identifier), ['MER-1-A']);
    assert.deepEqual(eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED }).map(payloadOf), [
        { source: 'memory', index: 2, file: null, reason: 'duplicate_id' }
    ]);
});

test('memory: an out-of-state and an in-state record with different ids return only the in-state one', () => {
    const emitter = createEmitter();
    const source = createMemoryWorkSource({
        items: [
            rawItem({ id: '1', identifier: 'MER-1', state: 'Done' }),
            rawItem({ id: '2', identifier: 'MER-2', state: 'Todo' })
        ],
        eventEmitter: emitter
    });

    assert.deepEqual(source.fetchByStates(listArg({ states: ['todo'] })).map((item) => item.id), ['2']);
    assert.equal(emitter.events.length, 0);
});

test('memory: a refresh result is the full normalized snapshot, not only dispatchable', () => {
    const source = createMemoryWorkSource({
        items: [rawItem({
            id: '1',
            identifier: 'MER-1',
            title: 'One',
            state: 'Todo',
            dispatchable: false,
            labels: ['Bug', 'BUG', 'ops'],
            priority: 2,
            createdAt: '2026-01-02T03:04:05Z',
            updatedAt: '2026-02-03T04:05:06Z',
            lane: 'ops',
            nativeRef: { repo: 'r' },
            metadata: { k: 'v' },
            blockedBy: [{ id: '2', identifier: 'MER-2', state: 'Todo' }],
            description: 'the description',
            url: 'https://example.test/1'
        })]
    });

    const [item] = source.fetchByIds(refreshArg({ ids: ['1'] }));
    assert.deepEqual(item, {
        id: '1',
        identifier: 'MER-1',
        title: 'One',
        state: 'Todo',
        dispatchable: false,
        labels: ['bug', 'ops'],
        priority: 2,
        createdAt: Date.parse('2026-01-02T03:04:05Z'),
        updatedAt: Date.parse('2026-02-03T04:05:06Z'),
        lane: 'ops',
        nativeRef: { repo: 'r' },
        metadata: { k: 'v' },
        blockedBy: [{ id: '2', identifier: 'MER-2', state: 'Todo' }],
        description: 'the description',
        url: 'https://example.test/1'
    });
});

test('memory: duplicate source ids keep the first and emit one duplicate_id event', () => {
    const emitter = createEmitter();
    const source = createMemoryWorkSource({
        items: [
            rawItem({ id: '1', identifier: 'MER-1' }),
            rawItem({ id: '1', identifier: 'MER-1-DUP' })
        ],
        eventEmitter: emitter
    });

    const items = source.fetchByIds(refreshArg({ ids: ['1'] }));
    assert.deepEqual(items.map((item) => item.identifier), ['MER-1']);

    const skipped = eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED });
    assert.equal(skipped.length, 1);
    assert.deepEqual(payloadOf(skipped[0]), { source: 'memory', index: 1, file: null, reason: 'duplicate_id' });
});

test('memory: input ids are a set and an unknown id is omitted', () => {
    const emitter = createEmitter();
    const source = createMemoryWorkSource({ items: [rawItem()], eventEmitter: emitter });

    assert.equal(source.fetchByIds(refreshArg({ ids: ['1', '1'] })).length, 1);
    assert.deepEqual(source.fetchByIds(refreshArg({ ids: ['nope'] })), []);
    assert.equal(emitter.events.length, 0);
});

test('memory: a non-array items option is a ConfigurationError', () => {
    assert.throws(
        () => createMemoryWorkSource({ items: { id: '1' } }),
        (error) => error instanceof ConfigurationError && error.option === 'items'
    );
});

test('memory: empty states or ids return [] with no normalization work', () => {
    const emitter = createEmitter();
    const source = createMemoryWorkSource({ items: [{ not: 'a record' }], eventEmitter: emitter });

    assert.deepEqual(source.fetchByStates(listArg({ states: [] })), []);
    assert.deepEqual(source.fetchByIds(refreshArg({ ids: [] })), []);
    assert.equal(emitter.events.length, 0);
});

test('memory: a null or non-string-id record is ignored on refresh', () => {
    const emitter = createEmitter();
    const source = createMemoryWorkSource({
        items: [null, 'not a record', { id: 42, identifier: 'NUM' }, rawItem({ id: '1', identifier: 'MER-1' })],
        eventEmitter: emitter
    });

    assert.deepEqual(source.fetchByIds(refreshArg({ ids: ['1'] })).map((item) => item.identifier), ['MER-1']);
    assert.equal(emitter.events.length, 0);
});

test('memory: a record whose id getter throws cannot be attributed and is ignored on refresh', () => {
    const hostile = rawItem({ id: '1', identifier: 'MER-1' });
    Object.defineProperty(hostile, 'id', { get() { throw new Error('hostile getter'); } });
    const emitter = createEmitter();
    const source = createMemoryWorkSource({
        items: [hostile, rawItem({ id: '2', identifier: 'MER-2' })],
        eventEmitter: emitter
    });

    assert.deepEqual(source.fetchByIds(refreshArg({ ids: ['1', '2'] })).map((item) => item.identifier), ['MER-2']);
    assert.equal(emitter.events.length, 0);
});

test('memory: an already-aborted signal throws AbortedError at entry and emits nothing', () => {
    const emitter = createEmitter();
    const source = createMemoryWorkSource({
        items: [{ bad: true }, rawItem({ id: '1', identifier: 'MER-1' })],
        eventEmitter: emitter
    });
    const controller = new AbortController();
    controller.abort();

    assert.throws(() => source.fetchByStates({ states: ['todo'], signal: controller.signal }), isAbortedError);
    // The entry check precedes the empty-query short-circuit, so an aborted
    // signal still throws when there is no work to do.
    assert.throws(() => source.fetchByStates({ states: [], signal: controller.signal }), isAbortedError);
    assert.throws(() => source.fetchByIds({ ids: ['1'], signal: controller.signal }), isAbortedError);
    assert.equal(emitter.events.length, 0);
});

test('memory: an abort raised while reading a record stops the refresh before the next one', () => {
    const controller = new AbortController();
    const first = rawItem({ id: '1', identifier: 'MER-1' });
    // A getter that cancels after the loop has started; the next iteration's
    // check is the only place the abort can surface.
    Object.defineProperty(first, 'id', {
        get() {
            controller.abort();
            return '1';
        }
    });
    const source = createMemoryWorkSource({ items: [first, rawItem({ id: '2', identifier: 'MER-2' })] });

    assert.throws(() => source.fetchByIds({ ids: ['1', '2'], signal: controller.signal }), isAbortedError);
});

// ---------------------------------------------------------------------------
// JSON file work source
// ---------------------------------------------------------------------------

test('json: list mode reads *.json files in file-name order and ignores other entries', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        await writeItemFile({ dir, id: 'MER-2' });
        await writeItemFile({ dir, id: 'MER-1' });
        await writeItemFile({ dir, id: 'MER-3', overrides: { state: 'Done' } });
        await writeItemFile({ dir, id: 'MER-4', overrides: { state: ' TODO ' } });
        await writeFile(join(dir, 'notes.tmp'), 'ignored');
        // A `.tmp` holding valid JSON is still not an item file.
        await writeFile(join(dir, 'valid.tmp'), JSON.stringify(rawItem({ id: 'TMP', identifier: 'TMP' })));
        await mkdir(join(dir, 'nested'));
        await writeItemFile({ dir: join(dir, 'nested'), id: 'MER-9' });
        // A directory that ends in .json: readdir lists it, reading it is EISDIR.
        await mkdir(join(dir, 'B.json'));

        const source = await createJsonFileWorkSource({ dir, eventEmitter: emitter });
        const items = await source.fetchByStates(listArg({ states: ['todo'] }));

        // The out-of-state MER-3 is excluded; a padded state still matches.
        assert.deepEqual(items.map((item) => item.identifier), ['MER-1', 'MER-2', 'MER-4']);
        assert.equal(items.at(-1)?.state, 'TODO');
        const skipped = eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED });
        assert.equal(skipped.length, 1);
        assert.deepEqual(payloadOf(skipped[0]), { source: 'json', index: 0, file: 'B.json', reason: 'malformed' });
    } });
});

test('json: a parse error and a valid-but-invalid record are skipped with the file name', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        await writeItemFile({ dir, id: 'MER-1' });
        await writeFile(join(dir, 'BAD.json'), '{ not json');
        // Valid JSON that is not a record object: a top-level array and null.
        await writeFile(join(dir, 'ARRAY.json'), '[]');
        await writeFile(join(dir, 'NULL.json'), 'null');
        await writeFile(join(dir, 'SHAPE.json'), JSON.stringify({ id: 'SHAPE', identifier: 'SHAPE', title: 'x' }));

        const source = await createJsonFileWorkSource({ dir, eventEmitter: emitter });
        const items = await source.fetchByStates(listArg({ states: ['todo'] }));

        assert.deepEqual(items.map((item) => item.identifier), ['MER-1']);
        const skipped = eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED });
        assert.deepEqual(skipped.map((entry) => payloadOf(entry).file), ['ARRAY.json', 'BAD.json', 'NULL.json', 'SHAPE.json']);
        assert.deepEqual(skipped.map((entry) => payloadOf(entry).reason), ['malformed', 'malformed', 'malformed', 'malformed']);
    } });
});

test('json: an id that differs from the file stem is skipped as id_filename_mismatch', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        await writeItemFile({ dir, id: 'MER-5', overrides: { id: 'MER-6' } });

        const source = await createJsonFileWorkSource({ dir, eventEmitter: emitter });
        assert.deepEqual(await source.fetchByStates(listArg({ states: ['todo'] })), []);
        const skipped = eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED });
        assert.deepEqual(payloadOf(skipped[0]), { source: 'json', index: 0, file: 'MER-5.json', reason: 'id_filename_mismatch' });
    } });
});

test('json: a missing or non-directory dir is a ConfigurationError at construction', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        await rejectsAsConstruct({ dir: join(dir, 'nope') });
        const file = join(dir, 'file.txt');
        await writeFile(file, 'x');
        await rejectsAsConstruct({ dir: file });
        await rejectsAsConstruct({ dir: '' });
        await rejectsAsConstruct({ dir: /** @type {unknown} */ (42) });
    } });
});

/**
 * @param {{dir: unknown}} arg0 -
 * @returns {Promise<void>}
 */
async function rejectsAsConstruct({ dir }) {
    await assert.rejects(createJsonFileWorkSource({ dir }), (error) => {
        assert.ok(error instanceof ConfigurationError, `expected ConfigurationError, got ${String(error)}`);
        assert.equal(error.option, 'dir');
        return true;
    });
}

test('json: a missing requested file is omitted and a malformed one throws', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        await writeItemFile({ dir, id: 'MER-1' });
        await writeFile(join(dir, 'BAD.json'), '{ not json');
        const source = await createJsonFileWorkSource({ dir });

        // A duplicate input id is a set: it is read once.
        assert.deepEqual((await source.fetchByIds(refreshArg({ ids: ['MER-1', 'MER-1', 'NOPE'] }))).map((item) => item.identifier), ['MER-1']);
        await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: ['BAD'] })), category: 'tracker_response', source: 'json' });
    } });
});

test('json: a requested id that differs from the file stem throws', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        await writeItemFile({ dir, id: 'MER-5', overrides: { id: 'MER-6' } });
        const source = await createJsonFileWorkSource({ dir });
        const error = await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: ['MER-5'] })), category: 'tracker_response', source: 'json' });
        assert.equal(error.message.includes('MER-6'), false);
    } });
});

test('json: requested ids are trimmed, so a padded id and its plain form read one file once', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        await writeItemFile({ dir, id: 'MER-1' });
        const source = await createJsonFileWorkSource({ dir });

        const items = await source.fetchByIds(refreshArg({ ids: [' MER-1 ', 'MER-1'] }));
        assert.deepEqual(items.map((item) => item.id), ['MER-1']);
        // A lone padded id needs the trim too: without it the stem lookup
        // misses the file and the item silently disappears.
        assert.deepEqual((await source.fetchByIds(refreshArg({ ids: [' MER-1 '] }))).map((item) => item.id), ['MER-1']);
        assert.deepEqual((await source.fetchByIds(refreshArg({ ids: ['\tMER-1\n'] }))).map((item) => item.id), ['MER-1']);
        // The unsafe-id refusal sees the trimmed value, never the padded one.
        assert.deepEqual(await source.fetchByIds(refreshArg({ ids: [' ../outside '] })), []);
    } });
});

test('json: non-string ids are ignored and the string ids still read', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        await writeItemFile({ dir, id: 'MER-1' });
        const source = await createJsonFileWorkSource({ dir });

        // A typed caller cannot pass these, but a JS host can; 42 and null are
        // not file stems and must not fail the refresh.
        const items = await source.fetchByIds({ ids: [42, null, 'MER-1'] });
        assert.deepEqual(items.map((item) => item.id), ['MER-1']);
    } });
});

test('json: an abort from the skip emitter stops the list before the next file', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        // A corrupt file sorts first and emits one skip; B.json is valid and
        // must never make it into a resolved prefix.
        await writeFile(join(dir, 'A.json'), '{ not json');
        await writeItemFile({ dir, id: 'B' });

        const controller = new AbortController();
        const emitter = createAbortingEmitter({ controller });
        const source = await createJsonFileWorkSource({ dir, eventEmitter: emitter });

        await assert.rejects(source.fetchByStates({ states: ['todo'], signal: controller.signal }), isAbortedError);
        assert.equal(eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED }).length, 1);
    } });
});

test('json: an already-aborted signal rejects before reading a deleted directory', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const work = join(dir, 'work');
        await mkdir(work);
        await writeItemFile({ dir: work, id: 'MER-1' });
        const source = await createJsonFileWorkSource({ dir: work });
        // A read would now fail as tracker_request; the abort must win first.
        await rm(work, { recursive: true, force: true });

        const controller = new AbortController();
        controller.abort();
        await assert.rejects(source.fetchByStates({ states: ['todo'], signal: controller.signal }), isAbortedError);
        await assert.rejects(source.fetchByIds({ ids: ['MER-1'], signal: controller.signal }), isAbortedError);
    } });
});

test('json: an abort during a listing rejects with AbortedError and never returns partial results', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        for (const id of ['MER-1', 'MER-2', 'MER-3', 'MER-4']) await writeItemFile({ dir, id });
        const source = await createJsonFileWorkSource({ dir });

        const controller = new AbortController();
        const pending = source.fetchByStates({ states: ['todo'], signal: controller.signal });
        // Abort after the call has started: the first awaited readdir is in
        // flight, and the call must reject rather than resolve a prefix.
        queueMicrotask(() => controller.abort());

        await assert.rejects(pending, isAbortedError);
    } });
});

test('json: a requested record with valid JSON but an invalid shape throws tracker_response', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        await writeFile(join(dir, 'SHAPE.json'), JSON.stringify({ id: 'SHAPE', identifier: 'SHAPE', title: 'x' }));
        const source = await createJsonFileWorkSource({ dir });
        await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: ['SHAPE'] })), category: 'tracker_response', source: 'json' });
    } });
});

test('json: a parse failure never exposes the file content', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const sentinel = 'SECRET-PAYLOAD';
        await writeFile(join(dir, 'RAW.json'), sentinel);
        await writeFile(join(dir, 'TRUNC.json'), `{"id":"TRUNC","description":"${sentinel}"`);
        const source = await createJsonFileWorkSource({ dir });

        for (const id of ['RAW', 'TRUNC']) {
            const error = await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: [id] })), category: 'tracker_response', source: 'json' });
            assert.equal(error.cause, undefined);
            assert.equal(error.message.includes('is not valid JSON'), true);
            /** @type {string[]} */
            const texts = [error.message, String(error.stack)];
            for (const key of Object.getOwnPropertyNames(error)) {
                texts.push(String(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (error))[key]));
            }
            assert.equal(texts.some((text) => text.includes(sentinel)), false, `leaked the content of ${id}`);
        }
    } });
});

test('json: a file the repair parser would heal is still rejected on both paths', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        // Both are invalid JSON that `@freakynit/json-healer` would repair; a
        // board file must be rejected, never healed.
        await writeFile(join(dir, 'TRAILING.json'), '{"id":"TRAILING","identifier":"TRAILING","title":"x","state":"Todo","dispatchable":true,}');
        await writeFile(join(dir, 'BARE.json'), '{id:"BARE",identifier:"BARE",title:"x",state:"Todo",dispatchable:true}');

        const emitter = createEmitter();
        const source = await createJsonFileWorkSource({ dir, eventEmitter: emitter });
        assert.deepEqual(await source.fetchByStates(listArg({ states: ['todo'] })), []);

        const skipped = eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED });
        assert.deepEqual(skipped.map((entry) => payloadOf(entry).file), ['BARE.json', 'TRAILING.json']);
        assert.deepEqual(skipped.map((entry) => payloadOf(entry).reason), ['malformed', 'malformed']);

        for (const id of ['BARE', 'TRAILING']) {
            const error = await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: [id] })), category: 'tracker_response', source: 'json' });
            assert.equal(error.message.includes('is not valid JSON'), true);
            assert.equal(error.cause, undefined);
        }
    } });
});

test('json: a corrupt refresh error never carries the primitive reason or a file sentinel', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const sentinel = 'SECRETPAY';
        const file = join(dir, 'POISON.json');
        await writeFile(file, `${sentinel}{{ not json`);
        // The primitive's `reason` is the parser message: non-empty, dropped.
        const stored = await readStoredJson({ filePath: file });
        assert.equal(stored.status, 'corrupt');
        assert.equal(typeof stored.reason, 'string');
        assert.ok(/** @type {string} */ (stored.reason).length > 0);

        const source = await createJsonFileWorkSource({ dir });
        const error = await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: ['POISON'] })), category: 'tracker_response', source: 'json' });
        assert.equal(error.cause, undefined);
        assert.equal(error.message.includes('is not valid JSON'), true);
        /** @type {string[]} */
        const texts = [error.message, String(error.stack)];
        for (const key of Object.getOwnPropertyNames(error)) {
            texts.push(String(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (error))[key]));
        }
        assert.equal(texts.some((text) => text.includes(sentinel)), false);
    } });
});

test('json: a truncated file behaves as a corrupt record on both paths', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        await writeFile(join(dir, 'TRUNC.json'), '{"id":"TRUNC","identifier":"TRUNC","title":"T');
        const emitter = createEmitter();
        const source = await createJsonFileWorkSource({ dir, eventEmitter: emitter });

        assert.deepEqual(await source.fetchByStates(listArg({ states: ['todo'] })), []);
        const skipped = eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED });
        assert.deepEqual(payloadOf(skipped[0]), { source: 'json', index: 0, file: 'TRUNC.json', reason: 'malformed' });

        const error = await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: ['TRUNC'] })), category: 'tracker_response', source: 'json' });
        assert.equal(error.message.includes('is not valid JSON'), true);
        assert.equal(error.cause, undefined);
        assert.equal(error.message.includes('title'), false);
    } });
});

test('json: a dot-prefixed file name that stays inside the dir lists and refreshes', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        await writeItemFile({ dir, id: '..backlog' });
        const source = await createJsonFileWorkSource({ dir });

        assert.deepEqual((await source.fetchByStates(listArg({ states: ['todo'] }))).map((item) => item.id), ['..backlog']);
        assert.deepEqual((await source.fetchByIds(refreshArg({ ids: ['..backlog'] }))).map((item) => item.id), ['..backlog']);
    } });
});

test('json: a file name that cannot name an id is skipped as unsafe_id', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const emitter = createEmitter();
        const body = JSON.stringify(rawItem({ id: 'X', identifier: 'X' }));
        await writeFile(join(dir, '..json'), body);
        await writeFile(join(dir, '...json'), body);
        // A backslash is a legal POSIX file-name character but a separator on
        // Windows, where such a file cannot exist at all.
        const posixName = process.platform === 'win32' ? null : 'a\\b.json';
        if (posixName) await writeFile(join(dir, posixName), body);

        const source = await createJsonFileWorkSource({ dir, eventEmitter: emitter });
        assert.deepEqual(await source.fetchByStates(listArg({ states: ['todo'] })), []);

        /** @type {Array<Record<string, unknown>>} */
        const expected = [
            { source: 'json', index: 0, file: '...json', reason: 'unsafe_id' },
            { source: 'json', index: 1, file: '..json', reason: 'unsafe_id' }
        ];
        if (posixName) expected.push({ source: 'json', index: 2, file: posixName, reason: 'unsafe_id' });
        assert.deepEqual(eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED }).map(payloadOf), expected);
    } });
});

test('json: an unsafe id is omitted with no IO and never reaches a file outside the dir', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const work = join(dir, 'work');
        await mkdir(work);
        await writeItemFile({ dir: work, id: 'MER-1' });
        await writeItemFile({ dir, id: 'outside' });

        const source = await createJsonFileWorkSource({ dir: work });
        const items = await source.fetchByIds(refreshArg({ ids: ['../outside', 'a/b', '.', '..', 'outside'] }));

        assert.deepEqual(items, []);
        // No safe id at all: the call short-circuits without touching the dir.
        assert.deepEqual(await source.fetchByIds(refreshArg({ ids: ['../outside', 'a/b', '.', '..'] })), []);
    } });
});

test('json: an over-long id is omitted instead of failing the refresh', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const source = await createJsonFileWorkSource({ dir });
        assert.deepEqual(await source.fetchByIds(refreshArg({ ids: ['x'.repeat(5000)] })), []);
    } });
});

test('json: empty states/ids return [] even after the directory disappears', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const work = join(dir, 'work');
        await mkdir(work);
        await writeItemFile({ dir: work, id: 'MER-1' });
        const source = await createJsonFileWorkSource({ dir: work });
        await rm(work, { recursive: true, force: true });

        assert.deepEqual(await source.fetchByStates(listArg({ states: [] })), []);
        assert.deepEqual(await source.fetchByIds(refreshArg({ ids: [] })), []);
    } });
});

test('json: a directory that disappears after construction fails both calls as tracker_request', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const work = join(dir, 'work');
        await mkdir(work);
        const source = await createJsonFileWorkSource({ dir: work });
        await rm(work, { recursive: true, force: true });

        await rejectsAs({ run: () => source.fetchByStates(listArg({ states: ['todo'] })), category: 'tracker_request', source: 'json' });
        await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: ['a'] })), category: 'tracker_request', source: 'json' });
    } });
});

test('json: a directory replaced by a file after construction fails the refresh as tracker_request', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const work = join(dir, 'work');
        await mkdir(work);
        const source = await createJsonFileWorkSource({ dir: work });
        await rm(work, { recursive: true, force: true });
        await writeFile(work, 'not a directory');

        await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: ['a'] })), category: 'tracker_request', source: 'json' });
    } });
});

test('json: a requested entry that is a directory throws instead of being read', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        await mkdir(join(dir, 'B.json'));
        const source = await createJsonFileWorkSource({ dir });
        await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: ['B'] })), category: 'tracker_response', source: 'json' });
    } });
});

test('json: both operations leave the directory byte-identical', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        await writeItemFile({ dir, id: 'MER-1' });
        await writeItemFile({ dir, id: 'MER-2' });
        await writeFile(join(dir, 'BAD.json'), '{ not json');
        await writeFile(join(dir, 'notes.tmp'), 'ignored');
        const before = await snapshotDir({ dir });

        const source = await createJsonFileWorkSource({ dir });
        await source.fetchByStates(listArg({ states: ['todo'] }));
        await source.fetchByIds(refreshArg({ ids: ['MER-1', 'MER-2', 'NOPE'] }));

        assert.deepEqual(await snapshotDir({ dir }), before);
    } });
});

// ---------------------------------------------------------------------------
// Function work source
// ---------------------------------------------------------------------------

test('function: both operations are required', () => {
    assert.throws(
        () => createFunctionWorkSource({ fetchByIds: async () => [] }),
        (error) => error instanceof ConfigurationError && error.option === 'fetchByStates'
    );
    assert.throws(
        () => createFunctionWorkSource({ fetchByStates: async () => [] }),
        (error) => error instanceof ConfigurationError && error.option === 'fetchByIds'
    );
});

test('function: the host receives the exact argument object', async () => {
    /** @type {Array<Record<string, unknown>>} */
    const listCalls = [];
    /** @type {Array<Record<string, unknown>>} */
    const refreshCalls = [];
    const signal = new AbortController().signal;
    const source = createFunctionWorkSource({
        fetchByStates: async (args) => { listCalls.push(args); return [rawItem()]; },
        fetchByIds: async (args) => { refreshCalls.push(args); return [rawItem()]; }
    });

    await source.fetchByStates({ states: ['Todo'], signal });
    await source.fetchByIds({ ids: ['1'], signal });

    assert.deepEqual(Object.keys(listCalls[0]).sort(), ['signal', 'states']);
    assert.deepEqual(listCalls[0].states, ['Todo']);
    assert.equal(listCalls[0].signal, signal);
    assert.deepEqual(Object.keys(refreshCalls[0]).sort(), ['ids', 'signal']);
    assert.deepEqual(refreshCalls[0].ids, ['1']);
    assert.equal(refreshCalls[0].signal, signal);
});

test('function: empty input makes zero host calls', async () => {
    let listCalls = 0;
    let refreshCalls = 0;
    const source = createFunctionWorkSource({
        fetchByStates: async () => { listCalls += 1; return []; },
        fetchByIds: async () => { refreshCalls += 1; return []; }
    });

    assert.deepEqual(await source.fetchByStates(listArg({ states: [] })), []);
    assert.deepEqual(await source.fetchByIds(refreshArg({ ids: [] })), []);
    assert.equal(listCalls, 0);
    assert.equal(refreshCalls, 0);
});

test('function: a non-empty id list with no string ids resolves [] with zero host calls', async () => {
    let refreshCalls = 0;
    const source = createFunctionWorkSource({
        fetchByStates: async () => [],
        fetchByIds: async () => { refreshCalls += 1; return []; }
    });

    // A JS caller can pass non-strings; the typed signature is not a guard.
    /** @typedef {(arg0: {ids: unknown}) => Promise<ReadonlyArray<unknown>>} LooseFetchByIds */
    const looseFetchByIds = /** @type {LooseFetchByIds} */ (/** @type {unknown} */ (source.fetchByIds));
    assert.deepEqual(await looseFetchByIds({ ids: [42, null] }), []);
    assert.equal(refreshCalls, 0);
});

test('function: a plain host error is wrapped as tracker_request with its cause', async () => {
    const cause = new Error('host secret detail');
    const source = createFunctionWorkSource({
        fetchByStates: async () => { throw cause; },
        fetchByIds: async () => []
    });

    const error = await rejectsAs({ run: () => source.fetchByStates(listArg({ states: ['todo'] })), category: 'tracker_request', source: 'function' });
    assert.equal(error.cause, cause);
    assert.equal(error.message.includes('host secret detail'), false);
});

test('function: a thrown WorkSourceError is preserved identity-wise', async () => {
    const boom = new WorkSourceError({ message: 'rate limited', options: { category: 'tracker_rate_limited', source: 'host' } });
    const source = createFunctionWorkSource({
        fetchByStates: async () => [],
        fetchByIds: async () => { throw boom; }
    });

    await assert.rejects(Promise.resolve(source.fetchByIds(refreshArg({ ids: ['1'] }))), (error) => {
        assert.equal(error, boom);
        return true;
    });
});

test('function: a non-array host result is tracker_response', async () => {
    const source = createFunctionWorkSource({
        fetchByStates: async () => ({ not: 'an array' }),
        fetchByIds: async () => 'nope'
    });

    await rejectsAs({ run: () => source.fetchByStates(listArg({ states: ['todo'] })), category: 'tracker_response', source: 'function' });
    await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: ['1'] })), category: 'tracker_response', source: 'function' });
});

test('function: host results use the list/refresh asymmetry', async () => {
    const emitter = createEmitter();
    const source = createFunctionWorkSource({
        fetchByStates: async () => [rawItem({ id: '1', identifier: 'MER-1' }), { bad: true }],
        fetchByIds: async () => [{ bad: true }],
        eventEmitter: emitter
    });

    const items = await source.fetchByStates(listArg({ states: ['todo'] }));
    assert.deepEqual(items.map((item) => item.identifier), ['MER-1']);
    const skipped = eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED });
    assert.deepEqual(payloadOf(skipped[0]), { source: 'function', index: 1, file: null, reason: 'malformed' });

    await rejectsAs({ run: () => source.fetchByIds(refreshArg({ ids: ['1'] })), category: 'tracker_response', source: 'function' });
});

test('function: duplicate input ids reach the host once', async () => {
    /** @type {Array<Record<string, unknown>>} */
    const calls = [];
    const source = createFunctionWorkSource({
        fetchByStates: async () => [],
        fetchByIds: async (args) => { calls.push(args); return [rawItem()]; }
    });

    const items = await source.fetchByIds(refreshArg({ ids: ['1', '1'] }));
    assert.deepEqual(calls[0].ids, ['1']);
    assert.equal(items.length, 1);
});

test('function: duplicate returned ids keep the first and report each extra', async () => {
    const emitter = createEmitter();
    const source = createFunctionWorkSource({
        fetchByStates: async () => [],
        fetchByIds: async () => [
            rawItem({ id: '1', identifier: 'MER-1' }),
            rawItem({ id: '1', identifier: 'MER-1-DUP' })
        ],
        eventEmitter: emitter
    });

    const items = await source.fetchByIds(refreshArg({ ids: ['1'] }));
    assert.deepEqual(items.map((item) => item.identifier), ['MER-1']);
    assert.deepEqual(eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED }).map(payloadOf), [
        { source: 'function', index: 1, file: null, reason: 'duplicate_id' }
    ]);
});

test('function: a host result is passed through even when its state disagrees (AC5 re-checks)', async () => {
    const source = createFunctionWorkSource({
        fetchByStates: async () => [rawItem({ id: '1', identifier: 'MER-1', state: 'Done' })],
        fetchByIds: async () => []
    });

    const items = await source.fetchByStates(listArg({ states: ['todo'] }));
    assert.equal(items.length, 1);
    assert.equal(items[0].state, 'Done');
});

test('function: an already-aborted signal rejects with AbortedError and makes zero host calls', async () => {
    let calls = 0;
    const source = createFunctionWorkSource({
        fetchByStates: async () => { calls += 1; return [rawItem()]; },
        fetchByIds: async () => { calls += 1; return [rawItem()]; }
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(source.fetchByStates({ states: ['Todo'], signal: controller.signal }), isAbortedError);
    await assert.rejects(source.fetchByIds({ ids: ['1'], signal: controller.signal }), isAbortedError);
    assert.equal(calls, 0);
});

test('function: an AbortedError thrown by the host passes through unchanged', async () => {
    const boom = new AbortedError({ message: 'host cancelled the read' });
    const source = createFunctionWorkSource({
        fetchByStates: async () => { throw boom; },
        fetchByIds: async () => []
    });

    await assert.rejects(source.fetchByStates(listArg({ states: ['todo'] })), (error) => {
        assert.equal(error, boom);
        assert.equal(error instanceof WorkSourceError, false);
        return true;
    });
});

// ---------------------------------------------------------------------------
// Todo store work source
// ---------------------------------------------------------------------------

/**
 * A `TodoComponent`-shaped shared store.
 * @param {Array<Record<string, unknown>>} todos -
 * @returns {Map<unknown, Record<string, unknown>>}
 */
function todoStore(todos) {
    return new Map(todos.map((todo) => [todo.id, todo]));
}

test('todos: an out-of-state record does not shadow a later in-state record with the same id', () => {
    const emitter = createEmitter();
    const source = createTodoWorkSource({
        store: todoStore([
            { id: '1', title: 'Done', status: 'completed' },
            { id: '1', title: 'Live', status: 'pending' }
        ]),
        eventEmitter: emitter
    });

    const items = source.fetchByStates(listArg({ states: ['pending'] }));
    assert.deepEqual(items.map((item) => item.title), ['Live']);
    assert.ok(Object.isFrozen(items[0]));
    // The completed record was never part of the result set, so it is not a duplicate.
    assert.equal(eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED }).length, 0);
});

test('todos: empty states or ids return [] with no normalization work', () => {
    const emitter = createEmitter();
    const source = createTodoWorkSource({
        store: todoStore([{ id: 1, title: /** @type {any} */ (undefined), status: 'pending' }]),
        eventEmitter: emitter
    });

    assert.deepEqual(source.fetchByStates(listArg({ states: [] })), []);
    assert.deepEqual(source.fetchByIds(refreshArg({ ids: [] })), []);
    assert.equal(emitter.events.length, 0);
});

test('todos: a refresh treats ids as a set, freezes the item, and reports each extra duplicate', () => {
    const emitter = createEmitter();
    const source = createTodoWorkSource({
        store: todoStore([
            { id: '1', title: 'First', status: 'pending' },
            { id: ' 1 ', title: 'Second', status: 'pending' }
        ]),
        eventEmitter: emitter
    });

    const items = source.fetchByIds(refreshArg({ ids: ['1', '1', ' 1 '] }));
    assert.equal(items.length, 1, 'duplicate request ids collapse before the store read');
    assert.ok(Object.isFrozen(items[0]));
    assert.deepEqual(eventsNamed({ emitter, name: EVENTS.WORK_ITEM.SKIPPED }).map(payloadOf), [
        { source: 'todos', index: 1, file: null, reason: 'duplicate_id' }
    ]);
});

test('todos: an abort raised between refresh rows stops the read', () => {
    const controller = new AbortController();
    const base = todoStore([
        { id: 1, title: 'One', status: 'pending' },
        { id: 2, title: 'Two', status: 'pending' }
    ]);
    let served = 0;
    const store = {
        get size() { return base.size; },
        values() {
            const iterator = base.values();
            return {
                [Symbol.iterator]() { return this; },
                next() {
                    const step = iterator.next();
                    served += 1;
                    // Cancel after the first row is handed out; the next
                    // iteration's check is the only place the abort can surface.
                    if (served === 2) controller.abort();
                    return step;
                }
            };
        }
    };
    const source = createTodoWorkSource({ store });

    assert.throws(
        () => source.fetchByIds({ ids: ['1', '2'], signal: controller.signal }),
        isAbortedError
    );
});

// ---------------------------------------------------------------------------
// Shared contract
// ---------------------------------------------------------------------------

test('WORK_SOURCE_CATEGORIES is frozen and is exactly the eight Symphony categories', () => {
    assert.ok(Object.isFrozen(WORK_SOURCE_CATEGORIES));
    assert.deepEqual([...WORK_SOURCE_CATEGORIES], EXPECTED_CATEGORIES);
    for (const category of WORK_SOURCE_CATEGORIES) {
        const error = new WorkSourceError({ message: 'typed', options: { category } });
        assert.equal(error.category, category);
    }
});

test('WORK_SOURCE_CATEGORIES has one owner: every import path yields the same frozen array', () => {
    const fromConstants = /** @type {ReadonlyArray<string>} */ (constantsBarrel.WORK_SOURCE_CATEGORIES);
    assert.equal(fromConstants, WORK_SOURCE_CATEGORIES, 'the scheduler path re-exports the constants array');
    assert.equal(schedulerBarrel.WORK_SOURCE_CATEGORIES, fromConstants);
    assert.ok(Object.isFrozen(fromConstants));
    assert.deepEqual([...fromConstants], EXPECTED_CATEGORIES, 'the strings match the documented typedef list');
});

test('every adapter emits a skipped payload with exactly the four documented keys', async () => {
    /** @type {Array<{emitter: CapturingEmitter, skipped: {event: string, [key: string]: unknown}}>} */
    const observed = [];

    const memoryEmitter = createEmitter();
    const memory = createMemoryWorkSource({ items: [{ bad: true }], eventEmitter: memoryEmitter });
    memory.fetchByStates(listArg({ states: ['todo'] }));
    observed.push({ emitter: memoryEmitter, skipped: eventsNamed({ emitter: memoryEmitter, name: EVENTS.WORK_ITEM.SKIPPED })[0] });

    const todoEmitter = createEmitter();
    const todos = createTodoWorkSource({ store: todoStore([{ id: 1, status: 'pending' }]), eventEmitter: todoEmitter });
    todos.fetchByStates(listArg({ states: ['pending'] }));
    observed.push({ emitter: todoEmitter, skipped: eventsNamed({ emitter: todoEmitter, name: EVENTS.WORK_ITEM.SKIPPED })[0] });

    await withTempDir({ fn: async ({ dir }) => {
        const jsonEmitter = createEmitter();
        await writeFile(join(dir, 'BAD.json'), '{ not json');
        const json = await createJsonFileWorkSource({ dir, eventEmitter: jsonEmitter });
        await json.fetchByStates(listArg({ states: ['todo'] }));
        observed.push({ emitter: jsonEmitter, skipped: eventsNamed({ emitter: jsonEmitter, name: EVENTS.WORK_ITEM.SKIPPED })[0] });

        const functionEmitter = createEmitter();
        const fn = createFunctionWorkSource({
            fetchByStates: async () => [{ bad: true }],
            fetchByIds: async () => [],
            eventEmitter: functionEmitter
        });
        await fn.fetchByStates(listArg({ states: ['todo'] }));
        observed.push({ emitter: functionEmitter, skipped: eventsNamed({ emitter: functionEmitter, name: EVENTS.WORK_ITEM.SKIPPED })[0] });
    } });

    for (const { skipped } of observed) {
        assert.ok(skipped, 'expected a work_item:skipped event');
        assert.deepEqual(Object.keys(payloadOf(skipped)).sort(), ['file', 'index', 'reason', 'source']);
    }
});

test('the scheduler barrel exposes the factories and normalize helpers, not the internals', () => {
    assert.equal(typeof normalizeWorkItem, 'function');
    assert.equal(typeof sortForDispatch, 'function');
    assert.equal(typeof schedulerBarrel.createMemoryWorkSource, 'function');
    assert.equal(typeof schedulerBarrel.createJsonFileWorkSource, 'function');
    assert.equal(typeof schedulerBarrel.createFunctionWorkSource, 'function');
    assert.equal(typeof schedulerBarrel.createTodoWorkSource, 'function');
    assert.equal(typeof schedulerBarrel.createMemoryClaimStore, 'function');
    assert.equal(typeof schedulerBarrel.createFileClaimStore, 'function');
    assert.equal('toEpochMs' in schedulerBarrel, false);
    assert.equal('isActiveState' in schedulerBarrel, false);
    assert.equal('isTerminalState' in schedulerBarrel, false);
    assert.equal('normalizeListRecord' in schedulerBarrel, false);
});
