import assert from "node:assert/strict";
import test from "node:test";
import {
  getUsageDashboardSnapshot,
  holdUsageDashboardCadence,
  refreshUsageDashboard,
  subscribeUsageDashboard,
  USAGE_DASHBOARD_REFRESH_INTERVAL_MS as INTERVAL,
  USAGE_DASHBOARD_RETRY_DELAY_MS as RETRY,
} from "./usage-dashboard-store.ts";
import { createRendererClock } from "../../scripts/test-renderer-clock.mjs";

function bind(t, clock) {
  const win = Object.getOwnPropertyDescriptor(globalThis, "window");
  const now = Date.now;
  Object.defineProperty(globalThis, "window", { configurable: true, value: clock.win });
  Date.now = () => clock.now;
  t.after(() => {
    Date.now = now;
    if (win) Object.defineProperty(globalThis, "window", win);
    else delete globalThis.window;
    getUsageDashboardSnapshot();
  });
}
const response = { value: { rows: [{ id: "provider", authenticated: true }] } };

test("usage polling pauses while hidden, revalidates stale data on return and keeps explicit refresh", async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  let calls = 0;
  const api = { async invokeCapability() { calls += 1; return response; } };
  const release = holdUsageDashboardCadence(api);
  await refreshUsageDashboard(api);
  assert.equal(calls, 1);
  clock.visibility("hidden");
  await clock.advance(INTERVAL * 3);
  assert.equal(calls, 1);
  assert.equal(clock.timers.size, 0);
  clock.visibility("visible");
  await clock.settle();
  assert.equal(calls, 2);
  clock.visibility("hidden");
  await refreshUsageDashboard(api, { force: true });
  assert.equal(calls, 3, "auth/manual refresh is not a background poll");
  release();
  await clock.settle();
  assert.equal(clock.timers.size + clock.doc.listenerCount() + clock.win.listenerCount(), 0);
});

test("a hidden failed request does not start a retry, and returning recovers", async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  let reject;
  let calls = 0;
  const gate = new Promise((_, no) => { reject = no; });
  const api = { invokeCapability() { calls += 1; return calls === 1 ? gate : Promise.resolve(response); } };
  const release = holdUsageDashboardCadence(api);
  const request = refreshUsageDashboard(api);
  clock.visibility("hidden");
  reject(new Error("offline"));
  await request;
  await clock.advance(RETRY * 2);
  assert.equal(calls, 1);
  assert.equal(clock.timers.size, 0);
  clock.visibility("visible");
  await clock.settle();
  assert.equal(calls, 2);
  assert.equal(getUsageDashboardSnapshot().status, "ready");
  release();
  await clock.settle();
});

test("an old document's holder cannot stop the replacement document's cadence", async (t) => {
  const old = createRendererClock();
  bind(t, old);
  const releaseOld = holdUsageDashboardCadence({ async invokeCapability() { return response; } });
  const fresh = createRendererClock();
  Object.defineProperty(globalThis, "window", { configurable: true, value: fresh.win });
  let calls = 0;
  const releaseFresh = holdUsageDashboardCadence({
    async invokeCapability() { calls += 1; return response; },
  });
  releaseOld();
  await fresh.settle();
  await fresh.advance(INTERVAL);
  assert.equal(calls, 1);
  assert.equal(old.timers.size + old.doc.listenerCount() + old.win.listenerCount(), 0);
  releaseFresh();
  await fresh.settle();
  assert.equal(fresh.timers.size + fresh.doc.listenerCount() + fresh.win.listenerCount(), 0);
});

test("repeated usage popup lifetimes release listeners and do not multiply refresh cadences", async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  let calls = 0;
  const api = { async invokeCapability() { calls += 1; return response; } };
  for (let index = 0; index < 2_000; index += 1) {
    const release = holdUsageDashboardCadence(api);
    const unsubscribe = subscribeUsageDashboard(() => {});
    unsubscribe();
    release();
    await clock.settle();
  }
  await clock.advance(INTERVAL);
  assert.equal(calls, 0);
  assert.equal(clock.timers.size + clock.doc.listenerCount() + clock.win.listenerCount(), 0);
});
