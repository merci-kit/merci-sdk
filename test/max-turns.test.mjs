// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { MaxTurnsExceededError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/** @param {string} name @param {string} args */
/** @param {{name: *, args: *}} arg0 */
const toolCall = ({ name, args }) => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: `call_${name}_${args}`, type: 'function', function: { name, arguments: args } }],
});

/**
 * @param {{stepImpl: Function, emitter?: EventEmitter}} arg0
 */
function makeSession({ stepImpl, emitter = new EventEmitter() }) {
    return {
        provider: 'OAI',
        model: 'test-model',
        _tools: [],
        eventEmitter: emitter,
        step: stepImpl,
    };
}

describe('MaxTurnsExceeded contract', () => {
    it('throws MaxTurnsExceededError when the tool budget is spent with no answer', async () => {
        /** @param {{messages: *}} arg0 */
        const session = makeSession({ stepImpl: /** @type {(...args: any[]) => any} */ (async function* ({ messages }) {
            return { done: false, messages: [...messages, toolCall({ name: 'read', args: '{}' })], thoughtSignature: null };
        }) });
        await assert.rejects(
            () => runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: { maxIterations: 2 } }),
            (err) => {
                assert.ok(err instanceof MaxTurnsExceededError, 'typed MaxTurnsExceededError');
                assert.equal(err.message, FALLBACK_MESSAGE.MAX_ITERATIONS, 'sentinel message');
                assert.equal(err.maxTurns, 2);
                assert.equal(err.iterationsUsed, 2);
                assert.equal(err.partialOutput, null);
                assert.equal(err.code, 'MERCI-MAX-TURNS-ERR');
                return true;
            }
        );
    });

    it('errorHandlers.max_turns returns a controlled output instead of throwing', async () => {
        /** @param {{messages: *}} arg0 */
        const session = makeSession({ stepImpl: /** @type {(...args: any[]) => any} */ (async function* ({ messages }) {
            return { done: false, messages: [...messages, toolCall({ name: 'read', args: '{}' })], thoughtSignature: null };
        }) });
        const seen = /** @type {any[]} */ ([]);
        const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
            maxIterations: 2,
            errorHandlers: {
                max_turns: /** @type {(...args: any[]) => any} */ ((info) => {
                    seen.push(info);
                    return 'CONTROLLED OUTPUT';
                }),
            },
        } });
        assert.equal(out, 'CONTROLLED OUTPUT');
        assert.equal(seen.length, 1, 'handler called once');
        assert.equal(seen[0].maxTurns, 2);
        assert.equal(seen[0].iterationsUsed, 2);
        assert.ok(Array.isArray(seen[0].messages), 'handler receives the conversation');
    });

    it('autoExtend extends while unseen tool calls keep appearing, then completes', async () => {
        const emitter = new EventEmitter();
        let extended = 0;
        emitter.on(EVENTS.CLIENT.MAX_TURNS_EXTENDED, () => { extended++; });

        let n = 0;
        /** @param {{messages: *}} arg0 */
        const session = makeSession({ stepImpl: /** @type {(...args: any[]) => any} */ (async function* ({ messages }) {
            n++;
            if (n <= 2) {
                return { done: false, messages: [...messages, toolCall({ name: 'search', args: `{"q":${n}}` })], thoughtSignature: null };
            }
            return { done: true, content: 'final', messages: [...messages], thoughtSignature: null };
        }), emitter });

        const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
            maxIterations: 2,
            autoExtend: true,
        } });
        assert.equal(out, 'final', 'the extension round produced the answer');
        assert.equal(extended, 1, 'exactly one progress extension');
    });

    it('autoExtend does NOT extend on repeated (non-novel) tool calls', async () => {
        const emitter = new EventEmitter();
        let extended = 0;
        emitter.on(EVENTS.CLIENT.MAX_TURNS_EXTENDED, () => { extended++; });

        /** @param {{messages: *}} arg0 */
        const session = makeSession({ stepImpl: /** @type {(...args: any[]) => any} */ (async function* ({ messages }) {
            return { done: false, messages: [...messages, toolCall({ name: 'read', args: '{}' })], thoughtSignature: null };
        }), emitter });

        await assert.rejects(
            () => runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: { maxIterations: 2, autoExtend: true } }),
            MaxTurnsExceededError
        );
        assert.equal(extended, 0, 'a spiral must not buy extra budget');
    });

    it('autoExtend respects maxExtensions', async () => {
        let n = 0;
        /** @param {{messages: *}} arg0 */
        const session = makeSession({ stepImpl: /** @type {(...args: any[]) => any} */ (async function* ({ messages }) {
            n++;
            return { done: false, messages: [...messages, toolCall({ name: 'search', args: `{"q":${n}}` })], thoughtSignature: null };
        }) });
        await assert.rejects(
            () => runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
                maxIterations: 1,
                autoExtend: { maxExtensions: 2 },
            } }),
            (err) => {
                assert.ok(err instanceof MaxTurnsExceededError);
                assert.equal(err.iterationsUsed, 3);
                return true;
            }
        );
    });

    it('C19: a controlled max_turns finish reports finishReason max_turns on run:end', async () => {
        const emitter = new EventEmitter();
        /** @param {{messages: *}} arg0 */
        const session = makeSession({ stepImpl: /** @type {(...args: any[]) => any} */ (async function* ({ messages }) {
            return { done: false, messages: [...messages, toolCall({ name: 'read', args: '{}' })], thoughtSignature: null };
        }), emitter });
        /** @type {any[]} */
        const ends = [];
        emitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
        const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
            maxIterations: 2,
            errorHandlers: { max_turns: () => 'CONTROLLED OUTPUT' },
        } });
        assert.equal(out, 'CONTROLLED OUTPUT');
        assert.equal(ends.length, 1);
        assert.equal(ends[0].finishReason, 'max_turns');
    });

    it('C19: an uncontrolled max-turns throw still reports finishReason max_turns', async () => {
        const emitter = new EventEmitter();
        /** @param {{messages: *}} arg0 */
        const session = makeSession({ stepImpl: /** @type {(...args: any[]) => any} */ (async function* ({ messages }) {
            return { done: false, messages: [...messages, toolCall({ name: 'read', args: '{}' })], thoughtSignature: null };
        }), emitter });
        /** @type {any[]} */
        const ends = [];
        emitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
        await assert.rejects(
            runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: { maxIterations: 2 } }),
            MaxTurnsExceededError
        );
        assert.equal(ends.length, 1);
        assert.equal(ends[0].finishReason, 'max_turns');
    });

    it('EMPTY_RESPONSE exhaustion still returns a string (unchanged failure class)', async () => {
        /** @param {{messages: *}} arg0 */
        const session = makeSession({ stepImpl: /** @type {(...args: any[]) => any} */ (async function* ({ messages }) {
            return { done: true, content: '', messages: [...messages], thoughtSignature: null };
        }) });
        const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: { maxIterations: 3 } });
        assert.equal(out, FALLBACK_MESSAGE.EMPTY_RESPONSE);
    });
});

