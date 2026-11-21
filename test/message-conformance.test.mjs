// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createToolCallMessage,
    createToolResultMessage,
    normalizeHistory as wireNormalizeHistory,
    normalizeToOAI as wireNormalizeToOAI,
    normalizeToAAI as wireNormalizeToAAI,
    normalizeToGAI as wireNormalizeToGAI,
} from '../lib/messaging/messages.mjs';
import { countConversationTurns, isInjection } from '../lib/messaging/unified-message.mjs';
import { ProviderType, SYSTEM_MESSAGE_MERGE_SEPARATOR } from '../lib/core/constants/index.mjs';

// This suite asserts on raw wire JSON, so it views normalized rows as open
// records; the library's own declarations stay strict.
/** @type {(arg0: {model?: string, msgs?: Array<Record<string, any>>, opts?: Object}) => Array<Record<string, any>>} */
const normalizeToOAI = wireNormalizeToOAI;
/** @type {(arg0?: {msgs?: Array<Record<string, any>>}) => {messages: Array<Record<string, any>>, system: string|Array<Record<string, any>>|null}} */
const normalizeToAAI = wireNormalizeToAAI;
/** @type {(arg0?: {msgs?: Array<Record<string, any>>, effectiveThoughtSignature?: string|null}) => {contents: Array<Record<string, any>>, systemInstruction: string|null}} */
const normalizeToGAI = wireNormalizeToGAI;
/** @type {(arg0: {provider: string, messages: Array<Record<string, any>>, options?: Object}) => Array<Record<string, any>>} */
const normalizeHistory = wireNormalizeHistory;

// ─── Fixtures: one input history per scenario, shared by A and B ─────────────

const S1 = {
    name: 'S1 multi-tool-call turn (OAI)',
    provider: 'OAI',
    input: [
        { type: 'assistant_message_tool', id: 'call_a', toolName: 'a', content: '{"x":1}' },
        { type: 'assistant_message_tool', id: 'call_b', toolName: 'b', content: '{"y":2}' },
        { type: 'tool_message', id: 'call_a', toolName: 'a', result: 'ok-a' },
        { type: 'tool_message', id: 'call_b', toolName: 'b', result: 'ok-b' },
    ],
};

const S2 = {
    name: 'S2 orphaned tool result (AAI/GAI)',
    provider: 'AAI+GAI',
    input: [
        { type: 'assistant_message_tool', id: 'call_x', toolName: 'x', content: '{}' },
        { role: 'tool', name: 'x', content: 'no id on this one' },
    ],
};

const S3 = {
    name: 'S3 duplicate consecutive system messages (OAI via normalizeHistory)',
    provider: 'OAI',
    input: [
        { role: 'system', content: 'sys-one' },
        { role: 'system', content: 'sys-two' },
        { role: 'user', content: 'hi' },
    ],
};

const S4 = {
    name: 'S4 OAI image_url block to AAI (multimodal history)',
    provider: 'AAI',
    input: [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'what is this?' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
        },
    ],
};

const S5 = {
    name: 'S5 remote-image-only user turn to GAI',
    provider: 'GAI',
    input: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
    ],
};

const S6 = {
    name: 'S6 snake thought_signature on OAI wire',
    provider: 'OAI',
    input: [
        { type: 'assistant_message_text', content: 'thinking out loud', thought_signature: 'sig-123' },
        { role: 'assistant', content: 'role-carrying message', thought_signature: 'sig-456' },
        { role: 'user', content: 'continue' },
    ],
};

const S7 = {
    name: 'S7 non-string tool-call arguments (OAI factory)',
    provider: 'OAI',
    input: () => [
        createToolCallMessage({ provider: ProviderType.OPENAI, id: 'call_o', name: 'obj', args: { a: 1 } }),
        createToolResultMessage({ provider: ProviderType.OPENAI, result: { id: 'call_o', name: 'obj', success: true, result: 'ok' } }),
    ],
};

const S8 = {
    name: 'S8 OAI assistant array content to GAI (tool_use blocks)',
    provider: 'GAI',
    input: [
        {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_z', name: 'z', input: { v: 3 } }],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_z', content: 'z-ok' }] },
    ],
};

