// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runBacktest } from '../apps/03-quant-lab/backtest.mjs';
import { evaluateStrategy } from '../apps/03-quant-lab/engine.mjs';
import { readCandles } from '../apps/03-quant-lab/market-data.mjs';
import { clampExposure, scaleByVolatility } from '../apps/03-quant-lab/risk.mjs';
import { generateTargets } from '../apps/03-quant-lab/strategies.mjs';

const fixture = fileURLToPath(new URL('./fixtures/quant-lab-ohlcv.json', import.meta.url));

/**
 * Flat bars: open = high = low = close, so execution price is unambiguous.
 * @param {number[]} closes
 * @returns {import('../apps/03-quant-lab/types.mjs').Candle[]}
 */
const flatBars = (closes) => closes.map((c, i) => ({ t: i * 86400000, o: c, h: c, l: c, c, v: 0 }));

/**
 * Deterministic 0/1 target stream.
 * @param {{ count: number, seed: number }} arg0
 * @returns {number[]}
 */
function toggles({ count, seed }) {
  let s = seed >>> 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    out.push(s / 4294967296 > 0.5 ? 1 : 0);
  }
  return out;
}

describe('backtest — execution timing (no lookahead)', () => {
  test('a target from bar i fills at the open of bar i+1', () => {
    const candles = flatBars([100, 110, 121]);
    const result = runBacktest({ candles, targets: [1, 1, 1], initialCapital: 10000, feeBps: 0, spreadBps: 0, slippageBps: 0 });
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].t, candles[1].t);
    assert.equal(result.trades[0].price, candles[1].o);
  });

  test('initial bar has no trade and holds cash', () => {
    const candles = flatBars([100, 110, 121]);
    const result = runBacktest({ candles, targets: [1, 1, 1], initialCapital: 10000, feeBps: 0, spreadBps: 0, slippageBps: 0 });
    assert.equal(result.equity[0], 10000);
    assert.equal(result.positions[0], 0);
  });
});

describe('backtest — accounting properties', () => {
  test('buy-and-hold matches the hand-computed return', () => {
    const candles = flatBars([100, 110, 121]);
    const result = runBacktest({ candles, targets: [1, 1, 1], initialCapital: 10000, feeBps: 0, spreadBps: 0, slippageBps: 0 });
    assert.ok(Math.abs(result.finalEquity - 10000 * (121 / 110)) < 1e-6);
  });

  test('higher costs strictly lower the final equity', async () => {
    const candles = await readCandles({ path: fixture });
    const params = { fast: 10, slow: 30 };
    const free = runBacktest({
      candles,
      targets: generateTargets({ name: 'sma_cross', candles, params }),
      initialCapital: 10000, feeBps: 0, spreadBps: 0, slippageBps: 0,
    });
    const costly = runBacktest({
      candles,
      targets: generateTargets({ name: 'sma_cross', candles, params }),
      initialCapital: 10000, feeBps: 100, spreadBps: 20, slippageBps: 50,
    });
    assert.ok(costly.finalEquity < free.finalEquity);
    assert.ok(costly.totalCosts > 0);
  });

  test('equity stays positive and exposure stays within [0, 1]', async () => {
    const candles = await readCandles({ path: fixture });
    const { result } = evaluateStrategy({ candles, strategyName: 'sma_cross', params: { fast: 10, slow: 30 } });
    assert.ok(result.equity.every((value) => value > 0));
    assert.ok(result.positions.every((value) => value >= -1e-9 && value <= 1 + 1e-6));
  });

  test('an all-cash target stream makes no trades and no return', () => {
    const candles = flatBars([100, 120, 90, 200]);
    const result = runBacktest({ candles, targets: [0, 0, 0, 0], initialCapital: 10000 });
    assert.equal(result.trades.length, 0);
    assert.equal(result.finalEquity, 10000);
  });
});

describe('backtest — the no-edge reality', () => {
  test('random targets on a flat price lose only to costs', () => {
    const candles = flatBars(new Array(200).fill(100));
    const targets = toggles({ count: candles.length, seed: 7 });
    const result = runBacktest({ candles, targets, initialCapital: 10000, feeBps: 10, spreadBps: 2, slippageBps: 5 });
    assert.ok(result.trades.length > 0);
    assert.ok(result.finalEquity < 10000);
    assert.ok(result.totalCosts > 0);
  });

  test('the drawdown kill switch flattens the book', () => {
    const candles = flatBars([100, 100, 100, 40, 40, 40]);
    const result = runBacktest({ candles, targets: [1, 1, 1, 1, 1, 1], initialCapital: 10000, killDrawdown: 0.5, feeBps: 0, spreadBps: 0, slippageBps: 0 });
    assert.equal(result.killed, true);
    assert.ok(Math.abs(result.positions[result.positions.length - 1]) < 1e-9);
  });
});

describe('risk — caps and scaling', () => {
  test('clampExposure bounds into [0, maxExposure]', () => {
    assert.deepEqual(clampExposure({ targets: [-0.5, 0.5, 2], maxExposure: 1 }), [0, 0.5, 1]);
  });

  test('volatility scaling stays within the exposure cap', async () => {
    const candles = await readCandles({ path: fixture });
    const scaled = scaleByVolatility({ targets: candles.map(() => 1), candles, targetVol: 0.4, window: 20, maxExposure: 1 });
    assert.ok(scaled.every((value) => value >= 0 && value <= 1));
  });
});
