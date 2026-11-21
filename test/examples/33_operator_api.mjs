// @ts-check
/**
 * Example 33 — The operator API.
 *
 * A real handler mounted on a `node:http` server bound to `127.0.0.1:0`.
 * Requests use `node:http`'s `request` — never `fetch`. Live, the provider is a
 * real `WorkScheduler` driven by `createEngineRunner`, with the real event ring
 * over the scheduler emitter; offline, a fake snapshot on a fixed clock and
 * synthetic orchestration events keep the audit deterministic.
 *
 *   A — the state route    : `GET /api/v1/state` answers one JSON projection of
 *       the snapshot: counts, the three row lists, totals, the four limits, the
 *       scheduler lifecycle and `rateLimits: null`.
 *   B — the detail + feed  : `GET /api/v1/items/MER-1` answers the item and its
 *       ring history (that identifier only, epoch-ms `at`), an unknown item is
 *       `404 item_not_found`, and the `<base>/<id>` alias answers the same body.
 *   C — the status page    : `GET /` is the same plain text `formatStatus`
 *       renders, and a hostile identifier cannot repaint the terminal.
 *   D — security + errors  : a foreign `Host` is `403 forbidden_host`, a route
 *       miss is `404 not_found`, a non-JSON refresh is `415`, a handler without
 *       a provider is `501 refresh_not_supported`, a JSON refresh is `202`, and
 *       no response body carries the fixture's `SECRET_` text.
 *   L — the live surface   : the same routes over a real scheduler run that
 *       completes its item; `POST /refresh` drives one tick.
 *
 * Public API: `createOperatorHttpHandler`, `createEventRing`, `formatStatus`,
 * `MerciEventEmitter`, `WorkScheduler`, `createMemoryWorkSource`,
 * `createMemoryClaimStore`, `createEngineRunner`, `EVENTS`, `log`.
 *
 * Run: `node test/examples/33_operator_api.mjs` (live) · `node test/examples/33_operator_api.mjs --offline` (deterministic)
 * Needs: `BACKEND` + provider credentials in `secret.env` for the live surface;
 *        `--offline` needs none.
 *
 * @version 0.12.0
 */
import { createServer, request as httpRequest } from 'node:http';
import { EVENTS, MerciEventEmitter, initializeClient, loadCredentials, log } from 'merci-sdk';
import { guardedParse } from 'merci-sdk/json';
import { OPERATOR_API_VERSION, OPERATOR_DEFAULTS, createEventRing, createOperatorHttpHandler, formatStatus } from 'merci-sdk/operator';
import {
    WorkScheduler, createEngineRunner, createMemoryClaimStore, createMemoryWorkSource,
} from 'merci-sdk/scheduler';
import { createAudit } from '../../examples/_shared/example-audit.mjs';
import { reportUsage, resolveExample, trackUsage, wireClient } from '../../examples/_shared/example-utils.mjs';

const OFFLINE = process.argv.includes('--offline');
const live = OFFLINE ? null : resolveExample();

const audit = createAudit({
    metaUrl: import.meta.url,
    id: 'audit/33_operator_api',
    offline: OFFLINE,
    provider: live?.provider ?? null,
    models: live ? live.toolModel : null,
    title: 'Example 33 — The operator API',
});

/** The one clock the whole example reads: a fixed instant, so every ISO string is stable. */
const NOW_MS = Date.UTC(2026, 10, 9, 18, 0, 0);
const NOW_ISO = new Date(NOW_MS).toISOString();

/** Text that lives only in the fixture's prose fields; it must never reach a body. */
const SECRET = 'SECRET_operator_api_do_not_leak';

/**
 * The fake scheduler snapshot: every field the API consumes, and no scheduler
 * import. `description`/`prompt` are deliberately outside the projection.
 */
const SNAPSHOT = {
    started: true,
    stopped: false,
    tickCount: 12,
    lastTickAt: NOW_MS - 30_000,
    lastOutcome: 'ok',
    pollIntervalMs: 30_000,
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Cancelled'],
    claimed: ['MER-1', 'MER-2', 'MER-3'],
    completed: ['MER-8', 'MER-9'],
    running: [{
        workItemId: 'wi-1',
        identifier: 'MER-1',
        url: 'https://tracker.example/MER-1',
        state: 'In Progress',
        lane: 'default',
        attempt: 2,
        startedAt: NOW_MS - 252_000,
        lastProgressAt: NOW_MS - 60_000,
        threadId: 'work:MER-1',
        workspacePath: '/tmp/ws/MER-1',
        description: `${SECRET}_DESCRIPTION`,
        prompt: `${SECRET}_PROMPT`,
    }],
    retrying: [{
        workItemId: 'wi-2',
        identifier: 'MER-2',
        url: 'https://tracker.example/MER-2',
        attempt: 1,
        kind: 'failure',
        dueAtMs: NOW_MS + 30_000,
        delayMs: 30_000,
        errorName: 'TimeoutError',
        errorCode: 'ETIMEDOUT',
        description: `${SECRET}_DESCRIPTION`,
        prompt: `${SECRET}_PROMPT`,
    }],
    parked: [{
        workItemId: 'wi-3',
        identifier: 'MER-3',
        url: null,
        reason: 'attempts_exhausted',
        since: NOW_MS - 3_600_000,
        nextCheckAt: NOW_MS + 600_000,
        attempts: 5,
        continuations: 2,
        description: `${SECRET}_DESCRIPTION`,
        prompt: `${SECRET}_PROMPT`,
    }],
    totals: {
        inputTokens: 5_000,
        outputTokens: 2_400,
        totalTokens: 7_400,
        costUsd: 0.42,
        secondsRunning: 1_834,
        dispatches: 12,
        attempts: 14,
        failures: 2,
        usageComplete: true,
        costComplete: true,
    },
    limits: {
        maxAttemptsPerItem: 5,
        maxDispatches: 100,
        maxTotalTokens: 1_000_000,
        maxTotalUsd: 25,
    },
};

