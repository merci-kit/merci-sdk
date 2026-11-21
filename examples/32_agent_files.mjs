// @ts-check
/**
 * Example 32 — Agent definition files: one YAML, a live tool-using agent, a live subagent.
 *
 * A non-coder writes one `agents/<name>.agent.yaml`. This program uses that file
 * for real — every model call below goes to the provider in `secret.env`:
 *
 *   A — THE FILE    : the YAML, on screen, plus the one script it declares.
 *       Nothing in the file builds a client, names a secret or defines a
 *       server: a definition selects what the host already provides.
 *   B — LOAD        : `loadAgentFile` validates every field, resolves the
 *       script on disk (contained, hashed) and returns a deep-frozen spec.
 *   C — THE TOOLBOX : `createAgentToolbox` supplies a real workspace and a real
 *       host tool; `resolveToolset` turns `use: [files]`, `host:lookup_policy`
 *       and the declared script into the exact tool list.
 *   D — LIVE SESSION: `applyAgentSpec` wires a real session. The model reads the
 *       note, runs the declared script tool, consults the host tool, and answers
 *       with the exact word count. The tool events below are the model's own.
 *   E — LIVE PROFILE: the SAME spec becomes a subagent profile via
 *       `toTaskAgent`. A parent session delegates to it, and the child runs the
 *       same tools under the same approval policy.
 *
 * Public API: `merci-sdk/agents` — `loadAgentFile`, `createAgentToolbox`,
 * `resolveToolset`, `applyAgentSpec`, `toTaskAgent`; `merci-sdk` — the client,
 * `EVENTS`, `log`.
 *
 * Run: `node examples/32_agent_files.mjs`
 * Needs: `PROVIDER` plus its credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EVENTS, initializeClient, loadCredentials, log } from 'merci-sdk';
import {
    applyAgentSpec,
    createAgentToolbox,
    loadAgentFile,
    resolveToolset,
    toTaskAgent
} from 'merci-sdk/agents';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer } from './_shared/example-utils.mjs';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';

const WORK_DIR = join(SCRATCH_DIR, '48-agent-files');
const AGENTS_DIR = join(WORK_DIR, 'agents');
const SCRIPTS_DIR = join(AGENTS_DIR, 'scripts');
const WORKSPACE_DIR = join(WORK_DIR, 'workspace');
const NOTE_PATH = join(WORKSPACE_DIR, 'staging-note.md');

/** 40 words, so the house rule below has something real to judge. */
const NOTE = [
    'The staging cluster failed twice this week.',
    'Both failures began with a configuration drift in the ingress rules.',
    'Roll back the last change, pin the controller version, and add a check that compares the live rules with the reviewed manifest.'
].join(' ');

/** The declared script tool: one file, one JSON argv, one JSON answer. */
const WORD_COUNT_SCRIPT = `import { readFileSync } from 'node:fs';

const { path } = JSON.parse(process.argv[2] ?? '{}');
const text = readFileSync(path, 'utf8');
const words = text.trim().split(/\\s+/).filter(Boolean).length;
process.stdout.write(JSON.stringify({ path, words }));
`;

/** The definition a non-coder edits. Groups for beginners, a selector for power users. */
const AGENT_YAML = `apiVersion: merci.dev/v1alpha1
kind: Agent
metadata:
  name: reviewer
  description: Reviews a short engineering note — reads it, counts its words, and checks the house style rule.
spec:
  model: tool
  instructions: |
    You review short engineering notes.
    For every review: read the note, call word_count with its absolute path,
    and call lookup_policy for rule STYLE-7.
    Answer in ONE sentence that states the exact word count and whether the note complies.
  tools:
    use: [files]
    allow: ["host:lookup_policy"]
    definitions:
      - name: word_count
        description: 'Count the words in a text file and return {"words": N}.'
        script: scripts/word-count.mjs
        timeoutMs: 10000
        parameters:
          type: object
          properties:
            path:
              type: string
          required: [path]
`;

/** House rules the host owns. The file may select this tool; it cannot define it. */
const HOUSE_RULES = new Map([
    ['STYLE-7', 'A review note must stay under 45 words and name one concrete next action.']
]);

