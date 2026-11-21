// @ts-check
/**
 * The SDK's advertised version comes from package.json, not a literal.
 *
 * A hard-coded version drifts on every release, and the failure is silent:
 * nothing else asserts the SDK's own version. The source guard also catches a
 * literal creeping back into one of the six runtime sites.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SDK_VERSION } from '../lib/core/constants/index.mjs';
import { ACP_AGENT_VERSION } from '../lib/agentic/acp-agent.mjs';
import { createA2AServer } from '../lib/tools/a2a-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** The six runtime files that must not carry a quoted semver literal. */
const VERSION_SITES = [
    'lib/core/constants/sdk.mjs',
    'lib/support/otel-exporter.mjs',
    'lib/tools/mcp-client.mjs',
    'lib/tools/mcp-server.mjs',
    'lib/tools/a2a-server.mjs',
    'lib/agentic/acp-agent.mjs',
];

/** @param {string} source @returns {string} */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('SDK_VERSION is derived from package.json', () => {
    assert.equal(SDK_VERSION, pkg.version);
});

test('ACP_AGENT_VERSION follows the SDK version', () => {
    assert.equal(ACP_AGENT_VERSION, pkg.version);
});

test('the A2A agent card advertises the SDK version', () => {
    const server = createA2AServer({ skills: [] });
    assert.equal(server.agentCard().version, pkg.version);
});

test('no runtime version literal remains at the six sites', () => {
    for (const rel of VERSION_SITES) {
        const source = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
        assert.doesNotMatch(source, /['"]\d+\.\d+\.\d+['"]/, `${rel} must import SDK_VERSION, not a literal`);
    }
});
