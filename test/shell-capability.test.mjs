// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, existsSync, realpathSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createShellTool } from '../lib/tools/shell-tools.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/**
 * @returns {{ tool: any, asked: () => number, calls: Array<{command: string, args: string[]}> }}
 * @param {{options?: *, approve?: *}} arg0
 */
function makeTool({ options = {}, approve = false } = {}) {
    /** @type {Array<{command: string, args: string[]}>} */
    const calls = [];
    const tool = createShellTool({ options: {
        approvalCallback: async (/** @type {string} */ command, /** @type {string[]} */ args) => {
            calls.push({ command, args });
            return approve;
        },
        ...options,
    } });
    return { tool, asked: () => calls.length, calls };
}

describe('shell safe tier — argument policy (T1)', () => {
    it('`sort -o FILE` asks for approval instead of writing', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'sort', args: ['-o', 'out.txt', 'in.txt'] } });
        assert.equal(asked(), 1, 'sort -o writes a file and is not read-only');
        assert.equal(res.success, false);
    });

    it('`sort --output=FILE` asks for approval', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'sort', args: ['--output=out.txt', 'in.txt'] } });
        assert.equal(asked(), 1, 'long-form output flag is the same write vector');
        assert.equal(res.success, false);
    });

    it('`rg --pre COMMAND` asks for approval instead of spawning COMMAND', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'rg', args: ['--pre', 'echo', 'x', 'test/audit-p0.test.mjs'] } });
        assert.equal(asked(), 1, 'rg --pre launches an arbitrary command');
        assert.equal(res.success, false);
    });

    it('`rg --pre=COMMAND` asks for approval', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'rg', args: ['--pre=echo', 'x', 'test/audit-p0.test.mjs'] } });
        assert.equal(asked(), 1, 'attached-value form is the same execution vector');
        assert.equal(res.success, false);
    });

    it('`uniq IN OUT` asks for approval (two operands = output write)', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'uniq', args: ['in.txt', 'out.txt'] } });
        assert.equal(asked(), 1, 'a second positional operand is an output path');
        assert.equal(res.success, false);
    });

    it('`uniq -c FILE` stays safe (single input operand)', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'uniq', args: ['-c', 'package.json'] } });
        assert.equal(asked(), 0, 'reading one input file is read-only');
        assert.equal(res.success, true);
    });

    it('`xxd -r` asks for approval', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'xxd', args: ['-r', 'dump.hex', 'out.bin'] } });
        assert.equal(asked(), 1, 'reverse mode can write an output file');
        assert.equal(res.success, false);
    });

    it('`grep -f FILE` treats the operand as a path (outside roots → asks)', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'grep', args: ['-f', '/etc/passwd', 'package.json'] } });
        assert.equal(asked(), 1, '-f reads a pattern file and must be path-confined');
        assert.equal(res.success, false);
    });

    it('`grep -f FILE` inside the roots stays safe', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'grep', args: ['-f', '.gitignore', 'package.json'] } });
        assert.equal(asked(), 0, 'a pattern file inside the roots is not a capability');
        assert.equal(res.success, true);
    });

    it('an escalated safe command emits the existing HITL events', async () => {
        const eventEmitter = new EventEmitter();
        const seen = /** @type {Array<{name: string, payload: any}>} */ ([]);
        eventEmitter.on(EVENTS.SHELL.APPROVAL_REQUESTED, (payload) => seen.push({ name: 'requested', payload }));
        eventEmitter.on(EVENTS.SHELL.APPROVAL_DENIED, (payload) => seen.push({ name: 'denied', payload }));
        const tool = /** @type {any} */ (createShellTool({ options: { approvalCallback: async () => false, eventEmitter } }));
        await tool.execute({ args: { command: 'sort', args: ['-o', 'out.txt', 'in.txt'] } });
        assert.deepEqual(seen.map((e) => e.name), ['requested', 'denied']);
        assert.deepEqual(seen[0].payload.args, ['-o', 'out.txt', 'in.txt']);
        assert.equal(seen[0].payload.command, 'sort');
    });
});

