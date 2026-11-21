#!/usr/bin/env node


/**
 * @file Consumer skill freshness gate.
 * @version 0.7.2
 *
 * @description
 * Network-free, deterministic checks over every skill directory directly under
 * `skills/` (the Agent Skills shipped inside the npm tarball):
 *   S1 frontmatter — SKILL.md opens with a YAML block carrying `name`
 *      (equal to the directory name), a non-trivial `description`, and a
 *      `version` equal to package.json's.
 *   S2 references — every `references/*.md` is linked from SKILL.md, and
 *      every `references/*.md` link there resolves.
 *   S3 examples — every `examples/<file>.mjs` cited exists in the repo.
 *   S4 subpaths — every `merci-sdk/<sub>` import cited is a package.json
 *      `exports` entry.
 *   S5 symbols — every name in an `import { ... } from 'merci-sdk...'` block
 *      exists in the generated STRUCTURE.md symbol tables.
 *   S6 consumer-clean — no repo-private references (`@lib`/`@test` aliases,
 *      local-machine hosts, `../lib/` imports) leak into a shipped skill.
 *   S7 version parity — no skill file cites an `0.x.y` version or a
 *      `merci-sdk@x.y.z` pin other than package.json's.
 *
 * Run: `node scripts/check-skill.mjs [--json]`
 * Exit 1 when any violation remains. The JSON form lists every checked skill
 * (`skills`) beside `violations`, so a test can assert the sweep covered it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SKILLS_ROOT = join(ROOT, 'skills');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

const toPosix = (p) => p.split(sep).join('/');
const relRoot = (abs) => toPosix(relative(ROOT, abs));

/** @type {string[]} */
const violations = [];

