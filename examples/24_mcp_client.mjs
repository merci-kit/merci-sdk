// @ts-check
/**
 * Example 24 — MCP: a stdio server's tools inside a live session.
 *
 * The parent spawns the sibling `24_mcp_server.mjs` as a child process, speaks
 * the Model Context Protocol over its stdin/stdout, and turns the advertised
 * tools into ordinary SDK tools:
 *
 *   A — handshake      : `loadMcpTools({ mcpClient })` starts the transport,
 *       lists the remote tools and maps each one to `{ name, description,
 *       parameters, execute }`. The call is REAL — no mock server.
 *   B — direct call    : the mapped tool executes over stdio and returns the
 *       server's computed statistics (same bytes the model would see).
 *   C — edge           : calling an unadvertised tool comes back as an MCP
 *       `isError` result — surfaced, never a hang.
 *   D — live session   : `.withTools({ tools: mcpTools })` lets the model call
 *       the remote tool; the answer carries the remote computation.
 *   E — capabilities   : the client declares `sampling`, `elicitation` and
 *       `roots`; the server's `ask_client` tool calls back on all three and
 *       the client's OWN answers come back inside the tool's result.
 *   F — resources/prompts : the client lists the server's resources and
 *       prompts, reads one of each and gets the server's real content.
 *   Teardown           : `mcpClient.stop()` closes the transport and kills the
 *       child.
 *
 * Run: `node examples/24_mcp_client.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`. No MCP install —
 * the server child comes from this repo.
 *
 * @version 0.23.0
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDisplay, initializeClient, loadCredentials, log } from 'merci-sdk';
import { McpClient, loadMcpTools } from 'merci-sdk/tools';
import { guardedParse } from 'merci-sdk/json';
import { reportUsage, resolveExample, runMain, trackUsage, wireClient, warnEmptyAnswer } from './_shared/example-utils.mjs';

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), '24_mcp_server.mjs');
const TOOL_NAME = 'word_stats';
const CALLBACK_TOOL = 'ask_client';
const RESOURCE_URI = 'file:///merci-example/notes.md';
const RESOURCE_MARKER = 'merci-example-notes-v1';
const RESOURCE_SENTENCE = 'the quick brown fox jumps over the lazy dog';
const PROMPT_NAME = 'word_stats_report';
const ROOT_URI = 'file:///workspace';
const SAMPLE_ANSWER = 'fox';
const ELICIT_CITY = 'Prague';

/**
 * Parse a tool's JSON result through the SDK guard. A malformed result fails
 * the example instead of being repaired.
 * @param {{input: unknown, label: string}} arg0 -
 * @returns {any}
 */
function parseResult({ input, label }) {
    const parsed = guardedParse({
        input: typeof input === 'string' ? input : JSON.stringify(input),
        options: { heal: false },
    });
    if (!parsed.success) throw new Error(`${label}: invalid JSON result (${parsed.error})`);
    return parsed.data;
}
const SAMPLE = 'the quick brown fox jumps over the lazy dog the fox sleeps';

