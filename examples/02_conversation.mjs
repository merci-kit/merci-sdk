// @ts-check
/**
 * Example 02 — Conversation: one carried history, parameters, a stdin-safe REPL.
 *
 * A travel-desk assistant in a bounded REPL. Each turn:
 *   1. append exactly ONE new user message to a COPY of the carried history;
 *   2. stream the reply with the canonical manual `step()` loop;
 *   3. REPLACE the history with `finalState.messages` — never push the reply
 *      (pushing duplicates rows on replay; the SDK's run loop instead rebuilds
 *      the full row every step);
 *   4. run the message-identity helpers on the carried history:
 *      `dedupeMessages` (first occurrence of each stable merciId wins — replay
 *      safe), `countConversationTurns` (genuine user turns only — tool rows and
 *      SDK injections never count), and `stripInjectionMeta` (a wire-ready
 *      export copy without non-wire keys).
 *
 * After the REPL closes, one closing section runs the VENDOR REQUEST KNOBS on
 * ONE session and ONE tiny turn: `serviceTier`, `logprobs`, `logprobsTopK`,
 * `store`, `previousResponseId`, `stream: false` and the PROMPT CACHING
 * (`cachePoints`, `promptCacheKey`). The unified parameter builder keeps
 * every knob it supports and WARNS about (`parameter_warning`) every knob the
 * backend does not — it never drops one silently. The section proves exactly
 * that: the knobs the builder KEPT plus the knobs it WARNED about cover the
 * knobs that were set, and a knob never breaks a turn.
 *
 * The two caching knobs get a second proof, because "kept" is not the same as
 * "on the wire": each one is either ON THE WIRE — the vendor request carries
 * it (`prompt_cache_key` on OpenAI, `parameters.promptCacheKey` on
 * JAI, a `cache_control` breakpoint on Anthropic) — or REPORTED as
 * ignored (`parameter_warning` from the parameter builder,
 * `session:params_filtered` from the vendor profile filter). Never dropped
 * silently, either way.
 *
 * A session with no registered task profiles advertises no tools at all, so a
 * plain chat cannot be derailed by a delegation call; the defensive branch
 * below would still decline a `tool_request` if a profile were registered.
 *
 * Public API: `client.session(model).withSystemMessage(...).withParameters(...)`,
 * `session.step({ messages })`, `createUserMessage`, `getToolCallName`,
 * `dedupeMessages`, `countConversationTurns`, `stripInjectionMeta`.
 *
 * Run: `node examples/02_conversation.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`. A closed stdin
 * (pipes, CI) exits cleanly instead of hanging.
 *
 * @version 0.23.0
 */
import * as readline from 'node:readline/promises';
import {
    EVENTS, countConversationTurns, createUserMessage, dedupeMessages, getToolCallName,
    initializeClient, loadCredentials, log, stripInjectionMeta,
} from 'merci-sdk';
import { guardedParse } from 'merci-sdk/json';
import {
    isExitKeyword, readlineSafe, reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient,
} from './_shared/example-utils.mjs';

const SYSTEM = 'You are a concise travel-desk assistant. Answer in at most 60 words.';
const MAX_TURNS = 8;
const MAX_TOOL_ROUNDS = 3;

/**
 * The prompt-caching knobs and where each one lands on the wire. The wire
 * NAME differs per vendor — OpenAI takes `prompt_cache_key`, JAI takes
 * `parameters.promptCacheKey`, Anthropic marks a `cache_control` breakpoint —
 * so the check looks the names up in the captured request body instead of one
 * fixed path. `value` is what the knob must carry on the wire.
 */
const CACHE_KNOBS = [
    { name: 'cachePoints', wire: ['cache_control', 'cachePoints', 'CACHE_POINTS'], value: 'ephemeral' },
    { name: 'promptCacheKey', wire: ['prompt_cache_key', 'promptCacheKey', 'PROMPT_CACHE_KEY'], value: 'merci-example-02' },
];

let failures = 0;

/**
 * Record one contract check. A failed check is counted and the run throws at
 * the end, so a broken contract fails the example instead of scrolling by.
 * @param {{name: string, passed: boolean, detail?: string}} arg0
 * @returns {void}
 */
