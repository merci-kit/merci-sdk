// @ts-check

/**
 * @file Base-URL resolution for the `anthropic` and `openai` providers.
 * @version 0.21.1
 *
 * @description
 * A host that points a provider at a proxy must not have the URL silently
 * dropped. Precedence, highest first: `options.baseURL` (a non-empty string),
 * the provider's URL env key (trimmed; blank ignored), the descriptor or
 * opencode-tier default, the connector default. `null` means "unset". On
 * `anthropic`, `options.anthropicOptions` (the old vendor-SDK option bag) is
 * refused: the backend is a native fetch connector now.
 *
 * Every test clears the URL/key env keys before it runs and restores the
 * ambient values afterwards, so the suite never depends on a host environment.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { initializeClient } from '../lib/index.mjs';
import { ProviderType, StandardType } from '../lib/core/constants/index.mjs';
import { MerciClient as AaiClient } from '../lib/backends/aai.mjs';
import { MerciClient as OaiClient } from '../lib/backends/oai.mjs';
import { joinUrl } from '../lib/backends/transport/http.mjs';
import { ensureEnvLoaded, loadCredentials } from '../lib/support/utils.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

// secret.env is merged into process.env once, lazily. Load it before any test
// clears a key, so a later load cannot repopulate what the test unset.
ensureEnvLoaded();

const ANTHROPIC_ENV = 'ANTHROPIC_BASE_URL';
const OPENAI_ENV = 'OPENAI_BASE_URL';
const OPENCODE_URL_ENV = 'OPENCODE_URL';
const OPENCODE_TIER_ENV = 'OPENCODE_TIER';
const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';
const ANTHROPIC_PROXY = 'https://anthropic-proxy.example/v1';
const OPENAI_PROXY = 'https://openai-proxy.example/v1';
const ANTHROPIC_DEFAULT = 'https://api.anthropic.com';
const OPENAI_DEFAULT = 'https://api.openai.com/v1';
const OPENROUTER_DEFAULT = 'https://openrouter.ai/api/v1';
const OPENCODE_GO = 'https://opencode.ai/zen/go/v1';
const OPENCODE_ZEN = 'https://opencode.ai/zen/v1';

// Cleared for every test: one suite must not inherit a host's endpoint or key.
const CLEARED_ENV = [
    ANTHROPIC_ENV, OPENAI_ENV, OPENCODE_URL_ENV, OPENCODE_TIER_ENV,
    OPENROUTER_KEY_ENV, 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_API_KEY',
];

/** @param {unknown} value @returns {any} */
const asAny = (value) => /** @type {any} */ (value);

/**
 * Runs `fn` with every endpoint/key env key cleared, then applies `assign` on
 * top. The ambient values are restored in a `finally`, whatever the test does.
 * @param {{assign?: Record<string, string>, fn: () => (void|Promise<void>)}} arg0
 */
