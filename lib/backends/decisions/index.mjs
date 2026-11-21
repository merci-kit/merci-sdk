// @ts-check
/**
 * @file Public surface of the decision (System One) client.
 * @version 0.23.0
 *
 * @description
 * `createDecisionsClient` is the standalone entry point; the OAI and GAI
 * backend clients also expose it as `client.decisions`, reusing the credentials
 * and transport they already resolved. The adapters stay private: a caller
 * writes the canonical questions and reads canonical answers.
 */

export { createDecisionsClient } from './client.mjs';
