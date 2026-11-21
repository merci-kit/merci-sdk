// @ts-check
/**
 * A-12: a `HEADER_TIMEOUT` retry re-sends the whole POST and no idempotency key
 * is sent. The provider guide must say so, or a caller learns it from a
 * duplicated request on the gateway.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DOC = readFileSync(new URL('../docs/PROVIDERS.md', import.meta.url), 'utf8');

/**
 * The body of the `###` section whose heading names timeouts.
 * @returns {string|null}
 */
function timeoutSection() {
    const lines = DOC.split('\n');
    const start = lines.findIndex((line) => /^###\s+.*timeout/i.test(line));
    if (start === -1) return null;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^#{1,3}\s/.test(line));
    return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

test('the timeout section names the double send', () => {
    const section = timeoutSection();
    assert.ok(section, 'docs/PROVIDERS.md has a section on timeouts');
    assert.match(section, /HEADER_TIMEOUT/, 'names the typed deadline error');
    assert.match(section, /re-?sends? the (whole )?POST/i, 'says the retry re-sends the POST');
    assert.match(section, /idempotency key/i, 'says no idempotency key is sent');
    assert.match(section, /maxRetries/, 'names the retry switch as the way to make a second send impossible');
    assert.doesNotMatch(section, /lower(ing)? the (request )?timeout/i, 'a shorter deadline makes a second send more likely, not safer');
});
