export const DESKTOP_IPC = {
  chooseProject: 'mixdog:choose-project',
  chooseFile: 'mixdog:choose-file',
  chooseFiles: 'mixdog:choose-files',
  chooseWorkspace: 'mixdog:choose-workspace',
  saveWorkspace: 'mixdog:save-workspace',
  readEditorSettings: 'mixdog:read-editor-settings',
  startProject: 'mixdog:start-project',
  startProjectTask: 'mixdog:start-project-task',
  startTask: 'mixdog:start-task',
  listProjects: 'mixdog:list-projects',
  addProject: 'mixdog:add-project',
  openProjectInExplorer: 'mixdog:open-project-in-explorer',
  openExternal: 'mixdog:open-external',
  renameProject: 'mixdog:rename-project',
  removeProject: 'mixdog:remove-project',
  readInstructions: 'mixdog:read-instructions',
  writeInstructions: 'mixdog:write-instructions',
  listProjectDir: 'mixdog:list-project-dir',
  readProjectFile: 'mixdog:read-project-file',
  previewProjectFile: 'mixdog:preview-project-file',
  writeProjectFile: 'mixdog:write-project-file',
  readEditorBackup: 'mixdog:read-editor-backup',
  writeEditorBackup: 'mixdog:write-editor-backup',
  deleteEditorBackup: 'mixdog:delete-editor-backup',
  statProjectFile: 'mixdog:stat-project-file',
  createProjectEntry: 'mixdog:create-project-entry',
  renameProjectEntry: 'mixdog:rename-project-entry',
  trashProjectEntry: 'mixdog:trash-project-entry',
  moveProjectEntry: 'mixdog:move-project-entry',
  copyProjectEntry: 'mixdog:copy-project-entry',
  chooseFolder: 'mixdog:choose-folder',
  listFolderDir: 'mixdog:list-folder-dir',
  createFolderEntry: 'mixdog:create-folder-entry',
  renameFolderEntry: 'mixdog:rename-folder-entry',
  moveFolderEntry: 'mixdog:move-folder-entry',
  copyFolderEntry: 'mixdog:copy-folder-entry',
  trashFolderEntry: 'mixdog:trash-folder-entry',
  openFolderEntry: 'mixdog:open-folder-entry',
  revealFolderEntry: 'mixdog:reveal-folder-entry',
  folderPlaces: 'mixdog:folder-places',
  folderEntryIcon: 'mixdog:folder-entry-icon',
  resolveLocalPaths: 'mixdog:resolve-local-paths',
  readLocalFile: 'mixdog:read-local-file',
  folderWatch: 'mixdog:folder-watch',
  folderUnwatch: 'mixdog:folder-unwatch',
  folderChanged: 'mixdog:folder-changed',
  codeGraphQuery: 'mixdog:code-graph-query',
  lspDocument: 'mixdog:lsp-document',
  lspRequest: 'mixdog:lsp-request',
  lspApplyWorkspaceEdit: 'mixdog:lsp-apply-workspace-edit',
  lspDiagnostics: 'mixdog:lsp-diagnostics',
  lspStatus: 'mixdog:lsp-status',
  relayPayloadRefused: 'mixdog:relay-payload-refused',
  listSessions: 'mixdog:list-sessions',
  renameSession: 'mixdog:rename-session',
  setSessionArchived: 'mixdog:set-session-archived',
  deleteSession: 'mixdog:delete-session',
  inheritSession: 'mixdog:inherit-session',
  remoteAccessInfo: 'mixdog:remote-access-info',
  rotateRemoteAccess: 'mixdog:rotate-remote-access',
  revokeRemoteAccessClient: 'mixdog:revoke-remote-access-client',
  prefetchSession: 'mixdog:prefetch-session',
  setVisibleSessions: 'mixdog:set-visible-sessions',
  listAgentPool: 'mixdog:list-agent-pool',
  searchProjectFiles: 'mixdog:search-project-files',
  searchWorkspaceText: 'mixdog:search-workspace-text',
  replaceWorkspaceText: 'mixdog:replace-workspace-text',
  getSnapshot: 'mixdog:get-snapshot',
  submitNewTask: 'mixdog:submit-new-task',
  submitToSession: 'mixdog:submit-to-session',
  abortSession: 'mixdog:abort-session',
  resolveToolApprovalForSession: 'mixdog:resolve-tool-approval-for-session',
  listProviderModels: 'mixdog:list-provider-models',
  setModelRoute: 'mixdog:set-model-route',
  setFast: 'mixdog:set-fast',
  readSettings: 'mixdog:read-settings',
  updateSetting: 'mixdog:update-setting',
  getZoomFactor: 'mixdog:get-zoom-factor',
  setZoomFactor: 'mixdog:set-zoom-factor',
  zoomFactorChanged: 'mixdog:zoom-factor-changed',
  browserOpenRequested: 'mixdog:browser-open-requested',
  applyTitleBarTheme: 'mixdog:apply-titlebar-theme',
  setTitleBarDim: 'mixdog:set-titlebar-dim',
  invokeCapability: 'mixdog:invoke-capability',
  readCapabilities: 'mixdog:read-capabilities',
  quit: 'mixdog:quit',
  state: 'mixdog:state',
  sessionState: 'mixdog:session-state',
  sessionStateResync: 'mixdog:session-state-resync',
  sessionsChanged: 'mixdog:sessions-changed',
  agentPoolChanged: 'mixdog:agent-pool-changed',
  remoteClientClaim: 'mixdog:remote-client-claim',
  listRemoteClientClaims: 'mixdog:list-remote-client-claims',
  resolveRemoteClientClaim: 'mixdog:resolve-remote-client-claim',
  stateResync: 'mixdog:state-resync',
  perfLog: 'mixdog:perf-log',
  rendererDiagnostic: 'mixdog:renderer-diagnostic',
  rendererReady: 'mixdog:renderer-ready',
  termEnsure: 'mixdog:term-ensure',
  termWrite: 'mixdog:term-write',
  termResize: 'mixdog:term-resize',
  termAcknowledge: 'mixdog:term-acknowledge',
  termDispose: 'mixdog:term-dispose',
  termData: 'mixdog:term-data',
  termProfiles: 'mixdog:term-profiles',
  gitStatus: 'mixdog:git-status',
  gitBranches: 'mixdog:git-branches',
  gitCheckoutBranch: 'mixdog:git-checkout-branch',
  gitCreateBranch: 'mixdog:git-create-branch',
  gitRenameBranch: 'mixdog:git-rename-branch',
  gitDeleteBranch: 'mixdog:git-delete-branch',
  gitMergeBranch: 'mixdog:git-merge-branch',
  gitDiff: 'mixdog:git-diff',
  gitApplyPatch: 'mixdog:git-apply-patch',
  gitStage: 'mixdog:git-stage',
  gitUnstage: 'mixdog:git-unstage',
  gitIgnore: 'mixdog:git-ignore',
  gitCommit: 'mixdog:git-commit',
  gitCommitPaths: 'mixdog:git-commit-paths',
  gitGenerateCommitMessage: 'mixdog:git-generate-commit-message',
  gitAmend: 'mixdog:git-amend',
  gitUndoLastCommit: 'mixdog:git-undo-last-commit',
  gitStash: 'mixdog:git-stash',
  gitStashPop: 'mixdog:git-stash-pop',
  gitStashList: 'mixdog:git-stash-list',
  gitStashApply: 'mixdog:git-stash-apply',
  gitStashDrop: 'mixdog:git-stash-drop',
  ghPrList: 'mixdog:gh-pr-list',
  ghPrDefaultBranch: 'mixdog:gh-pr-default-branch',
  ghPrCreate: 'mixdog:gh-pr-create',
  ghPrView: 'mixdog:gh-pr-view',
  ghPrCheckout: 'mixdog:gh-pr-checkout',
  ghPrMerge: 'mixdog:gh-pr-merge',
  ghPrDiff: 'mixdog:gh-pr-diff',
  gitPush: 'mixdog:git-push',
  gitFetch: 'mixdog:git-fetch',
  gitPull: 'mixdog:git-pull',
  gitSync: 'mixdog:git-sync',
  gitContinue: 'mixdog:git-continue',
  gitAbortOperation: 'mixdog:git-abort-operation',
  gitRevert: 'mixdog:git-revert',
  gitLog: 'mixdog:git-log',
  gitShow: 'mixdog:git-show',
  gitShowDiff: 'mixdog:git-show-diff',
  gitShowFile: 'mixdog:git-show-file',
  gitResetToCommit: 'mixdog:git-reset-to-commit',
  gitRevertCommit: 'mixdog:git-revert-commit',
  gitCherryPickCommit: 'mixdog:git-cherry-pick-commit',
  gitCreateTag: 'mixdog:git-create-tag',
  gitDeleteTag: 'mixdog:git-delete-tag',
  gitCheckoutCommit: 'mixdog:git-checkout-commit',
  gitCreateBranchAtCommit: 'mixdog:git-create-branch-at-commit',
  gitReview: 'mixdog:git-review',
  gitReviewDiff: 'mixdog:git-review-diff',
  githubCliStatus: 'mixdog:github-cli-status',
  installGithubCli: 'mixdog:install-github-cli',
  githubCliLoginStart: 'mixdog:github-cli-login-start',
  githubCliLoginStatus: 'mixdog:github-cli-login-status',
  githubCliLoginCancel: 'mixdog:github-cli-login-cancel',
  githubCliLogout: 'mixdog:github-cli-logout',
  githubCliAccount: 'mixdog:github-cli-account',
  gitGlobalConfig: 'mixdog:git-global-config',
  setGitGlobalConfig: 'mixdog:set-git-global-config',
  readGitPreferences: 'mixdog:read-git-preferences',
  updateGitPreferences: 'mixdog:update-git-preferences',
  revealFile: 'mixdog:reveal-file',
  openFilePath: 'mixdog:open-file-path',
  openAttachmentImage: 'mixdog:open-attachment-image',
  getUpdaterState: 'mixdog:get-updater-state',
  checkForDesktopUpdate: 'mixdog:check-for-desktop-update',
  showDesktopUpdate: 'mixdog:show-desktop-update',
  updaterState: 'mixdog:updater-state',
  githubStarStatus: 'mixdog:github-star-status',
  starGithub: 'mixdog:star-github',
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
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
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
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  task_id?: string;
  taskId?: string;
  status?: string;
  stage?: string;
  startedAt?: number | string;
}

