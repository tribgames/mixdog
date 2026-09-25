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
    for (const tokens of [512, 16384, entry.maxContextWindow]) {
      saveLocalContext(entry, tokens, dataDir);
      const model = localProviderCatalogStatus({ dataDir }).models.find((row) => row.id === entry.id);
      assert.equal(model.contextWindow, tokens);
      assert.equal(model.runtimeContextWindow, tokens);
      assert.equal(model.maxContextWindow, entry.maxContextWindow);
    }
    for (const invalid of [0, 511, 1.5, '8192', undefined, NaN, Infinity, entry.maxContextWindow + 1]) {
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
    saveLocalContext(entry, 512, dataDir);
    const file = join(dataDir, 'local-provider', 'context', readdirSync(join(dataDir, 'local-provider', 'context'))[0]);
    for (const contents of ['{not json', 'null', JSON.stringify({ tokens: entry.maxContextWindow + 1 })]) {
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
    const change = setLocalProviderContext(entry.id, 8192, { dataDir });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(localContextSettings(entry, dataDir).configuredContextWindow, null);
    finish();
    await Promise.all([inference, change]);
    assert.equal(localContextSettings(entry, dataDir).runtimeContextWindow, 8192);
    await assert.rejects(setLocalProviderContext('missing', 8192, { dataDir }), /Unknown/);
  } finally {
    finish();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
