import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelPromptImmediateFlush,
  schedulePromptImmediateFlush,
} from '../src/tui/components/prompt-input/immediate-render.mjs';

test('busy prompt input cancels a pending immediate render and schedules nothing', () => {
  const throttle = { lastAt: 90, timer: 7 };
  const cleared = [];
  let queued = 0;
  let flushed = 0;

  const scheduled = schedulePromptImmediateFlush({
    throttle,
    isSuppressed: true,
    flush: () => { flushed += 1; },
    now: () => 100,
    enqueue: () => { queued += 1; },
    clearTimer: (timer) => cleared.push(timer),
  });

  assert.equal(scheduled, false);
  assert.equal(throttle.timer, null);
  assert.deepEqual(cleared, [7]);
  assert.equal(queued, 0);
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
    isSuppressed: false,
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

test('a trailing immediate render is dropped if the turn becomes busy', () => {
  const throttle = { lastAt: 100, timer: null };
  let busy = false;
  let timerCallback;
  let flushed = 0;

  schedulePromptImmediateFlush({
    throttle,
    isSuppressed: () => busy,
    flush: () => { flushed += 1; },
    now: () => 105,
    setTimer: (callback) => {
      timerCallback = callback;
      return 1;
    },
  });
  busy = true;
  timerCallback();

  assert.equal(flushed, 0);
  assert.equal(throttle.timer, null);
  assert.equal(cancelPromptImmediateFlush(throttle), false);
});
