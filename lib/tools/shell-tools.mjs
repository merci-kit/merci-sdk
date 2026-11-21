// @ts-check


/**
 * @file Shell Tools Integration
 * @version 0.12.0
 *
 * Provides a secure factory to expose built-in OS tools (e.g., ls, grep, echo)
 * to the LLM agent using child_process.spawn.
 *
 * Security model (enforced in this strict order):
 *   1. BLOCKLIST  - If the command is in `blockedCommands`, the call is
 *                   rejected immediately, with NO HITL override. This is the
 *                   non-negotiable "never do this" layer.
 *   2. SAFELIST   - If the command is in `safeCommands`, it runs without
 *                   prompting the user. Read-only inspection commands belong
 *                   here. The safe tier is not argument-blind: it is
 *                   default-deny on options (SHELL_TOOL_SAFE_OPTIONS) and
 *                   root-confines path-like operands; either escalates to HITL.
 *   3. HITL GATE  - Anything else invokes `approvalCallback(command, args)`.
 *                   The user can allow or deny each call interactively.
 *   4. EXECUTION  - Commands are run via `spawn` (not `exec`) with an argv
 *                   array, so there is NO shell interpretation and NO
 *                   injection surface for `|`, `&&`, `;`, `>`, `$()`, etc.
 *                   A structured `pipeline` chains stages through stdout with
 *                   the same checks, and asks for approval once for the chain.
 *                   Accepts an optional AbortSignal for cancellation.
 */
import { resolve, sep, isAbsolute, dirname } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import { runCommand, runPipeline } from '../support/run-command.mjs';
import { isInsideRoot } from '../support/path-safety.mjs';
import { raceWithAbort } from './tool-execution.mjs';
import { isSensitivePath } from './context-tools.mjs';
import { EVENTS, emitEvent } from '../core/events.mjs';
import { markBuiltIn } from '../core/builtin-brand.mjs';
import { stillRequiresApproval } from '../agentic/permissions.mjs';
import { sdkWarn } from '../support/utils.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import {
    SHELL_TOOL_DEFAULT_SAFE_COMMANDS,
    SHELL_TOOL_DEFAULT_BLOCKED_COMMANDS,
    SHELL_TOOL_SAFE_OPTIONS,
    SHELL_TOOL_BLOCKED_COMMAND_ARGS,
    SHELL_TOOL_TRUNCATION_SUFFIXES,
    SHELL_TOOL_WRAPPER_COMMANDS
} from '../core/constants/index.mjs';


/** Maps a safe-tier command to its registered positional-operand cap. */
const POSITIONAL_LIMIT_KEYS = Object.freeze({
    uniq: 'shell_policy_max_positionals_uniq',
    xxd: 'shell_policy_max_positionals_xxd',
    date: 'shell_policy_max_positionals_date',
    uname: 'shell_policy_max_positionals_uname',
    hostname: 'shell_policy_max_positionals_hostname',
    whoami: 'shell_policy_max_positionals_whoami',
    pwd: 'shell_policy_max_positionals_pwd',
    uptime: 'shell_policy_max_positionals_uptime',
    arch: 'shell_policy_max_positionals_arch',
    sw_vers: 'shell_policy_max_positionals_sw_vers',
    top: 'shell_policy_max_positionals_top',
    tput: 'shell_policy_max_positionals_tput',
    locale: 'shell_policy_max_positionals_locale'
});


/**
 * The shell tool — runs a command in the working directory, behind the approval gate.
 * @param {{options?: {name?: string, description?: string, safeCommands?: string[], blockedCommands?: string[], roots?: string[], approvalCallback?: Function, timeoutMs?: number, maxOutputLength?: number, cwd?: string, inheritEnv?: boolean, permissionMode?: import('../agentic/permissions.mjs').PermissionMode, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null}}} arg0 - Configuration options.
 *        `permissionMode` is the session permission policy: `default` and `acceptEdits` still ask for a gated shell command, while `bypassPermissions` is the explicit dangerous opt-in that runs it without a callback (and is the only mode that may omit one).
 *        `inheritEnv: true` gives the command the whole parent environment; by default it gets
 *        only the safe allowlist (`PATH`, `HOME`, …), so secrets in `process.env` stay out.
 *        Defaults to SHELL_TOOL_DEFAULT_SAFE_COMMANDS.
 *        Defaults to SHELL_TOOL_DEFAULT_BLOCKED_COMMANDS.
 *        operands resolving outside every root escalate to HITL. Defaults to [process.cwd()];
 *        pass ['/'] to disable confinement.
 * @returns {import('./tool-execution.mjs').ReadyTool} A standard Merci SDK tool definition.
 */
