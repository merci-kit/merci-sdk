// @ts-check
/**
 * Example 07 — The agent loop: staged follow-ups, abort, budget, limits, in-flight input.
 *
 * `session.run(...)` is the loop a developer ships: the session owns the
 * iteration budget and drains the same `step()` stream a manual loop would.
 * An analyst reads a quarter of numbers and every knob below is one call:
 *
 *   A — tools + staged follow-ups : `.withTools(...)` gives the loop a real
 *       tool; `options.followUp` turns the first answer into a review round (a
 *       fresh iteration budget for the model) while `defaultDisplay({ also })`
 *       renders deltas and your own hook records telemetry.
 *   B — abort                    : `options.signal` stops an in-flight run; the
 *       caller sees an abort-shaped error and the client emits `aborted`.
 *   C — budget                   : `.withBudget({ budget: { maxTotalTokens } })`
 *       refuses a run whose prompt alone would blow the cap — before the call.
 *   D — streamed input           : `initialInput` may be an ASYNC ITERABLE —
 *       every chunk becomes the next user turn of the SAME conversation, the
 *       conversation accumulates, and the LAST turn's answer comes back.
 *   E — money budget             : `.withBudget({ budget: { maxBudgetUsd } })`
 *       caps the cost the provider reported. A backend that reports no cost
 *       cannot be capped: the run announces `run:budget_unreported` and
 *       continues — the token budget governs.
 *   F — limits                   : `getLimits()` reports the value, source and
 *       default of every bounded number, `setLimits()`/`resetLimits()` change
 *       one, and a tool built AFTER the change picks it up because nothing is
 *       captured at import. `LIMIT_DEFAULTS` is the catalog.
 *   G — in-flight input          : `session.enqueueInput({ input, delivery })`
 *       takes a message the user submitted WHILE the turn was running. A
 *       `steer` row (the default) joins that turn at its next step boundary; a
 *       `queue` row starts the next turn of the SAME run, so it is answered
 *       before `run()` returns — the caller may never run again.
 *       `getPendingInputs()`, `cancelInput()` and `setInputDelivery()` are the
 *       queue panel a host renders beside the composer.
 *   H — a streamed run           : the same rule when `initialInput` is an async
 *       iterable — a message sent between chunks rides the next chunk's turn,
 *       and one sent after the last chunk still gets a turn before `run()`
 *       resolves. `maxInboxTurns` caps how many such turns one run may add.
 *   I — the queue of record      : `drainInbox()` runs the queue with no
 *       invented prompt (one queued message per turn, one answer per message),
 *       `withInboxStore({ store })` makes it durable (a message queued before a
 *       restart is replayed by the next session), the store's lease keeps two
 *       workers off one thread, and `hasLiveBackgroundWork()` /
 *       `waitForBackgroundWork()` are the subagent gate.
 *
 *
 * Public API: `client.session(model).withSystemMessage(...).withTools(...)`
 * `.withBudget(...)`, `session.run({ initialInput, options })`,
 * `session.enqueueInput({ input, delivery })`, `session.getPendingInputs()`,
 * `session.cancelInput({ input })`, `session.setInputDelivery({ input, delivery })`,
 * `session.drainInbox()`, `session.isRunning()`, `session.hasLiveBackgroundWork()`,
 * `session.waitForBackgroundWork()`, `LocalFileInboxStore`,
 * `defaultDisplay`, `getLimits`, `setLimits`, `resetLimits`, `LIMIT_DEFAULTS`,
 * `EVENTS` (`run:budget_exceeded`, `run:budget_unreported`), `BudgetExceededError`,
 * `isAbortError`, `countConversationTurns`.
 *
 * Run: `node examples/07_agent_loop.mjs`
 * Needs: `PROVIDER` plus its key in `secret.env`.
 *
 * @version 0.23.0
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    BudgetExceededError, EVENTS, LIMIT_DEFAULTS, LocalFileInboxStore, countConversationTurns,
    defaultDisplay, getLimits, initializeClient, isAbortError, loadCredentials, log, resetLimits, setLimits,
} from 'merci-sdk';
import { createShellTool } from 'merci-sdk/tools';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';
import { resolveExample, reportUsage, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const PROMPT = 'Convert 120 EUR to USD with the convert_currency tool, then state the final amount in USD.';

/** Fixed demo rates — the tool is real code the loop executes, not a stub LLM. */
const RATES = /** @type {Record<string, number>} */ ({ 'EUR->USD': 1.1, 'USD->EUR': 0.9091 });

