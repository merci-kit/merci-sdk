// @ts-check

/**
 * @file Stage 2 tests: strict workflow config resolution (§5.2).
 * @version 0.12.0
 *
 * @description
 * Every field has a default, a bound, and a normalized form. Errors are
 * aggregated into one `PolicyError` whose message never carries a value, and
 * the resolved object is deep-frozen with `Object.prototype`.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    resolveWorkflowConfig,
    WORKFLOW_POLICY_DEFAULTS,
    WORKFLOW_POLICY_REASONS,
    WORKFLOW_POLICY_WARNINGS
} from '../lib/agentic/workflow-policy/index.mjs';
import { redactConfig } from '../lib/agentic/workflow-policy/config.mjs';
import { PolicyError } from '../lib/core/errors.mjs';

const BASE_DIR = '/base';
const HOME = '/home/u';

/** The exact §3.4 defaults plus the approved `scheduler.maxDispatches` amendment. */
const DEFAULTS = {
    tracker: {
        kind: null,
        provider: {},
        requiredLabels: [],
        activeStates: [],
        terminalStates: []
    },
    polling: { intervalMs: 30_000 },
    workspace: {
        root: join(tmpdir(), 'merci-workspaces'),
        strategy: 'directory',
        repoRoot: null,
        baseRef: 'HEAD',
        branchPrefix: 'merci/'
    },
    hooks: {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 60_000
    },
    agent: {
        maxConcurrentAgents: 1,
        maxTurns: 20,
        maxRetryBackoffMs: 300_000,
        maxConcurrentAgentsByState: {}
    },
    scheduler: {
        maxAttemptsPerItem: 5,
        continuationMax: 3,
        continuationDelayMs: 1_000,
        stallTimeoutMs: 900_000,
        retryBaseMs: 10_000,
        maxTotalTokens: null,
        maxTotalUsd: null,
        maxDispatches: null
    },
    engine: { kind: 'agentic', model: null }
};

/**
 * @param {Record<string, unknown>} config
 * @param {{baseDir?: string, env?: Record<string, string|undefined>, home?: string}} [options]
 */
function resolveConfig(config, { baseDir = BASE_DIR, env = {}, home = HOME } = {}) {
    const result = resolveWorkflowConfig({ config, baseDir, env, home });
    // A resolve must never freeze a shared prototype (the `$__proto__` defect).
    assert.equal(Object.isFrozen(Object.prototype), false, 'resolve must not freeze Object.prototype');
    return result;
}

/**
 * @param {Record<string, unknown>} config
 * @param {{baseDir?: string, env?: Record<string, string|undefined>, home?: string}} [options]
 * @returns {PolicyError}
 */
function errorFor(config, options) {
    try {
        resolveConfig(config, options);
    } catch (err) {
        assert.ok(err instanceof PolicyError, `expected PolicyError, got ${String(err)}`);
        assert.equal(Object.isFrozen(Object.prototype), false, 'a rejection must not freeze Object.prototype');
        return err;
    }
    assert.fail('expected the config to be rejected');
}

/**
 * @param {{value: unknown, path?: string}} arg0
 */
function assertFrozenDeep({ value, path = 'config' }) {
    if (value === null || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value), `${path} must be frozen`);
    for (const key of Object.keys(value)) {
        assertFrozenDeep({ value: /** @type {Record<string, unknown>} */ (value)[key], path: `${path}.${key}` });
    }
}

