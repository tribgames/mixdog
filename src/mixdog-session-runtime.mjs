import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ensureProjectMixdogMd, ensureStandaloneEnvironment } from './standalone/seeds.mjs';
import { createStandaloneBridge } from './standalone/bridge-tool.mjs';
import { EXPLORE_TOOL, runExplore } from './standalone/explore-tool.mjs';
import { createStandaloneChannelWorker } from './standalone/channel-worker.mjs';
import { createStandaloneHookBus } from './standalone/hook-bus.mjs';
import { writeLastSessionCwd } from './runtime/shared/user-cwd.mjs';
import { cancelBackgroundTasks } from './runtime/shared/background-tasks.mjs';
import { createWorkspaceRouter, formatWorkspaceSessionContext } from './runtime/shared/workspace-router.mjs';
import {
  PROVIDER_STATUS_TOOL,
  beginOAuthProviderLogin,
  forgetProviderAuth,
  loginOAuthProvider,
  providerSetup,
  renderProviderStatus,
  saveOpenAIUsageSessionKey,
  saveOpenCodeGoUsageAuth,
  saveProviderApiKey,
  setLocalProvider,
} from './standalone/provider-admin.mjs';
import { createUsageDashboard } from './standalone/usage-dashboard.mjs';
import {
  channelSetup,
  deleteChannel,
  deleteSchedule,
  deleteWebhook,
  forgetDiscordToken,
  forgetWebhookAuthtoken,
  renderChannelStatus,
  saveChannel,
  saveDiscordToken,
  saveSchedule,
  saveWebhook,
  saveWebhookAuthtoken,
  setScheduleEnabled,
  setWebhookEnabled,
  setWebhookConfig,
} from './standalone/channel-admin.mjs';
import {
  addPlugin as registryAddPlugin,
  listRegisteredPlugins,
  pluginAdminStatus,
  removePlugin as registryRemovePlugin,
  updatePlugin as registryUpdatePlugin,
} from './standalone/plugin-admin.mjs';
import {
  estimateMessagesTokens,
  estimateRequestReserveTokens,
  estimateToolSchemaTokens,
} from './runtime/agent/orchestrator/session/context-utils.mjs';

