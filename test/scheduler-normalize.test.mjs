// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeWorkItem,
    sortForDispatch,
    isActiveState,
    isTerminalState,
    toEpochMs
} from '../lib/agentic/scheduler/normalize.mjs';
import { MerciError, SchedulerError, WorkSourceError } from '../lib/core/errors.mjs';
import { ERROR_CODES } from '../lib/core/constants/limits.mjs';

// Stage 1 of the scheduler slice: work-item normalization, dispatch ordering,
// state predicates, and timestamp parsing. The module is internal; the public
// names come through the scheduler barrel in Stage 2.

/** A minimal valid raw record; each test overrides or removes one field. @type {Record<string, unknown>} */
const BASE = {
    id: 'item-1',
    identifier: 'MER-1',
    title: 'Fix the thing',
    state: 'Todo',
    dispatchable: true
};

/** @param {Record<string, unknown>} overrides */
function rawItem(overrides = {}) {
    return { ...BASE, ...overrides };
}

/** @param {string} field */
function withoutField(field) {
    const raw = rawItem();
    Reflect.deleteProperty(raw, field);
    return raw;
}

/**
 * Assert `normalizeWorkItem` rejects a record as a tracker-response failure.
 * @param {{raw: unknown, source?: string, field: string}} arg0 -
 * @returns {void}
 */
function assertMalformed({ raw, source = 'board', field }) {
    assert.throws(() => normalizeWorkItem({ raw, source }), (err) => {
        assert.ok(err instanceof WorkSourceError, `expected WorkSourceError, got ${err}`);
        assert.equal(err.category, 'tracker_response');
        assert.equal(err.source, source);
        assert.equal(err.code, ERROR_CODES.WORK_SOURCE);
        assert.ok(String(err.message).includes(field), `message names "${field}": ${err.message}`);
        return true;
    });
}

/**
 * Assert that a record which cannot be read fails as a tracker-response
 * `record` error, and that no foreign error text or `cause` is attached.
 * @param {unknown} raw
 * @returns {void}
 */
function assertUnreadableRecord(raw) {
    assert.throws(() => normalizeWorkItem({ raw, source: 'board' }), (err) => {
        assert.ok(err instanceof WorkSourceError, `expected WorkSourceError, got ${err}`);
        assert.equal(err.category, 'tracker_response');
        assert.equal(err.code, ERROR_CODES.WORK_SOURCE);
        assert.equal(err.source, 'board');
        assert.match(err.message, /"record" could not be read/);
        assert.equal(err.cause, undefined);
        assert.equal(/SECRET|revoked|trap/i.test(err.message), false, err.message);
        return true;
    });
}

/**
 * Build a normalized item for sort tests.
 * @param {{identifier?: string, id?: string, priority?: unknown, createdAt?: unknown}} [options]
 * @returns {ReturnType<typeof normalizeWorkItem>}
 */
function sortable({ identifier = 'MER-1', id = 'item-1', priority = null, createdAt = null } = {}) {
    return normalizeWorkItem({ raw: rawItem({ id, identifier, priority, createdAt }) });
}

// --- raw record shape ------------------------------------------------------

test('normalizeWorkItem: raw must be a non-null, non-array object', () => {
    for (const raw of [null, undefined, [], 'MER-1', 3, true]) {
        assertMalformed({ raw, field: 'raw' });
    }
});

test('normalizeWorkItem: required fields reject missing, blank, whitespace, and non-strings', () => {
    for (const field of ['id', 'identifier', 'title', 'state']) {
        assertMalformed({ raw: withoutField(field), field });
        assertMalformed({ raw: rawItem({ [field]: '' }), field });
        assertMalformed({ raw: rawItem({ [field]: '   ' }), field });
        assertMalformed({ raw: rawItem({ [field]: 42 }), field });
        assertMalformed({ raw: rawItem({ [field]: null }), field });
        assertMalformed({ raw: rawItem({ [field]: [] }), field });
        assertMalformed({ raw: rawItem({ [field]: {} }), field });
        assertMalformed({ raw: rawItem({ [field]: new String('x') }), field });
    }
});

