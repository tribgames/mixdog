import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LOCAL_PROVIDER_MANIFEST, localProviderModelRoot } from './catalog.mjs';
import { localProviderStatus } from './managed-runtime.mjs';

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
