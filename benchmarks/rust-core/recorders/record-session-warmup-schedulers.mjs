#!/usr/bin/env node
// Golden twin of `src/session-runtime/warmup-schedulers.test.mjs`: the background warmup / refresh schedulers
// (`createWarmupSchedulers`: scheduleProviderWarmup, scheduleProviderSetupWarmup, scheduleProviderModelWarmup,
// scheduleModelCatalogWarmup, scheduleStatuslineUsageWarmup, refreshStatuslineUsageAfterTurn, wakeDeferredWarmups).
//
// Every case is a script of STEPS the recorder performs in order; the recording keeps the steps (inputs) and, after each
// one, everything observable: the cumulative dependency calls (`calls`), boot-profile events, provider-model warms,
// catalog runs, the caller-owned `timers` object (key -> null | "armed"), and every `setTimeout` armed during the step
// (delay in ms). Time is node:test's mock clock (setTimeout only): it moves ONLY by an explicit `tick` step, and the
// event-loop turns the test awaits are explicit `yield` steps: a yield waits until every scripted async dependency a job called has settled and its caller's continuation ran (a held gate does not count), with a deadline. The dependencies
// (route, config, keychain/provider readiness gates, catalog fetch) are scripted endpoints.
//
//   node benchmarks/rust-core/recorders/record-session-warmup-schedulers.mjs --tree <dir>
import { mock } from 'node:test';
import { exact } from './lib/exact.mjs';
import { DEADLINE_MS, realClearTimeout, realSetTimeout } from './lib/session-wire-harness.mjs';
import { runSessionRecorder } from './lib/session-rec.mjs';

