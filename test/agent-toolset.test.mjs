// @ts-check


/**
 * @file Agent toolset resolution and the two adapters: groups, selectors,
 * external prefixing, collisions, deny-wins, and what reaches a session or a
 * profile.
 * @version 0.12.0
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMcpTools } from '../lib/tools/index.mjs';
import { after, describe, it } from 'node:test';

import {
    AGENT_TOOL_GROUPS as catalogGroups,
    applyAgentSpec,
    createAgentToolbox,
    parseSelector,
    prefixExternalTool,
    resolveToolset,
    toTaskAgent
} from '../lib/agentic/agents/index.mjs';

/** @type {string[]} */
const roots = [];
after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** @returns {string} */
function workspaceRoot() {
    const dir = mkdtempSync(join(tmpdir(), 'merci-agent-toolset-'));
    roots.push(dir);
    return dir;
}

/** @param {string} path @returns {Object} */
function workspace(path) {
    return { path, root: path, key: 'k' };
}

/** @param {string} name @param {string} [description] */
function tool(name, description = '') {
    return { name, description, parameters: { type: 'object', properties: {} }, execute: async () => '' };
}

function spec() {
    return {
        name: 'reviewer',
        description: 'Reviews things.',
        instructions: 'Review.',
        model: { kind: /** @type {const} */ ('id'), value: 'gpt-x' },
        tools: { use: [], allow: [], deny: [], mode: 'default', definitions: [] },
        limits: {}
    };
}

/** A spec with the given `tools` block. @param {Record<string, unknown>} tools */
function withTools(tools) {
    return { ...spec(), tools: { use: [], allow: [], deny: [], mode: 'default', definitions: [], ...tools } };
}

/** @param {string} selector_ */
function selector(selector_) {
    return /** @type {any} */ (parseSelector({ selector: selector_ }));
}

describe('selector grammar', () => {
    it('splits a server and a tool pattern', () => {
        assert.deepEqual(selector('mcp:github/issues_*'), { source: 'mcp', owner: 'github', pattern: 'issues_*' });
    });

    it('treats a bare server as every tool of that server', () => {
        assert.deepEqual(selector('mcp:github'), { source: 'mcp', owner: 'github', pattern: '*' });
    });

    it('keeps native selectors ownerless', () => {
        assert.deepEqual(selector('native:read'), { source: 'native', owner: null, pattern: 'read' });
    });

    it('rejects an unknown namespace', () => {
        assert.equal(parseSelector({ selector: 'magic:read' }), null);
    });
});

describe('external names', () => {
    it('prefixes and keeps dots out of the wire name', () => {
        assert.equal(prefixExternalTool({ source: 'mcp', owner: 'github', name: 'issues.list' }), 'mcp__github__issues_list');
    });

    it('keeps two servers apart', () => {
        const a = prefixExternalTool({ source: 'mcp', owner: 'one', name: 'search' });
        const b = prefixExternalTool({ source: 'mcp', owner: 'two', name: 'search' });
        assert.notEqual(a, b);
    });
});

describe('groups', () => {
    it('materializes the files group from a workspace', () => {
        const root = workspaceRoot();
        const resolved = resolveToolset({
            spec: withTools({ use: ['files'] }),
            toolbox: createAgentToolbox({ workspace: workspace(root) })
        });
        assert.deepEqual(resolved.names.sort(), ['glob', 'grep', 'read']);
        assert.deepEqual(resolved.actions, []);
    });

    it('every catalog group resolves to exactly its declared tools', () => {
        const root = workspaceRoot();
        const toolbox = createAgentToolbox({
            workspace: workspace(root),
            approval: () => true,
            todos: { store: new Map() },
            memory: { provider: {} },
            knowledge: { dir: root },
            skills: [tool('skill_tool')],
            search: { options: {} },
            scrape: { options: {} },
            browser: { options: {} },
            stateMachine: { graph: {} },
            delegation: { agents: [{ name: 'worker' }] }
        });
        for (const [name, entry] of Object.entries(catalogGroups)) {
            const resolved = resolveToolset({ spec: withTools({ use: [name] }), toolbox });
            const expected = name === 'skills' ? [...entry.tools, 'skill_tool'] : [...entry.tools];
            assert.deepEqual(resolved.names.sort(), expected.sort(), `group ${name}`);
        }
    });

    it('names the missing toolbox key', () => {
        assert.throws(
            () => resolveToolset({ spec: withTools({ use: ['files'] }), toolbox: createAgentToolbox({}) }),
            (error) => /** @type {any} */ (error).reason === 'agent_missing_group'
                && /workspace/.test(/** @type {any} */ (error).message)
        );
    });

    it('refuses a component group in a profile', () => {
        assert.throws(
            () => resolveToolset({
                spec: withTools({ use: ['todos'] }),
                toolbox: createAgentToolbox({ todos: { store: new Map() } }),
                mode: 'profile'
            }),
            (error) => /** @type {any} */ (error).reason === 'agent_profile_unsupported'
        );
    });
});

