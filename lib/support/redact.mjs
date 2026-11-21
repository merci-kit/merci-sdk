// @ts-check


/**
 * @file The two redaction helpers every sink shares.
 * @version 0.12.0
 *
 * @description
 * A URL and a free-text value reach different sinks (the OTel exporter, the
 * logger, an error message, an event payload), and every sink used to apply its
 * own policy. These are the one policy:
 *
 *   - `redactUrl` reduces a URL to its origin (`scheme://host[:port]`): no
 *     userinfo, path, query or fragment survives, so a credential placed in a
 *     base URL or a query string cannot be echoed (A-13, G2-9).
 *   - `scrubSecrets` removes the credential shapes that hide inside text
 *     (bearer tokens, `sk-…` keys, `key=`/`api_key=`/`token=`/`secret=` values
 *     and `user:pass@` userinfo), in one bounded pass — every quantifier is
 *     capped, so a hostile string cannot make the scan backtrack (G1-4, G2-8).
 */

/**
 * One pass, bounded alternatives: bearer token, URL userinfo, a PEM private-key
 * block, an `sk-` key, then a `name=value` / `"name":"value"` pair whose name
 * ends in `key`/`secret`/`token`/`password` (so `private_key=` and `API_KEY=`
 * are covered). Every quantifier is capped and the identifier prefix is short,
 * so the scan cannot backtrack over a long run. The pair alternative keeps its
 * name in group 1 and its value in group 2.
 *
 * The pair separator must be adjacent (`key=`, `"key":"…"`): `the key = the
 * answer` and `key: value pairs` are prose, not a credential.
 */
const SECRET_RE = new RegExp([
    String.raw`\bBearer\s+[A-Za-z0-9._~+/=:-]{1,512}`,
    String.raw`(?<=\/\/)[^\s\/@?#"'<>]{1,256}@`,
    // PEM body base64/newlines only — the bound stops a missing END from scanning the file.
    String.raw`-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY-----[^-]{0,16384}-----END [A-Z0-9 ]{0,32}PRIVATE KEY-----`,
    String.raw`\bsk-[A-Za-z0-9_-]{1,512}`,
    String.raw`(["']?\b[A-Za-z0-9_]{0,64}(?:key|secret|token|password|passwd)["']?[=:])("[^"\n]{0,512}"|'[^'\n]{0,512}'|[^\s&,;"'}\]]{1,512})`
].join('|'), 'gi');

const BEARER_RE = /^Bearer/i;
const PEM_RE = /^-----BEGIN/;
const SK_KEY_RE = /^sk-/i;


/**
 * The origin of a URL. Userinfo, path, query and fragment are dropped.
 *
 * @param {{url: unknown}} arg0 - Any URL-shaped value.
 * @returns {string} `scheme://host[:port]`, or `[invalid-url]` when it cannot
 *   be parsed (the input is never echoed, it may be the secret).
 *
 * @example
 * redactUrl({ url: 'https://user:sk-live-ABC@gw.example.com:8443/v1?key=x' })
 * // 'https://gw.example.com:8443'
 */
export function redactUrl({ url }) {
    try {
        const parsed = new URL(String(url ?? ''));
        return `${parsed.protocol}//${parsed.host}`;
    } catch {
        return '[invalid-url]';
    }
}


/**
 * Removes the credential shapes that can hide inside a free-text value.
 *
 * @param {{text: unknown}} arg0 - A message, a log value or an event payload string.
 * @returns {string} The text with each secret replaced (the surrounding text is kept).
 *
 * @example
 * scrubSecrets({ text: '401 for {"api_key":"hunter2"}' })
 * // '401 for {"api_key":[REDACTED]}'
 */
export function scrubSecrets({ text }) {
    const source = String(text ?? '');
    if (source === '') return source;
    return source.replace(SECRET_RE, (match, pairKey, pairValue) => {
        if (pairKey) return String(pairValue).startsWith('[REDACTED') ? match : `${pairKey}[REDACTED]`;
        if (BEARER_RE.test(match)) return 'Bearer [REDACTED]';
        if (PEM_RE.test(match)) return '[REDACTED PRIVATE KEY]';
        if (SK_KEY_RE.test(match)) return 'sk-[REDACTED]';
        // URL userinfo: drop `user:pass@` and keep the host that follows it.
        return '';
    });
}
