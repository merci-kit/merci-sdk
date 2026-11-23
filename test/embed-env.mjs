// @ts-check
/**
 * @file A clean clone has no `secret.env`, so the tests that drive a mocked
 * embed transport through a real client pin the model names the clients
 * resolve. Without this they soft-fail to `null` and assert nothing.
 * @version 0.23.0
 */

process.env.DEFAULT_OPENAI_EMBEDDING_MODEL ||= 'text-embedding-3-small';
process.env.DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL ||= 'text-embedding-004';
process.env.DEFAULT_GEMINI_EMBEDDING_MODEL ||= 'text-embedding-004';
