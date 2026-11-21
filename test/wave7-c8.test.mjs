// @ts-check

/**
 * Wave 7 / C8 — `planForEach` is no longer a second, fail-open DAG interpreter.
 *
 * It used to warn on an unknown dependency and carry on, so the dependent ran with an
 * `[UNRESOLVED: …]` reference. The plan is now validated once through the shared
 * `Plan` type (duplicate ids, unknown dependencies, cycles) before any step runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';

/** @param {{steps: any[]|((n: number) => any[])}} arg0 */
function makeClient({ steps }) {
    /** @type {any[]} */
    const calls = [];
    let plans = 0;
    const client = {
        calls,
        session(/** @type {any} */ model) {
            const s = /** @type {any} */ ({
                provider: 'openai',
                sys: model,
                withSystemMessage(/** @type {any} */ m) { s.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return s; },
                withTools() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                withRetryPolicy() { return s; },
                withStreamTimeout() { return s; },
                async run(/** @type {{initialInput: any, options: any}} */ { initialInput, options }) {
                    calls.push({ sys: s.sys, initialInput, options });
                    if (String(s.sys ?? '').includes('DAG Workflow Planner')) {
                        plans += 1;
                        const list = typeof steps === 'function' ? steps(plans) : steps;
                        return JSON.stringify({ summary: 'plan', steps: list });
                    }
                    return 'STEP-OUT';
                },
            });
            return s;
        },
    };
    return client;
}

/** @param {any} client */
function group(client) {
    const session = new DiscussionSession({ client });
    session.addAgent({ name: 'A', persona: 'Do the work.', model: 'm', provider: 'openai' });
    return session;
}

const gather = { id: 'gather', title: 'Gather', systemPrompt: 'Gather', userPromptTemplate: 'Gather', dependencies: [] };
const write = { id: 'write', title: 'Write', systemPrompt: 'Write', userPromptTemplate: 'Write from {{gather.output}}', dependencies: ['gather'] };

test('C8/unknown-dep: a plan naming a missing dependency is rejected before any step runs', async () => {
    const client = makeClient({ steps: [gather, { ...write, dependencies: ['ghost'] }] });
    await assert.rejects(() => group(client).planForEach({ instruction: 'topic' }), /planned an invalid DAG .*unknown node 'ghost'/);
    assert.equal(client.calls.length, 1, 'only the planner ran — no step was executed');
});

test('C8/cycle: a cyclic plan is rejected before any step runs', async () => {
    const client = makeClient({ steps: [
        { ...gather, dependencies: ['write'] },
        { ...write },
    ] });
    await assert.rejects(() => group(client).planForEach({ instruction: 'topic' }), /planned an invalid DAG .*not a DAG/);
    assert.equal(client.calls.length, 1);
});

test('C8/duplicate: duplicate step ids are rejected before any step runs', async () => {
    const client = makeClient({ steps: [gather, { ...write, id: 'gather' }] });
    await assert.rejects(() => group(client).planForEach({ instruction: 'topic' }), /planned an invalid DAG .*duplicate/);
    assert.equal(client.calls.length, 1);
});

test('C8/valid-plan: a valid plan still runs every step, in dependency order', async () => {
    const client = makeClient({ steps: [gather, write] });
    await group(client).planForEach({ instruction: 'topic' });
    assert.equal(client.calls.length, 3, 'planner + two steps');
    const stepCalls = client.calls.slice(1);
    assert.match(JSON.stringify(stepCalls[0]?.initialInput), /Gather/);
    assert.match(JSON.stringify(stepCalls[1]?.initialInput), /STEP-OUT|gather/i, 'the dependent saw the upstream output');
});

test('C8/failed-dependency: a failed upstream still skips its dependent (unchanged behaviour)', async () => {
    const client = makeClient({ steps: [gather, write] });
    const original = client.session;
    client.session = (/** @type {any} */ model) => {
        const s = original(model);
        const run = s.run;
        s.run = async (/** @type {any} */ arg) => {
            const out = await run(arg);
            return String(s.sys ?? '').includes('Gather') ? FALLBACK_MESSAGE.EMPTY_RESPONSE : out;
        };
        return s;
    };
    const session = group(client);
    await session.planForEach({ instruction: 'topic' });
    assert.equal(client.calls.length, 2, 'the planner and the failing step ran; the dependent was skipped');
});

test('C8/unknown-template: a template reference to a missing step is rejected too', async () => {
    const client = makeClient({ steps: [gather, { ...write, userPromptTemplate: 'Write from {{ghost.output}}' }] });
    await assert.rejects(() => group(client).planForEach({ instruction: 'topic' }), /planned an invalid DAG .*Unknown template reference/);
    assert.equal(client.calls.length, 1, 'no step ran');
});

test('C8/multi-agent-atomic: one agent with an invalid plan stops the others before they run', async () => {
    const client = makeClient({ steps: (n) => (n === 1 ? [gather, write] : [gather, { ...write, dependencies: ['ghost'] }]) });
    const session = group(client);
    session.addAgent({ name: 'B', persona: 'Second.', model: 'm', provider: 'openai' });
    await assert.rejects(() => session.planForEach({ instruction: 'topic' }), /agent "B" planned an invalid DAG/);
    assert.equal(client.calls.length, 2, 'both plans were made; no step ran for either agent');
});
