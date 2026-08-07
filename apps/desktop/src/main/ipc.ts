// Explicit handler/preload registration:
// arbitrary renderer-selected method execution is intentionally absent.
import type {
  App,
  BrowserWindow,
  Dialog,
  IpcMain,
  IpcMainInvokeEvent,
  PowerMonitor,
  Shell,
} from 'electron';

import { randomUUID } from 'node:crypto';
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename as pathBasename,
  dirname as pathDirname,
  isAbsolute as pathIsAbsolute,
  relative as pathRelative,
  sep as pathSep,
  resolve as resolvePath,
} from 'node:path';
import {
  DESKTOP_CAPABILITIES,
  DESKTOP_GIT_GLOBAL_CONFIG_KEYS,
  DESKTOP_IPC,
  DESKTOP_LSP_REQUEST_METHODS,
  DESKTOP_READ_CAPABILITIES,
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
  type DesktopRemoteAccessInfo,
  type DesktopSettingKey,
  type DesktopSettings,
  type DesktopSubmitOptions,
  type DesktopUpdaterState,
  type DesktopWorkspace,
  type DesktopWorkspaceFolder,
  type DesktopWorkspaceTextWrite,
  type SessionSnapshot,
  type ToolApprovalDecision,
} from '../shared/contract';
import { requiredSessionId } from './desktop-state';
import type { TerminalSpawnProfile } from './terminal-contract';
import type { DesktopService } from './desktop-service-contract';
import { registerFilePreview } from './file-preview';
import {
  browsableFolderPath,
  listFolderPlaces,
} from './folder-explorer';
import {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  requiredRepositoryCwd,
} from './git-contract.mjs';
import {
  projectEntryPathIn,
} from './project-files';
import type { DesktopSettingsStore } from './settings-store';
import {
  createSnapshotDeltaEncoder,
  releaseHiddenSessionStateEntries,
  shouldPublishSessionState,
  type SnapshotDeltaEncoder,
} from './state-delta';
import { TerminalDataBufferer } from './terminal-data-buffer';

const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_IMAGE_BASE64_LENGTH = 16_000_000;
// 20 MiB of raw attachment bytes per submit (~28M base64).
const MAX_FILE_BASE64_LENGTH = 28_000_000;

const SERVICE_OPERATION_NAMES = [
  'githubStarStatus', 'starGithub', 'githubCliStatus', 'installGithubCli',
  'githubCliLoginStart', 'githubCliLoginStatus', 'cancelGithubCliLogin',
  'githubCliLogout', 'githubCliAccount', 'gitGlobalConfig', 'setGitGlobalConfig',
  'gitAbortOperation', 'gitAmend', 'gitApplyPatch', 'gitBranches',
  'gitCheckoutBranch', 'gitCheckoutCommit', 'gitCherryPickCommit', 'gitCommit',
  'gitCommitPaths', 'gitContinue', 'gitCreateBranch', 'gitCreateBranchAtCommit',
  'gitCreateTag', 'gitDeleteBranch', 'gitDeleteTag', 'gitDiff', 'gitFetch',
  'gitIgnore', 'gitLog', 'gitMergeBranch', 'gitPull', 'gitPush',
  'gitRenameBranch', 'gitResetToCommit', 'gitRevertCommit', 'gitRevertFile',
  'gitReview', 'gitReviewDiff', 'gitShow', 'gitShowDiff', 'gitShowFile',
  'gitStage', 'gitStash', 'gitStashApply', 'gitStashDrop', 'gitStashList',
  'gitStashPop', 'gitStatus', 'gitSync', 'gitUndoLastCommit', 'gitUnstage',
  'ghPrCheckout', 'ghPrCreate', 'ghPrDefaultBranch', 'ghPrDiff', 'ghPrList',
  'ghPrMerge', 'ghPrView',
] as const;
const MAX_STRUCTURED_STRING_TOTAL = 32_000_000;
const CAPABILITY_SET = new Set<string>(DESKTOP_CAPABILITIES);
const READ_CAPABILITY_SET = new Set<string>(DESKTOP_READ_CAPABILITIES);
const BOOLEAN_FIRST_CAPABILITIES = new Set<DesktopCapability>([
  'setAutoUpdate', 'setRecapEnabled', 'setChannelsEnabled',
]);
const BOOLEAN_SECOND_CAPABILITIES = new Set<DesktopCapability>([
  'setMcpServerEnabled', 'setHookRuleEnabled', 'setScheduleEnabled', 'setWebhookEnabled',
]);
const SUBMIT_OPTION_KEYS = new Set([
  'id', 'submittedAt', 'displayText', 'priority', 'pastedImages', 'pastedTexts',
]);
const ABORT_OPTION_KEYS = new Set(['restorePrompt']);
const NEW_TASK_DRAFT_KEYS = new Set(['projectPath', 'route', 'workflowId', 'remote']);
const CAPABILITY_REQUEST_KEYS = new Set(['capability', 'args', 'sessionId']);
const MODEL_SELECTION_KEYS = new Set(['provider', 'model', 'effort', 'fast']);
const MODEL_CATALOG_OPTION_KEYS = new Set(['force', 'refresh', 'quick']);
const PROVIDER_SETUP_OPTION_KEYS = new Set(['force', 'refresh']);
const TOOL_APPROVAL_KEYS = new Set(['approved', 'reason']);
const LSP_REQUEST_METHODS: ReadonlySet<string> = new Set(DESKTOP_LSP_REQUEST_METHODS);
const isDesktopLspRequestMethod = (method: string): method is DesktopLspRequestMethod =>
  LSP_REQUEST_METHODS.has(method);

const CAPABILITY_ARITY = {
  restoreQueued: [0, 2], rewindToItem: [1, 1], setEffort: [1, 1], setToolMode: [1, 1], getAutoClear: [0, 0],
  setAutoClear: [0, 1], getUpdateSettings: [0, 0], setAutoUpdate: [1, 1], checkForUpdate: [0, 1],
  runUpdateNow: [0, 0], getUpdateStatus: [0, 0], getProfile: [0, 0], setProfile: [0, 1],
  getCompactionSettings: [0, 0], setCompactionSettings: [0, 1], getRecapSettings: [0, 0],
  setRecapEnabled: [1, 1], getChannelSettings: [0, 1], setChannelsEnabled: [1, 1],
  getVoiceStatus: [0, 0], toggleVoice: [0, 0],
  // agentControl accepts (args, { silent }) — the dock agent viewer's read.
  agentControl: [0, 2], toolsStatus: [0, 1], selectTools: [1, 1], getSystemShell: [0, 0],
  setSystemShell: [1, 1], mcpStatus: [0, 0], reconnectMcp: [0, 0], addMcpServer: [1, 1],
  removeMcpServer: [1, 1], setMcpServerEnabled: [2, 2], getDisabledSkills: [0, 0],
  setDisabledSkills: [1, 1], skillsStatus: [0, 0], skillContent: [1, 1], addSkill: [1, 1],
  reloadSkills: [0, 0], pluginsStatus: [0, 0], reloadPlugins: [0, 0], addPlugin: [1, 1],
  updatePlugin: [1, 1], removePlugin: [1, 1], enablePluginMcp: [1, 1], hooksStatus: [0, 0],
  contextStatus: [0, 0], addHookRule: [1, 1], setHookRuleEnabled: [2, 2], deleteHookRule: [1, 1],
  memoryControl: [0, 2], recall: [1, 2], runDoctor: [0, 0], compact: [0, 0], listPresets: [0, 0],
  setModel: [1, 1],
  getSearchRoute: [0, 0], listSearchModels: [0, 1], setSearchRoute: [1, 1], listAgents: [0, 0],
  listWorkflows: [0, 0], getOutputStyle: [0, 0], listOutputStyles: [0, 0], setOutputStyle: [1, 1],
  setWorkflow: [1, 1], toggleRemote: [0, 0], claimRemote: [0, 0], releaseRemote: [0, 0], isRemoteEnabled: [0, 0],
  getWorkflowPack: [1, 1], saveWorkflowPack: [1, 1], createWorkflow: [1, 1], deleteWorkflow: [1, 1],
  getAgentDefinition: [1, 1], saveAgentDefinition: [1, 1], deleteAgentDefinition: [1, 1],
  listThemes: [0, 0], getTheme: [0, 0], setTheme: [1, 2], setAgentRoute: [2, 2],
  listProviders: [0, 0], listProviderModels: [0, 1], getProviderSetup: [0, 1],
  getUsageDashboard: [0, 1], consumeCodexRateLimitResetCredit: [1, 1],
  getTurnReviewDiff: [0, 0], revertTurnReviewFile: [1, 1],
  getOnboardingStatus: [0, 0], skipOnboarding: [0, 0],
  completeOnboarding: [0, 1], loginOAuthProvider: [1, 1], beginOAuthProviderLogin: [1, 1],
  getOAuthProviderLoginStatus: [1, 1], completeOAuthProviderLogin: [2, 2], cancelOAuthProviderLogin: [1, 1],
  saveProviderApiKey: [2, 2], saveOpenCodeGoUsageAuth: [1, 1], loginOpenCodeGoUsage: [0, 0],
  saveOpenAIUsageSessionKey: [1, 1], setLocalProvider: [2, 2], authenticateProvider: [2, 2],
  forgetProviderAuth: [1, 1], getChannelSetup: [0, 0], getChannelWorkerStatus: [0, 0],
  setChannelProvider: [1, 1], saveDiscordToken: [1, 1], forgetDiscordToken: [0, 0],
  saveTelegramToken: [1, 1], forgetTelegramToken: [0, 0],
  setChannel: [1, 1], setWebhookConfig: [1, 1],
  saveSchedule: [1, 1], deleteSchedule: [1, 1], setScheduleEnabled: [2, 2], runScheduleNow: [1, 1], saveWebhook: [1, 1],
  deleteWebhook: [1, 1], setWebhookEnabled: [2, 2], clear: [0, 0], transcribeAudio: [1, 1],
  resizeImage: [1, 1],
  listMediaLanes: [0, 0], listMediaAssets: [0, 1], readMediaAsset: [1, 2],
  cacheMediaThumbnail: [2, 2],
  resolveMediaFile: [1, 2],
  getMediaJob: [1, 1], startMediaJob: [1, 1],
  cancelMediaJob: [1, 1], deleteMediaAsset: [1, 1], openMediaAsset: [1, 1],
  openMediaFolder: [0, 1],
} as const satisfies Record<DesktopCapability, readonly [number, number]>;

