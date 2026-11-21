// @ts-check
/**
 * Example 10 — Multimodal intake: vision, document ingestion, structured output.
 *
 *   1 — VISION      : `createUnifiedMediaMessages({ backend, prompt, imagePath })`
 *       shapes `fixtures/image.png` into the backend's wire form (Gemini parts /
 *       Anthropic blocks / OpenAI content parts / JAI media part); one streamed step.
 *   2 — INGEST      : `ingestDocument({ client, model, path, backend })` runs one
 *       vision step and returns the document as Markdown.
 *   3 — PDF GUARD   : `PDF_MEDIA_PROVIDERS` decides whether an inline PDF is legal;
 *       a non-PDF backend refuses with a typed `ConfigurationError` (never sent).
 *   4 — STRUCTURED  : the Markdown feeds a schema-constrained run via
 *       `.withParameters({ params: (b) => b.asJsonSchema({ config: { name, schema } }) })`.
 *
 * Public API: `createUnifiedMediaMessages`, `ingestDocument`, `PDF_MEDIA_PROVIDERS`,
 * `ProviderType`, `ConfigurationError`, `.withParameters({ params })`.
 *
 * Run: `node examples/10_multimodal.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`; a vision-capable model.
 *
 * @version 0.23.0
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ProviderType, ConfigurationError, PDF_MEDIA_PROVIDERS, createUnifiedMediaMessages,
    initializeClient, ingestDocument, loadCredentials, log,
} from 'merci-sdk';
import { extractAndParseJson } from 'merci-sdk/json';
import { resolveExample, reportUsage, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const IMAGE_PATH = fileURLToPath(new URL('./fixtures/image.png', import.meta.url));
const VISION_PROMPT = 'Describe this image in two sentences. Mention any visible text.';

/**
 * Describes each media part without ever printing payload bytes.
 * @param {{messages: Array<Record<string, any>>}} arg0
 * @returns {string[]}
 */
function describeMedia({ messages }) {
    /** @type {string[]} */
    const out = [];
    for (const m of messages) {
        const parts = Array.isArray(m.parts) ? m.parts : Array.isArray(m.content) ? m.content : [m];
        for (const p of parts) {
            if (typeof p === 'string' || p?.text !== undefined) { out.push('text'); continue; }
            if (p?.inlineData) { out.push(`inline ${p.inlineData.mimeType}`); continue; }
            if (p?.type === 'image') { out.push(`image (${p.source?.media_type ?? 'base64'})`); continue; }
            if (p?.type === 'document') { out.push('document (base64)'); continue; }
            if (p?.type === 'image_url') { out.push('image (data-url)'); continue; }
            if (p?.type === 'file') { out.push(`file (${p.file?.filename ?? 'inline'})`); continue; }
            out.push(String(p?.type ?? m.role ?? m.type ?? 'part'));
        }
    }
    return out;
}

let failures = 0;
/** @param {{name: string, passed: boolean, detail?: string}} arg0 */
function check({ name, passed, detail }) {
    if (!passed) failures += 1;
    log.check({ name, passed, detail });
}

