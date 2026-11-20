// The connection methods of the desktop API (saved SSH servers, the connect dialog, a server window's link and Ports
// panel, reopening server windows) as calls on this window's client to this PC's core: each method is one `connections/*` request,
// and what the core pushes (the `connections` scoped feed, the connection-scoped notifications) reaches the listeners.
// The names and types are the preload's; a failure is mapped by withDirectErrors, so its message keeps the code first
// (ssh-error-text.ts and the port error codes read it).
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import type { DesktopApi } from '../shared/contract';
import type { DesktopSshForgetResult } from '../shared/contract-ssh';
import type { DesktopConnectionIdentity } from '../shared/contract-workspace';
import { firstPcCoreOpen, pcCoreClient } from './core-direct/client.ts';
import { withDirectErrors } from './core-direct/errors.ts';

type PreloadMethods =
  | 'sshListHosts'
  | 'sshRenameHost'
  | 'sshForgetHost'
  | 'sshOpenHost'
  | 'sshConfigHosts'
  | 'sshInspectHostKey'
  | 'sshConnect'
  | 'sshCancel'
  | 'sshAskpassReply'
  | 'sshCleanupHost'
  | 'sshCleanupTarget'
  | 'sshUpdateHostSettings'
  | 'sshServerLogins'
  | 'sshServerLoginBegin'
  | 'sshServerLoginStatus'
  | 'sshServerLoginComplete'
  | 'sshServerLoginCancel'
  | 'sshServerLoginSaveKey'
  | 'sshServerLoginLogout'
  | 'sshServerLoginRemoveCustom'
  | 'sshDiagnosticsLog'
  | 'sshDiagnosticsCopy'
  | 'sshServerLog'
  | 'getConnectionLink'
  | 'retryConnection'
  | 'retryConnectionNow'
  | 'getReopenServerWindows'
  | 'setReopenServerWindows'
  | 'getServerRestoreProgress'
  | 'listServerPorts'
  | 'forwardServerPort'
  | 'stopServerPortForward'
  | 'dismissServerPort'
  | 'openServerPortInBrowser'
  | 'subscribeSshAskpass'
  | 'subscribeSshProgress'
  | 'subscribeSshCleanupProgress'
  | 'subscribeSshServerLoginUpdated'
  | 'subscribeConnectionLink'
  | 'subscribeConnectionNotice'
  | 'subscribeConnectionSignIn'
  | 'subscribeServerPorts'
  | 'subscribeServerRestoreProgress';

/** The preload's methods with the preload's types, and the two this file adds. */
export type ConnectionsCoreApi = {
  [K in PreloadMethods]-?: NonNullable<DesktopApi[K]>;
} & {
  /** A server window asks for the user's connect attempt (sign in again, confirm a changed host key). */
  requestConnectionSignIn(): Promise<void>;
  /** The saved SSH servers, or which are open, changed: read the list again. */
  subscribeSshHostsChanged(listener: () => void): () => void;
};

export interface ConnectionsCoreDeps {
  /** The client to this PC's core, null until it is open. */
  client(): ProtocolClient<SessionFold> | null;
  /** The window's first PC core open while it is in flight (the window renders before it): a call or a listener that finds no
   *  client waits for it. Null once it settled, or with none. */
  opening?(): Promise<unknown> | null;
  /** Called when the connection closed or replaced its client: the api re-reads `client()`. */
  onClientChange?(listener: () => void): () => void;
  /** The connection this window drives (the preload's `connection`). */
  connection(): DesktopConnectionIdentity | undefined;
  /** This PC's default browser. */
  openExternal(url: string): Promise<void>;
}

interface Notification {
  readonly method: string;
  readonly params?: unknown;
  readonly feed?: { readonly id?: string };
}
interface SectionChange {
  readonly key: string | null;
  readonly value?: unknown;
  readonly removed?: boolean;
}
type LooseClient = { call(method: string, params: unknown): Promise<unknown> };

