import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { childEnvironment } from './child-environment';
import { listHostDirectories, listServerDirectories } from './host-directories';
import * as editorBackups from './editor-backups';
import * as gh from './gh-cli';
import * as git from './git-cli';
import * as gitRequestContext from './git-request-context';
import * as gitPathspecChanges from './git-pathspec-changes';
import * as remoteProjectFiles from './remote-project-files';
import * as github from './github-cli';
import { createGithubService } from './github-service';
import { LanguageServerManager } from './language-server-manager';
import * as localFiles from './local-files';
import * as libreoffice from './libreoffice';
import * as projectFiles from './project-files';
import { projectRecoveryIn } from './project-recovery';
import { listShellProfiles, resolveShellProfileSpawn } from './shell-profiles';
import { DesktopSettingsStore, settingsConfigModuleUrl } from './settings-store';
import type { MixdogConfigModule } from './settings-store';
import { TerminalManager } from './terminal-manager';
import * as workspaceConfig from './workspace-config';
import * as workspaceSearch from './workspace-search';
import { createDocumentPreviewOperations } from './document-preview';
import type { DocumentPreviewModule } from './document-preview';
import { createServerFileOperations } from './server-file-operations';
import { listListeningPorts } from './server-ports';

import { ACTIVITY_RAIL_PINS_EVENT } from '../shared/activity-rail-pins';
import { PROVIDER_MODELS_EVENT } from '../shared/provider-models';
import { TERMINAL_SIZE_OWNER_EVENT, type TerminalSizeOwner } from '../shared/terminal-size-owner';
import { TERMINAL_ACTIVITY_EVENT } from '../shared/terminal-activity';
import { readSettingsChange, SETTINGS_CHANGED_EVENT, UPDATER_STATE_EVENT } from '../shared/settings-changed';
import { BROWSER_APPROVAL_SESSIONS_EVENT, readBrowserApprovalSessions } from '../shared/browser-approval-sessions';

interface DesktopOperationEvent {
  name:
    | 'folder-changed'
    | 'lsp-diagnostics'
    | 'lsp-status'
    | 'terminal-data'
    | typeof TERMINAL_SIZE_OWNER_EVENT
    | typeof TERMINAL_ACTIVITY_EVENT
    | typeof ACTIVITY_RAIL_PINS_EVENT
    | typeof PROVIDER_MODELS_EVENT
    | typeof SETTINGS_CHANGED_EVENT
    | typeof UPDATER_STATE_EVENT
    | typeof BROWSER_APPROVAL_SESSIONS_EVENT;
  value: unknown;
}

interface DesktopOperationsOptions {
  withRecoveryStore?<T>(
    root: string,
    action: 'write' | 'restore' | 'inspect' | 'discard',
    run: () => Promise<T>
  ): Promise<T>;
  userDataPath: string;
  packaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  loadConfig?: () => Promise<MixdogConfigModule>;
  loadDocumentPreview?: () => Promise<DocumentPreviewModule>;
  emit(event: DesktopOperationEvent): void;
}

const GITHUB_REPO_SLUG = 'tribgames/mixdog';

function runGh(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((done) => {
    execFile(
      'gh',
      args,
      {
        timeout: 8_000,
        windowsHide: true,
        env: childEnvironment(),
      },
      (error, _stdout, stderr) => {
        done({ ok: !error, stderr: String(stderr || '') });
      }
    );
  });
}

async function githubStarStatus(): Promise<{ available: boolean; starred: boolean }> {
  const probe = await runGh(['api', `user/starred/${GITHUB_REPO_SLUG}`, '--silent']);
  if (probe.ok) return { available: true, starred: true };
  if (/HTTP 404/i.test(probe.stderr)) return { available: true, starred: false };
  return { available: false, starred: false };
}

async function starGithub(): Promise<{ starred: boolean }> {
  const result = await runGh(['api', '-X', 'PUT', `user/starred/${GITHUB_REPO_SLUG}`, '--silent']);
  if (!result.ok) throw new Error(result.stderr.trim() || 'gh could not star the repository.');
  return { starred: true };
}

// PTY output is bursty: node-pty emits one chunk per read, and each chunk
// used to become its own daemon frame, SSE write, and renderer IPC message.
// Joining the chunks that land inside one coalescing window collapses that
// traffic without holding the first byte longer than a frame.
const TERMINAL_COALESCE_MS = 8;

/** Buffers one terminal's output for a frame and emits it as a single event.
 *  Owns nothing else: the PTYs stay with the terminal manager. */
