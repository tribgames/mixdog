import '../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scheduler } from './scheduler.mjs';

// A scheduler instance without the constructor's schedule loading; only the
// fire path's collaborators are present.
function bareScheduler(overrides = {}) {
  const scheduler = Object.create(Scheduler.prototype);
  return Object.assign(
    scheduler,
    {
      running: new Set(),
      renaming: new Set(),
      oneShotTimers: new Map(),
      lastFired: new Map(),
      injectFn: null,
      injectReadyFn: null,
      notifyFailure() {},
      wrapPrompt: (name, prompt) => `[${name}] ${prompt}`,
    },
    overrides
  );
}

test('fireTimedPrompt skips a schedule whose previous run is still in progress and records the skip', async () => {
  const skips = [];
  const scheduler = bareScheduler({
    running: new Set(['daily']),
    persistSkip: async (name, at) => skips.push([name, at]),
    scheduleRunner: () => assert.fail('an overlapping fire must not start a run'),
  });
  const schedule = { name: 'daily' };
  const fired = await scheduler.fireTimedPrompt(schedule, 'non-interactive', 'p');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fired, false);
  assert.equal(skips.length, 1);
  assert.equal(skips[0][0], 'daily');
  assert.equal(schedule.lastSkippedAt, skips[0][1].toISOString());
});

test('a cron fire skipped by the run path counts as a skip, not a failed run', async () => {
  const scheduler = bareScheduler({
    cronJobs: new Map(),
    deferred: new Map(),
    scheduleRunner: async () => ({ skipped: true, sessionId: null, result: '' }),
  });
  const schedule = { name: 'daily', prompt: 'p' };
  const fired = await scheduler.fireTimedPrompt(schedule, 'non-interactive', 'p', { awaitDispatch: true });
  assert.equal(fired, false);
  assert.ok(schedule.lastSkippedAt, 'the skip is stamped on the schedule');
  assert.equal(scheduler.running.has('daily'), false);
});

test('an interactive fire enqueues into the Lead session when a seat is attached', async () => {
  const calls = [];
  const scheduler = bareScheduler({ injectFn: (...args) => calls.push(args) });
  const fired = await scheduler.fireTimedPrompt({ name: 'standup', model: 'm' }, 'interactive', 'prompt');
  assert.equal(fired, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['', 'schedule:standup', ' ']);
  assert.deepEqual(calls[0][3], { type: 'schedule', instruction: '[standup] prompt' });
  assert.equal(scheduler.running.has('standup'), false, 'an enqueue counts as the fire; nothing runs');
});

test('getStatus lists non-interactive then interactive schedules with their type and fire state', () => {
  const scheduler = new Scheduler(
    [
      { name: 'nightly', whenCron: '0 3 * * *', lastSuccessAt: 's1' },
      { name: 'off', enabled: false },
    ],
    [{ name: 'standup', whenAt: '2030-01-01T09:00:00Z', lastFiredAt: '2029-12-31T09:00:00Z' }],
    ''
  );
  scheduler.running.add('nightly');
  assert.deepEqual(scheduler.getStatus(), [
    {
      name: 'nightly',
      time: '0 3 * * *',
      type: 'non-interactive',
      running: true,
      lastFired: null,
      lastSuccess: 's1',
      lastFailed: null,
      nextFire: null,
    },
    {
      name: 'standup',
      time: '2030-01-01T09:00:00Z',
      type: 'interactive',
      running: false,
      lastFired: '2029-12-31T09:00:00.000Z',
      lastSuccess: null,
      lastFailed: null,
      nextFire: null,
    },
  ]);
});

