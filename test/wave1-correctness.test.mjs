// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { ExecutionJournal, JOURNAL_STATUS, toolJournalKey } from '../lib/agentic/journal.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { LocalFileMemoryProvider } from '../lib/agentic/memory/providers.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

// ─── C3: the resume fingerprint must cover the whole step definition ────────

/**
 * A client whose sessions count every model call and answer with a distinct
 * string, so a re-run is visible in the output.
 * @param {{calls: {n: number}}} arg0
 */
function makeCountingClient({ calls }) {
    return {
        session: () => ({
            provider: 'openai',
            model: 'm',
            _tools: [],
            eventEmitter: { emit() {} },
            withSystemMessage() { return this; },
            withTools() { return this; },
            withParameters() { return this; },
            withCircuitBreaker() { return this; },
            /**
             * @param {{initialInput: any}} arg0
             */
            run({ initialInput }) {
                if (isObjectiveRestatePrompt({ input: initialInput })) return Promise.resolve('');
                calls.n++;
                return Promise.resolve(`out-${calls.n}`);
            },
        }),
    };
}

test('C3: a restored step whose definition changed re-runs instead of shipping the pre-edit output', async () => {
    const calls = { n: 0 };
    const client = makeCountingClient({ calls });
    /** @param {string} toolName */
    const definition = (toolName) => ({
        id: 'a',
        systemPrompt: 'Be terse.',
        userPromptTemplate: 'Do the thing.',
        dependencies: [],
        tools: [{ name: toolName }],
    });

    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [definition('old_tool')] });
    const first = /** @type {any} */ (await executor.execute({ userGoal: 'goal' }));
    assert.equal(first.a.output, 'out-1', 'the first run produces its own output');
    assert.equal(calls.n, 1);

    const resumed = WorkflowExecutor.load({ json: executor.save(), options: { client, defaultModel: 'm' } });
    resumed.setSteps({ stepsList: [definition('NEW_tool')] });
    const second = /** @type {any} */ (await resumed.execute({ userGoal: 'goal' }));

    assert.equal(calls.n, 2, 'a step whose definition changed must re-run');
    assert.equal(second.a.output, 'out-2', 'the restored step must not ship the pre-edit output');
});

test('C3: a restored step whose function-valued definition changed re-runs', async () => {
    // The live step comparison (executor `stepKey`) already discriminates
    // `verify`, `errorHandlers` and `autoExtend`; the restore path must not
    // be weaker than the live path for them.
    const calls = { n: 0 };
    const client = makeCountingClient({ calls });
    /** @param {any} extra */
    const definition = (extra) => ({
        id: 'a',
        userPromptTemplate: 'Do the thing.',
        dependencies: [],
        ...extra,
    });

    // The `errorHandlers` case keeps the SAME keys and changes only the
    // function's source, so the case can only pass through the source
    // comparison (a key-set difference would pass it for the wrong reason).
    for (const [label, first, changed] of /** @type {Array<[string, any, any]>} */ ([
        ['verify', {}, { verify: () => ({ passed: true, evidence: 'ok' }) }],
        ['errorHandlers', { errorHandlers: { onError: () => 'first' } }, { errorHandlers: { onError: () => 'second' } }],
        ['autoExtend', {}, { autoExtend: { maxExtensions: 2 } }],
    ])) {
        calls.n = 0;
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
        executor.setSteps({ stepsList: [definition(first)] });
        await executor.execute({ userGoal: 'goal' });
        assert.equal(calls.n, 1, `${label}: the first run produces its own output`);

        const resumed = WorkflowExecutor.load({ json: executor.save(), options: { client, defaultModel: 'm' } });
        resumed.setSteps({ stepsList: [definition(changed)] });
        const second = /** @type {any} */ (await resumed.execute({ userGoal: 'goal' }));

        assert.equal(calls.n, 2, `${label}: a changed definition must re-run the restored step`);
        assert.equal(second.a.output, 'out-2', `${label}: must not ship the pre-edit output`);
    }
});

