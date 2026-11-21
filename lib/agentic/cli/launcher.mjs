// @ts-check


/**
 * @file CLI command launcher: dispatch + interactive agent loop.
 * @version 0.12.0
 *
 * @description
 * `AgentLauncher` runs an interactive chat over a backend session: system
 * commands (/help, /history, ...), skill-plugin dispatch with parameter
 * extraction, and an agentic step loop with tool results fed back.
 * `CommandDispatcher` parses /command lines; `CommandSuggestionSource`
 * powers the completer.
 */
import { EventEmitter } from 'node:events';
import { COMMAND_PREFIX, SystemCommand, SYSTEM_COMMAND_DESCRIPTIONS, FALLBACK_MESSAGE, DEFAULT_EXTRACTOR_PERSONA } from '../../core/constants/index.mjs';
import { LIMITS, getLimits, setLimits } from '../../core/limit-config.mjs';
import { EVENTS, stampEvent } from '../../core/events.mjs';
import { log } from '../../support/utils.mjs';
import { stepAgentic } from '../agentic-core.mjs';
import {
    createUserMessage,
    createToolCallMessage,
    createToolResultMessage
} from '../../messaging/messages.mjs';
import { CommandSuggestionSource } from './suggestion-source.mjs';


/**
 * A skill command the launcher can bind: the /command name and the tool it runs.
 * @typedef {Object} LauncherSkill
 * @property {string} [command]
 * @property {string} [name]
 * @property {string} [description]
 * @property {Object} [parameters]
 */

/**
 * A step stream event as the REPL reads it: text, tool requests, their calls,
 * and the signature that rides along with them.
 * @typedef {Object} LauncherStepEvent
 * @property {string} [type]
 * @property {string} [content]
 * @property {string} [thoughtSignature]
 * @property {string} [thought_signature]
 * @property {Array<{id?: string, name?: string, args?: Object, arguments?: Object, thoughtSignature?: string, thought_signature?: string, function?: {name?: string, arguments?: Object}}>} [calls]
 */

/**
 * The session surface the REPL drives (the backend's own object).
 * @typedef {Object} LauncherSession
 * @property {string} [provider]
 * @property {(arg0: {tools: Array<Object>}) => LauncherSession} withTools
 * @property {(message: string) => LauncherSession} withSystemMessage
 * @property {(arg0: {params: Function}) => LauncherSession} withParameters
 * @property {(arg0: {messages: Array<import('../../messaging/unified-message.mjs').MessageRow>, options?: Object}) => AsyncGenerator<LauncherStepEvent, {content?: string, messages?: Array<import('../../messaging/unified-message.mjs').MessageRow>, thoughtSignature?: string}, unknown>} step
 */

/**
 * The backend client the launcher drives: one session factory.
 * @typedef {Object} LauncherClient
 * @property {(model: string) => LauncherSession} session
 */

/**
 * @param {{ command?: string, name?: string }} skill
 * @returns {string}
 */
const cmdOf = (skill) => {
    const cmd =  (skill.command ?? skill.name);
    return /** @type {any} */ (cmd).startsWith(COMMAND_PREFIX) ? /** @type {string} */ (cmd) : `${COMMAND_PREFIX}${cmd}`;
};


/**
 * Static helpers for /command line detection and parsing.
 */
export class CommandDispatcher {
    
    /**
     * @param {{input: unknown}} arg0 -
     * @returns {boolean}
     */
        static isCommand({ input }) {
        return typeof input === 'string' && input.trim().startsWith(COMMAND_PREFIX);
    }

    
    /**
     * @param {{input: string}} arg0 -
     * @returns {{command: string, payload: string}}
     */
        static parse({ input }) {
        const clean = input.trim();
        const firstSpace = clean.indexOf(' ');
        if (firstSpace === -1) {
            return { command: clean.toLowerCase(), payload: '' };
        }
        return {
            command: clean.substring(0, firstSpace).toLowerCase(),
            payload: clean.substring(firstSpace + 1).trim()
        };
    }
}


/**
 * Interactive agent CLI: system commands, skill-plugin dispatch, and a
 * tool-fed agentic loop over a backend session.
 * @extends {EventEmitter}
 */
