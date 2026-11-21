// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildMatrix, renderMatrix } from '../scripts/build-matrix.mjs';

const DOC = readFileSync(new URL('../docs/capability_matrix.html', import.meta.url), 'utf8');

describe('capability matrix', () => {
    it('the committed doc is current (regenerate-and-compare)', () => {
        assert.equal(DOC, renderMatrix());
    });

    it('names every capability with its tools and native legs', () => {
        const rows = buildMatrix();
        const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
        assert.match(byId.web_search.nativeProviders, /openai/);
        assert.doesNotMatch(byId.web_search.nativeProviders, /jai/);
        assert.match(byId.web_scrape.nativeProviders, /jai/);
        assert.doesNotMatch(byId.web_scrape.nativeProviders, /openai/);
        assert.equal(byId.browser.nativeProviders, '(none)');
        assert.equal(byId.memory.loadTool, 'load_memory');
        assert.equal(byId.memory.saveTool, 'save_memory');
        assert.ok(rows.length >= 9);
    });
});
