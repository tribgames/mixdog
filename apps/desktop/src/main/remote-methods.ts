// Transport-neutral method table for the remote Relay client: the
// same desktop service surface registerDesktopIpc exposes, minus desktop-only OS
// integrations (dialogs, shell reveal/open, zoom, updater, quit). Validation
// reuses the ipc.ts validators so the remote surface can never accept a shape
// the in-process IPC surface would reject.
import { randomUUID } from 'node:crypto';
import {
  basename as pathBasename,
  dirname as pathDirname,
  relative as pathRelative,
  resolve as resolvePath,
  sep as pathSep,
} from 'node:path';

import type { DesktopService } from './desktop-service-contract';
import type { DesktopSettingsStore } from './settings-store';
import type { DesktopLocalPathEntry, DesktopSettings } from '../shared/contract';
import {
  normalizeRemoteBrowserControl,
  normalizeRemoteBrowserFrameId,
} from '../shared/remote-browser';
import { requiredSessionId } from './desktop-state';
import type { TerminalSpawnProfile } from './terminal-contract';
import {
  projectDisplayName,
  requiredAbortOptions,
  requiredDesktopCapabilityReadRequests,
  requiredDesktopCapabilityRequest,
  requiredDesktopSettingKey,
  requiredFileSearchLimit,
  requiredGitDiscardMode,
  requiredGitBranchName,
  requiredGitLogLimit,
  requiredGitLogOffset,
  requiredGitLogQuery,
  requiredGitPatch,
  requiredGitPath,
  requiredGitPaths,
  requiredGitOptionalMessage,
  requiredModelCatalogOptions,
  requiredModelSelection,
  requiredNewTaskDraft,
  requiredPromptContent,
  requiredString,
  requiredSubmitOptions,
  requiredSessionMessageCount,
  requiredTranscriptItemLimit,
  requiredToolApprovalDecision,
  sessionDisplayName,
} from './ipc';
import {
  requiredCommitMessageFiles,
  requiredGitGlobalConfigKey,
  requiredGitPreferencesInput,
  requiredInstructionsContent,
  requiredLspDocumentInput,
  requiredLspRequestInput,
  requiredTextFileContent,
  requiredTextFileEncoding,
  requiredWorkspaceFolders,
  requiredWorkspaceSearchOptions,
  requiredWorkspaceTextWrites,
} from './ipc-validation';
import { browsableFolderPath } from './folder-explorer';
import {
  commonInstructionsFile,
  legacyCommonInstructionsFile,
  projectInstructionsFile,
} from './instructions-file';
import { MAX_SELECTED_FILE_GRANTS, selectedFileGrantKey } from './selected-file-grants';
import {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  requiredGitRevision,
  requiredRepositoryCwd,
} from './git-contract.mjs';

// Secrets and OAuth flows stay desktop-local even over E2EE, and OAuth logins
// open a browser on the desktop machine where the phone cannot complete them.
export const REMOTE_BLOCKED_CAPABILITIES: ReadonlySet<string> = new Set([
  'saveProviderApiKey',
  'authenticateProvider',
  'saveOpenAIUsageSessionKey',
  'saveOpenCodeGoUsageAuth',
  'loginOAuthProvider',
  'beginOAuthProviderLogin',
  'getOAuthProviderLoginStatus',
  'completeOAuthProviderLogin',
  'cancelOAuthProviderLogin',
  'loginOpenCodeGoUsage',
  'getMcpServerConfig',
  'saveMcpServer',
  // Media files reach a phone through the media HTTP route, which needs no
  // filesystem paths on the client. Keep the resolver host-side.
  'resolveMediaFile',
]);

export function assertRemoteCapability(capability: string): void {
  if (REMOTE_BLOCKED_CAPABILITIES.has(capability)) {
    throw new TypeError(`capability ${capability} is not available over remote access.`);
  }
}

export interface RemoteMethodDependencies {
  host: DesktopService;
  /** Editor backups and scoped editor settings live under the app's userData;
   *  without it those two lanes stay unavailable instead of guessing a path. */
  userDataPath?: string;
  settingsStore?: Pick<DesktopSettingsStore, 'read' | 'update'>;
  /** Fires after a successful desktop-settings write (keep-awake wiring). */
  onDesktopSettingsChanged?: (settings: DesktopSettings) => void;
  /** Web Push registration. Only the relay leg supplies it: a backgrounded web
   *  app has no socket, so this desktop notifies it through the browser's push
   *  service instead. The private half never leaves this machine. */
  push?: {
    publicKey(): Promise<string>;
    register(input: {
      endpoint: string;
      p256dh: string;
      auth: string;
      clientId?: string;
      label?: string;
    }): Promise<unknown>;
    remove(endpoint: string): Promise<boolean>;
  };
  terminals?: {
    ensure(id: string | null, cwd: string | null, profile?: TerminalSpawnProfile | string | null):
      { id: string; replay: string } | Promise<{ id: string; replay: string }>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
  };
  browserRemote?: (method: 'frame' | 'control', args: unknown[]) => Promise<unknown>;
}

