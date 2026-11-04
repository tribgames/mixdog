// A runtime boot reads its initial config after the writes this process had
// accepted or started when the boot began, never after every write busy
// neighbours keep starting while it waits.
import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const sharedConfig = await import('../../runtime/shared/config.mjs');
const { createConfigWriters } = await import('../config-lifecycle/config-writers.mjs');
const { beginBoot } = await import('./begin.mjs');
const { resolveConfig } = await import('./config.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const within = (promise, ms) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

test('a boot waits for the config writes in flight when it starts, not for those busy neighbours start later', async () => {
  let stop = false;
  // A neighbour runtime whose debounced save accepts its next change as soon
  // as one is written, and a direct writer that never pauses.
  let saves = 0;
  const neighbour = createConfigWriters({
    cfgMod: {
      saveConfigPatchAsync: async () => {
        saves += 1;
        await sharedConfig.updateSectionAsync('neighbour', (current) => ({ ...current, saves }));
        if (!stop) neighbour.queueConfigChanges([{ saves }]);
      },
    },
    sharedCfgMod: sharedConfig,
  });
  neighbour.queueConfigChanges([{ saves: 0 }]);
  void neighbour.flushConfigSaveAsync();
  const direct = (async () => {
    while (!stop) await sharedConfig.updateSectionAsync('direct', (current) => ({ n: (current.n || 0) + 1 }));
  })();
  try {
    await sleep(200);
    let inFlightSettled = false;
    const inFlight = sharedConfig.updateSectionAsync('probe', () => ({ written: true }));
    void inFlight.then(() => {
      inFlightSettled = true;
    });
    const boot = beginBoot({
      provider: 'openai',
      model: 'gpt-5.4',
      toolMode: 'full',
      cwd: process.cwd(),
      initialConfig: { providers: {}, modelSettings: {} },
    });
    boot.cfgMod = { loadConfig: () => ({}) };
    boot.sharedCfgMod = sharedConfig;
    const savesBefore = saves;
    assert.equal(await within(resolveConfig(boot), 10_000), true, 'the boot resolved while the neighbours kept writing');
    assert.equal(inFlightSettled, true, 'the boot waited for the write in flight when it started');
    assert.ok(saves > savesBefore, 'the neighbour wrote again while the boot waited, so it was still busy');
  } finally {
    stop = true;
    await direct;
    await neighbour.flushAllConfigSavesAsync();
  }
});
