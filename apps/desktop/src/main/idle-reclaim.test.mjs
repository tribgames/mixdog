import assert from "node:assert/strict";
import { test } from "node:test";

import { createIdleReclaim, purgeRendererMemory } from "./idle-reclaim.ts";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(overrides = {}) {
  const calls = [];
  const state = { focused: false };
  const reclaim = createIdleReclaim({
    delayMs: 0,
    isFocused: () => state.focused,
    reclaim: () => { calls.push(Date.now()); },
    ...overrides,
  });
  return { calls, state, reclaim };
}

test("releases once the unfocused window has stayed quiet", async () => {
  const { calls, reclaim } = harness();
  reclaim.onBlur();
  await tick();
  assert.equal(calls.length, 1);
});

test("keeps the heap while the window is focused", async () => {
  const { calls, state, reclaim } = harness();
  state.focused = true;
  reclaim.onBlur();
  await tick();
  assert.equal(calls.length, 0);
});

test("an unreadable window counts as focused", async () => {
  const { calls, reclaim } = harness({
    isFocused: () => { throw new Error("window is gone"); },
  });
  reclaim.onBlur();
  await tick();
  assert.equal(calls.length, 0);
});

test("never releases in the middle of a turn", async () => {
  const { calls, reclaim } = harness();
  reclaim.onSnapshot({ busy: true });
  reclaim.onBlur();
  await tick();
  assert.equal(calls.length, 0);
  // The turn ending re-arms the timer on the still-unfocused window.
  reclaim.onSnapshot({ busy: false });
  await tick();
  assert.equal(calls.length, 1);
});

test("releases once per quiet stretch", async () => {
  const { calls, reclaim } = harness();
  reclaim.onBlur();
  await tick();
  reclaim.onBlur();
  await tick();
  assert.equal(calls.length, 1);
  // Focus refills what was dropped, so the next background stretch earns one.
  reclaim.onFocus();
  reclaim.onBlur();
  await tick();
  assert.equal(calls.length, 2);
});

test("a fresh turn earns another release after it settles", async () => {
  const { calls, reclaim } = harness();
  reclaim.onBlur();
  await tick();
  assert.equal(calls.length, 1);
  reclaim.onSnapshot({ commandBusy: true });
  reclaim.onSnapshot({ commandBusy: false });
  await tick();
  assert.equal(calls.length, 2);
});

test("dispose cancels a pending release", async () => {
  const { calls, reclaim } = harness({ delayMs: 20 });
  reclaim.onBlur();
  reclaim.dispose();
  await tick(40);
  assert.equal(calls.length, 0);
});

test("purge drops renderer caches", async () => {
  const scripts = [];
  await purgeRendererMemory({
    isDestroyed: () => false,
    executeJavaScript: async (code) => { scripts.push(code); return true; },
  });
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].includes("mixdog:idle-reclaim"));
});

// Regression guard. Forcing a V8 purge through the debugger (CDP
// Memory.forciblyPurgeJavaScriptMemory) killed the renderer with
// ACCESS_VIOLATION every single time it fired, reloading the window under the
// user. The reclaim must never reach for the debugger again, so a target whose
// debugger traps on contact has to come through untouched.
test("purge never touches the debugger", async () => {
  const trap = () => { throw new Error("the reclaim must not use the debugger"); };
  await purgeRendererMemory({
    isDestroyed: () => false,
    executeJavaScript: async () => true,
    debugger: { isAttached: trap, attach: trap, detach: trap, sendCommand: trap },
  });
});

test("purge survives a document that went away mid-navigation", async () => {
  await purgeRendererMemory({
    isDestroyed: () => false,
    executeJavaScript: async () => { throw new Error("document is gone"); },
  });
});

test("purge skips a destroyed window", async () => {
  await purgeRendererMemory({
    isDestroyed: () => true,
    executeJavaScript: async () => { throw new Error("unreachable"); },
  });
});
