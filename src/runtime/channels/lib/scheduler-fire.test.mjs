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
      oneShotTimers: new Map(),
      lastFired: new Map(),
      injectFn: null,
      injectReadyFn: null,
      sendFn: null,
      notifyFailure() {},
      wrapPrompt: (name, prompt) => `[${name}] ${prompt}`,
    },
    overrides
  );
}

test('fireTimedPrompt skips a schedule whose previous run is still in progress', async () => {
  const scheduler = bareScheduler({ running: new Set(['daily']) });
  const fired = await scheduler.fireTimedPrompt({ name: 'daily', model: 'm' }, 'non-interactive', 'p', null);
  assert.equal(fired, false);
});

test('an interactive fire enqueues into the Lead session when a seat is attached', async () => {
  const calls = [];
  const scheduler = bareScheduler({ injectFn: (...args) => calls.push(args) });
  const fired = await scheduler.fireTimedPrompt({ name: 'standup', model: 'm' }, 'interactive', 'prompt', 'chan');
  assert.equal(fired, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['chan', 'schedule:standup', ' ']);
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

test('a schedule without a model is rejected before any dispatch', async () => {
  const notices = [];
  const scheduler = bareScheduler({ notifyFailure: (_schedule, message) => notices.push(message) });
  const fired = await scheduler.fireTimedPrompt({ name: 'nomodel' }, 'non-interactive', 'p', null);
  assert.equal(fired, false);
  assert.equal(scheduler.running.has('nomodel'), false);
  assert.match(notices[0], /missing "model"/);
});
