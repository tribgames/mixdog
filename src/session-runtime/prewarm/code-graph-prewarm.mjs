// prewarm/code-graph-prewarm.mjs — the code-graph prewarm timer: one pending
// warm per cwd, upgraded by the first visible provider token, parked while a
// turn or session create is busy, and started for a cwd queued mid-flight
// when the running warm settles.
import { performance } from 'node:perf_hooks';

export function createCodeGraphPrewarm({
  timers,
  bootProfile,
  getCurrentCwd,
  isCloseRequested,
  getActiveTurnCount,
  getSessionCreatePromise,
  getCodeGraphModule,
  delays,
  flags,
  state,
  park,
}) {
  const { codeGraphPrewarmDelayMs } = delays;
  const { codeGraphPrewarmEnabled } = flags;

  function runPrewarm(reason) {
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
      .then((scheduled) =>
        bootProfile(scheduled ? 'code-graph:prewarm:scheduled' : 'code-graph:prewarm:no-project', {
          cwd: prewarmCwd,
          ms: (performance.now() - startedAt).toFixed(1),
        })
      )
      .catch((error) =>
        bootProfile('code-graph:prewarm:failed', {
          cwd: prewarmCwd,
          ms: (performance.now() - startedAt).toFixed(1),
          error: error?.message || String(error),
        })
      )
      .finally(() => {
        state.codeGraphPrewarmInFlight = false;
        // The cwd queued while this one ran: its warm starts now.
        if (state.codeGraphPrewarmQueuedCwd && !isCloseRequested()) {
          scheduleCodeGraphPrewarm(0, 'queued');
        }
      });
  }

  function onPrewarmTimer(reason) {
    timers.codeGraphPrewarmTimer = null;
    if (isCloseRequested()) return;
    const activeTurn = getActiveTurnCount() > 0;
    // first-visible is armed only after TTFT. Let that warm overlap the
    // provider's remaining generation instead of retrying until the turn
    // ends, which made first-turn code_graph calls pay the full cold build.
    const canOverlapActiveTurn = reason === 'first-visible';
    if ((activeTurn && !canOverlapActiveTurn) || getSessionCreatePromise()) {
      bootProfile('code-graph:prewarm-deferred', { reason: activeTurn ? 'turn-active' : 'session-create' });
      park('codeGraphPrewarmTimer', () => onPrewarmTimer(reason));
      return;
    }
    // The running warm's settle starts the cwd queued meanwhile (runPrewarm).
    if (state.codeGraphPrewarmInFlight) {
      bootProfile('code-graph:prewarm-deferred', { reason: 'in-flight' });
      return;
    }
    runPrewarm(reason);
  }

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
    timers.codeGraphPrewarmTimer = setTimeout(() => onPrewarmTimer(reason), delayMs);
    timers.codeGraphPrewarmTimer.unref?.();
  }

  return { scheduleCodeGraphPrewarm };
}