describe('resolveWorkflowConfig defaults', () => {
    it('returns the exact default shape, frozen at every level', () => {
        const { config, warnings } = resolveWorkflowConfig({});
        assert.deepEqual(config, DEFAULTS);
        assert.deepEqual(warnings, ['no_active_states']);
        assert.equal(Object.getPrototypeOf(config), Object.prototype);
        assert.equal(Object.hasOwn(config, '__proto__'), false);
        assertFrozenDeep({ value: config });
        assert.ok(Object.isFrozen(warnings));
    });

    it('pins the documented defaults and code tables', () => {
        assert.deepEqual(WORKFLOW_POLICY_DEFAULTS, {
            path: 'WORKFLOW.md',
            watch: true,
            debounceMs: 100,
            maxFileBytes: 1_048_576,
            maxTemplateDepth: 32,
            maxRenderedChars: 1_000_000,
            promptFallback: 'You are working on an issue from the configured tracker.'
        });
        assert.ok(Object.isFrozen(WORKFLOW_POLICY_DEFAULTS));
        assert.ok(Object.isFrozen(WORKFLOW_POLICY_REASONS));
        assert.ok(Object.isFrozen(WORKFLOW_POLICY_WARNINGS));
        for (const code of ['missing_workflow_file', 'workflow_read_error', 'workflow_too_large',
            'workflow_parse_error', 'workflow_front_matter_not_a_map', 'invalid_config', 'missing_env',
            'template_parse_error', 'template_render_error', 'not_started', 'already_started', 'stopped']) {
            assert.ok(WORKFLOW_POLICY_REASONS.includes(code), `REASONS must include ${code}`);
        }
        for (const code of ['unknown_key', 'unsupported_section', 'invalid_by_state', 'empty_prompt',
            'no_active_states', 'watch_failed']) {
            assert.ok(WORKFLOW_POLICY_WARNINGS.includes(code), `WARNINGS must include ${code}`);
        }
    });

    it('does not mutate the input config', () => {
        const input = {
            tracker: { kind: 'linear', required_labels: [' Agent '] },
            polling: { interval_ms: 1000 }
        };
        const snapshot = structuredClone(input);
        resolveConfig(input);
        assert.deepEqual(input, snapshot);
    });

    it('reports a non-object config as one invalid_config:config error', () => {
        for (const config of [[], 'text', 3, null]) {
            assert.throws(() => resolveWorkflowConfig({ config }), (err) => {
                assert.ok(err instanceof PolicyError);
                assert.equal(err.reason, 'invalid_config:config');
                assert.deepEqual(err.reasons, ['invalid_config:config']);
                assert.equal(err.message, 'Workflow policy is invalid: 1 error(s)');
                return true;
            });
        }
    });

    it('reports a scalar section instead of crashing or accepting it', () => {
        assert.deepEqual(errorFor({ polling: 3 }).reasons, ['invalid_config:polling']);
        assert.deepEqual(errorFor({ tracker: [] }).reasons, ['invalid_config:tracker']);
    });
});

