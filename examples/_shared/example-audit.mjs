// @ts-check
/**
 * Example audit spine — turns every example into a self-describing, machine-
 * readable live test.
 *
 * For each run it prints a framed trace (GOAL / EXPECT / RISK modes / INPUT →
 * OBSERVE → CHECK) and writes TWO artifacts into the example's own subdir under
 * `examples/.logs/<example>/`:
 *   - `<ts>.log`  a full, ANSI-stripped mirror of stdout+stderr (never truncated)
 *   - `<ts>.json` the structured trail: environment, scenarios, checks, events
 *   - `latest.log` / `latest.json`  stable pointers for an agent to read
 *
 * The contract: every scenario declares what it EXPECTS and how it can FAIL, so
 * a failing check prints a playbook naming the failure mode and a hint, instead
 * of a bare red line. `summary()` ends the run with `[AUDIT-RESULT] {json}` and
 * sets a non-zero exit code when any check failed.
 *
 * @version 0.12.0
 */

/**
 * Example audit spine — turns every example into a self-describing, machine-
 * readable live test.
 *
 * For each run it prints a framed trace (GOAL / EXPECT / RISK modes / INPUT →
 * OBSERVE → CHECK) and writes TWO artifacts into the example's own subdir under
 * `examples/.logs/<example>/`:
 *   - `<ts>.log`  a full, ANSI-stripped mirror of stdout+stderr (never truncated)
 *   - `<ts>.json` the structured trail: environment, scenarios, checks, events
 *   - `latest.log` / `latest.json`  stable pointers for an agent to read
 *
 * The contract: every scenario declares what it EXPECTS and how it can FAIL, so
 * a failing check prints a playbook naming the failure mode and a hint, instead
 * of a bare red line. `summary()` ends the run with `[AUDIT-RESULT] {json}` and
 * sets a non-zero exit code when any check failed.
 *
 * @version 0.12.0
 */

/**
 * Example audit spine — turns every example into a self-describing, machine-
 * readable live test.
 *
 * For each run it prints a framed trace (GOAL / EXPECT / RISK modes / INPUT →
 * OBSERVE → CHECK) and writes TWO artifacts into the example's own subdir under
 * `examples/.logs/<example>/`:
 *   - `<ts>.log`  a full, ANSI-stripped mirror of stdout+stderr (never truncated)
 *   - `<ts>.json` the structured trail: environment, scenarios, checks, events
 *   - `latest.log` / `latest.json`  stable pointers for an agent to read
 *
 * The contract: every scenario declares what it EXPECTS and how it can FAIL, so
 * a failing check prints a playbook naming the failure mode and a hint, instead
 * of a bare red line. `summary()` ends the run with `[AUDIT-RESULT] {json}` and
 * sets a non-zero exit code when any check failed.
 *
 * @version 0.12.0
 */


/**
 * Example audit spine — turns every example into a self-describing, machine-
 * readable live test.
 *
 * For each run it prints a framed trace (GOAL / EXPECT / RISK modes / INPUT →
 * OBSERVE → CHECK) and writes TWO artifacts into the example's own subdir under
 * `examples/.logs/<example>/`:
 *   - `<ts>.log`  a full, ANSI-stripped mirror of stdout+stderr (never truncated)
 *   - `<ts>.json` the structured trail: environment, scenarios, checks, events
 *   - `latest.log` / `latest.json`  stable pointers for an agent to read
 *
 * The contract: every scenario declares what it EXPECTS and how it can FAIL, so
 * a failing check prints a playbook naming the failure mode and a hint, instead
 * of a bare red line. `summary()` ends the run with `[AUDIT-RESULT] {json}` and
 * sets a non-zero exit code when any check failed.
 *
 * @version 0.12.0
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, attachEventLogger } from '../../lib/index.mjs';
/**
 * @typedef {object} FailMode
 * @property {string} code - short failure code
 * @property {string} symptom - what the failure looks like in the log
 * @property {string} [hint] - where to look / how to fix
 */

/**
 * @typedef {object} CheckRecord
 * @property {string} name
 * @property {boolean} ok
 * @property {string} [expected]
 * @property {string} [observed]
 * @property {string} [detail]
 * @property {string} [hint]
 * @property {string} [source]
 * @property {number} at
 */