function sessionMessageText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content)
    ? content
    : (content && typeof content === 'object' && Array.isArray(content.content) ? content.content : null);
  if (parts) {
    return parts.map((part) => {
      if (typeof part === 'string') return part;
      return part?.text ?? '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  try { return JSON.stringify(content); } catch { return String(content); }
}

function roughTokenCount(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

function messageContextText(message) {
  if (!message || typeof message !== 'object') return '';
  let text = sessionMessageText(message.content);
  if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
    try { text += `\n${JSON.stringify(message.toolCalls)}`; }
    catch { text += `\n[${message.toolCalls.length} tool calls]`; }
  }
  if (message.role === 'tool' && message.toolCallId) text += `\n${message.toolCallId}`;
  return text;
}

function summarizeContextMessages(messages) {
  const rows = {
    system: { count: 0, tokens: 0 },
    user: { count: 0, tokens: 0 },
    assistant: { count: 0, tokens: 0 },
    tool: { count: 0, tokens: 0 },
    other: { count: 0, tokens: 0 },
  };
  let toolCallCount = 0;
  let toolCallTokens = 0;
  let toolResultCount = 0;
  let toolResultTokens = 0;
  for (const message of messages || []) {
    const role = rows[message?.role] ? message.role : 'other';
    const tokens = roughTokenCount(messageContextText(message)) + 4;
    rows[role].count += 1;
    rows[role].tokens += tokens;
    if (message?.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      toolCallCount += message.toolCalls.length;
      try { toolCallTokens += roughTokenCount(JSON.stringify(message.toolCalls)); }
      catch { toolCallTokens += roughTokenCount(`[${message.toolCalls.length} tool calls]`); }
    }
    if (message?.role === 'tool') {
      toolResultCount += 1;
      toolResultTokens += tokens;
    }
  }
  return {
    count: Array.isArray(messages) ? messages.length : 0,
    estimatedTokens: Array.isArray(messages) ? estimateMessagesTokens(messages) : 0,
    roles: rows,
    toolCallCount,
    toolCallTokens,
    toolResultCount,
    toolResultTokens,
  };
}

function isSessionPreviewNoise(text) {
  const value = String(text || '').trim();
  return !value
    || value.startsWith('<system-reminder>')
    || value.startsWith('</system-reminder>')
    || /^#\s*permission\b/i.test(value)
    || /^permission:\s*/i.test(value)
    || /^cwd:\s*/i.test(value);
}

function cleanSessionPreview(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

const RUNTIME = './runtime/agent/orchestrator';
const SEARCH_RUNTIME = './runtime/search/index.mjs';
const SEARCH_TOOL_DEFS = './runtime/search/tool-defs.mjs';
const MEMORY_TOOL_DEFS = './runtime/memory/tool-defs.mjs';
const MEMORY_RUNTIME = './runtime/memory/index.mjs';
const CHANNEL_TOOL_DEFS = './runtime/channels/tool-defs.mjs';
const CHANNEL_WORKER_ENTRY = './runtime/channels/index.mjs';
const CODE_GRAPH_TOOL_DEFS = './runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
const CODE_GRAPH_RUNTIME = './runtime/agent/orchestrator/tools/code-graph.mjs';
const STATUSLINE_SESSION_ROUTES = './vendor/statusline/src/gateway/session-routes.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const STANDALONE_SOURCE_ROOT = __dirname;
// Resource root stays at src/ because defaults/, rules/, runtime/, vendor/ live
// there. User-owned standalone state lives under MIXDOG_HOME (~/.mixdog).
const STANDALONE_ROOT = STANDALONE_SOURCE_ROOT;
const MIXDOG_HOME = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
const STANDALONE_DATA_DIR = process.env.MIXDOG_DATA_DIR || join(MIXDOG_HOME, 'data');

const DEFAULT_PROVIDER = 'anthropic-oauth';
const DEFAULT_MODEL = '';
const TOOL_MODES = new Set(['full', 'readonly', 'lead']);
const ALL_EFFORT_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_LABELS = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

const BOOT_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_BOOT_PROFILE || ''));
const BOOT_PROFILE_START = globalThis.__mixdogBootProfileStart || (globalThis.__mixdogBootProfileStart = performance.now());

function bootProfile(event, fields = {}) {
  if (!BOOT_PROFILE_ENABLED) return;
  const elapsedMs = performance.now() - BOOT_PROFILE_START;
  const parts = [`[mixdog-boot] +${elapsedMs.toFixed(1)}ms`, event];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`);
  }
  try { process.stderr.write(`${parts.join(' ')}\n`); } catch {}
}

async function profiledImport(label, spec, { optional = false } = {}) {
  const startedAt = performance.now();
  try {
    const mod = await import(spec);
    bootProfile(`import:${label}`, { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  } catch (error) {
    bootProfile(`import:${label}:failed`, {
      ms: (performance.now() - startedAt).toFixed(1),
      error: error?.message || String(error),
    });
    if (optional) return null;
    throw error;
  }
}
const EFFORT_OPTIONS_BY_PROVIDER = {
  openai: ['none', 'low', 'medium', 'high', 'xhigh'],
  'openai-oauth': ['none', 'low', 'medium', 'high', 'xhigh'],
  anthropic: ['low', 'medium', 'high', 'max'],
  'anthropic-oauth': ['low', 'medium', 'high', 'xhigh', 'max'],
  xai: ['none', 'low', 'medium', 'high'],
  'grok-oauth': ['none', 'low', 'medium', 'high'],
  'opencode-go': ['high', 'max'],
};
const EFFORT_BY_FAMILY = {
  opus: ['low', 'medium', 'high', 'xhigh', 'max'],
  sonnet: ['low', 'medium', 'high'],
  haiku: [],
  'gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-mini': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-nano': ['none', 'low', 'medium', 'high'],
  'gpt-codex': ['none', 'low', 'medium', 'high'],
  grok: ['none', 'low', 'medium', 'high'],
};
const EFFORT_FALLBACKS = {
  max: ['max', 'xhigh', 'high', 'medium', 'low'],
  xhigh: ['xhigh', 'high', 'medium', 'low'],
  high: ['high', 'medium', 'low'],
  medium: ['medium', 'low'],
  low: ['low'],
  none: ['none'],
};

export const TOOL_SEARCH_TOOL = {
  name: 'tool_search',
  title: 'Tool Search',
  annotations: {
    title: 'Tool Search',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  description: 'Search the current standalone tool surface and select deferred tools/skills for the task. Use before unfamiliar or currently inactive tools.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional search text, e.g. edit, bridge, memory, skill, mcp.' },
      select: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Tool/skill names to activate, as comma-separated text or an array.' },
      limit: { type: 'number', description: 'Maximum matches to return.' },
    },
    additionalProperties: false,
  },
};

const CHANNEL_STATUS_TOOL = {
  name: 'channel_status',
  title: 'Channel Status',
  annotations: {
    title: 'Channel Status',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    bridgeHidden: true,
  },
  description: 'List standalone Discord/channel/schedule/webhook configuration status. Read-only and never returns secrets.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const CWD_TOOL = {
  name: 'cwd',
  title: 'Current Working Directory',
  annotations: {
    title: 'Current Working Directory',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    bridgeHidden: true,
  },
  description: 'Show or set the standalone session working directory. Default get; action=set requires path.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'], description: 'Default get, or set when path is provided.' },
      path: { type: 'string', description: 'Directory path for action=set. Relative paths resolve from the current cwd.' },
    },
    additionalProperties: false,
  },
};

const MEASURED_TOOL_USAGE = Object.freeze({
  read: 710,
  code_graph: 520,
  grep: 500,
  glob: 460,
  list: 430,
  apply_patch: 400,
  explore: 360,
  bridge: 330,
  shell: 81,
  cwd: 2,
  diagnostics: 2,
  recall: 2,
  search: 2,
  web_fetch: 2,
  provider_status: 2,
  channel_status: 2,
});
const MEASURED_TOOL_ORDER = Object.freeze(Object.keys(MEASURED_TOOL_USAGE));
const DEFERRED_ALWAYS_ACTIVE_TOOLS = new Set([
  'tool_search',
  'recall',
  'search',
  'web_fetch',
]);
const LEAD_DISALLOWED_TOOLS = Object.freeze(['diagnostics', 'open_config']);
const DEFERRED_DEFAULT_FULL_LIMIT = 8;
const DEFERRED_DEFAULT_READONLY_TOOLS = Object.freeze([
  'read',
  'code_graph',
  'grep',
  'glob',
  'list',
  'explore',
  'tool_search',
]);
const DEFERRED_DEFAULT_LEAD_TOOLS = Object.freeze([
  'read',
  'code_graph',
  'grep',
  'glob',
  'list',
  'explore',
  'apply_patch',
  'bridge',
  'recall',
  'search',
  'web_fetch',
  'cwd',
  'tool_search',
]);
const READONLY_TOOL_NAMES = new Set([
  'read',
  'list',
  'grep',
  'glob',
  'code_graph',
  'search',
  'web_fetch',
  'recall',
  'memory',
  'provider_status',
  'channel_status',
  'schedule_status',
  'fetch',
]);
const BRIDGE_HIDDEN_WRAPPER_TOOLS = new Set(['explore', 'search']);

function applyStandaloneToolDefaults(tool) {
  if (!tool || !BRIDGE_HIDDEN_WRAPPER_TOOLS.has(tool.name)) return tool;
  return {
    ...tool,
    annotations: {
      ...(tool.annotations || {}),
      bridgeHidden: true,
    },
  };
}
const DEFERRED_SELECT_ALIASES = {
  filesystem: ['read', 'list', 'grep', 'glob'],
  search: ['search', 'web_fetch'],
  web: ['web_fetch', 'search'],
  memory: ['memory', 'recall'],
  channels: ['reply', 'fetch', 'react', 'edit_message', 'download_attachment', 'schedule_status', 'trigger_schedule', 'schedule_control', 'reload_config'],
  discord: ['reply', 'fetch', 'react', 'edit_message', 'download_attachment'],
  providers: ['provider_status'],
  provider: ['provider_status'],
  status: ['provider_status', 'channel_status', 'schedule_status'],
  schedule: ['schedule_status', 'trigger_schedule', 'schedule_control'],
  channel: ['channel_status'],
  explore: ['explore'],
  discovery: ['explore'],
  bridge: ['bridge'],
  graph: ['code_graph'],
  code: ['code_graph'],
  shell: ['shell', 'task'],
};

function normalizeToolMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return TOOL_MODES.has(value) ? value : 'full';
}

function normalizeEffortInput(value) {
  const v = clean(value).toLowerCase();
  if (!v || v === 'auto') return null;
  if (!ALL_EFFORT_LEVELS.has(v)) {
    throw new Error(`effort must be one of auto, ${[...ALL_EFFORT_LEVELS].join(', ')}`);
  }
  return v;
}

function effortOptionsFor(provider, model) {
  const providerAllowed = EFFORT_OPTIONS_BY_PROVIDER[provider] || null;
  const filterProvider = (values) => {
    const unique = [...new Set((values || []).map(clean).filter(Boolean))];
    return providerAllowed ? unique.filter((v) => providerAllowed.includes(v)) : unique;
  };
  const declared = Array.isArray(model?.reasoningLevels)
    ? model.reasoningLevels.map(clean).filter(Boolean)
    : [];
  if (Array.isArray(model?.reasoningLevels)) return filterProvider(declared);
  const family = clean(model?.family).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EFFORT_BY_FAMILY, family)) {
    return filterProvider(EFFORT_BY_FAMILY[family]);
  }
  return providerAllowed || [];
}

function coerceEffortFor(provider, model, effort) {
  if (!effort) return null;
  const allowed = effortOptionsFor(provider, model);
  if (!allowed || allowed.length === 0) return null;
  if (allowed.includes(effort)) return effort;
  for (const candidate of EFFORT_FALLBACKS[effort] || []) {
    if (allowed.includes(candidate)) return candidate;
  }
  return null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function modelSettingsFor(config, provider, model) {
  const key = routeFastKey(provider, model);
  const value = key ? config?.modelSettings?.[key] : null;
  return value && typeof value === 'object' ? value : {};
}

function normalizeSavedEffort(value) {
  try {
    return normalizeEffortInput(value);
  } catch {
    return null;
  }
}

function effortItemsFor(provider, model, activeEffort) {
  const allowed = effortOptionsFor(provider, model);
  const items = [];
  for (const value of allowed || []) {
    items.push({
      value,
      label: EFFORT_LABELS[value] || value,
      description: value === activeEffort ? 'current' : '',
    });
  }
  return items;
}

function toolSpecForMode(mode) {
  return mode === 'readonly' ? ['tools:readonly'] : 'full';
}

function clean(value) {
  return String(value ?? '').trim();
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function countSkillFiles(root) {
  const skillsDir = join(root, 'skills');
  if (!existsSync(skillsDir)) return 0;
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^(SKILL|skill)\.md$/i.test(entry.name) || entry.name.toLowerCase().endsWith('.md')) count += 1;
    }
  };
  try { walk(skillsDir); } catch { return count; }
  return count;
}

function mcpScriptForPlugin(root) {
  const candidates = [
    'scripts/run-mcp.mjs',
    'mcp/server.mjs',
    'server.mjs',
  ];
  return candidates.find((rel) => existsSync(join(root, rel))) || null;
}

function pluginManifest(root) {
  return readJsonSafe(join(root, '.codex-plugin', 'plugin.json'))
    || readJsonSafe(join(root, 'plugin.json'))
    || {};
}

function pluginMcpServerName(plugin = {}) {
  const base = clean(plugin.name || plugin.title || 'plugin')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base ? `plugin-${base}` : 'plugin-mcp';
}

function findPreset(config, key) {
  const wanted = clean(key).toLowerCase();
  if (!wanted) return null;
  const presets = Array.isArray(config?.presets) ? config.presets : [];
  return presets.find((p) => {
    const id = clean(p?.id).toLowerCase();
    const name = clean(p?.name).toLowerCase();
    return id === wanted || name === wanted;
  }) || null;
}

function resolveRoute(config, { provider, model, effort, fast } = {}) {
  const explicitProvider = clean(provider);
  const explicitModel = clean(model);
  const hasExplicitEffort = effort !== undefined;
  const explicitEffort = hasExplicitEffort ? normalizeEffortInput(effort) : undefined;
  const hasExplicitFast = fast !== undefined;
  const explicitFast = fast === true;

  if (explicitModel && !explicitProvider) {
    const preset = findPreset(config, explicitModel);
    if (preset) {
      const p = clean(preset.provider) || DEFAULT_PROVIDER;
      const m = clean(preset.model) || DEFAULT_MODEL;
      const saved = modelSettingsFor(config, p, m);
      return {
        provider: p,
        model: m,
        preset,
        effort: hasExplicitEffort ? explicitEffort : normalizeSavedEffort(saved.effort ?? preset.effort),
        fast: hasExplicitFast ? explicitFast : (hasOwn(saved, 'fast') ? saved.fast === true : (preset.fast === true || fastPreferenceFor(config, p, m))),
      };
    }
  }

  if (!explicitProvider && !explicitModel) {
    const defaultKey = config?.default;
    const preset = findPreset(config, defaultKey);
    if (preset) {
      const p = clean(preset.provider) || DEFAULT_PROVIDER;
      const m = clean(preset.model) || DEFAULT_MODEL;
      const saved = modelSettingsFor(config, p, m);
      return {
        provider: p,
        model: m,
        preset,
        effort: hasExplicitEffort ? explicitEffort : normalizeSavedEffort(saved.effort ?? preset.effort),
        fast: hasExplicitFast ? explicitFast : (hasOwn(saved, 'fast') ? saved.fast === true : (preset.fast === true || fastPreferenceFor(config, p, m))),
      };
    }
  }

  const p = explicitProvider || DEFAULT_PROVIDER;
  const m = explicitModel || DEFAULT_MODEL;
  const saved = modelSettingsFor(config, p, m);
  return {
    provider: p,
    model: m,
    preset: null,
    effort: hasExplicitEffort ? explicitEffort : normalizeSavedEffort(saved.effort),
    fast: hasExplicitFast ? explicitFast : (hasOwn(saved, 'fast') ? saved.fast === true : fastPreferenceFor(config, p, m)),
  };
}

function ensureProviderEnabled(config, provider) {
  const providers = { ...(config?.providers || {}) };
  providers[provider] = { ...(providers[provider] || {}), enabled: true };
  return providers;
}

const AUTO_CLEAR_DEFAULT_IDLE_MS = 60 * 60 * 1000;

function normalizeAutoClearConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const idleMs = Number(raw.idleMs ?? raw.thresholdMs ?? raw.idleMillis);
  return {
    enabled: raw.enabled !== false,
    idleMs: Number.isFinite(idleMs) && idleMs > 0 ? Math.max(60_000, Math.round(idleMs)) : AUTO_CLEAR_DEFAULT_IDLE_MS,
  };
}

function formatDurationMs(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  return `${Math.round(value / 1000)}s`;
}

function parseDurationMs(input) {
  const text = clean(input).toLowerCase();
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2] || 'm';
  const mult = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1;
  return Math.max(60_000, Math.round(n * mult));
}

const FAST_CAPABLE_PROVIDERS = new Set(['anthropic', 'anthropic-oauth', 'openai', 'openai-oauth']);

function routeFastKey(provider, model) {
  const p = clean(provider);
  const m = clean(model);
  return p && m ? `${p}/${m}` : '';
}

function openAiModelMetaSupportsFast(model) {
  const tiers = Array.isArray(model?.serviceTiers) ? model.serviceTiers : [];
  const speedTiers = Array.isArray(model?.additionalSpeedTiers) ? model.additionalSpeedTiers : [];
  if (tiers.length || speedTiers.length || model?.defaultServiceTier) {
    return tiers.some((tier) => tier?.id === 'priority')
      || speedTiers.includes('priority')
      || model?.defaultServiceTier === 'priority';
  }
  const id = clean(model?.id || model).toLowerCase();
  if (id.includes('mini') || id.includes('nano') || id.includes('codex')) return false;
  return /^gpt-5(\.|-|$)/.test(id);
}

function openAiDirectModelSupportsFast(model) {
  const id = clean(model?.id || model);
  return /^gpt-5\.5(?:-\d{4}|$)/.test(id)
    || /^gpt-5\.4(?:-\d{4}|$)/.test(id)
    || /^gpt-5\.4-mini(?:-\d{4}|$)/.test(id);
}

function anthropicModelMetaSupportsFast(model) {
  const id = clean(model?.id || model).toLowerCase();
  return /^claude-(opus|sonnet)/.test(id);
}

function fastCapableFor(provider, model) {
  const p = clean(provider);
  if (!FAST_CAPABLE_PROVIDERS.has(p)) return false;
  if (p === 'openai') return openAiDirectModelSupportsFast(model);
  if (p === 'openai-oauth') return openAiModelMetaSupportsFast(model);
  if (p === 'anthropic' || p === 'anthropic-oauth') return anthropicModelMetaSupportsFast(model);
  return false;
}

function fastPreferenceFor(config, provider, model) {
  const key = routeFastKey(provider, model);
  if (!key) return false;
  const saved = config?.modelSettings?.[key];
  if (saved && typeof saved === 'object' && hasOwn(saved, 'fast')) return saved.fast === true;
  return config?.fastModels?.[key] === true;
}

function saveModelSettings(cfgMod, route, { fastCapable = true } = {}) {
  const key = routeFastKey(route?.provider, route?.model);
  if (!key) return cfgMod.loadConfig();
  const nextConfig = cfgMod.loadConfig();
  const modelSettings = { ...(nextConfig.modelSettings || {}) };
  const nextSetting = { ...(modelSettings[key] || {}) };
  if (hasOwn(route, 'effort') && route.effort) nextSetting.effort = route.effort;
  else delete nextSetting.effort;
  if (fastCapable) nextSetting.fast = route.fast === true;
  else nextSetting.fast = false;
  modelSettings[key] = nextSetting;

  // Legacy compatibility: keep fastModels true entries for old readers, but
  // let modelSettings.fast=false override them in new readers.
  const fastModels = { ...(nextConfig.fastModels || {}) };
  if (nextSetting.fast === true) fastModels[key] = true;
  else delete fastModels[key];

  const savedConfig = { ...nextConfig, modelSettings, fastModels };
  cfgMod.saveConfig(savedConfig);
  return savedConfig;
}

function routeForStatusline(route) {
  const out = {
    mode: 'fixed',
    defaultProvider: route.provider,
    defaultModel: route.model,
  };
  const preset = route.preset || {};
  if (preset.id) out.presetId = preset.id;
  if (preset.name) out.presetName = preset.name;
  if (preset.modelDisplay) out.modelDisplay = preset.modelDisplay;
  if (route.fast === true || route.fast === false) out.fast = route.fast;
  else if (preset.fast === true || preset.fast === false) out.fast = preset.fast;
  if (route.effectiveEffort) {
    out.effort = route.effectiveEffort;
    out.displayEffort = route.effectiveEffort;
  } else if (hasOwn(route, 'effort')) {
    delete out.effort;
    delete out.displayEffort;
  }
  return out;
}

const ONBOARDING_VERSION = 1;
const WORKFLOW_ROUTE_SLOTS = ['lead', 'bridge', 'explorer', 'memory'];
const FIXED_AGENT_SLOTS = Object.freeze([
  { id: 'explore', label: 'Explore', description: 'Broad repository exploration', workflowSlot: 'explorer' },
  { id: 'web-researcher', label: 'Web Researcher', description: 'External current-info research' },
  { id: 'maintainer', label: 'Maintainer', description: 'Background memory and upkeep', workflowSlot: 'memory' },
  { id: 'worker', label: 'Worker', description: 'Scoped implementation' },
  { id: 'heavy-worker', label: 'Heavy Worker', description: 'Broad or multi-file implementation' },
  { id: 'reviewer', label: 'Reviewer', description: 'Diff review and risk checks' },
  { id: 'debugger', label: 'Debugger', description: 'Root-cause analysis and failure tracing' },
]);
const AGENT_ROLE_IDS = new Set(FIXED_AGENT_SLOTS.map((agent) => agent.id));
const agentDefinitionCache = new Map();
const DEFAULT_WORKFLOW_ID = 'default';

function workflowPresetId(slot) {
  return `workflow-${slot}`;
}

function workflowPresetName(slot) {
  return `WORKFLOW ${String(slot || '').toUpperCase()}`;
}

function agentPresetSlot(agentId) {
  return `agent-${String(agentId || '').replace(/[^a-z0-9_.-]+/gi, '-').toLowerCase()}`;
}

function normalizeAgentId(value) {
  const id = clean(value).toLowerCase().replace(/[\s_]+/g, '-');
  if (id === 'explorer') return 'explore';
  if (id === 'maint' || id === 'maintenance' || id === 'memory') return 'maintainer';
  if (id === 'heavy' || id === 'heavyworker') return 'heavy-worker';
  if (id === 'review') return 'reviewer';
  if (id === 'debug') return 'debugger';
  return AGENT_ROLE_IDS.has(id) ? id : '';
}

function normalizeWorkflowId(value, fallback = '') {
  const id = clean(value).toLowerCase().replace(/[\s_]+/g, '-');
  return /^[a-z0-9][a-z0-9_.-]*$/.test(id) ? id : fallback;
}

function readTextSafe(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

function workflowSourceDirs(dataDir) {
  return [
    { root: join(STANDALONE_ROOT, 'workflows'), source: 'built-in' },
    { root: join(dataDir || STANDALONE_DATA_DIR, 'workflows'), source: 'user' },
  ];
}

function agentSourceDirs(dataDir, id) {
  return [
    join(dataDir || STANDALONE_DATA_DIR, 'agents', id),
    join(STANDALONE_ROOT, 'agents', id),
  ];
}

function readWorkflowPackFromDir(dir, source = 'built-in') {
  const manifest = readJsonSafe(join(dir, 'workflow.json'));
  if (!manifest || typeof manifest !== 'object') return null;
  const id = normalizeWorkflowId(manifest.id || manifest.name);
  if (!id) return null;
  const entry = clean(manifest.entry) || 'WORKFLOW.md';
  const body = readTextSafe(join(dir, entry));
  if (!body) return null;
  return {
    id,
    name: clean(manifest.name) || id,
    description: clean(manifest.description),
    entry,
    agents: Array.isArray(manifest.agents) ? manifest.agents.map((agent) => normalizeAgentId(agent) || normalizeWorkflowId(agent)).filter(Boolean) : [],
    body,
    source,
  };
}

function listWorkflowPacks(dataDir) {
  const byId = new Map();
  for (const { root, source } of workflowSourceDirs(dataDir)) {
    if (!existsSync(root)) continue;
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pack = readWorkflowPackFromDir(join(root, entry.name), source);
      if (pack) byId.set(pack.id, pack);
    }
  }
  return [...byId.values()].sort((a, b) => {
    if (a.id === DEFAULT_WORKFLOW_ID) return -1;
    if (b.id === DEFAULT_WORKFLOW_ID) return 1;
    return a.name.localeCompare(b.name);
  });
}

function activeWorkflowId(config) {
  return normalizeWorkflowId(config?.workflow?.active, DEFAULT_WORKFLOW_ID);
}

function loadWorkflowPack(dataDir, id) {
  const wanted = normalizeWorkflowId(id, DEFAULT_WORKFLOW_ID);
  for (const { root, source } of workflowSourceDirs(dataDir).reverse()) {
    const pack = readWorkflowPackFromDir(join(root, wanted), source);
    if (pack) return pack;
  }
  return readWorkflowPackFromDir(join(STANDALONE_ROOT, 'workflows', DEFAULT_WORKFLOW_ID), 'built-in');
}

function loadAgentDefinition(dataDir, id) {
  const agentId = normalizeAgentId(id) || normalizeWorkflowId(id);
  if (!agentId) return null;
  const cacheKey = `${dataDir || STANDALONE_DATA_DIR}\n${agentId}`;
  if (agentDefinitionCache.has(cacheKey)) return agentDefinitionCache.get(cacheKey);
  for (const dir of agentSourceDirs(dataDir, agentId)) {
    const manifest = readJsonSafe(join(dir, 'agent.json')) || {};
    const entry = clean(manifest.entry) || 'AGENT.md';
    const body = readTextSafe(join(dir, entry));
    if (!body) continue;
    const definition = {
      id: agentId,
      name: clean(manifest.name) || FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId)?.label || agentId,
      description: clean(manifest.description) || FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId)?.description || '',
      body,
    };
    agentDefinitionCache.set(cacheKey, definition);
    return definition;
  }
  const legacyBody = readTextSafe(join(dataDir || STANDALONE_DATA_DIR, 'roles', `${agentId}.md`))
    || readTextSafe(join(STANDALONE_ROOT, 'agents', `${agentId}.md`));
  if (!legacyBody) {
    agentDefinitionCache.set(cacheKey, null);
    return null;
  }
  const definition = {
    id: agentId,
    name: FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId)?.label || agentId,
    description: '',
    body: legacyBody,
  };
  agentDefinitionCache.set(cacheKey, definition);
  return definition;
}

function workflowContextBlock(config, dataDir) {
  const pack = loadWorkflowPack(dataDir, activeWorkflowId(config));
  if (!pack) return '';
  const lines = [
    `# Active Workflow: ${pack.name}`,
  ];
  if (pack.description) lines.push(pack.description);
  lines.push(pack.body);

  const agentIds = pack.agents.length ? pack.agents : FIXED_AGENT_SLOTS.map((agent) => agent.id);
  const agentBlocks = agentIds
    .map((id) => loadAgentDefinition(dataDir, id))
    .filter(Boolean);
  if (agentBlocks.length) {
    lines.push('# Available Agents');
    for (const agent of agentBlocks) {
      lines.push(`## ${agent.name} (${agent.id})`);
      if (agent.description) lines.push(agent.description);
      lines.push(agent.body);
    }
  }
  return lines.join('\n\n');
}

