// @ts-check
/**
 * D-8: a condition's memory must not be able to kill the host.
 *
 * `node:vm` bounds CPU time only, so a planner-authored expression such as the
 * OOM payload below aborts the whole process (`FATAL ERROR: Reached heap
 * limit`, exit 134). String conditions now evaluate in a child process with its
 * own `--max-old-space-size`; the host gets a typed `ConfigurationError` and
 * keeps working.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { compileCondition } from '../lib/agentic/state-machine/machine.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { LIMITS, setLimits } from '../lib/core/limit-config.mjs';
import { conditionEvaluatorStats } from '../lib/agentic/state-machine/condition-evaluator.mjs';

const MACHINE = new URL('../lib/agentic/state-machine/machine.mjs', import.meta.url).href;
const ERRORS = new URL('../lib/core/errors.mjs', import.meta.url).href;
const EVALUATOR = new URL('../lib/agentic/state-machine/condition-evaluator.mjs', import.meta.url).href;

/** The review's host-kill probe. 14 × 80 MB arrays. */
const OOM_SRC = '(() => { const keep = []; for (let i = 0; i < 14; i++) keep.push(new Array(10_000_000).fill(i)); return keep.length > 0; })()';

const ctx = { get: (/** @type {string} */ k) => /** @type {any} */ ({ score: 9 })[k], getAll: () => ({ score: 9 }) };

describe('D-8: condition memory isolation', () => {
    it('an OOM condition is a typed error and the host process survives (a) and can evaluate again (b)', () => {
        const script = `
      import { compileCondition } from ${JSON.stringify(MACHINE)};
      import { ConfigurationError } from ${JSON.stringify(ERRORS)};
      const ctx = { get: (k) => ({ score: 9 })[k], getAll: () => ({ score: 9 }) };
      const src = ${JSON.stringify(OOM_SRC)};
      try { compileCondition({ src })(ctx); console.log('OOM NO_ERROR'); }
      catch (err) { console.log('OOM ' + (err instanceof ConfigurationError ? 'TYPED' : 'UNTYPED') + ' ' + err.message); }
      const next = compileCondition({ src: "ctx.get('score') >= 8" })(ctx);
      console.log('NEXT ' + next);
    `;
        const res = spawnSync(process.execPath, ['--max-old-space-size=512', '--input-type=module', '-e', script], {
            encoding: 'utf8',
            timeout: 30_000,
            // A small worker heap makes the probe OOM quickly (~350 ms).
            env: { ...process.env, MERCI_LIMIT_CONDITION_MEMORY_MB: '32' },
        });
        assert.equal(res.error, undefined, String(res.error));
        assert.equal(res.signal, null, 'the host process itself must not be killed');
        assert.equal(res.status, 0, `host exit code (stderr: ${res.stderr.slice(0, 400)})`);
        assert.match(res.stdout, /OOM TYPED .*memory budget/i, 'the OOM is a typed ConfigurationError');
        assert.match(res.stdout, /NEXT true/, 'the next condition still evaluates');
        assert.doesNotMatch(res.stderr, /FATAL ERROR/, 'the fatal OOM stderr stays in the isolated child');
    });

    it('evaluates true and false normally', () => {
        assert.equal(compileCondition({ src: "ctx.get('score') >= 8" })(ctx), true);
        assert.equal(compileCondition({ src: "ctx.get('score') < 8" })(ctx), false);
    });

    it('refuses a thenable', () => {
        assert.throws(() => compileCondition({ src: '({ then() {} })' })(ctx), ConfigurationError);
    });

    it('keeps process unreachable inside the sandbox', () => {
        assert.equal(compileCondition({ src: "typeof process === 'undefined'" })(ctx), true);
        assert.throws(() => compileCondition({ src: 'process.version' })(ctx), ConfigurationError);
    });

    it('a busy loop hits the time budget', () => {
        const prev = LIMITS.condition_timeout_ms;
        setLimits({ values: { condition_timeout_ms: 100 } });
        try {
            assert.throws(
                () => compileCondition({ src: '(() => { for (;;) {} })()' })(ctx),
                (err) => err instanceof ConfigurationError && /time budget/i.test(String(err.message)),
            );
        } finally {
            setLimits({ values: { condition_timeout_ms: prev } });
        }
    });

    it('resolves condition_memory_mb per call, respawning the child under the new cap', () => {
        const prev = LIMITS.condition_memory_mb;
        // ~40M packed elements trips a 16 MB heap, and is cheap enough to run.
        const big = '(() => { const a = new Array(40_000_000).fill(1); return a.length > 0; })()';
        try {
            setLimits({ values: { condition_memory_mb: 16 } });
            assert.throws(() => compileCondition({ src: big })(ctx), (err) => err instanceof ConfigurationError && /memory budget/i.test(String(err.message)));
            const before = conditionEvaluatorStats().spawns;
            setLimits({ values: { condition_memory_mb: prev } });
            // A limit change alone must replace the child: the old one keeps the
            // heap cap it was started with.
            assert.equal(compileCondition({ src: 'true' })(ctx), true);
            assert.ok(conditionEvaluatorStats().spawns > before, 'a changed memory cap respawns the child');
        } finally {
            setLimits({ values: { condition_memory_mb: prev } });
        }
    });

    it('refuses an oversized expression instead of evaluating it', () => {
        assert.throws(
            () => compileCondition({ src: 'a'.repeat(LIMITS.condition_max_length + 1) }),
            (err) => err instanceof ConfigurationError && /too long/i.test(String(err.message)),
        );
    });
});

