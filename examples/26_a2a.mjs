// @ts-check
/**
 * Example 26 — A2A: a remote peer as a tool — discover, delegate, track.
 *
 * `26_a2a_server.mjs` is spawned as a child process; `spawnChild({ script })`
 * waits for its single stdout handshake line (`PORT:<n>`), so the parent never
 * guesses a port. `loadA2ATool({ agentUrl })` then fetches
 * `GET /.well-known/agent-card.json`, pins the JSON-RPC endpoint to the card's
 * origin (SSRF guard), and materializes each advertised skill as a local tool.
 *
 * The happy path runs end to end twice: once by calling the materialized tool
 * directly (pure wire check), then through a ChatSession so the model itself
 * picks the tool and the lookup crosses the process boundary. Two edge cases:
 * a peer that is down fails soft (empty tool list, no throw), and a malformed
 * JSON-RPC body comes back as a typed error instead of crashing the server.
 *
 * The **A2A task lifecycle** section is pure protocol (no model): the peer
 * ends a task in the interrupted state `input-required`, so the delegation
 * hands back the task id instead of a result. That id is read with
 * `getA2ATask`, cancelled with `cancelA2ATask` and read again — the state
 * moves from `TASK_STATE_INPUT_REQUIRED` to `TASK_STATE_CANCELED`.
 *
 * Public API: `loadA2ATool`, `getA2ATask`, `cancelA2ATask`, `A2A_COMPLETED_STATES` from
 * `merci-sdk/tools`; `initializeClient`,
 * `client.session(model).withSystemMessage(...).withTools(...).run(...)`.
 *
 * Run: `node examples/26_a2a.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeClient, loadCredentials, log } from 'merci-sdk';
import { loadA2ATool, getA2ATask, cancelA2ATask, A2A_COMPLETED_STATES } from 'merci-sdk/tools';
import { reportUsage, resolveExample, runMain, spawnChild, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), '26_a2a_server.mjs');
const DEAD_PEER_URL = 'http://127.0.0.1:1';

/**
 * Prints the check and fails the run (non-zero exit) when it does not hold.
 * @param {{name: string, ok: boolean, detail?: string}} arg0
 */
