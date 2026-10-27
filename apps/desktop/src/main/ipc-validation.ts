import { isAbsolute as pathIsAbsolute, resolve as resolvePath } from 'node:path';

import {
  DESKTOP_CAPABILITIES,
  DESKTOP_GIT_GLOBAL_CONFIG_KEYS,
  DESKTOP_LSP_REQUEST_METHODS,
  DESKTOP_READ_CAPABILITIES,
  NOTIFICATION_VOLUME_MAX,
  type DesktopAbortOptions,
  type DesktopCapability,
  type DesktopCapabilityReadRequest,
  type DesktopCapabilityRequest,
  type DesktopGitGlobalConfigKey,
  type DesktopLspDocumentInput,
  type DesktopLspRequestInput,
  type DesktopLspRequestMethod,
  type DesktopModelCatalogOptions,
  type DesktopModelSelection,
  type DesktopNewTaskDraft,
  type DesktopPromptContent,
  type DesktopSettingKey,
  type DesktopSubmitOptions,
  type DesktopTextFileEncoding,
  type DesktopWorkspaceFolder,
  type DesktopWorkspaceTextWrite,
  type ToolApprovalDecision,
} from '../shared/contract';
import {
  type ConversationNotificationSetting,
  NOTIFICATION_EVENTS,
  type NotificationPreferencesPatch,
  type NotificationTarget,
} from '../shared/contract-notifications';
import {
  canonicalPromptFileMimeType,
  MAX_PROMPT_FILE_BASE64_LENGTH,
  MAX_PROMPT_FILE_BASE64_TOTAL,
  MAX_PROMPT_FILE_MIME_LENGTH,
  MAX_PROMPT_FILES,
  MAX_PROMPT_IMAGE_BASE64_LENGTH,
  MAX_PROMPT_IMAGE_BASE64_TOTAL,
  PROMPT_IMAGE_MIME_PATTERN,
  MAX_PROMPT_IMAGES,
} from '../shared/prompt-limits';
import {
  type DesktopVisualizeTabCommand,
  MAX_VISUALIZE_INLINE_BYTES,
  VISUALIZE_INLINE_KINDS,
  type VisualizeInlineContent,
} from '../shared/visualize';
import {
  DESKTOP_PET_COMMANDS,
  DESKTOP_PET_MAX_LAYERS,
  DESKTOP_PET_MAX_TEXT,
  DESKTOP_PET_OPTIONS,
  DESKTOP_PET_REPLY_MAX,
  DESKTOP_PET_SCALES,
  DESKTOP_PET_THEME_VARS,
  type DesktopPetBubble,
  type DesktopPetCommand,
  type DesktopPetComposer,
  type DesktopPetDrag,
  type DesktopPetLayers,
  type DesktopPetOption,
  type DesktopPetRect,
  type DesktopPetState,
  type DesktopPetTheme,
} from '../shared/desktop-pet';
import { HEARTBEAT_INTERVAL_CHOICES } from '../../../../src/runtime/shared/heartbeat-interval.mjs';
import { requiredSessionId, requiredSessionIds } from './desktop-state';
import { hasControlCharacter } from './ipc-control-chars';
import { isWorktreeCapability, validateWorktreeCapabilityArgs, WORKTREE_CAPABILITY_ARITY } from './worktree-validation';
import { IMPORT_CAPABILITY_ARITY, isImportCapability, validateImportCapabilityArgs } from './import-validation';

const visualizeVersionNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000_000) {
    throw new TypeError('visualize version must be a positive integer.');
  }
  return value;
};

/** The renderer's visualize tab click/close/version step:
 *  `{ sessionId, tabId, action, version?, compare? }`. */
export function requiredVisualizeTabCommand(value: unknown): DesktopVisualizeTabCommand {
  const command = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const action = command.action;
  if (
    action !== 'activate' &&
    action !== 'close' &&
    action !== 'version' &&
    action !== 'restore' &&
    action !== 'network' &&
    action !== 'reopen' &&
    action !== 'render' &&
    action !== 'blocked' &&
    action !== 'history' &&
    action !== 'export' &&
    action !== 'thumbnail'
  ) {
    throw new TypeError(
      'visualize command action must be activate, close, version, restore, network, reopen, render, blocked, history, export, or thumbnail.'
    );
  }
  if (action === 'history') {
    return {
      sessionId: requiredSessionId(command.sessionId),
      tabId: '',
      action,
      entry: requiredString(command.entry, 'visualize history entry', 64),
    };
  }
  const base = {
    sessionId: requiredSessionId(command.sessionId),
    tabId: requiredString(command.tabId, 'visualize tab id', 64),
  };
  if (action === 'export') return visualizeExportCommand(base, command);
  if (action === 'reopen') return visualizeReopenCommand(base, command);
  if (action === 'network') {
    if (typeof command.allow !== 'boolean') throw new TypeError('visualize network allow must be a boolean.');
    return { ...base, action, allow: command.allow };
  }
  if (action === 'version') return visualizeVersionCommand(base, command);
  if (action === 'render') return visualizeRenderCommand(base, command);
  if (action === 'blocked') return visualizeBlockedCommand(base, command);
  if (action === 'restore') return visualizeRestoreCommand(base, command);
  if (action === 'thumbnail') {
    const { version } = command;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > 1_000_000) {
      throw new TypeError('visualize thumbnail version is invalid.');
    }
    return { ...base, action, version };
  }
  return { ...base, action };
}

type VisualizeCommandInput = Record<string, unknown>;
type VisualizeTabBase = { sessionId: string; tabId: string };

const isVisualizePaneIndex = (pane: unknown): pane is number =>
  typeof pane === 'number' && Number.isInteger(pane) && pane >= 0 && pane <= 15;

function visualizeExportCommand(base: VisualizeTabBase, command: VisualizeCommandInput): DesktopVisualizeTabCommand {
  const { format, pane } = command;
  if (format !== 'png' && format !== 'pdf' && format !== 'project') {
    throw new TypeError('visualize export format must be png, pdf, or project.');
  }
  if (pane !== undefined && !isVisualizePaneIndex(pane)) {
    throw new TypeError('visualize pane index is invalid.');
  }
  return { ...base, action: 'export', format, ...(pane !== undefined ? { pane } : {}) };
}

/** A closed tab's file targets, from its chat card: 1-3 paths, never URLs;
 *  or the inline content it showed (fully validated again by the open). */
function visualizeReopenCommand(base: VisualizeTabBase, command: VisualizeCommandInput): DesktopVisualizeTabCommand {
  const label = typeof command.label === 'string' && command.label ? { label: command.label } : {};
  const content = command.content;
  if (content !== undefined) {
    const item = content && typeof content === 'object' ? (content as Record<string, unknown>) : {};
    if (
      !VISUALIZE_INLINE_KINDS.some((kind) => kind === item.kind) ||
      typeof item.source !== 'string' ||
      item.source.length > MAX_VISUALIZE_INLINE_BYTES ||
      (item.title !== undefined && (typeof item.title !== 'string' || item.title.length > 120)) ||
      (command.label !== undefined && (typeof command.label !== 'string' || command.label.length > 120))
    ) {
      throw new TypeError('visualize reopen content is invalid.');
    }
    return {
      ...base,
      action: 'reopen',
      targets: [],
      content: {
        kind: item.kind as VisualizeInlineContent['kind'],
        source: item.source,
        ...(typeof item.title === 'string' && item.title ? { title: item.title } : {}),
      },
      ...label,
    };
  }
  const targets = command.targets;
  if (
    !Array.isArray(targets) ||
    targets.length < 1 ||
    targets.length > 3 ||
    targets.some(
      (target) =>
        typeof target !== 'string' || !target.trim() || target.length > 4096 || /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
    )
  ) {
    throw new TypeError('visualize reopen targets must be 1-3 file paths.');
  }
  if (command.label !== undefined && (typeof command.label !== 'string' || command.label.length > 120)) {
    throw new TypeError('visualize reopen label is invalid.');
  }
  return { ...base, action: 'reopen', targets: [...targets], ...label };
}

function visualizeVersionCommand(base: VisualizeTabBase, command: VisualizeCommandInput): DesktopVisualizeTabCommand {
  if (command.compare !== undefined && typeof command.compare !== 'boolean') {
    throw new TypeError('visualize compare must be a boolean.');
  }
  return {
    ...base,
    action: 'version',
    version: command.version === null ? null : visualizeVersionNumber(command.version),
    ...(command.compare === true ? { compare: true } : {}),
  };
}

/** An inline pane's render result; a failure carries its (clipped) error. */
function visualizeRenderCommand(base: VisualizeTabBase, command: VisualizeCommandInput): DesktopVisualizeTabCommand {
  const { pane, error } = command;
  if (!isVisualizePaneIndex(pane)) {
    throw new TypeError('visualize pane index is invalid.');
  }
  if (error !== undefined && typeof error !== 'string') throw new TypeError('visualize render error must be text.');
  return {
    ...base,
    action: 'render',
    pane,
    renderId: requiredString(command.renderId, 'visualize render id', 128),
    ...(error ? { error: error.slice(0, 4000) } : {}),
  };
}

/** A refused outside request of a remote page frame: the address and the kind of request. */
function visualizeBlockedCommand(base: VisualizeTabBase, command: VisualizeCommandInput): DesktopVisualizeTabCommand {
  const { pane, resource } = command;
  if (!isVisualizePaneIndex(pane)) throw new TypeError('visualize pane index is invalid.');
  if (typeof resource !== 'string' || !/^[A-Za-z]{1,24}$/.test(resource)) {
    throw new TypeError('visualize blocked resource is invalid.');
  }
  return {
    ...base,
    action: 'blocked',
    pane,
    url: requiredString(command.url, 'visualize blocked url', 2048),
    resource,
  };
}

/** The page assets the user confirmed the restore may also overwrite. */
function visualizeRestoreCommand(base: VisualizeTabBase, command: VisualizeCommandInput): DesktopVisualizeTabCommand {
  const assets = command.assets;
  if (
    assets !== undefined &&
    (!Array.isArray(assets) ||
      assets.length > 64 ||
      assets.some((rel) => typeof rel !== 'string' || !rel || rel.length > 1024))
  ) {
    throw new TypeError('visualize restore assets must be a list of file paths.');
  }
  return {
    ...base,
    action: 'restore',
    version: visualizeVersionNumber(command.version),
    ...(Array.isArray(assets) && assets.length ? { assets: [...assets] } : {}),
  };
}

/** The pane a `data-choice` pick came from: `{ sessionId, tabId, pane }`. */
export function requiredVisualizeGestureTarget(value: unknown): { sessionId: string; tabId: string; pane: number } {
  const target = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const { sessionId, tabId } = requiredVisualizeTabCommand({ ...target, action: 'activate' });
  const pane = target.pane;
  if (!isVisualizePaneIndex(pane)) {
    throw new TypeError('visualize pane index is invalid.');
  }
  return { sessionId, tabId, pane };
}

/** A visualize pin's crop area: `{ x, y, width, height }` in window CSS px. */
export function requiredVisualizeCaptureRect(value: unknown): { x: number; y: number; width: number; height: number } {
  const rect = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const coordinate = (key: 'x' | 'y' | 'width' | 'height', min: number): number => {
    const number = rect[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > 100_000) {
      throw new TypeError(`visualize capture ${key} is invalid.`);
    }
    return number;
  };
  return {
    x: coordinate('x', 0),
    y: coordinate('y', 0),
    width: coordinate('width', 1),
    height: coordinate('height', 1),
  };
}

/** The visualize panel's content size: `{ width, height }` in CSS px. */
export function requiredVisualizePanelSize(value: unknown): { width: number; height: number } {
  const size = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const side = (key: 'width' | 'height'): number => {
    const number = size[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 1 || number > 100_000) {
      throw new TypeError(`visualize panel ${key} is invalid.`);
    }
    return Math.round(number);
  };
  return { width: side('width'), height: side('height') };
}

const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_STRUCTURED_STRING_TOTAL = 32_000_000;

