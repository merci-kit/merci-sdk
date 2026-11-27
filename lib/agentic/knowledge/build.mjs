// @ts-check
/**
 * @file Knowledge graph construction — the mechanical pass.
 * @version 0.25.0
 *
 * @description
 * Turns source text into nodes and edges with no model call. It records, it
 * does not interpret: headings become sections, blank-line blocks become
 * paragraphs, sentences with a modality become rules, `"Term" means …` becomes
 * a definition, and `Section 4.2` / `§ 4` become reference edges.
 *
 * Source offsets are exact, and every text-bearing node's span slices back to
 * its own text — the `node-roundtrip` finding checks that, so a bad extraction
 * is visible instead of becoming a graph of garbage.
 *
 * The interpretation layer is the agent's: it adds issues, concepts and
 * semantic edges through a validated patch (see `model.mjs` `applyPatch`).
 */

import { createHash } from 'node:crypto';
import { KNOWLEDGE_SCHEMA, KNOWLEDGE_VERSION, levelKindsFor, resolveProfile, statsOf } from './model.mjs';

/**
 * Bumped whenever the mechanical pass changes what it emits for the same bytes.
 * It is part of `corpusKey`, so an extractor upgrade cannot be served from a
 * cache built by the previous one.
 */
export const KNOWLEDGE_BUILD_VERSION = 2;

/**
 * A source document handed to the builder.
 * @typedef {Object} KnowledgeSource
 * @property {string} id
 * @property {string} name
 * @property {string} text
 * @property {string|null} [path]
 */

/** Definition verbs across the languages the corpus covers. */
const DEF_VERB = /^\s*(?:means|shall mean|has the meaning|refers to|is defined as|denotes|označuje|znamená|rozumí se|se rozumí|désigne|bedeutet|significa|indica)\b/i;

/** @type {Array<[string, RegExp]>} */
const MODALITY_RULES = [
    ['prohibition', /\b(?:shall\s+not|must\s+not|may\s+not|is\s+not\s+entitled|nesmí|nesmějí)\b/i],
    ['obligation', /\b(?:shall|must|is\s+required\s+to|is\s+obliged\s+to|musí|je\s+povinen)\b/i],
    ['permission', /\b(?:may|is\s+entitled\s+to|is\s+permitted\s+to|může|je\s+oprávněn)\b/i],
];

/** A clause that limits the rule it sits in, in every language the corpus covers. */
const CONDITION_RE = /\b(?:if|unless|provided\s+that|subject\s+to|only\s+if|except\s+where|jestliže|pokud|ledaže|za\s+předpokladu)\b/i;

/** Relations the mechanical pass may emit; a profile without the kind falls back. */
/** @type {Record<string, string>} */
const KIND_FALLBACK = Object.freeze({
    obligation: 'statement',
    permission: 'statement',
    prohibition: 'statement',
    condition: 'statement',
    definition: 'definition',
    paragraph: 'paragraph',
    section: 'section'
});

/**
 * Normalises line endings and strips a BOM. Offsets are computed after this.
 * @param {{text: string}} arg0 -
 * @returns {string}
 */
