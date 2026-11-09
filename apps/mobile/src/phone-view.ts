// What the phone has open on the core: the threads its panes show, plus the app feed. This replaces Node's `setVisibleSessions` /
// `synchronizeViews` pair. A thread is subscribed with `thread/resume` and dropped with `thread/unsubscribe`.
//
// The state machine that decides when the app's calls may leave is Node's, ported whole (phone-view-sync.ts): this file only says what one
// "sync" is in the protocol's dialect -- the app feed and every wanted thread attached on the connection that is up -- and tells the machine
// when a connection began and ended. Nothing else (no subscription event, no status of the client) opens or closes the gate.
//
// On a reconnect the client library re-attaches what was open on its own (`app/subscribe`, `thread/resume` with `resumeFrom`); that re-attachment
// is the first sync of the new connection: it succeeds only when every one of them was restored, and a refusal (`state: 'lost'`) fails it, so
// the machine retries on its backoff -- with this file's own attach, which re-subscribes what the refusal dropped -- and recycles the connection
// after three failures in a row, exactly as for a refused resync.
import type { ClientEvent, ProtocolClient, SessionFold, StoreChange } from '../../../packages/protocol-client/src/index.ts';
import { armCallWatch } from '../../desktop/src/renderer/remote-shim-call-watch.ts';
import { remoteConnectionInterruptedError } from '../../desktop/src/renderer/remote-connection-state.ts';
import { createViewSync } from './phone-view-sync.ts';

/** Threads open per pane: the same window `thread/resume` is asked for everywhere on the phone. */
export const VIEW_WINDOW = { lastItems: 50 } as const;

const APP_FEED = 'app';

export type ViewClient = Pick<ProtocolClient<SessionFold>, 'resumeThread' | 'unsubscribeThread' | 'subscribeApp' | 'status' | 'on'> & {
  readonly store: Pick<ProtocolClient<SessionFold>['store'], 'subscribe'>;
};

export interface ViewManager {
  /** The page names the threads it shows. Resolves true once they are open; rejects as interrupted when the connection ends first (Node: viewSync.close() rejects its waiters, remote-view-sync.ts:97). */
  set(threadIds: readonly string[]): Promise<boolean>;
  /** Asks the core again for the app feed and every open thread (they resume from where they were): the page doubts the stream, e.g. after a wake. Settles like `set`. */
  resync(): Promise<boolean>;
  /** The gate of the app's calls (Node: `viewSync.ready()` after `connect()`): a caller that arrives while no connection is up waits for the next one; then it waits for everything asked of the core to be attached, retries included, and rejects as interrupted when that connection ends first. */
  synced(): Promise<void>;
  stop(): void;
}