test('normalizeWorkItem: required strings are stored trimmed', () => {
    const item = normalizeWorkItem({
        raw: rawItem({ id: '  1  ', identifier: ' MER-1 ', title: '  Title  ', state: ' Todo ' })
    });
    assert.equal(item.id, '1');
    assert.equal(item.identifier, 'MER-1');
    assert.equal(item.title, 'Title');
    assert.equal(item.state, 'Todo');
});

test('normalizeWorkItem: dispatchable must be an explicit boolean, never coerced', () => {
    for (const value of [undefined, 'true', 1, null, 0, 'false']) {
        assertMalformed({ raw: rawItem({ dispatchable: value }), field: 'dispatchable' });
    }
    assertMalformed({ raw: withoutField('dispatchable'), field: 'dispatchable' });
    assert.equal(normalizeWorkItem({ raw: rawItem({ dispatchable: true }) }).dispatchable, true);
    assert.equal(normalizeWorkItem({ raw: rawItem({ dispatchable: false }) }).dispatchable, false);
});

test('normalizeWorkItem: source is preserved on the error', () => {
    assertMalformed({ raw: rawItem({ id: '' }), source: 'json-board', field: 'id' });
});

// --- labels ----------------------------------------------------------------

test('normalizeWorkItem: labels trim, lowercase, drop blanks, dedupe, drop non-strings', () => {
    const item = normalizeWorkItem({ raw: rawItem({ labels: [' Agent ', 'agent', '', 'URGENT', 7] }) });
    assert.deepEqual(item.labels, ['agent', 'urgent']);
    assert.deepEqual(normalizeWorkItem({ raw: rawItem({ labels: 'agent' }) }).labels, []);
    assert.deepEqual(normalizeWorkItem({ raw: rawItem({ labels: null }) }).labels, []);
});

test('normalizeWorkItem: an unreadable labels index fails closed to []', () => {
    const labels = ['agent'];
    Object.defineProperty(labels, 0, {
        configurable: true,
        enumerable: true,
        get() {
            throw new Error('SECRET-LABEL');
        }
    });

    // No foreign error escapes, so its message (prompt text) never surfaces.
    const item = normalizeWorkItem({ raw: rawItem({ labels }) });
    assert.deepEqual(item.labels, []);
    assert.equal(item.id, 'item-1');
});

// --- priority --------------------------------------------------------------

test('normalizeWorkItem: priority keeps integers only, everything else is null', () => {
    assert.equal(normalizeWorkItem({ raw: rawItem({ priority: 2 }) }).priority, 2);
    assert.equal(normalizeWorkItem({ raw: rawItem({ priority: 0 }) }).priority, 0);
    assert.equal(normalizeWorkItem({ raw: rawItem({ priority: -3 }) }).priority, -3);
    for (const value of [3.5, '2', NaN, undefined, null, Infinity]) {
        assert.equal(normalizeWorkItem({ raw: rawItem({ priority: value }) }).priority, null);
    }
});

// --- timestamps ------------------------------------------------------------

test('toEpochMs: Date, epoch, RFC 3339 in; everything else null', () => {
    const date = new Date('2026-01-02T03:04:05Z');
    assert.equal(toEpochMs({ value: date }), date.getTime());
    assert.equal(toEpochMs({ value: date.getTime() }), date.getTime());
    assert.equal(toEpochMs({ value: '2026-01-02T03:04:05Z' }), date.getTime());
    assert.equal(toEpochMs({ value: '2026-01-02t03:04:05z' }), date.getTime());
    assert.equal(
        toEpochMs({ value: '2026-01-02T03:04:05.123+02:00' }),
        Date.parse('2026-01-02T03:04:05.123+02:00')
    );
    for (const value of [
        '2026-01-02',
        '',
        'not-a-date',
        '2026-01-02T03:04Z',
        '2026-13-02T03:04:05Z',
        NaN,
        Infinity,
        null,
        {},
        ['2026-01-02T03:04:05Z'],
        new Date(NaN)
    ]) {
        assert.equal(toEpochMs({ value }), null, `expected null for ${String(value)}`);
    }
});

