// @ts-check

/**
 * @file Stage 1 tests: strict `WORKFLOW.md` front-matter parsing and one-shot loading (§5.1).
 * @version 0.12.0
 *
 * @description
 * The strict reader must never fall back, never print a YAML warning, and never
 * put file content in an error. Front matter is only recognized when the file
 * starts with a `---` fence; everything else is prompt text.
 */
import { after, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseWorkflowMarkdown, loadWorkflowFile } from '../lib/agentic/workflow-policy/index.mjs';
import { PolicyError } from '../lib/core/errors.mjs';

const require = createRequire(import.meta.url);

/** @type {string[]} */
const tempDirs = [];

after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * @returns {Promise<string>} An absolute temporary directory removed after the file.
 */
async function tempDir() {
    const dir = await mkdtemp(join(tmpdir(), 'merci-wp-parse-'));
    tempDirs.push(dir);
    return dir;
}

/**
 * @param {() => unknown} fn
 * @returns {PolicyError}
 */
function syncPolicyError(fn) {
    try {
        fn();
    } catch (err) {
        assert.ok(err instanceof PolicyError, `expected PolicyError, got ${String(err)}`);
        return err;
    }
    assert.fail('expected the call to throw a PolicyError');
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<PolicyError>}
 */
async function asyncPolicyError(promise) {
    try {
        await promise;
    } catch (err) {
        assert.ok(err instanceof PolicyError, `expected PolicyError, got ${String(err)}`);
        return err;
    }
    assert.fail('expected the promise to reject with a PolicyError');
}

/**
 * Makes yaml's `parseDocument` throw for the duration of `fn`, so the
 * containment path is exercised rather than assumed. `parseDocument` builds a
 * `Composer` from the required module object, so replacing that one export is
 * seen at call time; ESM named imports are not writable.
 * @param {() => void} fn
 */
function withThrowingParser(fn) {
    const yamlDir = dirname(require.resolve('yaml/package.json'));
    const composer = /** @type {{Composer: unknown}} */ (require(join(yamlDir, 'dist', 'compose', 'composer.js')));
    const realComposer = composer.Composer;
    composer.Composer = class {
        constructor() {
            throw new Error('composer failed');
        }
    };
    try {
        fn();
    } finally {
        composer.Composer = realComposer;
    }
}

/**
 * Recursively asserts every object/array level is frozen.
 * @param {{value: unknown, path?: string}} arg0
 */
function assertFrozenDeep({ value, path = 'root' }) {
    if (value === null || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value), `${path} must be frozen`);
    for (const key of Object.keys(value)) {
        assertFrozenDeep({ value: /** @type {Record<string, unknown>} */ (value)[key], path: `${path}.${key}` });
    }
}

