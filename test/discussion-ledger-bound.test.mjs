// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { ProviderType, FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';


/** @param {{onRun: *, options?: *}} arg0 */
function makeSession({ onRun, options = {} }) {
    const stubSession = {
        withSystemMessage() { return this; },
        withTools() { return this; },
        withTodos() { return this; },
        withRetryPolicy() { return this; },
        withStreamTimeout() { return this; },
        /** @param {{initialInput: *}} arg0 */
        async run({ initialInput: history }) { return onRun(history); },
    };
    const session = new DiscussionSession({ client: { session: () => stubSession }, options });
    session.addAgent({ name: 'alpha', model: 'm', provider: ProviderType.OPENAI });
    return session;
}


/** @param {{session: *, count: *}} arg0 */
function seed({ session, count }) {
    for (let i = 0; i < count; i++) {
        session.appendLedger({ entries: [{ author: 'A', content: `e${i}`, type: 'discussion', thoughtSignature: null }] });
    }
}


/** @param {any} history */
/** @param {{history: *}} arg0 */
/** @param {{history: *}} arg0 */
const text = ({ history }) => history.map(/** @type {(...args: any[]) => any} */ (( m) => String(m.content))).join('\n');

describe('discussion ledger memory bound (Phase 1)', () => {
    it('caps the ledger, records the prune, and keeps the newest entries', async () => {
        let n = 0;
        const session = makeSession({ onRun: () => `out${++n}`, options: { maxLedgerEntries: 5 } });
        
        /** @type {any[]} */
                const prunes = [];
        session.on('discussion:ledger_pruned', (e) => prunes.push(e));

        const r = await session.discuss({ instruction: 'go', turns: 12, sequential: true });

        assert.equal(r.turns, 12);
        assert.equal(session.getLedger().length, 5, 'retained entries never exceed the cap');
        assert.ok(prunes.length > 0, 'the prune is observable');
        assert.equal(
            prunes.reduce((s, e) => s + e.dropped, 0), 7,
            'exactly the overflow (12 - 5) was evicted'
        );
        assert.equal(prunes.at(-1).cap, 5);
        assert.equal( (/** @type {any} */ (session.getLedger().at(-1))).content, 'out12', 'newest entry survives');
        assert.equal( (/** @type {any} */ (session.getLedger()[0])).content, 'out8', 'oldest retained is out8');
    });

    it('0 / Infinity disables the cap', async () => {
        for (const max of [0, Infinity]) {
            let n = 0;
            const session = makeSession({ onRun: () => `o${++n}`, options: { maxLedgerEntries: max } });
            await session.discuss({ instruction: 'go', turns: 8, sequential: true });
            assert.equal(session.getLedger().length, 8, `unbounded for maxLedgerEntries=${max}`);
        }
    });

    it('never silently drops: an omission marker rides the next context', async () => {
        let n = 0;
         /** @type {any} */
                  let captured = null;
        const session = makeSession({ onRun: /** @type {(...args: any[]) => any} */ ((history) => { captured = history; return `o${++n}`; }), options: { maxLedgerEntries: 2 } });

        await session.discuss({ instruction: 'go', turns: 5, sequential: true });
        captured = null;
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });

        const joined = text({ history: captured });
        assert.ok(joined.includes('[Earlier discussion entries omitted]'), 'omission marker present');
        assert.match(joined, /3 entries pruned \(ledger cap 2\)/);
    });

    it('a prune never injects a fake ledger entry (guards stay correct)', async () => {
        let n = 0;
        const session = makeSession({ onRun: () => `o${++n}`, options: { maxLedgerEntries: 2 } });
        await session.discuss({ instruction: 'go', turns: 6, sequential: true });
        const ledger = session.getLedger();
        assert.equal(ledger.length, 2);
        assert.ok(
            ledger.every(( e) => /^o\d+$/.test(String(/** @type {any} */ (e).content))),
            'only real agent entries remain — no synthetic marker in the ledger'
        );
        assert.ok(!ledger.some(( e) => /** @type {any} */ (e).content?.startsWith?.('[Earlier')), 'no marker entry');
    });

    it('tail folding still works after a prune', async () => {
        let n = 0;
         /** @type {any} */
                  let captured = null;
        
        /** @type {string[]} */
                const summarized = [];
        const session = makeSession({ onRun: /** @type {(...args: any[]) => any} */ ((history) => { captured = history; return `o${++n}`; }), options: { maxLedgerEntries: 2 } });

        await session.discuss({ instruction: 'go', turns: 5, sequential: true });
        captured = null;
        await session.discuss({ instruction: 'go', turns: 1, sequential: true, tail: 1, summarize: /** @type {(...args: any[]) => any} */ (async (t) => { summarized.push(t); return 'SUM'; }) });

        assert.equal(summarized.length, 1, 'the dropped retained prefix was folded');
        assert.ok(summarized[0].includes('o4'), 'the fold covers the retained head');
        assert.ok(!summarized[0].includes('o1'), 'evicted entries are gone — not re-folded');
        assert.ok(text({ history: captured }).includes('[Earlier discussion summary]: SUM'), 'the fold rides the context');
    });

    it('reset clears the pruned state', async () => {
        let n = 0;
         /** @type {any} */
                  let captured = null;
        const session = makeSession({ onRun: /** @type {(...args: any[]) => any} */ ((history) => { captured = history; return `o${++n}`; }), options: { maxLedgerEntries: 2 } });

        await session.discuss({ instruction: 'go', turns: 4, sequential: true });
        session.reset();
        captured = null;
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });

        assert.ok(
            !text({ history: captured }).includes('[Earlier discussion entries omitted]'),
            'no stale omission marker after reset'
        );
    });

    it('planForEach still gates dependents after a ledger prune (no positional read)', async () => {
        
        /** @type {any[]} */
                const execCalls = [];
        const client = {
            execCalls,
            session() {
                
                /** @type {any} */
                                const s = {
                    provider: 'openai',
                    /** @param {*} m */
                    withSystemMessage( m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                    withTools() { return this; },
                    withParameters() { return this; },
                    /** @param {{initialInput: *}} arg0 */
                    async run({ initialInput: input }) {
                        const t = typeof input === 'string' ? input : String(input[0]?.content ?? '');
                        if (this.sys && this.sys.includes('DAG Workflow Planner')) {
                            return JSON.stringify({
                                summary: 'plan',
                                steps: [
                                    { id: 'gather', title: 'Gather', systemPrompt: 'Gather facts', userPromptTemplate: 'Gather.', dependencies: [] },
                                    { id: 'write', title: 'Write', systemPrompt: 'Write up', userPromptTemplate: 'Write using: {{gather.output}}', dependencies: ['gather'] }
                                ]
                            });
                        }
                        if (this.sys && this.sys.includes('Gather facts')) {
                            return FALLBACK_MESSAGE.EMPTY_RESPONSE;
                        }
                        execCalls.push(t);
                        return `answer from ${this.sys ?? 'no-sys'}`;
                    }
                };
                return s;
            }
        };
        const group = new DiscussionSession({ client, options: { maxLedgerEntries: 2 } });
        group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
        seed({ session: group, count: 3 });

        await group.planForEach({ instruction: 'topic' });

        assert.equal(execCalls.length, 0, 'the dependent never ran');
        assert.ok(group.getLedger().length <= 2, 'the ledger stayed bounded through the plan');
        const errorEntries = group.getLedger().filter(( e) => String(/** @type {any} */ (e).content).startsWith('[error:'));
        assert.ok(
            errorEntries.some(( e) => /** @type {any} */ (e).content.includes('dependency "gather" failed')),
            'the skip names the failed dependency after the prune'
        );
    });
});

