import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import type { DesktopApi } from '../shared/contract';
import type { DesktopSshForgetResult } from '../shared/contract-ssh';
import type { DesktopConnectionIdentity } from '../shared/contract-workspace';
import { firstPcCoreOpen, pcCoreClient } from './core-direct/client.ts';
import { withDirectErrors } from './core-direct/errors.ts';
import { asRecord, createCoreFeed, type LooseClient, NO_CORE } from './connections-core-feed.ts';

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

  const { onNotification, onKey, onNotificationWithFeed } = createCoreFeed(deps, pendingOpen);

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
