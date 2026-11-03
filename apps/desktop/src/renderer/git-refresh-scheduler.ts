import { subscribeProjectFileChanges } from './project-file-changes';

export type GitRefreshReason = 'activity' | 'safety';

interface GitRefreshScheduler {
  resume(): void;
  pause(): void;
  signal(): void;
  refreshNow(): void;
  dispose(): void;
}

const DEFAULT_MAX_INTERVAL_MS = 5 * 60_000;

/** Cadence for the surfaces that follow one file's diff (editor gutter, diff pane). */
export const FILE_DIFF_REFRESH_OPTIONS = {
  safetyIntervalMs: 30_000,
  activityDebounceMs: 125,
  activityMinGapMs: 1_000,
} as const;

export function createGitRefreshScheduler(
  task: (reason: GitRefreshReason) => Promise<void>,
  options: {
    safetyIntervalMs: number;
    activityDebounceMs: number;
    activityMinGapMs: number;
    slowTaskMultiplier?: number;
    maxIntervalMs?: number;
    /** A task that rejects is retried after `minMs`, doubling per failure up
     *  to `maxMs`, and reset by a success; its duration (a read cut off at a
     *  deadline) never feeds the slow-task backoff. Unset, a rejection counts
     *  as an ordinary run. */
    failureRetry?: { minMs: number; maxMs: number };
  }
): GitRefreshScheduler {
  let disposed = false;
  let enabled = false;
  let inFlight = false;
  let pendingActivity = false;
  let activityTimer = 0;
  let activityFiresAt = Infinity;
  let safetyTimer = 0;
  let lastRunEndedAt = -Infinity;
  let lastRunDurationMs = 0;
  let failures = 0;

  const clearActivity = () => {
    if (activityTimer) globalThis.clearTimeout(activityTimer);
    activityTimer = 0;
    activityFiresAt = Infinity;
  };
  const clearSafety = () => {
    if (safetyTimer) globalThis.clearTimeout(safetyTimer);
    safetyTimer = 0;
  };
  const maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const requiredIdleMs = () => Math.min(maxIntervalMs, Math.max(options.activityMinGapMs, lastRunDurationMs));
  const scheduleSafety = () => {
    if (!enabled || disposed) return;
    clearSafety();
    const retry = options.failureRetry;
    const delay =
      retry && failures > 0
        ? Math.min(retry.maxMs, retry.minMs * 2 ** (failures - 1))
        : Math.max(
            options.safetyIntervalMs,
            Math.min(maxIntervalMs, lastRunDurationMs * (options.slowTaskMultiplier ?? 5))
          );
    safetyTimer = globalThis.setTimeout(() => {
      safetyTimer = 0;
      start('safety');
    }, delay);
  };
  const scheduleActivity = (minimumDelayMs: number) => {
    if (!enabled || disposed) return;
    clearSafety();
    if (inFlight) {
      pendingActivity = true;
      return;
    }
    const now = Date.now();
    const delay = Math.max(minimumDelayMs, lastRunEndedAt + requiredIdleMs() - now);
    if (delay <= 0) {
      start('activity');
      return;
    }
    const firesAt = now + delay;
    if (activityTimer && firesAt >= activityFiresAt) return;
    clearActivity();
    activityFiresAt = firesAt;
    activityTimer = globalThis.setTimeout(() => {
      activityTimer = 0;
      activityFiresAt = Infinity;
      start('activity');
    }, delay);
  };
  const start = (reason: GitRefreshReason) => {
    if (!enabled || disposed || inFlight) return;
    clearActivity();
    clearSafety();
    inFlight = true;
    const startedAt = Date.now();
    let failed = false;
    void Promise.resolve()
      .then(() => task(reason))
      .catch(() => {
        failed = Boolean(options.failureRetry);
      })
      .finally(() => {
        lastRunEndedAt = Date.now();
        if (failed) failures += 1;
        else {
          failures = 0;
          lastRunDurationMs = Math.max(0, lastRunEndedAt - startedAt);
        }
        inFlight = false;
        if (!enabled || disposed) return;
        if (pendingActivity) {
          pendingActivity = false;
          scheduleActivity(0);
        } else {
          scheduleSafety();
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
      clearSafety();
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
      clearSafety();
    },
  };
}

/** Drives a scheduler from Git evidence: project file changes and explicit
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
