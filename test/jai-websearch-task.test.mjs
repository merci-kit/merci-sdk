// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { TaskAPI } from '../lib/backends/jai-vendor/api.mjs';

/**
 * @param {{lines: string[]}} arg0
 */
function sseStream({ lines }) {
    return new ReadableStream({
        start(c) {
            c.enqueue(new TextEncoder().encode(lines.join('\n')));
            c.close();
        }
    });
}

const CONTENT_JSON = JSON.stringify({
    answer: 'the answer',
    results: [{ title: 'T', url: 'https://example.com', content: 'body', publishedDate: '2026-01-01' }],
});

/**
 * @param {{lines: string[]}} arg0
 */
function cannedResponse({ lines }) {
    return { body: sseStream({ lines }) };
}

const HAPPY_LINES = [
    `data: ${JSON.stringify({ type: 'Content', content: CONTENT_JSON })}\n`,
    `data: ${JSON.stringify({ type: 'QuotaMetadata', spent: { amount: 0.05 }, updated: { license: 'demo' } })}\n`,
    'data: end\n',
];

test('executeJson web-search happy path: parses Content, captures quotaSpent', async () => {
    let seenPath = null;
    let seenOpts = /** @type {any} */ (null);
    const api = new TaskAPI({ httpClient: {
        streamTimeout: 150000,
        /** @param {{path: *, options: *}} arg0 */
        _fetchWithRetry: async ({ path, options }) => {
            seenPath = path;
            seenOpts = options;
            return cannedResponse({ lines: HAPPY_LINES });
        }
    } });
    const out = /** @type {Record<string, any>} */ (await api.executeJson({ taskId: 'web-search', parameters: { query: 'q', maxResults: 3, includeAnswer: 'advanced', includeDomains: ['https://a.com'] }, options: { version: 'v4' } }));
    assert.equal(seenPath, '/task/stream/v4/web-search');
    assert.equal(seenOpts.method, 'POST');
    assert.equal(out.answer, 'the answer');
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].title, 'T');
    assert.equal(out.results[0].url, 'https://example.com');
    assert.equal(out.results[0].content, 'body');
    assert.equal(out.results[0].publishedDate, '2026-01-01');
    assert.equal(out.quotaSpent, 0.05);
});

test('executeJson sends default parameters when absent', async () => {
    let seenBody = /** @type {any} */ (null);
    const api = new TaskAPI({ httpClient: {
        streamTimeout: 150000,
        /** @param {{options: *}} arg0 */
        _fetchWithRetry: async ({ options }) => {
            seenBody = JSON.parse(options.body);
            return cannedResponse({ lines: HAPPY_LINES });
        }
    } });
    await api.executeJson({ taskId: 'web-search', parameters: { query: 'q' } });
    assert.equal(seenBody.parameters.query, 'q');
    assert.equal(seenBody.parameters.maxResults, 5, 'maxResults defaults to 5');
    assert.equal(seenBody.parameters.includeAnswer, 'basic', 'includeAnswer defaults to basic');
    assert.deepEqual(seenBody.parameters.includeDomains, [], 'includeDomains defaults to []');
});

test('executeJson passes non-search task parameters through untouched', async () => {
    let seenBody = /** @type {any} */ (null);
    const api = new TaskAPI({ httpClient: {
        streamTimeout: 150000,
        /** @param {{options: *}} arg0 */
        _fetchWithRetry: async ({ options }) => {
            seenBody = JSON.parse(options.body);
            return cannedResponse({ lines: HAPPY_LINES });
        }
    } });
    await api.executeJson({ taskId: 'web-scrape', parameters: { url: 'https://example.com', maxChars: 500 } });
    assert.deepEqual(seenBody.parameters, { url: 'https://example.com', maxChars: 500 });
});

test('executeJson throws on an Error event', async () => {
    const lines = [`data: ${JSON.stringify({ type: 'Error', error_message: 'boom' })}\n`, 'data: end\n'];
    const api = new TaskAPI({ httpClient: {
        streamTimeout: 150000,
        _fetchWithRetry: async () => cannedResponse({ lines })
    } });
    await assert.rejects(
        () => api.executeJson({ taskId: 'web-search', parameters: { query: 'q' } }),
        /Task stream failed: boom/
    );
});

test('executeJson omits quotaSpent when no QuotaMetadata arrives', async () => {
    const api = new TaskAPI({ httpClient: {
        streamTimeout: 150000,
        _fetchWithRetry: async () => cannedResponse({ lines: [`data: ${JSON.stringify({ type: 'Content', content: CONTENT_JSON })}\n`, 'data: end\n'] })
    } });
    const out = await api.executeJson({ taskId: 'web-search', parameters: { query: 'q' } });
    assert.equal(out.quotaSpent, undefined);
    assert.equal(out.answer, 'the answer');
});