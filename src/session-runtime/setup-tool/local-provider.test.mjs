import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsApi } from '../settings-api.mjs';
import { setModuleEnabledInConfig } from '../config-helpers.mjs';
import { createSetupToolExecutor } from './executor.mjs';

const run = async (executor, args) => JSON.parse(await executor.execute(args));

test('local installation workflow inspects before install, returns installed models, and preserves the route', async () => {
  let config = { default: { provider: 'hosted', model: 'unchanged' } };
  let runtimeInstalled = false;
  let modelInstalled = false;
  let refreshes = 0;
  const preparations = [];
  const api = createSettingsApi({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => { config = next; },
    setModuleEnabledInConfig,
    webSearchEnabled: () => true, memoryToolsEnabledFn: () => true,
    gitToolsEnabledFn: () => true, officeToolsEnabledFn: () => true,
    localProviderEnabledFn: () => config.providers?.['mixdog-local']?.enabled === true,
    getLocalProviderStatus: () => ({
      available: true, runtime: { installed: runtimeInstalled },
      hardware: { gpu: { name: 'RTX 3090' } }, disk: { availableBytes: 30e9 },
      models: [{ id: 'approved-model', compatible: true, installed: modelInstalled }],
    }),
    prepareBuiltinFeature: async (name) => { preparations.push(name); runtimeInstalled = true; },
    prepareLocalProviderModel: async (id) => {
      if (id !== 'approved-model') throw new Error('unknown model');
      if (!runtimeInstalled) throw new Error('install runtime first');
      preparations.push(id);
      modelInstalled = true;
    },
    refreshLocalProviderCatalog: async () => { refreshes++; },
  });
  const executor = createSetupToolExecutor({ getApi: () => api });
  const initial = await run(executor, { action: 'status', domain: 'local-provider' });
  assert.equal(initial.runtime.installed, false);
  assert.equal(initial.models[0].compatible, true);
  assert.equal(initial.disk.availableBytes, 30e9);
  assert.deepEqual(preparations, []);
  await assert.rejects(run(executor, { action: 'install_local_model' }), /modelId is required/);
  await assert.rejects(run(executor, { action: 'install_local_model', modelId: 'approved-model' }), /install runtime first/);
  await run(executor, { action: 'install_builtin', name: 'localProvider' });
  await assert.rejects(run(executor, { action: 'install_local_model', modelId: 'unknown' }), /unknown model/);
  const receipt = await run(executor, { action: 'install_local_model', modelId: 'approved-model' });
  assert.equal(receipt.runtime.installed, true);
  assert.equal(receipt.models[0].installed, true);
  assert.equal(refreshes, 1);
  assert.deepEqual(preparations, ['localProvider', 'approved-model']);
  assert.deepEqual(config.default, { provider: 'hosted', model: 'unchanged' });
});
