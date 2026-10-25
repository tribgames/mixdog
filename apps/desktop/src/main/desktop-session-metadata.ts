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
const dirtyKey = (field: MetadataField, sessionId: string): string => `${field}\u0000${sessionId}`;

/** A queued save: this instance's maps plus the (field, session) entries it
 *  changed since they were last persisted, keyed to their change generation. */
interface PendingWrite {
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
  private readonly writer: DebouncedWriter<PendingWrite>;
  private writeError: unknown;
  private readonly dirty = new Map<string, number>();
  private generation = 0;
  private lastArchiveStamp = 0;

  constructor(userDataRoot: () => string) {
    this.userDataRoot = userDataRoot;
    this.writer = createDebouncedWriter({
      delayMs: 0,
      write: (pending: PendingWrite) => this.persist(pending),
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
   * completion-only read when the message count did not move. */
  async markRead(sessionId: string, messageCount: number, consumedUnread: boolean): Promise<boolean> {
    if (!isSessionId(sessionId) || !Number.isInteger(messageCount) || messageCount < 0 || messageCount > 10_000_000) {
      throw new TypeError('Session read cursor is invalid.');
    }
    await this.load();
    this.readMap ??= Object.create(null) as Record<string, SessionReadCursor>;
    const map = this.readMap;
    const current = map[sessionId];
    const nextCount = Math.max(current?.messageCount || 0, messageCount);
    if (current && nextCount === current.messageCount && !consumedUnread) {
      await this.flush();
      return false;
    }
    map[sessionId] = {
      messageCount: nextCount,
      revision: Math.min(Number.MAX_SAFE_INTEGER, (current?.revision || 0) + 1),
    };
    this.touch('reads', sessionId);
    await this.queueWrite();
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

  /** Project shared read cursors into the catalog pushed to every surface. */
  withReadCursors<T extends { id: string }>(
    summaries: T[]
  ): Array<T & { readMessageCount?: number; readRevision?: number }> {
    const reads = this.readMap;
    if (!reads) return summaries;
    return summaries.map((row) => {
      const cursor = reads[row.id];
      return cursor ? { ...row, readMessageCount: cursor.messageCount, readRevision: cursor.revision } : row;
    });
  }

  /** Settle every queued write (teardown). */
  async flush(): Promise<void> {
    if (!(await this.writer.flush())) throw this.writeError;
  }

  private touch(field: MetadataField, sessionId: string): void {
    this.dirty.set(dirtyKey(field, sessionId), ++this.generation);
  }

  private queueWrite(): Promise<void> {
    const titles = { ...this.titles };
    const names = { ...this.names };
    const archived = { ...(this.archivedMap || {}) };
    const favorites = { ...(this.favoriteMap || {}) };
    const projects = { ...(this.projectMap || {}) };
    const reads = { ...this.reads };
    const retired = { ...(this.retiredMap || {}) };
    this.writer.schedule({
      maps: { titles, names, archived, favorites, projects, reads, retired },
      dirty: new Map(this.dirty),
    });
    return this.flush();
  }

  /** Re-read the file and apply only the entries this instance changed, so a
   *  save never republishes this cache's stale view of other entries (another
   *  desktop service may share the metadata directory). */
  private async persist({ maps, dirty }: PendingWrite): Promise<void> {
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
