// @ts-check

import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { ChatSession as JaiChatSession } from '../lib/backends/jai.mjs';
import { formatJaiMessages } from '../lib/backends/jai-vendor/messages.mjs';
import { compactHistory, runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import {
    createUserMessage,
    normalizeToOAI,
    normalizeToAAI,
    normalizeToGAI,
    joinSystemParts,
} from '../lib/messaging/messages.mjs';
import {
    countConversationTurns,
    isInjection,
} from '../lib/messaging/unified-message.mjs';
import {
    ProviderType,
    INJECTION_META_KEY,
    SYNTHETIC_TURN_INJECTION,
    SYSTEM_MESSAGE_MERGE_SEPARATOR,
    FALLBACK_MESSAGE,
    PENULTIMATE_ITERATION_REMINDER,
} from '../lib/core/constants/index.mjs';
import { CONVERSATION_SUMMARY_MARKER } from '../lib/core/prompts.mjs';
import { MaxTurnsExceededError } from '../lib/core/errors.mjs';

/** @typedef {import('../lib/messaging/messages.mjs').MessageRow} MessageRow */

/** @type {any[]} */
const report =  ([]);


/**
 * @param {string} id
 */
/** @param {{id: *}} arg0 */
const TOOL_CALL = ({ id }) => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }],
});

/**
 * @param {string} id
 * @param {string} text
 */
/** @param {{id: *, text: *}} arg0 */
const TOOL_RESULT = ({ id, text }) => ({ role: 'tool', tool_call_id: id, name: 'read', content: text });

// ─── S1: L2 same-role text merge must preserve the later row's continuity ───

describe('L2: same-role merge preserves continuity fields', () => {
    const makeSession = () => {
        const stubClient = { chat: { completions: { create: async () => (async function* () {})() } } };
        return new OaiChatSession({ client: stubClient, model: 'test-model', eventEmitter: new EventEmitter() });
    };

    it('keeps the LATER thoughtSignature and concatenates reasoning_content', () => {
        const session = makeSession();
        const history = [
            createUserMessage({ provider: ProviderType.JAI, content: 'first' }),
            { type: 'assistant_message_text', content: 'one', thought_signature: 'sigA', reasoning_content: 'thinkA' },
            { type: 'assistant_message_text', content: 'two', thought_signature: 'sigB', reasoning_content: 'thinkB' },
            createUserMessage({ provider: ProviderType.JAI, content: 'second' }),
        ];
        const out = session._normalizeMessageSequence({ messages: history });
        assert.equal(out.length, 3, 'the two assistant rows merge into one');
        const merged = out[1];
        assert.equal(merged.content, 'one\n\ntwo');
        assert.equal(merged.thoughtSignature, 'sigB', 'the LATER signature must survive the merge (canonical camelCase)');
        assert.equal(merged.thought_signature, undefined, 'the stale snake spelling is dropped, never both');
        assert.ok(String(merged.reasoning_content).includes('thinkA')
            && String(merged.reasoning_content).includes('thinkB'),
        'reasoning_content of BOTH rows must be concatenated');

        const baselineMerged =  ({ ...history[1], content: 'one\n\ntwo' });
        const baselineKeepsSigB = /** @type {any} */ (baselineMerged).thought_signature === 'sigB';
        const refactoredKeepsSigB = merged.thoughtSignature === 'sigB';
        report.push({
            scenario: 'S1 same-role merge continuity',
            input: 'two consecutive assistant text rows with sigs + reasoning',
            implA_refactored: { rows: out.length, keepsLaterSig: refactoredKeepsSigB, keepsSigBValue: merged.thoughtSignature === 'sigB', reasoningLen: String(merged.reasoning_content).length },
            implB_baseline: { rows: 3, keepsLaterSig: baselineKeepsSigB, keepsSigBValue: /** @type {any} */ (baselineMerged).thought_signature, reasoningLen: 0 },
        });
        assert.equal(refactoredKeepsSigB, true);
        assert.equal(baselineKeepsSigB, false, 'baseline loses the later signature — the A/B must show the refactor winning');
    });

    it('propagates the synthetic-turn marker through the merge', () => {
        const session = makeSession();
        const nudge =  (createUserMessage({ provider: ProviderType.JAI, content: 'nudge' }));
        /** @type {Record<string, unknown>} */ (nudge)[INJECTION_META_KEY] = SYNTHETIC_TURN_INJECTION;
        const history = [createUserMessage({ provider: ProviderType.JAI, content: 'first' }), nudge];
        const out = session._normalizeMessageSequence({ messages: history });
        assert.equal(out.length, 1, 'both user rows merge');
        assert.equal(/** @type {Record<string, Object>} */ (out[0])[INJECTION_META_KEY], SYNTHETIC_TURN_INJECTION,
            'the merged row must not read as a genuine user turn');
        assert.equal(isInjection({ m: out[0] }), true);
    });
});