describe('tracker', () => {
    it('accepts an absent tracker', () => {
        const { config } = resolveWorkflowConfig({});
        assert.equal(config.tracker.kind, null);
        assert.deepEqual(config.tracker.provider, {});
    });

    it('requires kind when the section is present', () => {
        const err = errorFor({ tracker: {} });
        assert.deepEqual(err.reasons, ['invalid_config:tracker.kind']);
        assert.equal(err.reason, 'invalid_config:tracker.kind');
    });

    it('trims a present kind', () => {
        const { config } = resolveConfig({ tracker: { kind: '  linear  ' } });
        assert.equal(config.tracker.kind, 'linear');
    });

    it('rejects an empty or non-string kind', () => {
        for (const kind of ['', '   ', 3, null, true]) {
            const err = errorFor({ tracker: { kind } });
            assert.ok(err.reasons.includes('invalid_config:tracker.kind'), `kind=${String(kind)}`);
        }
    });

    it('normalizes required labels (trim, lowercase, dedupe, drop blanks)', () => {
        const { config } = resolveConfig({ tracker: { kind: 'linear', required_labels: [' Agent ', 'agent', '  ', 'QA'] } });
        assert.deepEqual(config.tracker.requiredLabels, ['agent', 'qa']);
    });

    it('rejects a non-array label list or non-string labels', () => {
        assert.ok(errorFor({ tracker: { kind: 'linear', required_labels: 'agent' } }).reasons.includes('invalid_config:tracker.required_labels'));
        assert.ok(errorFor({ tracker: { kind: 'linear', required_labels: ['agent', 3] } }).reasons.includes('invalid_config:tracker.required_labels'));
    });

    it('normalizes state lists (trim, dedupe, original case)', () => {
        const { config } = resolveConfig({
            tracker: { kind: 'linear', active_states: ['Todo', ' In Progress ', 'todo', ''] }
        });
        assert.deepEqual(config.tracker.activeStates, ['Todo', 'In Progress']);
    });

    it('rejects an active/terminal overlap case-insensitively', () => {
        const err = errorFor({
            tracker: { kind: 'linear', active_states: ['Todo'], terminal_states: ['todo'] }
        });
        assert.ok(err.reasons.includes('invalid_config:tracker.terminal_states'));
    });

    it('warns no_active_states only when both lists are empty', () => {
        assert.deepEqual(resolveConfig({}).warnings, ['no_active_states']);
        assert.equal(resolveConfig({ tracker: { kind: 'linear', active_states: ['Todo'] } }).warnings.includes('no_active_states'), false);
    });

    it('normalizes and filters max_concurrent_agents_by_state', () => {
        const { config, warnings } = resolveConfig({
            agent: {
                max_concurrent_agents_by_state: { Review: 2, ' In Progress ': 1, Bad: 0, Worse: 1.5, QA: 3 }
            }
        });
        assert.deepEqual(config.agent.maxConcurrentAgentsByState, { review: 2, 'in progress': 1, qa: 3 });
        assert.ok(warnings.includes('invalid_by_state:bad'));
        assert.ok(warnings.includes('invalid_by_state:worse'));
    });

    it('rejects a by-state value that is not an object', () => {
        assert.ok(errorFor({ agent: { max_concurrent_agents_by_state: [1] } }).reasons.includes('invalid_config:agent.max_concurrent_agents_by_state'));
    });

    it('rejects a forbidden by-state key after normalization', () => {
        const upper = errorFor({ agent: { max_concurrent_agents_by_state: { CONSTRUCTOR: 4 } } });
        assert.deepEqual(upper.reasons, ['invalid_config:agent.max_concurrent_agents_by_state.constructor']);

        const proto = errorFor({ agent: { max_concurrent_agents_by_state: { __PROTO__: 5 } } });
        assert.ok(proto.reasons.includes('invalid_config:agent.max_concurrent_agents_by_state.__proto__'),
            `__PROTO__ must be an error, not a silent drop; got ${proto.reasons.join(', ')}`);

        const { config } = resolveConfig({ agent: { max_concurrent_agents_by_state: { Review: 2 } } });
        assert.equal(Object.hasOwn(config.agent.maxConcurrentAgentsByState, 'constructor'), false);
        assert.equal(Object.hasOwn(config.agent.maxConcurrentAgentsByState, '__proto__'), false);
        assert.equal(Object.getPrototypeOf(config.agent.maxConcurrentAgentsByState), Object.prototype);
    });
});

