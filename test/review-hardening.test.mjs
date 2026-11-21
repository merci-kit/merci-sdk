// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, chmodSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createShellTool } from '../lib/tools/shell-tools.mjs';
import { LocalFileMemoryProvider, CompositeMemoryProvider } from '../lib/agentic/memory/providers.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';
import { LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { createSaveArtifactTool } from '../lib/agentic/artifacts.mjs';
import { estimateTokens, estimateMessageTokens, safeStringify } from '../lib/support/utils.mjs';
import { InactivityTimeoutPolicy } from '../lib/support/stream-timeout.mjs';
import { runCommand, RUN_COMMAND_TIMEOUT_CODE } from '../lib/support/run-command.mjs';
import { aaiAdapter } from '../lib/backends/adapters/aai-adapter.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { TodoComponent } from '../lib/agentic/todos/component.mjs';

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

describe('R1: shell safe tier — write primitives that evaded the arg policy', () => {
    it('a bundled short flag (`sort -so OUT IN`) asks for approval', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'sort', args: ['-so', 'out.txt', 'in.txt'] } });
        assert.equal(asked(), 1, '-so carries -o and writes a file');
        assert.equal(res.success, false);
    });

    it('other bundled forms of a write flag also ask', async () => {
        for (const bundled of ['-uo', '-no', '-ro']) {
            const { tool, asked } = makeTool();
            await tool.execute({ args: { command: 'sort', args: [bundled, 'out.txt', 'in.txt'] } });
            assert.equal(asked(), 1, `${bundled} must escalate`);
        }
    });

    it('`xxd IN OUT` asks for approval (second positional is the output file)', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'xxd', args: ['in.txt', 'out.txt'] } });
        assert.equal(asked(), 1, 'xxd takes [infile [outfile]] and writes');
        assert.equal(res.success, false);
    });

    it('a plain `sort IN` still does NOT ask', async () => {
        const { tool, asked } = makeTool();
        await tool.execute({ args: { command: 'sort', args: ['package.json'] } });
        assert.equal(asked(), 0, 'read-only safe-tier use stays unprompted');
    });
});

describe('R2: shell execution uses the command as given, not its basename', () => {
    it('a path-qualified command never inherits safe-tier treatment', async () => {
        const { tool, calls } = makeTool();
        await tool.execute({ args: { command: './cat', args: ['package.json'] } });
        assert.equal(calls.length, 1, 'a path-qualified command is an arbitrary script');
        assert.equal(calls[0].command, './cat', 'the operator is shown the real path, not "cat"');
    });

    it('spawns the workspace script, not a same-named $PATH impostor', async () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'merci-pathhijack-')));
        const impostorBin = join(dir, 'bin');
        const work = join(dir, 'work');
        mkdirSync(impostorBin, { recursive: true });
        mkdirSync(join(work, 'scripts'), { recursive: true });
        const impostor = join(impostorBin, 'probe.sh');
        const real = join(work, 'scripts', 'probe.sh');
        writeFileSync(impostor, '#!/bin/sh\necho I_AM_THE_PATH_IMPOSTOR\n');
        writeFileSync(real, '#!/bin/sh\necho I_AM_THE_WORKSPACE_SCRIPT\n');
        chmodSync(impostor, 0o755);
        chmodSync(real, 0o755);

        const prevPath = process.env.PATH;
        process.env.PATH = `${impostorBin}:${prevPath}`;
        try {
            const { tool } = makeTool({ options: { cwd: work, roots: [work] }, approve: true });
            const res = await tool.execute({ args: { command: './scripts/probe.sh', args: [] } });
            assert.equal(res.success, true, 'a relative script path must be runnable at all');
            assert.match(String(res.stdout), /I_AM_THE_WORKSPACE_SCRIPT/);
            assert.doesNotMatch(String(res.stdout), /IMPOSTOR/, '$PATH must not shadow the workspace file');
        } finally {
            process.env.PATH = prevPath;
        }
    });

    it('the blocklist still matches on the basename of a path-qualified command', async () => {
        const { tool, asked } = makeTool({ approve: true });
        const res = await tool.execute({ args: { command: '/bin/rm', args: ['-rf', 'x'] } });
        assert.equal(res.success, false, 'blocked commands have no HITL override');
        assert.match(String(res.error), /blocklist/);
        assert.equal(asked(), 0, 'the blocklist is checked before the gate');
    });
});