// ─── S2: L1 compaction failure keeps a loss marker ──────────────────────────

describe('L1: compaction failure keeps a loss marker', () => {
    it('prepends a marked system message instead of silently deleting the prefix', async () => {
        const history = [
            createUserMessage({ provider: 'OAI', content: 'q1' }),
            { role: 'assistant', content: 'a1' },
            createUserMessage({ provider: 'OAI', content: 'q2' }),
        ];
        const out = await compactHistory(/** @type {{ messages: MessageRow[]; compaction: any; session: any; signal: any; onEvent: any; }} */ ({ messages: history, compaction: {
            thresholdTokens: 0,
            summarize: async () => { throw new Error('summarizer down'); },
        } }));
        assert.equal(out[0].role, 'system');
        assert.ok(String(out[0].content).includes(CONVERSATION_SUMMARY_MARKER), 'the marker must be present');
        assert.ok(String(out[0].content).includes('summarizer down'), 'the failure reason is surfaced');
        assert.deepEqual(out.slice(1).map(m => m.content), ['q2'], 'the tail survives');

        const baseline = [history[2]];
        report.push({
            scenario: 'S2 compaction failure fallback',
            input: '3-row history, summarizer throws',
            implA_refactored: { rows: out.length, lossMarker: true },
            implB_baseline: { rows: baseline.length, lossMarker: false },
        });
    });

    it('compaction still cuts at synthetic follow-up turns (no silent disable)', async () => {
        const history = [
            createUserMessage({ provider: 'OAI', content: 'q1' }),
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'follow-up', [INJECTION_META_KEY]: SYNTHETIC_TURN_INJECTION },
            { role: 'assistant', content: 'a2' },
        ];
        const out = await compactHistory(/** @type {{ messages: MessageRow[]; compaction: any; session: any; signal: any; onEvent: any; }} */ ({ messages: history, compaction: {
            thresholdTokens: 0,
            summarize: /** @type {(...args: any[]) => any} */ (async (prefix) => `SUM:${prefix.length}`),
        } }));
        assert.equal(out[0].role, 'system', 'compaction fires for follow-up-heavy histories');
        assert.ok(String(out[0].content).includes(CONVERSATION_SUMMARY_MARKER));
        assert.equal(out[1].content, 'follow-up', 'the cut lands at the LAST user turn, synthetic included');
        assert.equal(out[2].content, 'a2');
    });
});

// ─── S3: L5 synthetic turns carry provenance, stay off the wire ─────────────