function check({ name, passed, detail }) {
    if (!passed) failures += 1;
    log.check({ name, passed, detail });
}

/**
 * The captured vendor request body: the OpenAI/Anthropic adapters report it
 * as `params` (an object), the JAI transport as `body` (a JSON string).
 * @param {{raw: any}} arg0
 * @returns {any} the parsed body, or null when there is none
 */
function requestBody({ raw }) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return raw;
    // The vendor body is machine-produced JSON: reject a corrupt one instead of
    // repairing it, so the example reports what the wire actually carried.
    const parsed = guardedParse({ input: raw, options: { heal: false } });
    return parsed.success ? parsed.data : null;
}

/**
 * Whether a caching knob reached the vendor request body, and under which wire
 * name. The body is searched as JSON text: a knob's value is a plain string
 * and the request carries no string value that looks like a wire name.
 * @param {{body: any, names: string[], value: string}} arg0
 * @returns {{names: string[], valueOnWire: boolean}} the wire names found and
 *   whether the knob's value travelled with them
 */
function wireHas({ body, names, value }) {
    const text = JSON.stringify(body ?? null);
    return {
        names: names.filter((name) => text.includes(`"${name}"`)),
        valueOnWire: text.includes(`"${value}"`),
    };
}

/**
 * Decline any advertised tool without executing anything, so the model falls
 * back to a text answer instead of looping on an unanswered call.
 * @param {{calls?: Array<Record<string, any>>}} arg0
 * @returns {Array<Record<string, any>>} one failure envelope per call
 */
function declineToolCalls({ calls }) {
    return (calls ?? []).map((call) => ({
        id: call.id,
        tool_call_id: call.id,
        name: getToolCallName({ call }),
        success: false,
        error: 'No subagents are configured in this example — answer in text.',
    }));
}

