import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import {
  clearSurfaceDataCache,
  getStatsDataCache,
  hasStatsDataCache,
  holdStatsDataCache,
  readSurfaceDataCache,
  refreshStatsDataCache,
  setStatsDataCache,
  subscribeStatsDataCache,
  surfaceDataCacheSize,
  writeSurfaceDataCache,
  SURFACE_DATA_CACHE_LIMIT,
} from './command-surface-cache.ts';
import {
  billingUrl,
  usageClock,
  usageEstimated,
  usagePlanType,
  usageProviderLabel,
  usageTone,
  usageWindowValue,
} from './command-surface-usage.tsx';
import { resolveInheritBlockedReason } from './command-surface-inherit.tsx';
import { useCommandSurfaceLifecycle } from './command-surface-lifecycle.ts';
import { CommandSurface, commandSurfaceTitle } from './CommandSurface.tsx';
import { t } from './i18n.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function setupDomHarness(context, Component = CommandSurface) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    url: 'https://mixdog.test/',
  });
  const originalWindow = globalThis.window;
  const originalDoc = globalThis.document;
  const originalElement = globalThis.HTMLElement;
  const originalNode = globalThis.Node;

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;

  const root = createRoot(document.querySelector('main'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    globalThis.window = originalWindow;
    globalThis.document = originalDoc;
    globalThis.HTMLElement = originalElement;
    globalThis.Node = originalNode;
  });

  return async (props) => act(async () => root.render(React.createElement(Component, props)));
}

test('usage getters omit snapshots while context, inheritance and commands retain their transport', async (context) => {
  clearSurfaceDataCache();
  context.after(clearSurfaceDataCache);
  let current;
  function Harness(props) {
    current = useCommandSurfaceLifecycle({ ...props, open: true });
    return null;
  }
  const render = setupDomHarness(context, Harness);
  const reads = [];
  const invokes = [];
  const snapshot = { sessionId: 'session-test', items: [{ id: 'message', text: 'full context' }] };
  const api = {
    async readCapabilities(requests) {
      reads.push(requests);
      return requests.map(({ capability }) => ({ ok: true, value: { capability } }));
    },
    async invokeCapability(request) {
      invokes.push(request);
      return { value: { capability: request.capability }, snapshot };
    },
  };
  await render({ surface: 'usage', api });
  assert.deepEqual(reads[0], [{ capability: 'getUsageDashboard', args: [] }]);
  assert.equal(invokes.length, 0);
  await render({ surface: 'stats', api });
  assert.deepEqual(reads[1], [{ capability: 'getUsageStats', args: [{ view: 'hour' }] }]);
  await act(async () => current.requestCapability('getUsageStats', [{ view: 'day', anchor: '2026-09-01' }]));
  assert.deepEqual(reads[2], [{ capability: 'getUsageStats', args: [{ view: 'day', anchor: '2026-09-01' }] }]);
  await render({ surface: 'context', sessionId: 'session-test', api });
  assert.deepEqual(invokes.at(-1), { capability: 'contextStatus', args: [], sessionId: 'session-test' });
  assert.deepEqual(current.data.snapshot, snapshot);
  await render({ surface: 'inherit', sessionId: 'session-test', api });
  assert.deepEqual(invokes.at(-1), { capability: 'contextStatus', args: [], sessionId: 'session-test' });
  assert.equal(reads.length, 3);
  await render({ surface: 'doctor', api });
  assert.deepEqual(invokes.at(-1), { capability: 'runDoctor', args: [] });
  await act(async () => current.run('cancelMediaJob', ['job']));
  assert.equal(invokes.filter(({ capability }) => capability === 'cancelMediaJob').length, 1);
  assert.equal(reads.length, 3);
});

test('command surface cache enforces bounded LRU eviction at limit 64', () => {
  clearSurfaceDataCache();
  assert.equal(SURFACE_DATA_CACHE_LIMIT, 64);

  for (let i = 0; i < 64; i++) {
    writeSurfaceDataCache(`key-${i}`, { index: i });
  }
  assert.equal(surfaceDataCacheSize(), 64);
  assert.deepEqual(readSurfaceDataCache('key-0'), { index: 0 });

  // Key-0 was accessed, so key-1 is now the oldest unaccessed entry.
  // Adding the 65th entry must evict key-1, while key-0 is preserved.
  writeSurfaceDataCache('key-64', { index: 64 });
  assert.equal(surfaceDataCacheSize(), 64);
  assert.deepEqual(readSurfaceDataCache('key-0'), { index: 0 });
  assert.equal(readSurfaceDataCache('key-1'), undefined);
  assert.deepEqual(readSurfaceDataCache('key-64'), { index: 64 });

  clearSurfaceDataCache();
  assert.equal(surfaceDataCacheSize(), 0);
});

