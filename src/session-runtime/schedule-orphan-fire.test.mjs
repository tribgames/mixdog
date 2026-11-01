// A schedule whose owner bot is gone never fires: the scheduler's cron fire
// goes through the real run path and owner check, against the bot's files.
import '../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const dataDir = process.env.MIXDOG_DATA_DIR;
const stamps = [];
const stored = new Map();
const schedulesDb = await import('../runtime/channels/lib/schedules-db.mjs');
mock.module('../runtime/channels/lib/schedules-db.mjs', {
  namedExports: {
    ...schedulesDb,
    getSchedule: async (name) => stored.get(name) ?? null,
    claimScheduleRun: async (name) => stored.get(name) ?? null,
    markScheduleSkipped: async (name) => stamps.push(['skipped', name]),
    markScheduleFailure: async (name) => stamps.push(['failed', name]),
    markScheduleSuccess: async (name) => stamps.push(['succeeded', name]),
  },
});
const turns = [];
mock.module('./routine-home-turn.mjs', {
  namedExports: {
    runRoutineTurn: async (request) => {
      turns.push(request);
      return { sessionId: 'sess_home_lead', result: 'ran' };
    },
  },
});

const { Scheduler } = await import('../runtime/channels/lib/scheduler.mjs');
const { runScheduleSession } = await import('./schedule-session-run.mjs');

test('a schedule whose owner bot was deleted is skipped as paused on every fire, never run anywhere', async () => {
  // Archived: the entry file moved aside under a tombstone (the user's own
  // "메일 정기 검토" state). Purged: nothing of the bot left at all.
  const archived = join(dataDir, 'agents', 'agent-a70d746b04');
  mkdirSync(archived, { recursive: true });
  writeFileSync(join(archived, '.deleted'), 'deleted\n');
  writeFileSync(join(archived, 'AGENT.md.archived'), '---\nname: clerk\n---\n\nReview mail.\n');
  for (const [name, owner] of [
    ['mail-review', 'agent-a70d746b04'],
    ['purged-owner', 'agent-0000000000'],
  ]) {
    const schedule = { name, whenCron: '0 */3 * * *', prompt: 'Review mail', ownerAgentId: owner };
    stored.set(name, { ...schedule, enabled: true, status: 'active' });
    const scheduler = Object.assign(Object.create(Scheduler.prototype), {
      schedules: [schedule],
      running: new Set(),
      renaming: new Set(),
      cronJobs: new Map(),
      lastFired: new Map(),
      promptsDir: join(dataDir, 'prompts'),
      notifyFailure() {},
      // As the channels worker wires it (worker-main.mjs).
      scheduleRunner: (row, opts) => runScheduleSession(row, opts),
    });
    await scheduler.onCronFire(schedule, new Date());
    assert.ok(schedule.lastSkippedAt, `${name}: the fire is recorded as skipped`);
  }
  assert.deepEqual(turns, [], 'no turn ran, in the owner bot’s chat or under Mixy');
  assert.deepEqual(stamps, [
    ['skipped', 'mail-review'],
    ['skipped', 'purged-owner'],
  ]);
});
