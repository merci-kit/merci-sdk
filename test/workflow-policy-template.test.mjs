// @ts-check

/**
 * @file Stage 3 tests: strict workflow prompt template parse/render (§5.3).
 * @version 0.12.0
 *
 * @description
 * The template dialect is a fixed subset of Liquid: outputs, `if`/`elsif`/
 * `else`, `raw`, and trim markers. Everything else is a parse error, an unknown
 * path is a render error, and no error ever carries the template text or a
 * rendered value.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';

import { renderPromptTemplate } from '../lib/agentic/workflow-policy/index.mjs';
import { parseTemplate, renderParsedTemplate } from '../lib/agentic/workflow-policy/template.mjs';
import { PolicyError } from '../lib/core/errors.mjs';

/** Every renderable field of the §3.9 issue view, both naming styles. */
const ISSUE = Object.freeze({
    id: 'item-1',
    identifier: 'MERCI-1',
    title: 'Fix the widget',
    description: 'The widget is broken.',
    state: 'In Progress',
    url: 'https://example.test/MERCI-1',
    lane: 'In Progress',
    dispatchable: true,
    priority: 2,
    labels: ['agent', 'bug'],
    blockedBy: ['MERCI-0'],
    blocked_by: ['MERCI-0', 'MERCI-2'],
    createdAt: '2026-11-01T00:00:00.000Z',
    created_at: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    updated_at: '2026-11-02T00:00:00.000Z',
    branch_name: 'merci/merci-1',
    assignee_id: 'user-1',
    native_ref: { id: 'n-1' },
    metadata: { source: 'linear' }
});

/** The reference prompt's constructs, one per line so the output is checkable. */
const REFERENCE_PROMPT = [
    'You are working on `{{ issue.identifier }}`.',
    '',
    'Labels: {{ issue.labels }}',
    'Attempt: {{ attempt }}',
    '{% if attempt %}Retry number {{ attempt }}.{% endif %}',
    '{% if issue.description %}Description: {{ issue.description }}{% else %}No description.{% endif %}'
].join('\n');

/**
 * @param {{template: string, issue?: Record<string, unknown>, attempt?: unknown, maxRenderedChars?: unknown, maxDepth?: unknown}} arg0
 * @returns {string}
 */
function render({ template, issue = ISSUE, attempt = null, maxRenderedChars, maxDepth }) {
    /** @type {{template: string, issue: Record<string, unknown>, attempt: unknown, maxRenderedChars?: number, maxDepth?: number}} */
    const options = { template, issue, attempt };
    if (maxRenderedChars !== undefined) options.maxRenderedChars = /** @type {number} */ (maxRenderedChars);
    if (maxDepth !== undefined) options.maxDepth = /** @type {number} */ (maxDepth);
    return renderPromptTemplate(options);
}

/**
 * Runs a render that must fail and returns the error.
 * @param {{template: string, issue?: Record<string, unknown>, attempt?: unknown, maxRenderedChars?: unknown, maxDepth?: unknown}} arg0
 * @returns {PolicyError}
 */
function renderError({ template, issue, attempt, maxRenderedChars, maxDepth }) {
    try {
        render({ template, issue, attempt, maxRenderedChars, maxDepth });
    } catch (err) {
        assert.ok(err instanceof PolicyError, `expected PolicyError, got ${String(err)}`);
        return err;
    }
    assert.fail('expected the template to fail');
}

/**
 * Runs a parse that must fail and returns the error.
 * @param {{template: string, maxDepth?: unknown}} arg0
 * @returns {PolicyError}
 */
function parseError({ template, maxDepth }) {
    try {
        if (maxDepth === undefined) parseTemplate({ template });
        else parseTemplate({ template, maxDepth: /** @type {number} */ (maxDepth) });
    } catch (err) {
        assert.ok(err instanceof PolicyError, `expected PolicyError, got ${String(err)}`);
        return err;
    }
    assert.fail('expected the template to fail');
}

/**
 * @param {{template: string}} arg0
 * @returns {boolean}
 */
function parses({ template }) {
    parseTemplate({ template });
    return true;
}