const CAPABILITY_SET = new Set<string>(DESKTOP_CAPABILITIES);
const READ_CAPABILITY_SET = new Set<string>(DESKTOP_READ_CAPABILITIES);
const BOOLEAN_FIRST_CAPABILITIES = new Set<DesktopCapability>([
  'setAutoUpdate',
  'setRecapEnabled',
  'setAiSessionTitles',
  'setCacheWarmingEnabled',
  'setHeartbeatEnabled',
  'setReactionsEnabled',
  'setWebSearchEnabled',
  'setMemoryToolsEnabled',
  'toggleVoice',
]);
const BOOLEAN_SECOND_CAPABILITIES = new Set<DesktopCapability>([
  'setMcpServerEnabled',
  'setPluginEnabled',
  'setScheduleEnabled',
  'setWebhookEnabled',
  'setBuiltinToolEnabled',
  'setDeveloperOption',
]);
const SUBMIT_OPTION_KEYS = new Set([
  'id',
  'submittedAt',
  'displayText',
  'goalCommand',
  'retryFailedTurn',
  'priority',
  'pastedImages',
  'pastedTexts',
  'kickoff',
]);
const ABORT_OPTION_KEYS = new Set(['restorePrompt', 'submissionId']);
const NEW_TASK_DRAFT_KEYS = new Set(['projectPath', 'route', 'workflowId', 'orchestrationMode', 'worktree']);
const CAPABILITY_REQUEST_KEYS = new Set(['capability', 'args', 'sessionId']);
const MODEL_SELECTION_KEYS = new Set([
  'provider',
  'model',
  'effort',
  'fast',
  'autoEffort',
  'modelParameters',
  'contextPercent',
  'contextTokens',
  'fallbacks',
  'onlyIfEmpty',
]);
const MODEL_CATALOG_OPTION_KEYS = new Set(['force', 'refresh', 'quick']);
const PROVIDER_SETUP_OPTION_KEYS = new Set(['force', 'refresh', 'unlockKeychain', 'recheckKeychain']);
const SKILLS_STATUS_OPTION_KEYS = new Set(['projectPath']);
// A secret value has no key here: it travels only through provideSecretInput.
const TOOL_APPROVAL_KEYS = new Set([
  'approved',
  'reason',
  'answers',
  'reply',
  'response',
  'editedArgs',
  'remember',
  'scope',
]);
const TOOL_APPROVAL_RESPONSES = new Set<string>([
  'approve',
  'deny',
  'edit-and-approve',
  'provide-secret',
  'skip',
  'done',
]);
const TOGGLEABLE_BUILTIN_TOOLS = new Set([
  'git',
  'office',
  'localProvider',
  'tidy',
  'autoEffort',
  'visualize',
  'media',
]);
const INSTALLABLE_BUILTIN_FEATURES = new Set(['git', 'memory', 'office', 'localProvider', 'tidy', 'autoEffort']);

const CAPABILITY_ARITY = {
  prioritizeQueued: [1, 1],
  restoreQueued: [0, 2],
  rewindToItem: [1, 1],
  retryFailedTurn: [2, 2],
  setEffort: [1, 1],
  setToolMode: [1, 1],
  getAutoClear: [0, 0],
  setAutoClear: [0, 1],
  getUpdateSettings: [0, 0],
  setAutoUpdate: [1, 1],
  checkForUpdate: [0, 1],
  runUpdateNow: [0, 0],
  getUpdateStatus: [0, 0],
  getProfile: [0, 0],
  setProfile: [0, 1],
  getCompactionSettings: [0, 0],
  setCompactionSettings: [0, 1],
  getRecapSettings: [0, 0],
  setRecapEnabled: [1, 1],
  getSessionTitleSettings: [0, 0],
  setAiSessionTitles: [1, 1],
  getCacheWarmingSettings: [0, 0],
  setCacheWarmingEnabled: [1, 1],
  getHeartbeatSettings: [0, 0],
  setHeartbeatEnabled: [1, 1],
  setHeartbeatInterval: [1, 1],
  noteUserInput: [1, 1],
  getReactionSettings: [0, 0],
  setReactionsEnabled: [1, 1],
  getToolModuleSettings: [0, 0],
  setWebSearchEnabled: [1, 1],
  setInstructionFiles: [1, 1],
  setAutoEffortBase: [1, 1],
  setMemoryToolsEnabled: [1, 1],
  getDeveloperSettings: [0, 0],
  setDeveloperOption: [2, 2],
  setBuiltinToolEnabled: [2, 2],
  installBuiltinFeature: [1, 2],
  getTidyEngineStatus: [0, 0],
  getTidyInstallStatus: [0, 0],
  installLocalProviderModel: [1, 1],
  startLocalProviderInstallation: [1, 2],
  cancelLocalProviderInstallation: [1, 1],
  discardLocalProviderInstallation: [1, 2],
  setLocalProviderIdleTtl: [1, 1],
  setLocalProviderContext: [2, 2],
  getLocalProviderModelDetails: [1, 1],
  startLocalProviderModelMaintenance: [2, 2],
  deleteLocalProviderModel: [1, 1],
  getVoiceStatus: [0, 0],
  toggleVoice: [1, 1],
  claimSetupRequest: [2, 2],
  isSetupRequestActive: [2, 2],
  completeSetupRequest: [3, 3],
  agentControl: [0, 2],
  taskControl: [0, 1],
  goalControl: [0, 1],
  toolsStatus: [0, 1],
  selectTools: [1, 1],
  getSystemShell: [0, 0],
  setSystemShell: [1, 1],
  mcpStatus: [0, 0],
  getMcpServerConfig: [1, 1],
  reconnectMcp: [0, 0],
  addMcpServer: [1, 1],
  saveMcpServer: [1, 1],
  removeMcpServer: [1, 1],
  setMcpServerEnabled: [2, 2],
  beginMcpOAuthLogin: [1, 2],
  getMcpOAuthLoginStatus: [1, 2],
  cancelMcpOAuthLogin: [1, 1],
  completeMcpOAuthLogin: [2, 2],
  signOutMcpServer: [1, 1],
  probeMcpServerAuth: [1, 1],
  getDisabledSkills: [0, 0],
  setDisabledSkills: [1, 1],
  setExtensionScope: [2, 3],
  skillsStatus: [0, 1],
  skillContent: [1, 1],
  addSkill: [1, 1],
  saveSkill: [1, 1],
  removeSkill: [1, 1],
  reloadSkills: [0, 0],
  pluginsStatus: [0, 0],
  reloadPlugins: [0, 0],
  addPlugin: [1, 1],
  updatePlugin: [1, 1],
  setPluginEnabled: [2, 2],
  removePlugin: [1, 1],
  enablePluginMcp: [1, 1],
  contextStatus: [0, 1],
  inheritancePreflight: [0, 2],
  memoryControl: [0, 2],
  recall: [1, 2],
  runDoctor: [0, 0],
  compact: [0, 0],
  devinHandoff: [0, 1],
  askSide: [1, 1],
  cancelSide: [0, 0],
  listPresets: [0, 0],
  setModel: [1, 1],
  getWebSearchRoute: [0, 0],
  listWebSearchModels: [0, 1],
  setWebSearchRoute: [1, 1],
  listAgents: [0, 0],
  listWorkflows: [0, 0],
  getOutputStyle: [0, 0],
  listOutputStyles: [0, 0],
  setOutputStyle: [1, 1],
  setWorkflow: [1, 2],
  getOrchestrationMode: [0, 0],
  getConfiguredOrchestrationMode: [0, 0],
  setOrchestrationMode: [1, 2],
  getWorkflowPack: [1, 1],
  saveWorkflowPack: [1, 1],
  createWorkflow: [1, 1],
  deleteWorkflow: [1, 1],
  getAgentDefinition: [1, 1],
  getAgentAvatarImage: [1, 1],
  archivedAgentIdentities: [1, 1],
  getAgentConnectors: [1, 1],
  listConnectors: [0, 0],
  listConnectorTools: [1, 1],
  setAgentConnectors: [2, 2],
  setAgentConnectorEnabled: [3, 3],
  getProjectConnectors: [1, 1],
  setProjectConnectorEnabled: [3, 3],
  setAgentConnectorToolPermission: [4, 4],
  getAgentAlwaysAllowedTools: [1, 1],
  getAgentPermissions: [1, 1],
  setAgentPermission: [3, 3],
  recordAgentApprovalAudit: [3, 3],
  getLeadPersona: [0, 0],
  saveLeadPersona: [1, 1],
  getLeadAgentBody: [0, 0],
  saveLeadAgentBody: [1, 1],
  getLeadStatus: [0, 0],
  getLeadAppearance: [0, 0],
  setLeadAppearance: [1, 1],
  getBotOrder: [0, 0],
  setBotOrder: [1, 1],
  setLeadCreated: [1, 2],
  saveLeadIdentity: [1, 1],
  saveAgentDefinition: [1, 1],
  deleteAgentDefinition: [1, 1],
  restoreAgentDefinition: [1, 1],
  listThemes: [0, 0],
  getTheme: [0, 0],
  setTheme: [1, 2],
  setAgentRoute: [2, 2],
  listProviders: [0, 0],
  listProviderModels: [0, 1],
  getProviderSetup: [0, 1],
  getProviderAccounts: [1, 1],
  updateProviderAccounts: [2, 2],
  getUsageDashboard: [0, 1],
  getUsageStats: [0, 1],
  getQuotaHistory: [0, 1],
  getSessionUsage: [0, 1],
  consumeCodexRateLimitResetCredit: [1, 1],
  getSessionReviewDiff: [0, 0],
  getSessionReviewFilePatch: [1, 2],
  getTurnReviewDiff: [0, 1],
  getTurnReviewFilePatch: [1, 1],
  revertTurnReview: [0, 1],
  revertTurnReviewFile: [1, 2],
  getTurnChanges: [1, 1],
  revertTurnChanges: [3, 3],
  reapplyTurnChanges: [3, 3],
  clearSessionChangeHistory: [0, 0],
  getOnboardingStatus: [0, 0],
  skipOnboarding: [0, 0],
  completeOnboarding: [0, 1],
  saveStarterGuideState: [1, 1],
  loginOAuthProvider: [1, 1],
  beginOAuthProviderLogin: [1, 2],
  getOAuthProviderLoginStatus: [1, 1],
  completeOAuthProviderLogin: [2, 2],
  cancelOAuthProviderLogin: [1, 1],
  saveProviderApiKey: [2, 2],
  saveCustomProvider: [1, 1],
  saveCustomProviderKey: [2, 2],
  removeCustomProvider: [1, 1],
  updateCustomProviderModel: [3, 3],
  setModelPreferences: [2, 2],
  testCustomProvider: [1, 1],
  checkCustomProviderKeyEnv: [1, 1],
  discoverCustomProviderModels: [1, 1],
  saveOpenAIUsageSessionKey: [1, 1],
  authenticateProvider: [2, 2],
  forgetProviderAuth: [1, 2],
  getChannelSetup: [0, 0],
  setWebhookConfig: [1, 1],
  saveSchedule: [1, 1],
  deleteSchedule: [1, 1],
  setScheduleEnabled: [2, 2],
  runScheduleNow: [1, 1],
  runWebhookNow: [1, 1],
  retryRoutineDelivery: [2, 2],
  testWebhook: [1, 1],
  saveWebhook: [1, 1],
  deleteWebhook: [1, 1],
  setWebhookEnabled: [2, 2],
  clear: [0, 0],
  transcribeAudio: [1, 1],
  prepareTranscription: [0, 0],
  resizeImage: [1, 1],
  listMediaLanes: [0, 1],
  listMediaAssets: [0, 1],
  readMediaAsset: [1, 2],
  cacheMediaThumbnail: [2, 2],
  resolveMediaFile: [1, 2],
  getMediaJob: [1, 1],
  getMediaDefault: [1, 1],
  setMediaDefault: [1, 1],
  getMediaPins: [0, 0],
  setMediaPin: [1, 1],
  startMediaJob: [1, 1],
  cancelMediaJob: [1, 1],
  deleteMediaAsset: [1, 1],
  deleteMediaAssets: [1, 1],
  openMediaAsset: [1, 1],
  openMediaFolder: [0, 1],
  ...WORKTREE_CAPABILITY_ARITY,
  ...IMPORT_CAPABILITY_ARITY,
} as const satisfies Record<DesktopCapability, readonly [number, number]>;

