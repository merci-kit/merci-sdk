#!/usr/bin/env node
// @ts-check
/**
 * @file Opt-in live smoke for the agent-wiring features.
 * @version 0.7.2
 *
 * NOT part of `pnpm test` — it needs real credentials and is intentionally
 * excluded from the zero-skipped suite. Run it explicitly:
 *
 *   pnpm smoke:live
 *   MERCI_SMOKE_SECOND_PROVIDER=anthropic pnpm smoke:live
 *
 * It exits 0 with a "skipped" line when `secret.env` has no usable backend, so
 * it is safe to invoke in an environment without credentials. Pair it with the
 * offline suite, never a replacement for it.
 */
import { ProviderType, resolveProvider, initializeClient, loadCredentials, getDefaultModel, withTaskAgents } from '../lib/index.mjs';

async function main() {
    let provider;
    try {
        provider = resolveProvider();
    } catch {
        console.log('[live-smoke] skipped: no PROVIDER in secret.env');
        return;
    }

    /** @type {any} */
    let client;
    try {
        ({ client } = await initializeClient({ provider, options: loadCredentials({ provider }) }));
    } catch (err) {
        console.log(`[live-smoke] skipped: credentials unavailable (${(/** @type {any} */ (err))?.message ?? err})`);
        return;
    }

    const model = getDefaultModel({ provider });
    const session = client.session(model).withSystemMessage('Reply with exactly the two letters: OK');
    const text = String(await session.run({ initialInput: 'Ping.' }) ?? '').trim();
    if (!text) throw new Error('empty response');
    console.log(`[live-smoke] ok: ${provider} replied ${JSON.stringify(text.slice(0, 40))}`);

    // The Anthropic structured-output shape is the one assumption a unit test
    // cannot close: only a real API answers whether `output_config.format` is
    // accepted. Opt in on Anthropic (or explicitly on any backend).
    if (provider === ProviderType.ANTHROPIC || process.env.MERCI_SMOKE_JSON_SCHEMA === '1') {
        const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
        const structured = client.session(model)
            .withParameters({ params: (/** @type {any} */ b) => b.asJsonSchema({ config: { name: 'smoke', schema } }) });
        const raw = String(await structured.run({ initialInput: 'Return {"ok":true}.' }) ?? '');
        const parsed = JSON.parse(raw);
        if (parsed?.ok !== true) throw new Error(`output_config.format was not honored: ${raw.slice(0, 80)}`);
        console.log('[live-smoke] ok: output_config.format accepted');
    }

    const second = process.env.MERCI_SMOKE_SECOND_PROVIDER;
    if (second) {
        const { client: other } = await initializeClient({ provider: second, options: loadCredentials({ provider: second }) });
        withTaskAgents({ client, agents: [{ name: 'probe', model: getDefaultModel({ provider: second }), client: other }], options: { clients: /** @type {any} */ ({ [second]: other }) } });
        console.log(`[live-smoke] ok: second backend "${second}" registered as a task transport (profile "probe")`);
    }
}

main().catch((err) => {
    console.error(`[live-smoke] FAILED: ${(/** @type {any} */ (err))?.message ?? err}`);
    process.exitCode = 1;
});
