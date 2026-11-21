// @ts-check
/**
 * @file Structure induction — measure the corpus, propose the shape.
 * @version 0.26.0
 *
 * @description
 * "Which kinds and relations does *this* data support?" answered by counting,
 * not by asking a model. The profiler is deterministic: the same corpus yields
 * the same profile on every run, which is what keeps two graphs comparable.
 *
 * The output is a *proposal*, not a schema. It carries the evidence that
 * justified each kind (`support` + `why`), and it becomes the vocabulary only
 * through the explicit adoption gate in `store.mjs` — schema is bedrock,
 * instances are a river.
 *
 * The one optional model call lives in the component, and it can only choose
 * among the candidates produced here.
 */

import { LIMITS } from '../../core/limit-config.mjs';
import { extractDefinitions, extractRefs, headingList, modalityOf, normalizeText, paragraphList, sentenceList } from './build.mjs';
import { CORE_RELATIONS, KNOWLEDGE_SCHEMA } from './model.mjs';

/** Structural relations every derived profile keeps: nothing can be read without them. */
const ALWAYS_RELATIONS = Object.freeze(['contains', 'part_of', 'derived_from', 'references']);

/**
 * Kinds the agent writes and no parse can infer. A shape without them can be
 * read but never enriched, so every proposal carries them.
 */
export const AGENT_KINDS = Object.freeze(['issue', 'concept', 'evidence', 'note', 'boundary']);

/**
 * What the corpus actually contains, as counts.
 * @typedef {Object} DataProfile
 * @property {string} schema
 * @property {number} sources
 * @property {number} chars
 * @property {number} headings
 * @property {number} headingDepth
 * @property {number} paragraphs
 * @property {number} sentences
 * @property {number} definitions
 * @property {number} references
 * @property {number} questions
 * @property {number} codeBlocks
 * @property {number} tables
 * @property {number} bullets
 * @property {number} dates
 * @property {number} speakers
 * @property {Record<string, number>} modality
 */

/**
 * Measures one or more documents. No model, no I/O beyond the text it is given.
 * @param {{sources?: Array<{id: string, name: string, text: string}>}} [arg0] -
 * @returns {DataProfile}
 */
