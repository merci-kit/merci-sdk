// @ts-check
/**
 * @file Memory-isolated evaluation of planner-authored string conditions.
 * @version 0.13.0
 *
 * @description
 * `node:vm` bounds a condition's CPU time, never its memory, so a single large
 * allocation aborts the whole host process with `FATAL ERROR: Reached heap
 * limit` (D-8). A `worker_threads` Worker with `resourceLimits` does not contain
 * it either: Node's near-heap-limit hook grants the worker only 16 MB of
 * leeway, and V8's OOM handler calls `abort()` process-wide. So string
 * conditions run in a CHILD PROCESS with its own `--max-old-space-size`; an
 * OOM kills that child and the caller receives a typed `ConfigurationError`.
 * The call is synchronous, so the condition keeps full JS expression semantics
 * and the caller's API stays synchronous.
 *
 * Cost: one child, started lazily and reused for every condition, driven over
 * two pipes with `fs.writeSync`/`fs.readSync` (EAGAIN polled with
 * `Atomics.wait`, no timers). Measured on an arm64 laptop: 20 evaluations of
 * one compiled condition in ~27-57 ms total, versus ~850 ms for one `spawnSync`
 * start per evaluation; a 20-transition `StateMachine` (~31-210 ms across runs)
 * was ~915 ms. If the pipes are not reachable the evaluator falls back to the
 * old one-shot `spawnSync` path (`condition-worker.mjs --once`), which still
 * pays one start per condition. Host-function conditions stay in-process and
 * are unaffected.
 *
 * The child reports its `heapUsed` with every frame. A condition that leaves
 * the child above half its heap cap gets that child replaced before the next
 * evaluation: the pages a heavy condition leaves behind would make the next
 * near-cap condition OOM where a fresh child would not.
 *
 * Permission scope: when the host itself runs under Node's permission model,
 * the child receives the host's own `--permission` and `--allow-*` flags, so
 * it never exceeds the host's scope; the single grant added is
 * `--allow-fs-read=<dir of condition-worker.mjs>`, which the child needs to
 * import this SDK's modules. A host without the permission model passes none.
 * Node >= 26 propagates the permission flags to `spawn` on its own; this SDK
 * forwards them explicitly because it blanks `NODE_OPTIONS` for the child.
 *
 * Fail closed: a host that forbids child processes — Node's permission model
 * without `--allow-child-process` — throws `ERR_ACCESS_DENIED` from `spawn`.
 * The default is to refuse with a typed `ConfigurationError` that names both
 * remedies, instead of silently losing the memory bound. Setting
 * `condition_unisolated_vm` (`MERCI_LIMIT_CONDITION_UNISOLATED_VM=1`) opts
 * into the in-process `node:vm` path, which warns once through both `sdkWarn`
 * and `process.emitWarning` that the memory bound is unavailable.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigurationError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { sdkWarn } from '../../support/utils.mjs';
import { runConditionInVm, CONDITION_THENABLE } from './condition-vm.mjs';

const WORKER_PATH = fileURLToPath(new URL('./condition-worker.mjs', import.meta.url));

/** Set once the host refuses child processes; the warning is not repeated. */
let isolationUnavailable = false;

/** Set once the synchronous pipe bridge turns out to be unusable. */
let persistentUnavailable = false;

/** @type {import('node:child_process').ChildProcess | null} */
let bridge = null;
/** @type {number | null} */
let stdinFd = null;
/** @type {number | null} */
let stdoutFd = null;
/** @type {number | null} */
let stderrFd = null;
/** Bytes read past the response line, kept for the next request. */
let responseCarry = Buffer.alloc(0);
let bridgeSpawns = 0;
/** @type {number|null} The heap cap the live child was started with; a limit change respawns it. */
let bridgeMemoryMb = null;
let evaluations = 0;
let exitHookRegistered = false;

/** One 1 ms sleep without timers; the caller is synchronous. */
const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(4));

function sleepOneMs() {
  Atomics.wait(SLEEP_WORD, 0, 0, 1);
}

/**
 * The argument vector for the evaluator child. Permission flags are forwarded
 * only when the host itself runs under the permission model; the worker module
 * directory is the one grant added.
 * @internal
 * @param {{memoryMb: number, execArgv?: string[], workerPath?: string}} arg0
 * @returns {string[]}
 */
