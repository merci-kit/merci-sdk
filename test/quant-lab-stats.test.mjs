// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  correlation,
  kurtosis,
  mean,
  median,
  normalCdf,
  normalInv,
  percentile,
  returns,
  skewness,
  stddev,
  variance,
} from '../apps/03-quant-lab/stats.mjs';

/**
 * Assert two numbers are within `eps`.
 * @param {number} a
 * @param {number} b
 * @param {number} [eps]
 * @returns {void}
 */
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

describe('stats — central tendency and spread', () => {
  test('mean of a simple series', () => {
    close(mean({ values: [1, 2, 3, 4] }), 2.5);
  });

  test('population vs sample variance', () => {
    const values = [-2, -1, 0, 1, 2];
    close(variance({ values, sample: false }), 2);
    close(variance({ values, sample: true }), 2.5);
  });

  test('stddev matches sqrt(variance)', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    close(stddev({ values, sample: false }), 2);
    close(stddev({ values, sample: true }), Math.sqrt(32 / 7));
  });

  test('clamp bounds the value', () => {
    assert.equal(clamp({ value: -1, min: 0, max: 1 }), 0);
    assert.equal(clamp({ value: 2, min: 0, max: 1 }), 1);
    assert.equal(clamp({ value: 0.5, min: 0, max: 1 }), 0.5);
  });
});

describe('stats — correlation and percentiles', () => {
  test('perfect positive and negative correlation', () => {
    close(correlation({ xs: [1, 2, 3], ys: [2, 4, 6] }), 1);
    close(correlation({ xs: [1, 2, 3], ys: [3, 2, 1] }), -1);
  });

  test('constant series has undefined correlation', () => {
    assert.ok(Number.isNaN(correlation({ xs: [1, 1, 1], ys: [1, 2, 3] })));
  });

  test('percentile and median interpolate', () => {
    close(percentile({ values: [1, 2, 3, 4], p: 0.5 }), 2.5);
    close(percentile({ values: [4, 1, 3, 2], p: 0 }), 1);
    close(percentile({ values: [4, 1, 3, 2], p: 1 }), 4);
    close(median({ values: [1, 2, 3, 4] }), 2.5);
  });
});

describe('stats — returns and moments', () => {
  test('simple returns', () => {
    assert.deepEqual(returns({ values: [100, 110, 121] }), [0.1, 0.1]);
  });

  test('log returns', () => {
    const out = returns({ values: [100, 110], log: true });
    close(out[0], Math.log(1.1));
  });

  test('skewness is zero for a symmetric series', () => {
    close(skewness({ values: [-2, -1, 0, 1, 2] }), 0);
  });

  test('kurtosis of a symmetric discrete series', () => {
    close(kurtosis({ values: [-2, -1, 0, 1, 2] }), 1.7);
  });
});

describe('stats — normal distribution', () => {
  test('normalCdf at anchor points', () => {
    close(normalCdf({ x: 0 }), 0.5, 1e-7);
    close(normalCdf({ x: 1.96 }), 0.975, 1e-3);
  });

  test('normalInv round-trips with normalCdf', () => {
    close(normalInv({ p: 0.5 }), 0, 1e-12);
    close(normalInv({ p: 0.975 }), 1.959964, 1e-4);
    close(normalCdf({ x: normalInv({ p: 0.9 }) }), 0.9, 1e-6);
  });

  test('boundaries are infinite', () => {
    assert.equal(normalInv({ p: 0 }), -Infinity);
    assert.equal(normalInv({ p: 1 }), Infinity);
  });
});
