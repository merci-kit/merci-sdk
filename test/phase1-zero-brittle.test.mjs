// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { AgentContext } from '../lib/agentic/agent-context.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { AgentLauncher } from '../lib/agentic/cli/launcher.mjs';
import { LocalFileMemoryProvider, MemoryManager } from '../lib/agentic/memory/index.mjs';
import { ExponentialBackoffPolicy, NoRetryPolicy } from '../lib/support/retry-policy.mjs';
import { EventEmitterApiObserver } from '../lib/support/api-observer.mjs';
import {
    ProviderType,
    DEFAULT_EXTRACTOR_PERSONA,
    FINAL_ITERATION_REMINDER
} from '../lib/core/constants/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import {
    MerciError,
    BackendError,
    AbortedError,
    AbstractMethodError,
    MemoryError,
    isAbortError,
    wrapError
} from '../lib/core/errors.mjs';

// ============================================================================
// Test helpers
// ============================================================================

const stubEmitter = () => new EventEmitter();
/** A deliberately bare client stub: the launcher tests never run a step through it. */
const stubSdk = () => /** @type {any} */ ({ session() {} });
const stubProfileManager = {
    getProfile() { return null; },
    isSupported() { return true; }
};

class MinimalSession extends AbstractChatSession {}


/**
 * @param {string} text
 */
const jaiUser = (text) => ({ type: 'user_message', content: text });

/**
 * @param {string} text
 */
const jaiSystem = (text) => ({ type: 'system_message', content: text });
const baseOpts = () => ({
    userMessageFactory: jaiUser,
    systemMessageFactory: jaiSystem
});

// ============================================================================
// F20 — Typed error hierarchy
// ============================================================================

test('F20: MerciError exposes code, name, and preserves cause chain', () => {
    const rootCause = new Error('upstream');
    const err = new MerciError({ message: 'top-level', options: { code: 'X', cause: rootCause } });
    assert.equal(err.name, 'MerciError');
    assert.equal(err.code, 'X');
    assert.equal(err.cause, rootCause);
    assert.ok(err instanceof Error);
});

test('F20: BackendError/AbortedError/MemoryError/AbstractMethodError are MerciError subclasses', () => {
    const cases = [
        [new BackendError({ message: 'x' }), 'BackendError'],
        [new AbortedError({ message: 'x' }), 'AbortedError'],
        [new MemoryError({ message: 'x' }), 'MemoryError'],
        [new AbstractMethodError({ message: 'x' }), 'AbstractMethodError']
    ];
    for (const [err, expectedName] of cases) {
        assert.equal( (/** @type {any} */ (err)).name, expectedName);
        assert.ok(err instanceof MerciError);
    }
});

test('F20: wrapError re-wraps arbitrary errors as MerciError; status-bearing errors become BackendError', () => {
    const plain =  (wrapError({ err: new Error('boom') }));
    assert.ok(plain instanceof MerciError);
    assert.equal( (/** @type {any} */ (plain.cause)).message, 'boom');

    const vendorErr =  (new Error('upstream-5xx'));
    /** @type {any} */ (vendorErr).status = 503;
    const wrapped = wrapError({ err: vendorErr, hints: { provider: 'OPENAI' } });
    assert.ok(wrapped instanceof BackendError);
    assert.equal(wrapped.status, 503);
    assert.equal(wrapped.provider, 'OPENAI');
});

test('F20: isAbortError detects aborted-signal and native AbortError shapes', () => {
    assert.equal(isAbortError({ err: null, signal: null }), false);
    assert.equal(isAbortError({ err: new Error('x'), signal: null }), false);
    const controller = new AbortController();
    controller.abort();
    assert.equal(isAbortError({ err: null, signal: controller.signal }), true);
    const nativeAbort = new Error('aborted');
    nativeAbort.name = 'AbortError';
    assert.equal(isAbortError({ err: nativeAbort }), true);
});

// ============================================================================
// ============================================================================

