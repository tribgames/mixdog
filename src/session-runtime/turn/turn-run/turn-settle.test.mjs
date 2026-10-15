import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnSettlement } from './turn-settle.mjs';

function errorTypeFor(message) {
  const dispatched = [];
  const { reportTurnError } = createTurnSettlement({
    getSession: () => ({ id: 's' }),
    hooks: { emit() {}, dispatch: (name, payload) => dispatched.push([name, payload]) },
    hookCommonPayload: (payload) => payload,
  });
  reportTurnError({ startedAt: Date.now() }, new Error(message));
  return dispatched[0][1].error_type;
}

test('StopFailure error types match status codes only as whole tokens', () => {
  assert.equal(errorTypeFor('context of 1500 tokens exceeded'), 'unknown');
  assert.equal(errorTypeFor('id 14290 not found'), 'unknown');
  assert.equal(errorTypeFor('HTTP 503 service unavailable'), 'server_error');
  assert.equal(errorTypeFor('status 429'), 'rate_limit');
  assert.equal(errorTypeFor('status 401'), 'authentication_failed');
});

function settlement({ current, pending, onRun }) {
  let active = 1;
  const { settleTurn } = createTurnSettlement({
    getSession: () => ({ id: current() }),
    setSession() {},
    mgr: {},
    transcript: {},
    hooks: { emit() {}, dispatch() {} },
    hookCommonPayload: (payload) => payload,
    endComputerExecution: async () => {},
    deferComputerSessionRelease() {},
    getActiveTurnCount: () => active,
    setActiveTurnCount: (value) => {
      active = value;
    },
    isFirstTurnCompleted: () => true,
    takePendingCompact: (id) => pending.delete(id),
    runPendingCompact: onRun,
  });
  const turn = {
    session0: { id: 'A' },
    emitTiming() {},
    armHeavyRuntimeWarmup() {},
    snapshot: { finish: async () => {} },
    timing: {},
  };
  return () => settleTurn(turn);
}

test('a scheduled compact runs for the settled session only while it is still current', async () => {
  const ran = [];
  const pending = new Set(['A']);
  await settlement({ current: () => 'A', pending, onRun: (id) => ran.push(id) })();
  assert.deepEqual(ran, ['A']);
  assert.equal(pending.has('A'), false, 'one-shot');

  const other = new Set(['A']);
  await settlement({ current: () => 'B', pending: other, onRun: (id) => ran.push(id) })();
  assert.deepEqual(ran, ['A'], 'never compacts another session');
  assert.equal(other.has('A'), true, 'stays pending for A');
});
