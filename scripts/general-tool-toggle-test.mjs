import assert from 'node:assert/strict';
import test from 'node:test';

import {
  moduleEnabled,
  memoryToolsEnabled,
  setMemoryToolsEnabledInConfig,
  setModuleEnabledInConfig,
} from '../src/session-runtime/config-helpers.mjs';
import { createSettingsApi } from '../src/session-runtime/settings-api.mjs';
import { createToolSurface } from '../src/session-runtime/tool-surface.mjs';
import { createCwdPlugins } from '../src/session-runtime/cwd-plugins.mjs';

const tool = (name) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: name !== 'memory' },
});

test('General tool toggles default on and persist canonical module entries', () => {
  let config = {};
  let invalidations = 0;
  const api = createSettingsApi({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => { config = next; },
    setModuleEnabledInConfig,
    setMemoryToolsEnabledInConfig,
    webSearchEnabled: () => moduleEnabled(config, 'search', true),
    exploreEnabled: () => moduleEnabled(config, 'explore', true),
    memoryToolsEnabledFn: () => memoryToolsEnabled(config, true),
    invalidatePreSessionToolSurface: () => { invalidations += 1; },
  });

  assert.deepEqual(api.getToolModuleSettings(), {
    search: { enabled: true },
    explore: { enabled: true },
    memory: { enabled: true },
  });
  api.setWebSearchEnabled(false);
  api.setExploreEnabled(false);
  api.setMemoryToolsEnabled(false);
  assert.deepEqual(config.modules, {
    search: { enabled: false },
    explore: { enabled: false },
  });
  assert.deepEqual(config.memoryTools, { enabled: false });
  assert.deepEqual(api.getToolModuleSettings(), {
    search: { enabled: false },
    explore: { enabled: false },
    memory: { enabled: false },
  });
  assert.equal(invalidations, 3);
});

test('new session previews and standalone catalogs omit disabled feature tools', () => {
  const tools = ['read', 'search', 'web_fetch', 'explore', 'memory', 'recall'].map(tool);
  let disabled = ['search', 'web_fetch', 'explore', 'memory', 'recall'];
  const surface = createToolSurface({
    mgr: { previewSessionTools: () => tools },
    mode: 'lead',
    standaloneTools: tools,
    agentToolNames: new Set(),
    getSession: () => null,
    getRoute: () => ({ provider: 'xai' }),
    getConfig: () => ({}),
    cfgMod: { getPluginData: () => '' },
    loadWorkflowPack: () => ({ delegatesAgents: true }),
    activeWorkflowId: () => 'default',
    dataDir: '',
    getFeatureDisallowedTools: () => disabled,
  });

  assert.deepEqual(surface.modelStandaloneTools().map(({ name }) => name), ['read']);
  assert.deepEqual(
    surface.activeToolSurface().deferredToolCatalog.map(({ name }) => name).sort(),
    ['read'],
  );

  disabled = [];
  surface.invalidatePreSessionToolSurface();
  assert.deepEqual(
    surface.activeToolSurface().deferredToolCatalog.map(({ name }) => name).sort(),
    ['explore', 'memory', 'read', 'recall', 'search', 'web_fetch'],
  );
});

test('Memory toggle OFF skips only the accumulated core-memory injection', async () => {
  let config = { memoryTools: { enabled: false } };
  let memoryLoads = 0;
  const plugins = createCwdPlugins({
    getCurrentCwd: () => process.cwd(),
    setCurrentCwd: () => {},
    getConfig: () => config,
    getSession: () => null,
    getRoute: () => ({}),
    getLastProjectMcpKey: () => '',
    setLastProjectMcpKey: () => {},
    isCodeGraphPrewarmLazy: () => false,
    isCodeGraphFirstTurnPrewarmDone: () => true,
    getCodeGraphPrewarmDelayMs: () => 0,
    setSessionNeedsCwdRefresh: () => {},
    connectConfiguredMcp: () => {},
    invalidatePreSessionToolSurface: () => {},
    scheduleCodeGraphPrewarm: () => {},
    hooks: null,
    hookCommonPayload: () => ({}),
    bootProfile: () => {},
    getMemoryModule: async () => {
      memoryLoads += 1;
      return { buildSessionCoreMemoryPayload: async () => ({ userLines: ['remember this rule'] }) };
    },
    listRegisteredPlugins: () => [],
    pluginAdminStatus: () => ({}),
    pluginManifest: () => null,
    pluginMcpServerName: () => '',
    clean: (value) => String(value ?? '').trim(),
  });

  assert.equal(await plugins.loadCoreMemoryContext(), '', 'OFF injects nothing');
  assert.equal(memoryLoads, 0, 'OFF never touches the memory runtime');

  // The shared test harness exports MIXDOG_BOOT_CORE_MEMORY=0 (PG-orphan
  // guard); clear it so the ON case exercises the real default path.
  const savedBootFlag = process.env.MIXDOG_BOOT_CORE_MEMORY;
  try {
    delete process.env.MIXDOG_BOOT_CORE_MEMORY;
    config = {};
    assert.equal(await plugins.loadCoreMemoryContext(), '- remember this rule', 'default ON injects the block');
    assert.equal(memoryLoads, 1);
  } finally {
    if (savedBootFlag === undefined) delete process.env.MIXDOG_BOOT_CORE_MEMORY;
    else process.env.MIXDOG_BOOT_CORE_MEMORY = savedBootFlag;
  }
});