async function withBaseURLEnv({ assign = {}, fn }) {
    /** @type {Record<string, string|undefined>} */
    const saved = {};
    for (const key of CLEARED_ENV) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    for (const [key, value] of Object.entries(assign)) process.env[key] = value;
    try {
        await fn();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}


describe('explicit options.baseURL', () => {
    it('anthropic: the option reaches the transport and the session keeps its identity', async () => {
        await withBaseURLEnv({ fn: async () => {
            const { client } = await initializeClient({
                provider: ProviderType.ANTHROPIC,
                options: { apiKey: 'k', baseURL: ANTHROPIC_PROXY },
            });
            assert.equal(asAny(client).transport.baseURL, ANTHROPIC_PROXY, 'transport.baseURL follows options.baseURL');
            const session = client.session('claude-sonnet-4-5');
            assert.equal(session.provider, ProviderType.ANTHROPIC, 'session.provider');
            assert.equal(session.standard, StandardType.AAI, 'session.standard');
        } });
    });

    it('openai: the option reaches the transport and the session keeps its identity', async () => {
        await withBaseURLEnv({ fn: async () => {
            const { client } = await initializeClient({
                provider: ProviderType.OPENAI,
                options: { apiKey: 'k', baseURL: OPENAI_PROXY },
            });
            assert.equal(asAny(client).transport.baseURL, OPENAI_PROXY, 'transport.baseURL follows options.baseURL');
            const session = client.session('gpt-4.1');
            assert.equal(session.provider, ProviderType.OPENAI, 'session.provider');
            assert.equal(session.standard, StandardType.OAI, 'session.standard');
        } });
    });
});


describe('provider URL env keys', () => {
    it('ANTHROPIC_BASE_URL reaches loadCredentials() and the client built from it', async () => {
        await withBaseURLEnv({ assign: { [ANTHROPIC_ENV]: ANTHROPIC_PROXY }, fn: async () => {
            const credentials = loadCredentials({ provider: ProviderType.ANTHROPIC });
            assert.equal(credentials.baseURL, ANTHROPIC_PROXY, 'loadCredentials.baseURL');
            const { client } = await initializeClient({
                provider: ProviderType.ANTHROPIC,
                options: { ...credentials, apiKey: 'k' },
            });
            assert.equal(asAny(client).transport.baseURL, ANTHROPIC_PROXY, 'transport.baseURL follows the env key');
        } });
    });

    it('OPENAI_BASE_URL reaches loadCredentials() and the client built from it', async () => {
        await withBaseURLEnv({ assign: { [OPENAI_ENV]: OPENAI_PROXY }, fn: async () => {
            const credentials = loadCredentials({ provider: ProviderType.OPENAI });
            assert.equal(credentials.baseURL, OPENAI_PROXY, 'loadCredentials.baseURL');
            const { client } = await initializeClient({
                provider: ProviderType.OPENAI,
                options: { ...credentials, apiKey: 'k' },
            });
            assert.equal(asAny(client).transport.baseURL, OPENAI_PROXY, 'transport.baseURL follows the env key');
        } });
    });
});


describe('precedence', () => {
    it('an explicit options.baseURL beats the env key for both providers', async () => {
        await withBaseURLEnv({
            assign: {
                [ANTHROPIC_ENV]: 'https://env-anthropic.example/v1',
                [OPENAI_ENV]: 'https://env-openai.example/v1',
            },
            fn: async () => {
                const { client: anthropic } = await initializeClient({
                    provider: ProviderType.ANTHROPIC,
                    options: { apiKey: 'k', baseURL: ANTHROPIC_PROXY },
                });
                assert.equal(asAny(anthropic).transport.baseURL, ANTHROPIC_PROXY, 'anthropic: option wins over env');
                const { client: openai } = await initializeClient({
                    provider: ProviderType.OPENAI,
                    options: { apiKey: 'k', baseURL: OPENAI_PROXY },
                });
                assert.equal(asAny(openai).transport.baseURL, OPENAI_PROXY, 'openai: option wins over env');
            },
        });
    });

    it('with neither option nor env key, the descriptor default wins', async () => {
        await withBaseURLEnv({ fn: async () => {
            // Both providers now report the key even when the env var is unset.
            const anthropicCredentials = loadCredentials({ provider: ProviderType.ANTHROPIC });
            assert.ok('baseURL' in anthropicCredentials, 'anthropic: loadCredentials keeps the baseURL key');
            assert.equal(anthropicCredentials.baseURL, undefined, 'anthropic: unset env resolves to undefined');
            const openaiCredentials = loadCredentials({ provider: ProviderType.OPENAI });
            assert.ok('baseURL' in openaiCredentials, 'openai: loadCredentials keeps the baseURL key');
            assert.equal(openaiCredentials.baseURL, undefined, 'openai: unset env resolves to undefined');

            const { client: anthropic } = await initializeClient({
                provider: ProviderType.ANTHROPIC,
                options: { ...anthropicCredentials, apiKey: 'k' },
            });
            assert.equal(asAny(anthropic).transport.baseURL, ANTHROPIC_DEFAULT, 'anthropic: SDK default');
            const { client: openai } = await initializeClient({
                provider: ProviderType.OPENAI,
                options: { ...openaiCredentials, apiKey: 'k' },
            });
            assert.equal(asAny(openai).transport.baseURL, OPENAI_DEFAULT, 'openai: descriptor default');
        } });
    });
});


describe('nested anthropic options', () => {
    it('anthropicOptions is refused and points at baseURL and transportOptions', async () => {
        await withBaseURLEnv({ assign: { [ANTHROPIC_ENV]: 'https://env-anthropic.example/v1' }, fn: async () => {
            assert.throws(() => new AaiClient({
                options: { apiKey: 'k', baseURL: ANTHROPIC_PROXY, anthropicOptions: { baseURL: 'https://nested-proxy.example/v1' } },
            }), (/** @type {any} */ error) => {
                assert.ok(error instanceof ConfigurationError);
                assert.match(error.message, /anthropicOptions/);
                assert.match(error.message, /baseURL/);
                assert.match(error.message, /transportOptions/);
                return true;
            });
        } });
    });
});


describe('trailing slash', () => {
    it('a trailing slash on the option is preserved verbatim and never doubled', async () => {
        await withBaseURLEnv({ fn: async () => {
            const { client: anthropic } = await initializeClient({
                provider: ProviderType.ANTHROPIC,
                options: { apiKey: 'k', baseURL: `${ANTHROPIC_PROXY}/` },
            });
            assert.equal(asAny(anthropic).transport.baseURL, `${ANTHROPIC_PROXY}/`, 'anthropic: value kept as given');
            assert.equal(joinUrl({ baseURL: `${ANTHROPIC_PROXY}/`, path: '/messages' }), `${ANTHROPIC_PROXY}/messages`, 'anthropic: one slash on the request');

            const { client: openai } = await initializeClient({
                provider: ProviderType.OPENAI,
                options: { apiKey: 'k', baseURL: `${OPENAI_PROXY}/` },
            });
            assert.equal(asAny(openai).transport.baseURL, `${OPENAI_PROXY}/`, 'openai: value kept as given');
            assert.equal(joinUrl({ baseURL: `${OPENAI_PROXY}/`, path: '/chat/completions' }), `${OPENAI_PROXY}/chat/completions`, 'openai: one slash on the request');
        } });
    });
});


describe('env-only initializeClient', () => {
    it('openai: OPENAI_BASE_URL applies without {...credentials}', async () => {
        await withBaseURLEnv({ assign: { [OPENAI_ENV]: OPENAI_PROXY }, fn: async () => {
            const { client } = await initializeClient({ provider: ProviderType.OPENAI, options: { apiKey: 'k' } });
            assert.equal(asAny(client).transport.baseURL, OPENAI_PROXY, 'transport.baseURL follows OPENAI_BASE_URL');
        } });
    });

    it('anthropic: ANTHROPIC_BASE_URL applies without {...credentials}', async () => {
        await withBaseURLEnv({ assign: { [ANTHROPIC_ENV]: ANTHROPIC_PROXY }, fn: async () => {
            const { client } = await initializeClient({ provider: ProviderType.ANTHROPIC, options: { apiKey: 'k' } });
            assert.equal(asAny(client).transport.baseURL, ANTHROPIC_PROXY, 'transport.baseURL follows ANTHROPIC_BASE_URL');
        } });
    });
});


describe('direct client construction', () => {
    it('openai: the env key reaches a client built without initializeClient', async () => {
        await withBaseURLEnv({ assign: { [OPENAI_ENV]: OPENAI_PROXY }, fn: () => {
            const client = new OaiClient({ options: { apiKey: 'k' } });
            assert.equal(asAny(client).transport.baseURL, OPENAI_PROXY, 'direct OaiClient follows OPENAI_BASE_URL');
        } });
    });

    it('openai: a whitespace-padded env value is trimmed', async () => {
        await withBaseURLEnv({ assign: { [OPENAI_ENV]: `  ${OPENAI_PROXY}  ` }, fn: () => {
            const client = new OaiClient({ options: { apiKey: 'k' } });
            assert.equal(asAny(client).transport.baseURL, OPENAI_PROXY, 'direct OaiClient trims the env value');
        } });
    });

    it('openai: with no env the OpenAI default still applies', async () => {
        await withBaseURLEnv({ fn: () => {
            const client = new OaiClient({ options: { apiKey: 'k' } });
            assert.equal(asAny(client).transport.baseURL, OPENAI_DEFAULT, 'direct OaiClient keeps the descriptor default');
        } });
    });

    it('anthropic: the env key reaches a client built without initializeClient', async () => {
        await withBaseURLEnv({ assign: { [ANTHROPIC_ENV]: ANTHROPIC_PROXY }, fn: () => {
            const client = new AaiClient({ options: { apiKey: 'k' } });
            assert.equal(asAny(client).transport.baseURL, ANTHROPIC_PROXY, 'direct AaiClient follows ANTHROPIC_BASE_URL');
        } });
    });

    it('anthropic: a whitespace-padded env value is trimmed', async () => {
        await withBaseURLEnv({ assign: { [ANTHROPIC_ENV]: `  ${ANTHROPIC_PROXY}  ` }, fn: () => {
            const client = new AaiClient({ options: { apiKey: 'k' } });
            assert.equal(asAny(client).transport.baseURL, ANTHROPIC_PROXY, 'direct AaiClient trims the env value');
        } });
    });
});


describe('invalid explicit baseURL', () => {
    /** @type {Array<{label: string, value: unknown}>} */
    const BAD = [
        { label: 'a whitespace string', value: '   ' },
        { label: 'an empty string', value: '' },
        { label: 'a number', value: 42 },
    ];
    for (const { label, value } of BAD) {
        it(`anthropic: ${label} throws ConfigurationError`, async () => {
            await withBaseURLEnv({ fn: async () => {
                assert.throws(
                    () => new AaiClient({ options: { apiKey: 'k', baseURL: asAny(value) } }),
                    (error) => error instanceof ConfigurationError && /baseURL must be a non-empty URL string/.test(error.message),
                );
                await assert.rejects(
                    () => initializeClient({ provider: ProviderType.ANTHROPIC, options: { apiKey: 'k', baseURL: asAny(value) } }),
                    ConfigurationError,
                );
            } });
        });
        it(`openai: ${label} throws ConfigurationError`, async () => {
            await withBaseURLEnv({ fn: async () => {
                assert.throws(
                    () => new OaiClient({ options: { apiKey: 'k', baseURL: asAny(value) } }),
                    (error) => error instanceof ConfigurationError && /baseURL must be a non-empty URL string/.test(error.message),
                );
                await assert.rejects(
                    () => initializeClient({ provider: ProviderType.OPENAI, options: { apiKey: 'k', baseURL: asAny(value) } }),
                    ConfigurationError,
                );
            } });
        });
    }
});


describe('blank env values are ignored', () => {
    it('anthropic: a whitespace-only ANTHROPIC_BASE_URL falls back to the SDK default', async () => {
        await withBaseURLEnv({ assign: { [ANTHROPIC_ENV]: '   ' }, fn: async () => {
            const { client } = await initializeClient({ provider: ProviderType.ANTHROPIC, options: { apiKey: 'k' } });
            assert.equal(asAny(client).transport.baseURL, ANTHROPIC_DEFAULT, 'blank env is ignored');
        } });
    });

    it('openai: a whitespace-only OPENAI_BASE_URL falls back to the descriptor default', async () => {
        await withBaseURLEnv({ assign: { [OPENAI_ENV]: '   ' }, fn: async () => {
            const { client } = await initializeClient({ provider: ProviderType.OPENAI, options: { apiKey: 'k' } });
            assert.equal(asAny(client).transport.baseURL, OPENAI_DEFAULT, 'blank env is ignored');
        } });
    });
});


describe('blank env through loadCredentials', () => {
    /** @type {Array<{label: string, provider: string, envKey: string, apiKeyEnv: string, fallback: string}>} */
    const CASES = [
        { label: 'anthropic', provider: ProviderType.ANTHROPIC, envKey: ANTHROPIC_ENV, apiKeyEnv: 'ANTHROPIC_API_KEY', fallback: ANTHROPIC_DEFAULT },
        { label: 'openai', provider: ProviderType.OPENAI, envKey: OPENAI_ENV, apiKeyEnv: 'OPENAI_API_KEY', fallback: OPENAI_DEFAULT },
    ];
    for (const { label, provider, envKey, apiKeyEnv, fallback } of CASES) {
        for (const value of ['', '   ']) {
            it(`${label}: ${JSON.stringify(value)} resolves to undefined and the spread does not throw`, async () => {
                await withBaseURLEnv({ assign: { [envKey]: value, [apiKeyEnv]: 'k' }, fn: async () => {
                    const credentials = loadCredentials({ provider });
                    assert.ok('baseURL' in credentials, 'the baseURL key stays present');
                    assert.equal(credentials.baseURL, undefined, 'a blank env value is not returned raw');
                    const { client } = await initializeClient({ provider, options: { ...credentials } });
                    assert.equal(asAny(client).transport.baseURL, fallback, 'the descriptor/SDK default applies');
                } });
            });
        }
    }
});


describe('null baseURL means unset', () => {
    it('anthropic: initializeClient and direct construction keep the SDK default', async () => {
        await withBaseURLEnv({ fn: async () => {
            const { client } = await initializeClient({ provider: ProviderType.ANTHROPIC, options: { apiKey: 'k', baseURL: asAny(null) } });
            assert.equal(asAny(client).transport.baseURL, ANTHROPIC_DEFAULT, 'initializeClient: null is unset');
            const direct = new AaiClient({ options: { apiKey: 'k', baseURL: null } });
            assert.equal(asAny(direct).transport.baseURL, ANTHROPIC_DEFAULT, 'direct AaiClient: null is unset');
        } });
    });

    it('openai: initializeClient and direct construction keep the descriptor default', async () => {
        await withBaseURLEnv({ fn: async () => {
            const { client } = await initializeClient({ provider: ProviderType.OPENAI, options: { apiKey: 'k', baseURL: asAny(null) } });
            assert.equal(asAny(client).transport.baseURL, OPENAI_DEFAULT, 'initializeClient: null is unset');
            const direct = new OaiClient({ options: { apiKey: 'k', baseURL: null } });
            assert.equal(asAny(direct).transport.baseURL, OPENAI_DEFAULT, 'direct OaiClient: null is unset');
        } });
    });
});


describe('opencode tiers', () => {
    it('OPENCODE_TIER=zen with no URL yields the zen URL from both paths', async () => {
        await withBaseURLEnv({ assign: { [OPENCODE_TIER_ENV]: 'zen' }, fn: async () => {
            const credentials = loadCredentials({ provider: ProviderType.OPENCODE });
            assert.equal(credentials.baseURL, OPENCODE_ZEN, 'loadCredentials: zen tier');
            const { client: fromCredentials } = await initializeClient({ provider: ProviderType.OPENCODE, options: { ...credentials, apiKey: 'k' } });
            assert.equal(asAny(fromCredentials).transport.baseURL, OPENCODE_ZEN, 'initializeClient with credentials: zen tier');
            const { client: optionOnly } = await initializeClient({ provider: ProviderType.OPENCODE, options: { apiKey: 'k' } });
            assert.equal(asAny(optionOnly).transport.baseURL, OPENCODE_ZEN, 'initializeClient without credentials: zen tier');
        } });
    });

    it('OPENCODE_URL wins over the tier and a blank URL is ignored', async () => {
        await withBaseURLEnv({ assign: { [OPENCODE_TIER_ENV]: 'zen', [OPENCODE_URL_ENV]: OPENAI_PROXY }, fn: async () => {
            const credentials = loadCredentials({ provider: ProviderType.OPENCODE });
            assert.equal(credentials.baseURL, OPENAI_PROXY, 'loadCredentials: the env URL wins');
            const { client } = await initializeClient({ provider: ProviderType.OPENCODE, options: { ...credentials, apiKey: 'k' } });
            assert.equal(asAny(client).transport.baseURL, OPENAI_PROXY, 'initializeClient: the env URL wins');

            process.env[OPENCODE_URL_ENV] = '   ';
            const blank = loadCredentials({ provider: ProviderType.OPENCODE });
            assert.equal(blank.baseURL, OPENCODE_ZEN, 'blank URL falls back to the zen tier');
            const { client: blankClient } = await initializeClient({ provider: ProviderType.OPENCODE, options: { apiKey: 'k' } });
            assert.equal(asAny(blankClient).transport.baseURL, OPENCODE_ZEN, 'blank URL falls back to the zen tier in initializeClient');
        } });
    });
});


describe('OpenRouter key fallback', () => {
    it('a stray OPENAI_BASE_URL does not lose OPENROUTER_API_KEY on a no-provider client', async () => {
        await withBaseURLEnv({ assign: { [OPENROUTER_KEY_ENV]: 'or-key', [OPENAI_ENV]: OPENAI_PROXY }, fn: () => {
            const client = new OaiClient({ options: {} });
            assert.equal(asAny(client).transport.apiKey, 'or-key', 'the OpenRouter key is the last resort');
            assert.equal(asAny(client).transport.baseURL, OPENAI_PROXY, 'the URL precedence is unchanged');
        } });
    });

    it('the no-provider OpenRouter quirk is unchanged without a stray URL', async () => {
        await withBaseURLEnv({ assign: { [OPENROUTER_KEY_ENV]: 'or-key' }, fn: () => {
            const client = new OaiClient({ options: {} });
            assert.equal(asAny(client).transport.baseURL, OPENROUTER_DEFAULT, 'no-provider defaults to OpenRouter');
            assert.equal(asAny(client).transport.apiKey, 'or-key', 'the OpenRouter key is used');
        } });
    });
});


describe('invalid explicit baseURL for every OAI provider', () => {
    for (const provider of [ProviderType.OPENROUTER, ProviderType.LOCAL, ProviderType.OPENCODE]) {
        it(`${provider}: a whitespace string throws ConfigurationError`, async () => {
            await withBaseURLEnv({ fn: async () => {
                assert.throws(
                    () => new OaiClient({ options: { apiKey: 'k', provider, baseURL: '   ' } }),
                    (error) => error instanceof ConfigurationError && /baseURL must be a non-empty URL string/.test(error.message),
                );
                await assert.rejects(
                    () => initializeClient({ provider, options: { apiKey: 'k', baseURL: '   ' } }),
                    ConfigurationError,
                );
            } });
        });
    }
});