function check({ name, ok, detail = '' }) {
    log.check({ name, passed: ok, detail });
    if (!ok) throw new Error(`check failed: ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
    const { provider, toolModel } = resolveExample();

    log.header({ t: `Example 26 — Remote agents over A2A (${provider})` });
    log.option({ name: 'provider', value: provider, source: 'resolveProvider()' });
    log.option({ name: 'model', value: toolModel, source: 'getToolModel({ backend }) — the leaf that delegates' });
    log.option({ name: 'child', value: SERVER_PATH, source: 'spawnChild({ script }) PORT handshake' });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    const missing = await loadA2ATool({ agentUrl: DEAD_PEER_URL });
    check({ name: 'a down peer fails soft', ok: missing.length === 0, detail: `tools=${missing.length}` });

    /** @type {{ proc: import('node:child_process').ChildProcess, port: number }|null} */
    let child = null;
    try {
        child = await spawnChild({ script: SERVER_PATH });
        const agentUrl = `http://127.0.0.1:${child.port}`;
        log.info({ m: `child announced ${agentUrl}` });

        const tools = /** @type {Array<any>} */ (await loadA2ATool({ agentUrl }));
        log.list({ title: 'advertised skills', items: tools.map((t) => `${t.name} — ${t.description}`) });
        const lookup = tools.find((t) => t.name === 'ticket_lookup');
        check({ name: 'agent card materialized the advertised tool', ok: Boolean(lookup), detail: tools.map((t) => t.name).join(', ') || '(none)' });

        const direct = await lookup.execute({ args: { ticketId: 'T-42' }, signal: null });
        log.event({ type: 'direct delegation', payload: { tool: lookup.name, result: direct } });
        check({
            name: 'direct delegation returns the remote ticket',
            ok: String(direct).includes('T-42') && String(direct).includes('escalated'),
            detail: log.truncate({ text: String(direct), n: 120 }),
        });

        // --- the A2A task lifecycle (protocol only — no model) --------------
        log.section({ t: 'the A2A task lifecycle' });
        const escalation = tools.find((t) => t.name === 'escalation_request');
        check({
            name: 'the card advertised the escalation skill',
            ok: Boolean(escalation),
            detail: tools.map((t) => t.name).join(', ') || '(none)',
        });

        // The peer ends this task in the interrupted state `input-required`,
        // so the delegation hands back the task id instead of a result.
        const interrupted = await escalation.execute({ args: { ticketId: 'T-42' }, signal: null });
        log.event({ type: 'interrupted delegation', payload: { tool: escalation.name, result: interrupted } });
        check({
            name: 'a task that needs input hands back its id',
            ok: interrupted?.success === false && interrupted?.needsInput === true && Boolean(interrupted?.taskId),
            detail: JSON.stringify(interrupted),
        });
        const taskId = String(interrupted?.taskId ?? '');

        const read = await getA2ATask({ agentUrl, taskId });
        log.event({ type: 'task.read', payload: { state: read.state, taskId: read.taskId } });
        check({
            name: 'the task reads back as input-required',
            ok: read.state === 'TASK_STATE_INPUT_REQUIRED' && read.taskId === taskId,
            detail: `state=${read.state} taskId=${read.taskId}`,
        });

        // The SDK's `A2A_COMPLETED_STATES` are the states that end a task
        // (completed / failed / canceled / rejected). The interrupted ones are
        // NOT terminal, so the peer still accepts a cancellation of this task —
        // a task that already COMPLETED or FAILED cannot be cancelled.
        check({
            name: 'the SDK says input-required is not a terminal state',
            ok: !A2A_COMPLETED_STATES.includes(read.state),
            detail: `state=${read.state} terminal=[${A2A_COMPLETED_STATES.join(', ')}]`,
        });
        const canceled = await cancelA2ATask({ agentUrl, taskId });
        check({
            name: 'input-required is not terminal — the live task cancels',
            ok: canceled === true,
            detail: `cancelA2ATask → ${canceled}`,
        });

        const afterCancel = await getA2ATask({ agentUrl, taskId });
        log.event({ type: 'task.read', payload: { state: afterCancel.state, taskId: afterCancel.taskId } });
        check({
            name: 'the cancelled task reads back as cancelled',
            ok: afterCancel.state === 'TASK_STATE_CANCELED' && afterCancel.taskId === taskId,
            detail: `state=${afterCancel.state} taskId=${afterCancel.taskId}`,
        });

        const malformed = await fetch(`${agentUrl}/a2a`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc": "2.0", "id": 7, ' });
        const malformedBody = /** @type {any} */ (await malformed.json());
        check({
            name: 'malformed JSON-RPC body → -32700 Parse error',
            ok: malformedBody?.error?.code === -32700,
            detail: JSON.stringify(malformedBody?.error ?? malformedBody),
        });

        let delegations = 0;
        const counted = tools.map((t) => ({
            ...t,
            /** @param {{args: any, signal: any, context?: any}} arg */
            execute: async (arg) => { delegations++; return t.execute(arg); },
        }));
        const answer = await client.session(toolModel)
            .withSystemMessage('You are an on-call assistant. The remote A2A agent advertises the ticket_lookup tool — call it instead of guessing.')
            .withTools({ tools: counted })
            .run({ initialInput: 'Look up ticket T-42 and report its status and owner in one short sentence.', options: { maxIterations: 4 } });
        log.assistant({ m: String(answer) });
        warnEmptyAnswer({ answer, label: 'the A2A session' });
        check({ name: 'the session delegated over JSON-RPC', ok: delegations >= 1, detail: `delegations=${delegations}` });
        check({ name: 'the answer reports the remote ticket', ok: String(answer).includes('T-42') || String(answer).includes('escalated'), detail: String(answer) });
    } finally {
        if (child) {
            const proc = child.proc;
            proc.kill();
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 2000);
                timer.unref?.();
                once(proc, 'exit').then(() => { clearTimeout(timer); resolve(undefined); });
            });
            log.info({ m: `child pid ${proc.pid} killed` });
        }
    }

    reportUsage({ provider, usage });
    log.success({ m: 'Done.' });
}

runMain({ mainFn: main });
