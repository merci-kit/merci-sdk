// @ts-check
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/**
 * A discussion whose single agent's session captures the exact input history of
 * the last turn.
 * @param {{onRun: (history: any[]) => string, options?: any, agents?: any[]}} arg0
 */
function makeSession({ onRun, options = {}, agents = [{ name: 'alpha', model: 'm', provider: ProviderType.OPENAI }] }) {
    const stubSession = {
        provider: ProviderType.OPENAI,
        withSystemMessage() { return this; },
        withTools() { return this; },
        withTodos() { return this; },
        withRetryPolicy() { return this; },
        withStreamTimeout() { return this; },
        withCircuitBreaker() { return this; },
        /** @param {{initialInput: any[]}} arg0 */
        async run({ initialInput }) { return onRun(initialInput); },
    };
    const session = new DiscussionSession({ client: { session: () => stubSession, provider: ProviderType.OPENAI }, options });
    for (const agent of agents) session.addAgent(agent);
    return session;
}

/** @param {any[]} history */
const capturedText = (history) => history.map((m) => String(m.content)).join('\n');

/**
 * Seeds peer entries authored by 'A'.
 * @param {any} session
 * @param {string[]} contents
 */
function seed(session, contents) {
    for (const content of contents) {
        session.appendLedger({ entries: [{ author: 'A', content, type: 'discussion', thoughtSignature: null }] });
    }
}

