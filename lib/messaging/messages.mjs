// @ts-check
/**
 * @file Unified message factories and per-backend history normalizers.
 * @version 0.12.0
 *
 * @description
 * Creates wire-shaped messages for all four backends (JAI/OAI/AAI/GAI) and
 * normalizes mixed-shape histories into one backend's wire format. Owns the
 * non-wire row identity (merciId) and injection-marker keys, the
 * media/vision factories, and the tool-call name/argument helpers.
 */

import { guardedParse } from '../support/json.mjs';
import { parseBase64DataUrl, toBase64DataUrl } from '../support/data-url.mjs';
import { randomUUID } from 'node:crypto';
import {
    ProviderType,
    ProtocolType,
    PROVIDERS,
    StandardType,
    standardFor,
    isOSeries,
    isStandard,
    SYSTEM_MESSAGE_MERGE_SEPARATOR,
    INJECTION_META_KEY,
    MERCI_ID_KEY,
    MERCI_NATIVE_KEY
} from '../core/constants/index.mjs';
import { LIMITS } from '../core/limit-config.mjs';

/**
 * A tool call in any of the four shapes (OAI `function`, JAI `tool_calls`,
 * GAI `functionCall`, AAI `tool_use`).
 * @typedef {Object} ToolCallShape
 * @property {string} [id]
 * @property {string} [type]
 * @property {string} [name]
 * @property {string|Object} [arguments]
 * @property {string|Object} [args]
 * @property {unknown} [input]
 * @property {{name?: string, arguments?: string}} [function]
 * @property {string} [thoughtSignature]
 */

/**
 * A Google GenAI function call part.
 * @typedef {Object} GaiFunctionCall
 * @property {string} [id]
 * @property {string} [name]
 * @property {unknown} [args]
 * @property {unknown} [arguments]
 */

/**
 * A Google GenAI function response part.
 * @typedef {Object} GaiFunctionResponse
 * @property {string} [id]
 * @property {string} [name]
 * @property {unknown} [response]
 * @property {unknown} [output]
 * @property {boolean} [is_error]
 */

/**
 * An Anthropic media source (base64 or url).
 * @typedef {Object} MediaSource
 * @property {string} [type]
 * @property {string} [url]
 * @property {string} [data]
 * @property {string} [media_type]
 */

/**
 * The Anthropic prompt-cache marker a structured system block may carry.
 * @typedef {Object} CacheControl
 * @property {string} [type]
 * @property {string} [ttl]
 */

/**
 * A wire-capable message row, or one content block / provider-native item of
 * one. The four backends overlap enough that one union covers both: a row has
 * `role`/`type`, a block has `text`/`functionCall`/`type`, and every key is
 * optional because a row carries only what its backend emits.
 * @typedef {Object} MessageRow
 * @property {string} [role]
 * @property {string} [type]
 * @property {string|Array<MessageRow>|null} [content]
 * @property {Array<MessageRow>} [parts]
 * @property {Array<ToolCallShape>} [tool_calls]
 * @property {string} [tool_call_id]
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [toolName]
 * @property {string|Object|null} [result]
 * @property {string} [text]
 * @property {string} [thinking]
 * @property {string} [signature]
 * @property {boolean} [thought]
 * @property {string} [tool_use_id]
 * @property {boolean} [is_error]
 * @property {unknown} [input]
 * @property {string} [input_arguments]
 * @property {GaiFunctionCall} [functionCall]
 * @property {GaiFunctionResponse} [functionResponse]
 * @property {{url?: string}} [image_url]
 * @property {{file_data?: string, filename?: string}} [file]
 * @property {{mimeType?: string, mime_type?: string, data?: string}} [inlineData]
 * @property {{mimeType?: string, mime_type?: string, data?: string}} [inline_data]
 * @property {{fileUri?: string, mimeType?: string}} [fileData]
 * @property {{name?: string, arguments?: string}} [function]
 * @property {string|Object} [arguments]
 * @property {string|Object} [args]
 * @property {MediaSource} [source]
 * @property {string} [filename]
 * @property {string|null} [thoughtSignature]
 * @property {string} [thought_signature]
 * @property {CacheControl} [cache_control]
 * @property {string} [encrypted_content]
 * @property {Array<MessageRow>} [summary]
 * @property {string} [status]
 * @property {string} [merciId]
 * @property {string} [merciInjection]
 * @property {string} [reasoning_content]
 * @property {string} [reasoningContent]
 * @property {Array<string>} [redactedThinking]
 * @property {boolean} [success]
 * @property {string} [error]
 * @property {boolean} [merci_success]
 */

/**
 * Options a caller passes to `normalizeHistory` (the JAI replay path).
 * @typedef {Object} JaiNormalizeOptions
 * @property {string} [protocol]
 */

/**
 * Options a caller passes to `normalizeToOAI`.
 * @typedef {Object} OaiNormalizeOptions
 * @property {boolean} [keepNative]
 */

/** @param {{row: *}} arg0 */
/** @param {{row: *}} arg0 */
const withId = ({ row }) => {
    row[MERCI_ID_KEY] = randomUUID();
    return row;
};

/**
 * Returns a copy of `messages` with the non-wire keys (INJECTION_META_KEY,
 * MERCI_ID_KEY and — unless `keepNative` — MERCI_NATIVE_KEY) removed from every
 * message. Pure: returns the same array reference when nothing was stripped (so
 * normalizers that already clone pay no extra allocation).
 * `keepNative` is for the same-protocol path only (the OAI Responses builder
 * reads the native items while it converts the rows; the resulting wire body
 * carries `input` items, never the row objects).
 * This is the boundary where identity leaves (F7): every normalizer dedupes by
 * `merciId` before it calls this, so a replay cannot cross it.
 * @param {{messages: Array<MessageRow>, keepNative?: boolean}} arg0
 * @returns {Array<MessageRow>}
 */
export function stripInjectionMeta({ messages, keepNative = false }) {
    if (!Array.isArray(messages)) return messages;
    let touched = false;
    const out = messages.map(m => {
        if (m && typeof m === 'object'
            && (Object.prototype.hasOwnProperty.call(m, INJECTION_META_KEY)
                || Object.prototype.hasOwnProperty.call(m, MERCI_ID_KEY)
                || (!keepNative && Object.prototype.hasOwnProperty.call(m, MERCI_NATIVE_KEY)))) {
            touched = true;
            const nativeValue = /** @type {Record<string, unknown>} */ (m)[MERCI_NATIVE_KEY];
            if (!keepNative || nativeValue === undefined) {
                const rest = /** @type {MessageRow} */ ({ ...m });
                const rec = /** @type {Record<string, unknown>} */ (rest);
                delete rec[INJECTION_META_KEY];
                delete rec[MERCI_ID_KEY];
                if (!keepNative) delete rec[MERCI_NATIVE_KEY];
                return rest;
            }
            const kept = /** @type {MessageRow} */ ({ ...m });
            const keptRec = /** @type {Record<string, unknown>} */ (kept);
            delete keptRec[INJECTION_META_KEY];
            delete keptRec[MERCI_ID_KEY];
            keptRec[MERCI_NATIVE_KEY] = nativeValue;
            return kept;
        }
        return m;
    });
    return touched ? out : messages;
}

/**
 * Attaches the provider-native replay payload to a row (non-wire; stripped by
 * every normalizer). Called by the step engine for rows produced by a backend
 * that can echo native items on a later turn.
 * @param {{row: MessageRow, provider: string, protocol: string|null, items: Array<MessageRow>}} arg0
 * @returns {MessageRow}
 */
export function attachNative({ row, provider, protocol, items }) {
    if (!row || !Array.isArray(items) || items.length === 0) return row;
    /** @type {Record<string, unknown>} */ (row)[MERCI_NATIVE_KEY] = { provider, protocol: protocol ?? null, items };
    return row;
}

/**
 * Reads a row's provider-native replay payload, or null when absent.
 * @param {{row: MessageRow}} arg0
 * @returns {{ provider: string, protocol: string|null, items: Array<MessageRow> }|null}
 */
export function getNative({ row }) {
    const raw = row && typeof row === 'object'
        ? /** @type {Record<string, unknown>} */ (row)[MERCI_NATIVE_KEY]
        : null;
    if (!raw || typeof raw !== 'object') return null;
    const stored = /** @type {{provider?: unknown, backend?: unknown, protocol?: unknown, items?: unknown}} */ (raw);
    const provider = stored.provider ?? stored.backend; // data compat: rows persisted before the rename
    const { protocol, items } = stored;
    if (!Array.isArray(items) || items.length === 0) return null;
    return {
        provider: typeof provider === 'string' ? provider : '',
        protocol: typeof protocol === 'string' ? protocol : null,
        items: /** @type {Array<MessageRow>} */ (items)
    };
}

