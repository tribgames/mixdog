// Transport-neutral method table for the remote Relay client: the
// same desktop service surface registerDesktopIpc exposes, minus desktop-only OS
// integrations (dialogs, shell reveal/open, zoom, quit). Validation
// shares transport-neutral validators so the remote surface cannot accept a shape
// the in-process IPC surface would reject.
import { randomUUID } from 'node:crypto';
import {
  basename as pathBasename,
  dirname as pathDirname,
  relative as pathRelative,
  resolve as resolvePath,
} from 'node:path';

import type { DesktopService } from './desktop-service-contract';
import type { DesktopSettingsStore } from './settings-store';
import type { DesktopLocalPathEntry, DesktopSettings } from '../shared/contract';
import { normalizeRemoteBrowserControl } from '../shared/remote-browser';
import { browserParityRemoteMethods, type BrowserRemoteMethod } from './remote-browser-methods';
import { STALE_SESSION_VIEW_MARKER } from '../shared/session-devices';
import { optionalSessionId, requiredSessionId } from './desktop-state';
import { submitFeedback } from './feedback-client';
import { validateGithubRequest } from '../../../../src/runtime/github/contract.mjs';
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
  requiredSessionContentQuery,
  requiredString,
  requiredSubmitOptions,
  requiredSessionMessageCount,
  requiredTranscriptItemLimit,
  requiredToolApprovalDecision,
  sessionDisplayName,
  requiredGitGlobalConfigKey,
  requiredLspDocumentInput,
  requiredLspRequestInput,
  requiredTextFileContent,
  requiredTextFileEncoding,
  requiredWorkspaceFolders,
  requiredWorkspaceSearchOptions,
  requiredWorkspaceTextWrites,
} from './ipc-validation';
import { absoluteLocalPath } from './local-files';
import { createRemoteFilePreviewMethods } from './remote-file-preview';
import { projectEntryPathIn } from './project-files';
import { MAIN_BROWSER_PAGE_PREFIX } from '../shared/contract';
import type { DesktopUpdaterState } from '../shared/contract';
import { MAX_SELECTED_FILE_GRANTS, owningProject, sameGrantedPath, selectedFileGrantKey } from './selected-file-grants';
import {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  requiredGitRevision,
  requiredRepositoryCwd,
} from './git-contract.mjs';

// Pairing approval is the trust: a paired client has the desktop's own
// capabilities. Only host-internal items that make no sense remotely stay
// refused. Media files reach a phone through the media HTTP route, which needs
// no filesystem paths on the client.
export const REMOTE_BLOCKED_CAPABILITIES: ReadonlySet<string> = new Set(['resolveMediaFile']);

export function assertRemoteCapability(capability: string): void {
  if (REMOTE_BLOCKED_CAPABILITIES.has(capability)) {
    throw new TypeError(`capability ${capability} is not available over remote access.`);
  }
}

/** The connection a method table serves. */
export interface RemoteMethodClient {
  /** Name of the paired device behind this connection, read by the host from
   *  the credential the relay authenticated — never from a request field. */
  deviceName?(): Promise<string>;
  /** The paired client (relay credential) behind this connection; '' when the
   *  relay did not name it. Native push registrations are bound to it. */
  credentialId?(): string;
  /** Whether this connection has not yet been shown another device's prompt
   *  in the session. A stale view is re-sent as a side effect. */
  staleView?(sessionId: string, device: string): boolean;
}

export const STALE_SESSION_VIEW_MESSAGE = `${STALE_SESSION_VIEW_MARKER} Review the latest messages, then send again.`;

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
  /** Native app push (APNs/FCM) through the relay. Only the relay leg supplies
   *  it, and `platforms()` is empty until the relay says it can deliver. */
  nativePush?: {
    platforms(): readonly string[];
    register(input: {
      clientId: string;
      platform: unknown;
      token: unknown;
      publicKey: unknown;
      sandbox?: unknown;
    }): Promise<unknown>;
    remove(clientId: string, token?: string): Promise<boolean>;
  };
  terminals?: {
    ensure(
      id: string | null,
      cwd: string | null,
      profile?: TerminalSpawnProfile | string | null
    ): { id: string; replay: string } | Promise<{ id: string; replay: string }>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
  };
  browserRemote?: (method: BrowserRemoteMethod, args: unknown[], timeoutMs?: number) => Promise<unknown>;
  /** Electron-only host actions (OS trash, auto-updater) run in the window
   *  process; the daemon asks it and awaits the answer. */
  hostRequest?: (method: RemoteHostRequestMethod, args: unknown[]) => Promise<unknown>;
}

export type RemoteHostRequestMethod = 'trashItem' | 'updaterState' | 'updaterCheck' | 'updaterInstall';

type RemoteMethod = (params: unknown[]) => unknown;
type InvokeDesktopOperation = (name: string, args: unknown[]) => Promise<unknown>;

/** Permissions this bridge issued for paths outside every registered project. */
interface SelectedFileGrants {
  rememberFileGrant(absolutePath: string): string;
  grantedFile(
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown
  ): { root: string; rel: string; absolute: string };
  grantedIf(accessToken: unknown): boolean;
}