test('per-api statistics cache isolates separate API host instances', () => {
  const api1 = { invokeCapability: async () => ({ value: {} }) };
  const api2 = { invokeCapability: async () => ({ value: {} }) };

  assert.equal(hasStatsDataCache(api1), false);
  assert.equal(hasStatsDataCache(api2), false);

  setStatsDataCache(api1, { stats: { currentContextTokens: 100 } });
  assert.equal(hasStatsDataCache(api1), true);
  assert.equal(hasStatsDataCache(api2), false);
  assert.deepEqual(getStatsDataCache(api1), { stats: { currentContextTokens: 100 } });
  assert.equal(getStatsDataCache(api2), undefined);
});

test('statistics warmup follows usage in host and session lanes, not streaming text or context estimates', async (context) => {
  let stateListener;
  let sessionListener;
  let subscriptions = 0;
  let releases = 0;
  const reads = [];
  const api = {
    async invokeCapability(request) {
      reads.push(request);
      return { value: { totals: { tokens: reads.length * 1000 } } };
    },
    subscribeState(listener) {
      stateListener = listener;
      subscriptions++;
      return () => {
        releases++;
      };
    },
    subscribeSessionState(listener) {
      sessionListener = listener;
      subscriptions++;
      return () => {
        releases++;
      };
    },
  };
  const release = holdStatsDataCache(api);
  const releaseSecond = holdStatsDataCache(api);
  context.after(() => {
    release();
    releaseSecond();
  });
  await refreshStatsDataCache(api);
  assert.equal(reads.length, 1);
  assert.equal(subscriptions, 2, 'holders share the host and session subscriptions');
  assert.deepEqual(reads[0], { capability: 'getUsageStats', args: [{ view: 'hour' }] });

  const snapshot = { sessionId: 'one', stats: { inputTokens: 100, outputTokens: 20, turns: 1 } };
  stateListener(snapshot);
  assert.equal(hasStatsDataCache(api), false, 'known-stale figures are not an opening seed');
  assert.equal(getStatsDataCache(api, true).getUsageStats.totals.tokens, 1000);
  await refreshStatsDataCache(api);
  assert.equal(getStatsDataCache(api).getUsageStats.totals.tokens, 2000);
  stateListener({
    ...snapshot,
    items: [{ text: 'streaming' }],
    stats: { ...snapshot.stats, currentContextTokens: 900 },
  });
  sessionListener({ sessionId: 'one', snapshot });
  assert.equal(reads.length, 2, 'duplicate lane publications and non-usage changes do not read statistics');

  sessionListener({ sessionId: 'two', snapshot: { stats: { inputTokens: 200, outputTokens: 40, turns: 1 } } });
  await refreshStatsDataCache(api);
  assert.equal(getStatsDataCache(api).getUsageStats.totals.tokens, 3000);
  release();
  release();
  assert.equal(releases, 0);
  releaseSecond();
  assert.equal(releases, 2);
});

test('statistics changes during a shared read publish only the newest complete result', async (context) => {
  let update;
  const resolvers = [];
  const api = {
    invokeCapability: () => new Promise((resolve) => resolvers.push(resolve)),
    subscribeState(listener) {
      update = listener;
      return () => {};
    },
  };
  const release = holdStatsDataCache(api);
  context.after(release);
  const published = [];
  context.after(subscribeStatsDataCache(api, () => published.push(getStatsDataCache(api))));
  const pending = refreshStatsDataCache(api);
  update({ sessionId: 'one', stats: { inputTokens: 100 } });
  update({ sessionId: 'one', stats: { inputTokens: 200 } });
  assert.equal(refreshStatsDataCache(api), pending);
  assert.equal(resolvers.length, 1);
  resolvers[0]({ value: { totals: { tokens: 100 } } });
  await new Promise(setImmediate);
  assert.equal(resolvers.length, 2, 'changes coalesce into one follow-up read');
  assert.deepEqual(published, []);
  resolvers[1]({ value: { totals: { tokens: 200 } } });
  await pending;
  assert.deepEqual(published, [{ getUsageStats: { totals: { tokens: 200 } } }]);
});

