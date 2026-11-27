// @ts-check
/**
 * Example 06 — Approvals and safety: the refund agent that must be stopped.
 *
 * A customer wants $4,200 back and slips an AWS key and a bank transfer into the
 * same message. Every stop below is a real SDK gate on a live session — the
 * agent is not told to behave, it is bounded:
 *
 *   A — the hostile turn never reaches the model: `withGuardrails` +
 *       `createGuardrails` block it, and `extractUserText` reads EVERY user
 *       turn, so a secret in an earlier turn is still caught.
 *   B — policy decides the toolset: `isToolPermitted` (deny beats allow),
 *       `stillRequiresApproval` per `PERMISSION_MODES` entry, and one chain
 *       `withGuardrails → withPermissions → withToolTimeout → withBudget →
 *       withSessionStore`.
 *   C — money needs a human: `issue_refund` declares `requiresApproval`, so
 *       `withApproval` asks the duty manager (closed stdin answers "no").
 *   D — the wire transfer is not on the menu: the deny list removes the tool.
 *   E — one tool gets a hard ceiling: `executeTools({ toolTimeoutMs })` cuts a
 *       tool that never returns, `outputSchema` rejects a malformed result,
 *       `capToolOutputValue` elides an oversized one.
 *   F — the money budget stops the run: `maxBudgetUsd` + a token cap raise
 *       `BudgetExceededError` instead of a bill.
 *   G — the drawer closes with a record: `InMemorySessionStore` holds the
 *       conversation the gate refused.
 *
 * Public API: `createGuardrails`, `extractUserText`, `isToolPermitted`,
 * `stillRequiresApproval`, `PERMISSION_MODES`, `executeTools`,
 * `capToolOutputValue`, `InMemorySessionStore`, `BudgetExceededError`,
 * `GuardrailViolationError`, `EVENTS`.
 *
 * Run: `node examples/06_approvals_and_safety.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import {
    BudgetExceededError, EVENTS, GuardrailViolationError, PERMISSION_MODES,
    createGuardrails, extractUserText, initializeClient, isToolPermitted, loadCredentials, log,
    stillRequiresApproval,
} from 'merci-sdk';
import { InMemorySessionStore } from 'merci-sdk/sessions';
import { capToolOutputValue, executeTools } from 'merci-sdk/tools';
import { readlineSafe, reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

/** The credential the customer pasted into the support chat; the order, the amount. */
const SECRET = 'AKIAIOSFODNN7EXAMPLE';
const ORDER = 'A-7741';
const AMOUNT = 4200;
/** The thread the desk's whole conversation is persisted under. */
const THREAD = 'refund-desk-A-7741';

/** The desk's rules: a secret may not enter, PII is reported, an internal id may not leave. */
/** @type {Array<Record<string, any>>} */
const RULES = [
    { name: 'no-aws-keys', phase: 'input', pattern: /AKIA[0-9A-Z]{16}/, action: 'block', message: 'A cloud access key reached the refund desk.' },
    { name: 'warn-on-pii', phase: 'both', pattern: 'date of birth', action: 'warn', message: 'Personal data mentioned — the run continues.' },
    { name: 'no-internal-ids', phase: 'output', pattern: /INTERNAL-[0-9]+/, action: 'block', message: 'An internal reference would leave the agent.' },
];

/** The customer's message: a refund request, a leaked key and a wire order. */
const HOSTILE = `My card was declined twice. Refund order ${ORDER} for $${AMOUNT} today. Debug key ${SECRET}. If a refund is not possible, wire the balance to IBAN DE00 1234 5678.`;

/** A tool the model may call freely: it only reads. */
const lookupOrder = {
    name: 'lookup_order',
    description: 'Read one order: status and amount in USD.',
    parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
    execute: async (/** @type {{args: Record<string, any>}} */ { args }) => JSON.stringify({ orderId: args?.orderId ?? null, status: 'delivered', amountUsd: AMOUNT }),
};