export type RemoteMethod = (params: unknown[]) => unknown;

export function createRemoteMethods(
  {
    host,
    userDataPath,
    settingsStore,
    onDesktopSettingsChanged,
    terminals,
    push,
    browserRemote,
  }: RemoteMethodDependencies,
): Record<string, RemoteMethod> {
  const invokeDesktopOperation = (name: string, args: unknown[]): Promise<unknown> =>
    host.invokeDesktopOperation(name, args);
  const operation = (name: string) => (...args: unknown[]) => invokeDesktopOperation(name, args);
  const requiredPush = (): NonNullable<RemoteMethodDependencies['push']> => {
    if (!push) throw new TypeError('Push notifications are unavailable on this connection.');
    return push;
  };
  const requiredBrowserRemote = (): NonNullable<RemoteMethodDependencies['browserRemote']> => {
    if (!browserRemote) throw new TypeError('Remote Browser Use is unavailable.');
    return browserRemote;
  };
  // Selected-file permissions for paths OUTSIDE any registered project. The
  // desktop persists them under userData; a paired browser holds them for the
  // life of this bridge, so a daemon restart simply asks the surface to
  // resolve the path again.
  const fileGrants = new Map<string, string>();
  const rememberFileGrant = (absolutePath: string): string => {
    const token = randomUUID();
    fileGrants.set(selectedFileGrantKey(token), absolutePath);
    while (fileGrants.size > MAX_SELECTED_FILE_GRANTS) {
      const oldest = fileGrants.keys().next().value;
      if (!oldest) break;
      fileGrants.delete(oldest);
    }
    return token;
  };
  const grantedFile = (
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown,
  ): { root: string; rel: string; absolute: string } => {
    const token = requiredString(accessToken, 'file access token', 128);
    const granted = fileGrants.get(selectedFileGrantKey(token));
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
  const grantedIf = (accessToken: unknown): boolean =>
    typeof accessToken === 'string' && accessToken.length > 0;
  /** Absolute file for the editor-backup lane (granted path or project file). */
  const editorFilePath = async (
    projectPath: unknown,
    relPath: unknown,
    accessToken: unknown,
  ): Promise<string> => {
    if (grantedIf(accessToken)) return grantedFile(accessToken, projectPath, relPath).absolute;
    const root = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
    return resolvePath(root, requiredString(relPath, 'relPath', 4_096));
  };
  const requiredEditorBackupRoot = (): string => {
    if (!userDataPath) throw new Error('Editor backup storage is unavailable.');
    return userDataPath;
  };
  const instructionsFilePath = async (projectPath: unknown): Promise<string> => {
    if (projectPath == null || projectPath === '') return commonInstructionsFile();
    const directory = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
    return projectInstructionsFile(directory);
  };
  const requiredFolderPaths = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
      throw new TypeError('paths are invalid.');
    }
    return value.map((path) => browsableFolderPath(path));
  };
  // Remote access is a transport client, not another service. Keep its
  // existing validation grammar while every Git mutation executes in the same
  // daemon operation service as Electron IPC.
  const {
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
    gitStage,
    gitStash,
    gitStashPop,
    gitStatus,
    gitSync,
    gitUndoLastCommit,
    gitUnstage,
  } = Object.fromEntries([
    'gitAbortOperation', 'gitAmend', 'gitApplyPatch', 'gitBranches',
    'gitCheckoutBranch', 'gitCheckoutCommit', 'gitCherryPickCommit', 'gitCommit',
    'gitCommitPaths', 'gitContinue', 'gitCreateBranch', 'gitCreateBranchAtCommit',
    'gitCreateTag', 'gitDeleteBranch', 'gitDeleteTag', 'gitDiff', 'gitFetch',
    'gitIgnore', 'gitLog', 'gitMergeBranch', 'gitPull', 'gitPush',
    'gitRenameBranch', 'gitResetToCommit', 'gitRevertCommit', 'gitRevertFile',
    'gitReview', 'gitReviewDiff', 'gitShow', 'gitShowDiff', 'gitStage',
    'gitStash', 'gitStashPop', 'gitStatus', 'gitSync', 'gitUndoLastCommit',
    'gitUnstage',
  ].map((name) => [name, operation(name)])) as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const methods: Record<string, RemoteMethod> = {
    startProject: ([projectPath]) => host.startProject(requiredString(projectPath, 'projectPath')),
    startProjectTask: ([projectPath]) =>
      host.startProjectTask(requiredString(projectPath, 'projectPath')),
    startTask: () => host.startTask(),
    listProjects: () => host.listProjects(),
    addProject: ([projectPath]) => host.addProject(requiredString(projectPath, 'projectPath')),
    renameProject: ([projectPath, alias]) =>
      host.renameProject(requiredString(projectPath, 'projectPath'), projectDisplayName(alias)),
    removeProject: ([projectPath]) => host.removeProject(requiredString(projectPath, 'projectPath')),
    listProjectDir: ([projectPath, relDir]) => host.listProjectDir(
      requiredString(projectPath, 'projectPath'),
      typeof relDir === 'string' ? relDir : '',
    ),
    readProjectFile: ([projectPath, relPath, accessToken]) => {
      if (grantedIf(accessToken)) {
        const granted = grantedFile(accessToken, projectPath, relPath);
        return invokeDesktopOperation('readProjectTextFileIn', [granted.root, granted.rel]);
      }
      return host.readProjectTextFile(
        requiredString(projectPath, 'projectPath'),
        requiredString(relPath, 'relPath'),
      );
    },
    statProjectFile: ([projectPath, relPath, accessToken]) => {
      if (grantedIf(accessToken)) {
        const granted = grantedFile(accessToken, projectPath, relPath);
        return invokeDesktopOperation('statProjectFileIn', [granted.root, granted.rel]);
      }
      return host.statProjectFile(
        requiredString(projectPath, 'projectPath'),
        requiredString(relPath, 'relPath'),
      );
    },
    // Rasterized pages, never the converted PDF's path: a phone cannot open a
    // file on this machine, and the byte lane that could serve one is disabled
    // until it is encrypted. The operation validates the page window itself.
    previewDocumentPages: async ([projectPath, relPath, accessToken, options]) => {
      const target = grantedIf(accessToken)
        ? grantedFile(accessToken, projectPath, relPath)
        : {
          root: await host.projectDirectory(requiredString(projectPath, 'projectPath')),
          rel: requiredString(relPath, 'relPath', 4_096),
        };
      const request = options && typeof options === 'object'
        ? options as { pages?: unknown; maxWidth?: unknown }
        : {};
      return invokeDesktopOperation('documentPreviewPagesIn', [
        target.root,
        target.rel,
        { pages: request.pages, maxWidth: request.maxWidth },
      ]);
    },
    // Web Push. The browser subscribes with the key this returns and hands the
    // resulting endpoint back over the SAME encrypted channel, so the relay
    // never sees which device wants notifications.
    pushPublicKey: () => requiredPush().publicKey(),
    registerPushSubscription: async ([input]) => {
      const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      await requiredPush().register({
        endpoint: requiredString(record.endpoint, 'endpoint'),
        p256dh: requiredString(record.p256dh, 'p256dh'),
        auth: requiredString(record.auth, 'auth'),
        ...(typeof record.clientId === 'string' ? { clientId: record.clientId } : {}),
        ...(typeof record.label === 'string' ? { label: record.label } : {}),
      });
      return true;
    },
    removePushSubscription: ([endpoint]) =>
      requiredPush().remove(requiredString(endpoint, 'endpoint')),
    listSessions: () => host.listSessions(),
    markSessionRead: ([sessionId, messageCount, consumedUnread]) => {
      if (consumedUnread !== undefined && typeof consumedUnread !== 'boolean') {
        throw new TypeError('consumedUnread must be a boolean.');
      }
      return host.markSessionRead(
        requiredSessionId(sessionId),
        requiredSessionMessageCount(messageCount),
        consumedUnread === true,
      );
    },
    listAgentPool: () => host.listAgentPool(),
    renameSession: ([sessionId, title]) =>
      host.renameSession(requiredSessionId(sessionId), sessionDisplayName(title)),
    setSessionArchived: ([sessionId, archived]) => {
      if (typeof archived !== 'boolean') throw new TypeError('archived must be a boolean.');
      return host.setSessionArchived(requiredSessionId(sessionId), archived);
    },
    deleteSession: ([sessionId]) => host.deleteSession(requiredSessionId(sessionId)),
    // Cold-lane fill for the remote surface: a canonical session.read whose
    // replay frame returns through the broadcast sessionState lane.
    prefetchSession: ([sessionId, itemLimit]) =>
      host.prefetchSession?.(
        requiredSessionId(sessionId),
        requiredTranscriptItemLimit(itemLimit),
      ) ?? false,
    searchProjectFiles: ([projectIdOrWorkspaceId, query, limit]) => {
      if (typeof query !== 'string' || query.length > 1_024) {
        throw new TypeError('query is invalid.');
      }
      return host.searchProjectFiles(
        requiredString(projectIdOrWorkspaceId, 'projectIdOrWorkspaceId'),
        query,
        requiredFileSearchLimit(limit),
      );
    },
    getSnapshot: () => host.getSnapshot(),
    submitNewTask: ([prompt, options, draft]) => host.submitNewTask(
      requiredPromptContent(prompt),
      requiredSubmitOptions(options),
      requiredNewTaskDraft(draft),
    ),
    submitToSession: ([sessionId, prompt, options]) => host.submitToSession(
      requiredSessionId(sessionId),
      requiredPromptContent(prompt),
      requiredSubmitOptions(options),
    ),
    abortSession: ([sessionId, options]) =>
      host.abortSession(requiredSessionId(sessionId), requiredAbortOptions(options)),
    resolveToolApprovalForSession: ([sessionId, id, decision]) =>
      host.resolveToolApprovalForSession(
        requiredSessionId(sessionId),
        requiredString(id, 'approval id', 1_024),
        requiredToolApprovalDecision(decision),
      ),
    inheritSession: ([sourceSessionId, selection]) => host.inheritSession(
      requiredSessionId(sourceSessionId),
      selection == null ? null : requiredModelSelection(selection),
    ),
    listProviderModels: ([options]) => host.listProviderModels(requiredModelCatalogOptions(options)),
    setModelRoute: ([selection, sessionId]) => host.setModelRoute(
      requiredModelSelection(selection),
      sessionId == null ? undefined : requiredSessionId(sessionId),
    ),
    setFast: ([enabled, sessionId]) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return host.setFast(enabled, sessionId == null ? undefined : requiredSessionId(sessionId));
    },
    invokeCapability: ([input]) => {
      const request = requiredDesktopCapabilityRequest(input);
      assertRemoteCapability(request.capability);
      // A phone addresses the same pane session the desktop does. Dropping the
      // id answered every session-scoped read (/context, /inherit) from the
      // blank control session (user: 모바일 /context가 0으로 나온다).
      return host.invokeCapability(request.capability, request.args, request.sessionId);
    },
    readCapabilities: ([input]) => {
      const requests = requiredDesktopCapabilityReadRequests(input);
      for (const request of requests) assertRemoteCapability(request.capability);
      return host.readCapabilities(requests);
    },
    browserRemoteFrame: ([previousFrameId]) => requiredBrowserRemote()(
      'frame',
      [normalizeRemoteBrowserFrameId(previousFrameId)],
    ),
    browserRemoteControl: ([input]) => requiredBrowserRemote()(
      'control',
      [normalizeRemoteBrowserControl(input)],
    ),
    gitStatus: ([cwd, options]) => {
      const record = options && typeof options === 'object'
        ? options as { reuseLineStats?: unknown }
        : {};
      return gitStatus(requiredRepositoryCwd(cwd), {
        reuseLineStats: record.reuseLineStats === true,
      });
    },
    gitBranches: ([cwd]) => gitBranches(requiredRepositoryCwd(cwd)),
    gitCheckoutBranch: ([cwd, branch, remote]) => gitCheckoutBranch(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      remote === true,
    ),
    gitCreateBranch: ([cwd, branch]) =>
      gitCreateBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)),
    gitRenameBranch: ([cwd, branch, nextBranch]) => gitRenameBranch(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      requiredGitBranchName(nextBranch),
    ),
    gitDeleteBranch: ([cwd, branch]) =>
      gitDeleteBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)),
    gitMergeBranch: ([cwd, branch]) =>
      gitMergeBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)),
    gitDiff: ([cwd, path, staged, worktreeOnly, untracked]) =>
      gitDiff(
        requiredRepositoryCwd(cwd),
        requiredGitPath(path),
        staged === true,
        worktreeOnly === true,
        untracked === true,
      ),
    gitApplyPatch: ([cwd, path, patch, reverse]) => {
      if (reverse !== undefined && typeof reverse !== 'boolean') {
        throw new TypeError('git patch direction is invalid.');
      }
      return gitApplyPatch(
        requiredRepositoryCwd(cwd),
        requiredGitPath(path),
        requiredGitPatch(patch),
        reverse === true,
      );
    },
    gitStage: ([cwd, paths]) => gitStage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)),
    gitUnstage: ([cwd, paths]) => gitUnstage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)),
    gitIgnore: ([cwd, path, scope]) => gitIgnore(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      requiredGitIgnoreScope(scope),
    ),
    gitCommit: ([cwd, message]) =>
      gitCommit(requiredRepositoryCwd(cwd), requiredString(message, 'commit message', 20_000)),
    gitCommitPaths: ([cwd, message, paths]) =>
      gitCommitPaths(
        requiredRepositoryCwd(cwd),
        requiredString(message, 'commit message', 20_000),
        requiredGitPaths(paths),
      ),
    gitAmend: ([cwd, message]) =>
      gitAmend(requiredRepositoryCwd(cwd), requiredGitOptionalMessage(message)),
    gitUndoLastCommit: ([cwd]) => gitUndoLastCommit(requiredRepositoryCwd(cwd)),
    gitStash: ([cwd, message]) =>
      gitStash(requiredRepositoryCwd(cwd), requiredGitOptionalMessage(message)),
    gitStashPop: ([cwd]) => gitStashPop(requiredRepositoryCwd(cwd)),
    gitPush: ([cwd]) => gitPush(requiredRepositoryCwd(cwd)),
    gitFetch: ([cwd]) => gitFetch(requiredRepositoryCwd(cwd)),
    gitPull: ([cwd]) => gitPull(requiredRepositoryCwd(cwd)),
    gitSync: ([cwd]) => gitSync(requiredRepositoryCwd(cwd)),
    gitContinue: ([cwd]) => gitContinue(requiredRepositoryCwd(cwd)),
    gitAbortOperation: ([cwd]) => gitAbortOperation(requiredRepositoryCwd(cwd)),
    gitRevert: ([cwd, path, untracked, mode]) => gitRevertFile(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      untracked === true,
      requiredGitDiscardMode(mode),
    ),
    gitLog: ([cwd, query, skip, limit]) => gitLog(
      requiredRepositoryCwd(cwd),
      requiredGitLogQuery(query),
      requiredGitLogOffset(skip),
      requiredGitLogLimit(limit),
    ),
    gitShow: ([cwd, hash]) => gitShow(requiredRepositoryCwd(cwd), requiredCommitHash(hash)),
    gitShowDiff: ([cwd, hash, path]) => gitShowDiff(
      requiredRepositoryCwd(cwd),
      requiredCommitHash(hash),
      requiredGitPath(path),
    ),
    gitResetToCommit: ([cwd, hash, mode, confirmedDirty]) => gitResetToCommit(
      requiredRepositoryCwd(cwd),
      requiredCommitHash(hash),
      requiredGitResetMode(mode),
      confirmedDirty === true,
    ),
    gitRevertCommit: ([cwd, hash]) =>
      gitRevertCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)),
    gitCherryPickCommit: ([cwd, hash]) =>
      gitCherryPickCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)),
    gitCreateTag: ([cwd, tag, hash]) => gitCreateTag(
      requiredRepositoryCwd(cwd),
      requiredString(tag, 'git tag', 512),
      requiredCommitHash(hash),
    ),
    gitDeleteTag: ([cwd, tag]) =>
      gitDeleteTag(requiredRepositoryCwd(cwd), requiredString(tag, 'git tag', 512)),
    gitCheckoutCommit: ([cwd, hash]) =>
      gitCheckoutCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)),
    gitCreateBranchAtCommit: ([cwd, branch, hash]) => gitCreateBranchAtCommit(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      requiredCommitHash(hash),
    ),
    gitReview: ([cwd]) => gitReview(requiredRepositoryCwd(cwd)),
    gitReviewDiff: ([cwd, path, untracked]) => gitReviewDiff(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      untracked === true,
    ),
    gitStashList: ([cwd]) => invokeDesktopOperation('gitStashList', [requiredRepositoryCwd(cwd)]),
    gitStashApply: ([cwd, ref]) => invokeDesktopOperation(
      'gitStashApply',
      [requiredRepositoryCwd(cwd), requiredString(ref, 'stash ref', 64)],
    ),
    gitStashDrop: ([cwd, ref]) => invokeDesktopOperation(
      'gitStashDrop',
      [requiredRepositoryCwd(cwd), requiredString(ref, 'stash ref', 64)],
    ),
    gitShowFile: ([cwd, rev, path]) => invokeDesktopOperation(
      'gitShowFile',
      [requiredRepositoryCwd(cwd), requiredGitRevision(rev), requiredGitPath(path)],
    ),
    gitGenerateCommitMessage: async ([cwd, files]) => {
      const repository = requiredRepositoryCwd(cwd);
      const entries = requiredCommitMessageFiles(files);
      const preferences = await invokeDesktopOperation('readGitPreferences', [])
        .catch(() => null);
      const message = await invokeDesktopOperation(
        'gitGenerateCommitMessage',
        [repository, entries, preferences],
      );
      return { message };
    },
    gitGlobalConfig: () => invokeDesktopOperation('gitGlobalConfig', []),
    setGitGlobalConfig: ([key, value]) => {
      // Empty is a real value here: it UNSETS the key.
      if (typeof value !== 'string' || value.length > 500) {
        throw new TypeError('value must be a string of at most 500 characters.');
      }
      return invokeDesktopOperation('setGitGlobalConfig', [
        requiredGitGlobalConfigKey(key),
        value,
      ]);
    },
    readGitPreferences: () => invokeDesktopOperation('readGitPreferences', []),
    updateGitPreferences: ([preferences]) => invokeDesktopOperation(
      'updateGitPreferences',
      [requiredGitPreferencesInput(preferences)],
    ),
    // Settings → Git/About: gh runs in the daemon, and its login is a DEVICE
    // flow (code + github.com/login/device), so a phone completes it in its
    // own browser exactly like the desktop does.
    githubStarStatus: () => invokeDesktopOperation('githubStarStatus', []),
    starGithub: () => invokeDesktopOperation('starGithub', []),
    githubCliStatus: () => invokeDesktopOperation('githubCliStatus', []),
    installGithubCli: () => invokeDesktopOperation('installGithubCli', []),
    githubCliLoginStart: () => invokeDesktopOperation('githubCliLoginStart', []),
    githubCliLoginStatus: ([flowId]) => invokeDesktopOperation(
      'githubCliLoginStatus',
      [requiredString(flowId, 'flowId', 200)],
    ),
    githubCliLoginCancel: ([flowId]) => invokeDesktopOperation(
      'cancelGithubCliLogin',
      [requiredString(flowId, 'flowId', 200)],
    ),
    githubCliLogout: () => invokeDesktopOperation('githubCliLogout', []),
    githubCliAccount: () => invokeDesktopOperation('githubCliAccount', []),
    // ── Explorer pane: absolute-path local browsing ────────────────────────
    // The daemon owns every filesystem operation here. OS-shell integrations
    // (trash, open-with, reveal, native icons) belong to Electron and stay
    // desktop-only; the remote shim reports them instead of failing silently.
    listFolderDir: ([dir]) => invokeDesktopOperation(
      'listFolderDirAbs',
      [browsableFolderPath(dir)],
    ),
    folderPlaces: () => invokeDesktopOperation('listFolderPlaces', []),
    createFolderEntry: ([dir, name, isDir]) => invokeDesktopOperation(
      'createFolderEntryAbs',
      [browsableFolderPath(dir), requiredString(name, 'name', 255), isDir === true],
    ),
    renameFolderEntry: ([path, newName]) => invokeDesktopOperation(
      'renameFolderEntryAbs',
      [browsableFolderPath(path), requiredString(newName, 'newName', 255)],
    ),
    moveFolderEntry: ([paths, targetDir, strategy]) => {
      const sources = requiredFolderPaths(paths);
      const target = browsableFolderPath(targetDir);
      if (strategy === 'replace') {
        // 'replace' trashes the existing entry first, and the recoverable OS
        // trash is an Electron integration the daemon cannot reach.
        throw new Error('Replacing existing entries is available in the desktop app only.');
      }
      const mode = strategy === 'keepBoth' || strategy === 'skip' ? strategy : 'ask';
      return invokeDesktopOperation('moveFolderEntriesAbs', [sources, target, mode]);
    },
    copyFolderEntry: ([paths, targetDir]) => invokeDesktopOperation(
      'copyFolderEntriesAbs',
      [requiredFolderPaths(paths), browsableFolderPath(targetDir)],
    ),
    folderWatch: ([dir, recursive]) => invokeDesktopOperation(
      'folderWatch',
      [browsableFolderPath(dir), recursive === true],
    ),
    folderUnwatch: ([dir, recursive]) => invokeDesktopOperation(
      'folderUnwatch',
      [browsableFolderPath(dir), recursive === true],
    ),
    // File tabs and attachments for paths outside any project: the same
    // describe-then-grant grammar the desktop uses for a chosen file.
    resolveLocalPaths: async ([paths]) => {
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) {
        throw new TypeError('paths are invalid.');
      }
      const projects = await host.listProjects().catch(() => []);
      const rows: DesktopLocalPathEntry[] = [];
      for (const raw of paths) {
        const entry = await invokeDesktopOperation(
          'statLocalEntryAbs',
          [browsableFolderPath(raw)],
        ) as { absolutePath: string; name: string; dir: boolean; size: number };
        const row: DesktopLocalPathEntry = {
          absolutePath: entry.absolutePath,
          name: entry.name,
          dir: entry.dir,
          size: entry.size,
        };
        if (!row.dir) {
          const normalizedFile = process.platform === 'win32'
            ? entry.absolutePath.toLocaleLowerCase()
            : entry.absolutePath;
          const owner = projects
            .map((project) => ({ project, root: resolvePath(project.path) }))
            .filter(({ root }) => {
              const normalizedRoot = process.platform === 'win32'
                ? root.toLocaleLowerCase()
                : root;
              return normalizedFile.startsWith(normalizedRoot + pathSep)
                || normalizedFile === normalizedRoot;
            })
            .sort((left, right) => right.root.length - left.root.length)[0];
          if (owner) {
            row.projectPath = owner.project.path;
            row.relPath = pathRelative(owner.root, entry.absolutePath).replace(/\\/g, '/');
          } else {
            row.projectPath = pathDirname(entry.absolutePath);
            row.relPath = pathBasename(entry.absolutePath);
            row.accessToken = rememberFileGrant(entry.absolutePath);
          }
        }
        rows.push(row);
      }
      return rows;
    },
    readLocalFile: ([path]) => invokeDesktopOperation(
      'readLocalFileAbs',
      [browsableFolderPath(path)],
    ),
    // ── Project entries and the editor ─────────────────────────────────────
    createProjectEntry: ([projectPath, relDir, name, dir]) => host.createProjectEntry(
      requiredString(projectPath, 'projectPath'),
      typeof relDir === 'string' ? relDir : '',
      requiredString(name, 'name'),
      dir === true,
    ),
    renameProjectEntry: ([projectPath, relPath, newName]) => host.renameProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      requiredString(newName, 'newName'),
    ),
    moveProjectEntry: ([projectPath, relPath, targetDirRel]) => host.moveProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      typeof targetDirRel === 'string' ? targetDirRel : '',
    ),
    copyProjectEntry: ([projectPath, relPath, targetDirRel]) => host.copyProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      typeof targetDirRel === 'string' ? targetDirRel : '',
    ),
    writeProjectFile: ([projectPath, relPath, content, expectedContent, accessToken, encoding]) => {
      const text = requiredTextFileContent(content, 'file content');
      const expected = requiredTextFileContent(expectedContent, 'expected file content');
      const fileEncoding = requiredTextFileEncoding(encoding);
      if (grantedIf(accessToken)) {
        const granted = grantedFile(accessToken, projectPath, relPath);
        return invokeDesktopOperation(
          'writeProjectTextFileIn',
          [granted.root, granted.rel, text, expected, fileEncoding],
        );
      }
      return host.writeProjectTextFile(
        requiredString(projectPath, 'projectPath'),
        requiredString(relPath, 'relPath'),
        text,
        expected,
        fileEncoding,
      );
    },
    readEditorSettings: async ([projectPath, relPath, workspaceFile]) => {
      const root = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
      const workspace = typeof workspaceFile === 'string' && workspaceFile.trim()
        ? resolvePath(workspaceFile)
        : undefined;
      return invokeDesktopOperation('readScopedEditorSettings', [
        userDataPath || '',
        root,
        requiredString(relPath, 'relPath', 4_096),
        workspace,
      ]);
    },
    readEditorBackup: async ([projectPath, relPath, accessToken]) => {
      if (!userDataPath) return null;
      const file = await editorFilePath(projectPath, relPath, accessToken);
      return invokeDesktopOperation('readEditorBackup', [userDataPath, file]);
    },
    writeEditorBackup: async ([projectPath, relPath, content, expectedContent, accessToken]) => {
      const root = requiredEditorBackupRoot();
      const file = await editorFilePath(projectPath, relPath, accessToken);
      return invokeDesktopOperation('writeEditorBackup', [
        root,
        file,
        requiredTextFileContent(content, 'file content'),
        requiredTextFileContent(expectedContent, 'expected file content'),
      ]);
    },
    deleteEditorBackup: async ([projectPath, relPath, accessToken]) => {
      if (!userDataPath) return null;
      const file = await editorFilePath(projectPath, relPath, accessToken);
      await invokeDesktopOperation('deleteEditorBackup', [userDataPath, file]);
      return null;
    },
    readInstructions: async ([projectPath]) => {
      const file = await instructionsFilePath(projectPath);
      const legacy = projectPath == null || projectPath === ''
        ? legacyCommonInstructionsFile()
        : '';
      return invokeDesktopOperation('readInstructions', [file, legacy]);
    },
    writeInstructions: async ([projectPath, content]) => {
      const text = requiredInstructionsContent(content);
      const file = await instructionsFilePath(projectPath);
      await invokeDesktopOperation('writeInstructions', [file, text]);
      return null;
    },
    saveWorkspace: ([workspaceFile, rawFolders]) => {
      const folders = requiredWorkspaceFolders(rawFolders);
      // The Save-As dialog is desktop-only; a remote surface must name the file.
      const file = typeof workspaceFile === 'string' && workspaceFile.trim()
        ? resolvePath(workspaceFile)
        : '';
      if (!file) throw new Error('Choosing a workspace file is available in the desktop app only.');
      return invokeDesktopOperation('writeWorkspaceFile', [file, folders]);
    },
    codeGraphQuery: ([projectPath, mode, symbol]) => {
      if (mode !== 'find_symbol' && mode !== 'references' && mode !== 'symbols') {
        throw new TypeError('mode is invalid.');
      }
      return host.codeGraphQuery(
        requiredString(projectPath, 'projectPath'),
        mode,
        requiredString(symbol, 'symbol'),
      );
    },
    searchWorkspaceText: async ([projectPath, rawOptions]) => {
      const root = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
      return invokeDesktopOperation('searchWorkspaceTextIn', [
        root,
        requiredWorkspaceSearchOptions(rawOptions),
      ]);
    },
    replaceWorkspaceText: async ([projectPath, rawOptions, replacement, relPaths]) => {
      const root = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
      if (typeof replacement !== 'string' || replacement.length > 1_000_000) {
        throw new TypeError('Replacement text is invalid.');
      }
      return invokeDesktopOperation('replaceWorkspaceTextIn', [
        root,
        requiredWorkspaceSearchOptions(rawOptions),
        replacement,
        relPaths === undefined ? undefined : requiredGitPaths(relPaths),
      ]);
    },
    lspDocument: async ([rawInput]) => {
      const input = requiredLspDocumentInput(rawInput);
      const root = await host.projectDirectory(input.projectPath);
      return invokeDesktopOperation('lspDocument', [input.projectPath, root, input]);
    },
    lspRequest: async ([rawInput]) => {
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
    },
    lspApplyWorkspaceEdit: async ([projectPath, rawWrites]) => {
      const root = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
      return invokeDesktopOperation('writeProjectTextFilesIn', [
        root,
        requiredWorkspaceTextWrites(rawWrites),
      ]);
    },
  };
  if (settingsStore) {
    methods.readSettings = () => settingsStore.read();
    methods.updateSetting = ([key, enabled]) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return settingsStore.update(requiredDesktopSettingKey(key), enabled).then((saved) => {
        onDesktopSettingsChanged?.(saved);
        return saved;
      });
    };
  }
  if (terminals) {
    methods.termEnsure = ([id, cwd, shell]) => terminals.ensure(
      typeof id === 'string' && id ? id : null,
      typeof cwd === 'string' && cwd ? cwd : null,
      typeof shell === 'string' && shell ? shell : null,
    );
    methods.termProfiles = () => invokeDesktopOperation('termProfiles', []);
    methods.termWrite = ([id, data]) => {
      terminals.write(String(id || ''), String(data ?? ''));
    };
    methods.termResize = ([id, cols, rows]) => {
      terminals.resize(String(id || ''), Number(cols), Number(rows));
    };
    // Closing a remote terminal pane must release its PTY; without this the
    // browser's dispose call answered "unknown method" and the shell lingered.
    methods.termDispose = ([id]) =>
      invokeDesktopOperation('termDispose', [requiredString(id, 'terminal id', 128)]);
  }
  return methods;
}

