import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelPromptImmediateFlush,
  schedulePromptImmediateFlush,
} from '../src/tui/components/prompt-input/immediate-render.mjs';

test('active prompt input schedules an immediate render instead of lagging behind streaming frames', () => {
  const throttle = { lastAt: 0, timer: null };
  let queued = 0;
  let flushed = 0;

  const scheduled = schedulePromptImmediateFlush({
    throttle,
    flush: () => { flushed += 1; },
    now: () => 100,
    enqueue: () => { queued += 1; },
  });

  assert.equal(scheduled, true);
  assert.equal(throttle.timer, null);
  assert.equal(queued, 1);
  assert.equal(flushed, 0);
});

test('idle prompt input keeps one leading and one coalesced trailing immediate render', () => {
  const throttle = { lastAt: 0, timer: null };
  let current = 100;
  const queued = [];
  const timers = [];
  let flushed = 0;
  const options = {
    throttle,
    flush: () => { flushed += 1; },
    now: () => current,
    enqueue: (callback) => queued.push(callback),
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
  };

  assert.equal(schedulePromptImmediateFlush(options), true);
  assert.equal(queued.length, 1);
  queued.shift()();
  assert.equal(flushed, 1);

  current = 105;
  assert.equal(schedulePromptImmediateFlush(options), true);
  current = 106;
  assert.equal(schedulePromptImmediateFlush(options), false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 11);

  current = 116;
  timers[0].callback();
  assert.equal(flushed, 2);
  assert.equal(throttle.timer, null);
});

test('a pending trailing immediate render can still be cancelled explicitly', () => {
  const throttle = { lastAt: 100, timer: null };
  const cleared = [];

  schedulePromptImmediateFlush({
    throttle,
    flush: () => {},
    now: () => 105,
    setTimer: () => 7,
  });

  assert.equal(cancelPromptImmediateFlush(throttle, (timer) => cleared.push(timer)), true);
  assert.deepEqual(cleared, [7]);
  assert.equal(throttle.timer, null);
  assert.equal(cancelPromptImmediateFlush(throttle), false);
});
