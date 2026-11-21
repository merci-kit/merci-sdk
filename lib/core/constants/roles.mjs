// @ts-check
/**
 * @file Client-role registry.
 * @version 0.24.0
 *
 * @description
 * A host may point each client role at its own provider and model: the chat
 * client, the embedding client, and the discriminative ("System One") client.
 * One entry per role declares the env keys that select them, the env key the
 * provider inherits, the descriptor `models` key used when no model is set,
 * and the surface the resolved client must expose. Data only — env-key names
 * are literal strings on purpose (importing ./sdk.mjs would create a cycle);
 * test/role-clients.test.mjs locks each one to the same-named `EnvKey` entry.
 */


/**
 * The three client roles a host can resolve.
 * @type {Object<string, string>}
 */
export const ClientRole = Object.freeze({
    GENERATIVE: 'generative',
    EMBEDDING: 'embedding',
    DECISION: 'decision',
});


/**
 * @typedef {Object} RoleDescriptor
 * @property {string} id - The ClientRole value.
 * @property {string} providerKey - Env key selecting the role's provider.
 * @property {string} modelKey - Env key selecting the role's model.
 * @property {string} inherits - Env key the provider falls back to (`PROVIDER`).
 * @property {string} defaultModel - Descriptor `models` key used when `modelKey`
 *   is unset: 'default', 'embedding', or 'decision'.
 * @property {'session'|'embeddings'|'decision'} requires - What the provider
 *   must support: 'session' is always available; 'embeddings' needs
 *   `descriptor.capabilities.embeddings`; 'decision' needs
 *   `descriptor.models.decision` to be non-null.
 */


/**
 * Role descriptors keyed by ClientRole value.
 * @type {Object<string, RoleDescriptor>}
 */
export const ROLE_REGISTRY = Object.freeze({
    [ClientRole.GENERATIVE]: {
        id: ClientRole.GENERATIVE,
        providerKey: 'GENERATIVE_PROVIDER',
        modelKey: 'GENERATIVE_MODEL',
        inherits: 'PROVIDER',
        defaultModel: 'default',
        requires: 'session',
    },
    [ClientRole.EMBEDDING]: {
        id: ClientRole.EMBEDDING,
        providerKey: 'EMBEDDING_PROVIDER',
        modelKey: 'EMBEDDING_MODEL',
        inherits: 'PROVIDER',
        defaultModel: 'embedding',
        requires: 'embeddings',
    },
    [ClientRole.DECISION]: {
        id: ClientRole.DECISION,
        providerKey: 'DECISION_PROVIDER',
        modelKey: 'DECISION_MODEL',
        inherits: 'PROVIDER',
        defaultModel: 'decision',
        requires: 'decision',
    },
});