export function normalizeText({ text }) {
    return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * @param {{text: string}} arg0 -
 * @returns {Array<{level: number, title: string, start: number, end: number, line: number, anchor: string}>}
 */
export function headingList({ text }) {
    /** @type {Array<{level: number, title: string, start: number, end: number, line: number, anchor: string}>} */
    const out = [];
    let offset = 0;
    let line = 0;
    for (const raw of text.split('\n')) {
        line++;
        const match = raw.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (match) {
            const numbered = match[2].match(/^(\d+(?:\.\d+)*)\.?\s/);
            out.push({
                level: match[1].length,
                title: match[2].trim(),
                start: offset,
                end: offset + raw.length,
                line,
                anchor: numbered ? numbered[1] : slug({ value: match[2] }) || `h${line}`
            });
        }
        offset += raw.length + 1;
    }
    return out;
}

/**
 * Blank-line separated blocks, each attributed to the nearest preceding heading.
 * @param {{text: string, headings: Array<{level: number, title: string, start: number, end: number, line: number, anchor: string}>}} arg0 -
 * @returns {Array<{start: number, end: number, text: string, section: {level: number, title: string, start: number, end: number, line: number, anchor: string}|null}>}
 */
export function paragraphList({ text, headings }) {
    /** @type {Array<{start: number, end: number, text: string, section: {level: number, title: string, start: number, end: number, line: number, anchor: string}|null}>} */
    const out = [];
    // A paragraph is a run of non-blank, non-heading lines. Scanning lines with
    // their real offsets is what makes this exact: the previous form split on
    // blank lines only, so a heading followed directly by its text swallowed the
    // paragraph (and every later offset drifted).
    let lineStart = 0;
    let runStart = -1;
    let runEnd = -1;

    const flush = () => {
        if (runStart === -1) return;
        const raw = text.slice(runStart, runEnd);
        const trimmed = raw.trim();
        const leading = raw.length - raw.trimStart().length;
        if (trimmed) {
            out.push({
                start: runStart + leading,
                end: runStart + leading + trimmed.length,
                text: trimmed,
                section: headingAt({ headings, offset: runStart })
            });
        }
        runStart = -1;
        runEnd = -1;
    };

    for (const line of text.split('\n')) {
        if (line.trim() === '' || /^#{1,6}\s/.test(line)) {
            flush();
        } else {
            if (runStart === -1) runStart = lineStart;
            runEnd = lineStart + line.length;
        }
        lineStart += line.length + 1;
    }
    flush();
    return out;
}

/**
 * Sentences inside a block, by terminal punctuation.
 * @param {{text: string}} arg0 -
 * @returns {Array<{start: number, end: number, text: string}>}
 */
export function sentenceList({ text }) {
    /** @type {Array<{start: number, end: number, text: string}>} */
    const out = [];
    const re = /[^.!?]+[.!?]+|[^.!?]+$/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const value = match[0];
        const start = match.index;
        const leading = value.length - value.trimStart().length;
        const body = value.trim();
        if (body) out.push({ start: start + leading, end: start + leading + body.length, text: body });
        if (match.index === re.lastIndex) re.lastIndex++;
    }
    return out;
}

/**
 * The modality a sentence states, or null when it is descriptive.
 * @param {{text: string}} arg0 -
 * @returns {'obligation'|'permission'|'prohibition'|null}
 */
export function modalityOf({ text }) {
    for (const [kind, re] of MODALITY_RULES) if (re.test(text)) return /** @type {'obligation'|'permission'|'prohibition'} */ (kind);
    return null;
}

/**
 * `"Term" means …` / `Term (the "Alias")` style definitions.
 * @param {{text: string}} arg0 -
 * @returns {Array<{term: string, definition: string, offset: number}>}
 */
export function extractDefinitions({ text }) {
    /** @type {Array<any>} */
    const out = [];
    const quoted = /(?:^|\n)\s*[“"]([^”"\n]{2,80})[”"]\s+([a-zá-ž]{3,20})\b([^.\n]{0,400})/gi;
    let match;
    while ((match = quoted.exec(text)) !== null) {
        if (!DEF_VERB.test(match[2])) continue;
        out.push({ term: match[1].trim(), definition: match[3].trim(), offset: match.index });
    }
    const bare = /(?:^|\n)\s*([A-Z][\p{L}\s-]{1,60}?)\s+([a-zá-ž]{3,20})\b\s+([^.\n]{3,400})/gu;
    while ((match = bare.exec(text)) !== null) {
        if (!DEF_VERB.test(match[2])) continue;
        const term = match[1].trim();
        if (out.some((item) => item.term.toLowerCase() === term.toLowerCase())) continue;
        out.push({ term, definition: match[3].trim(), offset: match.index });
    }
    return out;
}

/**
 * Cross-references an agent can anchor: `Section 4.2`, `Clause 7`, `§ 4`, `Annex I`.
 * @param {{text: string}} arg0 -
 * @returns {Array<{text: string, anchor: string}>}
 */
export function extractRefs({ text }) {
    /** @type {Array<{text: string, anchor: string}>} */
    const out = [];
    const re = /\b(?:Section|Clause|Article|Annex|Schedule|odstavec|článek|§)\s*(\d+(?:\.\d+)*)/gi;
    let match;
    while ((match = re.exec(text)) !== null) out.push({ text: match[0].trim(), anchor: match[1] });
    return out;
}

