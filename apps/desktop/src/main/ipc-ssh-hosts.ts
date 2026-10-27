// IPC for the SSH server list and the connect dialog: saved servers, ~/.ssh/config
// aliases, the host-key pre-check, connecting (with progress and the interactive
// login questions), per-server settings and the cleanup of a server. The
// connection manager is injected; opening the server window is its job.
//
// Every handler answers only this PC's own app window (its main frame, routed
// to the local connection). A connection is a main-minted attempt: the host-key
// pre-check opens it for one window and one address, freezes what it saw, and
// connect / cancel name it. Nothing the renderer sends later
// changes the address, the key or the pid main acts on.
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { DESKTOP_IPC } from '../shared/contract-ipc';
import type {
  DesktopSshAgentStatus,
  DesktopSshCleanupProgress,
  DesktopSshConfigHost,
  DesktopSshConnectRequest,
  DesktopSshConnectResult,
  DesktopSshHost,
} from '../shared/contract-ssh';
import { LOCAL_CONNECTION_ID, type ConnectionManager } from './connections/contract';
import type { WindowRouteRegistry } from './connections/window-routes';
import { cleanupRemoteServer } from './ssh/remote-cleanup';
import { detectSshAgent } from './ssh/ssh-agent';
import { startAskpassSession } from './ssh/ssh-auth';
import { configureMixdogSsh } from './ssh/mixdog-ssh-config';
import { prepareTargetSshConfig } from './ssh/ssh-resolved-config';
import { runWithSshContext, type SshRunContext } from './ssh/ssh-context';
import { inspectHostKey, pinHostKey, replaceHostKey, runTool, type HostKeyInspection } from './ssh/host-key';
import { parseSshTarget, type SshTarget } from './ssh/ssh-command';
import { readSshConfigHosts } from './ssh/ssh-config';
import {
  configureSshHostStore,
  DEFAULT_GRACE_MINUTES,
  sharedSshHostStore,
  type SshHostRecord,
  type SshHostStore,
} from './ssh/ssh-host-store';
import { diagnosticsKeyFor } from './ssh/ssh-diagnostics';
import { createAttemptRegistry } from './ssh/ssh-ipc-attempts';
import { createConnectHandlers, createInspectHandler } from './ssh/ssh-ipc-connect';
import { createCleanupHandler } from './ssh/ssh-ipc-cleanup';
import { createLoginRetry } from './ssh/ssh-ipc-login';
import { createDiagnosticsHandlers } from './ssh/ssh-ipc-diagnostics';
import { createHostListHandlers } from './ssh/ssh-ipc-host-list';
import { createServerLoginHandlers, type ServerLoginDeps } from './ssh/ssh-ipc-server-logins';
import { text } from './ssh/ssh-ipc-input';

export interface SshHostIpcDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  /** webContents.id → connection id of the app windows (read only). */
  routes: Pick<WindowRouteRegistry, 'connectionIdFor'>;
  /** Where ssh-hosts.json and the askpass helper live. */
  userDataPath: string;
  connections: ConnectionManager;
  /** Removes Mixdog from the server; defaults to ssh/remote-cleanup.ts. */
  cleanupRemoteServer?: (
    target: string,
    options: {
      removeUserData: boolean;
      onProgress?: (progress: { phase: DesktopSshCleanupProgress['phase']; detail?: string }) => void;
    }
  ) => Promise<unknown>;
  platform?: NodeJS.Platform;
  /** Test seams; the defaults talk to the system OpenSSH tools. */
  inspect?: (target: SshTarget) => Promise<HostKeyInspection>;
  pin?: typeof pinHostKey;
  replaceKey?: typeof replaceHostKey;
  readConfigHosts?: () => Promise<DesktopSshConfigHost[]>;
  detectAgent?: () => Promise<DesktopSshAgentStatus>;
  startAskpass?: typeof startAskpassSession;
  /** Prepares Mixdog's own ssh config and known_hosts (ssh/mixdog-ssh-config.ts). */
  configureSsh?: () => Promise<void>;
  now?: () => number;
  /** The app version shown in copied diagnostics. */
  appVersion?: string;
  /** Test seam: the tail of the server's daemon.log. */
  readServerLog?: (target: SshTarget) => Promise<string>;
  /** Test seam for `ssh -V` / `ssh -G` in the copied diagnostics. */
  diagnosticsRun?: typeof runTool;
  /** The attached servers whose provider logins the settings manage, this
   *  PC's browser and the callback forward; without it no server is attached. */
  serverLogins?: Omit<ServerLoginDeps, 'store'>;
}

