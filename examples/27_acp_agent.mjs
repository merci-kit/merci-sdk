// @ts-check
/**
 * Example 27 — merci behind an editor protocol.
 *
 * An editor speaks the Agent Client Protocol to this process. The ACP client is
 * the official SDK client on the other end of a real NDJSON transport (two
 * byte pipes, in memory); the ACP agent is `createAcpAgent` wrapping a live
 * merci session scoped to a workspace.
 *
 *   A — the editor connects : `initialize` negotiates ACP v1 and reports
 *       `ACP_AGENT_VERSION`; the client announces its capabilities.
 *   B — session/new         : the agent mints a session id and the merci
 *       session factory receives the editor's cwd; `session/list` shows it.
 *   C — a coding question   : a real model reads `config.json` in the workspace
 *       and answers with the retry limit; every thought, message chunk and tool
 *       call arrives as a `session/update` notification over the transport, and
 *       the turn ends with `ACP_STOP_REASONS.END_TURN`.
 *   D — permissions         : `permissionAllowed` grants only an option the
 *       agent offered — a reject, an unknown option id, a cancelled outcome and
 *       an empty list all deny. Then a live shell command is offered to the
 *       editor, the editor rejects it, and the command never runs.
 *   E — cancellation        : `session/cancel` is a notification, sent while the
 *       turn is streaming; the prompt resolves with the CANCELLED stop reason.
 *
 * What this shows:
 *   - the ACP v1 agent and session lifecycle, driven by a real client
 *   - fail-closed permissions wired from a shell gate to the editor
 *   - stop reasons as the protocol's answer for every turn
 *
 * Run: `node examples/27_acp_agent.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    ACP_AGENT_VERSION, ACP_STOP_REASONS, EVENTS, createAcpAgent, createContextTools, createShellTool,
    defaultDisplay, initializeClient, loadCredentials, log, permissionAllowed,
} from 'merci-sdk';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const WORKSPACE = join(SCRATCH_DIR, '27-acp-workspace');
const CONFIG_FILE = join(WORKSPACE, 'config.json');
const CONFIG = { service: 'billing', retryLimit: 3, timeoutSeconds: 30 };
const EDITOR_FILE = join(WORKSPACE, 'editor-only.txt');
const CODING_QUESTION = 'Read the file config.json in this workspace and report the retry limit. Answer in one sentence and name the file you read.';
const SHELL_QUESTION = `Run this exact shell command with the shell tool: node -e "require('node:fs').writeFileSync('editor-only.txt','ran')" . Then report the outcome in one sentence.`;
const LONG_QUESTION = 'Write a 300-word description of a deployment pipeline, with headings.';

const ALLOW = { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' };
const REJECT = { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' };
const CASES = [
    { name: 'allow_once', options: [ALLOW], answer: { outcome: { outcome: 'selected', optionId: 'opt-allow' } }, expected: true },
    { name: 'reject_once', options: [REJECT], answer: { outcome: { outcome: 'selected', optionId: 'opt-reject' } }, expected: false },
    { name: 'an option id that was never offered', options: [ALLOW], answer: { outcome: { outcome: 'selected', optionId: 'never-offered' } }, expected: false },
    { name: 'a cancelled outcome', options: [ALLOW], answer: { outcome: { outcome: 'cancelled' } }, expected: false },
    { name: 'an empty option list', options: [], answer: { outcome: { outcome: 'selected', optionId: 'opt-allow' } }, expected: false },
];

/**
 * Two byte pipes wired into a pair of NDJSON streams: the agent writes one way,
 * the client writes the other. Real protocol bytes, no child process.
 */
function ndjsonDuplex() {
    const clientToAgent = new TransformStream();
    const agentToClient = new TransformStream();
    return {
        agentStream: ndJsonStream(agentToClient.writable, clientToAgent.readable),
        clientStream: ndJsonStream(clientToAgent.writable, agentToClient.readable),
    };
}

/** @param {{filePath: string}} arg0 */
async function exists({ filePath }) {
    try {
        await readFile(filePath);
        return true;
    } catch {
        return false;
    }
}

