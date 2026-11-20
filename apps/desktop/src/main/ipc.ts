// Explicit handler/preload registration:
// arbitrary renderer-selected method execution is intentionally absent.
// Each handler family lives in its own ipc-*.ts module; this file owns the
// sender guard, the service-operation table, and the disposer.
import type {
  App,
  BrowserWindow,
  Dialog,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  PowerMonitor,
  Shell,
} from 'electron';

import { DESKTOP_IPC } from '../shared/contract';
import { ipcErrorEnvelope } from '../shared/coded-error';
import { translateNativeUi } from '../shared/native-ui';
import type { DesktopService } from './desktop-service-contract';
import type { DesktopSettingsStore } from './settings-store';
import type { BrowserHost } from './browser/host-types';
import type { BrowserLoginPopup } from './browser/login-popup';
import { registerBrowserIpc } from './ipc-browser';
import type { ProtocolConnection } from './protocol/connection';
import { registerComputerIpc, type ComputerIpcHost } from './ipc-computer';
import { registerFileDialogIpc } from './ipc-file-dialogs';
import { registerPaneLayoutIpc } from './ipc-pane-layout';
import type { PaneLayoutFile } from './pane-layout-file';
import { registerProjectIpc } from './ipc-projects';
import { coreErrorForWindow } from './protocol/core-error';
import type { DesktopComputerInputAccess } from '../shared/contract-computer';
import { registerProjectFileIpc } from './ipc-project-files';
import { registerSessionIpc } from './ipc-sessions';
import type { RemoteHostWindows } from './remote-host-windows';
import { registerSourceControlIpc } from './ipc-source-control';
import { DesktopStateBridge, type DesktopUpdater } from './ipc-state-bridge';
import { registerWindowSettingsIpc } from './ipc-window-settings';
import type { PcQuotaHost } from './ipc-host-extras';
import { createAllowAllActionsConfirm } from './developer-risk-confirm';
import { registerHostExtrasIpc } from './ipc-host-extras';
import { CORE_PORT_OPEN_CHANNEL, CORE_PORT_RETRY_CHANNEL, type CorePortRelay, type CoreSlot } from './core-port/relay';
import { raiseDesktopWindow } from './notification-window';
import { createSignInFocus } from './sign-in-focus';
import { createCoreFileGrants } from './core-file-grants';
import { registerScreenSessions } from './screen-sessions';
import { registerRendererProbeIpc } from './renderer-probe';
import type { ConnectionKind } from './connections/contract';
import { connectionFeatureGate } from './connections/feature-gates';
import {
  requiredAttachmentFile,
  requiredVisualizeCaptureRect,
  requiredVisualizeGestureTarget,
  requiredVisualizePanelSize,
  requiredVisualizeTabCommand,
} from './ipc-validation';
import { createServerFiles, serverCoreInvoke, uploadServerBytes } from './server-file-access';
import { serverUploadCoordinatorFor } from './server-upload-coordinator';
import type { DesktopVisualize } from './visualize/host';
import type { VisualizeService } from './visualize/service';

/** The ipcMain surface one window's registration uses: Electron's ipcMain or
 *  that window's connection-router scope (connections/ipc-router). */
export interface DesktopIpcMain {
  handle: IpcMain['handle'];
  removeHandler: IpcMain['removeHandler'];
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): unknown;
  removeListener(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): unknown;
}

/** A sender-guarded `ipcMain.handle`, shared by every handler family. */
export type IpcHandle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

