import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ensureStandaloneEnvironment } from './standalone/seeds.mjs';
import { createStandaloneAgent } from './standalone/agent-tool.mjs';
import { isAgentOwner } from './runtime/agent/orchestrator/agent-owner.mjs';
import { EXPLORE_TOOL, runExplore } from './standalone/explore-tool.mjs';
import { createStandaloneChannelWorker } from './standalone/channel-worker.mjs';
import { createStandaloneMemoryRuntime } from './standalone/memory-runtime-proxy.mjs';
import { createStandaloneHookBus } from './standalone/hook-bus.mjs';
import { writeLastSessionCwd } from './runtime/shared/user-cwd.mjs';
import { cancelBackgroundTasks } from './runtime/shared/background-tasks.mjs';
import {
  modelVisibleToolCompletionMessage,
  shouldPersistModelVisibleToolCompletion,
} from './runtime/shared/tool-execution-contract.mjs';
import {
  normalizeAgentPermissionOrNone,
  readMarkdownDocument,
} from './runtime/shared/markdown-frontmatter.mjs';
import { setConfiguredShell } from './runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs';
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
import { fetchOAuthUsageSnapshot } from './runtime/agent/orchestrator/providers/oauth-usage.mjs';
import { getModelMetadataSync } from './runtime/agent/orchestrator/providers/model-catalog.mjs';
import {
  isResponsesFreeformTool,
  toResponsesCustomTool,
} from './runtime/agent/orchestrator/providers/custom-tool-wire.mjs';
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

function stripSystemReminder(text) {
  return String(text || '')
    .replace(/^\s*<system-reminder>\s*/i, '')
    .replace(/\s*<\/system-reminder>\s*$/i, '')
    .trim();
}

function splitMarkdownSections(text) {
  const sections = [];
  let current = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^#\s+/.test(line) && current.length) {
      const body = current.join('\n').trim();
      if (body) sections.push(body);
      current = [line];
    } else {
      current.push(line);
    }
  }
  const tail = current.join('\n').trim();
  if (tail) sections.push(tail);
  return sections;
}

function reminderSectionBucket(section) {
  const heading = String(section.match(/^#\s+([^\n]+)/)?.[1] || '').trim().toLowerCase();
  if (heading.includes('core memory')) return 'memory';
  if (heading.includes('active workflow') || heading.includes('available agents') || heading.includes('workflow')) return 'workflow';
  if (heading.includes('workspace')) return 'workspace';
  if (heading.includes('environment')) return 'environment';
  return 'other';
}

function summarizeContextMessages(messages) {
  const rows = {
    system: { count: 0, tokens: 0 },
    user: { count: 0, tokens: 0 },
    assistant: { count: 0, tokens: 0 },
    tool: { count: 0, tokens: 0 },
    other: { count: 0, tokens: 0 },
  };
  const semantic = {
    system: { count: 0, tokens: 0 },
    chat: { count: 0, tokens: 0 },
    assistant: { count: 0, tokens: 0 },
    toolResults: { count: 0, tokens: 0 },
    reminders: { count: 0, tokens: 0, otherTokens: 0 },
    workflow: { tokens: 0 },
    memory: { tokens: 0 },
    workspace: { tokens: 0 },
    environment: { tokens: 0 },
    other: { tokens: 0 },
  };
  let toolCallCount = 0;
  let toolCallTokens = 0;
  let toolResultCount = 0;
  let toolResultTokens = 0;
  for (const message of messages || []) {
    const role = rows[message?.role] ? message.role : 'other';
    const text = messageContextText(message);
    const tokens = roughTokenCount(text) + 4;
    rows[role].count += 1;
    rows[role].tokens += tokens;
    if (role === 'system') {
      semantic.system.count += 1;
      semantic.system.tokens += tokens;
    } else if (role === 'user') {
      if (String(text || '').trim().startsWith('<system-reminder>')) {
        semantic.reminders.count += 1;
        semantic.reminders.tokens += tokens;
        let sectionTokens = 0;
        for (const section of splitMarkdownSections(stripSystemReminder(text))) {
          const bucket = reminderSectionBucket(section);
          const sectionTokenCount = roughTokenCount(section);
          semantic[bucket].tokens += sectionTokenCount;
          sectionTokens += sectionTokenCount;
        }
        semantic.reminders.otherTokens += Math.max(0, tokens - sectionTokens);
      } else {
        semantic.chat.count += 1;
        semantic.chat.tokens += tokens;
      }
    } else if (role === 'assistant') {
      semantic.assistant.count += 1;
      semantic.assistant.tokens += tokens;
    } else if (role === 'tool') {
      semantic.toolResults.count += 1;
      semantic.toolResults.tokens += tokens;
    }
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
    semantic,
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

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

function envPresent(name) {
  return process.env[name] !== undefined && process.env[name] !== '';
}

function envDelayMs(name, fallback, { min = 0, max = 60_000 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const BOOT_PROFILE_ENABLED = envFlag('MIXDOG_BOOT_PROFILE');
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
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
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
    agentHidden: true,
  },
  description: 'Search deferred tools; confident queries load matches.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search text; confident hits load. select:a,b forces exact names.' },
      select: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Force exact tool names.' },
      limit: { type: 'number', description: 'Max matches.' },
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
    agentHidden: true,
  },
  description: 'List channel/schedule/webhook status. No secrets.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const CWD_TOOL = {
  name: 'cwd',
  title: 'Work Project',
  annotations: {
    title: 'Work Project',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    agentHidden: true,
  },
  description: 'Show or set the session work project for tool execution.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'], description: 'Default get.' },
      path: { type: 'string', description: 'Project directory for set.' },
    },
    additionalProperties: false,
  },
};

