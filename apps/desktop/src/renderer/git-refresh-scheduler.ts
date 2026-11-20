import { projectWatchKey, subscribeProjectFileChanges } from './project-file-changes';
import { sectionStoreFor } from './section-store';

interface GitRefreshScheduler {
  resume(): void;
  pause(): void;
  signal(): void;
  dispose(): void;
}

/**
 * Runs `task` on Git evidence (`signal`) and on the first resume. Nothing re-reads on a clock and nothing is
 * debounced by a timer: coalescing is single-flight, so events during a run leave exactly one trailing run. Evidence
 * while paused is kept for the next resume, which otherwise reads nothing: a hidden window that comes back has seen
 * no change. A failed run is retried by the next event, like any other.
 *
 * Once runs come back to back (`GIT_REFRESH_BURST_RUNS` ended within `GIT_REFRESH_BURST_WINDOW_MS`), the next one starts no
 * sooner than `activityMinGapMs` after the previous one ended. While an agent edits the checkout, evidence arrives every
 * few hundred milliseconds and each run is a whole turn-review read on the core (over a second on a checkout with hundreds
 * of changed files): back to back, the reads never stopped. An occasional change still reads at once, and so does the run
 * a resume owes.
 */
export function createGitRefreshScheduler(
  task: () => Promise<void>,
  options: { activityMinGapMs?: number } = {}
): GitRefreshScheduler {
  const minGapMs = Math.max(0, options.activityMinGapMs ?? GIT_REFRESH_MIN_GAP_MS);
  let disposed = false;
  let enabled = false;
  let inFlight = false;
  let dirty = false;
  // No run yet, or evidence that arrived while paused: the next resume reads.
  let owed = true;
  let lastEndedAt = Number.NEGATIVE_INFINITY;
  // When the latest runs ended, newest last: the burst the gap is for.
  let recentEnds: number[] = [];
  let gapTimer: ReturnType<typeof setTimeout> | undefined;

  const start = (): void => {
    if (disposed) return;
    if (!enabled) {
      owed = true;
      return;
    }
    owed = false;
    if (inFlight || gapTimer !== undefined) {
      dirty = true;
      return;
    }
    const now = Date.now();
    recentEnds = recentEnds.filter((ended) => now - ended < GIT_REFRESH_BURST_WINDOW_MS);
    const wait = recentEnds.length >= GIT_REFRESH_BURST_RUNS ? lastEndedAt + minGapMs - now : 0;
    if (wait > 0) {
      dirty = true;
      gapTimer = setTimeout(() => {
        gapTimer = undefined;
        if (dirty) start();
      }, wait);
      return;
    }
    inFlight = true;
    dirty = false;
    void Promise.resolve()
      .then(() => task())
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        lastEndedAt = Date.now();
        recentEnds.push(lastEndedAt);
        if (recentEnds.length > GIT_REFRESH_BURST_RUNS) recentEnds.shift();
        if (dirty) start();
      });
  };
  const clearGap = (): void => {
    if (gapTimer !== undefined) clearTimeout(gapTimer);
    gapTimer = undefined;
  };

  return {
    resume() {
      if (disposed || enabled) return;
      enabled = true;
      if (owed) {
        // The run a resume owes is not held by the gap: the window was hidden and has seen nothing since.
        lastEndedAt = Number.NEGATIVE_INFINITY;
        recentEnds = [];
        start();
      }
    },
    pause() {
      enabled = false;
      clearGap();
      // A trailing run the pause cancels is owed to the resume.
      if (dirty) owed = true;
      dirty = false;
    },
    signal: start,
    dispose() {
      disposed = true;
      enabled = false;
      dirty = false;
      clearGap();
    },
  };
}

/** The least time between the end of one Git refresh run and the start of the next ([`createGitRefreshScheduler`]). */
const GIT_REFRESH_MIN_GAP_MS = 5_000;
/** How many runs ended within how long make a burst, after which the gap holds the next run. */
const GIT_REFRESH_BURST_RUNS = 3;
const GIT_REFRESH_BURST_WINDOW_MS = 10_000;

/** Whether a `gitStatus` key (the repository root a `git/watch` follows) is the root of `projectPath` or the path itself. */
function namesProject(key: string | null, project: string): boolean {
  if (!key) return false;
  const root = projectWatchKey(key);
  return project === root || project.startsWith(`${root}/`);
}

/** Drives a scheduler from evidence about `projectPath` only: changes under the project folder (the core's folder
 *  watch, which also follows the checkout's git dirs), a pushed `gitStatus` entry of the project's repository, and
 *  the window's own `mixdog:git-changed` after a Git action; a hidden document pauses it. The `reviewDiff` tell names
 *  no project or session (the core publishes it with no key and an empty body), so it is no evidence for a watcher,
 *  and neither is window focus. The returned teardown disposes the scheduler. */
export function watchGitRefreshEvidence(projectPath: string, scheduler: GitRefreshScheduler): () => void {
  const signal = () => scheduler.signal();
  const visibilityChanged = () => {
    if (document.visibilityState === 'hidden') scheduler.pause();
    else scheduler.resume();
  };
  const project = projectWatchKey(projectPath);
  const sections = sectionStoreFor(typeof window === 'undefined' ? undefined : window.mixdogDesktop);
  // The revision of each of the project's `gitStatus` entries last seen: a push for another repository leaves them as
  // they were.
  const seen = new Map<string, number>();
  const ownStatus = () => {
    let changed = false;
    for (const entry of sections?.list('gitStatus') ?? []) {
      if (!namesProject(entry.key, project)) continue;
      const key = entry.key ?? '';
      if (seen.get(key) !== entry.revision) changed = true;
      seen.set(key, entry.revision);
    }
    return changed;
  };
  ownStatus();
  const stopStatus = sections?.subscribe('gitStatus', () => {
    if (ownStatus()) signal();
  });
  const stopProject = subscribeProjectFileChanges(projectPath, signal);
  window.addEventListener('mixdog:git-changed', signal);
  document.addEventListener('visibilitychange', visibilityChanged);
  if (document.visibilityState !== 'hidden') scheduler.resume();
  return () => {
    scheduler.dispose();
    stopStatus?.();
    stopProject();
    window.removeEventListener('mixdog:git-changed', signal);
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
}