describe('shell safe tier — path confinement (T2)', () => {
    it('`cat` inside the roots does NOT ask', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'cat', args: ['package.json'] } });
        assert.equal(asked(), 0, 'in-root reads stay unprompted');
        assert.equal(res.success, true);
    });

    it('`cat /etc/passwd` asks and is denied when the callback denies', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
        assert.equal(asked(), 1, 'host reads outside the roots are gated');
        assert.equal(res.success, false, 'denied by the gate');
    });

    it('`cat /etc/passwd` runs when the callback approves, with the unchanged signature', async () => {
        const { tool, calls } = makeTool({ options: {}, approve: true });
        const res = await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], { command: 'cat', args: ['/etc/passwd'] }, 'approvalCallback(command, args) is unchanged');
        assert.equal(res.success, true);
    });

    it('a `..` escape asks for approval', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'cat', args: ['../outside.txt'] } });
        assert.equal(asked(), 1, 'lexical parent traversal is path-like');
        assert.equal(res.success, false);
    });

    it('`roots: ["/"]` disables confinement (documented opt-out)', async () => {
        const { tool, asked } = makeTool({ options: { roots: ['/'] } });
        const res = await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
        assert.equal(asked(), 0, 'an explicit root of / covers every path');
        assert.equal(res.success, true);
    });

    it('blocked commands still reject before approval', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'rm', args: ['-rf', '/'] } });
        assert.equal(asked(), 0, 'blocklist rejects with no HITL override');
        assert.equal(res.success, false);
        assert.match(String(res.error), /blocklist/);
    });
});

