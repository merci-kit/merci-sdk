// @ts-check
/**
 * Example 01 — Quickstart: init, stream, system message.
 *
 * The smallest correct Merci program: resolve the backend from `secret.env`,
 * build the client, wrap a model in a session with a system message, and stream
 * one turn. It then runs the SAME prompt under two system messages to show that
 * a fresh session keeps histories independent, and reports real token usage.
 *
 * Public API: `resolveProvider`/`initializeClient`/`loadCredentials`,
 * `client.session(model).withSystemMessage(...)`, `session.step({ messages })`,
 * `createUserMessage`.
 *
 * Run: `node examples/01_quickstart.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { createUserMessage, getAvailableModels, loadCredentials, initializeClient, log } from 'merci-sdk';
import { resolveExample, wireClient, trackUsage, reportUsage, runMain, warnEmptyAnswer } from './_shared/example-utils.mjs';

const PROMPT = "Write a one-sentence tagline for a coffee brand called 'Stardust Brew'.";

const PERSONAS = [
    { name: 'concise assistant', system: 'You are a helpful assistant. Answer in one short sentence.' },
    { name: 'haiku poet', system: 'You are a haiku poet. Answer only with a haiku (three lines).' },
];

async function main() {
    const { provider, defaultModel } = resolveExample();

    log.header({ t: `Example 01 — Quickstart (${provider})` });
    log.option({ name: 'provider', value: provider, source: 'resolveProvider()' });
    log.option({ name: 'model', value: defaultModel || '(empty)', source: 'getDefaultModel({ backend })' });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    const models = await getAvailableModels({ client, provider });
    if (models.length) log.list({ title: 'available models', items: models.map((m) => m.id) });

    log.user({ m: PROMPT });
    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks += 1;
        if (!ok) failures += 1;
        log.check({ name, passed: ok, detail });
    };
    const answers = [];
    for (const persona of PERSONAS) {
        const session = client.session(defaultModel).withSystemMessage(persona.system);
        const gen = session.step({ messages: [createUserMessage({ provider, content: PROMPT })] });

        log.info({ m: `persona: ${persona.name}` });
        let text = '';
        let labeled = false;
        let result = await gen.next();
        while (!result.done) {
            const ev = result.value;
            if (ev.type === 'text') {
                const chunk = String(ev.content ?? '');
                if (!labeled && chunk) { log.assistant({ m: '', isStreaming: true }); labeled = true; }
                process.stdout.write(chunk); text += chunk;
            }
            result = await gen.next();
        }
        if (labeled) process.stdout.write('\n');
        warnEmptyAnswer({ answer: text, label: `persona "${persona.name}"` });

        const finalState = result.value ?? {};
        answers.push({ persona: persona.name, text: text.trim(), history: (finalState.messages ?? []).length });
        log.info({ m: `history: ${answers.at(-1)?.history ?? 0} message(s)` });
        check({
            name: `[${persona.name}] the streamed turn answered and the session kept its own history`,
            ok: text.trim().length > 0 && (answers.at(-1)?.history ?? 0) >= 2,
            detail: `${text.trim().length} chars · ${answers.at(-1)?.history ?? 0} message(s)`,
        });
    }
    // Two independent sessions, one prompt: neither inherited the other's turn.
    check({
        name: 'the two personas answered differently, from their own history',
        ok: answers.length === 2 && answers[0].text !== answers[1].text,
        detail: answers.map((a) => `${a.persona}=${log.truncate({ text: a.text, n: 60 })}`).join(' | '),
    });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'Done.' });
    else throw new Error(`${failures}/${checks} check(s) failed — inspect the log above.`);
}

runMain({ mainFn: main });
