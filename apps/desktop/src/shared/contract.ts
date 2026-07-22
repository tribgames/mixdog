export const DESKTOP_IPC = {
  chooseProject: 'mixdog:choose-project',
  startProject: 'mixdog:start-project',
  startProjectTask: 'mixdog:start-project-task',
  startTask: 'mixdog:start-task',
  listProjects: 'mixdog:list-projects',
  openProjectInExplorer: 'mixdog:open-project-in-explorer',
  openExternal: 'mixdog:open-external',
  renameProject: 'mixdog:rename-project',
  setProjectPinned: 'mixdog:set-project-pinned',
  removeProject: 'mixdog:remove-project',
  listSessions: 'mixdog:list-sessions',
  renameSession: 'mixdog:rename-session',
  setSessionArchived: 'mixdog:set-session-archived',
  deleteSession: 'mixdog:delete-session',
  remoteAccessInfo: 'mixdog:remote-access-info',
  prefetchSession: 'mixdog:prefetch-session',
  resumeSession: 'mixdog:resume-session',
  searchProjectFiles: 'mixdog:search-project-files',
  getSnapshot: 'mixdog:get-snapshot',
  submit: 'mixdog:submit',
  abort: 'mixdog:abort',
  resolveToolApproval: 'mixdog:resolve-tool-approval',
  listProviderModels: 'mixdog:list-provider-models',
  setModelRoute: 'mixdog:set-model-route',
  setFast: 'mixdog:set-fast',
  readSettings: 'mixdog:read-settings',
  updateSetting: 'mixdog:update-setting',
  getZoomFactor: 'mixdog:get-zoom-factor',
  setZoomFactor: 'mixdog:set-zoom-factor',
  zoomFactorChanged: 'mixdog:zoom-factor-changed',
  applyTitleBarTheme: 'mixdog:apply-titlebar-theme',
  invokeCapability: 'mixdog:invoke-capability',
  readCapabilities: 'mixdog:read-capabilities',
  dispose: 'mixdog:dispose',
  quit: 'mixdog:quit',
  state: 'mixdog:state',
  sessionsChanged: 'mixdog:sessions-changed',
  stateResync: 'mixdog:state-resync',
  perfLog: 'mixdog:perf-log',
  rendererReady: 'mixdog:renderer-ready',
  termEnsure: 'mixdog:term-ensure',
  termWrite: 'mixdog:term-write',
  termResize: 'mixdog:term-resize',
  termData: 'mixdog:term-data',
  gitStatus: 'mixdog:git-status',
  gitDiff: 'mixdog:git-diff',
  gitStage: 'mixdog:git-stage',
  gitUnstage: 'mixdog:git-unstage',
  gitCommit: 'mixdog:git-commit',
  gitPush: 'mixdog:git-push',
  gitRevert: 'mixdog:git-revert',
  gitLog: 'mixdog:git-log',
  gitShow: 'mixdog:git-show',
  gitReview: 'mixdog:git-review',
  gitReviewDiff: 'mixdog:git-review-diff',
  revealFile: 'mixdog:reveal-file',
  openFilePath: 'mixdog:open-file-path',
  getUpdaterState: 'mixdog:get-updater-state',
  checkForDesktopUpdate: 'mixdog:check-for-desktop-update',
  showDesktopUpdate: 'mixdog:show-desktop-update',
  updaterState: 'mixdog:updater-state',
} as const;

export type DesktopUpdaterState =
  | { status: 'disabled' | 'idle' | 'checking' | 'up-to-date' }
  | { status: 'downloading' | 'ready' | 'installing'; version: string; percent?: number }
  | { status: 'error'; message: string };

export interface DesktopActivityState extends Readonly<Record<string, unknown>> {
  active?: boolean;
  mode?: string;
  verb?: string;
  startedAt?: number;
}

export interface DesktopTranscriptItem extends Readonly<Record<string, unknown>> {
  id?: string | number;
  kind?: string;
  status?: string;
  label?: string;
  detail?: string;
  at?: number;
  model?: string;
  provider?: string;
  agent?: string;
}

