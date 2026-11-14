// The renderer side of main/protocol/connection.ts for one window: the shared lanes (shared/core-lanes) run against a
// RendererConnection as they ran against the main process connection. One connection, one window: a watch id needs no
// window prefix, the section mirror is the client's own store, and nothing is relayed. Every call is mapped by
// withDirectErrors. Nothing polls: state arrives as sections, liveness is the client library's own ticker.
import type { ProtocolClient, SessionFold } from '../../../../../packages/protocol-client/src/index.ts';
import type { DesktopProtocolStatus, DesktopSectionsSnapshot } from '../../shared/contract-sections.ts';
import { SECTION_NAMES } from '../../shared/contract-sections.ts';
import { LOGIN_CANCEL_METHODS, LOGIN_START_METHODS, loginFeedId, loginUpdateOf } from '../../shared/core-lanes/login-feed.ts';
import type {
  ConnectionClient,
  ConnectionClientEvent,
  ConnectionStoreChange,
  LoginFeedState,
  ProtocolConnection,
  ProtocolWindow,
  ServerRequestAnswer,
} from '../../main/protocol/connection';
import { withDirectErrors } from './errors.ts';

/** `client/activity` is sent at most once per this long (desktop-services.md section 12.3: the rate limit is client-side). */
export const CLIENT_ACTIVITY_MIN_GAP_MS = 60_000;
/** The most sign-in flow feeds one connection keeps once flows have ended; a flow still pending is never let go. */
export const MAX_FOLLOWED_LOGINS = 32;

const isFinalLoginState = (state: unknown): boolean => {
  const name = (state as { state?: unknown } | null)?.state;
  return typeof name === 'string' && name !== 'pending';
};
const toStatus = (state: string): DesktopProtocolStatus =>
  state === 'ready' ? 'ready' : state === 'closed' ? 'closed' : 'reconnecting';

/** What a window of this connection hears: the scoped-feed notifications (`fs/changed`, `system/ports/updated`, login
 *  updates) and the loss of a sign-in feed. */
export type RendererWindow = Pick<ProtocolWindow, 'notification' | 'loginFeedLost'>;

/** How one request leaves for the core. The default is the client call; the size-aware sender plugs in here. */
export type Sender = (client: ProtocolClient<SessionFold>, method: string, params: unknown) => Promise<unknown>;
export const plainSender: Sender = (client, method, params) =>
  (client as unknown as { call(method: string, params: unknown): Promise<unknown> }).call(method, params);

export interface RendererConnectionOptions {
  /** Opens the client and performs `initialize`: openDirectClient bound to its bridge. */
  open(): Promise<ProtocolClient<SessionFold>>;
  send?: Sender;
}

/** The lane Picks of ProtocolConnection, plus what the renderer files and ports feeds need. */
export type RendererConnection = Pick<
  ProtocolConnection,
  | 'start' | 'reopen' | 'ensureOpen' | 'onReplaced' | 'status' | 'snapshot' | 'whenSynced' | 'attach' | 'call' | 'client'
  | 'resumeThread' | 'unsubscribeThread' | 'onStoreChange' | 'viewPorts' | 'watchFiles' | 'unwatchFiles' | 'loginFeed'
  | 'onEvent' | 'notify' | 'respond' | 'pendingServerRequests' | 'noteUserInput' | 'close'
> & {
  /** The same client with the library types: what the size-aware sender and the blob calls take. */
  protocolClient(): ProtocolClient<SessionFold> | null;
  /** Replaces how a request leaves (see Sender). */
  setSender(send: Sender): void;
};

