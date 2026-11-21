// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'check-guidelines.mjs');

/** @type {{ violations: Array<{rule:string,file:string,line:number,symbol:string}> }} */
let report = { violations: [] };
try {
    report = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' }));
} catch (error) {
    const out = /** @type {{ stdout?: string }} */ (error).stdout || '{}';
    report = JSON.parse(out);
}

/** @param {{rule: string}} arg0 @returns {Array<{file:string,line:number,symbol:string}>} */
/** @param {{rule: *}} arg0 */
const byRule = ({ rule }) => (report.violations || []).filter((v) => v.rule === rule);
/** @param {{list: Array<{file:string,line:number,symbol:string}>}} arg0 @returns {string} */
/** @param {{list: *}} arg0 */
const render = ({ list }) => list.slice(0, 15).map(/** @type {(...args: any[]) => any} */ ((v) => `${v.file}:${v.line} ${v.symbol}`)).join('\n');

describe('GUIDELINES.md conformance gate (lib/**)', () => {
    it('R1: every named multi-arg callable takes a single destructured object', () => {
        const r1 = byRule({ rule: 'R1' });
        assert.equal(r1.length, 0, `R1 violations: ${r1.length}\n${render({ list: r1 })}`);
    });

    it('R2: exported builders are fluent and expose a terminal method', () => {
        const r2 = byRule({ rule: 'R2' });
        assert.equal(r2.length, 0, `R2 violations: ${r2.length}\n${render({ list: r2 })}`);
    });

    it('R3: emit names come from the EVENTS registry (no bare literals)', () => {
        const r3 = byRule({ rule: 'R3' });
        assert.equal(r3.length, 0, `R3 violations: ${r3.length}\n${render({ list: r3 })}`);
    });

    it('R4: no forbidden cross-area import edges', () => {
        const r4 = byRule({ rule: 'R4' });
        assert.equal(r4.length, 0, `R4 violations: ${r4.length}\n${render({ list: r4 })}`);
    });
});
