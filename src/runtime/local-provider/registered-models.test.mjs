import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerLocalModel, registeredLocalModels } from './registered-models.mjs';

const id = `hf-${'a'.repeat(24)}`;
const model = {
  id,
  filename: `${id}.gguf`,
  remoteFilename: 'model.gguf',
  repository: 'test/model',
  revision: 'b'.repeat(40),
  name: 'Test model',
  source: 'https://huggingface.co/test/model',
  url: `https://huggingface.co/test/model/resolve/${'b'.repeat(40)}/model.gguf`,
  size: 1024,
  sha256: 'c'.repeat(64),
  contextWindow: 8192,
  estimatedVramBytes: 1024 ** 3,
  minimumVramBytes: 1024 ** 3,
};

test('a NUL-filled model index lists no models, is kept aside, and registration works again', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-registered-models-'));
  try {
    registerLocalModel(model, root);
    const indexPath = join(root, 'local-provider', 'registered-models.json');
    writeFileSync(indexPath, Buffer.alloc(256));
    assert.deepEqual(registeredLocalModels(root), []);
    const directory = join(root, 'local-provider');
    assert.ok(readdirSync(directory).some((name) => name.startsWith('registered-models.json.corrupt-')));
    registerLocalModel(model, root);
    assert.equal(registeredLocalModels(root).length, 1);
    assert.equal(JSON.parse(readFileSync(indexPath, 'utf8')).models.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a newer build index is left in place and registration refuses to replace it', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-registered-models-'));
  try {
    const indexPath = join(root, 'local-provider', 'registered-models.json');
    registerLocalModel(model, root);
    const newer = JSON.stringify({ schema: 2, models: [{ id: 'future' }] });
    writeFileSync(indexPath, newer);
    assert.deepEqual(registeredLocalModels(root), []);
    const second = { ...model, id: `hf-${'e'.repeat(24)}`, filename: `hf-${'e'.repeat(24)}.gguf` };
    assert.throws(() => registerLocalModel(second, root), /newer than this build/);
    assert.equal(readFileSync(indexPath, 'utf8'), newer);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an oversized damaged index still restores a small valid backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-registered-models-'));
  try {
    registerLocalModel(model, root);
    const second = { ...model, id: `hf-${'d'.repeat(24)}`, filename: `hf-${'d'.repeat(24)}.gguf` };
    registerLocalModel(second, root);
    writeFileSync(join(root, 'local-provider', 'registered-models.json'), Buffer.alloc(2 * 1024 * 1024));
    assert.deepEqual(
      registeredLocalModels(root).map((entry) => entry.id),
      [id]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a damaged model index is restored from the last good copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-registered-models-'));
  try {
    registerLocalModel(model, root);
    const second = { ...model, id: `hf-${'d'.repeat(24)}`, filename: `hf-${'d'.repeat(24)}.gguf` };
    registerLocalModel(second, root);
    writeFileSync(join(root, 'local-provider', 'registered-models.json'), '{"schema":1,"mod');
    assert.deepEqual(
      registeredLocalModels(root).map((entry) => entry.id),
      [id]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
