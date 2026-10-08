import './test-isolation.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { settleSendResult } from './send-phase.mjs';

const T0 = 1_000_000_000_000;

function makeSession(overrides = {}) {
  return {
    provider: 'anthropic',
    providerCacheOpts: { cacheStrategy: { messages: '5m' } },
    lastProviderSendAt: T0,
    lastProviderCachedPrefixTokens: 50_000,
    ...overrides,
  };
}

function settle({ session, guard = null, usage, gapMs = 60_000, intent, providerName } = {}) {
  const traces = [];
  const opts = intent ? { cacheBreakIntent: intent } : {};
  const state = {
    opts,
    sessionRef: session,
    sessionId: 'sess-cache-miss',
    model: 'claude-test',
    provider: { name: providerName || session.provider },
    messages: [],
    prefixGuardState: guard,
    iterations: 0,
    cacheBreakTraceOptions: { traceFn: (row) => traces.push(row), stderr: false },
    throwIfAborted() {},
  };
  const sent = {
    result: { response: { usage } },
    providerMessages: [],
    prefixGuardCandidate: { requestPrefixHash: 'h1', messageHashes: [] },
    sendStartedAt: T0 + gapMs,
    preSendMs: 0,
    toolResumeMs: null,
  };
  settleSendResult(state, { nextIteration: 1, sendTools: [] }, sent);
  return traces;
}

const missUsage = { cachedTokens: 2_000, cacheWriteTokens: 48_000, promptTokens: 52_000 };
const guardState = { requestPrefixHash: 'h1', messageHashes: [] };

test('miss within TTL after reload (no guard state) emits one actual_cache_miss', () => {
  // Reload: only plain persisted fields survive.
  const session = makeSession(JSON.parse(JSON.stringify(makeSession())));
  const traces = settle({ session, guard: null, usage: missUsage });
  assert.equal(traces.length, 1);
  assert.equal(traces[0].reason, 'actual_cache_miss');
  assert.equal(traces[0].classification, 'unexpected');
  assert.equal(traces[0].payload.actual_cache_miss, true);
  assert.equal(traces[0].payload.previous_cached_prefix_tokens, 50_000);
  assert.equal(traces[0].payload.missing_prefix_guard_baseline, true);
  assert.equal(session.lastProviderCachedPrefixTokens, 50_000);
});

test('warm hit emits nothing and updates baseline', () => {
  const session = makeSession();
  const traces = settle({
    session,
    guard: guardState,
    usage: { cachedTokens: 50_000, cacheWriteTokens: 1_000, promptTokens: 52_000 },
  });
  assert.equal(traces.length, 0);
  assert.equal(session.lastProviderCachedPrefixTokens, 51_000);
});

test('idle gap past TTL emits nothing', () => {
  const traces = settle({ session: makeSession(), usage: missUsage, gapMs: 6 * 60_000 });
  assert.equal(traces.length, 0);
});

test('1h strategy keeps a 6 minute gap inside the TTL', () => {
  const session = makeSession({ providerCacheOpts: { cacheStrategy: { messages: '1h' } } });
  assert.equal(settle({ session, usage: missUsage, gapMs: 6 * 60_000 }).length, 1);
});

test('compaction intent emits nothing', () => {
  const traces = settle({ session: makeSession(), usage: missUsage, intent: 'compaction' });
  assert.equal(traces.length, 0);
});

test('non-Anthropic providers emit nothing', () => {
  const traces = settle({ session: makeSession({ provider: 'openai' }), usage: missUsage });
  assert.equal(traces.length, 0);
});
