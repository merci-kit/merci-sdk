// @ts-check

/**
 * G1-4 / A-13 / G2-8 / G2-9 (2.14 review) — one redactor for every sink that can
 * print a value. A query, a credentialed URL and a secret inside text must not
 * survive into a span attribute, a pretty console line, an ambient log field or
 * a scrape/browser error message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOtlpExporter } from '../lib/support/otel-exporter.mjs';
import { Logger } from '../lib/support/logger.mjs';
import { redactUrl, scrubSecrets } from '../lib/support/redact.mjs';
import { joinUrl } from '../lib/backends/transport/http.mjs';
import { isSafeHttpUrl } from '../lib/agentic/web-shared.mjs';
import { CurlEngine } from '../lib/agentic/webscrape/engines.mjs';
import { ObscuraEngine, PlaywrightSession } from '../lib/agentic/browser/engines.mjs';

const QUERY = 'patient John Doe HIV test results';
const KEY = 'sk-live-ABCDEF123456';

/**
 * A logger that keeps its lines instead of printing them.
 * @param {{level?: string, format?: string}} [arg0]
 * @returns {{logger: Logger, lines: string[]}}
 */
function captureLogger({ level = 'debug', format } = {}) {
    /** @type {string[]} */
    const lines = [];
    const push = (/** @type {string} */ text) => { lines.push(text); };
    const logger = new Logger().configure({ level, colors: false, format, sink: { log: push, error: push, write: push } });
    return { logger, lines };
}

/**
 * A scrape result item's error text, as the caller receives it.
 * @param {{input: string, opts: Record<string, unknown>}} arg0
 * @returns {Promise<string>}
 */
async function curlError({ input, opts }) {
    const [item] = await CurlEngine.fetch({ input: [input], opts });
    return String(/** @type {any} */ (item).error ?? '');
}

// ==================================================================================
// W2E-4 — the pretty/sink path scrubs too
// ==================================================================================

test('pretty console output scrubs a secret in a tool arg or a styled line', () => {
    const { logger, lines } = captureLogger();
    logger.toolCall({ n: 'lookup', a: '{"api_key":"hunter2"}' });
    logger.toolResult({ n: 'lookup', r: 'token=result-secret', full: true });
    logger.success({ m: 'stored with Bearer tok_live_999' });

    const printed = lines.join('\n');
    for (const secret of ['hunter2', 'result-secret', 'tok_live_999']) {
        assert.equal(printed.includes(secret), false, `pretty output must not print ${secret}`);
    }
});

// ==================================================================================
// W2E-5 — scrape/browser messages never echo the URL's credential or query
// ==================================================================================

test('a credentialed or query-bearing scrape URL never reaches a scrape message', async () => {
    assert.equal(isSafeHttpUrl({ url: 'https://user:pw@example.com/' }), false, 'userinfo is not a safe URL');

    // The domain-policy message: the URL never reaches the network.
    const policy = await curlError({ input: 'https://user:URLPW-SECRET@127.0.0.1/page?api_key=QUERY-SECRET', opts: {} });
    assert.equal(policy.includes('URLPW-SECRET'), false, `policy message echoes the password: ${policy}`);
    assert.equal(policy.includes('QUERY-SECRET'), false, `policy message echoes the query: ${policy}`);
    assert.match(policy, /127\.0\.0\.1/, 'the host stays useful');

    // The redirect messages: the Location is attacker-controlled.
    const redirect = async (/** @type {string} */ location) => curlError({
        input: 'https://gw.example.com/page?api_key=QUERY-SECRET',
        opts: {
            allowPrivateNetwork: true,
            fetch: async () => ({ status: 302, headers: { get: (/** @type {string} */ name) => (name.toLowerCase() === 'location' ? location : null) } }),
        },
    });
    const credentialed = await redirect('https://user:URLPW-SECRET@other.example.com/x?api_key=QUERY-SECRET-2');
    assert.equal(credentialed.includes('URLPW-SECRET'), false, `redirect message echoes the password: ${credentialed}`);
    assert.equal(credentialed.includes('QUERY-SECRET'), false, `redirect message echoes the query: ${credentialed}`);
    assert.match(credentialed, /other\.example\.com/, 'the redirect host stays useful');

    const unparsable = await redirect('https://user:URLPW-SECRET-2@');
    assert.equal(unparsable.includes('URLPW-SECRET-2'), false, `unparsable Location echoes the secret: ${unparsable}`);

    // The browser engines' own policy message.
    const [browserItem] = await ObscuraEngine.fetch({ input: 'https://user:URLPW-SECRET@127.0.0.1/page?api_key=QUERY-SECRET', opts: { run: async () => 'content' } });
    const browser = String(/** @type {any} */ (browserItem).error ?? '');
    assert.equal(browser.includes('URLPW-SECRET'), false, `obscura message echoes the password: ${browser}`);
    assert.equal(browser.includes('QUERY-SECRET'), false, `obscura message echoes the query: ${browser}`);

    const page = new PlaywrightSession({ opts: {} });
    const playwright = await page._recycle({ url: 'https://user:URLPW-SECRET@127.0.0.1/page?api_key=QUERY-SECRET' })
        .then(() => '', (/** @type {any} */ err) => String(err?.message ?? err));
    assert.equal(playwright.includes('URLPW-SECRET'), false, `playwright message echoes the password: ${playwright}`);
    assert.equal(playwright.includes('QUERY-SECRET'), false, `playwright message echoes the query: ${playwright}`);
});

