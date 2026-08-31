import assert from 'node:assert/strict';
import test from 'node:test';

import {
  moduleEnabled,
  setMemoryToolsEnabledInConfig,
  setModuleEnabledInConfig,
  setRecapEnabledInConfig,
} from './config-helpers.mjs';
import { createSettingsApi } from './settings-api.mjs';

function fixture() {
  let config = {};
  let refreshes = 0;
  const api = createSettingsApi({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => { config = next; },
    setMemoryToolsEnabledInConfig,
    setModuleEnabledInConfig,
    setRecapEnabledInConfig,
    invalidateContextStatusCache() {},
    webSearchEnabled: () => true,
    memoryToolsEnabledFn: () => true,
    gitToolsEnabledFn: () => moduleEnabled(config, 'git', true),
    officeToolsEnabledFn: () => moduleEnabled(config, 'office', true),
    refreshEmptySessionToolPolicy: async () => { refreshes += 1; },
  });
  return {
    api,
    config: () => config,
    refreshes: () => refreshes,
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
  await assert.rejects(state.api.installBuiltinFeature('shell'), /git, memory, or office/);
});

test('built-in tool setting rejects names outside the first-party registry', async () => {
  const state = fixture();
  await assert.rejects(
    state.api.setBuiltinToolEnabled('shell', false),
    /git or office/,
  );
  assert.deepEqual(state.config(), {});
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
