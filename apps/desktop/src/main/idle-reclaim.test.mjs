import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIdleReclaim, purgeRendererMemory } from './idle-reclaim.ts';

// The release is a pure logic timer, so the tests drive it with mock timers
// instead of sleeping on the real clock.
const elapse = (t, ms = 1) => t.mock.timers.tick(ms);

function harness(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
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

test('never releases in the middle of a turn', async (t) => {
  const { calls, reclaim } = harness(t);
  reclaim.onSnapshot({ busy: true });
  reclaim.onBlur();
  elapse(t);
  assert.equal(calls.length, 0);
  // The turn ending re-arms the timer on the still-unfocused window.
  reclaim.onSnapshot({ busy: false });
  elapse(t);
  assert.equal(calls.length, 1);
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

test('a fresh turn earns another release after it settles', async (t) => {
  const { calls, reclaim } = harness(t);
  reclaim.onBlur();
  elapse(t);
  assert.equal(calls.length, 1);
  reclaim.onSnapshot({ commandBusy: true });
  reclaim.onSnapshot({ commandBusy: false });
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
