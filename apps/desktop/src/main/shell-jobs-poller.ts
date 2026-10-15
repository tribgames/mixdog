// Background shell-job strip for the status bar. The runtime has no push event
// for job counts, so the service polls with an adaptive delay.
import type { DesktopShellJobRow } from '../shared/contract';
import { shellJobsStatusEqual } from '../shared/shell-jobs-status';
import type { StatuslineSegmentsModule } from './desktop-support';
import { shellJobsPollDelay } from './desktop-support';

interface ShellJobsStatus {
  count: number;
  elapsedLabel: string;
  jobs: readonly DesktopShellJobRow[];
  /** Recently finished background jobs (session buckets only). */
  finished: readonly DesktopShellJobRow[];
}

/** Nothing running — shared so an unowned scope never allocates. */
const EMPTY_STATUS: ShellJobsStatus = Object.freeze({
  count: 0,
  elapsedLabel: '',
  jobs: Object.freeze([]),
  finished: Object.freeze([]),
});

interface ShellJobsPollerOptions {
  /** Live engine state, or null once the engine is gone (polling stops). */
  getEngineState(): Record<string, unknown> | null;
  /** Daemon-hosted services inject their own source module so plain Node never
   *  has to import an Electron ASAR path. Loaded lazily on the first poll. */
  loadModule: () => Promise<StatuslineSegmentsModule>;
  /** Called only when the status actually changed, carrying the sessions whose
   *  OWN bucket moved so their panes can be republished individually. */
  onChange(changedSessionIds: readonly string[]): void;
}

function normalizedJobs(value: unknown, finished = false): DesktopShellJobRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const taskId = String(row.taskId || row.task_id || '').trim();
    if (!taskId) return [];
    return [
      {
        taskId,
        command: String(row.command || '').trim(),
        cwd: String(row.cwd || '').trim(),
        startedAt: typeof row.startedAt === 'number' || typeof row.startedAt === 'string' ? row.startedAt : null,
        ...(finished
          ? {
              status: String(row.status || ''),
              exitCode: Number.isInteger(row.exitCode) ? (row.exitCode as number) : null,
              finishedAt:
                typeof row.finishedAt === 'number' || typeof row.finishedAt === 'string' ? row.finishedAt : null,
            }
          : {}),
      },
    ];
  });
}

interface RawShellJobsStatus {
  count?: unknown;
  elapsedLabel?: unknown;
  jobs?: unknown;
  finished?: unknown;
}

function normalizedStatus(value: RawShellJobsStatus | null | undefined): ShellJobsStatus {
  const count = Math.max(0, Number(value?.count) || 0);
  const jobs = normalizedJobs(value?.jobs);
  return {
    count,
    // The runtime's label is "time since the oldest job started" formatted at
    // read time, so every poll of an unchanged job set read as a change and
    // republished shellJobs/hostShellJobs to every desktop and phone lane.
    // Surfaces derive each listed job's elapsed time from its own startedAt;
    // the label is only ever shown for jobs the list does not carry, so it
    // travels only then.
    elapsedLabel: count > jobs.length ? String(value?.elapsedLabel || '') : '',
    jobs,
    finished: normalizedJobs(value?.finished, true),
  };
}

function normalizedSessions(value: unknown): Map<string, ShellJobsStatus> {
  const sessions = new Map<string, ShellJobsStatus>();
  if (!value || typeof value !== 'object') return sessions;
  for (const [sessionId, bucket] of Object.entries(value as Record<string, unknown>)) {
    const id = String(sessionId || '').trim();
    if (!id) continue;
    const status = normalizedStatus(bucket as RawShellJobsStatus);
    if (status.count > 0 || status.finished.length > 0) sessions.set(id, status);
  }
  return sessions;
}

function movedSessionIds(
  previous: ReadonlyMap<string, ShellJobsStatus>,
  next: ReadonlyMap<string, ShellJobsStatus>
): string[] {
  const moved: string[] = [];
  for (const [sessionId, status] of next) {
    const before = previous.get(sessionId);
    if (!shellJobsStatusEqual(before, status)) moved.push(sessionId);
  }
  // A session whose last job finished must repaint too (its pane still shows
  // the spinner until the empty bucket lands).
  for (const sessionId of previous.keys()) {
    if (!next.has(sessionId)) moved.push(sessionId);
  }
  return moved;
}

