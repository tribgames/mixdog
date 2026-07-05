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
  isRemoteEnabled,
  channelsEnabled,
  getCodeGraphModule,
  createCurrentSession,
  channels,
  envFlag,
  delays,
  flags,
  state,
}) {
  const { codeGraphPrewarmDelayMs, channelStartDelayMs, sessionPrewarmDelayMs, backgroundBusyRetryMs } = delays;
  const { codeGraphPrewarmEnabled, sessionPrewarmEnabled } = flags;

  function scheduleCodeGraphPrewarm(delayMs = codeGraphPrewarmDelayMs, reason = 'cwd') {
    if (!codeGraphPrewarmEnabled) {
      bootProfile('code-graph:prewarm-skipped', { reason: 'disabled' });
      return;
    }
    if (isCloseRequested()) return;
    state.codeGraphPrewarmQueuedCwd = getCurrentCwd();
    if (timers.codeGraphPrewarmTimer) return;
    timers.codeGraphPrewarmTimer = setTimeout(() => {
      timers.codeGraphPrewarmTimer = null;
      if (isCloseRequested()) return;
      if (getActiveTurnCount() > 0 || getSessionCreatePromise()) {
        bootProfile('code-graph:prewarm-deferred', { reason: getActiveTurnCount() > 0 ? 'turn-active' : 'session-create' });
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

  function scheduleLeadSessionPrewarm() {
    if (!sessionPrewarmEnabled) {
      bootProfile('session:prewarm-skipped');
      return;
    }
    const timer = setTimeout(() => {
      if (isCloseRequested() || getSession()?.id || getSessionCreatePromise() || getActiveTurnCount() > 0) return;
      void createCurrentSession('prewarm')
        .then(() => bootProfile('session:prewarm:ready'))
        .catch((error) => bootProfile('session:prewarm:failed', { error: error?.message || String(error) }));
    }, sessionPrewarmDelayMs);
    timer.unref?.();
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
    if (!channelsEnabled()) {
      bootProfile('channels:start-disabled');
      return;
    }
    if (timers.channelStartTimer || state.channelStartPromise || isCloseRequested()) return;
    bootProfile('channels:start-scheduled', { delayMs });
    timers.channelStartTimer = setTimeout(() => {
      timers.channelStartTimer = null;
      if (isCloseRequested()) return;
      // A deferred start may straddle a stopRemote(); re-check before booting so
      // a turned-off session neither starts channels nor keeps rescheduling.
      if (!isRemoteEnabled()) return;
      if (getActiveTurnCount() > 0 || getSessionCreatePromise()) {
        bootProfile('channels:start-deferred', { reason: getActiveTurnCount() > 0 ? 'turn-active' : 'session-create' });
        scheduleChannelStart(backgroundBusyRetryMs);
        return;
      }
      void invokeChannelStart();
    }, delayMs);
    timers.channelStartTimer.unref?.();
  }

  return {
    scheduleCodeGraphPrewarm,
    scheduleLeadSessionPrewarm,
    invokeChannelStart,
    scheduleChannelStart,
  };
}