describe('numeric bounds', () => {
    /** @type {Array<{field: string, make: (value: unknown) => Record<string, unknown>, valid: unknown[], invalid: unknown[]}>} */
    const cases = [
        { field: 'polling.interval_ms', make: (v) => ({ polling: { interval_ms: v } }), valid: [1, 30_000], invalid: [0, -1, 1.5, NaN, Infinity, true, '1000', null] },
        { field: 'agent.max_concurrent_agents', make: (v) => ({ agent: { max_concurrent_agents: v } }), valid: [1, 4], invalid: [0, -1, 1.2, NaN, Infinity, false, '1', null] },
        { field: 'agent.max_turns', make: (v) => ({ agent: { max_turns: v } }), valid: [1, 20], invalid: [0, -1, 2.5, NaN, Infinity, true, '20', null] },
        { field: 'agent.max_retry_backoff_ms', make: (v) => ({ agent: { max_retry_backoff_ms: v } }), valid: [300_000], invalid: [-1, 1.5, NaN, Infinity, true, '300000', null] },
        { field: 'hooks.timeout_ms', make: (v) => ({ hooks: { timeout_ms: v } }), valid: [1, 60_000], invalid: [0, -1, 1.5, NaN, Infinity, true, '60000', null] },
        { field: 'scheduler.max_attempts_per_item', make: (v) => ({ merci: { scheduler: { max_attempts_per_item: v } } }), valid: [1, 5], invalid: [0, -1, 1.5, NaN, Infinity, true, '5', null] },
        { field: 'scheduler.retry_base_ms', make: (v) => ({ merci: { scheduler: { retry_base_ms: v } } }), valid: [0, 10_000], invalid: [-1, 1.5, NaN, Infinity, true, '10000', null] },
        { field: 'scheduler.continuation_delay_ms', make: (v) => ({ merci: { scheduler: { continuation_delay_ms: v } } }), valid: [0, 1_000], invalid: [-1, 1.5, NaN, Infinity, true, '1000', null] },
        { field: 'scheduler.continuation_max', make: (v) => ({ merci: { scheduler: { continuation_max: v } } }), valid: [0, 3], invalid: [-1, 1.5, NaN, Infinity, true, '3', null] },
        { field: 'scheduler.stall_timeout_ms', make: (v) => ({ merci: { scheduler: { stall_timeout_ms: v } } }), valid: [0, 900_000], invalid: [-1, 1.5, NaN, Infinity, true, '900000', null] },
        { field: 'scheduler.max_total_tokens', make: (v) => ({ merci: { scheduler: { max_total_tokens: v } } }), valid: [1, 100], invalid: [0, -1, 1.5, NaN, Infinity, true, '10'] },
        { field: 'scheduler.max_total_usd', make: (v) => ({ merci: { scheduler: { max_total_usd: v } } }), valid: [0.5, 1.25, 3], invalid: [0, -1, NaN, Infinity, true, '1'] },
        { field: 'scheduler.max_dispatches', make: (v) => ({ merci: { scheduler: { max_dispatches: v } } }), valid: [1, 7], invalid: [0, -1, 1.5, NaN, Infinity, true, '2'] }
    ];

    for (const { field, make, valid, invalid } of cases) {
        it(`enforces ${field}`, () => {
            for (const value of valid) {
                assert.doesNotThrow(() => resolveConfig(make(value)), `${field} must accept ${String(value)}`);
            }
            for (const value of invalid) {
                const err = errorFor(make(value));
                assert.ok(err.reasons.includes(`invalid_config:${field}`),
                    `${field}=${String(value)} should be rejected; got ${err.reasons.join(', ')}`);
            }
        });
    }

    it('accepts null for the optional limits and validates them when set', () => {
        const { config } = resolveConfig({
            merci: { scheduler: { max_total_tokens: null, max_total_usd: null, max_dispatches: null } }
        });
        assert.equal(config.scheduler.maxTotalTokens, null);
        assert.equal(config.scheduler.maxTotalUsd, null);
        assert.equal(config.scheduler.maxDispatches, null);
    });
});

