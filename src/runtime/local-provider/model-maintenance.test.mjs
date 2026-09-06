import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerLocalModel, registeredLocalModels } from './registered-models.mjs';
import { createModelMaintenance } from './model-maintenance.mjs';
import { localModelState } from './model-state.mjs';
import { localProviderInstallStatus } from './install-progress.mjs';
import { localProviderCatalogStatus } from './catalog.mjs';

function fixture(root, fetchFn) {
  const payload = Buffer.from('verified GGUF fixture');
  const id = `hf-${'a'.repeat(24)}`;
  const model = { id, filename: `${id}.gguf`, remoteFilename: 'model.gguf',
    repository: 'test/model', revision: 'b'.repeat(40), name: 'Test model', source: 'https://huggingface.co/test/model',
    url: `https://huggingface.co/test/model/resolve/${'b'.repeat(40)}/model.gguf`,
    size: payload.length, sha256: createHash('sha256').update(payload).digest('hex'),
    contextWindow: 8192, estimatedVramBytes: 1024 ** 3, minimumVramBytes: 1024 ** 3 };
  registerLocalModel(model, root);
  const directory = join(root, 'local-provider', 'models');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, model.filename);
  writeFileSync(path, payload);
  let running = false, completion;
  const maintenance = createModelMaintenance({ dataDir: root, fetchFn,
    serverStatus: () => ({ running, activeModel: id }),
    exclusive: (operation, options) => { completion = operation(options?.signal || new AbortController().signal); return completion; },
  });
  return { id, path, payload, maintenance,
    running: (value) => { running = value; },
    complete: async () => { await new Promise(setImmediate); await completion; await new Promise(setImmediate); },
  };
}

test('verification reports corruption, repair retains the old file on failure, and a verified replacement succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-model-repair-'));
  let fail = true, payload;
  try {
    const f = fixture(root, async () => { if (fail) throw new Error('offline'); return new Response(payload); });
    payload = f.payload;
    f.maintenance.start(f.id, 'verify');
    await f.complete();
    assert.equal(localModelState(f.id).verification.valid, true);
    writeFileSync(f.path, 'damaged file');
    const damaged = localProviderCatalogStatus({ dataDir: root, hardware: { gpu: null } }).models.find((model) => model.id === f.id);
    assert.equal(damaged.installed, false);
    assert.equal(damaged.present, true);
    f.maintenance.start(f.id, 'verify');
    await assert.rejects(f.complete(), /integrity check failed/);
    assert.equal(localModelState(f.id).verification.valid, false);
    await new Promise(setImmediate);
    f.maintenance.start(f.id, 'repair');
    await assert.rejects(f.complete(), /offline/);
    assert.equal(readFileSync(f.path, 'utf8'), 'damaged file');
    await new Promise(setImmediate);
    fail = false;
    let refreshed = false;
    f.maintenance.start(f.id, 'repair', { onComplete: () => {
      assert.deepEqual(readFileSync(f.path), payload);
      refreshed = true;
    } });
    await f.complete();
    assert.equal(refreshed, true);
    assert.deepEqual(readFileSync(f.path), payload);
    assert.equal(localModelState(f.id).verification.valid, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deletion protects loaded and changed files and requires a fresh exact-path confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-model-delete-'));
  try {
    const f = fixture(root);
    const receipt = f.maintenance.details(f.id);
    assert.equal(receipt.files[0].path, f.path);
    assert.match(receipt.recoverability, /permanently/);
    f.running(true);
    await assert.rejects(f.maintenance.delete(receipt.confirmationToken), /active conversations/);
    f.running(false);
    writeFileSync(f.path, 'changed after confirmation');
    await assert.rejects(f.maintenance.delete(receipt.confirmationToken), /files changed/);
    assert.equal(existsSync(f.path), true);
    const current = f.maintenance.details(f.id);
    await f.maintenance.delete(current.confirmationToken);
    assert.equal(existsSync(f.path), false);
    assert.deepEqual(registeredLocalModels(root), []);
    assert.deepEqual(localProviderInstallStatus(root), []);
    await assert.rejects(f.maintenance.delete(current.confirmationToken), /expired/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
