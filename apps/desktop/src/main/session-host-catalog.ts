import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import { RecoveringStoreWatcher } from './recovering-store-watcher';

// Cold-view (stored-projection) refresh cadence. Only sessions that publish no
// live frames are re-read, and the worker runtime persists its in-progress
// transcript on a 2s clock, so a 1s reader keeps a visible agent pane current
// without adding a faster poll than there is new content to read.
export const COLD_VIEW_REFRESH_MS = 1_000;
export const STORE_REFRESH_DEBOUNCE_MS = 400;
export const STORE_REFRESH_MIN_GAP_MS = 2_000;
// Direct children of the data directory whose change can alter the session
// catalog or agent pool. Everything else the daemon writes there (index lock
// and temp files, shell job records, logs, tool snapshots) is noise that used
// to trigger a full store rescan per event.
const CATALOG_STORE_ENTRIES = new Set([
  'sessions',
  'session-summaries.json',
  'agent-workers.json',
  'lead-workers.json',
  'turn-checkpoints',
]);

export function catalogRelevantStoreEntry(filename: string | Buffer | null | undefined): boolean {
  const name = typeof filename === 'string' ? filename : filename ? String(filename) : '';
  // Windows reports nested changes as "dir\\file"; only the top segment matters.
  const top = name.split(/[\\/]/, 1)[0];
  return top === '' || CATALOG_STORE_ENTRIES.has(top);
}

export interface SessionHostCatalogOwner {
  isDisposed(): boolean;
  listSessions(): Promise<DesktopSessionSummary[]>;
  listAgentPool(): Promise<DesktopAgentPoolRow[]>;
  publishSessions(sessions: DesktopSessionSummary[]): void;
  publishAgents(agents: DesktopAgentPoolRow[]): void;
  coldSessionIds(): string[];
  readSession(sessionId: string): Promise<unknown>;
}

/** Store-watcher debounce, catalog republish, and cold-view poll. Owns the
 *  watcher and timers; SessionHost supplies listings and publication. */
export class SessionHostCatalog {
  private storeRefreshTimer: NodeJS.Timeout | null = null;
  private storeRefreshedAt = 0;
  private coldViewTimer: NodeJS.Timeout | null = null;
  private readonly refreshingColdSessionIds = new Set<string>();
  private readonly watcher: RecoveringStoreWatcher;

  constructor(
    private readonly owner: SessionHostCatalogOwner,
    options: {
      directory(): string;
      watch?: typeof import('node:fs').watch;
    },
  ) {
    this.watcher = new RecoveringStoreWatcher({
      directory: options.directory,
      relevant: catalogRelevantStoreEntry,
      changed: () => this.scheduleCatalogRefresh(),
      error: (error) => console.warn('[mixdog-catalog] change watcher interrupted; recovering', error),
      ...(options.watch ? { watch: options.watch } : {}),
    });
  }

  /** Cold-view refresh.
   *
   *  A session served from its STORED projection receives no live frames,
   *  because only a materialized daemon entry
   *  publishes those. An agent worker session never materializes one: it runs
   *  inside its Lead's runtime, so a pane opened on a working agent would sit
   *  forever on whatever snapshot it happened to load first (user report:
   *  위임한 세션이 pane에서 안 도는 것처럼 보인다).
   *
   *  Re-reading the visible cold views turns that pane into a live one. A
   *  session that later materializes starts publishing live frames, its
   *  stored-projection flag clears, and it drops out of this set on its own. */
  ensureColdViewRefresh(): void {
    if (this.coldViewTimer || this.owner.isDisposed()) return;
    this.coldViewTimer = setInterval(() => {
      void this.refreshColdViews();
    }, COLD_VIEW_REFRESH_MS);
    this.coldViewTimer.unref?.();
  }

  async refreshColdViews(): Promise<void> {
    if (this.owner.isDisposed()) return;
    const cold = this.owner.coldSessionIds();
    if (cold.length === 0) {
      if (this.coldViewTimer) clearInterval(this.coldViewTimer);
      this.coldViewTimer = null;
      return;
    }
    await Promise.allSettled(cold.map(async (sessionId) => {
      if (this.refreshingColdSessionIds.has(sessionId)) return;
      this.refreshingColdSessionIds.add(sessionId);
      try {
        await this.owner.readSession(sessionId);
      } finally {
        this.refreshingColdSessionIds.delete(sessionId);
      }
    }));
  }

  ensureStoreWatcher(): void {
    if (!this.owner.isDisposed()) this.watcher.start();
  }

  /** A catalog refresh re-enumerates every stored session (stat per file and a
   *  re-parse of each changed transcript), so store events coalesce into one
   *  trailing refresh no more often than STORE_REFRESH_MIN_GAP_MS. Session
   *  frames stay live on their own lane; only the sidebar catalog waits. */
  scheduleCatalogRefresh(): void {
    if (this.storeRefreshTimer || this.owner.isDisposed()) return;
    const sinceLast = Date.now() - this.storeRefreshedAt;
    const delay = Math.max(STORE_REFRESH_DEBOUNCE_MS, STORE_REFRESH_MIN_GAP_MS - sinceLast);
    this.storeRefreshTimer = setTimeout(() => {
      this.storeRefreshTimer = null;
      this.storeRefreshedAt = Date.now();
      void this.publishCatalogs();
    }, delay);
    this.storeRefreshTimer.unref?.();
  }

  async publishCatalogs(): Promise<void> {
    if (this.owner.isDisposed()) return;
    // A failed listing is NOT an empty store: publishing `[]` for a transient
    // daemon fault blanked every open tab's title (the tab strip and pane
    // addressing both read the catalog) until the next refresh repainted it.
    // Keep the last good catalog and let the next store event retry.
    const [sessions, agents] = await Promise.all([
      this.owner.listSessions().catch((): null => null),
      this.owner.listAgentPool().catch((): null => null),
    ]);
    if (sessions) this.owner.publishSessions(sessions);
    if (agents) this.owner.publishAgents(agents);
  }

  close(): void {
    if (this.storeRefreshTimer) clearTimeout(this.storeRefreshTimer);
    this.storeRefreshTimer = null;
    if (this.coldViewTimer) clearInterval(this.coldViewTimer);
    this.coldViewTimer = null;
    this.watcher.close();
  }
}