/**
 * The synthetic orchestration history. `ts` is epoch ms, so each ring record's
 * `at` is the envelope timestamp and not the insert clock.
 */
const EVENT_FEED = [
    {
        event: EVENTS.WORK_ITEM.RETRY_SCHEDULED,
        ts: NOW_MS - 400_000,
        workItemId: 'wi-1',
        identifier: 'MER-1',
        attempt: 1,
        delayMs: 30_000,
        dueAtMs: NOW_MS - 370_000,
        failureClass: 'timeout',
        description: `${SECRET}_EVENT_DESCRIPTION`,
        prompt: `${SECRET}_EVENT_PROMPT`,
    },
    {
        event: EVENTS.WORK_ITEM.CLAIMED,
        ts: NOW_MS - 252_000,
        workItemId: 'wi-1',
        identifier: 'MER-1',
        attempt: 2,
        owner: 'default',
    },
    {
        event: EVENTS.WORK_ITEM.DISPATCHED,
        ts: NOW_MS - 251_000,
        workItemId: 'wi-1',
        identifier: 'MER-1',
        attempt: 2,
        lane: 'default',
        state: 'In Progress',
        priority: 1,
        runId: 'run-1',
    },
    {
        event: EVENTS.WORK_ITEM.RETRY_SCHEDULED,
        ts: NOW_MS - 60_000,
        workItemId: 'wi-2',
        identifier: 'MER-2',
        attempt: 1,
        delayMs: 30_000,
        dueAtMs: NOW_MS + 30_000,
        failureClass: 'timeout',
    },
    {
        // Outside the recorded namespaces: the ring must drop it.
        event: EVENTS.CLIENT.RUN_START,
        ts: NOW_MS - 50_000,
        runId: 'run-1',
    },
];

/** The exact status page the fixture renders (asserted below, not pasted blindly). */
const EXPECTED_STATUS = [
    'MerciSDK operator | running | tick 12 | poll 30s | last ok',
    'Running (1)',
    '  MER-1  attempt 2  In Progress  0:04:12  /tmp/ws/MER-1',
    'Retrying (1)',
    '  MER-2  due in 30s  TimeoutError',
    'Parked (1)',
    '  MER-3  attempts_exhausted  since 2026-11-09T17:00:00.000Z  attempts 5',
    'Totals: 7400 tokens | $0.4200 | 0:30:34 | 12 dispatches | 2 failures | usage complete | cost complete',
].join('\n');

/**
 * @typedef {Object} HttpResult
 * @property {number} status
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {string} body
 */

/**
 * @typedef {Object} StateResponse
 * @property {string} generatedAt
 * @property {{running: number, retrying: number, parked: number, claimed: number, completed: number}} counts
 * @property {Array<Record<string, unknown>>} running
 * @property {Array<Record<string, unknown>>} retrying
 * @property {Array<Record<string, unknown>>} parked
 * @property {Record<string, unknown>} totals
 * @property {Record<string, unknown>} limits
 * @property {{started: boolean, stopped: boolean, tickCount: number, lastTickAt: string|null, pollIntervalMs: number, activeStates: Array<unknown>, terminalStates: Array<unknown>}} scheduler
 * @property {null} rateLimits
 */

/**
 * @typedef {Object} ItemResponse
 * @property {string} generatedAt
 * @property {string} identifier
 * @property {string} workItemId
 * @property {string|null} url
 * @property {string} status
 * @property {{path: string}|null} workspace
 * @property {{current: number, continuations: number}} attempts
 * @property {Record<string, unknown>|null} running
 * @property {Record<string, unknown>|null} retry
 * @property {Record<string, unknown>|null} parked
 * @property {Array<Record<string, unknown>>} recentEvents
 */

/** The state response's row fields, in the documented order. */
const RUNNING_FIELDS = ['workItemId', 'identifier', 'url', 'state', 'lane', 'attempt', 'startedAt', 'lastProgressAt', 'threadId', 'workspacePath'];
const RETRYING_FIELDS = ['workItemId', 'identifier', 'url', 'attempt', 'kind', 'dueAt', 'delayMs', 'errorName', 'errorCode'];
const PARKED_FIELDS = ['workItemId', 'identifier', 'url', 'reason', 'since', 'nextCheckAt', 'attempts', 'continuations'];
const TOTALS_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'costUsd', 'secondsRunning', 'dispatches', 'attempts', 'failures', 'usageComplete', 'costComplete'];
const LIMITS_FIELDS = ['maxAttemptsPerItem', 'maxDispatches', 'maxTotalTokens', 'maxTotalUsd'];
const SCHEDULER_FIELDS = ['started', 'stopped', 'tickCount', 'lastTickAt', 'lastOutcome', 'pollIntervalMs', 'activeStates', 'terminalStates'];
/** The detail response's top-level fields. */
const ITEM_FIELDS = ['generatedAt', 'identifier', 'workItemId', 'url', 'status', 'workspace', 'attempts', 'running', 'retry', 'parked', 'recentEvents'];

