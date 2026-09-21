// Explicit handler/preload registration:
// arbitrary renderer-selected method execution is intentionally absent.
// Each handler family lives in its own ipc-*.ts module; this file owns the
// sender guard, the service-operation table, and the disposer.
import type { App, BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent, PowerMonitor, Shell } from 'electron';

import { resolve as resolvePath } from 'node:path';
import { DESKTOP_IPC, type DesktopRemoteAccessInfo, type DesktopSettings } from '../shared/contract';
import { translateNativeUi } from '../shared/native-ui';
import type { DesktopService } from './desktop-service-contract';
import type { DesktopSettingsStore } from './settings-store';
import type { BrowserHost } from './browser/host';
import { registerBrowserIpc } from './ipc-browser';
import { registerFileDialogIpc } from './ipc-file-dialogs';
import { registerProjectIpc } from './ipc-projects';
import { registerProjectFileIpc } from './ipc-project-files';
import { registerSessionIpc } from './ipc-sessions';
import { registerSourceControlIpc } from './ipc-source-control';
import { DesktopStateBridge, type DesktopUpdater } from './ipc-state-bridge';
import { registerTerminalIpc, type DesktopTerminalHost } from './ipc-terminal';
import { registerWindowSettingsIpc } from './ipc-window-settings';
import { SelectedFileAccess } from './selected-file-access';
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
  'cancelGithubCliLogin',
  'githubCliLogout',
  'githubCliAccount',
  'gitGlobalConfig',
  'setGitGlobalConfig',
  'gitAbortOperation',
  'gitAmend',
  'gitApplyPatch',
  'gitBranches',
  'gitCheckoutBranch',
  'gitCheckoutCommit',
  'gitCherryPickCommit',
  'gitCommit',
  'gitCommitPaths',
  'gitContinue',
  'gitCreateBranch',
  'gitCreateBranchAtCommit',
  'gitCreateTag',
  'gitDeleteBranch',
  'gitDeleteTag',
  'gitDiff',
  'gitFetch',
  'gitIgnore',
  'gitLog',
  'gitMergeBranch',
  'gitPull',
  'gitPush',
  'gitRenameBranch',
  'gitResetToCommit',
  'gitRevertCommit',
  'gitRevertFile',
  'gitReview',
  'gitReviewDiff',
  'gitShow',
  'gitShowDiff',
  'gitShowFile',
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
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'> & Partial<Pick<Dialog, 'showSaveDialog'>>;
  shell: Pick<Shell, 'openPath' | 'openExternal' | 'showItemInFolder' | 'trashItem'>;
  powerMonitor?: Pick<PowerMonitor, 'on' | 'removeListener'>;
  settingsStore?: Pick<DesktopSettingsStore, 'read' | 'update' | 'readZoom' | 'updateZoom'>;
  /** Fires after a successful desktop-settings write (keep-awake wiring). */
  onDesktopSettingsChanged?: (settings: DesktopSettings) => void;
  /** Browser Use pane: local profile import without renderer-visible secrets. */
  browserHost?: Pick<
    BrowserHost,
    | 'browserImportSources'
    | 'browserImport'
    | 'browserHistorySearch'
    | 'releaseSession'
    | 'setGuestActive'
    | 'configureGuestViewport'
    | 'browserCredentialSuggestions'
    | 'browserCredentialFill'
    | 'browserClearData'
    | 'browserPageFrame'
    | 'browserPageControl'
  >;
  /** Settings → Connection pairing card; resolves null while the bridge is off. */
  remoteAccessInfo?: () => Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: mint a new pairing token (revokes paired phones). */
  rotateRemoteAccess?: () => Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: revoke one registered browser. */
  revokeRemoteAccessClient?: (clientId: string) => Promise<DesktopRemoteAccessInfo | null>;
  updater?: DesktopUpdater;
  terminals?: DesktopTerminalHost;
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
    browserHost,
    updater,
    terminals,
    remoteAccessInfo,
    rotateRemoteAccess,
    revokeRemoteAccessClient,
  }: DesktopIpcDependencies
): () => void {
  const nativeT = translateUi || ((key: string) => translateNativeUi(app.getLocale?.() || 'en', key));
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('IPC call rejected.');
    }
  };
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertSender(event);
      return listener(event, ...args);
    });
  };
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
  const grantedFile = (accessToken: unknown, projectPath: unknown, relPath: unknown) =>
    selectedFiles.requireGrant(accessToken, projectPath, relPath);

  registerFileDialogIpc({
    window,
    app,
    dialog,
    host,
    handle,
    invokeDesktopOperation,
    nativeT,
    describeLocalPaths: (value) => selectedFiles.describe(value),
  });
  registerProjectIpc({ handle, host, shell, invokeDesktopOperation, operations: serviceOperations });
  registerProjectFileIpc({
    app,
    handle,
    host,
    invokeDesktopOperation,
    shell,
    grantedFile,
  });
  registerSessionIpc({
    handle,
    host,
    invokeDesktopOperation,
    browserHost,
    remoteAccessInfo,
    rotateRemoteAccess,
    revokeRemoteAccessClient,
  });
  registerBrowserIpc({ handle, browserHost });
  registerWindowSettingsIpc({
    window,
    app,
    host,
    handle,
    invokeDesktopOperation,
    settingsStore,
    onDesktopSettingsChanged,
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
  const disposeTerminalIpc = registerTerminalIpc({
    window,
    ipcMain,
    handle,
    terminals,
    invokeDesktopOperation,
  });
  registerSourceControlIpc({
    app,
    handle,
    operations: serviceOperations,
    shell,
    grantedFile,
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
    DESKTOP_IPC.rendererDiagnostic,
    DESKTOP_IPC.termWrite,
    DESKTOP_IPC.termResize,
    DESKTOP_IPC.termAcknowledge,
    DESKTOP_IPC.termData,
    DESKTOP_IPC.lspDiagnostics,
    DESKTOP_IPC.lspStatus,
    DESKTOP_IPC.remoteClientClaim,
  ]);
  const channels = Object.values(DESKTOP_IPC).filter((channel) => !eventChannels.has(channel));
  let removed = false;

  return () => {
    if (removed) return;
    removed = true;
    stateBridge.dispose();
    disposeTerminalIpc();
    ipcMain.removeListener(DESKTOP_IPC.perfLog, onPerfLog);
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
