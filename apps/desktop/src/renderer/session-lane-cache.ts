import type { Snapshot } from "./desktop-types";
import { estimateRetainedChars } from "./renderer-value-weight";

export interface SessionLaneEntry {
  snapshot: Snapshot;
  bytes: number;
  estimatedAt: number;
  /** Authoritative content generation this cached transcript was accepted at. */
  revision: number | null;
}

/** Mounted panes pin their live frame; only inactive snapshots are evictable.
 * A live frame's size may be sampled cheaply, but release must remeasure it
 * before admitting it to the background budget. */
export class SessionLaneCache {
  private readonly entries = new Map<string, SessionLaneEntry>();
  private retained = 0;

  constructor(private readonly options: {
    maxEntries: number;
    maxBytes: number;
    subscribed(sessionId: string): boolean;
  }) {}

  get size(): number { return this.entries.size; }
  get bytes(): number { return this.retained; }
  get(sessionId: string): SessionLaneEntry | undefined { return this.entries.get(sessionId); }

  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
  }

  set(sessionId: string, entry: SessionLaneEntry): void {
    this.delete(sessionId);
    this.entries.set(sessionId, entry);
    this.retained += entry.bytes;
  }

  delete(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) this.retained -= entry.bytes;
    this.entries.delete(sessionId);
  }

  release(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry && !this.options.subscribed(sessionId)) {
      const limit = Math.max(0, this.options.maxBytes);
      // Keep finite accounting even when a single transcript exceeds the whole
      // budget. No need to traverse the rest of an already oversized frame.
      const bytes = Math.min(limit + 1, 2 * estimateRetainedChars(entry.snapshot, limit / 2));
      if (bytes > limit) {
        this.delete(sessionId);
        this.prune();
        return;
      }
      this.retained += bytes - entry.bytes;
      entry.bytes = bytes;
      entry.estimatedAt = Date.now();
    }
    this.prune();
  }

  prune(): void {
    for (const sessionId of this.entries.keys()) {
      if (this.entries.size <= Math.max(0, this.options.maxEntries)
        && this.retained <= Math.max(0, this.options.maxBytes)) break;
      if (!this.options.subscribed(sessionId)) this.delete(sessionId);
    }
  }

  evictInactive(): void {
    for (const sessionId of this.entries.keys()) {
      if (!this.options.subscribed(sessionId)) this.delete(sessionId);
    }
  }

  clear(): void {
    this.entries.clear();
    this.retained = 0;
  }
}
