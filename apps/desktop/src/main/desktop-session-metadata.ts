// Desktop-only session metadata: generated titles, user names and archive
// tombstones persisted next to the daemon-owned session store. Reads share one
// in-flight request so post-submit title work cannot race foreground listings.
// Writes drain immutable snapshots; a failed write retains the newest maps
// for an explicit retry instead of reporting an unsaved mutation as success.
import { createDebouncedWriter, type DebouncedWriter } from '../../../../src/runtime/shared/debounced-writer.mjs';
import { generatedSessionTitle, isMediaSessionTitlePlaceholder } from '../shared/session-title.mjs';
import { readSessionMetadata, writeSessionMetadata, type SessionReadCursor } from './session-metadata-file';
import { isSessionId } from './desktop-state';

type MetadataMaps = Parameters<typeof writeSessionMetadata>[1];
type MetadataField = keyof MetadataMaps;
const FIELDS: MetadataField[] = ['titles', 'names', 'archived', 'favorites', 'projects', 'reads', 'retired'];
/** Trailing window in which read-cursor changes share one write. */
const WRITE_COALESCE_MS = 400;
const dirtyKey = (field: MetadataField, sessionId: string): string => `${field}\u0000${sessionId}`;

/** A session's numbering: its compaction count (the epoch) and its message count. */
interface ReadNumbering {
  compactCount?: unknown;
  messageCount?: unknown;
}
const validEpoch = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;

/** What a save writes: this instance's maps plus the (field, session) entries
 *  it changed since they were last persisted, keyed to their change generation. */
interface MetadataSnapshot {
  maps: MetadataMaps;
  dirty: Map<string, number>;
}

export class DesktopSessionMetadata {
  private readonly userDataRoot: () => string;
  private titleMap: Record<string, string> | null = null;
  private nameMap: Record<string, string> | null = null;
  private archivedMap: Record<string, number> | null = null;
  private favoriteMap: Record<string, number> | null = null;
  /** Legacy sidebar project assignments: never read or set any more (a move
   *  changes the session's working folder); only a deleted session drops its entry. */
  private projectMap: Record<string, string> | null = null;
  private readMap: Record<string, SessionReadCursor> | null = null;
  private retiredMap: Record<string, number> | null = null;
  private loadRequest: Promise<void> | null = null;
  private readonly writer: DebouncedWriter<void>;
  private writeError: unknown;
  private readonly dirty = new Map<string, number>();
  private generation = 0;
  private lastArchiveStamp = 0;
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(userDataRoot: () => string) {
    this.userDataRoot = userDataRoot;
    this.writer = createDebouncedWriter({
      delayMs: 0,
      write: () => this.persist(),
      onError: (error: unknown) => {
        this.writeError = error;
        console.error('Failed to persist desktop session metadata:', error);
      },
    });
  }

  /** Generated titles keyed by session id (empty before the first load). */
  get titles(): Record<string, string> {
    return this.titleMap || {};
  }

  /** Whether metadata is already resident and can be updated without I/O. */
  get loaded(): boolean {
    return Boolean(this.titleMap && this.nameMap && this.archivedMap && this.readMap);
  }

  /** User-assigned names, which always win over a generated title. */
  get names(): Record<string, string> {
    return this.nameMap || {};
  }

  /** Archive tombstones, or null while metadata has never been read. */
  get archived(): Record<string, number> | null {
    return this.archivedMap;
  }

  /** Favorite stamps keyed by session id. */
  get favorites(): Record<string, number> {
    return this.favoriteMap || {};
  }

  /** Cross-surface read cursors keyed by session id. */
  get reads(): Record<string, SessionReadCursor> {
    return this.readMap || {};
  }

  async load(): Promise<void> {
    if (this.titleMap && this.nameMap && this.archivedMap && this.readMap) return;
    if (this.loadRequest) return await this.loadRequest;
    const request = (async () => {
      const maps = await readSessionMetadata(this.userDataRoot());
      this.titleMap = maps.titles;
      this.nameMap = maps.names;
      this.archivedMap = maps.archived;
      this.favoriteMap = maps.favorites;
      this.projectMap = maps.projects;
      this.readMap = maps.reads;
      this.retiredMap = maps.retired;
      // A stored title the current generator would render differently is
      // rewritten in memory; persist it so the next read is stable.
      if (maps.rewritten) await this.queueWrite();
    })();
    this.loadRequest = request;
    try {
      await request;
    } finally {
      if (this.loadRequest === request) this.loadRequest = null;
    }
  }

