import {
  isAbsolute as pathIsAbsolute,
  resolve as resolvePath,
} from 'node:path';

import {
  DESKTOP_CAPABILITIES,
  DESKTOP_GIT_GLOBAL_CONFIG_KEYS,
  DESKTOP_READ_CAPABILITIES,
  type DesktopAbortOptions,
  type DesktopCapability,
  type DesktopCapabilityReadRequest,
  type DesktopCapabilityRequest,
  type DesktopGitGlobalConfigKey,
  type DesktopModelCatalogOptions,
  type DesktopModelSelection,
  type DesktopNewTaskDraft,
  type DesktopPromptContent,
  type DesktopSettingKey,
  type DesktopSubmitOptions,
  type DesktopWorkspaceFolder,
  type ToolApprovalDecision,
} from '../shared/contract';
import { requiredSessionId } from './desktop-state';

const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_IMAGE_BASE64_LENGTH = 16_000_000;
const MAX_FILE_BASE64_LENGTH = 28_000_000;
const MAX_STRUCTURED_STRING_TOTAL = 32_000_000;

const CAPABILITY_SET = new Set<string>(DESKTOP_CAPABILITIES);
const READ_CAPABILITY_SET = new Set<string>(DESKTOP_READ_CAPABILITIES);
const BOOLEAN_FIRST_CAPABILITIES = new Set<DesktopCapability>([
  'setAutoUpdate', 'setRecapEnabled', 'setWebSearchEnabled', 'setMemoryToolsEnabled',
]);
const BOOLEAN_SECOND_CAPABILITIES = new Set<DesktopCapability>([
  'setMcpServerEnabled', 'setHookRuleEnabled', 'setScheduleEnabled', 'setWebhookEnabled',
]);
const SUBMIT_OPTION_KEYS = new Set([
  'id', 'submittedAt', 'displayText', 'priority', 'pastedImages', 'pastedTexts',
]);
const ABORT_OPTION_KEYS = new Set(['restorePrompt', 'submissionId']);
const NEW_TASK_DRAFT_KEYS = new Set(['projectPath', 'route', 'workflowId']);
const CAPABILITY_REQUEST_KEYS = new Set(['capability', 'args', 'sessionId']);
const MODEL_SELECTION_KEYS = new Set(['provider', 'model', 'effort', 'fast', 'modelParameters', 'contextPercent']);
const MODEL_CATALOG_OPTION_KEYS = new Set(['force', 'refresh', 'quick']);
const PROVIDER_SETUP_OPTION_KEYS = new Set(['force', 'refresh']);
const TOOL_APPROVAL_KEYS = new Set(['approved', 'reason']);

