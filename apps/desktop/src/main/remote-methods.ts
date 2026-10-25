// Transport-neutral method table for the remote Relay client: the
// same desktop service surface registerDesktopIpc exposes, minus desktop-only OS
// integrations (dialogs, shell reveal/open, zoom, quit). Validation
// shares transport-neutral validators so the remote surface cannot accept a shape
// the in-process IPC surface would reject.
import { randomUUID } from 'node:crypto';
import { requiredProjectRecoveryRequest } from '../shared/project-recovery';
import {
  basename as pathBasename,
  dirname as pathDirname,
  relative as pathRelative,
  resolve as resolvePath,
} from 'node:path';

import type { DesktopService } from './desktop-service-contract';
import type { DesktopSettingsStore } from './settings-store';
import {
  type DesktopLocalPathEntry,
  type DesktopSettings,
  type DesktopUpdaterState,
  MAIN_BROWSER_PAGE_PREFIX,
  type ToolApprovalDecision,
} from '../shared/contract';
import { REMOTE_BLOCKED_CAPABILITY_NAMES } from '../shared/remote-blocked-capabilities';
import { normalizeRemoteBrowserControl } from '../shared/remote-browser';
import { readHostDisplayPreferences } from '../shared/host-display-preferences';
import { browserParityRemoteMethods, type BrowserRemoteMethod } from './remote-browser-methods';
import { remoteCapabilityArgs } from './remote-authority';
import { isAllowAllActionsEnable } from './developer-risk-confirm';
import { pushRemoteMethods } from './remote-push-methods';
import { validatedHostDirectoryPath } from './host-directories';
import { sessionRemoteMethods } from './remote-session-methods';
import { optionalSessionId, requiredSessionId } from './desktop-state';
import { submitFeedback } from './feedback-client';
import { validateGithubRequest } from '../../../../src/runtime/github/contract.mjs';
import type { TerminalSpawnProfile } from './terminal-contract';
import {
  projectDisplayName,
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
  requiredGitRequestContextInput,
  requiredGitOptionalMessage,
  requiredReviewDiffFiles,
  requiredModelCatalogOptions,
  requiredModelSelection,
  requiredSessionContentQuery,
  requiredString,
  optionalGithubLoginOptions,
  requiredGitGlobalConfigKey,
  requiredLspDocumentInput,
  requiredLspRequestInput,
  requiredTextFileContent,
  requiredTextFileEncoding,
  requiredWorkspaceFolders,
  requiredWorkspaceSearchOptions,
  requiredWorkspaceTextWrites,
  requiredConversationNotificationSetting,
  requiredNotificationDeviceId,
  requiredNotificationPreferencesPatch,
  requiredNotificationTarget,
} from './ipc-validation';
import { absoluteLocalPath } from './local-files';
import { codedErrorParams } from '../shared/coded-error';
import { redactSecrets } from '../shared/redact-secret';
import { remoteDesktopOnlyError } from '../shared/remote-error-codes';
import { SELECTED_FILE_GRANT_UNAVAILABLE } from '../shared/file-error-codes';
import { FileDownloadError } from '../shared/file-downloads';
import { fileDownloadRemoteMethods, type FileDownloadRequester, type FileDownloadService } from './file-downloads';
import { createRemoteFilePreviewMethods, remoteFileTarget } from './remote-file-preview';
import { createRemoteLocalPageMethods } from './remote-local-page';
import { createRemoteAttachmentMethods } from './remote-attachments';
import { createRemoteVisualizeMethods, type RemoteVisualizeMirror } from './remote-visualize';
import { clientSizeOwner, type TerminalSizeOwner } from '../shared/terminal-size-owner';
import { MAX_SELECTED_FILE_GRANTS, owningProject, sameGrantedPath, selectedFileGrantKey } from './selected-file-grants';
import {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  requiredGitRevision,
  requiredRepositoryCwd,
  requiredReviewSource,
} from './git-contract.mjs';

// Pairing approval is the trust: a paired client has the desktop's own
// capabilities. Only host-internal items that make no sense remotely stay
// refused. Media files reach a phone through the media HTTP route, which needs
// no filesystem paths on the client.
export const REMOTE_BLOCKED_CAPABILITIES: ReadonlySet<string> = REMOTE_BLOCKED_CAPABILITY_NAMES;

/** Session-addressed capabilities a phone gets value-only: the daemon answers
 *  with the session's whole snapshot (transcript included), which these
 *  callers never apply and which would otherwise cross the relay per re-read. */