/** One active row from the merged child/Lead lifecycle pools. */
export interface DesktopAgentPoolRow extends Readonly<Record<string, unknown>> {
  tag: string;
  sessionId: string;
  ownerSessionId: string | null;
  title?: string | null;
  agent: string | null;
  provider: string | null;
  model: string | null;
  effort?: string | null;
  fast?: boolean | null;
  status: string;
  stage: string;
  startedAt: number | string | null;
  turnStartedAt: number | string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
  idleSince?: number | string | null;
  reapAt?: number | string | null;
  cwd: string | null;
  clientHostPid: number | null;
  taskId: string | null;
}

export interface DesktopActiveToolState {
  count: number;
  startedAt: number;
}

export interface DesktopShellJobsState {
  count: number;
  elapsedLabel: string;
  jobs?: DesktopShellJobRow[];
}

export interface DesktopShellJobRow extends Readonly<Record<string, unknown>> {
  taskId: string;
  command: string;
  cwd: string;
  startedAt: number | string | null;
}

export interface DesktopWorkflowState extends Readonly<Record<string, unknown>> {
  id?: string;
  name?: string;
}

export interface DesktopSessionState extends Readonly<Record<string, unknown>> {
  items?: DesktopTranscriptItem[];
  streamingTail?: DesktopTranscriptItem | null;
  queued?: unknown[];
  busy?: boolean;
  commandBusy?: boolean;
  thinking?: unknown;
  spinner?: DesktopActivityState | null;
  commandStatus?: DesktopActivityState | null;
  progressHint?: { text?: string; tone?: string } | null;
  fast?: boolean;
  fastCapable?: boolean;
  modelParameters?: Readonly<Record<string, string>>;
  contextPercent?: number;
  desktopSessionTitle?: string;
  agentWorkers?: DesktopAgentWorker[];
  agentJobs?: DesktopAgentJob[];
  activeTools?: {
    explore?: DesktopActiveToolState;
    web_search?: DesktopActiveToolState;
    shell?: DesktopActiveToolState;
    agent?: DesktopActiveToolState;
  } | null;
  shellJobs?: DesktopShellJobsState;
  /** Host-wide background shell totals (keep-awake). `shellJobs` above is the
   *  pane's OWN session bucket and must stay that way. */
  hostShellJobs?: DesktopShellJobsState;
  workflow?: DesktopWorkflowState | null;
  remoteEnabled?: boolean;
}

// These are the session runtime's real activity/completion fields, not a parallel
// desktop status model. In particular, `thinking`/spinner modes describe live
// work while statusdone/turndone items retain the core completion outcome.
export type SessionSnapshot = Readonly<DesktopSessionState> | null;

/** One split-pane live-lane publication after preload reconstruction: a
 *  pooled session's own full snapshot, keyed by sessionId. */
export type DesktopSessionStateUpdate = {
  sessionId: string;
  snapshot: SessionSnapshot;
  /** Publication boundary this frame came from. "live" is an owner
   *  publication; "replay" is a re-emitted retained/durable projection. */
  frameSource: DesktopSessionFrameSource;
  /** Authoritative transcript CONTENT generation for this session — NOT an
   *  arrival counter. It advances only when an owner publication (or a
   *  non-regressing durable read) projects different transcript content, and
   *  a replay re-carries the revision of the frame it was derived from, so a
   *  stale disk projection delivered late can never claim to be newer. */
  contentRevision?: number;
  /** Why this frame carried a NULL snapshot. Only 'gone' is a real teardown.
   *  The daemon reclaims an unwatched idle session's memory ('unloaded') and a
   *  dropped daemon transport ('disconnected') both leave the transcript on
   *  disk and reload on demand, so a cached lane must SURVIVE them — dropping
   *  it repainted a live task as an empty New Task
   *  (user: 진행중인 TASK창이 갑자기 NEWTASK처럼 아예 비어버린다). */
  laneEnd?: DesktopSessionLaneEnd;
};

export type DesktopSessionFrameSource = 'live' | 'replay';
export type DesktopSessionLaneEnd = 'gone' | 'unloaded' | 'disconnected';

// Wire form of the `mixdog:state` push. Streaming publications replace the
// full `items` array with an identity-prefix patch (settled transcript items
// are immutable by identity in the host); the preload bridge reassembles the
// full snapshot before listeners see it, so renderers keep consuming
// SessionSnapshot. A `base` mismatch (window reload, missed event) triggers a
// `mixdog:state-resync` request and the host restarts from a full snapshot.
export interface DesktopStateItemsPatch {
  base: number;
  revision: number;
  prefix: number;
  append: DesktopTranscriptItem[];
}
export interface DesktopStateStreamingTailPatch {
  prefix: number;
  append: string;
  tail: DesktopTranscriptItem;
}
export interface DesktopStateFieldsPatch {
  base: number;
  revision: number;
  changed: Readonly<Record<string, unknown>>;
  removed: string[];
}
export type DesktopStateWire = (DesktopSessionState & {
  __itemsRevision?: number;
  __itemsPatch?: DesktopStateItemsPatch;
  __streamingTailPatch?: DesktopStateStreamingTailPatch;
  __statePatch?: DesktopStateFieldsPatch;
}) | null;

/** IPC-only split-pane lane wire. Preload reconstructs this delta before the
 * renderer-facing DesktopSessionStateUpdate listener runs. */
