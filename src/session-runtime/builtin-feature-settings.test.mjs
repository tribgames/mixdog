import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  moduleEnabled,
  setMemoryToolsEnabledInConfig,
  setModuleEnabledInConfig,
  setRecapEnabledInConfig,
} from './config-helpers.mjs';
import { createSettingsApi } from './settings-api.mjs';
import {
  TIDY_CORE_ENGINE_IDS,
  installTidyCoreEngines,
  resetTidyInstallStatus,
  tidyEngineStatus,
  tidyInstallStatus,
} from '../runtime/tidy/core-install.mjs';
import { platformAssetKey } from '../runtime/tidy/install.mjs';

function fixture({
  onPrepare = null,
  tidyEngineStatus: engineStatus = null,
  tidyInstallStatus: installStatus = null,
} = {}) {
  let config = {};
  let refreshes = 0;
  let catalogRefreshes = 0;
  let runtimeInstalled = false;
  let stopped = 0;
  const prepared = [];
  const installedModels = [];
  const registrySyncs = [];
  const api = createSettingsApi({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    setMemoryToolsEnabledInConfig,
    setModuleEnabledInConfig,
    setRecapEnabledInConfig,
    invalidateContextStatusCache() {},
    webSearchEnabled: () => true,
    memoryToolsEnabledFn: () => true,
    gitToolsEnabledFn: () => moduleEnabled(config, 'git', true),
    officeToolsEnabledFn: () => moduleEnabled(config, 'office', true),
    localProviderEnabledFn: () =>
      config.builtins?.localProvider?.installed === true && moduleEnabled(config, 'localProvider', true),
    getLocalProviderStatus: () => ({
      available: true,
      runtime: { installed: runtimeInstalled, version: 'test' },
      models: [],
    }),
    prepareBuiltinFeature: async (name) => {
      prepared.push(name);
      if (name === 'localProvider') runtimeInstalled = true;
      await onPrepare?.(name);
    },
    tidyEngineStatus: engineStatus,
    tidyInstallStatus: installStatus,
    prepareLocalProviderModel: async (modelId) => {
      installedModels.push(modelId);
    },
    refreshLocalProviderCatalog: async () => {
      catalogRefreshes += 1;
    },
    stopLocalProviderServer: async () => {
      stopped += 1;
    },
    syncLocalProviderRegistry: async (enabled) => {
      registrySyncs.push(enabled);
    },
    refreshEmptySessionToolPolicy: async () => {
      refreshes += 1;
    },
  });
  return {
    api,
    config: () => config,
    refreshes: () => refreshes,
    catalogRefreshes: () => catalogRefreshes,
    prepared,
    installedModels,
    stopped: () => stopped,
    registrySyncs,
  };
}

test('built-in Git and Office settings persist and refresh empty-session tools', async () => {
  const state = fixture();
  assert.deepEqual(state.api.getToolModuleSettings().git, { enabled: true, installed: false });
  assert.deepEqual(state.api.getToolModuleSettings().office, { enabled: true, installed: false });

  const result = await state.api.setBuiltinToolEnabled('git', false);
  assert.deepEqual(result.git, { enabled: false, installed: false });
  assert.equal(state.config().modules.git.enabled, false);
  assert.equal(state.refreshes(), 1);
});

test('enabling a built-in tool marks it installed; install runs the adapter', async () => {
  const state = fixture();
  const enabled = await state.api.setBuiltinToolEnabled('office', true);
  assert.deepEqual(enabled.office, { enabled: true, installed: true });
  assert.equal(state.config().builtins.office.installed, true);

  const installed = await state.api.installBuiltinFeature('git');
  assert.deepEqual(installed.git, { enabled: true, installed: true });
  assert.equal(state.config().modules.git.enabled, true);
  await assert.rejects(state.api.installBuiltinFeature('shell'), /git, memory, office, tidy, or localProvider/);

  // Code tidy installs and toggles through the same path as office.
  const tidy = await state.api.installBuiltinFeature('tidy');
  assert.deepEqual(tidy.tidy, { enabled: true, installed: true });
  assert.equal(state.config().builtins.tidy.installed, true);
  const tidyOff = await state.api.setBuiltinToolEnabled('tidy', false);
  assert.deepEqual(tidyOff.tidy, { enabled: false, installed: true });
});

