// @ts-check
/**
 * Example 05 — Tool calling: the model chooses, the SDK executes.
 *
 * A support agent has real local tools — unit conversion, a city fact table
 * and an order lookup whose result must match its own schema — and four ways to
 * run them:
 *
 *   A — autonomous : `session.run({ initialInput, options })` drives the whole
 *       loop; the model picks the tools and the SDK executes and feeds them
 *       back. The round's calls are observed from the event stream.
 *   B — parallel   : `parallelToolCalls({ v: true })` lets the model batch
 *       several calls into one round; the round's call count is measured.
 *   C — manual     : iterate `session.step({ messages })` yourself, execute
 *       with `executeTools`, and rebuild the round with the message factories
 *       (`createSystemMessage`, `createAssistantMessage`, `createToolCallMessages`,
 *       `createToolResultMessage`) — the transcript is yours, and it normalizes
 *       back to the provider's wire.
 *   D — the contract: a tool declaring an `outputSchema` fails the call instead
 *       of answering wrongly, and `capToolOutputValue` trims a huge object
 *       before ANY of it reaches the model's context.
 *
 * Public API: `session.withTools(...).withSystemMessage(...)`,
 * `session.run({ initialInput, options })`, `session.step({ messages })`,
 * `executeTools({ toolCalls, toolLibrary })`, `capToolOutputValue`,
 * `createSystemMessage`, `createUserMessage`, `createAssistantMessage`,
 * `createToolCallMessages`, `createToolResultMessage`, `normalizeHistory`,
 * `getToolCallName`, `getToolCallArguments`.
 *
 * Run: `node examples/05_tool_calling.mjs`
 * Needs: `PROVIDER` plus its key in `secret.env`.
 *
 * @version 0.23.0
 */
import {
    createAssistantMessage, createSystemMessage, createToolCallMessages,
    createToolResultMessage, createUserMessage, getToolCallArguments, getToolCallName,
    initializeClient, loadCredentials, log, normalizeHistory,
} from 'merci-sdk';
import { capToolOutputValue, executeTools } from 'merci-sdk/tools';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const MAX_ITERATIONS = 4;
const MAX_MANUAL_STEPS = 4;

/** Real conversion math for `convert_units` — no lookup table of answers. */
const UNIT_CONVERSIONS = /** @type {Record<string, (arg0: {value: number}) => number>} */ ({
    'km->mi': ({ value }) => value / 1.609344,
    'mi->km': ({ value }) => value * 1.609344,
    'kg->lb': ({ value }) => value / 0.45359237,
    'lb->kg': ({ value }) => value * 0.45359237,
    'c->f': ({ value }) => value * 9 / 5 + 32,
    'f->c': ({ value }) => (value - 32) * 5 / 9,
});

/** In-memory city facts — the lookup tool's source of truth. */
const CITY_FACTS = new Map([
    ['tokyo', { country: 'Japan', population: '14.1M', capital: true }],
    ['lisbon', { country: 'Portugal', population: '0.55M', capital: true }],
    ['kyoto', { country: 'Japan', population: '1.46M', capital: false }],
    ['porto', { country: 'Portugal', population: '0.23M', capital: false }],
]);

const convertUnits = {
    name: 'convert_units',
    description: 'Convert a numeric value between units: km/mi, kg/lb, c/f.',
    parameters: {
        type: 'object',
        properties: {
            value: { type: 'number' },
            from: { type: 'string', enum: ['km', 'mi', 'kg', 'lb', 'c', 'f'] },
            to: { type: 'string', enum: ['km', 'mi', 'kg', 'lb', 'c', 'f'] },
        },
        required: ['value', 'from', 'to'],
    },
    execute: async (/** @type {{args: Record<string, any>}} */ { args }) => {
        const key = `${String(args.from).toLowerCase()}->${String(args.to).toLowerCase()}`;
        const convert = UNIT_CONVERSIONS[key];
        if (!convert) return { success: false, error: `Unsupported conversion '${key}' (use km/mi, kg/lb, c/f).` };
        return `${args.value} ${args.from} = ${Math.round(convert({ value: Number(args.value) }) * 1000) / 1000} ${args.to}`;
    },
};