export function createRendererConnection({ open, send: initialSend }: RendererConnectionOptions): RendererConnection {
  let sender: Sender = initialSend ?? plainSender;
  const windows = new Set<RendererWindow>();
  const portViewers = new Set<RendererWindow>();
  const eventListeners = new Set<(event: ConnectionClientEvent) => void>();
  const storeListeners = new Set<(change: ConnectionStoreChange) => void>();
  const replacedListeners = new Set<() => void>();
  const fsWatches = new Map<string, { window: RendererWindow; params: { watchId: string } & Record<string, unknown> }>();
  const loginFeeds = new Map<string, LoginFeedState>();
  let raw: ProtocolClient<SessionFold> | null = null;
  let client: ConnectionClient | null = null;
  let status: DesktopProtocolStatus = 'reconnecting';
  let unsubscribeClient: (() => void) | null = null;
  let unsubscribeStore: (() => void) | null = null;
  let closedByOwner = false;
  // The newest start or reopen owns the client: every handler of a client checks it still holds its number.
  let epoch = 0;
  let newest: Promise<void> | null = null;
  let inflight: Promise<void> | null = null;
  let lastActivityAt = Number.NEGATIVE_INFINITY;
  let everOpened = false;
  let syncedSettled = true;
  let resolveSynced!: () => void;
  let rejectSynced!: (error: unknown) => void;
  let synced!: Promise<void>;

  const track = (run: Promise<void>): Promise<void> => {
    inflight = run;
    const settled = (): void => {
      if (inflight === run) inflight = null;
    };
    run.then(settled, settled);
    return run;
  };
  const pendingSync = (): void => {
    if (!syncedSettled) return;
    syncedSettled = false;
    synced = new Promise<void>((resolve, reject) => {
      resolveSynced = resolve;
      rejectSynced = reject;
    });
    synced.catch(() => undefined);
  };
  const settleSynced = (error?: unknown): void => {
    syncedSettled = true;
    if (error === undefined) {
      everOpened = true;
      resolveSynced();
    } else rejectSynced(error);
  };
  pendingSync();

  const connected = (): ConnectionClient => {
    if (!client) throw new Error('The core connection is not open.');
    return client;
  };
  /** A request made before the first connection is open waits for that handshake and fails with its error. */
  const connectedAfterFirstOpen = async (): Promise<ConnectionClient> => {
    if (!client && !everOpened && !closedByOwner) await synced;
    return connected();
  };
  /** A request to the open client, through the sender. */
  const request = async (method: string, params: unknown): Promise<unknown> => {
    await connectedAfterFirstOpen();
    return sender(raw as ProtocolClient<SessionFold>, method, params);
  };

  const loseLoginFeed = (flowId: string, feed: LoginFeedState): void => {
    if (feed.lost) return;
    feed.lost = true;
    for (const window of [...windows]) window.loginFeedLost(flowId);
  };
  const unfollowLogin = (flowId: string): void => {
    if (!loginFeeds.delete(flowId)) return;
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
  const unwatchQuietly = (watchId: string): void => {
    fsWatches.delete(watchId);
    if (client) void client.call('fs/unwatch', { watchId }).catch(() => undefined);
  };
  /** The scoped feeds do not survive the socket: send again what live owners still want. */
  const restoreScopedFeeds = (restored: ConnectionClient): void => {
    for (const [watchId, { params }] of [...fsWatches]) {
      void restored.call('fs/watch', params).catch(() => void fsWatches.delete(watchId));
    }
    if (portViewers.size > 0) void restored.call('system/ports/subscribe', {}).catch(() => undefined);
  };
  const viewPorts = async (window: RendererWindow, viewing: boolean): Promise<void> => {
    const wasViewed = portViewers.size > 0;
    if (viewing) portViewers.add(window);
    else portViewers.delete(window);
    const isViewed = portViewers.size > 0;
    if (isViewed === wasViewed) return;
    await withDirectErrors(connected().call(isViewed ? 'system/ports/subscribe' : 'system/ports/unsubscribe', {}));
  };

  /** Drops the current client and what is bound to it; windows and watches stay. The followed sign-in flows are lost:
   *  their feeds ended with the client, and unsubscribing first keeps its closing from reaching them. */
  const release = async (next: DesktopProtocolStatus): Promise<void> => {
    unsubscribeClient?.();
    unsubscribeStore?.();
    unsubscribeClient = null;
    unsubscribeStore = null;
    for (const [flowId, feed] of loginFeeds) loseLoginFeed(flowId, feed);
    const closing = client;
    client = null;
    raw = null;
    status = next;
    await closing?.close().catch(() => undefined);
  };

  /** Opens a client for the owner `mine`. False when a newer owner took over meanwhile (the client is closed). */
  const handshake = async (mine: number): Promise<boolean> => {
    const opened = await open();
    const loose = opened as unknown as ConnectionClient;
    if (mine !== epoch) {
      await loose.close().catch(() => undefined);
      return false;
    }
    raw = opened;
    client = loose;
    status = toStatus(loose.status.state);
    const owns = (): boolean => mine === epoch && client === loose;
    unsubscribeStore = loose.store.subscribe((change) => {
      if (!owns()) return;
      for (const listener of [...storeListeners]) listener(change);
    });
    unsubscribeClient = loose.on((event) => {
      if (!owns()) return;
      for (const listener of [...eventListeners]) listener(event);
      if (!owns()) return;
      if (event.type === 'status') {
        const next = toStatus((event as { status: { state: string } }).status.state);
        const wasReady = status === 'ready';
        status = next;
        if (next === 'ready' && !wasReady) restoreScopedFeeds(loose);
        if (next !== 'ready') for (const [flowId, feed] of loginFeeds) loseLoginFeed(flowId, feed);
      } else if (event.type === 'notification') {
        const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
        const login = loginUpdateOf(method, params);
        const followed = login ? loginFeeds.get(login.flowId) : undefined;
        if (login && followed) followed.state = login.state;
        for (const window of [...windows]) window.notification(method, params);
      }
    });
    await loose.subscribeApp();
    return mine === epoch;
  };
  /** What a caller superseded by a newer open gets: that open outcome. */
  const supersededBy = async (): Promise<void> => {
    await newest;
  };
  const connect = async (mine: number): Promise<void> => {
    try {
      if (!(await handshake(mine))) await supersededBy();
    } catch (error) {
      if (mine !== epoch) return supersededBy();
      await release('closed');
      throw error;
    }
  };

  const connection: RendererConnection = {
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
      return connection.reopen();
    },
    reopen() {
      if (closedByOwner) return Promise.reject(new Error('The core connection is closed.'));
      const mine = ++epoch;
      pendingSync();
      const run = (async (): Promise<void> => {
        await release('reconnecting');
        if (mine !== epoch) return supersededBy();
        try {
          await connect(mine);
        } catch (error) {
          if (mine === epoch) settleSynced(error);
          throw error;
        }
        if (mine !== epoch) return;
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
    snapshot(): DesktopSectionsSnapshot {
      if (!client) return { status, entries: [] };
      const { store } = client;
      return { status, entries: SECTION_NAMES.flatMap((name) => store.sections(name)), epoch: store.appFeed()?.epoch };
    },
    attach(window) {
      windows.add(window);
      return () => {
        windows.delete(window);
        for (const [watchId, owner] of [...fsWatches]) if (owner.window === window) unwatchQuietly(watchId);
        if (portViewers.has(window)) void viewPorts(window, false).catch(() => undefined);
      };
    },
    async watchFiles(window, params) {
      await connectedAfterFirstOpen();
      // The owner is recorded before the request goes out: the watch is released with the window whether or not the core has answered.
      fsWatches.set(params.watchId, { window, params });
      try {
        return await withDirectErrors(request('fs/watch', params));
      } catch (error) {
        fsWatches.delete(params.watchId);
        throw error;
      }
    },
    async unwatchFiles(watchId) {
      fsWatches.delete(watchId);
      return withDirectErrors(connected().call('fs/unwatch', { watchId }));
    },
    viewPorts,
    async call(method, params) {
      const live = await connectedAfterFirstOpen();
      const reply = await withDirectErrors(request(method, params));
      const flow = (LOGIN_START_METHODS.has(method) ? reply : params) as { flowId?: unknown } | null;
      if (typeof flow?.flowId === 'string' && flow.flowId) {
        if (LOGIN_START_METHODS.has(method)) await followLogin(live, flow.flowId);
        else if (LOGIN_CANCEL_METHODS.has(method)) unfollowLogin(flow.flowId);
      }
      return reply;
    },
    client: () => client,
    protocolClient: () => raw,
    setSender(send) {
      sender = send;
    },
    async resumeThread(threadId, window) {
      return withDirectErrors((await connectedAfterFirstOpen()).resumeThread(threadId, window));
    },
    async unsubscribeThread(threadId) {
      return withDirectErrors((await connectedAfterFirstOpen()).unsubscribeThread(threadId));
    },
    onStoreChange(listener) {
      storeListeners.add(listener);
      return () => void storeListeners.delete(listener);
    },
    loginFeed(flowId) {
      const feed = loginFeeds.get(flowId);
      return feed ? { ...feed } : { state: null, lost: true };
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => void eventListeners.delete(listener);
    },
    notify: (method, params) => connected().notify(method, params),
    respond: (id: string | number, answer: ServerRequestAnswer) => connected().respond(id, answer),
    pendingServerRequests: () => client?.pendingServerRequests() ?? [],
    noteUserInput(at) {
      if (!client || status !== 'ready') return;
      if (at - lastActivityAt < CLIENT_ACTIVITY_MIN_GAP_MS) return;
      lastActivityAt = at;
      client.notify('client/activity', { at });
    },
    async close() {
      unsubscribeClient?.();
      unsubscribeStore?.();
      windows.clear();
      portViewers.clear();
      fsWatches.clear();
      loginFeeds.clear();
      replacedListeners.clear();
      storeListeners.clear();
      closedByOwner = true;
      epoch += 1;
      newest = null;
      if (!syncedSettled) settleSynced(new Error('The core connection is closed.'));
      const closing = client;
      client = null;
      raw = null;
      status = 'closed';
      await closing?.close();
    },
  };
  return connection;
}
