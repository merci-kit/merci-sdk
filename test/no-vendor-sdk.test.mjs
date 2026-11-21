// @ts-check
/**
 * @file No vendor inference SDK is a runtime dependency.
 * @version 0.22.0
 *
 * @description
 * The wire connectors are native `fetch` implementations. This gate keeps it
 * that way: the listed packages are absent from `dependencies`, nothing under
 * `lib/` imports them (statically, through `require`, or through a dynamic
 * `import()` written with any quote, even by subpath), and every oracle recorder
 * imports its own standard's SDK through a runtime string specifier so a
 * recorder still loads — and skips — once the package is gone. A recorder left
 * with a static import would crash the suite on a clean install, and one naming
 * the wrong package would make its parity claim meaningless.
 *
 * Both connectors are covered the same way: every `*-oracle-record` test and
 * its `<standard>-parity/observe.mjs` harness are checked against every entry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Every vendor SDK that must not be a runtime dependency. */
export const VENDOR_SDKS = [
    '@anthropic-ai/sdk',
    '@google/genai',
    // Only the OAI oracle recorder imports it; the SDK and the native client
    // still must not depend on it at runtime.
    'openai',
];

/** The one package each standard's oracle recorder and harness may import. */
const RECORDER_PACKAGE = {
    aai: '@anthropic-ai/sdk',
    gai: '@google/genai',
    oai: 'openai',
};

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LIB_DIR = join(ROOT, 'lib');
const TEST_DIR = join(ROOT, 'test');

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a static import, a dynamic `import()` or a `require()` of the package
 * or any of its subpaths, whichever quote the specifier is written with.
 * @param {string} pkg
 * @returns {RegExp}
 */
function vendoredImport(pkg) {
    return new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"\`]${escapeRegExp(pkg)}(?:/[^'"\`]*)?['"\`]`);
}

/**
 * Every module file under a directory: `.mjs`, plus the `.js`/`.cjs` a build
 * step could emit (none today).
 * @param {string} dir
 * @returns {Promise<Array<string>>}
 */
async function moduleFiles(dir) {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && /\.[mc]?js$/.test(entry.name))
        .map((entry) => join(entry.parentPath, entry.name));
}

test('no vendor SDK is a runtime dependency', async () => {
    const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    const dependencies = Object.keys(packageJson.dependencies ?? {});
    for (const pkg of VENDOR_SDKS) {
        assert.equal(dependencies.includes(pkg), false, `${pkg} must not be in dependencies`);
    }
});

test('no lib file imports a vendor SDK', async () => {
    const files = await moduleFiles(LIB_DIR);
    assert.ok(files.length > 0, 'lib/ has modules');
    /** @type {Array<string>} */
    const offenders = [];
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        for (const pkg of VENDOR_SDKS) {
            if (vendoredImport(pkg).test(source)) offenders.push(`${file}: ${pkg}`);
        }
    }
    assert.deepEqual(offenders, [], 'lib/ must not import a vendor SDK');
});

/**
 * The string a dynamic `import()` argument names: the literal it is bound to, or
 * one level of `const alias = SPECIFIER;`.
 * @param {{source: string, argument: string}} arg0
 * @returns {string|null}
 */
function resolvedSpecifier({ source, argument }) {
    /** @type {Map<string, string>} */
    const strings = new Map();
    for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"]+)\2/g)) strings.set(match[1], match[3]);
    /** @type {Map<string, string>} */
    const aliases = new Map();
    for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)) aliases.set(match[1], match[2]);
    const direct = strings.get(argument);
    if (direct !== undefined) return direct;
    const target = aliases.get(argument);
    const resolved = target === undefined ? undefined : strings.get(target);
    return resolved === undefined ? null : resolved;
}

test('vendoredImport catches a template-literal specifier and any subpath', () => {
    for (const pkg of VENDOR_SDKS) {
        const matcher = vendoredImport(pkg);
        assert.equal(matcher.test(`const sdk = await import(\`${pkg}\`);`), true, `${pkg}: a template literal is caught`);
        assert.equal(matcher.test(`const sdk = await import('${pkg}/dist/v1');`), true, `${pkg}: a subpath is caught`);
        assert.equal(matcher.test(`import sdk from "${pkg}";`), true, `${pkg}: a static import is caught`);
        assert.equal(matcher.test(`const sdk = await import('${pkg}-compatible');`), false, `${pkg}: a different package is not`);
    }
});

test('every recorder resolves its vendor SDK through a runtime string specifier', async () => {
    const entries = await readdir(TEST_DIR, { withFileTypes: true });
    const recorders = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('-oracle-record.test.mjs'))
        .map((entry) => entry.name)
        .sort();
    assert.ok(recorders.length > 0, 'at least one oracle recorder exists');

    for (const name of recorders) {
        const standard = name.split('-')[0];
        const expected = /** @type {Record<string, string>} */ (RECORDER_PACKAGE)[standard];
        assert.ok(expected, `${name}: the recorder's standard has a package`);
        assert.ok(VENDOR_SDKS.includes(expected), `${name}: ${expected} is a listed vendor SDK`);
        // The recorder plus the parity harness it drives: the specifier may live
        // in either one.
        const harness = join(`${standard}-parity`, 'observe.mjs');
        /** @type {Array<string>} */
        const specifiers = [];
        for (const file of [name, harness]) {
            const source = await readFile(join(TEST_DIR, file), 'utf8');
            for (const pkg of VENDOR_SDKS) {
                assert.equal(vendoredImport(pkg).test(source), false, `${file}: no import/require of ${pkg}`);
            }
            for (const match of source.matchAll(/import\s*\(([^)]*)\)/g)) {
                const argument = match[1].trim();
                const specifier = resolvedSpecifier({ source, argument });
                assert.ok(specifier !== null, `${file}: import(${argument}) resolves to a string specifier`);
                assert.ok(
                    specifier === expected || specifier.startsWith(`${expected}/`),
                    `${file}: import('${specifier}') must name ${expected}, the ${standard} standard's package`,
                );
                specifiers.push(specifier);
            }
        }
        assert.ok(specifiers.length > 0, `${name}: imports its SDK dynamically`);
    }
});
