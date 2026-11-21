// @ts-check
/**
 * @file External tool capabilities (MCP / A2A / ACP) on the unified
 * capability ("extension") contract.
 * @version 0.12.0
 *
 * @description
 * Remote tool families used to be raw tool-definition factories with no
 * capability surface (no announce, no listing block, no shared output cap —
 * MCP and A2A each hand-rolled the same truncation suffix). This module puts
 * them on the LoadableComponent contract with the tools-first SOTA policy:
 * descriptors live in tool schemas (dynamic discovery), the system prompt
 * carries at most a short stable announcement, and large results are capped
 * by reference-safe truncation — never full dumps.
 */

import { LoadableComponent } from '../core/loadable.mjs';
import { isAbortError } from '../core/errors.mjs';
import { merciEnvelope } from '../agentic/agent-context.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { LIMIT_REGISTRY } from '../core/constants/limits.mjs';




/**
 * One remote tool definition the capability wraps: a name, a description, its
 * JSON-Schema parameters and the execute the session calls.
 * @typedef {Object} RemoteTool
 * @property {string} [name]
 * @property {string} [description]
 * @property {Object} [parameters]
 * @property {Function} [execute]
 */

/**
 * The duck-typed ACP client: a catalog and a call. Every member is optional so a
 * partial adapter still fits; `connect` fails soft when the catalog cannot load.
 * @typedef {Object} AcpClient
 * @property {string} [name]
 * @property {Function} [listTools]
 * @property {Function} [callTool]
 */

/** Suffix marking a capped tool result. */
export const TOOL_OUTPUT_TRUNCATION_SUFFIX = '\n...[TRUNCATED TO PREVENT TOKEN OVERFLOW]';


/**
 * Default byte cap on a single remote tool result's text.
 * Code default only; the effective cap is `LIMITS.tool_output_max_chars` (`getLimits()`).
 */
export const DEFAULT_TOOL_OUTPUT_MAX_LENGTH = LIMIT_REGISTRY.tool_output_max_chars.default;


/**
 * A tool-result media block: its base64 payload is not text the model reads, so
 * the text budget must not truncate it (a cut base64 image is a corrupt image).
 * The per-image size limit is enforced where the block becomes a wire message.
 * @param {{node: any}} arg0
 * @returns {boolean}
 */
function isMediaBlock({ node }) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    if (node.type === 'image_url') return typeof node.image_url?.url === 'string';
    if (node.type !== 'image') return false;
    return typeof node.data === 'string'
        || typeof node.source?.data === 'string'
        || typeof (node.inlineData ?? node.inline_data)?.data === 'string';
}


/**
 * Non-strings pass through untouched. maxLength must exceed
 * TOOL_OUTPUT_TRUNCATION_SUFFIX.length (41) for the cap to hold —
 * smaller caps still emit the full suffix (visible marker wins).
 * The return keeps the caller's type: a string stays a string (shorter), and
 * anything else is returned as given.
 * @template T
 * @param {{text: T, maxLength?: number}} arg0 -
 * @returns {T}
 */
export function capToolOutput({ text, maxLength = LIMITS.tool_output_max_chars }) {
    if (typeof text !== 'string' || text.length <= maxLength) return text;
    return /** @type {T} */ (text.substring(0, maxLength - TOOL_OUTPUT_TRUNCATION_SUFFIX.length) + TOOL_OUTPUT_TRUNCATION_SUFFIX);
}


/**
 * Caps a tool result of **any** shape to a character budget, without
 * changing its type.
 *
 * A string result is capped exactly like `capToolOutput`. An object or an
 * array keeps its shape at the top level: every string leaf is capped, and
 * once the budget is spent the remaining values are elided with a `'[…]'`
 * marker (an oversized subtree is replaced, not walked). A runaway tool can
 * therefore never push an unbounded payload into the model's context. The
 * budget is counted in characters, the same unit `capToolOutput` uses, and the
 * deep tree is bounded so a pathological structure cannot recurse forever.
 *
 * @param {{ value: unknown, maxLength?: number, maxDepth?: number }} arg0 -
 * @returns {{ value: unknown, truncated: boolean }}
 */
