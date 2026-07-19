// Explicit handler/preload shape adapted from AiderDesk ipc-handlers.ts under
// Apache-2.0; arbitrary renderer-selected method execution is intentionally absent.
import type {
  App,
  BrowserWindow,
  Dialog,
  IpcMain,
  IpcMainInvokeEvent,
  Shell,
} from 'electron';
// Namespace import + optional access: the engine-host test stubs the electron
// module without a Notification export.
import * as electronModule from 'electron';
const NotificationCtor = (electronModule as { Notification?: typeof import('electron').Notification }).Notification;

import {
  DESKTOP_CAPABILITIES,
  DESKTOP_IPC,
  DESKTOP_READ_CAPABILITIES,
  type DesktopCapability,
  type DesktopCapabilityReadRequest,
  type DesktopCapabilityRequest,
  type DesktopModelSelection,
  type DesktopModelCatalogOptions,
  type DesktopPromptContent,
  type DesktopSubmitOptions,
  type DesktopSettingKey,
  type DesktopUpdaterState,
  type ToolApprovalDecision,
} from '../shared/contract';
import type { EngineHost } from './engine-host';
import { requiredSessionId } from './desktop-state';
import type { DesktopSettingsStore } from './settings-store';
import { setDesktopTitleBarTheme, setDesktopTitleBarZoom } from './window-options';

const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_IMAGE_BASE64_LENGTH = 16_000_000;
const MAX_STRUCTURED_STRING_TOTAL = 32_000_000;
const CAPABILITY_SET = new Set<string>(DESKTOP_CAPABILITIES);
const READ_CAPABILITY_SET = new Set<string>(DESKTOP_READ_CAPABILITIES);
const BOOLEAN_FIRST_CAPABILITIES = new Set<DesktopCapability>([
  'setAutoUpdate', 'setMemoryEnabled', 'setChannelsEnabled',
]);
const BOOLEAN_SECOND_CAPABILITIES = new Set<DesktopCapability>([
  'setMcpServerEnabled', 'setHookRuleEnabled', 'setScheduleEnabled', 'setWebhookEnabled',
]);
const SUBMIT_OPTION_KEYS = new Set(['displayText', 'priority', 'pastedImages', 'pastedTexts']);
const CAPABILITY_REQUEST_KEYS = new Set(['capability', 'args']);
const MODEL_SELECTION_KEYS = new Set(['provider', 'model', 'effort', 'fast']);
const MODEL_CATALOG_OPTION_KEYS = new Set(['force', 'refresh', 'quick']);
const PROVIDER_SETUP_OPTION_KEYS = new Set(['force', 'refresh']);
const TOOL_APPROVAL_KEYS = new Set(['approved', 'reason']);