export function requiredString(value: unknown, name: string, maximum = 32_768): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new TypeError(`${name} is invalid.`);
  return text;
}

function requiredGitGlobalConfigKey(value: unknown): DesktopGitGlobalConfigKey {
  if (
    typeof value === 'string'
    && (DESKTOP_GIT_GLOBAL_CONFIG_KEYS as readonly string[]).includes(value)
  ) {
    return value as DesktopGitGlobalConfigKey;
  }
  throw new TypeError('key must be user.name, user.email, or init.defaultBranch.');
}

function requireAllowedKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  name: string,
): void {
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError(`${name} contains an unsupported field.`);
  }
}

export function projectDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('alias must be a string.');
  const text = value.trim();
  if (text.length > 120 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError('alias is invalid.');
  }
  return text;
}

export function sessionDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('title must be a string.');
  const text = value.trim();
  if (!text || text.length > 1_024 || /[\u0000-\u001f\u007f]/.test(text)) {
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

export function requiredWorkspaceSearchLimit(value: unknown): number {
  if (value === undefined) return 2_000;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5_000) {
    throw new TypeError('maxResults is invalid.');
  }
  return value as number;
}

function validateStructuredValue(
  value: unknown,
  state = { strings: 0, nodes: 0 },
  depth = 0,
): void {
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
      if (imageCount > 8) throw new TypeError('too many prompt images.');
      const mimeType = requiredString(part.mimeType, 'image mime type', 64).toLowerCase();
      if (!/^image\/(?:png|jpe?g|gif|webp)$/.test(mimeType)) {
        throw new TypeError('image type is unsupported.');
      }
      if (typeof part.data !== 'string' || !part.data || part.data.length > MAX_IMAGE_BASE64_LENGTH ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) {
        throw new TypeError('image data is invalid.');
      }
      imageLength += part.data.length;
      if (imageLength > 48_000_000) throw new TypeError('prompt images are too large.');
      hasContent = true;
      return { type: 'image' as const, data: part.data, mimeType };
    }
    if (part.type === 'file') {
      fileCount += 1;
      if (fileCount > 4) throw new TypeError('too many prompt files.');
      const mimeType = requiredString(part.mimeType, 'file mime type', 64).toLowerCase();
      if (mimeType !== 'application/pdf') {
        throw new TypeError('file type is unsupported.');
      }
      if (typeof part.data !== 'string' || !part.data || part.data.length > MAX_FILE_BASE64_LENGTH ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) {
        throw new TypeError('file data is invalid.');
      }
      fileLength += part.data.length;
      if (fileLength > MAX_FILE_BASE64_LENGTH) throw new TypeError('prompt files are too large.');
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
  if (input.id !== undefined &&
    (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(input.id))) {
    throw new TypeError('submit id is invalid.');
  }
  if (input.submittedAt !== undefined &&
    (!Number.isSafeInteger(input.submittedAt) || (input.submittedAt as number) <= 0)) {
    throw new TypeError('submit timestamp is invalid.');
  }
  const priority = input.priority;
  if (priority !== undefined && priority !== 'now' && priority !== 'next' && priority !== 'later') {
    throw new TypeError('submit priority is invalid.');
  }
  if (input.displayText !== undefined &&
    (typeof input.displayText !== 'string' || input.displayText.length > MAX_PROMPT_LENGTH)) {
    throw new TypeError('submit display text is invalid.');
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
  const projectPath = input.projectPath === undefined
    ? ''
    : requiredString(input.projectPath, 'projectPath');
  const route = input.route === undefined ? undefined : requiredModelSelection(input.route);
  const workflowId = input.workflowId === undefined
    ? ''
    : requiredString(input.workflowId, 'workflowId', 256);
  if (input.remote !== undefined && typeof input.remote !== 'boolean') {
    throw new TypeError('new task remote flag is invalid.');
  }
  return {
    ...(projectPath ? { projectPath } : {}),
    ...(route ? { route } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(input.remote === true ? { remote: true } : {}),
  };
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
  if (BOOLEAN_FIRST_CAPABILITIES.has(capability) && typeof args[0] !== 'boolean') {
    throw new TypeError(`${capability} requires a boolean value.`);
  }
  if (BOOLEAN_SECOND_CAPABILITIES.has(capability) && typeof args[1] !== 'boolean') {
    throw new TypeError(`${capability} requires a boolean value.`);
  }
  if (capability === 'setModel') requiredString(args[0], 'model selector', 512);
  const validateSecret = (secret: unknown, name: string) => {
    if (typeof secret !== 'string' || !secret.trim() || secret.length > 65_536) {
      throw new TypeError(`${name} is invalid.`);
    }
  };
  if (capability === 'saveProviderApiKey' || capability === 'authenticateProvider') {
    validateSecret(args[1], 'provider secret');
  }
  if (capability === 'saveOpenAIUsageSessionKey' || capability === 'saveDiscordToken' ||
    capability === 'saveTelegramToken') {
    validateSecret(args[0], 'secret');
  }
  if (capability === 'saveOpenCodeGoUsageAuth') {
    const options = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
      ? args[0] as Record<string, unknown> : null;
    if (!options) throw new TypeError('OpenCode Go usage auth is invalid.');
    validateSecret(options.authCookie, 'OpenCode Go auth cookie');
    if (options.workspaceId !== undefined &&
      (typeof options.workspaceId !== 'string' || options.workspaceId.length > 256)) {
      throw new TypeError('OpenCode Go workspace id is invalid.');
    }
  }
  if (capability === 'getProviderSetup' && args[0] !== undefined) {
    const options = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
      ? args[0] as Record<string, unknown> : null;
    if (!options || Object.entries(options).some(([key, option]) =>
      !PROVIDER_SETUP_OPTION_KEYS.has(key) || typeof option !== 'boolean')) {
      throw new TypeError('provider setup options are invalid.');
    }
  }
  // The issuing surface's session, when it has one: a command belongs to the
  // session that surface paints, never to whatever holds focus.
  const sessionId = input.sessionId === undefined || input.sessionId === null
      || input.sessionId === ''
    ? undefined
    : requiredSessionId(input.sessionId);
  return { capability, args, ...(sessionId ? { sessionId } : {}) };
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
  if (effort !== undefined && typeof effort !== 'string') {
    throw new TypeError('selection.effort must be a string.');
  }
  if (fast !== undefined && typeof fast !== 'boolean') {
    throw new TypeError('selection.fast must be a boolean.');
  }
  return {
    provider: requiredString(selection.provider, 'selection.provider', 256),
    model: requiredString(selection.model, 'selection.model', 512),
    ...(effort === undefined ? {} : { effort: requiredString(effort, 'selection.effort', 64) }),
    ...(fast === undefined ? {} : { fast }),
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
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    typeof (value as ToolApprovalDecision).approved !== 'boolean') {
    throw new TypeError('decision is invalid.');
  }
  requireAllowedKeys(value as Record<string, unknown>, TOOL_APPROVAL_KEYS, 'decision');
  const decision = value as ToolApprovalDecision;
  if (decision.reason !== undefined &&
    (typeof decision.reason !== 'string' || decision.reason.length > 4_096)) {
    throw new TypeError('decision.reason is invalid.');
  }
  return { approved: decision.approved, reason: decision.reason };
}

export function requiredGitPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new TypeError('git paths are invalid.');
  }
  return value.map(requiredGitPath);
}

export function requiredCommitMessageFiles(
  value: unknown,
): Array<{ path: string; untracked?: boolean }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new TypeError('git files are invalid.');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('git file is invalid.');
    }
    const record = entry as Record<string, unknown>;
    return {
      path: requiredGitPath(record.path),
      ...(record.untracked === true ? { untracked: true as const } : {}),
    };
  });
}

export function requiredGitPath(value: unknown): string {
  const path = requiredString(value, 'git path', 4_096);
  if (pathIsAbsolute(path) || path.includes('\0') ||
    path.replace(/\\/g, '/').split('/').some((part) => part === '..')) {
    throw new TypeError('git path is invalid.');
  }
  return path;
}

export function requiredGitPatch(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_000_000
    || value.includes('\0')) {
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
  const branch = requiredString(value, 'git branch', 512).trim();
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

interface DesktopIpcDependencies {
  app: Pick<App, 'quit'> & Partial<Pick<App, 'getPath' | 'getFileIcon'>>;
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>
    & Partial<Pick<Dialog, 'showSaveDialog'>>;
  shell: Pick<Shell, 'openPath' | 'openExternal' | 'showItemInFolder' | 'trashItem'>;
  powerMonitor?: Pick<PowerMonitor, 'on' | 'removeListener'>;
  nativeImage?: Pick<typeof import('electron').nativeImage, 'createThumbnailFromPath'>;
  settingsStore?: Pick<DesktopSettingsStore,
    'read' | 'update' | 'readZoom' | 'updateZoom' | 'readGitPreferences' | 'updateGitPreferences'>;
  /** Fires after a successful desktop-settings write (keep-awake wiring). */
  onDesktopSettingsChanged?: (settings: DesktopSettings) => void;
  /** Settings → Connection pairing card; resolves null while the bridge is off. */
  remoteAccessInfo?: () => Promise<DesktopRemoteAccessInfo | null>;
  /** Settings → Connection: mint a new pairing token (revokes paired phones). */
  rotateRemoteAccess?: () => Promise<DesktopRemoteAccessInfo | null>;
  updater?: {
    getState(): DesktopUpdaterState;
    subscribe(listener: (state: DesktopUpdaterState) => void): () => void;
    check(): Promise<DesktopUpdaterState>;
    install(): Promise<void>;
  };
  terminals?: {
    ensure(id: string | null, cwd: string | null, profile?: TerminalSpawnProfile | string | null):
      { id: string; replay: string } | Promise<{ id: string; replay: string }>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    pauseOutput?(id: string): void;
    resumeOutput?(id: string): void;
    dispose(id: string): void;
    subscribe(listener: (event: { id: string; data: string }) => void): () => void;
  };
}

function requiredExternalUrl(value: unknown): string {
  const input = requiredString(value, 'url', 8_192);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError('url is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('url protocol is unsupported.');
  }
  return url.toString();
}

function requiredZoomFactor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.2 || value > 10) {
    throw new TypeError('zoom factor is invalid.');
  }
  return Math.round(value * 100) / 100;
}

