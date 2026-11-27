// @ts-check


/**
 * @file SkillsLibrary — dual-mode loadable skills component.
 * @version 0.12.0
 *
 * @description
 * `SkillsLibrary` exposes the in-memory skill set as a loadable component
 * whose load tool lists skills for the model. `loadSkillsFromDirectory`
 * scans a skills directory (SKILL.md frontmatter + optional scripts/) into
 * SDK tool definitions.
 */
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { join, extname } from 'node:path';
import { runCommand } from '../support/run-command.mjs';
import { CAPABILITY, CAPABILITY_REGISTRY, LOAD_SKILLS_TOOL_NAME } from '../core/constants/index.mjs';
import { EVENTS, emitEvent } from '../core/events.mjs';
import { LoadableComponent } from '../core/loadable.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { capToolOutput } from './external-capability.mjs';
import { SCRIPT_INTERPRETERS } from './script-tools.mjs';
import { sdkWarn } from '../support/utils.mjs';

const require = createRequire(import.meta.url);


/**
 * The `---`-fenced frontmatter block of a SKILL.md, plus its markdown body.
 * @type {RegExp}
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;


/**
 * Parses a SKILL.md frontmatter block. The frontmatter is YAML by
 * specification (the agent-skills convention every major agent SDK reads);
 * a malformed block throws so the loader can skip that skill instead of
 * crashing the whole directory.
 * @param {{rawYaml: string}} arg0 - The raw text between the `---` fences.
 * @returns {Record<string, any>} The parsed mapping (empty for an empty block).
 */
function parseFrontmatter({ rawYaml }) {
    try {
        const { parse } = require('yaml');
        const parsed = parse(rawYaml);
        if (parsed == null) return {};
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('frontmatter must be a YAML mapping');
        }
        return parsed;
    } catch (err) {
        // YAML is the specification, but a frontmatter the old `key: value`
        // reader understood (an unquoted colon in a value, for instance) must
        // not stop loading: the legacy reader is the fallback, and the author
        // is told the file is not valid YAML.
        const legacy = legacyFrontmatter({ rawYaml });
        if (Object.keys(legacy).length === 0) throw err;
        const reason = String((/** @type {any} */ (err))?.message ?? err);
        sdkWarn({ prefix: 'SKILLS', args: [`Frontmatter is not valid YAML (${reason}) — parsed with the legacy reader.`] });
        return legacy;
    }
}


/**
 * The pre-YAML reader: one `key: value` per line, the value keeping every
 * colon after the first. It is the fallback for a frontmatter that YAML
 * rejects but the old reader understood.
 * @param {{rawYaml: string}} arg0
 * @returns {Record<string, any>}
 */
