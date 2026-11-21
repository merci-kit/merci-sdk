// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatGreeting, parseGreetArgs, greet } from '../apps/02-greet/greet.mjs';

describe('Greeting Logic - formatGreeting', () => {
  test('returns default greeting when no options provided', () => {
    assert.equal(formatGreeting(), 'Hello, World!');
  });

  test('formats custom name correctly', () => {
    assert.equal(formatGreeting({ name: 'Alice' }), 'Hello, Alice!');
  });

  test('formats custom greeting and name correctly', () => {
    assert.equal(formatGreeting({ name: 'Bob', greeting: 'Hi' }), 'Hi, Bob!');
  });
});

describe('CLI Argument Parser - parseGreetArgs', () => {
  test('parses empty args as defaults', () => {
    const result = parseGreetArgs({ args: [] });
    assert.deepEqual(result, { name: 'World', greeting: 'Hello' });
  });

  test('parses positional name argument', () => {
    const result = parseGreetArgs({ args: ['Alice'] });
    assert.deepEqual(result, { name: 'Alice', greeting: 'Hello' });
  });

  test('parses --name flag', () => {
    const result = parseGreetArgs({ args: ['--name', 'Bob'] });
    assert.deepEqual(result, { name: 'Bob', greeting: 'Hello' });
  });

  test('parses -n short flag', () => {
    const result = parseGreetArgs({ args: ['-n', 'Charlie'] });
    assert.deepEqual(result, { name: 'Charlie', greeting: 'Hello' });
  });

  test('parses --greeting and -g flags', () => {
    const result = parseGreetArgs({ args: ['-g', 'Welcome', '--name', 'David'] });
    assert.deepEqual(result, { name: 'David', greeting: 'Welcome' });
  });

  test('parses --help flag', () => {
    const result = parseGreetArgs({ args: ['--help'] });
    assert.deepEqual(result, { help: true });
  });
});

describe('High-level greet function', () => {
  test('returns default greeting for empty array', () => {
    assert.equal(greet({ args: [] }), 'Hello, World!');
  });

  test('returns formatted greeting with custom args', () => {
    assert.equal(greet({ args: [/** @type {never} */ ('--name'), /** @type {never} */ ('Eve')] }), 'Hello, Eve!');
  });

  test('returns help message when --help is passed', () => {
    const output = greet({ args: [/** @type {never} */ ('--help')] });
    assert.match(output, /Usage: greet/);
  });
});