describe('issue fields', () => {
    it('renders every scalar and array field of the full fixture', () => {
        const template = [
            '{{ issue.id }}',
            '{{ issue.identifier }}',
            '{{ issue.title }}',
            '{{ issue.description }}',
            '{{ issue.state }}',
            '{{ issue.url }}',
            '{{ issue.lane }}',
            '{{ issue.dispatchable }}',
            '{{ issue.priority }}',
            '{{ issue.labels }}',
            '{{ issue.blockedBy }}',
            '{{ issue.blocked_by }}',
            '{{ issue.createdAt }}',
            '{{ issue.created_at }}',
            '{{ issue.updatedAt }}',
            '{{ issue.updated_at }}',
            '{{ issue.branch_name }}',
            '{{ issue.assignee_id }}'
        ].join('\n');
        assert.equal(render({ template }), [
            'item-1',
            'MERCI-1',
            'Fix the widget',
            'The widget is broken.',
            'In Progress',
            'https://example.test/MERCI-1',
            'In Progress',
            'true',
            '2',
            'agent, bug',
            'MERCI-0',
            'MERCI-0, MERCI-2',
            '2026-11-01T00:00:00.000Z',
            '2026-11-01T00:00:00.000Z',
            '2026-11-02T00:00:00.000Z',
            '2026-11-02T00:00:00.000Z',
            'merci/merci-1',
            'user-1'
        ].join('\n'));
    });

    it('treats an object field as non_scalar', () => {
        const err = renderError({ template: '{{ issue.native_ref }}' });
        assert.equal(err.reason, 'template_render_error:issue.native_ref:non_scalar');
        assert.equal(err.field, 'issue.native_ref');
    });
});

describe('conformance fixture', () => {
    it('parses and renders the reference prompt with attempt: null', () => {
        assert.equal(render({ template: REFERENCE_PROMPT, attempt: null }), [
            'You are working on `MERCI-1`.',
            '',
            'Labels: agent, bug',
            'Attempt: ',
            '',
            'Description: The widget is broken.'
        ].join('\n'));
    });

    it('parses and renders the reference prompt with attempt: 2', () => {
        assert.equal(render({ template: REFERENCE_PROMPT, attempt: 2 }), [
            'You are working on `MERCI-1`.',
            '',
            'Labels: agent, bug',
            'Attempt: 2',
            'Retry number 2.',
            'Description: The widget is broken.'
        ].join('\n'));
    });

    it('renders the else branch when the description is absent', () => {
        const issue = { ...ISSUE, description: null };
        assert.equal(render({ template: REFERENCE_PROMPT, issue }), [
            'You are working on `MERCI-1`.',
            '',
            'Labels: agent, bug',
            'Attempt: ',
            '',
            'No description.'
        ].join('\n'));
    });

    it('renders {{ attempt }} as an empty string and as the number', () => {
        assert.equal(render({ template: '{{ attempt }}', attempt: null }), '');
        assert.equal(render({ template: '{{ attempt }}', attempt: 2 }), '2');
    });
});

describe('truthiness', () => {
    it('is JS-like for attempt', () => {
        const template = '{% if attempt %}yes{% else %}no{% endif %}';
        assert.equal(render({ template, attempt: null }), 'no');
        assert.equal(render({ template, attempt: 2 }), 'yes');
        assert.equal(render({ template, attempt: 0 }), 'no');
        assert.equal(render({ template, attempt: false }), 'no');
        assert.equal(render({ template, attempt: '' }), 'no');
    });

    it('takes the else branch for a null or empty description', () => {
        const template = '{% if issue.description %}has{% else %}none{% endif %}';
        assert.equal(render({ template, issue: { description: null } }), 'none');
        assert.equal(render({ template, issue: { description: '' } }), 'none');
        assert.equal(render({ template, issue: { description: 'x' } }), 'has');
    });

    it('treats 0, NaN and an empty array as falsy while {} is truthy', () => {
        const template = '{% if issue.value %}yes{% else %}no{% endif %}';
        assert.equal(render({ template, issue: { value: 0 } }), 'no');
        assert.equal(render({ template, issue: { value: Number.NaN } }), 'no');
        assert.equal(render({ template, issue: { value: [] } }), 'no');
        assert.equal(render({ template, issue: { value: {} } }), 'yes');
        assert.equal(render({ template, issue: { value: [0] } }), 'yes');
    });
});

