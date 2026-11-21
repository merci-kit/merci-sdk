// @ts-check
/**
 * Example 09 — Memory and todos: the persistent agent state.
 *
 * A process restart is normal for an agent; its state must not be. Everything
 * here persists under `scratchpad/examples/` and every recall phase runs in a
 * FRESH instance (new provider, new session, new Map) to prove it:
 *
 *   A — durable memory : `LocalFileMemoryProvider` writes one fact to a JSON
 *       bank on disk.
 *   B — lazy recall    : `withMemory({ options: { preload: false } })` (the
 *       default) registers only the `load_memory`/`save_memory` tools — the
 *       model must pull the fact; `EVENTS.MEMORY.INJECTED` never fires. When
 *       the backend has `client.embed`, the recall also embeds + persists the
 *       fact under `getEmbeddingModel({ provider })` (JAI uses the model-less
 *       embedding service, sized by `getEmbeddingDimensions`); that is asserted,
 *       so a silently dead embedding path fails loudly.
 *   C — preload recall : `withMemory({ options: { preload: true } })` injects
 *       the relevant facts into the step context (`memory:injected`) with no
 *       tool call — the same fresh provider recalls the SAME fact.
 *   D — durable todos  : `withTodos({ store, options: { filePath } })` over a
 *       shared Map; a fresh Map rehydrates the tasks from the same file.
 *
 * Public API: `LocalFileMemoryProvider`, `EVENTS`, `.withMemory`, `.withTodos`.
 *
 * NOTE (JAI backend): Google models there are subject to the platform's
 * built-in content moderation. A blocked response closes the stream with
 * `ContinuousSSEException.PrematureEnd` (docs JBAI-A-1658), which can make the
 * lazy-recall check (B) flaky. The SDK retries and lowers the reasoning effort
 * for the memory path; B additionally retries once in a fresh session and, if
 * the provider still moderates, is recorded as SKIP (never a false fail). For a
 * hard pass use a non-Google model on JAI (e.g. anthropic-claude-4-5-haiku).
 *
 * Run: `node examples/09_memory_and_todos.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    ProviderType, EVENTS, LocalFileMemoryProvider, defaultDisplay, getEmbeddingDimensions, getEmbeddingModel, initializeClient, loadCredentials, log,
} from 'merci-sdk';
import { guardedParse } from 'merci-sdk/json';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const STATE_DIR = join(SCRATCH_DIR, '09-memory-state');
const MEMORY_FILE = join(STATE_DIR, 'memory-bank.json');
const TODO_FILE = join(STATE_DIR, 'todos.json');

const FACT = 'Project Nightfall deploys to the staging runner "blue-orbit" (region eu-central).';
const QUESTION = 'Which deployment target is recorded for project Nightfall?';
const TASKS = ['review the Nightfall release notes', 'book the blue-orbit smoke test'];

/**
 * Read a persisted JSON file through the SDK guard. Persisted state must be
 * rejected when corrupt, not repaired, so healing is off.
 * @param {{filePath: string, fallback?: any}} arg0 -
 * @returns {Promise<any>} the parsed value, the fallback, or a thrown error.
 */
async function readJsonFile({ filePath, fallback }) {
    let text = null;
    try {
        text = await readFile(filePath, 'utf8');
    } catch {
        text = null;
    }
    if (text === null) {
        if (fallback !== undefined) return fallback;
        throw new Error(`cannot read ${filePath}`);
    }
    const parsed = guardedParse({ input: text, options: { heal: false } });
    if (parsed.success) return parsed.data;
    if (fallback !== undefined) return fallback;
    throw new Error(`invalid JSON in ${filePath}: ${parsed.error}`);
}

const LAZY_SYSTEM = 'You are stateless and know nothing unless you load it. Before answering any question about stored project facts you MUST call the `load_memory` tool with a short topic query. Answer only from the tool result; if the result has no matching fact, reply exactly "NO MEMORY".';
const PRELOAD_SYSTEM = 'The stored project facts are already injected into your context in a memory block. Do NOT call any tools. Answer strictly from that block; if the block does not contain the answer, reply exactly "NO MEMORY".';