describe('selectors', () => {
    it('adds an MCP tool under its namespaced name', () => {
        const resolved = resolveToolset({
            spec: withTools({ allow: ['mcp:github/issues_*'] }),
            toolbox: createAgentToolbox({
                mcp: { github: [tool('issues.list'), tool('issues.get'), tool('repos.list')] },
                options: { strictDynamic: true }
            })
        });
        assert.deepEqual(resolved.names.sort(), ['mcp__github__issues_get', 'mcp__github__issues_list']);
        assert.deepEqual(resolved.aliases['mcp__github__issues_list'], { source: 'mcp', owner: 'github', original: 'issues.list' });
    });

    it('gates a write-capable MCP tool even when the client did not', () => {
        const resolved = resolveToolset({
            spec: withTools({ allow: ['mcp:github/issues_*'] }),
            toolbox: createAgentToolbox({
                mcp: { github: [tool('issues.close')] },
                options: { strictDynamic: true }
            })
        });
        assert.equal(/** @type {any} */ (resolved.tools[0]).requiresApproval, true);
    });

    it('does not trust a remote read-only hint by default', () => {
        const resolved = resolveToolset({
            spec: withTools({ allow: ['mcp:github/issues_*'] }),
            toolbox: createAgentToolbox({
                mcp: { github: [{ ...tool('issues.list'), idempotent: true }] },
                options: { strictDynamic: true }
            })
        });
        assert.equal(/** @type {any} */ (resolved.tools[0]).requiresApproval, true);
    });

    it('honours a read-only hint only when the host trusts it', () => {
        const resolved = resolveToolset({
            spec: withTools({ allow: ['mcp:github/issues_*'] }),
            toolbox: createAgentToolbox({
                mcp: { github: [{ ...tool('issues.list'), idempotent: true }] },
                options: { strictDynamic: true, trustReadOnlyHints: true }
            })
        });
        assert.equal(/** @type {any} */ (resolved.tools[0]).requiresApproval, undefined);
    });

    it('gates an ACP tool at the boundary', () => {
        const resolved = resolveToolset({
            spec: withTools({ allow: ['acp:editor/*'] }),
            toolbox: createAgentToolbox({ acp: { editor: [tool('format')] }, options: { strictDynamic: true } })
        });
        assert.equal(/** @type {any} */ (resolved.tools[0]).requiresApproval, true);
    });

    it('matches a dotted remote name through its sanitized form', () => {
        const resolved = resolveToolset({
            spec: withTools({ allow: ['mcp:github/issues.*'] }),
            toolbox: createAgentToolbox({ mcp: { github: [tool('issues.list')] }, options: { strictDynamic: true } })
        });
        assert.deepEqual(resolved.names, ['mcp__github__issues_list']);
    });

    it('adds a host tool by name', () => {
        const resolved = resolveToolset({
            spec: withTools({ allow: ['host:write_file'] }),
            toolbox: createAgentToolbox({ tools: [tool('write_file')] })
        });
        assert.deepEqual(resolved.names, ['write_file']);
    });

    it('adds the owning group for a native tool', () => {
        const root = workspaceRoot();
        const resolved = resolveToolset({
            spec: withTools({ allow: ['native:read'] }),
            toolbox: createAgentToolbox({ workspace: workspace(root) })
        });
        assert.deepEqual(resolved.names.sort(), ['glob', 'grep', 'read']);
    });

    it('errors on an unknown static selector', () => {
        assert.throws(
            () => resolveToolset({ spec: withTools({ allow: ['host:nope'] }), toolbox: createAgentToolbox({}) }),
            (error) => /** @type {any} */ (error).reason === 'agent_invalid_field'
        );
    });

    it('warns (does not throw) for an unenumerated dynamic source', () => {
        const resolved = resolveToolset({
            spec: withTools({ allow: ['mcp:github/issues_*'] }),
            toolbox: createAgentToolbox({ mcp: { github: [] } })
        });
        assert.deepEqual(resolved.names, []);
        assert.equal(resolved.warnings.length, 1);
        assert.match(resolved.warnings[0], /not enumerated/);
    });

    it('drops component wiring when a deny-all leaves nothing callable', () => {
        const resolved = resolveToolset({
            spec: withTools({ use: ['todos'], deny: ['*'] }),
            toolbox: createAgentToolbox({ todos: { store: new Map() } })
        });
        assert.deepEqual(resolved.names, []);
        assert.deepEqual(resolved.actions, [], 'no component is wired for a tool the model cannot call');
    });

    it('gates bypassPermissions in the public resolver', () => {
        assert.throws(
            () => resolveToolset({
                spec: withTools({ mode: 'bypassPermissions' }),
                toolbox: createAgentToolbox({})
            }),
            (error) => /** @type {any} */ (error).reason === 'agent_dangerous_mode'
        );
        assert.doesNotThrow(() => resolveToolset({
            spec: withTools({ mode: 'bypassPermissions' }),
            toolbox: createAgentToolbox({}),
            allowDangerous: true
        }));
    });

    it('gates requiresApproval: false in the public resolver', () => {
        const definition = {
            name: 'quiet', description: '', parameters: { type: 'object', properties: {} },
            scriptPath: '/tmp/quiet.mjs', interpreter: 'node', timeoutMs: 1000, requiresApproval: false, env: [], baseDir: '/tmp'
        };
        assert.throws(
            () => resolveToolset({
                spec: withTools({ definitions: [definition] }),
                toolbox: createAgentToolbox({})
            }),
            (error) => /** @type {any} */ (error).reason === 'agent_dangerous_mode'
        );
        assert.doesNotThrow(() => resolveToolset({
            spec: withTools({ definitions: [definition] }),
            toolbox: createAgentToolbox({}),
            allowDangerous: true
        }));
    });

    it('a bare deny * removes every granted name', () => {
        const root = workspaceRoot();
        const resolved = resolveToolset({
            spec: withTools({ use: ['files'], deny: ['*'] }),
            toolbox: createAgentToolbox({ workspace: workspace(root) })
        });
        assert.deepEqual(resolved.names, []);
        assert.deepEqual(resolved.denied.sort(), ['glob', 'grep', 'read']);
    });

    it('enforces the dangerous gate in the resolver, not only the loader', () => {
        for (const selector of ['native:*', 'host:*', 'skill:*', 'script:*', 'mcp:*', 'acp:*', 'a2a:*']) {
            assert.throws(
                () => resolveToolset({
                    spec: withTools({ allow: [selector] }),
                    toolbox: createAgentToolbox({ tools: [tool('write_file')] })
                }),
                (error) => /** @type {any} */ (error).reason === 'agent_dangerous_mode',
                selector
            );
        }
    });

    it('rejects a deny pattern that matches nothing static', () => {
        assert.throws(
            () => resolveToolset({
                spec: withTools({ use: ['files'], deny: ['native:reed'] }),
                toolbox: createAgentToolbox({ workspace: workspace(workspaceRoot()) })
            }),
            (error) => /** @type {any} */ (error).reason === 'agent_invalid_field'
                && /deny/.test(/** @type {any} */ (error).message)
        );
    });

    it('rejects a deny typo over an enumerated remote source', () => {
        assert.throws(
            () => resolveToolset({
                spec: withTools({ allow: ['mcp:github/issues_*'], deny: ['mcp:github/issue_delete'] }),
                toolbox: createAgentToolbox({
                    mcp: { github: [tool('issues_list'), tool('issues_delete')] },
                    options: { strictDynamic: true }
                })
            }),
            (error) => /** @type {any} */ (error).reason === 'agent_invalid_field'
        );
    });

    it('expands mcp:* over the registered servers', () => {
        const resolved = resolveToolset({
            spec: withTools({ allow: ['mcp:*'] }),
            toolbox: createAgentToolbox({
                mcp: { one: [tool('search')], two: [tool('search')] },
                options: { strictDynamic: true }
            }),
            allowDangerous: true
        });
        assert.deepEqual(resolved.names.sort(), ['mcp__one__search', 'mcp__two__search']);
    });

    it('errors on an unenumerated dynamic source in strict mode', () => {
        assert.throws(
            () => resolveToolset({
                spec: withTools({ allow: ['mcp:github/issues_*'] }),
                toolbox: createAgentToolbox({ mcp: { github: [] }, options: { strictDynamic: true } })
            }),
            (error) => /** @type {any} */ (error).reason === 'agent_invalid_field'
        );
    });

    it('deny wins over a tool the same file allows', () => {
        const resolved = resolveToolset({
            spec: withTools({ allow: ['mcp:github/issues_*'], deny: ['mcp:github/issues_get'] }),
            toolbox: createAgentToolbox({
                mcp: { github: [tool('issues.list'), tool('issues.get')] },
                options: { strictDynamic: true }
            })
        });
        assert.deepEqual(resolved.names, ['mcp__github__issues_list']);
        assert.deepEqual(resolved.denied, ['mcp__github__issues_get']);
    });

    it('rejects a host tool that shadows a native name', () => {
        const root = workspaceRoot();
        assert.throws(
            () => resolveToolset({
                spec: withTools({ use: ['files'], allow: ['host:read'] }),
                toolbox: createAgentToolbox({ workspace: workspace(root), tools: [tool('read')] })
            }),
            (error) => /** @type {any} */ (error).reason === 'agent_duplicate_tool'
        );
    });
});