describe('discussion ledger summarize on demand (Phase 2)', () => {
    it('folds the evicted prefix and injects the summary', async () => {
        let n = 0;
         /** @type {any} */
                  let captured = null;
        const session = makeSession({ onRun: /** @type {(...args: any[]) => any} */ ((history) => { captured = history; return `o${++n}`; }), options: { maxLedgerEntries: 2 } });
        seed({ session, count: 5 });
        
        /** @type {any[]} */
                const events = [];
        session.on('discussion:ledger_pruned', (e) => events.push(e));

        const res = await session.summarizeLedger({ summarize: /** @type {(...args: any[]) => any} */ (async ( t) => `SUMMARY(${t})`) });

        assert.equal(res.summarized, true);
        assert.equal(res.dropped, 3);
        assert.equal(session.getLedger().length, 2, 'kept to the cap');
        assert.ok(res.summary?.includes('SUMMARY('));
        assert.equal(events.at(-1).summarized, true);
        assert.equal(events.at(-1).dropped, 3);

        captured = null;
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });
        const joined = text({ history: captured });
        assert.ok(joined.includes('[Earlier discussion summary]'), 'summary replaces the count marker');
        assert.ok(joined.includes('SUMMARY('), 'the folded text is visible');
    });

    it('a failed summarizer keeps the count marker (never silent)', async () => {
        let n = 0;
         /** @type {any} */
                  let captured = null;
        const session = makeSession({ onRun: /** @type {(...args: any[]) => any} */ ((history) => { captured = history; return `o${++n}`; }), options: { maxLedgerEntries: 2 } });
        seed({ session, count: 5 });

        const res = await session.summarizeLedger({ summarize: async () => { throw new Error('down'); } });

        assert.equal(res.summarized, false);
        assert.equal(res.dropped, 3);
        assert.equal(session.getLedger().length, 2);
        captured = null;
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });
        const joined = text({ history: captured });
        assert.ok(joined.includes('[Earlier discussion entries omitted]'), 'count marker remains');
        assert.match(joined, /3 entries pruned/);
    });

    it('honors an explicit keep (usable with the cap off)', async () => {
        let n = 0;
        const session = makeSession({ onRun: () => `o${++n}`, options: { maxLedgerEntries: 0 } });
        seed({ session, count: 6 });
        const res = await session.summarizeLedger({ keep: 1, summarize: async () => 'S' });
        assert.equal(res.dropped, 5);
        assert.equal(res.summarized, true);
        assert.equal(session.getLedger().length, 1);
    });

    it('is a no-op when nothing would be evicted', async () => {
        const session = makeSession({ onRun: () => 'ok', options: { maxLedgerEntries: 10 } });
        seed({ session, count: 1 });
        const res = await session.summarizeLedger({ summarize: async () => 'S' });
        assert.deepEqual(res, { summarized: false, dropped: 0, summary: null });
        assert.equal(session.getLedger().length, 1);
    });
});

