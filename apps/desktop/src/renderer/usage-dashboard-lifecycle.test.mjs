import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAccountUsageWindows,
  getUsageDashboardSnapshot,
  holdUsageDashboardCadence,
  publishUsageDashboard,
  refreshUsageDashboard,
  refreshUsageDashboardAfterAuth,
  subscribeUsageDashboard,
  USAGE_DASHBOARD_CACHE_KEY as CACHE_KEY,
  USAGE_DASHBOARD_REQUEST_TIMEOUT_MS as TIMEOUT,
  USAGE_DASHBOARD_RETRY_DELAY_MS as RETRY,
} from './usage-dashboard-store.ts';
import { createRendererClock } from '../../scripts/test-renderer-clock.mjs';
/** Node b6f10295a pplyStageChange (tui/session/turn-stream.mjs) for the one stage this test sends: a selection change is UI state,
 *  published as providerAccountChange, never a spinner phase or a transcript item. */
async function applyStageChange(stream, stage, detail) {
  assert.equal(stage, 'account-changed');
  stream.set({ providerAccountChange: detail });
}

function bind(t, clock) {
  const win = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const now = Date.now;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: clock.win });
  Date.now = () => clock.now;
  t.after(() => {
    Date.now = now;
    if (win) Object.defineProperty(globalThis, 'window', win);
    else delete globalThis.window;
    getUsageDashboardSnapshot();
  });
}
const response = { value: { rows: [{ id: 'provider', authenticated: true }] } };

test('usage refresh uses value-only reads without changing provider refresh arguments', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  const requests = [];
  const api = {
    async readCapabilities(batch) {
      requests.push(batch);
      return [{ ok: true, value: response.value }];
    },
    invokeCapability() {
      assert.fail('The unused control snapshot must not be requested.');
    },
  };
  await refreshUsageDashboard(api, { force: true, providers: ['openai-oauth'] });
  assert.deepEqual(requests, [
    [
      {
        capability: 'getUsageDashboard',
        args: [{ refresh: true, refreshSetup: false, refreshProviders: ['openai-oauth'] }],
      },
    ],
  ]);
  assert.equal(getUsageDashboardSnapshot().status, 'ready');
  assert.deepEqual(getUsageDashboardSnapshot().dashboard, response.value);
});

const oldAccount = {
  id: 'openai-oauth',
  label: 'Codex',
  group: 'oauth',
  authenticated: true,
  windows: [{ label: '7D', usedPct: 39 }],
  resetCredits: { availableCount: 2, offerRevision: 'old-account:offer' },
  primary: '39%',
  remaining: 61,
  updatedAt: 100,
};
const otherProvider = {
  id: 'anthropic-oauth',
  group: 'oauth',
  authenticated: true,
  windows: [{ label: '7D', usedPct: 3 }],
};
const switchedRow = () => getUsageDashboardSnapshot().dashboard.rows[0];

for (const oldFirst of [true, false]) {
  test(`automatic account changes synchronize usage and reject old responses (${oldFirst ? 'old first' : 'old last'})`, async (t) => {
    const clock = createRendererClock();
    bind(t, clock);
    const exhausted = { ...otherProvider, windows: [{ label: '7D Fable', usedPct: 100 }] };
    const fresh = { ...otherProvider, windows: [{ label: '7D Fable', usedPct: 8 }] };
    publishUsageDashboard({ rows: [oldAccount, exhausted] });
    const states = new Set();
    const sessions = new Set();
    const requests = [];
    const api = {
      subscribeState(listener) {
        states.add(listener);
        return () => states.delete(listener);
      },
      subscribeSessionState(listener) {
        sessions.add(listener);
        return () => sessions.delete(listener);
      },
      invokeCapability(args) {
        return new Promise((resolve) => requests.push({ args, resolve }));
      },
    };
    const release = holdUsageDashboardCadence(api);
    const prior = refreshUsageDashboard(api, { force: true });
    const spinner = oldFirst ? null : { mode: 'responding' };
    let state = { spinner };
    const stream = {
      getState: () => state,
      set(patch) {
        state = { ...state, ...patch };
        for (const listener of states) listener(state);
        for (const listener of sessions) listener({ sessionId: 'lead', snapshot: state, frameSource: 'live' });
      },
    };
    await applyStageChange(stream, 'account-changed', {
      provider: 'anthropic-oauth',
      accountId: 'new-account',
      at: clock.now,
    });
    assert.equal(state.spinner, spinner, 'account changes do not change the turn phase');
    assert.equal(requests.length, 2, 'both state lanes share one immediate refresh');
    assert.deepEqual(requests[1].args.args[0].refreshProviders, ['anthropic-oauth']);
    assert.deepEqual(getUsageDashboardSnapshot().dashboard.rows[0], oldAccount);
    assert.deepEqual(getUsageDashboardSnapshot().dashboard.rows[1].windows, []);
    assert.equal(getUsageDashboardSnapshot().dashboard.rows[1].status, 'checking');
    if (oldFirst) {
      requests[0].resolve({ value: { rows: [oldAccount, exhausted] } });
      await prior;
      assert.deepEqual(getUsageDashboardSnapshot().dashboard.rows[1].windows, []);
    }
    requests[1].resolve({ value: { rows: [oldAccount, fresh] } });
    await clock.settle();
    if (!oldFirst) {
      requests[0].resolve({ value: { rows: [oldAccount, exhausted] } });
      await prior;
    }
    assert.deepEqual(getUsageDashboardSnapshot().dashboard.rows, [oldAccount, fresh]);
    assert.deepEqual(JSON.parse(clock.storage.get(CACHE_KEY)).rows, [oldAccount, fresh]);
    for (const listener of states) listener(state);
    for (const listener of sessions) {
      listener({
        sessionId: 'older-session',
        snapshot: { providerAccountChange: { provider: 'anthropic-oauth', accountId: 'old', at: clock.now - 1 } },
        frameSource: 'replay',
      });
    }
    assert.equal(requests.length, 2, 'repeated and older frames cannot restart an account check');
    const retiredListener = [...states][0];
    release();
    await clock.settle();
    assert.equal(states.size, 0);
    assert.equal(sessions.size, 0);
    retiredListener({
      providerAccountChange: { provider: 'anthropic-oauth', accountId: 'late', at: clock.now + 1 },
    });
    assert.equal(requests.length, 2);
    assert.equal(clock.timers.size, 0);
  });
}