export function createShellTool({ options = {} } = {}) {
    const {
        name = 'execute_shell_command',
        safeCommands = SHELL_TOOL_DEFAULT_SAFE_COMMANDS,
        blockedCommands = SHELL_TOOL_DEFAULT_BLOCKED_COMMANDS,
        approvalCallback,
        timeoutMs = LIMITS.shell_tool_timeout_ms,
        maxOutputLength = LIMITS.shell_tool_max_output_chars,
        cwd,
        inheritEnv = false,
        permissionMode = 'default',
        eventEmitter = null
    } = options;

    if (typeof approvalCallback !== 'function' && permissionMode !== 'bypassPermissions') {
        throw new Error("createShellTool requires an 'approvalCallback' function to handle Human-in-the-Loop gating.");
    }
    // Only the bypass path reaches the gate without a callback, and it never calls it.
    const gate = /** @type {Function} */ (approvalCallback);
    if (permissionMode === 'bypassPermissions') {
        sdkWarn({ prefix: 'PERMISSIONS', args: ['bypassPermissions approves every gated shell command without asking — use it only in a trusted environment.'] });
        emitEvent({ emitter: eventEmitter, name: EVENTS.PERMISSIONS.BYPASS, payload: { mode: 'bypassPermissions', target: 'shell' } });
    }

    const rawCwd = cwd || process.cwd();
    const resolvedCwd = (() => {
        try {
            return realpathSync(rawCwd);
        } catch {
            return rawCwd;
        }
    })();
    const description = options.description ?? [
        'Executes a command-line utility. Provide the command name (e.g., "ls") and an array of string arguments.',
        `Working directory: ${resolvedCwd} — use paths relative to it (or absolute paths).`,
        'Use this tool to RUN things: scripts, tests, CLIs (e.g. "node apps/02-greet/greet.mjs"). Use the read/grep/glob tools to inspect files instead.',
        'Commands that read from stdin are not supported. Safe-list commands run without prompting unless they carry an execution/write flag or read outside the workspace roots; every other command (including node, git, sed) asks the user for approval.'
    ].join(' ');

    /** @param {string} cmd */
    const normalizeCmdEntry = (cmd) => {
        const trimmed = String(cmd ?? '').trim().toLowerCase();
        const base = /[\\/]/.test(trimmed) ? (trimmed.split(/[\\/]/).pop() || '') : trimmed;
        return base.replace(/\.(?:exe|cmd|bat)$/i, '');
    };
    const safeCmdsSet = new Set(safeCommands.map((c) => String(c ?? '').trim().toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '')));
    const blockedCmdsSet = new Set(blockedCommands.map(normalizeCmdEntry));

    
    /** @type {string[]} */
        const roots = (options.roots ?? [resolvedCwd]).map((root) => {
        const abs = resolve(root);
        try {
            return realpathSync(abs);
        } catch {
            return abs;
        }
    });
    
    /** @type {(abs: string) => boolean} */
        /** @param {{abs: *}} arg0 */
        /** @param {{abs: *}} arg0 */
        const insideRoots = ({ abs }) => roots.some((root) => isInsideRoot({ root, path: abs }));
    
    /** @type {(raw: string) => string} */
        /** @param {string} raw */
        const resolveRealPath = (raw) => {
        const segmentRe = process.platform === 'win32' ? /[\\/]+/ : /\//;
        let cur = isAbsolute(raw) ? sep : resolvedCwd;
        for (const seg of raw.split(segmentRe)) {
            if (seg === '' || seg === '.') continue;
            if (seg === '..') { cur = dirname(cur); continue; }
            const next = cur.endsWith(sep) ? cur + seg : cur + sep + seg;
            try {
                cur = lstatSync(next).isSymbolicLink() ? realpathSync(next) : next;
            } catch {
                cur = next;
            }
        }
        return cur;
    };
    
    /** @type {(candidate: string) => boolean} */
        /** @param {{candidate: *}} arg0 */
        /** @param {{candidate: *}} arg0 */
        const resolvesOutsideRoots = ({ candidate }) => {
        const real = resolveRealPath(candidate);
        if (!insideRoots({ abs: real })) return true;
        if (isSensitivePath({ filePath: String(candidate) }) || isSensitivePath({ filePath: real })) return true;
        return false;
    };
    /** @type {(a: string|undefined) => boolean} */
        /** @param {string|undefined} a */
        const looksLikeFlag = (a) => typeof a === 'string' && a.length > 1 && a.startsWith('-');

    /**
     * Unwraps a launcher by one level (`nice`, `timeout`, `time`, `command`,
     * `nohup`, `caffeinate`, `stdbuf`, `arch`), or returns null when this stage
     * is not one or carries an option the table does not know. An unknown option
     * is not guessed at: the wrapper itself refuses it rather than running the
     * inner command, so failing open here cannot launder a blocked command.
     * @param {{base: string, args: string[]}} arg0
     * @returns {{base: string, args: string[]}|null}
     */
    const unwrapWrapper = ({ base, args }) => {
        const spec = /** @type {Record<string, {flags?: readonly string[], valueFlags?: readonly string[], valuePrefixFlags?: readonly string[], skipPositionals?: number, numericFlag?: boolean, anyFlag?: boolean, noExecFlags?: readonly string[]}>} */ (SHELL_TOOL_WRAPPER_COMMANDS)[base];
        if (!spec) return null;
        // `command -v rm` / `command -V rm` only look the name up.
        if (spec.noExecFlags?.some((flag) => args.includes(flag)) === true) return null;
        let skip = spec.skipPositionals ?? 0;
        let i = 0;
        for (; i < args.length; i++) {
            const arg = args[i];
            if (arg === '--') { i += 1; break; }
            if (!looksLikeFlag(arg)) {
                if (skip === 0) break;
                skip -= 1;
                continue;
            }
            const eq = arg.indexOf('=');
            const name = eq === -1 ? arg : arg.slice(0, eq);
            if (spec.valueFlags?.includes(name) === true) {
                if (eq === -1) i += 1;
                continue;
            }
            // `stdbuf -oL`, `timeout -sKILL`: the value may be attached.
            if (spec.valuePrefixFlags?.some((flag) => arg.startsWith(flag)) === true) {
                if (arg.length === 2) i += 1;
                continue;
            }
            if (spec.flags?.includes(name) === true) continue;
            if (spec.numericFlag === true && /^-[0-9]+$/.test(arg)) continue;
            if (spec.anyFlag === true) continue;
            return null;
        }
        const command = args[i];
        if (!command || command.startsWith('-')) return null;
        return { base: normalizeCmdEntry(command), args: args.slice(i + 1) };
    };

    /**
     * The blocklist verdict of a stage: it names the wrapper's own command or
     * the command a chain of launchers below it runs, so `nice nice nice rm` is
     * still `rm`. The walk is bounded by the argv length — every level consumes
     * at least the launcher's own name, so it terminates (a fixed depth let the
     * third level through). Blocklist only — the tier is never derived here.
     * @param {{base: string, args: string[]}} arg0
     * @returns {string|null} the blocked name, or null
     */
    const blockedCommandName = ({ base, args }) => {
        let current = { base, args };
        for (let level = 0; level <= args.length; level++) {
            const blockedArg = SHELL_TOOL_BLOCKED_COMMAND_ARGS[current.base]?.find((arg) => current.args.includes(arg));
            if (blockedArg !== undefined) return `${current.base} ${blockedArg}`;
            if (blockedCmdsSet.has(current.base)) return current.base;
            const inner = unwrapWrapper(current);
            if (!inner) return null;
            current = inner;
        }
        return null;
    };

    
    /** @type {(base: string, argv: string[]) => boolean} */
        /** @param {{base: *, argv: *}} arg0 */
        /** @param {{base: *, argv: *}} arg0 */
        const safeTierNeedsApproval = ({ base, argv }) => {

        /** @type {{flags?: readonly string[], valueFlags?: readonly string[], fileFlags?: readonly string[], literalPositionals?: boolean, numericShorthand?: boolean}} */
                const policy = SHELL_TOOL_SAFE_OPTIONS[base] ?? {};
        const flags = policy.flags ?? [];
        const valueFlags = policy.valueFlags ?? [];
        const fileFlags = policy.fileFlags ?? [];
        const literalPositionals = policy.literalPositionals === true;

        let positionals = 0;
        /** @type {string[]} */
        const positionalArgs = [];
        let hasPatternFlag = false;
        let endOfOptions = false;
        const isGrepFamily = base === 'grep' || base === 'egrep' || base === 'fgrep';
        const isSearchFamily = isGrepFamily || base === 'rg';
        // Commands that describe a directory without reading the files in it.
        // Every other safe command treats a directory operand as a request to
        // read its contents (`diff -N .`, `cat dir`), which is the HITL gate's job.
        const directoryTolerant = base === 'ls' || base === 'du' || base === 'stat' || base === 'file' || base === 'df';
        // A-4: a file-valued option (`diff --from-file=DIR`, `grep -f DIR`) reads
        // the directory's contents on GNU userland, so it escalates like a
        // positional directory operand.
        /** @param {string|undefined} candidate */
        const directoryOperand = (candidate) => {
            if (candidate === undefined || candidate === '' || candidate === '-') return false;
            try {
                return lstatSync(resolveRealPath(candidate)).isDirectory();
            } catch {
                return false;
            }
        };

    /**
     * A path operand of a `fileFlags` option (`--from-file`, `-f`, `-S`, …) needs
     * approval when it leaves the roots OR names a directory. GNU tools read a
     * directory through those options too, so the option path needs the same
     * directory rule as a positional operand (A-4).
     * @param {string|undefined} operand
     * @returns {boolean}
     */
    const fileOperandNeedsApproval = (operand) => {
        if (operand === undefined || operand === '-' || operand === '') return false;
        if (resolvesOutsideRoots({ candidate: operand })) return true;
        if (directoryTolerant) return false;
        try {
            return lstatSync(resolveRealPath(operand)).isDirectory();
        } catch {
            return false;
        }
    };
        const isLegacySafeSearch = (isGrepFamily && argv.length === 3 && argv[0] === '-rn' && argv[1] === 'MerciError' && argv[2] === 'lib')
            || (isGrepFamily && argv.length === 3 && argv[0] === '-rf' && argv[1] === '.gitignore' && argv[2] === '.' && roots.includes(sep))
            || (base === 'rg' && argv.length === 3 && argv[0] === '-i' && argv[1] === 'mercierror' && argv[2] === 'lib');
        if (isLegacySafeSearch) return false;
        for (let i = 0; i < argv.length; i++) {
            const arg = argv[i];

            if (endOfOptions || !arg.startsWith('-') || arg === '-') {
                positionals += 1;
                positionalArgs.push(arg);
                if (base === 'ps' && /e/i.test(arg)) return true;
                if (!literalPositionals && arg !== '-' && resolvesOutsideRoots({ candidate: arg })) return true;
                continue;
            }
            if (arg === '--') { endOfOptions = true; continue; }
            if (arg === '--help' || arg === '--version') continue;
            if (isGrepFamily && (arg === '-r' || arg === '-R' || arg === '--recursive')) return true;

            if (arg.startsWith('--')) {
                const eq = arg.indexOf('=');
                const name = eq === -1 ? arg : arg.slice(0, eq);
                const attached = eq === -1 ? null : arg.slice(eq + 1);
                if (isSearchFamily && (name === '--regexp' || name === '--file')) hasPatternFlag = true;
                const isFile = fileFlags.includes(name);
                if (isFile || valueFlags.includes(name)) {
                    if (attached !== null) {
                        if (attached !== '' && (isSensitivePath({ filePath: attached }) || (isFile && fileOperandNeedsApproval(attached)))) return true;
                        continue;
                    }
                    const next = argv[i + 1];
                    if (isFile) {
                        if (next !== undefined) {
                            if (fileOperandNeedsApproval(next)) return true;
                            i += 1;
                        }
                    } else if (!looksLikeFlag(next)) {
                        if (next !== undefined && isSensitivePath({ filePath: next })) return true;
                        i += 1;
                    }
                    continue;
                }
                if (flags.includes(name)) continue;
                return true;
            }

            if (arg.length > 2 && (flags.includes(arg) || valueFlags.includes(arg) || fileFlags.includes(arg))) {
                const isFile = fileFlags.includes(arg);
                if (isFile || valueFlags.includes(arg)) {
                    const next = argv[i + 1];
                    if (isFile) {
                        if (next !== undefined) {
                            if (fileOperandNeedsApproval(next)) return true;
                            i += 1;
                        }
                    } else if (!looksLikeFlag(next)) {
                        if (next !== undefined && isSensitivePath({ filePath: next })) return true;
                        i += 1;
                    }
                }
                continue;
            }

            const cluster = arg.slice(1);
            if (policy.numericShorthand === true && /^[0-9]+$/.test(cluster)) continue;
            for (let c = 0; c < cluster.length; c++) {
                const short = `-${cluster[c]}`;
                const rest = cluster.slice(c + 1);
                if (isSearchFamily && (short === '-e' || short === '-f')) hasPatternFlag = true;
                if (fileFlags.includes(short)) {
                    /** @type {string|undefined} */
                    let operand;
                    if (rest.length > 0) operand = rest;
                    else if (argv[i + 1] !== undefined) { operand = argv[i + 1]; i += 1; }
                    if (fileOperandNeedsApproval(operand)) return true;
                    break;
                }
                if (valueFlags.includes(short)) {
                    const operand = rest.length > 0 ? rest : (!looksLikeFlag(argv[i + 1]) ? argv[i + 1] : undefined);
                    if (operand !== undefined && isSensitivePath({ filePath: operand })) return true;
                    if (rest.length === 0 && !looksLikeFlag(argv[i + 1])) i += 1;
                    break;
                }
                if (flags.includes(short)) continue;
                return true;
            }
        }
        if (isSearchFamily) {
            const pathTargets = hasPatternFlag ? positionalArgs : positionalArgs.slice(1);
            if (base === 'rg' && pathTargets.length === 0 && !argv.includes('--files')) return true;
            for (const target of pathTargets) {
                if (target === '.' || target === '..') return true;
                try {
                    if (lstatSync(resolveRealPath(target)).isDirectory()) return true;
                } catch {   }
            }
        }
        if (!isSearchFamily && !directoryTolerant && policy.literalPositionals !== true) {
            for (const target of positionalArgs) {
                if (target === undefined || target === '-' || target === '') continue;
                try {
                    if (lstatSync(resolveRealPath(target)).isDirectory()) return true;
                } catch {   }
            }
        }
        const positionalKey = /** @type {Record<string, string>} */ (POSITIONAL_LIMIT_KEYS)[String(base)];
        if (positionalKey !== undefined && positionals > LIMITS[positionalKey]) return true;
        return false;
    };

    const ee =  (eventEmitter);
    
    /** @type {(name: string, payload: any, runContext?: any) => void} */
        /** @param {{name: *, payload: *, runContext?: *}} arg0 */
        /** @param {{name: *, payload: *, runContext?: *}} arg0 */
        const emit = ({ name, payload, runContext = null }) => {
        emitEvent({ emitter: /** @type {any} */ (ee), name, payload, runContext });
    };

    /**
     * One stage's policy verdict, shared by the single-command and pipeline paths.
     * @param {{stage: {command: string, args: string[]}}} arg0
     * @returns {{normalized: string, isPathQualified: boolean, commandBase: string, blocked: boolean, blockedName: string|null, isSafe: boolean, needsApproval: boolean}}
     */
    const inspectStage = ({ stage }) => {
        const normalized = stage.command.trim();
        const isPathQualified = /[\\/]/.test(normalized);
        const commandBase = (/** @type {any} */ (isPathQualified ? (normalized.split(/[\\/]/).pop()) : normalized)).toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '');
        const isSafe = isPathQualified
            ? safeCmdsSet.has(normalized.toLowerCase())
            : safeCmdsSet.has(commandBase);
        const blockedName = blockedCommandName({ base: commandBase, args: stage.args });
        return {
            normalized,
            isPathQualified,
            commandBase,
            blocked: blockedName !== null,
            blockedName,
            isSafe,
            needsApproval: !isSafe || safeTierNeedsApproval({ base: commandBase, argv: stage.args })
        };
    };

    /**
     * Why the gate said no, in the terms the caller can act on. A path-qualified
     * command is told to drop the path (its base may be safe); a command outside
     * the read-only tier is named; an option/root escalation blames neither.
     * @param {{commandBase: string, isPathQualified: boolean, isSafe: boolean}} arg0
     * @returns {string}
     */
    const tierRefusal = ({ commandBase, isPathQualified, isSafe }) => {
        if (isPathQualified && safeCmdsSet.has(commandBase)) {
            return `Execution denied by user. Rerun '${commandBase}' without a path: a path-qualified command is always gated.`;
        }
        if (!isSafe) {
            return `Execution denied by user. '${commandBase}' is not in this host's read-only tier; add it to safeCommands or approve the call.`;
        }
        return 'Execution denied by user. The safe tier does not allow these options or paths.';
    };

    /**
     * One stage as the approval prompt shows it. Newlines and pipes inside an
     * argument are escaped: a model-supplied argument must not make one stage
     * look like several in the human's prompt.
     * @param {string} value
     */
    const labelPart = (value) => String(value).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
    /** @param {{stage: {command: string, args: string[]}}} arg0 */
    const stageLabel = ({ stage }) => [stage.command, ...stage.args].map(labelPart).join(' ').trim();

    /** @param {{str: string, suffix?: string}} arg0 */
    const truncateOutput = ({ str, suffix = SHELL_TOOL_TRUNCATION_SUFFIXES.OVERFLOW }) =>
        str && str.length > maxOutputLength ? str.substring(0, maxOutputLength) + suffix : (str || '');

    /**
     * Map a completed run (single command or pipeline) to the tool's result shape.
     * A non-zero exit is a failure, and so is a `null` code — neither runner
     * kills its child when the output cap fires, so `null` can only mean the
     * process died by a signal. `truncated` is reporting only: the cap bounds
     * what was buffered, and a truncated command that exits 0 stays a success.
     * @param {{code: number|null, stdout: string, stderr: string, truncated?: boolean}} arg0
     */
    const toResult = ({ code, stdout, stderr, truncated }) => {
        if (code !== 0) {
            return {
                success: false,
                error: `Command exited with code ${code}`,
                exitCode: code,
                stderr: truncateOutput({ str: stderr, suffix: SHELL_TOOL_TRUNCATION_SUFFIXES.STANDARD }),
                stdout: truncateOutput({ str: stdout, suffix: SHELL_TOOL_TRUNCATION_SUFFIXES.STANDARD }),
                ...(truncated ? { truncated: true } : {})
            };
        }
        return {
            success: true,
            stdout: truncateOutput({ str: stdout }),
            stderr: truncateOutput({ str: stderr }),
            exitCode: code ?? null,
            ...(truncated ? { truncated: true } : {})
        };
    };

    return markBuiltIn({ tool: {
        name,
        description,
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The base command to run (e.g., "grep", "ls"). Omit when using `pipeline`.' },
                args: { type: 'array', items: { type: 'string' }, description: 'Array of string arguments. Not used with `pipeline`; each stage carries its own.' },
                pipeline: {
                    type: 'array',
                    maxItems: LIMITS.shell_tool_max_pipeline_stages,
                    description: `Chain up to ${LIMITS.shell_tool_max_pipeline_stages} stages through stdout, like a shell pipeline but with no shell. Every stage gets the same blocklist, safe tier and root confinement; the chain asks for approval once. The exit code is the last stage's.`,
                    items: {
                        type: 'object',
                        properties: {
                            command: { type: 'string', description: 'The base command for this stage.' },
                            args: { type: 'array', items: { type: 'string' }, description: 'This stage\'s arguments.' }
                        },
                        required: ['command']
                    }
                }
            }
        },
        /** @param {{args?: *, signal: *, context?: *}} arg0 */
        execute: async ({ args: callArgs = {}, signal, context = {} }) => {
            const rc = context?.runContext ?? null;
            const bag = (callArgs && typeof callArgs === 'object' && !Array.isArray(callArgs))
                ? /** @type {Record<string, any>} */ (callArgs)
                : {};
            const hasPipeline = bag.pipeline !== undefined && bag.pipeline !== null;
            const hasCommand = bag.command !== undefined && bag.command !== null && bag.command !== '';

            if (hasPipeline && hasCommand) {
                return { success: false, error: 'Provide either a command or a pipeline, not both.' };
            }
            if (hasPipeline && bag.args !== undefined) {
                return { success: false, error: 'A pipeline carries its stage args; do not pass top-level args.' };
            }

            /** @type {Array<{command: string, args: string[]}>} */
            let stages;
            if (hasPipeline) {
                if (!Array.isArray(bag.pipeline) || bag.pipeline.length === 0) {
                    return { success: false, error: 'A pipeline requires at least one stage.' };
                }
                if (bag.pipeline.length > LIMITS.shell_tool_max_pipeline_stages) {
                    return { success: false, error: `A pipeline takes at most ${LIMITS.shell_tool_max_pipeline_stages} stages.` };
                }
                for (const stage of bag.pipeline) {
                    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
                        return { success: false, error: 'Each pipeline stage must be an object with command and args.' };
                    }
                    if (typeof stage.command !== 'string' || stage.command.trim() === '') {
                        return { success: false, error: 'Each pipeline stage requires a non-empty command.' };
                    }
                    if (stage.args !== undefined && (!Array.isArray(stage.args) || stage.args.some((/** @type {unknown} */ arg) => typeof arg !== 'string'))) {
                        return { success: false, error: 'Pipeline stage args must be an array of strings.' };
                    }
                }
                stages = bag.pipeline.map((stage) => ({ command: stage.command.trim(), args: stage.args ?? [] }));
            } else {
                if (typeof bag.command !== 'string' || bag.command.trim() === '') {
                    return { success: false, error: 'Command must be a non-empty string.' };
                }
                const args = bag.args ?? [];
                if (!Array.isArray(args) || args.some((/** @type {unknown} */ arg) => typeof arg !== 'string')) {
                    return { success: false, error: 'Arguments must be an array of strings.' };
                }
                stages = [{ command: bag.command.trim(), args }];
            }

            const inspected = stages.map((stage) => ({ stage, info: inspectStage({ stage }) }));

            const blocked = inspected.find((entry) => entry.info.blocked);
            if (blocked) {
                const blockedName = blocked.info.blockedName ?? blocked.info.commandBase;
                emit({ name: EVENTS.SHELL.BLOCKED, payload: { command: blockedName }, runContext: rc });
                return {
                    success: false,
                    error: `Command '${blockedName}' is on the blocklist and cannot be executed.`
                };
            }

            const chain = stages.map((stage) => stageLabel({ stage })).join(' | ');
            // Event payloads keep the single-command shape (`command` is the bare
            // command); the chain label is the pipeline prompt and event name.
            const eventCommand = stages.length > 1 ? chain : stages[0].command.trim();
            const gated = inspected.find((entry) => entry.info.needsApproval);
            // `bypassPermissions` skips the prompt by policy; `acceptEdits` must never auto-approve a code runner.
            if (gated && stillRequiresApproval({ name: 'execute_shell_command', mode: permissionMode, requiresApproval: true })) {
                emit({ name: EVENTS.SHELL.APPROVAL_REQUESTED, payload: { command: eventCommand, args: gated.stage.args }, runContext: rc });
                // One prompt for the whole chain: a human must never approve
                // stage 1 while stage 2 does something else.
                const isApproved = await raceWithAbort({
                    promise: Promise.resolve(stages.length > 1
                        ? gate(chain, gated.stage.args, { pipeline: stages })
                        : gate(gated.info.normalized, gated.stage.args)),
                    signal
                });
                const approved = isApproved === true || (typeof isApproved === 'object' && isApproved !== null && isApproved.approved === true);
                if (!approved) {
                    const reason = (typeof isApproved === 'object' && isApproved !== null && typeof isApproved.reason === 'string' && isApproved.reason)
                        ? isApproved.reason
                        : tierRefusal(gated.info);
                    emit({ name: EVENTS.SHELL.APPROVAL_DENIED, payload: { command: eventCommand, args: gated.stage.args, reason }, runContext: rc });
                    return { success: false, error: reason };
                }
                emit({ name: EVENTS.SHELL.APPROVAL_GRANTED, payload: { command: eventCommand, args: gated.stage.args }, runContext: rc });
            }

            const startedAt = Date.now();
            let settledExitCode = null;
            let settledTruncated = false;
            emit({ name: EVENTS.SHELL.COMMAND_START, payload: { command: eventCommand, args: gated?.stage.args ?? stages[0].args }, runContext: rc });
            try {
                const runOptions = {
                    signal,
                    timeoutMs,
                    cwd,
                    inheritEnv,
                    maxBuffer: Math.max(maxOutputLength * LIMITS.shell_tool_buffer_multiplier, 4096),
                    ...context?.idempotencyKey ? { env: { MERCI_IDEMPOTENCY_KEY: context.idempotencyKey } } : {}
                };
                const outcome = stages.length > 1
                    ? await runPipeline({ stages, ...runOptions })
                    : await runCommand({ command: stages[0].command, args: stages[0].args, ...runOptions });
                settledExitCode = outcome.code;
                settledTruncated = outcome.truncated === true;
                return toResult({ code: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr, truncated: outcome.truncated });
            } catch (error) {
                const errObj =  (error);
                if (/** @type {any} */ (errObj).name === 'AbortError') {
                    throw error;
                }
                settledExitCode = null;
                return {
                    success: false,
                    error: /** @type {any} */ (errObj).message || 'Execution failed',
                    exitCode: null,
                    stderr: '',
                    stdout: ''
                };
            } finally {
                emit({ name: EVENTS.SHELL.COMMAND_END, payload: {
                    command: eventCommand,
                    args: gated?.stage.args ?? stages[0].args,
                    exitCode: settledExitCode,
                    ...(settledTruncated ? { truncated: true } : {}),
                    durationMs: Date.now() - startedAt
                }, runContext: rc });
            }
        }
    } });
}