test('normalizeWorkItem: createdAt/updatedAt go through toEpochMs', () => {
    const date = new Date('2026-01-02T03:04:05Z');
    const item = normalizeWorkItem({
        raw: rawItem({ createdAt: date, updatedAt: '2026-01-02T03:04:05Z' })
    });
    assert.equal(item.createdAt, date.getTime());
    assert.equal(item.updatedAt, date.getTime());
    assert.equal(normalizeWorkItem({ raw: rawItem({ createdAt: '2026-01-02' }) }).createdAt, null);
    assert.equal(normalizeWorkItem({ raw: rawItem({ updatedAt: {} }) }).updatedAt, null);
});

// --- lane ------------------------------------------------------------------

test('normalizeWorkItem: lane defaults to "default" unless a trimmed string', () => {
    assert.equal(normalizeWorkItem({ raw: rawItem({ lane: '  review ' }) }).lane, 'review');
    assert.equal(normalizeWorkItem({ raw: rawItem({ lane: '   ' }) }).lane, 'default');
    assert.equal(normalizeWorkItem({ raw: rawItem({ lane: 7 }) }).lane, 'default');
    assert.equal(normalizeWorkItem({ raw: rawItem() }).lane, 'default');
});

// --- nativeRef / metadata --------------------------------------------------

test('normalizeWorkItem: nativeRef/metadata are detached deep copies', () => {
    const raw = rawItem({
        metadata: { audit: { by: 'a' }, n: 1, ok: true, list: [1, 2] },
        nativeRef: { external: 'x' }
    });
    const item = normalizeWorkItem({ raw });
    assert.deepEqual(item.metadata, { audit: { by: 'a' }, n: 1, ok: true, list: [1, 2] });
    assert.deepEqual(item.nativeRef, { external: 'x' });

    // Mutating the caller's object after normalization cannot touch the record.
    const meta = /** @type {{audit: {by: string}}} */ (raw.metadata);
    meta.audit.by = 'b';
    const copied = /** @type {{audit: {by: string}}} */ (item.metadata);
    assert.equal(copied.audit.by, 'a');
});

test('normalizeWorkItem: a null inside metadata is JSON-safe and round-trips', () => {
    assert.deepEqual(normalizeWorkItem({ raw: rawItem({ metadata: { a: null } }) }).metadata, { a: null });
});

test('normalizeWorkItem: null-prototype plain objects are accepted', () => {
    /** @type {Record<string, unknown>} */
    const nullProto = Object.create(null);
    nullProto.a = 1;
    assert.deepEqual(normalizeWorkItem({ raw: rawItem({ metadata: nullProto }) }).metadata, { a: 1 });
});

test('normalizeWorkItem: non JSON-safe nativeRef/metadata become null without throwing', () => {
    /** @type {Record<string, unknown>} */
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    const cases = [
        { fn: () => {} },
        cyclic,
        { big: 10n },
        { symbol: Symbol('x') },
        { nested: { bad: Infinity } },
        { nested: { bad: NaN } },
        { nested: { bad: undefined } },
        { list: [() => {}] },
        { nested: new Map() },
        new Date(),
        new Map(),
        [1, 2]
    ];
    for (const value of cases) {
        const item = normalizeWorkItem({ raw: rawItem({ metadata: value }) });
        assert.equal(item.metadata, null, `expected null for ${Object.prototype.toString.call(value)}`);
        assert.equal(normalizeWorkItem({ raw: rawItem({ nativeRef: value }) }).nativeRef, null);
    }
    // The record itself stays valid: bad JSON-safety is not a record error.
    assert.equal(normalizeWorkItem({ raw: rawItem({ metadata: { fn: () => {} } }) }).id, 'item-1');
});