/**
 * Builds a graph from one or more documents.
 * @param {{sources?: Array<KnowledgeSource>, profile?: string|object|null, title?: string, now?: Date, hierarchy?: {levels?: string[], levelKinds?: Record<number, string>}|null}} arg0 -
 * @returns {import('./model.mjs').KnowledgeGraph} the graph
 */
export function buildGraph({ sources = [], profile = null, title = '', now = new Date(), hierarchy = null } = {}) {
    const resolved = resolveProfile({ profile });
    const fallbackFor = /** @type {Record<string, string>} */ (KIND_FALLBACK);
    const kindFor = (/** @type {string} */ kind) => (resolved.kinds.includes(kind) ? kind : (fallbackFor[kind] && resolved.kinds.includes(fallbackFor[kind]) ? fallbackFor[kind] : resolved.kinds[0]));
    /** @type {import('./model.mjs').KnowledgeNode[]} */
    const nodes = [];
    /** @type {import('./model.mjs').KnowledgeEdge[]} */
    const edges = [];
    const seen = new Set();
    const unique = (/** @type {string} */ base) => {
        let id = base;
        let n = 2;
        while (seen.has(id)) id = `${base}-${n++}`;
        seen.add(id);
        return id;
    };
    const edge = (/** @type {Partial<import('./model.mjs').KnowledgeEdge>} */ value) => {
        edges.push(/** @type {import('./model.mjs').KnowledgeEdge} */ ({ id: `E${edges.length + 1}`, confidence: 'high', origin: 'mechanical', ...value }));
    };

    for (const source of sources) {
        const text = normalizeText({ text: source.text });
        const headings = headingList({ text });
        const paragraphs = paragraphList({ text, headings });
        const definitions = extractDefinitions({ text });
        /** @type {Map<number, string>} */
        const sectionIds = new Map();
        /** @type {Map<number, Array<string>>} */
        const sectionPaths = new Map();
        /** @type {Array<{level: number, title: string}>} */
        const ancestors = [];
        const documentId = unique(`${source.id}-doc`);

        nodes.push({
            id: documentId,
            kind: kindFor('document'),
            label: headings[0]?.title ?? source.name,
            text: '',
            salience: 'core',
            confidence: 'high',
            source: { sourceId: source.id, start: 0, end: Math.min(1, text.length), line: 1, anchor: 'document' },
            terms: [],
            tags: [],
            headingPath: [],
            surface: 'document'
        });

        let lastSectionId = documentId;
        for (const heading of headings) {
            const id = unique(`${source.id}-s-${heading.anchor}`);
            sectionIds.set(heading.start, id);
            while (ancestors.length > 0 && ancestors[ancestors.length - 1].level >= heading.level) ancestors.pop();
            ancestors.push({ level: heading.level, title: heading.title });
            const headingPath = ancestors.map((ancestor) => ancestor.title);
            sectionPaths.set(heading.start, headingPath);
            nodes.push({
                id,
                kind: levelKindsFor({ profile: resolved, hierarchy, level: heading.level }),
                label: heading.title,
                text: '',
                salience: salienceOf({ title: heading.title }),
                confidence: 'high',
                source: { sourceId: source.id, start: heading.start, end: heading.end, line: heading.line, anchor: heading.anchor },
                terms: [],
                tags: [slug({ value: heading.title })].filter(Boolean),
                headingPath,
                surface: 'document'
            });
            edge({ from: parentSection({ headings, heading, sectionIds }) ?? documentId, to: id, rel: 'contains', note: 'heading nesting' });
            lastSectionId = id;
        }

        for (const paragraph of paragraphs) {
            const sectionId = paragraph.section ? sectionIds.get(paragraph.section.start) ?? lastSectionId : documentId;
            const headingPath = (paragraph.section ? sectionPaths.get(paragraph.section.start) : null) ?? [];
            const id = unique(`${source.id}-p-${lineOf({ text, offset: paragraph.start })}`);
            nodes.push({
                id,
                kind: kindFor('paragraph'),
                label: firstLine({ text: paragraph.text }),
                text: paragraph.text,
                salience: 'scope',
                confidence: 'high',
                source: { sourceId: source.id, start: paragraph.start, end: paragraph.end, line: lineOf({ text, offset: paragraph.start }), anchor: paragraph.section?.anchor ?? 'document' },
                terms: [],
                tags: [],
                headingPath,
                surface: 'document'
            });
            edge({ from: sectionId, to: id, rel: 'contains', note: 'paragraph in section' });

            let ruleIndex = 0;
            for (const sentence of sentenceList({ text: paragraph.text })) {
                const modality = modalityOf({ text: sentence.text });
                if (!modality) continue;
                ruleIndex++;
                const ruleId = unique(`${id}-r${ruleIndex}`);
                nodes.push({
                    id: ruleId,
                    kind: kindFor(modality),
                    label: firstLine({ text: sentence.text }).slice(0, 90),
                    text: sentence.text,
                    salience: 'core',
                    confidence: 'high',
                    source: {
                        sourceId: source.id,
                        start: paragraph.start + sentence.start,
                        end: paragraph.start + sentence.end,
                        line: lineOf({ text, offset: paragraph.start + sentence.start }),
                        anchor: paragraph.section?.anchor ?? 'document'
                    },
                    terms: [],
                    tags: [],
                    headingPath,
                    surface: 'document'
                });
                edge({ from: id, to: ruleId, rel: 'contains', note: `${modality} sentence` });

                // A conditional clause limits the rule it sits in, so it becomes a
                // node the rule points at — the design's "IF/UNLESS → condition".
                if (CONDITION_RE.test(sentence.text)) {
                    const conditionId = unique(`${ruleId}-c`);
                    nodes.push({
                        id: conditionId,
                        kind: kindFor('condition'),
                        label: firstLine({ text: sentence.text }).slice(0, 90),
                        text: sentence.text,
                        salience: 'scope',
                        confidence: 'high',
                        source: {
                            sourceId: source.id,
                            start: paragraph.start + sentence.start,
                            end: paragraph.start + sentence.end,
                            line: lineOf({ text, offset: paragraph.start + sentence.start }),
                            anchor: paragraph.section?.anchor ?? 'document'
                        },
                        terms: [],
                        tags: ['condition'],
                        surface: 'document'
                    });
                    edge({ from: ruleId, to: conditionId, rel: 'conditions', note: 'conditional clause qualifies the rule' });
                }
            }

            for (const ref of extractRefs({ text: paragraph.text })) {
                const target = sectionByAnchor({ headings, sectionIds, anchor: ref.anchor });
                edge({
                    from: id,
                    to: target ?? documentId,
                    rel: 'references',
                    note: `reference ${ref.text}`,
                    confidence: target ? 'high' : 'low',
                    ...(target ? {} : { unresolved: true, targetAnchor: ref.anchor })
                });
            }
        }

        for (const definition of definitions) {
            const owner = headingAt({ headings, offset: definition.offset });
            const ownerId = owner ? sectionIds.get(owner.start) ?? documentId : documentId;
            const headingPath = (owner ? sectionPaths.get(owner.start) : null) ?? [];
            const id = unique(`${source.id}-d-${slug({ value: definition.term })}`);
            const start = definition.offset + (text.slice(definition.offset).match(/^\s*/) ?? [''])[0].length;
            const raw = text.slice(start, start + definition.term.length + definition.definition.length + 24);
            nodes.push({
                id,
                kind: kindFor('definition'),
                label: definition.term,
                text: raw.trim(),
                salience: 'scope',
                confidence: 'high',
                source: { sourceId: source.id, start, end: start + raw.trim().length, line: lineOf({ text, offset: start }), anchor: owner?.anchor ?? 'document' },
                terms: [keyOf({ value: definition.term })],
                tags: ['definition'],
                headingPath,
                surface: 'document'
            });
            edge({ from: ownerId, to: id, rel: 'defines', note: `definition of ${definition.term}` });
        }
    }

    // Every node gets a content key before the graph is returned, so a later
    // delta rebuild can match an old node to a new one.
    for (const node of nodes) node.key = nodeKey({ node });

    return {
        schema: KNOWLEDGE_SCHEMA,
        version: KNOWLEDGE_VERSION,
        tool: 'knowledge',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        title: title || (sources[0] ? sources[0].name : 'knowledge'),
        profile: resolved.name,
        // The shape travels with the graph, so it can re-validate itself later.
        profileDefinition: {
            name: resolved.name,
            kinds: [...resolved.kinds],
            relations: [...resolved.relations],
            ...(resolved.levels ? { levels: [...resolved.levels] } : {})
        },
        ...(hierarchy ? { hierarchy: { ...(hierarchy.levels ? { levels: [...hierarchy.levels] } : {}), ...(hierarchy.levelKinds ? { levelKinds: { ...hierarchy.levelKinds } } : {}) } } : {}),
        sources: sources.map((source) => ({
            id: source.id,
            path: source.path ?? null,
            name: source.name,
            chars: normalizeText({ text: source.text }).length,
            sha256: sourceSha({ text: source.text })
        })),
        nodes,
        edges,
        stats: statsOf({ nodes, edges })
    };
}