test('a failed statistics warmup keeps a stale fallback and can be retried on entry', async (context) => {
  let update;
  let fail = false;
  const api = {
    async invokeCapability() {
      if (fail) throw new Error('usage offline');
      return { value: { totals: { tokens: 1000 } } };
    },
    subscribeState(listener) {
      update = listener;
      return () => {};
    },
  };
  const release = holdStatsDataCache(api);
  context.after(release);
  await refreshStatsDataCache(api);
  fail = true;
  update({ sessionId: 'one', stats: { inputTokens: 100 } });
  await assert.rejects(refreshStatsDataCache(api), /usage offline/);
  assert.equal(getStatsDataCache(api), undefined);
  assert.equal(getStatsDataCache(api, true).getUsageStats.totals.tokens, 1000);
  fail = false;
  await refreshStatsDataCache(api);
  assert.equal(hasStatsDataCache(api), true);
});

test('desktop state warms statistics before the dialog mounts without blocking boot', async (context) => {
  const { useDesktopState } = await import('./app-desktop-state.ts');
  let desktop;
  function Probe() {
    desktop = useDesktopState();
    return null;
  }
  function Harness({ mounted = true }) {
    return mounted ? React.createElement(Probe) : null;
  }
  const render = setupDomHarness(context, Harness);
  const stateListeners = new Set();
  const sessionListeners = new Set();
  const resolvers = [];
  const api = {
    async getSnapshot() {
      return { sessionId: '' };
    },
    invokeCapability: () => new Promise((resolve) => resolvers.push(resolve)),
    subscribeState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    subscribeSessionState(listener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
  };
  window.mixdogDesktop = api;
  await render({});
  assert.equal(desktop.hydrated, true, 'boot does not await the statistics read');
  assert.equal(resolvers.length, 1);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  await act(async () => resolvers[0]({ value: { totals: { tokens: 1000 } } }));
  assert.equal(getStatsDataCache(api).getUsageStats.totals.tokens, 1000);
  sessionListeners.forEach((listener) =>
    listener({
      sessionId: 'background-session',
      snapshot: { stats: { inputTokens: 2000 } },
    })
  );
  await act(async () => resolvers[1]({ value: { totals: { tokens: 2000 } } }));
  assert.equal(getStatsDataCache(api).getUsageStats.totals.tokens, 2000);
  await render({ mounted: false });
  assert.equal(stateListeners.size, 0);
  assert.equal(sessionListeners.size, 0);
});

test('inherit blocked reasons evaluate conditions in deterministic sequence', () => {
  // 1. Missing session ID
  assert.equal(
    resolveInheritBlockedReason({
      sessionId: '',
      busy: false,
      spoken: 5,
      onInheritAvailable: true,
      hasRoute: true,
      fit: null,
    }),
    t('This task has not started a session yet.')
  );

  // 2. Busy turn
  assert.equal(
    resolveInheritBlockedReason({
      sessionId: 'session-123',
      busy: true,
      spoken: 5,
      onInheritAvailable: true,
      hasRoute: true,
      fit: null,
    }),
    t('Wait for the current turn to finish.')
  );

  // 3. Spoken messages = 0
  assert.equal(
    resolveInheritBlockedReason({
      sessionId: 'session-123',
      busy: false,
      spoken: 0,
      onInheritAvailable: true,
      hasRoute: true,
      fit: null,
    }),
    t('There is no conversation to carry over yet.')
  );

  // 4. OnInherit unavailable
  assert.equal(
    resolveInheritBlockedReason({
      sessionId: 'session-123',
      busy: false,
      spoken: 5,
      onInheritAvailable: false,
      hasRoute: true,
      fit: null,
    }),
    t('Inheritance is unavailable on this surface.')
  );

  // 5. Unknown route
  assert.equal(
    resolveInheritBlockedReason({
      sessionId: 'session-123',
      busy: false,
      spoken: 5,
      onInheritAvailable: true,
      hasRoute: false,
      fit: null,
    }),
    t('Unknown')
  );

  // 6. Model context overflow without compaction
  assert.equal(
    resolveInheritBlockedReason({
      sessionId: 'session-123',
      busy: false,
      spoken: 5,
      onInheritAvailable: true,
      hasRoute: true,
      fit: {
        known: true,
        fits: false,
        willCompact: false,
        used: 1000,
        limit: 500,
        percent: 200,
        provider: 'openai',
        model: 'gpt-4o',
        reason: 'exceeded',
      },
    }),
    t('This conversation no longer fits the model context. Run /compact first.')
  );

  // 7. Ready
  assert.equal(
    resolveInheritBlockedReason({
      sessionId: 'session-123',
      busy: false,
      spoken: 5,
      onInheritAvailable: true,
      hasRoute: true,
      fit: {
        known: true,
        fits: true,
        willCompact: false,
        used: 100,
        limit: 500,
        percent: 20,
        provider: 'openai',
        model: 'gpt-4o',
        reason: 'ok',
      },
    }),
    ''
  );
});

test('usage presentation helpers compute clocks, tones and formats', () => {
  // Invalid/empty clocks
  assert.equal(usageClock(null), '');
  assert.equal(usageClock(0), '');
  assert.equal(usageClock(-1), '');

  // Estimated sources
  assert.equal(usageEstimated({ source: 'local' }), true);
  assert.equal(usageEstimated({ source: 'config-cache' }), true);
  assert.equal(usageEstimated({ source: '' }), true);
  assert.equal(usageEstimated({ source: 'provider-api' }), false);

  // Tone resolution
  assert.equal(usageTone({ source: 'local' }), 'estimate');
  assert.equal(usageTone({ source: 'api', usedPct: 96 }), 'danger');
  assert.equal(usageTone({ source: 'api', usedPct: 85 }), 'warn');
  assert.equal(usageTone({ source: 'api', usedPct: 50 }), 'ok');
  assert.equal(usageTone({ source: 'api', usedPct: null }), 'ok');

  // Plan types
  assert.equal(usagePlanType({ id: 'opencode-go' }), 'subscription');
  assert.equal(usagePlanType({ group: 'oauth' }), 'subscription');
  assert.equal(usagePlanType({ group: 'api' }), 'api');
  assert.equal(usagePlanType({ group: 'unknown' }), '');

  // Labels (Requirement 1: strip trailing OAuth/API only; Pro and ID preserved)
  assert.equal(usageProviderLabel({ label: 'OpenAI OAuth' }), 'OpenAI');
  assert.equal(usageProviderLabel({ label: 'OpenAI API' }), 'OpenAI');
  assert.equal(usageProviderLabel({ label: 'OpenAI Pro' }), 'OpenAI Pro');
  assert.equal(usageProviderLabel({ id: 'anthropic' }), 'anthropic');

  // Billing urls
  assert.equal(
    billingUrl({ group: 'api', id: 'openai' }),
    'https://platform.openai.com/settings/organization/billing/overview'
  );
  assert.equal(billingUrl({ group: 'oauth', id: 'openai' }), '');

  // Window values
  assert.equal(usageWindowValue({ usedPct: 42 }), '42%');
  assert.equal(usageWindowValue({ remainingUsd: 12.5 }), '$12.50');
  assert.equal(usageWindowValue({ usedUsd: 5, limitUsd: 20 }), '$5.00/$20.00');
});

test('command surface titles match supported slash command surfaces', () => {
  assert.equal(commandSurfaceTitle('context'), t('Context'));
  assert.equal(commandSurfaceTitle('usage'), t('Provider usage'));
  assert.equal(commandSurfaceTitle('doctor'), t('Doctor'));
  assert.equal(commandSurfaceTitle('inherit'), t('Inherit session'));
  assert.equal(commandSurfaceTitle('stats'), t('Token usage'));
});

test('command surface renders usage skeleton while loading then paints table', async (context) => {
  clearSurfaceDataCache();
  const render = setupDomHarness(context, CommandSurface);
  let resolveCapability;
  const api = {
    invokeCapability: () =>
      new Promise((resolve) => {
        resolveCapability = resolve;
      }),
  };

  await render({ surface: 'usage', open: true, onClose() {}, api });
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute('aria-busy'), 'true');
  assert.ok(document.querySelector('.usage-skeleton-row'));

  // Resolve with dashboard data
  await act(async () => {
    resolveCapability({
      value: {
        rows: [
          {
            id: 'openai',
            label: 'OpenAI',
            group: 'api',
            authenticated: true,
            windows: [{ label: 'requests', usedPct: 30 }],
          },
        ],
      },
    });
  });

  assert.equal(dialog.getAttribute('aria-busy'), 'false');
  assert.equal(document.querySelector('.usage-skeleton-row'), null);
  assert.ok(document.querySelector('.usage-table'));
  assert.equal(document.querySelector('.usage-provider-cell b')?.textContent, 'OpenAI');
});