test('normalizeWorkItem: a throwing getter is contained and yields null', () => {
    const metadata = {};
    Object.defineProperty(metadata, 'boom', {
        enumerable: true,
        get() {
            throw new Error('getter');
        }
    });
    const item = normalizeWorkItem({ raw: rawItem({ metadata }) });
    assert.equal(item.metadata, null);
});

// --- blockedBy -------------------------------------------------------------

test('normalizeWorkItem: blockedBy keeps object entries with null-able fields', () => {
    const item = normalizeWorkItem({
        raw: rawItem({
            blockedBy: [
                { id: ' 1 ', identifier: 'MER-2', state: ' Done ' },
                { id: 7, identifier: '', state: null },
                'x',
                null,
                [1]
            ]
        })
    });
    assert.deepEqual(item.blockedBy, [
        { id: '1', identifier: 'MER-2', state: 'Done' },
        { id: null, identifier: null, state: null }
    ]);
    assert.deepEqual(normalizeWorkItem({ raw: rawItem({ blockedBy: 'nope' }) }).blockedBy, []);
    assert.deepEqual(normalizeWorkItem({ raw: rawItem({ blockedBy: [] }) }).blockedBy, []);
});

test('normalizeWorkItem: an unreadable blockedBy entry is dropped without failing the record', () => {
    /** @type {Record<string, unknown>} */
    const throwingGetter = {};
    Object.defineProperty(throwingGetter, 'id', {
        configurable: true,
        enumerable: true,
        get() {
            throw new Error('SECRET-BLOCKED');
        }
    });
    const throwingProxy = new Proxy({}, {
        get() {
            throw new Error('SECRET-BLOCKED-PROXY');
        }
    });
    const legitimate = { id: ' 9 ', identifier: 'MER-9', state: ' Done ' };

    const item = normalizeWorkItem({
        raw: rawItem({ blockedBy: [throwingGetter, throwingProxy, legitimate] })
    });

    assert.deepEqual(item.blockedBy, [{ id: '9', identifier: 'MER-9', state: 'Done' }]);
    assert.equal(Object.isFrozen(item.blockedBy[0]), true);
});

test('normalizeWorkItem: an unreadable blockedBy index fails closed to []', () => {
    const blockedBy = [{ id: '1', identifier: 'MER-2', state: 'Done' }];
    Object.defineProperty(blockedBy, 0, {
        configurable: true,
        enumerable: true,
        get() {
            throw new Error('SECRET-BLOCKED');
        }
    });

    // No foreign error escapes, so its message (prompt text) never surfaces.
    const item = normalizeWorkItem({ raw: rawItem({ blockedBy }) });
    assert.deepEqual(item.blockedBy, []);
    assert.equal(item.id, 'item-1');
});

// --- description / url -----------------------------------------------------

test('normalizeWorkItem: description is prose (not trimmed), url is trimmed', () => {
    const item = normalizeWorkItem({ raw: rawItem({ description: '  keep  ', url: '  https://x  ' }) });
    assert.equal(item.description, '  keep  ');
    assert.equal(item.url, 'https://x');
    assert.equal(normalizeWorkItem({ raw: rawItem({ description: 5, url: '' }) }).description, null);
    assert.equal(normalizeWorkItem({ raw: rawItem({ description: 5, url: '  ' }) }).url, null);
});

// --- record shape ----------------------------------------------------------

test('normalizeWorkItem: unknown keys are dropped and the key set is exact', () => {
    const item = normalizeWorkItem({ raw: rawItem({ extra: 'drop me' }) });
    assert.deepEqual(Object.keys(item).sort(), [
        'blockedBy',
        'createdAt',
        'description',
        'dispatchable',
        'id',
        'identifier',
        'labels',
        'lane',
        'metadata',
        'nativeRef',
        'priority',
        'state',
        'title',
        'updatedAt',
        'url'
    ].sort());
    assert.equal(Object.hasOwn(item, 'extra'), false);
});