const S9 = {
    name: 'S9 OAI tool array content to AAI (block structure preserved)',
    provider: 'AAI',
    input: [
        { role: 'assistant', tool_calls: [{ id: 'call_w', type: 'function', function: { name: 'w', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_w', content: [{ type: 'text', text: 'part-one' }, { type: 'text', text: 'part-two' }] },
    ],
};

const S10 = {
    name: 'S10 countConversationTurns counts genuine turns',
    provider: 'core',
    input: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'r1' },
        { role: 'user', content: 'u2' },
    ],
};

const SCENARIOS = [S1, S2, S3, S4, S5, S6, S7, S8, S9, S10];

// ─── Reference converter B: canonical vendor-idiomatic wire shapes ───────────

/**
 * @param {{scenario: any}} arg0
 */
export function referenceConvert({ scenario }) {
    const input = typeof scenario.input === 'function' ? scenario.input() : scenario.input;
    switch (scenario.provider) {
        case 'OAI': return refOAI({ input });
        case 'AAI': return refAAI({ input });
        case 'GAI': return refGAI({ input });
        case 'AAI+GAI': return { aai: refAAI({ input }), gai: refGAI({ input }) };
        default: return null;
    }
}

/**
 * @param {{input: any}} arg0
 */
function refOAI({ input }) {
    const out = [];
    for (let i = 0; i < input.length; i++) {
        const m = input[i];
        if (m.type === 'assistant_message_tool' || m.type === 'assistant_tool_call') {
            const toolCalls = m.tool_calls || [{ id: m.id, name: m.toolName, arguments: m.content }];
            while (i + 1 < input.length && (input[i + 1].type === 'assistant_message_tool' || input[i + 1].type === 'assistant_tool_call')) {
                i++;
                toolCalls.push({ id: input[i].id, name: input[i].toolName, arguments: input[i].content });
            }
            out.push({
                role: 'assistant',
                tool_calls: toolCalls.map((/** @type {any} */ tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name || '', arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}) },
                })),
            });
        } else if (m.type === 'tool_message' || m.type === 'tool_result_message') {
            const raw = m.result ?? m.content;
            out.push({
                role: 'tool',
                tool_call_id: m.tool_call_id || m.id,
                content: typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''),
            });
        } else if (m.type === 'user_message') {
            out.push({ role: 'user', content: m.content });
        } else if (m.type === 'system_message') {
            out.push({ role: 'system', content: m.content });
        } else if (m.type === 'assistant_message_text') {
            const msg = /** @type {any} */ ({ role: 'assistant', content: m.content });
            if (m.thoughtSignature) msg.thoughtSignature = m.thoughtSignature;
            out.push(msg);
        } else if (m.role === 'user') {
            out.push({ role: 'user', content: m.content });
        } else if (m.role === 'system') {
            out.push({ role: 'system', content: m.content });
        } else if (m.role === 'tool') {
            const msg = /** @type {any} */ ({ role: 'tool', tool_call_id: m.tool_call_id || '', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') });
            if (m.thoughtSignature) msg.thoughtSignature = m.thoughtSignature;
            out.push(msg);
        } else if (m.role === 'assistant') {
            if (Array.isArray(m.tool_calls)) {
                out.push({
                    role: 'assistant',
                    tool_calls: m.tool_calls.map((/** @type {any} */ tc) => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.function?.name || '', arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}) },
                    })),
                });
            } else {
                out.push({ role: 'assistant', content: m.content });
            }
        }
    }
    const merged = [];
    let systemMsg = /** @type {any} */ (null);
    for (const m of out) {
        if (m.role === 'system' || m.role === 'developer') {
            systemMsg = systemMsg
                ? { ...systemMsg, content: (systemMsg.content ?? '') + SYSTEM_MESSAGE_MERGE_SEPARATOR + (m.content ?? '') }
                : { ...m };
        } else {
            if (systemMsg) { merged.push(systemMsg); systemMsg = null; }
            merged.push(m);
        }
    }
    if (systemMsg) merged.push(systemMsg);
    return merged;
}

/**
 * @param {{input: any}} arg0
 */