  async setName(sessionId: string, normalized: string): Promise<void> {
    await this.load();
    this.nameMap ??= Object.create(null) as Record<string, string>;
    if (this.nameMap[sessionId] === normalized) return await this.flush();
    this.nameMap[sessionId] = normalized;
    this.touch('names', sessionId);
    await this.queueWrite();
  }

  /** True when the session's own archive state actually changed (and was
   *  persisted). Its sub-agent `descendants` follow it in the same write: an
   *  archive stamps the ones not archived yet with the session's own stamp, a
   *  restore brings back exactly the ones carrying it (those it archived) and
   *  leaves any archived on their own. Stamps never repeat within this
   *  instance, so two archives never share one. */
  async setArchived(sessionId: string, archived: boolean, descendants: readonly string[] = []): Promise<boolean> {
    await this.load();
    this.archivedMap ??= Object.create(null) as Record<string, number>;
    const map = this.archivedMap;
    const has = Object.hasOwn(map, sessionId);
    if (archived === has) {
      await this.flush();
      return false;
    }
    const stamp = archived ? Math.max(Date.now(), this.lastArchiveStamp + 1) : map[sessionId];
    if (archived) this.lastArchiveStamp = stamp;
    for (const id of [sessionId, ...descendants]) {
      if (id !== sessionId && (archived ? Object.hasOwn(map, id) : map[id] !== stamp)) continue;
      if (archived) map[id] = stamp;
      else delete map[id];
      this.touch('archived', id);
    }
    await this.queueWrite();
    return true;
  }

  /** Whether this home thread was already archived for its agent's deletion. */
  async isRetired(sessionId: string): Promise<boolean> {
    await this.load();
    return Object.hasOwn(this.retiredMap || {}, sessionId);
  }

  /** Record (or, when the agent exists again, clear) a home thread's
   *  retirement. True when the record changed. */
  async setRetired(sessionId: string, retired: boolean): Promise<boolean> {
    await this.load();
    this.retiredMap ??= Object.create(null) as Record<string, number>;
    const map = this.retiredMap;
    if (retired === Object.hasOwn(map, sessionId)) return false;
    if (retired) map[sessionId] = Date.now();
    else delete map[sessionId];
    this.touch('retired', sessionId);
    await this.queueWrite();
    return true;
  }

  /** True when the favorite state actually changed (and was persisted). */
  async setFavorite(sessionId: string, favorite: boolean): Promise<boolean> {
    await this.load();
    this.favoriteMap ??= Object.create(null) as Record<string, number>;
    const map = this.favoriteMap;
    if (favorite === Object.hasOwn(map, sessionId)) {
      await this.flush();
      return false;
    }
    if (favorite) map[sessionId] = Date.now();
    else delete map[sessionId];
    this.touch('favorites', sessionId);
    await this.queueWrite();
    return true;
  }

  /** Advance the shared read cursor. `consumedUnread` also records a
   * completion-only read when the message count did not move. `numbering` is
   * the session's current compaction count and message count (see
   * settleReadCursor); a cursor of an earlier numbering restarts first. */
  async markRead(
    sessionId: string,
    messageCount: number,
    consumedUnread: boolean,
    numbering: ReadNumbering = {}
  ): Promise<boolean> {
    if (!isSessionId(sessionId) || !Number.isInteger(messageCount) || messageCount < 0 || messageCount > 10_000_000) {
      throw new TypeError('Session read cursor is invalid.');
    }
    await this.load();
    this.readMap ??= Object.create(null) as Record<string, SessionReadCursor>;
    const map = this.readMap;
    const stored = map[sessionId];
    const current = this.settleReadCursor(sessionId, numbering);
    const settled = current !== stored;
    // A surface still counting in a retired numbering (a local count from
    // before a compaction) cannot read past the session's own messages.
    const ownCount = Number.isSafeInteger(numbering.messageCount) ? (numbering.messageCount as number) : 0;
    const nextCount = Math.max(
      current?.messageCount || 0,
      ownCount >= 1 ? Math.min(messageCount, ownCount) : messageCount
    );
    if (current && nextCount === current.messageCount && !consumedUnread) {
      if (settled) this.deferWrite();
      // Only a retained failed write is retried here; a still-coalescing
      // cursor change must not be flushed early.
      else if (this.writer.hasPending()) await this.flush();
      return settled;
    }
    // A new cursor takes the session's epoch; an old one keeps the epoch it
    // was settled to (an unsettled one stays unstamped).
    const epoch = current ? current.epoch : validEpoch(numbering.compactCount);
    map[sessionId] = {
      messageCount: nextCount,
      revision: Math.min(Number.MAX_SAFE_INTEGER, (current?.revision || 0) + 1),
      ...(epoch === undefined ? {} : { epoch }),
    };
    this.touch('reads', sessionId);
    this.deferWrite();
    return true;
  }