describe('R3: shell roots are realpath-normalized', () => {
    it('a safe read inside a symlinked root does NOT ask', async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'merci-symroot-')));
        const realDir = join(base, 'real');
        const linkDir = join(base, 'link');
        mkdirSync(realDir, { recursive: true });
        writeFileSync(join(realDir, 'note.txt'), 'hello\n');
        symlinkSync(realDir, linkDir);

        const { tool, asked } = makeTool({ options: { cwd: linkDir, roots: [linkDir] }, approve: true });
        const res = await tool.execute({ args: { command: 'cat', args: ['note.txt'] } });
        assert.equal(asked(), 0, 'an in-root read through a symlinked root must stay unprompted');
        assert.equal(res.success, true);
    });

    it('an outside-root read through a symlinked root still asks', async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'merci-symroot-esc-')));
        const realDir = join(base, 'real');
        const linkDir = join(base, 'link');
        mkdirSync(realDir, { recursive: true });
        writeFileSync(join(base, 'outside.txt'), 'secret\n');
        symlinkSync(realDir, linkDir);

        const { tool, asked } = makeTool({ options: { cwd: linkDir, roots: [linkDir] } });
        await tool.execute({ args: { command: 'cat', args: ['../outside.txt'] } });
        assert.equal(asked(), 1, 'confinement still holds for a realpath-normalized root');
    });
});

describe('R4: memory delete argument shape', () => {
    it('CompositeMemoryProvider.delete actually deletes', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-memdel-'));
        const bank = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'a.json'), name: 'a' } });
        const composite = new CompositeMemoryProvider({ providers: [bank] });
        const fact = /** @type {any} */ (await composite.store({ content: 'a deletable fact' }));
        assert.ok(fact && fact.id, 'stored');
        const deleted = await composite.delete({ id: fact.id });
        assert.equal(deleted, true, 'composite delete reports the deletion');
        assert.equal(bank.facts.length, 0, 'and the fact is really gone');
    });

    it('deleting an unknown id reports false', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-memdel-miss-'));
        const bank = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'a.json'), name: 'a' } });
        const composite = new CompositeMemoryProvider({ providers: [bank] });
        await composite.store({ content: 'keep me' });
        assert.equal(await composite.delete({ id: 'nope' }), false);
        assert.equal(bank.facts.length, 1, 'a missed delete removes nothing');
    });
});

describe('R5: estimateTokens counts content-block arrays', () => {
    it('an Anthropic text-block row is not scored zero', () => {
        const big = 'x'.repeat(2000);
        const tokens = estimateMessageTokens({ messages: [{ role: 'assistant', content: [{ type: 'text', text: big }] }] });
        assert.equal(tokens, 500);
    });

    it('a multimodal row counts its text part', () => {
        const big = 'x'.repeat(2000);
        const tokens = estimateMessageTokens({ messages: [{ role: 'user', content: [
            { type: 'text', text: big },
            { type: 'image_url', image_url: { url: 'http://example.test/a.png' } },
        ] }] });
        assert.equal(tokens, 500);
    });

    it('the previously asserted shapes are unchanged', () => {
        assert.equal(estimateTokens({ text: '' }), 0);
        assert.equal(estimateTokens({ text: null }), 0);
        assert.equal(estimateTokens({ text: 'abcd' }), 1);
        assert.equal(estimateTokens({ text: [{ content: 'abcd' }, { content: 'efgh' }] }), 2);
        assert.equal(estimateTokens({ text: [{ content: 'abcd' }, { role: 'tool', content: '1234' }] }), 2);
    });
});

describe('R6: safeStringify distinguishes shared refs from cycles', () => {
    it('a shared acyclic reference is serialized twice, not marked circular', () => {
        const shared = { k: 'v' };
        assert.equal(safeStringify({ value: { a: shared, b: shared } }), '{"a":{"k":"v"},"b":{"k":"v"}}');
    });

    it('a true self-cycle is still marked', () => {
        /** @type {any} */
        const cyc = { name: 'root' };
        cyc.self = cyc;
        assert.equal(safeStringify({ value: cyc }), '{"name":"root","self":"[circular]"}');
    });

    it('a mutual cycle is still marked', () => {
        /** @type {any} */
        const a = { n: 1 };
        a.b = { a };
        assert.equal(safeStringify({ value: a }), '{"n":1,"b":{"a":"[circular]"}}');
    });

    it('bigint is still stringified', () => {
        assert.equal(safeStringify({ value: { big: 10n } }), '{"big":"10"}');
    });
});

