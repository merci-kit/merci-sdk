// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, parseParams, runCli } from '../apps/03-quant-lab/cli.mjs';

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/quant-lab-ohlcv.json', import.meta.url));
const cliPath = fileURLToPath(new URL('../apps/03-quant-lab/cli.mjs', import.meta.url));

describe('cli — argument parsing', () => {
  test('separates the command from options', () => {
    const { command, options } = parseCliArgs({ argv: ['backtest', '--strategy', 'sma_cross', '--json'] });
    assert.equal(command, 'backtest');
    assert.equal(options.strategy, 'sma_cross');
    assert.equal(options.json, 'true');
  });

  test('parses numeric parameter bags', () => {
    assert.deepEqual(parseParams({ raw: '{"fast":5,"slow":30}' }), { fast: 5, slow: 30 });
  });
});

describe('cli — commands', () => {
  test('lists strategies', async () => {
    const output = await runCli({ argv: ['strategies'] });
    assert.match(output, /sma_cross/);
    assert.match(output, /buy_and_hold/);
  });

  test('prints usage for unknown commands', async () => {
    const output = await runCli({ argv: ['nonsense'] });
    assert.match(output, /quant-lab/);
  });

  test('backtest emits machine-readable JSON over the fixture', async () => {
    const output = await runCli({ argv: ['backtest', '--strategy', 'sma_cross', '--fixtures', fixture, '--json'] });
    const parsed = JSON.parse(output);
    assert.equal(parsed.bars, 500);
    assert.ok(parsed.metrics.finalEquity > 0);
    assert.equal(typeof parsed.verdict.passed, 'boolean');
  });

  test('costs are monotonic through the CLI', async () => {
    const cheap = JSON.parse(await runCli({ argv: ['backtest', '--strategy', 'sma_cross', '--fixtures', fixture, '--fee-bps', '0', '--spread-bps', '0', '--slippage-bps', '0', '--json'] }));
    const dear = JSON.parse(await runCli({ argv: ['backtest', '--strategy', 'sma_cross', '--fixtures', fixture, '--fee-bps', '100', '--spread-bps', '20', '--slippage-bps', '50', '--json'] }));
    assert.ok(cheap.metrics.finalEquity > dear.metrics.finalEquity);
  });

  test('report renders a verdict and overfitting checks', async () => {
    const output = await runCli({ argv: ['report', '--strategy', 'sma_cross', '--fixtures', fixture] });
    assert.match(output, /# Quant Lab report/);
    assert.match(output, /## Verdict:/);
    assert.match(output, /Probability of backtest overfitting/);
  });

  test('report writes markdown to a nested --out path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'quant-lab-'));
    const out = path.join(dir, 'nested', 'report.md');
    await runCli({ argv: ['report', '--strategy', 'buy_and_hold', '--fixtures', fixture, '--out', out] });
    const text = await readFile(out, 'utf8');
    assert.match(text, /# Quant Lab report/);
  });
});

describe('cli — executable entrypoint', () => {
  test('runs as a spawned process', async () => {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, 'backtest', '--strategy', 'buy_and_hold', '--fixtures', fixture]);
    assert.match(stdout, /backtest: buy_and_hold/);
  });
});