// ==================================================================================
// W2E-6 — the span allowlist carries no free text
// ==================================================================================

test('a search query, a reason and an error message never reach a span attribute', () => {
    const exporter = createOtlpExporter({ flushIntervalMs: 0, batchSize: 100, fetchImpl: async () => ({ ok: true, status: 200 }) });
    exporter.onEvent({ name: 'web_search:start', payload: { event: 'web_search:start', runId: 'r1', query: QUERY } });
    exporter.onEvent({ name: 'workflow:failed', payload: { event: 'workflow:failed', runId: 'r1', reason: QUERY } });

    const error = Object.assign(new Error(QUERY), { code: 'BACKEND_UNAVAILABLE', nonRetryable: true });
    exporter.onRequest({ meta: { model: 'm' }, runContext: /** @type {any} */ ({ runId: 'r9' }) });
    exporter.onError({ meta: { error }, runContext: /** @type {any} */ ({ runId: 'r9' }) });

    const spans = exporter.getSpans();
    const exported = JSON.stringify(spans);
    assert.equal(exported.includes('John Doe'), false, 'no free text is an attribute');
    assert.equal(exported.includes(KEY), false, 'no credential is an attribute');

    const failed = spans.find((s) => s.name === 'workflow:failed');
    const keys = (/** @type {any} */ (failed)).attributes.map((/** @type {any} */ a) => a.key);
    assert.deepEqual(keys, ['runId'], `a failure keeps its ids, not its text: ${keys.join(',')}`);

    const chat = spans.find((s) => s.name === 'chat m');
    const byKey = new Map((/** @type {any} */ (chat)).attributes.map((/** @type {any} */ a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.boolValue]));
    assert.equal(byKey.get('error.code'), 'BACKEND_UNAVAILABLE', 'the code keeps a failure diagnosable');
    assert.equal(byKey.get('error.permanent'), true, 'the permanence keeps it actionable');
    assert.equal(byKey.has('error.message'), false, 'the message stays out');
    assert.equal(byKey.get('gen_ai.operation.name'), 'chat', 'the semantic convention survives');
});

// ==================================================================================
// G1-4 — a user/model-controlled `name` is never exported as an attribute
// ==================================================================================

test('G1-4: an artifact filename never becomes a span attribute', () => {
    const exporter = createOtlpExporter({ flushIntervalMs: 0, batchSize: 100, fetchImpl: async () => ({ ok: true, status: 200 }) });
    exporter.onEvent({ name: 'artifact:saved', payload: { event: 'artifact:saved', runId: 'r1', name: 'patient-john-doe-hiv-report.md' } });

    const span = exporter.getSpans().find((s) => s.name === 'artifact:saved');
    assert.ok(span, 'the artifact event still becomes a span');
    const keys = (/** @type {any} */ (span)).attributes.map((/** @type {any} */ a) => a.key);
    assert.equal(keys.includes('name'), false, `the filename is not an attribute: ${keys.join(',')}`);
    assert.equal(JSON.stringify(span).includes('patient-john-doe'), false, 'the filename never reaches the wire');
});

test('G1-4: a technical tool name is still exported, a path-like one is not', () => {
    const exporter = createOtlpExporter({ flushIntervalMs: 0, batchSize: 100, fetchImpl: async () => ({ ok: true, status: 200 }) });
    exporter.onEvent({ name: 'run:start', payload: { event: 'run:start', runId: 'r2' } });
    exporter.onEvent({ name: 'tool:call_start', payload: { event: 'tool:call_start', runId: 'r2', id: 'c1', name: 'read_file' } });
    exporter.onEvent({ name: 'tool:call_start', payload: { event: 'tool:call_start', runId: 'r2', id: 'c2', name: '../../etc/passwd' } });
    exporter.onEvent({ name: 'run:end', payload: { event: 'run:end', runId: 'r2' } });

    const spans = exporter.getSpans();
    const readFile = /** @type {any} */ (spans.find((s) => s.name === 'execute_tool read_file'));
    assert.equal(readFile.attributes.find((/** @type {any} */ a) => a.key === 'name')?.value.stringValue, 'read_file');
    // The span NAME is gated too: a path-shaped tool name cannot ride out in it.
    const traversal = /** @type {any} */ (spans.find((s) => s.name === 'execute_tool'));
    assert.equal(traversal.attributes.some((/** @type {any} */ a) => a.key === 'name'), false, 'a path-shaped name is dropped');
    assert.equal(traversal.attributes.some((/** @type {any} */ a) => a.key === 'gen_ai.tool.name'), false, 'and so is the gen_ai copy');
});

