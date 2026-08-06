// Desktop-only session metadata: generated titles, user names and archive
// tombstones persisted next to the daemon-owned session store. Reads share one
// in-flight request so post-submit title work cannot race foreground listings. Writes are
// snapshot-then-serialized so a later mutation never rides an older in-flight
// write.
import {
  generatedSessionTitle,
  isMediaSessionTitlePlaceholder,
} from '../shared/session-title.mjs';
import { readSessionMetadata, writeSessionMetadata } from './session-metadata-file';

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

export class DesktopSessionMetadata {
  private readonly userDataRoot: () => string;
  private titleMap: Record<string, string> | null = null;
  private nameMap: Record<string, string> | null = null;
  private archivedMap: Record<string, number> | null = null;
  private rewrittenGeneratedTitleIds = new Set<string>();
  private loadRequest: Promise<void> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(userDataRoot: () => string) {
    this.userDataRoot = userDataRoot;
  }

  /** Generated titles keyed by session id (empty before the first load). */
  get titles(): Record<string, string> {
    return this.titleMap || {};
  }

  /** Whether metadata is already resident and can be updated without I/O. */
  get loaded(): boolean {
    return Boolean(this.titleMap && this.nameMap && this.archivedMap);
  }

  /** User-assigned names, which always win over a generated title. */
  get names(): Record<string, string> {
    return this.nameMap || {};
  }

  /** Archive tombstones, or null while metadata has never been read. */
  get archived(): Record<string, number> | null {
    return this.archivedMap;
  }

  /** The canonical display title: manual name, shared core title, then the
   *  desktop's pre-generation fallback. */
  displayTitle(sessionId: string, sharedTitle = ''): string {
    if (!sessionId) return '';
    return this.nameMap?.[sessionId]
      || generatedSessionTitle(sharedTitle, '')
      || this.titleMap?.[sessionId]
      || '';
  }

  async load(): Promise<void> {
    if (this.titleMap && this.nameMap && this.archivedMap) return;
    if (this.loadRequest) return await this.loadRequest;
    const request = (async () => {
      const maps = await readSessionMetadata(this.userDataRoot());
      this.titleMap = maps.titles;
      this.nameMap = maps.names;
      this.archivedMap = maps.archived;
      this.rewrittenGeneratedTitleIds = new Set(maps.rewrittenTitleIds);
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
    (this.nameMap ??= Object.create(null) as Record<string, string>)[sessionId] = normalized;
    await this.queueWrite();
  }

  /** True when the archive state actually changed (and was persisted). */
  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    const map = this.archivedMap ??= Object.create(null) as Record<string, number>;
    const has = Object.prototype.hasOwnProperty.call(map, sessionId);
    if (archived === has) return false;
    if (archived) map[sessionId] = Date.now();
    else delete map[sessionId];
    await this.queueWrite();
    return true;
  }

  /** Drop every record for a deleted session. */
  async forget(sessionId: string): Promise<void> {
    const had = Object.prototype.hasOwnProperty.call(this.titles, sessionId)
      || Object.prototype.hasOwnProperty.call(this.names, sessionId)
      || Object.prototype.hasOwnProperty.call(this.archivedMap || {}, sessionId);
    delete this.titleMap?.[sessionId];
    delete this.nameMap?.[sessionId];
    if (this.archivedMap) delete this.archivedMap[sessionId];
    this.rewrittenGeneratedTitleIds.delete(sessionId);
    if (had) await this.queueWrite();
  }

  /** Record a generated title once: a user name or an existing title wins. */
  rememberGeneratedTitle(sessionId: string, title: string): boolean {
    if (!this.titleMap || !SESSION_ID.test(sessionId) || this.nameMap?.[sessionId]) return false;
    const normalized = generatedSessionTitle(title, '');
    if (!normalized) return false;
    const existing = this.titleMap[sessionId] || '';
    if (existing && (!isMediaSessionTitlePlaceholder(existing)
      || isMediaSessionTitlePlaceholder(normalized))) return false;
    this.titleMap[sessionId] = normalized;
    void this.queueWrite();
    return true;
  }

  /** LLM titling: replace the heuristic generated title with a model-written
   *  one. A user-assigned name still wins; media placeholders never demote a
   *  real title. */
  promoteGeneratedTitle(sessionId: string, title: string): boolean {
    if (!this.titleMap || !SESSION_ID.test(sessionId) || this.nameMap?.[sessionId]) return false;
    const normalized = generatedSessionTitle(title, '');
    if (!normalized || isMediaSessionTitlePlaceholder(normalized)) return false;
    if (this.titleMap[sessionId] === normalized) return false;
    this.titleMap[sessionId] = normalized;
    this.rewrittenGeneratedTitleIds.delete(sessionId);
    void this.queueWrite();
    return true;
  }

  /** A generator upgrade identified this id as polluted. Replace only that
   *  generated value from the full durable preview; manual names and all
   *  already-stable generated titles remain immutable. */
  repairRewrittenGeneratedTitle(sessionId: string, title: string): boolean {
    if (!this.titleMap || !SESSION_ID.test(sessionId)
      || this.nameMap?.[sessionId] || !this.rewrittenGeneratedTitleIds.has(sessionId)) return false;
    const normalized = generatedSessionTitle(title, '');
    if (!normalized) return false;
    this.rewrittenGeneratedTitleIds.delete(sessionId);
    if (this.titleMap[sessionId] === normalized) return false;
    this.titleMap[sessionId] = normalized;
    void this.queueWrite();
    return true;
  }

  /** Mark archived rows in a session listing. */
  withArchiveFlags<T extends { id: string }>(summaries: T[]): T[] {
    const archived = this.archivedMap;
    if (!archived) return summaries;
    return summaries.map((row) => (
      Object.prototype.hasOwnProperty.call(archived, row.id) ? { ...row, archived: true } : row
    ));
  }

  /** Settle every queued write (teardown). */
  flush(): Promise<void> {
    return this.pendingWrite;
  }

  private queueWrite(): Promise<void> {
    const titles = { ...this.titles };
    const names = { ...this.names };
    const archived = { ...(this.archivedMap || {}) };
    this.pendingWrite = this.pendingWrite.then(
      () => writeSessionMetadata(this.userDataRoot(), { titles, names, archived }),
    ).catch((error: unknown) => {
      console.error('Failed to persist desktop session metadata:', error);
    });
    return this.pendingWrite;
  }
}