describe('discussion transfer policy (Phase 3)', () => {
    it('agent transfer ledger-selected renders through the shared module (its own marker framing)', async () => {
        /** @type {any[]} */
        let captured = [];
        const session = makeSession({
            onRun: (h) => { captured = h; return 'ok'; },
            agents: [{ name: 'alpha', model: 'm', provider: ProviderType.OPENAI, transfer: { preset: 'ledger-selected', tail: 1 } }],
        });
        seed(session, ['e0', 'e1', 'e2']);
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });

        const joined = capturedText(captured);
        assert.ok(joined.includes('[Earlier context omitted]'), 'module marker framing');
        assert.ok(!joined.includes('[Earlier discussion entries omitted]'), 'not the native framing');
        assert.ok(joined.includes('[A]: e2'), 'the kept tail entry survives');
        assert.ok(!joined.includes('[A]: e0'), 'the dropped prefix is gone');
    });

    it('group-level transfer applies to agents without their own', async () => {
        /** @type {any[]} */
        let captured = [];
        const session = makeSession({
            onRun: (h) => { captured = h; return 'ok'; },
            options: { transfer: { preset: 'ledger-selected', tail: 1 } },
            agents: [{ name: 'alpha', model: 'm', provider: ProviderType.OPENAI }],
        });
        seed(session, ['e0', 'e1', 'e2']);
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });

        assert.ok(capturedText(captured).includes('[Earlier context omitted]'), 'the session default reaches the agent');
    });

    it('transfer ledger replays own entries as assistant rows and peers as [author]: user rows', async () => {
        /** @type {any[]} */
        let captured = [];
        const session = makeSession({
            onRun: (h) => { captured = h; return 'ok'; },
            agents: [{ name: 'alpha', model: 'm', provider: ProviderType.OPENAI, transfer: 'ledger' }],
        });
        session.appendLedger({ entries: [
            { author: 'alpha', content: 'mine', type: 'discussion', thoughtSignature: null },
            { author: 'beta', content: 'theirs', type: 'discussion', thoughtSignature: null },
            { author: 'alpha', content: '[pass]', type: 'discussion', thoughtSignature: null, pass: true },
        ] });
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });

        assert.deepEqual(
            captured.map((m) => [m.role, String(m.content)]),
            [['assistant', 'mine'], ['user', '[beta]: theirs'], ['user', 'go']],
            'order preserved; own→assistant, peer→[author]: user, pass skipped',
        );
    });

    it('transfer ledger-compact folds the dropped prefix into a summary row', async () => {
        /** @type {any[]} */
        let captured = [];
        const session = makeSession({
            onRun: (h) => { captured = h; return 'ok'; },
            agents: [{ name: 'alpha', model: 'm', provider: ProviderType.OPENAI, transfer: { preset: 'ledger-compact', tail: 1 } }],
        });
        seed(session, ['e0', 'e1', 'e2']);
        await session.discuss({ instruction: 'go', turns: 1, sequential: true, summarize: async (/** @type {string} */ t) => `SUM(${t})` });

        const joined = capturedText(captured);
        assert.ok(joined.includes('[Earlier context omitted]'), 'summary frame');
        assert.ok(joined.includes('SUM('), 'the fold result rides the context');
        assert.ok(joined.includes('[A]: e2'), 'the kept tail entry survives');
    });

    it('unset transfer keeps the native marker framing (no regression)', async () => {
        /** @type {any[]} */
        let captured = [];
        const session = makeSession({ onRun: (h) => { captured = h; return 'ok'; } });
        seed(session, ['e0', 'e1', 'e2']);
        await session.discuss({ instruction: 'go', turns: 1, sequential: true, tail: 1 });

        const joined = capturedText(captured);
        assert.ok(joined.includes('[Earlier discussion entries omitted]'), 'native framing stays the default');
        assert.ok(!joined.includes('[Earlier context omitted]'), 'module framing is opt-in only');
    });

    it('stringify transfer honours its own select: tail window', async () => {
        /** @type {any[]} */
        let captured = [];
        const session = makeSession({
            onRun: (h) => { captured = h; return 'ok'; },
            agents: [{ name: 'alpha', model: 'm', provider: ProviderType.OPENAI, transfer: { mode: 'stringify', select: 'tail', tail: 1 } }],
        });
        seed(session, ['e0', 'e1', 'e2']);
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });

        const joined = capturedText(captured);
        assert.ok(joined.includes('[A]: e2'), 'the kept tail entry survives');
        assert.ok(!joined.includes('[A]: e0') && !joined.includes('[A]: e1'), 'the dropped prefix is gone');
        assert.ok(joined.includes('[Earlier discussion entries omitted]: 2 entries'), 'the omission marker names the window');
    });

    it('stringify transfer: an explicit tail of 0 means no window', async () => {
        /** @type {any[]} */
        let captured = [];
        const session = makeSession({
            onRun: (h) => { captured = h; return 'ok'; },
            agents: [{ name: 'alpha', model: 'm', provider: ProviderType.OPENAI, transfer: { mode: 'stringify', select: 'tail', tail: 0 } }],
        });
        seed(session, Array.from({ length: 10 }, (_, i) => `e${i}`));
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });

        const joined = capturedText(captured);
        assert.ok(joined.includes('[A]: e0'), 'nothing is dropped (the ledger-normalized 8-row window must not apply)');
        assert.ok(!joined.includes('entries omitted'), 'and no omission marker is invented');
    });

    it('stringify transfer: a window wider than the ledger drops nothing', async () => {
        /** @type {any[]} */
        let captured = [];
        const session = makeSession({
            onRun: (h) => { captured = h; return 'ok'; },
            agents: [{ name: 'alpha', model: 'm', provider: ProviderType.OPENAI, transfer: { mode: 'stringify', select: 'tail', tail: 5 } }],
        });
        seed(session, ['e0', 'e1', 'e2']);
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });

        const joined = capturedText(captured);
        assert.ok(joined.includes('[A]: e0') && joined.includes('[A]: e2'), 'everything fits');
        assert.ok(!joined.includes('entries omitted'), 'no marker for a window nothing exceeded');
    });

    it('stringify transfer: select tail without a tail uses the default window', async () => {
        /** @type {any[]} */
        let captured = [];
        const session = makeSession({
            onRun: (h) => { captured = h; return 'ok'; },
            agents: [{ name: 'alpha', model: 'm', provider: ProviderType.OPENAI, transfer: { mode: 'stringify', select: 'tail' } }],
        });
        seed(session, Array.from({ length: 10 }, (_, i) => `e${i}`));
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });

        const joined = capturedText(captured);
        assert.ok(joined.includes('[A]: e9'), 'the newest entry is kept');
        assert.ok(!joined.includes('[A]: e0'), 'the default window still trims the prefix');
        assert.ok(joined.includes('2 entries'), 'and the marker counts the two dropped rows');
    });

    it('stringify transfer honours an explicit markerLabel', async () => {
        /** @type {any[]} */
        let captured = [];
        const session = makeSession({
            onRun: (h) => { captured = h; return 'ok'; },
            agents: [{ name: 'alpha', model: 'm', provider: ProviderType.OPENAI, transfer: { mode: 'stringify', select: 'tail', tail: 1, markerLabel: 'trimmed' } }],
        });
        seed(session, ['e0', 'e1', 'e2']);
        await session.discuss({ instruction: 'go', turns: 1, sequential: true });

        const joined = capturedText(captured);
        assert.ok(joined.includes('[trimmed]: 2 entries'), 'the caller-supplied label frames the dropped prefix');
        assert.ok(!joined.includes('[Earlier discussion entries omitted]'), 'the default label is not also emitted');
    });
});
