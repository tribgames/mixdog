// What the app's wait for this PC's core reports to the windows that wait with it: the core's index rebuild, and a start that
// cannot succeed. Everything here belongs to a launch attempt (one call of the launcher's attach-or-start): what an attempt
// reported is withdrawn when the attempt ends, however it ends.
/** What the core does before it serves, as the person waiting is told: the conversion of the earlier version's data, the index
 *  rebuild, or the wait for the earlier version's daemon to close. */
export type BootStage = 'migration' | 'rebuild' | 'legacy';

export interface BootProgress {
  readonly stage: BootStage;
  /** The counts the core names of its work (0 of 0 while it names none). */
  readonly done: number;
  readonly total: number;
  /** The core process (its pid) these counts are of: the counts of one boot's stage never decrease, and a new boot starts again. */
  readonly boot: number | null;
}

/** The process a start is blocked on, as shown: no credential of the launcher's. */
export interface BootBlock {
  readonly pid: number | null;
  readonly kind: string;
  readonly image: string | null;
  readonly commandLine: string | null;
  /** The core may be told the process is not Mixdog (`release{pid}`); otherwise the way past it is its stop. */
  readonly releasable: boolean;
  /** The process is the earlier version's daemon. */
  readonly legacy: boolean;
  /** Why the earlier daemon did not agree to close when asked, when it was asked. */
  readonly retireError: string | null;
  /** The person's action runs: the start continues when the process has gone. */
  readonly resolving: boolean;
  /** The person's action failed, with why. */
  readonly resolveError: string | null;
}

/** A start that trying again will not change: the core process exits at boot for the same recorded reason, cannot be started at
 *  all, was waited for the launcher's whole limit without serving, or is blocked on a process the person must decide about. */
export interface BootFailure {
  /** The launcher's own sentence: what the core ended with and the last thing it said. */
  readonly message: string;
  readonly exitCode: number | null;
  /** Where the core's own stderr was kept. */
  readonly stderrPath: string | null;
  readonly blocked: BootBlock | null;
}

export interface BootReport {
  readonly progress: BootProgress | null;
  readonly failure: BootFailure | null;
  /** No core is started: an update replaces this one and the app is about to quit for its installer. */
  readonly updating: boolean;
}

export interface BootReportSource {
  current(): BootReport;
  /** The user chose to try again after a confirmed failure (for a blocked start: the action past the block). */
  retry(): void;
  subscribe(listener: (report: BootReport) => void): () => void;
}

export interface LaunchAttempt {
  /** What the core does before it serves as the launcher reads it (null when nothing). Ignored once the attempt has ended. */
  readonly progress: (
    progress: { stage: BootStage; done: number; total: number } | null,
    boot: number | null
  ) => void;
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

/** What the launcher names of a blocked start (ensure-core.mjs `coreBlocked`) and how it can act on it (`coreBlockedAccess`). */
export interface BlockedStart {
  readonly block: {
    pid: number | null;
    kind: string;
    image: string | null;
    commandLine: string | null;
    releasable: boolean;
    legacy: boolean;
    retire: { accepted: boolean; error: string | null } | null;
  };
  readonly access: unknown;
}

export interface BootReportsOptions {
  /** The person's action past a block: resolves once it has been carried out (the process asked to stop, or released). */
  resolveBlock?(start: BlockedStart): Promise<void>;
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
  /** How the launcher can act on the standing block (never shown). */
  private blockedStart: BlockedStart | null = null;
  private updating = false;
  private readonly listeners = new Set<(report: BootReport) => void>();
  private readonly servingListeners = new Set<() => void>();
  /** The structured outcome of the last recorded exit (its code and signal), and the captures already counted. */
  private lastExit: string | null = null;
  private readonly counted = new Set<string>();
  private told: BootReport = { progress: null, failure: null, updating: false };

  constructor(private readonly options: BootReportsOptions = {}) {}

  current(): BootReport {
    const shown = this.reporting.size > 0 && this.bootNow !== undefined ? this.highs.get(this.bootNow) : undefined;
    return { progress: shown ?? null, failure: this.failure, updating: this.updating };
  }

  /** Told each time a launcher attempt or the recovery watch sees a core serve: what gave up on the core before it served (main's
   *  own link) starts again from here. */
  onServing(listener: () => void): () => void {
    this.servingListeners.add(listener);
    return () => {
      this.servingListeners.delete(listener);
    };
  }