/**
 * Removes duplicate rows by their stable merciId. FIRST occurrence wins (the
 * original row) — replay safety: a replayed history can never double-append.
 * Rows without an id always pass through. Pure — same reference when no
 * duplicates were found. Corrected-content replays must create a NEW row
 * (a fresh id), not mutate one in place.
 *
 * F7: this is only meaningful while the rows still carry an id. Every normalizer
 * applies it at its entry (before `stripInjectionMeta`), so a caller cannot lose
 * the protection by normalizing first and deduping afterwards — and the wire never
 * carries the identity it compared.
 * @param {{messages: Array<MessageRow>}} arg0
 * @returns {Array<MessageRow>}
 */
export function dedupeMessages({ messages }) {
    if (!Array.isArray(messages)) return messages;
    const seen = new Set();
    const out = [];
    for (const m of messages) {
        if (!m || typeof m !== 'object') { out.push(m); continue; }
        const id = /** @type {Record<string, unknown>} */ (m)[MERCI_ID_KEY];
        if (id != null) {
            if (seen.has(id)) continue;
            seen.add(id);
        }
        out.push(m);
    }
    return out.length === messages.length ? messages : out;
}

/**
 * Merges consecutive system parts with the shared separator.
 * @param {{acc: string|null, part: string}} arg0
 * @returns {string}
 */
export function joinSystemParts({ acc, part }) {
    return acc ? acc + SYSTEM_MESSAGE_MERGE_SEPARATOR + part : part;
}

/**
 * True when a message is an assistant/model turn carrying no payload — such
 * rows must never reach the wire (a trailing one is a 400 on Gemini/JAI);
 * tool-call rows, multimodal content arrays and GAI functionCall parts are
 * never empty turns.
 * @param {{m: MessageRow}} arg0
 * @returns {boolean}
 */
export function isEmptyAssistantTurn({ m }) {
    if (!m || typeof m !== 'object') return false;
    const isAssistant = m.type === 'assistant_message_text'
        || m.type === 'assistant_message'
        || m.role === 'assistant'
        || m.role === 'model';
    if (!isAssistant) return false;
    if (m.type === 'assistant_tool_call' || m.type === 'assistant_message_tool') return false;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return false;
    if (m.reasoning_content) return false;
    if (m.role === 'model' && Array.isArray(m.parts)) {
        return !m.parts.some(p => p && typeof p === 'object' && !p.thought
            && ((typeof p.text === 'string' && p.text.trim() !== '') || p.functionCall || p.inlineData || p.fileData));
    }
    if (Array.isArray(m.content)) {
        return m.content.length === 0 || m.content.every(b => b && typeof b === 'object'
            && b.type === 'text' && typeof b.text === 'string' && !b.text.trim());
    }
    return !String(m.content ?? '').trim();
}

/** @param {{provider: *, role: *, typeName: *, content: *}} arg0 */
function shapeMessage({ provider, role, typeName, content }) {
    return withId({ row: provider === ProviderType.JAI
        ? { type: typeName, content }
        : { role, content } });
}

/**
 * Creates a user message in the backend's wire shape.
 * @param {{provider: string, content: string|Array<MessageRow>}} arg0
 * @returns {MessageRow}
 */
export function createUserMessage({ provider, content }) {
    return shapeMessage({ provider, role: 'user', typeName: 'user_message', content });
}

/**
 * Creates a system message in the backend's wire shape.
 * @param {{provider: string, content: string|Array<MessageRow>}} arg0
 * @returns {MessageRow}
 */
export function createSystemMessage({ provider, content }) {
    return shapeMessage({ provider, role: 'system', typeName: 'system_message', content });
}

/**
 * Creates an assistant text message, optionally carrying a thought signature
 * (and DeepSeek-style `reasoning_content` for multi-turn continuity).
 * @param {{provider: string, content: string, thoughtSignature?: string|null, reasoningContent?: string, redactedThinking?: Array<string>}} arg0
 * @returns {MessageRow}
 */
export function createAssistantMessage({ provider, content, thoughtSignature, reasoningContent, redactedThinking }) {
    if (provider === ProviderType.JAI) {
        const msg = /** @type {MessageRow} */ ({ type: 'assistant_message_text', content });
        if (thoughtSignature) msg.thought_signature = thoughtSignature;
        return withId({ row: msg });
    }
    if (isStandard({ provider, standard: StandardType.GAI })) {
        const part = /** @type {MessageRow} */ ({ text: content });
        if (thoughtSignature) part.thoughtSignature = thoughtSignature;
        return withId({ row: { role: 'model', parts: [part] } });
    }
    const msg = /** @type {MessageRow} */ ({ role: 'assistant', content });
    if (thoughtSignature) msg.thoughtSignature = thoughtSignature;
    if (reasoningContent) msg.reasoning_content = reasoningContent;
    if (provider === ProviderType.ANTHROPIC && redactedThinking && redactedThinking.length > 0) {
        msg.redactedThinking = redactedThinking;
    }
    return withId({ row: msg });
}

/**
 * Creates an assistant tool-call message in the backend's wire shape. `calls`
 * (GAI only) carries a whole parallel turn as `{ id, name, args, thoughtSignature }`
 * entries, so one model row holds every call; the single-call arguments are
 * its one-entry form.
 * @param {{provider: string, id?: string, name?: string, args?: string|Object, thoughtSignature?: string|null, calls?: Array<{id: string, name: string, args: string|Object, thoughtSignature?: string|null}>}} arg0
 * @returns {MessageRow}
 */
export function createToolCallMessage({ provider, id, name, args, thoughtSignature, calls }) {
    if (provider === ProviderType.JAI) {
        const msg = /** @type {MessageRow} */ ({ type: 'assistant_message_tool', id, toolName: name, content: args });
        if (thoughtSignature) msg.thought_signature = thoughtSignature;
        return withId({ row: msg });
    }
    if (isStandard({ provider, standard: StandardType.GAI })) {
        const parts = (calls ?? [{ id, name, args, thoughtSignature }]).map((call) => {
            const parsedArgs = typeof call.args === 'string' ? (guardedParse({ input: call.args }).data ?? {}) : (call.args || {});
            const part = /** @type {MessageRow} */ ({ functionCall: { id: call.id, name: call.name, args: parsedArgs } });
            if (call.thoughtSignature) part.thoughtSignature = call.thoughtSignature;
            return part;
        });
        return withId({ row: { role: 'model', parts } });
    }
    const msg = /** @type {MessageRow} */ ({
        role: 'assistant',
        tool_calls: [{
            id,
            type: 'function',
            function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) }
        }]
    });
    if (thoughtSignature) msg.thoughtSignature = thoughtSignature;
    return withId({ row: msg });
}

/**
 * Builds the model-visible failure payload for a failed tool result.
 * `result` carries the shell-tool contract: on failure, `executeTools` returns
 * `{ success:false, error, result: { success:false, error, exitCode, stderr,
 * stdout } }`. The model must see that detail (why the command failed), not a
 * bare "Command exited with code 1" — it cannot fix its command blind.
 * @param {{result: MessageRow}} arg0
 * @private
 * @returns {Record<string, any>}
 */
function toolFailurePayload({ result }) {
    const payload = /** @type {Record<string, any>} */ ({ error: result.error || 'Tool execution failed.' });
    const detail = result.result;
    if (detail && typeof detail === 'object') {
        const fields = /** @type {Record<string, unknown>} */ (detail);
        for (const k of ['exitCode', 'stderr', 'stdout', 'signal', 'raw']) {
            if (fields[k] !== undefined) payload[k] = fields[k];
        }
    }
    return payload;
}

/** @param {{success: *, value: *}} arg0 */
function markAmbiguousSuccess({ success, value }) {
    return success && value && typeof value === 'object' && !Array.isArray(value) && ('error' in value)
        ? { ...value, merci_success: true }
        : value;
}

/** @param {{value: *}} arg0 @returns {Record<string, any>} */
function _gaiResponseObject({ value }) {
    if (value === undefined || value === null) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    return { output: value };
}


/**
 * Backends whose tool-result wire can carry an image block. OpenAI only on the
 * Responses protocol (a chat-completions tool message is text-only); JAI
 * tool messages carry a JSON value, so an image is reported as dropped.
 * @type {Set<string>}
 */
export const IMAGE_TOOL_RESULT_BACKENDS = new Set([
    ProviderType.ANTHROPIC,
    ProviderType.GOOGLE_GENAI,
    ProviderType.VERTEX,
]);

/**
 * Reads an image block in any of the shapes a tool may return: MCP
 * (`{type:'image', data, mimeType}`), Anthropic (`source`), Gemini
 * (`inlineData`) or an OpenAI data URL. A remote URL is not fetched here.
 * @private
 * @param {*} b
 * @returns {{data: string, mimeType: string}|null}
 */
function _imageFromBlock(b) {
    if (!b || typeof b !== 'object') return null;
    if (b.type === 'image') {
        if (typeof b.data === 'string') return { data: b.data, mimeType: b.mimeType || b.mime_type || 'image/png' };
        if (b.source?.type === 'base64' && typeof b.source.data === 'string') return { data: b.source.data, mimeType: b.source.media_type || 'image/png' };
        const inline = b.inlineData || b.inline_data;
        if (inline && typeof inline.data === 'string') return { data: inline.data, mimeType: inline.mimeType || inline.mime_type || 'image/png' };
        return null;
    }
    if (b.type === 'image_url' && typeof b.image_url?.url === 'string') {
        const parsed = parseBase64DataUrl({ url: b.image_url.url });
        return parsed ? { data: parsed.data, mimeType: parsed.mimeType } : null;
    }
    return null;
}