export type DesktopSessionStateWireUpdate = {
  sessionId: string;
  wire: DesktopStateWire;
  frameSource: DesktopSessionFrameSource;
  contentRevision?: number;
  laneEnd?: DesktopSessionLaneEnd;
};

export interface ToolApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface DesktopModelEffortOption {
  value: string;
  label: string;
}

export interface DesktopModelParameterOption {
  id: string;
  label: string;
  kind: 'boolean' | 'enum';
  options: Array<{ value: string; label: string; contextWindow?: number }>;
}

export interface DesktopModelOption {
  provider: string;
  model: string;
  display: string;
  created?: number;
  releaseDate?: string;
  contextWindow?: number;
  maxContextWindow?: number;
  family?: string;
  latest?: boolean;
  /** Free-form secondary line; media lanes use it for the provider name. */
  description?: string;
  supportsVision?: boolean;
  effortOptions: DesktopModelEffortOption[];
  fastCapable: boolean;
  fastEfforts?: string[];
  fastPreferred: boolean;
  savedEffort?: string;
  savedFast?: boolean;
  defaultEffort?: string;
  defaultFast?: boolean;
  modelParameterOptions?: DesktopModelParameterOption[];
  parameterVariants?: Array<Record<string, string>>;
  defaultModelParameters?: Record<string, string>;
  savedModelParameters?: Record<string, string>;
  savedContextPercent?: number;
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
  modelParameters?: Record<string, string>;
  contextPercent?: number;
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
  content?: string;
  attachmentRef?: string;
  sizeBytes?: number;
  mediaType: string;
  filename?: string;
  sourcePath?: string;
  metadataText?: string;
}

export interface DesktopPastedText {
  id: number;
  text?: string;
  attachmentRef?: string;
  sizeBytes?: number;
  chars?: number;
  filename?: string;
  mimeType?: string;
  source?: 'file' | 'paste';
}

export interface DesktopSubmitOptions {
  /** Renderer-generated correlation id reused by the session queue/transcript. */
  id?: string;
  /** Wall-clock submit time for privacy-safe queue/steering latency diagnostics. */
  submittedAt?: number;
  displayText?: string;
  priority?: DesktopPromptPriority;
  pastedImages?: Record<string, DesktopPromptAttachment>;
  pastedTexts?: Record<string, DesktopPastedText>;
}

export interface DesktopAbortOptions {
  /** Rewind a submitted prompt only when the composer was empty at cancel. */
  restorePrompt?: boolean;
  /** Renderer submission identity used to reclaim an accepted prompt before
   *  its busy projection reaches the pane. */
  submissionId?: string;
}

export interface DesktopNewTaskDraft {
  projectPath?: string;
  route?: DesktopModelSelection;
  workflowId?: string;
}

export interface DesktopNewTaskSubmitResult {
  accepted: boolean;
  sessionId: string;
  snapshot: SessionSnapshot;
}

// Public session features that are safe to expose to the renderer. Keeping this
// list explicit prevents the desktop bridge from becoming arbitrary method
// execution while still making the TUI's existing session capabilities
// available to the GUI.
export const DESKTOP_CAPABILITIES = [
  'prioritizeQueued',
  'restoreQueued',
  'rewindToItem',
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
  'getRecapSettings',
  'setRecapEnabled',
  'getToolModuleSettings',
  'setWebSearchEnabled',
  'setMemoryToolsEnabled',
  'getVoiceStatus',
  'toggleVoice',
  'agentControl',
  'taskControl',
  'toolsStatus',
  'selectTools',
  'getSystemShell',
  'setSystemShell',
  'mcpStatus',
  'getMcpServerConfig',
  'reconnectMcp',
  'addMcpServer',
  'saveMcpServer',
  'removeMcpServer',
  'setMcpServerEnabled',
  'getDisabledSkills',
  'setDisabledSkills',
  'skillsStatus',
  'skillContent',
  'addSkill',
  'saveSkill',
  'reloadSkills',
  'pluginsStatus',
  'reloadPlugins',
  'addPlugin',
  'updatePlugin',
  'setPluginEnabled',
  'removePlugin',
  'enablePluginMcp',
  'hooksStatus',
  'contextStatus',
  'getTurnReviewDiff',
  'revertTurnReview',
  'revertTurnReviewFile',
  'addHookRule',
  'setHookRuleEnabled',
  'deleteHookRule',
  'memoryControl',
  'recall',
  'runDoctor',
  'compact',
  'listPresets',
  'setModel',
  'getWebSearchRoute',
  'listWebSearchModels',
  'setWebSearchRoute',
  'listAgents',
  'listWorkflows',
  'getOutputStyle',
  'listOutputStyles',
  'setOutputStyle',
  'setWorkflow',
  'listThemes',
  'getTheme',
  'setTheme',
  'transcribeAudio',
  'resizeImage',
  'setAgentRoute',
  'getWorkflowPack',
  'saveWorkflowPack',
  'createWorkflow',
  'deleteWorkflow',
  'getAgentDefinition',
  'saveAgentDefinition',
  'deleteAgentDefinition',
  'listProviders',
  'listProviderModels',
  'getProviderSetup',
  'getUsageDashboard',
  'consumeCodexRateLimitResetCredit',
  'getOnboardingStatus',
  'getOAuthProviderLoginStatus',
  'skipOnboarding',
  'completeOnboarding',
  'loginOAuthProvider',
  'beginOAuthProviderLogin',
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
  'setWebhookConfig',
  'saveSchedule',
  'deleteSchedule',
  'setScheduleEnabled',
  'runScheduleNow',
  'saveWebhook',
  'deleteWebhook',
  'setWebhookEnabled',
  // Media studio (image/video generation).
  'listMediaLanes',
  'listMediaAssets',
  'readMediaAsset',
  'cacheMediaThumbnail',
  'resolveMediaFile',
  'getMediaJob',
  'startMediaJob',
  'cancelMediaJob',
  'deleteMediaAsset',
  'openMediaAsset',
  'openMediaFolder',
  'clear',
] as const;

export type DesktopCapability = typeof DESKTOP_CAPABILITIES[number];

export const DESKTOP_READ_CAPABILITIES = [
  'getAutoClear',
  'getUpdateSettings',
  'getUpdateStatus',
  'getProfile',
  'getCompactionSettings',
  'getRecapSettings',
  'getToolModuleSettings',
  'getVoiceStatus',
  'toolsStatus',
  'getSystemShell',
  'mcpStatus',
  'getMcpServerConfig',
  'getDisabledSkills',
  'skillsStatus',
  'skillContent',
  'pluginsStatus',
  'hooksStatus',
  'contextStatus',
  'getTurnReviewDiff',
  'listPresets',
  'getWebSearchRoute',
  'listWebSearchModels',
  'listAgents',
  'listWorkflows',
  'getWorkflowPack',
  'getAgentDefinition',
  'getOutputStyle',
  'listOutputStyles',
  'listThemes',
  'getTheme',
  'listProviders',
  'listProviderModels',
  'getProviderSetup',
  'getUsageDashboard',
  'getOnboardingStatus',
  'getOAuthProviderLoginStatus',
  'getChannelSetup',
  'listMediaLanes',
  'listMediaAssets',
  'readMediaAsset',
  'resolveMediaFile',
  'getMediaJob',
] as const satisfies ReadonlyArray<DesktopCapability>;

export type DesktopReadCapability = typeof DESKTOP_READ_CAPABILITIES[number];

export interface DesktopCapabilityRequest {
  capability: DesktopCapability;
  args?: unknown[];
  /** The session the SURFACE that issued this command is painting. Focus
   *  decides nothing: a queue ×, /clear or /compact belongs to the session
   *  its own surface shows, not to whichever pane holds the caret. */
  sessionId?: string;
}

export interface DesktopCapabilityReadRequest {
  capability: DesktopReadCapability;
  args?: unknown[];
  sessionId?: string;
}