describe('remote name preservation', () => {
    it('executes an MCP tool under its original protocol name', async () => {
        /** @type {string[]} */
        const seen = [];
        const client = {
            connect: async () => {},
            getTools: async () => [{ name: 'issues.list', inputSchema: { type: 'object' } }],
            executeTool: async (/** @type {{name: string}} */ arg0) => {
                seen.push(arg0.name);
                return { content: [{ type: 'text', text: 'ok' }] };
            }
        };
        const tools = await loadMcpTools({ mcpClient: /** @type {any} */ (client) });
        const resolved = resolveToolset({
            spec: withTools({ allow: ['mcp:github/issues_*'] }),
            toolbox: createAgentToolbox({ mcp: { github: tools }, options: { strictDynamic: true } })
        });
        assert.equal(/** @type {any} */ (resolved.tools[0]).name, 'mcp__github__issues_list');
        await /** @type {any} */ (resolved.tools[0]).execute({ args: {} });
        assert.deepEqual(seen, ['issues.list']);
    });
});

describe('script definitions', () => {
    it('builds the tool and never marks it idempotent', () => {
        const resolved = resolveToolset({
            spec: withTools({
                definitions: [{
                    name: 'lint_changed',
                    description: 'Lints.',
                    parameters: { type: 'object', properties: {} },
                    scriptPath: '/tmp/lint.mjs',
                    interpreter: 'node',
                    timeoutMs: 1000,
                    requiresApproval: true,
                    env: [],
                    baseDir: '/tmp'
                }]
            }),
            toolbox: createAgentToolbox({})
        });
        const built = /** @type {any} */ (resolved.tools[0]);
        assert.equal(built.name, 'lint_changed');
        assert.equal(built.runsCode, true);
        assert.equal(built.idempotent, false);
        assert.equal(built.requiresApproval, true);
    });

    /** @param {string} name */
    const definitionOf = (name) => ({
        name, description: '', parameters: { type: 'object', properties: {} },
        scriptPath: `/tmp/${name}.mjs`, interpreter: 'node', timeoutMs: 1000, requiresApproval: true, env: [], baseDir: '/tmp'
    });

    it('a script selector narrows the declared set', () => {
        const resolved = resolveToolset({
            spec: withTools({ allow: ['script:one'], definitions: [definitionOf('one'), definitionOf('two')] }),
            toolbox: createAgentToolbox({})
        });
        assert.deepEqual(resolved.names, ['one']);
    });

    it('enforces the script timeout', async () => {
        const scriptPath = fileURLToPath(new URL('./fixtures/agents/scripts/sleep.mjs', import.meta.url));
        const resolved = resolveToolset({
            spec: withTools({
                definitions: [{
                    name: 'sleep', description: '', parameters: { type: 'object', properties: {} },
                    scriptPath, interpreter: 'node', timeoutMs: 10, requiresApproval: true, env: [], baseDir: '/tmp'
                }]
            }),
            toolbox: createAgentToolbox({})
        });
        await assert.rejects(() => /** @type {any} */ (resolved.tools[0]).execute({ args: {} }));
    });

    it('a script selector that matches nothing is an error', () => {
        assert.throws(
            () => resolveToolset({
                spec: withTools({ allow: ['script:lnt_changed'], definitions: [definitionOf('lint_changed')] }),
                toolbox: createAgentToolbox({})
            }),
            (error) => /** @type {any} */ (error).reason === 'agent_invalid_field'
        );
    });
});