test('C3: a live re-plan that drops a function invalidates the step', async () => {
    // On a live re-plan a missing function IS a removal. (Across a restore it
    // is indistinguishable from a checkpoint that dropped it — the durable
    // approval wins there, see the D16 check.)
    const calls = { n: 0 };
    const client = makeCountingClient({ calls });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    const withVerify = { id: 'a', userPromptTemplate: 'go', dependencies: [], verify: () => ({ passed: true, evidence: 'ok' }) };
    const withoutVerify = { id: 'a', userPromptTemplate: 'go', dependencies: [] };

    executor.setSteps({ stepsList: [withVerify] });
    await executor.execute({ userGoal: 'goal' });
    assert.ok(executor.steps.get('a')?.output, 'the step produced an output');

    executor.setSteps({ stepsList: [withVerify] });
    assert.ok(executor.steps.get('a')?.output, 'the same plan keeps the output');

    executor.setSteps({ stepsList: [withoutVerify] });
    assert.equal(executor.steps.get('a')?.output ?? null, null, 'dropping the verify gate must invalidate the step');
});

// ─── C2: a parallel wave must not exceed the workflow token cap ─────────────

/**
 * A client whose sessions spend a fixed number of tokens, but never more than
 * the run budget they were granted — a real session stops at its own ceiling.
 * @param {{grants: Array<number>}} arg0
 */
function makeQuotaClient({ grants }) {
    return {
        session: () => {
            let granted = Number.POSITIVE_INFINITY;
            return {
                provider: 'openai',
                model: 'm',
                _tools: [],
                eventEmitter: { emit() {} },
                withSystemMessage() { return this; },
                withTools() { return this; },
                withParameters() { return this; },
                withCircuitBreaker() { return this; },
                /**
                 * @param {{messages: any}} arg0
                 */
                async *step({ messages }) {
                    const used = Math.min(60, granted);
                    yield { type: 'quota', data: { prompt_tokens: used, completion_tokens: 0 } };
                    return { done: true, content: 'answer', messages };
                },
                /**
                 * @param {{initialInput: any, options: any}} arg0
                 */
                run({ initialInput, options }) {
                    if (isObjectiveRestatePrompt({ input: initialInput })) return Promise.resolve('');
                    granted = Number(options?.budget?.maxTotalTokens ?? Number.POSITIVE_INFINITY);
                    grants.push(granted);
                    return runAgenticLoop({ session: /** @type {any} */ (this), messages: initialInput, opts: options });
                },
            };
        },
    };
}

test('C2: a parallel wave cannot spend more than the workflow token cap', async () => {
    const grants = /** @type {Array<number>} */ ([]);
    const client = makeQuotaClient({ grants });
    const executor = new WorkflowExecutor({
        options: { client, defaultModel: 'm', budget: { maxTotalTokens: 100 } },
    });
    executor.setSteps({
        stepsList: [
            { id: 'p1', userPromptTemplate: 'first', dependencies: [] },
            { id: 'p2', userPromptTemplate: 'second', dependencies: [] },
        ],
    });

    /** @type {any} */
    let failure = null;
    try {
        await executor.execute({ userGoal: 'goal' });
    } catch (err) {
        failure = err;
    }

    assert.equal(failure, null, `the wave must stay inside the cap (${failure && failure.message})`);
    assert.equal(grants.length, 2, 'both parallel steps asked for a budget');
    const authorised = grants.reduce((sum, g) => sum + g, 0);
    assert.ok(authorised <= 100, `a parallel wave must not be authorised past the cap (${authorised} > 100)`);
    assert.ok(
        executor._workflowTokensSpent <= 100,
        `the wave must not spend past the cap (${executor._workflowTokensSpent} > 100)`
    );
});