describe('parseWorkflowMarkdown', () => {
    it('returns the raw front matter and the trimmed body', () => {
        const markdown = '---\ntracker:\n  kind: linear\npolling:\n  interval_ms: 1000\n---\n\nHello {{ issue.identifier }}\n\n';
        const { config, promptTemplate } = parseWorkflowMarkdown({ markdown });
        assert.deepEqual(config, { tracker: { kind: 'linear' }, polling: { interval_ms: 1000 } });
        assert.equal(promptTemplate, 'Hello {{ issue.identifier }}');
    });

    it('treats a file without front matter as all body', () => {
        const { config, promptTemplate } = parseWorkflowMarkdown({ markdown: '  # Title\n\nBody  \n' });
        assert.deepEqual(config, {});
        assert.equal(promptTemplate, '# Title\n\nBody');
    });

    it('strips exactly one leading BOM before the opening fence', () => {
        const { config, promptTemplate } = parseWorkflowMarkdown({ markdown: '\uFEFF---\na: 1\n---\nBody' });
        assert.deepEqual(config, { a: 1 });
        assert.equal(promptTemplate, 'Body');
    });

    it('accepts CRLF front matter and body', () => {
        const { config, promptTemplate } = parseWorkflowMarkdown({ markdown: '---\r\na: 1\r\n---\r\nBody\r\n' });
        assert.deepEqual(config, { a: 1 });
        assert.equal(promptTemplate, 'Body');
    });

    it('accepts mixed line endings', () => {
        const { config, promptTemplate } = parseWorkflowMarkdown({ markdown: '---\r\na: 1\n---\r\nBody' });
        assert.deepEqual(config, { a: 1 });
        assert.equal(promptTemplate, 'Body');
    });

    it('rejects an opening fence with no close, at the opening offset', () => {
        const err = syncPolicyError(() => parseWorkflowMarkdown({ markdown: '---\na: 1\nBody' }));
        assert.equal(err.reason, 'workflow_parse_error');
        assert.equal(err.line, 1);
        assert.equal(err.column, 1);
        assert.equal(err.path, null);
        assert.equal(err.cause, undefined);
    });

    it('does not treat an opening fence after byte 0 as front matter', () => {
        const { config, promptTemplate } = parseWorkflowMarkdown({ markdown: '\n---\na: 1\n---\nBody' });
        assert.deepEqual(config, {});
        assert.equal(promptTemplate, '---\na: 1\n---\nBody');
    });

    it('accepts empty front matter', () => {
        const { config, promptTemplate } = parseWorkflowMarkdown({ markdown: '---\n---\nBody' });
        assert.deepEqual(config, {});
        assert.equal(promptTemplate, 'Body');
    });

    it('accepts YAML null as an empty map', () => {
        const { config } = parseWorkflowMarkdown({ markdown: '---\nnull\n---\nBody' });
        assert.deepEqual(config, {});
    });

    it('rejects a YAML sequence', () => {
        const err = syncPolicyError(() => parseWorkflowMarkdown({ markdown: '---\n- a\n- b\n---\nBody' }));
        assert.equal(err.reason, 'workflow_front_matter_not_a_map');
    });

    it('rejects a YAML scalar', () => {
        const err = syncPolicyError(() => parseWorkflowMarkdown({ markdown: '---\n42\n---\nBody' }));
        assert.equal(err.reason, 'workflow_front_matter_not_a_map');
    });

    it('rejects malformed YAML with line/column and without the offending value', () => {
        const secret = 'SECRET_PARSE_VALUE_9f3';
        const err = syncPolicyError(() => parseWorkflowMarkdown({
            markdown: `---\ntracker:\n  kind: linear\nbroken: [${secret}, 2\n---\nBody`
        }));
        assert.equal(err.reason, 'workflow_parse_error');
        assert.equal(typeof err.line, 'number');
        assert.equal(typeof err.column, 'number');
        assert.ok(/** @type {number} */ (err.line) >= 1);
        assert.ok(!err.message.includes(secret), 'the message must not quote the YAML line');
        assert.ok(!JSON.stringify(err.reasons).includes(secret), 'the reasons must not quote the YAML line');
        assert.ok(!String(err.message).includes('broken'));
        assert.equal(err.cause, undefined);
    });

    it('rejects duplicate keys', () => {
        const err = syncPolicyError(() => parseWorkflowMarkdown({ markdown: '---\na: 1\na: 2\n---\nBody' }));
        assert.equal(err.reason, 'workflow_parse_error');
    });

    it('bounds alias expansion', () => {
        const markdown = [
            '---',
            'a: &a [1, 1, 1, 1, 1, 1, 1, 1, 1]',
            'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]',
            'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]',
            'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]',
            'e: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d]',
            'f: &f [*e, *e, *e, *e, *e, *e, *e, *e, *e]',
            'g: &g [*f, *f, *f, *f, *f, *f, *f, *f, *f]',
            'h: &h [*g, *g, *g, *g, *g, *g, *g, *g, *g]',
            '---',
            'Body'
        ].join('\n');
        const startedAt = Date.now();
        const err = syncPolicyError(() => parseWorkflowMarkdown({ markdown }));
        assert.equal(err.reason, 'workflow_parse_error');
        assert.ok(Date.now() - startedAt < 5000, 'the alias bomb must fail fast');
    });

    it('caps alias references at the pinned count', () => {
        // 60 references to one anchor: yaml's cap is per anchor
        // (`count * aliasCount`), so 60 is under its default 100 and over the
        // pinned 50. A 60-distinct-anchor file would never trip it.
        const references = new Array(60).fill('*a').join(', ');
        const markdown = ['---', 'base: &a 0', `list: [${references}]`, '---', 'Body'].join('\n');
        const startedAt = Date.now();
        const err = syncPolicyError(() => parseWorkflowMarkdown({ markdown }));
        assert.equal(err.reason, 'workflow_parse_error');
        assert.ok(Date.now() - startedAt < 2000, 'the alias cap must fail fast');
    });

    it('contains a parser construction failure as workflow_parse_error', () => {
        const err = syncPolicyError(() => withThrowingParser(() => parseWorkflowMarkdown({
            markdown: '---\na: 1\n---\nBody'
        })));
        assert.equal(err.reason, 'workflow_parse_error');
        assert.equal(err.message, 'Workflow front matter is not valid YAML');
        assert.equal(err.cause, undefined);
        assert.deepEqual(parseWorkflowMarkdown({ markdown: '---\na: 1\n---\nBody' }).config, { a: 1 });
    });

    it('rejects an unknown tag without writing to stderr', async () => {
        const write = mock.method(process.stderr, 'write', () => true);
        try {
            const err = syncPolicyError(() => parseWorkflowMarkdown({
                markdown: '---\na: !!js/function |\n  function(){}\n---\nBody'
            }));
            assert.equal(err.reason, 'workflow_parse_error');
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(write.mock.callCount(), 0, 'parseDocument warnings must stay in memory');
        } finally {
            write.mock.restore();
        }
    });

    it('does not pollute Object.prototype from a __proto__ key', () => {
        const { config } = parseWorkflowMarkdown({ markdown: '---\n__proto__:\n  polluted: true\n---\nBody' });
        assert.equal(/** @type {Record<string, unknown>} */ ({}).polluted, undefined);
        assert.equal(Object.prototype.hasOwnProperty('polluted'), false);
        assert.equal(Object.getPrototypeOf(config), Object.prototype);
    });
});

