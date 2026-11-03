// A Gemini long-decode turn bills every hop's prompt, but its context holds the
// first hop's prompt and what was generated. The gauge must read that same
// occupancy (what compaction counts), with a cache split that fits inside it,
// while the session's billed totals keep the summed values.
import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-long-decode-gauge-'));
process.env.MIXDOG_DATA_DIR = dataDir;
after(() => {
  delete process.env.MIXDOG_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const metrics = await import('./manager/usage-metrics.mjs');
const { usageDeltaEvent } = await import('./loop/usage.mjs');

// 2 hops: billed input 100 + 150, cached reads 60 + 100, output 75.
const usage = {
  inputTokens: 250,
  promptTokens: 250,
  cachedTokens: 160,
  outputTokens: 75,
  contextInputTokens: 100,
  contextCachedTokens: 60,
};

function assertGauge(session) {
  assert.equal(session.lastContextTokens, 175);
  assert.equal(session.lastInputTokens, 100);
  assert.equal(session.lastCachedReadTokens, 60);
  assert.equal(session.lastUncachedInputTokens, 40);
}

test('the live gauge shows the compaction occupancy and a cache split inside it; billing stays summed', async () => {
  const id = 'sess_long_decode_gauge';
  const session = { id, provider: 'gemini', messages: [{ role: 'user', content: 'hi' }] };
  metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session }) });
  try {
    metrics.bumpUsageMetricsTurnId(session);
    await metrics.persistIterationMetrics({
      ...usageDeltaEvent({ sessionId: id, iterationIndex: 1, usage, sendTools: [] }),
      sessionId: id,
    });
    assertGauge(session);
    assert.equal(session.totalInputTokens, 250);
    assert.equal(session.totalCachedReadTokens, 160);
  } finally {
    metrics.dropMetricSeenState(id);
  }
});

test('the terminal gauge reading matches the live one', () => {
  const session = { id: 'sess_long_decode_terminal', provider: 'gemini' };
  metrics.applyAskTerminalUsageTotals(session, { usage, lastTurnUsage: usage });
  assertGauge(session);
});
