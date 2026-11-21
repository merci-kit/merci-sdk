// @ts-check


/**
 * @file StateMachine planning schema and prompt.
 * @version 0.12.0
 *
 * @description
 * The schema (nodes, edges, optional JS conditions, cycles allowed) and the
 * architect prompt for the StateMachine executor.
 */
import { z } from 'zod';
import { HANDOFF_OPTION_SCHEMA } from './dag.mjs';


/**
 * Zod schema for a state machine plan — nodes/edges, cycles allowed. Converted to JSON
 * Schema at the wire boundary; backends still receive plain JSON Schema.
 * @type {import('zod').ZodType}
 */
export const SM_PLAN_SCHEMA = z.object({
    summary: z.string().describe('One-sentence summary of the state machine approach.').optional(),
    entry: z.string().describe('ID of the starting node.'),
    nodes: z.array(z.object({
        id: z.string().describe('Unique node identifier.'),
        model: z.string().describe('Optional model override for this node. Omit to use the default model.').optional(),
        systemPrompt: z.string().describe('System directive for the LLM when this node executes.').optional(),
        userPromptTemplate: z.string().describe('Optional template for the user message. Use {{context.key}} to reference the shared state.').optional(),
        terminal: z.boolean().describe('If true, the machine halts after this node.').optional(),
        handoff: HANDOFF_OPTION_SCHEMA.describe('Handoff modes for this node (goal/context/tools). Omit for defaults.').optional(),
        maxVisits: z.number().int().describe('Max times this node can execute before cycle guard throws (default 10).').optional()
    })).min(1),
    edges: z.array(z.object({
        from: z.string().describe('Source node ID.'),
        to: z.string().describe('Target node ID.'),
        condition: z.string().describe('Optional JS expression evaluated against context. When omitted, the edge is unconditional.').optional()
    }))
});


/**
 * Builds the state-machine architect prompt.
 * @param {Record<string, any>} arg0
 * @param {string} arg0.objective
 * @param {Array<{name?: any, description?: any, parameters?: any}>} arg0.toolsList - Available tools (omitted from the prompt when empty).
 * @returns {string}
 */
/** @param {{objective: string, toolsList: Array<Record<string, unknown>>}} arg0 */
export const SM_PLAN_PROMPT = ({ objective, toolsList }) => {
    const tools = (toolsList ?? []).map((/** @type {{name?: any, description?: any, parameters?: any}} */ { name, description, parameters }) => ({ name, description, parameters }));
    return `
You are a senior state machine architect. Design a graph of nodes and edges that achieves the goal.

=== Goal ===
${objective}

${tools.length ? `=== Available Tools ===\n${JSON.stringify(tools, null, 2)}` : ''}

=== Rules ===
1. Nodes are LLM-call steps (systemPrompt). JS-logic nodes are added programmatically via addNode, not planned.
2. Edges define transitions. An edge without a condition is unconditional. A "condition" MUST be a single JS **expression** (no "return", no statements) evaluated against \`ctx\`, which is a context object with a \`get(key)\` method — e.g. "ctx.get('score') >= 8". Read state only via \`ctx.get('<node id>')\`; each node's output is stored under its own id.
3. Cycles ARE allowed — a node can loop back to itself or form a cycle with others.
4. Set "terminal: true" on the final node.
5. Use {{context.key}} in systemPrompt to reference shared state variables.
6. Start simple — only add nodes and edges the goal actually requires. Set "handoff" only for non-default isolation/compaction (same semantics as DAG steps).
`;
};