describe('workspace', () => {
    it('requires repo_root for git-worktree', () => {
        const err = errorFor({ merci: { workspace: { strategy: 'git-worktree' } } });
        assert.ok(err.reasons.includes('invalid_config:workspace.repo_root'));
    });

    it('accepts and absolutizes a relative repo_root for git-worktree', () => {
        const { config } = resolveConfig({ merci: { workspace: { strategy: 'git-worktree', repo_root: 'repos/main' } } });
        assert.equal(config.workspace.strategy, 'git-worktree');
        assert.equal(config.workspace.repoRoot, '/base/repos/main');
    });

    it('rejects an unknown strategy', () => {
        assert.ok(errorFor({ merci: { workspace: { strategy: 'rsync' } } }).reasons.includes('invalid_config:workspace.strategy'));
    });

    it('expands ~, $VAR, ${VAR}, relative, and absolute roots', () => {
        const env = { FOO: 'foo', BAR: '$BAZ' };
        assert.equal(resolveConfig({ workspace: { root: '~/ws' } }, { env }).config.workspace.root, '/home/u/ws');
        assert.equal(resolveConfig({ workspace: { root: '$FOO/ws' } }, { env }).config.workspace.root, '/base/foo/ws');
        assert.equal(resolveConfig({ workspace: { root: '${FOO}/ws' } }, { env }).config.workspace.root, '/base/foo/ws');
        assert.equal(resolveConfig({ workspace: { root: 'rel/ws' } }, { env }).config.workspace.root, '/base/rel/ws');
        assert.equal(resolveConfig({ workspace: { root: '/abs/ws' } }, { env }).config.workspace.root, '/abs/ws');
        assert.equal(resolveConfig({ workspace: { root: '$BAR' } }, { env }).config.workspace.root, '/base/$BAZ');
    });

    it('leaves a lone $ literal', () => {
        assert.equal(resolveConfig({ workspace: { root: '$' } }).config.workspace.root, '/base/$');
        assert.equal(resolveConfig({ workspace: { root: 'a$/b' } }).config.workspace.root, '/base/a$/b');
        assert.equal(resolveConfig({ workspace: { root: '${}' } }).config.workspace.root, '/base/${}');
    });

    it('reports a missing or empty variable', () => {
        const missing = errorFor({ workspace: { root: '$NOPE/ws' } });
        assert.ok(missing.reasons.includes('missing_env:workspace.root:NOPE'));
        assert.throws(() => resolveConfig({ workspace: { root: '$EMPTY/ws' } }, { env: { EMPTY: '' } }), (err) => {
            assert.ok(err instanceof PolicyError);
            assert.ok(err.reasons.includes('missing_env:workspace.root:EMPTY'));
            return true;
        });
    });

    it('rejects a non-string root', () => {
        for (const root of [3, null, '', true]) {
            assert.ok(errorFor({ workspace: { root } }).reasons.includes('invalid_config:workspace.root'), `root=${String(root)}`);
        }
    });

    it('expands only a bare ~ or a ~/ prefix', () => {
        assert.equal(resolveConfig({ workspace: { root: '~' } }).config.workspace.root, HOME);
        assert.equal(resolveConfig({ workspace: { root: '~/ws' } }).config.workspace.root, '/home/u/ws');
        for (const root of ['~user/ws', '~foo', '~user']) {
            assert.ok(errorFor({ workspace: { root } }).reasons.includes('invalid_config:workspace.root'),
                `root=${root} must not resolve as a relative path`);
        }
        const repo = errorFor({ merci: { workspace: { strategy: 'git-worktree', repo_root: '~user/ws' } } });
        assert.ok(repo.reasons.includes('invalid_config:workspace.repo_root'));

        // An env value that expands to `~user` is rejected by the same rule:
        // expansion happens first, so it cannot smuggle a pseudo-home past it.
        const viaEnv = errorFor({ workspace: { root: '$T' } }, { env: { T: '~user/ws' } });
        assert.ok(viaEnv.reasons.includes('invalid_config:workspace.root'));
        assert.equal(
            resolveConfig({ workspace: { root: '$T' } }, { env: { T: '~/ws' } }).config.workspace.root,
            '/home/u/ws'
        );
    });

    it('rejects non-string base_ref, branch_prefix, and repo_root', () => {
        for (const value of [3, '', '   ', true, null]) {
            assert.ok(errorFor({ merci: { workspace: { base_ref: value } } }).reasons.includes('invalid_config:workspace.base_ref'),
                `base_ref=${String(value)}`);
        }
        for (const value of [3, true, null]) {
            assert.ok(errorFor({ merci: { workspace: { branch_prefix: value } } }).reasons.includes('invalid_config:workspace.branch_prefix'),
                `branch_prefix=${String(value)}`);
        }
        for (const value of [3, true, [], {}]) {
            assert.ok(errorFor({ merci: { workspace: { repo_root: value } } }).reasons.includes('invalid_config:workspace.repo_root'),
                `repo_root=${String(value)}`);
        }
    });
});