interface DesktopIpcDependencies {
  app: Pick<App, 'quit'> & Partial<Pick<App, 'getPath' | 'getLocale'>>;
  translateUi?: (key: string) => string;
  ipcMain: DesktopIpcMain;
  dialog: Pick<Dialog, 'showOpenDialog'> & Partial<Pick<Dialog, 'showSaveDialog'>>;
  shell: Pick<Shell, 'openPath' | 'openExternal' | 'showItemInFolder' | 'trashItem'>;
  powerMonitor?: Pick<PowerMonitor, 'on' | 'removeListener'>;
  settingsStore?: Pick<DesktopSettingsStore, 'readZoom' | 'updateZoom'>;
  /** Settings → Notifications: play the notification sound at the saved volume. */
  previewNotificationSound?: () => Promise<string>;
  /** Browser Use pane: local profile import without renderer-visible secrets. */
  browserHost?: Pick<
    BrowserHost,
    | 'browserImportSources'
    | 'browserImport'
    | 'browserCookieAutoImportStatus'
    | 'browserCookieAutoImportConfigure'
    | 'browserCookieAutoImportForgetKey'
    | 'browserHistorySearch'
    | 'releaseSession'
    | 'setGuestActive'
    | 'browserPanelShown'
    | 'configureGuestViewport'
    | 'browserCredentialSuggestions'
    | 'browserCredentialFill'
    | 'browserPageFrame'
    | 'browserPageControl'
    | 'browserPageMetadata'
    | 'browserPresentNative'
    | 'browserPageIdentity'
    | 'browserSignedInSites'
    | 'browserSignOutSite'
    | 'browserClearSignIns'
    | 'browserVaultLogins'
    | 'browserVaultSave'
    | 'browserVaultDelete'
    | 'browserLinkedSignIns'
    | 'browserLinkedSignInDelete'
  >;
  /** Login takeovers' sign-in windows (this PC's window only). */
  browserLogin?: Pick<BrowserLoginPopup, 'open' | 'status'>;
  /** Extensions → Computer Use: OS readiness reads and one-press fixes. */
  computer?: ComputerIpcHost;
  /** Agent `visualize` tabs (this PC's window only). */
  visualize?: Pick<VisualizeService, 'snapshot' | 'command' | 'paneText' | 'setPanelSize'> &
    Partial<Pick<DesktopVisualize, 'attachFeedback' | 'captureRect' | 'consumeChoiceGesture'>>;
  /** Settings → Connection / command surface: connect to another PC. */
  remoteHosts?: RemoteHostWindows;
  updater?: DesktopUpdater;
  /** The kind of daemon connection `host` is: a server (`ssh`) window refuses
   *  every feature that acts on this PC (see connections/feature-gates). */
  connectionKind?: ConnectionKind;
  /** The window's connection id (a server window's: the id of this PC's link to the server, which its downloads go through). */
  serverId?: string;
  /** This PC's own daemon, for a server window: the sign-ins a server's model
   *  calls run on are this PC's, so their quota reads are answered here. */
  pcHost?: PcQuotaHost;
  /** This window's pane layout file in the profile (see pane-layout-file.ts). */
  paneLayoutFile?: PaneLayoutFile;
  /** The connection's protocol link: pushed sections and detail calls for the renderer. */
  protocol?: ProtocolConnection | null;
  /** This PC's own core connection (what reads this computer, e.g. its installed fonts); the window's own when absent. */
  pcCore?: ProtocolConnection | null;
  prepareConfirmedAllowAllActions?: () => (() => Promise<unknown>) | undefined;
  /** Hands the window its own MessagePort to its core (and, for a server window, to this PC's): the renderer's direct lane. */
  corePort?: Pick<CorePortRelay, 'open' | 'retryLaunch'>;
}

