interface PendingTerminalWrite {
  id: string;
  data: string;
  acknowledge: boolean;
  queuedAt: number;
  resolve?: () => void;
}

/**
 * Submit ordinary output directly into xterm's ordered parser queue. Only
 * replay/local-prediction writes form barriers. Keep the submitted window
 * bounded so a large output burst still applies upstream backpressure.
 */
export class TerminalWritePump {
  private readonly active = new Set<PendingTerminalWrite>();
  private readonly pending: PendingTerminalWrite[] = [];
  private barrier: PendingTerminalWrite | null = null;
  private inFlightChars = 0;
  private draining = false;
  private disposed = false;
  private completedWrites = 0;
  private totalQueueMs = 0;
  private maxQueueMs = 0;
  private totalCommitMs = 0;

  constructor(
    private readonly write: (data: string, complete: () => void) => void,
    private readonly acknowledge: (id: string, charCount: number) => void,
    private readonly now: () => number = () => performance.now(),
    private readonly maxInFlightChars = 64 * 1024,
  ) {}

  push(id: string, data: string): void {
    const terminalId = String(id || "");
    const value = String(data || "");
    if (this.disposed || !terminalId || !value) return;
    const tail = this.pending.at(-1);
    if (tail?.acknowledge && tail.id === terminalId && !tail.resolve) {
      tail.data += value;
    } else {
      this.pending.push({
        id: terminalId,
        data: value,
        acknowledge: true,
        queuedAt: this.now(),
      });
    }
    this.drain();
  }

  /** True while server output (acknowledged writes) is queued or in flight.
   *  Local prediction/replay writes do not count. */
  get hasQueuedOutput(): boolean {
    return [...this.active].some((item) => item.acknowledge)
      || this.pending.some((item) => item.acknowledge);
  }

  /** Aggregate timings only; never retain terminal text or keystrokes. */
  get timingStats() {
    return {
      completedWrites: this.completedWrites,
      meanQueueMs: this.completedWrites ? this.totalQueueMs / this.completedWrites : 0,
      maxQueueMs: this.maxQueueMs,
      meanCommitMs: this.completedWrites ? this.totalCommitMs / this.completedWrites : 0,
      inFlightChars: this.inFlightChars,
      pendingWrites: this.pending.length,
    };
  }

  /** Replays reconnect scrollback before newly arriving acknowledged output. */
  writeReplay(data: string): Promise<void> {
    const value = String(data || "");
    if (this.disposed || !value) return Promise.resolve();
    return new Promise((resolve) => {
      this.pending.push({
        id: "",
        data: value,
        acknowledge: false,
        queuedAt: this.now(),
        resolve,
      });
      this.drain();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const abandoned = [...this.active, ...this.pending];
    this.active.clear();
    this.barrier = null;
    this.inFlightChars = 0;
    this.pending.length = 0;
    for (const item of abandoned) {
      if (item.acknowledge) this.acknowledge(item.id, item.data.length);
      item.resolve?.();
    }
  }

  private drain(): void {
    if (this.disposed || this.draining) return;
    this.draining = true;
    try {
      while (!this.disposed && !this.barrier && this.pending.length) {
        const item = this.pending[0];
        if (this.active.size && (!item.acknowledge
            || this.inFlightChars + item.data.length > this.maxInFlightChars)) return;
        this.pending.shift();
        this.active.add(item);
        this.inFlightChars += item.data.length;
        if (!item.acknowledge) this.barrier = item;
        const submittedAt = this.now();
        const complete = () => {
          if (!this.active.delete(item)) return;
          this.inFlightChars -= item.data.length;
          if (this.barrier === item) this.barrier = null;
          if (item.acknowledge) {
            const queuedMs = Math.max(0, submittedAt - item.queuedAt);
            this.completedWrites += 1;
            this.totalQueueMs += queuedMs;
            this.maxQueueMs = Math.max(this.maxQueueMs, queuedMs);
            this.totalCommitMs += Math.max(0, this.now() - submittedAt);
            this.acknowledge(item.id, item.data.length);
          }
          item.resolve?.();
          this.drain();
        };
        try {
          this.write(item.data, complete);
        } catch {
          // A disposed xterm must not strand main-process flow control.
          complete();
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
