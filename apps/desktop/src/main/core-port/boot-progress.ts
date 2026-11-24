// What the app's wait for this PC's core reports to the windows that wait with it: the core's index rebuild, and a start that
// cannot succeed. Everything here belongs to a launch attempt (one call of the launcher's attach-or-start): what an attempt
// reported is withdrawn when the attempt ends, however it ends.
export interface BootProgress {
  readonly done: number;
  readonly total: number;
  /** The core process (its pid) these counts are of: the counts of one boot never decrease, and a new boot starts again. */
  readonly boot: number | null;
}

/** A start that trying again will not change: the core process exits at boot for the same recorded reason, cannot be started at
 *  all, or was waited for the launcher's whole limit without serving. */
export interface BootFailure {
  /** The launcher's own sentence: what the core ended with and the last thing it said. */
  readonly message: string;
  readonly exitCode: number | null;
  /** Where the core's own stderr was kept. */
  readonly stderrPath: string | null;
}

export interface BootReport {
  readonly progress: BootProgress | null;
  readonly failure: BootFailure | null;
}

export interface BootReportSource {
  current(): BootReport;
  /** The user chose to try again after a confirmed failure. */
  retry(): void;
  subscribe(listener: (report: BootReport) => void): () => void;
}

export interface LaunchAttempt {
  /** The rebuild's progress as the launcher reads it (null when none runs). Ignored once the attempt has ended. */
  readonly progress: (progress: { done: number; total: number } | null, boot: number | null) => void;
  /** The attempt ended with a serving core. */
  succeeded(): void;
  /** The attempt ended without one: the error to throw (a start that fails the same way again carries `coreLaunchFailed`). */
  failed(error: unknown): unknown;
}

interface ExitRecord {
  code?: number | null;
  signal?: string | null;
  reason?: string | null;
  stderrPath?: string | null;
}

export class BootReports implements BootReportSource {
  /** The attempts that now report counts. */
  private readonly reporting = new Set<LaunchAttempt>();
  /** The most each core boot has been read to have come to. Counts are shown only while some attempt reports them, but withdrawing them does
   *  not forget these: one boot's counts never go back, whichever attempt reads them and whatever came between. */
  private readonly highs = new Map<number | null, BootProgress>();
  /** The boot whose counts are shown: the newest one seen. A boot that another has superseded is never current again. */
  private bootNow: number | null | undefined;
  private failure: BootFailure | null = null;
  private readonly listeners = new Set<(report: BootReport) => void>();
  /** The structured outcome of the last recorded exit (its code and signal), and the captures already counted. */
  private lastExit: string | null = null;
  private readonly counted = new Set<string>();
  private told: BootReport = { progress: null, failure: null };

  current(): BootReport {
    const shown = this.reporting.size > 0 && this.bootNow !== undefined ? this.highs.get(this.bootNow) : undefined;
    return { progress: shown ?? null, failure: this.failure };
  }

  subscribe(listener: (report: BootReport) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A launch attempt begins. A confirmed failure is not its to clear by failing: it stays until the user asks to try again (`retry`) or an attempt observes a serving core. */
  attempt(): LaunchAttempt {
    let ended = false;
    const attempt: LaunchAttempt = {
      progress: (progress, boot) => {
        if (ended) return;
        if (!progress) {
          this.reporting.delete(attempt);
        } else {
          const held = this.highs.get(boot);
          // A boot another one has superseded stays superseded: its late readings are dropped.
          if (!held || boot === this.bootNow) {
            // A reading behind what the boot has already come to (another attempt read an older file) is not shown.
            if (!held || progress.done >= held.done)
              this.highs.set(boot, { done: progress.done, total: progress.total, boot });
            this.bootNow = boot;
            this.reporting.add(attempt);
          }
        }
        this.settle();
      },
      succeeded: () => {
        end();
        this.recovered();
      },
      failed: (error) => {
        end();
        return this.record(error);
      },
    };
    const end = (): void => {
      ended = true;
      this.reporting.delete(attempt);
      this.settle();
    };
    return attempt;
  }

  /** The start that is confirmed not to succeed, until the user asks to try again or a serving core is seen: no attempt launches the core meanwhile. */
  confirmed(): BootFailure | null {
    return this.failure;
  }

  /** A core observed serving supersedes a confirmed failure (and the record of exits): the latch stops launches, not attaching. */
  recovered(): void {
    this.lastExit = null;
    this.counted.clear();
    this.failure = null;
    this.highs.clear();
    this.bootNow = undefined;
    this.emit();
  }

  /** The user's `Try again`: the only thing that withdraws a confirmed failure. The recorded exit stays known, so the same exit
   *  recorded again by the attempt that follows is confirmed at once. */
  retry(): void {
    this.failure = null;
    this.emit();
  }

  private settle(): void {
    this.emit();
  }

  /** Whether a failed attempt is the same recorded exit as the one before it (same exit code, signal and recorded reason, a different capture of it):
   *  then trying again will not change it. The launcher's sentence and the stderr it quotes are detail, not identity. A failure with no exit
   *  (no process started, or the wait ran out) is confirmed the first time. */
  private record(error: unknown): unknown {
    // Once confirmed, no attempt (one already in flight included) changes it: it ends the same way, or another, and the latch stands.
    if (this.failure) return Object.assign(error as Error, { coreLaunchFailed: this.failure });
    const exit = (error as { coreExit?: ExitRecord } | null)?.coreExit;
    if (!exit) {
      // No exit to compare. The binary could not be started (`coreSpawnFailed`), or the launcher's whole wait ended with no serving
      // core (`coreDiscovery`: blocked, stalled, or nothing published): asking again repeats it out of sight, so it is confirmed at
      // once. A core that serves later withdraws it (failure-recovery.ts).
      const held = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
      if (!held || (held.coreSpawnFailed === undefined && !('coreDiscovery' in held))) return error;
      this.failure = {
        message: error instanceof Error ? error.message : String(error),
        exitCode: null,
        stderrPath: null,
      };
      this.emit();
      return Object.assign(error as Error, { coreLaunchFailed: this.failure });
    }
    const signature = JSON.stringify([exit.code ?? null, exit.signal ?? null, exit.reason ?? null]);
    const path = exit.stderrPath ?? null;
    // One exit seen by two overlapping attempts is one record.
    const seen = path !== null && this.counted.has(path);
    if (path !== null) this.counted.add(path);
    if (!seen) {
      const again = this.lastExit === signature;
      this.lastExit = signature;
      this.failure = again
        ? {
            message: error instanceof Error ? error.message : String(error),
            exitCode: exit.code ?? null,
            stderrPath: path,
          }
        : null;
    }
    this.emit();
    return this.failure ? Object.assign(error as Error, { coreLaunchFailed: this.failure }) : error;
  }

  /** Tells the listeners what changed since the last time they were told: a report that says what the last one said is not sent. */
  private emit(): void {
    const report = this.current();
    const told = this.told;
    if (
      told.failure === report.failure &&
      told.progress?.done === report.progress?.done &&
      told.progress?.total === report.progress?.total &&
      told.progress?.boot === report.progress?.boot
    )
      return;
    this.told = report;
    for (const listener of [...this.listeners]) listener(report);
  }
}
