import { subscribeProjectFileChanges } from './project-file-changes';

interface GitRefreshScheduler {
  resume(): void;
  pause(): void;
  signal(): void;
  refreshNow(): void;
  dispose(): void;
}

/** Cadence for the surfaces that follow one file's diff (editor gutter, diff pane). */
export const FILE_DIFF_REFRESH_OPTIONS = {
  activityDebounceMs: 125,
  activityMinGapMs: 1_000,
} as const;

/**
 * Runs `task` only on Git evidence — a change event (`signal`, debounced), a
 * refresh request or a resume (`refreshNow`). Nothing re-reads on a clock:
 * the one timer waits for the next allowed run of an event already seen
 * (the debounce, and a gap after the last run at least as long as that run
 * took, so a slow read is not repeated back to back). Single-flight: events
 * during a run leave one trailing run. A failed run is retried by the next
 * event, like any other.
 */
export function createGitRefreshScheduler(
  task: () => Promise<void>,
  options: {
    activityDebounceMs: number;
    activityMinGapMs: number;
  }
): GitRefreshScheduler {
  let disposed = false;
  let enabled = false;
  let inFlight = false;
  let pendingActivity = false;
  let activityTimer = 0;
  let activityFiresAt = Infinity;
  let lastRunEndedAt = -Infinity;
  let lastRunDurationMs = 0;

  const clearActivity = () => {
    if (activityTimer) globalThis.clearTimeout(activityTimer);
    activityTimer = 0;
    activityFiresAt = Infinity;
  };
  const requiredIdleMs = () => Math.max(options.activityMinGapMs, lastRunDurationMs);
  const scheduleActivity = (minimumDelayMs: number) => {
    if (!enabled || disposed) return;
    if (inFlight) {
      pendingActivity = true;
      return;
    }
    const now = Date.now();
    const delay = Math.max(minimumDelayMs, lastRunEndedAt + requiredIdleMs() - now);
    if (delay <= 0) {
      start();
      return;
    }
    const firesAt = now + delay;
    if (activityTimer && firesAt >= activityFiresAt) return;
    clearActivity();
    activityFiresAt = firesAt;
    activityTimer = globalThis.setTimeout(() => {
      activityTimer = 0;
      activityFiresAt = Infinity;
      start();
    }, delay);
  };
  const start = () => {
    if (!enabled || disposed || inFlight) return;
    clearActivity();
    inFlight = true;
    const startedAt = Date.now();
    let failed = false;
    void Promise.resolve()
      .then(() => task())
      .catch(() => {
        failed = true;
      })
      .finally(() => {
        lastRunEndedAt = Date.now();
        // A rejected run (a read cut off at its deadline, a failed git) timed
        // no work: the gap keeps the last good run's duration.
        if (!failed) lastRunDurationMs = Math.max(0, lastRunEndedAt - startedAt);
        inFlight = false;
        if (!enabled || disposed) return;
        if (pendingActivity) {
          pendingActivity = false;
          scheduleActivity(0);
        }
      });
  };

  return {
    resume() {
      if (disposed || enabled) return;
      enabled = true;
      scheduleActivity(0);
    },
    pause() {
      enabled = false;
      pendingActivity = false;
      clearActivity();
    },
    signal() {
      scheduleActivity(options.activityDebounceMs);
    },
    refreshNow() {
      scheduleActivity(0);
    },
    dispose() {
      disposed = true;
      enabled = false;
      pendingActivity = false;
      clearActivity();
    },
  };
}

/** Drives a scheduler from Git evidence: project file changes (the folder
 *  watch also follows the checkout's git dirs outside it) and explicit
 *  `mixdog:git-changed` events signal it, window focus refreshes at once, and
 *  a hidden document pauses it. The returned teardown disposes the scheduler. */
export function watchGitRefreshEvidence(projectPath: string, scheduler: GitRefreshScheduler): () => void {
  const signal = () => scheduler.signal();
  const refreshNow = () => scheduler.refreshNow();
  const visibilityChanged = () => {
    if (document.visibilityState === 'hidden') scheduler.pause();
    else scheduler.resume();
  };
  const unsubscribeProject = subscribeProjectFileChanges(projectPath, signal);
  window.addEventListener('focus', refreshNow);
  window.addEventListener('mixdog:git-changed', signal);
  document.addEventListener('visibilitychange', visibilityChanged);
  if (document.visibilityState !== 'hidden') scheduler.resume();
  return () => {
    scheduler.dispose();
    unsubscribeProject();
    window.removeEventListener('focus', refreshNow);
    window.removeEventListener('mixdog:git-changed', signal);
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
}