const CONNECTIONS_FEED = 'connections';
const NO_CORE = 'This window has no connection to the core.';

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** The section updates a `connections` feed notification carries: one `connections/updated`, or the sections of a snapshot. */
function sectionChanges(note: Notification): SectionChange[] {
  const params = asRecord(note.params);
  const updates =
    note.method === 'feed/snapshot'
      ? asRecord(params.state).sections
      : note.method === 'connections/updated'
        ? [params]
        : [];
  if (!Array.isArray(updates)) return [];
  return updates
    .map(asRecord)
    .filter((u) => u.section === CONNECTIONS_FEED)
    .map((u) => ({
      key: typeof u.key === 'string' ? u.key : null,
      ...('value' in u ? { value: u.value } : {}),
      ...(u.removed === true ? { removed: true } : {}),
    }));
}

export function createConnectionsCoreApi(deps: ConnectionsCoreDeps): ConnectionsCoreApi {
  /** The first open in flight, when no client is open yet. */
  const pendingOpen = (): Promise<unknown> | null => (deps.client() ? null : (deps.opening?.() ?? null));
  const call = <T>(method: string, params: unknown = {}): Promise<T> => {
    const opening = pendingOpen();
    if (opening)
      return opening.then(
        () => callOpen<T>(method, params),
        () => callOpen<T>(method, params)
      );
    return callOpen<T>(method, params);
  };
  const callOpen = <T>(method: string, params: unknown): Promise<T> => {
    const client = deps.client();
    if (!client) return Promise.reject(new Error(NO_CORE));
    return withDirectErrors((client as unknown as LooseClient).call(method, params) as Promise<T>);
  };
  const connectionId = (): string => deps.connection()?.id ?? 'local';

  // ---- what the core pushes
  const notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  const sectionListeners = new Set<(change: SectionChange) => void>();
  let attachedTo: ProtocolClient<SessionFold> | null = null;
  let detach: (() => void) | null = null;
  let feedSubscription: string | null = null;
  let feedChain: Promise<void> = Promise.resolve();
  let wasReady = true;
  let reportedNoCore = false;

  const syncFeed = (): void => {
    feedChain = feedChain
      .then(async () => {
        // The feed is the attached client's: its id and the completion of its request belong to that client alone.
        const owner = attachedTo;
        const client = owner as unknown as LooseClient | null;
        if (!client) return;
        if (sectionListeners.size > 0 && feedSubscription === null) {
          const identity = deps.connection();
          const reply = (await client.call(
            'connections/subscribe',
            identity?.kind === 'ssh' ? { connectionId: identity.id } : {}
          )) as { id: string };
          if (attachedTo === owner) feedSubscription = reply.id;
        } else if (sectionListeners.size === 0 && feedSubscription !== null) {
          const subscriptionId = feedSubscription;
          feedSubscription = null;
          await client.call('connections/unsubscribe', { subscriptionId });
          // The service ends its own record; the server keeps pushing the feed until this ends the subscription.
          await client.call('feed/unsubscribe', { feedId: CONNECTIONS_FEED });
        }
      })
      .catch((error: unknown) => {
        console.error('connections feed:', error instanceof Error ? error.message : error);
      });
  };
  const onEvent = (event: { type: string; notification?: Notification; status?: { state: string } }): void => {
    if (event.type === 'status') {
      const ready = event.status?.state === 'ready';
      // A new connection to the core holds no feed: ask for it again.
      if (ready && !wasReady) {
        feedSubscription = null;
        if (sectionListeners.size > 0) syncFeed();
      }
      wasReady = ready;
      return;
    }
    const note = event.notification;
    if (event.type !== 'notification' || !note) return;
    if (note.feed?.id === CONNECTIONS_FEED || note.method === 'connections/updated') {
      for (const change of sectionChanges(note)) for (const listener of [...sectionListeners]) listener(change);
    }
    for (const listener of [...(notificationListeners.get(note.method) ?? [])]) listener(note.params);
  };
  /** The open client. One that closed is none: the registry names it until its replacement is accepted. */
  const liveClient = (): ProtocolClient<SessionFold> | null => {
    const client = deps.client();
    return client && (client as { status?: { state?: string } }).status?.state !== 'closed' ? client : null;
  };
  /** Listens to the client that is open now (and to a replacement of it), and asks a new one for the feed its listeners
   *  need. False while there is none, said once when the window has no client at all. */
  const attach = (): boolean => {
    const client = liveClient();
    if (!client) {
      if (!deps.client() && !reportedNoCore) {
        reportedNoCore = true;
        console.error(NO_CORE);
      }
      return false;
    }
    if (attachedTo !== client) {
      detach?.();
      attachedTo = client;
      feedSubscription = null;
      wasReady = true;
      detach = client.on((event) => onEvent(event as never));
      if (sectionListeners.size > 0) syncFeed();
    }
    return true;
  };
  /** attach(), or, while the first open is in flight, true now and attach() (then `opened`) once it settled. */
  const attachOrDefer = (opened: () => void): boolean => {
    const opening = pendingOpen();
    if (!opening) return attach();
    const later = (): void => {
      if (attach()) opened();
    };
    void opening.then(later, later);
    return true;
  };
  // The api lives as long as the page, so it must not keep a client that closed or was replaced: it lets go of it (listener,
  // feed state) by identity, and follows the open one if anyone is subscribed (also one who subscribed during the gap).
  const reconcile = (): void => {
    const live = liveClient();
    if (attachedTo !== null && attachedTo === live) return;
    if (attachedTo !== null) {
      detach?.();
      detach = null;
      attachedTo = null;
      feedSubscription = null;
      wasReady = true;
    }
    const subscribed = sectionListeners.size > 0 || [...notificationListeners.values()].some((set) => set.size > 0);
    if (live && subscribed) attach();
  };
  deps.onClientChange?.(reconcile);
  const onNotification = (method: string, listener: (params: unknown) => void): (() => void) => {
    attachOrDefer(() => undefined);
    const set = notificationListeners.get(method) ?? new Set();
    notificationListeners.set(method, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const onSection = (listener: (change: SectionChange) => void): (() => void) => {
    attachOrDefer(syncFeed);
    sectionListeners.add(listener);
    syncFeed();
    return () => {
      sectionListeners.delete(listener);
      syncFeed();
    };
  };
  /** The value of one key of the `connections` feed, whenever it is written. */
  const onKey = <T>(key: string, listener: (value: T) => void): (() => void) =>
    onSection((change) => {
      if (change.key === key && !change.removed && 'value' in change) listener(change.value as T);
    });
  /** A connection-scoped notification reaches only the subscribers of the feed. */
  const onNotificationWithFeed = (method: string, listener: (params: unknown) => void): (() => void) => {
    const stopNotice = onNotification(method, listener);
    const stopFeed = onSection(() => undefined);
    return () => {
      stopNotice();
      stopFeed();
    };
  };

  const hosts = () => call<Awaited<ReturnType<ConnectionsCoreApi['sshListHosts']>>>('connections/ssh/list');
  const restoreEnabled = async (): Promise<boolean> =>
    (await call<{ enabled: boolean }>('connections/restore/get')).enabled;

  const api: ConnectionsCoreApi = {
    sshListHosts: () => hosts(),
    sshRenameHost: async (id, name) => {
      await call('connections/ssh/rename', { id, name });
      return hosts();
    },
    sshForgetHost: async (id) => {
      const result = await call<{ ok: true } | Extract<DesktopSshForgetResult, { ok: false }>>(
        'connections/ssh/forget',
        { id }
      );
      if (!result.ok) return result;
      return { ok: true, hosts: await hosts() };
    },
    sshOpenHost: (id) => call('connections/ssh/open', { id }),
    sshConfigHosts: () => call('connections/ssh/configHosts'),
    sshInspectHostKey: (target) => call('connections/ssh/inspect', { target }),
    sshConnect: (request) => call('connections/ssh/connect', { attemptId: request.attemptId, request }),
    sshCancel: async (attemptId) => {
      await call('connections/ssh/cancel', { attemptId });
    },
    sshAskpassReply: async (attemptId, requestId, secret) => {
      await call('connections/ssh/askpassReply', { attemptId, requestId, secret });
    },
    sshCleanupHost: (id, request) => call('connections/ssh/cleanup', { id, request }),
    sshCleanupTarget: (target, request) => call('connections/ssh/cleanup', { target, request }),
    sshUpdateHostSettings: async (id, settings) => {
      await call('connections/ssh/updateSettings', { id, settings });
      return hosts();
    },
    sshServerLogins: (id) => call('connections/ssh/serverLogins', { id }),
    sshServerLoginBegin: async (id, provider) => {
      const flow = await call<Awaited<ReturnType<ConnectionsCoreApi['sshServerLoginBegin']>> & { openUrl?: string }>(
        'connections/ssh/serverLoginBegin',
        { id, provider }
      );
      // The server never opens a browser of its own: this PC's does. A browser that does not open ends the login.
      if (flow.openUrl && /^https?:\/\//i.test(flow.openUrl)) {
        try {
          await deps.openExternal(flow.openUrl);
        } catch (error) {
          await call('connections/ssh/serverLoginCancel', { id, flowId: flow.flowId }).catch(() => undefined);
          throw error;
        }
      }
      return flow;
    },
    sshServerLoginStatus: (id, flowId) => call('connections/ssh/serverLoginStatus', { id, flowId }),
    sshServerLoginComplete: (id, flowId, redirectUrl) =>
      call('connections/ssh/serverLoginComplete', { id, flowId, redirectUrl }),
    sshServerLoginCancel: async (id, flowId) => {
      await call('connections/ssh/serverLoginCancel', { id, flowId });
    },
    sshServerLoginSaveKey: async (id, provider, key) => {
      await call('connections/ssh/serverLoginSaveKey', { id, provider, key });
    },
    sshServerLoginLogout: async (id, provider) => {
      await call('connections/ssh/serverLoginLogout', { id, provider });
    },
    sshServerLoginRemoveCustom: async (id, provider) => {
      await call('connections/ssh/serverLoginRemoveCustom', { id, provider });
    },
    sshDiagnosticsLog: (ref) => call('connections/ssh/diagnosticsLog', { ref }),
    sshDiagnosticsCopy: async (ref) => (await call<{ text: string }>('connections/ssh/diagnosticsCopy', { ref })).text,
    sshServerLog: (ref) => call('connections/ssh/serverLog', { ref }),
    getConnectionLink: () => call('connections/link/get', { connectionId: connectionId() }),
    retryConnection: async () => {
      await call('connections/link/retry', { connectionId: connectionId() });
    },
    retryConnectionNow: async () => {
      await call('connections/link/retryNow', { connectionId: connectionId() });
    },
    requestConnectionSignIn: async () => {
      await call('connections/link/requestSignIn', { connectionId: connectionId() });
    },
    getReopenServerWindows: restoreEnabled,
    setReopenServerWindows: async (enabled) => {
      await call('connections/restore/set', { enabled });
      return restoreEnabled();
    },
    getServerRestoreProgress: () => call('connections/restore/progress'),
    listServerPorts: () => call('connections/ports/list', { connectionId: connectionId() }),
    forwardServerPort: (remotePort, localPort) =>
      call('connections/ports/forward', { connectionId: connectionId(), remotePort, localPort: localPort ?? null }),
    stopServerPortForward: async (remotePort) => {
      await call('connections/ports/stop', { connectionId: connectionId(), remotePort });
    },
    dismissServerPort: async (port) => {
      await call('connections/ports/dismiss', { connectionId: connectionId(), port });
    },
    openServerPortInBrowser: async (remotePort) => {
      const view = await api.listServerPorts();
      const forward = view.forwards.find(
        (f) => f.remotePort === remotePort && f.status === 'active' && f.localPort > 0
      );
      if (!forward) throw new Error(`port-not-active: Port ${remotePort} is not forwarded to this PC right now.`);
      await deps.openExternal(`http://127.0.0.1:${forward.localPort}/`);
    },

    subscribeSshAskpass: (listener) => onNotification('connections/ssh/askpass', (p) => listener(p as never)),
    subscribeSshProgress: (listener) => onNotification('connections/ssh/progress', (p) => listener(p as never)),
    subscribeSshCleanupProgress: (listener) =>
      onNotification('connections/ssh/cleanupProgress', (p) => {
        // The server id the core adds names the server; the progress the window shows is the operation's.
        const { id: _server, ...progress } = asRecord(p);
        listener(progress as never);
      }),
    subscribeSshServerLoginUpdated: (listener) =>
      onNotification('connections/ssh/serverLoginUpdated', (p) => listener(p as never)),
    subscribeConnectionLink: (listener) => onKey(`link/${connectionId()}`, listener as (value: unknown) => void),
    subscribeConnectionNotice: (listener) =>
      onNotificationWithFeed('connections/notice', (p) => {
        const { connectionId: from, notice } = asRecord(p);
        if (from === connectionId()) listener(notice as never);
      }),
    subscribeConnectionSignIn: (listener) => onNotificationWithFeed('connections/signIn', (p) => listener(p as never)),
    subscribeServerPorts: (listener) => onKey(`ports/${connectionId()}`, listener as (value: unknown) => void),
    subscribeServerRestoreProgress: (listener) => {
      // The list holds the reopenings still running or failed: one that left it is ready, and the window hears so.
      let shown = new Map<string, string>();
      return onKey<{ progress?: unknown }>('restore', (value) => {
        const entries = (Array.isArray(value?.progress) ? value.progress : []).map(asRecord);
        const now = new Map(entries.map((entry) => [String(entry.id), String(entry.name ?? '')]));
        for (const [id, name] of shown) if (!now.has(id)) listener({ id, name, phase: 'ready' });
        shown = now;
        for (const progress of entries) listener(progress as never);
      });
    },
    subscribeSshHostsChanged: (listener) => onKey('hosts', () => listener()),
  };
  return api;
}

const clientChangeListeners = new Set<() => void>();
/** The window's connection closed or replaced its client: the window's connections api re-reads which client is open. */
export const releaseConnectionsClient = (): void => {
  for (const listener of [...clientChangeListeners]) listener();
};

const defaults = createConnectionsCoreApi({
  client: pcCoreClient,
  onClientChange: (listener) => {
    clientChangeListeners.add(listener);
    return () => void clientChangeListeners.delete(listener);
  },
  opening: firstPcCoreOpen,
  connection: () => window.mixdogDesktop?.connection,
  openExternal: (url) => window.mixdogDesktop.openExternal(url),
});

/** The window's one instance: the components call its functions, and install.ts hands the same ones out as DesktopApi members. */
export const connectionsApi = defaults;

export const {
  sshListHosts,
  sshRenameHost,
  sshForgetHost,
  sshOpenHost,
  sshConfigHosts,
  sshInspectHostKey,
  sshConnect,
  sshCancel,
  sshAskpassReply,
  sshCleanupHost,
  sshCleanupTarget,
  sshUpdateHostSettings,
  sshServerLogins,
  sshServerLoginBegin,
  sshServerLoginStatus,
  sshServerLoginComplete,
  sshServerLoginCancel,
  sshServerLoginSaveKey,
  sshServerLoginLogout,
  sshServerLoginRemoveCustom,
  sshDiagnosticsLog,
  sshDiagnosticsCopy,
  sshServerLog,
  getConnectionLink,
  retryConnection,
  retryConnectionNow,
  getReopenServerWindows,
  setReopenServerWindows,
  getServerRestoreProgress,
  listServerPorts,
  forwardServerPort,
  stopServerPortForward,
  dismissServerPort,
  openServerPortInBrowser,
  requestConnectionSignIn,
  subscribeSshAskpass,
  subscribeSshProgress,
  subscribeSshCleanupProgress,
  subscribeSshServerLoginUpdated,
  subscribeConnectionLink,
  subscribeConnectionNotice,
  subscribeConnectionSignIn,
  subscribeServerPorts,
  subscribeServerRestoreProgress,
  subscribeSshHostsChanged,
} = defaults;
