// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const DOC = readFileSync(new URL('../docs/api_reference.html', import.meta.url), 'utf8');
const PLAIN = DOC.replace(/<[^>]+>/g, ' ');
const IMPORTS = [...PLAIN.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)]
    .map(([, names, spec]) => ({
        spec,
        names: names.split(',').map((n) => n.trim()).filter(Boolean),
    }));

const DOC_EXPORT_LIST = (() => {
    const card = DOC.match(/Every named export of[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/);
    if (!card) return [];
    return [...card[1].matchAll(/<code class="inline">([^<]+)<\/code>/g)].map((m) => m[1].trim()).filter(Boolean);
})();

describe('docs/api_reference.html <-> export surface', () => {
    it('found the documented import blocks', () => {
        assert.ok(IMPORTS.length >= 4, `expected import blocks, found ${IMPORTS.length}`);
    });

    it('every documented import resolves in the module it names', async () => {
        for (const { spec, names } of IMPORTS) {
            const mod = await import(spec);
            for (const name of names) {
                assert.ok(name in mod, `${spec} must export ${name}`);
            }
        }
    });

    it('every main-entry export is named somewhere in the docs', async () => {
        const sdk = await import('merci-sdk');
        for (const name of Object.keys(sdk)) {
            const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            assert.ok(re.test(DOC), `docs must mention export ${name}`);
        }
    });

    it('every name in the docs export list is a real main-entry export', async () => {
        assert.ok(DOC_EXPORT_LIST.length >= 50, `expected the export list, found ${DOC_EXPORT_LIST.length}`);
        const sdk = await import('merci-sdk');
        for (const name of DOC_EXPORT_LIST) {
            assert.ok(name in sdk, `docs list ${name} but merci-sdk does not export it`);
        }
    });
});
