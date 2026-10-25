import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelStart } from './channel-start.mjs';

test('rescheduling automation autostart cancels the pending timer instead of leaking it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let probes = 0;
  const timers = {};
  const { scheduleAutomationAutostart } = createChannelStart({
    timers,
    bootProfile() {},
    isCloseRequested: () => false,
    hasActiveAutomation: async () => {
      probes += 1;
      return false;
    },
    channels: { start: async () => {} },
    envFlag: () => false,
    delays: { channelStartDelayMs: 0, backgroundBusyRetryMs: 0 },
    state: { channelStartPromise: null },
  });
  scheduleAutomationAutostart(20);
  scheduleAutomationAutostart(20);
  t.mock.timers.tick(20);
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
});