/** Selected-file permissions for paths OUTSIDE any registered project. The
 *  desktop persists them under userData; a paired browser holds them for the
 *  life of this bridge, so a daemon restart simply asks the surface to
 *  resolve the path again. A token names one exact path and nothing else. */
function createSelectedFileGrants(): SelectedFileGrants {
  const fileGrants = new Map<string, string>();
  return {
    rememberFileGrant: (absolutePath: string): string => {
      const token = randomUUID();
      fileGrants.set(selectedFileGrantKey(token), absolutePath);
      while (fileGrants.size > MAX_SELECTED_FILE_GRANTS) {
        const oldest = fileGrants.keys().next().value;
        if (!oldest) break;
        fileGrants.delete(oldest);
      }
      return token;
    },
    grantedFile: (accessToken: unknown, projectPath: unknown, relPath: unknown) => {
      const token = requiredString(accessToken, 'file access token', 128);
      const granted = fileGrants.get(selectedFileGrantKey(token));
      if (!granted) throw new Error('The selected-file permission is unavailable.');
      const requested = resolvePath(requiredString(projectPath, 'projectPath'), requiredString(relPath, 'relPath'));
      if (!sameGrantedPath(granted, requested))
        throw new Error('The selected-file permission does not match this path.');
      return { root: pathDirname(granted), rel: pathBasename(granted), absolute: granted };
    },
    grantedIf: (accessToken: unknown): boolean => typeof accessToken === 'string' && accessToken.length > 0,
  };
}

// Remote access is a transport client, not another service. Keep its
// existing validation grammar while every Git mutation executes in the same
// daemon operation service as Electron IPC.
const GIT_OPERATION_NAMES = [
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
  'gitStage',
  'gitStash',
  'gitStashPop',
  'gitStatus',
  'gitSync',
  'gitUndoLastCommit',
  'gitUnstage',
] as const;

type GitOperations = Record<(typeof GIT_OPERATION_NAMES)[number], (...args: unknown[]) => Promise<unknown>>;

function gitDesktopOperations(invokeDesktopOperation: InvokeDesktopOperation): GitOperations {
  return Object.fromEntries(
    GIT_OPERATION_NAMES.map((name) => [name, (...args: unknown[]) => invokeDesktopOperation(name, args)])
  ) as GitOperations;
}

/** The working tree and the index: what is changed, staged, committed, or
 *  shelved in this checkout. */
function gitWorkingTreeRemoteMethods(
  git: GitOperations,
  invokeDesktopOperation: InvokeDesktopOperation
): Record<string, RemoteMethod> {
  return {
    gitStatus: ([cwd, options]) => {
      const record =
        options && typeof options === 'object'
          ? (options as { reuseLineStats?: unknown; skipLineStats?: unknown })
          : {};
      return git.gitStatus(requiredRepositoryCwd(cwd), {
        reuseLineStats: record.reuseLineStats === true,
        skipLineStats: record.skipLineStats === true,
      });
    },
    gitDiff: ([cwd, path, staged, worktreeOnly, untracked]) =>
      git.gitDiff(
        requiredRepositoryCwd(cwd),
        requiredGitPath(path),
        staged === true,
        worktreeOnly === true,
        untracked === true
      ),
    gitApplyPatch: ([cwd, path, patch, reverse]) => {
      if (reverse !== undefined && typeof reverse !== 'boolean') {
        throw new TypeError('git patch direction is invalid.');
      }
      return git.gitApplyPatch(
        requiredRepositoryCwd(cwd),
        requiredGitPath(path),
        requiredGitPatch(patch),
        reverse === true
      );
    },
    gitStage: ([cwd, paths]) => git.gitStage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)),
    gitUnstage: ([cwd, paths]) => git.gitUnstage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)),
    gitIgnore: ([cwd, path, scope]) =>
      git.gitIgnore(requiredRepositoryCwd(cwd), requiredGitPath(path), requiredGitIgnoreScope(scope)),
    gitCommit: ([cwd, message]) =>
      git.gitCommit(requiredRepositoryCwd(cwd), requiredString(message, 'commit message', 20_000)),
    gitCommitPaths: ([cwd, message, paths]) =>
      git.gitCommitPaths(
        requiredRepositoryCwd(cwd),
        requiredString(message, 'commit message', 20_000),
        requiredGitPaths(paths)
      ),
    gitAmend: ([cwd, message]) => git.gitAmend(requiredRepositoryCwd(cwd), requiredGitOptionalMessage(message)),
    gitUndoLastCommit: ([cwd]) => git.gitUndoLastCommit(requiredRepositoryCwd(cwd)),
    gitRevert: ([cwd, path, untracked, mode]) =>
      git.gitRevertFile(
        requiredRepositoryCwd(cwd),
        requiredGitPath(path),
        untracked === true,
        requiredGitDiscardMode(mode)
      ),
    gitReview: ([cwd]) => git.gitReview(requiredRepositoryCwd(cwd)),
    gitReviewDiff: ([cwd, path, untracked]) =>
      git.gitReviewDiff(requiredRepositoryCwd(cwd), requiredGitPath(path), untracked === true),
    gitStash: ([cwd, message]) => git.gitStash(requiredRepositoryCwd(cwd), requiredGitOptionalMessage(message)),
    gitStashPop: ([cwd]) => git.gitStashPop(requiredRepositoryCwd(cwd)),
    gitStashList: ([cwd]) => invokeDesktopOperation('gitStashList', [requiredRepositoryCwd(cwd)]),
    gitStashApply: ([cwd, ref]) =>
      invokeDesktopOperation('gitStashApply', [requiredRepositoryCwd(cwd), requiredString(ref, 'stash ref', 64)]),
    gitStashDrop: ([cwd, ref]) =>
      invokeDesktopOperation('gitStashDrop', [requiredRepositoryCwd(cwd), requiredString(ref, 'stash ref', 64)]),
  };
}

