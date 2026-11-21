// @ts-check

/**
 * `describe_shell_policy` is the answer to a host that overrides the tier:
 * the skill can only describe the SDK defaults, and this tool returns the
 * effective policy of the instance it was built with.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createShellTool, createShellPolicyTool } from '../lib/tools/shell-tools.mjs';

test('the policy reflects the defaults', async () => {
    const tool = createShellPolicyTool({ options: { roots: [process.cwd()] } });
    const policy = JSON.parse(String(await tool.execute({ args: {} })));
    assert.ok(policy.safeCommands.includes('rg'));
    assert.ok(policy.safeCommands.includes('ls'));
    assert.ok(policy.blockedCommands.includes('rm'));
    assert.ok(policy.blockedCommands.includes('bash'));
    assert.equal(policy.maxPipelineStages, 5);
    assert.ok(Array.isArray(policy.roots));
});

test('the policy reflects a host override', async () => {
    const tool = createShellPolicyTool({ options: {
        safeCommands: ['fd', 'rg'],
        blockedCommands: ['rm'],
        timeoutMs: 1234,
    } });
    const policy = JSON.parse(String(await tool.execute({ args: {} })));
    assert.deepEqual(policy.safeCommands, ['fd', 'rg']);
    assert.deepEqual(policy.blockedCommands, ['rm']);
    assert.equal(policy.timeoutMs, 1234);
});

test('a refusal names the tier a command was missing from', async () => {
    const shell = createShellTool({ options: {
        approvalCallback: async () => false,
        roots: [process.cwd()],
    } });
    const res = await shell.execute({ args: { command: 'fd', args: ['x'] } });
    assert.equal(res.success, false);
    assert.match(String(res.error), /denied/i);
    assert.match(String(res.error), /'fd' is not in this host's read-only tier/);
});

test('a path-qualified command is told to drop the path, not that it is off-tier', async () => {
    const shell = createShellTool({ options: {
        approvalCallback: async () => false,
        roots: [process.cwd()],
    } });
    const res = await shell.execute({ args: { command: '/bin/cat', args: ['package.json'] } });
    assert.equal(res.success, false);
    assert.match(String(res.error), /without a path/);
    assert.doesNotMatch(String(res.error), /'cat' is not in this host's read-only tier/);
});

test('the policy reports the cwd the gate actually enforces', async () => {
    const tool = createShellPolicyTool({ options: { cwd: tmpdir() } });
    const policy = JSON.parse(String(await tool.execute({ args: {} })));
    assert.equal(policy.roots.length, 1);
    assert.equal(policy.roots[0], realpathSync(tmpdir()));
});

test('the policy snapshots the arrays, like the gate does', async () => {
    const safe = ['rg'];
    const tool = createShellPolicyTool({ options: { safeCommands: safe } });
    safe.push('fd');
    const policy = JSON.parse(String(await tool.execute({ args: {} })));
    assert.deepEqual(policy.safeCommands, ['rg'], 'a later mutation must not disagree with the gate');
});

test('an option-level refusal does not blame the tier', async () => {
    const shell = createShellTool({ options: {
        approvalCallback: async () => false,
        roots: [process.cwd()],
    } });
    const res = await shell.execute({ args: { command: 'sort', args: ['-o', 'out.txt', 'in.txt'] } });
    assert.equal(res.success, false);
    assert.doesNotMatch(String(res.error), /read-only tier/);
});

test('a wrapper cannot carry a blocked command', async () => {
    // The blocklist has no HITL override, so a wrapper must not launder a
    // blocked command past it — under bypassPermissions this is the only layer.
    /** @type {Array<[string, string[]]>} */
    const cases = [
        ['nice', ['touch', 'x']],
        ['command', ['-p', 'touch', 'x']],
        ['timeout', ['5', 'touch', 'x']],
        ['find', ['.', '-exec', 'touch', 'x', ';']],
        // Two wrapper levels are unwrapped too.
        ['nice', ['-n', '5', 'timeout', '5', 'rm', '-rf', '/tmp/x']],
    ];
    for (const [command, args] of cases) {
        let asked = false;
        const shell = createShellTool({ options: { approvalCallback: async () => { asked = true; return true; } } });
        const res = await shell.execute({ args: { command, args } });
        assert.equal(res.success, false, `${command} ${args.join(' ')} must be blocked`);
        assert.equal(asked, false, 'the blocklist must answer before the HITL gate');
        assert.match(String(res.error), /blocklist/);
    }
});

test('a wrapper chain of any depth cannot carry a blocked command', async () => {
    // `sysctl` is blocked and has no side effect when it does run, so a
    // regression here fails the assertion instead of littering the repo.
    const payload = ['sysctl', '-n', 'hw.ncpu'];
    /** @type {Array<[string, string[]]>} */
    const cases = [
        // Proven under bypassPermissions: three `nice` levels used to spawn.
        ['nice', ['nice', 'nice', ...payload]],
        ['nice', ['nice', 'nice', 'nice', ...payload]],
        // Launchers that were absent from the table reached spawn directly.
        ['setsid', [...payload]],
        ['flock', ['-x', '/tmp/merci.lock', ...payload]],
        ['ionice', ['-c2', ...payload]],
        ['unbuffer', [...payload]],
        ['script', ['-q', '/dev/null', ...payload]],
        ['taskset', ['-c', '0', ...payload]],
        ['chrt', ['5', ...payload]],
        ['prlimit', ['--nofile=1024', ...payload]],
        // A shell string hides the command from argv unwrapping, so it is blocked.
        ['flock', ['-c', 'sysctl -n hw.ncpu', '/tmp/merci.lock']],
        ['script', ['-c', 'sysctl -n hw.ncpu']],
    ];
    /** @type {string[]} */
    const leaked = [];
    for (const [command, args] of cases) {
        let asked = false;
        const shell = createShellTool({ options: { approvalCallback: async () => { asked = true; return true; } } });
        const res = await shell.execute({ args: { command, args } });
        if (res.success || asked || !/blocklist/.test(String(res.error))) leaked.push(`${command} ${args.join(' ')}`);
    }
    assert.deepEqual(leaked, [], 'every wrapper form must be refused before the HITL gate');
});

test('a wrapper around a safe command still runs', async () => {
    let asked = false;
    const shell = createShellTool({ options: {
        approvalCallback: async () => { asked = true; return true; },
        roots: [process.cwd()],
    } });
    const res = await shell.execute({ args: { command: 'nice', args: ['echo', 'hi'] } });
    assert.equal(asked, true, 'the wrapper itself stays HITL-gated');
    assert.equal(res.success, true);
    assert.equal(String(res.stdout).trim(), 'hi');

    // Unwrapping is for the blocklist: a `find` with no executor is gated, not blocked.
    const found = await shell.execute({ args: { command: 'find', args: ['.', '-maxdepth', '0'] } });
    assert.equal(found.success, true);
    assert.doesNotMatch(String(found.error ?? ''), /blocklist/);
});