const VALUE_ONLY_SESSION_CAPABILITIES: ReadonlySet<string> = new Set([
  'getTurnReviewDiff',
  'getTurnReviewFilePatch',
  // The session diff read (session-diff-cache.ts takes `.value` only) is
  // re-run by the scheduler; with the snapshot each answer queued the whole
  // transcript ahead of the next history page.
  'getSessionReviewDiff',
  'getSessionReviewFilePatch',
  'getTurnChanges',
  'skillsStatus',
]);

export function assertRemoteCapability(capability: string): void {
  if (REMOTE_BLOCKED_CAPABILITIES.has(capability)) {
    throw new TypeError(`capability ${capability} is not available over remote access.`);
  }
}

/** assertRemoteCapability for a call that carries its arguments. A paired
 *  client may never create a standing allow (a bot's action `allow`) and cannot
 *  write the desktop's audit; whether a connector or permission change widens a
 *  bot's EFFECTIVE authority is judged by the runtime writer (remote-authority.ts). */
export function assertRemoteCapabilityCall(capability: string, args: readonly unknown[] = []): void {
  assertRemoteCapability(capability);
  if (capability === 'recordAgentApprovalAudit') {
    throw new TypeError(`capability ${capability} is not available over remote access.`);
  }
  if (capability === 'setAgentPermission' && args[2] === 'allow') {
    throw new TypeError(`${capability} cannot create a standing allow over remote access; use the desktop.`);
  }
  // Turning on "Allow all actions" is confirmed by the person at this PC under the
  // human-only lock (developer-risk-confirm.ts); a paired browser on this PC could
  // be driven by Computer Use, so remote clients may only turn it off.
  if (isAllowAllActionsEnable(capability, args)) {
    throw remoteDesktopOnlyError(`${capability} cannot turn on Allow all actions over remote access; use the desktop.`);
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
  /** The relay's id for THIS connection (one per phone/tab). Terminal size
   *  ownership is claimed and released per connection. */
  connectionId?(): string;
  /** Whether this connection has not yet been shown another device's prompt
   *  in the session. A stale view is re-sent as a side effect. */
  staleView?(sessionId: string, device: string): boolean;
  /** Sessions this connection currently views (the host's own record of its
   *  visible set): the ones its transcript row reads may address. */
  viewedSessionIds?(): readonly string[];
  /** The transcript the host last sent this connection for a session (the
   *  copy its delta baseline holds), or null when it sent none. */
  heldTranscript?(sessionId: string): unknown;
  /** Marks a read this connection asked for: its answer reaches this
   *  connection although the session is not in its visible set yet. */
  requestRead?(sessionId: string): void;
  /** This connection asked for a history page: its window may hold `limit` rows. */
  requestTranscriptPage?(sessionId: string, limit: number): void;
  /** The read failed: its answer is no longer awaited. */
  releaseRead?(sessionId: string): void;
}

export { STALE_SESSION_VIEW_MESSAGE } from './remote-session-methods';

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
  /** Which approval a notification's Allow may answer (push-notifier.ts). Only
   *  the relay leg supplies it; without it every such Allow opens the app. */
  approvalNotifications?: {
    /** What that Allow answers with (the card's 한 번만 허용 decision); null opens the app. */
    approvalAllowDecision(sessionId: string, approvalId: string): ToolApprovalDecision | null;
    /** Allowed only by a click on its card: a bare Allow for it is refused. */
    approvalPointerOnly(sessionId: string, approvalId: string): boolean;
  };
  terminals?: {
    ensure(
      id: string | null,
      cwd: string | null,
      profile?: TerminalSpawnProfile | string | null
    ):
      | { id: string; replay: string; sizeOwner?: TerminalSizeOwner }
      | Promise<{ id: string; replay: string; sizeOwner?: TerminalSizeOwner }>;
    /** A running PTY's replay, or null when it is not running; never spawns. */
    attach(id: string): Promise<{ id: string; replay: string; sizeOwner?: TerminalSizeOwner } | null>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number, client?: string): void;
  };
  browserRemote?: (method: BrowserRemoteMethod, args: unknown[], timeoutMs?: number) => Promise<unknown>;
  /** Electron-only host actions (OS trash, auto-updater) run in the window
   *  process; the daemon asks it and awaits the answer. */
  hostRequest?: (method: RemoteHostRequestMethod, args: unknown[]) => Promise<unknown>;
  /** The daemon's mirror of the window's agent `visualize` tabs. */
  visualize?: RemoteVisualizeMirror;
  /** Host file downloads (file-downloads.ts), shared by every connection of
   *  this relay so unpair and session deletion reach every grant. */
  fileDownloads?: FileDownloadService;
  /** The paired device's one-file grants (see createSelectedFileGrants), held
   *  by the relay across that device's connections; a table of its own when
   *  absent. */
  selectedFileGrants?: SelectedFileGrants;
}

