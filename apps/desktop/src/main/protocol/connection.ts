// The one protocol connection of this Electron process to one core (a target: this PC's core, or a server's
// through its SSH tunnel). Main owns the socket and the client library's fold store; windows get the pushed
// sections mirrored (section-relay.ts) and call the closed list of detail methods (window-ipc.ts). Nothing here
// polls: state arrives as sections, liveness is the connection's own ticker (protocol.md §4.7).
import type {
  DesktopProtocolStatus,
  DesktopSectionChange,
  DesktopSectionEntry,
  DesktopSectionsPush,
  DesktopSectionsSnapshot,
} from '../../shared/contract-sections';
import { SECTION_NAMES } from '../../shared/contract-sections';
import { createSectionRelay, type RelayedStore, type SectionRelay } from './section-relay';
import { loginFeedId, loginUpdateOf, LOGIN_CANCEL_METHODS, LOGIN_START_METHODS } from './login-feed';
import { scopedSectionChanges, type ScopedFeedRoute } from './scoped-sections';

export { SECTION_NAMES };

/** `client/activity` is sent at most once per this long (desktop-services.md §12.3: rate limit is client-side). */
export const CLIENT_ACTIVITY_MIN_GAP_MS = 60_000;

/** The most sign-in flow feeds one connection keeps once flows have ended; the oldest ended one is let go first. A
 *  flow still pending (or whose first frame has not arrived) is never let go: Node's status read answered for any
 *  live flow, and a dialog waiting on it would never be told. */
export const MAX_FOLLOWED_LOGINS = 32;

/** A held login state that has left `pending` (complete, failed, cancelled, expired): nothing more will arrive. */
const isFinalLoginState = (state: unknown): boolean => {
  const name = (state as { state?: unknown } | null)?.state;
  return typeof name === 'string' && name !== 'pending';
};

/** What the connection needs from the client library's `ProtocolClient`. */
export interface ConnectionClient {
  readonly store: RelayedStore;
  readonly status: { readonly state: string };
  call(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  subscribeApp(): Promise<void>;
  /** `thread/resume` as the library sends it: the thread is folded from then on and resumed again after a reconnect. */
  resumeThread(threadId: string, window: unknown): Promise<unknown>;
  /** `thread/unsubscribe`; the library drops the thread's fold. */
  unsubscribeThread(threadId: string): Promise<void>;
  respond(id: string | number, answer: ServerRequestAnswer): void;
  /** The server requests this client's core is waiting on: added when it asks, removed when it resolves the ask, all
   *  dropped with the socket. */
  pendingServerRequests(): ReadonlyArray<{ readonly id: string | number; readonly method: string; readonly params: unknown }>;
  /** One binary X17 frame; present when the library's transport supports the host media lane. */
  sendBinary?(frame: Uint8Array): void;
  on(listener: (event: ConnectionClientEvent) => void): () => void;
  close(): Promise<void>;
}

export type ServerRequestAnswer =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };

export type ConnectionClientEvent =
  | { readonly type: 'status'; readonly status: { readonly state: string } }
  | {
      readonly type: 'notification';
      readonly notification: { readonly method: string; readonly params?: unknown; readonly feed?: { readonly id: string } };
    }
  | { readonly type: 'serverRequest'; readonly request: { readonly id: string | number; readonly method: string; readonly params: unknown } }
  | { readonly type: 'serverRequestResolved'; readonly params: { readonly requestId?: string | number } }
  | { readonly type: string };

/** A change of the open client's store (the library's `StoreChange`): a folded thread, a section, the app snapshot, a
 *  subscription restored or lost. */
export interface ConnectionStoreChange {
  readonly type: string;
  readonly threadId?: string;
  readonly section?: string;
  readonly key?: string | null;
  readonly feedId?: string;
  readonly state?: string;
}

export interface ProtocolConnectionOptions {
  /** Opens the transport and performs `initialize`; the library's `connect` bound to this target. */
  open(): Promise<ConnectionClient>;
  defer?(flush: () => void): void;
}

