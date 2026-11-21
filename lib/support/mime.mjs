// @ts-check
/**
 * @file mime — the media type for a file path.
 * @version 0.12.0
 *
 * @description
 * The two media factories each looked up `MIME_TYPE_MAP` by lowercased
 * extension and carried their own fallback (one `image/jpeg`, one
 * `application/octet-stream` plus an `.svg` entry). One lookup with the
 * caller's fallback and extra entries keeps both behaviours explicit.
 */

import { extname } from 'node:path';
import { MIME_TYPE_MAP } from '../core/constants/index.mjs';

/**
 * The media type for a path, from its lowercased extension.
 * @param {{path: string, fallback?: string, extra?: Record<string, string>|null}} arg0 -
 *   `extra` entries win over the shared map; `fallback` is used for an unknown
 *   or missing extension.
 * @returns {string}
 */
export function mimeTypeForPath({ path, fallback = 'application/octet-stream', extra = null }) {
    const map = extra ? { ...MIME_TYPE_MAP, ...extra } : MIME_TYPE_MAP;
    return map[extname(path).toLowerCase()] || fallback;
}