describe('environment lookup', () => {
    it('refuses inherited names instead of reading the prototype chain', () => {
        assert.equal(Object.isFrozen(Object.prototype), false);
        const ownAmount = Object.getOwnPropertyNames(Object.prototype).length;

        const inherited = errorFor({ tracker: { kind: 'linear', provider: { leaf: '$toString' } } });
        assert.ok(inherited.reasons.includes('missing_env:tracker.provider.leaf:toString'),
            `an inherited method must be missing; got ${inherited.reasons.join(', ')}`);

        const protoEnv = /** @type {Record<string, string|undefined>} */ (Object.create({ INHERITED: 'x' }));
        const chain = errorFor({ workspace: { root: '$INHERITED/ws' } }, { env: protoEnv });
        assert.ok(chain.reasons.includes('missing_env:workspace.root:INHERITED'));

        assert.equal(Object.isFrozen(Object.prototype), false, 'Object.prototype must never be frozen');
        assert.equal(Object.getOwnPropertyNames(Object.prototype).length, ownAmount);
    });

    it('refuses forbidden names even when env owns them', () => {
        const hostile = /** @type {Record<string, string|undefined>} */ (
            JSON.parse('{"__proto__":"p","constructor":"c","prototype":"p2"}')
        );
        assert.equal(Object.hasOwn(hostile, '__proto__'), true);
        for (const name of ['__proto__', 'constructor', 'prototype']) {
            const bare = errorFor({ workspace: { root: `$${name}/ws` } }, { env: hostile });
            assert.ok(bare.reasons.includes(`missing_env:workspace.root:${name}`), `$${name}`);

            const braced = errorFor({ workspace: { root: '${' + name + '}/ws' } }, { env: hostile });
            assert.ok(braced.reasons.includes(`missing_env:workspace.root:${name}`), '${' + name + '}');

            const leaf = errorFor({ tracker: { kind: 'linear', provider: { leaf: '$' + name } } }, { env: hostile });
            assert.ok(leaf.reasons.includes(`missing_env:tracker.provider.leaf:${name}`), `provider $${name}`);
        }
        assert.equal(Object.isFrozen(Object.prototype), false);
        assert.equal(Object.hasOwn(Object.prototype, 'p'), false);
        assert.equal(/** @type {Record<string, unknown>} */ ({}).p, undefined);
    });

    it('never resolves a provider leaf to a non-string env value', () => {
        const hostile = /** @type {Record<string, string|undefined>} */ (
            /** @type {unknown} */ ({ NUM: 5, OBJ: { a: 1 }, FN: () => 'x' })
        );
        for (const name of ['NUM', 'OBJ', 'FN']) {
            const err = errorFor({ tracker: { kind: 'linear', provider: { leaf: '$' + name } } }, { env: hostile });
            assert.ok(err.reasons.includes(`missing_env:tracker.provider.leaf:${name}`),
                `${name} must be missing, got ${err.reasons.join(', ')}`);
        }
    });
});