export function conditionChildArgs({ memoryMb, execArgv = process.execArgv, workerPath = WORKER_PATH }) {
  const args = [`--max-old-space-size=${memoryMb}`];
  const scoped = process.permission !== undefined || execArgv.some((a) => /^--(experimental-)?permission(-audit)?$/.test(a));
  if (!scoped) return args;
  for (const arg of execArgv) {
    if (/^--(experimental-)?permission(-audit)?$/.test(arg) || /^--allow-/.test(arg)) args.push(arg);
  }
  args.push(`--allow-fs-read=${dirname(workerPath)}`);
  return args;
}

/**
 * @internal
 * @returns {{spawns: number, evaluations: number, persistent: boolean}}
 */
export function conditionEvaluatorStats() {
  return { spawns: bridgeSpawns, evaluations, persistent: bridge !== null };
}

/**
 * @returns {ConfigurationError}
 */
function thenableError() {
  return new ConfigurationError({ message: 'StateMachine: condition must be synchronous — the expression returned a thenable', options: { option: 'condition' } });
}

/**
 * Kills and forgets the child; the next evaluation starts a new one.
 */
function killBridge() {
  const child = bridge;
  bridge = null;
  bridgeMemoryMb = null;
  stdinFd = null;
  stdoutFd = null;
  stderrFd = null;
  responseCarry = Buffer.alloc(0);
  if (!child) return;
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream?.destroy();
    } catch {
      // Already gone.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Stops the child at host exit without SIGKILL: closing the request pipe gives
 * it EOF, so it exits normally and flushes its own V8 coverage profile (the
 * coverage gate measures every runtime file, including this one). The wait is
 * bounded, and a child that ignores EOF is still killed.
 */
function shutdownBridgeAtExit() {
  if (!bridge) return;
  // Synchronous close: `stdin.end()` only queues the FIN on a loop that is
  // already shutting down, so the child would not see EOF before the host dies.
  try {
    if (stdinFd !== null) fs.closeSync(stdinFd);
  } catch {
    // Already closed.
  }
  stdinFd = null;
  const deadline = Date.now() + 250;
  const scratch = Buffer.allocUnsafe(4096);
  while (stdoutFd !== null && Date.now() < deadline) {
    try {
      if (fs.readSync(stdoutFd, scratch, 0, scratch.length, null) === 0) break;
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        sleepOneMs();
        continue;
      }
      break;
    }
  }
  killBridge();
}

function registerExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  // unref() lets the host exit with the child still alive; this makes sure the
  // child stops (cleanly, so its coverage profile is written) with the host.
  process.once('exit', () => shutdownBridgeAtExit());
}

/**
 * One policy for a host that denies child processes. Refuses by default; when
 * the host opted in (`condition_unisolated_vm`), warns once and reports that
 * the caller may evaluate in-process. Spawning is never retried after a denial,
 * so the opt-in cannot be reached by retrying.
 * @returns {true}
 */
function allowUnisolatedFallback() {
  if (LIMITS.condition_unisolated_vm === 1) {
    isolationUnavailable = true;
    warnIsolationUnavailable();
    return true;
  }
  throw new ConfigurationError({
    message: 'StateMachine: condition cannot run in an isolated process (child processes are denied); run Node with --allow-child-process, or set MERCI_LIMIT_CONDITION_UNISOLATED_VM=1 to accept losing the memory bound.',
    options: { option: 'condition' },
  });
}

/**
 * Starts the persistent child. Returns false when it cannot serve (no pipe, or
 * a denial the host opted into), leaving the one-shot path to the caller.
 * Throws when child processes are denied and the host did not opt in.
 * @returns {boolean}
 */
