// Agent keep-awake (orca-inspired): while the engine reports live work, hold
// an Electron powerSaveBlocker so the OS never suspends mid-turn; release it
// the moment the work stops. `prevent-app-suspension` keeps the machine and
// network alive while still letting the display sleep.
import type { SessionSnapshot } from '../shared/contract';

// A crashed engine can freeze the last snapshot on "working". Never hold the
// machine awake on a signal older than this window (matches orca's staleness).
export const AWAKE_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export function snapshotHasActiveWork(snapshot: SessionSnapshot): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const state = snapshot as Record<string, unknown>;
  // Mirrors the renderer's hasActiveSnapshotWork, plus background shell jobs:
  // an async command keeps running after the turn goes idle and dies with the
  // machine just the same.
  const active = (value: unknown): boolean => Boolean(
    value && typeof value === 'object' && (value as { active?: unknown }).active !== false,
  );
  // `shellJobs` is PANE-scoped (one session's own jobs); keep-awake is a
  // machine-wide concern, so the host-wide aggregate wins when present and the
  // pane field is only the fallback for older/remote frames.
  const shellJobs = (state.hostShellJobs ?? state.shellJobs) as { count?: unknown } | null | undefined;
  return Boolean(
    state.busy
    || state.commandBusy
    || state.thinking
    || active(state.spinner)
    || active(state.commandStatus)
    || (shellJobs && Number(shellJobs.count) > 0),
  );
}

export class AgentAwakeService {
  private enabled = true;
  private working = false;
  private lastWorkSignalAt = 0;
  private blockerId: number | null = null;
  private staleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly blocker: PowerSaveBlockerLike,
    private readonly now: () => number = Date.now,
  ) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.refresh();
  }

  onSnapshot(snapshot: SessionSnapshot): void {
    this.working = snapshotHasActiveWork(snapshot);
    if (this.working) this.lastWorkSignalAt = this.now();
    this.refresh();
  }

  /** Re-check without new input (system resume, periodic safety). */
  reevaluate(): void {
    this.refresh();
  }

  isBlocking(): boolean {
    return this.blockerId !== null;
  }

  dispose(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    this.working = false;
    this.stopBlocker();
  }

  private shouldBlock(): boolean {
    return this.enabled && this.working
      && this.now() - this.lastWorkSignalAt <= AWAKE_STALE_AFTER_MS;
  }

  private refresh(): void {
    this.scheduleStaleRelease();
    if (this.shouldBlock()) this.startBlocker();
    else this.stopBlocker();
  }

  private scheduleStaleRelease(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    if (!this.enabled || !this.working) return;
    const remaining = this.lastWorkSignalAt + AWAKE_STALE_AFTER_MS - this.now();
    if (remaining <= 0) return;
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      this.refresh();
    }, remaining);
    this.staleTimer.unref?.();
  }

  private startBlocker(): void {
    try {
      if (this.blockerId !== null && this.blocker.isStarted(this.blockerId)) return;
      this.blockerId = this.blocker.start('prevent-app-suspension');
    } catch {
      // Keep-awake is best-effort; never let a platform failure break a turn.
      this.blockerId = null;
    }
  }

  private stopBlocker(): void {
    if (this.blockerId === null) return;
    const id = this.blockerId;
    this.blockerId = null;
    try {
      this.blocker.stop(id);
    } catch { /* already released */ }
  }
}