export class AgentLauncher extends EventEmitter {
     /** @type {LauncherClient} */
          client;
     /** @type {string} */
          provider;
     /** @type {string} */
          model;
     /** @type {LauncherSession} */
          session;
     /** @type {Array<LauncherSkill>} */
          skills;
     /** @type {Array<import('../../messaging/unified-message.mjs').MessageRow>} */
          messages;
     /** @type {string|null} */
          thoughtSignature;
     /** @type {Map<string, Function>} */
          systemHandlers;
     /** @type {CommandSuggestionSource} */
          suggestionSource;
     /** @type {string|Function} */
          extractorPersona;
     /** @type {LauncherSession|null} */
          _extractorSession;

    
    /**
      * @param {{client: LauncherClient, provider?: string, model: string}} arg0
     */
        constructor({ client, provider, model }) {
        super();
        this.client = client;
        this.provider = provider ?? '';
        this.model = model;
        this.session = client.session(model);
        this.skills = [];
        this.messages = [];
        this.thoughtSignature = null;
        this.systemHandlers = new Map();
        this.suggestionSource = new CommandSuggestionSource();
        this.extractorPersona = DEFAULT_EXTRACTOR_PERSONA;

        this._extractorSession = null;

        this._registerDefaultSystemHandlers();
    }

    
    /**
     * `(skill, payload) => string` producing the extractor's system message.
     * @param {{personaOrFn: string|Function}} arg0 -
     * @returns {AgentLauncher}
     */
        withExtractorPersona({ personaOrFn }) {
        if (typeof personaOrFn === 'string' && personaOrFn.length > 0) {
            this.extractorPersona = personaOrFn;
        } else if (typeof personaOrFn === 'function') {
            this.extractorPersona = personaOrFn;
        } else {
            throw new TypeError(
                'AgentLauncher.withExtractorPersona: argument must be a non-empty string or a function.'
            );
        }
        return this;
    }

    _registerDefaultSystemHandlers() {
        this.systemHandlers.set(SystemCommand.RESET, () => {
            this.messages = [];
            this.thoughtSignature = null;
            log.success({ m: 'Chat memory has been reset successfully!' });
        });

        this.systemHandlers.set(SystemCommand.HISTORY, () => {
            log.info({ m: '--- Active Conversation History ---' });
            if (this.messages.length === 0) {
                console.log(' (empty)');
                return;
            }
            this.messages.forEach((msg, idx) => {
                const role = typeof msg.role === 'string' ? msg.role : (typeof msg.type === 'string' ? msg.type : 'unknown');
                let content = msg.content || msg.result || '';
                const calls = /** @type {Array<{function?: {name?: string}, name?: string}>|undefined} */ (msg.tool_calls);
                if (!content && calls) {
                    content = `[Tool Calls: ${calls.map(/** @type {(...args: any[]) => any} */ (( tc) => tc.function?.name || tc.name)).join(', ')}]`;
                }
                console.log(`[${idx}] \x1b[1m${role.toUpperCase()}\x1b[0m: ${typeof content === 'string' ? content : JSON.stringify(content)}`);
            });
        });

        this.systemHandlers.set(SystemCommand.LIMITS, (/** @type {string} */ payload = '') => {
            try {
                const tokens = String(payload ?? '').trim().split(/\s+/).filter(Boolean);
                const first = tokens[0] ?? '';
                if (first === 'off' || first === 'limits_off') {
                    setLimits({ disabled: true });
                    log.warn({ m: 'Limits suspended: the kill switch is on. `/limits on` restores the configured values.' });
                    return;
                }
                if (first === 'on' || first === 'limits_on') {
                    setLimits({ disabled: false });
                    log.success({ m: 'Limits restored from their configured sources.' });
                    return;
                }
                const pair = first.includes('=') ? first.split('=') : (first === 'set' ? tokens.slice(1) : tokens);
                if (pair.length === 2 && pair[0] && pair[1]) {
                    const raw = /^(off|none|unlimited|disabled)$/i.test(pair[1]) ? 'off' : pair[1];
                    setLimits({ values: { [pair[0]]: raw } });
                    log.success({ m: `Set ${pair[0]} = ${raw} for this session. This is not persisted; use secret.env or ${'merci-limits.json'} for that.` });
                    return;
                }
                const entries = getLimits();
                const show = (/** @type {{key: string, value: number, source: string, default: number, env: string}} */ entry) =>
                    console.log(`  ${entry.key.padEnd(38)} ${String(entry.value).padStart(12)}  ${entry.source}${entry.value !== entry.default ? ` (default ${entry.default})` : ''}`);
                if (first === 'all') {
                    log.info({ m: `--- Effective limits (${entries.length}) ---` });
                    for (const entry of entries) show(entry);
                    return;
                }
                const changed = entries.filter((entry) => entry.source !== 'default' && entry.source !== 'guard');
                log.info({ m: `--- Limits: ${entries.length} total, ${changed.length} not at their default ---` });
                for (const entry of changed) show(entry);
                if (changed.length === 0) console.log('  (all limits at their documented defaults)');
                console.log('  Use `/limits all` for every key, `/limits off` to suspend, `/limits <key> <value>` to override.');
            } catch (error) {
                log.error({ m: error instanceof Error ? error.message : String(error) });
            }
        });

        this.systemHandlers.set(SystemCommand.HELP, () => {
            log.info({ m: '--- Available System Commands ---' });
            for (const [cmd, desc] of Object.entries(SYSTEM_COMMAND_DESCRIPTIONS)) {
                console.log(`  \x1b[1m${cmd}\x1b[0m : ${desc}`);
            }

            log.info({ m: '--- Loaded Skill Plugins ---' });
            if (this.skills.length === 0) {
                console.log(' (No plugins loaded)');
                return;
            }
            this.skills.forEach(skill => {
                const cmdBind = cmdOf(skill);
                console.log(`  \x1b[1m${cmdBind}\x1b[0m : ${skill.description}`);
            });
        });

        this._syncSystemCommandProvider();
    }

