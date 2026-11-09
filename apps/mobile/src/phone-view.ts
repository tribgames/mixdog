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
  /** Resolves when the connection that is up has the app feed and every open thread attached. */
  synced(): Promise<void>;
  stop(): void;
}

export function createViewManager(
  client: ViewClient,
  options: {
    /** Threads of the last visit: opened with the first connection, whatever the panes name first. */
    restored: readonly string[];
    /** Called each time a connection finished attaching (the first one included). */
    onSynced(reconnected: boolean): void;
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
      return false;
    }
    restored = [];
    if (!everSynced) synced(false);
    return true;
  };

  return {
    set(threadIds) {
      wanted = [...new Set(threadIds)];
      const run = chain.then(apply, apply);
      chain = run;
      return run;
    },
    synced: () => syncedNow,
    stop: offStatus,
  };
}
