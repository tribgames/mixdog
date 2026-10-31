// A one-shot schedule fires when its stored time is the instant it was armed
// with: the database hands back a new Date on every read.
import '../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const WHEN = '2030-01-01T09:00:00.000Z';
const stored = { row: null };
const db = new URL('./schedules-db.mjs', import.meta.url).href;
mock.module(db, {
  namedExports: { ...(await import(db)), getSchedule: async () => (stored.row ? { ...stored.row } : null) },
});
const { Scheduler } = await import('./scheduler.mjs');

function armed(whenAt) {
  const fired = [];
  const scheduler = Object.assign(Object.create(Scheduler.prototype), {
    notifyFailure() {},
    resolvePrompt: () => 'prompt',
    fireTimedPrompt: async (schedule) => {
      fired.push(schedule.name);
      return true;
    },
  });
  return { scheduler, fired, schedule: { name: 'once', whenAt, whenCron: null } };
}

test('an unchanged one-shot fires although the stored time is a new Date for the same instant', async () => {
  stored.row = { name: 'once', enabled: true, status: 'active', prompt: 'p', whenAt: new Date(WHEN), whenCron: null };
  const { scheduler, fired, schedule } = armed(new Date(WHEN));
  assert.equal(await scheduler.fireTimed(schedule), true);
  assert.deepEqual(fired, ['once']);
});

test('a one-shot moved to another time since it was armed is skipped', async () => {
  stored.row = {
    name: 'once',
    enabled: true,
    status: 'active',
    prompt: 'p',
    whenAt: new Date('2030-01-02T09:00:00.000Z'),
    whenCron: null,
  };
  const { scheduler, fired, schedule } = armed(new Date(WHEN));
  assert.equal(await scheduler.fireTimed(schedule), false);
  assert.deepEqual(fired, []);
});
