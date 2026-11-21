// @ts-check
/**
 * Example 36 — The reverse seam: an ordinary session consumes the new capability.
 *
 * Examples 27–35 prove the coordination layer from the outside; this audit proves
 * the other direction. A plain `client.session(model)` over a scripted vendor, a
 * `TodoComponent` store, and a shared `MerciEventEmitter` — no
 * `createOrchestration` anywhere:
 *
 *   A — workspace : `withWorkspace({ workspace })` binds the context and shell
 *       tools to one real handle. The scripted model reads a file from that
 *       directory, an outside path that EXISTS is refused, and the shell gate is
 *       asked with the command and its argv and says no.
 *   B — intake    : a `TodoComponent`-backed `Map` feeds `createTodoWorkSource`;
 *       one `WorkScheduler` tick dispatches the `pending` todo and never the
 *       `completed` one, and the store is read live, not snapshotted.
 *   C — ring      : the session's `run:*`/`tool:*` records reach
 *       `createEventRing` with `sessionId` only when the prefixes are opted in;
 *       the default set records none of them and never keeps tool arguments.
 *
 * Public API: `MerciClient`, `WorkspaceManager`, `TodoComponent`,
 * `createTodoWorkSource`, `WorkScheduler`, `createEventRing`,
 * `DEFAULT_PREFIXES`, `MerciEventEmitter`, `EVENTS`, `log`.
 *
 * Run: `node test/examples/36_connected_layers.mjs` (offline only)
 * Needs: nothing — no backend, no model, no network.
 *
 * @version 0.12.0
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENTS, MerciEventEmitter, TodoComponent, log } from 'merci-sdk';
import { MerciClient } from 'merci-sdk/oai';
import { DEFAULT_PREFIXES, createEventRing } from 'merci-sdk/operator';
import { WorkScheduler, createMemoryClaimStore, createTodoWorkSource } from 'merci-sdk/scheduler';
import { WorkspaceManager } from 'merci-sdk/workspace';
import { createAudit } from '../../examples/_shared/example-audit.mjs';

const OFFLINE = process.argv.includes('--offline');
const SESSION_ID = 'session-36-audit';
const INSIDE_MARKER = 'WORKSPACE-NOTE-36';
const OUTSIDE_MARKER = 'OUTSIDE-SECRET-36';
const ANSWER_MARKER = 'FINAL-36';
// The audit never claims a stable transcript, so it takes a fresh temp root.
let ROOT = '';

const audit = createAudit({
    metaUrl: import.meta.url,
    id: 'audit/36_connected_layers',
    offline: true,
    provider: null,
    models: 'scripted vendor',
    // This audit has no live path; the flag only says how CI selected it.
    env: { path: OFFLINE ? 'offline (--offline)' : 'offline by construction' },
    title: 'Example 36 — The reverse seam',
});

// ── the scripted vendor ──────────────────────────────────────────────────────
/** One assistant chunk that requests a tool. @param {{name: string, args: Record<string, unknown>}} arg0 */
const toolChunk = ({ name, args }) => ({
    choices: [{
        delta: { tool_calls: [{ index: 0, id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: 'tool_calls'
    }]
});

/**
 * The offline vendor: an OpenAI-shaped `chat.completions.create` replaying one
 * scripted round per call and keeping every request body.
 * @param {{steps: Array<Array<Record<string, unknown>>>}} arg0 -
 */
function scriptedVendor({ steps }) {
    /** @type {Array<Record<string, any>>} */
    const bodies = [];
    let index = 0;
    return {
        bodies,
        chat: {
            completions: {
                /** @param {{messages: Array<any>}} body */
                create: async (body) => {
                    bodies.push(/** @type {any} */ (body));
                    const step = steps[Math.min(index, steps.length - 1)];
                    index += 1;
                    return (async function* replay() { for (const chunk of step) yield chunk; })();
                }
            }
        },
        responses: { create: async () => { throw new Error('this script only speaks chat completions'); } }
    };
}

/** Every `tool`-role message the vendor received, as text. @param {{bodies: Array<Record<string, any>>}} arg0 - */
const toolMessages = ({ bodies }) => bodies.flatMap((body) => (Array.isArray(body.messages) ? body.messages : []))
    .filter((row) => row?.role === 'tool')
    .map((row) => String(row.content ?? ''));

/** @type {any} */
let active = null;

async function main() {
    ROOT = await mkdtemp(join(tmpdir(), 'merci-audit-36-'));
    await mkdir(join(ROOT, 'root'), { recursive: true });

    const workspaceManager = new WorkspaceManager({ root: join(ROOT, 'root') });
    const workspace = await workspaceManager.ensure({ workItemId: 'todo-open', identifier: 'MER-36' });
    await writeFile(join(workspace.path, 'notes.txt'), `${INSIDE_MARKER}\n`, 'utf8');
    // A file one level above the workspace and really present: a denied read must
    // be confinement, not a missing file.
    await writeFile(join(workspace.root, 'outside.txt'), `${OUTSIDE_MARKER}\n`, 'utf8');

    const emitter = new MerciEventEmitter();
    /** @type {Array<[unknown, unknown]>} */
    const gateCalls = [];
    const vendor = scriptedVendor({
        steps: [
            [toolChunk({ name: 'read', args: { filePath: 'notes.txt' } })],
            [toolChunk({ name: 'read', args: { filePath: '../outside.txt' } })],
            [toolChunk({ name: 'execute_shell_command', args: { command: 'ls', args: ['..'] } })],
            [{ choices: [{ delta: { content: ANSWER_MARKER }, finish_reason: 'stop' }] }]
        ]
    });
    const client = new MerciClient({ options: { apiKey: 'offline' } });
    /** @type {any} */ (client).transport = vendor;

    // The control ring records the default namespaces; the opt-in one adds the
    // session's own. Both see the same emitter.
    const optInRing = createEventRing({ emitter, prefixes: [...DEFAULT_PREFIXES, 'run:', 'tool:'] });
    const defaultRing = createEventRing({ emitter });

    try {
        // ── A: the session works inside the workspace ────────────────────────
        audit.scenario({
            id: 'A', title: 'withWorkspace binds one real handle',
            goal: 'a plain client.session(model) uses the workspace for reads, refuses an outside path, and reaches the shell gate',
            expect: 'session.workspace is the handle · the read result carries the file under the workspace path · the outside path is denied and its content never appears · the gate is called once with (ls, [..]) and refuses · the answer is the scripted marker',
            fails: [
                { code: 'unbound', symptom: 'session.workspace is null', hint: 'withWorkspace({ workspace }) must receive the handle the manager returned' },
                { code: 'wrong-root', symptom: 'the read result is not under workspace.path', hint: 'createWorkspaceTools roots read/grep/glob at workspace.path' },
                { code: 'leaked', symptom: 'the outside file content appears in a tool message', hint: 'read denials come from confineReal(), which must run before the file is opened' },
                { code: 'ungated', symptom: 'no gate call for `ls ..`', hint: "the shell tool escalates an outside operand to the session's withApproval() callback" },
            ],
            input: { model: 'scripted-36', workspace: 'directory', approval: 'deny' },
        });

        const session = client.session({ model: 'scripted-36', sessionId: SESSION_ID });
        session.eventEmitter = emitter;
        session.withApproval({
            // (toolName, argsObject) for a tool; (command, argv) for the shell.
            fn: (/** @type {unknown[]} */ ...args) => { gateCalls.push([args[0], args[1]]); return false; }
        });
        session.withWorkspace({ workspace });

        const answer = await session.run({ initialInput: `Read notes.txt, then try ../outside.txt, then run ls. Reply ${ANSWER_MARKER}.`, options: { maxIterations: 6 } });
        const messages = toolMessages({ bodies: vendor.bodies });
        const allMessages = messages.join('\n');
        const insideRead = messages[0] ?? '';
        // The last request carries the whole turn: one tool result per scripted call.
        const finalToolResults = toolMessages({ bodies: [vendor.bodies.at(-1) ?? {}] });
        // The wire request names the tools `withWorkspace` bound to this session.
        const wireTools = /** @type {Array<any>} */ (vendor.bodies[0]?.tools ?? []);
        const boundTools = new Set(wireTools.map((tool) => String(tool?.function?.name ?? tool?.name ?? '')));

        audit.observe({ name: 'workspace path', value: workspace.path });
        audit.observe({ name: 'vendor rounds', value: vendor.bodies.length });
        audit.observe({ name: 'gate calls', value: gateCalls });
        audit.check({
            name: 'withWorkspace bound the handle and its context, shell and artifact tools',
            ok: session.workspace === workspace
                && ['read', 'execute_shell_command', 'save_artifact'].every((name) => boundTools.has(name)),
            detail: {
                expected: 'session.workspace === workspace · read, execute_shell_command, save_artifact on the wire',
                observed: `${session.workspace === workspace ? 'the handle' : 'not the handle'} · [${[...boundTools].join(', ')}]`,
            },
        });
        audit.check({
            name: 'the model read the file from the workspace root',
            ok: insideRead.includes(INSIDE_MARKER) && insideRead.includes(`<path>${realpathSync(workspace.path)}`),
            detail: {
                expected: `the read result carries ${INSIDE_MARKER} under <path>${realpathSync(workspace.path)}`,
                observed: insideRead.slice(0, 160),
            },
        });
        audit.check({
            name: 'an outside operand that exists is refused, not silently read',
            ok: allMessages.includes('outside the workspace root') && !allMessages.includes(OUTSIDE_MARKER),
            detail: {
                expected: 'the denial text, and never the outside content',
                observed: `denied ${allMessages.includes('outside the workspace root')} · leaked ${allMessages.includes(OUTSIDE_MARKER)}`,
            },
        });
        audit.check({
            name: 'the shell gate was called with the command and its argv, and said no',
            ok: gateCalls.length === 1
                && gateCalls[0][0] === 'ls'
                && Array.isArray(gateCalls[0][1]) && /** @type {Array<unknown>} */ (gateCalls[0][1]).includes('..')
                && allMessages.includes('Execution denied by user'),
            detail: {
                expected: "one call (ls, [..]) and the tier's refusal",
                observed: `${gateCalls.length} call(s) ${JSON.stringify(gateCalls[0] ?? null)}`,
            },
        });
        audit.check({
            name: 'the scripted turn carried all three tool results',
            ok: finalToolResults.length === 3 && finalToolResults.every((message) => !message.includes('not found')),
            detail: {
                expected: '3 tool results in the turn (one per scripted call), none unanswered',
                observed: `${finalToolResults.length} result(s) · answer ${JSON.stringify(String(answer))}`,
            },
        });
        audit.end();

        // ── B: the todo store is the board ───────────────────────────────────
        audit.scenario({
            id: 'B', title: 'the todo store feeds the scheduler',
            goal: 'createTodoWorkSource maps the SDK todo store and the scheduler dispatches only active todos',
            expect: 'a pending todo is listed with state pending and dispatchable true; a completed todo maps to state completed and dispatchable false · one tick dispatches todo-open once and never todo-done · marking the todo completed empties the next list',
            fails: [
                { code: 'status-map', symptom: 'the completed todo is listed as active', hint: 'rawTodo() maps the status and sets dispatchable from the terminal set' },
                { code: 'snapshot', symptom: 'a finished todo still lists', hint: 'fetchByStates reads the Map on every call' },
                { code: 'redispatch', symptom: 'todo-done is dispatched', hint: 'the caller states are the only filter; completed is not in [pending, in_progress]' },
                { code: 'not-started', symptom: 'tick() rejects with not_started', hint: 'start() runs the first tick; tick() alone is refused' },
            ],
            input: { activeStates: ['pending', 'in_progress'], terminalStates: ['completed', 'failed'] },
        });

        /** @type {Map<string, {id: string, title: string, status: string}>} */
        const todoStore = new Map();
        const todos = new TodoComponent({ store: todoStore });
        // Seeded through the component's public action, never its private store.
        await todos.save({ args: { action: 'add', id: 'todo-open', title: 'Open: write the note' } });
        await todos.save({ args: { action: 'add', id: 'todo-done', title: 'Done: already answered' } });
        await todos.save({ args: { action: 'complete', id: 'todo-done' } });
        const rendered = await todos.load();
        const workSource = createTodoWorkSource({ store: todoStore });
        const listed = workSource.fetchByStates({ states: ['pending', 'in_progress'] });
        const completedRow = workSource.fetchByIds({ ids: ['todo-done'] })[0] ?? null;

        /** @type {string[]} */
        const dispatched = [];
        emitter.on(EVENTS.WORK_ITEM.DISPATCHED, (/** @type {any} */ envelope) => { dispatched.push(String(envelope.identifier)); });
        /** @type {() => void} */
        let ranOnce = () => {};
        const ran = new Promise((resolve) => { ranOnce = () => resolve(undefined); });
        const scheduler = new WorkScheduler({
            workSource,
            workflow: { run: async ({ item }) => { ranOnce(); return { status: 'completed', summary: `ran ${item.identifier}` }; } },
            claims: createMemoryClaimStore(),
            eventEmitter: emitter,
            activeStates: ['pending', 'in_progress'],
            terminalStates: ['completed', 'failed'],
            concurrency: { global: 1 },
            continuation: { max: 0, delayMs: 0 },
            pollIntervalMs: 3_600_000,
            stallTimeoutMs: 0
        });
        active = scheduler;
        await scheduler.start();
        await ran;
        for (let i = 0; i < 200 && !scheduler.snapshot().completed.includes('todo-open'); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const board = scheduler.snapshot();
        await todos.save({ args: { action: 'complete', id: 'todo-open' } });
        const afterFinish = workSource.fetchByStates({ states: ['pending', 'in_progress'] });

        audit.observe({ name: 'listed', value: listed.map((item) => `${item.identifier}:${item.state}:${item.dispatchable}`) });
        audit.observe({ name: 'board', value: { dispatched, completed: board.completed, totals: board.totals } });
        audit.check({
            name: 'the component and the source read one shared Map',
            ok: typeof rendered === 'string'
                && rendered.includes('[ ] id:todo-open') && rendered.includes('[x] id:todo-done')
                && listed.length + (completedRow === null ? 0 : 1) === todoStore.size,
            detail: {
                expected: 'load() renders both seeded rows with their statuses; the source sees the same two',
                observed: `${typeof rendered === 'string' ? rendered.trim().split('\n').length : 0} rendered line(s) · store ${todoStore.size} row(s)`,
            },
        });
        audit.check({
            name: 'the todo source mapped pending and completed to work items',
            ok: listed.length === 1 && listed[0].state === 'pending' && listed[0].dispatchable === true
                && completedRow !== null && completedRow.state === 'completed' && completedRow.dispatchable === false,
            detail: {
                expected: 'pending → dispatchable true · completed → dispatchable false',
                observed: `listed ${listed.map((item) => `${item.identifier}:${item.state}:${item.dispatchable}`).join(',')} · by id ${completedRow === null ? 'none' : `${completedRow.state}:${completedRow.dispatchable}`}`,
            },
        });
        audit.check({
            name: 'the list path filters with the scheduler vocabulary',
            ok: listed.every((item) => item.state === 'pending' || item.state === 'in_progress') && listed.length === 1,
            detail: {
                expected: '1 row for [pending, in_progress]',
                observed: `${listed.length} row(s): ${listed.map((item) => item.identifier).join(',')}`,
            },
        });
        audit.check({
            name: 'one tick dispatched the pending todo once',
            ok: dispatched.join(',') === 'todo-open' && board.totals.dispatches === 1 && board.completed.includes('todo-open'),
            detail: {
                expected: 'dispatched [todo-open] · dispatches 1 · completed [todo-open]',
                observed: `dispatched [${dispatched.join(',')}] · dispatches ${board.totals.dispatches} · completed [${board.completed.join(',')}]`,
            },
        });
        audit.check({
            name: 'the state filter kept the completed todo out',
            ok: !dispatched.includes('todo-done') && !board.completed.includes('todo-done'),
            detail: {
                expected: 'no todo-done anywhere in the dispatch record',
                observed: `dispatched ${dispatched.includes('todo-done')} · completed ${board.completed.includes('todo-done')}`,
            },
        });
        audit.check({
            name: 'the source reads the live store, not a snapshot',
            ok: afterFinish.length === 0,
            detail: {
                expected: '0 rows after the todo was marked completed',
                observed: `${afterFinish.length} row(s)`,
            },
        });
        audit.end();

        // ── C: the ring hears the session only on opt-in ─────────────────────
        audit.scenario({
            id: 'C', title: 'the session joins the operator history',
            goal: 'a shared MerciEventEmitter carries the session run and tool records into createEventRing',
            expect: 'run:start and run:end each once with sessionId · three tool:call_end records carrying the same sessionId, one read success, one read denial, one shell denial · the default prefix ring records none of them · no record keeps tool arguments',
            fails: [
                { code: 'no-onany', symptom: 'the ring threw invalid_emitter', hint: 'createEventRing subscribes through MerciEventEmitter.onAny' },
                { code: 'no-session', symptom: 'records carry no sessionId', hint: 'construct the session with an explicit id, or read the auto-minted run id' },
                { code: 'default-hides', symptom: 'the default ring already had run: records', hint: "run:/tool: are not in DEFAULT_PREFIXES — that is the opt-in the host makes" },
                { code: 'leak-args', symptom: 'a record contains notes.txt', hint: "projectEventRecord's allowlist drops tool arguments" },
            ],
            input: { prefixes: [...DEFAULT_PREFIXES, 'run:', 'tool:'] },
        });

        const records = /** @type {Array<Record<string, unknown>>} */ (optInRing.list());
        const byEvent = (/** @type {string} */ name) => records.filter((record) => record.event === name);
        const runStarts = byEvent(EVENTS.CLIENT.RUN_START);
        const runEnds = byEvent(EVENTS.CLIENT.RUN_END);
        const toolEnds = byEvent(EVENTS.TOOL.CALL_END);
        const pathDenied = byEvent(EVENTS.TOOL.PATH_DENIED);
        const defaultSessionRecords = /** @type {Array<Record<string, unknown>>} */ (defaultRing.list())
            .filter((record) => String(record.event).startsWith('run:') || String(record.event).startsWith('tool:'));

        audit.observe({ name: 'ring events', value: [...new Set(records.map((record) => record.event))] });
        audit.check({
            name: 'the ring holds the session run records with its sessionId',
            ok: runStarts.length === 1 && runEnds.length === 1
                && runStarts[0]?.sessionId === SESSION_ID && runEnds[0]?.sessionId === SESSION_ID,
            detail: {
                expected: `1 run:start + 1 run:end, both ${SESSION_ID}`,
                observed: `${runStarts.length} + ${runEnds.length} · ${String(runStarts[0]?.sessionId)} / ${String(runEnds[0]?.sessionId)}`,
            },
        });
        audit.check({
            name: 'the ring holds the session tool records with the same sessionId',
            ok: toolEnds.length === 3 && toolEnds.every((record) => record.sessionId === SESSION_ID)
                && toolEnds.filter((record) => record.name === 'read' && record.success === true).length === 1
                && toolEnds.filter((record) => record.name === 'read' && record.success === false).length === 1
                && toolEnds.some((record) => record.name === 'execute_shell_command' && record.success === false),
            detail: {
                expected: '3 tool:call_end, all with the sessionId: one read ok, one read denied, one shell denied',
                observed: `${toolEnds.length} records · ${toolEnds.map((record) => `${String(record.name)}:${String(record.success)}`).join(', ')} · path_denied ${pathDenied.length}`,
            },
        });
        const isSessionRecord = /** @param {unknown} record */ (record) => {
            const name = String(/** @type {any} */ (record)?.event ?? '');
            return name.startsWith('run:') || name.startsWith('tool:');
        };
        audit.check({
            name: 'the default prefix set kept every session record out',
            ok: defaultSessionRecords.length === 0
                && defaultRing.list().length > 0
                && records.some(isSessionRecord),
            detail: {
                expected: 'the default ring holds work_item:* records and 0 run:/tool: ones; the opt-in ring holds run:/tool:',
                observed: `default ${defaultRing.list().length} record(s), ${defaultSessionRecords.length} run:/tool: · opt-in ${records.filter(isSessionRecord).length} run:/tool:`,
            },
        });
        audit.check({
            name: 'the ring drops `args` and keeps the denied path',
            ok: !JSON.stringify(records).includes('notes.txt')
                && records.every((record) => !('args' in record) && !('filePath' in record))
                && typeof pathDenied[0]?.path === 'string' && pathDenied[0].path !== '',
            detail: {
                expected: 'no args or filePath on any record, and the path_denied record keeps its path',
                observed: `${records.length} records · path ${typeof pathDenied[0]?.path === 'string' ? 'kept' : 'missing'}`,
            },
        });
        audit.end();

        log.success({ m: 'Reverse seam verified: workspace, todo intake and the ring on a plain session.' });
    } finally {
        optInRing.stop();
        defaultRing.stop();
        if (active !== null) await active.stop().catch(() => {});
    }
}

// The await matters: a truncated log must not exit 0.
try {
    await audit.run(main);
} finally {
    if (active !== null) await active.stop().catch(() => {});
    if (ROOT !== '') await rm(ROOT, { recursive: true, force: true });
}
