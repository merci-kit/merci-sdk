// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';

/** @param {string} output @returns {any} */
function runClient(output) {
    const sessions = /** @type {any[]} */ ([]);
    return {
        provider: 'openai',
        sessions,
        session() {
            const s = {
                provider: 'openai',
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                withRetryPolicy() { return s; },
                withStreamTimeout() { return s; },
                withApproval() { return s; },
                withHeaderTimeout() { return s; },
                withMaxElapsedMs() { return s; },
                withBudget() { return s; },
                withCircuitBreaker() { return s; },
                /** @param {{initialInput: any[]}} arg0 */
                async run({ initialInput }) { return output; },
            };
            sessions.push(s);
            return s;
        },
    };
}

test('DAG: an oversized upstream output is persisted and referenced by path', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'merci-intake-'));
    const big = 'X'.repeat(5000);
    const runs = /** @type {any[][]} */ ([]);
    const client = runClient('');
    client.session = () => {
        const s = {
            provider: 'openai',
            withSystemMessage() { return s; },
            withTools() { return s; },
            withMemory() { return s; },
            withTodos() { return s; },
            withParameters() { return s; },
            withRetryPolicy() { return s; },
            withStreamTimeout() { return s; },
            withApproval() { return s; },
            withHeaderTimeout() { return s; },
            withMaxElapsedMs() { return s; },
            withBudget() { return s; },
            withCircuitBreaker() { return s; },
            /** @param {{initialInput: any[]}} arg0 */
            async run({ initialInput }) { runs.push(initialInput); return big; },
        };
        return s;
    };

    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', intakeArtifactThreshold: 100, artifactDir: dir } });
    exec.setSteps({ stepsList: [
        { id: 'a', userPromptTemplate: 'first thing', dependencies: [] },
        { id: 'b', userPromptTemplate: 'second thing', dependencies: ['a'] },
    ] });
    await exec.execute({ userGoal: 'g' });

    const bRun = runs.find((r) => Array.isArray(r) && r.some((m) => typeof m?.content === 'string' && m.content.includes('second thing')));
    assert.ok(bRun, 'step b ran');
    const text = bRun.map((m) => String(m?.content ?? '')).join('\n');
    assert.match(text, /too large to inline/);
    const m = text.match(/read artifact (\S+)/);
    assert.ok(m, `expected an artifact path in: ${text.slice(0, 200)}`);
    const artifactPath = /** @type {RegExpMatchArray} */ (m)[1];
    await fs.access(artifactPath);
    await fs.rm(dir, { recursive: true, force: true });
});

test('DAG: a small upstream output is still inlined (no artifact)', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'merci-intake-'));
    const runs = /** @type {any[][]} */ ([]);
    const client = runClient('');
    client.session = () => {
        const s = {
            provider: 'openai',
            withSystemMessage() { return s; },
            withTools() { return s; },
            withMemory() { return s; },
            withTodos() { return s; },
            withParameters() { return s; },
            withRetryPolicy() { return s; },
            withStreamTimeout() { return s; },
            withApproval() { return s; },
            withHeaderTimeout() { return s; },
            withMaxElapsedMs() { return s; },
            withBudget() { return s; },
            withCircuitBreaker() { return s; },
            /** @param {{initialInput: any[]}} arg0 */
            async run({ initialInput }) { runs.push(initialInput); return 'small'; },
        };
        return s;
    };
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', intakeArtifactThreshold: 1000, artifactDir: dir } });
    exec.setSteps({ stepsList: [
        { id: 'a', userPromptTemplate: 'first thing', dependencies: [] },
        { id: 'b', userPromptTemplate: 'second thing', dependencies: ['a'] },
    ] });
    await exec.execute({ userGoal: 'g' });
    const bRun = runs.find((r) => Array.isArray(r) && r.some((m) => typeof m?.content === 'string' && m.content.includes('second thing')));
    const text = /** @type {any[]} */ (bRun).map((m) => String(m?.content ?? '')).join('\n');
    assert.equal(text.includes('too large to inline'), false);
    assert.ok(text.includes('small'), 'the small output is inlined');
    await fs.rm(dir, { recursive: true, force: true });
});