/** The rows the projections must produce, field by field. */
const EXPECTED_RUNNING = {
    workItemId: 'wi-1',
    identifier: 'MER-1',
    url: 'https://tracker.example/MER-1',
    state: 'In Progress',
    lane: 'default',
    attempt: 2,
    startedAt: new Date(NOW_MS - 252_000).toISOString(),
    lastProgressAt: new Date(NOW_MS - 60_000).toISOString(),
    threadId: 'work:MER-1',
    workspacePath: '/tmp/ws/MER-1',
};
const EXPECTED_RETRYING = {
    workItemId: 'wi-2',
    identifier: 'MER-2',
    url: 'https://tracker.example/MER-2',
    attempt: 1,
    kind: 'failure',
    dueAt: new Date(NOW_MS + 30_000).toISOString(),
    delayMs: 30_000,
    errorName: 'TimeoutError',
    errorCode: 'ETIMEDOUT',
};
const EXPECTED_PARKED = {
    workItemId: 'wi-3',
    identifier: 'MER-3',
    url: null,
    reason: 'attempts_exhausted',
    since: new Date(NOW_MS - 3_600_000).toISOString(),
    nextCheckAt: new Date(NOW_MS + 600_000).toISOString(),
    attempts: 5,
    continuations: 2,
};
const EXPECTED_TOTALS = {
    inputTokens: 5_000,
    outputTokens: 2_400,
    totalTokens: 7_400,
    costUsd: 0.42,
    secondsRunning: 1_834,
    dispatches: 12,
    attempts: 14,
    failures: 2,
    usageComplete: true,
    costComplete: true,
};
const EXPECTED_LIMITS = {
    maxAttemptsPerItem: 5,
    maxDispatches: 100,
    maxTotalTokens: 1_000_000,
    maxTotalUsd: 25,
};
const EXPECTED_SCHEDULER = {
    started: true,
    stopped: false,
    tickCount: 12,
    lastTickAt: new Date(NOW_MS - 30_000).toISOString(),
    lastOutcome: 'ok',
    pollIntervalMs: 30_000,
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Cancelled'],
};

/**
 * One declared field list as a comparable JSON string, in that list's order.
 * @param {{ value: Record<string, unknown>, keys: Array<string> }} arg0 -
 * @returns {string}
 */
const pick = ({ value, keys }) => {
    // The comparison must catch a leaked extra key and a dropped nullable one,
    // so the shape is part of the rendered value: `Object.hasOwn` distinguishes
    // an explicit null (documented) from a missing field (a projection bug).
    const extras = Object.keys(value).filter((key) => !keys.includes(key));
    const missing = keys.filter((key) => !Object.hasOwn(value, key));
    const rendered = JSON.stringify(Object.fromEntries(keys.map((key) => [key, value[key] ?? null])));
    const shape = [
        ...extras.map((key) => `+${key}`),
        ...missing.map((key) => `-${key}`),
    ];
    return shape.length === 0 ? rendered : `${rendered} · shape ${shape.join(',')}`;
};

/**
 * One loopback HTTP request with a hard 2 s deadline.
 * @param {{port: number, path: string, method?: string, headers?: Record<string, string>, body?: string}} arg0 -
 * @returns {Promise<HttpResult>}
 */
function send({ port, path, method = 'GET', headers = {}, body = '' }) {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
            /** @type {Array<string>} */
            const chunks = [];
            res.setEncoding('utf8');
            res.on('data', (chunk) => { chunks.push(chunk); });
            res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: chunks.join('') }); });
        });
        req.setTimeout(2_000, () => { req.destroy(new Error(`request timeout: ${method} ${path}`)); });
        req.on('error', reject);
        if (body !== '') req.write(body);
        req.end();
    });
}

/**
 * Parse a response body through the SDK guard. The handler produced this JSON,
 * so a corrupt body is a failure, not something to repair.
 * @param {{body: string}} arg0 -
 * @returns {any}
 */
function parseBody({ body }) {
    const parsed = guardedParse({ input: body, options: { heal: false } });
    if (!parsed.success) throw new Error(`invalid JSON body: ${parsed.error}`);
    return parsed.data;
}

/**
 * The fixed error code of a JSON error response.
 * @param {HttpResult} result -
 * @returns {string}
 */
function errorCode(result) {
    try {
        const parsed = /** @type {{error?: {code?: unknown}}} */ (parseBody({ body: result.body }));
        return String(parsed.error?.code ?? '');
    } catch {
        return '';
    }
}

/** @type {Array<string>} */
const BODIES = [];

/** @type {number} */
let refreshCalls = 0;

