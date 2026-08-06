import assert from 'node:assert/strict';
import test from 'node:test';

import { createStreamJsonPool } from '../src/runtime/agent/orchestrator/providers/stream-json-pool.mjs';
import { ProviderAdmissionScheduler } from '../src/runtime/agent/orchestrator/providers/admission-scheduler.mjs';

test('large provider stream batches use reusable workers and preserve order', async (t) => {
  const pool = createStreamJsonPool({ maxWorkers: 2, minBatchBytes: 1 });
  t.after(() => pool.close('test complete'));
  const payloads = Array.from({ length: 8 }, (_, index) =>
    JSON.stringify({ index, text: String(index).repeat(64 * 1024) }));
  const first = pool.parseBatch(payloads.slice(0, 4));
  const second = pool.parseBatch(payloads.slice(4));

  assert.equal(pool.snapshot().workers, 2);
  assert.equal(pool.snapshot().activeBatches, 2);
  const values = [...await first, ...await second];
  assert.deepEqual(values.map((value) => value.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pool.snapshot(), {
    workers: 2,
    workerMax: 2,
    activeBatches: 0,
    pendingBytes: 0,
    waitingBatches: 0,
    waitingBytes: 0,
    maxPendingBytes: 32 * 1024 * 1024,
    ownerAffinities: 0,
    inlineBatches: 0,
    offloadedBatches: 2,
    fallbackBatches: 0,
    parsedBytes: payloads.reduce((sum, payload) => sum + Buffer.byteLength(payload), 0),
  });
});

test('small deltas stay inline and malformed JSON remains a SyntaxError', async (t) => {
  const pool = createStreamJsonPool({ maxWorkers: 1, minBatchBytes: 1024 });
  t.after(() => pool.close('test complete'));
  assert.deepEqual(await pool.parseBatch(['{"ok":true}']), [{ ok: true }]);
  await assert.rejects(pool.parseBatch(['{"broken":']), SyntaxError);
  assert.equal(pool.snapshot().workers, 0);
  assert.equal(pool.snapshot().inlineBatches, 2);
});

test('provider session owners keep stable parser-worker affinities', async (t) => {
  const pool = createStreamJsonPool({ maxWorkers: 2, minBatchBytes: 1 });
  const admission = new ProviderAdmissionScheduler();
  t.after(() => Promise.all([
    pool.close('test complete'),
    Promise.resolve(admission.shutdown()),
  ]));
  const payload = JSON.stringify({ text: 'x'.repeat(40_000) });
  const [left, right] = await Promise.all([
    admission.run('openai:left', () => pool.parseBatch([payload]), { ownerKey: 'session-left' }),
    admission.run('openai:right', () => pool.parseBatch([payload]), { ownerKey: 'session-right' }),
  ]);
  assert.equal(left[0].text.length, 40_000);
  assert.equal(right[0].text.length, 40_000);
  assert.deepEqual(pool.snapshot(), {
    workers: 2,
    workerMax: 2,
    activeBatches: 0,
    pendingBytes: 0,
    waitingBatches: 0,
    waitingBytes: 0,
    maxPendingBytes: 32 * 1024 * 1024,
    ownerAffinities: 2,
    inlineBatches: 0,
    offloadedBatches: 2,
    fallbackBatches: 0,
    parsedBytes: Buffer.byteLength(payload) * 2,
  });
});

test('provider stream workers bound posted and waiting payload bytes', async (t) => {
  const pool = createStreamJsonPool({
    maxWorkers: 1,
    minBatchBytes: 1,
    maxPendingBytes: 1024 * 1024,
  });
  t.after(() => pool.close('test complete'));
  const payload = JSON.stringify({ text: 'x'.repeat(700 * 1024) });
  const first = pool.parseBatch([payload], { ownerKey: 'first' });
  const second = pool.parseBatch([payload], { ownerKey: 'second' });
  const loaded = pool.snapshot();
  assert.equal(loaded.activeBatches, 1);
  assert.equal(loaded.waitingBatches, 1);
  assert.ok(loaded.pendingBytes <= loaded.maxPendingBytes);
  assert.ok(loaded.waitingBytes <= loaded.maxPendingBytes);
  await Promise.all([first, second]);
  assert.equal(pool.snapshot().pendingBytes, 0);
  assert.equal(pool.snapshot().waitingBytes, 0);
});

test('a single provider stream batch cannot exceed the worker byte budget', async (t) => {
  const pool = createStreamJsonPool({
    maxWorkers: 1,
    minBatchBytes: 1,
    maxPendingBytes: 1024 * 1024,
  });
  t.after(() => pool.close('test complete'));
  const payload = JSON.stringify({ text: 'x'.repeat(1100 * 1024) });
  await assert.rejects(
    pool.parseBatch([payload]),
    (error) => error?.code === 'ERESOURCEPRESSURE'
      && /batch exceeded 1048576 bytes/.test(error.message),
  );
  assert.equal(pool.snapshot().workers, 0);
  assert.equal(pool.snapshot().pendingBytes, 0);
  assert.equal(pool.snapshot().waitingBytes, 0);
});
