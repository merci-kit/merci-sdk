// @ts-check


/**
 * @file CommandSuggestionSource — UI-agnostic command-completion engine.
 * @version 0.12.0
 *
 * @description
 * Answers "what commands exist?" and "which commands match this prefix?" for
 * any suggestion adapter (terminal, React, web, IDE plugin, ...).
 */
import { BASE_EXIT_KEYWORDS } from '../../core/constants/index.mjs';


/**
 * CommandSuggestionSource: UI-agnostic command-completion engine.
 *
 * Holds the registered command sets and answers "what commands exist?" and
 * "which commands match this prefix?" — the two questions every suggestion
 * adapter (terminal, React, web, IDE plugin, ...) needs to ask. It contains
 * no terminal, readline, DOM, or framework code, so it is reusable across
 * all present and future interfaces.
 *
 * Providers are registered by *name* so multiple subsystems (system
 * commands, skill plugins, history recents, ...) can each own a slot
 * without coupling to one another. `setProvider(name, [...])` is
 * idempotent and replaces any previous value for that name.
 */
export class CommandSuggestionSource {
    /** @type {Map<string, Array<string>>} */
    _providers;

    constructor() {
        this._providers = new Map();
        this.setProvider({ name: 'base', commands: BASE_EXIT_KEYWORDS });
    }

    
    /**
     * @param {{name: string, commands: string[]}} arg0 -
     * @returns {CommandSuggestionSource}
     */
        setProvider({ name, commands }) {
        this._providers.set(name, [...new Set(commands)]);
        return this;
    }

    
    /**
     * Returns the de-duplicated union of all registered commands,
     * in the order: base, then providers in registration order.
     * @returns {string[]}
     */
        getAllCommands() {
        const merged = [];
        for (const commands of this._providers.values()) {
            merged.push(...commands);
        }
        return [...new Set(merged)];
    }

    
    /**
     * @param {{line: string}} arg0 -
     * @returns {string[]}
     */
        getMatches({ line }) {
        if (typeof line !== 'string' || line.length === 0) return [];
        const lower = line.toLowerCase();
        return this.getAllCommands().filter(c => c.toLowerCase().startsWith(lower));
    }
}