export interface DesktopAgentWorker extends Readonly<Record<string, unknown>> {
  tag?: string;
  agent?: string;
  name?: string;
  status?: string;
  stage?: string;
  startedAt?: number | string;
  startTime?: number | string;
  createdAt?: number | string;
}

export interface DesktopAgentJob extends Readonly<Record<string, unknown>> {
  tag?: string;
  agent?: string;
  type?: string;
  task_id?: string;
  taskId?: string;
  status?: string;
  stage?: string;
  startedAt?: number | string;
}

export interface DesktopActiveToolState {
  count: number;
  startedAt: number;
}

export interface DesktopShellJobsState {
  count: number;
  elapsedLabel: string;
}

export interface DesktopWorkflowState extends Readonly<Record<string, unknown>> {
  id?: string;
  name?: string;
}

export interface DesktopEngineState extends Readonly<Record<string, unknown>> {
  items?: DesktopTranscriptItem[];
  queued?: unknown[];
  busy?: boolean;
  commandBusy?: boolean;
  thinking?: unknown;
  spinner?: DesktopActivityState | null;
  commandStatus?: DesktopActivityState | null;
  progressHint?: { text?: string; tone?: string } | null;
  fast?: boolean;
  fastCapable?: boolean;
  desktopSessionTitle?: string;
  agentWorkers?: DesktopAgentWorker[];
  agentJobs?: DesktopAgentJob[];
  activeTools?: {
    explore: DesktopActiveToolState;
    search: DesktopActiveToolState;
  } | null;
  shellJobs?: DesktopShellJobsState;
  workflow?: DesktopWorkflowState | null;
  remoteEnabled?: boolean;
}

// These are the core engine's real activity/completion fields, not a parallel
// desktop status model. In particular, `thinking`/spinner modes describe live
// work while statusdone/turndone items retain the core completion outcome.
export type EngineSnapshot = Readonly<DesktopEngineState> | null;

// Wire form of the `mixdog:state` push. Streaming publications replace the
// full `items` array with an identity-prefix patch (settled transcript items
// are immutable by identity in the host); the preload bridge reassembles the
// full snapshot before listeners see it, so renderers keep consuming
// EngineSnapshot. A `base` mismatch (window reload, missed event) triggers a
// `mixdog:state-resync` request and the host restarts from a full snapshot.
export interface DesktopStateItemsPatch {
  base: number;
  revision: number;
  prefix: number;
  append: DesktopTranscriptItem[];
}
export type DesktopStateWire = (DesktopEngineState & {
  __itemsRevision?: number;
  __itemsPatch?: DesktopStateItemsPatch;
}) | null;

export interface ToolApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface DesktopModelEffortOption {
  value: string;
  label: string;
}

export interface DesktopModelOption {
  provider: string;
  model: string;
  display: string;
  created?: number;
  releaseDate?: string;
  contextWindow?: number;
  family?: string;
  latest?: boolean;
  effortOptions: DesktopModelEffortOption[];
  fastCapable: boolean;
  fastPreferred: boolean;
  savedEffort?: string;
  savedFast?: boolean;
}

export interface DesktopModelCatalogOptions {
  force?: boolean;
  refresh?: boolean;
  quick?: boolean;
}

export interface DesktopModelSelection {
  provider: string;
  model: string;
  effort?: string;
  fast?: boolean;
}

export interface DesktopPromptTextPart {
  type: 'text';
  text: string;
}