/** A session double that records the fluent calls. @param {Array<string>} calls */
function fakeSession(calls) {
    const session = {
        _permissionRules: /** @type {{allow: string[], deny: string[], mode: string}} */ ({ allow: [], deny: [], mode: 'default' }),
        withSystemMessage(/** @type {string} */ value) { calls.push(`system:${value}`); return session; },
        withPermissions(/** @type {{allow?: string[], deny?: string[], mode?: string}} */ rules) {
            calls.push(`permissions:${(rules.allow ?? []).join(',')}|${(rules.deny ?? []).join(',')}|${rules.mode}`);
            return session;
        },
        withToolAllowlist(/** @type {{patterns: string[]}} */ arg0) {
            calls.push(`allowlist:${arg0.patterns.join(',')}`);
            return session;
        },
        withAdditionalTools(/** @type {{tools: Array<Object>}} */ arg0) {
            calls.push(`tools:${arg0.tools.map((entry) => /** @type {any} */ (entry).name).join(',')}`);
            return session;
        },
        withTodos() { calls.push('todos'); return session; }
    };
    return session;
}

describe('applyAgentSpec', () => {
    it('sets the prompt, the exact allow list and appends the tools', () => {
        const root = workspaceRoot();
        /** @type {string[]} */
        const calls = [];
        applyAgentSpec({
            session: fakeSession(calls),
            spec: withTools({ use: ['files'] }),
            toolbox: createAgentToolbox({ workspace: workspace(root) })
        });
        assert.deepEqual(calls[0], 'system:Review.');
        assert.deepEqual(calls[2].split(':')[1].split(',').sort(), ['glob', 'grep', 'read']);
        assert.match(calls[3], /^tools:/);
    });

    it('denies everything when the file grants no tools', () => {
        /** @type {string[]} */
        const calls = [];
        applyAgentSpec({ session: fakeSession(calls), spec: withTools({}), toolbox: createAgentToolbox({}) });
        assert.equal(calls[1], 'permissions:||default');
        assert.equal(calls[2], 'allowlist:__none__');
        assert.equal(calls.length, 3);
    });

    it('keeps a host deny list and never widens the host mode', () => {
        const root = workspaceRoot();
        /** @type {string[]} */
        const calls = [];
        const session = fakeSession(calls);
        session._permissionRules = { allow: [], deny: ['execute_shell_command'], mode: 'default' };
        applyAgentSpec({
            session,
            spec: withTools({ use: ['files', 'shell'] }),
            toolbox: createAgentToolbox({ workspace: workspace(root), approval: () => true })
        });
        const [, denyPart = '', modePart = ''] = calls[1].split('|');
        assert.match(denyPart, /execute_shell_command/);
        assert.equal(modePart, 'default');
        assert.match(calls[2], /^allowlist:.*execute_shell_command/);
    });

    it('runs a component action before appending tools', () => {
        /** @type {string[]} */
        const calls = [];
        applyAgentSpec({
            session: fakeSession(calls),
            spec: withTools({ use: ['todos'] }),
            toolbox: createAgentToolbox({ todos: { store: new Map() } })
        });
        assert.ok(calls.includes('todos'));
        assert.match(calls[2], /^allowlist:load_todos,manage_todos$/);
    });
});

