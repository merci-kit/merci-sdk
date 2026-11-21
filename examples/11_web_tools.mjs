// @ts-check
/**
 * Example 11 — Web tools: search, scrape, and the headless browser.
 *
 * Two sessions, one network story:
 *
 *   A — web search + web scrape : one session carries `.withWebSearch(...)` and
 *       `.withWebScrape(...)`. Each mode is read from an env var, validated by
 *       the SDK's `resolve*Mode` helpers, and the components' `EVENTS.WEB_SEARCH.*`
 *       / `EVENTS.WEB_SCRAPE.*` lifecycle is subscribed end-to-end. The scrape
 *       targets a REAL local HTTP server (loopback, no external egress).
 *   B — browser : a second session carries `.withBrowser(...)`; navigating the
 *       read leg fetches the same local server (`action` must be omitted —
 *       an explicit `action: "navigate"` switches to the Playwright/CDP
 *       interactive leg, which needs `obscura serve`).
 *
 * Both sessions opt into the `inject` date context: a `Today's date: …` line
 * (and optional instructions) is rendered into the capability's preload block
 * so the model can answer "today"-style questions.
 *
 * Env knobs: `EXAMPLE_WEB_SEARCH_MODE` (default `tavily`),
 * `EXAMPLE_WEB_SCRAPE_MODE` (default `curl`), `EXAMPLE_BROWSER_MODE`
 * (default `curl`). Tavily modes need `TAVILY_API_KEY`; a missing key surfaces
 * as `web_search:error` and a tool error — never a crash.
 *
 * Run: `node examples/11_web_tools.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`; a search key for
 * the default search mode.
 *
 * @version 0.23.0
 */
import {
    EVENTS, defaultDisplay, initializeClient, loadCredentials, log,
    resolveBrowserMode, resolveScrapeMode, resolveSearchMode,
} from 'merci-sdk';
import { startLocalApiServer } from './_shared/real-tools.mjs';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const SEARCH_MODE = process.env.EXAMPLE_WEB_SEARCH_MODE ?? 'tavily';
const SCRAPE_MODE = process.env.EXAMPLE_WEB_SCRAPE_MODE ?? 'curl';
const BROWSER_MODE = process.env.EXAMPLE_BROWSER_MODE ?? 'curl';

/** Opt-in context injection: the capability preload block gets a date line. */
const INJECT = { date: { format: 'iso' }, time: false, timezone: 'UTC' };

