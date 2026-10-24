import type { Snapshot } from './desktop-types';
import { estimateRetainedChars } from './renderer-value-weight';

interface SessionLaneEntry {
  snapshot: Snapshot;
  bytes: number;
  estimatedAt: number;
  /** Authoritative content generation this cached transcript was accepted at. */
  revision: number | null;
}

/** Mounted panes pin their live frame; only inactive snapshots are evictable.
 * The byte budget therefore bounds the INACTIVE lanes only: a pinned frame is
 * held by its pane whatever this cache does, so charging it here let a few
 * large mounted transcripts push the background set past the budget, and
 * prune() then evicted every lane the user had just left (each return re-read
 * the transcript behind the loading cover). A live frame's size may be
 * sampled cheaply, but release must remeasure it before admitting it to the
 * background budget. */
export class SessionLaneCache {
  private readonly entries = new Map<string, SessionLaneEntry>();

  constructor(
    private readonly options: {
      maxEntries: number;
      maxBytes: number;
      subscribed(sessionId: string): boolean;
    }
  ) {}

  get size(): number {
    return this.entries.size;
  }
  /** Estimated bytes of the inactive (evictable) lanes. */
  get bytes(): number {
    let total = 0;
    for (const [sessionId, entry] of this.entries) {
      if (!this.options.subscribed(sessionId)) total += entry.bytes;
    }
    return total;
  }
  get(sessionId: string): SessionLaneEntry | undefined {
    return this.entries.get(sessionId);
  }

  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
  }

  set(sessionId: string, entry: SessionLaneEntry): void {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
  }

  delete(sessionId: string): void {
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
      entry.bytes = bytes;
      entry.estimatedAt = Date.now();
      // The lane the user just left is the most recently viewed one; lanes
      // that merely received background frames meanwhile are older views.
      this.touch(sessionId);
    }
    this.prune();
  }

  prune(): void {
    const maxEntries = Math.max(0, this.options.maxEntries);
    const maxBytes = Math.max(0, this.options.maxBytes);
    let inactive = this.bytes;
    for (const [sessionId, entry] of this.entries) {
      if (this.entries.size <= maxEntries && inactive <= maxBytes) break;
      if (this.options.subscribed(sessionId)) continue;
      this.entries.delete(sessionId);
      inactive -= entry.bytes;
    }
  }

  evictInactive(): void {
    for (const sessionId of this.entries.keys()) {
      if (!this.options.subscribed(sessionId)) this.delete(sessionId);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
