/** @file Code-review skill script: scores a code snippet on line length, TODO/FIXME markers, console statements, empty catches, magic numbers and complexity; prints JSON {score, issues, suggestions}. @version 0.7.2 */
const args = JSON.parse(process.argv[2] || '{}');
const code = String(args.code ?? '');
const language = (args.language || 'javascript').toLowerCase();

if (!code.trim()) {
    console.log(JSON.stringify({ score: 0, issues: ['No code provided.'], suggestions: ['Supply a non-empty code snippet.'] }));
    process.exit(0);
}

const issues = [];
const suggestions = [];
const lines = code.split('\n');

const lineCount = lines.length;
const maxLineLength = Math.max(...lines.map(l => l.length), 0);

if (maxLineLength > 120) {
    issues.push(`Longest line is ${maxLineLength} characters; exceeds 120-char limit.`);
    suggestions.push('Break long lines into multiple lines for better readability.');
}

const todoPattern = /\/\/\s*TODO|\/\/\s*FIXME|\/\/\s*HACK/gi;
const todoMatches = code.match(todoPattern);
if (todoMatches && todoMatches.length > 0) {
    issues.push(`Found ${todoMatches.length} TODO/FIXME/HACK comment(s).`);
    suggestions.push('Resolve or track outstanding TODO items before merging.');
}

const consolePattern = language === 'javascript' ? /\bconsole\.(log|warn|error|debug)\s*\(/g : null;
if (consolePattern) {
    const consoleMatches = code.match(consolePattern);
    if (consoleMatches && consoleMatches.length > 3) {
        issues.push(`Excessive console statements (${consoleMatches.length}).`);
        suggestions.push('Replace console statements with a proper logging library in production code.');
    }
}

const emptyCatch = /catch\s*\([^)]*\)\s*\{\s*\}/g;
const emptyCatchMatches = code.match(emptyCatch);
if (emptyCatchMatches && emptyCatchMatches.length > 0) {
    issues.push(`Found ${emptyCatchMatches.length} empty catch block(s).`);
    suggestions.push('Never swallow exceptions silently — at minimum, log the error.');
}

const magicNumbers = /(?<![a-zA-Z0-9_])(?![0-9]+[a-zA-Z])[0-9]{2,}(?![a-zA-Z0-9_])/g;
const magicMatches = code.match(magicNumbers);
if (magicMatches && magicMatches.length > 5) {
    issues.push(`Many magic numbers detected (${magicMatches.slice(0, 5).join(', ')}...).`);
    suggestions.push('Extract magic numbers into named constants for maintainability.');
}

if (lineCount > 300) {
    issues.push(`File is ${lineCount} lines long; consider splitting into smaller modules.`);
    suggestions.push('Split large files into cohesive modules following single-responsibility principle.');
}

const complexityIndicators = (code.match(/\bif\b/g) || []).length +
                              (code.match(/\bfor\b/g) || []).length +
                              (code.match(/\bwhile\b/g) || []).length;
if (complexityIndicators > 20) {
    issues.push(`High cyclomatic complexity (${complexityIndicators} branching statements).`);
    suggestions.push('Refactor deeply nested logic into smaller helper functions.');
}

const score = Math.max(1, Math.min(10, 10 - issues.length));

const result = {
    score,
    language,
    line_count: lineCount,
    max_line_length: maxLineLength,
    issues: issues.length > 0 ? issues : ['No major issues detected.'],
    suggestions: suggestions.length > 0 ? suggestions : ['Code looks clean — no further suggestions.'],
};

console.log(JSON.stringify(result));