  /** Drop every record for a deleted session. */
  async forget(sessionId: string): Promise<void> {
    await this.load();
    const had =
      Object.hasOwn(this.titles, sessionId) ||
      Object.hasOwn(this.names, sessionId) ||
      Object.hasOwn(this.archivedMap || {}, sessionId) ||
      Object.hasOwn(this.favoriteMap || {}, sessionId) ||
      Object.hasOwn(this.projectMap || {}, sessionId) ||
      Object.hasOwn(this.readMap || {}, sessionId) ||
      Object.hasOwn(this.retiredMap || {}, sessionId);
    delete this.titleMap?.[sessionId];
    delete this.nameMap?.[sessionId];
    if (this.archivedMap) delete this.archivedMap[sessionId];
    if (this.favoriteMap) delete this.favoriteMap[sessionId];
    if (this.projectMap) delete this.projectMap[sessionId];
    if (this.readMap) delete this.readMap[sessionId];
    if (this.retiredMap) delete this.retiredMap[sessionId];
    if (had) {
      for (const field of FIELDS) this.touch(field, sessionId);
      await this.queueWrite();
    } else await this.flush();
  }

  /** Record a generated title once: a user name or an existing title wins. */
  rememberGeneratedTitle(sessionId: string, title: string): boolean {
    if (!this.titleMap || !isSessionId(sessionId) || this.nameMap?.[sessionId]) return false;
    const normalized = generatedSessionTitle(title, '');
    if (!normalized) return false;
    const existing = this.titleMap[sessionId] || '';
    if (existing && (!isMediaSessionTitlePlaceholder(existing) || isMediaSessionTitlePlaceholder(normalized)))
      return false;
    return this.storeTitle(sessionId, normalized);
  }

  /** A deleted bot's archived home: titled with the bot's name at that
   *  deletion, replacing an earlier one (a user name still wins). */
  rememberRetiredTitle(sessionId: string, name: string): boolean {
    if (!this.titleMap || !isSessionId(sessionId) || this.nameMap?.[sessionId]) return false;
    const normalized = generatedSessionTitle(name, '');
    if (!normalized || this.titleMap[sessionId] === normalized) return false;
    return this.storeTitle(sessionId, normalized);
  }

  private storeTitle(sessionId: string, title: string): boolean {
    if (!this.titleMap) return false;
    this.titleMap[sessionId] = title;
    this.touch('titles', sessionId);
    void this.queueWrite().catch(() => {
      /* writer retains and reports the pending save */
    });
    return true;
  }

  /** Mark archived rows in a session listing. */
  withArchiveFlags<T extends { id: string }>(summaries: T[]): T[] {
    const archived = this.archivedMap;
    if (!archived) return summaries;
    return summaries.map((row) => (Object.hasOwn(archived, row.id) ? { ...row, archived: true } : row));
  }

  /** Mark the home threads whose bot was deleted (a read-only chat), each
   *  listed under the bot's name (rememberRetiredTitle) over a title its
   *  conversation got; a user's own name for it still wins. */
  withRetiredFlags<T extends { id: string; title?: string }>(summaries: T[]): T[] {
    const retired = this.retiredMap;
    if (!retired) return summaries;
    return summaries.map((row) => {
      if (!Object.hasOwn(retired, row.id)) return row;
      const botName = this.nameMap?.[row.id] ? '' : this.titleMap?.[row.id] || '';
      return { ...row, agentDeleted: true, ...(botName ? { title: botName } : {}) };
    });
  }

  /** Mark favorite rows in a session listing. */
  withFavoriteFlags<T extends { id: string }>(summaries: T[]): T[] {
    const favorites = this.favoriteMap;
    if (!favorites) return summaries;
    return summaries.map((row) => (Object.hasOwn(favorites, row.id) ? { ...row, favorite: true } : row));
  }

