import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSettingsApi } from './settings-api.mjs';
import { setModuleEnabledInConfig } from './config-helpers.mjs';
import { createSetupToolExecutor } from './setup-tool/executor.mjs';
import { trackLocalInstallation, localProviderInstallStatus, cancelLocalInstallation } from '../runtime/local-provider/install-progress.mjs';

test('background setup installation returns a job, pauses all observers, and resumes without changing the route', async () => {
  const root = join(tmpdir(), randomUUID());
  let config = { default: { provider: 'hosted', model: 'keep' } };
  let finish;
  let modelInstalled = false;
  let attempts = 0;
  let ttl;
  const api = createSettingsApi({
    getConfig: () => config, saveConfigAndAdopt: (next) => { config = next; },
    setModuleEnabledInConfig,
    getLocalProviderStatus: () => ({ runtime: { installed: true },
      models: [{ id: 'model', installed: modelInstalled }], installations: localProviderInstallStatus(root) }),
    prepareLocalProviderModel: (id) => trackLocalInstallation(root, { phase: 'model', modelId: id }, (_publish, signal) => {
      attempts++;
      return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        finish = () => { modelInstalled = true; resolve(); };
      });
    }),
    cancelLocalProviderInstallation: (jobId) => cancelLocalInstallation(jobId, root),
    configureLocalProviderIdleTtl: (seconds) => { ttl = seconds; },
    webSearchEnabled: () => true, memoryToolsEnabledFn: () => true,
    gitToolsEnabledFn: () => true, officeToolsEnabledFn: () => true,
  });
  const executor = createSetupToolExecutor({ getApi: () => api });
  const run = async (args) => JSON.parse(await executor.execute(args));
  const started = await run({ action: 'start_local_installation', phase: 'model', modelId: 'model' });
  assert.equal(started.background, true);
  assert.equal(started.installations[0].state, 'running');
  const jobId = started.installations[0].jobId;
  const stopped = await run({ action: 'cancel_local_installation', jobId });
  assert.equal(stopped.installations[0].state, 'cancelling');
  await new Promise(setImmediate);
  const paused = await run({ action: 'status', domain: 'local-provider' });
  assert.equal(paused.installations[0].state, 'paused');
  assert.equal(paused.installationCommandError, null);
  const resumed = await run({ action: 'start_local_installation', phase: 'model', modelId: 'model' });
  assert.notEqual(resumed.installations[0].jobId, jobId);
  assert.equal(attempts, 2);
  finish();
  await new Promise(setImmediate);
  assert.equal((await run({ action: 'status', domain: 'local-provider' })).models[0].installed, true);
  await run({ action: 'set_local_idle_ttl', idleTtlSeconds: 0 });
  assert.equal(ttl, 0);
  assert.equal(config.providers['mixdog-local'].idleTtlSeconds, 0);
  assert.deepEqual(config.default, { provider: 'hosted', model: 'keep' });
  await assert.rejects(run({ action: 'set_local_idle_ttl', idleTtlSeconds: -1 }), /idleTtlSeconds/);
  await assert.rejects(run({ action: 'start_local_installation', phase: 'model', modelId: 'not-in-catalog' }), /catalog/);
});