const lookupCity = {
    name: 'lookup_city',
    description: 'Look up a city in the local fact table (country, population, capital flag).',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    execute: async (/** @type {{args: Record<string, any>}} */ { args }) => {
        const fact = CITY_FACTS.get(String(args.city).toLowerCase());
        return fact ? `${args.city}: ${JSON.stringify(fact)}` : { success: false, error: `No record for '${args.city}'.` };
    },
};

/** Every declared field is required by the model's consumers — a miss is a failed call. */
const orderStatus = {
    name: 'order_status',
    description: 'Return the status of an order as a structured record.',
    parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
    outputSchema: {
        type: 'object',
        properties: { orderId: { type: 'string' }, status: { type: 'string' }, etaDays: { type: 'number' } },
        required: ['orderId', 'status', 'etaDays'],
    },
    execute: async (/** @type {{args: Record<string, any>}} */ { args }) => ({ orderId: String(args.orderId), status: 'in_transit', etaDays: 2 }),
};

/** The same contract, deliberately broken: `etaDays` comes back as text. */
const brokenOrderStatus = {
    ...orderStatus,
    execute: async (/** @type {{args: Record<string, any>}} */ { args }) => ({ orderId: String(args.orderId), status: 'in_transit', etaDays: 'two' }),
};

const MANUAL_SYSTEM = 'You are a precise support agent. Use the tools; do not guess values.';
const MANUAL_PROMPT = 'Convert 3.5 kg to lb and then look up Kyoto. Give both results in one line.';

/** @param {{e: any, calls: string[]}} arg0 */
const collectCall = ({ e, calls }) => {
    if (e?.type === 'tool_call_start') calls.push(String(e.name));
    if (e?.type === 'tool_call_end') log.toolResult({ n: e.name, r: e.result });
};