export function registerDesktopIpc(
  window: BrowserWindow,
  host: DesktopService,
  {
    app,
    translateUi,
    ipcMain,
    dialog,
    shell,
    powerMonitor: powerMonitorRef,
    settingsStore,
    previewNotificationSound,
    browserHost,
    browserLogin,
    updater,
    computer,
    remoteHosts,
    visualize,
    connectionKind = 'local',
    serverId,
    pcHost,
    paneLayoutFile,
    protocol,
    pcCore,
    prepareConfirmedAllowAllActions,
    corePort,
  }: DesktopIpcDependencies
): () => void {
  const nativeT = translateUi || ((key: string) => translateNativeUi(app.getLocale?.() || 'en', key));
  // This PC's core: what reads or writes this computer (a saved file, an attachment, a chat link, the input-access rule) is answered by it.
  const localCore = pcCore ?? protocol ?? null;
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('IPC call rejected.');
    }
  };
  const handle: IpcHandle = (channel, listener) => {
    ipcMain.handle(channel, (event, ...args) => {
      assertSender(event);
      const refused = connectionFeatureGate(connectionKind, channel);
      if (refused) throw refused;
      // Custom Error properties do not survive Electron's invoke, so a
      // refusal with a structured code is returned as an envelope the
      // preload turns back into an Error with that code.
      const refusal = (error: unknown): unknown => {
        const envelope = ipcErrorEnvelope(error);
        if (envelope) return envelope;
        throw error;
      };
      // The listener still starts in this tick: handlers' call order matters.
      try {
        const result = listener(event, ...args);
        return result instanceof Promise ? result.catch(refusal) : result;
      } catch (error) {
        return refusal(error);
      }
    });
  };
  const invokeDesktopOperation = <T>(method: string, args: unknown[]): Promise<T> =>
    host.invokeDesktopOperation(method, args) as Promise<T>;
  // This PC's one-file grants (picked, dropped, linked files) are kept and redeemed by the core.
  const selectedFiles = createCoreFileGrants(invokeDesktopOperation);
  // A server window's files live on the server: its one-file grants name
  // server paths (agent output links, uploads) and its bytes travel over the
  // window's own connection. This PC's selected-file grants never apply there.
  const downloadsDir = () => (typeof app.getPath === 'function' ? app.getPath('downloads') : '');
  const server =
    connectionKind === 'ssh'
      ? createServerFiles({
          invoke: invokeDesktopOperation,
          core: serverCoreInvoke(pcCore ?? protocol),
          serverId: serverId ?? '',
          listProjects: () => host.listProjects(),
          session: () => window.webContents.session,
          downloadsDir,
        })
      : null;
  const grantedFile = async (accessToken: unknown, projectPath: unknown, relPath: unknown) =>
    server
      ? server.grants.requireGrant(accessToken, projectPath, relPath)
      : selectedFiles.requireGrant(accessToken, projectPath, relPath);
  // A chat link opens wherever it is, so main hands back the file's folder as
  // its root instead of a one-off grant. The picker and drop keep their grants.
  const describeLocalPaths = (value: unknown, _sessionId?: unknown, options?: unknown) =>
    server
      ? server.grants.describe(value)
      : selectedFiles.describe(value, (options as { chatLink?: unknown } | undefined)?.chatLink !== true);
  // The server connection's one upload coordinator: this window's file uploads and its attachment staging draw on the same
  // allowance as every other window of that server (it is found from the connection, so no window owns it).
  const serverUploads = server && protocol ? serverUploadCoordinatorFor(protocol) : null;
  const stagingOwner = {};
  const stageAttachment = server
    ? async (dataUrl: unknown, name: unknown) => {
        if (!serverUploads) throw new Error('The server connection is not available.');
        const file = requiredAttachmentFile(dataUrl, name);
        const uploaded = await uploadServerBytes(
          serverUploads,
          stagingOwner,
          file.bytes,
          `${file.baseName}.${file.extension}`,
          'transcript'
        );
        return server.grants.entry(uploaded.absolutePath, uploaded);
      }
    : undefined;

  registerFileDialogIpc({
    window,
    connectionKind,
    dialog,
    host,
    handle,
    invokeDesktopOperation,
    nativeT,
    describeLocalPaths,
    core: localCore,
  });
  registerProjectIpc({ handle, host, shell, core: localCore });
  handle(DESKTOP_IPC.requestLinuxInputAccess, async () => {
    if (!localCore) throw new Error('The core connection is not available.');
    try {
      // `desktop/computer/inputAccess/request`: the core installs the /dev/uinput rule once (one polkit prompt) and answers the outcome.
      return (await localCore.call('desktop/computer/inputAccess/request', {})) as DesktopComputerInputAccess;
    } catch (error) {
      throw coreErrorForWindow(error);
    }
  });
  const disposeProjectFileIpc = registerProjectFileIpc({
    handle,
    host,
    invokeDesktopOperation,
    shell,
    grantedFile,
    server,
    uploads: serverUploads,
  });
  registerSessionIpc({ handle, remoteHosts, core: protocol });
  registerBrowserIpc({ handle, browserHost, browserLogin });
  registerComputerIpc({ handle, shell, computer, invokeDesktopOperation });
  handle(DESKTOP_IPC.visualizeState, () => visualize?.snapshot() ?? []);
  handle(DESKTOP_IPC.visualizeCommand, async (_event, command) =>
    visualize?.command(requiredVisualizeTabCommand(command))
  );
  handle(DESKTOP_IPC.visualizePaneText, async (_event, sessionId, tabId, index) => {
    if (!visualize) throw new Error('Visualize is unavailable.');
    const target = requiredVisualizeGestureTarget({ sessionId, tabId, pane: index });
    return visualize.paneText(target.sessionId, target.tabId, target.pane);
  });
  handle(DESKTOP_IPC.visualizePanelSize, (_event, size) => {
    visualize?.setPanelSize(requiredVisualizePanelSize(size));
  });
  handle(DESKTOP_IPC.visualizeFeedbackAttach, async (_event, sessionId, tabId) => {
    const target = requiredVisualizeTabCommand({ sessionId, tabId, action: 'activate' });
    await visualize?.attachFeedback?.(target.sessionId, target.tabId);
  });
  handle(DESKTOP_IPC.visualizeCaptureRect, async (_event, rect) => {
    if (!visualize?.captureRect) throw new Error('Visualize capture is unavailable.');
    return visualize.captureRect(requiredVisualizeCaptureRect(rect));
  });
  handle(
    DESKTOP_IPC.visualizeConsumeGesture,
    async (_event, target) => (await visualize?.consumeChoiceGesture?.(requiredVisualizeGestureTarget(target))) === true
  );
  const confirmAllowAllActions = createAllowAllActionsConfirm({ window, nativeT });
  registerWindowSettingsIpc({ window, app, handle, invokeDesktopOperation, settingsStore, previewNotificationSound });
  const disposeHostExtrasIpc = registerHostExtrasIpc({
    handle,
    removeHandler: (channel) => ipcMain.removeHandler(channel),
    host,
    pcHost: connectionKind === 'local' ? undefined : pcHost,
    confirmAllowAllActions,
    prepareConfirmedAllowAllActions,
    signInFocus: connectionKind === 'local' ? createSignInFocus({ activate: () => raiseDesktopWindow(window) }) : null,
  });

  const stateBridge = new DesktopStateBridge({
    window,
    host,
    ipcMain,
    handle,
    powerMonitor: powerMonitorRef,
    updater,
    // A window with a core port reads and recovers state on that connection, even when the port has to reopen.
    directCore: Boolean(corePort),
  });
  // The renderer's direct lane: `window.mixdogCorePort.open({slot})` (preload/core-port.ts) asks for the port.
  if (corePort) {
    handle(CORE_PORT_OPEN_CHANNEL, (event, options) => {
      const slot: CoreSlot = (options as { slot?: unknown } | null | undefined)?.slot === 'pc' ? 'pc' : 'primary';
      return corePort.open(event.sender as unknown as Parameters<CorePortRelay['open']>[0], slot);
    });
    handle(CORE_PORT_RETRY_CHANNEL, () => corePort.retryLaunch());
  }
  // Renderer perf lines ride a fire-and-forget event channel (no invoke).
  const onPerfLog = (_event: Electron.IpcMainEvent, line: unknown): void => {
    (host as { perfLog?: (line: string) => void }).perfLog?.(String(line ?? ''));
  };
  ipcMain.on(DESKTOP_IPC.perfLog, onPerfLog);
  const disposeRendererProbe = registerRendererProbeIpc({ window, ipcMain, handle });
  // What this window paints, for the completion-notification rule.
  const disposeScreenSessions = registerScreenSessions(window, ipcMain);
  const disposePaneLayoutIpc = registerPaneLayoutIpc({ window, ipcMain, file: paneLayoutFile });
  registerSourceControlIpc({
    app,
    handle,
    shell,
    grantedFile,
    describeLocalPaths,
    stageAttachment,
    core: localCore,
  });
  const eventChannels = new Set<string>([
    DESKTOP_IPC.state,
    DESKTOP_IPC.sessionState,
    DESKTOP_IPC.sessionStateResync,
    DESKTOP_IPC.sessionsChanged,
    DESKTOP_IPC.agentPoolChanged,
    DESKTOP_IPC.stateResync,
    DESKTOP_IPC.updaterState,
    DESKTOP_IPC.perfLog,
    DESKTOP_IPC.rendererProbeLog,
    DESKTOP_IPC.reportScreenSessions,
    DESKTOP_IPC.rendererDiagnostic,
    DESKTOP_IPC.readPaneLayoutFile,
    DESKTOP_IPC.writePaneLayoutFile,
    DESKTOP_IPC.termWrite,
    DESKTOP_IPC.termResize,
    DESKTOP_IPC.termAcknowledge,
    DESKTOP_IPC.termData,
    DESKTOP_IPC.termSizeOwner,
    DESKTOP_IPC.termActivityChanged,
    DESKTOP_IPC.termFocus,
    DESKTOP_IPC.lspDiagnostics,
    DESKTOP_IPC.lspStatus,
    DESKTOP_IPC.remoteClientClaim,
    DESKTOP_IPC.remoteAccessSettingsChanged,
    DESKTOP_IPC.conversationImportProgress,
  ]);
  const channels = Object.values(DESKTOP_IPC).filter((channel) => !eventChannels.has(channel));
  let removed = false;

  return () => {
    if (removed) return;
    removed = true;
    stateBridge.dispose();
    void server?.dispose();
    disposeProjectFileIpc();
    serverUploads?.releaseOwner(stagingOwner);
    disposeHostExtrasIpc();
    ipcMain.removeListener(DESKTOP_IPC.perfLog, onPerfLog);
    disposeRendererProbe();
    disposeScreenSessions();
    disposePaneLayoutIpc();
    for (const channel of channels) ipcMain.removeHandler(channel);
    if (corePort) {
      ipcMain.removeHandler(CORE_PORT_OPEN_CHANNEL);
      ipcMain.removeHandler(CORE_PORT_RETRY_CHANNEL);
    }
  };
}
