// @ts-check
/**
 * Example 20 — A crash mid-run, resumed exactly once.
 *
 * A release agent works one live deployment turn, then the process dies. The
 * next process knows nothing except what is on disk under
 * `scratchpad/examples/20-durability/`: the conversation checkpoint and the
 * execution journal that records what already happened.
 *
 *   A — the live turn     : a real model calls `deploy_release`, a tool whose
 *       execute() appends one line to a ledger file, inside a session bound to
 *       a `LocalFileSessionStore` and an `ExecutionJournal`.
 *   B — a tagged checkpoint : `saveCheckpoint`/`restoreCheckpoint` round-trip
 *       a payload under `CHECKPOINT_KIND`; asking for the wrong kind throws,
 *       so a resume cannot mistake another engine's record for its own.
 *   C — the crash         : a NEW session on the same thread id restores the
 *       transcript with `loadCheckpoint()`; the deploy is re-issued at its
 *       recorded boundary with the restored journal and REPLAYS — the ledger
 *       keeps exactly one line.
 *   D — interrupted work  : a row left in `JOURNAL_STATUS.INTENT` (the process
 *       died mid-call) fails closed for a non-idempotent tool; only a tool
 *       that declares `idempotent: true` is re-run.
 *   E — the fork          : `forkCheckpoint` branches the thread; the branch
 *       takes its own turn and the source history does not move.
 *
 * What this shows:
 *   - at-most-once side effects across a process restart
 *   - `withSessionStore` + `withExecutionJournal` on one session
 *   - `toolJournalKey` as the identity a replay is matched on
 *   - `forkCheckpoint` as the branch point for a second attempt
 *
 * Run: `node examples/20_durability.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CHECKPOINT_KIND, ConfigurationError, ExecutionJournal, JOURNAL_STATUS, LocalFileSessionStore,
    createUserMessage, defaultDisplay, initializeClient, loadCredentials, log,
    restoreCheckpoint, saveCheckpoint, toolJournalKey,
} from 'merci-sdk';
import { executeTools } from 'merci-sdk/tools';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const RUN_DIR = join(SCRATCH_DIR, '20-durability');
const STORE_DIR = join(RUN_DIR, 'sessions');
const LEDGER = join(RUN_DIR, 'deploy-ledger.jsonl');
const THREAD = 'release-42';
const NOTE_THREAD = 'release-42-note';
const FORK_THREAD = 'release-42-rollback';
const MARKER = 'RELEASE-42-READY';
const ROLLBACK_MARKER = 'ROLLBACK-PLANNED';
const DEPLOY_PROMPT = `Deploy this release to staging: call deploy_release exactly once with environment "staging". Then reply with exactly: ${MARKER}`;
const ROLLBACK_PROMPT = `A rollback is being considered for the same release. Reply with exactly: ${ROLLBACK_MARKER}`;

/**
 * A deployment step whose execute() performs a REAL side effect: one appended
 * line in the ledger file. Any re-run is therefore visible on disk.
 * @param {{ledgerPath: string, counter: {n: number}, idempotent?: boolean}} arg0
 */
function deployTool({ ledgerPath, counter, idempotent = false }) {
    return {
        name: 'deploy_release',
        description: 'Deploys the current release to one environment and appends the deployment to the ledger file. Performs a real side effect.',
        parameters: {
            type: 'object',
            properties: { environment: { type: 'string', description: 'Target environment, e.g. staging.' } },
            required: ['environment'],
        },
        idempotent,
        /** @param {{args?: {environment?: string}}} arg0 */
        execute: async ({ args = {} }) => {
            const environment = String(args.environment ?? 'staging');
            counter.n += 1;
            const deployment = `dep-${counter.n}`;
            await appendFile(ledgerPath, `${JSON.stringify({ deployment, environment, at: new Date().toISOString() })}\n`, 'utf8');
            return JSON.stringify({ deployment, environment, ledgerLines: await ledgerLines({ filePath: ledgerPath }) });
        },
    };
}