const CAPABILITY_ARITY = {
  restoreQueued: [0, 2], setEffort: [1, 1], setToolMode: [1, 1], getAutoClear: [0, 0],
  setAutoClear: [0, 1], getUpdateSettings: [0, 0], setAutoUpdate: [1, 1], checkForUpdate: [0, 1],
  runUpdateNow: [0, 0], getUpdateStatus: [0, 0], getProfile: [0, 0], setProfile: [0, 1],
  getCompactionSettings: [0, 0], setCompactionSettings: [0, 1], getMemorySettings: [0, 0],
  setMemoryEnabled: [1, 1], getChannelSettings: [0, 1], setChannelsEnabled: [1, 1],
  getVoiceStatus: [0, 0], toggleVoice: [0, 0],
  agentControl: [0, 1], toolsStatus: [0, 1], selectTools: [1, 1], getSystemShell: [0, 0],
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
  setWorkflow: [1, 1], toggleRemote: [0, 0], claimRemote: [0, 0], isRemoteEnabled: [0, 0],
  listThemes: [0, 0], getTheme: [0, 0], setTheme: [1, 2], setAgentRoute: [2, 2],
  setDefaultProvider: [1, 1], listProviders: [0, 0], getProviderSetup: [0, 1],
  getUsageDashboard: [0, 1], getOnboardingStatus: [0, 0], skipOnboarding: [0, 0],
  completeOnboarding: [0, 1], loginOAuthProvider: [1, 1], beginOAuthProviderLogin: [1, 1],
  getOAuthProviderLoginStatus: [1, 1], completeOAuthProviderLogin: [2, 2], cancelOAuthProviderLogin: [1, 1],
  saveProviderApiKey: [2, 2], saveOpenCodeGoUsageAuth: [1, 1], loginOpenCodeGoUsage: [0, 0],
  saveOpenAIUsageSessionKey: [1, 1], setLocalProvider: [2, 2], authenticateProvider: [2, 2],
  forgetProviderAuth: [1, 1], getChannelSetup: [0, 0], getChannelWorkerStatus: [0, 0],
  setBackend: [1, 1], saveDiscordToken: [1, 1], forgetDiscordToken: [0, 0],
  saveTelegramToken: [1, 1], forgetTelegramToken: [0, 0], saveWebhookAuthtoken: [1, 1],
  forgetWebhookAuthtoken: [0, 0], setChannel: [1, 1], setWebhookConfig: [1, 1],
  saveSchedule: [1, 1], deleteSchedule: [1, 1], setScheduleEnabled: [2, 2], saveWebhook: [1, 1],
  deleteWebhook: [1, 1], setWebhookEnabled: [2, 2], clear: [0, 0], transcribeAudio: [1, 1],
} as const satisfies Record<DesktopCapability, readonly [number, number]>;

function requiredString(value: unknown, name: string, maximum = 32_768): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new TypeError(`${name} is invalid.`);
  return text;
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

function projectDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('alias must be a string.');
  const text = value.trim();
  if (text.length > 120 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError('alias is invalid.');
  }
  return text;
}

function sessionDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('title must be a string.');
  const text = value.trim();
  if (!text || text.length > 1_024 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError('title is invalid.');
  }
  return text;
}

function requiredFileSearchLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 200) {
    throw new TypeError('limit is invalid.');
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

function requiredPromptContent(value: unknown): DesktopPromptContent {
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
    throw new TypeError('prompt part type is unsupported.');
  });
  if (!hasContent) throw new TypeError('prompt is empty.');
  return content;
}

