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
  // The monotonic clock stops while the OS is suspended; the wall clock does not.
  let mono = 0;
  const open = () =>
    createGoalRuntime({
      dataDir,
      now: () => clock,
      monotonicNow: () => mono,
      suspendDetectable: true,
      deadlineWarningMs: [],
      generateTitle: null,
    });

  const first = open();
  await first.control(SESSION, { action: 'create', objective: 'Verify the markets', duration: '1h' });
  // Ten live minutes: the heartbeat re-stamps the record every minute.
  for (let minute = 0; minute < 10; minute += 1) {
    clock += MINUTE;
    mono += MINUTE;
    mock.timers.tick(MINUTE);
    await first.control(SESSION, { action: 'get' });
  }
  // The PC sleeps for six hours with the app open: the next beat drops the suspension.
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
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => mock.timers.reset());
  const dataDir = dataDirFor(t);
  let clock = 1_800_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock, deadlineWarningMs: [], generateTitle: null });
  t.after(() => runtime.close());
  await runtime.control(SESSION, { action: 'create', objective: 'Short budget', duration: '30m' });
  // Live heartbeats up to 29 minutes, then a read lands inside the heartbeat
  // tolerance but past the cap: running time, not sleep.
  for (let minute = 0; minute < 29; minute += 1) {
    clock += MINUTE;
    mock.timers.tick(MINUTE);
    await runtime.control(SESSION, { action: 'get' });
  }
  clock += 2.5 * MINUTE;
  const goal = runtime.snapshot(SESSION);
  assert.equal(goal.status, 'duration_reached');
  assert.equal(goal.timeUsedMs, 30 * MINUTE);
});

test('a snapshot read after the PC slept does not expire the Goal or charge the sleep', async (t) => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => mock.timers.reset());
  const dataDir = dataDirFor(t);
  let clock = 1_800_000_000_000;
  const mono = 0;
  const runtime = createGoalRuntime({
    dataDir,
    now: () => clock,
    monotonicNow: () => mono,
    suspendDetectable: true,
    deadlineWarningMs: [],
    generateTitle: null,
  });
  t.after(() => runtime.close());
  await runtime.control(SESSION, { action: 'create', objective: 'Slept through', duration: '30m' });
  // No heartbeat fires: the first observer after the sleep is a snapshot read,
  // and only the wall clock moved.
  clock += 6 * HOUR;
  const goal = runtime.snapshot(SESSION);
  assert.equal(goal.status, 'active');
  assert.ok(goal.timeUsedMs <= MINUTE, `charged ${goal.timeUsedMs}`);
  await runtime.control(SESSION, { action: 'get' });
  assert.equal(readStoredGoalSnapshot({ dataDir, sessionId: SESSION, now: () => clock }).status, 'active');
});

test('a suspend is charged at the edit that re-stamps the Goal, and never reused against a later awake stall', async (t) => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => mock.timers.reset());
  const dataDir = dataDirFor(t);
  let clock = 1_800_000_000_000;
  let mono = 0;
  const runtime = createGoalRuntime({
    dataDir,
    now: () => clock,
    monotonicNow: () => mono,
    suspendDetectable: true,
    deadlineWarningMs: [],
    generateTitle: null,
  });
  t.after(() => runtime.close());
  await runtime.control(SESSION, { action: 'create', objective: 'Edited after sleep', duration: '2h' });
  // The PC sleeps; the first thing to touch the Goal is the user's edit.
  clock += 6 * HOUR;
  const edited = (await runtime.control(SESSION, { action: 'edit', objective: 'Edited after sleep, clarified' })).goal;
  assert.equal(edited.status, 'active');
  assert.ok(edited.timeUsedMs <= MINUTE, `edit charged ${edited.timeUsedMs}`);
  // Then the process stalls awake for 40 minutes before any heartbeat: that
  // time ran, and the sleep before the edit must not be deducted from it.
  clock += 40 * MINUTE;
  mono += 40 * MINUTE;
  const goal = runtime.snapshot(SESSION);
  assert.equal(goal.status, 'active');
  assert.ok(goal.timeUsedMs >= 39 * MINUTE, `stall counted as ${goal.timeUsedMs}`);
});

const SETTLEMENTS = {
  'a model completion': [
    (runtime) => runtime.executeTool('goal', { action: 'complete' }, { callerSessionId: SESSION }),
    'complete',
  ],
  'a clean turn finish': [(runtime) => runtime.settleTurn(SESSION, { status: 'done' }), 'active'],
  'a cancelled turn': [(runtime) => runtime.settleTurn(SESSION, { status: 'cancelled' }), 'paused'],
  'a failed turn': [(runtime) => runtime.settleTurn(SESSION, { status: 'failed', error: 'boom' }), 'blocked'],
};
for (const [name, [settle, expected]] of Object.entries(SETTLEMENTS)) {
  test(`${name} right after a suspend does not charge the sleep or reach the cap`, async (t) => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    t.after(() => mock.timers.reset());
    const dataDir = dataDirFor(t);
    let clock = 1_800_000_000_000;
    const mono = 0;
    const runtime = createGoalRuntime({
      dataDir,
      now: () => clock,
      monotonicNow: () => mono,
      suspendDetectable: true,
      deadlineWarningMs: [],
      generateTitle: null,
    });
    t.after(() => runtime.close());
    await runtime.control(SESSION, { action: 'create', objective: 'Turn across a sleep', duration: '30m' });
    await runtime.startTurn(SESSION);
    // The PC sleeps mid-turn; the turn ends before any heartbeat or read.
    clock += 6 * HOUR;
    await settle(runtime);
    const goal = runtime.snapshot(SESSION);
    assert.equal(goal.status, expected);
    assert.ok(goal.timeUsedMs <= MINUTE, `charged ${goal.timeUsedMs}`);
  });
}

