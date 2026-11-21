// @ts-check

/**
 * Skill catalog budget and the load/run split.
 *
 * SOTA harnesses (Codex, Claude Code) spend 1–2% of the context window on the
 * skill *catalog* — name plus description — and load a body only when the
 * skill is chosen. A body inlined into the catalog costs 10–40x that budget
 * and pushes the trigger text out of the model's view.
 *
 * A skill that ships `scripts/` must also stay readable: calling it with no
 * `script` selector returns the instructions, and only an explicit selector
 * executes code.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SkillsLibrary, loadSkillsFromDirectory } from '../lib/tools/skills.mjs';

/** @param {{name: string, description: string, body?: string, scripts?: Record<string, string>}} arg0 */
async function writeSkill({ name, description, body = 'Body text.', scripts = {} }) {
    const root = await mkdtemp(join(tmpdir(), `merci-catalog-${name}-`));
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), ['---', `name: ${name}`, `description: ${description}`, '---', '', body, ''].join('\n'));
    for (const [file, content] of Object.entries(scripts)) {
        await mkdir(join(dir, 'scripts'), { recursive: true });
        await writeFile(join(dir, 'scripts', file), content);
    }
    return { root, dir };
}

describe('skill catalog — progressive disclosure', () => {
    it('the listing carries name and description, never the body', async () => {
        const { root } = await writeSkill({ name: 'alpha', description: 'Does alpha things.', body: 'SECRET_BODY_TEXT' });
        try {
            const tools = await loadSkillsFromDirectory({ directory: root });
            const library = new SkillsLibrary({ skills: tools });
            const listing = await library.load();
            assert.match(listing, /alpha/);
            assert.match(listing, /Does alpha things\./);
            assert.doesNotMatch(listing, /SECRET_BODY_TEXT/, 'the body must cost nothing until the skill is chosen');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('the catalog budget drops whole entries instead of truncating triggers mid-word', async () => {
        const dirs = [];
        /** @type {any[]} */
        const tools = [];
        try {
            for (let i = 0; i < 8; i++) {
                const made = await writeSkill({ name: `skill-${i}`, description: `Description number ${i} with a distinctive trigger phrase.` });
                dirs.push(made.root);
                tools.push(...await loadSkillsFromDirectory({ directory: made.root }));
            }
            const library = new SkillsLibrary({ skills: tools, maxCatalogChars: 260 });
            const listing = await library.load();
            assert.ok(listing.length <= 260, `the listing is a ceiling, not an estimate (${listing.length})`);
            assert.match(listing, /not listed/i, 'the omission is stated, never silent');
            const listed = tools.filter((t) => listing.includes(`* ${t.name}:`)).length;
            assert.ok(listed > 0 && listed < tools.length, `partial catalog (${listed}/${tools.length})`);
        } finally {
            for (const d of dirs) await rm(d, { recursive: true, force: true });
        }
    });

    it('a named load reads the body the catalog leaves out', async () => {
        const library = new SkillsLibrary({ skills: [
            { name: 'deploy', description: 'Deploy the app', instructions: 'RUN make deploy' }
        ] });
        assert.doesNotMatch(await library.load(), /RUN make deploy/);
        assert.match(await library.load({ name: 'deploy' }), /RUN make deploy/);
        assert.match(await library.load({ name: 'missing' }), /No skill named 'missing'/);
    });

    it('a budget below the omission notice is still a ceiling', async () => {
        const library = new SkillsLibrary({
            skills: [{ name: 'a', description: 'A' }, { name: 'b', description: 'B' }],
            maxCatalogChars: 40
        });
        const listing = await library.load();
        assert.ok(listing.length <= 40, `(${listing.length})`);
    });
});

describe('skill tool — load vs run', () => {
    it('a skill with scripts returns its instructions when no script is selected', async () => {
        const { root } = await writeSkill({
            name: 'scripted',
            description: 'Has a script.',
            body: 'READ_ME_INSTRUCTIONS',
            scripts: { 'run.sh': '#!/bin/bash\necho RAN\n' }
        });
        try {
            const tools = await loadSkillsFromDirectory({ directory: root });
            const res = await tools[0].execute({ args: {}, signal: null });
            assert.match(String(res), /READ_ME_INSTRUCTIONS/);
            assert.doesNotMatch(String(res), /RAN/, 'no script runs without a selector');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('the instructions response names the runnable scripts', async () => {
        const { root } = await writeSkill({
            name: 'scripted',
            description: 'Has a script.',
            body: 'BODY',
            scripts: { 'run.sh': '#!/bin/bash\necho RAN\n' }
        });
        try {
            const tools = await loadSkillsFromDirectory({ directory: root });
            const res = String(await tools[0].execute({ args: {}, signal: null }));
            assert.match(res, /run\.sh/, 'the model is told what it can run');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('an explicit selector still runs the script with the payload', async () => {
        const { root } = await writeSkill({
            name: 'scripted',
            description: 'Has a script.',
            scripts: { 'run.sh': '#!/bin/bash\necho "RAN $1"\n' }
        });
        try {
            const tools = await loadSkillsFromDirectory({ directory: root });
            const res = String(await tools[0].execute({ args: { script: 'run.sh', n: 7 }, signal: null }));
            assert.match(res, /RAN/);
            assert.match(res, /\{"n":7\}/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('only a selector is approval-gated; reading the skill is not', async () => {
        const { root } = await writeSkill({
            name: 'scripted',
            description: 'Has a script.',
            scripts: { 'run.sh': '#!/bin/bash\necho RAN\n' }
        });
        try {
            const tools = await loadSkillsFromDirectory({ directory: root });
            const gate = /** @type {any} */ (tools[0]).requiresApproval;
            assert.equal(typeof gate, 'function', 'the gate is per call, not per tool');
            assert.equal(gate({ args: {} }), false, 'reading the instructions runs nothing');
            assert.equal(gate({ args: { script: 'run.sh' } }), true, 'running a script is gated');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('the schema advertises the runnable script names', async () => {
        const { root } = await writeSkill({
            name: 'scripted',
            description: 'Has a script.',
            scripts: { 'run.sh': '#!/bin/bash\necho RAN\n' }
        });
        try {
            const tools = await loadSkillsFromDirectory({ directory: root });
            const script = /** @type {any} */ (tools[0]).parameters.properties.script;
            assert.deepEqual(script.enum, ['run.sh'], 'the model can see what it may run');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
