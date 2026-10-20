import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import { RecoveringStoreWatcher } from './recovering-store-watcher';

// Cold-view (stored-projection) refresh cadence. Only sessions that publish no
// live frames are re-read, and the worker runtime persists its in-progress
// transcript on a 2s clock, so a 1s reader keeps a visible agent pane current
// without adding a faster poll than there is new content to read.
export const COLD_VIEW_REFRESH_MS = 1_000;
const COLD_VIEW_REFRESH_CONCURRENCY = 2;
export const STORE_REFRESH_DEBOUNCE_MS = 400;
export const STORE_REFRESH_MIN_GAP_MS = 2_000;
// Direct children of the data directory whose change can alter the session
// catalog or agent pool. Everything else the daemon writes there (index lock
// and temp files, shell job records, logs, tool snapshots) is noise that used
// to trigger a full store rescan per event.
const CATALOG_STORE_ENTRIES = new Set([
  'sessions',
  'session-summaries.json',
  // Per-session delta log of the summary index; an update appends here and
  // only touches the .json on compaction.
  'session-summaries.log',
  'agent-workers.json',
  'lead-workers.json',
  'turn-checkpoints',
]);

export function catalogRelevantStoreEntry(filename: string | Buffer | null | undefined): boolean {
  let name = '';
  if (typeof filename === 'string') name = filename;
  else if (filename) name = String(filename);
  // Windows reports nested changes as "dir\\file"; only the top segment matters.
  const top = name.split(/[\\/]/, 1)[0];
  return top === '' || CATALOG_STORE_ENTRIES.has(top);
}

/** Subscribes `changed`; resolves to its unsubscribe function (or nothing when
 *  the store offers no such notification). */
type StoreChangeSubscription = (
  changed: (kind?: string) => void
) => Promise<(() => void) | undefined | void> | (() => void) | undefined | void;

/** Coalescing window of an agent-activity refresh: a turn settling, a task
 *  wait starting or a background hand-off reaches the Agents pool promptly,
 *  while a burst of transitions still costs one pool read. */
export const AGENT_ACTIVITY_REFRESH_MS = 50;

interface SessionHostCatalogOwner {
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
  private agentPoolRefreshTimer: NodeJS.Timeout | null = null;
  private agentPoolRefreshing = false;
  private agentPoolRefreshQueued = false;
  private agentPoolListMs = 0;
  private storeRefreshedAt = 0;
  private sessionListingSeq = 0;
  private publishedSessionListingSeq = 0;
  private coldViewTimer: NodeJS.Timeout | null = null;
  private readonly refreshingColdSessionIds = new Set<string>();
  private readonly watcher: RecoveringStoreWatcher;
  private readonly subscribeStoreChanges: StoreChangeSubscription | undefined;
  private storeSubscribed = false;
  private unsubscribeStore: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly owner: SessionHostCatalogOwner,
    options: {
      directory(): string;
      watch?: typeof import('node:fs').watch;
      /** Store-side catalog corrections that no file event reports (the
       *  stored-session reader's background verification). */
      subscribeStoreChanges?: StoreChangeSubscription;
    }
  ) {
    this.subscribeStoreChanges = options.subscribeStoreChanges;
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
    // A few reads at a time: every visible cold pane re-read at once (a
    // restore with many panes) projected its transcripts back to back on the
    // daemon's one thread.
    let next = 0;
    const refreshNext = async (): Promise<void> => {
      while (next < cold.length) {
        const sessionId = cold[next++];
        if (this.refreshingColdSessionIds.has(sessionId)) continue;
        this.refreshingColdSessionIds.add(sessionId);
        try {
          await this.owner.readSession(sessionId);
        } catch {
          // One unreadable view must not stop the others' refresh.
        } finally {
          this.refreshingColdSessionIds.delete(sessionId);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(COLD_VIEW_REFRESH_CONCURRENCY, cold.length) }, refreshNext));
  }

  ensureStoreWatcher(): void {
    if (this.owner.isDisposed()) return;
    this.watcher.start();
    if (this.storeSubscribed || !this.subscribeStoreChanges) return;
    this.storeSubscribed = true;
    void Promise.resolve()
      .then(() =>
        this.subscribeStoreChanges?.((kind) =>
          kind === 'agent-activity' ? this.scheduleAgentPoolRefresh() : this.scheduleCatalogRefresh()
        )
      )
      .then(
        (unsubscribe) => {
          if (typeof unsubscribe !== 'function') return;
          if (this.closed) unsubscribe();
          else this.unsubscribeStore = unsubscribe;
        },
        (error) => console.warn('[mixdog-catalog] store change subscription failed', error)
      );
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

  /** Runtime activity changed (no store file did): re-read only the Agents
   *  pool, which projects that activity, after a short coalescing window.
   *  One read at a time: changes during a read queue one trailing read, which
   *  waits at least as long as the last read took. Every turn and background
   *  task transition signals here, and the pool read runs on the daemon's
   *  thread; under load a read outlasting the window let reads pile up. */
  scheduleAgentPoolRefresh(): void {
    if (this.agentPoolRefreshTimer || this.owner.isDisposed()) return;
    if (this.agentPoolRefreshing) {
      this.agentPoolRefreshQueued = true;
      return;
    }
    this.agentPoolRefreshTimer = setTimeout(
      () => {
        this.agentPoolRefreshTimer = null;
        if (this.owner.isDisposed()) return;
        this.agentPoolRefreshing = true;
        const startedAt = Date.now();
        void this.owner
          .listAgentPool()
          .then((agents) => this.owner.publishAgents(agents))
          .catch(() => {})
          .finally(() => {
            this.agentPoolRefreshing = false;
            this.agentPoolListMs = Date.now() - startedAt;
            if (!this.agentPoolRefreshQueued) return;
            this.agentPoolRefreshQueued = false;
            this.scheduleAgentPoolRefresh();
          });
      },
      Math.max(AGENT_ACTIVITY_REFRESH_MS, this.agentPoolListMs)
    );
    this.agentPoolRefreshTimer.unref?.();
  }

  async publishCatalogs(): Promise<void> {
    if (this.owner.isDisposed()) return;
    // A failed listing is NOT an empty store: publishing `[]` for a transient
    // daemon fault blanked every open tab's title (the tab strip and pane
    // addressing both read the catalog) until the next refresh repainted it.
    // Keep the last good catalog and let the next store event retry.
    // Each catalog is published as soon as its own listing lands. Held for a
    // slow Agents pool read, a session listing taken while a new task was
    // still hidden went out after the task's row had already been published,
    // and the renderer read the missing row as a deletion: it closed the
    // task's tab and left the pane on a blank New task. A listing that lands
    // after a newer one was already published is dropped for the same reason.
    const listingSeq = ++this.sessionListingSeq;
    await Promise.all([
      this.owner.listSessions().then(
        (sessions) => {
          if (listingSeq < this.publishedSessionListingSeq) return;
          this.publishedSessionListingSeq = listingSeq;
          this.owner.publishSessions(sessions);
        },
        () => undefined
      ),
      this.owner.listAgentPool().then(
        (agents) => this.owner.publishAgents(agents),
        () => undefined
      ),
    ]);
  }

  close(): void {
    this.closed = true;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    if (this.storeRefreshTimer) clearTimeout(this.storeRefreshTimer);
    this.storeRefreshTimer = null;
    if (this.agentPoolRefreshTimer) clearTimeout(this.agentPoolRefreshTimer);
    this.agentPoolRefreshTimer = null;
    if (this.coldViewTimer) clearInterval(this.coldViewTimer);
    this.coldViewTimer = null;
    this.watcher.close();
  }
}