/** Named refs and the remote: branches, tags, and the sync operations that
 *  can leave a merge or rebase in progress. */
function gitBranchRemoteMethods(git: GitOperations): Record<string, RemoteMethod> {
  return {
    gitBranches: ([cwd]) => git.gitBranches(requiredRepositoryCwd(cwd)),
    gitCheckoutBranch: ([cwd, branch, remote]) =>
      git.gitCheckoutBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch), remote === true),
    gitCreateBranch: ([cwd, branch]) => git.gitCreateBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)),
    gitRenameBranch: ([cwd, branch, nextBranch]) =>
      git.gitRenameBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch), requiredGitBranchName(nextBranch)),
    gitDeleteBranch: ([cwd, branch]) => git.gitDeleteBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)),
    gitMergeBranch: ([cwd, branch]) => git.gitMergeBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)),
    gitCreateTag: ([cwd, tag, hash]) =>
      git.gitCreateTag(requiredRepositoryCwd(cwd), requiredString(tag, 'git tag', 512), requiredCommitHash(hash)),
    gitDeleteTag: ([cwd, tag]) => git.gitDeleteTag(requiredRepositoryCwd(cwd), requiredString(tag, 'git tag', 512)),
    gitPush: ([cwd]) => git.gitPush(requiredRepositoryCwd(cwd)),
    gitFetch: ([cwd]) => git.gitFetch(requiredRepositoryCwd(cwd)),
    gitPull: ([cwd]) => git.gitPull(requiredRepositoryCwd(cwd)),
    gitSync: ([cwd]) => git.gitSync(requiredRepositoryCwd(cwd)),
    gitContinue: ([cwd]) => git.gitContinue(requiredRepositoryCwd(cwd)),
    gitAbortOperation: ([cwd]) => git.gitAbortOperation(requiredRepositoryCwd(cwd)),
  };
}

/** Commit-addressed reads and moves, plus the global identity Settings edits. */
function gitHistoryRemoteMethods(
  git: GitOperations,
  invokeDesktopOperation: InvokeDesktopOperation
): Record<string, RemoteMethod> {
  return {
    gitLog: ([cwd, query, skip, limit]) =>
      git.gitLog(
        requiredRepositoryCwd(cwd),
        requiredGitLogQuery(query),
        requiredGitLogOffset(skip),
        requiredGitLogLimit(limit)
      ),
    gitShow: ([cwd, hash]) => git.gitShow(requiredRepositoryCwd(cwd), requiredCommitHash(hash)),
    gitShowDiff: ([cwd, hash, path]) =>
      git.gitShowDiff(requiredRepositoryCwd(cwd), requiredCommitHash(hash), requiredGitPath(path)),
    gitShowFile: ([cwd, rev, path]) =>
      invokeDesktopOperation('gitShowFile', [
        requiredRepositoryCwd(cwd),
        requiredGitRevision(rev),
        requiredGitPath(path),
      ]),
    gitResetToCommit: ([cwd, hash, mode, confirmedDirty]) =>
      git.gitResetToCommit(
        requiredRepositoryCwd(cwd),
        requiredCommitHash(hash),
        requiredGitResetMode(mode),
        confirmedDirty === true
      ),
    gitRevertCommit: ([cwd, hash]) => git.gitRevertCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)),
    gitCherryPickCommit: ([cwd, hash]) => git.gitCherryPickCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)),
    gitCheckoutCommit: ([cwd, hash]) => git.gitCheckoutCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)),
    gitCreateBranchAtCommit: ([cwd, branch, hash]) =>
      git.gitCreateBranchAtCommit(requiredRepositoryCwd(cwd), requiredGitBranchName(branch), requiredCommitHash(hash)),
    gitGlobalConfig: () => invokeDesktopOperation('gitGlobalConfig', []),
    setGitGlobalConfig: ([key, value]) => {
      // Empty is a real value here: it UNSETS the key.
      if (typeof value !== 'string' || value.length > 500) {
        throw new TypeError('value must be a string of at most 500 characters.');
      }
      return invokeDesktopOperation('setGitGlobalConfig', [requiredGitGlobalConfigKey(key), value]).then(
        async (saved) => {
          await invokeDesktopOperation('notifySettingsChanged', ['git']).catch(() => {});
          return saved;
        }
      );
    },
  };
}

