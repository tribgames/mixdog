import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// The session store resolves its data dir once per process.
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-usage-readout-'));
process.env.MIXDOG_DATA_DIR = dataDir;
after(() => {
  delete process.env.MIXDOG_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const { foldUsageReadout, emptyUsageReadout } = await import('../../../shared/usage-readout-totals.mjs');
const { usageDeltaEvent } = await import('./loop/usage.mjs');
const metrics = await import('./manager/usage-metrics.mjs');
const { _sessionForDisk } = await import('./store/serialize.mjs');
const { createContextStatus } = await import('../runtime-core/context-status.mjs');
const { sessionTokenCounters } = await import('../runtime-core/context-status-shape.mjs');

const call = (over) => ({ deltaInput: 100, deltaCachedRead: 0, deltaCacheWrite: 0, deltaOutput: 0, ...over });

test('the fold sums prompt split across calls; unmeasured prompts add nothing', () => {
  // Exclusive input (Messages): the prompt is input + cache read + write.
  let totals = foldUsageReadout(
    null,
    call({ deltaInput: 100, deltaCachedRead: 900, deltaCacheWrite: 50, deltaPrompt: 1050 })
  );
  assert.deepEqual(totals, {
    input: 100,
    cacheRead: 900,
    cacheWrite: 50,
    output: 0,
    requestOutputTokens: 0,
    requestMs: 0,
  });
  // Inclusive input (Responses): the cache is inside the reported input.
  totals = foldUsageReadout(totals, call({ deltaInput: 1000, deltaCachedRead: 800, deltaPrompt: 1000 }));
  assert.deepEqual([totals.input, totals.cacheRead, totals.cacheWrite], [300, 1700, 50]);
  // A call that could not measure its prompt is unknown, not zero; its output is known.
  const before = totals;
  totals = foldUsageReadout(totals, { deltaOutput: 14, promptKnown: false });
  assert.deepEqual(totals, { ...before, output: 14 });
  assert.notEqual(totals, before, 'a new record, never a mutation');
});

test('the output sum counts every call; a record without it never grows a partial one', () => {
  let totals = foldUsageReadout(null, call({ deltaOutput: 5 }), 0);
  totals = foldUsageReadout(totals, call({ deltaOutput: 200 }), 4000);
  assert.equal(totals.output, 205, 'timed and untimed calls alike');
  const { output: _output, ...legacy } = totals;
  assert.equal('output' in foldUsageReadout(legacy, call({ deltaOutput: 7 })), false);
});

test('every call with positive output and positive duration is summed, as the usage ledger does', () => {
  let totals = emptyUsageReadout();
  totals = foldUsageReadout(totals, call({ deltaOutput: 200 }), 4000);
  assert.deepEqual([totals.requestOutputTokens, totals.requestMs], [200, 4000]);
  // No output, no duration, a non-finite or negative duration: none enters either sum.
  totals = foldUsageReadout(totals, call({ deltaOutput: 0 }), 5000);
  totals = foldUsageReadout(totals, call({ deltaOutput: 500 }), 0);
  totals = foldUsageReadout(totals, call({ deltaOutput: 500 }), Number.NaN);
  totals = foldUsageReadout(totals, call({ deltaOutput: 500 }), -10);
  assert.deepEqual([totals.requestOutputTokens, totals.requestMs], [200, 4000]);
  // A short or quick reply is a call like any other.
  totals = foldUsageReadout(totals, call({ deltaOutput: 5 }), 300);
  assert.deepEqual([totals.requestOutputTokens, totals.requestMs], [205, 4300]);
  totals = foldUsageReadout(totals, call({ deltaOutput: 1 }), 1);
  assert.deepEqual([totals.requestOutputTokens, totals.requestMs], [206, 4301]);
});

test('a record saved with the first-token speed keeps it and gains the request-time sums beside it', () => {
  const legacy = { input: 1, cacheRead: 0, cacheWrite: 0, output: 300, speedOutputTokens: 300, speedMs: 1000 };
  const totals = foldUsageReadout(legacy, call({ deltaOutput: 200 }), 4000);
  assert.deepEqual([totals.speedOutputTokens, totals.speedMs], [300, 1000]);
  assert.deepEqual([totals.requestOutputTokens, totals.requestMs], [200, 4000]);
});

test('the usage delta carries the call request time', () => {
  const event = (extra) =>
    usageDeltaEvent({ sessionId: 's', iterationIndex: 1, usage: { outputTokens: 30 }, ...extra });
  assert.equal(event({ requestMs: 1234 }).requestMs, 1234);
  assert.equal(event({}).requestMs, 0);
});

test('session totals accumulate across turns and tool-loop calls, persist and surface', async () => {
  const id = 'sess_usage_readout';
  const session = { id, provider: 'anthropic', messages: [{ role: 'user', content: 'hello' }] };
  metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session }) });
  const send = (iterationIndex, delta) => metrics.persistIterationMetrics({ sessionId: id, iterationIndex, ...delta });

  // Turn 1: a tool loop of two model calls.
  metrics.bumpUsageMetricsTurnId(session);
  await send(1, call({ deltaInput: 100, deltaCacheWrite: 900, deltaPrompt: 1000, deltaOutput: 100, requestMs: 2000 }));
  await send(2, call({ deltaInput: 50, deltaCachedRead: 950, deltaPrompt: 1000, deltaOutput: 100, requestMs: 2000 }));
  // A replayed delta (same turn/epoch/iteration) is not counted twice.
  await send(2, call({ deltaInput: 50, deltaCachedRead: 950, deltaPrompt: 1000, deltaOutput: 100, requestMs: 2000 }));
  assert.deepEqual(session.usageReadout, {
    input: 150,
    cacheRead: 950,
    cacheWrite: 900,
    output: 200,
    requestOutputTokens: 200,
    requestMs: 4000,
  });

  // Turn 2 (iteration indices restart): one more call, with no request time.
  metrics.bumpUsageMetricsTurnId(session);
  await send(1, call({ deltaInput: 10, deltaCachedRead: 990, deltaPrompt: 1000, deltaOutput: 5, requestMs: 0 }));
  const { input, cacheRead, cacheWrite, output, requestOutputTokens, requestMs } = session.usageReadout;
  assert.equal(input + cacheRead + cacheWrite + output, 3000 + 205, 'the total tokens of three calls');
  assert.equal(cacheRead / (input + cacheRead + cacheWrite), 1940 / 3000);
  assert.equal((requestOutputTokens * 1000) / requestMs, 50);

  // Survives a restart (disk projection) and reaches the status the TUI reads.
  const restored = JSON.parse(JSON.stringify(_sessionForDisk(session)));
  assert.deepEqual(restored.usageReadout, session.usageReadout);
  const api = createContextStatus({
    getSession: () => restored,
    getRoute: () => ({ provider: 'anthropic', model: 'test' }),
    getCurrentCwd: () => process.cwd(),
    getMode: () => 'code',
  });
  assert.deepEqual(api.contextStatus().usage.usageReadout, session.usageReadout);

  // The status cache key moves with the totals.
  const key = sessionTokenCounters(session).usageReadout;
  await send(2, call({ deltaInput: 1, deltaPrompt: 1 }));
  assert.notEqual(sessionTokenCounters(session).usageReadout, key);
  metrics.dropMetricSeenState(id);
});
