// @ts-check
/**
 * Example 03 — Structured output: JSON Schema, Zod, and bounded corrections.
 *
 * One real-life job — turn an invoice email into validated data — through
 * four paths:
 *
 *   A — JSON Schema : `.withParameters({ params: (b) =>
 *       b.asJsonSchema({ config: { name: 'invoice', schema } }) })` plus
 *       `session.run({ options: { maxIterations, maxSchemaRetries } })`. The run
 *       loop validates the deliverable against the schema and appends a
 *       corrective turn up to `maxSchemaRetries` times before giving up, so a
 *       malformed answer is corrected in-session; the caller-side `guardedParse`
 *       below is the always-on backstop.
 *   B — Zod          : author the same invoice in Zod, convert it for the wire
 *       with `zodSchemaToJsonSchema({ zodSchema })` from `merci-sdk/json`, and
 *       keep Zod as the LOCAL validator (`safeParse`) — richer issues than raw
 *       JSON Schema.
 *   C — Validator    : `guardedParse` repairs a trailing comma (healer) and
 *       reports unparseable prose as a value — never a throw.
 *   D — Correction   : a scripted stub answers prose first and valid JSON
 *       second; `structuredLlmCall({ maxAttempts })` retries on a fresh session
 *       and returns the object. Exhausting the budget ends in the typed
 *       `OrchestrationExhaustedError` — a clean typed failure, not a raw parse
 *       crash.
 *
 * Public API: `client.session(model).withParameters(...)`, `session.run(...)`,
 * `guardedParse`, `zodSchemaToJsonSchema`, `structuredLlmCall`.
 *
 * Run: `node examples/03_structured_output.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { z } from 'zod';
import {
    OrchestrationExhaustedError, initializeClient, loadCredentials, log,
} from 'merci-sdk';
import { guardedParse, zodSchemaToJsonSchema } from 'merci-sdk/json';
import { structuredLlmCall } from 'merci-sdk/planning';
import { reportUsage, resolveExample, runMain, trackUsage, wireClient } from './_shared/example-utils.mjs';

const MAX_ITERATIONS = 3;
const MAX_SCHEMA_RETRIES = 2;
const MAX_STUB_ATTEMPTS = 2;

const INVOICE_TEXT = [
    'Invoice INV-2041 — Nordwind GmbH',
    'Bill to: Hotel Adler, Berlin',
    '- 2 x City map — 4.50 EUR each',
    '- 1 x Museum pass — 22.00 EUR',
    '- 3 x Coffee voucher — 3.80 EUR each',
    'Total due: 42.40 EUR',
].join('\n');

const INVOICE_SCHEMA = {
    type: 'object',
    properties: {
        vendor: { type: 'string' },
        invoice_number: { type: 'string' },
        currency: { type: 'string', enum: ['EUR', 'USD', 'GBP'] },
        total: { type: 'number' },
        line_items: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    description: { type: 'string' },
                    quantity: { type: 'number' },
                    unit_price: { type: 'number' },
                },
                required: ['description', 'quantity', 'unit_price'],
            },
        },
    },
    required: ['vendor', 'invoice_number', 'currency', 'total', 'line_items'],
};

/** The same invoice, authored in Zod (validated locally with `safeParse`). */
const InvoiceZ = z.object({
    vendor: z.string(),
    invoice_number: z.string(),
    currency: z.enum(['EUR', 'USD', 'GBP']),
    total: z.number(),
    line_items: z.array(z.object({
        description: z.string(),
        quantity: z.number(),
        unit_price: z.number(),
    })),
});

const INVOICE_PROMPT = 'Extract the invoice below into the invoice object. Copy the given invoice_number, currency, and total exactly as written.\n\n' + INVOICE_TEXT;

/**
 * A deterministic stub client for path D: each `session()` returns the next
 * scripted answer, so the corrective retry is observable without a live model.
 * @param {{script: string[]}} arg0
 */
function scriptedClient({ script }) {
    let opened = 0;
    return {
        provider: 'openai',
        sessionsOpened: () => opened,
        session() {
            const text = script[Math.min(opened, script.length - 1)];
            opened += 1;
            const session = {
                withSystemMessage() { return session; },
                withParameters() { return session; },
                async run() { return text; },
            };
            return session;
        },
    };
}

/**
 * A — JSON Schema response format + the in-session corrective retry.
 * @param {{client: any, model: string}} arg0
 */
async function jsonSchemaPath({ client, model }) {
    log.phase({ t: 'A — JSON Schema', sub: 'asJsonSchema({ config: { name, schema } })' });
    let corrections = 0;
    const session = client.session(model)
        .withParameters({ params: (/** @type {any} */ b) => b.asJsonSchema({ config: { name: 'invoice', schema: INVOICE_SCHEMA } }) });
    const raw = await session.run({
        initialInput: INVOICE_PROMPT,
        options: {
            maxIterations: MAX_ITERATIONS,
            maxSchemaRetries: MAX_SCHEMA_RETRIES,
            onEvent: (/** @type {any} */ e) => {
                if (e.type === 'schema_validation_failed') {
                    corrections += 1;
                    log.warn({ m: `invalid JSON corrected in-loop (${corrections}/${MAX_SCHEMA_RETRIES})` });
                }
            },
        },
    });
    log.info({ m: `in-loop corrections: ${corrections} (bounded by maxSchemaRetries=${MAX_SCHEMA_RETRIES})` });
    const parsed = guardedParse({ input: raw, schema: INVOICE_SCHEMA });
    const invoice = /** @type {{total?: unknown, currency?: unknown}} */ (parsed.data);
    log.check({ name: 'A — JSON Schema extraction', passed: parsed.success, detail: parsed.success ? `total=${invoice.total} ${invoice.currency}` : String(parsed.error) });
    if (parsed.success) log.dump({ label: 'INVOICE · JSON Schema', value: /** @type {Object} */ (parsed.data) });
    return parsed;
}

