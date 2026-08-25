import assert from 'node:assert/strict';
import test from 'node:test';

import { SPINNER_MODE_OVERRIDE_VERBS } from '../spinner-verbs.mjs';
import { createSessionApiA } from './session-api.mjs';

function createHarness({ enqueueResult = true } = {}) {
  let state = {
    busy: true,
    commandBusy: false,
  };
  let interruptCount = 0;
  const queued = [];
  const api = createSessionApiA({
    runtime: {
      interruptTaskWait(reason) {
        assert.equal(reason, 'user-message');
        interruptCount += 1;
      },
    },
    nextId: () => `submission_${queued.length + 1}`,
    flags: { autoClearRunning: false },
    pending: [],
    listeners: new Set(),
    getState: () => state,
    getPublishedState: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
    flushEmitImmediate() {},
    pushItem() {},
    patchItem() {},
    replaceItems: (items) => items,
    restoreOlderTranscript() {},
    restoreNewerTranscript() {},
    settleStreamingTail() {},
    clearStreamingTail() {},
    pushNotice() {},
    autoClearState: {},
    agentStatusState: () => ({}),
    routeState: () => ({}),
    syncContextStats() {},
    denyAllToolApprovals() {},
    updateAgentJobCard() {},
    requeueEntriesFront() {},
    enqueue(text, options) {
      queued.push({ text, options });
      return enqueueResult;
    },
    autoClearBeforeSubmit: async () => {},
    restoreQueued() {},
    prioritizeQueued() {},
    resetStatsAndSyncContext() {},
    drain() {},
    flushDeferredExecutionPendingResumeKick() {},
    discardExecutionPendingResume() {},
  });
  return {
    api,
    queued,
    interruptCount: () => interruptCount,
  };
}

test('accepted user input wakes an active task wait', () => {
  const harness = createHarness();

  assert.equal(harness.api.submit('새 지시'), true);
  assert.equal(harness.queued.length, 1);
  assert.equal(harness.interruptCount(), 1);
});

test('rejected user input does not wake a task wait', () => {
  const harness = createHarness({ enqueueResult: false });

  assert.equal(harness.api.submit('중복 지시'), false);
  assert.equal(harness.interruptCount(), 0);
});

test('task wait spinner has the dedicated waiting label', () => {
  assert.equal(SPINNER_MODE_OVERRIDE_VERBS['task-wait'], '작업 대기 중');
});