/** A plain tool. The SDK calls `execute({ args, signal, context })`. */
const convertCurrency = {
    name: 'convert_currency',
    description: 'Convert an amount between two currencies using fixed demo rates.',
    parameters: {
        type: 'object',
        properties: {
            amount: { type: 'number' },
            from: { type: 'string' },
            to: { type: 'string' },
        },
        required: ['amount', 'from', 'to'],
    },
    /** @param {{args: {amount: number, from: string, to: string}}} arg0 */
    async execute({ args }) {
        const pair = `${String(args.from).toUpperCase()}->${String(args.to).toUpperCase()}`;
        const rate = RATES[pair];
        if (!rate) return `No demo rate for ${pair}.`;
        const [from, to] = pair.split('->');
        return `${args.amount} ${from} = ${(args.amount * rate).toFixed(2)} ${to}`;
    },
};

let checks = 0, failures = 0;
/** @param {{name: string, ok: boolean, detail?: string}} arg0 */
function check({ name, ok, detail }) {
    checks += 1;
    if (!ok) failures += 1;
    log.check({ name, passed: ok, detail });
}

/**
 * The streamed input: an async iterable whose every chunk becomes the next
 * user turn of the same conversation.
 * @param {{chunks: string[]}} arg0 - the chunks to feed, in order.
 * @returns {AsyncGenerator<string, void, unknown>} one chunk per pull.
 */
async function* chunkFeed({ chunks }) {
    for (const chunk of chunks) yield chunk;
}

