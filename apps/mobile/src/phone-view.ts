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
  /** The page names the threads it shows. Resolves true once they are open; false asks the caller to ask again. */
  set(threadIds: readonly string[]): Promise<boolean>;
  /** Asks the core again for the app feed and every open thread (they resume from where they were): the page doubts the stream, e.g. after a wake. */
  resync(): Promise<boolean>;
  /** Resolves when the connection that is up has the app feed and every open thread attached. */
  synced(): Promise<void>;
  stop(): void;
}

export function createViewManager(
  client: ViewClient,
  options: {
    /** Threads of the last visit: opened with the first connection, whatever the panes name first. */
    restored: readonly string[];
    /** Called each time everything asked of the core has been attached (the first connection included); reconnected when a new connection did it. */
    onSynced(reconnected: boolean): void;
    /** A sync of the view began on the connection that is up (a change of the view, a resync): the indicator shows it until onSynced. */
    syncing(): void;
  }
): ViewManager {
  const open = new Set<string>();
  let wanted: readonly string[] = [];
  let restored = [...options.restored];
  let appOpen = false;
  let chain: Promise<unknown> = Promise.resolve();
  let firstSynced: () => void = () => undefined;
  let syncedNow: Promise<void> = new Promise<void>((resolve) => {
    firstSynced = resolve;
  });
  let everSynced = false;
  let running = 0;
  const live = (): boolean => client.status.state === 'ready';
  const begin = (): void => {
    running += 1;
    if (live()) options.syncing();
  };
  const end = (ok: boolean): void => {
    running -= 1;
    if (ok && running === 0 && live()) synced(false);
  };
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

  // A new connection: the library re-attaches what was open; this connection is synced when all of it is back.
  const offStatus = client.on((event: ClientEvent) => {
    if (event.type !== 'status' || event.status.state !== 'ready' || !everSynced) return;
    syncedNow = appOpen || open.size > 0 ? waitAttached().then(() => synced(true)) : Promise.resolve(synced(true));
  });

  const apply = async (): Promise<boolean> => {
    const target = new Set([...wanted, ...restored]);
    const changed = !appOpen || target.size !== open.size || [...target].some((id) => !open.has(id));
    if (changed) begin();
    try {
      if (!appOpen) {
        await client.subscribeApp();
        appOpen = true;
      }
      for (const id of [...open]) {
        if (target.has(id)) continue;
        open.delete(id);
        await client.unsubscribeThread(id);
      }
      for (const id of target) {
        if (open.has(id)) continue;
        await client.resumeThread(id, VIEW_WINDOW);
        open.add(id);
      }
    } catch {
      if (changed) end(false);
      return false;
    }
    restored = [];
    if (changed) end(true);
    return true;
  };
  const resync = async (): Promise<boolean> => {
    begin();
    try {
      await client.subscribeApp();
      for (const id of [...open]) await client.resumeThread(id, VIEW_WINDOW);
    } catch {
      end(false);
      return false;
    }
    end(true);
    return true;
  };

  return {
    set(threadIds) {
      wanted = [...new Set(threadIds)];
      const run = chain.then(apply, apply);
      chain = run;
      return run;
    },
    resync() {
      const run = chain.then(resync, resync);
      chain = run;
      return run;
    },
    synced: () => syncedNow,
    stop: offStatus,
  };
}