async function main() {
    const { provider, defaultModel } = resolveExample();
    log.header({ t: `Example 10 — Multimodal intake (${provider})` });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    const size = (await stat(IMAGE_PATH)).size;
    log.option({ name: 'image', value: `${IMAGE_PATH} (${size} bytes)`, source: 'import.meta.url → fixtures/image.png' });

    // ── 1 · vision: one media turn, streamed ─────────────────────────────────
    log.section({ t: '1 · createUnifiedMediaMessages → stream the answer' });
    const messages = await createUnifiedMediaMessages({ provider, prompt: VISION_PROMPT, imagePath: IMAGE_PATH });
    log.event({ type: 'media message(s)', payload: describeMedia({ messages }) });
    const expectedMessages = provider === ProviderType.JAI ? 2 : 1;
    check({ name: 'backend-shaped media turn', passed: messages.length === expectedMessages, detail: `${messages.length} message(s), expected ${expectedMessages}` });

    let visionAnswer = '';
    let visionLabeled = false;
    const gen = client.session(defaultModel).withSystemMessage('You are a precise image analyst.').step({ messages });
    let result = await gen.next();
    while (!result.done) {
        const ev = result.value;
        if (ev?.type === 'text') {
            const chunk = String(ev.content ?? '');
            if (!visionLabeled && chunk) { log.assistant({ m: '', isStreaming: true }); visionLabeled = true; }
            visionAnswer += chunk;
            process.stdout.write(chunk);
        }
        result = await gen.next();
    }
    if (visionLabeled) process.stdout.write('\n');
    warnEmptyAnswer({ answer: visionAnswer, label: 'the vision turn' });
    check({ name: 'the vision turn answered', passed: visionAnswer.trim().length > 0, detail: `${visionAnswer.trim().length} chars` });

    // ── 2 · document → Markdown ──────────────────────────────────────────────
    log.section({ t: '2 · ingestDocument → Markdown' });
    const markdown = await ingestDocument({ client, model: defaultModel, path: IMAGE_PATH, provider });
    log.info({ m: `markdown (${markdown.length} chars): ${log.truncate({ text: markdown, n: 400 })}` });
    check({ name: 'ingestDocument returned Markdown', passed: markdown.trim().length > 0, detail: `${markdown.trim().length} chars` });

    // ── 3 · PDF guard: only PDF-capable backends accept an inline document ───
    log.section({ t: '3 · PDF_MEDIA_PROVIDERS guard' });
    const pdfCapable = PDF_MEDIA_PROVIDERS.has(provider);
    log.option({ name: 'pdf-capable', value: pdfCapable, source: `PDF_MEDIA_PROVIDERS.has('${provider}') = {${[...PDF_MEDIA_PROVIDERS].join(', ')}}` });
    if (pdfCapable) {
        log.info({ m: 'This backend inlines application/pdf as a media part — the guard does not fire (no PDF fixture ships).' });
    } else {
        const dir = await mkdtemp(join(tmpdir(), 'merci-ingest-'));
        const pdfPath = join(dir, 'sample.pdf');
        await writeFile(pdfPath, '%PDF-1.4 demo placeholder — the guard rejects before the file is read', 'utf8');
        /** @type {any} */
        let guardErr = null;
        try { await ingestDocument({ client, model: defaultModel, path: pdfPath, provider }); } catch (err) { guardErr = err; }
        await rm(dir, { recursive: true, force: true });
        check({ name: 'PDF on a non-PDF backend fails fast', passed: guardErr instanceof ConfigurationError, detail: guardErr ? `${guardErr.name}: ${log.truncate({ text: guardErr.message, n: 120 })}` : 'no error — the dummy PDF reached the model' });
    }

    // ── 4 · the Markdown feeds a schema-constrained run ──────────────────────
    log.section({ t: '4 · structured output from the Markdown' });
    const schema = {
        type: 'object',
        properties: {
            headings: { type: 'array', items: { type: 'string' } },
            mentions_image: { type: 'boolean' },
        },
        required: ['headings', 'mentions_image'],
    };
    const outlineSession = client.session(defaultModel)
        .withSystemMessage('Extract structure from the Markdown document. Return only JSON matching the schema.')
        .withParameters({ params: (/** @type {any} */ b) => b.asJsonSchema({ config: { name: 'doc_outline', schema } }) });
    const raw = await outlineSession.run({
        initialInput: `Markdown document:\n\n${markdown}\n\nList every heading and set mentions_image to whether the document refers to an image.`,
        options: { maxIterations: 3 },
    });
    const parsed = extractAndParseJson({ input: raw, schema });
    check({ name: 'schema-constrained run produced valid JSON', passed: parsed.success, detail: parsed.success ? JSON.stringify(parsed.data) : String(parsed.error) });
    log.assistant({ m: JSON.stringify(parsed.data ?? {}) });
    warnEmptyAnswer({ answer: raw, label: 'the outline run' });

    reportUsage({ provider, usage });
    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    log.success({ m: 'Vision, ingestion and structured intake verified.' });
}

runMain({ mainFn: main });
