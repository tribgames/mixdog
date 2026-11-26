import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAccountUsageWindows,
  getUsageDashboardSnapshot,
  getUsageResetVerificationState,
  holdUsageDashboardCadence,
  publishUsageDashboard,
  refreshUsageDashboard,
  refreshUsageDashboardAfterAuth,
  subscribeUsageDashboard,
  usageResetWindowKeys,
  USAGE_DASHBOARD_CACHE_KEY as CACHE_KEY,
  USAGE_DASHBOARD_REQUEST_TIMEOUT_MS as TIMEOUT,
  USAGE_DASHBOARD_RETRY_DELAY_MS as RETRY,
  USAGE_RESET_FOLLOWUP_DELAYS_MS as RESET_FOLLOWUPS,
  USAGE_RESET_SETTLE_DELAY_MS as RESET_SETTLE,
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
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    async invokeCapability() {
      host.calls += 1;
      return response;
    },
    listenerCount: () => listeners.size,
    push(rows, extraFields = {}) {
      const entry = { section: 'usage', key: 'dashboard', revision: ++revision, value: { ...extraFields, rows } };
      entries = [entry, ...entries.filter((item) => item.key !== 'dashboard')];
      for (const listener of [...listeners])
        listener({ kind: 'sections', changes: [{ section: 'usage', key: 'dashboard', entry }] });
    },
    pushStats(value) {
      const entry = { section: 'usage', key: 'stats', revision: ++revision, value };
      entries = [entry, ...entries.filter((item) => item.key !== 'stats')];
      for (const listener of [...listeners])
        listener({ kind: 'sections', changes: [{ section: 'usage', key: 'stats', entry }] });
    },
    reconnect(epoch = 'core-1') {
      const cloned = structuredClone(entries);
      for (const listener of [...listeners]) {
        listener({ kind: 'replace', stage: 'begin' });
        listener({ kind: 'replace', stage: 'chunk', entries: cloned });
        listener({ kind: 'replace', stage: 'commit', epoch });
      }
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

test('a reading older than the one a provider shows never replaces it, whichever arrives last', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  const reading = (usedPct, updatedAt) => [
    { id: 'anthropic-oauth', authenticated: true, updatedAt, windows: [{ label: '5H', usedPct }] },
  ];
  const stored = () => JSON.parse(clock.storage.get(CACHE_KEY)).rows;

  // A refresh is answered from the read the core already runs; that read's own result is pushed before the answer lands.
  const answer = Promise.withResolvers();
  const host = sectionsHost({ invokeCapability: () => answer.promise });
  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  const request = refreshUsageDashboard(host, { force: true });
  host.push(reading(10, 200));
  answer.resolve({ value: { rows: reading(9, 100) } });
  await request;
  assert.deepEqual(rowsOf(), reading(10, 200));
  assert.deepEqual(stored(), reading(10, 200));
  release();
  await clock.settle();

  // The first section snapshot, read before a refresh, resolves after the refresh's newer answer.
  const snapshot = Promise.withResolvers();
  const late = sectionsHost({
    sections: { snapshot: () => snapshot.promise, subscribe: () => () => undefined },
    invokeCapability: async () => ({ value: { rows: reading(11, 300) } }),
  });
  const releaseLate = holdUsageDashboardCadence(late);
  await refreshUsageDashboard(late, { force: true });
  assert.deepEqual(rowsOf(), reading(11, 300));
  snapshot.resolve({
    status: 'ready',
    entries: [{ section: 'usage', key: 'dashboard', revision: 1, value: { rows: reading(10, 200) } }],
  });
  await clock.settle();
  assert.deepEqual(rowsOf(), reading(11, 300));
  assert.deepEqual(stored(), reading(11, 300));
  releaseLate();
  await clock.settle();
});

test('readings are ordered only within one account: another account replaces the shown row whatever its time', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  const reading = (account, usedPct, updatedAt) => [
    {
      id: 'anthropic-oauth',
      authenticated: true,
      updatedAt,
      credentialStamp: account,
      windows: [{ label: '5H', usedPct }],
    },
  ];
  const stored = () => JSON.parse(clock.storage.get(CACHE_KEY)).rows;
  const stateListeners = new Set();
  const answers = [];
  const host = sectionsHost({
    subscribeState(listener) {
      stateListeners.add(listener);
      return () => void stateListeners.delete(listener);
    },
    invokeCapability: () => new Promise((resolve) => answers.push(resolve)),
  });
  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  const switchTo = (accountId, at) => {
    for (const listener of stateListeners)
      listener({ providerAccountChange: { provider: 'anthropic-oauth', accountId, at } });
  };
  const A = (usedPct = 10, at = 200) => reading('aaaa', usedPct, at);
  const B = (usedPct = 40, at = 150) => reading('bbbb', usedPct, at);

  host.push(A());
  assert.deepEqual(rowsOf(), A());

  // Switch seen by this window: B, measured earlier, is answered.
  switchTo('b', clock.now + 1);
  await clock.settle();
  answers.shift()({ value: { rows: B() } });
  await clock.settle();
  assert.deepEqual(rowsOf(), B());
  assert.deepEqual(stored(), B());

  // The same account still orders: B's older reading never replaces B's newer one.
  host.push(B(41, 160));
  host.push(B(40, 150));
  assert.deepEqual(rowsOf(), B(41, 160));

  // A push carrying A lands between the switch back to A and its answer, then B's stale row is answered late.
  switchTo('a', clock.now + 2);
  await clock.settle();
  host.push(A());
  answers.shift()({ value: { rows: A() } });
  await clock.settle();
  assert.deepEqual(rowsOf(), A());

  // A switch made by another client: this window hears of it only as a push with an older time.
  host.push(B());
  assert.deepEqual(rowsOf(), B());
  assert.deepEqual(stored(), B());
  host.push(A());
  assert.deepEqual(rowsOf(), A(), 'a newer reading of the other account takes the row back');
  release();
  await clock.settle();
});

test('a stored row carries its account, so a restart orders against it', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  const row = (account, updatedAt, usedPct) => [
    {
      id: 'anthropic-oauth',
      authenticated: true,
      updatedAt,
      credentialStamp: account,
      windows: [{ label: '5H', usedPct }],
    },
  ];
  publishUsageDashboard({ rows: row('aaaa', 200, 10) });
  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(row('aaaa', 100, 9));
  assert.deepEqual(rowsOf(), row('aaaa', 200, 10), 'the same account keeps its newer stored reading');
  host.push(row('bbbb', 150, 40));
  assert.deepEqual(rowsOf(), row('bbbb', 150, 40));
  release();
  await clock.settle();
});

test('a core that sends no account keeps ordering by the readings this document accepted', async (t) => {
  const clock = createRendererClock();
  bind(t, clock);
  const row = (updatedAt, usedPct) => [
    { id: 'anthropic-oauth', authenticated: true, updatedAt, windows: [{ label: '5H', usedPct }] },
  ];
  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(row(200, 10));
  host.push(row(150, 40));
  assert.deepEqual(rowsOf(), row(200, 10));
  release();
  await clock.settle();
});

const EPOCH_OFFSET = 1_700_000_000_000;

function bindEpoch(t, clock) {
  bind(t, clock);
  Date.now = () => EPOCH_OFFSET + clock.now;
}

test('refreshUsageDashboard treats a cached snapshot as stale once a window resetAt passes', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const reset5h = Date.now() + 10_000;
  const reset7d = Date.now() + 500_000;
  const rolled5h = Date.now() + 18_010_000;

  publishUsageDashboard({
    rows: [
      {
        id: 'openai-oauth',
        authenticated: true,
        windows: [
          { label: '5H', usedPct: 100, resetAt: reset5h },
          { label: '7D', usedPct: 20, resetAt: reset7d },
        ],
      },
    ],
  });

  let calls = 0;
  const api = {
    async readCapabilities() {
      calls += 1;
      return [
        {
          ok: true,
          value: {
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                windows: [
                  { label: '5H', usedPct: 0, resetAt: rolled5h },
                  { label: '7D', usedPct: 20, resetAt: reset7d },
                ],
              },
            ],
          },
        },
      ];
    },
  };

  // Before resetAt, snapshot stays fresh within the 5-minute TTL.
  await clock.advance(9_000);
  await refreshUsageDashboard(api);
  assert.equal(calls, 0);

  // Once resetAt passes, non-forced refresh must bypass freshness and fetch live.
  await clock.advance(1_000);
  await refreshUsageDashboard(api);
  assert.equal(calls, 1);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);

  // After rollover, snapshot is fresh again.
  await refreshUsageDashboard(api);
  assert.equal(calls, 1);
});