describe('discussion ledger automatic summarize mode (Phase 2b)', () => {
    it('folds each overflow in the background and injects the summary', async () => {
        let n = 0;
         /** @type {any} */
                  let captured = null;
        
        /** @type {string[]} */
                const calls = [];
        const session = makeSession({ onRun: /** @type {(...args: any[]) => any} */ ((history) => { captured = history; return `o${++n}`; }), options: {
            maxLedgerEntries: 2,
            ledgerPruneMode: 'summarize',
            /** @param {{t: *}} arg0 */
            ledgerSummarize: async ({ t }) => { calls.push(t); return `AUTO(${t})`; },
        } });
        
        /** @type {any[]} */
                const events = [];
        session.on('discussion:ledger_pruned', (e) => events.push(e));

        await session.discuss({ instruction: 'go', turns: 4, sequential: true });

        assert.ok(calls.length >= 1, 'the background fold ran');
        const joined = text({ history: captured });
        assert.ok(joined.includes('[Earlier discussion summary]'), 'summary injected, not the count marker');
        assert.ok(joined.includes('AUTO('), 'the folded text is visible');
        assert.ok(
            events.some((e) => e.summarized === true && e.summary?.includes('AUTO(')),
            'the prune event carries the summary'
        );
    });

    it('a failed automatic fold falls back to the count marker (never silent)', async () => {
        let n = 0;
         /** @type {any} */
                  let captured = null;
        const session = makeSession({ onRun: /** @type {(...args: any[]) => any} */ ((history) => { captured = history; return `o${++n}`; }), options: {
            maxLedgerEntries: 2,
            ledgerPruneMode: 'summarize',
            ledgerSummarize: async () => { throw new Error('down'); },
        } });

        await session.discuss({ instruction: 'go', turns: 4, sequential: true });

        const joined = text({ history: captured });
        assert.ok(joined.includes('[Earlier discussion entries omitted]'), 'count marker fallback');
        assert.ok(!joined.includes('[Earlier discussion summary]'), 'no fabricated summary');
    });

    it('ledgerSummarize:false disables the fold (marker fallback)', async () => {
        let n = 0;
         /** @type {any} */
                  let captured = null;
        const session = makeSession({ onRun: /** @type {(...args: any[]) => any} */ ((history) => { captured = history; return `o${++n}`; }), options: {
            maxLedgerEntries: 2,
            ledgerPruneMode: 'summarize',
            ledgerSummarize: false,
        } });

        await session.discuss({ instruction: 'go', turns: 4, sequential: true });

        assert.ok(text({ history: captured }).includes('[Earlier discussion entries omitted]'), 'marker path taken');
    });

    it('an invalid ledgerPruneMode is rejected', () => {
        assert.throws(
            () => makeSession({ onRun: () => 'ok', options: { ledgerPruneMode: 'nope' } }),
            /ledgerPruneMode must be 'marker' or 'summarize'/
        );
    });

    it('addAgent rejects a duplicate name and the reserved author names', () => {
        const session = makeSession({ onRun: () => 'ok' });
        assert.throws(
            () => session.addAgent({ name: 'alpha', model: 'm', provider: ProviderType.OPENAI }),
            /already exists/,
            'a duplicate name would make each agent read the other\'s turns as its own'
        );
        assert.throws(
            () => session.addAgent({ name: 'Judge', model: 'm', provider: ProviderType.OPENAI }),
            /reserved/,
            'Judge is the fixed author of the judge turn'
        );
        assert.throws(
            () => session.addAgent({ name: 'Aggregator', model: 'm', provider: ProviderType.OPENAI }),
            /reserved/,
            'Aggregator is the fixed author of the aggregated turn'
        );
    });

    it('judge and aggregate reject an author name an agent already uses', async () => {
        const session = makeSession({ onRun: () => 'ok' });
        // The second door: the per-call name override would recreate the collision
        // addAgent refuses, and the judge turn would replay as agent alpha's own.
        await assert.rejects(
            () => session.judge({ instruction: 'pick one', options: { name: 'alpha' } }),
            /already exists/,
            'judge honours the same author uniqueness as addAgent'
        );
        await assert.rejects(
            () => session.aggregate({ options: { name: 'alpha' } }),
            /already exists/,
            'aggregate honours it too'
        );
    });
});