function createTerminalOutputCoalescer(
  terminals: Pick<TerminalManager, 'subscribe'>,
  emit: (event: DesktopOperationEvent) => void
) {
  const chunks = new Map<string, string[]>();
  const timers = new Map<string, NodeJS.Timeout>();
  const drop = (id: string): void => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    chunks.delete(id);
  };
  const flush = (id: string): void => {
    const buffered = chunks.get(id);
    drop(id);
    if (!buffered || buffered.length === 0) return;
    emit({ name: 'terminal-data', value: { id, data: buffered.join('') } });
  };
  const unsubscribe = terminals.subscribe((value) => {
    const id = String(value?.id || '');
    const data = String(value?.data || '');
    if (!id || !data) return;
    const buffered = chunks.get(id);
    if (buffered) {
      buffered.push(data);
      return;
    }
    chunks.set(id, [data]);
    const timer = setTimeout(() => flush(id), TERMINAL_COALESCE_MS);
    timer.unref();
    timers.set(id, timer);
  });
  return {
    /** A disposed terminal has no output left to deliver. */
    drop,
    dispose(): void {
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      chunks.clear();
    },
  };
}

/** Reference-counted directory watches, debounced per directory. One entry per
 *  (directory, recursive) pair, because both forms watch different trees. */
export function createFolderWatchRegistry(
  emit: (event: DesktopOperationEvent) => void,
  watchDirectory: typeof watch = watch
) {
  const watchers = new Map<
    string,
    {
      watcher: FSWatcher;
      count: number;
      timer: NodeJS.Timeout | null;
    }
  >();
  const watchKey = (path: string) => (process.platform === 'win32' ? path.toLocaleLowerCase() : path);
  const registryKey = (dir: string, recursive: boolean) => `${watchKey(dir)}\0${recursive ? 'recursive' : 'direct'}`;
  const closeWatch = (state: { watcher: FSWatcher; timer: NodeJS.Timeout | null }) => {
    if (state.timer) clearTimeout(state.timer);
    try {
      state.watcher.close();
    } catch {}
  };
  return {
    watch(dir: string, recursive: boolean): void {
      const key = registryKey(dir, recursive);
      const existing = watchers.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      const watcher = watchDirectory(dir, { persistent: false, recursive }, () => {
        const state = watchers.get(key);
        if (!state || state.timer) return;
        state.timer = setTimeout(() => {
          state.timer = null;
          emit({ name: 'folder-changed', value: dir });
        }, 250);
      });
      watcher.on('error', () => {
        closeWatch({ watcher, timer: watchers.get(key)?.timer ?? null });
        watchers.delete(key);
      });
      watchers.set(key, { watcher, count: 1, timer: null });
    },
    unwatch(dir: string, recursive: boolean): void {
      const key = registryKey(dir, recursive);
      const state = watchers.get(key);
      if (!state) return;
      state.count -= 1;
      if (state.count <= 0) {
        closeWatch(state);
        watchers.delete(key);
      }
    },
    dispose(): void {
      for (const state of watchers.values()) closeWatch(state);
      watchers.clear();
    },
  };
}

