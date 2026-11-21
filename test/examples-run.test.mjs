// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { OFFLINE_ARGS, OFFLINE_EXAMPLES, parseAuditResult, runExample } from '../scripts/run-examples.mjs';

test('examples: the audited set is the deterministic test tree, not the showcase tree', () => {
    assert.ok(OFFLINE_EXAMPLES.length >= 1, 'expected at least the durability audit');
    assert.ok(OFFLINE_EXAMPLES.every((rel) => rel.startsWith('test/examples/')), 'audits live under test/examples/');
    assert.ok(OFFLINE_EXAMPLES.includes('test/examples/35_capstone.mjs'));
});

test('examples: the showcase tree is live-only', () => {
    const dir = 'examples';
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.mjs')) continue;
        const source = readFileSync(join(dir, name), 'utf8');
        assert.ok(!source.includes('--offline'), `${dir}/${name} must stay live-only`);
        assert.ok(!OFFLINE_ARGS[`${dir}/${name}`], `${dir}/${name} must not be in the audit set`);
    }
});

test('examples: every audited example receives --offline in CI', () => {
    for (const rel of OFFLINE_EXAMPLES) {
        assert.deepEqual(OFFLINE_ARGS[rel], ['--offline'], `${rel} must run its deterministic path in CI`);
        // The runner passes the flag, so every file must read it — offline by
        // construction included; otherwise a rename or a new entry runs live.
        const source = readFileSync(rel, 'utf8');
        assert.ok(source.includes("process.argv.includes('--offline')"), `${rel} must read the --offline flag`);
    }
    assert.equal(OFFLINE_ARGS['examples/01_quickstart.mjs'], undefined, 'a live-only example takes no flag');
});

test('parseAuditResult reads the machine line', () => {
    const line = '[AUDIT-RESULT] {"example":"x","checks":3,"passed":3,"failed":0,"skipped":0,"errors":0}';
    const r = parseAuditResult({ stdout: `noise\n${line}\n` });
    assert.equal(r?.checks, 3);
    assert.equal(r?.failed, 0);
});

for (const rel of OFFLINE_EXAMPLES) {
    test(`example runs clean: ${rel}`, { timeout: 180_000 }, async () => {
        const r = await runExample({ rel });
        assert.equal(r.ok, true, `${rel} failed: ${r.reason}\n${r.stdout.split('\n').slice(-30).join('\n')}`);
    });
}
