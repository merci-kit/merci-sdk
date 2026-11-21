// @ts-check
/**
 * @file Pretty console logger — the SDK's single logging vocabulary.
 * @version 0.12.0
 *
 * @description
 * One Logger class, human-readable and styled per data type. Backward-
 * compatible surface (header, step, info, success, warn, error, experiment,
 * assistant, user, thinking, toolCall, toolResult) plus the extended
 * vocabulary (flow, wire, usage, latency, option, condition, event, dump,
 * list, check, totals, phase, section, divider, spacer, indent, debug,
 * trace, style + named styles). `log` is the shared singleton.
 */




import { currentRunContext } from '../core/events.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { scrubSecrets } from './redact.mjs';


/** @type {Record<string, string>} */
const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
    underline: '\x1b[4m', strike: '\x1b[9m',
    black: '\x1b[30m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
    gray: '\x1b[90m', brightRed: '\x1b[91m', brightGreen: '\x1b[92m',
    brightYellow: '\x1b[93m', brightBlue: '\x1b[94m', brightMagenta: '\x1b[95m',
    brightCyan: '\x1b[96m', brightWhite: '\x1b[97m',
    bgBlack: '\x1b[40m', bgRed: '\x1b[41m', bgGreen: '\x1b[42m', bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m', bgMagenta: '\x1b[45m', bgCyan: '\x1b[46m', bgWhite: '\x1b[47m',
};


/**
 * Any value a log line may carry. The logger stringifies it (`_str`), so the
 * honest constraint is "a value": `Object|null|undefined` accepts primitives and
 * keeps call sites unconstrained without an `any` hole.
 * @typedef {Object|null|undefined} LogValue
 */

/**
 * The console-like sink `configure({sink})` accepts: each member takes the
 * already-rendered text.
 * @typedef {Object} LogSink
 * @property {(text: string) => void} log
 * @property {(text: string) => void} error
 * @property {(text: string) => void} write
 */

/** The request/response/retry metadata a `wire()` line reads.
 * @typedef {Object} WireMeta
 * @property {string} [method]
 * @property {string} [url]
 * @property {string} [model]
 * @property {Array<Object>} [messages]
 * @property {Array<Object>} [contents]
 * @property {Object} [params]
 * @property {Object} [config]
 * @property {string} [body]
 * @property {number} [status]
 * @property {boolean} [ok]
 * @property {number} [latencyMs]
 * @property {number} [durationMs]
 * @property {number} [attempt]
 * @property {number} [nextDelayMs]
 * @property {number} [delayMs]
 * @property {{message?: string}} [error]
 */

/** The token counts a `usage()` line reads.
 * @typedef {Object} UsageMeta
 * @property {number} [prompt_tokens]
 * @property {number} [completion_tokens]
 * @property {number} [total_tokens]
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [cache_read_input_tokens]
 */

/** A credit amount entry.
 * @typedef {Object} CreditAmount
 * @property {number} [amount]
 */

/** The nested state a `credits()` line reads.
 * @typedef {Object} CreditsMeta
 * @property {CreditAmount} [spent]
 * @property {{current?: CreditAmount, maximum?: CreditAmount, license?: string}} [updated]
 */

/** @type {Record<string, number>} */
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 99 };

/** Secret-bearing key fragments masked by `dump`/`_str` (normalized: lower-case, alnum-only; matched exact or as a suffix). */
const DEFAULT_REDACT = ['authorization', 'apikey', 'password', 'passwd', 'secret', 'token', 'privatekey', 'cookie', 'setcookie'];

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** @param {{text: string}} arg0 @returns {string} */
function stripAnsi({ text }) { return text.replace(ANSI_RE, ''); }

function colorEnabled() {
    return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}


/**
 * Pretty-printing console logger. Level-gated (info/success/debug/trace
 * respect `configure({level})`); warn/error always print. `extended` gates
 * the sdkLog/sdkWarn SDK-internal lines; `quiet` silences sdkError.
 *
 * `format` selects the output: `pretty` (default, byte-compatible), `json`
 * (one NDJSON record per line), `auto` (pretty on a TTY, json when piped).
 * JSON records and pretty lines optionally carry the ambient run correlation
 * (`runId`/`parentRunId`/`sessionId`) from `currentRunContext()`.
 */
export class Logger {
    constructor() {
        this._level = LEVELS.info;
        this._extended = false;
        this._quiet = false;
        this._timestamps = false;
        this._colors = colorEnabled();
        this._format = 'pretty';
        this._correlation = false;
        this._redact = DEFAULT_REDACT;
        this._fields = {};
        this._namespaces = null;
        this._sink = /** @type {LogSink} */ ({
            log: (t) => console.log(t),
            error: (t) => console.error(t),
            write: (t) => process.stdout.write(t),
        });
    }

    
    /**
 * Applies logging options. Chainable. `level`/`format` fall back to the
 * LOG_LEVEL / LOG_FORMAT environment variables when not passed explicitly.
 * @param {{level?: string, extended?: boolean, quiet?: boolean, timestamps?: boolean, colors?: boolean, sink?: LogSink, format?: string, correlation?: boolean, redact?: Array<string>, namespaces?: Array<string>|null, fields?: Object}} arg0
 * @returns {Logger}
 */
        configure({ level, extended, quiet, timestamps, colors, sink, format, correlation, redact, namespaces, fields } = {}) {
        const lvl = level ?? process.env.LOG_LEVEL;
        const fmt = format ?? process.env.LOG_FORMAT;
        if (lvl !== undefined) this._level = LEVELS[lvl] ?? this._level;
        if (extended !== undefined) this._extended = Boolean(extended);
        if (quiet !== undefined) this._quiet = Boolean(quiet);
        if (timestamps !== undefined) this._timestamps = Boolean(timestamps);
        if (colors !== undefined) this._colors = Boolean(colors);
        if (sink !== undefined) this._sink = sink;
        if (fmt !== undefined) this._format = fmt;
        if (correlation !== undefined) this._correlation = Boolean(correlation);
        if (redact !== undefined) this._redact = redact;
        if (namespaces !== undefined) this._namespaces = namespaces;
        // Ambient fields ride every JSON record, so they are redacted once here
        // instead of on each line — otherwise `context` bypasses the policy (W2E-7).
        if (fields !== undefined) this._fields = /** @type {Record<string, any>} */ (this._redactDeep({ value: { ...this._fields, ...fields } }));
        return this;
    }

    
    /** The current level name ('trace'|'debug'|'info'|'warn'|'error'|'silent'). @returns {string} */
        get level() { return Object.keys(LEVELS).find(k => LEVELS[k] === this._level) ?? 'info'; }
    
    /** Whether extended SDK-internal logging is enabled. @returns {boolean} */
        get extended() { return this._extended; }
    
    /** Whether sdkError is silenced. @returns {boolean} */
        get quiet() { return this._quiet; }

    /** The active output format ('pretty'|'json'|'text'|'auto'). @returns {string} */
        get format() { return this._format; }

    /**
 * Whether a message at `level` would be emitted at the current threshold.
 * @param {{level: string}} arg0
 * @returns {boolean}
 */
        isLevelEnabled({ level }) { return (LEVELS[level] ?? LEVELS.info) >= this._level; }

    
    /**
     * @param {{prefix: string, args?: Array<LogValue>}} arg0 -
     */
        sdkLog({ prefix, args = [] }) { if (!this._extended || !this._nsMatch({ prefix })) return; this._line({ kind: 'log', label: `[${prefix}]`, msg: args, fg: 'gray', level: 'debug' }); }
    
    /**
     * @param {{prefix: string, args?: Array<LogValue>}} arg0 -
     */
        sdkWarn({ prefix, args = [] }) { if (!this._extended || !this._nsMatch({ prefix })) return; this._line({ kind: 'log', label: `[${prefix}]`, msg: args, fg: 'yellow', level: 'warn' }); }
    
    /**
     * @param {{prefix: string, args?: Array<LogValue>}} arg0 -
     */
        sdkError({ prefix, args = [] }) { if (this._quiet || !this._nsMatch({ prefix })) return; this._line({ kind: 'error', label: `[${prefix}]`, msg: args, fg: 'red', level: 'error' }); }

    
    /**
     * @param {{text: LogValue, fg?: string, bg?: string, bold?: boolean, dim?: boolean, italic?: boolean, underline?: boolean, strike?: boolean}} arg0 -
     * @returns {string}
     */
        style({ text, fg, bg, bold, dim, italic, underline, strike }) {
        let out = String(text ?? '');
        if (!this._colors) return out;
        const codes = [];
        if (bold) codes.push(ANSI.bold);
        if (dim) codes.push(ANSI.dim);
        if (italic) codes.push(ANSI.italic);
        if (underline) codes.push(ANSI.underline);
        if (strike) codes.push(ANSI.strike);
        if (fg && ANSI[fg]) codes.push(ANSI[fg]);
        if (typeof bg === 'string' && ANSI['bg' + bg[0].toUpperCase() + bg.slice(1)]) codes.push(ANSI['bg' + bg[0].toUpperCase() + bg.slice(1)]);
        if (codes.length === 0) return out;
        return `${codes.join('')}${out}${ANSI.reset}`;
    }

    
    /** @param {{t: LogValue}} arg0 */
    black({ t }) { return this.style({ text: t, fg: 'black' }); }
    
    /** @param {{t: LogValue}} arg0 */
    red({ t }) { return this.style({ text: t, fg: 'red' }); }
    
    /** @param {{t: LogValue}} arg0 */
    green({ t }) { return this.style({ text: t, fg: 'green' }); }
    
    /** @param {{t: LogValue}} arg0 */
    yellow({ t }) { return this.style({ text: t, fg: 'yellow' }); }
    
    /** @param {{t: LogValue}} arg0 */
    blue({ t }) { return this.style({ text: t, fg: 'blue' }); }
    
    /** @param {{t: LogValue}} arg0 */
    magenta({ t }) { return this.style({ text: t, fg: 'magenta' }); }
    
    /** @param {{t: LogValue}} arg0 */
    cyan({ t }) { return this.style({ text: t, fg: 'cyan' }); }
    
    /** @param {{t: LogValue}} arg0 */
    gray({ t }) { return this.style({ text: t, fg: 'gray' }); }
    
    /** @param {{t: LogValue}} arg0 */
    white({ t }) { return this.style({ text: t, fg: 'white' }); }
    
    /** @param {{t: LogValue}} arg0 */
    bold({ t }) { return this.style({ text: t, bold: true }); }
    
    /** @param {{t: LogValue}} arg0 */
    dim({ t }) { return this.style({ text: t, dim: true }); }
    
    /** @param {{t: LogValue}} arg0 */
    italic({ t }) { return this.style({ text: t, italic: true }); }
    
    /** @param {{t: LogValue}} arg0 */
    underline({ t }) { return this.style({ text: t, underline: true }); }
    
    /** @param {{t: LogValue}} arg0 */
    strike({ t }) { return this.style({ text: t, strike: true }); }

    _ts() {
        if (!this._timestamps) return '';
        const d = new Date();
        /** @param {{n: number}} arg0 */
        const p = ({ n }) => String(n).padStart(2, '0');
        return this.gray({ t: `[${p({ n: d.getHours() })}:${p({ n: d.getMinutes() })}:${p({ n: d.getSeconds() })}] ` });
    }

    /**
 * The single output sink. Pretty prints (optionally prefixed with the ambient
 * run correlation); JSON/auto-piped mode emits one NDJSON record per call.
 * @param {{kind: string, text: string, level?: string, fields?: Object}} arg0
 */
    _out({ kind, text, level = 'info', fields }) {
        const sink = this._sink[kind === 'error' ? 'error' : 'log'];
        if (this._format === 'json' || (this._format === 'auto' && !process.stdout.isTTY)) {
            // Redact the structured fields with the same policy the text goes through: a
            // trace record must not print what the summary hid (B8).
            let body;
            try {
                body = JSON.stringify(this._record({ kind, text, level, fields: this._redactDeep({ value: fields }) }));
            } catch {
                // A circular or unserialisable field loses the fields, never the event.
                body = JSON.stringify(this._record({ kind, text, level, fields: { fieldsDropped: 'not serializable' } }));
            }
            sink(body);
            return;
        }
        const prefix = this._correlation ? this._corrPrefix() : '';
        // The pretty path renders through `style`/`_toolArg`, which do not all go
        // through `_str`: scrub the finished line so a styled value is covered too.
        sink(scrubSecrets({ text: this._ts() + prefix + text }));
    }

    /**
 * Builds one structured log record (NDJSON) with optional correlation.
 * @param {{kind: string, text: LogValue, level: string, fields?: LogValue}} arg0
 * @returns {Record<string, LogValue>}
 */
    _record({ kind, text, level, fields }) {
        /** @type {Record<string, any>} */
        const record = { ts: new Date().toISOString(), level, kind, text: scrubSecrets({ text: stripAnsi({ text: String(text) }) }) };
        if (Object.keys(this._fields).length) record.context = this._fields;
        const ctx = currentRunContext();
        if (ctx) {
            /** @type {Record<string, any>} */
            const correlation = {};
            if (ctx.runId) correlation.runId = ctx.runId;
            if (ctx.parentRunId) correlation.parentRunId = ctx.parentRunId;
            if (ctx.sessionId) correlation.sessionId = ctx.sessionId;
            if (Object.keys(correlation).length) record.correlation = correlation;
        }
        if (fields && typeof fields === 'object') Object.assign(record, fields);
        return record;
    }

    /** Dim `[runId8]` prefix for pretty correlation. @returns {string} */
    _corrPrefix() {
        const ctx = currentRunContext();
        if (!ctx?.runId) return '';
        return this.dim({ t: `[${String(ctx.runId).slice(0, LIMITS.log_run_id_chars)}] ` });
    }

    /** @param {{prefix: string}} arg0 @returns {boolean} */
    _nsMatch({ prefix }) {
        if (!this._namespaces || this._namespaces.length === 0) return true;
        const name = String(prefix).toLowerCase();
        return this._namespaces.some((ns) => {
            const re = new RegExp('^' + String(ns).toLowerCase().split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
            return re.test(name);
        });
    }

    /**
     * Redacts a structured field tree with the configured policy (keys only, as the
     * text path does), and drops what cannot be serialised.
     * @param {{value: LogValue, seen?: Set<LogValue>}} arg0
     * @returns {LogValue}
     */
    _redactDeep({ value, seen = new Set() }) {
        if (value === null || typeof value !== 'object') return value;
        if (seen.has(value)) return '[CIRCULAR]';
        seen.add(value);
        if (Array.isArray(value)) return value.map((item) => this._redactDeep({ value: item, seen }));
        /** @type {Record<string, any>} */
        const out = {};
        for (const [key, item] of Object.entries(/** @type {Record<string, any>} */ (value))) {
            const redacted = this._redactPair({ k: key, v: item });
            out[key] = redacted === '[REDACTED]' ? redacted : this._redactDeep({ value: redacted, seen });
        }
        seen.delete(value);
        return out;
    }

    /** @param {{k: string, v: LogValue}} arg0 @returns {LogValue} */
    _redactPair({ k, v }) {
        if (k && Array.isArray(this._redact) && this._redact.length) {
            const norm = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
            if (norm && this._redact.some((r) => { const t = String(r).toLowerCase().replace(/[^a-z0-9]/g, ''); return t !== '' && (norm === t || norm.endsWith(t)); })) return '[REDACTED]';
        }
        // A value can hide a secret under a key the denylist does not know: a JSON
        // string in `tool:call_start.args`, or a URL in an error message (G1-4).
        return typeof v === 'string' ? scrubSecrets({ text: v }) : v;
    }

    
    /**
      * @param {{kind: string, label: LogValue, msg: LogValue, fg?: string, weight?: string, italic?: boolean, level?: string}} arg0
     */
        _line({ kind, label, msg, fg = 'gray', weight, level = 'info' }) {
        const body = Array.isArray(msg) ? msg.map(m => this._str({ v: m })).join(' ') : this._str({ v: msg });
        const styled = label
            ? `${this.style({ text: label, fg, bold: weight === 'bold' })} ${body}`
            : body;
        this._out({ kind, text: styled, level });
    }

    /** @param {{v: LogValue}} arg0 */
    _str({ v }) {
        if (v === null || v === undefined) return String(v ?? '');
        if (typeof v === 'string') return scrubSecrets({ text: v });
        if (v instanceof Error) return v.stack || `${v.name || 'Error'}: ${v.message || ''}`;
        if (typeof v === 'object') return this.dump({ label: '', value: v, inline: true }) ?? String(v);
        return String(v);
    }

    
    /**
     * @param {{text: LogValue, n?: number}} arg0 -
     * @returns {string}
     */
        truncate({ text, n = LIMITS.log_truncate_chars }) {
        const str = String(text ?? '');
        if (str.length <= n) return str;
        return str.slice(0, n) + this.dim({ t: '…' });
    }

    
    /** @param {{t: LogValue}} arg0 */
    header({ t }) {
        this._out({ kind: 'log', text: `\n${this.style({ text: `  === ${String(t).toUpperCase()} ===`, fg: 'cyan', bold: true })}\n` });
    }

    
    /** @param {{t: LogValue}} arg0 */
    section({ t }) {
        this._out({ kind: 'log', text: `\n${this.style({ text: `  ── ${t} ──`, fg: 'cyan', bold: true })}` });
    }

    
    /** @param {{n: LogValue, d: LogValue}} arg0 */
    step({ n, d }) {
        this._out({ kind: 'log', text: this.style({ text: `[STEP ${n}] ${d}`, fg: 'blue', bold: true }) });
    }

    
    /** @param {{t: LogValue, sub: LogValue}} arg0 */
    phase({ t, sub }) {
        const s = sub ? ` ${this.gray({ t: `(${sub})` })}` : '';
        this._out({ kind: 'log', text: this.style({ text: `▶ ${t}`, fg: 'blue', bold: true }) + s });
    }

    
    /** @param {{t: LogValue}} arg0 */
    experiment({ t }) {
        this._out({ kind: 'log', text: `\n${this.style({ text: `--- Experiment: ${t} ---`, fg: 'magenta' })}` });
    }

    
    /** @param {{char?: string, n?: number}} arg0 */
    divider({ char = '─', n = LIMITS.log_divider_width } = {}) {
        this._out({ kind: 'log', text: this.gray({ t: char.repeat(Math.max(1, n)) }) });
    }

    
    /** Prints a blank line. */
        spacer() {
        this._out({ kind: 'log', text: '' });
    }

    
    /** @param {{text: LogValue, n?: number}} arg0 */
    indent({ text, n = LIMITS.log_indent_width }) {
        const pad = ' '.repeat(n);
        return String(text ?? '').split('\n').map(l => pad + l).join('\n');
    }

    
    /** @param {{m: LogValue}} arg0 */
    info({ m }) { if (this._level > LEVELS.info) return; this._line({ kind: 'log', label: this.style({ text: '[INFO]', fg: 'gray' }), msg: [m], fg: 'gray', level: 'info' }); }
    
    /** @param {{m: LogValue}} arg0 */
    success({ m }) { if (this._level > LEVELS.info) return; this._out({ kind: 'log', text: this.green({ t: m }), level: 'info' }); }
    
    /** @param {{m: LogValue}} arg0 */
    debug({ m }) { if (this._level > LEVELS.debug) return; this._line({ kind: 'log', label: this.style({ text: '[DEBUG]', fg: 'brightBlue' }), msg: [m], fg: 'brightBlue', level: 'debug' }); }
    
    /** @param {{m: LogValue}} arg0 */
    trace({ m }) { if (this._level > LEVELS.trace) return; this._line({ kind: 'log', label: this.style({ text: '[TRACE]', fg: 'gray', italic: true }), msg: [m], fg: 'gray', italic: true, level: 'trace' }); }
    
    /** @param {{m: LogValue}} arg0 */
    warn({ m }) { this._line({ kind: 'log', label: this.style({ text: '[WARNING]', fg: 'yellow', bold: true }), msg: [m], fg: 'yellow', level: 'warn' }); }
    
    /**
     * @param {{m: string, d?: LogValue}} arg0 -
     */
        error({ m, d }) {
        this._out({ kind: 'error', text: this.style({ text: `[ERROR] ${m}`, fg: 'red', bold: true }), level: 'error' });
        if (d !== undefined && d !== null) this._out({ kind: 'error', text: this.red({ t: this._str({ v: d }) }), level: 'error' });
    }
    
    /**
     * @param {{m: string, d?: LogValue}} arg0 -
     */
        fatal({ m, d }) {
        this._out({ kind: 'error', text: this.style({ text: `[FATAL] ${m}`, fg: 'red', bold: true, underline: true }), level: 'fatal' });
        if (d !== undefined && d !== null) this._out({ kind: 'error', text: this.red({ t: this._str({ v: d }) }), level: 'fatal' });
    }
    
    /** @param {{t: LogValue}} arg0 */
    thinking({ t }) { this._out({ kind: 'log', text: this.style({ text: t, dim: true, italic: true }) }); }
    
    /**
     * @param {{m: LogValue, isStreaming?: boolean}} arg0 -
     */
        assistant({ m, isStreaming }) {
        if (isStreaming) { this._sink.write(this.cyan({ t: 'Assistant > ' })); return; }
        this._out({ kind: 'log', text: `${this.cyan({ t: 'Assistant > ' })}${m}` });
    }
    
    /**
     * @param {{m: LogValue, returnOnly?: boolean}} arg0 -
     * @returns {string|undefined}
     */
        user({ m, returnOnly }) {
        const t = `${this.yellow({ t: 'User > ' })}${m}`;
        if (returnOnly) return t;
        this._out({ kind: 'log', text: t });
    }

    
    /** @param {{n: LogValue, a: LogValue}} arg0 */
    toolCall({ n, a }) {
        this._out({ kind: 'log', text: `${this.style({ text: n, fg: 'blue', bold: true })} ${this.gray({ t: this._toolArg({ a }) })}` });
    }
    
    /** @param {{n: LogValue, r: LogValue, full?: boolean}} arg0 */
    toolResult({ n, r, full = false }) {
        const body = this._toolArg({ a: r });
        const shown = (full || this._level <= LEVELS.debug) ? body : this.truncate({ text: body, n: LIMITS.log_tool_result_chars });
        this._out({ kind: 'log', text: `${this.green({ t: n })} ${this.gray({ t: shown })}` });
    }
    /** @param {{a: LogValue}} arg0 */
    _toolArg({ a }) {
        let text;
        if (typeof a === 'string') {
            text = a;
        } else {
            try { text = JSON.stringify(a, (k, v) => this._redactPair({ k, v })); } catch { text = String(a); }
        }
        // A tool arg is the caller's payload: scrub the finished string, including
        // the plain-string form that never meets the key denylist (W2E-4).
        return scrubSecrets({ text });
    }

    
    /**
     * @param {{from: string, to: string, what?: LogValue, why?: string}} arg0 -
     */
        flow({ from, to, what, why }) {
        let line = `${this.blue({ t: from })} ${this.cyan({ t: '→' })} ${this.blue({ t: to })}`;
        if (what) line += `: ${this.white({ t: what })}`;
        if (why) line += ` ${this.dim({ t: this.italic({ t: `(${why})` }) })}`;
        this._out({ kind: 'log', text: `${this.style({ text: '[FLOW]', fg: 'cyan', bold: true })} ${line}` });
    }

    
    /**
     * @param {{kind: string, meta: WireMeta, full?: boolean}} arg0 - 'request'|'response'|'retry'.
     */
        wire({ kind, meta, full = false }) {
        const m = meta ?? {};
        const showFull = full || this._level <= LEVELS.trace;
        if (kind === 'request') {
            const parts = [];
            if (m.method) parts.push(this.bold({ t: m.method }));
            if (m.url) parts.push(this.gray({ t: m.url }));
            if (m.model) parts.push(this.cyan({ t: m.model }));
            if (Array.isArray(m.messages)) parts.push(this.gray({ t: `msgs=${m.messages.length}` }));
            if (Array.isArray(m.contents)) parts.push(this.gray({ t: `contents=${m.contents.length}` }));
            if (m.params && typeof m.params === 'object') { const k = Object.keys(m.params); parts.push(this.gray({ t: `params=${k.length ? k.join(',') : '—'}` })); }
            if (m.config && typeof m.config === 'object') { const k = Object.keys(m.config); parts.push(this.gray({ t: `config=${k.length ? k.join(',') : '—'}` })); }
            if (typeof m.body === 'string') parts.push(this.gray({ t: `body=${m.body.length}b` }));
            this._out({ kind: 'log', text: `${this.style({ text: '→', fg: 'blue', bold: true })} ${parts.join(' ')}` });
            if (showFull) {
                if (Array.isArray(m.messages) && m.messages.length) this.dump({ label: 'request.messages', value: m.messages });
                if (Array.isArray(m.contents) && m.contents.length) this.dump({ label: 'request.contents', value: m.contents });
                if (m.params && typeof m.params === 'object') this.dump({ label: 'request.params', value: m.params });
                if (m.config && typeof m.config === 'object') this.dump({ label: 'request.config', value: m.config });
                if (typeof m.body === 'string') {
                    let parsed; try { parsed = JSON.parse(m.body); } catch { parsed = m.body; }
                    this.dump({ label: 'request.body', value: parsed });
                }
            }
        } else if (kind === 'response') {
            const ms = m.latencyMs ?? m.durationMs;
            const parts = [this.style({ text: String(m.status ?? '?'), ...m.ok === false ? { fg: 'red', bold: true } : { fg: 'green', bold: true } })];
            if (m.url) parts.push(this.gray({ t: m.url }));
            if (ms !== undefined) parts.push(this.dim({ t: `(${this._ms({ ms })})` }));
            this._out({ kind: 'log', text: `${this.style({ text: '←', fg: 'green', bold: true })} ${parts.join(' ')}` });
        } else if (kind === 'retry') {
            const parts = [this.style({ text: `attempt=${m.attempt}`, fg: 'yellow', bold: true })];
            const delay = m.nextDelayMs ?? m.delayMs;
            if (delay !== undefined) parts.push(this.dim({ t: `in ${delay}ms` }));
            if (m.error?.message) parts.push(this.gray({ t: m.error.message }));
            this._out({ kind: 'log', text: `${this.style({ text: '↻', fg: 'yellow', bold: true })} ${parts.join(' ')}` });
        }
    }

    
    /** @param {{u: UsageMeta|null}} arg0 */
    usage({ u }) {
        if (!u) return;
        const parts = [];
        if (u.prompt_tokens != null) parts.push(`prompt=${u.prompt_tokens}`);
        if (u.completion_tokens != null) parts.push(`completion=${u.completion_tokens}`);
        if (u.total_tokens != null) parts.push(this.bold({ t: `total=${u.total_tokens}` }));
        if (u.cache_creation_input_tokens != null) parts.push(`cache_write=${u.cache_creation_input_tokens}`);
        if (u.cache_read_input_tokens != null) parts.push(`cache_read=${u.cache_read_input_tokens}`);
        if (parts.length === 0) return;
        this._out({ kind: 'log', text: `${this.style({ text: '[TOKENS]', fg: 'brightMagenta' })} ${this.gray({ t: parts.join(' · ') })}` });
    }

    
    /** @param {{u: CreditsMeta|null}} arg0 */
    credits({ u }) {
        if (!u) return;
        const parts = [];
        if (u.spent?.amount != null) parts.push(`spent=${u.spent.amount}`);
        if (u.updated?.current?.amount != null) parts.push(`current=${u.updated.current.amount}`);
        if (u.updated?.maximum?.amount != null) parts.push(`maximum=${u.updated.maximum.amount}`);
        if (u.updated?.license) parts.push(`license=${u.updated.license}`);
        if (parts.length === 0) return;
        this._out({ kind: 'log', text: `${this.style({ text: '[CREDITS]', fg: 'brightCyan' })} ${this.gray({ t: parts.join(' · ') })}` });
    }

    
    /**
     * @param {{ms?: number, label?: string}} arg0 -
     * @returns {string}
     */
        latency({ ms, label = 'took' }) {
        return this.dim({ t: `(${label} ${this._ms({ ms })})` });
    }
    /** @param {{ms: number|undefined}} arg0 */
    _ms({ ms }) {
        if (ms == null) return '?';
        return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
    }

    
    /**
     * @param {{name: string, value: LogValue, source?: string}} arg0 -
     */
        option({ name, value, source }) {
        const v = this.yellow({ t: String(value) });
        const src = source ? ` ${this.dim({ t: `(${source})` })}` : '';
        this._out({ kind: 'log', text: `${this.style({ text: '[OPTION]', fg: 'cyan', bold: true })} ${name}=${v}${src}` });
    }

    
    /**
     * @param {{label: string, branch: LogValue, why?: string}} arg0 -
     */
        condition({ label, branch, why }) {
        const w = why ? ` ${this.dim({ t: this.italic({ t: `— ${why}` }) })}` : '';
        this._out({ kind: 'log', text: `${this.style({ text: '[COND]', fg: 'magenta', bold: true })} ${label} ${this.cyan({ t: '→' })} ${this.white({ t: branch })}${w}` });
    }

    
    /**
     * @param {{type: LogValue, payload?: LogValue, detail?: LogValue, fields?: Record<string, LogValue>}} arg0 -
     *   `fields` ride the structured NDJSON record; `payload`/`detail` are the human line.
     */
        event({ type, payload, detail, fields }) {
        let line = `${this.style({ text: String(type), fg: 'brightBlue', bold: true })}`;
        if (payload) line += ` ${this.gray({ t: this._toolArg({ a: payload }) })}`;
        if (detail) line += ` ${this.dim({ t: this._toolArg({ a: detail }) })}`;
        // `fields` ride the structured NDJSON record (B8): the JSON sink is a ledger, so a
        // caller that has the data must be able to put it on the record, not only in text.
        this._out({ kind: 'log', text: `${this.style({ text: '•', fg: 'brightBlue' })} ${line}`, fields });
    }

    
    /**
     * string instead of printing.
     * @param {{label: string, value: LogValue, inline?: boolean}} arg0 -
     * @returns {string|undefined}
     */
        dump({ label, value, inline = false }) {
        let body;
        try {
            body = JSON.stringify(value, (k, v) => {
                const redacted = this._redactPair({ k, v });
                if (redacted instanceof Error) {
                    return {
                        ...(/** @type {Record<string, any>} */ (redacted)),
                        name: redacted.name,
                        message: redacted.message,
                        ...(redacted.stack ? { stack: redacted.stack } : {})
                    };
                }
                return redacted;
            }, 2);
        } catch {
            body = undefined;
        }
        if (body === undefined) body = String(value ?? '');
        if (inline) return body;
        const title = label ? ` ${label} ` : ' ';
        const width = Math.min(LIMITS.log_box_width, Math.max(title.length + 2, LIMITS.log_box_min_width));
        const out = [];
        out.push(this.gray({ t: `┌─${title.padEnd(width, '─')}─┐` }));
        for (const l of body.split('\n')) out.push(this.gray({ t: `│ ${l}` }));
        out.push(this.gray({ t: `└${'─'.repeat(width + 3)}┘` }));
        this._out({ kind: 'log', text: out.join('\n') });
    }

    
    /**
     * @param {{title: string, items: LogValue, bullet?: string, color?: string}} arg0 -
     */
        list({ title, items, bullet = '•', color = 'cyan' }) {
        const arr = Array.isArray(items) ? items : (items == null ? [] : [items]);
        this._out({ kind: 'log', text: `${this.style({ text: `[LIST]`, fg: color, bold: true })} ${title} ${this.gray({ t: `(${arr.length})` })}` });
        for (const it of arr) {
            this._out({ kind: 'log', text: `${this.dim({ t: '  ' })}${this.style({ text: bullet, fg: color })} ${this.gray({ t: this._str({ v: it }) })}` });
        }
    }

    
    /**
     * @param {{name: string, passed: boolean, detail?: string}} arg0 -
     */
        check({ name, passed, detail }) {
        if (passed) this._out({ kind: 'log', text: `${this.green({ t: '✓' })} ${this.bold({ t: name })}${detail ? ` ${this.gray({ t: '— ' + detail })}` : ''}` });
        else this._out({ kind: 'log', text: `${this.red({ t: '✗' })} ${this.bold({ t: name })}${detail ? ` ${this.red({ t: '— ' + detail })}` : ''}` });
    }

    
    /**
     * @param {{entries: Object, label?: string}} arg0 -
     */
        totals({ entries, label = 'TOTALS' }) {
        const pairs = Object.entries(entries ?? {});
        if (pairs.length === 0) return;
        const width = Math.max(...pairs.map(([k]) => k.length));
        this._out({ kind: 'log', text: this.style({ text: `  ${label}`, fg: 'cyan', bold: true }) });
        for (const [k, v] of pairs) {
            this._out({ kind: 'log', text: `  ${this.gray({ t: k.padEnd(width) })} ${this.bold({ t: String(v) })}` });
        }
    }

    /**
 * Starts a labeled timer; `done()` logs the elapsed time and returns the ms.
 * @param {{label?: string}} arg0
 * @returns {{done: (arg0?: {level?: string, fields?: Object}) => number}}
 */
    timer({ label = 'timer' } = {}) {
        const start = Date.now();
        return {
            done: ({ level = 'info', fields } = {}) => {
                const durationMs = Date.now() - start;
                this._out({ kind: 'log', level, text: `${this.style({ text: '[TIMER]', fg: 'gray' })} ${label} ${this.dim({ t: this._ms({ ms: durationMs }) })}`, fields: { label, durationMs, ...(fields ?? {}) } });
                return durationMs;
            },
        };
    }

    /**
 * Returns a scoped logger sharing this one's config, with `fields` bound onto
 * every record (`context` in JSON): `log.child({ module: 'TOOLS' })`.
 * @param {Record<string, LogValue>} arg0
 * @returns {Logger}
 */
    child({ ...fields } = {}) {
        const c = new Logger();
        c._level = this._level; c._extended = this._extended; c._quiet = this._quiet;
        c._timestamps = this._timestamps; c._colors = this._colors; c._format = this._format;
        c._correlation = this._correlation; c._redact = this._redact;
        c._namespaces = this._namespaces; c._sink = this._sink;
        c._fields = /** @type {Record<string, any>} */ (this._redactDeep({ value: { ...this._fields, ...fields } }));
        return c;
    }
}


/** The shared logger singleton. */
export const log = new Logger();
