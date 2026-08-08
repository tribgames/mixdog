import assert from 'node:assert/strict';
import test from 'node:test';

import {
  moduleEnabled,
  setModuleEnabledInConfig,
} from '../src/session-runtime/config-helpers.mjs';
import { createSettingsApi } from '../src/session-runtime/settings-api.mjs';
import { createToolSurface } from '../src/session-runtime/tool-surface.mjs';

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
    webSearchEnabled: () => moduleEnabled(config, 'search', true),
    exploreEnabled: () => moduleEnabled(config, 'explore', true),
    invalidatePreSessionToolSurface: () => { invalidations += 1; },
  });

  assert.deepEqual(api.getToolModuleSettings(), {
    search: { enabled: true },
    explore: { enabled: true },
  });
  api.setWebSearchEnabled(false);
  api.setExploreEnabled(false);
  assert.deepEqual(config.modules, {
    search: { enabled: false },
    explore: { enabled: false },
  });
  assert.deepEqual(api.getToolModuleSettings(), {
    search: { enabled: false },
    explore: { enabled: false },
  });
  assert.equal(invalidations, 2);
});

test('new session previews and standalone catalogs omit disabled feature tools', () => {
  const tools = ['read', 'search', 'web_fetch', 'explore', 'memory', 'recall'].map(tool);
  let disabled = ['search', 'web_fetch', 'explore', 'memory'];
  const surface = createToolSurface({
    mgr: { previewSessionTools: () => tools },
    mode: 'lead',
    standaloneTools: tools,
    agentToolNames: new Set(),
    getSession: () => null,
    getRoute: () => ({ provider: 'xai' }),
    getConfig: () => ({}),
    cfgMod: { getPluginData: () => '' },
    loadWorkflowPack: () => ({ agentsConfigured: true, agents: [{}] }),
    activeWorkflowId: () => 'default',
    dataDir: '',
    getFeatureDisallowedTools: () => disabled,
  });

  assert.deepEqual(surface.modelStandaloneTools().map(({ name }) => name), ['read', 'recall']);
  assert.deepEqual(
    surface.activeToolSurface().deferredToolCatalog.map(({ name }) => name).sort(),
    ['read', 'recall'],
  );

  disabled = [];
  surface.invalidatePreSessionToolSurface();
  assert.deepEqual(
    surface.activeToolSurface().deferredToolCatalog.map(({ name }) => name).sort(),
    ['explore', 'memory', 'read', 'recall', 'search', 'web_fetch'],
  );
});