async function main() {
    const { provider, defaultModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    log.header({ t: `Example 09 — Memory and todos (${provider})` });
    await rm(STATE_DIR, { recursive: true, force: true });
    await mkdir(STATE_DIR, { recursive: true });
    log.option({ name: 'memory.file', value: MEMORY_FILE, source: 'LocalFileMemoryProvider({ options: { filePath } })' });
    log.option({ name: 'todos.file', value: TODO_FILE, source: 'withTodos({ options: { filePath } })' });
    const embeddingModel = getEmbeddingModel({ provider });
    const embeddingDimensions = getEmbeddingDimensions({ provider });
    log.option({ name: 'memory.embeddingModel', value: embeddingModel || (embeddingDimensions ? `(fixed server-side model, ${embeddingDimensions}-dim)` : '(none)'), source: 'getEmbeddingModel({ provider }) — DEFAULT_<PROVIDER>_EMBEDDING_MODEL' });
    const vectorTierActive = typeof client.embed === 'function' && provider !== ProviderType.OPENCODE;

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // ── A: a completed process persisted one fact ────────────────────────────
    log.section({ t: 'A — seed: one fact persisted to a JSON bank' });
    const seedProvider = new LocalFileMemoryProvider({ options: {
        filePath: MEMORY_FILE, name: 'nightfall', description: 'facts about project Nightfall',
    } });
    await seedProvider.store({ content: FACT, category: 'project' });
    const bank = await readJsonFile({ filePath: MEMORY_FILE });
    log.event({ type: 'memory bank written', payload: { facts: bank.facts?.length, version: bank.version } });
    check({
        name: 'A: the fact is on disk',
        ok: bank.facts?.length === 1 && String(bank.facts[0].content).includes('blue-orbit'),
        detail: `${bank.facts?.length ?? 0} fact(s)`,
    });

    // ── B/C: lazy vs preloaded recall in a fresh provider each time ──────────
    let injected = 0;
    client.on(EVENTS.MEMORY.INJECTED, (/** @type {any} */ e) => {
        injected++;
        log.event({ type: EVENTS.MEMORY.INJECTED, payload: { factCount: e.factCount } });
    });
    let loadCalls = 0;
    const countMemoryTools = (/** @type {any} */ e) => {
        if (e?.name !== 'load_memory') return;
        if (e.type === 'tool_call_start') loadCalls++;
        else if (e.type === 'tool_call_end') log.toolResult({ n: 'load_memory', r: e.result });
    };

    log.section({ t: 'B — lazy recall (preload: false): the model pulls via load_memory' });
    const runLazyRecall = async () => {
        injected = 0;
        loadCalls = 0;
        const provider = new LocalFileMemoryProvider({ options: { filePath: MEMORY_FILE } });
        const session = client.session(defaultModel)
            .withMemory({ provider, options: { preload: false } })
            .withSystemMessage(LAZY_SYSTEM)
            .withExecute({ options: { rules: { task: 'deny' } } });
        return String(await session.run({ initialInput: QUESTION, options: { ...defaultDisplay({ also: countMemoryTools }), maxConsecutiveEmpty: 4 } }));
    };
    /** @param {string} answer */
    const providerIncomplete = (answer) => /content moderation|truncated by the model|PrematureEnd/i.test(answer);
    log.user({ m: QUESTION });
    let lazyAnswer = await runLazyRecall();
    let lazyIncomplete = providerIncomplete(lazyAnswer);
    if (lazyIncomplete) {
        // JAI Google models intermittently close the synthesis stream (PrematureEnd, JBAI-A-1658)
        // or return a partial answer marked as a length limit. A fresh session often clears it —
        // retry once, then SKIP rather than report a false product failure.
        log.event({ type: 'lazy recall retry', payload: { reason: 'provider incomplete response (JBAI-A-1658)' } });
        lazyAnswer = await runLazyRecall();
        lazyIncomplete = providerIncomplete(lazyAnswer);
    }
    warnEmptyAnswer({ answer: lazyAnswer, label: 'the lazy recall' });
    check({ name: 'B: the model called load_memory', ok: loadCalls >= 1, detail: `calls=${loadCalls}` });
    check({ name: 'B: no memory block was injected', ok: injected === 0, detail: `memory:injected=${injected}` });
    check({
        name: 'B: the answer recalls the persisted fact',
        ok: lazyIncomplete || /blue-orbit/i.test(lazyAnswer),
        detail: lazyIncomplete
            ? 'SKIP: JAI provider moderation/truncation stopped the synthesis (JBAI-A-1658) — set a non-Google DEFAULT_JAI_MODEL for a hard check'
            : log.truncate({ text: lazyAnswer, n: 120 }),
    });
    if (vectorTierActive) {
        const bankAfterB = await readJsonFile({ filePath: MEMORY_FILE });
        const vector = bankAfterB.facts?.[0]?.embedding;
        check({
            name: 'B: the vector tier embedded + persisted the fact',
            ok: Array.isArray(vector) && vector.length > 0,
            detail: `${embeddingModel ? `model=${embeddingModel}` : `embedding/${embeddingDimensions}d`} dim=${Array.isArray(vector) ? vector.length : 0}`,
        });
    } else {
        log.event({ type: 'vector tier skipped', payload: { provider, reason: 'client.embed unavailable' } });
    }

    log.section({ t: 'C — preload recall (preload: true): the fact is injected, no tool call' });
    injected = 0;
    loadCalls = 0;
    const preloadProvider = new LocalFileMemoryProvider({ options: { filePath: MEMORY_FILE } });
    const preloadSession = client.session(defaultModel)
        .withMemory({ provider: preloadProvider, options: { preload: true } })
        .withSystemMessage(PRELOAD_SYSTEM)
        .withExecute({ options: { rules: { task: 'deny' } } });
    /** @returns {Promise<string>} */
    const runPreloadRecall = async () => String(await preloadSession.run({ initialInput: QUESTION, options: { ...defaultDisplay({ also: countMemoryTools }), maxConsecutiveEmpty: 4 } }));
    log.user({ m: QUESTION });
    let preloadAnswer = await runPreloadRecall();
    let preloadIncomplete = providerIncomplete(preloadAnswer);
    if (preloadIncomplete) {
        log.event({ type: 'preload recall retry', payload: { reason: 'provider incomplete response (JBAI-A-1658)' } });
        preloadAnswer = await runPreloadRecall();
        preloadIncomplete = providerIncomplete(preloadAnswer);
    }
    warnEmptyAnswer({ answer: preloadAnswer, label: 'the preload recall' });
    check({ name: 'C: the memory block was injected', ok: injected >= 1, detail: `memory:injected=${injected}` });
    check({
        name: 'C: the answer recalls the persisted fact',
        ok: preloadIncomplete || /blue-orbit/i.test(preloadAnswer),
        detail: preloadIncomplete
            ? 'SKIP: JAI provider moderation/truncation stopped the synthesis (JBAI-A-1658) — set a non-Google DEFAULT_JAI_MODEL for a hard check'
            : log.truncate({ text: preloadAnswer, n: 120 }),
    });

    // ── D: todos in a shared Map, rehydrated from the same file ──────────────
    log.section({ t: 'D — todos: shared Map store + filePath rehydration' });
    const todoStore = new Map();
    const todoSession = client.session(defaultModel)
        .withTodos({ store: todoStore, options: { filePath: TODO_FILE } })
        .withSystemMessage('You manage a task list. When asked to add tasks, call manage_todos once per task with action "add". Confirm in one short line.')
        .withExecute({ options: { rules: { task: 'deny' } } });
    log.user({ m: `Add two tasks: "${TASKS[0]}", "${TASKS[1]}"` });
    const todoAnswer = String(await todoSession.run({ initialInput: `Add these two tasks to my list: "${TASKS[0]}" and "${TASKS[1]}".`, options: { ...defaultDisplay(), maxConsecutiveEmpty: 4 } }));
    warnEmptyAnswer({ answer: todoAnswer, label: 'the todo add' });
    const todoFile = await readJsonFile({ filePath: TODO_FILE, fallback: {} });
    check({
        name: 'D: both tasks reached the shared Map and the file',
        ok: todoStore.size === 2 && todoFile.tasks?.length === 2,
        detail: `store=${todoStore.size} file=${todoFile.tasks?.length ?? 0}`,
    });

    const revived = new Map();
    const revivedSession = client.session(defaultModel)
        .withTodos({ store: revived, options: { filePath: TODO_FILE } })
        .withSystemMessage('Answer from the active task list in your context. Do not call any tools.')
        .withExecute({ options: { rules: { task: 'deny' } } });
    log.user({ m: 'List my open tasks, one per line.' });
    const revivedAnswer = String(await revivedSession.run({ initialInput: 'List my open tasks, one per line.', options: { ...defaultDisplay(), maxConsecutiveEmpty: 4 } }));
    warnEmptyAnswer({ answer: revivedAnswer, label: 'the revived session' });
    check({ name: 'D: a fresh Map rehydrated from the file', ok: revived.size === 2, detail: `tasks=${revived.size}` });
    check({
        name: 'D: the fresh session sees both tasks',
        ok: revivedAnswer.includes('release notes') && revivedAnswer.includes('smoke test'),
        detail: log.truncate({ text: revivedAnswer, n: 120 }),
    });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'Every fresh instance recalled the persisted state.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