function normalizeWorkflowRoute(routeLike, fallback = {}) {
  const provider = clean(routeLike?.provider) || clean(fallback.provider);
  const model = clean(routeLike?.model) || clean(fallback.model);
  if (!provider || !model) return null;
  const effort = normalizeEffortInput(routeLike?.effort ?? fallback.effort);
  const fast = routeLike?.fast ?? fallback.fast;
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(fast === true ? { fast: true } : {}),
  };
}

function upsertWorkflowPreset(presets, slot, routeLike) {
  const route = normalizeWorkflowRoute(routeLike);
  if (!route) return presets;
  const id = workflowPresetId(slot);
  const preset = {
    id,
    name: workflowPresetName(slot),
    type: 'bridge',
    provider: route.provider,
    model: route.model,
    ...(route.effort ? { effort: route.effort } : {}),
    ...(route.fast === true ? { fast: true } : {}),
    tools: 'full',
  };
  const next = (Array.isArray(presets) ? presets : []).filter((p) => clean(p?.id) !== id && clean(p?.name) !== preset.name);
  next.push(preset);
  return next;
}

function summarizeWorkflowRoutes(config) {
  const routes = config?.workflowRoutes && typeof config.workflowRoutes === 'object' ? config.workflowRoutes : {};
  const out = {};
  for (const slot of WORKFLOW_ROUTE_SLOTS) {
    const route = routes[slot];
    if (route?.provider && route?.model) out[slot] = normalizeWorkflowRoute(route);
  }
  return out;
}

function legacyWorkflowRolePreset(dataDir, role) {
  try {
    const file = join(dataDir, 'user-workflow.json');
    if (!existsSync(file)) return '';
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const found = (raw?.roles || []).find((item) => clean(item?.name) === role);
    return clean(found?.preset);
  } catch {
    return '';
  }
}

function routeFromPreset(config, presetName) {
  const preset = findPreset(config, presetName);
  return preset ? normalizeWorkflowRoute(preset) : null;
}

function agentRouteFromConfig(config, agentId, dataDir) {
  const id = normalizeAgentId(agentId);
  if (!id) return null;
  const explicit = normalizeWorkflowRoute(config?.agents?.[id])
    || (id === 'maintainer' ? normalizeWorkflowRoute(config?.agents?.maintenance) : null);
  if (explicit) return explicit;

  const agent = FIXED_AGENT_SLOTS.find((item) => item.id === id);
  if (agent?.workflowSlot) {
    const workflowRoute = normalizeWorkflowRoute(config?.workflowRoutes?.[agent.workflowSlot]);
    if (workflowRoute) return workflowRoute;
  }

  if (id === 'explore') return routeFromPreset(config, config?.maintenance?.explore);
  if (id === 'maintainer') return routeFromPreset(config, config?.maintenance?.memory);

  return routeFromPreset(config, legacyWorkflowRolePreset(dataDir, id));
}