test('automatic account subscriptions move to the current host API', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  publishUsageDashboard({ rows: [oldAccount] });
  const makeApi = () => {
    const callbacks = new Set();
    let calls = 0;
    return {
      callbacks,
      get calls() {
        return calls;
      },
      subscribeState(listener) {
        callbacks.add(listener);
        return () => callbacks.delete(listener);
      },
      async invokeCapability() {
        calls += 1;
        return { value: { rows: [oldAccount] } };
      },
    };
  };
  const oldApi = makeApi();
  const newApi = makeApi();
  const releaseOld = holdUsageDashboardCadence(oldApi);
  const oldListener = [...oldApi.callbacks][0];
  const releaseNew = holdUsageDashboardCadence(newApi);
  assert.equal(oldApi.callbacks.size, 0);
  assert.equal(newApi.callbacks.size, 1);
  const state = { providerAccountChange: { provider: 'openai-oauth', accountId: 'b', at: clock.now } };
  oldListener(state);
  for (const listener of newApi.callbacks) listener(state);
  await clock.settle();
  assert.equal(oldApi.calls, 0);
  assert.equal(newApi.calls, 1);
  releaseOld();
  releaseNew();
  await clock.settle();
  assert.equal(newApi.callbacks.size, 0);
});

for (const oldFirst of [true, false]) {
  test(`account switching immediately refreshes without accepting old responses (${oldFirst ? 'old first' : 'old last'})`, async (t) => {
    const clock = createRendererClock();
    bind(t, clock);
    publishUsageDashboard({ rows: [oldAccount, otherProvider] });
    const requests = [];
    const api = {
      invokeCapability(args) {
        return new Promise((resolve) => {
          requests.push({ args, resolve });
        });
      },
    };
    const previous = refreshUsageDashboard(api, { force: true });
    await clock.settle();
    assert.equal(applyAccountUsageWindows('openai-oauth', undefined), true);
    const current = refreshUsageDashboardAfterAuth(api, ['openai-oauth']);
    await clock.settle();
    assert.equal(requests.length, 2, 'account switching bypasses both the fresh cache and the old pending request');
    assert.deepEqual(requests[1].args.args[0], {
      refresh: true,
      refreshSetup: false,
      refreshProviders: ['openai-oauth'],
    });
    const waiting = {
      id: 'openai-oauth',
      label: 'Codex',
      group: 'oauth',
      authenticated: true,
      windows: [],
      status: 'checking',
      updatedAt: null,
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
      id: 'openai-oauth',
      group: 'oauth',
      authenticated: true,
      windows: [{ label: '7D', usedPct: 12 }],
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

for (const failure of ['offline', 'timeout', 'empty', 'malformed', 'missing-api']) {
  test(`an account usage check settles safely after ${failure}`, async (t) => {
    const clock = createRendererClock();
    bind(t, clock);
    publishUsageDashboard({ rows: [oldAccount, otherProvider] });
    applyAccountUsageWindows('openai-oauth', undefined);
    let lateResolve;
    const invokeCapability = () => {
      if (failure === 'timeout')
        return new Promise((resolve) => {
          lateResolve = resolve;
        });
      if (failure === 'offline') return Promise.reject(new Error('offline'));
      return Promise.resolve({ value: failure === 'empty' ? { rows: [] } : {} });
    };
    const api = failure === 'missing-api' ? {} : { invokeCapability };
    const request = refreshUsageDashboardAfterAuth(api, ['openai-oauth']);
    if (failure === 'timeout') await clock.advance(TIMEOUT);
    await request;
    assert.equal(switchedRow().status, 'unavailable');
    assert.deepEqual(switchedRow().windows, []);
    assert.equal(switchedRow().resetCredits, undefined);
    assert.deepEqual(getUsageDashboardSnapshot().dashboard.rows[1], otherProvider);
    assert.equal(JSON.parse(clock.storage.get(CACHE_KEY)).rows[0].status, 'unavailable');
    if (lateResolve) {
      lateResolve({ value: { rows: [oldAccount] } });
      await clock.settle();
      assert.equal(switchedRow().status, 'unavailable', 'a timed-out result cannot restore stale quotas');
    }
    assert.equal(clock.timers.size, 0);
  });
}

test('known windows belong to the chosen account, but reset credits never carry across', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  publishUsageDashboard({ rows: [oldAccount, otherProvider] });
  const refreshedAt = getUsageDashboardSnapshot().refreshedAt;
  const windows = [{ label: '7D', usedPct: 12 }];
  applyAccountUsageWindows('openai-oauth', windows);
  assert.deepEqual(switchedRow().windows, windows);
  assert.equal(switchedRow().resetCredits, undefined);
  assert.equal(getUsageDashboardSnapshot().refreshedAt, refreshedAt);
  // A popup reopening after retirement must revalidate the pending switch,
  // even though the dashboard's previous live timestamp is still recent.
  let calls = 0;
  await refreshUsageDashboard({
    async invokeCapability() {
      calls += 1;
      throw new Error('offline');
    },
  });
  assert.equal(calls, 1);
  assert.equal(switchedRow().status, 'partial');
  assert.deepEqual(switchedRow().windows, windows);
});

// The core pushes the dashboard as section `usage`, key `dashboard` (desktop-services.md §15 P7; the Rust producer is
// `usage_stats_feed`). A host here is an api with a `sections` source; `push(rows)` is the core publishing a new entry.
function sectionsHost(extra = {}) {
  const listeners = new Set();
  let revision = 0;
  let entries = [];
  const host = {
    calls: 0,
    sections: {
      snapshot: async () => ({ status: 'ready', entries }),
      subscribe: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    },
    async invokeCapability() {
      host.calls += 1;
      return response;
    },
    listenerCount: () => listeners.size,
    push(rows) {
      const entry = { section: 'usage', key: 'dashboard', revision: ++revision, value: { rows } };
      entries = [entry];
      for (const listener of [...listeners]) listener({ kind: 'sections', changes: [{ section: 'usage', key: 'dashboard', entry }] });
    },
    ...extra,
  };
  return host;
}
const rowsOf = () => getUsageDashboardSnapshot().dashboard.rows;
const idle = (clock) => clock.timers.size + clock.doc.listenerCount() + clock.win.listenerCount();

test('the pushed usage dashboard is the live result and nothing polls for it', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  assert.equal(getUsageDashboardSnapshot().status, 'idle', 'nothing is pushed yet');

  host.push([{ id: 'openai-oauth', authenticated: true, windows: [{ label: '7D', usedPct: 4 }] }]);
  assert.equal(getUsageDashboardSnapshot().status, 'ready');
  assert.equal(getUsageDashboardSnapshot().refreshedAt, clock.now);
  assert.deepEqual(rowsOf(), [{ id: 'openai-oauth', authenticated: true, windows: [{ label: '7D', usedPct: 4 }] }]);
  assert.deepEqual(JSON.parse(clock.storage.get(CACHE_KEY)).rows, rowsOf());

  // Long hidden and visible stretches read nothing; only the next push moves the dashboard.
  clock.visibility('hidden');
  await clock.advance(30 * 60_000);
  clock.visibility('visible');
  await clock.advance(30 * 60_000);
  assert.equal(host.calls, 0);
  assert.equal(clock.timers.size, 0);
  host.push([{ id: 'openai-oauth', authenticated: true, windows: [{ label: '7D', usedPct: 9 }] }]);
  assert.equal(rowsOf()[0].windows[0].usedPct, 9);

  release();
  await clock.settle();
  host.push([{ id: 'openai-oauth', authenticated: true, windows: [{ label: '7D', usedPct: 77 }] }]);
  assert.equal(rowsOf()[0].windows[0].usedPct, 9, 'a released holder no longer follows the section');
  assert.equal(idle(clock), 0);
});

test('an entry already pushed when the holder starts is taken, and pushes continue after a credential refresh', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  const host = sectionsHost();
  host.push([{ id: 'a', authenticated: true }]);
  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  assert.deepEqual(rowsOf(), [{ id: 'a', authenticated: true }]);

  // A login or account switch retires the requests in flight; it must not silence the section.
  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  assert.equal(host.calls, 1);
  host.push([{ id: 'b', authenticated: true }]);
  assert.deepEqual(rowsOf(), [{ id: 'b', authenticated: true }]);
  publishUsageDashboard({ rows: [{ id: 'c', authenticated: true }] });
  host.push([{ id: 'd', authenticated: true }]);
  assert.deepEqual(rowsOf(), [{ id: 'd', authenticated: true }]);
  release();
  await clock.settle();
});

test('a hidden failed request does not start a retry, and returning recovers', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  let reject;
  let calls = 0;
  const gate = new Promise((_, no) => {
    reject = no;
  });
  const api = sectionsHost({
    invokeCapability() {
      calls += 1;
      return gate;
    },
  });
  const release = holdUsageDashboardCadence(api);
  const request = refreshUsageDashboard(api);
  await clock.settle();
  assert.equal(calls, 1);
  clock.visibility('hidden');
  reject(new Error('offline'));
  await request;
  await clock.advance(RETRY * 2);
  assert.equal(calls, 1);
  assert.equal(clock.timers.size, 0);
  clock.visibility('visible');
  await clock.settle();
  assert.equal(calls, 1, 'returning to the window reads nothing: the core pushes');
  assert.equal(getUsageDashboardSnapshot().status, 'unavailable');
  api.push([{ id: 'provider', authenticated: true }]);
  assert.equal(getUsageDashboardSnapshot().status, 'ready');
  release();
  await clock.settle();
});