const STATIC_OPERATIONS = {
  deleteEditorBackup: editorBackups.deleteEditorBackup,
  ghPrCheckout: gh.ghPrCheckout,
  ghPrCreate: gh.ghPrCreate,
  ghPrDefaultBranch: gh.ghPrDefaultBranch,
  ghPrDiff: gh.ghPrDiff,
  ghPrList: gh.ghPrList,
  ghPrMerge: gh.ghPrMerge,
  ghPrView: gh.ghPrView,
  cancelGithubCliLogin: github.cancelGithubCliLogin,
  githubCliAccount: github.githubCliAccount,
  githubCliLoginStart: github.githubCliLoginStart,
  githubCliLoginStatus: github.githubCliLoginStatus,
  githubCliLoginOpenBrowser: github.githubCliLoginOpenBrowser,
  githubCliLogout: github.githubCliLogout,
  githubCliStatus: github.githubCliStatus,
  gitCliStatus: github.gitCliStatus,
  gitGlobalConfig: github.gitGlobalConfig,
  installGitCli: github.installGitCli,
  installGithubCli: github.installGithubCli,
  setGitGlobalConfig: github.setGitGlobalConfig,
  libreOfficeStatus: libreoffice.libreOfficeStatus,
  gitAbortOperation: git.gitAbortOperation,
  gitAmend: git.gitAmend,
  gitApplyPatch: git.gitApplyPatch,
  gitBranches: git.gitBranches,
  gitCherryPickCommit: git.gitCherryPickCommit,
  gitCommit: git.gitCommit,
  gitCommitPaths: git.gitCommitPaths,
  gitContinue: git.gitContinue,
  gitCreateTag: git.gitCreateTag,
  gitDeleteBranch: git.gitDeleteBranch,
  gitDeleteTag: git.gitDeleteTag,
  gitDiff: git.gitDiff,
  gitFetch: git.gitFetch,
  gitIgnore: git.gitIgnore,
  gitLog: git.gitLog,
  gitPull: git.gitPull,
  gitPush: git.gitPush,
  gitRenameBranch: git.gitRenameBranch,
  gitResetToCommit: git.gitResetToCommit,
  gitRevertCommit: git.gitRevertCommit,
  gitRevertFile: git.gitRevertFile,
  gitReview: git.gitReview,
  gitReviewDiff: git.gitReviewDiff,
  gitReviewDiffs: git.gitReviewDiffs,
  gitShow: git.gitShow,
  gitShowDiff: git.gitShowDiff,
  gitShowFile: git.gitShowFile,
  gitRequestContext: gitRequestContext.gitRequestContext,
  gitPathspecChanges: gitPathspecChanges.gitPathspecChanges,
  gitStage: git.gitStage,
  gitStash: git.gitStash,
  gitStashApply: git.gitStashApply,
  gitStashDrop: git.gitStashDrop,
  gitStashList: git.gitStashList,
  gitStashPop: git.gitStashPop,
  gitStatus: git.gitStatus,
  gitSync: git.gitSync,
  gitUndoLastCommit: git.gitUndoLastCommit,
  gitUnstage: git.gitUnstage,
  readEditorBackup: editorBackups.readEditorBackup,
  readLocalFileAbs: localFiles.readLocalFileAbs,
  statLocalEntryAbs: localFiles.statLocalEntryAbs,
  readProjectTextFileIn: projectFiles.readProjectTextFileIn,
  readProjectTextFileAuthorized: remoteProjectFiles.readProjectTextFileAuthorized,
  writeProjectTextFileAuthorized: remoteProjectFiles.writeProjectTextFileAuthorized,
  readMarkdownDefaultView: workspaceConfig.readMarkdownDefaultView,
  readScopedEditorSettings: workspaceConfig.readScopedEditorSettings,
  writeMarkdownDefaultView: workspaceConfig.writeMarkdownDefaultView,
  readWorkspaceFile: workspaceConfig.readWorkspaceFile,
  searchWorkspaceTextIn: workspaceSearch.searchWorkspaceTextIn,
  statProjectFileIn: projectFiles.statProjectFileIn,
  listHostDirectories,
  listServerDirectories,
  writeEditorBackup: editorBackups.writeEditorBackup,
  writeProjectTextFileIn: projectFiles.writeProjectTextFileIn,
  writeWorkspaceFile: workspaceConfig.writeWorkspaceFile,
} satisfies Record<string, (...args: never[]) => unknown>;

/** One named operation: its RPC arguments in, its answer out. */
type OperationHandler = (args: unknown[]) => unknown;
type Emit = (event: DesktopOperationEvent) => void;
type InstallPaths = Pick<DesktopOperationsOptions, 'packaged' | 'resourcesPath' | 'appPath'>;

/** Edits and restores run inside the root's recovery store; anything but an
 *  inspection reports the folder changed. Recovery storage belongs to the
 *  file host, never to an RPC argument. */