function legacyFrontmatter({ rawYaml }) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const line of String(rawYaml).split('\n')) {
        const parts = line.split(':');
        if (parts.length < 2) continue;
        const key = parts[0].trim();
        if (!key) continue;
        const value = parts.slice(1).join(':').trim().replace(/^(["'])(.*)\1$/, '$2');
        out[key] = value;
    }
    return out;
}


/**
 * Coerces a frontmatter value into a display string. A non-scalar (list or
 * map) has no meaningful string form and falls back to the caller's default.
 * @param {{value: *, fallback: string}} arg0 - The raw frontmatter value and its default.
 * @returns {string} The string form of the value, or the fallback.
 */
function scalarText({ value, fallback }) {
    if (typeof value === 'string') return value.trim() || fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return fallback;
}


/**
 * Normalizes a frontmatter tool list (a YAML list or a comma-separated string).
 * @param {{value: *}} arg0 - The raw frontmatter value.
 * @returns {string[]} The tool names, in frontmatter order.
 */
function toolNames({ value }) {
    if (value == null) return [];
    const raw = Array.isArray(value) ? value : String(value).split(',');
    return raw.map((v) => String(v).trim()).filter(Boolean);
}


/**
 * Lists every runnable script of a skill's `scripts/` directory, name-sorted.
 * The first entry is the default script (the legacy single-script behaviour).
 * @param {{scriptsDir: string}} arg0 - The skill's scripts directory.
 * @returns {Promise<Array<{name: string, path: string, interpreter: string}>>} The runnable scripts.
 */
async function listScripts({ scriptsDir }) {
    /** @type {Array<string>} */
    let names = [];
    try {
        const entries = await fs.readdir(scriptsDir, { withFileTypes: true });
        names = entries
            .filter((e) => e.isFile() && SCRIPT_INTERPRETERS.has(extname(e.name).toLowerCase()))
            .map((e) => e.name)
            .sort();
    } catch {
        return [];
    }
    return names.map((name) => ({
        name,
        path: join(scriptsDir, name),
        interpreter: /** @type {string} */ (SCRIPT_INTERPRETERS.get(extname(name).toLowerCase()))
    }));
}


/**
 * A skill the library lists: its name, one-line description and the usage
 * instructions the model reads.
 * @typedef {Object} SkillEntry
 * @property {string} [name]
 * @property {string} [description]
 * @property {string|null} [instructions]
 * @property {Object} [metadata]
 */

/**
 * A skill tool definition as the loader builds it: the executor's shape,
 * `execute` always present, plus what the loader attaches — the command, the
 * SKILL.md body, the runnable scripts and the normalized frontmatter.
 * @typedef {import('./tool-execution.mjs').ToolDefinition & {execute: Function, parameters: import('../support/json.mjs').JsonSchema, command?: string|null, instructions?: string|null, scripts?: Array<{name: string, path: string, interpreter: string}>, metadata?: {frontmatter?: Record<string, unknown>, allowedTools?: Array<string>}}} SkillTool
 */

/**
 * Loadable component exposing the registered skills to the model via a
 * list-skills load tool.
 * @extends {LoadableComponent}
 */
export class SkillsLibrary extends LoadableComponent {
    /** @type {Array<SkillEntry>} */
    skills;
    /** @type {number} */
    maxCatalogChars;

    /**
      * @param {{skills?: Array<SkillEntry>, maxCatalogChars?: number, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null}} arg0
     */
        constructor({ skills = [], maxCatalogChars = LIMITS.skill_catalog_chars, eventEmitter = null } = {}) {
        super({
            id: CAPABILITY.SKILLS,
            loadToolName: LOAD_SKILLS_TOOL_NAME,
            loadDescription: 'List the available skills with their names and descriptions. Call this tool with { "name": "<skill>" } to read a skill\'s instructions; a skill that ships scripts runs one only when you name the script.',
            loadParameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill to read. Omit to list the catalog.' }
                },
                required: []
            },
            announce: CAPABILITY_REGISTRY[CAPABILITY.SKILLS]?.announce ?? null,
            eventEmitter
        });
        this.skills =  (Array.isArray(skills) ? skills : []);
        this.maxCatalogChars = Number.isInteger(maxCatalogChars) && maxCatalogChars > 0 ? maxCatalogChars : LIMITS.skill_catalog_chars;
    }

    
    /**
     * @param {{preload?: boolean}} [ctx]
     */
        async shouldInjectStep(ctx = {}) {
        return !!ctx?.preload;
    }

    async stepBlock() {
        return this.load();
    }

    
    /**
     * Builds the model-visible skill catalog: name plus description, never the
     * body. The body costs 10-40x the catalog and pushes the trigger text out of
     * view, so it is loaded only when the model asks for it by name. Over
     * budget, whole entries are dropped (never truncated mid-word) and the
     * omission is stated.
     * @param {{name?: unknown}} [args] - `name` reads that skill's instructions.
     * @returns {Promise<string>} The catalog, or the requested skill's body.
     */
        async load(args = {}) {
        const requested = args && typeof args === 'object' && typeof args.name === 'string'
            ? args.name.trim()
            : '';
        if (requested) {
            const skill = this.skills.find((entry) => entry && entry.name === requested);
            if (!skill) return `No skill named '${requested}'.\n\n${await this.load()}`;
            const body = skill.instructions;
            return typeof body === 'string' && body.trim() ? body.trim() : `Skill '${requested}' has no instructions.`;
        }
        if (!this.skills.length) return 'No skills are currently available.';
        const header = '=== Available Skills ===\n';
        /** @type {string[]} */
        const lines = [];
        for (const s of this.skills) {
            if (!s || !s.name) continue;
            lines.push(`* ${s.name}: ${s.description || 'No description provided.'}\n`);
        }
        if (!lines.length) return 'No skills are currently available.';
        const budget = this.maxCatalogChars;
        /** @param {number} count */
        const omitted = (count) => `... ${count} skill${count === 1 ? '' : 's'} not listed (catalog budget ${budget} chars). Call the skill by name to load it.\n`;
        // A budget smaller than the header plus the omission notice cannot list
        // anything; return the notice clipped to the ceiling rather than exceed it.
        if (budget < header.length + omitted(lines.length).length) {
            return (header + omitted(lines.length)).slice(0, budget);
        }
        let out = header;
        let kept = 0;
        for (const line of lines) {
            const remaining = lines.length - kept - 1;
            const tail = remaining > 0 ? omitted(remaining) : '';
            if (out.length + line.length + tail.length > budget) break;
            out += line;
            kept += 1;
        }
        const remaining = lines.length - kept;
        if (remaining > 0) out += omitted(remaining);
        return out;
    }
}


