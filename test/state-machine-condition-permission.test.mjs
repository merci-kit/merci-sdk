// @ts-check
/**
 * D-8 fallback: the isolated evaluator child must never exceed the host's own
 * Node permission scope.
 *
 * Before this fix the child ran with the OS user's access, so a host started
 * with `--permission` silently widened its own sandbox by evaluating a string
 * condition. The child now receives the host's permission flags plus exactly
 * one extra read grant: the directory of the evaluator module it must import.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { conditionChildArgs } from '../lib/agentic/state-machine/condition-evaluator.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const WORKER = resolve(REPO, 'lib/agentic/state-machine/condition-worker.mjs');
const WORKER_DIR = dirname(WORKER);
const MACHINE = new URL('../lib/agentic/state-machine/machine.mjs', import.meta.url).href;
const EVALUATOR = new URL('../lib/agentic/state-machine/condition-evaluator.mjs', import.meta.url).href;
const ERRORS = new URL('../lib/core/errors.mjs', import.meta.url).href;
const LIMITS = new URL('../lib/core/limit-config.mjs', import.meta.url).href;

describe('D-8 residual: the child inherits the host permission scope', () => {
    it('forwards the host permission flags and adds only the worker module read grant', () => {
        const args = conditionChildArgs({
            memoryMb: 64,
            workerPath: WORKER,
            execArgv: ['--permission', '--allow-fs-read=/x', '--allow-child-process', '--input-type=module', '-e'],
        });
        assert.deepEqual(args, [
            '--max-old-space-size=64',
            '--permission',
            '--allow-fs-read=/x',
            '--allow-child-process',
            `--allow-fs-read=${WORKER_DIR}`,
        ], 'only permission flags are forwarded, plus the worker module read grant');
        assert.equal(args.filter((a) => a === `--allow-fs-read=${WORKER_DIR}`).length, 1, 'exactly one worker-dir grant');
        assert.equal(args.some((a) => a.startsWith('--allow-fs-write')), false, 'no write grant is added');
    });

    it('accepts the experimental spelling and forwards nothing else', () => {
        const args = conditionChildArgs({
            memoryMb: 128,
            workerPath: WORKER,
            execArgv: ['--experimental-permission', '--allow-child-process', '--trace-warnings'],
        });
        assert.deepEqual(args, [
            '--max-old-space-size=128',
            '--experimental-permission',
            '--allow-child-process',
            `--allow-fs-read=${WORKER_DIR}`,
        ]);
    });

    it('forwards audit mode so the child stays in the same diagnostic mode', () => {
        const args = conditionChildArgs({
            memoryMb: 128,
            workerPath: WORKER,
            execArgv: ['--permission-audit', '--allow-fs-read=/x'],
        });
        assert.deepEqual(args, [
            '--max-old-space-size=128',
            '--permission-audit',
            '--allow-fs-read=/x',
            `--allow-fs-read=${WORKER_DIR}`,
        ]);
    });

    it('adds no permission flags when the host has no permission model', () => {
        const args = conditionChildArgs({ memoryMb: 32, workerPath: WORKER, execArgv: [] });
        if (process.permission === undefined) {
            assert.deepEqual(args, ['--max-old-space-size=32'], 'a host without --permission forwards none');
        }
    });

    it('a host running under --permission still evaluates a normal condition', () => {
        const script = `
      import { compileCondition } from ${JSON.stringify(MACHINE)};
      import { conditionEvaluatorStats } from ${JSON.stringify(EVALUATOR)};
      const ctx = { get: (k) => ({ score: 9 })[k], getAll: () => ({ score: 9 }) };
      const out = compileCondition({ src: "ctx.get('score') >= 8" })(ctx);
      console.log('PERM ' + out + ' ' + JSON.stringify(conditionEvaluatorStats()));
    `;
        const res = spawnSync(process.execPath, [
            '--permission',
            `--allow-fs-read=${REPO}`,
            '--allow-child-process',
            '--input-type=module',
            '-e',
            script,
        ], { encoding: 'utf8', timeout: 30_000 });
        assert.equal(res.status, 0, `host exit code (stderr: ${res.stderr.slice(0, 600)})`);
        assert.match(res.stdout, /PERM true \{"spawns":1,"evaluations":1,"persistent":true\}/,
            'the isolated child evaluates inside the forwarded scope');
    });

    it('a host that denies child processes fails closed, naming the cause and both remedies', () => {
        const script = `
      import { compileCondition } from ${JSON.stringify(MACHINE)};
      import { ConfigurationError } from ${JSON.stringify(ERRORS)};
      const ctx = { get: (k) => ({ score: 9 })[k], getAll: () => ({ score: 9 }) };
      try { const out = compileCondition({ src: "ctx.get('score') >= 8" })(ctx); console.log('DENIED RESULT ' + out); }
      catch (err) { console.log('DENIED ' + (err instanceof ConfigurationError ? 'TYPED' : 'UNTYPED') + ' ' + err.message); }
    `;
        const res = spawnSync(process.execPath, [
            '--permission',
            `--allow-fs-read=${REPO}`,
            '--input-type=module',
            '-e',
            script,
        ], { encoding: 'utf8', timeout: 30_000 });
        assert.equal(res.status, 0, `host exit code (stderr: ${res.stderr.slice(0, 600)})`);
        assert.match(res.stdout, /DENIED TYPED .*cannot run in an isolated process/,
            'the denial is a typed ConfigurationError that names the cause');
        assert.match(res.stdout, /DENIED TYPED .*--allow-child-process/,
            'the message names the --allow-child-process remedy');
        assert.match(res.stdout, /DENIED TYPED .*MERCI_LIMIT_CONDITION_UNISOLATED_VM=1/,
            'the message names the explicit opt-in');
        assert.doesNotMatch(res.stdout, /DENIED RESULT/, 'nothing is evaluated in-process by default');
        assert.doesNotMatch(res.stderr, /MERCI_CONDITION_ISOLATION/, 'a refusal is not the warned fallback');
    });

    it('the explicit opt-in evaluates in-process and warns exactly once', () => {
        const script = `
      import { compileCondition } from ${JSON.stringify(MACHINE)};
      import { setLimits } from ${JSON.stringify(LIMITS)};
      import { conditionEvaluatorStats } from ${JSON.stringify(EVALUATOR)};
      const ctx = { get: (k) => ({ score: 9 })[k], getAll: () => ({ score: 9 }) };
      setLimits({ values: { condition_unisolated_vm: 1 } });
      try {
        const a = compileCondition({ src: "ctx.get('score') >= 8" })(ctx);
        const b = compileCondition({ src: "ctx.get('score') < 8" })(ctx);
        console.log('OPTIN ' + a + ' ' + b + ' ' + JSON.stringify(conditionEvaluatorStats()));
      } finally { setLimits({ values: { condition_unisolated_vm: 0 } }); }
    `;
        const res = spawnSync(process.execPath, [
            '--permission',
            `--allow-fs-read=${REPO}`,
            '--input-type=module',
            '-e',
            script,
        ], { encoding: 'utf8', timeout: 30_000 });
        assert.equal(res.status, 0, `host exit code (stderr: ${res.stderr.slice(0, 600)})`);
        assert.match(res.stdout, /OPTIN true false \{"spawns":0,"evaluations":2,"persistent":false\}/,
            'both conditions evaluate in-process; no child is ever started');
        assert.equal((res.stderr.match(/MERCI_CONDITION_ISOLATION/g) ?? []).length, 1,
            `the lost memory bound is warned exactly once (stderr: ${res.stderr.slice(0, 600)})`);
    });
});