function gitRemoteMethods(invokeDesktopOperation: InvokeDesktopOperation): Record<string, RemoteMethod> {
  const git = gitDesktopOperations(invokeDesktopOperation);
  return {
    ...gitWorkingTreeRemoteMethods(git, invokeDesktopOperation),
    ...gitBranchRemoteMethods(git),
    ...gitHistoryRemoteMethods(git, invokeDesktopOperation),
  };
}

// Settings → Git/About: gh runs in the daemon, and its login is a DEVICE
// flow (code + github.com/login/device), so a phone completes it in its
// own browser exactly like the desktop does.
function developerToolingRemoteMethods(invokeDesktopOperation: InvokeDesktopOperation): Record<string, RemoteMethod> {
  return {
    githubStarStatus: () => invokeDesktopOperation('githubStarStatus', []),
    starGithub: () => invokeDesktopOperation('starGithub', []),
    gitCliStatus: () => invokeDesktopOperation('gitCliStatus', []),
    installGitCli: () => invokeDesktopOperation('installGitCli', []),
    libreOfficeStatus: () => invokeDesktopOperation('libreOfficeStatus', []),
    installLibreOffice: () => invokeDesktopOperation('installLibreOffice', []),
    githubCliStatus: () => invokeDesktopOperation('githubCliStatus', []),
    githubRequest: ([cwd, input]) =>
      invokeDesktopOperation('githubRequest', [requiredRepositoryCwd(cwd), validateGithubRequest(input)]),
    installGithubCli: () => invokeDesktopOperation('installGithubCli', []),
    githubCliLoginStart: () => invokeDesktopOperation('githubCliLoginStart', []),
    githubCliLoginStatus: ([flowId]) =>
      invokeDesktopOperation('githubCliLoginStatus', [requiredString(flowId, 'flowId', 200)]),
    githubCliLoginOpenBrowser: ([flowId]) =>
      invokeDesktopOperation('githubCliLoginOpenBrowser', [requiredString(flowId, 'flowId', 200)]),
    githubCliLoginCancel: ([flowId]) =>
      invokeDesktopOperation('cancelGithubCliLogin', [requiredString(flowId, 'flowId', 200)]),
    githubCliLogout: () => invokeDesktopOperation('githubCliLogout', []),
    githubCliAccount: () => invokeDesktopOperation('githubCliAccount', []),
    ghPrList: ([cwd]) => invokeDesktopOperation('ghPrList', [requiredRepositoryCwd(cwd)]),
    ghPrDefaultBranch: ([cwd]) => invokeDesktopOperation('ghPrDefaultBranch', [requiredRepositoryCwd(cwd)]),
    ghPrCreate: ([cwd, input]) => invokeDesktopOperation('ghPrCreate', [requiredRepositoryCwd(cwd), input]),
    ghPrView: ([cwd, number]) => invokeDesktopOperation('ghPrView', [requiredRepositoryCwd(cwd), number]),
    ghPrCheckout: ([cwd, number]) => invokeDesktopOperation('ghPrCheckout', [requiredRepositoryCwd(cwd), number]),
    ghPrMerge: ([cwd, number, method]) =>
      invokeDesktopOperation('ghPrMerge', [requiredRepositoryCwd(cwd), number, method]),
    ghPrDiff: ([cwd, number]) => invokeDesktopOperation('ghPrDiff', [requiredRepositoryCwd(cwd), number]),
  };
}

/** Absolute paths as the file surface describes them: owned by the deepest
 *  registered project that contains them, otherwise named by a one-off grant
 *  this bridge can resolve on the calls that follow. */