export const SKILL_TOOL = {
  name: 'Skill',
  title: 'Skill',
  annotations: {
    title: 'Skill',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    agentHidden: false,
  },
  description: 'Load a named SKILL.md into context.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

const MEASURED_TOOL_USAGE = Object.freeze({
  read: 710,
  code_graph: 520,
  grep: 500,
  find: 480,
  glob: 460,
  list: 430,
  apply_patch: 400,
  explore: 360,
  agent: 330,
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
const LEAD_DISALLOWED_TOOLS = Object.freeze(['diagnostics', 'open_config']);
const DEFERRED_DEFAULT_FULL_TOOLS = Object.freeze([
  'read',
  'code_graph',
  'grep',
  'find',
  'glob',
  'list',
  'explore',
  'apply_patch',
  'Skill',
  'tool_search',
]);
const DEFERRED_DEFAULT_READONLY_TOOLS = Object.freeze([
  'read',
  'code_graph',
  'grep',
  'find',
  'glob',
  'list',
  'explore',
  'Skill',
  'tool_search',
]);
const DEFERRED_DEFAULT_LEAD_TOOLS = Object.freeze([
  'read',
  'code_graph',
  'grep',
  'find',
  'glob',
  'list',
  'shell',
  'task',
  'explore',
  'apply_patch',
  'agent',
  'recall',
  'search',
  'web_fetch',
  'cwd',
  'Skill',
  'tool_search',
]);
const READONLY_TOOL_NAMES = new Set([
  'read',
  'list',
  'grep',
  'find',
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
  'Skill',
]);
const AGENT_HIDDEN_WRAPPER_TOOLS = new Set(['search']);

function applyStandaloneToolDefaults(tool) {
  if (!tool || !AGENT_HIDDEN_WRAPPER_TOOLS.has(tool.name)) return tool;
  return {
    ...tool,
    annotations: {
      ...(tool.annotations || {}),
      agentHidden: true,
    },
  };
}
const DEFERRED_SELECT_ALIASES = {
  filesystem: ['read', 'list', 'grep', 'find', 'glob'],
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
  agent: ['agent'],
  graph: ['code_graph'],
  code: ['code_graph'],
  shell: ['shell', 'task'],
};
const TOOL_SEARCH_SAFE_AUTO_ALIASES = new Set([
  'shell',
  'web',
  'search',
  'agent',
  'provider',
  'providers',
  'channel',
  'schedule',
  'memory',
]);
const TOOL_SEARCH_AMBIGUOUS_AUTO_QUERIES = new Set([
  'status',
  'state',
  'info',
  'list',
  'show',
  'config',
]);
const TOOL_SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'me',
  'need',
  'of',
  'on',
  'please',
  'the',
  'to',
  'tool',
  'tools',
  'use',
  'using',
  'with',
]);
const TOOL_SEARCH_ROW_ALIASES = Object.freeze({
  agent: ['delegate', 'subagent', 'worker', 'parallel agent', 'background agent', 'reviewer', 'explorer'],
  channel_status: ['channel status', 'discord status', 'channel config'],
  cwd: ['cwd', 'working directory', 'current directory', 'project root', 'folder'],
  memory: ['save memory', 'store memory', 'delete memory', 'forget memory', 'memory status'],
  provider_status: ['provider status', 'auth status', 'model status', 'oauth status', 'provider config'],
  recall: ['recall', 'previous work', 'past work', 'prior context', 'history', 'resume context'],
  schedule_status: ['schedule status', 'cron status'],
  search: ['web search', 'internet search', 'current info', 'latest info', 'online search', 'docs search'],
  shell: ['run command', 'execute command', 'terminal', 'powershell', 'bash', 'run tests', 'test command', 'build command', 'npm', 'node', 'git'],
  task: ['background task', 'async task', 'wait task', 'cancel task', 'task status'],
  web_fetch: ['fetch url', 'fetch page', 'open url', 'web page', 'read url', 'docs page'],
});

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
  const family = clean(model?.family).toLowerCase();
  if (Array.isArray(model?.reasoningLevels)) {
    if (declared.length) return filterProvider(declared);
    if (Object.prototype.hasOwnProperty.call(EFFORT_BY_FAMILY, family)) {
      return filterProvider(EFFORT_BY_FAMILY[family]);
    }
    return [];
  }
  const reasoningOptionEffort = Array.isArray(model?.reasoningOptions)
    ? model.reasoningOptions.find((option) => clean(option?.type).toLowerCase() === 'effort')
    : null;
  const reasoningOptionValues = Array.isArray(reasoningOptionEffort?.values)
    ? reasoningOptionEffort.values.map(clean).filter(Boolean)
    : [];
  if (reasoningOptionValues.length) return filterProvider(reasoningOptionValues);
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

function deferredSurfaceModeForLead(mode) {
  return mode === 'readonly' ? 'readonly' : 'lead';
}

function clean(value) {
  return String(value ?? '').trim();
}

// A resolved model meta carries catalog-derived fields (contextWindow, pricing,
// capabilities, …). The lookupModelMeta() fallback for an unknown id is the
// bare shape `{ id, provider }`, so "more than id/provider" reliably tells a
// real catalog hit apart from that placeholder.
function modelMetaLooksResolved(meta) {
  if (!meta || typeof meta !== 'object') return false;
  return Object.keys(meta).some((key) => key !== 'id' && key !== 'provider');
}

const OUTPUT_STYLE_ORDER = ['default', 'simple', 'extreme-simple'];
const OUTPUT_STYLE_ALIASES = new Map([
  ['compact', 'default'],
  ['normal', 'default'],
  ['extreme', 'extreme-simple'],
  ['extremesimple', 'extreme-simple'],
  ['extreme-simple', 'extreme-simple'],
  ['extreme_simple', 'extreme-simple'],
]);

function normalizeOutputStyleId(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return '';
  const slug = raw.replace(/[_\s]+/g, '-').replace(/^-+|-+$/g, '');
  const compact = slug.replace(/[_.-]+/g, '');
  if (OUTPUT_STYLE_ALIASES.has(slug)) return OUTPUT_STYLE_ALIASES.get(slug);
  if (OUTPUT_STYLE_ALIASES.has(compact)) return OUTPUT_STYLE_ALIASES.get(compact);
  return /^[a-z0-9.-]+$/.test(slug) ? slug : '';
}

function outputStyleCompactKey(value) {
  return normalizeOutputStyleId(value).replace(/[_.-]+/g, '');
}

function titleCaseOutputStyle(id) {
  return clean(id)
    .split(/[_.-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'Default';
}

function parseOutputStyleFrontmatter(markdown) {
  const match = String(markdown || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (!match) return meta;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!kv) continue;
    meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return meta;
}

function readOutputStyleMetadata(filePath, source) {
  let raw = '';
  try { raw = readFileSync(filePath, 'utf8'); } catch { return null; }
  const meta = parseOutputStyleFrontmatter(raw);
  const fileId = normalizeOutputStyleId(basename(filePath).replace(/\.md$/i, ''));
  const id = normalizeOutputStyleId(meta.name) || fileId;
  if (!id) return null;
  const aliases = clean(meta.aliases)
    .split(',')
    .map((value) => normalizeOutputStyleId(value))
    .filter(Boolean);
  const label = clean(meta.title || meta.label) || titleCaseOutputStyle(id);
  return {
    id,
    label,
    description: clean(meta.description),
    aliases,
    source,
  };
}

function listOutputStyleCatalog(dataDir = STANDALONE_DATA_DIR) {
  const byId = new Map();
  const dirs = [
    { dir: join(STANDALONE_ROOT, 'output-styles'), source: 'builtin' },
    { dir: join(dataDir || STANDALONE_DATA_DIR, 'output-styles'), source: 'user' },
  ];
  for (const { dir, source } of dirs) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const style = readOutputStyleMetadata(join(dir, entry.name), source);
      if (style) byId.set(style.id, style);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const ai = OUTPUT_STYLE_ORDER.indexOf(a.id);
    const bi = OUTPUT_STYLE_ORDER.indexOf(b.id);
    if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    return a.label.localeCompare(b.label, 'en', { sensitivity: 'base' });
  });
}

function findOutputStyle(value, styles) {
  const id = normalizeOutputStyleId(value);
  const compact = outputStyleCompactKey(value);
  if (!id && !compact) return null;
  return (styles || []).find((style) => {
    if (style.id === id || outputStyleCompactKey(style.id) === compact) return true;
    if (outputStyleCompactKey(style.label) === compact) return true;
    return (style.aliases || []).some((alias) => alias === id || outputStyleCompactKey(alias) === compact);
  }) || null;
}

function configuredOutputStyleValue(dataDir = STANDALONE_DATA_DIR) {
  const unified = readJsonSafe(join(dataDir || STANDALONE_DATA_DIR, 'mixdog-config.json')) || {};
  return clean(unified.outputStyle || (unified.agent && unified.agent.outputStyle) || 'default') || 'default';
}

function outputStyleStatus(dataDir = STANDALONE_DATA_DIR) {
  const styles = listOutputStyleCatalog(dataDir);
  const configured = configuredOutputStyleValue(dataDir);
  const current = findOutputStyle(configured, styles)
    || findOutputStyle('default', styles)
    || styles[0]
    || { id: 'default', label: 'Default', description: '', aliases: [], source: 'builtin' };
  return { configured, current, styles };
}

function sessionHasConversationMessages(activeSession) {
  const messages = Array.isArray(activeSession?.messages) ? activeSession.messages : [];
  return messages.some((message) => {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') return false;
    const text = sessionMessageText(message.content).trim();
    if (!text && role !== 'assistant') return false;
    if (role === 'user' && isSessionPreviewNoise(text)) return false;
    return true;
  });
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

function isLikelyRawModelId(value) {
  const model = clean(value);
  if (!model || model.length > 160) return false;
  if (/\s/.test(model)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(model);
}

function validateRequestedModelSelector(config, requested = {}) {
  const model = clean(requested.model);
  if (!model) return;
  if (findPreset(config, model)) return;
  if (isLikelyRawModelId(model)) return;
  throw new Error(`Invalid model selector "${model}". Use a preset or a model id; free-form text cannot be used as a model.`);
}

function ensureProviderEnabled(config, provider) {
  const providers = { ...(config?.providers || {}) };
  providers[provider] = { ...(providers[provider] || {}), enabled: true };
  return providers;
}

const AUTO_CLEAR_DEFAULT_IDLE_MS = 60 * 60 * 1000;

function normalizeSystemShellConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const command = clean(raw.command ?? raw.path ?? raw.executable ?? raw.shell);
  const envCommand = clean(process.env.MIXDOG_SHELL);
  return {
    command,
    effective: command || envCommand || '',
    source: command ? 'config' : (envCommand ? 'env' : 'auto'),
  };
}

function normalizeSystemShellCommand(value) {
  const command = clean(value).replace(/^auto$/i, '').replace(/^['"](.+)['"]$/, '$1').trim();
  if (!command) return '';
  if (process.platform === 'win32') {
    const stem = command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    if (stem !== 'powershell' && stem !== 'pwsh') {
      throw new Error('system shell command must be powershell.exe or pwsh on Windows');
    }
  }
  return command;
}

function normalizeAutoClearConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const idleMs = Number(raw.idleMs ?? raw.thresholdMs ?? raw.idleMillis);
  const compactType = clean(raw.compactType ?? raw.compact_type ?? raw.type);
  const normalizedCompactType = compactType ? normalizeCompactTypeSetting(compactType, 'semantic') : '';
  return {
    enabled: raw.enabled !== false,
    idleMs: Number.isFinite(idleMs) && idleMs > 0 ? Math.max(60_000, Math.round(idleMs)) : AUTO_CLEAR_DEFAULT_IDLE_MS,
    ...(normalizedCompactType ? { compactType: normalizedCompactType } : {}),
  };
}

function normalizeCompactTypeSetting(value, fallback = 'semantic') {
  const raw = clean(value).toLowerCase().replace(/_/g, '-');
  if (!raw) return fallback;
  if (raw === '1' || raw === 'type1' || raw === 'type-1' || raw === 'semantic' || raw === 'summary' || raw === 'default') return 'semantic';
  if (raw === '2' || raw === 'type2' || raw === 'type-2' || raw === 'recall' || raw === 'recall-fast' || raw === 'recall-fasttrack' || raw === 'recall-fast-track' || raw === 'fasttrack' || raw === 'fast-track') return 'recall-fasttrack';
  return fallback;
}

function normalizeCompactionConfig(value = {}, { memoryEnabled = true } = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  let compactType = normalizeCompactTypeSetting(raw.compactType ?? raw.compact_type ?? raw.type, 'semantic');
  if (compactType === 'recall-fasttrack' && memoryEnabled === false) compactType = 'semantic';
  return {
    ...raw,
    auto: raw.auto !== false && raw.enabled !== false,
    type: compactType,
    compactType,
  };
}

function moduleEnabled(configLike, name, fallback = true) {
  const entry = configLike?.modules?.[name];
  if (entry && typeof entry === 'object' && entry.enabled === false) return false;
  return fallback !== false;
}

function setModuleEnabledInConfig(configLike, name, enabled) {
  const next = { ...(configLike || {}) };
  next.modules = { ...(next.modules || {}) };
  next.modules[name] = {
    ...(next.modules[name] || {}),
    enabled: enabled !== false,
  };
  return next;
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
const LAZY_SECRET_PROVIDERS = new Set(['openai-oauth', 'anthropic-oauth', 'grok-oauth', 'ollama', 'lmstudio']);

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

function openAiModelSupportsHostedWebSearch(model) {
  const id = clean(model?.id || model).toLowerCase();
  if (!id) return false;
  if (model?.supportsWebSearch === true) return true;
  const tools = [
    ...(Array.isArray(model?.supportedTools) ? model.supportedTools : []),
    ...(Array.isArray(model?.tools) ? model.tools : []),
    ...(Array.isArray(model?.capabilities?.tools) ? model.capabilities.tools : []),
  ].map((tool) => clean(tool?.type || tool?.name || tool).toLowerCase());
  if (tools.some((tool) => tool === 'web_search' || tool === 'web_search_preview')) return true;
  if (/codex|image|audio|tts|stt|embedding|rerank|moderation|search-preview/.test(id)) return false;
  return /^gpt-(5(?:\.|$|-)|4\.1(?:-|$)|4o(?:-|$)|4\.5(?:-|$))/.test(id)
    || /^o[34](?:-|$)/.test(id);
}

function grokModelSupportsHostedWebSearch(model) {
  const id = clean(model?.id || model).toLowerCase();
  if (!id || /imagine|image|video|composer/.test(id)) return false;
  if (id === 'grok-build') return false;
  return /^grok-/.test(id);
}

function geminiModelSupportsHostedWebSearch(model) {
  const id = clean(model?.id || model).toLowerCase();
  if (!id || /embedding|aqa|imagen|veo|tts|image|computer-use|customtools/.test(id)) return false;
  return /^gemini-(3(?:\.|-|$)|2\.5-|2\.0-flash)/.test(id);
}

function anthropicModelSupportsHostedWebSearch(model) {
  const id = clean(model?.id || model).toLowerCase();
  if (!id) return false;
  const match = id.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/);
  if (!match) return false;
  const major = Number(match[2]) || 0;
  const minor = Number(match[3]) || 0;
  return major > 4 || (major === 4 && minor >= 0);
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

function searchCapableFor(provider, model) {
  const p = normalizeSearchProviderId(provider);
  if (!isSearchCapableProvider(p)) return false;
  if (p === 'openai' || p === 'openai-oauth') return openAiModelSupportsHostedWebSearch(model);
  if (p === 'grok-oauth' || p === 'xai') return grokModelSupportsHostedWebSearch(model);
  if (p === 'gemini') return geminiModelSupportsHostedWebSearch(model);
  if (p === 'anthropic' || p === 'anthropic-oauth') return anthropicModelSupportsHostedWebSearch(model);
  return model?.supportsWebSearch === true;
}

function fastPreferenceFor(config, provider, model) {
  const key = routeFastKey(provider, model);
  if (!key) return false;
  const saved = config?.modelSettings?.[key];
  if (saved && typeof saved === 'object' && hasOwn(saved, 'fast')) return saved.fast === true;
  return config?.fastModels?.[key] === true;
}

function saveModelSettings(cfgMod, route, { fastCapable = true, baseConfig = null } = {}) {
  const key = routeFastKey(route?.provider, route?.model);
  if (!key) return baseConfig || cfgMod.loadConfig();
  const nextConfig = baseConfig || cfgMod.loadConfig();
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

function writeStatuslineRoute(statusRoutes, session, route) {
  if (!session?.id || !route) return;
  const clientHostPid = session?.clientHostPid || process.pid;
  statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route), { clientHostPid });
}

const ONBOARDING_VERSION = 1;
const WORKFLOW_ROUTE_SLOTS = ['lead', 'agent', 'explorer', 'memory'];
const FIXED_AGENT_SLOTS = Object.freeze([
  { id: 'explore', label: 'Explore', description: 'Broad repository exploration', workflowSlot: 'explorer' },
  { id: 'maintainer', label: 'Maintainer', description: 'Background memory and upkeep', workflowSlot: 'memory' },
  { id: 'worker', label: 'Worker', description: 'Scoped implementation' },
  { id: 'heavy-worker', label: 'Heavy Worker', description: 'Broad or multi-file implementation' },
  { id: 'reviewer', label: 'Reviewer', description: 'Diff review and risk checks' },
  { id: 'debugger', label: 'Debugger', description: 'Root-cause analysis and failure tracing' },
]);
const SEARCH_CAPABLE_PROVIDERS = new Set([
  'openai-oauth',
  'openai',
  'grok-oauth',
  'xai',
  'gemini',
  'anthropic',
  'anthropic-oauth',
]);
const SEARCH_DEFAULT_PROVIDER = 'default';
const SEARCH_DEFAULT_MODEL = 'default';
const SEARCH_PROVIDER_ALIASES = Object.freeze({
  'openai-api': 'openai',
  'xai-api': 'xai',
  'gemini-api': 'gemini',
  'anthropic-api': 'anthropic',
});
const QUICK_SEARCH_MODELS = Object.freeze({
  'openai-oauth': [
    { id: 'gpt-5.5', display: 'GPT-5.5', latest: true, contextWindow: 1000000 },
    { id: 'gpt-5.4', display: 'GPT-5.4', latest: true, contextWindow: 1000000 },
    { id: 'gpt-5', display: 'GPT-5', contextWindow: 400000 },
    { id: 'gpt-4.1', display: 'GPT-4.1', contextWindow: 1000000 },
  ],
  openai: [
    { id: 'gpt-5.5', display: 'GPT-5.5', latest: true, contextWindow: 1000000 },
    { id: 'gpt-5.4', display: 'GPT-5.4', latest: true, contextWindow: 1000000 },
    { id: 'gpt-5', display: 'GPT-5', contextWindow: 400000 },
    { id: 'gpt-4.1', display: 'GPT-4.1', contextWindow: 1000000 },
    { id: 'gpt-4o', display: 'GPT-4o', contextWindow: 128000 },
  ],
  'grok-oauth': [
    { id: 'grok-4.3', display: 'Grok 4.3', latest: true, contextWindow: 1000000 },
    { id: 'grok-4.20', display: 'Grok 4.20', contextWindow: 1000000 },
    { id: 'grok-4', display: 'Grok 4', contextWindow: 256000 },
  ],
  xai: [
    { id: 'grok-4.3', display: 'Grok 4.3', latest: true, contextWindow: 1000000 },
    { id: 'grok-4.20', display: 'Grok 4.20', contextWindow: 1000000 },
    { id: 'grok-4', display: 'Grok 4', contextWindow: 256000 },
  ],
  gemini: [
    { id: 'gemini-3-pro', display: 'Gemini 3 Pro', latest: true, contextWindow: 1000000 },
    { id: 'gemini-2.5-pro', display: 'Gemini 2.5 Pro', contextWindow: 1000000 },
    { id: 'gemini-2.5-flash', display: 'Gemini 2.5 Flash', contextWindow: 1000000 },
    { id: 'gemini-2.0-flash', display: 'Gemini 2.0 Flash', contextWindow: 1000000 },
  ],
  'anthropic-oauth': [
    { id: 'claude-opus-4-8', display: 'Claude Opus 4.8', latest: true, contextWindow: 1000000 },
    { id: 'claude-sonnet-4-6', display: 'Claude Sonnet 4.6', latest: true, contextWindow: 1000000 },
    { id: 'claude-haiku-4-5-20251001', display: 'Claude Haiku 4.5', contextWindow: 200000 },
  ],
  anthropic: [
    { id: 'claude-opus-4-8', display: 'Claude Opus 4.8', latest: true, contextWindow: 1000000 },
    { id: 'claude-sonnet-4-6', display: 'Claude Sonnet 4.6', latest: true, contextWindow: 1000000 },
    { id: 'claude-haiku-4-5-20251001', display: 'Claude Haiku 4.5', contextWindow: 200000 },
  ],
});
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
  const agentsConfigured = Array.isArray(manifest.agents);
  return {
    id,
    name: clean(manifest.name) || id,
    description: clean(manifest.description),
    entry,
    agentsConfigured,
    agents: agentsConfigured ? manifest.agents.map((agent) => normalizeAgentId(agent) || normalizeWorkflowId(agent)).filter(Boolean) : [],
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

function workflowSummary(pack) {
  const id = normalizeWorkflowId(pack?.id, DEFAULT_WORKFLOW_ID);
  return {
    id,
    name: clean(pack?.name) || (id === DEFAULT_WORKFLOW_ID ? 'Default' : id),
    description: clean(pack?.description),
    source: clean(pack?.source),
  };
}

function activeWorkflowSummary(config, dataDir) {
  return workflowSummary(loadWorkflowPack(dataDir, activeWorkflowId(config)));
}

function loadAgentDefinition(dataDir, id) {
  const agentId = normalizeAgentId(id) || normalizeWorkflowId(id);
  if (!agentId) return null;
  const cacheKey = `${dataDir || STANDALONE_DATA_DIR}\n${agentId}`;
  if (agentDefinitionCache.has(cacheKey)) return agentDefinitionCache.get(cacheKey);
  for (const dir of agentSourceDirs(dataDir, agentId)) {
    const manifest = readJsonSafe(join(dir, 'agent.json')) || {};
    const entry = clean(manifest.entry) || 'AGENT.md';
    const doc = readMarkdownDocument(readTextSafe(join(dir, entry)));
    const body = doc.body;
    if (!body) continue;
    const definition = {
      id: agentId,
      name: clean(manifest.name) || FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId)?.label || agentId,
      description: clean(manifest.description) || FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId)?.description || '',
      permission: normalizeAgentPermissionOrNone(doc.frontmatter.permission),
      frontmatter: doc.frontmatter,
      body,
    };
    agentDefinitionCache.set(cacheKey, definition);
    return definition;
  }
  const legacyDoc = readMarkdownDocument(readTextSafe(join(STANDALONE_ROOT, 'agents', `${agentId}.md`)));
  if (!legacyDoc.body) {
    agentDefinitionCache.set(cacheKey, null);
    return null;
  }
  const definition = {
    id: agentId,
    name: FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId)?.label || agentId,
    description: '',
    permission: normalizeAgentPermissionOrNone(legacyDoc.frontmatter.permission),
    frontmatter: legacyDoc.frontmatter,
    body: legacyDoc.body,
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

  const agentIds = pack.agentsConfigured ? pack.agents : FIXED_AGENT_SLOTS.map((agent) => agent.id);
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
  // Defensive: a workflow/agent route must carry a real model id. Reject values
  // that are obviously free-form text (whitespace, prose) so a bad string can
  // never be persisted as a preset/workflow route. Normal model ids pass
  // isLikelyRawModelId unchanged.
  if (!isLikelyRawModelId(model)) return null;
  const effort = normalizeEffortInput(routeLike?.effort ?? fallback.effort);
  const fast = routeLike?.fast ?? fallback.fast;
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(fast === true ? { fast: true } : {}),
  };
}

function normalizeSearchProviderId(provider) {
  const id = clean(provider);
  return SEARCH_PROVIDER_ALIASES[id] || id;
}

function isDefaultSearchRouteConfig(routeLike = {}) {
  return normalizeSearchProviderId(routeLike?.provider) === SEARCH_DEFAULT_PROVIDER
    && clean(routeLike?.model).toLowerCase() === SEARCH_DEFAULT_MODEL;
}

function isSearchCapableProvider(provider) {
  return SEARCH_CAPABLE_PROVIDERS.has(normalizeSearchProviderId(provider));
}

function normalizeSearchRouteConfig(routeLike, fallback = {}) {
  const provider = normalizeSearchProviderId(routeLike?.provider || fallback.provider);
  const model = clean(routeLike?.model || fallback.model);
  if (!provider || !model) return null;
  let effort = null;
  try {
    effort = normalizeEffortInput(routeLike?.effort ?? fallback.effort);
  } catch {
    effort = null;
  }
  const fast = routeLike?.fast ?? fallback.fast;
  const toolType = clean(routeLike?.toolType || fallback.toolType);
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(fast === true ? { fast: true } : {}),
    ...(toolType ? { toolType } : {}),
  };
}