    _syncSystemCommandProvider() {
        this.suggestionSource.setProvider({ name: 'system', commands: Array.from(this.systemHandlers.keys()) });
    }

    
    /**
     * suggestion source (slash-command completion).
     * @param {{skills: Array<Object>}} arg0 -
     * @returns {AgentLauncher}
     */
        withSkills({ skills }) {
        this.skills = skills;
        this.suggestionSource.setProvider({ name: 'skills', commands: this.skills.map(cmdOf) });
        this.session.withTools({ tools: skills });
        return this;
    }

    
    /**
     * Sets the session's system message.
     * @param {string} msg
     * @returns {AgentLauncher}
     */
        withSystemMessage(msg) {
        this.session.withSystemMessage(msg);
        return this;
    }

    
    /**
     * Returns a readline-style completer `(line) => [hits, line]` backed by
     * the suggestion source.
     * @returns {Function}
     */
        getCompleter() {
        return /** @type {(...args: any[]) => any} */ (( line) => {
            if (line.includes(' ')) return [[], line];

            const clean = line.trim();

            if (clean === COMMAND_PREFIX || clean === '') {
                return [[], line];
            }

            const hits = this.suggestionSource.getMatches({ line: clean });

            return [hits, line];
        });
    }

    
    /**
     * Yields stream events (tool_request, text, ...) to the caller; tool
     * requests are resolved by feeding the yielded results back in.
     * @param {{userInput: string}} arg0 -
     * @returns {AsyncGenerator<Object>}
     */
        async* processInput({ userInput }) {
        const { isCommand, parse } = CommandDispatcher;

        if (isCommand({ input: userInput })) {
            const { command, payload } = parse({ input: userInput });

            if (this.systemHandlers.has(command)) {
                this.emit(EVENTS.CLI.COMMAND, stampEvent({ name: EVENTS.CLI.COMMAND, payload: { command, kind: 'system' } }));
                await /** @type {Function} */ (this.systemHandlers.get(command))(payload);
                yield { type: 'text', content: `\n[System] Command executed.\n` };
                return;
            }

            const skill = this.skills.find(s => cmdOf(s).toLowerCase() === command);
            if (skill) {
                this.emit(EVENTS.CLI.COMMAND, stampEvent({ name: EVENTS.CLI.COMMAND, payload: { command, kind: 'skill' } }));
                yield { type: 'text', content: `\n\x1b[35m[Plugin] Binding parameters for ${skill.name}...\x1b[0m\n` };

                if (!this._extractorSession) {
                    this._extractorSession = this.client.session(this.model);
                }

                const extractorSystemMessage = typeof this.extractorPersona === 'function'
                    ? this.extractorPersona(skill, payload)
                    : this.extractorPersona;

                const tempSession = this._extractorSession
                    .withTools({ tools: this.skills })
                    .withSystemMessage(extractorSystemMessage);

                tempSession.withParameters({ params: /** @type {(...args: any[]) => any} */ ((b) => b.toolChoiceNamed({ name: skill.name })) });

                const instruction = createUserMessage({ provider: this.provider, content: `Extract parameters for the tool '${skill.name}' from the following input: '${payload}'` });

                const stepGen = tempSession.step({ messages: [instruction] });
                let result = await stepGen.next();
                /** @type {NonNullable<LauncherStepEvent['calls']>} */
                let executedCalls = [];
                let capturedResults = null;
                let pluginThoughtSignature = null;

                while (!result.done) {
                    const event = result.value;
                    if (event.type === 'tool_request') {
                        executedCalls = event.calls ?? [];
                        pluginThoughtSignature = event.thoughtSignature
                            || event.calls?.[0]?.thoughtSignature
                            || null;
                        const toolResults = yield event;
                        capturedResults = toolResults;
                        result = await stepGen.next(toolResults);
                    } else {
                        yield event;
                        result = await stepGen.next();
                    }
                }

                if (executedCalls.length > 0 && capturedResults && capturedResults.length > 0) {
                    const userMsg = createUserMessage({ provider: this.provider, content: `${command} ${payload}` });
                    const firstCall = executedCalls[0];
                    const firstRes = capturedResults[0];

                    const tId = firstCall.id || 'call_1';
                    const tName = firstCall.name || firstCall.function?.name || skill.name || 'unknown';
                    const tArgs = firstCall.args || firstCall.arguments || firstCall.function?.arguments || '{}';
                    const tSig = pluginThoughtSignature
                        || firstCall.thoughtSignature
                        || firstCall.thought_signature
                        || this.thoughtSignature
                        || null;
                    const asstMsg = createToolCallMessage({ provider: this.provider, id: tId, name: tName, args: tArgs, thoughtSignature: tSig });

                    const toolMsg = createToolResultMessage({ provider: this.provider, result: firstRes, thoughtSignature: tSig });

                    this.messages.push(userMsg, asstMsg, toolMsg);

                    yield { type: 'text', content: `\n\x1b[35m[Plugin] Execution complete. Synthesizing result...\x1b[0m\n` };

                    const summaryGen = this.session.step({ messages: this.messages, options: { thoughtSignature: tSig } });
                    let sumRes = await summaryGen.next();
                    while(!sumRes.done) {
                        if (sumRes.value.type !== 'tool_request') {
                            yield sumRes.value;
                            sumRes = await summaryGen.next();
                        } else {
                            const toolResults = yield sumRes.value;
                            sumRes = await summaryGen.next(toolResults);
                        }
                    }
                    this.messages = sumRes.value.messages ?? this.messages;
                    this.thoughtSignature = sumRes.value.thoughtSignature || tSig;
                    return;
                }

                yield { type: 'text', content: `\n\x1b[31m[Plugin] Parameter extraction for '${skill.name}' produced no tool call. Try rephrasing the request.\x1b[0m\n` };
                return;
            }

            this.emit(EVENTS.CLI.COMMAND, stampEvent({ name: EVENTS.CLI.COMMAND, payload: { command, kind: 'unknown' } }));
            yield { type: 'text', content: `\n[Error] Unknown command: ${command}. Type /help for a list of commands.\n` };
            return;
        }

        const msg = createUserMessage({ provider: this.provider, content: userInput });
        this.messages.push(msg);

        // A7 — the one deliberate exemption from `runStep`: this loop SUSPENDS on a
        // `tool_request` (yielded to the caller) and resumes with the results, while
        // `runStep` drives a whole attempt to completion and reports one-way. Session
        // reuse is not the reason (runStep accepts a session); the interactive tool
        // channel is. Recorded in `lib/agentic/step.mjs`; do not "fix" it here.
        const maxIterations = LIMITS.max_iterations;
        for (let iteration = 0; iteration < maxIterations; iteration++) {
            const isLastIteration = iteration === maxIterations - 1;
            const gen = stepAgentic({ session: this.session, messages: this.messages, options: {
                thoughtSignature: this.thoughtSignature,
                forceTextResponse: isLastIteration
            } });
            let result = await gen.next();

            while (!result.done) {
                const event = result.value;
                if (event && event.type === 'tool_request') {
                    const toolResults = yield event;
                    result = await gen.next(toolResults);
                } else {
                    yield event;
                    result = await gen.next();
                }
            }

            const finalState = /** @type {{messages: Array<import('../../messaging/unified-message.mjs').MessageRow>, thoughtSignature?: string|null, done?: boolean}} */ (/** @type {unknown} */ (result.value));
            this.messages = finalState.messages;
            this.thoughtSignature = finalState.thoughtSignature || this.thoughtSignature;

            if (finalState.done) {
                return;
            }
        }

        log.warn({ m: FALLBACK_MESSAGE.MAX_ITERATIONS });
    }
}
