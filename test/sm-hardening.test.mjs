// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { StateMachine } from '../lib/agentic/state-machine/index.mjs';


/** @param {{store?: *}} arg0 */
function recordingClient({ store = [] } = {}) {
    return {
        session: () => {
            
            /** @type {any} */
                        const session =  (new Proxy(/** @type {any} */ ({ provider: 'openai', model: 'm', eventEmitter: { emit() {} }, _tools: [] }), {
                get(target, prop) {
                    if (prop === 'run') return /** @type {(...args: any[]) => any} */ (async ({ options }) => { session._runOpts = options; return 'answer'; });
                    if (typeof prop === 'string' && prop.startsWith('with')) return () => session;
                    return target[prop];
                },
                set(target, prop, value) { target[prop] = value; return true; },
            }));
            store.push(session);
            return session;
        },
    };
}

describe('2E SM: graph validation', () => {
    it('rejects duplicate node ids', () => {
        assert.throws(() => new StateMachine({ graph: {
            entry: 'a',
            nodes: [{ id: 'a', execute: () => 1, terminal: true }, { id: 'a', execute: () => 2 }],
            edges: [],
        } }), /duplicate node ids: a/);
    });
});

describe('2E SM: verify contract', () => {
    it('a throwing verify becomes a failed check with evidence, not an unhandled throw', async () => {
        let calls = 0;
        const sm = new StateMachine({ graph: {
            entry: 'a',
            nodes: [{
                id: 'a',
                execute: () => { calls++; return 'x'; },
                verify: () => { throw new Error('verify exploded'); },
                terminal: true,
            }],
            edges: [],
        }, options: { contract: { maxRetries: 2 } } });
        await assert.rejects(() => sm.run(), /failed verification/);
        assert.equal(calls, 3, 'the global attempt cap still applies (maxRetries 2 → 3 attempts)');
        assert.equal(sm.phase, 'escalated');
    });

    it('verify receives the run signal as its third argument', async () => {
        const ac = new AbortController();
        
        /** @type {any} */
                let seen = null;
        const sm = new StateMachine({ graph: {
            entry: 'a',
            nodes: [{
                id: 'a',
                execute: () => 'x',
                verify: /** @type {(...args: any[]) => any} */ (( _out,  _ctx,  signal) => { seen = signal; return { passed: true }; }),
                terminal: true,
            }],
            edges: [],
        } });
        await sm.run({ signal: ac.signal });
        assert.equal(seen, ac.signal);
    });

    it('maxVisits is authoritative across verify retries', async () => {
        let calls = 0;
        const sm = new StateMachine({ graph: {
            entry: 'a',
            nodes: [{
                id: 'a',
                execute: () => { calls++; return 'bad'; },
                verify: () => ({ passed: false, evidence: 'nope' }),
                maxVisits: 1,
                terminal: true,
            }],
            edges: [],
        }, options: { contract: { maxRetries: 5 } } });
        await assert.rejects(() => sm.run(), /maxVisits/);
        assert.equal(calls, 1, 'the retry loop must not bypass maxVisits');
    });
});

describe('2E SM: node timeout', () => {
    it('a hung execute is unblocked by node.timeoutMs', async () => {
        const sm = new StateMachine({ graph: {
            entry: 'a',
            nodes: [{ id: 'a', execute: () => new Promise(() => {}), timeoutMs: 30, terminal: true }],
            edges: [],
        } });
        await assert.rejects(() => sm.run(), /timed out after 30ms/);
    });
});

describe('2E SM: checkpoint ledger', () => {
    it('load() then run({contract}) keeps the restored fingerprint budget', async () => {
        let calls = 0;
        const graph =  ({
            entry: 'a',
            nodes: [{ id: 'a', execute: () => { calls++; return 'bad'; }, verify: () => ({ passed: false, evidence: 'nope' }), terminal: true }],
            edges: [],
        });
        const sm = new StateMachine({ graph: graph, options: { contract: { maxRetries: 2 } } });
        await assert.rejects(() => sm.run(), /failed verification/);
        const afterFirstRun = calls;
        const restored = StateMachine.load({ json: sm.save(), graph: graph, options: {} });
        await assert.rejects(() => restored.run({ contract: { maxRetries: 2 } }), /failed verification/);
        assert.equal(calls, afterFirstRun + 1, 'a spent restored budget allows the single attempt, no retries');
    });
});

describe('2E SM: correlation', () => {
    it('node session runs carry the machine runContext', async () => {
        
        /** @type {any[]} */
                const sessions = [];
        const sm = new StateMachine({ graph: {
            entry: 'a',
            nodes: [{ id: 'a', userPromptTemplate: 'do', terminal: true }],
            edges: [],
        }, options: { client: recordingClient({ store: sessions }), defaultModel: 'm' } });
        await sm.run();
        assert.ok(sessions.length >= 1);
        const ctx = sessions[0]._runOpts?.runContext;
        assert.ok(ctx && typeof ctx.runId === 'string', 'the session run must receive the machine runContext');
    });
});
