// @ts-check
/**
 * The facts the `docs/PROVIDERS.md` caveats and the S-11…S-18 rows of
 * `specs/providers/ANALYSIS.md` rest on, asserted against the pinned documents,
 * the recorded wire fixtures and — when it is installed — the vendor SDK, no
 * network. A refresh that moves any of them fails here before the prose goes
 * stale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';

const ANTHROPIC_DTS = new URL('../node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts', import.meta.url);
const AAI_REQUEST_FIXTURE = new URL('./fixtures/aai-parity/messages-request-headers.json', import.meta.url);

/** @param {string} name @returns {any} */
const discovery = (name) => JSON.parse(readFileSync(new URL(`../specs/providers/raw/${name}`, import.meta.url), 'utf8'));

/** @param {string} name @returns {any} */
const discoveryGz = (name) => JSON.parse(gunzipSync(readFileSync(new URL(`../specs/providers/raw/${name}`, import.meta.url))).toString());

test('spec snapshot: Vertex v1beta1 defines publishers.models.list, Vertex v1 does not (S-16)', () => {
    const v1beta1 = discoveryGz('vertex.v1beta1.discovery.json.gz');
    const list = v1beta1.resources?.publishers?.resources?.models?.methods?.list;
    assert.ok(list, 'aiplatform.publishers.models.list exists in v1beta1');
    assert.equal(list.flatPath, 'v1beta1/publishers/{publishersId}/models');

    const v1 = discoveryGz('vertex.v1.discovery.json.gz');
    assert.equal(v1.resources?.publishers?.resources?.models?.methods?.list, undefined, 'Vertex v1 has no list method');
});

test('spec snapshot: cachedContent is on Gemini v1beta, absent from Gemini v1 (S-17)', () => {
    const v1beta = discovery('gemini.v1beta.discovery.json');
    const v1 = discovery('gemini.v1.discovery.json');
    assert.ok(v1beta.schemas.GenerateContentRequest.properties.cachedContent, 'v1beta GenerateContentRequest carries cachedContent');
    assert.equal(v1.schemas.GenerateContentRequest.properties.cachedContent, undefined, 'v1 GenerateContentRequest does not');
});

test('spec snapshot: the Gemini enums carry the eight refusal reasons and IMAGE_OTHER (S-18)', () => {
    const beta = discovery('gemini.v1beta.discovery.json');
    const finish = new Set(beta.schemas.Candidate.properties.finishReason.enum);
    for (const reason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION']) {
        assert.ok(finish.has(reason), `${reason} is a finish reason`);
    }
    assert.ok(finish.has('IMAGE_OTHER'), 'IMAGE_OTHER exists and is not a refusal');

    const block = new Set(beta.schemas.PromptFeedback.properties.blockReason.enum);
    for (const reason of ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY']) {
        assert.ok(block.has(reason), `${reason} is a block reason`);
    }
    assert.ok(block.has('OTHER'), 'OTHER exists and is not a refusal');
});

test('recorded wire: thinking, output_config and the server tools are GA shapes (S-13)', () => {
    // The recorded body and headers of one request the GA (non-beta) surface of
    // `@anthropic-ai/sdk@1.5.0` sent to a loopback server: the wire evidence that
    // each shape is accepted without an `anthropic-beta` header. This half runs
    // with or without the vendor package installed.
    const fixture = JSON.parse(readFileSync(AAI_REQUEST_FIXTURE, 'utf8'));
    const wire = JSON.parse(fixture.request[0].body);
    assert.ok(wire.thinking, 'thinking travels on the non-beta messages surface');
    assert.ok(wire.output_config, 'output_config travels on the non-beta messages surface');
    /** @type {Array<any>} */
    const tools = wire.tools;
    const toolTypes = tools.map((tool) => tool.type);
    assert.ok(toolTypes.includes('web_search_20260209'), 'the web-search server tool is a GA shape');
    assert.ok(toolTypes.includes('web_fetch_20260209'), 'the web-fetch server tool is a GA shape');
    assert.equal(
        Object.keys(fixture.request[0].headers).some((name) => name.toLowerCase() === 'anthropic-beta'),
        false,
        'none of those shapes needed a beta opt-in header',
    );

    // The installed parameters interface says the same thing; asserted only
    // while the package is on disk, since it leaves the dependency tree.
    if (!existsSync(ANTHROPIC_DTS)) return;
    const dts = readFileSync(ANTHROPIC_DTS, 'utf8');
    const start = dts.indexOf('export interface MessageCreateParamsBase');
    assert.ok(start > 0, 'the non-beta params interface exists (not resources/beta/)');
    const body = dts.slice(start, dts.indexOf('\nexport ', start + 40));
    assert.match(body, /\n {4}thinking\?:/, 'thinking is declared without a beta import');
    assert.match(body, /\n {4}output_config\?:/);
    // `tools` is typed through ToolUnion, which carries the server tools. The
    // version suffixes move between SDK minors, so only the family is pinned.
    assert.match(body, /\n {4}tools\?: Array<ToolUnion>/);
    const toolUnion = dts.slice(dts.indexOf('export type ToolUnion = '), dts.indexOf('\n', dts.indexOf('export type ToolUnion = ')));
    assert.match(toolUnion, /WebSearchTool\d+/, 'the union carries a versioned web-search server tool');
    assert.match(toolUnion, /WebFetchTool\d+/, 'and a versioned web-fetch server tool');
    // The one field that does name a beta header, which this SDK never sends.
    assert.match(dts, /fast-mode-\d{4}-\d{2}-\d{2}/, 'speed is the only beta-gated field');
});