function refAAI({ input }) {
    const out = [];
    /** @type {any} */
    let system = null;
    /** @type {(arg0: {t: string}) => void} */
    /** @param {{t: *}} arg0 */
    const pushSystem =({ t }) => { system = system ? system + SYSTEM_MESSAGE_MERGE_SEPARATOR + t : t; };
    for (const m of input) {
        if (m.type === 'system_message' || m.role === 'system') { pushSystem({ t: String(m.content ?? '') }); continue; }
        if (m.type === 'user_message') { out.push({ role: 'user', content: [{ type: 'text', text: m.content }] }); continue; }
        if (m.type === 'assistant_message_text') { out.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] }); continue; }
        if (m.type === 'assistant_message_tool') {
            out.push({ role: 'assistant', content: [{ type: 'tool_use', id: m.id, name: m.toolName, input: parseArgs({ args: m.content }) }] });
            continue;
        }
        if (m.type === 'tool_message') {
            out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || m.id, content: m.result }] });
            continue;
        }
        if (m.role === 'tool') {
            if (!m.tool_call_id) { out.push({ role: 'user', content: [{ type: 'text', text: '[tool result with missing id preserved]' }] }); continue; }
            const content = Array.isArray(m.content)
                ? m.content.map((/** @type {any} */ b) => (typeof b === 'string' ? b : (b.text || JSON.stringify(b)))).join('')
                : String(m.content ?? '');
            out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content }] });
            continue;
        }
        if (m.role === 'user') {
            const blocks = Array.isArray(m.content) ? m.content.map((/** @type {any} */ b) => {
                if (b.type === 'image_url') {
                    const url = b.image_url?.url || '';
                    const dm = /^data:([^;,]+);base64,(.+)$/.exec(url);
                    if (dm) return { type: 'image', source: { type: 'base64', media_type: dm[1], data: dm[2] } };
                    return { type: 'image', source: { type: 'url', url } };
                }
                return b;
            }) : [{ type: 'text', text: String(m.content ?? '') }];
            out.push({ role: 'user', content: blocks });
            continue;
        }
        if (m.role === 'assistant') {
            if (Array.isArray(m.tool_calls)) {
                const blocks = m.tool_calls.map((/** @type {any} */ tc) => ({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input: parseArgs({ args: tc.function?.arguments || '{}' }) }));
                out.push({ role: 'assistant', content: blocks });
            } else if (Array.isArray(m.content)) {
                out.push({ role: 'assistant', content: m.content });
            } else {
                out.push({ role: 'assistant', content: [{ type: 'text', text: String(m.content ?? '') }] });
            }
            continue;
        }
    }
    const merged = [];
    for (const m of out) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === m.role && !hasToolBlocks({ msg: prev }) && !hasToolBlocks({ msg: m })) {
            prev.content = prev.content.concat(m.content);
        } else {
            merged.push({ role: m.role, content: [...m.content] });
        }
    }
    return { messages: merged, system };
}

/**
 * @param {{msg: any}} arg0
 */
function hasToolBlocks({ msg }) {
    return (msg.content || []).some((/** @type {any} */ b) => b.type === 'tool_use' || b.type === 'tool_result');
}

/**
 * @param {{args: any}} arg0
 */
function parseArgs({ args }) {
    if (args && typeof args === 'object') return args;
    try { return JSON.parse(args || '{}'); } catch { return {}; }
}

/**
 * @param {{input: any}} arg0
 */