async function main() {
    const { provider, defaultModel } = resolveExample();
    log.header({ t: `Example 02 — Conversation (${provider})` });
    log.option({ name: 'model', value: defaultModel || '(empty)', source: 'getDefaultModel({ backend })' });
    log.info({ m: "Type a message, or 'exit'/'quit' to finish. A closed stdin ends the REPL too." });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });
    /** @type {string[]} */
    const warnedParameters = [];
    client.on('parameter_warning', /** @param {{parameter: string, message: string}} w */ ({ parameter, message }) => {
        warnedParameters.push(parameter);
        log.warn({ m: `parameter ignored: ${parameter} — ${message}` });
    });

    const session = client.session(defaultModel)
        .withSystemMessage(SYSTEM)
        .withParameters({ params: (/** @type {any} */ b) => b.temperature({ v: 0.3 }).topP({ v: 0.9 }).seed({ v: 42 }).maxTokens({ v: 512 }) });

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    /** @type {any[]} */
    let messages = [];
    let turns = 0;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const line = await readlineSafe({ rl, prompt: /** @type {string} */ (log.user({ m: '', returnOnly: true })), fallback: 'exit' });
        if (isExitKeyword({ line })) break;

        let history = [...messages, createUserMessage({ provider, content: line })];
        log.phase({ t: `Turn ${turn}`, sub: `${history.length} message(s) sent` });

        let answer = '';
        let labeled = false;
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const gen = session.step({ messages: history });
            let result = await gen.next();
            let toolRound = false;
            while (!result.done) {
                const ev = result.value;
                if (ev.type === 'text') {
                    const chunk = String(ev.content ?? '');
                    if (!labeled && chunk) { log.assistant({ m: '', isStreaming: true }); labeled = true; }
                    process.stdout.write(chunk); answer += chunk;
                }
                if (ev.type === 'tool_request') {
                    toolRound = true;
                    log.condition({ label: 'tool_request', branch: 'declined', why: 'decline the delegation and let the model answer in text (a registered profile would make this call executable)' });
                    result = await gen.next(declineToolCalls({ calls: ev.calls }));
                    continue;
                }
                result = await gen.next();
            }

            const raw = result.value?.messages ?? history;
            history = dedupeMessages({ messages: raw });
            if (history.length < raw.length) log.warn({ m: `dedupeMessages removed ${raw.length - history.length} replayed row(s)` });
            if (!toolRound) break;
        }
        if (labeled) process.stdout.write('\n');
        warnEmptyAnswer({ answer, label: `turn ${turn}` });
        messages = history;
        turns += 1;

        const wireReady = stripInjectionMeta({ messages });
        const strippedRows = messages.filter((row, i) => row !== wireReady[i]).length;
        log.event({ type: 'history', payload: {
            messages: messages.length,
            conversationTurns: countConversationTurns({ messages }),
            exportRowsStripped: strippedRows,
        }, detail: 'replace-not-push keeps one row per real event; merciId makes dedupe replay-safe' });
    }

    rl.close();
    log.info({ m: `turns completed: ${turns}; history rows: ${messages.length}` });

    // ── closing section · the vendor request knobs ───────────────────────────
    log.section({ t: 'Vendor request knobs — kept, warned about, never dropped' });

    const knobSession = client.session(defaultModel).withSystemMessage(SYSTEM);
    // `previousResponseId` is the one knob the wire cannot take blind: the
    // Responses endpoint wants the id of a response the vendor actually stored
    // (a dangling id is a 400), so it is set only where the adapter drops it —
    // the chat-completions endpoint. The other knobs travel as they are.
    const wireCarriesPreviousResponseId = knobSession.protocol === 'responses';
    // `temperature` is supported by every backend, so the KEPT half of the
    // contract is exercised on every backend; the wave-2 knobs are the ones
    // that differ from backend to backend.
    /** @type {string[]} */
    const knobNames = ['temperature', 'stream', 'serviceTier', 'logprobs', 'logprobsTopK', 'store', 'cachePoints', 'promptCacheKey'];
    if (!wireCarriesPreviousResponseId) knobNames.push('previousResponseId');
    else log.condition({ label: 'previousResponseId', branch: 'not set', why: 'the Responses endpoint wants the id of a response the vendor stored — a dangling id would be a 400' });

    /** @type {any} */
    let builder = null;
    const warnedBefore = warnedParameters.length;
    knobSession.withParameters({ params: (/** @type {any} */ b) => {
        builder = b;
        b.temperature({ v: 0.2 })
            .serviceTier({ v: 'priority' })
            .logprobs({ v: true })
            .logprobsTopK({ v: 3 })
            .store({ v: true })
            .cachePoints({ v: { count: 1, type: 'ephemeral' } })
            .promptCacheKey({ v: 'merci-example-02' })
            .stream(false);
        if (!wireCarriesPreviousResponseId) b.previousResponseId({ v: 'resp_prev_1' });
        return b;
    } });

    // The builder handed to the callback is the SDK's public parameter builder:
    // `build()` returns the unified spec it KEPT, and a knob it does not
    // support is a no-op that warned instead of being stored.
    /** @type {string[]} */
    const warned = [...new Set(warnedParameters.slice(warnedBefore).map((name) => (
        name === 'CACHE_POINTS' ? 'cachePoints'
            : name === 'PROMPT_CACHE_KEY' ? 'promptCacheKey'
                : name
    )))];
    const spec = builder?.build() ?? {};
    /** @type {string[]} */
    const kept = knobNames.filter((name) => spec[name] !== undefined);
    const covered = new Set([...kept, ...warned]);
    // A profile filter may report a knob the unified builder already kept:
    // "kept" is not "on the wire". The caching block below is the wire-or-
    // reported proof; here only coverage and no silent drop matter.
    check({
        name: 'every knob was accounted for — kept or warned about, never dropped silently',
        passed: covered.size === knobNames.length
            && knobNames.every((name) => covered.has(name)),
        detail: `kept=[${kept.join(', ')}] warned=[${warned.join(', ')}]`,
    });
    log.event({ type: 'knobs', payload: { kept: kept.length, warned: warned.length, set: knobNames.length },
        detail: 'the parameter layer keeps the knobs it supports and warns about the rest — the knob set covers the backend, not the other way round' });

    log.phase({ t: 'Knob turn', sub: 'Reply with the single word: ok' });
    // The vendor request is the evidence for `stream: false` AND for the
    // prompt caching: the api_request event carries the body the SDK actually
    // put on the wire. (The number of text events is NOT evidence — a one-word
    // answer arrives as one event even when the vendor streamed it.)
    /** @type {any} */
    let wireRequest = null;
    /** @type {(e: {params?: any, body?: any, payload?: any}) => void} */
    const onApiRequest = ({ params, body, payload }) => {
        wireRequest = requestBody({ raw: payload?.params ?? params ?? payload?.body ?? body ?? null });
    };
    // The vendor profile filter drops the parameters the profile does not
    // declare — and REPORTS the omitted ones (`session:params_filtered`).
    /** @type {string[]} */
    const filteredParameters = [];
    /** @type {(e: {omitted?: string[]}) => void} */
    const onParamsFiltered = ({ omitted }) => { filteredParameters.push(...(omitted ?? [])); };
    client.on(EVENTS.CLIENT.API_REQUEST, onApiRequest);
    client.on(EVENTS.CLIENT.SESSION_PARAMS_FILTERED, onParamsFiltered);
    const gen = knobSession.step({ messages: [createUserMessage({ provider, content: 'Reply with the single word: ok' })] });
    /** @type {string[]} */
    const textEvents = [];
    let knobAnswer = '';
    let knobResult = await gen.next();
    while (!knobResult.done) {
        const ev = knobResult.value;
        if (ev.type === 'text') {
            const chunk = String(ev.content ?? '');
            textEvents.push(chunk);
            knobAnswer += chunk;
        }
        knobResult = await gen.next();
    }
    client.off(EVENTS.CLIENT.API_REQUEST, onApiRequest);
    client.off(EVENTS.CLIENT.SESSION_PARAMS_FILTERED, onParamsFiltered);
    if (knobAnswer.trim()) log.assistant({ m: knobAnswer.trim() });
    check({ name: 'the knob turn still answered', passed: knobAnswer.trim().length > 0, detail: `${knobAnswer.trim().length} chars` });

    if (kept.includes('stream')) {
        log.condition({ label: 'stream: false', branch: 'accepted', why: 'the backend supports it — the vendor request carries stream:false, so the vendor answers with one complete object' });
        check({
            name: 'the vendor request carried stream: false',
            passed: wireRequest?.stream === false,
            detail: `wire.stream=${String(wireRequest?.stream)} textEvents=${textEvents.length}`,
        });
    } else {
        log.condition({ label: 'stream: false', branch: 'ignored', why: 'the backend does not support it (it warned) — nothing is asserted about the wire' });
    }

    // ── the prompt caching ───────────────────────────────────────────────────
    // "Kept by the builder" is not the same as "on the wire": a knob the vendor
    // profile does not declare is dropped when the request is built. Each
    // caching knob is therefore either ON THE WIRE — the request carries it —
    // or REPORTED as ignored (`parameter_warning` from the parameter builder,
    // `session:params_filtered` from the profile filter). Never both, never
    // neither.
    const caching = CACHE_KNOBS.map(({ name, wire, value }) => {
        const found = wireHas({ body: wireRequest, names: wire, value });
        return {
            name,
            reported: warned.includes(name) || filteredParameters.includes(name),
            found: found.names,
            valueOnWire: found.valueOnWire,
        };
    });
    for (const { name, reported, found, valueOnWire } of caching) {
        if (reported) {
            log.condition({ label: `prompt caching · ${name}`, branch: 'ignored', why: 'the backend reported it as unsupported — nothing is asserted about the wire' });
        } else {
            log.condition({ label: `prompt caching · ${name}`, branch: 'accepted', why: `the backend kept it — the vendor request carries ${found.join(', ') || 'no wire name'}${valueOnWire ? '' : ' (the value did not travel)'}` });
        }
    }
    check({
        name: 'the prompt caching — every knob either reached the wire or was reported',
        passed: caching.every(({ reported, found, valueOnWire }) => reported || (found.length > 0 && valueOnWire)),
        detail: caching.map(({ name, reported, found }) => `${name}=${reported ? 'reported' : (found.join('|') || 'lost')}`).join(' '),
    });

    reportUsage({ provider, usage });
    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    log.success({ m: 'Chat complete.' });
}

runMain({ mainFn: main });
