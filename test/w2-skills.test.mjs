// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillsFromDirectory } from '../lib/tools/skills.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { log } from '../lib/support/logger.mjs';


/**
 * Writes a skill directory: SKILL.md plus optional scripts/.
 * @param {{root: string, dir: string, skillMd: string, scripts?: Record<string, string>}} arg0 - The skill to write.
 * @returns {Promise<string>} The created skill directory.
 */
async function makeSkill({ root, dir, skillMd, scripts = {} }) {
    const skillDir = join(root, dir);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), skillMd);
    const names = Object.keys(scripts);
    if (names.length > 0) {
        await mkdir(join(skillDir, 'scripts'), { recursive: true });
        for (const name of names) {
            await writeFile(join(skillDir, 'scripts', name), scripts[name]);
        }
    }
    return skillDir;
}


/**
 * Loads a skills directory with the SDK warning channel and the skill events
 * captured, so a test can assert on the loader's failure policy.
 * @param {{directory: string, requireScriptApproval?: boolean}} arg0 - Loader options.
 * @returns {Promise<{tools: Array<Record<string, any>>, warnings: Array<{prefix: string, args: Array<any>}>, events: Array<Record<string, any>>}>} The loaded tools, warnings and events.
 */
async function load({ directory, requireScriptApproval = true }) {
    /** @type {Array<{prefix: string, args: Array<any>}>} */
    const warnings = [];
    /** @type {Array<Record<string, any>>} */
    const events = [];
    const emitter = new EventEmitter();
    emitter.on(EVENTS.SKILLS.LOAD_ERROR, (/** @type {any} */ envelope) => { events.push(envelope); });
    emitter.on(EVENTS.SKILLS.LOADED, (/** @type {any} */ envelope) => { events.push(envelope); });
    const original = log.sdkWarn;
    log.sdkWarn = ({ prefix, args = [] }) => { warnings.push({ prefix, args: [...args] }); };
    try {
        const tools = await loadSkillsFromDirectory({ directory, eventEmitter: emitter, requireScriptApproval });
        return { tools, warnings, events };
    } finally {
        log.sdkWarn = original;
    }
}


test('W2-S1 YAML frontmatter keeps lists and nested maps in metadata.frontmatter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-w2-yaml-'));
    try {
        await makeSkill({
            root,
            dir: 'rich',
            skillMd: [
                '---',
                'name: yaml-rich',
                'description: Rich YAML skill',
                'command: /yaml-rich',
                'allowed-tools:',
                '  - Read',
                '  - Write',
                'meta:',
                '  author: platform',
                '  tags:',
                '    - alpha',
                '    - beta',
                '---',
                'Body text.',
                ''
            ].join('\n')
        });

        const { tools, warnings } = await load({ directory: root });
        assert.equal(tools.length, 1);
        const tool = tools[0];
        assert.equal(tool.name, 'yaml-rich');
        assert.equal(tool.description, 'Rich YAML skill');
        assert.equal(tool.command, '/yaml-rich');
        assert.deepEqual(tool.metadata.frontmatter.meta, { author: 'platform', tags: ['alpha', 'beta'] });
        assert.deepEqual(tool.metadata.frontmatter['allowed-tools'], ['Read', 'Write']);
        assert.deepEqual(tool.metadata.allowedTools, ['Read', 'Write']);
        assert.equal(tool.instructions, 'Body text.');
        assert.equal(warnings.length, 0, 'valid YAML must not warn');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});


test('W2-S1 a quoted value loses its quotes and a block scalar keeps its newlines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-w2-quotes-'));
    try {
        await makeSkill({
            root,
            dir: 'quoted',
            skillMd: [
                '---',
                'name: "quoted_skill"',
                "description: 'Single quoted description'",
                'notes: |',
                '  line one',
                '  line two',
                '---',
                'Body.',
                ''
            ].join('\n')
        });

        const { tools } = await load({ directory: root });
        assert.equal(tools.length, 1);
        const tool = tools[0];
        assert.equal(tool.name, 'quoted_skill');
        assert.equal(tool.description, 'Single quoted description');
        assert.equal(tool.metadata.frontmatter.notes, 'line one\nline two\n');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});


