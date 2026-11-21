// @ts-check

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { guardedParse, validateStrict } from '../lib/support/json.mjs';
import { LocalFileMemoryProvider } from '../lib/agentic/memory/providers.mjs';
import { TodoComponent } from '../lib/agentic/todos/component.mjs';
import { createSaveArtifactTool } from '../lib/agentic/artifacts.mjs';
import { TaskState } from '../lib/agentic/planning/task-state.mjs';
import { ConfigurationError } from '../lib/index.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'merci-strict-json-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let counter = 0;
/** @param {{name: string}} arg0 @returns {string} */
/** @param {{name: *}} arg0 */
const scratch = ({ name }) => {
    counter += 1;
    const dir = join(ROOT, `case-${counter}-${name}`);
    mkdirSync(dir, { recursive: true });
    return dir;
};
/** @param {{path: string, contents: any}} arg0 @returns {string} */
/** @param {{path: *, contents: *}} arg0 */
const writeJsonFile = ({ path, contents }) => {
    writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
    return path;
};

const SHAPE = { type: 'object', properties: { facts: { type: 'array' }, lastSyncedTurnIndex: { type: 'number' } } };

// ─── the strict primitive ────────────────────────────────────────────────────

test('validateStrict: valid payload passes with the same six-field contract', () => {
    const r = validateStrict({ input: '{"facts":[],"lastSyncedTurnIndex":3}', schema: SHAPE });
    assert.deepEqual(Object.keys(r).sort(), ['success', 'data', 'error', 'details', 'healed', 'originalValid'].sort());
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { facts: [], lastSyncedTurnIndex: 3 });
    assert.equal(r.healed, false);
    assert.equal(r.originalValid, true);
});

test('validateStrict refuses to heal what guardedParse repairs', () => {
    const malformed = '{a:1}';
    const healed = guardedParse({ input: malformed });
    assert.equal(healed.success, true);
    assert.equal(healed.healed, true, 'precondition: the normal path heals this');

    const strict = validateStrict({ input: malformed });
    assert.equal(strict.success, false);
    assert.equal(strict.originalValid, false);
    assert.equal(strict.healed, false);
    assert.equal(strict.error, 'Failed to parse JSON structure');
});

test('validateStrict: schema mismatch reports details and keeps data inspectable', () => {
    const r = validateStrict({ input: '{"facts":"oops"}', schema: SHAPE });
    assert.equal(r.success, false);
    assert.equal(r.error, 'Schema Validation Failed');
    assert.equal(r.originalValid, true, 'parse succeeded — only validation failed');
    assert.deepEqual(r.data, { facts: 'oops' });
    assert.ok(Array.isArray(r.details));
});

// ─── memory bank: corrupt ⇒ QUARANTINE + recover (F9 policy) ─────────────────

test('memory bank: a valid file loads facts and the checkpoint', async () => {
    const file = writeJsonFile({ path: join(scratch({ name: 'mem-ok' }), 'bank.json'), contents: { facts: ['a', 'b'], lastSyncedTurnIndex: 7 } });
    const provider = new LocalFileMemoryProvider({ options: { filePath: file, name: 'test' } });
    await provider.load();
    assert.deepEqual(provider.facts, ['a', 'b']);
    assert.equal(provider.lastSyncedTurnIndex, 7);
});

test('memory bank: a missing file starts fresh without throwing', async () => {
    const provider = new LocalFileMemoryProvider({ options: { filePath: join(scratch({ name: 'mem-missing' }), 'nope.json'), name: 'test' } });
    await provider.load();
    assert.deepEqual(provider.facts, []);
    assert.equal(provider.lastSyncedTurnIndex, 0);
});

test('memory bank: unparseable content is quarantined, never silently emptied', async () => {
    const dir = scratch({ name: 'mem-corrupt' });
    const file = writeJsonFile({ path: join(dir, 'bank.json'), contents: '{not json at all' });
    const provider = new LocalFileMemoryProvider({ options: { filePath: file, name: 'test' } });
    await provider.load();
    assert.deepEqual(provider.facts, [], 'memory recovers empty instead of dying forever');
    const quarantined = readdirSync(dir).filter((f) => f.startsWith('bank.json.corrupt-'));
    assert.equal(quarantined.length, 1, 'the corrupt bytes are preserved in a quarantine file');
    assert.equal(readFileSync(join(dir, quarantined[0]), 'utf8'), '{not json at all');
});

test('memory bank: a wrong-typed field is quarantined, not repaired', async () => {
    const dir = scratch({ name: 'mem-wrongtype' });
    const file = writeJsonFile({ path: join(dir, 'bank.json'), contents: { facts: 'oops', lastSyncedTurnIndex: 1 } });
    const provider = new LocalFileMemoryProvider({ options: { filePath: file, name: 'test' } });
    await provider.load();
    assert.deepEqual(provider.facts, []);
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('bank.json.corrupt-')).length, 1);
});