/**
 * The number of committed side effects, read back from disk.
 * @param {{filePath: string}} arg0
 * @returns {Promise<number>}
 */
async function ledgerLines({ filePath }) {
    const text = await readFile(filePath, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).length;
}

/**
 * Builds the tool call a resumed process would re-issue.
 * @param {{args: Record<string, any>, id?: string}} arg0
 */
function deployCall({ args, id = 'call-deploy' }) {
    return { id, name: 'deploy_release', arguments: JSON.stringify(args) };
}

/**
 * Runs an action and reports what it threw, so a fail-closed branch is visible
 * instead of ending the example.
 * @param {{fn: () => Promise<any>}} arg0
 * @returns {Promise<{threw: boolean, error: any}>}
 */
async function attempt({ fn }) {
    try {
        await fn();
        return { threw: false, error: null };
    } catch (error) {
        return { threw: true, error };
    }
}

async function main() {
    const { provider, toolModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    log.header({ t: `Example 20 — Durability: a crash, resumed exactly once (${provider})` });
    await rm(RUN_DIR, { recursive: true, force: true });
    await mkdir(STORE_DIR, { recursive: true });

    const store = new LocalFileSessionStore({ dir: STORE_DIR });
    log.option({ name: 'store.dir', value: STORE_DIR, source: 'new LocalFileSessionStore({ dir })' });
    log.option({ name: 'thread', value: THREAD, source: 'withSessionStore({ store, threadId })' });
    log.option({ name: 'ledger', value: LEDGER, source: 'deploy_release appends one line per real execution' });
    log.option({ name: 'model', value: toolModel, source: 'resolveExample().toolModel' });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // ── A: the live turn, journaled ─────────────────────────────────────────
    log.section({ t: 'A — the live turn: one deploy, journaled' });
    const journal = new ExecutionJournal({ runId: 'jrn_release_42' });
    log.option({ name: 'journal.runId', value: journal.runId, source: "new ExecutionJournal({ runId }) — fixed, so the keys printed below stay readable" });
    const counter = { n: 0 };
    const session = client.session(toolModel)
        .withSessionStore({ store, threadId: THREAD })
        .withExecutionJournal({ journal })
        .withTools({ tools: [deployTool({ ledgerPath: LEDGER, counter })] })
        .withSystemMessage('You are a release agent. Use the tools you are given; do not describe what you would do instead of doing it.');
    log.user({ m: DEPLOY_PROMPT });
    const answer = String(await session.run({ initialInput: DEPLOY_PROMPT, options: { ...defaultDisplay(), maxIterations: 4 } }));
    warnEmptyAnswer({ answer, label: 'the live deploy turn' });
    await session.saveCheckpoint();

    const deployRow = journal.entries().find((row) => row.name === 'deploy_release' && row.status === JOURNAL_STATUS.DONE);
    check({ name: 'A: the model deployed through the journaled tool', ok: counter.n >= 1, detail: `executions=${counter.n}` });
    check({ name: 'A: the side effect is on disk', ok: (await ledgerLines({ filePath: LEDGER })) === counter.n, detail: `${await ledgerLines({ filePath: LEDGER })} ledger line(s)` });
    check({ name: 'A: the answer carries the forced marker', ok: answer.includes(MARKER), detail: log.truncate({ text: answer, n: 120 }) });
    check({ name: 'A: the journal holds a DONE row for the deploy', ok: Boolean(deployRow), detail: deployRow ? `key=${deployRow.key} boundary=${String(deployRow.boundary)}` : 'no DONE row' });
    if (!deployRow) throw new Error('the model never called deploy_release — the resume scene needs a journaled side effect');
    log.option({ name: 'journal.boundary', value: String(deployRow.boundary), source: 'the committed boundary of the live tool call' });

    // ── B: a tagged checkpoint round-trips ──────────────────────────────────
    log.section({ t: 'B — a tagged checkpoint round-trips, a wrong kind is refused' });
    const note = JSON.stringify({ next: 'verify staging', ledgerLines: await ledgerLines({ filePath: LEDGER }) });
    log.option({ name: 'note.thread', value: NOTE_THREAD, source: 'saveCheckpoint({ store, threadId, kind, payload })' });
    await saveCheckpoint({ store, threadId: NOTE_THREAD, kind: CHECKPOINT_KIND.CHAT, payload: note });
    const savedNote = await store.load(NOTE_THREAD);
    const restoredNote = restoreCheckpoint({ saved: savedNote, kind: CHECKPOINT_KIND.CHAT });
    const mismatch = await attempt({ fn: async () => restoreCheckpoint({ saved: savedNote, kind: CHECKPOINT_KIND.WORKFLOW, args: [{}] }) });
    check({ name: 'B: a checkpoint of the same kind restores its payload', ok: restoredNote === note, detail: log.truncate({ text: String(restoredNote), n: 60 }) });
    check({
        name: 'B: the wrong kind throws a typed error, it does not read as "no checkpoint"',
        ok: mismatch.threw && mismatch.error instanceof ConfigurationError && /kind mismatch/i.test(String(mismatch.error?.message)),
        detail: mismatch.threw ? String(mismatch.error?.message).slice(0, 100) : 'no error thrown',
    });

    // ── C: the crash, and a replay instead of a second deploy ───────────────
    log.section({ t: 'C — the crash: a fresh session replays, it does not re-run' });
    const resumed = client.session(toolModel)
        .withSessionStore({ store, threadId: THREAD })
        .withSystemMessage('You are a release agent resuming after a restart.');
    const checkpoint = /** @type {any} */ (await resumed.loadCheckpoint());
    const history = Array.isArray(checkpoint?.messages) ? [...checkpoint.messages] : [];
    const restoredJournal = ExecutionJournal.fromJSON(checkpoint?.journal);
    const args = /** @type {Record<string, any>} */ (deployRow.args ?? { environment: 'staging' });
    const boundary = /** @type {string|number} */ (deployRow.boundary);
    const key = toolJournalKey({ runId: restoredJournal.runId, boundary, name: 'deploy_release', args });
    log.option({ name: 'resume.key', value: key, source: 'toolJournalKey({ runId, boundary, name, args })' });
    check({ name: 'C: the transcript came back from disk', ok: history.length > 1, detail: `${history.length} message(s), journal rows=${restoredJournal.entries().length}` });
    check({ name: 'C: the recorded key matches the restored journal', ok: restoredJournal.get({ key })?.status === JOURNAL_STATUS.DONE, detail: `status=${String(restoredJournal.get({ key })?.status)}` });

    const linesBeforeReplay = await ledgerLines({ filePath: LEDGER });
    const replay = /** @type {any} */ ((await executeTools({
        toolCalls: [deployCall({ args, id: 'call-deploy-replay' })],
        toolLibrary: [deployTool({ ledgerPath: LEDGER, counter: { n: counter.n } })],
        journal: restoredJournal,
        boundary,
    }))[0]);
    const linesAfterReplay = await ledgerLines({ filePath: LEDGER });
    log.event({ type: 'resumed tool call', payload: { replayed: replay.replayed, result: replay.result } });
    check({ name: 'C: the resumed call replayed the recorded result', ok: replay.replayed === true, detail: `replayed=${String(replay.replayed)}` });
    check({ name: 'C: the ledger did not grow', ok: linesAfterReplay === linesBeforeReplay, detail: `${linesBeforeReplay} → ${linesAfterReplay} line(s)` });

    // ── D: an interrupted call fails closed ─────────────────────────────────
    log.section({ t: 'D — interrupted work fails closed' });
    const crashedJournal = new ExecutionJournal({ runId: 'jrn_release_42' });
    const crashBoundary = 'release-turn-2';
    const crashArgs = { environment: 'production' };
    const crashKey = toolJournalKey({ runId: crashedJournal.runId, boundary: crashBoundary, name: 'deploy_release', args: crashArgs });
    const intent = crashedJournal.begin({ key: crashKey, meta: { kind: 'tool', name: 'deploy_release', boundary: crashBoundary, args: crashArgs } });
    log.option({ name: 'crashed.key', value: crashKey, source: "journal.begin() — the INTENT row a killed process leaves behind" });
    const linesBeforeIntent = await ledgerLines({ filePath: LEDGER });
    const blocked = /** @type {any} */ ((await executeTools({
        toolCalls: [deployCall({ args: crashArgs, id: 'call-crashed' })],
        toolLibrary: [deployTool({ ledgerPath: LEDGER, counter: { n: 0 } })],
        journal: crashedJournal,
        boundary: crashBoundary,
    }))[0]);
    check({ name: 'D: the crash left an INTENT row', ok: intent.status === JOURNAL_STATUS.INTENT, detail: `status=${String(intent.status)}` });
    check({
        name: 'D: the non-idempotent tool refused to re-run',
        ok: blocked.success === false && /state is unknown/i.test(String(blocked.error)) && (await ledgerLines({ filePath: LEDGER })) === linesBeforeIntent,
        detail: String(blocked.error),
    });
    const idemCounter = { n: 0 };
    const idem = /** @type {any} */ ((await executeTools({
        toolCalls: [deployCall({ args: crashArgs, id: 'call-crashed-idempotent' })],
        toolLibrary: [deployTool({ ledgerPath: LEDGER, counter: idemCounter, idempotent: true })],
        journal: crashedJournal,
        boundary: crashBoundary,
    }))[0]);
    check({ name: 'D: a tool that declares idempotent is re-run', ok: idem.success === true && idemCounter.n === 1, detail: `executions=${idemCounter.n}` });

    // ── E: the fork takes its own turn ──────────────────────────────────────
    log.section({ t: 'E — fork: the branch and the source diverge' });
    const branch = /** @type {any} */ (await resumed.forkCheckpoint({ newThreadId: FORK_THREAD }));
    log.option({ name: 'fork.thread', value: FORK_THREAD, source: 'forkCheckpoint({ newThreadId })' });
    check({
        name: 'E: the branch holds the original transcript',
        ok: Array.isArray(branch?.messages) && branch.messages.length === history.length,
        detail: `${branch?.messages?.length ?? 0} message(s)`,
    });
    const branchSession = client.session(toolModel)
        .withSessionStore({ store, threadId: FORK_THREAD })
        .withSystemMessage('You are a terse release assistant. Answer with exactly what is asked.');
    const branchCheckpoint = /** @type {any} */ (await branchSession.loadCheckpoint());
    const branchHistory = Array.isArray(branchCheckpoint?.messages) ? [...branchCheckpoint.messages] : [];
    branchHistory.push(createUserMessage({ provider, content: ROLLBACK_PROMPT }));
    log.user({ m: ROLLBACK_PROMPT });
    const branchAnswer = String(await branchSession.run({ initialInput: branchHistory, options: { ...defaultDisplay(), maxIterations: 2 } }));
    warnEmptyAnswer({ answer: branchAnswer, label: 'the branch turn' });
    await branchSession.saveCheckpoint();
    const branchAfter = /** @type {any} */ (await store.load(FORK_THREAD));
    const sourceAfter = /** @type {any} */ (await store.load(THREAD));
    check({
        name: 'E: the branch answered on its own history',
        ok: branchAnswer.includes(ROLLBACK_MARKER) && (branchAfter?.messages?.length ?? 0) > history.length,
        detail: `${branchAfter?.messages?.length ?? 0} > ${history.length} message(s)`,
    });
    check({
        name: 'E: the source thread did not move',
        ok: sourceAfter?.messages?.length === history.length,
        detail: `${sourceAfter?.messages?.length ?? 0} message(s)`,
    });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'The crash resumed exactly once: one deploy, one ledger line.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
