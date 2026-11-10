import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompactionSettings } from './settings-compaction-api.mjs';
import {
  normalizeAutoClearConfig,
  normalizeCompactionConfig,
  autoClearIdleMsForProvider,
  resolveAutoClearIdleMs,
  parseDurationMs,
} from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { _clearLiveSession, setLiveSession } from '../runtime/agent/orchestrator/session/store/live-state.mjs';

function harness(session) {
  let config = { autoClear: { providerIdleMs: { 'anthropic-oauth': 300_000 } } };
  const api = createCompactionSettings({
    getConfig: () => config,
    getRoute: () => ({ provider: 'anthropic-oauth' }),
    getSession: () => session,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    hasOwn: (o, k) => Object.hasOwn(o, k),
    normalizeAutoClearConfig,
    autoClearIdleMsForProvider,
    resolveAutoClearIdleMs,
    normalizeCompactionConfig: (c) => c || {},
    autoClearProviderDefaults: () => [],
    parseDurationMs,
    formatDurationMs: String,
    invalidateContextStatusCache() {},
  });
  return api;
}
const ttl = (s) => s.providerCacheOpts?.cacheStrategy?.messages;
const stale = (extra = {}) => ({
  id: 's1',
  provider: 'anthropic-oauth',
  agent: null,
  providerCacheOpts: { cacheStrategy: { messages: '5m' } },
  ...extra,
});

test('auto-clear changes retarget a Lead session messages TTL', () => {
  const session = stale();
  const api = harness(session);
  api.setAutoClear({ provider: 'anthropic-oauth', duration: '1h' });
  assert.equal(ttl(session), '1h');
  api.setAutoClear({ provider: 'anthropic-oauth', duration: '5m' });
  assert.equal(ttl(session), '5m');
  api.setAutoClear({ enabled: false });
  assert.equal(ttl(session), '1h');
  api.setAutoClear({ enabled: true });
  assert.equal(ttl(session), '5m');
});

test('auto-clear changes also retarget other live Lead sessions in the process', () => {
  const other = stale({ id: 's-live-other' });
  setLiveSession(other);
  try {
    harness(stale()).setAutoClear({ provider: 'anthropic-oauth', duration: '1h' });
    assert.equal(ttl(other), '1h');
  } finally {
    _clearLiveSession(other.id);
  }
});

test('compaction summaryMode defaults to smart, migrates useMaintainer and round-trips through settings', () => {
  let config = {};
  const session = { id: 's1', compaction: { useMaintainer: false } };
  const api = createCompactionSettings({
    getConfig: () => config,
    getRoute: () => ({}),
    getSession: () => session,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    hasOwn: (o, k) => Object.hasOwn(o, k),
    normalizeCompactionConfig,
    invalidateContextStatusCache() {},
  });
  assert.equal(api.getCompactionSettings().summaryMode, 'smart');
  assert.equal(api.setCompactionSettings({ summaryMode: 'self' }).summaryMode, 'self');
  assert.equal(config.compaction.summaryMode, 'self');
  assert.equal(session.compaction.summaryMode, 'self');
  assert.equal(Object.hasOwn(session.compaction, 'useMaintainer'), false, 'the replaced boolean is dropped');
  assert.equal(api.setCompactionSettings({ auto: false }).summaryMode, 'self', 'kept across other edits');
  assert.equal(api.setCompactionSettings({ summaryMode: 'maintainer' }).summaryMode, 'maintainer');
  assert.throws(() => api.setCompactionSettings({ summaryMode: 'fastest' }), /summaryMode smart \| maintainer \| self/);
  assert.equal(config.compaction.summaryMode, 'maintainer');
  // A saved boolean from the previous release migrates on read.
  config = { compaction: { useMaintainer: false } };
  assert.equal(api.getCompactionSettings().summaryMode, 'self');
  assert.equal(Object.hasOwn(api.getCompactionSettings(), 'useMaintainer'), false);
  for (const compaction of [{ useMaintainer: true }, {}, undefined]) {
    config = { compaction };
    assert.equal(api.getCompactionSettings().summaryMode, 'smart');
  }
});

test('auto-compact on model change defaults on and persists with the compaction settings', () => {
  let config = {};
  const session = { id: 's1', compaction: {} };
  const api = createCompactionSettings({
    getConfig: () => config,
    getRoute: () => ({}),
    getSession: () => session,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    hasOwn: (o, k) => Object.hasOwn(o, k),
    normalizeCompactionConfig,
    invalidateContextStatusCache() {},
  });
  assert.equal(api.getCompactionSettings().onModelChange, true);
  assert.equal(api.setCompactionSettings({ onModelChange: false }).onModelChange, false);
  assert.equal(config.compaction.onModelChange, false);
  assert.equal(config.compaction.auto, true, 'auto-compact itself is untouched');
  assert.equal(session.compaction.onModelChange, false);
  assert.equal(api.setCompactionSettings({ auto: false }).onModelChange, false, 'kept across other edits');
  assert.equal(api.setCompactionSettings({ onModelChange: true }).onModelChange, true);
});

test('a provider idle window can be set to unlimited, reported as never, and reset', () => {
  const session = stale();
  const api = harness(session);
  for (const patch of [{ unlimited: true }, { duration: 'unlimited' }, { duration: 'Never' }, { idleMs: 0 }]) {
    const view = api.setAutoClear({ provider: 'anthropic-oauth', ...patch });
    assert.equal(view.unlimited, true, JSON.stringify(patch));
    assert.equal(view.label, 'unlimited');
    assert.equal(ttl(session), '1h', 'never clearing keeps the 1h Lead tail');
    api.setAutoClear({ provider: 'anthropic-oauth', duration: '5m' });
    assert.equal(api.getAutoClear().unlimited, false);
  }
  api.setAutoClear({ provider: 'anthropic-oauth', unlimited: true });
  const reset = api.setAutoClear({ provider: 'anthropic-oauth', resetProvider: true });
  assert.equal(reset.unlimited, false);
  assert.equal(reset.idleMs, 60 * 60_000);
  assert.throws(() => api.setAutoClear({ provider: 'anthropic-oauth', duration: 'soon' }), /unlimited/);
});

test('/autoclear unlimited|never with no provider applies to the current route provider', () => {
  const api = harness(stale());
  for (const duration of ['unlimited', 'Never']) {
    api.setAutoClear({ provider: 'anthropic-oauth', duration: '5m' });
    const view = api.setAutoClear({ duration });
    assert.equal(view.unlimited, true, duration);
    assert.equal(view.label, 'unlimited');
    assert.equal(api.getAutoClear().unlimited, true, 'stored for the route provider');
  }
  assert.throws(() => api.setAutoClear({ duration: 'soon' }), /usage/);
});

test('getAutoClear reports the human label the settings row shows', () => {
  const api = harness(stale());
  assert.equal(api.getAutoClear().label, String(300_000), 'formatted by the injected duration formatter');
  api.setAutoClear({ provider: 'anthropic-oauth', unlimited: true });
  assert.equal(api.getAutoClear().label, 'unlimited');
});

test('explicit and non-Lead cache policies are not refreshed by auto-clear changes', () => {
  const override = stale({ providerCacheOptsOverride: true });
  harness(override).setAutoClear({ provider: 'anthropic-oauth', duration: '1h' });
  assert.equal(ttl(override), '5m');
  const worker = stale({ agent: 'worker' });
  harness(worker).setAutoClear({ provider: 'anthropic-oauth', duration: '1h' });
  assert.equal(ttl(worker), '5m');
});
