// Regenerates the EXPECTED wire-parity fixture in
// test/unified-parameter-wire-parity.test.mjs FROM the running implementation.
//
// The fixture is a captured snapshot of the parameter builder's behaviour. When
// a wave deliberately changes that behaviour (wave 2 makes prompt caching real),
// the fixture has to be re-captured — and the diff has to be reviewed, not
// assumed. This script prints exactly which (case, backend) pairs changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { ProviderType, StandardType } from '../lib/core/constants/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import {
    UnifiedParameterBuilder,
    buildParameterMapForOai,
    buildParameterMapForAai,
    buildParameterMapForGai,
    buildParameterMapForJai
} from '../lib/messaging/unified-parameter.mjs';

const TEST_FILE = new URL('../test/unified-parameter-wire-parity.test.mjs', import.meta.url);
const source = readFileSync(TEST_FILE, 'utf8');

// ── extract the CASES table (the executable part of the fixture) ──────────────
const casesStart = source.indexOf('export const CASES = [');
const casesEnd = source.indexOf('\n];', casesStart) + 3;
const casesSource = source.slice(casesStart, casesEnd);
const SMALL_SCHEMA = { type: 'object', properties: { a: { type: 'string' } } };
const { z } = await import('zod');
const CASES = new Function('SMALL_SCHEMA', 'z', `return ${casesSource.replace('export const CASES =', '')};`)(SMALL_SCHEMA, z);

const STANDARDS = [StandardType.OAI, StandardType.AAI, StandardType.GAI, StandardType.JAI];
const PROVIDER_FOR_STANDARD = {
    [StandardType.OAI]: ProviderType.OPENAI,
    [StandardType.AAI]: ProviderType.ANTHROPIC,
    [StandardType.GAI]: ProviderType.GOOGLE_GENAI,
    [StandardType.JAI]: ProviderType.JAI,
};

function executeCase({ id, standard }) {
    const entry = CASES.find(([cid]) => cid === id);
    const emitter = new EventEmitter();
    const warnings = [];
    emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (e) => {
        const { ts, ...rest } = e;
        warnings.push(rest);
    });
    const b = new UnifiedParameterBuilder({ model: 'test-model', eventEmitter: emitter, provider: PROVIDER_FOR_STANDARD[standard], standard });
    entry[1](b);
    const spec = b._build();
    return {
        wire: JSON.stringify(spec),
        warnings,
        maps: {
            oai: JSON.stringify(buildParameterMapForOai({ spec })),
            aai: JSON.stringify(buildParameterMapForAai({ spec })),
            gai: JSON.stringify(buildParameterMapForGai({ spec })),
            jai: JSON.stringify(buildParameterMapForJai({ spec }))
        }
    };
}

// ── extract the EXPECTED block ───────────────────────────────────────────────
const expectedStart = source.indexOf('const EXPECTED = {');
const blockStart = source.indexOf('{', expectedStart);
let depth = 0;
let blockEnd = -1;
for (let i = blockStart; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { blockEnd = i + 1; break; }
    }
}
const expected = JSON.parse(source.slice(blockStart, blockEnd));

// Fixture keys move from provider ids to StandardType values.
const STANDARD_FOR_PROVIDER = {
    [ProviderType.OPENAI]: StandardType.OAI,
    [ProviderType.ANTHROPIC]: StandardType.AAI,
    [ProviderType.GOOGLE_GENAI]: StandardType.GAI,
    [ProviderType.JAI]: StandardType.JAI,
};
for (const id of Object.keys(expected)) {
    const migrated = {};
    for (const [key, entry] of Object.entries(expected[id])) {
        migrated[STANDARD_FOR_PROVIDER[key] ?? key] = entry;
    }
    expected[id] = migrated;
}

// ── re-capture ───────────────────────────────────────────────────────────────
const changed = [];
for (const [id] of CASES) {
    for (const standard of STANDARDS) {
        const actual = executeCase({ id, standard });
        const before = expected[id]?.[standard];
        if (!before) continue;
        const differs = before.wire !== actual.wire
            || JSON.stringify(before.warnings) !== JSON.stringify(actual.warnings)
            || Object.keys(actual.maps).some((k) => before.maps[k] !== actual.maps[k]);
        if (!differs) continue;
        changed.push({ id, standard, before, actual });
        expected[id][standard] = actual;
    }
}

console.log(`changed entries: ${changed.length}`);
for (const { id, standard } of changed) {
    console.log(`  - ${id} × ${standard}`);
}

// ── write back only when the diff is the standard-keying one ─────────────────
const warningsOnlyMoved = ({ before, actual, standard }) =>
    before.warnings.length === actual.warnings.length
    && before.warnings.every((w, i) => {
        const n = actual.warnings[i];
        const expectedMessage = w.message.replace(/ (openai|anthropic|google_genai|jai) backend\.$/, ` ${standard} standard.`);
        return w.model === n.model
            && w.parameter === n.parameter
            && w.provider === n.provider
            && n.standard === standard
            && n.message === expectedMessage;
    });
const unexpected = changed.filter((entry) =>
    entry.before.wire !== entry.actual.wire
    || Object.keys(entry.actual.maps).some((k) => entry.before.maps[k] !== entry.actual.maps[k])
    || !warningsOnlyMoved(entry));
if (unexpected.length) {
    console.error('UNEXPECTED changes — refusing to rewrite the fixture:');
    for (const { id, standard } of unexpected) console.error(`  - ${id} × ${standard}`);
    process.exit(1);
}

const rendered = JSON.stringify(expected, null, 2);
const updated = source.slice(0, blockStart) + rendered + source.slice(blockEnd);
writeFileSync(TEST_FILE, updated);
console.log('fixture re-captured');