const CAPABILITY_ARITY = {
  prioritizeQueued: [1, 1], restoreQueued: [0, 2], rewindToItem: [1, 1], setEffort: [1, 1], setToolMode: [1, 1], getAutoClear: [0, 0],
  setAutoClear: [0, 1], getUpdateSettings: [0, 0], setAutoUpdate: [1, 1], checkForUpdate: [0, 1],
  runUpdateNow: [0, 0], getUpdateStatus: [0, 0], getProfile: [0, 0], setProfile: [0, 1],
  getCompactionSettings: [0, 0], setCompactionSettings: [0, 1], getRecapSettings: [0, 0],
  setRecapEnabled: [1, 1], getToolModuleSettings: [0, 0], setWebSearchEnabled: [1, 1], setMemoryToolsEnabled: [1, 1],
  getVoiceStatus: [0, 0], toggleVoice: [0, 0],
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
  setWorkflow: [1, 1],
  getWorkflowPack: [1, 1], saveWorkflowPack: [1, 1], createWorkflow: [1, 1], deleteWorkflow: [1, 1],
  getAgentDefinition: [1, 1], saveAgentDefinition: [1, 1], deleteAgentDefinition: [1, 1],
  listThemes: [0, 0], getTheme: [0, 0], setTheme: [1, 2], setAgentRoute: [2, 2],
  listProviders: [0, 0], listProviderModels: [0, 1], getProviderSetup: [0, 1],
  getUsageDashboard: [0, 1], consumeCodexRateLimitResetCredit: [1, 1],
  getTurnReviewDiff: [0, 0], revertTurnReview: [0, 0], revertTurnReviewFile: [1, 1],
  getOnboardingStatus: [0, 0], skipOnboarding: [0, 0],
  completeOnboarding: [0, 1], loginOAuthProvider: [1, 1], beginOAuthProviderLogin: [1, 1],
  getOAuthProviderLoginStatus: [1, 1], completeOAuthProviderLogin: [2, 2], cancelOAuthProviderLogin: [1, 1],
  saveProviderApiKey: [2, 2], saveOpenCodeGoUsageAuth: [1, 1], loginOpenCodeGoUsage: [0, 0],
  saveOpenAIUsageSessionKey: [1, 1], setLocalProvider: [2, 2], authenticateProvider: [2, 2],
  forgetProviderAuth: [1, 1], getChannelSetup: [0, 0],
  setWebhookConfig: [1, 1],
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

export function requiredGitGlobalConfigKey(value: unknown): DesktopGitGlobalConfigKey {
  if (
    typeof value === 'string'
    && (DESKTOP_GIT_GLOBAL_CONFIG_KEYS as readonly string[]).includes(value)
  ) {
    return value as DesktopGitGlobalConfigKey;
  }
  throw new TypeError('key must be user.name, user.email, or init.defaultBranch.');
}

export function requireAllowedKeys(
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

export function validateStructuredValue(
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
      if (mimeType !== 'application/pdf') throw new TypeError('file type is unsupported.');
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
  if (capability === 'saveOpenAIUsageSessionKey') {
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
  const modelParameters = selection.modelParameters;
  const contextPercent = selection.contextPercent;
  if (effort !== undefined && typeof effort !== 'string') {
    throw new TypeError('selection.effort must be a string.');
  }
  if (fast !== undefined && typeof fast !== 'boolean') {
    throw new TypeError('selection.fast must be a boolean.');
  }
  if (modelParameters !== undefined && (!modelParameters || typeof modelParameters !== 'object' || Array.isArray(modelParameters)
    || Object.entries(modelParameters).some(([key, option]) => !key || typeof option !== 'string'))) {
    throw new TypeError('selection.modelParameters must be a string map.');
  }
  if (contextPercent !== undefined && (typeof contextPercent !== 'number'
    || !Number.isFinite(contextPercent)
    || contextPercent < 10 || contextPercent > 100
    || contextPercent % 10 !== 0)) {
    throw new TypeError('selection.contextPercent must be a 10-point percentage from 10 to 100.');
  }
  return {
    provider: requiredString(selection.provider, 'selection.provider', 256),
    model: requiredString(selection.model, 'selection.model', 512),
    ...(effort === undefined ? {} : { effort: requiredString(effort, 'selection.effort', 64) }),
    ...(fast === undefined ? {} : { fast }),
    ...(modelParameters === undefined ? {} : { modelParameters: { ...modelParameters as Record<string, string> } }),
    ...(contextPercent === undefined ? {} : { contextPercent }),
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

export function requiredExternalUrl(value: unknown): string {
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

export function requiredZoomFactor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.2 || value > 10) {
    throw new TypeError('zoom factor is invalid.');
  }
  return Math.round(value * 100) / 100;
}

export function requiredDesktopSettingKey(value: unknown): DesktopSettingKey {
  if (value === 'autoClear' || value === 'autoCompact' || value === 'keepAwake'
    || value === 'usagePinned') return value;
  throw new TypeError('setting key is invalid.');
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
      ...(typeof record.name === 'string' && record.name.trim()
        ? { name: record.name.trim().slice(0, 200) }
        : {}),
    };
  });
}
