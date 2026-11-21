// @ts-check

/**
 * @file Agent definition loading: valid specs, the rejection matrix, and
 * directory aggregation.
 * @version 0.12.0
 *
 * @description
 * Pins the loader contract: a valid file becomes a deep-frozen spec with a
 * byte hash and resolved scripts; every bad field is collected into one
 * `AgentFileError` with a stable reason and (where known) a line and column;
 * and a directory reports every broken file at once.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAgentDirectory, loadAgentFile } from '../lib/agentic/agents/load.mjs';
import {
    AGENT_API_VERSION,
    AGENT_FILE_REASONS,
    AGENT_KIND,
    normalizeAgentSpec
} from '../lib/agentic/agents/spec.mjs';
import { AgentFileError } from '../lib/core/errors.mjs';
import { parseYamlMapping } from '../lib/support/yaml-mapping.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/agents', import.meta.url));

/** @type {string[]} */
const tempDirs = [];

after(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * @param {...string} parts
 * @returns {string}
 */
function fixture(...parts) {
    return join(FIXTURES, ...parts);
}

/**
 * @returns {Promise<string>} An absolute temporary directory removed after the suite.
 */
async function tempDir() {
    const directory = await mkdtemp(join(tmpdir(), 'merci-agent-files-'));
    tempDirs.push(directory);
    return directory;
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<AgentFileError>}
 */
async function agentFileError(promise) {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof AgentFileError, `expected AgentFileError, got ${String(error)}`);
        return error;
    }
    assert.fail('expected the call to throw an AgentFileError');
}


describe('agent file spec', () => {
    it('pins the stable reason list', () => {
        assert.ok(Object.isFrozen(AGENT_FILE_REASONS));
        assert.deepEqual([...AGENT_FILE_REASONS], [
            'agent_read_error',
            'agent_too_large',
            'agent_parse_error',
            'agent_not_a_map',
            'agent_unknown_key',
            'agent_invalid_field',
            'agent_unsupported_api_version',
            'agent_unsupported_kind',
            'agent_name_mismatch',
            'agent_duplicate_name',
            'agent_missing_group',
            'agent_profile_unsupported',
            'agent_unknown_model',
            'agent_dangerous_mode',
            'agent_symlink',
            'agent_script_outside_root',
            'agent_script_too_large',
            'agent_script_unsupported',
            'agent_duplicate_tool'
        ]);
        assert.equal(AGENT_API_VERSION, 'merci.dev/v1alpha1');
        assert.equal(AGENT_KIND, 'Agent');
    });

    it('loads a valid file into a deep-frozen spec', async () => {
        const path = fixture('reviewer.agent.yaml');
        const spec = await loadAgentFile({ path });

        assert.equal(spec.apiVersion, AGENT_API_VERSION);
        assert.equal(spec.kind, AGENT_KIND);
        assert.equal(spec.name, 'reviewer');
        assert.equal(spec.description, 'Reviews diffs for correctness and missing tests.');
        assert.deepEqual(spec.model, { kind: 'role', value: 'default' });
        assert.match(spec.instructions, /review changes/);
        assert.deepEqual(spec.tools.use, ['files', 'search', 'scrape', 'todos']);
        assert.deepEqual(spec.tools.allow, ['mcp:github/issues_*']);
        assert.deepEqual(spec.tools.deny, ['native:execute_shell_command']);
        assert.equal(spec.tools.mode, 'default');
        // The author's 8 is kept: the format clamps only at its own sanity ceiling,
        // and the runtime applies its configured maximum when it runs the turn.
        assert.deepEqual(spec.limits, { maxIterations: 8, maxDepth: 0, timeoutMs: 120_000, maxElapsedMs: 300_000 });

        const definition = spec.tools.definitions[0];
        assert.equal(definition.name, 'echo_args');
        assert.equal(definition.script, 'scripts/echo-args.mjs');
        assert.ok(definition.scriptPath.endsWith('scripts/echo-args.mjs'));
        assert.equal(definition.interpreter, 'node');
        assert.equal(definition.scriptHash, createHash('sha256').update(await readFile(definition.scriptPath)).digest('hex'));
        assert.ok(definition.size > 0);
        assert.equal(definition.timeoutMs, 5_000);
        assert.equal(definition.requiresApproval, true);
        assert.deepEqual(definition.env, ['CI']);
        assert.equal(definition.baseDir, fixture());

        assert.equal(spec.source.path, path);
        assert.equal(spec.source.hash, createHash('sha256').update(await readFile(path)).digest('hex'));

        assert.ok(Object.isFrozen(spec));
        assert.ok(Object.isFrozen(spec.tools));
        assert.ok(Object.isFrozen(spec.tools.use));
        assert.ok(Object.isFrozen(spec.tools.definitions));
        assert.ok(Object.isFrozen(definition));
        assert.ok(Object.isFrozen(definition.env));
        assert.ok(Object.isFrozen(spec.limits));
        assert.ok(Object.isFrozen(spec.source));
        assert.throws(() => {
            /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (spec)).name = 'other';
        }, TypeError);
    });

    it('records positions for dotted paths', async () => {
        const text = await readFile(fixture('reviewer.agent.yaml'), 'utf8');
        const parsed = parseYamlMapping({ text });
        assert.ok(parsed.ok);
        assert.deepEqual(parsed.positions.get('metadata.name'), { line: 5, column: 3 });
        assert.deepEqual(parsed.positions.get('spec.tools.definitions.0.name'), { line: 20, column: 9 });
        assert.deepEqual(parsed.positions.get('spec.tools.definitions.0.script'), { line: 22, column: 9 });
    });

    it('normalizes a value directly with supplied positions', async () => {
        const text = await readFile(fixture('invalid', 'unknown-root.agent.yaml'), 'utf8');
        const parsed = parseYamlMapping({ text });
        assert.ok(parsed.ok);
        const error = await agentFileError(normalizeAgentSpec({
            value: parsed.value,
            path: fixture('invalid', 'unknown-root.agent.yaml'),
            positions: parsed.positions,
            baseDir: fixture('invalid'),
            root: fixture('invalid')
        }));
        assert.equal(error.reason, 'agent_unknown_key');
        assert.equal(error.field, 'bogus');
        assert.equal(error.line, 6);
        assert.equal(error.column, 1);
    });
});


