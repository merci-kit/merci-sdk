// @ts-check
/**
 * Example 14 — A workspace-scoped coding agent (REPL).
 *
 * The agent is confined to one workspace root and gets the tool belt a coding
 * assistant needs:
 *
 *   read/grep/glob : `createContextTools({ options: { root } })` — path-confined
 *       file access (grep/glob shell out to real ripgrep).
 *   shell          : `createShellTool({ options: { roots: [root], approvalCallback } })`
 *       — the blocked / safe / HITL gate. Every non-safe command asks the
 *       operator; `readlineSafe`'s `fallback: 'n'` means a closed stdin
 *       DECLINES, so the gate can never hang the run.
 *   skills         : `loadSkillsFromDirectory({ directory })` + `.withSkills(...)`
 *       — SKILL.md tools from `examples/fixtures/skills`; script-carrying skills
 *       are HITL-gated by `requiresApproval` and answered here through
 *       `.withApproval({ fn })`.
 *   yaml skills    : the section "skills — YAML frontmatter and multi-script
 *       selection" reads the `yaml_multi_script` fixture: its frontmatter is
 *       real YAML (a tool LIST, a nested map, a block scalar) and its TWO
 *       scripts are picked with the `script` argument.
 *   auto-context   : `.withAutoContext({ options: { root } })` renders the
 *       environment block + AGENTS.md into every step.
 *
 * The REPL runs one turn per line; `exit`/`quit` leaves. A non-TTY stdin gets
 * one scripted, read-only turn first, so closed-stdin runs still exercise the
 * agent; a piped script can answer approval prompts too:
 *   `printf 'run node --version\ny\nexit\n' | node examples/14_coding_agent.mjs`
 *
 * Run: `node examples/14_coding_agent.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { dirname, join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
    EVENTS, createContextTools, createShellTool, defaultDisplay, initializeClient,
    loadCredentials, loadSkillsFromDirectory, log,
} from 'merci-sdk';
import { isExitKeyword, readlineSafe, reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SKILLS_DIR = join(HERE, 'fixtures', 'skills');

async function main() {
    const { provider, defaultModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    const rl = readline.createInterface({ input, output });
    /** Ask the operator. A closed stdin answers with the fallback ('n' = decline). */
    /** @param {{label: string}} arg0 - The prompt to show. @returns {Promise<boolean>} True when the operator approved. */
    const ask = async ({ label }) => {
        process.stdout.write('\n');
        const answer = (await readlineSafe({ rl, prompt: `${label} [y/N] `, fallback: 'n' })).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
    };

    log.header({ t: `Example 14 — Workspace coding agent (${provider})` });
    log.option({ name: 'workspace', value: ROOT, source: 'withAutoContext root + shell roots + context-tool root' });

    const approvalCallback = (/** @type {string} */ command, /** @type {any} */ args) =>
        ask({ label: `Run shell command: ${command} ${Array.isArray(args) ? args.join(' ') : ''}` });
    const approveTool = (/** @type {string} */ name, /** @type {any} */ args) =>
        ask({ label: `Run tool ${name}(${log.truncate({ text: JSON.stringify(args ?? {}), n: 80 })})` });

    const shellEvents = { requested: 0, granted: 0, denied: 0, blocked: 0 };
    client.on(EVENTS.SHELL.APPROVAL_REQUESTED, (/** @type {any} */ e) => {
        shellEvents.requested++;
        log.event({ type: EVENTS.SHELL.APPROVAL_REQUESTED, payload: { command: e.command, args: e.args } });
    });
    client.on(EVENTS.SHELL.APPROVAL_GRANTED, () => { shellEvents.granted++; });
    client.on(EVENTS.SHELL.APPROVAL_DENIED, () => { shellEvents.denied++; });
    client.on(EVENTS.SHELL.BLOCKED, (/** @type {any} */ e) => { shellEvents.blocked++; log.warn({ m: `blocked command: ${e.command}` }); });
    client.on(EVENTS.SKILLS.LOADED, (/** @type {any} */ e) => log.event({ type: EVENTS.SKILLS.LOADED, payload: { count: e.count, names: e.names } }));

    const skills = await loadSkillsFromDirectory({ directory: SKILLS_DIR, eventEmitter: client, requireScriptApproval: true });
    const contextTools = createContextTools({ options: { root: ROOT } });
    const shellTool = createShellTool({ options: {
        roots: [ROOT], cwd: ROOT, approvalCallback, timeoutMs: 30_000, maxOutputLength: 20_000,
    } });

    const session = client.session(defaultModel)
        .withAutoContext({ options: { root: ROOT } })
        .withTools({ tools: [...contextTools, shellTool] })
        .withSkills({ skills })
        .withApproval({ fn: approveTool })
        .withSystemMessage('You are a coding agent scoped to this repository. Inspect files with read/grep/glob before you run or change anything. Use execute_shell_command to run commands. Some tools require operator approval: if a call is denied, stop and report the denial — do not retry the same call.');

    log.list({ title: 'tools', items: [...contextTools.map((t) => t.name), shellTool.name] });
    log.list({ title: 'skills', items: skills.map((s) => s.name) });
    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 - The check to log. @returns {void} */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };
    check({ name: 'the fixture skills loaded', ok: skills.length >= 1, detail: `${skills.length} skill(s)` });

    // A skill's schema is the frontmatter's `parameters`. The frontmatter is
    // YAML, so the schema is written as a YAML MAPPING (the natural spelling);
    // the JSON-string form is accepted too. Either way the tool is advertised
    // with its real schema — a dropped schema would leave the model with no
    // idea which arguments the skill takes.
    const schemaOf = (/** @type {any} */ skill) => skill?.parameters?.properties ?? {};
    const codeReview = skills.find(({ name }) => name === 'code_review');
    check({
        name: 'every fixture skill advertises its real schema',
        ok: skills.every(({ name }) => Object.keys(schemaOf(skills.find((s) => s.name === name))).length > 0),
        detail: skills.map(({ name }) => `${name}=[${Object.keys(schemaOf(skills.find((s) => s.name === name))).join(',')}]`).join(' '),
    });
    check({
        name: 'the YAML mapping in the frontmatter IS the schema',
        ok: Object.keys(schemaOf(codeReview)).includes('code'),
        detail: `code_review=[${Object.keys(schemaOf(codeReview)).join(',')}]`,
    });

    log.section({ t: 'skills — YAML frontmatter and multi-script selection' });
    /** @param {{skill: Record<string, any>}} arg0 - The loaded skill tool. @returns {Record<string, any>} The parsed YAML frontmatter. */
    const frontmatterOf = ({ skill }) => skill?.metadata?.frontmatter ?? {};
    /** @param {{skill: Record<string, any>}} arg0 - The loaded skill tool. @returns {string[]} The script names, load order (the first one is the default). */
    const scriptNamesOf = ({ skill }) => /** @type {Array<{name: string}>} */ (skill?.scripts ?? []).map(({ name }) => String(name));
    const yamlSkill = skills.find(({ name }) => name === 'yaml_multi_script');
    if (!yamlSkill) {
        check({ name: 'the yaml_multi_script fixture skill loaded', ok: false, detail: 'not found in the skills directory' });
    } else {
        const frontmatter = frontmatterOf({ skill: yamlSkill });
        const declaredTools = frontmatter['allowed-tools'];
        const notes = String(frontmatter?.notes ?? '');
        check({
            name: 'the SKILL.md frontmatter is parsed as YAML',
            ok: Array.isArray(declaredTools)
                && Array.isArray(frontmatter?.meta?.tags)
                && notes.includes('\n'),
            detail: `allowed-tools=${JSON.stringify(declaredTools ?? null)} meta.tags=${JSON.stringify(frontmatter?.meta?.tags ?? null)} notes=${notes.split('\n').filter(Boolean).length} line(s)`,
        });
        check({
            name: 'metadata.allowedTools is the normalized tool list',
            ok: Array.isArray(yamlSkill.metadata?.allowedTools)
                && yamlSkill.metadata.allowedTools.join(',') === 'Read,Grep,Bash',
            detail: `allowedTools=${JSON.stringify(yamlSkill.metadata?.allowedTools ?? null)}`,
        });
        check({
            name: 'the JSON-string parameters field is parsed',
            ok: typeof /** @type {Record<string, unknown>} */ (yamlSkill.parameters.properties ?? {}).script === 'object',
            detail: `type=${yamlSkill.parameters?.type ?? '?'} properties=${Object.keys(yamlSkill.parameters?.properties ?? {}).join(',') || '?'}`,
        });
        const scriptNames = scriptNamesOf({ skill: yamlSkill });
        check({
            name: 'the skill exposes two scripts, selectable by name',
            ok: scriptNames.length === 2 && scriptNames[0] === 'first.js' && scriptNames[1] === 'second.js',
            detail: `scripts=[${scriptNames.join(', ')}]`,
        });
        const readRun = String(await yamlSkill.execute({ args: {}, signal: null, context: {} }));
        check({
            name: 'reading the skill returns its instructions and runs nothing',
            ok: readRun.includes('first.js') && !readRun.includes('FIRST script ran'),
            detail: readRun,
        });
        const firstRun = String(await yamlSkill.execute({ args: { script: 'first.js' }, signal: null, context: {} }));
        check({
            name: 'the { script } argument runs the named first script',
            ok: firstRun.includes('FIRST script ran'),
            detail: firstRun,
        });
        const namedRun = String(await yamlSkill.execute({ args: { script: 'second.js' }, signal: null, context: {} }));
        check({
            name: 'the { script } argument selects the second script',
            ok: namedRun.includes('SECOND script ran') && !namedRun.includes('FIRST script ran'),
            detail: namedRun,
        });
        let unknownScriptError = '';
        try {
            await yamlSkill.execute({ args: { script: 'nope.js' }, signal: null, context: {} });
        } catch (err) {
            unknownScriptError = String((/** @type {any} */ (err))?.message ?? err);
        }
        check({
            name: 'an unknown script name is rejected',
            ok: unknownScriptError.includes('has no script named'),
            detail: unknownScriptError || 'the call did not throw',
        });
        check({
            name: 'a script-carrying skill stays HITL-gated per call',
            ok: typeof yamlSkill.requiresApproval === 'function'
                && yamlSkill.requiresApproval({ args: {} }) === false
                && yamlSkill.requiresApproval({ args: { script: 'first.js' } }) === true,
            detail: `requiresApproval({args:{}})=${String(typeof yamlSkill.requiresApproval === 'function' ? yamlSkill.requiresApproval({ args: {} }) : 'n/a')}`,
        });
    }

    if (!process.stdin.isTTY) {
        log.section({ t: 'warm-up turn (non-TTY stdin)' });
        const warmupAnswer = String(await session.run({
            initialInput: 'Read the workspace instructions (AGENTS.md) and state in one sentence which package manager this project uses.',
            options: { maxIterations: 6, ...defaultDisplay() },
        }));
        warnEmptyAnswer({ answer: warmupAnswer, label: 'the warm-up turn' });
    }

    log.section({ t: 'REPL — one turn per line, "exit" to leave' });
    try {
        for (;;) {
            const line = await readlineSafe({ rl, prompt: '\nagent> ', fallback: 'exit' });
            if (isExitKeyword({ line })) {
                log.condition({ label: 'repl', branch: 'exit', why: line ? `input "${line}"` : 'stdin closed' });
                break;
            }
            if (!line) continue;
            log.user({ m: line });
            const turnAnswer = String(await session.run({ initialInput: line, options: { maxIterations: 8, ...defaultDisplay() } }));
            warnEmptyAnswer({ answer: turnAnswer, label: 'the REPL turn' });
        }
    } finally {
        rl.close();
    }

    reportUsage({ provider, usage });
    log.totals({ entries: {
        checks, failed: failures,
        'shell.approval_requested': shellEvents.requested,
        'shell.granted': shellEvents.granted,
        'shell.denied': shellEvents.denied,
        'shell.blocked': shellEvents.blocked,
    } });
    if (failures === 0) log.success({ m: 'Coding agent finished.' });
    else throw new Error(`${failures}/${checks} check(s) failed — inspect the log above.`);
}

runMain({ mainFn: main });