/** A window of this connection: where pushes are delivered. */
export interface ProtocolWindow {
  push(push: DesktopSectionsPush): void;
  /** A scoped-feed notification of this connection (`fs/changed`, `system/ports/updated`). */
  notification(method: string, params: unknown): void;
  /** The feed of a sign-in flow this connection followed can no longer deliver (it could not be subscribed, or the
   *  link went down): the flow's progress will not arrive. */
  loginFeedLost(flowId: string): void;
}

/** What the connection holds of a followed sign-in flow's feed. */
export interface LoginFeedState {
  /** The last state the feed delivered; null before the first frame. */
  state: unknown;
  lost: boolean;
}

export interface ProtocolConnection {
  start(): Promise<void>;
  /** Replaces the client with a new one opened against the endpoint as it is now (the client library's terminal
   *  states, a refused version or a closed client, end its redial loop for good; a dial that follows the user's
   *  reconnect or a restarted core must not reuse it). The windows, watches and port views stay; they are sent the
   *  new client's whole store and the scoped feeds again. Rejects with the handshake's own error. A reopen while
   *  another is in flight supersedes it: the older one's client is closed unused and its caller gets the newest
   *  reopen's outcome. The followed sign-in flows end as lost (their feeds do not survive the client). */
  reopen(): Promise<void>;
  /** The user's reconnect: leaves a live (`ready`) client alone, joins a start or reopen in flight, and otherwise
   *  reopens. A client the automatic recovery restored meanwhile is neither closed nor its calls rejected. */
  ensureOpen(): Promise<void>;
  /** Called after a reopen has attached the new client: whatever a caller subscribed through `call` (the resumed
   *  threads) belongs to the old client and is sent again here. Returns the removal. */
  onReplaced(listener: () => void): () => void;
  readonly status: DesktopProtocolStatus;
  snapshot(): DesktopSectionsSnapshot;
  /** Settles when the connect handshake (`start`: open, `initialize`, the app subscription) has folded the first
   *  snapshot: resolved then, rejected with the handshake's own error when it failed. A read of the held sections
   *  issued before that waits here; there is no timeout of its own. */
  whenSynced(): Promise<void>;
  /** Registers a window; returns its removal. A window attached after `start` is told the current status. */
  attach(window: ProtocolWindow): () => void;
  call(method: string, params: unknown): Promise<unknown>;
  /** The client that is open now: what folds the threads this connection follows (the session lane reads a thread's
   *  state from it). Null while none is open. */
  client(): ConnectionClient | null;
  /** Follows a thread through the library (`ConnectionClient.resumeThread`). A `thread/resume` sent with `call` is not
   *  folded: the library drops the feed of a thread it was not asked to follow. */
  resumeThread(threadId: string, window: unknown): Promise<unknown>;
  unsubscribeThread(threadId: string): Promise<void>;
  /** Every change of the open client's store, whichever client that is: the listeners stay across a reopen. Returns
   *  the removal. */
  onStoreChange(listener: (change: ConnectionStoreChange) => void): () => void;
  /** The core samples listening ports only while someone views them (U-DS4): the first viewer subscribes, the last
   *  one leaving unsubscribes. After a reconnect the subscription is sent again while viewers remain. */
  viewPorts(window: ProtocolWindow, viewing: boolean): Promise<void>;
  /** `fs/watch` for `window`: its owner is recorded before the request goes out, so the watch is released with the
   *  window even when the answer is late, and it is sent again after a reconnect. `params.watchId` is unique per
   *  connection. A failed request forgets the watch. */
  watchFiles(window: ProtocolWindow, params: { watchId: string } & Record<string, unknown>): Promise<unknown>;
  unwatchFiles(watchId: string): Promise<unknown>;
  /** `feed/subscribe` of a scoped feed that carries sections (`media:<jobId>`) for `window`. What the feed delivers reaches
   *  every window watching it as ordinary section changes, so the window's mirror holds it like an app section; a window
   *  that starts watching a feed another one already holds is given what the feed holds now. The first watcher subscribes
   *  and the last one leaving unsubscribes; the feeds are sent again after a reconnect. `absent`: the core has no such feed
   *  (a job it no longer holds). Any other failure of the request rejects. */
  watchFeed(window: ProtocolWindow, feedId: string): Promise<{ absent: boolean }>;
  /** The window stops watching: the sections the feed held are removed from its mirror. */
  unwatchFeed(window: ProtocolWindow, feedId: string): Promise<void>;
  /** The feed of a sign-in flow this connection started (`call` of a login start subscribes `login:<flowId>`): what it
   *  last delivered, and whether it was lost. A window reads it when it starts to listen, so a frame or a loss that
   *  came before its listener is not missed. A flow this connection does not follow has no feed: lost. */
  loginFeed(flowId: string): LoginFeedState;
  /** Main's own read of a section (the computer pill, nothing in a window): called with the current entry after each
   *  change of `section`, `undefined` once removed. Valid before and after `start`. */
  watchSection(section: string, listener: (entry: DesktopSectionEntry | undefined) => void): () => void;
  /** Raw client events for the host role (server requests and non-section notifications). Returns the removal. */
  onEvent(listener: (event: ConnectionClientEvent) => void): () => void;
  notify(method: string, params: unknown): void;
  respond(id: string | number, answer: ServerRequestAnswer): void;
  /** What the live client's core is asking now; none while no client is open. The set belongs to the client, so a
   *  request of a closed or replaced client is never in it and an answer never crosses clients. */
  pendingServerRequests(): ReturnType<ConnectionClient['pendingServerRequests']>;
  sendBinary(frame: Uint8Array): void;
  /** The user operated this app (`input` event). Sends `client/activity` unless one went out within the minute. */
  noteUserInput(at: number): void;
  close(): Promise<void>;
}