export interface DesktopPromptImagePart {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface DesktopPromptFilePart {
  type: 'file';
  data: string;
  mimeType: string;
  filename?: string;
}

export type DesktopPromptContent =
  string | Array<DesktopPromptTextPart | DesktopPromptImagePart | DesktopPromptFilePart>;

export type DesktopPromptPriority = 'now' | 'next' | 'later';

export interface DesktopPromptAttachment {
  id: number;
  type: 'image';
  content: string;
  mediaType: string;
  filename?: string;
  sourcePath?: string;
  metadataText?: string;
}

export interface DesktopPastedText {
  id: number;
  text: string;
}

export interface DesktopSubmitOptions {
  displayText?: string;
  priority?: DesktopPromptPriority;
  pastedImages?: Record<string, DesktopPromptAttachment>;
  pastedTexts?: Record<string, DesktopPastedText>;
}

// Public engine features that are safe to expose to the renderer. Keeping this
// list explicit prevents the desktop bridge from becoming arbitrary method
// execution while still making the TUI's existing backend capabilities
// available to the GUI.
export const DESKTOP_CAPABILITIES = [
  'restoreQueued',
  'setEffort',
  'setToolMode',
  'getAutoClear',
  'setAutoClear',
  'getUpdateSettings',
  'setAutoUpdate',
  'checkForUpdate',
  'runUpdateNow',
  'getUpdateStatus',
  'getProfile',
  'setProfile',
  'getCompactionSettings',
  'setCompactionSettings',
  'getMemorySettings',
  'setMemoryEnabled',
  'getChannelSettings',
  'setChannelsEnabled',
  'getVoiceStatus',
  'toggleVoice',
  'agentControl',
  'toolsStatus',
  'selectTools',
  'getSystemShell',
  'setSystemShell',
  'mcpStatus',
  'reconnectMcp',
  'addMcpServer',
  'removeMcpServer',
  'setMcpServerEnabled',
  'getDisabledSkills',
  'setDisabledSkills',
  'skillsStatus',
  'skillContent',
  'addSkill',
  'reloadSkills',
  'pluginsStatus',
  'reloadPlugins',
  'addPlugin',
  'updatePlugin',
  'removePlugin',
  'enablePluginMcp',
  'hooksStatus',
  'contextStatus',
  'getTurnReviewDiff',
  'addHookRule',
  'setHookRuleEnabled',
  'deleteHookRule',
  'memoryControl',
  'recall',
  'runDoctor',
  'compact',
  'listPresets',
  'setModel',
  'getSearchRoute',
  'listSearchModels',
  'setSearchRoute',
  'listAgents',
  'listWorkflows',
  'getOutputStyle',
  'listOutputStyles',
  'setOutputStyle',
  'setWorkflow',
  'toggleRemote',
  'claimRemote',
  'isRemoteEnabled',
  'listThemes',
  'getTheme',
  'setTheme',
  'transcribeAudio',
  'resizeImage',
  'setAgentRoute',
  'setDefaultProvider',
  'listProviders',
  'getProviderSetup',
  'getUsageDashboard',
  'getOnboardingStatus',
  'skipOnboarding',
  'completeOnboarding',
  'loginOAuthProvider',
  'beginOAuthProviderLogin',
  'getOAuthProviderLoginStatus',
  'completeOAuthProviderLogin',
  'cancelOAuthProviderLogin',
  'saveProviderApiKey',
  'saveOpenCodeGoUsageAuth',
  'loginOpenCodeGoUsage',
  'saveOpenAIUsageSessionKey',
  'setLocalProvider',
  'authenticateProvider',
  'forgetProviderAuth',
  'getChannelSetup',
  'getChannelWorkerStatus',
  'setBackend',
  'saveDiscordToken',
  'forgetDiscordToken',
  'saveTelegramToken',
  'forgetTelegramToken',
  'saveWebhookAuthtoken',
  'forgetWebhookAuthtoken',
  'setChannel',
  'setWebhookConfig',
  'saveSchedule',
  'deleteSchedule',
  'setScheduleEnabled',
  'runScheduleNow',
  'saveWebhook',
  'deleteWebhook',
  'setWebhookEnabled',
  'clear',
] as const;

export type DesktopCapability = typeof DESKTOP_CAPABILITIES[number];

export const DESKTOP_READ_CAPABILITIES = [
  'getAutoClear',
  'getUpdateSettings',
  'getUpdateStatus',
  'getProfile',
  'getCompactionSettings',
  'getMemorySettings',
  'getChannelSettings',
  'getVoiceStatus',
  'toolsStatus',
  'getSystemShell',
  'mcpStatus',
  'getDisabledSkills',
  'skillsStatus',
  'skillContent',
  'pluginsStatus',
  'hooksStatus',
  'contextStatus',
  'getTurnReviewDiff',
  'listPresets',
  'getSearchRoute',
  'listSearchModels',
  'listAgents',
  'listWorkflows',
  'getOutputStyle',
  'listOutputStyles',
  'isRemoteEnabled',
  'listThemes',
  'getTheme',
  'listProviders',
  'getProviderSetup',
  'getUsageDashboard',
  'getOnboardingStatus',
  'getChannelSetup',
  'getChannelWorkerStatus',
] as const satisfies ReadonlyArray<DesktopCapability>;

export type DesktopReadCapability = typeof DESKTOP_READ_CAPABILITIES[number];

export interface DesktopCapabilityRequest {
  capability: DesktopCapability;
  args?: unknown[];
}

export interface DesktopCapabilityReadRequest {
  capability: DesktopReadCapability;
  args?: unknown[];
}

export type DesktopCapabilityReadResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface DesktopCapabilityResult<T = unknown> {
  value: T;
  snapshot: EngineSnapshot;
}

export type DesktopSettingKey = 'autoClear' | 'autoCompact';

export interface DesktopSettings {
  autoClear: boolean;
  autoCompact: boolean;
}

export type DesktopSessionClassification = 'task' | 'project' | null;

/** Pairing card data for Settings → Connection (QRs pre-rendered as SVG in
 *  the main process so the renderer needs no QR dependency). */
export interface DesktopRemoteAccessInfo {
  port: number;
  urls: string[];
  browserUrl: string;
  appLink: string;
  apkUrl: string;
  browserQrSvg: string;
  appQrSvg: string;
  /** QR of the preferred APK download URL (relay when connected, else LAN). */
  apkQrSvg?: string;
  /** Relay pairing (set while the desktop is connected to a public relay):
   *  these work from anywhere, not just the LAN. */
  relayBrowserUrl?: string;
  relayAppLink?: string;
  relayApkUrl?: string;
  relayBrowserQrSvg?: string;
  relayAppQrSvg?: string;
}

export interface DesktopSessionSummary {
  id: string;
  preview: string;
  title: string;
  updatedAt: number;
  /** User/assistant message count — the unread dot keys off GROWTH here, not
   *  updatedAt, so housekeeping saves never re-dot an already-checked session. */
  messageCount: number;
  cwd: string;
  classification: DesktopSessionClassification;
  projectPath: string | null;
  currentSession: boolean;
  /** Fresh cross-process turn heartbeat; independent of which session is selected. */
  working?: boolean;
  /** Codex-style archive: hidden from Recent, restorable; file stays on disk. */
  archived?: boolean;
}

export interface DesktopProjectSummary {
  name: string;
  path: string;
  alias: string | null;
  pinned: boolean;
}

export interface DesktopApi {
  chooseProject(): Promise<string | null>;
  startProject(projectPath: string): Promise<EngineSnapshot>;
  startProjectTask(projectPath: string): Promise<EngineSnapshot>;
  startTask(): Promise<EngineSnapshot>;
  listProjects(): Promise<DesktopProjectSummary[]>;
  openProjectInExplorer(projectPath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  renameProject(projectPath: string, alias: string): Promise<void>;
  setProjectPinned(projectPath: string, pinned: boolean): Promise<void>;
  removeProject(projectPath: string): Promise<void>;
  listSessions(): Promise<DesktopSessionSummary[]>;
  /** Push channel: fires with a fresh catalog whenever the on-disk session
   *  store changes (any mixdog process). Renderers fall back to their
   *  safety-net poll when the host does not provide it (remote shim). */
  subscribeSessions?(listener: (sessions: DesktopSessionSummary[]) => void): () => void;
  renameSession(sessionId: string, title: string): Promise<void>;
  setSessionArchived?(sessionId: string, archived: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<EngineSnapshot>;
  /** Settings → Connection: pairing QRs + URLs for the phone remote. Only
   *  the in-process desktop implements it (null while the bridge is off);
   *  the remote shim omits it — a phone never needs its own pairing card. */
  getRemoteAccessInfo?(): Promise<DesktopRemoteAccessInfo | null>;
  prefetchSession?(sessionId: string): Promise<boolean>;
  resumeSession(sessionId: string): Promise<EngineSnapshot>;
  searchProjectFiles(projectIdOrWorkspaceId: string, query: string, limit?: number): Promise<string[]>;
  getSnapshot(): Promise<EngineSnapshot>;
  subscribeState(listener: (snapshot: EngineSnapshot) => void): () => void;
  /** Fire-and-forget renderer perf timing line (MIXDOG_DESKTOP_PERF=1 only). */
  perfLog?(line: string): void;
  /** First React commit signal — main defers window.show until it lands. */
  rendererReady?(): void;
  /** Dock terminal: create or reattach the shared PTY (main-process owned). */
  termEnsure?(id: string | null, cwd?: string | null): Promise<{ id: string; replay: string }>;
  termWrite?(id: string, data: string): void;
  termResize?(id: string, cols: number, rows: number): void;
  subscribeTermData?(listener: (event: { id: string; data: string }) => void): () => void;
  /** Dock Git panel: plain git CLI over the active project directory. */
  gitStatus?(cwd: string): Promise<{ repository: boolean; branch: string; upstream: boolean; ahead: number; behind: number; files: Array<{ path: string; index: string; worktree: string; untracked: boolean; additions: number; deletions: number }> }>;
  gitDiff?(cwd: string, path: string, staged?: boolean): Promise<string>;
  gitStage?(cwd: string, paths: string[]): Promise<void>;
  gitUnstage?(cwd: string, paths: string[]): Promise<void>;
  gitCommit?(cwd: string, message: string): Promise<string>;
  gitPush?(cwd: string): Promise<string>;
  gitRevert?(cwd: string, path: string, untracked: boolean): Promise<void>;
  gitLog?(cwd: string): Promise<Array<{ hash: string; shortHash: string; subject: string; when: string; pushed: boolean }>>;
  gitShow?(cwd: string, hash: string): Promise<string>;
  /** Review pane: cumulative diff of the working tree vs merge-base(origin default branch, HEAD). */
  gitReview?(cwd: string): Promise<{ base: string; files: Array<{ path: string; status: string; additions: number; deletions: number; untracked: boolean; uncommitted: boolean }> }>;
  gitReviewDiff?(cwd: string, path: string, untracked?: boolean): Promise<string>;
  /** Review file context menu: OS-level reveal/open for a project-relative file. */
  revealFile?(cwd: string, path: string): Promise<void>;
  openFilePath?(cwd: string, path: string): Promise<void>;
  getUpdaterState(): Promise<DesktopUpdaterState>;
  subscribeUpdaterState(listener: (state: DesktopUpdaterState) => void): () => void;
  checkForDesktopUpdate(): Promise<DesktopUpdaterState>;
  showDesktopUpdate(): Promise<DesktopUpdaterState>;
  submit(prompt: DesktopPromptContent, options?: DesktopSubmitOptions): Promise<boolean>;
  abort(): Promise<unknown>;
  resolveToolApproval(id: string, decision: ToolApprovalDecision): Promise<boolean>;
  listProviderModels(options?: DesktopModelCatalogOptions): Promise<DesktopModelOption[]>;
  setModelRoute(selection: DesktopModelSelection): Promise<EngineSnapshot>;
  setFast(enabled: boolean): Promise<EngineSnapshot>;
  readSettings(): Promise<DesktopSettings>;
  updateSetting(key: DesktopSettingKey, enabled: boolean): Promise<DesktopSettings>;
  getZoomFactor(): Promise<number>;
  setZoomFactor(factor: number): Promise<number>;
  onZoomFactorChanged(listener: (factor: number) => void): () => void;
  applyTitleBarTheme(theme: string): Promise<void>;
  invokeCapability<T = unknown>(request: DesktopCapabilityRequest): Promise<DesktopCapabilityResult<T>>;
  readCapabilities(requests: DesktopCapabilityReadRequest[]): Promise<DesktopCapabilityReadResult[]>;
  dispose(): Promise<void>;
  quit(): Promise<void>;
}
