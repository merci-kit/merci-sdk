// @ts-check
/**
 * D-1: a transition condition string must never hand the host a function.
 *
 * The escape was `out.catch(() => {})` in `compileCondition`: `out` came from
 * the sandbox, and the host arrow was reachable as `f.constructor`, i.e. the
 * host realm's `Function`. The fix forces the value to a primitive boolean
 * inside the sandbox and never touches it on the host.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCondition } from '../lib/agentic/state-machine/machine.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';

const MARKER = join(mkdtempSync(join(tmpdir(), 'merci-d1-')), 'escaped.txt');

/** The payload from the review probe: a thenable that runs host code via `f.constructor`. */
const payload = `({ then() {}, catch(f) { const p = f.constructor('return process')(); p.getBuiltinModule('fs').writeFileSync(${JSON.stringify(MARKER)}, 'host-code-ran'); } })`;

describe('D-1: condition sandbox escape is closed', () => {
    it('does not run the payload, and refuses it as a thenable', () => {
        rmSync(MARKER, { force: true });
        const fn = compileCondition({ src: payload });
        assert.throws(() => fn({ get: () => undefined, getAll: () => ({ score: 3 }) }), ConfigurationError);
        assert.equal(existsSync(MARKER), false, 'the payload must not touch the host filesystem');
    });

    it('returns a primitive boolean for a plain value', () => {
        const out = compileCondition({ src: '({ score: 3 })' })({ get: () => undefined, getAll: () => ({}) });
        assert.equal(typeof out, 'boolean', 'the host must receive a primitive, never a sandbox object');
        assert.equal(out, true, 'a truthy object still means "condition met"');
    });

    it('keeps the ten constructor-chain escapes blocked', () => {
        const escapes = [
            'this.constructor.constructor("return process")()',
            '({}).constructor.constructor("return process")()',
            '[].constructor.constructor("return process")()',
            '/x/.constructor.constructor("return process")()',
            'Symbol.constructor("return process")()',
            'new Error().constructor.constructor("return process")()',
            '(function*(){}).constructor("return process")()',
            'eval("process")',
            'new Function("return process")()',
        ];
        for (const src of escapes) {
            const fn = compileCondition({ src: `(() => { try { return !!(${src}); } catch { return false; } })()` });
            assert.equal(fn({ get: () => undefined, getAll: () => ({}) }), false, src);
        }
    });

    it('still refuses a thenable, without handing the host a function', () => {
        const fn = compileCondition({ src: '({ then() {} })' });
        assert.throws(() => fn({ get: () => undefined, getAll: () => ({}) }), ConfigurationError);
    });

    it('refuses an oversized expression instead of compiling it', () => {
        assert.throws(
            () => compileCondition({ src: 'a'.repeat(400_001) }),
            (err) => err instanceof ConfigurationError && /too long/i.test(String(err.message)),
        );
    });

    it('refuses import() at compile time, leaving no unhandled rejection', async () => {
        /** @type {unknown} */
        let unhandled = null;
        const onUnhandled = (/** @type {unknown} */ reason) => { unhandled = reason; };
        process.once('unhandledRejection', onUnhandled);
        try {
            assert.throws(() => compileCondition({ src: "import('node:fs')" }), ConfigurationError);
            await new Promise((resolve) => setImmediate(resolve));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        assert.equal(unhandled, null, 'the refused source must not leave a rejection behind');
    });

    it('refuses a real dynamic import() but leaves the word "import" as data alone', () => {
        assert.throws(() => compileCondition({ src: "import('node:fs')" }), ConfigurationError);
        const byStatus = compileCondition({ src: "ctx.status === 'import'" });
        assert.equal(byStatus({ getAll: () => ({ status: 'import' }) }), true, "a state named 'import' is a value, not a call");
        const byProperty = compileCondition({ src: 'ctx.import === 1' });
        assert.equal(byProperty({ getAll: () => ({ import: 1 }) }), true, 'a property named import is data, not a call');
    });

    it('an over-budget condition payload is a non-retryable error naming the remedy (W2C-4)', () => {
        const rows = Array.from({ length: LIMITS.safe_stringify_max_nodes + 10 }, (_, i) => ({ i }));
        const fn = compileCondition({ src: 'ctx.rows.length > 0' });
        assert.throws(() => fn({ get: () => undefined, getAll: () => ({ rows }) }), (/** @type {any} */ err) => {
            assert.ok(err instanceof ConfigurationError);
            assert.equal(err.option, 'safe_stringify_max_nodes', 'the option is attached');
            assert.match(String(err.message), /MERCI_LIMIT_SAFE_STRINGIFY_MAX_NODES/, 'the remedy is named');
            assert.equal(err.nonRetryable, true, 'an over-budget value cannot shrink between attempts');
            return true;
        });
    });

    it('a statement body cannot mutate the host', () => {
        // Statements are still compiled (D-9, S4); the sandbox is what contains them.
        try {
            const fn = compileCondition({ src: '1); globalThis.__d1 = 1; (1' });
            fn({ get: () => undefined, getAll: () => ({}) });
        } catch (err) {
            assert.ok(err instanceof ConfigurationError, String(err));
        }
        assert.equal(/** @type {any} */ (globalThis).__d1, undefined);
    });
});
