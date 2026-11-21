// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSkillsFromDirectory } from '../lib/tools/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SKILLS_DIR = join(ROOT, 'skills');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the shipped merci-sdk skill loads through the SDK skill loader', async () => {
    const tools = await loadSkillsFromDirectory({ directory: SKILLS_DIR });
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('merci-sdk'), `expected a merci-sdk skill tool, got [${names.join(', ')}]`);
    const skill = tools.find((t) => t.name === 'merci-sdk');
    assert.ok((skill?.description ?? '').length >= 40, 'the skill description must be triggerable');
    assert.deepEqual(skill?.parameters, { type: 'object', properties: {} });
    assert.equal(skill?.metadata?.frontmatter?.version, pkg.version);
});

test('the shipped skill is inside the npm files allowlist', () => {
    assert.ok((pkg.files ?? []).includes('skills'), 'package.json "files" must ship skills/');
});
