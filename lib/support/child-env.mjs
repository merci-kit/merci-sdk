// @ts-check


/**
 * @file The environment a child process may inherit.
 * @version 0.12.0
 *
 * @description
 * Kept out of `utils.mjs`, and free of any MCP import, on purpose: importing
 * `@modelcontextprotocol/client/stdio` pulls the whole MCP client into the
 * module graph, and this module sits on the path from `skills.mjs` /
 * `context-tools.mjs` to every backend. A backend that never speaks MCP must
 * not pay that cost at cold start.
 *
 * The allowlist mirrors the MCP SDK's `DEFAULT_INHERITED_ENV_VARS` (there is no
 * extension hook, and importing it would defeat the point); the locale and
 * timezone variables a child needs for correct date formatting are merged on
 * top, and only when the parent has them.
 */

/** The MCP SDK's inherited-variable allowlist, copied verbatim. */
const INHERITED_ENV_VARS = process.platform === 'win32'
    ? [
        'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT',
        'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
        'PROGRAMW6432', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE', 'WINDIR',
    ]
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

/** Locale/timezone variables the allowlist omits but a child formats with. */
const LOCALE_ENV_VARS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'];


/**
 * The environment a child process may inherit.
 * @returns {Record<string, string>}
 */
export function safeChildEnv() {
    /** @type {Record<string, string>} */
    const out = {};
    for (const key of [...INHERITED_ENV_VARS, ...LOCALE_ENV_VARS]) {
        const value = process.env[key];
        if (typeof value === 'string' && value.length > 0) out[key] = value;
    }
    return out;
}
