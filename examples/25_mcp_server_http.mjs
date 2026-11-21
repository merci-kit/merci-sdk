// @ts-check
/**
 * Example 25 — Your SDK is the MCP server.
 *
 * This process does not consume someone else's MCP server; it IS one. A
 * `node:http` server serves the Streamable HTTP transport from
 * `createMcpHttpHandler`, and a real model on the other side of an `McpClient`
 * calls the tools this same process advertises — the same model wearing two
 * hats, server-side and client-side.
 *
 *   A — serve            : `createMcpHttpHandler` mounts `word_stats` (with an
 *       `outputSchema`) on a loopback `node:http` server.
 *   B — connect          : an `McpClient` attaches over Streamable HTTP and
 *       `loadMcpTools` maps the advertised tool into an SDK tool; a direct call
 *       returns the server's own numbers.
 *   C — the model calls  : a live session uses that remote tool and answers
 *       with the forced marker plus the real word count.
 *   D — the extension surface : a `LoadableComponent` (loaded, saved and
 *       injected as a per-step block), an `ExternalToolCapability` doing real
 *       file work, and an `AcpCapability` over a duck-typed client — all
 *       registered on one session with `withCapability`.
 *   E — bounded output   : `capToolOutput` on text, `capToolOutputValue` on
 *       JSON, with the truncation suffix the model actually sees.
 *   F — artifacts        : `createSaveArtifactTool` writes versioned files and
 *       keeps a manifest, so a large result becomes a path.
 *   G — host context     : `buildEnvironmentBlock` + `discoverInstructions`
 *       render the workspace block and the AGENTS.md a host injects.
 *
 * What this shows:
 *   - the Streamable HTTP server and the client SDK meeting over loopback
 *   - capabilities as the extension seam (component + remote families)
 *   - output caps and artifacts as the boundary for large results
 *
 * Run: `node examples/25_mcp_server_http.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    AcpCapability, ExternalToolCapability, LoadableComponent,
    buildEnvironmentBlock, capToolOutput, capToolOutputValue, createMcpHttpHandler, createSaveArtifactTool,
    defaultDisplay, discoverInstructions, initializeClient, loadCredentials, loadMcpTools, log,
    McpClient,
} from 'merci-sdk';
import { TOOL_OUTPUT_TRUNCATION_SUFFIX } from 'merci-sdk/tools';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const RUN_DIR = join(SCRATCH_DIR, '25-mcp-http');
const WORKSPACE = join(RUN_DIR, 'workspace');
const ARTIFACTS = join(RUN_DIR, 'artifacts');
const NOTES_FILE = join(WORKSPACE, 'release-notes.md');
const SAMPLE_TEXT = 'the quick brown fox jumps over the lazy dog';
const SERVER_MARKER = 'LIVE-MCP-HTTP';
const EXTENSION_MARKER = 'EXTENSION-OK';
const FILE_TOKEN = 'ORBIT-7';
const RETRY_BUDGET = '3';
const ARTIFACT_TEXT = '# Staging report\n\nThe release went out at 09:12.';

/**
 * One word-statistics tool served by this process. `outputSchema` makes the MCP
 * server return `structuredContent`, not just a text blob.
 */