test('F5: _prepareStepMessages re-anchors the session system message', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    session.withSDKDescriptorMessage({ args: ['You are a focused assistant.'] });
    const prepared = await session._prepareStepMessages({ messages: [{ type: 'user_message', content: 'hi' }] });
    assert.equal(prepared[0].type, 'system_message');
    assert.equal(prepared[0].content, 'You are a focused assistant.');
});

test('F5: _prepareStepMessages replaces existing system message with fresh context', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    session.withSDKDescriptorMessage({ args: ['Session persona'] });
    const input = [
        { type: 'system_message', content: 'Inline persona' },
        { type: 'user_message', content: 'hi' }
    ];
    const prepared = await session._prepareStepMessages({ messages: input });
    assert.equal(prepared[0].content, 'Session persona');
});

test('F5: _prepareStepMessages puts the final-turn reminder in the system message, not a trailing user turn', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    const prepared = await session._prepareStepMessages({ messages: [{ type: 'user_message', content: 'hi' }], options: { isLastIteration: true } });
    const sys = prepared.find(m => m.type === 'system_message');
    assert.ok(sys && String(sys.content).includes(FINAL_ITERATION_REMINDER));
    assert.notEqual(prepared[prepared.length - 1].content, FINAL_ITERATION_REMINDER);
});

test('F5: the reminder does not disturb the tail of a tool round', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    const prepared = await session._prepareStepMessages({ messages: [
        { type: 'user_message', content: 'add three tasks' },
        { type: 'assistant_message_tool', id: 'c1', toolName: 'manage_todos', content: '{}' },
        { type: 'tool_message', id: 'c1', toolName: 'manage_todos', result: '{"ok":true}' }
    ], options: { isLastIteration: true } });
    assert.equal(prepared[prepared.length - 1].type, 'tool_message');
});

test('F5: _prepareStepMessages does NOT append the reminder on intermediate iterations', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    const prepared = await session._prepareStepMessages({ messages: [{ type: 'user_message', content: 'hi' }], options: { isLastIteration: false } });
    const hasReminder = prepared.some(m => m.content === FINAL_ITERATION_REMINDER);
    assert.equal(hasReminder, false);
});

test('F5: _normalizeMessageSequence merges consecutive user turns, never injects ACK/filler', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    const prepared = await session._prepareStepMessages({ messages: [
        { type: 'user_message', content: 'first' },
        { type: 'user_message', content: 'second' }
    ] });
    const users = prepared.filter(m => m.type === 'user_message');
    assert.equal(users.length, 1);
    assert.equal(users[0].content, 'first\n\nsecond');
    const serialized = JSON.stringify(prepared);
    assert.ok(!serialized.includes('Acknowledged.'), 'no ACK injection');
    assert.ok(!serialized.includes('"Continue."'), 'no filler user turn');
});

test('F5: _normalizeMessageSequence merges consecutive assistant text turns', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    const prepared = await session._prepareStepMessages({ messages: [
        { type: 'user_message', content: 'go' },
        { type: 'assistant_message_text', content: 'one' },
        { type: 'assistant_message_text', content: 'two' }
    ] });
    const assistants = prepared.filter(m => m.type === 'assistant_message_text');
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].content, 'one\n\ntwo');
});

test('F5: system slot is SDK descriptor first, then user system, then [Global Objective]', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    session.withObjective({ ctx: 'THE GOAL: audit the fleet' });
    session.withSDKDescriptorMessage({ args: ['You are a focused assistant.'] });
    session._userSystemMessage = 'Be terse.';
    const prepared = await session._prepareStepMessages({ messages: [{ type: 'user_message', content: 'hi' }] });
    const sys = prepared.find(m => m.type === 'system_message');
    assert.ok(sys, 'system message present');
    assert.ok(String(sys.content).includes('[Global Objective]\nTHE GOAL: audit the fleet'),
        'objective block present');
    assert.ok(String(sys.content).includes('Be terse.'), 'user system still present');
    assert.ok(String(sys.content).indexOf('You are a focused assistant.') < String(sys.content).indexOf('Be terse.'),
        'SDK descriptor comes first');
    assert.ok(String(sys.content).indexOf('Be terse.') < String(sys.content).indexOf('[Global Objective]'),
        'user system comes before operational context');
});

