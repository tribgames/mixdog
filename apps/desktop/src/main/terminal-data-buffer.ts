export interface TerminalDataEvent {
  id: string;
  data: string;
}

interface PendingTerminalData {
  chunks: string[];
  charCount: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface TerminalProducerFlowControl {
  pause(id: string): void;
  resume(id: string): void;
}

/** Coalesce bursty node-pty output before it crosses Electron IPC. */
export class TerminalDataBufferer {
  private readonly pending = new Map<string, PendingTerminalData>();
  private readonly inFlightChars = new Map<string, number>();
  private readonly pausedProducers = new Set<string>();
  private readonly delayMs: number;
  private readonly highWatermarkChars: number;
  private readonly lowWatermarkChars: number;

  constructor(
    private readonly deliver: (event: TerminalDataEvent) => void,
    delayMs = 5,
    highWatermarkChars = 256 * 1024,
    private readonly producerFlow?: TerminalProducerFlowControl,
    lowWatermarkChars = Math.max(1, Math.floor(highWatermarkChars / 8)),
  ) {
    this.delayMs = Math.max(0, Math.round(delayMs));
    this.highWatermarkChars = Math.max(1, Math.round(highWatermarkChars));
    this.lowWatermarkChars = Math.max(
      0,
      Math.min(this.highWatermarkChars - 1, Math.round(lowWatermarkChars)),
    );
  }

  push(event: TerminalDataEvent): void {
    const id = String(event?.id || "");
    const data = String(event?.data || "");
    if (!id || !data) return;
    const existing = this.pending.get(id);
    if (existing) {
      existing.chunks.push(data);
      existing.charCount += data.length;
      this.updateProducerFlow(id);
      return;
    }
    const timer = setTimeout(() => this.flush(id), this.delayMs);
    this.pending.set(id, { chunks: [data], charCount: data.length, timer });
    this.updateProducerFlow(id);
  }

  flush(id: string, force = false): void {
    const buffered = this.pending.get(id);
    if (!buffered) return;
    const inFlight = this.inFlightChars.get(id) || 0;
    const available = this.highWatermarkChars - inFlight;
    if (!force && available <= 0) {
      if (buffered.timer) clearTimeout(buffered.timer);
      buffered.timer = null;
      return;
    }
    if (buffered.timer) clearTimeout(buffered.timer);
    const joined = buffered.chunks.join("");
    const data = force ? joined : joined.slice(0, available);
    const remainder = force ? "" : joined.slice(data.length);
    if (remainder) {
      this.pending.set(id, { chunks: [remainder], charCount: remainder.length, timer: null });
    } else {
      this.pending.delete(id);
    }
    if (!data) return;
    if (!force) {
      this.inFlightChars.set(id, inFlight + data.length);
    }
    this.deliver({ id, data });
  }

  /** Release IPC pressure only after xterm has parsed the corresponding data. */
  acknowledge(id: string, charCount: number): void {
    const terminalId = String(id || "");
    const count = Math.floor(Number(charCount));
    if (!terminalId || !Number.isFinite(count) || count <= 0) return;
    const current = this.inFlightChars.get(terminalId) || 0;
    if (current <= 0) return;
    const next = Math.max(0, current - count);
    if (next > 0) this.inFlightChars.set(terminalId, next);
    else this.inFlightChars.delete(terminalId);
    if (next < this.highWatermarkChars && this.pending.has(terminalId)) {
      this.flush(terminalId);
    }
    this.updateProducerFlow(terminalId);
  }

  /** Drop all accounting for a disposed PTY and guarantee that a producer
   * paused under the old terminal id cannot remain wedged. */
  release(id: string): void {
    const terminalId = String(id || "");
    if (!terminalId) return;
    const buffered = this.pending.get(terminalId);
    if (buffered?.timer) clearTimeout(buffered.timer);
    this.pending.delete(terminalId);
    this.inFlightChars.delete(terminalId);
    this.resumeProducer(terminalId);
  }

  private pendingChars(id: string): number {
    return (this.inFlightChars.get(id) || 0) + (this.pending.get(id)?.charCount || 0);
  }

  private updateProducerFlow(id: string): void {
    if (!this.producerFlow) return;
    const pendingChars = this.pendingChars(id);
    if (!this.pausedProducers.has(id)) {
      if (pendingChars > this.highWatermarkChars) {
        try {
          this.producerFlow.pause(id);
          this.pausedProducers.add(id);
        } catch {
          // The renderer queue remains bounded even if producer flow control fails.
        }
      }
      return;
    }
    if (pendingChars < this.lowWatermarkChars) this.resumeProducer(id);
  }

  private resumeProducer(id: string): void {
    if (!this.pausedProducers.delete(id)) return;
    try {
      this.producerFlow?.resume(id);
    } catch {
      // Teardown must continue even if the PTY exited while paused.
    }
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.flush(id, true);
    for (const id of [...this.pausedProducers]) this.resumeProducer(id);
    this.inFlightChars.clear();
  }
}
