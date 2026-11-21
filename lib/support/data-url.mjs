// @ts-check
/**
 * @file data-url — the base64 data-URL parse and encode the wire layers share.
 * @version 0.12.0
 *
 * @description
 * Six call sites parsed a data URL with the same literal regex and three built
 * one with the same template. The strict form is the one they all required: a
 * media type and a payload, separated by `;base64,`. A data URL without the
 * `;base64` marker, without a media type or without a payload is not media and
 * parses to `null`.
 */

/** `data:<mime>;base64,<payload>`, the form every call site already required. */
const BASE64_DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/;

/**
 * The media type and payload of a base64 data URL, or `null` when the URL is
 * not one (a remote URL, a non-base64 data URL, an empty payload).
 * @param {{url: string}} arg0
 * @returns {{mimeType: string, data: string}|null}
 */
export function parseBase64DataUrl({ url }) {
    const match = BASE64_DATA_URL_RE.exec(url);
    return match ? { mimeType: match[1], data: match[2] } : null;
}

/**
 * The base64 data URL for a media type and payload.
 * @param {{mimeType: string, data: string}} arg0
 * @returns {string}
 */
export function toBase64DataUrl({ mimeType, data }) {
    return `data:${mimeType};base64,${data}`;
}
