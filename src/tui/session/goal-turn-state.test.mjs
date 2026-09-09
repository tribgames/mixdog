import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGoalRuntime } from '../../session-runtime/goal-runtime.mjs';
import { createSessionApiA } from './session-api.mjs';
import { abortGoalTurn, preserveGoalStateAfterTurn } from './goal-turn-state.mjs';

test('a steering abort preserves requested Goal time while a later explicit stop still pauses it', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-steering-'));
  let clock = 2_000_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock });
  const sessionId = 'sess_goal_steering';
  const flags = { leadTurnEpoch: 1 };
  t.after(() => {
    flags.disposed = true;
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const pending = [{ mode: 'prompt', content: 'Continue with this correction' }];
  const reasons = [];
  const api = createSessionApiA({
    flags, pending, getState: () => ({ busy: true }),
    denyAllToolApprovals() {},
    runtime: { abort: (reason) => { reasons.push(reason); return true; } },
  });
  const settle = () => runtime.settleTurn(sessionId, {
    status: 'cancelled',
    preserveGoalState: preserveGoalStateAfterTurn({
      cancelled: true,
      interruptedForSteering: flags.goalSteeringAbortEpoch === flags.leadTurnEpoch,
    }),
  });
  await runtime.control(sessionId, { action: 'create', objective: 'Keep working for the requested duration', duration: '30m' });
  await runtime.startTurn(sessionId);
  clock += 10_000;
  assert.equal(api.abort().aborted, true);
  const handedOff = await settle();
  assert.equal(handedOff.status, 'active');
  assert.equal(handedOff.timeLimitMs, 1_800_000);
  assert.equal(handedOff.remainingMs, 1_790_000);
  assert.equal(runtime.continuation(sessionId).run, true);

  pending.length = 0;
  flags.leadTurnEpoch += 1;
  await runtime.startTurn(sessionId);
  clock += 5_000;
  assert.equal(api.abort().aborted, true);
  const stopped = await settle();
  assert.equal(stopped.status, 'paused');
  assert.equal(stopped.timeUsedMs, 15_000);
  clock += 10_000;
  assert.equal(runtime.snapshot(sessionId).timeUsedMs, stopped.timeUsedMs);
  assert.equal(runtime.continuation(sessionId).run, false);
  assert.deepEqual(reasons, ['interrupt', 'user-cancel']);
});

test('rejected or failed abort requests cannot authorize a steering handoff', () => {
  for (const abort of [() => false, () => { throw new Error('abort unavailable'); }]) {
    const flags = { leadTurnEpoch: 2, goalSteeringAbortEpoch: 1 };
    try { abortGoalTurn({ abort }, flags, true); } catch {}
    assert.equal(preserveGoalStateAfterTurn({
      cancelled: true,
      interruptedForSteering: flags.goalSteeringAbortEpoch === flags.leadTurnEpoch,
    }), false);
  }
});
