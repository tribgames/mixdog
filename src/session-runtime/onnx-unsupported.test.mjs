// Simulates macOS Intel (darwin-x64), where onnxruntime-node has no binding.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBuiltinToolSettings } from './settings-builtin-tools-api.mjs';
import { builtinFeatureActive } from '../runtime/agent/orchestrator/runtime-core/builtin-features.mjs';
import { embeddingOnDemandCanStart, embeddingWarmupCanStart } from '../runtime/memory/lib/memory-config-flags.mjs';
import { embedText, embedTexts, getEmbeddingInfo, warmupEmbeddingProvider } from '../runtime/memory/lib/embedding-provider.mjs';
import { flushEmbeddingDirty } from '../runtime/memory/lib/memory-embed.mjs';
import { effortJudgeAvailable, installEffortJudge, judgeTurn } from '../runtime/effort-judge/judge-client.mjs';

async function onDarwinX64(fn) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const arch = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
  }
}

function settings() {
  const prepared = [];
  const api = createBuiltinToolSettings(
    {
      getConfig: () => ({}),
      saveConfigAndAdopt() {},
      setRecapEnabledInConfig: (c) => c,
      setMemoryToolsEnabledInConfig: (c) => c,
      setModuleEnabledInConfig: (c) => c,
      prepareBuiltinFeature: async (name) => prepared.push(name),
      recapEnabledFn: () => true,
      memoryToolsEnabledFn: () => true,
      gitToolsEnabledFn: () => true,
      officeToolsEnabledFn: () => true,
      localProviderEnabledFn: () => false,
      webSearchEnabled: () => true,
      invalidateContextStatusCache() {},
      invalidatePreSessionToolSurface() {},
    },
    { status: () => ({}) }
  );
  return { api, prepared };
}

test('embedding gate is closed and provider fails fast on darwin-x64', () =>
  onDarwinX64(async () => {
    assert.equal(embeddingWarmupCanStart(), false);
    assert.equal(embeddingOnDemandCanStart(), false);
    await assert.rejects(warmupEmbeddingProvider(), /unsupported on darwin-x64/);
    await assert.rejects(embedText('hello'), /unsupported on darwin-x64/);
    await assert.rejects(embedTexts(['hello']), /unsupported on darwin-x64/);
    assert.equal(getEmbeddingInfo().supported, false);
    const flushed = await flushEmbeddingDirty({});
    assert.deepEqual(flushed, { attempted: 0, succeeded: 0, failed: [], timedOut: false });
  }));

test('autoEffort is inactive and judge never installs on darwin-x64', () =>
  onDarwinX64(async () => {
    const prev = process.env.MIXDOG_FEATURE_AUTO_EFFORT;
    process.env.MIXDOG_FEATURE_AUTO_EFFORT = '1';
    try {
      assert.equal(builtinFeatureActive({}, 'autoEffort'), false);
    } finally {
      if (prev === undefined) delete process.env.MIXDOG_FEATURE_AUTO_EFFORT;
      else process.env.MIXDOG_FEATURE_AUTO_EFFORT = prev;
    }
    assert.equal(effortJudgeAvailable(), false);
    await assert.rejects(installEffortJudge(), /unsupported on darwin-x64/);
    assert.deepEqual(await judgeTurn({ request: 'x' }), { skipped: 'unsupported' });
  }));

test('settings API reports and rejects autoEffort on darwin-x64', () =>
  onDarwinX64(async () => {
    const { api, prepared } = settings();
    const mods = api.getToolModuleSettings();
    assert.equal(mods.autoEffort.supported, false);
    assert.equal(mods.autoEffort.enabled, false);
    assert.equal(mods.memory.semanticSearchSupported, false);
    await assert.rejects(api.setBuiltinToolEnabled('autoEffort', true), /unsupported on darwin-x64/);
    await assert.rejects(api.installBuiltinFeature('autoEffort'), /unsupported on darwin-x64/);
    assert.deepEqual(prepared, []);
    await api.setBuiltinToolEnabled('autoEffort', false);
  }));

test('settings API reports supported on other platforms', () => {
  const { api } = settings();
  const mods = api.getToolModuleSettings();
  assert.equal(mods.autoEffort.supported, process.platform === 'darwin' && process.arch === 'x64' ? false : true);
});