/** @param {string} message */
function fail(message) {
    violations.push(message);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const pkgVersion = String(pkg.version ?? '');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;
const REF_LINK_RE = /references\/([A-Za-z0-9_-]+\.md)/g;
const EXAMPLE_RE = /examples\/([A-Za-z0-9_.-]+\.mjs)/g;
const SUBPATH_RE = /merci-sdk\/([A-Za-z0-9_-]+)/g;
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]merci-sdk[^'"]*['"]/g;
const VERSION_RE = /\b0\.\d+\.\d+\b|merci-sdk@(\d+\.\d+\.\d+)/g;
const DENY = ['@lib', '@test', '127.0.0.1', 'ponytail', '../lib/', 'merci-memory.json'];

const exportSubs = new Set(
    Object.keys(pkg.exports ?? {})
        .filter((k) => k !== '.' && k !== './package.json')
        .map((k) => k.replace(/^\.\//, ''))
);
const structure = existsSync(join(ROOT, 'STRUCTURE.md')) ? readFileSync(join(ROOT, 'STRUCTURE.md'), 'utf8') : '';
const known = new Set([...structure.matchAll(/\| `([A-Za-z_$][\w$]*)` \|/g)].map((x) => x[1]));

/** Every skill directory directly under `skills/`. @returns {string[]} */
function listSkills() {
    if (!existsSync(SKILLS_ROOT)) return [];
    return readdirSync(SKILLS_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

/**
 * The skill's markdown files: SKILL.md plus references/*.md.
 * @param {{dir: string}} arg0
 * @returns {string[]}
 */
function skillFiles({ dir }) {
    /** @type {string[]} */
    const out = [join(dir, 'SKILL.md')];
    const refsDir = join(dir, 'references');
    if (existsSync(refsDir)) {
        for (const name of readdirSync(refsDir).sort()) {
            if (!name.endsWith('.md')) continue;
            const abs = join(refsDir, name);
            try {
                if (statSync(abs).isFile()) out.push(abs);
            } catch {
                // A broken symlink is S2's finding, not a crash: it is reported
                // as a linked reference that does not exist.
            }
        }
    }
    return out;
}

/**
 * Run every rule for one skill. Each message names the skill, because the
 * sweep reports them together.
 * @param {{name: string}} arg0
 * @returns {number} the number of markdown files checked
 */
function checkSkill({ name }) {
    const dir = join(SKILLS_ROOT, name);
    const skillMd = join(dir, 'SKILL.md');
    const refsDir = join(dir, 'references');
    const files = skillFiles({ dir });
    /** @type {Map<string, string>} */
    const bodies = new Map();
    for (const file of files) {
        try {
            bodies.set(file, readFileSync(file, 'utf8'));
        } catch {
            // A directory named SKILL.md, a permission error, or a broken
            // symlink: a violation, never an uncaught stack inside `pnpm test`.
        }
    }
    /** @param {string} message */
    const skillFail = (message) => fail(`[${name}] ${message}`);

    // ── S1 frontmatter ──────────────────────────────────────────
    const raw = bodies.get(skillMd);
    if (raw === undefined) {
        skillFail('SKILL.md is missing or unreadable');
        return 0;
    }
    const match = raw.match(FRONTMATTER_RE);
    if (!match) {
        skillFail('SKILL.md has no --- YAML frontmatter block');
    } else {
        /** @type {any} */
        let fm = null;
        try {
            fm = parseYaml(match[1]);
        } catch (err) {
            skillFail(`SKILL.md frontmatter is not valid YAML: ${/** @type {any} */ (err)?.message ?? err}`);
        }
        if (fm !== null && (typeof fm !== 'object' || Array.isArray(fm))) {
            skillFail('SKILL.md frontmatter must be a YAML mapping');
        } else if (fm) {
            if (fm.name !== name) skillFail(`SKILL.md frontmatter name is ${JSON.stringify(fm.name)} — expected ${JSON.stringify(name)}`);
            if (typeof fm.description !== 'string' || fm.description.trim().length < 40) {
                skillFail('SKILL.md frontmatter description is missing or too short to trigger on (min 40 chars)');
            }
            if (String(fm.version ?? '') !== pkgVersion) {
                skillFail(`SKILL.md frontmatter version is ${JSON.stringify(fm.version ?? null)} — package.json says ${pkgVersion}`);
            }
        }
    }

    // ── S2 references ───────────────────────────────────────────
    const linked = new Set([...(bodies.get(skillMd) ?? '').matchAll(REF_LINK_RE)].map((x) => x[1]));
    const onDisk = existsSync(refsDir)
        ? readdirSync(refsDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
            .map((entry) => entry.name)
        : [];
    for (const ref of onDisk) {
        if (!linked.has(ref)) skillFail(`references/${ref} exists but SKILL.md does not link to it`);
    }
    for (const ref of linked) {
        const abs = join(refsDir, ref);
        let isFile = false;
        try {
            isFile = statSync(abs).isFile();
        } catch {
            isFile = false;
        }
        if (!isFile) skillFail(`SKILL.md links to references/${ref}, which does not exist`);
    }

    for (const [file, body] of bodies) {
        // ── S3 examples ─────────────────────────────────────────
        for (const x of body.matchAll(EXAMPLE_RE)) {
            if (!existsSync(join(ROOT, 'examples', x[1]))) {
                skillFail(`${relRoot(file)} cites examples/${x[1]}, which does not exist`);
            }
        }
        // ── S4 subpaths ─────────────────────────────────────────
        for (const x of body.matchAll(SUBPATH_RE)) {
            if (!exportSubs.has(x[1])) skillFail(`${relRoot(file)} cites the merci-sdk/${x[1]} subpath, which package.json does not export`);
        }
        // ── S5 symbols ──────────────────────────────────────────
        for (const x of body.matchAll(IMPORT_RE)) {
            for (const imported of x[1].split(',').map((s) => s.trim()).filter(Boolean)) {
                if (!known.has(imported)) skillFail(`${relRoot(file)} imports ${imported} from merci-sdk, which STRUCTURE.md does not list`);
            }
        }
        // ── S6 consumer-clean ───────────────────────────────────
        for (const token of DENY) {
            if (body.includes(token)) skillFail(`${relRoot(file)} contains repo-private reference ${JSON.stringify(token)}`);
        }
        // ── S7 version parity ───────────────────────────────────
        for (const x of body.matchAll(VERSION_RE)) {
            const cited = x[1] ?? x[0];
            if (cited !== pkgVersion) skillFail(`${relRoot(file)} cites version ${cited} — package.json says ${pkgVersion}`);
        }
    }

    return files.length;
}

const skills = listSkills();
if (skills.length === 0) fail('skills/ has no SKILL.md directory');
let fileCount = 0;
for (const name of skills) fileCount += checkSkill({ name });

if (asJson) {
    process.stdout.write(`${JSON.stringify({ skills, violations }, null, 2)}\n`);
} else if (violations.length > 0) {
    process.stderr.write(`skill gate — ${violations.length} problem(s):\n`);
    for (const v of violations) process.stderr.write(`  - ${v}\n`);
} else {
    process.stdout.write(`skill gate — ${skills.length} skill(s), ${fileCount} file(s), matches the package surface\n`);
}
process.exit(violations.length > 0 ? 1 : 0);
