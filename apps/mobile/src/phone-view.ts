// What the phone has open on the core: the threads its panes show, plus the app feed. This replaces Node's `setVisibleSessions` /
// `synchronizeViews` pair. A thread is subscribed with `thread/resume` and dropped with `thread/unsubscribe`; the client library
// restores every subscription itself after a reconnect (with `resumeFrom`), so this module never re-sends them. What it adds is
// the order Node kept: the set the page last named wins, the set of the last visit is opened with the first connection, and a
// connection counts as synced only when the app feed and every open thread are attached again.
import type { ClientEvent, ProtocolClient, SessionFold, StoreChange } from '../../../packages/protocol-client/src/index.ts';

/** Threads open per pane: the same window `thread/resume` is asked for everywhere on the phone. */
export const VIEW_WINDOW = { lastItems: 50 } as const;

export type ViewClient = Pick<ProtocolClient<SessionFold>, 'resumeThread' | 'unsubscribeThread' | 'subscribeApp' | 'status' | 'on'> & {
  readonly store: Pick<ProtocolClient<SessionFold>['store'], 'subscribe'>;
};

export interface ViewManager {
  /** The page names the threads it shows. Resolves true once they are open; false when the connection ended first (ask again). */
  set(threadIds: readonly string[]): Promise<boolean>;
  /** Asks the core again for the app feed and every open thread (they resume from where they were): the page doubts the stream, e.g. after a wake. */
  resync(): Promise<boolean>;
  /** Resolves when the connection that is up has the app feed and every open thread attached. */
  synced(): Promise<void>;
  stop(): void;
}

/** Syncs that fail this many times in a row on one connection recycle it (Node: `createRemoteViewSync` `failureLimit`, remote-view-sync.ts:16). */
export const SYNC_FAILURE_LIMIT = 3;
/** A failed sync is retried after 250 ms, doubling to 10 s (remote-view-sync.ts:24, :53). */
export const SYNC_RETRY_MS = 250;
export const SYNC_RETRY_MAX_MS = 10_000;

/**
 * One sync in flight per connection; requests made meanwhile coalesce into the next (remote-view-sync.ts:30-34 `pump`). A failed
 * sync is reported, retried on the backoff above, and after `SYNC_FAILURE_LIMIT` failures in a row the connection is recycled: the
 * socket is alive but useless for syncing, and everything waiting on the view would wait forever (remote-view-sync.ts:46-59). A
 * connection that ended takes its failures and its retry with it; the library re-attaches what was open on the next one.
 */