/**
 * B — the same job authored in Zod; Zod also validates the parsed result.
 * @param {{client: any, model: string}} arg0
 */
async function zodPath({ client, model }) {
    log.phase({ t: 'B — Zod schema', sub: 'zodSchemaToJsonSchema({ zodSchema })' });
    const wireSchema = zodSchemaToJsonSchema({ zodSchema: InvoiceZ });
    log.option({ name: 'wire fields', value: Object.keys(wireSchema?.properties ?? {}).join(', '), source: 'plain JSON Schema — no Zod instance reaches the backend' });

    const session = client.session(model)
        .withParameters({ params: (/** @type {any} */ b) => b.asJsonSchema({ config: { name: 'invoice', schema: wireSchema } }) });
    const raw = await session.run({
        initialInput: INVOICE_PROMPT,
        options: { maxIterations: MAX_ITERATIONS, maxSchemaRetries: MAX_SCHEMA_RETRIES },
    });

    const parsed = guardedParse({ input: raw, schema: /** @type {Record<string, any>} */ (wireSchema) });
    const zodParsed = parsed.success ? InvoiceZ.safeParse(parsed.data) : null;
    const detail = zodParsed?.success
        ? `vendor=${zodParsed.data.vendor} items=${zodParsed.data.line_items.length}`
        : (zodParsed ? zodParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(parsed.error));
    log.check({ name: 'B — Zod extraction (safeParse)', passed: zodParsed?.success === true, detail });
    if (zodParsed?.success) log.dump({ label: 'INVOICE · Zod', value: zodParsed.data });
    return zodParsed?.success === true;
}

/** C — malformed answers are values the caller can inspect, never exceptions. */
function validatorEdge() {
    log.phase({ t: 'C — the validator never throws', sub: 'guardedParse({ input, schema })' });
    const healed = guardedParse({ input: '{"vendor": "Nordwind GmbH", "invoice_number": "INV-2041", "currency": "EUR", "total": 42.4, "line_items": [],}', schema: INVOICE_SCHEMA });
    const prose = guardedParse({ input: 'Sorry, I cannot read this invoice.', schema: INVOICE_SCHEMA });
    log.check({ name: 'C — trailing comma healed', passed: healed.success && healed.healed === true, detail: healed.error ?? 'ran through the JSON healer' });
    log.check({ name: 'C — prose reported as a value', passed: prose.success === false && typeof prose.error === 'string', detail: String(prose.error) });
}

/** D — bounded corrective retry, demonstrated deterministically. */
async function correctionProof() {
    log.phase({ t: 'D — bounded correction', sub: `structuredLlmCall({ maxAttempts: ${MAX_STUB_ATTEMPTS} }) retries parse failures on fresh sessions` });
    const stub = scriptedClient({ script: [
        'I can only answer in prose.',
        '{"vendor":"Nordwind GmbH","invoice_number":"INV-2041","currency":"EUR","total":42.4,"line_items":[{"description":"City map","quantity":2,"unit_price":4.5}],}',
    ] });
    const data = await structuredLlmCall({
        client: stub, model: 'scripted', systemMessage: 'Return JSON.',
        schema: INVOICE_SCHEMA, prompt: INVOICE_PROMPT, label: '03D', schemaName: 'invoice',
        maxAttempts: MAX_STUB_ATTEMPTS,
    });
    log.event({ type: 'stub sessions', payload: stub.sessionsOpened(), detail: 'attempt 1 prose → attempt 2 healable JSON with a trailing comma' });
    log.check({ name: 'D — prose corrected to a valid object', passed: data?.invoice_number === 'INV-2041', detail: `vendor=${data?.vendor} total=${data?.total}` });

    const hopeless = scriptedClient({ script: ['still not JSON'] });
    try {
        await structuredLlmCall({
            client: hopeless, model: 'scripted', systemMessage: 'Return JSON.',
            schema: INVOICE_SCHEMA, prompt: INVOICE_PROMPT, schemaName: 'invoice',
            maxAttempts: MAX_STUB_ATTEMPTS,
        });
        log.check({ name: 'D — exhausted budget stays typed', passed: false, detail: 'expected OrchestrationExhaustedError' });
    } catch (err) {
        const typed = err instanceof OrchestrationExhaustedError;
        const e = /** @type {Error} */ (err);
        log.check({ name: 'D — exhausted budget stays typed', passed: typed, detail: `${e.name}: ${log.truncate({ text: String(e.message), n: 90 })}` });
    }
}

async function main() {
    const { provider, defaultModel } = resolveExample();
    log.header({ t: `Example 03 — Structured output (${provider})` });
    log.option({ name: 'model', value: defaultModel || '(empty)', source: 'getDefaultModel({ backend })' });
    log.option({ name: 'bounds', value: `maxIterations=${MAX_ITERATIONS}, maxSchemaRetries=${MAX_SCHEMA_RETRIES}`, source: 'literals passed via session.run options' });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    const bySchema = await jsonSchemaPath({ client, model: defaultModel });
    const byZod = await zodPath({ client, model: defaultModel });
    validatorEdge();
    await correctionProof();

    log.totals({ entries: {
        'A · JSON Schema': bySchema.success ? 'valid' : 'invalid',
        'B · Zod': byZod ? 'valid' : 'invalid',
        'C · validator': 'deterministic',
        'D · correction': 'deterministic',
    }, label: 'PATHS' });
    reportUsage({ provider, usage });
    log.success({ m: 'Structured output complete.' });
}

runMain({ mainFn: main });
