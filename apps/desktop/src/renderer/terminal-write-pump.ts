interface PendingTerminalWrite {
  id: string;
  data: string;
  acknowledge: boolean;
  resolve?: () => void;
}

/**
 * Keep only one xterm parse in flight. Output that arrives while xterm is
 * parsing is joined before the next write, reducing renderer calls without
 * delaying the first visible chunk.
 */
export class TerminalWritePump {
  private active: PendingTerminalWrite | null = null;
  private readonly pending: PendingTerminalWrite[] = [];
  private disposed = false;

  constructor(
    private readonly write: (data: string, complete: () => void) => void,
    private readonly acknowledge: (id: string, charCount: number) => void,
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
      });
    }
    this.drain();
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
        resolve,
      });
      this.drain();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const abandoned = this.active
      ? [this.active, ...this.pending]
      : [...this.pending];
    this.active = null;
    this.pending.length = 0;
    for (const item of abandoned) {
      if (item.acknowledge) this.acknowledge(item.id, item.data.length);
      item.resolve?.();
    }
  }

  private drain(): void {
    if (this.disposed || this.active) return;
    const item = this.pending.shift();
    if (!item) return;
    this.active = item;
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      if (this.active !== item) return;
      this.active = null;
      if (item.acknowledge) this.acknowledge(item.id, item.data.length);
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
}
