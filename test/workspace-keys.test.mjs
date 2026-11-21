// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    workspaceKeyFor,
    resolveWorkspacePath,
    isInsideRoot
} from '../lib/agentic/workspace/index.mjs';
import {
    resolveWorkspaceRoot,
    assertDirectoryTarget,
    assertRealPathInsideRoot
} from '../lib/agentic/workspace/paths.mjs';
import { ConfigurationError, WorkspaceError } from '../lib/core/errors.mjs';

// Stage 1 of workspace isolation: deterministic keys and real-path containment.
// The public names come through the workspace barrel; the path guards are
// internal, so they are imported from `paths.mjs` directly.

/**
 * The same function seen with an `unknown` id, so the deliberately invalid
 * inputs type-check without an `any` cast or a suppression directive.
 * @type {(arg0: {workItemId: unknown}) => string}
 */
const callWithUnknownId = /** @type {(arg0: {workItemId: unknown}) => string} */ (workspaceKeyFor);

/**
 * Run a test body in a fresh temp directory and always clean it up.
 * @param {{fn: (arg0: {dir: string}) => Promise<void>}} arg0 -
 * @returns {Promise<void>}
 */
async function withTempDir({ fn }) {
    const dir = await mkdtemp(join(tmpdir(), 'merci-workspace-keys-'));
    try {
        await fn({ dir });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * Assert a synchronous throw is a WorkspaceError carrying `reason`.
 * @param {{fn: () => unknown, reason: string}} arg0 -
 * @returns {void}
 */
function assertThrowsWorkspace({ fn, reason }) {
    assert.throws(fn, (err) => {
        assert.ok(err instanceof WorkspaceError, `expected WorkspaceError, got ${err}`);
        assert.equal(err.reason, reason);
        assert.equal(err.code, 'MERCI-WORKSPACE-ERR');
        return true;
    });
}

/**
 * Assert a rejected promise is a WorkspaceError carrying `reason`.
 * @param {{fn: () => Promise<unknown>, reason: string}} arg0 -
 * @returns {Promise<void>}
 */
async function assertRejectsWorkspace({ fn, reason }) {
    await assert.rejects(fn, (err) => {
        assert.ok(err instanceof WorkspaceError, `expected WorkspaceError, got ${err}`);
        assert.equal(err.reason, reason);
        assert.equal(err.code, 'MERCI-WORKSPACE-ERR');
        return true;
    });
}

// --- key derivation (AC1) -------------------------------------------------

test('key: deterministic, ASCII-safe, 16-hex suffix', () => {
    const key = workspaceKeyFor({ workItemId: 'MER-42' });
    assert.equal(key, workspaceKeyFor({ workItemId: 'MER-42' }));
    assert.match(key, /^[A-Za-z0-9._-]+$/);
    assert.match(key, /-[0-9a-f]{16}$/);
    assert.ok(key.startsWith('MER-42-'), key);
});

test('key: ids that sanitize alike stay distinct, including case', () => {
    const ids = ['a/b', 'a\\b', 'a b', 'Foo', 'foo'];
    const keys = ids.map((id) => workspaceKeyFor({ workItemId: id }));
    assert.equal(new Set(keys).size, ids.length);
    assert.match(keys[0], /^a_b-/);
    assert.match(keys[1], /^a_b-/);
    assert.match(keys[2], /^a_b-/);
    assert.match(keys[3], /^Foo-/);
    assert.match(keys[4], /^foo-/);
});

test('key: NFC and NFD forms of the same text produce one key', () => {
    const nfc = 'caf\u00e9';
    const nfd = 'cafe\u0301';
    assert.notEqual(nfc, nfd);
    assert.equal(workspaceKeyFor({ workItemId: nfc }), workspaceKeyFor({ workItemId: nfd }));
});

test('key: two 200-character ids sharing a prefix stay distinct', () => {
    const prefix = 'x'.repeat(200);
    const a = workspaceKeyFor({ workItemId: `${prefix}a` });
    const b = workspaceKeyFor({ workItemId: `${prefix}b` });
    assert.equal(a.length, 48 + 1 + 16);
    assert.equal(a.slice(0, 48), prefix.slice(0, 48));
    assert.notEqual(a, b);
});

test('key: empty, dot ids, and non-string/number types throw ConfigurationError', () => {
    /** @type {Array<unknown>} */
    const invalidIds = ['', '   ', '.', '..', null, undefined, {}, []];
    for (const id of invalidIds) {
        assert.throws(() => callWithUnknownId({ workItemId: id }), (err) => {
            assert.ok(err instanceof ConfigurationError, `expected ConfigurationError for ${JSON.stringify(id)}, got ${err}`);
            return true;
        });
    }
});

test('key: NaN and Infinity are rejected', () => {
    for (const id of [NaN, Infinity, -Infinity]) {
        assert.throws(() => workspaceKeyFor({ workItemId: id }), (err) => {
            assert.ok(err instanceof ConfigurationError, `expected ConfigurationError for ${String(id)}, got ${err}`);
            return true;
        });
    }
    assert.match(workspaceKeyFor({ workItemId: 0 }), /^0-[0-9a-f]{16}$/);
});

test('key: a numeric id is accepted', () => {
    assert.match(workspaceKeyFor({ workItemId: 42 }), /^42-[0-9a-f]{16}$/);
});

// --- path containment (AC2) ----------------------------------------------

test('isInsideRoot: a prefix sibling is outside; the root itself is inside', () => {
    assert.equal(isInsideRoot({ root: '/root', path: '/root2' }), false);
    assert.equal(isInsideRoot({ root: '/root2', path: '/root' }), false);
    assert.equal(isInsideRoot({ root: '/root', path: '/root/a' }), true);
    assert.equal(isInsideRoot({ root: '/root', path: '/root' }), true);
});

test('resolveWorkspacePath: a traversal key is rejected as outside_root', () => {
    assertThrowsWorkspace({ fn: () => resolveWorkspacePath({ root: '/root', key: '../escape' }), reason: 'outside_root' });
    assertThrowsWorkspace({ fn: () => resolveWorkspacePath({ root: '/root', key: '/etc' }), reason: 'outside_root' });
    assert.equal(resolveWorkspacePath({ root: '/root', key: 'item-abc' }), '/root/item-abc');
});

test('resolveWorkspaceRoot: creates a missing root and returns its real path', () => withTempDir({ fn: async ({ dir }) => {
    const root = join(dir, 'nested', 'workspaces');
    const resolved = await resolveWorkspaceRoot({ root });
    assert.equal(resolved, await realpath(root));
    assert.equal((await stat(resolved)).isDirectory(), true);
} }));

test('resolveWorkspaceRoot: the filesystem root is refused unless allowed', async () => {
    await assert.rejects(() => resolveWorkspaceRoot({ root: '/' }), (err) => {
        assert.ok(err instanceof ConfigurationError, `expected ConfigurationError, got ${err}`);
        return true;
    });
    assert.equal(await resolveWorkspaceRoot({ root: '/', allowFilesystemRoot: true }), await realpath('/'));
});

test('resolveWorkspaceRoot: an existing regular file is refused', () => withTempDir({ fn: async ({ dir }) => {
    const file = join(await realpath(dir), 'root-file');
    await writeFile(file, 'x');
    await assert.rejects(() => resolveWorkspaceRoot({ root: file }), (err) => {
        assert.ok(err instanceof ConfigurationError, `expected ConfigurationError, got ${err}`);
        assert.equal(err.option, 'root');
        return true;
    });
} }));

test('resolveWorkspaceRoot: a symlink to the filesystem root is refused unless allowed', () => withTempDir({ fn: async ({ dir }) => {
    const link = join(await realpath(dir), 'to-root');
    await symlink('/', link);
    await assert.rejects(() => resolveWorkspaceRoot({ root: link }), (err) => {
        assert.ok(err instanceof ConfigurationError, `expected ConfigurationError, got ${err}`);
        return true;
    });
    assert.equal(await resolveWorkspaceRoot({ root: link, allowFilesystemRoot: true }), await realpath('/'));
} }));

test('resolveWorkspaceRoot: a symlinked configured root returns the real path', () => withTempDir({ fn: async ({ dir }) => {
    const base = await realpath(dir);
    const real = join(base, 'real-root');
    await mkdir(real);
    const link = join(base, 'link-root');
    await symlink(real, link);
    assert.equal(await resolveWorkspaceRoot({ root: link }), real);
} }));

test('assertDirectoryTarget: a directory and a missing path are fine', () => withTempDir({ fn: async ({ dir }) => {
    const root = await realpath(dir);
    await mkdir(join(root, 'workspace'));
    await assertDirectoryTarget({ root, path: join(root, 'workspace') });
    await assertDirectoryTarget({ root, path: join(root, 'not-created-yet') });
    await mkdir(join(root, 'parent'));
    await assertDirectoryTarget({ root, path: join(root, 'parent', 'not-created-yet') });
} }));

test('assertDirectoryTarget: a file is not_directory, a symlink is symlink', () => withTempDir({ fn: async ({ dir }) => {
    const root = await realpath(dir);
    const file = join(root, 'file.txt');
    await writeFile(file, 'x');
    await assertRejectsWorkspace({ fn: () => assertDirectoryTarget({ root, path: file }), reason: 'not_directory' });

    const outside = join(root, 'outside');
    await mkdir(outside);
    const link = join(root, 'link');
    await symlink(outside, link);
    await assertRejectsWorkspace({ fn: () => assertDirectoryTarget({ root, path: link }), reason: 'symlink' });
} }));

test('assertDirectoryTarget: a path outside the root is rejected', () => withTempDir({ fn: async ({ dir }) => {
    const root = await realpath(dir);
    await assertRejectsWorkspace({ fn: () => assertDirectoryTarget({ root, path: join(root, '..', 'elsewhere') }), reason: 'outside_root' });
} }));

test('assertDirectoryTarget: a missing target under a symlinked parent that escapes is outside_root', () => withTempDir({ fn: async ({ dir }) => {
    const base = await realpath(dir);
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, 'pivot'));

    // Nothing exists at root/pivot/ws yet; the missing tail is resolved through
    // the pivot, so the escape is caught before anything is created outside.
    await assertRejectsWorkspace({ fn: () => assertDirectoryTarget({ root, path: join(root, 'pivot', 'ws') }), reason: 'outside_root' });
    await assert.rejects(() => stat(join(outside, 'ws')), (err) => /** @type {{code?: string}} */ (err).code === 'ENOENT');
} }));

