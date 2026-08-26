// Background prewarm/start schedulers, extracted from
// mixdog-session-runtime.mjs. Dependency-injected factory: timer handles live
// in a caller-owned `timers` object (so the facade's clearTimeout teardown
// still sees them) and all state reads go through supplied accessors. Byte-for-
// byte identical behavior; only grouping changes.
import { performance } from 'node:perf_hooks';

export function createPrewarmSchedulers({
  timers,
  bootProfile,
  getCurrentCwd,
  isCloseRequested,
  getActiveTurnCount,
  getSessionCreatePromise,
  getSession,
  hasActiveAutomation,
  getCodeGraphModule,
  createCurrentSession,
  channels,
  envFlag,
  delays,
  flags,
  state,
}) {
  const { codeGraphPrewarmDelayMs, channelStartDelayMs, backgroundBusyRetryMs } = delays;
  const { codeGraphPrewarmEnabled } = flags;

  function scheduleCodeGraphPrewarm(delayMs = codeGraphPrewarmDelayMs, reason = 'cwd') {
    if (!codeGraphPrewarmEnabled) {
      bootProfile('code-graph:prewarm-skipped', { reason: 'disabled' });
      return;
    }
    if (isCloseRequested()) return;
    state.codeGraphPrewarmQueuedCwd = getCurrentCwd();
    if (timers.codeGraphPrewarmTimer) {
      // Upgrade a pending idle/cwd warm when the first visible provider token
      // arrives. Keeping the older timer would preserve its non-overlap reason
      // and defer the graph until after the active turn.
      if (reason !== 'first-visible') return;
      clearTimeout(timers.codeGraphPrewarmTimer);
      timers.codeGraphPrewarmTimer = null;
    }
    timers.codeGraphPrewarmTimer = setTimeout(() => {
      timers.codeGraphPrewarmTimer = null;
      if (isCloseRequested()) return;
      const activeTurn = getActiveTurnCount() > 0;
      // first-visible is armed only after TTFT. Let that warm overlap the
      // provider's remaining generation instead of retrying until the turn
      // ends, which made first-turn code_graph calls pay the full cold build.
      const canOverlapActiveTurn = reason === 'first-visible';
      if ((activeTurn && !canOverlapActiveTurn) || getSessionCreatePromise()) {
        bootProfile('code-graph:prewarm-deferred', { reason: activeTurn ? 'turn-active' : 'session-create' });
        scheduleCodeGraphPrewarm(backgroundBusyRetryMs, 'busy');
        return;
      }
      if (state.codeGraphPrewarmInFlight) {
        bootProfile('code-graph:prewarm-deferred', { reason: 'in-flight' });
        scheduleCodeGraphPrewarm(backgroundBusyRetryMs, 'in-flight');
        return;
      }
      const prewarmCwd = state.codeGraphPrewarmQueuedCwd || getCurrentCwd();
      state.codeGraphPrewarmQueuedCwd = '';
      state.codeGraphPrewarmInFlight = true;
      const startedAt = performance.now();
      bootProfile('code-graph:prewarm:start', { cwd: prewarmCwd, reason });
      void getCodeGraphModule()
        .then((mod) => {
          if (typeof mod?.prewarmCodeGraphIfProject !== 'function') return false;
          return mod.prewarmCodeGraphIfProject(prewarmCwd);
        })
        .then((scheduled) => bootProfile(scheduled ? 'code-graph:prewarm:scheduled' : 'code-graph:prewarm:no-project', {
          cwd: prewarmCwd,
          ms: (performance.now() - startedAt).toFixed(1),
        }))
        .catch((error) => bootProfile('code-graph:prewarm:failed', {
          cwd: prewarmCwd,
          ms: (performance.now() - startedAt).toFixed(1),
          error: error?.message || String(error),
        }))
        .finally(() => {
          state.codeGraphPrewarmInFlight = false;
          if (state.codeGraphPrewarmQueuedCwd && !isCloseRequested()) {
            scheduleCodeGraphPrewarm(backgroundBusyRetryMs, 'queued');
          }
        });
    }, delayMs);
    timers.codeGraphPrewarmTimer.unref?.();
  }

  // Tool-runtime warmup: start the native shell manager and token estimator.
  function scheduleToolRuntimeWarmup(delayMs = 2500) {
    if (envFlag('MIXDOG_DISABLE_TOOL_PREWARM')) {
      bootProfile('tool-runtime:prewarm-skipped');
      return;
    }
    const timer = setTimeout(() => void (async () => {
      if (isCloseRequested()) return;
      try {
        const { warmNativeSpawnServer } = await import('../runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs');
        bootProfile('tool-runtime:native-shell', { warmed: await warmNativeSpawnServer() === true });
      } catch (error) {
        bootProfile('tool-runtime:native-shell-failed', { error: error?.message || String(error) });
      }
      try {
        // Shell jobs orphaned by a daemon restart: finalize their records and
        // deliver one completion notice to each owner session so the outcome
        // is never silently dropped.
        const { reconcileRecoveredShellJobCompletions } = await import('../runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs');
        bootProfile('tool-runtime:shell-job-recovery', { notified: await reconcileRecoveredShellJobCompletions() });
      } catch (error) {
        bootProfile('tool-runtime:shell-job-recovery-failed', { error: error?.message || String(error) });
      }
      try {
        const { prewarmTokenEstimator } = await import('../runtime/agent/orchestrator/session/context-utils.mjs');
        bootProfile('tool-runtime:token-estimator', { warmed: prewarmTokenEstimator() === true });
      } catch (error) {
        bootProfile('tool-runtime:token-estimator-failed', { error: error?.message || String(error) });
      }
    })(), delayMs);
    timer.unref?.();
  }

  // Search warmup overlaps session/provider prep so the first grep/find does
  // not wait for the resident server spawn. Kept off the first-token path
  // that still owns PowerShell and code-graph workers.
  function scheduleSearchRuntimeWarmup(delayMs = 0) {
    if (envFlag('MIXDOG_DISABLE_TOOL_PREWARM')) {
      bootProfile('search-runtime:prewarm-skipped');
      return;
    }
    if (timers.searchRuntimeWarmupTimer || timers.searchRuntimeWarmupStarted) return;
    timers.searchRuntimeWarmupStarted = true;
    const start = () => void (async () => {
      timers.searchRuntimeWarmupTimer = null;
      if (isCloseRequested()) return;
      const nativeSearchWarm = (async () => {
        const { warmNativeSearchServer } = await import('../runtime/agent/orchestrator/tools/builtin/native-search-client.mjs');
        bootProfile('native-search:warm', { up: await warmNativeSearchServer() === true });
      })().catch((error) => {
        bootProfile('native-search:warm-failed', { error: error?.message || String(error) });
      });
      const nativeSpawnWarm = (async () => {
        const { warmNativeSpawnServer } = await import('../runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs');
        bootProfile('native-spawn:warm', { up: await warmNativeSpawnServer() === true });
      })().catch((error) => {
        bootProfile('native-spawn:warm-failed', { error: error?.message || String(error) });
      });
      await Promise.all([nativeSearchWarm, nativeSpawnWarm]);
    });
    if (delayMs <= 0) {
      start();
      return;
    }
    timers.searchRuntimeWarmupTimer = setTimeout(start, delayMs);
    timers.searchRuntimeWarmupTimer.unref?.();
  }

  function invokeChannelStart() {
    if (state.channelStartPromise) return state.channelStartPromise;
    const startedAt = performance.now();
    bootProfile('channels:start:begin');
    state.channelStartPromise = channels.start()
      .then(() => bootProfile('channels:start:ready', { ms: (performance.now() - startedAt).toFixed(1) }))
      .catch((error) => bootProfile('channels:start:failed', {
        ms: (performance.now() - startedAt).toFixed(1),
        error: error?.message || String(error),
      }))
      .finally(() => {
        state.channelStartPromise = null;
      });
    return state.channelStartPromise;
  }

  function scheduleChannelStart(delayMs = channelStartDelayMs) {
    if (envFlag('MIXDOG_DISABLE_CHANNEL_START')) {
      bootProfile('channels:start-skipped');
      return;
    }
    if (timers.channelStartTimer || state.channelStartPromise || isCloseRequested()) return;
    bootProfile('channels:start-scheduled', { delayMs });
    timers.channelStartTimer = setTimeout(() => void (async () => {
      timers.channelStartTimer = null;
      if (isCloseRequested()) return;
      // Channels-module and remote toggles gate MESSAGING; automation
      // (enabled schedules/webhooks) keeps the worker boot alive — its
      // channel worker runs headless: only active automation boots it.
      const automation = await hasActiveAutomation().catch(() => false);
      if (!automation) {
        bootProfile('channels:start-disabled');
        return;
      }
      if (isCloseRequested()) return;
      if (getActiveTurnCount() > 0 || getSessionCreatePromise()) {
        bootProfile('channels:start-deferred', { reason: getActiveTurnCount() > 0 ? 'turn-active' : 'session-create' });
        scheduleChannelStart(backgroundBusyRetryMs);
        return;
      }
      void invokeChannelStart();
    })(), delayMs);
    timers.channelStartTimer.unref?.();
  }

  return {
    scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup,
    invokeChannelStart,
    scheduleChannelStart,
  };
}