test('F5: the objective block is absent when withObjective was not called', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    session.withSDKDescriptorMessage({ args: ['You are a focused assistant.'] });
    const prepared = await session._prepareStepMessages({ messages: [{ type: 'user_message', content: 'hi' }] });
    const sys = prepared.find(m => m.type === 'system_message');
    assert.ok(sys && !String(sys.content).includes('[Global Objective]'));
});

test('F5: the objective block is not duplicated across steps', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    session.withObjective({ ctx: 'THE GOAL' });
    session.withSDKDescriptorMessage({ args: ['You are a focused assistant.'] });
    for (let i = 0; i < 3; i++) {
        const prepared = await session._prepareStepMessages({ messages: [{ type: 'user_message', content: `turn ${i}` }] });
        const sys = prepared.find(m => m.type === 'system_message');
        assert.equal((( (/** @type {any} */ (sys))).content.match(/\[Global Objective\]/g) ?? []).length, 1,
            `step ${i} carries the objective exactly once`);
    }
});

// ============================================================================
// F19 — AbortSignal propagation
// ============================================================================

test('F19: _prepareStepMessages throws AbortedError when an already-aborted signal is passed', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    const controller = new AbortController();
    controller.abort('user-cancel');
    await assert.rejects(
        () => session._prepareStepMessages({ messages: [jaiUser('hi')], options: { signal: controller.signal } }),
        (err) => err instanceof AbortedError
    );
});

test('F19: distill short-circuits when signal is already aborted and stores lastDistillError', async () => {
    const provider = new LocalFileMemoryProvider({ options: { filePath: '/tmp/__phase1_test_noent2__.json' } });
    await provider.load();
    const mm = new MemoryManager({ provider });
    const controller = new AbortController();
    controller.abort();
    await mm.distill({ messages: [jaiUser('hi')], client: stubSdk(), modelToUse: 'model', options: { signal: controller.signal } });
    assert.ok(mm.lastDistillError instanceof AbortedError);
});

// ============================================================================
// F6 — distill error observability
// ============================================================================

test('F6: handleDistillError sets lastDistillError and emits a memory:distill_error event', () => {
    const provider = new LocalFileMemoryProvider({ options: { filePath: '/tmp/__phase1_test_noent3__.json' } });
    const mm = new MemoryManager({ provider });
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const events =  ([]);
    emitter.on(EVENTS.MEMORY.DISTILL_ERROR, (payload) => events.push(payload));

    const rootCause = new Error('upstream-network');
    mm.handleDistillError({ err: rootCause, ctx: { emitter, context: { model: 'm', provider: 'B' } } });

    assert.ok(mm.lastDistillError instanceof MemoryError);
    assert.equal(mm.lastDistillError.cause, rootCause);
    assert.equal(events.length, 1);
    assert.equal(events[0].error, mm.lastDistillError);
});

// ============================================================================
// ============================================================================

test('F31: withParameters function form throws AbstractMethodError on bare subclass', () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    assert.throws(
        () => session.withParameters({ params: /** @type {(...args: any[]) => any} */ ((prev) => ({ ...prev, temperature: 0.7 })) }),
        (err) => err instanceof AbstractMethodError && err.code === 'MERCI-ABSTRACT-METHOD'
    );
});

test('F31: withParameters function form works on real backend subclasses', () => {
    const session = new OaiChatSession({
        client:  (stubSdk()), model: 'gpt-4o-mini', eventEmitter: stubEmitter(), provider: ProviderType.OPENAI
    });
    session.withParameters({ params: { temperature: 0.7 } });
    assert.equal( (/** @type {any} */ (session))._parameters.temperature, 0.7);
});

// ============================================================================
// ============================================================================

