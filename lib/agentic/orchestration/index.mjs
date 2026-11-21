// @ts-check


/**
 * @file Public surface of the orchestration composition root.
 * @version 0.12.0
 *
 * @description
 * One name: `createOrchestration` binds the workflow policy, the scheduler, the
 * workspace manager and the operator API around one client, one work source,
 * and one `WORKFLOW.md`. The four primitives keep their own subpaths and stay
 * separately usable; this barrel is the assembly, not a replacement.
 *
 * `createItemTools` stays internal because it is the default binder, not a
 * policy a host chooses: a host that wants different tools passes `tools`.
 */
export { createOrchestration } from './facade.mjs';