async function main() {
    const { provider, toolModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    log.header({ t: `Example 24 — MCP over stdio (${provider})` });
    log.option({ name: 'server', value: SERVER_PATH, source: 'sibling child process (24_mcp_server.mjs)' });
    log.option({ name: 'transport', value: 'stdio', source: 'new McpClient({ command: process.execPath, args: [serverPath] })' });
    log.option({ name: 'capabilities', value: 'sampling, elicitation, roots', source: 'McpClient({ options: { onSampling, onElicit, roots } })' });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    /** @type {Array<{messages: any[], maxTokens: number|null}>} */
    const sampled = [];
    /** @type {Array<{message: string, requestedSchema: any}>} */
    const elicited = [];

    /**
     * Answers a server-initiated `sampling/createMessage` with a fixed,
     * model-free answer — the point of the round trip is the plumbing, not
     * the text.
     * @param {{messages?: any[], maxTokens?: number|null, modelPreferences?: any, systemPrompt?: string|null, includeContext?: string}} arg0
     * @returns {Promise<{role: string, content: {type: string, text: string}, model: string, stopReason: string}>}
     */
    const onSampling = async ({ messages = [], maxTokens = null } = {}) => {
        sampled.push({ messages, maxTokens });
        return { role: 'assistant', content: { type: 'text', text: SAMPLE_ANSWER }, model: 'merci-example-sampler', stopReason: 'endTurn' };
    };

    /**
     * Answers a server-initiated `elicitation/create` with a fixed city.
     * @param {{message?: string, requestedSchema?: any, mode?: string}} arg0
     * @returns {Promise<{action: string, content: Record<string, any>}>}
     */
    const onElicit = async ({ message = '', requestedSchema = null } = {}) => {
        elicited.push({ message, requestedSchema });
        return { action: 'accept', content: { city: ELICIT_CITY } };
    };

    const mcpClient = new McpClient({
        command: process.execPath,
        args: [SERVER_PATH],
        options: {
            onSampling,
            onElicit,
            roots: [{ uri: ROOT_URI, name: 'workspace' }],
        },
    });
    try {
        // ── A: handshake + tool mapping ──────────────────────────────────────
        log.section({ t: 'A — handshake and tool discovery' });
        const mcpTools = await loadMcpTools({ mcpClient });
        log.list({ title: 'remote tools', items: mcpTools.map((t) => `${t.name} — ${t.description}`) });
        const remote = mcpTools.find((t) => t.name === TOOL_NAME);
        check({ name: 'the remote tool was discovered', ok: !!remote, detail: mcpTools.map((t) => t.name).join(', ') || '(none)' });
        if (!remote) throw new Error(`MCP server did not advertise ${TOOL_NAME}`);

        // ── B: a direct call through the transport (no model, real bytes) ────
        log.section({ t: 'B — direct remote call over stdio' });
        const direct = /** @type {any} */ (await remote.execute({ args: { text: SAMPLE, top: 3 } }));
        if (direct?.success !== true) throw new Error(`direct ${TOOL_NAME} call failed: ${direct?.error ?? 'unknown error'}`);
        const stats = parseResult({ input: direct.result, label: TOOL_NAME });
        log.toolResult({ n: `${TOOL_NAME} (direct)`, r: direct.result });
        check({
            name: 'the remote tool computes real word stats',
            ok: direct.success === true && stats.words === SAMPLE.split(/\s+/).length,
            detail: `words=${stats.words}`,
        });

        // ── C: edge — an unadvertised tool is an isError result, not a crash ─
        log.section({ t: 'C — edge: unknown remote tool' });
        let unknown = 'no-response';
        try {
            const response = /** @type {any} */ (await mcpClient.executeTool({ name: 'no_such_tool', args: {} }));
            unknown = response?.isError ? 'isError' : 'unexpected-success';
        } catch (error) {
            unknown = `threw: ${(/** @type {Error} */ (error)).message}`;
        }
        log.condition({ label: 'unknown remote tool', branch: unknown, why: 'the server answers with an MCP error result' });
        check({ name: 'an unknown remote tool is surfaced, not fatal', ok: unknown === 'isError' || unknown.startsWith('threw:') });

        // ── D: a live session calls the remote tool ──────────────────────────
        log.section({ t: 'D — the model calls the remote tool' });
        let remoteCalls = 0;
        const countRemote = (/** @type {any} */ e) => {
            if (e?.name === TOOL_NAME && e.type === 'tool_call_start') remoteCalls++;
        };
        const expectedWords = stats.words;
        log.user({ m: `word_stats("${log.truncate({ text: SAMPLE, n: 40 })}")` });
        const answer = String(await client.session(toolModel)
            .withTools({ tools: mcpTools.filter((t) => t.name === TOOL_NAME) })
            .withSystemMessage('You have remote tools served over MCP. Call the tool named in the request; do not compute the answer yourself.')
            .run({
                initialInput: `Call the ${TOOL_NAME} tool exactly once on this text (top=3): "${SAMPLE}" Then reply with only the total word count.`,
                options: defaultDisplay({ also: countRemote }),
            }));
        warnEmptyAnswer({ answer, label: 'the MCP session' });
        check({ name: 'the session called the remote tool', ok: remoteCalls >= 1, detail: `calls=${remoteCalls}` });
        check({
            name: 'the answer carries the remote computation',
            ok: new RegExp(`\\b${expectedWords}\\b`).test(answer),
            detail: log.truncate({ text: answer, n: 140 }),
        });

        // ── E: the server calls BACK into the client's own capabilities ──────
        log.section({ t: 'E — the client capabilities: sampling, elicitation, roots' });
        const callbackTool = mcpTools.find((t) => t.name === CALLBACK_TOOL);
        if (!callbackTool) throw new Error(`MCP server did not advertise ${CALLBACK_TOOL}`);
        const called = /** @type {any} */ (await callbackTool.execute({ args: { topic: SAMPLE } }));
        if (called?.success !== true) throw new Error(`the ${CALLBACK_TOOL} call failed: ${called?.error ?? 'unknown error'}`);
        const payload = parseResult({ input: called.result, label: CALLBACK_TOOL });
        log.toolResult({ n: `${CALLBACK_TOOL} (callback round trip)`, r: called.result });
        const caps = payload.clientCapabilities ?? {};
        check({
            name: 'the server saw the client declare sampling, elicitation and roots',
            ok: !!caps.sampling && !!caps.elicitation && !!caps.roots,
            detail: Object.keys(caps).join(', ') || '(none)',
        });
        check({
            name: 'the sampling callback fired and its answer came back',
            ok: sampled.length > 0 && payload.sample?.text === SAMPLE_ANSWER,
            detail: `calls=${sampled.length} text="${payload.sample?.text ?? ''}"`,
        });
        check({
            name: 'the elicitation callback fired and its answer came back',
            ok: elicited.length > 0 && payload.elicited?.action === 'accept' && payload.elicited?.content?.city === ELICIT_CITY,
            detail: `calls=${elicited.length} city=${payload.elicited?.content?.city ?? ''}`,
        });
        check({
            name: 'the roots came back from the client',
            ok: Array.isArray(payload.roots) && payload.roots.includes(ROOT_URI),
            detail: (payload.roots ?? []).join(', '),
        });

        // ── F: the resources and the prompts the server publishes ────────────
        log.section({ t: 'F — resources and prompts' });
        const resources = await mcpClient.listResources();
        log.list({ title: 'remote resources', items: resources.map((r) => `${r.uri} — ${r.name ?? ''}`) });
        const listed = resources.find((r) => r.uri === RESOURCE_URI);
        const read = await mcpClient.readResource({ uri: RESOURCE_URI });
        const text = String(read?.contents?.[0]?.text ?? '');
        log.toolResult({ n: `resource ${RESOURCE_URI}`, r: text });
        const expectedResourceWords = RESOURCE_SENTENCE.split(/\s+/).filter(Boolean).length;
        check({
            name: 'the client listed the server resources and read one',
            ok: !!listed && text.includes(RESOURCE_MARKER) && text.includes(`${expectedResourceWords} words`),
            detail: `${text.length} chars, server counted ${expectedResourceWords} words`,
        });
        const prompts = await mcpClient.listPrompts();
        log.list({ title: 'remote prompts', items: prompts.map((p) => `${p.name} — ${p.description ?? ''}`) });
        const prompt = await mcpClient.getPrompt({ name: PROMPT_NAME, args: { text: SAMPLE } });
        const rendered = String(prompt?.messages?.[0]?.content?.text ?? '');
        log.toolResult({ n: `prompt ${PROMPT_NAME}`, r: rendered });
        check({
            name: 'the client listed the server prompts and rendered one',
            ok: prompts.some((p) => p.name === PROMPT_NAME) && rendered.includes(SAMPLE),
            detail: log.truncate({ text: rendered, n: 120 }),
        });
    } finally {
        await mcpClient.stop();
    }

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'MCP round trips verified.' });
    else throw new Error(`${failures}/${checks} live check(s) failed — inspect the log above.`);
}

runMain({ mainFn: main });
