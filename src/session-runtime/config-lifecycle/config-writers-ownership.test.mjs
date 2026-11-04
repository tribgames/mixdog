// A runtime's debounced config saves stay its own whoever flushes them, and a
// reader's barrier waits for what each channel had accepted, never for a
// drain of what another channel keeps accepting.
import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const sharedConfig = await import('../../runtime/shared/config.mjs');
const { withFileLock } = await import('../../runtime/shared/file-lock.mjs');
const { createConfigWriters, flushPendingSessionConfigWrites } = await import('./config-writers.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const within = (promise, ms) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

/** Hold the config file lock; resolves to its release. */
async function holdConfigLock() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let locked;
  const taken = new Promise((resolve) => {
    locked = resolve;
  });
  const holder = withFileLock(join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json.lock'), async () => {
    locked();
    await gate;
  });
  await taken;
  return async () => {
    release();
    await holder;
  };
}

test("a boot that starts another runtime's save does not take that save into its own close", async () => {
  const ownerA = sharedConfig.createConfigWriteOwner();
  const ownerB = sharedConfig.createConfigWriteOwner();
  // Runtime A's writers, created in A's context as its boot does.
  const a = ownerA.run(() =>
    createConfigWriters({
      cfgMod: {
        saveConfigPatchAsync: (changes) =>
          sharedConfig.updateSectionAsync('runtimeA', (current) => ({ ...current, saved: changes.length })),
      },
      sharedCfgMod: sharedConfig,
    })
  );
  const unlock = await holdConfigLock();
  let unlocked = false;
  let barrier = null;
  try {
    a.queueConfigChanges([{ field: 1 }]);
    // Runtime B's boot barrier starts A's pending save from B's context.
    barrier = ownerB.run(() => flushPendingSessionConfigWrites());
    await sleep(50);
    assert.equal(await within(ownerB.settled(), 300), true, "B's close waited on A's held save");
    assert.equal(await within(ownerA.settled(), 300), false, "A's close no longer covers its own held save");
    await unlock();
    unlocked = true;
    await barrier;
    await ownerA.settled();
    assert.equal(sharedConfig.readSection('runtimeA')?.saved, 1);
  } finally {
    if (!unlocked) await unlock();
    await barrier?.catch(() => {});
    await a.flushAllConfigSavesAsync();
  }
});

test('a reader barrier does not hold an accepted skills change behind a config edit queued after the call', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let skills = null;
  const writers = createConfigWriters({
    cfgMod: {
      saveConfigPatchAsync: () => held,
      patchSkillsDisabledAsync: async (names) => {
        skills = names;
      },
    },
    sharedCfgMod: sharedConfig,
  });
  try {
    writers.scheduleSkillsSave(['off-skill']);
    const barrier = flushPendingSessionConfigWrites();
    // Accepted after the call, and its write never finishes while the barrier waits.
    writers.queueConfigChanges([{ edit: 'later' }]);
    void writers.flushConfigSaveAsync();
    assert.equal(await within(barrier, 1000), true, 'the barrier waited for the config edit queued after it');
    assert.deepEqual(skills, ['off-skill']);
  } finally {
    release();
    await writers.flushAllConfigSavesAsync();
  }
});

test('a reader barrier writes an accepted skills change while config edits keep being accepted', async () => {
  let stop = false;
  let edits = 0;
  let skills = null;
  const writers = createConfigWriters({
    cfgMod: {
      // Every config write accepts the next edit, so the config channel never empties.
      saveConfigPatchAsync: async () => {
        edits += 1;
        await sleep(10);
        if (!stop) writers.queueConfigChanges([{ edit: edits }]);
      },
      patchSkillsDisabledAsync: async (names) => {
        skills = names;
      },
    },
    sharedCfgMod: sharedConfig,
  });
  writers.queueConfigChanges([{ edit: 0 }]);
  const busy = writers.flushConfigSaveAsync();
  try {
    await sleep(50);
    writers.scheduleSkillsSave(['off-skill']);
    const editsBefore = edits;
    assert.equal(await within(flushPendingSessionConfigWrites(), 3000), true, 'the barrier waited for config to go quiet');
    assert.deepEqual(skills, ['off-skill']);
    assert.ok(edits > editsBefore, 'config edits kept being accepted while the barrier waited');
  } finally {
    stop = true;
    await busy;
    await writers.flushAllConfigSavesAsync();
  }
});