/** Optional `{ openBrowser?: boolean }` for GitHub CLI sign-in. */
export function optionalGithubLoginOptions(value: unknown): { openBrowser?: boolean } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('options must be an object.');
  const { openBrowser } = value as { openBrowser?: unknown };
  if (openBrowser !== undefined && typeof openBrowser !== 'boolean') {
    throw new TypeError('openBrowser must be a boolean.');
  }
  return openBrowser === undefined ? {} : { openBrowser };
}

export function requiredString(value: unknown, name: string, maximum = 32_768): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new TypeError(`${name} is invalid.`);
  return text;
}

/** A paired device's local nickname: a string, where only an explicit '' clears
 *  it. Anything else is refused rather than read as a clear. */
export function requiredDeviceAlias(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('alias must be a string.');
  if (value.length > 1_024) throw new TypeError('alias is invalid.');
  return value;
}

export function requiredSessionContentQuery(value: unknown): string {
  return requiredString(value, 'session search query', 1_024);
}

const CUSTOM_PROVIDER_KEYS = new Set([
  'id',
  'name',
  'protocol',
  'baseURL',
  'apiKey',
  'apiKeyEnv',
  'models',
  'schemaVersion',
  'enabled',
  'auth',
  'discovery',
  'modelOverrides',
  'wires',
  'modelWires',
  'type',
]);
// Wires a custom OpenAI-compatible endpoint can serve (custom-provider-config.mjs).
const CUSTOM_WIRES = new Set(['chat', 'responses', 'messages']);
const CUSTOM_MODEL_KEYS = new Set(['id', 'name', 'contextWindow', 'maxOutputTokens']);
const CUSTOM_PROTOCOLS = new Set(['openai-chat', 'openai-responses', 'anthropic']);
const CUSTOM_DISCOVERY_KEYS = new Set(['newModelsHidden']);
const CUSTOM_OVERRIDE_KEYS = new Set([
  'manual',
  'hidden',
  'name',
  'contextWindow',
  'maxOutputTokens',
  'supportsVision',
  'reasoning',
]);
const CUSTOM_REASONING_KEYS = new Set(['levels', 'wireFormat', 'wireValues', 'replay']);
// Mirror the runtime normalizer (custom-provider-config.mjs): the same level
// list (CUSTOM_REASONING_LEVELS, kept identical by custom-provider-validation
// test) and limits no looser than its own.
export const CUSTOM_REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const CUSTOM_WIRE_FORMATS = new Set(['standard', 'deepseek']);
export const CUSTOM_MAX_OVERRIDES = 500;
export const CUSTOM_MAX_MODEL_ID = 256;
export const CUSTOM_MAX_NAME = 200;
export const CUSTOM_MAX_WIRE_VALUE = 64;
// Same transport rules as provider-admin.mjs (validateCustomTransportFields).
export const CUSTOM_MAX_API_KEY = 65_536;
const CUSTOM_PROVIDER_ID = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CUSTOM_API_KEY_ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CUSTOM_LEVEL_ALIASES: Readonly<Record<string, string>> = { ultra: 'max' };

/** Canonical level like the runtime (trimmed, case-folded, `ultra` → `max`), or null. */
function canonicalLevel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const level = CUSTOM_LEVEL_ALIASES[text] ?? text;
  return (CUSTOM_REASONING_LEVELS as readonly string[]).includes(level) ? level : null;
}