function recoveryOperations(
  userDataPath: string,
  withRecoveryStore: NonNullable<DesktopOperationsOptions['withRecoveryStore']>,
  emit: Emit
): Record<string, OperationHandler> {
  const recoveryOperation = <T>(
    root: string,
    action: 'write' | 'restore' | 'inspect' | 'discard',
    run: () => Promise<T>
  ) =>
    withRecoveryStore(root, action, run).finally(() => {
      if (action !== 'inspect') emit({ name: 'folder-changed', value: root });
    });
  return {
    projectRecoveryIn: (args) => {
      const action = (args[1] as { action?: string })?.action;
      return recoveryOperation(
        args[0] as string,
        action === 'restore' || action === 'discard' ? action : 'inspect',
        () => projectRecoveryIn(userDataPath, args[0] as string, args[1])
      );
    },
    writeProjectTextFilesIn: (args) =>
      recoveryOperation(args[0] as string, 'write', () =>
        projectFiles.writeProjectTextFilesIn(
          args[0] as string,
          args[1] as Parameters<typeof projectFiles.writeProjectTextFilesIn>[1],
          userDataPath
        )
      ),
    writeProjectTextFilesAuthorized: (args) =>
      recoveryOperation(args[0] as string, 'write', () =>
        remoteProjectFiles.writeProjectTextFilesAuthorized(
          args[0] as string,
          args[1] as Parameters<typeof remoteProjectFiles.writeProjectTextFilesAuthorized>[1],
          userDataPath
        )
      ),
    replaceWorkspaceTextIn: (args) =>
      recoveryOperation(args[0] as string, 'write', () =>
        workspaceSearch.replaceWorkspaceTextIn(
          args[0] as string,
          args[1] as Parameters<typeof workspaceSearch.replaceWorkspaceTextIn>[1],
          args[2] as string,
          args[3] as readonly string[] | undefined,
          undefined,
          userDataPath
        )
      ),
  };
}

/** The GitHub API through the configured account, and this repository's star. */
function githubOperations(executeGithub: ReturnType<typeof createGithubService>): Record<string, OperationHandler> {
  return {
    githubRequest: (args) => executeGithub(args[0], args[1]),
    githubStarStatus: () => githubStarStatus(),
    starGithub: () => starGithub(),
  };
}

/** Document previews and the office suite that renders them. */
function documentOperations(
  documentPreviews: ReturnType<typeof createDocumentPreviewOperations>,
  { packaged, resourcesPath, appPath }: InstallPaths
): Record<string, OperationHandler> {
  return {
    documentPreviewIn: (args) => documentPreviews.documentPreviewIn(String(args[0] || ''), String(args[1] || '')),
    documentPreviewPagesIn: (args) =>
      documentPreviews.documentPreviewPagesIn(
        String(args[0] || ''),
        String(args[1] || ''),
        (args[2] ?? {}) as { pages?: unknown; maxWidth?: unknown; password?: unknown }
      ),
    installLibreOffice: () => libreoffice.installLibreOffice({ packaged, resourcesPath, appPath }),
  };
}

/** Desktop settings: reads and updates; saved rail pins are announced. */
function settingsOperations(settingsStore: DesktopSettingsStore, emit: Emit): Record<string, OperationHandler> {
  return {
    readSettings: () => settingsStore.read(),
    readActivityRailPins: () => settingsStore.readActivityRailPins(),
    updateActivityRailPins: async (args) => {
      if (args[1] !== undefined && typeof args[1] !== 'boolean') {
        throw new TypeError('initializeIfMissing must be a boolean.');
      }
      const saved = await settingsStore.updateActivityRailPins(args[0], args[1] === true);
      emit({ name: ACTIVITY_RAIL_PINS_EVENT, value: saved });
      return saved;
    },
    updateSetting: (args) =>
      settingsStore.update(args[0] as Parameters<DesktopSettingsStore['update']>[0], args[1] === true),
    updateNotificationVolume: (args) => settingsStore.updateNotificationVolume(Number(args[0])),
    readZoom: () => settingsStore.readZoom(),
    updateZoom: (args) => settingsStore.updateZoom(Number(args[0])),
  };
}

/** State the window process owns, announced to every client: provider and
 *  settings changes, the updater, and the sessions with a Browser Use
 *  approval waiting. */
function windowEventOperations(emit: Emit): Record<string, OperationHandler> {
  // The last list the window published (publishBrowserApprovalSessions).
  let browserApprovalSessions: string[] = [];
  return {
    notifyProviderModelsChanged: (args) => {
      emit({ name: PROVIDER_MODELS_EVENT, value: { origin: args[0] } });
      return undefined;
    },
    notifySettingsChanged: (args) => {
      const change = readSettingsChange({ scope: args[0] });
      if (!change) throw new TypeError('settings scope is invalid.');
      emit({ name: SETTINGS_CHANGED_EVENT, value: change });
      return undefined;
    },
    // The window process owns the updater; remote clients learn its state here.
    publishUpdaterState: (args) => {
      emit({ name: UPDATER_STATE_EVENT, value: args[0] });
      return undefined;
    },
    // The window process holds the Browser Use approval cards; paired devices
    // learn which sessions have one waiting (ids only) here.
    publishBrowserApprovalSessions: (args) => {
      const ids = readBrowserApprovalSessions(args[0]);
      if (!ids) throw new TypeError('browser approval sessions are invalid.');
      browserApprovalSessions = ids;
      emit({ name: BROWSER_APPROVAL_SESSIONS_EVENT, value: ids });
      return undefined;
    },
    readBrowserApprovalSessions: () => browserApprovalSessions,
  };
}

