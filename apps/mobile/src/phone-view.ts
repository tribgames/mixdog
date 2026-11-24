// What the phone has open on the core: the threads its panes show, plus the app feed. A thread is subscribed with `thread/resume` and dropped with `thread/unsubscribe`.
import type {
  ClientEvent,
  ProtocolClient,
  SessionFold,
  StoreChange,
} from '../../../packages/protocol-client/src/index.ts';
import { armCallWatch } from '../../desktop/src/renderer/remote-shim-call-watch.ts';
import { remoteConnectionInterruptedError } from '../../desktop/src/renderer/remote-connection-state.ts';
import { createViewSync } from './phone-view-sync.ts';
import { firstFrame, scopeClient } from './phone-send-scope.ts';

/** Threads open per pane: the same window `thread/resume` is asked for everywhere on the phone. */
export const VIEW_WINDOW = { lastItems: 50 } as const;

/** The desktop lane's `STRAY_FOLLOW_RELEASE_MS` (shared/core-lanes/service-route.ts): how long a thread followed outside the view may stay. */
export const STRAY_FOLLOW_RELEASE_MS = 60_000;

const APP_FEED = 'app';

/** Opened once; or shut, which rejects what waits on it (its own rejection is never left unhandled). */
function newGate() {
  let settle!: () => void;
  let shut!: (error: Error) => void;
  let isOpen = false;
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    shut = reject;
  });
  promise.catch(() => undefined);
  return {
    promise,
    open: () => {
      isOpen = true;
      settle();
    },
    shut,
    isOpen: () => isOpen,
  };
}

function threadGone(error: unknown): boolean {
  const detail = ((error as { detail?: unknown } | null)?.detail ?? error) as {
    kind?: string;
    reason?: string;
    data?: { reason?: string };
  } | null;
  return detail?.kind === 'rpc' && (detail.reason === 'threadNotFound' || detail.data?.reason === 'threadNotFound');
}

export type ViewClient = Pick<
  ProtocolClient<SessionFold>,
  'resumeThread' | 'unsubscribeThread' | 'subscribeApp' | 'confirmFeeds' | 'status' | 'on'
> & {
  readonly store: Pick<ProtocolClient<SessionFold>['store'], 'subscribe'>;
};

export interface ViewManager {
  /** The page names the threads it shows. Resolves true once they are open; rejects as interrupted when the connection ends first. */
  set(threadIds: readonly string[]): Promise<boolean>;
  /** Asks the core again for the app feed and every open thread (they resume from where they were): the page doubts the stream, e.g. after a wake. Settles like `set`. */
  resync(): Promise<boolean>;
  /** Checks continuity in one core request. False means gap recovery is needed. */
  wake(expectedFeeds?: readonly string[]): Promise<boolean>;
  /** The gate of what needs only the app feed (the conversation list): the connection's app subscription is attached, whatever its
   *  threads are doing. Rejects as interrupted when the connection ends first. */
  appSynced(): Promise<void>;
  /** The gate of the app's calls: a caller that arrives while no connection is up waits for the next one; then it waits for everything asked of the core to be attached, retries included, and rejects as interrupted when that connection ends first. */
  synced(): Promise<void>;
  stop(): void;
}

/** Threads the client follows that the view never opened and no pane names (a prefetch from the list, a resume made to read a
 *  state or answer an approval): the library resumes each again on every reconnect and the core keeps a followed thread loaded,
 *  so one that stayed unwanted for `STRAY_FOLLOW_RELEASE_MS` is let go, as the desktop's lane does (service-route.ts).
 *  `forget` starts a thread's age over (a pane named it); `stop` ends the sweep. */
