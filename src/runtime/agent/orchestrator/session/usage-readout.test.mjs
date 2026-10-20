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

const { foldUsageReadout, emptyUsageReadout, MIN_SPEED_MS, MIN_SPEED_OUTPUT_TOKENS } = await import(
  '../../../shared/usage-readout-totals.mjs'
);
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
  assert.deepEqual(totals, { input: 100, cacheRead: 900, cacheWrite: 50, output: 0, speedOutputTokens: 0, speedMs: 0 });
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

test('each call meets the speed floors before it is summed', () => {
  let totals = emptyUsageReadout();
  totals = foldUsageReadout(totals, call({ deltaOutput: 200 }), 4000);
  assert.deepEqual([totals.speedOutputTokens, totals.speedMs], [200, 4000]);
  // Too short in tokens, too short in time, untimed: none enters either sum.
  totals = foldUsageReadout(totals, call({ deltaOutput: MIN_SPEED_OUTPUT_TOKENS - 1 }), 5000);
  totals = foldUsageReadout(totals, call({ deltaOutput: 500 }), MIN_SPEED_MS - 1);
  totals = foldUsageReadout(totals, call({ deltaOutput: 500 }), 0);
  assert.deepEqual([totals.speedOutputTokens, totals.speedMs], [200, 4000]);
  totals = foldUsageReadout(totals, call({ deltaOutput: MIN_SPEED_OUTPUT_TOKENS }), MIN_SPEED_MS);
  assert.deepEqual([totals.speedOutputTokens, totals.speedMs], [220, 4500]);
});

test('the usage delta carries the call generation time', () => {
  const event = (extra) =>
    usageDeltaEvent({ sessionId: 's', iterationIndex: 1, usage: { outputTokens: 30 }, ...extra });
  assert.equal(event({ generationMs: 1234 }).generationMs, 1234);
  assert.equal(event({}).generationMs, 0);
});

test('session totals accumulate across turns and tool-loop calls, persist and surface', async () => {
  const id = 'sess_usage_readout';
  const session = { id, provider: 'anthropic', messages: [{ role: 'user', content: 'hello' }] };
  metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session }) });
  const send = (iterationIndex, delta) => metrics.persistIterationMetrics({ sessionId: id, iterationIndex, ...delta });

  // Turn 1: a tool loop of two model calls.
  metrics.bumpUsageMetricsTurnId(session);
  await send(
    1,
    call({ deltaInput: 100, deltaCacheWrite: 900, deltaPrompt: 1000, deltaOutput: 100, generationMs: 2000 })
  );
  await send(
    2,
    call({ deltaInput: 50, deltaCachedRead: 950, deltaPrompt: 1000, deltaOutput: 100, generationMs: 2000 })
  );
  // A replayed delta (same turn/epoch/iteration) is not counted twice.
  await send(
    2,
    call({ deltaInput: 50, deltaCachedRead: 950, deltaPrompt: 1000, deltaOutput: 100, generationMs: 2000 })
  );
  assert.deepEqual(session.usageReadout, {
    input: 150,
    cacheRead: 950,
    cacheWrite: 900,
    output: 200,
    speedOutputTokens: 200,
    speedMs: 4000,
  });

  // Turn 2 (iteration indices restart): one more call, too short to time.
  metrics.bumpUsageMetricsTurnId(session);
  await send(1, call({ deltaInput: 10, deltaCachedRead: 990, deltaPrompt: 1000, deltaOutput: 5, generationMs: 300 }));
  const { input, cacheRead, cacheWrite, output, speedOutputTokens, speedMs } = session.usageReadout;
  assert.equal(input + cacheRead + cacheWrite + output, 3000 + 205, 'the total tokens of three calls');
  assert.equal(cacheRead / (input + cacheRead + cacheWrite), 1940 / 3000);
  assert.equal((speedOutputTokens * 1000) / speedMs, 50);

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