/** A real host tool: the YAML reaches it with `host:lookup_policy`. */
const lookupPolicy = {
    name: 'lookup_policy',
    description: 'Look up a house style rule by id (for example STYLE-7).',
    parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
    },
    /** @param {{args: Record<string, any>}} arg0 */
    execute: async ({ args }) => {
        const rule = HOUSE_RULES.get(String(args.id ?? '').toUpperCase());
        return rule ? { id: String(args.id).toUpperCase(), rule } : { success: false, error: `No rule "${String(args.id)}".` };
    }
};

let failures = 0;
/** @param {{name: string, passed: boolean, detail?: string}} arg0 */
function check({ name, passed, detail }) {
    if (!passed) failures += 1;
    log.check({ name, passed, detail });
}

/** Writes the note, the definition and its script; returns the definition path. */
async function furnish() {
    await rm(WORK_DIR, { recursive: true, force: true });
    await mkdir(SCRIPTS_DIR, { recursive: true });
    await mkdir(WORKSPACE_DIR, { recursive: true });
    await writeFile(join(AGENTS_DIR, 'reviewer.agent.yaml'), AGENT_YAML, 'utf8');
    await writeFile(join(SCRIPTS_DIR, 'word-count.mjs'), WORD_COUNT_SCRIPT, 'utf8');
    await writeFile(NOTE_PATH, `${NOTE}\n`, 'utf8');
    return join(AGENTS_DIR, 'reviewer.agent.yaml');
}

/** The host-side approve-all policy; it prints, because the gate is the point. */
let approvals = 0;
/** @param {string} name */
function approve(name) {
    approvals += 1;
    log.condition({ label: 'approval', branch: 'granted', why: `${name} — the callback decides; the arguments were printed above` });
    return true;
}

/** Streams the model's text and logs the tool calls it makes.
 * @param {{onTool?: (arg0: {name: string, result: string}) => void}} [arg0]
 */
function liveEvents({ onTool } = {}) {
    let labeled = false;
    return {
        /** @param {any} event */
        onEvent: (event) => {
            if (event.type === 'tool_call_start') {
                log.toolCall({ n: event.name, a: log.truncate({ text: JSON.stringify(event.args), n: 120 }) });
            } else if (event.type === 'tool_call_end') {
                log.toolResult({ n: event.name, r: event.result });
                onTool?.({ name: String(event.name), result: String(event.result ?? '') });
            } else if (event.type === 'text') {
                const chunk = String(event.content ?? '');
                if (!labeled && chunk) { log.assistant({ m: '', isStreaming: true }); labeled = true; }
                process.stdout.write(chunk);
            } else if (event.type === 'stream_end' && labeled) {
                process.stdout.write('\n');
                labeled = false;
            }
        }
    };
}

/** D — a real session driven by the definition file.
 * @param {{client: any, model: string, spec: any, toolbox: any}} arg0
 */
async function liveSession({ client, model, spec, toolbox }) {
    log.section({ t: 'D — live session: applyAgentSpec, then real tool calls' });
    /** @type {{read: boolean, wordCount: number|null, policy: boolean}} */
    const seen = { read: false, wordCount: null, policy: false };
    const { onEvent } = liveEvents({
        onTool: ({ name, result }) => {
            if (name === 'read') seen.read = true;
            if (name === 'lookup_policy') seen.policy = true;
            if (name === 'word_count') {
                try { seen.wordCount = JSON.parse(result).words; } catch { seen.wordCount = Number.NaN; }
            }
        }
    });

    const session = client.session(model).withApproval({ fn: approve });
    applyAgentSpec({ session, spec, toolbox });
    log.option({ name: 'session', value: `${model} · approval policy attached`, source: 'applyAgentSpec({ session, spec, toolbox })' });

    const prompt = [
        `Review the note at ${NOTE_PATH}.`,
        'Read it first, then call word_count with exactly that absolute path, then call lookup_policy for STYLE-7.',
        'Answer in one sentence with the exact word count and the rule id.'
    ].join(' ');
    log.user({ m: prompt });

    const answer = String(await session.run({ initialInput: prompt, options: { maxIterations: 8, onEvent } }));
    warnEmptyAnswer({ answer, label: 'the live reviewer' });

    check({ name: 'D — the model read the note', passed: seen.read, detail: 'read tool observed' });
    check({ name: 'D — the declared script tool ran', passed: Number.isFinite(seen.wordCount), detail: `word_count returned ${seen.wordCount}` });
    check({ name: 'D — the script counted the real file', passed: seen.wordCount === 40, detail: `expected 40, got ${seen.wordCount}` });
    check({ name: 'D — the host tool was consulted', passed: seen.policy, detail: 'lookup_policy observed' });
    check({ name: 'D — the answer carries the count and the rule', passed: /40/.test(answer) && /STYLE-7/i.test(answer), detail: log.truncate({ text: answer, n: 120 }) });
    return answer;
}

