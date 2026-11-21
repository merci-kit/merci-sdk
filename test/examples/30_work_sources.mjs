// @ts-check
/**
 * Example 30 — Work sources and claims: the board the scheduler reads.
 *
 * The scheduler never invents work. Three read-only adapters turn a board into
 * normalized items, and a claim store guarantees one owner per item. This
 * example proves each adapter's contract and then points a real scheduler at a
 * JSON board so a real model does one dispatched item.
 *
 *   A — normalize and order : a raw record becomes a frozen `WorkItem`, a
 *       malformed required field fails closed, and `sortForDispatch` orders by
 *       priority bucket, then oldest `createdAt`, then identifier.
 *   B — memory              : an array captured by reference; the state filter
 *       applies, a malformed row is skipped on the list path and throws on the
 *       refresh path.
 *   C — JSON file board     : one file per item, the stem is the id, an
 *       id/name mismatch is refused, a deleted file refreshes as missing.
 *   D — host function       : the escape hatch for a real tracker; an empty
 *       query never calls the host, a host throw becomes a `WorkSourceError`
 *       with the host's category intact.
 *   E — claims              : one winner for a memory claim, a second process
 *       refused by the file store, and a stale foreign claim reclaimed.
 *   F — live board          : a JSON item drives a real `WorkScheduler` tick
 *       and a real agentic engine run; the model returns the forced marker.
 *
 * Public API: `normalizeWorkItem`, `sortForDispatch`, the three work sources,
 * the two claim stores, `WorkScheduler`, `createEngineRunner`, `EVENTS`, `log`.
 *
 * Run: `node test/examples/30_work_sources.mjs` (live) · `node test/examples/30_work_sources.mjs --offline` (deterministic)
 * Needs: `BACKEND` + provider credentials in `secret.env` for the live board;
 *        `--offline` needs none.
 *
 * @version 0.12.0
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENTS, WorkSourceError, initializeClient, loadCredentials, log } from 'merci-sdk';
import {
    WORK_SOURCE_CATEGORIES, WorkScheduler, createEngineRunner, createFileClaimStore,
    createFunctionWorkSource, createJsonFileWorkSource, createMemoryClaimStore,
    createMemoryWorkSource, normalizeWorkItem, sortForDispatch,
} from 'merci-sdk/scheduler';
import { createAudit } from '../../examples/_shared/example-audit.mjs';
import { reportUsage, resolveExample, trackUsage, wireClient } from '../../examples/_shared/example-utils.mjs';

const OFFLINE = process.argv.includes('--offline');
const live = OFFLINE ? null : resolveExample();

const audit = createAudit({
    metaUrl: import.meta.url,
    id: 'audit/30_work_sources',
    offline: OFFLINE,
    provider: live?.provider ?? null,
    models: live ? live.toolModel : null,
    title: 'Example 30 — Work sources and claims',
});

/** The live scheduler, so a thrown assertion still stops it. @type {any} */
let activeScheduler = null;

// ── the manual clock ─────────────────────────────────────────────────────────
// The live tick is explicit; the poll interval is an hour, so a timer can never
// be the reason anything happens.
let now = 1_000_000;
let seq = 0;
/** @type {Map<number, { at: number, fn: () => void }>} */
const timers = new Map();
/** @type {{ now: () => number, setTimeout: (fn: () => void, ms: number) => number, clearTimeout: (id: unknown) => void }} */
const clock = {
    now: () => now,
    setTimeout: (/** @type {[() => void, number]} */ ...args) => {
        const [fn, ms] = args;
        const id = ++seq;
        timers.set(id, { at: now + ms, fn });
        return id;
    },
    clearTimeout: (id) => { timers.delete(Number(id)); },
};