describe('if blocks', () => {
    it('walks an elsif chain in order', () => {
        const template = '{% if issue.description %}d{% elsif issue.labels %}l{% elsif issue.title %}t{% else %}n{% endif %}';
        assert.equal(render({ template }), 'd');
        assert.equal(render({ template, issue: { description: null, labels: ['a'], title: 't' } }), 'l');
        assert.equal(render({ template, issue: { description: null, labels: [], title: 't' } }), 't');
        assert.equal(render({ template, issue: { description: null, labels: [], title: '' } }), 'n');
    });

    it('nests if blocks', () => {
        const template = '{% if issue.labels %}a{% if issue.description %}b{% else %}c{% endif %}{% endif %}';
        assert.equal(render({ template }), 'ab');
        assert.equal(render({ template, issue: { labels: ['x'], description: null } }), 'ac');
        assert.equal(render({ template, issue: { labels: [], description: 'x' } }), '');
    });

    it('accepts an else without a body and empty branches', () => {
        assert.equal(render({ template: 'a{% if issue.description %}{% else %}{% endif %}b' }), 'ab');
        assert.equal(render({ template: 'a{% if issue.description %}{% endif %}b' }), 'ab');
        assert.equal(render({ template: '{% if issue.description %}x{% else %}{% endif %}' }), 'x');
        assert.equal(render({ template: '{% if issue.description %}{% else %}y{% endif %}' }), '');
    });
});

describe('value rendering', () => {
    it('renders arrays, empty arrays, null and scalars', () => {
        assert.equal(render({ template: '{{ issue.labels }}', issue: { labels: ['a', 'b'] } }), 'a, b');
        assert.equal(render({ template: '{{ issue.labels }}', issue: { labels: [] } }), '');
        assert.equal(render({ template: '{{ issue.value }}', issue: { value: null } }), '');
        assert.equal(render({ template: '{{ issue.value }}', issue: { value: undefined } }), '');
        assert.equal(render({ template: '{{ issue.value }}', issue: { value: 0 } }), '0');
        assert.equal(render({ template: '{{ issue.value }}', issue: { value: false } }), 'false');
        assert.equal(render({ template: '{{ issue.value }}', issue: { value: Number.NaN } }), 'NaN');
    });

    it('joins nested arrays and renders their null elements as empty', () => {
        assert.equal(render({ template: '{{ issue.value }}', issue: { value: [['a'], null, 'b'] } }), 'a, , b');
    });

    it('rejects objects and non-JSON values', () => {
        assert.equal(renderError({ template: '{{ issue.value }}', issue: { value: {} } }).reason,
            'template_render_error:issue.value:non_scalar');
        assert.equal(renderError({ template: '{{ issue.value }}', issue: { value: () => 'x' } }).reason,
            'template_render_error:issue.value:non_scalar');
        assert.equal(renderError({ template: '{{ issue.value }}', issue: { value: Symbol('x') } }).reason,
            'template_render_error:issue.value:non_scalar');
        assert.equal(renderError({ template: '{{ issue.value }}', issue: { value: 10n } }).reason,
            'template_render_error:issue.value:non_scalar');
    });

    it('rejects an object element inside an array instead of stringifying it', () => {
        assert.equal(renderError({ template: '{{ issue.value }}', issue: { value: ['a', {}] } }).reason,
            'template_render_error:issue.value:non_scalar');
    });
});