function releaseStrays(
  client: ViewClient,
  view: { wants(id: string): boolean; live(): boolean; stopped(): boolean }
): { forget(id: string): void; stop(): void } {
  const library = client as unknown as {
    threadSubscription?(threadId: string): {
      readonly followed: boolean;
      readonly held: boolean;
      readonly restoring: boolean;
    };
    readonly store: { readonly threads?: { keys(): Iterable<string> } };
  };
  // The sweep a follow was first seen unwanted at. The age is that follow's: a thread the view took meanwhile (a pane named
  // it, the view opened it) or whose subscription the library reported on starts over when it is seen unwanted again.
  const strays = new Map<string, number>();
  const offStore = client.store.subscribe((change: StoreChange) => {
    if (change.type === 'subscription') strays.delete(change.feedId);
  });
  let sweeps = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sweep = (): void => {
    if (view.stopped()) return;
    sweeps += 1;
    const followed = new Set<string>();
    if (view.live() && library.threadSubscription) {
      for (const id of library.store.threads?.keys() ?? []) {
        const subscription = library.threadSubscription(id);
        if (subscription.followed && !subscription.held && !view.wants(id)) followed.add(id);
      }
    }
    for (const id of [...strays.keys()]) if (!followed.has(id)) strays.delete(id);
    for (const id of followed) {
      const since = strays.get(id);
      if (since === undefined) strays.set(id, sweeps);
      else if (sweeps - since >= 2) {
        // The library's resume of it after a reconnect is still out: the core may attach the thread after an unsubscribe it
        // already answered, and the client would then follow nothing while the core keeps it loaded. A later sweep lets it go.
        if (library.threadSubscription?.(id).restoring) continue;
        strays.delete(id);
        void client.unsubscribeThread(id).catch(() => undefined);
      }
    }
    arm();
  };
  const arm = (): void => {
    timer = setTimeout(sweep, STRAY_FOLLOW_RELEASE_MS / 2);
    // Node's test runner: the sweep keeps no process alive.
    (timer as { unref?(): void }).unref?.();
  };
  arm();
  return {
    forget: (id) => void strays.delete(id),
    stop: () => {
      clearTimeout(timer);
      offStore();
    },
  };
}

