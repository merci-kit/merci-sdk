// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createContextTools } from '../lib/tools/context-tools.mjs';
import { buildEnvironmentBlock, discoverInstructions } from '../lib/agentic/context.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

class MinimalSession extends AbstractChatSession {
    /** @param {any} provider @param {any} model @param {any} eventEmitter @param {any} [client] */
    constructor( provider,  model,  eventEmitter,  client) {
        super({ provider, model, eventEmitter, client });
    }
}


/** @type {string} */
let tmp;
test.before(async () => { tmp = await mkdtemp(join(tmpdir(), 'merci-context-')); });
test.after(async () => { await rm(tmp, { recursive: true, force: true }); });

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test('read returns numbered lines with an end-of-file footer', async () => {
    const file = join(tmp, 'ten.txt');
    await writeFile(file, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'));
    const [read] =  (createContextTools({ options: { root: tmp } }));
    const out = await read.execute({ args: { filePath: 'ten.txt' } });
    assert.ok(out.includes('3: line3'));
    assert.ok(out.includes('(End of file - total 10 lines)'));
});

test('read honors offset/limit windows and shows a continue hint', async () => {
    const [read] =  (createContextTools({ options: { root: tmp } }));
    const out = await read.execute({ args: { filePath: 'ten.txt', offset: 3, limit: 2 } });
    assert.ok(out.includes('3: line3'));
    assert.ok(out.includes('4: line4'));
    assert.ok(!out.includes('5: line5'));
    assert.ok(out.includes('(Showing lines 3-4 of 10. Use offset=5 to continue.)'));
});

test('read lists directories with trailing slashes on folders', async () => {
    await mkdir(join(tmp, 'sub'), { recursive: true });
    await writeFile(join(tmp, 'a.txt'), 'a');
    const [read] =  (createContextTools({ options: { root: tmp } }));
    const out = await read.execute({ args: { filePath: '.' } });
    assert.ok(out.includes('sub/'));
    assert.ok(out.includes('a.txt'));
    assert.ok(out.includes('<type>directory</type>'));
});

test('read truncates over-long lines', async () => {
    const long = 'x'.repeat(2100);
    const file = join(tmp, 'long.txt');
    await writeFile(file, long);
    const [read] =  (createContextTools({ options: { root: tmp } }));
    const out = await read.execute({ args: { filePath: 'long.txt' } });
    assert.ok(out.includes('... (line truncated to 2000 chars)'));
});

test('read caps output at 50 KB with a continue hint', async () => {
    const file = join(tmp, 'big.txt');
    await writeFile(file, Array.from({ length: 700 }, () => 'y'.repeat(100)).join('\n'));
    const [read] =  (createContextTools({ options: { root: tmp } }));
    const out = await read.execute({ args: { filePath: 'big.txt' } });
    assert.ok(out.includes('(Output capped at 50 KB.'));
    assert.ok(out.includes('Use offset='));
});

test('read suggests near-miss files when the target is missing', async () => {
    await writeFile(join(tmp, 'foo_bar.mjs'), 'x');
    const [read] =  (createContextTools({ options: { root: tmp } }));
    await assert.rejects(() => read.execute({ args: { filePath: 'foo_bar.mj' } }), /Did you mean one of these\?/);
});

test('read rejects binary files', async () => {
    const file = join(tmp, 'blob.txt');
    await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const [read] =  (createContextTools({ options: { root: tmp } }));
    await assert.rejects(() => read.execute({ args: { filePath: 'blob.txt' } }), /Cannot read binary file/);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test('grep returns matches grouped by file', async () => {
    await writeFile(join(tmp, 'a.mjs'), 'const hello = 1;');
    await writeFile(join(tmp, 'b.mjs'), 'say hello world');
    await writeFile(join(tmp, 'c.md'), 'nothing here');
    const [, grep] =  (createContextTools({ options: { root: tmp } }));
    const out = await grep.execute({ args: { pattern: 'hello', path: '.' } });
    assert.ok(out.includes('Found 2 matches'));
    assert.ok(out.includes('a.mjs:'));
    assert.ok(out.includes('b.mjs:'));
    assert.ok(out.includes('Line 1: const hello = 1'));
});

test('grep reports no files on zero matches', async () => {
    const [, grep] =  (createContextTools({ options: { root: tmp } }));
    const out = await grep.execute({ args: { pattern: 'zzz_no_match_zzz', path: '.' } });
    assert.equal(out, 'No files found');
});

test('glob lists files matching the pattern relative to root', async () => {
    await writeFile(join(tmp, 'x.mjs'), 'x');
    await writeFile(join(tmp, 'y.txt'), 'y');
    const [, , glob] =  (createContextTools({ options: { root: tmp } }));
    const out = await glob.execute({ args: { pattern: '**/*.mjs', path: '.' } });
    assert.ok(out.includes('x.mjs'));
    assert.ok(!out.includes('y.txt'));
});

test('grep/glob surface a clear error when ripgrep is missing', async () => {
    const fakeSpawn = () => {
        const child =  (new EventEmitter());
        /** @type {any} */ (child).stdout = new EventEmitter();
        /** @type {any} */ (child).stderr = new EventEmitter();
        setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
        return child;
    };
    const [, grep, glob] =  (createContextTools({ options: { root: tmp, spawn: fakeSpawn } }));
    await assert.rejects(() => grep.execute({ args: { pattern: 'hello' } }), /ripgrep \(rg\) is not installed/);
    await assert.rejects(() => glob.execute({ args: { pattern: '**/*.mjs' } }), /ripgrep \(rg\) is not installed/);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test('buildEnvironmentBlock renders the env block', async () => {
    const block = await buildEnvironmentBlock({ root: tmp });
    assert.ok(block.includes('<env>'));
    assert.ok(block.includes(`Working directory: ${tmp}`));
    assert.ok(block.includes('Platform:'));
    assert.ok(block.includes('Today\'s date:'));
});

test('discoverInstructions finds AGENTS.md up to the stop directory', async () => {
    const root = join(tmp, 'tree');
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'AGENTS.md'), '# root rules');
    await writeFile(join(root, 'a', 'b', 'AGENTS.md'), '# nested rules');

    const fromNested =  (await discoverInstructions({ root: join(root, 'a', 'b'), stopAt: root }));
    assert.ok(/** @type {any} */ (fromNested).includes('# root rules'));
    assert.ok(/** @type {any} */ (fromNested).includes('# nested rules'));

    const none = await discoverInstructions({ root: join(root, 'a'), stopAt: join(root, 'a') });
    assert.equal(none, null);
});

test('withAutoContext injects env + instructions into the system message', async () => {
    await writeFile(join(tmp, 'AGENTS.md'), '# workspace rules');
    const s = new ( (MinimalSession))('openrouter', 'm', new EventEmitter());
    s.withAutoContext({ options: { root: tmp } });
    const prepared = await s._prepareStepMessages({ messages: [createUserMessage({ provider: 'openrouter', content: 'hi' })] });
    const sys = ( (/** @type {any} */ (prepared.find(( m) => m.type === 'system_message')))).content;
    assert.ok(sys.includes('<env>'));
    assert.ok(sys.includes('Instructions from:'));
    assert.ok(sys.includes('# workspace rules'));
});

test('withAutoContext blocks can be disabled individually', async () => {
    const s = new ( (MinimalSession))('openrouter', 'm', new EventEmitter());
    s.withAutoContext({ options: { root: tmp, env: false, instructions: false } });
    s.withSDKDescriptorMessage();
    const prepared = await s._prepareStepMessages({ messages: [createUserMessage({ provider: 'openrouter', content: 'hi' })] });
    const sys = ( (/** @type {any} */ (prepared.find(( m) => m.type === 'system_message')))).content;
    assert.ok(!sys.includes('<env>'));
    assert.ok(!sys.includes('Instructions from:'));
});

test('no withAutoContext means no env or instructions blocks', async () => {
    const s = new ( (MinimalSession))('openrouter', 'm', new EventEmitter());
    s.withSDKDescriptorMessage();
    const prepared = await s._prepareStepMessages({ messages: [createUserMessage({ provider: 'openrouter', content: 'hi' })] });
    const sys = ( (/** @type {any} */ (prepared.find(( m) => m.type === 'system_message')))).content;
    assert.ok(!sys.includes('<env>'));
    assert.ok(!sys.includes('Instructions from:'));
});
