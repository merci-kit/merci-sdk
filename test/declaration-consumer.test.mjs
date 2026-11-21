// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The published declarations must compile in a Node consumer that does NOT
 * have the DOM lib. A type import of a vendor SDK inside a declaration drags
 * that SDK's `.d.ts` (which references `HeadersInit`, `RequestInit`, …) into
 * the consumer's program — this test is the oracle for that class of leak.
 *
 * It compiles the real `exports` surface of the package (a symlink to the repo
 * root, so `package.json` resolution is the consumer's), not a copy.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TYPES_ENTRY = join(ROOT, 'dist', 'types', 'lib', 'index.d.mts');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const HAS_TYPES = existsSync(TYPES_ENTRY);
const SKIP = HAS_TYPES
    ? false
    : 'dist/types is missing — run `pnpm run build:types` first (the declarations are the source of truth)';

/** A root import is the strict case: the barrel reaches every declaration. */
const CONSUMER = `import { McpClient } from 'merci-sdk';

const client = new McpClient({ command: 'node', args: ['server.mjs'] });
client.onSampling = async () => ({ content: { type: 'text', text: 'ok' } });
void client;
`;

/**
 * Compiles a consumer against the built declarations.
 * @param {{ dir: string }} arg0
 * @returns {{ status: number|null, stdout: string, stderr: string, output: string }}
 */
function compileConsumer({ dir }) {
    const result = spawnSync(process.execPath, [TSC, '-p', join(dir, 'tsconfig.json')], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 120_000,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    };
}

test('the published declarations compile without the DOM lib', { skip: SKIP }, () => {
    assert.equal(existsSync(TSC), true, `typescript must be installed (${TSC})`);
    const dir = mkdtempSync(join(tmpdir(), 'merci-dom-free-'));
    try {
        mkdirSync(join(dir, 'node_modules'), { recursive: true });
        symlinkSync(ROOT, join(dir, 'node_modules', 'merci-sdk'), 'dir');
        writeFileSync(join(dir, 'consume.ts'), CONSUMER);
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                strict: true,
                noEmit: true,
                skipLibCheck: false,
                module: 'nodenext',
                moduleResolution: 'nodenext',
                target: 'ES2023',
                lib: ['ES2023'],
                types: ['node'],
                typeRoots: [join(ROOT, 'node_modules', '@types')],
            },
            include: ['consume.ts'],
        }, null, 2));

        const run = compileConsumer({ dir });
        assert.equal(run.status, 0, `the consumer must compile with 0 errors:\n${run.output}`);
        assert.equal(run.output, '', 'no diagnostic is acceptable');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
