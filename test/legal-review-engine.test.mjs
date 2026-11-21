// @ts-check

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalFileSessionStore, createAssistantMessage, dedupeMessages } from 'merci-sdk';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import {
    LegalReviewEngine,
    applyReasoning,
    createProposeInputsTool,
    createRecordContextTool,
    formatDocuments,
    loadDefinitions,
    resolveReasoning,
} from '../apps/04-legal-review/engine.mjs';
import { collectDocuments, runCli } from '../apps/04-legal-review/cli.mjs';

const APP_DIR = fileURLToPath(new URL('../apps/04-legal-review/', import.meta.url));
const PHASE_IDS = [0, 1, 2, 3, 4, 5, 6];

/** A stub session whose `run` drives the real loop (journal-resume pattern). */
/** @param {{capture?: Record<string, any>, tools?: Array<any>}} arg0 */
function makeStubSession({ capture = {}, tools = [] } = {}) {
    capture.systemMessages = capture.systemMessages ?? [];
    capture.stepSystems = capture.stepSystems ?? [];
    capture.messageCounts = capture.messageCounts ?? [];
    capture.stepContents = capture.stepContents ?? [];
    return {
        provider: 'OAI',
        model: 'stub',
        _tools: tools,
        _retryPolicy: undefined,
        _lastStepMessages: /** @type {any} */ (undefined),
        _userSystemMessage: '',
        eventEmitter: { emit() {} },
        /** @param {string} content */
        withSystemMessage(content) { this._userSystemMessage = content; capture.systemMessages.push(content); return this; },
        withTools() { return this; },
        /** @param {{messages: Array<Record<string, any>>}} arg0 */
        async *step({ messages }) {
            capture.stepSystems.push(this._userSystemMessage);
            capture.messageCounts.push(messages.length);
            capture.stepContents.push(messages.map((m) => String(m.content ?? '')).join('\n---\n'));
            const sys = String(this._userSystemMessage);
            const tag = /ACTIVE STEP:\s*intake/i.test(sys) ? 'intake' : ((/ACTIVE PHASE:\s*(\d)/.exec(sys) ?? [])[1] ?? '?');
            const lastUser = [...messages].reverse().find((m) => m.role === 'user' || m.type === 'user_message');
            const text = `OUTPUT ${tag} | ${String(lastUser?.content ?? '')}`;
            const out = [...messages, createAssistantMessage({ provider: 'OAI', content: text })];
            this._lastStepMessages = out;
            return { done: true, content: text, messages: out, thoughtSignature: null };
        },
        /** @param {{initialInput: *, options?: *}} arg0 */
        run({ initialInput, options }) {
            return runAgenticLoop({ session: this, messages: initialInput, opts: options ?? {} });
        },
    };
}

/** @param {{m: Record<string, any>}} arg0 */
const isAssistant = ({ m }) => m && (m.role === 'assistant' || m.role === 'model' || m.type === 'assistant_message_text');

const FULL_PARAMS = {
    task: 'legal',
    type: 'review',
    domain: 'NDA',
    jurisdiction: 'Czech Republic',
    epoch: '2026-06-01',
    client: 'the disclosing party',
};

/** @param {{store?: *, threadId?: string, capture?: *, matter?: string}} arg0 */
async function makeEngine({ store = null, threadId = 'thread-1', capture = {}, matter = 'Review this NDA.' } = {}) {
    const definitions = await loadDefinitions({ dir: APP_DIR });
    const session = makeStubSession({ capture });
    const engine = new LegalReviewEngine({ session, store, threadId, definitions, matter });
    engine.intake({ provided: FULL_PARAMS });
    return { engine, session, definitions, capture };
}

/** @param {{engine: LegalReviewEngine}} arg0 */
async function acceptAll({ engine }) {
    while (!engine.isComplete) {
        await engine.runPhase();
        await engine.accept();
    }
}