function startBridge() {
  const memoryMb = LIMITS.condition_memory_mb;
  /** @type {import('node:child_process').ChildProcess} */
  let child;
  try {
    child = spawn(process.execPath, [...conditionChildArgs({ memoryMb }), WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // A host preload must not print into the child's stdout frames.
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ERR_ACCESS_DENIED') {
      allowUnisolatedFallback();
    } else {
      persistentUnavailable = true;
    }
    return false;
  }
  const inHandle = /** @type {any} */ (child.stdin)?._handle;
  const outHandle = /** @type {any} */ (child.stdout)?._handle;
  const errHandle = /** @type {any} */ (child.stderr)?._handle;
  if (!inHandle || !outHandle || typeof inHandle.fd !== 'number' || typeof outHandle.fd !== 'number') {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    persistentUnavailable = true;
    return false;
  }
  bridge = child;
  stdinFd = inHandle.fd;
  stdoutFd = outHandle.fd;
  stderrFd = typeof errHandle?.fd === 'number' ? errHandle.fd : null;
  bridgeSpawns += 1;
  bridgeMemoryMb = memoryMb;
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream) continue;
    // The bridge is driven through the raw fds; stream errors (EPIPE after an
    // OOM) must not surface as an unhandled 'error' event.
    stream.on('error', () => {});
    const streamRef = /** @type {any} */ (stream);
    if (typeof streamRef.unref === 'function') streamRef.unref();
  }
  child.on('error', () => {});
  registerExitHook();
  return true;
}

/**
 * @returns {boolean}
 */
function ensureBridge() {
  // Raw-fd pipe polling is POSIX-only; the one-shot `spawnSync` path is
  // portable and correct, just slower, so Windows and the explicit opt-in take
  // it before a spawn is attempted.
  if (process.platform === 'win32' || process.env.MERCI_CONDITION_ONESHOT === '1') return false;
  // `condition_memory_mb` resolves per call: a host that lowers or raises it must
  // not keep evaluating under the previous child's heap cap.
  if (bridge && bridgeMemoryMb !== LIMITS.condition_memory_mb) killBridge();
  if (bridge) return true;
  if (persistentUnavailable) return false;
  if (!startBridge()) return false;
  return true;
}

/**
 * Writes the whole request; false when the pipe is gone.
 * @param {{fd: number, buf: Buffer}} arg0
 * @returns {boolean}
 */
function writeAll({ fd, buf }) {
  let offset = 0;
  while (offset < buf.length) {
    let written;
    try {
      written = fs.writeSync(fd, buf, offset, buf.length - offset);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        sleepOneMs();
        continue;
      }
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'EBADF') return false;
      throw err;
    }
    if (written === 0) {
      sleepOneMs();
      continue;
    }
    offset += written;
  }
  return true;
}

/**
 * Reads one response line. `eof` means the child died; `timeout` means the
 * deadline passed with no line.
 * @param {{deadline: number}} arg0
 * @returns {{kind: 'line', line: string} | {kind: 'eof'} | {kind: 'timeout'}}
 */
function readFrame({ deadline }) {
  let pending = responseCarry;
  responseCarry = Buffer.alloc(0);
  const scratch = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const index = pending.indexOf(10);
    if (index >= 0) {
      const line = pending.subarray(0, index).toString('utf8');
      responseCarry = pending.subarray(index + 1);
      return { kind: 'line', line };
    }
    if (Date.now() > deadline) return { kind: 'timeout' };
    let read;
    try {
      read = fs.readSync(/** @type {number} */ (stdoutFd), scratch, 0, scratch.length, null);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        sleepOneMs();
        continue;
      }
      // EBADF or a closed pipe: the child is gone.
      return { kind: 'eof' };
    }
    if (read === 0) return { kind: 'eof' };
    const chunk = Buffer.from(scratch.subarray(0, read));
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  }
}

/**
 * Best-effort stderr text of a dead child, read through the raw fd so the host
 * stays synchronous. The OOM banner is what separates a heap abort from a
 * startup crash, and it sits at the head of stderr.
 *
 * No cap: this runs only after stdout reached EOF, i.e. the child is gone, and
 * a condition can neither reach `process` nor write to stderr, so what remains
 * readable is Node's own crash output inside one pipe buffer.
 * @returns {string}
 */
function drainStderr() {
  if (stderrFd === null) return '';
  const scratch = Buffer.allocUnsafe(16 * 1024);
  let text = '';
  try {
    for (;;) {
      const read = fs.readSync(stderrFd, scratch, 0, scratch.length, null);
      if (read === 0) break;
      text += scratch.subarray(0, read).toString('utf8');
    }
  } catch {
    // EAGAIN or a closed pipe: whatever was readable is the tail.
  }
  return text;
}

