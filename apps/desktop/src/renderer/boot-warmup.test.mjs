import assert from "node:assert/strict";
import test from "node:test";
import {
  _bootWarmupPendingForTest,
  _noteBootWarmupInputForTest,
  _resetBootWarmupForTest,
  armBootWarmup,
  scheduleBootWarmup,
} from "./boot-warmup.ts";

/** Deterministic idle host: every idle/timer callback is a manual tick. */
function fakeHost() {
  const callbacks = new Map();
  let next = 1;
  return {
    host: {
      requestIdleCallback(callback) { callbacks.set(next, callback); return next++; },
      cancelIdleCallback(handle) { callbacks.delete(handle); },
      setTimeout(callback) { callbacks.set(next, callback); return next++; },
      clearTimeout(handle) { callbacks.delete(handle); },
    },
    tick() {
      const [handle, callback] = callbacks.entries().next().value ?? [];
      if (handle === undefined) return false;
      callbacks.delete(handle);
      callback();
      return true;
    },
    pending: () => callbacks.size,
  };
}

test("tasks stay parked until the lane is armed, then run lowest priority first", async () => {
  const clock = fakeHost();
  _resetBootWarmupForTest(clock.host);
  const ran = [];
  scheduleBootWarmup({ id: "settings", priority: 80, run: () => ran.push("settings") });
  scheduleBootWarmup({ id: "sidebar", priority: 20, run: () => ran.push("sidebar") });
  scheduleBootWarmup({ id: "dock", priority: 40, run: () => ran.push("dock") });
  assert.equal(clock.pending(), 0, "nothing is scheduled before arming");
  armBootWarmup();
  // idle → task → gap → idle → task … one task per idle slice.
  clock.tick(); // idle: sidebar
  assert.deepEqual(ran, ["sidebar"]);
  clock.tick(); // gap
  clock.tick(); // idle: dock
  assert.deepEqual(ran, ["sidebar", "dock"]);
  clock.tick();
  clock.tick();
  assert.deepEqual(ran, ["sidebar", "dock", "settings"]);
  assert.deepEqual(_bootWarmupPendingForTest(), []);
});

test("an async task holds the lane until it settles; re-scheduling an id replaces it", async () => {
  const clock = fakeHost();
  _resetBootWarmupForTest(clock.host);
  armBootWarmup();
  let release;
  const ran = [];
  scheduleBootWarmup({ id: "slow", priority: 10, run: () => new Promise((resolve) => { release = resolve; }) });
  scheduleBootWarmup({ id: "later", priority: 20, run: () => ran.push("later-v1") });
  scheduleBootWarmup({ id: "later", priority: 20, run: () => ran.push("later-v2") });
  clock.tick(); // idle: slow starts
  assert.equal(clock.pending(), 0, "no idle request while a task is in flight");
  release();
  await Promise.resolve();
  await Promise.resolve();
  clock.tick(); // gap
  clock.tick(); // idle: later (replaced version only)
  assert.deepEqual(ran, ["later-v2"]);
});

test("recent input defers the next task instead of running it in the idle slice", () => {
  const clock = fakeHost();
  _resetBootWarmupForTest(clock.host);
  armBootWarmup();
  const ran = [];
  scheduleBootWarmup({ id: "mount", priority: 1, run: () => ran.push("mount") });
  _noteBootWarmupInputForTest(Date.now());
  clock.tick(); // idle slice arrives right after a keystroke → deferred
  assert.deepEqual(ran, []);
  _noteBootWarmupInputForTest(Date.now() - 10_000);
  clock.tick(); // the quiet timer → pump → idle
  clock.tick(); // idle: runs now that input is old
  assert.deepEqual(ran, ["mount"]);
});

test("an arm delay parks the first task until the delay elapses", () => {
  const clock = fakeHost();
  _resetBootWarmupForTest(clock.host);
  const ran = [];
  scheduleBootWarmup({ id: "a", priority: 1, run: () => ran.push("a") });
  armBootWarmup(600);
  assert.equal(clock.pending(), 1, "only the delay timer is armed");
  clock.tick(); // delay → pump → idle
  clock.tick(); // idle: a
  assert.deepEqual(ran, ["a"]);
});

test("cancelling a pending task removes it without disturbing the lane", () => {
  const clock = fakeHost();
  _resetBootWarmupForTest(clock.host);
  armBootWarmup();
  const ran = [];
  const cancel = scheduleBootWarmup({ id: "a", priority: 1, run: () => ran.push("a") });
  scheduleBootWarmup({ id: "b", priority: 2, run: () => ran.push("b") });
  cancel();
  clock.tick();
  assert.deepEqual(ran, ["b"]);
  _resetBootWarmupForTest();
});