function refGAI({ input }) {
    const contents = [];
    /** @type {any} */
    let systemInstruction = null;
    /** @type {(arg0: {t: string}) => void} */
    /** @param {{t: *}} arg0 */
    const pushSys =({ t }) => { systemInstruction = systemInstruction ? systemInstruction + SYSTEM_MESSAGE_MERGE_SEPARATOR + t : t; };
    for (const m of input) {
        if (m.type === 'system_message' || m.role === 'system') { pushSys({ t: String(m.content ?? '') }); continue; }
        if (m.type === 'user_message') { contents.push({ role: 'user', parts: [{ text: m.content }] }); continue; }
        if (m.type === 'assistant_message_text') { contents.push({ role: 'model', parts: [{ text: m.content }] }); continue; }
        if (m.type === 'assistant_message_tool') {
            contents.push({ role: 'model', parts: [{ functionCall: { id: m.id, name: m.toolName, args: parseArgs({ args: m.content }) } }] });
            continue;
        }
        if (m.type === 'tool_message') {
            contents.push({ role: 'user', parts: [{ functionResponse: { id: m.tool_call_id || m.id, name: m.toolName || '', response: typeof m.result === 'string' ? { output: m.result } : (m.result ?? {}) } }] });
            continue;
        }
        if (m.role === 'tool') {
            if (!m.tool_call_id) { contents.push({ role: 'user', parts: [{ text: '[tool result with missing id preserved]' }] }); continue; }
            contents.push({ role: 'user', parts: [{ functionResponse: { id: m.tool_call_id, name: m.name || '', response: typeof m.content === 'string' ? { output: m.content } : (m.content ?? {}) } }] });
            continue;
        }
        if (m.role === 'user') {
            let parts;
            if (Array.isArray(m.content)) {
                parts = [];
                for (const b of m.content) {
                    if (b.type === 'text') { parts.push({ text: b.text }); }
                    else if (b.type === 'image_url') {
                        const dm = /^data:([^;,]+);base64,(.+)$/.exec(b.image_url?.url || '');
                        if (dm) parts.push({ inlineData: { mimeType: dm[1], data: dm[2] } });
                        else parts.push({ text: '[remote image omitted, turn preserved]' });
                    }
                }
                if (parts.length === 0) parts = [{ text: '' }];
            } else {
                parts = [{ text: String(m.content ?? '') }];
            }
            contents.push({ role: 'user', parts });
            continue;
        }
        if (m.role === 'assistant') {
            if (Array.isArray(m.tool_calls)) {
                contents.push({ role: 'model', parts: m.tool_calls.map((/** @type {any} */ tc) => ({ functionCall: { id: tc.id, name: tc.function?.name || '', args: tc.function?.arguments || {} } })) });
            } else if (Array.isArray(m.content)) {
                const parts = m.content.map((/** @type {any} */ b) => (b.type === 'tool_use' ? { functionCall: { id: b.id, name: b.name, args: b.input || {} } } : b));
                contents.push({ role: 'model', parts });
            } else {
                contents.push({ role: 'model', parts: [{ text: String(m.content ?? '') }] });
            }
            continue;
        }
    }
    const merged = [];
    for (const c of contents) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === c.role) prev.parts = prev.parts.concat(c.parts);
        else merged.push({ role: c.role, parts: [...c.parts] });
    }
    return { contents: merged, systemInstruction };
}

// ─── Merci implementation A ──────────────────────────────────────────────────

/**
 * @param {{scenario: any}} arg0
 */
export function merciConvert({ scenario }) {
    const input = typeof scenario.input === 'function' ? scenario.input() : scenario.input;
    switch (scenario.provider) {
        case 'OAI': return normalizeToOAI({ model: undefined, msgs: input });
        case 'AAI': return normalizeToAAI({ msgs: input });
        case 'GAI': return normalizeToGAI({ msgs: input });
        case 'AAI+GAI': return { aai: normalizeToAAI({ msgs: input }), gai: normalizeToGAI({ msgs: input }) };
        default: return null;
    }
}

// ─── Wire-rule validators (provider contracts, implementation-agnostic) ──────

/** @param {any} msgs */
function validateOAIWire(msgs) {
    const errors = [];
    if (!Array.isArray(msgs)) return ['not an array'];
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) errors.push(`bad role ${m.role}`);
        if (m.role === 'tool' && !m.tool_call_id) errors.push(`tool msg missing tool_call_id at ${i}`);
        if (m.role === 'tool' && typeof m.content !== 'string') errors.push(`tool content not string at ${i}`);
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                if (typeof tc.function?.arguments !== 'string') errors.push(`non-string arguments at ${i}`);
                if (!tc.id) errors.push(`tool_call missing id at ${i}`);
            }
            const next = msgs[i + 1];
            if (!(next && next.role === 'tool')) errors.push(`assistant tool_calls at ${i} has no following tool message`);
        }
        if (m.thought_signature !== undefined) errors.push(`snake thought_signature leaked at ${i}`);
    }
    return errors;
}

