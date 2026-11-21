// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TodoComponent, CAPABILITY } from '../lib/index.mjs';

test('TodoComponent.load returns null when empty', async () => {
    const c = new TodoComponent();
    assert.equal(await c.load(), null);
});

test('TodoComponent.save add task and load shows it', async () => {
    const c = new TodoComponent();
    /** @type {any} */
    const r = await c.save({ args: { action: 'add', title: 'test task' } });
    assert.equal(r.success, true);
    assert.ok(r.message.includes('added task'));
    assert.equal(r.task.title, 'test task');
    assert.equal(r.task.status, 'pending');
    const block = await c.load();
    assert.ok(/** @type {string} */ (block).includes('test task'));
    assert.ok(/** @type {string} */ (block).includes('[pending]'));
});

test('TodoComponent.save add requires title', async () => {
    const c = new TodoComponent();
    /** @type {any} */
    const r = await c.save({ args: { action: 'add' } });
    assert.equal(r.success, false);
});

test('TodoComponent.save complete marks done', async () => {
    const c = new TodoComponent();
    await c.save({ args: { action: 'add', title: 'task' } });
    /** @type {any} */
    const r = await c.save({ args: { action: 'complete', id: 1 } });
    assert.equal(r.success, true);
    assert.equal(r.task.status, 'completed');
    const block = await c.load();
    assert.ok(/** @type {string} */ (block).includes('[x]'));
});

test('TodoComponent.save complete on missing id', async () => {
    const c = new TodoComponent();
    /** @type {any} */
    const r = await c.save({ args: { action: 'complete', id: 99 } });
    assert.equal(r.success, false);
});

test('TodoComponent.save delete removes task', async () => {
    const c = new TodoComponent();
    await c.save({ args: { action: 'add', title: 'task' } });
    /** @type {any} */
    const r = await c.save({ args: { action: 'delete', id: 1 } });
    assert.equal(r.success, true);
    assert.equal(await c.load(), null);
});

test('TodoComponent.save delete on missing id', async () => {
    const c = new TodoComponent();
    /** @type {any} */
    const r = await c.save({ args: { action: 'delete', id: 99 } });
    assert.equal(r.success, false);
});

test('TodoComponent.save update changes title and status', async () => {
    const c = new TodoComponent();
    await c.save({ args: { action: 'add', title: 'original' } });
    /** @type {any} */
    const r = await c.save({ args: { action: 'update', id: 1, title: 'updated', status: 'in_progress' } });
    assert.equal(r.success, true);
    assert.equal(r.task.title, 'updated');
    assert.equal(r.task.status, 'in_progress');
});

test('TodoComponent.save list returns tasks', async () => {
    const c = new TodoComponent();
    await c.save({ args: { action: 'add', title: 'a' } });
    await c.save({ args: { action: 'add', title: 'b' } });
    /** @type {any} */
    const r = await c.save({ args: { action: 'list' } });
    assert.equal(r.success, true);
    assert.equal(r.tasks.length, 2);
});

test('TodoComponent.save unknown action', async () => {
    const c = new TodoComponent();
    /** @type {any} */
    const r = await c.save({ args: { action: 'nope' } });
    assert.equal(r.success, false);
});

test('TodoComponent supports explicit id', async () => {
    const c = new TodoComponent();
    await c.save({ args: { action: 'add', title: 'custom', id: 'my_id' } });
    assert.ok(/** @type {string} */ (await c.load()).includes('my_id'));
    /** @type {any} */
    const r = await c.save({ args: { action: 'complete', id: 'my_id' } });
    assert.equal(r.success, true);
});

test('TodoComponent is a LoadableComponent with correct tools', () => {
    const c = new TodoComponent();
    const loadTool = c.toLoadTool();
    assert.equal(/** @type {any} */ (loadTool).name, 'load_todos');
    const saveTool = c.toSaveTool();
    assert.equal(/** @type {any} */ (saveTool).name, 'manage_todos');
});

test('TodoComponent: a shared store does not restart ids at 1 (DAG / multi-session)', async () => {
    const store = new Map();
    const first = new TodoComponent({ store });
    await first.save({ args: { action: 'add', title: 'step one' } });
    await first.save({ args: { action: 'add', title: 'step two' } });

    const second = new TodoComponent({ store });
    /** @type {any} */
    const r = await second.save({ args: { action: 'add', title: 'step three' } });
    assert.equal(r.success, true, 'must not collide with an id the first session added');
    assert.equal(r.task.id, 3);
    assert.equal(store.size, 3);
});

test('TodoComponent: non-numeric ids survive normalization', async () => {
    const c = new TodoComponent();
    await c.save({ args: { action: 'add', id: 'my_id', title: 'named' } });
    assert.ok(/** @type {string} */ (await c.load()).includes('my_id'));
    assert.equal((/** @type {any} */ (await c.save({ args: { action: 'complete', id: 'my_id' } }))).success, true);
});