async function main() {
    const { provider, defaultModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    const searchLeg = resolveSearchMode({ sessionProvider: provider, mode: SEARCH_MODE });
    const scrapeLeg = resolveScrapeMode({ sessionProvider: provider, mode: SCRAPE_MODE });
    const browserLeg = resolveBrowserMode({ _sessionProvider: provider, mode: BROWSER_MODE });

    log.header({ t: `Example 11 — Web tools (${provider})` });
    log.option({ name: 'web.search', value: `${SEARCH_MODE} → ${searchLeg}`, source: 'EXAMPLE_WEB_SEARCH_MODE / resolveSearchMode' });
    log.option({ name: 'web.scrape', value: `${SCRAPE_MODE} → ${scrapeLeg}`, source: 'EXAMPLE_WEB_SCRAPE_MODE / resolveScrapeMode' });
    log.option({ name: 'browser', value: `${BROWSER_MODE} → ${browserLeg}`, source: 'EXAMPLE_BROWSER_MODE / resolveBrowserMode' });
    log.option({ name: 'inject', value: JSON.stringify(INJECT), source: 'opt-in date context rendered into the preload block' });

    const web = {
        search: { start: 0, ok: 0, err: 0 },
        scrape: { start: 0, ok: 0, err: 0 },
        browser: { start: 0, ok: 0, err: 0 },
    };
    client.on(EVENTS.WEB_SEARCH.SEARCH_START, (/** @type {any} */ e) => { web.search.start++; log.event({ type: EVENTS.WEB_SEARCH.SEARCH_START, payload: { query: e.query, mode: e.mode } }); });
    client.on(EVENTS.WEB_SEARCH.SEARCH_SUCCESS, (/** @type {any} */ e) => { web.search.ok++; log.event({ type: EVENTS.WEB_SEARCH.SEARCH_SUCCESS, payload: { query: e.query, sources: e.resultCount, ms: e.durationMs } }); });
    client.on(EVENTS.WEB_SEARCH.SEARCH_ERROR, (/** @type {any} */ e) => { web.search.err++; log.warn({ m: `${EVENTS.WEB_SEARCH.SEARCH_ERROR} — ${e.error}` }); });
    client.on(EVENTS.WEB_SCRAPE.SCRAPE_START, (/** @type {any} */ e) => { web.scrape.start++; log.event({ type: EVENTS.WEB_SCRAPE.SCRAPE_START, payload: { url: e.url, mode: e.mode } }); });
    client.on(EVENTS.WEB_SCRAPE.SCRAPE_SUCCESS, (/** @type {any} */ e) => { web.scrape.ok++; log.event({ type: EVENTS.WEB_SCRAPE.SCRAPE_SUCCESS, payload: { url: e.url, chars: e.chars, truncated: e.truncated, ms: e.durationMs } }); });
    client.on(EVENTS.WEB_SCRAPE.SCRAPE_ERROR, (/** @type {any} */ e) => { web.scrape.err++; log.warn({ m: `${EVENTS.WEB_SCRAPE.SCRAPE_ERROR} — ${e.error}` }); });
    client.on(EVENTS.BROWSER.NAVIGATE_START, (/** @type {any} */ e) => { web.browser.start++; log.event({ type: EVENTS.BROWSER.NAVIGATE_START, payload: { url: e.url, mode: e.mode } }); });
    client.on(EVENTS.BROWSER.NAVIGATE_SUCCESS, (/** @type {any} */ e) => { web.browser.ok++; log.event({ type: EVENTS.BROWSER.NAVIGATE_SUCCESS, payload: { url: e.url, chars: e.chars, error: e.error ?? null } }); });
    client.on(EVENTS.BROWSER.NAVIGATE_ERROR, (/** @type {any} */ e) => { web.browser.err++; log.warn({ m: `${EVENTS.BROWSER.NAVIGATE_ERROR} — ${e.error}` }); });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    const { baseUrl, close } = await startLocalApiServer();
    log.option({ name: 'local target', value: baseUrl, source: 'startLocalApiServer() — real bytes, loopback only' });

    try {
        // ── A: search + scrape in one session ────────────────────────────────
        log.section({ t: 'A — withWebSearch + withWebScrape' });
        const webSession = client.session(defaultModel)
            .withWebSearch({ options: { mode: SEARCH_MODE, maxResults: 3, inject: INJECT } })
            .withWebScrape({ options: { mode: SCRAPE_MODE, maxUrls: 1, format: 'text', timeoutMs: 15_000, allowPrivateNetwork: true, inject: INJECT } })
            .withSystemMessage('You have a `web_search` tool and a `web_scrape` tool. Use the tool named in the request. If a tool returns an error, report it verbatim instead of guessing.');

        if (searchLeg === 'tool') {
            log.user({ m: 'Use web_search for the latest release notes.' });
            const searchAnswer = String(await webSession.run({
                initialInput: 'Use the web_search tool to look up "release notes" and then report the title of the first source on one line.',
                options: defaultDisplay(),
            }));
            check({
                name: 'search: the remote call ran and surfaced success or error',
                ok: web.search.start >= 1 && (web.search.ok >= 1 || web.search.err >= 1),
                detail: `start=${web.search.start} ok=${web.search.ok} err=${web.search.err}`,
            });
            warnEmptyAnswer({ answer: searchAnswer, label: 'the search leg' });
        } else {
            log.condition({ label: 'web search', branch: searchLeg, why: 'handled outside the tool — no web_search events expected' });
        }

        if (scrapeLeg === 'tool') {
            const scrapeUrl = `${baseUrl}/legacy/inventory`;
            log.user({ m: `Scrape ${scrapeUrl} and report recordsAffected.` });
            const scrapeAnswer = String(await webSession.run({
                initialInput: `Use the web_scrape tool to fetch ${scrapeUrl} and report its "recordsAffected" value.`,
                options: defaultDisplay(),
            }));
            warnEmptyAnswer({ answer: scrapeAnswer, label: 'the scrape leg' });
            check({
                name: 'scrape: the local page was fetched',
                ok: web.scrape.start >= 1 && web.scrape.ok >= 1,
                detail: `start=${web.scrape.start} ok=${web.scrape.ok} err=${web.scrape.err}`,
            });
            check({ name: 'scrape: the answer reads the payload', ok: /\b42\b/.test(scrapeAnswer), detail: log.truncate({ text: scrapeAnswer, n: 120 }) });
        } else {
            log.condition({ label: 'web scrape', branch: scrapeLeg, why: 'handled outside the tool — no web_scrape events expected' });
        }

        // ── B: browser read leg in its own session ───────────────────────────
        log.section({ t: 'B — withBrowser (read leg)' });
        if (browserLeg === 'off') {
            log.condition({ label: 'browser', branch: browserLeg, why: 'mode off registers no browser tool' });
        } else {
            const browserSession = client.session(defaultModel)
                .withBrowser({ options: { mode: BROWSER_MODE, maxChars: 4000, timeoutMs: 15_000, allowPrivateNetwork: true, inject: INJECT } })
                .withSystemMessage('You have a `browser` tool. For this request call it with a `url` only — omitting `action` uses the read leg. Report what the page payload says.');
            const graphqlUrl = `${baseUrl}/graphql`;
            log.user({ m: `Navigate to ${graphqlUrl} and report the records value.` });
            const browserAnswer = String(await browserSession.run({
                initialInput: `Use the browser tool to navigate to ${graphqlUrl} (omit the action field) and report the "records" value found in the payload.`,
                options: defaultDisplay(),
            }));
            warnEmptyAnswer({ answer: browserAnswer, label: 'the browser leg' });
            check({
                name: 'browser: the page was fetched',
                ok: web.browser.start >= 1 && web.browser.ok >= 1,
                detail: `start=${web.browser.start} ok=${web.browser.ok} err=${web.browser.err}`,
            });
            check({ name: 'browser: the answer reads the payload', ok: /\b42\b/.test(browserAnswer), detail: log.truncate({ text: browserAnswer, n: 120 }) });
        }
    } finally {
        await close();
    }

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'Search, scrape and browser legs exercised.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