test('command surface renders inherit session dialog with facts and cancel button', async (context) => {
  const render = setupDomHarness(context, CommandSurface);
  let closed = false;
  const api = {
    invokeCapability: async () => ({ value: { contextStatus: {} } }),
  };
  const snapshot = {
    sessionId: 'session-inherit-test',
    model: 'gpt-4o',
    provider: 'openai',
    items: [
      { kind: 'user', content: 'Hello' },
      { kind: 'assistant', content: 'Hi there' },
    ],
  };

  await render({
    surface: 'inherit',
    open: true,
    sessionId: 'session-inherit-test',
    snapshot,
    api,
    onInherit: async () => {},
    onClose() {
      closed = true;
    },
  });

  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.ok(document.querySelector('.inherit-surface'));
  const facts = document.querySelectorAll('.command-surface-facts dd');
  assert.equal(facts[0]?.textContent, '2'); // spoken count = 2
  assert.equal(facts[1]?.textContent, 'openai/gpt-4o');

  const cancelBtn = document.querySelector('.inherit-surface-cancel');
  assert.ok(cancelBtn);
  cancelBtn.click();
  assert.equal(closed, true);
});

test('active surface rerender touches MRU cache on every render', async (context) => {
  clearSurfaceDataCache();
  const render = setupDomHarness(context, CommandSurface);
  const api = {
    invokeCapability: async () => ({ value: { getUsageDashboard: { rows: [] } } }),
  };

  // Seed cache with 'usage'
  await render({ surface: 'usage', open: true, onClose() {}, api });
  assert.ok(readSurfaceDataCache('usage'));

  // Write 63 more keys (usage + 63 keys = 64 total)
  for (let i = 0; i < 63; i++) {
    writeSurfaceDataCache(`fill-${i}`, { i });
  }
  assert.equal(surfaceDataCacheSize(), 64);

  // Re-render CommandSurface for 'usage'. This must touch 'usage' via cachedSurface read.
  await render({ surface: 'usage', open: true, onClose() {}, api });

  // Adding 64th fill entry must evict fill-0 (oldest unaccessed), NOT 'usage'
  writeSurfaceDataCache('fill-63', { i: 63 });
  assert.equal(surfaceDataCacheSize(), 64);
  assert.ok(readSurfaceDataCache('usage'));
  assert.equal(readSurfaceDataCache('fill-0'), undefined);

  clearSurfaceDataCache();
});