/** Language servers: their diagnostics and status as events, and the `lsp*`
 *  operations. */
function createLanguageServerOperations(emit: Emit) {
  const languageServers = new LanguageServerManager();
  const unsubscribeDiagnostics = languageServers.subscribeDiagnostics((value) => {
    emit({ name: 'lsp-diagnostics', value });
  });
  const unsubscribeStatus = languageServers.subscribeStatus((value) => {
    emit({ name: 'lsp-status', value });
  });
  const operations: Record<string, OperationHandler> = {
    lspDocument: (args) =>
      languageServers.document(
        String(args[0] || ''),
        String(args[1] || ''),
        args[2] as Parameters<LanguageServerManager['document']>[2]
      ),
    lspRequest: (args) =>
      languageServers.request(
        String(args[0] || ''),
        String(args[1] || ''),
        String(args[2] || ''),
        String(args[3] || ''),
        args[4] as Parameters<LanguageServerManager['request']>[4],
        args[5] as Parameters<LanguageServerManager['request']>[5]
      ),
    lspDisposeUnder: (args) => languageServers.disposeUnder(String(args[0] || '')),
  };
  return {
    operations,
    stopEvents(): void {
      unsubscribeDiagnostics();
      unsubscribeStatus();
    },
    dispose: (): Promise<void> => languageServers.dispose(),
  };
}

/** The desktop's terminals: the PTY manager, its coalesced output, size-owner
 *  and activity events, and the `term*` operations. */
function createTerminalOperations(terminals: TerminalManager, emit: Emit) {
  const terminalOutput = createTerminalOutputCoalescer(terminals, emit);
  const unsubscribeSizeOwner = terminals.subscribeSizeOwner((value) => {
    emit({ name: TERMINAL_SIZE_OWNER_EVENT, value });
  });
  const unsubscribeActivity = terminals.subscribeActivity((value) => {
    emit({ name: TERMINAL_ACTIVITY_EVENT, value });
  });
  const operations: Record<string, OperationHandler> = {
    termEnsure: async (args) => {
      const requestedProfile = args[2];
      const profile =
        requestedProfile && typeof requestedProfile === 'object'
          ? (requestedProfile as Parameters<TerminalManager['ensure']>[2])
          : await resolveShellProfileSpawn(requestedProfile);
      return terminals.ensure(
        typeof args[0] === 'string' && args[0] ? args[0] : null,
        typeof args[1] === 'string' && args[1] ? args[1] : null,
        profile
      );
    },
    // Attach-only (warm-ups): a running PTY's replay, or null; never spawns.
    termAttach: (args) => terminals.attach(String(args[0] || '')),
    termProfiles: () => listShellProfiles(),
    // Read-only views for the agent `terminal` bridge (see terminal/bridge-server.ts).
    termSessionTabs: (args) => terminals.sessionTabs(String(args[0] || '')),
    termSnapshot: (args) => terminals.snapshot(String(args[0] || ''), args[1] == null ? undefined : Number(args[1])),
    termWrite: (args) => {
      terminals.write(String(args[0] || ''), String(args[1] ?? ''));
      return null;
    },
    termActivity: () => terminals.activitySnapshot(),
    termFocus: (args) => {
      terminals.focus(String(args[0] || ''), typeof args[2] === 'string' ? args[2] : '', args[1] === true);
      return null;
    },
    termResize: (args) => {
      terminals.resize(
        String(args[0] || ''),
        Number(args[1]),
        Number(args[2]),
        typeof args[3] === 'string' ? args[3] : ''
      );
      return null;
    },
    termPause: (args) => {
      terminals.pauseOutput(String(args[0] || ''));
      return null;
    },
    termResume: (args) => {
      terminals.resumeOutput(String(args[0] || ''));
      return null;
    },
    termDispose: (args) => {
      const terminalId = String(args[0] || '');
      terminalOutput.drop(terminalId);
      terminals.dispose(terminalId);
      return null;
    },
    termDisposeUnder: (args) => {
      const ids = terminals.disposeTerminalsUnder(String(args[0] || ''));
      for (const id of ids) terminalOutput.drop(id);
      return ids;
    },
  };
  return {
    operations,
    stopEvents(): void {
      terminalOutput.dispose();
      unsubscribeSizeOwner();
      unsubscribeActivity();
    },
  };
}