describe('R7: stream timeout honors a pre-aborted signal', () => {
    it('a signal aborted before wrapping throws and consumes nothing', async () => {
        const policy = new InactivityTimeoutPolicy({ timeoutMs: 5000 });
        async function* src() { yield 'a'; yield 'b'; }
        const ac = new AbortController();
        ac.abort(new Error('pre-aborted'));
        /** @type {string[]} */
        const seen = [];
        await assert.rejects(async () => {
            for await (const chunk of policy.wrapStream({ stream: src(), signal: ac.signal })) seen.push(chunk);
        }, /abort/i);
        assert.deepEqual(seen, [], 'a pre-aborted stream must not be consumed');
    });

    it('a stream with no signal still passes through', async () => {
        const policy = new InactivityTimeoutPolicy({ timeoutMs: 5000 });
        async function* src() { yield 'a'; yield 'b'; }
        /** @type {string[]} */
        const seen = [];
        for await (const chunk of policy.wrapStream({ stream: src(), signal: null })) seen.push(chunk);
        assert.deepEqual(seen, ['a', 'b']);
    });
});

describe('R10: safe-tier option VALUES are not treated as positionals or flag letters', () => {
    /** @type {Array<[string, string[]]>} */
    const silent = [
        ['xxd', ['-l', '64', 'package.json']],
        ['xxd', ['-c', '16', 'package.json']],
        ['xxd', ['-s', '0x10', '-l', '64', 'package.json']],
        ['xxd', ['-ps', 'package.json']],
        ['sort', ['-to', 'package.json']],
        ['sort', ['-k', '2', 'package.json']],
        ['uniq', ['-f', '1', 'package.json']],
        ['grep', ['-rf', '.gitignore', '.']],
        ['rg', ['-if', '.gitignore', 'package.json']],
    ];
    for (const [command, args] of silent) {
        it(`\`${command} ${args.join(' ')}\` does NOT ask`, async () => {
            const { tool, asked } = makeTool({ options: { roots: ['/'] } });
            await tool.execute({ args: { command, args } });
            assert.equal(asked(), 0, 'read-only invocation must not prompt');
        });
    }

    /** @type {Array<[string, string[]]>} */
    const gated = [
        ['xxd', ['in.txt', 'out.txt']],
        ['uniq', ['in.txt', 'out.txt']],
        ['sort', ['-so', 'out.txt', 'in.txt']],
        ['man', ['-aP', 'less', 'ls']],
    ];
    for (const [command, args] of gated) {
        it(`\`${command} ${args.join(' ')}\` asks`, async () => {
            const { tool, asked } = makeTool({ options: { roots: ['/'] } });
            await tool.execute({ args: { command, args } });
            assert.equal(asked(), 1, 'write/exec invocation must be gated');
        });
    }

    /** @type {Array<[string, string[]]>} */
    const valueFlagSwallow = [
        ['sort', ['-k', '-o', 'out.txt', 'in.txt']],
        ['sort', ['-S', '-o', 'out.txt', 'in.txt']],
        ['xxd', ['-l', '-r', 'in.txt']],
        ['xxd', ['-o', '-r', 'in.txt']],
    ];
    for (const [command, args] of valueFlagSwallow) {
        it(`a value flag does not swallow the write flag in \`${command} ${args.join(' ')}\``, async () => {
            const { tool, asked } = makeTool({ options: { roots: ['/'] } });
            await tool.execute({ args: { command, args } });
            assert.equal(asked(), 1, 'the following write flag must still be seen');
        });
    }

    it('`sort -T/tmp` is still path-confined (default roots)', async () => {
        const { tool, asked } = makeTool();
        await tool.execute({ args: { command: 'sort', args: ['-T/tmp'] } });
        assert.equal(asked(), 1, 'a temp dir outside the roots must be gated');
    });
});

describe('R15: safe-tier options that execute a program or read an unconfinable path', () => {
    /** @type {Array<[string, string[]]>} */
    const mustGate = [
        ['sort', ['--compress-program=./x.sh', 'in.txt']],
        ['sort', ['--compress-program', './x.sh', 'in.txt']],
        ['sort', ['--files0-from=list']],
        ['sort', ['--files0-from', 'list']],
        ['sort', ['--random-source=/etc/passwd', 'in.txt']],
        ['du', ['--files0-from=list']],
        ['wc', ['--files0-from=list']],
        ['file', ['-C', '-m', 'magic']],
        ['man', ['-H/tmp/x.sh', 'ls']],
        ['man', ['--html=./x.sh', 'ls']],
    ];
    for (const [command, args] of mustGate) {
        it(`\`${command} ${args.join(' ')}\` asks for approval`, async () => {
            const { tool, asked } = makeTool({ options: { roots: ['/'] } });
            await tool.execute({ args: { command, args } });
            assert.equal(asked(), 1, 'exec / unconfinable-read options must be gated');
        });
    }

    /** @type {Array<[string, string[]]>} */
    const mustStaySilent = [
        ['sort', ['package.json']],
        ['sort', ['-k', '2', 'package.json']],
        ['file', ['package.json']],
        ['wc', ['-l', 'package.json']],
        ['du', ['-sh', '.']],
        ['man', ['ls']],
    ];
    for (const [command, args] of mustStaySilent) {
        it(`\`${command} ${args.join(' ')}\` does NOT ask`, async () => {
            const { tool, asked } = makeTool({ options: { roots: ['/'] } });
            await tool.execute({ args: { command, args } });
            assert.equal(asked(), 0, 'ordinary read-only use must stay unprompted');
        });
    }
});

