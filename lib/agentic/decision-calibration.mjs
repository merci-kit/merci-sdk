// @ts-check
/**
 * @file Decision calibration — ECE, Brier, and a threshold sweep.
 * @version 0.24.0
 *
 * @description
 * The gate's thresholds (`DECISION_GATE_THRESHOLD`, `DECISION_SKIP_CERTAINTY`)
 * are policy, not vendor facts. This module turns a labelled sample of
 * `{ probability, expected }` pairs into the numbers that justify or refute
 * them: expected calibration error, Brier score, and the coverage/accuracy cost
 * of each candidate threshold. Pure functions — no client, no IO.
 */

import { ConfigurationError } from '../core/errors.mjs';


/**
 * One labelled decision. `probability` is the wire's probability for the
 * "true" answer; `expected` is the ground truth.
 * @typedef {Object} CalibrationSample
 * @property {number} probability
 * @property {boolean} expected
 * @property {number|null} [confidence] - The wire's confidence, when it reports
 *   one. The sweep uses the same certainty the gate does: confidence, else the
 *   distance of probability from 0.5.
 */

/**
 * @typedef {Object} CalibrationBin
 * @property {number} from
 * @property {number} to
 * @property {number} count
 * @property {number|null} meanProbability
 * @property {number|null} observed
 */

/**
 * @typedef {Object} ThresholdPoint
 * @property {number} threshold - Certainty at or above which the gate would act.
 * @property {number} coverage - Share of samples the gate would decide.
 * @property {number|null} accuracy - Accuracy on the samples it decides; null when it decides none.
 * @property {number} escalated - Share it would escalate instead.
 */

/**
 * @param {{samples?: Array<CalibrationSample>, bins?: number, thresholds?: Array<number>}} [arg0]
 * @returns {{count: number, ece: number, brier: number, bins: Array<CalibrationBin>, sweep: Array<ThresholdPoint>}}
 */
export function decisionCalibration({ samples = [], bins = 10, thresholds = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95] } = {}) {
    if (!Array.isArray(samples) || samples.length === 0) {
        throw new ConfigurationError({ message: 'decisionCalibration requires at least one { probability, expected } sample.', options: { option: 'samples' } });
    }
    if (!Number.isInteger(bins) || bins < 2) {
        throw new ConfigurationError({ message: 'decisionCalibration: bins must be an integer >= 2.', options: { option: 'bins' } });
    }
    if (!Array.isArray(thresholds) || thresholds.some((threshold) => !Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
        throw new ConfigurationError({ message: 'decisionCalibration: thresholds must be an array of numbers in 0..1.', options: { option: 'thresholds' } });
    }
    for (const [index, sample] of samples.entries()) {
        if (!sample || !Number.isFinite(sample.probability) || sample.probability < 0 || sample.probability > 1 || typeof sample.expected !== 'boolean') {
            throw new ConfigurationError({ message: `decisionCalibration: sample ${index} must be { probability: 0..1, expected: boolean }.`, options: { option: 'samples' } });
        }
        if (sample.confidence !== undefined && sample.confidence !== null
            && (!Number.isFinite(sample.confidence) || sample.confidence < 0 || sample.confidence > 1)) {
            throw new ConfigurationError({ message: `decisionCalibration: sample ${index} confidence must be 0..1 or null.`, options: { option: 'samples' } });
        }
    }

    const total = samples.length;
    const width = 1 / bins;
    /** @type {Array<{count: number, sumProbability: number, positives: number}>} */
    const buckets = Array.from({ length: bins }, () => ({ count: 0, sumProbability: 0, positives: 0 }));
    let brierSum = 0;
    for (const sample of samples) {
        const index = Math.min(bins - 1, Math.floor(sample.probability / width));
        const bucket = buckets[index];
        bucket.count += 1;
        bucket.sumProbability += sample.probability;
        bucket.positives += sample.expected ? 1 : 0;
        const truth = sample.expected ? 1 : 0;
        brierSum += (sample.probability - truth) ** 2;
    }

    let ece = 0;
    /** @type {Array<CalibrationBin>} */
    const report = buckets.map((bucket, index) => {
        const from = index * width;
        const to = index === bins - 1 ? 1 : (index + 1) * width;
        if (bucket.count === 0) return { from, to, count: 0, meanProbability: null, observed: null };
        const meanProbability = bucket.sumProbability / bucket.count;
        const observed = bucket.positives / bucket.count;
        ece += (Math.abs(meanProbability - observed) * bucket.count) / total;
        return { from, to, count: bucket.count, meanProbability, observed };
    });

    /** @type {Array<ThresholdPoint>} */
    const sweep = thresholds.map((threshold) => {
        let decided = 0;
        let correct = 0;
        for (const sample of samples) {
            const certainty = Number.isFinite(sample.confidence) ? /** @type {number} */ (sample.confidence) : Math.max(sample.probability, 1 - sample.probability);
            if (certainty < threshold) continue;
            decided += 1;
            const verdict = sample.probability >= 0.5;
            if (verdict === sample.expected) correct += 1;
        }
        return {
            threshold,
            coverage: decided / total,
            accuracy: decided === 0 ? null : correct / decided,
            escalated: (total - decided) / total,
        };
    });

    return { count: total, ece, brier: brierSum / total, bins: report, sweep };
}