test('C2: a bounded pool and a negative pool size still split the cap', async () => {
    // The cap is split between the steps of the WAVE, not between the slots of
    // the pool: with a bounded pool a step starts later, on a `remaining` that
    // no longer covers the steps still running.
    for (const maxConcurrency of /** @type {Array<number|null>} */ ([2, -1, null])) {
        const grants = /** @type {Array<number>} */ ([]);
        const client = makeQuotaClient({ grants });
        const executor = new WorkflowExecutor({
            options: { client, defaultModel: 'm', budget: { maxTotalTokens: 100 }, maxConcurrency },
        });
        executor.setSteps({
            stepsList: [
                { id: 'p1', userPromptTemplate: 'first', dependencies: [] },
                { id: 'p2', userPromptTemplate: 'second', dependencies: [] },
                { id: 'p3', userPromptTemplate: 'third', dependencies: [] },
            ],
        });

        /** @type {any} */
        let failure = null;
        try {
            await executor.execute({ userGoal: 'goal' });
        } catch (err) {
            failure = err;
        }

        assert.equal(failure, null, `maxConcurrency=${maxConcurrency}: the wave must stay inside the cap (${failure && failure.message})`);
        const authorised = grants.reduce((sum, g) => sum + g, 0);
        assert.ok(
            authorised <= 100,
            `maxConcurrency=${maxConcurrency}: the wave must not be authorised past the cap (${authorised} > 100)`
        );
        assert.ok(
            executor._workflowTokensSpent <= 100,
            `maxConcurrency=${maxConcurrency}: the wave must not spend past the cap (${executor._workflowTokensSpent} > 100)`
        );
    }
});

