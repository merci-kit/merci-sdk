// @ts-check
/**
 * Deferred tools: a tool with `deferLoading: true` stays out of the model's
 * request until `tool_search` finds it. Execution and permissions keep the
 * full `_tools` list, so an activated tool runs like any other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { TOOL_SEARCH_TOOL_NAME, EVENTS } from '../lib/core/constants/index.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';

/**
 * @param {{name: string, description?: string, deferLoading?: boolean, execute?: Function|null}} arg0
 * @returns {any}
 */
function tool({ name, description = '', deferLoading = false, execute = null }) {
    return {
        name,
        description,
        parameters: { type: 'object', properties: {} },
        ...(deferLoading ? { deferLoading: true } : {}),
        ...(execute ? { execute } : {}),
    };
}

/** @param {{session: any}} arg0 */
function searchTool({ session }) {
    const found = session._tools.find((/** @type {any} */ t) => t.name === TOOL_SEARCH_TOOL_NAME);
    assert.ok(found, 'tool_search is offered when a tool is deferred');
    return found;
}

test('a deferred tool is kept for execution but left out of the request', () => {
    const session = new ChatSessionBuilder().withTools({ tools: [
        tool({ name: 'read_file' }),
        tool({ name: 'deploy', description: 'Deploy to production', deferLoading: true }),
    ] });

    assert.deepEqual(session._tools.map((t) => t.name), ['read_file', 'deploy', TOOL_SEARCH_TOOL_NAME]);
    assert.deepEqual(session._requestTools().map((t) => t.name), ['read_file', TOOL_SEARCH_TOOL_NAME]);
});

test('tool_search activates its matches for the next request', async () => {
    const session = new ChatSessionBuilder().withTools({ tools: [
        tool({ name: 'read_file' }),
        tool({ name: 'deploy', description: 'Deploy to production', deferLoading: true }),
        tool({ name: 'rollback', description: 'Undo a production deploy', deferLoading: true }),
    ] });

    const search = searchTool({ session });
    const out = await search.execute({ args: { query: 'deploy production' } });
    assert.equal(out.success, true);
    assert.deepEqual(out.result.tools.map((/** @type {any} */ t) => t.name), ['deploy', 'rollback'], 'a description word matches');
    assert.deepEqual(session._requestTools().map((t) => t.name), ['read_file', 'deploy', 'rollback', TOOL_SEARCH_TOOL_NAME]);
});

test('tool_search reports no match without activating anything', async () => {
    const session = new ChatSessionBuilder().withTools({ tools: [
        tool({ name: 'deploy', deferLoading: true }),
    ] });
    const out = await searchTool({ session }).execute({ args: { query: 'nothing-like-this' } });
    assert.deepEqual(out.result.tools, []);
    assert.match(out.result.note, /No deferred tool matched/);
    assert.deepEqual(session._requestTools().map((t) => t.name), [TOOL_SEARCH_TOOL_NAME]);
});

test('tool_search caps the matches it returns and activates', async () => {
    const many = Array.from({ length: LIMITS.tool_search_max_results + 5 }, (_, i) => tool({ name: `match_${i}`, description: 'match', deferLoading: true }));
    const session = new ChatSessionBuilder().withTools({ tools: many });
    const out = await searchTool({ session }).execute({ args: { query: 'match' } });
    assert.equal(out.result.tools.length, LIMITS.tool_search_max_results);
    assert.match(out.result.note, /Showing/);
});

test('with nothing deferred there is no tool_search and the request is unchanged', () => {
    const session = new ChatSessionBuilder().withTools({ tools: [tool({ name: 'read_file' })] });
    assert.deepEqual(session._tools.map((t) => t.name), ['read_file']);
    assert.deepEqual(session._requestTools().map((t) => t.name), ['read_file']);
});

test('a denied deferred tool is not offered and does not add tool_search', () => {
    const session = new ChatSessionBuilder()
        .withPermissions({ deny: ['deploy'] })
        .withTools({ tools: [tool({ name: 'deploy', deferLoading: true })] });
    assert.deepEqual(session._tools.map((t) => t.name), []);
    assert.deepEqual(session._requestTools(), []);
});

test('an unactivated deferred tool still executes when the model calls it', async () => {
    const session = new ChatSessionBuilder().withTools({ tools: [
        tool({ name: 'deploy', deferLoading: true, execute: async () => 'deployed' }),
    ] });
    const [result] = await executeTools({
        toolCalls: [{ id: 'c1', name: 'deploy', arguments: {} }],
        toolLibrary: session._tools,
    });
    assert.equal(/** @type {any} */ (result).success, true);
    assert.equal(/** @type {any} */ (result).result, 'deployed');
});

test('the request builder receives the filtered list, not the full one', async () => {
    /** @type {string[][]} */
    const seen = [];
    const session = new OaiChatSession({ client: /** @type {any} */ ({}), model: 'm', eventEmitter: new EventEmitter() });
    session.withTools({ tools: [
        tool({ name: 'read_file' }),
        tool({ name: 'deploy', deferLoading: true }),
    ] });
    session._adapter = /** @type {any} */ ({
        vendorName: 'STUB',
        /** @param {{tools: Array<any>}} arg0 */
        buildVendorRequest: ({ tools }) => {
            seen.push(tools.map((/** @type {any} */ t) => t.name));
            return { request: {}, observability: {} };
        },
        executeVendorRequest: async () => (async function* () {})(),
        consumeStream: () => (async function* () {
            yield { type: EVENTS.STEP.TEXT, content: 'ok' };
            yield { type: EVENTS.STEP.FINISH, reason: 'stop' };
        })(),
    });

    for await (const _ of session.step({ messages: [] })) { /* drain */ }
    assert.deepEqual(seen, [['read_file', TOOL_SEARCH_TOOL_NAME]], 'the deferred tool never reached the vendor request');
});