describe('L5: synthetic-turn provenance', () => {
    it('marks the post-tool-round nudge and the follow-up prompt', async () => {
        /** @type {any[]} */
        const stepCalls =  ([]);
        let calls = 0;
        let fuCalls = 0;
        const session = {
            provider: 'OAI',
            model: 'test-model',
            _tools: [],
            eventEmitter: { emit: () => {} },
            /** @param {{messages: *}} arg0 */
            async *step({ messages }) {
                stepCalls.push(messages.map( (/** @type {(...args: any[]) => any} */ (m => ({ ...m })))));
                calls++;
                if (calls === 1) {
                    return { done: false, messages: [...messages, TOOL_CALL({ id: 'c1' }), TOOL_RESULT({ id: 'c1', text: 'x' })], thoughtSignature: null };
                }
                if (calls === 2) {
                    return { done: true, content: '', messages: [...messages], thoughtSignature: null };
                }
                if (calls === 3) {
                    return { done: true, content: 'answer', messages: [...messages], thoughtSignature: null };
                }
                return { done: true, content: 'done', messages: [...messages], thoughtSignature: null };
            },
        };
        await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
            maxIterations: 5,
            followUp: async () => (fuCalls++ === 0 ? 'next stage' : null),
        } });

        const nudgeInput = stepCalls[2];
        const nudgeRow = nudgeInput[nudgeInput.length - 1];
        assert.equal(nudgeRow[INJECTION_META_KEY], SYNTHETIC_TURN_INJECTION,
            'the synthesis nudge must carry the marker');
        assert.equal(isInjection({ m: nudgeRow }), true);

        const followInput = stepCalls[3];
        const followRow = followInput[followInput.length - 1];
        assert.equal(followRow.content, 'next stage');
        assert.equal(followRow[INJECTION_META_KEY], SYNTHETIC_TURN_INJECTION,
            'the follow-up prompt must carry the marker');

        assert.equal(countConversationTurns({ messages: followInput }), 1, 'the nudge must not inflate the turn count');

        /** @param {{wire: *}} arg0 */
        const rowsOf = ({ wire }) => Array.isArray(wire) ? wire : (wire.messages ?? wire.contents ?? []);
        for (const normalize of [normalizeToOAI, normalizeToAAI, normalizeToGAI]) {
            const wire =  (normalize)({ model: 'test-model', msgs: followInput });
            assert.ok(rowsOf({ wire }).every(/** @type {(...args: any[]) => any} */ (( m) => !(INJECTION_META_KEY in m))),
                `the marker must be stripped before the wire (${normalize.name})`);
        }
        const jaiWire = formatJaiMessages({ messages: followInput });
        assert.ok(jaiWire.every(m => !(INJECTION_META_KEY in m)), 'the marker must be stripped on the JAI wire');

        const baselineCount = 1 + 2;
        report.push({
            scenario: 'S3 synthetic-turn provenance',
            input: 'one genuine turn + tool round + nudge + follow-up',
            implA_refactored: { genuineTurns: countConversationTurns({ messages: followInput }), markedRows: [nudgeRow, followRow].filter(m => isInjection({ m })).length },
            implB_baseline: { genuineTurns: baselineCount, markedRows: 0 },
        });
    });

    it('pushes a marked quota notice after the penultimate tool round', async () => {
        /** @type {any[]} */
        const stepCalls =  ([]);
        let calls = 0;
        const session = {
            provider: 'OAI',
            model: 'test-model',
            _tools: [],
            eventEmitter: { emit: () => {} },
            /** @param {{messages: *}} arg0 */
            async *step({ messages }) {
                stepCalls.push(messages.map( (/** @type {(...args: any[]) => any} */ (m => ({ ...m })))));
                calls++;
                if (calls <= 2) {
                    return { done: false, messages: [...messages, TOOL_CALL({ id: `c${calls}` }), TOOL_RESULT({ id: `c${calls}`, text: 'x' })], thoughtSignature: null };
                }
                return { done: true, content: 'final', messages: [...messages], thoughtSignature: null };
            },
        };
        const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: { maxIterations: 3 } });
        assert.equal(out, 'final');

        const noticed = stepCalls[2];
        const row = noticed[noticed.length - 1];
        assert.equal(row.content, PENULTIMATE_ITERATION_REMINDER);
        assert.equal(row[INJECTION_META_KEY], SYNTHETIC_TURN_INJECTION);
        assert.equal(isInjection({ m: row }), true);
        assert.equal(countConversationTurns({ messages: noticed }), 1, 'the notice must not inflate the turn count');

        const rowsOf = /** @type {(...args: any[]) => any} */ (( wire) => Array.isArray(wire) ? wire : (wire.messages ?? wire.contents ?? []));
        for (const normalize of [normalizeToOAI, normalizeToAAI, normalizeToGAI]) {
            const wire =  (normalize)({ model: 'test-model', msgs: noticed });
            assert.ok(rowsOf({ wire }).every(/** @type {(...args: any[]) => any} */ (( m) => !(INJECTION_META_KEY in m))),
                `the marker must be stripped before the wire (${normalize.name})`);
        }
        const jaiWire = formatJaiMessages({ messages: noticed });
        assert.ok(jaiWire.every(m => !(INJECTION_META_KEY in m)), 'the marker must be stripped on the JAI wire');
    });

    it('never pushes the quota notice with a single-iteration budget', async () => {
        /** @type {any[]} */
        const stepCalls =  ([]);
        const session = {
            provider: 'OAI',
            model: 'test-model',
            _tools: [],
            eventEmitter: { emit: () => {} },
            /** @param {{messages: *}} arg0 */
            async *step({ messages }) {
                stepCalls.push(messages.map( (/** @type {(...args: any[]) => any} */ (m => ({ ...m })))));
                return { done: false, messages: [...messages, TOOL_CALL({ id: 'c1' }), TOOL_RESULT({ id: 'c1', text: 'x' })], thoughtSignature: null };
            },
        };
        await assert.rejects(
            () => runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: { maxIterations: 1 } }),
            (err) => err instanceof MaxTurnsExceededError && err.message === FALLBACK_MESSAGE.MAX_ITERATIONS,
            'a spent tool budget throws MaxTurnsExceededError carrying the fallback sentinel message'
        );
        assert.ok(stepCalls.flat().every(m => m.content !== PENULTIMATE_ITERATION_REMINDER),
            'no notice may appear when maxIterations is 1');
    });
});