const NO_SERVER_LOGINS: Omit<ServerLoginDeps, 'store'> = {
  connection: () => null,
  openExternal: async () => {
    throw new Error('No browser is available.');
  },
  forwardCallback: async () => {
    throw new Error('No callback forward is available.');
  },
};

async function inspectWithForwards(target: SshTarget): Promise<HostKeyInspection> {
  const inspection = await inspectHostKey(target);
  if (inspection.check.status === 'unreachable') return inspection;
  // Mixdog's ssh runs with what ssh resolves for this server, minus every forward; when that cannot be built faithfully the user's config applies and its forwards are listed.
  const { forwards } = await prepareTargetSshConfig(runTool, target).catch(() => ({ forwards: [] as string[] }));
  return forwards.length > 0 && inspection.summary
    ? { ...inspection, summary: { ...inspection.summary, forwards } }
    : inspection;
}

/** Registers the handlers once for the app; returns the disposer. */
export function registerSshHostIpc(deps: SshHostIpcDeps): () => void {
  const { ipcMain, connections, routes } = deps;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const inspect = deps.inspect ?? inspectWithForwards;
  const pin = deps.pin ?? pinHostKey;
  const replaceKey = deps.replaceKey ?? ((replace) => replaceHostKey(replace));
  const readConfig = deps.readConfigHosts ?? (() => readSshConfigHosts());
  const agentStatus = deps.detectAgent ?? (() => detectSshAgent(runTool, platform));
  const startAskpass = deps.startAskpass ?? startAskpassSession;
  const cleanupServer = deps.cleanupRemoteServer ?? cleanupRemoteServer;
  // Mixdog's own known_hosts and ssh config are ready before the first check or connection; without them ssh falls back to the user's files.
  const configured = (
    deps.configureSsh ?? (() => configureMixdogSsh({ userDataPath: deps.userDataPath, run: runTool }))
  )().catch(() => undefined);
  configureSshHostStore(deps.userDataPath);
  const store = (): Promise<SshHostStore> => sharedSshHostStore(deps.userDataPath);
  /** The ssh context of a saved server: its settings (the grace period always set) and the diagnostics ring its ssh runs write to. */
  const contextFor = (record: SshHostRecord, extra: SshRunContext = {}): SshRunContext => ({
    ...extra,
    settings: { ...record.settings, graceMinutes: record.settings?.graceMinutes ?? DEFAULT_GRACE_MINUTES },
    diagnosticsKey: diagnosticsKeyFor(parseSshTarget(record.target)),
  });
  const attempts = createAttemptRegistry(connections);

  /** Only this PC's own app windows may manage SSH servers: the sender's main
   *  frame, in a window the route registry routes to the local connection. */
  const senderRoute = ({ sender, senderFrame }: IpcMainInvokeEvent): string => {
    const route =
      sender.isDestroyed() || !senderFrame || senderFrame !== sender.mainFrame
        ? undefined
        : routes.connectionIdFor(sender.id);
    if (!route) throw new Error('SSH servers can only be managed from this PC’s main window.');
    return route;
  };
  const authorize = (event: IpcMainInvokeEvent): void => {
    if (senderRoute(event) !== LOCAL_CONNECTION_ID)
      throw new Error('SSH servers can only be managed from this PC’s main window.');
  };

  const view = (record: SshHostRecord): DesktopSshHost => ({ ...record, open: connections.isOpen(record.id) });
  const views = async (): Promise<DesktopSshHost[]> => (await store()).list().map(view);

  const withLogin = createLoginRetry({
    startAskpass,
    askInWindow: attempts.askInWindow,
    agentStatus,
    userDataPath: deps.userDataPath,
    platform,
  });

  const { open, connect } = createConnectHandlers({
    connections,
    attempts,
    store,
    contextFor,
    view,
    withLogin,
    configured,
    pin,
    replaceKey,
    now,
    platform,
  });

  const cleanup = createCleanupHandler({ connections, store, views, contextFor, withLogin, cleanupServer, platform });

  const inspectHostKeyHandler = createInspectHandler({ attempts, configured, inspect });
  // The restart dials the server again: under the server's saved settings
  // (its key file), in batch mode like any automatic reconnect.
  const hostList = createHostListHandlers(store, views, async (id, modelLogin) => {
    const record = (await store()).get(id);
    if (record) await runWithSshContext(contextFor(record), () => connections.applyModelLogin?.(id, modelLogin));
  });
  const serverLogins = createServerLoginHandlers({ ...(deps.serverLogins ?? NO_SERVER_LOGINS), store });
  const diagnostics = createDiagnosticsHandlers({
    senderRoute,
    store,
    contextFor,
    run: deps.diagnosticsRun ?? runTool,
    appVersion: deps.appVersion,
    readServerLog: deps.readServerLog,
  });

  /** The third entry: also answered in a server window (about its own server only). */
  const handlers: Array<[string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown, boolean?]> = [
    [DESKTOP_IPC.sshListHosts, () => views()],
    [DESKTOP_IPC.sshRenameHost, (_event, id, name) => hostList.rename(id, name)],
    [DESKTOP_IPC.sshUpdateHostSettings, (_event, id, settings) => hostList.updateSettings(id, settings)],
    [DESKTOP_IPC.sshServerLogins, (_event, id) => serverLogins.logins(id)],
    [DESKTOP_IPC.sshServerLoginBegin, (_event, id, provider) => serverLogins.begin(id, provider)],
    [DESKTOP_IPC.sshServerLoginStatus, (_event, id, flowId) => serverLogins.status(id, flowId)],
    [
      DESKTOP_IPC.sshServerLoginComplete,
      (_event, id, flowId, redirectUrl) => serverLogins.complete(id, flowId, redirectUrl),
    ],
    [DESKTOP_IPC.sshServerLoginCancel, (_event, id, flowId) => serverLogins.cancel(id, flowId)],
    [DESKTOP_IPC.sshServerLoginSaveKey, (_event, id, provider, key) => serverLogins.saveKey(id, provider, key)],
    [DESKTOP_IPC.sshServerLoginLogout, (_event, id, provider) => serverLogins.logout(id, provider)],
    [DESKTOP_IPC.sshServerLoginRemoveCustom, (_event, id, provider) => serverLogins.removeCustomProvider(id, provider)],
    [
      DESKTOP_IPC.sshForgetHost,
      async (_event, id) => {
        const hosts = await hostList.forget(id);
        serverLogins.forgetHost(id);
        return hosts;
      },
    ],
    [DESKTOP_IPC.sshConfigHosts, () => readConfig()],
    [DESKTOP_IPC.sshInspectHostKey, (event, rawTarget) => inspectHostKeyHandler(event, rawTarget)],
    [
      // Only focuses a server whose window is already open; a connection that
      // starts from nothing goes through inspect → confirm → connect.
      DESKTOP_IPC.sshOpenHost,
      async (_event, id): Promise<DesktopSshConnectResult> => {
        const record = (await store()).get(text(id, 'id'));
        if (!record) throw new Error('This SSH server is no longer saved.');
        if (!connections.isOpen(record.id))
          throw new Error('This SSH server is not connected. Connect it from the SSH server dialog.');
        return open(record, parseSshTarget(record.target));
      },
    ],
    [DESKTOP_IPC.sshConnect, (event, request) => connect(event, request as DesktopSshConnectRequest | undefined)],
    [DESKTOP_IPC.sshCancel, (event, attemptId) => attempts.cancelFor(event, attemptId)],
    [
      DESKTOP_IPC.sshAskpassReply,
      async (event, _attemptId, requestId, secret) => attempts.answer(event, requestId, secret),
    ],
    [DESKTOP_IPC.sshCleanupHost, (event, id, request) => cleanup(event, id, request)],
    [DESKTOP_IPC.sshDiagnosticsLog, (event, ref) => diagnostics.log(event, ref), true],
    [DESKTOP_IPC.sshDiagnosticsCopy, (event, ref) => diagnostics.copy(event, ref), true],
    [DESKTOP_IPC.sshServerLog, (event, ref) => diagnostics.serverLog(event, ref), true],
  ];
  for (const [channel, handler, anyWindow] of handlers) {
    // Async, so a refused sender rejects like any other failure.
    ipcMain.handle(channel, async (event, ...args) => {
      if (anyWindow) senderRoute(event);
      else authorize(event);
      return handler(event, ...args);
    });
  }
  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
    void serverLogins.dispose();
  };
}