test('normalizeWorkItem: the record and its arrays are frozen', () => {
    const item = normalizeWorkItem({ raw: rawItem({ labels: ['a'], blockedBy: [{ id: '2' }] }) });
    assert.equal(Object.isFrozen(item), true);
    assert.equal(Object.isFrozen(item.labels), true);
    assert.equal(Object.isFrozen(item.blockedBy), true);
    assert.equal(Object.isFrozen(item.blockedBy[0]), true);
});

test('normalizeWorkItem: metadata is a detached copy, documented as not frozen', () => {
    const item = normalizeWorkItem({ raw: rawItem({ metadata: { a: 1 } }) });
    assert.equal(Object.isFrozen(item.metadata), false);
});

test('normalizeWorkItem: errors name the field and source, never the value', () => {
    const raw = rawItem({ description: 'SECRET-PROMPT-TEXT', dispatchable: 'yes' });
    try {
        normalizeWorkItem({ raw, source: 'board' });
        assert.fail('expected a WorkSourceError');
    } catch (err) {
        assert.ok(err instanceof WorkSourceError);
        assert.match(err.message, /dispatchable/);
        assert.match(err.message, /board/);
        assert.equal(err.message.includes('SECRET-PROMPT-TEXT'), false);
    }

    const titleSecret = rawItem({ title: 'SECRET-TITLE-VALUE', state: '' });
    try {
        normalizeWorkItem({ raw: titleSecret, source: 'board' });
        assert.fail('expected a WorkSourceError');
    } catch (err) {
        assert.ok(err instanceof WorkSourceError);
        assert.match(err.message, /state/);
        assert.equal(err.message.includes('SECRET-TITLE-VALUE'), false);
    }
});

test('normalizeWorkItem: an unreadable record field is malformed without leaking its message', () => {
    // An accessor on the raw record itself.
    const getterRecord = rawItem();
    Object.defineProperty(getterRecord, 'title', {
        configurable: true,
        enumerable: true,
        get() {
            throw new Error('SECRET-TITLE');
        }
    });
    assertUnreadableRecord(getterRecord);

    // A Proxy `get` trap on a field read after the first four.
    const proxyRecord = new Proxy(rawItem(), {
        get(target, key, receiver) {
            if (key === 'metadata') throw new Error('SECRET-META');
            return Reflect.get(target, key, receiver);
        }
    });
    assertUnreadableRecord(proxyRecord);
});

test('normalizeWorkItem: a revoked Proxy as raw is a malformed record', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    assertUnreadableRecord(revoked.proxy);
});

test('normalizeWorkItem: a revoked Proxy as labels or blockedBy is a malformed record', () => {
    const revokedLabels = Proxy.revocable([], {});
    revokedLabels.revoke();
    assertUnreadableRecord(rawItem({ labels: revokedLabels.proxy }));

    const revokedBlockedBy = Proxy.revocable([], {});
    revokedBlockedBy.revoke();
    assertUnreadableRecord(rawItem({ blockedBy: revokedBlockedBy.proxy }));
});

test('normalizeWorkItem: a Proxy createdAt that throws in getPrototypeOf or getTime is malformed', () => {
    // `instanceof Date` asks the proxy for its prototype.
    const throwingPrototype = new Proxy(new Date(), {
        getPrototypeOf() {
            throw new Error('SECRET-TRAP-PROTOTYPE');
        }
    });
    assertUnreadableRecord(rawItem({ createdAt: throwingPrototype }));

    // Past `instanceof`, `getTime()` asks the proxy for the method.
    const throwingGet = new Proxy(new Date(), {
        get() {
            throw new Error('SECRET-TRAP-GET');
        }
    });
    assertUnreadableRecord(rawItem({ createdAt: throwingGet }));
});