describe('R11: SIGKILL escalation survives every settle path', () => {
    /** @param {{dir: string, body: string}} arg0 */
    const stubborn = ({ dir, body }) => {
        const script = join(dir, 'stubborn.sh');
        writeFileSync(script, `#!/bin/sh\ntrap '' TERM\n${body}\n`);
        chmodSync(script, 0o755);
        return script;
    };

    /** @param {string} script */
    const aliveCount = (script) =>
        execFileSync('/bin/sh', ['-c', `pgrep -f ${script} | wc -l`]).toString().trim();

    it('a deadline still escalates, and a noisy command is truncated, not killed', { timeout: 20_000 }, async () => {
        // F2-9: the output cap bounds the buffer, not the child, so the two
        // settle paths split. A bounded deadline still has to reap a child that
        // ignores SIGTERM, and a chatty command that finishes must keep its own
        // exit code.
        const dir = mkdtempSync(join(tmpdir(), 'merci-maxbuf-'));
        const script = stubborn({ dir, body: 'while :; do echo AAAAAAAAAAAAAAAAAAAAAAAA; done' });
        await assert.rejects(
            () => runCommand({ command: script, args: [], maxBuffer: 2048, timeoutMs: 500 }),
            (error) => /** @type {{code?: string}} */ (error).code === RUN_COMMAND_TIMEOUT_CODE
        );
        // The SIGKILL escalation runs after the grace window; poll instead of
        // sleeping a fixed span, and fail loudly rather than hang.
        const deadline = Date.now() + 5_000;
        while (aliveCount(script) !== '0' && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(aliveCount(script), '0', 'the deadline must reap a child SIGTERM could not');

        const noisy = await runCommand({
            command: process.execPath,
            args: ['-e', "process.stdout.write('x'.repeat(200000))"],
            maxBuffer: 2048
        });
        assert.equal(noisy.code, 0, 'the cap is not a kill: the command finished on its own');
        assert.equal(noisy.truncated, true);
        assert.ok(noisy.stdout.length <= 2048);
    });

    it('an aborted command still escalates', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-sigkill-'));
        const script = stubborn({ dir, body: 'sleep 30' });
        const ac = new AbortController();
        setTimeout(() => ac.abort(new Error('cancel')), 150);
        await assert.rejects(() => runCommand({ command: script, args: [], signal: ac.signal }));
        await new Promise((r) => setTimeout(r, 1800));
        assert.equal(aliveCount(script), '0', 'the child must not survive an aborted command');
    });

    it('a normal command leaves no lingering timer', async () => {
        const res = await runCommand({ command: 'echo', args: ['ok'] });
        assert.equal(res.code, 0);
        const timers = process.getActiveResourcesInfo().filter((r) => r === 'Timeout');
        assert.equal(timers.length, 0, 'a successful command must not leave a kill timer armed');
    });
});

describe('R14: Anthropic thinking budget never lands below the 1024 floor', () => {
    /** @param {{max_tokens?: number, budget: number}} arg0 */
    const build = ({ max_tokens, budget }) => aaiAdapter.buildVendorRequest({
        model: 'claude-opus-5',
        parameters: { ...(max_tokens === undefined ? {} : { max_tokens }), thinking: { type: 'enabled', budget_tokens: budget } },
        tools: [],
        preparedMessages: [{ role: 'user', content: 'hi' }],
    }).request;

    it('raises max_tokens rather than emitting a sub-floor budget', () => {
        const req = build({ max_tokens: 500, budget: 2048 });
        assert.ok(req.thinking.budget_tokens >= 1024, `budget ${req.thinking.budget_tokens} is below the floor`);
        assert.ok(req.max_tokens > req.thinking.budget_tokens, 'max_tokens must exceed the budget');
    });

    it('still clamps under max_tokens when there is room above the floor', () => {
        const req = build({ max_tokens: 4096, budget: 8192 });
        assert.equal(req.thinking.budget_tokens, 4095);
        assert.equal(req.max_tokens, 4096, 'a roomy max_tokens is left alone');
    });

    it('leaves a already-valid budget untouched', () => {
        const req = build({ max_tokens: 8192, budget: 2048 });
        assert.equal(req.thinking.budget_tokens, 2048);
        assert.equal(req.max_tokens, 8192);
    });
});

