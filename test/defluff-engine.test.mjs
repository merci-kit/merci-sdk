// @ts-check

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DefluffEngine,
    PROMPT_FILES,
    buildSystem,
    loadPrompts,
} from '../apps/05-defluff/engine.mjs';
import { indexDocument, isCaptionLine, reconstruct } from '../apps/05-defluff/index.mjs';
import { assembleDocument, deriveBlocks, normalizeAst } from '../apps/05-defluff/structure.mjs';
import { extractProtectedTokens } from '../apps/05-defluff/tokens.mjs';
import {
    hasBlockingFinding,
    normalizeCohesion,
    normalizeFindings,
    normalizeJudge,
    verdictOf,
} from '../apps/05-defluff/judge.mjs';
import { parseArgs, runCli } from '../apps/05-defluff/cli.mjs';
import { LITE_SYSTEM, litePrompt, runLite } from '../apps/05-defluff/lite.mjs';
import { findStructuralCandidates, renderArchitecture, validateArchitecture } from '../apps/05-defluff/architecture.mjs';
import { fillerHint, scanFiller, scanStyle } from '../apps/05-defluff/style.mjs';

const APP_DIR = fileURLToPath(new URL('../apps/05-defluff/', import.meta.url));

const MANDATED = 'The audience are business stakeholders. Be focused. Be relevant. Be precise. The output must be **to  the point**, **no fluff**, exactly as the business loves it.';

const SAMPLE = [
    '# Title',
    '',
    'A short paragraph with 4,500 EUR and 30 days.',
    '',
    '## 1. Definitions',
    '',
    '1.1 "Confidential Information" means any non-public information.',
    '',
    '1.2 "Disclosing Party" means the party that discloses it.',
    '',
    '## 2. Term',
    '',
    '2.1 This Agreement shall remain in force for three (3) years.',
].join('\n');

/** @param {{prompt: string, start: string, end: string}} arg0 */
function section({ prompt, start, end }) {
    const after = prompt.split(start)[1];
    if (after === undefined) return '';
    return after.split(end)[0];
}

/** @param {{prompt: string}} arg0 */
function structureNodes({ prompt }) {
    return [...prompt.matchAll(/^\s*(p\d+) \[([^\]]*)\]/gm)].map((match) => {
        const label = String(match[2]);
        const kind = label.startsWith('heading') ? 'heading' : label.startsWith('signature') ? 'signature' : 'clause';
        return { id: match[1], kind };
    });
}