/**
 * Pulls the image blocks out of a tool result value (an array of blocks or an
 * object with a `content` array). Oversized images are dropped and counted.
 * @private
 * @param {{value: any}} arg0
 * @returns {{images: Array<{data: string, mimeType: string}>, dropped: number}}
 */
function _toolImages({ value }) {
    const blocks = Array.isArray(value)
        ? value
        : (Array.isArray(value?.content) ? value.content : (_imageFromBlock(value) ? [value] : []));
    /** @type {Array<{data: string, mimeType: string}>} */
    const images = [];
    let dropped = 0;
    for (const b of blocks) {
        const image = _imageFromBlock(b);
        if (!image) continue;
        if (image.data.length > LIMITS.tool_image_max_chars) { dropped += 1; continue; }
        images.push(image);
    }
    return { images, dropped };
}

/**
 * Removes image blocks from a tool result value so their base64 never reaches a
 * text field. The value is returned untouched when it carries no image.
 * @private
 * @param {{value: any}} arg0
 * @returns {any}
 */
function _stripToolImages({ value }) {
    /** @param {*} b */
    const isImage = (b) => _imageFromBlock(b) !== null;
    if (isImage(value)) return '';
    if (Array.isArray(value)) {
        if (!value.some(isImage)) return value;
        const rest = value.filter((/** @type {*} */ b) => !isImage(b));
        return rest.length ? rest : '';
    }
    if (value && typeof value === 'object' && Array.isArray(value.content) && value.content.some(isImage)) {
        const rest = value.content.filter((/** @type {*} */ b) => !isImage(b));
        const keys = Object.keys(value).filter((k) => k !== 'content');
        return keys.length === 0 ? (rest.length ? rest : '') : { ...value, content: rest };
    }
    return value;
}

/** @private @param {{value: any, note: string}} arg0 @returns {any} */
function _withToolNote({ value, note }) {
    if (!note) return value;
    if (typeof value === 'string') return `${value}${note}`;
    if (Array.isArray(value)) return [...value, { type: 'text', text: note.trim() }];
    if (value && typeof value === 'object') return { ...value, note: note.trim().replace(/^\[|\]$/g, '') };
    return `${String(value ?? '')}${note}`;
}

/**
 * Creates a tool result message in the target backend's wire shape.
 * `result` is the agentic-core `executeTools` result shape:
 *   { id, tool_call_id, name, success: boolean, result?, error? }
 * Per-backend wire mapping:
 *   JAI  : { type: 'tool_message', id, toolName, result: <value>, thought_signature? }
 *   OPENAI     : { role: 'tool', tool_call_id, name, content: <json-string>, thoughtSignature? }
 *   ANTHROPIC  : { role: 'user', content: [{ type: 'tool_result', tool_use_id, content, is_error }] }
 *   GOOGLE_GENAI: { role: 'user', parts: [{ functionResponse: { id, name, response } }] }
 * An image block in `result.result` survives on a backend whose tool-result wire
 * accepts one; elsewhere it is replaced by a note that says it was dropped.
 * @param {{provider: string, result: MessageRow, thoughtSignature?: string|null, protocol?: string|null}} arg0
 * @returns {MessageRow}
 */
export function createToolResultMessage({ provider, result, thoughtSignature = null, protocol = null }) {
    const id = result.id || result.tool_call_id;
    const name = result.name || '';
    const success = result.success !== false;
    const media = success ? _toolImages({ value: result.result }) : { images: [], dropped: 0 };
    const supportsImages = IMAGE_TOOL_RESULT_BACKENDS.has(provider)
        || (standardFor({ provider }) === StandardType.OAI && protocol === 'responses');
    const omitted = supportsImages ? 0 : media.images.length;
    const notes = [];
    if (media.dropped > 0) notes.push(`${media.dropped} image(s) omitted: too large for a tool result.`);
    if (omitted > 0) notes.push(`${omitted} image(s) omitted: the ${provider} tool result cannot carry images.`);
    const value = _withToolNote({
        value: _stripToolImages({ value: success ? result.result : toolFailurePayload({ result }) }),
        note: notes.length ? `\n[${notes.join(' ')}]` : '',
    });

    if (provider === ProviderType.JAI) {
        const marked = markAmbiguousSuccess({ success, value });
        const msg = /** @type {MessageRow} */ ({ type: 'tool_message', id, toolName: name, result: marked });
        if (thoughtSignature) msg.thought_signature = thoughtSignature;
        return withId({ row: msg });
    }

    if (provider === ProviderType.ANTHROPIC) {
        const block = /** @type {MessageRow} */ ({ type: 'tool_result', tool_use_id: id, is_error: !success });
        if (success) {
            const text = typeof value === 'string'
                ? value
                : (media.images.length > 0 ? _stringifyContent({ content: value }) : JSON.stringify(value ?? ''));
            block.content = supportsImages && media.images.length > 0
                ? [
                    ...(text ? [{ type: 'text', text }] : []),
                    ...media.images.map((/** @type {{data: string, mimeType: string}} */ i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })),
                ]
                : (typeof value === 'string' ? value : [{ type: 'text', text }]);
        } else {
            block.content = toolFailurePayload({ result }).error;
            const detail = /** @type {Record<string, unknown>} */ (result.result);
            if (detail && typeof detail === 'object' && typeof detail.stderr === 'string' && detail.stderr) {
                block.content += `\nstderr: ${detail.stderr}`;
            }
        }
        return withId({ row: { role: 'user', content: [block] } });
    }

    if (isStandard({ provider, standard: StandardType.GAI })) {
        const responseValue = success
            ? _gaiResponseObject({ value })
            : toolFailurePayload({ result });
        const functionResponse = /** @type {Record<string, any>} */ ({ id, name, response: responseValue });
        if (supportsImages && media.images.length > 0) {
            functionResponse.parts = media.images.map((/** @type {{data: string, mimeType: string}} */ i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } }));
        }
        return withId({ row: {
            role: 'user',
            parts: [{ functionResponse }]
        } });
    }

    if (standardFor({ provider }) === StandardType.OAI && protocol === 'responses' && media.images.length > 0) {
        const text = typeof value === 'string' ? value : _stringifyContent({ content: value });
        const content = [
            ...(text ? [{ type: 'text', text }] : []),
            ...media.images.map((/** @type {{data: string, mimeType: string}} */ i) => ({ type: 'image_url', image_url: { url: toBase64DataUrl({ mimeType: i.mimeType, data: i.data }) } })),
        ];
        return withId({ row: { role: 'tool', tool_call_id: id, name, content } });
    }

    const marked = markAmbiguousSuccess({ success, value });
    const content = typeof marked === 'string' ? marked : JSON.stringify(marked ?? '');
    const msg = /** @type {MessageRow} */ ({ role: 'tool', tool_call_id: id, name, content });
    if (thoughtSignature) msg.thoughtSignature = thoughtSignature;
    return withId({ row: msg });
}

/**
 * Backends whose wire can carry an `application/pdf` document as one inline
 * media message: JAI (vendor media part), Gemini/Vertex (`inlineData`),
 * Anthropic (`document` block), OpenAI (`file` part). Other backends
 * (local/OpenRouter/opencode) pass through to arbitrary providers that may
 * reject the part, so a PDF is refused there.
 * @type {Set<string>}
 */
export const PDF_MEDIA_PROVIDERS = new Set(Object.values(PROVIDERS).filter((d) => d.capabilities.pdfMedia).map((d) => d.id));

/**
 * Normalizes a mixed-shape history to the backend's wire format: the JAI
 * shape for JAI, otherwise the OAI normalizer. Injection markers are
 * always stripped first. For JAI responses sessions, same-protocol native
 * reasoning items are replayed as `reasoning_message` rows.
 * @param {{provider: string, messages: Array<MessageRow>, options?: JaiNormalizeOptions}} arg0
 * @returns {Array<MessageRow>}
 */
export function normalizeHistory({ provider, messages, options = {} }) {
    if (provider === ProviderType.JAI) {
        // F7: the dedupe runs while the rows still carry their identity — the
        // strip below is the boundary where it leaves. Normalizing is therefore
        // replay-safe on its own, whatever order the caller uses.
        return _normalizeToJAI({ messages: stripInjectionMeta({ messages: dedupeMessages({ messages }), keepNative: true }), ...options });
    }
    return normalizeToOAI({ model: undefined, msgs: messages });
}

/**
 * @param {{messages: Array<MessageRow>, protocol?: string}} arg0
 * @returns {Array<MessageRow>}
 */