export function profileSources({ sources = [] } = {}) {
    const profile = {
        schema: `${KNOWLEDGE_SCHEMA}/profile`,
        sources: sources.length,
        chars: 0,
        headings: 0,
        headingDepth: 0,
        paragraphs: 0,
        sentences: 0,
        definitions: 0,
        references: 0,
        questions: 0,
        codeBlocks: 0,
        tables: 0,
        bullets: 0,
        dates: 0,
        speakers: 0,
        modality: /** @type {Record<string, number>} */ ({})
    };

    for (const source of sources) {
        const text = normalizeText({ text: source.text });
        profile.chars += text.length;
        const headings = headingList({ text });
        profile.headings += headings.length;
        profile.headingDepth = Math.max(profile.headingDepth, ...headings.map((heading) => heading.level), 0);
        const paragraphs = paragraphList({ text, headings });
        profile.paragraphs += paragraphs.length;
        for (const paragraph of paragraphs) {
            for (const sentence of sentenceList({ text: paragraph.text })) {
                profile.sentences++;
                const modality = modalityOf({ text: sentence.text });
                if (modality) profile.modality[modality] = (profile.modality[modality] ?? 0) + 1;
                if (/\b(?:if|unless|provided\s+that|subject\s+to|only\s+if|jestliže|pokud|ledaže)\b/i.test(sentence.text)) {
                    profile.modality.condition = (profile.modality.condition ?? 0) + 1;
                }
            }
            if (paragraph.text.trimEnd().endsWith('?')) profile.questions++;
            if (/^\s*(?:[-*]|\d+\.)\s+/m.test(paragraph.text)) profile.bullets++;
        }
        profile.definitions += extractDefinitions({ text }).length;
        for (const paragraph of paragraphs) profile.references += extractRefs({ text: paragraph.text }).length;
        profile.codeBlocks += (text.match(/```/g) ?? []).length / 2;
        profile.tables += (text.match(/^\s*\|.*\|\s*$/gm) ?? []).length > 0 ? 1 : 0;
        profile.dates += (text.match(/\b\d{1,2}\.\s?\d{1,2}\.\s?\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g) ?? []).length;
        profile.speakers += (text.match(/^\s{0,3}[A-Z][\p{L} ]{1,40}:\s/mgu) ?? []).length;
    }

    profile.codeBlocks = Math.floor(profile.codeBlocks);
    return profile;
}

/**
 * One derived kind, with the count that justified it.
 * @typedef {Object} KindProposal
 * @property {string} kind
 * @property {number} support
 * @property {string} why
 */

/**
 * One derived relation, with the count that justified it.
 * @typedef {Object} RelationProposal
 * @property {string} rel
 * @property {number} support
 * @property {string} why
 */

/**
 * A measured shape, before anyone adopts it.
 * @typedef {Object} OntologyProposal
 * @property {string} schema
 * @property {'proposed'} status
 * @property {string} name
 * @property {string} createdAt
 * @property {DataProfile} [measured]
 * @property {{name: string, kinds: Array<string>, relations: Array<string>}} profile
 * @property {Array<KindProposal>} kinds
 * @property {Array<RelationProposal>} relations
 * @property {Array<string>} shapes
 * @property {string} sha
 */

/**
 * Turns a measurement into a candidate vocabulary.
 *
 * Every rule is "if the corpus has enough of X, a graph of it needs kind K".
 * `minSupport` keeps a single stray heading from inventing a shape.
 * @param {{profile?: DataProfile, minSupport?: number, name?: string}} arg0 -
 * @returns {OntologyProposal}
 */
export function proposeOntology({ profile, minSupport = LIMITS.knowledge_propose_min_support, name = 'derived' } = /** @type {{profile?: DataProfile, minSupport?: number, name?: string}} */ ({})) {
    if (!profile) throw new Error('proposeOntology needs a profile.');
    /** @type {Array<KindProposal>} */
    const kinds = [];
    const add = (/** @type {{kind: string, support: number, why: string}} */ { kind, support, why }) => {
        if (support < minSupport) return;
        if (kinds.some((entry) => entry.kind === kind)) return;
        kinds.push({ kind, support, why });
    };

    // A graph always has its document root; that kind is not a measurement.
    add({ kind: 'document', support: Math.max(minSupport, profile.sources), why: `${profile.sources} source(s)` });
    add({ kind: 'section', support: profile.headings, why: `${profile.headings} heading(s)` });
    add({ kind: 'subsection', support: profile.headingDepth > 2 ? profile.headings : 0, why: `heading depth ${profile.headingDepth}` });
    add({ kind: 'paragraph', support: profile.paragraphs, why: `${profile.paragraphs} paragraph(s)` });
    add({ kind: 'definition', support: profile.definitions, why: `${profile.definitions} definition(s)` });
    add({ kind: 'obligation', support: profile.modality.obligation ?? 0, why: `${profile.modality.obligation ?? 0} obligation sentence(s)` });
    add({ kind: 'permission', support: profile.modality.permission ?? 0, why: `${profile.modality.permission ?? 0} permission sentence(s)` });
    add({ kind: 'prohibition', support: profile.modality.prohibition ?? 0, why: `${profile.modality.prohibition ?? 0} prohibition sentence(s)` });
    add({ kind: 'condition', support: profile.modality.condition ?? 0, why: `${profile.modality.condition ?? 0} conditional clause(s)` });
    add({ kind: 'question', support: profile.questions, why: `${profile.questions} question paragraph(s)` });
    add({ kind: 'answer', support: profile.questions > 0 ? profile.paragraphs : 0, why: 'paragraphs following a question' });
    add({ kind: 'code', support: profile.codeBlocks, why: `${profile.codeBlocks} fenced block(s)` });
    add({ kind: 'table', support: profile.tables, why: `${profile.tables} table(s)` });
    add({ kind: 'event', support: profile.dates, why: `${profile.dates} dated expression(s)` });
    add({ kind: 'episode', support: profile.speakers, why: `${profile.speakers} speaker turn(s)` });
    add({ kind: 'statement', support: profile.sentences, why: `${profile.sentences} sentence(s)` });
    // Agent-authored kinds: the data cannot justify them, and without them the
    // graph could be read but never enriched.
    for (const kind of AGENT_KINDS) add({ kind, support: Math.max(minSupport, 1), why: 'agent-authored kind' });

    /** @type {Array<RelationProposal>} */
    const relations = [];
    const rel = (/** @type {{rel: string, support: number, why: string}} */ { rel: value, support, why }) => {
        if (support < minSupport) return;
        if (relations.some((entry) => entry.rel === value)) return;
        relations.push({ rel: value, support, why });
    };
    for (const value of ALWAYS_RELATIONS) rel({ rel: value, support: Math.max(minSupport, profile.paragraphs), why: 'structural' });
    rel({ rel: 'defines', support: profile.definitions, why: `${profile.definitions} definition(s) introduce a term` });
    rel({ rel: 'uses', support: profile.definitions, why: `${profile.definitions} term(s) are used after introduction` });
    rel({ rel: 'conditions', support: profile.modality.condition ?? 0, why: 'conditional clauses qualify a rule' });
    rel({ rel: 'excepts', support: profile.modality.condition ?? 0, why: 'conditional clauses carve out exceptions' });
    rel({ rel: 'answers', support: profile.questions, why: 'a question is resolved by an answer' });
    rel({ rel: 'same_as', support: profile.sources > 1 ? profile.sources : 0, why: `${profile.sources} source(s) can be bridged` });

    const kindNames = kinds.map((entry) => entry.kind);
    // Kinds are the data's shape and are derived. Relations are the SDK's
    // validated contract and are kept whole: a derived profile that dropped
    // `depends_on` could read the corpus but never let an agent link to it.
    const relNames = [...CORE_RELATIONS];
    const shapes = ['binary'];
    if (profile.definitions > 0 || profile.modality.condition > 0) shapes.push('negative');
    if ((profile.modality.condition ?? 0) > 0) shapes.push('conditional');
    if (profile.sources > 1) shapes.push('evidenced');

    /** @type {OntologyProposal} */
    const proposal = {
        schema: `${KNOWLEDGE_SCHEMA}/ontology-proposal`,
        status: 'proposed',
        name,
        createdAt: new Date().toISOString(),
        measured: profile,
        profile: { name, kinds: kindNames, relations: relNames },
        kinds,
        relations,
        shapes,
        sha: ''
    };
    proposal.sha = ontologySha({ proposal });
    return proposal;
}

/**
 * Identity of a proposal: the shape, not the timestamp. A caller can compare
 * before adopting, and re-running on an unchanged corpus yields the same sha.
 * @param {{proposal?: Partial<OntologyProposal>|null}} arg0 -
 * @returns {string}
 */
export function ontologySha({ proposal }) {
    const stable = JSON.stringify({
        kinds: (proposal?.kinds ?? []).map((/** @type {{kind: string, support: number}} */ entry) => [entry.kind, entry.support]),
        relations: (proposal?.relations ?? []).map((/** @type {{rel: string, support: number}} */ entry) => [entry.rel, entry.support]),
        shapes: proposal?.shapes ?? []
    });
    // Not a security hash: a stable fingerprint for compare-and-swap adoption.
    let hash = 0;
    for (let index = 0; index < stable.length; index++) {
        hash = (hash * 31 + stable.charCodeAt(index)) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