/**
 * @typedef {object} ScenarioRecord
 * @property {string} id
 * @property {number} index
 * @property {string} title
 * @property {string} [goal]
 * @property {string} [expect]
 * @property {FailMode[]} fails
 * @property {*} [input]
 * @property {string} startedAt
 * @property {number} durationMs
 * @property {'pass'|'fail'|'skip'|'running'} outcome
 * @property {Array<{ name: string, value: *, at: number }>} observations
 * @property {CheckRecord[]} checks
 * @property {string} [hint]
 * @property {{ name: string, message: string, code?: string }|null} error
 */


const EXAMPLES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANSI = /\u001b\[[0-9;]*m/g;


/** @param {*} s @returns {string} */
/** @param {{s: *}} arg0 */
const stripAnsi = ({ s }) => String(s ?? '').replace(ANSI, '');

/** @param {*} s @returns {string} */
/** @param {{s: *}} arg0 */
const oneLine = ({ s }) => String(s ?? '').replace(/\s+/g, ' ').trim();


/** @param {{tag: *, body: *}} arg0 */
function frame({ tag, body }) {
    return `${tag} ${body}`;
}






/**
 * The audit surface returned by `createAudit`: a chainable scenario/check
 * recorder that renders the machine-readable `[AUDIT-RESULT]` footer.
 * @typedef {object} Audit
 * @property {string} id
 * @property {string} logDir
 * @property {() => void} begin
 * @property {(arg0: {id: string, title: string, goal?: string, expect?: string, fails?: FailMode[], input?: any}) => Audit} scenario
 * @property {(arg0: {name: string, value: any}) => Audit} observe
 * @property {(arg0: {name: string, ok: boolean, detail?: object|string, hint?: string}) => boolean} check
 * @property {(arg0: {name: string, why: string}) => Audit} skip
 * @property {(arg0: {name: string, err: any, expect: any}) => boolean} checkError
 * @property {(arg0: {fn: () => (Promise<any>|any)}) => Promise<{ok: boolean, value: any, error: any}>} probe
 * @property {() => void} end
 * @property {(err: any) => void} fatal
 * @property {(arg0: {scen: ScenarioRecord|null, rec: CheckRecord}) => void} _playbook
 * @property {() => {checks: number, passed: number, failed: number, skipped: number}} summary
 * @property {(main: () => Promise<void>) => Promise<void>} run
 */


/**
 * @param {{metaUrl: string, offline?: boolean, provider?: string|null, models?: string|null, env?: Record<string, *>, title?: string|null, id?: string|null, dir?: string|null}} arg0 - 
 * @returns {Audit}pass `import.meta.url` from the example.
 */
export function createAudit({ metaUrl, offline = false, provider = null, models = null, env = {}, title = null, id = null, dir = null }) {
    const modulePath = fileURLToPath(metaUrl);
    const exampleId = id ?? relative(EXAMPLES_ROOT, modulePath).replace(/\.[a-z]+$/, '');
    const logDir = dir ?? join(EXAMPLES_ROOT, '.logs', exampleId);

    const startedMs = Date.now();
    
    /** @type {ScenarioRecord[]} */
        const scenarios = [];
    
    /** @type {ScenarioRecord|null} */
        let current =  (null);
    let finished = false;
    
    /** @type {string[]} */
        const stdoutChunks = [];

    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);

    
    /** @param {*} line */
        /** @param {{line: *}} arg0 */
        const out = ({ line }) => { origStdout(`${line}\n`); };
    
    /** @param {*} tag @param {*} body */
        /** @param {{tag: *, body: *}} arg0 */
        const tagged = ({ tag, body }) => out({ line: `${log.bold({ t: tag })} ${body}` });

     /** @type {any} */
          (process.stdout).write = /** @type {(...args: any[]) => any} */ (( chunk,  enc,  cb) => {
        stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return origStdout(chunk, enc, cb);
    });
     /** @type {any} */
          (process.stderr).write = /** @type {(...args: any[]) => any} */ (( chunk,  enc,  cb) => {
        stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return origStderr(chunk, enc, cb);
    });

    
    /**
     * @returns {ScenarioRecord}
     * /
      * @param {{id: *, title?: *}} arg0
     */
        function makeScenario({ id, title = '' }) {
        return {
            id, index: scenarios.length + 1, title,
            fails: [], startedAt: new Date().toISOString(), durationMs: 0,
            outcome: 'running', observations: [], checks: [], error: null,
        };
    }

    const audit = /** @type {Audit} */ ({
        
        /** The example id derived from the module path (e.g. `advanced/33_audit_invariants`). */
                id: exampleId,
        
        logDir,

        
        /** Prints the begin sentinel + banner and the environment block. */
                begin() {
            tagged({ tag: '[AUDIT-BEGIN]', body: `example=${exampleId} offline=${offline} provider=${provider ?? '—'}` });
            out({ line: '' });
            log.header({ t: title ?? `Audit — ${exampleId}` });
            const envBlock = {
                node: process.version,
                platform: `${process.platform}/${process.arch}`,
                offline,
                provider: provider ?? '(none)',
                models: models ?? '(none)',
                tty: Boolean(process.stdout.isTTY),
                ...env,
            };
            for (const [k, v] of Object.entries(envBlock)) tagged({ tag: '[AUDIT-ENV]', body: `${k} = ${oneLine({ s: v })}` });
            out({ line: '' });
        },

        
        /**
 * Opens a scenario frame. Every scenario should declare what it expects
 * and how it can fail.
 * @param {{id: string, title: string, goal?: string, expect?: string, fails?: FailMode[], input?: *}} arg0
 * @returns {Audit} chainable
 */
                scenario({ id, title, goal, expect, fails = [], input = null }) {
            current = makeScenario({ id, title });
            current.goal = goal;
            current.expect = expect;
            current.fails = fails;
            current.input = input;
            scenarios.push(current);
            out({ line: '' });
            tagged({ tag: '[AUDIT-SCENARIO]', body: `${id} · ${title}  ${log.gray({ t: `(${current.index})` })}` });
            if (goal) tagged({ tag: '  [AUDIT-GOAL]', body: goal });
            if (expect) tagged({ tag: '  [AUDIT-EXPECT]', body: expect });
            // `fails` stays on the record for the playbook, but is printed only
            // when a check actually fails: a green run listing hypothetical
            // failures reads as if those failures happened.
            if (input !== null && input !== undefined) tagged({ tag: '  [AUDIT-INPUT]', body: oneLine({ s: JSON.stringify(input) }) });
            return audit;
        },

        
        /**
         * @param {{name: string, value: *}} arg0 -
         * @returns {Audit}
         * /
         */
                observe({ name, value }) {
            const at = Date.now();
            if (current) current.observations.push({ name, value, at });
            tagged({ tag: '  [AUDIT-OBSERVE]', body: `${name} = ${oneLine({ s: typeof value === 'object' ? JSON.stringify(value) : value })}` });
            return audit;
        },

        
        /**
         * @param {{name: string, ok: boolean, detail?: object|string, hint?: string}} arg0 -
         * @returns {boolean} ok
         * /
         */
                check({ name, ok, detail, hint }) {
            const d =  (typeof detail === 'object' && detail !== null ? detail : {});
            const rec = {
                name, ok,
                expected: /** @type {any} */ (d).expected,
                observed: /** @type {any} */ (d).observed ?? (typeof detail === 'string' ? detail : undefined),
                detail: typeof detail === 'string' ? detail : /** @type {any} */ (d).detail,
                hint: hint ?? /** @type {any} */ (d).hint,
                source: /** @type {any} */ (d).source,
                at: Date.now(),
            };
            if (current) current.checks.push(rec);
            const line = rec.detail ?? rec.observed ?? '';
            if (ok) tagged({ tag: '  [AUDIT-CHECK]', body: `${log.green({ t: '✓' })} ${name}${line ? ` ${log.gray({ t: '— ' + oneLine({ s: line }) })}` : ''}` });
            else {
                tagged({ tag: '  [AUDIT-CHECK]', body: `${log.red({ t: '✗' })} ${name}${line ? ` ${log.red({ t: '— ' + oneLine({ s: line }) })}` : ''}` });
                this._playbook({ scen: current, rec });
                process.exitCode = 1;
            }
            return ok;
        },

        
        /**
         * @param {{name: string, why: string}} arg0 -
         * @returns {Audit}
         * /
         */
                skip({ name, why }) {
            if (current) current.checks.push({ name, ok: true, detail: `SKIP: ${why}`, at: Date.now() });
            tagged({ tag: '  [AUDIT-SKIP]', body: `${name} — ${why}` });
            return audit;
        },

        
        /**
         * @param {{fn: () => Promise<T>|T}} arg0 -
         * @template T
         * @returns {Promise<{ ok: boolean, value: T|null, error: any }>}
         * /
         */
                async probe({ fn }) {
            try { return { ok: true, value: await fn(), error: null }; }
            catch (error) { return { ok: false, value: null, error }; }
        },

        
        /**
         * @param {{name: string, err: any, expect: *}} arg0 -
         * @returns {boolean}
         * /
         */
                checkError({ name, err, expect }) {
            if (!err) return this.check({ name, ok: false, detail: { observed: 'nothing was thrown', expected: expect.name ?? expect.code ?? 'a typed error' } });
            const nameOk = !expect.name || err.name === expect.name;
            const codeOk = !expect.code || err.code === expect.code;
            const msgOk = !expect.message || (expect.message instanceof RegExp ? expect.message.test(String(err.message)) : String(err.message).includes(expect.message));
            const ok = nameOk && codeOk && msgOk;
            return this.check({ name, ok, detail: {
                expected: `${expect.name ?? ''}${expect.code ? ` code=${expect.code}` : ''}${expect.message ? ` msg~${expect.message}` : ''}`.trim(),
                observed: `${err.name}${err.code ? ` code=${err.code}` : ''}: ${oneLine({ s: err.message })}`,
                hint: `a non-typed throw is the C13 regression — inspect the throw site`,
            } });
        },

        
        /** Marks the current scenario's outcome from its checks. */
                end() {
            if (!current) return audit;
            current.durationMs = Date.now() - Date.parse(current.startedAt);
            const failed = current.checks.some((c) => !c.ok) || Boolean(current.error);
            const allSkipped = current.checks.length > 0 && current.checks.every((c) => c.detail?.startsWith?.('SKIP'));
            current.outcome = failed ? 'fail' : (allSkipped ? 'skip' : 'pass');
            const mark = failed ? log.red({ t: '✗' }) : (allSkipped ? log.yellow({ t: '~' }) : log.green({ t: '✓' }));
            tagged({ tag: '[AUDIT-OUTCOME]', body: `${mark} ${current.id} · ${current.title} (${current.checks.length} check${current.checks.length === 1 ? '' : 's'})` });
            current =  (null);
            return audit;
        },

        
        /**
         * Records a fatal (uncaught) error on the current scenario.
         * @param {any} err
         */
                fatal(err) {
            const rec = { name: err?.name ?? 'Error', message: String(err?.message ?? err), code: err?.code };
            if (current) current.error = rec;
            else {
                const s = makeScenario({ id: 'fatal', title: 'uncaught error' });
                s.error = rec;
                s.outcome = 'fail';
                scenarios.push(s);
            }
        },

        
        /**
         * @param {{scen: ScenarioRecord|null, rec: CheckRecord}} arg0 -
         * /
         */
                _playbook({ scen, rec }) {
            tagged({ tag: '  [AUDIT-PLAYBOOK]', body: `${scen ? scen.id : '?'} — ${rec.name}` });
            if (scen?.expect) tagged({ tag: '    expected:', body: scen.expect });
            if (rec.observed) tagged({ tag: '    observed:', body: oneLine({ s: rec.observed }) });
            if (rec.hint) tagged({ tag: '    likely cause:', body: rec.hint });
            for (const f of scen?.fails ?? []) tagged({ tag: '    fail mode:', body: `${f.code} → ${f.symptom}${f.hint ? `  hint: ${f.hint}` : ''}` });
            tagged({ tag: '    next:', body: 'compare OBSERVE lines above with EXPECT, then inspect the hint/source file:line' });
        },

        
        /**
         * Writes the log artifacts, prints the scoreboard and the [AUDIT-RESULT]
         * machine line. Safe to call once (idempotent).
         * @returns {{ checks: number, passed: number, failed: number, skipped: number }}
         */
                summary() {
            if (finished) return { checks: 0, passed: 0, failed: 0, skipped: 0 };
            finished = true;
            if (current) this.end();

            const checks = scenarios.flatMap((s) => s.checks);
            const failed = checks.filter((c) => !c.ok);
            const passed = checks.length - failed.length;
            const skipped = checks.filter((c) => c.detail?.startsWith?.('SKIP')).length;
            const errors = scenarios.filter((s) => s.error).length;
            const endedMs = Date.now();
            const record = {
                schemaVersion: 1,
                example: exampleId,
                startedAt: new Date(startedMs).toISOString(),
                endedAt: new Date(endedMs).toISOString(),
                durationMs: endedMs - startedMs,
                environment: { node: process.version, platform: process.platform, offline, provider, models, ...env },
                scenarios,
                totals: { checks: checks.length, passed, failed: failed.length, skipped, errors },
            };

            const ts = new Date(startedMs).toISOString().replace(/[:.]/g, '-');
            const jsonPath = join(logDir, `${ts}.json`);
            const logPath = join(logDir, `${ts}.log`);
            const latestJson = join(logDir, 'latest.json');
            const latestLog = join(logDir, 'latest.log');
            const result = { example: exampleId, checks: checks.length, passed, failed: failed.length, skipped, errors, durationMs: endedMs - startedMs, log: logPath };
            let writeError =  (null);
            try {
                mkdirSync(logDir, { recursive: true });
                const json = JSON.stringify(record, null, 2);
                const text = stripAnsi({ s: stdoutChunks.join('') });
                writeFileSync(jsonPath, json);
                writeFileSync(logPath, text);
                writeFileSync(latestJson, json);
                writeFileSync(latestLog, text);
                const tail = [
                    '',
                    frame({ tag: '[AUDIT-RESULT]', body: JSON.stringify(result) }),
                    frame({ tag: '[AUDIT-LOG]', body: logPath }),
                    frame({ tag: '[AUDIT-END]', body: `failed=${failed.length} errors=${errors}` }),
                ].join('\n') + '\n';
                appendFileSync(logPath, tail);
                appendFileSync(latestLog, tail);
            } catch (err) {
                writeError =  (err);
            }

            out({ line: '' });
            log.divider();
            log.totals({ entries: { example: exampleId, checks: checks.length, passed, failed: failed.length, skipped, errors, durationMs: `${endedMs - startedMs}ms` } });
            out({ line: frame({ tag: '[AUDIT-RESULT]', body: JSON.stringify(result) }) });
            if (writeError) out({ line: frame({ tag: '[AUDIT-WARN]', body: `log not written: ${/** @type {any} */ (writeError).message}` }) });
            else out({ line: frame({ tag: '[AUDIT-LOG]', body: logPath }) });
            out({ line: frame({ tag: '[AUDIT-END]', body: `failed=${failed.length} errors=${errors}` }) });
            if (failed.length || errors) process.exitCode = 1;
            return { checks: checks.length, passed, failed: failed.length, skipped };
        },

        
        /**
         * The canonical footer: runs `main`, always flushes the log, and exits
         * non-zero on a fatal error or a failed check.
         * @param {() => Promise<void>} main
         * @returns {Promise<void>}
         */
                async run(main) {
            this.begin();
            try {
                await main();
            } catch (err) {
                this.fatal(err);
                log.error({ m: 'Example failed', d: (/** @type {any} */ (err))?.stack ??  (/** @type {any} */ (err))?.message });
                process.exitCode = 1;
            } finally {
                this.summary();
                 /** @type {any} */
                                  (process.stdout).write = origStdout;
                 /** @type {any} */
                                  (process.stderr).write = origStderr;
            }
        },
    });

    return audit;
}


