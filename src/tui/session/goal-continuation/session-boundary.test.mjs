import assert from 'node:assert/strict';
import test from 'node:test';
import { rearmGoalContinuationOnSessionBoundaries } from './session-boundary.mjs';

test('every session boundary re-arms the Goal continuation after it settles', async () => {
  const log = [];
  const api = {
    resume: async (id) => {
      log.push(`resume:${id}`);
      return true;
    },
    newSession: async () => {
      log.push('newSession');
      return 'fresh';
    },
    switchContext: async () => {
      log.push('switchContext');
      return false;
    },
    submit: () => 'untouched',
  };
  const bag = {
    cancelQueuedGoalContinuations: () => log.push('cancel'),
    refreshGoalState: () => log.push('refresh'),
    scheduleGoalContinuation: () => log.push('schedule'),
  };
  const submit = api.submit;
  rearmGoalContinuationOnSessionBoundaries({ api, bag });
  assert.equal(await api.resume('sess-1'), true);
  assert.equal(await api.newSession(), 'fresh');
  assert.equal(await api.switchContext(), false);
  assert.equal(api.submit, submit);
  assert.deepEqual(log, [
    'resume:sess-1',
    'cancel',
    'refresh',
    'schedule',
    'newSession',
    'cancel',
    'refresh',
    'schedule',
    'switchContext',
    'cancel',
    'refresh',
    'schedule',
  ]);
});
