// @ts-check
/**
 * @file Client roles — one provider/model per role, with the surface bound.
 * @version 0.24.0
 *
 * @description
 * Pins the role registry to `EnvKey`, the resolution precedence (role key >
 * inherited `PROVIDER`, role model > descriptor default), the refusals that
 * name the env key to fix, and `createRoleClients`' one-client-per-provider
 * build with the role surface bound to that client.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClientRole, ROLE_REGISTRY, EnvKey } from '../lib/core/constants/index.mjs';
import { createRoleClients } from '../lib/index.mjs';
import { ensureEnvLoaded, resolveRole } from '../lib/support/utils.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

// secret.env is merged once, before any test edits the environment; otherwise
// deleting PROVIDER would make a later ensureEnvLoaded() re-inject it.
ensureEnvLoaded();


/**
 * Runs `fn` with `assign` merged into process.env, restoring every touched key
 * afterwards. A value of `undefined` unsets the key.
 * @param {{assign: Record<string, string|undefined>, fn: () => (void|Promise<void>)}} arg0
 */
async function withEnv({ assign, fn }) {
    /** @type {Record<string, string|undefined>} */
    const saved = {};
    for (const key of Object.keys(assign)) {
        saved[key] = process.env[key];
        if (assign[key] === undefined) delete process.env[key];
        else process.env[key] = assign[key];
    }
    try {
        await fn();
    } finally {
        for (const key of Object.keys(assign)) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}


test('registry: every role env-key literal is the same-named EnvKey entry', () => {
    assert.deepEqual(Object.keys(ROLE_REGISTRY), Object.values(ClientRole));
    for (const entry of Object.values(ROLE_REGISTRY)) {
        assert.equal(ROLE_REGISTRY[entry.id], entry);
        assert.equal(EnvKey[entry.providerKey], entry.providerKey);
        assert.equal(EnvKey[entry.modelKey], entry.modelKey);
        assert.equal(EnvKey[entry.inherits], entry.inherits);
    }
    assert.deepEqual(ROLE_REGISTRY[ClientRole.DECISION], {
        id: 'decision',
        providerKey: 'DECISION_PROVIDER',
        modelKey: 'DECISION_MODEL',
        inherits: 'PROVIDER',
        defaultModel: 'decision',
        requires: 'decision',
    });
});


test('resolution: the role provider key wins over PROVIDER', async () => {
    await withEnv({
        assign: { PROVIDER: 'vertex', GENERATIVE_PROVIDER: 'openai', GENERATIVE_MODEL: 'g-model' },
        fn: () => {
            const resolved = resolveRole({ role: ClientRole.GENERATIVE });
            assert.equal(resolved.provider, 'openai');
            assert.equal(resolved.model, 'g-model');
            assert.deepEqual(resolved.source, { provider: 'role', model: 'role' });
        },
    });
});


test('resolution: an unset role provider key inherits PROVIDER', async () => {
    await withEnv({
        assign: { PROVIDER: 'vertex', GENERATIVE_PROVIDER: undefined, GENERATIVE_MODEL: undefined, DEFAULT_VERTEX_MODEL: 'vertex-default' },
        fn: () => {
            const resolved = resolveRole({ role: ClientRole.GENERATIVE });
            assert.equal(resolved.provider, 'vertex');
            assert.equal(resolved.source.provider, 'inherited');
        },
    });
});


test('resolution: the role model key wins over the descriptor default', async () => {
    await withEnv({
        assign: {
            GENERATIVE_PROVIDER: 'openai',
            GENERATIVE_MODEL: 'role-model',
            DEFAULT_OPENAI_MODEL: 'descriptor-model',
        },
        fn: () => {
            const resolved = resolveRole({ role: ClientRole.GENERATIVE });
            assert.equal(resolved.model, 'role-model');
            assert.equal(resolved.source.model, 'role');
        },
    });
});


test('resolution: an unset role model key falls back to the descriptor default', async () => {
    await withEnv({
        assign: {
            GENERATIVE_PROVIDER: 'openai',
            GENERATIVE_MODEL: undefined,
            DEFAULT_OPENAI_MODEL: 'descriptor-model',
        },
        fn: () => {
            const resolved = resolveRole({ role: ClientRole.GENERATIVE });
            assert.equal(resolved.model, 'descriptor-model');
            assert.equal(resolved.source.model, 'default');
        },
    });
});


test('refusals: a provider without the wire is named by the role key', async () => {
    await withEnv({
        assign: { DECISION_PROVIDER: 'vertex', DECISION_MODEL: undefined },
        fn: () => {
            assert.throws(() => resolveRole({ role: ClientRole.DECISION }), (error) => {
                assert.ok(error instanceof ConfigurationError);
                assert.match(error.message, /DECISION_PROVIDER/);
                assert.match(error.message, /decision wire/);
                return true;
            });
        },
    });
    await withEnv({
        assign: { EMBEDDING_PROVIDER: 'anthropic', EMBEDDING_MODEL: undefined },
        fn: () => {
            assert.throws(() => resolveRole({ role: ClientRole.EMBEDDING }), (error) => {
                assert.ok(error instanceof ConfigurationError);
                assert.match(error.message, /EMBEDDING_PROVIDER/);
                assert.match(error.message, /embeddings wire/);
                return true;
            });
        },
    });
});


test('refusals: a decision-capable provider with no default model names both keys', async () => {
    await withEnv({
        assign: {
            DECISION_PROVIDER: 'openai',
            DECISION_MODEL: undefined,
            DEFAULT_OPENAI_DECISION_MODEL: undefined,
        },
        fn: () => {
            assert.throws(() => resolveRole({ role: ClientRole.DECISION }), (error) => {
                assert.ok(error instanceof ConfigurationError);
                assert.match(error.message, /DECISION_MODEL/);
                assert.match(error.message, /DEFAULT_OPENAI_DECISION_MODEL/);
                return true;
            });
        },
    });
});


test('refusals: an unknown role lists the valid roles', () => {
    assert.throws(() => resolveRole({ role: 'nope' }), (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /Unknown client role/);
        assert.match(error.message, /generative, embedding, decision/);
        return true;
    });
});


