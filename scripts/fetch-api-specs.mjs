#!/usr/bin/env node
// @ts-check
/**
 * @file Provider API-spec snapshot fetcher.
 * @version 0.21.1
 *
 * @description
 * Downloads the machine-readable API description for every provider the SDK
 * targets, stores it under `specs/providers/`, and writes a manifest with the
 * source URL, HTTP status, byte counts and SHA-256 for both the wire bytes and
 * the stored artifact. Snapshots live in git so conformance analysis and tests
 * are reproducible offline; this script is the only thing that talks to the
 * network.
 *
 * Storage: files above `GZIP_THRESHOLD` are gzipped (deterministic level, no
 * mtime) to keep the repository small; smaller ones are stored verbatim.
 *
 * Run: `node scripts/fetch-api-specs.mjs`          (refresh)
 *      `node scripts/fetch-api-specs.mjs --verify` (offline hash check)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SPEC_ROOT = join(ROOT, 'specs', 'providers');
const RAW_DIR = join(SPEC_ROOT, 'raw');
const MANIFEST = join(SPEC_ROOT, 'manifest.json');
const GZIP_THRESHOLD = 512 * 1024;

/**
 * Every snapshot the SDK's conformance work relies on.
 * `id` is the stored basename; `format` describes the payload.
 * @type {Array<{id: string, provider: string, url: string, format: string, note: string}>}
 */
const SOURCES = [
    { id: 'openai.openapi.yaml', provider: 'openai', url: 'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml', format: 'openapi-3.1-yaml', note: 'Official OpenAI OpenAPI repository.' },
    { id: 'openrouter.openapi.json', provider: 'openrouter', url: 'https://openrouter.ai/openapi.json', format: 'openapi-json', note: 'OpenRouter publishes its OpenAPI document at the site root.' },
    { id: 'gemini.v1.discovery.json', provider: 'google_genai', url: 'https://generativelanguage.googleapis.com/$discovery/rest?version=v1', format: 'google-discovery-json', note: 'Gemini API Discovery document, v1.' },
    { id: 'gemini.v1beta.discovery.json', provider: 'google_genai', url: 'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta', format: 'google-discovery-json', note: 'Gemini API Discovery document, v1beta (newer surfaces).' },
    { id: 'vertex.v1.discovery.json', provider: 'vertex', url: 'https://aiplatform.googleapis.com/$discovery/rest?version=v1', format: 'google-discovery-json', note: 'Vertex AI Discovery document, v1.' },
    { id: 'vertex.v1beta1.discovery.json', provider: 'vertex', url: 'https://aiplatform.googleapis.com/$discovery/rest?version=v1beta1', format: 'google-discovery-json', note: 'Vertex AI Discovery document, v1beta1.' },
    { id: 'anthropic.openapi.json', provider: 'anthropic', url: 'https://raw.githubusercontent.com/laszukdawid/anthropic-openapi-spec/main/hosted_spec.json', format: 'openapi-json-unofficial', note: 'Community spec extracted from the official Anthropic SDK types; Anthropic hosts no standalone OpenAPI document. Treat as advisory.' },
    { id: 'opencode.openapi.json', provider: 'opencode', url: 'https://opencode.ai/openapi.json', format: 'openapi-3.1-json', note: 'Server management API (session, model, mcp, pty routes). It is orthogonal to the OpenAI-compatible inference surface this SDK calls; a running instance serves the same server schema at /doc.' },
];

/**
 * @param {{bytes: Buffer}} arg0
 * @returns {string} Hex SHA-256.
 */
function sha256({ bytes }) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {{url: string}} arg0
 * @returns {Promise<Buffer>}
 */
async function download({ url }) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return Buffer.from(await response.arrayBuffer());
}

/**
 * @param {{id: string}} arg0
 * @returns {{stored: string, bytes: Buffer, payload: Buffer}|null} The stored
 *   artifact, its decoded bytes and the raw file payload the hash covers.
 */
function readStored({ id }) {
    const gz = join(RAW_DIR, `${id}.gz`);
    const plain = join(RAW_DIR, id);
    if (existsSync(gz)) {
        const payload = readFileSync(gz);
        return { stored: `${id}.gz`, bytes: gunzipSync(payload), payload };
    }
    if (existsSync(plain)) {
        const payload = readFileSync(plain);
        return { stored: id, bytes: payload, payload };
    }
    return null;
}

/**
 * Refreshes every snapshot and the manifest.
 * @returns {Promise<void>}
 */
async function refresh() {
    mkdirSync(RAW_DIR, { recursive: true });
    /** @type {Array<Record<string, unknown>>} */
    const entries = [];
    for (const source of SOURCES) {
        const bytes = await download({ url: source.url });
        const rawHash = sha256({ bytes });
        const stored = bytes.length > GZIP_THRESHOLD;
        const name = stored ? `${source.id}.gz` : source.id;
        const payload = stored ? gzipSync(bytes, { level: 9 }) : bytes;
        writeFileSync(join(RAW_DIR, name), payload);
        entries.push({
            id: source.id,
            provider: source.provider,
            url: source.url,
            format: source.format,
            note: source.note,
            stored: `raw/${name}`,
            storedBytes: payload.length,
            rawBytes: bytes.length,
            rawSha256: rawHash,
            storedSha256: sha256({ bytes: payload }),
        });
        process.stderr.write(`saved ${name} (${bytes.length} bytes, sha256 ${rawHash.slice(0, 12)})\n`);
    }
    const manifest = {
        $comment: 'Vendor API-description snapshots. Refresh with node scripts/fetch-api-specs.mjs; verify offline with --verify. Vendor documents remain subject to their own terms; they are stored for internal conformance work only.',
        fetchedAt: new Date().toISOString(),
        entries: entries.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    };
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stderr.write(`wrote ${MANIFEST}\n`);
}

/**
 * Verifies the stored artifacts against the manifest without network access.
 * Fails when a file is missing, gzipped unexpectedly, or has a different hash.
 * @returns {void}
 */
function verify() {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    /** @type {Array<string>} */
    const problems = [];
    for (const entry of manifest.entries) {
        /** @type {{stored: string, bytes: Buffer, payload: Buffer}|null} */
        let artifact;
        try {
            artifact = readStored({ id: entry.id });
        } catch (error) {
            problems.push(`unreadable: ${entry.id} (${error instanceof Error ? error.message : String(error)})`);
            continue;
        }
        if (!artifact) {
            problems.push(`missing: ${entry.id}`);
            continue;
        }
        if (artifact.stored !== String(entry.stored).replace(/^raw\//, '')) {
            problems.push(`storage mismatch: ${entry.id} is ${artifact.stored}, manifest says ${entry.stored}`);
            continue;
        }
        if (sha256({ bytes: artifact.payload }) !== entry.storedSha256) problems.push(`stored hash mismatch: ${entry.id}`);
        if (sha256({ bytes: artifact.bytes }) !== entry.rawSha256) problems.push(`hash mismatch: ${entry.id}`);
    }
    if (problems.length > 0) {
        for (const problem of problems) process.stderr.write(`specs: ${problem}\n`);
        process.exit(1);
    }
    process.stderr.write(`specs: ${manifest.entries.length} snapshot(s) verified\n`);
}

if (process.argv.includes('--verify')) verify();
else await refresh();
