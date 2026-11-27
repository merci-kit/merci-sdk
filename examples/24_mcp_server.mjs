// @ts-check
/**
 * Example 24 — the MCP server child (stdio).
 *
 * `10_mcp_client.mjs` spawns this file with `process.execPath` and speaks the Model
 * Context Protocol over its stdin/stdout. Nothing here may write to stdout:
 * `childLog()` first moves the SDK logger to stderr, then `createMcpServer`
 * takes over the wire with the official stdio transport.
 *
 * The advertised tools do REAL work locally — word/line statistics and the
 * most frequent words over the text they are given — so the parent's remote
 * call returns a computed answer, not a canned payload. The JSON Schema is
 * advertised verbatim as the MCP `inputSchema`.
 *
 *   E — capabilities   : the `ask_client` tool calls BACK into the client. It
 *       asks the client for a sample (`sampling/createMessage`), for
 *       structured user input (`elicitation/create`) and for the workspace
 *       roots (`roots/list`) — the three capabilities the client declares. The
 *       client's own answers travel back into the tool's result.
 *   F — resources/prompts : one resource and one prompt are published, so the
 *       client can list them, read them and render them.
 *
 * Run: `node examples/24_mcp_server.mjs` (normally spawned by `10_mcp_client.mjs`)
 *
 * @version 0.23.0
 */
import { log } from 'merci-sdk';
import { createMcpServer } from 'merci-sdk/tools';
import { childLog } from './_shared/example-utils.mjs';

childLog();

const TOOL_NAME = 'word_stats';
const CALLBACK_TOOL = 'ask_client';
const RESOURCE_URI = 'file:///merci-example/notes.md';
const RESOURCE_MARKER = 'merci-example-notes-v1';
const PROMPT_NAME = 'word_stats_report';
const NOTES_SENTENCE = 'the quick brown fox jumps over the lazy dog';

/**
 * Counts the characters, words and lines of a text and returns its most
 * frequent words. Shared by the `word_stats` tool and the notes resource, so
 * both report the same numbers.
 * @param {{text?: string, top?: number}} arg0
 * @returns {{characters: number, words: number, lines: number, top: Array<{word: string, count: number}>}}
 */
function wordStats({ text = '', top = 3 } = {}) {
    const body = String(text);
    const words = body.split(/\s+/).filter(Boolean);
    const freq = new Map();
    for (const word of words) {
        const key = word.toLowerCase().replace(/[^a-z0-9']/g, '');
        if (key) freq.set(key, (freq.get(key) ?? 0) + 1);
    }
    const frequent = [...freq.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, Math.min(10, Math.max(1, Number(top) || 3)))
        .map(([word, count]) => ({ word, count }));
    return { characters: body.length, words: words.length, lines: body.split('\n').length, top: frequent };
}

/** The notes the published resource serves — computed, not typed by hand. */
const NOTES = [
    '# Merci SDK — MCP example notes',
    '',
    RESOURCE_MARKER,
    '',
    `The word_stats tool counts ${wordStats({ text: NOTES_SENTENCE }).words} words in: "${NOTES_SENTENCE}"`,
    '',
    'This text is served by the MCP child over stdio; the client reads it with readResource({ uri }).',
].join('\n');

/** The connected MCP server — the tool below calls back through it. */
/** @type {any} */
let server = null;

const tools = [{
    name: TOOL_NAME,
    description: 'Computes real text statistics: characters, words, lines, and the most frequent words. Returns a JSON object.',
    parameters: {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'The text to analyze.' },
            top: { type: 'integer', minimum: 1, maximum: 10, description: 'How many frequent words to return (default 3).' },
        },
        required: ['text'],
    },
    /**
     * @param {{args?: Record<string, any>}} arg0
     * @returns {Promise<string>}
     */
    execute: async ({ args = {} } = {}) => JSON.stringify(wordStats({ text: String(args.text ?? ''), top: Number(args.top) || 3 })),
}, {
    name: CALLBACK_TOOL,
    description: 'Calls back into the connected MCP client: asks it for a sample, for structured user input and for the workspace roots. The client\'s own answers come back inside the result.',
    parameters: {
        type: 'object',
        properties: {
            topic: { type: 'string', description: 'The text the server asks the client to sample.' },
        },
    },
    /**
     * @param {{args?: Record<string, any>}} arg0
     * @returns {Promise<string>}
     */
    execute: async ({ args = {} } = {}) => {
        if (!server) throw new Error('the MCP server is not connected yet');
        const topic = String(args.topic ?? 'the quick brown fox');
        // 1 — sampling: the server asks the CLIENT's model for a completion.
        const sample = await server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: `Name the animal in: ${topic}` } }],
            maxTokens: 64,
        });
        // 2 — elicitation: the server asks the CLIENT's user for input.
        const elicited = await server.elicitInput({
            message: 'Which city should the report be written for?',
            requestedSchema: {
                type: 'object',
                properties: { city: { type: 'string', description: 'The city to report on.' } },
                required: ['city'],
            },
        });
        // 3 — roots: the server asks the CLIENT which workspaces it may read.
        const listed = await server.listRoots();
        /** @type {Array<{uri?: string}>} */
        const rootList = Array.isArray(listed?.roots) ? listed.roots : [];
        return JSON.stringify({
            clientCapabilities: server.getClientCapabilities() ?? {},
            sample: { text: String(sample?.content?.text ?? ''), model: String(sample?.model ?? ''), stopReason: String(sample?.stopReason ?? '') },
            elicited: { action: String(elicited?.action ?? ''), content: elicited?.content ?? {} },
            roots: rootList.map(({ uri }) => String(uri ?? '')),
        });
    },
}];

const resources = [{
    uri: RESOURCE_URI,
    name: 'notes',
    description: 'The example notes served by the MCP child.',
    mimeType: 'text/markdown',
    /**
     * @param {{}} arg0
     * @returns {string}
     */
    read: ({ } = {}) => NOTES,
}];

const prompts = [{
    name: PROMPT_NAME,
    description: 'Asks for a word statistics report on a text.',
    arguments: [{ name: 'text', description: 'The text to report on.', required: true }],
    /**
     * @param {{text?: string}} arg0
     * @returns {{messages: Array<{role: string, content: {type: string, text: string}}>}}
     */
    render: ({ text = '' } = {}) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Report the word statistics of this text: "${text}"` } }],
    }),
}];

log.option({ name: 'transport', value: 'stdio', source: 'StdioServerTransport — stdout is protocol-only' });
log.list({ title: 'advertised tools', items: tools.map((t) => `${t.name} — ${t.description}`) });
log.list({ title: 'published resources', items: resources.map((r) => `${r.uri} — ${r.description ?? ''}`) });
log.list({ title: 'published prompts', items: prompts.map((p) => `${p.name} — ${p.description ?? ''}`) });

server = await createMcpServer({ name: 'merci-example-word-stats', version: '1.0.0', tools, resources, prompts });
log.success({ m: `${TOOL_NAME} is listening for JSON-RPC requests on stdin` });
