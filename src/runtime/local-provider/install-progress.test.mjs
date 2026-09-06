import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { trackLocalInstallation, localProviderInstallStatus, cancelLocalInstallation } from './install-progress.mjs';

test('installation observers share work and verification never reports early completion', async () => {
  const root = join(tmpdir(), randomUUID());
  const descriptor = { phase: 'model', modelId: 'test-model' };
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  let publish;
  let calls = 0;
  const operation = async (progress) => {
    calls += 1;
    publish = progress;
    await gate;
    return 'installed';
  };
  const observed = [];
  const first = trackLocalInstallation(root, descriptor, operation);
  const second = trackLocalInstallation(root, descriptor, operation, (value) => observed.push(value));
  await Promise.resolve();
  publish({ stage: 'downloading', receivedBytes: 42, totalBytes: 100, percent: 42 });
  assert.equal(localProviderInstallStatus(root)[0].percent, 42);
  publish({ stage: 'verifying', receivedBytes: 100, totalBytes: 100, percent: 100 });
  assert.equal(localProviderInstallStatus(root)[0].state, 'running');
  assert.equal(localProviderInstallStatus(root)[0].percent, 99);
  finish();
  assert.deepEqual(await Promise.all([first, second]), ['installed', 'installed']);
  assert.equal(calls, 1);
  assert.equal(observed.at(-1).state, 'complete');
  assert.equal(observed.at(-1).percent, 100);
});

test('failed installation status remains readable and a retry starts new work', async () => {
  const root = join(tmpdir(), randomUUID());
  const descriptor = { phase: 'runtime' };
  await assert.rejects(trackLocalInstallation(root, descriptor, async () => {
    throw new Error('digest mismatch');
  }), /digest mismatch/);
  assert.equal(localProviderInstallStatus(root)[0].state, 'failed');
  assert.equal(localProviderInstallStatus(root)[0].error, 'digest mismatch');
  await trackLocalInstallation(root, descriptor, async () => 'recovered');
  assert.equal(localProviderInstallStatus(root)[0].state, 'complete');
  assert.equal(localProviderInstallStatus(root)[0].error, undefined);
  assert.deepEqual(localProviderInstallStatus(join(tmpdir(), randomUUID())), []);
});

test('explicit cancellation targets one shared job, retains a paused receipt, and cannot cancel a later retry', async () => {
  const root = join(tmpdir(), randomUUID());
  const descriptor = { phase: 'model', modelId: 'model' };
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const operation = (_publish, signal) => new Promise((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    entered();
  });
  const first = trackLocalInstallation(root, descriptor, operation);
  const second = trackLocalInstallation(root, descriptor, operation);
  const failures = [assert.rejects(first, /paused by user/), assert.rejects(second, /paused by user/)];
  await started;
  const jobId = localProviderInstallStatus(root)[0].jobId;
  assert.equal(cancelLocalInstallation(jobId, root).state, 'cancelling');
  await Promise.all(failures);
  assert.equal(localProviderInstallStatus(root)[0].state, 'paused');
  await trackLocalInstallation(root, descriptor, async () => 'resumed');
  assert.equal(localProviderInstallStatus(root)[0].state, 'complete');
  assert.notEqual(localProviderInstallStatus(root)[0].jobId, jobId);
  assert.throws(() => cancelLocalInstallation(jobId, root), /job not found/);
});