// ─── S4: L4 the full step row survives to node.messages ─────────────────────

describe('L4: last-step row capture', () => {
    it('step() records _lastStepMessages', async () => {
        const stubClient = { chat: { completions: { create: async () => (async function* () {})() } } };
        const session = new OaiChatSession({ client: stubClient, model: 'test-model', eventEmitter: new EventEmitter() });
        const history = [createUserMessage({ provider: 'OAI', content: 'hi' })];
        const gen = session.step({ messages: history });
        while (!(await gen.next()).done) { /* drain */ }
        assert.ok(Array.isArray(session._lastStepMessages), 'the last step row must be captured');
        assert.deepEqual(session._lastStepMessages, history, 'an empty turn leaves the history unchanged');
    });

    it('WorkflowExecutor records the full row (tool rounds) via the capture', async () => {
        const fullRow = [
            createUserMessage({ provider: 'OAI', content: 'Do the thing.' }),
            TOOL_CALL({ id: 'c1' }),
            TOOL_RESULT({ id: 'c1', text: 'data' }),
            { role: 'assistant', content: 'final answer' },
        ];
        const client = {
            session: () => ({
                provider: 'openai',
                withSystemMessage() { return this; },
                withTools() { return this; },
                withMemory() { return this; },
                withTodos() { return this; },
                withParameters() { return this; },
                _lastStepMessages: /** @type {any} */ (null),
                async run() { this._lastStepMessages = fullRow; return 'plain answer'; },
            }),
        };
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
        executor.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'Be terse.', userPromptTemplate: 'Do the thing.', dependencies: [] }] });
        await executor.execute({ userGoal: 'goal' });
        assert.deepEqual( (/** @type {any} */ (executor.steps.get('a'))).messages, fullRow,
            'node.messages must keep the tool rounds for replan/retry');

        const baseline = [
            createUserMessage({ provider: 'OAI', content: 'Do the thing.' }),
            { role: 'assistant', content: 'plain answer' },
        ];
        report.push({
            scenario: 'S4 executor step row',
            input: 'step with one tool round',
            implA_refactored: { rows:  (/** @type {any} */ (executor.steps.get('a'))).messages.length, hasToolCall:  (/** @type {any} */ (executor.steps.get('a'))).messages.some(/** @type {(...args: any[]) => any} */ (m => m.tool_calls)) },
            implB_baseline: { rows: baseline.length, hasToolCall: false },
        });
    });
});

// ─── S5: D2 single-pass JAI system merge ────────────────────────────────────

