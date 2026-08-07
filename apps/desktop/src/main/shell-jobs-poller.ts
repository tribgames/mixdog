// Background shell-job strip for the status bar. The runtime has no push event
// for job counts, so the service polls with an adaptive delay.
import type { StatuslineSegmentsModule } from './desktop-support';
import { shellJobsPollDelay } from './desktop-support';

export interface ShellJobsStatus {
  count: number;
  elapsedLabel: string;
}

/** Nothing running — shared so an unowned scope never allocates. */
const EMPTY_STATUS: ShellJobsStatus = Object.freeze({ count: 0, elapsedLabel: '' });

export interface ShellJobsPollerOptions {
  /** Live engine state, or null once the engine is gone (polling stops). */
  getEngineState(): Record<string, unknown> | null;
  /** Resolved statusline module URL — imported lazily on the first poll. */
  moduleUrl(): string;
  /** Daemon-hosted services inject their own source module so plain Node never
   *  has to import an Electron ASAR path. */
  loadModule?: () => Promise<StatuslineSegmentsModule>;
  /** Called only when the status actually changed, carrying the sessions whose
   *  OWN bucket moved so their panes can be republished individually. */
  onChange(changedSessionIds: readonly string[]): void;
}

function normalizedStatus(value: { count?: unknown; elapsedLabel?: unknown } | null | undefined): ShellJobsStatus {
  return {
    count: Math.max(0, Number(value?.count) || 0),
    elapsedLabel: String(value?.elapsedLabel || ''),
  };
}

function normalizedSessions(value: unknown): Map<string, ShellJobsStatus> {
  const sessions = new Map<string, ShellJobsStatus>();
  if (!value || typeof value !== 'object') return sessions;
  for (const [sessionId, bucket] of Object.entries(value as Record<string, unknown>)) {
    const id = String(sessionId || '').trim();
    if (!id) continue;
    const status = normalizedStatus(bucket as { count?: unknown; elapsedLabel?: unknown });
    if (status.count > 0) sessions.set(id, status);
  }
  return sessions;
}

function movedSessionIds(
  previous: ReadonlyMap<string, ShellJobsStatus>,
  next: ReadonlyMap<string, ShellJobsStatus>,
): string[] {
  const moved: string[] = [];
  for (const [sessionId, status] of next) {
    const before = previous.get(sessionId);
    if (!before || before.count !== status.count || before.elapsedLabel !== status.elapsedLabel) {
      moved.push(sessionId);
    }
  }
  // A session whose last job finished must repaint too (its pane still shows
  // the spinner until the empty bucket lands).
  for (const sessionId of previous.keys()) {
    if (!next.has(sessionId)) moved.push(sessionId);
  }
  return moved;
}

export function createShellJobsPoller({
  getEngineState,
  moduleUrl,
  loadModule,
  onChange,
}: ShellJobsPollerOptions) {
  let timer: NodeJS.Timeout | null = null;
  let delayMs = 0;
  let status: ShellJobsStatus = EMPTY_STATUS;
  // Per-session buckets: one host process owns every pooled pane's jobs, so
  // the aggregate alone cannot say whose shell is running.
  let sessions: ReadonlyMap<string, ShellJobsStatus> = new Map();
  let modulePromise: Promise<StatuslineSegmentsModule> | null = null;

  function schedule(immediate = false): void {
    const state = getEngineState();
    if (!state) return;
    if (timer) clearTimeout(timer);
    delayMs = shellJobsPollDelay(state, status.count);
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, immediate ? 0 : delayMs);
    timer.unref?.();
  }

  async function poll(): Promise<void> {
    // Attached-viewer sessions mirror the OWNER's pid (live-share frames): the
    // registry's jobs belong to that process, not this one.
    const state = getEngineState();
    const ownerPid = Number(state?.ownerClientHostPid || state?.clientHostPid) || 0;
    if (!ownerPid) {
      schedule();
      return;
    }
    try {
      modulePromise ??= loadModule
        ? loadModule()
        : import(/* @vite-ignore */ moduleUrl()) as Promise<StatuslineSegmentsModule>;
      const module = await modulePromise;
      const value = module.shellJobsStatus({ clientHostPid: ownerPid });
      const next = normalizedStatus(value);
      const nextSessions = normalizedSessions(value?.sessions);
      const moved = movedSessionIds(sessions, nextSessions);
      if (next.count !== status.count || next.elapsedLabel !== status.elapsedLabel || moved.length > 0) {
        status = next;
        sessions = nextSessions;
        onChange(moved);
      }
    } catch {
      // The strip is optional: engine activity stays publishable when the
      // external runtime module is unavailable.
    } finally {
      schedule();
    }
  }

  return {
    /** Host-wide aggregate: keep-awake and the CLI statusline own the process,
     *  not one pane. */
    get status(): ShellJobsStatus { return status; },
    /** One session's own jobs. A blank id (New task pane) owns nothing. */
    statusFor(sessionId: string): ShellJobsStatus {
      const id = String(sessionId || '').trim();
      return (id ? sessions.get(id) : undefined) ?? EMPTY_STATUS;
    },
    start(): void {
      this.stop();
      schedule(true);
    },
    stop(): void {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      delayMs = 0;
    },
    /** An engine event may shorten the desired delay — re-arm when it does. */
    onEngineEvent(): void {
      const state = getEngineState();
      if (!state) return;
      const desired = shellJobsPollDelay(state, status.count);
      if (!timer || desired < delayMs) schedule(true);
    },
  };
}
