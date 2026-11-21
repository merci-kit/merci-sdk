/** @file Document-review skill script: scores a document across focus areas (clarity/grammar/structure/tone); prints JSON {score, document_length, focus_areas, issues, suggestions}. @version 0.7.2 */
const args = JSON.parse(process.argv[2] || '{}');
const document = String(args.document ?? '');
const focusAreas = String(args.focus_areas ?? 'clarity, grammar, structure');

if (!document.trim()) {
    console.log(JSON.stringify({ score: 0, issues: ['No document provided.'], suggestions: ['Supply a non-empty document.'] }));
    process.exit(0);
}

const issues = [];
const suggestions = [];
const areas = focusAreas.split(',').map(a => a.trim().toLowerCase());

const wordCount = document.split(/\s+/).filter(Boolean).length;

if (areas.includes('clarity')) {
    if (wordCount < 20) {
        issues.push('Very short document; clarity is hard to assess fully.');
        suggestions.push('Consider expanding the document with more detail.');
    }
    const longSentences = document.match(/[^.!?]{80,}[.!?]/g);
    if (longSentences && longSentences.length > 0) {
        issues.push(`Found ${longSentences.length} long sentence(s) (>80 chars).`);
        suggestions.push('Break long sentences into shorter ones for better readability.');
    }
}

if (areas.includes('grammar')) {
    const passivePattern = /\b(is|are|was|were|be|been|being)\s+\w+ed\b/gi;
    const passiveMatches = document.match(passivePattern);
    if (passiveMatches && passiveMatches.length > 3) {
        issues.push(`Document uses passive voice frequently (${passiveMatches.length} occurrences).`);
        suggestions.push('Consider using active voice where possible.');
    }
}

if (areas.includes('structure')) {
    const hasHeading = /^#{1,6}\s+/m.test(document);
    if (!hasHeading) {
        issues.push('No headings found — structure may be flat.');
        suggestions.push('Add headings to organize content hierarchically.');
    }
    const paragraphs = document.split(/\n\s*\n/).filter(Boolean);
    if (paragraphs.length < 2) {
        issues.push('Only one paragraph detected.');
        suggestions.push('Break content into multiple paragraphs for better flow.');
    }
}

if (areas.includes('tone')) {
    const aggressiveWords = /\b(terrible|awful|stupid|idiotic|incompetent)\b/gi;
    const matches = document.match(aggressiveWords);
    if (matches && matches.length > 0) {
        issues.push(`Aggressive tone detected (words: ${[...new Set(matches)].join(', ')}).`);
        suggestions.push('Use neutral, professional language instead of loaded terms.');
    }
}

const score = Math.max(1, Math.min(10, 10 - issues.length));

const result = {
    score,
    document_length: wordCount,
    focus_areas: focusAreas,
    issues: issues.length > 0 ? issues : ['No major issues detected.'],
    suggestions: suggestions.length > 0 ? suggestions : ['Document looks good — no further suggestions.'],
};

console.log(JSON.stringify(result));