export type RemoteHostRequestMethod =
  | 'trashItem'
  | 'updaterState'
  | 'updaterCheck'
  | 'updaterInstall'
  | 'displayPreferences'
  | 'visualizeState'
  | 'visualizeCommand'
  | 'visualizeExport'
  | 'captureFileSnapshot'
  | 'localPageUrl'
  /** This PC's OS notifications: { supported, idleSeconds } (notification-center.ts). */
  | 'notificationStatus'
  /** One test notification on this PC: { ok, message? }. */
  | 'notificationTest';

export type RemoteMethod = (params: unknown[]) => unknown;
type InvokeDesktopOperation = (name: string, args: unknown[]) => Promise<unknown>;

/** Permissions this bridge issued for paths outside every registered project. */
export interface SelectedFileGrants {
  rememberFileGrant(absolutePath: string, sessionId: string): string;
  grantedFile(
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown
  ): { root: string; rel: string; absolute: string };
  grantedIf(accessToken: unknown): boolean;
}

/** A bridge grant's lifetime; unpair, close or its conversation ending drops
 *  it sooner. */
const BRIDGE_GRANT_TTL_MS = 60 * 60 * 1000;

/** One-file permissions for paths OUTSIDE any registered project: the
 *  device's counterpart of the desktop's selected-file grants, minted for any
 *  file the device describes (resolveLocalPathEntries, as the desktop's
 *  SelectedFileAccess.describe) or opens as an attachment. Bound to one
 *  paired device: the relay keeps them across that device's reconnects, as it
 *  keeps its download grants, so a file the client already resolved still
 *  opens after the relay leg changes. A grant minted for a conversation
 *  (`sessionId`, an attachment) ends with it; every grant ends after
 *  BRIDGE_GRANT_TTL_MS, and the client then describes the file again. A token
 *  names one exact path and nothing else; the same file keeps its one token,
 *  so describing it again never evicts the grant another surface holds. */
export function createSelectedFileGrants(sessionRemoved: (sessionId: string) => boolean): SelectedFileGrants {
  const fileGrants = new Map<string, { path: string; sessionId: string; expiresAt: number; token: string }>();
  const live = (grant: { sessionId: string; expiresAt: number }): boolean =>
    grant.expiresAt > Date.now() && !sessionRemoved(grant.sessionId);
  return {
    rememberFileGrant: (absolutePath: string, sessionId: string): string => {
      for (const [key, grant] of fileGrants) {
        if (grant.sessionId !== sessionId || !sameGrantedPath(grant.path, absolutePath)) continue;
        fileGrants.delete(key);
        if (!live(grant)) continue;
        // Most recently used last; the file was just described again.
        fileGrants.set(key, { ...grant, expiresAt: Date.now() + BRIDGE_GRANT_TTL_MS });
        return grant.token;
      }
      const token = randomUUID();
      fileGrants.set(selectedFileGrantKey(token), {
        path: absolutePath,
        sessionId,
        expiresAt: Date.now() + BRIDGE_GRANT_TTL_MS,
        token,
      });
      while (fileGrants.size > MAX_SELECTED_FILE_GRANTS) {
        const oldest = fileGrants.keys().next().value;
        if (!oldest) break;
        fileGrants.delete(oldest);
      }
      return token;
    },
    grantedFile: (accessToken: unknown, projectPath: unknown, relPath: unknown) => {
      const token = requiredString(accessToken, 'file access token', 128);
      const key = selectedFileGrantKey(token);
      const granted = fileGrants.get(key);
      if (!granted || !live(granted)) {
        fileGrants.delete(key);
        throw Object.assign(new Error('The selected-file permission is unavailable.'), {
          code: SELECTED_FILE_GRANT_UNAVAILABLE,
        });
      }
      const requested = resolvePath(requiredString(projectPath, 'projectPath'), requiredString(relPath, 'relPath'));
      if (!sameGrantedPath(granted.path, requested))
        throw new Error('The selected-file permission does not match this path.');
      return { root: pathDirname(granted.path), rel: pathBasename(granted.path), absolute: granted.path };
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
  'gitRequestContext',
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
    gitReview: ([cwd, source]) => git.gitReview(requiredRepositoryCwd(cwd), requiredReviewSource(source)),
    gitReviewDiff: ([cwd, path, untracked, source]) =>
      git.gitReviewDiff(
        requiredRepositoryCwd(cwd),
        requiredGitPath(path),
        untracked === true,
        requiredReviewSource(source)
      ),
    gitReviewDiffs: ([cwd, files, source]) =>
      git.gitReviewDiffs(requiredRepositoryCwd(cwd), requiredReviewDiffFiles(files), requiredReviewSource(source)),
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
    // Checkout/create: the guarded selectProjectBranch capability (invokeCapability).
    gitBranches: ([cwd]) => git.gitBranches(requiredRepositoryCwd(cwd)),
    gitRenameBranch: ([cwd, branch, nextBranch]) =>
      git.gitRenameBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch), requiredGitBranchName(nextBranch)),
    gitDeleteBranch: ([cwd, branch]) => git.gitDeleteBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)),
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
    gitRequestContext: ([cwd, input]) =>
      git.gitRequestContext(requiredRepositoryCwd(cwd), requiredGitRequestContextInput(input)),
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
    libreOfficeStatus: ([refresh]) => invokeDesktopOperation('libreOfficeStatus', [refresh === true]),
    installLibreOffice: () => invokeDesktopOperation('installLibreOffice', []),
    githubCliStatus: () => invokeDesktopOperation('githubCliStatus', []),
    githubRequest: ([cwd, input]) =>
      invokeDesktopOperation('githubRequest', [requiredRepositoryCwd(cwd), validateGithubRequest(input)]),
    installGithubCli: () => invokeDesktopOperation('installGithubCli', []),
    // A remote client opens the device page on its own browser, never the host's.
    githubCliLoginStart: () => invokeDesktopOperation('githubCliLoginStart', [{ openBrowser: false }]),
    githubCliLoginStatus: ([flowId]) =>
      invokeDesktopOperation('githubCliLoginStatus', [requiredString(flowId, 'flowId', 200)]),
    githubCliLoginOpenBrowser: ([flowId, options]) =>
      invokeDesktopOperation('githubCliLoginOpenBrowser', [
        requiredString(flowId, 'flowId', 200),
        optionalGithubLoginOptions(options),
      ]),
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

