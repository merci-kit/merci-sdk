// @ts-check


/**
 * @file Public surface of the workspace modules.
 * @version 0.12.0
 *
 * @description
 * The barrel grows with each stage: keys, path containment, lifecycle hooks,
 * the manager, and the tool binder today. A test imports through this file so
 * `check:coverage` sees every workspace module from the published path.
 *
 * Only the intended public surface is re-exported. `normalizeHooks`,
 * `runWorkspaceHook`, and the path guards (`resolveWorkspaceRoot`,
 * `assertDirectoryTarget`, `assertRealPathInsideRoot`) are internal; a test
 * that needs them imports `hooks.mjs` or `paths.mjs` directly.
 */
export { workspaceKeyFor } from './keys.mjs';
export { resolveWorkspacePath, isInsideRoot } from './paths.mjs';
export { WORKSPACE_HOOKS } from './hooks.mjs';
export { WorkspaceManager, WORKSPACE_STRATEGIES } from './manager.mjs';
export { createWorkspaceTools } from './toolbox.mjs';
