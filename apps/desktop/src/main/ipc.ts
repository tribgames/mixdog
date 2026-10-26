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

import { resolve as resolvePath } from 'node:path';
import { DESKTOP_IPC, type DesktopRemoteAccessInfo, type DesktopSettings } from '../shared/contract';
import { ipcErrorEnvelope } from '../shared/coded-error';
import { translateNativeUi } from '../shared/native-ui';
import type { DesktopService } from './desktop-service-contract';
import type { DesktopSettingsStore } from './settings-store';
import type { BrowserHost } from './browser/host';
import type { BrowserLoginPopup } from './browser/login-popup';
import { registerBrowserIpc } from './ipc-browser';
import { registerComputerIpc, type ComputerIpcHost } from './ipc-computer';
import { registerFileDialogIpc } from './ipc-file-dialogs';
import { registerPaneLayoutIpc } from './ipc-pane-layout';
import type { PaneLayoutFile } from './pane-layout-file';
import { registerProjectIpc } from './ipc-projects';
import { requestLinuxInputAccess } from './linux-input-access';
import { registerProjectFileIpc } from './ipc-project-files';
import { registerSessionIpc } from './ipc-sessions';
import { type NotificationIpcHost, registerNotificationIpc } from './ipc-notifications';
import type { RemoteHostWindows } from './remote-host-windows';
import { registerSourceControlIpc } from './ipc-source-control';
import { DesktopStateBridge, type DesktopUpdater } from './ipc-state-bridge';
import { registerTerminalIpc, type DesktopTerminalHost } from './ipc-terminal';
import { registerWindowSettingsIpc, type PcQuotaHost } from './ipc-window-settings';
import { createAllowAllActionsConfirm } from './developer-risk-confirm';
import { SelectedFileAccess } from './selected-file-access';
import { registerScreenSessions } from './screen-sessions';
import type { ConnectionKind } from './connections/contract';
import { connectionFeatureGate } from './connections/feature-gates';
import {
  requiredAttachmentFile,
  requiredVisualizeCaptureRect,
  requiredVisualizeGestureTarget,
  requiredVisualizePanelSize,
  requiredVisualizeTabCommand,
} from './ipc-validation';
import { createServerFiles, uploadServerBytes } from './server-file-access';
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

const SERVICE_OPERATION_NAMES = [
  'githubStarStatus',
  'starGithub',
  'gitCliStatus',
  'installGitCli',
  'libreOfficeStatus',
  'installLibreOffice',
  'githubCliStatus',
  'installGithubCli',
  'githubCliLoginStart',
  'githubCliLoginStatus',
  'githubCliLoginOpenBrowser',
  'cancelGithubCliLogin',
  'githubCliLogout',
  'githubCliAccount',
  'gitGlobalConfig',
  'setGitGlobalConfig',
  'notifySettingsChanged',
  'gitAbortOperation',
  'gitAmend',
  'gitApplyPatch',
  'gitBranches',
  'gitCherryPickCommit',
  'gitCommit',
  'gitCommitPaths',
  'gitContinue',
  'gitCreateTag',
  'gitDeleteBranch',
  'gitDeleteTag',
  'gitDiff',
  'gitFetch',
  'gitIgnore',
  'gitLog',
  'gitPull',
  'gitPush',
  'gitRenameBranch',
  'gitResetToCommit',
  'gitRevertCommit',
  'gitRevertFile',
  'gitReview',
  'gitReviewDiff',
  'gitReviewDiffs',
  'gitShow',
  'gitShowDiff',
  'gitShowFile',
  'gitRequestContext',
  'gitStage',
  'gitStash',
  'gitStashApply',
  'gitStashDrop',
  'gitStashList',
  'gitStashPop',
  'gitStatus',
  'gitSync',
  'gitUndoLastCommit',
  'gitUnstage',
  'ghPrCheckout',
  'ghPrCreate',
  'ghPrDefaultBranch',
  'ghPrDiff',
  'ghPrList',
  'ghPrMerge',
  'ghPrView',
  'githubRequest',
] as const;

