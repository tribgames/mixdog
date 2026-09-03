// Explicit handler/preload registration:
// arbitrary renderer-selected method execution is intentionally absent.
import type {
  App,
  BrowserWindow,
  Dialog,
  IpcMain,
  IpcMainInvokeEvent,
  PowerMonitor,
  Shell,
} from 'electron';

import {
  readFile as fsReadFile,
  stat as fsStat,
} from 'node:fs/promises';
import {
  basename as pathBasename,
  isAbsolute as pathIsAbsolute,
  resolve as resolvePath,
} from 'node:path';
import {
  DESKTOP_IPC,
  type DesktopRemoteAccessInfo,
  type DesktopSettings,
  type DesktopWorkspace,
} from '../shared/contract';
import { localFileMimeTypeForPath } from '../shared/local-files';
import { requiredSessionId } from './desktop-state';
import type { DesktopService } from './desktop-service-contract';
import {
  absoluteLocalPath,
  MAX_LOCAL_FILE_BYTES,
} from './local-files';
import { readOnboardingStatusFromDisk } from './onboarding-status-file';
import {
  commonInstructionsFile,
  legacyCommonInstructionsFile,
  projectInstructionsFile,
} from './instructions-file';
import type { DesktopSettingsStore } from './settings-store';
import type { BrowserHost } from './browser/host';
import { registerBrowserIpc } from './ipc-browser';
import { registerProjectFileIpc } from './ipc-project-files';
import { registerSourceControlIpc } from './ipc-source-control';
import {
  DesktopStateBridge,
  type DesktopUpdater,
} from './ipc-state-bridge';
import {
  registerTerminalIpc,
  type DesktopTerminalHost,
} from './ipc-terminal';
import { SelectedFileAccess } from './selected-file-access';
import {
  projectDisplayName,
  requiredAbortOptions,
  requiredDesktopCapabilityReadRequests,
  requiredDesktopCapabilityRequest,
  requiredDesktopSettingKey,
  requiredExternalUrl,
  requiredFileSearchLimit,
  requiredGitPaths,
  requiredInstructionsContent,
  requiredModelCatalogOptions,
  requiredModelSelection,
  requiredNewTaskDraft,
  requiredPromptContent,
  requiredString,
  requiredSubmitOptions,
  requiredSessionMessageCount,
  requiredTranscriptItemLimit,
  requiredToolApprovalDecision,
  requiredWorkspaceFolders,
  requiredWorkspaceSearchOptions,
  requiredZoomFactor,
  sessionDisplayName,
} from './ipc-validation';
export {
  projectDisplayName,
  requiredAbortOptions,
  requiredCommitMessageFiles,
  requiredDesktopCapabilityReadRequests,
  requiredDesktopCapabilityRequest,
  requiredDesktopSettingKey,
  requiredFileSearchLimit,
  requiredGitBranchName,
  requiredGitDiscardMode,
  requiredGitLogLimit,
  requiredGitLogOffset,
  requiredGitLogQuery,
  requiredGitOptionalMessage,
  requiredGitPatch,
  requiredGitPath,
  requiredGitPaths,
  requiredModelCatalogOptions,
  requiredModelSelection,
  requiredNewTaskDraft,
  requiredPromptContent,
  requiredString,
  requiredSubmitOptions,
  requiredSessionMessageCount,
  requiredTranscriptItemLimit,
  requiredToolApprovalDecision,
  requiredWorkspaceSearchLimit,
  sessionDisplayName,
} from './ipc-validation';