describe('loadWorkflowFile', () => {
    it('reads, resolves, freezes, and never parses the template', async () => {
        const dir = await tempDir();
        const path = join(dir, 'WORKFLOW.md');
        await writeFile(path, '---\ntracker:\n  kind: linear\n---\nHello {{ issue.identifier }}\n', 'utf8');

        const loaded = await loadWorkflowFile({ path });
        assert.equal(loaded.path, path);
        assert.equal(loaded.baseDir, dirname(path));
        assert.equal(loaded.promptTemplate, 'Hello {{ issue.identifier }}');
        assert.equal(loaded.config.tracker.kind, 'linear');
        assert.equal(typeof loaded.loadedAt, 'number');
        assert.deepEqual(Object.keys(loaded).sort(), ['baseDir', 'config', 'loadedAt', 'path', 'promptTemplate', 'warnings']);
        assert.equal(Object.hasOwn(loaded, 'ast'), false);
        assertFrozenDeep({ value: loaded });
        assert.ok(Object.isFrozen(loaded.warnings));
    });

    it('warns empty_prompt for an empty body', async () => {
        const dir = await tempDir();
        const path = join(dir, 'WORKFLOW.md');
        await writeFile(path, '---\ntracker:\n  kind: linear\n---\n   \n', 'utf8');

        const loaded = await loadWorkflowFile({ path });
        assert.equal(loaded.promptTemplate, '');
        assert.ok(loaded.warnings.includes('empty_prompt'));
    });

    it('reports a missing file as missing_workflow_file', async () => {
        const dir = await tempDir();
        const path = join(dir, 'absent.md');
        const err = await asyncPolicyError(loadWorkflowFile({ path }));
        assert.equal(err.reason, 'missing_workflow_file');
        assert.equal(err.path, path);
    });

    it('reports a directory as workflow_read_error', async () => {
        const dir = await tempDir();
        const path = join(dir, 'folder');
        await mkdir(path);
        const err = await asyncPolicyError(loadWorkflowFile({ path }));
        assert.equal(err.reason, 'workflow_read_error');
        assert.equal(err.path, path);
    });

    it('rejects a file over maxFileBytes before reading', async () => {
        const dir = await tempDir();
        const path = join(dir, 'WORKFLOW.md');
        await writeFile(path, '---\ntracker:\n  kind: linear\n---\n' + 'x'.repeat(200), 'utf8');
        const err = await asyncPolicyError(loadWorkflowFile({ path, maxFileBytes: 10 }));
        assert.equal(err.reason, 'workflow_too_large');
        assert.equal(err.path, path);
    });

    it('rejects a file that grows past maxFileBytes after the stat', async () => {
        const dir = await tempDir();
        const path = join(dir, 'WORKFLOW.md');
        await writeFile(path, '---\ntracker:\n  kind: linear\n---\nBody\n', 'utf8');

        const cjsFs = /** @type {{promises: {stat: (path: string) => Promise<import('node:fs').Stats>}}} */ (require('node:fs'));
        const realStat = cjsFs.promises.stat;
        cjsFs.promises.stat = async (target) => {
            const stats = await realStat(target);
            const clone = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { size: 1 });
            return /** @type {import('node:fs').Stats} */ (clone);
        };
        try {
            const err = await asyncPolicyError(loadWorkflowFile({ path, maxFileBytes: 4 }));
            assert.equal(err.reason, 'workflow_too_large');
        } finally {
            cjsFs.promises.stat = realStat;
        }
    });

    it('rejects a __proto__ config key through config resolution', async () => {
        const dir = await tempDir();
        const path = join(dir, 'WORKFLOW.md');
        await writeFile(path, '---\n__proto__:\n  polluted: true\n---\nBody\n', 'utf8');

        const err = await asyncPolicyError(loadWorkflowFile({ path }));
        assert.ok(err.reasons.includes('invalid_config:__proto__'));
        assert.equal(/** @type {Record<string, unknown>} */ ({}).polluted, undefined);
    });

    it('maps a stat permission failure to workflow_read_error', async (t) => {
        if (typeof process.getuid === 'function' && process.getuid() === 0) {
            t.skip('permission bits do not apply to root');
            return;
        }
        const dir = await tempDir();
        const locked = join(dir, 'locked');
        await mkdir(locked);
        const path = join(locked, 'WORKFLOW.md');
        await writeFile(path, '---\n---\nBody\n', 'utf8');
        await chmod(locked, 0o000);
        try {
            const err = await asyncPolicyError(loadWorkflowFile({ path }));
            assert.equal(err.reason, 'workflow_read_error');
            assert.equal(err.path, path);
        } finally {
            await chmod(locked, 0o700);
        }
    });

    it('maps a read failure to workflow_read_error', async (t) => {
        if (typeof process.getuid === 'function' && process.getuid() === 0) {
            t.skip('permission bits do not apply to root');
            return;
        }
        const dir = await tempDir();
        const path = join(dir, 'WORKFLOW.md');
        await writeFile(path, '---\n---\nBody\n', 'utf8');
        await chmod(path, 0o000);
        try {
            const err = await asyncPolicyError(loadWorkflowFile({ path }));
            assert.equal(err.reason, 'workflow_read_error');
        } finally {
            await chmod(path, 0o600);
        }
    });

    it('reports a FIFO as workflow_read_error', async () => {
        const dir = await tempDir();
        const path = join(dir, 'pipe');
        execFileSync('mkfifo', [path]);
        const err = await asyncPolicyError(loadWorkflowFile({ path }));
        assert.equal(err.reason, 'workflow_read_error');
        assert.equal(err.path, path);
    });

    it('keeps the text it read available to the parser only', async () => {
        const dir = await tempDir();
        const path = join(dir, 'WORKFLOW.md');
        const text = '---\n---\nBody';
        await writeFile(path, text, 'utf8');
        const loaded = await loadWorkflowFile({ path });
        assert.equal(Object.values(loaded).includes(text), false);
        assert.equal(await readFile(path, 'utf8'), text);
    });
});
