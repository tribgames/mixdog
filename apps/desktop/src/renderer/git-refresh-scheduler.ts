export type GitRefreshReason = "activity" | "safety";

export interface GitRefreshScheduler {
  resume(): void;
  pause(): void;
  signal(): void;
  refreshNow(): void;
  dispose(): void;
}

export function createGitRefreshScheduler(
  task: (reason: GitRefreshReason) => Promise<void>,
  options: {
    safetyIntervalMs: number;
    activityDebounceMs: number;
    activityMinGapMs: number;
    slowTaskMultiplier?: number;
    maxIntervalMs?: number;
  },
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

  const clearActivity = () => {
    if (activityTimer) globalThis.clearTimeout(activityTimer);
    activityTimer = 0;
    activityFiresAt = Infinity;
  };
  const clearSafety = () => {
    if (safetyTimer) globalThis.clearTimeout(safetyTimer);
    safetyTimer = 0;
  };
  const requiredIdleMs = () => Math.min(
    options.maxIntervalMs ?? 5 * 60_000,
    Math.max(options.activityMinGapMs, lastRunDurationMs),
  );
  const scheduleSafety = () => {
    if (!enabled || disposed) return;
    clearSafety();
    const delay = Math.max(
      options.safetyIntervalMs,
      Math.min(
        options.maxIntervalMs ?? 5 * 60_000,
        lastRunDurationMs * (options.slowTaskMultiplier ?? 5),
      ),
    );
    safetyTimer = globalThis.setTimeout(() => {
      safetyTimer = 0;
      start("safety");
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
      start("activity");
      return;
    }
    const firesAt = now + delay;
    if (activityTimer && firesAt >= activityFiresAt) return;
    clearActivity();
    activityFiresAt = firesAt;
    activityTimer = globalThis.setTimeout(() => {
      activityTimer = 0;
      activityFiresAt = Infinity;
      start("activity");
    }, delay);
  };
  const start = (reason: GitRefreshReason) => {
    if (!enabled || disposed || inFlight) return;
    clearActivity();
    clearSafety();
    inFlight = true;
    const startedAt = Date.now();
    void Promise.resolve()
      .then(() => task(reason))
      .catch(() => undefined)
      .finally(() => {
        lastRunEndedAt = Date.now();
        lastRunDurationMs = Math.max(0, lastRunEndedAt - startedAt);
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