test('normalizeWorkItem: a metadata or nativeRef Proxy with a throwing getPrototypeOf trap is malformed', () => {
    // The JSON-safety check asks the value for its prototype, so a Proxy with a
    // throwing `getPrototypeOf` trap escapes `toJsonSafeObject` and is contained
    // only by the top-level record net.
    /** @returns {Record<string, unknown>} */
    const throwingPrototype = () =>
        new Proxy({ a: 1 }, {
            getPrototypeOf() {
                throw new Error('SECRET-TRAP-PROTOTYPE');
            }
        });
    assertUnreadableRecord(rawItem({ metadata: throwingPrototype() }));
    assertUnreadableRecord(rawItem({ nativeRef: throwingPrototype() }));
});

// --- sortForDispatch -------------------------------------------------------

test('sortForDispatch: priority buckets 1..4, then others, oldest first, null last', () => {
    const items = [
        sortable({ identifier: 'N', priority: null }),
        sortable({ identifier: 'F', priority: 5 }),
        sortable({ identifier: 'B', priority: 2 }),
        sortable({ identifier: 'A', priority: 1 }),
        sortable({ identifier: 'C1', priority: 2, createdAt: 1 }),
        sortable({ identifier: 'C2', priority: 2, createdAt: 2 })
    ];
    const sorted = sortForDispatch({ items });
    assert.deepEqual(sorted.map((item) => item.identifier), ['A', 'C1', 'C2', 'B', 'F', 'N']);
});

test('sortForDispatch: priority 0 joins the non-1..4 bucket', () => {
    const items = [sortable({ identifier: 'Z', priority: 0 }), sortable({ identifier: 'A', priority: 1 })];
    assert.deepEqual(sortForDispatch({ items }).map((item) => item.identifier), ['A', 'Z']);
});

test('sortForDispatch: null createdAt sorts last within a bucket', () => {
    const items = [
        sortable({ identifier: 'null-created' }),
        sortable({ identifier: 'old', createdAt: 10 }),
        sortable({ identifier: 'new', createdAt: 20 })
    ];
    assert.deepEqual(
        sortForDispatch({ items }).map((item) => item.identifier),
        ['old', 'new', 'null-created']
    );
});

test('sortForDispatch: identifier breaks ties lexicographically, not by locale', () => {
    const items = [
        sortable({ identifier: 'b', priority: 1 }),
        sortable({ identifier: 'B', priority: 1 }),
        sortable({ identifier: 'a', priority: 1 })
    ];
    // Code-unit order: uppercase B (66) < lowercase a (97) < lowercase b (98).
    assert.deepEqual(sortForDispatch({ items }).map((item) => item.identifier), ['B', 'a', 'b']);
});

test('sortForDispatch: identical keys keep input order (explicit stability)', () => {
    const first = sortable({ identifier: 'same', id: 'first', priority: 1 });
    const second = sortable({ identifier: 'same', id: 'second', priority: 1 });
    assert.deepEqual(sortForDispatch({ items: [first, second] }).map((item) => item.id), ['first', 'second']);
    assert.deepEqual(sortForDispatch({ items: [second, first] }).map((item) => item.id), ['second', 'first']);
});

test('sortForDispatch: returns a new array and does not mutate the input', () => {
    const items = [sortable({ identifier: 'b', priority: 2 }), sortable({ identifier: 'a', priority: 1 })];
    const before = items.map((item) => item.identifier);
    const sorted = sortForDispatch({ items });
    assert.notEqual(sorted, items);
    assert.deepEqual(items.map((item) => item.identifier), before);
});

test('sortForDispatch: negative and huge integers share the 5 bucket', () => {
    const items = [
        sortable({ identifier: 'neg', priority: -3 }),
        sortable({ identifier: 'huge', priority: Number.MAX_SAFE_INTEGER }),
        sortable({ identifier: 'p1', priority: 1 })
    ];
    assert.deepEqual(sortForDispatch({ items }).map((item) => item.identifier), ['p1', 'huge', 'neg']);
});