async function resolveLocalPathEntries(
  paths: unknown,
  deps: { host: DesktopService; invokeDesktopOperation: InvokeDesktopOperation; grants: SelectedFileGrants }
): Promise<DesktopLocalPathEntry[]> {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) {
    throw new TypeError('paths are invalid.');
  }
  const projects = await deps.host.listProjects().catch(() => []);
  const rows: DesktopLocalPathEntry[] = [];
  for (const raw of paths) {
    const entry = (await deps.invokeDesktopOperation('statLocalEntryAbs', [absoluteLocalPath(raw)])) as {
      absolutePath: string;
      name: string;
      dir: boolean;
      size: number;
    };
    const row: DesktopLocalPathEntry = {
      absolutePath: entry.absolutePath,
      name: entry.name,
      dir: entry.dir,
      size: entry.size,
    };
    if (!row.dir) {
      const owner = owningProject(projects, entry.absolutePath);
      if (owner) {
        row.projectPath = owner.project.path;
        row.relPath = pathRelative(owner.root, entry.absolutePath).replace(/\\/g, '/');
      } else {
        row.projectPath = pathDirname(entry.absolutePath);
        row.relPath = pathBasename(entry.absolutePath);
        row.accessToken = deps.grants.rememberFileGrant(entry.absolutePath);
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Entries inside a project, addressed the way the explorer addresses them. */
function projectEntryRemoteMethods(
  host: DesktopService,
  hostRequest: NonNullable<RemoteMethodDependencies['hostRequest']>
): Record<string, RemoteMethod> {
  return {
    trashProjectEntry: async ([projectPath, relPath]) => {
      const target = await host.projectEntryPath(
        requiredString(projectPath, 'projectPath'),
        requiredString(relPath, 'relPath')
      );
      await hostRequest('trashItem', [target]);
    },
    createProjectEntry: ([projectPath, relDir, name, dir]) =>
      host.createProjectEntry(
        requiredString(projectPath, 'projectPath'),
        typeof relDir === 'string' ? relDir : '',
        requiredString(name, 'name'),
        dir === true
      ),
    renameProjectEntry: ([projectPath, relPath, newName]) =>
      host.renameProjectEntry(
        requiredString(projectPath, 'projectPath'),
        requiredString(relPath, 'relPath'),
        requiredString(newName, 'newName')
      ),
    moveProjectEntry: ([projectPath, relPath, targetDirRel]) =>
      host.moveProjectEntry(
        requiredString(projectPath, 'projectPath'),
        requiredString(relPath, 'relPath'),
        typeof targetDirRel === 'string' ? targetDirRel : ''
      ),
    copyProjectEntry: ([projectPath, relPath, targetDirRel]) =>
      host.copyProjectEntry(
        requiredString(projectPath, 'projectPath'),
        requiredString(relPath, 'relPath'),
        typeof targetDirRel === 'string' ? targetDirRel : ''
      ),
  };
}

/** The editor's own lanes: writes, scoped settings, crash backups,
 *  workspace search and the language servers. Everything here
 *  resolves a project-relative path first — through a selected-file grant when
 *  the surface holds one, otherwise through the project directory. */
function editorRemoteMethods(deps: {
  host: DesktopService;
  userDataPath: string | undefined;
  invokeDesktopOperation: InvokeDesktopOperation;
  grants: SelectedFileGrants;
}): Record<string, RemoteMethod> {
  const { host, userDataPath, invokeDesktopOperation, grants } = deps;
  /** Absolute file for the editor-backup lane (granted path or project file). */
  const editorFilePath = async (projectPath: unknown, relPath: unknown, accessToken: unknown): Promise<string> => {
    if (grants.grantedIf(accessToken)) return grants.grantedFile(accessToken, projectPath, relPath).absolute;
    const root = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
    return projectEntryPathIn(root, requiredString(relPath, 'relPath', 4_096));
  };
  const requiredEditorBackupRoot = (): string => {
    if (!userDataPath) throw new Error('Editor backup storage is unavailable.');
    return userDataPath;
  };
  return {
    writeProjectFile: ([projectPath, relPath, content, expectedContent, accessToken, encoding]) => {
      const text = requiredTextFileContent(content, 'file content');
      const expected = requiredTextFileContent(expectedContent, 'expected file content');
      const fileEncoding = requiredTextFileEncoding(encoding);
      if (grants.grantedIf(accessToken)) {
        const granted = grants.grantedFile(accessToken, projectPath, relPath);
        return invokeDesktopOperation('writeProjectTextFileIn', [
          granted.root,
          granted.rel,
          text,
          expected,
          fileEncoding,
        ]);
      }
      return host.writeProjectTextFile(
        requiredString(projectPath, 'projectPath'),
        requiredString(relPath, 'relPath'),
        text,
        expected,
        fileEncoding
      );
    },
    readEditorSettings: async ([projectPath, relPath, workspaceFile]) => {
      const root = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
      const workspace =
        typeof workspaceFile === 'string' && workspaceFile.trim() ? resolvePath(workspaceFile) : undefined;
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
    saveWorkspace: ([workspaceFile, rawFolders]) => {
      const folders = requiredWorkspaceFolders(rawFolders);
      // The Save-As dialog is desktop-only; a remote surface must name the file.
      const file = typeof workspaceFile === 'string' && workspaceFile.trim() ? resolvePath(workspaceFile) : '';
      if (!file) throw new Error('Choosing a workspace file is available in the desktop app only.');
      return invokeDesktopOperation('writeWorkspaceFile', [file, folders]);
    },
    codeGraphQuery: ([projectPath, mode, symbol]) => {
      if (mode !== 'find_symbol' && mode !== 'references' && mode !== 'symbols') {
        throw new TypeError('mode is invalid.');
      }
      return host.codeGraphQuery(requiredString(projectPath, 'projectPath'), mode, requiredString(symbol, 'symbol'));
    },
    searchWorkspaceText: async ([projectPath, rawOptions]) => {
      const root = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
      return invokeDesktopOperation('searchWorkspaceTextIn', [root, requiredWorkspaceSearchOptions(rawOptions)]);
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
      return invokeDesktopOperation('writeProjectTextFilesIn', [root, requiredWorkspaceTextWrites(rawWrites)]);
    },
  };
}

export function createRemoteMethods(
  {
    host,
    userDataPath,
    settingsStore,
    onDesktopSettingsChanged,
    terminals,
    push,
    nativePush,
    browserRemote,
    hostRequest,
  }: RemoteMethodDependencies,
  client?: RemoteMethodClient
): Record<string, RemoteMethod> {
  const connectionDevice = async (): Promise<string> => (await client?.deviceName?.()) || 'Web app';
  const invokeDesktopOperation = (name: string, args: unknown[]): Promise<unknown> =>
    host.invokeDesktopOperation(name, args);
  const requiredNativePush = (): NonNullable<RemoteMethodDependencies['nativePush']> => {
    if (!nativePush || nativePush.platforms().length === 0) {
      throw new TypeError('Native push is unavailable on this connection.');
    }
    return nativePush;
  };
  const connectionClientId = (): string => {
    const id = client?.credentialId?.() ?? '';
    if (!id) throw new TypeError('Native push needs a paired client.');
    return id;
  };
  const requiredPush = ():NonNullable<RemoteMethodDependencies['push']> => {
    if (!push) throw new TypeError('Push notifications are unavailable on this connection.');
    return push;
  };
  const requiredBrowserRemote = (): NonNullable<RemoteMethodDependencies['browserRemote']> => {
    if (!browserRemote) throw new TypeError('Remote Browser Use is unavailable.');
    return browserRemote;
  };
  const requiredHostRequest = (): NonNullable<RemoteMethodDependencies['hostRequest']> => {
    if (!hostRequest) throw new TypeError('The desktop app is unavailable on this connection.');
    return hostRequest;
  };
  const grants = createSelectedFileGrants();
  const { grantedFile, grantedIf } = grants;
  const methods: Record<string, RemoteMethod> = {
    submitFeedback: ([input]) => submitFeedback(input),
    readActivityRailPins: () => invokeDesktopOperation('readActivityRailPins', []),
    // A web client writes normally; it never initializes from its local cache.
    updateActivityRailPins: ([pins]) => invokeDesktopOperation('updateActivityRailPins', [pins]),
    notifyProviderModelsChanged: ([origin]) =>
      invokeDesktopOperation('notifyProviderModelsChanged', [requiredString(origin, 'origin', 128)]),
    startProject: ([projectPath]) => host.startProject(requiredString(projectPath, 'projectPath')),
    startProjectTask: ([projectPath]) => host.startProjectTask(requiredString(projectPath, 'projectPath')),
    startTask: () => host.startTask(),
    listProjects: () => host.listProjects(),
    addProject: ([projectPath]) => host.addProject(requiredString(projectPath, 'projectPath')),
    renameProject: ([projectPath, alias]) =>
      host.renameProject(requiredString(projectPath, 'projectPath'), projectDisplayName(alias)),
    removeProject: ([projectPath]) => host.removeProject(requiredString(projectPath, 'projectPath')),
    listProjectDir: ([projectPath, relDir]) =>
      host.listProjectDir(requiredString(projectPath, 'projectPath'), typeof relDir === 'string' ? relDir : ''),
    readProjectFile: ([projectPath, relPath, accessToken]) => {
      if (grantedIf(accessToken)) {
        const granted = grantedFile(accessToken, projectPath, relPath);
        return invokeDesktopOperation('readProjectTextFileIn', [granted.root, granted.rel]);
      }
      return host.readProjectTextFile(requiredString(projectPath, 'projectPath'), requiredString(relPath, 'relPath'));
    },
    statProjectFile: ([projectPath, relPath, accessToken]) => {
      if (grantedIf(accessToken)) {
        const granted = grantedFile(accessToken, projectPath, relPath);
        return invokeDesktopOperation('statProjectFileIn', [granted.root, granted.rel]);
      }
      return host.statProjectFile(requiredString(projectPath, 'projectPath'), requiredString(relPath, 'relPath'));
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
      const request =
        options && typeof options === 'object' ? (options as { pages?: unknown; maxWidth?: unknown }) : {};
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
    removePushSubscription: ([endpoint]) => requiredPush().remove(requiredString(endpoint, 'endpoint')),
    // Native app push. `{ platform, token, publicKey }` arrives over the
    // encrypted channel and is bound to the paired client behind it; the
    // content of every later push is encrypted for `publicKey`.
    registerNativePush: async ([input]) => {
      const native = requiredNativePush();
      const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      if (typeof record.platform !== 'string' || !native.platforms().includes(record.platform)) {
        throw new TypeError('Native push is unavailable for this platform.');
      }
      await native.register({
        clientId: connectionClientId(),
        platform: record.platform,
        token: record.token,
        publicKey: record.publicKey,
        sandbox: record.sandbox,
      });
      return true;
    },
    removeNativePush: ([token]) => {
      if (token !== undefined && typeof token !== 'string') throw new TypeError('token must be a string.');
      return requiredNativePush().remove(connectionClientId(), token);
    },
    listSessions: () => host.listSessions(),
    markSessionRead: ([sessionId, messageCount, consumedUnread]) => {
      if (consumedUnread !== undefined && typeof consumedUnread !== 'boolean') {
        throw new TypeError('consumedUnread must be a boolean.');
      }
      return host.markSessionRead(
        requiredSessionId(sessionId),
        requiredSessionMessageCount(messageCount),
        consumedUnread === true
      );
    },
    listAgentPool: () => host.listAgentPool(),
    searchSessionContent: ([query]) => host.searchSessionContent(requiredSessionContentQuery(query)),
    renameSession: ([sessionId, title]) => host.renameSession(requiredSessionId(sessionId), sessionDisplayName(title)),
    setSessionArchived: ([sessionId, archived]) => {
      if (typeof archived !== 'boolean') throw new TypeError('archived must be a boolean.');
      return host.setSessionArchived(requiredSessionId(sessionId), archived);
    },
    setSessionFavorite: ([sessionId, favorite]) => {
      if (typeof favorite !== 'boolean') throw new TypeError('favorite must be a boolean.');
      return host.setSessionFavorite(requiredSessionId(sessionId), favorite);
    },
    deleteSession: async ([sessionId]) => {
      const ownerSessionId = requiredSessionId(sessionId);
      const snapshot = await host.deleteSession(ownerSessionId);
      // Session deletion remains authoritative when Browser Use is unavailable.
      if (browserRemote) await browserRemote('release', [ownerSessionId]).catch(() => undefined);
      return snapshot;
    },
    // Cold-lane fill for the remote surface: a canonical session.read whose
    // replay frame returns through the broadcast sessionState lane.
    prefetchSession: ([sessionId, itemLimit, readTraceId]) =>
      host.prefetchSession?.(
        requiredSessionId(sessionId),
        requiredTranscriptItemLimit(itemLimit),
        typeof readTraceId === 'string' && readTraceId ? readTraceId : undefined
      ) ?? false,
    searchProjectFiles: ([projectIdOrWorkspaceId, query, limit, includeIgnored]) => {
      if (typeof query !== 'string' || query.length > 1_024) {
        throw new TypeError('query is invalid.');
      }
      return host.searchProjectFiles(
        requiredString(projectIdOrWorkspaceId, 'projectIdOrWorkspaceId'),
        query,
        requiredFileSearchLimit(limit),
        includeIgnored === true
      );
    },
    getSnapshot: () => host.getSnapshot(),
    submitNewTask: async ([prompt, options, draft]) =>
      host.submitNewTask(
        requiredPromptContent(prompt),
        { ...requiredSubmitOptions(options), device: await connectionDevice() },
        requiredNewTaskDraft(draft)
      ),
    submitToSession: async ([sessionId, prompt, options]) => {
      const id = requiredSessionId(sessionId);
      const content = requiredPromptContent(prompt);
      const submitOptions = requiredSubmitOptions(options);
      const device = await connectionDevice();
      if (client?.staleView?.(id, device)) throw new Error(STALE_SESSION_VIEW_MESSAGE);
      return host.submitToSession(id, content, { ...submitOptions, device });
    },
    abortSession: async ([sessionId, options]) =>
      host.abortSession(requiredSessionId(sessionId), {
        ...requiredAbortOptions(options),
        device: await connectionDevice(),
      }),
    resolveToolApprovalForSession: async ([sessionId, id, decision]) =>
      host.resolveToolApprovalForSession(requiredSessionId(sessionId), requiredString(id, 'approval id', 1_024), {
        ...requiredToolApprovalDecision(decision),
        device: await connectionDevice(),
      }),
    inheritSession: ([sourceSessionId, selection, options]) =>
      host.inheritSession(
        requiredSessionId(sourceSessionId),
        selection == null ? null : requiredModelSelection(selection),
        { compact: (options as { compact?: unknown } | null | undefined)?.compact === true }
      ),
    listProviderModels: ([options]) => host.listProviderModels(requiredModelCatalogOptions(options)),
    setModelRoute: ([selection, sessionId]) =>
      host.setModelRoute(
        requiredModelSelection(selection),
        optionalSessionId(sessionId)
      ),
    setFast: ([enabled, sessionId]) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return host.setFast(enabled, optionalSessionId(sessionId));
    },
    invokeCapability: ([input]) => {
      const request = requiredDesktopCapabilityRequest(input);
      assertRemoteCapability(request.capability);
      // A phone addresses the same pane session the desktop does. Dropping the
      // id answered every session-scoped read (/context, /inherit) from the
      // blank control session (user: 모바일 /context가 0으로 나온다).
      const result = host.invokeCapability(request.capability, request.args, request.sessionId);
      // The daemon answers a session-addressed call with that session's whole
      // snapshot (transcript included). The turn review bar reads the value
      // only and the phone mirrors the session on its own lane, so each
      // re-read crossed the relay carrying the entire conversation.
      if (request.capability !== 'getTurnReviewDiff') return result;
      return result.then(({ value }) => ({ value }));
    },
    readCapabilities: ([input]) => {
      const requests = requiredDesktopCapabilityReadRequests(input);
      for (const request of requests) assertRemoteCapability(request.capability);
      return host.readCapabilities(requests);
    },
    browserRemoteControl: ([sessionId, input]) =>
      requiredBrowserRemote()('control', [requiredSessionId(sessionId), normalizeRemoteBrowserControl(input)]),
    ...browserParityRemoteMethods(browserRemote),
    ...gitRemoteMethods(invokeDesktopOperation),
    ...developerToolingRemoteMethods(invokeDesktopOperation),
    folderWatch: ([dir, recursive]) =>
      invokeDesktopOperation('folderWatch', [absoluteLocalPath(dir), recursive === true]),
    folderUnwatch: ([dir, recursive]) =>
      invokeDesktopOperation('folderUnwatch', [absoluteLocalPath(dir), recursive === true]),
    // File tabs and attachments for paths outside any project: the same
    // describe-then-grant grammar the desktop uses for a chosen file.
    resolveLocalPaths: ([paths]) => resolveLocalPathEntries(paths, { host, invokeDesktopOperation, grants }),
    readLocalFile: ([path]) => invokeDesktopOperation('readLocalFileAbs', [absoluteLocalPath(path)]),
    // ── Project entries and the editor ─────────────────────────────────────
    ...projectEntryRemoteMethods(host, (method, args) => requiredHostRequest()(method, args)),
    // Host updater: the window process owns it; these mirror the desktop
    // getUpdaterState / checkForDesktopUpdate / showDesktopUpdate calls.
    getUpdaterState: () => requiredHostRequest()('updaterState', []) as Promise<DesktopUpdaterState>,
    checkForDesktopUpdate: () => requiredHostRequest()('updaterCheck', []) as Promise<DesktopUpdaterState>,
    showDesktopUpdate: () => requiredHostRequest()('updaterInstall', []) as Promise<DesktopUpdaterState>,
    // Only main-workspace browser tabs are the client's to release.
    browserReleasePage: async ([pageId]) => {
      if (!browserRemote) return;
      const id = requiredSessionId(pageId);
      if (!id.startsWith(MAIN_BROWSER_PAGE_PREFIX)) throw new TypeError('Browser page is not a main tab page.');
      await browserRemote('release', [id]);
    },
    ...editorRemoteMethods({ host, userDataPath, invokeDesktopOperation, grants }),
    ...createRemoteFilePreviewMethods({ host, grants }),
  };
  if (settingsStore) {
    methods.readSettings = () => settingsStore.read();
    methods.updateSetting = ([key, enabled]) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return settingsStore.update(requiredDesktopSettingKey(key), enabled).then(async (saved) => {
        onDesktopSettingsChanged?.(saved);
        // Open settings pages on the host and on other clients re-read it.
        await invokeDesktopOperation('notifySettingsChanged', ['desktop']).catch(() => {});
        return saved;
      });
    };
  }
  if (terminals) {
    methods.termEnsure = ([id, cwd, shell]) =>
      terminals.ensure(
        typeof id === 'string' && id ? id : null,
        typeof cwd === 'string' && cwd ? cwd : null,
        typeof shell === 'string' && shell ? shell : null
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
    methods.termDispose = ([id]) => invokeDesktopOperation('termDispose', [requiredString(id, 'terminal id', 128)]);
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

const MIN_REDACTED_SECRET_LENGTH = 6;
const REDACTED = '[redacted]';

/** Capabilities whose arguments carry secrets (API keys, session keys, auth
 *  codes, pasted redirect URLs). */
const SECRET_CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  'saveProviderApiKey',
  'saveOpenAIUsageSessionKey',
  'saveOpenCodeGoUsageAuth',
  'saveCustomProvider',
  'removeCustomProvider',
  'testCustomProvider',
  'discoverCustomProviderModels',
  'getMcpServerConfig',
  'saveMcpServer',
  'setDeveloperOption',
  'forgetProviderAuth',
  'beginOAuthProviderLogin',
  'getOAuthProviderLoginStatus',
  'completeOAuthProviderLogin',
  'cancelOAuthProviderLogin',
  'loginOAuthProvider',
  'authenticateProvider',
]);

/** Every string a secret-bearing capability call carried. An upstream failure
 *  can echo one back inside its message, which would reach the client's logs
 *  and every relay-side frame trace. */
function secretStringsOf(method: string, params: unknown[]): string[] {
  if (method !== 'invokeCapability') return [];
  const request = params[0] as { capability?: unknown; args?: unknown } | null;
  if (typeof request?.capability !== 'string' || !SECRET_CAPABILITY_NAMES.has(request.capability)) return [];
  const found: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      if (value.length >= MIN_REDACTED_SECRET_LENGTH) found.push(value);
    } else if (depth < 6 && value && typeof value === 'object') {
      for (const entry of Object.values(value)) visit(entry, depth + 1);
    }
  };
  visit(request.args, 0);
  return found;
}

/** An error message with any secret from the failing call removed. */
export function redactRemoteError(message: string, method: string, params: unknown[]): string {
  let safe = message;
  for (const secret of secretStringsOf(method, params)) safe = safe.split(secret).join(REDACTED);
  return safe;
}

// Relay RPC frame executor: parses one wire frame and returns the response
// payload, or undefined when no
// response frame is owed (fire-and-forget lane or an unparseable frame).
export async function executeRemoteFrame(
  methods: Record<string, RemoteMethod>,
  raw: string
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
      try {
        await handler(params);
      } catch {
        /* keystroke lost */
      }
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
      error: redactRemoteError(error instanceof Error ? error.message : String(error), method, params),
    };
    if (typeof code === 'string' && code) response.errorCode = code;
    return response;
  }
}
