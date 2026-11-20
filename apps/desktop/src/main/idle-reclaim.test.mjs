import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { attachWindowIdleReclaim, createIdleReclaim, purgeRendererMemory } from './idle-reclaim.ts';

// The release is a pure logic timer, so the tests drive it with mock timers
// instead of sleeping on the real clock.
const elapse = (t, ms = 1) => t.mock.timers.tick(ms);

function harness(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const state = { focused: false };
  const reclaim = createIdleReclaim({
    delayMs: 0,
    isFocused: () => state.focused,
    reclaim: () => {
      calls.push(Date.now());
    },
    ...overrides,
  });
  return { calls, state, reclaim };
}

test('releases once the unfocused window has stayed quiet', async (t) => {
  const { calls, reclaim } = harness(t);
  reclaim.onBlur();
  elapse(t);
  assert.equal(calls.length, 1);
});

test('keeps the heap while the window is focused', async (t) => {
  const { calls, state, reclaim } = harness(t);
  state.focused = true;
  reclaim.onBlur();
  elapse(t);
  assert.equal(calls.length, 0);
});

test('an unreadable window counts as focused', async (t) => {
  const { calls, reclaim } = harness(t, {
    isFocused: () => {
      throw new Error('window is gone');
    },
  });
  reclaim.onBlur();
  elapse(t);
  assert.equal(calls.length, 0);
});

test('a focused window the user walked away from is released by system idle time', async (t) => {
  const idle = { ms: 0 };
  const { calls, state, reclaim } = harness(t, { delayMs: 100, pollMs: 10, systemIdleMs: () => idle.ms });
  // The machine's idle time grows with the clock until the user touches it.
  const away = (ms) => {
    for (let passed = 0; passed < ms; passed += 10) {
      idle.ms += 10;
      elapse(t, 10);
    }
  };
  state.focused = true;
  for (let i = 0; i < 5; i += 1) {
    idle.ms = 0;
    elapse(t, 10);
  }
  assert.equal(calls.length, 0, 'a present user is untouched');
  away(100);
  assert.equal(calls.length, 1);
  away(200);
  assert.equal(calls.length, 1, 'one release per quiet stretch');
  idle.ms = 0;
  away(100);
  assert.equal(calls.length, 2);
  reclaim.dispose();
});

test('a release by the blur timer is not repeated by the idle poll in the same quiet stretch', async (t) => {
  const idle = { ms: 0 };
  const { calls, reclaim } = harness(t, { delayMs: 100, pollMs: 30, systemIdleMs: () => idle.ms });
  const pass = (ms) => {
    for (let passed = 0; passed < ms; passed += 10) {
      idle.ms += 10;
      elapse(t, 10);
    }
  };
  reclaim.onBlur();
  pass(90);
  idle.ms = 0; // the user's last input elsewhere, just before the release
  pass(10);
  assert.equal(calls.length, 1, 'the blur timer released');
  pass(200);
  assert.equal(calls.length, 1);
  reclaim.dispose();
});

test('releases once per quiet stretch', async (t) => {
  const { calls, reclaim } = harness(t);
  reclaim.onBlur();
  elapse(t);
  reclaim.onBlur();
  elapse(t);
  assert.equal(calls.length, 1);
  // Focus refills what was dropped, so the next background stretch earns one.
  reclaim.onFocus();
  reclaim.onBlur();
  elapse(t);
  assert.equal(calls.length, 2);
});

test('dispose cancels a pending release', async (t) => {
  const { calls, reclaim } = harness(t, { delayMs: 20 });
  reclaim.onBlur();
  reclaim.dispose();
  elapse(t, 40);
  assert.equal(calls.length, 0);
});

test('closing the window retires its reclaim controller without affecting a replacement', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  function attach(name) {
    const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocused: () => false });
    const controller = attachWindowIdleReclaim(window, { delayMs: 20, reclaim: () => calls.push(name) });
    window.emit('blur');
    return { window, controller };
  }
  const first = attach('first');
  const second = attach('second');
  first.window.emit('closed');
  elapse(t, 20);
  assert.deepEqual(calls, ['second']);

  first.controller.onBlur();
  elapse(t, 20);
  assert.deepEqual(calls, ['second'], 'a late event cannot rearm the closed window');
});

test('purge drops renderer caches', async () => {
  const scripts = [];
  await purgeRendererMemory({
    isDestroyed: () => false,
    executeJavaScript: async (code) => {
      scripts.push(code);
      return true;
    },
  });
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].includes('mixdog:idle-reclaim'));
});

// Regression guard. Forcing a V8 purge through the debugger (CDP
// Memory.forciblyPurgeJavaScriptMemory) killed the renderer with
// ACCESS_VIOLATION every single time it fired, reloading the window under the
// user. The reclaim must never reach for the debugger again, so a target whose
// debugger traps on contact has to come through untouched.
test('purge never touches the debugger', async () => {
  const trap = () => {
    throw new Error('the reclaim must not use the debugger');
  };
  await purgeRendererMemory({
    isDestroyed: () => false,
    executeJavaScript: async () => true,
    debugger: { isAttached: trap, attach: trap, detach: trap, sendCommand: trap },
  });
});

test('purge survives a document that went away mid-navigation', async () => {
  let attempts = 0;
  await purgeRendererMemory({
    isDestroyed: () => false,
    executeJavaScript: async () => {
      attempts += 1;
      throw new Error('document is gone');
    },
  });
  assert.equal(attempts, 1);
});

test('purge skips a destroyed window', async () => {
  let attempts = 0;
  await purgeRendererMemory({
    isDestroyed: () => true,
    executeJavaScript: async () => {
      attempts += 1;
      throw new Error('unreachable');
    },
  });
  assert.equal(attempts, 0);
});