/**
 * Subscribes a registry-driven catch-all logger to any emitter (client,
 * session, workflow executor, state machine, discussion group): every canonical
 * event is logged, summarized and redacted, level-gated. Replaces the old
 * hand-maintained 19-name list, which went stale as events were added.
 * @param {{emitter?: *, level?: string, filter?: ((arg0: {name: string, envelope: *}) => boolean)|null}} [arg0]
 * @returns {*} the emitter
 */
export function wireAllEvents({ emitter, level = 'info', filter = null } = {}) {
    attachEventLogger({ emitter, level, filter });
    return emitter;
}


/**
 * Derives the example id from the running script path (`process.argv[1]`), so
 * the auto-logging footer can locate the right per-example subdir.
 * @returns {string|null}
 */
export function exampleIdFromArgv() {
    const arg = process.argv[1];
    if (!arg) return null;
    const rel = relative(EXAMPLES_ROOT, arg).replace(/\.[a-z]+$/, '');
    return rel.startsWith('..') ? null : rel;
}


/**
 * spine (the live demos). Captures the FULL stdout+stderr and writes a text
 * mirror + a minimal JSON record into the example's own subdir. The migrated
 * examples use `createAudit` instead (scenarios + checks).
 * @param {{exampleId: string}} arg0 -
 * @returns {{ logDir: string, finish: (o?: { status?: string, error?: any }) => void }}
 */