test('G1-4: an error reason carrying a secret is still scrubbed', () => {
    const exporter = createOtlpExporter({ flushIntervalMs: 0, batchSize: 100, fetchImpl: async () => ({ ok: true, status: 200 }) });
    exporter.onEvent({ name: 'workflow:failed', payload: { event: 'workflow:failed', runId: 'r3', reason: `401 for key=${KEY}` } });
    const exported = JSON.stringify(exporter.getSpans());
    assert.equal(exported.includes(KEY), false, 'the secret is not exported');
    assert.equal(exported.includes('"reason"'), false, 'the free-text key stays out');
});

// ==================================================================================
// W2E-7 — ambient fields are redacted when configured
// ==================================================================================

test('ambient logger fields are redacted at configure time and on update', () => {
    const { logger, lines } = captureLogger({ format: 'json' });
    logger.configure({ fields: { api_key: 'hunter2', note: 'cached Bearer tok_live_999' } });
    logger.info({ m: 'hello' });
    logger.configure({ fields: { token: 'abc123' } });
    logger.info({ m: 'again' });

    const logged = lines.join('\n');
    for (const secret of ['hunter2', 'tok_live_999', 'abc123']) {
        assert.equal(logged.includes(secret), false, `context must not carry ${secret}`);
    }
    assert.equal(logged.includes('"api_key":"[REDACTED]"'), true, `the field name survives: ${logged}`);
});

// ==================================================================================
// W2E-8 — the pair rule leaves prose alone; key material and PEM are redacted
// ==================================================================================

test('the pair rule leaves prose alone and redacts key material and PEM blocks', () => {
    const prose = 'the key = the answer, and key: value pairs';
    assert.equal(scrubSecrets({ text: prose }), prose, 'prose is not a key/value pair');

    for (const text of ['private_key=MIIEabc123', 'client_secret=s3cr3t', 'db_password=hunter2', 'API_KEY=abc123', 'token=abc123']) {
        const scrubbed = scrubSecrets({ text });
        assert.equal(scrubbed.includes(text.split('=')[1]), false, `${text} must be scrubbed`);
        assert.equal(scrubSecrets({ text: scrubbed }), scrubbed, `${text} must be idempotent`);
    }

    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const pemOnce = scrubSecrets({ text: `before\n${pem}\nafter` });
    assert.equal(pemOnce.includes('MIIEowIBAAKCAQEA'), false, 'a PEM block is redacted');
    assert.match(pemOnce, /^before\n\[REDACTED PRIVATE KEY\]\nafter$/, `the surrounding text survives: ${pemOnce}`);
    assert.equal(scrubSecrets({ text: pemOnce }), pemOnce, 'PEM redaction is idempotent');

    const json = '{"api_key":"hunter2"}';
    const jsonOnce = scrubSecrets({ text: json });
    assert.equal(jsonOnce.includes('hunter2'), false);
    assert.equal(scrubSecrets({ text: jsonOnce }), jsonOnce, 'the JSON pair form is idempotent');

    assert.equal(redactUrl({ url: 'https://user:pw@gw.example.com:8443/v1?key=x' }), 'https://gw.example.com:8443');
    assert.equal(redactUrl({ url: 'not a url' }), '[invalid-url]');
});

// ==================================================================================
// A-13 — joinUrl errors
// ==================================================================================

test('a credentialed or unparsable base URL never appears in a joinUrl error', () => {
    assert.throws(() => joinUrl({ baseURL: `https://svc:${KEY}@gw.example.com/v1`, path: '/models' }), (/** @type {any} */ error) => {
        assert.equal(String(error.message).includes(KEY), false, 'the password is not echoed');
        assert.equal(String(error.message).includes('svc:'), false, 'the userinfo is not echoed');
        assert.match(String(error.message), /gw\.example\.com/, 'the host stays useful');
        return true;
    });
    assert.throws(() => joinUrl({ baseURL: `gw.internal/v1?key=${KEY}`, path: '/models' }), (/** @type {any} */ error) => {
        assert.equal(String(error.message).includes(KEY), false, 'an unparsable base URL does not echo its query');
        return true;
    });
});