// ─── B5: concurrent writers to one memory bank must both survive ────────────
test('B5: two concurrent writers to one memory bank both survive', async () => {
    for (let round = 0; round < 3; round++) {
        const dir = mkdtempSync(join(tmpdir(), 'merci-b5-'));
        try {
            const filePath = join(dir, 'bank.json');
            const p1 = new LocalFileMemoryProvider({ options: { filePath } });
            const p2 = new LocalFileMemoryProvider({ options: { filePath } });
            await p1.load();
            await p2.load();
            await Promise.all([
                p1.store({ content: 'fact one' }),
                p2.store({ content: 'fact two' }),
            ]);

            const reloaded = new LocalFileMemoryProvider({ options: { filePath } });
            await reloaded.load();
            assert.deepEqual(
                reloaded.facts.map((f) => f.content).sort(),
                ['fact one', 'fact two'],
                `round ${round}: a concurrent writer must not lose the other writer's fact`
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('B5: a live lock holder is never displaced, a dead one is reclaimed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b5-lock-'));
    try {
        const filePath = join(dir, 'bank.json');
        const lockPath = `${filePath}.lock`;

        // A LIVE holder (this process) owns the lock: the writer must not take
        // it, and the lock must survive the failed attempt. The lock file is
        // aged, so a rule that reclaims a stale lock would steal it.
        writeFileSync(lockPath, `${process.pid}:live-holder`, 'utf8');
        const aged = new Date(Date.now() - 60_000);
        utimesSync(lockPath, aged, aged);
        const blocked = new LocalFileMemoryProvider({ options: { filePath } });
        await blocked.load();
        /** @type {any} */
        let failure = null;
        try {
            await blocked.store({ content: 'intruder' });
        } catch (err) {
            failure = err;
        }
        assert.notEqual(failure, null, 'a live lock holder must not be displaced');
        assert.equal(existsSync(lockPath), true, "the live holder's lock must survive");
        assert.equal(
            readFileSync(lockPath, 'utf8').startsWith(`${process.pid}:`),
            true,
            'the lock must still belong to the live holder'
        );

        // A DEAD holder: the lock is reclaimed and the write goes through.
        const dead = spawnSync(process.execPath, ['-e', '']);
        assert.ok(dead.status === 0, 'the dead-holder helper ran');
        const deadPid = dead.pid;
        assert.ok(typeof deadPid === 'number' && deadPid > 0, 'the dead holder has a pid');
        writeFileSync(lockPath, `${deadPid}:dead-holder`, 'utf8');

        const reclaimer = new LocalFileMemoryProvider({ options: { filePath } });
        await reclaimer.load();
        await reclaimer.store({ content: 'after the crash' });
        assert.equal(existsSync(lockPath), false, 'the lock is released after the write');

        const reloaded = new LocalFileMemoryProvider({ options: { filePath } });
        await reloaded.load();
        assert.deepEqual(
            reloaded.facts.map((f) => f.content),
            ['after the crash'],
            'the write after a dead holder went through'
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('C3: a restored step keeps its durable HITL decision when the plan is re-supplied without its functions', async () => {
    // A JSON checkpoint cannot carry functions: the plan re-supplied from it has
    // no `verify`. The step must still match its saved definition, or the
    // durable approval is dropped and the gate is re-asked (D6/D16).
    const calls = { n: 0 };
    const client = makeCountingClient({ calls });
    const plan = () => ([{
        id: 'a',
        title: 'A',
        systemPrompt: 'SYS',
        userPromptTemplate: 'do the thing',
        dependencies: [],
        hitl: true,
        verify: () => ({ passed: true, evidence: 'ok' }),
    }]);

    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', hitlTimeoutMs: 50 } });
    executor.setSteps({ stepsList: plan() });

    // A checkpoint taken after the gate was approved but before the output was recorded.
    const state = JSON.parse(executor.save());
    Object.assign(state.steps[0], {
        status: 'running',
        _hitlDecision: { approved: true, systemPrompt: null, userPrompt: null },
    });

    const resumed = WorkflowExecutor.load({
        json: JSON.stringify(state),
        options: { client, defaultModel: 'm', hitlTimeoutMs: 50 },
    });
    // C-3: re-supply the plan **with** its `verify` function — the documented
    // restore path. A plan stripped of functions now fails closed instead of
    // running ungated, so the durable decision is proven on the real path; every
    // D6/D16 assertion below is unchanged.
    resumed.setSteps({ stepsList: plan() });

    const node = resumed.steps.get('a');
    assert.ok(node?._hitlDecision, 'the durable HITL decision must survive the restore');

    let opened = 0;
    resumed.on('workflow:hitl_pending', () => { opened++; });
    const outputs = /** @type {any} */ (await resumed.execute({ userGoal: 'goal' }));
    assert.equal(opened, 0, 'the gate must not be re-asked');
    assert.equal(outputs.a.output, 'out-1', 'the step runs with the approved decision');

    // W2D-7 — the subject this test is named for, restored: a checkpoint cannot
    // carry functions, so the **fingerprint must ignore them**. A plan re-supplied
    // from disk (its `verify` gone) still matches its saved definition, and the
    // durable decision survives instead of being dropped and re-asked.
    const strippedPlan = JSON.parse(JSON.stringify(plan()));
    const stripped = WorkflowExecutor.load({ json: JSON.stringify(state), options: { client, defaultModel: 'm', hitlTimeoutMs: 50 } });
    stripped.setSteps({ stepsList: strippedPlan });
    const strippedNode = /** @type {any} */ (stripped.steps.get('a'));
    assert.equal(typeof strippedNode?.verify, 'undefined', 'the re-supplied plan has no function');
    assert.equal(strippedNode?._stepFingerprint, state.steps[0]._stepFingerprint, 'the fingerprint ignores the dropped function');
    assert.ok(strippedNode?._hitlDecision, 'the durable decision survives a function-less re-supply');

    // C-3: with the gate gone, the resume refuses to run the step ungated ...
    const refused = WorkflowExecutor.load({ json: JSON.stringify(state), options: { client, defaultModel: 'm' } });
    refused.setSteps({ stepsList: strippedPlan });
    await assert.rejects(
        () => refused.execute({ userGoal: 'goal' }),
        (/** @type {any} */ err) => err instanceof ConfigurationError && /'a'/.test(err.message) && /verify gate/.test(err.message)
    );

    // ... unless the caller opts out explicitly; the durable decision still applies.
    const optedOut = WorkflowExecutor.load({ json: JSON.stringify(state), options: { client, defaultModel: 'm', allowLostStepFunctions: true } });
    optedOut.setSteps({ stepsList: strippedPlan });
    let optedOpened = 0;
    optedOut.on('workflow:hitl_pending', () => { optedOpened++; });
    const ungated = /** @type {any} */ (await optedOut.execute({ userGoal: 'goal' }));
    assert.equal(optedOpened, 0, 'the durable decision is not re-asked on the ungated path');
    assert.equal(ungated.a.output, 'out-2', 'the opted-out step ran once, from the durable decision');
});

test('B5: a lock left by a dead writer is reclaimed without two writers inside', async () => {
    // Two reclaimers must not both delete the dead lock and both write: one
    // writer's facts would be lost.
    // The double-hold is a narrow race: 12 rounds catch it with high
    // probability (a single round catches it in roughly one case in four).
    for (let round = 0; round < 12; round++) {
        const dir = mkdtempSync(join(tmpdir(), 'merci-b5-race-'));
        try {
            const filePath = join(dir, 'bank.json');
            writeFileSync(filePath, JSON.stringify({ version: 1, facts: [], lastSyncedTurnIndex: 0 }), 'utf8');
            // A lock whose owner is gone.
            writeFileSync(`${filePath}.lock`, '999999:dead-holder', 'utf8');

            const writers = await Promise.all([0, 1, 2, 3].map(async (i) => {
                const p = new LocalFileMemoryProvider({ options: { filePath } });
                await p.load();
                await p.store({ content: `fact ${i}` });
                return p;
            }));
            assert.equal(writers.length, 4);

            const reloaded = new LocalFileMemoryProvider({ options: { filePath } });
            await reloaded.load();
            assert.deepEqual(
                reloaded.facts.map((f) => f.content).sort(),
                ['fact 0', 'fact 1', 'fact 2', 'fact 3'],
                `round ${round}: no writer may lose another's fact`
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('B5: a live reclaimer holding the claim keeps a second writer out', async () => {
    // The reclaim is exclusive: while another reclaimer holds the claim, this
    // writer must NOT take over the dead lock.
    const dir = mkdtempSync(join(tmpdir(), 'merci-b5-claim-'));
    try {
        const filePath = join(dir, 'bank.json');
        writeFileSync(`${filePath}.lock`, '999999:dead-holder', 'utf8');
        writeFileSync(`${filePath}.lock.reclaim`, `${process.pid}:live-reclaimer`, 'utf8');

        const provider = new LocalFileMemoryProvider({ options: { filePath } });
        await provider.load();
        /** @type {any} */
        let failure = null;
        try {
            await provider.store({ content: 'intruder' });
        } catch (err) {
            failure = err;
        }
        assert.notEqual(failure, null, 'a live reclaimer must keep the second writer out');
        assert.equal(
            readFileSync(`${filePath}.lock`, 'utf8'),
            '999999:dead-holder',
            'the dead lock must be left for the live reclaimer'
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('B5: a lock with no owner is reclaimed once it is old enough', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b5-garbage-'));
    try {
        const filePath = join(dir, 'bank.json');
        const lockPath = `${filePath}.lock`;
        writeFileSync(lockPath, 'not-a-pid', 'utf8');
        const aged = new Date(Date.now() - 60_000);
        utimesSync(lockPath, aged, aged);

        const provider = new LocalFileMemoryProvider({ options: { filePath } });
        await provider.load();
        await provider.store({ content: 'after the garbage lock' });

        assert.equal(existsSync(lockPath), false, 'the lock is released after the write');
        const reloaded = new LocalFileMemoryProvider({ options: { filePath } });
        await reloaded.load();
        assert.deepEqual(reloaded.facts.map((f) => f.content), ['after the garbage lock']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ─── G0: journal.begin() must protect its own fields ────────────────────────
test('G0: journal.begin() cannot let meta overwrite the protected fields', () => {
    const journal = new ExecutionJournal({ runId: 'real-run' });

    const status = journal.begin({ key: 'k1', meta: { status: 'done' } });
    assert.equal(status.status, JOURNAL_STATUS.INTENT, 'meta must not manufacture a DONE row');
    assert.equal(journal.get({ key: 'k1' })?.status, JOURNAL_STATUS.INTENT);

    const rekeyed = journal.begin({ key: 'k2', meta: { key: 'other', runId: 'hijacked' } });
    assert.equal(rekeyed.key, 'k2', 'meta must not re-key the row');
    assert.equal(rekeyed.runId, 'real-run', 'meta must not rewrite the run id');
    assert.equal(journal.get({ key: 'other' }), null, 'the row must not be reachable under a meta-supplied key');
});

test('G0: journal.begin() cannot let meta inject an outcome or an error', () => {
    const journal = new ExecutionJournal({ runId: 'real-run' });

    const entry = /** @type {any} */ (journal.begin({ key: 'k1', meta: { outcome: { success: true, result: 'forged' }, error: 'forged-error' } }));
    assert.equal(entry.outcome, undefined, 'meta must not inject an outcome');
    assert.equal(entry.error, undefined, 'meta must not inject an error');

    journal.complete({ key: 'k1', outcome: { success: true, result: 'real' } });
    const done = journal.get({ key: 'k1' });
    assert.deepEqual(done?.outcome, { success: true, result: 'real' }, 'complete() must set the real outcome');
    assert.equal(done?.error, undefined, 'the forged error must not survive complete()');
});

// ─── B1: an unserializable outcome must replay as a failure ─────────────────

test('B1: an unserializable tool outcome replays as a failure, not as a success', async () => {
    const journal = new ExecutionJournal();
    const tool = {
        name: 'big',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ big: 9007199254740993n }),
    };
    const call = { id: 'c1', name: 'big', arguments: '{}' };

    await executeTools({ toolCalls: [call], toolLibrary: [tool], signal: undefined, journal, boundary: 'b1' });

    const persisted = journal.toJSON();
    const row = persisted.entries[0];
    assert.equal(row.status, JOURNAL_STATUS.DONE);
    assert.equal(row.outcome?.success, false, 'an outcome that cannot be serialised must be persisted as a failure');

    const restored = ExecutionJournal.fromJSON(persisted);
    const [replay] = /** @type {any[]} */ (await executeTools({
        toolCalls: [call], toolLibrary: [tool], signal: undefined, journal: restored, boundary: 'b1',
    }));
    assert.equal(replay.replayed, true, 'the restored journal replays the call');
    assert.equal(replay.failed, true, 'the replay must report a failure, not a success with no result');
    assert.equal(replay.result, undefined, 'a failed replay must not report a result');
});

test('B1: an outcome that is not a success replays as a failure', async () => {
    // `outcome: null` (or a missing outcome) is an UNKNOWN result — it must
    // not replay as a success with no result.
    const okTool = {
        name: 'ok',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ hello: 'world' }),
    };

    for (const outcome of /** @type {any[]} */ ([null, undefined])) {
        const journal = new ExecutionJournal();
        const key = toolJournalKey({ runId: journal.runId, boundary: 'b1', name: 'ok', args: {} });
        journal.begin({ key });
        journal.complete({ key, outcome });

        const restored = ExecutionJournal.fromJSON(journal.toJSON());
        const [replay] = /** @type {any[]} */ (await executeTools({
            toolCalls: [{ id: 'c1', name: 'ok', arguments: '{}' }],
            toolLibrary: [okTool],
            signal: undefined,
            journal: restored,
            boundary: 'b1',
        }));
        assert.equal(replay.replayed, true, `outcome=${JSON.stringify(outcome)}: the row must replay`);
        assert.equal(replay.failed, true, `outcome=${JSON.stringify(outcome)}: an unknown outcome must replay as a failure`);
        assert.equal(replay.result, undefined, `outcome=${JSON.stringify(outcome)}: no result may be reported`);
    }
});