function boundedCustomText(value: unknown, name: string, maximum: number): string {
  const text = requiredString(value, name, maximum);
  if (hasControlCharacter(text)) throw new TypeError(`${name} is invalid.`);
  return text;
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid.`);
  return value as Record<string, unknown>;
}

/** Shape check only; semantic validation (URL, model rules) is the runtime's. */
export function requiredCustomProviderInput(value: unknown, modelsOptional = false): Record<string, unknown> {
  const input = plainRecord(value, 'custom provider');
  requireAllowedKeys(input, CUSTOM_PROVIDER_KEYS, 'custom provider');
  if (input.id !== undefined && (typeof input.id !== 'string' || !CUSTOM_PROVIDER_ID.test(input.id))) {
    throw new TypeError('custom provider id is invalid.');
  }
  boundedCustomText(input.name, 'custom provider name', CUSTOM_MAX_NAME);
  if (typeof input.protocol !== 'string' || !CUSTOM_PROTOCOLS.has(input.protocol)) {
    throw new TypeError('custom provider protocol is invalid.');
  }
  requiredString(input.baseURL, 'custom provider baseURL', 2048);
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > CUSTOM_MAX_API_KEY)) {
    throw new TypeError('custom provider apiKey is invalid.');
  }
  if (input.apiKeyEnv !== undefined && input.apiKeyEnv !== null) {
    if (typeof input.apiKeyEnv !== 'string' || !CUSTOM_API_KEY_ENV.test(input.apiKeyEnv)) {
      throw new TypeError('custom provider apiKeyEnv is invalid.');
    }
    if (input.auth === 'none') throw new TypeError('custom provider apiKeyEnv requires key auth.');
    if (typeof input.apiKey === 'string' && input.apiKey !== '') {
      throw new TypeError('custom provider apiKey and apiKeyEnv are mutually exclusive.');
    }
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== 2) {
    throw new TypeError('custom provider schemaVersion is invalid.');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new TypeError('custom provider enabled is invalid.');
  }
  if (input.auth !== undefined && input.auth !== 'key' && input.auth !== 'none') {
    throw new TypeError('custom provider auth is invalid.');
  }
  if (input.type !== undefined && input.type !== 'custom') {
    throw new TypeError('custom provider type is invalid.');
  }
  if (
    (input.discovery !== undefined ||
      input.modelOverrides !== undefined ||
      input.wires !== undefined ||
      input.modelWires !== undefined) &&
    input.schemaVersion !== 2
  ) {
    throw new TypeError('custom provider schemaVersion is invalid.');
  }
  // Shape only; the runtime ties them to the protocol and to each other.
  if (input.wires !== undefined) {
    if (
      !Array.isArray(input.wires) ||
      input.wires.length === 0 ||
      input.wires.length > CUSTOM_WIRES.size ||
      input.wires.some((wire) => typeof wire !== 'string' || !CUSTOM_WIRES.has(wire))
    ) {
      throw new TypeError('custom provider wires are invalid.');
    }
  }
  if (input.modelWires !== undefined) {
    const modelWires = plainRecord(input.modelWires, 'custom provider modelWires');
    const ids = Object.keys(modelWires);
    if (ids.length > CUSTOM_MAX_OVERRIDES) throw new TypeError('custom provider modelWires are too large.');
    for (const modelId of ids) {
      requireSafeModelId(modelId);
      const wire = modelWires[modelId];
      if (typeof wire !== 'string' || !CUSTOM_WIRES.has(wire)) {
        throw new TypeError('custom provider modelWires are invalid.');
      }
    }
  }
  // v2 states models as modelOverrides; a legacy `models` list is unversioned only.
  if (input.schemaVersion === 2 && input.models !== undefined) {
    throw new TypeError('custom provider models are invalid.');
  }
  if (input.discovery !== undefined) {
    const discovery = plainRecord(input.discovery, 'custom provider discovery');
    requireAllowedKeys(discovery, CUSTOM_DISCOVERY_KEYS, 'custom provider discovery');
    if (discovery.newModelsHidden !== undefined && typeof discovery.newModelsHidden !== 'boolean') {
      throw new TypeError('custom provider discovery is invalid.');
    }
  }
  if (input.modelOverrides !== undefined) {
    const overrides = plainRecord(input.modelOverrides, 'custom provider modelOverrides');
    const ids = Object.keys(overrides);
    if (ids.length > CUSTOM_MAX_OVERRIDES) throw new TypeError('custom provider modelOverrides are too large.');
    for (const modelId of ids) {
      requireSafeModelId(modelId);
      validateCustomModelOverride(overrides[modelId], false, input.protocol);
    }
  }
  if (input.models === undefined && (modelsOptional || input.schemaVersion === 2)) {
    return input;
  }
  if (!Array.isArray(input.models) || input.models.length > CUSTOM_MAX_OVERRIDES)
    throw new TypeError('custom provider models are invalid.');
  for (const model of input.models) {
    const row = plainRecord(model, 'custom provider model');
    requireAllowedKeys(row, CUSTOM_MODEL_KEYS, 'custom provider model');
    requiredString(row.id, 'custom provider model id', CUSTOM_MAX_MODEL_ID);
    if (row.name !== undefined) requiredString(row.name, 'custom provider model name', CUSTOM_MAX_NAME);
    for (const key of ['contextWindow', 'maxOutputTokens']) {
      if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || Number(row[key]) <= 0)) {
        throw new TypeError(`custom provider model ${key} is invalid.`);
      }
    }
  }
  return input;
}

function requireSafeModelId(modelId: string): void {
  if (
    !modelId.trim() ||
    modelId !== modelId.trim() ||
    modelId.length > CUSTOM_MAX_MODEL_ID ||
    hasControlCharacter(modelId) ||
    UNSAFE_KEYS.has(modelId)
  ) {
    throw new TypeError('custom provider model id is invalid.');
  }
}

/**
 * Check one model override with the runtime normalizer's accept set
 * (custom-provider-config.mjs; parity is table-tested). `patch` additionally
 * allows null to delete a property; its wire values are not tied to levels
 * because the service prunes them against the merged levels.
 */
function validateCustomModelOverride(value: unknown, patch: boolean, protocol?: unknown): void {
  const row = plainRecord(value, 'custom provider model override');
  requireAllowedKeys(row, CUSTOM_OVERRIDE_KEYS, 'custom provider model override');
  const nullable = (v: unknown) => patch && v === null;
  for (const key of ['manual', 'hidden', 'supportsVision']) {
    if (row[key] !== undefined && !nullable(row[key]) && typeof row[key] !== 'boolean') {
      throw new TypeError(`custom provider model ${key} is invalid.`);
    }
  }
  if (row.name !== undefined && !nullable(row.name))
    boundedCustomText(row.name, 'custom provider model name', CUSTOM_MAX_NAME);
  for (const key of ['contextWindow', 'maxOutputTokens']) {
    const v = row[key];
    if (v !== undefined && !nullable(v) && (!Number.isSafeInteger(v) || Number(v) <= 0)) {
      throw new TypeError(`custom provider model ${key} is invalid.`);
    }
  }
  if (row.reasoning === undefined || nullable(row.reasoning)) return;
  const reasoning = plainRecord(row.reasoning, 'custom provider reasoning');
  requireAllowedKeys(reasoning, CUSTOM_REASONING_KEYS, 'custom provider reasoning');
  const { levels, wireFormat, wireValues, replay } = reasoning;
  let declared: Set<string> | null = null;
  if (levels !== undefined && !nullable(levels)) {
    if (!Array.isArray(levels) || levels.length > CUSTOM_REASONING_LEVELS.length) {
      throw new TypeError('custom provider reasoning levels are invalid.');
    }
    declared = new Set();
    for (const entry of levels) {
      const level = canonicalLevel(entry);
      if (!level || declared.has(level)) throw new TypeError('custom provider reasoning levels are invalid.');
      declared.add(level);
    }
  }
  if (wireFormat !== undefined && !nullable(wireFormat)) {
    const format = typeof wireFormat === 'string' ? wireFormat.trim() : '';
    if (
      !CUSTOM_WIRE_FORMATS.has(format) ||
      (format === 'deepseek' && protocol !== undefined && protocol !== 'openai-chat')
    ) {
      throw new TypeError('custom provider reasoning wireFormat is invalid.');
    }
  }
  if (replay !== undefined && !nullable(replay) && typeof replay !== 'boolean') {
    throw new TypeError('custom provider reasoning replay is invalid.');
  }
  if (wireValues !== undefined && !nullable(wireValues)) {
    const values = plainRecord(wireValues, 'custom provider reasoning wireValues');
    const seen = new Set<string>();
    for (const [key, wire] of Object.entries(values)) {
      const level = canonicalLevel(key);
      if (
        !level ||
        seen.has(level) ||
        (!patch && declared && !declared.has(level)) ||
        typeof wire !== 'string' ||
        !wire.trim() ||
        wire.trim().length > CUSTOM_MAX_WIRE_VALUE ||
        hasControlCharacter(wire.trim())
      ) {
        throw new TypeError('custom provider reasoning wireValues are invalid.');
      }
      seen.add(level);
    }
  }
}

/** Shape check for updateCustomProviderModel(id, modelId, patch); patch null deletes the override. */
export function requiredCustomModelPatch(id: unknown, modelId: unknown, patch: unknown): void {
  requiredString(id, 'custom provider id', 128);
  requireSafeModelId(requiredString(modelId, 'custom provider model id', CUSTOM_MAX_MODEL_ID));
  if (patch !== null) validateCustomModelOverride(patch, true);
}

const MODEL_PREFERENCE_KEYS: ReadonlySet<string> = new Set(['model', 'hidden', 'favorite']);
export const MODEL_PREFERENCE_CHANGES_MAX = 5_000;

/** Shape check for setModelPreferences(provider, [{ model, hidden?, favorite? }]). */
function requiredModelPreferences(provider: unknown, changes: unknown): void {
  requiredString(provider, 'provider id', 128);
  if (!Array.isArray(changes) || changes.length > MODEL_PREFERENCE_CHANGES_MAX) {
    throw new TypeError('model preference changes are invalid.');
  }
  for (const raw of changes) {
    const change = plainRecord(raw, 'model preference change');
    requireAllowedKeys(change, MODEL_PREFERENCE_KEYS, 'model preference change');
    requireSafeModelId(requiredString(change.model, 'model id', CUSTOM_MAX_MODEL_ID));
    for (const key of ['hidden', 'favorite']) {
      if (change[key] !== undefined && typeof change[key] !== 'boolean') {
        throw new TypeError(`model preference ${key} is invalid.`);
      }
    }
  }
}

export function requiredGitGlobalConfigKey(value: unknown): DesktopGitGlobalConfigKey {
  if (typeof value === 'string' && (DESKTOP_GIT_GLOBAL_CONFIG_KEYS as readonly string[]).includes(value)) {
    return value as DesktopGitGlobalConfigKey;
  }
  throw new TypeError('key must be user.name, user.email, or init.defaultBranch.');
}

function requireAllowedKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError(`${name} contains an unsupported field.`);
  }
}

export function projectDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('alias must be a string.');
  const text = value.trim();
  if (text.length > 120 || hasControlCharacter(text)) {
    throw new TypeError('alias is invalid.');
  }
  return text;
}

export function sessionDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('title must be a string.');
  const text = value.trim();
  if (!text || text.length > 1_024 || hasControlCharacter(text)) {
    throw new TypeError('title is invalid.');
  }
  return text;
}

export function requiredFileSearchLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 200) {
    throw new TypeError('limit is invalid.');
  }
  return value as number;
}

/** Absent (JSON transports carry an omitted argument as null): re-read the
 *  session's current transcript window without growing it. */
export function requiredTranscriptItemLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 8_192) {
    throw new TypeError('transcript item limit is invalid.');
  }
  return value as number;
}

export function requiredSessionMessageCount(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 10_000_000) {
    throw new TypeError('session message count is invalid.');
  }
  return value as number;
}

function requiredWorkspaceSearchLimit(value: unknown): number {
  if (value === undefined) return 2_000;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5_000) {
    throw new TypeError('maxResults is invalid.');
  }
  return value as number;
}

function validateStructuredValue(value: unknown, state = { strings: 0, nodes: 0 }, depth = 0): void {
  state.nodes += 1;
  if (state.nodes > 20_000 || depth > 12) throw new TypeError('structured input is too large.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('structured input contains an invalid number.');
    return;
  }
  if (typeof value === 'string') {
    state.strings += value.length;
    if (state.strings > MAX_STRUCTURED_STRING_TOTAL) throw new TypeError('structured input is too large.');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 5_000) throw new TypeError('structured input contains too many entries.');
    for (const entry of value) validateStructuredValue(entry, state, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') throw new TypeError('structured input is invalid.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 5_000) throw new TypeError('structured input contains too many fields.');
  for (const [key, entry] of entries) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new TypeError('structured input contains an invalid field.');
    }
    validateStructuredValue(entry, state, depth + 1);
  }
}

export function requiredPromptContent(value: unknown): DesktopPromptContent {
  if (typeof value === 'string') {
    if (!value.trim() || value.length > MAX_PROMPT_LENGTH) throw new TypeError('prompt is invalid.');
    return value;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError('prompt content is invalid.');
  }
  let textLength = 0;
  let imageLength = 0;
  let imageCount = 0;
  let fileLength = 0;
  let fileCount = 0;
  let hasContent = false;
  const content = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('prompt part is invalid.');
    }
    const part = entry as Record<string, unknown>;
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw new TypeError('prompt text part is invalid.');
      textLength += part.text.length;
      if (textLength > MAX_PROMPT_LENGTH) throw new TypeError('prompt text is too large.');
      if (part.text.trim()) hasContent = true;
      return { type: 'text' as const, text: part.text };
    }
    if (part.type === 'image') {
      imageCount += 1;
      if (imageCount > MAX_PROMPT_IMAGES) throw new TypeError('too many prompt images.');
      const mimeType = requiredString(part.mimeType, 'image mime type', 64).toLowerCase();
      if (!PROMPT_IMAGE_MIME_PATTERN.test(mimeType)) {
        throw new TypeError('image type is unsupported.');
      }
      if (
        typeof part.data !== 'string' ||
        !part.data ||
        part.data.length > MAX_PROMPT_IMAGE_BASE64_LENGTH ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)
      ) {
        throw new TypeError('image data is invalid.');
      }
      imageLength += part.data.length;
      if (imageLength > MAX_PROMPT_IMAGE_BASE64_TOTAL) throw new TypeError('prompt images are too large.');
      hasContent = true;
      return { type: 'image' as const, data: part.data, mimeType };
    }
    if (part.type === 'file') {
      fileCount += 1;
      if (fileCount > MAX_PROMPT_FILES) throw new TypeError('too many prompt files.');
      const mimeType = canonicalPromptFileMimeType(
        requiredString(part.mimeType, 'file mime type', MAX_PROMPT_FILE_MIME_LENGTH)
      );
      if (!mimeType) throw new TypeError('file type is unsupported.');
      if (
        typeof part.data !== 'string' ||
        !part.data ||
        part.data.length > MAX_PROMPT_FILE_BASE64_LENGTH ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)
      ) {
        throw new TypeError('file data is invalid.');
      }
      fileLength += part.data.length;
      if (fileLength > MAX_PROMPT_FILE_BASE64_TOTAL) throw new TypeError('prompt files are too large.');
      hasContent = true;
      const filename = typeof part.filename === 'string' ? part.filename.slice(0, 160) : '';
      return { type: 'file' as const, data: part.data, mimeType, ...(filename ? { filename } : {}) };
    }
    throw new TypeError('prompt part type is unsupported.');
  });
  if (!hasContent) throw new TypeError('prompt is empty.');
  return content;
}

export function requiredSubmitOptions(value: unknown): DesktopSubmitOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('submit options are invalid.');
  }
  validateStructuredValue(value);
  const input = value as Record<string, unknown>;
  requireAllowedKeys(input, SUBMIT_OPTION_KEYS, 'submit options');
  if (
    input.id !== undefined &&
    (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 256 || hasControlCharacter(input.id))
  ) {
    throw new TypeError('submit id is invalid.');
  }
  if (
    input.submittedAt !== undefined &&
    (!Number.isSafeInteger(input.submittedAt) || (input.submittedAt as number) <= 0)
  ) {
    throw new TypeError('submit timestamp is invalid.');
  }
  if (input.retryFailedTurn !== undefined && typeof input.retryFailedTurn !== 'boolean') {
    throw new TypeError('submit retryFailedTurn is invalid.');
  }
  if (input.kickoff !== undefined && typeof input.kickoff !== 'boolean') {
    throw new TypeError('submit kickoff is invalid.');
  }
  const priority = input.priority;
  if (priority !== undefined && priority !== 'now' && priority !== 'next' && priority !== 'later') {
    throw new TypeError('submit priority is invalid.');
  }
  if (
    input.displayText !== undefined &&
    (typeof input.displayText !== 'string' || input.displayText.length > MAX_PROMPT_LENGTH)
  ) {
    throw new TypeError('submit display text is invalid.');
  }
  if (
    input.goalCommand !== undefined &&
    (typeof input.goalCommand !== 'string' || !input.goalCommand.trim() || input.goalCommand.length > MAX_PROMPT_LENGTH)
  ) {
    throw new TypeError('goal command is invalid.');
  }
  return value as DesktopSubmitOptions;
}

export function requiredAbortOptions(value: unknown): DesktopAbortOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('abort options are invalid.');
  }
  const input = value as Record<string, unknown>;
  requireAllowedKeys(input, ABORT_OPTION_KEYS, 'abort options');
  if (input.restorePrompt !== undefined && typeof input.restorePrompt !== 'boolean') {
    throw new TypeError('abort restorePrompt is invalid.');
  }
  if (input.submissionId !== undefined) {
    requiredString(input.submissionId, 'abort submission id', 1_024);
  }
  return value as DesktopAbortOptions;
}

export function requiredNewTaskDraft(value: unknown): DesktopNewTaskDraft {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('new task draft is invalid.');
  }
  validateStructuredValue(value);
  const input = value as Record<string, unknown>;
  requireAllowedKeys(input, NEW_TASK_DRAFT_KEYS, 'new task draft');
  const projectPath = input.projectPath === undefined ? '' : requiredString(input.projectPath, 'projectPath');
  const route = input.route === undefined ? undefined : requiredModelSelection(input.route);
  const workflowId = input.workflowId === undefined ? '' : requiredString(input.workflowId, 'workflowId', 256);
  const orchestrationMode = input.orchestrationMode as DesktopNewTaskDraft['orchestrationMode'];
  if (orchestrationMode !== undefined && !['none', 'focused', 'balanced', 'swarm'].includes(orchestrationMode)) {
    throw new TypeError('orchestrationMode is invalid.');
  }
  let worktree: DesktopNewTaskDraft['worktree'];
  if (input.worktree !== undefined) {
    const value = input.worktree;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('worktree is invalid.');
    const record = value as Record<string, unknown>;
    requireAllowedKeys(record, new Set(['confirmLarge', 'branch', 'create']), 'new task worktree');
    if (record.confirmLarge !== undefined && typeof record.confirmLarge !== 'boolean') {
      throw new TypeError('worktree.confirmLarge must be a boolean.');
    }
    worktree = record.confirmLarge === true ? { confirmLarge: true } : {};
    if (record.branch !== undefined) worktree.branch = requiredString(record.branch, 'worktree.branch');
    if (record.create !== undefined) {
      if (typeof record.create !== 'boolean' || !worktree.branch) {
        throw new TypeError('worktree.create requires a branch and must be a boolean.');
      }
      worktree.create = record.create;
    }
  }
  return {
    ...(projectPath ? { projectPath } : {}),
    ...(route ? { route } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(orchestrationMode !== undefined ? { orchestrationMode } : {}),
    ...(worktree ? { worktree } : {}),
  };
}

// Mirrors the runtime schema (src/session-runtime/starter-guide-state.mjs).
const STARTER_GUIDE_STEPS = new Set(['provider', 'project', 'workflow', 'extensions', 'remote']);

function requiredStarterGuideState(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('starter guide state must be an object.');
  }
  const state = value as Record<string, unknown>;
  requireAllowedKeys(state, new Set(['closed', 'welcomed', 'visited']), 'starter guide state');
  if (typeof state.closed !== 'boolean' || typeof state.welcomed !== 'boolean') {
    throw new TypeError('starter guide closed and welcomed must be booleans.');
  }
  if (
    !Array.isArray(state.visited) ||
    state.visited.length > STARTER_GUIDE_STEPS.size * 2 ||
    state.visited.some((step) => typeof step !== 'string' || !STARTER_GUIDE_STEPS.has(step))
  ) {
    throw new TypeError('starter guide visited must list known steps.');
  }
}

export function requiredDesktopCapabilityRequest(value: unknown): DesktopCapabilityRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('capability request is invalid.');
  }
  const input = value as Record<string, unknown>;
  requireAllowedKeys(input, CAPABILITY_REQUEST_KEYS, 'capability request');
  if (typeof input.capability !== 'string' || !CAPABILITY_SET.has(input.capability)) {
    throw new TypeError('capability is unavailable.');
  }
  const capability = input.capability as DesktopCapability;
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args)) throw new TypeError('capability arguments must be an array.');
  const [minimum, maximum] = CAPABILITY_ARITY[capability];
  if (args.length < minimum || args.length > maximum) {
    throw new TypeError(`capability ${capability} received an invalid number of arguments.`);
  }
  validateStructuredValue(args);
  if (capability === 'retryFailedTurn') {
    const target = requiredSessionId(args[0]);
    requiredString(args[1], 'turn key', 512);
    if (input.sessionId !== target) throw new TypeError('retry session must match the addressed session.');
  }
  if (isWorktreeCapability(capability)) validateWorktreeCapabilityArgs(capability, args);
  if (isImportCapability(capability)) validateImportCapabilityArgs(capability, args);
  if (capability === 'contextStatus' && args.length) validateContextStatusArgs(args[0]);
  if (capability === 'getSessionUsage' && args.length) validateSessionUsageArgs(args[0]);
  validateSettingCapabilityArgs(capability, args);
  validateLocalProviderCapabilityArgs(capability, args);
  validateCredentialCapabilityArgs(capability, args);
  validateTurnCapabilityArgs(capability, args);
  if (capability === 'getProviderSetup' && args[0] !== undefined) {
    const options = optionalPlainRecord(args[0]);
    if (
      !options ||
      Object.entries(options).some(
        ([key, option]) => !PROVIDER_SETUP_OPTION_KEYS.has(key) || typeof option !== 'boolean'
      )
    ) {
      throw new TypeError('provider setup options are invalid.');
    }
  }
  // A new-task draft asks for skills as its selected Project would see them.
  // Only an absolute path passes here; the host then resolves it to a
  // registered Project (or its managed worktree) and refuses anything else.
  if (capability === 'skillsStatus' && args.length) {
    const options = optionalPlainRecord(args[0]);
    if (!options) throw new TypeError('skills status options are invalid.');
    requireAllowedKeys(options, SKILLS_STATUS_OPTION_KEYS, 'skills status options');
    const projectPath = requiredString(options.projectPath, 'projectPath', 4_096);
    if (!pathIsAbsolute(projectPath) || projectPath.includes('\0')) throw new TypeError('projectPath is invalid.');
  }
  const sessionId =
    input.sessionId === undefined || input.sessionId === null || input.sessionId === ''
      ? undefined
      : requiredSessionId(input.sessionId);
  return { capability, args, ...(sessionId ? { sessionId } : {}) };
}

const optionalPlainRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function validateContextStatusArgs(options: unknown): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('context inspection options must be an object.');
  }
  const inspection = options as Record<string, unknown>;
  requireAllowedKeys(inspection, new Set(['inspect', 'entryId', 'revision']), 'context inspection');
  if (inspection.inspect !== true) throw new TypeError('context inspection requires inspect: true.');
  if (inspection.entryId !== undefined) {
    requiredString(inspection.entryId, 'context entry id', 128);
    requiredString(inspection.revision, 'context revision', 64);
  } else if (inspection.revision !== undefined) {
    throw new TypeError('context revision requires an entry id.');
  }
}

/** The agent sessions whose ledger totals the composer island reads beside its own. */
const MAX_SESSION_USAGE_IDS = 64;
function validateSessionUsageArgs(options: unknown): void {
  const request = optionalPlainRecord(options);
  if (!request) throw new TypeError('session usage options must be an object.');
  requireAllowedKeys(request, new Set(['sessionIds', 'agents']), 'session usage options');
  if (request.sessionIds !== undefined) requiredSessionIds(request.sessionIds, MAX_SESSION_USAGE_IDS);
  if (request.agents !== undefined && typeof request.agents !== 'boolean') {
    throw new TypeError('session usage agents must be a boolean.');
  }
}

function validateSettingCapabilityArgs(capability: DesktopCapability, args: readonly unknown[]): void {
  if (BOOLEAN_FIRST_CAPABILITIES.has(capability) && typeof args[0] !== 'boolean') {
    throw new TypeError(`${capability} requires a boolean value.`);
  }
  if (capability === 'noteUserInput' && (typeof args[0] !== 'number' || !Number.isFinite(args[0]) || args[0] <= 0)) {
    throw new TypeError('noteUserInput requires a positive time in milliseconds.');
  }
  if (capability === 'setHeartbeatInterval' && !HEARTBEAT_INTERVAL_CHOICES.includes(args[0] as number)) {
    throw new TypeError(`setHeartbeatInterval requires ${HEARTBEAT_INTERVAL_CHOICES.join(', ')} minutes.`);
  }
  if (capability === 'setInstructionFiles' && !['all', 'agents', 'claude', 'off'].includes(args[0] as string)) {
    throw new TypeError('setInstructionFiles requires all, agents, claude, or off.');
  }
  if (capability === 'setAutoEffortBase' && !['low', 'medium', 'high'].includes(args[0] as string)) {
    throw new TypeError('setAutoEffortBase requires low, medium, or high.');
  }
  if (BOOLEAN_SECOND_CAPABILITIES.has(capability) && typeof args[1] !== 'boolean') {
    throw new TypeError(`${capability} requires a boolean value.`);
  }
  if (capability === 'setBuiltinToolEnabled' && !TOGGLEABLE_BUILTIN_TOOLS.has(args[0] as string)) {
    throw new TypeError(
      'setBuiltinToolEnabled requires git, office, localProvider, tidy, autoEffort, visualize, or media.'
    );
  }
  if (capability === 'setDeveloperOption') requiredString(args[0], 'developer option id', 128);
  if (capability === 'installBuiltinFeature' && !INSTALLABLE_BUILTIN_FEATURES.has(args[0] as string)) {
    throw new TypeError('installBuiltinFeature requires git, memory, office, localProvider, or tidy.');
  }
  if (capability === 'installBuiltinFeature' && args[1] !== undefined) {
    const engines = (args[1] as { engines?: unknown } | null)?.engines;
    if (
      args[0] !== 'tidy' ||
      !Array.isArray(engines) ||
      engines.length === 0 ||
      engines.length > 16 ||
      !engines.every((id) => typeof id === 'string' && /^[a-z0-9_-]{1,64}$/.test(id))
    ) {
      throw new TypeError('installBuiltinFeature options accept only engines:[ids] for tidy.');
    }
  }
  if (capability === 'setModel') requiredString(args[0], 'model selector', 512);
}

function validateLocalProviderCapabilityArgs(capability: DesktopCapability, args: readonly unknown[]): void {
  if (capability === 'startLocalProviderInstallation') {
    if (args[0] !== 'runtime' && args[0] !== 'model') throw new TypeError('phase must be runtime or model.');
    if (args[0] === 'model') requiredString(args[1], 'modelId', 512);
    else if (args[1] !== undefined) throw new TypeError('runtime installation does not accept modelId.');
  }
  if (capability === 'cancelLocalProviderInstallation') requiredString(args[0], 'jobId', 128);
  if (capability === 'discardLocalProviderInstallation') {
    if (!['runtime', 'model', 'verify', 'repair'].includes(args[0] as string))
      throw new TypeError('phase must be runtime, model, verify or repair.');
    if (args[0] !== 'runtime') requiredString(args[1], 'modelId', 512);
    else if (args[1] !== undefined) throw new TypeError('runtime installation does not accept modelId.');
  }
  if (capability === 'setLocalProviderContext') {
    requiredString(args[0], 'modelId', 512);
    if (args[1] !== null && (!Number.isSafeInteger(args[1]) || Number(args[1]) < 16384)) {
      throw new TypeError('Context size must be null (automatic) or an integer of at least 16384 tokens.');
    }
  }
  if (capability === 'getLocalProviderModelDetails' || capability === 'startLocalProviderModelMaintenance')
    requiredString(args[0], 'modelId', 512);
  if (capability === 'deleteLocalProviderModel') requiredString(args[0], 'confirmationToken', 128);
  if (capability === 'startLocalProviderModelMaintenance' && args[1] !== 'verify' && args[1] !== 'repair') {
    throw new TypeError('operation must be verify or repair.');
  }
  if (
    capability === 'setLocalProviderIdleTtl' &&
    (typeof args[0] !== 'number' || !Number.isInteger(args[0]) || args[0] < 0 || args[0] > 86400)
  ) {
    throw new TypeError('idleTtlSeconds must be an integer from 0 to 86400.');
  }
}

function validateSecret(secret: unknown, name: string): void {
  if (typeof secret !== 'string' || !secret.trim() || secret.length > 65_536) {
    throw new TypeError(`${name} is invalid.`);
  }
}

function validateCredentialCapabilityArgs(capability: DesktopCapability, args: readonly unknown[]): void {
  if (capability === 'saveProviderApiKey' || capability === 'authenticateProvider') {
    validateSecret(args[1], 'provider secret');
  }
  if (
    capability === 'saveCustomProvider' ||
    capability === 'testCustomProvider' ||
    capability === 'discoverCustomProviderModels'
  ) {
    requiredCustomProviderInput(args[0], capability === 'discoverCustomProviderModels');
  }
  if (capability === 'checkCustomProviderKeyEnv') requiredString(args[0], 'environment variable name', 128);
  if (capability === 'saveStarterGuideState') requiredStarterGuideState(args[0]);
  if (capability === 'updateCustomProviderModel') requiredCustomModelPatch(args[0], args[1], args[2]);
  if (capability === 'setModelPreferences') requiredModelPreferences(args[0], args[1]);
  if (capability === 'removeCustomProvider') requiredString(args[0], 'custom provider id', 128);
  if (capability === 'saveCustomProviderKey') {
    if (typeof args[0] !== 'string' || !CUSTOM_PROVIDER_ID.test(args[0])) {
      throw new TypeError('custom provider id is invalid.');
    }
    validateSecret(args[1], 'provider secret');
  }
  if (capability === 'saveOpenAIUsageSessionKey') {
    validateSecret(args[0], 'secret');
  }
}

function validateTurnCapabilityArgs(capability: DesktopCapability, args: readonly unknown[]): void {
  // A /btw side question: one non-empty question text.
  if (capability === 'askSide') requiredString(args[0], 'side question', MAX_PROMPT_LENGTH);
  if (capability === 'getTurnReviewDiff' && args[0] !== undefined) {
    // The turn review bar asks for `{ refresh, known, summary, poll }`: whether
    // to re-read the worktree before diffing, the tag of the review it already
    // shows, whether a collapsed bar can go without the patch text, and
    // whether its interval timer (`poll: 'background'`) sent the read.
    // Anything else is not a review option.
    const options = optionalPlainRecord(args[0]);
    if (
      !options ||
      Object.entries(options).some(([key, option]) => {
        if (key === 'refresh' || key === 'summary') return typeof option !== 'boolean';
        if (key === 'poll') return option !== 'background';
        return key !== 'known' || typeof option !== 'string' || !/^[a-f0-9]{32}$/.test(option);
      })
    ) {
      throw new TypeError('turn review options are invalid.');
    }
  }
  if (capability === 'getSessionReviewFilePatch' || capability === 'getTurnReviewFilePatch') {
    // `[file, oldPath?]`: one listed file (and a rename's source) of a review.
    requiredString(args[0], 'file', 4_096);
    if (args[1] !== undefined) requiredString(args[1], 'oldPath', 4_096);
  }
  if (capability === 'getTurnChanges') {
    // `{ checkpointId, patch?, file? }`: one turn's recorded changes.
    const options = optionalPlainRecord(args[0]);
    if (!options) throw new TypeError('turn changes options are invalid.');
    requiredString(options.checkpointId, 'checkpointId', 512);
    for (const [key, option] of Object.entries(options)) {
      if (key === 'checkpointId') continue;
      if (key === 'patch' && typeof option === 'boolean') continue;
      if (key === 'file' && typeof option === 'string' && option.length <= 4_096) continue;
      throw new TypeError('turn changes options are invalid.');
    }
  }
  if (capability === 'revertTurnChanges' || capability === 'reapplyTurnChanges') {
    // `[checkpointId, file | null, revision]`.
    requiredString(args[0], 'checkpointId', 512);
    if (args[1] !== null) requiredString(args[1], 'file', 4_096);
    if (typeof args[2] !== 'number' || !Number.isSafeInteger(args[2]) || args[2] < 0) {
      throw new TypeError('revision must be a non-negative integer.');
    }
  }
}

export function requiredDesktopCapabilityReadRequests(value: unknown): DesktopCapabilityReadRequest[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new TypeError('capability read batch is invalid.');
  }
  return value.map((entry) => {
    const request = requiredDesktopCapabilityRequest(entry);
    if (!READ_CAPABILITY_SET.has(request.capability)) {
      throw new TypeError(`capability ${request.capability} is not read-only.`);
    }
    return request as DesktopCapabilityReadRequest;
  });
}

export function requiredModelSelection(value: unknown): DesktopModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('model selection is invalid.');
  }
  const selection = value as Record<string, unknown>;
  requireAllowedKeys(selection, MODEL_SELECTION_KEYS, 'model selection');
  const effort = selection.effort;
  const fast = selection.fast;
  const autoEffort = selection.autoEffort;
  const modelParameters = selection.modelParameters;
  const contextPercent = selection.contextPercent;
  const contextTokens = selection.contextTokens;
  const onlyIfEmpty = selection.onlyIfEmpty;
  if (onlyIfEmpty !== undefined && typeof onlyIfEmpty !== 'boolean') {
    throw new TypeError('selection.onlyIfEmpty must be a boolean.');
  }
  if (
    contextTokens !== undefined &&
    (typeof contextTokens !== 'number' || !Number.isSafeInteger(contextTokens) || contextTokens < 1)
  ) {
    throw new TypeError('selection.contextTokens must be a positive integer.');
  }
  if (effort !== undefined && typeof effort !== 'string') {
    throw new TypeError('selection.effort must be a string.');
  }
  if (fast !== undefined && typeof fast !== 'boolean') {
    throw new TypeError('selection.fast must be a boolean.');
  }
  if (autoEffort !== undefined && typeof autoEffort !== 'boolean') {
    throw new TypeError('selection.autoEffort must be a boolean.');
  }
  if (
    modelParameters !== undefined &&
    (!modelParameters ||
      typeof modelParameters !== 'object' ||
      Array.isArray(modelParameters) ||
      Object.entries(modelParameters).some(([key, option]) => !key || typeof option !== 'string'))
  ) {
    throw new TypeError('selection.modelParameters must be a string map.');
  }
  if (
    contextPercent !== undefined &&
    (typeof contextPercent !== 'number' ||
      !Number.isFinite(contextPercent) ||
      contextPercent < 10 ||
      contextPercent > 100 ||
      contextPercent % 10 !== 0)
  ) {
    throw new TypeError('selection.contextPercent must be a 10-point percentage from 10 to 100.');
  }
  // The Lead's fallback chain: leaf selections only (the runtime checks providers).
  const fallbacks = selection.fallbacks;
  if (fallbacks !== undefined && (!Array.isArray(fallbacks) || fallbacks.length > 16)) {
    throw new TypeError('selection.fallbacks must be an array of model selections.');
  }
  const fallbackSelections = (fallbacks as unknown[] | undefined)?.map((entry) => {
    if (entry && typeof entry === 'object' && Object.hasOwn(entry, 'fallbacks')) {
      throw new TypeError('fallback selections must be leaf selections.');
    }
    return requiredModelSelection(entry);
  });
  return {
    provider: requiredString(selection.provider, 'selection.provider', 256),
    ...(fallbackSelections === undefined ? {} : { fallbacks: fallbackSelections }),
    model: requiredString(selection.model, 'selection.model', 512),
    ...(effort === undefined ? {} : { effort: requiredString(effort, 'selection.effort', 64) }),
    ...(fast === undefined ? {} : { fast }),
    ...(autoEffort === undefined ? {} : { autoEffort }),
    ...(modelParameters === undefined ? {} : { modelParameters: { ...(modelParameters as Record<string, string>) } }),
    ...(contextPercent === undefined ? {} : { contextPercent }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(onlyIfEmpty === true ? { onlyIfEmpty } : {}),
  };
}

export function requiredModelCatalogOptions(value: unknown): DesktopModelCatalogOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('model catalog options are invalid.');
  }
  const input = value as Record<string, unknown>;
  for (const [key, option] of Object.entries(input)) {
    if (!MODEL_CATALOG_OPTION_KEYS.has(key) || typeof option !== 'boolean') {
      throw new TypeError('model catalog options are invalid.');
    }
  }
  return input as DesktopModelCatalogOptions;
}

export function requiredToolApprovalDecision(value: unknown): ToolApprovalDecision {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as ToolApprovalDecision).approved !== 'boolean'
  ) {
    throw new TypeError('decision is invalid.');
  }
  requireAllowedKeys(value as Record<string, unknown>, TOOL_APPROVAL_KEYS, 'decision');
  const decision = value as ToolApprovalDecision;
  if (decision.reason !== undefined && (typeof decision.reason !== 'string' || decision.reason.length > 4_096)) {
    throw new TypeError('decision.reason is invalid.');
  }
  const result: ToolApprovalDecision = { approved: decision.approved, reason: decision.reason };
  if (decision.answers !== undefined) result.answers = requiredQuestionAnswers(decision.answers);
  if (decision.reply !== undefined) {
    if (typeof decision.reply !== 'string' || decision.reply.trim().length > 4_000) {
      throw new TypeError('decision.reply is invalid.');
    }
    result.reply = decision.reply.trim();
  }
  if (decision.response !== undefined) {
    if (!TOOL_APPROVAL_RESPONSES.has(decision.response)) throw new TypeError('decision.response is invalid.');
    result.response = decision.response;
  }
  if (decision.remember !== undefined) {
    if (!['once', 'agent', 'always'].includes(decision.remember)) throw new TypeError('decision.remember is invalid.');
    result.remember = decision.remember;
  }
  if (decision.scope !== undefined) {
    if (typeof decision.scope !== 'string' || decision.scope.length > 200) {
      throw new TypeError('decision.scope is invalid.');
    }
    result.scope = decision.scope;
  }
  if (decision.editedArgs !== undefined) {
    const edited = decision.editedArgs as unknown;
    if (
      !edited ||
      typeof edited !== 'object' ||
      Array.isArray(edited) ||
      Object.keys(edited).length > 8 ||
      Object.values(edited).some((value) => typeof value !== 'string' || value.length > 40_000)
    ) {
      throw new TypeError('decision.editedArgs is invalid.');
    }
    result.editedArgs = { ...(edited as Record<string, string>) };
  }
  return result;
}

function requiredQuestionAnswers(value: unknown): NonNullable<ToolApprovalDecision['answers']> {
  if (!Array.isArray(value) || value.length > 4) throw new TypeError('decision.answers is invalid.');
  return value.map((entry) => {
    if (entry === null) return null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new TypeError('decision.answers is invalid.');
    requireAllowedKeys(entry as Record<string, unknown>, new Set(['selected', 'text']), 'decision.answers');
    const { selected, text } = entry as { selected?: unknown; text?: unknown };
    if (
      !Array.isArray(selected) ||
      selected.length > 4 ||
      selected.some((label) => typeof label !== 'string' || label.length > 200)
    ) {
      throw new TypeError('decision.answers is invalid.');
    }
    if (text !== undefined && (typeof text !== 'string' || text.length > 4_000)) {
      throw new TypeError('decision.answers is invalid.');
    }
    return text === undefined ? { selected: selected as string[] } : { selected: selected as string[], text };
  });
}

export function requiredGitPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new TypeError('git paths are invalid.');
  }
  return value.map(requiredGitPath);
}

/** Island Git request: the listed files (may be empty) and an optional base branch. */
export function requiredGitRequestContextInput(value: unknown): { paths: string[]; base: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('git request input is invalid.');
  const { paths, base } = value as Record<string, unknown>;
  if (!Array.isArray(paths) || paths.length > 500) throw new TypeError('git paths are invalid.');
  return {
    paths: paths.map(requiredGitPath),
    base: base === undefined || base === '' ? '' : requiredGitBranchName(base),
  };
}

export function requiredReviewDiffFiles(value: unknown): { path: string; untracked: boolean }[] {
  if (!Array.isArray(value) || value.length > 512) throw new TypeError('git review files are invalid.');
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new TypeError('git review file is invalid.');
    const { path, untracked } = entry as { path?: unknown; untracked?: unknown };
    return { path: requiredGitPath(path), untracked: untracked === true };
  });
}

export function requiredGitPath(value: unknown): string {
  const path = requiredString(value, 'git path', 4_096);
  if (
    pathIsAbsolute(path) ||
    path.includes('\0') ||
    path
      .replace(/\\/g, '/')
      .split('/')
      .some((part) => part === '..')
  ) {
    throw new TypeError('git path is invalid.');
  }
  return path;
}

export function requiredGitPatch(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_000_000 || value.includes('\0')) {
    throw new TypeError('git patch is invalid.');
  }
  return value;
}

export function requiredGitDiscardMode(value: unknown): 'worktree' | 'all' {
  if (value === undefined || value === 'all') return 'all';
  if (value === 'worktree') return 'worktree';
  throw new TypeError('git discard mode is invalid.');
}

export function requiredGitBranchName(value: unknown): string {
  const branch = requiredString(value, 'git branch', 512);
  if (branch.startsWith('-') || branch.includes('\0') || /[\r\n]/.test(branch)) {
    throw new TypeError('git branch is invalid.');
  }
  return branch;
}

export function requiredGitOptionalMessage(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 20_000 || value.includes('\0')) {
    throw new TypeError('git message is invalid.');
  }
  return value.trim();
}

export function requiredGitLogQuery(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 200 || value.includes('\0')) {
    throw new TypeError('git history query is invalid.');
  }
  return value.trim();
}

export function requiredGitLogOffset(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new TypeError('git history offset is invalid.');
  }
  return offset;
}

export function requiredGitLogLimit(value: unknown): number {
  if (value === undefined || value === null) return 40;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('git history limit is invalid.');
  }
  return limit;
}

export function requiredExternalUrl(value: unknown): string {
  const input = requiredString(value, 'url', 8_192);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError('url is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') {
    throw new TypeError('url protocol is unsupported.');
  }
  return url.toString();
}

const ATTACHMENT_IMAGE_EXTENSIONS = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/bmp', 'bmp'],
]);
const ATTACHMENT_IMAGE_DATA_URL_RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;
const MAX_ATTACHMENT_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * Transcript attachment chip → OS viewer. Only a base64 data URL carrying a
 * raster image passes: SVG and every other markup-bearing type stay out,
 * because their OS handler can be a browser, which would then run script from
 * a file this process itself just wrote.
 */
export function requiredAttachmentImage(value: unknown): { bytes: Buffer; extension: string } {
  if (typeof value !== 'string') throw new TypeError('image must be a string.');
  const match = ATTACHMENT_IMAGE_DATA_URL_RE.exec(value.trim());
  const extension = match && ATTACHMENT_IMAGE_EXTENSIONS.get(match[1].toLowerCase());
  if (!match || !extension) throw new TypeError('image data URL is unsupported.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_IMAGE_BYTES) {
    throw new TypeError('image data URL is invalid.');
  }
  return { bytes, extension };
}

/**
 * Filename stem for that temp copy. The submitted name is a label only: it is
 * stripped to word characters, so no separator, extension, or traversal
 * segment from the renderer survives into the path.
 */
export function attachmentImageBaseName(value: unknown): string {
  const label =
    typeof value === 'string'
      ? value
          .replace(/\.[^./\\]*$/, '')
          .replace(/[^\w-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60)
      : '';
  return label || 'image';
}

const MAX_DATA_URL_BYTES = 256 * 1024 * 1024;
const MIME_EXTENSIONS = new Map<string, string>([
  ['application/pdf', 'pdf'],
  ['application/json', 'json'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
  ['text/csv', 'csv'],
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/bmp', 'bmp'],
  ['audio/mpeg', 'mp3'],
  ['video/mp4', 'mp4'],
]);
// Allowlist of inert document, media and plain-text types. Anything else
// (scripts, installers, control-panel items, markup a browser would run) is
// never handed to the OS from a file this process just wrote.
const OPENABLE_ATTACHMENT_EXTENSIONS = new Set([
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'tif', 'tiff', 'heic', 'ico'],
  ...['pdf', 'doc', 'docx', 'dot', 'dotx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'],
  ...['txt', 'md', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'toml', 'ini'],
  ...['mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'webm', 'mov', 'mkv'],
]);

/** Decodes a base64 or percent-encoded `data:` URL. */
function decodeDataUrl(value: unknown): { mime: string; bytes: Buffer } {
  if (typeof value !== 'string') throw new TypeError('data URL must be a string.');
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(value.trim());
  if (!match) throw new TypeError('data URL is invalid.');
  const params = match[1].split(';').map((part) => part.trim());
  const mime = (params[0] || 'text/plain').toLowerCase();
  const base64 = params.slice(1).some((part) => part.toLowerCase() === 'base64');
  let bytes: Buffer;
  if (base64) {
    if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(match[2])) throw new TypeError('data URL is invalid.');
    bytes = Buffer.from(match[2], 'base64');
  } else {
    try {
      bytes = Buffer.from(decodeURIComponent(match[2]), 'utf8');
    } catch {
      throw new TypeError('data URL is invalid.');
    }
  }
  if (bytes.length > MAX_DATA_URL_BYTES) throw new TypeError('data URL is too large.');
  return { mime, bytes };
}

/** Source of "Save link as": an http(s) URL or a data URL. */
export function requiredSaveSource(
  value: unknown
): { kind: 'data'; mime: string; bytes: Buffer } | { kind: 'http'; url: string } {
  const text = requiredString(value, 'source', 64 * 1024 * 1024).trim();
  if (/^data:/i.test(text)) return { kind: 'data', ...decodeDataUrl(text) };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError('source is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('source protocol is unsupported.');
  return { kind: 'http', url: url.toString() };
}

/** A file name safe to offer as a dialog default: no separators or reserved characters. */
export function sanitizedFileName(value: unknown, fallback = 'download'): string {
  const name =
    typeof value === 'string'
      ? value
          // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped.
          .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
          .replace(/^[\s.-]+|[\s.]+$/g, '')
          .slice(0, 120)
      : '';
  return name || fallback;
}

/** Any attachment → OS app: bytes plus a stem and an extension that cannot launch code. */
export function requiredAttachmentFile(
  dataUrl: unknown,
  name: unknown
): { bytes: Buffer; baseName: string; extension: string } {
  const { mime, bytes } = decodeDataUrl(dataUrl);
  if (bytes.length === 0) throw new TypeError('attachment data URL is empty.');
  const named = typeof name === 'string' ? /\.([A-Za-z0-9]{1,10})$/.exec(name.trim())?.[1].toLowerCase() : undefined;
  const textKind = mime.startsWith('text/') || /^application\/(?:json|xml|x-yaml)$|\+(?:json|xml)$/.test(mime);
  const derived = MIME_EXTENSIONS.get(mime);
  const extension =
    [named, derived].find((candidate) => candidate && OPENABLE_ATTACHMENT_EXTENSIONS.has(candidate)) ||
    (textKind ? 'txt' : undefined);
  if (!extension) throw new TypeError('attachment type cannot be opened.');
  return { bytes, baseName: attachmentImageBaseName(name), extension };
}

export function requiredZoomFactor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.2 || value > 10) {
    throw new TypeError('zoom factor is invalid.');
  }
  return Math.round(value * 100) / 100;
}

export function requiredNotificationVolume(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > NOTIFICATION_VOLUME_MAX) {
    throw new TypeError('notification volume is invalid.');
  }
  return value as number;
}

export function requiredDesktopSettingKey(value: unknown): DesktopSettingKey {
  if (
    value === 'autoClear' ||
    value === 'autoCompact' ||
    value === 'keepAwake' ||
    value === 'runInBackground' ||
    value === 'usagePinned' ||
    value === 'usageRailShortLong' ||
    value === 'usageAccountsExpanded' ||
    value === 'usageRailSlotsThree' ||
    value === 'usageRailSlotsAll' ||
    value === 'computerControl' ||
    value === 'computerObserveOnly' ||
    value === 'browserControl' ||
    value === 'browserAutoSignIn' ||
    value === 'saveChatLogins' ||
    value === 'computerInstalled' ||
    value === 'browserInstalled'
  )
    return value;
  throw new TypeError('setting key is invalid.');
}

const NOTIFICATION_DEVICE_ID = /^[\w.:-]{1,80}$/u;
const NOTIFICATION_TARGET_ID = /^[\w.:-]{1,200}$/u;
const NOTIFICATION_TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;
const NOTIFICATION_PATCH_KEYS = new Set([
  'scope',
  'events',
  'automaticRuns',
  'quietHours',
  'holdWhileDesktopActive',
  'taskbarFlash',
]);
const NOTIFICATION_QUIET_KEYS = new Set(['enabled', 'start', 'end', 'days', 'allowWaiting']);

function onlyKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`${name} has an unsupported field: ${key}.`);
  }
}

function optionalBoolean(input: Record<string, unknown>, key: string, name: string): boolean | undefined {
  if (input[key] === undefined) return undefined;
  if (typeof input[key] !== 'boolean') throw new TypeError(`${name}.${key} must be a boolean.`);
  return input[key] as boolean;
}

/** A notification device: NOTIFICATION_PC_DEVICE_ID or a paired client id. */
export function requiredNotificationDeviceId(value: unknown): string {
  if (typeof value !== 'string' || !NOTIFICATION_DEVICE_ID.test(value)) {
    throw new TypeError('notification device id is invalid.');
  }
  return value;
}

export function requiredNotificationPreferencesPatch(value: unknown): NotificationPreferencesPatch {
  const input = plainRecord(value, 'notification preferences');
  onlyKeys(input, NOTIFICATION_PATCH_KEYS, 'notification preferences');
  const patch: NotificationPreferencesPatch = {};
  if (input.scope !== undefined) {
    if (input.scope !== 'all' && input.scope !== 'bots' && input.scope !== 'off') {
      throw new TypeError('notification scope is invalid.');
    }
    patch.scope = input.scope;
  }
  if (input.events !== undefined) {
    const events = plainRecord(input.events, 'notification events');
    onlyKeys(events, new Set(NOTIFICATION_EVENTS), 'notification events');
    patch.events = {};
    for (const event of NOTIFICATION_EVENTS) {
      const enabled = optionalBoolean(events, event, 'notification events');
      if (enabled !== undefined) patch.events[event] = enabled;
    }
  }
  if (input.quietHours !== undefined) {
    const quiet = plainRecord(input.quietHours, 'quiet hours');
    onlyKeys(quiet, NOTIFICATION_QUIET_KEYS, 'quiet hours');
    patch.quietHours = {};
    for (const key of ['enabled', 'allowWaiting'] as const) {
      const flag = optionalBoolean(quiet, key, 'quiet hours');
      if (flag !== undefined) patch.quietHours[key] = flag;
    }
    for (const key of ['start', 'end'] as const) {
      if (quiet[key] === undefined) continue;
      if (typeof quiet[key] !== 'string' || !NOTIFICATION_TIME.test(quiet[key] as string)) {
        throw new TypeError(`quiet hours ${key} must be HH:MM.`);
      }
      patch.quietHours[key] = quiet[key] as string;
    }
    if (quiet.days !== undefined) {
      if (quiet.days !== 'every' && quiet.days !== 'weekdays' && quiet.days !== 'weekends') {
        throw new TypeError('quiet hours days is invalid.');
      }
      patch.quietHours.days = quiet.days;
    }
  }
  for (const key of ['automaticRuns', 'holdWhileDesktopActive', 'taskbarFlash'] as const) {
    const flag = optionalBoolean(input, key, 'notification preferences');
    if (flag !== undefined) patch[key] = flag;
  }
  return patch;
}

export function requiredNotificationTarget(value: unknown): NotificationTarget {
  const input = plainRecord(value, 'notification target');
  onlyKeys(input, new Set(['kind', 'id']), 'notification target');
  if (input.kind !== 'session' && input.kind !== 'agent' && input.kind !== 'room') {
    throw new TypeError('notification target kind is invalid.');
  }
  if (typeof input.id !== 'string' || !NOTIFICATION_TARGET_ID.test(input.id)) {
    throw new TypeError('notification target id is invalid.');
  }
  return { kind: input.kind, id: input.id };
}

export function requiredConversationNotificationSetting(value: unknown): ConversationNotificationSetting {
  const input = plainRecord(value, 'notification setting');
  if (input.mode === 'inherit' || input.mode === 'always') {
    onlyKeys(input, new Set(['mode']), 'notification setting');
    return { mode: input.mode };
  }
  if (input.mode !== 'muted') throw new TypeError('notification setting mode is invalid.');
  onlyKeys(input, new Set(['mode', 'until']), 'notification setting');
  const until = input.until;
  if (until !== null && !(Number.isSafeInteger(until) && (until as number) > 0)) {
    throw new TypeError('notification mute end must be epoch milliseconds or null.');
  }
  return { mode: 'muted', until: until as number | null };
}

const LSP_REQUEST_METHOD_SET: ReadonlySet<string> = new Set(DESKTOP_LSP_REQUEST_METHODS);
const LSP_DOCUMENT_KEYS = new Set(['kind', 'projectPath', 'relPath', 'languageId', 'version', 'content']);
const LSP_REQUEST_KEYS = new Set(['projectPath', 'relPath', 'languageId', 'method', 'params']);
const WORKSPACE_WRITE_KEYS = new Set(['relPath', 'content', 'expectedContent']);
const WORKSPACE_SEARCH_KEYS = new Set(['query', 'include', 'exclude', 'matchCase', 'wholeWord', 'regex', 'maxResults']);
const MAX_TEXT_FILE_LENGTH = 4_194_304;

interface DesktopWorkspaceSearchOptionsInput {
  query: string;
  include?: string;
  exclude?: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  maxResults: number;
}

/** Editor/LSP payload body: the same 4 MiB ceiling every text lane uses. */
export function requiredTextFileContent(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT_FILE_LENGTH) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

export function requiredTextFileEncoding(value: unknown): DesktopTextFileEncoding | undefined {
  // The remote lane is JSON: an omitted encoding arrives as `null`.
  if (value === undefined || value === null) return undefined;
  if (value === 'utf8' || value === 'utf8bom' || value === 'utf16le' || value === 'utf16be') {
    return value;
  }
  throw new TypeError('file encoding is invalid.');
}

export function requiredLspDocumentInput(value: unknown): DesktopLspDocumentInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('LSP document input is invalid.');
  }
  const input = value as Record<string, unknown>;
  requireAllowedKeys(input, LSP_DOCUMENT_KEYS, 'LSP document input');
  if (input.kind !== 'open' && input.kind !== 'change' && input.kind !== 'save' && input.kind !== 'close') {
    throw new TypeError('LSP document kind is invalid.');
  }
  if (!Number.isInteger(input.version) || Number(input.version) < 0) {
    throw new TypeError('LSP document version is invalid.');
  }
  if (
    input.content !== undefined &&
    (typeof input.content !== 'string' || input.content.length > MAX_TEXT_FILE_LENGTH)
  ) {
    throw new TypeError('LSP document content is invalid.');
  }
  return {
    kind: input.kind,
    projectPath: requiredString(input.projectPath, 'projectPath'),
    relPath: requiredString(input.relPath, 'relPath', 4_096),
    languageId: requiredString(input.languageId, 'languageId', 64),
    version: Number(input.version),
    ...(typeof input.content === 'string' ? { content: input.content } : {}),
  };
}

export function requiredLspRequestInput(value: unknown): DesktopLspRequestInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('LSP request input is invalid.');
  }
  const input = value as Record<string, unknown>;
  requireAllowedKeys(input, LSP_REQUEST_KEYS, 'LSP request input');
  const method = requiredString(input.method, 'LSP method', 128);
  if (!LSP_REQUEST_METHOD_SET.has(method)) throw new TypeError('LSP method is unavailable.');
  const params = input.params === undefined ? {} : input.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('LSP params are invalid.');
  }
  validateStructuredValue(params);
  return {
    projectPath: requiredString(input.projectPath, 'projectPath'),
    relPath: requiredString(input.relPath, 'relPath', 4_096),
    languageId: requiredString(input.languageId, 'languageId', 64),
    method: method as DesktopLspRequestMethod,
    params: params as Record<string, unknown>,
  };
}

export function requiredWorkspaceTextWrites(value: unknown): DesktopWorkspaceTextWrite[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new TypeError('Workspace edit files are invalid.');
  }
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError('Workspace edit file is invalid.');
    }
    const record = row as Record<string, unknown>;
    requireAllowedKeys(record, WORKSPACE_WRITE_KEYS, 'Workspace edit file');
    if (
      typeof record.content !== 'string' ||
      record.content.length > MAX_TEXT_FILE_LENGTH ||
      typeof record.expectedContent !== 'string' ||
      record.expectedContent.length > MAX_TEXT_FILE_LENGTH
    ) {
      throw new TypeError('Workspace edit file content is invalid.');
    }
    return {
      relPath: requiredString(record.relPath, 'relPath', 4_096),
      content: record.content,
      expectedContent: record.expectedContent,
    };
  });
}

export function requiredWorkspaceSearchOptions(value: unknown): DesktopWorkspaceSearchOptionsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Workspace search options are invalid.');
  }
  const input = value as Record<string, unknown>;
  requireAllowedKeys(input, WORKSPACE_SEARCH_KEYS, 'Workspace search options');
  return {
    query: requiredString(input.query, 'search query', 4_096),
    ...(typeof input.include === 'string' ? { include: input.include.slice(0, 4_096) } : {}),
    ...(typeof input.exclude === 'string' ? { exclude: input.exclude.slice(0, 4_096) } : {}),
    matchCase: input.matchCase === true,
    wholeWord: input.wholeWord === true,
    regex: input.regex === true,
    maxResults: requiredWorkspaceSearchLimit(input.maxResults),
  };
}

export function requiredWorkspaceFolders(value: unknown): DesktopWorkspaceFolder[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError('Workspace folders are invalid.');
  }
  const seen = new Set<string>();
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError('Workspace folder is invalid.');
    }
    const record = row as Record<string, unknown>;
    const path = resolvePath(requiredString(record.path, 'workspace folder path', 16_384));
    if (!pathIsAbsolute(path)) throw new TypeError('Workspace folder path must be absolute.');
    const key = process.platform === 'win32' ? path.toLocaleLowerCase() : path;
    if (seen.has(key)) throw new TypeError('Workspace folders must be unique.');
    seen.add(key);
    return {
      path,
      ...(typeof record.name === 'string' && record.name.trim() ? { name: record.name.trim().slice(0, 200) } : {}),
    };
  });
}

// ---- Desktop pet (main/desktop-pet-window.ts) --------------------------------

const PET_KEY_MAX = 256;
const PET_NAME_MAX = 200;
const PET_AVATAR_MAX = 4_096;
const PET_MEMBERS_MAX = 4;

function petObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function petText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || hasControlCharacter(value)) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function requiredDesktopPetBubble(value: unknown): DesktopPetBubble {
  const bubble = petObject(value, 'pet bubble');
  const kind = bubble.kind;
  if (kind === 'idle' || kind === 'working' || kind === 'approval') return { kind };
  if (kind !== 'reply') throw new TypeError('pet bubble kind is invalid.');
  const key = petText(bubble.key, 'pet bubble key', PET_KEY_MAX);
  // Markdown source: line breaks, no other control characters.
  if (typeof bubble.text !== 'string' || bubble.text.length > DESKTOP_PET_REPLY_MAX) {
    throw new TypeError('pet bubble text is invalid.');
  }
  for (const line of bubble.text.split('\n')) petText(line, 'pet bubble text', DESKTOP_PET_REPLY_MAX);
  return { kind, key, text: bubble.text };
}

/** A plain JSON look (mascot picks or custom file names), bounded. */
function petAvatar(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const text = JSON.stringify(petObject(value, 'pet avatar'));
  if (text.length > PET_AVATAR_MAX) throw new TypeError('pet avatar is too large.');
  return JSON.parse(text);
}

/** The app window's published state for Mixy's chat: no field
 *  beyond the session id, the bubble and the face is kept. */
export function requiredDesktopPetState(value: unknown): DesktopPetState {
  const state = petObject(value, 'pet state');
  const sessionId = state.sessionId === '' ? '' : requiredSessionId(state.sessionId);
  const face = petObject(state.face, 'pet face');
  if (!Array.isArray(face.members) || face.members.length > PET_MEMBERS_MAX) {
    throw new TypeError('pet face members are invalid.');
  }
  return {
    sessionId,
    bubble: requiredDesktopPetBubble(state.bubble),
    face: {
      room: face.room === true,
      members: face.members.map((entry) => {
        const member = petObject(entry, 'pet member');
        return {
          id: requiredString(member.id, 'pet member id', PET_KEY_MAX),
          name: petText(member.name, 'pet member name', PET_NAME_MAX),
          avatar: petAvatar(member.avatar),
        };
      }),
    },
    quiet: state.quiet === true,
  };
}

/** A quick message: plain text, trimmed, within the send limit. */
export function requiredDesktopPetText(value: unknown): string {
  return requiredString(value, 'pet message', DESKTOP_PET_MAX_TEXT);
}

export function requiredDesktopPetDrag(value: unknown): DesktopPetDrag {
  const drag = petObject(value, 'pet drag');
  const { phase, screenX, screenY } = drag;
  if (phase !== 'start' && phase !== 'move' && phase !== 'end') throw new TypeError('pet drag phase is invalid.');
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) throw new TypeError('pet drag point is invalid.');
  return { phase, screenX: Math.round(screenX as number), screenY: Math.round(screenY as number) };
}

/** The app window's composer card (CSS px), or null when none shows. */
export function requiredDesktopPetComposerRect(value: unknown): DesktopPetRect | null {
  if (value === null) return null;
  const rect = petObject(value, 'pet composer rect');
  const out = { x: 0, y: 0, width: 0, height: 0 };
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const number = rect[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > 100_000) {
      throw new TypeError('pet composer rect is invalid.');
    }
    out[key] = Math.round(number);
  }
  if (out.width < 0 || out.height < 0) throw new TypeError('pet composer rect is invalid.');
  return out;
}

/** The composer card plus its island pill's centre line (CSS px; null when
 *  no pill shows), or null when no card shows. */
export function requiredDesktopPetComposer(value: unknown): DesktopPetComposer | null {
  const rect = requiredDesktopPetComposerRect(value);
  if (!rect) return null;
  const { transcript } = value as { transcript?: unknown };
  const column = requiredDesktopPetTranscriptColumn(transcript);
  return { ...requiredDesktopPetIsland(rect, value), ...(column ? { transcript: column } : {}) };
}

function petCoordinate(number: unknown, what: string): number {
  if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > 100_000) {
    throw new TypeError(`pet composer ${what} is invalid.`);
  }
  return Math.round(number);
}

/** The transcript column beside the card (left ≤ right), or none. */
function requiredDesktopPetTranscriptColumn(value: unknown): DesktopPetComposer['transcript'] {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new TypeError('pet composer transcript is invalid.');
  const { left, right, bottom } = value as { left?: unknown; right?: unknown; bottom?: unknown };
  const column = {
    left: petCoordinate(left, 'transcript'),
    right: petCoordinate(right, 'transcript'),
    bottom: petCoordinate(bottom, 'transcript'),
  };
  if (column.right < column.left) throw new TypeError('pet composer transcript is invalid.');
  return column;
}

function requiredDesktopPetIsland(rect: DesktopPetRect, value: unknown): DesktopPetComposer {
  const { island, islandSpan } = value as { island?: unknown; islandSpan?: unknown };
  if (island === undefined || island === null) return { ...rect, island: null };
  const line = petCoordinate(island, 'island');
  if (islandSpan === undefined || islandSpan === null) return { ...rect, island: line };
  if (typeof islandSpan !== 'object') throw new TypeError('pet composer island is invalid.');
  const span = islandSpan as { left?: unknown; right?: unknown; top?: unknown };
  const left = petCoordinate(span.left, 'island');
  const right = petCoordinate(span.right, 'island');
  const top = petCoordinate(span.top, 'island');
  if (right < left || top > line) throw new TypeError('pet composer island is invalid.');
  return { ...rect, island: line, islandSpan: { left, right, top } };
}

/** The bot's size: one of the offered percentages (50–200, step 10). */
export function requiredDesktopPetScale(value: unknown): number {
  if (typeof value !== 'number' || !DESKTOP_PET_SCALES.includes(value)) {
    throw new TypeError('pet scale is invalid.');
  }
  return value;
}

/** One overlay option Settings sets by name, with its on/off value. */
export function requiredDesktopPetOption(name: unknown, value: unknown): { name: DesktopPetOption; value: boolean } {
  if (typeof name !== 'string' || !(DESKTOP_PET_OPTIONS as readonly string[]).includes(name)) {
    throw new TypeError('pet option is invalid.');
  }
  if (typeof value !== 'boolean') throw new TypeError('pet option value must be a boolean.');
  return { name: name as DesktopPetOption, value };
}

/** The app's open floating layers: the backdrop flag and at most
 *  DESKTOP_PET_MAX_LAYERS transient rects (CSS px). */
export function requiredDesktopPetLayers(value: unknown): DesktopPetLayers {
  const { backdrop, rects } = petObject(value, 'pet layers');
  if (typeof backdrop !== 'boolean') throw new TypeError('pet layers backdrop must be a boolean.');
  if (!Array.isArray(rects) || rects.length > DESKTOP_PET_MAX_LAYERS) throw new TypeError('pet layers are invalid.');
  return {
    backdrop,
    rects: rects.map((rect) => {
      const checked = requiredDesktopPetComposerRect(rect);
      if (!checked) throw new TypeError('pet layer is invalid.');
      return checked;
    }),
  };
}

const PET_THEME_VALUE_MAX = 400;

/** The app's chat look for the pet: only the listed tokens, plain values
 *  (no url(), no rule breaks). */
export function requiredDesktopPetTheme(value: unknown): DesktopPetTheme {
  const theme = petObject(value, 'pet theme');
  if (theme.scheme !== 'light' && theme.scheme !== 'dark') throw new TypeError('pet theme scheme is invalid.');
  const raw = petObject(theme.vars, 'pet theme vars');
  const vars: Record<string, string> = {};
  for (const name of DESKTOP_PET_THEME_VARS) {
    const entry = raw[name];
    if (entry === undefined) continue;
    if (
      typeof entry !== 'string' ||
      entry.length > PET_THEME_VALUE_MAX ||
      /[;{}<>\\\u0000-\u001f]/.test(entry) ||
      /url\s*\(/i.test(entry)
    ) {
      throw new TypeError(`pet theme value ${name} is invalid.`);
    }
    vars[name] = entry.trim();
  }
  return { scheme: theme.scheme, vars };
}

export function requiredDesktopPetCommand(value: unknown): DesktopPetCommand {
  if (typeof value !== 'string' || !(DESKTOP_PET_COMMANDS as readonly string[]).includes(value)) {
    throw new TypeError('pet command is invalid.');
  }
  return value as DesktopPetCommand;
}

/** An arrow-key nudge: at most 64px on each axis. */
export function requiredDesktopPetNudge(dx: unknown, dy: unknown): { dx: number; dy: number } {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new TypeError('pet nudge is invalid.');
  const bound = (value: number) => Math.max(-64, Math.min(64, Math.round(value)));
  return { dx: bound(dx as number), dy: bound(dy as number) };
}
