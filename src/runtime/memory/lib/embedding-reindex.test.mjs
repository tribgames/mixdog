import assert from 'node:assert/strict';
import test from 'node:test';

import { drainEmbeddingReindex, runRootEmbedSweep } from './embedding-reindex.mjs';

test('the root text sweep rests between steps and stops when done or cancelled', async () => {
  const steps = [
    { claimed: 8, replaced: 8, done: false },
    { claimed: 8, replaced: 7, done: false },
    { claimed: 3, replaced: 3, done: true },
  ];
  const waits = [];
  const summary = await runRootEmbedSweep({
    sweepStep: async () => steps.shift(),
    wait: async (ms) => waits.push(ms),
  });
  assert.deepEqual(summary, { steps: 3, replaced: 18 });
  assert.equal(waits.length, 2);
  assert.ok(waits.every((ms) => ms >= 4_000));

  const controller = new AbortController();
  const cancelled = new Error('memory service stopping');
  let calls = 0;
  await assert.rejects(
    runRootEmbedSweep({
      sweepStep: async () => {
        calls += 1;
        return { replaced: 8, done: false };
      },
      signal: controller.signal,
      wait: async () => controller.abort(cancelled),
    }),
    (error) => error === cancelled
  );
  assert.equal(calls, 1);
});

test('embedding reindex resumes timed-out entry passes', async () => {
  const results = [
    { attempted: 32, succeeded: 32, failed: [], timedOut: true },
    { attempted: 4, succeeded: 4, failed: [], timedOut: false },
  ];
  let waits = 0;
  const summary = await drainEmbeddingReindex({
    flushEntries: async () => results.shift(),
    wait: async () => {
      waits += 1;
    },
  });
  assert.deepEqual(summary, {
    passes: 2,
    attempted: 36,
    succeeded: 36,
    failed: 0,
  });
  assert.equal(waits, 1);
});

test('embedding reindex stops retrying a timed-out pass that made no progress', async () => {
  let calls = 0;
  const summary = await drainEmbeddingReindex({
    flushEntries: async () => {
      calls += 1;
      return { attempted: 32, succeeded: 0, failed: Array(32).fill(0), timedOut: true };
    },
  });
  assert.equal(calls, 1);
  assert.equal(summary.failed, 32);
});