function tidyManifest() {
  const engines = {};
  for (const id of TIDY_CORE_ENGINE_IDS) {
    engines[id] = {
      version: '1.2.3',
      license: 'MIT',
      kind: ['format'],
      languages: ['bash'],
      assets: {
        [id === 'psscriptanalyzer' ? 'any' : platformAssetKey()]: {
          url: `https://example.invalid/${id}`,
          sha256: 'a'.repeat(64),
          archive: 'none',
          binPath: id,
        },
      },
    };
  }
  return { version: 1, engines };
}

test('installing Code Tidy provisions the core engines and keeps the marker when one fails', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tidy-builtin-install-'));
  t.after(() => {
    resetTidyInstallStatus();
    rmSync(root, { recursive: true, force: true });
  });
  resetTidyInstallStatus();
  const manifest = tidyManifest();
  const env = { PATH: '', Path: '' };
  const requested = [];
  let outcome = null;
  const state = fixture({
    onPrepare: async (name) => {
      if (name !== 'tidy') return;
      outcome = await installTidyCoreEngines({
        pluginData: root,
        manifest,
        env,
        installEngines: async (options) => {
          requested.push(options.ids);
          return {
            installed: options.ids
              .filter((id) => id !== 'shellcheck')
              .map((id) => ({ id, version: '1.2.3', status: 'installed', bytes: 10 })),
            errors: [{ id: 'shellcheck', error: 'HTTP 503 for https://example.invalid/shellcheck' }],
            needsApproval: null,
          };
        },
      });
    },
    tidyEngineStatus: () => tidyEngineStatus({ pluginData: root, manifest, env, probeVersions: false }),
    tidyInstallStatus: () => tidyInstallStatus(),
  });

  const settings = await state.api.installBuiltinFeature('tidy');
  // One engine failed; the tool itself works, so the feature stays installed.
  assert.deepEqual(settings.tidy, { enabled: true, installed: true });
  assert.equal(state.config().builtins.tidy.installed, true);
  assert.deepEqual(requested, [['biome', 'ruff', 'shfmt', 'shellcheck']]);
  const byId = new Map(outcome.engines.map((engine) => [engine.id, engine]));
  assert.equal(byId.get('biome').status, 'installed');
  assert.equal(byId.get('shellcheck').status, 'failed');
  assert.equal(byId.get('psscriptanalyzer').status, 'skipped');

  const status = await state.api.getTidyEngineStatus();
  assert.equal(status.toolsDir, join(root, 'tools'));
  assert.deepEqual(status.core, [...TIDY_CORE_ENGINE_IDS]);
  assert.equal(status.installing.active, false);
  assert.equal(status.installing.percent, 100);
  const install = await state.api.getTidyInstallStatus();
  assert.equal(install.engines.find((engine) => engine.id === 'shellcheck').status, 'failed');
});

test('Code Tidy status reads answer with null before any install adapter is wired', async () => {
  const state = fixture();
  assert.equal(await state.api.getTidyEngineStatus(), null);
  assert.equal(await state.api.getTidyInstallStatus(), null);
});

test('built-in tool setting rejects names outside the first-party registry', async () => {
  const state = fixture();
  await assert.rejects(state.api.setBuiltinToolEnabled('shell', false), /git, office, tidy, or localProvider/);
  assert.deepEqual(state.config(), {});
});

