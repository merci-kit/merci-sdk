// @ts-check
/**
 * @file Model-tier defaults and provider detection helpers.
 * @version 0.12.0
 *
 * @description
 * Default model ids per embedding/reasoning backend, MIME-type mapping for
 * media payloads, and predicate helpers that classify models/profiles by
 * provider (Google, Anthropic) or reasoning tier (o-series). The per-backend
 * default/tool-tier model maps live in the EnvKey registry (sdk.mjs); these
 * constants pin the concrete ids those keys resolve to.
 */


/** API-key placeholder for local backends that require none. */
export const LOCAL_API_KEY_PLACEHOLDER = 'not-needed';


/**
 * XML open/close tags wrapping tool calls on raw-text backends.
 * @type {Object<string, string>}
 */
export const XML_TOOL_CALL_TAGS = Object.freeze({
    START: '<tool_call>',
    END: '</tool_call>'
});


/** Default Anthropic model id. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

/** Default model id for the opencode backend. */
export const DEFAULT_OPENCODE_MODEL = 'deepseek-v4-flash';

const ProviderName = {
    GOOGLE: 'Google',
    ANTHROPIC: 'Anthropic',
    OPENAI: 'OpenAI',
};

const ProviderProfilePrefix = {
    GOOGLE: 'google-',
    ANTHROPIC: 'anthropic-',
};

const O_SERIES_MODEL_IDS = new Set([
    'o1',
    'o1-preview',
    'o1-mini',
    'o3',
    'o3-mini',
    'o4-mini',
    'o4',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-5.1',
    'gpt-5.1-mini',
    'gpt-5.1-nano',
]);

const O_SERIES_PATH_PATTERNS = ['/o1-', '/o3-', '/o4-', '/gpt-5', '/gpt-5.1'];
const O_SERIES_REGEX = /(?:^|\/)(?:o[134]|gpt-5(?:\.\d+)?)(?:[-_]|$)/i;


/**
 * path pattern) that must use the reasoning-wire shape.
 * @param {{model: string}} arg0 -
 * @returns {boolean}
 */
export function isOSeries({ model }) {
    if (typeof model !== 'string') return false;
    return O_SERIES_MODEL_IDS.has(model) || O_SERIES_PATH_PATTERNS.some(p => model.includes(p)) || O_SERIES_REGEX.test(model);
}


/**
 * Extension → MIME-type map for media attachments.
 * @type {Object<string, string>}
 */
export const MIME_TYPE_MAP = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
};


/**
 * (Gemini/Vertex).
 * @param {{modelProfile: {provider?: string}|null|undefined, profile: string|null|undefined}} arg0 -
 * @returns {boolean}
 */
export function isGoogleProvider({ modelProfile, profile }) {
    return !!((modelProfile && modelProfile.provider === ProviderName.GOOGLE)
        || (profile && profile.startsWith(ProviderProfilePrefix.GOOGLE)));
}


/**
 * @param {{modelProfile: {provider?: string}|null|undefined, profile: string|null|undefined}} arg0 -
 * @returns {boolean}
 */
export function isAnthropicProvider({ modelProfile, profile }) {
    return !!((modelProfile && modelProfile.provider === ProviderName.ANTHROPIC)
        || (profile && profile.startsWith(ProviderProfilePrefix.ANTHROPIC)));
}
