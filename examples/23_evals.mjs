// @ts-check
/**
 * Example 23 — Evals: ship a prompt only if it scores.
 *
 * The suite runs live, is recorded as it runs, and is replayed immediately
 * afterwards on a client whose key cannot possibly work — so a replay that
 * scored the same proves the recording answered it, not the vendor. Then the
 * failure that a score hides is classified, and a judge grades what a regex
 * cannot.
 *
 *   A — record and score : `runEvals` gives each case a fresh session wrapped
 *       in `withCassette({ mode: 'record' })`; every `EVAL_SCORERS` verdict and
 *       the pass rate come from the real run, whose requests land on one file.
 *   B — replay           : a fresh cassette on the same file, `mode: 'replay'`,
 *       on a client with an invalid key. Same verdicts, same pass rate, no
 *       vendor call it could have made.
 *   C — the failure taxonomy: the failing case is not just "red". Its
 *       `failureFingerprint` keys a `RetryLedger`, `classifyFailure` names what
 *       broke, `claimReplan` counts the replan budget, and
 *       `stateFingerprint`/`compareProgress` say whether a retry moved.
 *   D — the judged gate : `createLlmJudge` and `createScoredJudge` grade the
 *       recorded answers through `EVAL_SCORERS.judge`, and the ship decision
 *       requires both the deterministic rate and the judge.
 *
 * Public API: `runEvals`, `EVAL_SCORERS`, `createCassette`, `withCassette`,
 * `FailureClass`, `failureFingerprint`, `RetryLedger`, `classifyFailure`,
 * `claimReplan`, `stateFingerprint`, `compareProgress`, `createLlmJudge`,
 * `createScoredJudge`.
 *
 * Run: `node examples/23_evals.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
    EVAL_SCORERS, FailureClass, RetryLedger, claimReplan, classifyFailure, compareProgress, createCassette, createLlmJudge,
    createScoredJudge, failureFingerprint, initializeClient, loadCredentials, log, runEvals, stateFingerprint,
} from 'merci-sdk';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';
import { reportUsage, resolveExample, runMain, trackUsage, wireClient } from './_shared/example-utils.mjs';

const CASSETTE = join(SCRATCH_DIR, '23-evals', 'suite.cassette.json');

/** The token the passing cases must return; the failing case expects a different one. */
const TOKEN = 'EVAL-SHIP-23';
const WRONG_TOKEN = 'EVAL-SHIP-00';

/** The system prompt under test — the thing this example is deciding to ship. */
const PROMPT = `You are a release gate. When asked for a token, reply with exactly that token and nothing else.`;

/**
 * The suite: two cases that match their expectation and one that does not, so
 * the pass rate is a decision rather than a formality.
 * @type {Array<{name: string, input: string, expected: Record<string, any>}>}
 */
const CASES = [
    { name: 'marker', input: `Reply with exactly ${TOKEN} and nothing else.`, expected: { output: new RegExp(TOKEN) } },
    { name: 'marker-repeated', input: `Say ${TOKEN} twice, separated by a space.`, expected: { output: new RegExp(TOKEN) } },
    { name: 'wrong-expectation', input: `Reply with exactly ${TOKEN}, with no punctuation at all.`, expected: { output: new RegExp(WRONG_TOKEN), maxTotalTokens: 10_000 } },
];

/** The deterministic scorers every case is graded by. */
const SCORERS = [EVAL_SCORERS.outputMatches()];

const verdictLine = (/** @type {any} */ r) => `${r.name}: ${r.passed ? 'pass' : 'FAIL'} · ${r.verdicts.filter((/** @type {any} */ v) => !v.skipped).map((/** @type {any} */ v) => `${v.name}=${v.passed}`).join(' ')}`;

/** The comparable shape of a suite run: name, pass, and per-scorer verdicts. */
const verdictsOf = (/** @type {any[]} */ results) => JSON.stringify(results.map((r) => [r.name, r.passed, r.verdicts.map((/** @type {any} */ v) => [v.name, v.passed])]));

