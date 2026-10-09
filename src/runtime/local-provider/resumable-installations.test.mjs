import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LOCAL_PROVIDER_MANIFEST, localProviderModelRoot } from './catalog.mjs';
import { discardLocalInstallation, localProviderStatus } from './managed-runtime.mjs';
import { localProviderInstallStatus, trackLocalInstallation } from './install-progress.mjs';

test('a fresh process status can expose resumable files without an in-memory job', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-local-durable-part-'));
  try {
    const model = LOCAL_PROVIDER_MANIFEST.models[0];
    const models = localProviderModelRoot(dataDir);
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, `${model.filename}.part`), Buffer.alloc(16));
    const status = localProviderStatus({ dataDir, hardware: { gpu: null } });
    const job = status.installations.find((entry) => entry.modelId === model.id);
    assert.equal(job.state, 'paused');
    assert.equal(job.receivedBytes, 16);
    assert.equal(job.jobId, undefined);
    assert.equal(status.models[0].installed, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('discarding a paused model installation deletes its partial file and drops the row', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-local-discard-'));
  try {
    const model = LOCAL_PROVIDER_MANIFEST.models[0];
    const models = localProviderModelRoot(dataDir);
    mkdirSync(models, { recursive: true });
    const partial = join(models, `${model.filename}.part`);
    writeFileSync(partial, Buffer.alloc(16));
    let release;
    const failed = trackLocalInstallation(
      dataDir,
      { phase: 'model', modelId: model.id },
      () =>
        new Promise((_resolve, reject) => {
          release = () => reject(new Error('network lost'));
        })
    );
    assert.throws(() => discardLocalInstallation('model', model.id, dataDir), /stop the installation/);
    await new Promise(setImmediate);
    release();
    await assert.rejects(failed, /network lost/);
    assert.equal(localProviderInstallStatus(dataDir)[0].state, 'failed');
    discardLocalInstallation('model', model.id, dataDir);
    assert.equal(existsSync(partial), false);
    assert.deepEqual(localProviderStatus({ dataDir, hardware: { gpu: null } }).installations, []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
