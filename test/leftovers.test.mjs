// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentLauncher } from '../lib/agentic/cli/launcher.mjs';
import { ExponentialBackoffPolicy } from '../lib/support/retry-policy.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { ConfigurationError, BackendError } from '../lib/core/errors.mjs';
import { mapProfileListError } from '../lib/support/utils.mjs';

// ─── L1: launcher extractor failure ─────────────────────────────────────────

test('L1 an extractor that returns text yields an error event, not silence', async () => {
    const extractorSession = {
        provider: 'OAI',
        withTools() { return this; },
        withSystemMessage() { return this; },
        withParameters() { return this; },
        step() {
            return (async function* () {
                yield { type: 'text', content: 'I will not call a tool' };
                return { done: true, messages: [], thoughtSignature: null };
            })();
        },
    };
    const client = /** @type {any} */ ({ session: () => extractorSession });
    const launcher = new AgentLauncher({ client, provider: 'OAI', model: 'test-model' });
    launcher.withSkills({ skills: [{ name: 'echo', command: '/echo', description: 'd', instructions: 'i' }] });

    const gen = launcher.processInput({ userInput: '/echo hello' });
    /** @type {any[]} */
    const events =  ([]);
    for (let i = 0; i < 10; i++) {
        const { value, done } = await gen.next();
        if (done) break;
        events.push(value);
    }
    assert.ok(
        events.some(e => e.type === 'text' && e.content.includes("produced no tool call")),
        'the caller must be told the extraction failed, not left hanging'
    );
});

test('L1 an unknown command still yields the Unknown command error', async () => {
    const client = /** @type {any} */ ({ session: () => ({ provider: 'OAI', withTools() { return this; } }) });
    const launcher = new AgentLauncher({ client, provider: 'OAI', model: 'test-model' });
    launcher.withSkills({ skills: [{ name: 'echo', command: '/echo', description: 'd', instructions: 'i' }] });
    const gen = launcher.processInput({ userInput: '/nope x' });
    const { value, done } = await gen.next();
    assert.equal(done, false);
    assert.ok( (/** @type {any} */ (value)).content.includes('Unknown command'), 'unmatched commands must error');
});

// ─── L3: JAI timeout messages are retryable ─────────────────────────────────

test('L3 JAI header/body timeout messages match the retry policy', () => {
    const p = new ExponentialBackoffPolicy({ maxRetries: 1 });
    const header = new Error('JAI gateway did not respond with headers within 600000ms (header timeout)');
    assert.equal(p.shouldRetry({ error: header, attempt: 0 }).retry, true, 'a header stall is transient');
    const body = new Error('JAI gateway did not deliver the response body within 5000ms (body timeout)');
    assert.equal(p.shouldRetry({ error: body, attempt: 0 }).retry, true, 'a body stall is transient');
    const coded = Object.assign(new Error('unrelated wording'), { code: 'HEADER_TIMEOUT' });
    assert.equal(p.shouldRetry({ error: coded, attempt: 0 }).retry, true, 'the typed timeout code retries without message match');
});

// ─── L4: StateMachine condition validation ──────────────────────────────────

test('L4 a boolean edge condition is rejected as a configuration error', () => {
    const graph = {
        entry: 'a',
        nodes: [
            { id: 'a', execute: () => {} },
            { id: 'b', execute: () => {}, terminal: true },
        ],
        edges: [{ from: 'a', to: 'b', condition: true }],
    };
    assert.throws(() => new StateMachine({ graph: graph }), ConfigurationError);
});

test('L4 a string edge condition is compiled by the constructor (hand-built graphs work)', async () => {
    const graph = {
        entry: 'a',
        nodes: [
            { id: 'a', execute: /** @type {(...args: any[]) => any} */ (( ctx) => ctx.set({ k: 'score', v: 9 })) },
            { id: 'done', execute: () => 'ok', terminal: true },
            { id: 'retry', execute: () => 'retry' },
        ],
        edges: [
            { from: 'a', to: 'done', condition: "ctx.get('score') >= 8" },
            { from: 'a', to: 'retry' },
        ],
    };
    const sm = new StateMachine({ graph: graph });
    const { to } = await sm.step();
    assert.equal(to, 'done', 'a compiled string condition must route the transition');
});

// ─── L8: mapProfileListError typing ─────────────────────────────────────────

test('L8 mapProfileListError throws BackendError with the stable .code contract', () => {
    assert.throws(
        () => mapProfileListError({ error: Object.assign(new Error('denied'), { status: 401 }) }),
        (e) => e instanceof BackendError && e.code === 'AUTH_FAILURE' && e.status === 401
    );
    assert.throws(
        () => mapProfileListError({ error: Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }) }),
        (e) => e instanceof BackendError && e.code === 'NETWORK_FAILURE'
    );
});
