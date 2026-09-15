import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAccountUsageWindows,
  getUsageDashboardSnapshot,
  holdUsageDashboardCadence,
  publishUsageDashboard,
  refreshUsageDashboard,
  refreshUsageDashboardAfterAuth,
  subscribeUsageDashboard,
  USAGE_DASHBOARD_CACHE_KEY as CACHE_KEY,
  USAGE_DASHBOARD_REFRESH_INTERVAL_MS as INTERVAL,
  USAGE_DASHBOARD_REQUEST_TIMEOUT_MS as TIMEOUT,
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

test("usage refresh uses value-only reads without changing provider refresh arguments", async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  const requests = [];
  const api = {
    async readCapabilities(batch) {
      requests.push(batch);
      return [{ ok: true, value: response.value }];
    },
    invokeCapability() { assert.fail("The unused control snapshot must not be requested."); },
  };
  await refreshUsageDashboard(api, { force: true, providers: ["openai-oauth"] });
  assert.deepEqual(requests, [[{
    capability: "getUsageDashboard",
    args: [{ refresh: true, refreshSetup: false, refreshProviders: ["openai-oauth"] }],
  }]]);
  assert.equal(getUsageDashboardSnapshot().status, "ready");
  assert.deepEqual(getUsageDashboardSnapshot().dashboard, response.value);
});

const oldAccount = {
  id: "openai-oauth", label: "Codex", group: "oauth", authenticated: true,
  windows: [{ label: "7D", usedPct: 39 }],
  resetCredits: { availableCount: 2, offerRevision: "old-account:offer" },
  primary: "39%", remaining: 61, updatedAt: 100,
};
const otherProvider = {
  id: "anthropic-oauth", group: "oauth", authenticated: true,
  windows: [{ label: "7D", usedPct: 3 }],
};
const switchedRow = () => getUsageDashboardSnapshot().dashboard.rows[0];

for (const oldFirst of [true, false]) {
  test(`account switching immediately refreshes without accepting old responses (${oldFirst ? "old first" : "old last"})`, async (t) => {
    const clock = createRendererClock();
    bind(t, clock);
    publishUsageDashboard({ rows: [oldAccount, otherProvider] });
    const requests = [];
    const api = { invokeCapability(args) {
      return new Promise((resolve) => { requests.push({ args, resolve }); });
    } };
    const previous = refreshUsageDashboard(api, { force: true });
    assert.equal(applyAccountUsageWindows("openai-oauth", undefined), true);
    const current = refreshUsageDashboardAfterAuth(api, ["openai-oauth"]);
    assert.equal(requests.length, 2, "account switching bypasses both the fresh cache and the old pending request");
    assert.deepEqual(requests[1].args.args[0], {
      refresh: true, refreshSetup: false, refreshProviders: ["openai-oauth"],
    });
    const waiting = {
      id: "openai-oauth", label: "Codex", group: "oauth", authenticated: true,
      windows: [], status: "checking", updatedAt: null,
    };
    assert.deepEqual(switchedRow(), waiting);
    assert.deepEqual(getUsageDashboardSnapshot().dashboard.rows[1], otherProvider);
    assert.deepEqual(JSON.parse(clock.storage.get(CACHE_KEY)).rows[0], waiting);
    if (oldFirst) {
      requests[0].resolve({ value: { rows: [oldAccount, otherProvider] } });
      await previous;
      assert.deepEqual(switchedRow(), waiting, "an old response cannot end the new account's loading state");
    }
    const fresh = {
      id: "openai-oauth", group: "oauth", authenticated: true,
      windows: [{ label: "7D", usedPct: 12 }],
    };
    requests[1].resolve({ value: { rows: [fresh, otherProvider] } });
    await current;
    if (!oldFirst) {
      requests[0].resolve({ value: { rows: [oldAccount, otherProvider] } });
      await previous;
    }
    assert.deepEqual(switchedRow(), fresh);
    assert.deepEqual(JSON.parse(clock.storage.get(CACHE_KEY)).rows, [fresh, otherProvider]);
  });
}

for (const failure of ["offline", "timeout", "empty", "malformed", "missing-api"]) {
  test(`an account usage check settles safely after ${failure}`, async (t) => {
    const clock = createRendererClock();
    bind(t, clock);
    publishUsageDashboard({ rows: [oldAccount, otherProvider] });
    applyAccountUsageWindows("openai-oauth", undefined);
    let lateResolve;
    const api = failure === "missing-api" ? {} : { invokeCapability() {
      if (failure === "timeout") return new Promise((resolve) => { lateResolve = resolve; });
      if (failure === "offline") return Promise.reject(new Error("offline"));
      return Promise.resolve({ value: failure === "empty" ? { rows: [] } : {} });
    } };
    const request = refreshUsageDashboardAfterAuth(api, ["openai-oauth"]);
    if (failure === "timeout") await clock.advance(TIMEOUT);
    await request;
    assert.equal(switchedRow().status, "unavailable");
    assert.deepEqual(switchedRow().windows, []);
    assert.equal(switchedRow().resetCredits, undefined);
    assert.deepEqual(getUsageDashboardSnapshot().dashboard.rows[1], otherProvider);
    assert.equal(JSON.parse(clock.storage.get(CACHE_KEY)).rows[0].status, "unavailable");
    if (lateResolve) {
      lateResolve({ value: { rows: [oldAccount] } });
      await clock.settle();
      assert.equal(switchedRow().status, "unavailable", "a timed-out result cannot restore stale quotas");
    }
    assert.equal(clock.timers.size, 0);
  });
}

test("known windows belong to the chosen account, but reset credits never carry across", async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  publishUsageDashboard({ rows: [oldAccount, otherProvider] });
  const refreshedAt = getUsageDashboardSnapshot().refreshedAt;
  const windows = [{ label: "7D", usedPct: 12 }];
  applyAccountUsageWindows("openai-oauth", windows);
  assert.deepEqual(switchedRow().windows, windows);
  assert.equal(switchedRow().resetCredits, undefined);
  assert.equal(getUsageDashboardSnapshot().refreshedAt, refreshedAt);
  // A popup reopening after retirement must revalidate the pending switch,
  // even though the dashboard's previous live timestamp is still recent.
  let calls = 0;
  await refreshUsageDashboard({ async invokeCapability() {
    calls += 1;
    throw new Error("offline");
  } });
  assert.equal(calls, 1);
  assert.equal(switchedRow().status, "partial");
  assert.deepEqual(switchedRow().windows, windows);
});

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
