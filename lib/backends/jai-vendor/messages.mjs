// @ts-check
/**
 * @file JAI wire message shaping and media message creation.
 * @version 0.12.0
 *
 * @description
 * Normalizes unified messages to the JAI wire shape: native system_message
 * rows (probed live on the gateway), thought_signature field renames,
 * tool-result JSON coercion, array-content splitting into media_message rows —
 * plus base64 media message construction from files or Buffers.
 */

import { promises as fs } from 'node:fs';
import { Buffer } from 'node:buffer';
import { mimeTypeForPath } from '../../support/mime.mjs';
import { parseBase64DataUrl } from '../../support/data-url.mjs';
import { stripInjectionMeta, joinSystemParts, dedupeMessages } from '../../messaging/messages.mjs';

/**
 * Shapes unified messages onto the JAI wire format.
 * @param {{messages: Array<import('../../messaging/unified-message.mjs').MessageRow>}} arg0
 * @returns {Array<Record<string, unknown>>} JAI-shaped chat messages.
 */
export function formatJaiMessages({ messages }) {
    if (!Array.isArray(messages)) return messages;
    // F7: dedupe while the rows still carry their identity (see messages.mjs).
    const shaped = stripInjectionMeta({ messages: dedupeMessages({ messages }) }).map((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const m = raw;
        switch (m.type) {
            case 'assistant_message_text':
            case 'assistant_message_tool': {
                if (m.thoughtSignature) {
                    if ('thought_signature' in m) {
                        const { thought_signature: _drop, ...rest } = m;
                        return rest;
                    }
                    return m;
                }
                if (m.thought_signature) {
                    const { thought_signature, ...rest } = m;
                    return { ...rest, thoughtSignature: thought_signature };
                }
                return m;
            }
            case 'tool_message': {
                let result = m;
                if ('thought_signature' in result || 'thoughtSignature' in result) {
                    const { thought_signature, thoughtSignature, ...rest } = result;
                    result = rest;
                }
                if ('result' in result && typeof result.result !== 'string') {
                    try {
                        result = { ...result, result: JSON.stringify(result.result) };
                    } catch (e) {
                        result = { ...result, result: String(result.result) };
                    }
                }
                return result;
            }
            default:
                return m;
        }
    });

    /** @type {Array<Record<string, any>>} */
    const chatMessages = [];
    for (const msg of shaped) {
        if (msg && msg.type === 'user_message' && Array.isArray(msg.content)) {
            chatMessages.push(...splitUserContent({ parts: msg.content }));
        } else {
            chatMessages.push(msg);
        }
    }

    if (chatMessages.length > 0 && chatMessages.every((m) => /** @type {any} */ (m)?.type === 'system_message')) {
        let buf = null;
        for (const m of chatMessages) buf = joinSystemParts({ acc: buf, part: (m).content ?? '' });
        return [{ type: 'user_message', content: buf }];
    }
    return chatMessages;
}

/**
 * Splits an array-content user message into JAI-native rows: base64 media
 * parts become media_message rows (emitted first, the native media+prompt
 * order), text parts join into one trailing user_message. Unrecognized parts
 * are JSON-encoded into the text — never silently dropped.
 * @param {{parts: Array<any>}} arg0
 * @returns {Array<Record<string, any>>} media_message rows and one user_message row.
 */
function splitUserContent({ parts }) {
    /** @type {Array<Record<string, any>>} */
    const out = [];
    /** @type {Array<string>} */
    const texts = [];
    for (const part of parts) {
        if (part == null) continue;
        if (typeof part === 'string') { texts.push(part); continue; }
        if (typeof part !== 'object') { texts.push(String(part)); continue; }
        if (typeof part.text === 'string') { if (part.text) texts.push(part.text); continue; }
        const media = mediaRowFromPart({ part });
        if (media) { out.push(media); continue; }
        texts.push(JSON.stringify(part));
    }
    if (texts.length > 0) {
        out.push({ type: 'user_message', content: texts.join('\n') });
    } else if (out.length === 0) {
        out.push({ type: 'user_message', content: JSON.stringify(parts) });
    }
    return out;
}

/**
 * Converts one multimodal content part to a JAI media_message when it carries
 * base64 media (OAI image_url data URL, GAI inlineData, AAI image source).
 * @param {{part: Record<string, any>}} arg0
 * @returns {Record<string, any>|null}
 */
function mediaRowFromPart({ part }) {
    const inline = part.inlineData || part.inline_data;
    if (inline && typeof inline.data === 'string') {
        return { type: 'media_message', mediaType: inline.mimeType || inline.mime_type || 'application/octet-stream', data: inline.data };
    }
    const source = part.source;
    if (source && typeof source.data === 'string') {
        return { type: 'media_message', mediaType: source.media_type || source.mediaType || 'application/octet-stream', data: source.data };
    }
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    if (typeof url === 'string') {
        const parsed = parseBase64DataUrl({ url });
        if (parsed) return { type: 'media_message', mediaType: parsed.mimeType, data: parsed.data };
    }
    return null;
}

/**
 * Builds a base64 media message from a file path or Buffer.
 * @param {{source: string|Buffer, explicitMimeType?: string}} arg0
 * @returns {Promise<Record<string, unknown>>} A `media_message` row.
 */
export async function createMediaMessage({ source, explicitMimeType }) {
    let data;
    let mediaType;
    if (typeof source === 'string') {
        data = await fs.readFile(source);
        if (explicitMimeType) {
            mediaType = explicitMimeType;
        } else {
            mediaType = mimeTypeForPath({ path: source, fallback: 'application/octet-stream', extra: { '.svg': 'image/svg+xml' } });
        }
    } else if (Buffer.isBuffer(source)) {
        if (!explicitMimeType) throw new Error('explicitMimeType is required when creating a media message from a Buffer.');
        data = source;
        mediaType = explicitMimeType;
    } else {
        throw new Error('source must be a file path (string) or a Buffer.');
    }
    return { type: 'media_message', mediaType: mediaType, data: data.toString('base64') };
}