/** @param {{ messages: any, system: any }} arg */
function validateAAIWire({ messages, system }) {
    const errors = [];
    if (!Array.isArray(messages)) return ['not an array'];
    const toolUseIds = new Set();
    const toolResultIds = new Set();
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role !== 'user' && m.role !== 'assistant') errors.push(`bad role ${m.role}`);
        if (!Array.isArray(m.content)) { errors.push(`content not array at ${i}`); continue; }
        for (const b of m.content) {
            if (b.type === 'tool_use') {
                toolUseIds.add(b.id);
                if (!b.name) errors.push(`tool_use missing name at ${i}`);
                if (!b.input || typeof b.input !== 'object' || Array.isArray(b.input)) errors.push(`tool_use.input not an object at ${i}`);
            }
            if (b.type === 'tool_result') { toolResultIds.add(b.tool_use_id); }
            if (b.type === 'image_url') errors.push(`image_url block leaked to AAI at ${i}`);
            if (b.type === 'file') errors.push(`file block leaked to AAI at ${i}`);
            if (b.type === 'image' && !b.source) errors.push(`image block missing source at ${i}`);
            if (b.type === 'document' && !b.source) errors.push(`document block missing source at ${i}`);
        }
    }
    for (const id of toolUseIds) if (!toolResultIds.has(id)) errors.push(`orphaned tool_use ${id}`);
    for (const id of toolResultIds) if (!toolUseIds.has(id)) errors.push(`orphaned tool_result ${id}`);
    return errors;
}

/** @param {{ contents: any, systemInstruction: any }} arg */
function validateGAIWire({ contents, systemInstruction }) {
    const errors = [];
    if (!Array.isArray(contents)) return ['not an array'];
    for (let i = 0; i < contents.length; i++) {
        const c = contents[i];
        if (c.role !== 'user' && c.role !== 'model') errors.push(`bad role ${c.role}`);
        if (!Array.isArray(c.parts)) { errors.push(`parts not array at ${i}`); continue; }
        for (const p of c.parts) {
            if (p.text !== undefined && typeof p.text !== 'string') errors.push(`non-string text part at ${i}`);
            if (p.functionCall && typeof p.functionCall.args !== 'object') errors.push(`functionCall args not object at ${i}`);
            if (p.functionResponse && typeof p.functionResponse.response !== 'object') errors.push(`functionResponse.response not object at ${i}`);
        }
    }
    return errors;
}

const VALIDATORS = { OAI: validateOAIWire, AAI: validateAAIWire, GAI: validateGAIWire };

/** @param {{scenario: any, result: any}} arg0 */
function validate({ scenario, result }) {
    if (scenario.provider === 'AAI+GAI') {
        return { aai: validateAAIWire(result.aai), gai: validateGAIWire(result.gai) };
    }
    const fn = (/** @type {any} */ (VALIDATORS))[scenario.provider];
    return fn ? fn(result) : [];
}

// ─── Spec asserts (objective gate). Scenarios currently red are labeled. ─────

