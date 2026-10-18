// Session capability names the renderer may invoke and their request/result shapes.
import type { SessionSnapshot } from './contract-session';
import { DESKTOP_IMPORT_CAPABILITIES, DESKTOP_IMPORT_READ_CAPABILITIES } from './contract-import';
import { DESKTOP_WORKTREE_CAPABILITIES, DESKTOP_WORKTREE_READ_CAPABILITIES } from './contract-worktree';

// Public session features that are safe to expose to the renderer. Keeping this
// list explicit prevents the desktop bridge from becoming arbitrary method
// execution while still making the TUI's existing session capabilities
// available to the GUI.
export const DESKTOP_CAPABILITIES = [
  'prioritizeQueued',
  'restoreQueued',
  'rewindToItem',
  'retryFailedTurn',
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
  'getSessionTitleSettings',
  'setAiSessionTitles',
  'getToolModuleSettings',
  'setWebSearchEnabled',
  'setInstructionFiles',
  'setMemoryToolsEnabled',
  'getDeveloperSettings',
  'setDeveloperOption',
  'setBuiltinToolEnabled',
  'installBuiltinFeature',
  'getTidyEngineStatus',
  'getTidyInstallStatus',
  'installLocalProviderModel',
  'startLocalProviderInstallation',
  'cancelLocalProviderInstallation',
  'discardLocalProviderInstallation',
  'setLocalProviderIdleTtl',
  'setLocalProviderContext',
  'getLocalProviderModelDetails',
  'startLocalProviderModelMaintenance',
  'deleteLocalProviderModel',
  'getVoiceStatus',
  'toggleVoice',
  'claimSetupRequest',
  'isSetupRequestActive',
  'completeSetupRequest',
  'agentControl',
  'taskControl',
  'goalControl',
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
  'beginMcpOAuthLogin',
  'getMcpOAuthLoginStatus',
  'cancelMcpOAuthLogin',
  'completeMcpOAuthLogin',
  'signOutMcpServer',
  'probeMcpServerAuth',
  'getDisabledSkills',
  'setDisabledSkills',
  'setExtensionScope',
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
  'contextStatus',
  'inheritancePreflight',
  'getSessionReviewDiff',
  'getSessionReviewFilePatch',
  'getTurnReviewDiff',
  'getTurnReviewFilePatch',
  'revertTurnReview',
  'revertTurnReviewFile',
  'getTurnChanges',
  'revertTurnChanges',
  'reapplyTurnChanges',
  'clearSessionChangeHistory',
  'memoryControl',
  'recall',
  'runDoctor',
  'compact',
  // /btw: `askSide(question)` answers `{ text }` from the conversation while a
  // turn keeps running (never written to the transcript); `cancelSide()` aborts it.
  'askSide',
  'cancelSide',
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
  'getOrchestrationMode',
  'setOrchestrationMode',
  'listThemes',
  'getTheme',
  'setTheme',
  'transcribeAudio',
  'prepareTranscription',
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
  'getProviderAccounts',
  'updateProviderAccounts',
  'getUsageDashboard',
  'getUsageStats',
  'getQuotaHistory',
  'getSessionUsage',
  'consumeCodexRateLimitResetCredit',
  'getOnboardingStatus',
  'getOAuthProviderLoginStatus',
  'skipOnboarding',
  'completeOnboarding',
  'saveStarterGuideState',
  'loginOAuthProvider',
  'beginOAuthProviderLogin',
  'completeOAuthProviderLogin',
  'cancelOAuthProviderLogin',
  'saveProviderApiKey',
  'saveCustomProvider',
  'removeCustomProvider',
  'updateCustomProviderModel',
  'setModelPreferences',
  'testCustomProvider',
  'checkCustomProviderKeyEnv',
  'discoverCustomProviderModels',
  'saveOpenAIUsageSessionKey',
  'authenticateProvider',
  'forgetProviderAuth',
  'getChannelSetup',
  'setWebhookConfig',
  'saveSchedule',
  'deleteSchedule',
  'setScheduleEnabled',
  'runScheduleNow',
  'testWebhook',
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
  'getMediaDefault',
  'setMediaDefault',
  'getMediaPins',
  'setMediaPin',
  'startMediaJob',
  'cancelMediaJob',
  'deleteMediaAsset',
  'deleteMediaAssets',
  'openMediaAsset',
  'openMediaFolder',
  // Lead worktrees (contract-worktree.ts).
  ...DESKTOP_WORKTREE_CAPABILITIES,
  // Import conversations from other apps (contract-import.ts).
  ...DESKTOP_IMPORT_CAPABILITIES,
  'clear',
] as const;

