// @ts-check

import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { WorkflowEvaluator } from '../lib/agentic/planning/evaluator.mjs';
import { StateMachine, createStateMachineTool } from '../lib/agentic/state-machine/machine.mjs';
import { foldContext } from '../lib/agentic/context-fold.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { AgentContext } from '../lib/agentic/agent-context.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/** @type {any[]} */
const report = [];

function makeCapturingClient() {
    /** @type {any[]} */
    const calls = [];
    /** @type {any[]} */
    const systems = [];
    const client = {
        calls,
        systems,
        session: () => ({
            provider: 'openai',
            _system: '',
            withSystemMessage(/** @type {any} */ msg) { this._system = Array.isArray(msg) ? msg.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : String(msg ?? ''); return this; },
            withTools() { return this; },
            withMemory() { return this; },
            withTodos() { return this; },
            withParameters() { return this; },
            /** @param {{initialInput: *}} arg0 */
            async run({ initialInput: input }) {
                if (isObjectiveRestatePrompt({ input })) return '';
                calls.push(input); systems.push(this._system); return 'answer';
            },
        }),
    };
    return client;
}

const OBJECTIVE = 'THE GLOBAL GOAL: audit the fleet and remediate findings.';

describe('objective reaches every model hop', () => {
    it('every DAG step carries the global objective in its system slot (naive engine)', async () => {
        const client = makeCapturingClient();
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
        executor.setSteps({ stepsList: [
            { id: 'a', title: 'A', systemPrompt: 'sys-a', userPromptTemplate: 'Do step A.', dependencies: [] },
            { id: 'b', title: 'B', systemPrompt: 'sys-b', userPromptTemplate: 'Do step B with {{a.output}}.', dependencies: ['a'] },
        ] });
        await executor.execute({ userGoal: OBJECTIVE });
        assert.ok(client.calls.length >= 2, 'both steps ran');
        for (let i = 0; i < 2; i++) {
            assert.ok(String(client.systems[i]).includes('[Global Objective]'), `step ${i} system prompt carries the block`);
            assert.ok(String(client.systems[i]).includes(OBJECTIVE), `step ${i} system prompt carries the objective verbatim`);
            const userMsg = client.calls[i][client.calls[i].length - 1];
            assert.equal(String(userMsg.content).includes('[Global Objective]'), false,
                `step ${i} user prompt carries no second copy`);
        }
    });

    it('a verified-step retry does NOT accumulate a second objective block', async () => {
        const client = makeCapturingClient();
        const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
        let attempts = 0;
        executor.setSteps({ stepsList: [{
            id: 'a', title: 'A', systemPrompt: 'sys', userPromptTemplate: 'Do the thing.', dependencies: [],
            maxRetries: 2,
            verify: async (/** @type {any} */ result) => {
                attempts++;
                return attempts === 1 ? { passed: false, evidence: 'redo' } : { passed: true, evidence: 'ok' };
            },
        }] });
        await executor.execute({ userGoal: OBJECTIVE });
        assert.ok(client.calls.length >= 2, 'the step was retried');
        const flat = [...client.calls[1].map((/** @type {any} */ m) => String(m.content ?? '')), String(client.systems[1] ?? '')].join('\n');
        assert.equal((flat.match(/\[Global Objective\]/g) ?? []).length, 1,
            'the retried step carries the objective exactly once');
    });

    it('the state-machine TOOL threads the session objective into nested nodes', async () => {
        const client = makeCapturingClient();
        const tool = createStateMachineTool({ graph: {
            entry: 'step',
            nodes: [{ id: 'step', model: 'm', systemPrompt: 'sys', userPromptTemplate: 'Do it.' }],
            edges: [],
        }, options: { client, objective: () => OBJECTIVE } });
        const result = await (/** @type {any} */ (tool)).execute({ args: {} });
        assert.ok(typeof result === 'string');
        assert.ok(String(client.systems[client.systems.length - 1]).includes(OBJECTIVE),
            'the tool-threaded objective reaches the nested node system slot');
    });

    it('state-machine nodes carry the objective unless the prompt already has it', async () => {
        const client = makeCapturingClient();
        const sm = new StateMachine({ graph: {
            entry: 'step',
            nodes: [{ id: 'step', systemPrompt: 'sys', userPromptTemplate: 'Do the thing.' }],
            edges: [],
        }, options: { client, defaultModel: 'm', objective: OBJECTIVE } });
        await sm.run();
        assert.ok(String(client.systems[0]).includes('[Global Objective]'));
        assert.ok(String(client.systems[0]).includes(OBJECTIVE));
        assert.equal(String(client.calls[0][0].content).includes('[Global Objective]'), false,
            'the user prompt carries no second copy');
        const sm2 = new StateMachine({ graph: {
            entry: 'step',
            nodes: [{ id: 'step', systemPrompt: 'sys', userPromptTemplate: `[Global Objective]\nalready here\n\nDo it.` }],
            edges: [],
        }, options: { client, defaultModel: 'm', objective: OBJECTIVE } });
        await sm2.run();
        const text = client.calls[client.calls.length - 1][0].content;
        assert.equal(text.match(/\[Global Objective\]/g).length, 1, 'no double injection');
        assert.equal(String(client.systems[client.systems.length - 1]).includes('[Global Objective]'), false,
            'the system slot adds no second copy');
    });

    it('the evaluator prompt carries the objective', async () => {
        /** @type {any[]} */
        const calls = [];
        const client = {
            calls,
            session: () => ({
                provider: 'openai',
                withSystemMessage() { return this; },
                withTools() { return this; },
                withParameters() { return this; },
                /** @param {{initialInput: *}} arg0 */
                async run({ initialInput: messages }) {
                    calls.push(messages);
                    return JSON.stringify({ replanRequired: false, reason: 'ok' });
                },
            }),
        };
        const evaluator = new WorkflowEvaluator({ options: { client, model: 'm' } });
        const result = await evaluator.evaluate({ node: { id: 's1', output: 'x' }, outputs: {}, objective: OBJECTIVE });
        assert.equal(result.replanRequired, false);
        const prompt = String(calls[0]);
        assert.ok(prompt.includes('Global Objective'));
        assert.ok(prompt.includes(OBJECTIVE));
    });
});