test('assert helpers: a relative path is refused', () => withTempDir({ fn: async ({ dir }) => {
    const root = await realpath(dir);
    await assert.rejects(() => assertDirectoryTarget({ root, path: 'relative/child' }), (err) => {
        assert.ok(err instanceof ConfigurationError, `expected ConfigurationError, got ${err}`);
        assert.equal(err.option, 'path');
        return true;
    });
    await assert.rejects(() => assertRealPathInsideRoot({ root, path: 'relative/child' }), (err) => {
        assert.ok(err instanceof ConfigurationError, `expected ConfigurationError, got ${err}`);
        assert.equal(err.option, 'path');
        return true;
    });
} }));

test('assertRealPathInsideRoot: a symlinked parent that escapes the root is outside_root', () => withTempDir({ fn: async ({ dir }) => {
    const base = await realpath(dir);
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    const insideDir = join(root, 'inside');
    await mkdir(root);
    await mkdir(insideDir);
    await mkdir(join(outside, 'target'), { recursive: true });
    await symlink(outside, join(root, 'escape'));

    // lstat alone sees a directory; only the real path reveals the escape.
    assert.equal((await lstat(join(root, 'escape', 'target'))).isDirectory(), true);
    await assertRejectsWorkspace({
        fn: () => assertRealPathInsideRoot({ root, path: join(root, 'escape', 'target') }),
        reason: 'outside_root'
    });
    await assertRejectsWorkspace({
        fn: () => assertDirectoryTarget({ root, path: join(root, 'escape', 'target') }),
        reason: 'outside_root'
    });

    await assertRealPathInsideRoot({ root, path: root });
    await assertRealPathInsideRoot({ root, path: insideDir });
} }));

test('assertRealPathInsideRoot: a missing path outside the root is outside_root; an in-root one passes', () => withTempDir({ fn: async ({ dir }) => {
    const base = await realpath(dir);
    const root = join(base, 'root');
    await mkdir(join(root, 'parent'), { recursive: true });

    // Nothing exists at either path; the nearest existing ancestor decides.
    await assertRejectsWorkspace({
        fn: () => assertRealPathInsideRoot({ root, path: join(base, 'sibling', 'missing') }),
        reason: 'outside_root'
    });
    await assertRealPathInsideRoot({ root, path: join(root, 'parent', 'missing') });
} }));