test('sortForDispatch: a missing createdAt on the left sorts after one that has it', () => {
    const items = [
        sortable({ identifier: 'a', priority: 2 }),
        sortable({ identifier: 'b', priority: 2, createdAt: 5 })
    ];
    assert.deepEqual(sortForDispatch({ items }).map((item) => item.identifier), ['b', 'a']);
});

test('sortForDispatch: a null createdAt compared as the left argument still sorts oldest first', () => {
    // The null-created item sits after a dated one in input order, so the
    // comparison sees it as `a` (left) against a `b` that has a timestamp.
    const items = [
        sortable({ identifier: 'dated', priority: 2, createdAt: 10 }),
        sortable({ identifier: 'null-created', priority: 2 }),
        sortable({ identifier: 'newer', priority: 2, createdAt: 20 })
    ];
    assert.deepEqual(
        sortForDispatch({ items }).map((item) => item.identifier),
        ['dated', 'newer', 'null-created']
    );
});

test('sortForDispatch: sorting twice is idempotent', () => {
    const items = [
        sortable({ identifier: 'b', priority: 2 }),
        sortable({ identifier: 'a', priority: 1 }),
        sortable({ identifier: 'c', priority: 5, createdAt: 7 })
    ];
    const once = sortForDispatch({ items }).map((item) => item.identifier);
    assert.deepEqual(sortForDispatch({ items: sortForDispatch({ items }) }).map((item) => item.identifier), once);
});

test('sortForDispatch: empty and single-item inputs return a new array', () => {
    assert.deepEqual(sortForDispatch({ items: [] }), []);
    const only = sortable({ identifier: 'only' });
    const input = [only];
    const sorted = sortForDispatch({ items: input });
    assert.deepEqual(sorted, [only]);
    assert.notEqual(sorted, input);
});

// --- state predicates ------------------------------------------------------

/**
 * A state predicate seen with an `unknown` state list, so the deliberately
 * invalid inputs below type-check without an `any` cast or a suppression
 * directive.
 * @typedef {(arg0: {state: unknown, states: unknown}) => boolean} LooseStatePredicate
 */

/** @type {{isActive: LooseStatePredicate, isTerminal: LooseStatePredicate}} */
const loosePredicates = /** @type {{isActive: LooseStatePredicate, isTerminal: LooseStatePredicate}} */ ({
    isActive: isActiveState,
    isTerminal: isTerminalState
});

test('isActiveState: trim + lowercase compare; non-string state and bad states are false', () => {
    assert.equal(isActiveState({ state: ' Todo ', states: ['todo', 'in progress'] }), true);
    assert.equal(isActiveState({ state: ' TODO ', states: ['todo'] }), true);
    assert.equal(isActiveState({ state: 'todo', states: [' done '] }), false);
    assert.equal(loosePredicates.isActive({ state: 5, states: ['todo'] }), false);
    assert.equal(loosePredicates.isActive({ state: null, states: ['todo'] }), false);
    assert.equal(isActiveState({ state: 'todo', states: [] }), false);
    assert.equal(loosePredicates.isActive({ state: 'todo', states: 'todo' }), false);
    assert.equal(loosePredicates.isActive({ state: 'todo', states: null }), false);
    assert.equal(loosePredicates.isActive({ state: 'todo', states: new Map([['todo', true]]) }), false);
});

test('isActiveState: accepts a precomputed Set as-is', () => {
    assert.equal(isActiveState({ state: ' Todo ', states: new Set(['todo']) }), true);
    assert.equal(isActiveState({ state: 'todo', states: new Set([' done ']) }), false);
    // Used verbatim, never rebuilt: a mutant that re-trims or lowercases the
    // set would make these match.
    assert.equal(isActiveState({ state: 'todo', states: new Set(['TODO']) }), false);
    assert.equal(isActiveState({ state: 'TODO', states: new Set(['TODO']) }), false);
    assert.equal(isActiveState({ state: 'todo', states: new Set([' todo ']) }), false);
    assert.equal(isActiveState({ state: ' Todo ', states: new Set([' todo ']) }), false);
});