export interface RemoteFrameResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  /**
   * The failing error's own `code`, lifted onto the frame because JSON keeps
   * no custom Error property: without it a remote caller only ever sees prose
   * and cannot tell a CONTRACT failure ("this needs the user's confirmation",
   * git-cli.ts `GIT_RESET_DIRTY_CODE`) from a real Git failure. Present only
   * when the error actually carried a string `code`, so its absence still
   * means "no contract to branch on".
   */
  errorCode?: string;
}

// Relay RPC frame executor: parses one wire frame and returns the response
// payload, or undefined when no
// response frame is owed (fire-and-forget lane or an unparseable frame).
export async function executeRemoteFrame(
  methods: Record<string, RemoteMethod>,
  raw: string,
): Promise<RemoteFrameResponse | undefined> {
  let message: { id?: unknown; method?: unknown; params?: unknown };
  try {
    message = JSON.parse(raw) as { id?: unknown; method?: unknown; params?: unknown };
  } catch {
    return undefined;
  }
  const method = typeof message.method === 'string' ? message.method : '';
  const params = Array.isArray(message.params) ? message.params : [];
  const handler = methods[method];
  if (typeof message.id !== 'number') {
    // Fire-and-forget lane (terminal keystrokes/resize): no response frame.
    if (handler && (method === 'termWrite' || method === 'termResize')) {
      try { await handler(params); } catch { /* keystroke lost */ }
    }
    return undefined;
  }
  const id = message.id;
  if (!handler) return { id, ok: false, error: `unknown method: ${method || '(none)'}` };
  try {
    const value = await handler(params);
    return { id, ok: true, value: value === undefined ? null : value };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const response: RemoteFrameResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    if (typeof code === 'string' && code) response.errorCode = code;
    return response;
  }
}