/** @param {{prompt: string}} arg0 */
function blockIds({ prompt }) {
    return [...prompt.matchAll(/^(b\d+) \[/gm)].map((match) => match[1]);
}

/**
 * Parses the per-block judge payload back into sources and rewrites.
 * @param {{prompt: string}} arg0
 * @returns {Array<{id: string, source: string, rewrite: string, prompt: string}>}
 */
function judgeTargets({ prompt }) {
    return prompt
        .split(/\n(?=## Block )/)
        .filter((part) => part.startsWith('## Block '))
        .map((part) => ({
            id: /^## Block ([\w-]+) —/.exec(part)?.[1] ?? '',
            source: section({ prompt: part, start: '### Source\n', end: '\n\n### Rewrite' }),
            rewrite: section({ prompt: part, start: '### Rewrite\n', end: '\n\n### Advisory context' }),
            prompt: part,
        }))
        .filter((target) => target.id);
}

/**
 * Parses the ids from a block appeal or an audit appeal payload.
 * @param {{prompt: string}} arg0
 * @returns {Array<string>}
 */
function appealIds({ prompt }) {
    const blockIdsFound = [...prompt.matchAll(/^- ([\w.]+) \[/gm)].map((match) => match[1]);
    if (blockIdsFound.length > 0) return blockIdsFound;
    return [...prompt.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1]);
}

/**
 * A scripted LLM: faithful by default, damaged when a test asks for it.
 * @param {{damaged?: Record<string, string>, repairMode?: 'source'|'damage', auditStatus?: string, audit?: Function|null, fix?: Record<string, string>|Function|null, evidence?: string|null, requote?: Record<string, any>|Function|null, cohesion?: string|Function|null, rulesMode?: 'default'|'none', architecture?: Record<string, any>|null, plan?: Record<string, any>|Function|null, planJudge?: Record<string, any>|Function|null, judge?: Record<string, any>|Function|null, blockAppeal?: Record<string, any>|Function|null, auditAppeal?: Record<string, any>|Function|null, cohesionJudge?: Record<string, any>|Function|null, calls?: Array<any>}} arg0
 */
function makeStub({ damaged = {}, repairMode = 'source', auditStatus = 'present', audit = null, fix = null, evidence = null, requote = null, cohesion = null, rulesMode = 'default', architecture = null, plan = null, planJudge = null, judge = null, blockAppeal = null, auditAppeal = null, cohesionJudge = null, calls = [] } = {}) {
    return {
        calls,
        /** @param {{system: string, prompt: string, schema: any, label?: string}} arg0 */
        async json({ system, prompt, label = '' }) {
            calls.push({ kind: 'json', label, prompt, system });
            if (label.startsWith('structure')) {
                return { docType: 'contract', language: 'en', nodes: structureNodes({ prompt }), definedTerms: [], crossRefs: [] };
            }
            if (label === 'architecture') {
                return architecture ?? { findings: [] };
            }
            if (label === 'plan') {
                if (typeof plan === 'function') return plan({ prompt, system });
                return plan ?? {};
            }
            if (label === 'plan:judge') {
                if (typeof planJudge === 'function') return planJudge({ prompt, system });
                return planJudge ?? { verdict: 'ok', findings: [] };
            }
            if (label === 'salience') {
                return { blocks: blockIds({ prompt }).map((id) => ({ id, decision: 'keep', why: 'needed to act' })) };
            }
            if (label === 'rules' || label.startsWith('rules:')) {
                if (rulesMode === 'none') return { rules: [], edges: [] };
                return { rules: blockIds({ prompt }).map((id, index) => ({ id: `r${index + 1}`, blockId: id, modality: 'obligation', object: 'perform' })), edges: [] };
            }
            if (label === 'judge' || label.startsWith('judge:')) {
                return {
                    blocks: judgeTargets({ prompt }).map((target) => {
                        const decided = typeof judge === 'function'
                            ? judge(target)
                            : judge?.[target.id] ?? { verdict: 'ok', findings: [] };
                        return { id: target.id, ...decided };
                    }),
                };
            }
            if (label === 'cohesion:judge') {
                const before = section({ prompt, start: '## Before\n', end: '\n\n## After' });
                const after = section({ prompt, start: '## After\n', end: '\n\nCheck that' });
                if (typeof cohesionJudge === 'function') return cohesionJudge({ before, after, prompt });
                return cohesionJudge ?? { verdict: 'ok', findings: [] };
            }
            if (label.startsWith('appeal:block:')) {
                if (typeof blockAppeal === 'function') return blockAppeal({ prompt, ids: appealIds({ prompt }) });
                return blockAppeal ?? { appeals: [] };
            }
            if (label.startsWith('appeal:audit:')) {
                if (typeof auditAppeal === 'function') return auditAppeal({ prompt, ids: appealIds({ prompt }) });
                return auditAppeal ?? { appeals: [] };
            }
            if (label === 'audit' || label.startsWith('audit:')) {
                if (label.startsWith('audit:requote')) {
                    if (typeof requote === 'function') return requote({ prompt });
                    return requote ?? { quotes: [] };
                }
                const document = section({ prompt, start: '## Final text\n', end: '\n\n## Rule graph' });
                const graph = JSON.parse(section({ prompt, start: '## Rule graph\n', end: '\n\n## Playbook positions' }) || '{"rules":[]}');
                if (typeof audit === 'function') return audit({ prompt, document, graph, label });
                const grounded = evidence ?? document.slice(0, 40);
                return {
                    rules: (graph.rules ?? []).map((/** @type {any} */ rule) => ({ id: rule.id, status: auditStatus, evidence: grounded })),
                    positions: [],
                };
            }
            if (label.startsWith('fix:')) {
                const id = label.split(':')[2] ?? '';
                const source = section({ prompt, start: '## Source block\n', end: '\n\n## Current rewrite' });
                const corrected = typeof fix === 'function'
                    ? fix({ prompt, id })
                    : fix?.[id] ?? source;
                return { blocks: corrected ? [{ id, text: corrected }] : [] };
            }
            return {};
        },
        /** @param {{system: string, prompt: string, label?: string}} arg0 */
        async text({ system, prompt, label = '' }) {
            calls.push({ kind: 'text', label, prompt, system });
            if (label.startsWith('rewrite:')) {
                const id = label.split(':')[1];
                if (damaged[id]) return damaged[id];
                const single = section({ prompt, start: '## Source block\n', end: '\nReturn only the rewritten block.' });
                if (single) return single;
                const merged = section({ prompt, start: '## Source blocks\n', end: '\nReturn only the rewritten block.' });
                return merged
                    .split(/\n(?=### b\d+ — )/)
                    .map((part) => part.replace(/^### b\d+ — [^\n]*\n/, '').trim())
                    .filter(Boolean)
                    .join('\n\n');
            }
            if (label.startsWith('repair:')) {
                const id = label.split(':')[1];
                if (repairMode === 'damage' && damaged[id]) return damaged[id];
                return section({ prompt, start: '## Source block\n', end: '\n\n## Current rewrite' });
            }
            if (label === 'cohesion') {
                const document = section({ prompt, start: 'Document:\n\n', end: '\n\nReturn the whole document.' });
                if (typeof cohesion === 'function') return cohesion({ document });
                if (cohesion !== null) return cohesion;
                return document;
            }
            return '';
        },
    };
}

/** @param {{stub: any, tier?: 'static'|'guided', strategy?: 'conservative'|'aggressive', onReview?: Function|null, outDir?: string|null, emit?: Array<string>, playbook?: any, reviewAt?: Array<string>|null, fast?: boolean, style?: 'plain'|'ste', fixRounds?: number}} arg0 */
async function makeEngine({ stub, tier = 'static', strategy = 'conservative', onReview = null, outDir = null, emit = ['text', 'report'], playbook = null, reviewAt = null, fast = false, style = 'plain', fixRounds = 3 }) {
    const prompts = await loadPrompts({ dir: APP_DIR });
    return new DefluffEngine({ llm: stub, prompts, tier, strategy, mode: 'normal', style, outDir, emit, playbook, reviewAt, onReview, fast, fixRounds });
}

describe('index', () => {
    test('round-trips the source byte for byte', () => {
        const fixture = readFile(join(APP_DIR, 'fixtures', 'sample-contract.txt'), 'utf8');
        /** @type {Array<string>} */
        const samples = [SAMPLE, 'One line only.\n', '\n\n  padded  \n\n\nlast\n'];
        return fixture.then((text) => {
            samples.push(text);
            for (const sample of samples) {
                const index = indexDocument({ text: sample });
                assert.equal(reconstruct({ index }), sample);
            }
        });
    });

    test('deleting a paragraph breaks the round-trip (the check can fail)', () => {
        const index = indexDocument({ text: SAMPLE });
        index.paragraphs.splice(1, 1);
        assert.notEqual(reconstruct({ index }), SAMPLE);
    });

    test('nests 3.2.1 under 3.2 under 3, and keeps a numbered clause under its heading', () => {
        const index = indexDocument({ text: '1. Top\n1.1 Mid\n1.1.1 Leaf\n2. Next' });
        const byText = new Map(index.paragraphs.map((paragraph) => [paragraph.text, paragraph]));
        assert.equal(byText.get('1.1 Mid')?.parentId, byText.get('1. Top')?.id);
        assert.equal(byText.get('1.1.1 Leaf')?.parentId, byText.get('1.1 Mid')?.id);
        assert.equal(byText.get('2. Next')?.parentId, null);

        const withHeading = indexDocument({ text: '## 1. Definitions\n1.1 A term means a thing.' });
        assert.equal(withHeading.paragraphs[1].parentId, withHeading.paragraphs[0].id);
    });

    test('an all-caps numbered caption is its own paragraph', () => {
        const index = indexDocument({ text: '4. PURCHASING THROUGH RESELLERS AND DISTRIBUTORS\nThis Agreement applies to purchases.' });
        assert.equal(index.paragraphs.length, 2);
        assert.equal(index.paragraphs[0].text, '4. PURCHASING THROUGH RESELLERS AND DISTRIBUTORS');
        assert.equal(index.paragraphs[1].text, 'This Agreement applies to purchases.');
        assert.equal(reconstruct({ index }), '4. PURCHASING THROUGH RESELLERS AND DISTRIBUTORS\nThis Agreement applies to purchases.');
        assert.equal(isCaptionLine({ line: '16.1. Entire Agreement.' }), false);
        assert.equal(isCaptionLine({ line: '1. PARTIES' }), true);
    });

    test('a year at the start of a line is not a clause number', () => {
        const index = indexDocument({ text: '2026. The parties agree to meet.\n2027. They meet again.' });
        assert.equal(index.paragraphs[0].kind, 'para');
    });
});

describe('structure', () => {
    test('drops unknown ids, reports missing ones, repairs a cycle', () => {
        const index = indexDocument({ text: 'Title\n\nBody one.\n\nBody two.' });
        const result = normalizeAst({
            index,
            ast: {
                docType: 'contract',
                nodes: [
                    { id: 'p1', kind: 'heading' },
                    { id: 'p9', kind: 'clause' },
                    { id: 'p2', kind: 'clause', parent: 'p3' },
                    { id: 'p3', kind: 'clause', parent: 'p2' },
                ],
            },
        });
        assert.deepEqual(result.dropped, ['p9']);
        assert.deepEqual(result.missing, []);
        assert.ok(result.filled.length === 0);
        assert.ok(result.reattached.includes('p2') || result.reattached.includes('p3'));
    });

    test('reports and fills a missing annotation', () => {
        const index = indexDocument({ text: 'Title\n\nBody one.' });
        const partial = normalizeAst({ index, ast: { docType: 'contract', nodes: [{ id: 'p1', kind: 'heading' }] }, fill: false });
        assert.deepEqual(partial.missing, ['p2']);
        const filled = normalizeAst({ index, ast: { docType: 'contract', nodes: [{ id: 'p1', kind: 'heading' }] }, fill: true });
        assert.deepEqual(filled.filled, ['p2']);
        assert.equal(filled.ast.nodes.length, 2);
    });

    test('blocks exclude headings and carry the heading path', () => {
        const text = '# Agreement\n\n## 1. Definitions\n\n1.1 A term means a thing.\n\n## 2. Obligations\n\n2.1 The Recipient shall keep it confidential.';
        const index = indexDocument({ text });
        const byText = new Map(index.paragraphs.map((paragraph) => [paragraph.text, paragraph]));
        const ast = {
            docType: 'contract',
            nodes: [
                { id: byText.get('# Agreement')?.id, kind: 'heading', parentId: null },
                { id: byText.get('## 1. Definitions')?.id, kind: 'heading', parentId: byText.get('# Agreement')?.id },
                { id: byText.get('1.1 A term means a thing.')?.id, kind: 'definition', parentId: byText.get('## 1. Definitions')?.id },
                { id: byText.get('## 2. Obligations')?.id, kind: 'heading', parentId: byText.get('# Agreement')?.id },
                { id: byText.get('2.1 The Recipient shall keep it confidential.')?.id, kind: 'obligation', parentId: byText.get('## 2. Obligations')?.id },
            ],
        };
        const { blocks } = deriveBlocks({ ast, index });
        assert.equal(blocks.length, 2);
        assert.ok(blocks.every((block) => !block.nodeIds.includes(String(byText.get('# Agreement')?.id))));
        assert.deepEqual(blocks[1].headingPath, ['Agreement', '2. Obligations']);
        const rebuilt = assembleDocument({ index, blocks, rewrites: { [blocks[0].id]: 'SHORT ONE.', [blocks[1].id]: 'SHORT TWO.' } });
        assert.ok(rebuilt.includes('# Agreement'));
        assert.ok(rebuilt.includes('## 1. Definitions'));
        assert.ok(rebuilt.includes('SHORT ONE.'));
        assert.ok(rebuilt.includes('SHORT TWO.'));
    });

    test('never crosses a nested heading and keeps source order on assembly', () => {
        const text = '1. Payments\n1.1 The Buyer shall pay 100 EUR.\n### Late payment\n1.2 Interest accrues daily.';
        const index = indexDocument({ text });
        const [root, first, heading, second] = index.paragraphs;
        const ast = {
            docType: 'contract',
            nodes: [
                { id: root.id, kind: 'clause', parentId: null },
                { id: first.id, kind: 'obligation', parentId: root.id },
                { id: heading.id, kind: 'heading', parentId: root.id },
                { id: second.id, kind: 'obligation', parentId: root.id },
            ],
        };
        const { blocks } = deriveBlocks({ ast, index });
        assert.equal(blocks.length, 2);
        assert.deepEqual(blocks[0].nodeIds, [root.id, first.id]);
        assert.deepEqual(blocks[1].nodeIds, [second.id]);
        const rebuilt = assembleDocument({ index, blocks, rewrites: { [blocks[0].id]: 'FIRST BLOCK.', [blocks[1].id]: 'SECOND BLOCK.' } });
        const firstAt = rebuilt.indexOf('FIRST BLOCK.');
        const headingAt = rebuilt.indexOf('### Late payment');
        const secondAt = rebuilt.indexOf('SECOND BLOCK.');
        assert.ok(firstAt >= 0 && headingAt > firstAt && secondAt > headingAt, rebuilt);
    });

    test('splits an oversized clause at child boundaries', () => {
        const text = '1. Payments\n1.1 The Buyer shall pay 4,500 EUR within 30 days.\n1.2 The Seller shall invoice on the first day.';
        const index = indexDocument({ text });
        const [root, first, second] = index.paragraphs;
        const ast = {
            docType: 'contract',
            nodes: [
                { id: root.id, kind: 'clause', parentId: null },
                { id: first.id, kind: 'obligation', parentId: root.id },
                { id: second.id, kind: 'obligation', parentId: root.id },
            ],
        };
        const { blocks } = deriveBlocks({ ast, index, blockMaxChars: 50 });
        assert.equal(blocks.length, 2);
        assert.deepEqual(blocks.map((block) => block.rootNodeId), [first.id, second.id]);
    });
});

describe('meaning judge', () => {
    const block = {
        id: 'b1',
        text: 'The Buyer shall pay 4,500 EUR within 30 days under Section 3.2, and the Seller may not disclose the Confidential Information.',
    };

    test('a faithful rewrite produces no findings', () => {
        const normalized = normalizeJudge({
            raw: { blocks: [{ id: 'b1', verdict: 'ok', findings: [] }] },
            blocks: [block],
            rewrites: { b1: block.text },
        });
        assert.equal(normalized.blocks[0].verdict, 'ok');
        assert.equal(hasBlockingFinding({ findings: normalized.findings }), false);
    });

    test('a paraphrase is not a change: prior to -> before', () => {
        const source = { id: 'b1', text: 'Acme will notify Customer thirty (30) days prior to termination.' };
        const normalized = normalizeJudge({
            raw: { blocks: [{ id: 'b1', verdict: 'ok', findings: [] }] },
            blocks: [source],
            rewrites: { b1: 'Acme will notify Customer thirty (30) days before termination.' },
        });
        assert.equal(normalized.blocks[0].verdict, 'ok');
    });

    test('computes the verdict from blocking findings, not the model verdict', () => {
        const normalized = normalizeJudge({
            raw: {
                blocks: [{
                    id: 'b1',
                    verdict: 'ok',
                    findings: [{ kind: 'omission', severity: 'blocking', source_quote: '4,500 EUR', rewrite_quote: '', why: 'the amount disappeared' }],
                }],
            },
            blocks: [block],
            rewrites: { b1: 'The Buyer shall pay within 30 days under Section 3.2, and the Seller may not disclose the Confidential Information.' },
        });
        assert.equal(normalized.blocks[0].verdict, 'lost');
        assert.equal(hasBlockingFinding({ findings: normalized.findings }), true);
    });

    test('drops an unknown block id and fails closed on a missing id', () => {
        const normalized = normalizeJudge({
            raw: { blocks: [{ id: 'b999', verdict: 'ok', findings: [] }] },
            blocks: [block],
            rewrites: { b1: block.text },
        });
        assert.deepEqual(normalized.unknown, ['b999']);
        assert.deepEqual(normalized.missing, ['b1']);
        assert.equal(normalized.blocks[0].verdict, 'changed');
        assert.equal(normalized.findings[0].code, 'JUDGE_MISSING');
    });

    test('grounds a short literal quote and rejects a fabricated one', () => {
        const grounded = normalizeFindings({
            list: [{ kind: 'duration', severity: 'blocking', source_quote: '30 days', rewrite_quote: '30 days', why: 'same' }],
            source: block.text,
            rewrite: block.text,
            idPrefix: 'b1.f',
        });
        assert.equal(grounded[0].ungrounded, false);
        const fabricated = normalizeFindings({
            list: [{ kind: 'duration', severity: 'blocking', source_quote: '90 days', rewrite_quote: '', why: 'invented' }],
            source: block.text,
            rewrite: block.text,
            idPrefix: 'b1.f',
        });
        assert.equal(fabricated[0].ungrounded, true);
    });

    test('an overruled finding no longer blocks', () => {
        const findings = normalizeFindings({
            list: [{ kind: 'condition', severity: 'blocking', source_quote: 'thirty (30) days', rewrite_quote: 'thirty (30) days', why: 'false positive' }],
            source: 'thirty (30) days prior',
            rewrite: 'thirty (30) days before',
            idPrefix: 'b1.f',
        });
        findings[0].overruled = true;
        assert.equal(hasBlockingFinding({ findings }), false);
        assert.equal(verdictOf({ findings }), 'ok');
    });

    test('cohesion normalization blocks on a grounded finding and on a bare block', () => {
        const grounded = normalizeCohesion({
            raw: { verdict: 'blocked', findings: [{ kind: 'modality', severity: 'blocking', source_quote: 'shall remain', rewrite_quote: 'may remain', why: 'permission' }] },
            before: 'This shall remain in force.',
            after: 'This may remain in force.',
        });
        assert.equal(grounded.verdict, 'blocked');
        const bare = normalizeCohesion({ raw: { verdict: 'blocked', findings: [] }, before: 'a', after: 'b' });
        assert.equal(bare.verdict, 'blocked');
    });
});

describe('advisory tokens', () => {
    test('extracts every protected class from one sentence', () => {
        const tokens = extractProtectedTokens({
            text: 'The Buyer shall pay 4,500 EUR within 30 days under Section 3.2.',
        });
        const kinds = new Set(tokens.map((token) => token.kind));
        for (const kind of ['money', 'duration', 'reference']) assert.ok(kinds.has(kind), `missing ${kind}`);
    });
});

describe('engine', () => {
    const source = SAMPLE;

    test('runs the fixed DAG and rewrites every block', async () => {
        const stub = makeStub();
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass');
        assert.equal(result.exitCode, 0);
        const order = engine.executionLog;
        assert.deepEqual(order.slice(0, 3), ['index', 'structure', 'blocks']);
        assert.ok(order.indexOf('salience') > order.indexOf('blocks'));
        assert.ok(order.indexOf('rules') > order.indexOf('blocks'));
        assert.ok(order.indexOf('plan') > order.indexOf('architecture'));
        assert.ok(order.indexOf('rewrite') > order.indexOf('plan'));
        assert.ok(order.indexOf('judge') > order.indexOf('rewrite'));
        assert.ok(order.indexOf('repair') > order.indexOf('judge'));
        assert.equal(order.at(-1), 'write');
        const rewrites = stub.calls.filter((call) => call.label.startsWith('rewrite:'));
        assert.equal(rewrites.length, engine.state.targetBlocks.length);
        assert.ok(engine.state.blocks.length >= 4);
    });

    test('conservative proposes a structural merge; aggressive applies it', async () => {
        const plan = {
            blockOps: [{
                id: 'o1',
                op: 'merge',
                source: ['b2', 'b3'],
                target: 'm1',
                reason: 'the two definitions belong in one paragraph',
                evidence: ['1.1 "Confidential Information" means any non-public information.'],
                confidence: 'high',
                mode: 'apply',
                mustKeep: ['Confidential Information', 'non-public information'],
                targetChars: 180,
            }],
        };
        const conservativeStub = makeStub({ plan });
        const conservative = await makeEngine({ stub: conservativeStub });
        const conservativeResult = await conservative.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(conservativeResult.status, 'pass');
        assert.equal(conservativeResult.state.plan.applied, 0);
        assert.equal(conservativeResult.state.plan.proposed, 1);
        assert.equal(conservativeResult.state.targetBlocks.length, conservativeResult.state.blocks.length);
        assert.ok(conservativeResult.report.includes('proposed'));
        assert.ok(!conservativeStub.calls.some((call) => call.label === 'plan:judge'));

        const aggressiveStub = makeStub({ plan, planJudge: { verdict: 'ok', findings: [] } });
        const aggressive = await makeEngine({ stub: aggressiveStub, strategy: 'aggressive' });
        const aggressiveResult = await aggressive.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(aggressiveResult.status, 'pass');
        assert.equal(aggressiveResult.state.plan.applied, 1);
        assert.equal(aggressiveResult.state.targetBlocks.length, aggressiveResult.state.blocks.length - 1);
        assert.ok(aggressiveStub.calls.some((call) => call.label === 'plan:judge'));
        const mergedRewrite = aggressiveStub.calls.find((call) => call.label === 'rewrite:m1');
        assert.ok(mergedRewrite.prompt.includes('## Compression budget'));
        assert.ok(mergedRewrite.prompt.includes('about 180 characters'));
        assert.ok(aggressiveResult.state.document.includes('1.1'));
        assert.ok(aggressiveResult.state.document.includes('1.2'));
    });

    test('aggressive moves a block inside its run', async () => {
        const plan = { blockOps: [{ id: 'o1', op: 'move', source: ['b2'], after: 'b3', reason: 'keep the term definition together', mode: 'apply' }] };
        const stub = makeStub({ plan });
        const engine = await makeEngine({ stub, strategy: 'aggressive' });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass');
        assert.equal(result.state.plan.applied, 1);
        assert.ok(result.state.document.indexOf('1.2') < result.state.document.indexOf('1.1'));
    });

    test('aggressive keeps a cross-heading move in place and proposes it instead', async () => {
        const plan = { blockOps: [{ id: 'o1', op: 'move', source: ['b2'], after: 'b4', reason: 'move the definition under Term', mode: 'apply' }] };
        const stub = makeStub({ plan });
        const engine = await makeEngine({ stub, strategy: 'aggressive' });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass');
        assert.equal(result.state.plan.applied, 0);
        assert.equal(result.state.plan.proposed, 1);
        assert.ok(result.state.document.indexOf('1.1') < result.state.document.indexOf('2.1'));
    });

    test('aggressive fails closed when the plan judge blocks the merge', async () => {
        const plan = { blockOps: [{ id: 'o1', op: 'merge', source: ['b2', 'b3'], target: 'm1', mode: 'apply' }] };
        const planJudge = {
            verdict: 'blocked',
            findings: [{ kind: 'merge', severity: 'blocking', source_rules: ['r2', 'r3'], target_rules: [], why: 'the two definitions have different objects' }],
        };
        const stub = makeStub({ plan, planJudge });
        const engine = await makeEngine({ stub, strategy: 'aggressive' });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.exitCode, 2);
        assert.equal(result.state.targetBlocks.length, result.state.blocks.length);
        assert.ok(result.report.includes('different objects'));
    });

    test('conservative applies an exact rule merge without a plan judge', async () => {
        const plan = {
            targetRules: [{
                id: 't1',
                blockId: 'b2',
                sourceRuleIds: ['r2', 'r3'],
                actor: '',
                modality: 'obligation',
                object: 'perform',
                conditions: [],
                exceptions: [],
                amount: '',
                date: '',
            }],
        };
        const stub = makeStub({ plan });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass');
        assert.equal(result.state.targetRules.length, result.state.rules.length - 1);
        assert.ok(!stub.calls.some((call) => call.label === 'plan:judge'));
    });

    test('aggressive fails fidelity when a dropped block carries an uncovered rule', async () => {
        const plan = { blockOps: [{ id: 'o1', op: 'drop', source: ['b2'], reason: 'redundant', mode: 'apply' }] };
        const stub = makeStub({ plan });
        const engine = await makeEngine({ stub, strategy: 'aggressive' });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.exitCode, 2);
        assert.ok(result.report.includes('r2'));
        assert.ok(result.report.includes('not covered'));
    });

    test('fails closed when the audit reports a dropped rule', async () => {
        const stub = makeStub({ auditStatus: 'dropped' });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'fail');
        assert.equal(result.exitCode, 2);
        assert.ok(result.report.includes('audit: r1 — dropped'));
    });

    test('fails closed when audit evidence is not in the output', async () => {
        const stub = makeStub({ evidence: 'this sentence is nowhere in the document' });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.exitCode, 2);
        assert.ok(result.report.includes('evidence not found in the output'));
    });

    test('repairs a damaged block once, then passes', async () => {
        const probe = await makeEngine({ stub: makeStub() });
        await probe.run({ text: source, sourcePath: 'sample.txt' });
        const target = probe.state.blocks.find((/** @type {any} */ block) => block.text.includes('three (3) years'));
        assert.ok(target, 'fixture must carry the duration block');
        const judge = (/** @type {{id: string, source: string, rewrite: string}} */ { id, source, rewrite }) => {
            if (id !== target.id || rewrite.includes('three (3) years')) return { verdict: 'ok', findings: [] };
            return {
                verdict: 'lost',
                findings: [{ kind: 'omission', severity: 'blocking', source_quote: 'three (3) years', rewrite_quote: '', why: 'the duration disappeared' }],
            };
        };
        const stub = makeStub({ damaged: { [target.id]: 'This Agreement stays in force.' }, repairMode: 'source', judge });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass', JSON.stringify(result.state.failures));
        assert.equal(result.state.repairs.get(target.id)?.rounds, 1);
        assert.ok(result.state.document.includes('three (3) years'));
    });

    test('keeps the source after two failed repair rounds', async () => {
        const probe = await makeEngine({ stub: makeStub() });
        await probe.run({ text: source, sourcePath: 'sample.txt' });
        const target = probe.state.blocks.find((/** @type {any} */ block) => block.text.includes('three (3) years'));
        const judge = (/** @type {{id: string, source: string, rewrite: string}} */ { id, source, rewrite }) => {
            if (id !== target.id || rewrite.includes('three (3) years')) return { verdict: 'ok', findings: [] };
            return {
                verdict: 'lost',
                findings: [{ kind: 'omission', severity: 'blocking', source_quote: 'three (3) years', rewrite_quote: '', why: 'the duration disappeared' }],
            };
        };
        const stub = makeStub({ damaged: { [target.id]: 'This Agreement stays in force.' }, repairMode: 'damage', judge });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        const repairCalls = stub.calls.filter((call) => call.label.startsWith(`repair:${target.id}`));
        assert.equal(repairCalls.length, 2);
        assert.equal(result.state.kept.length, 1);
        assert.ok(result.report.includes('KEPT'));
        assert.ok(result.state.document.includes('three (3) years'));
    });

    test('rejects an empty rewrite without asking the appeal', async () => {
        const probe = await makeEngine({ stub: makeStub() });
        await probe.run({ text: source, sourcePath: 'sample.txt' });
        const target = probe.state.blocks.find((/** @type {any} */ block) => block.text.includes('three (3) years'));
        const stub = makeStub({
            damaged: { [target.id]: '   ' },
            blockAppeal: () => ({ appeals: [{ id: `${target.id}.f1`, decision: 'overruled', why: 'not a semantic finding' }] }),
        });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass', JSON.stringify(result.state.failures));
        assert.equal(stub.calls.filter((call) => call.label.startsWith('appeal:block:')).length, 0);
        assert.ok(result.state.document.includes('three (3) years'));
    });

    test('feeds an ungrounded judge finding back and restores the source block', async () => {
        const probe = await makeEngine({ stub: makeStub() });
        await probe.run({ text: source, sourcePath: 'sample.txt' });
        const target = probe.state.blocks.find((/** @type {any} */ block) => block.text.includes('three (3) years'));
        const judge = (/** @type {{id: string}} */ { id }) => {
            if (id !== target.id) return { verdict: 'ok', findings: [] };
            return {
                verdict: 'changed',
                findings: [{ kind: 'duration', severity: 'blocking', source_quote: 'ninety (90) years', rewrite_quote: '', why: 'invented' }],
            };
        };
        const stub = makeStub({ damaged: { [target.id]: 'This Agreement stays in force.' }, judge });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass', JSON.stringify(result.state.failures));
        assert.equal(result.state.fixes.length, 1);
        assert.equal(result.state.fixes[0].blockId, target.id);
        assert.ok(result.state.fixes[0].reasons.some((/** @type {string} */ reason) => reason.includes('judge:') && reason.includes('evidence not found')));
        assert.equal(result.state.fixes[0].restored, true);
        assert.ok(result.report.includes('## Fail-fix loop'));
        assert.ok(result.report.includes('KEPT — fix loop restored source'));
        const fixCall = stub.calls.find((call) => call.label === `fix:1:${target.id}`);
        assert.ok(fixCall, 'the failure must be fed back to the fix agent');
        assert.ok(fixCall.prompt.includes('## Gate failures to correct'));
        assert.ok(fixCall.prompt.includes('judge:') && fixCall.prompt.includes('evidence not found'));
        assert.ok(fixCall.prompt.includes('## Source block'));
    });

    test('fails closed on an ungrounded finding when the fail-fix loop is disabled', async () => {
        const probe = await makeEngine({ stub: makeStub() });
        await probe.run({ text: source, sourcePath: 'sample.txt' });
        const target = probe.state.blocks.find((/** @type {any} */ block) => block.text.includes('three (3) years'));
        const judge = (/** @type {{id: string}} */ { id }) => {
            if (id !== target.id) return { verdict: 'ok', findings: [] };
            return {
                verdict: 'changed',
                findings: [{ kind: 'duration', severity: 'blocking', source_quote: 'ninety (90) years', rewrite_quote: '', why: 'invented' }],
            };
        };
        const stub = makeStub({ damaged: { [target.id]: 'This Agreement stays in force.' }, judge });
        const engine = await makeEngine({ stub, fixRounds: 0 });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'fail');
        assert.ok(result.state.failures.some((/** @type {string} */ failure) => failure.includes('judge:') && failure.includes('evidence not found')));
        assert.equal(stub.calls.filter((call) => call.label.startsWith('fix:')).length, 0);
    });

    test('feeds an audit failure back with the rule and re-audits the corrected block', async () => {
        const probe = await makeEngine({ stub: makeStub() });
        await probe.run({ text: source, sourcePath: 'sample.txt' });
        const rule = probe.state.targetRules[0];
        const block = probe.state.targetBlocks.find((/** @type {any} */ item) => item.id === rule.blockId);
        assert.ok(rule && block, 'fixture must carry a target rule');
        let auditCalls = 0;
        const audit = (/** @type {{document: string, graph: Record<string, any>}} */ { document, graph }) => {
            auditCalls += 1;
            return {
                rules: (graph.rules ?? []).map((/** @type {any} */ item) => ({
                    id: item.id,
                    status: item.id === rule.id && auditCalls === 1 ? 'weakened' : 'present',
                    evidence: document.slice(0, 40),
                })),
                positions: [],
            };
        };
        const stub = makeStub({
            damaged: { [block.id]: 'This Agreement stays in force.' },
            repairMode: 'damage',
            audit,
        });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass', JSON.stringify(result.state.failures));
        assert.ok(auditCalls >= 2, 'the audit must run again after the correction');
        assert.equal(result.state.fixes.length, 1);
        assert.ok(result.state.fixes[0].reasons.some((/** @type {string} */ reason) => reason.includes(`audit: ${rule.id} — weakened`)));
        const fixCall = stub.calls.find((call) => call.label === `fix:1:${block.id}`);
        assert.ok(fixCall, 'the audit failure must be fed back to the fix agent');
        assert.ok(fixCall.prompt.includes(`audit: ${rule.id} — weakened`));
        assert.ok(fixCall.prompt.includes('## Rules carried by this block'));
        assert.ok(result.state.document.includes(block.text.slice(0, 30)));
    });

    test('a block appeal overrules a false positive without repairing', async () => {
        const probe = await makeEngine({ stub: makeStub() });
        await probe.run({ text: source, sourcePath: 'sample.txt' });
        const target = probe.state.blocks.find((/** @type {any} */ block) => block.text.includes('three (3) years'));
        const judge = (/** @type {{id: string}} */ { id }) => {
            if (id !== target.id) return { verdict: 'ok', findings: [] };
            return {
                verdict: 'changed',
                findings: [{ kind: 'meaning', severity: 'blocking', source_quote: 'three (3) years', rewrite_quote: 'three (3) years', why: 'wording changed' }],
            };
        };
        const blockAppeal = (/** @type {{ids: Array<string>}} */ { ids }) => ({
            appeals: ids.map((id) => ({ id, decision: 'overruled', why: 'faithful paraphrase' })),
        });
        const stub = makeStub({
            damaged: { [target.id]: 'This Agreement shall remain in force for three (3) years.' },
            judge,
            blockAppeal,
        });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass', JSON.stringify(result.state.failures));
        assert.equal(result.state.judge.appeals.length, 1);
        assert.ok(result.state.notes.some((/** @type {string} */ note) => note.includes('judge appeal overruled')));
        assert.equal(stub.calls.filter((call) => call.label.startsWith('repair:')).length, 0);
    });

    test('an audit appeal overrules a weakened verdict when the rule survives', async () => {
        const probe = await makeEngine({ stub: makeStub() });
        await probe.run({ text: source, sourcePath: 'sample.txt' });
        const target = probe.state.blocks.find((/** @type {any} */ block) => block.text.includes('three (3) years'));
        const stub = makeStub({
            damaged: { [target.id]: 'This Agreement shall remain in force for three (3) years.' },
            auditStatus: 'weakened',
            auditAppeal: (/** @type {{ids: Array<string>}} */ { ids }) => ({
                appeals: ids.map((id) => ({
                    id,
                    decision: 'overruled',
                    evidence: 'shall remain in force for three (3) years',
                    why: 'the obligation and its duration survive',
                })),
            }),
        });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass', JSON.stringify(result.state.failures));
        assert.ok(result.state.audit.appeals.length >= 1);
        assert.ok(result.state.notes.some((/** @type {string} */ note) => note.includes('audit appeal overruled')));
    });

    test('reverts a cohesion pass that is implausibly short', async () => {
        const stub = makeStub({ cohesion: 'A much shorter unrelated document.' });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.state.cohesion.applied, false);
        assert.ok(result.state.cohesion.reason.includes('half'));
        assert.ok(result.state.document.includes('three (3) years'));
    });

    test('reverts a cohesion pass the judge finds semantically lossy', async () => {
        const stub = makeStub({
            cohesion: (/** @type {{document: string}} */ { document }) => document.replace('shall remain in force', 'may remain in force'),
            cohesionJudge: {
                verdict: 'blocked',
                findings: [{ kind: 'modality', severity: 'blocking', source_quote: 'shall remain in force', rewrite_quote: 'may remain in force', why: 'the obligation became a permission' }],
            },
        });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.state.cohesion.applied, false);
        assert.ok(result.state.cohesion.reason.includes('cohesion judge'));
        assert.ok(result.state.document.includes('shall remain in force'));
    });

    test('static never asks; guided asks at every configured checkpoint', async () => {
        const staticReview = { calls: 0 };
        const staticEngine = await makeEngine({ stub: makeStub(), onReview: () => { staticReview.calls += 1; return { action: 'accept' }; } });
        await staticEngine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(staticReview.calls, 0);

        /** @type {Array<string>} */
        const checkpoints = [];
        const guidedEngine = await makeEngine({
            stub: makeStub(),
            tier: 'guided',
            onReview: (/** @type {{checkpoint: string}} */ { checkpoint }) => { checkpoints.push(checkpoint); return { action: 'accept' }; },
        });
        await guidedEngine.run({ text: source, sourcePath: 'sample.txt' });
        assert.deepEqual(checkpoints, ['structure', 'rules', 'plan', 'draft', 'audit']);
    });

    test('reverts cohesion that deletes a heading', async () => {
        const stub = makeStub({ cohesion: (/** @type {{document: string}} */ { document }) => document.replace('# Title\n\n', '') });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.state.cohesion.applied, false);
        assert.ok(result.state.cohesion.reason.includes('preserved node'));
        assert.ok(result.state.document.includes('# Title'));
    });

    test('overrules a weakened verdict on a block the rewrite never changed', async () => {
        const stub = makeStub({ auditStatus: 'weakened' });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass');
        assert.ok(result.state.notes.some((/** @type {any} */ note) => note.includes('auditor overruled')));
    });

    test('fails closed when a one-word audit evidence grounds nothing', async () => {
        const stub = makeStub({ evidence: 'Agreement' });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.exitCode, 2);
        assert.ok(result.report.includes('evidence not found in the output'));
    });

    test('fails closed when the rule graph is empty', async () => {
        const stub = makeStub({ rulesMode: 'none' });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.exitCode, 2);
        assert.ok(result.report.includes('audit would be vacuous'));
    });

    test('static never reviews even when reviewAt names a checkpoint', async () => {
        let reviews = 0;
        const engine = await makeEngine({
            stub: makeStub(),
            reviewAt: ['structure'],
            onReview: () => { reviews += 1; return { action: 'accept' }; },
        });
        await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(reviews, 0);
    });

    test('normalizes a BOM and CRLF before indexing', async () => {
        const engine = await makeEngine({ stub: makeStub() });
        const result = await engine.run({ text: '\uFEFF# Title\r\n\r\nA clause with 30 days.\r\n', sourcePath: 'crlf.txt' });
        assert.ok(!result.state.document.includes('\r'));
        assert.ok(!result.state.document.includes('\uFEFF'));
        assert.ok(result.state.document.includes('# Title'));
    });

    test('fast mode skips salience and cohesion and still assembles the document', async () => {
        const stub = makeStub();
        const engine = await makeEngine({ stub, fast: true });
        const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass');
        assert.ok(!engine.executionLog.includes('salience'));
        assert.ok(engine.executionLog.includes('architecture'));
        assert.ok(engine.executionLog.includes('judge'));
        assert.equal(result.state.cohesion.applied, false);
        assert.ok(result.state.ledger.some((/** @type {any} */ entry) => entry.stage === 'salience' && entry.status === 'skipped'));
        assert.ok(result.state.document.includes('three (3) years'));
    });

    test('grounds evidence when the source duplicates an address as a mailto link', async () => {
        const text = '1.1 Customer must report concerns to compliance@example.com(mailto:compliance@example.com) without delay.';
        const engine = await makeEngine({ stub: makeStub({ evidence: 'Customer must report concerns to compliance@example.com' }) });
        const result = await engine.run({ text, sourcePath: 'mailto.txt' });
        assert.equal(result.status, 'pass');
        assert.equal(result.state.audit.rules[0].grounded, true);
    });

    test('grounds evidence when a URL is duplicated with a trailing slash', async () => {
        const text = '1.1 The Data Processing Addendum at https://example.com/legal/dpa(https://example.com/legal/dpa/) applies.';
        const engine = await makeEngine({ stub: makeStub({ evidence: 'The Data Processing Addendum at https://example.com/legal/dpa/ applies.' }) });
        const result = await engine.run({ text, sourcePath: 'url.txt' });
        assert.equal(result.status, 'pass');
        assert.equal(result.state.audit.rules[0].grounded, true);
    });

    test('writes text, report and JSON artifacts', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'defluff-test-'));
        try {
            const engine = await makeEngine({ stub: makeStub(), outDir: dir, emit: ['text', 'report', 'json'] });
            const result = await engine.run({ text: source, sourcePath: 'sample.txt' });
            const files = (await readdir(dir)).sort();
            assert.deepEqual(files, ['sample.defluff.json', 'sample.defluffed.txt', 'sample.report.md']);
            assert.equal(result.artifacts.length, 3);
            const report = await readFile(join(dir, 'sample.report.md'), 'utf8');
            assert.match(report, /\*\*Verdict:\*\* PASS/);
            assert.ok(report.includes('| Block | Role | Salience |'));
            const payload = JSON.parse(await readFile(join(dir, 'sample.defluff.json'), 'utf8'));
            assert.equal(payload.version, 3);
            assert.ok(Array.isArray(payload.blocks));
            assert.ok(payload.ast.nodes.length > 0);
            assert.ok(payload.plan && Array.isArray(payload.targetBlocks));
            assert.ok(payload.judge && Array.isArray(payload.judge.blocks));
            assert.ok(Array.isArray(payload.fixes));
            assert.equal(payload.fixRounds, 3);
            assert.ok(!('violations' in payload));
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('architecture review', () => {
    const blocks = [
        { id: 'b1', text: 'The Customer shall pay 100 EUR within 30 days.', headingPath: ['6. FEES'], role: 'obligation' },
        { id: 'b2', text: 'The Customer shall pay 100 EUR within 30 days.', headingPath: ['6. FEES'], role: 'obligation' },
        { id: 'b3', text: 'The Supplier may audit the records once a year.', headingPath: ['7. AUDIT'], role: 'permission' },
    ];
    const rules = [
        { id: 'r1', blockId: 'b1', actor: 'Customer', modality: 'obligation', object: 'pay 100 EUR within 30 days' },
        { id: 'r2', blockId: 'b2', actor: 'Customer', modality: 'obligation', object: 'pay 100 EUR within 30 days' },
    ];
    const source = blocks.map((block) => block.text).join('\n\n');
    const index = indexDocument({ text: source });

    test('finds duplicate blocks and shared rule signatures, but not nested scope', () => {
        const candidates = findStructuralCandidates({ blocks, ast: { definedTerms: [], crossRefs: [] }, rules, edges: [], index });
        assert.ok(candidates.duplicates.some((/** @type {Record<string, any>} */ pair) => pair.a === 'b1' && pair.b === 'b2'));
        assert.ok(candidates.ruleOverlaps.some((/** @type {Record<string, any>} */ group) => group.blocks.includes('b1') && group.blocks.includes('b2')));
        const nested = [
            { id: 'b4', text: 'The Customer shall pay 100 EUR within 30 days.', headingPath: ['6. FEES'] },
            { id: 'b5', text: 'The Customer shall pay 100 EUR within 30 days.', headingPath: ['6. FEES', '6.1 Late payment'] },
        ];
        const nestedCandidates = findStructuralCandidates({ blocks: nested, rules: [], index });
        assert.equal(nestedCandidates.duplicates.length, 0);
    });

    test('drops unknown ids, grounds quotes and labels an ungrounded finding a hypothesis', () => {
        const validated = validateArchitecture({
            raw: {
                findings: [
                    { id: 's1', kind: 'merge', blocks: ['b1', 'b2'], why: 'same rule', evidence: ['The Customer shall pay 100 EUR within 30 days.'], confidence: 'high' },
                    { id: 's2', kind: 'drop', blocks: ['b999'], why: 'unknown', evidence: [], confidence: 'low' },
                    { id: 's3', kind: 'move', blocks: ['b3'], why: 'belongs with audit', evidence: ['not a quote from the text'], confidence: 'medium' },
                ],
            },
            blocks,
            rules,
            source,
        });
        assert.equal(validated.findings.length, 2);
        assert.deepEqual(validated.dropped, ['s2']);
        assert.equal(validated.findings.find((finding) => finding.id === 's1')?.grounded, true);
        assert.ok((validated.findings.find((finding) => finding.id === 's1')?.saving ?? 0) > 0);
        assert.equal(validated.findings.find((finding) => finding.id === 's3')?.hypothesis, true);
        assert.ok(renderArchitecture({ architecture: validated }).includes('Advisory input'));
    });

    test('an editorial issue marker is not evidence', () => {
        const validated = validateArchitecture({
            raw: { findings: [{ id: 's4', kind: 'move', blocks: ['b3'], why: 'marker only', evidence: ['⚠ [ISSUE: one sentence]'] }] },
            blocks,
            rules,
            source,
        });
        assert.equal(validated.findings[0]?.hypothesis, true);
    });
});

describe('style scan', () => {
    test('separates safe filler from legal-risk filler and counts passive sentences', () => {
        const text = 'In the event that the Buyer fails, for the avoidance of doubt, prior to the date. The report is prepared by the Seller and the review is performed by the auditor.';
        const hits = scanFiller({ text });
        assert.ok(hits.some((hit) => hit.phrase.toLowerCase() === 'in the event that' && hit.risk === 'safe'));
        assert.ok(hits.some((hit) => hit.phrase.toLowerCase() === 'prior to' && hit.risk === 'safe'));
        assert.ok(hits.some((hit) => hit.phrase.toLowerCase() === 'for the avoidance of doubt' && hit.risk === 'check'));
        const metrics = scanStyle({ text });
        assert.equal(metrics.sentences, 2);
        assert.ok(metrics.passive >= 2);
        assert.ok(metrics.words > 10);
        assert.ok(fillerHint({ text }).includes('Safe to remove'));
    });

    test('keeps a legal-risk filler phrase on the check list', () => {
        const hint = fillerHint({ text: 'The Agreement can be updated from time to time to reflect changes.' });
        assert.match(hint, /Check before removing/i);
        assert.match(hint, /from time to time/i);
    });
});

describe('architecture and style in the engine', () => {
    test('adds a grounded advisory finding and leaves the document alone', async () => {
        const stub = makeStub();
        const original = stub.json;
        stub.json = async (/** @type {any} */ args) => {
            if (args.label === 'architecture') {
                const ids = blockIds({ prompt: args.prompt });
                return {
                    findings: [{
                        id: 's1',
                        kind: 'merge',
                        blocks: ids.slice(0, 2),
                        why: 'the same topic',
                        evidence: ['A short paragraph with 4,500 EUR'],
                        confidence: 'high',
                        risk: 'none',
                    }],
                };
            }
            return original(args);
        };
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: SAMPLE, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass');
        assert.equal(result.state.architecture.findings.length, 1);
        assert.equal(result.state.architecture.findings[0].grounded, true);
        assert.ok(result.report.includes('## Structural review'));
        assert.ok(result.report.includes('Advisory input'));
        assert.ok(result.state.document.includes('4,500 EUR'));
        assert.ok(engine.executionLog.includes('architecture'));
    });

    test('re-quotes a present rule instead of failing on stale evidence', async () => {
        const stub = makeStub({
            evidence: 'stale evidence text',
            requote: (/** @type {{prompt: string}} */ { prompt }) => {
                const block = prompt.split('## Rules to quote\n')[1].split('\n\nReturn one short')[0];
                const rules = JSON.parse(block);
                return { quotes: rules.map((/** @type {{id: string}} */ rule) => ({ id: rule.id, quote: 'three (3) years' })) };
            },
        });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: SAMPLE, sourcePath: 'sample.txt' });
        assert.equal(result.status, 'pass');
        assert.ok(result.state.audit.rules.every((/** @type {any} */ rule) => rule.grounded));
        assert.ok(result.state.ledger.some((/** @type {any} */ entry) => String(entry.detail).includes('re-quoted')));
    });

    test('drops a finding that names an unknown block and records why', async () => {
        const stub = makeStub({
            architecture: {
                findings: [{ id: 's9', kind: 'drop', blocks: ['b999'], why: 'unknown', evidence: ['A short paragraph with 4,500 EUR'] }],
            },
        });
        const engine = await makeEngine({ stub });
        const result = await engine.run({ text: SAMPLE, sourcePath: 'sample.txt' });
        assert.equal(result.state.architecture.findings.length, 0);
        assert.deepEqual(result.state.architecture.dropped, ['s9']);
        assert.ok(result.state.notes.some((/** @type {string} */ note) => note.includes('unknown block ids')));
    });

    test('the ste profile reaches the rewrite system slot and the report', async () => {
        const stub = makeStub();
        const engine = await makeEngine({ stub, style: 'ste' });
        const result = await engine.run({ text: SAMPLE, sourcePath: 'sample.txt' });
        const rewrite = stub.calls.find((call) => String(call.label).startsWith('rewrite:'));
        assert.ok(rewrite?.system.includes('STE-informed'));
        assert.match(result.report, /## Style/);
        assert.equal(result.state.style.profile, 'ste');
        assert.ok(result.state.style.before.words > 0);
        assert.ok(result.state.style.after.words > 0);
    });
});