describe('R12: safeStringify output stays bounded on a dense DAG', () => {
    it('a deep diamond does not blow up the serialized size', () => {
        /** @type {any} */
        let node = { leaf: true };
        for (let i = 0; i < 24; i++) node = { l: node, r: node };
        const out = safeStringify({ value: node });
        assert.ok(out.length < 2_000_000, `expected a bounded string, got ${out.length} chars`);
        assert.match(out, /\[truncated\]/, 'the budget should be visible in the output');
    });
});

describe('R13: estimateTokens handles structured block payloads', () => {
    it('a tool_use block counts its structured input', () => {
        const tokens = estimateMessageTokens({ messages: [{ role: 'assistant', content: [
            { type: 'tool_use', name: 't', input: { q: 'x'.repeat(10000) } },
        ] }] });
        assert.ok(tokens > 2000, `expected the input to be counted, got ${tokens}`);
    });

    it('a thinking block is counted', () => {
        const tokens = estimateMessageTokens({ messages: [{ role: 'assistant', content: [
            { type: 'thinking', thinking: 'x'.repeat(2000) },
        ] }] });
        assert.equal(tokens, 500);
    });

    it('a base64 image is NOT counted by length (no pathological compaction)', () => {
        const tokens = estimateMessageTokens({ messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', data: 'A'.repeat(200000) } },
        ] }] });
        assert.equal(tokens, 0, 'image bytes must not be charged as text tokens');
    });
});

describe('R9: a transient todo-store read failure does not destroy the list', () => {
    it('a failed hydrate is retried instead of being marked done and overwritten', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-todo-hydrate-'));
        const filePath = join(dir, 'todos.json');
        writeFileSync(filePath, JSON.stringify({
            version: '1.0',
            updatedAt: Date.now(),
            tasks: [{ id: 1, title: 'keep one', status: 'pending' }, { id: 2, title: 'keep two', status: 'pending' }],
        }));

        const component = new TodoComponent({ filePath });
        chmodSync(filePath, 0o000);
        await component.load();
        chmodSync(filePath, 0o644);

        const res = /** @type {any} */ (await component.save({ args: { action: 'add', title: 'new task' } }));
        assert.equal(res.success, true);
        const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
        assert.deepEqual(
            onDisk.tasks.map((/** @type {any} */ t) => t.title),
            ['keep one', 'keep two', 'new task'],
            'the persisted tasks must survive a transient read failure',
        );
        assert.equal(res.task.id, 3, 'and the new id must not collide with a task it never loaded');
    });

    it('a normal add still persists', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-todo-normal-'));
        const filePath = join(dir, 'todos.json');
        writeFileSync(filePath, JSON.stringify({
            version: '1.0',
            updatedAt: Date.now(),
            tasks: [{ id: 1, title: 'existing', status: 'pending' }],
        }));
        const component = new TodoComponent({ filePath });
        await component.load();
        await component.save({ args: { action: 'add', title: 'fresh task' } });
        const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
        assert.deepEqual(onDisk.tasks.map((/** @type {any} */ t) => t.title), ['existing', 'fresh task']);
    });
});

describe('R8: state machine per-run contract override is scoped', () => {
    const graph = () => ({
        entry: 'a',
        nodes: [{ id: 'a', execute: () => 'x', terminal: true }],
        edges: [],
    });

    it('the override governs its own run and the instance contract is restored', async () => {
        let instanceChecks = 0;
        let overrideChecks = 0;
        const instanceContract = { criteria: [{ name: 'instance', check: () => { instanceChecks++; return { passed: true }; } }] };
        const sm = new StateMachine({ graph: graph(), options: { contract: instanceContract } });

        await sm.run({ contract: { criteria: [{ name: 'override', check: () => { overrideChecks++; return { passed: true }; } }] } });
        assert.equal(overrideChecks, 1, 'the override gate ran');
        assert.equal(instanceChecks, 0, 'the instance gate was displaced for that run');

        const sm2 = new StateMachine({ graph: graph(), options: { contract: instanceContract } });
        await sm2.run();
        assert.equal(instanceChecks, 1, 'the instance contract is intact and still enforced');
        assert.equal(overrideChecks, 1, 'the previous override did not leak');
    });

    it('a run with no override still enforces the instance contract', async () => {
        let checks = 0;
        const sm = new StateMachine({ graph: graph(), options: {
            contract: { criteria: [{ name: 'only', check: () => { checks++; return { passed: true }; } }] },
        } });
        await sm.run();
        assert.equal(checks, 1);
    });
});