test('a pending retry runs as soon as the remote connection is back', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  const dataset = {};
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset } } });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  let calls = 0;
  const api = {
    invokeCapability() {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('')) : Promise.resolve(response);
    },
  };
  const release = holdUsageDashboardCadence(api);
  await refreshUsageDashboard(api);
  assert.equal(getUsageDashboardSnapshot().status, 'loading');
  dataset.mixdogRemoteConnection = 'reconnecting';
  clock.win.emit('mixdog:remote-connection-state');
  await clock.settle();
  assert.equal(calls, 1, 'a connection that is not back yet leaves the retry armed');
  dataset.mixdogRemoteConnection = 'connected';
  clock.win.emit('mixdog:remote-connection-state');
  await clock.settle();
  assert.equal(calls, 2);
  assert.equal(getUsageDashboardSnapshot().status, 'ready');
  await clock.advance(RETRY * 2);
  assert.equal(calls, 2, 'the early retry replaces the delayed one');
  release();
  await clock.settle();
  assert.equal(clock.timers.size + clock.doc.listenerCount() + clock.win.listenerCount(), 0);
});

test("an old document's holder cannot stop the replacement document's section follow", async (t) => {
  const old = createRendererClock();
  bind(t, old);
  const oldHost = sectionsHost();
  const releaseOld = holdUsageDashboardCadence(oldHost);
  await old.settle();
  const fresh = createRendererClock();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fresh.win });
  const freshHost = sectionsHost();
  const releaseFresh = holdUsageDashboardCadence(freshHost);
  await fresh.settle();
  releaseOld();
  await fresh.settle();

  freshHost.push([{ id: 'fresh', authenticated: true }]);
  assert.deepEqual(rowsOf(), [{ id: 'fresh', authenticated: true }], 'the fresh holder still receives updates');
  oldHost.push([{ id: 'old', authenticated: true }]);
  assert.deepEqual(rowsOf(), [{ id: 'fresh', authenticated: true }], 'the old document no longer feeds the store');
  assert.equal(idle(old), 0);

  releaseFresh();
  await fresh.settle();
  freshHost.push([{ id: 'after', authenticated: true }]);
  assert.deepEqual(rowsOf(), [{ id: 'fresh', authenticated: true }], 'the released fresh holder stops following');
  assert.equal(idle(fresh), 0);
});

test('repeated usage popup lifetimes release listeners and do not multiply refresh cadences', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  let calls = 0;
  const api = {
    async invokeCapability() {
      calls += 1;
      return response;
    },
  };
  for (let index = 0; index < 2_000; index += 1) {
    const release = holdUsageDashboardCadence(api);
    const unsubscribe = subscribeUsageDashboard(() => {});
    unsubscribe();
    release();
    await clock.settle();
  }
  await clock.advance(TIMEOUT * 10);
  assert.equal(calls, 0);
  assert.equal(clock.timers.size + clock.doc.listenerCount() + clock.win.listenerCount(), 0);
});