interface DesktopIpcDependencies {
  app: Pick<App, 'quit'> & Partial<Pick<App, 'getPath' | 'getLocale'>>;
  translateUi?: (key: string) => string;
  ipcMain: DesktopIpcMain;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'> & Partial<Pick<Dialog, 'showSaveDialog'>>;
  shell: Pick<Shell, 'openPath' | 'openExternal' | 'showItemInFolder' | 'trashItem'>;
  powerMonitor?: Pick<PowerMonitor, 'on' | 'removeListener'>;
  settingsStore?: Pick<
    DesktopSettingsStore,
    'read' | 'update' | 'updateNotificationVolume' | 'readZoom' | 'updateZoom'
  >;
  /** Fires after a successful desktop-settings write (keep-awake wiring). */
  onDesktopSettingsChanged?: (settings: DesktopSettings) => void;
  /** Settings → Notifications: play the notification sound at the saved volume. */
  previewNotificationSound?: () => Promise<string>;
  /** Settings → Notifications: this PC's OS notifications (this PC's window only). */
  notifications?: NotificationIpcHost;
  /** Browser Use pane: local profile import without renderer-visible secrets. */
  browserHost?: Pick<
    BrowserHost,
    | 'browserImportSources'
    | 'browserImport'
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
  /** Settings → Connection pairing card; resolves null while the bridge is off. */
  remoteAccessInfo?: (options?: { activate?: boolean }) => Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: mint a new pairing token (revokes paired phones). */
  rotateRemoteAccess?: () => Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: revoke one registered browser. */
  revokeRemoteAccessClient?: (clientId: string) => Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection / command surface: connect to another PC. */
  remoteHosts?: RemoteHostWindows;
  updater?: DesktopUpdater;
  terminals?: DesktopTerminalHost;
  /** Agent `terminal` tool: the renderer claims a command before entering it. */
  terminalRuns?: { claim(requestId: string): boolean };
  /** The kind of daemon connection `host` is: a server (`ssh`) window refuses
   *  every feature that acts on this PC (see connections/feature-gates). */
  connectionKind?: ConnectionKind;
  /** Where the connection's daemon keeps user data (editor backups, editor
   *  settings); this PC's userData unless given. */
  serviceUserDataPath?: () => string;
  /** This PC's own daemon, for a server window: the sign-ins a server's model
   *  calls run on are this PC's, so their quota reads are answered here. */
  pcHost?: PcQuotaHost;
  /** This window's pane layout file in the profile (see pane-layout-file.ts). */
  paneLayoutFile?: PaneLayoutFile;
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
    onDesktopSettingsChanged,
    previewNotificationSound,
    notifications,
    browserHost,
    browserLogin,
    updater,
    terminals,
    terminalRuns,
    computer,
    remoteAccessInfo,
    rotateRemoteAccess,
    revokeRemoteAccessClient,
    remoteHosts,
    visualize,
    connectionKind = 'local',
    serviceUserDataPath,
    pcHost,
    paneLayoutFile,
  }: DesktopIpcDependencies
): () => void {
  const nativeT = translateUi || ((key: string) => translateNativeUi(app.getLocale?.() || 'en', key));
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
  // The daemon's own user-data directory for paths handed to the service.
  const serviceGetPath = (name: Parameters<App['getPath']>[0]) =>
    name === 'userData' ? serviceUserDataPath?.() : app.getPath?.(name);
  const serviceApp: Partial<Pick<App, 'getPath'>> =
    serviceUserDataPath && typeof app.getPath === 'function' ? { getPath: serviceGetPath as App['getPath'] } : app;
  const invokeDesktopOperation = <T>(method: string, args: unknown[]): Promise<T> =>
    host.invokeDesktopOperation(method, args) as Promise<T>;
  type ServiceOperation = (...args: unknown[]) => Promise<unknown>;
  const serviceOperation =
    (name: string): ServiceOperation =>
    (...args: unknown[]) =>
      invokeDesktopOperation(name, args);
  const serviceOperations = Object.fromEntries(
    SERVICE_OPERATION_NAMES.map((name) => [name, serviceOperation(name)])
  ) as Record<(typeof SERVICE_OPERATION_NAMES)[number], ServiceOperation>;
  const selectedFiles = new SelectedFileAccess({
    storePath:
      typeof app.getPath === 'function' ? resolvePath(app.getPath('userData'), 'selected-file-grants.json') : '',
    listProjects: () => host.listProjects(),
  });
  // A server window's files live on the server: its one-file grants name
  // server paths (agent output links, uploads) and its bytes travel over the
  // window's own connection. This PC's selected-file grants never apply there.
  const downloadsDir = () => (typeof app.getPath === 'function' ? app.getPath('downloads') : '');
  const server =
    connectionKind === 'ssh'
      ? createServerFiles({
          invoke: invokeDesktopOperation,
          listProjects: () => host.listProjects(),
          session: () => window.webContents.session,
          downloadsDir,
        })
      : null;
  const grantedFile = async (accessToken: unknown, projectPath: unknown, relPath: unknown) =>
    server
      ? server.grants.requireGrant(accessToken, projectPath, relPath)
      : selectedFiles.requireGrant(accessToken, projectPath, relPath);
  const describeLocalPaths = (value: unknown) =>
    server ? server.grants.describe(value) : selectedFiles.describe(value);
  const stageAttachment = server
    ? async (dataUrl: unknown, name: unknown) => {
        const file = requiredAttachmentFile(dataUrl, name);
        const uploaded = await uploadServerBytes(
          invokeDesktopOperation,
          file.bytes,
          `${file.baseName}.${file.extension}`,
          'transcript'
        );
        return server.grants.entry(uploaded.absolutePath, uploaded);
      }
    : undefined;

  registerFileDialogIpc({
    window,
    app: serviceApp,
    connectionKind,
    dialog,
    host,
    handle,
    invokeDesktopOperation,
    nativeT,
    describeLocalPaths,
  });
  registerProjectIpc({ handle, host, shell, invokeDesktopOperation, operations: serviceOperations });
  handle(DESKTOP_IPC.requestLinuxInputAccess, () => requestLinuxInputAccess());
  registerProjectFileIpc({
    app: serviceApp,
    handle,
    host,
    invokeDesktopOperation,
    shell,
    grantedFile,
    server,
  });
  registerSessionIpc({
    handle,
    host,
    invokeDesktopOperation,
    browserHost,
    remoteAccessInfo,
    rotateRemoteAccess,
    revokeRemoteAccessClient,
    remoteHosts,
  });
  if (notifications) registerNotificationIpc({ handle, invokeDesktopOperation, notifications });
  registerBrowserIpc({ handle, browserHost, browserLogin });
  registerComputerIpc({ handle, shell, computer });
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
  registerWindowSettingsIpc({
    window,
    app,
    host,
    handle,
    readsLocalOnboardingStatus: connectionKind === 'local',
    raiseOnSignIn: connectionKind === 'local',
    pcHost: connectionKind === 'local' ? undefined : pcHost,
    invokeDesktopOperation,
    settingsStore,
    onDesktopSettingsChanged,
    previewNotificationSound,
    confirmAllowAllActions: createAllowAllActionsConfirm({ dialog, window, nativeT }),
  });

  const stateBridge = new DesktopStateBridge({
    window,
    host,
    ipcMain,
    handle,
    powerMonitor: powerMonitorRef,
    updater,
  });
  // Renderer perf lines ride a fire-and-forget event channel (no invoke).
  const onPerfLog = (_event: Electron.IpcMainEvent, line: unknown): void => {
    (host as { perfLog?: (line: string) => void }).perfLog?.(String(line ?? ''));
  };
  ipcMain.on(DESKTOP_IPC.perfLog, onPerfLog);
  // What this window paints, for the completion-notification rule.
  const disposeScreenSessions = registerScreenSessions(window, ipcMain);
  const disposePaneLayoutIpc = registerPaneLayoutIpc({ window, ipcMain, file: paneLayoutFile });
  const disposeTerminalIpc = registerTerminalIpc({
    window,
    ipcMain,
    handle,
    terminals,
    terminalRuns,
    invokeDesktopOperation,
  });
  registerSourceControlIpc({
    app,
    handle,
    operations: serviceOperations,
    shell,
    grantedFile,
    describeLocalPaths,
    stageAttachment,
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
    disposeTerminalIpc();
    ipcMain.removeListener(DESKTOP_IPC.perfLog, onPerfLog);
    disposeScreenSessions();
    disposePaneLayoutIpc();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