describe('strict resolution', () => {
    it('fails on an unknown output path and names it', () => {
        const err = renderError({ template: '{{ issue.nope }}' });
        assert.equal(err.reason, 'template_render_error:issue.nope');
        assert.equal(err.field, 'issue.nope');
        assert.equal(err.line, null);
    });

    it('fails on an unknown path in a condition', () => {
        const err = renderError({ template: '{% if issue.nope %}x{% endif %}' });
        assert.equal(err.reason, 'template_render_error:issue.nope');
        assert.equal(err.field, 'issue.nope');
    });

    it('fails when the root is not issue or attempt', () => {
        assert.equal(renderError({ template: '{{ other.value }}' }).reason, 'template_render_error:other.value');
    });

    it('fails when an intermediate is not an object', () => {
        const err = renderError({ template: '{{ issue.title.length }}' });
        assert.equal(err.reason, 'template_render_error:issue.title.length');
    });

    it('renders a present-but-null property as an empty string', () => {
        assert.equal(render({ template: '{{ issue.value }}', issue: { value: null } }), '');
    });

    it('turns a throwing getter into a render error', () => {
        const issue = {
            get boom() {
                throw new TypeError('getter exploded');
            }
        };
        const err = renderError({ template: '{{ issue.boom }}', issue });
        assert.equal(err.reason, 'template_render_error:issue.boom');
        assert.equal(err.field, 'issue.boom');
        assert.equal(err.message.includes('getter exploded'), false);
    });

    it('turns a throwing Proxy trap into a render error', () => {
        const issue = new Proxy({ boom: 1 }, {
            get() {
                throw new TypeError('trap exploded');
            }
        });
        const err = renderError({ template: '{{ issue.boom }}', issue });
        assert.equal(err.reason, 'template_render_error:issue.boom');
        assert.equal(err.field, 'issue.boom');
        assert.equal(err.message.includes('trap exploded'), false);
    });
});

describe('parse errors', () => {
    it('rejects a filter in an output', () => {
        const err = renderError({ template: 'line one\n{{ issue.labels | upcase }}' });
        assert.equal(err.reason, 'template_parse_error:unsupported_filter');
        assert.equal(err.line, 2);
        assert.equal(err.column, 1);
    });

    it('rejects an unknown tag with its name', () => {
        const err = parseError({ template: '{% for x in y %}z{% endfor %}' });
        assert.equal(err.reason, 'template_parse_error:unsupported_tag:for');
        assert.equal(err.line, 1);
        assert.equal(err.column, 1);
    });

    it('rejects a comparison', () => {
        const err = parseError({ template: 'a\n{% if issue.a == 1 %}x{% endif %}' });
        assert.equal(err.reason, 'template_parse_error:unsupported_comparison');
        assert.equal(err.line, 2);
        assert.equal(err.column, 1);
    });

    it('rejects an unclosed if', () => {
        assert.equal(parseError({ template: '{% if attempt %}x' }).reason, 'template_parse_error:unclosed_if');
        assert.equal(parseError({ template: '{% if attempt %}x{% else %}y' }).reason, 'template_parse_error:unclosed_if');
    });

    it('rejects an unclosed raw', () => {
        const err = parseError({ template: 'a\n{% raw %}x' });
        assert.equal(err.reason, 'template_parse_error:unclosed_raw');
        assert.equal(err.line, 2);
    });

    it('rejects an unclosed output and tag', () => {
        assert.equal(parseError({ template: '{{ issue.title' }).reason, 'template_parse_error:unclosed_output');
        assert.equal(parseError({ template: '{% if attempt' }).reason, 'template_parse_error:unclosed_tag');
    });

    it('rejects unexpected elsif, else and endif', () => {
        assert.equal(parseError({ template: '{% elsif attempt %}' }).reason, 'template_parse_error:unexpected_tag:elsif');
        assert.equal(parseError({ template: 'x{% else %}' }).reason, 'template_parse_error:unexpected_tag:else');
        assert.equal(parseError({ template: 'x{% endif %}' }).reason, 'template_parse_error:unexpected_tag:endif');
        assert.equal(parseError({ template: '{% endraw %}' }).reason, 'template_parse_error:unexpected_tag:endraw');
    });

    it('rejects an elsif after else', () => {
        assert.equal(parseError({
            template: '{% if attempt %}a{% else %}b{% elsif attempt %}c{% endif %}'
        }).reason, 'template_parse_error:unexpected_tag:elsif');
    });

    it('rejects an empty or malformed expression', () => {
        assert.equal(parseError({ template: '{{ }}' }).reason, 'template_parse_error:invalid_path');
        assert.equal(parseError({ template: '{% if %}x{% endif %}' }).reason, 'template_parse_error:invalid_path');
        assert.equal(parseError({ template: '{{ issue.1bad }}' }).reason, 'template_parse_error:invalid_path');
    });

    it('rejects arguments on a no-argument tag', () => {
        assert.equal(parseError({ template: '{% if attempt %}x{% endif now %}' }).reason,
            'template_parse_error:unexpected_argument:endif');
    });

    it('rejects a forbidden path segment at parse time', () => {
        for (const segment of ['__proto__', 'constructor', 'prototype']) {
            assert.equal(parseError({ template: `{{ issue.${segment} }}` }).reason,
                `template_parse_error:forbidden_path:${segment}`);
            assert.equal(parseError({ template: `{% if ${segment} %}x{% endif %}` }).reason,
                `template_parse_error:forbidden_path:${segment}`);
        }
    });
});