test('stale asynchronous response cannot overwrite newer request state', async (context) => {
  let latestResult = null;
  function LifecycleTestComponent({ surface, api }) {
    const result = useCommandSurfaceLifecycle({ surface, open: true, api });
    latestResult = result;
    return null;
  }

  const render = setupDomHarness(context, LifecycleTestComponent);
  const resolvers = [];
  const api = {
    invokeCapability: ({ capability }) =>
      new Promise((resolve) => {
        resolvers.push({ capability, resolve });
      }),
  };

  // 1. Initial surface: 'doctor' -> triggers request 1 (runDoctor)
  await render({ surface: 'doctor', api });
  assert.equal(resolvers.length, 1);
  assert.equal(resolvers[0].capability, 'runDoctor');
  assert.equal(latestResult.loading, true);

  // 2. Legitimate transition to 'usage' -> advances sequence and triggers request 2 (getUsageDashboard)
  await render({ surface: 'usage', api });
  assert.equal(resolvers.length, 2);
  assert.equal(resolvers[1].capability, 'getUsageDashboard');

  // 3. Resolve request 2 (the latest request) with authoritative data
  await act(async () => {
    resolvers[1].resolve({ value: { rows: [{ id: 'provider-active' }] } });
  });
  assert.equal(latestResult.loading, false);
  assert.deepEqual(latestResult.data.getUsageDashboard, { rows: [{ id: 'provider-active' }] });
  assert.equal(latestResult.data.runDoctor, undefined);

  // 4. Resolve stale request 1 (runDoctor) with an older result
  await act(async () => {
    resolvers[0].resolve({ value: 'stale-doctor-output' });
  });

  // 5. Verify the older result did NOT overwrite the latest state
  assert.equal(latestResult.data.runDoctor, undefined);
  assert.deepEqual(latestResult.data.getUsageDashboard, { rows: [{ id: 'provider-active' }] });
});