test('tool module settings include memory model metadata even before activation', () => {
  const state = fixture();
  const memory = state.api.getToolModuleSettings().memory;
  assert.equal(memory.installed, false);
  assert.ok(memory.info.model);
  assert.ok(memory.info.dtype);
  assert.equal(memory.info.engine, 'Transformers.js · ONNX Runtime');
  assert.deepEqual(state.prepared, []);
});

test('first-use approval for Browser Use and Computer Use persists per capability', async () => {
  const state = fixture();
  const off = await state.api.setBridgeFirstUseApproval('browser', false);
  assert.equal(off.name, 'browser');
  assert.equal(off.firstUseApproval, false);
  assert.equal(state.config().builtins.browser.firstUseApproval, false);
  // Computer keeps its default (on) until set on its own.
  const on = await state.api.setBridgeFirstUseApproval('computer', true);
  assert.equal(on.firstUseApproval, true);
  assert.equal(state.config().builtins.computer.firstUseApproval, true);
  await assert.rejects(state.api.setBridgeFirstUseApproval('office', false), /browser or computer/);
});

test('Local Provider prepares its runtime, persists provider activation, and refreshes models', async () => {
  const state = fixture();
  assert.deepEqual(state.api.getToolModuleSettings().localProvider, {
    installationCommandError: null,
    available: true,
    runtime: { installed: false, version: 'test' },
    models: [],
    enabled: false,
    installed: false,
  });

  const enabled = await state.api.setBuiltinToolEnabled('localProvider', true);
  assert.equal(enabled.localProvider.installed, true);
  assert.equal(enabled.localProvider.enabled, true);
  assert.deepEqual(state.prepared, ['localProvider']);
  assert.equal(state.config().providers['mixdog-local'].enabled, true);
  assert.deepEqual(state.registrySyncs, [true]);

  await state.api.installLocalProviderModel('recommended-model');
  assert.deepEqual(state.installedModels, ['recommended-model']);
  assert.equal(state.catalogRefreshes(), 1);

  const disabled = await state.api.setBuiltinToolEnabled('localProvider', false);
  assert.equal(disabled.localProvider.enabled, false);
  assert.equal(disabled.localProvider.installed, true);
  assert.equal(state.config().providers['mixdog-local'].enabled, false);
  assert.equal(state.stopped(), 1);
  assert.deepEqual(state.registrySyncs, [true, false]);
});

test('disabling installed runtime built-ins preserves every install marker', async () => {
  const state = fixture();
  await state.api.installBuiltinFeature('git');
  await state.api.installBuiltinFeature('memory');
  await state.api.installBuiltinFeature('office');

  const gitOff = await state.api.setBuiltinToolEnabled('git', false);
  const officeOff = await state.api.setBuiltinToolEnabled('office', false);
  await state.api.setMemoryToolsEnabled(false);

  assert.deepEqual(gitOff.git, { enabled: false, installed: true });
  assert.deepEqual(officeOff.office, { enabled: false, installed: true });
  assert.equal(state.config().builtins.git.installed, true);
  assert.equal(state.config().builtins.memory.installed, true);
  assert.equal(state.config().builtins.office.installed, true);
});

test('local runtime activation preserves settings changed while preparation was pending', async () => {
  let config = { profile: { title: 'before' } };
  let finishInstall;
  const pending = new Promise((resolve) => {
    finishInstall = resolve;
  });
  const api = createSettingsApi({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    setModuleEnabledInConfig,
    getLocalProviderStatus: () => ({ runtime: { installed: false } }),
    prepareBuiltinFeature: () => pending,
    webSearchEnabled: () => true,
    memoryToolsEnabledFn: () => true,
    gitToolsEnabledFn: () => true,
    officeToolsEnabledFn: () => true,
  });
  const activating = api.setBuiltinToolEnabled('localProvider', true);
  config = { ...config, profile: { title: 'updated during preparation' } };
  finishInstall();
  await activating;
  assert.equal(config.profile.title, 'updated during preparation');
  assert.equal(config.providers['mixdog-local'].enabled, true);
});