// ─── Option plumbing: executor / StateMachine / DiscussionSession ───────────

function recordingClient() {
    /** @type {any[]} */
    const calls = [];
    return {
        calls,
        /** @param {string} model */
        session(model) {
            const session = {
                provider: 'OAI',
                model: model ?? 'm',
                _tools: [],
                eventEmitter: new EventEmitter(),
                withSystemMessage() { return session; },
                withTools() { return session; },
                withMemory() { return session; },
                withTodos() { return session; },
                withParameters() { return session; },
                withCircuitBreaker() { return session; },
                withRetryPolicy() { return session; },
                withStreamTimeout() { return session; },
                /** @param {{initialInput: *, options: *}} arg0 */
                async run({ initialInput: input, options: runOpts }) {
                    if (isObjectiveRestatePrompt({ input })) return '';
                    calls.push(runOpts ?? {}); return 'OK';
                },
            };
            return session;
        },
    };
}

/** @param {any} client */
/** @param {{client: *}} arg0 */
const stepRuns = ({ client }) => client.calls;
const agentStep = { id: 's', systemPrompt: 'sys', userPromptTemplate: 'go', dependencies: [], intakeMode: 'none' };

describe('exhaustion option plumbing', () => {
    it('StateMachine forwards machine-level autoExtend / errorHandlers to the node run', async () => {
        const client = recordingClient();
        const sm = new StateMachine({ graph: { entry: 'n', nodes: [{ id: 'n', model: 'm', systemPrompt: 'sys', userPromptTemplate: 'do', terminal: true }], edges: [] }, options: { client, autoExtend: true, errorHandlers: { max_turns: () => 'x' } } });
        await sm.run();
        const run = stepRuns({ client })[0];
        assert.equal(run.autoExtend, true);
        assert.equal(typeof run.errorHandlers.max_turns, 'function');
    });

    it('StateMachine node-level autoExtend overrides the machine default', async () => {
        const client = recordingClient();
        const sm = new StateMachine({ graph: { entry: 'n', nodes: [{ id: 'n', model: 'm', systemPrompt: 'sys', userPromptTemplate: 'do', terminal: true, autoExtend: false }], edges: [] }, options: { client, autoExtend: true } });
        await sm.run();
        assert.equal(stepRuns({ client })[0].autoExtend, undefined, 'node false must win over machine true');
    });

    it('DiscussionSession forwards group-level options to every agent turn', async () => {
        const client = recordingClient();
        const group = new DiscussionSession({ client, options: { autoExtend: true, errorHandlers: { max_turns: () => 'x' } } });
        group.addAgent({ name: 'a', model: 'm', provider: 'OAI' });
        await group.discuss({ instruction: 'hello', turns: 1, sequential: true });
        const run = stepRuns({ client })[0];
        assert.equal(run.autoExtend, true);
        assert.equal(typeof run.errorHandlers.max_turns, 'function');
    });

    it('DiscussionSession agent-level autoExtend overrides the group default', async () => {
        const client = recordingClient();
        const group = new DiscussionSession({ client, options: { autoExtend: true } });
        group.addAgent({ name: 'a', model: 'm', provider: 'OAI', autoExtend: false });
        await group.discuss({ instruction: 'hello', turns: 1, sequential: true });
        assert.equal(stepRuns({ client })[0].autoExtend, undefined, 'agent false must win over group true');
    });

    it('WorkflowExecutor: a per-step override beats the executor default (naive engine)', async () => {
        const client = recordingClient();
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', autoExtend: true, errorHandlers: { max_turns: () => 'x' } } });
        executor.setSteps({ stepsList: [{ ...agentStep, autoExtend: false }] });
        await executor.execute({ userGoal: 'goal' });
        const run = stepRuns({ client })[0];
        assert.equal(run.autoExtend, undefined, 'step false must win over executor true');
        assert.equal(typeof run.errorHandlers.max_turns, 'function', 'executor handler still applies');
    });

    it('WorkflowExecutor: changing a step\'s autoExtend re-runs it; an identical step keeps its result', async () => {
        const client = recordingClient();
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
        executor.setSteps({ stepsList: [{ ...agentStep, autoExtend: true }] });
        await executor.execute({ userGoal: 'goal' });
        assert.equal((/** @type {any} */ (executor.steps.get('s'))).status, 'completed');

        executor.setSteps({ stepsList: [{ ...agentStep, autoExtend: true }] });
        assert.equal((/** @type {any} */ (executor.steps.get('s'))).status, 'completed', 'unchanged definition keeps status');

        executor.setSteps({ stepsList: [{ ...agentStep, autoExtend: false }] });
        assert.equal((/** @type {any} */ (executor.steps.get('s'))).status, 'pending', 'changed autoExtend must re-run the step');
    });
});