export function createRunLog({ exampleId }) {
    const logDir = join(EXAMPLES_ROOT, '.logs', exampleId);
    const startedMs = Date.now();
    
    /** @type {string[]} */
        const chunks = [];
    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);
     /** @type {any} */
          (process.stdout).write = /** @type {(...args: any[]) => any} */ (( c,  e,  cb) => {
        chunks.push(typeof c === 'string' ? c : c.toString());
        return origStdout(c, e, cb);
    });
     /** @type {any} */
          (process.stderr).write = /** @type {(...args: any[]) => any} */ (( c,  e,  cb) => {
        chunks.push(typeof c === 'string' ? c : c.toString());
        return origStderr(c, e, cb);
    });
    let finished = false;
    let checksRan = 0;
    let checksPassed = 0;
    let checksFailed = 0;
    let checksSkipped = 0;
    const origCheck = log.check.bind(log);
    /** @type {any} */
    log.check = (/** @type {{name: string, passed: boolean, detail?: string}} */ arg) => {
        if (!finished) {
            checksRan += 1;
            if (arg?.passed) checksPassed += 1;
            else checksFailed += 1;
            if (typeof arg?.detail === 'string' && arg.detail.startsWith('SKIP')) checksSkipped += 1;
        }
        return origCheck(arg);
    };
    return {
        logDir,
        /** @param {{status?: *, error?: *}} arg0 */
        finish({ status = 'ok', error = null } = {}) {
            if (finished) return;
            finished = true;
             /** @type {any} */
                          (process.stdout).write = origStdout;
             /** @type {any} */
                          (process.stderr).write = origStderr;
            /** @type {any} */
            (log).check = origCheck;
            const endedMs = Date.now();
            const ts = new Date(startedMs).toISOString().replace(/[:.]/g, '-');
            const logPath = join(logDir, `${ts}.log`);
            const result = {
                schemaVersion: 1, example: exampleId,
                startedAt: new Date(startedMs).toISOString(), endedAt: new Date(endedMs).toISOString(),
                durationMs: endedMs - startedMs,
                environment: { node: process.version, platform: process.platform },
                status,
                error: error ? { name: error.name, message: String(error.message ?? error), code: error.code } : null,
                checks: checksRan,
                passed: checksPassed,
                failed: checksFailed,
                skipped: checksSkipped,
            };
            const machine = { example: exampleId, checks: checksRan, passed: checksPassed, failed: checksFailed, skipped: checksSkipped, errors: status === 'error' ? 1 : 0, log: logPath };
            let writeError =  (null);
            try {
                mkdirSync(logDir, { recursive: true });
                const text = stripAnsi({ s: `${chunks.join('')}\n${frame({ tag: '[AUDIT-RESULT]', body: JSON.stringify(machine) })}\n${frame({ tag: '[AUDIT-END]', body: `status=${status}` })}\n` });
                const json = JSON.stringify(result, null, 2);
                writeFileSync(logPath, text);
                writeFileSync(join(logDir, 'latest.log'), text);
                writeFileSync(join(logDir, `${ts}.json`), json);
                writeFileSync(join(logDir, 'latest.json'), json);
            } catch (err) {
                writeError =  (err);
            }
            origStdout(`${frame({ tag: '[AUDIT-RESULT]', body: JSON.stringify(machine) })}\n`);
            if (writeError) origStdout(`${frame({ tag: '[AUDIT-WARN]', body: `log not written: ${/** @type {any} */ (writeError).message}` })}\n`);
            else origStdout(`${frame({ tag: '[AUDIT-LOG]', body: logPath })}\n`);
            origStdout(`${frame({ tag: '[AUDIT-END]', body: `status=${status}` })}\n`);
        },
    };
}