describe('prompts and CLI', () => {
    test('the mandated audience block is verbatim in base.md and in every composed system slot', async () => {
        const prompts = await loadPrompts({ dir: APP_DIR });
        assert.ok(prompts.base.includes(MANDATED));
        for (const name of PROMPT_FILES) {
            const system = buildSystem({ base: prompts.base, directive: prompts[name] });
            assert.ok(system.includes(MANDATED), `${name} lost the mandated block`);
        }
    });

    test('the judge and audit prompts treat prior to -> before as equivalent', async () => {
        const prompts = await loadPrompts({ dir: APP_DIR });
        assert.match(prompts.judge, /prior to.*before/is);
        assert.match(prompts.audit, /prior to.*before/is);
        assert.match(prompts.appeal, /prior to.*before/is);
        assert.match(prompts['cohesion-judge'], /heading.*signature/is);
    });

    test('parses flags and rejects a playbook without the guided tier', () => {
        const parsed = parseArgs({ argv: ['in.txt', '--tier', 'guided', '--emit', 'text,json', '--block-max-chars', '900'] });
        assert.equal(parsed.input, 'in.txt');
        assert.deepEqual(parsed.emit, ['text', 'json']);
        assert.equal(parsed.blockMaxChars, 900);
        assert.throws(() => parseArgs({ argv: ['in.txt', '--playbook', 'p.json'] }), /guided/);
        assert.equal(parseArgs({ argv: ['in.txt', '--style', 'ste'] }).style, 'ste');
        assert.equal(parseArgs({ argv: ['in.txt', '--strategy', 'aggressive'] }).strategy, 'aggressive');
        assert.equal(parseArgs({ argv: ['in.txt', '--fix-rounds', '5'] }).fixRounds, 5);
        assert.equal(parseArgs({ argv: ['in.txt', '--lite'] }).lite, true);
        assert.throws(() => parseArgs({ argv: ['in.txt', '--fix-rounds', '-1'] }), /--fix-rounds/);
        assert.throws(() => parseArgs({ argv: ['in.txt', '--lite', '--out', 'x'] }), /one pass/);
        assert.throws(() => parseArgs({ argv: ['in.txt', '--strategy', 'wild'] }), /Unknown strategy/);
        assert.throws(() => parseArgs({ argv: ['in.txt', '--style', 'wild'] }), /Unknown style/);
        assert.throws(() => parseArgs({ argv: ['in.txt', '--tier', 'wild'] }), /Unknown tier/);
        assert.throws(() => parseArgs({ argv: ['in.txt', '--nope'] }), /Unknown flag/);
    });

    test('rejects an empty emit list and lets --help win over unrelated flags', () => {
        assert.throws(() => parseArgs({ argv: ['in.txt', '--emit', ''] }), /at least one/);
        assert.equal(parseArgs({ argv: ['--help', '--playbook', 'p.json'] }).help, true);
    });

    test('lite makes one call, keeps the mandated contract and returns the transformed text', async () => {
        /** @type {Array<Record<string, any>>} */
        const calls = [];
        const llm = {
            /** @param {{system: string, prompt: string, label?: string}} arg0 */
            async text({ system, prompt, label = '' }) {
                calls.push({ system, prompt, label });
                return '  Short text.  ';
            },
        };
        const output = await runLite({ text: 'Long text that should be transformed.', llm });
        assert.equal(output, 'Short text.');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].label, 'lite');
        assert.ok(calls[0].system.includes(MANDATED));
        assert.match(calls[0].system, /ASD-STE100/);
        assert.match(calls[0].system, /active voice/);
        assert.match(calls[0].system, /merge, rename or remove a definition/);
        assert.match(calls[0].system, /consistently across the whole document/);
        assert.match(calls[0].system, /must not be narrower than its uses/);
        assert.match(calls[0].system, /removes the only use of a definition/);
        assert.match(calls[0].system, /list its uses in the new document/);
        assert.match(calls[0].prompt, /Long text that should be transformed\./);
        assert.ok(calls[0].prompt.includes('Return the transformed document only.'));
        assert.equal(litePrompt({ text: 'X' }), '## Document\n\nX\n\nReturn the transformed document only.');
        assert.ok(LITE_SYSTEM.startsWith(MANDATED));
    });

    test('lite rejects an empty document without asking the model', async () => {
        let called = false;
        const llm = { text: async () => { called = true; return 'x'; } };
        await assert.rejects(() => runLite({ text: '   ', llm }), /empty/i);
        assert.equal(called, false);
    });

    test('--lite prints only the transformed text and writes no artifacts', async () => {
        /** @type {Array<string>} */
        const printed = [];
        const io = { print: (/** @type {{text: string}} */ { text }) => printed.push(text), ask: async () => 'a', close: () => {} };
        let jsonCalls = 0;
        let textCalls = 0;
        const llm = {
            async json() { jsonCalls += 1; return {}; },
            async text() { textCalls += 1; return 'Lite output.'; },
        };
        const result = await runCli({
            argv: [join(APP_DIR, 'fixtures', 'sample-contract.txt'), '--lite'],
            io,
            llm,
        });
        assert.equal(result.status, 'pass');
        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.artifacts, []);
        assert.deepEqual(printed, ['Lite output.']);
        assert.equal(textCalls, 1);
        assert.equal(jsonCalls, 0);
    });

    test('runCli reads the fixture, writes artifacts and reports the verdict', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'defluff-cli-'));
        /** @type {Array<string>} */
        const printed = [];
        const io = {
            print: (/** @type {{text: string}} */ { text }) => printed.push(text),
            ask: async () => 'a',
            close: () => {},
        };
        try {
            const result = await runCli({
                argv: [join(APP_DIR, 'fixtures', 'sample-contract.txt'), '-o', dir, '--emit', 'text,report,json', '--quiet'],
                io,
                llm: makeStub(),
            });
            assert.equal(result.status, 'pass');
            assert.equal(result.exitCode, 0);
            const files = (await readdir(dir)).sort();
            assert.deepEqual(files, ['sample-contract.defluff.json', 'sample-contract.defluffed.txt', 'sample-contract.report.md']);
            assert.ok(printed.join('\n').includes('PASS'));
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('runCli exits 2 when the audit fails', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'defluff-cli-fail-'));
        const io = { print: () => {}, ask: async () => 'a', close: () => {} };
        try {
            const result = await runCli({
                argv: [join(APP_DIR, 'fixtures', 'sample-contract.txt'), '-o', dir, '--quiet'],
                io,
                llm: makeStub({ auditStatus: 'dropped' }),
            });
            assert.equal(result.status, 'fail');
            assert.equal(result.exitCode, 2);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
