import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ensureStandaloneEnvironment } from './standalone/seeds.mjs';
import { createStandaloneBridge } from './standalone/bridge-tool.mjs';
import { EXPLORE_TOOL, runExplore } from './standalone/explore-tool.mjs';
import { createStandaloneChannelWorker } from './standalone/channel-worker.mjs';
import { createStandaloneHookBus } from './standalone/hook-bus.mjs';
import { writeLastSessionCwd } from './runtime/shared/user-cwd.mjs';
import {
  PROVIDER_STATUS_TOOL,
  forgetProviderAuth,
  loginOAuthProvider,
  providerSetup,
  renderProviderStatus,
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
const STANDALONE_PROJECT_ROOT = resolve(__dirname, '..');
// Resource root stays at src/ because defaults/, rules/, runtime/, vendor/ live
// there. User-owned standalone state is scoped to the project/package root so
// installs do not fall back to ~/.mixdog by default.
const STANDALONE_ROOT = STANDALONE_SOURCE_ROOT;
const STANDALONE_DATA_DIR = process.env.MIXDOG_DATA_DIR || join(STANDALONE_PROJECT_ROOT, '.mixdog', 'data');

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

const TOOL_SEARCH_TOOL = {
  name: 'tool_search',
  title: 'Tool Search',
  annotations: {
    title: 'Tool Search',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  description: 'Search the current standalone tool surface and select tools/skills for the task. Use before deferred or unfamiliar tools.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional search text, e.g. edit, bridge, memory, skill, mcp.' },
      select: { type: ['string', 'array'], description: 'Comma-separated tool names or an array of tool names to select.' },
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
  description: 'List standalone Discord/channel/schedule/webhook configuration status. This never returns secrets.',
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
  description: 'Show or set the standalone session working directory. action=get|set; path is required for set.',
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
  bash: 81,
  edit: 40,
  write: 38,
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
  write: ['apply_patch', 'write'],
  edit: ['apply_patch'],
  shell: ['bash', 'job_wait'],
  bash: ['bash', 'job_wait'],
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
  if (declared.length > 0) return filterProvider(declared);
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
  const items = [{ value: 'auto', label: 'auto', description: 'provider/model default' }];
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
    || readJsonSafe(join(root, '.claude-plugin', 'plugin.json'))
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

  cfgMod.saveConfig({ ...nextConfig, modelSettings, fastModels });
  return cfgMod.loadConfig();
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
const WORKFLOW_ROUTE_SLOTS = ['lead', 'bridge', 'explorer', 'search', 'memory'];

function workflowPresetId(slot) {
  return `workflow-${slot}`;
}

function workflowPresetName(slot) {
  return `WORKFLOW ${String(slot || '').toUpperCase()}`;
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
  if (['edit', 'write', 'apply_patch', 'bash'].includes(name)) return 'write';
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

    const nextConfig = cfgMod.loadConfig();
    nextConfig.presets = upsertWorkflowPreset(nextConfig.presets, 'lead', leadRoute);
    nextConfig.workflowRoutes = {
      ...(nextConfig.workflowRoutes || {}),
      lead: leadRoute,
    };
    nextConfig.default = workflowPresetId('lead');

    cfgMod.saveConfig(nextConfig);
    config = cfgMod.loadConfig();
    return leadRoute;
  }

  async function closePatchRuntimeIfLoaded() {
    const closer = globalThis.__mixdogCloseNativePatchServers;
    if (typeof closer !== 'function' || globalThis.__mixdogNativePatchRuntimeTouched !== true) return;
    bootProfile('patch-runtime:close:start');
    const startedAt = performance.now();
    try {
      await closer();
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

  let config = cfgMod.loadConfig();
  let route = resolveRoute(config, { provider, model });
  let mode = normalizeToolMode(toolMode);
  let session = null;
  let currentCwd = cwd;
  let closeRequested = false;
  let channelStartTimer = null;
  const modelMetaByRoute = new Map();
  let mcpFailures = [];
  const hooks = createStandaloneHookBus({ dataDir: cfgMod.getPluginData() });
  hooks.emit('runtime:start', { cwd: currentCwd, provider: route.provider, model: route.model, toolMode: mode });

  function mcpTransportLabel(cfg = {}) {
    if (cfg.autoDetect) return `autoDetect:${cfg.autoDetect}`;
    if (cfg.transport === 'http' || cfg.url) return 'http';
    if (cfg.command) return 'stdio';
    return 'unknown';
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
  const bridge = createStandaloneBridge({
    cfgMod,
    reg,
    mgr,
    dataDir: cfgMod.getPluginData(),
    cwd,
    defaultMode: persistedBridgeMode ?? 'async',
  });
  const bridgeStatusState = () => {
    try {
      const status = bridge.getStatus?.() || {};
      return {
        bridgeMode: bridge.getDefaultMode?.() || status.bridgeMode || 'async',
        bridgeWorkers: Array.isArray(status.workers) ? status.workers : [],
        bridgeJobs: Array.isArray(status.jobs) ? status.jobs : [],
      };
    } catch {
      return { bridgeMode: bridge.getDefaultMode?.() || 'async', bridgeWorkers: [], bridgeJobs: [] };
    }
  };
  const channels = createStandaloneChannelWorker({
    entry: join(STANDALONE_ROOT, CHANNEL_WORKER_ENTRY.replace(/^\.\//, '')),
    rootDir: STANDALONE_ROOT,
    dataDir: cfgMod.getPluginData(),
    cwd,
  });
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
  ];
  internalTools.setInternalToolsProvider({
    tools: standaloneTools,
    executor: async (name, args, callerCtx = {}) => {
      const callerCwd = callerCtx?.callerCwd || currentCwd;
      if (name === 'search' || name === 'web_fetch') {
        const searchMod = await getSearchModule();
        if (!searchMod?.handleToolCall) throw new Error('search runtime is not available');
        return await searchMod.handleToolCall(name, args || {});
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
        return await runExplore(args || {}, {
          callerCwd: args?.cwd ? resolveCwdPath(currentCwd, args.cwd) : callerCwd,
          callerSessionId: callerCtx?.callerSessionId || session?.id || null,
        });
      }
      if (name === 'cwd') {
        const action = clean(args?.action || (args?.path ? 'set' : 'get')).toLowerCase();
        if (action === 'set') {
          currentCwd = resolveCwdPath(currentCwd, args?.path);
          process.env.MIXDOG_SESSION_CWD = currentCwd;
          writeLastSessionCwd(currentCwd);
          if (session) session.cwd = currentCwd;
        } else if (action !== 'get') {
          throw new Error(`cwd: unknown action "${action}"`);
        }
        return JSON.stringify({ cwd: currentCwd, sessionId: session?.id || null }, null, 2);
      }
      if (name === 'bridge') return await bridge.execute(args, { callerCwd, invocationSource: 'model-tool' });
      if (name === 'provider_status') return renderProviderStatus(cfgMod.loadConfig());
      if (name === 'channel_status') return renderChannelStatus();
      if (channels.isChannelTool(name)) return await channels.execute(name, args || {});
      throw new Error(`unknown standalone internal tool: ${name}`);
    },
  });
  internalTools.markBootReady?.();
  await connectConfiguredMcp();

  function reloadChannelsSoon() {
    channels.execute('reload_config', {}).catch(() => {});
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

  function sortProviderModels(models) {
    return (models || []).sort((a, b) => {
      const ar = a.provider === route.provider ? 0 : 1;
      const br = b.provider === route.provider ? 0 : 1;
      if (ar !== br) return ar - br;
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      if (a.latest !== b.latest) return a.latest ? -1 : 1;
      return String(a.display || a.id).localeCompare(String(b.display || b.id));
    });
  }

  async function collectProviderModels() {
    await reg.initProviders(config.providers || {});
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
            const key = `${name}:${m.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({
              id: m.id,
              provider: name,
              display: m.display || m.name || m.id,
              contextWindow: m.contextWindow,
              outputTokens: m.outputTokens || null,
              family: m.family || null,
              tier: m.tier || null,
              latest: m.latest === true,
              description: m.description || '',
              supportsVision: m.supportsVision === true,
              supportsFunctionCalling: m.supportsFunctionCalling === true,
              supportsPromptCaching: m.supportsPromptCaching === true,
              reasoningLevels: Array.isArray(m.reasoningLevels) ? m.reasoningLevels : [],
              effortOptions: effortItemsFor(name, m, null),
              fastCapable: fastCapableFor(name, m),
              fastPreferred: fastPreferenceFor(config, name, m.id),
              savedEffort: modelSettingsFor(config, name, m.id).effort || null,
              savedFast: modelSettingsFor(config, name, m.id).fast === true,
            });
          }
        }
      } catch {
        // Ignore per-provider catalog failures so one bad credential or
        // transient /models error does not hide other authenticated models.
      }
    }
    return sortProviderModels(results);
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

  async function refreshRouteEffort() {
    await reg.initProviders(ensureProviderEnabled(config, route.provider));
    const modelMeta = await lookupModelMeta(route.provider, route.model);
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
    await resolveMissingRouteModelForFirstTurn();
    requireModelRoute();
    await refreshRouteEffort();
    const providerImpl = reg.getProvider(route.provider);
    if (!providerImpl) {
      throw new Error(`Provider "${route.provider}" is not configured.`);
    }
    const coreMemoryContext = await loadCoreMemoryContext();
    const sessionOpts = {
      provider: route.provider,
      model: route.model,
      preset: route.preset || undefined,
      tools: toolSpecForMode(mode),
      owner: 'cli',
      lane: 'cli',
      sourceType: 'cli',
      sourceName: 'main',
      clientHostPid: process.pid,
      disallowedTools: ['diagnostics', 'open_config'],
      cwd: currentCwd,
      coreMemoryContext,
      fast: route.fast === true,
    };
    if (hasOwn(route, 'effort') || route.effectiveEffort) {
      sessionOpts.effort = route.effectiveEffort || null;
    }
    session = mgr.createSession(sessionOpts);
    Object.defineProperty(session, 'beforeToolHook', {
      value: (input) => hooks.beforeTool(input),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    applyDeferredToolSurface(session, mode, standaloneTools);
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

  const recreateStartedAt = performance.now();
  await recreateCurrentSessionIfReady();
  bootProfile('session-runtime:ready', { ms: (performance.now() - recreateStartedAt).toFixed(1) });
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
      return route.effectiveEffort || null;
    },
    get fast() {
      return route.fast === true;
    },
    get fastCapable() {
      return route.fastCapable === true;
    },
    get effortOptions() {
      return route.effortOptions || [{ value: 'auto', label: 'auto', description: 'provider/model default' }];
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
    get cwd() {
      return currentCwd;
    },
    get session() {
      return session;
    },
    contextStatus() {
      const messages = Array.isArray(session?.messages) ? session.messages : [];
      const messageSummary = summarizeContextMessages(messages);
      const tools = Array.isArray(session?.tools) ? session.tools : [];
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
      const usedTokens = lastUsageStale
        ? estimatedContextTokens
        : Math.max(estimatedContextTokens, lastContextTokens || 0);
      const freeTokens = effectiveWindow ? Math.max(0, effectiveWindow - usedTokens) : 0;
      const compactBoundaryTokens = Number(session?.compactBoundaryTokens || session?.compaction?.boundaryTokens || 0);
      const compactTriggerTokens = Number(session?.compaction?.triggerTokens || 0);
      return {
        sessionId: session?.id || null,
        provider: route.provider,
        model: route.model,
        cwd: currentCwd,
        toolMode: mode,
        bridgeMode: bridge.getDefaultMode(),
        contextWindow: effectiveWindow || null,
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
    },
    listProviders() {
      return renderProviderStatus(cfgMod.loadConfig());
    },
    async getProviderSetup() {
      return await providerSetup(cfgMod.loadConfig());
    },
    async getUsageDashboard(options = {}) {
      const nextConfig = cfgMod.loadConfig();
      return await createUsageDashboard(nextConfig, {
        ...(options || {}),
        setup: await providerSetup(nextConfig),
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
      return result;
    },
    async loginOAuthProvider(providerId) {
      const result = await loginOAuthProvider(cfgMod, providerId);
      config = cfgMod.loadConfig();
      return result;
    },
    saveProviderApiKey(providerId, secret) {
      const result = saveProviderApiKey(cfgMod, providerId, secret);
      config = cfgMod.loadConfig();
      return result;
    },
    setLocalProvider(providerId, opts) {
      const result = setLocalProvider(cfgMod, providerId, opts);
      config = cfgMod.loadConfig();
      return result;
    },
    forgetProviderAuth(providerId) {
      const result = forgetProviderAuth(providerId);
      config = cfgMod.loadConfig();
      return result;
    },
    listPresets() {
      return cfgMod.listPresets(cfgMod.loadConfig());
    },
    async listProviderModels() {
      return await collectProviderModels();
    },
    async ask(prompt, options = {}) {
      if (!session?.id) await createCurrentSession();
      const startedAt = Date.now();
      hooks.emit('turn:start', { sessionId: session.id, prompt, cwd: currentCwd });
      try {
        const result = await mgr.askSession(
          session.id,
          prompt,
          options.context || null,
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
      return await mgr.clearSessionMessages(session.id);
    },
    async compact() {
      if (!session?.id) return null;
      const result = await mgr.compactSessionMessages(session.id);
      session = mgr.getSession(session.id) || session;
      return result;
    },
    async setToolMode(nextMode) {
      mode = normalizeToolMode(nextMode);
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
    bridgeControl(args = {}) {
      return bridge.execute(args, { callerCwd: currentCwd, invocationSource: 'user-command' });
    },
    toolsStatus(query = '') {
      const catalog = Array.isArray(session?.deferredToolCatalog)
        ? session.deferredToolCatalog
        : (Array.isArray(session?.tools) ? session.tools : []);
      const activeNames = new Set((session?.tools || []).map((tool) => tool?.name).filter(Boolean));
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
      const result = selectDeferredTools(session, list, mode);
      return { ...result, status: this.toolsStatus() };
    },
    setCwd(path) {
      currentCwd = resolveCwdPath(currentCwd, path);
      process.env.MIXDOG_SESSION_CWD = currentCwd;
      writeLastSessionCwd(currentCwd);
      if (session) session.cwd = currentCwd;
      return currentCwd;
    },
    mcpStatus() {
      return mcpStatus();
    },
    async reconnectMcp() {
      config = cfgMod.loadConfig();
      const status = await connectConfiguredMcp({ reset: true });
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
            CLAUDE_PLUGIN_ROOT: root,
            CLAUDE_PLUGIN_DATA: join(cfgMod.getPluginData?.() || STANDALONE_DATA_DIR, 'plugins', 'data', clean(plugin.id || plugin.name || serverName)),
          },
        },
      };
      cfgMod.saveConfig(nextConfig);
      config = cfgMod.loadConfig();
      const status = await connectConfiguredMcp({ reset: true });
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
      if (session?.id) mgr.closeSession(session.id, 'cli-model-switch');
      await recreateCurrentSessionIfReady();
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
      if (session) {
        session.fast = route.fast === true;
        statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route));
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
      }
      return route;
    },
    async close(reason = 'cli-exit') {
      closeRequested = true;
      if (channelStartTimer) {
        clearTimeout(channelStartTimer);
        channelStartTimer = null;
      }
      const channelStop = channels.stop(reason);
      try { bridge.closeAll(reason); } catch {}
      let mcpStop = null;
      try { mcpStop = mcpClient.disconnectAll?.(); } catch {}
      const openaiWsStop = import('./runtime/agent/orchestrator/providers/openai-oauth-ws.mjs')
        .then((mod) => mod?.drainOpenaiWsPool?.(reason))
        .catch(() => {});
      let ok = false;
      if (session?.id) {
        statusRoutes?.clearGatewaySessionRoute?.(session.id);
        ok = mgr.closeSession(session.id, reason);
        session = null;
      }
      await Promise.allSettled([
        withTeardownDeadline(channelStop, 5500, false),
        withTeardownDeadline(mcpStop, 1500, false),
        withTeardownDeadline(openaiWsStop, 1500, false),
        withTeardownDeadline(closePatchRuntimeIfLoaded(), 1500, false),
      ]);
      return ok;
    },
    abort(reason = 'cli-abort') {
      if (!session?.id) return false;
      return mgr.abortSessionTurn(session.id, reason);
    },
    listSessions() {
      return mgr.listSessions({}).map(s => {
        const msgs = s.messages || [];
        const userPreviews = msgs
          .filter(m => m && m.role === 'user')
          .map(m => cleanSessionPreview(sessionMessageText(m.content)))
          .filter(text => !isSessionPreviewNoise(text));
        const preview = userPreviews[userPreviews.length - 1] || userPreviews[0] || '';
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
      });
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
      writeLastSessionCwd(currentCwd);
      const resumeEffort = hasOwn(route, 'effort') ? route.effort : resumed.effort;
      route = resolveRoute(config, { provider: resumed.provider, model: resumed.model, effort: resumeEffort });
      await refreshRouteEffort();
      session.effort = route.effectiveEffort || null;
      session.cwd = currentCwd;
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
