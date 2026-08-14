import assert from 'node:assert/strict';
import test from 'node:test';

import { createPrewarmSchedulers } from './prewarm.mjs';

test('first-visible code graph prewarm overlaps an active turn', async () => {
  const timers = {};
  const calls = [];
  const profiles = [];
  const cwd = process.cwd();
  const schedulers = createPrewarmSchedulers({
    timers,
    bootProfile: (event, detail) => profiles.push([event, detail]),
    getCurrentCwd: () => cwd,
    isCloseRequested: () => false,
    getActiveTurnCount: () => 1,
    getSessionCreatePromise: () => null,
    getSession: () => null,
    isRemoteEnabled: () => false,
    channelsEnabled: () => false,
    hasActiveAutomation: () => false,
    getCodeGraphModule: async () => ({
      prewarmCodeGraphIfProject(root) {
        calls.push(root);
        return true;
      },
    }),
    createCurrentSession: async () => null,
    channels: {},
    envFlag: () => false,
    delays: {
      codeGraphPrewarmDelayMs: 0,
      channelStartDelayMs: 0,
      backgroundBusyRetryMs: 50,
    },
    flags: { codeGraphPrewarmEnabled: true },
    state: {
      codeGraphPrewarmQueuedCwd: '',
      codeGraphPrewarmInFlight: false,
    },
  });

  schedulers.scheduleCodeGraphPrewarm(100, 'cwd');
  schedulers.scheduleCodeGraphPrewarm(0, 'first-visible');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(calls, [cwd]);
  assert.equal(
    profiles.some(([event, detail]) =>
      event === 'code-graph:prewarm-deferred' && detail?.reason === 'turn-active'),
    false,
  );
});
