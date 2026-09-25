import assert from 'node:assert/strict';
import test from 'node:test';
import { argValue, hasFlag, intArg, numArg, positionalArgs } from './cli-args.mjs';

test('argValue reads both the separated and the joined option form', () => {
  const argv = ['node', 'bench.mjs', '--model', 'opus', '--round=3', '--trailing'];
  assert.equal(argValue('--model', null, argv), 'opus');
  assert.equal(argValue('--round', null, argv), '3');
  assert.equal(argValue('--missing', null, argv), null);
  assert.equal(argValue('--missing', 'fallback', argv), 'fallback');
  // An explicit `undefined` fallback takes the parameter default, so a
  // missing option always reads as null rather than undefined.
  assert.equal(argValue('--missing', undefined, argv), null);
});

test('argValue falls back when the separated form has no value left', () => {
  assert.equal(argValue('--save', 'default', ['node', 'bench.mjs', '--save']), 'default');
  // An empty joined value is a value, not a missing option.
  assert.equal(argValue('--save', 'default', ['node', 'bench.mjs', '--save=']), '');
  // The next argument is taken verbatim, even when it looks like a flag.
  assert.equal(argValue('--save', null, ['node', 'bench.mjs', '--save', '--json']), '--json');
});

test('hasFlag reports presence only', () => {
  const argv = ['node', 'bench.mjs', '--json', '--limit=5'];
  assert.equal(hasFlag('--json', argv), true);
  assert.equal(hasFlag('--limit', argv), false);
  assert.equal(hasFlag('--quiet', argv), false);
});

test('intArg accepts positive integers and keeps the fallback otherwise', () => {
  assert.equal(intArg('--limit', 30, ['node', 'diag.mjs', '--limit', '5']), 5);
  assert.equal(intArg('--limit', 30, ['node', 'diag.mjs', '--limit=12']), 12);
  assert.equal(intArg('--limit', 30, ['node', 'diag.mjs']), 30);
  assert.equal(intArg('--limit', 30, ['node', 'diag.mjs', '--limit', 'abc']), 30);
  assert.equal(intArg('--limit', 30, ['node', 'diag.mjs', '--limit', '0']), 30);
  assert.equal(intArg('--limit', 30, ['node', 'diag.mjs', '--limit', '-4']), 30);
  // parseInt stops at the first non-digit, as the CLIs have always accepted.
  assert.equal(intArg('--limit', 30, ['node', 'diag.mjs', '--limit', '7x']), 7);
});

test('numArg keeps a deliberate 0 and falls back only on missing or non-numeric values', () => {
  assert.equal(numArg('--budget', 16000, ['node', 'bench.mjs', '--budget', '0']), 0);
  assert.equal(numArg('--budget', 16000, ['node', 'bench.mjs', '--budget=0']), 0);
  assert.equal(numArg('--budget', 16000, ['node', 'bench.mjs', '--budget', '2500']), 2500);
  assert.equal(numArg('--budget', 16000, ['node', 'bench.mjs', '--budget', '0.5']), 0.5);
  assert.equal(numArg('--budget', 16000, ['node', 'bench.mjs']), 16000);
  assert.equal(numArg('--budget', 16000, ['node', 'bench.mjs', '--budget=']), 16000);
  assert.equal(numArg('--budget', 16000, ['node', 'bench.mjs', '--budget', 'lots']), 16000);
  assert.equal(numArg('--budget', 16000, ['node', 'bench.mjs', '--budget']), 16000);
});

test('positionalArgs never lets a boolean flag or a joined value swallow a positional', () => {
  const booleans = new Set(['--render']);
  assert.deepEqual(
    positionalArgs(['--render', 'deck.js', 'deck.pptx', '--mode', 'auto'], booleans),
    ['deck.js', 'deck.pptx']
  );
  assert.deepEqual(positionalArgs(['--mode=auto', 'deck.js', 'deck.pptx'], booleans), ['deck.js', 'deck.pptx']);
  assert.deepEqual(
    positionalArgs(['deck.js', '--out', 'result.json', 'deck.pptx', '--render'], booleans),
    ['deck.js', 'deck.pptx']
  );
});