function upsertWorkflowPreset(presets, slot, routeLike) {
  const route = normalizeWorkflowRoute(routeLike);
  if (!route) return presets;
  const id = workflowPresetId(slot);
  const preset = {
    id,
    name: workflowPresetName(slot),
    type: 'agent',
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

function routeFromPreset(config, presetName) {
  const preset = findPreset(config, presetName);
  return preset ? normalizeWorkflowRoute(preset) : null;
}

function agentRouteFromConfig(config, agentId, _dataDir) {
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

  return null;
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

function isEmptyRecallText(value) {
  const text = String(value || '').trim();
  return !text || /^\(?no results\)?$/i.test(text) || /^\(?empty memory result\)?$/i.test(text);
}

function currentSessionRecallRows(session, query, { limit = 10 } = {}) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  if (!messages.length) return '(no results)';
  const terms = [...new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu) || [])]
    .filter(Boolean)
    .slice(0, 16);
  const max = Math.max(1, Math.min(100, Number(limit) || 10));
  const rows = [];
  for (let i = messages.length - 1; i >= 0 && rows.length < max; i -= 1) {
    const m = messages[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool')) continue;
    const text = messageContextText(m).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (terms.length && !terms.some((term) => text.toLowerCase().includes(term))) continue;
    rows.push(`[session:${i + 1}] ${m.role}: ${text.slice(0, 1000)}`);
  }
  return rows.length ? rows.join('\n') : '(no results)';
}

function parseToolSelection(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (value && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') {
    return [...value].map(clean).filter(Boolean);
  }
  return String(value || '').replace(/^select\s*:/i, '')
    .split(/[,\s]+/)
    .map(clean)
    .filter(Boolean);
}

function parseToolSearchQuerySelection(query) {
  const match = clean(query).match(/^select\s*:\s*(.+)$/i);
  return match ? parseToolSelection(match[1]) : [];
}

function toolKind(tool) {
  const name = clean(tool?.name);
  if (name.startsWith('mcp__')) return 'mcp';
  if (name.startsWith('skill:') || tool?.annotations?.mixdogKind === 'skill') return 'skill';
  if (name === 'Skill' || name.startsWith('skill_') || name === 'skills_list' || name === 'skill_view') return 'skill';
  if (tool?.annotations?.agentHidden) return 'control';
  if (['apply_patch', 'shell'].includes(name)) return 'mutation';
  return 'tool';
}

function toolSchemaBucket(tool) {
  const name = clean(tool?.name);
  const kind = toolKind(tool);
  if (kind === 'mcp') return 'mcp';
  if (kind === 'skill') return 'skills';
  if (name === 'memory' || name === 'recall' || name.includes('memory')) return 'memory';
  if (name === 'search' || name === 'web_fetch') return 'web';
  if (['read', 'grep', 'find', 'glob', 'list', 'code_graph', 'explore'].includes(name)) return 'code';
  if (['shell', 'apply_patch'].includes(name)) return 'mutation';
  if (name === 'agent' || name === 'delegate') return 'agents';
  if (name.includes('channel') || name.includes('discord') || name.includes('webhook')) return 'channels';
  if (name.includes('provider') || name === 'tool_search' || name === 'cwd') return 'setup';
  return 'other';
}

function estimateToolSchemaBreakdown(tools) {
  const out = {};
  for (const tool of Array.isArray(tools) ? tools : []) {
    const bucket = toolSchemaBucket(tool);
    const row = out[bucket] || { count: 0, tokens: 0 };
    row.count += 1;
    row.tokens += estimateToolSchemaTokens([tool]);
    out[bucket] = row;
  }
  return out;
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

function deferredProviderMode(provider) {
  const p = clean(provider).toLowerCase();
  if (p === 'gemini') return 'full';
  if (p === 'anthropic' || p === 'anthropic-oauth'
    || p === 'openai' || p === 'openai-oauth'
    || p === 'xai' || p === 'grok-oauth') {
    return 'native';
  }
  return 'legacy';
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
  const available = new Set((catalog || []).map((tool) => clean(tool?.name)).filter(Boolean));
  if (mode === 'lead') {
    return new Set(DEFERRED_DEFAULT_LEAD_TOOLS.filter((name) => available.has(name)));
  }
  if (mode === 'readonly') {
    return new Set(DEFERRED_DEFAULT_READONLY_TOOLS.filter((name) => available.has(name)));
  }
  return new Set(DEFERRED_DEFAULT_FULL_TOOLS.filter((name) => available.has(name)));
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

function providerSupportsResponsesCustomTools(provider) {
  const p = clean(provider).toLowerCase();
  if (!p) return true;
  return p === 'openai' || p === 'openai-oauth';
}

function openAILoadableToolSpec(tool, provider = '') {
  if (providerSupportsResponsesCustomTools(provider) && isResponsesFreeformTool(tool)) return toResponsesCustomTool(tool);
  return {
    type: 'function',
    name: clean(tool?.name),
    description: clean(tool?.description),
    defer_loading: true,
    parameters: tool?.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} },
  };
}

function toolSearchNativePayload(catalog, names, provider = '') {
  const selected = new Set((names || []).map(clean).filter(Boolean));
  if (!selected.size) return null;
  const tools = [];
  const refs = [];
  for (const tool of catalog || []) {
    const name = clean(tool?.name);
    if (!name || !selected.has(name)) continue;
    refs.push(name);
    tools.push(openAILoadableToolSpec(tool, provider));
  }
  if (!refs.length) return null;
  return {
    toolReferences: refs,
    openaiTools: tools,
    summary: `Loaded deferred tools: ${refs.join(', ')}`,
  };
}

function toolSearchTokens(value) {
  return (clean(value).toLowerCase().match(/[a-z0-9_.-]+/g) || [])
    .map((token) => token.replace(/[-.]+/g, '_'))
    .filter(Boolean);
}

function toolSearchMeaningfulTokens(value) {
  return toolSearchTokens(value).filter((token) => !TOOL_SEARCH_STOP_WORDS.has(token));
}

function toolSearchText(row) {
  const text = `${row.name} ${String(row.name || '').replace(/_/g, ' ')} ${row.kind} ${row.description} ${row.active ? 'active' : 'deferred'}`;
  return `${text} ${text.replace(/[-.]+/g, '_')}`.toLowerCase();
}

function toolSearchRowAliases(name) {
  return TOOL_SEARCH_ROW_ALIASES[clean(name)] || [];
}

function toolSearchRank(row, query) {
  const raw = clean(query).toLowerCase();
  if (!raw) return { score: 0, reasons: [] };
  const name = clean(row?.name).toLowerCase();
  const prettyName = name.replace(/_/g, ' ');
  const haystack = toolSearchText(row);
  const aliases = toolSearchRowAliases(name);
  const aliasText = aliases.join(' ').toLowerCase();
  const queryTokens = toolSearchMeaningfulTokens(raw);
  const nameTokens = new Set(toolSearchTokens(`${name} ${prettyName}`));
  const aliasTokens = new Set(toolSearchTokens(aliasText));
  let score = 0;
  const reasons = [];
  if (raw === name || raw === prettyName) {
    score += 120;
    reasons.push('exact-name');
  }
  if (aliases.some((alias) => raw === alias || raw === alias.replace(/[_-]+/g, ' '))) {
    score += 100;
    reasons.push('exact-alias');
  }
  if (haystack.includes(raw)) {
    score += 34;
    reasons.push('phrase');
  }
  for (const alias of aliases) {
    const normalizedAlias = alias.toLowerCase();
    if (normalizedAlias && raw.includes(normalizedAlias)) {
      score += 58;
      reasons.push('alias-phrase');
      break;
    }
  }
  let matchedTokens = 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token) || name.includes(token)) {
      score += 24;
      matchedTokens += 1;
      continue;
    }
    if (aliasTokens.has(token) || aliasText.includes(token)) {
      score += 18;
      matchedTokens += 1;
      continue;
    }
    if (haystack.includes(token)) {
      score += 7;
      matchedTokens += 1;
    }
  }
  if (queryTokens.length && matchedTokens === queryTokens.length) {
    score += Math.min(18, queryTokens.length * 6);
    reasons.push('all-tokens');
  }
  if (clean(row?.kind).toLowerCase() === raw) score += 10;
  if (score > 0) score += Math.min(6, Math.floor(measuredToolUsage(name) / 150));
  return { score, reasons };
}

function toolSearchMatches(row, query) {
  const raw = clean(query).toLowerCase();
  if (!raw) return true;
  return toolSearchRank(row, raw).score > 0;
}

function rankedToolSearchRows(rows, query) {
  const raw = clean(query).toLowerCase();
  if (!raw) return rows;
  return rows
    .map((row) => {
      const ranked = toolSearchRank(row, raw);
      return { ...row, score: ranked.score, reasons: ranked.reasons };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.active !== b.active) return a.active ? 1 : -1;
      if (b.usage !== a.usage) return b.usage - a.usage;
      return String(a.name).localeCompare(String(b.name));
    });
}

function queryHasAnyPhrase(query, phrases) {
  const text = clean(query).toLowerCase().replace(/[_-]+/g, ' ');
  return phrases.some((phrase) => text.includes(phrase));
}