describe('tracker.provider', () => {
    it('expands only exact references and keeps other leaves', () => {
        const { config } = resolveConfig({
            tracker: {
                kind: 'linear',
                provider: {
                    project_slug: '$PROJ',
                    project_alt: '${PROJ}',
                    embedded: 'x-$PROJ',
                    num: 3,
                    flag: true,
                    nothing: null,
                    nested: { leaf: '$PROJ' },
                    list: ['$PROJ', 'keep']
                }
            }
        }, { env: { PROJ: 'p1' } });
        assert.deepEqual(config.tracker.provider, {
            project_slug: 'p1',
            project_alt: 'p1',
            embedded: 'x-$PROJ',
            num: 3,
            flag: true,
            nothing: null,
            nested: { leaf: 'p1' },
            list: ['p1', 'keep']
        });
    });

    it('reports a missing variable with the array index path', () => {
        const err = errorFor({ tracker: { kind: 'linear', provider: { list: ['ok', '$NOPE'] } } });
        assert.ok(err.reasons.includes('missing_env:tracker.provider.list[1]:NOPE'));
    });

    it('rejects a programmatic cycle', () => {
        /** @type {Record<string, unknown>} */
        const provider = { nested: {} };
        /** @type {Record<string, unknown>} */ (provider.nested).self = provider;
        const err = errorFor({ tracker: { kind: 'linear', provider } });
        assert.ok(err.reasons.some((reason) => reason.startsWith('invalid_config:tracker.provider')),
            `expected a provider cycle rejection; got ${err.reasons.join(', ')}`);
    });

    it('rejects non-JSON leaves and a non-object provider', () => {
        assert.ok(errorFor({ tracker: { kind: 'linear', provider: { bad: () => 1 } } }).reasons.includes('invalid_config:tracker.provider.bad'));
        assert.ok(errorFor({ tracker: { kind: 'linear', provider: { bad: 1n } } }).reasons.includes('invalid_config:tracker.provider.bad'));
        assert.ok(errorFor({ tracker: { kind: 'linear', provider: [] } }).reasons.includes('invalid_config:tracker.provider'));
    });

    it('rejects NaN, Infinity, Date, and Map leaves', () => {
        /** @type {Array<[string, unknown]>} */
        const leaves = [['nan', NaN], ['infinity', Infinity], ['date', new Date(0)], ['map', new Map()]];
        for (const [key, value] of leaves) {
            const err = errorFor({ tracker: { kind: 'linear', provider: { [key]: value } } });
            assert.ok(err.reasons.includes(`invalid_config:tracker.provider.${key}`),
                `${key} must be rejected; got ${err.reasons.join(', ')}`);
        }
    });

    it('rejects a nested forbidden provider key', () => {
        /** @type {Record<string, unknown>} */
        const nested = JSON.parse('{"tracker":{"kind":"linear","provider":{"outer":{"__proto__":"x"}}}}');
        const err = errorFor(nested);
        assert.ok(err.reasons.includes('invalid_config:tracker.provider.outer.__proto__'),
            `got ${err.reasons.join(', ')}`);
        assert.equal(/** @type {Record<string, unknown>} */ ({}).x, undefined);
    });

    it('rejects nesting deeper than eight levels', () => {
        /** @type {Record<string, unknown>} */
        let deep = { leaf: 'x' };
        for (let depth = 0; depth < 9; depth += 1) deep = { nested: deep };
        const err = errorFor({ tracker: { kind: 'linear', provider: deep } });
        assert.ok(err.reasons.some((reason) => reason.startsWith('invalid_config:tracker.provider')));
    });
});

describe('hooks', () => {
    it('preserves scripts verbatim', () => {
        const script = 'echo "$HOME"\npnpm test -- --watch=false';
        const { config } = resolveConfig({
            hooks: { after_create: script, before_run: null, after_run: '  echo hi  ' }
        });
        assert.equal(config.hooks.afterCreate, script);
        assert.equal(config.hooks.beforeRun, null);
        assert.equal(config.hooks.afterRun, '  echo hi  ');
    });

    it('rejects an empty or non-string script', () => {
        assert.ok(errorFor({ hooks: { after_run: '' } }).reasons.includes('invalid_config:hooks.after_run'));
        assert.ok(errorFor({ hooks: { before_remove: 3 } }).reasons.includes('invalid_config:hooks.before_remove'));
    });
});

describe('engine', () => {
    it('accepts the four kinds and a trimmed model', () => {
        for (const kind of ['agentic', 'dag', 'stateMachine', 'discussion']) {
            const { config } = resolveConfig({ merci: { engine: { kind } } });
            assert.equal(config.engine.kind, kind);
        }
        const { config } = resolveConfig({ merci: { engine: { model: '  gpt-x  ' } } });
        assert.equal(config.engine.model, 'gpt-x');
    });

    it('rejects an unknown kind or an empty model', () => {
        assert.ok(errorFor({ merci: { engine: { kind: 'quantum' } } }).reasons.includes('invalid_config:engine.kind'));
        assert.ok(errorFor({ merci: { engine: { model: '' } } }).reasons.includes('invalid_config:engine.model'));
    });
});

