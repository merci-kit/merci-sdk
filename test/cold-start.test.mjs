// @ts-check
/**
 * Cold start: importing the SDK must not pull every backend, and the child-env
 * helper must not pull the MCP client. Both are load-time costs every consumer
 * pays even when it uses one backend and never spawns a child.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the entry point does not import the backends statically', () => {
    const source = readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
    const staticBackendImport = /^import\s[^;]*from\s+'\.\/backends\/(jai|oai|gai|aai)\.mjs'/m;
    assert.equal(staticBackendImport.test(source), false, 'initializeClient must import the chosen backend dynamically');
    assert.match(source, /await import\('\.\/backends\/oai\.mjs'\)/, 'the dynamic import is what remains');
});

test('the child-env helper does not pull the MCP client', () => {
    const source = readFileSync(new URL('../lib/support/child-env.mjs', import.meta.url), 'utf8');
    assert.equal(/^\s*import\s[^;]*from\s+'@modelcontextprotocol\//m.test(source), false, 'a static MCP import here reaches every provider');
    assert.equal(/import\('@modelcontextprotocol\//.test(source), false, 'not even a dynamic one');
});