describe('raw blocks', () => {
    it('emits its content literally', () => {
        assert.equal(render({ template: 'a{% raw %}{{ not_a_var }}{% endraw %}b' }), 'a{{ not_a_var }}b');
        assert.equal(render({ template: '{% raw %}{% for x in y %}{% endraw %}' }), '{% for x in y %}');
    });

    it('closes at the first endraw and keeps a second raw literal', () => {
        assert.equal(render({ template: '{% raw %}a{% raw %}b{% endraw %}c' }), 'a{% raw %}bc');
    });

    it('applies trim markers around the raw content', () => {
        assert.equal(render({ template: '{% raw -%}  x  {%- endraw %}' }), 'x');
    });

    it('applies the right trim on endraw', () => {
        assert.equal(render({ template: 'a{% raw %}x{% endraw -%}   b' }), 'axb');
    });

    it('rejects endraw inside an if body with its position', () => {
        const err = parseError({ template: '{% if issue.title %}{% endraw %}{% endif %}' });
        assert.equal(err.reason, 'template_parse_error:unexpected_tag:endraw');
        assert.equal(err.line, 1);
        assert.equal(err.column, 21);
    });
});

describe('trim markers', () => {
    it('strips trailing whitespace after {{-', () => {
        assert.equal(render({ template: 'a \n\t {{- issue.title }}' }), 'aFix the widget');
    });

    it('strips leading whitespace after -}}', () => {
        assert.equal(render({ template: '{{ issue.title -}} \r\n\t b' }), 'Fix the widgetb');
    });

    it('strips trailing whitespace after {%-', () => {
        assert.equal(render({ template: 'a  {%- if attempt %}x{% endif %}', attempt: 1 }), 'ax');
    });

    it('strips leading whitespace after -%}', () => {
        assert.equal(render({ template: '{% if attempt -%}  \n x{% endif %}', attempt: 1 }), 'x');
    });

    it('strips whitespace only, never other characters', () => {
        assert.equal(render({ template: 'a.b{{- issue.title }}' }), 'a.bFix the widget');
        assert.equal(render({ template: '{{ issue.title -}}.b' }), 'Fix the widget.b');
    });

    it('leaves whitespace alone without a trim marker', () => {
        assert.equal(render({ template: 'a  {{ issue.title }}  b' }), 'a  Fix the widget  b');
    });
});

