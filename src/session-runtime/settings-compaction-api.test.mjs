import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompactionSettings } from './settings-compaction-api.mjs';
import {
  normalizeAutoClearConfig,
  autoClearIdleMsForProvider,
  resolveAutoClearIdleMs,
  parseDurationMs,
} from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import {
  _clearLiveSession,
  setLiveSession,
} from '../runtime/agent/orchestrator/session/store/live-state.mjs';

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

test('explicit and non-Lead cache policies are not refreshed by auto-clear changes', () => {
  const override = stale({ providerCacheOptsOverride: true });
  harness(override).setAutoClear({ provider: 'anthropic-oauth', duration: '1h' });
  assert.equal(ttl(override), '5m');
  const worker = stale({ agent: 'worker' });
  harness(worker).setAutoClear({ provider: 'anthropic-oauth', duration: '1h' });
  assert.equal(ttl(worker), '5m');
});