function autoToolSelectionNames(query, rows) {
  const raw = clean(query).toLowerCase();
  if (!raw || TOOL_SEARCH_AMBIGUOUS_AUTO_QUERIES.has(raw)) return [];
  if (TOOL_SEARCH_SAFE_AUTO_ALIASES.has(raw) && DEFERRED_SELECT_ALIASES[raw]) {
    return DEFERRED_SELECT_ALIASES[raw];
  }
  if (queryHasAnyPhrase(raw, ['save memory', 'store memory', 'delete memory', 'forget memory', 'memory status', '기억 저장', '메모리 저장'])) {
    return ['memory'];
  }
  if (queryHasAnyPhrase(raw, ['run', 'execute', 'test', 'tests', 'build', 'terminal', 'command', 'powershell', 'bash', 'shell', 'npm', 'node', 'git', '실행', '테스트', '빌드', '터미널', '쉘'])) {
    return ['shell', 'task'];
  }
  if (queryHasAnyPhrase(raw, ['web', 'internet', 'online', 'current info', 'latest', 'news', 'browse', 'docs', 'documentation', '웹', '인터넷', '최신', '뉴스', '문서'])) {
    return ['search', 'web_fetch'];
  }
  if (queryHasAnyPhrase(raw, ['recall', 'remember', 'memory previous', 'previous', 'history', 'past', 'prior', 'earlier', 'resume', '이전', '기억', '히스토리'])) {
    return ['recall'];
  }
  if (queryHasAnyPhrase(raw, ['delegate', 'subagent', 'worker', 'parallel agent', 'background agent', 'reviewer', 'explorer', '에이전트', '워커', '병렬'])) {
    return ['agent'];
  }
  if (queryHasAnyPhrase(raw, ['working directory', 'project root', 'current directory', 'cwd'])) {
    return ['cwd'];
  }
  const ranked = rankedToolSearchRows(rows, raw);
  const top = ranked[0];
  if (!top) return [];
  const reasons = new Set(top.reasons || []);
  if (reasons.has('exact-name') || reasons.has('exact-alias')) return [top.name];
  return [];
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

function storedDeferredToolNames(session) {
  for (const source of [session?.deferredDiscoveredTools, session?.deferredSelectedTools]) {
    const names = parseToolSelection(source);
    if (names.length) return names;
  }
  return [];
}

function canonicalDeferredToolNames(catalog, names) {
  const byName = new Map();
  for (const tool of catalog || []) {
    const name = clean(tool?.name);
    if (!name) continue;
    byName.set(name, name);
    byName.set(name.toLowerCase(), name);
  }
  const out = [];
  for (const raw of expandSelectionNames(names)) {
    const name = clean(raw);
    const canonical = byName.get(name) || byName.get(name.toLowerCase());
    if (canonical) out.push(canonical);
  }
  return sortedNamesByMeasuredUsage(new Set(out));
}

function setDeferredToolState(session, names) {
  if (!session) return [];
  const selected = sortedNamesByMeasuredUsage(new Set(parseToolSelection(names)));
  session.deferredDiscoveredTools = selected;
  session.deferredSelectedTools = selected;
  return selected;
}

function isReadonlySelectable(tool) {
  const name = clean(tool?.name);
  if (READONLY_TOOL_NAMES.has(name)) return true;
  const annotations = tool?.annotations || {};
  if (annotations.destructiveHint === true) return false;
  if (annotations.readOnlyHint === true) return true;
  return false;
}

function applyDeferredToolSurface(session, mode, extraTools = [], options = {}) {
  if (!session || !Array.isArray(session.tools)) return session;
  const providerMode = deferredProviderMode(options.provider || session.provider);
  const byName = new Map();
  for (const tool of [...session.tools, ...(extraTools || [])]) {
    const name = clean(tool?.name);
    if (!name || byName.has(name)) continue;
    byName.set(name, activeToolForSurface(tool));
  }
  const catalog = sortedCatalogByMeasuredUsage([...byName.values()]);
  const defaultNames = defaultDeferredToolNames(catalog, mode);
  const storedNames = providerMode === 'native' ? [] : storedDeferredToolNames(session);
  let selectedNames = providerMode === 'full'
    ? sortedNamesByMeasuredUsage(catalog.map((tool) => clean(tool?.name)).filter(Boolean))
    : [];
  if (providerMode !== 'full') {
    selectedNames = storedNames.length ? canonicalDeferredToolNames(catalog, storedNames) : [];
    if (!selectedNames.length || providerMode === 'native') selectedNames = sortedNamesByMeasuredUsage(defaultNames);
  }
  const selected = new Set(selectedNames);
  session.deferredToolCatalog = catalog;
  session.deferredToolUsage = MEASURED_TOOL_USAGE;
  session.deferredDefaultTools = sortedNamesByMeasuredUsage(defaultNames);
  session.deferredProviderMode = providerMode;
  session.deferredNativeTools = providerMode === 'native';
  session.tools.length = 0;
  const active = [];
  for (const tool of catalog) {
    if (!selected.has(clean(tool?.name))) continue;
    if (mode === 'readonly' && !isReadonlySelectable(tool)) continue;
    session.tools.push(tool);
    active.push(clean(tool?.name));
  }
  if (providerMode === 'native') {
    const discovered = canonicalDeferredToolNames(catalog, session.deferredDiscoveredTools || []);
    session.deferredSelectedTools = active;
    session.deferredDiscoveredTools = discovered.filter((name) => !selected.has(name));
  } else {
    setDeferredToolState(session, active);
  }
  return session;
}

function selectDeferredTools(session, names, mode) {
  const catalog = Array.isArray(session?.deferredToolCatalog)
    ? session.deferredToolCatalog
    : (Array.isArray(session?.tools) ? session.tools : []);
  const active = new Set((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const native = session?.deferredProviderMode === 'native' || session?.deferredNativeTools === true;
  const discovered = new Set(Array.isArray(session?.deferredDiscoveredTools) ? session.deferredDiscoveredTools : []);
  const byName = new Map();
  for (const tool of catalog) {
    const name = clean(tool?.name);
    if (!name) continue;
    byName.set(name, tool);
    byName.set(name.toLowerCase(), tool);
  }
  const added = [];
  const already = [];
  const blocked = [];
  const missing = [];
  for (const rawName of expandSelectionNames(names)) {
    const requestedName = clean(rawName);
    const tool = byName.get(requestedName) || byName.get(requestedName.toLowerCase());
    const name = clean(tool?.name);
    if (!tool) {
      missing.push(requestedName);
      continue;
    }
    if (mode === 'readonly' && !isReadonlySelectable(tool)) {
      blocked.push({ name, reason: 'readonly mode' });
      continue;
    }
    if (active.has(name) || discovered.has(name)) {
      already.push(name);
      continue;
    }
    if (native) {
      discovered.add(name);
    } else {
      session.tools.push(tool);
      active.add(name);
    }
    added.push(name);
  }
  if (native) {
    session.deferredDiscoveredTools = sortedNamesByMeasuredUsage(discovered);
    session.deferredSelectedTools = sortedNamesByMeasuredUsage(active);
  } else {
    setDeferredToolState(session, active);
  }
  return { added, already, blocked, missing, native };
}

function renderToolSearch(args = {}, session, mode = 'full') {
  const catalog = Array.isArray(session?.deferredToolCatalog)
    ? session.deferredToolCatalog
    : (Array.isArray(session?.tools) ? session.tools : []);
  const rawQuery = clean(args.query);
  const explicitSelectedNames = parseToolSelection(args.select);
  const querySelectedNames = explicitSelectedNames.length ? [] : parseToolSearchQuerySelection(rawQuery);
  const forcedSelectedNames = explicitSelectedNames.length ? explicitSelectedNames : querySelectedNames;
  const query = querySelectedNames.length ? '' : rawQuery.toLowerCase();
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  const initialActiveNames = new Set((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const initialRows = catalog.map((tool) => toolRow(tool, initialActiveNames)).filter((row) => row.name);
  const autoSelectedNames = (!forcedSelectedNames.length && query)
    ? autoToolSelectionNames(query, initialRows)
    : [];
  const selectedNames = forcedSelectedNames.length ? forcedSelectedNames : autoSelectedNames;
  const toolSelection = selectedNames.length ? selectDeferredTools(session, selectedNames, mode) : null;
  const selectionMode = forcedSelectedNames.length ? 'select' : (autoSelectedNames.length ? 'auto' : null);
  const nextActiveNames = new Set((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const rows = [
    ...catalog.map((tool) => toolRow(tool, nextActiveNames)),
  ].filter((row) => row.name);
  const matches = query
    ? rankedToolSearchRows(rows, query)
    : rows;
  const selected = toolSelection
    ? {
        mode: selectionMode,
        tools: toolSelection,
      }
    : null;
  const nativeToolSearch = toolSelection?.native
    ? toolSearchNativePayload(catalog, toolSelection.added, session?.provider)
    : null;
  return JSON.stringify({
    selected,
    ...(nativeToolSearch ? { nativeToolSearch } : {}),
    totalMatches: matches.length,
    matches: matches.slice(0, limit),
    activeTools: sortedNamesByMeasuredUsage(nextActiveNames),
    discoveredTools: sortedNamesByMeasuredUsage(session?.deferredDiscoveredTools || []),
    note: 'query ranks matches and auto-loads high-confidence deferred tools; select exact tool names, or query select:a,b, to force load.',
  }, null, 2);
}

export function __renderToolSearchForTest(args = {}, session = {}, mode = 'full') {
  return renderToolSearch(args, session, mode);
}

export function __saveModelSettingsForTest(cfgMod, route, options = {}) {
  return saveModelSettings(cfgMod, route, options);
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
  const pluginDataDir = cfgMod.getPluginData();
  const memoryRuntime = createStandaloneMemoryRuntime({
    entry: join(STANDALONE_ROOT, MEMORY_RUNTIME.replace(/^\.\//, '')),
    dataDir: pluginDataDir,
    cwd,
  });
  let memoryModPromise = null;
  let searchModPromise = null;
  let codeGraphModPromise = null;
  let outputStyleStatusCache = null;
  let outputStyleStatusCacheAt = 0;
  let outputStyleStatusCacheDir = '';

  const memoryEnabled = () => moduleEnabled(config, 'memory', true);
  const channelsEnabled = () => moduleEnabled(config, 'channels', true);
  const getOutputStyleStatusCached = ({ fresh = false } = {}) => {
    const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
    const cacheDir = resolve(dataDir);
    const now = performance.now();
    if (
      !fresh
      && outputStyleStatusCache
      && outputStyleStatusCacheDir === cacheDir
      && now - outputStyleStatusCacheAt < 2500
    ) {
      return outputStyleStatusCache;
    }
    outputStyleStatusCache = outputStyleStatus(dataDir);
    outputStyleStatusCacheAt = now;
    outputStyleStatusCacheDir = cacheDir;
    return outputStyleStatusCache;
  };
  const invalidateOutputStyleStatusCache = () => {
    outputStyleStatusCache = null;
    outputStyleStatusCacheAt = 0;
    outputStyleStatusCacheDir = '';
  };

  async function getMemoryModule() {
    if (!memoryEnabled()) throw new Error('memory is disabled in settings');
    const startedAt = performance.now();
    memoryModPromise ??= Promise.resolve(memoryRuntime);
    const mod = await memoryModPromise;
    if (typeof mod?.init === 'function') {
      await mod.init();
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

  function normalizeSearchAllowedDomain(site) {
    const raw = clean(site);
    if (!raw) return '';
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch {
      return raw.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    }
  }

  function nativeSearchUserLocation(locale) {
    if (!locale || typeof locale !== 'object' || Array.isArray(locale)) return null;
    const location = { type: 'approximate' };
    for (const key of ['country', 'region', 'city', 'timezone']) {
      const value = clean(locale[key]);
      if (value) location[key] = value;
    }
    return Object.keys(location).length > 1 ? location : null;
  }

  function nativeSearchTool(args = {}, toolType = 'web_search', providerId = '') {
    const providerName = normalizeSearchProviderId(providerId);
    const domain = normalizeSearchAllowedDomain(args.site);
    const type = clean(toolType) || 'web_search';
    const location = nativeSearchUserLocation(args.locale);
    if (providerName === 'gemini') {
      return { type: type || 'google_search' };
    }
    if (providerName === 'anthropic' || providerName === 'anthropic-oauth') {
      const tool = {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: Math.max(1, Math.min(10, Number(args.maxResults) || 5)),
      };
      if (domain) tool.allowed_domains = [domain];
      if (location) tool.user_location = location;
      return tool;
    }
    if (providerName === 'grok-oauth' || providerName === 'xai') {
      const tool = { type };
      if (domain) tool.filters = { allowed_domains: [domain] };
      return tool;
    }
    const tool = {
      type,
    };
    if (type === 'web_search') {
      tool.search_context_size = clean(args.contextSize) || 'low';
      if (domain) tool.filters = { allowed_domains: [domain] };
      if (location) tool.user_location = location;
    }
    return tool;
  }

  function nativeSearchToolTypes(routeLike = {}) {
    const envToolType = clean(process.env.MIXDOG_NATIVE_SEARCH_TOOL_TYPE);
    if (envToolType) return [envToolType];
    const configured = clean(routeLike.toolType);
    if (configured) return [configured];
    const providerName = normalizeSearchProviderId(routeLike.provider);
    if (providerName === 'gemini') return ['google_search'];
    if (providerName === 'anthropic' || providerName === 'anthropic-oauth') return ['web_search'];
    if (providerName === 'grok-oauth' || providerName === 'xai') return ['web_search'];
    return ['web_search', 'web_search_preview'];
  }

  function currentMainSearchModelMeta() {
    if (!route?.provider || !route?.model) return null;
    return { ...route, id: route.model, display: route.model, name: route.model };
  }

  function nativeSearchRoutes() {
    const cfg = ensureFullConfig();
    searchRoute = normalizeSearchRouteConfig(cfg.searchRoute) || normalizeSearchRouteConfig(searchRoute);
    if (!searchRoute) return [];
    if (isDefaultSearchRouteConfig(searchRoute)) {
      const mainModel = currentMainSearchModelMeta();
      if (!mainModel || !searchCapableFor(route.provider, mainModel)) return [];
      return [{
        key: `default\n${route.provider}\n${route.model}`,
        provider: normalizeSearchProviderId(route.provider),
        model: route.model,
        source: 'default-search-route',
        effort: route.effectiveEffort || route.effort || null,
        fast: route.fast === true,
        toolType: searchRoute.toolType || null,
      }];
    }
    const providerName = normalizeSearchProviderId(searchRoute.provider);
    if (!isSearchCapableProvider(providerName)) return [];
    return [{
      key: `${providerName}\n${searchRoute.model}`,
      provider: providerName,
      model: searchRoute.model,
      source: 'search-route',
      effort: searchRoute.effort || null,
      fast: searchRoute.fast === true,
      toolType: searchRoute.toolType || null,
    }];
  }

  function nativeSearchMessages(searchArgs = {}) {
    const prompt = searchArgs.prompt || '';
    return [
      {
        role: 'system',
        content: [
          'You are Mixdog native web search.',
          'Use the hosted web_search tool for current or external facts.',
          'Answer concisely, cite source URLs, and do not request local tools or file edits.',
        ].join('\n'),
      },
      { role: 'user', content: prompt },
    ];
  }

  function flattenNativeSearchSources(result = {}) {
    const out = [];
    const add = (source, fallbackTitle = '') => {
      if (!source || typeof source !== 'object') return;
      const url = clean(source.url || source.uri || source.href || source.source_url);
      if (!url) return;
      out.push({
        title: clean(source.title || source.query || source.name || fallbackTitle || url),
        url,
        snippet: clean(source.snippet || source.text || source.description),
        source: source.source || 'native-web-search',
        provider: source.provider || 'native-web-search',
      });
    };
    for (const citation of Array.isArray(result.citations) ? result.citations : []) add(citation);
    for (const call of Array.isArray(result.webSearchCalls) ? result.webSearchCalls : []) {
      const action = call?.action || {};
      for (const source of Array.isArray(action.sources) ? action.sources : []) add(source, action.query || '');
      if (action.url) add({ url: action.url, title: action.query || '' });
      for (const url of Array.isArray(action.urls) ? action.urls : []) add({ url, title: action.query || '' });
    }
    const seen = new Set();
    return out.filter((item) => {
      const key = item.url || `${item.title}\n${item.snippet}`;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function runNativeWebSearch(searchArgs = {}, { signal } = {}) {
    const candidates = nativeSearchRoutes();
    if (!candidates.length) {
      if (isDefaultSearchRouteConfig(searchRoute)) {
        throw new Error(`default search route requires the current main model to support native web search (${route?.provider || 'unknown'}/${route?.model || 'unknown'})`);
      }
      throw new Error('search route is not configured; open /search to choose a search provider/model');
    }
    const errors = [];
    for (const candidate of candidates) {
      for (const toolType of nativeSearchToolTypes(candidate)) {
        try {
          await ensureProvidersReady(ensureProviderEnabled(config, candidate.provider));
          const providerImpl = reg.getProvider(candidate.provider);
          if (!providerImpl || typeof providerImpl.send !== 'function') {
            throw new Error(`provider "${candidate.provider}" is not ready`);
          }
          const model = candidate.model;
          const searchTool = nativeSearchTool(searchArgs, toolType, candidate.provider);
          const startedAt = Date.now();
          const result = await providerImpl.send(
            nativeSearchMessages(searchArgs),
            model,
            undefined,
            {
              signal,
              role: 'web-search',
              sessionId: `${session?.id || 'search'}:native-search:${Date.now().toString(36)}`,
              sourceType: 'native-search',
              sourceName: 'search',
              nativeTools: [searchTool],
              nativeInclude: candidate.provider === 'openai' || candidate.provider === 'openai-oauth'
                ? ['web_search_call.action.sources']
                : [],
              toolChoice: candidate.provider === 'gemini' ? 'auto' : 'required',
              ...(candidate.effort ? { effort: candidate.effort } : {}),
              fast: candidate.fast === true,
              onStageChange: () => {},
              onStreamDelta: () => {},
            },
          );
          const sources = flattenNativeSearchSources(result);
          return {
            content: String(result?.content || '').trim(),
            provider: candidate.provider,
            model: result?.model || candidate.model || null,
            usage: result?.usage || null,
            citations: sources,
            webSearchCalls: result?.webSearchCalls || [],
            durationMs: Date.now() - startedAt,
          };
        } catch (err) {
          errors.push(`${candidate.provider}${candidate.model ? `/${candidate.model}` : ''}/${toolType}: ${err?.message || String(err)}`);
        }
      }
    }
    throw new Error(`native web search failed: ${errors.join(' | ')}`);
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

    saveConfigAndAdopt(nextConfig);
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
    if (!memoryEnabled()) {
      bootProfile('core-memory:disabled');
      return '';
    }
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
  setConfiguredShell(normalizeSystemShellConfig(config.shell).command);
  let configHasSecrets = false;
  let route = resolveRoute(config, { provider, model });
  let searchRoute = normalizeSearchRouteConfig(config.searchRoute);
  bootProfile('config:ready', { ms: (performance.now() - configStartedAt).toFixed(1) });
  let mode = normalizeToolMode(toolMode);
  let session = null;
  let sessionCreatePromise = null;
  let currentCwd = cwd;
  let sessionNeedsCwdRefresh = false;
  let closeRequested = false;
  let channelStartTimer = null;
  let providerSetupWarmupTimer = null;
  let providerWarmupTimer = null;
  let providerModelWarmupTimer = null;
  let codeGraphPrewarmTimer = null;
  let codeGraphPrewarmInFlight = false;
  let codeGraphPrewarmQueuedCwd = '';
  let statuslineUsageWarmupTimer = null;
  let statuslineUsageRefreshTimer = null;
  let activeTurnCount = 0;
  let firstTurnCompleted = false;
  function hookTranscriptPath(sessionId) {
    const id = clean(sessionId);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
    return join(dataDir, 'sessions', `${id}.json`);
  }
  function hookEffortPayload() {
    const level = clean(route.effectiveEffort || route.effort);
    return level ? { level: level.toLowerCase() } : undefined;
  }
  function hookCommonPayload(extra = {}) {
    const sid = clean(extra.session_id || extra.sessionId || session?.id);
    return {
      ...(sid ? { session_id: sid, transcript_path: hookTranscriptPath(sid) } : {}),
      cwd: currentCwd,
      permission_mode: session?.permissionMode || 'default',
      ...(hookEffortPayload() ? { effort: hookEffortPayload() } : {}),
      ...extra,
    };
  }
  const sessionPrewarmDelayMs = envDelayMs('MIXDOG_SESSION_PREWARM_DELAY_MS', 50, { min: 0, max: 10_000 });
  const providerSetupWarmupDelayMs = envDelayMs('MIXDOG_PROVIDER_SETUP_WARMUP_DELAY_MS', 300, { min: 0, max: 60_000 });
  const providerWarmupDelayMs = envDelayMs('MIXDOG_PROVIDER_WARMUP_DELAY_MS', 1_500, { min: 0, max: 60_000 });
  // Background model-catalog prefetch delay. Kept short so the first `/model`
  // open finds a warm cache instead of paying a cold full network load. The
  // work is async + unref'd, so short-lived detached runtimes still exit
  // cleanly without waiting on it. Operators can raise it via env if a
  // detached runtime must avoid the /models round-trip entirely.
  const providerModelWarmupDelayMs = envDelayMs('MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS', 2_000, { min: 0, max: 120_000 });
  const codeGraphPrewarmDelayMs = envDelayMs('MIXDOG_CODE_GRAPH_PREWARM_DELAY_MS', 250, { min: 0, max: 60_000 });
  const statuslineUsageWarmupDelayMs = envDelayMs('MIXDOG_STATUSLINE_USAGE_WARMUP_DELAY_MS', 800, { min: 0, max: 60_000 });
  // Idle keep-alive: re-fetch usage before the statusline's 10-min staleness cut
  // (LIVE_USAGE_SNAPSHOT_MAX_AGE_MS) so the usage segment does not disappear
  // while the session sits idle with no turns to trigger a refresh.
  const statuslineUsageRefreshDelayMs = envDelayMs('MIXDOG_STATUSLINE_USAGE_REFRESH_MS', 240_000, { min: 30_000, max: 540_000 });
  const channelStartDelayMs = envDelayMs('MIXDOG_CHANNEL_START_DELAY_MS', 10_000, { min: 0, max: 120_000 });
  const backgroundBusyRetryMs = envDelayMs('MIXDOG_BACKGROUND_BUSY_RETRY_MS', 1_000, { min: 50, max: 10_000 });
  const sessionPrewarmEnabled = !envFlag('MIXDOG_DISABLE_SESSION_PREWARM')
    && (envFlag('MIXDOG_ENABLE_SESSION_PREWARM') || envPresent('MIXDOG_SESSION_PREWARM_DELAY_MS'));
  const providerWarmupEnabled = !envFlag('MIXDOG_DISABLE_PROVIDER_WARMUP')
    && (
      envFlag('MIXDOG_ENABLE_PROVIDER_WARMUP')
      || envFlag('MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN')
      || envPresent('MIXDOG_PROVIDER_WARMUP_DELAY_MS')
      || envPresent('MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS')
    );
  // Boot-time model-catalog prefetch is intentionally decoupled from the
  // heavier providerWarmupEnabled gate (which stays opt-in for provider
  // *init* side effects). Fetching the model list in the background after a
  // short delay is cheap, fire-and-forget, and unref'd, so it is ON by
  // default — otherwise the FIRST `/model` open always paid a cold full
  // network load. Operators can still disable it explicitly.
  const modelPrefetchEnabled = !envFlag('MIXDOG_DISABLE_PROVIDER_WARMUP')
    && !envFlag('MIXDOG_DISABLE_MODEL_PREFETCH');
  const codeGraphPrewarmEnabled = !envFlag('MIXDOG_DISABLE_CODE_GRAPH_PREWARM');
  // Lazy code-graph prewarm (default ON): do NOT prewarm at startup / on cwd
  // change — that fired ~250ms after the first frame and, in a large tree,
  // burned a worker (and felt like a freeze) before the user did anything.
  // Instead prewarm ONCE on the first real turn, when a code lookup is actually
  // imminent. Operators who want the old eager behavior can set
  // MIXDOG_CODE_GRAPH_PREWARM_EAGER=1.
  const codeGraphPrewarmLazy = codeGraphPrewarmEnabled && !envFlag('MIXDOG_CODE_GRAPH_PREWARM_EAGER');
  let codeGraphFirstTurnPrewarmDone = false;
  const modelMetaByRoute = new Map();
  const notificationListeners = new Set();
  let providerModelsCache = { models: null, at: 0 };
  let providerModelsPromise = null;
  let searchProviderModelsCache = { models: null, at: 0 };
  let searchProviderModelsPromise = null;
  let usageDashboardCache = { dashboard: null, at: 0 };
  let usageDashboardPromise = null;
  let providerSetupCache = { setup: null, at: 0 };
  let providerSetupQuickCache = { setup: null, at: 0 };
  let providerSetupPromise = null;
  let providerInitPromise = null;
  let mcpFailures = [];
  let preSessionToolSurface = null;
  let contextStatusCacheKey = null;
  let contextStatusCacheValue = null;
  const hooksStartedAt = performance.now();
  const hooks = createStandaloneHookBus({ dataDir: cfgMod.getPluginData() });
  hooks.emit('runtime:start', { cwd: currentCwd, provider: route.provider, model: route.model, toolMode: mode });
  bootProfile('hooks:ready', { ms: (performance.now() - hooksStartedAt).toFixed(1) });

  function mcpTransportLabel(cfg = {}) {
    if (cfg.autoDetect) return `autoDetect:${cfg.autoDetect}`;
    if (cfg.transport === 'http' || cfg.url) return 'http';
    if (cfg.command) return 'stdio';
    return 'unknown';
  }

  function emitRuntimeNotification(content, meta = {}) {
    const text = String(content || '').trim();
    if (!text) return false;
    const event = { content: text, meta: meta && typeof meta === 'object' ? meta : {} };
    let handled = false;
    for (const listener of [...notificationListeners]) {
      try {
        if (listener(event) === true) handled = true;
      } catch {}
    }
    return handled;
  }

  function notifyFnForSession(callerSessionId) {
    return (text, meta = {}) => {
      const handledByRuntimeListener = emitRuntimeNotification(text, meta);
      let enqueued = false;
      // TUI sessions consume raw execution notifications for UI/task cards via
      // onNotification, but those raw envelopes are internal-only in pending
      // drain. Always mirror terminal completions with a model-visible wrapper
      // while keeping the raw text for UI display.
      if (callerSessionId && typeof mgr.enqueuePendingMessage === 'function'
        && shouldPersistModelVisibleToolCompletion(text, meta)) {
        try {
          const visible = modelVisibleToolCompletionMessage(text, meta);
          if (visible) enqueued = mgr.enqueuePendingMessage(callerSessionId, visible) > 0;
        } catch {}
      }
      // Headless/API listeners may exist but not consume the event; preserve
      // the old fallback for non-terminal notifications only when unhandled.
      if (!enqueued && !handledByRuntimeListener && callerSessionId
        && typeof mgr.enqueuePendingMessage === 'function') {
        try {
          const visible = modelVisibleToolCompletionMessage(text, meta);
          if (visible) enqueued = mgr.enqueuePendingMessage(callerSessionId, visible) > 0;
        } catch {}
      }
      return enqueued || handledByRuntimeListener;
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

  function scheduleCodeGraphPrewarm(delayMs = codeGraphPrewarmDelayMs, reason = 'cwd') {
    if (!codeGraphPrewarmEnabled) {
      bootProfile('code-graph:prewarm-skipped', { reason: 'disabled' });
      return;
    }
    if (closeRequested) return;
    codeGraphPrewarmQueuedCwd = currentCwd;
    if (codeGraphPrewarmTimer) return;
    codeGraphPrewarmTimer = setTimeout(() => {
      codeGraphPrewarmTimer = null;
      if (closeRequested) return;
      if (activeTurnCount > 0 || sessionCreatePromise) {
        bootProfile('code-graph:prewarm-deferred', { reason: activeTurnCount > 0 ? 'turn-active' : 'session-create' });
        scheduleCodeGraphPrewarm(backgroundBusyRetryMs, 'busy');
        return;
      }
      if (codeGraphPrewarmInFlight) {
        bootProfile('code-graph:prewarm-deferred', { reason: 'in-flight' });
        scheduleCodeGraphPrewarm(backgroundBusyRetryMs, 'in-flight');
        return;
      }
      const prewarmCwd = codeGraphPrewarmQueuedCwd || currentCwd;
      codeGraphPrewarmQueuedCwd = '';
      codeGraphPrewarmInFlight = true;
      const startedAt = performance.now();
      bootProfile('code-graph:prewarm:start', { cwd: prewarmCwd, reason });
      void getCodeGraphModule()
        .then((mod) => {
          if (typeof mod?.prewarmCodeGraphIfProject !== 'function') return false;
          return mod.prewarmCodeGraphIfProject(prewarmCwd);
        })
        .then((scheduled) => bootProfile(scheduled ? 'code-graph:prewarm:scheduled' : 'code-graph:prewarm:no-project', {
          cwd: prewarmCwd,
          ms: (performance.now() - startedAt).toFixed(1),
        }))
        .catch((error) => bootProfile('code-graph:prewarm:failed', {
          cwd: prewarmCwd,
          ms: (performance.now() - startedAt).toFixed(1),
          error: error?.message || String(error),
        }))
        .finally(() => {
          codeGraphPrewarmInFlight = false;
          if (codeGraphPrewarmQueuedCwd && !closeRequested) {
            scheduleCodeGraphPrewarm(backgroundBusyRetryMs, 'queued');
          }
        });
    }, delayMs);
    codeGraphPrewarmTimer.unref?.();
  }

  function applyResolvedCwd(nextCwd, { markRefresh = true } = {}) {
    const resolved = resolve(nextCwd);
    const stat = statSync(resolved);
    if (!stat.isDirectory()) throw new Error(`cwd: not a directory: ${resolved}`);
    const changed = resolve(currentCwd) !== resolved;
    currentCwd = resolved;
    process.env.MIXDOG_SESSION_CWD = currentCwd;
    writeLastSessionCwd(currentCwd);
    if (session) session.cwd = currentCwd;
    // cwd changes NEVER recreate the session: a mid-conversation cwd switch must
    // preserve the full message history (and the BP1–BP3 prompt cache). We only
    // retarget the live session's cwd in place; tool execution already reads the
    // current cwd per turn. `cwd` is intentionally absent from the prompt
    // context (see composeSystemPrompt), so there is nothing prompt-side to
    // refresh either. `markRefresh`/`changed` are kept only for signature
    // compatibility with existing callers.
    void changed;
    void markRefresh;
    // Lazy mode: before the first turn (e.g. the initial project-selection
    // cwd set), do NOT prewarm — that is exactly the post-first-frame freeze
    // we are avoiding. Once a turn has run, an in-session cwd switch DOES
    // prewarm the new dir, since a lookup there is now likely.
    if (codeGraphPrewarmLazy && !codeGraphFirstTurnPrewarmDone) {
      bootProfile('code-graph:prewarm-lazy', { reason: 'cwd-deferred-to-first-turn' });
    } else {
      scheduleCodeGraphPrewarm(changed ? 0 : codeGraphPrewarmDelayMs, changed ? 'cwd-change' : 'cwd');
    }
    return currentCwd;
  }

  async function refreshSessionForCwdIfNeeded(reason = 'cwd-change') {
    // No-op: cwd changes are applied in place by applyResolvedCwd and never
    // tear down the session. Retained as a stable hook for ask()'s pre-turn
    // call so the surrounding turn flow is unchanged.
    void reason;
    sessionNeedsCwdRefresh = false;
    return session;
  }

  function skillContent(name) {
    const content = typeof contextMod.loadSkillContent === 'function'
      ? contextMod.loadSkillContent(name, currentCwd)
      : null;
    if (!content) throw new Error(`skill not found: ${name}`);
    return { name, content };
  }

  function skillToolContent(name) {
    const skill = skillContent(name);
    const escapedName = String(skill.name || '').replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    return `<skill>\n<name>${escapedName}</name>\n${skill.content}\n</skill>`;
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

  const agentToolStartedAt = performance.now();
  const agentTool = createStandaloneAgent({
    cfgMod,
    reg,
    mgr,
    dataDir: cfgMod.getPluginData(),
    cwd,
  });
  bootProfile('agent:ready', { ms: (performance.now() - agentToolStartedAt).toFixed(1) });
  const agentStatusState = () => {
    try {
      const status = agentTool.getStatus?.({ clientHostPid: session?.clientHostPid || process.pid }) || {};
      return {
        agentWorkers: Array.isArray(status.workers) ? status.workers : [],
        agentJobs: Array.isArray(status.jobs) ? status.jobs : [],
        agentScope: status.scope || null,
      };
    } catch {
      return { agentWorkers: [], agentJobs: [], agentScope: null };
    }
  };
  const channelsStartedAt = performance.now();
  const channels = createStandaloneChannelWorker({
    entry: join(STANDALONE_ROOT, CHANNEL_WORKER_ENTRY.replace(/^\.\//, '')),
    rootDir: STANDALONE_ROOT,
    dataDir: cfgMod.getPluginData(),
    cwd,
    onNotify: (msg) => {
      if (msg?.method !== 'notifications/claude/channel') return;
      const params = msg?.params && typeof msg.params === 'object' ? msg.params : {};
      const meta = params.meta && typeof params.meta === 'object' ? params.meta : {};
      if (meta.silent_to_agent === true || meta.silent_to_agent === 'true') return;
      const instruction = typeof meta.instruction === 'string' ? meta.instruction.trim() : '';
      const content = instruction || String(params.content || '').trim();
      emitRuntimeNotification(content, meta);
    },
  });
  bootProfile('channels:worker-ready', { ms: (performance.now() - channelsStartedAt).toFixed(1) });
  const toolsStartedAt = performance.now();
  const standaloneTools = [
    TOOL_SEARCH_TOOL,
    SKILL_TOOL,
    CWD_TOOL,
    EXPLORE_TOOL,
    ...(searchToolDefs?.TOOL_DEFS || []).filter((tool) => tool?.name === 'search' || tool?.name === 'web_fetch'),
    ...(memoryToolDefs?.TOOL_DEFS || []).filter((tool) => tool?.name === 'recall' || tool?.name === 'memory'),
    ...(channelToolDefs?.TOOL_DEFS || []).filter((tool) => channels.isChannelTool(tool?.name)),
    ...(codeGraphToolDefs?.CODE_GRAPH_TOOL_DEFS || []).filter((tool) => tool?.name === 'code_graph'),
    ...agentTool.tools,
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
    applyDeferredToolSurface(surface, deferredSurfaceModeForLead(mode), standaloneTools, { provider: route.provider });
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
    const discovered = Array.isArray(preSessionToolSurface.deferredDiscoveredTools)
      ? preSessionToolSurface.deferredDiscoveredTools
      : [];
    const replay = [...new Set([...selected, ...discovered])];
    if (replay.length) selectDeferredTools(session, replay, deferredSurfaceModeForLead(mode));
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
          nativeSearch: name === 'search'
            ? async (searchArgs) => runNativeWebSearch(searchArgs, { signal: callerCtx?.signal || session?.controller?.signal })
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
      if (name === 'tool_search') {
        return renderToolSearch(args, activeToolSurface(), mode);
      }
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
      if (name === 'Skill') {
        return skillToolContent(args?.name);
      }
      if (name === 'agent') {
        const callerSessionId = callerCtx?.callerSessionId || session?.id || null;
        return await agentTool.execute(args, {
          callerCwd,
          invocationSource: 'model-tool',
          callerSessionId,
          clientHostPid: callerCtx?.clientHostPid || session?.clientHostPid || process.pid,
          signal: callerCtx?.signal,
          notifyFn: notifyFnForSession(callerSessionId),
        });
      }
      if (name === 'provider_status') return renderProviderStatus(displayConfig());
      if (name === 'channel_status') return renderChannelStatus();
      if (channels.isChannelTool(name)) {
        if (!channelsEnabled()) throw new Error('channels are disabled in settings');
        return await channels.execute(name, args || {});
      }
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
    searchProviderModelsCache = { models: null, at: 0 };
    searchProviderModelsPromise = null;
    usageDashboardCache = { dashboard: null, at: 0 };
    usageDashboardPromise = null;
    providerSetupCache = { setup: null, at: 0 };
    providerSetupQuickCache = { setup: null, at: 0 };
    providerSetupPromise = null;
    providerInitPromise = null;
    modelMetaByRoute.clear();
  }

  function adoptConfig(nextConfig, { hasSecrets = configHasSecrets } = {}) {
    config = nextConfig;
    configHasSecrets = hasSecrets === true;
    setConfiguredShell(normalizeSystemShellConfig(config.shell).command);
    searchRoute = normalizeSearchRouteConfig(config.searchRoute) || normalizeSearchRouteConfig(searchRoute);
    return config;
  }

  // Persisting mixdog-config.json is heavy: it takes a cross-process file
  // lock, does an atomic temp+rename, and on win32 shells out to icacls
  // (an external process, multiple times per write) to enforce an owner-only
  // ACL. Doing that synchronously on EVERY option toggle froze the TUI main
  // thread, so adjusting a picker felt laggy and unresponsive. We split the
  // two concerns: adopt the new config in-memory IMMEDIATELY (so getProfile/
  // getAutoClear/etc. and the UI read fresh values on the same tick), and
  // DEBOUNCE the actual disk write so a burst of toggles collapses into a
  // single persist after input settles. The security model is unchanged —
  // cfgMod.saveConfig still strips apiKey (keychain-only) and still applies
  // the owner-only ACL; we only changed WHEN it runs, never HOW.
  let pendingConfigToSave = null;
  let configSaveTimer = null;
  const CONFIG_SAVE_DEBOUNCE_MS = 150;
  function flushConfigSave() {
    if (configSaveTimer) {
      clearTimeout(configSaveTimer);
      configSaveTimer = null;
    }
    if (pendingConfigToSave === null) return;
    const snapshot = pendingConfigToSave;
    pendingConfigToSave = null;
    try {
      cfgMod.saveConfig(snapshot);
    } catch (err) {
      process.stderr.write(`[config] debounced saveConfig failed: ${err?.message || err}\n`);
    }
  }
  function saveConfigAndAdopt(nextConfig, { hasSecrets = configHasSecrets } = {}) {
    // In-memory adopt is synchronous and first so callers that read back the
    // value immediately (e.g. setProfile -> getProfile) see the new state.
    const adopted = adoptConfig(nextConfig, { hasSecrets });
    // Persist the adopted object; coalesce rapid successive changes into one
    // disk write after CONFIG_SAVE_DEBOUNCE_MS of quiet.
    pendingConfigToSave = config;
    if (configSaveTimer) clearTimeout(configSaveTimer);
    configSaveTimer = setTimeout(flushConfigSave, CONFIG_SAVE_DEBOUNCE_MS);
    configSaveTimer.unref?.();
    return adopted;
  }

  function reloadFullConfig() {
    // A pending debounced write holds the only copy of the latest change.
    // Flush it before re-reading from disk so loadConfig() observes (and the
    // subsequent adopt preserves) that change instead of reverting to a stale
    // on-disk snapshot.
    flushConfigSave();
    return adoptConfig(cfgMod.loadConfig(), { hasSecrets: true });
  }

  function ensureFullConfig() {
    if (configHasSecrets) return config;
    return reloadFullConfig();
  }

  function displayConfig() {
    return config;
  }

  function ensureConfigForRouteProvider() {
    const providerId = clean(route.provider);
    const providerCfg = config?.providers?.[providerId];
    if (configHasSecrets || LAZY_SECRET_PROVIDERS.has(providerId) || providerCfg?.apiKey) {
      return config;
    }
    return ensureFullConfig();
  }

  function refreshStatuslineUsageSnapshot(routeLike = {}) {
    const providerId = clean(routeLike.provider);
    const modelId = clean(routeLike.model);
    if (!providerId || !providerId.includes('oauth')) return;
    const providerObj = reg.getProvider(providerId);
    if (!providerObj) return;
    void fetchOAuthUsageSnapshot({ provider: providerId, model: modelId }, providerObj, (message) => {
      if (process.env.MIXDOG_STATUSLINE_TRACE) {
        try { process.stderr.write(`[statusline] ${message}\n`); } catch {}
      }
    }).catch(() => {});
  }

  async function ensureProvidersReady(providerConfig = config.providers || {}) {
    if (providerInitPromise) return await providerInitPromise;
    providerInitPromise = reg.initProviders(providerConfig)
      .finally(() => {
        providerInitPromise = null;
      });
    return await providerInitPromise;
  }

  async function cachedProviderSetup({ force = false, quick = false } = {}) {
    if (!force && providerSetupCache.setup) {
      return providerSetupCache.setup;
    }
    if (quick) {
      if (!force && providerSetupQuickCache.setup) {
        return providerSetupQuickCache.setup;
      }
      const setup = await providerSetup(displayConfig(), { detectLocal: false, checkSecrets: false });
      providerSetupQuickCache = { setup, at: Date.now() };
      if (!providerSetupPromise && !providerSetupWarmupTimer && !closeRequested) {
        scheduleProviderSetupWarmup(0);
      }
      return setup;
    }
    if (providerSetupPromise) return await providerSetupPromise;
    providerSetupPromise = providerSetup(displayConfig(), { detectLocal: true })
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

  async function lookupModelMeta(providerId, modelId, { allowFetch = false } = {}) {
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
    if (!allowFetch) {
      const fallback = { id: modelId, provider: providerId };
      modelMetaByRoute.set(key, fallback);
      scheduleProviderModelWarmup();
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
      supportsWebSearch: searchCapableFor(name, m),
      supportsPromptCaching: m.supportsPromptCaching === true,
      supportsReasoning: m.supportsReasoning === true,
      reasoningLevels: Array.isArray(m.reasoningLevels) ? m.reasoningLevels : undefined,
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

  function quickProviderModelRows() {
    const pickerConfig = displayConfig();
    const rows = [];
    const seen = new Set();
    const addRoute = (routeLike = {}) => {
      const provider = clean(routeLike.provider);
      const model = clean(routeLike.model);
      if (!provider || !model) return;
      const key = `${provider}:${model}`;
      if (seen.has(key)) return;
      seen.add(key);
      const row = providerModelCacheRow(provider, {
        id: model,
        name: routeLike.modelDisplay || routeLike.display || model,
        display: routeLike.modelDisplay || routeLike.display || model,
        latest: routeLike.latest === true,
        supportsReasoning: !!routeLike.effort,
        mode: 'chat',
      });
      rows.push(row);
      modelMetaByRoute.set(modelMetaKey(provider, model), row);
    };

    addRoute(route);
    for (const preset of pickerConfig.presets || []) addRoute(preset);
    for (const workflowRoute of Object.values(pickerConfig.workflowRoutes || {})) addRoute(workflowRoute);
    for (const agentRoute of Object.values(pickerConfig.agents || {})) addRoute(agentRoute);
    return providerModelsFromCacheRows(rows);
  }

  function addQuickSearchModel(rows, seen, provider, model) {
    const providerName = normalizeSearchProviderId(provider);
    const modelId = clean(model?.id || model);
    if (!providerName || !modelId || !isSearchCapableProvider(providerName)) return;
    const key = `${providerName}:${modelId}`;
    if (seen.has(key)) return;
    const row = providerModelCacheRow(providerName, {
      id: modelId,
      name: model?.name || model?.display || modelId,
      display: model?.display || model?.name || modelId,
      contextWindow: model?.contextWindow || null,
      outputTokens: model?.outputTokens || null,
      latest: model?.latest === true,
      supportsWebSearch: true,
      supportsFunctionCalling: model?.supportsFunctionCalling === true,
      supportsPromptCaching: model?.supportsPromptCaching === true,
      supportsReasoning: model?.supportsReasoning === true,
      reasoningLevels: Array.isArray(model?.reasoningLevels) ? model.reasoningLevels : undefined,
      reasoningOptions: Array.isArray(model?.reasoningOptions) ? model.reasoningOptions : [],
      mode: 'chat',
    });
    if (row.supportsWebSearch !== true) return;
    seen.add(key);
    rows.push({
      ...row,
      provider: providerName,
      searchCapable: true,
      searchToolType: row.searchToolType || 'web_search',
    });
  }

  function addDefaultSearchModel(rows, seen = new Set()) {
    const mainModel = currentMainSearchModelMeta();
    if (!mainModel || !searchCapableFor(route.provider, mainModel)) return;
    const key = `${SEARCH_DEFAULT_PROVIDER}:${SEARCH_DEFAULT_MODEL}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      id: SEARCH_DEFAULT_MODEL,
      provider: SEARCH_DEFAULT_PROVIDER,
      display: 'Default',
      name: 'Default',
      description: `Use current main model: ${route.provider}/${route.model}`,
      supportsWebSearch: true,
      searchCapable: true,
      searchToolType: 'web_search',
      mode: 'chat',
    });
  }

  function quickSearchProviderModelRows() {
    const pickerConfig = displayConfig();
    const rows = [];
    const seen = new Set();
    addDefaultSearchModel(rows, seen);
    for (const [name, providerConfig] of Object.entries(pickerConfig.providers || {})) {
      const providerName = normalizeSearchProviderId(name);
      if (!providerConfig?.enabled || !isSearchCapableProvider(providerName)) continue;
      for (const model of QUICK_SEARCH_MODELS[providerName] || []) {
        addQuickSearchModel(rows, seen, providerName, model);
      }
    }
    const configuredSearch = normalizeSearchRouteConfig(pickerConfig.searchRoute) || normalizeSearchRouteConfig(searchRoute);
    if (configuredSearch?.provider && configuredSearch?.model) {
      addQuickSearchModel(rows, seen, configuredSearch.provider, {
        id: configuredSearch.model,
        display: configuredSearch.model,
      });
    }
    const mainModel = currentMainSearchModelMeta();
    if (mainModel && searchCapableFor(route.provider, mainModel)) {
      addQuickSearchModel(rows, seen, route.provider, {
        id: route.model,
        display: route.model,
      });
    }
    return searchModelsFromRows(rows);
  }

  function searchModelsFromRows(rows) {
    return sortProviderModels((rows || [])
      .filter((row) => row.supportsWebSearch === true)
      .map((row) => ({
        ...row,
        provider: normalizeSearchProviderId(row.provider),
        searchCapable: true,
        searchToolType: row.searchToolType || 'web_search',
      })));
  }

  function searchRowsWithDefault(rows = []) {
    const out = [];
    const seen = new Set();
    addDefaultSearchModel(out, seen);
    for (const row of rows || []) {
      const providerName = normalizeSearchProviderId(row?.provider);
      const modelId = clean(row?.id || row?.model);
      if (providerName === SEARCH_DEFAULT_PROVIDER && modelId.toLowerCase() === SEARCH_DEFAULT_MODEL) continue;
      const key = `${providerName}:${modelId}`;
      if (!providerName || !modelId || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out;
  }

  async function collectSearchProviderModels({ force = false } = {}) {
    if (!force && Array.isArray(searchProviderModelsCache.models)) {
      return providerModelsFromCacheRows(searchRowsWithDefault(searchProviderModelsCache.models));
    }
    if (!force && Array.isArray(providerModelsCache.models)) {
      const rows = searchRowsWithDefault(searchModelsFromRows(providerModelsCache.models));
      searchProviderModelsCache = { models: rows, at: Date.now() };
      return providerModelsFromCacheRows(rows);
    }
    if (!force) {
      const rows = searchRowsWithDefault(quickSearchProviderModelRows());
      searchProviderModelsCache = { models: rows, at: Date.now() };
      return providerModelsFromCacheRows(rows);
    }
    if (!searchProviderModelsPromise) {
      searchProviderModelsPromise = loadSearchProviderModelsFresh()
        .then((models) => {
          searchProviderModelsCache = { models, at: Date.now() };
          return models;
        })
        .finally(() => {
          searchProviderModelsPromise = null;
        });
    }
    return providerModelsFromCacheRows(await searchProviderModelsPromise);
  }

  function enabledSearchProviderConfig() {
    ensureFullConfig();
    const out = {};
    for (const [name, providerConfig] of Object.entries(config.providers || {})) {
      const providerName = normalizeSearchProviderId(name);
      if (!providerConfig?.enabled || !isSearchCapableProvider(providerName)) continue;
      out[providerName] = { ...providerConfig, enabled: true };
    }
    return out;
  }

  async function loadSearchProviderModelsFresh() {
    const searchProviders = enabledSearchProviderConfig();
    const providerNames = Object.keys(searchProviders);
    if (!providerNames.length) return [];
    await ensureProvidersReady(config.providers || {});
    const providerResults = await Promise.all(providerNames.map(async (name) => {
      const provider = reg.getProvider(name);
      if (typeof provider?.listModels !== 'function') return [];
      try {
        const models = await provider.listModels();
        if (!Array.isArray(models)) return [];
        const rows = [];
        for (const m of models) {
          if (!m?.id || !isSelectableLlmModel(m)) continue;
          const row = providerModelCacheRow(name, m);
          if (row.supportsWebSearch !== true) continue;
          rows.push({
            ...row,
            provider: normalizeSearchProviderId(row.provider),
            searchCapable: true,
            searchToolType: row.searchToolType || 'web_search',
          });
          modelMetaByRoute.set(modelMetaKey(name, m.id), row);
        }
        return rows;
      } catch {
        // Keep the picker responsive if one search-capable provider has a
        // transient catalog/auth failure.
        return [];
      }
    }));
    const results = [];
    const seen = new Set();
    addDefaultSearchModel(results, seen);
    for (const row of providerResults.flat()) {
      const key = `${normalizeSearchProviderId(row.provider)}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(row);
    }
    return results;
  }

  async function loadProviderModelsFresh() {
    ensureFullConfig();
    await ensureProvidersReady(config.providers || {});
    const allProviders = [...reg.getAllProviders()];
    const providerResults = await Promise.all(allProviders.map(async ([name, provider]) => {
      if (typeof provider?.listModels !== 'function') return [];
      try {
        const models = await provider.listModels();
        if (!Array.isArray(models)) return [];
        const rows = [];
        for (const m of models) {
          if (!m?.id) continue;
          if (!isSelectableLlmModel(m)) continue;
          rows.push(providerModelCacheRow(name, m));
        }
        return rows;
      } catch {
        // Ignore per-provider catalog failures so one bad credential or
        // transient /models error does not hide other authenticated models.
        return [];
      }
    }));
    const results = [];
    const seen = new Set();
    for (const row of providerResults.flat()) {
      const key = `${row.provider}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(row);
      modelMetaByRoute.set(modelMetaKey(row.provider, row.id), row);
    }
    return results;
  }

  async function collectProviderModels({ force = false, quick = false } = {}) {
    if (!force && Array.isArray(providerModelsCache.models)) {
      return providerModelsFromCacheRows(providerModelsCache.models);
    }
    if (!force && quick) {
      warmProviderModelCache();
      return quickProviderModelRows();
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

  async function createCurrentSession(reason = 'demand') {
    if (sessionCreatePromise) return await sessionCreatePromise;
    if (session?.id && !sessionNeedsCwdRefresh) {
      const liveSession = mgr.getSession(session.id);
      if (liveSession && liveSession.closed !== true && liveSession.status !== 'closed') {
        session = liveSession;
        return session;
      }
      session = null;
    }

    const startedAt = performance.now();
    bootProfile('session:create:start', { mode, reason });
    const promise = (async () => {
      ensureConfigForRouteProvider();
      await resolveMissingRouteModelForFirstTurn();
      requireModelRoute();
      bootProfile('session:create:route-ready', { ms: (performance.now() - startedAt).toFixed(1) });
      await refreshRouteEffort();
      bootProfile('session:create:effort-ready', { ms: (performance.now() - startedAt).toFixed(1) });
      const providerImpl = reg.getProvider(route.provider);
      if (!providerImpl) {
        throw new Error(`Provider "${route.provider}" is not configured.`);
      }
      bootProfile('session:create:provider-ready', { ms: (performance.now() - startedAt).toFixed(1) });
      const coreMemoryContext = await loadCoreMemoryContext();
      if (closeRequested) throw new Error('runtime is closing');
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const workflow = activeWorkflowSummary(config, dataDir);
      const workflowContext = workflowContextBlock(config, dataDir);
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
        workflow,
        workflowContext,
        fast: route.fast === true,
        compaction: config.compaction && typeof config.compaction === 'object'
          ? normalizeCompactionConfig(config.compaction, { memoryEnabled: memoryEnabled() })
          : undefined,
      };
      if (hasOwn(route, 'effort') || route.effectiveEffort) {
        sessionOpts.effort = route.effectiveEffort || null;
      }
      session = mgr.createSession(sessionOpts);
      sessionNeedsCwdRefresh = false;
      Object.defineProperty(session, 'beforeToolHook', {
        value: (input) => hooks.beforeTool(hookCommonPayload({
          ...input,
          session_id: input?.sessionId || input?.session_id || session?.id,
          tool_name: input?.name || input?.tool_name,
          tool_input: input?.args || input?.tool_input,
          tool_use_id: input?.toolCallId || input?.tool_use_id,
          cwd: input?.cwd || currentCwd,
        })),
        enumerable: false,
        configurable: true,
        writable: true,
      });
      // PostToolUse: bridge runtime tool completions to the standard hook bus.
      // dispatch() returns a promise; the loop's afterToolHook caller already
      // try/catches, so a rejection cannot escape the tool loop.
      Object.defineProperty(session, 'afterToolHook', {
        value: (input) => hooks.dispatch('PostToolUse', hookCommonPayload({
          session_id: input?.sessionId || input?.session_id || session?.id,
          cwd: input?.cwd || currentCwd,
          tool_name: input?.name,
          tool_input: input?.args,
          tool_use_id: input?.toolCallId || input?.tool_use_id,
          tool_response: input?.result,
        })),
        enumerable: false,
        configurable: true,
        writable: true,
      });
      applyDeferredToolSurface(session, deferredSurfaceModeForLead(mode), standaloneTools, { provider: route.provider });
      applyPreSessionToolSelection();
      writeStatuslineRoute(statusRoutes, session, route);
      hooks.emit('session:create', { sessionId: session.id, provider: route.provider, model: route.model, toolMode: mode, cwd: currentCwd });
      // SessionStart: bridge to the standard Claude Code hook bus. Best-effort;
      // a hook error must never break session creation. additionalContext is
      // injected before the first user turn as a system-reminder context pair.
      try {
        const startSource = /resume/i.test(String(reason || ''))
          ? 'resume'
          : (/clear/i.test(String(reason || '')) ? 'clear' : 'startup');
        const startDispatch = await hooks.dispatch('SessionStart', hookCommonPayload({ session_id: session.id, source: startSource, model: route.model }));
        const startContext = Array.isArray(startDispatch?.additionalContext)
          ? startDispatch.additionalContext.join('\n\n')
          : String(startDispatch?.additionalContext || '');
        if (startContext.trim()) {
          session.messages.push({ role: 'user', content: `<system-reminder>\n# SessionStart Hook Context\n${startContext.trim()}\n</system-reminder>` });
          session.messages.push({ role: 'assistant', content: '.' });
          session.updatedAt = Date.now();
        }
      } catch { /* best-effort: never break session create */ }
      bootProfile('session:create:ready', {
        ms: (performance.now() - startedAt).toFixed(1),
        reason,
        tools: Array.isArray(session.tools) ? session.tools.length : 0,
        catalog: Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog.length : 0,
      });
      return session;
    })();

    sessionCreatePromise = promise;
    try {
      return await promise;
    } finally {
      if (sessionCreatePromise === promise) sessionCreatePromise = null;
    }
  }

  function scheduleLeadSessionPrewarm() {
    if (!sessionPrewarmEnabled) {
      bootProfile('session:prewarm-skipped');
      return;
    }
    const timer = setTimeout(() => {
      if (closeRequested || session?.id || sessionCreatePromise || activeTurnCount > 0) return;
      void createCurrentSession('prewarm')
        .then(() => bootProfile('session:prewarm:ready'))
        .catch((error) => bootProfile('session:prewarm:failed', { error: error?.message || String(error) }));
    }, sessionPrewarmDelayMs);
    timer.unref?.();
  }

  function scheduleProviderWarmup(delayMs = providerWarmupDelayMs) {
    if (!providerWarmupEnabled) {
      bootProfile('providers:warm-skipped');
      return;
    }
    if (providerWarmupTimer || closeRequested) return;
    providerWarmupTimer = setTimeout(() => {
      providerWarmupTimer = null;
      if (closeRequested) return;
      if (!firstTurnCompleted && !envFlag('MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN')) {
        bootProfile('providers:warm-deferred', { reason: 'first-turn-pending' });
        return;
      }
      if (activeTurnCount > 0 || sessionCreatePromise) {
        bootProfile('providers:warm-deferred', { reason: activeTurnCount > 0 ? 'turn-active' : 'session-create' });
        scheduleProviderWarmup(backgroundBusyRetryMs);
        return;
      }
      const providersStartedAt = performance.now();
      try {
        reloadFullConfig();
      } catch (error) {
        bootProfile('config:full-failed', { error: error?.message || String(error) });
      }
      void ensureProvidersReady(config.providers || {})
        .then(() => {
          bootProfile('providers:init:ready', { ms: (performance.now() - providersStartedAt).toFixed(1) });
          if (closeRequested) return null;
          return true;
        })
        .catch((error) => bootProfile('providers:warm-failed', { error: error?.message || String(error) }));
    }, delayMs);
    providerWarmupTimer.unref?.();
  }

  function scheduleProviderSetupWarmup(delayMs = providerSetupWarmupDelayMs) {
    if (providerSetupWarmupTimer || closeRequested) return;
    providerSetupWarmupTimer = setTimeout(() => {
      providerSetupWarmupTimer = null;
      if (closeRequested) return;
      void cachedProviderSetup()
        .then(() => bootProfile('provider-setup:warm-ready'))
        .catch((error) => bootProfile('provider-setup:warm-failed', { error: error?.message || String(error) }));
    }, delayMs);
    providerSetupWarmupTimer.unref?.();
  }

  function scheduleProviderModelWarmup(delayMs = providerModelWarmupDelayMs) {
    if (!modelPrefetchEnabled) return;
    if (providerModelWarmupTimer || closeRequested) return;
    providerModelWarmupTimer = setTimeout(() => {
      providerModelWarmupTimer = null;
      if (closeRequested || Array.isArray(providerModelsCache.models) || providerModelsPromise) return;
      if (activeTurnCount > 0 || sessionCreatePromise) {
        bootProfile('provider-models:warm-deferred', { reason: activeTurnCount > 0 ? 'turn-active' : 'session-create' });
        scheduleProviderModelWarmup(backgroundBusyRetryMs);
        return;
      }
      warmProviderModelCache();
    }, delayMs);
    providerModelWarmupTimer.unref?.();
  }

  function scheduleStatuslineUsageWarmup(delayMs = statuslineUsageWarmupDelayMs) {
    const providerId = clean(route?.provider);
    if (!providerId || !providerId.includes('oauth')) {
      bootProfile('statusline-usage:warm-skipped', { provider: providerId || null });
      return;
    }
    if (statuslineUsageWarmupTimer || closeRequested) return;
    statuslineUsageWarmupTimer = setTimeout(async () => {
      statuslineUsageWarmupTimer = null;
      if (closeRequested) return;
      if (activeTurnCount > 0 || sessionCreatePromise) {
        bootProfile('statusline-usage:warm-deferred', { reason: activeTurnCount > 0 ? 'turn-active' : 'session-create' });
        scheduleStatuslineUsageWarmup(backgroundBusyRetryMs);
        return;
      }
      try {
        ensureConfigForRouteProvider();
        await ensureProvidersReady(ensureProviderEnabled(config, route.provider));
        if (closeRequested) return;
        refreshStatuslineUsageSnapshot(route);
        bootProfile('statusline-usage:warm-ready', { provider: clean(route?.provider) });
      } catch (error) {
        bootProfile('statusline-usage:warm-failed', { error: error?.message || String(error) });
      } finally {
        scheduleStatuslineUsageRefresh();
      }
    }, delayMs);
    statuslineUsageWarmupTimer.unref?.();
  }

  // Idle keep-alive loop: periodically re-fetch the OAuth usage snapshot so its
  // cachedAt stays "live-fresh" and the statusline usage segment does not vanish
  // after LIVE_USAGE_SNAPSHOT_MAX_AGE_MS while the session is idle. Turn-driven
  // refreshes (recordStandaloneStatusTelemetry) already cover active sessions.
  function scheduleStatuslineUsageRefresh(delayMs = statuslineUsageRefreshDelayMs) {
    const providerId = clean(route?.provider);
    if (!providerId || !providerId.includes('oauth')) return;
    if (statuslineUsageRefreshTimer || closeRequested) return;
    statuslineUsageRefreshTimer = setTimeout(async () => {
      statuslineUsageRefreshTimer = null;
      if (closeRequested) return;
      if (activeTurnCount > 0 || sessionCreatePromise) {
        // Active turns refresh usage on their own; just re-arm the idle loop.
        scheduleStatuslineUsageRefresh();
        return;
      }
      try {
        ensureConfigForRouteProvider();
        await ensureProvidersReady(ensureProviderEnabled(config, route.provider));
        if (closeRequested) return;
        refreshStatuslineUsageSnapshot(route);
      } catch {
        // Usage display must never affect the session runtime.
      } finally {
        scheduleStatuslineUsageRefresh();
      }
    }, delayMs);
    statuslineUsageRefreshTimer.unref?.();
  }

  function scheduleChannelStart(delayMs = channelStartDelayMs) {
    if (envFlag('MIXDOG_DISABLE_CHANNEL_START')) {
      bootProfile('channels:start-skipped');
      return;
    }
    if (!channelsEnabled()) {
      bootProfile('channels:start-disabled');
      return;
    }
    if (channelStartTimer || closeRequested) return;
    bootProfile('channels:start-scheduled', { delayMs });
    channelStartTimer = setTimeout(() => {
      channelStartTimer = null;
      if (closeRequested) return;
      if (activeTurnCount > 0 || sessionCreatePromise) {
        bootProfile('channels:start-deferred', { reason: activeTurnCount > 0 ? 'turn-active' : 'session-create' });
        scheduleChannelStart(backgroundBusyRetryMs);
        return;
      }
      const startedAt = performance.now();
      bootProfile('channels:start:begin');
      channels.start()
        .then(() => bootProfile('channels:start:ready', { ms: (performance.now() - startedAt).toFixed(1) }))
        .catch((error) => bootProfile('channels:start:failed', {
          ms: (performance.now() - startedAt).toFixed(1),
          error: error?.message || String(error),
        }));
    }, delayMs);
    channelStartTimer.unref?.();
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

  bootProfile('session-runtime:ready', {
    lazySession: true,
    prewarmSession: sessionPrewarmEnabled,
    providerWarmup: providerWarmupEnabled,
    codeGraphPrewarm: codeGraphPrewarmEnabled,
  });
  scheduleLeadSessionPrewarm();
  // Lazy mode (default): skip the startup prewarm entirely; the first turn
  // triggers it instead (see ask()). Eager mode keeps the old startup schedule.
  if (!codeGraphPrewarmLazy) {
    scheduleCodeGraphPrewarm(codeGraphPrewarmDelayMs, 'startup');
  } else {
    bootProfile('code-graph:prewarm-lazy', { reason: 'startup-deferred-to-first-turn' });
  }
  scheduleProviderSetupWarmup();
  scheduleProviderWarmup();
  // Warm the provider model catalog in the background, but keep it on its own
  // delay so short-lived detached runtimes can exit before /models I/O starts.
  // Operators that want earlier catalog warming can lower
  // MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS explicitly.
  scheduleProviderModelWarmup();
  scheduleStatuslineUsageWarmup();
  scheduleChannelStart();

  function contextStatusCacheKeyFor({ messages, tools }) {
    const compaction = session?.compaction || {};
    const lastMessage = messages[messages.length - 1] || null;
    return {
      session,
      sessionId: session?.id || null,
      provider: route.provider,
      model: route.model,
      cwd: currentCwd,
      mode,
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
    get autoClear() {
      return normalizeAutoClearConfig(config.autoClear);
    },
    get systemShell() {
      return normalizeSystemShellConfig(config.shell);
    },
    get searchRoute() {
      searchRoute = normalizeSearchRouteConfig(config.searchRoute) || normalizeSearchRouteConfig(searchRoute);
      return searchRoute;
    },
    get workflow() {
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      if (session?.workflow && typeof session.workflow === 'object') {
        return workflowSummary(session.workflow);
      }
      return activeWorkflowSummary(config, dataDir);
    },
    get outputStyle() {
      return getOutputStyleStatusCached().current;
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
      const cacheKey = contextStatusCacheKeyFor({ messages, tools });
      if (contextStatusCacheValue && sameContextStatusCacheKey(cacheKey, contextStatusCacheKey)) {
        return contextStatusCacheValue;
      }

      const messageSummary = summarizeContextMessages(messages);
      const toolSchemaTokens = estimateToolSchemaTokens(tools);
      const toolSchemaBreakdown = estimateToolSchemaBreakdown(tools);
      const requestReserveTokens = estimateRequestReserveTokens(tools);
      const requestOverheadTokens = Math.max(0, requestReserveTokens - toolSchemaTokens);
      const rawWindow = Number(session?.rawContextWindow || session?.contextWindow || 0);
      const effectiveWindow = Number(session?.contextWindow || rawWindow || 0);
      const lastContextTokens = Number(session?.lastContextTokens || 0);
      // On a brand-new session (no conversation messages and no recorded API
      // usage) the only thing left is the fixed request-overhead reserve, which
      // is fit/compaction headroom — not consumed context. Surfacing it as
      // "used" makes the statusline read a phantom ~0.1% on first entry. Keep
      // the reserve for compaction math but report zero estimated context until
      // the transcript actually has content.
      const hasContextActivity = messageSummary.count > 0 || lastContextTokens > 0;
      const estimatedContextTokens = hasContextActivity
        ? messageSummary.estimatedTokens + requestReserveTokens
        : 0;
      const compactAt = Number(session?.compaction?.lastChangedAt || session?.compaction?.lastCompactAt || 0);
      const usageAt = Number(session?.lastContextTokensUpdatedAt || 0);
      const lastUsageStale = !!lastContextTokens && (
        session?.lastContextTokensStaleAfterCompact === true
        || (compactAt > 0 && usageAt > 0 && usageAt <= compactAt)
        || (compactAt > 0 && usageAt <= 0)
      );
      const compactBoundaryTokens = Number(session?.compactBoundaryTokens || session?.compaction?.boundaryTokens || 0);
      const displayWindow = compactBoundaryTokens || effectiveWindow;
      // The transcript estimate is the single source of truth for the displayed
      // context footprint. Provider-reported input_tokens (lastContextTokens)
      // swing non-monotonically and are not window-bounded on some providers
      // (e.g. OpenAI gpt-5.5 Responses API), so they are kept only as secondary
      // metadata (lastApiRequestTokens / usage.lastContextTokens) and never feed
      // the gauge numerator.
      const usedTokens = estimatedContextTokens;
      const freeTokens = displayWindow ? Math.max(0, displayWindow - usedTokens) : 0;
      const autoCompactTokenLimit = Number(session?.autoCompactTokenLimit || 0);
      const defaultCompactTriggerTokens = compactBoundaryTokens ? Math.max(1, compactBoundaryTokens) : 0;
      const compactTriggerTokens = autoCompactTokenLimit && compactBoundaryTokens && autoCompactTokenLimit <= compactBoundaryTokens
        ? autoCompactTokenLimit
        : Number(session?.compaction?.triggerTokens || defaultCompactTriggerTokens || 0);
      const compactBufferTokens = Number(session?.compaction?.bufferTokens || (compactBoundaryTokens && compactTriggerTokens ? Math.max(0, compactBoundaryTokens - compactTriggerTokens) : 0));
      const value = {
        sessionId: session?.id || null,
        provider: route.provider,
        model: route.model,
        cwd: currentCwd,
        toolMode: mode,
        contextWindow: displayWindow || effectiveWindow || null,
        effectiveContextWindow: effectiveWindow || null,
        rawContextWindow: rawWindow || null,
        effectiveContextWindowPercent: session?.effectiveContextWindowPercent || null,
        usedTokens,
        usedSource: 'estimated',
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
          toolSchemaBreakdown,
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
      return renderProviderStatus(displayConfig());
    },
    async getProviderSetup() {
      return await cachedProviderSetup();
    },
    async getUsageDashboard(options = {}) {
      const forceSetup = options?.force === true || options?.refresh === true;
      if (!forceSetup && usageDashboardCache.dashboard) {
        const cached = {
          ...usageDashboardCache.dashboard,
          refresh: false,
          checking: false,
          cached: true,
          cachedAt: usageDashboardCache.at,
        };
        if (typeof options?.onUpdate === 'function') {
          try { options.onUpdate(cached); } catch {}
        }
        return cached;
      }
      if (!forceSetup && usageDashboardPromise) return await usageDashboardPromise;
      const quickSetup = options?.quickSetup !== false;
      const getProvider = (providerId) => reg.getProvider(providerId);
      const log = (message) => {
        if (process.env.MIXDOG_USAGE_TRACE) {
          try { process.stderr.write(`[usage] ${message}\n`); } catch {}
        }
      };
      if (quickSetup && typeof options?.onUpdate === 'function') {
        const previewConfig = displayConfig();
        const previewSetup = await cachedProviderSetup({ force: false, quick: true });
        await createUsageDashboard(previewConfig, {
          ...(options || {}),
          preview: true,
          setup: previewSetup,
          getProvider,
          log,
        });
      }
      const buildDashboard = async () => {
        const dashboard = await createUsageDashboard(displayConfig(), {
          ...(options || {}),
          setup: await cachedProviderSetup({ force: forceSetup, quick: false }),
          getProvider,
          log,
        });
        usageDashboardCache = { dashboard, at: Date.now() };
        return dashboard;
      };
      if (forceSetup) return await buildDashboard();
      usageDashboardPromise = buildDashboard()
        .finally(() => {
          usageDashboardPromise = null;
        });
      return await usageDashboardPromise;
    },
    getOnboardingStatus() {
      const nextConfig = displayConfig();
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
    // --- User profile (/profile statusline command) ---------------------
    // getProfile returns the normalized { title, language } plus the resolved
    // language catalog entry and the full language list for the picker UI.
    getProfile() {
      const profile = cfgMod.normalizeProfileConfig(config.profile);
      return {
        ...profile,
        languageEntry: cfgMod.profileLanguageEntry(profile.language),
        languages: cfgMod.PROFILE_LANGUAGES,
      };
    },
    // setProfile patches title and/or language and persists. Unknown language
    // ids normalize back to 'system'. Prompt-side injection is wired separately
    // (composeSystemPrompt) — this only owns the stored value.
    setProfile(input = {}) {
      const current = cfgMod.normalizeProfileConfig(config.profile);
      const next = { ...current };
      if (hasOwn(input, 'title') || hasOwn(input, 'name')) {
        next.title = input.title ?? input.name ?? '';
      }
      if (hasOwn(input, 'language') || hasOwn(input, 'lang')) {
        next.language = input.language ?? input.lang ?? 'system';
      }
      const normalized = cfgMod.normalizeProfileConfig(next);
      saveConfigAndAdopt({ ...config, profile: normalized });
      return this.getProfile();
    },
    getCompactionSettings() {
      return normalizeCompactionConfig(config.compaction, { memoryEnabled: memoryEnabled() });
    },
    setCompactionSettings(input = {}) {
      const current = normalizeCompactionConfig(config.compaction, { memoryEnabled: memoryEnabled() });
      const next = { ...current };
      if (hasOwn(input, 'auto')) next.auto = input.auto !== false;
      if (hasOwn(input, 'enabled')) next.auto = input.enabled !== false;
      if (hasOwn(input, 'type') || hasOwn(input, 'compactType') || hasOwn(input, 'compact_type')) {
        const requestedType = input.type ?? input.compactType ?? input.compact_type;
        const compactType = normalizeCompactTypeSetting(requestedType, current.compactType || current.type || 'semantic');
        if (compactType === 'recall-fasttrack' && !memoryEnabled()) {
          throw new Error('recall-fasttrack compact requires memory to be enabled');
        }
        next.type = compactType;
        next.compactType = compactType;
      }
      const nextConfig = { ...config };
      nextConfig.compaction = normalizeCompactionConfig(next, { memoryEnabled: memoryEnabled() });
      saveConfigAndAdopt(nextConfig);
      if (session) {
        session.compaction = {
          ...(session.compaction || {}),
          ...normalizeCompactionConfig(config.compaction, { memoryEnabled: memoryEnabled() }),
        };
      }
      invalidateContextStatusCache();
      return normalizeCompactionConfig(config.compaction, { memoryEnabled: memoryEnabled() });
    },
    getMemorySettings() {
      return {
        enabled: memoryEnabled(),
        compactFastTrackAvailable: memoryEnabled(),
      };
    },
    async setMemoryEnabled(enabled) {
      const nextConfig = setModuleEnabledInConfig({ ...config }, 'memory', enabled !== false);
      if (enabled === false) {
        nextConfig.compaction = normalizeCompactionConfig(nextConfig.compaction, { memoryEnabled: false });
      }
      saveConfigAndAdopt(nextConfig);
      if (!memoryEnabled() && memoryModPromise) {
        await memoryModPromise.then((mod) => mod?.stop?.()).catch(() => {});
        memoryModPromise = null;
      }
      if (session && config.compaction) {
        session.compaction = {
          ...(session.compaction || {}),
          ...normalizeCompactionConfig(config.compaction, { memoryEnabled: memoryEnabled() }),
        };
      }
      invalidatePreSessionToolSurface();
      invalidateContextStatusCache();
      return this.getMemorySettings();
    },
    getChannelSettings(options = {}) {
      return {
        enabled: channelsEnabled(),
        ...(options?.includeStatus === false ? {} : { status: channels.status() }),
      };
    },
    async setChannelsEnabled(enabled) {
      const nextConfig = setModuleEnabledInConfig({ ...config }, 'channels', enabled !== false);
      saveConfigAndAdopt(nextConfig);
      if (!channelsEnabled()) {
        if (channelStartTimer) {
          clearTimeout(channelStartTimer);
          channelStartTimer = null;
        }
        await channels.stop('settings-disabled', { waitForExit: false }).catch(() => {});
      } else {
        scheduleChannelStart(0);
      }
      invalidatePreSessionToolSurface();
      return this.getChannelSettings();
    },
    getSystemShell() {
      return normalizeSystemShellConfig(config.shell);
    },
    setSystemShell(input = {}) {
      const command = normalizeSystemShellCommand(typeof input === 'string' ? input : input?.command);
      saveConfigAndAdopt({
        ...config,
        shell: command ? { ...(config.shell || {}), command } : {},
      });
      setConfiguredShell(command);
      return normalizeSystemShellConfig(config.shell);
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
      saveConfigAndAdopt({ ...config, autoClear: next });
      return { ...normalizeAutoClearConfig(config.autoClear), label: formatDurationMs(normalizeAutoClearConfig(config.autoClear).idleMs) };
    },
    async completeOnboarding(payload = {}) {
      const defaultRoute = normalizeWorkflowRoute(payload.defaultRoute, route);
      const workflowInput = payload.workflowRoutes && typeof payload.workflowRoutes === 'object'
        ? payload.workflowRoutes
        : {};
      const nextConfig = { ...config };
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

      saveConfigAndAdopt(nextConfig);
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
      reloadFullConfig();
      invalidateProviderCaches();
      warmProviderModelCache();
      return result;
    },
    async loginOAuthProvider(providerId) {
      const result = await loginOAuthProvider(cfgMod, providerId);
      reloadFullConfig();
      invalidateProviderCaches();
      warmProviderModelCache();
      return result;
    },
    async beginOAuthProviderLogin(providerId) {
      const result = await beginOAuthProviderLogin(cfgMod, providerId);
      reloadFullConfig();
      return {
        ...result,
        waitForCallback: result.waitForCallback?.then((completed) => {
          reloadFullConfig();
          if (completed) {
            invalidateProviderCaches();
            warmProviderModelCache();
          }
          return completed;
        }),
        completeCode: async (code) => {
          const completed = await result.completeCode(code);
          reloadFullConfig();
          invalidateProviderCaches();
          warmProviderModelCache();
          return completed;
        },
      };
    },
    saveProviderApiKey(providerId, secret) {
      const result = saveProviderApiKey(cfgMod, providerId, secret);
      reloadFullConfig();
      invalidateProviderCaches();
      warmProviderModelCache();
      return result;
    },
    saveOpenAIUsageSessionKey(secret) {
      const result = saveOpenAIUsageSessionKey(cfgMod, secret);
      reloadFullConfig();
      invalidateProviderCaches();
      return result;
    },
    saveOpenCodeGoUsageAuth(opts) {
      const result = saveOpenCodeGoUsageAuth(cfgMod, opts);
      reloadFullConfig();
      invalidateProviderCaches();
      return result;
    },
    setLocalProvider(providerId, opts) {
      const result = setLocalProvider(cfgMod, providerId, opts);
      reloadFullConfig();
      invalidateProviderCaches();
      warmProviderModelCache();
      return result;
    },
    forgetProviderAuth(providerId) {
      const result = forgetProviderAuth(cfgMod, providerId);
      reloadFullConfig();
      invalidateProviderCaches();
      warmProviderModelCache();
      return result;
    },
    listPresets() {
      return cfgMod.listPresets(displayConfig());
    },
    async listProviderModels(options = {}) {
      return await collectProviderModels({
        force: options.force === true || options.refresh === true,
        quick: options.quick === true,
      });
    },
    getSearchRoute() {
      searchRoute = normalizeSearchRouteConfig(config.searchRoute) || normalizeSearchRouteConfig(searchRoute);
      return searchRoute;
    },
    async listSearchModels(options = {}) {
      return await collectSearchProviderModels({ force: options.force === true || options.refresh === true });
    },
    async setSearchRoute(next) {
      let selectedRoute = normalizeSearchRouteConfig(next);
      if (!selectedRoute && next?.model && searchRoute?.provider) {
        selectedRoute = normalizeSearchRouteConfig({ ...next, provider: searchRoute.provider });
      }
      if (!selectedRoute) throw new Error('search route requires provider and model');
      if (isDefaultSearchRouteConfig(selectedRoute)) {
        ensureFullConfig();
        const routeToSave = normalizeSearchRouteConfig({
          provider: SEARCH_DEFAULT_PROVIDER,
          model: SEARCH_DEFAULT_MODEL,
          ...(selectedRoute.toolType ? { toolType: selectedRoute.toolType } : {}),
        });
        const nextConfig = { ...config };
        nextConfig.searchRoute = routeToSave;
        saveConfigAndAdopt(nextConfig);
        searchRoute = normalizeSearchRouteConfig(config.searchRoute);
        invalidateProviderCaches();
        return searchRoute;
      }
      if (!isSearchCapableProvider(selectedRoute.provider)) {
        throw new Error(`provider "${selectedRoute.provider}" does not support Mixdog native search`);
      }
      ensureFullConfig();
      await reg.initProviders(ensureProviderEnabled(config, selectedRoute.provider));
      const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
      if (!searchCapableFor(selectedRoute.provider, modelMeta)) {
        throw new Error(`model "${selectedRoute.model}" is not marked as web-search capable`);
      }
      const fastCapable = fastCapableFor(selectedRoute.provider, modelMeta);
      const effort = coerceEffortFor(selectedRoute.provider, modelMeta, selectedRoute.effort);
      selectedRoute = {
        ...selectedRoute,
        ...(effort ? { effort } : {}),
        fast: fastCapable ? selectedRoute.fast === true : false,
      };
      adoptConfig(saveModelSettings(cfgMod, selectedRoute, { fastCapable, baseConfig: config }), { hasSecrets: configHasSecrets });
      const routeToSave = normalizeSearchRouteConfig(selectedRoute);
      const nextConfig = { ...config };
      nextConfig.searchRoute = routeToSave;
      saveConfigAndAdopt(nextConfig);
      searchRoute = normalizeSearchRouteConfig(config.searchRoute);
      invalidateProviderCaches();
      return searchRoute;
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
      const currentConfig = displayConfig();
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
    getOutputStyle() {
      return getOutputStyleStatusCached();
    },
    listOutputStyles() {
      return getOutputStyleStatusCached();
    },
    async setOutputStyle(value) {
      const before = getOutputStyleStatusCached({ fresh: true });
      const selected = findOutputStyle(value, before.styles);
      if (!selected) {
        const names = before.styles.map((style) => style.label || style.id).join(', ') || 'Default';
        throw new Error(`output style must be one of ${names}`);
      }
      if (typeof sharedCfgMod.updateConfig !== 'function') throw new Error('output style config writer unavailable');
      sharedCfgMod.updateConfig((root) => {
        const next = { ...(root || {}), outputStyle: selected.id };
        if (next.agent && typeof next.agent === 'object' && !Array.isArray(next.agent)) {
          const agent = { ...next.agent };
          delete agent.outputStyle;
          next.agent = agent;
        }
        return next;
      });
      invalidateOutputStyleStatusCache();
      const hasConversation = sessionHasConversationMessages(session);
      let appliedToCurrentSession = !hasConversation;
      if (session?.id && !hasConversation) {
        mgr.closeSession(session.id, 'cli-output-style-switch');
        session = null;
        await recreateCurrentSessionIfReady();
      }
      invalidateContextStatusCache();
      return { ...getOutputStyleStatusCached({ fresh: true }), appliedToCurrentSession };
    },
    async setWorkflow(workflowId) {
      const id = normalizeWorkflowId(workflowId, DEFAULT_WORKFLOW_ID);
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const pack = loadWorkflowPack(dataDir, id);
      if (!pack || pack.id !== id) throw new Error(`workflow "${workflowId}" not found`);
      const nextConfig = { ...config };
      nextConfig.workflow = { ...(nextConfig.workflow || {}), active: id };
      saveConfigAndAdopt(nextConfig);
      return workflowSummary(pack);
    },
    async setAgentRoute(agentId, next) {
      const id = normalizeAgentId(agentId);
      if (!id) throw new Error(`unknown agent "${agentId}"`);
      let selectedRoute = resolveRoute(config, { ...(next || {}) });
      await reg.initProviders(ensureProviderEnabled(config, selectedRoute.provider));
      const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
      const fastCapable = fastCapableFor(selectedRoute.provider, modelMeta);
      selectedRoute = { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false };
      adoptConfig(saveModelSettings(cfgMod, selectedRoute, { fastCapable, baseConfig: config }), { hasSecrets: configHasSecrets });

      const routeToSave = normalizeWorkflowRoute(selectedRoute);
      if (!routeToSave) throw new Error('agent route requires provider and model');
      const agent = FIXED_AGENT_SLOTS.find((item) => item.id === id);
      const nextConfig = { ...config };
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
      saveConfigAndAdopt(nextConfig);
      return routeToSave;
    },
    async ask(prompt, options = {}) {
      activeTurnCount += 1;
      // Lazy code-graph prewarm: kick off the build ONCE, on the first real
      // turn, so a likely code lookup hits a warm cache — without paying the
      // post-first-frame prewarm freeze on idle startup. The schedule is async
      // + unref'd (worker thread), so it never blocks this turn.
      if (codeGraphPrewarmLazy && !codeGraphFirstTurnPrewarmDone) {
        codeGraphFirstTurnPrewarmDone = true;
        scheduleCodeGraphPrewarm(0, 'first-turn');
      }
      const startedAt = Date.now();
      try {
        await refreshSessionForCwdIfNeeded('cwd-change');
        if (!session?.id) await createCurrentSession('turn');
        hooks.emit('turn:start', { sessionId: session.id, prompt, cwd: currentCwd });
        // UserPromptSubmit: bridge to the standard hook bus. A hook FAILURE
        // must not block the turn, but a genuine blocked===true MUST throw.
        let promptDispatch = null;
        try {
          promptDispatch = await hooks.dispatch('UserPromptSubmit', hookCommonPayload({ session_id: session.id, prompt }));
        } catch { /* hook failure never blocks the turn */ }
        if (promptDispatch?.blocked === true) {
          throw new Error(`prompt blocked by hook: ${promptDispatch.reason || ''}`);
        }
        const hookContext = Array.isArray(promptDispatch?.additionalContext)
          ? promptDispatch.additionalContext.join('\n\n')
          : String(promptDispatch?.additionalContext || '');
        const turnContext = [options.context || '', hookContext]
          .map((part) => String(part || '').trim())
          .filter(Boolean)
          .join('\n\n');
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
            onAssistantText: options.onAssistantText,
            onUsageDelta: options.onUsageDelta,
            onToolResult: options.onToolResult,
            onToolApproval: options.onToolApproval,
            onCompactEvent: options.onCompactEvent,
            onStageChange: options.onStageChange,
            onStreamDelta: options.onStreamDelta,
            drainSteering: options.drainSteering,
            onSteerMessage: options.onSteerMessage,
            notifyFn: notifyFnForSession(session.id),
          },
        );
        session = mgr.getSession(session.id) || session;
        hooks.emit('turn:end', { sessionId: session.id, elapsedMs: Date.now() - startedAt });
        // Stop: bridge to the standard hook bus. Best-effort; ignore result,
        // never throw.
        try {
          await hooks.dispatch('Stop', hookCommonPayload({ session_id: session.id }));
        } catch { /* best-effort: Stop hook must never break the turn */ }
        return { result, session };
      } catch (error) {
        hooks.emit('turn:error', { sessionId: session?.id || null, elapsedMs: Date.now() - startedAt, error: error?.message || String(error) });
        throw error;
      } finally {
        activeTurnCount = Math.max(0, activeTurnCount - 1);
        if (!firstTurnCompleted) {
          firstTurnCompleted = true;
          scheduleProviderWarmup();
          scheduleProviderModelWarmup();
        }
      }
    },
    async clear(options = {}) {
      if (!session?.id) return false;
      const cleared = await mgr.clearSessionMessages(session.id, options);
      if (!cleared) return false;
      session = typeof cleared === 'object' ? cleared : (mgr.getSession(session.id) || session);
      if (options.recoverAgent === true) {
        try { agentTool.recoverWorkers?.({ clientHostPid: session?.clientHostPid || process.pid }); } catch {}
      }
      invalidateContextStatusCache();
      return true;
    },
    async compact(options = {}) {
      if (!session?.id) return null;
      if (activeTurnCount > 0) {
        return { changed: false, reason: 'compact skipped: turn in progress' };
      }
      const result = await mgr.compactSessionMessages(session.id);
      session = mgr.getSession(session.id) || session;
      if (options.recoverAgent === true) {
        try { agentTool.recoverWorkers?.({ clientHostPid: session?.clientHostPid || process.pid }); } catch {}
      }
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
    agentStatus() {
      return agentStatusState();
    },
    get clientHostPid() {
      return session?.clientHostPid || process.pid;
    },
    agentControl(args = {}) {
      const callerSessionId = session?.id || null;
      return agentTool.execute(args, {
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
        discoveredTools: sortedNamesByMeasuredUsage(surface?.deferredDiscoveredTools || []),
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
      reloadFullConfig();
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-reconnect');
      await recreateCurrentSessionIfReady();
      return status;
    },
    async addMcpServer(input = {}) {
      const { name, config: serverConfig } = normalizeMcpServerInput(input);
      const nextConfig = { ...config };
      nextConfig.mcpServers = {
        ...(nextConfig.mcpServers || {}),
        [name]: serverConfig,
      };
      saveConfigAndAdopt(nextConfig);
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-add');
      await recreateCurrentSessionIfReady();
      return { name, status };
    },
    async removeMcpServer(name) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const nextConfig = { ...config };
      const current = nextConfig.mcpServers && typeof nextConfig.mcpServers === 'object'
        ? { ...nextConfig.mcpServers }
        : {};
      if (!Object.prototype.hasOwnProperty.call(current, serverName)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      delete current[serverName];
      saveConfigAndAdopt({ ...nextConfig, mcpServers: current });
      const status = await connectConfiguredMcp({ reset: true });
      invalidatePreSessionToolSurface();
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-remove');
      await recreateCurrentSessionIfReady();
      return status;
    },
    async setMcpServerEnabled(name, enabled) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const nextConfig = { ...config };
      const current = nextConfig.mcpServers && typeof nextConfig.mcpServers === 'object'
        ? { ...nextConfig.mcpServers }
        : {};
      if (!Object.prototype.hasOwnProperty.call(current, serverName)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      current[serverName] = { ...(current[serverName] || {}), enabled: enabled !== false };
      saveConfigAndAdopt({ ...nextConfig, mcpServers: current });
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
      const nextConfig = { ...config };
      const serverName = pluginMcpServerName(plugin);
      if (nextConfig.mcpServers && Object.prototype.hasOwnProperty.call(nextConfig.mcpServers, serverName)) {
        const current = { ...nextConfig.mcpServers };
        delete current[serverName];
        saveConfigAndAdopt({ ...nextConfig, mcpServers: current });
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
      const nextConfig = { ...config };
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
      saveConfigAndAdopt(nextConfig);
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
      const baseQuery = query || args?.query || '';
      if (args?.currentSession !== false && session?.id) {
        const currentText = currentSessionRecallRows(session, baseQuery, { limit: args?.limit });
        if (!isEmptyRecallText(currentText)) return currentText;
      }
      const memoryMod = await getMemoryModule();
      if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
      const baseArgs = {
        ...(args || {}),
        query: baseQuery,
        cwd: args?.cwd || currentCwd,
      };
      let result = '(no results)';
      if (session?.id && args?.currentSession !== false && args?.forceCycleOnEmpty !== false) {
        const messages = Array.isArray(session.messages) ? session.messages : [];
        if (messages.length > 0) {
          await memoryMod.handleToolCall('memory', {
            action: 'ingest_session',
            sessionId: session.id,
            cwd: currentCwd,
            messages,
          });
          await memoryMod.handleToolCall('memory', {
            action: 'cycle1',
            min_batch: 1,
            session_cap: 1,
            batch_size: Math.max(1, Math.min(100, messages.length)),
          });
          result = toolResponseText(await memoryMod.handleToolCall('recall', {
            ...baseArgs,
            sessionId: session.id,
            currentSession: true,
            projectScope: baseArgs.projectScope || 'all',
            includeRaw: baseArgs.includeRaw !== false,
            includeArchived: baseArgs.includeArchived !== false,
          }));
        }
      }
      if (isEmptyRecallText(result)) {
        result = toolResponseText(await memoryMod.handleToolCall('recall', baseArgs));
      }
      return result;
    },
    async setRoute(next, options = {}) {
      const applyToCurrentSession = options?.applyToCurrentSession !== false;
      const requested = { ...(next || {}) };
      validateRequestedModelSelector(config, requested);
      const providerExplicitlyRequested = clean(next?.provider) !== '';
      if (requested.effort === undefined && !requested.provider && !requested.model && hasOwn(route, 'effort')) {
        requested.effort = route.effort;
      }
      if (!requested.provider && requested.model && !findPreset(config, requested.model)) {
        requested.provider = route.provider;
      }
      let selectedRoute = resolveRoute(config, requested);
      await reg.initProviders(ensureProviderEnabled(config, selectedRoute.provider));
      const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
      // Guard (A안 / strict reject): a free-text string must never become the
      // lead model. When the caller did not pin a provider, the route did not
      // match a preset, and the model is unknown to both the live provider
      // catalog (modelMeta is still the {id,provider} placeholder) and the
      // offline catalog, refuse BEFORE any config write so a partial save
      // (saveModelSettings/adoptConfig/persistLeadRoute) can never land.
      if (!providerExplicitlyRequested
        && !selectedRoute.preset
        && !modelMetaLooksResolved(modelMeta)
        && !getModelMetadataSync(selectedRoute.model, selectedRoute.provider)) {
        throw new Error(`unknown model: ${selectedRoute.provider}/${selectedRoute.model}`);
      }
      const fastCapable = fastCapableFor(selectedRoute.provider, modelMeta);
      selectedRoute = { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false };
      adoptConfig(saveModelSettings(cfgMod, selectedRoute, { fastCapable, baseConfig: config }), { hasSecrets: configHasSecrets });
      if (!applyToCurrentSession) {
        persistLeadRoute(selectedRoute);
        refreshStatuslineUsageSnapshot(route);
        scheduleStatuslineUsageRefresh();
        return selectedRoute;
      }
      const leadRoute = persistLeadRoute(selectedRoute);
      route = resolveRoute(config, leadRoute
        ? { model: workflowPresetId('lead') }
        : selectedRoute);
      await refreshRouteEffort(modelMeta);
      refreshStatuslineUsageSnapshot(route);
      scheduleStatuslineUsageRefresh();
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
        writeStatuslineRoute(statusRoutes, session, route);
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
      adoptConfig(saveModelSettings(cfgMod, route, { fastCapable, baseConfig: config }), { hasSecrets: configHasSecrets });
      const leadRoute = persistLeadRoute(route);
      if (leadRoute) route = resolveRoute(config, { model: workflowPresetId('lead') });
      await refreshRouteEffort(modelMeta);
      if (session) {
        session.fast = route.fast === true;
        session.effort = route.effectiveEffort || null;
        writeStatuslineRoute(statusRoutes, session, route);
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
      const modelMeta = await lookupModelMeta(route.provider, route.model);
      const fastCapable = fastCapableFor(route.provider, modelMeta);
      adoptConfig(saveModelSettings(cfgMod, route, { fastCapable, baseConfig: config }), { hasSecrets: configHasSecrets });
      const leadRoute = persistLeadRoute(route);
      if (leadRoute) {
        route = resolveRoute(config, { model: workflowPresetId('lead') });
      }
      await refreshRouteEffort(modelMeta);
      if (session) {
        session.effort = route.effectiveEffort || null;
        writeStatuslineRoute(statusRoutes, session, route);
        invalidateContextStatusCache();
      }
      return route;
    },
    async close(reason = 'cli-exit', options = {}) {
      const detach = options?.detach === true || options?.wait === false || options?.waitForExit === false;
      closeRequested = true;
      // Persist any change that is still sitting in the debounce window so a
      // toggle made right before exit is not lost. Synchronous + best-effort:
      // teardown must continue even if the final write fails.
      try { flushConfigSave(); } catch {}
      if (channelStartTimer) {
        clearTimeout(channelStartTimer);
        channelStartTimer = null;
      }
      if (providerSetupWarmupTimer) {
        clearTimeout(providerSetupWarmupTimer);
        providerSetupWarmupTimer = null;
      }
      if (providerWarmupTimer) {
        clearTimeout(providerWarmupTimer);
        providerWarmupTimer = null;
      }
      if (providerModelWarmupTimer) {
        clearTimeout(providerModelWarmupTimer);
        providerModelWarmupTimer = null;
      }
      if (codeGraphPrewarmTimer) {
        clearTimeout(codeGraphPrewarmTimer);
        codeGraphPrewarmTimer = null;
      }
      if (statuslineUsageWarmupTimer) {
        clearTimeout(statuslineUsageWarmupTimer);
        statuslineUsageWarmupTimer = null;
      }
      if (statuslineUsageRefreshTimer) {
        clearTimeout(statuslineUsageRefreshTimer);
        statuslineUsageRefreshTimer = null;
      }
      try { cancelBackgroundTasks({ reason, notify: false }); } catch {}
      const channelStop = channels.stop(reason, detach ? { waitForExit: false } : undefined);
      try { agentTool.closeAll(reason); } catch {}
      let mcpStop = null;
      try { mcpStop = mcpClient.disconnectAll?.(); } catch {}
      const openaiWsStop = globalThis.__mixdogOpenaiWsRuntimeLoaded === true
        ? import('./runtime/agent/orchestrator/providers/openai-oauth-ws.mjs')
          .then((mod) => mod?.drainOpenaiWsPool?.(reason))
          .catch(() => {})
        : null;
      const patchStop = closePatchRuntimeIfLoaded(detach ? { waitForExit: false } : undefined);
      const memoryStop = memoryModPromise
        ? memoryModPromise
          .then((mod) => (typeof mod?.stop === 'function' ? mod.stop() : null))
          .catch(() => {})
          .finally(() => {
            memoryModPromise = null;
          })
        : null;
      let ok = false;
      if (session?.id) {
        statusRoutes?.clearGatewaySessionRoute?.(session.id);
        ok = mgr.closeSession(session.id, reason);
        session = null;
      }
      const shellJobsStop = globalThis.__mixdogShellJobsRuntimeLoaded === true
        ? import('./runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs')
          .then((mod) => mod?.shutdownShellJobs?.(reason, { sync: !detach }))
          .catch(() => {})
        : null;
      const bashSessionsStop = globalThis.__mixdogBashSessionRuntimeLoaded === true
        ? import('./runtime/agent/orchestrator/tools/bash-session.mjs')
          .then((mod) => mod?.shutdownBashSessions?.(reason))
          .catch(() => {})
        : null;
      if (detach) {
        try { await withTeardownDeadline(channelStop, 300, false); } catch {}
        try { await withTeardownDeadline(shellJobsStop, 300, false); } catch {}
        try { await withTeardownDeadline(bashSessionsStop, 300, false); } catch {}
        try { await withTeardownDeadline(memoryStop, 1500, false); } catch {}
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
        withTeardownDeadline(memoryStop, 5500, false),
        withTeardownDeadline(shellJobsStop, 1500, false),
        withTeardownDeadline(bashSessionsStop, 1500, false),
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
          || (!sourceType && !sourceName && !isAgentOwner(owner));
        if (!leadish) return null;
        let preview = cleanSessionPreview(s.preview || '');
        let messageCount = Math.max(0, Number(s.messageCount) || 0);
        if (!preview && Array.isArray(s.messages)) {
          const msgs = s.messages || [];
          const userPreviews = msgs
            .filter(m => m && m.role === 'user')
            .map(m => cleanSessionPreview(sessionMessageText(m.content)))
            .filter(text => !isSessionPreviewNoise(text));
          preview = userPreviews[userPreviews.length - 1] || userPreviews[0] || '';
          messageCount = msgs.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length;
        }
        if (!preview) return null;
        return {
          id: s.id,
          updatedAt: s.updatedAt,
          cwd: s.cwd || '',
          model: s.model,
          provider: s.provider,
          messageCount,
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
      applyDeferredToolSurface(session, deferredSurfaceModeForLead(mode), standaloneTools, { provider: route.provider });
      invalidatePreSessionToolSurface();
      invalidateContextStatusCache();
      sessionNeedsCwdRefresh = false;
      writeStatuslineRoute(statusRoutes, session, route);
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
