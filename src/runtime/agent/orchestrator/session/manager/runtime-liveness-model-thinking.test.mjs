import assert from 'node:assert/strict';
import test from 'node:test';
import { getSessionProgressSnapshot, markSessionTransportActivity, updateSessionStage } from './runtime-liveness.mjs';
import { runtimeState } from './runtime-state.mjs';

test('a sent request reads as model thinking until its headers arrive, without touching stage or clocks', async (t) => {
  const id = 'sess_model_thinking';
  t.after(() => runtimeState.delete(id));
  updateSessionStage(id, 'requesting');
  const started = getSessionProgressSnapshot(id);
  assert.equal(started.awaitingModelResponse, false, 'not sent yet');

  await new Promise((resolve) => setTimeout(resolve, 2));
  updateSessionStage(id, 'model_thinking');
  const thinking = getSessionProgressSnapshot(id);
  assert.equal(thinking.stage, 'requesting');
  assert.equal(thinking.awaitingModelResponse, true);
  assert.equal(thinking.modelRequestStartedAt, started.modelRequestStartedAt);
  assert.equal(thinking.lastProgressAt, started.lastProgressAt, 'sending is not progress');

  await new Promise((resolve) => setTimeout(resolve, 2));
  markSessionTransportActivity(id);
  assert.equal(getSessionProgressSnapshot(id).awaitingModelResponse, false, 'headers arrived');

  // A retried attempt starts unsent and keeps the request clock.
  updateSessionStage(id, 'model_thinking');
  updateSessionStage(id, 'requesting');
  const retried = getSessionProgressSnapshot(id);
  assert.equal(retried.awaitingModelResponse, false);
  assert.equal(retried.modelRequestStartedAt, started.modelRequestStartedAt);
});