async function runOffline() {
    log.option({ name: 'snapshot', value: '3 rows (1 running, 1 retrying, 1 parked)', source: 'a fake provider — no scheduler import' });
    log.option({ name: 'clock', value: NOW_ISO, source: 'a fixed instant; every timestamp is injected' });

    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter, limit: 50, now: () => NOW_MS });
    for (const entry of EVENT_FEED) emitter.emit(entry.event, entry);

    const handler = createOperatorHttpHandler({
        getSnapshot: () => SNAPSHOT,
        refresh: async () => { refreshCalls += 1; },
        recentEvents: ({ identifier, limit }) => ring.list({
            identifier: typeof identifier === 'string' ? identifier : null,
            limit: limit ?? null,
        }),
        now: () => NOW_MS,
    });
    // A second mount without a refresh provider: `501 refresh_not_supported`
    // is decided before the body is even read.
    const readOnlyHandler = createOperatorHttpHandler({
        getSnapshot: () => SNAPSHOT,
        basePath: '/ops/v1',
        statusPath: null,
        now: () => NOW_MS,
    });

    const server = createServer((req, res) => {
        if ((req.url ?? '').startsWith('/ops/')) void readOnlyHandler(req, res);
        else void handler(req, res);
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    log.option({ name: 'address', value: `http://127.0.0.1:${port}`, source: 'createServer + listen(0) — loopback, ephemeral' });

    try {
        // ── A: the state route ───────────────────────────────────────────────
        audit.scenario({
            id: 'A', title: 'the state route',
            goal: 'GET /api/v1/state answers one JSON projection of the whole snapshot',
            expect: `200 JSON · generatedAt ${NOW_ISO} · counts 1/1/1 · the running, retrying and parked rows field by field · totals and the four limits as declared · scheduler lifecycle · rateLimits null · cache-control no-store`,
            fails: [
                { code: 'not-json', symptom: 'the state route did not answer 200 application/json', hint: 'the handler projects the snapshot; a missing getSnapshot is 503' },
                { code: 'row-spread', symptom: 'a row field or an extra limit/total key appeared', hint: 'every row is an explicit projection, never a spread' },
                { code: 'bad-timestamp', symptom: 'a timestamp is not an ISO string', hint: 'startedAt/lastProgressAt/dueAt/since/nextCheckAt/lastTickAt are converted once' },
            ],
            input: { route: 'GET /api/v1/state', now: NOW_ISO },
        });

        const stateResult = await send({ port, path: '/api/v1/state' });
        BODIES.push(stateResult.body);
        const state = /** @type {StateResponse} */ (parseBody({ body: stateResult.body }));
        audit.observe({ name: 'counts', value: state.counts });
        audit.observe({ name: 'totals', value: state.totals });

        audit.check({
            name: 'the state route answers 200 JSON with cache-control: no-store',
            ok: stateResult.status === 200
                && String(stateResult.headers['content-type'] ?? '').startsWith('application/json')
                && stateResult.headers['cache-control'] === 'no-store',
            detail: {
                expected: '200 · application/json · no-store',
                observed: `${stateResult.status} · ${String(stateResult.headers['content-type'])} · ${String(stateResult.headers['cache-control'])}`,
            },
        });
        audit.check({
            name: 'the published API version and defaults name the route this fixture uses',
            ok: OPERATOR_API_VERSION === 1
                && OPERATOR_DEFAULTS.basePath === '/api/v1'
                && OPERATOR_DEFAULTS.statusPath === '/'
                && OPERATOR_DEFAULTS.allowedHosts.includes('127.0.0.1'),
            detail: {
                expected: 'version 1 · basePath /api/v1 · statusPath / · loopback allowed',
                observed: `version ${OPERATOR_API_VERSION} · ${OPERATOR_DEFAULTS.basePath} · ${OPERATOR_DEFAULTS.statusPath} · ${OPERATOR_DEFAULTS.allowedHosts.join(',')}`,
            },
        });
        audit.check({
            name: 'generatedAt is the injected ISO instant and the counts match the row lists',
            ok: state.generatedAt === NOW_ISO
                && state.counts.running === 1 && state.counts.retrying === 1 && state.counts.parked === 1
                && state.counts.claimed === 3 && state.counts.completed === 2,
            detail: {
                expected: `${NOW_ISO} · counts {running:1,retrying:1,parked:1,claimed:3,completed:2}`,
                observed: `${state.generatedAt} · ${JSON.stringify(state.counts)}`,
            },
        });
        audit.check({
            name: 'the running row matches field by field',
            ok: pick({ value: state.running[0] ?? {}, keys: RUNNING_FIELDS }) === JSON.stringify(EXPECTED_RUNNING),
            detail: {
                expected: JSON.stringify(EXPECTED_RUNNING),
                observed: pick({ value: state.running[0] ?? {}, keys: RUNNING_FIELDS }),
            },
        });
        audit.check({
            name: 'the retrying row matches field by field',
            ok: pick({ value: state.retrying[0] ?? {}, keys: RETRYING_FIELDS }) === JSON.stringify(EXPECTED_RETRYING),
            detail: {
                expected: JSON.stringify(EXPECTED_RETRYING),
                observed: pick({ value: state.retrying[0] ?? {}, keys: RETRYING_FIELDS }),
            },
        });
        audit.check({
            name: 'the parked row matches field by field',
            ok: pick({ value: state.parked[0] ?? {}, keys: PARKED_FIELDS }) === JSON.stringify(EXPECTED_PARKED),
            detail: {
                expected: JSON.stringify(EXPECTED_PARKED),
                observed: pick({ value: state.parked[0] ?? {}, keys: PARKED_FIELDS }),
            },
        });
        audit.check({
            name: 'totals carry every declared field and no extra key',
            ok: pick({ value: state.totals, keys: TOTALS_FIELDS }) === JSON.stringify(EXPECTED_TOTALS)
                && Object.keys(state.totals).length === TOTALS_FIELDS.length,
            detail: {
                expected: `${JSON.stringify(EXPECTED_TOTALS)} · ${TOTALS_FIELDS.length} keys`,
                observed: `${pick({ value: state.totals, keys: TOTALS_FIELDS })} · ${Object.keys(state.totals).length} keys`,
            },
        });
        audit.check({
            name: 'limits carry exactly the four declared fields',
            ok: pick({ value: state.limits, keys: LIMITS_FIELDS }) === JSON.stringify(EXPECTED_LIMITS)
                && Object.keys(state.limits).length === LIMITS_FIELDS.length,
            detail: {
                expected: `${JSON.stringify(EXPECTED_LIMITS)} · ${LIMITS_FIELDS.length} keys`,
                observed: `${pick({ value: state.limits, keys: LIMITS_FIELDS })} · ${Object.keys(state.limits).length} keys`,
            },
        });
        audit.check({
            name: 'the scheduler lifecycle is mirrored and rateLimits is null',
            ok: pick({ value: /** @type {Record<string, unknown>} */ (state.scheduler), keys: SCHEDULER_FIELDS }) === JSON.stringify(EXPECTED_SCHEDULER)
                && state.rateLimits === null,
            detail: {
                expected: `${JSON.stringify(EXPECTED_SCHEDULER)} · rateLimits null`,
                observed: `${pick({ value: /** @type {Record<string, unknown>} */ (state.scheduler), keys: SCHEDULER_FIELDS })} · rateLimits ${String(state.rateLimits)}`,
            },
        });
        audit.end();

        // ── B: the detail route and its feed ─────────────────────────────────
        audit.scenario({
            id: 'B', title: 'the detail route and its feed',
            goal: 'one item resolves by identifier, carries its own ring history, and the alias answers the same body',
            expect: 'GET /api/v1/items/MER-1 200 · status running · workspace /tmp/ws/MER-1 · attempts 2/0 · recentEvents: retry_scheduled → claimed → dispatched, all MER-1, at = the envelope ts · GET /api/v1/items/NOPE 404 item_not_found · the alias /api/v1/MER-1 answers the identical body',
            fails: [
                { code: 'unfiltered-feed', symptom: 'the feed carries MER-2 or the run:start event', hint: 'the ring filters by its four prefixes, and the route filters by identifier' },
                { code: 'iso-at', symptom: 'recentEvents[].at is an ISO string', hint: 'at is epoch milliseconds, the documented exception' },
                { code: 'alias-differs', symptom: 'the alias body differs from the canonical one', hint: 'both paths route to the same item projection' },
            ],
            input: { routes: ['GET /api/v1/items/MER-1', 'GET /api/v1/items/NOPE', 'GET /api/v1/MER-1'] },
        });

        const itemResult = await send({ port, path: '/api/v1/items/MER-1' });
        BODIES.push(itemResult.body);
        const item = /** @type {ItemResponse} */ (parseBody({ body: itemResult.body }));
        audit.observe({
            name: 'recentEvents',
            value: item.recentEvents.map((event) => `${String(event.event)}@${String(event.at)}`),
        });

        audit.check({
            name: 'the detail route answers the running item with its workspace and attempts',
            ok: itemResult.status === 200
                && item.identifier === 'MER-1' && item.workItemId === 'wi-1'
                && item.status === 'running' && item.generatedAt === NOW_ISO
                && item.workspace !== null && item.workspace.path === '/tmp/ws/MER-1'
                && item.attempts.current === 2 && item.attempts.continuations === 0
                && item.running !== null && item.retry === null && item.parked === null,
            detail: {
                expected: '200 · MER-1/wi-1 running · workspace /tmp/ws/MER-1 · attempts 2/0 · retry null · parked null',
                observed: `${itemResult.status} · ${String(item.identifier)}/${String(item.workItemId)} ${String(item.status)} · workspace ${JSON.stringify(item.workspace)} · attempts ${JSON.stringify(item.attempts)} · retry ${String(item.retry)} · parked ${String(item.parked)}`,
            },
        });
        audit.check({
            name: 'the detail response is exactly the documented key set',
            ok: JSON.stringify(Object.keys(item).sort()) === JSON.stringify([...ITEM_FIELDS].sort()),
            detail: {
                expected: ITEM_FIELDS.join(', '),
                observed: Object.keys(item).sort().join(', '),
            },
        });

        const feedNames = item.recentEvents.map((event) => String(event.event));
        const feedAts = item.recentEvents.map((event) => event.at);
        audit.check({
            name: 'the feed is this identifier only, in order, with epoch-ms at and no prose',
            ok: item.recentEvents.length === 3
                && feedNames.join(' → ') === [
                    EVENTS.WORK_ITEM.RETRY_SCHEDULED, EVENTS.WORK_ITEM.CLAIMED, EVENTS.WORK_ITEM.DISPATCHED,
                ].join(' → ')
                && item.recentEvents.every((event) => event.identifier === 'MER-1')
                && feedAts.every((at) => typeof at === 'number')
                && JSON.stringify(feedAts) === JSON.stringify([NOW_MS - 400_000, NOW_MS - 252_000, NOW_MS - 251_000])
                && item.recentEvents.every((event) => !('description' in event) && !('prompt' in event)),
            detail: {
                expected: `3 events · retry_scheduled → claimed → dispatched · at ${NOW_MS - 400_000}/${NOW_MS - 252_000}/${NOW_MS - 251_000} · no description/prompt`,
                observed: `${item.recentEvents.length} events · ${feedNames.join(' → ')} · at ${feedAtText(feedAts)} · ${item.recentEvents.filter((event) => 'description' in event || 'prompt' in event).length} prose records`,
            },
        });

        const missingItem = await send({ port, path: '/api/v1/items/NOPE' });
        BODIES.push(missingItem.body);
        audit.check({
            name: 'an unknown identifier is 404 item_not_found',
            ok: missingItem.status === 404 && errorCode(missingItem) === 'item_not_found',
            detail: {
                expected: '404 · item_not_found',
                observed: `${missingItem.status} · ${errorCode(missingItem)}`,
            },
        });

        const aliasResult = await send({ port, path: '/api/v1/MER-1' });
        BODIES.push(aliasResult.body);
        audit.check({
            name: 'the alias route answers the identical body',
            ok: aliasResult.status === 200 && aliasResult.body === itemResult.body,
            detail: {
                expected: '200 · the canonical /items/MER-1 body',
                observed: `${aliasResult.status} · ${aliasResult.body === itemResult.body ? 'identical' : 'different'} body`,
            },
        });
        audit.end();

        // ── C: the status page ───────────────────────────────────────────────
        audit.scenario({
            id: 'C', title: 'the status page',
            goal: 'GET / renders the same plain-text page formatStatus produces, and terminal control characters are neutralized',
            expect: 'GET / 200 text/plain · the header, the Running/Retrying/Parked sections and the totals line · formatStatus({snapshot, now}) byte-identical · a hostile identifier yields no ANSI or CR',
            fails: [
                { code: 'json-on-status', symptom: 'the status route answered JSON', hint: 'the status route is the one text route; its failures are text too' },
                { code: 'renderer-drift', symptom: 'the route body differs from formatStatus', hint: 'both call the same pure renderer' },
                { code: 'ansi', symptom: 'an escape sequence survived in the page', hint: 'safeText turns every control character into ?' },
            ],
            input: { route: 'GET /', now: NOW_ISO },
        });

        const statusResult = await send({ port, path: '/' });
        BODIES.push(statusResult.body);
        audit.observe({ name: 'status page', value: statusResult.body });
        const rendererText = formatStatus({ snapshot: SNAPSHOT, now: NOW_MS });
        const headerLine = statusResult.body.split('\n')[0] ?? '';

        audit.check({
            name: 'the status route answers 200 text/plain with cache-control: no-store',
            ok: statusResult.status === 200
                && String(statusResult.headers['content-type'] ?? '').startsWith('text/plain')
                && statusResult.headers['cache-control'] === 'no-store',
            detail: {
                expected: '200 · text/plain · no-store',
                observed: `${statusResult.status} · ${String(statusResult.headers['content-type'])} · ${String(statusResult.headers['cache-control'])}`,
            },
        });
        audit.check({
            name: 'the header names the lifecycle, the tick and the poll interval',
            ok: headerLine === 'MerciSDK operator | running | tick 12 | poll 30s | last ok',
            detail: {
                expected: 'MerciSDK operator | running | tick 12 | poll 30s | last ok',
                observed: headerLine,
            },
        });
        audit.check({
            name: 'the three sections are present with their row counts',
            ok: ['Running (1)', 'Retrying (1)', 'Parked (1)'].every((section) => statusResult.body.includes(section)),
            detail: {
                expected: 'Running (1) · Retrying (1) · Parked (1)',
                observed: ['Running (1)', 'Retrying (1)', 'Parked (1)']
                    .map((section) => `${section}=${statusResult.body.includes(section)}`)
                    .join(' '),
            },
        });
        audit.check({
            name: 'the totals line carries tokens, cost, runtime, dispatches, failures and both flags',
            ok: statusResult.body.includes('Totals: 7400 tokens | $0.4200 | 0:30:34 | 12 dispatches | 2 failures | usage complete | cost complete'),
            detail: {
                expected: 'Totals: 7400 tokens | $0.4200 | 0:30:34 | 12 dispatches | 2 failures | usage complete | cost complete',
                observed: statusResult.body.split('\n').find((line) => line.startsWith('Totals:')) ?? '(no totals line)',
            },
        });
        audit.check({
            name: 'formatStatus produces exactly the served page',
            ok: rendererText === statusResult.body && rendererText === EXPECTED_STATUS,
            detail: {
                expected: `${EXPECTED_STATUS.split('\n').length} golden lines`,
                observed: `${rendererText.split('\n').length} renderer lines · ${rendererText === statusResult.body ? 'identical to the route' : 'differs from the route'}`,
            },
        });
        const hostile = {
            ...SNAPSHOT,
            running: [{
                ...SNAPSHOT.running[0],
                identifier: '\u001b[31mEVIL-1\u001b[0m',
                workspacePath: '/tmp/ws/\r\nEVIL',
            }],
        };
        const hostileText = formatStatus({ snapshot: hostile, now: NOW_MS });
        audit.check({
            name: 'a hostile identifier cannot inject ANSI or a carriage return',
            ok: !hostileText.includes('\u001b') && !hostileText.includes('\r')
                && hostileText.includes('?[31mEVIL-1?[0m'),
            detail: {
                expected: 'no \\u001b and no \\r · the identifier rendered as ?[31mEVIL-1?[0m',
                observed: `${hostileText.includes('\u001b') ? 'ANSI present' : 'no ANSI'} · ${hostileText.includes('\r') ? 'CR present' : 'no CR'}`,
            },
        });
        audit.end();

        // ── D: security and errors ───────────────────────────────────────────
        audit.scenario({
            id: 'D', title: 'security and errors',
            goal: 'the Host allowlist, the route miss, the JSON-only refresh and the missing provider each answer their documented code',
            expect: 'foreign Host 403 forbidden_host · GET /api/v1/nope 404 item_not_found (an alias id) · GET /nope 404 not_found · POST text/plain 415 unsupported_media_type · POST JSON on the provider-less mount 501 refresh_not_supported · POST JSON 202 queued · no body carries SECRET_',
            fails: [
                { code: 'host-open', symptom: 'a foreign Host was served', hint: 'requestHostAllowed compares the Host header; loopback is the default allowlist' },
                { code: 'csrf', symptom: 'a text/plain refresh started a tick', hint: 'the JSON media type is the CSRF control; it is checked before the body' },
                { code: 'leak', symptom: 'a body carried the fixture SECRET_ text', hint: 'rows and events are projected by an explicit allowlist' },
            ],
            input: { routes: ['GET /api/v1/state (Host: evil.example)', 'GET /api/v1/nope', 'GET /nope', 'POST /api/v1/refresh', 'POST /ops/v1/refresh'] },
        });

        const foreignHost = await send({ port, path: '/api/v1/state', headers: { host: 'evil.example' } });
        BODIES.push(foreignHost.body);
        audit.check({
            name: 'a foreign Host is refused with 403 forbidden_host',
            ok: foreignHost.status === 403 && errorCode(foreignHost) === 'forbidden_host',
            detail: {
                expected: '403 · forbidden_host',
                observed: `${foreignHost.status} · ${errorCode(foreignHost)}`,
            },
        });

        const unknownAlias = await send({ port, path: '/api/v1/nope' });
        BODIES.push(unknownAlias.body);
        audit.check({
            name: 'an unknown alias segment is an item lookup, so 404 item_not_found',
            ok: unknownAlias.status === 404 && errorCode(unknownAlias) === 'item_not_found',
            detail: {
                expected: '404 · item_not_found',
                observed: `${unknownAlias.status} · ${errorCode(unknownAlias)}`,
            },
        });

        const unknownRoute = await send({ port, path: '/nope' });
        BODIES.push(unknownRoute.body);
        audit.check({
            name: 'a path outside every route is 404 not_found',
            ok: unknownRoute.status === 404 && errorCode(unknownRoute) === 'not_found',
            detail: {
                expected: '404 · not_found',
                observed: `${unknownRoute.status} · ${errorCode(unknownRoute)}`,
            },
        });

        const wrongType = await send({
            port,
            path: '/api/v1/refresh',
            method: 'POST',
            headers: { 'content-type': 'text/plain', 'content-length': '2' },
            body: '{}',
        });
        BODIES.push(wrongType.body);
        audit.check({
            name: 'a text/plain refresh is 415 unsupported_media_type and starts nothing',
            ok: wrongType.status === 415 && errorCode(wrongType) === 'unsupported_media_type' && refreshCalls === 0,
            detail: {
                expected: '415 · unsupported_media_type · 0 refreshes',
                observed: `${wrongType.status} · ${errorCode(wrongType)} · ${refreshCalls} refreshes`,
            },
        });

        const noProvider = await send({
            port,
            path: '/ops/v1/refresh',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': '2' },
            body: '{}',
        });
        BODIES.push(noProvider.body);
        audit.check({
            name: 'a handler without a refresh provider is 501 refresh_not_supported',
            ok: noProvider.status === 501 && errorCode(noProvider) === 'refresh_not_supported',
            detail: {
                expected: '501 · refresh_not_supported',
                observed: `${noProvider.status} · ${errorCode(noProvider)}`,
            },
        });

        const refresh = await send({
            port,
            path: '/api/v1/refresh',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': '2' },
            body: '{}',
        });
        BODIES.push(refresh.body);
        const refreshBody = /** @type {{queued?: unknown, coalesced?: unknown, requestedAt?: unknown, operations?: unknown}} */ (parseBody({ body: refresh.body }));
        audit.check({
            name: 'a JSON refresh is accepted once with 202 and the fixed operations',
            ok: refresh.status === 202 && refreshBody.queued === true && refreshBody.coalesced === false
                && refreshBody.requestedAt === NOW_ISO
                && JSON.stringify(refreshBody.operations) === JSON.stringify(['poll', 'reconcile'])
                && refreshCalls === 1,
            detail: {
                expected: `202 · queued true · coalesced false · ${NOW_ISO} · ["poll","reconcile"] · 1 refresh call`,
                observed: `${refresh.status} · ${refresh.body} · ${refreshCalls} refresh call`,
            },
        });

        const leaked = BODIES.filter((body) => body.includes(SECRET));
        audit.observe({ name: 'captured bodies', value: BODIES.length });
        audit.check({
            name: 'no captured response body carries the fixture secret',
            // A vacuous pass if nothing was captured, so the count is part of it.
            ok: BODIES.length > 0 && leaked.length === 0,
            detail: {
                expected: 'at least one captured body, none with the SECRET_ sentinel',
                observed: `${BODIES.length} captured · ${leaked.length === 0 ? 'no SECRET_ text' : `${leaked.length} leaked it`}`,
            },
        });
        audit.end();

        log.success({ m: 'Operator API verified: state, detail feed, status page, security and errors.' });
    } finally {
        ring.stop();
        server.closeAllConnections();
        await new Promise((resolve) => { server.close(() => resolve(undefined)); });
    }
}

/** @returns {Promise<void>} Let the scheduler's promise chains settle. */
async function flush() {
    for (let round = 0; round < 5; round += 1) {
        await new Promise((resolve) => { setImmediate(resolve); });
    }
}

async function runLive() {
    if (live === null) throw new Error('live backend unavailable');
    const { client } = await initializeClient({
        provider: live.provider,
        options: loadCredentials({ provider: live.provider }),
    });
    wireClient({ client });
    const usage = trackUsage({ client });
    let apiCalls = 0;
    client.on('api_request', () => { apiCalls += 1; });

    const identifier = 'MER-30';
    const emitter = new MerciEventEmitter();
    const ring = createEventRing({ emitter, limit: 50 });
    /** @type {(() => void)|null} */
    let settle = null;
    const settled = new Promise((resolve) => { settle = () => resolve(undefined); });
    let liveAnswer = '';
    const engineWorkflow = createEngineRunner({
        engine: 'agentic',
        client,
        model: live.toolModel,
        prompt: /** @type {(arg0: { item: { identifier: string } }) => string} */ (({ item }) => `Reply with exactly: OPERATOR-LIVE-${item.identifier}`),
    });
    const items = [{
        id: 'wi-30',
        identifier,
        title: 'The operator live item',
        description: 'demo-only description text',
        state: 'Todo',
        dispatchable: true,
        priority: 1,
    }];
    const scheduler = new WorkScheduler({
        workSource: createMemoryWorkSource({ items }),
        workflow: {
            /** @param {Parameters<ReturnType<typeof createEngineRunner>['run']>[0]} args */
            async run(args) {
                try {
                    const result = await engineWorkflow.run(args);
                    liveAnswer = result.summary ?? '';
                    return result;
                } finally {
                    settle?.();
                }
            },
        },
        claims: createMemoryClaimStore(),
        eventEmitter: emitter,
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        concurrency: { global: 1 },
        retry: { baseMs: 1_000, maxMs: 1_000 },
        continuation: { delayMs: 0, max: 0 },
        limits: { maxAttemptsPerItem: 1 },
        stallTimeoutMs: 0,
        pollIntervalMs: 3_600_000,
    });

    const handler = createOperatorHttpHandler({
        getSnapshot: () => scheduler.snapshot(),
        refresh: async () => { await scheduler.tick(); },
        recentEvents: ({ identifier: id, limit }) => ring.list({
            identifier: typeof id === 'string' ? id : null,
            limit: limit ?? null,
        }),
    });
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    log.option({ name: 'address', value: `http://127.0.0.1:${port}`, source: 'createServer + listen(0) — loopback, ephemeral' });
    log.option({ name: 'snapshot', value: 'a real WorkScheduler', source: 'createMemoryWorkSource + createEngineRunner' });

    try {
        await scheduler.start();
        await settled;
        await flush();
        // One explicit tick after start(), so the refresh below has a real tick to move.
        await scheduler.tick();

        audit.scenario({
            id: 'L', title: 'the live operator surface',
            goal: 'the same routes read a real scheduler run: state counts, the item feed, the status page and a refresh tick',
            expect: 'state 200 JSON · 0 running, 1 parked, 1 claimed, >= 1 dispatch · detail parked with this identifier\'s ring history · alias identical · status text · POST refresh 202 and the tick count moves by one · > 0 api_request · no body carries the prompt marker',
            fails: [
                { code: 'no-run', symptom: 'the live item never settled', hint: 'the engine run must resolve; the finally in workflow.run signals the wait' },
                { code: 'wrong-row', symptom: 'the detail is not the parked live item', hint: 'continuations are disabled, so a completion parks and keeps its claim' },
                { code: 'no-tick', symptom: 'the refresh did not move the tick count', hint: 'refresh calls scheduler.tick()' },
                { code: 'leak', symptom: 'a body carries the prompt text', hint: 'the ring projects allowlisted fields only' },
            ],
            input: { identifier, model: live.toolModel },
        });

        /** @type {Array<string>} */
        const bodies = [];
        const stateResult = await send({ port, path: '/api/v1/state' });
        bodies.push(stateResult.body);
        const state = /** @type {StateResponse} */ (parseBody({ body: stateResult.body }));
        const itemResult = await send({ port, path: `/api/v1/items/${identifier}` });
        bodies.push(itemResult.body);
        const item = /** @type {ItemResponse} */ (parseBody({ body: itemResult.body }));
        const aliasResult = await send({ port, path: `/api/v1/${identifier}` });
        bodies.push(aliasResult.body);
        const aliasItem = /** @type {ItemResponse} */ (parseBody({ body: aliasResult.body }));
        const statusResult = await send({ port, path: '/' });
        bodies.push(statusResult.body);

        audit.observe({ name: 'live answer', value: liveAnswer });
        audit.observe({ name: 'live counts', value: state.counts });
        audit.observe({ name: 'live totals', value: state.totals });
        audit.observe({ name: 'live recentEvents', value: item.recentEvents.map((event) => `${String(event.event)}@${String(event.at)}`) });

        audit.check({
            name: 'the state route answers the settled live snapshot',
            ok: stateResult.status === 200
                && state.counts.running === 0 && state.counts.retrying === 0
                && state.counts.parked === 1 && state.counts.claimed === 1
                && Number(state.totals.dispatches) >= 1,
            detail: {
                expected: '200 · running 0 · retrying 0 · parked 1 · claimed 1 · dispatches >= 1',
                observed: `${stateResult.status} · ${JSON.stringify(state.counts)} · dispatches ${String(state.totals.dispatches)}`,
            },
        });
        audit.check({
            name: 'the detail route answers this parked item with its own feed',
            ok: itemResult.status === 200
                && item.identifier === identifier && item.workItemId === 'wi-30'
                && item.status === 'parked' && item.parked !== null
                // The scheduler's per-item attempt counter counts failures only:
                // a clean first attempt completes with 0, so that is the real value.
                && item.attempts.current === 0 && item.attempts.continuations === 0
                && item.recentEvents.length > 0
                && item.recentEvents.every((event) => event.identifier === identifier)
                && item.recentEvents.every((event) => typeof event.at === 'number'),
            detail: {
                expected: '200 · MER-30/wi-30 parked · attempts 0/0 · non-empty feed for this identifier · epoch-ms at',
                observed: `${itemResult.status} · ${String(item.identifier)}/${String(item.workItemId)} ${String(item.status)} · attempts ${JSON.stringify(item.attempts)} · ${item.recentEvents.length} events`,
            },
        });
        audit.check({
            name: 'the alias route answers the same item projection',
            // generatedAt is the response clock; every other field must match.
            ok: aliasResult.status === 200
                && JSON.stringify({ ...aliasItem, generatedAt: null }) === JSON.stringify({ ...item, generatedAt: null }),
            detail: {
                expected: '200 · the canonical item projection (generatedAt aside)',
                observed: `${aliasResult.status} · ${JSON.stringify({ ...aliasItem, generatedAt: null }) === JSON.stringify({ ...item, generatedAt: null }) ? 'identical' : 'different'} projection`,
            },
        });
        const statusHeader = statusResult.body.split('\n')[0] ?? '';
        audit.check({
            name: 'the status route renders the live scheduler state',
            ok: statusResult.status === 200
                && statusHeader.startsWith('MerciSDK operator | running | tick ')
                && statusResult.body.includes('Parked (1)'),
            detail: {
                expected: '200 · "MerciSDK operator | running | tick …" · Parked (1)',
                observed: `${statusResult.status} · ${statusHeader}`,
            },
        });

        const refresh = await send({
            port,
            path: '/api/v1/refresh',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': '2' },
            body: '{}',
        });
        bodies.push(refresh.body);
        const afterResult = await send({ port, path: '/api/v1/state' });
        bodies.push(afterResult.body);
        const after = /** @type {StateResponse} */ (parseBody({ body: afterResult.body }));
        audit.check({
            name: 'a JSON refresh drives one tick and the tick count moves',
            ok: refresh.status === 202 && after.scheduler.tickCount === state.scheduler.tickCount + 1,
            detail: {
                expected: `202 · tick ${state.scheduler.tickCount + 1}`,
                observed: `${refresh.status} · tick ${after.scheduler.tickCount} (before ${state.scheduler.tickCount})`,
            },
        });
        const promptMarker = `OPERATOR-LIVE-${identifier}`;
        audit.check({
            name: 'the live run made real vendor calls and produced the prompt marker',
            ok: apiCalls > 0 && liveAnswer.includes(promptMarker),
            detail: {
                expected: `> 0 api_request · ${promptMarker}`,
                observed: `${apiCalls} api_request · ${JSON.stringify(liveAnswer)}`,
            },
        });
        const leaked = bodies.filter((body) => body.includes(promptMarker));
        audit.check({
            name: 'no response body carries the prompt marker',
            ok: bodies.length > 0 && leaked.length === 0,
            detail: {
                expected: `>= 1 body · no ${promptMarker}`,
                observed: `${bodies.length} bodies · ${leaked.length === 0 ? 'clean' : `${leaked.length} leaked it`}`,
            },
        });
        audit.end();

        log.success({ m: 'Operator API verified live: the real scheduler state, feed, status page and refresh tick.' });
    } finally {
        ring.stop();
        server.closeAllConnections();
        await new Promise((resolve) => { server.close(() => resolve(undefined)); });
        await scheduler.stop({ reason: 'example-done' });
        reportUsage({ provider: live.provider, usage });
    }
}

async function main() {
    if (OFFLINE) {
        await runOffline();
        return;
    }
    await runLive();
}

/**
 * The feed's `at` values as one comparable string.
 * @param {Array<unknown>} ats -
 * @returns {string}
 */
function feedAtText(ats) {
    return ats.map((at) => String(at)).join('/');
}

// The await matters: without it a stalled run would exit 0 with a truncated log.
await audit.run(main);