function requiredSubmitOptions(value: unknown): DesktopSubmitOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('submit options are invalid.');
  }
  validateStructuredValue(value);
  const input = value as Record<string, unknown>;
  requireAllowedKeys(input, SUBMIT_OPTION_KEYS, 'submit options');
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
    capability === 'saveTelegramToken' || capability === 'saveWebhookAuthtoken') {
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
  return { capability, args };
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

function requiredModelSelection(value: unknown): DesktopModelSelection {
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

function requiredModelCatalogOptions(value: unknown): DesktopModelCatalogOptions {
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

interface DesktopIpcDependencies {
  app: Pick<App, 'quit'>;
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>;
  shell: Pick<Shell, 'openPath' | 'openExternal'>;
  settingsStore?: Pick<DesktopSettingsStore, 'read' | 'update' | 'readZoom' | 'updateZoom'>;
  updater?: {
    getState(): DesktopUpdaterState;
    subscribe(listener: (state: DesktopUpdaterState) => void): () => void;
    check(): Promise<DesktopUpdaterState>;
    install(): Promise<void>;
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
  if (value === 'autoClear' || value === 'autoCompact') return value;
  throw new TypeError('setting key is invalid.');
}

export function registerDesktopIpc(
  window: BrowserWindow,
  host: EngineHost,
  { app, ipcMain, dialog, shell, settingsStore, updater }: DesktopIpcDependencies,
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

  handle(DESKTOP_IPC.chooseProject, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a Mixdog project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(DESKTOP_IPC.startProject, (_event, projectPath) =>
    host.startProject(requiredString(projectPath, 'projectPath')));
  handle(DESKTOP_IPC.startProjectTask, (_event, projectPath) =>
    host.startProjectTask(requiredString(projectPath, 'projectPath')));
  handle(DESKTOP_IPC.startTask, () => host.startTask());
  handle(DESKTOP_IPC.listProjects, () => host.listProjects());
  handle(DESKTOP_IPC.openProjectInExplorer, async (_event, projectPath) => {
    const directory = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
    const failure = await shell.openPath(directory);
    if (failure) throw new Error(`Unable to open project folder: ${failure}`);
  });
  handle(DESKTOP_IPC.openExternal, (_event, url) =>
    shell.openExternal(requiredExternalUrl(url)));
  handle(DESKTOP_IPC.renameProject, (_event, projectPath, alias) =>
    host.renameProject(
      requiredString(projectPath, 'projectPath'),
      projectDisplayName(alias),
    ));
  handle(DESKTOP_IPC.setProjectPinned, (_event, projectPath, pinned) => {
    if (typeof pinned !== 'boolean') throw new TypeError('pinned must be a boolean.');
    return host.setProjectPinned(requiredString(projectPath, 'projectPath'), pinned);
  });
  handle(DESKTOP_IPC.removeProject, (_event, projectPath) =>
    host.removeProject(requiredString(projectPath, 'projectPath')));
  handle(DESKTOP_IPC.listSessions, () => host.listSessions());
  handle(DESKTOP_IPC.renameSession, (_event, sessionId, title) =>
    host.renameSession(requiredSessionId(sessionId), sessionDisplayName(title)));
  handle(DESKTOP_IPC.deleteSession, (_event, sessionId) =>
    host.deleteSession(requiredSessionId(sessionId)));
  handle(DESKTOP_IPC.resumeSession, (_event, sessionId) =>
    host.resumeSession(requiredSessionId(sessionId)));
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
  handle(DESKTOP_IPC.getSnapshot, () => host.getSnapshot());
  handle(DESKTOP_IPC.getUpdaterState, () => updater?.getState() ?? { status: 'disabled' });
  handle(DESKTOP_IPC.checkForDesktopUpdate, () =>
    updater?.check() ?? Promise.resolve({ status: 'disabled' } as const));
  handle(DESKTOP_IPC.showDesktopUpdate, async () => {
    const current = updater?.getState() ?? { status: 'disabled' } as const;
    if (current.status !== 'ready' || !updater) return current;
    const response = await dialog.showMessageBox(window, {
      type: 'info',
      title: 'Update Ready',
      message: `Mixdog ${current.version} has been downloaded.`,
      detail: 'Restart now to install the update?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response.response === 0) await updater.install();
    return updater.getState();
  });
  handle(DESKTOP_IPC.submit, (_event, prompt, options) =>
    host.submit(requiredPromptContent(prompt), requiredSubmitOptions(options)));
  handle(DESKTOP_IPC.abort, () => host.abort());
  handle(DESKTOP_IPC.resolveToolApproval, (_event, id, input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof (input as ToolApprovalDecision).approved !== 'boolean') {
      throw new TypeError('decision is invalid.');
    }
    requireAllowedKeys(input as Record<string, unknown>, TOOL_APPROVAL_KEYS, 'decision');
    const decision = input as ToolApprovalDecision;
    if (decision.reason !== undefined &&
      (typeof decision.reason !== 'string' || decision.reason.length > 4_096)) {
      throw new TypeError('decision.reason is invalid.');
    }
    return host.resolveToolApproval(requiredString(id, 'approval id', 1_024), {
      approved: decision.approved,
      reason: decision.reason,
    });
  });
  handle(DESKTOP_IPC.listProviderModels, (_event, options) =>
    host.listProviderModels(requiredModelCatalogOptions(options)));
  handle(DESKTOP_IPC.setModelRoute, (_event, selection) =>
    host.setModelRoute(requiredModelSelection(selection)));
  handle(DESKTOP_IPC.setFast, (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    return host.setFast(enabled);
  });
  if (settingsStore) {
    handle(DESKTOP_IPC.readSettings, () => settingsStore.read());
    handle(DESKTOP_IPC.updateSetting, (_event, key, enabled) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return settingsStore.update(requiredDesktopSettingKey(key), enabled);
    });
  }
  handle(DESKTOP_IPC.getZoomFactor, async () => {
    const factor = settingsStore ? await settingsStore.readZoom() : 1;
    window.webContents.setZoomFactor(factor);
    setDesktopTitleBarZoom(window, factor);
    return factor;
  });
  handle(DESKTOP_IPC.setZoomFactor, async (_event, value) => {
    const requested = requiredZoomFactor(value);
    const factor = settingsStore ? await settingsStore.updateZoom(requested) : requested;
    window.webContents.setZoomFactor(factor);
    setDesktopTitleBarZoom(window, factor);
    window.webContents.send(DESKTOP_IPC.zoomFactorChanged, factor);
    return factor;
  });
  // Renderer-resolved theme (system preference / stored preference / engine
  // theme) drives the native caption symbol color. The capability path below
  // only covers explicit getTheme/setTheme calls; preference-based light mode
  // never hit it, leaving white symbols invisible on the light band.
  handle(DESKTOP_IPC.applyTitleBarTheme, (_event, theme) => {
    setDesktopTitleBarTheme(window, requiredString(theme, 'theme'));
  });
  handle(DESKTOP_IPC.invokeCapability, async (_event, input) => {
    const request = requiredDesktopCapabilityRequest(input);
    const result = await host.invokeCapability(request.capability, request.args);
    if (request.capability === 'getTheme' || request.capability === 'setTheme') {
      setDesktopTitleBarTheme(window, result);
    }
    return result;
  });
  handle(DESKTOP_IPC.readCapabilities, (_event, input) =>
    host.readCapabilities(requiredDesktopCapabilityReadRequests(input)));
  handle(DESKTOP_IPC.dispose, () => host.dispose());
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

  // Zed "Get Notified" parity: when a turn finishes while the window is in
  // the background, raise an OS notification that refocuses on click.
  let turnWasBusy = false;
  const unsubscribeState = host.subscribe((snapshot) => {
    const busy = (snapshot as Record<string, unknown> | null)?.busy === true;
    if (turnWasBusy && !busy && !window.isDestroyed() && !window.isFocused()
      && NotificationCtor && NotificationCtor.isSupported()) {
      const notice = new NotificationCtor({
        title: 'Mixdog',
        body: 'Response ready — the agent finished this turn.',
      });
      notice.on('click', () => {
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      });
      notice.show();
    }
    turnWasBusy = busy;
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(DESKTOP_IPC.state, snapshot);
    }
  });
  const unsubscribeUpdater = updater?.subscribe((next) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(DESKTOP_IPC.updaterState, next);
    }
  }) ?? (() => {});
  // Renderer perf lines ride a fire-and-forget event channel (no invoke).
  const onPerfLog = (_event: Electron.IpcMainEvent, line: unknown): void => {
    (host as { perfLog?: (line: string) => void }).perfLog?.(String(line ?? ''));
  };
  ipcMain.on(DESKTOP_IPC.perfLog, onPerfLog);
  const eventChannels = new Set<string>([DESKTOP_IPC.state, DESKTOP_IPC.updaterState, DESKTOP_IPC.perfLog]);
  const channels = Object.values(DESKTOP_IPC).filter((channel) => !eventChannels.has(channel));
  let removed = false;

  return () => {
    if (removed) return;
    removed = true;
    unsubscribeState();
    unsubscribeUpdater();
    ipcMain.removeListener(DESKTOP_IPC.perfLog, onPerfLog);
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
