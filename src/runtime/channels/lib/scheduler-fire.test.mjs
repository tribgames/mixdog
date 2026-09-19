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

test('a schedule without a model is rejected before any dispatch', async () => {
  const notices = [];
  const scheduler = bareScheduler({ notifyFailure: (_schedule, message) => notices.push(message) });
  const fired = await scheduler.fireTimedPrompt({ name: 'nomodel' }, 'non-interactive', 'p', null);
  assert.equal(fired, false);
  assert.equal(scheduler.running.has('nomodel'), false);
  assert.match(notices[0], /missing "model"/);
});
