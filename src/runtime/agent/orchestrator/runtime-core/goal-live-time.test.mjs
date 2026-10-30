import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import { createGoalRuntime, readStoredGoalSnapshot } from './goal-runtime.mjs';

const SESSION = 'sess_goal_live_time';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function dataDirFor(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-live-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test('a Goal is charged only for the time a live runtime ran it, not for a closed app or a sleeping PC', async (t) => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => mock.timers.reset());
  const dataDir = dataDirFor(t);
  let clock = 1_800_000_000_000;
  const open = () => createGoalRuntime({ dataDir, now: () => clock, deadlineWarningMs: [], generateTitle: null });

  const first = open();
  await first.control(SESSION, { action: 'create', objective: 'Verify the markets', duration: '1h' });
  // Ten live minutes: the heartbeat re-stamps the record every minute.
  for (let minute = 0; minute < 10; minute += 1) {
    clock += MINUTE;
    mock.timers.tick(MINUTE);
    await first.control(SESSION, { action: 'get' });
  }
  // The PC sleeps for six hours with the app open: the next beat drops the silence.
  clock += 6 * HOUR;
  mock.timers.tick(MINUTE);
  await first.control(SESSION, { action: 'get' });
  const afterSleep = first.snapshot(SESSION);
  assert.equal(afterSleep.status, 'active', 'sleep does not spend the budget');
  assert.equal(afterSleep.timeUsedMs, 10 * MINUTE);

  // The app closes for a day and reopens.
  await first.close();
  clock += 24 * HOUR;
  const second = open();
  t.after(() => second.close());
  const reopened = second.snapshot(SESSION);
  assert.equal(reopened.status, 'active');
  assert.ok(reopened.timeUsedMs <= 12 * MINUTE, `used ${reopened.timeUsedMs}`);
  assert.ok(reopened.timeUsedMs >= 10 * MINUTE);
  assert.ok(reopened.remainingMs > 45 * MINUTE);
});

test('a spent budget stored with wall-clock overshoot loads at its cap, never above it', async (t) => {
  const dataDir = dataDirFor(t);
  mkdirSync(join(dataDir, 'goals'), { recursive: true });
  const spent = Date.now() - 30 * HOUR;
  writeFileSync(
    join(dataDir, 'goals', `${SESSION}.json`),
    JSON.stringify({
      version: 1,
      goal: {
        id: 'goal-legacy',
        objective: 'Markets coverage and revenue model',
        status: 'duration_reached',
        timeLimitMs: 21 * HOUR + 23 * MINUTE,
        timeUsedMs: 23 * HOUR + 26 * MINUTE,
        createdAt: spent,
        updatedAt: spent,
      },
    })
  );
  const runtime = createGoalRuntime({ dataDir, deadlineWarningMs: [], generateTitle: null });
  t.after(() => runtime.close());
  const goal = runtime.snapshot(SESSION);
  assert.equal(goal.status, 'duration_reached');
  assert.equal(goal.timeUsedMs, 21 * HOUR + 23 * MINUTE);
  assert.equal(goal.remainingMs, 0);
});

test('a Goal that reaches its cap on a late observation reports the cap as spent', async (t) => {
  const dataDir = dataDirFor(t);
  let clock = 1_800_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock, deadlineWarningMs: [], generateTitle: null });
  t.after(() => runtime.close());
  await runtime.control(SESSION, { action: 'create', objective: 'Short budget', duration: '30m' });
  clock += 2 * HOUR;
  const goal = runtime.snapshot(SESSION);
  assert.equal(goal.status, 'duration_reached');
  assert.equal(goal.timeUsedMs, 30 * MINUTE);
});

test('snapshot reads do not starve the heartbeat: live minutes survive a reopen a day later', async (t) => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => mock.timers.reset());
  const dataDir = dataDirFor(t);
  let clock = 1_800_000_000_000;
  const open = () => createGoalRuntime({ dataDir, now: () => clock, deadlineWarningMs: [], generateTitle: null });
  const first = open();
  await first.control(SESSION, { action: 'create', objective: 'Watched work', duration: '1h' });
  // A reader (the route pulse) re-arms the deadline every 30 s.
  for (let beat = 0; beat < 20; beat += 1) {
    clock += MINUTE / 2;
    mock.timers.tick(MINUTE / 2);
    first.snapshot(SESSION);
    await first.control(SESSION, { action: 'get' });
  }
  await first.close();
  clock += 24 * HOUR;
  const second = open();
  t.after(() => second.close());
  assert.equal(second.snapshot(SESSION).timeUsedMs, 10 * MINUTE);
});

test('a short closed-app interval is not charged to the Goal', async (t) => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => mock.timers.reset());
  const dataDir = dataDirFor(t);
  let clock = 1_800_000_000_000;
  const open = () => createGoalRuntime({ dataDir, now: () => clock, deadlineWarningMs: [], generateTitle: null });
  const first = open();
  await first.control(SESSION, { action: 'create', objective: 'Quick restart', duration: '1h' });
  await first.close();
  clock += 2 * MINUTE;
  const second = open();
  t.after(() => second.close());
  assert.equal(second.snapshot(SESSION).timeUsedMs, 0);
});

test('a stateless read reports only persisted usage: never above it, never charging downtime, never backward', async (t) => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => mock.timers.reset());
  const dataDir = dataDirFor(t);
  let clock = 1_800_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock, deadlineWarningMs: [], generateTitle: null });
  await runtime.control(SESSION, { action: 'create', objective: 'Read before adoption', duration: '1h' });
  const reads = [];
  const read = (at = clock) => {
    const used = readStoredGoalSnapshot({ dataDir, sessionId: SESSION, now: () => at }).timeUsedMs;
    reads.push(used);
    return used;
  };
  const beatMinute = async () => {
    clock += MINUTE;
    mock.timers.tick(MINUTE);
    await runtime.control(SESSION, { action: 'get' });
  };

  // Live running: three heartbeats persist three minutes.
  for (let minute = 0; minute < 3; minute += 1) await beatMinute();
  // Half a minute past the last beat the runtime knows more than the file does;
  // a reader reports the file, never the runtime's unpersisted tail.
  clock += MINUTE / 2;
  assert.equal(runtime.snapshot(SESSION).timeUsedMs, 3.5 * MINUTE);
  assert.equal(read(), 3 * MINUTE, 'a live read never exceeds what the runtime persisted');

  // A starved heartbeat: five silent minutes later usage neither grows nor
  // drops to zero, and the late beat does not change it either.
  clock += 5 * MINUTE;
  assert.equal(read(), 3 * MINUTE);
  mock.timers.tick(MINUTE);
  await runtime.control(SESSION, { action: 'get' });
  assert.equal(read(), 3 * MINUTE);
  await beatMinute();
  assert.equal(read(), 4 * MINUTE);

  // Closed: the open segment stays at what was persisted, however long it stays closed.
  await runtime.close();
  const persisted = read();
  assert.equal(persisted, 4 * MINUTE);
  assert.equal(read(clock + 30_000), persisted, 'closing immediately never charges downtime');
  assert.equal(read(clock + 2 * MINUTE), persisted);
  assert.equal(read(clock + 24 * HOUR), persisted);

  assert.deepEqual(
    reads,
    [...reads].sort((a, b) => a - b),
    'successive reads never go backward'
  );
});
