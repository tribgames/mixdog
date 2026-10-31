import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionActionCalls } from './session-action.mjs';
import { createSessionTurnGate } from './turn-gate.mjs';

function actions(turnGate, runtime) {
  const entry = { runtime };
  return createSessionActionCalls({
    isClosed: () => false,
    log: () => {},
    turnGate,
    projection: { bodyForClient: () => ({}), sessionOwner: () => null },
    retention: {
      retainUnwatched() {},
      awaitingApprovalSessionKinds: () => new Map(),
      roomHandoffQuestions: () => new Map(),
      stateBusy: () => false,
    },
    entries: {
      assertAvailable() {},
      hostedEntryForSession: async () => entry,
      entryForSession: async () => entry,
    },
    advanceForCaller: () => ({}),
    responseSessionId: (_entry, id) => id,
  });
}

const deleteCall = (id) => ({
  sessionId: 'sess_control',
  action: 'deleteSessionIfIdle',
  args: [id, { lastUsedAt: 1 }],
});

test('the idle-only delete refuses while a turn start is admitted, and closes the session to starts while it runs', async () => {
  const gate = createSessionTurnGate();
  const finish = Promise.withResolvers();
  const calls = [];
  const runtime = {
    deleteSessionIfIdle: async (id, expected, guards) => {
      calls.push([id, expected, typeof guards.isHostedBusy]);
      await finish.promise;
      return { deleted: true };
    },
  };
  const { configureSession } = actions(gate, runtime);
  // A submit is still in its intake: the delete never reaches the runtime.
  const leave = gate.enter('sess_x');
  assert.deepEqual((await configureSession(deleteCall('sess_x'))).value, { deleted: false, reason: 'turn-starting' });
  assert.deepEqual(calls, []);
  leave();
  // While the delete runs, a turn start of that session is refused.
  const deleting = configureSession(deleteCall('sess_x'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => gate.enter('sess_x'), { name: 'SessionClosedError' });
  // Other sessions start as usual.
  gate.enter('sess_other')();
  finish.resolve();
  assert.deepEqual((await deleting).value, { deleted: true });
  assert.deepEqual(calls, [['sess_x', { lastUsedAt: 1 }, 'function']]);
  // Reopened afterwards.
  gate.enter('sess_x')();
});
