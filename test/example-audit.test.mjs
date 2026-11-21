// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const AUDIT_MODULE = join(ROOT, 'examples', '_shared', 'example-audit.mjs');


/** @param {{body: *}} arg0 */
function runChild({ body }) {
    const dir = mkdtempSync(join(tmpdir(), 'merci-audit-test-'));
    const script = join(dir, 'child.mjs');
    writeFileSync(script, `
        import { createAudit } from ${JSON.stringify(AUDIT_MODULE)};
        const audit = createAudit({ metaUrl: import.meta.url, id: 'selftest', dir: ${JSON.stringify(dir)} });
        ${body}
    `);
    try {
        const stdout = execFileSync(process.execPath, [script], { encoding: 'utf8', cwd: ROOT });
        return { status: 0, stdout, dir };
    } catch (err) {
        const e =  (err);
        return { status: /** @type {any} */ (e).status ?? 1, stdout: String(/** @type {any} */ (e).stdout ?? ''), dir };
    }
}

test('example-audit: a passing run writes artifacts and exits 0', () => {
    const { status, stdout, dir } = runChild({ body: `
        audit.begin();
        audit.scenario({ id: 'A', title: 'pass case', expect: 'one check', fails: [{ code: 'x', symptom: 'n/a' }] });
        audit.observe({ name: 'calls', value: 1 });
        audit.check({ name: 'all good', ok: 1 === 1, detail: { observed: 'calls=1' } });
        audit.end();
        audit.summary();
    ` });
    try {
        assert.equal(status, 0, stdout);
        assert.match(stdout, /\[AUDIT-BEGIN\]/);
        assert.match(stdout, /\[AUDIT-SCENARIO\] A · pass case/);
        assert.match(stdout, /\[AUDIT-RESULT\] \{"example":"selftest","checks":1,"passed":1,"failed":0,"skipped":0/);
        assert.match(stdout, /\[AUDIT-END\] failed=0/);
        const latest = join(dir, 'latest.json');
        assert.ok(existsSync(latest), 'latest.json written');
        const rec = JSON.parse(readFileSync(latest, 'utf8'));
        assert.equal(rec.schemaVersion, 1);
        assert.equal(rec.example, 'selftest');
        assert.equal(rec.totals.failed, 0);
        assert.equal(rec.scenarios[0].checks[0].ok, true);
        assert.ok(existsSync(join(dir, 'latest.log')), 'latest.log written');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('example-audit: a failing check prints a playbook, is counted, and exits 1', () => {
    const { status, stdout, dir } = runChild({ body: `
        audit.begin();
        audit.scenario({ id: 'B', title: 'fail case', expect: 'cap enforced', fails: [{ code: 'no-cap', symptom: 'cap ignored', hint: 'agentic-core.mjs pre-call guard' }] });
        audit.check({ name: 'cap enforced', ok: false, detail: { expected: '1 call', observed: '2 calls', hint: 'agentic-core.mjs pre-call guard' } });
        audit.end();
        audit.summary();
    ` });
    try {
        assert.equal(status, 1, 'a failed check must set a non-zero exit code');
        assert.match(stdout, /\[AUDIT-PLAYBOOK\] B — cap enforced/);
        assert.match(stdout, /fail mode: no-cap/);
        assert.match(stdout, /\[AUDIT-RESULT\] \{"example":"selftest","checks":1,"passed":0,"failed":1/);
        const rec = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
        assert.equal(rec.totals.failed, 1);
        assert.equal(rec.scenarios[0].outcome, 'fail');
        assert.equal(rec.scenarios[0].checks[0].observed, '2 calls');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('example-audit: skips are counted separately from failures', () => {
    const { status, stdout, dir } = runChild({ body: `
        audit.begin();
        audit.scenario({ id: 'C', title: 'live-only', expect: 'needs a backend' });
        audit.skip({ name: 'live call', why: 'no network in this run' });
        audit.end();
        audit.summary();
    ` });
    try {
        assert.equal(status, 0, 'skips must not fail the run');
        assert.match(stdout, /\[AUDIT-SKIP\] live call — no network in this run/);
        assert.match(stdout, /"checks":1,"passed":1,"failed":0,"skipped":1/);
        const rec = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
        assert.equal(rec.totals.skipped, 1);
        assert.equal(rec.scenarios[0].outcome, 'skip');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('example-audit: fatal errors are captured and the run exits 1', () => {
    const { status, stdout, dir } = runChild({ body: `
        await audit.run(async () => {
            audit.scenario({ id: 'D', title: 'boom' });
            throw Object.assign(new Error('vendor exploded'), { code: 'MERCI-BACKEND-ERR' });
        });
    ` });
    try {
        assert.equal(status, 1);
        assert.match(stdout, /\[AUDIT-END\] failed=0 errors=1/);
        const rec = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
        assert.equal(rec.totals.errors, 1);
        assert.equal(rec.scenarios[0].error?.message, 'vendor exploded');
        assert.equal(rec.scenarios[0].error?.code, 'MERCI-BACKEND-ERR');
        assert.equal(rec.scenarios[0].outcome, 'fail');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('example-audit: createRunLog counts SKIP checks separately and never as a failure', () => {
    const logger = join(ROOT, 'lib', 'support', 'logger.mjs');
    const runLogDir = join(ROOT, 'examples', '.logs', 'selftest-runlog');
    try {
        const { status, stdout } = runChild({ body: `
            import { createRunLog } from ${JSON.stringify(AUDIT_MODULE)};
            import { log } from ${JSON.stringify(logger)};
            const runLog = createRunLog({ exampleId: 'selftest-runlog' });
            log.check({ name: 'ok', passed: true, detail: 'fine' });
            log.check({ name: 'flaky', passed: true, detail: 'SKIP: provider moderation' });
            runLog.finish({ status: 'ok' });
        ` });
        assert.equal(status, 0, stdout);
        assert.match(stdout, /"checks":2,"passed":2,"failed":0,"skipped":1/);
    } finally {
        rmSync(runLogDir, { recursive: true, force: true });
    }
});