/** E — the same spec as a subagent profile, delegated to by a parent session.
 * @param {{client: any, model: string, spec: any, toolbox: any, reviewerAnswer: string}} arg0
 */
async function liveDelegation({ client, model, spec, toolbox, reviewerAnswer }) {
    log.section({ t: 'E — live profile: toTaskAgent, then a real delegation' });
    const profile = toTaskAgent({ spec, toolbox });
    log.list({
        title: 'profile built from the same spec',
        items: [
            `name        ${String(profile.name)}`,
            `model       ${String(profile.model)}`,
            `tools       ${/** @type {string[]} */ (profile.toolNames).join(', ')}`,
            `sha256      ${String(profile.definitionHash).slice(0, 16)}… (definition) · ${String((/** @type {any[]} */ (profile.scriptHashes)[0]?.scriptHash ?? '')).slice(0, 16)}… (script)`
        ]
    });

    const task = { started: 0, status: 'pending', result: '', error: '' };
    client.on(EVENTS.TASK.START, (/** @type {any} */ event) => { if (event?.subagent_type === 'reviewer') task.started += 1; });
    client.on(EVENTS.TASK.FINISH, (/** @type {any} */ event) => {
        if (event?.subagent_type !== 'reviewer') return;
        task.status = 'finish';
        task.result = String(event.result ?? '');
    });
    client.on(EVENTS.TASK.ERROR, (/** @type {any} */ event) => {
        if (event?.subagent_type !== 'reviewer') return;
        task.status = 'error';
        task.error = String(event.error ?? '');
    });

    const parent = client.session(model)
        .withSystemMessage('You delegate. Use the task tool with subagent_type "reviewer" and repeat the subagent answer verbatim. Do not do the review yourself.')
        .withApproval({ fn: approve })
        .withTaskAgents({ agents: [/** @type {any} */ (profile)] });
    log.option({ name: 'parent', value: `${model} · roster: reviewer`, source: 'withTaskAgents({ agents: [toTaskAgent(...)] })' });

    const prompt = `Delegate to the reviewer: ask it to review the note at ${NOTE_PATH}, then repeat its sentence verbatim.`;
    log.user({ m: prompt });
    const answer = String(await parent.run({ initialInput: prompt, options: { maxIterations: 10 } }));
    warnEmptyAnswer({ answer, label: 'the parent session' });

    const settled = task.status !== 'pending' ? task : await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(task), 120_000);
        /** @type {any} */ (client).once(EVENTS.TASK.FINISH, () => { clearTimeout(timer); resolve(task); });
        /** @type {any} */ (client).once(EVENTS.TASK.ERROR, () => { clearTimeout(timer); resolve(task); });
    });

    check({ name: 'E — the parent delegated to the profile', passed: task.started === 1, detail: `${task.started} task:start` });
    check({ name: 'E — the subagent finished', passed: settled.status === 'finish' && settled.result.trim().length > 0, detail: settled.status === 'finish' ? log.truncate({ text: settled.result, n: 120 }) : settled.error });
    check({
        name: 'E — the subagent answer matches the reviewer it ran',
        passed: /40/.test(settled.result) || /40/.test(reviewerAnswer),
        detail: 'the child ran the same spec and produced a word count'
    });
}