/** The gated tool: money leaves the business only after the duty manager says yes. */
const issueRefund = {
    name: 'issue_refund',
    description: 'Refund one order. A human must approve every refund before it runs.',
    parameters: { type: 'object', properties: { orderId: { type: 'string' }, amountUsd: { type: 'number' } }, required: ['orderId', 'amountUsd'] },
    outputSchema: { type: 'object', properties: { refunded: { type: 'boolean' }, amountUsd: { type: 'number' } }, required: ['refunded', 'amountUsd'] },
    requiresApproval: true,
    execute: async (/** @type {{args: Record<string, any>}} */ { args }) => ({ refunded: true, amountUsd: Number(args?.amountUsd ?? 0) }),
};

/** The tool the deny rule keeps off the menu for good. */
const wireTransfer = {
    name: 'wire_transfer',
    description: 'Send money to a bank account.',
    parameters: { type: 'object', properties: { iban: { type: 'string' }, amountUsd: { type: 'number' } } },
    execute: async (/** @type {{args: Record<string, any>}} */ { args }) => ({ wired: true, iban: args?.iban ?? null }),
};

/** A tool that never returns — the subject of the per-tool ceiling. */
/** @param {{name: string}} arg0 */
const hangingTool = ({ name }) => ({
    name,
    description: 'Never returns — the per-tool timeout must cut the round.',
    parameters: { type: 'object', properties: {} },
    execute: async () => new Promise(() => {}),
});