describe('dangerous keys and unknown sections', () => {
    it('rejects dangerous keys at every depth', () => {
        /** @type {Record<string, unknown>} */
        const top = JSON.parse('{"__proto__":{"polluted":true}}');
        assert.ok(errorFor(top).reasons.includes('invalid_config:__proto__'));

        /** @type {Record<string, unknown>} */
        const nested = JSON.parse('{"tracker":{"kind":"linear","constructor":{"x":1}}}');
        assert.ok(errorFor(nested).reasons.includes('invalid_config:tracker.constructor'));

        const deep = { merci: /** @type {Record<string, unknown>} */ (JSON.parse('{"workspace":{"prototype":{}}}')) };
        assert.ok(errorFor(deep).reasons.includes('invalid_config:merci.workspace.prototype'));
        assert.equal(/** @type {Record<string, unknown>} */ ({}).polluted, undefined);
    });

    it('warns on unknown keys in each known section and ignores unknown top-level sections', () => {
        const { warnings, config } = resolveConfig({
            tracker: { kind: 'linear', nope: 1 },
            polling: { interval_ms: 1000, nope: 1 },
            workspace: { root: '/x', nope: 1 },
            agent: { nope: 1 },
            hooks: { nope: 1 },
            merci: {
                workspace: { nope: 1 },
                scheduler: { nope: 1 },
                engine: { nope: 1 },
                ignored_extension: true
            },
            custom_top_level: true,
            codex: { command: 'x' }
        });
        for (const warning of [
            'unknown_key:tracker.nope',
            'unknown_key:polling.nope',
            'unknown_key:workspace.nope',
            'unknown_key:agent.nope',
            'unknown_key:hooks.nope',
            'unknown_key:merci.workspace.nope',
            'unknown_key:merci.scheduler.nope',
            'unknown_key:merci.engine.nope',
            'unsupported_section:codex'
        ]) {
            assert.ok(warnings.includes(warning), `missing warning ${warning}; got ${warnings.join(', ')}`);
        }
        assert.equal(warnings.some((warning) => warning.includes('custom_top_level')), false);
        assert.equal(warnings.some((warning) => warning.includes('ignored_extension')), false);
        assert.equal(config.tracker.kind, 'linear');
    });

    it('aggregates errors and never puts a value in the message', () => {
        const err = errorFor({
            polling: { interval_ms: 0 },
            merci: { engine: { kind: 'quantum' } }
        });
        assert.equal(err.reasons.length, 2);
        assert.equal(err.reason, err.reasons[0]);
        assert.equal(err.reasons[0], 'invalid_config:polling.interval_ms');
        assert.equal(err.reasons[1], 'invalid_config:engine.kind');
        assert.equal(err.message, 'Workflow policy is invalid: 2 error(s)');
        assert.equal(err.message.includes('quantum'), false);
        assert.equal(err.message.includes('0'), false);
    });
});

describe('redactConfig', () => {
    it('projects provider keys and hook presence without values', () => {
        const { config } = resolveConfig({
            tracker: { kind: 'linear', provider: { secret: '$SECRET', slug: 's' } },
            hooks: { after_create: 'echo SECRET_SCRIPT', before_remove: null }
        }, { env: { SECRET: 'super-secret-value' } });

        const view = redactConfig({ config });
        assert.deepEqual(view.tracker, {
            kind: 'linear',
            provider: { redacted: true, keys: ['secret', 'slug'] },
            requiredLabels: [],
            activeStates: [],
            terminalStates: []
        });
        assert.deepEqual(view.hooks, {
            afterCreate: true,
            beforeRun: false,
            afterRun: false,
            beforeRemove: false,
            timeoutMs: 60_000
        });
        assert.equal(JSON.stringify(view).includes('super-secret-value'), false);
        assert.equal(JSON.stringify(view).includes('SECRET_SCRIPT'), false);
    });

    it('copies a populated by-state map without unfreezing the snapshot', () => {
        const { config } = resolveConfig({ agent: { max_concurrent_agents_by_state: { Review: 2 } } });
        const view = /** @type {{agent: {maxConcurrentAgentsByState: Record<string, number>}}} */ (
            /** @type {unknown} */ (redactConfig({ config }))
        );
        assert.deepEqual(view.agent.maxConcurrentAgentsByState, { review: 2 });
        assert.notEqual(view.agent.maxConcurrentAgentsByState, config.agent.maxConcurrentAgentsByState);
        assert.ok(Object.isFrozen(config.agent.maxConcurrentAgentsByState));
        view.agent.maxConcurrentAgentsByState.review = 99;
        assert.equal(config.agent.maxConcurrentAgentsByState.review, 2);
    });
});
