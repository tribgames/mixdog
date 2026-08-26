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

test("purge drops renderer caches and shrinks the V8 heap", async () => {
  const commands = [];
  const scripts = [];
  let attached = false;
  await purgeRendererMemory({
    isDestroyed: () => false,
    executeJavaScript: async (code) => { scripts.push(code); return true; },
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      detach: () => { attached = false; },
      sendCommand: async (method) => { commands.push(method); },
    },
  });
  assert.ok(scripts[0].includes("mixdog:idle-reclaim"));
  assert.deepEqual(commands, ["Memory.forciblyPurgeJavaScriptMemory"]);
  assert.equal(attached, false, "the debugger session must not be left attached");
});

test("purge stays silent when DevTools owns the debugger", async () => {
  const scripts = [];
  await purgeRendererMemory({
    isDestroyed: () => false,
    executeJavaScript: async (code) => { scripts.push(code); return true; },
    debugger: {
      isAttached: () => false,
      attach: () => { throw new Error("Another debugger is already attached"); },
      detach: () => { throw new Error("not attached"); },
      sendCommand: async () => { throw new Error("unreachable"); },
    },
  });
  // The cache drop still ran; only the heap-shrink leg was unavailable.
  assert.equal(scripts.length, 1);
});

test("purge skips a destroyed window", async () => {
  await purgeRendererMemory({
    isDestroyed: () => true,
    executeJavaScript: async () => { throw new Error("unreachable"); },
    debugger: {
      isAttached: () => { throw new Error("unreachable"); },
      attach: () => { throw new Error("unreachable"); },
      detach: () => {},
      sendCommand: async () => { throw new Error("unreachable"); },
    },
  });
});
