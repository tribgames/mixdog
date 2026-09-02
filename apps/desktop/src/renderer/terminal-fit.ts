export type TerminalGrid = {
  cols: number;
  rows: number;
};

type FrameCallback = (time: number) => void;

export type StableTerminalFitOptions<RestoreState> = {
  isActive(): boolean;
  isMeasurable(): boolean;
  currentGrid(): TerminalGrid;
  proposeGrid(): TerminalGrid | null;
  fit(restore: RestoreState | null): void;
  emitResize(grid: TerminalGrid): void;
  onSettled(): void;
  requestFrame(callback: FrameCallback): number;
  cancelFrame(id: number): void;
};

const MAX_STABILITY_FRAMES = 8;

export function sameTerminalGrid(
  left: TerminalGrid | null,
  right: TerminalGrid | null,
): boolean {
  return left?.cols === right?.cols && left?.rows === right?.rows;
}

/**
 * Coalesces drag-driven measurements, waits for a stable xterm grid, and emits
 * a PTY resize only when the fitted rows or columns actually changed.
 */
export class StableTerminalFitScheduler<RestoreState> {
  private frame: number | null = null;
  private candidate: TerminalGrid | null = null;
  private stabilityFrames = 0;
  private lastEmittedGrid: TerminalGrid | null = null;
  private pendingRestore: RestoreState | null = null;
  private hasPendingRestore = false;

  constructor(private readonly options: StableTerminalFitOptions<RestoreState>) {}

  schedule(): void;
  schedule(restore: RestoreState | null): void;
  schedule(restore?: RestoreState | null): void {
    if (arguments.length > 0) {
      this.pendingRestore = restore ?? null;
      this.hasPendingRestore = true;
    }
    if (this.frame !== null || !this.options.isActive()) return;
    this.frame = this.options.requestFrame(() => this.run());
  }

  invalidateResize(): void {
    this.lastEmittedGrid = null;
  }

  pause(): void {
    if (this.frame !== null) this.options.cancelFrame(this.frame);
    this.frame = null;
    this.candidate = null;
    this.stabilityFrames = 0;
  }

  dispose(): void {
    this.pause();
    this.pendingRestore = null;
    this.hasPendingRestore = false;
    this.lastEmittedGrid = null;
  }

  private run(): void {
    this.frame = null;
    if (!this.options.isActive() || !this.options.isMeasurable()) {
      this.candidate = null;
      this.stabilityFrames = 0;
      return;
    }

    let proposed: TerminalGrid | null;
    try {
      proposed = this.options.proposeGrid();
    } catch {
      return;
    }
    if (!proposed) return;

    const current = this.options.currentGrid();
    const stable = sameTerminalGrid(current, proposed)
      || sameTerminalGrid(this.candidate, proposed)
      || this.stabilityFrames >= MAX_STABILITY_FRAMES - 1;
    if (!stable) {
      this.candidate = proposed;
      this.stabilityFrames += 1;
      this.schedule();
      return;
    }

    const restore = this.hasPendingRestore ? this.pendingRestore : null;
    this.pendingRestore = null;
    this.hasPendingRestore = false;
    this.candidate = null;
    this.stabilityFrames = 0;
    try {
      this.options.fit(restore);
      const fitted = this.options.currentGrid();
      if (!sameTerminalGrid(this.lastEmittedGrid, fitted)) {
        this.lastEmittedGrid = fitted;
        this.options.emitResize(fitted);
      }
      this.options.onSettled();
    } catch {
      // The surface can be parked between measurement and fit.
    }
  }
}

export function applyTerminalActivity(
  active: boolean,
  handlers: {
    enableRenderer(): void;
    releaseRenderer(): void;
    scheduleFit(): void;
    pauseFit(): void;
    focus(): void;
  },
): void {
  if (!active) {
    handlers.pauseFit();
    handlers.releaseRenderer();
    return;
  }
  handlers.enableRenderer();
  handlers.scheduleFit();
  handlers.focus();
}