test('isTerminalState: trim + lowercase compare; non-string state and bad states are false', () => {
    assert.equal(isTerminalState({ state: ' DONE ', states: ['done'] }), true);
    assert.equal(isTerminalState({ state: 'Canceled', states: ['canceled', 'done'] }), true);
    assert.equal(isTerminalState({ state: 'todo', states: ['done'] }), false);
    assert.equal(loosePredicates.isTerminal({ state: {}, states: ['done'] }), false);
    assert.equal(loosePredicates.isTerminal({ state: 'done', states: null }), false);
    assert.equal(isTerminalState({ state: ' DONE ', states: new Set(['done']) }), true);
    // Used verbatim, never rebuilt: a mutant that re-trims or lowercases the
    // set would make these match.
    assert.equal(isTerminalState({ state: 'done', states: new Set(['DONE']) }), false);
    assert.equal(isTerminalState({ state: 'DONE', states: new Set(['DONE']) }), false);
    assert.equal(isTerminalState({ state: 'done', states: new Set([' done ']) }), false);
    assert.equal(isTerminalState({ state: ' DONE ', states: new Set([' done ']) }), false);
});


// ─── typed errors ───────────────────────────────────────────────────────────

test('SchedulerError: carries reason and the base contract', () => {
    const cause = new Error('root');
    const context = { attempt: 2 };
    const err = new SchedulerError({ message: 'not started', options: { reason: 'not_started', cause, context } });
    assert.ok(err instanceof SchedulerError);
    assert.ok(err instanceof MerciError);
    assert.equal(err.name, 'SchedulerError');
    assert.equal(err.reason, 'not_started');
    assert.equal(err.code, ERROR_CODES.SCHEDULER);
    assert.equal(err.cause, cause);
    assert.deepEqual(err.context, context);
    assert.equal(new SchedulerError({ message: 'x', options: { code: 'CUSTOM' } }).code, 'CUSTOM');
    // The hierarchy allows a bare construction; the reason stays honest.
    assert.equal(new SchedulerError({ message: 'bare' }).reason, undefined);
});

test('WorkSourceError: carries source, hints, and an honest absence', () => {
    const cause = new Error('root');
    const context = { call: 'fetchByStates' };
    const err = new WorkSourceError({
        message: 'fetch failed',
        options: { source: 'board', category: 'tracker_status', retryable: true, retryAfterMs: 1500, cause, context }
    });
    assert.ok(err instanceof WorkSourceError);
    assert.ok(err instanceof MerciError);
    assert.equal(err.name, 'WorkSourceError');
    assert.equal(err.code, ERROR_CODES.WORK_SOURCE);
    assert.equal(err.source, 'board');
    assert.equal(err.category, 'tracker_status');
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterMs, 1500);
    assert.equal(err.cause, cause);
    assert.deepEqual(err.context, context);
    assert.equal(new WorkSourceError({ message: 'x', options: { code: 'CUSTOM' } }).code, 'CUSTOM');

    const bare = new WorkSourceError({ message: 'bare' });
    assert.equal(bare.source, 'unknown');
    assert.equal(bare.category, undefined, 'no guessed category');
    assert.equal(bare.retryable, false);
    assert.equal(bare.retryAfterMs, undefined, 'absent hint stays absent');
    assert.equal(new WorkSourceError({ message: 'x', options: { retryAfterMs: -1 } }).retryAfterMs, undefined);
    assert.equal(new WorkSourceError({ message: 'x', options: { retryAfterMs: Infinity } }).retryAfterMs, undefined);
});
