// @ts-check
/**
 * @file Slash-command constants and CLI exit keywords.
 * @version 0.12.0
 *
 * @description
 * The `/`-prefixed interactive commands (help/reset/history), their
 * user-facing descriptions, and the base exit keywords the CLI loop matches
 * to end a session.
 */




/** Prefix of every interactive slash command. */
export const COMMAND_PREFIX = '/';


/**
 * The built-in interactive commands.
 * @type {Object<string, string>}
 */
export const SystemCommand = {
    HELP: '/help',
    RESET: '/reset',
    HISTORY: '/history',
    LIMITS: '/limits'
};


/**
 * User-facing help text for each system command.
 * @type {Object<string, string>}
 */
export const SYSTEM_COMMAND_DESCRIPTIONS = {
    [SystemCommand.HELP]: 'Displays all available slash commands and modular skills.',
    [SystemCommand.RESET]: 'Clears the current chat session memory.',
    [SystemCommand.HISTORY]: 'Prints the formatted conversation history.',
    [SystemCommand.LIMITS]: 'Shows effective limits: `/limits`, `/limits all`, `/limits on|off`, `/limits <key> <value>`.'
};


/**
 * Keywords that terminate a CLI session.
 * @type {Array<string>}
 */
export const BASE_EXIT_KEYWORDS = ['/exit', '/quit', 'exit', 'quit'];