const SERVICE_OPERATION_NAMES = [
  'githubStarStatus', 'starGithub', 'gitCliStatus', 'installGitCli',
  'libreOfficeStatus', 'installLibreOffice', 'githubCliStatus', 'installGithubCli',
  'githubCliLoginStart', 'githubCliLoginStatus', 'cancelGithubCliLogin',
  'githubCliLogout', 'githubCliAccount', 'gitGlobalConfig', 'setGitGlobalConfig',
  'gitAbortOperation', 'gitAmend', 'gitApplyPatch', 'gitBranches',
  'gitCheckoutBranch', 'gitCheckoutCommit', 'gitCherryPickCommit', 'gitCommit',
  'gitCommitPaths', 'gitContinue', 'gitCreateBranch', 'gitCreateBranchAtCommit',
  'gitCreateTag', 'gitDeleteBranch', 'gitDeleteTag', 'gitDiff', 'gitFetch',
  'gitIgnore', 'gitLog', 'gitMergeBranch', 'gitPull', 'gitPush',
  'gitRenameBranch', 'gitResetToCommit', 'gitRevertCommit', 'gitRevertFile',
  'gitReview', 'gitReviewDiff', 'gitShow', 'gitShowDiff', 'gitShowFile',
  'gitStage', 'gitStash', 'gitStashApply', 'gitStashDrop', 'gitStashList',
  'gitStashPop', 'gitStatus', 'gitSync', 'gitUndoLastCommit', 'gitUnstage',
  'ghPrCheckout', 'ghPrCreate', 'ghPrDefaultBranch', 'ghPrDiff', 'ghPrList',
  'ghPrMerge', 'ghPrView',
] as const;
interface DesktopIpcDependencies {
  app: Pick<App, 'quit'> & Partial<Pick<App, 'getPath'>>;
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>
    & Partial<Pick<Dialog, 'showSaveDialog'>>;
  shell: Pick<Shell, 'openPath' | 'openExternal' | 'showItemInFolder' | 'trashItem'>;
  powerMonitor?: Pick<PowerMonitor, 'on' | 'removeListener'>;
  settingsStore?: Pick<DesktopSettingsStore,
    'read' | 'update' | 'readZoom' | 'updateZoom' | 'readGitPreferences' | 'updateGitPreferences'>;
  /** Fires after a successful desktop-settings write (keep-awake wiring). */
  onDesktopSettingsChanged?: (settings: DesktopSettings) => void;
  /** Browser Use pane: local profile import without renderer-visible secrets. */
  browserHost?: Pick<BrowserHost,
    'browserImportSources'
    | 'browserImport'
    | 'browserHistorySearch'
    | 'releaseSession'
    | 'setGuestActive'
    | 'configureGuestViewport'
    | 'browserCredentialSuggestions'
    | 'browserCredentialFill'>;
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
  }: DesktopIpcDependencies,
): () => void {
  let quitPromise: Promise<void> | null = null;
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('IPC call rejected.');
    }
  };
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertSender(event);
      return listener(event, ...args);
    });
  };
  const invokeDesktopOperation = <T>(
    method: string,
    args: unknown[],
  ): Promise<T> => host.invokeDesktopOperation(method, args) as Promise<T>;
  type ServiceOperation = (...args: any[]) => Promise<any>;
  const serviceOperation = (name: string): ServiceOperation =>
    (...args: unknown[]) => invokeDesktopOperation(name, args);
  const serviceOperations = Object.fromEntries(SERVICE_OPERATION_NAMES
    .map((name) => [name, serviceOperation(name)])) as Record<
      (typeof SERVICE_OPERATION_NAMES)[number],
      ServiceOperation
    >;
  const {
    githubStarStatus,
    starGithub,
    libreOfficeStatus,
    installLibreOffice,
  } = serviceOperations;
  const selectedFiles = new SelectedFileAccess({
    storePath: typeof app.getPath === 'function'
      ? resolvePath(app.getPath('userData'), 'selected-file-grants.json')
      : '',
    listProjects: () => host.listProjects(),
  });
  const describeLocalPaths = (value: unknown) => selectedFiles.describe(value);
  const grantedFile = (
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown,
  ) => selectedFiles.requireGrant(accessToken, projectPath, relPath);

  handle(DESKTOP_IPC.chooseProject, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a Mixdog project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(DESKTOP_IPC.resolveLocalPaths, (_event, paths) => describeLocalPaths(paths));
  handle(DESKTOP_IPC.readLocalFile, async (_event, rawPath) => {
    const file = absoluteLocalPath(rawPath);
    const info = await fsStat(file);
    if (!info.isFile()) throw new Error('Only files can be attached.');
    if (info.size > MAX_LOCAL_FILE_BYTES) {
      throw new Error(`${pathBasename(file)}: files must be 20 MB or smaller.`);
    }
    const data = await fsReadFile(file);
    return {
      name: pathBasename(file),
      size: info.size,
      mimeType: localFileMimeTypeForPath(file),
      data: data.toString('base64'),
    };
  });
  // Project file refresh is daemon-owned and refcounted there.
  handle(DESKTOP_IPC.folderWatch, (_event, dirRaw, recursive) => {
    const dir = absoluteLocalPath(dirRaw);
    return invokeDesktopOperation('folderWatch', [dir, recursive === true]);
  });
  handle(DESKTOP_IPC.folderUnwatch, (_event, dirRaw, recursive) => {
    const dir = absoluteLocalPath(dirRaw);
    return invokeDesktopOperation('folderUnwatch', [dir, recursive === true]);
  });
  handle(DESKTOP_IPC.chooseFile, async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open file',
      ...(typeof defaultPath === 'string' && pathIsAbsolute(defaultPath)
        ? { defaultPath }
        : {}),
      properties: ['openFile'],
    });
    const file = result.canceled ? '' : resolvePath(result.filePaths[0] || '');
    if (!file) return null;
    return (await describeLocalPaths([file]))[0] ?? null;
  });
  handle(DESKTOP_IPC.chooseFiles, async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open files',
      ...(typeof defaultPath === 'string' && pathIsAbsolute(defaultPath)
        ? { defaultPath }
        : {}),
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return describeLocalPaths(result.filePaths.map((file) => resolvePath(file)));
  });
  handle(DESKTOP_IPC.chooseWorkspace, async () => {
    const result = await dialog.showOpenDialog(window, {
      // User-facing product noun is Project; `.code-workspace` stays as the
      // on-disk format name only.
      title: 'Open Project File',
      properties: ['openFile'],
      filters: [{ name: 'Project file', extensions: ['code-workspace'] }],
    });
    const file = result.canceled ? '' : result.filePaths[0] || '';
    if (!file) return null;
    const workspace = await invokeDesktopOperation<DesktopWorkspace>(
      'readWorkspaceFile',
      [file],
    );
    for (const folder of workspace.folders) await host.addProject(folder.path);
    return workspace;
  });
  handle(DESKTOP_IPC.saveWorkspace, async (_event, workspaceFile, rawFolders) => {
    const folders = requiredWorkspaceFolders(rawFolders);
    let file = typeof workspaceFile === 'string' && workspaceFile.trim()
      ? resolvePath(workspaceFile)
      : '';
    if (!file) {
      if (typeof dialog.showSaveDialog !== 'function') {
        throw new Error('The Project file save dialog is unavailable.');
      }
      const result = await dialog.showSaveDialog(window, {
        title: 'Save Project File As',
        defaultPath: 'project.code-workspace',
        filters: [{ name: 'Project file', extensions: ['code-workspace'] }],
      });
      if (result.canceled || !result.filePath) return null;
      file = result.filePath;
    }
    return invokeDesktopOperation(
      'writeWorkspaceFile',
      [file, folders],
    );
  });
  handle(DESKTOP_IPC.readEditorSettings, async (
    _event,
    projectPath,
    relPath,
    workspaceFile,
  ) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    const workspace = typeof workspaceFile === 'string' && workspaceFile.trim()
      ? resolvePath(workspaceFile)
      : undefined;
    const userDataPath = typeof app.getPath === 'function' ? app.getPath('userData') : '';
    const cleanRel = requiredString(relPath, 'relPath', 4_096);
    return invokeDesktopOperation(
      'readScopedEditorSettings',
      [userDataPath, root, cleanRel, workspace],
    );
  });
  handle(DESKTOP_IPC.startProject, (_event, projectPath) =>
    host.startProject(requiredString(projectPath, 'projectPath')));
  handle(DESKTOP_IPC.startProjectTask, (_event, projectPath) =>
    host.startProjectTask(requiredString(projectPath, 'projectPath')));
  handle(DESKTOP_IPC.startTask, () => host.startTask());
  handle(DESKTOP_IPC.listProjects, () => host.listProjects());
  handle(DESKTOP_IPC.addProject, (_event, projectPath) =>
    host.addProject(requiredString(projectPath, 'projectPath')));
  handle(DESKTOP_IPC.openProjectInExplorer, async (_event, projectPath) => {
    const directory = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
    const failure = await shell.openPath(directory);
    if (failure) throw new Error(`Unable to open project folder: ${failure}`);
  });
  const resolvedMediaAssetPath = async (assetId: unknown): Promise<string> => {
    const id = requiredString(assetId, 'assetId', 512);
    const result = await host.invokeCapability<{ available?: unknown; path?: unknown }>(
      'resolveMediaFile',
      [id, { variant: 'original' }],
    );
    const file = result.value;
    if (file?.available !== true || typeof file.path !== 'string' || !pathIsAbsolute(file.path)) {
      throw new Error('Media asset is unavailable.');
    }
    return file.path;
  };
  handle(DESKTOP_IPC.openMediaAsset, async (_event, assetId) => {
    const failure = await shell.openPath(await resolvedMediaAssetPath(assetId));
    if (failure) throw new Error(`Unable to open media asset: ${failure}`);
  });
  handle(DESKTOP_IPC.openMediaFolder, async (_event, assetId) => {
    shell.showItemInFolder(await resolvedMediaAssetPath(assetId));
  });
  handle(DESKTOP_IPC.openExternal, (_event, url) =>
    shell.openExternal(requiredExternalUrl(url)));
  handle(DESKTOP_IPC.githubStarStatus, () => githubStarStatus());
  handle(DESKTOP_IPC.starGithub, () => starGithub());
  // Extensions → Office: LibreOffice dependency probe + guided install.
  handle(DESKTOP_IPC.libreOfficeStatus, () => libreOfficeStatus());
  handle(DESKTOP_IPC.installLibreOffice, () => installLibreOffice());
  handle(DESKTOP_IPC.renameProject, (_event, projectPath, alias) =>
    host.renameProject(
      requiredString(projectPath, 'projectPath'),
      projectDisplayName(alias),
    ));
  handle(DESKTOP_IPC.removeProject, (_event, projectPath) =>
    host.removeProject(requiredString(projectPath, 'projectPath')));
  // Instructions editor (Projects page). null/'' → the common instructions
  // file (data/instructions.md, injected as "# Common Instructions" in BP3;
  // legacy user-workflow.md is read as a fallback so old installs surface
  // their existing guidance); a project path → `<project>/.mixdog/
  // instructions.md` (injected once per session after the `# Session` block).
  const instructionsFilePath = async (projectPath: unknown): Promise<string> => {
    if (projectPath == null || projectPath === '') return commonInstructionsFile();
    const directory = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
    return projectInstructionsFile(directory);
  };
  handle(DESKTOP_IPC.readInstructions, async (_event, projectPath) => {
    const file = await instructionsFilePath(projectPath);
    const legacy = projectPath == null || projectPath === ''
      ? legacyCommonInstructionsFile()
      : '';
    return invokeDesktopOperation('readInstructions', [file, legacy]);
  });
  handle(DESKTOP_IPC.writeInstructions, async (_event, projectPath, content) => {
    const text = requiredInstructionsContent(content);
    const file = await instructionsFilePath(projectPath);
    await invokeDesktopOperation('writeInstructions', [file, text]);
  });
  registerProjectFileIpc({
    app,
    handle,
    host,
    invokeDesktopOperation,
    shell,
    grantedFile,
  });
  handle(DESKTOP_IPC.listSessions, () => host.listSessions());
  handle(DESKTOP_IPC.markSessionRead, (_event, sessionId, messageCount, consumedUnread) => {
    if (consumedUnread !== undefined && typeof consumedUnread !== 'boolean') {
      throw new TypeError('consumedUnread must be a boolean.');
    }
    return host.markSessionRead(
      requiredSessionId(sessionId),
      requiredSessionMessageCount(messageCount),
      consumedUnread === true,
    );
  });
  handle(DESKTOP_IPC.listAgentPool, () => host.listAgentPool());
  // Settings → Connection: pairing card (null while the bridge is off).
  handle(DESKTOP_IPC.remoteAccessInfo, () => remoteAccessInfo?.() ?? null);
  handle(DESKTOP_IPC.rotateRemoteAccess, () => rotateRemoteAccess?.() ?? null);
  handle(DESKTOP_IPC.revokeRemoteAccessClient, (_event, clientId) =>
    revokeRemoteAccessClient?.(requiredString(clientId, 'clientId')) ?? null);
  handle(DESKTOP_IPC.listRemoteClientClaims, () =>
    invokeDesktopOperation('remoteAccessListClaims', []));
  // The approval itself: this answer is what mints the asking app's credential.
  handle(DESKTOP_IPC.resolveRemoteClientClaim, async (_event, claimId, approved) => {
    if (typeof approved !== 'boolean') throw new TypeError('approved must be a boolean.');
    const handled = await invokeDesktopOperation('remoteAccessResolveClaim', [
      requiredString(claimId, 'claimId'),
      approved,
    ]);
    return handled === true;
  });
  handle(DESKTOP_IPC.renameSession, (_event, sessionId, title) =>
    host.renameSession(requiredSessionId(sessionId), sessionDisplayName(title)));
  handle(DESKTOP_IPC.setSessionArchived, (_event, sessionId, archived) => {
    if (typeof archived !== 'boolean') throw new TypeError('archived must be a boolean.');
    return host.setSessionArchived(requiredSessionId(sessionId), archived);
  });
  handle(DESKTOP_IPC.deleteSession, async (_event, sessionId) => {
    const ownerSessionId = requiredSessionId(sessionId);
    const snapshot = await host.deleteSession(ownerSessionId);
    browserHost?.releaseSession(ownerSessionId);
    return snapshot;
  });
  handle(DESKTOP_IPC.prefetchSession, (_event, sessionId, itemLimit) =>
    host.prefetchSession(
      requiredSessionId(sessionId),
      requiredTranscriptItemLimit(itemLimit),
    ));
  handle(DESKTOP_IPC.searchProjectFiles, (_event, projectIdOrWorkspaceId, query, limit) => {
    if (typeof query !== 'string' || query.length > 1_024) {
      throw new TypeError('query is invalid.');
    }
    return host.searchProjectFiles(
      requiredString(projectIdOrWorkspaceId, 'projectIdOrWorkspaceId'),
      query,
      requiredFileSearchLimit(limit),
    );
  });
  handle(DESKTOP_IPC.searchWorkspaceText, async (_event, projectPath, rawOptions) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    const options = requiredWorkspaceSearchOptions(rawOptions);
    return invokeDesktopOperation(
      'searchWorkspaceTextIn',
      [root, options],
    );
  });
  handle(DESKTOP_IPC.replaceWorkspaceText, async (
    _event,
    projectPath,
    rawOptions,
    replacement,
    relPaths,
  ) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    if (typeof replacement !== 'string' || replacement.length > 1_000_000) {
      throw new TypeError('Replacement text is invalid.');
    }
    const options = requiredWorkspaceSearchOptions(rawOptions);
    const paths = relPaths === undefined ? undefined : requiredGitPaths(relPaths);
    return invokeDesktopOperation(
      'replaceWorkspaceTextIn',
      [root, options, replacement, paths],
    );
  });
  handle(DESKTOP_IPC.submitNewTask, (_event, prompt, options, draft) =>
    host.submitNewTask(
      requiredPromptContent(prompt),
      requiredSubmitOptions(options),
      requiredNewTaskDraft(draft),
    ));
  // Split panes: prompt/abort/approval addressed to any pooled live session
  // (active or parked). The host contract requires every addressed route.
  handle(DESKTOP_IPC.submitToSession, (_event, sessionId, prompt, options) =>
    host.submitToSession(
      requiredSessionId(sessionId),
      requiredPromptContent(prompt),
      requiredSubmitOptions(options),
    ));
  handle(DESKTOP_IPC.abortSession, (_event, sessionId, options) =>
    host.abortSession(requiredSessionId(sessionId), requiredAbortOptions(options)));
  handle(DESKTOP_IPC.resolveToolApprovalForSession, (_event, sessionId, id, input) =>
    host.resolveToolApprovalForSession(
      requiredSessionId(sessionId),
      requiredString(id, 'approval id', 1_024),
      requiredToolApprovalDecision(input),
    ));
  handle(DESKTOP_IPC.inheritSession, (_event, sourceSessionId, selection) =>
    host.inheritSession(
      requiredSessionId(sourceSessionId),
      selection === undefined || selection === null
        ? null
        : requiredModelSelection(selection),
    ));
  handle(DESKTOP_IPC.listProviderModels, (_event, options) =>
    host.listProviderModels(requiredModelCatalogOptions(options)));
  handle(DESKTOP_IPC.setModelRoute, (_event, selection, sessionId) =>
    host.setModelRoute(
      requiredModelSelection(selection),
      sessionId === undefined || sessionId === null || sessionId === ''
        ? undefined
        : requiredSessionId(sessionId),
    ));
  handle(DESKTOP_IPC.setFast, (_event, enabled, sessionId) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    return host.setFast(
      enabled,
      sessionId === undefined || sessionId === null || sessionId === ''
        ? undefined
        : requiredSessionId(sessionId),
    );
  });
  handle(DESKTOP_IPC.readSettings, () =>
    settingsStore?.read() ?? invokeDesktopOperation('readSettings', []));
  handle(DESKTOP_IPC.updateSetting, (_event, key, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    const settingKey = requiredDesktopSettingKey(key);
    const update = settingsStore
      ? settingsStore.update(settingKey, enabled)
      : invokeDesktopOperation<DesktopSettings>('updateSetting', [settingKey, enabled]);
    return update.then((saved) => {
      onDesktopSettingsChanged?.(saved);
      return saved;
    });
  });
  registerBrowserIpc({ handle, browserHost });
  handle(DESKTOP_IPC.getZoomFactor, async () => {
    const factor = settingsStore
      ? await settingsStore.readZoom()
      : await invokeDesktopOperation<number>('readZoom', []);
    window.webContents.setZoomFactor(factor);
    const { setDesktopTitleBarZoom } = await import('./window-options');
    setDesktopTitleBarZoom(window, factor);
    return factor;
  });
  handle(DESKTOP_IPC.setZoomFactor, async (_event, value) => {
    const requested = requiredZoomFactor(value);
    const factor = settingsStore
      ? await settingsStore.updateZoom(requested)
      : await invokeDesktopOperation<number>('updateZoom', [requested]);
    window.webContents.setZoomFactor(factor);
    const { setDesktopTitleBarZoom } = await import('./window-options');
    setDesktopTitleBarZoom(window, factor);
    window.webContents.send(DESKTOP_IPC.zoomFactorChanged, factor);
    return factor;
  });
  // Renderer-resolved DESKTOP theme (system preference / stored preference)
  // is the only owner of the native band, caption symbols, and the DWM frame
  // theme. The engine/TUI theme is a separate user setting — the old
  // getTheme/setTheme capability hook let it overwrite this band with a
  // mismatched palette, so capabilities stay theme-neutral now.
  handle(DESKTOP_IPC.applyTitleBarTheme, async (_event, theme, systemPreference) => {
    const { setDesktopTitleBarTheme } = await import('./window-options');
    setDesktopTitleBarTheme(window, requiredString(theme, 'theme'), systemPreference === true);
  });
  // Fullscreen-modal dim for the native WCO caption band: the renderer sends
  // pre-composited hex colors; anything malformed clears back to the theme.
  handle(DESKTOP_IPC.setTitleBarDim, async (_event, dim) => {
    const record = (dim && typeof dim === 'object' ? dim : {}) as Record<string, unknown>;
    const hex = /^#[0-9a-f]{6}$/i;
    const valid = typeof record.color === 'string' && hex.test(record.color)
      && typeof record.symbolColor === 'string' && hex.test(record.symbolColor);
    const { setDesktopTitleBarDim } = await import('./window-options');
    setDesktopTitleBarDim(window, valid
      ? { color: record.color as string, symbolColor: record.symbolColor as string }
      : null);
  });
  handle(DESKTOP_IPC.invokeCapability, async (_event, input) => {
    const request = requiredDesktopCapabilityRequest(input);
    if (request.capability === 'getOnboardingStatus' && !request.sessionId) {
      const status = await readOnboardingStatusFromDisk();
      if (status) return { value: status, snapshot: host.getSnapshot() };
    }
    return host.invokeCapability(request.capability, request.args, request.sessionId);
  });
  handle(DESKTOP_IPC.readCapabilities, (_event, input) =>
    host.readCapabilities(requiredDesktopCapabilityReadRequests(input)));
  handle(DESKTOP_IPC.quit, () => {
    quitPromise ??= (async () => {
      try {
        await host.dispose();
      } finally {
        app.quit();
      }
    })();
    return quitPromise;
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
    settingsStore,
    invokeDesktopOperation,
    shell,
    grantedFile,
  });
  const eventChannels = new Set<string>([
    DESKTOP_IPC.state, DESKTOP_IPC.sessionState, DESKTOP_IPC.sessionStateResync,
    DESKTOP_IPC.sessionsChanged, DESKTOP_IPC.agentPoolChanged, DESKTOP_IPC.stateResync,
    DESKTOP_IPC.updaterState, DESKTOP_IPC.perfLog, DESKTOP_IPC.rendererDiagnostic,
    DESKTOP_IPC.termWrite, DESKTOP_IPC.termResize, DESKTOP_IPC.termAcknowledge,
    DESKTOP_IPC.termData,
    DESKTOP_IPC.lspDiagnostics, DESKTOP_IPC.lspStatus,
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
