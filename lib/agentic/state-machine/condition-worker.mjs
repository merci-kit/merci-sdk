// @ts-check
/**
 * @file Child-process evaluator for planner-authored string conditions.
 * @version 0.13.0
 *
 * @description
 * Spawned by `condition-evaluator.mjs` with `--max-old-space-size` and kept
 * alive for the life of the host. Each request is one JSON line on stdin
 * (`{ src, payloadJson, timeoutMs, maxMessageChars }`); each response is
 * exactly one JSON line on stdout: `{ kind: 0|1, heapUsed }` for false/true,
 * `{ kind: 3, heapUsed }` for a thenable, `{ kind: 2, message, heapUsed }` for
 * an evaluation error. `heapUsed` is `process.memoryUsage().heapUsed` after the
 * evaluation, so the host can recycle a child whose heap a condition filled.
 *
 * `--once` keeps the original one-shot contract for the `spawnSync` fallback:
 * read stdin to EOF, write one frame, exit.
 *
 * An OOM here is fatal to V8 and calls abort(), so it must happen in this
 * child and never in the host (D-8). A condition that allocates close to the
 * cap can leave the shared heap fragmented, so the caller's next condition may
 * OOM sooner than it would in a fresh child; it is still typed and contained.
 */

import { runConditionInVm, CONDITION_THENABLE } from './condition-vm.mjs';

/**
 * The frame is one stdout line; a pathological message must not exceed it.
 * @param {{err: unknown, maxChars: number}} arg0
 * @returns {string}
 */
function messageFor({ err, maxChars }) {
  const e = /** @type {any} */ (err);
  return String(e?.message ?? e).slice(0, maxChars);
}

/**
 * Evaluates one request line and returns one response frame (no newline).
 * @param {{line: string}} arg0
 * @returns {string}
 */
function evaluateLine({ line }) {
  /** @type {number} */
  let reqMaxChars = Number.MAX_SAFE_INTEGER;
  /** @type {{kind: number, message?: string, heapUsed: number}} */
  let result;
  try {
    const req = JSON.parse(line);
    reqMaxChars = Number(req.maxMessageChars) > 0 ? Number(req.maxMessageChars) : Number.MAX_SAFE_INTEGER;
    const out = runConditionInVm({
      src: String(req.src),
      payloadJson: String(req.payloadJson),
      timeoutMs: Number(req.timeoutMs),
    });
    result = { kind: out ? 1 : 0, heapUsed: 0 };
  } catch (err) {
    const e = /** @type {any} */ (err);
    result = { kind: e?.code === CONDITION_THENABLE ? 3 : 2, message: messageFor({ err, maxChars: Number(reqMaxChars) }), heapUsed: 0 };
  }
  // Read after the condition so the number reflects what it left behind.
  result.heapUsed = process.memoryUsage().heapUsed;
  return JSON.stringify(result);
}

if (process.argv.includes('--once')) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(evaluateLine({ line: input }));
} else {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      process.stdout.write(`${evaluateLine({ line })}\n`);
    }
  });
  // The host is the only writer; EOF means it is gone.
  process.stdin.on('end', () => process.exit(0));
}