describe('R16: memory tombstones are durable, so a delete/clear cannot resurrect', () => {
    /** @returns {string} */
    const tmp = () => mkdtempSync(join(tmpdir(), 'merci-r16-'));

    it('a concurrent writer cannot resurrect a deleted fact', async () => {
        const dir = tmp();
        const filePath = join(dir, 'bank.json');
        try {
            const p1 = new LocalFileMemoryProvider({ options: { filePath } });
            const a = /** @type {any} */ (await p1.store({ content: 'FACT A' }));
            const p2 = new LocalFileMemoryProvider({ options: { filePath } });
            await p2.load();
            await p1.delete({ id: a.id });
            await p2.store({ content: 'FACT B' });
            const fresh = new LocalFileMemoryProvider({ options: { filePath } });
            await fresh.load();
            assert.deepEqual(fresh.facts.map(f => f.content), ['FACT B'], 'the deleted fact must stay deleted');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a concurrent writer cannot resurrect a cleared bank', async () => {
        const dir = tmp();
        const filePath = join(dir, 'bank.json');
        try {
            const p1 = new LocalFileMemoryProvider({ options: { filePath } });
            await p1.store({ content: 'FACT A' });
            await p1.store({ content: 'FACT B' });
            const p2 = new LocalFileMemoryProvider({ options: { filePath } });
            await p2.load();
            await p1.clear();
            await p2.store({ content: 'FACT C' });
            const fresh = new LocalFileMemoryProvider({ options: { filePath } });
            await fresh.load();
            assert.deepEqual(fresh.facts.map(f => f.content), ['FACT C'], 'a cleared bank must not come back');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a clear on a fresh instance tombstones the facts still on disk', async () => {
        const dir = tmp();
        const filePath = join(dir, 'bank.json');
        try {
            const writer = new LocalFileMemoryProvider({ options: { filePath } });
            await writer.store({ content: 'PRECIOUS' });
            const stale = new LocalFileMemoryProvider({ options: { filePath } });
            await stale.load();
            const clearer = new LocalFileMemoryProvider({ options: { filePath } });
            await clearer.clear();
            await stale.save();
            const fresh = new LocalFileMemoryProvider({ options: { filePath } });
            await fresh.load();
            assert.deepEqual(fresh.facts, [], 'the cleared bank must stay cleared');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('R17: an evaluator-rejected step is never shipped completed', () => {
    const STEP = { id: 'a', title: 'A', systemPrompt: 'Be terse.', userPromptTemplate: 'Do the thing.', dependencies: [] };
    /** @param {() => string} impl */
    const executorFor = (impl) => {
        const client = { session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; }, withTools() { return this; }, withMemory() { return this; },
            withTodos() { return this; }, withParameters() { return this; },
            run: async (/** @type {{initialInput: any}} */ { initialInput }) =>
                isObjectiveRestatePrompt({ input: initialInput }) ? '' : impl(),
        }) };
        const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 2 } });
        ex.setSteps({ stepsList: [STEP] });
        return ex;
    };

    it('a no-op replan cannot leave the rejected output as the result', async () => {
        const ex = executorFor(() => 'REJECTED WEAK OUTPUT');
        await assert.rejects(
            () => ex.execute({ userGoal: 'goal', planner: { replan: async () => ({ steps: [STEP] }) }, evaluator: { evaluate: async () => ({ replanRequired: true, reason: 'weak' }) } }),
            /Replan limit \(2\) reached/,
            'the run must fail loudly, not ship the rejected output'
        );
    });

    it('a replan that changes the step re-runs it and can be accepted', async () => {
        let runs = 0;
        const ex = executorFor(() => `good ${++runs}`);
        let evals = 0;
        const outputs = /** @type {any} */ (await ex.execute({ userGoal: 'goal', planner: { replan: async () => ({ steps: [{ ...STEP, userPromptTemplate: 'try again' }] }) }, evaluator: { evaluate: async () => ({ replanRequired: ++evals === 1, reason: 'weak' }) } }));
        assert.ok(String(outputs.a.output).startsWith('good'), 'the replanned step result is returned');
        assert.equal(evals, 2, 'the re-run step is re-evaluated');
    });

    it('a sibling completed step is still evaluated after a replan', async () => {
        const ex = executorFor(() => 'OUT');
        ex.setSteps({ stepsList: [{ ...STEP, id: 'a' }, { ...STEP, id: 'b' }] });
        /** @type {Record<string, number>} */
        const evals = {};
        await ex.execute({ userGoal: 'goal', planner: { replan: async () => ({ steps: [{ ...STEP, id: 'a' }, { ...STEP, id: 'b' }] }) }, evaluator: { evaluate: async (/** @type {any} */ { node }) => { evals[node.id] = (evals[node.id] ?? 0) + 1; return { replanRequired: node.id === 'a' && evals.a === 1, reason: 'weak' }; } } });
        assert.ok(evals.b >= 1, 'the sibling must receive a verdict, not ship unverified');
    });

    it('a rejected step dropped by the replan is removed from the result', async () => {
        const ex = executorFor(() => 'OUT');
        const outputs = /** @type {any} */ (await ex.execute({ userGoal: 'goal', planner: { replan: async () => ({ steps: [{ ...STEP, id: 'b' }] }) }, evaluator: { evaluate: async (/** @type {any} */ { node }) => ({ replanRequired: node.id === 'a', reason: 'weak' }) } }));
        assert.equal('a' in outputs, false, 'the rejected step output must not be returned');
        assert.ok('b' in outputs, 'the replacement step ran');
    });

    it('a requeued rejected step re-runs its already-completed dependent against the new output', async () => {
        const A = { ...STEP, id: 'a', userPromptTemplate: 'a-MARK' };
        const B = { ...STEP, id: 'b', userPromptTemplate: 'b-MARK {{a}}', dependencies: ['a'] };
        let aRuns = 0;
        let bRuns = 0;
        const client = { session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; }, withTools() { return this; }, withMemory() { return this; },
            withTodos() { return this; }, withParameters() { return this; },
            run: async (/** @type {any} */ { initialInput }) => {
                if (isObjectiveRestatePrompt({ input: initialInput })) return '';
                const s = JSON.stringify(initialInput);
                if (/b-MARK/i.test(s)) {
                    bRuns++;
                    const upstream = /(OUT-A-\d+)/.exec(s);
                    return `OUT-B-${bRuns}-sees-${upstream ? upstream[1] : 'NONE'}`;
                }
                aRuns++;
                return `OUT-A-${aRuns}`;
            },
        }) };
        const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
        ex.setSteps({ stepsList: [A, B] });
        let aCalls = 0;
        const outputs = /** @type {any} */ (await ex.execute({
            userGoal: 'goal',
            planner: { replan: async () => ({ steps: [A, B] }) },
            evaluator: { evaluate: async (/** @type {any} */ { node }) => {
                if (node.id !== 'a') return { replanRequired: false };
                aCalls++;
                if (aCalls === 1) throw new Error('transient evaluator outage');
                return { replanRequired: aCalls === 2, reason: 'weak' };
            } },
        }));
        assert.equal(bRuns, 2, 'the dependent must re-run after its rejected upstream is requeued');
        assert.ok(String(outputs.b.output).includes(String(outputs.a.output)), 'the dependent must reference the current upstream output');
    });

    it('a resumed fully-completed plan re-verifies its carried-over steps', async () => {
        const A = { ...STEP, id: 'a', userPromptTemplate: 'a-MARK' };
        const B = { ...STEP, id: 'b', userPromptTemplate: 'b-MARK' };
        const client = { session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; }, withTools() { return this; }, withMemory() { return this; },
            withTodos() { return this; }, withParameters() { return this; },
            run: async (/** @type {any} */ { initialInput }) => (isObjectiveRestatePrompt({ input: initialInput }) ? '' : 'OUT'),
        }) };
        const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 2 } });
        ex.setSteps({ stepsList: [A, B] });
        await ex.execute({ userGoal: 'goal', planner: { replan: async () => ({ steps: [A, B] }) }, evaluator: { evaluate: async () => ({ replanRequired: false }) } });
        const resumed = WorkflowExecutor.load({ json: ex.save() });
        let evals = 0;
        await resumed.execute({ userGoal: 'goal', planner: { replan: async () => ({ steps: [A, B] }) }, evaluator: { evaluate: async () => { evals++; return { replanRequired: false }; } } });
        assert.ok(evals >= 2, `a fully-completed resume must re-verify its carried-over completed steps (evaluator calls: ${evals})`);
    });

    it('a failed step dropped by a replan leaves no error output in the result', async () => {
        const A = { ...STEP, id: 'a', userPromptTemplate: 'a-MARK' };
        const C = { ...STEP, id: 'c', userPromptTemplate: 'c-MARK' };
        const client = { session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; }, withTools() { return this; }, withMemory() { return this; },
            withTodos() { return this; }, withParameters() { return this; },
            run: async (/** @type {any} */ { initialInput }) => {
                if (isObjectiveRestatePrompt({ input: initialInput })) return '';
                if (/a-MARK/i.test(JSON.stringify(initialInput))) throw new Error('STEP BOOM');
                return 'OUT-C';
            },
        }) };
        const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
        ex.setSteps({ stepsList: [A] });
        const outputs = /** @type {any} */ (await ex.execute({ userGoal: 'goal', planner: { replan: async () => ({ steps: [C] }) }, evaluator: { evaluate: async () => ({ replanRequired: false }) } }));
        assert.equal('a' in outputs, false, 'a dropped failed step must not leak its error output');
        assert.ok('c' in outputs, 'the replacement step ran');
    });
});

