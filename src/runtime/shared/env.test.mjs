import assert from 'node:assert/strict';
import test from 'node:test';

import { envNonNegativeInt, envPositiveInt } from './env.mjs';
import { nonNegativeInt, positiveInt } from './numbers.mjs';

function withEnv(name, value, run) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('env integer helpers reuse the shared number policy', () => {
  withEnv('MIXDOG_TEST_ENV_INT', undefined, () => {
    assert.equal(envPositiveInt('MIXDOG_TEST_ENV_INT', 9), positiveInt(undefined, 9));
    assert.equal(envNonNegativeInt('MIXDOG_TEST_ENV_INT', 4), nonNegativeInt(undefined, 4));
  });
  withEnv('MIXDOG_TEST_ENV_INT', '12.9', () => {
    assert.equal(envPositiveInt('MIXDOG_TEST_ENV_INT', 1), 12);
    assert.equal(envNonNegativeInt('MIXDOG_TEST_ENV_INT', 1), 12);
  });
  withEnv('MIXDOG_TEST_ENV_INT', '0', () => {
    assert.equal(envPositiveInt('MIXDOG_TEST_ENV_INT', 7), 7);
    assert.equal(envNonNegativeInt('MIXDOG_TEST_ENV_INT', 7), 0);
  });
  withEnv('MIXDOG_TEST_ENV_INT', '-3', () => {
    assert.equal(envPositiveInt('MIXDOG_TEST_ENV_INT', 7), 7);
    assert.equal(envNonNegativeInt('MIXDOG_TEST_ENV_INT', 7), 7);
  });
});

test('envNonNegativeInt keeps an omitted or undefined fallback as undefined', () => {
  withEnv('MIXDOG_TEST_ENV_INT', undefined, () => {
    assert.equal(envNonNegativeInt('MIXDOG_TEST_ENV_INT'), undefined);
    assert.equal(envNonNegativeInt('MIXDOG_TEST_ENV_INT', undefined), undefined);
    assert.notEqual(envNonNegativeInt('MIXDOG_TEST_ENV_INT'), nonNegativeInt(undefined));
  });
  withEnv('MIXDOG_TEST_ENV_INT', 'abc', () => {
    assert.equal(envNonNegativeInt('MIXDOG_TEST_ENV_INT'), undefined);
    assert.equal(envNonNegativeInt('MIXDOG_TEST_ENV_INT', undefined), undefined);
    assert.equal(envNonNegativeInt('MIXDOG_TEST_ENV_INT', 9), 9);
  });
});
