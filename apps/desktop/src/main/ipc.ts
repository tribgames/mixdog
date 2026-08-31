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

import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  stat as fsStat,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import {
  basename as pathBasename,
  dirname as pathDirname,
  isAbsolute as pathIsAbsolute,
  join as joinPath,
  relative as pathRelative,
  sep as pathSep,
  resolve as resolvePath,
} from 'node:path';
import {
  DESKTOP_IPC,
  type DesktopLocalPathEntry,
  type DesktopRemoteAccessInfo,
  type DesktopSettings,
  type DesktopUpdaterState,
  type DesktopWorkspace,
  type SessionSnapshot,
} from '../shared/contract';
import { localFileMimeTypeForPath } from '../shared/local-files';
import { requiredSessionId } from './desktop-state';
import { readSecretFile, writeSecretFile } from './secret-file';
import {
  MAX_SELECTED_FILE_GRANTS,
  parseSelectedFileGrants,
  selectedFileGrantKey,
  serializeSelectedFileGrants,
} from './selected-file-grants';
import type { TerminalSpawnProfile } from './terminal-contract';
import type { DesktopService } from './desktop-service-contract';
import { registerFilePreview } from './file-preview';
import {
  browsableFolderPath,
  listFolderPlaces,
  MAX_LOCAL_FILE_BYTES,
} from './folder-explorer';
import {
  commonInstructionsFile,
  legacyCommonInstructionsFile,
  projectInstructionsFile,
} from './instructions-file';
import {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  requiredGitRevision,
  requiredRepositoryCwd,
} from './git-contract.mjs';
import {
  projectEntryPathIn,
} from './project-files';
import type { DesktopSettingsStore } from './settings-store';
import type { BrowserHost } from './browser-host';
import {
  createSnapshotDeltaEncoder,
  releaseHiddenSessionStateEntries,
  shouldPublishSessionState,
  type SnapshotDeltaEncoder,
} from './state-delta';
import { TerminalDataBufferer } from './terminal-data-buffer';
import {
  attachmentImageBaseName,
  projectDisplayName,
  requiredAbortOptions,
  requiredAttachmentImage,
  requiredCommitMessageFiles,
  requiredDesktopCapabilityReadRequests,
  requiredDesktopCapabilityRequest,
  requiredDesktopSettingKey,
  requiredExternalUrl,
  requiredFileSearchLimit,
  requiredGitBranchName,
  requiredGitDiscardMode,
  requiredGitGlobalConfigKey,
  requiredGitLogLimit,
  requiredGitLogOffset,
  requiredGitLogQuery,
  requiredGitOptionalMessage,
  requiredGitPatch,
  requiredGitPath,
  requiredGitPaths,
  requiredGitPreferencesInput,
  requiredInstructionsContent,
  requiredLspDocumentInput,
  requiredLspRequestInput,
  requiredModelCatalogOptions,
  requiredModelSelection,
  requiredNewTaskDraft,
  requiredPromptContent,
  requiredString,
  requiredSubmitOptions,
  requiredTextFileContent,
  requiredTextFileEncoding,
  requiredSessionMessageCount,
  requiredTranscriptItemLimit,
  requiredToolApprovalDecision,
  requiredWorkspaceFolders,
  requiredWorkspaceSearchOptions,
  requiredWorkspaceTextWrites,
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
  app: Pick<App, 'quit'> & Partial<Pick<App, 'getPath' | 'getFileIcon'>>;
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>
    & Partial<Pick<Dialog, 'showSaveDialog'>>;
  shell: Pick<Shell, 'openPath' | 'openExternal' | 'showItemInFolder' | 'trashItem'>;
  powerMonitor?: Pick<PowerMonitor, 'on' | 'removeListener'>;
  nativeImage?: Pick<typeof import('electron').nativeImage, 'createThumbnailFromPath'>;
  settingsStore?: Pick<DesktopSettingsStore,
    'read' | 'update' | 'readZoom' | 'updateZoom' | 'readGitPreferences' | 'updateGitPreferences'>;
  /** Fires after a successful desktop-settings write (keep-awake wiring). */
  onDesktopSettingsChanged?: (settings: DesktopSettings) => void;
  /** Browser Use pane: local profile import without renderer-visible secrets. */
  browserHost?: Pick<BrowserHost,
    'browserImportSources'
    | 'browserImport'
    | 'browserHistorySearch'
    | 'setGuestActive'
    | 'browserCredentialSuggestions'
    | 'browserCredentialFill'>;
  /** Settings → Connection pairing card; resolves null while the bridge is off. */
  remoteAccessInfo?: () => Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: mint a new pairing token (revokes paired phones). */
  rotateRemoteAccess?: () => Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: revoke one registered browser. */
  revokeRemoteAccessClient?: (clientId: string) => Promise<DesktopRemoteAccessInfo | null>;
  updater?: {
    getState(): DesktopUpdaterState;
    subscribe(listener: (state: DesktopUpdaterState) => void): () => void;
    check(): Promise<DesktopUpdaterState>;
    install(): Promise<void>;
  };
  terminals?: {
    ensure(id: string | null, cwd: string | null, profile?: TerminalSpawnProfile | string | null):
      { id: string; replay: string } | Promise<{ id: string; replay: string }>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    pauseOutput?(id: string): void;
    resumeOutput?(id: string): void;
    dispose(id: string): void;
    subscribe(listener: (event: { id: string; data: string }) => void): () => void;
  };
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
    nativeImage: nativeImageRef,
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
  const {
    githubStarStatus,
    starGithub,
    gitCliStatus,
    installGitCli,
    libreOfficeStatus,
    installLibreOffice,
    githubCliStatus,
    installGithubCli,
    githubCliLoginStart,
    githubCliLoginStatus,
    cancelGithubCliLogin,
    githubCliLogout,
    githubCliAccount,
    gitGlobalConfig,
    setGitGlobalConfig,
    gitAbortOperation,
    gitAmend,
    gitApplyPatch,
    gitBranches,
    gitCheckoutBranch,
    gitCheckoutCommit,
    gitCherryPickCommit,
    gitCommit,
    gitCommitPaths,
    gitContinue,
    gitCreateBranch,
    gitCreateBranchAtCommit,
    gitCreateTag,
    gitDeleteBranch,
    gitDeleteTag,
    gitDiff,
    gitFetch,
    gitIgnore,
    gitLog,
    gitMergeBranch,
    gitPull,
    gitPush,
    gitRenameBranch,
    gitResetToCommit,
    gitRevertCommit,
    gitRevertFile,
    gitReview,
    gitReviewDiff,
    gitShow,
    gitShowDiff,
    gitShowFile,
    gitStage,
    gitStash,
    gitStashApply,
    gitStashDrop,
    gitStashList,
    gitStashPop,
    gitStatus,
    gitSync,
    gitUndoLastCommit,
    gitUnstage,
    ghPrCheckout,
    ghPrCreate,
    ghPrDefaultBranch,
    ghPrDiff,
    ghPrList,
    ghPrMerge,
    ghPrView,
  } = Object.fromEntries(SERVICE_OPERATION_NAMES
    .map((name) => [name, serviceOperation(name)])) as Record<
      (typeof SERVICE_OPERATION_NAMES)[number],
      ServiceOperation
    >;
  const selectedFileGrants = new Map<string, string>();
  let selectedFileGrantsLoaded = false;
  const selectedFileGrantStore = typeof app.getPath === 'function'
    ? resolvePath(app.getPath('userData'), 'selected-file-grants.json')
    : '';
  const loadSelectedFileGrants = async (): Promise<void> => {
    if (selectedFileGrantsLoaded) return;
    selectedFileGrantsLoaded = true;
    if (!selectedFileGrantStore) return;
    try {
      const parsed = parseSelectedFileGrants(
        await readSecretFile(selectedFileGrantStore) ?? '[]',
      );
      for (const [tokenHash, file] of parsed.grants) {
        selectedFileGrants.set(tokenHash, file);
      }
      if (parsed.migrated) {
        await writeSecretFile(
          selectedFileGrantStore,
          serializeSelectedFileGrants(selectedFileGrants),
        );
      }
    } catch {
      // No grant store yet, or a corrupt convenience file: start empty.
    }
  };
  const persistSelectedFileGrants = async (): Promise<void> => {
    if (!selectedFileGrantStore) return;
    await writeSecretFile(
      selectedFileGrantStore,
      serializeSelectedFileGrants(selectedFileGrants),
    );
  };
  const describeLocalPaths = async (value: unknown): Promise<DesktopLocalPathEntry[]> => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
      throw new TypeError('paths are invalid.');
    }
    const projects = await host.listProjects().catch(() => []);
    let grantsChanged = false;
    const rows: DesktopLocalPathEntry[] = [];
    for (const raw of value) {
      const absolutePath = browsableFolderPath(raw);
      const info = await fsStat(absolutePath);
      const row: DesktopLocalPathEntry = {
        absolutePath,
        name: pathBasename(absolutePath) || absolutePath,
        dir: info.isDirectory(),
        size: Number(info.size) || 0,
      };
      if (!row.dir) {
        const normalizedFile = process.platform === 'win32'
          ? absolutePath.toLocaleLowerCase()
          : absolutePath;
        const owner = projects
          .map((project) => ({ project, root: resolvePath(project.path) }))
          .filter(({ root }) => {
            const normalizedRoot = process.platform === 'win32' ? root.toLocaleLowerCase() : root;
            return normalizedFile.startsWith(normalizedRoot + pathSep)
              || normalizedFile === normalizedRoot;
          })
          .sort((left, right) => right.root.length - left.root.length)[0];
        if (owner) {
          row.projectPath = owner.project.path;
          row.relPath = pathRelative(owner.root, absolutePath).replace(/\\/g, '/');
        } else {
          const accessToken = randomUUID();
          selectedFileGrants.set(selectedFileGrantKey(accessToken), absolutePath);
          row.projectPath = pathDirname(absolutePath);
          row.relPath = pathBasename(absolutePath);
          row.accessToken = accessToken;
          grantsChanged = true;
        }
      }
      rows.push(row);
    }
    while (selectedFileGrants.size > MAX_SELECTED_FILE_GRANTS) {
      const oldest = selectedFileGrants.keys().next().value;
      if (!oldest) break;
      selectedFileGrants.delete(oldest);
      grantsChanged = true;
    }
    if (grantsChanged) await persistSelectedFileGrants();
    return rows;
  };
  const grantedFile = async (
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown,
  ): Promise<{ root: string; rel: string; absolute: string }> => {
    await loadSelectedFileGrants();
    const token = requiredString(accessToken, 'file access token', 128);
    const granted = selectedFileGrants.get(selectedFileGrantKey(token));
    if (!granted) throw new Error('The selected-file permission is unavailable.');
    const requested = resolvePath(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    );
    const same = process.platform === 'win32'
      ? requested.toLocaleLowerCase() === granted.toLocaleLowerCase()
      : requested === granted;
    if (!same) throw new Error('The selected-file permission does not match this path.');
    return { root: pathDirname(granted), rel: pathBasename(granted), absolute: granted };
  };
  const editorFilePath = async (
    projectPath: unknown,
    relPath: unknown,
    accessToken: unknown,
  ): Promise<string> => {
    if (typeof accessToken === 'string' && accessToken) {
      return (await grantedFile(accessToken, projectPath, relPath)).absolute;
    }
    const project = requiredString(projectPath, 'projectPath');
    const rel = requiredString(relPath, 'relPath', 4_096);
    return projectEntryPathIn(await host.projectDirectory(project), rel);
  };
  // Root + relative pair for operations that resolve the file themselves, so
  // the traversal guard runs where the work happens instead of on a path this
  // process hands over already resolved.
  const editorFileTarget = async (
    projectPath: unknown,
    relPath: unknown,
    accessToken: unknown,
  ): Promise<{ root: string; rel: string }> => {
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return { root: granted.root, rel: granted.rel };
    }
    return {
      root: await host.projectDirectory(requiredString(projectPath, 'projectPath')),
      rel: requiredString(relPath, 'relPath', 4_096),
    };
  };
  const editorBackupRoot = typeof app.getPath === 'function'
    ? app.getPath('userData')
    : '';

  handle(DESKTOP_IPC.chooseProject, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a Mixdog project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(DESKTOP_IPC.chooseFolder, async () => {
    // PARENTLESS on purpose: the window-parented modal can fail to present on
    // Windows (IFileDialog silently auto-cancels ~5s later without ever
    // creating a dialog window — reproduced with a minimal Electron app).
    // The parentless dialog always presents; losing modality is acceptable.
    const result = await dialog.showOpenDialog({
      title: 'Open Folder',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  const requiredFolderPaths = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
      throw new TypeError('paths are invalid.');
    }
    return value.map((path) => browsableFolderPath(path));
  };
  handle(DESKTOP_IPC.listFolderDir, (_event, dir) =>
    invokeDesktopOperation('listFolderDirAbs', [browsableFolderPath(dir)]));
  handle(DESKTOP_IPC.createFolderEntry, (_event, dir, name, isDir) =>
    invokeDesktopOperation(
      'createFolderEntryAbs',
      [browsableFolderPath(dir), requiredString(name, 'name', 255), isDir === true],
    ));
  handle(DESKTOP_IPC.renameFolderEntry, (_event, path, newName) =>
    invokeDesktopOperation(
      'renameFolderEntryAbs',
      [browsableFolderPath(path), requiredString(newName, 'newName', 255)],
    ));
  handle(DESKTOP_IPC.moveFolderEntry, (_event, paths, targetDir, strategy) => {
    const sources = requiredFolderPaths(paths);
    const target = browsableFolderPath(targetDir);
    const mode = strategy === 'replace' || strategy === 'keepBoth' || strategy === 'skip'
      ? strategy
      : 'ask';
    // Replace keeps Electron's recoverable OS trash, but both the conflict
    // scan and the actual move execute in the daemon. If the second scan sees
    // a new race it reports conflicts instead of deleting anything.
    if (mode === 'replace') {
      return (async () => {
        const moved: Array<{ from: string; to: string }> = [];
        for (const source of sources) {
          const first = await invokeDesktopOperation<{
            conflicts?: string[]; moved: Array<{ from: string; to: string }>;
          }>('moveFolderEntriesAbs', [[source], target, 'ask']);
          if (first.moved.length) {
            moved.push(...first.moved);
            continue;
          }
          if (first.conflicts?.length) {
            await shell.trashItem(resolvePath(target, pathBasename(first.conflicts[0])));
            const second = await invokeDesktopOperation<{
              conflicts?: string[]; moved: Array<{ from: string; to: string }>;
            }>('moveFolderEntriesAbs', [[source], target, 'ask']);
            if (second.conflicts?.length) return { conflicts: second.conflicts, moved };
            moved.push(...second.moved);
          }
        }
        return { moved };
      })();
    }
    return invokeDesktopOperation(
      'moveFolderEntriesAbs',
      [sources, target, mode],
    );
  });
  handle(DESKTOP_IPC.copyFolderEntry, (_event, paths, targetDir) =>
    invokeDesktopOperation(
      'copyFolderEntriesAbs',
      [requiredFolderPaths(paths), browsableFolderPath(targetDir)],
    ));
  handle(DESKTOP_IPC.trashFolderEntry, async (_event, path) => {
    await shell.trashItem(browsableFolderPath(path));
  });
  handle(DESKTOP_IPC.openFolderEntry, async (_event, path) => {
    const failure = await shell.openPath(browsableFolderPath(path));
    if (failure) throw new Error(failure);
  });
  handle(DESKTOP_IPC.revealFolderEntry, async (_event, path) => {
    shell.showItemInFolder(browsableFolderPath(path));
  });
  handle(DESKTOP_IPC.folderPlaces, () =>
    listFolderPlaces(typeof app.getPath === 'function'
      ? (name) => app.getPath!(name)
      : undefined));
  handle(DESKTOP_IPC.folderEntryIcon, async (_event, path, thumbnail, size) => {
    const target = browsableFolderPath(path);
    const edge = Number.isFinite(Number(size))
      ? Math.max(32, Math.min(1024, Math.round(Number(size))))
      : 96;
    if (thumbnail === true && nativeImageRef?.createThumbnailFromPath) {
      try {
        const thumb = await nativeImageRef.createThumbnailFromPath(target, { width: edge, height: edge });
        if (!thumb.isEmpty()) return thumb.toDataURL();
      } catch { /* fall back to the shell icon */ }
    }
    if (typeof app.getFileIcon === 'function') {
      try {
        const icon = await app.getFileIcon(target, { size: 'large' });
        if (!icon.isEmpty()) return icon.toDataURL();
      } catch { /* renderer falls back to a generic glyph */ }
    }
    return '';
  });
  handle(DESKTOP_IPC.resolveLocalPaths, (_event, paths) => describeLocalPaths(paths));
  handle(DESKTOP_IPC.readLocalFile, async (_event, rawPath) => {
    const file = browsableFolderPath(rawPath);
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
  // Explorer pane live refresh is daemon-owned and refcounted there.
  handle(DESKTOP_IPC.folderWatch, (_event, dirRaw, recursive) => {
    const dir = browsableFolderPath(dirRaw);
    return invokeDesktopOperation('folderWatch', [dir, recursive === true]);
  });
  handle(DESKTOP_IPC.folderUnwatch, (_event, dirRaw, recursive) => {
    const dir = browsableFolderPath(dirRaw);
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
    await loadSelectedFileGrants();
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
    await loadSelectedFileGrants();
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
  handle(DESKTOP_IPC.gitCliStatus, () => gitCliStatus());
  handle(DESKTOP_IPC.installGitCli, () => installGitCli());
  // Extensions → Office: LibreOffice dependency probe + guided install.
  handle(DESKTOP_IPC.libreOfficeStatus, () => libreOfficeStatus());
  handle(DESKTOP_IPC.installLibreOffice, () => installLibreOffice());
  // Settings → Git: GitHub CLI integration + global git identity.
  handle(DESKTOP_IPC.githubCliStatus, () => githubCliStatus());
  handle(DESKTOP_IPC.installGithubCli, () => installGithubCli());
  handle(DESKTOP_IPC.githubCliLoginStart, () => githubCliLoginStart());
  handle(DESKTOP_IPC.githubCliLoginStatus, (_event, flowId) =>
    githubCliLoginStatus(requiredString(flowId, 'flowId', 200)));
  handle(DESKTOP_IPC.githubCliLoginCancel, (_event, flowId) =>
    cancelGithubCliLogin(requiredString(flowId, 'flowId', 200)));
  handle(DESKTOP_IPC.githubCliLogout, () => githubCliLogout());
  handle(DESKTOP_IPC.githubCliAccount, () => githubCliAccount());
  handle(DESKTOP_IPC.gitGlobalConfig, () => gitGlobalConfig());
  handle(DESKTOP_IPC.setGitGlobalConfig, (_event, key, value) => {
    // Empty is a real value here: it UNSETS the key, so requiredString's
    // non-empty contract does not apply.
    if (typeof value !== 'string' || value.length > 500) {
      throw new TypeError('value must be a string of at most 500 characters.');
    }
    return setGitGlobalConfig(requiredGitGlobalConfigKey(key), value);
  });
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
  handle(DESKTOP_IPC.listProjectDir, (_event, projectPath, relDir) =>
    host.listProjectDir(
      requiredString(projectPath, 'projectPath'),
      typeof relDir === 'string' ? relDir : '',
    ));
  handle(DESKTOP_IPC.readProjectFile, async (_event, projectPath, relPath, accessToken) => {
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return invokeDesktopOperation(
        'readProjectTextFileIn',
        [granted.root, granted.rel],
      );
    }
    return host.readProjectTextFile(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    );
  });
  handle(DESKTOP_IPC.previewProjectFile, async (_event, projectPath, relPath, accessToken) => {
    let file: string;
    let info: { mtimeMs: number; size: number };
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      file = granted.absolute;
      info = await invokeDesktopOperation(
        'statProjectFileIn',
        [granted.root, granted.rel],
      );
    } else {
      const cleanProject = requiredString(projectPath, 'projectPath');
      const cleanRel = requiredString(relPath, 'relPath');
      const root = await host.projectDirectory(cleanProject);
      file = projectEntryPathIn(root, cleanRel);
      info = await invokeDesktopOperation(
        'statProjectFileIn',
        [root, cleanRel],
      );
    }
    const preview = registerFilePreview(file, `${info.mtimeMs}:${info.size}`);
    if (!preview) throw new Error('This file type does not support an in-app preview.');
    return { ...preview, ...info };
  });
  // An Office document has no in-browser viewer, so one conversion per file
  // revision produces a PDF and the existing PDF surface shows it. The token
  // is registered from the CONVERSION, so the renderer never learns where the
  // cache lives — same rule as every other preview URL.
  handle(DESKTOP_IPC.previewDocumentFile, async (_event, projectPath, relPath, accessToken) => {
    const target = await editorFileTarget(projectPath, relPath, accessToken);
    const converted = await invokeDesktopOperation(
      'documentPreviewIn',
      [target.root, target.rel],
    ) as { path: string; format: string; mtimeMs: number; size: number };
    const preview = registerFilePreview(converted.path, `${converted.mtimeMs}:${converted.size}`);
    if (!preview) throw new Error('The converted document preview is unavailable.');
    return {
      url: preview.url,
      kind: 'pdf' as const,
      mime: preview.mime,
      format: converted.format,
      mtimeMs: converted.mtimeMs,
      size: converted.size,
    };
  });
  handle(DESKTOP_IPC.previewDocumentPages, async (
    _event,
    projectPath,
    relPath,
    accessToken,
    options,
  ) => {
    const target = await editorFileTarget(projectPath, relPath, accessToken);
    return invokeDesktopOperation(
      'documentPreviewPagesIn',
      [target.root, target.rel, options ?? {}],
    );
  });
  handle(DESKTOP_IPC.writeProjectFile, async (
    _event,
    projectPath,
    relPath,
    content,
    expectedContent,
    accessToken,
    encoding,
  ) => {
    const text = requiredTextFileContent(content, 'file content');
    const expected = requiredTextFileContent(expectedContent, 'expected file content');
    const fileEncoding = requiredTextFileEncoding(encoding);
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return invokeDesktopOperation(
        'writeProjectTextFileIn',
        [granted.root, granted.rel, text, expected, fileEncoding],
      );
    }
    const cleanProject = requiredString(projectPath, 'projectPath');
    const cleanRel = requiredString(relPath, 'relPath');
    return host.writeProjectTextFile(
      cleanProject,
      cleanRel,
      text,
      expected,
      fileEncoding,
    );
  });
  handle(DESKTOP_IPC.readEditorBackup, async (_event, projectPath, relPath, accessToken) => {
    if (!editorBackupRoot) return null;
    const file = await editorFilePath(projectPath, relPath, accessToken);
    return invokeDesktopOperation(
      'readEditorBackup',
      [editorBackupRoot, file],
    );
  });
  handle(DESKTOP_IPC.writeEditorBackup, async (
    _event,
    projectPath,
    relPath,
    content,
    expectedContent,
    accessToken,
  ) => {
    if (!editorBackupRoot) throw new Error('Editor backup storage is unavailable.');
    const file = await editorFilePath(projectPath, relPath, accessToken);
    return invokeDesktopOperation(
      'writeEditorBackup',
      [editorBackupRoot, file, content, expectedContent],
    );
  });
  handle(DESKTOP_IPC.deleteEditorBackup, async (_event, projectPath, relPath, accessToken) => {
    if (!editorBackupRoot) return;
    const file = await editorFilePath(projectPath, relPath, accessToken);
    await invokeDesktopOperation(
      'deleteEditorBackup',
      [editorBackupRoot, file],
    );
  });
  handle(DESKTOP_IPC.statProjectFile, async (_event, projectPath, relPath, accessToken) => {
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return invokeDesktopOperation(
        'statProjectFileIn',
        [granted.root, granted.rel],
      );
    }
    return host.statProjectFile(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    );
  });
  handle(DESKTOP_IPC.createProjectEntry, (_event, projectPath, relDir, name, dir) =>
    host.createProjectEntry(
      requiredString(projectPath, 'projectPath'),
      typeof relDir === 'string' ? relDir : '',
      requiredString(name, 'name'),
      dir === true,
    ));
  handle(DESKTOP_IPC.renameProjectEntry, (_event, projectPath, relPath, newName) =>
    host.renameProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      requiredString(newName, 'newName'),
    ));
  handle(DESKTOP_IPC.moveProjectEntry, (_event, projectPath, relPath, targetDirRel) =>
    host.moveProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      typeof targetDirRel === 'string' ? targetDirRel : '',
    ));
  handle(DESKTOP_IPC.copyProjectEntry, (_event, projectPath, relPath, targetDirRel) =>
    host.copyProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      typeof targetDirRel === 'string' ? targetDirRel : '',
    ));
  handle(DESKTOP_IPC.trashProjectEntry, async (_event, projectPath, relPath) => {
    const target = await host.projectEntryPath(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    );
    await shell.trashItem(target);
  });
  handle(DESKTOP_IPC.codeGraphQuery, (_event, projectPath, mode, symbol) => {
    if (mode !== 'find_symbol' && mode !== 'references' && mode !== 'symbols') {
      throw new TypeError('mode is invalid.');
    }
    return host.codeGraphQuery(
      requiredString(projectPath, 'projectPath'),
      mode,
      requiredString(symbol, 'symbol'),
    );
  });
  handle(DESKTOP_IPC.lspDocument, async (_event, rawInput) => {
    const input = requiredLspDocumentInput(rawInput);
    const root = await host.projectDirectory(input.projectPath);
    return invokeDesktopOperation('lspDocument', [input.projectPath, root, input]);
  });
  handle(DESKTOP_IPC.lspRequest, async (_event, rawInput) => {
    const input = requiredLspRequestInput(rawInput);
    const root = await host.projectDirectory(input.projectPath);
    return invokeDesktopOperation('lspRequest', [
      input.projectPath,
      root,
      input.relPath,
      input.languageId,
      input.method,
      input.params ?? {},
    ]);
  });
  handle(DESKTOP_IPC.lspApplyWorkspaceEdit, async (_event, projectPath, rawWrites) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    const writes = requiredWorkspaceTextWrites(rawWrites);
    return invokeDesktopOperation(
      'writeProjectTextFilesIn',
      [root, writes],
    );
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
  handle(DESKTOP_IPC.deleteSession, (_event, sessionId) =>
    host.deleteSession(requiredSessionId(sessionId)));
  handle(DESKTOP_IPC.prefetchSession, (_event, sessionId, itemLimit) =>
    host.prefetchSession(
      requiredSessionId(sessionId),
      requiredTranscriptItemLimit(itemLimit),
    ));
  const visibleSessionStateIds = new Set<string>();
  handle(DESKTOP_IPC.setVisibleSessions, async (_event, sessionIds) => {
    if (!Array.isArray(sessionIds) || sessionIds.length > 256) {
      throw new TypeError('sessionIds must be a bounded array.');
    }
    const normalized = [...new Set(sessionIds.map((sessionId) => requiredSessionId(sessionId)))];
    visibleSessionStateIds.clear();
    for (const sessionId of normalized) visibleSessionStateIds.add(sessionId);
    const released = releaseHiddenSessionStateEntries(
      visibleSessionStateIds,
      [sessionStateEncoders, latestSessionStates, latestSessionProvenance],
      (sessionId) => {
        if (window.isDestroyed() || window.webContents.isDestroyed()) return;
        const encoder = sessionStateEncoders.get(sessionId);
        window.webContents.send(DESKTOP_IPC.sessionState, {
          sessionId,
          wire: encoder ? encoder.encode(null) : null,
        });
      },
    );
    // The lane store now keeps a released pane painted, so this is diagnostic
    // only: it names WHICH registration dropped a session id, the one way to
    // see a mounted pane leave the visible set while it is still on screen.
    if (released.length > 0) {
      console.error('[mixdog-lane] baseline released'
        + ` count=${released.length} visible=${normalized.length}`
        + ` ids=${released.slice(0, 6).map((sessionId) => sessionId.slice(-8)).join(',')}`);
    }
    return (await host.setVisibleSessions?.(normalized)) === true;
  });
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
  handle(DESKTOP_IPC.getSnapshot, () => host.getSnapshot());
  handle(DESKTOP_IPC.getUpdaterState, () => updater?.getState() ?? { status: 'disabled' });
  handle(DESKTOP_IPC.checkForDesktopUpdate, () =>
    updater?.check() ?? Promise.resolve({ status: 'disabled' } as const));
  handle(DESKTOP_IPC.showDesktopUpdate, async () => {
    const current = updater?.getState() ?? { status: 'disabled' } as const;
    if (current.status !== 'ready' || !updater) return current;
    await updater.install();
    return updater.getState();
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
  handle(DESKTOP_IPC.browserSetActiveGuest, (_event, paneId, webContentsId, active) => {
    if (!browserHost) throw new Error('Browser Use is unavailable in this app surface.');
    if (typeof paneId !== 'string' || !/^browser_tab_[a-z0-9-]{4,120}$/i.test(paneId)) {
      throw new TypeError('Browser pane id is invalid.');
    }
    if (!Number.isSafeInteger(webContentsId) || Number(webContentsId) <= 0) {
      throw new TypeError('Browser guest id is invalid.');
    }
    if (typeof active !== 'boolean') throw new TypeError('Browser guest activity is invalid.');
    browserHost.setGuestActive(paneId, Number(webContentsId), active);
  });
  handle(DESKTOP_IPC.browserProfileImportSources, () => {
    if (!browserHost) throw new Error('Browser profile import is unavailable in this app surface.');
    return browserHost.browserImportSources();
  });
  handle(DESKTOP_IPC.browserProfileImportStart, (_event, value) => {
    if (!browserHost) throw new Error('Browser profile import is unavailable in this app surface.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Browser import request must be an object.');
    }
    const request = value as Record<string, unknown>;
    const jobId = String(request.jobId || '');
    const sourceId = String(request.sourceId || '');
    const profileId = String(request.profileId || '');
    const items = Array.isArray(request.items)
      ? request.items.map((item) => String(item))
      : [];
    if (!/^[a-zA-Z0-9_-]{8,120}$/.test(jobId)) throw new TypeError('Browser import job id is invalid.');
    if (!sourceId || sourceId.length > 100) throw new TypeError('Browser import source id is invalid.');
    if (!profileId || profileId.length > 200) throw new TypeError('Browser import profile id is invalid.');
    if (
      !items.length
      || items.length > 3
      || items.some((item) => !['passwords', 'cookies', 'history'].includes(item))
    ) {
      throw new TypeError('Browser import items are invalid.');
    }
    return browserHost.browserImport({
      jobId,
      sourceId,
      profileId,
      items: items as Array<'passwords' | 'cookies' | 'history'>,
      administratorApproved: request.administratorApproved === true,
    });
  });
  handle(DESKTOP_IPC.browserHistorySearch, (_event, query) => {
    if (!browserHost) throw new Error('Browser history is unavailable in this app surface.');
    if (typeof query !== 'string' || query.length > 500) {
      throw new TypeError('Browser history query is invalid.');
    }
    return browserHost.browserHistorySearch(query);
  });
  handle(DESKTOP_IPC.browserCredentialSuggestions, () => {
    if (!browserHost) throw new Error('Stored browser credentials are unavailable in this app surface.');
    return browserHost.browserCredentialSuggestions();
  });
  handle(DESKTOP_IPC.browserCredentialFill, (_event, credentialId) => {
    if (!browserHost) throw new Error('Stored browser credentials are unavailable in this app surface.');
    if (typeof credentialId !== 'string' || !/^[a-f0-9]{24}$/.test(credentialId)) {
      throw new TypeError('Stored browser credential id is invalid.');
    }
    return browserHost.browserCredentialFill(credentialId);
  });
  handle(DESKTOP_IPC.readGitPreferences, () =>
    settingsStore?.readGitPreferences() ?? invokeDesktopOperation('readGitPreferences', []));
  handle(DESKTOP_IPC.updateGitPreferences, (_event, preferences) => {
    const value = requiredGitPreferencesInput(preferences);
    return settingsStore
      ? settingsStore.updateGitPreferences(value)
      : invokeDesktopOperation('updateGitPreferences', [value]);
  });
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

  // Background turn-finished OS toasts removed (user decision): state fanout
  // only. Restore behind a setting if notifications return.
  // Streaming state pushes ride an identity-prefix delta. The daemon delta
  // decoder retains unchanged item identity, so only appended/changed items
  // cross the IPC serializer. A resync restarts from a full snapshot.
  let sentItems: readonly unknown[] | null = null;
  let sentStreamingTail: Record<string, unknown> | null = null;
  let sentStateFields: Record<string, unknown> | null = null;
  let sentRevision = 0;
  const snapshotFieldsFrom = (record: Record<string, unknown>): Record<string, unknown> => {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'items' && key !== 'streamingTail') fields[key] = value;
    }
    return fields;
  };
  const patchStateFields = (
    wire: Record<string, unknown>,
    record: Record<string, unknown>,
    base: number,
    revision: number,
  ): void => {
    const nextFields = snapshotFieldsFrom(record);
    const previousFields = sentStateFields || {};
    const changed: Record<string, unknown> = {};
    const removed: string[] = [];
    for (const [key, value] of Object.entries(nextFields)) {
      // The daemon delta decoder retains identity for unchanged fields, so a
      // deep walk here would only repeat work on every publication.
      if (!Object.hasOwn(previousFields, key) || !Object.is(previousFields[key], value)) {
        changed[key] = value;
      }
    }
    for (const key of Object.keys(previousFields)) {
      if (!Object.hasOwn(nextFields, key)) removed.push(key);
    }
    wire.__statePatch = { base, revision, changed, removed };
    sentStateFields = nextFields;
  };
  const streamingTailFrom = (record: Record<string, unknown> | null): Record<string, unknown> | null => {
    const value = record?.streamingTail;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  };
  const patchStreamingTail = (
    wire: Record<string, unknown>,
    nextTail: Record<string, unknown> | null,
  ): void => {
    const previousTail = sentStreamingTail;
    if (previousTail === nextTail) {
      sentStreamingTail = nextTail;
      return;
    }
    const previousText = typeof previousTail?.text === 'string' ? previousTail.text : '';
    const nextText = typeof nextTail?.text === 'string' ? nextTail.text : '';
    if (
      previousTail
      && nextTail
      && previousTail.id != null
      && previousTail.id === nextTail.id
      && nextText.length >= previousText.length
      && nextText.startsWith(previousText)
    ) {
      const tail = { ...nextTail };
      delete tail.text;
      delete wire.streamingTail;
      wire.__streamingTailPatch = {
        prefix: previousText.length,
        append: nextText.slice(previousText.length),
        tail,
      };
    } else {
      wire.streamingTail = nextTail;
    }
    sentStreamingTail = nextTail;
  };
  const sendEngineState = (snapshot: SessionSnapshot): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const record = snapshot as Record<string, unknown> | null;
    const items = record && Array.isArray(record.items) ? record.items as unknown[] : null;
    const streamingTail = streamingTailFrom(record);
    if (!items) {
      sentItems = null;
      sentStreamingTail = streamingTail;
      sentStateFields = record ? snapshotFieldsFrom(record) : null;
      window.webContents.send(DESKTOP_IPC.state, snapshot);
      return;
    }
    sentRevision += 1;
    if (sentItems) {
      const base = sentRevision - 1;
      let prefix = sentItems === items ? items.length : 0;
      if (sentItems !== items) {
        const shared = Math.min(sentItems.length, items.length);
        while (prefix < shared && sentItems[prefix] === items[prefix]) prefix += 1;
      }
      const wire: Record<string, unknown> = {};
      wire.__itemsPatch = {
        base,
        revision: sentRevision,
        prefix,
        append: items.slice(prefix),
      };
      patchStateFields(wire, record!, base, sentRevision);
      patchStreamingTail(wire, streamingTail);
      sentItems = items;
      window.webContents.send(DESKTOP_IPC.state, wire);
      return;
    }
    sentItems = items;
    sentStreamingTail = streamingTail;
    sentStateFields = snapshotFieldsFrom(record!);
    window.webContents.send(DESKTOP_IPC.state, { ...record, __itemsRevision: sentRevision });
  };
  const unsubscribeState = host.subscribe(sendEngineState);
  const onStateResync = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    sentItems = null;
    sentStreamingTail = null;
    sentStateFields = null;
    sendEngineState(host.getSnapshot());
  };
  ipcMain.on(DESKTOP_IPC.stateResync, onStateResync);
  // Sleep/resume: the renderer may have missed pushes while its frames were
  // throttled and the delta baseline cannot be trusted — restart the state
  // lane from a full snapshot on wake (system-resume broadcast).
  const onSystemResume = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    sentItems = null;
    sentStreamingTail = null;
    sentStateFields = null;
    sendEngineState(host.getSnapshot());
  };
  if (typeof powerMonitorRef?.on === 'function') powerMonitorRef.on('resume', onSystemResume);
  // Sidebar push: the host watches the on-disk session store and fans out a
  // fresh catalog; the renderer applies it without an extra list round-trip.
  // Guarded: embedders/tests may hand a partial host without the watcher API.
  const unsubscribeSessions = typeof host.subscribeSessions === 'function'
    ? host.subscribeSessions((sessions) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC.sessionsChanged, sessions);
      }
    })
    : () => {};
  const unsubscribeAgentPool = typeof host.subscribeAgentPool === 'function'
    ? host.subscribeAgentPool((agents) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC.agentPoolChanged, agents);
      }
    })
    : () => {};
  // Split panes: preserve the host's 20 Hz responsiveness while sending only
  // changed state and transcript suffixes. Preload reconstructs full snapshots
  // before renderer listeners run, retaining settled item identity.
  const sessionStateEncoders = new Map<string, SnapshotDeltaEncoder>();
  const latestSessionStates = new Map<string, SessionSnapshot>();
  // Provenance of the last frame per session: a delta resync must re-send the
  // same frame description, never an unversioned one.
  const latestSessionProvenance = new Map<string, {
    frameSource: 'live' | 'replay';
    contentRevision?: number;
  }>();
  const sendSessionState = (update: {
    sessionId: string;
    snapshot: SessionSnapshot;
    frameSource: 'live' | 'replay';
    contentRevision?: number;
    laneEnd?: 'gone' | 'unloaded' | 'disconnected';
  }): void => {
    const sessionId = String(update.sessionId || '');
    if (!sessionId || window.isDestroyed() || window.webContents.isDestroyed()) return;
    if (!shouldPublishSessionState(sessionId, update.snapshot, visibleSessionStateIds)) return;
    let encoder = sessionStateEncoders.get(sessionId);
    if (!encoder) encoder = createSnapshotDeltaEncoder();
    if (update.snapshot === null) {
      window.webContents.send(DESKTOP_IPC.sessionState, {
        sessionId,
        wire: encoder.encode(null),
        frameSource: update.frameSource,
        ...(update.laneEnd ? { laneEnd: update.laneEnd } : {}),
        ...(typeof update.contentRevision === 'number'
          ? { contentRevision: update.contentRevision }
          : {}),
      });
      sessionStateEncoders.delete(sessionId);
      latestSessionStates.delete(sessionId);
      latestSessionProvenance.delete(sessionId);
      return;
    }
    sessionStateEncoders.set(sessionId, encoder);
    latestSessionStates.delete(sessionId);
    latestSessionStates.set(sessionId, update.snapshot);
    latestSessionProvenance.set(sessionId, {
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number'
        ? { contentRevision: update.contentRevision }
        : {}),
    });
    window.webContents.send(DESKTOP_IPC.sessionState, {
      sessionId,
      wire: encoder.encode(update.snapshot),
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number'
        ? { contentRevision: update.contentRevision }
        : {}),
    });
  };
  const onSessionStateResync = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    const sessionId = String(value || '');
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !latestSessionStates.has(sessionId)) return;
    const provenance = latestSessionProvenance.get(sessionId);
    if (!provenance) return;
    sessionStateEncoders.get(sessionId)?.reset();
    sendSessionState({
      sessionId,
      snapshot: latestSessionStates.get(sessionId)!,
      ...provenance,
    });
  };
  ipcMain.on(DESKTOP_IPC.sessionStateResync, onSessionStateResync);
  const unsubscribeSessionStates = host.subscribeSessionStates(sendSessionState);
  const unsubscribeUpdater = updater?.subscribe((next) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(DESKTOP_IPC.updaterState, next);
    }
  }) ?? (() => {});
  const unsubscribeDesktopEvents = host.subscribeDesktopEvents?.(({ name, value }) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    if (name === 'folder-changed') window.webContents.send(DESKTOP_IPC.folderChanged, value);
    else if (name === 'lsp-diagnostics') window.webContents.send(DESKTOP_IPC.lspDiagnostics, value);
    else if (name === 'lsp-status') window.webContents.send(DESKTOP_IPC.lspStatus, value);
    else if (name === 'relay-payload-refused') {
      window.webContents.send(DESKTOP_IPC.relayPayloadRefused, value);
    }
    else if (name === 'remote-client-claim') {
      // Keep delivery global so a live renderer can queue the request, but do
      // not reveal or restore the window: only Settings → Connection is armed
      // to render it. A later panel open re-reads pending claims from service.
      window.webContents.send(DESKTOP_IPC.remoteClientClaim, value);
    }
  }) ?? (() => {});
  // Renderer perf lines ride a fire-and-forget event channel (no invoke).
  const onPerfLog = (_event: Electron.IpcMainEvent, line: unknown): void => {
    (host as { perfLog?: (line: string) => void }).perfLog?.(String(line ?? ''));
  };
  ipcMain.on(DESKTOP_IPC.perfLog, onPerfLog);
  // Dock terminal: invoke for ensure, fire-and-forget events for keystrokes
  // and resize (latency), a push event for PTY output. Same sender guard as
  // the invoke surface — a compromised child frame must not reach the PTY.
  const validTermSender = (event: Electron.IpcMainEvent): boolean =>
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  const terminalDataBufferer = new TerminalDataBufferer(
    (event) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC.termData, event);
      }
    },
    5,
    256 * 1024,
    terminals ? {
      pause: (id) => terminals.pauseOutput?.(id),
      resume: (id) => terminals.resumeOutput?.(id),
    } : undefined,
    32 * 1024,
  );
  if (terminals) {
    handle(DESKTOP_IPC.termEnsure, (_event, id, cwd, shell) => terminals.ensure(
      typeof id === 'string' && id ? id : null,
      typeof cwd === 'string' && cwd ? cwd : null,
      typeof shell === 'string' && shell ? shell : null,
    ));
    handle(DESKTOP_IPC.termProfiles, () => invokeDesktopOperation('termProfiles', []));
    handle(DESKTOP_IPC.termDispose, (_event, id) => {
      const terminalId = requiredString(id, 'terminal id', 128);
      terminalDataBufferer.release(terminalId);
      terminals.dispose(terminalId);
    });
  }
  // Dock Git panel: plain git CLI scoped to an absolute project directory.
  handle(DESKTOP_IPC.gitStatus, (_event, cwd, options) => {
    const record = options && typeof options === 'object'
      ? options as { reuseLineStats?: unknown }
      : {};
    return gitStatus(requiredRepositoryCwd(cwd), {
      reuseLineStats: record.reuseLineStats === true,
    });
  });
  handle(DESKTOP_IPC.gitBranches, (_event, cwd) => gitBranches(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitCheckoutBranch, (_event, cwd, branch, remote) =>
    gitCheckoutBranch(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      remote === true,
    ));
  handle(DESKTOP_IPC.gitCreateBranch, (_event, cwd, branch) =>
    gitCreateBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)));
  handle(DESKTOP_IPC.gitRenameBranch, (_event, cwd, branch, nextBranch) =>
    gitRenameBranch(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      requiredGitBranchName(nextBranch),
    ));
  handle(DESKTOP_IPC.gitDeleteBranch, (_event, cwd, branch) =>
    gitDeleteBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)));
  handle(DESKTOP_IPC.gitMergeBranch, (_event, cwd, branch) =>
    gitMergeBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)));
  handle(DESKTOP_IPC.gitDiff, (_event, cwd, path, staged, worktreeOnly, untracked) =>
    gitDiff(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      staged === true,
      worktreeOnly === true,
      untracked === true,
    ));
  handle(DESKTOP_IPC.gitApplyPatch, (_event, cwd, path, patch, reverse) => {
    if (reverse !== undefined && typeof reverse !== 'boolean') {
      throw new TypeError('git patch direction is invalid.');
    }
    return gitApplyPatch(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      requiredGitPatch(patch),
      reverse === true,
    );
  });
  handle(DESKTOP_IPC.gitStage, (_event, cwd, paths) =>
    gitStage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)));
  handle(DESKTOP_IPC.gitUnstage, (_event, cwd, paths) =>
    gitUnstage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)));
  handle(DESKTOP_IPC.gitCommit, (_event, cwd, message) =>
    gitCommit(requiredRepositoryCwd(cwd), requiredString(message, 'commit message', 20_000)));
  handle(DESKTOP_IPC.gitCommitPaths, (_event, cwd, message, paths) =>
    gitCommitPaths(
      requiredRepositoryCwd(cwd),
      requiredString(message, 'commit message', 20_000),
      requiredGitPaths(paths),
    ));
  handle(DESKTOP_IPC.gitGenerateCommitMessage, async (_event, cwd, files) => {
    const repository = requiredRepositoryCwd(cwd);
    const entries = requiredCommitMessageFiles(files);
    const preferences = settingsStore
      ? await settingsStore.readGitPreferences().catch(() => null)
      : await invokeDesktopOperation('readGitPreferences', []).catch(() => null);
    const message = await invokeDesktopOperation<string>(
      'gitGenerateCommitMessage',
      [repository, entries, preferences],
    );
    return { message };
  });
  handle(DESKTOP_IPC.gitAmend, (_event, cwd, message) =>
    gitAmend(requiredRepositoryCwd(cwd), requiredGitOptionalMessage(message)));
  handle(DESKTOP_IPC.gitUndoLastCommit, (_event, cwd) =>
    gitUndoLastCommit(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitStash, (_event, cwd, message) =>
    gitStash(requiredRepositoryCwd(cwd), requiredGitOptionalMessage(message)));
  handle(DESKTOP_IPC.gitStashPop, (_event, cwd) =>
    gitStashPop(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitStashList, (_event, cwd) =>
    gitStashList(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitStashApply, (_event, cwd, ref) =>
    gitStashApply(requiredRepositoryCwd(cwd), requiredString(ref, 'stash ref', 64)));
  handle(DESKTOP_IPC.gitStashDrop, (_event, cwd, ref) =>
    gitStashDrop(requiredRepositoryCwd(cwd), requiredString(ref, 'stash ref', 64)));
  handle(DESKTOP_IPC.ghPrList, (_event, cwd) => ghPrList(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.ghPrDefaultBranch, (_event, cwd) =>
    ghPrDefaultBranch(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.ghPrCreate, (_event, cwd, input) =>
    ghPrCreate(requiredRepositoryCwd(cwd), input));
  handle(DESKTOP_IPC.ghPrView, (_event, cwd, number) =>
    ghPrView(requiredRepositoryCwd(cwd), number));
  handle(DESKTOP_IPC.ghPrCheckout, (_event, cwd, number) =>
    ghPrCheckout(requiredRepositoryCwd(cwd), number));
  handle(DESKTOP_IPC.ghPrMerge, (_event, cwd, number, method) =>
    ghPrMerge(requiredRepositoryCwd(cwd), number, method));
  handle(DESKTOP_IPC.ghPrDiff, (_event, cwd, number) =>
    ghPrDiff(requiredRepositoryCwd(cwd), number));
  handle(DESKTOP_IPC.gitPush, (_event, cwd) => gitPush(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitFetch, (_event, cwd) => gitFetch(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitPull, (_event, cwd) => gitPull(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitSync, (_event, cwd) => gitSync(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitContinue, (_event, cwd) => gitContinue(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitAbortOperation, (_event, cwd) =>
    gitAbortOperation(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitIgnore, (_event, cwd, path, scope) =>
    gitIgnore(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      requiredGitIgnoreScope(scope),
    ));
  handle(DESKTOP_IPC.gitRevert, (_event, cwd, path, untracked, mode) =>
    gitRevertFile(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      untracked === true,
      requiredGitDiscardMode(mode),
    ));
  handle(DESKTOP_IPC.gitLog, (_event, cwd, query, skip, limit) => gitLog(
    requiredRepositoryCwd(cwd),
    requiredGitLogQuery(query),
    requiredGitLogOffset(skip),
    requiredGitLogLimit(limit),
  ));
  handle(DESKTOP_IPC.gitShow, (_event, cwd, hash) =>
    gitShow(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitShowDiff, (_event, cwd, hash, path) =>
    gitShowDiff(requiredRepositoryCwd(cwd), requiredCommitHash(hash), requiredGitPath(path)));
  handle(DESKTOP_IPC.gitShowFile, (_event, cwd, rev, path) =>
    gitShowFile(requiredRepositoryCwd(cwd), requiredGitRevision(rev), requiredGitPath(path)));
  // `confirmedDirty` is a CALLER CONTRACT, not evidence: the main side cannot
  // prove a warning was shown, and does not try to. The reference can gate this
  // on its own dialog callback because its store OWNS the dialog; here the flag
  // crosses a process boundary, and any caller that can reach this channel
  // (preload of our own window, or a paired remote client) is already trusted
  // with `gitResetToCommit(mode: 'hard')`, `gitDiscard` and `gitStash` — all of
  // which destroy strictly more uncommitted work than a `--mixed` reset, which
  // only UNSTAGES it (the content stays in the worktree, recoverable). The
  // refusal is therefore a safety NET for the honest caller that forgot to ask,
  // not a permission check; the destructive mode (`hard`) keeps refusing a
  // dirty worktree outright, with no flag that can wave it through.
  handle(DESKTOP_IPC.gitResetToCommit, (_event, cwd, hash, mode, confirmedDirty) => gitResetToCommit(
    requiredRepositoryCwd(cwd),
    requiredCommitHash(hash),
    requiredGitResetMode(mode),
    confirmedDirty === true,
  ));
  handle(DESKTOP_IPC.gitRevertCommit, (_event, cwd, hash) =>
    gitRevertCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitCherryPickCommit, (_event, cwd, hash) =>
    gitCherryPickCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitCreateTag, (_event, cwd, tag, hash) => gitCreateTag(
    requiredRepositoryCwd(cwd),
    requiredString(tag, 'git tag', 512),
    requiredCommitHash(hash),
  ));
  handle(DESKTOP_IPC.gitDeleteTag, (_event, cwd, tag) =>
    gitDeleteTag(requiredRepositoryCwd(cwd), requiredString(tag, 'git tag', 512)));
  handle(DESKTOP_IPC.gitCheckoutCommit, (_event, cwd, hash) =>
    gitCheckoutCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitCreateBranchAtCommit, (_event, cwd, branch, hash) =>
    gitCreateBranchAtCommit(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      requiredCommitHash(hash),
    ));
  handle(DESKTOP_IPC.gitReview, (_event, cwd) => gitReview(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitReviewDiff, (_event, cwd, path, untracked) =>
    gitReviewDiff(requiredRepositoryCwd(cwd), requiredGitPath(path), untracked === true));
  // Review context menu: OS reveal/open, confined to the project directory.
  const resolveInsideProject = (cwd: unknown, path: unknown): string => {
    const root = resolvePath(requiredRepositoryCwd(cwd));
    const absolute = resolvePath(root, requiredString(path, 'file path', 4_096));
    if (absolute !== root && !absolute.startsWith(root + pathSep)) {
      throw new TypeError('The file path escapes the project directory.');
    }
    return absolute;
  };
  handle(DESKTOP_IPC.revealFile, async (_event, cwd, path, accessToken) => {
    const absolute = typeof accessToken === 'string' && accessToken
      ? (await grantedFile(accessToken, cwd, path)).absolute
      : resolveInsideProject(cwd, path);
    shell.showItemInFolder(absolute);
  });
  handle(DESKTOP_IPC.openFilePath, async (_event, cwd, path, accessToken) => {
    const absolute = typeof accessToken === 'string' && accessToken
      ? (await grantedFile(accessToken, cwd, path)).absolute
      : resolveInsideProject(cwd, path);
    const failure = await shell.openPath(absolute);
    if (failure) throw new Error(`Unable to open file: ${failure}`);
  });
  // Transcript attachment chip: the renderer holds a submitted image only as a
  // session-lifetime preview data URL, so the bytes arrive here. The temp file
  // handed to the OS viewer is named from our own digest — no caller-supplied
  // path reaches the shell, and reopening one image reuses a single file
  // instead of littering the temp directory.
  handle(DESKTOP_IPC.openAttachmentImage, async (_event, dataUrl, name) => {
    const image = requiredAttachmentImage(dataUrl);
    const temp = typeof app.getPath === 'function' ? app.getPath('temp') : '';
    if (!temp) throw new Error('Unable to open image: no temporary directory.');
    const directory = joinPath(temp, 'mixdog-attachments');
    await fsMkdir(directory, { recursive: true });
    const digest = createHash('sha256').update(image.bytes).digest('hex').slice(0, 16);
    const file = joinPath(
      directory,
      `${attachmentImageBaseName(name)}-${digest}.${image.extension}`,
    );
    await fsWriteFile(file, image.bytes, { mode: 0o600 });
    const failure = await shell.openPath(file);
    if (failure) throw new Error(`Unable to open image: ${failure}`);
  });
  const onTermWrite = (event: Electron.IpcMainEvent, id: unknown, data: unknown): void => {
    if (!validTermSender(event)) return;
    terminals?.write(String(id || ''), String(data ?? ''));
  };
  const onTermResize = (event: Electron.IpcMainEvent, id: unknown, cols: unknown, rows: unknown): void => {
    if (!validTermSender(event)) return;
    terminals?.resize(String(id || ''), Number(cols), Number(rows));
  };
  const onTermAcknowledge = (
    event: Electron.IpcMainEvent,
    id: unknown,
    charCount: unknown,
  ): void => {
    if (!validTermSender(event)) return;
    terminalDataBufferer.acknowledge(String(id || ''), Number(charCount));
  };
  ipcMain.on(DESKTOP_IPC.termWrite, onTermWrite);
  ipcMain.on(DESKTOP_IPC.termResize, onTermResize);
  ipcMain.on(DESKTOP_IPC.termAcknowledge, onTermAcknowledge);
  const unsubscribeTerminals = terminals?.subscribe((event) => {
    terminalDataBufferer.push(event);
  }) ?? (() => {});
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
    unsubscribeState();
    unsubscribeSessions();
    unsubscribeAgentPool();
    unsubscribeSessionStates();
    sessionStateEncoders.clear();
    latestSessionStates.clear();
    latestSessionProvenance.clear();
    visibleSessionStateIds.clear();
    unsubscribeUpdater();
    unsubscribeTerminals();
    unsubscribeDesktopEvents();
    terminalDataBufferer.dispose();
    if (typeof powerMonitorRef?.removeListener === 'function') {
      powerMonitorRef.removeListener('resume', onSystemResume);
    }
    ipcMain.removeListener(DESKTOP_IPC.perfLog, onPerfLog);
    ipcMain.removeListener(DESKTOP_IPC.stateResync, onStateResync);
    ipcMain.removeListener(DESKTOP_IPC.sessionStateResync, onSessionStateResync);
    ipcMain.removeListener(DESKTOP_IPC.termWrite, onTermWrite);
    ipcMain.removeListener(DESKTOP_IPC.termResize, onTermResize);
    ipcMain.removeListener(DESKTOP_IPC.termAcknowledge, onTermAcknowledge);
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