async function main() {
    const { provider, toolModel } = resolveExample();
    const { client: sdk } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client: sdk });
    const usage = trackUsage({ client: sdk });

    log.header({ t: `Example 27 — ACP v1: merci behind an editor protocol (${provider})` });
    await rm(WORKSPACE, { recursive: true, force: true });
    await mkdir(WORKSPACE, { recursive: true });
    await writeFile(CONFIG_FILE, `${JSON.stringify(CONFIG, null, 2)}\n`, 'utf8');
    await writeFile(join(WORKSPACE, 'AGENTS.md'), '# House rules\n\n- Answer from the files in this workspace.\n- Name the file you read.\n', 'utf8');
    log.option({ name: 'workspace', value: WORKSPACE, source: 'withAutoContext({ root }) + context tools + shell roots' });
    log.option({ name: 'transport', value: 'NDJSON over two in-memory byte pipes', source: 'ndJsonStream(...) — the official ACP transport framing' });
    log.option({ name: 'model', value: toolModel, source: 'resolveExample().toolModel' });
    log.option({ name: 'agent', value: `merci-sdk ${ACP_AGENT_VERSION}`, source: `createAcpAgent({ createSession }) · protocol ${PROTOCOL_VERSION}` });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    /** The editor-side bridge of the turn currently in flight. */
    const turnBridge = { current: /** @type {any} */ (null) };
    /** The shell gate's live verdicts, captured where the gate decides. */
    const gate = { requests: 0, allowed: 0, denied: 0, started: 0 };
    const shellEvents = new EventEmitter();
    shellEvents.on(EVENTS.SHELL.COMMAND_START, () => { gate.started += 1; });

    const shellTool = createShellTool({ options: {
        roots: [WORKSPACE],
        cwd: WORKSPACE,
        eventEmitter: shellEvents,
        approvalCallback: async (/** @type {string} */ command, /** @type {any[]} */ args) => {
            const bridge = turnBridge.current;
            if (!bridge) return false;
            gate.requests += 1;
            const options = [ALLOW, REJECT];
            const response = await bridge.requestPermission({
                toolCall: { toolCallId: `gate-${gate.requests}`, title: `${command} ${Array.isArray(args) ? args.join(' ') : ''}`, kind: 'execute', status: 'pending', rawInput: { command, args } },
                options,
            });
            const allowed = permissionAllowed({ response, options });
            if (allowed) gate.allowed += 1;
            else gate.denied += 1;
            return allowed;
        },
    } });

    /** @type {Array<{acpSessionId: string, cwd: string}>} */
    const spawned = [];
    const app = createAcpAgent({
        createSession: ({ sessionId, cwd }) => {
            spawned.push({ acpSessionId: String(sessionId), cwd: String(cwd) });
            return sdk.session(toolModel)
                .withAutoContext({ options: { root: cwd } })
                .withTools({ tools: [...createContextTools({ options: { root: cwd } }), shellTool] })
                .withSystemMessage('You are a coding agent inside an editor. Read files before you answer. Use the shell tool when the request names a command. If a tool is denied, report the denial and stop — never retry the same call.');
        },
        onTurnContext: (/** @type {any} */ bridge) => { turnBridge.current = bridge; },
    });

    const { agentStream, clientStream } = ndjsonDuplex();
    const agentConnection = app.connect(agentStream);
    const clientApp = client({ name: 'merci-acp-editor' });
    /** @type {any} */
    const editor = { ctx: null, updates: [], permissionRequests: [], cancelOnFirstChunk: false, cancelSent: false };

    clientApp.onNotification(methods.client.session.update, (/** @type {any} */ { params }) => {
        editor.updates.push(params.update);
        if (editor.cancelOnFirstChunk && !editor.cancelSent && params.update?.sessionUpdate === 'agent_message_chunk') {
            editor.cancelSent = true;
            void editor.ctx?.notify(methods.agent.session.cancel, { sessionId: params.sessionId });
        }
    });
    clientApp.onRequest(methods.client.session.requestPermission, (/** @type {any} */ { params }) => {
        editor.permissionRequests.push(params);
        // This editor refuses every permission it is asked for: fail closed.
        return { outcome: { outcome: 'selected', optionId: REJECT.optionId } };
    });

    try {
        await clientApp.connectWith(clientStream, async (/** @type {any} */ ctx) => {
            editor.ctx = ctx;

            // ── A: the editor connects ────────────────────────────────────────
            log.section({ t: 'A — the editor connects: initialize over the transport' });
            const init = /** @type {any} */ (await ctx.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: true }, elicitation: { form: {} } },
            }));
            log.event({ type: 'acp.initialize', payload: { protocolVersion: init.protocolVersion, agent: init.agentInfo?.name, version: init.agentInfo?.version } });
            check({ name: 'A: initialize negotiates ACP v1', ok: init.protocolVersion === PROTOCOL_VERSION, detail: `protocol=${init.protocolVersion}` });
            check({ name: 'A: the agent reports the merci agent version', ok: init.agentInfo?.version === ACP_AGENT_VERSION, detail: `${init.agentInfo?.name} ${init.agentInfo?.version}` });

            // ── B: session/new ───────────────────────────────────────────────
            log.section({ t: 'B — session/new: the editor opens a workspace session' });
            const created = /** @type {any} */ (await ctx.request(methods.agent.session.new, { cwd: WORKSPACE, mcpServers: [] }));
            const sessionId = String(created.sessionId);
            const listed = /** @type {any} */ (await ctx.request(methods.agent.session.list, {}));
            log.option({ name: 'session.id', value: sessionId, source: "ctx.request(methods.agent.session.new, { cwd })" });
            check({ name: 'B: the agent minted a merci session id', ok: /^merci-/.test(sessionId), detail: sessionId });
            check({ name: 'B: session/list holds exactly that session', ok: listed.sessions?.length === 1 && listed.sessions[0]?.sessionId === sessionId, detail: `sessions=${listed.sessions?.length ?? 0}` });

            // ── C: a real coding question ────────────────────────────────────
            log.section({ t: 'C — a coding question: prompt → session/update → end_turn' });
            editor.updates = [];
            log.user({ m: CODING_QUESTION });
            const coding = /** @type {any} */ (await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: CODING_QUESTION }] }));
            const kinds = editor.updates.map((/** @type {any} */ update) => update.sessionUpdate);
            const answerText = editor.updates
                .filter((/** @type {any} */ update) => update.sessionUpdate === 'agent_message_chunk')
                .map((/** @type {any} */ update) => update.content?.text ?? '')
                .join('');
            const toolTitles = editor.updates
                .filter((/** @type {any} */ update) => update.sessionUpdate === 'tool_call')
                .map((/** @type {any} */ update) => update.title ?? update.toolCallId);
            warnEmptyAnswer({ answer: answerText, label: 'the ACP turn' });
            log.list({ title: 'session/update kinds', items: [...new Set(kinds)] });
            log.list({ title: 'tool calls the editor saw', items: toolTitles.length > 0 ? toolTitles : ['(none — answered from the workspace block)'] });
            check({ name: 'C: the model answered with the retry limit from config.json', ok: /\b3\b/.test(answerText) && /config\.json/i.test(answerText), detail: log.truncate({ text: answerText, n: 160 }) });
            check({ name: 'C: the answer arrived as agent_message_chunk updates', ok: kinds.includes('agent_message_chunk') && answerText.length > 0, detail: `${kinds.length} update(s)` });
            check({ name: 'C: the turn ends with end_turn', ok: coding.stopReason === ACP_STOP_REASONS.END_TURN, detail: `stopReason=${coding.stopReason}` });
            check({ name: 'C: the merci session was built for the editor cwd', ok: spawned[0]?.cwd === WORKSPACE && spawned[0]?.acpSessionId === sessionId, detail: `${spawned[0]?.acpSessionId} @ ${spawned[0]?.cwd}` });

            // ── D: fail-closed permissions ───────────────────────────────────
            log.section({ t: 'D — permissions: only an offered allow grants anything' });
            const verdicts = CASES.map((testCase) => ({
                name: testCase.name,
                allowed: permissionAllowed({ response: testCase.answer, options: testCase.options }),
                expected: testCase.expected,
            }));
            log.list({ title: 'permissionAllowed verdicts', items: verdicts.map((verdict) => `${verdict.name} → ${verdict.allowed ? 'allow' : 'deny'}`) });
            check({ name: 'D: every static verdict matches the fail-closed rule', ok: verdicts.every((verdict) => verdict.allowed === verdict.expected), detail: verdicts.map((verdict) => `${verdict.name}=${verdict.allowed}`).join(' ') });

            editor.updates = [];
            editor.permissionRequests = [];
            log.user({ m: SHELL_QUESTION });
            const denied = /** @type {any} */ (await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: SHELL_QUESTION }] }));
            const denialText = editor.updates
                .filter((/** @type {any} */ update) => update.sessionUpdate === 'agent_message_chunk')
                .map((/** @type {any} */ update) => update.content?.text ?? '')
                .join('');
            log.event({ type: 'acp.permission', payload: { requests: editor.permissionRequests.length, gate } });
            check({ name: 'D: the shell gate asked the editor for permission', ok: editor.permissionRequests.length >= 1 && gate.requests >= 1, detail: `requests=${editor.permissionRequests.length} gate=${gate.requests}` });
            check({
                name: 'D: the offered request names the real command',
                ok: editor.permissionRequests[0]?.toolCall?.rawInput?.command === 'node' && editor.permissionRequests[0]?.sessionId === sessionId,
                detail: `${editor.permissionRequests[0]?.toolCall?.rawInput?.command} ${JSON.stringify(editor.permissionRequests[0]?.toolCall?.rawInput?.args ?? null)}`,
            });
            check({ name: 'D: the editor rejection denied the call', ok: gate.denied >= 1 && gate.allowed === 0, detail: `denied=${gate.denied} allowed=${gate.allowed}` });
            check({ name: 'D: the denied command never ran', ok: gate.started === 0 && !(await exists({ filePath: EDITOR_FILE })), detail: `command starts=${gate.started}, editor-only.txt ${(await exists({ filePath: EDITOR_FILE })) ? 'exists' : 'absent'}` });
            check({ name: 'D: the model reported the denial', ok: denied.stopReason === ACP_STOP_REASONS.END_TURN && /denied|refus|not permitted|not allowed/i.test(denialText), detail: log.truncate({ text: denialText, n: 140 }) });

            // ── E: cancellation is a notification ────────────────────────────
            log.section({ t: 'E — cancellation: a notification that stops the turn' });
            editor.updates = [];
            editor.cancelOnFirstChunk = true;
            editor.cancelSent = false;
            log.user({ m: LONG_QUESTION });
            const long = /** @type {any} */ (await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: LONG_QUESTION }] }));
            check({ name: 'E: the cancel went out while the turn was streaming', ok: editor.cancelSent === true, detail: `chunks before cancel=${editor.updates.length}` });
            check({ name: 'E: the turn stopped with the cancelled stop reason', ok: long.stopReason === ACP_STOP_REASONS.CANCELLED, detail: `stopReason=${long.stopReason}` });
            const afterCancel = /** @type {any} */ (await ctx.request(methods.agent.session.list, {}));
            check({ name: 'E: the connection stays usable after the cancel', ok: afterCancel.sessions?.length === 1, detail: `sessions=${afterCancel.sessions?.length ?? 0}` });
            log.list({ title: 'stop reasons exercised', items: [ACP_STOP_REASONS.END_TURN, ACP_STOP_REASONS.CANCELLED].map((reason) => `${reason} (${String(reason) === coding.stopReason || String(reason) === long.stopReason ? 'observed' : 'offered'})`) });
        });
    } finally {
        agentConnection.close();
    }

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures, 'shell.requests': gate.requests, 'shell.denied': gate.denied, 'shell.started': gate.started } });
    if (failures === 0) log.success({ m: 'ACP v1 lifecycle, permissions and stop reasons verified.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