/** Folder watches a window or device holds open. */
function folderOperations(
  folderWatchers: ReturnType<typeof createFolderWatchRegistry>
): Record<string, OperationHandler> {
  return {
    folderWatch: (args) => {
      folderWatchers.watch(localFiles.absoluteLocalPath(args[0]), args[1] === true);
      return null;
    },
    folderUnwatch: (args) => {
      folderWatchers.unwatch(localFiles.absoluteLocalPath(args[0]), args[1] === true);
      return null;
    },
  };
}

export function createDesktopOperations({
  userDataPath,
  withRecoveryStore = (_root, _action, run) => run(),
  packaged,
  resourcesPath,
  appPath,
  loadConfig,
  loadDocumentPreview,
  emit,
}: DesktopOperationsOptions) {
  const languageServerOperations = createLanguageServerOperations(emit);
  const terminals = new TerminalManager({ shellIntegrationDir: join(userDataPath, 'shell-integration') });
  const settingsStore = new DesktopSettingsStore({
    packaged,
    resourcesPath,
    appPath,
    loadConfig,
  });
  const executeGithub = createGithubService(
    loadConfig ??
      (async () =>
        import(
          /* @vite-ignore */ settingsConfigModuleUrl(packaged, resourcesPath, appPath)
        ) as Promise<MixdogConfigModule>)
  );
  // Converted documents are a cache, not user data: they live under the app's
  // own directory and are evicted, never synced or backed up.
  const documentPreviews = createDocumentPreviewOperations({
    cacheRoot: userDataPath,
    loadDocumentPreview,
  });
  const folderWatchers = createFolderWatchRegistry(emit);
  // Upload staging, ranged reads and trash for server windows' files.
  const serverFiles = createServerFileOperations({ userDataPath });
  const terminalOperations = createTerminalOperations(terminals, emit);
  // Every named operation but the static and server-file tables; the names
  // are distinct across these groups.
  const operations = new Map<string, OperationHandler>(
    Object.entries({
      ...recoveryOperations(userDataPath, withRecoveryStore, emit),
      ...githubOperations(executeGithub),
      ...documentOperations(documentPreviews, { packaged, resourcesPath, appPath }),
      ...settingsOperations(settingsStore, emit),
      ...windowEventOperations(emit),
      ...languageServerOperations.operations,
      ...terminalOperations.operations,
      // The Ports panel of a server window: what listens on this machine.
      listListeningPorts: () => listListeningPorts(),
      ...folderOperations(folderWatchers),
    })
  );

  async function invoke(name: string, args: unknown[] = []): Promise<unknown> {
    const operation = operations.get(name);
    if (operation) return operation(args);
    const staticOperation = STATIC_OPERATIONS[name as keyof typeof STATIC_OPERATIONS] as
      | ((...values: unknown[]) => unknown)
      | undefined;
    if (staticOperation) return await staticOperation(...args);
    if (serverFiles.handles(name)) return serverFiles.invoke(name, args);
    throw new TypeError('Mixdog desktop service operation is unavailable.');
  }

  async function dispose(): Promise<void> {
    languageServerOperations.stopEvents();
    terminalOperations.stopEvents();
    folderWatchers.dispose();
    terminals.disposeAll();
    await languageServerOperations.dispose();
    await serverFiles.dispose();
  }

  const remoteTerminals = {
    ensure(
      id: string | null,
      cwd: string | null,
      profile?: import('./terminal-contract').TerminalSpawnProfile | string | null
    ) {
      return invoke('termEnsure', [id, cwd, profile ?? null]) as Promise<{
        id: string;
        replay: string;
        sizeOwner?: TerminalSizeOwner;
      }>;
    },
    attach(id: string) {
      return invoke('termAttach', [id]) as Promise<{
        id: string;
        replay: string;
        sizeOwner?: TerminalSizeOwner;
      } | null>;
    },
    write(id: string, data: string): void {
      void invoke('termWrite', [id, data]).catch(() => {});
    },
    /** `client` is the remote connection of a phone claiming the size; '' for any other view. */
    resize(id: string, cols: number, rows: number, client = ''): void {
      void invoke('termResize', [id, cols, rows, client]).catch(() => {});
    },
  };

  return {
    invoke,
    dispose,
    userDataPath,
    terminals: remoteTerminals,
    settingsStore,
    serverFiles,
    subscribeTerminalData: (listener: (event: { id: string; data: string }) => void) => terminals.subscribe(listener),
  };
}
