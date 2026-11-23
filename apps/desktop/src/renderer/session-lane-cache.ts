import type { Snapshot } from './desktop-types';
import { estimateRetainedChars } from './renderer-value-weight';

interface SessionLaneEntry {
  snapshot: Snapshot;
  bytes: number;
  estimatedAt: number;
  /** Authoritative content generation this cached transcript was accepted at. */
  revision: number | null;
  /** The lane's own snapshot object this entry was made from: handed on again, it is the same state at a later position. */
  incoming?: WeakRef<object>;
  /** That snapshot's item list, as the lane handed it over: the rows the entry shows from `rawOffset` on were made from it,
   *  one for one (the rows before are those of an earlier window the lane kept above). */
  rawItems?: WeakRef<readonly unknown[]>;
  rawOffset?: number | undefined;
  /** The rows shown from `rawOffset` on are `windowAnchored` (transcript-alignment); unset: not read yet. */
  anchored?: boolean | undefined;
  /** A sweep has decided what is kept of this state (`sweep`). */
  swept?: boolean;
}

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

  /** Every lane no pane shows is handed to `trim`, once per state it holds: what `trim` returns is what is kept of it
   *  (the same snapshot: all of it), and null lets the lane go. */
  sweep(trim: (sessionId: string, snapshot: Snapshot) => Snapshot | null): void {
    for (const [sessionId, entry] of [...this.entries]) {
      if (this.options.subscribed(sessionId) || entry.swept) continue;
      const kept = trim(sessionId, entry.snapshot);
      if (!kept) this.entries.delete(sessionId);
      else if (kept === entry.snapshot) entry.swept = true;
      else {
        this.entries.set(sessionId, {
          snapshot: kept,
          bytes: Math.min(entry.bytes, 2 * estimateRetainedChars(kept, Math.max(0, this.options.maxBytes) / 2)),
          estimatedAt: Date.now(),
          revision: entry.revision,
          swept: true,
        });
      }
    }
  }

  /** Rows held by the lanes no pane shows. */
  get inactiveRows(): number {
    let rows = 0;
    for (const [sessionId, entry] of this.entries) {
      if (this.options.subscribed(sessionId)) continue;
      const view = (entry.snapshot as { transcriptViewItems?: unknown }).transcriptViewItems;
      rows += (entry.snapshot.items?.length ?? 0) + (Array.isArray(view) ? view.length : 0);
    }
    return rows;
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
