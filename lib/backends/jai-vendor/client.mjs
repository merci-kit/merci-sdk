// @ts-check
/** @file JAI vendor transport client. @version 0.12.0 */

import { EventEmitter } from 'node:events';
import { InternalHttpClient } from './http-client.mjs';
import { ProfileManager } from './profiles.mjs';
import { TaskAPI, QuotaAPI } from './api.mjs';
import { ProviderType } from '../../core/constants/index.mjs';

/**
 * @typedef {Object} MerciClientOptions
 * @property {string} [token] - JWT authentication token (required by the authenticated endpoints; the constructor tolerates its absence).
 * @property {string} [authType]
 * @property {string} [endpoint]
 * @property {number} [streamTimeout]
 * @property {string} [tokenPersistFile]
 * @property {string} [tokenPersistKey]
 * @property {string} [userToken]
 * @property {string} [originalServiceToken]
 * @property {string} [originalApplicationToken]
 * @property {string} [applicationUserId]
 * @property {string} [originalUserCountry]
 * @property {string} [originalUserIP]
 * @property {string} [clientExecutionId]
 * @property {string} [clientFeatureId]
 * @property {boolean} [provideDebugInfo]
 * @property {string} [protocol] - Wire protocol (ProtocolType): 'chat' (default), 'responses', or 'task' (transport-only — use client.tasks).
 * @property {number} [profileCacheTTL] - Profile cache TTL in ms.
 */

/**
 * JAI vendor transport client — assembles the HTTP client, profile manager,
 * task API, and quota API around a single event emitter.
 */
export class MerciClient extends EventEmitter {
    tasks; profiles; quota; httpClient;
    /** @type {string|undefined} Wire protocol inherited by sessions (ProtocolType). */
    protocol;

    /**
 * @param {{options?: MerciClientOptions}} arg0
 */
    constructor({ options = {} } = {}) {
        super();
        this.provider = ProviderType.JAI;
        this.protocol = options.protocol;
        this.httpClient = new InternalHttpClient({ options: /** @type {any} */ (options), eventEmitter: this });
        this.profiles = new ProfileManager({ httpClient: this.httpClient, cacheTTL: options.profileCacheTTL });
        this.tasks = new TaskAPI({ httpClient: this.httpClient });
        this.quota = new QuotaAPI({ httpClient: this.httpClient });
    }
}
