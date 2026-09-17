import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionContextMeasurement, contextMeasurementStats, measuredContextUsage } from './context-measurement.mjs';
import { applyAskTerminalUsageTotals } from '../runtime/agent/orchestrator/session/manager/usage-metrics.mjs';
import { addUsage, normalizeUsage, usageDeltaEvent } from '../runtime/agent/orchestrator/session/loop/usage.mjs';
import { resolveContextUsedPct } from './statusline.mjs';

test('provider prompt normalization includes cache once for hosted and local routes', () => {
  for (const provider of ['openai-oauth', 'gemini', 'grok-oauth', 'mixdog-local', 'anthropic-oauth']) {
    const excludesCache = provider === 'anthropic-oauth';
    const session = { provider, model: 'test-model', totalInputTokens: 999_999 };
    const usage = {
      inputTokens: excludesCache ? 4700 : 8300,
      outputTokens: 800,
      cachedTokens: 3500,
      cacheWriteTokens: 100,
    };
    applyAskTerminalUsageTotals(session, { usage, lastTurnUsage: usage });
    const measurement = sessionContextMeasurement(session);
    assert.equal(measurement.tokens, 8300, provider);
    const stats = contextMeasurementStats({ measurement });
    const input = { stats, contextWindow: 436000, autoCompactTokenLimit: 10000 };
    assert.equal(measuredContextUsage(input).percent, 1.9);
    assert.equal(resolveContextUsedPct({ ...input, gatewayStatus: { contextUsedPct: 99 } }), 1.9);
    // Unsent additions and an out-of-date pressure anchor cannot change last input.
    session.messages = [{ role: 'user', content: 'new work '.repeat(10000) }];
    session.contextPressureBaselineTokens = 99000;
    assert.deepEqual(sessionContextMeasurement(session), measurement);
  }
});

test('measurement lifecycle distinguishes pending, missing usage, compaction, and changed routes', () => {
  const session = { provider: 'mixdog-local', model: 'qwen' };
  assert.equal(sessionContextMeasurement(session).source, 'pending');
  applyAskTerminalUsageTotals(session, { usage: { inputTokens: 24000, outputTokens: 30 } });
  assert.equal(sessionContextMeasurement(session).tokens, 24000);
  const measuredAt = session.lastContextTokensUpdatedAt;
  session.compaction = { lastChangedAt: measuredAt + 1 };
  session.lastContextTokensStaleAfterCompact = true;
  assert.equal(sessionContextMeasurement(session).source, 'pending');
  session.lastContextTokensUpdatedAt = measuredAt + 2;
  session.lastContextTokensStaleAfterCompact = false;
  assert.equal(sessionContextMeasurement(session).tokens, 24000);
  session.contextPressureBaselineModel = 'old-model';
  assert.equal(sessionContextMeasurement(session).source, 'pending');
  delete session.contextPressureBaselineModel;
  session.lastContextTokens = null;
  session.lastContextTokensStaleAfterCompact = true;
  assert.equal(sessionContextMeasurement(session).source, 'unavailable');
});

test('a provider without main usage never exposes output or a warmup as measured input', () => {
  for (const lastTurnUsage of [
    { inputTokens: 0, outputTokens: 120 },
    { mainUsageAvailable: false, inputTokens: 9000, outputTokens: 120 },
    { mainInputTokens: 0, inputTokens: 9000, mainOutputTokens: 120 },
  ]) {
    const session = { provider: 'openai-oauth', lastContextTokens: 8000 };
    applyAskTerminalUsageTotals(session, { usage: lastTurnUsage, lastTurnUsage });
    assert.equal(sessionContextMeasurement(session).source, 'unavailable');
    assert.equal(sessionContextMeasurement(session).tokens, null);
  }
});

test('Cursor checkpoint occupancy measures the gauge without inventing a prompt or cache split', () => {
  const raw = { inputTokens: null, cachedTokens: null, inputTokensKnown: false, outputTokens: 40, contextTokens: 61_500 };
  const session = { provider: 'cursor-oauth', lastContextTokens: null, lastContextTokensUpdatedAt: 1 };
  applyAskTerminalUsageTotals(session, { usage: normalizeUsage(raw), lastTurnUsage: raw });
  assert.equal(sessionContextMeasurement(session).source, 'last_api_request');
  assert.equal(sessionContextMeasurement(session).tokens, 61_500);
  assert.equal(session.lastInputTokens, null);
  assert.equal(session.lastCachedReadTokens, null);
  assert.equal(session.lastOutputTokens, 40);

  // The aggregated usage keeps the latest occupancy instead of summing it.
  const total = addUsage(normalizeUsage({ ...raw, contextTokens: 30_000 }), raw);
  assert.equal(total.contextTokens, 61_500);
  assert.equal(usageDeltaEvent({ sessionId: 's', iterationIndex: 0, usage: raw }).contextMeasuredTokens, 61_500);

  // A provider that withholds main usage still reports unavailable.
  const withheld = { provider: 'cursor-oauth' };
  applyAskTerminalUsageTotals(withheld, { usage: raw, lastTurnUsage: { ...raw, mainUsageAvailable: false } });
  assert.equal(sessionContextMeasurement(withheld).source, 'unavailable');
});