test('holdUsageDashboardCadence refreshes automatically when a window resetAt passes even with SidebarUsage unmounted', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const reset5h = Date.now() + 10_000;
  const reset7d = Date.now() + 500_000;
  const rolled5h = Date.now() + 18_010_000;

  publishUsageDashboard({
    rows: [
      {
        id: 'openai-oauth',
        authenticated: true,
        windows: [
          { label: '5H', usedPct: 100, resetAt: reset5h },
          { label: '7D', usedPct: 20, resetAt: reset7d },
        ],
      },
    ],
  });

  let calls = 0;
  const api = {
    async readCapabilities() {
      calls += 1;
      return [
        {
          ok: true,
          value: {
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                windows: [
                  { label: '5H', usedPct: 0, resetAt: rolled5h },
                  { label: '7D', usedPct: 20, resetAt: reset7d },
                ],
              },
            ],
          },
        },
      ];
    },
  };

  const release = holdUsageDashboardCadence(api);
  await clock.advance(10_000 + RESET_SETTLE - 1);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('reset refresh retries with bounded follow-ups when upstream still echoes elapsed resetAt', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const reset5h = Date.now() + 10_000;
  const reset7d = Date.now() + 500_000;
  const rolled5h = Date.now() + 18_010_000;

  const expiredRow = (usedPct = 100, resetAt = reset5h) => ({
    rows: [
      {
        id: 'openai-oauth',
        authenticated: true,
        windows: [
          { label: '5H', usedPct, resetAt },
          { label: '7D', usedPct: 20, resetAt: reset7d },
        ],
      },
    ],
  });

  // Case 1: upstream echoes elapsed resetAt twice (skew/cache), then rolls over on second follow-up.
  publishUsageDashboard(expiredRow(100, reset5h));
  let calls = 0;
  const recoveringApi = {
    async readCapabilities() {
      calls += 1;
      const value = calls <= 2 ? expiredRow(100, reset5h) : expiredRow(0, rolled5h);
      return [{ ok: true, value }];
    },
  };
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];
  const release1 = holdUsageDashboardCadence(recoveringApi);
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), true);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), false);

  await clock.advance(RESET_FOLLOWUPS[0]);
  assert.equal(calls, 2);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), true);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), false);

  await clock.advance(RESET_FOLLOWUPS[1]);
  assert.equal(calls, 3);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.size, 0);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);
  release1();
  await clock.settle();
  assert.equal(idle(clock), 0);

  // Case 2: upstream never clears the elapsed resetAt — follow-ups stop cleanly after the bounded count.
  const stuckReset = Date.now() + 10_000;
  publishUsageDashboard({
    rows: [{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: stuckReset }] }],
  });
  let stuckCalls = 0;
  const stuckApi = {
    async readCapabilities() {
      stuckCalls += 1;
      return [
        {
          ok: true,
          value: {
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                windows: [{ label: '5H', usedPct: 100, resetAt: stuckReset }],
              },
            ],
          },
        },
      ];
    },
  };
  const release2 = holdUsageDashboardCadence(stuckApi);
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(stuckCalls, 1);
  for (let i = 0; i < RESET_FOLLOWUPS.length; i += 1) {
    await clock.advance(RESET_FOLLOWUPS[i]);
    assert.equal(stuckCalls, i + 2);
  }
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), false);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  await clock.advance(60 * 60_000);
  assert.equal(stuckCalls, RESET_FOLLOWUPS.length + 1, 'no polling after bounded follow-ups exhaust');
  release2();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a timed-out reset refresh still rearms subsequent window resets after recovery', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const reset5h = Date.now() + 10_000;
  const reset7d = Date.now() + 120_000;
  const rolled5h = Date.now() + 18_010_000;
  const rolled7d = Date.now() + 7 * 86_400_000;

  publishUsageDashboard({
    rows: [
      {
        id: 'openai-oauth',
        authenticated: true,
        windows: [
          { label: '5H', usedPct: 100, resetAt: reset5h },
          { label: '7D', usedPct: 80, resetAt: reset7d },
        ],
      },
    ],
  });

  let calls = 0;
  const api = {
    invokeCapability() {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      if (calls === 2) {
        return Promise.resolve({
          value: {
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                windows: [
                  { label: '5H', usedPct: 0, resetAt: rolled5h },
                  { label: '7D', usedPct: 80, resetAt: reset7d },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({
        value: {
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              windows: [
                { label: '5H', usedPct: 0, resetAt: rolled5h },
                { label: '7D', usedPct: 0, resetAt: rolled7d },
              ],
            },
          ],
        },
      });
    },
  };

  const release = holdUsageDashboardCadence(api);
  // t=12s: 5H reset triggers call 1, which hangs until TIMEOUT (30s -> t=42s).
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  await clock.advance(TIMEOUT);
  // t=57s (+RETRY=15s): ordinary retry recovers with rolled 5H and upcoming 7D (t=120s).
  await clock.advance(RETRY);
  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[1].usedPct, 80);

  // Advancing to 7D resetAt + RESET_SETTLE (t=122s, remaining = 65s) must still trigger call 3.
  const remainingTo7d = reset7d + RESET_SETTLE - Date.now();
  assert.ok(remainingTo7d > 0);
  await clock.advance(remainingTo7d - 1);
  assert.equal(calls, 2);
  await clock.advance(1);
  assert.equal(calls, 3);
  assert.equal(rowsOf()[0].windows[1].usedPct, 0);
  assert.equal(rowsOf()[0].windows[1].resetAt, rolled7d);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('alternating elapsed resetAt timestamps for the same window still exhaust the bounded retry budget', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const resetA = Date.now() + 10_000;
  const resetB = resetA - 1_000;

  publishUsageDashboard({
    rows: [{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: resetA }] }],
  });

  let calls = 0;
  const api = {
    async readCapabilities() {
      calls += 1;
      const echoed = calls % 2 === 1 ? resetA : resetB;
      return [
        {
          ok: true,
          value: {
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                windows: [{ label: '5H', usedPct: 100, resetAt: echoed }],
              },
            ],
          },
        },
      ];
    },
  };

  const release = holdUsageDashboardCadence(api);
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  for (let i = 0; i < RESET_FOLLOWUPS.length; i += 1) {
    await clock.advance(RESET_FOLLOWUPS[i] - 1);
    assert.equal(calls, i + 1);
    await clock.advance(1);
    assert.equal(calls, i + 2);
  }
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.size, 0);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 1);

  await clock.advance(60 * 60_000);
  assert.equal(calls, RESET_FOLLOWUPS.length + 1, 'alternating elapsed timestamps must not loop');
  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a transient transport error does not permanently block skew follow-ups after a later successful read', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const reset5h = Date.now() + 10_000;
  const rolled5h = Date.now() + 18_010_000;

  publishUsageDashboard({
    rows: [{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }] }],
  });

  let calls = 0;
  const api = {
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      if (calls === 2) {
        return Promise.resolve({
          value: {
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
              },
            ],
          },
        });
      }
      return Promise.resolve({
        value: {
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }],
            },
          ],
        },
      });
    },
  };

  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];
  const release = holdUsageDashboardCadence(api);
  // t=12s: reset refresh fails transiently.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // t=27s (+RETRY): ordinary retry succeeds but upstream still returns the stale elapsed resetAt.
  await clock.advance(RETRY);
  assert.equal(calls, 2);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), false);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), true);

  // Follow-up timer runs after RESET_FOLLOWUPS[0] and picks up the rolled-over window.
  await clock.advance(RESET_FOLLOWUPS[0] - 1);
  assert.equal(calls, 2);
  await clock.advance(1);
  assert.equal(calls, 3);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.size, 0);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a failed scoped auth refresh restores unaffected providers reset timers', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const resetOpenai = Date.now() + 40_000;
  const rolledOpenai = Date.now() + 18_040_000;

  publishUsageDashboard({
    rows: [
      { id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: resetOpenai }] },
      { id: 'anthropic-oauth', authenticated: true, windows: [{ label: '7D', usedPct: 10 }] },
    ],
  });

  let calls = 0;
  const api = {
    async readCapabilities() {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return [
        {
          ok: true,
          value: {
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                windows: [{ label: '5H', usedPct: 0, resetAt: rolledOpenai }],
              },
              { id: 'anthropic-oauth', authenticated: true, windows: [{ label: '7D', usedPct: 10 }] },
            ],
          },
        },
      ];
    },
  };

  const release = holdUsageDashboardCadence(api);
  // Scoped auth refresh for anthropic-oauth fails; openai-oauth's scheduled reset must still fire at +42s.
  await refreshUsageDashboardAfterAuth(api, ['anthropic-oauth']);
  assert.equal(calls, 1);

  await clock.advance(40_000 + RESET_SETTLE - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolledOpenai);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('staggered window resets do not spend another windows retry budget before its backoff expires', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const resetA = Date.now() + 10_000;
  const resetB = Date.now() + 13_000;
  const rolledA = Date.now() + 18_010_000;
  const rolledB = Date.now() + 18_013_000;

  const frame = (aPct, aReset, bPct, bReset) => ({
    rows: [
      { id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: aPct, resetAt: aReset }] },
      { id: 'anthropic-oauth', authenticated: true, windows: [{ label: '5H', usedPct: bPct, resetAt: bReset }] },
    ],
  });

  publishUsageDashboard(frame(100, resetA, 100, resetB));

  const replies = [
    frame(100, resetA, 100, resetB), // t=12s: A initial settle
    frame(100, resetA, 100, resetB), // t=15s: B initial settle
    frame(100, resetA, 100, resetB), // t=17s: A follow-up 0
    frame(100, resetA, 0, rolledB), // t=20s: B follow-up 0 rolls over B
    frame(100, resetA, 0, rolledB), // t=32s: A follow-up 1
    frame(0, rolledA, 0, rolledB), // t=62s: A follow-up 2 rolls over A
  ];
  let calls = 0;
  const api = {
    async readCapabilities() {
      calls += 1;
      const value = replies.shift();
      assert.ok(value, `unexpected call #${calls}`);
      return [{ ok: true, value }];
    },
  };

  const keyA = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];
  const release = holdUsageDashboardCadence(api);
  // t=12s: A initial settle
  await clock.advance(12_000);
  assert.equal(calls, 1);
  // t=15s: B initial settle (A is not due until t=17s)
  await clock.advance(3_000);
  assert.equal(calls, 2);
  // t=17s: A follow-up 0
  await clock.advance(2_000);
  assert.equal(calls, 3);
  // t=20s: B follow-up 0 rolls over B (A is not due until t=32s)
  await clock.advance(3_000);
  assert.equal(calls, 4);
  assert.equal(rowsOf()[1].windows[0].usedPct, 0);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(keyA), true);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(keyA), false);
  // t=32s: A follow-up 1
  await clock.advance(12_000);
  assert.equal(calls, 5);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(keyA), true);
  // t=62s: A follow-up 2 rolls over A (full 3 follow-ups preserved)
  await clock.advance(30_000);
  assert.equal(calls, 6);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolledA);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.size, 0);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('resets more than 24 days away reschedule intermediate wakeups and refresh when due', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const DAY = 86_400_000;
  const resetMonthly = Date.now() + 28 * DAY;
  const rolledMonthly = Date.now() + 58 * DAY;

  publishUsageDashboard({
    rows: [{ id: 'cursor-oauth', authenticated: true, windows: [{ label: 'M', usedPct: 95, resetAt: resetMonthly }] }],
  });

  let calls = 0;
  const api = {
    async readCapabilities() {
      calls += 1;
      return [
        {
          ok: true,
          value: {
            rows: [
              {
                id: 'cursor-oauth',
                authenticated: true,
                windows: [{ label: 'M', usedPct: 0, resetAt: rolledMonthly }],
              },
            ],
          },
        },
      ];
    },
  };

  const release = holdUsageDashboardCadence(api);
  // Intermediate 24-day wakeup fires without making an early capability call.
  await clock.advance(24 * DAY);
  assert.equal(calls, 0);

  // Remaining 4 days + RESET_SETTLE triggers the actual refresh.
  await clock.advance(4 * DAY + RESET_SETTLE - 1);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolledMonthly);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('two consecutive timeouts still preserve scheduled future reset timers', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const reset5h = Date.now() + 10_000;
  const reset7d = Date.now() + 120_000;
  const rolled5h = Date.now() + 18_010_000;
  const rolled7d = Date.now() + 7 * 86_400_000;

  publishUsageDashboard({
    rows: [
      {
        id: 'openai-oauth',
        authenticated: true,
        windows: [
          { label: '5H', usedPct: 100, resetAt: reset5h },
          { label: '7D', usedPct: 80, resetAt: reset7d },
        ],
      },
    ],
  });

  let calls = 0;
  const api = {
    invokeCapability() {
      calls += 1;
      if (calls <= 2) return new Promise(() => {});
      return Promise.resolve({
        value: {
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              windows: [
                { label: '5H', usedPct: 0, resetAt: rolled5h },
                { label: '7D', usedPct: 0, resetAt: rolled7d },
              ],
            },
          ],
        },
      });
    },
  };

  const release = holdUsageDashboardCadence(api);
  // t=12s: 5H reset refresh starts (call 1) and times out at t=42s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  await clock.advance(TIMEOUT);
  // t=57s (+RETRY): ordinary recovery retry starts (call 2) and ALSO times out at t=87s.
  await clock.advance(RETRY);
  assert.equal(calls, 2);
  await clock.advance(TIMEOUT);

  // t=122s (7D resetAt + RESET_SETTLE): scheduled future reset timer must still fire.
  const remainingTo7d = reset7d + RESET_SETTLE - Date.now();
  assert.ok(remainingTo7d > 0);
  await clock.advance(remainingTo7d - 1);
  assert.equal(calls, 2);
  await clock.advance(1);
  assert.equal(calls, 3);
  assert.equal(rowsOf()[0].windows[1].usedPct, 0);
  assert.equal(rowsOf()[0].windows[1].resetAt, rolled7d);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a slow read does not spend another windows retry budget', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const resetA = Date.now() + 10_000;
  const resetB = Date.now() + 13_000;
  const rolledA = Date.now() + 18_010_000;
  const rolledB = Date.now() + 18_013_000;
  const keyA = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  const frame = (aPct, aReset, bPct, bReset) => ({
    rows: [
      { id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: aPct, resetAt: aReset }] },
      { id: 'anthropic-oauth', authenticated: true, windows: [{ label: '5H', usedPct: bPct, resetAt: bReset }] },
    ],
  });

  publishUsageDashboard(frame(100, resetA, 100, resetB));

  let slowResolve = null;
  let calls = 0;
  const api = {
    readCapabilities() {
      calls += 1;
      if (calls === 1) return Promise.resolve([{ ok: true, value: frame(100, resetA, 100, resetB) }]);
      if (calls === 2) {
        return new Promise((resolve) => {
          slowResolve = () => resolve([{ ok: true, value: frame(100, resetA, 0, rolledB) }]);
        });
      }
      if (calls <= 4) return Promise.resolve([{ ok: true, value: frame(100, resetA, 0, rolledB) }]);
      return Promise.resolve([{ ok: true, value: frame(0, rolledA, 0, rolledB) }]);
    },
  };

  const release = holdUsageDashboardCadence(api);
  // t=12s: A initial settle -> A nextDueAt = t=17s (attempt 1).
  await clock.advance(12_000);
  assert.equal(calls, 1);

  // t=15s: B initial settle starts (before A is due at t=17s), but finishes slowly at t=18s.
  await clock.advance(3_000);
  assert.equal(calls, 2);
  await clock.advance(3_000);
  assert.equal(calls, 2);
  slowResolve();
  await clock.settle();
  // Because call 2 started at t=15s (< 17s), A must not spend attempt 2 and immediately wakes for follow-up 0.
  await clock.advance(0);
  assert.equal(calls, 3);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(keyA), true);

  // t=33s (+15s): A follow-up 1 still runs.
  await clock.advance(RESET_FOLLOWUPS[1] - 1);
  assert.equal(calls, 3);
  await clock.advance(1);
  assert.equal(calls, 4);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(keyA), true);

  // t=63s (+30s): A follow-up 2 still runs and rolls A over (full 3 follow-ups preserved).
  await clock.advance(RESET_FOLLOWUPS[2] - 1);
  assert.equal(calls, 4);
  await clock.advance(1);
  assert.equal(calls, 5);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolledA);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.size, 0);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a stats-only usage section push is not treated as a fresh dashboard verification', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const reset5h = Date.now() + 10_000;
  const rolled5h = Date.now() + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return Promise.resolve({
        value: {
          rows: [
            { id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }] },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push([{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }] }]);
  const initialRefreshedAt = getUsageDashboardSnapshot().refreshedAt;

  // t=12s: reset refresh fails -> window is failed and ordinary RETRY is armed for t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), false);

  // t=15s: a stats-only push in the usage section must not cancel RETRY or fake dashboard verification.
  await clock.advance(3_000);
  host.pushStats({ totals: { tokens: 4200 } });
  assert.equal(getUsageDashboardSnapshot().refreshedAt, initialRefreshedAt);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), false);

  // t=27s (remaining RETRY - 3s): ordinary retry still fires and rolls over the window.
  await clock.advance(RETRY - 3_000 - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('publishUsageDashboard resumes follow-ups for a transport-failed window echoing an elapsed reset', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const reset5h = Date.now() + 10_000;
  const rolled5h = Date.now() + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  publishUsageDashboard({
    rows: [{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }] }],
  });

  let calls = 0;
  const api = {
    invokeCapability() {
      calls += 1;
      if (calls <= 2) return Promise.reject(new Error('offline'));
      return Promise.resolve({
        value: {
          rows: [
            { id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }] },
          ],
        },
      });
    },
  };

  const release = holdUsageDashboardCadence(api);
  // t=12s: reset refresh fails; t=27s: ordinary retry also fails -> retries retired, window transport-failed.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  await clock.advance(RETRY);
  assert.equal(calls, 2);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), false);

  // Reset-credit mutation publishes a fresh dashboard that still echoes the elapsed resetAt.
  const published = publishUsageDashboard({
    rows: [{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }] }],
  });
  assert.equal(published, true);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), false);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), true);

  // Follow-up timer runs after RESET_FOLLOWUPS[0] and rolls the window over.
  await clock.advance(RESET_FOLLOWUPS[0] - 1);
  assert.equal(calls, 2);
  await clock.advance(1);
  assert.equal(calls, 3);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.size, 0);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('aligned reset timestamps keep per-provider verification and failure state isolated', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const sharedReset = Date.now() + 10_000;
  const openaiKey = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];
  const anthropicKey = usageResetWindowKeys([{ label: '5H' }], 'anthropic-oauth')[0];

  const staleBoth = () => ({
    rows: [
      { id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: sharedReset }] },
      { id: 'anthropic-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: sharedReset }] },
    ],
  });

  publishUsageDashboard(staleBoth());

  const api = {
    async readCapabilities() {
      return [{ ok: true, value: staleBoth() }];
    },
  };

  const release = holdUsageDashboardCadence(api);
  await clock.advance(10_000 + RESET_SETTLE);
  for (const delay of RESET_FOLLOWUPS) {
    await clock.advance(delay);
  }
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(openaiKey), true);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(anthropicKey), true);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.size, 0);

  // Reauthing anthropic-oauth restarts verification for anthropic only; openai-oauth must remain failed.
  await refreshUsageDashboardAfterAuth(api, ['anthropic-oauth']);
  const state = getUsageResetVerificationState();
  assert.equal(state.verifyingWindowKeys.has(anthropicKey), true);
  assert.equal(state.failedWindowKeys.has(anthropicKey), false);
  assert.equal(state.failedWindowKeys.has(openaiKey), true);
  assert.equal(state.verifyingWindowKeys.has(openaiKey), false);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a slow core push uses checkedAt so it does not spend another windows retry budget', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const resetA = start + 10_000;
  const resetB = start + 13_000;
  const rolledA = start + 18_010_000;
  const rolledB = start + 18_013_000;
  const keyA = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  const rows = (aPct, aReset, bPct, bReset) => [
    { id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: aPct, resetAt: aReset }] },
    { id: 'anthropic-oauth', authenticated: true, windows: [{ label: '5H', usedPct: bPct, resetAt: bReset }] },
  ];

  let slowCallResolve = null;
  let calls = 0;
  const host = sectionsHost({
    readCapabilities() {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve([{ ok: true, value: { checkedAt: Date.now(), rows: rows(100, resetA, 100, resetB) } }]);
      }
      if (calls === 2) {
        return new Promise((resolve) => {
          slowCallResolve = () =>
            resolve([{ ok: true, value: { checkedAt: start + 15_000, rows: rows(100, resetA, 0, rolledB) } }]);
        });
      }
      if (calls <= 4) {
        return Promise.resolve([{ ok: true, value: { checkedAt: Date.now(), rows: rows(100, resetA, 0, rolledB) } }]);
      }
      return Promise.resolve([{ ok: true, value: { checkedAt: Date.now(), rows: rows(0, rolledA, 0, rolledB) } }]);
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(rows(100, resetA, 100, resetB), { checkedAt: start });

  // t=12s: A initial settle (call 1) -> A nextDueAt = start + 17s (attempt 1).
  await clock.advance(12_000);
  assert.equal(calls, 1);

  // t=15s: B initial settle (call 2) starts and stays slow until t=18s.
  await clock.advance(3_000);
  assert.equal(calls, 2);
  await clock.advance(3_000); // t=18s (past A's nextDueAt = 17s)

  // Core pushes the slow read (started at checkedAt = start + 15s < 17s) at t=18s before call 2 finishes.
  host.push(rows(100, resetA, 0, rolledB), { checkedAt: start + 15_000 });
  slowCallResolve();
  await clock.settle();

  // Because the pushed dashboard was checked at t=15s (< 17s), A still has all 3 follow-ups remaining.
  await clock.advance(0);
  assert.equal(calls, 3);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(keyA), true);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(keyA), false);

  await clock.advance(RESET_FOLLOWUPS[1]);
  assert.equal(calls, 4);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(keyA), true);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(keyA), false);

  await clock.advance(RESET_FOLLOWUPS[2]);
  assert.equal(calls, 5);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolledA);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.size, 0);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a newly due reset does not inherit the failure of a request started before it was due', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const reset5h = Date.now() + 10_000;
  const rolled5h = Date.now() + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  publishUsageDashboard({
    rows: [{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }] }],
  });

  let rejectFirst = null;
  let calls = 0;
  const api = {
    invokeCapability() {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve({
        value: {
          rows: [
            { id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }] },
          ],
        },
      });
    },
  };

  const release = holdUsageDashboardCadence(api);

  // t=5s: an unrelated forced refresh starts BEFORE 5H is due (t=12s).
  await clock.advance(5_000);
  const earlyRefresh = refreshUsageDashboard(api, { force: true });
  await clock.settle();
  assert.equal(calls, 1);

  // t=12s: 5H reset becomes due and awaits the already-pending call 1.
  await clock.advance(7_000);
  assert.equal(calls, 1);

  // t=13s: call 1 fails. 5H must not inherit that failure; it must immediately issue its own due read (call 2).
  await clock.advance(1_000);
  rejectFirst(new Error('offline'));
  await earlyRefresh;
  await clock.settle();

  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), false);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), false);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a scoped auth refresh does not exhaust an untouched providers final reset follow-up', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const resetCodex = Date.now() + 10_000;
  const rolledCodex = Date.now() + 18_010_000;
  const codexKey = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  const frame = (codexPct, codexReset, claudePct) => ({
    rows: [
      { id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: codexPct, resetAt: codexReset }] },
      { id: 'anthropic-oauth', authenticated: true, windows: [{ label: '7D', usedPct: claudePct }] },
    ],
  });

  publishUsageDashboard(frame(100, resetCodex, 50));

  let calls = 0;
  const api = {
    readCapabilities(batch) {
      calls += 1;
      const scoped = batch[0]?.args?.[0]?.refreshProviders;
      if (Array.isArray(scoped) && scoped.includes('anthropic-oauth')) {
        // Core refreshes Claude live and returns the cached stale Codex row (no updatedAt).
        return Promise.resolve([{ ok: true, value: frame(100, resetCodex, 10) }]);
      }
      if (calls <= 3) return Promise.resolve([{ ok: true, value: frame(100, resetCodex, 50) }]);
      // Call 4 (at t=62s) stays pending so the scoped auth refresh starts AFTER Codex's due time.
      if (calls === 4) return new Promise(() => {});
      return Promise.resolve([{ ok: true, value: frame(0, rolledCodex, 10) }]);
    },
  };

  const release = holdUsageDashboardCadence(api);
  // t=12s (settle, attempt 1), t=17s (follow-up 0, attempt 2), t=32s (follow-up 1, attempt 3, nextDueAt=t+62s).
  await clock.advance(10_000 + RESET_SETTLE);
  await clock.advance(RESET_FOLLOWUPS[0]);
  await clock.advance(RESET_FOLLOWUPS[1]);
  assert.equal(calls, 3);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(codexKey), true);

  // t=62s: Codex final follow-up begins (call 4, pending); advance to t=62.5s (strictly past Codex due time).
  await clock.advance(RESET_FOLLOWUPS[2]);
  assert.equal(calls, 4);
  await clock.advance(500);

  // Scoped auth refresh starts at t=62.5s >= 62s; only providerScope prevents exhausting Codex.
  await refreshUsageDashboardAfterAuth(api, ['anthropic-oauth']);
  assert.equal(calls, 5);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(codexKey), false);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(codexKey), true);

  // Codex's own unscoped follow-up runs immediately and rolls Codex over cleanly.
  await clock.advance(0);
  assert.equal(calls, 6);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolledCodex);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a slow reset-credit publication started before a transport failure preserves the scheduled recovery retry', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const reset5h = Date.now() + 10_000;
  const rolled5h = Date.now() + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  const stale = () => ({
    rows: [{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }] }],
  });
  const rolled = () => ({
    rows: [{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }] }],
  });

  publishUsageDashboard(stale());
  // Mutation begins at t=0, well before the window fails on its final follow-up.
  const slowMutationStartedAt = Date.now();

  let calls = 0;
  const api = {
    invokeCapability() {
      calls += 1;
      if (calls <= 3) return Promise.resolve({ value: stale() });
      if (calls === 4) return Promise.reject(new Error('offline'));
      return Promise.resolve({ value: rolled() });
    },
  };

  const release = holdUsageDashboardCadence(api);
  // t=12s (attempt 1), t=17s (attempt 2), t=32s (attempt 3), t=62s (transport failure arms RETRY for t=77s).
  await clock.advance(10_000 + RESET_SETTLE);
  await clock.advance(RESET_FOLLOWUPS[0]);
  await clock.advance(RESET_FOLLOWUPS[1]);
  await clock.advance(RESET_FOLLOWUPS[2]);
  assert.equal(calls, 4);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // Slow reset-credit mutation from t=0 settles at t=65s with stale Codex data.
  await clock.advance(3_000);
  assert.equal(
    publishUsageDashboard(stale(), { readStartedAt: slowMutationStartedAt, providers: ['openai-oauth'] }),
    true
  );
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // Scheduled recovery retry must still fire automatically at t=77s (RETRY - 3s later) without manual refresh.
  await clock.advance(RETRY - 3_000 - 1);
  assert.equal(calls, 4);
  await clock.advance(1);
  assert.equal(calls, 5);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('reconnecting section-store replay of an unchanged dashboard does not fake verification or cancel retry', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const rolled5h = start + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return Promise.resolve({
        value: {
          rows: [
            { id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }] },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push([{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }] }], {
    checkedAt: start,
  });
  const initialRefreshedAt = getUsageDashboardSnapshot().refreshedAt;

  // t=12s: reset refresh fails -> window is failed and ordinary RETRY is armed for t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), false);

  // t=15s: reconnect replays the exact same revision with newly deserialized objects.
  await clock.advance(3_000);
  host.reconnect('core-1');
  assert.equal(getUsageDashboardSnapshot().refreshedAt, initialRefreshedAt);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), false);

  // t=27s: ordinary retry was preserved and rolls the window over.
  await clock.advance(RETRY - 3_000 - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a stale changed section push preserves the scheduled recovery retry for a transport-failed window', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const rolled5h = start + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return Promise.resolve({
        value: {
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 5 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // t=12s: reset refresh fails -> Codex is transport-failed and RETRY is scheduled for t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // t=15s: a changed section push arrives (Claude updated), while Codex row updatedAt still predates failedAt (12s).
  await clock.advance(3_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start + 15_000, windows: [{ label: '7D', usedPct: 5 }] },
    ],
    { checkedAt: start + 15_000 }
  );
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // Scheduled recovery retry still fires automatically at t=27s and rolls Codex over.
  await clock.advance(RETRY - 3_000 - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a republished dashboard with a newer checkedAt and older untouched provider updatedAt does not exhaust that provider', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const resetCodex = start + 10_000;
  const rolledCodex = start + 18_010_000;
  const codexKey = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  const rows = (codexPct, codexReset, codexUpdatedAt, antigravityPct, antigravityUpdatedAt) => [
    {
      id: 'openai-oauth',
      authenticated: true,
      updatedAt: codexUpdatedAt,
      windows: [{ label: '5H', usedPct: codexPct, resetAt: codexReset }],
    },
    {
      id: 'antigravity-oauth',
      authenticated: true,
      updatedAt: antigravityUpdatedAt,
      windows: [{ label: '7D', usedPct: antigravityPct }],
    },
  ];

  let resolveEarly = null;
  let calls = 0;
  const host = sectionsHost({
    readCapabilities() {
      calls += 1;
      if (calls <= 3) {
        return Promise.resolve([
          { ok: true, value: { checkedAt: Date.now(), rows: rows(100, resetCodex, Date.now(), 40, start) } },
        ]);
      }
      if (calls === 4) {
        return new Promise((resolve) => {
          resolveEarly = () =>
            resolve([
              {
                ok: true,
                value: { checkedAt: start + 50_000, rows: rows(100, resetCodex, start + 50_000, 40, start) },
              },
            ]);
        });
      }
      return Promise.resolve([
        { ok: true, value: { checkedAt: Date.now(), rows: rows(0, rolledCodex, Date.now(), 15, Date.now()) } },
      ]);
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(rows(100, resetCodex, start, 40, start), { checkedAt: start });

  // t=12s (attempt 1), t=17s (attempt 2), t=32s (attempt 3 -> updatedAt=32s, nextDueAt=62s).
  await clock.advance(10_000 + RESET_SETTLE);
  await clock.advance(RESET_FOLLOWUPS[0]);
  await clock.advance(RESET_FOLLOWUPS[1]);
  assert.equal(calls, 3);

  // t=50s: unrelated forced refresh starts BEFORE Codex is due (t=62s).
  await clock.advance(18_000);
  const early = refreshUsageDashboard(host, { force: true });
  await clock.settle();
  assert.equal(calls, 4);

  // t=62s: Codex becomes due and awaits `early`; advance to t=62.5s.
  await clock.advance(12_500);
  assert.equal(calls, 4);

  // Daemon republishes dashboard on agent-quota change with newer checkedAt (62.5s) but cached Codex updatedAt (32s).
  host.push(rows(100, resetCodex, start + 32_000, 15, start + 62_500), { checkedAt: start + 62_500 });

  // `early` settles at t=63s (started at 50s < 62s); Codex must NOT have been exhausted by the republished checkedAt,
  // so pass 2 immediately issues Codex's real final follow-up (call 5) and rolls Codex over.
  await clock.advance(500);
  resolveEarly();
  await early;
  await clock.settle();

  assert.equal(calls, 5);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolledCodex);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(codexKey), false);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a slow pre-due push does not mask a rejecting due reset requests transport failure', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const rolled5h = start + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let rejectFirst = null;
  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve({
        value: {
          rows: [
            { id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }] },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push([{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }] }], {
    checkedAt: start,
  });

  // t=12s: due reset refresh starts (call 1, pending).
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);

  // t=13s: a slow pre-due push (checkedAt=11s < 12s) arrives while call 1 is in flight.
  await clock.advance(1_000);
  host.push([{ id: 'openai-oauth', authenticated: true, windows: [{ label: '5H', usedPct: 99, resetAt: reset5h }] }], {
    checkedAt: start + 11_000,
  });

  // t=14s: call 1 rejects; the pre-due push must NOT mask the transport failure or cause immediate rearming.
  await clock.advance(1_000);
  rejectFirst(new Error('offline'));
  await clock.settle();
  await clock.advance(0);

  assert.equal(calls, 1);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), false);

  // Recovery waits for the scheduled transport retry delay (+RETRY from t=14s -> t=29s) and rolls over.
  await clock.advance(RETRY - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a stale pre-failure publication during an in-flight recovery retry does not retire the recovery', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const rolled5h = start + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let resolveRecovery = null;
  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return new Promise((resolve) => {
        resolveRecovery = () =>
          resolve({
            value: {
              checkedAt: Date.now(),
              rows: [
                {
                  id: 'openai-oauth',
                  authenticated: true,
                  updatedAt: Date.now(),
                  windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }],
                },
              ],
            },
          });
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
    ],
    { checkedAt: start }
  );

  // t=10s: reset-credit mutation starts before the t=12s reset read fails.
  await clock.advance(10_000);
  const slowMutationStartedAt = Date.now();

  // t=12s: reset refresh fails -> transport-failed, recovery retry scheduled for t=27s.
  await clock.advance(RESET_SETTLE);
  assert.equal(calls, 1);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // t=27s: recovery retry fires and stays in flight.
  await clock.advance(RETRY);
  assert.equal(calls, 2);

  // t=28s: stale pre-failure mutation arrives while recovery is in flight; it must NOT retire the recovery.
  await clock.advance(1_000);
  publishUsageDashboard(
    {
      checkedAt: slowMutationStartedAt,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          updatedAt: slowMutationStartedAt,
          windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
        },
      ],
    },
    { readStartedAt: slowMutationStartedAt, providers: ['openai-oauth'] }
  );

  // t=29s: the in-flight 27s recovery resolves with rolled-over data and must be accepted.
  await clock.advance(1_000);
  resolveRecovery();
  await clock.settle();

  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('hiding and showing across a stale publication preserves an armed recovery retry deadline', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const rolled5h = start + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 5 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // t=12s: reset refresh fails -> transport-failed, recovery retry due at t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // t=14s: window hides.
  await clock.advance(2_000);
  clock.visibility('hidden');

  // t=15s: stale section push and stale mutation arrive while hidden.
  await clock.advance(1_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start + 15_000, windows: [{ label: '7D', usedPct: 5 }] },
    ],
    { checkedAt: start + 15_000 }
  );
  publishUsageDashboard(
    {
      checkedAt: start + 10_000,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          updatedAt: start + 10_000,
          windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
        },
        {
          id: 'anthropic-oauth',
          authenticated: true,
          updatedAt: start + 15_000,
          windows: [{ label: '7D', usedPct: 5 }],
        },
      ],
    },
    { readStartedAt: start + 10_000, providers: ['openai-oauth'] }
  );
  assert.equal(clock.timers.size, 0);

  // t=20s: window becomes visible before the original t=27s deadline -> retry is restored for t=27s.
  await clock.advance(5_000);
  clock.visibility('visible');
  await clock.advance(RETRY - 8_000 - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('releasing and reacquiring the last cadence holder restores a pending recovery retry', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const rolled5h = start + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }],
            },
          ],
        },
      });
    },
  });

  const release1 = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
    ],
    { checkedAt: start }
  );

  // t=12s: reset refresh fails -> transport-failed, recovery retry due at t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // t=15s: release the last cadence holder; all timers and listeners must drop.
  await clock.advance(3_000);
  release1();
  await clock.settle();
  assert.equal(idle(clock), 0);

  // t=20s: reacquire cadence holder; pending recovery retry must rearm for the original t=27s deadline.
  await clock.advance(5_000);
  const release2 = holdUsageDashboardCadence(host);
  await clock.settle();
  await clock.advance(RETRY - 8_000 - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release2();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a rejecting scoped auth refresh does not move an unrelated providers transport recovery deadline', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const rolled5h = start + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let calls = 0;
  const host = sectionsHost({
    invokeCapability(request) {
      calls += 1;
      const scoped = request?.args?.[0]?.refreshProviders;
      if (calls === 1) return Promise.reject(new Error('offline'));
      if (Array.isArray(scoped) && scoped.includes('anthropic-oauth')) {
        return Promise.reject(new Error('claude-auth-offline'));
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 10 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // t=12s: Codex reset refresh fails -> transport-failed, recovery retry due at t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // t=15s: scoped auth refresh for Claude rejects; its 15s retry (t=30s) must NOT push Codex's t=27s retry.
  await clock.advance(3_000);
  await refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  assert.equal(calls, 2);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // t=27s: Codex's recovery retry still fires on time at t=27s (NOT t=30s) and rolls Codex over.
  await clock.advance(RETRY - 3_000 - 1);
  assert.equal(calls, 2);
  await clock.advance(1);
  assert.equal(calls, 3);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  // Past t=30s: the unscoped t=27s recovery already satisfied Claude too, so no extra call fires at t=30s.
  await clock.advance(3_001);
  assert.equal(calls, 3);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('an unrelated changed section push during an in-flight recovery does not reset the bounded retry budget', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let rejectRecovery = null;
  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline-1'));
      if (calls === 2) {
        return new Promise((_resolve, reject) => {
          rejectRecovery = reject;
        });
      }
      return Promise.reject(new Error('unexpected-extra-retry'));
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // t=12s: initial reset refresh fails (call 1) -> recovery retry due at t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);

  // t=27s: single bounded recovery retry fires (call 2) and stays in flight.
  await clock.advance(RETRY);
  assert.equal(calls, 2);

  // t=28s: unrelated changed section push arrives while recovery is in flight (Claude updated, Codex still stale).
  await clock.advance(1_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start + 28_000, windows: [{ label: '7D', usedPct: 5 }] },
    ],
    { checkedAt: start + 28_000 }
  );

  // t=29s: call 2 rejects -> bounded retry budget is spent; no further retries may be armed.
  await clock.advance(1_000);
  rejectRecovery(new Error('offline-2'));
  await clock.settle();
  assert.equal(calls, 2);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // Advance well past RETRY and send another unrelated push -> strictly 2 calls total, never looping.
  await clock.advance(RETRY + 1_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start + 45_000, windows: [{ label: '7D', usedPct: 6 }] },
    ],
    { checkedAt: start + 45_000 }
  );
  await clock.advance(RETRY * 2);
  assert.equal(calls, 2);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('an older recovery returning a partial row with null updatedAt preserves a newer mutation for another provider', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const resetClaude = start + 10_000;
  const rolledClaude = start + 18_010_000;
  const resetCodex = start + 300_000;
  const rolledCodex = start + 18_300_000;

  let resolveClaudeRecovery = null;
  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return new Promise((resolve) => {
        resolveClaudeRecovery = () =>
          resolve({
            value: {
              checkedAt: start + 27_000,
              rows: [
                {
                  id: 'anthropic-oauth',
                  authenticated: true,
                  updatedAt: start + 29_000,
                  windows: [{ label: '5H', usedPct: 0, resetAt: rolledClaude }],
                },
                {
                  id: 'openai-oauth',
                  authenticated: true,
                  updatedAt: null,
                  windows: [{ label: '5H', usedPct: 100, resetAt: resetCodex }],
                },
              ],
            },
          });
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'anthropic-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetClaude }],
      },
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetCodex }],
      },
    ],
    { checkedAt: start }
  );

  // t=12s: Claude reset refresh fails -> transport-failed, recovery retry due at t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);

  // t=27s: Claude recovery retry starts (call 2, in flight).
  await clock.advance(RETRY);
  assert.equal(calls, 2);

  // t=28s: Codex reset-credit mutation publishes fresh windows & resetCredits while Claude recovery is in flight.
  await clock.advance(1_000);
  const codexCredits = { availableCredits: [{ id: 'credit-1', remaining: 1 }] };
  publishUsageDashboard(
    {
      checkedAt: start + 28_000,
      rows: [
        {
          id: 'anthropic-oauth',
          authenticated: true,
          updatedAt: start,
          windows: [{ label: '5H', usedPct: 100, resetAt: resetClaude }],
        },
        {
          id: 'openai-oauth',
          authenticated: true,
          updatedAt: start + 28_000,
          windows: [{ label: '5H', usedPct: 0, resetAt: rolledCodex }],
          resetCredits: codexCredits,
        },
      ],
    },
    { readStartedAt: start + 28_000, providers: ['openai-oauth'] }
  );

  // t=29s: older Claude recovery resolves with a partial Codex row (updatedAt: null); Codex mutation stays intact.
  await clock.advance(1_000);
  resolveClaudeRecovery();
  await clock.settle();

  assert.equal(calls, 2);
  const claude = rowsOf().find((row) => row.id === 'anthropic-oauth');
  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(claude.windows[0].usedPct, 0);
  assert.equal(claude.windows[0].resetAt, rolledClaude);
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, rolledCodex);
  assert.deepEqual(codex.resetCredits, codexCredits);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('releasing and re-holding cadence during an in-flight recovery retry does not bypass the retry limit', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return new Promise(() => undefined);
    },
  });

  const release1 = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
    ],
    { checkedAt: start }
  );

  // t=12s: initial reset refresh fails (call 1) -> recovery retry scheduled for t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);

  // t=27s: single bounded recovery retry dispatches (call 2, stays in flight) and charges the budget immediately.
  await clock.advance(RETRY);
  assert.equal(calls, 2);

  // t=28s: release and re-hold cadence while call 2 is in flight -> must NOT dispatch a 3rd retry.
  await clock.advance(1_000);
  release1();
  await clock.settle();
  assert.equal(idle(clock), 0);
  const release2 = holdUsageDashboardCadence(host);
  await clock.settle();
  assert.equal(calls, 2);

  // t=29s: release and re-hold again -> still strictly 2 calls total.
  await clock.advance(1_000);
  release2();
  await clock.settle();
  const release3 = holdUsageDashboardCadence(host);
  await clock.settle();
  await clock.advance(RETRY * 2);
  assert.equal(calls, 2);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  release3();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a non-forced refresh respects transport-failed backoff and spent retry budget while force still runs', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const rolled5h = start + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls <= 2) return Promise.reject(new Error(`offline-${calls}`));
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
    ],
    { checkedAt: start }
  );

  // t=12s: reset refresh fails (call 1) -> transport-failed, retry due at t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);

  // t=20s: normal rail remount (non-forced refresh) must NOT bypass the t=27s backoff.
  await clock.advance(8_000);
  await refreshUsageDashboard(host);
  assert.equal(calls, 1);

  // t=27s: scheduled recovery retry fires (call 2) and also fails -> retry budget is now spent.
  await clock.advance(RETRY - 8_000);
  assert.equal(calls, 2);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // t=28s: normal remount (non-forced refresh) must NOT fire once the retry budget is spent.
  await clock.advance(1_000);
  await refreshUsageDashboard(host);
  assert.equal(calls, 2);

  // Explicit forced refresh still runs normally and recovers the window.
  await refreshUsageDashboard(host, { force: true });
  assert.equal(calls, 3);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('an unrelated push and concurrent other-provider refresh preserve a failed scoped auth retry', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();

  let resolveCodex = null;
  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('claude-auth-offline'));
      if (requests.length === 2) {
        return new Promise((resolve) => {
          resolveCodex = () =>
            resolve({
              value: {
                checkedAt: Date.now(),
                rows: [
                  {
                    id: 'openai-oauth',
                    authenticated: true,
                    updatedAt: Date.now(),
                    windows: [{ label: '5H', usedPct: 12 }],
                  },
                  {
                    id: 'anthropic-oauth',
                    authenticated: true,
                    updatedAt: start,
                    windows: [{ label: '7D', usedPct: 20 }],
                  },
                ],
              },
            });
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 12 }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 3 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      { id: 'openai-oauth', authenticated: true, updatedAt: start, windows: [{ label: '5H', usedPct: 30 }] },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // t=5s: scoped auth refresh for Claude rejects -> retry armed for t=20s.
  await clock.advance(5_000);
  await refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=10s: unrelated section push updates Codex while Claude stays stale -> must NOT cancel Claude's retry.
  await clock.advance(5_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start + 10_000,
        windows: [{ label: '5H', usedPct: 25 }],
      },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start + 10_000 }
  );

  // t=19s: another provider's scoped refresh (Codex) starts and stays in flight across t=20s.
  await clock.advance(9_000);
  const codexRefresh = refreshUsageDashboard(host, { force: true, providers: ['openai-oauth'] });
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth']]);

  // t=20s: Claude's retry timer fires while Codex's scoped refresh is in flight -> deferred, not dropped.
  await clock.advance(1_000);
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth']]);

  // t=21s: Codex's refresh settles -> deferred Claude scoped retry runs immediately and refreshes Claude.
  await clock.advance(1_000);
  resolveCodex();
  await codexRefresh;
  await clock.settle();

  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth'], ['anthropic-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].usedPct, 3);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a successful same-provider scoped refresh cancels its armed auth retry', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();

  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('claude-auth-offline'));
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 4 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [{ id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] }],
    { checkedAt: start }
  );

  // t=0s: scoped auth refresh for Claude rejects -> retry armed for t=15s.
  await refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=5s: a successful same-provider scoped refresh covers Claude and cancels the t=15s retry.
  await clock.advance(5_000);
  await refreshUsageDashboard(host, { force: true, providers: ['anthropic-oauth'] });
  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth']]);
  assert.equal(rowsOf()[0].windows[0].usedPct, 4);

  // Past t=15s: no redundant retry fires.
  await clock.advance(RETRY * 2);
  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth']]);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a recovery started after a credit-reset mutation started still preserves the mutation once committed', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const resetClaude = start + 10_000;
  const rolledClaude = start + 18_010_000;
  const resetCodex = start + 300_000;
  const rolledCodex = start + 18_300_000;

  let resolveClaudeRecovery = null;
  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return new Promise((resolve) => {
        resolveClaudeRecovery = () =>
          resolve({
            value: {
              checkedAt: start + 27_000,
              rows: [
                {
                  id: 'anthropic-oauth',
                  authenticated: true,
                  updatedAt: start + 29_000,
                  windows: [{ label: '5H', usedPct: 0, resetAt: rolledClaude }],
                },
                {
                  id: 'openai-oauth',
                  authenticated: true,
                  updatedAt: null,
                  windows: [{ label: '5H', usedPct: 100, resetAt: resetCodex }],
                },
              ],
            },
          });
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'anthropic-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetClaude }],
      },
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetCodex }],
      },
    ],
    { checkedAt: start }
  );

  // t=12s: Claude reset refresh fails -> transport-failed, recovery retry due at t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);

  // t=26s: Codex credit-reset mutation starts BEFORE Claude recovery starts at t=27s.
  await clock.advance(RETRY - 1_000);
  const mutationStartedAt = Date.now();

  // t=27s: Claude recovery starts (call 2, in flight).
  await clock.advance(1_000);
  assert.equal(calls, 2);

  // t=28s: Codex mutation commits rolled windows & resetCredits with readStartedAt=26s.
  await clock.advance(1_000);
  const codexCredits = { availableCredits: [{ id: 'credit-2', remaining: 1 }] };
  publishUsageDashboard(
    {
      checkedAt: start + 28_000,
      rows: [
        {
          id: 'anthropic-oauth',
          authenticated: true,
          updatedAt: start,
          windows: [{ label: '5H', usedPct: 100, resetAt: resetClaude }],
        },
        {
          id: 'openai-oauth',
          authenticated: true,
          updatedAt: start + 28_000,
          windows: [{ label: '5H', usedPct: 0, resetAt: rolledCodex }],
          resetCredits: codexCredits,
        },
      ],
    },
    { readStartedAt: mutationStartedAt, providers: ['openai-oauth'] }
  );

  // t=29s: Claude recovery resolves with updatedAt: null for Codex -> confirmed Codex reset stays intact.
  await clock.advance(1_000);
  resolveClaudeRecovery();
  await clock.settle();

  assert.equal(calls, 2);
  const claude = rowsOf().find((row) => row.id === 'anthropic-oauth');
  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(claude.windows[0].usedPct, 0);
  assert.equal(claude.windows[0].resetAt, rolledClaude);
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, rolledCodex);
  assert.deepEqual(codex.resetCredits, codexCredits);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('an overdue rail remount adopted by the reset scheduler does not spawn an unbudgeted third transport read', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let rejectSecond = null;
  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline-1'));
      if (calls === 2) {
        return new Promise((_resolve, reject) => {
          rejectSecond = reject;
        });
      }
      return Promise.reject(new Error('unexpected-third-read'));
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
    ],
    { checkedAt: start }
  );

  // t=12s: initial reset refresh fails (call 1) -> transport-failed, retry due at t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);

  // t=20s: window hides so the t=27s timer is paused.
  await clock.advance(8_000);
  clock.visibility('hidden');

  // t=30s: overdue rail remount starts a non-forced refresh (call 2), then window becomes visible
  // so syncResetRefresh / runResetRefresh runs while call 2 is in flight.
  await clock.advance(10_000);
  const remount = refreshUsageDashboard(host);
  await clock.settle();
  assert.equal(calls, 2);

  clock.visibility('visible');
  await clock.advance(0);
  assert.equal(calls, 2);

  // t=31s: call 2 rejects -> budget is spent and ordinary retry is suppressed; no 3rd read ever fires.
  await clock.advance(1_000);
  rejectSecond(new Error('offline-2'));
  await remount;
  await clock.settle();

  await clock.advance(RETRY * 2);
  assert.equal(calls, 2);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a non-forced refresh after snapshot TTL expiry still respects transport backoff and spent retry budget', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 6 * 60_000;
  const rolled5h = start + 18_360_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls <= 2) return Promise.reject(new Error(`offline-${calls}`));
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
    ],
    { checkedAt: start }
  );

  // t=6m+2s (past 5m TTL): initial reset read fails (call 1) -> retry due at t=6m+17s.
  await clock.advance(6 * 60_000 + RESET_SETTLE);
  assert.equal(calls, 1);

  // t=6m+5s (during backoff, past TTL): non-forced refresh must NOT bypass backoff.
  await clock.advance(3_000);
  await refreshUsageDashboard(host);
  assert.equal(calls, 1);

  // t=6m+17s: budgeted recovery retry fires (call 2) and rejects -> retry budget is spent.
  await clock.advance(RETRY - 3_000);
  assert.equal(calls, 2);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // t=6m+18s (past TTL, budget spent): non-forced refresh must NOT dispatch read 3.
  await clock.advance(1_000);
  await refreshUsageDashboard(host);
  assert.equal(calls, 2);

  // Explicit forced refresh still works and rolls the window over.
  await refreshUsageDashboard(host, { force: true });
  assert.equal(calls, 3);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a second providers auth refresh does not cancel the first providers pending retry', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();

  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('claude-auth-offline'));
      if (Array.isArray(scoped) && scoped.includes('openai-oauth')) {
        return Promise.resolve({
          value: {
            checkedAt: Date.now(),
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                updatedAt: Date.now(),
                windows: [{ label: '5H', usedPct: 7 }],
              },
              {
                id: 'anthropic-oauth',
                authenticated: true,
                updatedAt: start,
                windows: [{ label: '7D', usedPct: 20 }],
              },
            ],
          },
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 7 }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 2 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      { id: 'openai-oauth', authenticated: true, updatedAt: start, windows: [{ label: '5H', usedPct: 30 }] },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // t=0s: Claude auth refresh fails -> Claude retry armed for t=15s.
  await refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=5s: Codex auth refresh runs and succeeds -> must NOT cancel Claude's t=15s retry.
  await clock.advance(5_000);
  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 7);

  // t=15s: Claude's retry still fires on time and refreshes Claude.
  await clock.advance(RETRY - 5_000 - 1);
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth']]);
  await clock.advance(1);
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth'], ['anthropic-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].usedPct, 2);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a failing overlapping same-provider refresh crossing the deadline does not cancel the pending retry', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();

  let rejectManual = null;
  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('claude-auth-offline'));
      if (requests.length === 2) {
        return new Promise((_resolve, reject) => {
          rejectManual = reject;
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 1 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [{ id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] }],
    { checkedAt: start }
  );

  // t=0s: Claude auth refresh fails -> Claude retry armed for t=15s.
  await refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=10s: manual Claude refresh starts and stays in flight across the t=15s retry deadline.
  await clock.advance(10_000);
  const manual = refreshUsageDashboard(host, { force: true, providers: ['anthropic-oauth'] });
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth']]);

  // t=15s: deadline crosses while manual refresh is still in flight -> retry stays deferred, not dropped.
  await clock.advance(5_000);
  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth']]);

  // t=16s: manual refresh rejects -> deferred Claude retry fires immediately and recovers Claude.
  await clock.advance(1_000);
  rejectManual(new Error('manual-offline'));
  await manual;
  await clock.settle();

  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth'], ['anthropic-oauth']]);
  assert.equal(rowsOf()[0].windows[0].usedPct, 1);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('two providers failing auth refreshes both receive their own independent retries', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();

  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      if (requests.length <= 2) return Promise.reject(new Error(`offline-${requests.length}`));
      if (Array.isArray(scoped) && scoped.includes('anthropic-oauth')) {
        return Promise.resolve({
          value: {
            checkedAt: Date.now(),
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                updatedAt: start,
                windows: [{ label: '5H', usedPct: 30 }],
              },
              {
                id: 'anthropic-oauth',
                authenticated: true,
                updatedAt: Date.now(),
                windows: [{ label: '7D', usedPct: 2 }],
              },
            ],
          },
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 4 }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 2 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      { id: 'openai-oauth', authenticated: true, updatedAt: start, windows: [{ label: '5H', usedPct: 30 }] },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // t=0s: Claude auth refresh fails -> Claude retry armed for t=15s.
  await refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=5s: Codex auth refresh fails -> Codex ALSO gets its own retry armed for t=20s.
  await clock.advance(5_000);
  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth']]);

  // t=15s: Claude retry fires on time.
  await clock.advance(RETRY - 5_000 - 1);
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth']]);
  await clock.advance(1);
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth'], ['anthropic-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].usedPct, 2);

  // t=20s: Codex retry fires on time.
  await clock.advance(5_000 - 1);
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth'], ['anthropic-oauth']]);
  await clock.advance(1);
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth'], ['anthropic-oauth'], ['openai-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 4);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a confirmed mutation started before a transport failure is preserved when recovery returns null updatedAt', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const rolled5h = start + 18_010_000;

  let resolveRecovery = null;
  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return new Promise((resolve) => {
        resolveRecovery = () =>
          resolve({
            value: {
              checkedAt: start + 27_000,
              rows: [
                {
                  id: 'openai-oauth',
                  authenticated: true,
                  updatedAt: null,
                  windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
                },
              ],
            },
          });
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
    ],
    { checkedAt: start }
  );

  // t=10s: Codex credit-reset mutation starts BEFORE the t=12s transport failure.
  await clock.advance(10_000);
  const mutationStartedAt = Date.now();

  // t=12s: Codex reset refresh fails -> transport-failed, recovery retry due at t=27s.
  await clock.advance(RESET_SETTLE);
  assert.equal(calls, 1);

  // t=27s: recovery starts (call 2, in flight).
  await clock.advance(RETRY);
  assert.equal(calls, 2);

  // t=28s: Codex mutation commits confirmed 0% windows & resetCredits.
  await clock.advance(1_000);
  const codexCredits = { availableCredits: [{ id: 'credit-r8-1', remaining: 1 }] };
  publishUsageDashboard(
    {
      checkedAt: start + 28_000,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          updatedAt: start + 28_000,
          windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }],
          resetCredits: codexCredits,
        },
      ],
    },
    { readStartedAt: mutationStartedAt, providers: ['openai-oauth'] }
  );

  // t=29s: recovery resolves with updatedAt: null and stale 100% -> confirmed commit stays intact.
  await clock.advance(1_000);
  resolveRecovery();
  await clock.settle();

  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.deepEqual(rowsOf()[0].resetCredits, codexCredits);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a partial recovery row stamped after a confirmed commit does not overwrite the commit or drop resetCredits', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const resetClaude = start + 10_000;
  const rolledClaude = start + 18_010_000;
  const resetCodex = start + 300_000;
  const rolledCodex = start + 18_300_000;

  let resolveClaudeRecovery = null;
  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return new Promise((resolve) => {
        resolveClaudeRecovery = () =>
          resolve({
            value: {
              checkedAt: start + 29_000,
              rows: [
                {
                  id: 'anthropic-oauth',
                  authenticated: true,
                  updatedAt: start + 29_000,
                  windows: [{ label: '5H', usedPct: 0, resetAt: rolledClaude }],
                },
                {
                  id: 'openai-oauth',
                  authenticated: true,
                  status: 'partial',
                  updatedAt: start + 29_000,
                  windows: [{ label: '5H', usedPct: 100, resetAt: resetCodex }],
                },
              ],
            },
          });
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'anthropic-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetClaude }],
      },
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetCodex }],
      },
    ],
    { checkedAt: start }
  );

  // t=12s: Claude reset refresh fails -> transport-failed, recovery retry due at t=27s.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);

  // t=26s: Codex mutation starts; t=27s: Claude recovery starts; t=28s: Codex mutation commits.
  await clock.advance(RETRY - 1_000);
  const mutationStartedAt = Date.now();
  await clock.advance(1_000);
  assert.equal(calls, 2);

  await clock.advance(1_000);
  const codexCredits = { availableCredits: [{ id: 'credit-r8-2', remaining: 1 }] };
  publishUsageDashboard(
    {
      checkedAt: start + 28_000,
      rows: [
        {
          id: 'anthropic-oauth',
          authenticated: true,
          updatedAt: start,
          windows: [{ label: '5H', usedPct: 100, resetAt: resetClaude }],
        },
        {
          id: 'openai-oauth',
          authenticated: true,
          updatedAt: start + 28_000,
          windows: [{ label: '5H', usedPct: 0, resetAt: rolledCodex }],
          resetCredits: codexCredits,
        },
      ],
    },
    { readStartedAt: mutationStartedAt, providers: ['openai-oauth'] }
  );

  // t=29s: recovery started at 27s returns a partial Codex row stamped 29s -> Codex commit stays intact.
  await clock.advance(1_000);
  resolveClaudeRecovery();
  await clock.settle();

  const claude = rowsOf().find((row) => row.id === 'anthropic-oauth');
  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(claude.windows[0].usedPct, 0);
  assert.equal(claude.windows[0].resetAt, rolledClaude);
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, rolledCodex);
  assert.deepEqual(codex.resetCredits, codexCredits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a scoped auth refresh for another provider re-queues an in-flight auth retry instead of dropping it', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();

  let resolveRetiredClaude = null;
  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('claude-auth-offline'));
      if (requests.length === 2) {
        return new Promise((resolve) => {
          resolveRetiredClaude = () =>
            resolve({
              value: {
                checkedAt: Date.now(),
                rows: [
                  {
                    id: 'openai-oauth',
                    authenticated: true,
                    updatedAt: start,
                    windows: [{ label: '5H', usedPct: 30 }],
                  },
                  {
                    id: 'anthropic-oauth',
                    authenticated: true,
                    updatedAt: Date.now(),
                    windows: [{ label: '7D', usedPct: 99 }],
                  },
                ],
              },
            });
        });
      }
      if (Array.isArray(scoped) && scoped.includes('openai-oauth')) {
        return Promise.resolve({
          value: {
            checkedAt: Date.now(),
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                updatedAt: Date.now(),
                windows: [{ label: '5H', usedPct: 6 }],
              },
              { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
            ],
          },
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 6 }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 1 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      { id: 'openai-oauth', authenticated: true, updatedAt: start, windows: [{ label: '5H', usedPct: 30 }] },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // t=0s: Claude auth refresh fails -> Claude retry armed for t=15s.
  await refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=15s: Claude's auth retry dispatches and stays in flight.
  await clock.advance(RETRY);
  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth']]);

  // t=16s: Codex reauthenticates while Claude's retry is in flight -> Codex runs, then Claude's retry runs.
  await clock.advance(1_000);
  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  await clock.settle();

  // Late resolution of retired Claude retry is ignored; replacement Claude retry refreshed Claude to 1%.
  resolveRetiredClaude();
  await clock.settle();

  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth'], ['openai-oauth'], ['anthropic-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 6);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].usedPct, 1);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a scoped auth refresh runs its own provider instead of adopting another providers overdue retry', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();

  let resolveGlobal = null;
  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('claude-auth-offline'));
      if (requests.length === 2) {
        return new Promise((resolve) => {
          resolveGlobal = () =>
            resolve({
              value: {
                checkedAt: start + 14_000,
                rows: [
                  {
                    id: 'openai-oauth',
                    authenticated: true,
                    updatedAt: start,
                    windows: [{ label: '5H', usedPct: 30 }],
                  },
                  {
                    id: 'anthropic-oauth',
                    authenticated: true,
                    updatedAt: start,
                    windows: [{ label: '7D', usedPct: 20 }],
                  },
                ],
              },
            });
        });
      }
      if (Array.isArray(scoped) && scoped.includes('openai-oauth')) {
        return Promise.resolve({
          value: {
            checkedAt: Date.now(),
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                updatedAt: Date.now(),
                windows: [{ label: '5H', usedPct: 8 }],
              },
              { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
            ],
          },
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 8 }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 2 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      { id: 'openai-oauth', authenticated: true, updatedAt: start, windows: [{ label: '5H', usedPct: 30 }] },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // t=0s: Claude auth refresh fails -> Claude retry armed for t=15s.
  await refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=14s: global refresh starts and stays in flight past t=15s so Claude's retry becomes overdue.
  await clock.advance(RETRY - 1_000);
  const globalRefresh = refreshUsageDashboard(host, { force: true });
  await clock.settle();
  await clock.advance(2_000);
  assert.deepEqual(requests, [['anthropic-oauth'], undefined]);

  // t=16s: Codex reauthenticates -> must dispatch Codex FIRST (never adopt Claude's overdue retry),
  // and once Codex settles, Claude's overdue retry runs too.
  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  await clock.settle();
  resolveGlobal();
  await globalRefresh;
  await clock.settle();

  assert.deepEqual(requests, [['anthropic-oauth'], undefined, ['openai-oauth'], ['anthropic-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 8);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].usedPct, 2);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a rail mount after reset settlement that rejects before the 0ms reset timer fires still stays within 2 transport reads', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      return Promise.reject(new Error(`offline-${calls}`));
    },
  });

  // Seed dashboard at t=0s without cadence held yet.
  publishUsageDashboard({
    checkedAt: start,
    rows: [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
    ],
  });

  // t=13s (past resetAt + RESET_SETTLE = 12s): cadence mounts (scheduling 0ms timer) AND rail mount
  // calls non-forced refreshUsageDashboard in the same tick, which rejects immediately before 0ms fires.
  await clock.advance(13_000);
  const release = holdUsageDashboardCadence(host);
  await refreshUsageDashboard(host);
  await clock.advance(0);
  assert.equal(calls, 1);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // t=28s (+RETRY): exactly 1 bounded transport retry fires (call 2) and rejects -> strictly 2 reads total.
  await clock.advance(RETRY - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  await clock.advance(RETRY * 2);
  assert.equal(calls, 2);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a post-TTL non-forced refresh respects a spent transport budget while another provider awaits a future skew follow-up', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const resetA = start + 360_000;
  const resetB = start + 378_000;
  const rolledB = start + 18_378_000;

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      // t=362s (A initial) and t=377s (A retry) both fail; t=380s (B initial) succeeds with stale B -> nextDueAt=385s.
      if (calls <= 2) return Promise.reject(new Error(`offline-${calls}`));
      if (calls === 3) {
        return Promise.resolve({
          value: {
            checkedAt: Date.now(),
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                updatedAt: start,
                windows: [{ label: '5H', usedPct: 100, resetAt: resetA }],
              },
              {
                id: 'anthropic-oauth',
                authenticated: true,
                updatedAt: Date.now(),
                windows: [{ label: '5H', usedPct: 100, resetAt: resetB }],
              },
            ],
          },
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: start,
              windows: [{ label: '5H', usedPct: 100, resetAt: resetA }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 0, resetAt: rolledB }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetA }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetB }],
      },
    ],
    { checkedAt: start }
  );

  // t=362s (past 5m TTL): A initial reset read fails (call 1) -> retry due at t=377s.
  await clock.advance(360_000 + RESET_SETTLE);
  assert.equal(calls, 1);

  // t=377s: A recovery retry fails (call 2) -> A's transport budget is spent; refreshedAt is still start (past TTL).
  await clock.advance(RETRY);
  assert.equal(calls, 2);

  // t=379s (past 5m TTL; A budget spent, B elapsed at 378s awaiting settle at 380s): non-forced refresh must NOT fire.
  await clock.advance(2_000);
  await refreshUsageDashboard(host);
  assert.equal(calls, 2);

  // t=380s (resetB + RESET_SETTLE): B's first settle read succeeds with stale B -> B scheduled for t=385s (+5s).
  await clock.advance(1_000);
  assert.equal(calls, 3);

  // t=381s (B waiting for future skew follow-up at t=385s): non-forced refresh must NOT fire early.
  await clock.advance(1_000);
  await refreshUsageDashboard(host);
  assert.equal(calls, 3);

  // t=385s: B's scheduled skew follow-up fires on time (call 4) and rolls B over.
  await clock.advance(4_000 - 1);
  assert.equal(calls, 3);
  await clock.advance(1);
  assert.equal(calls, 4);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].usedPct, 0);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].resetAt, rolledB);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a section push with null updatedAt or unrolled partial row does not undo a confirmed reset commit', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const resetCodex = start + 300_000;
  const rolledCodex = start + 18_300_000;

  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetCodex }],
      },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // t=28s: Codex credit-reset mutation commits rolled windows & resetCredits.
  await clock.advance(28_000);
  const codexCredits = { availableCredits: [{ id: 'credit-r9-1', remaining: 1 }] };
  publishUsageDashboard(
    {
      checkedAt: start + 28_000,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          updatedAt: start + 28_000,
          windows: [{ label: '5H', usedPct: 0, resetAt: rolledCodex }],
          resetCredits: codexCredits,
        },
        { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
      ],
    },
    { readStartedAt: start + 26_000, providers: ['openai-oauth'] }
  );

  // t=29s: changed section push arrives with updatedAt: null for Codex -> commit & resetCredits stay intact.
  await clock.advance(1_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: null,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetCodex }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        updatedAt: start + 29_000,
        windows: [{ label: '7D', usedPct: 18 }],
      },
    ],
    { checkedAt: start + 29_000 }
  );
  let codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, rolledCodex);
  assert.deepEqual(codex.resetCredits, codexCredits);

  // t=30s: changed section push arrives with status: 'partial' unrolled row -> commit & resetCredits stay intact.
  await clock.advance(1_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        updatedAt: start + 30_000,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetCodex }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        updatedAt: start + 30_000,
        windows: [{ label: '7D', usedPct: 17 }],
      },
    ],
    { checkedAt: start + 30_000 }
  );
  codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, rolledCodex);
  assert.deepEqual(codex.resetCredits, codexCredits);

  // t=31s: changed section push arrives with status: 'partial' same window dropping resetCredits -> commit stays intact.
  await clock.advance(1_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        updatedAt: start + 31_000,
        windows: [{ label: '5H', usedPct: 0, resetAt: rolledCodex }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        updatedAt: start + 31_000,
        windows: [{ label: '7D', usedPct: 16 }],
      },
    ],
    { checkedAt: start + 31_000 }
  );
  codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, rolledCodex);
  assert.deepEqual(codex.resetCredits, codexCredits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a valid status partial OAuth rollover during the last recovery is accepted after a pre-failure mutation echo', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const rolled5h = start + 18_010_000;

  let resolveRecovery = null;
  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('offline'));
      return new Promise((resolve) => {
        resolveRecovery = () =>
          resolve({
            value: {
              checkedAt: start + 29_000,
              rows: [
                {
                  id: 'openai-oauth',
                  authenticated: true,
                  status: 'partial',
                  updatedAt: start + 29_000,
                  windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }],
                },
              ],
            },
          });
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
      },
    ],
    { checkedAt: start }
  );

  // t=10s: pre-failure mutation starts; t=12s: reset read fails -> transport-failed, retry due at t=27s.
  await clock.advance(10_000);
  const mutationStartedAt = Date.now();
  await clock.advance(RESET_SETTLE);
  assert.equal(calls, 1);

  // t=27s: last recovery attempt starts (in flight).
  await clock.advance(RETRY);
  assert.equal(calls, 2);

  // t=28s: pre-failure mutation echoes the expired 100% window.
  await clock.advance(1_000);
  publishUsageDashboard(
    {
      checkedAt: mutationStartedAt,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          updatedAt: mutationStartedAt,
          windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
        },
      ],
    },
    { readStartedAt: mutationStartedAt, providers: ['openai-oauth'] }
  );

  // t=29s: recovery resolves with valid OAuth status: 'partial' rolled windows -> accepted cleanly.
  await clock.advance(1_000);
  resolveRecovery();
  await clock.settle();

  assert.equal(calls, 2);
  assert.equal(rowsOf()[0].status, 'partial');
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a cold-cache reload with persisted rows respects transport backoff and spent retry budget on non-forced refresh', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const rolled5h = start + 18_010_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  // Seed persisted localStorage cache directly before first store access so refreshedAt stays 0.
  clock.storage.set(
    CACHE_KEY,
    JSON.stringify({
      checkedAt: start,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          updatedAt: start,
          windows: [{ label: '5H', usedPct: 100, resetAt: reset5h }],
        },
      ],
    })
  );

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls <= 2) return Promise.reject(new Error(`offline-${calls}`));
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 0, resetAt: rolled5h }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  assert.equal(getUsageDashboardSnapshot().refreshedAt, 0);

  // t=12s: first reset read fails (call 1) -> transport-failed, backoff until t=27s, refreshedAt still 0.
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  assert.equal(getUsageDashboardSnapshot().refreshedAt, 0);

  // t=20s: popup open (non-forced refresh) during cold-cache backoff must NOT fire early.
  await clock.advance(8_000);
  await refreshUsageDashboard(host);
  assert.equal(calls, 1);

  // t=27s: budgeted recovery retry fires (call 2) and rejects -> budget spent, refreshedAt still 0.
  await clock.advance(RETRY - 8_000);
  assert.equal(calls, 2);
  assert.equal(getUsageDashboardSnapshot().refreshedAt, 0);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // t=28s: popup open (non-forced refresh) on cold cache must NOT dispatch a 3rd read.
  await clock.advance(1_000);
  await refreshUsageDashboard(host);
  assert.equal(calls, 2);

  // Explicit forced refresh still runs and recovers.
  await refreshUsageDashboard(host, { force: true });
  assert.equal(calls, 3);
  assert.equal(rowsOf()[0].windows[0].usedPct, 0);
  assert.equal(rowsOf()[0].windows[0].resetAt, rolled5h);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a due reset waits for an in-flight scoped refresh for another provider instead of adopting it', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const resetB = start + 10_000;
  const rolledB = start + 18_010_000;

  let resolveScopedA = null;
  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      if (requests.length === 1) {
        return new Promise((resolve) => {
          resolveScopedA = () =>
            resolve({
              value: {
                checkedAt: Date.now(),
                rows: [
                  {
                    id: 'anthropic-oauth',
                    authenticated: true,
                    updatedAt: Date.now(),
                    windows: [{ label: '7D', usedPct: 5 }],
                  },
                ],
              },
            });
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 5 }],
            },
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 0, resetAt: rolledB }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: resetB }],
      },
    ],
    { checkedAt: start }
  );

  // t=11s: scoped refresh for A starts and stays in flight across B's t=12s reset settle time.
  await clock.advance(11_000);
  const scopedA = refreshUsageDashboard(host, { force: true, providers: ['anthropic-oauth'] });
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=12s: B's reset becomes due while A's scoped refresh is in flight -> waits for A, does not adopt A.
  await clock.advance(1_000);
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=13s: A resolves with NO reset window for B -> B's unscoped reset read still runs cleanly and rolls B over.
  await clock.advance(1_000);
  resolveScopedA();
  await scopedA;
  await clock.settle();

  assert.deepEqual(requests, [['anthropic-oauth'], undefined]);
  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, rolledB);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('a forced global refresh queued behind a hung scoped request wakes and completes when another auth refresh retires it', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();

  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      if (requests.length === 1) {
        // Hung scoped A request that never settles on its own.
        return new Promise(() => undefined);
      }
      if (Array.isArray(scoped) && scoped.includes('openai-oauth')) {
        return Promise.resolve({
          value: {
            checkedAt: Date.now(),
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                updatedAt: Date.now(),
                windows: [{ label: '5H', usedPct: 9 }],
              },
              { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
            ],
          },
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 9 }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 1 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      { id: 'openai-oauth', authenticated: true, updatedAt: start, windows: [{ label: '5H', usedPct: 30 }] },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // Start hung scoped A refresh, then queue a forced global refresh behind it.
  void refreshUsageDashboard(host, { force: true, providers: ['anthropic-oauth'] });
  await clock.settle();
  let globalResolved = false;
  const globalReq = refreshUsageDashboard(host, { force: true }).then(() => {
    globalResolved = true;
  });

  // B reauthenticates, retiring hung A -> queued globalReq must wake up after B and resolve cleanly.
  await clock.advance(1_000);
  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  await globalReq;
  await clock.settle();

  assert.equal(globalResolved, true);
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth'], undefined]);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 9);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].usedPct, 1);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('hiding the window while another auth refresh settles preserves a re-queued providers auth recovery until visible', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();

  let resolveB = null;
  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('claude-auth-offline'));
      if (requests.length === 2) return new Promise(() => undefined);
      if (requests.length === 3) {
        return new Promise((resolve) => {
          resolveB = () =>
            resolve({
              value: {
                checkedAt: Date.now(),
                rows: [
                  {
                    id: 'openai-oauth',
                    authenticated: true,
                    updatedAt: Date.now(),
                    windows: [{ label: '5H', usedPct: 7 }],
                  },
                  {
                    id: 'anthropic-oauth',
                    authenticated: true,
                    updatedAt: start,
                    windows: [{ label: '7D', usedPct: 20 }],
                  },
                ],
              },
            });
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 7 }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 2 }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      { id: 'openai-oauth', authenticated: true, updatedAt: start, windows: [{ label: '5H', usedPct: 30 }] },
      { id: 'anthropic-oauth', authenticated: true, updatedAt: start, windows: [{ label: '7D', usedPct: 20 }] },
    ],
    { checkedAt: start }
  );

  // t=0s: A auth refresh fails -> retry armed for t=15s.
  await refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=15s: A retry dispatches and stays in flight.
  await clock.advance(RETRY);
  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth']]);

  // t=16s: B reauthenticates (re-queuing A in retryStates) and stays in flight.
  await clock.advance(1_000);
  const authB = refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth'], ['openai-oauth']]);

  // t=17s: window hides, then B settles while hidden -> A must NOT dispatch while hidden and must NOT be dropped.
  await clock.advance(1_000);
  clock.visibility('hidden');
  resolveB();
  await authB;
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth'], ['openai-oauth']]);
  assert.equal(clock.timers.size, 0);

  // t=25s: returning to the window dispatches A's preserved auth recovery promptly.
  await clock.advance(8_000);
  clock.visibility('visible');
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth'], ['openai-oauth'], ['anthropic-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].usedPct, 2);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('future deadline jitter on a partial push is not mistaken for a window rollover', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;
  const credits = { availableCount: 1, offerRevision: 'codex-rev-1' };

  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  clock.advance(1_000);
  publishUsageDashboard(
    {
      checkedAt: Date.now(),
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: Date.now(),
          resetCredits: credits,
          windows: [{ label: '5H', usedPct: 0, resetAt: futureReset }],
        },
      ],
    },
    { readStartedAt: start + 500, providers: ['openai-oauth'] }
  );

  // Newer partial push with +250ms jitter on a still-future resetAt must not overwrite the confirmed reset.
  clock.advance(1_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        updatedAt: Date.now(),
        windows: [{ label: '5H', usedPct: 100, resetAt: futureReset + 250 }],
      },
    ],
    { checkedAt: Date.now() }
  );
  await clock.settle();

  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, futureReset);
  assert.deepEqual(codex.resetCredits, credits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('reloaded cache stays protected against stale updatedAt: null section replay for the same account', async (t) => {
  const clock1 = createRendererClock();
  bindEpoch(t, clock1);
  const start = Date.now();
  const futureReset = start + 300_000;
  const credits = { availableCount: 2, offerRevision: 'codex-reload-rev' };

  const committedAt = start + 1_000;
  clock1.advance(1_000);
  publishUsageDashboard(
    {
      checkedAt: committedAt,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          credentialStamp: 'acc-1',
          updatedAt: committedAt,
          resetCredits: credits,
          windows: [{ label: '5H', usedPct: 0, resetAt: futureReset }],
        },
      ],
    },
    { readStartedAt: start + 500, providers: ['openai-oauth'] }
  );
  const persisted = clock1.storage.get(CACHE_KEY);
  assert.ok(persisted);

  // Simulate renderer reload with a new window (clearing in-memory providerPublished) but surviving localStorage.
  const clock2 = createRendererClock();
  clock2.storage.set(CACHE_KEY, persisted);
  await clock2.advance(clock1.now + 2_000);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: clock2.win });
  Date.now = () => EPOCH_OFFSET + clock2.now;

  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock2.settle();

  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        credentialStamp: 'acc-1',
        updatedAt: null,
        windows: [{ label: '5H', usedPct: 100, resetAt: futureReset }],
      },
    ],
    { checkedAt: Date.now() }
  );
  await clock2.settle();

  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.updatedAt, committedAt);
  assert.deepEqual(codex.resetCredits, credits);
  const cachedCodex = JSON.parse(clock2.storage.get(CACHE_KEY)).rows.find((row) => row.id === 'openai-oauth');
  assert.equal(cachedCodex.windows[0].usedPct, 0);
  assert.deepEqual(cachedCodex.resetCredits, credits);

  release();
  await clock2.settle();
  assert.equal(idle(clock2), 0);
});