export type DesktopCapabilityReadResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface DesktopCapabilityResult<T = unknown> {
  value: T;
  snapshot: SessionSnapshot;
}

export type DesktopSettingKey = 'autoClear' | 'autoCompact' | 'keepAwake' | 'usagePinned' | 'computerControl';

export interface DesktopSettings {
  autoClear: boolean;
  autoCompact: boolean;
  /** Desktop-only: hold a power-save blocker while agents are working. */
  keepAwake: boolean;
  /** Activity-rail usage pin mode, shared by desktop and remote surfaces. */
  usagePinned: boolean;
  /** Opt-in: expose the agent `computer` tool that controls the local desktop
   *  (Windows). Default off — full-PC control is high risk. */
  computerControl: boolean;
}

/** Settings → Git: GitHub CLI presence and auth, probed through gh itself. */
export interface DesktopGithubCliStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  login?: string;
}

export type DesktopGithubCliLoginState = 'pending' | 'code' | 'success' | 'error';

/** One `gh auth login --web` device flow (Providers OAuth grammar): the
 *  renderer polls this while `pending`/`code` and stops on a terminal state. */
export interface DesktopGithubCliLoginFlow {
  flowId: string;
  state: DesktopGithubCliLoginState;
  /** The one-time device code, once gh prints it. */
  code?: string;
  /** Device-activation URL (github.com/login/device). */
  url?: string;
  message?: string;
  login?: string;
}

/** The signed-in GitHub account (gh api user); the identity source of truth
 *  for git's user.name/user.email. `email` falls back to the account's
 *  noreply address when no public email is set (the default). */
export interface DesktopGithubCliAccount {
  login: string;
  name: string;
  email: string;
}

export const DESKTOP_GIT_GLOBAL_CONFIG_KEYS = [
  'user.name',
  'user.email',
  'init.defaultBranch',
] as const;

export type DesktopGitGlobalConfigKey = typeof DESKTOP_GIT_GLOBAL_CONFIG_KEYS[number];

/** Settings → Git: the global git identity/defaults (`git config --global`). */
export interface DesktopGitGlobalConfig {
  name: string;
  email: string;
  defaultBranch: string;
}

export type DesktopGitCommitPreset = 'none' | 'conventional' | 'custom';

/** Settings → Git: desktop-stored commit-message preferences. */
export interface DesktopGitPreferences {
  commitPreset: DesktopGitCommitPreset;
  /** Legacy combined field retained for older desktop/daemon build skew. */
  commitTemplate: string;
  /** Custom commit shown as the Source Control ghost-text/preview. */
  commitExample: string;
  /** Custom natural-language instructions supplied to AI generation. */
  commitInstructions: string;
  /** Commit with an empty summary generates the message from the included
   *  changes on the maintenance model, then commits with that exact text. */
  autoCommitMessage: boolean;
}

export type DesktopSessionClassification = 'task' | 'project' | null;

/** Pairing card data for Settings → Connection (QRs pre-rendered as SVG in
 *  the main process so the renderer needs no QR dependency). */
export interface DesktopRemoteClientInfo {
  id: string;
  name: string;
  platform: string;
  browser: string;
  createdAt: number;
  lastSeenAt: number;
  online: boolean;
}

export interface DesktopRemoteAccessInfo {
  relayBrowserUrl: string;
  relayBrowserQrSvg: string;
  clients: DesktopRemoteClientInfo[];
}

/** An installed web app asking this desktop for access. It arrives with no
 *  credential — approving it here is what creates one. */
export interface DesktopRemoteClientClaim {
  claimId: string;
  clientId: string;
  name: string;
  platform: string;
  browser: string;
  expiresAt: number;
}

export interface DesktopSessionSummary {
  id: string;
  preview: string;
  title: string;
  updatedAt: number;
  /** User-visible conversation activity; unlike updatedAt, lifecycle-only
   *  resume/detach saves do not advance this timestamp. */
  activityAt?: number;
  /** User/assistant message count — the unread dot keys off GROWTH here, not
   *  updatedAt, so housekeeping saves never re-dot an already-checked session. */
  messageCount: number;
  cwd: string;
  classification: DesktopSessionClassification;
  projectPath: string | null;
  /** Fresh cross-process turn heartbeat; independent of which session is selected. */
  working?: boolean;
  /** Fresh heartbeat from this session's Lead, excluding child-agent work. */
  leadWorking?: boolean;
  /** Fresh heartbeat from a running child agent owned by this lead session. */
  agentWorking?: boolean;
  /** Archive: hidden from Recent, restorable; file stays on disk. */
  archived?: boolean;
  /** Automation origin: present on schedule/webhook runner sessions so the
   *  sidebar groups them under Automations instead of Recent. */
  sourceType?: 'schedule' | 'webhook';
  /** Schedule/webhook name — the Automations row label. */
  sourceName?: string;
  /** Automation delivery mode: 'channel'-only runs hide from Automations
   *  (they surface on the messaging channel; the session lands in Archived). */
  sourceDelivery?: 'app' | 'channel' | 'both';
  /** Last known route of this session. The catalog row is the FIRST-FRAME
   *  source for pane chrome: naming the model must not wait for a lane
   *  snapshot, a peek, or pane focus. */
  provider?: string;
  model?: string;
}

export interface DesktopProjectSummary {
  name: string;
  path: string;
  alias: string | null;
}

export interface DesktopWorkspaceFolder {
  path: string;
  name?: string;
}

export interface DesktopWorkspace {
  kind: 'empty' | 'folder' | 'workspace';
  name: string;
  workspaceFile?: string;
  folders: DesktopWorkspaceFolder[];
}

export interface DesktopEditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  wordWrap: 'off' | 'on' | 'wordWrapColumn' | 'bounded';
  wordWrapColumn: number;
  renderWhitespace: 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
  minimapEnabled: boolean;
  stickyScrollEnabled: boolean;
  bracketPairColorization: boolean;
  bracketPairGuides: boolean | 'active';
  inlayHintsEnabled: 'off' | 'on' | 'offUnlessPressed' | 'onUnlessPressed';
  formatOnSave: boolean;
  formatOnPaste: boolean;
  formatOnType: boolean;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
}

/** Dock Files tab: one directory level of a registered project. */
export interface DesktopDirEntry {
  name: string;
  dir: boolean;
}

/** Explorer pane: one directory level with Windows-Explorer metadata. */
export interface DesktopFolderEntry {
  name: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
}

/** Explorer pane sidebar: a known user folder or a mounted drive root. */
export interface DesktopFolderPlace {
  name: string;
  path: string;
  kind: 'home' | 'desktop' | 'downloads' | 'documents' | 'pictures' | 'music' | 'videos' | 'drive';
  /** Drive capacity (Explorer usage bar); omitted when unavailable. */
  totalBytes?: number;
  freeBytes?: number;
}

export type DesktopLspDocumentKind = 'open' | 'change' | 'save' | 'close';

export interface DesktopLspDocumentInput {
  kind: DesktopLspDocumentKind;
  projectPath: string;
  relPath: string;
  languageId: string;
  version: number;
  content?: string;
}

