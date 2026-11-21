// @ts-check
/**
 * @file `withAdditionalTools` appends to the list `withTools` set instead of
 * replacing it, and replaces a tool of the same name.
 * @version 0.12.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';


/**
 * A tool definition good enough for the session's wiring.
 * @param {{name: string, description?: string}} arg0 -
 * @returns {{name: string, description: string, parameters: {type: 'object', properties: Record<string, never>}, execute: () => Promise<string>}}
 */
function tool({ name, description = name }) {
    return {
        name,
        description,
        parameters: { type: 'object', properties: {} },
        execute: async () => name
    };
}


test('withAdditionalTools keeps the withTools list and replaces a same-name tool', () => {
    const session = new ChatSessionBuilder().withTools({ tools: [tool({ name: 'read' }), tool({ name: 'grep', description: 'old' })] });

    const returned = session.withAdditionalTools({ tools: [tool({ name: 'lint' }), tool({ name: 'grep', description: 'new' })] });
    assert.equal(returned, session);

    const names = session._tools.map((entry) => entry?.name);
    assert.equal(names.length, 3, 'the host list survives and no duplicate is added');
    assert.ok(names.includes('read'));
    assert.ok(names.includes('lint'));
    const greps = session._tools.filter((entry) => entry?.name === 'grep');
    assert.equal(greps.length, 1);
    assert.equal(greps[0]?.description, 'new');
});

test('withAdditionalTools works on a builder with no tools yet', () => {
    const session = new ChatSessionBuilder().withAdditionalTools({ tools: [tool({ name: 'only' })] });
    assert.deepEqual(session._tools.map((entry) => entry?.name), ['only']);
});

test('replace: false refuses to overwrite a host tool', () => {
    const session = new ChatSessionBuilder().withTools({ tools: [tool({ name: 'write_file', description: 'host' })] });
    assert.throws(
        () => session.withAdditionalTools({ tools: [tool({ name: 'write_file', description: 'file' })], replace: false }),
        (error) => /** @type {any} */ (error).code === 'MERCI-CONFIG-ERR'
    );
    assert.equal(session._tools[0]?.description, 'host', 'the host tool is untouched');
});
