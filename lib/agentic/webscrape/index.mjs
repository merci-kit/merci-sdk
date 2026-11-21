// @ts-check


/**
 * @file Web-scrape capability barrel.
 * @version 0.12.0
 * @description Re-exports the web-scrape component and engines.
 */
export { WebScrapeComponent } from './component.mjs';
export { TavilyExtractEngine, JaiScrapeEngine, CurlEngine, resolveScrapeMode, toUnifiedScrape } from './engines.mjs';