describe('message-conformance: provider wire rules', () => {
    it('S1 OAI groups consecutive tool-call messages and keeps results paired', () => {
        const out = normalizeToOAI({ model: undefined, msgs: S1.input });
        const assistantMsgs = out.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
        assert.equal(assistantMsgs.length, 1, 'expected exactly one grouped assistant message');
        assert.equal(assistantMsgs[0].tool_calls.length, 2);
        const toolMsgs = out.filter(m => m.role === 'tool');
        assert.deepEqual(toolMsgs.map(m => m.tool_call_id), ['call_a', 'call_b']);
        assert.deepEqual(validateOAIWire(out), []);
    });

    it('S2 orphaned tool result is not silently dropped (AAI)', () => {
        const { messages } = normalizeToAAI({ msgs: S2.input });
        const totalBlocks = messages.flatMap(m => m.content).length;
        assert.ok(totalBlocks >= 2, `expected 2+ blocks, got ${totalBlocks} — orphaned tool result was dropped`);
    });

    it('S2 orphaned tool result is not silently dropped (GAI)', () => {
        const { contents } = normalizeToGAI({ msgs: S2.input });
        const totalParts = contents.flatMap(c => c.parts).length;
        assert.ok(totalParts >= 2, `expected 2+ parts, got ${totalParts} — orphaned tool result was dropped`);
    });

    it('S3 normalizeHistory(OAI) collapses consecutive system messages', () => {
        const viaHistory = normalizeHistory({ provider: ProviderType.OPENAI, messages: S3.input });
        const viaOAI = normalizeToOAI({ model: undefined, msgs: S3.input });
        assert.deepEqual(viaHistory, viaOAI, 'normalizeHistory must match normalizeToOAI for OAI');
        const systems = viaHistory.filter(m => m.role === 'system' || m.role === 'developer');
        assert.equal(systems.length, 1, 'consecutive system messages must collapse to one');
        assert.ok(systems[0].content.includes(SYSTEM_MESSAGE_MERGE_SEPARATOR));
        assert.deepEqual(validateOAIWire(viaHistory), []);
    });

    it('S4 AAI converts OAI image_url data-URLs to Anthropic image blocks', () => {
        const { messages } = normalizeToAAI({ msgs: S4.input });
        const blocks = messages.flatMap(m => m.content);
        const image = blocks.find(b => b.type === 'image');
        assert.ok(image, 'expected an Anthropic image block');
        assert.equal(image.source.type, 'base64');
        assert.equal(image.source.data, 'AAAA');
        assert.equal(image.source.media_type, 'image/png');
        assert.ok(!blocks.some((/** @type {any} */ b) => b.type === 'image_url'), 'image_url block must be converted, not passed through');
    });

    it('S5 GAI preserves a user turn whose only content is a remote image', () => {
        const { contents } = normalizeToGAI({ msgs: S5.input });
        assert.ok(contents.length >= 1, 'user turn must not vanish');
        assert.ok(contents[0].role === 'user');
        assert.deepEqual(validateGAIWire({ contents, systemInstruction: null }), []);
    });

    it('S6 OAI wire never carries snake thought_signature', () => {
        const out = normalizeToOAI({ model: undefined, msgs: S6.input });
        for (const m of out) assert.equal(m.thought_signature, undefined, 'snake thought_signature leaked');
        assert.deepEqual(validateOAIWire(out), []);
    });

    it('S7 tool-call arguments are strings on the OAI wire', () => {
        const out = normalizeToOAI({ model: undefined, msgs: S7.input() });
        const args = out[0].tool_calls[0].function.arguments;
        assert.equal(typeof args, 'string', 'arguments must be a JSON string on the OAI wire');
        assert.deepEqual(validateOAIWire(out), []);
    });

    it('S8 GAI maps OAI assistant array content to functionCall parts', () => {
        const { contents } = normalizeToGAI({ msgs: S8.input });
        const modelParts = contents.flatMap(c => c.parts);
        const fc = modelParts.find(p => p.functionCall);
        assert.ok(fc, 'expected a functionCall part');
        for (const p of modelParts) {
            if (p.text !== undefined) assert.equal(typeof p.text, 'string', 'text part must be a string, not an array/object');
        }
        assert.deepEqual(validateGAIWire({ contents, systemInstruction: null }), []);
    });

    it('S9 AAI preserves tool_result block structure (no JSON stringification)', () => {
        const { messages } = normalizeToAAI({ msgs: S9.input });
        const blocks = messages.flatMap(m => m.content);
        const result = blocks.find(b => b.type === 'tool_result');
        assert.ok(result, 'expected a tool_result block');
        const text = Array.isArray(result.content) ? result.content.map((/** @type {any} */ x) => (typeof x === 'string' ? x : x.text || '')).join('') : result.content;
        assert.equal(text, 'part-onepart-two');
        assert.deepEqual(validateAAIWire({ messages, system: null }), []);
    });

    it('S10 countConversationTurns counts genuine user turns, not tool messages', () => {
        const n = countConversationTurns({ messages: S10.input });
        assert.equal(n, 2, `expected 2 user turns, got ${n}`);
        assert.equal(isInjection({ m: {} }), false);
    });

    it('S11 OAI groups consecutive role-carrying assistant tool_calls rows', () => {
        const out = normalizeToOAI({ model: undefined, msgs: [
            { role: 'user', content: 'run both' },
            { role: 'assistant', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'f1', arguments: '{"x":1}' } }], content: 'calling' },
            { role: 'assistant', tool_calls: [{ id: 'a2', type: 'function', function: { name: 'f2', arguments: '{"y":2}' } }] },
            { role: 'tool', tool_call_id: 'a1', content: 'r1' },
            { role: 'tool', tool_call_id: 'a2', content: 'r2' }
        ] });
        const assistantMsgs = out.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
        assert.equal(assistantMsgs.length, 1, 'consecutive role rows must group into one assistant message');
        assert.equal(assistantMsgs[0].tool_calls.length, 2);
        assert.equal(assistantMsgs[0].content, 'calling', 'first row content preserved');
        assert.deepEqual(validateOAIWire(out), []);
    });

    it('S12 OAI reads function.arguments from role-carrying tool_calls (no argument loss)', () => {
        const out = normalizeToOAI({ model: undefined, msgs: [
            { role: 'user', content: 'go' },
            { role: 'assistant', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'f1', arguments: '{"keep":"me"}' } }] }
        ] });
        assert.equal(out[1].tool_calls[0].function.arguments, '{"keep":"me"}');
    });

    it('S13 AAI flags failed OAI/JAI tool results with is_error', () => {
        const failed = normalizeToAAI({ msgs: [
            { role: 'user', content: 'go' },
            { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ error: 'boom' }) }
        ] });
        const failedBlock = failed.messages.flatMap(m => m.content).find(b => b.type === 'tool_result');
        assert.equal(failedBlock.is_error, true, 'OAI {error:...} result must map to is_error');

        const jaiFailed = normalizeToAAI({ msgs: [
            { type: 'user_message', content: 'go' },
            { type: 'assistant_message_tool', id: 'c2', toolName: 'f', content: '{}' },
            { type: 'tool_message', id: 'c2', toolName: 'f', result: { error: 'kaboom' } }
        ] });
        const jaiBlock = jaiFailed.messages.flatMap(m => m.content).find(b => b.type === 'tool_result');
        assert.equal(jaiBlock.is_error, true, 'JAI {error:...} result must map to is_error');

        const ok = normalizeToAAI({ msgs: [
            { role: 'user', content: 'go' },
            { role: 'assistant', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'f', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c3', content: '{"total": 42}' }
        ] });
        const okBlock = ok.messages.flatMap(m => m.content).find(b => b.type === 'tool_result');
        assert.equal(okBlock.is_error, false, 'successful result must stay is_error=false');
    });

    it('S14 AAI does not flag a SUCCESSFUL result whose data contains an error key', () => {
        const ok = normalizeToAAI({ msgs: [
            { role: 'user', content: 'go' },
            { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: '{"error": "not found"}', success: true }
        ] });
        const block = ok.messages.flatMap(m => m.content).find(b => b.type === 'tool_result');
        assert.equal(block.is_error, false, 'success:true with error-key data must NOT be flagged');

        const okJai = normalizeToAAI({ msgs: [
            { type: 'user_message', content: 'go' },
            { type: 'assistant_message_tool', id: 'c2', toolName: 'f', content: '{}' },
            { type: 'tool_message', id: 'c2', toolName: 'f', result: { error: 'not found' }, success: true }
        ] });
        const jaiBlock = okJai.messages.flatMap(m => m.content).find(b => b.type === 'tool_result');
        assert.equal(jaiBlock.is_error, false, 'JAI success:true with error-key data must NOT be flagged');
    });

    it('S15 OAI file part (PDF) converts to an Anthropic document block, never leaking', () => {
        const { messages } = normalizeToAAI({ msgs: [
            { role: 'user', content: [
                { type: 'text', text: 'summarise' },
                { type: 'file', file: { filename: 'doc.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } },
            ] },
        ] });
        const blocks = messages.flatMap(m => m.content);
        const doc = blocks.find(b => b.type === 'document');
        assert.ok(doc, 'expected an Anthropic document block');
        assert.equal(doc.source.type, 'base64');
        assert.equal(doc.source.media_type, 'application/pdf');
        assert.equal(doc.source.data, 'JVBERi0=');
        assert.ok(!blocks.some((/** @type {any} */ b) => b.type === 'file'), 'file block must not leak to AAI');
        assert.deepEqual(validateAAIWire({ messages, system: null }), []);
    });

    it('S16 AAI document/image blocks convert to OAI file/image_url parts (turn not emptied)', () => {
        const out = normalizeToOAI({ model: undefined, msgs: [
            { role: 'user', content: [
                { type: 'text', text: 'summarise' },
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ] },
        ] });
        const user = out.find(m => m.role === 'user' && Array.isArray(m.content));
        assert.ok(user, 'a media-only AAI user turn must not be emptied');
        assert.equal(user.content[0].type, 'text');
        const file = user.content.find((/** @type {any} */ p) => p.type === 'file');
        assert.ok(file, 'expected an OAI file part');
        assert.ok(file.file.file_data.startsWith('data:application/pdf;base64,'));
        const img = user.content.find((/** @type {any} */ p) => p.type === 'image_url');
        assert.ok(img, 'expected an OAI image_url part');
        assert.ok(img.image_url.url.startsWith('data:image/png;base64,'));
        assert.ok(!JSON.stringify(out).includes('"type":"document"'), 'AAI blocks must not leak to the OAI wire');
        assert.deepEqual(validateOAIWire(out), []);
    });

    it('S17 file/document blocks become GAI inlineData (never dropped)', () => {
        const { contents } = normalizeToGAI({ msgs: [
            { role: 'user', content: [
                { type: 'text', text: 'summarise' },
                { type: 'file', file: { filename: 'doc.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } },
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
            ] },
        ] });
        const inlines = contents.flatMap(c => c.parts).filter(p => p.inlineData);
        assert.equal(inlines.length, 2, 'both media blocks must survive to the GAI wire');
        for (const p of inlines) assert.equal(p.inlineData.mimeType, 'application/pdf');
        assert.deepEqual(validateGAIWire({ contents, systemInstruction: null }), []);
    });

    it('S18 an un-inlinable file block (file_id) is dropped, never leaked to AAI', () => {
        const { messages } = normalizeToAAI({ msgs: [
            { role: 'user', content: [
                { type: 'text', text: 'summarise' },
                { type: 'file', file: { file_id: 'file-abc123' } },
            ] },
        ] });
        const blocks = messages.flatMap(m => m.content);
        assert.ok(!blocks.some((/** @type {any} */ b) => b.type === 'file'), 'file block must not leak to the Anthropic wire');
        assert.ok(!blocks.some((/** @type {any} */ b) => b.type === 'document'), 'no document block can be built from a file_id');
        assert.ok(blocks.some((/** @type {any} */ b) => b.type === 'text'), 'the text block survives');
        assert.deepEqual(validateAAIWire({ messages, system: null }), []);
    });

    it('S19 a url-source AAI image becomes an OAI image_url (turn not emptied)', () => {
        const out = normalizeToOAI({ model: undefined, msgs: [
            { role: 'user', content: [
                { type: 'text', text: 'look' },
                { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
            ] },
        ] });
        const user = out.find(m => m.role === 'user' && Array.isArray(m.content));
        assert.ok(user, 'a url-source image turn must not be emptied');
        const img = user.content.find((/** @type {any} */ p) => p.type === 'image_url');
        assert.ok(img, 'expected an OAI image_url part');
        assert.equal(img.image_url.url, 'https://example.com/a.png');
        assert.deepEqual(validateOAIWire(out), []);
    });

    it('all scenarios: reference converter B is wire-clean (harness sanity)', () => {
        for (const s of SCENARIOS) {
            if (s.provider === 'core') continue;
            if (s === S2) continue;
            assert.deepEqual(validate({ scenario: s, result: referenceConvert({ scenario: s }) }), [], `${s.name}: reference converter must be clean`);
        }
    });
});

// ─── Blind A/B report (BLIND_REPORT=1) ───────────────────────────────────────

if (process.env.BLIND_REPORT) {
    const report = SCENARIOS.map(s => {
        const a = merciConvert({ scenario: s });
        const b = referenceConvert({ scenario: s });
        return {
            name: s.name,
            provider: s.provider,
            input: typeof s.input === 'function' ? s.input() : s.input,
            implA_merci: a,
            implB_reference: b,
            a_errors: validate({ scenario: s, result: a }),
            b_errors: validate({ scenario: s, result: b }),
        };
    });
    const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratchpad');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'blind-report.json'), JSON.stringify(report, null, 2));
    console.log(`[blind-report] wrote scratchpad/blind-report.json (${report.length} scenarios)`);
}