// ── event capture ────────────────────────────────────────────────────────────
/** @type {Array<{ name: string, envelope: Record<string, unknown> }>} */
const events = [];
const emitter = new EventEmitter();
/** @type {{ emit: (...args: [string, Record<string, unknown>]) => void }} */
const eventSink = {
    emit: (...args) => {
        const [name, payload] = args;
        emitter.emit(name, payload);
    },
};
for (const name of [
    EVENTS.SCHEDULER.START, EVENTS.SCHEDULER.STOP, EVENTS.SCHEDULER.TICK,
    EVENTS.WORK_ITEM.SKIPPED, EVENTS.WORK_ITEM.DISPATCHED, EVENTS.WORK_ITEM.COMPLETED,
    EVENTS.WORK_ITEM.PARKED,
]) {
    emitter.on(name, (/** @type {Record<string, unknown>} */ envelope) => { events.push({ name, envelope }); });
}
/** @type {(name: string) => number} */
const countOf = (name) => events.filter((entry) => entry.name === name).length;

/** @param {Partial<{ id: string, identifier: string, state: string, priority: number|null, createdAt: number|null }>} [arg0] */
const rawItem = ({ id = 'id-1', identifier = 'MER-1', state = 'Todo', priority = null, createdAt = null } = {}) => ({
    id,
    identifier,
    title: `Work ${identifier}`,
    state,
    dispatchable: true,
    priority,
    createdAt,
});

/** @param {{promise: Promise<unknown>, ms: number}} arg0 @returns {Promise<'done'|'timeout'>} */
const withTimeout = ({ promise, ms }) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(() => {
        clearTimeout(timer);
        resolve('done');
    });
});

