// @ts-check


/**
 * @file Bounded child-process runner for the tools layer.
 * @version 0.12.0
 *
 * @description
 * One spawn wrapper for one-shot commands: accumulates stdout/stderr, aborts
 * on timeout or an external signal. Callers decide exit-code semantics (the
 * promise always resolves with `{ code, stdout, stderr }`, even on non-zero
 * exit). A missing binary rejects with the raw ENOENT error — callers map it
 * to a friendly message. The `maxBuffer` cap bounds what is **buffered**, not
 * the child: the overflow is dropped and reported as `truncated: true` while the
 * command runs on to its own exit code, as `runPipeline` already does. A
 * command whose producer never ends therefore never settles on its own — pass
 * `timeoutMs` (or a caller `signal`) when the command can run forever.
 *
 * The child does **not** inherit the parent's environment: it gets the safe
 * allowlist the MCP stdio transport uses (`HOME`, `LOGNAME`, `PATH`, `SHELL`,
 * `TERM`, `USER`; the Windows equivalents there) plus the caller's explicit
 * `env`, so an API key in `process.env` never reaches a model-chosen command.
 * `inheritEnv: true` passes the whole parent environment, as before 0.8.0.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { LIMITS } from '../core/limit-config.mjs';
import { safeChildEnv } from './child-env.mjs';


/** Error `.code` carried by the rejection when a command hits `timeoutMs` (CMD_TIMEOUT). */
export const RUN_COMMAND_TIMEOUT_CODE = 'CMD_TIMEOUT';


/**
 * Always resolves with `{ code, stdout, stderr }` — even on non-zero exit —
 * plus `truncated` when the `maxBuffer` cap fired. A missing binary rejects
 * with the raw ENOENT error; an internal timeout rejects with an Error whose
 * `.code` is RUN_COMMAND_TIMEOUT_CODE; an external abort rejects as an
 * AbortError (cancellation, not a tool failure).
 * @param {{command: string, args?: string[], signal?: AbortSignal|null, timeoutMs?: number, maxBuffer?: number, spawn?: Function, cwd?: string, env?: Record<string, string>|null, inheritEnv?: boolean}} arg0 -
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, truncated?: boolean}>}
 */
export function runCommand({ command, args = [], signal = null, timeoutMs = 0, maxBuffer = LIMITS.run_command_max_buffer_bytes, spawn = nodeSpawn, cwd, env = null, inheritEnv = false }) {
    return new Promise((resolve, reject) => {
        const ac = new AbortController();
        const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(RUN_COMMAND_TIMEOUT_CODE), timeoutMs) : null;
        const onSignalAbort = () => ac.abort(signal?.reason ?? new Error('Aborted'));
        if (signal) {
            if (signal.aborted) onSignalAbort();
            else signal.addEventListener('abort', onSignalAbort, { once: true });
        }
        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        
        /** @type {import('node:child_process').ChildProcess|null} */
                let child = null;
        
        /** @type {ReturnType<typeof setTimeout>|null} */
                let killTimer = null;
        let truncated = false;
        let settled = false;
        let closed = false;
        /** @param {{fn: *, value: *}} arg0 */
        /** @param {{fn: *, value: *}} arg0 */
        const done = ({ fn, value }) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener?.('abort', onSignalAbort);
            fn(value);
        };
        /** @param {{code: *}} arg0 */
        /** @param {{code: *}} arg0 */
        const settleClose = ({ code }) => {
            closed = true;
            if (killTimer) { clearTimeout(killTimer); killTimer = null; }
            done({ fn: resolve, value: { code, stdout, stderr, ...(truncated ? { truncated: true } : {}) } });
        };
        const detached = process.platform !== 'win32';
        /** @param {{sig: *}} arg0 */
        /** @param {{sig: *}} arg0 */
        const killGroup = ({ sig }) => {
            if (!child?.pid) return;
            try {
                if (detached) process.kill(-child.pid, sig);
                else child.kill(sig);
            } catch {   }
        };
        ac.signal.addEventListener('abort', () => {
            if (closed) return;
            killGroup({ sig: 'SIGTERM' });
            if (killTimer) clearTimeout(killTimer);
            killTimer = setTimeout(() => killGroup({ sig: 'SIGKILL' }), LIMITS.run_command_kill_grace_ms);
            // No truncation bail-out here: the buffer cap no longer aborts, so
            // every abort is a caller signal or a timeout and must settle as a
            // rejection — a noisy slow command used to resolve with `code: null`.
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener?.('abort', onSignalAbort);
            const reason = ac.signal.reason;
            const isTimeout = reason === RUN_COMMAND_TIMEOUT_CODE;
            if (isTimeout) {
                const timeoutErr =  (new Error(`Command timed out after ${timeoutMs}ms`));
                /** @type {any} */ (timeoutErr).code = RUN_COMMAND_TIMEOUT_CODE;
                return reject(timeoutErr);
            }
            const abortErr =  (new Error(reason instanceof Error ? reason.message : 'Command aborted'));
            abortErr.name = 'AbortError';
            /** @type {any} */ (abortErr).code = 'ABORT_ERR';
            if (reason instanceof Error) abortErr.cause = reason;
            reject(abortErr);
        }, { once: true });
        try {
            child = spawn(command, args, { signal: ac.signal, stdio: ['ignore', 'pipe', 'pipe'], detached, ...(cwd ? { cwd } : {}), env: { ...(inheritEnv ? process.env : safeChildEnv()), ...(env ?? {}) } });
        } catch (err) {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener?.('abort', onSignalAbort);
            return reject(err);
        }
        // Decode through the stream's StringDecoder: a multibyte character split across two
        // chunks stays whole (per-chunk Buffer-to-string turned it into U+FFFD).
        child?.stdout?.setEncoding('utf8');
        child?.stderr?.setEncoding('utf8');
        /** @param {{d: *, which: *}} arg0 */
        const grow = ({ d, which }) => {
            const used = which === 'stdout' ? stdoutBytes : stderrBytes;
            const dLen = Buffer.byteLength(d);
            if (used + dLen > maxBuffer) {
                // The cap bounds what this call buffers, not the child's life:
                // killing it reported `code: null` for a command that only
                // talked too much. The rest of the output is read and dropped,
                // so the exit code stays real (as `runPipeline` already does).
                truncated = true;
                if (used < maxBuffer) {
                    const keep = Buffer.from(d).subarray(0, maxBuffer - used).toString('utf8');
                    if (which === 'stdout') { stdoutBytes = maxBuffer; stdout += keep; }
                    else { stderrBytes = maxBuffer; stderr += keep; }
                }
                return;
            }
            if (which === 'stdout') { stdoutBytes += dLen; stdout += d; }
            else { stderrBytes += dLen; stderr += d; }
        };
        child?.stdout?.on('data', ( d) => { grow({ d, which: 'stdout' }); });
        child?.stderr?.on('data', ( d) => { grow({ d, which: 'stderr' }); });
        ( (/** @type {any} */ (child))).on('error', /** @type {(...args: any[]) => any} */ (( err) => {
            // A child `error` is a spawn/kill failure, never a result: a
            // truncated-and-failed command must reject, not resolve with a null
            // code the shell tool would read as a signal death it can report.
            done({ fn: reject, value: err });
        }));
        ( (/** @type {any} */ (child))).on('close', /** @type {(...args: any[]) => any} */ (( code) => settleClose({ code })));
    });
}