async function main() {
    const { provider, defaultModel, toolModel } = resolveExample();
    log.header({ t: `Example 32 — Agent definition files (${provider})` });
    log.option({ name: 'default model', value: defaultModel || '(empty)', source: 'resolveExample()' });
    log.option({ name: 'tool model', value: toolModel || '(empty)', source: 'spec.model: tool → getToolModel' });

    const yamlPath = await furnish();

    // ── A: the file a non-coder edits ───────────────────────────────────────
    log.section({ t: 'A — the file: agents/reviewer.agent.yaml' });
    const yamlText = await readFile(yamlPath, 'utf8');
    for (const [index, line] of yamlText.split('\n').entries()) {
        log.info({ m: `${String(index + 1).padStart(2)} │ ${line}` });
    }
    log.option({ name: 'script', value: join('agents', 'scripts', 'word-count.mjs'), source: 'declared in the file, resolved by the loader' });

    // ── B: load and validate ────────────────────────────────────────────────
    log.section({ t: 'B — load: strict validation, a frozen spec' });
    const spec = await loadAgentFile({ path: yamlPath });
    log.list({
        title: 'loaded spec',
        items: [
            `name         ${spec.name}`,
            `description  ${spec.description}`,
            `model        ${spec.model.kind}:${spec.model.value}`,
            `groups       ${spec.tools.use.join(', ') || '(none)'}`,
            `selectors    ${spec.tools.allow.join(', ') || '(none)'}`,
            `script       ${spec.tools.definitions[0]?.name} · ${spec.tools.definitions[0]?.size} byte(s) · sha256 ${String(spec.tools.definitions[0]?.scriptHash).slice(0, 16)}…`,
            `frozen       ${Object.isFrozen(spec)} (the loader builds it field by field)`
        ]
    });
    check({ name: 'B — the spec is deep-frozen', passed: Object.isFrozen(spec) && Object.isFrozen(spec.tools.definitions[0]) });
    check({ name: 'B — the script was resolved and hashed at load time', passed: typeof spec.tools.definitions[0]?.scriptHash === 'string' });

    // ── C: the toolbox the host supplies ────────────────────────────────────
    log.section({ t: 'C — toolbox: the host owns the sources, the file selects them' });
    const workspace = { path: WORKSPACE_DIR, root: WORKSPACE_DIR, key: 'example-48' };
    const toolbox = createAgentToolbox({
        workspace,
        approval: approve,
        tools: [lookupPolicy],
        options: { strictDynamic: true }
    });
    const resolved = resolveToolset({ spec, toolbox });
    log.list({
        title: 'resolved toolset',
        items: resolved.names.map((name) => {
            const alias = resolved.aliases[name];
            const origin = alias?.source ?? 'script';
            return `${name.padEnd(18)} ${origin}${alias?.owner ? `:${alias.owner}` : ''}`;
        })
    });
    check({ name: 'C — the files group became real tools', passed: ['read', 'grep', 'glob'].every((name) => resolved.names.includes(name)) });
    check({ name: 'C — the host selector became a real tool', passed: resolved.names.includes('lookup_policy') });
    check({ name: 'C — the declared script became a real tool', passed: resolved.names.includes('word_count') });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    // The SDK event logger is deliberately off here: the point of this program is
    // the model's own tool calls, not the transport. Wire `wireClient({ client })`
    // (from `_shared/example-utils.mjs`) when you want every event.
    client.on('error', (/** @type {any} */ error) => log.error({ m: 'SDK error', d: error?.message ?? error }));
    const usage = trackUsage({ client });

    // ── D: live session ─────────────────────────────────────────────────────
    const reviewerAnswer = await liveSession({ client, model: toolModel, spec, toolbox });

    // ── E: live delegation ──────────────────────────────────────────────────
    await liveDelegation({ client, model: defaultModel, spec, toolbox, reviewerAnswer });

    log.event({ type: 'approvals', payload: { granted: approvals }, detail: 'the script tool asks before it runs; the callback above is the gate' });
    reportUsage({ provider, usage });

    if (failures > 0) {
        log.error({ m: `${failures} check(s) failed.` });
        process.exitCode = 1;
    } else {
        log.success({ m: 'Agent definition files: loaded, resolved, run live, delegated live.' });
    }
    log.info({ m: `files kept under ${WORK_DIR}` });
}

runMain({ mainFn: main });