export function createViewManager(
  client: ViewClient,
  options: {
    /** Threads of the last visit: opened with the first connection, whatever the panes name first. */
    restored: readonly string[];
    /** Threads the page names now, which the first sync reads. */
    wanted: readonly string[];
    /** Called each time everything asked of the core has been attached. */
    onSynced(): void;
    /** A sync of the view began on the connection that is up (a change of the view, a resync): the indicator shows it until `onSynced`. */
    syncing(): void;
    /** A sync failed (it is retried). */
    error(error: unknown): void;
    /** The connection is alive but cannot sync: replace it. */
    recycle(): void;
    /** A sync overdue is probed like any call. */
    probe(): void;
    /** Nothing arrived since a call was sent and no probe is out (the silent-call probe's condition). */
    silentSince(since: number): boolean;
  }
): ViewManager {
  const open = new Set<string>();
  let wanted: readonly string[] = [...new Set(options.wanted)];
  let restored = [...options.restored];
  // Threads the core answered `threadNotFound` for (deleted on the PC): no sync asks for them again until the page names one anew.
  const gone = new Set<string>();
  let appOpen = false;
  let refresh = false;
  // The library's re-attachment of what was open on the connection that is up: owed by every sync until each restore was answered,
  // so a retry after a failed sync waits for the same restores instead of taking the feeds as attached.
  let reattach: Promise<void> | undefined;
  let cancelReattach: (() => void) | undefined;
  // Which connection a sync ran on: a refresh that failed because its connection ended is not owed to the next one.
  let connection = 0;
  // A connection is live for the view once its sync is open, not merely once the client is ready (the first sync opens a turn later).
  let opened = false;
  let stopped = false;
  const live = (): boolean => opened;
  const readyWaiters = new Set<() => void>();
  const target = (): Set<string> => new Set([...wanted, ...restored].filter((id) => !gone.has(id)));
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
          if (change.feedId !== APP_FEED && threadGone(change.error)) gone.add(change.feedId);
          else refused ??= change.error;
        }
        if (pending.size === 0) finish();
      });
      cancelReattach = () => {
        off();
        reject(remoteConnectionInterruptedError());
      };
      if (pending.size === 0) finish();
    });
  };

  const strays = releaseStrays(client, {
    wants: (id) => target().has(id) || open.has(id),
    live,
    stopped: () => stopped,
  });

  // The app feed's attach of the connection that is up, apart from its threads': the list needs nothing else.
  let appGate = newGate();
  let watchApp: (() => void) | undefined;

  /** `c` is the sync's own client: the frames it writes carry this sync's claim, whichever connection they end up on. The app feed and
   *  every thread go out together, one request per feed (so each feed's order is its own); a thread's resume joins one the page already
   *  has in flight rather than replacing it. */
  const attach = async (force: boolean, c: ViewClient, signal: AbortSignal): Promise<void> => {
    const want = target();
    const gate = appGate;
    const sent: Array<Promise<void>> = [];
    if (!appOpen || force) {
      sent.push(
        c.subscribeApp().then(() => {
          appOpen = true;
          gate.open();
        })
      );
    } else gate.open();
    for (const id of [...open]) {
      if (want.has(id)) continue;
      open.delete(id);
      sent.push(c.unsubscribeThread(id));
    }
    for (const id of want) {
      if (open.has(id) && !force) continue;
      sent.push(
        c.resumeThread(id, VIEW_WINDOW, { ...(force ? { force: true } : { join: true }), follow: true, signal }).then(
          () => {
            open.add(id);
          },
          (error: unknown) => {
            // A thread deleted on the PC is gone, not a failed sync: the rest is delivered.
            if (!threadGone(error)) throw error;
            gone.add(id);
            open.delete(id);
            restored = restored.filter((kept) => kept !== id);
          }
        )
      );
    }
    const outcomes = await Promise.allSettled(sent);
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  };

  const inFlight = new Map<number, true>();
  let syncId = 0;
  const timers = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  };
  // The sync request is a call like any other: its deadline starts when it is sent, and an overdue one probes the connection before it times out.
  const underDeadline = <T>(run: (c: ViewClient, signal: AbortSignal) => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++syncId;
      inFlight.set(id, true);
      // The watch's failure ends the client's waits it covers, too.
      const ended = new AbortController();
      const failed = (error: Error): void => {
        ended.abort(error);
        reject(error);
      };
      const watch = armCallWatch(inFlight, id, failed, options.probe, options.silentSince, timers);
      // This sync's own claim, carried by its own frames (the first one it writes): a reconnect between the claim and the write cannot hand the
      // frame to another sync.
      const own = scopeClient(
        client,
        firstFrame((sent) => void sent.then(watch.transmitted, () => undefined))
      );
      const done = (): void => {
        watch.cancel();
        inFlight.delete(id);
      };
      run(own, ended.signal).then(
        (value) => {
          done();
          resolve(value);
        },
        (error: unknown) => {
          done();
          reject(error);
        }
      );
    });
  const sync = createViewSync({
    synchronize: () =>
      underDeadline(async (c, signal) => {
        const force = refresh;
        const mine = connection;
        refresh = false;
        try {
          const owed = reattach;
          if (owed) {
            try {
              await owed;
            } finally {
              // Answered, or refused (the refused feeds were dropped and are attached anew below); still owed otherwise.
              if (reattach === owed) reattach = undefined;
            }
          }
          // A sync its watch already failed attaches nothing: the retry does.
          if (signal.aborted) throw signal.reason;
          await attach(force, c, signal);
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

  // A caller that finds no connection up waits for the next one.
  const connected = async (): Promise<void> => {
    while (!live() && !stopped) await new Promise<void>((resolve) => readyWaiters.add(resolve));
    if (stopped) throw remoteConnectionInterruptedError();
  };
  const begin = (): void => {
    connection += 1;
    opened = true;
    reattach = appOpen || open.size > 0 ? reattached() : undefined;
    reattach?.catch(() => undefined);
    appGate = newGate();
    // What the library restores on its own: the app feed is attached again once its subscription is restored, before the threads'.
    if (appOpen) {
      const gate = appGate;
      const off = client.store.subscribe((change: StoreChange) => {
        if (change.type !== 'subscription' || change.feedId !== APP_FEED || change.state !== 'restored') return;
        gate.open();
        off();
      });
      watchApp = off;
    }
    sync.open();
    for (const wake of [...readyWaiters]) wake();
    readyWaiters.clear();
  };
  // The first connection's sync leaves a turn after the connection resolved, so the
  // reads that need no sync -- sent by the callers the connection wakes -- are on the wire before it.
  let firstTurn: ReturnType<typeof setTimeout> | undefined;
  const offStatus = client.on((event: ClientEvent) => {
    if (event.type !== 'status') return;
    clearTimeout(firstTurn);
    if (event.status.state !== 'ready') {
      connection += 1;
      opened = false;
      watchApp?.();
      watchApp = undefined;
      appGate.shut(remoteConnectionInterruptedError());
      cancelReattach?.();
      cancelReattach = undefined;
      reattach = undefined;
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
      for (const id of wanted) strays.forget(id);
      for (const id of [...gone]) if (!wanted.includes(id)) gone.delete(id);
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
      if (appGate.isOpen()) appGate = newGate();
      await sync.request();
      return true;
    },
    async wake(expectedFeeds = []) {
      if (!live()) return true;
      const mine = connection;
      try {
        await sync.ready();
        if (mine !== connection) return true;
        // Under the watch of the sync it checks: an unanswered check fails as that watch does, which recovers the leg.
        const confirmed = await underDeadline((c) => c.confirmFeeds([APP_FEED, ...open, ...expectedFeeds]));
        return mine !== connection || confirmed;
      } catch (error) {
        if (mine !== connection) return true;
        throw error;
      }
    },
    async appSynced() {
      await connected();
      await appGate.promise;
    },
    async synced() {
      await connected();
      await sync.ready();
    },
    stop() {
      stopped = true;
      for (const wake of readyWaiters) wake();
      readyWaiters.clear();
      clearTimeout(firstTurn);
      strays.stop();
      watchApp?.();
      appGate.shut(remoteConnectionInterruptedError());
      offStatus();
      cancelReattach?.();
      sync.close();
    },
  };
}