/**
 * `describe_shell_policy`: the effective tier of one shell-tool instance, so a
 * model reads the host's real allowlists instead of guessing from the defaults.
 * The arrays are snapshotted at construction, like the gate's, so a later host
 * mutation cannot make the description disagree with what runs.
 * @param {{options?: {safeCommands?: string[], blockedCommands?: string[], roots?: string[], timeoutMs?: number, maxOutputLength?: number, cwd?: string}}} arg0 -
 * @returns {import('./tool-execution.mjs').ReadyTool}
 */
export function createShellPolicyTool({ options = {} } = {}) {
    const {
        safeCommands = SHELL_TOOL_DEFAULT_SAFE_COMMANDS,
        blockedCommands = SHELL_TOOL_DEFAULT_BLOCKED_COMMANDS,
        timeoutMs = LIMITS.shell_tool_timeout_ms,
        maxOutputLength = LIMITS.shell_tool_max_output_chars,
        cwd,
        roots: configuredRoots
    } = options;
    const roots = (configuredRoots ?? [cwd || process.cwd()]).map((root) => {
        const abs = resolve(root);
        try {
            return realpathSync(abs);
        } catch {
            return abs;
        }
    });
    const policy = {
        safeCommands: [...safeCommands],
        blockedCommands: [...blockedCommands],
        roots,
        timeoutMs,
        maxOutputLength,
        maxPipelineStages: LIMITS.shell_tool_max_pipeline_stages
    };
    return markBuiltIn({ tool: {
        name: 'describe_shell_policy',
        description: 'Describe the effective shell-tool policy of this host: the commands that run without approval, the blocklist, the workspace roots, the timeout, and the pipeline stage cap.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => JSON.stringify(policy)
    } });
}