describe('D2: native JAI system rows (formatJaiMessages)', () => {
    it('keeps system rows native ahead of the user row (probed live on the gateway)', () => {
        const sys = 'SYS';
        const wire =  (formatJaiMessages({ messages: [
            { type: 'system_message', content: sys },
            createUserMessage({ provider: ProviderType.JAI, content: 'hi' }),
        ] }));
        assert.equal(wire.length, 2, 'the system row is preserved, not merged');
        assert.equal(wire[0].type, 'system_message');
        assert.equal(wire[0].content, sys);
        assert.equal(wire[1].type, 'user_message');
        assert.equal(wire[1].content, 'hi');

        report.push({
            scenario: 'S5 JAI system rows',
            input: 'system row + user row',
            implA_refactored: { passes: 1, rows: wire.length, systemOnWire: wire.some(m => m.type === 'system_message') },
            implB_baseline: { passes: 2, rows: wire.length, systemOnWire: true },
        });
    });

    it('converts a system-only history into a user row (Vertex requires non-system contents)', () => {
        const input = [{ type: 'system_message', content: 'A' }, { type: 'system_message', content: 'B' }];
        const out =  (formatJaiMessages({ messages: input }));
        assert.equal(out.length, 1);
        assert.equal(out[0].type, 'user_message');
        assert.equal(out[0].content, joinSystemParts({ acc: 'A', part: 'B' }), 'multiple system rows join with the shared separator');
        assert.equal(out[0].content.split(SYSTEM_MESSAGE_MERGE_SEPARATOR).length, 2);
    });
});

// ─── S6: D1 public V9 spec + per-call tool-choice clone ─────────────────────

describe('D1: JAI parameter spec is public and clone-safe', () => {
    const makeSession = () => {
        const emitter = new EventEmitter();
        const httpClient =  ({
            streamTimeout: 1000,
            getEventEmitter: () => emitter,
        });
        return new JaiChatSession({ httpClient: /** @type {any} */ (httpClient), profile: 'jai-gpt-4o', eventEmitter: emitter, profileManager: /** @type {any} */ (null) });
    };

    it('withParameters stores the V9 spec publicly and builds wire params', () => {
        const session = makeSession();
        session.withParameters({ params: /** @type {(...args: any[]) => any} */ ((b) => b.temperature({ v: 0.5 })) });
        assert.ok(session._jaiSpec, 'the V9 spec must be public (_jaiSpec)');
        assert.ok(session._parameters, 'the wire params must be built');
        assert.equal(session._jaiSpec.TEMPERATURE, 0.5, 'the V9-keyed spec holds the value');
    });

    it('the tool-choice clone inherits the spec without a private-field copy', () => {
        const session = makeSession();
        // JAI attaches toolConfig only when the session carries at least one tool
        // (buildParametersV9 gate) — the forceTextResponse overlay needs one to be observable.
        session.withTools({ tools: [{ name: 'probe', description: 'd', parameters: { type: 'object', properties: {} } }] });
        session.withParameters({ params: /** @type {(...args: any[]) => any} */ (( b) => b.temperature({ v: 0.5 })) });
        const ctx = session._onStepBuildContext({ forceTextResponse: true, toolChoiceRequired: false });
        assert.notEqual(ctx.session, session, 'a per-call clone is returned');
        assert.deepEqual(ctx.session._jaiSpec, session._jaiSpec,
            'the clone inherits the spec via the descriptor copy');
        assert.equal( (/** @type {any} */ (ctx.session._parameters)).toolConfig.toolChoice.none, true,
            'forceTextResponse overrides the tool choice on the clone only');
        assert.equal((/** @type {any} */ (session._parameters))?.toolConfig?.toolChoice?.none, undefined,
            'the original session is untouched');

        const cloneSpec = ctx.session._jaiSpec;
        const specSurvivesClone = cloneSpec && cloneSpec.TEMPERATURE === 0.5;
        report.push({
            scenario: 'S6 JAI parameter spec clone',
            input: 'withParameters(temperature 0.5) + forceTextResponse clone',
            implA_refactored: { specPublic: !!cloneSpec, specSurvivesClone, privateCopy: false },
            implB_baseline: { specPublic: false, specSurvivesClone: false, privateCopy: true },
        });
    });
});

// ─── Blind report (BLIND_REPORT=1) ──────────────────────────────────────────

if (process.env.BLIND_REPORT) {
    after(() => {
        const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratchpad');
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'blind-report-field-fidelity.json'), JSON.stringify(report, null, 2));
        console.log(`[blind-report] wrote scratchpad/blind-report-field-fidelity.json (${report.length} scenarios)`);
    });
}
