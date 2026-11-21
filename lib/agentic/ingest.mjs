// @ts-check


/**
 * @file Document ingestion → Markdown (images and PDFs via a model).
 * @version 0.12.0
 *
 * @description
 * Reusable form of the apps/01-OCR path: base64 the document into a unified
 * media message (createUnifiedMediaMessages) and run one streaming step
 * against a vision-capable model, returning the Markdown. No local PDF parser
 * is involved — the model does the transcription.
 */
import { promises as fs } from 'node:fs';
import { extname, resolve } from 'node:path';
import { MIME_TYPE_MAP } from '../core/constants/models.mjs';
import { ConfigurationError } from '../core/errors.mjs';
import { PDF_MEDIA_PROVIDERS } from '../messaging/messages.mjs';
import { createUnifiedMediaMessages } from '../backends/media.mjs';
import { isInsideRoot } from '../support/path-safety.mjs';
import { utilitySession } from './planning/planner-utils.mjs';
/**
 * @typedef {Object} IngestClient
 * @property {(model: string) => Object} session - Starts a model session.
 * @property {string} provider - ProviderType value.
 */



/** Instruction paired with the document in the user turn. */
export const DOCUMENT_INGEST_PROMPT =
    'Convert this document to Markdown following the conventions in your system instructions.';


/** System directive that fixes the Markdown output conventions. */
export const DOCUMENT_INGEST_SYSTEM_PROMPT = `You are an OCR engine. Convert the provided document to clean, faithful Markdown.
Follow these formatting conventions:
- Preserve the original content and order exactly; do not add commentary or summary.
- Headings: use a logical hierarchy starting at ## (never #). Numbered/nested structure becomes depth.
- Tables become pipe tables with a header separator row.
- Code blocks use triple-backtick fences with the language tag when identifiable.
- Lists keep the original bullet or numeric style, preserving nesting with indentation.
- Images become ![alt text](url) only if a caption exists; otherwise omit them.
- Keep raw numbers, measurements, dates, and proper nouns verbatim.
- Output only the Markdown, with no preamble or closing note.`;




/**
 * Ingests a document (image or PDF) as Markdown using a vision-capable model.
 * When `root` is a non-empty string the document path is resolved against it
 * and must exist inside the root's real path; the resolved absolute path is
 * then read, so a symlink cannot point the read outside. Without a root the
 * path is used as given.
 * @param {{client?: IngestClient, model?: string, path?: string, root?: string, provider?: string, signal?: AbortSignal}} arg0
 * @returns {Promise<string>} The document as Markdown.
 */
export async function ingestDocument({ client, model, path, root, provider, signal } = {}) {
    if (!client || typeof client.session !== 'function') {
        throw new ConfigurationError({ message: 'ingestDocument requires an initialized client (an object exposing session()).', options: { option: 'client' } });
    }
    if (typeof path !== 'string' || path.length === 0) {
        throw new ConfigurationError({ message: 'ingestDocument requires a document path.', options: { option: 'path' } });
    }
    /** @type {string} */
    let documentPath = path;
    if (typeof root === 'string' && root !== '') {
        const base = resolve(root);
        documentPath = resolve(base, path);
        const realRoot = await fs.realpath(base).catch(() => null);
        if (realRoot === null) {
            throw new ConfigurationError({ message: `ingestDocument: root cannot be resolved: ${base}`, options: { option: 'root' } });
        }
        const realTarget = await fs.realpath(documentPath).catch(() => null);
        if (realTarget === null) {
            throw new ConfigurationError({ message: `ingestDocument: document cannot be resolved inside root: ${documentPath}`, options: { option: 'path' } });
        }
        if (!isInsideRoot({ root: realRoot, path: realTarget })) {
            throw new ConfigurationError({ message: `ingestDocument: path is outside root: ${documentPath}`, options: { option: 'path' } });
        }
    }
    const resolvedProvider = provider ?? client.provider;
    const ext = extname(documentPath).toLowerCase();
    const mimeType = MIME_TYPE_MAP[ext];
    if (!mimeType) {
        throw new ConfigurationError({ message: `Unsupported document type "${ext || documentPath}". Supported: ${Object.keys(MIME_TYPE_MAP).join(', ')}.`, options: { option: 'unsupported_document_type' } });
    }
    if (mimeType === 'application/pdf' && !PDF_MEDIA_PROVIDERS.has(resolvedProvider)) {
        throw new ConfigurationError({ message: `PDF ingestion is not supported on the ${resolvedProvider} provider: only ${[...PDF_MEDIA_PROVIDERS].join(', ')} can inline application/pdf as a media message.`, options: { option: 'pdf_provider_unsupported' } });
    }

    const messages = await createUnifiedMediaMessages({ provider: resolvedProvider, prompt: DOCUMENT_INGEST_PROMPT, imagePath: documentPath });
    let markdown = '';
    const session = utilitySession({ client, model, systemMessage: DOCUMENT_INGEST_SYSTEM_PROMPT });
    for await (const event of session.step({ messages, options: { signal } })) {
        if (event?.type === 'text') markdown += event.content;
    }
    return markdown;
}
