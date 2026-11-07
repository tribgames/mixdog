// The one protocol connection of this Electron process to one core (a target: this PC's core, or a server's
// through its SSH tunnel). Main owns the socket and the client library's fold store; windows get the pushed
// sections mirrored (section-relay.ts) and call the closed list of detail methods (window-ipc.ts). Nothing here
// polls: state arrives as sections, liveness is the connection's own ticker (protocol.md §4.7).
import type {
  DesktopProtocolStatus,
  DesktopSectionEntry,
  DesktopSectionsPush,
  DesktopSectionsSnapshot,
} from '../../shared/contract-sections';
import { SECTION_NAMES } from '../../shared/contract-sections';
import { createSectionRelay, type RelayedStore, type SectionRelay } from './section-relay';

export { SECTION_NAMES };

/** `client/activity` is sent at most once per this long (desktop-services.md §12.3: rate limit is client-side). */
export const CLIENT_ACTIVITY_MIN_GAP_MS = 60_000;

/** What the connection needs from the client library's `ProtocolClient`. */
export interface ConnectionClient {
  readonly store: RelayedStore;
  readonly status: { readonly state: string };
  call(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  subscribeApp(): Promise<void>;
  respond(id: string | number, answer: ServerRequestAnswer): void;
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
  | { readonly type: 'notification'; readonly notification: { readonly method: string; readonly params?: unknown } }
  | { readonly type: 'serverRequest'; readonly request: { readonly id: string | number; readonly method: string; readonly params: unknown } }
  | { readonly type: 'serverRequestResolved'; readonly params: { readonly requestId?: string | number } }
  | { readonly type: string };

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
}

export interface ProtocolConnection {
  start(): Promise<void>;
  readonly status: DesktopProtocolStatus;
  snapshot(): DesktopSectionsSnapshot;
  /** Settles when the connect handshake (`start`: open, `initialize`, the app subscription) has folded the first
   *  snapshot: resolved then, rejected with the handshake's own error when it failed. A read of the held sections
   *  issued before that waits here; there is no timeout of its own. */
  whenSynced(): Promise<void>;
  /** Registers a window; returns its removal. A window attached after `start` is told the current status. */
  attach(window: ProtocolWindow): () => void;
  call(method: string, params: unknown): Promise<unknown>;
  /** The core samples listening ports only while someone views them (U-DS4): the first viewer subscribes, the last
   *  one leaving unsubscribes. After a reconnect the subscription is sent again while viewers remain. */
  viewPorts(window: ProtocolWindow, viewing: boolean): Promise<void>;
  /** `fs/watch` for `window`: its owner is recorded before the request goes out, so the watch is released with the
   *  window even when the answer is late, and it is sent again after a reconnect. `params.watchId` is unique per
   *  connection. A failed request forgets the watch. */
  watchFiles(window: ProtocolWindow, params: { watchId: string } & Record<string, unknown>): Promise<unknown>;
  unwatchFiles(watchId: string): Promise<unknown>;
  /** Main's own read of a section (the computer pill, nothing in a window): called with the current entry after each
   *  change of `section`, `undefined` once removed. Valid before and after `start`. */
  watchSection(section: string, listener: (entry: DesktopSectionEntry | undefined) => void): () => void;
  /** Raw client events for the host role (server requests and non-section notifications). Returns the removal. */
  onEvent(listener: (event: ConnectionClientEvent) => void): () => void;
  notify(method: string, params: unknown): void;
  respond(id: string | number, answer: ServerRequestAnswer): void;
  sendBinary(frame: Uint8Array): void;
  /** The user operated this app (`input` event). Sends `client/activity` unless one went out within the minute. */
  noteUserInput(at: number): void;
  close(): Promise<void>;
}

const toStatus = (state: string): DesktopProtocolStatus =>
  state === 'ready' ? 'ready' : state === 'closed' ? 'closed' : 'reconnecting';

export function createProtocolConnection({ open, defer }: ProtocolConnectionOptions): ProtocolConnection {
  const windows = new Set<ProtocolWindow>();
  const portViewers = new Set<ProtocolWindow>();
  const eventListeners = new Set<(event: ConnectionClientEvent) => void>();
  const sectionWatchers = new Map<string, Set<(entry: DesktopSectionEntry | undefined) => void>>();
  const fsWatches = new Map<string, { window: ProtocolWindow; params: { watchId: string } & Record<string, unknown> }>();
  // Set when the link came back: the windows' whole store is replaced once the restored app subscription's snapshot
  // has been folded and swapped in (`appSnapshot` comes last; the section changes before it announce the removed
  // sections too).
  let awaitingAppSnapshot = false;
  let unsubscribeStore: (() => void) | null = null;
  let client: ConnectionClient | null = null;
  let relay: SectionRelay | null = null;
  let status: DesktopProtocolStatus = 'reconnecting';
  let lastActivityAt = Number.NEGATIVE_INFINITY;
  let unsubscribeClient: (() => void) | null = null;
  let resolveSynced!: () => void;
  let rejectSynced!: (error: unknown) => void;
  const synced = new Promise<void>((resolve, reject) => {
    resolveSynced = resolve;
    rejectSynced = reject;
  });
  // A failed handshake reaches every reader that awaits `whenSynced`; one nobody awaits must not be an unhandled rejection.
  synced.catch(() => undefined);

  const broadcast = (push: DesktopSectionsPush): void => {
    for (const window of [...windows]) window.push(push);
  };
  const connected = (): ConnectionClient => {
    if (!client) throw new Error('The core connection is not open.');
    return client;
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
  };
  const viewPorts = async (window: ProtocolWindow, viewing: boolean): Promise<void> => {
    const wasViewed = portViewers.size > 0;
    if (viewing) portViewers.add(window);
    else portViewers.delete(window);
    const isViewed = portViewers.size > 0;
    if (isViewed === wasViewed) return;
    await connected().call(isViewed ? 'system/ports/subscribe' : 'system/ports/unsubscribe', {});
  };

  const handshake = async (): Promise<void> => {
    const opened = await open();
    client = opened;
    status = toStatus(opened.status.state);
    relay = createSectionRelay({
      store: opened.store,
      sectionNames: SECTION_NAMES,
      send: broadcast,
      ...(defer ? { defer } : {}),
    });
    unsubscribeStore = opened.store.subscribe((change) => {
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
      for (const listener of [...eventListeners]) listener(event);
      if (event.type === 'status') {
        const next = toStatus((event as { status: { state: string } }).status.state);
        const wasReady = status === 'ready';
        status = next;
        if (next === 'ready' && !wasReady) {
          awaitingAppSnapshot = true;
          restoreScopedFeeds(opened);
        }
        relay?.status(next);
      } else if (event.type === 'notification') {
        const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
        for (const window of [...windows]) window.notification(method, params);
      }
    });
    await opened.subscribeApp();
  };

  return {
    get status() {
      return status;
    },
    whenSynced: () => synced,
    async start() {
      if (client) return;
      try {
        await handshake();
      } catch (error) {
        rejectSynced(error);
        throw error;
      }
      resolveSynced();
    },
    snapshot: () => (relay ? relay.snapshot(status) : { status, entries: [] as DesktopSectionEntry[] }),
    attach(window) {
      windows.add(window);
      return () => {
        windows.delete(window);
        for (const [watchId, owner] of [...fsWatches]) if (owner.window === window) unwatchQuietly(watchId);
        if (portViewers.has(window)) void viewPorts(window, false).catch(() => undefined);
      };
    },
    async watchFiles(window, params) {
      const live = connected();
      fsWatches.set(params.watchId, { window, params });
      try {
        return await live.call('fs/watch', params);
      } catch (error) {
        fsWatches.delete(params.watchId);
        throw error;
      }
    },
    async unwatchFiles(watchId) {
      fsWatches.delete(watchId);
      return connected().call('fs/unwatch', { watchId });
    },
    call: (method, params) => connected().call(method, params),
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
      const closing = client;
      client = null;
      relay = null;
      status = 'closed';
      await closing?.close();
    },
  };
}
