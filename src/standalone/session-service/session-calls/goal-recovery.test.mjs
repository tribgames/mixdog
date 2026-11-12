import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalRecovery } from './goal-recovery.mjs';

const ids = Array.from({ length: 20 }, (_, index) => `sess_daemon_${index}_${'a'.repeat(32)}`);

test('active Goals resume one per turn of the event loop, never as one run', async () => {
  const events = [];
  let running = true;
  const tick = () => {
    if (!running) return;
    events.push('tick');
    setImmediate(tick);
  };
  setImmediate(tick);
  const recover = createGoalRecovery({
    log: () => {},
    listStoredActiveGoalSessionIds: async () => ids,
    readStoredGoal: async () => ({ status: 'active' }),
    materializeSession: async () => {
      events.push('resume');
    },
  });
  const summary = await recover();
  running = false;
  assert.deepEqual(summary, { found: 20, resumed: 20, skipped: 0, failed: 0 });
  // The loop turned between the resumes (without pacing every resume runs in
  // one microtask chain and the ticks only start after the last one).
  const firstTick = events.indexOf('tick');
  const lastResume = events.lastIndexOf('resume');
  assert.ok(firstTick >= 0 && firstTick < lastResume, events.join(' '));
  const turns = events.slice(0, lastResume).filter((event) => event === 'tick').length;
  assert.ok(turns >= ids.length - 2, `${turns} loop turns for ${ids.length} resumes`);
});
