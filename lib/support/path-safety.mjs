// @ts-check


/**
 * @file Path containment shared by every boundary that accepts a path.
 * @version 0.12.0
 *
 * @description
 * One answer to "is this path inside that root?" keeps the workspace guard,
 * the context tools, the artifact tool, and document ingestion from drifting
 * apart. A bare string prefix would accept `/root2` for the root `/root`, so
 * the separator is part of the test; both sides are resolved, so `.` and `..`
 * segments and a trailing separator cannot change the answer.
 */
import { resolve, sep } from 'node:path';

/**
 * True when `path` is `root` itself or sits below it.
 *
 * A bare string prefix would accept `/root2` for the root `/root`; the
 * separator is part of the test. Both sides are resolved, so `.` and `..`
 * segments and a trailing separator cannot change the answer.
 *
 * @param {{root: string, path: string}} arg0 -
 * @returns {boolean}
 */
export function isInsideRoot({ root, path }) {
    const base = resolve(root);
    const target = resolve(path);
    // The filesystem root is its own prefix; appending a separator would make it `//`.
    const prefix = base === sep || base.endsWith(sep) ? base : base + sep;
    return target === base || target.startsWith(prefix);
}