/**
 * Parses one response frame into its object form.
 * @param {{raw: string}} arg0
 * @returns {{kind?: number, message?: string, heapUsed?: number}}
 */
function parseFrame({ raw }) {
  /** @type {{kind?: number, message?: string, heapUsed?: number}} */
  let out;
  try {
    out = JSON.parse(raw);
  } catch {
    throw new ConfigurationError({ message: 'StateMachine: condition evaluation returned no readable result', options: { option: 'condition' } });
  }
  if (!out || typeof out !== 'object' || Array.isArray(out)) {
    throw new ConfigurationError({ message: 'StateMachine: condition evaluation returned a malformed result', options: { option: 'condition' } });
  }
  return out;
}

/**
 * Maps one parsed frame to a boolean or a typed error.
 * @param {{out: {kind?: number, message?: string}, timeoutMs: number}} arg0
 * @returns {boolean}
 */
function decodeResult({ out, timeoutMs }) {
  if (out.kind === 1) return true;
  if (out.kind === 0) return false;
  if (out.kind === 3) throw thenableError();
  const message = String(out.message || 'unknown error');
  if (/Script execution timed out|timed out/i.test(message)) {
    throw new ConfigurationError({ message: `StateMachine: condition exceeded its time budget (${timeoutMs}ms)`, options: { option: 'condition' } });
  }
  throw new ConfigurationError({ message: `StateMachine: condition evaluation failed: ${message}`, options: { option: 'condition' } });
}

/**
 * Maps one response frame to a boolean or a typed error. Shared by the
 * persistent bridge and the one-shot `spawnSync` path so both report the same
 * outcomes.
 * @param {{raw: string, timeoutMs: number}} arg0
 * @returns {boolean}
 */
function decodeFrame({ raw, timeoutMs }) {
  return decodeResult({ out: parseFrame({ raw }), timeoutMs });
}

/**
 * One evaluation through the persistent child.
 * @param {{src: string, payloadJson: string, timeoutMs: number}} arg0
 * @returns {boolean}
 */
function evaluateThroughBridge({ src, payloadJson, timeoutMs }) {
  const memoryMb = LIMITS.condition_memory_mb;
  const deadline = Date.now() + timeoutMs + 250;
  const request = Buffer.from(`${JSON.stringify({ src, payloadJson, timeoutMs, maxMessageChars: LIMITS.stderr_tail_chars })}\n`);
  if (!writeAll({ fd: /** @type {number} */ (stdinFd), buf: request })) {
    killBridge();
    throw new ConfigurationError({ message: `StateMachine: condition evaluator exited before evaluating the condition`, options: { option: 'condition' } });
  }
  const frame = readFrame({ deadline });
  if (frame.kind === 'timeout') {
    killBridge();
    throw new ConfigurationError({ message: `StateMachine: condition exceeded its time budget (${timeoutMs}ms)`, options: { option: 'condition' } });
  }
  if (frame.kind === 'eof') {
    const stderr = drainStderr();
    const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, LIMITS.stderr_tail_chars);
    killBridge();
    // V8's heap abort is an abort() in the child; the banner is the evidence
    // the exit status would carry if the blocked host could observe it.
    if (/Reached heap limit|heap out of memory|Allocation failed/i.test(stderr)) {
      throw new ConfigurationError({ message: `StateMachine: condition exceeded its memory budget (MERCI_LIMIT_CONDITION_MEMORY_MB, ${memoryMb} MB) and was stopped`, options: { option: 'condition' } });
    }
    throw new ConfigurationError({ message: `StateMachine: condition evaluator exited unexpectedly${tail ? `: ${tail}` : ''}`, options: { option: 'condition' } });
  }
  const out = parseFrame({ raw: frame.line });
  const result = decodeResult({ out, timeoutMs });
  // Half the heap cap is the recycle threshold: it keeps a 128 MB child usable
  // after a heavy condition instead of letting the next near-cap one OOM.
  if (Number(out.heapUsed ?? 0) > (LIMITS.condition_memory_mb * 1024 * 1024) / 2) killBridge();
  return result;
}

