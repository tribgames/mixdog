import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localContextSettings, saveLocalContext } from './context-settings.mjs';
import { LOCAL_PROVIDER_MANIFEST, localProviderCatalogStatus } from './catalog.mjs';
import { runLocalProviderRequest, setLocalProviderContext } from './server.mjs';

test('model context persists independently, validates boundaries, and resets to its default', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-context-'));
  const entry = LOCAL_PROVIDER_MANIFEST.models[0];
  try {
    assert.equal(localContextSettings(entry, dataDir).configuredContextWindow, null);
    for (const tokens of [16384, 32768, entry.maxContextWindow]) {
      saveLocalContext(entry, tokens, dataDir);
      const model = localProviderCatalogStatus({ dataDir }).models.find((row) => row.id === entry.id);
      assert.equal(model.contextWindow, tokens);
      assert.equal(model.runtimeContextWindow, tokens);
      assert.equal(model.maxContextWindow, entry.maxContextWindow);
    }
    for (const invalid of [0, 511, 8192, 16383, 1.5, '16384', undefined, NaN, Infinity, entry.maxContextWindow + 1]) {
      assert.throws(() => saveLocalContext(entry, invalid, dataDir));
    }
    assert.equal(localContextSettings({ ...entry, id: 'another-model' }, dataDir).configuredContextWindow, null);
    saveLocalContext(entry, null, dataDir);
    assert.equal(localContextSettings(entry, dataDir).contextWindow, entry.contextWindow);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a corrupt or out-of-range context file falls back to the model default', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-context-corrupt-'));
  const entry = LOCAL_PROVIDER_MANIFEST.models[0];
  try {
    saveLocalContext(entry, 16384, dataDir);
    const file = join(dataDir, 'local-provider', 'context', readdirSync(join(dataDir, 'local-provider', 'context'))[0]);
    for (const contents of [
      '{not json',
      'null',
      JSON.stringify({ tokens: entry.maxContextWindow + 1 }),
      JSON.stringify({ tokens: 8192 }),
    ]) {
      writeFileSync(file, contents);
      const settings = localContextSettings(entry, dataDir);
      assert.equal(settings.configuredContextWindow, null, contents);
      assert.equal(settings.contextWindow, entry.contextWindow, contents);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('applying context waits for inference without aborting it, then exposes the saved capacity', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-context-queue-'));
  const entry = LOCAL_PROVIDER_MANIFEST.models[0];
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  try {
    const inference = runLocalProviderRequest(async (signal) => {
      await gate;
      assert.equal(signal.aborted, false);
    });
    const change = setLocalProviderContext(entry.id, 16384, { dataDir });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(localContextSettings(entry, dataDir).configuredContextWindow, null);
    finish();
    await Promise.all([inference, change]);
    assert.equal(localContextSettings(entry, dataDir).runtimeContextWindow, 16384);
    await assert.rejects(setLocalProviderContext('missing', 16384, { dataDir }), /Unknown/);
  } finally {
    finish();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a model registered below the agent minimum runs at the minimum its GGUF allows', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-context-legacy-'));
  try {
    const legacy = { id: 'legacy-model', contextWindow: 8192, maxContextWindow: 131072 };
    assert.equal(localContextSettings(legacy, dataDir).contextWindow, 16384);
    assert.equal(localContextSettings(legacy, dataDir).minContextWindow, 16384);
    const small = { id: 'small-model', contextWindow: 4096, maxContextWindow: 4096 };
    assert.equal(localContextSettings(small, dataDir).contextWindow, 4096);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