export function createViewManager(
  client: ViewClient,
  options: {
    /** Threads of the last visit: opened with the first connection, whatever the panes name first. */
    restored: readonly string[];
    /** Called each time everything asked of the core has been attached (the first connection included); `reconnected` when a new connection did it. */
    onSynced(reconnected: boolean): void;
    /** A sync of the view began on the connection that is up (a change of the view, a resync): the indicator shows it until `onSynced`. */
    syncing(): void;
    /** A sync failed (it is retried). */
    error(error: unknown): void;
    /** The connection is alive but cannot sync: replace it. */
    recycle(): void;
  }
): ViewManager {
  const open = new Set<string>();
  let wanted: readonly string[] = [];
  let restored = [...options.restored];
  let appOpen = false;
  let refresh = false;
  let firstSynced: () => void = () => undefined;
  let syncedNow: Promise<void> = new Promise<void>((resolve) => {
    firstSynced = resolve;
  });
  let everSynced = false;
  const live = (): boolean => client.status.state === 'ready';

  let requested = 0;
  let completed = 0;
  let running = false;
  let generation = 0;
  let failures = 0;
  let retryDelay = SYNC_RETRY_MS;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Set<(ok: boolean) => void>();

  const waitAttached = (): Promise<void> => {
    const pending = new Set<string>(['app', ...open]);
    return new Promise<void>((resolve) => {
      const off = client.store.subscribe((change: StoreChange) => {
        if (change.type !== 'subscription') return;
        pending.delete(change.feedId);
        if (pending.size === 0) {
          off();
          resolve();
        }
      });
      if (pending.size === 0) {
        off();
        resolve();
      }
    });
  };
  const synced = (reconnected: boolean): void => {
    everSynced = true;
    firstSynced();
    options.onSynced(reconnected);
  };

  const attach = async (force: boolean): Promise<void> => {
    const target = new Set([...wanted, ...restored]);
    if (!appOpen || force) {
      await client.subscribeApp();
      appOpen = true;
    }
    for (const id of [...open]) {
      if (target.has(id)) continue;
      open.delete(id);
      await client.unsubscribeThread(id);
    }
    for (const id of target) {
      if (open.has(id) && !force) continue;
      await client.resumeThread(id, VIEW_WINDOW);
      open.add(id);
    }
  };

  const pump = (): void => {
    if (running || retry !== undefined || completed === requested || !live()) return;
    const epoch = generation;
    const revision = requested;
    const force = refresh;
    refresh = false;
    running = true;
    options.syncing();
    attach(force)
      .then(
        () => {
          if (epoch !== generation) return;
          completed = revision;
          retryDelay = SYNC_RETRY_MS;
          failures = 0;
          restored = [];
          if (completed === requested) {
            synced(false);
            for (const done of [...waiting]) done(true);
            waiting.clear();
          }
        },
        (error: unknown) => {
          if (epoch !== generation) return;
          if (force) refresh = true;
          options.error(error);
          failures += 1;
          retry = setTimeout(() => {
            retry = undefined;
            pump();
          }, retryDelay);
          retryDelay = Math.min(SYNC_RETRY_MAX_MS, retryDelay * 2);
          // Armed first: the recycle's close ends this connection, which clears the timer with the rest of its state.
          if (failures >= SYNC_FAILURE_LIMIT) {
            failures = 0;
            options.recycle();
          }
        }
      )
      .finally(() => {
        if (epoch !== generation) return;
        running = false;
        pump();
      });
  };
  const request = (): Promise<boolean> => {
    requested += 1;
    const done = new Promise<boolean>((resolve) => waiting.add(resolve));
    pump();
    return done;
  };

  // A new connection: the library re-attaches what was open; this connection is synced when all of it is back.
  const offStatus = client.on((event: ClientEvent) => {
    if (event.type !== 'status') return;
    if (event.status.state !== 'ready') {
      // The connection's sync, its failures and its retry end with it (a new connection owes nothing to the previous one's failures).
      generation += 1;
      running = false;
      // The next connection's attach is the full sync; a refresh still owed to the one that ended is not asked again of it.
      refresh = false;
      failures = 0;
      retryDelay = SYNC_RETRY_MS;
      clearTimeout(retry);
      retry = undefined;
      for (const done of [...waiting]) done(false);
      waiting.clear();
      return;
    }
    if (everSynced) syncedNow = appOpen || open.size > 0 ? waitAttached().then(() => synced(true)) : Promise.resolve(synced(true));
    pump();
  });

  return {
    set(threadIds) {
      wanted = [...new Set(threadIds)];
      const target = new Set([...wanted, ...restored]);
      const unchanged = appOpen && completed === requested && target.size === open.size && [...target].every((id) => open.has(id));
      return unchanged ? Promise.resolve(true) : request();
    },
    resync() {
      refresh = true;
      return request();
    },
    // The connection's first (or re-attach) sync, then whatever the page asked since: a resync or a changed view in flight holds the caller
    // until it completes, retries included (Node: ready() waits for completed === requested, remote-view-sync.ts:67-70). A connection that
    // ends meanwhile hands the caller to the next one's sync.
    async synced() {
      for (;;) {
        await syncedNow;
        if (completed === requested || !live()) return;
        if (await new Promise<boolean>((resolve) => waiting.add(resolve))) return;
      }
    },
    stop: offStatus,
  };
}