function _normalizeToJAI({ messages, protocol }) {
    /** @type {Array<MessageRow>} */
    const normalized = [];
    const replayResponses = protocol === ProtocolType.RESPONSES;
    for (const m of messages) {
        if (replayResponses) {
            const replay = _jaiReasoningReplay({ row: m });
            if (replay.length > 0) normalized.push(...replay);
        }
        if (isEmptyAssistantTurn({ m })) continue;
        if (m.role === 'model' && Array.isArray(m.parts)) {
            for (const p of m.parts) {
                if (!p || typeof p !== 'object') continue;
                if (p.thought === true) continue;
                const sig = p.thoughtSignature || p.thought_signature || m.thoughtSignature || m.thought_signature;
                if (typeof p.text === 'string' && p.text.trim()) {
                    normalized.push({
                        type: 'assistant_message_text',
                        content: p.text,
                        ...(sig ? { thought_signature: sig } : {})
                    });
                } else if (p.functionCall) {
                    normalized.push({
                        type: 'assistant_message_tool',
                        id: p.functionCall.id,
                        toolName: p.functionCall.name || '',
                        content: typeof p.functionCall.args === 'string'
                            ? p.functionCall.args
                            : JSON.stringify(p.functionCall.args ?? {}),
                        ...(sig ? { thought_signature: sig } : {})
                    });
                }
            }
            continue;
        }
        if (m.role === 'user' && Array.isArray(m.parts)) {
            const contentParts = [];
            for (const p of m.parts) {
                if (!p || typeof p !== 'object') continue;
                if (p.functionResponse) {
                    const fr = p.functionResponse;
                    normalized.push({
                        type: 'tool_message',
                        id: fr.id,
                        toolName: fr.name || '',
                        result: typeof fr.response === 'string'
                            ? fr.response
                            : JSON.stringify(fr.response ?? fr.output ?? {})
                    });
                } else {
                    contentParts.push(p);
                }
            }
            if (contentParts.length > 0) normalized.push({ type: 'user_message', content: contentParts });
            continue;
        }
        if (m.role === 'user') {
            if (Array.isArray(m.content) && m.content.some((/** @type {any} */ b) => b && typeof b === 'object' && b.type === 'tool_result')) {
                const restBlocks = [];
                for (const b of m.content) {
                    if (b && typeof b === 'object' && b.type === 'tool_result') {
                        const rawRes = b.content;
                        normalized.push({
                            type: 'tool_message',
                            id: b.tool_use_id || b.id,
                            toolName: b.name || '',
                            result: b.is_error ? { error: typeof rawRes === 'string' ? rawRes : JSON.stringify(rawRes) } : rawRes
                        });
                    } else {
                        restBlocks.push(b);
                    }
                }
                if (restBlocks.length > 0) normalized.push({ type: 'user_message', content: restBlocks });
            } else {
                normalized.push({ type: 'user_message', content: m.content });
            }
            continue;
        }
        if (m.role === 'system' || m.role === 'developer' || m.type === 'system_message' || m.type === 'developer_message') {
            const content = Array.isArray(m.parts)
                ? m.parts.map((/** @type {any} */ p) => (typeof p === 'string' ? p : (p?.text || ''))).filter(Boolean).join('\n\n')
                : Array.isArray(m.content)
                    ? m.content.map((/** @type {any} */ b) => (typeof b === 'string' ? b : (b?.text || ''))).filter(Boolean).join('\n\n')
                    : m.content;
            const sysRow = /** @type {MessageRow} */ ({ ...m, type: 'system_message', content });
            delete sysRow.role;
            delete sysRow.parts;
            if (sysRow.thoughtSignature && !sysRow.thought_signature) sysRow.thought_signature = sysRow.thoughtSignature;
            delete sysRow.thoughtSignature;
            delete /** @type {Record<string, unknown>} */ (sysRow)[MERCI_NATIVE_KEY];
            normalized.push(sysRow);
            continue;
        }
        if (m.role === 'assistant') {
            const text = Array.isArray(m.content)
                ? m.content.filter((/** @type {any} */ b) => b && typeof b === 'object' && typeof b.text === 'string').map((/** @type {any} */ b) => b.text).join('')
                : m.content;
            if (text) {
                normalized.push({
                    type: 'assistant_message_text',
                    content: text,
                    thought_signature: m.thoughtSignature || m.thought_signature
                });
            }
            if (Array.isArray(m.content)) {
                for (const b of m.content) {
                    if (b && typeof b === 'object' && b.type === 'tool_use') {
                        const sig = b.thoughtSignature || b.thought_signature || m.thoughtSignature || m.thought_signature;
                        normalized.push({
                            type: 'assistant_message_tool',
                            id: b.id,
                            toolName: b.name || '',
                            content: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
                            ...(sig ? { thought_signature: sig } : {})
                        });
                    }
                }
            }
            if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                for (const tc of m.tool_calls) {
                    normalized.push({
                        type: 'assistant_message_tool',
                        id: tc.id,
                        toolName: tc.function?.name || tc.name,
                        content: _stringifyContent({ content: tc.function?.['arguments'] ?? tc['arguments'] ?? '{}' }),
                        thought_signature: m.thoughtSignature || m.thought_signature
                    });
                }
            }
            continue;
        }
        if (m.role === 'tool') {
            normalized.push({
                type: 'tool_message',
                id: m.tool_call_id || m.id,
                toolName: m.toolName || m.name || '',
                result: m.content,
                thought_signature: m.thoughtSignature || m.thought_signature
            });
            continue;
        }
        if (m.type) {
            const clone = { ...m };
            if (clone.thoughtSignature && !clone.thought_signature) clone.thought_signature = clone.thoughtSignature;
            delete clone.thoughtSignature;
            delete /** @type {Record<string, unknown>} */ (clone)[MERCI_NATIVE_KEY];
            normalized.push(clone);
            continue;
        }
        normalized.push(m);
    }
    return normalized;
}

/**
 * Builds the replay rows for a same-protocol JAI responses reasoning sidecar.
 * The request-side shape is `reasoning_message` with snake_case
 * `encrypted_content` (probed live: `role`/extra fields 400 the request, a
 * camelCase `encryptedContent` is silently dropped, a missing `id` 400s) —
 * emit a strict allowlist from the captured item, never the raw object.
 * @param {{row: MessageRow}} arg0
 * @returns {Array<MessageRow>}
 */
function _jaiReasoningReplay({ row }) {
    const native = getNative({ row });
    if (!native || native.provider !== ProviderType.JAI || native.protocol !== 'responses') return [];
    const out = [];
    for (const item of native.items) {
        if (!item || typeof item !== 'object' || item.type !== 'reasoning_message') continue;
        if (typeof item.id !== 'string' || !item.id) continue;
        /** @type {MessageRow} */
        const replay = { type: 'reasoning_message', id: item.id };
        if (typeof item.encrypted_content === 'string' && item.encrypted_content) {
            replay.encrypted_content = item.encrypted_content;
        }
        if (Array.isArray(item.summary) && item.summary.length > 0) {
            const summary = item.summary
                .filter((/** @type {any} */ s) => s && typeof s === 'object')
                .map((/** @type {any} */ s) => ({
                    ...(typeof s.type === 'string' ? { type: s.type } : {}),
                    ...(typeof s.text === 'string' ? { text: s.text } : {})
                }))
                .filter((/** @type {any} */ s) => Object.keys(s).length > 0);
            if (summary.length > 0) replay.summary = summary;
        }
        if (typeof item.status === 'string' && item.status) replay.status = item.status;
        out.push(replay);
    }
    return out;
}

/**
 * Reads the tool name from a tool call in any shape (OAI/JAI/GAI).
 * @param {{call: MessageRow}} arg0
 * @returns {string|undefined}
 */
export function getToolCallName({ call }) {
    return call.name || (call.function && call.function.name);
}

// Intentional divergence (A1): the backend adapters keep their own
// `formatToolCall` args fallback — per-vendor `function.arguments` / `args` /
// `input` priority differs from this reader, so routing them here would change
// output (results/03-adapter-dedup.md). Planner/tool-call consumers still use this.
/**
 * Reads the tool arguments from a tool call in any shape (OAI/JAI/GAI).
 * @param {{call: MessageRow}} arg0
 * @returns {unknown}
 */
export function getToolCallArguments({ call }) {
    return call.arguments || call.args || call.input || (call.function && call.function.arguments);
}

/** @param {{clean: *}} arg0 */
function isFailedToolResult({ clean }) {
    if (clean.success === false) return true;
    if (clean.success === true) return false;
    const raw = clean.result ?? clean.content;
    const parsed = typeof raw === 'string' ? guardedParse({ input: raw }).data : raw;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.merci_success === true) return false;
    return !!(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ('error' in parsed));
}

/**
 * Coerces a content block's text into a string for tool_result payloads.
 * @private
  * @param {{content: *}} arg0
 */
function _stringifyContent({ content }) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(b => {
            if (typeof b === 'string') return b;
            if (b && typeof b === 'object') {
                if (b.type === 'text') return b.text || '';
                return JSON.stringify(b);
            }
            return String(b);
        }).join('');
    }
    if (content && typeof content === 'object') return JSON.stringify(content);
    return String(content ?? '');
}

/**
 * Maps an OAI-shaped media content block to its Anthropic equivalent:
 * `image_url` → `image` (data URL → base64 source, remote URL → url source)
 * and `file` → `document` (data URL → base64 source). Other blocks pass through.
 * @private
 * @param {*} b
 */