/** Absolute paths as the file surface describes them, exactly as the
 *  desktop's SelectedFileAccess.describe does: owned by the deepest registered
 *  project that contains them, otherwise named by a one-file grant the calls
 *  that follow can redeem. Older clients still send a conversation and an
 *  `anyConversation` option; neither narrows what may be described. */
async function resolveLocalPathEntries(
  paths: unknown,
  deps: {
    host: DesktopService;
    invokeDesktopOperation: InvokeDesktopOperation;
    grants: SelectedFileGrants;
  }
): Promise<DesktopLocalPathEntry[]> {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) {
    throw new TypeError('paths are invalid.');
  }
  const projects = await deps.host.listProjects().catch(() => []);
  const describe = async (raw: unknown): Promise<DesktopLocalPathEntry> => {
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
        row.accessToken = deps.grants.rememberFileGrant(entry.absolutePath, '');
      }
    }
    return row;
  };
  // Paths are described a few at a time, each with its own deadline: a path on
  // a stalled network share or an endless transcript search fails alone.
  const rows = new Array<DesktopLocalPathEntry>(paths.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const index = next++;
      rows[index] = await withPathDeadline(describe(paths[index]), String(paths[index]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOCAL_PATH_CONCURRENCY, paths.length) }, worker));
  return rows;
}

const LOCAL_PATH_CONCURRENCY = 4;
const LOCAL_PATH_TIMEOUT_MS = 15_000;

