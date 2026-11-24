// Measured on Windows (node 22): a directory watch fires for the atomic replace (write a staging file, rename over daemon.json) made by
// another process, with an event naming `daemon.json`.
import { processRuns } from '../../../../../packages/protocol-client/src/launch/ensure-core.mjs';
import type { BootFailure } from './boot-progress';

export interface RecoveryReports {
  current(): { failure: BootFailure | null };
  subscribe(listener: (report: { failure: BootFailure | null }) => void): () => void;
  recovered(): void;
}

export interface RecoveryWatch {
  close(): void;
}

export interface RecoveryOptions {
  reports: RecoveryReports;
  runtimeRoot: string;
  readState(): Promise<{ state: string; rpcPort: number | null; pid?: number | null }>;
  /** Makes sure the runtime directory exists (the app's own, private to the user). */
  ensureRoot(): void;
  /** `fs.watch` over a directory: told of every change in it (`onChange`) and when the watch itself stops (`onEnd`: an error or a close). */
  watch(directory: string, onChange: () => void, onEnd: () => void): RecoveryWatch;
  /** Whether a process still runs: a discovery file outlives a core that was killed. */
  runs?(pid: number): boolean;
  /** The desktop diagnostics log. */
  log(event: string, fields: Record<string, unknown>): void;
}

export function watchRecovery({
  reports,
  runtimeRoot,
  readState,
  ensureRoot,
  watch,
  runs = processRuns,
  log,
}: RecoveryOptions): () => void {
  /** The failure being watched for, and the watch of the runtime directory for it. */
  let standing: BootFailure | null = null;
  let watching: RecoveryWatch | null = null;
  let live = true;

  const stopWatching = (): void => {
    const held = watching;
    watching = null;
    try {
      held?.close();
    } catch {
      /* a watch that cannot be closed is already gone */
    }
  };

  /** The launcher's judgment of a serving core (ensure-core.mjs ``ensureCore``): a discovery that names a process that no longer runs names no core. */
  const serving = (state: { state: string; rpcPort: number | null; pid?: number | null }): boolean => {
    if (Number.isInteger(state.pid) && !runs(state.pid as number)) return false;
    return state.state === 'serving' && Boolean(state.rpcPort);
  };

  const look = async (failure: BootFailure): Promise<void> => {
    const state = await readState().catch(() => null);
    // The read answers for the failure that asked: one that has gone or been replaced since is not the answer's to clear.
    if (!live || standing !== failure || reports.current().failure !== failure || !state || !serving(state)) return;
    standing = null;
    stopWatching();
    try {
      reports.recovered();
    } catch {
      /* the report of recovery is the reports' own */
    }
  };

  /** Watches the runtime directory (made sure to exist first). */
  const install = (failure: BootFailure): void => {
    stopWatching();
    try {
      ensureRoot();
      const own: RecoveryWatch = watch(
        runtimeRoot,
        () => {
          if (watching === own && standing === failure) void look(failure);
        },
        () => {
          if (watching !== own || !live || standing !== failure) return;
          // Not replaced here: a watch that fails at once would fail again at once. The next report for the failure replaces it.
          stopWatching();
          void look(failure);
        }
      );
      watching = own;
    } catch (error) {
      // Recorded, not swallowed: the card and Try again remain, but recovery will not be noticed by itself.
      log('core-recovery-watch-failed', {
        runtimeRoot,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const follow = (report: { failure: BootFailure | null }): void => {
    if (!live) return;
    if (!report.failure) {
      standing = null;
      stopWatching();
      return;
    }
    if (standing === report.failure) {
      if (!watching) {
        install(report.failure);
        void look(report.failure);
      }
      return;
    }
    standing = report.failure;
    install(report.failure);
    // Once the watch is in place: a core that came up before it, or between, is seen.
    void look(report.failure);
  };

  // Started after the report that confirmed the failure has reached every listener, and never throwing into it.
  const off = reports.subscribe((report) =>
    queueMicrotask(() => {
      try {
        follow(report);
      } catch {
        /* observing recovery must not break reporting */
      }
    })
  );
  queueMicrotask(() => follow(reports.current()));
  return () => {
    live = false;
    off();
    standing = null;
    stopWatching();
  };
}
