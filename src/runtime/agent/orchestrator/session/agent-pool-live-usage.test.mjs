// The Agents pool shows an agent's running token total from its live session
// the moment a model response lands, not after the throttled save, and the
// pool is told to re-read at that moment.
import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-pool-live-usage-'));
process.env.MIXDOG_DATA_DIR = dataDir;
after(async () => {
  // A held session writer lock keeps its file (and the dir) from being removed on Windows.
  (await import('./store/session-writer-claim.mjs')).releaseHeldSessionWriters();
  delete process.env.MIXDOG_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const { withLiveUsage } = await import('./agent-pool-progress.mjs');
const { onSessionActivityChange } = await import('../../../shared/session-activity-signal.mjs');
const metrics = await import('./manager/usage-metrics.mjs');

test('a row shows the live session totals; a row without a live session keeps its stored ones', () => {
  const stored = { sessionId: 'a', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: 1 };
  const other = { sessionId: 'b', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, toolCalls: 2 };
  const live = { id: 'a', totalInputTokens: 300, totalOutputTokens: 40, totalToolCalls: 7 };
  const [a, b] = withLiveUsage([stored, other], (id) => (id === 'a' ? live : undefined));
  assert.deepEqual(a.usage, { inputTokens: 300, outputTokens: 40, totalTokens: 340 });
  assert.equal(a.toolCalls, 7);
  assert.equal(b, other);
  // A live session that has recorded nothing yet does not blank the stored totals.
  const [blank] = withLiveUsage([stored], () => ({ id: 'a' }));
  assert.deepEqual([blank.usage, blank.toolCalls], [stored.usage, stored.toolCalls]);
});

test('a model response moves the live totals and pulses the pool once; a replay does neither', async () => {
  const id = 'sess_pool_live_usage';
  const session = { id, provider: 'anthropic', messages: [{ role: 'user', content: 'hi' }] };
  metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session }) });
  const pulses = [];
  const off = onSessionActivityChange((sessionId) => pulses.push(sessionId));
  try {
    metrics.bumpUsageMetricsTurnId(session);
    const delta = { sessionId: id, iterationIndex: 1, deltaInput: 120, deltaOutput: 30, deltaPrompt: 120 };
    await metrics.persistIterationMetrics(delta);
    const [row] = withLiveUsage([{ sessionId: id }], () => session);
    assert.equal(row.usage.totalTokens, 150);
    assert.deepEqual(pulses, [id]);
    await metrics.persistIterationMetrics(delta);
    assert.deepEqual(pulses, [id], 'the same call is not counted or announced twice');
  } finally {
    off();
    metrics.dropMetricSeenState(id);
  }
});