/** A fake backend client with all three role surfaces. */
function fakeClient() {
    return {
        session: (/** @type {any} */ modelOrOptions) => ({ modelOrOptions }),
        embed: (/** @type {any} */ arg0) => Promise.resolve({ vectors: [], arg0 }),
        decisions: { ask: (/** @type {any} */ arg0) => Promise.resolve({ model: arg0.model, answers: {}, usage: {} }) },
    };
}


test('createRoleClients: one client per distinct provider, one entry per role', async () => {
    await withEnv({
        assign: {
            GENERATIVE_PROVIDER: 'openai',
            GENERATIVE_MODEL: 'g-model',
            EMBEDDING_PROVIDER: 'openai',
            EMBEDDING_MODEL: 'e-model',
            DECISION_PROVIDER: 'openai',
            DECISION_MODEL: 'd-model',
        },
        fn: async () => {
            /** @type {Array<{provider: string, options: Record<string, unknown>}>} */
            const calls = [];
            const clients = await createRoleClients({
                clientFactory: async ({ provider, options }) => {
                    calls.push({ provider, options });
                    return { client: fakeClient() };
                },
            });
            assert.equal(calls.length, 1);
            assert.equal(calls[0].provider, 'openai');
            assert.deepEqual(Object.keys(clients), [ClientRole.GENERATIVE, ClientRole.EMBEDDING, ClientRole.DECISION]);
            assert.equal(clients.generative.provider, 'openai');
            assert.equal(clients.generative.model, 'g-model');
            assert.equal(clients.embedding.model, 'e-model');
            assert.equal(clients.decision.model, 'd-model');
            assert.equal(typeof clients.generative.session, 'function');
            assert.equal(typeof clients.embedding.embed, 'function');
            assert.equal(typeof clients.decision.ask, 'function');
            // The public entry type keeps every surface optional (roles are dynamic),
            // so a test that knows its roles narrows once instead of casting per call.
            const decision = /** @type {any} */ (clients.decision);
            const asked = await decision.ask({ state: 's', questions: {} });
            assert.equal(asked.model, 'd-model');
        },
    });
});