test('W2-S1 frontmatter that YAML rejects falls back to the legacy reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-w2-badyaml-'));
    try {
        await makeSkill({
            root,
            dir: 'legacy',
            skillMd: ['---', 'name: legacy', 'description: Use this: for that', '---', 'Body.', ''].join('\n')
        });

        const { tools, warnings } = await load({ directory: root });
        assert.equal(tools.length, 1, 'a frontmatter the legacy reader understands still loads');
        assert.equal(tools[0].name, 'legacy');
        assert.equal(tools[0].description, 'Use this: for that', 'the value keeps every colon');
        assert.ok(
            warnings.some((w) => w.prefix === 'SKILLS' && String(w.args.join(' ')).includes('not valid YAML')),
            `the author is told the frontmatter is not valid YAML, got: ${JSON.stringify(warnings)}`
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('W2-S1 frontmatter neither reader understands is skipped with a warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-w2-badyaml-'));
    try {
        await makeSkill({
            root,
            dir: 'broken',
            skillMd: ['---', '- a', '- b', '---', 'Body.', ''].join('\n')
        });
        await makeSkill({
            root,
            dir: 'good',
            skillMd: ['---', 'name: good', 'description: Fine', '---', 'Body.', ''].join('\n')
        });

        const { tools, warnings, events } = await load({ directory: root });
        assert.equal(tools.length, 1, 'the corrupt skill is skipped, the healthy one loads');
        assert.equal(tools[0].name, 'good');
        assert.ok(
            warnings.some((w) => w.prefix === 'SKILLS' && String(w.args.join(' ')).includes('broken')),
            `a SKILLS warning must name the broken skill, got: ${JSON.stringify(warnings)}`
        );
        const loadErrors = events.filter((e) => e.event === EVENTS.SKILLS.LOAD_ERROR);
        assert.equal(loadErrors.length, 1);
        assert.ok(String(loadErrors[0].dir).endsWith('broken'), 'the LOAD_ERROR names the skipped directory');
        assert.ok(String(loadErrors[0].error).length > 0, 'the LOAD_ERROR carries the parse reason');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});


test('W2-S1 legacy key:value frontmatter still loads (backwards compatibility)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-w2-legacy-'));
    try {
        await makeSkill({
            root,
            dir: 'legacy',
            skillMd: [
                '---',
                'name: legacy_skill',
                'description: Legacy description',
                'alias: /legacy',
                '---',
                'Legacy body.',
                ''
            ].join('\n')
        });

        const { tools, warnings } = await load({ directory: root });
        assert.equal(tools.length, 1);
        const tool = tools[0];
        assert.equal(tool.name, 'legacy_skill');
        assert.equal(tool.description, 'Legacy description');
        assert.equal(tool.command, '/legacy');
        assert.equal(tool.instructions, 'Legacy body.');
        assert.equal(warnings.length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});


