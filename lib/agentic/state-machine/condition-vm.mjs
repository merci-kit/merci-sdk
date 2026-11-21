// @ts-check
/**
 * @file The one `node:vm` evaluator for a string transition condition.
 * @version 0.12.0
 *
 * @description
 * Shared by the isolated child process (`condition-worker.mjs`) and the
 * in-process fallback in `condition-evaluator.mjs`, so both paths build the
 * same context and produce the same booleans.
 *
 * Security (D-1): the script evaluated inside the sandbox coerces to a primitive
 * boolean there (`!!(expr)`), so the caller never receives, reads a property of,
 * or calls a method on a sandbox object. The old `.then`/`.catch` probe handed
 * the sandbox a host function (`f.constructor` was the host `Function`), which
 * escaped the sandbox entirely.
 *
 * Memory (D-8): this module bounds CPU time only. The caller must run it in a
 * process whose heap V8 may abort without taking the host down.
 */

import vm from 'node:vm';

/** `code` of the error thrown when the expression produced a thenable. */
export const CONDITION_THENABLE = 'ERR_CONDITION_THENABLE';

/**
 * Compiles the expression into a sandbox script whose completion value is a
 * primitive boolean (or the thenable sentinel). Throws a `SyntaxError` when the
 * source is not a valid expression or statement body.
 * @param {{src: string}} arg0
 * @returns {import('node:vm').Script}
 */
export function compileConditionScript({ src }) {
  return new vm.Script(
    `"use strict"; (() => { const v = (${src}); return (v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function') ? "__MERCI_THENABLE__" : !!v; })();`,
    { filename: 'state-machine-condition' },
  );
}

/**
 * Evaluates one condition against `payloadJson` in a fresh hardened context.
 * @param {{src: string, payloadJson: string, timeoutMs: number}} arg0
 * @returns {boolean}
 */
export function runConditionInVm({ src, payloadJson, timeoutMs }) {
  const script = compileConditionScript({ src });
  const sandbox = Object.create(null);
  sandbox.__merci_json = payloadJson;
  const context = vm.createContext(sandbox, { name: 'state-machine-condition', codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  vm.runInContext('ctx = JSON.parse(__merci_json); ctx.get = function (k) { return ctx[k]; };', context, { timeout: timeoutMs });
  const out = script.runInContext(context, { timeout: timeoutMs, displayErrors: false });
  if (out === '__MERCI_THENABLE__') {
    throw Object.assign(new Error('the expression returned a thenable'), { code: CONDITION_THENABLE });
  }
  return out === true;
}