async function main() {
    const { provider, defaultModel, toolModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });
    let apiCalls = 0;
    client.on('api_request', () => { apiCalls += 1; });
    await mkdir(join(SCRATCH_DIR, '23-evals'), { recursive: true });

    log.header({ t: `Example 23 — Evals (${provider})` });
    log.option({ name: 'cassette', value: CASSETTE, source: "withCassette({ cassette: createCassette({ path }), mode })" });
    log.option({ name: 'prompt under test', value: PROMPT, source: 'the session system message every case runs' });
    log.option({ name: 'cases', value: CASES.map((c) => c.name).join(', '), source: 'runEvals({ cases })' });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // The replay client's key cannot authenticate: a live call could never pass
    // for a replay, so section B's identical score is the recording's answer.
    const { client: replayClient } = await initializeClient({ provider, options: { ...loadCredentials({ provider }), apiKey: 'replay-only-invalid-key' } });

    // ── A: record the live suite ─────────────────────────────────────────────
    log.section({ t: 'A — the suite runs live and is recorded while it runs' });
    const before = apiCalls;
    /** @param {{cassette: any, mode: 'record'|'replay', onClient?: any}} arg0 */
    const sessionsOn = ({ cassette, mode, onClient = client }) => () => onClient.session(toolModel)
        .withSystemMessage(PROMPT)
        .withCassette({ cassette, mode });
    const recording = createCassette({ path: CASSETTE });
    const recorded = await runEvals({ cases: CASES, scorers: SCORERS, makeSession: sessionsOn({ cassette: recording, mode: 'record' }) });
    const recordedCalls = apiCalls - before;
    const recordedKeys = await createCassette({ path: CASSETTE }).size();
    const [passCase, secondPass, failed] = recorded.results;
    const stored = JSON.parse(await readFile(CASSETTE, 'utf8'));
    log.list({ title: 'recorded verdicts', items: recorded.results.map(verdictLine) });
    check({
        name: 'A: two cases pass, the mismatched expectation fails',
        ok: recorded.results.map((r) => r.passed).join(',') === 'true,true,false' && Math.abs(recorded.passRate - 2 / 3) < 1e-9,
        detail: `${recorded.results.map((r) => r.passed).join(',')} · passRate=${recorded.passRate}`,
    });
    check({ name: 'A: the live run made real vendor calls', ok: recordedCalls >= CASES.length, detail: `${recordedCalls} api_request for ${CASES.length} cases` });
    check({ name: 'A: every request was written to the cassette file', ok: recordedKeys >= CASES.length, detail: `${recordedKeys} recording(s) at ${CASSETTE}` });
    check({
        name: 'A: the cassette is a real, readable file',
        ok: typeof stored?.entries === 'object' && Object.keys(stored.entries).length === recordedKeys,
        detail: `version=${stored?.version} entries=${Object.keys(stored?.entries ?? {}).length}`,
    });
    check({
        name: 'A: the failing case carries the evidence, not just a colour',
        ok: /expected/.test(String(failed.verdicts[0]?.evidence)) && String(failed.observation.output ?? '').includes(TOKEN),
        detail: log.truncate({ text: String(failed.verdicts[0]?.evidence), n: 110 }),
    });
    check({
        name: 'A: each case was observed — tokens, latency and tool calls',
        ok: recorded.results.every((r) => (r.observation.usage?.total_tokens ?? 0) > 0 && r.observation.durationMs > 0)
            && recorded.results.every((r) => Array.isArray(r.observation.toolCalls) && r.observation.toolCalls.length === 0),
        detail: recorded.results.map((r) => `${r.name}:${r.observation.usage?.total_tokens ?? 0}tok/${r.observation.durationMs}ms`).join(' '),
    });
    const silentSuite = await runEvals({
        cases: [CASES[0]],
        scorers: [EVAL_SCORERS.outputSchema(), EVAL_SCORERS.toolsCalled(), EVAL_SCORERS.withinBudget()],
        makeSession: sessionsOn({ cassette: createCassette({ path: CASSETTE }), mode: 'replay', onClient: replayClient }),
    });
    const silentVerdicts = silentSuite.results[0]?.verdicts ?? [];
    check({
        name: 'A: a scorer with no expectation in the case is skipped, not failed',
        ok: silentSuite.results[0]?.passed === true && silentVerdicts.length === 3 && silentVerdicts.every((v) => v.skipped === true),
        detail: silentVerdicts.map((v) => `${v.name}:skipped=${v.skipped}`).join(' '),
    });

    // ── B: replay on a client that cannot work ───────────────────────────────
    log.section({ t: 'B — replay immediately, on an invalid key' });
    const replayBefore = apiCalls;
    const replayed = await runEvals({ cases: CASES, scorers: SCORERS, makeSession: sessionsOn({ cassette: createCassette({ path: CASSETTE }), mode: 'replay', onClient: replayClient }) });
    log.list({ title: 'replayed verdicts', items: replayed.results.map(verdictLine) });
    check({
        name: 'B: the replay gives the same verdicts and pass rate',
        ok: verdictsOf(replayed.results) === verdictsOf(recorded.results) && replayed.passRate === recorded.passRate,
        detail: `identical=${verdictsOf(replayed.results) === verdictsOf(recorded.results)} passRate=${replayed.passRate}`,
    });
    check({
        name: 'B: the invalid-key client answered every case from the cassette',
        ok: replayed.results.every((r) => r.observation.failureClass === null) && replayed.results.map((r) => r.passed).join(',') === 'true,true,false',
        detail: `classes=${replayed.results.map((r) => r.observation.failureClass ?? 'none').join(',')} api_request on the origin client=${apiCalls - replayBefore}`,
    });
    const unrecorded = await runEvals({
        cases: [{ name: 'never-recorded', input: 'A prompt the cassette has never seen.', expected: { output: new RegExp(TOKEN) } }],
        scorers: SCORERS,
        makeSession: sessionsOn({ cassette: createCassette({ path: CASSETTE }), mode: 'replay', onClient: replayClient }),
    });
    const missed = unrecorded.results[0];
    check({
        name: 'B: a case with no recording fails as the environment, not as the model',
        ok: missed?.passed === false && missed?.observation.output === null
            && /no recording/.test(String(missed?.observation.error?.message))
            && missed?.observation.failureClass === FailureClass.ENVIRONMENT_MISMATCH,
        detail: `${String(missed?.observation.error?.message).slice(0, 70)} · class=${missed?.observation.failureClass}`,
    });

    // ── C: what the red row actually is ──────────────────────────────────────
    log.section({ t: 'C — the failure taxonomy behind one red row' });
    const fingerprint = failureFingerprint({ action: 'outputMatches', input: String(failed.observation.case.input), signature: 'expected-output-mismatch' });
    const retries = new RetryLedger({ perFingerprintLimit: 2 });
    retries.record({ fingerprint });
    const canRetryOnce = retries.canRetry({ fingerprint });
    retries.record({ fingerprint });
    const canRetryTwice = retries.canRetry({ fingerprint });
    const classification = classifyFailure({ evidence: { source: 'verification', verificationFailed: true, sameFingerprint: true } });
    const transient = classifyFailure({ evidence: { timedOut: true } });
    const blocked = classifyFailure({ evidence: { permissionBlocked: true } });
    const replans = claimReplan({ used: 0, max: 2, onExhausted: () => null, onClaim: ({ next, label }) => `${next}:${label}` });
    const noReplans = claimReplan({ used: 2, max: 2, onExhausted: () => 'exhausted', onClaim: () => 'claimed' });
    const beforeState = { failingTests: 2, completedSteps: 1 };
    const afterState = { failingTests: 1, completedSteps: 2 };
    const moved = compareProgress({ previous: beforeState, current: afterState });
    const stalled = compareProgress({ previous: beforeState, current: { ...beforeState } });
    log.option({ name: 'failure fingerprint', value: fingerprint, source: 'failureFingerprint({ action, input, signature })' });
    log.list({
        title: 'taxonomy',
        items: [`verification = ${classification}`, `timeout = ${transient}`, `permission = ${blocked}`, `replan = ${replans} / ${noReplans}`],
    });
    check({ name: 'C: the same failed hypothesis has no retry budget left', ok: canRetryOnce === true && canRetryTwice === false && retries.counts.get(fingerprint) === 2, detail: `retry1=${canRetryOnce} retry2=${canRetryTwice} ledger=${JSON.stringify([...retries.counts])}` });
    check({ name: 'C: the taxonomy names the cause, not the symptom', ok: classification === FailureClass.FAILED_HYPOTHESIS && transient === FailureClass.TRANSIENT_INFRASTRUCTURE && blocked === FailureClass.PERMISSION_BLOCK, detail: `${classification}, ${transient}, ${blocked}` });
    check({ name: 'C: the replan budget is claimed once per attempt', ok: replans === '1:[replan 1/2]' && noReplans === 'exhausted', detail: `${replans} / ${noReplans}` });
    check({
        name: 'C: progress is measured, not assumed',
        ok: moved > 0 && stalled <= 0 && stateFingerprint({ snapshot: beforeState }) !== stateFingerprint({ snapshot: afterState }),
        detail: `moved=${moved} stalled=${stalled} states differ=${stateFingerprint({ snapshot: beforeState }) !== stateFingerprint({ snapshot: afterState })}`,
    });

    // ── D: the judged gate ───────────────────────────────────────────────────
    log.section({ t: 'D — a regex is not enough: the judged gate' });
    const judge = createLlmJudge({ client, model: defaultModel, criteria: [{ name: `The answer contains ${TOKEN}` }, { name: 'The answer adds no unrelated content' }] });
    const scored = createScoredJudge({
        client, model: defaultModel, scoreField: 'score',
        schema: z.object({ score: z.number().min(0).max(1), reason: z.string() }),
        systemMessage: 'You grade release-gate answers. Score 1 when the answer is exactly the required token.',
    });
    const markerScorer = EVAL_SCORERS.judge({ judge: /** @type {any} */ (judge), threshold: 0.5, name: 'llm-judge' });
    const scoredScorer = EVAL_SCORERS.judge({ judge: /** @type {any} */ (scored), threshold: 0.5, name: 'scored-judge' });
    const judged = await runEvals({
        cases: [CASES[0]],
        scorers: [markerScorer, scoredScorer],
        makeSession: sessionsOn({ cassette: createCassette({ path: CASSETTE }), mode: 'replay', onClient: replayClient }),
    });
    const [judgedCase] = judged.results;
    const llmVerdict = judgedCase?.verdicts.find((v) => v.name === 'llm-judge');
    const scoreVerdict = judgedCase?.verdicts.find((v) => v.name === 'scored-judge');
    log.list({ title: 'judged verdicts', items: judged.results.map(verdictLine) });
    check({
        name: 'D: the pass/fail judge graded the recorded answer as passing',
        ok: llmVerdict?.passed === true,
        detail: log.truncate({ text: String(llmVerdict?.evidence ?? ''), n: 110 }),
    });
    check({
        name: 'D: the scored judge returned a number above the threshold',
        ok: scoreVerdict?.passed === true && Number(scoreVerdict?.score) >= 0.5,
        detail: `score=${scoreVerdict?.score ?? 'none'} evidence=${log.truncate({ text: String(scoreVerdict?.evidence ?? ''), n: 70 })}`,
    });
    const ship = recorded.passRate >= 2 / 3 && llmVerdict?.passed === true && scoreVerdict?.passed === true;
    const deterministicOnly = recorded.passRate >= 2 / 3 && passedShipHeuristic({ passCase, secondPass });
    log.condition({ label: 'ship decision', branch: ship ? 'ship' : 'hold', why: `passRate=${recorded.passRate} judge=${llmVerdict?.passed} scored=${scoreVerdict?.passed} deterministic-only=${deterministicOnly}` });
    check({ name: 'D: the ship decision needs the rate AND the judge', ok: ship === true && deterministicOnly === true, detail: `ship=${ship} deterministic=${deterministicOnly}` });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'Recorded live, replayed deterministically, classified, judged, and gated.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

/**
 * What a deterministic-only gate would have concluded: the two passing cases
 * passed. Kept separate so the difference between "green" and "ship" is visible.
 * @param {{passCase: any, secondPass: any}} arg0
 * @returns {boolean}
 */
function passedShipHeuristic({ passCase, secondPass }) {
    return passCase?.passed === true && secondPass?.passed === true;
}

runMain({ mainFn: main });