// ─── todo store: corrupt ⇒ WARN + empty (policy preserved) ───────────────────

test('todo store: a valid file hydrates tasks', async () => {
    const file = writeJsonFile({ path: join(scratch({ name: 'todo-ok' }), 'todos.json'), contents: {
        version: '1.0', updatedAt: 1, tasks: [{ id: 't1', title: 'one', status: 'pending' }],
    } });
    const component = new TodoComponent({ filePath: file });
    await component.load();
    assert.equal(component._store.size, 1);
    assert.equal(/** @type {any} */ (component._store.get('t1')).title, 'one');
});

test('todo store: a corrupt file warns and stays empty, never throws', async () => {
    const file = writeJsonFile({ path: join(scratch({ name: 'todo-corrupt' }), 'todos.json'), contents: '{{{ broken' });
    const component = new TodoComponent({ filePath: file });
    await component.load();
    assert.equal(component._store.size, 0);
});

test('todo store: one malformed task is skipped, the rest still load', async () => {
    const file = writeJsonFile({ path: join(scratch({ name: 'todo-partial' }), 'todos.json'), contents: {
        version: '1.0', updatedAt: 1, tasks: [{ id: 'good', title: 'ok' }, { title: 'no id' }],
    } });
    const component = new TodoComponent({ filePath: file });
    await component.load();
    assert.equal(component._store.size, 1);
    assert.ok(component._store.has('good'));
});

// ─── artifact manifest: corrupt ⇒ silent empty (policy preserved) ────────────
// ponytail: ArtifactComponent (the listing wrapper) was deleted as dead code —

test('artifact manifest: a valid manifest keeps version continuity on save', async () => {
    const dir = scratch({ name: 'art-ok' });
    writeJsonFile({ path: join(dir, '.artifacts.json'), contents: { entries: [{ name: 'report.md', bytes: 12, version: 1 }] } });
    const tool = createSaveArtifactTool({ dir });
    const path = await tool.execute({ args: { name: 'report.md', content: 'fresh' } });
    assert.match(path, /report\.v2\.md$/, 'a healthy manifest versions the next save to v2');
});

test('artifact manifest: a corrupt manifest lists nothing and does not throw', async () => {
    const dir = scratch({ name: 'art-corrupt' });
    writeJsonFile({ path: join(dir, '.artifacts.json'), contents: 'not json' });
    const tool = createSaveArtifactTool({ dir });
    const path = await tool.execute({ args: { name: 'report.md', content: 'fresh' } });
    assert.match(path, /report\.md$/, 'a corrupt manifest silently degrades to an empty index (fresh v1)');
});

test('artifact manifest: a wrong-typed entries field lists nothing', async () => {
    const dir = scratch({ name: 'art-wrongtype' });
    writeJsonFile({ path: join(dir, '.artifacts.json'), contents: { entries: 'oops' } });
    const tool = createSaveArtifactTool({ dir });
    const path = await tool.execute({ args: { name: 'report.md', content: 'fresh' } });
    assert.match(path, /report\.md$/, 'a wrong-typed manifest silently degrades to an empty index (fresh v1)');
});

// ─── TaskState: malformed ⇒ THROW; non-object ⇒ empty (policy preserved) ─────

test('TaskState.fromJSON: a snapshot round-trips', () => {
    const state = TaskState.fromJSON(JSON.stringify({ objective: 'ship it', steps: [], outputs: {}, replanCount: 2 }));
    assert.equal(state.objective, 'ship it');
    assert.equal(state.replanCount, 2);
});

test('TaskState.fromJSON: malformed JSON still throws', () => {
    assert.throws(() => TaskState.fromJSON('{broken'), (/** @type {any} */ err) => {
        assert.ok(err instanceof ConfigurationError);
        assert.equal(err.code, 'MERCI-CONFIG-ERR');
        assert.match(err.message, /Invalid TaskState JSON/);
        return true;
    });
});

test('TaskState.fromJSON: a well-formed non-object snapshot degrades to empty', () => {
    const state = TaskState.fromJSON('5');
    assert.equal(state.objective, '');
    assert.deepEqual(state.steps, []);
});

test('TaskState.fromJSON: a live object is taken as-is, without a stringify round-trip', () => {
    const live = { objective: 'live', steps: [], outputs: {}, replanCount: 0 };
    assert.equal(TaskState.fromJSON(live).objective, 'live');
    const circular = { objective: 'circ', steps: [], outputs: {} };
    /** @type {any} */
    (circular).self = circular;
    assert.equal(TaskState.fromJSON(circular).objective, 'circ');
});