function _mediaBlockToAai(/** @type {MessageRow} */ b) {
    if (!b || typeof b !== 'object') return b;
    const inline = b.inlineData || b.inline_data;
    if (inline && typeof inline.data === 'string') {
        return { type: 'image', source: { type: 'base64', media_type: inline.mimeType || inline.mime_type || 'image/png', data: inline.data } };
    }
    if (b.type === 'image_url' && typeof b.image_url?.url === 'string') {
        const dm = parseBase64DataUrl({ url: b.image_url.url });
        if (dm) return { type: 'image', source: { type: 'base64', media_type: dm.mimeType, data: dm.data } };
        return { type: 'image', source: { type: 'url', url: b.image_url.url } };
    }
    if (b.type === 'file') {
        const dm = typeof b.file?.file_data === 'string'
            ? parseBase64DataUrl({ url: b.file.file_data })
            : null;
        return dm ? { type: 'document', source: { type: 'base64', media_type: dm.mimeType, data: dm.data } } : null;
    }
    return b;
}

/**
 * Centralized normalization of JAI/OAI/GAI-style messages to Anthropic format.
 * `system` is a string when the input carries one plain system text, and an
 * array of `{type:'text', text, cache_control?}` blocks when a row was
 * structured (SP6: a cacheable role template plus a per-spawn adaptation).
 * @param {{msgs?: Array<MessageRow>}} arg0
 * @returns {{messages: Array<MessageRow>, system: string|Array<{type: 'text', text: string, cache_control?: CacheControl}>|null}}
 */
export function normalizeToAAI({ msgs = [] } = {}) {
    // F7: dedupe before the identity is stripped (see normalizeHistory).
    msgs = stripInjectionMeta({ messages: dedupeMessages({ messages: msgs }), keepNative: true });
    /** @type {Array<MessageRow>} */
    const out = [];
    // SP6: a system row may carry BLOCKS (a cacheable role template + a
    // per-spawn adaptation). Blocks must survive as blocks — merging them into
    // one string is what made a per-block `cache_control` impossible.
    /** @type {Array<Record<string, any>>} */
    const systemBlocks = [];
    let systemPlain = '';
    const flushSystemPlain = () => {
        if (!systemPlain) return;
        systemBlocks.push({ type: 'text', text: systemPlain });
        systemPlain = '';
    };
    let system = null;

    for (const m of msgs) {
        if (!m || typeof m !== 'object') continue;
        if (isEmptyAssistantTurn({ m })) continue;
        const { thoughtSignature, thought_signature, redactedThinking, ...clean } = m;
        const effectiveSig = thoughtSignature || thought_signature;
        const redactedBlocks = Array.isArray(redactedThinking)
            ? redactedThinking.map((/** @type {string} */ data) => ({ type: 'redacted_thinking', data }))
            : [];
        const native = getNative({ row: m });
        const nativeBlocks = native && native.provider === ProviderType.ANTHROPIC
            && (native.protocol == null || native.protocol === ProtocolType.MESSAGES)
            ? native.items.filter((/** @type {any} */ b) => b?.type === 'thinking' || b?.type === 'redacted_thinking')
            : [];
        const hasNativeThinking = nativeBlocks.some((/** @type {any} */ b) => b?.type === 'thinking' || b?.type === 'redacted_thinking');
        const leadBlocks = nativeBlocks.length > 0 ? nativeBlocks : redactedBlocks;

        if (clean.role === 'system' || clean.role === 'developer' || clean.type === 'system_message' || clean.type === 'developer_message') {
            // A structured row (objects, not plain strings) keeps its block
            // boundaries and its `cache_control`; everything else accumulates as
            // plain text, exactly as before.
            const structured = Array.isArray(clean.content)
                && clean.content.some((/** @type {any} */ b) => b && typeof b === 'object' && !Array.isArray(b));
            if (structured) {
                flushSystemPlain();
                const systemContent = /** @type {Array<MessageRow>} */ (clean.content);
                for (const b of systemContent) {
                    if (typeof b === 'string') {
                        systemPlain = joinSystemParts({ acc: systemPlain, part: b });
                        continue;
                    }
                    if (!b || typeof b !== 'object') continue;
                    const text = typeof b?.text === 'string' ? b.text : '';
                    if (!text) continue;
                    systemBlocks.push({
                        type: 'text',
                        text,
                        ...(b.cache_control ? { cache_control: b.cache_control } : {}),
                    });
                }
                continue;
            }
            const text = typeof clean.content === 'string'
                ? clean.content
                : Array.isArray(clean.content)
                    ? clean.content.map(b => (typeof b === 'string' ? b : (b?.text || ''))).join('')
                    : Array.isArray(clean.parts)
                        ? clean.parts.map((/** @type {any} */ p) => (typeof p === 'string' ? p : (p?.text || ''))).filter(Boolean).join('\n\n')
                        : '';
            systemPlain = joinSystemParts({ acc: systemPlain, part: text });
            continue;
        }

        if (clean.role === 'model' && Array.isArray(clean.parts)) {
            const blocks = [];
            for (const p of clean.parts) {
                if (!p || typeof p !== 'object') continue;
                if (p.thought === true) continue;
                if (typeof p.text === 'string' && p.text.trim()) blocks.push({ type: 'text', text: p.text });
                else if (p.functionCall) {
                    blocks.push({
                        type: 'tool_use',
                        id: p.functionCall.id,
                        name: p.functionCall.name || '',
                        input: guardedParse({ input: p.functionCall.args ?? p.functionCall.arguments ?? {} }).data ?? {}
                    });
                }
            }
            if (effectiveSig && !hasNativeThinking) blocks.unshift({ type: 'thinking', thinking: '', signature: effectiveSig });
            if (blocks.length) out.push({ role: 'assistant', content: [...leadBlocks, ...blocks] });
            continue;
        }

        if (clean.role === 'user' && Array.isArray(clean.parts)) {
            const blocks = [];
            for (const p of clean.parts) {
                if (!p || typeof p !== 'object') continue;
                if (typeof p.text === 'string') blocks.push({ type: 'text', text: p.text });
                else if (p.functionResponse) {
                    blocks.push({
                        type: 'tool_result',
                        tool_use_id: p.functionResponse.id,
                        is_error: p.functionResponse.is_error === true,
                        content: _stringifyContent({ content: p.functionResponse.response ?? p.functionResponse.output ?? '' })
                    });
                } else {
                    const media = _mediaBlockToAai(p);
                    if (media) blocks.push(media);
                }
            }
            if (blocks.length) out.push({ role: 'user', content: blocks });
            continue;
        }

        if (clean.role === 'user') {
            if (typeof clean.content === 'string') {
                out.push({ role: 'user', content: [{ type: 'text', text: clean.content }] });
            } else if (Array.isArray(clean.content)) {
                out.push({ role: 'user', content: /** @type {Array<MessageRow>} */ (clean.content.map(_mediaBlockToAai).filter(Boolean)) });
            } else {
                out.push({ role: 'user', content: [{ type: 'text', text: String(clean.content ?? '') }] });
            }
            continue;
        }

        if (clean.role === 'assistant') {
            if (Array.isArray(clean.content)) {
                const blocks = /** @type {Array<MessageRow>} */ (clean.content.map(_mediaBlockToAai).filter(Boolean));
                if (Array.isArray(clean.tool_calls) && clean.tool_calls.length > 0) {
                    for (const tc of clean.tool_calls) {
                        blocks.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.function?.name || tc.name || '',
                            input: guardedParse({ input: tc.function?.arguments || tc.input || {} }).data ?? {}
                        });
                    }
                }
                if (effectiveSig && !hasNativeThinking && !blocks.some(b => b?.type === 'thinking')) {
                    blocks.unshift({ type: 'thinking', thinking: '', signature: effectiveSig });
                }
                out.push({ role: 'assistant', content: [...leadBlocks, ...blocks] });
            } else if (Array.isArray(clean.tool_calls)) {
                const blocks = clean.tool_calls.map(tc => /** @type {MessageRow} */ ({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function?.name || tc.name || '',
                    input: guardedParse({ input: tc.function?.arguments || tc.input || {} }).data ?? {}
                }));
                if (typeof clean.content === 'string' && clean.content.trim()) {
                    blocks.unshift({ type: 'text', text: clean.content });
                }
                if (effectiveSig && !hasNativeThinking) blocks.unshift({ type: 'thinking', thinking: '', signature: effectiveSig });
                out.push({ role: 'assistant', content: [...leadBlocks, ...blocks] });
            } else if (typeof clean.content === 'string') {
                const blocks = /** @type {Array<MessageRow>} */ ([]);
                if (effectiveSig && !hasNativeThinking) blocks.push({ type: 'thinking', thinking: '', signature: effectiveSig });
                blocks.push({ type: 'text', text: clean.content });
                out.push({ role: 'assistant', content: [...leadBlocks, ...blocks] });
            }
            continue;
        }

        if (clean.role === 'tool') {
            const toolCallId = clean.tool_call_id || clean.id || '';
            if (!toolCallId) {
                out.push({ role: 'user', content: [{ type: 'text', text: '[tool result with missing id preserved]' }] });
                continue;
            }
            out.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: toolCallId,
                    is_error: isFailedToolResult({ clean }),
                    content: _stringifyContent({ content: clean.content ?? '' })
                }]
            });
            continue;
        }

        if (clean.type === 'user_message') {
            out.push({
                role: 'user',
                content: Array.isArray(clean.content)
                    ? /** @type {Array<MessageRow>} */ (clean.content.map(_mediaBlockToAai).filter(Boolean))
                    : [{ type: 'text', text: clean.content || '' }]
            });
            continue;
        }

        if (clean.type === 'assistant_message_text' || clean.type === 'assistant_message') {
            if (Array.isArray(clean.content)) {
                const blocks = /** @type {Array<MessageRow>} */ (clean.content.map(_mediaBlockToAai).filter(Boolean));
                if (effectiveSig && !hasNativeThinking && !blocks.some(b => b?.type === 'thinking')) {
                    blocks.unshift({ type: 'thinking', thinking: '', signature: effectiveSig });
                }
                out.push({ role: 'assistant', content: [...leadBlocks, ...blocks] });
            } else {
                const blocks = /** @type {Array<MessageRow>} */ ([]);
                if (effectiveSig && !hasNativeThinking) blocks.push({ type: 'thinking', thinking: '', signature: effectiveSig });
                blocks.push({ type: 'text', text: clean.content || '' });
                out.push({ role: 'assistant', content: [...leadBlocks, ...blocks] });
            }
            continue;
        }

        if (clean.type === 'assistant_message_tool' || clean.type === 'assistant_tool_call') {
            const blocks = /** @type {Array<MessageRow>} */ ([{
                type: 'tool_use',
                id: clean.id,
                name: clean.toolName || clean.name || '',
                input: guardedParse({ input: clean.content || clean.arguments || {} }).data ?? {}
            }]);
            if (effectiveSig && !hasNativeThinking) blocks.unshift({ type: 'thinking', thinking: '', signature: effectiveSig });
            out.push({ role: 'assistant', content: [...leadBlocks, ...blocks] });
            continue;
        }

        if (clean.type === 'tool_message' || clean.type === 'tool_result_message') {
            out.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: clean.tool_call_id || clean.id,
                    is_error: isFailedToolResult({ clean }),
                    content: _stringifyContent({ content: clean.result ?? clean.content ?? '' })
                }]
            });
            continue;
        }
    }

    const merged = /** @type {Array<MessageRow>} */ ([]);
    for (const m of out) {
        const prev = merged[merged.length - 1];
        const hasToolBlocks = (/** @type {Array<MessageRow>} */ (m.content) || []).some(b => b.type === 'tool_use' || b.type === 'tool_result');
        if (prev && prev.role === m.role && !hasToolBlocks
            && !(/** @type {Array<MessageRow>} */ (prev.content) || []).some(b => b.type === 'tool_use' || b.type === 'tool_result')) {
            prev.content = /** @type {Array<MessageRow>} */ (prev.content)
                .concat(/** @type {Array<MessageRow>} */ (m.content));
        } else {
            merged.push({ role: m.role, content: [.../** @type {Array<MessageRow>} */ (m.content)] });
        }
    }

    flushSystemPlain();
    if (systemBlocks.length === 1 && !systemBlocks[0].cache_control) {
        system = systemBlocks[0].text;
    } else if (systemBlocks.length > 0) {
        system = systemBlocks;
    }
    return { messages: merged, system };
}

