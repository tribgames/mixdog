// Transport-neutral method table for the remote (LAN/WebSocket) bridge: the
// same EngineHost surface registerDesktopIpc exposes, minus desktop-only OS
// integrations (dialogs, shell reveal/open, zoom, updater, quit). Validation
// reuses the ipc.ts validators so the remote surface can never accept a shape
// the in-process IPC surface would reject.
import type { DesktopEngineHost } from './engine-host-api';
import type { DesktopSettingsStore } from './settings-store';
import type { DesktopSettings } from '../shared/contract';
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
  requiredToolApprovalDecision,
  sessionDisplayName,
} from './ipc';
import {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  requiredRepositoryCwd,
} from './git-contract.mjs';

// Secrets and OAuth flows stay desktop-local: tokens must not transit the
// bridge link until end-to-end encryption lands, and OAuth logins open a
// browser on the desktop machine where the phone cannot complete them.
const REMOTE_BLOCKED_CAPABILITIES: ReadonlySet<string> = new Set([
  'saveProviderApiKey',
  'authenticateProvider',
  'saveOpenAIUsageSessionKey',
  'saveOpenCodeGoUsageAuth',
  'saveDiscordToken',
  'saveTelegramToken',
  'loginOAuthProvider',
  'beginOAuthProviderLogin',
  'getOAuthProviderLoginStatus',
  'completeOAuthProviderLogin',
  'cancelOAuthProviderLogin',
  'loginOpenCodeGoUsage',
  // Media files reach a phone through the media HTTP route, which needs no
  // filesystem paths on the client. Keep the resolver host-side.
  'resolveMediaFile',
]);

function assertRemoteCapability(capability: string): void {
  if (REMOTE_BLOCKED_CAPABILITIES.has(capability)) {
    throw new TypeError(`capability ${capability} is not available over the remote bridge.`);
  }
}

export interface RemoteMethodDependencies {
  host: DesktopEngineHost;
  settingsStore?: Pick<DesktopSettingsStore, 'read' | 'update'>;
  /** Fires after a successful desktop-settings write (keep-awake wiring). */
  onDesktopSettingsChanged?: (settings: DesktopSettings) => void;
  terminals?: {
    ensure(id: string | null, cwd: string | null, profile?: TerminalSpawnProfile | string | null):
      { id: string; replay: string } | Promise<{ id: string; replay: string }>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
  };
}

export type RemoteMethod = (params: unknown[]) => unknown;

export function createRemoteMethods(
  { host, settingsStore, onDesktopSettingsChanged, terminals }: RemoteMethodDependencies,
): Record<string, RemoteMethod> {
  const backendInvoke = (name: string, args: unknown[]): Promise<unknown> =>
    host.backendInvoke(name, args);
  const operation = (name: string) => (...args: unknown[]) => backendInvoke(name, args);
  // Remote bridge/relay are transport clients, not another backend. Keep their
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
    readProjectFile: ([projectPath, relPath]) => host.readProjectTextFile(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    ),
    statProjectFile: ([projectPath, relPath]) => host.statProjectFile(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    ),
    listSessions: () => host.listSessions(),
    renameSession: ([sessionId, title]) =>
      host.renameSession(requiredSessionId(sessionId), sessionDisplayName(title)),
    setSessionArchived: ([sessionId, archived]) => {
      if (typeof archived !== 'boolean') throw new TypeError('archived must be a boolean.');
      return host.setSessionArchived(requiredSessionId(sessionId), archived);
    },
    deleteSession: ([sessionId]) => host.deleteSession(requiredSessionId(sessionId)),
    resumeSession: ([sessionId]) => host.resumeSession(requiredSessionId(sessionId)),
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
    submit: ([prompt, options]) =>
      host.submit(requiredPromptContent(prompt), requiredSubmitOptions(options)),
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
    abort: ([options]) => host.abort(requiredAbortOptions(options)),
    abortSession: ([sessionId, options]) =>
      host.abortSession(requiredSessionId(sessionId), requiredAbortOptions(options)),
    resolveToolApproval: ([id, decision]) => host.resolveToolApproval(
      requiredString(id, 'approval id', 1_024),
      requiredToolApprovalDecision(decision),
    ),
    resolveToolApprovalForSession: ([sessionId, id, decision]) =>
      host.resolveToolApprovalForSession(
        requiredSessionId(sessionId),
        requiredString(id, 'approval id', 1_024),
        requiredToolApprovalDecision(decision),
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
      return host.invokeCapability(request.capability, request.args);
    },
    readCapabilities: ([input]) => {
      const requests = requiredDesktopCapabilityReadRequests(input);
      for (const request of requests) assertRemoteCapability(request.capability);
      return host.readCapabilities(requests);
    },
    gitStatus: ([cwd]) => gitStatus(requiredRepositoryCwd(cwd)),
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
    methods.termProfiles = () => backendInvoke('termProfiles', []);
    methods.termWrite = ([id, data]) => {
      terminals.write(String(id || ''), String(data ?? ''));
    };
    methods.termResize = ([id, cols, rows]) => {
      terminals.resize(String(id || ''), Number(cols), Number(rows));
    };
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

// Shared RPC frame executor for the LAN bridge and the relay client: parses
// one wire frame and returns the response payload, or undefined when no
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