test('scoped refresh for another provider does not overwrite a measured provider with an unmeasured empty row', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;
  const credits = { availableCount: 1, offerRevision: 'codex-scoped-rev' };

  const host = sectionsHost({
    invokeCapability() {
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'error',
              updatedAt: null,
              windows: [],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 15, resetAt: futureReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  const committedAt = start + 1_000;
  clock.advance(1_000);
  publishUsageDashboard(
    {
      checkedAt: committedAt,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: committedAt,
          resetCredits: credits,
          windows: [{ label: '5H', usedPct: 0, resetAt: futureReset }],
        },
        {
          id: 'anthropic-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: start,
          windows: [{ label: '7D', usedPct: 40, resetAt: futureReset }],
        },
      ],
    },
    { readStartedAt: start + 500, providers: ['openai-oauth'] }
  );

  clock.advance(1_000);
  await refreshUsageDashboard(host, { force: true, providers: ['anthropic-oauth'] });
  await clock.settle();

  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  const claude = rowsOf().find((row) => row.id === 'anthropic-oauth');
  assert.equal(claude.windows[0].usedPct, 15);
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.updatedAt, committedAt);
  assert.deepEqual(codex.resetCredits, credits);
  const cachedCodex = JSON.parse(clock.storage.get(CACHE_KEY)).rows.find((row) => row.id === 'openai-oauth');
  assert.equal(cachedCodex.windows[0].usedPct, 0);
  assert.deepEqual(cachedCodex.resetCredits, credits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('normal partial usage updates continue after accepting a genuine partial rollover', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const oldReset = start + 10_000;
  const newReset = start + 300_000;
  const credits = { availableCount: 1, offerRevision: 'codex-rollover-rev' };

  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  publishUsageDashboard(
    {
      checkedAt: start,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: start,
          resetCredits: credits,
          windows: [{ label: '5H', usedPct: 100, resetAt: oldReset }],
        },
      ],
    },
    { readStartedAt: start, providers: ['openai-oauth'] }
  );

  // Advance past oldReset (before settle poll) and push a genuine partial rollover to a new 5H window at 0%.
  await clock.advance(11_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        updatedAt: Date.now(),
        resetCredits: credits,
        windows: [{ label: '5H', usedPct: 0, resetAt: newReset }],
      },
    ],
    { checkedAt: Date.now() }
  );
  await clock.settle();
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 0);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].resetAt, newReset);

  // Subsequent partial usage reading (10% on the new window, credits intact) must be accepted.
  await clock.advance(5_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        updatedAt: Date.now(),
        resetCredits: credits,
        windows: [{ label: '5H', usedPct: 10, resetAt: newReset }],
      },
    ],
    { checkedAt: Date.now() }
  );
  await clock.settle();
  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 10);
  assert.equal(codex.windows[0].resetAt, newReset);
  assert.deepEqual(codex.resetCredits, credits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('queued scoped caller resolves cleanly when its adopted in-flight refresh is later retired', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;

  let resolveA2 = null;
  let resolveB2 = null;
  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      // 1: hung A1, 2: hung B1 (after auth), 3: A2 (after auth), 4: re-queued B2.
      if (requests.length === 1 || requests.length === 2) return new Promise(() => undefined);
      if (requests.length === 3) {
        return new Promise((resolve) => {
          resolveA2 = () =>
            resolve({
              value: {
                checkedAt: Date.now(),
                rows: [
                  {
                    id: 'anthropic-oauth',
                    authenticated: true,
                    updatedAt: Date.now(),
                    windows: [{ label: '7D', usedPct: 11, resetAt: futureReset }],
                  },
                  {
                    id: 'openai-oauth',
                    authenticated: true,
                    updatedAt: start,
                    windows: [{ label: '5H', usedPct: 50, resetAt: futureReset }],
                  },
                ],
              },
            });
        });
      }
      return new Promise((resolve) => {
        resolveB2 = () =>
          resolve({
            value: {
              checkedAt: Date.now(),
              rows: [
                {
                  id: 'anthropic-oauth',
                  authenticated: true,
                  updatedAt: Date.now(),
                  windows: [{ label: '7D', usedPct: 11, resetAt: futureReset }],
                },
                {
                  id: 'openai-oauth',
                  authenticated: true,
                  updatedAt: Date.now(),
                  windows: [{ label: '5H', usedPct: 5, resetAt: futureReset }],
                },
              ],
            },
          });
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  // Start hung A1 and queue scoped B behind it.
  const firstA = refreshUsageDashboard(host, { force: true, providers: ['anthropic-oauth'] });
  const queuedB = refreshUsageDashboard(host, { force: true, providers: ['openai-oauth'] });
  let queuedBSettled = false;
  queuedB.then(() => {
    queuedBSettled = true;
  });
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // B auth refresh retires hung A1 and hangs; queuedB wakes and adopts B1.
  const authB = refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth']]);
  assert.equal(queuedBSettled, false);

  // A auth refresh retires hung B1, starts A2, and re-queues B2.
  const authA = refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth'], ['anthropic-oauth']]);

  resolveA2();
  await authA;
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth'], ['openai-oauth'], ['anthropic-oauth'], ['openai-oauth']]);
  assert.equal(queuedBSettled, false);

  resolveB2();
  await Promise.all([firstA, authB, queuedB]);
  await clock.settle();
  assert.equal(queuedBSettled, true);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 5);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].usedPct, 11);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('unrelated provider publication re-queues an in-flight auth-recovery retry instead of dropping it', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;
  const credits = { availableCount: 1, offerRevision: 'codex-pub-rev' };

  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('anthropic-auth-offline'));
      if (requests.length === 2) return new Promise(() => undefined);
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              updatedAt: start,
              windows: [{ label: '5H', usedPct: 90, resetAt: futureReset }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 4, resetAt: futureReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 90, resetAt: futureReset }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        updatedAt: start,
        windows: [{ label: '7D', usedPct: 50, resetAt: futureReset }],
      },
    ],
    { checkedAt: start }
  );

  // t=0s: Anthropic auth refresh fails -> retry armed for t=15s.
  await refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=15s: Anthropic auth-recovery retry dispatches and hangs.
  await clock.advance(RETRY);
  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth']]);

  // t=16s: Codex credit reset commits while Anthropic's retry is in flight.
  await clock.advance(1_000);
  publishUsageDashboard(
    {
      checkedAt: Date.now(),
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: Date.now(),
          resetCredits: credits,
          windows: [{ label: '5H', usedPct: 0, resetAt: futureReset }],
        },
        {
          id: 'anthropic-oauth',
          authenticated: true,
          updatedAt: start,
          windows: [{ label: '7D', usedPct: 50, resetAt: futureReset }],
        },
      ],
    },
    { readStartedAt: start + 15_500, providers: ['openai-oauth'] }
  );
  await clock.settle();

  // Anthropic's in-flight auth recovery must be re-queued and complete, without regressing Codex's committed reset.
  assert.deepEqual(requests, [['anthropic-oauth'], ['anthropic-oauth'], ['anthropic-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].usedPct, 4);
  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.deepEqual(codex.resetCredits, credits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('cold-loaded cached rows respect ordinary transport backoff and spent retry budget', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;

  clock.storage.set(
    CACHE_KEY,
    JSON.stringify({
      checkedAt: start,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: start,
          windows: [{ label: '5H', usedPct: 30, resetAt: futureReset }],
        },
      ],
    })
  );

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls <= 2) return Promise.reject(new Error('offline'));
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 25, resetAt: futureReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  // Initial cold-load rail read fails offline (call 1) and arms ordinary retry at +15s.
  await refreshUsageDashboard(host);
  assert.equal(calls, 1);

  // Opening the popup 1s later must not bypass ordinary transport backoff even though refreshedAt === 0.
  await clock.advance(1_000);
  await refreshUsageDashboard(host);
  assert.equal(calls, 1);

  // Scheduled retry fires at t=15s (call 2) and also fails offline.
  await clock.advance(RETRY - 1_000);
  assert.equal(calls, 2);

  // Another non-forced open 1s later must not wipe the spent retry budget and dispatch a 3rd read.
  await clock.advance(1_000);
  await refreshUsageDashboard(host);
  assert.equal(calls, 2);

  // Explicit forced refresh still runs and recovers.
  await refreshUsageDashboard(host, { force: true });
  assert.equal(calls, 3);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 25);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('due reset waiting behind an incompatible scoped read skips forced global refresh if already rolled', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const dueReset = start + 10_000;
  const nextReset = start + 300_000;

  let resolveScoped = null;
  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders ?? null;
      requests.push(scoped);
      if (requests.length === 1) {
        return new Promise((resolve) => {
          resolveScoped = () =>
            resolve({
              value: {
                checkedAt: Date.now(),
                rows: [
                  {
                    id: 'openai-oauth',
                    authenticated: true,
                    status: 'ok',
                    updatedAt: Date.now(),
                    windows: [{ label: '5H', usedPct: 0, resetAt: nextReset }],
                  },
                  {
                    id: 'anthropic-oauth',
                    authenticated: true,
                    status: 'ok',
                    updatedAt: Date.now(),
                    windows: [{ label: '7D', usedPct: 18, resetAt: nextReset }],
                  },
                ],
              },
            });
        });
      }
      assert.fail(`Unexpected extra refresh request: ${JSON.stringify(scoped)}`);
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: dueReset }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        status: 'ok',
        updatedAt: start,
        windows: [{ label: '7D', usedPct: 20, resetAt: nextReset }],
      },
    ],
    { checkedAt: start }
  );

  // t=9s: start an incompatible scoped Anthropic read that stays in flight past Codex's due reset.
  await clock.advance(9_000);
  const scoped = refreshUsageDashboard(host, { force: true, providers: ['anthropic-oauth'] });
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=12s: Codex's reset timer fires and waits behind the scoped read.
  await clock.advance(1_000 + RESET_SETTLE);
  assert.deepEqual(requests, [['anthropic-oauth']]);

  // t=12.5s: while the scoped Anthropic read is still in flight, a section push rolls Codex over.
  await clock.advance(500);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        updatedAt: Date.now(),
        windows: [{ label: '5H', usedPct: 0, resetAt: nextReset }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        status: 'ok',
        updatedAt: start,
        windows: [{ label: '7D', usedPct: 20, resetAt: nextReset }],
      },
    ],
    { checkedAt: Date.now() }
  );

  // t=13s: scoped read completes -> due reset rechecks, sees Codex already rolled over, and skips forced global read.
  await clock.advance(500);
  resolveScoped();
  await scoped;
  await clock.settle();
  assert.deepEqual(requests, [['anthropic-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 0);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].resetAt, nextReset);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.size, 0);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.size, 0);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('due reset returning an empty authenticated row advances reset backoff instead of spinning', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const dueReset = start + 10_000;
  const key5h = usageResetWindowKeys([{ label: '5H' }], 'openai-oauth')[0];

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: null,
              windows: [],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: dueReset }],
      },
    ],
    { checkedAt: start }
  );

  // t=12s: due reset read returns an empty authenticated row -> old measurement stays, 1 read only (no spin).
  await clock.advance(10_000 + RESET_SETTLE);
  assert.equal(calls, 1);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 100);
  assert.equal(getUsageResetVerificationState().verifyingWindowKeys.has(key5h), true);

  // Bounded follow-ups fire at +5s, +15s, +30s and then exhaust cleanly without spinning.
  await clock.advance(RESET_FOLLOWUPS[0] - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);

  await clock.advance(RESET_FOLLOWUPS[1]);
  assert.equal(calls, 3);

  await clock.advance(RESET_FOLLOWUPS[2]);
  assert.equal(calls, 4);
  assert.equal(getUsageResetVerificationState().failedWindowKeys.has(key5h), true);

  // Exhausted: advancing further dispatches zero additional reads.
  await clock.advance(60_000);
  assert.equal(calls, 4);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('forced read after a confirmed reset does not accept a jittered unrolled partial row', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;
  const credits = { availableCount: 1, offerRevision: 'codex-forced-partial' };

  let call = 0;
  const host = sectionsHost({
    invokeCapability() {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          value: {
            checkedAt: Date.now(),
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                status: 'partial',
                updatedAt: Date.now(),
                windows: [{ label: '5H', usedPct: 100, resetAt: futureReset + 250 }],
              },
            ],
          },
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: Date.now(),
              resetCredits: credits,
              windows: [{ label: '5H', usedPct: 12, resetAt: futureReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  await clock.advance(1_000);
  publishUsageDashboard(
    {
      checkedAt: Date.now(),
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: Date.now(),
          resetCredits: credits,
          windows: [{ label: '5H', usedPct: 0, resetAt: futureReset }],
        },
      ],
    },
    { readStartedAt: start + 500, providers: ['openai-oauth'] }
  );

  // Forced read started AFTER the commit returns a jittered unrolled partial row -> must not revert confirmed reset.
  await clock.advance(1_000);
  await refreshUsageDashboard(host, { force: true });
  await clock.settle();

  let codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, futureReset);
  assert.deepEqual(codex.resetCredits, credits);
  const cachedAfterPartial = JSON.parse(clock.storage.get(CACHE_KEY)).rows.find((row) => row.id === 'openai-oauth');
  assert.equal(cachedAfterPartial.windows[0].usedPct, 0);
  assert.deepEqual(cachedAfterPartial.resetCredits, credits);

  // An authoritative complete (non-partial) forced read supersedes normally.
  await clock.advance(1_000);
  await refreshUsageDashboard(host, { force: true });
  await clock.settle();
  codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 12);
  assert.deepEqual(codex.resetCredits, credits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('authoritative second publishUsageDashboard credit operation supersedes the prior commit', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;

  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  await clock.advance(1_000);
  const firstOk = publishUsageDashboard(
    {
      checkedAt: Date.now(),
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'partial',
          updatedAt: Date.now(),
          resetCredits: { availableCount: 2, offerRevision: 'rev-1' },
          windows: [{ label: '5H', usedPct: 100, resetAt: futureReset }],
        },
      ],
    },
    { readStartedAt: start + 500, providers: ['openai-oauth'] }
  );
  assert.equal(firstOk, true);

  // Second authoritative credit reset for the same provider before natural deadline must commit cleanly.
  await clock.advance(1_000);
  const secondOk = publishUsageDashboard(
    {
      checkedAt: Date.now(),
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'partial',
          updatedAt: Date.now(),
          resetCredits: { availableCount: 1, offerRevision: 'rev-2' },
          windows: [{ label: '5H', usedPct: 0, resetAt: futureReset }],
        },
      ],
    },
    { readStartedAt: start + 1_500, providers: ['openai-oauth'] }
  );
  assert.equal(secondOk, true);

  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.deepEqual(codex.resetCredits, { availableCount: 1, offerRevision: 'rev-2' });
  const cachedCodex = JSON.parse(clock.storage.get(CACHE_KEY)).rows.find((row) => row.id === 'openai-oauth');
  assert.equal(cachedCodex.windows[0].usedPct, 0);
  assert.deepEqual(cachedCodex.resetCredits, { availableCount: 1, offerRevision: 'rev-2' });

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('OAuth login auth refresh replaces prior account row when new account returns an empty unmeasured row', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;
  const creditsA = { availableCount: 3, offerRevision: 'account-a-credits' };

  const host = sectionsHost({
    invokeCapability() {
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: null,
              windows: [],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              status: 'error',
              updatedAt: null,
              windows: [],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'acc-A',
        updatedAt: start,
        resetCredits: creditsA,
        windows: [{ label: '5H', usedPct: 88, resetAt: futureReset }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'claude-1',
        updatedAt: start,
        windows: [{ label: '7D', usedPct: 22, resetAt: futureReset }],
      },
    ],
    { checkedAt: start }
  );

  // OAuth login as account B triggers an explicit auth refresh for openai-oauth.
  await clock.advance(1_000);
  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  await clock.settle();

  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.credentialStamp, undefined);
  assert.equal(codex.updatedAt, null);
  assert.deepEqual(codex.windows, []);
  assert.equal(codex.resetCredits, undefined);

  // Out-of-scope Anthropic still preserves its measured row against an empty/error row.
  const claude = rowsOf().find((row) => row.id === 'anthropic-oauth');
  assert.equal(claude.windows[0].usedPct, 22);
  assert.equal(claude.updatedAt, start);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('delayed section row with older updatedAt is rejected without clearing confirmed-reset protection', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const oldReset = start + 10_000;
  const futureReset = start + 300_000;
  const credits = { availableCount: 1, offerRevision: 'codex-delayed-rev' };

  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  // Commit confirmed reset at t=15s (updatedAt=start+15_000, resetAt already elapsed relative to delayed push check).
  await clock.advance(15_000);
  const committedAt = Date.now();
  publishUsageDashboard(
    {
      checkedAt: committedAt,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          credentialStamp: 'acc-1',
          updatedAt: committedAt,
          resetCredits: credits,
          windows: [{ label: '5H', usedPct: 0, resetAt: oldReset }],
        },
      ],
    },
    { readStartedAt: start + 14_500, providers: ['openai-oauth'] }
  );

  // Delayed section row looks like a rollover (new futureReset) but has an older same-account updatedAt.
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'acc-1',
        updatedAt: start + 5_000,
        windows: [{ label: '5H', usedPct: 0, resetAt: futureReset }],
      },
    ],
    { checkedAt: committedAt }
  );
  await clock.settle();

  // Must still be protected against a subsequent unrolled partial push.
  await clock.advance(1_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        credentialStamp: 'acc-1',
        updatedAt: Date.now(),
        windows: [{ label: '5H', usedPct: 100, resetAt: oldReset }],
      },
    ],
    { checkedAt: Date.now() }
  );
  await clock.settle();

  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, oldReset);
  assert.deepEqual(codex.resetCredits, credits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('partial rollover of 5H protects a still-future 7D window and credits from jitter regression', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const reset5h = start + 10_000;
  const nextReset5h = start + 18_000_000;
  const futureReset7d = start + 600_000_000;
  const credits = { availableCount: 2, offerRevision: 'codex-per-window' };

  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  publishUsageDashboard(
    {
      checkedAt: start,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: start,
          resetCredits: credits,
          windows: [
            { label: '5H', usedPct: 100, resetAt: reset5h },
            { label: '7D', usedPct: 0, resetAt: futureReset7d },
          ],
        },
      ],
    },
    { readStartedAt: start, providers: ['openai-oauth'] }
  );

  // Advance past 5H while 7D is still far in the future.
  await clock.advance(11_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        updatedAt: Date.now(),
        windows: [
          { label: '5H', usedPct: 0, resetAt: nextReset5h },
          { label: '7D', usedPct: 100, resetAt: futureReset7d + 250 },
        ],
      },
    ],
    { checkedAt: Date.now() }
  );
  await clock.settle();

  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  const win5h = codex.windows.find((w) => w.label === '5H');
  const win7d = codex.windows.find((w) => w.label === '7D');
  assert.equal(win5h.usedPct, 0);
  assert.equal(win5h.resetAt, nextReset5h);
  assert.equal(win7d.usedPct, 0);
  assert.equal(win7d.resetAt, futureReset7d);
  assert.deepEqual(codex.resetCredits, credits);

  // Subsequent normal partial update for rolled 5H (10%) is accepted while 7D remains protected.
  await clock.advance(2_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        updatedAt: Date.now(),
        windows: [
          { label: '5H', usedPct: 10, resetAt: nextReset5h },
          { label: '7D', usedPct: 100, resetAt: futureReset7d + 250 },
        ],
      },
    ],
    { checkedAt: Date.now() }
  );
  await clock.settle();

  const codexAfter = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codexAfter.windows.find((w) => w.label === '5H').usedPct, 10);
  assert.equal(codexAfter.windows.find((w) => w.label === '7D').usedPct, 0);
  assert.equal(codexAfter.windows.find((w) => w.label === '7D').resetAt, futureReset7d);
  assert.deepEqual(codexAfter.resetCredits, credits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('non-forced global read on cold cache honors active scoped auth retry holds', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;

  clock.storage.set(
    CACHE_KEY,
    JSON.stringify({
      checkedAt: start,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: start,
          windows: [{ label: '5H', usedPct: 35, resetAt: futureReset }],
        },
      ],
    })
  );

  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders ?? null;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('auth-offline'));
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 12, resetAt: futureReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  // Scoped auth refresh fails and arms a 15s retry hold for openai-oauth.
  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  assert.deepEqual(requests, [['openai-oauth']]);
  assert.equal(getUsageDashboardSnapshot().refreshedAt, 0);

  // Opening popup 1s later triggers a non-forced global read -> must honor openai-oauth's 15s hold.
  await clock.advance(1_000);
  await refreshUsageDashboard(host);
  assert.deepEqual(requests, [['openai-oauth']]);

  // Scheduled retry fires at t=15s and recovers openai-oauth.
  await clock.advance(RETRY - 1_000);
  assert.deepEqual(requests, [['openai-oauth'], ['openai-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 12);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('non-forced global read on cold cache narrows around a held provider to refresh unheld providers only', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;

  clock.storage.set(
    CACHE_KEY,
    JSON.stringify({
      checkedAt: start,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: start,
          windows: [{ label: '5H', usedPct: 35, resetAt: futureReset }],
        },
        {
          id: 'anthropic-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: start,
          windows: [{ label: '7D', usedPct: 40, resetAt: futureReset }],
        },
      ],
    })
  );

  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders ?? null;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('codex-auth-offline'));
      if (requests.length === 2) {
        return Promise.resolve({
          value: {
            checkedAt: Date.now(),
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                status: 'ok',
                updatedAt: start,
                windows: [{ label: '5H', usedPct: 35, resetAt: futureReset }],
              },
              {
                id: 'anthropic-oauth',
                authenticated: true,
                status: 'ok',
                updatedAt: Date.now(),
                windows: [{ label: '7D', usedPct: 18, resetAt: futureReset }],
              },
            ],
          },
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 9, resetAt: futureReset }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 18, resetAt: futureReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  assert.deepEqual(requests, [['openai-oauth']]);

  // Opening popup 1s later narrows the non-forced global read to unheld anthropic-oauth only.
  await clock.advance(1_000);
  await refreshUsageDashboard(host);
  assert.deepEqual(requests, [['openai-oauth'], ['anthropic-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').windows[0].usedPct, 18);

  // At t=15s, openai-oauth's scheduled auth retry fires and refreshes openai-oauth.
  await clock.advance(RETRY - 1_000);
  assert.deepEqual(requests, [['openai-oauth'], ['anthropic-oauth'], ['openai-oauth']]);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 9);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('out-of-scope provider in a scoped mutation does not revert another provider from account B back to account A', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;

  const host = sectionsHost({
    invokeCapability() {
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              credentialStamp: 'codex-1',
              updatedAt: start,
              windows: [{ label: '5H', usedPct: 100, resetAt: futureReset }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              status: 'ok',
              credentialStamp: 'claude-B',
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 7, resetAt: futureReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'codex-1',
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 100, resetAt: futureReset }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'claude-A',
        updatedAt: start,
        windows: [{ label: '7D', usedPct: 91, resetAt: futureReset }],
      },
    ],
    { checkedAt: start }
  );

  // Codex credit operation starts at t=1s while Claude is on account A.
  await clock.advance(1_000);
  const codexMutationStartedAt = Date.now();

  // At t=2s, Claude switches to account B and finishes its auth refresh.
  await clock.advance(1_000);
  await refreshUsageDashboardAfterAuth(host, ['anthropic-oauth']);
  await clock.settle();
  assert.equal(rowsOf().find((row) => row.id === 'anthropic-oauth').credentialStamp, 'claude-B');

  // At t=3s, Codex-scoped mutation commits an older aggregate containing Claude account A.
  await clock.advance(1_000);
  publishUsageDashboard(
    {
      checkedAt: Date.now(),
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          credentialStamp: 'codex-1',
          updatedAt: Date.now(),
          resetCredits: { availableCount: 1, offerRevision: 'codex-scoped-rev' },
          windows: [{ label: '5H', usedPct: 0, resetAt: futureReset }],
        },
        {
          id: 'anthropic-oauth',
          authenticated: true,
          status: 'ok',
          credentialStamp: 'claude-A',
          updatedAt: start,
          windows: [{ label: '7D', usedPct: 91, resetAt: futureReset }],
        },
      ],
    },
    { readStartedAt: codexMutationStartedAt, providers: ['openai-oauth'] }
  );
  await clock.settle();

  const claude = rowsOf().find((row) => row.id === 'anthropic-oauth');
  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(claude.credentialStamp, 'claude-B');
  assert.equal(claude.windows[0].usedPct, 7);
  const cachedClaude = JSON.parse(clock.storage.get(CACHE_KEY)).rows.find((row) => row.id === 'anthropic-oauth');
  assert.equal(cachedClaude.credentialStamp, 'claude-B');
  assert.equal(cachedClaude.windows[0].usedPct, 7);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('non-auth forced read returning an empty row does not cancel a pending forAuth retry', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;

  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders ?? null;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('auth-offline'));
      if (requests.length === 2) {
        return Promise.resolve({
          value: {
            checkedAt: Date.now(),
            rows: [
              {
                id: 'openai-oauth',
                authenticated: true,
                status: 'ok',
                updatedAt: null,
                windows: [],
              },
            ],
          },
        });
      }
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: null,
              windows: [],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'acc-A',
        updatedAt: start,
        resetCredits: { availableCount: 2, offerRevision: 'acc-a-credits' },
        windows: [{ label: '5H', usedPct: 80, resetAt: futureReset }],
      },
    ],
    { checkedAt: start }
  );

  // Switch A -> B: auth refresh fails and arms a 15s forAuth retry.
  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  assert.deepEqual(requests, [['openai-oauth']]);

  // At t=5s, an ordinary forced read returns an empty row -> A is preserved, B's forAuth retry MUST stay armed.
  await clock.advance(5_000);
  await refreshUsageDashboard(host, { force: true });
  await clock.settle();
  assert.deepEqual(requests, [['openai-oauth'], null]);
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').credentialStamp, 'acc-A');

  // At t=15s, B's pending forAuth retry still fires and replaces A with B's empty row.
  await clock.advance(RETRY - 5_000);
  assert.deepEqual(requests, [['openai-oauth'], null, ['openai-oauth']]);
  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.credentialStamp, undefined);
  assert.equal(codex.updatedAt, null);
  assert.deepEqual(codex.windows, []);
  assert.equal(codex.resetCredits, undefined);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('scoped Codex mutation retiring an initial global forAuth refresh re-queues it for the new Claude account', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;
  const credits = { availableCount: 1, offerRevision: 'codex-commit-rev' };

  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders ?? null;
      requests.push(scoped);
      if (requests.length === 1) return new Promise(() => undefined);
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              credentialStamp: 'codex-1',
              updatedAt: start,
              windows: [{ label: '5H', usedPct: 95, resetAt: futureReset }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              status: 'ok',
              credentialStamp: 'claude-B',
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 6, resetAt: futureReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'codex-1',
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 95, resetAt: futureReset }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'claude-A',
        updatedAt: start,
        windows: [{ label: '7D', usedPct: 85, resetAt: futureReset }],
      },
    ],
    { checkedAt: start }
  );

  // Start initial global forAuth refresh (not a retry) and keep it pending.
  await clock.advance(1_000);
  const globalAuth = refreshUsageDashboardAfterAuth(host);
  await clock.settle();
  assert.deepEqual(requests, [null]);

  // At t=2s, commit a Codex-scoped mutation that retires the pending global forAuth refresh.
  await clock.advance(1_000);
  publishUsageDashboard(
    {
      checkedAt: Date.now(),
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          credentialStamp: 'codex-1',
          updatedAt: Date.now(),
          resetCredits: credits,
          windows: [{ label: '5H', usedPct: 0, resetAt: futureReset }],
        },
        {
          id: 'anthropic-oauth',
          authenticated: true,
          status: 'ok',
          credentialStamp: 'claude-A',
          updatedAt: start,
          windows: [{ label: '7D', usedPct: 85, resetAt: futureReset }],
        },
      ],
    },
    { readStartedAt: Date.now(), providers: ['openai-oauth'] }
  );
  await globalAuth;
  await clock.settle();

  // Replacement global forAuth refresh must dispatch, updating Claude to B while preserving Codex's newer commit.
  assert.deepEqual(requests, [null, null]);
  const claude = rowsOf().find((row) => row.id === 'anthropic-oauth');
  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(claude.credentialStamp, 'claude-B');
  assert.equal(claude.windows[0].usedPct, 6);
  assert.equal(codex.windows[0].usedPct, 0);
  assert.deepEqual(codex.resetCredits, credits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('delayed forAuth response for the same account with an older updatedAt does not regress a newer section push', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;

  let resolveAuth = null;
  const host = sectionsHost({
    invokeCapability() {
      return new Promise((resolve) => {
        resolveAuth = () =>
          resolve({
            value: {
              checkedAt: start + 1_000,
              rows: [
                {
                  id: 'openai-oauth',
                  authenticated: true,
                  status: 'ok',
                  credentialStamp: 'acc-B',
                  updatedAt: start + 1_000,
                  windows: [{ label: '5H', usedPct: 10, resetAt: futureReset }],
                },
              ],
            },
          });
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'acc-A',
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 90, resetAt: futureReset }],
      },
    ],
    { checkedAt: start }
  );

  // Start forAuth refresh for account B.
  await clock.advance(1_000);
  const authRefresh = refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  await clock.settle();

  // While forAuth is in flight, a newer section push reports 22% for account B.
  await clock.advance(2_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'acc-B',
        updatedAt: start + 3_000,
        windows: [{ label: '5H', usedPct: 22, resetAt: futureReset }],
      },
    ],
    { checkedAt: start + 3_000 }
  );
  await clock.settle();
  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 22);

  // Delayed forAuth answer returns 10% for the SAME stamp acc-B with older updatedAt -> must be rejected.
  resolveAuth();
  await authRefresh;
  await clock.settle();

  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.credentialStamp, 'acc-B');
  assert.equal(codex.windows[0].usedPct, 22);
  assert.equal(codex.updatedAt, start + 3_000);
  const cachedCodex = JSON.parse(clock.storage.get(CACHE_KEY)).rows.find((row) => row.id === 'openai-oauth');
  assert.equal(cachedCodex.windows[0].usedPct, 22);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('partial read shifting an expired deadline forward while still in the past is not treated as a rollover', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const expiredReset = start + 10_000;
  const credits = { availableCount: 1, offerRevision: 'codex-past-jitter' };

  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  publishUsageDashboard(
    {
      checkedAt: start,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: start,
          resetCredits: credits,
          windows: [{ label: '5H', usedPct: 0, resetAt: expiredReset }],
        },
      ],
    },
    { readStartedAt: start, providers: ['openai-oauth'] }
  );

  // Advance 2s past expiredReset; partial push shifts deadline by +250ms (still 1.75s in the past) and reports 100%.
  await clock.advance(11_900);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        updatedAt: Date.now(),
        windows: [{ label: '5H', usedPct: 100, resetAt: expiredReset + 250 }],
      },
    ],
    { checkedAt: Date.now() }
  );
  await clock.settle();

  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, expiredReset);
  assert.deepEqual(codex.resetCredits, credits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('genuine partial rollover of a single-window row preserves resetCredits in snapshot and cache', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const oldReset = start + 10_000;
  const nextReset = start + 300_000;
  const credits = { availableCount: 2, offerRevision: 'codex-single-win-credits' };

  const host = sectionsHost();
  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  publishUsageDashboard(
    {
      checkedAt: start,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: start,
          resetCredits: credits,
          windows: [{ label: '5H', usedPct: 100, resetAt: oldReset }],
        },
      ],
    },
    { readStartedAt: start, providers: ['openai-oauth'] }
  );

  // Advance past oldReset and push a genuine partial 5H rollover that omits resetCredits.
  await clock.advance(11_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        updatedAt: Date.now(),
        windows: [{ label: '5H', usedPct: 0, resetAt: nextReset }],
      },
    ],
    { checkedAt: Date.now() }
  );
  await clock.settle();

  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 0);
  assert.equal(codex.windows[0].resetAt, nextReset);
  assert.deepEqual(codex.resetCredits, credits);
  const cachedCodex = JSON.parse(clock.storage.get(CACHE_KEY)).rows.find((row) => row.id === 'openai-oauth');
  assert.equal(cachedCodex.windows[0].usedPct, 0);
  assert.equal(cachedCodex.windows[0].resetAt, nextReset);
  assert.deepEqual(cachedCodex.resetCredits, credits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('cold-loaded due reset honors active scoped auth-retry hold on a non-forced global refresh', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const alreadyDueReset = start - 5_000;
  const nextReset = start + 300_000;

  clock.storage.set(
    CACHE_KEY,
    JSON.stringify({
      checkedAt: start - 10_000,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          updatedAt: start - 10_000,
          windows: [{ label: '5H', usedPct: 100, resetAt: alreadyDueReset }],
        },
      ],
    })
  );

  const requests = [];
  const host = sectionsHost({
    invokeCapability(request) {
      const scoped = request?.args?.[0]?.refreshProviders ?? null;
      requests.push(scoped);
      if (requests.length === 1) return Promise.reject(new Error('auth-offline'));
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 0, resetAt: nextReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  // Fail scoped auth refresh -> arms 15s retry hold for openai-oauth.
  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  assert.deepEqual(requests, [['openai-oauth']]);

  // Non-forced global refresh before the reset timer runs must honor openai-oauth's 15s hold.
  await refreshUsageDashboard(host);
  assert.deepEqual(requests, [['openai-oauth']]);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('scoped refresh for Codex preserves signed-out Claude instead of resurrecting an old signed-in row', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;

  const host = sectionsHost({
    invokeCapability() {
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 12, resetAt: futureReset }],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              status: 'ok',
              credentialStamp: 'claude-old',
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 45, resetAt: futureReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 30, resetAt: futureReset }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: false,
        status: 'unavailable',
        updatedAt: null,
        windows: [],
      },
    ],
    { checkedAt: start }
  );

  await clock.advance(1_000);
  await refreshUsageDashboard(host, { force: true, providers: ['openai-oauth'] });
  await clock.settle();

  assert.equal(rowsOf().find((row) => row.id === 'openai-oauth').windows[0].usedPct, 12);
  const claude = rowsOf().find((row) => row.id === 'anthropic-oauth');
  assert.equal(claude.authenticated, false);
  assert.deepEqual(claude.windows, []);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('failed global forAuth refresh overlapping a due reset preserves forAuth on its retry', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const alreadyDueReset = start - 5_000;

  clock.storage.set(
    CACHE_KEY,
    JSON.stringify({
      checkedAt: start - 10_000,
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          credentialStamp: 'acc-A',
          updatedAt: start - 10_000,
          resetCredits: { availableCount: 2, offerRevision: 'acc-a-rev' },
          windows: [{ label: '5H', usedPct: 100, resetAt: alreadyDueReset }],
        },
      ],
    })
  );

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('auth-offline'));
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: null,
              windows: [],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  await refreshUsageDashboardAfterAuth(host);
  assert.equal(calls, 1);

  // At t=15s, retry fires once with forAuth preserved and replaces account A with account B's empty row.
  await clock.advance(RETRY);
  assert.equal(calls, 2);
  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.credentialStamp, undefined);
  assert.equal(codex.updatedAt, null);
  assert.deepEqual(codex.windows, []);
  assert.equal(codex.resetCredits, undefined);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('section push updating another provider does not cancel a pending global forAuth retry', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;

  let calls = 0;
  const host = sectionsHost({
    invokeCapability() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('global-auth-offline'));
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: null,
              windows: [],
            },
            {
              id: 'anthropic-oauth',
              authenticated: true,
              status: 'ok',
              updatedAt: Date.now(),
              windows: [{ label: '7D', usedPct: 14, resetAt: futureReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'codex-A',
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 88, resetAt: futureReset }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        status: 'ok',
        updatedAt: start,
        windows: [{ label: '7D', usedPct: 20, resetAt: futureReset }],
      },
    ],
    { checkedAt: start }
  );

  // Global forAuth refresh fails and arms a 15s global forAuth retry.
  await refreshUsageDashboardAfterAuth(host);
  assert.equal(calls, 1);

  // At t=5s, an unsolicited section push updates Anthropic while echoing Codex's unchanged old row.
  await clock.advance(5_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'ok',
        credentialStamp: 'codex-A',
        updatedAt: start,
        windows: [{ label: '5H', usedPct: 88, resetAt: futureReset }],
      },
      {
        id: 'anthropic-oauth',
        authenticated: true,
        status: 'ok',
        updatedAt: Date.now(),
        windows: [{ label: '7D', usedPct: 15, resetAt: futureReset }],
      },
    ],
    { checkedAt: Date.now() }
  );
  await clock.settle();

  // At t=15s, the global forAuth retry MUST still fire and update Codex.
  await clock.advance(RETRY - 5_000);
  assert.equal(calls, 2);
  const codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.credentialStamp, undefined);
  assert.equal(codex.updatedAt, null);
  assert.deepEqual(codex.windows, []);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});