/**
 * Converts a GAI-shaped row (role + parts) to the OpenAI wire.
 * Without this, `normalizeToOAI` pushed `{ role:'model', parts:[...] }` and
 * `{ role:'user', parts:[...] }` through verbatim — guaranteed 400 on OpenAI.
 * @private
  * @param {{m: *}} arg0
 */
function oaiFromGaiParts({ m }) {
    const texts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const p of m.parts || []) {
        if (!p || typeof p !== 'object') continue;
        if (p.thought === true) continue;
        if (typeof p.text === 'string') texts.push(p.text);
        else if (p.functionCall) {
            toolCalls.push({
                id: p.functionCall.id,
                type: 'function',
                function: {
                    name: p.functionCall.name || '',
                    arguments: typeof p.functionCall.args === 'string'
                        ? p.functionCall.args
                        : JSON.stringify(p.functionCall.args ?? {})
                }
            });
        } else if (p.functionResponse) {
            toolResults.push(p.functionResponse);
        }
    }
    if (toolResults.length > 0) {
        /** @type {Array<MessageRow>} */
        const rows = toolResults.map((fr) => ({
            role: 'tool',
            tool_call_id: fr.id,
            name: fr.name || '',
            content: typeof fr.response === 'string'
                ? fr.response
                : JSON.stringify(fr.response ?? fr.output ?? {})
        }));
        const text = texts.join('');
        if (text) rows.push({ role: 'user', content: text });
        return rows.length === 1 ? rows[0] : rows;
    }
    const row = /** @type {MessageRow} */ ({ role: m.role === 'model' ? 'assistant' : m.role, content: texts.join('') || '' });
    if (toolCalls.length) row.tool_calls = toolCalls;
    return row;
}

/**
 * Maps an AAI media block to its OpenAI chat-completions equivalent:
 * `document` (base64 source) → `file` part, `image` (base64 source) →
 * `image_url` data URL. Returns null for anything else. @private
 * @param {*} b
 */
function _aaiMediaToOai(/** @type {MessageRow} */ b) {
    if (!b || typeof b !== 'object') return null;
    if (b.type === 'image' && b.source?.type === 'url' && typeof b.source.url === 'string') {
        return { type: 'image_url', image_url: { url: b.source.url } };
    }
    if (b.source?.type !== 'base64' || typeof b.source.data !== 'string') return null;
    if (b.type === 'document') {
        return {
            type: 'file',
            file: {
                filename: b.filename || 'document.pdf',
                file_data: toBase64DataUrl({ mimeType: b.source.media_type || 'application/pdf', data: b.source.data })
            }
        };
    }
    if (b.type === 'image') {
        return { type: 'image_url', image_url: { url: toBase64DataUrl({ mimeType: b.source.media_type || 'image/png', data: b.source.data }) } };
    }
    return null;
}

/**
 * Converts an AAI-shaped row (role + content blocks) to OpenAI wire rows.
 * tool_use blocks become assistant tool_calls; tool_result blocks become
 * `role:'tool'` rows (one per block — OpenAI wants one tool message each).
 * @private
  * @param {{m: *}} arg0
 */
function oaiFromAaiBlocks({ m }) {
    const blocks = /** @type {Array<MessageRow>} */ (m.content);
    if (m.role === 'assistant') {
        const toolCalls = blocks.filter(b => b?.type === 'tool_use').map(b => ({
            id: b.id,
            type: 'function',
            function: { name: b.name || '', arguments: JSON.stringify(b.input ?? {}) }
        }));
        const text = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
        if (toolCalls.length === 0 && !text) return null;
        const row = /** @type {MessageRow} */ ({ role: 'assistant', tool_calls: toolCalls });
        if (text) row.content = text;
        return row;
    }
    if (m.role === 'user') {
        const results = blocks.filter(b => b?.type === 'tool_result');
        const text = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
        if (results.length > 0) {
            /** @type {Array<MessageRow>} */
            const rows = results.map(b => ({
                role: 'tool',
                tool_call_id: b.tool_use_id,
                name: b.name || '',
                content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
            }));
            if (text) rows.push({ role: 'user', content: text });
            return rows.length === 1 ? rows[0] : rows;
        }
        const media = blocks.map(_aaiMediaToOai).filter(Boolean);
        if (media.length === 0) return { role: 'user', content: text || '' };
        const content = [];
        if (text) content.push({ type: 'text', text });
        content.push(...media);
        return { role: 'user', content };
    }
    return m;
}

/**
 * Centralized normalization of JAI-style messages to OpenAI shape.
 * After the per-message map pass, consecutive system/developer messages are
 * collapsed into a single message with SYSTEM_MESSAGE_MERGE_SEPARATOR between
 * contents. This mirrors the natural merging done by normalizeToAAI and
 * normalizeToGAI (which both extract the system into a top-level field via
 * concatenation). OAI keeps the system message inline in the messages array,
 * so the collapse happens here. The result: the wire payload never has two
 * consecutive system/developer messages, eliminating the duplicate-system-
 * message quirk in OAI sessions.
 * @param {{model?: string, msgs?: Array<MessageRow>, opts?: OaiNormalizeOptions}} arg0
 * @returns {Array<MessageRow>}
 */