export function createViewManager(
  client: ViewClient,
  options: {
    /** Threads of the last visit: opened with the first connection, whatever the panes name first. */
    restored: readonly string[];
    /** Threads the page names now (Node: ctx.lastVisibleSessionIds, which the first sync reads). */
    wanted: readonly string[];
    /** Called each time everything asked of the core has been attached (Node: createRemoteViewSync's `state('connected')`). */
    onSynced(): void;
    /** A sync of the view began on the connection that is up (a change of the view, a resync): the indicator shows it until `onSynced`. */
    syncing(): void;
    /** A sync failed (it is retried). */
    error(error: unknown): void;
    /** The connection is alive but cannot sync: replace it. */
    recycle(): void;
    /** A sync overdue is probed like any call (Node: invoke('synchronizeViews') arms the call deadline, remote-shim-calls.ts:239). */
    probe(): void;
    /** Nothing arrived since a call was sent and no probe is out (the silent-call probe's condition). */
    silentSince(since: number): boolean;
    /** Resolves when the next request frame has left this page. */
    nextRequestSent(): Promise<void>;
  }
): ViewManager {
  const open = new Set<string>();
  let wanted: readonly string[] = [...new Set(options.wanted)];
  let restored = [...options.restored];
  let appOpen = false;
  let refresh = false;
  // The connection that is up began with the library re-attaching what was open: its first sync is that re-attachment's outcome.
  let reattach = false;
  let cancelReattach: (() => void) | undefined;
  // Which connection a sync ran on: a refresh that failed because its connection ended is not owed to the next one.
  let connection = 0;
  // A connection is live for the view once its sync is open, not merely once the client is ready (the first sync opens a turn later).
  let opened = false;
  const live = (): boolean => opened;
  const readyWaiters = new Set<() => void>();
  const target = (): Set<string> => new Set([...wanted, ...restored]);
  const keyOf = (ids: Iterable<string>): string => JSON.stringify([...new Set(ids)].sort());
  let requestedKey = keyOf(target());

  /** Resolves when every feed the library is restoring on this connection was restored; rejects with the refusal of a `lost` one (after noting the loss). */
  const reattached = (): Promise<void> => {
    const pending = new Set<string>([...(appOpen ? [APP_FEED] : []), ...open]);
    let refused: unknown;
    return new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        off();
        cancelReattach = undefined;
        if (refused === undefined) resolve();
        else reject(refused);
      };
      const off = client.store.subscribe((change: StoreChange) => {
        if (change.type !== 'subscription' || !pending.delete(change.feedId)) return;
        if (change.state === 'lost') {
          if (change.feedId === APP_FEED) appOpen = false;
          else open.delete(change.feedId);
          refused ??= change.error;
        }
        if (pending.size === 0) finish();
      });
      cancelReattach = off;
      if (pending.size === 0) finish();
    });
  };

  const attach = async (force: boolean): Promise<void> => {
    const want = target();
    if (!appOpen || force) {
      await client.subscribeApp();
      appOpen = true;
    }
    for (const id of [...open]) {
      if (want.has(id)) continue;
      open.delete(id);
      await client.unsubscribeThread(id);
    }
    for (const id of want) {
      if (open.has(id) && !force) continue;
      await client.resumeThread(id, VIEW_WINDOW);
      open.add(id);
    }
  };

  const inFlight = new Map<number, true>();
  let syncId = 0;
  const timers = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  };
  // The sync request is a call like any other: its deadline starts when it is sent, and an overdue one probes the connection before it times out.
  const underDeadline = <T>(run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++syncId;
      inFlight.set(id, true);
      const watch = armCallWatch(inFlight, id, reject, options.probe, options.silentSince, timers);
      void options.nextRequestSent().then(watch.transmitted);
      const done = (): void => {
        watch.cancel();
        inFlight.delete(id);
      };
      run().then(
        (value) => (done(), resolve(value)),
        (error: unknown) => (done(), reject(error))
      );
    });
  const sync = createViewSync({
    synchronize: () =>
      underDeadline(async () => {
      const force = refresh;
      const mine = connection;
      refresh = false;
      try {
        if (reattach) {
          reattach = false;
          await reattached();
        }
        await attach(force);
      } catch (error) {
        if (force && mine === connection) refresh = true;
        throw error;
      }
      restored = [];
      }),
    state: (state) => {
      if (state === 'syncing') return options.syncing();
      options.onSynced();
    },
    error: options.error,
    interrupted: remoteConnectionInterruptedError,
    recycle: options.recycle,
  });

  // Node's `connect()`: a caller that finds no connection up waits for the next one.
  const connected = async (): Promise<void> => {
    while (!live()) await new Promise<void>((resolve) => readyWaiters.add(resolve));
  };
  const begin = (): void => {
    connection += 1;
    opened = true;
    reattach = appOpen || open.size > 0;
    sync.open();
    for (const wake of [...readyWaiters]) wake();
    readyWaiters.clear();
  };
  // The first connection's sync leaves a turn after the connection resolved (Node: its preparation awaits, remote-shim-sync.ts:60-66), so the
  // reads that need no sync -- sent by the callers the connection wakes -- are on the wire before it.
  let firstTurn: ReturnType<typeof setTimeout> | undefined;
  const offStatus = client.on((event: ClientEvent) => {
    if (event.type !== 'status') return;
    clearTimeout(firstTurn);
    if (event.status.state !== 'ready') {
      connection += 1;
      opened = false;
      cancelReattach?.();
      cancelReattach = undefined;
      // A refresh still owed to the connection that ended is not asked again of the next one: its first sync is the full one.
      refresh = false;
      sync.close();
      return;
    }
    begin();
  });
  if (client.status.state === 'ready') firstTurn = setTimeout(begin, 0);

  return {
    async set(threadIds) {
      wanted = [...new Set(threadIds)];
      await connected();
      const key = keyOf(target());
      // Already named by the latest sync: wait for it instead of asking again (remote-shim-api.ts:306-307).
      if (key === requestedKey) await sync.ready();
      else {
        requestedKey = key;
        await sync.request();
      }
      return true;
    },
    async resync() {
      if (!live()) return true;
      refresh = true;
      await sync.request();
      return true;
    },
    async synced() {
      await connected();
      await sync.ready();
    },
    stop() {
      clearTimeout(firstTurn);
      offStatus();
      cancelReattach?.();
      sync.close();
    },
  };
}