test('triggerManual reports unknown, running, fired and non-fired schedules', async () => {
  const scheduler = new Scheduler([{ name: 'nightly' }], [{ name: 'standup' }], '');
  const fires = [];
  let outcome = true;
  scheduler.fireTimed = async (schedule, type) => {
    fires.push([schedule.name, type]);
    return outcome;
  };
  assert.equal(await scheduler.triggerManual('missing'), 'schedule "missing" not found');
  scheduler.running.add('nightly');
  assert.equal(await scheduler.triggerManual('nightly'), '"nightly" is already running');
  scheduler.running.clear();
  assert.equal(await scheduler.triggerManual('nightly'), 'triggered "nightly"');
  assert.match(scheduler.lastFired.get('nightly'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  outcome = false;
  assert.equal(await scheduler.triggerManual('standup'), '"standup" did not fire (skipped or already running)');
  assert.deepEqual(fires, [
    ['nightly', 'non-interactive'],
    ['standup', 'interactive'],
  ]);
});

test("a schedule needs no model: the fire goes to its run path (a turn in its bot's chat)", async () => {
  const runs = [];
  const scheduler = bareScheduler({
    scheduleRunner: async (schedule, opts) => {
      runs.push([schedule.name, opts.prompt]);
      return { sessionId: 'sess_home_lead', result: 'done' };
    },
  });
  const fired = await scheduler.fireTimedPrompt({ name: 'nomodel' }, 'non-interactive', 'p', { awaitDispatch: true });
  assert.equal(fired, true);
  assert.deepEqual(runs, [['nomodel', 'p']]);
  assert.equal(scheduler.running.has('nomodel'), false);
});

test('a fire whose bot is missing is a paused skip, never a failed run', async () => {
  const scheduler = bareScheduler({
    cronJobs: new Map(),
    deferred: new Map(),
    scheduleRunner: async () => ({ skipped: true, reason: 'owner', message: 'Create the representative bot first.' }),
  });
  const schedule = { name: 'briefing', prompt: 'p' };
  const fired = await scheduler.fireTimedPrompt(schedule, 'non-interactive', 'p', { awaitDispatch: true });
  assert.equal(fired, false);
  assert.ok(schedule.lastSkippedAt);
  assert.equal(schedule.lastFailedAt, undefined);
});

test('renameLocked refuses a schedule that is running or already being renamed, and releases the name after', async () => {
  const scheduler = bareScheduler({ running: new Set(['busy']) });
  let moved = 0;
  await assert.rejects(
    scheduler.renameLocked('busy', async () => moved++),
    /"busy" is running/
  );
  assert.equal(moved, 0, 'the row is never moved under a running schedule');
  let inner;
  await scheduler.renameLocked('idle', async () => {
    inner = scheduler.renameLocked('idle', async () => moved++).catch((error) => error.message);
    await inner;
  });
  assert.match(await inner, /is running/);
  assert.equal(scheduler.renaming.has('idle'), false, 'released once the rename settles');
  await scheduler.renameLocked('idle', async () => moved++);
  assert.equal(moved, 1);
});

test('a fire of a schedule being renamed does not start a run, and one that started is seen by the rename', async () => {
  const runs = [];
  const scheduler = bareScheduler({
    scheduleRunner: async (schedule) => runs.push(schedule.name) && { sessionId: 's', result: '' },
  });
  let fireDuring;
  await scheduler.renameLocked('daily', async () => {
    fireDuring = await scheduler.fireTimedPrompt({ name: 'daily' }, 'non-interactive', 'p');
  });
  assert.equal(fireDuring, false);
  assert.deepEqual(runs, []);
  assert.equal(scheduler.running.has('daily'), false);
  // The other order: the fire is already running when the rename asks.
  const release = Promise.withResolvers();
  const slow = bareScheduler({ scheduleRunner: () => release.promise });
  await slow.fireTimedPrompt({ name: 'daily' }, 'non-interactive', 'p');
  await assert.rejects(slow.renameLocked('daily', async () => {}), /is running/);
  release.resolve({ sessionId: 's', result: '' });
});

test('reloadConfig drops lastFired for names that no longer exist, so a reused name starts clean', () => {
  const scheduler = new Scheduler([{ name: 'old', whenCron: '0 3 * * *', lastFiredAt: '2030-01-01T00:00:00.000Z' }], []);
  scheduler.lastFired.set('old', '2030-01-02T00:00:00.000Z');
  scheduler.lastFired.set('kept', '2030-01-03T00:00:00.000Z');
  scheduler.reloadConfig([{ name: 'kept', whenCron: '0 4 * * *' }], [], { restart: false });
  assert.equal(scheduler.lastFired.has('old'), false);
  assert.equal(scheduler.lastFired.get('kept'), '2030-01-03T00:00:00.000Z');
  scheduler.reloadConfig([{ name: 'old', whenCron: '0 5 * * *' }, { name: 'kept', whenCron: '0 4 * * *' }], [], {
    restart: false,
  });
  assert.equal(scheduler.lastFired.has('old'), false, 'a reused name does not inherit the stale stamp');
  assert.equal(scheduler.getStatus().find((row) => row.name === 'old').lastFired, null);
});