describe('toTaskAgent', () => {
    it('builds the profile with resolved tools and limits', () => {
        const root = workspaceRoot();
        const profile = toTaskAgent({
            spec: { ...withTools({ use: ['files'] }), limits: { maxIterations: 3 } },
            toolbox: createAgentToolbox({ workspace: workspace(root) }),
            model: 'gpt-x'
        });
        assert.equal(profile.name, 'reviewer');
        assert.equal(profile.model, 'gpt-x');
        assert.equal(profile.maxIterations, 3);
        assert.deepEqual(/** @type {string[]} */ (profile.toolNames).sort(), ['glob', 'grep', 'read']);
        assert.equal(/** @type {Array<Object>} */ (profile.tools).length, 3);
    });

    it('resolves a role shorthand when no model is passed', () => {
        const previous = process.env.PROVIDER;
        process.env.PROVIDER = 'openai';
        try {
            const profile = toTaskAgent({
                spec: withTools({}),
                toolbox: createAgentToolbox({})
            });
            assert.equal(typeof profile.model, 'string');
            assert.ok(String(profile.model).length > 0);
        } finally {
            if (previous === undefined) delete process.env.PROVIDER;
            else process.env.PROVIDER = previous;
        }
    });

    it('refuses a component group', () => {
        assert.throws(
            () => toTaskAgent({
                spec: withTools({ use: ['todos'] }),
                toolbox: createAgentToolbox({ todos: { store: new Map() } }),
                model: 'gpt-x'
            }),
            (error) => /** @type {any} */ (error).reason === 'agent_profile_unsupported'
        );
    });
});