test('an awake stall past the heartbeat tolerance still expires a Goal over its cap', async (t) => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => mock.timers.reset());
  const dataDir = dataDirFor(t);
  let clock = 1_800_000_000_000;
  let mono = 0;
  const runtime = createGoalRuntime({
    dataDir,
    now: () => clock,
    monotonicNow: () => mono,
    suspendDetectable: true,
    deadlineWarningMs: [],
    generateTitle: null,
  });
  t.after(() => runtime.close());
  await runtime.control(SESSION, { action: 'create', objective: 'Starved loop', duration: '30m' });
  // A busy event loop for 40 minutes: both clocks advanced, no heartbeat ran.
  clock += 40 * MINUTE;
  mono += 40 * MINUTE;
  const goal = runtime.snapshot(SESSION);
  assert.equal(goal.status, 'duration_reached');
  assert.equal(goal.timeUsedMs, 30 * MINUTE);
});

test('a faked Date clock with no monotonic source counts its jumps, where suspend detection is on', async (t) => {
  // Fake timers move Date.now but not performance.now; a test that fakes Date
  // opts out of the monotonic pair with `monotonicNow: null`.
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 2_000_000_000_000 });
  t.after(() => mock.timers.reset());
  const dataDir = dataDirFor(t);
  const runtime = createGoalRuntime({
    dataDir,
    monotonicNow: null,
    suspendDetectable: true,
    deadlineWarningMs: [],
    generateTitle: null,
  });
  t.after(() => runtime.close());
  await runtime.control(SESSION, { action: 'create', objective: 'Fake clock', duration: '30m' });
  mock.timers.tick(31 * MINUTE);
  assert.equal(runtime.snapshot(SESSION).status, 'duration_reached');
});

test('a transparent Date.now wrapper does not disable real suspend detection', async (t) => {
  // Provenance is not decided by Date.now's identity: a wrapper that only
  // forwards the real clock (here shifted like a sleeping PC) still detects.
  const realNow = Date.now.bind(Date);
  let shift = 0;
  t.mock.method(Date, 'now', () => realNow() + shift);
  const dataDir = dataDirFor(t);
  const runtime = createGoalRuntime({ dataDir, suspendDetectable: true, deadlineWarningMs: [], generateTitle: null });
  t.after(() => runtime.close());
  await runtime.control(SESSION, { action: 'create', objective: 'Wrapped clock', duration: '30m' });
  shift = 6 * HOUR;
  const goal = runtime.snapshot(SESSION);
  assert.equal(goal.status, 'active');
  assert.ok(goal.timeUsedMs <= MINUTE, `charged ${goal.timeUsedMs}`);
});

test('a missing monotonic reading retires the anchor, so a later valid one cannot discard counted time', async (t) => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => mock.timers.reset());
  const dataDir = dataDirFor(t);
  let clock = 1_800_000_000_000;
  const mono = 0;
  let reading = true;
  const runtime = createGoalRuntime({
    dataDir,
    now: () => clock,
    monotonicNow: () => (reading ? mono : null),
    suspendDetectable: true,
    deadlineWarningMs: [],
    generateTitle: null,
  });
  t.after(() => runtime.close());
  await runtime.control(SESSION, { action: 'create', objective: 'Gap in readings', duration: '2h' });
  // Twenty minutes pass with no monotonic reading: they are counted.
  reading = false;
  clock += 20 * MINUTE;
  assert.equal(runtime.snapshot(SESSION).timeUsedMs, 20 * MINUTE);
  // The reading returns while the monotonic clock never moved. Against the old
  // anchor that gap looks like a suspend and would erase the counted 20 minutes.
  reading = true;
  clock += MINUTE;
  assert.equal(runtime.snapshot(SESSION).timeUsedMs, 21 * MINUTE);
});

test('without suspend evidence (no usable monotonic clock) the time is counted', async (t) => {
  const dataDir = dataDirFor(t);
  let clock = 1_800_000_000_000;
  const runtime = createGoalRuntime({
    dataDir,
    now: () => clock,
    monotonicNow: () => 0,
    suspendDetectable: false,
    deadlineWarningMs: [],
    generateTitle: null,
  });
  t.after(() => runtime.close());
  await runtime.control(SESSION, { action: 'create', objective: 'Windows-like', duration: '30m' });
  clock += 6 * HOUR;
  assert.equal(runtime.snapshot(SESSION).status, 'duration_reached');
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

  // A starved heartbeat: five silent minutes later the file still reports what
  // it persisted; the late beat then records the stall as running time (an
  // awake stall is not suspend).
  clock += 5 * MINUTE;
  assert.equal(read(), 3 * MINUTE);
  mock.timers.tick(MINUTE);
  await runtime.control(SESSION, { action: 'get' });
  assert.equal(read(), 8.5 * MINUTE);
  await beatMinute();
  assert.equal(read(), 9.5 * MINUTE);

  // Closed: the open segment stays at what was persisted, however long it stays closed.
  await runtime.close();
  const persisted = read();
  assert.equal(persisted, 9.5 * MINUTE);
  assert.equal(read(clock + 30_000), persisted, 'closing immediately never charges downtime');
  assert.equal(read(clock + 2 * MINUTE), persisted);
  assert.equal(read(clock + 24 * HOUR), persisted);

  assert.deepEqual(
    reads,
    [...reads].sort((a, b) => a - b),
    'successive reads never go backward'
  );
});