describe('agent file rejection matrix', () => {
    const unknownKeys = [
        { file: 'unknown-root.agent.yaml', field: 'bogus', line: 6, column: 1 },
        { file: 'unknown-tools.agent.yaml', field: 'spec.tools.bogus', line: 10, column: 5 },
        { file: 'unknown-definition.agent.yaml', field: 'spec.tools.definitions.0.bogus', line: 13, column: 9 }
    ];

    for (const { file, field, line, column } of unknownKeys) {
        it(`rejects an unknown key in ${file}`, async () => {
            const error = await agentFileError(loadAgentFile({ path: fixture('invalid', file) }));
            assert.equal(error.reason, 'agent_unknown_key');
            assert.deepEqual(error.reasons, ['agent_unknown_key']);
            assert.equal(error.field, field);
            assert.equal(error.line, line);
            assert.equal(error.column, column);
        });
    }

    it('rejects a prototype key without polluting anything', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'proto.agent.yaml') }));
        assert.equal(error.reason, 'agent_unknown_key');
        assert.equal(error.field, '__proto__');
        assert.equal(/** @type {Record<string, unknown>} */ ({}).polluted, undefined);
    });

    it('rejects an unsupported apiVersion', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'bad-version.agent.yaml') }));
        assert.equal(error.reason, 'agent_unsupported_api_version');
        assert.equal(error.field, 'apiVersion');
    });

    it('rejects an unsupported kind', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'bad-kind.agent.yaml') }));
        assert.equal(error.reason, 'agent_unsupported_kind');
        assert.equal(error.field, 'kind');
    });

    it('rejects a name that differs from the file stem', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'name-mismatch.agent.yaml') }));
        assert.equal(error.reason, 'agent_name_mismatch');
        assert.equal(error.field, 'metadata.name');
    });

    it('collects a missing description and missing instructions together', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'no-description.agent.yaml') }));
        assert.deepEqual(error.reasons, ['agent_invalid_field', 'agent_invalid_field']);
        assert.equal(error.field, 'metadata.description');
    });

    it('rejects a provider-qualified model id', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'bad-model.agent.yaml') }));
        assert.equal(error.reason, 'agent_unknown_model');
        assert.equal(error.field, 'spec.model');
    });

    it('rejects an unknown group and names the valid ones', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'unknown-group.agent.yaml') }));
        assert.equal(error.reason, 'agent_invalid_field');
        assert.equal(error.field, 'spec.tools.use.0');
        assert.match(error.message, /Valid groups: .*files/);
    });

    it('refuses a merge key inside a tool parameter schema', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'merge-parameters.agent.yaml') }));
        assert.equal(error.reason, 'agent_unknown_key');
        assert.ok(error.issues.some((issue) => String(issue.field).includes('parameters.<<')), JSON.stringify(error.issues));
    });

    it('reports every unknown key, not only the first', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'two-unknown.agent.yaml') }));
        assert.equal(error.reason, 'agent_unknown_key');
        const fields = error.issues.map((issue) => issue.field);
        assert.ok(fields.includes('spec.bogus1'), `fields: ${fields.join(',')}`);
        assert.ok(fields.includes('spec.tools.bogus2'), `fields: ${fields.join(',')}`);
    });

    it('refuses an alias bomb at parse time', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'alias-bomb.agent.yaml') }));
        assert.equal(error.reason, 'agent_parse_error');
    });

    it('accepts a deny-all without allowDangerous and grants nothing', async () => {
        const spec = await loadAgentFile({ path: fixture('deny-star.agent.yaml') });
        assert.deepEqual(spec.tools.deny, ['*']);
    });

    it('requires allowDangerous for a bare wildcard', async () => {
        const denied = await agentFileError(loadAgentFile({ path: fixture('invalid', 'bare-star.agent.yaml') }));
        assert.equal(denied.reason, 'agent_dangerous_mode');
        assert.equal(denied.field, 'spec.tools.allow');

        const allowed = await loadAgentFile({ path: fixture('invalid', 'bare-star.agent.yaml'), allowDangerous: true });
        assert.deepEqual(allowed.tools.allow, ['*']);
    });

    it('requires allowDangerous for every MCP server at once', async () => {
        const denied = await agentFileError(loadAgentFile({ path: fixture('invalid', 'mcp-star.agent.yaml') }));
        assert.equal(denied.reason, 'agent_dangerous_mode');
        assert.equal(denied.field, 'spec.tools.allow');

        const allowed = await loadAgentFile({ path: fixture('invalid', 'mcp-star.agent.yaml'), allowDangerous: true });
        assert.deepEqual(allowed.tools.allow, ['mcp:*']);
    });

    it('requires allowDangerous for bypassPermissions', async () => {
        const denied = await agentFileError(loadAgentFile({ path: fixture('invalid', 'bypass.agent.yaml') }));
        assert.equal(denied.reason, 'agent_dangerous_mode');
        assert.equal(denied.field, 'spec.tools.mode');

        const allowed = await loadAgentFile({ path: fixture('invalid', 'bypass.agent.yaml'), allowDangerous: true });
        assert.equal(allowed.tools.mode, 'bypassPermissions');
    });

    it('requires allowDangerous for requiresApproval: false', async () => {
        const denied = await agentFileError(loadAgentFile({ path: fixture('invalid', 'approval-off.agent.yaml') }));
        assert.equal(denied.reason, 'agent_dangerous_mode');
        assert.equal(denied.field, 'spec.tools.definitions.0.requiresApproval');

        const allowed = await loadAgentFile({ path: fixture('invalid', 'approval-off.agent.yaml'), allowDangerous: true });
        assert.equal(allowed.tools.definitions[0].requiresApproval, false);
    });

    it('rejects a duplicate script tool name', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'dup-tool.agent.yaml') }));
        assert.equal(error.reason, 'agent_duplicate_tool');
        assert.equal(error.field, 'spec.tools.definitions.1.name');
    });

    it('rejects an unsupported script extension', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'unknown-extension.agent.yaml') }));
        assert.equal(error.reason, 'agent_script_unsupported');
        assert.equal(error.field, 'spec.tools.definitions.0.script');
    });

    it('rejects a script above the definition file', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'outside-root.agent.yaml') }));
        assert.equal(error.reason, 'agent_script_outside_root');
        assert.equal(error.field, 'spec.tools.definitions.0.script');
    });

    it('rejects a script that is a symlink', async () => {
        const directory = await tempDir();
        await writeFile(join(directory, 'real.mjs'), 'process.stdout.write("ok");');
        await symlink(join(directory, 'real.mjs'), join(directory, 'linked.mjs'));
        const definitionPath = join(directory, 'linked.agent.yaml');
        await writeFile(definitionPath, [
            'apiVersion: merci.dev/v1alpha1',
            'kind: Agent',
            'metadata:',
            '  name: linked',
            '  description: A definition whose script is a symlink.',
            'spec:',
            '  instructions: Do nothing.',
            '  tools:',
            '    definitions:',
            '      - name: linked',
            '        description: Runs through a symlink.',
            '        script: linked.mjs',
            '        parameters:',
            '          type: object'
        ].join('\n'));

        const error = await agentFileError(loadAgentFile({ path: definitionPath }));
        assert.equal(error.reason, 'agent_symlink');
        assert.equal(error.field, 'spec.tools.definitions.0.script');
    });

    it('rejects an oversized script', async () => {
        const directory = await tempDir();
        await writeFile(join(directory, 'big.mjs'), 'a'.repeat(1_025));
        const definitionPath = join(directory, 'big.agent.yaml');
        await writeFile(definitionPath, [
            'apiVersion: merci.dev/v1alpha1',
            'kind: Agent',
            'metadata:',
            '  name: big',
            '  description: A definition with an oversized script.',
            'spec:',
            '  instructions: Do nothing.',
            '  tools:',
            '    definitions:',
            '      - name: big',
            '        description: Too many bytes.',
            '        script: big.mjs',
            '        parameters:',
            '          type: object'
        ].join('\n'));

        const previous = process.env.MERCI_LIMIT_AGENT_SCRIPT_MAX_BYTES;
        process.env.MERCI_LIMIT_AGENT_SCRIPT_MAX_BYTES = '1024';
        try {
            const error = await agentFileError(loadAgentFile({ path: definitionPath }));
            assert.equal(error.reason, 'agent_script_too_large');
            assert.equal(error.field, 'spec.tools.definitions.0.script');
        } finally {
            if (previous === undefined) delete process.env.MERCI_LIMIT_AGENT_SCRIPT_MAX_BYTES;
            else process.env.MERCI_LIMIT_AGENT_SCRIPT_MAX_BYTES = previous;
        }
    });

    it('rejects env written as a map', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'env-map.agent.yaml') }));
        assert.equal(error.reason, 'agent_invalid_field');
        assert.equal(error.field, 'spec.tools.definitions.0.env');
    });

    it('rejects a negative limit', async () => {
        const error = await agentFileError(loadAgentFile({ path: fixture('invalid', 'negative-limit.agent.yaml') }));
        assert.equal(error.reason, 'agent_invalid_field');
        assert.equal(error.field, 'spec.limits.maxIterations');
    });

    it('rejects an oversized definition file', async () => {
        const directory = await tempDir();
        const definitionPath = join(directory, 'huge.agent.yaml');
        await writeFile(definitionPath, 'a'.repeat(1_048_577));

        const error = await agentFileError(loadAgentFile({ path: definitionPath }));
        assert.equal(error.reason, 'agent_too_large');
    });

    it('rejects a symlinked definition file', async () => {
        const directory = await tempDir();
        const real = join(directory, 'real.agent.yaml');
        await writeFile(real, 'apiVersion: merci.dev/v1alpha1\nkind: Agent\n');
        const link = join(directory, 'link.agent.yaml');
        await symlink(real, link);

        const error = await agentFileError(loadAgentFile({ path: link }));
        assert.equal(error.reason, 'agent_symlink');
    });
});