export function normalizeToOAI({ model, msgs = [], opts = {} }) {
    // F7: dedupe before the identity is stripped (see normalizeHistory).
    msgs = stripInjectionMeta({ messages: dedupeMessages({ messages: msgs }), ...opts });
    const isOseries = isOSeries({ model: model ?? '' });
    const systemRole = isOseries ? 'developer' : 'system';

    const normalized = [];
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m || typeof m !== 'object') { normalized.push(m); continue; }
        if (isEmptyAssistantTurn({ m })) continue;
        const { thoughtSignature: _thoughtSignature, thought_signature: _thought_signature, redactedThinking: _redactedThinking, ...cleanMsg } = m;

        if (cleanMsg.role) {
            if (cleanMsg.role === 'system' || cleanMsg.role === 'developer') {
                const targetRole = cleanMsg.role === 'developer' ? 'developer' : systemRole;
                if (Array.isArray(cleanMsg.parts)) {
                    const text = cleanMsg.parts.filter((/** @type {any} */ p) => typeof p?.text === 'string').map((/** @type {any} */ p) => p.text).join('');
                    normalized.push({ role: targetRole, content: text });
                } else if (Array.isArray(cleanMsg.content)) {
                    normalized.push({ ...cleanMsg, role: targetRole, content: _stringifyContent({ content: cleanMsg.content }) });
                } else {
                    normalized.push({ ...cleanMsg, role: targetRole });
                }
                continue;
            }
            if (cleanMsg.role === 'assistant' && Array.isArray(cleanMsg.tool_calls) && cleanMsg.tool_calls.length > 0) {
                i = normalizeOaiToolCallRows({ msgs, i, normalized });
            } else if (cleanMsg.role && Array.isArray(cleanMsg.parts)) {
                const wired = oaiFromGaiParts({ m: cleanMsg });
                if (Array.isArray(wired)) normalized.push(...wired);
                else normalized.push(wired);
            } else if (Array.isArray(cleanMsg.content)
                && cleanMsg.content.some(b => b && typeof b === 'object'
                    && (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking'
                        || (cleanMsg.role === 'user' && (b.type === 'image' || b.type === 'document'))))) {
                const wired = oaiFromAaiBlocks({ m: cleanMsg });
                if (Array.isArray(wired)) normalized.push(...wired);
                else if (wired) normalized.push(wired);
            } else {
                normalized.push(cleanMsg);
            }
            continue;
        }

        if (m.type === 'user_message') { normalized.push({ role: 'user', content: m.content }); continue; }
        if (m.type === 'system_message') { normalized.push({ role: systemRole, content: m.content }); continue; }
        if (m.type === 'developer_message') { normalized.push({ role: 'developer', content: m.content }); continue; }
        if (m.type === 'assistant_message' || m.type === 'assistant_message_text') {
            const row = /** @type {MessageRow} */ ({ role: 'assistant', content: m.content });
            if (m.reasoning_content) row.reasoning_content = m.reasoning_content;
            normalized.push(row);
            continue;
        }

        if (m.type === 'assistant_tool_call' || m.type === 'assistant_message_tool') {
            i = normalizeOaiToolCallRows({ msgs, i, normalized });
            continue;
        }

        if (m.type === 'tool_result_message' || m.type === 'tool_message') {
            const raw = m.content ?? m.result;
            normalized.push({
                role: 'tool',
                tool_call_id: m.tool_call_id || m.id,
                name: m.toolName || m.name || '',
                content: typeof raw === 'string' ? raw : JSON.stringify(raw)
            });
            continue;
        }

        normalized.push(cleanMsg);
    }

    return _collapseConsecutiveSystemMessages({ msgs: normalized });
}

/** @param {{msgs: *, i: *, normalized: *}} arg0 */
function normalizeOaiToolCallRows({ msgs, i, normalized }) {
    const m = msgs[i];
    const calls = /** @type {Array<MessageRow>} */ (m.tool_calls || [{ id: m.id, name: m.toolName, arguments: m.content }]);
    let content = '';
    /** @type {Array<any>} */
    const nativeItems = [];
    /** @type {{provider: string, protocol: string|null}|null} */
    let nativeMeta = null;
    /** @param {{src: *}} arg0 */
    /** @param {{src: *}} arg0 */
    const collectNative = ({ src }) => {
        const n = getNative({ row: src });
        if (n) {
            nativeMeta = nativeMeta ?? { provider: n.provider, protocol: n.protocol };
            nativeItems.push(...n.items);
        }
    };
    collectNative({ src: m });
    if (m.role === 'assistant' && typeof m.content === 'string') content = m.content;
    let reasoningContent = m.reasoning_content ?? '';
    while (i + 1 < msgs.length && isOaiToolCallRow({ x: msgs[i + 1] })) {
        const next = msgs[++i];
        collectNative({ src: next });
        calls.push(...(next.tool_calls || [{ id: next.id, name: next.toolName, arguments: next.content }]));
        if (next.role === 'assistant' && typeof next.content === 'string' && next.content) {
            content = content ? content + '\n' + next.content : next.content;
        }
        if (next.reasoning_content) reasoningContent = reasoningContent ? reasoningContent + '\n' + next.reasoning_content : next.reasoning_content;
    }
    const row = /** @type {MessageRow} */ ({
        role: 'assistant',
        tool_calls: calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
                name: tc.name || tc.function?.name || '',
                arguments: typeof (tc.arguments ?? tc.function?.arguments) === 'string'
                    ? (tc.arguments ?? tc.function?.arguments)
                    : JSON.stringify(tc.arguments ?? tc.function?.arguments ?? {})
            }
        }))
    });
    if (content) row.content = content;
    if (reasoningContent) row.reasoning_content = reasoningContent;
    const meta = /** @type {{provider: string, protocol: string|null}|null} */ (nativeMeta);
    if (meta && nativeItems.length > 0) attachNative({ row, provider: meta.provider, protocol: meta.protocol, items: nativeItems });
    normalized.push(row);
    return i;
}

/** @param {{x: *}} arg0 */
function isOaiToolCallRow({ x }) {
    return x && typeof x === 'object'
        && (x.type === 'assistant_tool_call' || x.type === 'assistant_message_tool'
            || (x.role === 'assistant' && Array.isArray(x.tool_calls) && x.tool_calls.length > 0));
}

/**
 * Collapse consecutive role:system / role:developer messages into a single
 * message with SYSTEM_MESSAGE_MERGE_SEPARATOR between contents. The first
 * message's role wins. Non-system messages flush any pending merged system
 * message into the output and are pushed as-is. Other roles (user, assistant,
 * tool) are not merged — only system-ish roles are.
  * @param {{msgs: *}} arg0
 */
function _collapseConsecutiveSystemMessages({ msgs }) {
    const merged = [];
    let systemMsg = null;
    for (const m of msgs) {
        if (m && (m.role === 'system' || m.role === 'developer')) {
            if (systemMsg === null) {
                systemMsg = { ...m, ...(Array.isArray(m.content) ? { content: _stringifyContent({ content: m.content }) } : {}) };
            } else {
                const a = _stringifyContent({ content: systemMsg.content });
                const b = _stringifyContent({ content: m.content });
                systemMsg.content = a + SYSTEM_MESSAGE_MERGE_SEPARATOR + b;
            }
        } else {
            if (systemMsg !== null) {
                merged.push(systemMsg);
                systemMsg = null;
            }
            merged.push(m);
        }
    }
    if (systemMsg !== null) merged.push(systemMsg);
    return merged;
}

/**
 * Maps OAI/AAI-shaped assistant content blocks to Gemini parts.
 * @param {{blocks: Array<MessageRow>, sig: string|null, toolNamesById: Map<string, string>}} arg0
 * @returns {Array<Record<string, any>>}
 */
function _gaiModelPartsFromBlocks({ blocks, sig, toolNamesById }) {
    const parts = [];
    for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use') {
            const name = b.name || '';
            if (b.id) toolNamesById.set(b.id, name);
            const part = /** @type {MessageRow} */ ({
                functionCall: {
                    id: b.id,
                    name,
                    args: b.input && typeof b.input === 'object'
                        ? b.input
                        : guardedParse({ input: b.input ?? b.input_arguments ?? '{}' }).data ?? {}
                }
            });
            const partSig = b.thoughtSignature ?? sig; if (partSig) part.thoughtSignature = partSig;
            parts.push(part);
        } else if (b.type === 'text' && typeof b.text === 'string') {
            parts.push({ text: b.text });
        } else if (b.type === 'image_url' && typeof b.image_url?.url === 'string') {
            const m = parseBase64DataUrl({ url: b.image_url.url });
            if (m) parts.push({ inlineData: { mimeType: m.mimeType, data: m.data } });
        }
    }
    return parts;
}

/**
 * Maps OAI/AAI-shaped user content blocks to Gemini parts.
 * @param {{blocks: Array<MessageRow>, toolNamesById: Map<string, string>}} arg0
 * @returns {Array<Record<string, any>>}
 */