describe('depth and size', () => {
    it('accepts 32 nested if blocks and rejects 33', () => {
        /** @param {{count: number}} arg0 */
        const depth = ({ count }) => `${'{% if attempt %}'.repeat(count)}x${'{% endif %}'.repeat(count)}`;
        assert.equal(render({ template: depth({ count: 32 }), attempt: 1 }), 'x');
        const err = renderError({ template: depth({ count: 33 }), attempt: 1 });
        assert.equal(err.reason, 'template_parse_error:too_deep');
        assert.equal(err.line, 1);
    });

    it('honors an explicit maxDepth', () => {
        const template = '{% if attempt %}{% if attempt %}x{% endif %}{% endif %}';
        assert.equal(render({ template: '{% if attempt %}x{% endif %}', attempt: 1, maxDepth: 1 }), 'x');
        assert.equal(renderError({ template, attempt: 1, maxDepth: 1 }).reason, 'template_parse_error:too_deep');
    });

    it('rejects a non-numeric, non-positive or unbounded maxDepth', () => {
        for (const maxDepth of [Number.NaN, 'x', 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
            assert.equal(parseError({ template: '', maxDepth }).reason, 'invalid_option:maxDepth');
        }
        // A cap above 512 could exhaust the stack before `too_deep` fires, so
        // it fails as an option instead of becoming a raw RangeError later.
        for (const maxDepth of [513, 100_000]) {
            assert.equal(parseError({ template: '', maxDepth }).reason, 'invalid_option:maxDepth');
        }
        assert.doesNotThrow(() => parseTemplate({ template: 'x', maxDepth: 512 }));
    });

    it('reports too_deep, never RangeError, for a valid cap on a deep template', () => {
        const deep = '{% if attempt %}'.repeat(20_000) + '{% endif %}'.repeat(20_000);
        assert.equal(parseError({ template: deep, maxDepth: 32 }).reason, 'template_parse_error:too_deep');
    });

    it('does not count elsif branches toward maxDepth', () => {
        /** @param {{depth: number, elsifs: number}} arg0 */
        const nested = ({ depth, elsifs }) => {
            let body = 'x';
            for (let level = 0; level < depth; level += 1) {
                body = `{% if issue.a %}${body}${'{% elsif issue.a %}'.repeat(elsifs)}{% endif %}`;
            }
            return body;
        };
        assert.equal(render({ template: nested({ depth: 32, elsifs: 200 }), issue: { a: true } }), 'x');
        const err = renderError({ template: nested({ depth: 33, elsifs: 200 }), issue: { a: true } });
        assert.equal(err.reason, 'template_parse_error:too_deep');
    });

    it('rejects output over the cap and accepts exactly the cap', () => {
        assert.equal(render({ template: '{{ issue.title }}', maxRenderedChars: 14 }), 'Fix the widget');
        assert.equal(render({ template: 'x'.repeat(10), maxRenderedChars: 10 }), 'x'.repeat(10));
        assert.equal(render({ template: '{{ issue.title }}{{ issue.title }}', maxRenderedChars: 28 }), 'Fix the widget'.repeat(2));
        const err = renderError({ template: '{{ issue.title }}', maxRenderedChars: 13 });
        assert.equal(err.reason, 'template_render_error:prompt_too_large');
        assert.equal(err.field, null);
    });

    it('rejects a non-numeric or non-positive maxRenderedChars', () => {
        for (const maxRenderedChars of [Number.NaN, 'x', 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
            assert.equal(renderError({ template: 'x', maxRenderedChars }).reason, 'invalid_option:maxRenderedChars');
        }
    });
});

describe('performance', () => {
    it('parses and renders 50 000 output nodes in one pass', { timeout: 5000 }, () => {
        const count = 50_000;
        const template = '{{ issue.identifier }}'.repeat(count);
        const started = performance.now();
        const ast = parseTemplate({ template });
        const rendered = renderParsedTemplate({ ast, issue: ISSUE });
        const elapsed = performance.now() - started;
        assert.equal(ast.nodes.length, count);
        assert.equal(rendered, 'MERCI-1'.repeat(count));
        assert.ok(elapsed < 2000, `parse+render took ${elapsed.toFixed(1)}ms`);
    });
});

describe('positions', () => {
    it('reports line and column after CRLF and multi-line text', () => {
        const err = parseError({ template: 'one\r\ntwo\r\n{{ issue.x | upcase }}' });
        assert.equal(err.line, 3);
        assert.equal(err.column, 1);
        assert.equal(parseError({ template: 'one\r\ntwo {% for %}' }).line, 2);
        assert.equal(parseError({ template: 'one\r\ntwo {% for %}' }).column, 5);
        assert.equal(parseError({ template: 'line one\nline two\n{% if %}' }).line, 3);
        assert.equal(parseError({ template: 'line one\nline two\n{% if %}' }).column, 1);
    });

    it('reports the column of a tag after multi-line text on the same line', () => {
        const err = parseError({ template: 'a\nb\nc   {% raw %}x' });
        assert.equal(err.line, 3);
        assert.equal(err.column, 5);
    });
});

describe('leakage', () => {
    it('never carries the template text or a value in a parse error', () => {
        const err = parseError({ template: 'SECRET_TOKEN_XYZ\n{% for x in y %}' });
        assert.equal(err.message.includes('SECRET_TOKEN_XYZ'), false);
        for (const reason of err.reasons) assert.equal(reason.includes('SECRET_TOKEN_XYZ'), false);
        assert.equal(err.message.includes('for x in y'), false);
    });

    it('never carries the template text or a value in a render error', () => {
        const err = renderError({ template: 'SECRET_TOKEN_XYZ {{ issue.nope }}' });
        assert.equal(err.message.includes('SECRET_TOKEN_XYZ'), false);
        for (const reason of err.reasons) assert.equal(reason.includes('SECRET_TOKEN_XYZ'), false);
    });

    it('sets field on render errors and line/column on parse errors only', () => {
        const parse = parseError({ template: '{{ issue.a | upcase }}' });
        assert.equal(parse.field, null);
        assert.equal(parse.line, 1);
        const renderFailure = renderError({ template: '{{ issue.nope }}' });
        assert.equal(renderFailure.line, null);
        assert.equal(renderFailure.field, 'issue.nope');
    });
});

describe('entry points', () => {
    it('rejects a missing argument as invalid_template instead of a TypeError', () => {
        const calls = [
            () => parseTemplate(),
            () => renderPromptTemplate(),
            () => renderParsedTemplate({ ast: null })
        ];
        for (const call of calls) {
            assert.throws(call, (err) => {
                assert.ok(err instanceof PolicyError);
                assert.equal(err.reason, 'template_parse_error:invalid_template');
                return true;
            });
        }
    });

    it('rejects a non-string template and a missing AST shape', () => {
        for (const template of [null, 3, {}]) {
            /** @type {{template: string}} */
            const options = /** @type {{template: string}} */ (/** @type {unknown} */ ({ template }));
            assert.throws(() => parseTemplate(options), (err) => {
                assert.ok(err instanceof PolicyError);
                assert.equal(err.reason, 'template_parse_error:invalid_template');
                return true;
            });
        }
        for (const ast of [undefined, {}, { nodes: 'x' }]) {
            assert.throws(() => renderParsedTemplate({ ast }), (err) => {
                assert.ok(err instanceof PolicyError);
                assert.equal(err.reason, 'template_parse_error:invalid_template');
                return true;
            });
        }
    });
});

describe('AST', () => {
    it('pins the node shape and offsets', () => {
        const ast = parseTemplate({ template: 'Hi {{ issue.title }}{% if attempt %}r{% endif %}{% raw %}{{x}}{% endraw %}' });
        assert.equal(ast.type, 'root');
        assert.deepEqual(ast.nodes.map((node) => node.type), ['text', 'output', 'if', 'raw']);
        assert.deepEqual(ast.nodes[0], { type: 'text', value: 'Hi ', offset: 0 });
        assert.deepEqual(ast.nodes[1], { type: 'output', path: 'issue.title', segments: ['issue', 'title'], offset: 3 });
        assert.equal(ast.nodes[3].type, 'raw');
        if (ast.nodes[3].type === 'raw') assert.equal(ast.nodes[3].value, '{{x}}');
    });

    it('renders one parsed AST for different items without caching', () => {
        const ast = parseTemplate({ template: '{{ issue.title }}:{{ attempt }}' });
        assert.equal(renderParsedTemplate({ ast, issue: { title: 'a' }, attempt: null }), 'a:');
        assert.equal(renderParsedTemplate({ ast, issue: { title: 'b' }, attempt: 1 }), 'b:1');
    });

    it('renders an empty template as an empty string', () => {
        assert.equal(render({ template: '' }), '');
        assert.deepEqual(parseTemplate({ template: '' }).nodes, []);
    });
});