describe('isSdkFallbackOutput contract', () => {
    it('recognizes both sentinels and their variants', async () => {
        const { isSdkFallbackOutput } = await import('../lib/agentic/agentic-core.mjs');
        assert.equal(isSdkFallbackOutput({ text: FALLBACK_MESSAGE.EMPTY_RESPONSE }), true);
        assert.equal(isSdkFallbackOutput({ text: `${FALLBACK_MESSAGE.EMPTY_RESPONSE} (stream reset)` }), true);
        assert.equal(isSdkFallbackOutput({ text: `${FALLBACK_MESSAGE.EMPTY_RESPONSE} earlier text${FALLBACK_MESSAGE.TRUNCATED}` }), true);
        assert.equal(isSdkFallbackOutput({ text: FALLBACK_MESSAGE.MAX_ITERATIONS }), true);
        assert.equal(isSdkFallbackOutput({ text: 'a real answer' }), false);
    });

    it('prefix-anchored: a real answer that quotes the sentinel mid-text is not a fallback', async () => {
        const { isSdkFallbackOutput } = await import('../lib/agentic/agentic-core.mjs');
        assert.equal(isSdkFallbackOutput({ text: `The reviewer said: ${FALLBACK_MESSAGE.EMPTY_RESPONSE} — ignore that` }), false);
        assert.equal(isSdkFallbackOutput({ text: `${FALLBACK_MESSAGE.EMPTY_RESPONSE} (stream reset)` }), true, 'the produced variant still matches');
    });

    it('returns false for empty/whitespace (callers must check emptiness separately)', async () => {
        const { isSdkFallbackOutput } = await import('../lib/agentic/agentic-core.mjs');
        assert.equal(isSdkFallbackOutput({ text: '' }), false, 'documented contract — see the JSDoc');
        assert.equal(isSdkFallbackOutput({ text: '   ' }), false);
        assert.equal(isSdkFallbackOutput({ text: /** @type {any} */ (null) }), false);
    });
});