test('same-stamp partial forAuth refresh preserves resetCredits and partial merge keeps newly measured windows', async (t) => {
  const clock = createRendererClock();
  bindEpoch(t, clock);
  const start = Date.now();
  const futureReset = start + 300_000;
  const futureReset7d = start + 600_000_000;
  const credits = { availableCount: 2, offerRevision: 'codex-keep-credits' };

  const host = sectionsHost({
    invokeCapability() {
      return Promise.resolve({
        value: {
          checkedAt: Date.now(),
          rows: [
            {
              id: 'openai-oauth',
              authenticated: true,
              status: 'partial',
              credentialStamp: 'acc-1',
              updatedAt: Date.now(),
              windows: [{ label: '5H', usedPct: 5, resetAt: futureReset }],
            },
          ],
        },
      });
    },
  });

  const release = holdUsageDashboardCadence(host);
  await clock.settle();

  // Commit single-window 5H row with resetCredits.
  await clock.advance(1_000);
  publishUsageDashboard(
    {
      checkedAt: Date.now(),
      rows: [
        {
          id: 'openai-oauth',
          authenticated: true,
          status: 'ok',
          credentialStamp: 'acc-1',
          updatedAt: Date.now(),
          resetCredits: credits,
          windows: [{ label: '5H', usedPct: 0, resetAt: futureReset }],
        },
      ],
    },
    { readStartedAt: start + 500, providers: ['openai-oauth'] }
  );

  // Partial push jitters protected 5H while adding newly measured 7D -> keep protected 5H + credits AND merge 7D.
  await clock.advance(1_000);
  host.push(
    [
      {
        id: 'openai-oauth',
        authenticated: true,
        status: 'partial',
        credentialStamp: 'acc-1',
        updatedAt: Date.now(),
        windows: [
          { label: '5H', usedPct: 100, resetAt: futureReset + 250 },
          { label: '7D', usedPct: 18, resetAt: futureReset7d },
        ],
      },
    ],
    { checkedAt: Date.now() }
  );
  await clock.settle();

  let codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows.find((w) => w.label === '5H').usedPct, 0);
  assert.equal(codex.windows.find((w) => w.label === '5H').resetAt, futureReset);
  assert.equal(codex.windows.find((w) => w.label === '7D').usedPct, 18);
  assert.deepEqual(codex.resetCredits, credits);

  // Same-stamp partial forAuth refresh omitting resetCredits preserves resetCredits.
  await clock.advance(1_000);
  await refreshUsageDashboardAfterAuth(host, ['openai-oauth']);
  await clock.settle();

  codex = rowsOf().find((row) => row.id === 'openai-oauth');
  assert.equal(codex.windows[0].usedPct, 5);
  assert.deepEqual(codex.resetCredits, credits);

  release();
  await clock.settle();
  assert.equal(idle(clock), 0);
});