function _gaiUserPartsFromBlocks({ blocks, toolNamesById }) {
    const parts = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push({ text: block.text });
        } else if (block.type === 'image_url' && typeof block.image_url?.url === 'string') {
            const m = parseBase64DataUrl({ url: block.image_url.url });
            if (m) parts.push({ inlineData: { mimeType: m.mimeType, data: m.data } });
            else parts.push({ text: '[remote image omitted, turn preserved]' });
        } else if (block.type === 'file' && typeof block.file?.file_data === 'string') {
            const m = parseBase64DataUrl({ url: block.file.file_data });
            if (m) parts.push({ inlineData: { mimeType: m.mimeType, data: m.data } });
        } else if ((block.type === 'image' || block.type === 'document')
            && block.source?.type === 'base64' && typeof block.source.data === 'string') {
            parts.push({
                inlineData: {
                    mimeType: block.source.media_type || (block.type === 'document' ? 'application/pdf' : 'image/png'),
                    data: block.source.data
                }
            });
        } else if (block.type === 'tool_result') {
            const rid = block.tool_use_id || '';
            parts.push({
                functionResponse: {
                    id: rid,
                    name: block.name || toolNamesById.get(rid) || '',
                    response: _gaiResponseObject({ value: block.content })
                }
            });
        }
    }
    return parts;
}

/**
 * Centralized normalization of JAI/OAI messages to Google GenAI Content format.
 * @param {{msgs?: Array<MessageRow>, effectiveThoughtSignature?: string|null}} arg0
 * @returns {{contents: Array<{role: string, parts: Array<MessageRow>}>, systemInstruction: string|null}}
 */
export function normalizeToGAI({ msgs = [], effectiveThoughtSignature = null } = {}) {
    // F7: dedupe before the identity is stripped (see normalizeHistory).
    msgs = stripInjectionMeta({ messages: dedupeMessages({ messages: msgs }), keepNative: true });
    /** @type {Array<{role: string, parts: Array<MessageRow>}>} */
    const contents = [];
    let systemInstruction = null;
    const toolNamesById = new Map();

    for (const m of msgs) {
        if (!m || typeof m !== 'object') continue;
        if (isEmptyAssistantTurn({ m })) continue;
        const { thoughtSignature: _msgSig, thought_signature: _msgSigSnake, redactedThinking: _redactedThinking, ...cleanMsg } = m;
        delete /** @type {Record<string, unknown>} */ (cleanMsg)[MERCI_NATIVE_KEY];
        const sig = _msgSig || _msgSigSnake || effectiveThoughtSignature;
        const native = getNative({ row: m });
        const nativeParts = native && isStandard({ provider: native.provider, standard: StandardType.GAI })
            && (native.protocol == null || native.protocol === ProtocolType.GENERATE_CONTENT)
            ? native.items.filter((/** @type {any} */ p) => p && typeof p === 'object' && p.thought === true)
            : [];

        if (cleanMsg.role === 'system' || cleanMsg.role === 'developer' || m.type === 'system_message' || m.type === 'developer_message') {
            const text = Array.isArray(cleanMsg.parts)
                ? cleanMsg.parts.map((/** @type {any} */ p) => p?.text || '').filter(Boolean).join('\n\n')
                : Array.isArray(cleanMsg.content)
                    ? cleanMsg.content.map((/** @type {any} */ b) => (typeof b === 'string' ? b : (b?.text || ''))).filter(Boolean).join('\n\n')
                    : String(cleanMsg.content ?? '');
            systemInstruction = joinSystemParts({ acc: systemInstruction, part: text });
            continue;
        }

        if (cleanMsg.role === 'user' && cleanMsg.parts) {
            contents.push(/** @type {{role: string, parts: Array<MessageRow>}} */ (cleanMsg));
            continue;
        }

        if (cleanMsg.role === 'model' && cleanMsg.parts) {
            contents.push(nativeParts.length > 0
                ? { role: 'model', parts: [...nativeParts, ...cleanMsg.parts] }
                : /** @type {{role: string, parts: Array<MessageRow>}} */ (cleanMsg));
            continue;
        }

        if (m.type === 'user_message') {
            contents.push({ role: 'user', parts: Array.isArray(m.content)
                ? _gaiUserPartsFromBlocks({ blocks: m.content, toolNamesById })
                : [{ text: m.content }] });
            continue;
        }

        if (m.type === 'assistant_message' || m.type === 'assistant_message_text') {
            const parts = /** @type {Array<Record<string, any>>} */ (Array.isArray(m.content)
                ? _gaiModelPartsFromBlocks({ blocks: m.content, sig, toolNamesById })
                : [{ text: m.content }]);
            for (const p of parts) {
                if (typeof p?.text === 'string' && sig && p.thoughtSignature === undefined) p.thoughtSignature = sig;
            }
            contents.push({ role: 'model', parts: [...nativeParts, ...parts] });
            continue;
        }

        if (m.type === 'assistant_tool_call' || m.type === 'assistant_message_tool') {
            const calls = /** @type {Array<MessageRow>} */ (m.tool_calls || [{
                id: m.id,
                name: m.toolName,
                arguments: m.content
            }]);
            const parts = calls.map(tc => {
                const name = tc.name || tc.function?.name || tc.toolName || '';
                if (tc.id) toolNamesById.set(tc.id, name);
                const part = /** @type {MessageRow} */ ({
                    functionCall: {
                        id: tc.id,
                        name,
                        args: guardedParse({ input: tc.args || tc.arguments || tc.function?.arguments || tc.content || {} }).data ?? {}
                    }
                });
                const partSig = tc.thoughtSignature ?? sig; if (partSig) part.thoughtSignature = partSig;
                return part;
            });
            contents.push({ role: 'model', parts: [...nativeParts, ...parts] });
            continue;
        }

        if (m.type === 'tool_result_message' || m.type === 'tool_message') {
            const resultValue = m.result ?? m.content;
            contents.push({
                role: 'user',
                parts: [{
                    functionResponse: {
                        id: m.tool_call_id || m.id,
                        name: m.toolName || m.name || '',
                        response: _gaiResponseObject({ value: resultValue })
                    }
                }]
            });
            continue;
        }

        if (cleanMsg.role === 'tool') {
            const toolCallId = cleanMsg.tool_call_id || cleanMsg.id || '';
            if (!toolCallId) {
                contents.push({ role: 'user', parts: [{ text: '[tool result with missing id preserved]' }] });
                continue;
            }
            contents.push({
                role: 'user',
                parts: [{
                    functionResponse: {
                        id: toolCallId,
                        name: cleanMsg.name || toolNamesById.get(toolCallId) || '',
                        response: _gaiResponseObject({ value: cleanMsg.content })
                    }
                }]
            });
            continue;
        }

        if (cleanMsg.role === 'assistant' && cleanMsg.tool_calls) {
            const parts = cleanMsg.tool_calls.map((/** @type {MessageRow} */ tc) => {
                const name = tc.function?.name || '';
                if (tc.id) toolNamesById.set(tc.id, name);
                const part = /** @type {MessageRow} */ ({
                    functionCall: {
                        id: tc.id,
                        name,
                        args: guardedParse({ input: tc.function?.arguments || {} }).data ?? {}
                    }
                });
                const partSig = tc.thoughtSignature ?? sig; if (partSig) part.thoughtSignature = partSig;
                return part;
            });
            contents.push({ role: 'model', parts: [...nativeParts, ...parts] });
            continue;
        }

        if (cleanMsg.role === 'assistant' && Array.isArray(cleanMsg.content)) {
            const parts = _gaiModelPartsFromBlocks({ blocks: cleanMsg.content, sig, toolNamesById });
            if (parts.length > 0) contents.push({ role: 'model', parts: [...nativeParts, ...parts] });
            continue;
        }

        if (cleanMsg.role === 'assistant' && cleanMsg.content) {
            const textPart = /** @type {MessageRow} */ ({ text: String(cleanMsg.content) });
            if (sig) textPart.thoughtSignature = sig;
            contents.push({ role: 'model', parts: [...nativeParts, textPart] });
            continue;
        }

        if (cleanMsg.role === 'user' && Array.isArray(cleanMsg.content)) {
            const parts = _gaiUserPartsFromBlocks({ blocks: cleanMsg.content, toolNamesById });
            if (parts.length === 0) parts.push({ text: '[unhandled content blocks preserved]' });
            contents.push({ role: 'user', parts });
            continue;
        }

        if (cleanMsg.role === 'user' && cleanMsg.content) {
            contents.push({ role: 'user', parts: [{ text: String(cleanMsg.content) }] });
            continue;
        }
    }

    const merged = [];
    for (const c of contents) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === c.role) {
            prev.parts = prev.parts.concat(c.parts);
        } else {
            merged.push({ role: c.role, parts: [...c.parts] });
        }
    }

    // Vertex (and the Gemini 3 models behind it) rejects a user turn whose
    // functionResponse part is followed by text:
    //   400 "Requests ending with a model turn are not supported."
    // The trailing live-state row (todos, memory, skills) merges into the tool
    // result turn, producing [functionResponse, text] — the rejected order.
    // Keep functionResponse parts last inside every user turn; a turn that is
    // only functionResponses is unchanged, and the text still reaches the model
    // in the same turn.
    for (const content of merged) {
        if (content.role !== 'user' || content.parts.length < 2) continue;
        const isResponse = (/** @type {any} */ part) => !!part && typeof part === 'object' && part.functionResponse;
        if (!content.parts.some(isResponse)) continue;
        const responses = content.parts.filter(isResponse);
        const rest = content.parts.filter((/** @type {any} */ part) => !isResponse(part));
        content.parts = [...rest, ...responses];
    }

    return { contents: merged, systemInstruction };
}