/**
 * Stable identity of a node's content, independent of where it sits.
 *
 * Line-based ids shift when anything above them is edited, which would break
 * every agent-authored node that points at them. A content key does not: an
 * unchanged paragraph keeps its key when the file around it changes, so a delta
 * rebuild can re-anchor derived work instead of discarding it.
 * @param {{node: {kind?: string, text?: string, label?: string}}} arg0 -
 * @returns {string}
 */
export function nodeKey({ node }) {
    const body = String(node?.text ?? '').trim() || String(node?.label ?? '').trim();
    const normalized = body.replace(/\s+/g, ' ');
    const digest = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
    return `${node?.kind ?? 'node'}:${digest}`;
}

/**
 * Content hash of a whole source, for the corpus manifest.
 * @param {{text: string}} arg0 -
 * @returns {string}
 */
export function sourceSha({ text }) {
    return createHash('sha256').update(normalizeText({ text }), 'utf8').digest('hex');
}

/**
 * Lowercase, accent-folded, hyphenated key.
 * @param {{value: string}} arg0 -
 * @returns {string}
 */
export function slug({ value }) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

/**
 * Normalised term key: `The Confidential Information` → `confidential information`.
 * @param {{value: string}} arg0 -
 * @returns {string}
 */
export function keyOf({ value }) {
    return String(value ?? '').toLowerCase().replace(/^the\s+/, '').replace(/[’']/g, "'").replace(/[\s\-–—]+/g, ' ').trim();
}

/** @param {{text: string, offset: number}} arg0 - */
function lineOf({ text, offset }) {
    return text.slice(0, offset).split('\n').length;
}

/** @param {{text: string}} arg0 - */
function firstLine({ text }) {
    return String(text ?? '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** @param {{title: string}} arg0 - */
function salienceOf({ title }) {
    if (/defin|payment|fee|price|term|termination|liabilit|indemn|confidential|intellectual|data|dispute|governing|warrant|sankc|odměn|závazek/i.test(title)) return 'core';
    if (/schedule|annex|appendix|exhibit|příloha/i.test(title)) return 'support';
    return 'scope';
}

/** @param {{headings: Array<{level: number, title: string, start: number, end: number, line: number, anchor: string}>, heading: {level: number, title: string, start: number, end: number, line: number, anchor: string}, sectionIds: Map<number, string>}} arg0 - */
function parentSection({ headings, heading, sectionIds }) {
    for (let index = headings.indexOf(heading) - 1; index >= 0; index--) {
        if (headings[index].level < heading.level) return sectionIds.get(headings[index].start) ?? null;
    }
    return null;
}

/** @param {{headings: Array<{level: number, title: string, start: number, end: number, line: number, anchor: string}>, offset: number}} arg0 - */
function headingAt({ headings, offset }) {
    let current = null;
    for (const heading of headings) {
        if (heading.start <= offset) current = heading;
        else break;
    }
    return current;
}

/** @param {{headings: Array<{level: number, title: string, start: number, end: number, line: number, anchor: string}>, sectionIds: Map<number, string>, anchor: string}} arg0 - */
function sectionByAnchor({ headings, sectionIds, anchor }) {
    const heading = headings.find((candidate) => candidate.anchor === anchor);
    return heading ? sectionIds.get(heading.start) ?? null : null;
}