function toolResponseText(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result.content
      .map((part) => (part?.type === 'text' ? part.text || '' : JSON.stringify(part)))
      .join('\n');
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

function parseToolSelection(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return String(value || '')
    .split(/[,\s]+/)
    .map(clean)
    .filter(Boolean);
}

function toolKind(tool) {
  const name = clean(tool?.name);
  if (name.startsWith('mcp__')) return 'mcp';
  if (name.startsWith('skill_') || name === 'skills_list') return 'skill';
  if (tool?.annotations?.bridgeHidden) return 'control';
  if (['edit', 'write', 'apply_patch', 'shell'].includes(name)) return 'write';
  return 'tool';
}

function measuredToolUsage(name) {
  return MEASURED_TOOL_USAGE[clean(name)] || 0;
}

function measuredToolRank(name) {
  const index = MEASURED_TOOL_ORDER.indexOf(clean(name));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function sortedCatalogByMeasuredUsage(catalog) {
  return (catalog || [])
    .map((tool, index) => ({ tool, index }))
    .sort((a, b) => {
      const au = measuredToolUsage(a.tool?.name);
      const bu = measuredToolUsage(b.tool?.name);
      if (bu !== au) return bu - au;
      const ar = measuredToolRank(a.tool?.name);
      const br = measuredToolRank(b.tool?.name);
      if (ar !== br) return ar - br;
      return a.index - b.index;
    })
    .map((entry) => entry.tool);
}

function activeToolForSurface(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  return JSON.parse(JSON.stringify(tool));
}

function filterDisallowedTools(tools, disallowed = []) {
  if (!Array.isArray(disallowed) || disallowed.length === 0) return tools;
  const deny = new Set(disallowed.map((name) => clean(name)).filter(Boolean));
  if (deny.size === 0) return tools;
  return (tools || []).filter((tool) => !deny.has(clean(tool?.name)));
}

function sortedNamesByMeasuredUsage(names) {
  return [...(names || [])].sort((a, b) => {
    const au = measuredToolUsage(a);
    const bu = measuredToolUsage(b);
    if (bu !== au) return bu - au;
    const ar = measuredToolRank(a);
    const br = measuredToolRank(b);
    if (ar !== br) return ar - br;
    return String(a).localeCompare(String(b));
  });
}

export function defaultDeferredToolNames(catalog, mode) {
  if (mode === 'lead') {
    const available = new Set((catalog || []).map((tool) => clean(tool?.name)).filter(Boolean));
    return new Set(DEFERRED_DEFAULT_LEAD_TOOLS.filter((name) => available.has(name)));
  }
  if (mode === 'readonly') {
    const available = new Set((catalog || []).map((tool) => clean(tool?.name)).filter(Boolean));
    return new Set(DEFERRED_DEFAULT_READONLY_TOOLS.filter((name) => available.has(name)));
  }
  const names = new Set(DEFERRED_ALWAYS_ACTIVE_TOOLS);
  const limit = DEFERRED_DEFAULT_FULL_LIMIT;
  for (const tool of sortedCatalogByMeasuredUsage(catalog)) {
    const name = clean(tool?.name);
    if (!name || names.has(name)) continue;
    if (mode === 'readonly' && !isReadonlySelectable(tool)) continue;
    names.add(name);
    if (names.size >= DEFERRED_ALWAYS_ACTIVE_TOOLS.size + limit) break;
  }
  return names;
}

export function compactToolSearchDescription(value, max = 220) {
  const text = clean(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolRow(tool, activeNames = new Set()) {
  const name = clean(tool?.name);
  return {
    name,
    kind: toolKind(tool),
    usage: measuredToolUsage(name),
    active: activeNames.has(name),
    description: compactToolSearchDescription(tool?.description),
  };
}

function toolSearchTokens(value) {
  return (clean(value).toLowerCase().match(/[a-z0-9_.-]+/g) || [])
    .map((token) => token.replace(/[-.]+/g, '_'))
    .filter(Boolean);
}

function toolSearchText(row) {
  const text = `${row.name} ${String(row.name || '').replace(/_/g, ' ')} ${row.kind} ${row.description} ${row.active ? 'active' : 'deferred'}`;
  return `${text} ${text.replace(/[-.]+/g, '_')}`.toLowerCase();
}

function toolSearchMatches(row, query) {
  const raw = clean(query).toLowerCase();
  if (!raw) return true;
  const haystack = toolSearchText(row);
  if (haystack.includes(raw)) return true;
  const tokens = toolSearchTokens(raw);
  if (tokens.length === 0) return haystack.includes(raw);
  return tokens.some((token) => haystack.includes(token));
}

function expandSelectionNames(names) {
  const out = [];
  for (const raw of names || []) {
    const key = clean(raw);
    if (!key) continue;
    const alias = DEFERRED_SELECT_ALIASES[key.toLowerCase()];
    if (alias) out.push(...alias);
    else out.push(key);
  }
  return [...new Set(out)];
}

function isReadonlySelectable(tool) {
  const name = clean(tool?.name);
  if (READONLY_TOOL_NAMES.has(name)) return true;
  const annotations = tool?.annotations || {};
  if (annotations.destructiveHint === true) return false;
  if (annotations.readOnlyHint === true) return true;
  return false;
}

function applyDeferredToolSurface(session, mode, extraTools = []) {
  if (!session || !Array.isArray(session.tools)) return session;
  const byName = new Map();
  for (const tool of [...session.tools, ...(extraTools || [])]) {
    const name = clean(tool?.name);
    if (!name || byName.has(name)) continue;
    byName.set(name, activeToolForSurface(tool));
  }
  const catalog = sortedCatalogByMeasuredUsage([...byName.values()]);
  const defaultNames = defaultDeferredToolNames(catalog, mode);
  session.deferredToolCatalog = catalog;
  session.deferredToolUsage = MEASURED_TOOL_USAGE;
  session.deferredSelectedTools = sortedNamesByMeasuredUsage(defaultNames);
  session.tools.length = 0;
  for (const tool of catalog) {
    if (!defaultNames.has(clean(tool?.name))) continue;
    if (mode === 'readonly' && !isReadonlySelectable(tool)) continue;
    session.tools.push(tool);
  }
  return session;
}

function selectDeferredTools(session, names, mode) {
  const catalog = Array.isArray(session?.deferredToolCatalog)
    ? session.deferredToolCatalog
    : (Array.isArray(session?.tools) ? session.tools : []);
  const active = new Set((session?.tools || []).map((tool) => tool?.name).filter(Boolean));
  const byName = new Map(catalog.map((tool) => [tool?.name, tool]).filter(([name]) => name));
  const added = [];
  const already = [];
  const blocked = [];
  const missing = [];
  for (const name of expandSelectionNames(names)) {
    const tool = byName.get(name);
    if (!tool) {
      missing.push(name);
      continue;
    }
    if (mode === 'readonly' && !isReadonlySelectable(tool)) {
      blocked.push({ name, reason: 'readonly mode' });
      continue;
    }
    if (active.has(name)) {
      already.push(name);
      continue;
    }
    session.tools.push(tool);
    active.add(name);
    added.push(name);
  }
  session.deferredSelectedTools = sortedNamesByMeasuredUsage(active);
  return { added, already, blocked, missing };
}

function renderToolSearch(args = {}, session, mode = 'full') {
  const catalog = Array.isArray(session?.deferredToolCatalog)
    ? session.deferredToolCatalog
    : (Array.isArray(session?.tools) ? session.tools : []);
  const activeNames = new Set((session?.tools || []).map((tool) => tool?.name).filter(Boolean));
  const query = clean(args.query).toLowerCase();
  const selectedNames = parseToolSelection(args.select);
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  const selection = selectedNames.length ? selectDeferredTools(session, selectedNames, mode) : null;
  const nextActiveNames = new Set((session?.tools || []).map((tool) => tool?.name).filter(Boolean));
  const rows = catalog.map((tool) => toolRow(tool, nextActiveNames)).filter((row) => row.name);
  const matches = query
    ? rows.filter((row) => toolSearchMatches(row, query))
    : rows;
  return JSON.stringify({
    selected: selection,
    totalMatches: matches.length,
    matches: matches.slice(0, limit),
    activeTools: sortedNamesByMeasuredUsage(nextActiveNames),
    note: 'standalone: tool_search adds deferred tools to the current session schema for the next model iteration.',
  }, null, 2);
}

function resolveCwdPath(currentCwd, value) {
  const raw = clean(value);
  if (!raw) throw new Error('cwd: path is required for action=set');
  const next = resolve(currentCwd || process.cwd(), raw);
  const stat = statSync(next);
  if (!stat.isDirectory()) throw new Error(`cwd: not a directory: ${next}`);
  return next;
}

export async function createMixdogSessionRuntime({
  provider,
  model,
  cwd = process.cwd(),
  toolMode = 'full',
} = {}) {
  bootProfile('session-runtime:start', { provider, model, toolMode, cwd });
  process.env.MIXDOG_QUIET_SESSION_LOG ??= '1';
  const standaloneStartedAt = performance.now();
  ensureStandaloneEnvironment({
    rootDir: STANDALONE_ROOT,
    dataDir: STANDALONE_DATA_DIR,
  });
  ensureProjectMixdogMd({ cwd });
  bootProfile('standalone-env:ready', { ms: (performance.now() - standaloneStartedAt).toFixed(1) });

  const importsStartedAt = performance.now();
  const [
    cfgMod,
    sharedCfgMod,
    reg,
    mcpClient,
    mgr,
    contextMod,
    internalTools,
    statusRoutes,
    searchToolDefs,
    memoryToolDefs,
    channelToolDefs,
    codeGraphToolDefs,
  ] = await Promise.all([
    profiledImport('config', `${RUNTIME}/config.mjs`),
    profiledImport('shared-config', `${RUNTIME}/../../shared/config.mjs`),
    profiledImport('providers-registry', `${RUNTIME}/providers/registry.mjs`),
    profiledImport('mcp-client', `${RUNTIME}/mcp/client.mjs`),
    profiledImport('session-manager', `${RUNTIME}/session/manager.mjs`),
    profiledImport('context-collect', `${RUNTIME}/context/collect.mjs`),
    profiledImport('internal-tools', `${RUNTIME}/internal-tools.mjs`),
    profiledImport('status-routes', STATUSLINE_SESSION_ROUTES, { optional: true }),
    profiledImport('search-tool-defs', SEARCH_TOOL_DEFS, { optional: true }),
    profiledImport('memory-tool-defs', MEMORY_TOOL_DEFS, { optional: true }),
    profiledImport('channel-tool-defs', CHANNEL_TOOL_DEFS, { optional: true }),
    profiledImport('code-graph-tool-defs', CODE_GRAPH_TOOL_DEFS, { optional: true }),
  ]);
  bootProfile('imports:ready', { ms: (performance.now() - importsStartedAt).toFixed(1) });
  let memoryModPromise = null;
  let memoryInitPromise = null;
  let searchModPromise = null;
  let codeGraphModPromise = null;

  async function getMemoryModule() {
    const startedAt = performance.now();
    memoryModPromise ??= import(MEMORY_RUNTIME);
    const mod = await memoryModPromise;
    if (typeof mod?.init === 'function') {
      memoryInitPromise ??= mod.init();
      await memoryInitPromise;
    }
    bootProfile('memory-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  async function getSearchModule() {
    const startedAt = performance.now();
    searchModPromise ??= import(SEARCH_RUNTIME);
    const mod = await searchModPromise;
    bootProfile('search-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  async function getCodeGraphModule() {
    const startedAt = performance.now();
    codeGraphModPromise ??= import(CODE_GRAPH_RUNTIME);
    const mod = await codeGraphModPromise;
    bootProfile('code-graph-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  function persistLeadRoute(routeLike) {
    const leadRoute = normalizeWorkflowRoute(routeLike);
    if (!leadRoute) return null;

    const nextConfig = { ...(config || {}) };
    nextConfig.presets = upsertWorkflowPreset(nextConfig.presets, 'lead', leadRoute);
    nextConfig.workflowRoutes = {
      ...(nextConfig.workflowRoutes || {}),
      lead: leadRoute,
    };
    nextConfig.default = workflowPresetId('lead');

    cfgMod.saveConfig(nextConfig);
    config = nextConfig;
    return leadRoute;
  }

  async function closePatchRuntimeIfLoaded(options = {}) {
    const closer = globalThis.__mixdogCloseNativePatchServers;
    if (typeof closer !== 'function' || globalThis.__mixdogNativePatchRuntimeTouched !== true) return;
    bootProfile('patch-runtime:close:start');
    const startedAt = performance.now();
    try {
      await closer(options);
    } catch {
      // Best-effort shutdown only; terminal restore must continue.
    } finally {
      bootProfile('patch-runtime:close:done', { ms: (performance.now() - startedAt).toFixed(1) });
    }
  }

  function formatCoreMemoryLines(payload = {}) {
    const seen = new Set();
    const lines = [];
    for (const value of [
      ...(Array.isArray(payload.userLines) ? payload.userLines : []),
      ...(Array.isArray(payload.dbLines) ? payload.dbLines : []),
    ]) {
      const text = clean(value).replace(/\s+/g, ' ');
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${text}`);
      if (lines.length >= 40) break;
    }
    const out = lines.join('\n');
    const maxChars = 6000;
    return out.length > maxChars ? `${out.slice(0, maxChars).replace(/\s+\S*$/, '')}\n- ...` : out;
  }

  async function loadCoreMemoryContext() {
    // Boot should not pay for memory/PG startup unless explicitly requested.
    // Recall and memory tools still initialize the memory service on first use.
    if (process.env.MIXDOG_BOOT_CORE_MEMORY !== '1') {
      bootProfile('core-memory:skipped');
      return '';
    }
    const startedAt = performance.now();
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(''), 2000);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        (async () => {
          const memoryMod = await getMemoryModule();
          if (typeof memoryMod?.buildSessionCoreMemoryPayload !== 'function') return '';
          return formatCoreMemoryLines(await memoryMod.buildSessionCoreMemoryPayload(currentCwd));
        })(),
        timeout,
      ]);
    } catch {
      return '';
    } finally {
      if (timer) clearTimeout(timer);
      bootProfile('core-memory:done', { ms: (performance.now() - startedAt).toFixed(1) });
    }
  }

  const configStartedAt = performance.now();
  let config = cfgMod.loadConfig({ secrets: false });
  let configHasSecrets = false;
  let route = resolveRoute(config, { provider, model });
  bootProfile('config:ready', { ms: (performance.now() - configStartedAt).toFixed(1) });
  let mode = normalizeToolMode(toolMode);
  let session = null;
  let currentCwd = cwd;
  let sessionNeedsCwdRefresh = false;
  const workspaceRouter = createWorkspaceRouter({ entryCwd: cwd });
  let closeRequested = false;
  let channelStartTimer = null;
  const modelMetaByRoute = new Map();
  const notificationListeners = new Set();
  let providerModelsCache = { models: null, at: 0 };
  let providerModelsPromise = null;
  let providerSetupCache = { setup: null, at: 0 };
  let providerSetupPromise = null;
  let providerInitPromise = null;
  const PROVIDER_SETUP_CACHE_TTL_MS = 10_000;
  let mcpFailures = [];
  let preSessionToolSurface = null;
  let contextStatusCacheKey = null;
  let contextStatusCacheValue = null;
  const hooksStartedAt = performance.now();
  const hooks = createStandaloneHookBus({ dataDir: cfgMod.getPluginData() });
  hooks.emit('runtime:start', { cwd: currentCwd, provider: route.provider, model: route.model, toolMode: mode });
  bootProfile('hooks:ready', { ms: (performance.now() - hooksStartedAt).toFixed(1) });

  function contextContentLength(content) {
    if (typeof content === 'string') return content.length;
    if (!Array.isArray(content)) {
      try { return JSON.stringify(content ?? '').length; } catch { return String(content ?? '').length; }
    }
    let length = 0;
    for (const part of content) {
      if (typeof part === 'string') length += part.length;
      else if (typeof part?.text === 'string') length += part.text.length;
      else {
        try { length += JSON.stringify(part ?? '').length; } catch { length += String(part ?? '').length; }
      }
    }
    return length;
  }

  function sameContextStatusKey(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }

  function buildContextStatusCacheKey(messages, tools, bridgeMode) {
    const lastMessage = messages[messages.length - 1] || null;
    const compaction = session?.compaction || null;
    return [
      session?.id || null,
      route.provider,
      route.model,
      currentCwd,
      mode,
      bridgeMode,
      messages,
      messages.length,
      lastMessage,
      lastMessage?.role || null,
      lastMessage?.content || null,
      contextContentLength(lastMessage?.content),
      Array.isArray(lastMessage?.toolCalls) ? lastMessage.toolCalls.length : 0,
      tools,
      tools.length,
      session?.contextWindow || null,
      session?.rawContextWindow || null,
      session?.effectiveContextWindowPercent || null,
      session?.lastContextTokens || 0,
      session?.lastContextTokensUpdatedAt || 0,
      session?.lastContextTokensStaleAfterCompact === true,
      session?.lastInputTokens || 0,
      session?.lastOutputTokens || 0,
      session?.lastCachedReadTokens || 0,
      session?.lastCacheWriteTokens || 0,
      session?.totalInputTokens || 0,
      session?.totalOutputTokens || 0,
      session?.totalCachedReadTokens || 0,
      session?.totalCacheWriteTokens || 0,
      session?.compactBoundaryTokens || 0,
      compaction,
      compaction?.lastChangedAt || 0,
      compaction?.lastCompactAt || 0,
      compaction?.boundaryTokens || 0,
      compaction?.triggerTokens || 0,
    ];
  }

  function mcpTransportLabel(cfg = {}) {
    if (cfg.autoDetect) return `autoDetect:${cfg.autoDetect}`;
    if (cfg.transport === 'http' || cfg.url) return 'http';
    if (cfg.command) return 'stdio';
    return 'unknown';
  }

  function emitRuntimeNotification(content, meta = {}) {
    const text = String(content || '').trim();
    if (!text) return;
    const event = { content: text, meta: meta && typeof meta === 'object' ? meta : {} };
    for (const listener of [...notificationListeners]) {
      try { listener(event); } catch {}
    }
  }

  function notifyFnForSession(callerSessionId) {
    return (text, meta = {}) => {
      const hadRuntimeListener = notificationListeners.size > 0;
      emitRuntimeNotification(text, meta);
      // TUI sessions keep their own Claude-Code-style command queue via
      // onNotification. Headless/model-tool callers have no listener, so fall
      // back to the session manager pending-message queue.
      if (!hadRuntimeListener && callerSessionId && typeof mgr.enqueuePendingMessage === 'function') {
        try { mgr.enqueuePendingMessage(callerSessionId, String(text || '')); } catch {}
      }
    };
  }

  function mcpStatus() {
    const configured = config?.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers
      : {};
    const connected = new Map((mcpClient.getMcpServerStatus?.() || []).map((row) => [row.name, row]));
    const failures = new Map((mcpFailures || []).map((row) => [row.name, row]));
    const servers = [];
    for (const [name, cfg] of Object.entries(configured)) {
      const live = connected.get(name);
      const fail = failures.get(name);
      servers.push({
        name,
        configured: true,
        enabled: cfg?.enabled !== false,
        connected: Boolean(live),
        status: cfg?.enabled === false ? 'disabled' : live ? 'connected' : fail ? 'failed' : 'disconnected',
        transport: mcpTransportLabel(cfg),
        toolCount: live?.toolCount || 0,
        tools: live?.tools || [],
        error: fail?.msg || null,
      });
      connected.delete(name);
    }
    for (const live of connected.values()) {
      servers.push({ ...live, configured: false, status: 'connected' });
    }
    servers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return {
      servers,
      configuredCount: Object.keys(configured).length,
      connectedCount: servers.filter((row) => row.connected).length,
      failedCount: servers.filter((row) => row.status === 'failed').length,
    };
  }

  function skillsStatus() {
    const skills = typeof contextMod.collectSkillsCached === 'function'
      ? contextMod.collectSkillsCached(currentCwd)
      : [];
    const norm = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const cwdNorm = norm(currentCwd);
    const sourceForSkill = (filePath) => {
      const path = norm(filePath);
      if (cwdNorm && path.startsWith(`${cwdNorm}/.mixdog/skills/`)) return 'project';
      return 'skill';
    };
    return {
      cwd: currentCwd,
      count: skills.length,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description || '',
        filePath: skill.filePath || null,
        source: sourceForSkill(skill.filePath),
      })),
    };
  }

  function applyResolvedCwd(nextCwd, { markRefresh = true } = {}) {
    const resolved = resolve(nextCwd);
    const stat = statSync(resolved);
    if (!stat.isDirectory()) throw new Error(`cwd: not a directory: ${resolved}`);
    const changed = resolve(currentCwd) !== resolved;
    currentCwd = resolved;
    ensureProjectMixdogMd({ cwd: currentCwd });
    process.env.MIXDOG_SESSION_CWD = currentCwd;
    writeLastSessionCwd(currentCwd);
    if (session) session.cwd = currentCwd;
    if (changed && markRefresh && session?.id) sessionNeedsCwdRefresh = true;
    return currentCwd;
  }

  async function refreshSessionForCwdIfNeeded(reason = 'cwd-change') {
    if (!session?.id || !sessionNeedsCwdRefresh) return session;
    const previousId = session.id;
    statusRoutes?.clearGatewaySessionRoute?.(previousId);
    mgr.closeSession(previousId, reason);
    session = null;
    sessionNeedsCwdRefresh = false;
    return await createCurrentSession();
  }

  function buildWorkspaceContext() {
    try {
      return formatWorkspaceSessionContext(workspaceRouter.snapshot(currentCwd));
    } catch (error) {
      return [
        '# Workspace',
        `current cwd: ${currentCwd}`,
        `project candidates: unavailable (${error?.message || String(error)})`,
      ].join('\n');
    }
  }

  function skillContent(name) {
    const content = typeof contextMod.loadSkillContent === 'function'
      ? contextMod.loadSkillContent(name, currentCwd)
      : null;
    if (!content) throw new Error(`skill not found: ${name}`);
    return { name, content };
  }

  function addProjectSkill(input = {}) {
    const name = clean(input.name).replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('skill name is required');
    const dir = join(currentCwd, '.mixdog', 'skills', name);
    const filePath = join(dir, 'SKILL.md');
    if (existsSync(filePath)) throw new Error(`skill already exists: ${name}`);
    const description = clean(input.description) || 'Project skill.';
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      '',
      '# Instructions',
      '',
      'Describe when and how to use this skill.',
      '',
    ].join('\n'), 'utf8');
    return { name, filePath };
  }

  function pluginsStatus() {
    const dataDir = cfgMod.getPluginData?.();
    const configuredMcp = config?.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers
      : {};
    const plugins = [];
    const addRegisteredPlugin = (entry) => {
      const root = clean(entry.root);
      if (!root || !existsSync(root)) return;
      const manifest = pluginManifest(root);
      const name = clean(manifest.name) || clean(manifest.id) || clean(entry.name) || root.split(/[\\/]/).pop() || root;
      const plugin = {
        id: clean(entry.id) || name,
        name,
        title: clean(manifest.title) || clean(manifest.displayName) || clean(entry.title) || name,
        version: clean(manifest.version) || clean(entry.version) || null,
        description: clean(manifest.description) || clean(entry.description),
        marketplace: null,
        source: clean(entry.sourceType) === 'local' ? 'local' : 'registry',
        sourceUrl: clean(entry.source),
        sourceType: clean(entry.sourceType) || 'git',
        managed: entry.managed !== false,
        root,
        installedAt: entry.installedAt || null,
        updatedAt: entry.updatedAt || null,
        skillCount: countSkillFiles(root),
        mcpScript: mcpScriptForPlugin(root),
      };
      plugin.mcpServerName = pluginMcpServerName(plugin);
      plugin.mcpEnabled = Object.prototype.hasOwnProperty.call(configuredMcp, plugin.mcpServerName);
      plugins.push(plugin);
    };

    for (const entry of listRegisteredPlugins({ dataDir })) addRegisteredPlugin(entry);

    plugins.sort((a, b) => {
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      return a.name.localeCompare(b.name);
    });
    const admin = pluginAdminStatus({ dataDir });
    return {
      count: plugins.length,
      plugins,
      roots: {
        registry: admin.registryPath,
        installed: admin.installRoot,
      },
    };
  }

  async function connectConfiguredMcp({ reset = false } = {}) {
    if (reset) await mcpClient.disconnectAll?.();
    mcpFailures = [];
    const servers = config?.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers
      : {};
    if (Object.keys(servers).length === 0) return mcpStatus();
    try {
      await mcpClient.connectMcpServers(servers);
    } catch (error) {
      mcpFailures = Array.isArray(error?.failures)
        ? error.failures
        : [{ name: 'mcp', msg: error?.message || String(error) }];
    }
    return mcpStatus();
  }

  function normalizeMcpServerInput(input = {}) {
    const name = clean(input.name).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('MCP server name is required');
    const url = clean(input.url);
    if (url) {
      if (!/^https?:\/\//i.test(url)) throw new Error('MCP URL must start with http:// or https://');
      return { name, config: { transport: 'http', url } };
    }
    const command = clean(input.command);
    if (!command) throw new Error('MCP server command or URL is required');
    const args = Array.isArray(input.args)
      ? input.args.map((v) => String(v)).filter(Boolean)
      : clean(input.args).split(/\s+/).filter(Boolean);
    const requestedCwd = clean(input.cwd);
    const cwdForServer = requestedCwd ? resolve(currentCwd, requestedCwd) : currentCwd;
    const root = resolve(currentCwd);
    const resolvedCwd = resolve(cwdForServer);
    if (resolvedCwd !== root && !resolvedCwd.startsWith(`${root}\\`) && !resolvedCwd.startsWith(`${root}/`)) {
      throw new Error('MCP server cwd must stay under the current project');
    }
    return { name, config: { command, args, cwd: resolvedCwd } };
  }

  const persistedBridgeMode = (() => {
    try { return (sharedCfgMod.readSection('agent') || {}).bridgeMode; } catch { return undefined; }
  })();
  const bridgeStartedAt = performance.now();
  const bridge = createStandaloneBridge({
    cfgMod,
    reg,
    mgr,
    dataDir: cfgMod.getPluginData(),
    cwd,
    defaultMode: persistedBridgeMode ?? 'async',
  });
  bootProfile('bridge:ready', { ms: (performance.now() - bridgeStartedAt).toFixed(1) });
  const bridgeStatusState = () => {
    try {
      const status = bridge.getStatus?.({ clientHostPid: session?.clientHostPid || process.pid }) || {};
      return {
        bridgeMode: bridge.getDefaultMode?.() || status.bridgeMode || 'async',
        bridgeWorkers: Array.isArray(status.workers) ? status.workers : [],
        bridgeJobs: Array.isArray(status.jobs) ? status.jobs : [],
        bridgeScope: status.scope || null,
      };
    } catch {
      return { bridgeMode: bridge.getDefaultMode?.() || 'async', bridgeWorkers: [], bridgeJobs: [], bridgeScope: null };
    }
  };
  const channelsStartedAt = performance.now();
  const channels = createStandaloneChannelWorker({
    entry: join(STANDALONE_ROOT, CHANNEL_WORKER_ENTRY.replace(/^\.\//, '')),
    rootDir: STANDALONE_ROOT,
    dataDir: cfgMod.getPluginData(),
    cwd,
  });
  bootProfile('channels:worker-ready', { ms: (performance.now() - channelsStartedAt).toFixed(1) });
  const toolsStartedAt = performance.now();
  const standaloneTools = [
    TOOL_SEARCH_TOOL,
    CWD_TOOL,
    EXPLORE_TOOL,
    ...(searchToolDefs?.TOOL_DEFS || []).filter((tool) => tool?.name === 'search' || tool?.name === 'web_fetch'),
    ...(memoryToolDefs?.TOOL_DEFS || []).filter((tool) => tool?.name === 'recall' || tool?.name === 'memory'),
    ...(channelToolDefs?.TOOL_DEFS || []).filter((tool) => channels.isChannelTool(tool?.name)),
    ...(codeGraphToolDefs?.CODE_GRAPH_TOOL_DEFS || []).filter((tool) => tool?.name === 'code_graph'),
    ...bridge.tools,
    PROVIDER_STATUS_TOOL,
    CHANNEL_STATUS_TOOL,
  ].map(applyStandaloneToolDefaults);
  bootProfile('tools:ready', { ms: (performance.now() - toolsStartedAt).toFixed(1), count: standaloneTools.length });

  function invalidatePreSessionToolSurface() {
    preSessionToolSurface = null;
  }

  function invalidateContextStatusCache() {
    contextStatusCacheKey = null;
    contextStatusCacheValue = null;
  }

  function buildPreSessionToolSurface() {
    const previewTools = typeof mgr.previewSessionTools === 'function'
      ? mgr.previewSessionTools(toolSpecForMode(mode), [])
      : [];
    const tools = filterDisallowedTools(previewTools, LEAD_DISALLOWED_TOOLS);
    const surface = { tools: Array.isArray(tools) ? tools.slice() : [] };
    applyDeferredToolSurface(surface, mode, standaloneTools);
    return surface;
  }

  function activeToolSurface() {
    if (session) return session;
    preSessionToolSurface ??= buildPreSessionToolSurface();
    return preSessionToolSurface;
  }

  function applyPreSessionToolSelection() {
    if (!session || !preSessionToolSurface) return;
    const selected = Array.isArray(preSessionToolSurface.deferredSelectedTools)
      ? preSessionToolSurface.deferredSelectedTools
      : [];
    if (selected.length) selectDeferredTools(session, selected, mode);
  }
  internalTools.setInternalToolsProvider({
    tools: standaloneTools,
    executor: async (name, args, callerCtx = {}) => {
      const callerCwd = callerCtx?.callerCwd || currentCwd;
      if (name === 'search' || name === 'web_fetch') {
        const callerSessionId = callerCtx?.callerSessionId || session?.id || null;
        const searchMod = await getSearchModule();
        if (!searchMod?.handleToolCall) throw new Error('search runtime is not available');
        return await searchMod.handleToolCall(name, args || {}, {
          callerCwd,
          callerSessionId,
          routingSessionId: callerSessionId,
          clientHostPid: callerCtx?.clientHostPid || session?.clientHostPid || process.pid,
          notifyFn: notifyFnForSession(callerSessionId),
          agentSearch: name === 'search'
            ? async (searchArgs) => {
              const query = Array.isArray(searchArgs.keywords)
                ? searchArgs.keywords.join('\n')
                : String(searchArgs.keywords || searchArgs.query || '');
              const prompt = searchArgs.prompt || [
                'Perform a concise web research task for Mixdog search.',
                '',
                `Query: ${query}`,
                searchArgs.site ? `Site/domain restriction: ${searchArgs.site}` : null,
                searchArgs.type ? `Search type: ${searchArgs.type}` : null,
                searchArgs.locale ? `Locale: ${typeof searchArgs.locale === 'string' ? searchArgs.locale : JSON.stringify(searchArgs.locale)}` : null,
                `Max results: ${Math.max(1, Math.min(20, Number(searchArgs.maxResults) || 10))}`,
                '',
                'Return a short answer first, then cite useful results as title + URL + one-line snippet.',
                'Do not edit files.',
              ].filter(Boolean).join('\n');
              const rendered = await bridge.execute({
                type: 'spawn',
                agent: 'web-researcher',
                tag: `search_${Date.now().toString(36)}`,
                prompt,
                cwd: callerCwd,
                wait: true,
                firstResponseTimeoutMs: Number.isFinite(Number(searchArgs.firstResponseTimeoutMs)) ? Number(searchArgs.firstResponseTimeoutMs) : 120_000,
                idleTimeoutMs: Number.isFinite(Number(searchArgs.idleTimeoutMs)) ? Number(searchArgs.idleTimeoutMs) : 30 * 60_000,
              }, { invocationSource: 'user-command', callerCwd });
              return String(rendered || '').replace(/^bridge result[^\n]*\n/i, '').trim();
            }
            : undefined,
        });
      }
      if (name === 'recall' || name === 'memory' || name === 'search_memories') {
        const memoryMod = await getMemoryModule();
        if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
        return await memoryMod.handleToolCall(name, args || {});
      }
      if (name === 'code_graph') {
        const codeGraphMod = await getCodeGraphModule();
        if (!codeGraphMod?.executeCodeGraphTool) throw new Error('code_graph runtime is not available');
        return await codeGraphMod.executeCodeGraphTool(name, args || {}, args?.cwd || callerCwd);
      }
      if (name === 'tool_search') return renderToolSearch(args, session, mode);
      if (name === 'explore') {
        const callerSessionId = callerCtx?.callerSessionId || session?.id || null;
        return await runExplore(args || {}, {
          callerCwd: args?.cwd ? resolveCwdPath(currentCwd, args.cwd) : callerCwd,
          callerSessionId,
          routingSessionId: callerSessionId,
          clientHostPid: callerCtx?.clientHostPid || session?.clientHostPid || process.pid,
          notifyFn: notifyFnForSession(callerSessionId),
        });
      }
      if (name === 'cwd') {
        const action = clean(args?.action || (args?.path ? 'set' : 'get')).toLowerCase();
        if (action === 'set') {
          applyResolvedCwd(resolveCwdPath(currentCwd, args?.path));
        } else if (action !== 'get') {
          throw new Error(`cwd: unknown action "${action}"`);
        }
        return JSON.stringify({ cwd: currentCwd, sessionId: session?.id || null }, null, 2);
      }
      if (name === 'bridge') {
        const callerSessionId = callerCtx?.callerSessionId || session?.id || null;
        return await bridge.execute(args, {
          callerCwd,
          invocationSource: 'model-tool',
          callerSessionId,
          clientHostPid: callerCtx?.clientHostPid || session?.clientHostPid || process.pid,
          signal: callerCtx?.signal,
          notifyFn: notifyFnForSession(callerSessionId),
        });
      }
      if (name === 'provider_status') return renderProviderStatus(cfgMod.loadConfig());
      if (name === 'channel_status') return renderChannelStatus();
      if (channels.isChannelTool(name)) return await channels.execute(name, args || {});
      throw new Error(`unknown standalone internal tool: ${name}`);
    },
  });
  internalTools.markBootReady?.();
  void connectConfiguredMcp()
    .then((status) => bootProfile('mcp:ready', {
      connected: Number(status?.connectedCount || 0),
      failed: Number(status?.failedCount || 0),
    }))
    .catch((error) => bootProfile('mcp:failed', { error: error?.message || String(error) }));

  function reloadChannelsSoon() {
    channels.execute('reload_config', {}).catch(() => {});
  }

  function invalidateProviderCaches() {
    providerModelsCache = { models: null, at: 0 };
    providerModelsPromise = null;
    providerSetupCache = { setup: null, at: 0 };
    providerSetupPromise = null;
    providerInitPromise = null;
    modelMetaByRoute.clear();
  }

  function ensureFullConfig() {
    if (configHasSecrets) return config;
    config = cfgMod.loadConfig();
    configHasSecrets = true;
    return config;
  }

  async function ensureProvidersReady(providerConfig = config.providers || {}) {
    if (providerInitPromise) return await providerInitPromise;
    providerInitPromise = reg.initProviders(providerConfig)
      .finally(() => {
        providerInitPromise = null;
      });
    return await providerInitPromise;
  }

  async function cachedProviderSetup({ force = false } = {}) {
    const now = Date.now();
    if (!force && providerSetupCache.setup && now - providerSetupCache.at < PROVIDER_SETUP_CACHE_TTL_MS) {
      return providerSetupCache.setup;
    }
    if (!force && providerSetupPromise) return await providerSetupPromise;
    providerSetupPromise = providerSetup(cfgMod.loadConfig())
      .then((setup) => {
        providerSetupCache = { setup, at: Date.now() };
        return setup;
      })
      .finally(() => {
        providerSetupPromise = null;
      });
    return await providerSetupPromise;
  }

  function modelMetaKey(providerId, modelId) {
    return `${clean(providerId)}\n${clean(modelId)}`;
  }

  async function lookupModelMeta(providerId, modelId) {
    const key = modelMetaKey(providerId, modelId);
    if (modelMetaByRoute.has(key)) return modelMetaByRoute.get(key);
    const providerImpl = reg.getProvider(providerId);
    if (!providerImpl || typeof providerImpl.listModels !== 'function') {
      const fallback = { id: modelId, provider: providerId };
      modelMetaByRoute.set(key, fallback);
      return fallback;
    }
    if (typeof providerImpl.getCachedModelInfo === 'function') {
      const cached = providerImpl.getCachedModelInfo(modelId);
      if (cached) {
        const meta = { ...cached, id: cached.id || modelId, provider: providerId };
        modelMetaByRoute.set(key, meta);
        return meta;
      }
    }
    try {
      const models = await providerImpl.listModels();
      const found = Array.isArray(models) ? models.find((m) => m?.id === modelId) : null;
      const meta = found || { id: modelId, provider: providerId };
      modelMetaByRoute.set(key, meta);
      return meta;
    } catch {
      const fallback = { id: modelId, provider: providerId };
      modelMetaByRoute.set(key, fallback);
      return fallback;
    }
  }

function parsedProviderModelVersion(id) {
    const text = clean(id).toLowerCase();
    const claude = text.match(/^claude-[a-z]+-(\d+)(?:[-.](\d+))?/);
    if (claude) return [Number(claude[1]) || 0, Number(claude[2]) || 0];
    const compact = text.match(/(?:^|[-_])(?:o|gpt|grok|qwen|llama|mistral|gemma|phi|glm)(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/);
    if (compact) return compact.slice(1).filter((v) => v != null).map((v) => Number(v) || 0);
    const generic = text.match(/(?:^|[-_v])(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/);
    return generic ? generic.slice(1).filter((v) => v != null).map((v) => Number(v) || 0) : [];
  }

  function compareProviderModelVersion(a, b) {
    const va = parsedProviderModelVersion(a.id || a.display || a.name);
    const vb = parsedProviderModelVersion(b.id || b.display || b.name);
    if (va.length === 0 && vb.length === 0) return 0;
    if (va.length === 0) return 1;
    if (vb.length === 0) return -1;
    for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
      const delta = (vb[i] || 0) - (va[i] || 0);
      if (delta) return delta;
    }
    return 0;
  }

  function providerModelReleaseTime(model) {
    if (model?.releaseDate) {
      const t = Date.parse(model.releaseDate);
      if (Number.isFinite(t)) return t;
    }
    const created = Number(model?.created);
    if (Number.isFinite(created) && created > 0) {
      return created < 1_000_000_000_000 ? created * 1000 : created;
    }
    const dated = clean(model?.id).match(/(?:^|-)(\d{4})(\d{2})(\d{2})(?:$|-)/);
    return dated ? (Date.parse(`${dated[1]}-${dated[2]}-${dated[3]}`) || 0) : 0;
  }

  function isClaudeProviderModel(model) {
    return clean(model?.provider).toLowerCase().includes('anthropic')
      && /^claude-[a-z]+-/.test(clean(model?.id).toLowerCase());
  }

  function compareProviderModelRecency(a, b) {
    if (isClaudeProviderModel(a) && isClaudeProviderModel(b)) {
      if (a.latest !== b.latest) return a.latest ? -1 : 1;
      const versionDelta = compareProviderModelVersion(a, b);
      if (versionDelta) return versionDelta;
      const ta = providerModelReleaseTime(a);
      const tb = providerModelReleaseTime(b);
      if (ta !== tb) return tb - ta;
      return clean(a.display || a.id).localeCompare(clean(b.display || b.id));
    }
    const ta = providerModelReleaseTime(a);
    const tb = providerModelReleaseTime(b);
    if (ta !== tb) return tb - ta;
    if (a.latest !== b.latest) return a.latest ? -1 : 1;
    const versionDelta = compareProviderModelVersion(a, b);
    if (versionDelta) return versionDelta;
    return clean(a.display || a.id).localeCompare(clean(b.display || b.id));
  }

  function sortProviderModels(models) {
    return (models || []).sort((a, b) => {
      const ar = a.provider === route.provider ? 0 : 1;
      const br = b.provider === route.provider ? 0 : 1;
      if (ar !== br) return ar - br;
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return compareProviderModelRecency(a, b);
    });
  }

  function isSelectableLlmModel(model) {
    const id = clean(model?.id).toLowerCase();
    const display = clean(model?.display || model?.name).toLowerCase();
    const mode = clean(model?.mode).toLowerCase();
    const text = `${id} ${display}`;
    if (!id) return false;
    if (mode && !['chat', 'completion', 'responses', 'messages'].includes(mode)) return false;
    if (/(^|[-_\s])(image|images|video|videos|audio|tts|stt|speech|embedding|embeddings|rerank|moderation|imagine)([-_\s]|$)/i.test(text)) return false;
    if (/(^|[-_\s])(dall[-_\s]?e|sora|imagen)([-_\s]|$)/i.test(text)) return false;
    return true;
  }

  function providerModelCacheRow(name, m) {
    return {
      id: m.id,
      provider: name,
      display: m.display || m.name || m.id,
      created: typeof m.created === 'number' ? m.created : null,
      releaseDate: m.releaseDate || null,
      contextWindow: m.contextWindow,
      outputTokens: m.outputTokens || null,
      family: m.family || null,
      tier: m.tier || null,
      latest: m.latest === true,
      description: m.description || '',
      supportsVision: m.supportsVision === true,
      supportsFunctionCalling: m.supportsFunctionCalling === true,
      supportsPromptCaching: m.supportsPromptCaching === true,
      supportsReasoning: m.supportsReasoning === true,
      reasoningLevels: Array.isArray(m.reasoningLevels) ? m.reasoningLevels : [],
      reasoningOptions: Array.isArray(m.reasoningOptions) ? m.reasoningOptions : [],
      reasoningContentField: m.reasoningContentField || null,
      mode: m.mode || null,
    };
  }

  function hydrateProviderModelRow(row) {
    return {
      ...row,
      effortOptions: effortItemsFor(row.provider, row, null),
      fastCapable: fastCapableFor(row.provider, row),
      fastPreferred: fastPreferenceFor(config, row.provider, row.id),
      savedEffort: modelSettingsFor(config, row.provider, row.id).effort || null,
      savedFast: modelSettingsFor(config, row.provider, row.id).fast === true,
    };
  }

  function providerModelsFromCacheRows(rows) {
    return sortProviderModels((rows || []).map(hydrateProviderModelRow));
  }

  async function loadProviderModelsFresh() {
    ensureFullConfig();
    await ensureProvidersReady(config.providers || {});
    const allProviders = reg.getAllProviders();
    const results = [];
    const seen = new Set();
    for (const [name, provider] of allProviders) {
      if (typeof provider?.listModels !== 'function') continue;
      try {
        const models = await provider.listModels();
        if (Array.isArray(models)) {
          for (const m of models) {
            if (!m?.id) continue;
            if (!isSelectableLlmModel(m)) continue;
            const key = `${name}:${m.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const row = providerModelCacheRow(name, m);
            results.push(row);
            modelMetaByRoute.set(modelMetaKey(name, m.id), row);
          }
        }
      } catch {
        // Ignore per-provider catalog failures so one bad credential or
        // transient /models error does not hide other authenticated models.
      }
    }
    return results;
  }

  async function collectProviderModels({ force = false } = {}) {
    if (!force && Array.isArray(providerModelsCache.models)) {
      return providerModelsFromCacheRows(providerModelsCache.models);
    }
    if (!providerModelsPromise) {
      providerModelsPromise = loadProviderModelsFresh()
        .then((models) => {
          providerModelsCache = { models, at: Date.now() };
          return models;
        })
        .finally(() => {
          providerModelsPromise = null;
        });
    }
    return providerModelsFromCacheRows(await providerModelsPromise);
  }

  function warmProviderModelCache() {
    if (Array.isArray(providerModelsCache.models) || providerModelsPromise) return providerModelsPromise;
    providerModelsPromise = loadProviderModelsFresh()
      .then((models) => {
        providerModelsCache = { models, at: Date.now() };
        bootProfile('provider-models:warm-ready', { count: models.length });
        return models;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        bootProfile('provider-models:warm-failed', { error: msg });
        return [];
      })
      .finally(() => {
        providerModelsPromise = null;
      });
    return providerModelsPromise;
  }

  async function resolveMissingRouteModelForFirstTurn() {
    if (routeHasModel()) return route;
    const models = await collectProviderModels();
    const picked = models[0] || null;
    if (!picked) {
      throw new Error('No provider models available. Run /providers to authenticate, then /model to choose a model.');
    }
    route = {
      ...route,
      provider: picked.provider,
      model: picked.id,
      preset: null,
    };
    return route;
  }

  async function refreshRouteEffort(modelMetaOverride = null) {
    await ensureProvidersReady(ensureProviderEnabled(config, route.provider));
    const modelMeta = modelMetaOverride || await lookupModelMeta(route.provider, route.model);
    const requested = hasOwn(route, 'effort') ? route.effort : (route.preset?.effort || null);
    const effectiveEffort = coerceEffortFor(route.provider, modelMeta, requested);
    const fastCapable = fastCapableFor(route.provider, modelMeta);
    route = {
      ...route,
      fast: fastCapable ? route.fast === true : false,
      fastCapable,
      effectiveEffort,
      effortOptions: effortItemsFor(route.provider, modelMeta, effectiveEffort),
    };
    return route;
  }

  function routeHasModel() {
    return !!clean(route?.model);
  }

  function requireModelRoute() {
    if (routeHasModel()) return;
    throw new Error('No model configured. Run /providers to authenticate, then /model to choose a model.');
  }

  async function recreateCurrentSessionIfReady() {
    if (!routeHasModel()) {
      session = null;
      return null;
    }
    return await createCurrentSession();
  }

  async function createCurrentSession() {
    const startedAt = performance.now();
    bootProfile('session:create:start', { mode });
    ensureFullConfig();
    await resolveMissingRouteModelForFirstTurn();
    requireModelRoute();
    await refreshRouteEffort();
    const providerImpl = reg.getProvider(route.provider);
    if (!providerImpl) {
      throw new Error(`Provider "${route.provider}" is not configured.`);
    }
    const coreMemoryContext = await loadCoreMemoryContext();
    const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
    const workflowContext = workflowContextBlock(config, dataDir);
    const workspaceContext = buildWorkspaceContext();
    const sessionOpts = {
      provider: route.provider,
      model: route.model,
      preset: route.preset || undefined,
      tools: toolSpecForMode(mode),
      owner: 'cli',
      role: 'lead',
      lane: 'cli',
      sourceType: 'lead',
      sourceName: 'main',
      clientHostPid: process.pid,
      disallowedTools: LEAD_DISALLOWED_TOOLS,
      cwd: currentCwd,
      coreMemoryContext,
      workflowContext,
      workspaceContext,
      fast: route.fast === true,
    };
    if (hasOwn(route, 'effort') || route.effectiveEffort) {
      sessionOpts.effort = route.effectiveEffort || null;
    }
    session = mgr.createSession(sessionOpts);
    sessionNeedsCwdRefresh = false;
    Object.defineProperty(session, 'beforeToolHook', {
      value: (input) => hooks.beforeTool(input),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    applyDeferredToolSurface(session, mode, standaloneTools);
    applyPreSessionToolSelection();
    statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route));
    hooks.emit('session:create', { sessionId: session.id, provider: route.provider, model: route.model, toolMode: mode, cwd: currentCwd });
    bootProfile('session:create:ready', {
      ms: (performance.now() - startedAt).toFixed(1),
      tools: Array.isArray(session.tools) ? session.tools.length : 0,
      catalog: Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog.length : 0,
    });
    return session;
  }

  function withTeardownDeadline(promise, ms, fallback = false) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  setImmediate(() => {
    if (closeRequested) return;
    const providersStartedAt = performance.now();
    try {
      config = cfgMod.loadConfig();
      configHasSecrets = true;
    } catch (error) {
      bootProfile('config:full-failed', { error: error?.message || String(error) });
    }
    void ensureProvidersReady(config.providers || {})
      .then(() => {
        bootProfile('providers:init:ready', { ms: (performance.now() - providersStartedAt).toFixed(1) });
        warmProviderModelCache();
        return cachedProviderSetup();
      })
      .then((setup) => bootProfile('provider-setup:warm-ready', {
        api: Array.isArray(setup?.api) ? setup.api.length : 0,
        oauth: Array.isArray(setup?.oauth) ? setup.oauth.length : 0,
        local: Array.isArray(setup?.local) ? setup.local.length : 0,
      }))
      .catch((error) => bootProfile('providers:warm-failed', { error: error?.message || String(error) }));
  });

  bootProfile('session-runtime:ready', { lazySession: true });
  bootProfile('channels:start-scheduled', { delayMs: 500 });
  channelStartTimer = setTimeout(() => {
    channelStartTimer = null;
    if (closeRequested) return;
    const startedAt = performance.now();
    bootProfile('channels:start:begin');
    channels.start()
      .then(() => bootProfile('channels:start:ready', { ms: (performance.now() - startedAt).toFixed(1) }))
      .catch((error) => bootProfile('channels:start:failed', {
        ms: (performance.now() - startedAt).toFixed(1),
        error: error?.message || String(error),
      }));
  }, 500);
  channelStartTimer.unref?.();

  function contextStatusCacheKeyFor({ messages, tools, bridgeMode }) {
    const compaction = session?.compaction || {};
    const lastMessage = messages[messages.length - 1] || null;
    return {
      session,
      sessionId: session?.id || null,
      provider: route.provider,
      model: route.model,
      cwd: currentCwd,
      mode,
      bridgeMode,
      messages,
      messageCount: messages.length,
      lastMessage,
      lastMessageRole: lastMessage?.role || null,
      lastMessageContent: lastMessage?.content || null,
      tools,
      toolCount: tools.length,
      contextWindow: session?.contextWindow || null,
      rawContextWindow: session?.rawContextWindow || null,
      effectiveContextWindowPercent: session?.effectiveContextWindowPercent || null,
      autoCompactTokenLimit: Number(session?.autoCompactTokenLimit || 0),
      lastContextTokens: Number(session?.lastContextTokens || 0),
      lastContextTokensUpdatedAt: Number(session?.lastContextTokensUpdatedAt || 0),
      lastContextTokensStaleAfterCompact: session?.lastContextTokensStaleAfterCompact === true,
      lastInputTokens: Number(session?.lastInputTokens || 0),
      lastOutputTokens: Number(session?.lastOutputTokens || 0),
      lastCachedReadTokens: Number(session?.lastCachedReadTokens || 0),
      lastCacheWriteTokens: Number(session?.lastCacheWriteTokens || 0),
      totalInputTokens: Number(session?.totalInputTokens || 0),
      totalOutputTokens: Number(session?.totalOutputTokens || 0),
      totalCachedReadTokens: Number(session?.totalCachedReadTokens || 0),
      totalCacheWriteTokens: Number(session?.totalCacheWriteTokens || 0),
      compactBoundaryTokens: Number(session?.compactBoundaryTokens || 0),
      compactionBoundaryTokens: Number(compaction.boundaryTokens || 0),
      compactionTriggerTokens: Number(compaction.triggerTokens || 0),
      compactionLastChangedAt: Number(compaction.lastChangedAt || 0),
      compactionLastCompactAt: Number(compaction.lastCompactAt || 0),
    };
  }

  function sameContextStatusCacheKey(a, b) {
    if (!a || !b) return false;
    for (const key of Object.keys(a)) {
      if (!Object.is(a[key], b[key])) return false;
    }
    return true;
  }

  return {
    get id() {
      return session?.id || null;
    },
    get provider() {
      return route.provider;
    },
    get model() {
      return route.model;
    },
    get effort() {
      return route.effectiveEffort || route.effort || route.preset?.effort || null;
    },
    get fast() {
      return route.fast === true;
    },
    get fastCapable() {
      return route.fastCapable === true;
    },
    get effortOptions() {
      return route.effortOptions || [];
    },
    get contextWindow() {
      return session?.contextWindow || null;
    },
    get rawContextWindow() {
      return session?.rawContextWindow || session?.contextWindow || null;
    },
    get effectiveContextWindowPercent() {
      return session?.effectiveContextWindowPercent || null;
    },
    get toolMode() {
      return mode;
    },
    get bridgeMode() {
      return bridge.getDefaultMode();
    },
    get autoClear() {
      return normalizeAutoClearConfig(config.autoClear);
    },
    get workflow() {
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const pack = loadWorkflowPack(dataDir, activeWorkflowId(config));
      return pack ? { id: pack.id, name: pack.name, description: pack.description, source: pack.source } : { id: DEFAULT_WORKFLOW_ID, name: 'Default' };
    },
    get cwd() {
      return currentCwd;
    },
    get session() {
      return session;
    },
    contextStatus() {
      const messages = Array.isArray(session?.messages) ? session.messages : [];
      const tools = Array.isArray(session?.tools) ? session.tools : [];
      const bridgeMode = bridge.getDefaultMode();
      const cacheKey = contextStatusCacheKeyFor({ messages, tools, bridgeMode });
      if (contextStatusCacheValue && sameContextStatusCacheKey(cacheKey, contextStatusCacheKey)) {
        return contextStatusCacheValue;
      }

      const messageSummary = summarizeContextMessages(messages);
      const toolSchemaTokens = estimateToolSchemaTokens(tools);
      const requestReserveTokens = estimateRequestReserveTokens(tools);
      const requestOverheadTokens = Math.max(0, requestReserveTokens - toolSchemaTokens);
      const rawWindow = Number(session?.rawContextWindow || session?.contextWindow || 0);
      const effectiveWindow = Number(session?.contextWindow || rawWindow || 0);
      const lastContextTokens = Number(session?.lastContextTokens || 0);
      const estimatedContextTokens = messageSummary.estimatedTokens + requestReserveTokens;
      const compactAt = Number(session?.compaction?.lastChangedAt || session?.compaction?.lastCompactAt || 0);
      const usageAt = Number(session?.lastContextTokensUpdatedAt || 0);
      const lastUsageStale = !!lastContextTokens && (
        session?.lastContextTokensStaleAfterCompact === true
        || (compactAt > 0 && usageAt > 0 && usageAt <= compactAt)
        || (compactAt > 0 && usageAt <= 0)
      );
      const compactBoundaryTokens = Number(session?.compactBoundaryTokens || session?.compaction?.boundaryTokens || 0);
      const displayWindow = compactBoundaryTokens || effectiveWindow;
      const usedTokens = lastUsageStale
        ? estimatedContextTokens
        : Math.max(estimatedContextTokens, lastContextTokens || 0);
      const freeTokens = displayWindow ? Math.max(0, displayWindow - usedTokens) : 0;
      const autoCompactTokenLimit = Number(session?.autoCompactTokenLimit || 0);
      const defaultCompactTriggerTokens = compactBoundaryTokens ? Math.max(1, Math.floor(compactBoundaryTokens * 0.9)) : 0;
      const compactTriggerTokens = autoCompactTokenLimit && compactBoundaryTokens && autoCompactTokenLimit < compactBoundaryTokens
        ? autoCompactTokenLimit
        : Number(session?.compaction?.triggerTokens || defaultCompactTriggerTokens || 0);
      const compactBufferTokens = Number(session?.compaction?.bufferTokens || (compactBoundaryTokens && compactTriggerTokens ? Math.max(0, compactBoundaryTokens - compactTriggerTokens) : 0));
      const value = {
        sessionId: session?.id || null,
        provider: route.provider,
        model: route.model,
        cwd: currentCwd,
        toolMode: mode,
        bridgeMode,
        contextWindow: displayWindow || effectiveWindow || null,
        effectiveContextWindow: effectiveWindow || null,
        rawContextWindow: rawWindow || null,
        effectiveContextWindowPercent: session?.effectiveContextWindowPercent || null,
        usedTokens,
        usedSource: lastContextTokens && !lastUsageStale && lastContextTokens >= estimatedContextTokens
          ? 'last_api_request'
          : 'estimated',
        currentEstimatedTokens: estimatedContextTokens,
        lastApiRequestTokens: lastContextTokens || 0,
        lastApiRequestStale: lastUsageStale,
        freeTokens,
        compaction: {
          ...(session?.compaction || {}),
          boundaryTokens: compactBoundaryTokens || null,
          triggerTokens: compactTriggerTokens || null,
          bufferTokens: compactBufferTokens || null,
          currentEstimatedTokens: estimatedContextTokens,
          lastApiRequestTokens: lastContextTokens || 0,
          lastApiRequestStale: lastUsageStale,
        },
        messages: messageSummary,
        request: {
          toolSchemaTokens,
          requestOverheadTokens,
          reserveTokens: requestReserveTokens,
        },
        usage: {
          lastInputTokens: Number(session?.lastInputTokens || 0),
          lastOutputTokens: Number(session?.lastOutputTokens || 0),
          lastCachedReadTokens: Number(session?.lastCachedReadTokens || 0),
          lastCacheWriteTokens: Number(session?.lastCacheWriteTokens || 0),
          lastContextTokens,
          totalInputTokens: Number(session?.totalInputTokens || 0),
          totalOutputTokens: Number(session?.totalOutputTokens || 0),
          totalCachedReadTokens: Number(session?.totalCachedReadTokens || 0),
          totalCacheWriteTokens: Number(session?.totalCacheWriteTokens || 0),
        },
      };
      contextStatusCacheKey = cacheKey;
      contextStatusCacheValue = value;
      return value;
    },
    listProviders() {
      return renderProviderStatus(cfgMod.loadConfig());
    },
    async getProviderSetup() {
      return await cachedProviderSetup();
    },
    async getUsageDashboard(options = {}) {
      const nextConfig = cfgMod.loadConfig();
      return await createUsageDashboard(nextConfig, {
        ...(options || {}),
        setup: await cachedProviderSetup(),
        getProvider: (providerId) => reg.getProvider(providerId),
        log: (message) => {
          if (process.env.MIXDOG_USAGE_TRACE) {
            try { process.stderr.write(`[usage] ${message}\n`); } catch {}
          }
        },
      });
    },
    getOnboardingStatus() {
      const nextConfig = cfgMod.loadConfig();
      return {
        completed: nextConfig?.onboarding?.completed === true,
        version: nextConfig?.onboarding?.version || 0,
        default: nextConfig?.default || null,
        workflowRoutes: summarizeWorkflowRoutes(nextConfig),
      };
    },
    getAutoClear() {
      return normalizeAutoClearConfig(config.autoClear);
    },
    setAutoClear(input = {}) {
      const current = normalizeAutoClearConfig(config.autoClear);
      const next = { ...current };
      if (hasOwn(input, 'enabled')) next.enabled = input.enabled !== false;
      if (hasOwn(input, 'idleMs')) {
        const idleMs = Number(input.idleMs);
        if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error('autoclear idleMs must be a positive number');
        next.idleMs = Math.max(60_000, Math.round(idleMs));
      }
      if (hasOwn(input, 'duration')) {
        const idleMs = parseDurationMs(input.duration);
        if (!idleMs) throw new Error('usage: /autoclear [on|off|status|<minutes|1h|90m>]');
        next.idleMs = idleMs;
        if (!hasOwn(input, 'enabled')) next.enabled = true;
      }
      const nextConfig = cfgMod.loadConfig();
      cfgMod.saveConfig({ ...nextConfig, autoClear: next });
      config = cfgMod.loadConfig();
      return { ...normalizeAutoClearConfig(config.autoClear), label: formatDurationMs(normalizeAutoClearConfig(config.autoClear).idleMs) };
    },
    async completeOnboarding(payload = {}) {
      const defaultRoute = normalizeWorkflowRoute(payload.defaultRoute, route);
      const workflowInput = payload.workflowRoutes && typeof payload.workflowRoutes === 'object'
        ? payload.workflowRoutes
        : {};
      const nextConfig = cfgMod.loadConfig();
      let presets = Array.isArray(nextConfig.presets) ? nextConfig.presets.slice() : [];
      const workflowRoutes = { ...(nextConfig.workflowRoutes || {}) };

      if (defaultRoute) {
        presets = upsertWorkflowPreset(presets, 'lead', defaultRoute);
        workflowRoutes.lead = defaultRoute;
        nextConfig.default = workflowPresetId('lead');
      }

      for (const slot of WORKFLOW_ROUTE_SLOTS) {
        const normalized = normalizeWorkflowRoute(workflowInput[slot]);
        if (!normalized) continue;
        workflowRoutes[slot] = normalized;
        presets = upsertWorkflowPreset(presets, slot, normalized);
      }

      nextConfig.presets = presets;
      nextConfig.workflowRoutes = workflowRoutes;
      nextConfig.maintenance = {
        ...(nextConfig.maintenance || {}),
        explore: workflowRoutes.explorer ? workflowPresetId('explorer') : (nextConfig.maintenance?.explore || 'haiku'),
        memory: workflowRoutes.memory ? workflowPresetId('memory') : (nextConfig.maintenance?.memory || 'haiku'),
      };
      nextConfig.onboarding = {
        ...(nextConfig.onboarding || {}),
        completed: true,
        version: ONBOARDING_VERSION,
        completedAt: new Date().toISOString(),
      };

      cfgMod.saveConfig(nextConfig);
      config = cfgMod.loadConfig();
      if (defaultRoute) {
        route = resolveRoute(config, { provider: defaultRoute.provider, model: defaultRoute.model, effort: defaultRoute.effort });
        if (session?.id) mgr.closeSession(session.id, 'cli-onboarding-complete');
        await recreateCurrentSessionIfReady();
      }
      return this.getOnboardingStatus();
    },
    getChannelSetup() {
      return channelSetup();
    },
    getChannelWorkerStatus() {
      return channels.status();
    },
    saveDiscordToken(token) {
      const result = saveDiscordToken(token);
      reloadChannelsSoon();
      return result;
    },
    forgetDiscordToken() {
      const result = forgetDiscordToken();
      reloadChannelsSoon();
      return result;
    },
    saveWebhookAuthtoken(token) {
      const result = saveWebhookAuthtoken(token);
      reloadChannelsSoon();
      return result;
    },
    forgetWebhookAuthtoken() {
      const result = forgetWebhookAuthtoken();
      reloadChannelsSoon();
      return result;
    },
    saveChannel(entry) {
      const result = saveChannel(entry);
      reloadChannelsSoon();
      return result;
    },
    deleteChannel(name) {
      const result = deleteChannel(name);
      reloadChannelsSoon();
      return result;
    },
    setWebhookConfig(patch) {
      const result = setWebhookConfig(patch);
      reloadChannelsSoon();
      return result;
    },
    saveSchedule(entry) {
      const result = saveSchedule(entry);
      reloadChannelsSoon();
      return result;
    },
    deleteSchedule(name) {
      const result = deleteSchedule(name);
      reloadChannelsSoon();
      return result;
    },
    setScheduleEnabled(name, enabled) {
      const result = setScheduleEnabled(name, enabled);
      reloadChannelsSoon();
      return result;
    },
    saveWebhook(entry) {
      const result = saveWebhook(entry);
      reloadChannelsSoon();
      return result;
    },
    deleteWebhook(name) {
      const result = deleteWebhook(name);
      reloadChannelsSoon();
      return result;
    },
    setWebhookEnabled(name, enabled) {
      const result = setWebhookEnabled(name, enabled);
      reloadChannelsSoon();
      return result;
    },
    async authenticateProvider(providerId, secret) {
      const result = String(secret || '').trim()
        ? saveProviderApiKey(cfgMod, providerId, secret)
        : await loginOAuthProvider(cfgMod, providerId);
      config = cfgMod.loadConfig();
      invalidateProviderCaches();
      warmProviderModelCache();
      return result;
    },
    async loginOAuthProvider(providerId) {
      const result = await loginOAuthProvider(cfgMod, providerId);
      config = cfgMod.loadConfig();
      invalidateProviderCaches();
      warmProviderModelCache();
      return result;
    },
    async beginOAuthProviderLogin(providerId) {
      const result = await beginOAuthProviderLogin(cfgMod, providerId);
      config = cfgMod.loadConfig();
      return {
        ...result,
        completeCode: async (code) => {
          const completed = await result.completeCode(code);
          config = cfgMod.loadConfig();
          invalidateProviderCaches();
          warmProviderModelCache();
          return completed;
        },
      };
    },
    saveProviderApiKey(providerId, secret) {
      const result = saveProviderApiKey(cfgMod, providerId, secret);
      config = cfgMod.loadConfig();
      invalidateProviderCaches();
      warmProviderModelCache();
      return result;
    },
    saveOpenAIUsageSessionKey(secret) {
      const result = saveOpenAIUsageSessionKey(cfgMod, secret);
      config = cfgMod.loadConfig();
      invalidateProviderCaches();
      return result;
    },
    saveOpenCodeGoUsageAuth(opts) {
      const result = saveOpenCodeGoUsageAuth(cfgMod, opts);
      config = cfgMod.loadConfig();
      invalidateProviderCaches();
      return result;
    },
    setLocalProvider(providerId, opts) {
      const result = setLocalProvider(cfgMod, providerId, opts);
      config = cfgMod.loadConfig();
      invalidateProviderCaches();
      warmProviderModelCache();
      return result;
    },
    forgetProviderAuth(providerId) {
      const result = forgetProviderAuth(providerId);
      config = cfgMod.loadConfig();
      invalidateProviderCaches();
      warmProviderModelCache();
      return result;
    },
    listPresets() {
      return cfgMod.listPresets(cfgMod.loadConfig());
    },
    async listProviderModels(options = {}) {
      return await collectProviderModels({ force: options.force === true || options.refresh === true });
    },
    listAgents() {
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      return FIXED_AGENT_SLOTS.map((agent) => ({
        ...agent,
        locked: true,
        route: agentRouteFromConfig(config, agent.id, dataDir),
        definition: loadAgentDefinition(dataDir, agent.id),
      }));
    },
    listWorkflows() {
      const currentConfig = cfgMod.loadConfig();
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const active = activeWorkflowId(currentConfig);
      return listWorkflowPacks(dataDir).map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        source: workflow.source,
        active: workflow.id === active,
        agents: workflow.agents,
      }));
    },
    async setWorkflow(workflowId) {
      const id = normalizeWorkflowId(workflowId, DEFAULT_WORKFLOW_ID);
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const pack = loadWorkflowPack(dataDir, id);
      if (!pack || pack.id !== id) throw new Error(`workflow "${workflowId}" not found`);
      const nextConfig = cfgMod.loadConfig();
      nextConfig.workflow = { ...(nextConfig.workflow || {}), active: id };
      cfgMod.saveConfig(nextConfig);
      config = cfgMod.loadConfig();
      if (session?.id) {
        mgr.closeSession(session.id, 'cli-workflow-switch');
        session = null;
      }
      await recreateCurrentSessionIfReady();
      return { id: pack.id, name: pack.name, description: pack.description, source: pack.source };
    },
    async setAgentRoute(agentId, next) {
      const id = normalizeAgentId(agentId);
      if (!id) throw new Error(`unknown agent "${agentId}"`);
      let selectedRoute = resolveRoute(config, { ...(next || {}) });
      await reg.initProviders(ensureProviderEnabled(config, selectedRoute.provider));
      const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
      const fastCapable = fastCapableFor(selectedRoute.provider, modelMeta);
      selectedRoute = { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false };
      config = saveModelSettings(cfgMod, selectedRoute, { fastCapable });

      const routeToSave = normalizeWorkflowRoute(selectedRoute);
      if (!routeToSave) throw new Error('agent route requires provider and model');
      const agent = FIXED_AGENT_SLOTS.find((item) => item.id === id);
      const nextConfig = cfgMod.loadConfig();
      nextConfig.agents = {
        ...(nextConfig.agents || {}),
        [id]: routeToSave,
      };
      nextConfig.presets = upsertWorkflowPreset(nextConfig.presets, agentPresetSlot(id), routeToSave);
      if (agent?.workflowSlot) {
        nextConfig.workflowRoutes = {
          ...(nextConfig.workflowRoutes || {}),
          [agent.workflowSlot]: routeToSave,
        };
        nextConfig.presets = upsertWorkflowPreset(nextConfig.presets, agent.workflowSlot, routeToSave);
        nextConfig.maintenance = {
          ...(nextConfig.maintenance || {}),
          ...(id === 'explore' ? { explore: workflowPresetId('explorer') } : {}),
          ...(id === 'maintainer' ? { memory: workflowPresetId('memory') } : {}),
        };
      }
      cfgMod.saveConfig(nextConfig);
      config = cfgMod.loadConfig();
      return routeToSave;
    },
    async ask(prompt, options = {}) {
      await refreshSessionForCwdIfNeeded('cwd-change');
      if (!session?.id) await createCurrentSession();
      const startedAt = Date.now();
      hooks.emit('turn:start', { sessionId: session.id, prompt, cwd: currentCwd });
      try {
        const turnContext = [options.context || ''].map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
        const result = await mgr.askSession(
          session.id,
          prompt,
          turnContext || null,
          async (iter, calls) => {
            for (const call of calls || []) {
              hooks.emit('tool:planned', {
                sessionId: session.id,
                name: call?.name || 'tool',
                callId: call?.id || null,
              });
            }
            if (typeof options.onToolCall === 'function') {
              return await options.onToolCall(iter, calls);
            }
            return undefined;
          },
          currentCwd,
          options.prefetch || null,
          {
            onTextDelta: options.onTextDelta,
            onReasoningDelta: options.onReasoningDelta,
            onUsageDelta: options.onUsageDelta,
            onToolResult: options.onToolResult,
            onStageChange: options.onStageChange,
            onStreamDelta: options.onStreamDelta,
            drainSteering: options.drainSteering,
            onSteerMessage: options.onSteerMessage,
          },
        );
        session = mgr.getSession(session.id) || session;
        hooks.emit('turn:end', { sessionId: session.id, elapsedMs: Date.now() - startedAt });
        return { result, session };
      } catch (error) {
        hooks.emit('turn:error', { sessionId: session?.id || null, elapsedMs: Date.now() - startedAt, error: error?.message || String(error) });
        throw error;
      }
    },
    async clear() {
      if (!session?.id) return false;
      const cleared = await mgr.clearSessionMessages(session.id);
      if (!cleared) return false;
      session = typeof cleared === 'object' ? cleared : (mgr.getSession(session.id) || session);
      invalidateContextStatusCache();
      return true;
    },
    async compact() {
      if (!session?.id) return null;
      const result = await mgr.compactSessionMessages(session.id);
      session = mgr.getSession(session.id) || session;
      invalidateContextStatusCache();
      return result;
    },
    async setToolMode(nextMode) {
      mode = normalizeToolMode(nextMode);
      invalidatePreSessionToolSurface();
      if (session?.id) mgr.closeSession(session.id, 'cli-mode-switch');
      await recreateCurrentSessionIfReady();
      return mode;
    },
    setBridgeMode(nextMode) {
      const applied = bridge.setDefaultMode(nextMode);
      try { sharedCfgMod.updateSection('agent', (s) => ({ ...(s || {}), bridgeMode: applied })); } catch {}
      return applied;
    },
    toggleBridgeMode() {
      const applied = bridge.toggleDefaultMode();
      try { sharedCfgMod.updateSection('agent', (s) => ({ ...(s || {}), bridgeMode: applied })); } catch {}
      return applied;
    },
    bridgeStatus() {
      return bridgeStatusState();
    },
    get clientHostPid() {
      return session?.clientHostPid || process.pid;
    },
    bridgeControl(args = {}) {
      const callerSessionId = session?.id || null;
      return bridge.execute(args, {
        callerCwd: currentCwd,
        invocationSource: 'user-command',
        callerSessionId,
        clientHostPid: session?.clientHostPid || process.pid,
        notifyFn: notifyFnForSession(callerSessionId),
      });
    },
    onNotification(listener) {
      if (typeof listener !== 'function') return () => {};
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    toolsStatus(query = '') {
      const surface = activeToolSurface();
      const catalog = Array.isArray(surface?.deferredToolCatalog)
        ? surface.deferredToolCatalog
        : (Array.isArray(surface?.tools) ? surface.tools : []);
      const activeNames = new Set((surface?.tools || []).map((tool) => tool?.name).filter(Boolean));
      const needle = clean(query).toLowerCase();
      const rows = catalog.map((tool) => toolRow(tool, activeNames)).filter((row) => row.name);
      const tools = needle
        ? rows.filter((row) => toolSearchMatches(row, needle))
        : rows;
      return {
        mode,
        count: rows.length,
        activeCount: rows.filter((row) => row.active).length,
        tools,
        activeTools: sortedNamesByMeasuredUsage(activeNames),
      };
    },
    selectTools(names) {
      const list = Array.isArray(names) ? names : String(names || '').split(/[,\s]+/);
      const result = selectDeferredTools(activeToolSurface(), list, mode);
      return { ...result, status: this.toolsStatus() };
    },
    setCwd(path) {
      applyResolvedCwd(resolveCwdPath(currentCwd, path));
      return currentCwd;
    },
    mcpStatus() {
      return mcpStatus();
    },
    async reconnectMcp() {
      config = cfgMod.loadConfig();
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-reconnect');
      await recreateCurrentSessionIfReady();
      return status;
    },
    async addMcpServer(input = {}) {
      const { name, config: serverConfig } = normalizeMcpServerInput(input);
      const nextConfig = cfgMod.loadConfig();
      nextConfig.mcpServers = {
        ...(nextConfig.mcpServers || {}),
        [name]: serverConfig,
      };
      cfgMod.saveConfig(nextConfig);
      config = cfgMod.loadConfig();
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-add');
      await recreateCurrentSessionIfReady();
      return { name, status };
    },
    async removeMcpServer(name) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const nextConfig = cfgMod.loadConfig();
      const current = nextConfig.mcpServers && typeof nextConfig.mcpServers === 'object'
        ? { ...nextConfig.mcpServers }
        : {};
      if (!Object.prototype.hasOwnProperty.call(current, serverName)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      delete current[serverName];
      cfgMod.saveConfig({ ...nextConfig, mcpServers: current });
      config = cfgMod.loadConfig();
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-remove');
      await recreateCurrentSessionIfReady();
      return status;
    },
    async setMcpServerEnabled(name, enabled) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const nextConfig = cfgMod.loadConfig();
      const current = nextConfig.mcpServers && typeof nextConfig.mcpServers === 'object'
        ? { ...nextConfig.mcpServers }
        : {};
      if (!Object.prototype.hasOwnProperty.call(current, serverName)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      current[serverName] = { ...(current[serverName] || {}), enabled: enabled !== false };
      cfgMod.saveConfig({ ...nextConfig, mcpServers: current });
      config = cfgMod.loadConfig();
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-toggle');
      await recreateCurrentSessionIfReady();
      return status;
    },
    skillsStatus() {
      return skillsStatus();
    },
    skillContent(name) {
      return skillContent(name);
    },
    async addSkill(input = {}) {
      const skill = addProjectSkill(input);
      if (session?.id) mgr.closeSession(session.id, 'cli-skill-add');
      await recreateCurrentSessionIfReady();
      return { skill, status: skillsStatus() };
    },
    async reloadSkills() {
      if (session?.id) mgr.closeSession(session.id, 'cli-skills-reload');
      await recreateCurrentSessionIfReady();
      return skillsStatus();
    },
    pluginsStatus() {
      return pluginsStatus();
    },
    async reloadPlugins() {
      if (session?.id) mgr.closeSession(session.id, 'cli-plugins-reload');
      await recreateCurrentSessionIfReady();
      return pluginsStatus();
    },
    async addPlugin(source) {
      const dataDir = cfgMod.getPluginData?.();
      const plugin = registryAddPlugin(source, { dataDir });
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-add');
      await recreateCurrentSessionIfReady();
      return { plugin, status: pluginsStatus() };
    },
    async updatePlugin(plugin = {}) {
      const key = clean(plugin.id || plugin.name || plugin);
      const dataDir = cfgMod.getPluginData?.();
      const updated = registryUpdatePlugin(key, { dataDir });
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-update');
      await recreateCurrentSessionIfReady();
      return { plugin: updated, status: pluginsStatus() };
    },
    async removePlugin(plugin = {}) {
      const key = clean(plugin.id || plugin.name || plugin);
      const dataDir = cfgMod.getPluginData?.();
      const removed = registryRemovePlugin(key, { dataDir });
      const nextConfig = cfgMod.loadConfig();
      const serverName = pluginMcpServerName(plugin);
      if (nextConfig.mcpServers && Object.prototype.hasOwnProperty.call(nextConfig.mcpServers, serverName)) {
        const current = { ...nextConfig.mcpServers };
        delete current[serverName];
        cfgMod.saveConfig({ ...nextConfig, mcpServers: current });
        config = cfgMod.loadConfig();
        await connectConfiguredMcp({ reset: true });
        invalidatePreSessionToolSurface();
      }
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-remove');
      await recreateCurrentSessionIfReady();
      return { plugin: removed, status: pluginsStatus() };
    },
    async enablePluginMcp(plugin = {}) {
      const root = clean(plugin.root);
      const script = clean(plugin.mcpScript);
      if (!root || !script) throw new Error('plugin has no MCP script');
      const scriptPath = join(root, script);
      if (!existsSync(scriptPath)) throw new Error(`plugin MCP script not found: ${scriptPath}`);
      const serverName = pluginMcpServerName(plugin);
      const nextConfig = cfgMod.loadConfig();
      nextConfig.mcpServers = {
        ...(nextConfig.mcpServers || {}),
        [serverName]: {
          command: 'node',
          args: [scriptPath],
          cwd: root,
          env: {
            MIXDOG_PLUGIN_ROOT: root,
            MIXDOG_PLUGIN_DATA: join(cfgMod.getPluginData?.() || STANDALONE_DATA_DIR, 'plugins', 'data', clean(plugin.id || plugin.name || serverName)),
          },
        },
      };
      cfgMod.saveConfig(nextConfig);
      config = cfgMod.loadConfig();
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-mcp-enable');
      await recreateCurrentSessionIfReady();
      return { serverName, status };
    },
    hooksStatus() {
      return hooks.status();
    },
    addHookRule(rule) {
      return hooks.addRule(rule);
    },
    setHookRuleEnabled(index, enabled) {
      return hooks.setRuleEnabled(index, enabled);
    },
    deleteHookRule(index) {
      return hooks.deleteRule(index);
    },
    async memoryControl(args = {}) {
      const memoryMod = await getMemoryModule();
      if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
      return toolResponseText(await memoryMod.handleToolCall('memory', args || {}));
    },
    async recall(query, args = {}) {
      const memoryMod = await getMemoryModule();
      if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
      return toolResponseText(await memoryMod.handleToolCall('recall', {
        ...(args || {}),
        query: query || args?.query || '',
        cwd: args?.cwd || currentCwd,
      }));
    },
    async setRoute(next) {
      const requested = { ...(next || {}) };
      if (requested.effort === undefined && !requested.provider && !requested.model && hasOwn(route, 'effort')) {
        requested.effort = route.effort;
      }
      if (!requested.provider && requested.model && !findPreset(config, requested.model)) {
        requested.provider = route.provider;
      }
      let selectedRoute = resolveRoute(config, requested);
      await reg.initProviders(ensureProviderEnabled(config, selectedRoute.provider));
      const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
      const fastCapable = fastCapableFor(selectedRoute.provider, modelMeta);
      selectedRoute = { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false };
      config = saveModelSettings(cfgMod, selectedRoute, { fastCapable });
      const leadRoute = persistLeadRoute(selectedRoute);
      route = resolveRoute(config, leadRoute
        ? { model: workflowPresetId('lead') }
        : selectedRoute);
      await refreshRouteEffort(modelMeta);
      if (session) {
        const updated = mgr.updateSessionRoute?.(session.id, {
          provider: route.provider,
          model: route.model,
          fast: route.fast === true,
          effort: route.effectiveEffort || null,
        });
        if (updated) session = updated;
        else {
          session.provider = route.provider;
          session.model = route.model;
          session.fast = route.fast === true;
          session.effort = route.effectiveEffort || null;
        }
        statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route));
        invalidateContextStatusCache();
      }
      return route;
    },

    async setFast(value) {
      const enabled = value === true;
      const modelMeta = await lookupModelMeta(route.provider, route.model);
      const fastCapable = fastCapableFor(route.provider, modelMeta);
      if (enabled && !fastCapable) {
        throw new Error(`fast mode is not available for ${route.provider}/${route.model}`);
      }
      route = resolveRoute(config, { provider: route.provider, model: route.model, effort: route.effort, fast: fastCapable ? enabled : false });
      config = saveModelSettings(cfgMod, route, { fastCapable });
      const leadRoute = persistLeadRoute(route);
      if (leadRoute) route = resolveRoute(config, { model: workflowPresetId('lead') });
      await refreshRouteEffort(modelMeta);
      if (session) {
        session.fast = route.fast === true;
        session.effort = route.effectiveEffort || null;
        statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route));
        invalidateContextStatusCache();
      }
      return route.fast === true;
    },

    async toggleFast() {
      return await this.setFast(!(route.fast === true));
    },

    async setEffort(value) {
      const normalized = normalizeEffortInput(value);
      route = { ...route, effort: normalized };
      config = saveModelSettings(cfgMod, route, { fastCapable: route.fastCapable !== false });
      const leadRoute = persistLeadRoute(route);
      if (leadRoute) {
        route = resolveRoute(config, { model: workflowPresetId('lead') });
      }
      await refreshRouteEffort();
      if (session) {
        session.effort = route.effectiveEffort || null;
        statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route));
        invalidateContextStatusCache();
      }
      return route;
    },
    async close(reason = 'cli-exit', options = {}) {
      const detach = options?.detach === true || options?.wait === false || options?.waitForExit === false;
      closeRequested = true;
      if (channelStartTimer) {
        clearTimeout(channelStartTimer);
        channelStartTimer = null;
      }
      try { cancelBackgroundTasks({ reason, notify: false }); } catch {}
      const channelStop = channels.stop(reason, detach ? { waitForExit: false } : undefined);
      try { bridge.closeAll(reason); } catch {}
      let mcpStop = null;
      try { mcpStop = mcpClient.disconnectAll?.(); } catch {}
      const openaiWsStop = import('./runtime/agent/orchestrator/providers/openai-oauth-ws.mjs')
        .then((mod) => mod?.drainOpenaiWsPool?.(reason))
        .catch(() => {});
      const patchStop = closePatchRuntimeIfLoaded(detach ? { waitForExit: false } : undefined);
      let ok = false;
      if (session?.id) {
        statusRoutes?.clearGatewaySessionRoute?.(session.id);
        ok = mgr.closeSession(session.id, reason);
        session = null;
      }
      if (detach) {
        try { await withTeardownDeadline(channelStop, 300, false); } catch {}
        for (const stop of [mcpStop, openaiWsStop, patchStop]) {
          Promise.resolve(stop).catch(() => {});
        }
        return ok;
      }
      await Promise.allSettled([
        withTeardownDeadline(channelStop, 5500, false),
        withTeardownDeadline(mcpStop, 1500, false),
        withTeardownDeadline(openaiWsStop, 1500, false),
        withTeardownDeadline(patchStop, 1500, false),
      ]);
      return ok;
    },
    abort(reason = 'cli-abort') {
      if (!session?.id) return false;
      return mgr.abortSessionTurn(session.id, reason);
    },
    listSessions() {
      return mgr.listSessions({}).map(s => {
        const owner = clean(s.owner || 'user').toLowerCase();
        if (owner && !['cli', 'user', 'mixdog', 'legacy'].includes(owner)) return null;
        const sourceType = clean(s.sourceType || '').toLowerCase();
        const sourceName = clean(s.sourceName || '').toLowerCase();
        const role = clean(s.role || '').toLowerCase();
        const leadish = role === 'lead'
          || sourceType === 'lead'
          || (sourceType === 'cli' && (!sourceName || sourceName === 'main'))
          || (!sourceType && !sourceName && owner !== 'bridge');
        if (!leadish) return null;
        const msgs = s.messages || [];
        const userPreviews = msgs
          .filter(m => m && m.role === 'user')
          .map(m => cleanSessionPreview(sessionMessageText(m.content)))
          .filter(text => !isSessionPreviewNoise(text));
        const preview = userPreviews[userPreviews.length - 1] || userPreviews[0] || '';
        if (!preview) return null;
        const userAsst = msgs.filter(m => m && (m.role === 'user' || m.role === 'assistant'));
        return {
          id: s.id,
          updatedAt: s.updatedAt,
          cwd: s.cwd || '',
          model: s.model,
          provider: s.provider,
          messageCount: userAsst.length,
          preview,
        };
      }).filter(Boolean);
    },
    async newSession() {
      if (session?.id) mgr.closeSession(session.id, 'cli-new');
      await createCurrentSession();
      return session.id;
    },
    async resume(id) {
      const previousId = session?.id || null;
      const resumed = await mgr.resumeSession(id, toolSpecForMode(mode));
      if (!resumed) return null;
      if (previousId && previousId !== resumed.id) {
        statusRoutes?.clearGatewaySessionRoute?.(previousId);
        mgr.closeSession(previousId, 'cli-resume');
      }
      session = resumed;
      currentCwd = resumed.cwd || currentCwd;
      applyResolvedCwd(currentCwd, { markRefresh: false });
      const resumeEffort = hasOwn(route, 'effort') ? route.effort : resumed.effort;
      route = resolveRoute(config, { provider: resumed.provider, model: resumed.model, effort: resumeEffort });
      await refreshRouteEffort();
      session.effort = route.effectiveEffort || null;
      session.cwd = currentCwd;
      applyDeferredToolSurface(session, mode, standaloneTools);
      invalidatePreSessionToolSurface();
      invalidateContextStatusCache();
      sessionNeedsCwdRefresh = false;
      statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route));
      return {
        id: resumed.id,
        messages: resumed.messages || [],
        cwd: currentCwd,
        provider: resumed.provider,
        model: resumed.model,
      };
    },
  };
}
