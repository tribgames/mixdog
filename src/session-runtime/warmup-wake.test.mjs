// The wake path end to end: the runtime's active-turn control (boot/config),
// the turn settlement that lowers the count, and a warmup the running turn
// parked (warmup/timer-arm).
import assert from 'node:assert/strict';
import test from 'node:test';
import { activeTurnControls } from './boot/config.mjs';
import { createTurnSettlement } from './turn/turn-run/turn-settle.mjs';
import { createWarmupSchedulers } from './warmup-schedulers.mjs';

test('a warmup parked by a running turn runs once that turn settles the count to 0, not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rt = {
    activeTurnCount: 0,
    closeRequested: false,
    activeTurnAbortControllers: new Set(),
    sessionCreatePromise: null,
  };
  const controls = activeTurnControls(rt);
  const warms = [];
  const schedulers = createWarmupSchedulers({
    timers: {},
    bootProfile() {},
    getRoute: () => ({ provider: 'openai', model: 'm' }),
    getConfig: () => ({ providers: {} }),
    isCloseRequested: () => rt.closeRequested,
    getActiveTurnCount: () => rt.activeTurnCount,
    getSessionCreatePromise: () => rt.sessionCreatePromise,
    getProviderModelsCache: () => ({}),
    getProviderModelsPromise: () => null,
    warmProviderModelCache: (options) => warms.push(options),
    isFirstTurnCompleted: () => true,
    envFlag: () => false,
    delays: { providerModelWarmupDelayMs: 0 },
    flags: { modelPrefetchEnabled: true },
  });
  rt.wakeDeferredWarmups = schedulers.wakeDeferredWarmups;
  const { settleTurn } = createTurnSettlement({
    getSession: () => ({ id: 'A' }),
    setSession() {},
    mgr: {},
    transcript: {},
    hooks: { emit() {}, dispatch() {} },
    hookCommonPayload: (payload) => payload,
    endComputerExecution: async () => {},
    deferComputerSessionRelease() {},
    getActiveTurnCount: () => rt.activeTurnCount,
    setActiveTurnCount: controls.setActiveTurnCount,
    isFirstTurnCompleted: () => true,
    refreshStatuslineUsageAfterTurn() {},
  });
  const turn = () => ({
    session0: { id: 'A' },
    emitTiming() {},
    armHeavyRuntimeWarmup() {},
    snapshot: { finish: async () => {} },
    timing: {},
  });

  controls.setActiveTurnCount(2);
  schedulers.scheduleProviderModelWarmup(0);
  t.mock.timers.tick(0);
  assert.deepEqual(warms, [], 'parked behind the running turns');
  await settleTurn(turn());
  t.mock.timers.tick(0);
  assert.deepEqual(warms, [], 'one turn still runs');
  await settleTurn(turn());
  t.mock.timers.tick(0);
  assert.deepEqual(warms, [{ loadSecrets: true }]);
});