/** The core answers `invalidParams` for a feed it does not hold; every other failure is the request's own. */
const isAbsentFeed = (error: unknown): boolean => {
  const detail = (error as { detail?: { kind?: unknown; data?: { reason?: unknown } } } | null)?.detail;
  return detail?.kind === 'rpc' && detail.data?.reason === 'invalidParams';
};

const toStatus =(state: string): DesktopProtocolStatus =>
  state === 'ready' ? 'ready' : state === 'closed' ? 'closed' : 'reconnecting';

export function createProtocolConnection({ open, defer }: ProtocolConnectionOptions): ProtocolConnection {
  const windows = new Set<ProtocolWindow>();
  const portViewers = new Set<ProtocolWindow>();
  const eventListeners = new Set<(event: ConnectionClientEvent) => void>();
  const storeListeners = new Set<(change: ConnectionStoreChange) => void>();
  const sectionWatchers = new Map<string, Set<(entry: DesktopSectionEntry | undefined) => void>>();
  const fsWatches = new Map<string, { window: ProtocolWindow; params: { watchId: string } & Record<string, unknown> }>();
  // Scoped feeds that carry sections, by feed id: who watches them and the sections each holds.
  const feedWatches = new Map<string, ScopedFeedRoute>();
  // Set when the link came back: the windows' whole store is replaced once the restored app subscription's snapshot
  // has been folded and swapped in (`appSnapshot` comes last; the section changes before it announce the removed
  // sections too).
  let awaitingAppSnapshot = false;
  let unsubscribeStore: (() => void) | null = null;
  let client: ConnectionClient | null = null;
  let relay: SectionRelay | null = null;
  let status: DesktopProtocolStatus = 'reconnecting';
  let closedByOwner = false;
  // The owner of the client's lifetime is the newest open or reopen: every client it opened, and every handler of
  // that client, checks it still holds this number before it touches anything here.
  let epoch = 0;
  let newest: Promise<void> | null = null;
  // The start or reopen that has not settled yet; `ensureOpen` joins it instead of opening another client.
  let inflight: Promise<void> | null = null;
  const track = (run: Promise<void>): Promise<void> => {
    inflight = run;
    const settled = (): void => {
      if (inflight === run) inflight = null;
    };
    run.then(settled, settled);
    return run;
  };
  const replacedListeners = new Set<() => void>();
  let lastActivityAt = Number.NEGATIVE_INFINITY;
  let unsubscribeClient: (() => void) | null = null;
  let resolveSynced!: () => void;
  let rejectSynced!: (error: unknown) => void;
  let synced!: Promise<void>;
  let syncedSettled = true;
  /** One promise per handshake: a failed one stays rejected for its readers, the next handshake gets a fresh one. */
  const pendingSync = (): void => {
    if (!syncedSettled) return;
    syncedSettled = false;
    synced = new Promise<void>((resolve, reject) => {
      resolveSynced = resolve;
      rejectSynced = reject;
    });
    // A failed handshake reaches every reader that awaits `whenSynced`; one nobody awaits must not be an unhandled rejection.
    synced.catch(() => undefined);
  };
  // True once a handshake has completed: from then on a missing client is a link that went down (calls fail at once,
  // the status says reconnecting), not a connection that has not been opened yet.
  let everOpened = false;
  const settleSynced = (error?: unknown): void => {
    syncedSettled = true;
    if (error === undefined) everOpened = true;
    if (error === undefined) resolveSynced();
    else rejectSynced(error);
  };
  pendingSync();

  const broadcast = (push: DesktopSectionsPush): void => {
    for (const window of [...windows]) window.push(push);
  };
  const connected = (): ConnectionClient => {
    if (!client) throw new Error('The core connection is not open.');
    return client;
  };
  /** The client for a request that may arrive before the first connection is open (a window's first calls come while
   *  the core is still starting): it waits for that first handshake, and fails with its error if that fails. */
  const connectedAfterFirstOpen = async (): Promise<ConnectionClient> => {
    if (!client && !everOpened && !closedByOwner) await synced;
    return connected();
  };
  const unwatchQuietly = (watchId: string): void => {
    fsWatches.delete(watchId);
    // Best effort: a link that is down ends its watches by itself.
    if (client) void client.call('fs/unwatch', { watchId }).catch(() => undefined);
  };
  /** The scoped feeds do not survive the socket: send again what live owners still want. */
  const restoreScopedFeeds = (restored: ConnectionClient): void => {
    for (const [watchId, { params }] of [...fsWatches]) {
      void restored.call('fs/watch', params).catch(() => void fsWatches.delete(watchId));
    }
    if (portViewers.size > 0) void restored.call('system/ports/subscribe', {}).catch(() => undefined);
    for (const feedId of [...feedWatches.keys()]) {
      void restored.call('feed/subscribe', { feedId }).catch((error: unknown) => {
        // Only a feed the core does not hold is gone; any other failure keeps what the windows hold and tells them.
        if (isAbsentFeed(error)) return dropFeed(feedId);
        const message = error instanceof Error ? error.message : String(error);
        for (const window of [...(feedWatches.get(feedId)?.windows ?? [])]) window.push({ kind: 'feedError', feedId, message });
      });
    }
  };
  /** The one place scoped state meets a replace: the windows' store is swapped for the app's, which holds no scoped
   *  section, so the held ones go into the replace itself, just before its commit, and the swap keeps them. */
  const sendWithScoped = (push: DesktopSectionsPush): void => {
    if (push.kind !== 'replace' || push.stage !== 'commit') return broadcast(push);
    for (const window of [...windows]) {
      const entries: DesktopSectionEntry[] = [];
      for (const route of feedWatches.values()) if (route.windows.has(window)) entries.push(...route.held.values());
      if (entries.length) window.push({ kind: 'replace', stage: 'chunk', entries });
      window.push(push);
    }
  };
  const removalsOf = (route: ScopedFeedRoute): DesktopSectionChange[] =>
    [...route.held.values()].map(({ section, key }) => ({ section, key, entry: null }));
  /** Forgets a feed the core no longer has and removes the sections it held from its watchers. */
  const dropFeed = (feedId: string): void => {
    const route = feedWatches.get(feedId);
    feedWatches.delete(feedId);
    if (!route) return;
    const changes = removalsOf(route);
    if (changes.length) for (const window of [...route.windows]) window.push({ kind: 'sections', changes });
  };
  const watchFeed = async (window: ProtocolWindow, feedId: string): Promise<{ absent: boolean }> => {
    const live = client ?? (await connectedAfterFirstOpen());
    const known = feedWatches.get(feedId);
    if (known) {
      known.windows.add(window);
      const changes = [...known.held.values()].map((entry) => ({ section: entry.section, key: entry.key, entry }));
      if (changes.length) window.push({ kind: 'sections', changes });
      return { absent: false };
    }
    feedWatches.set(feedId, { windows: new Set([window]), held: new Map() });
    try {
      await live.call('feed/subscribe', { feedId });
      return { absent: false };
    } catch (error) {
      feedWatches.delete(feedId);
      if (isAbsentFeed(error)) return { absent: true };
      throw error;
    }
  };
  const leaveFeed = (window: ProtocolWindow, feedId: string): ScopedFeedRoute | undefined => {
    const route = feedWatches.get(feedId);
    if (!route || !route.windows.delete(window)) return undefined;
    if (route.windows.size === 0) {
      feedWatches.delete(feedId);
      if (client) void client.call('feed/unsubscribe', { feedId }).catch(() => undefined);
    }
    return route;
  };
  // The sign-in flows this connection follows. A scoped feed reaches only its subscriber and does not survive the
  // socket, so a followed feed whose subscription failed, or whose link went down, is lost for good: the flow goes on in
  // the core, but its progress will not arrive, and the windows are told.
  const loginFeeds = new Map<string, LoginFeedState>();
  const loseLoginFeed = (flowId: string, feed: LoginFeedState): void => {
    if (feed.lost) return;
    feed.lost = true;
    for (const window of [...windows]) window.loginFeedLost(flowId);
  };
  const unfollowLogin = (flowId: string): void => {
    if (!loginFeeds.delete(flowId)) return;
    // Best effort: a link that is down ends its subscriptions by itself.
    if (client) void client.call('feed/unsubscribe', { feedId: loginFeedId(flowId) }).catch(() => undefined);
  };
  const followLogin = async (live: ConnectionClient, flowId: string): Promise<void> => {
    const feed: LoginFeedState = { state: null, lost: false };
    loginFeeds.set(flowId, feed);
    for (const [oldest, held] of [...loginFeeds]) {
      if (loginFeeds.size <= MAX_FOLLOWED_LOGINS) break;
      if (isFinalLoginState(held.state)) unfollowLogin(oldest);
    }
    try {
      await live.call('feed/subscribe', { feedId: loginFeedId(flowId) });
    } catch {
      loseLoginFeed(flowId, feed);
    }
  };
  const viewPorts = async (window: ProtocolWindow, viewing: boolean): Promise<void> => {
    const wasViewed = portViewers.size > 0;
    if (viewing) portViewers.add(window);
    else portViewers.delete(window);
    const isViewed = portViewers.size > 0;
    if (isViewed === wasViewed) return;
    await connected().call(isViewed ? 'system/ports/subscribe' : 'system/ports/unsubscribe', {});
  };

  /** Drops the current client and everything bound to it; the windows and their registrations stay. They are told
   *  `next`, since the relay that told them the client's status goes with it. The followed sign-in flows are lost:
   *  their feeds ended with the client, and unsubscribing first keeps its closing from reaching them. */
  const release = async (next: DesktopProtocolStatus): Promise<void> => {
    unsubscribeClient?.();
    unsubscribeStore?.();
    relay?.dispose();
    unsubscribeClient = null;
    unsubscribeStore = null;
    relay = null;
    awaitingAppSnapshot = false;
    for (const [flowId, feed] of loginFeeds) loseLoginFeed(flowId, feed);
    const closing = client;
    client = null;
    if (status !== next) {
      status = next;
      broadcast({ kind: 'status', status });
    }
    await closing?.close().catch(() => undefined);
  };

  /** Opens a client for the owner `mine`. False when a newer owner took over meanwhile (the client is closed). */
  const handshake = async (mine: number): Promise<boolean> => {
    const opened = await open();
    if (mine !== epoch) {
      await opened.close().catch(() => undefined);
      return false;
    }
    client = opened;
    status = toStatus(opened.status.state);
    const owns = (): boolean => mine === epoch && client === opened;
    relay = createSectionRelay({
      store: opened.store,
      sectionNames: SECTION_NAMES,
      send: sendWithScoped,
      ...(defer ? { defer } : {}),
    });
    unsubscribeStore = opened.store.subscribe((change) => {
      if (!owns()) return;
      for (const listener of [...storeListeners]) listener(change);
      // A listener may have reopened: this client is superseded then.
      if (!owns()) return;
      if (change.type === 'appSnapshot' && awaitingAppSnapshot) {
        awaitingAppSnapshot = false;
        relay?.reconnected();
        return;
      }
      // The core refused to restore the app subscription: the store keeps the previous app state whole, and no
      // snapshot is coming to wait for.
      if (change.type === 'subscription' && (change as { feedId?: string }).feedId === 'app' && (change as { state?: string }).state === 'lost') {
        awaitingAppSnapshot = false;
        return;
      }
      if (change.type !== 'section' || change.section === undefined) return;
      const entry = opened.store.section(change.section, change.key ?? null);
      for (const watcher of [...(sectionWatchers.get(change.section) ?? [])]) watcher(entry);
    });
    unsubscribeClient = opened.on((event) => {
      if (!owns()) return;
      for (const listener of [...eventListeners]) listener(event);
      // A listener may have reopened: this client is superseded then, and its event must not write over the new state.
      if (!owns()) return;
      if (event.type === 'status') {
        const next = toStatus((event as { status: { state: string } }).status.state);
        const wasReady = status === 'ready';
        status = next;
        if (next === 'ready' && !wasReady) {
          awaitingAppSnapshot = true;
          restoreScopedFeeds(opened);
        }
        if (next !== 'ready') for (const [flowId, feed] of loginFeeds) loseLoginFeed(flowId, feed);
        relay?.status(next);
      } else if (event.type === 'notification') {
        const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
        const login = loginUpdateOf(method, params);
        const followed = login ? loginFeeds.get(login.flowId) : undefined;
        if (login && followed) followed.state = login.state;
        for (const window of [...windows]) window.notification(method, params);
        const feedId = (event as { notification: { feed?: { id: string } } }).notification.feed?.id;
        const route = feedId === undefined ? undefined : feedWatches.get(feedId);
        if (route) {
          const changes = scopedSectionChanges(route, method, params);
          if (changes.length) for (const window of [...route.windows]) window.push({ kind: 'sections', changes });
        }
      }
    });
    await opened.subscribeApp();
    return mine === epoch;
  };
  /** What a caller superseded by a newer open gets: that open's outcome. */
  const supersededBy = async (): Promise<void> => {
    await newest;
  };
  const connect = async (mine: number): Promise<void> => {
    try {
      if (!(await handshake(mine))) await supersededBy();
    } catch (error) {
      if (mine !== epoch) return supersededBy();
      // A client left half-opened would make the next start believe the connection exists; nothing serves now.
      await release('closed');
      throw error;
    }
  };

  return {
    get status() {
      return status;
    },
    whenSynced: () => synced,
    start() {
      if (client) return Promise.resolve();
      if (inflight) return inflight;
      const mine = ++epoch;
      return track(
        (async (): Promise<void> => {
          try {
            await connect(mine);
          } catch (error) {
            if (mine === epoch) settleSynced(error);
            throw error;
          }
          if (mine === epoch) settleSynced();
        })()
      );
    },
    ensureOpen() {
      if (inflight) return inflight;
      if (client && status === 'ready') return Promise.resolve();
      return this.reopen();
    },
    reopen() {
      if (closedByOwner) return Promise.reject(new Error('The core connection is closed.'));
      const mine = ++epoch;
      pendingSync();
      const run = (async (): Promise<void> => {
        await release('reconnecting');
        if (mine !== epoch) return supersededBy();
        // The windows hold the old client's store: they are sent the new one once its app snapshot is folded.
        awaitingAppSnapshot = true;
        try {
          await connect(mine);
        } catch (error) {
          if (mine === epoch) settleSynced(error);
          throw error;
        }
        if (mine !== epoch) return;
        relay?.status(status);
        if (client) restoreScopedFeeds(client);
        settleSynced();
        for (const listener of [...replacedListeners]) listener();
      })();
      newest = run;
      return track(run);
    },
    onReplaced(listener) {
      replacedListeners.add(listener);
      return () => void replacedListeners.delete(listener);
    },
    snapshot: () => (relay ? relay.snapshot(status) : { status, entries: [] as DesktopSectionEntry[] }),
    attach(window) {
      windows.add(window);
      return () => {
        windows.delete(window);
        for (const [watchId, owner] of [...fsWatches]) if (owner.window === window) unwatchQuietly(watchId);
        for (const feedId of [...feedWatches.keys()]) leaveFeed(window, feedId);
        if (portViewers.has(window)) void viewPorts(window, false).catch(() => undefined);
      };
    },
    async watchFiles(window, params) {
      const live = client ?? (await connectedAfterFirstOpen());
      fsWatches.set(params.watchId, { window, params });
      try {
        return await live.call('fs/watch', params);
      } catch (error) {
        fsWatches.delete(params.watchId);
        throw error;
      }
    },
    watchFeed,
    async unwatchFeed(window, feedId) {
      const route = leaveFeed(window, feedId);
      const changes = route ? removalsOf(route) : [];
      if (changes.length) window.push({ kind: 'sections', changes });
    },
    async unwatchFiles(watchId) {
      fsWatches.delete(watchId);
      return connected().call('fs/unwatch', { watchId });
    },
    async call(method, params) {
      const live = client ?? (await connectedAfterFirstOpen());
      const reply = await live.call(method, params);
      const flowId = (LOGIN_START_METHODS.has(method) ? reply : params) as { flowId?: unknown } | null;
      if (typeof flowId?.flowId === 'string' && flowId.flowId) {
        if (LOGIN_START_METHODS.has(method)) await followLogin(live, flowId.flowId);
        else if (LOGIN_CANCEL_METHODS.has(method)) unfollowLogin(flowId.flowId);
      }
      return reply;
    },
    client: () => client,
    async resumeThread(threadId, window) {
      return (client ?? (await connectedAfterFirstOpen())).resumeThread(threadId, window);
    },
    async unsubscribeThread(threadId) {
      return (client ?? (await connectedAfterFirstOpen())).unsubscribeThread(threadId);
    },
    onStoreChange(listener) {
      storeListeners.add(listener);
      return () => void storeListeners.delete(listener);
    },
    loginFeed: (flowId) => {
      const feed = loginFeeds.get(flowId);
      return feed ? { ...feed } : { state: null, lost: true };
    },
    watchSection(section, listener) {
      const set = sectionWatchers.get(section) ?? new Set();
      sectionWatchers.set(section, set);
      set.add(listener);
      return () => void set.delete(listener);
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => void eventListeners.delete(listener);
    },
    notify: (method, params) => connected().notify(method, params),
    respond: (id, answer) => connected().respond(id, answer),
    pendingServerRequests: () => client?.pendingServerRequests() ?? [],
    sendBinary(frame) {
      const send = connected().sendBinary;
      if (!send) throw new Error('This connection has no media lane.');
      send.call(client, frame);
    },
    viewPorts,
    noteUserInput(at) {
      if (!client || status !== 'ready') return;
      if (at - lastActivityAt < CLIENT_ACTIVITY_MIN_GAP_MS) return;
      lastActivityAt = at;
      client.notify('client/activity', { at });
    },
    async close() {
      unsubscribeClient?.();
      unsubscribeStore?.();
      relay?.dispose();
      windows.clear();
      loginFeeds.clear();
      feedWatches.clear();
      replacedListeners.clear();
      storeListeners.clear();
      closedByOwner = true;
      epoch += 1;
      newest = null;
      // The handshake in flight can no longer settle `synced` (it is no longer the owner): what waits on it, a call
      // made before the first open included, ends here.
      if (!syncedSettled) settleSynced(new Error('The core connection is closed.'));
      const closing = client;
      client = null;
      relay = null;
      status = 'closed';
      await closing?.close();
    },
  };
}