describe('legal-review — definitions and system slot', () => {
    test('the base prompt is present verbatim and the phases are fixed 0→6', async () => {
        const definitions = await loadDefinitions({ dir: APP_DIR });
        assert.match(definitions.basePrompt, /^# Legal Document Drafting & Review\n/);
        assert.match(definitions.basePrompt, /Phase 6 confirms the Phase 0 criteria before anything leaves the conversation\./);
        for (let i = 0; i <= 6; i++) {
            assert.match(definitions.basePrompt, new RegExp(`### Phase ${i} — `));
        }
        assert.deepEqual(definitions.phases.map((/** @type {any} */ p) => p.id), PHASE_IDS);
    });

    test('the intake system slot starts with the verbatim base prompt plus the intake directive', async () => {
        const { engine, definitions, capture } = await makeEngine();
        await engine.startIntake();
        const slot = capture.systemMessages[0];
        assert.equal(slot.slice(0, definitions.basePrompt.length), definitions.basePrompt);
        assert.match(slot, /ACTIVE STEP: intake/i);
    });

    test('every phase system slot starts with the verbatim base prompt plus its directive', async () => {
        const { engine, definitions, capture } = await makeEngine();
        await acceptAll({ engine });
        assert.equal(capture.systemMessages.length, 7, 'one system slot per phase');
        for (let i = 0; i <= 6; i++) {
            const slot = capture.systemMessages[i];
            assert.equal(slot.slice(0, definitions.basePrompt.length), definitions.basePrompt, `phase ${i}: base prompt is verbatim and untouched`);
            assert.match(slot, new RegExp(`ACTIVE PHASE: ${i} of 6`), `phase ${i}: directive names the active phase`);
        }
    });

    test('the Phase 6 directive carries the accepted Phase 0 goals and success criteria', async () => {
        const { engine, capture } = await makeEngine();
        await acceptAll({ engine });
        assert.match(capture.systemMessages[6], /success criteria set in Phase 0/);
        assert.ok(capture.systemMessages[6].includes(engine.artifacts[0]), 'the Phase 0 artifact is injected into the Phase 6 directive');
    });

    test('Phase 5 is its own phase and forbids truncation', async () => {
        const definitions = await loadDefinitions({ dir: APP_DIR });
        const directive = definitions.phases[5].directive;
        assert.match(directive, /never clustered/i);
        assert.match(directive, /no-truncation/i);
    });
});

describe('legal-review — fixed phase order', () => {
    test('a full pass executes and accepts exactly 0→6, monotonic and deduplicated', async () => {
        const { engine, capture, definitions } = await makeEngine();
        const accepted = [];
        while (!engine.isComplete) {
            await engine.runPhase();
            accepted.push(await engine.accept());
        }
        assert.deepEqual(accepted.map((/** @type {any} */ a) => a.phase), PHASE_IDS);
        assert.deepEqual(engine.executionLog, PHASE_IDS);
        assert.deepEqual(engine.phaseOrder, definitions.phases.map((/** @type {any} */ p) => p.id));

        const ids = engine.history.map((/** @type {any} */ m) => m.merciId).filter(Boolean);
        assert.equal(new Set(ids).size, ids.length, 'history has no duplicate rows');
        assert.deepEqual(dedupeMessages({ messages: engine.history }), engine.history, 'dedupe is a no-op on accepted history');
        for (let i = 1; i < capture.messageCounts.length; i++) {
            assert.ok(capture.messageCounts[i] > capture.messageCounts[i - 1], `history grows into phase ${i}`);
        }
    });
});

describe('legal-review — the four review actions', () => {
    test('feedback appends to the growing history and re-presents the phase', async () => {
        const { engine } = await makeEngine();
        const first = (await engine.runPhase()).output;
        const before = engine._pending?.workingHistory.length ?? 0;
        const revised = await engine.feedback({ text: 'tighten the goal' });
        assert.notEqual(revised, first);
        assert.match(revised, /tighten the goal/);
        assert.ok((engine._pending?.workingHistory.length ?? 0) > before, 'feedback grows history');
        assert.ok(engine._pending?.workingHistory.some((/** @type {any} */ m) => String(m.content).includes('tighten the goal')), 'the feedback row is in history');
    });

    test('regenerate restores the pre-phase snapshot without stacking discarded output', async () => {
        const { engine } = await makeEngine();
        await engine.runPhase();
        const snapshot = engine._pending?.snapshot.length ?? 0;
        await engine.feedback({ text: 'discarded direction' });
        await engine.regenerate();
        assert.equal(engine._pending?.snapshot.length, snapshot);
        assert.equal(engine._pending?.workingHistory.length, snapshot + 2, 'only the kickoff and the fresh answer remain');
        assert.ok(!engine._pending?.workingHistory.some((/** @type {any} */ m) => String(m.content).includes('discarded direction')), 'discarded output must not stack');
    });

    test('manual edit replaces the artifact (and the assistant row)', async () => {
        const { engine } = await makeEngine();
        await engine.runPhase();
        engine.manualEdit({ text: 'EDITED ARTIFACT TEXT' });
        await engine.accept();
        assert.equal(engine.artifacts[0], 'EDITED ARTIFACT TEXT');
        const lastAssistant = [...engine.history].reverse().find((/** @type {any} */ m) => isAssistant({ m }));
        assert.equal(lastAssistant?.content, 'EDITED ARTIFACT TEXT');
    });

    test('accept advances and clears the pending output', async () => {
        const { engine } = await makeEngine();
        await engine.runPhase();
        const record = await engine.accept();
        assert.equal(record.phase, 0);
        assert.equal(engine.phaseIndex, 1);
        assert.equal(engine._pending, null);
        assert.equal(typeof engine.artifacts[0], 'string');
    });
});

describe('legal-review — deterministic intake evaluator', () => {
    test('flags stated vs inferred and asks only load-bearing gaps', async () => {
        const engine = new LegalReviewEngine({ session: makeStubSession(), definitions: await loadDefinitions({ dir: APP_DIR }) });
        const plan = engine.intake({ provided: { task: 'legal', type: 'review' } });
        assert.equal(plan.parameters.jurisdiction.source, 'missing');
        assert.equal(plan.parameters.epoch.source, 'missing');
        assert.equal(plan.parameters.client.source, 'missing');
        assert.deepEqual(plan.questions.map((/** @type {any} */ q) => q.field), ['jurisdiction', 'epoch', 'client']);
        assert.equal(plan.parameters.domain.source, 'inferred');
        assert.equal(plan.parameters.domain.basis.length > 0, true);
        assert.equal(plan.complete, false);
    });

    test('answers to load-bearing questions are recorded as stated', async () => {
        const engine = new LegalReviewEngine({ session: makeStubSession(), definitions: await loadDefinitions({ dir: APP_DIR }) });
        engine.intake({ provided: { task: 'legal' } });
        const plan = engine.answerIntake({ answers: { jurisdiction: 'Czech Republic', epoch: '2026-06-01', client: 'Acme' } });
        assert.equal(plan.complete, true);
        assert.equal(plan.parameters.jurisdiction.source, 'stated');
        assert.equal(plan.parameters.epoch.value, '2026-06-01');
    });

    test('evaluateIntake requires input documents only for document-based modes', async () => {
        const engine = new LegalReviewEngine({ session: makeStubSession(), definitions: await loadDefinitions({ dir: APP_DIR }) });
        engine.recordContext({ fields: { task: 'legal', type: 'review', domain: 'NDA', jurisdiction: 'CZ', epoch: '2026', client: 'Acme' } });
        const before = engine.evaluateIntake();
        assert.equal(before.complete, true);
        assert.equal(before.needsInputs, true);
        assert.equal(before.ready, false);

        engine.attachInputs({ documents: [{ name: 'nda.txt', content: 'text' }] });
        const after = engine.evaluateIntake();
        assert.equal(after.needsInputs, false);
        assert.equal(after.ready, true);

        assert.equal(engine.evaluateIntake({ type: 'question' }).needsInputs, false);
    });

    test('recordContext merges learned fields and reports the remaining gaps', async () => {
        const engine = new LegalReviewEngine({ session: makeStubSession(), definitions: await loadDefinitions({ dir: APP_DIR }) });
        const assessment = engine.recordContext({ fields: { jurisdiction: 'CZ' } });
        assert.equal(engine.known.jurisdiction, 'CZ');
        assert.equal(assessment.parameters.jurisdiction.source, 'stated');
        assert.ok(assessment.questions.some((/** @type {any} */ q) => q.field === 'client'));
    });
});

describe('legal-review — intake tools (HITL)', () => {
    test('record_context returns the evaluator assessment to the model', async () => {
        const engine = new LegalReviewEngine({ session: makeStubSession(), definitions: await loadDefinitions({ dir: APP_DIR }) });
        const tool = createRecordContextTool({ onRecord: ({ fields }) => engine.recordContext({ fields }) });
        const result = JSON.parse(await tool.execute({ args: { jurisdiction: 'CZ', client: 'Acme' } }));
        assert.equal(engine.known.client, 'Acme');
        assert.equal(result.parameters.jurisdiction.source, 'stated');
        assert.ok(Array.isArray(result.questions));
    });

    test('propose_inputs requires operator confirmation and reports the decision', async () => {
        let seen = null;
        const reject = createProposeInputsTool({ confirm: async () => false, onProposed: (a) => { seen = a; } });
        assert.equal(JSON.parse(await reject.execute({ args: { paths: ['a.txt'] } })).approved, false);
        assert.deepEqual(seen, { paths: ['a.txt'], approved: false });

        const approve = createProposeInputsTool({ confirm: async ({ paths }) => paths.length === 2, onProposed: () => {} });
        assert.equal(JSON.parse(await approve.execute({ args: { paths: ['a.txt', 'b.txt'] } })).approved, true);
        assert.equal(JSON.parse(await approve.execute({ args: { paths: ['a.txt'] } })).approved, false);
    });
});

describe('legal-review — chat intake', () => {
    test('startIntake + intakeTurn grow one history and the phase then sees it', async () => {
        const { engine, capture } = await makeEngine();
        const opened = await engine.startIntake();
        assert.equal(typeof opened, 'string');
        const afterOpen = engine.history.length;
        await engine.intakeTurn({ message: 'We act for Acme; Czech law; effective 2026-06-01.' });
        assert.ok(engine.history.length > afterOpen);
        assert.ok(engine.history.some((/** @type {any} */ m) => String(m.content).includes('We act for Acme')));

        engine.finishIntake();
        await engine.runPhase();
        assert.ok(capture.stepContents.some((/** @type {string} */ c) => c.includes('We act for Acme')), 'the chat history reaches Phase 0');
        assert.equal(capture.stepSystems[0], engine.intakeSystemMessage(), 'the intake slot is the intake system message');
    });

    test('attachInputs carries the full document text into the next turn and later phases', async () => {
        const { engine, capture } = await makeEngine();
        await engine.startIntake();
        const sentinel = 'FULL-NDA-TEXT-'.repeat(200);
        engine.attachInputs({ documents: [{ name: 'nda.txt', path: '/tmp/nda.txt', content: sentinel }] });
        assert.equal(engine.documents.length, 1);

        await engine.intakeTurn({ message: 'The inputs are attached; continue.' });
        const attached = engine.history.find((/** @type {any} */ m) => String(m.content).includes('FULL-NDA-TEXT-'));
        assert.ok(attached, 'the attachment block is in history');
        assert.ok(String(attached.content).includes(sentinel), 'the document text is present in full, untruncated');
        assert.ok(String(attached.content).includes('[INPUT DOCUMENTS'));

        engine.finishIntake();
        await engine.runPhase();
        assert.ok(capture.stepContents.some((/** @type {string} */ c) => c.includes(sentinel)), 'later phases see the full document');
        assert.ok(formatDocuments({ documents: [{ name: 'x', content: 'y' }] }).startsWith('[INPUT DOCUMENTS'));
    });
});

describe('legal-review — durable artifacts and resume', () => {
    test('writes one artifact per accepted phase plus the consolidated deliverable in phase order', async () => {
        const { engine } = await makeEngine();
        await acceptAll({ engine });
        const dir = await mkdtemp(join(tmpdir(), 'legal-review-artifacts-'));
        try {
            const { paths } = await engine.writeArtifacts({ dir });
            const files = await readdir(dir);
            for (let i = 0; i <= 6; i++) {
                assert.ok(files.some((f) => f.startsWith(`phase-${i}-`)), `phase ${i} artifact exists`);
            }
            assert.ok(files.includes('deliverable.md'));
            assert.equal(paths.length, 8);
            const consolidated = await readFile(join(dir, 'deliverable.md'), 'utf8');
            let cursor = -1;
            for (let i = 0; i <= 6; i++) {
                const at = consolidated.indexOf(`# Phase ${i} —`);
                assert.ok(at > cursor, `phase ${i} appears in order`);
                cursor = at;
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('a killed run resumes at the last accepted phase with its history and inputs', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'legal-review-store-'));
        try {
            const store = new LocalFileSessionStore({ dir });
            const first = await makeEngine({ store, threadId: 'resume-me', capture: {} });
            first.engine.attachInputs({ documents: [{ name: 'nda.txt', content: 'X' }] });
            await first.engine.runPhase(); await first.engine.accept();
            await first.engine.runPhase(); await first.engine.accept();
            assert.equal(first.engine.phaseIndex, 2);

            const second = await makeEngine({ store, threadId: 'resume-me', capture: {} });
            assert.equal(second.engine.phaseIndex, 0, 'a fresh engine starts at Phase 0');
            assert.equal(await second.engine.resume(), true);
            assert.equal(second.engine.phaseIndex, 2, 'resume continues at the last accepted phase');
            assert.equal(second.engine.history.length, first.engine.history.length);
            assert.equal(second.engine.documents.length, 1);
            assert.equal(second.engine.artifacts[0], first.engine.artifacts[0]);

            const { output } = await second.engine.runPhase();
            assert.match(output, /OUTPUT 2 \|/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('legal-review — reasoning policy', () => {
    test('resolves Gemini (and friends) to the highest effort for the backend/model', async () => {
        const { reasoning } = await loadDefinitions({ dir: APP_DIR });
        assert.deepEqual(resolveReasoning({ provider: 'google_genai', model: 'gemini-3.5-flash', reasoning }), { knob: 'thinkingLevel', value: 'high', source: 'provider:google_genai' });
        assert.deepEqual(resolveReasoning({ provider: 'jai', model: 'google-gemini-3-5-flash-lite', reasoning }), { knob: 'reasoningEffort', value: 'high', source: 'model:gemini' });
        assert.deepEqual(resolveReasoning({ provider: 'openai', model: 'gpt-5.6-terra', reasoning }), { knob: 'reasoningEffort', value: 'high', source: 'model:gpt-5' });
        assert.deepEqual(resolveReasoning({ provider: 'anthropic', model: 'claude-sonnet-4-5', reasoning }), { knob: 'thinkingBudget', value: 32768, source: 'provider:anthropic' });
        assert.deepEqual(resolveReasoning({ provider: 'local', model: 'unknown-model', reasoning }), { knob: 'reasoningEffort', value: 'high', source: 'default' });
    });

    test('applies the resolved knob through the SDK withParameters builder', async () => {
        const { reasoning } = await loadDefinitions({ dir: APP_DIR });
        const calls = /** @type {Array<{knob: string, value: any}>} */ ([]);
        const session = {
            /** @param {{params: Function}} arg0 */
            withParameters({ params }) {
                const builder = new Proxy({}, {
                    /** @param {any} _t @param {string|symbol} key */
                    get: (_t, key) => {
                        /** @param {{v: any}} arg0 */
                        const setter = (arg0) => { calls.push({ knob: String(key), value: arg0?.v }); return builder; };
                        return setter;
                    },
                });
                params(builder);
            },
        };
        const plan = applyReasoning({ session, provider: 'jai', model: 'google-gemini-3-5-flash-lite', reasoning });
        assert.deepEqual(calls, [{ knob: 'reasoningEffort', value: 'high' }]);
        assert.equal(plan?.knob, 'reasoningEffort');
        assert.equal(plan?.value, 'high');
    });
});

describe('legal-review — CLI adapter (chat-only)', () => {
    /** @param {{lines: string[]}} arg0 */
    function scriptedIo({ lines }) {
        const queue = [...lines];
        const printed = /** @type {string[]} */ ([]);
        return {
            printed,
            /** @param {{text: string}} arg0 */
            print: ({ text }) => printed.push(text),
            ask: async () => queue.shift() ?? 'accept',
            confirm: async () => true,
            /** @param {{text: string}} arg0 */
            edit: async ({ text }) => `${text}\n[operator edit]`,
        };
    }

    test('runs intake chat → /begin → all seven phases and writes the deliverable', async () => {
        const storeDir = await mkdtemp(join(tmpdir(), 'legal-review-cli-store-'));
        const outDir = await mkdtemp(join(tmpdir(), 'legal-review-cli-out-'));
        try {
            const io = scriptedIo({ lines: [
                'Review the mutual NDA; we act for Acme s.r.o.; Czech law; effective 2026-06-01.',
                '/begin',
                ...Array(7).fill('accept'),
            ] });
            const session = makeStubSession({ capture: {} });
            const result = await runCli({
                session,
                io,
                store: new LocalFileSessionStore({ dir: storeDir }),
                outDir,
                dataDir: APP_DIR,
            });
            assert.equal(result.status, 'complete');
            assert.ok(io.printed.some((line) => line.includes('Phase 0 — Intent, Goals & Plan')));
            assert.ok(io.printed.some((line) => line.includes('Phase 6 — Summary')));
            const files = await readdir(outDir);
            assert.ok(files.includes('deliverable.md'));
        } finally {
            await rm(storeDir, { recursive: true, force: true });
            await rm(outDir, { recursive: true, force: true });
        }
    });

    test('collectDocuments resolves workspace-relative paths against the tools root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'legal-review-root-'));
        try {
            await mkdir(join(root, 'matter'), { recursive: true });
            await writeFile(join(root, 'matter', 'nda.txt'), 'ROOT-RELATIVE-TEXT', 'utf8');
            const docs = await collectDocuments({ paths: ['matter/nda.txt'], root });
            assert.equal(docs.length, 1);
            assert.equal(docs[0].content, 'ROOT-RELATIVE-TEXT');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test('/inputs attaches a file in full', async () => {
        const storeDir = await mkdtemp(join(tmpdir(), 'legal-review-cli-store2-'));
        const outDir = await mkdtemp(join(tmpdir(), 'legal-review-cli-out2-'));
        const inputDir = await mkdtemp(join(tmpdir(), 'legal-review-input-'));
        try {
            const sentinel = 'CONTRACT-FULL-TEXT-'.repeat(50);
            const file = join(inputDir, 'nda.txt');
            await writeFile(file, sentinel, 'utf8');
            const capture = /** @type {Record<string, any>} */ ({});
            const io = scriptedIo({ lines: [
                'Intake it.',
                `/inputs ${file}`,
                '/begin',
                ...Array(7).fill('accept'),
            ] });
            const result = await runCli({
                session: makeStubSession({ capture }),
                io,
                store: new LocalFileSessionStore({ dir: storeDir }),
                outDir,
                dataDir: APP_DIR,
            });
            assert.equal(result.status, 'complete');
            assert.ok(io.printed.some((line) => line.includes('Attached 1 document(s) in full.')));
            assert.ok(capture.stepContents.some((/** @type {string} */ c) => c.includes(sentinel)), 'the full text reaches the model');
        } finally {
            await rm(storeDir, { recursive: true, force: true });
            await rm(outDir, { recursive: true, force: true });
            await rm(inputDir, { recursive: true, force: true });
        }
    });
});
