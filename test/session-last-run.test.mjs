// @ts-check

/**
 * @file `getLastRun()` — the public run result, without `_lastStepMessages`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';

/**
 * A session carrying only the fields the getter reads.
 * @param {Record<string, unknown>} [fields]
 */
function fakeSession(fields = {}) {
    const session = Object.create(ChatSessionBuilder.prototype);
    return Object.assign(session, fields);
}

test('getLastRun returns the deliverable, rows, usage, citations, and sources', () => {
    const session = fakeSession({
        _lastRunText: 'final answer',
        _lastStepMessages: [{ role: 'assistant', content: 'final answer' }],
        _lastRunUsage: { total_tokens: 3 },
        _lastRunCitations: [{ title: 'a source' }],
        _lastRunSources: [{ url: 'https://example.com' }]
    });

    const run = session.getLastRun();
    assert.deepEqual(run, {
        text: 'final answer',
        messages: [{ role: 'assistant', content: 'final answer' }],
        usage: { total_tokens: 3 },
        citations: [{ title: 'a source' }],
        sources: [{ url: 'https://example.com' }]
    });

    run.messages.push({ role: 'user', content: 'x' });
    run.citations.pop();
    assert.equal(session._lastStepMessages.length, 1, 'the rows are a copy');
    assert.equal(session._lastRunCitations.length, 1, 'the citations are a copy');
});

test('getLastRun is empty before a run and after a failed run cleared its state', () => {
    // `step()` clears `_lastRunText` alongside usage and rows, so a failed run
    // cannot return the previous run's text with the failed run's usage.
    const session = fakeSession({
        _lastRunText: null,
        _lastStepMessages: null,
        _lastRunUsage: null,
        _lastRunCitations: null,
        _lastRunSources: null
    });
    assert.deepEqual(session.getLastRun(), {
        text: '',
        messages: [],
        usage: null,
        citations: [],
        sources: []
    });
});