export function capToolOutputValue({ value, maxLength = LIMITS.tool_output_max_chars, maxDepth = LIMITS.cap_max_depth }) {
    // An object with a million keys is a payload too — the key set is bounded
    // as well as the values.
    let budget = Math.max(0, Number(maxLength) || 0);
    let truncated = false;
    const maxCappedKeys = LIMITS.capped_object_keys;
    const maxElidedKeyLength = LIMITS.elided_key_chars;

    /**
     * @param {{ node: any, depth: number }} arg0
     * @returns {any}
     */
    /**
     * A key that no longer fits the budget is shortened: the entry keeps a
     * recognisable prefix and an index, so the shape survives without the
     * payload growing.
     * @param {{ key: string, index: number }} arg0
     * @returns {string}
     */
    const elideKey = ({ key, index }) => (key.length <= maxElidedKeyLength
        ? key
        : `${key.substring(0, maxElidedKeyLength)}…#${index}`);

    /**
     * @param {{ node: any, depth: number }} arg0
     * @returns {any}
     */
    const walk = ({ node, depth }) => {
        if (typeof node === 'string') {
            if (node.length <= budget) {
                budget -= node.length;
                return node;
            }
            const room = Math.max(0, budget - TOOL_OUTPUT_TRUNCATION_SUFFIX.length);
            budget = 0;
            truncated = true;
            return node.substring(0, room) + TOOL_OUTPUT_TRUNCATION_SUFFIX;
        }
        if (Array.isArray(node)) {
            if (depth >= maxDepth) {
                truncated = true;
                return '[…]';
            }
            /** @type {any[]} */
            const out = [];
            for (const item of node) {
                // Media rides beside the text budget: a truncated base64 image
                // is a corrupt image, and its size is checked where it is sent.
                if (isMediaBlock({ node: item })) {
                    out.push(item);
                    continue;
                }
                if (budget <= 0) {
                    truncated = true;
                    out.push('[…]');
                    break;
                }
                out.push(walk({ node: item, depth: depth + 1 }));
            }
            return out;
        }
        if (node && typeof node === 'object') {
            if (depth >= maxDepth) {
                truncated = true;
                return '[…]';
            }
            if (isMediaBlock({ node })) return node;
            /** @type {Record<string, any>} */
            const out = {};
            let kept = 0;
            for (const [key, item] of Object.entries(node)) {
                if (isMediaBlock({ node: item })) {
                    out[key] = item;
                    kept += 1;
                    continue;
                }
                if (budget <= 0) {
                    // The shape survives: the key stays (shortened — a long key
                    // is a payload too), its value is elided.
                    truncated = true;
                    out[elideKey({ key, index: kept })] = '[…]';
                    kept += 1;
                    if (kept > maxCappedKeys) break;
                    continue;
                }
                if (key.length > budget) {
                    // A key longer than the whole budget: keep a prefix of it.
                    truncated = true;
                    out[key.substring(0, Math.max(0, Math.floor(budget)))] = '[…]';
                    budget = 0;
                    kept += 1;
                    if (kept > maxCappedKeys) break;
                    continue;
                }
                // The key is part of the payload too: it costs budget.
                budget -= key.length;
                out[key] = walk({ node: item, depth: depth + 1 });
                kept += 1;
                if (kept > maxCappedKeys) {
                    truncated = true;
                    break;
                }
            }
            return out;
        }
        return node;
    };

    const capped = walk({ node: value, depth: 0 });
    return { value: capped, truncated };
}


/**
 * A remote tool family surfaced as a capability: the tool definitions do the
 * work (tools-first), `load()` renders a short catalog listing for the model,
 * and there is no save leg (toSaveTool() is null — no saveToolName passed).
 * Per-step system injection stays off by default; pass a shouldInjectStep /
 * stepBlock override (or subclass) only for small always-relevant listings.
 * @extends {LoadableComponent}
 */
export class ExternalToolCapability extends LoadableComponent {
    
