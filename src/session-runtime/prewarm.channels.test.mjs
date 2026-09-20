import assert from 'node:assert/strict';
import test from 'node:test';

import { createPrewarmSchedulers } from './prewarm.mjs';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(overrides = {}) {
  const timers = {};
  const profiles = [];
  const starts = [];
  const state = { codeGraphPrewarmQueuedCwd: '', codeGraphPrewarmInFlight: false, channelStartPromise: null };
  const deps = {
    timers,
    bootProfile: (event, detail) => profiles.push(detail === undefined ? [event] : [event, detail]),
    getCurrentCwd: () => 'C:\\proj',
    isCloseRequested: () => false,
    getActiveTurnCount: () => 0,
    getSessionCreatePromise: () => null,
    getSession: () => null,
    hasActiveAutomation: async () => true,
    getCodeGraphModule: async () => ({ prewarmCodeGraphIfProject: () => true }),
    createCurrentSession: async () => null,
    channels: {
      start: async () => {
        starts.push(Date.now());
      },
    },
    envFlag: () => false,
    delays: { codeGraphPrewarmDelayMs: 0, channelStartDelayMs: 0, backgroundBusyRetryMs: 5 },
    flags: { codeGraphPrewarmEnabled: true },
    state,
    ...overrides,
  };
  return { schedulers: createPrewarmSchedulers(deps), timers, profiles, starts, state };
}

const events = (profiles) => profiles.map(([event]) => event);

test('environment flags skip the tool, search and channel warmups with a profile mark', () => {
  const { schedulers, profiles, timers } = fixture({ envFlag: () => true });
  schedulers.scheduleToolRuntimeWarmup(0);
  schedulers.scheduleSearchRuntimeWarmup(0);
  schedulers.scheduleChannelStart(0);
  assert.deepEqual(events(profiles), [
    'tool-runtime:prewarm-skipped',
    'search-runtime:prewarm-skipped',
    'channels:start-skipped',
  ]);
  assert.deepEqual(timers, {});
});

test('a disabled code graph prewarm never arms a timer', () => {
  const { schedulers, profiles, timers } = fixture({ flags: { codeGraphPrewarmEnabled: false } });
  schedulers.scheduleCodeGraphPrewarm(0, 'cwd');
  assert.deepEqual(profiles, [['code-graph:prewarm-skipped', { reason: 'disabled' }]]);
  assert.equal(timers.codeGraphPrewarmTimer, undefined);
});

test('an in-flight code graph prewarm defers the next one and re-arms for the queued cwd', async () => {
  const { schedulers, profiles, state } = fixture();
  state.codeGraphPrewarmInFlight = true;
  schedulers.scheduleCodeGraphPrewarm(0, 'cwd');
  await tick();
  assert.deepEqual(profiles[0], ['code-graph:prewarm-deferred', { reason: 'in-flight' }]);
  assert.equal(state.codeGraphPrewarmQueuedCwd, 'C:\\proj');
  state.codeGraphPrewarmInFlight = false;
  await tick(15);
  assert.ok(events(profiles).includes('code-graph:prewarm:start'));
  assert.ok(events(profiles).includes('code-graph:prewarm:scheduled'));
  assert.equal(state.codeGraphPrewarmQueuedCwd, '');
});

test('channel start runs once for active automation and the promise is shared while in flight', async () => {
  const { schedulers, profiles, starts, state } = fixture();
  schedulers.scheduleChannelStart(0);
  assert.deepEqual(profiles[0], ['channels:start-scheduled', { delayMs: 0 }]);
  await tick();
  assert.equal(starts.length, 1);
  assert.deepEqual(events(profiles).slice(1), ['channels:start:begin', 'channels:start:ready']);
  assert.equal(state.channelStartPromise, null);
  const first = schedulers.invokeChannelStart();
  assert.equal(schedulers.invokeChannelStart(), first, 'a second caller joins the in-flight start');
  await first;
  assert.equal(starts.length, 2);
});

test('channel start stays down without automation and defers while a turn is active', async () => {
  const idle = fixture({ hasActiveAutomation: async () => false });
  idle.schedulers.scheduleChannelStart(0);
  await tick();
  assert.deepEqual(events(idle.profiles), ['channels:start-scheduled', 'channels:start-disabled']);
  assert.equal(idle.starts.length, 0);

  let turns = 1;
  const busy = fixture({ getActiveTurnCount: () => turns });
  busy.schedulers.scheduleChannelStart(0);
  await tick();
  assert.deepEqual(busy.profiles[1], ['channels:start-deferred', { reason: 'turn-active' }]);
  assert.equal(busy.starts.length, 0);
  turns = 0;
  await tick(15);
  assert.equal(busy.starts.length, 1, 'the deferred start re-armed on the busy retry delay');
});

test('a failed channel start is profiled and releases the shared promise', async () => {
  const { schedulers, profiles, state } = fixture({
    channels: {
      start: async () => {
        throw new Error('bus down');
      },
    },
  });
  await schedulers.invokeChannelStart();
  assert.equal(profiles.at(-1)[0], 'channels:start:failed');
  assert.equal(profiles.at(-1)[1].error, 'bus down');
  assert.equal(state.channelStartPromise, null);
});

test('automation autostart probes once and only boots the worker when automation is enabled', async () => {
  const active = fixture();
  active.schedulers.scheduleAutomationAutostart(0);
  await tick();
  assert.deepEqual(events(active.profiles), [
    'channels:automation-autostart',
    'channels:start:begin',
    'channels:start:ready',
  ]);
  assert.equal(active.timers.channelStartTimer, null);

  const off = fixture({ hasActiveAutomation: async () => false });
  off.schedulers.scheduleAutomationAutostart(0);
  await tick();
  assert.deepEqual(off.profiles, []);
  assert.equal(off.starts.length, 0);
});

test('search runtime warmup is armed at most once per runtime', () => {
  const { schedulers, timers } = fixture();
  schedulers.scheduleSearchRuntimeWarmup(60_000);
  const first = timers.searchRuntimeWarmupTimer;
  assert.ok(first);
  schedulers.scheduleSearchRuntimeWarmup(60_000);
  assert.equal(timers.searchRuntimeWarmupTimer, first);
  assert.equal(timers.searchRuntimeWarmupStarted, true);
  clearTimeout(first);
});