describe('D-8 residual: one persistent evaluator child, not one start per condition', () => {
    it('twenty sequential evaluations reuse one child and stay under 200 ms', () => {
        const script = `
      import { compileCondition } from ${JSON.stringify(MACHINE)};
      import { conditionEvaluatorStats } from ${JSON.stringify(EVALUATOR)};
      const ctx = { get: (k) => ({ score: 9 })[k], getAll: () => ({ score: 9 }) };
      const fn = compileCondition({ src: "ctx.get('score') >= 8" });
      let ok = true;
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) ok = ok && fn(ctx) === true;
      const ms = performance.now() - t0;
      console.log(JSON.stringify({ ok, ms, ...conditionEvaluatorStats() }));
    `;
        const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            encoding: 'utf8',
            timeout: 30_000,
        });
        assert.equal(res.status, 0, `host exit code (stderr: ${res.stderr.slice(0, 400)})`);
        const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}');
        assert.equal(out.ok, true, 'every evaluation returns true');
        assert.equal(out.spawns, 1, 'twenty sequential evaluations start exactly one child');
        assert.equal(out.evaluations, 20, 'every evaluation is counted');
        assert.equal(out.persistent, true, 'the bridge outlives a single evaluation');
        assert.ok(out.ms < 200, `twenty evaluations took ${out.ms.toFixed(1)}ms, expected < 200ms`);
    });

    it('an OOM in the persistent child is typed, keeps the host alive, and the next call respawns', () => {
        const script = `
      import { compileCondition } from ${JSON.stringify(MACHINE)};
      import { conditionEvaluatorStats } from ${JSON.stringify(EVALUATOR)};
      import { ConfigurationError } from ${JSON.stringify(ERRORS)};
      const ctx = { get: (k) => ({ score: 9 })[k], getAll: () => ({ score: 9 }) };
      const before = conditionEvaluatorStats().spawns;
      let typed = 'NO_ERROR';
      try { compileCondition({ src: ${JSON.stringify(OOM_SRC)} })(ctx); }
      catch (err) { typed = (err instanceof ConfigurationError ? 'TYPED ' : 'UNTYPED ') + err.message; }
      const afterCrash = conditionEvaluatorStats().spawns;
      const next = compileCondition({ src: "ctx.get('score') >= 8" })(ctx);
      console.log(JSON.stringify({ typed, before, afterCrash, next, persistent: conditionEvaluatorStats().persistent }));
    `;
        const res = spawnSync(process.execPath, ['--max-old-space-size=512', '--input-type=module', '-e', script], {
            encoding: 'utf8',
            timeout: 30_000,
            env: { ...process.env, MERCI_LIMIT_CONDITION_MEMORY_MB: '32' },
        });
        assert.equal(res.signal, null, 'the host process itself must not be killed');
        assert.equal(res.status, 0, `host exit code (stderr: ${res.stderr.slice(0, 400)})`);
        const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}');
        assert.match(out.typed, /^TYPED .*memory budget/i, 'the OOM is a typed ConfigurationError');
        assert.equal(out.afterCrash, out.before + 1, 'the dead child is replaced by exactly one new child');
        assert.equal(out.next, true, 'the next condition still evaluates');
        assert.equal(out.persistent, true, 'the replacement child keeps the bridge alive');
        assert.doesNotMatch(res.stderr, /FATAL ERROR/, 'the fatal OOM stderr stays in the isolated child');
    });

    it('a busy loop in the persistent child hits the time budget and leaves the child usable', () => {
        const prev = LIMITS.condition_timeout_ms;
        setLimits({ values: { condition_timeout_ms: 100 } });
        try {
            assert.throws(
                () => compileCondition({ src: '(() => { for (;;) {} })()' })(ctx),
                (err) => err instanceof ConfigurationError && /time budget/i.test(String(err.message)),
            );
        } finally {
            setLimits({ values: { condition_timeout_ms: prev } });
        }
        assert.equal(compileCondition({ src: "ctx.get('score') >= 8" })(ctx), true, 'the same child answers after a vm timeout');
    });

    it('recycles the child once a condition leaves its heap over half the cap', () => {
        // ~80 MB in a 128 MB child: the array is garbage when the condition
        // returns, but the child keeps the pages until V8 collects them, so a
        // second near-cap condition would OOM where a fresh child would not.
        const heavy = '(() => { const a = new Array(10_000_000).fill(1); return a.length > 0; })()';
        const before = conditionEvaluatorStats();
        assert.equal(compileCondition({ src: heavy })(ctx), true, 'the heavy condition itself succeeds');
        const after = conditionEvaluatorStats();
        assert.equal(after.persistent, false, 'the heavy child is recycled before the next call');
        assert.equal(after.spawns, before.spawns, 'the recycle itself starts no child');
        assert.equal(compileCondition({ src: heavy })(ctx), true, 'a second heavy condition succeeds in a fresh child');
        assert.equal(conditionEvaluatorStats().spawns, before.spawns + 1, 'the next evaluation starts exactly one new child');
    });

    it('takes the portable one-shot path when MERCI_CONDITION_ONESHOT=1', () => {
        const script = `
      import { compileCondition } from ${JSON.stringify(MACHINE)};
      import { conditionEvaluatorStats } from ${JSON.stringify(EVALUATOR)};
      const ctx = { get: (k) => ({ score: 9 })[k], getAll: () => ({ score: 9 }) };
      const ok = compileCondition({ src: "ctx.get('score') >= 8" })(ctx);
      console.log(JSON.stringify({ ok, ...conditionEvaluatorStats() }));
    `;
        const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            encoding: 'utf8',
            timeout: 30_000,
            env: { ...process.env, MERCI_CONDITION_ONESHOT: '1' },
        });
        assert.equal(res.status, 0, `host exit code (stderr: ${res.stderr.slice(0, 400)})`);
        const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}');
        assert.equal(out.ok, true, 'the one-shot child evaluates the condition');
        assert.equal(out.persistent, false, 'the one-shot path starts no persistent bridge');
        assert.equal(out.spawns, 0, 'no bridge spawn is counted');
    });
});
