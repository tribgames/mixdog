import { sectionStoreFor } from './section-store';

interface GitRefreshScheduler {
  resume(): void;
  pause(): void;
  signal(): void;
  refreshNow(): void;
  dispose(): void;
}

/**
 * Runs `task` only on pushed Git evidence — the core's `gitStatus` / `reviewDiff` sections (desktop-services.md §5,
 * §15 P1) or an explicit request (`signal`, `refreshNow`, a resume). Nothing re-reads on a clock and nothing is
 * debounced by a timer: coalescing is single-flight, so events during a run leave exactly one trailing run. A
 * failed run is retried by the next event, like any other.
 */
export function createGitRefreshScheduler(task: () => Promise<void>): GitRefreshScheduler {
  let disposed = false;
  let enabled = false;
  let inFlight = false;
  let dirty = false;

  const start = (): void => {
    if (!enabled || disposed) return;
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    dirty = false;
    void Promise.resolve()
      .then(() => task())
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (dirty) start();
      });
  };

  return {
    resume() {
      if (disposed || enabled) return;
      enabled = true;
      start();
    },
    pause() {
      enabled = false;
      dirty = false;
    },
    signal: start,
    refreshNow: start,
    dispose() {
      disposed = true;
      enabled = false;
      dirty = false;
    },
  };
}

/** Drives a scheduler from Git evidence: the core's pushed `gitStatus` and `reviewDiff` sections and explicit
 *  `mixdog:git-changed` events signal it, and a hidden document pauses it. The returned teardown disposes the
 *  scheduler. */
export function watchGitRefreshEvidence(_projectPath: string, scheduler: GitRefreshScheduler): () => void {
  const signal = () => scheduler.signal();
  const visibilityChanged = () => {
    if (document.visibilityState === 'hidden') scheduler.pause();
    else scheduler.resume();
  };
  const sections = sectionStoreFor(typeof window === 'undefined' ? undefined : window.mixdogDesktop);
  const stops = [sections?.subscribe('gitStatus', signal), sections?.subscribe('reviewDiff', signal)];
  const refreshNow = () => scheduler.refreshNow();
  window.addEventListener('mixdog:git-changed', signal);
  window.addEventListener('focus', refreshNow);
  document.addEventListener('visibilitychange', visibilityChanged);
  if (document.visibilityState !== 'hidden') scheduler.resume();
  return () => {
    scheduler.dispose();
    for (const stop of stops) stop?.();
    window.removeEventListener('mixdog:git-changed', signal);
    window.removeEventListener('focus', refreshNow);
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
}