async function main() {
    const { provider, defaultModel } = resolveExample();
    log.header({ t: `Example 07 — Agent loop (${provider})` });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });
    log.option({ name: 'model', value: defaultModel, source: 'resolveExample() — the brain tier' });
    log.option({ name: 'followUp', value: '1 review round', source: 'run({ options: { followUp } })' });
    log.option({ name: 'budget', value: 'maxTotalTokens 8 / 50 000 · maxBudgetUsd 0.000001', source: 'withBudget({ budget })' });
    log.option({ name: 'streamedInput', value: '3 chunks', source: 'run({ initialInput: asyncIterable })' });
    log.option({ name: 'inFlightInput', value: 'steer (default) · queue', source: 'session.enqueueInput({ input, delivery })' });
    log.option({ name: 'limits', value: 'getLimits() · setLimits() · resetLimits()', source: 'LIMIT_DEFAULTS is the catalog' });

    /** @type {string|null} */
    let lastFinishReason = null;
    client.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => { lastFinishReason = e?.finishReason ?? null; });

    // ── A · tools + a staged review round ────────────────────────────────────
    log.section({ t: 'A — run(): tools + a staged review round' });
    /** @type {string[]} */
    const toolNames = [];
    let stagedRounds = 0;
    let followUpCalls = 0;
    const display = defaultDisplay({ also: (/** @type {any} */ e) => { if (e?.type === 'tool_call_start') toolNames.push(e.name); } });

    /** @param {{round: number, content: string}} arg0 */
    const followUp = async ({ round, content }) => {
        followUpCalls += 1;
        if (round >= 1) return null;
        stagedRounds += 1;
        return `Double-check the exchange-rate arithmetic and restate only the final amount (draft: ${String(content).slice(0, 60)}).`;
    };

    const session = client.session(defaultModel)
        .withSystemMessage('You are a meticulous currency assistant. Use convert_currency for every conversion.')
        .withTools({ tools: [convertCurrency] })
        .withBudget({ budget: { maxTotalTokens: 50_000 } });

    log.user({ m: PROMPT });
    const answer = await session.run({ initialInput: PROMPT, options: { maxIterations: 5, followUp, onEvent: display.onEvent } });
    warnEmptyAnswer({ answer, label: 'the agent loop' });
    check({ name: 'the model called the tool', ok: toolNames.includes('convert_currency'), detail: `calls=[${toolNames.join(', ')}]` });
    check({ name: 'followUp staged exactly one review round', ok: stagedRounds === 1, detail: `stagedRounds=${stagedRounds} followUpCalls=${followUpCalls}` });
    check({ name: 'run finished with stop', ok: lastFinishReason === 'stop', detail: `finishReason=${lastFinishReason}` });
    check({ name: 'a final answer was returned', ok: answer.trim().length > 0, detail: `${answer.trim().length} chars` });

    // ── B · abort mid-stream ─────────────────────────────────────────────────
    log.section({ t: 'B — options.signal: abort an in-flight run' });
    const ac = new AbortController();
    let abortedSeen = false;
    let streamedBeforeAbort = 0;
    client.once(EVENTS.CLIENT.ABORTED, () => { abortedSeen = true; });
    const stopping = defaultDisplay({ also: (/** @type {any} */ e) => {
        if (!ac.signal.aborted && (e.type === 'text' || e.type === 'thought')) {
            streamedBeforeAbort += 1;
            ac.abort(new Error('operator pressed stop'));
        }
    }});

    lastFinishReason = null;
    /** @type {any} */
    let abortErr = null;
    try {
        await client.session(defaultModel)
            .withSystemMessage('Be exhaustively verbose.')
            .run({ initialInput: 'Count from 1 to 300, one number per line, no commentary.', options: { maxIterations: 3, signal: ac.signal, onEvent: stopping.onEvent } });
    } catch (err) { abortErr = err; }
    check({ name: 'the abort interrupted an in-flight stream', ok: streamedBeforeAbort > 0, detail: `events before abort=${streamedBeforeAbort}` });
    check({ name: 'the caller sees an abort-shaped error', ok: isAbortError({ err: abortErr }), detail: `err=${abortErr?.name ?? 'none'}: ${log.truncate({ text: String(abortErr?.message ?? 'run completed before the abort landed'), n: 80 })}` });
    check({ name: 'the client emitted `aborted`', ok: abortedSeen, detail: `aborted=${abortedSeen}` });
    check({ name: 'run:end reports aborted', ok: lastFinishReason === 'aborted', detail: `finishReason=${lastFinishReason}` });

    // ── C · budget: fail fast, before paying for the call ────────────────────
    log.section({ t: 'C — withBudget: refuse a run that would exceed the cap' });
    /** @type {any} */
    let budgetEvent = null;
    client.on(EVENTS.CLIENT.BUDGET_EXCEEDED, (/** @type {any} */ e) => { budgetEvent = e; });
    /** @type {any} */
    let budgetErr = null;
    try {
        await client.session(defaultModel)
            .withSystemMessage('You are a terse assistant.')
            .withBudget({ budget: { maxTotalTokens: 8 } })
            .run({ initialInput: 'Explain superposition, entanglement and decoherence in detail.', options: { maxIterations: 2 } });
    } catch (err) { budgetErr = err; }
    check({ name: 'BudgetExceededError names the cap', ok: budgetErr instanceof BudgetExceededError && budgetErr?.maxTotalTokens === 8, detail: `err=${budgetErr?.name ?? 'none'} maxTotalTokens=${budgetErr?.maxTotalTokens}` });
    check({ name: 'run:budget_exceeded fired before any API call', ok: Boolean(budgetEvent) && budgetEvent?.usage?.estimated === true, detail: `estimated=${budgetEvent?.usage?.estimated} total_tokens=${budgetEvent?.usage?.total_tokens}` });

    // ── D · streamed input: the async iterable becomes the user turns ────────
    log.section({ t: 'D — initialInput as an async iterable: three chunks, one conversation' });

    /** Every request the SDK sent during the section — the public wire view. */
    /** @type {Array<Array<any>>} */
    const sentRequests = [];
    /** @type {Map<string, string>} */
    const answersByRun = new Map();
    // The wire body names its rows per provider: GAI sends `contents`, the
    // OpenAI-shaped backends send `messages`. Both are the same conversation.
    const onRequest = (/** @type {any} */ e) => {
        const rows = e?.payload?.contents ?? e?.payload?.messages ?? e?.contents ?? e?.messages;
        if (Array.isArray(rows)) sentRequests.push(rows);
    };
    const onText = (/** @type {any} */ e) => {
        if (e?.type === EVENTS.STEP.RESTART) { answersByRun.set(String(e.runId ?? ''), ''); return; }
        if (e?.type !== EVENTS.STEP.TEXT) return;
        const run = String(e.runId ?? '');
        answersByRun.set(run, (answersByRun.get(run) ?? '') + String(e.content ?? ''));
    };
    client.on(EVENTS.CLIENT.API_REQUEST, onRequest);

    const CHUNKS = ['Reply with one word: apple.', 'Reply with one word: brick.', 'Reply with one word: zebra.'];
    for (const chunk of CHUNKS) log.user({ m: chunk });

    /** @type {any} */
    let streamErr = null;
    /** @type {string} */
    let streamAnswer = '';
    try {
        streamAnswer = await client.session(defaultModel)
            .withSystemMessage('Answer with exactly one word and nothing else.')
            .run({ initialInput: chunkFeed({ chunks: CHUNKS }), options: { maxIterations: 2, onEvent: onText } });
    } catch (err) { streamErr = err; }
    client.off(EVENTS.CLIENT.API_REQUEST, onRequest);

    const lastRequest = sentRequests[sentRequests.length - 1] ?? [];
    const userTurns = countConversationTurns({ messages: lastRequest });
    const lastTurnAnswer = Array.from(answersByRun.values()).pop() ?? '';

    check({ name: 'the streamed input became three user turns of ONE conversation', ok: userTurns === 3, detail: `userTurns=${userTurns} rowsInLastRequest=${lastRequest.length}` });
    check({ name: 'every chunk ran its own turn', ok: answersByRun.size === 3, detail: `turns=${answersByRun.size}` });
    check({ name: 'the streamed run did not throw', ok: !streamErr, detail: `err=${streamErr?.name ?? 'none'}: ${log.truncate({ text: String(streamErr?.message ?? ''), n: 80 })}` });
    check({ name: 'a final answer was returned', ok: streamAnswer.trim().length > 0, detail: `${streamAnswer.trim().length} chars` });
    check({ name: 'the returned answer is the LAST turn\'s answer', ok: lastTurnAnswer.trim() === streamAnswer.trim(), detail: `lastTurn="${log.truncate({ text: lastTurnAnswer.trim(), n: 40 })}" returned="${log.truncate({ text: streamAnswer.trim(), n: 40 })}"` });

    // ── E · the money budget: the cap follows the cost the provider reported ──
    log.section({ t: 'E — withBudget({ maxBudgetUsd }): the cap follows the reported cost' });

    const MAX_BUDGET_USD = 0.000001;
    /** @type {any} */
    let unreportedEvent = null;
    /** @type {any} */
    let exceededEvent = null;
    /** @type {any} */
    let moneyUsage = null;
    // The VENDOR's own report: the quota event carries the cost the backend
    // answered with, before the SDK accumulates it into a usage snapshot. The
    // branch below is decided from THIS, so an SDK that loses the reported
    // cost cannot pass itself off as a backend that never reported one.
    /** @type {any} */
    let vendorQuota = null;
    const onQuota = (/** @type {any} */ e) => { if (e?.type === 'quota') vendorQuota = e?.data ?? e; };
    const onUnreported = (/** @type {any} */ e) => { unreportedEvent = e; };
    const onExceeded = (/** @type {any} */ e) => { exceededEvent = e; };
    const onMoneyEnd = (/** @type {any} */ e) => { moneyUsage = e?.usage ?? null; };
    client.on(EVENTS.CLIENT.BUDGET_UNREPORTED, onUnreported);
    client.on(EVENTS.CLIENT.BUDGET_EXCEEDED, onExceeded);
    client.on(EVENTS.CLIENT.RUN_END, onMoneyEnd);

    /** @type {any} */
    let moneyErr = null;
    /** @type {string} */
    let moneyAnswer = '';
    const moneySession = client.session(defaultModel).withSystemMessage('Answer with one word.');
    moneySession.withBudget({ budget: { maxBudgetUsd: MAX_BUDGET_USD } });
    try {
        moneyAnswer = await moneySession.run({ initialInput: 'Say hi.', options: { maxIterations: 2, onEvent: onQuota } });
    } catch (err) { moneyErr = err; }
    client.off(EVENTS.CLIENT.BUDGET_UNREPORTED, onUnreported);
    client.off(EVENTS.CLIENT.BUDGET_EXCEEDED, onExceeded);
    client.off(EVENTS.CLIENT.RUN_END, onMoneyEnd);

    // The SDK never estimates a price: the cap can only be enforced against
    // the cost the provider reported. Which branch ran is decided by the
    // VENDOR's report (the quota event), never by the SDK's own bookkeeping
    // and never assumed.
    const vendorCost = vendorQuota?.cost_usd;
    const vendorReportedCost = typeof vendorCost === 'number' && Number.isFinite(vendorCost);
    const reportedCost = moneyUsage?.cost_usd;
    const costIsNull = moneyUsage != null && reportedCost === null;
    const costIsNumber = typeof reportedCost === 'number' && Number.isFinite(reportedCost);
    const branch = exceededEvent ? 'enforced' : unreportedEvent ? 'unreported' : 'not reached';
    log.condition({
        label: 'the money budget',
        branch,
        why: branch === 'enforced'
            ? `the backend reported $${vendorCost} — at or over the $${MAX_BUDGET_USD} cap`
            : branch === 'unreported'
                ? 'the backend reported no cost — the cap cannot be enforced, the token budget governs'
                : 'the backend reported a cost below the cap',
    });

    check({ name: 'the money cap took the branch this backend can take', ok: branch !== 'not reached', detail: `branch=${branch} vendorCost=${vendorReportedCost ? `$${vendorCost}` : 'none'} cost_usd=${costIsNull ? 'null' : String(reportedCost)}` });
    check({ name: 'the branch matches what the VENDOR reported', ok: (vendorReportedCost && branch === 'enforced') || (!vendorReportedCost && branch === 'unreported'), detail: `vendorCost=${vendorReportedCost ? `$${vendorCost}` : 'none'} branch=${branch}` });
    if (branch === 'enforced') {
        check({ name: 'the run stopped with the USD budget error', ok: moneyErr instanceof BudgetExceededError && exceededEvent?.maxBudgetUsd === MAX_BUDGET_USD, detail: `err=${moneyErr?.name ?? 'none'} maxBudgetUsd=${exceededEvent?.maxBudgetUsd} costUsd=${exceededEvent?.costUsd}` });
        check({ name: 'the reported cost reached the cap', ok: costIsNumber && reportedCost >= MAX_BUDGET_USD, detail: `cost_usd=${reportedCost} cap=${MAX_BUDGET_USD} vendorCost=${vendorCost}` });
    } else if (branch === 'unreported') {
        check({ name: 'the run announced run:budget_unreported and CONTINUED', ok: Boolean(unreportedEvent) && !moneyErr && moneyAnswer.trim().length > 0, detail: `event=${EVENTS.CLIENT.BUDGET_UNREPORTED} maxBudgetUsd=${unreportedEvent?.maxBudgetUsd} err=${moneyErr?.name ?? 'none'} answer=${moneyAnswer.trim().length} chars` });
    }
    check({ name: 'the usage snapshot reports a number or null — never 0 for an unreported cost', ok: (costIsNumber || costIsNull) && (branch !== 'unreported' || costIsNull), detail: `cost_usd=${costIsNull ? 'null' : String(reportedCost)}` });

    // ── F · limits: every cap is a setting, read at build time ───────────────
    log.section({ t: 'F — limits: every cap is a setting, read when the object is built' });
    log.option({ name: 'limits.catalog', value: `${Object.keys(LIMIT_DEFAULTS).length} keys`, source: 'LIMIT_DEFAULTS — the documented defaults' });
    const readLimit = (/** @type {string} */ key) => getLimits().find((entry) => entry.key === key);
    /** The shell tool advertises its pipeline ceiling in the tool schema. */
    const pipelineMax = () => (/** @type {any} */ (createShellTool({ options: { approvalCallback: () => false, timeoutMs: 1_000 } })))
        .parameters?.properties?.pipeline?.maxItems;
    const iterationsLimit = readLimit('max_iterations');
    const maxPipelineStages = pipelineMax();
    check({
        name: 'the catalog matches LIMIT_DEFAULTS and the loop cap resolves to its default',
        ok: getLimits().length === Object.keys(LIMIT_DEFAULTS).length
            && iterationsLimit?.value === LIMIT_DEFAULTS.max_iterations
            && iterationsLimit?.source !== 'programmatic',
        detail: `${getLimits().length} keys · max_iterations=${iterationsLimit?.value} (default ${LIMIT_DEFAULTS.max_iterations}, source ${iterationsLimit?.source})`,
    });
    check({
        name: 'a tool built before the change carries the default cap',
        ok: maxPipelineStages === LIMIT_DEFAULTS.shell_tool_max_pipeline_stages,
        detail: `pipeline.maxItems=${maxPipelineStages} default=${LIMIT_DEFAULTS.shell_tool_max_pipeline_stages}`,
    });

    setLimits({ values: { shell_tool_max_pipeline_stages: 9 } });
    const raisedStages = readLimit('shell_tool_max_pipeline_stages')?.value;
    const raisedPipelineStages = pipelineMax();
    check({
        name: 'a tool built AFTER setLimits() picks up the new cap',
        ok: raisedStages === 9 && raisedPipelineStages === 9,
        detail: `limit=${raisedStages} (source ${readLimit('shell_tool_max_pipeline_stages')?.source}) pipeline.maxItems=${raisedPipelineStages} (was ${maxPipelineStages})`,
    });

    resetLimits();
    const restoredStages = readLimit('shell_tool_max_pipeline_stages')?.value;
    const restoredPipelineStages = pipelineMax();
    check({
        name: 'resetLimits() restores the default in the registry and in the next tool',
        ok: restoredStages === LIMIT_DEFAULTS.shell_tool_max_pipeline_stages
            && restoredPipelineStages === LIMIT_DEFAULTS.shell_tool_max_pipeline_stages,
        detail: `limit=${restoredStages} pipeline.maxItems=${restoredPipelineStages}`,
    });

    // ── G · in-flight input: a message sent while the turn is running ────────
    log.section({ t: 'G — in-flight input: a message that jumps into the running run' });

    const STEER_TEXT = 'Also mention that the demo rates are fixed, not live.';
    const QUEUED_TEXT = 'Finish with one line that starts with "USD:".';
    const WITHDRAWN_TEXT = 'Ignore this line: it is withdrawn before delivery.';

    /** Every request body the SDK sent, in send order. */
    /** @type {Array<Array<any>>} */
    const flightRequests = [];
    const onFlightRequest = (/** @type {any} */ e) => {
        const rows = e?.payload?.contents ?? e?.payload?.messages ?? e?.contents ?? e?.messages;
        if (Array.isArray(rows)) flightRequests.push(rows);
    };
    client.on(EVENTS.CLIENT.API_REQUEST, onFlightRequest);

    const flightSession = client.session(defaultModel)
        .withSystemMessage('You are a meticulous currency assistant. Use convert_currency for every conversion.')
        .withTools({ tools: [convertCurrency] });

    /** @type {any} */
    let queuedRow = null;
    /** @type {any} */
    let withdrawnRow = null;
    /** @type {any} */
    let cancelledRow = null;
    /** @type {boolean|null} */
    let toggleKeptItPending = null;
    /** @type {string|null} */
    let triggerType = null;
    const onFlightEvent = (/** @type {any} */ e) => {
        // The first stream event proves the model call is in flight: this is the
        // moment a user types into the composer of a running turn.
        if (triggerType !== null || !e?.type) return;
        triggerType = String(e.type);
        flightSession.enqueueInput({ input: STEER_TEXT });                                       // steer: next step boundary
        queuedRow = flightSession.enqueueInput({ input: QUEUED_TEXT, delivery: 'queue' });        // queue: next turn of THIS run
        // The queue panel's toggle, while the message still waits: steer -> queue.
        const flipped = flightSession.setInputDelivery({ input: queuedRow, delivery: 'steer' });
        const flippedBack = flightSession.setInputDelivery({ input: /** @type {any} */ (queuedRow).merciId, delivery: 'queue' });
        toggleKeptItPending = flipped === queuedRow && flippedBack === queuedRow
            && /** @type {any} */ (queuedRow).delivery === 'queue'
            && flightSession.getPendingInputs().filter((row) => row === queuedRow).length === 1;
        withdrawnRow = flightSession.enqueueInput({ input: WITHDRAWN_TEXT, delivery: 'queue' });
        cancelledRow = withdrawnRow ? flightSession.cancelInput({ input: withdrawnRow }) : null; // the user changes their mind
    };

    log.user({ m: PROMPT });
    /** @type {any} */
    let flightErr = null;
    /** @type {string} */
    let flightAnswer = '';
    // ONE run. A message the user sends mid-turn must be answered before this
    // call returns: in the real host, the next run() may never happen.
    try {
        flightAnswer = await flightSession.run({ initialInput: PROMPT, options: { maxIterations: 5, onEvent: onFlightEvent } });
    } catch (err) { flightErr = err; }
    client.off(EVENTS.CLIENT.API_REQUEST, onFlightRequest);

    // JSON.stringify is the provider-agnostic read: the text must appear in the
    // serialized body whichever key this backend names its rows with. The needle
    // is escaped the same way, so a quote inside the message cannot hide it.
    const bodyHas = (/** @type {{rows: Array<any>, text: string}} */ { rows, text }) => JSON.stringify(rows ?? []).includes(JSON.stringify(text).slice(1, -1));
    const firstSteerAt = flightRequests.findIndex((rows) => bodyHas({ rows, text: STEER_TEXT }));
    const firstQueuedAt = flightRequests.findIndex((rows) => bodyHas({ rows, text: QUEUED_TEXT }));
    const flightLastRequest = flightRequests[flightRequests.length - 1] ?? [];

    check({ name: 'the message was submitted while the turn was in flight', ok: triggerType !== null, detail: `first step event=${triggerType ?? 'none'}` });
    check({ name: 'the steer reached the model inside the SAME run', ok: firstSteerAt >= 0, detail: `requests=${flightRequests.length} firstSteerAt=${firstSteerAt}` });
    check({ name: 'the queued message reached the model in the SAME run — no second run()', ok: firstQueuedAt >= 0, detail: `requests=${flightRequests.length} firstQueuedAt=${firstQueuedAt} steerAt=${firstSteerAt}` });
    check({ name: 'it waited for a turn boundary: it is not in the run\'s first request', ok: !bodyHas({ rows: flightRequests[0] ?? [], text: QUEUED_TEXT }), detail: `firstRequestRows=${(flightRequests[0] ?? []).length}` });
    check({ name: 'a cancelled row was never sent', ok: cancelledRow === withdrawnRow && !flightRequests.some((rows) => bodyHas({ rows, text: WITHDRAWN_TEXT })), detail: `cancelInput returned the row=${cancelledRow === withdrawnRow}` });
    check({ name: 'setInputDelivery kept it pending, singular, and back on queue', ok: toggleKeptItPending === true, detail: `delivery=${/** @type {any} */ (queuedRow)?.delivery}` });
    check({ name: 'no message is left for a run that may never happen', ok: flightSession.getPendingInputs().length === 0, detail: `pending=${flightSession.getPendingInputs().length}` });
    check({ name: 'the run answered that last turn and returned it', ok: !flightErr && flightAnswer.trim().length > 0 && bodyHas({ rows: flightLastRequest, text: QUEUED_TEXT }), detail: `err=${flightErr?.name ?? 'none'} ${flightAnswer.trim().length} chars` });

    // ── H · the same inbox on a streamed run ─────────────────────────────────
    log.section({ t: 'H — a streamed run drains the same inbox between chunks and after the last one' });

    const BETWEEN_TEXT = 'Also keep the answer to one word.';
    const AFTER_TEXT = 'And one more one-word answer.';
    /** @type {Array<Array<any>>} */
    const streamRequests = [];
    const onStreamRequest = (/** @type {any} */ e) => {
        const rows = e?.payload?.contents ?? e?.payload?.messages ?? e?.contents ?? e?.messages;
        if (Array.isArray(rows)) streamRequests.push(rows);
    };
    client.on(EVENTS.CLIENT.API_REQUEST, onStreamRequest);

    const streamSession = client.session(defaultModel).withSystemMessage('Answer with exactly one word and nothing else.');
    /** @type {any} */
    let betweenRow = null;
    /** @type {any} */
    let afterRow = null;
    /** @returns {AsyncGenerator<string, void, unknown>} */
    async function* chunksAroundInbox() {
        yield 'Reply with one word: apple.';
        // Sent between two turns of the stream: the NEXT chunk's turn carries it.
        betweenRow = streamSession.enqueueInput({ input: BETWEEN_TEXT, delivery: 'queue' });
        yield 'Reply with one word: brick.';
        // Sent after the last chunk: the run must still answer it before resolving.
        afterRow = streamSession.enqueueInput({ input: AFTER_TEXT, delivery: 'queue' });
    }
    /** @type {any} */
    let streamErr2 = null;
    /** @type {string} */
    let streamAnswer2 = '';
    try {
        streamAnswer2 = await streamSession.run({ initialInput: chunksAroundInbox(), options: { maxIterations: 2 } });
    } catch (err) { streamErr2 = err; }
    client.off(EVENTS.CLIENT.API_REQUEST, onStreamRequest);

    check({ name: 'a message sent between chunks rides the next chunk\'s turn', ok: streamRequests.some((rows) => bodyHas({ rows, text: BETWEEN_TEXT })), detail: `requests=${streamRequests.length}` });
    check({ name: 'a message sent after the last chunk still gets a turn', ok: streamRequests.some((rows) => bodyHas({ rows, text: AFTER_TEXT })), detail: `requests=${streamRequests.length} afterQueued=${Boolean(afterRow)}` });
    check({ name: 'the streamed run leaves nothing pending', ok: betweenRow !== null && streamSession.getPendingInputs().length === 0, detail: `pending=${streamSession.getPendingInputs().length}` });
    check({ name: 'the streamed run returned an answer', ok: !streamErr2 && streamAnswer2.trim().length > 0, detail: `err=${streamErr2?.name ?? 'none'} ${streamAnswer2.trim().length} chars` });

    // ── I · the queue of record: drainInbox(), one answer per message, a restart
    log.section({ t: 'I — the durable inbox: drainInbox(), one answer per message, replay after a restart' });

    const INBOX_RUN_DIR = join(SCRATCH_DIR, '07-inbox');
    await rm(INBOX_RUN_DIR, { recursive: true, force: true });
    await mkdir(INBOX_RUN_DIR, { recursive: true });
    const inboxStore = new LocalFileInboxStore({ dir: INBOX_RUN_DIR });
    const INBOX_THREAD = 'example-07-inbox';
    log.option({ name: 'inbox.store', value: INBOX_RUN_DIR, source: 'new LocalFileInboxStore({ dir })' });
    log.option({ name: 'inbox.thread', value: INBOX_THREAD, source: 'withInboxStore({ store, threadId })' });

    const inboxSession = client.session(defaultModel)
        .withSystemMessage('Answer with exactly one word and nothing else.')
        .withInboxStore({ store: inboxStore, threadId: INBOX_THREAD });

    for (const text of ['Reply with one word: apple.', 'Reply with one word: brick.']) {
        log.user({ m: text });
        inboxSession.enqueueInput({ input: text, delivery: 'queue' });
    }

    // No `initialInput`: the queue is the prompt. A host calls this on idle.
    const drained = await inboxSession.drainInbox();
    check({ name: 'drainInbox ran the queue without an invented prompt', ok: (drained?.answers.length ?? 0) === 2, detail: `answers=${drained?.answers.length ?? 0} requests=${drained?.answers.map((/** @type {any} */ a) => a.inboxId ? 'id' : 'none').join(',') ?? 'none'}` });
    check({ name: 'each queued message got its own turn and its own answer', ok: (drained?.answers ?? []).every((/** @type {any} */ a) => typeof a.inboxId === 'string' && a.text.trim().length > 0), detail: (drained?.answers ?? []).map((/** @type {any} */ a) => a.text.trim().slice(0, 12)).join(' · ') });
    check({ name: 'the session is idle once the drain returned', ok: inboxSession.isRunning() === false, detail: `isRunning=${inboxSession.isRunning()}` });
    check({ name: 'an empty queue is a no-op, not a model call', ok: (await inboxSession.drainInbox()) === null, detail: 'drainInbox() === null' });

    // A send that never got its turn, then a "restart" with only the store.
    log.user({ m: 'Reply with one word: zebra.' });
    const parked = inboxSession.enqueueInput({ input: 'Reply with one word: zebra.', delivery: 'queue' });
    await inboxSession.loadInbox();   // settles the durable write (a graceful stop)
    const reopened = client.session(defaultModel)
        .withSystemMessage('Answer with exactly one word and nothing else.')
        .withInboxStore({ store: inboxStore, threadId: INBOX_THREAD });
    const restored = await reopened.loadInbox();
    check({ name: 'a message queued before the restart is still in the durable queue', ok: restored.length === 1 && /** @type {any} */ (restored[0]).merciId === /** @type {any} */ (parked).merciId, detail: `restored=${restored.length}` });

    const replayed = await reopened.drainInbox();
    check({ name: 'the reopened session answers it under the same inbox id', ok: replayed?.answers[0]?.inboxId === /** @type {any} */ (parked).merciId, detail: `inboxId=${replayed?.answers[0]?.inboxId ?? 'none'}` });
    check({ name: 'the durable queue is empty after the replay', ok: (await inboxStore.load({ threadId: INBOX_THREAD })).length === 0, detail: `stored=${(await inboxStore.load({ threadId: INBOX_THREAD })).length}` });

    // Two workers, one thread: the store lease decides, and the loser reports it.
    log.user({ m: 'Reply with one word: cherry.' });
    reopened.enqueueInput({ input: 'Reply with one word: cherry.', delivery: 'queue' });
    await reopened.loadInbox();
    const otherWorker = `other-worker:${process.pid}`;
    const holdsLease = await inboxStore.lease.acquire({ threadId: INBOX_THREAD, owner: otherWorker });
    const raced = await reopened.drainInbox();
    check({
        name: 'a drain skips while another worker holds the thread lease',
        ok: holdsLease === true && raced?.skipped === 'lease' && raced.answers.length === 0,
        detail: `skipped=${raced?.skipped ?? 'none'} answers=${raced?.answers.length ?? 0}`,
    });
    await inboxStore.lease.release({ threadId: INBOX_THREAD, owner: otherWorker });
    const afterLease = await reopened.drainInbox();
    check({ name: 'the same queue drains once the lease is free', ok: afterLease?.answers.length === 1, detail: `answers=${afterLease?.answers.length ?? 0}` });
    check({
        name: 'the idle gate opens when no subagent is running',
        ok: reopened.hasLiveBackgroundWork() === false && (await reopened.waitForBackgroundWork({ timeoutMs: 0 })) === true,
        detail: `live=${reopened.hasLiveBackgroundWork()}`,
    });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'Agent loop, abort, budget, streamed input, money budget, limits and in-flight input verified.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
