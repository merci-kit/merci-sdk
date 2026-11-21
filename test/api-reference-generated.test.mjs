// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateApiReference, splitGeneratedBlock } from '../scripts/build-api-reference.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_FILE = join(ROOT, 'docs', 'api_reference.html');
const DOC = readFileSync(DOC_FILE, 'utf8');
const HAS_TYPES = existsSync(join(ROOT, 'dist', 'types', 'lib', 'index.d.mts'));
const SKIP = HAS_TYPES
    ? false
    : 'dist/types is missing — run `pnpm run build:types` first (the declarations are the source of truth)';

const BLOCK = splitGeneratedBlock({ document: DOC }).block;

/**
 * The published declaration of `run()` must accept a streamed input. The
 * implementation has routed an async iterable to `_runStreamed` since the
 * agentic-capability wave, but the declaration said `string | Array<Object>`
 * — so the streaming input mode was unusable from TypeScript. Nothing else in
 * the repo can catch that: `initializeClient` types the client as
 * `Record<string, any>`, so an example's `session.run(...)` is `any` and the
 * repo's own type gate never sees it.
 * @returns {void}
 */
function theRunDeclarationAcceptsAStreamedInput() {
    const file = join(ROOT, 'dist', 'types', 'lib', 'agentic', 'chat-session-builder.d.mts');
    if (!existsSync(file)) return; // the declarations are built by `pnpm run build:types`
    const declaration = readFileSync(file, 'utf8');
    const runSignature = declaration.match(/run\(\{ initialInput[^}]*\}[\s\S]{0,200}?\): Promise<string>;/);
    assert.ok(runSignature, 'the run() declaration must be in the published types');
    assert.match(
        runSignature[0],
        /AsyncIterable/,
        'run({ initialInput }) must accept an AsyncIterable in the published types'
    );
}


/**
 * The name list the docs-exports gate parses: the first div after the
 * `Every named export of` heading, split on commas.
 * @returns {string[]}
 */
function documentedExportNames() {
    const card = BLOCK.match(/Every named export of[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/);
    assert.ok(card, 'the generated block must keep the `Every named export of` heading and its name list');
    return [...card[1].matchAll(/<code class="inline">([^<]+)<\/code>/g)].map((m) => m[1].trim()).filter(Boolean);
}

describe('docs/api_reference.html is generated from the declarations', () => {
    it('the committed block matches what the generator produces', { skip: SKIP }, () => {
        const { block } = generateApiReference({ root: ROOT });
        assert.equal(
            BLOCK,
            block,
            'docs/api_reference.html is stale — run `node scripts/build-api-reference.mjs`',
        );
    });

    it('the generated block is deterministic', { skip: SKIP }, () => {
        const first = generateApiReference({ root: ROOT }).block;
        const second = generateApiReference({ root: ROOT }).block;
        assert.equal(first, second, 'two runs must produce byte-identical output');
    });

    it('the name list is non-empty and free of markup', () => {
        const names = documentedExportNames();
        assert.ok(names.length >= 50, `expected the export list, found ${names.length}`);
        for (const name of names) {
            assert.match(name, /^[A-Za-z_$][\w$]*$/, `name "${name}" must be a bare export name`);
        }
    });

    it('the name list holds no markup inside the names', () => {
        for (const name of documentedExportNames()) {
            assert.ok(!/[<>]/.test(name), `name "${name}" must not contain markup`);
        }
    });

    it('every entry point lists exactly the exports its module has', { skip: SKIP }, async () => {
        const { model } = generateApiReference({ root: ROOT });
        for (const group of model.groups) {
            const mod = await import(group.spec);
            const runtime = Object.keys(mod).sort();
            const documented = group.entries.map((e) => e.name).sort();
            assert.deepEqual(
                documented,
                runtime,
                `${group.spec}: the generated list must be the module's runtime exports, exactly`,
            );
        }
    });

    it('the block covers every entry point of the package', { skip: SKIP }, () => {
        const { model } = generateApiReference({ root: ROOT });
        const specs = model.groups.map((g) => g.spec);
        assert.ok(specs.includes('merci-sdk'), 'the main entry must be covered');
        for (const sub of ['merci-sdk/oai', 'merci-sdk/aai', 'merci-sdk/gai', 'merci-sdk/jai', 'merci-sdk/tools', 'merci-sdk/json', 'merci-sdk/planning', 'merci-sdk/messaging']) {
            assert.ok(specs.includes(sub), `the subpath export ${sub} must be covered`);
        }
    });
});

describe('the published declarations', () => {
    it('run() accepts a streamed input', theRunDeclarationAcceptsAStreamedInput);
});