test('F18: _runWithRetry honors the configured policy and emits api_retry on each retry', async () => {
    const emitter = new EventEmitter();
    const observer = new EventEmitterApiObserver({ emitter });
    const session = new MinimalSession({
        provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: emitter, client: stubSdk()
    });
    session._apiObserver = observer;
    session._retryPolicy = new ExponentialBackoffPolicy({
        maxRetries: 2,
        initialDelayMs: 1,
        maxDelayMs: 5,
        jitterMs: 0
    });

    /** @type {any[]} */
    const retryEvents =  ([]);
    emitter.on('api_retry', (payload) => retryEvents.push(payload));

    let attempt = 0;
    const op = async () => {
        attempt++;
        if (attempt < 3) {
            const err =  (new Error('rate limit'));
            /** @type {any} */ (err).status = 429;
            throw err;
        }
        return 'ok';
    };
    const result = await session._runWithRetry({ operation: op, ctx: { vendorName: 'TEST' } });
    assert.equal(result, 'ok');
    assert.equal(retryEvents.length, 2, 'two retries should have been emitted');
    assert.equal(retryEvents[0].vendor, 'TEST');
});

test('F18: _runWithRetry with NoRetryPolicy makes a single attempt', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    session._retryPolicy = new NoRetryPolicy();
    let attempts = 0;
    const op = async () => {
        attempts++;
        throw new Error('flaky');
    };
    await assert.rejects(() => session._runWithRetry({ operation: op }));
    assert.equal(attempts, 1, 'NoRetryPolicy must not loop');
});

test('F18: _runWithRetry with aborted signal does not retry past the abort', async () => {
    const session = new MinimalSession({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: stubEmitter(), client: stubSdk() });
    session._retryPolicy = new ExponentialBackoffPolicy({
        maxRetries: 5,
        initialDelayMs: 1,
        jitterMs: 0
    });
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    await assert.rejects(
        () => session._runWithRetry({ operation: async () => {
                attempts++;
                throw new Error('flaky');
            }, ctx: { signal: controller.signal } }),
        (err) => err instanceof AbortedError
    );
    assert.equal(attempts, 0, 'aborted-before-attempt should not even try');
});

// ============================================================================
// F4 — AgentLauncher.withExtractorPersona is configurable
// ============================================================================

test('F4: AgentLauncher defaults to DEFAULT_EXTRACTOR_PERSONA', () => {
    const launcher = new AgentLauncher({ client: stubSdk(), provider: ProviderType.OPENAI, model: 'gpt-4o-mini' });
    assert.equal(launcher.extractorPersona, DEFAULT_EXTRACTOR_PERSONA);
});

test('F4: withExtractorPersona accepts a string override', () => {
    const launcher = new AgentLauncher({ client: stubSdk(), provider: ProviderType.OPENAI, model: 'gpt-4o-mini' });
    const custom = 'You are a custom extractor.';
    launcher.withExtractorPersona({ personaOrFn: custom });
    assert.equal(launcher.extractorPersona, custom);
});

test('F4: withExtractorPersona accepts a function override', () => {
    const launcher = new AgentLauncher({ client: stubSdk(), provider: ProviderType.OPENAI, model: 'gpt-4o-mini' });
    const fn = /** @type {(...args: any[]) => any} */ (( skill,  payload) => `Extract ${skill.name} from ${payload}`);
    launcher.withExtractorPersona({ personaOrFn: fn });
    assert.equal(launcher.extractorPersona, fn);
    assert.equal(typeof launcher.extractorPersona, 'function');
});

test('F4: withExtractorPersona rejects invalid arguments', () => {
    const launcher = new AgentLauncher({ client: stubSdk(), provider: ProviderType.OPENAI, model: 'gpt-4o-mini' });
    assert.throws(() => launcher.withExtractorPersona({ personaOrFn: /** @type {any} */ (null) }), TypeError);
    assert.throws(() => launcher.withExtractorPersona({ personaOrFn: /** @type {any} */ (42) }), TypeError);
    assert.throws(() => launcher.withExtractorPersona({ personaOrFn: '' }), TypeError);
});

// ============================================================================
// ============================================================================

test('F23: FINAL_ITERATION_REMINDER is a stable, non-empty string constant', () => {
    assert.ok(typeof FINAL_ITERATION_REMINDER === 'string');
    assert.ok(FINAL_ITERATION_REMINDER.length > 0);
});
