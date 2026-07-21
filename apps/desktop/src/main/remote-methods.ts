// Transport-neutral method table for the remote (LAN/WebSocket) bridge: the
// same EngineHost surface registerDesktopIpc exposes, minus desktop-only OS
// integrations (dialogs, shell reveal/open, zoom, updater, quit). Validation
// reuses the ipc.ts validators so the remote surface can never accept a shape
// the in-process IPC surface would reject.
import type { EngineHost } from './engine-host';
import type { DesktopSettingsStore } from './settings-store';
import { requiredSessionId } from './desktop-state';
import {
  projectDisplayName,
  requiredDesktopCapabilityReadRequests,
  requiredDesktopCapabilityRequest,
  requiredDesktopSettingKey,
  requiredFileSearchLimit,
  requiredGitPaths,
  requiredModelCatalogOptions,
  requiredModelSelection,
  requiredPromptContent,
  requiredString,
  requiredSubmitOptions,
  requiredToolApprovalDecision,
  sessionDisplayName,
} from './ipc';
import {
  gitCommit,
  gitDiff,
  gitLog,
  gitPush,
  gitReview,
  gitReviewDiff,
  gitRevertFile,
  gitShow,
  gitStage,
  gitStatus,
  gitUnstage,
  requiredCommitHash,
  requiredRepositoryCwd,
} from './git-cli';

// Secrets and OAuth flows stay desktop-local: tokens must not transit the
// bridge link until end-to-end encryption lands, and OAuth logins open a
// browser on the desktop machine where the phone cannot complete them.
export const REMOTE_BLOCKED_CAPABILITIES: ReadonlySet<string> = new Set([
  'saveProviderApiKey',
  'authenticateProvider',
  'saveOpenAIUsageSessionKey',
  'saveOpenCodeGoUsageAuth',
  'saveDiscordToken',
  'saveTelegramToken',
  'saveWebhookAuthtoken',
  'loginOAuthProvider',
  'beginOAuthProviderLogin',
  'getOAuthProviderLoginStatus',
  'completeOAuthProviderLogin',
  'cancelOAuthProviderLogin',
  'loginOpenCodeGoUsage',
]);

function assertRemoteCapability(capability: string): void {
  if (REMOTE_BLOCKED_CAPABILITIES.has(capability)) {
    throw new TypeError(`capability ${capability} is not available over the remote bridge.`);
  }
}

export interface RemoteMethodDependencies {
  host: EngineHost;
  settingsStore?: Pick<DesktopSettingsStore, 'read' | 'update'>;
  terminals?: {
    ensure(id: string | null, cwd: string | null): { id: string; replay: string };
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
  };
}

export type RemoteMethod = (params: unknown[]) => unknown;

export function createRemoteMethods(
  { host, settingsStore, terminals }: RemoteMethodDependencies,
): Record<string, RemoteMethod> {
  const methods: Record<string, RemoteMethod> = {
    startProject: ([projectPath]) => host.startProject(requiredString(projectPath, 'projectPath')),
    startProjectTask: ([projectPath]) =>
      host.startProjectTask(requiredString(projectPath, 'projectPath')),
    startTask: () => host.startTask(),
    listProjects: () => host.listProjects(),
    renameProject: ([projectPath, alias]) =>
      host.renameProject(requiredString(projectPath, 'projectPath'), projectDisplayName(alias)),
    setProjectPinned: ([projectPath, pinned]) => {
      if (typeof pinned !== 'boolean') throw new TypeError('pinned must be a boolean.');
      return host.setProjectPinned(requiredString(projectPath, 'projectPath'), pinned);
    },
    removeProject: ([projectPath]) => host.removeProject(requiredString(projectPath, 'projectPath')),
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
    abort: () => host.abort(),
    resolveToolApproval: ([id, decision]) => host.resolveToolApproval(
      requiredString(id, 'approval id', 1_024),
      requiredToolApprovalDecision(decision),
    ),
    listProviderModels: ([options]) => host.listProviderModels(requiredModelCatalogOptions(options)),
    setModelRoute: ([selection]) => host.setModelRoute(requiredModelSelection(selection)),
    setFast: ([enabled]) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return host.setFast(enabled);
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
    gitDiff: ([cwd, path, staged]) =>
      gitDiff(requiredRepositoryCwd(cwd), requiredString(path, 'git path', 4_096), staged === true),
    gitStage: ([cwd, paths]) => gitStage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)),
    gitUnstage: ([cwd, paths]) => gitUnstage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)),
    gitCommit: ([cwd, message]) =>
      gitCommit(requiredRepositoryCwd(cwd), requiredString(message, 'commit message', 20_000)),
    gitPush: ([cwd]) => gitPush(requiredRepositoryCwd(cwd)),
    gitRevert: ([cwd, path, untracked]) => gitRevertFile(
      requiredRepositoryCwd(cwd),
      requiredString(path, 'git path', 4_096),
      untracked === true,
    ),
    gitLog: ([cwd]) => gitLog(requiredRepositoryCwd(cwd)),
    gitShow: ([cwd, hash]) => gitShow(requiredRepositoryCwd(cwd), requiredCommitHash(hash)),
    gitReview: ([cwd]) => gitReview(requiredRepositoryCwd(cwd)),
    gitReviewDiff: ([cwd, path, untracked]) => gitReviewDiff(
      requiredRepositoryCwd(cwd),
      requiredString(path, 'git path', 4_096),
      untracked === true,
    ),
  };
  if (settingsStore) {
    methods.readSettings = () => settingsStore.read();
    methods.updateSetting = ([key, enabled]) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return settingsStore.update(requiredDesktopSettingKey(key), enabled);
    };
  }
  if (terminals) {
    methods.termEnsure = ([id, cwd]) => terminals.ensure(
      typeof id === 'string' && id ? id : null,
      typeof cwd === 'string' && cwd ? cwd : null,
    );
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
    return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
