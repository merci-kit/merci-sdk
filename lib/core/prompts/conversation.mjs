// @ts-check


/**
 * @file Conversation-history compaction prompts.
 * @version 0.12.0
 *
 * @description
 * The summarizer persona and schema used by opt-in history compaction
 * (runAgenticLoop opts.compaction, DiscussionSession tail summarization),
 * plus the marker placed in place of the folded prefix.
 */
import { z } from 'zod';


/** Marker replacing the folded prefix in a compacted history. */
export const CONVERSATION_SUMMARY_MARKER = '[Summarized earlier conversation]';


/**
 * Zod schema for the summarizer's single-output response. Converted to JSON Schema at
 * the wire boundary (`UnifiedParameterBuilder._build`), so every backend still receives
 * plain JSON Schema.
 * @type {import('zod').ZodType}
 */
export const CONVERSATION_SUMMARY_SCHEMA = z.strictObject({
    summary: z.string().describe('Concise, retention-worthy summary of the earlier conversation turns.')
});


/** Summarizer persona: preserve goals, constraints, decisions, facts, unfinished work. */
export const CONVERSATION_SUMMARY_PROMPT = [
    'You are a conversation historian. The following transcript contains earlier turns of an ongoing conversation.',
    "Summarize them concisely for later reference, preserving: the user's goals and constraints, decisions made,",
    'facts established, and any unfinished work. Keep the summary under 200 tokens. Never invent details.',
].join('\n');