async function main() {
    /** @type {string[]} */
    const temporaryDirs = [];
    const tempDir = (/** @type {string} */ prefix) => {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        temporaryDirs.push(dir);
        return dir;
    };

    /** @type {Awaited<ReturnType<typeof initializeClient>>['client']|null} */
    let client = null;
    /** @type {ReturnType<typeof trackUsage>|null} */
    let usage = null;
    let apiCalls = 0;
    /** @type {string|null} */
    let liveSummary = null;

    try {
        // ── A: normalize and order ───────────────────────────────────────────
        audit.scenario({
            id: 'A', title: 'normalize and order',
            goal: 'a raw record becomes the frozen record the scheduler dispatches on, and ordering is total and deterministic',
            expect: 'the record is frozen with lane "default" · a numeric identifier is refused as malformed · priority 1 sorts before 3, before an absent priority · oldest createdAt wins a bucket · identifier breaks the remaining tie',
            fails: [
                { code: 'not-frozen', symptom: 'Object.isFrozen(item) is false', hint: 'the record, its arrays and every blockedBy entry are frozen' },
                { code: 'coerced', symptom: 'a numeric identifier was accepted', hint: 'required fields are strict: a wrong type fails closed, never coerces' },
                { code: 'unstable-order', symptom: 'the sorted identifiers differ from the expected order', hint: 'priority bucket → createdAt (null last) → identifier → original index' },
            ],
            input: { source: 'example-board', priority: [1, 3, null] },
        });

        const normalized = normalizeWorkItem({ raw: rawItem({ identifier: 'MER-300', priority: 2 }), source: 'example-board' });
        const malformed = await audit.probe({ fn: () => normalizeWorkItem({ raw: { ...rawItem(), identifier: 42 }, source: 'example-board' }) });
        const ordered = sortForDispatch({
            items: [
                normalizeWorkItem({ raw: rawItem({ identifier: 'MER-303', priority: null, createdAt: 1 }), source: 'example-board' }),
                normalizeWorkItem({ raw: rawItem({ identifier: 'MER-302', priority: 3, createdAt: 2 }), source: 'example-board' }),
                normalizeWorkItem({ raw: rawItem({ identifier: 'MER-301', priority: 1, createdAt: 3 }), source: 'example-board' }),
                normalizeWorkItem({ raw: rawItem({ identifier: 'MER-304', priority: 1, createdAt: 2 }), source: 'example-board' }),
            ],
        });
        audit.observe({ name: 'normalized', value: { identifier: normalized.identifier, lane: normalized.lane, labels: normalized.labels, frozen: Object.isFrozen(normalized) } });
        audit.observe({ name: 'ordered', value: ordered.map((item) => `${item.identifier}:p${String(item.priority)}`).join(' → ') });
        audit.check({
            name: 'the record is frozen and carries the defaults',
            ok: Object.isFrozen(normalized) && normalized.lane === 'default'
                && normalized.labels.length === 0 && normalized.identifier === 'MER-300',
            detail: {
                expected: 'frozen · lane default · labels [] · identifier MER-300',
                observed: `frozen ${Object.isFrozen(normalized)} · lane ${normalized.lane} · labels ${normalized.labels.length} · identifier ${normalized.identifier}`,
            },
        });
        audit.checkError({ name: 'a numeric identifier is refused, not coerced', err: malformed.error, expect: { name: 'WorkSourceError' } });
        audit.check({
            name: 'sortForDispatch orders by priority, then oldest createdAt',
            ok: ordered.map((item) => item.identifier).join(',') === 'MER-304,MER-301,MER-302,MER-303',
            detail: {
                expected: 'MER-304,MER-301,MER-302,MER-303',
                observed: ordered.map((item) => item.identifier).join(','),
            },
        });
        audit.end();

        // ── B: memory source ─────────────────────────────────────────────────
        audit.scenario({
            id: 'B', title: 'the memory source',
            goal: 'an array captured by reference is the board; the state filter applies and a broken row is skipped on list but fails a refresh',
            expect: 'list(Todo) returns two items · list(Done) returns one · a malformed row is skipped with work_item:skipped · refresh of the malformed id throws WorkSourceError · refresh of a missing id returns []',
            fails: [
                { code: 'no-filter', symptom: 'a Done item was returned for states [Todo]', hint: 'the memory adapter filters every record against the requested states' },
                { code: 'list-threw', symptom: 'the list path threw on a malformed row', hint: 'the list path skips and reports; only the refresh path fails' },
                { code: 'refresh-quiet', symptom: 'the refresh returned [] for a present malformed row', hint: 'the caller asked for that exact id, so a broken row is an error' },
            ],
            input: { items: ['MER-310 Todo', 'MER-311 Todo', 'MER-312 Done', 'malformed'] },
        });

        const memoryItems = [
            rawItem({ id: 'id-310', identifier: 'MER-310', state: 'Todo', priority: 1 }),
            rawItem({ id: 'id-311', identifier: 'MER-311', state: 'Todo', priority: 2 }),
            rawItem({ id: 'id-312', identifier: 'MER-312', state: 'Done' }),
            { id: 'id-31x', identifier: 'MER-31X', title: 'broken', state: 'Todo', dispatchable: 'yes' },
        ];
        const memory = createMemoryWorkSource({ items: memoryItems, eventEmitter: eventSink });
        const todo = await memory.fetchByStates({ states: ['Todo'] });
        const done = await memory.fetchByStates({ states: ['Done'] });
        const skipped = events.filter((entry) => entry.name === EVENTS.WORK_ITEM.SKIPPED);
        const missing = await memory.fetchByIds({ ids: ['MER-999'] });
        const broken = await audit.probe({ fn: () => memory.fetchByIds({ ids: ['id-31x'] }) });
        audit.observe({ name: 'todo ids', value: todo.map((item) => item.identifier).join(',') });
        audit.observe({ name: 'skipped records', value: skipped.map((entry) => entry.envelope.reason).join(',') });
        audit.check({
            name: 'the state filter returns only the matching items',
            ok: todo.map((item) => item.identifier).join(',') === 'MER-310,MER-311' && done.map((item) => item.identifier).join(',') === 'MER-312',
            detail: {
                expected: 'Todo: MER-310,MER-311 · Done: MER-312',
                observed: `Todo: ${todo.map((item) => item.identifier).join(',')} · Done: ${done.map((item) => item.identifier).join(',')}`,
            },
        });
        audit.check({
            name: 'the malformed row is skipped on the list path and reported',
            // Every list call enumerates the board, so the broken row is reported
            // once per requested state — the point is that it never stops a scan.
            ok: skipped.length >= 1 && skipped.every((entry) => entry.envelope.reason === 'malformed')
                && skipped.every((entry) => entry.envelope.source === 'memory'),
            detail: {
                expected: 'work_item:skipped with reason malformed and source memory',
                observed: `${skipped.length} skipped · reasons ${skipped.map((entry) => String(entry.envelope.reason)).join(',')} · sources ${skipped.map((entry) => String(entry.envelope.source)).join(',')}`,
            },
        });
        audit.check({ name: 'refresh of a missing id returns an empty list', ok: missing.length === 0, detail: { expected: '[]', observed: `${missing.length} items` } });
        audit.checkError({ name: 'refresh of the malformed id throws a typed error', err: broken.error, expect: { name: 'WorkSourceError' } });
        audit.end();

        // ── C: the JSON file board ───────────────────────────────────────────
        audit.scenario({
            id: 'C', title: 'the JSON file board',
            goal: 'one file per item, the stem is the id: a mismatched file is refused, a deleted file refreshes as missing',
            expect: 'list(Todo) returns MER-320 and MER-321 · MER-321.json declaring MER-999 is skipped as id_filename_mismatch · refreshing a deleted file returns [] · refreshing the mismatched file throws',
            fails: [
                { code: 'name-drift', symptom: 'the mismatched record was returned', hint: 'the file stem is the only key, so an id that differs from it is malformed' },
                { code: 'missing-threw', symptom: 'a deleted file made the refresh throw', hint: 'a missing requested file is exactly "no longer visible" — an empty result' },
                { code: 'no-filter', symptom: 'a Done file was returned for states [Todo]', hint: 'the JSON adapter filters locally after reading every record' },
            ],
            input: { dir: 'a temporary directory with three *.json files' },
        });

        const boardDir = tempDir('merci-board-');
        writeFileSync(join(boardDir, 'MER-320.json'), JSON.stringify(rawItem({ id: 'MER-320', identifier: 'MER-320', state: 'Todo', priority: 1 })));
        writeFileSync(join(boardDir, 'MER-321.json'), JSON.stringify({ ...rawItem({ identifier: 'MER-321', state: 'Todo' }), id: 'MER-999' }));
        writeFileSync(join(boardDir, 'MER-322.json'), JSON.stringify(rawItem({ id: 'MER-322', identifier: 'MER-322', state: 'Done' })));
        const board = await createJsonFileWorkSource({ dir: boardDir, eventEmitter: eventSink });
        const boardTodo = await board.fetchByStates({ states: ['Todo'] });
        const mismatchSkip = events.filter((entry) => entry.name === EVENTS.WORK_ITEM.SKIPPED).at(-1);
        const deleted = await board.fetchByIds({ ids: ['MER-320'] });
        rmSync(join(boardDir, 'MER-320.json'));
        const gone = await board.fetchByIds({ ids: ['MER-320'] });
        const mismatchRefresh = await audit.probe({ fn: () => board.fetchByIds({ ids: ['MER-321'] }) });
        audit.observe({ name: 'board list', value: boardTodo.map((item) => item.identifier).join(',') });
        audit.check({
            name: 'the list returns the matching files and refuses the name mismatch',
            ok: boardTodo.map((item) => item.identifier).join(',') === 'MER-320'
                && mismatchSkip?.envelope.reason === 'id_filename_mismatch',
            detail: {
                expected: 'list: MER-320 · skipped: id_filename_mismatch',
                observed: `list: ${boardTodo.map((item) => item.identifier).join(',')} · skipped: ${String(mismatchSkip?.envelope.reason)}`,
            },
        });
        audit.check({ name: 'a present file refreshes, a deleted file refreshes as missing', ok: deleted.length === 1 && gone.length === 0, detail: { expected: 'present 1 · deleted 0', observed: `present ${deleted.length} · deleted ${gone.length}` } });
        audit.checkError({ name: 'a present mismatched file fails the refresh', err: mismatchRefresh.error, expect: { name: 'WorkSourceError' } });
        audit.end();

        // ── D: the host function ─────────────────────────────────────────────
        audit.scenario({
            id: 'D', title: 'the host function source',
            goal: 'a real tracker plugs in two functions; the adapter owns the contract and wraps failures',
            expect: 'an empty state list never calls the host · the host receives { states } and its records are normalized · a plain host throw becomes WorkSourceError category tracker_request · a WorkSourceError keeps its own category',
            fails: [
                { code: 'called-empty', symptom: 'the host was called with an empty state list', hint: 'an empty query returns [] without calling the host' },
                { code: 'category-lost', symptom: 'the host category was replaced', hint: 'a WorkSourceError passes through unchanged; only a plain error is wrapped as tracker_request' },
                { code: 'message-leak', symptom: 'the wrapper message quotes the host error text', hint: 'the adapter never copies a host error message, which may quote a payload' },
            ],
            input: { fetchByStates: 'a host function', fetchByIds: 'a host function' },
        });

        /** @type {Array<{ states?: string[], ids?: string[] }>} */
        const hostCalls = [];
        const host = createFunctionWorkSource({
            fetchByStates: async (/** @type {{states?: string[], ids?: string[], signal?: AbortSignal}} */ { states }) => {
                hostCalls.push({ states: states ?? [] });
                return [rawItem({ id: 'id-330', identifier: 'MER-330', state: 'Todo' })];
            },
            fetchByIds: async () => [],
            eventEmitter: eventSink,
        });
        const empty = await host.fetchByStates({ states: [] });
        const hosted = await host.fetchByStates({ states: ['Todo'] });
        const hostError = await audit.probe({
            fn: () => createFunctionWorkSource({
                fetchByStates: async () => { throw new Error('the tracker said no'); },
                fetchByIds: async () => [],
            }).fetchByStates({ states: ['Todo'] }),
        });
        const typedError = await audit.probe({
            fn: () => createFunctionWorkSource({
                fetchByStates: async () => { throw new WorkSourceError({ message: 'rate limited', options: { category: 'tracker_rate_limited', source: 'host' } }); },
                fetchByIds: async () => [],
            }).fetchByStates({ states: ['Todo'] }),
        });
        audit.observe({ name: 'host calls', value: hostCalls });
        audit.check({
            name: 'an empty query short-circuits and a real query is normalized',
            ok: empty.length === 0 && hostCalls.length === 1
                && hostCalls[0]?.states?.join(',') === 'Todo' && hosted[0]?.identifier === 'MER-330',
            detail: {
                expected: '1 host call with states [Todo] · MER-330',
                observed: `${hostCalls.length} host call(s) · ${hosted.map((item) => item.identifier).join(',')}`,
            },
        });
        audit.check({
            name: 'a plain host throw becomes tracker_request without quoting it',
            ok: hostError.error instanceof WorkSourceError
                && hostError.error.category === 'tracker_request'
                && !String(hostError.error.message).includes('the tracker said no'),
            detail: {
                expected: 'WorkSourceError · category tracker_request · message does not quote the host text',
                observed: `${hostError.error?.name} · ${String(hostError.error?.category)} · ${String(hostError.error?.message)}`,
            },
        });
        audit.check({
            name: 'a typed host error keeps its own category',
            ok: typedError.error instanceof WorkSourceError && typedError.error.category === 'tracker_rate_limited'
                && /** @type {ReadonlyArray<string>} */ (WORK_SOURCE_CATEGORIES).includes('tracker_rate_limited'),
            detail: {
                expected: 'category tracker_rate_limited (a documented category)',
                observed: `${String(typedError.error?.category)} · documented ${/** @type {ReadonlyArray<string>} */ (WORK_SOURCE_CATEGORIES).includes('tracker_rate_limited')}`,
            },
        });
        audit.end();

        // ── E: claims ───────────────────────────────────────────────────────
        audit.scenario({
            id: 'E', title: 'claims: one owner per item',
            goal: 'a claim store guarantees one owner, and the file store is a second-process guard on one machine',
            expect: 'the memory store grants one acquire and refuses the second · release frees it · two file-store instances cannot both acquire · a stale foreign claim is reclaimed',
            fails: [
                { code: 'double-win', symptom: 'two owners acquired the same item', hint: 'acquire is O_EXCL for the file store and a Map set for memory' },
                { code: 'no-release', symptom: 'release did not free the claim', hint: 'release requires the same owner token' },
                { code: 'no-reclaim', symptom: 'a stale foreign claim was not reclaimed', hint: 'a foreign host past staleMs is reclaimable; a live same-host pid never is' },
            ],
            input: { claim: 'MER-340', owners: ['owner-a', 'owner-b'] },
        });

        const memoryClaims = createMemoryClaimStore();
        const first = await memoryClaims.acquire({ workItemId: 'MER-340', owner: 'owner-a' });
        const second = await memoryClaims.acquire({ workItemId: 'MER-340', owner: 'owner-b' });
        const released = await memoryClaims.release({ workItemId: 'MER-340', owner: 'owner-a' });
        const afterRelease = await memoryClaims.isClaimed({ workItemId: 'MER-340' });

        const claimsDir = tempDir('merci-claims-');
        const storeA = createFileClaimStore({ dir: claimsDir, hostId: 'host-a', now: () => 1_000 });
        const storeB = createFileClaimStore({ dir: claimsDir, hostId: 'host-b', now: () => 1_200 });
        const fileFirst = await storeA.acquire({ workItemId: 'MER-341', owner: 'owner-a' });
        const fileSecond = await storeB.acquire({ workItemId: 'MER-341', owner: 'owner-b' });
        const staleB = createFileClaimStore({ dir: claimsDir, hostId: 'host-b', staleMs: 1_000, now: () => 9_000 });
        const reclaimed = await staleB.acquire({ workItemId: 'MER-341', owner: 'owner-b' });

        audit.observe({ name: 'memory claims', value: { first, second, released, afterRelease } });
        audit.observe({ name: 'file claims', value: { fileFirst, fileSecond, reclaimed } });
        audit.check({
            name: 'the memory store grants one owner and release frees it',
            ok: first === true && second === false && released === true && afterRelease === false,
            detail: { expected: 'acquire a true · acquire b false · release true · claimed false', observed: `acquire a ${first} · acquire b ${second} · release ${released} · claimed ${afterRelease}` },
        });
        audit.check({
            name: 'two file-store instances cannot both own one item',
            ok: fileFirst === true && fileSecond === false,
            detail: { expected: 'host-a true · host-b false', observed: `host-a ${fileFirst} · host-b ${fileSecond}` },
        });
        audit.check({
            name: 'a stale foreign claim is reclaimed',
            ok: reclaimed === true,
            detail: { expected: 'true after staleMs', observed: String(reclaimed) },
        });
        audit.end();

        // ── F: a live JSON board drives a real run ───────────────────────────
        audit.scenario({
            id: 'F', title: 'a JSON board drives a real run',
            goal: 'the same adapter the offline checks proved feeds a real scheduler tick and a real agentic engine',
            expect: 'the JSON source lists the item · start() dispatches it once · the engine returns the forced marker · the item completes · stop() drains and clears the timer',
            fails: [
                { code: 'no-dispatch', symptom: 'work_item:dispatched never fired', hint: 'the board item must be Todo + dispatchable and the source must list it' },
                { code: 'no-marker', symptom: 'the summary does not contain the forced marker', hint: 'the prompt forces an exact token; a free answer is not proof' },
                { code: 'timer-leak', symptom: 'stop() left the poll timer armed', hint: 'stop() clears the timer' },
            ],
            input: { board: 'MER-350.json', concurrency: { global: 1 }, continuation: { max: 0 } },
        });

        if (live !== null) {
            const initialized = await initializeClient({
                provider: live.provider,
                options: loadCredentials({ provider: live.provider }),
            });
            client = initialized.client;
            wireClient({ client });
            usage = trackUsage({ client });
            client.on('api_request', () => { apiCalls += 1; });
        }

        const liveBoardDir = tempDir('merci-live-board-');
        writeFileSync(join(liveBoardDir, 'MER-350.json'), JSON.stringify(rawItem({ id: 'MER-350', identifier: 'MER-350', state: 'Todo', priority: 1 })));
        const liveSource = await createJsonFileWorkSource({ dir: liveBoardDir, eventEmitter: eventSink });
        const liveItems = await liveSource.fetchByStates({ states: ['Todo'] });

        const engine = createEngineRunner({
            engine: 'agentic',
            client: client ?? offlineClient(),
            model: live?.toolModel ?? 'offline-model',
            prompt: (/** @type {{item: {identifier: string}}} */ { item }) => `Reply with exactly: SOURCE-LIVE-${item.identifier}`,
        });

        const scheduler = new WorkScheduler({
            workSource: liveSource,
            workflow: {
                /** @param {Parameters<ReturnType<typeof createEngineRunner>['run']>[0]} args */
                async run(args) {
                    const result = await engine.run(args);
                    liveSummary = result.summary ?? null;
                    return result;
                },
            },
            claims: createMemoryClaimStore(),
            clock,
            eventEmitter: eventSink,
            activeStates: ['Todo'],
            terminalStates: ['Done'],
            concurrency: { global: 1 },
            continuation: { delayMs: 0, max: 0 },
            stallTimeoutMs: 0,
            pollIntervalMs: 3_600_000,
        });
        activeScheduler = scheduler;

        const completed = /** @type {Promise<void>} */ (new Promise((resolve) => {
            emitter.once(EVENTS.WORK_ITEM.COMPLETED, () => resolve());
        }));
        await scheduler.start();
        const settle = await withTimeout({ promise: completed, ms: 90_000 });
        const snapshot = scheduler.snapshot();
        const counts = await scheduler.stop({ reason: 'example-done' });
        activeScheduler = null;
        const armedTimers = timers.size;

        audit.observe({ name: 'board list', value: liveItems.map((item) => item.identifier).join(',') });
        audit.observe({ name: 'completion', value: { completed: snapshot.completed, dispatches: snapshot.totals.dispatches } });
        audit.check({
            name: 'the JSON adapter listed the board item',
            ok: liveItems.length === 1 && liveItems[0]?.identifier === 'MER-350',
            detail: { expected: 'MER-350', observed: liveItems.map((item) => item.identifier).join(',') || '(none)' },
        });
        audit.check({
            name: 'the tick dispatched it once and the item completed',
            ok: countOf(EVENTS.WORK_ITEM.DISPATCHED) === 1 && countOf(EVENTS.WORK_ITEM.COMPLETED) === 1
                && snapshot.completed.includes('MER-350') && settle === 'done',
            detail: {
                expected: '1 dispatched · 1 completed · completed [] contains MER-350',
                observed: `${countOf(EVENTS.WORK_ITEM.DISPATCHED)} dispatched · ${countOf(EVENTS.WORK_ITEM.COMPLETED)} completed · ${snapshot.completed.join(',')} · settle ${settle}`,
            },
        });
        audit.check({
            name: 'stop drained the scheduler and cleared the timer',
            ok: counts.drained === true && counts.running === 0 && armedTimers === 0,
            detail: { expected: 'drained true · running 0 · 0 armed timers', observed: `${JSON.stringify(counts)} · ${armedTimers} armed` },
        });
        if (live !== null) {
            audit.check({
                name: 'the live model returned the forced marker',
                ok: apiCalls > 0 && liveSummary !== null && String(liveSummary).includes('SOURCE-LIVE-MER-350'),
                detail: {
                    expected: '> 0 api_request · the summary contains SOURCE-LIVE-MER-350',
                    observed: `${apiCalls} api_request · summary ${JSON.stringify(liveSummary)}`,
                },
            });
        }
        audit.end();

        if (live !== null && usage !== null) reportUsage({ provider: live.provider, usage });
        log.success({ m: 'Work sources verified: normalize, order, three adapters, two claim stores, and a live JSON board run.' });
    } finally {
        if (activeScheduler !== null) await activeScheduler.stop({ reason: 'example-cleanup' }).catch(() => {});
        for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * The offline engine: a session that speaks the runner's fluent contract and
 * answers with the forced marker, so the wiring is exercised with no model.
 * @returns {{ session: (model: string) => Record<string, unknown> }}
 */
function offlineClient() {
    return {
        session: (/** @type {string} */ model) => {
            /** @type {Record<string, any>} */
            const session = {
                provider: 'offline',
                model,
                _lastRunUsage: { total_tokens: 5 },
                withSessionStore() { return session; },
                withExecutionJournal() { return session; },
                withTools() { return session; },
                withBudget() { return session; },
                withApproval() { return session; },
                async loadCheckpoint() { return null; },
                async run() { return 'SOURCE-OFFLINE-OK'; },
            };
            return session;
        },
    };
}

// The await matters: without it a stalled round would exit 0 with a truncated log.
try {
    await audit.run(main);
} finally {
    if (activeScheduler !== null) await activeScheduler.stop({ reason: 'example-finally' }).catch(() => {});
}