describe('R18: a corrupt checkpoint/manifest is quarantined, never overwritten', () => {
    it('a corrupt session checkpoint is moved aside before a fresh save', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-r18-session-'));
        try {
            const store = new LocalFileSessionStore({ dir });
            writeFileSync(join(dir, 't-1.json'), '{corrupt session bytes', 'utf8');
            await assert.rejects(store.load('t-1'), /is corrupt/, 'a present-but-unreadable record is an error (W2C-3)');
            const q = readdirSync(dir).find(f => f.includes('.corrupt-'));
            assert.ok(q, 'the corrupt bytes are preserved');
            assert.equal(readFileSync(join(dir, q), 'utf8'), '{corrupt session bytes');
            await store.save({ threadId: 't-1', data: { messages: [{ role: 'user', content: 'new' }] } });
            assert.equal(/** @type {any} */ (await store.load('t-1')).messages[0].content, 'new', 'the fresh save is readable');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a corrupt artifact manifest is moved aside before a fresh index is written', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-r18-artifact-'));
        try {
            writeFileSync(join(dir, '.artifacts.json'), 'not json', 'utf8');
            const tool = createSaveArtifactTool({ dir });
            const path = await tool.execute({ args: { name: 'report.md', content: 'fresh' } });
            assert.match(path, /report\.md$/, 'a corrupt manifest still degrades to a fresh v1');
            const q = readdirSync(dir).find(f => f.includes('.corrupt-'));
            assert.ok(q, 'the corrupt manifest bytes are preserved');
            assert.equal(readFileSync(join(dir, q), 'utf8'), 'not json');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a missing checkpoint is still a plain miss (no quarantine file)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-r18-miss-'));
        try {
            const store = new LocalFileSessionStore({ dir });
            assert.equal(await store.load('absent'), null);
            assert.equal(readdirSync(dir).filter(f => f.includes('.corrupt-')).length, 0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a JSON-null checkpoint is quarantined, never crashed on', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-r18-null-'));
        try {
            const store = new LocalFileSessionStore({ dir });
            writeFileSync(join(dir, 't.json'), 'null', 'utf8');
            await assert.rejects(store.load('t'), (/** @type {any} */ error) => error?.option === 'checkpoint_corrupt', 'a JSON null is a record that cannot be restored (W2C-3)');
            assert.equal(readdirSync(dir).filter(f => f.includes('.corrupt-')).length, 1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a corrupt manifest does not overwrite surviving artifact files', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-r18-preserve-'));
        try {
            writeFileSync(join(dir, 'a.txt'), 'OLD-V1-BYTES', 'utf8');
            writeFileSync(join(dir, 'a.v2.txt'), 'OLD-V2-BYTES', 'utf8');
            writeFileSync(join(dir, '.artifacts.json'), 'not json', 'utf8');
            const tool = createSaveArtifactTool({ dir });
            const path = await tool.execute({ args: { name: 'a.txt', content: 'NEW' } });
            assert.match(path, /a\.v3\.txt$/, 'a surviving file must force the next free version');
            assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'OLD-V1-BYTES', 'the surviving artifact is untouched');
            assert.equal(readFileSync(join(dir, 'a.v2.txt'), 'utf8'), 'OLD-V2-BYTES');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