async function main() {
    const { provider, toolModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    log.header({ t: `Example 05 — Tool calling (${provider})` });
    log.option({ name: 'model', value: toolModel, source: 'resolveExample() — the cheap tool tier' });
    log.option({ name: 'tools', value: 'convert_units, lookup_city, order_status', source: 'withTools({ tools }) — execute() does real work' });
    log.option({ name: 'iterations', value: MAX_ITERATIONS, source: 'run({ options }) / the manual step ceiling' });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // ── A: the autonomous loop ──────────────────────────────────────────────
    log.section({ t: 'A — autonomous: the model chooses, the SDK executes' });
    /** @type {string[]} */
    const autonomousCalls = [];
    let labeled = false;
    log.user({ m: 'How many miles is 26 km? Then what does the city table say about Lisbon?' });
    const autoAnswer = await client.session(toolModel)
        .withSystemMessage('You are a support agent. Call the tools for every value you report, then answer in two short lines.')
        .withTools({ tools: [convertUnits, lookupCity] })
        .run({
            initialInput: 'How many miles is 26 km? Then what does the city table say about Lisbon? Use convert_units and lookup_city.',
            options: {
                maxIterations: MAX_ITERATIONS,
                onEvent: (/** @type {any} */ e) => {
                    collectCall({ e, calls: autonomousCalls });
                    if (e.type === 'tool_call_start') log.toolCall({ n: e.name, a: log.truncate({ text: JSON.stringify(e.args), n: 100 }) });
                    else if (e.type === 'text') { if (!labeled && String(e.content ?? '')) { log.assistant({ m: '', isStreaming: true }); labeled = true; } process.stdout.write(String(e.content ?? '')); }
                    else if (e.type === 'stream_end' && labeled) { process.stdout.write('\n'); labeled = false; }
                },
            },
        });
    warnEmptyAnswer({ answer: autoAnswer, label: 'the autonomous run' });
    check({
        name: 'the model chose both tools in one autonomous run',
        ok: autonomousCalls.includes('convert_units') && autonomousCalls.includes('lookup_city'),
        detail: `calls=[${autonomousCalls.join(', ')}]`,
    });
    check({ name: 'the loop returned a final answer', ok: String(autoAnswer).trim().length > 0, detail: `${String(autoAnswer).trim().length} chars` });

    // ── B: parallel rounds ──────────────────────────────────────────────────
    log.section({ t: 'B — parallel: several calls in one round' });
    let inRound = 0;
    let maxInRound = 0;
    labeled = false;
    log.user({ m: 'Convert all four in one round: 5, 10, 20 and 42 km → mi.' });
    const parallelAnswer = await client.session(toolModel)
        .withSystemMessage('Convert every value you are given and list the results.')
        .withTools({ tools: [convertUnits] })
        .withParameters({ params: (/** @type {any} */ b) => b.parallelToolCalls({ v: true }) })
        .run({
            initialInput: 'Convert ALL FOUR in a SINGLE round of tool calls, then list the results: 5 km->mi, 10 km->mi, 20 km->mi, 42 km->mi.',
            options: {
                maxIterations: MAX_ITERATIONS,
                onEvent: (/** @type {any} */ e) => {
                    if (e.type === 'tool_call_start') { inRound += 1; maxInRound = Math.max(maxInRound, inRound); }
                    else if (e.type === 'stream_end') inRound = 0;
                    else if (e.type === 'text') { if (!labeled && String(e.content ?? '')) { log.assistant({ m: '', isStreaming: true }); labeled = true; } process.stdout.write(String(e.content ?? '')); }
                },
            },
        });
    if (labeled) process.stdout.write('\n');
    warnEmptyAnswer({ answer: parallelAnswer, label: 'the parallel run' });
    log.condition({
        label: 'parallel round',
        branch: maxInRound > 1 ? `${maxInRound} calls in one round` : 'the model stayed sequential',
        why: 'parallelToolCalls(true) advertises batching; the model decides',
    });
    check({ name: 'the parallel run finished with an answer', ok: String(parallelAnswer).trim().length > 0, detail: `max calls in one round=${maxInRound}` });

    // ── C: the manual loop and its transcript ───────────────────────────────
    log.section({ t: 'C — manual: you own the step loop and the transcript' });
    /** @type {Array<Record<string, any>>} */
    const manualCalls = [];
    /** @type {Array<Record<string, any>>} */
    const manualResults = [];
    const manualRows = [
        createSystemMessage({ provider, content: MANUAL_SYSTEM }),
        createUserMessage({ provider, content: MANUAL_PROMPT }),
    ];
    let manualText = '';
    labeled = false;
    let messages = manualRows;
    const manualSession = client.session(toolModel).withTools({ tools: [convertUnits, lookupCity] });
    log.user({ m: MANUAL_PROMPT });
    for (let step = 1; step <= MAX_MANUAL_STEPS; step++) {
        const gen = manualSession.step({ messages });
        let result = await gen.next();
        let roundCalls = 0;
        while (!result.done) {
            const ev = result.value;
            if (ev.type === 'text') { const chunk = String(ev.content ?? ''); if (!labeled && chunk) { log.assistant({ m: '', isStreaming: true }); labeled = true; } process.stdout.write(chunk); manualText += chunk; }
            if (ev.type === 'tool_request') {
                // The step event carries the wire calls; `executeTools` widens
                // them to its own row shape, which is the same objects.
                /** @type {Parameters<typeof executeTools>[0]['toolCalls']} */
                const calls = /** @type {Parameters<typeof executeTools>[0]['toolCalls']} */ (ev.calls ?? []);
                roundCalls = calls.length;
                for (const call of calls) {
                    const callRow = /** @type {Parameters<typeof getToolCallName>[0]['call']} */ (call);
                    log.toolCall({ n: getToolCallName({ call: callRow }), a: log.truncate({ text: JSON.stringify(getToolCallArguments({ call: callRow })), n: 100 }) });
                }
                const results = /** @type {Array<Record<string, any>>} */ (await executeTools({ toolCalls: calls, toolLibrary: [convertUnits, lookupCity] }));
                manualCalls.push(...calls);
                manualResults.push(...results);
                for (const res of results) log.toolResult({ n: res.name, r: res.success ? res.result : res.error });
                result = await gen.next(results);
                continue;
            }
            result = await gen.next();
        }
        if (labeled) { process.stdout.write('\n'); labeled = false; }
        messages = result.value?.messages ?? messages;
        log.event({ type: 'manual step', payload: { step, toolCalls: roundCalls, messages: messages.length } });
        if (roundCalls === 0) break;
    }
    warnEmptyAnswer({ answer: manualText, label: 'the manual loop' });
    check({
        name: 'the manual loop executed the calls it collected',
        ok: manualCalls.length >= 2 && manualResults.every((res) => res.success === true),
        detail: `calls=${manualCalls.length} results=${manualResults.length}`,
    });

    // The same round, rebuilt by hand: this is what a stored transcript looks
    // like, and the provider accepts it after normalization.
    const rebuilt = [
        createSystemMessage({ provider, content: MANUAL_SYSTEM }),
        createUserMessage({ provider, content: MANUAL_PROMPT }),
        ...createToolCallMessages({
            provider,
            calls: manualCalls.map((call) => ({
                id: String(call.id ?? call.tool_call_id ?? ''),
                name: String(getToolCallName({ call }) ?? ''),
                args: /** @type {string | Record<string, unknown>} */ (getToolCallArguments({ call })),
            })),
        }),
        ...manualResults.map((res) => createToolResultMessage({ provider, result: res })),
        createAssistantMessage({ provider, content: manualText || 'both results returned' }),
    ];
    const normalized = normalizeHistory({ provider, messages: rebuilt });
    const flat = JSON.stringify(normalized);
    check({
        name: 'the hand-built transcript survives normalization with call and result paired',
        ok: normalized.length === rebuilt.length && flat.includes('convert_units') && flat.includes('Kyoto'),
        detail: `rows=${rebuilt.length}→${normalized.length} call=${flat.includes('lookup_city')} result=${flat.includes('Kyoto')}`,
    });

    // ── D: the result contract and the output cap ───────────────────────────
    log.section({ t: 'D — the result contract: schema, then cap' });
    const goodEnvelope = /** @type {any} */ ((await executeTools({
        toolCalls: [{ id: 'c-order', name: 'order_status', arguments: '{"orderId":"A-1042"}' }],
        toolLibrary: [orderStatus],
    }))[0]);
    const badEnvelope = /** @type {any} */ ((await executeTools({
        toolCalls: [{ id: 'c-broken', name: 'order_status', arguments: '{"orderId":"A-1042"}' }],
        toolLibrary: [brokenOrderStatus],
    }))[0]);
    check({
        name: 'a result that matches its outputSchema passes',
        ok: goodEnvelope?.success === true && goodEnvelope?.result?.etaDays === 2,
        detail: `${goodEnvelope?.success} etaDays=${goodEnvelope?.result?.etaDays}`,
    });
    check({
        name: 'a result that breaks its outputSchema fails the call',
        ok: badEnvelope?.success === false && /outputSchema/.test(String(badEnvelope?.error)),
        detail: String(badEnvelope?.error ?? 'no error'),
    });

    const huge = { report: 'A'.repeat(400), rows: { first: 'B'.repeat(400), second: 'C'.repeat(400) } };
    const capped = capToolOutputValue({ value: huge, maxLength: 500 });
    /** @type {{report?: string, rows?: {first?: string, second?: string}}} */
    const cappedValue = /** @type {{report?: string, rows?: {first?: string, second?: string}}} */ (capped.value);
    const roundHuge = { report: 'D'.repeat(60_000) };
    const hugeEnvelope = /** @type {any} */ ((await executeTools({
        toolCalls: [{ id: 'c-huge', name: 'huge_report', arguments: '{}' }],
        toolLibrary: [{
            name: 'huge_report',
            description: 'Returns an oversized record.',
            parameters: { type: 'object', properties: {} },
            execute: async () => roundHuge,
        }],
    }))[0]);
    log.list({
        title: 'the output cap',
        items: [
            `direct: truncated=${capped.truncated} report kept=${cappedValue.report === huge.report} rows.first=${String(cappedValue.rows?.first).slice(0, 12)}…`,
            `round : ${JSON.stringify(hugeEnvelope?.result).length} chars for a ${JSON.stringify(roundHuge).length}-char object`,
        ],
    });
    check({
        name: 'capToolOutputValue keeps the shape and elides the oversized part',
        ok: capped.truncated === true && cappedValue.report === huge.report && cappedValue.rows?.first !== huge.rows.first,
        detail: `truncated=${capped.truncated} keys=${Object.keys(cappedValue).join(',')}`,
    });
    check({
        name: 'executeTools caps a huge object before it reaches the model',
        ok: hugeEnvelope?.success === true && JSON.stringify(hugeEnvelope.result).length <= 50_200,
        detail: `${JSON.stringify(hugeEnvelope?.result).length} chars for ${JSON.stringify(roundHuge).length}`,
    });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'Autonomous, parallel, manual and contracted tool rounds verified.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
