import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSnapshot } from '../channels/lib/status-snapshot.mjs';
import { resolveScheduleTimezone, validateScheduleCron } from './schedule-time.mjs';

test('schedule registration validates cron and persists an explicit timezone', () => {
  assert.equal(validateScheduleCron('0 9 * * 1-5'), '0 9 * * 1-5');
  assert.throws(() => validateScheduleCron('61 9 * * *'), /invalid cron expression/);
  assert.equal(resolveScheduleTimezone('Asia/Seoul'), 'Asia/Seoul');
  assert.throws(() => resolveScheduleTimezone('Mars/Olympus'), /invalid schedule timezone/);
});

test('schedule status uses the node-cron v4 getNextRun API', async () => {
  const fireAt = new Date('2026-08-19T00:00:00.000Z');
  const snapshot = await computeSnapshot({
    cronJobs: new Map([['daily', { getNextRun: () => fireAt }]]),
    oneShotTimers: new Map(),
    nonInteractive: [],
    interactive: [],
    deferred: new Map(),
    shouldSkip: () => false,
  });
  assert.deepEqual(snapshot.schedules.next, {
    name: 'daily',
    fireAt: fireAt.getTime(),
    kind: 'cron',
  });
});