describe('agent directory', () => {
    it('loads every regular file as a frozen spec', async () => {
        const specs = await loadAgentDirectory({ directory: fixture('dir-valid') });
        assert.ok(Object.isFrozen(specs));
        assert.deepEqual(specs.map((spec) => spec.name), ['alpha', 'beta']);
        assert.ok(specs.every((spec) => Object.isFrozen(spec)));
        assert.deepEqual(specs[1].model, { kind: 'role', value: 'tool' });
        assert.equal(specs[0].source.path, fixture('dir-valid', 'alpha.agent.yaml'));
        assert.equal(specs[0].tools.definitions.length, 0);
    });

    it('reports a duplicate declared name', async () => {
        const error = await agentFileError(loadAgentDirectory({ directory: fixture('dir-duplicate') }));
        assert.ok(error.reasons.includes('agent_duplicate_name'));
        assert.ok(error.issues.length > 0, 'every per-file issue is carried');
        assert.ok(error.issues.length > 0, 'every per-file issue is carried');
        assert.ok(error.issues.some((issue) => typeof issue.field === 'string' && issue.field.includes(':')),
            'a per-file issue is prefixed with the file');
        assert.match(error.message, /2 invalid files/);
    });

    it('aggregates two bad files into one error', async () => {
        const error = await agentFileError(loadAgentDirectory({ directory: fixture('dir-bad') }));
        assert.match(error.message, /2 invalid files/);
        assert.deepEqual([...error.reasons], ['agent_invalid_field', 'agent_unsupported_api_version']);
        assert.equal(error.field, 'a.agent.yaml:metadata.description');
        assert.equal(error.path, fixture('dir-bad'));
    });

    it('refuses a symlinked entry', async () => {
        const directory = await tempDir();
        const real = join(directory, 'real.agent.yaml');
        await writeFile(real, 'apiVersion: merci.dev/v1alpha1\nkind: Agent\n');
        await mkdir(join(directory, 'nested'));
        await symlink(real, join(directory, 'link.agent.yaml'));

        const error = await agentFileError(loadAgentDirectory({ directory }));
        assert.equal(error.reason, 'agent_symlink');
        assert.equal(error.field, 'link.agent.yaml');
    });
});