const wordStatsTool = {
    name: 'word_stats',
    description: 'Computes text statistics: characters, words, lines and the most frequent words.',
    parameters: {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'The text to analyze.' },
            top: { type: 'integer', minimum: 1, maximum: 10, description: 'How many frequent words to return (default 3).' },
        },
        required: ['text'],
    },
    outputSchema: {
        type: 'object',
        properties: {
            characters: { type: 'integer' },
            words: { type: 'integer' },
            lines: { type: 'integer' },
            top: { type: 'array', items: { type: 'object', properties: { word: { type: 'string' }, count: { type: 'integer' } } } },
        },
        required: ['characters', 'words', 'lines', 'top'],
    },
    /** @param {{args?: Record<string, any>}} arg0 */
    execute: async ({ args = {} } = {}) => {
        const text = String(args.text ?? '');
        const top = Math.min(10, Math.max(1, Number(args.top) || 3));
        const words = text.split(/\s+/).filter(Boolean);
        const freq = new Map();
        for (const word of words) {
            const key = word.toLowerCase().replace(/[^a-z0-9']/g, '');
            if (key) freq.set(key, (freq.get(key) ?? 0) + 1);
        }
        const frequent = [...freq.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, top)
            .map(([word, count]) => ({ word, count }));
        return { characters: text.length, words: words.length, lines: text.split('\n').length, top: frequent };
    },
};

/**
 * A capability the host writes itself: an in-memory case scratchpad, surfaced
 * as `save_case_notes` / `load_case_notes` and injected as a step block.
 * @extends {LoadableComponent}
 */
class CaseNotes extends LoadableComponent {
    constructor() {
        super({
            id: 'case-notes',
            loadToolName: 'load_case_notes',
            saveToolName: 'save_case_notes',
            announce: 'A case scratchpad is available: save_case_notes / load_case_notes.',
        });
        /** @type {string[]} */
        this.notes = [];
    }
    /** @param {Record<string, unknown>} [args] */
    async load(args = {}) {
        void args;
        return this.notes.length === 0 ? null : this.notes.map((note) => `- ${note}`).join('\n');
    }
    /** @param {{args?: {content?: unknown}}} [arg0] */
    async save({ args = {} } = {}) {
        this.notes.push(String(args.content ?? ''));
        return { success: true, count: this.notes.length };
    }
    /** @param {Record<string, any>} [ctx] */
    shouldInjectStep(ctx = {}) {
        return ctx.preload === true && this.notes.length > 0;
    }
    /** @param {Record<string, any>} [ctx] */
    async stepBlock(ctx = {}) {
        void ctx;
        return this.notes.length === 0 ? null : `Case scratchpad:\n${await this.load()}`;
    }
}

/** @param {{filePath: string}} arg0 */
async function digestOf({ filePath }) {
    const raw = await readFile(filePath, 'utf8');
    return { bytes: Buffer.byteLength(raw, 'utf8'), sha256: createHash('sha256').update(raw).digest('hex') };
}

async function main() {
    const { provider, toolModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    log.header({ t: `Example 25 — The SDK as an MCP server (${provider})` });
    await rm(RUN_DIR, { recursive: true, force: true });
    await mkdir(WORKSPACE, { recursive: true });
    await mkdir(ARTIFACTS, { recursive: true });
    await writeFile(NOTES_FILE, `# Release notes\n\n- owner: platform\n- token: ${FILE_TOKEN}\n- staging deployed, rollback rehearsed\n`, 'utf8');
    await writeFile(join(WORKSPACE, 'AGENTS.md'), '# House rules\n\n- Reply with the token the workspace file carries.\n- Never invent a deployment result.\n', 'utf8');
    log.option({ name: 'workspace', value: WORKSPACE, source: 'scratchpad/examples/25-mcp-http/workspace' });
    log.option({ name: 'model', value: toolModel, source: 'resolveExample().toolModel — the same model on both sides' });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // ── A: this process serves MCP over Streamable HTTP ─────────────────────
    log.section({ t: 'A — serve: a Streamable HTTP MCP server on loopback' });
    const handler = await createMcpHttpHandler({
        name: 'merci-example-http',
        version: '1.0.0',
        tools: [wordStatsTool],
        resources: [{
            uri: 'file:///release-notes.md',
            name: 'release-notes',
            description: 'The release notes for this service.',
            mimeType: 'text/plain',
            read: () => readFile(NOTES_FILE, 'utf8'),
        }],
        prompts: [{
            name: 'summarize_release',
            description: 'Summarize a release document.',
            arguments: [{ name: 'document', description: 'The document to summarize.', required: true }],
            /** @param {Record<string, any>} args */
            render: (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Summarize this release:\n\n${args?.document ?? ''}` } }] }),
        }],
    });
    const http = createServer((/** @type {any} */ req, /** @type {any} */ res) => { void handler.handle(req, res); });
    await new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = /** @type {any} */ (http.address());
    const url = `http://127.0.0.1:${address.port}/mcp`;
    log.option({ name: 'endpoint', value: 'http://127.0.0.1:<ephemeral port>/mcp', source: 'createMcpHttpHandler({ tools }) + node:http' });
    log.option({ name: 'advertised', value: 'word_stats (outputSchema) · 1 resource · 1 prompt', source: 'the server options' });
    check({ name: 'A: the loopback server is listening', ok: http.listening === true, detail: `port=${address.port}` });
    check({ name: 'A: no MCP session exists before any client connects', ok: handler.sessions.size === 0, detail: `sessions=${handler.sessions.size}` });

    const mcpClient = new McpClient({ options: { url } });
    try {
        // ── B: the client connects and calls the served tool directly ────────
        log.section({ t: 'B — connect: an McpClient on the other side of the HTTP transport' });
        const mcpTools = await loadMcpTools({ mcpClient });
        log.list({ title: 'tools served by this process', items: mcpTools.map((tool) => tool.name) });
        const remote = mcpTools.find((tool) => tool.name === 'word_stats');
        check({ name: 'B: loadMcpTools mapped the advertised tool', ok: Boolean(remote), detail: mcpTools.map((tool) => tool.name).join(', ') || '(none)' });
        if (!remote) throw new Error('the MCP server did not advertise word_stats');
        const direct = /** @type {any} */ (await mcpClient.executeTool({ name: 'word_stats', args: { text: SAMPLE_TEXT, top: 2 } }));
        const stats = /** @type {any} */ (direct.structuredContent);
        log.toolResult({ n: 'word_stats (direct over HTTP)', r: JSON.stringify(stats) });
        check({ name: 'B: the direct call returns the server computation as structuredContent', ok: direct.isError !== true && stats?.words === 9 && stats?.top?.[0]?.word === 'the', detail: `${stats?.words} words, top=${stats?.top?.[0]?.word}x${stats?.top?.[0]?.count}` });
        check({ name: 'B: the HTTP transport opened exactly one MCP session', ok: handler.sessions.size === 1, detail: `sessions=${handler.sessions.size}` });

        // ── C: the model calls the tool this process serves ──────────────────
        log.section({ t: 'C — the model calls its own process' });
        /** @type {string[]} */
        const servedCalls = [];
        const prompt = `Call the word_stats tool exactly once on this text (top=2): "${SAMPLE_TEXT}" Then reply with exactly: ${SERVER_MARKER} and the total word count.`;
        log.user({ m: prompt });
        const servedAnswer = String(await client.session(toolModel)
            .withTools({ tools: [remote] })
            .withSystemMessage('You have a remote MCP tool served over Streamable HTTP. Call the tool named in the request; never count the words yourself.')
            .run({
                initialInput: prompt,
                options: defaultDisplay({ also: (/** @type {any} */ event) => {
                    if (event?.type === 'tool_call_start') servedCalls.push(String(event.name));
                } }),
            }));
        warnEmptyAnswer({ answer: servedAnswer, label: 'the MCP round trip' });
        check({ name: 'C: the model called the served tool', ok: servedCalls.includes('word_stats'), detail: servedCalls.join(', ') || '(none)' });
        check({ name: 'C: the answer carries the marker and the real count', ok: servedAnswer.includes(SERVER_MARKER) && /\b9\b/.test(servedAnswer), detail: log.truncate({ text: servedAnswer, n: 140 }) });

        // ── D: the extension surface, registered on one session ──────────────
        log.section({ t: 'D — the extension surface: a loadable component and two tool families' });
        const notes = new CaseNotes();
        const saveNotes = /** @type {any} */ (notes.toSaveTool());
        const loadNotes = /** @type {any} */ (notes.toLoadTool());
        const saved = await saveNotes.execute({ args: { content: `the retry budget for this release is ${RETRY_BUDGET}` } });
        const loadedNotes = await loadNotes.execute({ args: {} });
        const block = await notes.stepBlock({ preload: true });
        log.info({ m: `announce: ${notes.startupAnnounce()}` });
        log.info({ m: `load_case_notes → ${String(loadedNotes)}` });
        check({ name: 'D: the LoadableComponent saved and loaded its payload', ok: saved?.success === true && String(loadedNotes).includes(RETRY_BUDGET), detail: String(loadedNotes) });
        check({ name: 'D: preload injects the block and start announces once', ok: String(block).includes(RETRY_BUDGET) && String(notes.startupAnnounce()).includes('save_case_notes'), detail: 'block + announce present' });

        /** @type {{n: number}} */
        const digestRuns = { n: 0 };
        const files = new ExternalToolCapability({
            id: 'files',
            loadToolName: 'load_files_tools',
            announce: 'A file tool is available: file_digest.',
            tools: [{
                name: 'file_digest',
                description: 'Reads a file from disk and returns its byte size, SHA-256 and the token line it carries.',
                parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                execute: async (/** @type {{args?: Record<string, any>}} */ { args = {} } = {}) => {
                    const filePath = String(args.path ?? '');
                    const raw = await readFile(filePath, 'utf8');
                    digestRuns.n += 1;
                    const { bytes, sha256 } = await digestOf({ filePath });
                    const token = /token:\s*(\S+)/.exec(raw)?.[1] ?? null;
                    return JSON.stringify({ file: filePath, bytes, sha256, token });
                },
            }],
        });
        const acp = new AcpCapability({
            id: 'acp',
            announce: 'A duck-typed remote tool is available: acp_word_count.',
            client: {
                listTools: async () => [{
                    name: 'acp_word_count',
                    description: 'Counts words and distinct words in a piece of text.',
                    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
                }],
                /** @param {string} name @param {Record<string, any>} args */
                callTool: async (name, args) => {
                    const words = String(args?.text ?? '').split(/\s+/).filter(Boolean);
                    return JSON.stringify({ tool: name, words: words.length, distinct: new Set(words).size });
                },
            },
        });
        await acp.connect();
        const acpTool = /** @type {any} */ (acp.tools()[0]);
        const acpDirect = /** @type {any} */ (await acpTool.execute({ args: { text: SAMPLE_TEXT } }));
        log.toolResult({ n: acpTool.name, r: acpDirect.result });
        check({ name: 'D: the AcpCapability remote tool executes', ok: acpDirect.success === true && JSON.parse(String(acpDirect.result)).words === 9, detail: String(acpDirect.result) });

        /** @type {string[]} */
        const extensionCalls = [];
        const extensionPrompt = `Call the file_digest tool exactly once on ${NOTES_FILE}. Then reply in exactly this shape, filling in the values: ${EXTENSION_MARKER} <token> <retry budget>. The token comes from the tool result; the retry budget is in the case scratchpad in your context.`;
        log.user({ m: extensionPrompt });
        const extensionAnswer = String(await client.session(toolModel)
            .withCapability({ capability: notes, preload: true })
            .withCapability({ capability: files, extraTools: files.tools() })
            .withCapability({ capability: acp, extraTools: acp.tools() })
            .withSystemMessage('You are a release assistant. Use the tools you are given; the scratchpad block in your context is authoritative.')
            .run({
                initialInput: extensionPrompt,
                options: defaultDisplay({ also: (/** @type {any} */ event) => {
                    if (event?.type === 'tool_call_start') extensionCalls.push(String(event.name));
                } }),
            }));
        warnEmptyAnswer({ answer: extensionAnswer, label: 'the capability turn' });
        log.info({ m: `capability tools advertised: ${[notes.loadToolName, notes.saveToolName, ...files.tools().map((tool) => tool.name), ...acp.tools().map((tool) => tool.name)].join(', ')}` });
        check({ name: 'D: the model called the ExternalToolCapability tool', ok: digestRuns.n >= 1 && extensionCalls.includes('file_digest'), detail: `runs=${digestRuns.n} calls=${extensionCalls.join(', ') || '(none)'}` });
        check({
            name: 'D: the answer carries the file token and the injected scratchpad value',
            ok: extensionAnswer.includes(EXTENSION_MARKER) && extensionAnswer.includes(FILE_TOKEN) && extensionAnswer.includes(RETRY_BUDGET),
            detail: log.truncate({ text: extensionAnswer, n: 160 }),
        });
    } finally {
        await mcpClient.stop();
        http.closeAllConnections?.();
        await new Promise((resolve) => http.close(() => resolve(undefined)));
    }

    // ── E: bounded output ───────────────────────────────────────────────────
    log.section({ t: 'E — bounded output: the cap the model actually sees' });
    const longText = `ledger entry ${'x'.repeat(400)}`;
    const cappedText = capToolOutput({ text: longText, maxLength: 80 });
    const cappedValue = capToolOutputValue({ value: { report: longText, nested: { detail: longText } }, maxLength: 120 });
    log.option({ name: 'cap.maxLength', value: '80 (text) · 120 (object)', source: 'capToolOutput / capToolOutputValue' });
    check({ name: 'E: text is shortened and marked', ok: cappedText.length < longText.length && cappedText.endsWith(TOOL_OUTPUT_TRUNCATION_SUFFIX), detail: `${cappedText.length} chars` });
    check({ name: 'E: a JSON value is capped and reported as truncated', ok: cappedValue.truncated === true && JSON.stringify(cappedValue.value).length < JSON.stringify({ report: longText, nested: { detail: longText } }).length, detail: `${JSON.stringify(cappedValue.value).length} chars, shape=${Object.keys(/** @type {Record<string, any>} */ (cappedValue.value)).join(',')}` });

    // ── F: artifacts ────────────────────────────────────────────────────────
    log.section({ t: 'F — artifacts: a path instead of megabytes' });
    const artifactTool = /** @type {any} */ (createSaveArtifactTool({ dir: ARTIFACTS }));
    const v1 = String(await artifactTool.execute({ args: { name: 'staging-report.md', content: ARTIFACT_TEXT } }));
    const v2 = String(await artifactTool.execute({ args: { name: 'staging-report.md', content: `${ARTIFACT_TEXT}\n\nAmended: rollback rehearsed.` } }));
    const manifest = JSON.parse(await readFile(join(ARTIFACTS, '.artifacts.json'), 'utf8'));
    log.toolResult({ n: 'save_artifact', r: `${v1} · ${v2}` });
    check({ name: 'F: the second save wrote a new versioned file', ok: v1 !== v2 && String(await readFile(v2, 'utf8')).includes('Amended'), detail: `${v1.split('/').pop()} → ${v2.split('/').pop()}` });
    check({ name: 'F: the manifest records both versions', ok: Array.isArray(manifest.entries) && manifest.entries.length === 2, detail: JSON.stringify(manifest.entries?.map((/** @type {any} */ entry) => entry.version)) });

    // ── G: the environment block a host injects ─────────────────────────────
    log.section({ t: 'G — the environment block and the workspace instructions' });
    const envBlock = await buildEnvironmentBlock({ root: WORKSPACE });
    const instructions = await discoverInstructions({ root: WORKSPACE, stopAt: WORKSPACE });
    log.info({ m: envBlock });
    log.info({ m: `instructions: ${String(instructions).length} char(s)` });
    check({ name: 'G: the environment block names the workspace and the platform', ok: envBlock.includes(WORKSPACE) && envBlock.includes(process.platform), detail: `platform=${process.platform}` });
    check({ name: 'G: the AGENTS.md instructions were discovered', ok: String(instructions).includes('Never invent a deployment result'), detail: `${String(instructions).length} char(s)` });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'The SDK served MCP over HTTP and extended its own session.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