  /** Project shared read cursors into the catalog pushed to every surface.
   *  Each cursor is first settled against its row's numbering epoch. */
  withReadCursors<T extends { id: string; messageCount?: number; compactCount?: number }>(
    summaries: T[]
  ): Array<T & { readMessageCount?: number; readRevision?: number }> {
    const reads = this.readMap;
    if (!reads) return summaries;
    let settled = false;
    const projected = summaries.map((row) => {
      const stored = reads[row.id];
      const cursor = this.settleReadCursor(row.id, row);
      if (cursor !== stored) settled = true;
      return cursor ? { ...row, readMessageCount: cursor.messageCount, readRevision: cursor.revision } : row;
    });
    if (settled) void this.queueWrite().catch(() => undefined);
    return projected;
  }

  /** A cursor counts the messages the session had when it was recorded, and a
   *  compaction (`compactCount` up by one) trims them and restarts that
   *  numbering. A cursor recorded under another `compactCount` restarts at 0:
   *  the reset is not a read, so it keeps its revision and every unread or
   *  completion state survives it. A cursor from before the epoch was recorded
   *  is stamped with the current one; when the session is known compacted it
   *  is also lowered to the session's message count if that is above it, and
   *  stays as it is until a real count (at least 1) can judge it. A row
   *  without a `compactCount` settles nothing. */
  private settleReadCursor(
    sessionId: string,
    { compactCount, messageCount }: ReadNumbering
  ): SessionReadCursor | undefined {
    const reads = this.readMap;
    const cursor = reads?.[sessionId];
    const epoch = validEpoch(compactCount);
    if (!reads || !cursor || epoch === undefined || cursor.epoch === epoch) return cursor;
    let restarted = cursor.messageCount;
    if (cursor.epoch !== undefined) restarted = 0;
    else if (epoch > 0) {
      // Not settled, nor stamped, without a real count to judge it by.
      if (!Number.isSafeInteger(messageCount) || (messageCount as number) < 1) return cursor;
      restarted = Math.min(restarted, messageCount as number);
    }
    const settled = { ...cursor, messageCount: restarted, epoch };
    reads[sessionId] = settled;
    this.touch('reads', sessionId);
    return settled;
  }

  /** Settle every queued write (teardown). */
  async flush(): Promise<void> {
    if (this.deferredTimer) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = null;
      this.schedulePersist();
    }
    if (!(await this.writer.flush())) throw this.writeError;
  }

  private touch(field: MetadataField, sessionId: string): void {
    this.dirty.set(dirtyKey(field, sessionId), ++this.generation);
  }

  private queueWrite(): Promise<void> {
    this.schedulePersist();
    return this.flush();
  }

  /** Mark a write pending without snapshotting; the maps are copied once, when
   *  the write actually starts, so coalesced changes cost one copy. */
  private schedulePersist(): void {
    this.writer.schedule();
  }

  /** Persist a non-critical change (a read cursor) within a short trailing
   *  window; every change inside it shares one write. `flush()` and quit
   *  settle it early. */
  private deferWrite(): void {
    if (this.deferredTimer) return;
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = null;
      this.schedulePersist();
      void this.writer.flush();
    }, WRITE_COALESCE_MS);
    this.deferredTimer.unref?.();
  }

  private snapshot(): MetadataSnapshot {
    return {
      maps: {
        titles: { ...this.titles },
        names: { ...this.names },
        archived: { ...(this.archivedMap || {}) },
        favorites: { ...(this.favoriteMap || {}) },
        projects: { ...(this.projectMap || {}) },
        reads: { ...this.reads },
        retired: { ...(this.retiredMap || {}) },
      },
      dirty: new Map(this.dirty),
    };
  }

  /** Re-read the file and apply only the entries this instance changed, so a
   *  save never republishes this cache's stale view of other entries (another
   *  desktop service may share the metadata directory). */
  private async persist(): Promise<void> {
    const { maps, dirty } = this.snapshot();
    const root = this.userDataRoot();
    const disk = await readSessionMetadata(root);
    const merged = {} as Record<MetadataField, Record<string, unknown>>;
    for (const field of FIELDS) merged[field] = Object.assign(Object.create(null), disk[field]);
    for (const key of dirty.keys()) {
      const [field, id] = key.split('\u0000') as [MetadataField, string];
      const source = maps[field] as Record<string, unknown>;
      if (Object.hasOwn(source, id)) merged[field][id] = source[id];
      else delete merged[field][id];
    }
    await writeSessionMetadata(root, merged as MetadataMaps);
    for (const [key, generation] of dirty) if (this.dirty.get(key) === generation) this.dirty.delete(key);
  }
}