function withPathDeadline<T>(operation: Promise<T>, path: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${LOCAL_PATH_TIMEOUT_MS / 1000}s reading ${path}.`)),
      LOCAL_PATH_TIMEOUT_MS
    );
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

/** Entries inside a project, addressed the way the explorer addresses them:
 *  the desktop handlers' own calls, with the OS trash in the window process. */
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
  const editorFilePath = async (projectPath: unknown, relPath: unknown, accessToken: unknown): Promise<string> =>
    (await remoteFileTarget(host, grants, projectPath, relPath, accessToken)).absolute;
  const requiredEditorBackupRoot = (): string => {
    if (!userDataPath) throw new Error('Editor backup storage is unavailable.');
    return userDataPath;
  };
  return {
    writeProjectFile: ([projectPath, relPath, content, expectedContent, accessToken, encoding]) => {
      const text = requiredTextFileContent(content, 'file content');
      const expected = requiredTextFileContent(expectedContent, 'expected file content');
      const fileEncoding = requiredTextFileEncoding(encoding);
      // Checked and written through the handle whose real location was
      // authorized inside the project or granted folder (remote-project-files.ts).
      return remoteFileTarget(host, grants, projectPath, relPath, accessToken).then((target) =>
        invokeDesktopOperation('writeProjectTextFileAuthorized', [
          target.root,
          target.rel,
          text,
          expected,
          fileEncoding,
        ])
      );
    },
    // The desktop handler's read: user, workspace and folder settings.
    readEditorSettings: async ([projectPath, relPath, workspaceFile]) => {
      const root = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
      const workspace =
        typeof workspaceFile === 'string' && workspaceFile.trim() ? resolvePath(workspaceFile) : undefined;
      const rel = requiredString(relPath, 'relPath', 4_096);
      return invokeDesktopOperation('readScopedEditorSettings', [userDataPath || '', root, rel, workspace]);
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
      const files = relPaths === undefined ? undefined : requiredGitPaths(relPaths);
      return invokeDesktopOperation('replaceWorkspaceTextIn', [
        root,
        requiredWorkspaceSearchOptions(rawOptions),
        replacement,
        files,
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
      return invokeDesktopOperation('writeProjectTextFilesAuthorized', [root, requiredWorkspaceTextWrites(rawWrites)]);
    },
    projectRecovery: async ([projectPath, input]) => {
      const request = requiredProjectRecoveryRequest(input);
      const root = await (host.projectRecoveryDirectory?.bind(host) ?? host.projectDirectory.bind(host))(
        requiredString(projectPath, 'projectPath')
      );
      return invokeDesktopOperation('projectRecoveryIn', [root, request]);
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
    approvalNotifications,
    browserRemote,
    hostRequest,
    visualize,
    fileDownloads,
    selectedFileGrants,
  }: RemoteMethodDependencies,
  client?: RemoteMethodClient
): Record<string, RemoteMethod> {
  const invokeDesktopOperation = (name: string, args: unknown[]): Promise<unknown> =>
    host.invokeDesktopOperation(name, args);
  const requiredHostRequest = (): NonNullable<RemoteMethodDependencies['hostRequest']> => {
    if (!hostRequest) throw new TypeError('The desktop app is unavailable on this connection.');
    return hostRequest;
  };
  const grants =
    selectedFileGrants ?? createSelectedFileGrants((sessionId) => fileDownloads?.sessionRemoved(sessionId) === true);
  // The paired device behind this connection, as the relay authenticated it.
  const downloadRequester = (): FileDownloadRequester => {
    const connection = client?.connectionId?.() ?? '';
    const deviceId = client?.credentialId?.() || (connection ? `connection:${connection}` : '');
    if (!deviceId) throw new FileDownloadError('unavailable', 'This connection has no paired device identity.');
    return { deviceId };
  };
  const methods: Record<string, RemoteMethod> = {
    ...workspaceRemoteMethods({ host, invokeDesktopOperation, grants }),
    ...pushRemoteMethods(push, nativePush, client),
    listSessions: () => host.listSessions(),
    listAgentPool: () => host.listAgentPool(),
    searchSessionContent: ([query]) => host.searchSessionContent(requiredSessionContentQuery(query)),
    ...sessionRemoteMethods(host, client, browserRemote, approvalNotifications),
    ...hostCapabilityRemoteMethods(host, browserRemote, invokeDesktopOperation),
    ...browserParityRemoteMethods(browserRemote),
    ...gitRemoteMethods(invokeDesktopOperation),
    ...developerToolingRemoteMethods(invokeDesktopOperation),
    ...localFileRemoteMethods({ host, invokeDesktopOperation, grants }),
    ...(fileDownloads ? fileDownloadRemoteMethods(fileDownloads, downloadRequester) : {}),
    // ── Project entries and the editor ─────────────────────────────────────
    ...projectEntryRemoteMethods(host, (method, args) => requiredHostRequest()(method, args)),
    ...hostWindowRemoteMethods(requiredHostRequest, browserRemote),
    ...editorRemoteMethods({ host, userDataPath, invokeDesktopOperation, grants }),
    ...createRemoteFilePreviewMethods({ host, grants, hostRequest }),
    ...createRemoteLocalPageMethods({ host, grants, hostRequest }),
    ...createRemoteAttachmentMethods({ host, grants }),
    ...createRemoteVisualizeMethods({
      mirror: visualize,
      hostRequest,
      invokeDesktopOperation,
      // A PNG/PDF export becomes this device's own download.
      ...(fileDownloads ? { exportDownload: (file) => fileDownloads.registerExport(downloadRequester(), file) } : {}),
    }),
  };
  Object.assign(methods, notificationRemoteMethods(invokeDesktopOperation, client));
  if (settingsStore)
    Object.assign(methods, settingsRemoteMethods(settingsStore, onDesktopSettingsChanged, invokeDesktopOperation));
  if (terminals) Object.assign(methods, terminalRemoteMethods(terminals, invokeDesktopOperation, client));
  return methods;
}

function workspaceRemoteMethods({
  host,
  invokeDesktopOperation,
  grants,
}: {
  host: DesktopService;
  invokeDesktopOperation: InvokeDesktopOperation;
  grants: SelectedFileGrants;
}): Record<string, RemoteMethod> {
  return {
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
    // Add-project browser: directories only, valid before any project exists.
    listHostDirectories: ([path]) => invokeDesktopOperation('listHostDirectories', [validatedHostDirectoryPath(path)]),
    listProjectDir: ([projectPath, relDir]) =>
      host.listProjectDir(requiredString(projectPath, 'projectPath'), typeof relDir === 'string' ? relDir : ''),
    // Read through the handle whose real location was authorized inside the
    // project or granted folder (remote-project-files.ts).
    readProjectFile: ([projectPath, relPath, accessToken]) =>
      remoteFileTarget(host, grants, projectPath, relPath, accessToken).then((target) =>
        invokeDesktopOperation('readProjectTextFileAuthorized', [target.root, target.rel])
      ),
    statProjectFile: ([projectPath, relPath, accessToken]) =>
      remoteFileTarget(host, grants, projectPath, relPath, accessToken).then((target) =>
        target.granted
          ? invokeDesktopOperation('statProjectFileIn', [target.root, target.rel])
          : host.statProjectFile(requiredString(projectPath, 'projectPath'), target.rel)
      ),
    // Rasterized pages, never the converted PDF's path: a phone cannot open a
    // file on this machine, and the byte lane that could serve one is disabled
    // until it is encrypted. The operation validates the page window itself.
    // A protected document's password arrives inside this end-to-end encrypted
    // call and goes only to that conversion.
    previewDocumentPages: async ([projectPath, relPath, accessToken, options]) => {
      const target = await remoteFileTarget(host, grants, projectPath, relPath, accessToken);
      const request =
        options && typeof options === 'object'
          ? (options as { pages?: unknown; maxWidth?: unknown; password?: unknown })
          : {};
      // The conversion the desktop handler runs, on the same project or granted file.
      return invokeDesktopOperation('documentPreviewPagesIn', [
        target.root,
        target.rel,
        request.password === undefined
          ? { pages: request.pages, maxWidth: request.maxWidth }
          : { pages: request.pages, maxWidth: request.maxWidth, password: request.password },
      ]);
    },
  };
}

function hostCapabilityRemoteMethods(
  host: DesktopService,
  browserRemote: RemoteMethodDependencies['browserRemote'],
  invokeDesktopOperation: InvokeDesktopOperation
): Record<string, RemoteMethod> {
  const requiredBrowserRemote = (): NonNullable<RemoteMethodDependencies['browserRemote']> => {
    if (!browserRemote) throw new TypeError('Remote Browser Use is unavailable.');
    return browserRemote;
  };
  return {
    searchProjectFiles: ([projectIdOrWorkspaceId, query, limit, includeIgnored, includeDirectories]) => {
      if (typeof query !== 'string' || query.length > 1_024) {
        throw new TypeError('query is invalid.');
      }
      return host.searchProjectFiles(
        requiredString(projectIdOrWorkspaceId, 'projectIdOrWorkspaceId'),
        query,
        requiredFileSearchLimit(limit),
        includeIgnored === true,
        includeDirectories === true
      );
    },
    getSnapshot: () => host.getSnapshot(),
    listProviderModels: ([options]) => host.listProviderModels(requiredModelCatalogOptions(options)),
    setModelRoute: ([selection, sessionId]) =>
      host.setModelRoute(requiredModelSelection(selection), optionalSessionId(sessionId)),
    setFast: ([enabled, sessionId]) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return host.setFast(enabled, optionalSessionId(sessionId));
    },
    invokeCapability: ([input]) => {
      const request = requiredDesktopCapabilityRequest(input);
      assertRemoteCapabilityCall(request.capability, request.args);
      // A phone addresses the same pane session the desktop does. Dropping the
      // id answered every session-scoped read (/context, /inherit) from the
      // blank control session (user: 모바일 /context가 0으로 나온다).
      // The authority setters are marked no-widen: the runtime judges it atomically with the write.
      const result = host.invokeCapability(
        request.capability,
        remoteCapabilityArgs(request.capability, request.args),
        request.sessionId
      );
      // The daemon answers a session-addressed call with that session's whole
      // snapshot (transcript included). The turn review bar reads the value
      // only and the phone mirrors the session on its own lane, so each
      // re-read crossed the relay carrying the entire conversation. The
      // transcript card's turn-changes read is value-only for the same reason.
      const shaped = VALUE_ONLY_SESSION_CAPABILITIES.has(request.capability)
        ? result.then(({ value }) => ({ value }))
        : result;
      // The shared Lead face changed: the desktop and the other phones re-read it.
      if (request.capability === 'setLeadAppearance' || request.capability === 'setBotOrder') {
        void shaped.then(() => invokeDesktopOperation('notifySettingsChanged', ['desktop'])).catch(() => {});
      }
      return shaped;
    },
    readCapabilities: async ([input]) => {
      const requests = requiredDesktopCapabilityReadRequests(input);
      for (const request of requests) assertRemoteCapability(request.capability);
      return host.readCapabilities(requests);
    },
    browserRemoteControl: ([sessionId, input]) =>
      requiredBrowserRemote()('control', [requiredSessionId(sessionId), normalizeRemoteBrowserControl(input)]),
  };
}

function localFileRemoteMethods({
  host,
  invokeDesktopOperation,
  grants,
}: {
  host: DesktopService;
  invokeDesktopOperation: InvokeDesktopOperation;
  grants: SelectedFileGrants;
}): Record<string, RemoteMethod> {
  return {
    folderWatch: ([dir, recursive]) =>
      invokeDesktopOperation('folderWatch', [absoluteLocalPath(dir), recursive === true]),
    folderUnwatch: ([dir, recursive]) =>
      invokeDesktopOperation('folderUnwatch', [absoluteLocalPath(dir), recursive === true]),
    // File tabs and attachments: project files, and any other file through a
    // one-file grant, as on the desktop.
    resolveLocalPaths: ([paths]) => resolveLocalPathEntries(paths, { host, invokeDesktopOperation, grants }),
    // The desktop's attachment read of any local file.
    readLocalFile: ([path]) => invokeDesktopOperation('readLocalFileAbs', [absoluteLocalPath(path)]),
  };
}

function hostWindowRemoteMethods(
  requiredHostRequest: () => NonNullable<RemoteMethodDependencies['hostRequest']>,
  browserRemote: RemoteMethodDependencies['browserRemote']
): Record<string, RemoteMethod> {
  return {
    // Host updater: the window process owns it; these mirror the desktop
    // getUpdaterState / checkForDesktopUpdate / showDesktopUpdate calls.
    getUpdaterState: () => requiredHostRequest()('updaterState', []) as Promise<DesktopUpdaterState>,
    checkForDesktopUpdate: () => requiredHostRequest()('updaterCheck', []) as Promise<DesktopUpdaterState>,
    showDesktopUpdate: () => requiredHostRequest()('updaterInstall', []) as Promise<DesktopUpdaterState>,
    // The host window's theme + UI language: a browser with no choice of its own follows them.
    readHostDisplayPreferences: async () =>
      readHostDisplayPreferences(await requiredHostRequest()('displayPreferences', [])),
    // Only main-workspace browser tabs are the client's to release.
    browserReleasePage: async ([pageId]) => {
      if (!browserRemote) return;
      const id = requiredSessionId(pageId);
      if (!id.startsWith(MAIN_BROWSER_PAGE_PREFIX)) throw new TypeError('Browser page is not a main tab page.');
      await browserRemote('release', [id]);
    },
  };
}

function settingsRemoteMethods(
  settingsStore: NonNullable<RemoteMethodDependencies['settingsStore']>,
  onDesktopSettingsChanged: RemoteMethodDependencies['onDesktopSettingsChanged'],
  invokeDesktopOperation: InvokeDesktopOperation
): Record<string, RemoteMethod> {
  return {
    readSettings: () => settingsStore.read(),
    updateSetting: ([key, enabled]) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return settingsStore.update(requiredDesktopSettingKey(key), enabled).then(async (saved) => {
        onDesktopSettingsChanged?.(saved);
        // Open settings pages on the host and on other clients re-read it.
        await invokeDesktopOperation('notifySettingsChanged', ['desktop']).catch(() => {});
        return saved;
      });
    },
  };
}

/** Settings › Notifications on a paired device: the same service operations
 *  this PC's window calls, with this connection's paired client as the
 *  current device. A paired device reads every device and writes any, the
 *  trust it has for the other settings. */
function notificationRemoteMethods(
  invokeDesktopOperation: InvokeDesktopOperation,
  client: RemoteMethodClient | undefined
): Record<string, RemoteMethod> {
  const currentDeviceId = (): string => client?.credentialId?.() ?? '';
  return {
    getNotificationPreferences: () => invokeDesktopOperation('notificationPreferencesState', [currentDeviceId(), null]),
    setNotificationPreferences: ([deviceId, patch]) =>
      invokeDesktopOperation('setNotificationPreferences', [
        currentDeviceId(),
        null,
        requiredNotificationDeviceId(deviceId),
        requiredNotificationPreferencesPatch(patch),
      ]),
    sendTestNotification: ([deviceId]) =>
      invokeDesktopOperation('sendTestNotification', [requiredNotificationDeviceId(deviceId)]),
    listConversationNotifications: () => invokeDesktopOperation('listConversationNotifications', []),
    setConversationNotification: ([target, setting]) =>
      invokeDesktopOperation('setConversationNotification', [
        requiredNotificationTarget(target),
        requiredConversationNotificationSetting(setting),
      ]),
  };
}

function terminalRemoteMethods(
  terminals: NonNullable<RemoteMethodDependencies['terminals']>,
  invokeDesktopOperation: InvokeDesktopOperation,
  client: RemoteMethodClient | undefined
): Record<string, RemoteMethod> {
  // Size ownership is per connection: this phone's claims and releases are
  // keyed by the relay's id for THIS leg, never by anything it sends.
  const connectionId = (): string => client?.connectionId?.() || 'remote';
  return {
    termEnsure: async ([id, cwd, shell]) => {
      const { sizeOwner, ...ensured } = await terminals.ensure(
        typeof id === 'string' && id ? id : null,
        typeof cwd === 'string' && cwd ? cwd : null,
        typeof shell === 'string' && shell ? shell : null
      );
      const owner = clientSizeOwner(sizeOwner, connectionId());
      return owner ? { ...ensured, sizeOwner: owner } : ensured;
    },
    termAttach: async ([id]) => {
      const attached = await terminals.attach(requiredString(id, 'terminal id', 128));
      if (!attached) return null;
      const { sizeOwner, ...rest } = attached;
      const owner = clientSizeOwner(sizeOwner, connectionId());
      return owner ? { ...rest, sizeOwner: owner } : rest;
    },
    termProfiles: () => invokeDesktopOperation('termProfiles', []),
    termWrite: ([id, data]) => {
      terminals.write(String(id || ''), String(data ?? ''));
    },
    termResize: ([id, cols, rows, phoneOwner]) => {
      terminals.resize(String(id || ''), Number(cols), Number(rows), phoneOwner === true ? connectionId() : '');
    },
    // Closing a remote terminal pane must release its PTY; without this the
    // browser's dispose call answered "unknown method" and the shell lingered.
    termDispose: ([id]) => invokeDesktopOperation('termDispose', [requiredString(id, 'terminal id', 128)]),
    termActivity: () => invokeDesktopOperation('termActivity', []),
    // Focus, like size ownership, belongs to THIS connection.
    termFocus: ([id, focused]) =>
      invokeDesktopOperation('termFocus', [requiredString(id, 'terminal id', 128), focused === true, connectionId()]),
  };
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
  /** The error's whitelisted string params (coded-error.ts), redacted. */
  errorParams?: Record<string, string>;
}

const MIN_REDACTED_SECRET_LENGTH = 6;

/** Capabilities whose arguments carry secrets (API keys, session keys, auth
 *  codes, pasted redirect URLs). */
const SECRET_CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  'saveProviderApiKey',
  'saveOpenAIUsageSessionKey',
  'saveCustomProvider',
  'saveCustomProviderKey',
  'removeCustomProvider',
  'updateCustomProviderModel',
  'testCustomProvider',
  'checkCustomProviderKeyEnv',
  'discoverCustomProviderModels',
  'getMcpServerConfig',
  'addMcpServer',
  'saveMcpServer',
  'setDeveloperOption',
  'forgetProviderAuth',
  'beginOAuthProviderLogin',
  'getOAuthProviderLoginStatus',
  'completeOAuthProviderLogin',
  'cancelOAuthProviderLogin',
  'loginOAuthProvider',
  'authenticateProvider',
  // A pasted MCP OAuth redirect URL carries the authorization code.
  'completeMcpOAuthLogin',
  // A probed MCP config may carry header credentials.
  'probeMcpServerAuth',
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
  return redactSecrets(message, secretStringsOf(method, params));
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
  // Own entries only: an inherited name (`constructor`, `toString`) is not a method.
  const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
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
    // Only the display params the code declares public ride along (coded-error.ts);
    // the call's own secrets are redacted from them as from the message.
    const errorParams = codedErrorParams(code, (error as { details?: unknown } | null)?.details);
    if (errorParams) {
      response.errorParams = Object.fromEntries(
        Object.entries(errorParams).map(([key, value]) => [key, redactRemoteError(value, method, params)])
      );
    }
    return response;
  }
}