describe('session objective injection never duplicates an orchestrator block', () => {
    const makeSession = () => new OaiChatSession({ client: /** @type {any} */ ({}), model: 'gpt-4o-mini', eventEmitter: new EventEmitter() });
    /** @param {{out: *}} arg0 */
    /** @param {{out: *}} arg0 */
    const systemsOf = ({ out }) => out.filter(
        (/** @type {any} */ m) => m.type === 'system_message' || m.role === 'system' || m.role === 'developer');
    /** @param {{out: *}} arg0 */
    /** @param {{out: *}} arg0 */
    const tagCount = ({ out }) =>
        out.map((/** @type {any} */ m) => String(m.content ?? '')).join('\n').match(/\[Global Objective\]/g)?.length ?? 0;

    it('skips the system-slot objective when a user message already carries the block', async () => {
        const session = makeSession();
        session._agentContext = AgentContext.fromObjective({ objective: OBJECTIVE });
        const out = await session._prepareStepMessages({ messages: [
            { role: 'user', content: `[Global Objective]\n${OBJECTIVE}\n\nDo step A.` },
        ] });
        assert.equal(tagCount({ out }), 1, 'the objective is injected exactly once across the whole step');
        assert.equal(systemsOf({ out }).some(/** @type {(...args: any[]) => any} */ ((m) => String(m.content).includes('[Global Objective]'))), false,
            'no second copy in the system slot');
    });

    it('injects the objective into the system slot when nothing else carries it', async () => {
        const session = makeSession();
        session._agentContext = AgentContext.fromObjective({ objective: OBJECTIVE });
        const out = await session._prepareStepMessages({ messages: [{ role: 'user', content: 'Do step A.' }] });
        const systems = systemsOf({ out });
        assert.equal(systems.length, 1, 'a system row is produced');
        assert.ok(String(systems[0].content).includes('[Global Objective]'), 'objective is in the system slot');
        assert.ok(String(systems[0].content).includes(OBJECTIVE), 'the objective rides verbatim');
    });

    it('skips when the user system content already carries the block', async () => {
        const session = makeSession();
        session._agentContext = AgentContext.fromObjective({ objective: OBJECTIVE });
        session.withSystemMessage(`[Global Objective]\n${OBJECTIVE}\n\nYou are terse.`);
        const out = await session._prepareStepMessages({ messages: [{ role: 'user', content: 'Do step A.' }] });
        assert.equal(tagCount({ out }), 1, 'the objective is injected exactly once');
    });
});