export function requiredDesktopSettingKey(value: unknown): DesktopSettingKey {
  if (value === 'autoClear' || value === 'autoCompact' || value === 'keepAwake') return value;
  throw new TypeError('setting key is invalid.');
}

function requiredWorkspaceFolders(value: unknown): DesktopWorkspaceFolder[] {
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
      ...(typeof record.name === 'string' && record.name.trim()
        ? { name: record.name.trim().slice(0, 200) }
        : {}),
    };
  });
}

export function registerDesktopIpc(
  window: BrowserWindow,
  host: DesktopService,
  {
    app,
    ipcMain,
    dialog,
    shell,
    powerMonitor: powerMonitorRef,
    nativeImage: nativeImageRef,
    settingsStore,
    onDesktopSettingsChanged,
    updater,
    terminals,
    remoteAccessInfo,
    rotateRemoteAccess,
  }: DesktopIpcDependencies,
): () => void {
  let quitPromise: Promise<void> | null = null;
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('IPC call rejected.');
    }
  };
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertSender(event);
      return listener(event, ...args);
    });
  };
  const invokeDesktopOperation = <T>(
    method: string,
    args: unknown[],
  ): Promise<T> => host.invokeDesktopOperation(method, args) as Promise<T>;
  type ServiceOperation = (...args: any[]) => Promise<any>;
  const serviceOperation = (name: string): ServiceOperation =>
    (...args: unknown[]) => invokeDesktopOperation(name, args);
  const {
    githubStarStatus,
    starGithub,
    githubCliStatus,
    installGithubCli,
    githubCliLoginStart,
    githubCliLoginStatus,
    cancelGithubCliLogin,
    githubCliLogout,
    githubCliAccount,
    gitGlobalConfig,
    setGitGlobalConfig,
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
    gitShowFile,
    gitStage,
    gitStash,
    gitStashApply,
    gitStashDrop,
    gitStashList,
    gitStashPop,
    gitStatus,
    gitSync,
    gitUndoLastCommit,
    gitUnstage,
    ghPrCheckout,
    ghPrCreate,
    ghPrDefaultBranch,
    ghPrDiff,
    ghPrList,
    ghPrMerge,
    ghPrView,
  } = Object.fromEntries(SERVICE_OPERATION_NAMES
    .map((name) => [name, serviceOperation(name)])) as Record<
      (typeof SERVICE_OPERATION_NAMES)[number],
      ServiceOperation
    >;
  const selectedFileGrants = new Map<string, string>();
  let selectedFileGrantsLoaded = false;
  const selectedFileGrantStore = typeof app.getPath === 'function'
    ? resolvePath(app.getPath('userData'), 'selected-file-grants.json')
    : '';
  const loadSelectedFileGrants = async (): Promise<void> => {
    if (selectedFileGrantsLoaded) return;
    selectedFileGrantsLoaded = true;
    if (!selectedFileGrantStore) return;
    try {
      const rows = JSON.parse(await fsReadFile(selectedFileGrantStore, 'utf8')) as unknown;
      if (!Array.isArray(rows)) return;
      for (const row of rows.slice(-100)) {
        if (!row || typeof row !== 'object') continue;
        const token = String((row as Record<string, unknown>).token || '');
        const file = String((row as Record<string, unknown>).file || '');
        if (token && pathIsAbsolute(file)) selectedFileGrants.set(token, resolvePath(file));
      }
    } catch {
      // No grant store yet, or a corrupt convenience file: start empty.
    }
  };
  const persistSelectedFileGrants = async (): Promise<void> => {
    if (!selectedFileGrantStore) return;
    const rows = [...selectedFileGrants.entries()].slice(-100)
      .map(([token, file]) => ({ token, file }));
    await fsMkdir(pathDirname(selectedFileGrantStore), { recursive: true });
    await fsWriteFile(selectedFileGrantStore, JSON.stringify(rows), 'utf8');
  };
  const grantedFile = async (
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown,
  ): Promise<{ root: string; rel: string; absolute: string }> => {
    await loadSelectedFileGrants();
    const token = requiredString(accessToken, 'file access token', 128);
    const granted = selectedFileGrants.get(token);
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
  const editorFilePath = async (
    projectPath: unknown,
    relPath: unknown,
    accessToken: unknown,
  ): Promise<string> => {
    if (typeof accessToken === 'string' && accessToken) {
      return (await grantedFile(accessToken, projectPath, relPath)).absolute;
    }
    const project = requiredString(projectPath, 'projectPath');
    const rel = requiredString(relPath, 'relPath', 4_096);
    return projectEntryPathIn(await host.projectDirectory(project), rel);
  };
  const editorBackupRoot = typeof app.getPath === 'function'
    ? app.getPath('userData')
    : '';

  handle(DESKTOP_IPC.chooseProject, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a Mixdog project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(DESKTOP_IPC.chooseFolder, async () => {
    // PARENTLESS on purpose: the window-parented modal can fail to present on
    // Windows (IFileDialog silently auto-cancels ~5s later without ever
    // creating a dialog window — reproduced with a minimal Electron app).
    // The parentless dialog always presents; losing modality is acceptable.
    const result = await dialog.showOpenDialog({
      title: 'Open Folder',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  const requiredFolderPaths = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
      throw new TypeError('paths are invalid.');
    }
    return value.map((path) => browsableFolderPath(path));
  };
  handle(DESKTOP_IPC.listFolderDir, (_event, dir) =>
    invokeDesktopOperation('listFolderDirAbs', [browsableFolderPath(dir)]));
  handle(DESKTOP_IPC.createFolderEntry, (_event, dir, name, isDir) =>
    invokeDesktopOperation(
      'createFolderEntryAbs',
      [browsableFolderPath(dir), requiredString(name, 'name', 255), isDir === true],
    ));
  handle(DESKTOP_IPC.renameFolderEntry, (_event, path, newName) =>
    invokeDesktopOperation(
      'renameFolderEntryAbs',
      [browsableFolderPath(path), requiredString(newName, 'newName', 255)],
    ));
  handle(DESKTOP_IPC.moveFolderEntry, (_event, paths, targetDir, strategy) => {
    const sources = requiredFolderPaths(paths);
    const target = browsableFolderPath(targetDir);
    const mode = strategy === 'replace' || strategy === 'keepBoth' || strategy === 'skip'
      ? strategy
      : 'ask';
    // Replace keeps Electron's recoverable OS trash, but both the conflict
    // scan and the actual move execute in the daemon. If the second scan sees
    // a new race it reports conflicts instead of deleting anything.
    if (mode === 'replace') {
      return invokeDesktopOperation<{ conflicts?: string[]; moved: Array<{ from: string; to: string }> }>(
        'moveFolderEntriesAbs',
        [sources, target, 'ask'],
      ).then(async (first) => {
        if (!first.conflicts?.length) return first;
        for (const name of first.conflicts) {
          await shell.trashItem(resolvePath(target, pathBasename(name)));
        }
        return invokeDesktopOperation(
          'moveFolderEntriesAbs',
          [sources, target, 'ask'],
        );
      });
    }
    return invokeDesktopOperation(
      'moveFolderEntriesAbs',
      [sources, target, mode],
    );
  });
  handle(DESKTOP_IPC.copyFolderEntry, (_event, paths, targetDir) =>
    invokeDesktopOperation(
      'copyFolderEntriesAbs',
      [requiredFolderPaths(paths), browsableFolderPath(targetDir)],
    ));
  handle(DESKTOP_IPC.trashFolderEntry, async (_event, path) => {
    await shell.trashItem(browsableFolderPath(path));
  });
  handle(DESKTOP_IPC.openFolderEntry, async (_event, path) => {
    const failure = await shell.openPath(browsableFolderPath(path));
    if (failure) throw new Error(failure);
  });
  handle(DESKTOP_IPC.revealFolderEntry, async (_event, path) => {
    shell.showItemInFolder(browsableFolderPath(path));
  });
  handle(DESKTOP_IPC.folderPlaces, () =>
    listFolderPlaces(typeof app.getPath === 'function'
      ? (name) => app.getPath!(name)
      : undefined));
  handle(DESKTOP_IPC.folderEntryIcon, async (_event, path, thumbnail, size) => {
    const target = browsableFolderPath(path);
    const edge = Number.isFinite(Number(size))
      ? Math.max(32, Math.min(1024, Math.round(Number(size))))
      : 96;
    if (thumbnail === true && nativeImageRef?.createThumbnailFromPath) {
      try {
        const thumb = await nativeImageRef.createThumbnailFromPath(target, { width: edge, height: edge });
        if (!thumb.isEmpty()) return thumb.toDataURL();
      } catch { /* fall back to the shell icon */ }
    }
    if (typeof app.getFileIcon === 'function') {
      try {
        const icon = await app.getFileIcon(target, { size: 'large' });
        if (!icon.isEmpty()) return icon.toDataURL();
      } catch { /* renderer falls back to a generic glyph */ }
    }
    return '';
  });
  // Explorer pane live refresh is daemon-owned and refcounted there.
  handle(DESKTOP_IPC.folderWatch, (_event, dirRaw) => {
    const dir = browsableFolderPath(dirRaw);
    return invokeDesktopOperation('folderWatch', [dir]);
  });
  handle(DESKTOP_IPC.folderUnwatch, (_event, dirRaw) => {
    const dir = browsableFolderPath(dirRaw);
    return invokeDesktopOperation('folderUnwatch', [dir]);
  });
  handle(DESKTOP_IPC.chooseFile, async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open file',
      ...(typeof defaultPath === 'string' && pathIsAbsolute(defaultPath)
        ? { defaultPath }
        : {}),
      properties: ['openFile'],
    });
    const file = result.canceled ? '' : resolvePath(result.filePaths[0] || '');
    if (!file) return null;
    const projects = await host.listProjects().catch(() => []);
    const normalizedFile = process.platform === 'win32' ? file.toLocaleLowerCase() : file;
    const owner = projects
      .map((project) => ({ project, root: resolvePath(project.path) }))
      .filter(({ root }) => {
        const normalizedRoot = process.platform === 'win32' ? root.toLocaleLowerCase() : root;
        return normalizedFile.startsWith(normalizedRoot + pathSep)
          || normalizedFile === normalizedRoot;
      })
      .sort((left, right) => right.root.length - left.root.length)[0];
    if (owner) {
      return {
        projectPath: owner.project.path,
        relPath: pathRelative(owner.root, file).replace(/\\/g, '/'),
      };
    }
    await loadSelectedFileGrants();
    const accessToken = randomUUID();
    selectedFileGrants.set(accessToken, file);
    while (selectedFileGrants.size > 100) {
      const oldest = selectedFileGrants.keys().next().value;
      if (!oldest) break;
      selectedFileGrants.delete(oldest);
    }
    await persistSelectedFileGrants();
    return {
      projectPath: pathDirname(file),
      relPath: pathBasename(file),
      accessToken,
    };
  });
  handle(DESKTOP_IPC.chooseWorkspace, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Workspace',
      properties: ['openFile'],
      filters: [{ name: 'VS Code Workspace', extensions: ['code-workspace'] }],
    });
    const file = result.canceled ? '' : result.filePaths[0] || '';
    if (!file) return null;
    const workspace = await invokeDesktopOperation<DesktopWorkspace>(
      'readWorkspaceFile',
      [file],
    );
    for (const folder of workspace.folders) await host.addProject(folder.path);
    return workspace;
  });
  handle(DESKTOP_IPC.saveWorkspace, async (_event, workspaceFile, rawFolders) => {
    const folders = requiredWorkspaceFolders(rawFolders);
    let file = typeof workspaceFile === 'string' && workspaceFile.trim()
      ? resolvePath(workspaceFile)
      : '';
    if (!file) {
      if (typeof dialog.showSaveDialog !== 'function') {
        throw new Error('Workspace save dialog is unavailable.');
      }
      const result = await dialog.showSaveDialog(window, {
        title: 'Save Workspace As',
        defaultPath: 'workspace.code-workspace',
        filters: [{ name: 'VS Code Workspace', extensions: ['code-workspace'] }],
      });
      if (result.canceled || !result.filePath) return null;
      file = result.filePath;
    }
    return invokeDesktopOperation(
      'writeWorkspaceFile',
      [file, folders],
    );
  });
  handle(DESKTOP_IPC.readEditorSettings, async (
    _event,
    projectPath,
    relPath,
    workspaceFile,
  ) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    const workspace = typeof workspaceFile === 'string' && workspaceFile.trim()
      ? resolvePath(workspaceFile)
      : undefined;
    const userDataPath = typeof app.getPath === 'function' ? app.getPath('userData') : '';
    const cleanRel = requiredString(relPath, 'relPath', 4_096);
    return invokeDesktopOperation(
      'readScopedEditorSettings',
      [userDataPath, root, cleanRel, workspace],
    );
  });
  handle(DESKTOP_IPC.startProject, (_event, projectPath) =>
    host.startProject(requiredString(projectPath, 'projectPath')));
  handle(DESKTOP_IPC.startProjectTask, (_event, projectPath) =>
    host.startProjectTask(requiredString(projectPath, 'projectPath')));
  handle(DESKTOP_IPC.startTask, () => host.startTask());
  handle(DESKTOP_IPC.listProjects, () => host.listProjects());
  handle(DESKTOP_IPC.addProject, (_event, projectPath) =>
    host.addProject(requiredString(projectPath, 'projectPath')));
  handle(DESKTOP_IPC.openProjectInExplorer, async (_event, projectPath) => {
    const directory = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
    const failure = await shell.openPath(directory);
    if (failure) throw new Error(`Unable to open project folder: ${failure}`);
  });
  handle(DESKTOP_IPC.openExternal, (_event, url) =>
    shell.openExternal(requiredExternalUrl(url)));
  handle(DESKTOP_IPC.githubStarStatus, () => githubStarStatus());
  handle(DESKTOP_IPC.starGithub, () => starGithub());
  // Settings → Git: GitHub CLI integration + global git identity.
  handle(DESKTOP_IPC.githubCliStatus, () => githubCliStatus());
  handle(DESKTOP_IPC.installGithubCli, () => installGithubCli());
  handle(DESKTOP_IPC.githubCliLoginStart, () => githubCliLoginStart());
  handle(DESKTOP_IPC.githubCliLoginStatus, (_event, flowId) =>
    githubCliLoginStatus(requiredString(flowId, 'flowId', 200)));
  handle(DESKTOP_IPC.githubCliLoginCancel, (_event, flowId) =>
    cancelGithubCliLogin(requiredString(flowId, 'flowId', 200)));
  handle(DESKTOP_IPC.githubCliLogout, () => githubCliLogout());
  handle(DESKTOP_IPC.githubCliAccount, () => githubCliAccount());
  handle(DESKTOP_IPC.gitGlobalConfig, () => gitGlobalConfig());
  handle(DESKTOP_IPC.setGitGlobalConfig, (_event, key, value) => {
    // Empty is a real value here: it UNSETS the key, so requiredString's
    // non-empty contract does not apply.
    if (typeof value !== 'string' || value.length > 500) {
      throw new TypeError('value must be a string of at most 500 characters.');
    }
    return setGitGlobalConfig(requiredGitGlobalConfigKey(key), value);
  });
  handle(DESKTOP_IPC.renameProject, (_event, projectPath, alias) =>
    host.renameProject(
      requiredString(projectPath, 'projectPath'),
      projectDisplayName(alias),
    ));
  handle(DESKTOP_IPC.removeProject, (_event, projectPath) =>
    host.removeProject(requiredString(projectPath, 'projectPath')));
  // Instructions editor (Projects page). null/'' → the common instructions
  // file (data/instructions.md, injected as "# Common Instructions" in BP3;
  // legacy user-workflow.md is read as a fallback so old installs surface
  // their existing guidance); a project path → `<project>/.mixdog/
  // instructions.md` (injected once per session after the `# Session` block).
  const commonDataDir = (): string => process.env.MIXDOG_DATA_DIR
    || resolvePath(process.env.MIXDOG_HOME || resolvePath(homedir(), '.mixdog'), 'data');
  const instructionsFilePath = async (projectPath: unknown): Promise<string> => {
    if (projectPath == null || projectPath === '') {
      return resolvePath(commonDataDir(), 'instructions.md');
    }
    const directory = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
    return resolvePath(directory, '.mixdog', 'instructions.md');
  };
  handle(DESKTOP_IPC.readInstructions, async (_event, projectPath) => {
    const file = await instructionsFilePath(projectPath);
    const legacy = projectPath == null || projectPath === ''
      ? resolvePath(commonDataDir(), 'user-workflow.md')
      : '';
    return invokeDesktopOperation('readInstructions', [file, legacy]);
  });
  handle(DESKTOP_IPC.writeInstructions, async (_event, projectPath, content) => {
    if (typeof content !== 'string' || content.length > 65_536) {
      throw new TypeError('instructions content is invalid.');
    }
    const file = await instructionsFilePath(projectPath);
    await invokeDesktopOperation('writeInstructions', [file, content]);
  });
  handle(DESKTOP_IPC.listProjectDir, (_event, projectPath, relDir) =>
    host.listProjectDir(
      requiredString(projectPath, 'projectPath'),
      typeof relDir === 'string' ? relDir : '',
    ));
  handle(DESKTOP_IPC.readProjectFile, async (_event, projectPath, relPath, accessToken) => {
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return invokeDesktopOperation(
        'readProjectTextFileIn',
        [granted.root, granted.rel],
      );
    }
    return host.readProjectTextFile(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    );
  });
  handle(DESKTOP_IPC.previewProjectFile, async (_event, projectPath, relPath, accessToken) => {
    let file: string;
    let info: { mtimeMs: number; size: number };
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      file = granted.absolute;
      info = await invokeDesktopOperation(
        'statProjectFileIn',
        [granted.root, granted.rel],
      );
    } else {
      const cleanProject = requiredString(projectPath, 'projectPath');
      const cleanRel = requiredString(relPath, 'relPath');
      const root = await host.projectDirectory(cleanProject);
      file = projectEntryPathIn(root, cleanRel);
      info = await invokeDesktopOperation(
        'statProjectFileIn',
        [root, cleanRel],
      );
    }
    const preview = registerFilePreview(file, `${info.mtimeMs}:${info.size}`);
    if (!preview) throw new Error('This file type does not support an in-app preview.');
    return { ...preview, ...info };
  });
  handle(DESKTOP_IPC.writeProjectFile, async (
    _event,
    projectPath,
    relPath,
    content,
    expectedContent,
    accessToken,
    encoding,
  ) => {
    if (typeof content !== 'string' || content.length > 4_194_304) {
      throw new TypeError('file content is invalid.');
    }
    if (typeof expectedContent !== 'string' || expectedContent.length > 4_194_304) {
      throw new TypeError('expected file content is invalid.');
    }
    if (encoding !== undefined
      && encoding !== 'utf8'
      && encoding !== 'utf8bom'
      && encoding !== 'utf16le'
      && encoding !== 'utf16be') {
      throw new TypeError('file encoding is invalid.');
    }
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return invokeDesktopOperation(
        'writeProjectTextFileIn',
        [granted.root, granted.rel, content, expectedContent, encoding],
      );
    }
    const cleanProject = requiredString(projectPath, 'projectPath');
    const cleanRel = requiredString(relPath, 'relPath');
    return host.writeProjectTextFile(
      cleanProject,
      cleanRel,
      content,
      expectedContent,
      encoding,
    );
  });
  handle(DESKTOP_IPC.readEditorBackup, async (_event, projectPath, relPath, accessToken) => {
    if (!editorBackupRoot) return null;
    const file = await editorFilePath(projectPath, relPath, accessToken);
    return invokeDesktopOperation(
      'readEditorBackup',
      [editorBackupRoot, file],
    );
  });
  handle(DESKTOP_IPC.writeEditorBackup, async (
    _event,
    projectPath,
    relPath,
    content,
    expectedContent,
    accessToken,
  ) => {
    if (!editorBackupRoot) throw new Error('Editor backup storage is unavailable.');
    const file = await editorFilePath(projectPath, relPath, accessToken);
    return invokeDesktopOperation(
      'writeEditorBackup',
      [editorBackupRoot, file, content, expectedContent],
    );
  });
  handle(DESKTOP_IPC.deleteEditorBackup, async (_event, projectPath, relPath, accessToken) => {
    if (!editorBackupRoot) return;
    const file = await editorFilePath(projectPath, relPath, accessToken);
    await invokeDesktopOperation(
      'deleteEditorBackup',
      [editorBackupRoot, file],
    );
  });
  handle(DESKTOP_IPC.statProjectFile, async (_event, projectPath, relPath, accessToken) => {
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return invokeDesktopOperation(
        'statProjectFileIn',
        [granted.root, granted.rel],
      );
    }
    return host.statProjectFile(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    );
  });
  handle(DESKTOP_IPC.createProjectEntry, (_event, projectPath, relDir, name, dir) =>
    host.createProjectEntry(
      requiredString(projectPath, 'projectPath'),
      typeof relDir === 'string' ? relDir : '',
      requiredString(name, 'name'),
      dir === true,
    ));
  handle(DESKTOP_IPC.renameProjectEntry, (_event, projectPath, relPath, newName) =>
    host.renameProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      requiredString(newName, 'newName'),
    ));
  handle(DESKTOP_IPC.moveProjectEntry, (_event, projectPath, relPath, targetDirRel) =>
    host.moveProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      typeof targetDirRel === 'string' ? targetDirRel : '',
    ));
  handle(DESKTOP_IPC.copyProjectEntry, (_event, projectPath, relPath, targetDirRel) =>
    host.copyProjectEntry(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
      typeof targetDirRel === 'string' ? targetDirRel : '',
    ));
  handle(DESKTOP_IPC.trashProjectEntry, async (_event, projectPath, relPath) => {
    const target = await host.projectEntryPath(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    );
    await shell.trashItem(target);
  });
  handle(DESKTOP_IPC.codeGraphQuery, (_event, projectPath, mode, symbol) => {
    if (mode !== 'find_symbol' && mode !== 'references' && mode !== 'symbols') {
      throw new TypeError('mode is invalid.');
    }
    return host.codeGraphQuery(
      requiredString(projectPath, 'projectPath'),
      mode,
      requiredString(symbol, 'symbol'),
    );
  });
  const requiredLspDocument = (value: unknown): DesktopLspDocumentInput => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('LSP document input is invalid.');
    }
    const input = value as Record<string, unknown>;
    requireAllowedKeys(input, new Set([
      'kind', 'projectPath', 'relPath', 'languageId', 'version', 'content',
    ]), 'LSP document input');
    if (input.kind !== 'open' && input.kind !== 'change'
      && input.kind !== 'save' && input.kind !== 'close') {
      throw new TypeError('LSP document kind is invalid.');
    }
    if (!Number.isInteger(input.version) || Number(input.version) < 0) {
      throw new TypeError('LSP document version is invalid.');
    }
    if (input.content !== undefined
      && (typeof input.content !== 'string' || input.content.length > 4_194_304)) {
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
  };
  const requiredLspRequest = (value: unknown): DesktopLspRequestInput => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('LSP request input is invalid.');
    }
    const input = value as Record<string, unknown>;
    requireAllowedKeys(input, new Set([
      'projectPath', 'relPath', 'languageId', 'method', 'params',
    ]), 'LSP request input');
    const method = requiredString(input.method, 'LSP method', 128);
    if (!isDesktopLspRequestMethod(method)) throw new TypeError('LSP method is unavailable.');
    const params = input.params === undefined ? {} : input.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new TypeError('LSP params are invalid.');
    }
    validateStructuredValue(params);
    return {
      projectPath: requiredString(input.projectPath, 'projectPath'),
      relPath: requiredString(input.relPath, 'relPath', 4_096),
      languageId: requiredString(input.languageId, 'languageId', 64),
      method,
      params: params as Record<string, unknown>,
    };
  };
  const requiredWorkspaceWrites = (value: unknown): DesktopWorkspaceTextWrite[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
      throw new TypeError('Workspace edit files are invalid.');
    }
    return value.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new TypeError('Workspace edit file is invalid.');
      }
      const record = row as Record<string, unknown>;
      requireAllowedKeys(
        record,
        new Set(['relPath', 'content', 'expectedContent']),
        'Workspace edit file',
      );
      if (typeof record.content !== 'string' || record.content.length > 4_194_304
        || typeof record.expectedContent !== 'string' || record.expectedContent.length > 4_194_304) {
        throw new TypeError('Workspace edit file content is invalid.');
      }
      return {
        relPath: requiredString(record.relPath, 'relPath', 4_096),
        content: record.content,
        expectedContent: record.expectedContent,
      };
    });
  };
  handle(DESKTOP_IPC.lspDocument, async (_event, rawInput) => {
    const input = requiredLspDocument(rawInput);
    const root = await host.projectDirectory(input.projectPath);
    return invokeDesktopOperation('lspDocument', [input.projectPath, root, input]);
  });
  handle(DESKTOP_IPC.lspRequest, async (_event, rawInput) => {
    const input = requiredLspRequest(rawInput);
    const root = await host.projectDirectory(input.projectPath);
    return invokeDesktopOperation('lspRequest', [
      input.projectPath,
      root,
      input.relPath,
      input.languageId,
      input.method,
      input.params ?? {},
    ]);
  });
  handle(DESKTOP_IPC.lspApplyWorkspaceEdit, async (_event, projectPath, rawWrites) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    const writes = requiredWorkspaceWrites(rawWrites);
    return invokeDesktopOperation(
      'writeProjectTextFilesIn',
      [root, writes],
    );
  });
  handle(DESKTOP_IPC.listSessions, () => host.listSessions());
  handle(DESKTOP_IPC.listAgentPool, () => host.listAgentPool());
  // Settings → Connection: pairing card (null while the bridge is off).
  handle(DESKTOP_IPC.remoteAccessInfo, () => remoteAccessInfo?.() ?? null);
  handle(DESKTOP_IPC.rotateRemoteAccess, () => rotateRemoteAccess?.() ?? null);
  handle(DESKTOP_IPC.renameSession, (_event, sessionId, title) =>
    host.renameSession(requiredSessionId(sessionId), sessionDisplayName(title)));
  handle(DESKTOP_IPC.setSessionArchived, (_event, sessionId, archived) => {
    if (typeof archived !== 'boolean') throw new TypeError('archived must be a boolean.');
    return host.setSessionArchived(requiredSessionId(sessionId), archived);
  });
  handle(DESKTOP_IPC.deleteSession, (_event, sessionId) =>
    host.deleteSession(requiredSessionId(sessionId)));
  handle(DESKTOP_IPC.prefetchSession, (_event, sessionId) =>
    host.prefetchSession(requiredSessionId(sessionId)));
  handle(DESKTOP_IPC.peekSession, async (_event, sessionId) =>
    (await host.peekSession?.(requiredSessionId(sessionId))) === true);
  const visibleSessionStateIds = new Set<string>();
  handle(DESKTOP_IPC.setVisibleSessions, async (_event, sessionIds) => {
    if (!Array.isArray(sessionIds) || sessionIds.length > 256) {
      throw new TypeError('sessionIds must be a bounded array.');
    }
    const normalized = [...new Set(sessionIds.map((sessionId) => requiredSessionId(sessionId)))];
    visibleSessionStateIds.clear();
    for (const sessionId of normalized) visibleSessionStateIds.add(sessionId);
    releaseHiddenSessionStateEntries(
      visibleSessionStateIds,
      [sessionStateEncoders, latestSessionStates, latestSessionProvenance],
      (sessionId) => {
        if (window.isDestroyed() || window.webContents.isDestroyed()) return;
        const encoder = sessionStateEncoders.get(sessionId);
        window.webContents.send(DESKTOP_IPC.sessionState, {
          sessionId,
          wire: encoder ? encoder.encode(null) : null,
        });
      },
    );
    return (await host.setVisibleSessions?.(normalized)) === true;
  });
  handle(DESKTOP_IPC.resumeSession, async (_event, sessionId) => {
    const snapshot = await host.resumeSession(requiredSessionId(sessionId));
    if (!snapshot) return null;
    // The complete snapshot already travels over mixdog:state. Returning the
    // same 512-row transcript from invoke() makes Electron structured-clone it
    // a second time; the renderer only needs this correlated acknowledgement.
    return {
      sessionId: snapshot.sessionId,
      sessionForkedFrom: snapshot.sessionForkedFrom,
      desktopSessionTitle: snapshot.desktopSessionTitle,
    };
  });
  handle(DESKTOP_IPC.searchProjectFiles, (_event, projectIdOrWorkspaceId, query, limit) => {
    if (typeof query !== 'string' || query.length > 1_024) {
      throw new TypeError('query is invalid.');
    }
    return host.searchProjectFiles(
      requiredString(projectIdOrWorkspaceId, 'projectIdOrWorkspaceId'),
      query,
      requiredFileSearchLimit(limit),
    );
  });
  const requiredWorkspaceSearchOptions = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Workspace search options are invalid.');
    }
    const input = value as Record<string, unknown>;
    requireAllowedKeys(input, new Set([
      'query', 'include', 'exclude', 'matchCase', 'wholeWord', 'regex', 'maxResults',
    ]), 'Workspace search options');
    const query = requiredString(input.query, 'search query', 4_096);
    const maxResults = requiredWorkspaceSearchLimit(input.maxResults);
    return {
      query,
      ...(typeof input.include === 'string' ? { include: input.include.slice(0, 4_096) } : {}),
      ...(typeof input.exclude === 'string' ? { exclude: input.exclude.slice(0, 4_096) } : {}),
      matchCase: input.matchCase === true,
      wholeWord: input.wholeWord === true,
      regex: input.regex === true,
      maxResults,
    };
  };
  handle(DESKTOP_IPC.searchWorkspaceText, async (_event, projectPath, rawOptions) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    const options = requiredWorkspaceSearchOptions(rawOptions);
    return invokeDesktopOperation(
      'searchWorkspaceTextIn',
      [root, options],
    );
  });
  handle(DESKTOP_IPC.replaceWorkspaceText, async (
    _event,
    projectPath,
    rawOptions,
    replacement,
    relPaths,
  ) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    if (typeof replacement !== 'string' || replacement.length > 1_000_000) {
      throw new TypeError('Replacement text is invalid.');
    }
    const options = requiredWorkspaceSearchOptions(rawOptions);
    const paths = relPaths === undefined ? undefined : requiredGitPaths(relPaths);
    return invokeDesktopOperation(
      'replaceWorkspaceTextIn',
      [root, options, replacement, paths],
    );
  });
  handle(DESKTOP_IPC.getSnapshot, () => host.getSnapshot());
  handle(DESKTOP_IPC.getUpdaterState, () => updater?.getState() ?? { status: 'disabled' });
  handle(DESKTOP_IPC.checkForDesktopUpdate, () =>
    updater?.check() ?? Promise.resolve({ status: 'disabled' } as const));
  handle(DESKTOP_IPC.showDesktopUpdate, async () => {
    const current = updater?.getState() ?? { status: 'disabled' } as const;
    if (current.status !== 'ready' || !updater) return current;
    await updater.install();
    return updater.getState();
  });
  handle(DESKTOP_IPC.submit, (_event, prompt, options) =>
    host.submit(requiredPromptContent(prompt), requiredSubmitOptions(options)));
  handle(DESKTOP_IPC.submitNewTask, (_event, prompt, options, draft) =>
    host.submitNewTask(
      requiredPromptContent(prompt),
      requiredSubmitOptions(options),
      requiredNewTaskDraft(draft),
    ));
  handle(DESKTOP_IPC.abort, (_event, options) => host.abort(requiredAbortOptions(options)));
  handle(DESKTOP_IPC.resolveToolApproval, (_event, id, input) =>
    host.resolveToolApproval(
      requiredString(id, 'approval id', 1_024),
      requiredToolApprovalDecision(input),
    ));
  // Split panes: prompt/abort/approval addressed to any pooled live session
  // (active or parked). The host contract requires every addressed route.
  handle(DESKTOP_IPC.submitToSession, (_event, sessionId, prompt, options) =>
    host.submitToSession(
      requiredSessionId(sessionId),
      requiredPromptContent(prompt),
      requiredSubmitOptions(options),
    ));
  handle(DESKTOP_IPC.abortSession, (_event, sessionId, options) =>
    host.abortSession(requiredSessionId(sessionId), requiredAbortOptions(options)));
  handle(DESKTOP_IPC.resolveToolApprovalForSession, (_event, sessionId, id, input) =>
    host.resolveToolApprovalForSession(
      requiredSessionId(sessionId),
      requiredString(id, 'approval id', 1_024),
      requiredToolApprovalDecision(input),
    ));
  handle(DESKTOP_IPC.listProviderModels, (_event, options) =>
    host.listProviderModels(requiredModelCatalogOptions(options)));
  handle(DESKTOP_IPC.setModelRoute, (_event, selection, sessionId) =>
    host.setModelRoute(
      requiredModelSelection(selection),
      sessionId === undefined || sessionId === null || sessionId === ''
        ? undefined
        : requiredSessionId(sessionId),
    ));
  handle(DESKTOP_IPC.setFast, (_event, enabled, sessionId) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    return host.setFast(
      enabled,
      sessionId === undefined || sessionId === null || sessionId === ''
        ? undefined
        : requiredSessionId(sessionId),
    );
  });
  handle(DESKTOP_IPC.readSettings, () =>
    settingsStore?.read() ?? invokeDesktopOperation('readSettings', []));
  handle(DESKTOP_IPC.updateSetting, (_event, key, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    const settingKey = requiredDesktopSettingKey(key);
    const update = settingsStore
      ? settingsStore.update(settingKey, enabled)
      : invokeDesktopOperation<DesktopSettings>('updateSetting', [settingKey, enabled]);
    return update.then((saved) => {
      onDesktopSettingsChanged?.(saved);
      return saved;
    });
  });
  handle(DESKTOP_IPC.readGitPreferences, () =>
    settingsStore?.readGitPreferences() ?? invokeDesktopOperation('readGitPreferences', []));
  handle(DESKTOP_IPC.updateGitPreferences, (_event, preferences) => {
    const source = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
      ? preferences as Record<string, unknown>
      : {};
    requireAllowedKeys(
      source,
      new Set(['commitTemplate', 'commitPreset', 'autoCommitMessage']),
      'preferences',
    );
    const template = source.commitTemplate;
    if (template !== undefined && (typeof template !== 'string' || template.length > 20_000)) {
      throw new TypeError('commitTemplate must be a string of at most 20,000 characters.');
    }
    const preset = source.commitPreset;
    if (preset !== undefined
      && (typeof preset !== 'string' || !['none', 'conventional', 'custom'].includes(preset))) {
      throw new TypeError('commitPreset must be none, conventional, or custom.');
    }
    const auto = source.autoCommitMessage;
    if (auto !== undefined && typeof auto !== 'boolean') {
      throw new TypeError('autoCommitMessage must be a boolean.');
    }
    const value = {
      ...(typeof template === 'string' ? { commitTemplate: template } : {}),
      ...(typeof preset === 'string'
        ? { commitPreset: preset as 'none' | 'conventional' | 'custom' }
        : {}),
      ...(typeof auto === 'boolean' ? { autoCommitMessage: auto } : {}),
    };
    return settingsStore
      ? settingsStore.updateGitPreferences(value)
      : invokeDesktopOperation('updateGitPreferences', [value]);
  });
  handle(DESKTOP_IPC.getZoomFactor, async () => {
    const factor = settingsStore
      ? await settingsStore.readZoom()
      : await invokeDesktopOperation<number>('readZoom', []);
    window.webContents.setZoomFactor(factor);
    const { setDesktopTitleBarZoom } = await import('./window-options');
    setDesktopTitleBarZoom(window, factor);
    return factor;
  });
  handle(DESKTOP_IPC.setZoomFactor, async (_event, value) => {
    const requested = requiredZoomFactor(value);
    const factor = settingsStore
      ? await settingsStore.updateZoom(requested)
      : await invokeDesktopOperation<number>('updateZoom', [requested]);
    window.webContents.setZoomFactor(factor);
    const { setDesktopTitleBarZoom } = await import('./window-options');
    setDesktopTitleBarZoom(window, factor);
    window.webContents.send(DESKTOP_IPC.zoomFactorChanged, factor);
    return factor;
  });
  // Renderer-resolved DESKTOP theme (system preference / stored preference)
  // is the only owner of the native band, caption symbols, and the DWM frame
  // theme. The engine/TUI theme is a separate user setting — the old
  // getTheme/setTheme capability hook let it overwrite this band with a
  // mismatched palette, so capabilities stay theme-neutral now.
  handle(DESKTOP_IPC.applyTitleBarTheme, async (_event, theme, systemPreference) => {
    const { setDesktopTitleBarTheme } = await import('./window-options');
    setDesktopTitleBarTheme(window, requiredString(theme, 'theme'), systemPreference === true);
  });
  // Fullscreen-modal dim for the native WCO caption band: the renderer sends
  // pre-composited hex colors; anything malformed clears back to the theme.
  handle(DESKTOP_IPC.setTitleBarDim, async (_event, dim) => {
    const record = (dim && typeof dim === 'object' ? dim : {}) as Record<string, unknown>;
    const hex = /^#[0-9a-f]{6}$/i;
    const valid = typeof record.color === 'string' && hex.test(record.color)
      && typeof record.symbolColor === 'string' && hex.test(record.symbolColor);
    const { setDesktopTitleBarDim } = await import('./window-options');
    setDesktopTitleBarDim(window, valid
      ? { color: record.color as string, symbolColor: record.symbolColor as string }
      : null);
  });
  handle(DESKTOP_IPC.invokeCapability, async (_event, input) => {
    const request = requiredDesktopCapabilityRequest(input);
    return host.invokeCapability(request.capability, request.args, request.sessionId);
  });
  handle(DESKTOP_IPC.readCapabilities, (_event, input) =>
    host.readCapabilities(requiredDesktopCapabilityReadRequests(input)));
  handle(DESKTOP_IPC.quit, () => {
    quitPromise ??= (async () => {
      try {
        await host.dispose();
      } finally {
        app.quit();
      }
    })();
    return quitPromise;
  });

  // Background turn-finished OS toasts removed (user decision): state fanout
  // only. Restore behind a setting if notifications return.
  // Streaming state pushes ride an identity-prefix delta. The daemon delta
  // decoder retains unchanged item identity, so only appended/changed items
  // cross the IPC serializer. A resync restarts from a full snapshot.
  let sentItems: readonly unknown[] | null = null;
  let sentStreamingTail: Record<string, unknown> | null = null;
  let sentStateFields: Record<string, unknown> | null = null;
  let sentRevision = 0;
  const snapshotFieldsFrom = (record: Record<string, unknown>): Record<string, unknown> => {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'items' && key !== 'streamingTail') fields[key] = value;
    }
    return fields;
  };
  const patchStateFields = (
    wire: Record<string, unknown>,
    record: Record<string, unknown>,
    base: number,
    revision: number,
  ): void => {
    const nextFields = snapshotFieldsFrom(record);
    const previousFields = sentStateFields || {};
    const changed: Record<string, unknown> = {};
    const removed: string[] = [];
    for (const [key, value] of Object.entries(nextFields)) {
      // The daemon delta decoder retains identity for unchanged fields, so a
      // deep walk here would only repeat work on every publication.
      if (!Object.hasOwn(previousFields, key) || !Object.is(previousFields[key], value)) {
        changed[key] = value;
      }
    }
    for (const key of Object.keys(previousFields)) {
      if (!Object.hasOwn(nextFields, key)) removed.push(key);
    }
    wire.__statePatch = { base, revision, changed, removed };
    sentStateFields = nextFields;
  };
  const streamingTailFrom = (record: Record<string, unknown> | null): Record<string, unknown> | null => {
    const value = record?.streamingTail;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  };
  const patchStreamingTail = (
    wire: Record<string, unknown>,
    nextTail: Record<string, unknown> | null,
  ): void => {
    const previousTail = sentStreamingTail;
    if (previousTail === nextTail) {
      sentStreamingTail = nextTail;
      return;
    }
    const previousText = typeof previousTail?.text === 'string' ? previousTail.text : '';
    const nextText = typeof nextTail?.text === 'string' ? nextTail.text : '';
    if (
      previousTail
      && nextTail
      && previousTail.id != null
      && previousTail.id === nextTail.id
      && nextText.length >= previousText.length
      && nextText.startsWith(previousText)
    ) {
      const tail = { ...nextTail };
      delete tail.text;
      delete wire.streamingTail;
      wire.__streamingTailPatch = {
        prefix: previousText.length,
        append: nextText.slice(previousText.length),
        tail,
      };
    } else {
      wire.streamingTail = nextTail;
    }
    sentStreamingTail = nextTail;
  };
  const sendEngineState = (snapshot: SessionSnapshot): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const record = snapshot as Record<string, unknown> | null;
    const items = record && Array.isArray(record.items) ? record.items as unknown[] : null;
    const streamingTail = streamingTailFrom(record);
    if (!items) {
      sentItems = null;
      sentStreamingTail = streamingTail;
      sentStateFields = record ? snapshotFieldsFrom(record) : null;
      window.webContents.send(DESKTOP_IPC.state, snapshot);
      return;
    }
    sentRevision += 1;
    if (sentItems) {
      const base = sentRevision - 1;
      let prefix = sentItems === items ? items.length : 0;
      if (sentItems !== items) {
        const shared = Math.min(sentItems.length, items.length);
        while (prefix < shared && sentItems[prefix] === items[prefix]) prefix += 1;
      }
      const wire: Record<string, unknown> = {};
      wire.__itemsPatch = {
        base,
        revision: sentRevision,
        prefix,
        append: items.slice(prefix),
      };
      patchStateFields(wire, record!, base, sentRevision);
      patchStreamingTail(wire, streamingTail);
      sentItems = items;
      window.webContents.send(DESKTOP_IPC.state, wire);
      return;
    }
    sentItems = items;
    sentStreamingTail = streamingTail;
    sentStateFields = snapshotFieldsFrom(record!);
    window.webContents.send(DESKTOP_IPC.state, { ...record, __itemsRevision: sentRevision });
  };
  const unsubscribeState = host.subscribe(sendEngineState);
  const onStateResync = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    sentItems = null;
    sentStreamingTail = null;
    sentStateFields = null;
    sendEngineState(host.getSnapshot());
  };
  ipcMain.on(DESKTOP_IPC.stateResync, onStateResync);
  // Sleep/resume: the renderer may have missed pushes while its frames were
  // throttled and the delta baseline cannot be trusted — restart the state
  // lane from a full snapshot on wake (orca-style system-resume broadcast).
  const onSystemResume = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    sentItems = null;
    sentStreamingTail = null;
    sentStateFields = null;
    sendEngineState(host.getSnapshot());
  };
  if (typeof powerMonitorRef?.on === 'function') powerMonitorRef.on('resume', onSystemResume);
  // Sidebar push: the host watches the on-disk session store and fans out a
  // fresh catalog; the renderer applies it without an extra list round-trip.
  // Guarded: embedders/tests may hand a partial host without the watcher API.
  const unsubscribeSessions = typeof host.subscribeSessions === 'function'
    ? host.subscribeSessions((sessions) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC.sessionsChanged, sessions);
      }
    })
    : () => {};
  const unsubscribeAgentPool = typeof host.subscribeAgentPool === 'function'
    ? host.subscribeAgentPool((agents) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC.agentPoolChanged, agents);
      }
    })
    : () => {};
  // Split panes: preserve the host's 20 Hz responsiveness while sending only
  // changed state and transcript suffixes. Preload reconstructs full snapshots
  // before renderer listeners run, retaining settled item identity.
  const sessionStateEncoders = new Map<string, SnapshotDeltaEncoder>();
  const latestSessionStates = new Map<string, SessionSnapshot>();
  // Provenance of the last frame per session: a delta resync must re-send the
  // same frame description, never an unversioned one.
  const latestSessionProvenance = new Map<string, {
    frameSource: 'live' | 'replay';
    contentRevision?: number;
  }>();
  const sendSessionState = (update: {
    sessionId: string;
    snapshot: SessionSnapshot;
    frameSource: 'live' | 'replay';
    contentRevision?: number;
  }): void => {
    const sessionId = String(update.sessionId || '');
    if (!sessionId || window.isDestroyed() || window.webContents.isDestroyed()) return;
    if (!shouldPublishSessionState(sessionId, update.snapshot, visibleSessionStateIds)) return;
    let encoder = sessionStateEncoders.get(sessionId);
    if (!encoder) encoder = createSnapshotDeltaEncoder();
    if (update.snapshot === null) {
      window.webContents.send(DESKTOP_IPC.sessionState, {
        sessionId,
        wire: encoder.encode(null),
        frameSource: update.frameSource,
        ...(typeof update.contentRevision === 'number'
          ? { contentRevision: update.contentRevision }
          : {}),
      });
      sessionStateEncoders.delete(sessionId);
      latestSessionStates.delete(sessionId);
      latestSessionProvenance.delete(sessionId);
      return;
    }
    sessionStateEncoders.set(sessionId, encoder);
    latestSessionStates.delete(sessionId);
    latestSessionStates.set(sessionId, update.snapshot);
    latestSessionProvenance.set(sessionId, {
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number'
        ? { contentRevision: update.contentRevision }
        : {}),
    });
    window.webContents.send(DESKTOP_IPC.sessionState, {
      sessionId,
      wire: encoder.encode(update.snapshot),
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number'
        ? { contentRevision: update.contentRevision }
        : {}),
    });
  };
  const onSessionStateResync = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    const sessionId = String(value || '');
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !latestSessionStates.has(sessionId)) return;
    const provenance = latestSessionProvenance.get(sessionId);
    if (!provenance) return;
    sessionStateEncoders.get(sessionId)?.reset();
    sendSessionState({
      sessionId,
      snapshot: latestSessionStates.get(sessionId)!,
      ...provenance,
    });
  };
  ipcMain.on(DESKTOP_IPC.sessionStateResync, onSessionStateResync);
  const unsubscribeSessionStates = host.subscribeSessionStates(sendSessionState);
  const unsubscribeUpdater = updater?.subscribe((next) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(DESKTOP_IPC.updaterState, next);
    }
  }) ?? (() => {});
  const unsubscribeDesktopEvents = host.subscribeDesktopEvents?.(({ name, value }) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    if (name === 'folder-changed') window.webContents.send(DESKTOP_IPC.folderChanged, value);
    else if (name === 'lsp-diagnostics') window.webContents.send(DESKTOP_IPC.lspDiagnostics, value);
    else if (name === 'lsp-status') window.webContents.send(DESKTOP_IPC.lspStatus, value);
  }) ?? (() => {});
  // Renderer perf lines ride a fire-and-forget event channel (no invoke).
  const onPerfLog = (_event: Electron.IpcMainEvent, line: unknown): void => {
    (host as { perfLog?: (line: string) => void }).perfLog?.(String(line ?? ''));
  };
  ipcMain.on(DESKTOP_IPC.perfLog, onPerfLog);
  // Dock terminal: invoke for ensure, fire-and-forget events for keystrokes
  // and resize (latency), a push event for PTY output. Same sender guard as
  // the invoke surface — a compromised child frame must not reach the PTY.
  const validTermSender = (event: Electron.IpcMainEvent): boolean =>
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  const terminalDataBufferer = new TerminalDataBufferer(
    (event) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC.termData, event);
      }
    },
    5,
    256 * 1024,
    terminals ? {
      pause: (id) => terminals.pauseOutput?.(id),
      resume: (id) => terminals.resumeOutput?.(id),
    } : undefined,
    32 * 1024,
  );
  if (terminals) {
    handle(DESKTOP_IPC.termEnsure, (_event, id, cwd, shell) => terminals.ensure(
      typeof id === 'string' && id ? id : null,
      typeof cwd === 'string' && cwd ? cwd : null,
      typeof shell === 'string' && shell ? shell : null,
    ));
    handle(DESKTOP_IPC.termProfiles, () => invokeDesktopOperation('termProfiles', []));
    handle(DESKTOP_IPC.termDispose, (_event, id) => {
      const terminalId = requiredString(id, 'terminal id', 128);
      terminalDataBufferer.release(terminalId);
      terminals.dispose(terminalId);
    });
  }
  // Dock Git panel: plain git CLI scoped to an absolute project directory.
  handle(DESKTOP_IPC.gitStatus, (_event, cwd) => gitStatus(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitBranches, (_event, cwd) => gitBranches(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitCheckoutBranch, (_event, cwd, branch, remote) =>
    gitCheckoutBranch(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      remote === true,
    ));
  handle(DESKTOP_IPC.gitCreateBranch, (_event, cwd, branch) =>
    gitCreateBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)));
  handle(DESKTOP_IPC.gitRenameBranch, (_event, cwd, branch, nextBranch) =>
    gitRenameBranch(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      requiredGitBranchName(nextBranch),
    ));
  handle(DESKTOP_IPC.gitDeleteBranch, (_event, cwd, branch) =>
    gitDeleteBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)));
  handle(DESKTOP_IPC.gitMergeBranch, (_event, cwd, branch) =>
    gitMergeBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)));
  handle(DESKTOP_IPC.gitDiff, (_event, cwd, path, staged, worktreeOnly, untracked) =>
    gitDiff(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      staged === true,
      worktreeOnly === true,
      untracked === true,
    ));
  handle(DESKTOP_IPC.gitApplyPatch, (_event, cwd, path, patch, reverse) => {
    if (reverse !== undefined && typeof reverse !== 'boolean') {
      throw new TypeError('git patch direction is invalid.');
    }
    return gitApplyPatch(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      requiredGitPatch(patch),
      reverse === true,
    );
  });
  handle(DESKTOP_IPC.gitStage, (_event, cwd, paths) =>
    gitStage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)));
  handle(DESKTOP_IPC.gitUnstage, (_event, cwd, paths) =>
    gitUnstage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)));
  handle(DESKTOP_IPC.gitCommit, (_event, cwd, message) =>
    gitCommit(requiredRepositoryCwd(cwd), requiredString(message, 'commit message', 20_000)));
  handle(DESKTOP_IPC.gitCommitPaths, (_event, cwd, message, paths) =>
    gitCommitPaths(
      requiredRepositoryCwd(cwd),
      requiredString(message, 'commit message', 20_000),
      requiredGitPaths(paths),
    ));
  handle(DESKTOP_IPC.gitGenerateCommitMessage, async (_event, cwd, files) => {
    const repository = requiredRepositoryCwd(cwd);
    const entries = requiredCommitMessageFiles(files);
    const preferences = settingsStore
      ? await settingsStore.readGitPreferences().catch(() => null)
      : await invokeDesktopOperation('readGitPreferences', []).catch(() => null);
    const message = await invokeDesktopOperation<string>(
      'gitGenerateCommitMessage',
      [repository, entries, preferences],
    );
    return { message };
  });
  handle(DESKTOP_IPC.gitAmend, (_event, cwd, message) =>
    gitAmend(requiredRepositoryCwd(cwd), requiredGitOptionalMessage(message)));
  handle(DESKTOP_IPC.gitUndoLastCommit, (_event, cwd) =>
    gitUndoLastCommit(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitStash, (_event, cwd, message) =>
    gitStash(requiredRepositoryCwd(cwd), requiredGitOptionalMessage(message)));
  handle(DESKTOP_IPC.gitStashPop, (_event, cwd) =>
    gitStashPop(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitStashList, (_event, cwd) =>
    gitStashList(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitStashApply, (_event, cwd, ref) =>
    gitStashApply(requiredRepositoryCwd(cwd), requiredString(ref, 'stash ref', 64)));
  handle(DESKTOP_IPC.gitStashDrop, (_event, cwd, ref) =>
    gitStashDrop(requiredRepositoryCwd(cwd), requiredString(ref, 'stash ref', 64)));
  handle(DESKTOP_IPC.ghPrList, (_event, cwd) => ghPrList(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.ghPrDefaultBranch, (_event, cwd) =>
    ghPrDefaultBranch(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.ghPrCreate, (_event, cwd, input) =>
    ghPrCreate(requiredRepositoryCwd(cwd), input));
  handle(DESKTOP_IPC.ghPrView, (_event, cwd, number) =>
    ghPrView(requiredRepositoryCwd(cwd), number));
  handle(DESKTOP_IPC.ghPrCheckout, (_event, cwd, number) =>
    ghPrCheckout(requiredRepositoryCwd(cwd), number));
  handle(DESKTOP_IPC.ghPrMerge, (_event, cwd, number, method) =>
    ghPrMerge(requiredRepositoryCwd(cwd), number, method));
  handle(DESKTOP_IPC.ghPrDiff, (_event, cwd, number) =>
    ghPrDiff(requiredRepositoryCwd(cwd), number));
  handle(DESKTOP_IPC.gitPush, (_event, cwd) => gitPush(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitFetch, (_event, cwd) => gitFetch(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitPull, (_event, cwd) => gitPull(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitSync, (_event, cwd) => gitSync(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitContinue, (_event, cwd) => gitContinue(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitAbortOperation, (_event, cwd) =>
    gitAbortOperation(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitIgnore, (_event, cwd, path, scope) =>
    gitIgnore(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      requiredGitIgnoreScope(scope),
    ));
  handle(DESKTOP_IPC.gitRevert, (_event, cwd, path, untracked, mode) =>
    gitRevertFile(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      untracked === true,
      requiredGitDiscardMode(mode),
    ));
  handle(DESKTOP_IPC.gitLog, (_event, cwd, query, skip, limit) => gitLog(
    requiredRepositoryCwd(cwd),
    requiredGitLogQuery(query),
    requiredGitLogOffset(skip),
    requiredGitLogLimit(limit),
  ));
  handle(DESKTOP_IPC.gitShow, (_event, cwd, hash) =>
    gitShow(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitShowDiff, (_event, cwd, hash, path) =>
    gitShowDiff(requiredRepositoryCwd(cwd), requiredCommitHash(hash), requiredGitPath(path)));
  // Diff tab editor mode: `HEAD`/`:0` (index) or a commit hash, optionally
  // `^`-suffixed for its first parent.
  const requiredGitRevision = (value: unknown): string => {
    const rev = requiredString(value, 'git revision', 128);
    if (rev === 'HEAD' || rev === ':0') return rev;
    const parent = rev.endsWith('^');
    return `${requiredCommitHash(parent ? rev.slice(0, -1) : rev)}${parent ? '^' : ''}`;
  };
  handle(DESKTOP_IPC.gitShowFile, (_event, cwd, rev, path) =>
    gitShowFile(requiredRepositoryCwd(cwd), requiredGitRevision(rev), requiredGitPath(path)));
  // `confirmedDirty` is a CALLER CONTRACT, not evidence: the main side cannot
  // prove a warning was shown, and does not try to. The reference can gate this
  // on its own dialog callback because its store OWNS the dialog; here the flag
  // crosses a process boundary, and any caller that can reach this channel
  // (preload of our own window, or a paired remote client) is already trusted
  // with `gitResetToCommit(mode: 'hard')`, `gitDiscard` and `gitStash` — all of
  // which destroy strictly more uncommitted work than a `--mixed` reset, which
  // only UNSTAGES it (the content stays in the worktree, recoverable). The
  // refusal is therefore a safety NET for the honest caller that forgot to ask,
  // not a permission check; the destructive mode (`hard`) keeps refusing a
  // dirty worktree outright, with no flag that can wave it through.
  handle(DESKTOP_IPC.gitResetToCommit, (_event, cwd, hash, mode, confirmedDirty) => gitResetToCommit(
    requiredRepositoryCwd(cwd),
    requiredCommitHash(hash),
    requiredGitResetMode(mode),
    confirmedDirty === true,
  ));
  handle(DESKTOP_IPC.gitRevertCommit, (_event, cwd, hash) =>
    gitRevertCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitCherryPickCommit, (_event, cwd, hash) =>
    gitCherryPickCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitCreateTag, (_event, cwd, tag, hash) => gitCreateTag(
    requiredRepositoryCwd(cwd),
    requiredString(tag, 'git tag', 512),
    requiredCommitHash(hash),
  ));
  handle(DESKTOP_IPC.gitDeleteTag, (_event, cwd, tag) =>
    gitDeleteTag(requiredRepositoryCwd(cwd), requiredString(tag, 'git tag', 512)));
  handle(DESKTOP_IPC.gitCheckoutCommit, (_event, cwd, hash) =>
    gitCheckoutCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitCreateBranchAtCommit, (_event, cwd, branch, hash) =>
    gitCreateBranchAtCommit(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      requiredCommitHash(hash),
    ));
  handle(DESKTOP_IPC.gitReview, (_event, cwd) => gitReview(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitReviewDiff, (_event, cwd, path, untracked) =>
    gitReviewDiff(requiredRepositoryCwd(cwd), requiredGitPath(path), untracked === true));
  // Review context menu: OS reveal/open, confined to the project directory.
  const resolveInsideProject = (cwd: unknown, path: unknown): string => {
    const root = resolvePath(requiredRepositoryCwd(cwd));
    const absolute = resolvePath(root, requiredString(path, 'file path', 4_096));
    if (absolute !== root && !absolute.startsWith(root + pathSep)) {
      throw new TypeError('The file path escapes the project directory.');
    }
    return absolute;
  };
  handle(DESKTOP_IPC.revealFile, async (_event, cwd, path, accessToken) => {
    const absolute = typeof accessToken === 'string' && accessToken
      ? (await grantedFile(accessToken, cwd, path)).absolute
      : resolveInsideProject(cwd, path);
    shell.showItemInFolder(absolute);
  });
  handle(DESKTOP_IPC.openFilePath, async (_event, cwd, path, accessToken) => {
    const absolute = typeof accessToken === 'string' && accessToken
      ? (await grantedFile(accessToken, cwd, path)).absolute
      : resolveInsideProject(cwd, path);
    const failure = await shell.openPath(absolute);
    if (failure) throw new Error(`Unable to open file: ${failure}`);
  });
  const onTermWrite = (event: Electron.IpcMainEvent, id: unknown, data: unknown): void => {
    if (!validTermSender(event)) return;
    terminals?.write(String(id || ''), String(data ?? ''));
  };
  const onTermResize = (event: Electron.IpcMainEvent, id: unknown, cols: unknown, rows: unknown): void => {
    if (!validTermSender(event)) return;
    terminals?.resize(String(id || ''), Number(cols), Number(rows));
  };
  const onTermAcknowledge = (
    event: Electron.IpcMainEvent,
    id: unknown,
    charCount: unknown,
  ): void => {
    if (!validTermSender(event)) return;
    terminalDataBufferer.acknowledge(String(id || ''), Number(charCount));
  };
  ipcMain.on(DESKTOP_IPC.termWrite, onTermWrite);
  ipcMain.on(DESKTOP_IPC.termResize, onTermResize);
  ipcMain.on(DESKTOP_IPC.termAcknowledge, onTermAcknowledge);
  const unsubscribeTerminals = terminals?.subscribe((event) => {
    terminalDataBufferer.push(event);
  }) ?? (() => {});
  const eventChannels = new Set<string>([
    DESKTOP_IPC.state, DESKTOP_IPC.sessionState, DESKTOP_IPC.sessionStateResync,
    DESKTOP_IPC.sessionsChanged, DESKTOP_IPC.agentPoolChanged, DESKTOP_IPC.stateResync,
    DESKTOP_IPC.updaterState, DESKTOP_IPC.perfLog, DESKTOP_IPC.rendererDiagnostic,
    DESKTOP_IPC.termWrite, DESKTOP_IPC.termResize, DESKTOP_IPC.termAcknowledge,
    DESKTOP_IPC.termData,
    DESKTOP_IPC.lspDiagnostics, DESKTOP_IPC.lspStatus,
  ]);
  const channels = Object.values(DESKTOP_IPC).filter((channel) => !eventChannels.has(channel));
  let removed = false;

  return () => {
    if (removed) return;
    removed = true;
    unsubscribeState();
    unsubscribeSessions();
    unsubscribeAgentPool();
    unsubscribeSessionStates();
    sessionStateEncoders.clear();
    latestSessionStates.clear();
    latestSessionProvenance.clear();
    visibleSessionStateIds.clear();
    unsubscribeUpdater();
    unsubscribeTerminals();
    unsubscribeDesktopEvents();
    terminalDataBufferer.dispose();
    if (typeof powerMonitorRef?.removeListener === 'function') {
      powerMonitorRef.removeListener('resume', onSystemResume);
    }
    ipcMain.removeListener(DESKTOP_IPC.perfLog, onPerfLog);
    ipcMain.removeListener(DESKTOP_IPC.stateResync, onStateResync);
    ipcMain.removeListener(DESKTOP_IPC.sessionStateResync, onSessionStateResync);
    ipcMain.removeListener(DESKTOP_IPC.termWrite, onTermWrite);
    ipcMain.removeListener(DESKTOP_IPC.termResize, onTermResize);
    ipcMain.removeListener(DESKTOP_IPC.termAcknowledge, onTermAcknowledge);
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
