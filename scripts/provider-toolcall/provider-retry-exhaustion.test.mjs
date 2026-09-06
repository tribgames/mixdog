import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isProviderRecoveryExhausted,
  withRetry,
} from '../../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';

test('an exhausted Anthropic request cannot receive a second outer retry budget', async () => {
  const transient = new Error('connection reset');
  transient.code = 'ECONNRESET';
  Object.freeze(transient);
  let innerAttempts = 0;
  let outerAttempts = 0;

  await assert.rejects(withRetry(
    async () => {
      outerAttempts += 1;
      return withRetry(
        async () => {
          innerAttempts += 1;
          throw transient;
        },
        {
          maxAttempts: 2,
          backoffMs: [0, 0],
          provider: 'anthropic',
          recoveryOwner: 'anthropic-initial-response',
          retryJitterRatio: 0,
          sleepFn: async () => {},
        },
      );
    },
    {
      maxAttempts: 3,
      backoffMs: [0, 0, 0],
      retryJitterRatio: 0,
      sleepFn: async () => {},
    },
  ), (error) => {
    assert.equal(error, transient);
    assert.equal(isProviderRecoveryExhausted(error), true);
    assert.equal(isProviderRecoveryExhausted(new Error('wrapper', { cause: error })), true);
    return true;
  });

  assert.equal(innerAttempts, 2);
  assert.equal(outerAttempts, 1);
});