/**
 * Run stages connected through stdout → stdin, like a shell pipeline but with
 * no shell: every stage is an argv array, so `|`, `>` and `$()` still never
 * reach a process. The exit code is the **last** stage's; an upstream stage that
 * fails (rg finding nothing, a writer whose reader closed the pipe) does not
 * fail the pipeline. Every stage is awaited, not only the last one.
 *
 * stderr is the concatenation of every stage and is capped without aborting the
 * run: `truncated: true` reports the cap, and the last stage's answer survives a
 * noisy neighbour.
 * @param {{
 *   stages: Array<{command: string, args?: string[]}>,
 *   signal?: AbortSignal|null,
 *   timeoutMs?: number,
 *   maxBuffer?: number,
 *   spawn?: Function,
 *   cwd?: string,
 *   env?: Record<string, string>|null,
 *   inheritEnv?: boolean
 * }} arg0 -
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, truncated?: boolean}>}
 */
export function runPipeline({ stages = [], signal = null, timeoutMs = 0, maxBuffer = LIMITS.run_command_max_buffer_bytes, spawn = nodeSpawn, cwd, env = null, inheritEnv = false }) {
    return new Promise((resolve, reject) => {
        if (!Array.isArray(stages) || stages.length === 0) {
            return reject(new Error('runPipeline requires at least one stage'));
        }
        const ac = new AbortController();
        const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(RUN_COMMAND_TIMEOUT_CODE), timeoutMs) : null;
        const onSignalAbort = () => ac.abort(signal?.reason ?? new Error('Aborted'));
        if (signal) {
            if (signal.aborted) onSignalAbort();
            else signal.addEventListener('abort', onSignalAbort, { once: true });
        }
        const detached = process.platform !== 'win32';
        const childEnv = { ...(inheritEnv ? process.env : safeChildEnv()), ...(env ?? {}) };
        // A signal that was already aborted must never spawn anything. The
        // listener below would not fire: `ac.abort()` ran before it existed.
        if (signal?.aborted) {
            if (timer) clearTimeout(timer);
            signal.removeEventListener?.('abort', onSignalAbort);
            const preAbort = new Error(signal.reason instanceof Error ? signal.reason.message : 'Command aborted');
            preAbort.name = 'AbortError';
            /** @type {any} */ (preAbort).code = 'ABORT_ERR';
            if (signal.reason instanceof Error) preAbort.cause = signal.reason;
            return reject(preAbort);
        }
        /** @type {Array<import('node:child_process').ChildProcess>} */
        const children = [];
        /** @type {Array<number|null>} */
        const codes = Array.from({ length: stages.length }, () => null);
        let stdout = '';
        let stdoutBytes = 0;
        let stderr = '';
        let stderrBytes = 0;
        let truncated = false;
        let closed = 0;
        let settled = false;
        /** @type {ReturnType<typeof setTimeout>|null} */
        let killTimer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (killTimer) { clearTimeout(killTimer); killTimer = null; }
            signal?.removeEventListener?.('abort', onSignalAbort);
        };
        /** @param {NodeJS.Signals} sig */
        const killAll = (sig) => {
            for (const child of children) {
                try {
                    if (detached && child.pid) process.kill(-child.pid, sig);
                    else child.kill(sig);
                } catch { /* already gone */ }
            }
        };
        ac.signal.addEventListener('abort', () => {
            if (settled) return;
            killAll('SIGTERM');
            settled = true;
            cleanup();
            // Escalate after the graceful signal. Set AFTER `cleanup()`, which
            // clears the timer, or the SIGKILL would never fire.
            killTimer = setTimeout(() => killAll('SIGKILL'), LIMITS.run_command_kill_grace_ms);
            killTimer.unref?.();
            const reason = ac.signal.reason;
            if (reason === RUN_COMMAND_TIMEOUT_CODE) {
                const timeoutErr = new Error(`Command timed out after ${timeoutMs}ms`);
                /** @type {any} */ (timeoutErr).code = RUN_COMMAND_TIMEOUT_CODE;
                return reject(timeoutErr);
            }
            const abortErr = new Error(reason instanceof Error ? reason.message : 'Command aborted');
            abortErr.name = 'AbortError';
            /** @type {any} */ (abortErr).code = 'ABORT_ERR';
            if (reason instanceof Error) abortErr.cause = reason;
            reject(abortErr);
        }, { once: true });

        /** @param {string} d */
        const growStderr = (d) => {
            if (stderrBytes >= maxBuffer) { truncated = true; return; }
            const dLen = Buffer.byteLength(d);
            if (stderrBytes + dLen > maxBuffer) {
                stderr += Buffer.from(d).subarray(0, maxBuffer - stderrBytes).toString('utf8');
                stderrBytes = maxBuffer;
                truncated = true;
                return;
            }
            stderr += d;
            stderrBytes += dLen;
        };

        for (let index = 0; index < stages.length; index += 1) {
            const stage = stages[index];
            const isLast = index === stages.length - 1;
            /** @type {import('node:child_process').ChildProcess} */
            let child;
            try {
                child = spawn(stage.command, stage.args ?? [], {
                    stdio: [index === 0 ? 'ignore' : 'pipe', 'pipe', 'pipe'],
                    detached,
                    ...(cwd ? { cwd } : {}),
                    env: childEnv
                });
            } catch (err) {
                settled = true;
                killAll('SIGTERM');
                cleanup();
                return reject(err);
            }
            children.push(child);
            child.stderr?.setEncoding('utf8');
            child.stderr?.on('data', growStderr);
            child.stderr?.on('error', () => { /* diagnostics are best-effort */ });
            if (index > 0) {
                const upstream = children[index - 1];
                // A reader that exits early closes the pipe; EPIPE is a normal
                // pipeline signal, never a tool failure. Destroy the parent's
                // read end too: a paused `pipe()` source otherwise blocks the
                // producer forever (a full pipe, no SIGPIPE), so the stage never
                // closes and the pipeline deadlocks until its timeout.
                child.stdin?.on('error', () => { /* EPIPE */ });
                upstream.stdout?.on('error', () => { /* EPIPE */ });
                child.on('close', () => {
                    upstream.stdout?.destroy();
                });
                if (child.stdin) upstream.stdout?.pipe(child.stdin);
            }
            if (isLast) {
                child.stdout?.setEncoding('utf8');
                child.stdout?.on('data', (/** @type {string} */ d) => {
                    if (stdoutBytes >= maxBuffer) { truncated = true; return; }
                    const dLen = Buffer.byteLength(d);
                    if (stdoutBytes + dLen > maxBuffer) {
                        stdout += Buffer.from(d).subarray(0, maxBuffer - stdoutBytes).toString('utf8');
                        stdoutBytes = maxBuffer;
                        truncated = true;
                        return;
                    }
                    stdout += d;
                    stdoutBytes += dLen;
                });
                child.stdout?.on('error', () => { /* EPIPE */ });
            }
            child.on('error', (/** @type {any} */ err) => {
                if (settled) return;
                settled = true;
                killAll('SIGTERM');
                cleanup();
                reject(err);
            });
            child.on('close', (/** @type {number|null} */ code) => {
                codes[index] = code;
                closed += 1;
                if (settled) return;
                if (closed === stages.length) {
                    settled = true;
                    cleanup();
                    resolve({ code: codes[stages.length - 1] ?? null, stdout, stderr, ...(truncated ? { truncated: true } : {}) });
                }
            });
        }
    });
}