/**
 * Missing roots and missing SKILL.md files are normal skips; corruption is
 * surfaced via sdkWarn and the SKILLS.LOAD_ERROR event. A skill's frontmatter
 * is YAML by specification — it is parsed with the `yaml` package, so lists,
 * nested maps, quoted strings and block scalars all survive into
 * `tool.metadata.frontmatter`.
 * Security: a skill script is arbitrary code in a directory any session write
 * primitive can modify, so a script-carrying tool is HITL-gated per call
 * (`requiresApproval({ args })` is true only when the call selects a script —
 * executeTools consults it, fail closed). Pass
 * `{ requireScriptApproval: false }` only for trusted, read-only skills roots;
 * the flag lives on the CALLER, never in frontmatter (attacker-controllable).
 * A call with no `script` returns the instructions and runs nothing; a call
 * selects one script by exact name.
 * @param {{directory: string, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, requireScriptApproval?: boolean, inheritEnv?: boolean}} arg0 - Root skills directory.
 *   `inheritEnv: true` gives a skill script the whole parent environment; by default it gets only the safe allowlist.
 * @returns {Promise<Array<SkillTool>>} SDK tool definitions.
 */
export async function loadSkillsFromDirectory({ directory, eventEmitter = null, requireScriptApproval = true, inheritEnv = false }) {
    const ee =  (eventEmitter);
    
    /** @type {(name: string, payload: any) => void} */
        /** @param {{name: *, payload: *}} arg0 */
        /** @param {{name: *, payload: *}} arg0 */
        const emit = ({ name, payload }) => {
        emitEvent({ emitter: /** @type {any} */ (ee), name, payload });
    };
    const tools = [];
    try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillDir = join(directory, entry.name);
            const skillMdPath = join(skillDir, 'SKILL.md');
            try {
                const content = (await fs.readFile(skillMdPath, 'utf8')).replace(/^\uFEFF/, '');
                const match = content.match(FRONTMATTER_RE);
                if (!match) continue;
                const rawYaml = match[1];
                const body = match[2];

                /** @type {Record<string, any>} */
                let fm;
                try {
                    fm = parseFrontmatter({ rawYaml });
                } catch (e) {
                    const yamlErr =  (e);
                    const message = /** @type {any} */ (yamlErr).message ?? String(e);
                    sdkWarn({ prefix: 'SKILLS', args: [`Skill "${entry.name}": invalid YAML frontmatter skipped — ${message}`] });
                    emit({ name: EVENTS.SKILLS.LOAD_ERROR, payload: { dir: skillDir, error: message } });
                    continue;
                }

                const name = scalarText({ value: fm.name, fallback: entry.name });
                const description = scalarText({ value: fm.description, fallback: 'No description provided.' });
                const commandRaw = fm.command || fm.alias || null;
                const command = (commandRaw == null || typeof commandRaw === 'object') ? null : String(commandRaw).trim();

                let parameters = { type: 'object', properties: {} };
                if (fm.parameters) {
                    if (typeof fm.parameters === 'object' && !Array.isArray(fm.parameters)) {
                        // The frontmatter is YAML, so a schema is naturally
                        // written as a YAML mapping. The JSON string form is
                        // accepted too, but dropping a mapping would leave the
                        // tool advertised with an EMPTY schema — the model then
                        // has no idea which arguments the tool takes.
                        parameters = fm.parameters;
                    } else {
                        // The legacy JSON-string form is accepted too, but a
                        // schema must be a mapping: a JSON list (or scalar)
                        // would advertise the tool with a non-object schema.
                        /** @type {any} */
                        let parsed = null;
                        try { parsed = JSON.parse(String(fm.parameters)); } catch { parsed = null; }
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            parameters = parsed;
                        } else {
                            sdkWarn({ prefix: 'SKILLS', args: [`Skill "${entry.name}": invalid parameters JSON ignored.`] });
                        }
                    }
                }

                const scripts = await listScripts({ scriptsDir: join(skillDir, 'scripts') });
                if (scripts.length > 0) {
                    // The model can see what it may run before it runs it; the
                    // name is the only selector (no path, no arguments).
                    parameters = {
                        ...parameters,
                        properties: {
                            ...(parameters.properties ?? {}),
                            script: {
                                type: 'string',
                                enum: scripts.map((s) => s.name),
                                description: 'Runnable script to execute. Omit to read the skill instructions.'
                            }
                        }
                    };
                }
                /** A script run is gated per call; reading the instructions is not. */
                /** @type {((arg0: {args?: any}) => boolean)|undefined} */
                const scriptGate = scripts.length > 0 && requireScriptApproval
                    ? ({ args }) => Boolean(args && typeof args === 'object' && !Array.isArray(args) && args.script !== undefined && args.script !== null)
                    : undefined;

                tools.push({
                    name,
                    description,
                    parameters,
                    // A skill with scripts runs code: `acceptEdits` must not
                    // auto-approve it just because the name looks like an edit.
                    ...(scripts.length > 0 ? { runsCode: true } : {}),
                    ...(scriptGate ? { requiresApproval: scriptGate } : {}),
                    command,
                    instructions: body ? body.trim() : null,
                    scripts,
                    metadata: {
                        frontmatter: { ...fm },
                        allowedTools: toolNames({ value: fm['allowed-tools'] ?? fm.allowedTools })
                    },
                    /** @param {{args: *, signal: *, context?: *}} arg0 */
                    execute: async ({ args, signal, context = {} }) => {
                        if (scripts.length > 0) {
                            const bag = (args && typeof args === 'object' && !Array.isArray(args)) ? /** @type {Record<string, any>} */ (args) : null;
                            const selector = bag ? bag.script : undefined;
                            if (selector === undefined || selector === null) {
                                // Reading must never run code: the instructions and
                                // the runnable names are the whole response.
                                const instructions = body && body.trim() ? body.trim() : 'No instructions.';
                                return capToolOutput({ text: `${instructions}\n\nRunnable scripts: ${scripts.map((s) => s.name).join(', ')}\nCall this tool with { "script": "<name>" } to run one.`, maxLength: LIMITS.skill_output_chars });
                            }
                            const chosen = scripts.find((s) => s.name === selector);
                            if (!chosen) {
                                throw new Error(`Skill '${name}' has no script named '${String(selector)}'. Available scripts: ${scripts.map((s) => s.name).join(', ')}`);
                            }
                            const payload = { ...bag };
                            delete payload.script;
                            const { code, stdout, stderr } = await runCommand({ command: chosen.interpreter, args: [chosen.path, JSON.stringify(payload)], signal, timeoutMs: LIMITS.skill_script_timeout_ms, inheritEnv, ...context?.idempotencyKey ? { env: { MERCI_IDEMPOTENCY_KEY: context.idempotencyKey } } : {} });
                            if (code === 0) return capToolOutput({ text: stdout.trim(), maxLength: LIMITS.skill_output_chars });
                            throw new Error(`Skill script failed: ${capToolOutput({ text: stderr.trim() || stdout.trim(), maxLength: LIMITS.skill_output_chars })}`);
                        }
                        return capToolOutput({ text: `Skill '${name}' loaded. Instructions: ${body}`, maxLength: LIMITS.skill_output_chars });
                    }
                });
            } catch (e) {
                const errObj =  (e);
                if (/** @type {any} */ (errObj).code !== 'ENOENT') {
                    sdkWarn({ prefix: 'SKILLS', args: [`Failed to load skill dir "${entry.name}": ${/** @type {any} */ (errObj).message}`] });
                    emit({ name: EVENTS.SKILLS.LOAD_ERROR, payload: { dir: join(directory, entry.name), error: /** @type {any} */ (errObj).message ?? String(e) } });
                }
            }
        }
    } catch (e) {
        const errObj =  (e);
        if (/** @type {any} */ (errObj).code !== 'ENOENT') {
            sdkWarn({ prefix: 'SKILLS', args: [`Failed to read skills directory "${directory}": ${/** @type {any} */ (errObj).message}`] });
            emit({ name: EVENTS.SKILLS.LOAD_ERROR, payload: { dir: directory, error: /** @type {any} */ (errObj).message ?? String(e) } });
        }
    }
    emit({ name: EVENTS.SKILLS.LOADED, payload: { count: tools.length, names: tools.map(t => t.name) } });
    return tools;
}