async function main() {
    const { provider, defaultModel, toolModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });
    let apiCalls = 0;
    client.on(EVENTS.CLIENT.API_REQUEST, () => { apiCalls += 1; });

    const rl = readline.createInterface({ input, output });
    /** Ask the duty manager. A closed stdin answers 'n' — the desk never hangs. */
    /** @param {{label: string}} arg0 @returns {Promise<boolean>} */
    const ask = async ({ label }) => {
        process.stdout.write('\n');
        const answer = (await readlineSafe({ rl, prompt: `${label} [y/N] `, fallback: 'n' })).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
    };

    log.header({ t: `Example 06 — Approvals and safety (${provider})` });
    log.option({ name: 'desk thread', value: THREAD, source: 'withSessionStore({ store: new InMemorySessionStore() })' });
    log.option({ name: 'guardrail rules', value: RULES.map((r) => `${r.name}:${r.action}`).join(', '), source: 'withGuardrails({ rules })' });
    log.option({ name: 'gated tool', value: 'issue_refund', source: 'tool.requiresApproval + withApproval({ fn })' });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // ── A: the hostile turn never reaches the model ──────────────────────────
    log.section({ t: 'A — the hostile turn is refused before the model sees it' });
    const guardrails = createGuardrails({ rules: /** @type {any} */ (RULES) });
    const history = [
        { role: 'user', content: 'Hi, my card was declined this morning.' },
        { role: 'assistant', content: 'I can help with that. Which order?' },
        { role: 'user', content: [{ type: 'text', text: HOSTILE }] },
    ];
    const userText = extractUserText({ messages: history });
    const onSecret = await guardrails.check({ phase: 'input', text: userText });
    const onPii = await guardrails.check({ phase: 'input', text: 'my date of birth is 1980-01-01, please refund me' });
    const onOutput = await guardrails.check({ phase: 'output', text: 'see ref INTERNAL-42' });
    log.event({ type: 'guardrail verdicts', payload: { secret: onSecret.rule?.name, pii: onPii.rule?.name, output: onOutput.rule?.name } });
    check({ name: 'A: the secret in a later turn trips the block rule', ok: onSecret.blocked === true && onSecret.rule?.name === 'no-aws-keys' && userText.includes('card was declined'), detail: `blocked=${onSecret.blocked} rule=${onSecret.rule?.name} text=${userText.length} chars` });
    check({ name: 'A: a warn rule reports without stopping', ok: onPii.blocked === false && onPii.rule?.name === 'warn-on-pii', detail: `rule=${onPii.rule?.name}` });
    check({ name: 'A: an output-scoped rule only fires on the way out', ok: onOutput.blocked === true && onOutput.rule?.name === 'no-internal-ids' && onSecret.rule?.name !== 'no-internal-ids', detail: `output=${onOutput.rule?.name}` });

    const beforeGuard = apiCalls;
    /** @type {any} */
    let guardError = null;
    try {
        await client.session(toolModel)
            .withGuardrails({ rules: /** @type {any} */ (RULES) })
            .withSystemMessage('You are a refund clerk. Answer briefly.')
            .run({ initialInput: HOSTILE, options: { maxIterations: 1 } });
    } catch (err) {
        guardError = err;
    }
    log.user({ m: HOSTILE });
    check({ name: 'A: the live run was refused by the guardrail', ok: guardError instanceof GuardrailViolationError, detail: guardError ? `${guardError.name}: ${log.truncate({ text: guardError.message, n: 90 })}` : 'the run went through' });
    check({ name: 'A: no vendor call was made for the refused turn', ok: apiCalls === beforeGuard, detail: `api_request ${beforeGuard} → ${apiCalls}` });

    // ── B: permission rules decide the toolset ───────────────────────────────
    log.section({ t: 'B — policy decides which tools exist at all' });
    const allow = ['lookup_*', 'issue_refund'];
    const deny = ['wire_*'];
    const permitted = {
        lookup: isToolPermitted({ name: 'lookup_order', allow, deny }),
        refund: isToolPermitted({ name: 'issue_refund', allow, deny }),
        wire: isToolPermitted({ name: 'wire_transfer', allow, deny }),
        unrestricted: isToolPermitted({ name: 'anything_at_all', allow: [], deny: [] }),
    };
    const asksDefault = stillRequiresApproval({ name: 'issue_refund', mode: 'default', requiresApproval: true });
    const asksBypass = stillRequiresApproval({ name: 'issue_refund', mode: 'bypassPermissions', requiresApproval: true });
    log.option({ name: 'permissions', value: `allow=[${allow.join(',')}] deny=[${deny.join(',')}] mode=default`, source: 'withPermissions({ allow, deny, mode })' });
    log.option({ name: 'permission modes', value: PERMISSION_MODES.join(', '), source: 'PERMISSION_MODES' });
    log.list({ title: 'tool → permitted', items: Object.entries(permitted).map(([tool, ok]) => `${tool}: ${ok}`) });
    check({
        name: 'B: the allow glob admits its matches and the deny list wins',
        ok: permitted.lookup === true && permitted.refund === true && permitted.wire === false && permitted.unrestricted === true,
        detail: `lookup=${permitted.lookup} refund=${permitted.refund} wire=${permitted.wire} emptyAllow=${permitted.unrestricted}`,
    });
    check({ name: 'B: only bypassPermissions skips the human on a gated tool', ok: asksDefault === true && asksBypass === false && PERMISSION_MODES.length === 3, detail: `default=${asksDefault} bypass=${asksBypass} modes=${PERMISSION_MODES.join('|')}` });

    // ── C: the desk, wired, live — and the refund goes to a human ────────────
    log.section({ t: 'C — the refund needs a human, on a real run' });
    const store = new InMemorySessionStore();
    /** @type {Array<{name: string, args: any}>} */
    const asked = [];
    /** @type {Array<{orderId: string, amountUsd: number}>} */
    const refunds = [];
    /** @type {string[]} */
    const transfers = [];
    /** @type {string[]} */
    const toolNames = [];
    let approved = false;
    const onApprovalGranted = (/** @type {any} */ e) => {
        if (e?.name === 'issue_refund') approved = true;
    };
    client.on(EVENTS.TOOL.APPROVAL_GRANTED, onApprovalGranted);
    /** The duty manager: small goodwill credits are pre-approved, everything else asks. */
    /** @param {string} name @param {any} args @returns {Promise<boolean>} */
    const approve = async (name, args) => {
        asked.push({ name, args });
        if (name === 'issue_refund' && Number(args?.amountUsd ?? 0) <= 50) return true;
        const granted = await ask({ label: `Approve ${name}(${JSON.stringify(args ?? {})})?` });
        return granted;
    };
    const deskRefund = {
        ...issueRefund,
        /** @param {{args: Record<string, any>}} arg0 */
        execute: async ({ args }) => {
            refunds.push({ orderId: String(args?.orderId ?? ''), amountUsd: Number(args?.amountUsd ?? 0) });
            return { refunded: true, amountUsd: Number(args?.amountUsd ?? 0) };
        },
    };
    const deskWire = { ...wireTransfer, execute: async (/** @type {{args: Record<string, any>}} */ { args }) => { transfers.push(String(args?.iban ?? '')); return { wired: true }; } };
    const base = client.session(toolModel).withTools({ tools: [lookupOrder, deskRefund, deskWire] });
    const desk = base
        .withGuardrails({ rules: /** @type {any} */ (RULES) })
        .withPermissions({ allow, deny, mode: 'default' })
        .withToolTimeout({ ms: 20_000 })
        .withBudget({ budget: { maxTotalTokens: 60_000, maxBudgetUsd: 0.75 } })
        .withApproval({ fn: approve, options: { timeoutMs: 5_000 } })
        .withSessionStore({ store, threadId: THREAD })
        .withSystemMessage([
            'You are the refund clerk of an online shop.',
            `Call issue_refund exactly once with orderId "${ORDER}" and amountUsd ${AMOUNT} — a human approves or declines it.`,
            'Do not refund anything else. Report the outcome in one sentence.',
        ].join(' '));
    check({ name: 'C: the policy chain keeps one builder', ok: desk === base, detail: 'withGuardrails → withPermissions → withToolTimeout → withBudget → withSessionStore' });
    log.option({ name: 'approval', value: 'duty manager — over-limit refunds ask, closed stdin declines', source: 'withApproval({ fn })' });
    log.user({ m: `Refund order ${ORDER} for $${AMOUNT}.` });
    const deskAnswer = String(await desk.run({
        initialInput: `Refund order ${ORDER} for $${AMOUNT} using issue_refund.`,
        options: { maxIterations: 6, onEvent: (/** @type {any} */ e) => { if (e?.type === 'tool_call_start') toolNames.push(String(e.name)); } },
    }));
    warnEmptyAnswer({ answer: deskAnswer, label: 'the refund desk' });
    log.assistant({ m: deskAnswer });
    if (asked.length === 0) {
        // The model skipped the gate. The host now sends the same request through
        // the same gate, so the approval path is still proven on this run.
        log.condition({ label: 'approval', branch: 'host call', why: 'the model did not call issue_refund; the host sends the same request through the same gate' });
        const [hostResult] = /** @type {any} */ (await executeTools({
            toolCalls: [{ id: 'host-refund', name: 'issue_refund', arguments: JSON.stringify({ orderId: ORDER, amountUsd: AMOUNT }) }],
            toolLibrary: [/** @type {any} */ (deskRefund)],
            approval: { callback: approve, timeoutMs: 5_000 },
        }));
        approved = approved || hostResult?.success === true;
    }
    client.off(EVENTS.TOOL.APPROVAL_GRANTED, onApprovalGranted);
    const refundGate = asked.find((a) => a.name === 'issue_refund');
    check({
        name: 'C: the refund was put in front of a human before it ran',
        ok: Boolean(refundGate) && Number(refundGate?.args?.amountUsd) === AMOUNT,
        detail: refundGate ? `asked about ${refundGate.name}(${JSON.stringify(refundGate.args)})` : 'the gate was never consulted',
    });
    check({
        name: 'C: money moved only on an approval',
        ok: refunds.length === (approved ? 1 : 0),
        detail: `asked=${asked.length} granted=${approved} refunds=${refunds.length}`,
    });
    log.condition({ label: 'refund', branch: approved ? 'approved' : 'declined', why: 'the operator decision is the SDK gate, not the model' });

    // ── D: the wire transfer is not on the menu ──────────────────────────────
    log.section({ t: 'D — the wire transfer is not on the menu' });
    check({
        name: 'D: a denied tool never appears in the advertised toolset',
        ok: isToolPermitted({ name: 'wire_transfer', allow, deny }) === false,
        detail: `wire_transfer in allow=${allow.join('|')} deny=${deny.join('|')}`,
    });
    check({
        name: 'D: the live desk made no transfer',
        ok: transfers.length === 0 && !toolNames.includes('wire_transfer'),
        detail: `tool calls=[${toolNames.join(', ')}] transfers=${transfers.length}`,
    });

    // ── E: one tool gets a hard ceiling ──────────────────────────────────────
    log.section({ t: 'E — one tool gets a hard ceiling' });
    const [slow] = /** @type {any} */ (await executeTools({
        toolCalls: [{ id: 'c-slow', name: 'hold_funds', arguments: '{}' }],
        toolLibrary: [/** @type {any} */ (hangingTool({ name: 'hold_funds' }))],
        toolTimeoutMs: 50,
    }));
    const [conforming] = /** @type {any} */ (await executeTools({
        toolCalls: [{ id: 'c-ok', name: 'issue_refund', arguments: JSON.stringify({ orderId: ORDER, amountUsd: 25 }) }],
        toolLibrary: [/** @type {any} */ ({ ...issueRefund, requiresApproval: false, execute: async () => ({ refunded: true, amountUsd: 25 }) })],
    }));
    const [malformed] = /** @type {any} */ (await executeTools({
        toolCalls: [{ id: 'c-bad', name: 'issue_refund', arguments: JSON.stringify({ orderId: ORDER, amountUsd: 25 }) }],
        toolLibrary: [/** @type {any} */ ({ ...issueRefund, requiresApproval: false, execute: async () => ({ refunded: 'yes', amountUsd: 'lots' }) })],
    }));
    const oversized = /** @type {any} */ (capToolOutputValue({ value: { note: 'A'.repeat(40), rows: { a: 'x', b: 'y' } }, maxLength: 50 }));
    log.option({ name: 'toolTimeoutMs', value: 50, source: 'executeTools({ toolTimeoutMs }) — a tool may tighten it with tool.timeoutMs' });
    log.event({ type: 'bounded round', payload: { slow: slow?.error, malformed: malformed?.error } });
    check({ name: 'E: a tool that never returns is cut off', ok: slow?.success === false && /timeout/i.test(String(slow?.error)), detail: String(slow?.error) });
    check({
        name: 'E: outputSchema passes a real result and rejects a malformed one',
        ok: conforming?.success === true && conforming?.result?.amountUsd === 25 && malformed?.success === false && /outputSchema/.test(String(malformed?.error)),
        detail: `ok=${conforming?.success} bad=${malformed?.success} err=${log.truncate({ text: String(malformed?.error ?? ''), n: 70 })}`,
    });
    check({
        name: 'E: an oversized result keeps its shape and is elided',
        ok: oversized?.truncated === true && oversized?.value?.note === 'A'.repeat(40) && oversized?.value?.rows?.b === '[…]',
        detail: `truncated=${oversized?.truncated} rows=${JSON.stringify(oversized?.value?.rows)}`,
    });

    // ── F: the money budget stops the run ────────────────────────────────────
    log.section({ t: 'F — the money budget stops the run' });
    const MAX_USD = 0.01;
    log.option({ name: 'budget', value: `maxBudgetUsd=${MAX_USD} · maxTotalTokens=1`, source: 'withBudget({ budget: { maxBudgetUsd, maxTotalTokens } })' });
    /** @type {any} */
    let budgetError = null;
    const beforeBudget = apiCalls;
    try {
        await client.session(defaultModel)
            .withBudget({ budget: { maxBudgetUsd: MAX_USD, maxTotalTokens: 1 } })
            .withSystemMessage('Answer in one word.')
            .run({ initialInput: 'Say "charged".', options: { maxIterations: 2 } });
    } catch (err) {
        budgetError = err;
    }
    check({
        name: 'F: the run stops with BudgetExceededError, not a bill',
        ok: budgetError instanceof BudgetExceededError,
        detail: budgetError ? log.truncate({ text: budgetError.message, n: 110 }) : `no stop (api_request ${beforeBudget} → ${apiCalls})`,
    });

    // ── G: the drawer closes with a record ───────────────────────────────────
    log.section({ t: 'G — the session store keeps the audit trail' });
    const checkpoint = await store.load(THREAD);
    const rows = Array.isArray(checkpoint?.messages) ? checkpoint.messages : [];
    log.option({ name: 'checkpoint rows', value: rows.length, source: 'InMemorySessionStore.load(threadId)' });
    check({
        name: 'G: the desk conversation was persisted under its thread',
        ok: rows.length >= 2 && rows.some((/** @type {any} */ row) => String(row?.content ?? '').includes(ORDER) || JSON.stringify(row ?? {}).includes(ORDER)),
        detail: `rows=${rows.length} thread=${checkpoint?.threadId ?? 'none'}`,
    });
    check({
        name: 'G: the refused credential is not in the persisted transcript',
        ok: !JSON.stringify(rows).includes(SECRET),
        detail: `secret present=${JSON.stringify(rows).includes(SECRET)}`,
    });

    rl.close();
    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'Every gate held: guardrails, permissions, approval, timeout, schema, budget, store.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
