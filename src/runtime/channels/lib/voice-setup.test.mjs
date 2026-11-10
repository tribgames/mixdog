import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let voice = {};
let installed = false;
let lockChain = Promise.resolve();
let lockHold = null;
let releaseInstall;
const gate = new Promise((resolve) => {
  releaseInstall = resolve;
});

mock.module('../../shared/config.mjs', {
  namedExports: {
    readSection: () => voice,
    // Serialized like the real config lock; `lockHold` delays lock acquisition.
    updateSectionAsync: (_name, fn) => {
      const run = lockChain.then(async () => {
        if (lockHold) await lockHold;
        voice = fn(voice);
      });
      lockChain = run.catch(() => {});
      return run;
    },
  },
});
mock.module('../../shared/plugin-paths.mjs', { namedExports: { resolvePluginData: () => 'data' } });
mock.module('./voice-runtime-fetcher.mjs', {
  namedExports: {
    selectVoiceModelId: () => 'm',
    voiceRuntimeInfo: () => ({}),
    resolveVoiceRuntime: () => ({
      installed,
      binary: installed,
      serverCmd: installed,
      model: installed,
      ffmpeg: installed,
      modelId: 'm',
    }),
    ensureWhisperRuntime: async () => {
      await gate;
      installed = true;
    },
    ensureWhisperModel: async () => {},
    ensureFfmpegRuntime: async () => {},
  },
});

const { toggleVoice } = await import('./voice-setup.mjs');

test('voice OFF requested during a pending install is not undone when the install completes', async () => {
  const on = toggleVoice({ enabled: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await toggleVoice({ enabled: false }), false);
  releaseInstall();
  await on;
  assert.notEqual(voice.enabled, true);
});

test('voice OFF accepted while the ON write waits for the config lock wins', async () => {
  voice = {};
  let releaseLock;
  lockHold = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const on = toggleVoice({ enabled: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const off = toggleVoice({ enabled: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  lockHold = null;
  releaseLock();
  await Promise.all([on, off]);
  assert.notEqual(voice.enabled, true);
});
