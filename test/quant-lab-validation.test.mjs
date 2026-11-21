// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readCandles } from '../apps/03-quant-lab/market-data.mjs';
import { createTrialLog, deflatedSharpe, expectedMaxSharpe, probabilityOfBacktestOverfitting, walkForward } from '../apps/03-quant-lab/validation.mjs';

const fixture = fileURLToPath(new URL('./fixtures/quant-lab-ohlcv.json', import.meta.url));

/** Deterministic standard-normal draw from a linear congruential generator. */
function makeNormal() {
  let s = 12345 >>> 0;
  const uniform = () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/**
 * Build `strategies` return series of `length`; only strategy 0 has an edge when `edge`.
 * @param {{ strategies: number, length: number, edge: boolean }} arg0
 * @returns {number[][]}
 */
function returnMatrix({ strategies, length, edge }) {
  const normal = makeNormal();
  const matrix = [];
  for (let m = 0; m < strategies; m++) {
    const series = [];
    for (let i = 0; i < length; i++) {
      series.push(m === 0 && edge ? 0.002 + 0.001 * normal() : 0.001 * normal());
    }
    matrix.push(series);
  }
  return matrix;
}

describe('validation — trial log', () => {
  test('counts every configuration tried', () => {
    const log = createTrialLog();
    log.add({ label: 'a', params: { fast: 5 }, metric: 1 });
    log.add({ label: 'b', params: { fast: 10 }, metric: 2 });
    assert.equal(log.count(), 2);
    assert.equal(log.all().length, 2);
  });
});

describe('validation — deflated Sharpe', () => {
  test('expected maximum Sharpe grows with the number of trials', () => {
    const few = expectedMaxSharpe({ trials: 2, sampleLength: 1000 });
    const many = expectedMaxSharpe({ trials: 1000, sampleLength: 1000 });
    assert.ok(many > few);
  });

  test('the same Sharpe deflates as trials increase', () => {
    const honest = deflatedSharpe({ sharpe: 0.12, trials: 2, sampleLength: 500 });
    const searched = deflatedSharpe({ sharpe: 0.12, trials: 5000, sampleLength: 500 });
    assert.ok(searched < honest);
  });

  test('a strong Sharpe with a single trial rejects the null', () => {
    const dsr = deflatedSharpe({ sharpe: 0.3, trials: 1, sampleLength: 1000 });
    assert.ok(dsr > 0.95);
  });
});

describe('validation — probability of backtest overfitting', () => {
  test('undefined with fewer than two strategies', () => {
    assert.ok(Number.isNaN(probabilityOfBacktestOverfitting({ returnsByStrategy: [[0.1, 0.2, 0.3]] })));
  });

  test('a genuine edge survives; pure noise does not', () => {
    const edgePbo = probabilityOfBacktestOverfitting({ returnsByStrategy: returnMatrix({ strategies: 8, length: 400, edge: true }) });
    const noisePbo = probabilityOfBacktestOverfitting({ returnsByStrategy: returnMatrix({ strategies: 8, length: 400, edge: false }) });
    assert.ok(edgePbo < 0.1, `edge PBO should be low, got ${edgePbo}`);
    assert.ok(noisePbo > edgePbo, `noise PBO (${noisePbo}) should exceed edge PBO (${edgePbo})`);
  });
});

describe('validation — walk-forward', () => {
  test('produces out-of-sample segments and counts trials', async () => {
    const candles = await readCandles({ path: fixture });
    const result = walkForward({ candles, strategyName: 'sma_cross', trainSize: 200, testSize: 50 });
    assert.ok(result.segments.length >= 1);
    assert.equal(result.trials, result.segments.length * result.gridSize);
    assert.ok(Number.isFinite(result.metrics.netReturn));
    for (const segment of result.segments) {
      assert.equal(typeof segment.params, 'object');
    }
  });
});