export function createShellJobsPoller({ getEngineState, loadModule, onChange }: ShellJobsPollerOptions) {
  let timer: NodeJS.Timeout | null = null;
  let delayMs = 0;
  let status: ShellJobsStatus = EMPTY_STATUS;
  // Per-session buckets: one host process owns every pooled pane's jobs, so
  // the aggregate alone cannot say whose shell is running.
  let sessions: ReadonlyMap<string, ShellJobsStatus> = new Map();
  let modulePromise: Promise<StatuslineSegmentsModule> | null = null;
  let running = false;
  let inFlight = false;
  // An engine event landed during a poll: one immediate follow-up is needed.
  let followUp = false;
  // Bumped on every start/stop so a late poll can tell it is stale.
  let generation = 0;

  /** Running shells across the owner aggregate and every session bucket: a
   *  desktop pane's shell is published by a shard, so the aggregate alone is 0. */
  function runningCount(): number {
    let total = status.count;
    for (const bucket of sessions.values()) total += bucket.count;
    return total;
  }

  function schedule(immediate = false): void {
    if (!running || inFlight) return;
    const state = getEngineState();
    if (!state) return;
    if (timer) clearTimeout(timer);
    delayMs = shellJobsPollDelay(state, runningCount());
    timer = setTimeout(
      () => {
        timer = null;
        void poll();
      },
      immediate ? 0 : delayMs
    );
    timer.unref?.();
  }

  function currentOwnerPid(): number {
    const state = getEngineState();
    return Number(state?.ownerClientHostPid || state?.clientHostPid) || 0;
  }

  function loadOnce(): Promise<StatuslineSegmentsModule> {
    if (!modulePromise) {
      const loading = loadModule();
      modulePromise = loading;
      // A rejected load is not cached: the next poll retries.
      loading.catch(() => {
        if (modulePromise === loading) modulePromise = null;
      });
    }
    return modulePromise;
  }

  async function poll(): Promise<void> {
    // Attached-viewer sessions mirror the OWNER's pid (live-share frames): the
    // registry's jobs belong to that process, not this one.
    const ownerPid = currentOwnerPid();
    if (!ownerPid) {
      schedule();
      return;
    }
    const myGeneration = generation;
    inFlight = true;
    let rerun = false;
    try {
      const module = await loadOnce();
      if (myGeneration !== generation) return;
      if (currentOwnerPid() !== ownerPid) {
        // The owner changed while loading: never publish the previous owner's data.
        rerun = true;
        return;
      }
      // Awaited fresh scan: the cache-only read answers one interval late.
      const value = module.shellJobsStatusFresh
        ? await module.shellJobsStatusFresh({ clientHostPid: ownerPid })
        : module.shellJobsStatus({ clientHostPid: ownerPid });
      if (myGeneration !== generation) return;
      if (currentOwnerPid() !== ownerPid) {
        rerun = true;
        return;
      }
      const next = normalizedStatus(value);
      const nextSessions = normalizedSessions(value?.sessions);
      const moved = movedSessionIds(sessions, nextSessions);
      if (!shellJobsStatusEqual(status, next) || moved.length > 0) {
        status = next;
        sessions = nextSessions;
        onChange(moved);
      }
    } catch {
      // The strip is optional: engine activity stays publishable when the
      // external runtime module is unavailable.
    } finally {
      // A stale poll (stopped or restarted meanwhile) must not touch the new lifecycle.
      if (myGeneration === generation) {
        inFlight = false;
        const immediate = rerun || followUp;
        followUp = false;
        schedule(immediate);
      }
    }
  }

  return {
    /** Host-wide aggregate: keep-awake and the CLI statusline own the process,
     *  not one pane. */
    get status(): ShellJobsStatus {
      return status;
    },
    /** One session's own jobs. A blank id (New task pane) owns nothing. */
    statusFor(sessionId: string): ShellJobsStatus {
      const id = String(sessionId || '').trim();
      return (id ? sessions.get(id) : undefined) ?? EMPTY_STATUS;
    },
    start(): void {
      this.stop();
      running = true;
      schedule(true);
    },
    stop(): void {
      running = false;
      generation += 1;
      inFlight = false;
      followUp = false;
      if (timer) clearTimeout(timer);
      timer = null;
      delayMs = 0;
    },
    /** An engine event may shorten the desired delay — re-arm when it does. */
    onEngineEvent(): void {
      if (!running) return;
      if (inFlight) {
        followUp = true;
        return;
      }
      const state = getEngineState();
      if (!state) return;
      const desired = shellJobsPollDelay(state, runningCount());
      if (!timer || desired < delayMs) schedule(true);
    },
  };
}