export interface DesktopLspCapabilities {
  completion: boolean;
  completionResolve: boolean;
  completionTriggerCharacters: string[];
  signatureHelp: boolean;
  signatureHelpTriggerCharacters: string[];
  signatureHelpRetriggerCharacters: string[];
  hover: boolean;
  declaration: boolean;
  definition: boolean;
  typeDefinition: boolean;
  implementation: boolean;
  references: boolean;
  documentHighlight: boolean;
  linkedEditingRange: boolean;
  documentSymbol: boolean;
  codeLens: boolean;
  codeLensResolve: boolean;
  rename: boolean;
  prepareRename: boolean;
  codeAction: boolean;
  codeActionResolve: boolean;
  codeActionKinds: string[];
  formatting: boolean;
  rangeFormatting: boolean;
  onTypeFormatting: boolean;
  onTypeFormattingTriggerCharacters: string[];
  documentLink: boolean;
  documentLinkResolve: boolean;
  documentColor: boolean;
  foldingRange: boolean;
  selectionRange: boolean;
  semanticTokens: boolean;
  semanticTokensRange: boolean;
  semanticTokensDelta: boolean;
  semanticTokensLegend: {
    tokenTypes: string[];
    tokenModifiers: string[];
  };
  inlayHint: boolean;
  inlayHintResolve: boolean;
  callHierarchy: boolean;
  /** LSP `workspace/symbol` — project-wide symbol search (Mixdog is
   *  project-scoped; "workspace" is wire-protocol naming only). */
  workspaceSymbol: boolean;
  executeCommand: boolean;
}

export interface DesktopLspServerState {
  available: boolean;
  status: 'unsupported' | 'starting' | 'ready' | 'missing' | 'error' | 'stopped';
  server: string;
  detail?: string;
  capabilities?: DesktopLspCapabilities;
}

export interface DesktopLspPosition {
  line: number;
  character: number;
}

export interface DesktopLspRange {
  start: DesktopLspPosition;
  end: DesktopLspPosition;
}

export interface DesktopLspDiagnostic {
  range: DesktopLspRange;
  severity?: number;
  code?: string | number | { value: string | number };
  source?: string;
  message: string;
  tags?: number[];
}

export interface DesktopLspDiagnosticEvent {
  projectPath: string;
  relPath: string;
  uri: string;
  server: string;
  diagnostics: DesktopLspDiagnostic[];
}

export interface DesktopLspStatusEvent extends DesktopLspServerState {
  projectPath: string;
  languageId: string;
  relPath?: string;
}

export const DESKTOP_LSP_REQUEST_METHODS = [
  'textDocument/completion',
  'completionItem/resolve',
  'textDocument/signatureHelp',
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/typeDefinition',
  'textDocument/declaration',
  'textDocument/implementation',
  'textDocument/references',
  'textDocument/documentHighlight',
  'textDocument/linkedEditingRange',
  'textDocument/documentSymbol',
  'textDocument/codeLens',
  'codeLens/resolve',
  'textDocument/prepareRename',
  'textDocument/rename',
  'textDocument/codeAction',
  'codeAction/resolve',
  'textDocument/formatting',
  'textDocument/rangeFormatting',
  'textDocument/onTypeFormatting',
  'textDocument/documentLink',
  'documentLink/resolve',
  'textDocument/documentColor',
  'textDocument/colorPresentation',
  'textDocument/foldingRange',
  'textDocument/selectionRange',
  'textDocument/semanticTokens/full',
  'textDocument/semanticTokens/full/delta',
  'textDocument/semanticTokens/range',
  'textDocument/inlayHint',
  'inlayHint/resolve',
  'textDocument/prepareCallHierarchy',
  'callHierarchy/incomingCalls',
  'callHierarchy/outgoingCalls',
  'workspace/symbol',
  'workspace/executeCommand',
] as const;

export type DesktopLspRequestMethod = typeof DESKTOP_LSP_REQUEST_METHODS[number];

export interface DesktopLspRequestInput {
  projectPath: string;
  relPath: string;
  languageId: string;
  method: DesktopLspRequestMethod;
  params?: Readonly<Record<string, unknown>>;
}

export interface DesktopLspRequestResult extends DesktopLspServerState {
  result?: unknown;
}

export interface DesktopWorkspaceTextWrite {
  relPath: string;
  content: string;
  expectedContent: string;
}

export type DesktopTextFileEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be';

export interface DesktopEditorBackup {
  content: string;
  expectedContent: string;
  updatedAt: number;
}

export interface DesktopRendererFailureDiagnostic {
  kind?: 'failure';
  phase: 'boundary' | 'window-error' | 'unhandled-rejection';
  errorName: string;
  fingerprint: string;
  failureCode?: string;
  components?: string[];
  source?: string;
  line?: number;
  column?: number;
}

export interface DesktopRendererLongTaskDiagnostic {
  kind: 'long-task';
  durationMs: number;
}

export interface DesktopRendererComposerActionDiagnostic {
  kind: 'composer-action';
  action: 'submit' | 'restore-queue';
  source: 'keyboard-enter' | 'form-submit' | 'slash-keyboard' | 'slash-click'
    | 'escape' | 'arrow-up' | 'queue-row';
  turnBusy: boolean;
  queueCount: number;
  draftLength: number;
  composing: boolean;
  uptimeMs: number;
  targeted?: boolean;
}

export type DesktopRendererDiagnostic =
  | DesktopRendererFailureDiagnostic
  | DesktopRendererLongTaskDiagnostic
  | DesktopRendererComposerActionDiagnostic;

export interface DesktopBootContext {
  bootId: string;
  processStartedAt: number;
  scenario?: string;
}

export interface DesktopGitFile {
  path: string;
  oldPath?: string;
  index: string;
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
  stagedAdditions: number;
  stagedDeletions: number;
  unstagedAdditions: number;
  unstagedDeletions: number;
  additions: number;
  deletions: number;
}

export interface DesktopGitStatus {
  repository: boolean;
  branch: string;
  detached: boolean;
  unborn: boolean;
  upstream: boolean;
  upstreamName: string;
  remote: boolean;
  /** Primary remote URL (origin preferred) for hosted-review/PR links. */
  remoteUrl?: string;
  ahead: number;
  behind: number;
  operation: "" | "merge" | "rebase" | "cherry-pick" | "revert";
  files: DesktopGitFile[];
}

export interface DesktopGitStatusOptions {
  /** Reuse the last accepted line totals when the status shape is unchanged. */
  reuseLineStats?: boolean;
}

export interface DesktopGitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string;
  /** Branch tip committer date (ISO-8601); absent when git omitted it. */
  lastCommitAt?: string;
  /** Branch tip age in git's relative grammar ("16 days ago"). */
  lastCommitRelative?: string;
  /** Commits this branch has that the current branch lacks, when computable. */
  ahead?: number;
  /** Commits the current branch has that this branch lacks, when computable. */
  behind?: number;
}

export interface DesktopGitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  when: string;
  author: string;
  authoredAt: string;
  pushed: boolean;
  parents: string[];
  refs: string[];
  /**
   * Decorations split per KIND so the history menu can tell a tag from a
   * branch. Optional: an older host still answers with `refs` only.
   */
  tags?: string[];
  branches?: string[];
  remotes?: string[];
}

/**
 * `.gitignore` rule shape: one repository-rooted literal path (`file`, the
 * default) or the unanchored `*<ext>` rule behind "Ignore all <ext> files".
 */
export type DesktopGitIgnoreScope = 'file' | 'extension';

export interface DesktopGitStashEntry {
  ref: string;
  message: string;
  when: string;
}

/** GitHub CLI-backed pull request rows. */
export interface DesktopPullRequestChecks {
  total: number;
  passing: number;
  failing: number;
  pending: number;
}

export interface DesktopPullRequestEntry {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  state: string;
  url: string;
  updatedAt: string;
  reviewDecision: string;
  checks: DesktopPullRequestChecks;
}