test('context session and stats API isolation through lifecycle hook', async (context) => {
  clearSurfaceDataCache();
  const render = setupDomHarness(context, CommandSurface);

  const api1 = {
    invokeCapability: async ({ sessionId, capability }) => {
      if (capability === 'getUsageStats') return { value: { totals: { tokens: 1000 } } };
      return { value: { status: `context-data-for-${sessionId}` }, snapshot: { sessionId } };
    },
  };
  const api2 = {
    invokeCapability: async ({ capability }) => {
      if (capability === 'getUsageStats') return { value: { totals: { tokens: 9999 } } };
      return { value: {}, snapshot: {} };
    },
  };

  // Context Session A
  await render({ surface: 'context', open: true, sessionId: 'session-a', api: api1, onClose() {} });
  assert.ok(readSurfaceDataCache('context:session-a'));
  assert.equal(readSurfaceDataCache('context:session-b'), undefined);

  // Context Session B
  await render({ surface: 'context', open: true, sessionId: 'session-b', api: api1, onClose() {} });
  assert.ok(readSurfaceDataCache('context:session-b'));

  // Stats API 1
  await render({ surface: 'stats', open: true, api: api1, onClose() {} });
  assert.equal(hasStatsDataCache(api1), true);
  assert.equal(hasStatsDataCache(api2), false);

  // Stats API 2
  await render({ surface: 'stats', open: true, api: api2, onClose() {} });
  assert.equal(hasStatsDataCache(api2), true);
  assert.notDeepEqual(getStatsDataCache(api1), getStatsDataCache(api2));

  clearSurfaceDataCache();
});

test('context subscribeState coalesces multiple notifications and handles queued refresh disposal', async (context) => {
  clearSurfaceDataCache();
  const render = setupDomHarness(context, CommandSurface);

  let subscriberCallback = null;
  let unsubscribed = false;
  let capabilityInvocations = 0;
  const resolvers = [];

  const api = {
    invokeCapability: () => {
      capabilityInvocations++;
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    },
    subscribeState: (listener) => {
      subscriberCallback = listener;
      return () => {
        unsubscribed = true;
      };
    },
  };

  // Initial render: initial contextStatus load begins
  await render({ surface: 'context', open: true, sessionId: 'sess-sub', api, onClose() {} });
  assert.equal(capabilityInvocations, 1);

  // Resolve initial load so subscribeState effect becomes active
  await act(async () => {
    resolvers[0]({ value: { initial: true }, snapshot: { sessionId: 'sess-sub' } });
  });
  assert.ok(subscriberCallback !== null, 'subscriber registered');

  // Trigger background refresh 1 via subscribeState
  await act(async () => {
    subscriberCallback();
  });
  assert.equal(capabilityInvocations, 2);

  // While request 2 is in flight, trigger 3 more state events (must coalesce into 1 follow-up)
  await act(async () => {
    subscriberCallback();
    subscriberCallback();
    subscriberCallback();
  });
  // Invocations should still be 2 because refreshRunning is true
  assert.equal(capabilityInvocations, 2);

  // Resolve request 2. The coalesced queued refresh will now execute request 3.
  await act(async () => {
    resolvers[1]({ value: { intermediate: true }, snapshot: { sessionId: 'sess-sub' } });
  });
  assert.equal(capabilityInvocations, 3);

  // Unmount / close before request 3 finishes to exercise disposal cleanup
  await render({ surface: 'context', open: false, sessionId: 'sess-sub', api, onClose() {} });
  assert.equal(unsubscribed, true);

  // Resolve request 3 after unmount — disposed guard prevents crash or state update
  await act(async () => {
    resolvers[2]({ value: { final: true }, snapshot: { sessionId: 'sess-sub' } });
  });
});