test('W2-S1 a YAML mapping in the frontmatter IS the tool schema', async () => {    // The frontmatter is YAML, so a schema written as a YAML mapping is the
    // natural spelling. Dropping it would advertise the tool with an EMPTY
    // schema, and the model would have no idea which arguments it takes.
    const dir = await mkdtemp(join(tmpdir(), 'merci-skill-yaml-'));
    try {
        await mkdir(join(dir, 'yaml_skill'), { recursive: true });
        await writeFile(join(dir, 'yaml_skill', 'SKILL.md'), [
            '---',
            'name: yaml_skill',
            'description: A skill whose schema is a YAML mapping.',
            'parameters:',
            '  type: object',
            '  properties:',
            '    target:',
            '      type: string',
            '      description: What to act on.',
            '  required:',
            '    - target',
            '---',
            'Body.',
            '',
        ].join('\n'));

        const tools = await loadSkillsFromDirectory({ directory: dir });
        assert.equal(tools.length, 1);
        const tool = tools[0];
        assert.equal(tool.parameters.type, 'object');
        assert.deepEqual(Object.keys(/** @type {Record<string, unknown>} */ (tool.parameters.properties ?? {})), ['target']);
        assert.deepEqual(tool.parameters.required, ['target']);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('W2-S1 a list is never a tool schema, in YAML or in JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-skill-list-'));
    try {
        await makeSkill({
            root,
            dir: 'yaml_list',
            skillMd: [
                '---',
                'name: list_skill',
                'description: A skill whose schema is a list.',
                'parameters:',
                '  - target',
                '  - mode',
                '---',
                'Body.',
                '',
            ].join('\n'),
        });
        const yamlForm = await load({ directory: root });
        assert.equal(yamlForm.tools.length, 1);
        assert.deepEqual(yamlForm.tools[0].parameters, { type: 'object', properties: {} }, 'a YAML list is not a schema');
        assert.equal(yamlForm.warnings.some((w) => w.args.some((a) => String(a).includes('invalid parameters'))), true, 'the drop is announced');

        // The legacy JSON-string form must be a MAPPING too: `[1,2]` parses,
        // but it is still not a tool schema.
        await writeFile(join(root, 'yaml_list', 'SKILL.md'), [
            '---',
            'name: list_skill',
            'description: A skill whose schema is a JSON list.',
            'parameters: "[1,2]"',
            '---',
            'Body.',
            '',
        ].join('\n'));
        const jsonForm = await load({ directory: root });
        assert.deepEqual(jsonForm.tools[0].parameters, { type: 'object', properties: {} }, 'a JSON list is not a schema');
        assert.equal(jsonForm.warnings.some((w) => w.args.some((a) => String(a).includes('invalid parameters'))), true, 'the drop is announced');

        // A scalar parses as JSON too, and is equally not a schema.
        await writeFile(join(root, 'yaml_list', 'SKILL.md'), [
            '---',
            'name: list_skill',
            'description: A skill whose schema is a scalar.',
            'parameters: "42"',
            '---',
            'Body.',
            '',
        ].join('\n'));
        const scalarForm = await load({ directory: root });
        assert.deepEqual(scalarForm.tools[0].parameters, { type: 'object', properties: {} }, 'a JSON scalar is not a schema');
        assert.equal(scalarForm.warnings.some((w) => w.args.some((a) => String(a).includes('invalid parameters'))), true, 'the drop is announced');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('W2-S2 a skill with two scripts exposes both, and runs one only when named', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-w2-scripts-'));
    try {
        await makeSkill({
            root,
            dir: 'multi',
            skillMd: ['---', 'name: multi', '---', 'Body.', ''].join('\n'),
            scripts: {
                'a-first.sh': '#!/bin/bash\necho "FIRST $1"\n',
                'b-second.sh': '#!/bin/bash\necho "SECOND $1"\n',
                'notes.txt': 'not a script\n'
            }
        });

        const { tools } = await load({ directory: root });
        assert.equal(tools.length, 1);
        const tool = tools[0];
        assert.deepEqual(tool.scripts.map((/** @type {any} */ s) => s.name), ['a-first.sh', 'b-second.sh']);
        assert.deepEqual(tool.scripts.map((/** @type {any} */ s) => s.interpreter), ['bash', 'bash']);
        assert.ok(String(tool.scripts[0].path).endsWith('a-first.sh'));

        const readOnly = await tool.execute({ args: { n: 1 }, signal: null });
        assert.match(String(readOnly), /Body\./, 'no selector reads the instructions');
        assert.match(String(readOnly), /a-first\.sh/);
        assert.match(String(readOnly), /b-second\.sh/);
        assert.doesNotMatch(String(readOnly), /FIRST|SECOND/, 'reading never runs a script');

        const first = await tool.execute({ args: { script: 'a-first.sh', n: 1 }, signal: null });
        assert.match(String(first), /FIRST/);
        assert.match(String(first), /\{"n":1\}/);

        const named = await tool.execute({ args: { script: 'b-second.sh', n: 2 }, signal: null });
        assert.match(String(named), /SECOND/);
        assert.match(String(named), /\{"n":2\}/);
        assert.doesNotMatch(String(named), /script/, 'the selector is not part of the payload');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});


test('W2-S2 an unknown script name is rejected and never reaches a shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-w2-badscript-'));
    try {
        const skillDir = await makeSkill({
            root,
            dir: 'multi',
            skillMd: ['---', 'name: multi', '---', 'Body.', ''].join('\n'),
            scripts: { 'run.sh': '#!/bin/bash\necho RAN\n' }
        });
        await makeSkill({
            root,
            dir: 'evil',
            skillMd: ['---', 'name: evil', '---', 'Body.', ''].join('\n'),
            scripts: { 'evil.sh': '#!/bin/bash\necho PWNED\n' }
        });

        const { tools } = await load({ directory: root });
        const tool = tools.find((t) => t.name === 'multi');
        assert.ok(tool, 'the multi-script skill loads');

        await assert.rejects(
            () => tool.execute({ args: { script: '../evil/evil.sh' }, signal: null }),
            (/** @type {any} */ err) => {
                assert.match(err.message, /no script named/);
                return true;
            }
        );
        await assert.rejects(
            () => tool.execute({ args: { script: 'run.sh; echo pwned' }, signal: null }),
            /no script named/
        );

        // The rejected selector never reached the shell: the evil script is intact
        // and the skill only ever ran its own script.
        const out = await tool.execute({ args: { script: 'run.sh' }, signal: null });
        assert.match(String(out), /RAN/);
        assert.doesNotMatch(String(out), /PWNED/);
        await access(join(skillDir, 'scripts', 'run.sh'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});


test('W2-S2 a script skill stays HITL-gated and the frontmatter cannot switch it off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merci-w2-gate-'));
    try {
        await makeSkill({
            root,
            dir: 'scripted',
            skillMd: ['---', 'name: scripted', 'requiresApproval: false', 'allowed-tools: [Read]', '---', 'Body.', ''].join('\n'),
            scripts: { 'run.sh': '#!/bin/bash\necho hi\n' }
        });
        await makeSkill({
            root,
            dir: 'plain',
            skillMd: ['---', 'name: plain', '---', 'Body.', ''].join('\n')
        });

        const { tools } = await load({ directory: root });
        const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
        assert.equal(typeof byName.scripted.requiresApproval, 'function', 'a script skill is gated per call');
        assert.equal(byName.scripted.requiresApproval({ args: {} }), false, 'reading the instructions runs nothing');
        assert.equal(byName.scripted.requiresApproval({ args: { script: 'run.sh' } }), true, 'running a script is gated');
        assert.equal(byName.plain.requiresApproval, undefined, 'an instructions-only skill runs nothing');
        assert.deepEqual(byName.scripted.metadata.allowedTools, ['Read'], 'the frontmatter tool list is metadata, not policy');

        const { tools: trusted } = await load({ directory: root, requireScriptApproval: false });
        const trustedByName = Object.fromEntries(trusted.map((t) => [t.name, t]));
        assert.equal(trustedByName.scripted.requiresApproval, undefined, 'the host keeps the opt-out');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