export interface DesktopPullRequestCreateInput {
  base: string;
  head: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export interface DesktopPullRequestCategory {
  key: string;
  label: string;
  prs: DesktopPullRequestEntry[];
}

export interface DesktopPullRequestFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface DesktopPullRequestTimelineItem {
  kind: 'comment' | 'review';
  author: string;
  body: string;
  state: string;
  createdAt: string;
}

export interface DesktopPullRequestReviewer {
  login: string;
  state: string;
}

export interface DesktopPullRequestDetail extends DesktopPullRequestEntry {
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: DesktopPullRequestFile[];
  mergeable: string;
  mergeStateStatus: string;
  createdAt: string;
  labels: string[];
  timeline: DesktopPullRequestTimelineItem[];
  reviewers: DesktopPullRequestReviewer[];
}

export interface DesktopGitCommitFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface DesktopGitCommitDetails {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  email: string;
  authoredAt: string;
  parents: string[];
  files: DesktopGitCommitFile[];
}

export interface DesktopWorkspaceTextSearchOptions {
  query: string;
  include?: string;
  exclude?: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  maxResults?: number;
}

export interface DesktopWorkspaceTextMatch {
  line: number;
  column: number;
  endColumn: number;
  preview: string;
  matchText: string;
}

export interface DesktopWorkspaceTextFileResult {
  relPath: string;
  matches: DesktopWorkspaceTextMatch[];
}

export interface DesktopWorkspaceTextSearchResult {
  files: DesktopWorkspaceTextFileResult[];
  matchCount: number;
  limitHit: boolean;
}

export interface DesktopWorkspaceTextReplaceResult {
  filesChanged: number;
  replacements: number;
  paths: string[];
}

export interface DesktopLocalPathEntry {
  absolutePath: string;
  name: string;
  dir: boolean;
  size: number;
  projectPath?: string;
  relPath?: string;
  accessToken?: string;
}

export interface DesktopLocalFileData {
  name: string;
  size: number;
  mimeType: string;
  data: string;
}

/** Small, last-writer-wins UI projection shared by Electron and paired web
 * clients. Pane geometry remains local; `selection` is the first visual pane. */
export interface DesktopApi {
  /** Immutable process timeline identity injected before renderer modules run. */
  readonly bootContext?: DesktopBootContext;
  chooseProject(): Promise<string | null>;
  chooseFile?(defaultPath?: string | null): Promise<{
    projectPath: string;
    relPath: string;
    accessToken?: string;
  } | null>;
  chooseFiles?(defaultPath?: string | null): Promise<DesktopLocalPathEntry[] | null>;
  chooseWorkspace?(): Promise<DesktopWorkspace | null>;
  saveWorkspace?(
    workspaceFile: string | null,
    folders: DesktopWorkspaceFolder[],
  ): Promise<DesktopWorkspace | null>;
  readEditorSettings?(
    projectPath: string,
    relPath: string,
    workspaceFile?: string,
  ): Promise<DesktopEditorSettings>;
  startProject(projectPath: string): Promise<SessionSnapshot>;
  startProjectTask(projectPath: string): Promise<SessionSnapshot>;
  startTask(): Promise<SessionSnapshot>;
  listProjects(): Promise<DesktopProjectSummary[]>;
  /** Register a folder without entering it (Projects page add dialog). */
  addProject(projectPath: string): Promise<void>;
  openProjectInExplorer(projectPath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Settings → About: gh-CLI star state for the mixdog repo. Desktop-only;
   *  the remote shim omits both and the Star button falls back to the repo
   *  link. */
  githubStarStatus?(): Promise<{ available: boolean; starred: boolean }>;
  starGithub?(): Promise<{ starred: boolean }>;
  /** Settings → Git: GitHub CLI status, guided install, and device-flow
   *  login/logout. Desktop-only; the remote shim omits the whole family. */
  githubCliStatus?(): Promise<DesktopGithubCliStatus>;
  installGithubCli?(): Promise<DesktopGithubCliStatus>;
  githubCliLoginStart?(): Promise<DesktopGithubCliLoginFlow>;
  githubCliLoginStatus?(flowId: string): Promise<DesktopGithubCliLoginFlow>;
  githubCliLoginCancel?(flowId: string): Promise<void>;
  githubCliLogout?(): Promise<DesktopGithubCliStatus>;
  githubCliAccount?(): Promise<DesktopGithubCliAccount>;
  /** Settings → Git: global git identity/defaults (`git config --global`). */
  gitGlobalConfig?(): Promise<DesktopGitGlobalConfig>;
  setGitGlobalConfig?(
    key: DesktopGitGlobalConfigKey,
    value: string,
  ): Promise<DesktopGitGlobalConfig>;
  /** Settings → Git: desktop-stored git preferences (commit template). */
  readGitPreferences?(): Promise<DesktopGitPreferences>;
  updateGitPreferences?(
    preferences: Partial<DesktopGitPreferences>,
  ): Promise<DesktopGitPreferences>;
  renameProject(projectPath: string, alias: string): Promise<void>;
  removeProject(projectPath: string): Promise<void>;
  /** Instructions editor (Projects page). `projectPath: null` targets the
   *  common instructions file (data/instructions.md → "# Common Instructions");
   *  a project path targets `<project>/.mixdog/instructions.md`
   *  ("# Project Instructions", injected at session start). Optional: the
   *  remote shim omits both and the UI hides the editor. */
  readInstructions?(projectPath: string | null): Promise<string>;
  writeInstructions?(projectPath: string | null, content: string): Promise<void>;
  /** Dock Files tab: lazy per-directory listing. */
  listProjectDir?(projectPath: string, relDir: string): Promise<DesktopDirEntry[]>;
  /** Editor tab: project file IO (traversal-guarded in main). */
  readProjectFile?(projectPath: string, relPath: string, accessToken?: string): Promise<{
    content: string;
    mtimeMs: number;
    binary: boolean;
    tooLarge: boolean;
    encoding: DesktopTextFileEncoding;
  }>;
  previewProjectFile?(projectPath: string, relPath: string, accessToken?: string): Promise<{
    url: string;
    kind: 'image' | 'pdf' | 'audio' | 'video';
    mime: string;
    mtimeMs: number;
    size: number;
  }>;
  writeProjectFile?(
    projectPath: string,
    relPath: string,
    content: string,
    expectedContent: string,
    accessToken?: string,
    encoding?: DesktopTextFileEncoding,
  ): Promise<{ mtimeMs: number }>;
  readEditorBackup?(projectPath: string, relPath: string, accessToken?: string): Promise<DesktopEditorBackup | null>;
  writeEditorBackup?(
    projectPath: string,
    relPath: string,
    content: string,
    expectedContent: string,
    accessToken?: string,
  ): Promise<DesktopEditorBackup>;
  deleteEditorBackup?(projectPath: string, relPath: string, accessToken?: string): Promise<void>;
  statProjectFile?(projectPath: string, relPath: string, accessToken?: string): Promise<{ mtimeMs: number; size: number }>;
  createProjectEntry?(projectPath: string, relDir: string, name: string, dir: boolean): Promise<void>;
  renameProjectEntry?(projectPath: string, relPath: string, newName: string): Promise<void>;
  trashProjectEntry?(projectPath: string, relPath: string): Promise<void>;
  /** Explorer DnD / cut-paste: move an entry into another project folder. */
  moveProjectEntry?(projectPath: string, relPath: string, targetDirRel: string): Promise<void>;
  /** Explorer copy-paste: copy an entry; collisions get "name copy" names. */
  copyProjectEntry?(projectPath: string, relPath: string, targetDirRel: string): Promise<{ name: string }>;
  /** Explorer pane (Windows-Explorer-style): absolute-path local filesystem
   *  surface with terminal-equivalent trust; mutations refuse overwrites. */
  chooseFolder?(): Promise<string | null>;
  listFolderDir?(dir: string): Promise<DesktopFolderEntry[]>;
  /** Creates with a collision-free name ("New folder (2)") and returns it. */
  createFolderEntry?(dir: string, name: string, isDir: boolean): Promise<{ name: string }>;
  renameFolderEntry?(path: string, newName: string): Promise<void>;
  /** 'ask' (default) reports { conflicts } without moving; 'replace' trashes
   *  the existing entries first, 'keepBoth' renames, 'skip' leaves them. */
  moveFolderEntry?(
    paths: string[],
    targetDir: string,
    strategy?: 'ask' | 'replace' | 'keepBoth' | 'skip',
  ): Promise<{ conflicts?: string[]; moved: Array<{ from: string; to: string }> }>;
  copyFolderEntry?(paths: string[], targetDir: string): Promise<{ created: string[] }>;
  trashFolderEntry?(path: string): Promise<void>;
  openFolderEntry?(path: string): Promise<void>;
  revealFolderEntry?(path: string): Promise<void>;
  folderPlaces?(): Promise<DesktopFolderPlace[]>;
  /** Native shell icon (or image thumbnail) for a path, as a data URL.
   *  `size` bounds the thumbnail edge (32-1024, default 96). */
  folderEntryIcon?(path: string, thumbnail?: boolean, size?: number): Promise<string>;
  /** Absolute path of an OS-native dropped File (webUtils.getPathForFile). */
  folderPathForFile?(file: File): string;
  /** Resolve trusted local paths for file-tab opening and internal drag/drop. */
  resolveLocalPaths?(paths: string[]): Promise<DesktopLocalPathEntry[]>;
  /** Read one local file for an existing attachment flow; capped in main. */
  readLocalFile?(path: string): Promise<DesktopLocalFileData>;
  /** Live refresh: watch a directory (refcounted) and stream change pings. */
  folderWatch?(dir: string, recursive?: boolean): Promise<void>;
  folderUnwatch?(dir: string, recursive?: boolean): Promise<void>;
  subscribeFolderChanges?(listener: (dir: string) => void): () => void;
  /** Monaco definition/reference/document-symbol providers via code_graph. */
  codeGraphQuery?(projectPath: string, mode: 'find_symbol' | 'references' | 'symbols', query: string): Promise<string>;
  /** Dynamic project language servers. Unsupported or missing servers quietly
   *  return unavailable so Monaco/code_graph remain the fallback. */
  lspDocument?(input: DesktopLspDocumentInput): Promise<DesktopLspServerState>;
  lspRequest?(input: DesktopLspRequestInput): Promise<DesktopLspRequestResult>;
  lspApplyWorkspaceEdit?(
    projectPath: string,
    writes: DesktopWorkspaceTextWrite[],
  ): Promise<void>;
  subscribeLspDiagnostics?(listener: (event: DesktopLspDiagnosticEvent) => void): () => void;
  subscribeLspStatus?(listener: (event: DesktopLspStatusEvent) => void): () => void;
  /** The relay refused an oversize frame this desktop sent and named no
   *  client. Surfaced to the user; it blames no call and reaches no phone. */
  subscribeRelayPayloadRefused?(
    listener: (detail: { bytes: number | null; limit: number | null }) => void,
  ): () => void;
  listSessions(): Promise<DesktopSessionSummary[]>;
  /** Push channel: fires with a fresh catalog whenever the on-disk session
   *  store changes (any mixdog process). Renderers fall back to their
   *  safety-net poll when the host does not provide it (remote shim). */
  subscribeSessions?(listener: (sessions: DesktopSessionSummary[]) => void): () => void;
  /** Event-driven process-global agent lifecycle pool. */
  listAgentPool?(): Promise<DesktopAgentPoolRow[]>;
  subscribeAgentPool?(listener: (agents: DesktopAgentPoolRow[]) => void): () => void;
  renameSession(sessionId: string, title: string): Promise<void>;
  setSessionArchived?(sessionId: string, archived: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<SessionSnapshot>;
  /** /inherit — copy this conversation into a NEW session id that runs on the
   *  supplied (currently selected) model. The source session is left as it is,
   *  so both transcripts continue from the same point. */
  inheritSession(
    sourceSessionId: string,
    route?: DesktopModelSelection | null,
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot | null }>;
  /** Settings → Connection: pairing QRs + URLs for the phone remote. Only
   *  the in-process desktop implements it (null while the bridge is off);
   *  the remote shim omits it — a phone never needs its own pairing card. */
  getRemoteAccessInfo?(): Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: revoke every paired phone by minting a new
   *  pairing token and restarting the bridge/relay legs. */
  rotateRemoteAccess?(): Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: revoke one browser while preserving every other
   *  browser's individual credential. */
  revokeRemoteAccessClient?(clientId: string): Promise<DesktopRemoteAccessInfo | null>;
  /** A web app with no credential is asking to connect. Only the in-process
   *  desktop implements these: the approval has to happen where the user is. */
  subscribeRemoteClientClaim?(
    listener: (claim: DesktopRemoteClientClaim) => void,
  ): () => void;
  listRemoteClientClaims?(): Promise<DesktopRemoteClientClaim[]>;
  resolveRemoteClientClaim?(claimId: string, approved: boolean): Promise<boolean>;
  prefetchSession?(sessionId: string, transcriptItemLimit?: number): Promise<boolean>;
  /** Register every visible session for owner-pipe mirroring. */
  setVisibleSessions?(sessionIds: string[]): Promise<boolean>;
  searchProjectFiles(projectIdOrWorkspaceId: string, query: string, limit?: number): Promise<string[]>;
  searchWorkspaceText?(
    projectPath: string,
    options: DesktopWorkspaceTextSearchOptions,
  ): Promise<DesktopWorkspaceTextSearchResult>;
  replaceWorkspaceText?(
    projectPath: string,
    options: DesktopWorkspaceTextSearchOptions,
    replacement: string,
    relPaths?: string[],
  ): Promise<DesktopWorkspaceTextReplaceResult>;
  getSnapshot(): Promise<SessionSnapshot>;
  subscribeState(listener: (snapshot: SessionSnapshot) => void): () => void;
  /** Fire-and-forget renderer perf timing line (MIXDOG_DESKTOP_PERF=1 only). */
  perfLog?(line: string): void;
  /** Privacy-bounded renderer failure/performance evidence; user content is never sent. */
  rendererDiagnostic?(diagnostic: DesktopRendererDiagnostic): void;
  /** First React commit signal — main defers window.show until it lands. */
  rendererReady?(): void;
  /** Dock terminal: create or reattach the shared PTY (main-process owned). */
  termEnsure?(id: string | null, cwd?: string | null, shell?: string | null):
    Promise<{ id: string; replay: string }>;
  termWrite?(id: string, data: string): void;
  termResize?(id: string, cols: number, rows: number): void;
  termAcknowledge?(id: string, charCount: number): void;
  termDispose?(id: string): Promise<void>;
  subscribeTermData?(listener: (event: { id: string; data: string }) => void): () => void;
  /** Shells detected on this machine for the terminal strip's picker. */
  termProfiles?(): Promise<Array<{ id: string; label: string; path: string; default?: boolean }>>;
  /** Dock Git panel: plain git CLI over the active project directory. */
  gitStatus?(cwd: string, options?: DesktopGitStatusOptions): Promise<DesktopGitStatus>;
  gitBranches?(cwd: string): Promise<DesktopGitBranch[]>;
  gitCheckoutBranch?(cwd: string, branch: string, remote?: boolean): Promise<string>;
  gitCreateBranch?(cwd: string, branch: string): Promise<string>;
  gitRenameBranch?(cwd: string, branch: string, nextBranch: string): Promise<string>;
  gitDeleteBranch?(cwd: string, branch: string): Promise<string>;
  /** Merge `branch` into the checked-out branch; conflicts reject with detail. */
  gitMergeBranch?(cwd: string, branch: string): Promise<string>;
  gitDiff?(cwd: string, path: string, staged?: boolean, worktreeOnly?: boolean, untracked?: boolean): Promise<string>;
  gitApplyPatch?(cwd: string, path: string, patch: string, reverse?: boolean): Promise<void>;
  gitStage?(cwd: string, paths: string[]): Promise<void>;
  gitUnstage?(cwd: string, paths: string[]): Promise<void>;
  /**
   * `scope: 'extension'` writes the unanchored `*<ext>` rule derived from the
   * path's own extension; omitted/`'file'` keeps the rooted literal path.
   */
  gitIgnore?(cwd: string, path: string, scope?: DesktopGitIgnoreScope): Promise<void>;
  gitCommit?(cwd: string, message: string): Promise<string>;
  /**
   * Commit only `paths` (`git commit -m <message> -- <paths>`): every other
   * index entry survives untouched and each listed path commits its worktree
   * content, so the caller never stages or unstages around a commit.
   */
  gitCommitPaths?(cwd: string, message: string, paths: string[]): Promise<string>;
  /** Settings → Git auto commit message: one-shot maintenance-model
   *  completion over the included files' diffs; never touches git itself. */
  gitGenerateCommitMessage?(
    cwd: string,
    files: Array<{ path: string; untracked?: boolean }>,
  ): Promise<{ message: string }>;
  gitAmend?(cwd: string, message?: string): Promise<string>;
  gitUndoLastCommit?(cwd: string): Promise<string>;
  gitStash?(cwd: string, message?: string): Promise<string>;
  gitStashPop?(cwd: string): Promise<string>;
  gitStashList?(cwd: string): Promise<DesktopGitStashEntry[]>;
  gitStashApply?(cwd: string, ref: string): Promise<string>;
  gitStashDrop?(cwd: string, ref: string): Promise<string>;
  ghPrList?(cwd: string): Promise<DesktopPullRequestCategory[]>;
  ghPrDefaultBranch?(cwd: string): Promise<string>;
  ghPrCreate?(cwd: string, input: DesktopPullRequestCreateInput): Promise<DesktopPullRequestEntry>;
  ghPrView?(cwd: string, number: number): Promise<DesktopPullRequestDetail>;
  ghPrCheckout?(cwd: string, number: number): Promise<string>;
  ghPrMerge?(cwd: string, number: number, method: 'merge' | 'squash' | 'rebase'): Promise<string>;
  ghPrDiff?(cwd: string, number: number): Promise<string>;
  gitPush?(cwd: string): Promise<string>;
  gitFetch?(cwd: string): Promise<string>;
  gitPull?(cwd: string): Promise<string>;
  gitSync?(cwd: string): Promise<string>;
  gitContinue?(cwd: string): Promise<string>;
  gitAbortOperation?(cwd: string): Promise<string>;
  gitRevert?(cwd: string, path: string, untracked: boolean, mode?: 'worktree' | 'all'): Promise<void>;
  gitLog?(cwd: string, query?: string, skip?: number, limit?: number): Promise<DesktopGitLogEntry[]>;
  gitShow?(cwd: string, hash: string): Promise<DesktopGitCommitDetails>;
  gitShowDiff?(cwd: string, hash: string, path: string): Promise<string>;
  /** Diff tab editor mode: file content at `HEAD`/`:0`/commit (null if absent). */
  gitShowFile?(cwd: string, rev: string, path: string): Promise<string | null>;
  /**
   * History context menu, gated narrowly: only
   * cherry-pick refuses on top of a live operation or a dirty worktree
   * (naming the files), checkout/branch carry safe local changes across, and
   * revert is left to git. A conflicted cherry-pick/revert stays resolvable
   * through `gitContinue`/`gitAbortOperation`.
   *
   * `--hard` reset refuses a dirty worktree outright. `--mixed` reset rewrites
   * the index — staged work becomes unstaged — so it REPORTS a dirty worktree
   * (message naming the files, `code: 'git-reset-dirty-worktree'`) instead of
   * doing it silently; pass `confirmedDirty` once the user has confirmed.
   */
  gitResetToCommit?(
    cwd: string,
    hash: string,
    mode: 'soft' | 'mixed' | 'hard',
    confirmedDirty?: boolean,
  ): Promise<string>;
  gitRevertCommit?(cwd: string, hash: string): Promise<string>;
  gitCherryPickCommit?(cwd: string, hash: string): Promise<string>;
  gitCreateTag?(cwd: string, tag: string, hash: string): Promise<string>;
  gitDeleteTag?(cwd: string, tag: string): Promise<string>;
  /** Check out `hash` itself: a detached HEAD. */
  gitCheckoutCommit?(cwd: string, hash: string): Promise<string>;
  gitCreateBranchAtCommit?(cwd: string, branch: string, hash: string): Promise<string>;
  /** Review pane: cumulative diff of the working tree vs merge-base(origin default branch, HEAD). */
  gitReview?(cwd: string): Promise<{ base: string; files: Array<{ path: string; status: string; additions: number; deletions: number; untracked: boolean; uncommitted: boolean }> }>;
  gitReviewDiff?(cwd: string, path: string, untracked?: boolean): Promise<string>;
  /** Review file context menu: OS-level reveal/open for a project-relative file. */
  revealFile?(cwd: string, path: string, accessToken?: string): Promise<void>;
  openFilePath?(cwd: string, path: string, accessToken?: string): Promise<void>;
  /** Transcript attachment chip: hand a submitted image to the OS viewer. The
   *  renderer holds those bytes only as a session-lifetime preview data URL, so
   *  they travel here and the main process owns the temp file. */
  openAttachmentImage?(dataUrl: string, name?: string): Promise<void>;
  getUpdaterState(): Promise<DesktopUpdaterState>;
  subscribeUpdaterState(listener: (state: DesktopUpdaterState) => void): () => void;
  checkForDesktopUpdate(): Promise<DesktopUpdaterState>;
  showDesktopUpdate(): Promise<DesktopUpdaterState>;
  /** Atomically materialize a renderer-only draft and accept its first prompt. */
  submitNewTask(
    prompt: DesktopPromptContent,
    options?: DesktopSubmitOptions,
    draft?: DesktopNewTaskDraft,
  ): Promise<DesktopNewTaskSubmitResult>;
  /** Split panes: prompt/abort/approvals addressed to any pooled live
   *  session (active or parked), keyed by sessionId. */
  submitToSession(
    sessionId: string,
    prompt: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ): Promise<boolean>;
  abortSession(sessionId: string, options?: DesktopAbortOptions): Promise<unknown>;
  resolveToolApprovalForSession(
    sessionId: string,
    id: string,
    decision: ToolApprovalDecision,
  ): Promise<boolean>;
  /** Per-session live snapshot lane covering every pooled session runtime. */
  subscribeSessionState(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  listProviderModels(options?: DesktopModelCatalogOptions): Promise<DesktopModelOption[]>;
  /** sessionId addresses a pane. Omitted routes through the control session
   *  for settings that are not owned by a conversation. */
  setModelRoute(selection: DesktopModelSelection, sessionId?: string): Promise<SessionSnapshot>;
  setFast(enabled: boolean, sessionId?: string): Promise<SessionSnapshot>;
  readSettings(): Promise<DesktopSettings>;
  updateSetting(key: DesktopSettingKey, enabled: boolean): Promise<DesktopSettings>;
  getZoomFactor(): Promise<number>;
  setZoomFactor(factor: number): Promise<number>;
  onZoomFactorChanged(listener: (factor: number) => void): () => void;
  /** Agent browser bridge (desktop host only): a `browser` tool call arrived
   *  while no in-app browser webview was live; present a browser surface. */
  onBrowserOpenRequested?(listener: () => void): () => void;
  /** systemPreference keeps DWM on 'system' so OS theme tracking survives. */
  applyTitleBarTheme(theme: string, systemPreference?: boolean): Promise<void>;
  /** Scrim-composited WCO caption colors while a fullscreen modal is open;
   *  null restores the theme band. */
  setTitleBarDim(dim: { color: string; symbolColor: string } | null): Promise<void>;
  invokeCapability<T = unknown>(request: DesktopCapabilityRequest): Promise<DesktopCapabilityResult<T>>;
  readCapabilities(requests: DesktopCapabilityReadRequest[]): Promise<DesktopCapabilityReadResult[]>;
  /** Direct URL for one media asset/rendition, or '' when this host has no
   *  media transport. Gallery bytes ride THIS url (cacheable, range-able),
   *  never the RPC lane. */
  mediaUrl?(assetId: string, variant?: string): string;
  quit(): Promise<void>;
}