export type DesktopCapability = (typeof DESKTOP_CAPABILITIES)[number];

export const DESKTOP_READ_CAPABILITIES = [
  'isSetupRequestActive',
  'getLocalProviderModelDetails',
  'getAutoClear',
  'getUpdateSettings',
  'getUpdateStatus',
  'getProfile',
  'getCompactionSettings',
  'getRecapSettings',
  'getSessionTitleSettings',
  'getToolModuleSettings',
  'getDeveloperSettings',
  'getTidyEngineStatus',
  'getTidyInstallStatus',
  'getVoiceStatus',
  'toolsStatus',
  'getSystemShell',
  'mcpStatus',
  'getMcpServerConfig',
  'getMcpOAuthLoginStatus',
  'getDisabledSkills',
  'skillsStatus',
  'skillContent',
  'pluginsStatus',
  'contextStatus',
  'inheritancePreflight',
  'getSessionReviewDiff',
  'getSessionReviewFilePatch',
  'getTurnReviewDiff',
  'getTurnReviewFilePatch',
  'getTurnChanges',
  'listPresets',
  'getWebSearchRoute',
  'listWebSearchModels',
  'listAgents',
  'listWorkflows',
  'getWorkflowPack',
  'getOrchestrationMode',
  'getAgentDefinition',
  'getOutputStyle',
  'listOutputStyles',
  'listThemes',
  'getTheme',
  'listProviders',
  'listProviderModels',
  'getProviderSetup',
  'getUsageDashboard',
  'getUsageStats',
  'getQuotaHistory',
  'getSessionUsage',
  'getProviderAccounts',
  'getOnboardingStatus',
  'getOAuthProviderLoginStatus',
  'getChannelSetup',
  'listMediaLanes',
  'listMediaAssets',
  'readMediaAsset',
  'resolveMediaFile',
  'getMediaJob',
  'getMediaDefault',
  'getMediaPins',
  ...DESKTOP_WORKTREE_READ_CAPABILITIES,
  ...DESKTOP_IMPORT_READ_CAPABILITIES,
] as const satisfies ReadonlyArray<DesktopCapability>;

export type DesktopReadCapability = (typeof DESKTOP_READ_CAPABILITIES)[number];

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

export type DesktopCapabilityReadResult = { ok: true; value: unknown } | { ok: false; error: string };

/** One recorded file of a turn's changes. */
export interface TurnChangesFile {
  /** Root-relative, forward slashes. */
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
  additions: number;
  deletions: number;
  binary?: boolean;
  state: 'applied' | 'reverted';
  revertable: boolean;
  /** Why the file is not revertable. */
  reason?: string;
  /** Its replay/preview patch was dropped for size (byte-budget eviction or an oversized single turn). */
  patchOmitted?: true;
  /** The record kept no line counts for it (an old outside-root edit). */
  unmeasured?: true;
}

/**
 * The reply of `getTurnChanges` (`[{ checkpointId, patch?, file? }]`),
 * `revertTurnChanges` and `reapplyTurnChanges`
 * (`[checkpointId, file | null, revision]`).
 */
export interface TurnChangesReply {
  /** pending = turn still finalizing; none = changed nothing; missing = no record (evicted/unknown). */
  status: 'ready' | 'pending' | 'none' | 'missing';
  checkpointId: string;
  revision: number;
  /** Absolute recorded root. */
  root: string;
  files: TurnChangesFile[];
  /** Only when `patch: true`; only that file's patch when `file` is given. */
  patch?: string;
  /** Some file applied and every applied file revertable. */
  canUndo: boolean;
  /** Some file reverted. */
  canReapply: boolean;
  /** Why canUndo is false when files exist. */
  reason?: string;
}

export interface DesktopCapabilityResult<T = unknown> {
  value: T;
  snapshot: SessionSnapshot;
}