function warnIsolationUnavailable() {
  const warning = 'Merci SDK: condition memory isolation is unavailable (child processes are denied) because MERCI_LIMIT_CONDITION_UNISOLATED_VM=1 was set; evaluating conditions in-process, without the D-8 memory bound. Run Node with --allow-child-process to restore it.';
  sdkWarn({ prefix: 'STATE-MACHINE', args: [warning] });
  // sdkWarn is gated by the log level; a host that silently loses the memory
  // bound must still be told, so this also goes to the platform warning path.
  process.emitWarning(warning, { type: 'MerciSDKWarning', code: 'MERCI_CONDITION_ISOLATION' });
}

/**
 * Evaluates a string condition in a separate process with a private heap cap.
 * @param {{src: string, payloadJson: string}} arg0
 * @returns {boolean}
 */
export function evaluateCondition({ src, payloadJson }) {
  evaluations += 1;
  if (isolationUnavailable) return evaluateInProcess({ src, payloadJson });
  const timeoutMs = LIMITS.condition_timeout_ms;
  if (ensureBridge()) {
    return evaluateThroughBridge({ src, payloadJson, timeoutMs });
  }
  if (isolationUnavailable) return evaluateInProcess({ src, payloadJson });
  return evaluateOneShot({ src, payloadJson, timeoutMs });
}

/**
 * The original path: one child per condition, used when the pipe bridge is not
 * reachable in this environment.
 * @param {{src: string, payloadJson: string, timeoutMs: number}} arg0
 * @returns {boolean}
 */
function evaluateOneShot({ src, payloadJson, timeoutMs }) {
  const memoryMb = LIMITS.condition_memory_mb;
  /** @type {import('node:child_process').SpawnSyncReturns<string>} */
  let res;
  try {
    // Same permission scope as the persistent child: the one-shot path must not
    // run a denied condition outside the host's flags.
    res = spawnSync(process.execPath, [...conditionChildArgs({ memoryMb }), WORKER_PATH, '--once'], {
      input: JSON.stringify({ src, payloadJson, timeoutMs, maxMessageChars: LIMITS.stderr_tail_chars }),
      encoding: 'utf8',
      timeout: timeoutMs + 500,
      maxBuffer: 1 << 20,
      windowsHide: true,
      // A host preload must not print into the child's single stdout frame.
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== 'ERR_ACCESS_DENIED') {
      throw new ConfigurationError({ message: `StateMachine: condition could not run in an isolated process: ${/** @type {Error} */ (err).message}`, options: { option: 'condition' } });
    }
    allowUnisolatedFallback();
    return evaluateInProcess({ src, payloadJson });
  }
  if (/** @type {any} */ (res.error)?.code === 'ETIMEDOUT') {
    throw new ConfigurationError({ message: `StateMachine: condition exceeded its time budget (${timeoutMs}ms)`, options: { option: 'condition' } });
  }
  if (res.signal || res.status !== 0) {
    // A signal is the OOM/abort path; a plain non-zero exit is a startup or
    // environment problem and its own stderr tail is the useful evidence.
    if (res.signal) {
      throw new ConfigurationError({ message: `StateMachine: condition exceeded its memory budget (MERCI_LIMIT_CONDITION_MEMORY_MB, ${memoryMb} MB) and was stopped`, options: { option: 'condition' } });
    }
    const tail = String(res.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, LIMITS.stderr_tail_chars);
    throw new ConfigurationError({ message: `StateMachine: condition evaluator exited with code ${res.status}${tail ? `: ${tail}` : ''}`, options: { option: 'condition' } });
  }
  return decodeFrame({ raw: res.stdout, timeoutMs });
}

/**
 * The fallback path: evaluate in this process. Bounds CPU only.
 * @param {{src: string, payloadJson: string}} arg0
 * @returns {boolean}
 */
function evaluateInProcess({ src, payloadJson }) {
  const timeoutMs = LIMITS.condition_timeout_ms;
  try {
    return runConditionInVm({ src, payloadJson, timeoutMs });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.code === CONDITION_THENABLE) throw thenableError();
    if (e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new ConfigurationError({ message: `StateMachine: condition exceeded its time budget (${timeoutMs}ms)`, options: { option: 'condition' } });
    }
    throw new ConfigurationError({ message: `StateMachine: condition evaluation failed: ${e?.message ?? e}`, options: { option: 'condition' } });
  }
}