test('createRoleClients: a reused client is still checked for the second role surface', async () => {
    await withEnv({
        assign: {
            GENERATIVE_PROVIDER: 'openai',
            GENERATIVE_MODEL: 'g-model',
            DECISION_PROVIDER: 'openai',
            DECISION_MODEL: 'd-model',
        },
        fn: async () => {
            let builds = 0;
            await assert.rejects(
                createRoleClients({
                    roles: [ClientRole.GENERATIVE, ClientRole.DECISION],
                    clientFactory: async () => {
                        builds += 1;
                        return { client: { session: () => null } };
                    },
                }),
                (error) => {
                    assert.ok(error instanceof ConfigurationError);
                    assert.match(error.message, /decisions\.ask/);
                    return true;
                },
            );
            assert.equal(builds, 1, 'the shared client is built once, then refused for decision');
        },
    });
});


test('createRoleClients: distinct per-role options never share a client', async () => {
    await withEnv({
        assign: {
            GENERATIVE_PROVIDER: 'openai',
            GENERATIVE_MODEL: 'g-model',
            EMBEDDING_PROVIDER: 'openai',
            EMBEDDING_MODEL: 'e-model',
        },
        fn: async () => {
            /** @type {Array<Record<string, unknown>>} */
            const calls = [];
            const fetchA = async () => new Response('{}');
            const fetchB = async () => new Response('{}');
            await createRoleClients({
                roles: [ClientRole.GENERATIVE, ClientRole.EMBEDDING],
                options: { generative: { fetchImpl: fetchA }, embedding: { fetchImpl: fetchB } },
                clientFactory: async ({ options }) => {
                    calls.push(options);
                    return { client: fakeClient() };
                },
            });
            assert.equal(calls.length, 2);
            assert.equal(calls[0].fetchImpl, fetchA);
            assert.equal(calls[1].fetchImpl, fetchB);
        },
    });
});


test('createRoleClients: the generative surface defaults to the role model', async () => {
    await withEnv({
        assign: { GENERATIVE_PROVIDER: 'openai', GENERATIVE_MODEL: 'g-model' },
        fn: async () => {
            const clients = await createRoleClients({
                roles: [ClientRole.GENERATIVE],
                clientFactory: async () => ({ client: fakeClient() }),
            });
            const generative = /** @type {any} */ (clients.generative);
            assert.equal(generative.session().modelOrOptions, 'g-model');
            assert.equal(generative.session('explicit').modelOrOptions, 'explicit');
        },
    });
});


test('resolution: a blank role model is unset, not a model named spaces', async () => {
    await withEnv({
        assign: { GENERATIVE_PROVIDER: 'openai', GENERATIVE_MODEL: '   ', DEFAULT_OPENAI_MODEL: undefined },
        fn: () => {
            assert.throws(() => resolveRole({ role: ClientRole.GENERATIVE }), (error) => {
                assert.ok(error instanceof ConfigurationError);
                assert.match(error.message, /GENERATIVE_MODEL/);
                return true;
            });
        },
    });
    await withEnv({
        assign: { GENERATIVE_PROVIDER: 'openai', GENERATIVE_MODEL: '   ', DEFAULT_OPENAI_MODEL: 'fallback-model' },
        fn: () => {
            const resolved = resolveRole({ role: ClientRole.GENERATIVE });
            assert.equal(resolved.model, 'fallback-model');
            assert.equal(resolved.source.model, 'default');
        },
    });
});


test('createRoleClients: a client without session() cannot serve the generative role', async () => {
    await withEnv({
        assign: { GENERATIVE_PROVIDER: 'openai', GENERATIVE_MODEL: 'g-model' },
        fn: async () => {
            await assert.rejects(
                createRoleClients({
                    roles: [ClientRole.GENERATIVE],
                    clientFactory: async () => ({ client: { embed: () => null } }),
                }),
                (error) => {
                    assert.ok(error instanceof ConfigurationError);
                    assert.match(error.message, /session\(\)/);
                    return true;
                },
            );
        },
    });
});


test('createRoleClients: a client without the role surface is refused', async () => {
    await withEnv({
        assign: { DECISION_PROVIDER: 'openai', DECISION_MODEL: 'd-model' },
        fn: async () => {
            await assert.rejects(
                createRoleClients({
                    roles: [ClientRole.DECISION],
                    clientFactory: async () => ({ client: { session: () => null } }),
                }),
                (error) => {
                    assert.ok(error instanceof ConfigurationError);
                    assert.match(error.message, /decision/);
                    return true;
                },
            );
        },
    });
});