await runSessionRecorder(import.meta.url, {
  set: 'session-warmup-schedulers',
  testFile: 'src/session-runtime/warmup-schedulers.test.mjs',
  entry: 'Ran src/session-runtime/warmup-schedulers.mjs createWarmupSchedulers (with warmup/timer-arm.mjs, provider-warmups.mjs, catalog-warmup.mjs, statusline-usage-warmup.mjs) with the test file\'s scripted dependencies on node:test\'s mock clock (setTimeout) that the recorder advances only by recorded tick steps. Did not run the real provider registry, keychain, model catalog or statusline usage fetch.',
  replay: 'mixdog-app-server-daemon src/warmup_schedulers_replay.rs, one test per case. Node\'s createWarmupSchedulers is the daemon\'s five warm-ups, each driven through the call the runtime makes: scheduleProviderWarmup = ai_admin provider_warmup.rs ProviderWarmup::start, scheduleProviderModelWarmup = model_warmup.rs ModelWarmup::start, scheduleProviderSetupWarmup(0) = setup_host.rs SetupWarmup::schedule(0), scheduleModelCatalogWarmup = catalog.rs arm_first_warm, scheduleStatuslineUsageWarmup / refreshStatuslineUsageAfterTurn = statusline_warmup.rs StatuslineWarmup::start / turn_settled, wakeDeferredWarmups = the wake of prewarm_world.rs WarmupSignals (catalog, models, statusline, providers). The recorded delay argument 0 is each warm-up\'s configured delay (its env delay 0); isFirstTurnCompleted() true is the first turn settled (first_turn_settled) before the warm-ups are bound, so it arms nothing. The scripted dependencies are the warm-ups\' ports (ProviderInit, ModelCacheWarm, UsagePrep + StatuslineSink, ProviderSetup, CatalogRefresh) and the runtime\'s gates and marks (WarmupGates, WarmupMarks: bootProfile, timer slots armed with their delay, jobs started and ended). An async dependency resolves at the next yield step, a gated one at the yield after its gate opened; time is the paused tokio clock moved only by the tick steps. Every row (calls, events, warms, catalog runs, timer slots, timers armed this step) is compared whole, in order.',
  exclusions: [
    'a yield step waits on the event it stands for: every scripted async dependency a scheduler job called (awaitKeychainPrewarm, ensureProvidersReady, cachedProviderSetup, warmCatalogsInBackground) has settled and the caller\'s continuation after it has run (tracked two promise hops after the settle), so a job that calls a further dependency is waited on too; a dependency blocked on a gate the recorder has not yet resolved does not count. No event-loop turn is counted; 10 s real-timer deadline',
    'event meta ms (a measured elapsed time of the provider init, e.g. providers:init:ready) -> <elapsed ms>',
    'the closing-while-keychain-pending cases (85, 97) and the idle-loop cases are recorded as steps; no value is normalised',
    'the dependency call `warmProviderModelCache` is recorded as `warms` (its options), `warmCatalogsInBackground` as `catalogRuns`; bootProfile events as `events`',
  ],
}, async ({ imp }) => {
  const { createWarmupSchedulers } = await imp('src/session-runtime/warmup-schedulers.mjs');
  const HOURS6 = 6 * 60 * 60 * 1000;

  // The one wait of this recorder: the macrotask boundary at which the previous step's microtask chain has drained (what the test's `await setImmediate()` is). It has a real-timer deadline (the mock clock does not run it).
  const withDeadline = (promise, label) => new Promise((resolve, reject) => {
    const timer = realSetTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), DEADLINE_MS);
    promise.then((value) => { realClearTimeout(timer); resolve(value); }, (error) => { realClearTimeout(timer); reject(error); });
  });

  async function runCase(spec) {
    mock.timers.reset();
    mock.timers.enable({ apis: ['setTimeout'] });
    const mockSetTimeout = globalThis.setTimeout;
    let armedNow = [];
    globalThis.setTimeout = function (fn, delay, ...rest) { armedNow.push(exact(delay)); return mockSetTimeout.call(this, fn, delay, ...rest); };
    const gates = { keychain: Promise.withResolvers(), provider: Promise.withResolvers() };
    const world = { closed: false, route: { provider: 'openai-oauth', model: 'first' }, active: spec.active ?? 0, catalogPending: spec.catalogPending ?? false, outcome: spec.catalogOutcome ?? undefined };
    const calls = [];
    const events = [];
    const warms = [];
    const catalogRuns = [];
    const timers = {};
    const gateOpen = { keychain: false, provider: false };
    const pendingDeps = new Set();
    const quietWaiters = new Set();
    const poke = () => { for (const check of [...quietWaiters]) check(); };
    // A tracked dependency: the same promise goes to the caller; the tracker settles two hops after it, i.e. after the caller's continuation.
    const tracked = (fn, gate = null) => (...args) => {
      const promise = fn(...args);
      const entry = { held: () => gate !== null && !gateOpen[gate] };
      pendingDeps.add(entry);
      const finish = () => { pendingDeps.delete(entry); poke(); };
      Promise.resolve(promise).then(() => Promise.resolve()).then(finish, () => Promise.resolve().then(finish));
      return promise;
    };
    const quiet = (label) => withDeadline(new Promise((resolve) => {
      const check = () => { if ([...pendingDeps].every((entry) => entry.held())) { quietWaiters.delete(check); resolve(); } };
      quietWaiters.add(check);
      check();
    }), label);
    const overrides = {};
    if (spec.keychainGate) overrides.awaitKeychainPrewarm = tracked(() => gates.keychain.promise, 'keychain');
    if (spec.providerGate) overrides.ensureProvidersReady = tracked(() => gates.provider.promise, 'provider');
    const schedulers = createWarmupSchedulers({
      timers,
      bootProfile: (name, meta) => events.push(meta ? [name, meta] : name),
      getRoute: () => world.route,
      getConfig: () => ({ providers: { [world.route.provider]: { enabled: true } } }),
      isCloseRequested: () => world.closed,
      getActiveTurnCount: () => world.active,
      getSessionCreatePromise: () => null,
      getProviderModelsCache: () => ({}),
      getProviderModelsPromise: () => null,
      reloadFullConfig: () => { calls.push('reload'); },
      ensureConfigForRouteProvider: () => { calls.push('config'); },
      awaitKeychainPrewarm: tracked(async () => {}),
      ensureProvidersReady: tracked(async () => { calls.push('providers'); }),
      ensureProviderEnabled: (config) => config.providers,
      refreshStatuslineUsageSnapshot: (value) => { calls.push(['usage', value]); },
      warmProviderModelCache: (opts) => { warms.push(opts); },
      cachedProviderSetup: tracked(async () => ({})),
      warmCatalogsInBackground: tracked(async () => {
        catalogRuns.push(world.outcome instanceof Error ? 'throws' : world.outcome ?? 'resolves undefined');
        if (world.outcome instanceof Error) throw world.outcome;
        return world.outcome;
      }),
      isFirstTurnCompleted: () => spec.firstTurnCompleted ?? true,
      isCatalogRefreshPending: () => world.catalogPending,
      envFlag: () => false,
      delays: { providerWarmupDelayMs: 0, providerSetupWarmupDelayMs: 0, providerModelWarmupDelayMs: 0, modelCatalogWarmupDelayMs: 0, statuslineUsageWarmupDelayMs: 0 },
      flags: spec.flags ?? { providerWarmupEnabled: true, modelPrefetchEnabled: true, modelCatalogWarmupEnabled: true },
      ...overrides,
    });
    const snapshot = (step) => {
      const out = {
        step,
        calls: exact(calls),
        events: events.map((e) => (Array.isArray(e) && e[1] && 'ms' in e[1] ? [e[0], exact({ ...e[1], ms: '<elapsed ms>' })] : exact(e))),
        warms: exact(warms),
        catalogRuns: catalogRuns.slice(),
        timers: Object.fromEntries(Object.entries(timers).map(([k, v]) => [k, v ? 'armed' : v === null ? null : 'unset'])),
        timersArmedThisStep: armedNow,
      };
      armedNow = [];
      return out;
    };
    const rows = [];
    try {
      for (const step of spec.steps) {
        switch (step.op) {
          case 'call': schedulers[step.method](...(step.args ?? [])); break;
          case 'tick': mock.timers.tick(step.ms); break;
          case 'yield': await quiet(`every dependency call settled after step ${rows.length}`); break;
          case 'closeRuntime': world.closed = true; break;
          case 'resolveGate': gateOpen[step.gate] = true; gates[step.gate].resolve(); poke(); break;
          case 'rejectGate': gateOpen[step.gate] = true; gates[step.gate].reject(new Error(step.message)); poke(); break;
          case 'setRoute': world.route = step.route; break;
          case 'setActiveTurnCount': world.active = step.count; break;
          case 'setCatalogRefreshPending': world.catalogPending = step.pending; break;
          case 'setCatalogOutcome': world.outcome = step.error ? new Error(step.error) : step.value; break;
          default: throw new Error(`unknown step ${step.op}`);
        }
        rows.push(snapshot(step));
      }
    } finally {
      globalThis.setTimeout = mockSetTimeout;
      mock.timers.reset();
    }
    return rows;
  }

  const call = (method, ...args) => ({ op: 'call', method, args });
  const tick = (ms) => ({ op: 'tick', ms });
  const yieldTurn = { op: 'yield' };
  // The test's `start(t, f, method)`: a scheduler arms its timer, the after-turn refresh runs at once.
  const start = (method) => (method === 'refreshStatuslineUsageAfterTurn' ? [call(method)] : [call(method, 0), tick(0)]);

  const specs = [];
  for (const method of ['scheduleProviderWarmup', 'scheduleStatuslineUsageWarmup', 'refreshStatuslineUsageAfterTurn']) {
    specs.push({ name: `${method}-cannot-start-provider-work-after-closing-during-keychain-readiness`, testLine: 85, keychainGate: true,
      steps: [...start(method), { op: 'closeRuntime' }, { op: 'resolveGate', gate: 'keychain' }, yieldTurn] });
  }
  specs.push({ name: 'provider-warmup-does-not-continue-after-a-keychain-failure-during-close', testLine: 97, keychainGate: true,
    steps: [call('scheduleProviderWarmup', 0), tick(0), { op: 'closeRuntime' }, { op: 'rejectGate', gate: 'keychain', message: 'keychain unavailable' }, yieldTurn] });
  for (const method of ['scheduleStatuslineUsageWarmup', 'refreshStatuslineUsageAfterTurn']) {
    specs.push({ name: `${method}-stops-before-usage-refresh-if-provider-readiness-outlives-the-runtime`, testLine: 109, providerGate: true,
      steps: [...start(method), yieldTurn, { op: 'closeRuntime' }, { op: 'resolveGate', gate: 'provider' }, yieldTurn] });
    specs.push({ name: `${method}-refreshes-the-prepared-route-if-selection-changes-while-waiting-and-arms-no-idle-loop`, testLine: 121, providerGate: true,
      steps: [...start(method), yieldTurn, { op: 'setRoute', route: { provider: 'anthropic-oauth', model: 'replacement' } }, { op: 'resolveGate', gate: 'provider' }, yieldTurn] });
  }
  specs.push({ name: 'normal-provider-warmup-still-reloads-configuration-before-provider-initialization', testLine: 134,
    steps: [call('scheduleProviderWarmup', 0), tick(0), yieldTurn] });
  specs.push({ name: 'busy-runtime-parks-provider-warmup-with-no-timer-until-the-runtime-reports-idle', testLine: 148, active: 1,
    steps: [call('scheduleProviderWarmup', 0), tick(0), yieldTurn, tick(60_000), yieldTurn, { op: 'setActiveTurnCount', count: 0 }, call('wakeDeferredWarmups'), tick(0), yieldTurn] });
  specs.push({ name: 'provider-model-warmup-parks-behind-the-catalog-refresh-and-runs-when-it-settles', testLine: 166, catalogPending: true,
    steps: [call('scheduleProviderModelWarmup', 0), tick(0), { op: 'setCatalogRefreshPending', pending: false }, call('wakeDeferredWarmups'), tick(0)] });
  specs.push({ name: 'idle-session-before-its-first-turn-warms-the-model-cache-once-and-arms-nothing-after', testLine: 184, firstTurnCompleted: false,
    steps: [call('scheduleProviderModelWarmup', 0), tick(0), tick(60_000)] });
  specs.push({ name: 'model-catalog-warmup-runs-every-6h-a-failure-waits-for-the-next-regular-cycle', testLine: 199, catalogOutcome: { retryAfterMs: 60_000 },
    steps: [call('scheduleModelCatalogWarmup', 0), tick(0), yieldTurn, tick(60_000), yieldTurn, { op: 'setCatalogOutcome', error: 'offline' }, tick(HOURS6 - 60_000), yieldTurn, tick(HOURS6 - 1), yieldTurn, tick(1), yieldTurn] });
  specs.push({ name: 'disabled-or-inapplicable-warmups-report-the-skip-instead-of-arming-a-timer', testLine: 232,
    flags: { providerWarmupEnabled: false, modelPrefetchEnabled: false, modelCatalogWarmupEnabled: false },
    steps: [{ op: 'setRoute', route: { provider: 'openai', model: 'm' } }, call('scheduleProviderWarmup', 0), call('scheduleProviderModelWarmup', 0), call('scheduleModelCatalogWarmup', 0), call('scheduleStatuslineUsageWarmup', 0), call('refreshStatuslineUsageAfterTurn')] });
  specs.push({ name: 'provider-setup-warmup-reports-readiness', testLine: 250,
    steps: [call('scheduleProviderSetupWarmup', 0), tick(0), yieldTurn] });

  const cases = [];
  for (const spec of specs) {
    const { name, testLine, steps, ...world } = spec;
    cases.push({ name, testLine, input: { world, steps }, result: { rows: await runCase(spec) } });
  }
  return { cases };
});
process.exit(0);