  /** The block a confirmed failure stands on, when it is one: the recovery watch ends it when that process has gone. */
  blockedPid(): number | null {
    return this.failure?.blocked?.pid ?? null;
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
            // A reading behind what the boot's stage has already come to (another attempt read an older file) is not shown; a
            // stage the boot moved on to starts its counts again.
            if (!held || held.stage !== progress.stage || progress.done >= held.done)
              this.highs.set(boot, { stage: progress.stage, done: progress.done, total: progress.total, boot });
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

  /** A core observed serving supersedes a confirmed failure (and the record of exits): the latch stops launches, not attaching. So
   *  does the end of the process a block stood on: the blocked core starts by itself then. */
  recovered(): void {
    this.lastExit = null;
    this.counted.clear();
    this.failure = null;
    this.blockedStart = null;
    this.updating = false;
    this.highs.clear();
    this.bootNow = undefined;
    this.emit();
    for (const listener of [...this.servingListeners]) {
      try {
        listener();
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  /** The user's `Try again`: the only thing that withdraws a confirmed failure. The recorded exit stays known, so the same exit
   *  recorded again by the attempt that follows is confirmed at once. A block is not withdrawn: the action past it runs (the
   *  process is stopped, or released), and the block ends when that process has gone (the recovery watch) or the core serves. */
  retry(): void {
    const start = this.blockedStart;
    const failure = this.failure;
    if (start && failure?.blocked && this.options.resolveBlock) {
      if (failure.blocked.resolving) return;
      this.failure = { ...failure, blocked: { ...failure.blocked, resolving: true, resolveError: null } };
      this.emit();
      const resolving = this.failure;
      this.options.resolveBlock(start).catch((error: unknown) => {
        if (this.failure !== resolving || !resolving.blocked) return;
        const message = error instanceof Error ? error.message : String(error);
        this.failure = { ...resolving, blocked: { ...resolving.blocked, resolving: false, resolveError: message } };
        this.emit();
      });
      return;
    }
    this.failure = null;
    this.blockedStart = null;
    this.emit();
  }

  private settle(): void {
    this.emit();
  }

  /** Whether a failed attempt is the same recorded exit as the one before it (same exit code, signal and recorded reason, a different capture of it):
   *  then trying again will not change it. The launcher's sentence and the stderr it quotes are detail, not identity. A failure with no exit
   *  (no process started, or the wait ran out) is confirmed the first time. */
  private record(error: unknown): unknown {
    // An update replaces the core and the app quits for its installer: no launch is a failure then, and nothing is confirmed.
    if ((error as { name?: unknown } | null)?.name === 'CoreLaunchRefused') {
      if (!this.updating) {
        this.updating = true;
        this.emit();
      }
      return error;
    }
    // Any other end: launches are open again (an install that did not go ahead), and the wait is the core's again.
    if (this.updating) {
      this.updating = false;
      this.emit();
    }
    // Once confirmed, no attempt (one already in flight included) changes it: it ends the same way, or another, and the latch stands.
    if (this.failure) return Object.assign(error as Error, { coreLaunchFailed: this.failure });
    const exit = (error as { coreExit?: ExitRecord } | null)?.coreExit;
    if (!exit) {
      // No exit to compare: the binary could not be started (`coreSpawnFailed`), the launcher's whole wait ended with no serving
      // core (`coreDiscovery`: stalled, or nothing published), or the start is blocked on a process (`coreBlocked`). Asking again
      // repeats it out of sight, so it is confirmed at once; a core that serves later withdraws it (failure-recovery.ts). Any other
      // error (a read the OS refused for a moment) is the client's to try again.
      const held = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
      if (!held || (held.coreSpawnFailed === undefined && !('coreDiscovery' in held))) return error;
      const blocked = error as { coreBlocked?: BlockedStart['block']; coreBlockedAccess?: unknown };
      this.blockedStart = blocked.coreBlocked ? { block: blocked.coreBlocked, access: blocked.coreBlockedAccess } : null;
      this.failure = {
        message: error instanceof Error ? error.message : String(error),
        exitCode: null,
        stderrPath: null,
        blocked: blocked.coreBlocked
          ? {
              pid: blocked.coreBlocked.pid,
              kind: blocked.coreBlocked.kind,
              image: blocked.coreBlocked.image,
              commandLine: blocked.coreBlocked.commandLine,
              releasable: blocked.coreBlocked.releasable,
              legacy: blocked.coreBlocked.legacy,
              retireError:
                blocked.coreBlocked.retire && !blocked.coreBlocked.retire.accepted
                  ? (blocked.coreBlocked.retire.error ?? 'it did not agree')
                  : null,
              resolving: false,
              resolveError: null,
            }
          : null,
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
            blocked: null,
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
      told.updating === report.updating &&
      told.progress?.stage === report.progress?.stage &&
      told.progress?.done === report.progress?.done &&
      told.progress?.total === report.progress?.total &&
      told.progress?.boot === report.progress?.boot
    )
      return;
    this.told = report;
    for (const listener of [...this.listeners]) listener(report);
  }
}
