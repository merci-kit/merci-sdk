// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { atr, ema, roc, rollingStd, rsi, sma } from '../apps/03-quant-lab/indicators.mjs';

/**
 * Build flat bars whose close follows `closes`, with a symmetric high/low band.
 * @param {number[]} closes
 * @param {number} [band]
 * @returns {import('../apps/03-quant-lab/types.mjs').Candle[]}
 */
const banded = (closes, band = 1) => closes.map((c) => ({ t: 0, o: c, h: c + band, l: c - band, c, v: 0 }));

describe('indicators — moving averages', () => {
  test('sma has NaN warm-up and the trailing mean after', () => {
    const out = sma({ values: [1, 2, 3, 4, 5], period: 3 });
    assert.ok(Number.isNaN(out[0]));
    assert.ok(Number.isNaN(out[1]));
    assert.equal(out[2], 2);
    assert.equal(out[3], 3);
    assert.equal(out[4], 4);
  });

  test('sma returns all NaN when the series is shorter than the period', () => {
    const out = sma({ values: [1, 2], period: 3 });
    assert.ok(out.every(Number.isNaN));
  });

  test('ema is seeded with the first simple average', () => {
    const out = ema({ values: [1, 2, 3, 4, 5], period: 3 });
    assert.equal(out[2], 2);
    assert.equal(out[3], 3);
    assert.equal(out[4], 4);
  });
});

describe('indicators — RSI', () => {
  test('monotonic rise pins RSI at 100', () => {
    const out = rsi({ values: [1, 2, 3, 4, 5], period: 2 });
    assert.equal(out[2], 100);
    assert.equal(out[4], 100);
  });

  test('monotonic fall pins RSI at 0', () => {
    const out = rsi({ values: [5, 4, 3, 2, 1], period: 2 });
    assert.equal(out[2], 0);
    assert.equal(out[4], 0);
  });
});

describe('indicators — ATR and friends', () => {
  test('ATR equals the constant true range', () => {
    const out = atr({ candles: banded([10, 11, 12, 13, 14], 1), period: 2 });
    assert.equal(out[2], 2);
    assert.equal(out[4], 2);
  });

  test('rate of change in percent', () => {
    const out = roc({ values: [100, 110, 121], period: 1 });
    assert.ok(Number.isNaN(out[0]));
    assert.equal(out[1], 10);
    assert.equal(out[2], 10);
  });

  test('rolling standard deviation', () => {
    const out = rollingStd({ values: [1, 1, 1], period: 2 });
    assert.ok(Number.isNaN(out[0]));
    assert.equal(out[1], 0);
    assert.equal(out[2], 0);
  });
});