describe('shell safe tier — option allowlist (default-deny)', () => {
    it('`file --compile` asks for approval AND writes nothing', async () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'merci-allow-')));
        writeFileSync(join(dir, 'magic'), '0\tstring\ttest\tx\n');
        let asked = 0;
        const tool = createShellTool({ options: {
            cwd: dir,
            roots: [dir],
            approvalCallback: async () => { asked += 1; return false; },
        } });
        const res = await tool.execute({ args: { command: 'file', args: ['--compile', '-m', './magic'] } });
        assert.equal(asked, 1, 'the long form of -C must reach the gate');
        assert.equal(res.success, false, 'denied by the gate');
        assert.ok(!existsSync(join(dir, 'magic.mgc')), 'no .mgc may be written');
    });

    /** @type {Array<[string, string[]]>} */
    const unlistedOptions = [
        ['file', ['--compile', '-m', 'magic']],
        ['ls', ['--frobnicate']],
        ['cat', ['-Z', 'package.json']],
        ['sort', ['--output', 'out', 'in']],
        ['sort', ['--compress-program=./x.sh', 'in']],
        ['rg', ['--pre', 'echo', 'x', 'file']],
        ['du', ['--files0-from=x']],
        ['xxd', ['-r', 'f']],
        ['man', ['--pager=cat', 'ls']],
        ['rg', ['-z', 'hello', 'package.json']],
        ['rg', ['-L', 'x', '.']],
        ['rg', ['--follow', 'x', '.']],
        ['ls', ['-L', '.']],
        ['du', ['-L', '.']],
        ['man', ['-M', '/tmp', 'ls']],
        ['file', ['-f', 'list.txt']],
        ['shasum', ['-c', 'sums.txt']],
        ['md5sum', ['--check', 'sums.txt']],
    ];
    for (const [command, args] of unlistedOptions) {
        it(`an unlisted option on \`${command}\` escalates: ${args.join(' ')}`, async () => {
            const { tool, asked } = makeTool({ options: { roots: ['/'] } });
            const res = await tool.execute({ args: { command, args } });
            assert.equal(asked(), 1, 'anything not on the allowlist must reach the gate');
            assert.equal(res.success, false, 'denied by the gate');
        });
    }

    /** @type {Array<[string, string[]]>} */
    const outsidePathOperands = [
        ['ls', ['-T', '/etc']],
        ['man', ['/etc/passwd']],
        ['mdls', ['/etc/passwd']],
        ['hexdump', ['-f', '/etc/passwd', 'package.json']],
        ['date', ['-f', '/etc/passwd']],
        ['mdfind', ['-onlyin', '/etc', 'x']],
    ];
    for (const [command, args] of outsidePathOperands) {
        it(`an out-of-root file operand on \`${command}\` escalates: ${args.join(' ')}`, async () => {
            const { tool, asked } = makeTool();
            await tool.execute({ args: { command, args } });
            assert.equal(asked(), 1, 'a read outside every root must be gated');
        });
    }

    it('a symlink + `..` traversal is confined', async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'merci-sympath-')));
        const root = join(base, 'root');
        mkdirSync(root);
        mkdirSync(join(base, 'inside'));
        writeFileSync(join(base, 'secret.txt'), 'SECRET_OUTSIDE_9f3a\n');
        writeFileSync(join(root, 'in.txt'), 'alpha\n');
        symlinkSync(join(base, 'inside'), join(root, 'link'));
        const { tool, asked } = makeTool({ options: { cwd: root, roots: [root] } });
        const res = await tool.execute({ args: { command: 'cat', args: ['link/../secret.txt'] } });
        assert.equal(asked(), 1, 'symlink + .. must not collapse back inside the root');
        assert.doesNotMatch(String(res.stdout ?? ''), /SECRET_OUTSIDE/, 'the outside file must never be read');
    });

    it('file-flag operands are confined in attached, separated and backslash forms', async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'merci-fileflag-')));
        const root = join(base, 'root');
        mkdirSync(root);
        const outside = join(base, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'fmt.txt'), '0\tbyte\t\\0\n');
        writeFileSync(join(root, 'in.txt'), 'hello\n');
        symlinkSync(outside, join(root, '-x'));
        symlinkSync(join(outside, 'fmt.txt'), join(root, '-xfmt'));
        symlinkSync(outside, join(root, 'x\\y'));

        /** @type {Array<[string, string[]]>} */
        const escapes = [
            ['hexdump', ['-f-x/fmt.txt', 'in.txt']],
            ['hexdump', ['-f', '-xfmt', 'in.txt']],
            ['cat', ['x\\y/fmt.txt']],
        ];
        for (const [command, args] of escapes) {
            const { tool, asked } = makeTool({ options: { cwd: root, roots: [root] } });
            await tool.execute({ args: { command, args } });
            assert.equal(asked(), 1, `\`${command} ${args.join(' ')}\` must not read outside the root`);
        }

        const { tool, asked } = makeTool({ options: { cwd: root, roots: [root] } });
        await tool.execute({ args: { command: 'hexdump', args: ['-f', 'in.txt', 'in.txt'] } });
        assert.equal(asked(), 0, 'an in-root format file must stay unprompted');
    });

    it('a bundled cluster with one unlisted letter escalates', async () => {
        const { tool, asked } = makeTool();
        await tool.execute({ args: { command: 'sort', args: ['-so', 'out', 'in'] } });
        assert.equal(asked(), 1, '-so carries the unlisted -o');
    });

    /** @type {Array<[string, string[]]>} */
    const commonReads = [
        ['ls', ['-la']],
        ['head', ['-n', '5', 'package.json']],
        ['head', ['-5', 'package.json']],
        ['tail', ['-n', '5', 'package.json']],
        ['wc', ['-l', 'package.json']],
        ['grep', ['-rn', 'MerciError', 'lib']],
        ['rg', ['-i', 'mercierror', 'lib']],
        ['ps', ['aux']],
        ['sort', ['-n', 'package.json']],
        ['sort', ['-k2', 'package.json']],
        ['cut', ['-d,', '-f1', 'package.json']],
        ['xxd', ['-s', '0', '-l', '16', 'package.json']],
        ['uniq', ['-c', 'package.json']],
        ['diff', ['-u', 'package.json', 'package.json']],
        ['du', ['-sh', '.']],
        ['man', ['ls']],
    ];
    for (const [command, args] of commonReads) {
        it(`a read-only invocation stays silent: \`${command} ${args.join(' ')}\``, async () => {
            const { tool, asked } = makeTool();
            await tool.execute({ args: { command, args } });
            assert.equal(asked(), 0, 'ordinary reads must not prompt');
        });
    }
});