    /**
 * @param {{id?: string, loadToolName?: string, tools?: Array<RemoteTool>, announce?: string|null, loadDescription?: string|null, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null}} arg0
 */
        constructor({ id, loadToolName, tools = [], announce = null, loadDescription = null, eventEmitter = null } = {}) {
        super({
            id,
            loadToolName,
            loadDescription: loadDescription || `List the available ${id} tools with their descriptions.`,
            loadParameters: { type: 'object', properties: {}, required: [] },
            announce,
            eventEmitter
        });
        /** @type {Array<RemoteTool>} */
        this._remoteTools = Array.isArray(tools) ? tools : [];
    }

    
    /** @returns {Array<RemoteTool>} The wrapped SDK tool definitions (merge into the session via withTools or withCapability). */
        tools() {
        return [...this._remoteTools];
    }

    
    /** Short catalog listing (`* name: description` per tool). */
        async load() {
        if (this._remoteTools.length === 0) return `No ${this.id} tools are currently available.`;
        let out = `=== Available ${this.id} tools ===\n`;
        for (const t of this._remoteTools) {
            if (!t || !t.name) continue;
            out += `* ${t.name}: ${t.description || 'No description provided.'}\n`;
        }
        return out;
    }
}


/**
 * Agent Client Protocol (ACP) capability — a duck-typed remote-tool adapter.
 *
 * @deprecated Wrong role for ACP. ACP (the editor protocol) is an
 * editor↔agent protocol, not a remote-tool family like MCP/A2A: its agent side
 * is served by `createAcpAgent` (lib/agentic/acp-agent.mjs). This class remains
 * for callers that use it as a generic third-party tool adapter with the
 * `{ listTools, callTool }` duck type; it will be removed in a future major.
 *
 *   client = { name?, listTools: () => [{ name, description?, parameters? }],
 *              callTool: (name, args) => result }
 *
 * `connect()` pulls the catalog once (tools-first SOTA: cache the catalog,
 * don't re-fetch per step) and wraps each entry with output capping and a
 * `{ success, ... }` envelope. Fails soft (empty tools, like loadA2ATool)
 * when the catalog cannot be loaded.
 * @extends {ExternalToolCapability}
 */
export class AcpCapability extends ExternalToolCapability {
    
    /**
 * @param {{client?: AcpClient, id?: string, maxOutputLength?: number, announce?: string|null, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null, agentContext?: import('../agentic/agent-context.mjs').AgentContext|null}} arg0
 *   inline as `args._merci` (unknown-field-tolerant peers ignore it).
 */
        constructor({ client, id = 'acp', maxOutputLength = LIMITS.tool_output_max_chars, announce = null, eventEmitter = null, agentContext = null } = {}) {
        super({
            id,
            loadToolName: `load_${id}_tools`,
            tools: [],
            announce: announce ?? `You have remote ${id.toUpperCase()} tools. Call them directly by name; list them with \`load_${id}_tools\`.`,
            eventEmitter
        });
        /** @type {AcpClient|undefined} */
        this.client = client;
        this.maxOutputLength = maxOutputLength;
        /** @type {import('../agentic/agent-context.mjs').AgentContext|null} */
        this._agentContext = agentContext;
    }

    
    /** @returns {Promise<Array<RemoteTool>>} Pulls the catalog once and wraps each entry (idempotent — re-call to refresh). */
        async connect() {
        const client =  (this.client);
        
        /** @type {Array<RemoteTool>} */
        let entries = [];
        try {
            entries = /** @type {Array<RemoteTool>} */ (await /** @type {any} */ (client).listTools());
        } catch {
            entries = [];
        }
        const max = this.maxOutputLength;
        const built = (Array.isArray(entries) ? entries : [])
            .filter((t) => t && t.name)
            .map((t) => ({
                name: t.name,
                description: t.description || `${(this.id ?? '').toUpperCase()} tool: ${t.name}`,
                parameters: t.parameters || { type: 'object', properties: {} },
                /** @param {{args: *, signal: *, context?: *}} arg0 */
                execute: async ({ args, signal, context = {} }) => {
                    try {
                        const env = merciEnvelope({ ctx: context?.agentContext ?? this._agentContext });
                        /** @type {Record<string, any>} */
                                                if (context?.idempotencyKey)  (env).idempotencyKey = context.idempotencyKey;
                        const params = Object.keys(env).length > 0 ? { ...(args ?? {}), _merci: env } : (args ?? {});
                        const result = await /** @type {any} */ (client).callTool(t.name, params, { signal });
                        const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
                        return { success: true, result: capToolOutput({ text, maxLength: max }) };
                    } catch (err) {
                        if (isAbortError({ err, signal })) throw err;
                        return { success: false, error: ( (/** @type {any} */ (err)))?.message ?? String(err) };
                    }
                }
            }));
        this._remoteTools = /** @type {Array<RemoteTool>} */ (built);
        return this.tools();
    }
}