describe('state-machine template interpolation', () => {
    it('resolves {{context.x}} and emits no warning when the key exists', async () => {
        const client = makeCapturingClient();
        const sm = new StateMachine({ graph: {
            entry: 'step',
            nodes: [{ id: 'step', systemPrompt: 'sys', userPromptTemplate: 'Write about {{context.topic}}.' }],
            edges: [],
        }, options: { client, defaultModel: 'm', context: { topic: 'the space race' } } });
        const warnings = /** @type {any[]} */ ([]);
        sm.on('workflow:template_warning', (w) => warnings.push(w));
        await sm.run();
        const text = client.calls[0][0].content;
        assert.ok(text.includes('the space race'), 'the context value is interpolated');
        assert.equal(text.includes('[UNRESOLVED'), false, 'no placeholder when the key exists');
        assert.equal(warnings.length, 0, 'no warning when the key exists');
    });

    it('renders [UNRESOLVED] and emits workflow:template_warning on a miss', async () => {
        const client = makeCapturingClient();
        const sm = new StateMachine({ graph: {
            entry: 'step',
            nodes: [{ id: 'step', systemPrompt: 'sys', userPromptTemplate: 'Write about {{context.topic}}.' }],
            edges: [],
        }, options: { client, defaultModel: 'm' } });
        const warnings = /** @type {any[]} */ ([]);
        sm.on('workflow:template_warning', (w) => warnings.push(w));
        await sm.run();
        const text = client.calls[0][0].content;
        assert.ok(text.includes('[UNRESOLVED: topic]'), 'the placeholder is rendered');
        assert.equal(warnings.length, 1, 'the miss is surfaced, never silent');
        assert.equal(warnings[0].nodeId, 'step');
        assert.equal(warnings[0].path, 'context.topic');
    });
});

describe('foldContext: every drop is marked', () => {
    const rows = [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
        { role: 'assistant', content: 'four' },
    ];

    it('folds with a summary when summarize succeeds', async () => {
        /** @type {any} */
        /** @param {{summary: *}} arg0 */
        /** @param {{summary: *}} arg0 */
        const fold = await foldContext({ rows, cut: 2, summarize: /** @type {(...args: any[]) => any} */ (async (prefix) => `SUM:${prefix.length}`), wrapSummary: /** @type {(...args: any[]) => any} */ (({ summary }) => ({ role: 'system', content: `[Earlier]: ${summary}` })) });
        assert.equal(fold.folded, true);
        assert.equal(fold.summarized, true);
        assert.equal(fold.dropped, 2);
        assert.equal(fold.rows[0].content, '[Earlier]: SUM:2');
        assert.equal(fold.rows[1].content, 'three', 'the tail follows');
    });

    it('marks the drop when no summarizer is configured', async () => {
        /** @type {any} */
        const fold = await foldContext({ rows, cut: 2 });
        assert.equal(fold.folded, true);
        assert.equal(fold.summarized, false);
        assert.ok(fold.rows[0].content.includes('2 earlier entries were omitted'), 'the marker names the drop');
        assert.equal(fold.rows[1].content, 'three');
    });

    it('marks the drop when the summarizer throws', async () => {
        /** @type {any} */
        const fold = await foldContext({ rows, cut: 2, summarize: async () => { throw new Error('down'); } });
        assert.equal(fold.summarized, false);
        assert.ok(fold.rows[0].content.includes('down'), 'the failure reason is surfaced');
    });

    it('is a strict no-op when the cut is at the boundary', async () => {
        const fold = await foldContext({ rows, cut: 0 });
        assert.equal(fold.folded, false);
        assert.equal(fold.rows, rows, 'same array reference, nothing allocated');
    });

    it('rejects a non-integer / NaN cut as a no-op', async () => {
        const fold = await foldContext({ rows, cut: NaN });
        assert.equal(fold.folded, false, 'NaN must not fold');
        assert.equal(fold.rows, rows);
        const frac = await foldContext({ rows, cut: 2.5 });
        assert.equal(frac.folded, false, 'fractional cuts must not fold');
    });
});

describe('state-machine context window announces omissions', () => {
    it('the default view marks entries beyond the window', async () => {
        const client = makeCapturingClient();
        const graph = {
            entry: 'step',
            nodes: [{ id: 'step', systemPrompt: 'sys', userPromptTemplate: null }],
            edges: [],
        };
        /** @type {Record<string, any>} */
        const context = {};
        for (let i = 0; i < 25; i++) context[`node_${i}`] = `output ${i}`;
        const sm = new StateMachine({ graph: graph, options: { client, defaultModel: 'm', context, maxContextEntries: 10 } });
        await sm.run();
        const text = client.calls[0][0].content;
        assert.ok(text.includes('__omittedEntries'), 'the window announces omitted entries');
        assert.ok(text.includes('15 earlier node outputs'), 'the count is exact');
    });
});

// ─── Blind A/B (BLIND_REPORT=1) ─────────────────────────────────────────────

if (process.env.BLIND_REPORT) {
    after(() => {
        report.push({
            scenario: 'context-fidelity',
            input: 'objective threading + folding + window markers',
            implA_redesigned: {
                objectiveAtEveryStep: true,
                markersOnEveryDrop: true,
                windowOmissionsAnnounced: true,
            },
            implB_baseline: {
                objectiveAtEveryStep: false,
                markersOnEveryDrop: false,
                windowOmissionsAnnounced: false,
            },
        });
        const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratchpad');
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'blind-report-context-fidelity.json'), JSON.stringify(report, null, 2));
        console.log(`[blind-report] wrote scratchpad/blind-report-context-fidelity.json (${report.length} scenarios)`);
    });
}
