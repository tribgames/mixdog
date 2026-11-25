import type { Snapshot } from './desktop-types';
import { estimateRetainedChars } from './renderer-value-weight';

/** No row or field of a shown lane is measured past this many characters. */
const MEASURE_LIMIT = 256 * 1024 * 1024;
/** Fields a lane holds that another cache counts: the turn keys of its rows (the decorator's failure scopes). */
const COUNTED_ELSEWHERE = new Set(['failedTurnKeys', 'transcriptTurnKeys']);
/** The fold keeps a row it is told again as the object it holds (protocol-client `heldInPlace`), and a frame that changed
 *  no row hands the same list on: a lane is measured by the lists and rows it gained, each once. */
const listChars = new WeakMap<readonly unknown[], number>();
const rowChars = new WeakMap<object, number>();

function rowsChars(rows: readonly unknown[]): number {
  let chars = listChars.get(rows);
  if (chars !== undefined) return chars;
  chars = 16 + 4 * rows.length;
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      chars += estimateRetainedChars(row, MEASURE_LIMIT);
      continue;
    }
    let own = rowChars.get(row);
    if (own === undefined) {
      own = estimateRetainedChars(row, MEASURE_LIMIT);
      rowChars.set(row, own);
    }
    chars += own;
  }
  listChars.set(rows, chars);
  return chars;
}

/** The characters a lane's state holds (`estimateRetainedChars` units): its rows, by the lists that hold them (a list shown
 *  twice counts once), and its other fields. */
function laneChars(snapshot: Snapshot): number {
  const record = snapshot as Record<string, unknown>;
  const lists = new Set<readonly unknown[]>();
  let chars = 32;
  for (const key in record) {
    if (!Object.hasOwn(record, key) || COUNTED_ELSEWHERE.has(key)) continue;
    const value = record[key];
    chars += key.length + 8;
    if ((key === 'items' || key === 'transcriptViewItems') && Array.isArray(value)) lists.add(value);
    else if (key === 'transcriptViews' && Array.isArray(value)) {
      chars += 16 + 36 * value.length;
      for (const view of value) {
        const items = (view as { items?: unknown } | null)?.items;
        if (Array.isArray(items)) lists.add(items);
      }
    } else chars += estimateRetainedChars(value, MEASURE_LIMIT);
  }
  for (const list of lists) chars += rowsChars(list);
  return chars;
}

interface SessionLaneEntry {
  snapshot: Snapshot;
  bytes: number;
  /** `laneChars` of `snapshot`, read while a pane shows it (`chars`). */
  shownChars?: number;
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
      /** A pane reads the lane. */
      subscribed(sessionId: string): boolean;
      /** The lane is never let go: a pane reads it, shows it, or is about to. */
      kept(sessionId: string): boolean;
    }
  ) {}

  get size(): number {
    return this.entries.size;
  }
  /** Estimated bytes of the inactive (evictable) lanes. */
  get bytes(): number {
    let total = 0;
    for (const [sessionId, entry] of this.entries) {
      if (!this.options.kept(sessionId)) total += entry.bytes;
    }
    return total;
  }
  /** What a lane holds, in the renderer budget's characters: one a pane reads as `laneChars` measures what it holds now
   *  (its bound is the window its session's fold holds), another as its estimate (`bytes`). */
  private counted(sessionId: string, entry: SessionLaneEntry): number {
    if (!this.options.subscribed(sessionId)) return entry.bytes / 2;
    entry.shownChars ??= laneChars(entry.snapshot);
    return entry.shownChars;
  }
  /** What every lane holds (`counted`). */
  get chars(): number {
    let total = 0;
    for (const [sessionId, entry] of this.entries) total += this.counted(sessionId, entry);
    return total;
  }
  /** What the lanes that are never let go hold (`counted`). */
  get keptChars(): number {
    let total = 0;
    for (const [sessionId, entry] of this.entries) {
      if (this.options.kept(sessionId)) total += this.counted(sessionId, entry);
    }
    return total;
  }
  /** Lets lanes go, least recently viewed first, until the lanes hold at most `target` characters (`chars`); a kept
   *  lane is never let go. Returns the sessions let go. */
  trimTo(target: number): string[] {
    const gone: string[] = [];
    let total = this.chars;
    for (const [sessionId, entry] of [...this.entries]) {
      if (total <= target) break;
      if (this.options.kept(sessionId)) continue;
      this.entries.delete(sessionId);
      total -= entry.bytes / 2;
      gone.push(sessionId);
    }
    return gone;
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
      if (bytes > limit && !this.options.kept(sessionId)) {
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
      if (this.options.kept(sessionId)) continue;
      this.entries.delete(sessionId);
      inactive -= entry.bytes;
    }
  }

  /** Every lane no pane shows is handed to `trim`, once per state it holds: what `trim` returns is what is kept of it
   *  (the same snapshot: all of it), and null lets the lane go. */
  sweep(trim: (sessionId: string, snapshot: Snapshot) => Snapshot | null): void {
    for (const [sessionId, entry] of [...this.entries]) {
      if (this.options.kept(sessionId) || entry.swept) continue;
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
