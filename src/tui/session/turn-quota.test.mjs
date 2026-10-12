import assert from 'node:assert/strict';
import test from 'node:test';

import { failTurn, turnDoneItem } from './turn.mjs';
import { createTurnStream } from './turn-stream.mjs';

function failedItem(error) {
  let state = { spinner: null };
  const stream = createTurnStream({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    isCurrentTurn: () => true,
  });
  const ctx = {
    turn: {
      startedAt: Date.now(),
      completionVerb: 'Done',
      routeMeta: { provider: 'route-provider', model: 'route-model' },
    },
    stream,
    cards: { aggregates: { finalizeToolHeaders() {} }, toolCards: [] },
    getState: () => state,
    nextId: () => 1,
    pushNotice() {},
  };
  failTurn(ctx, error);
  return turnDoneItem(ctx);
}

test('a quota-exhausted failure carries quota on the failed turndone', () => {
  const error = Object.assign(new Error('limit'), {
    quotaExhausted: { provider: 'openai-oauth', model: 'gpt-x', resetAt: 123 },
  });
  const item = failedItem(error);
  assert.equal(item.status, 'failed');
  assert.deepEqual(item.quota, { provider: 'openai-oauth', model: 'gpt-x', resetAt: 123 });
});

test('quota falls back to the route and a null reset', () => {
  const item = failedItem(Object.assign(new Error('limit'), { quotaExhausted: {} }));
  assert.deepEqual(item.quota, { provider: 'route-provider', model: 'route-model', resetAt: null });
});

test('a generic usage-limit failure has no quota field', () => {
  const item = failedItem(Object.assign(new Error('Too many requests'), { status: 429 }));
  assert.equal(item.status, 'failed');
  assert.equal('quota' in item, false);
});