describe('shell safe tier — recursive reads cannot follow a symlink out of the roots', () => {
    it('`diff -r` asks for approval (it dereferences an in-root directory symlink)', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'diff', args: ['-r', '.', './sub'] } });
        assert.equal(asked(), 1, 'recursive diff can read content outside the roots');
        assert.equal(res.success, false);
    });

    it('`diff --recursive` asks for approval', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'diff', args: ['--recursive', '.', './sub'] } });
        assert.equal(asked(), 1);
        assert.equal(res.success, false);
    });

    it('`diff -u FILE FILE` stays safe (non-recursive)', async () => {
        const { tool, asked } = makeTool();
        await tool.execute({ args: { command: 'diff', args: ['-u', 'package.json', 'package.json'] } });
        assert.equal(asked(), 0);
    });

    it('`grep -R` asks for approval (GNU follows every symlink)', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'grep', args: ['-R', 'pattern', '.'] } });
        assert.equal(asked(), 1, '-R/--dereference-recursive can print content outside the roots');
        assert.equal(res.success, false);
    });

    it('`grep -r` stays safe (only command-line symlinks are followed, which confinement resolves)', async () => {
        const { tool, asked } = makeTool();
        await tool.execute({ args: { command: 'grep', args: ['-rn', 'MerciError', 'lib'] } });
        assert.equal(asked(), 0);
    });

    it('`tldr --render <outside file>` asks for approval', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'tldr', args: ['--render', '/etc/passwd'] } });
        assert.equal(asked(), 1, 'the render operand is a file path and must be root-confined');
        assert.equal(res.success, false);
    });

    it('`tldr <page>` stays safe (an in-root page name)', async () => {
        const { tool, asked } = makeTool();
        await tool.execute({ args: { command: 'tldr', args: ['ls'] } });
        assert.equal(asked(), 0);
    });
});

describe('shell approval — permission modes', () => {
    it('default asks once and honors a denial', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
        assert.equal(asked(), 1, 'the default mode still gates the shell');
        assert.equal(res.success, false);
    });

    it('bypassPermissions runs a gated command without asking', async () => {
        const { tool, asked } = makeTool({ options: { permissionMode: 'bypassPermissions' } });
        const res = await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
        assert.equal(asked(), 0);
        assert.equal(res.success, true);
    });

    it('bypassPermissions announces the bypass once and grants no approval', async () => {
        const eventEmitter = new EventEmitter();
        /** @type {string[]} */
        const granted = [];
        /** @type {any[]} */
        const bypass = [];
        eventEmitter.on(EVENTS.SHELL.APPROVAL_GRANTED, () => granted.push('granted'));
        eventEmitter.on(EVENTS.PERMISSIONS.BYPASS, (/** @type {any} */ envelope) => bypass.push(envelope.payload ?? envelope));
        const tool = createShellTool({ options: { permissionMode: 'bypassPermissions', eventEmitter } });
        const res = await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
        assert.equal(res.success, true);
        assert.deepEqual(granted, [], 'no real callback ran, so nothing was granted');
        assert.equal(bypass.length, 1, 'construction announces the dangerous mode once');
        assert.equal(bypass[0].mode, 'bypassPermissions');
        assert.equal(bypass[0].target, 'shell');

        await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
        assert.equal(bypass.length, 1, 'a bypassed command does not re-announce');
    });

    it('default and acceptEdits do not announce a bypass', () => {
        for (const permissionMode of /** @type {Array<import('../lib/agentic/permissions.mjs').PermissionMode>} */ (['default', 'acceptEdits'])) {
            const eventEmitter = new EventEmitter();
            let announced = 0;
            eventEmitter.on(EVENTS.PERMISSIONS.BYPASS, () => { announced += 1; });
            createShellTool({ options: { approvalCallback: () => false, permissionMode, eventEmitter } });
            assert.equal(announced, 0, `${permissionMode} must not announce a bypass`);
        }
    });

    it('hostile permissionMode values still ask once and can deny', async () => {
        for (const permissionMode of /** @type {any[]} */ (['BYPASS', {}, true, null, []])) {
            const { tool, asked } = makeTool({ options: { permissionMode } });
            const res = await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
            assert.equal(asked(), 1, `${String(permissionMode)} must still prompt`);
            assert.equal(res.success, false, `${String(permissionMode)} can be denied`);
        }
    });

    it('acceptEdits still asks for the shell', async () => {
        const { tool, asked } = makeTool({ options: { permissionMode: 'acceptEdits' } });
        const res = await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
        assert.equal(asked(), 1, 'running code is not an edit');
        assert.equal(res.success, false);
    });

    it('only bypassPermissions may omit the callback', async () => {
        const tool = createShellTool({ options: { permissionMode: 'bypassPermissions' } });
        const res = await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
        assert.equal(res.success, true, 'the explicit dangerous opt-in needs no callback');

        assert.throws(() => createShellTool({ options: {} }), /approvalCallback/);
        assert.throws(() => createShellTool({ options: { permissionMode: 'acceptEdits' } }), /approvalCallback/);
    });
});
