import '../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { mock } from 'node:test';

// The scheduler's store writes become spies; nothing reaches PostgreSQL.
const writes = { done: [], failures: [] };
const realDb = await import('./schedules-db.mjs');
mock.module('./schedules-db.mjs', {
  namedExports: {
    ...realDb,
    markDone: async (name) => writes.done.push(name),
    markFired: async () => {},
    markScheduleSuccess: async () => {},
    markScheduleFailure: async (name) => writes.failures.push(name),
    markScheduleSkipped: async () => {},
    setNextFire: async () => {},
  },
});
const { Scheduler } = await import('./scheduler.mjs');

function bareScheduler(schedules, overrides = {}) {
  return Object.assign(Object.create(Scheduler.prototype), {
    nonInteractive: schedules,
    interactive: [],
    promptsDir: mkdtempSync(join(tmpdir(), 'mixdog-sched-')),
    running: new Set(),
    renaming: new Set(),
    cronJobs: new Map(),
    oneShotTimers: new Map(),
    lastFired: new Map(),
    deferred: new Map(),
    injectFn: null,
    notifyFailure() {},
    ...overrides,
  });
}

test('a reload failing after the row moved drops the old name and reports the failure', async () => {
  let cronDestroyed = 0;
  let oneShotFired = 0;
  const schedules = [{ name: 'a' }, { name: 'other' }];
  const scheduler = bareScheduler(schedules, { tickTimer: null });
  scheduler.cronJobs.set('a', { destroy: () => cronDestroyed++ });
  scheduler.oneShotTimers.set(
    'a',
    setTimeout(() => oneShotFired++, 20)
  );
  scheduler.lastFired.set('a', 'then');
  scheduler.lastFired.set('other', 'then');
  await assert.rejects(
    scheduler.renameLocked('a', async () => ({ name: 'b' }), {
      newName: 'b',
      reload: async () => {
        throw new Error('loadConfig rejected');
      },
    }),
    (error) =>
      /Renamed to "b", but reloading the scheduler failed \(loadConfig rejected\)/.test(error.message) &&
      error.code === 'SCHEDULE_RENAME_RELOAD_FAILED' &&
      error.details?.name === 'b'
  );
  await delay(50);
  assert.equal(cronDestroyed, 1, 'the old cron job is stopped');
  assert.equal(oneShotFired, 0, 'the old one-shot timer never fires');
  assert.equal(scheduler.oneShotTimers.size + scheduler.cronJobs.size, 0);
  assert.equal(scheduler.lastFired.has('a'), false);
  assert.equal(scheduler.lastFired.has('other'), true);
  assert.deepEqual(
    scheduler.nonInteractive.map((s) => s.name),
    ['other']
  );
  assert.equal(scheduler.renaming.has('a'), false, 'the name is released');
});

test('a one-shot blocked by the reservation fires once after a failed rename', async () => {
  const runs = [];
  const schedule = { name: 'a', prompt: 'go', whenAt: new Date(Date.now() - 1000).toISOString() };
  const scheduler = bareScheduler([schedule], {
    tickTimer: true,
    scheduleRunner: async (s) => {
      runs.push(s.name);
      return { sessionId: 's', result: '' };
    },
  });
  // What start() does for the loaded entries (the lock and cron are not needed here).
  scheduler.restart = () => {
    for (const s of scheduler.nonInteractive) scheduler.armOneShot(s, 'non-interactive');
  };
  await assert.rejects(
    scheduler.renameLocked(
      'a',
      async () => {
        await scheduler.fireOneShot(schedule, 'non-interactive'); // due while reserved
        throw new Error('the rename failed');
      },
      { newName: 'b' }
    ),
    /the rename failed/
  );
  assert.deepEqual(runs, [], 'nothing ran under the reservation');
  assert.deepEqual(writes.failures, [], 'the blocked fire is a skip, not a failure');
  await delay(60);
  assert.deepEqual(runs, ['a'], 'it fires once afterwards');
  assert.deepEqual(writes.done, ['a']);
  scheduler.oneShotTimers.forEach(clearTimeout);
});

test('another rename settling meanwhile does not hide a blocked one-shot of a failed rename', async () => {
  const a = { name: 'a', prompt: 'go', whenAt: new Date(Date.now() - 1000).toISOString() };
  const scheduler = bareScheduler([a, { name: 'b' }], { tickTimer: true });
  let restarts = 0;
  scheduler.restart = () => restarts++;
  scheduler.fireOneShot = (s) => scheduler.fireTimedPrompt(s, 'non-interactive');
  await assert.rejects(
    scheduler.renameLocked(
      'a',
      async () => {
        await scheduler.fireOneShot(a); // due while reserved
        await scheduler.renameLocked('b', async () => ({ name: 'b2' }), { newName: 'b2' });
        throw new Error('the rename failed');
      },
      { newName: 'a2' }
    ),
    /the rename failed/
  );
  assert.equal(restarts, 1, "a's blocked one-shot is re-armed");
  assert.equal(scheduler.renameBlocked?.size ?? 0, 0, 'nothing is left marked');
});
