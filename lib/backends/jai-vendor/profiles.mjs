// @ts-check
/**
 * @file JAI model profile registry.
 * @version 0.12.0
 *
 * @description
 * Fetches and caches the JAI `/llm/profiles/v9` listing, exposing profile
 * lookup and per-profile parameter support probes (dotted toolConfig paths
 * included; unknown/undisclosed params are treated as supported).
 */

import { LIMITS } from '../../core/limit-config.mjs';
import { connectTimeoutMs } from './http-client.mjs';

/**
 * True when the profile's declared params include `key` (prefix or suffix
 * match on dotted paths). Unknown/undisclosed sets are permissive.
 * @param {{params: Set<string>, key: string}} arg0
 * @returns {boolean}
 */
export function declaresParam({ params, key }) {
    if (!params || params.size === 0) return true;
    if (params.has(key)) return true;
    for (const p of params) {
        if (p.startsWith(`${key}.`) || p.endsWith(`.${key}`)) return true;
    }
    return false;
}

/**
 * @typedef {Object} JaiProfile
 * @property {string} id
 * @property {string} [name]
 * @property {{ parameters?: Array<string> }} [chatDefinition]
 * @property {Array<string>} [parameters]
 */

/**
 * @typedef {Object} ProfileHttpClient
 * @property {number} [streamTimeout] - The session's stream timeout (read for the roster call's budget).
 * @property {(arg0: {path: string, options: import('./http-client.mjs').FetchOptions}) => Promise<{json: () => Promise<unknown>}>} _fetchWithRetry
 */

/**
 * A cached JAI model profile: the wire profile plus the parsed parameter set.
 * @typedef {JaiProfile & {params?: Set<string>}} CachedJaiProfile
 */

/**
 * Cached JAI model profile registry.
 */
export class ProfileManager {
    /**
     * @type {ProfileHttpClient}
     */
    #httpClient;
    /**
     * @type {Record<string, any>|null}
     */
    #cache = null;
    #cacheTimestamp = 0;
    #TTL = LIMITS.profile_cache_ttl_ms;
    /**
     * In-flight roster fetch — concurrent callers share it instead of each
     * firing their own request (J14). Cleared on settle, so a failure retries.
     * @type {Promise<Record<string, any>>|null}
     */
    #inflight = null;

    /**
 * @param {{httpClient: ProfileHttpClient, cacheTTL?: number}} arg0
 */
    constructor({ httpClient, cacheTTL }) {
        this.#httpClient = httpClient;
        this.#TTL = cacheTTL ?? LIMITS.profile_cache_ttl_ms;
    }

    /**
     * Fetches (or serves from cache) the profile map keyed by profile id.
     * @returns {Promise<Record<string, CachedJaiProfile>>} Profile map (`id → { ..., params: Set }`).
     */
    async getProfiles() {
        if (this.#cache && this.#TTL > 0 && (Date.now() - this.#cacheTimestamp < this.#TTL)) {
            return this.#cache;
        }
        if (!this.#inflight) {
            this.#inflight = this.#fetchProfiles().finally(() => { this.#inflight = null; });
        }
        return this.#inflight;
    }

    /**
     * The actual roster round-trip behind getProfiles().
     * @returns {Promise<Record<string, CachedJaiProfile>>}
     */
    async #fetchProfiles() {
        try {
            const timeoutMs = connectTimeoutMs();
            const response = await this.#httpClient._fetchWithRetry({ path: '/llm/profiles/v9', options: { method: 'GET', headerTimeoutMs: timeoutMs, bodyTimeoutMs: timeoutMs } });
            const data = /** @type {{ profiles?: JaiProfile[] }} */ (await response.json());

            this.#cache = (data.profiles ?? []).reduce((acc, profile) => {
                const paramList = (profile.chatDefinition && Array.isArray(profile.chatDefinition.parameters))
                    ? profile.chatDefinition.parameters
                    : (profile.parameters || []);
                acc[profile.id] = {
                    ...profile,
                    params: new Set(paramList)
                };
                return acc;
            }, /** @type {Record<string, any>} */ (Object.create(null)));

            this.#cacheTimestamp = Date.now();
            return this.#cache;
        } catch (e) {
            this.#cache = this.#cache || Object.create(null);
            throw e;
        }
    }

    /**
 * True when the profile supports the parameter (permissive when unknown).
 * @param {{profileId: string, paramKey: string}} arg0
 * @returns {boolean}
 */
    isSupported({ profileId, paramKey }) {
        if (!this.#cache || !this.#cache[profileId]) return true;
        return declaresParam({ params: this.#cache[profileId].params, key: paramKey });
    }

    /**
 * Returns the cached profile for an id, or null.
 * @param {{profileId: string}} arg0
 * @returns {CachedJaiProfile|null}
 */
    getProfile({ profileId }) {
        return this.#cache?.[profileId] ?? null;
    }
}
