// A remote client does not poll for statistics: the core pushes section `usage`, key `stats` (desktop-services.md §15
// P7; the Rust producer is `usage_stats_feed`), whose value is the `getUsageStats({ view: 'hour' })` answer. An open
// dialog shows each pushed entry as it arrives.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { CommandSurface } from './CommandSurface.tsx';
import {
  REMOTE_STATS_REFRESH_INTERVAL_MS,
  getStatsDataCache,
  holdStatsDataCache,
  refreshStatsDataCache,
  subscribeStatsDataCache,
} from './command-surface-cache.ts';
import { resolveUsageStatsPeriod } from './test-support/usage-stats-period.recorded.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function snapshot(tokens) {
  const now = new Date(2026, 8, 13, 12).getTime();
  const period = resolveUsageStatsPeriod({ view: 'hour', now });
  const route = {
    turns: 1,
    sessions: 1,
    input: tokens - 200,
    output: 200,
    tokens,
    cacheRead: 500,
    cacheWrite: 800,
    cacheTokens: 1300,
    costUsd: 2,
    costCoverage: 1,
    share: 1,
    models: [],
  };
  return {
    generatedAt: now,
    period,
    range: { days: period.days, firstDay: period.startDay || '2025-01-01' },
    totals: { ...route, sessions: 1 },
    providers: [{ ...route, provider: 'openai', providerKind: 'api' }],
    daily: [{ day: period.startDay, tokens, turns: 1, costUsd: 2, costKnownTurns: 1, providers: [] }],
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      key: String(hour).padStart(2, '0'),
      label: `${String(hour).padStart(2, '0')}:00`,
      tokens: hour === 9 ? tokens : 0,
      turns: hour === 9 ? 1 : 0,
      costUsd: hour === 9 ? 2 : 0,
      costKnownTurns: hour === 9 ? 1 : 0,
      providers: [],
      future: hour > 12,
    })),
    coverage: {},
  };
}

test('a pushed usage/stats entry updates an open statistics dialog without a read', async (context) => {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><main></main></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['HTMLElement', 'Node', 'history'],
    actEnvironment: false,
  });
  const root = createRoot(document.querySelector('main'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });

  const listeners = new Set();
  let revision = 0;
  let entries = [];
  const reads = [];
  const api = {
    sections: {
      core: async () => true,
      snapshot: async () => ({ status: 'ready', entries }),
      subscribe: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    },
    async invokeCapability(request) {
      reads.push(request);
      return { value: snapshot(1200) };
    },
    subscribeState: () => () => {},
    subscribeSessionState: () => () => {},
  };
  const push = (tokens) => {
    const entry = { section: 'usage', key: 'stats', revision: ++revision, value: snapshot(tokens) };
    entries = [entry];
    for (const listener of [...listeners]) listener({ kind: 'sections', changes: [{ section: 'usage', key: 'stats', entry }] });
  };
  const shown = () => document.querySelectorAll('.stats-card > b')[2]?.textContent;
  const props = { surface: 'stats', open: true, onClose() {}, api };

  // A remote client: no background cache, statistics only from the pushed section.
  const release = holdStatsDataCache(api, { background: false });
  context.after(release);
  await act(async () => root.render(React.createElement(CommandSurface, props)));
  assert.equal(shown(), '1.2K', 'opening reads once');
  assert.equal(reads.length, 1);

  await act(async () => push(2400));
  assert.equal(shown(), '2.4K');
  await act(async () => push(3600));
  assert.equal(shown(), '3.6K');
  assert.ok(document.querySelector('.stats-provider-row').textContent.includes('3.6K'));
  assert.equal(reads.length, 1, 'the dialog followed the pushes without reading again');

  // Closed, the entry is still taken, so the cache a reopening paints from is current.
  await act(async () => root.render(React.createElement(CommandSurface, { ...props, open: false })));
  await act(async () => push(4800));
  assert.equal(getStatsDataCache(api, true).getUsageStats.totals.tokens, 4800);
});

// The preload offers a `sections` source on every connection, so its presence says nothing about the lane. The
// connection's own answer (`sections.core()`) does: only a Node-hosted connection re-reads (K1), at a bounded rate
// and for an open dialog; a connection with a core endpoint is never read on this interval.
for (const core of [false, true]) {
  test(`a ${core ? 'core' : 'Node-hosted'} connection with a sections source ${core ? 'never' : 'bounds its'} re-reads`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const sessionListeners = new Set();
    let reads = 0;
    const api = {
      sections: {
        core: async () => core,
        snapshot: async () => ({ status: 'ready', entries: [] }),
        subscribe: () => () => {},
      },
      async invokeCapability() {
        reads += 1;
        return { value: { totals: { tokens: reads * 1000 } } };
      },
      subscribeState: () => () => {},
      subscribeSessionState: (listener) => (sessionListeners.add(listener), () => void sessionListeners.delete(listener)),
    };
    const release = holdStatsDataCache(api, { background: false });
    context.after(release);
    context.after(subscribeStatsDataCache(api, () => {}));
    await refreshStatsDataCache(api);
    await new Promise(setImmediate);
    assert.equal(reads, 1);

    let tokens = 0;
    for (let turn = 0; turn < 5; turn += 1) {
      tokens += 100;
      for (const listener of sessionListeners) listener({ sessionId: 'busy', snapshot: { stats: { inputTokens: tokens } } });
      context.mock.timers.tick(2_000);
      await new Promise(setImmediate);
    }
    assert.equal(reads, 1, 'changes inside the interval wait for it');
    for (let tick = 0; tick < 3; tick += 1) {
      context.mock.timers.tick(REMOTE_STATS_REFRESH_INTERVAL_MS);
      await new Promise(setImmediate);
    }
    assert.equal(reads, core ? 1 : 2, core ? 'the core connection is told, not polled' : 'one coalesced re-read, then no poll');
  });
}