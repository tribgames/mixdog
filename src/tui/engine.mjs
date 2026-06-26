/**
 * src/tui/engine.mjs - the engine<->React bridge (React-free).
 *
 * Runs mixdog's session manager outside React and exposes a tiny subscribable
 * store. The React/ink layer consumes it via useSyncExternalStore
 * (see hooks/useEngine.mjs).
 */
import { performance } from 'node:perf_hooks';
import { SPINNER_VERBS } from './spinner-verbs.mjs';
import {
  classifyToolCategory,
  formatAggregateDetail,
  summarizeToolResult,
} from '../runtime/shared/tool-surface.mjs';
import { presentErrorText } from '../runtime/shared/err-text.mjs';

const BOOT_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_BOOT_PROFILE || ''));
const BOOT_PROFILE_START = globalThis.__mixdogBootProfileStart || (globalThis.__mixdogBootProfileStart = performance.now());

function bootProfile(event, fields = {}) {
  if (!BOOT_PROFILE_ENABLED) return;
  const elapsedMs = performance.now() - BOOT_PROFILE_START;
  const parts = [`[mixdog-boot] +${elapsedMs.toFixed(1)}ms`, `tui:${event}`];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`);
  }
  try { process.stderr.write(`${parts.join(' ')}\n`); } catch {}
}

// Session-usage accumulator - inlined (not imported from ui/statusline.mjs) so
// engine.mjs has no static dependency on the vendored statusline closure.
function createSessionStats() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    promptTokens: 0,
    latestInputTokens: 0,
    latestOutputTokens: 0,
    latestCachedTokens: 0,
    latestCacheWriteTokens: 0,
    latestPromptTokens: 0,
    currentContextTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function applyUsageDelta(stats, delta = {}) {
  if (!stats || !delta) return stats;
  const inputTokens = num(delta.deltaInput);
  const outputTokens = num(delta.deltaOutput);
  const cachedTokens = num(delta.deltaCachedRead);
  const cacheWriteTokens = num(delta.deltaCacheWrite);
  const promptTokens = num(delta.deltaPrompt);
  stats.inputTokens += inputTokens;
  stats.outputTokens += outputTokens;
  stats.cachedTokens += cachedTokens;
  stats.cacheWriteTokens += cacheWriteTokens;
  stats.promptTokens += promptTokens;
  stats.latestInputTokens = inputTokens;
  stats.latestOutputTokens = outputTokens;
  stats.latestCachedTokens = cachedTokens;
  stats.latestCacheWriteTokens = cacheWriteTokens;
  stats.latestPromptTokens = promptTokens;
  stats.costUsd += num(delta.costUsd);
  return stats;
}

// Source tests resolve from src/tui/engine.mjs; the built bundle resolves from
// src/tui/dist/index.mjs.
const SESSION_RUNTIME_MODULE = import.meta.url.replace(/\\/g, '/').includes('/tui/dist/')
  ? '../../mixdog-session-runtime.mjs'
  : '../mixdog-session-runtime.mjs';

let _idSeq = 0;
const nextId = () => `it_${++_idSeq}`;

function pickVerb(turn) {
  return SPINNER_VERBS[(turn * 7 + 3) % SPINNER_VERBS.length];
}

const TURN_DONE_VERBS = [
  'Thought',
  'Reasoned',
  'Mapped',
  'Checked',
  'Solved',
  'Composed',
  'Synthesized',
  'Wrapped',
];

function pickDoneVerb(turn) {
  return TURN_DONE_VERBS[(turn * 5 + 2) % TURN_DONE_VERBS.length];
}

function formatIdleDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value >= 3_600_000 && value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value >= 60_000) return `${Math.round(value / 60_000)}m`;
  if (value < 1_000) return '';
  return `${Math.floor(value / 1000)}s`;
}

const FAILED_NOTICE_ACTIONS = new Map([
  ['api key save', 'save API key'],
  ['auth-forget', 'forget auth'],
  ['auto-clear', 'update auto-clear'],
  ['autoclear', 'update auto-clear'],
  ['bridge', 'run bridge command'],
  ['channels', 'load channels'],
  ['channels update', 'update channels'],
  ['clear', 'clear chat'],
  ['compact', 'compact context'],
  ['copy', 'copy'],
  ['core memory', 'load core memory'],
  ['cwd', 'update working directory'],
  ['effort switch', 'switch effort'],
  ['fast', 'update fast mode'],
  ['hook rule update', 'update hook rule'],
  ['hook toggle', 'toggle hook'],
  ['hook update', 'update hook'],
  ['hooks status', 'load hooks'],
  ['local provider update', 'update local provider'],
  ['mcp add', 'add MCP server'],
  ['mcp reconnect', 'reconnect MCP server'],
  ['mcp status', 'load MCP status'],
  ['mcp toggle', 'toggle MCP server'],
  ['memory', 'run memory command'],
  ['memory status', 'load memory status'],
  ['model save', 'save model'],
  ['model switch', 'switch model'],
  ['oauth code', 'finish OAuth login'],
  ['oauth login', 'start OAuth login'],
  ['OpenAI usage auth save', 'save OpenAI usage auth'],
  ['OpenCode Go usage auth save', 'save OpenCode Go usage auth'],
  ['plugin add', 'add plugin'],
  ['plugin MCP enable', 'enable plugin MCP'],
  ['plugin uninstall', 'uninstall plugin'],
  ['plugin update', 'update plugin'],
  ['plugins status', 'load plugins'],
  ['providers', 'load providers'],
  ['recall', 'run recall'],
  ['resume', 'resume chat'],
  ['schedule toggle', 'toggle schedule'],
  ['setup save', 'save setup'],
  ['settings update', 'update settings'],
  ['skill add', 'add skill'],
  ['skills status', 'load skills'],
  ['tools status', 'load tool status'],
  ['usage', 'load usage'],
  ['webhook toggle', 'toggle webhook'],
  ['workflow switch', 'switch workflow'],
]);

function polishNoticeAction(action) {
  const value = String(action || '').trim();
  if (!value) return 'finish';
  const key = value.toLowerCase();
  for (const [candidate, replacement] of FAILED_NOTICE_ACTIONS.entries()) {
    if (candidate.toLowerCase() === key) return replacement;
  }
  const suffixes = [
    [' save', 'save'],
    [' switch', 'switch'],
    [' update', 'update'],
    [' toggle', 'toggle'],
    [' reconnect', 'reconnect'],
    [' enable', 'enable'],
    [' uninstall', 'uninstall'],
    [' add', 'add'],
  ];
  for (const [suffix, verb] of suffixes) {
    if (!key.endsWith(suffix)) continue;
    const subject = value.slice(0, -suffix.length).trim();
    return subject ? `${verb} ${subject}` : verb;
  }
  return value;
}

function sentenceStart(text) {
  const value = String(text || '').trim();
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function polishNoticeText(text) {
  let value = String(text ?? '').trim().replace(/^✓\s*/, '');
  if (!value) return '';
  const error = /^error\s*:\s*(.+)$/i.exec(value);
  if (error?.[1]) value = error[1].trim();
  const couldNot = /^could not\s+(.+?)(?::\s*(.+))?$/i.exec(value);
  if (couldNot) {
    return couldNot[2]
      ? `Couldn’t ${couldNot[1]}: ${couldNot[2]}`
      : `Couldn’t ${couldNot[1]}.`;
  }
  const failed = /^(.+?)\s+failed(?::\s*(.+))?$/i.exec(value);
  if (failed) {
    const action = polishNoticeAction(failed[1]);
    return failed[2] ? `Couldn’t ${action}: ${failed[2]}` : `Couldn’t ${action}.`;
  }
  const busy = /^(.+?)\s+already in progress\.?$/i.exec(value);
  if (busy) return `${sentenceStart(polishNoticeAction(busy[1]))} is already running.`;
  const required = /^(.+?)\s+is required(?:\s+for\s+(.+))?\.?$/i.exec(value);
  if (required) {
    const subject = required[1].trim();
    const target = required[2]?.trim();
    return `${subject}${target ? ` required for ${target}` : ' required'}.`;
  }
  return value;
}

function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content)
    ? content
    : (content && typeof content === 'object' && Array.isArray(content.content) ? content.content : null);
  if (parts) {
    return parts.map((c) => {
      if (typeof c === 'string') return c;
      if (c?.type === 'image') return `[image: ${c.mimeType || c.mediaType || c.source?.media_type || 'image'}]`;
      return c?.text ?? '';
    }).filter(Boolean).join('\n');
  }
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).filter(Boolean).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  try { return JSON.stringify(content); } catch { return String(content); }
}

function toolErrorDisplay(value, surface = 'tool') {
  const text = presentErrorText(value, { surface });
  if (/^(?:Search failed|Fetch failed|No first response|The .+ went stale|(?:Web search agent|Agent|Tool) (?:stopped|was cancelled))/i.test(text)) {
    return text;
  }
  return /^error\s*:/i.test(text) ? text : `Error: ${text}`;
}

function toolCallId(call) {
  return call?.id ?? call?.toolCallId ?? call?.tool_call_id ?? call?.call_id;
}

function toolResultCallId(message) {
  return message?.toolCallId
    ?? message?.tool_call_id
    ?? message?.tool_use_id
    ?? message?.call_id
    ?? message?.id;
}

function toolCallName(call) {
  return call?.name ?? call?.function?.name ?? call?.toolName ?? call?.tool_name ?? 'tool';
}

function toolCallArgs(call) {
  return call?.arguments ?? call?.args ?? call?.input ?? call?.function?.arguments;
}

function textBetweenTag(text, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = re.exec(String(text ?? ''));
  return match ? match[1].trim() : '';
}

function stripSyntheticAgentTags(text) {
  const value = String(text ?? '').trim();
  const finalAnswer = textBetweenTag(value, 'final-answer');
  if (finalAnswer) return finalAnswer;
  const taskResult = textBetweenTag(value, 'result');
  if (taskResult) return taskResult;
  return value
    .replace(/<\/?(?:final-answer|task-notification|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>/gi, '')
    .trim();
}

function splitBridgeEnvelope(text) {
  const value = String(text ?? '').trim();
  if (!value) return { head: '', body: '' };
  const match = /\n\s*\n/.exec(value);
  if (!match) return { head: value, body: '' };
  return {
    head: value.slice(0, match.index).trim(),
    body: value.slice(match.index + match[0].length).trim(),
  };
}

function bridgeJobStatusText(parsed) {
  if (!parsed) return '';
  const parts = [];
  if (parsed.status) parts.push(`status: ${parsed.status}`);
  if (parsed.taskId) parts.push(`task_id: ${parsed.taskId}`);
  return parts.join(' · ');
}

function bridgeJobResultText(text, parsed = parseBridgeJob(text)) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  if (parsed?.taskId) {
    const { body } = splitBridgeEnvelope(value);
    const cleanBody = stripSyntheticAgentTags(body);
    if (cleanBody) return cleanBody;
    return bridgeJobStatusText(parsed);
  }
  return stripSyntheticAgentTags(value) || value;
}

function bracketField(text, name) {
  const re = new RegExp(`^\\[${name}:\\s*([^\\]]*)\\]`, 'mi');
  return re.exec(String(text ?? ''))?.[1]?.trim() || '';
}

function parseSyntheticAgentMessage(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const finalAnswer = textBetweenTag(value, 'final-answer');
  if (finalAnswer) {
    return {
      name: 'bridge',
      label: 'final',
      args: { type: 'read', description: 'agent result' },
      result: finalAnswer,
    };
  }
  const shellTaskId = bracketField(value, 'task_id');
  if (shellTaskId) {
    const status = bracketField(value, 'status') || 'done';
    const exit = bracketField(value, 'exit');
    const command = bracketField(value, 'command');
    return {
      name: 'shell',
      label: status,
      args: { type: 'result', task_id: shellTaskId, command },
      result: value,
      isError: /^(failed|error|timeout|cancelled|killed)$/i.test(status) || (exit && exit !== '0' && exit !== 'n/a'),
    };
  }
  const bridgeJob = parseBridgeJob(value);
  if (bridgeJob?.taskId) {
    const label = bridgeJob.status || 'notification';
    const result = bridgeJobResultText(value, bridgeJob);
    return {
      name: 'bridge',
      label,
      args: bridgeArgsWithResultMetadata({ type: bridgeJob.type || 'notification', description: 'agent notification' }, bridgeJob),
      result: result || bridgeJobStatusText(bridgeJob) || 'agent notification',
      isError: /^(failed|error|timeout|cancelled|killed)$/i.test(label),
    };
  }
  if (/<task-notification\b/i.test(value)) {
    const status = textBetweenTag(value, 'status') || 'completed';
    const summary = textBetweenTag(value, 'summary') || `Agent ${status}`;
    const taskId = textBetweenTag(value, 'task-id');
    const result = stripSyntheticAgentTags(value);
    return {
      name: 'bridge',
      label: status,
      taskId,
      summary,
      result: result || summary,
    };
  }
  return null;
}

function normalizeToolName(name) {
  return String(name || 'tool')
    .replace(/^mcp__.*__/, '')
    .replace(/^functions\./, '')
    .replace(/-/g, '_')
    .toLowerCase();
}

function parseToolArgs(args) {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof args === 'object' ? args : {};
}

const BRIDGE_JOB_POLL_MS = 2000;
const BRIDGE_JOB_MAX_POLL_MS = 10 * 60_000;
const yieldToRenderer = () => new Promise((resolve) => setImmediate(resolve));

function parseBridgeJob(text) {
  const value = String(text || '');
  const idMatch = /^bridge task:\s*([^\s]+)/m.exec(value) || /^task_id:\s*([^\s]+)/m.exec(value);
  if (!idMatch) return null;
  const statusMatch = /^status:\s*([^\s(]+)/m.exec(value);
  const typeMatch = /^type:\s*(.+)$/m.exec(value);
  const targetMatch = /^target:\s*(.+)$/m.exec(value);
  const roleMatch = /^(?:agent|role):\s*(.+)$/m.exec(value);
  const presetMatch = /^preset:\s*(.+)$/m.exec(value);
  const modelMatch = /^model:\s*([^/\s]+)\/(.+)$/m.exec(value);
  const effortMatch = /^effort:\s*(.+)$/m.exec(value);
  const fastMatch = /^fast:\s*(on|off|true|false)$/m.exec(value);
  return {
    taskId: idMatch[1],
    status: (statusMatch?.[1] || '').toLowerCase(),
    type: (typeMatch?.[1] || '').trim(),
    target: (targetMatch?.[1] || '').trim(),
    role: (roleMatch?.[1] || '').trim(),
    preset: (presetMatch?.[1] || '').trim(),
    provider: (modelMatch?.[1] || '').trim(),
    model: (modelMatch?.[2] || '').trim(),
    effort: (effortMatch?.[1] || '').trim(),
    fast: fastMatch ? /^(on|true)$/i.test(fastMatch[1]) : undefined,
  };
}

function bridgeArgsWithResultMetadata(args, parsed) {
  if (!parsed) return args;
  const next = { ...(args && typeof args === 'object' ? args : {}) };
  if (parsed.type) next.type = parsed.type;
  if (parsed.taskId) next.task_id = parsed.taskId;
  if (parsed.role) next.role = parsed.role;
  if (parsed.preset) next.preset = parsed.preset;
  if (parsed.provider) next.provider = parsed.provider;
  if (parsed.model) next.model = parsed.model;
  if (parsed.effort) next.effort = parsed.effort;
  if (parsed.fast !== undefined) next.fast = parsed.fast;
  if (!next.tag && parsed.target) {
    const target = parsed.target.split(/\s+/)[0];
    if (target && !target.startsWith('sess_')) next.tag = target;
  }
  return next;
}

export async function createEngineSession({
  provider: providerName,
  model,
  toolMode = 'full',
} = {}) {
  const startedAt = performance.now();
  bootProfile('engine:create:start', { provider: providerName, model, toolMode });
  // Silence provider/session diagnostics so they cannot tear through the
  // alternate-screen React/ink render.
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
  process.env.MIXDOG_QUIET_SESSION_LOG = '1';
  process.env.MIXDOG_QUIET_MCP_LOG = '1';
  process.env.MIXDOG_QUIET_MEMORY_LOG = '1';
  process.env.MIXDOG_PATCH_NATIVE_PREWARM ??= '0';

  const importStartedAt = performance.now();
  const { createMixdogSessionRuntime } = await import(SESSION_RUNTIME_MODULE);
  bootProfile('session-runtime:imported', { ms: (performance.now() - importStartedAt).toFixed(1) });
  const runtime = await createMixdogSessionRuntime({ provider: providerName, model, toolMode });
  bootProfile('engine:create:runtime-ready', { ms: (performance.now() - startedAt).toFixed(1) });
  const cwd = runtime.cwd || process.cwd();
  const stateStartedAt = performance.now();
  const autoClearState = () => runtime.getAutoClear?.() || runtime.autoClear || { enabled: true, idleMs: 60 * 60 * 1000 };
  const bridgeStatusState = () => {
    const status = runtime.bridgeStatus?.() || {};
    return {
      bridgeMode: runtime.bridgeMode || status.bridgeMode || 'async',
      bridgeWorkers: Array.isArray(status.bridgeWorkers) ? status.bridgeWorkers : [],
      bridgeJobs: Array.isArray(status.bridgeJobs) ? status.bridgeJobs : [],
    };
  };
  const routeState = () => ({
    sessionId: runtime.id,
    model: runtime.model,
    provider: runtime.provider,
    effort: runtime.effort,
    effortOptions: runtime.effortOptions,
    fast: runtime.fast,
    fastCapable: runtime.fastCapable,
    contextWindow: runtime.contextWindow,
    rawContextWindow: runtime.rawContextWindow,
    effectiveContextWindowPercent: runtime.effectiveContextWindowPercent,
    cwd: runtime.cwd || process.cwd(),
    autoClear: autoClearState(),
    workflow: runtime.workflow || null,
  });

  const routeStateStartedAt = performance.now();
  const initialRouteState = routeState();
  bootProfile('engine:route-state-ready', { ms: (performance.now() - routeStateStartedAt).toFixed(1) });
  const initialBridgeState = {
    bridgeMode: runtime.bridgeMode || 'async',
    bridgeWorkers: [],
    bridgeJobs: [],
  };
  let state = {
    items: [],
    toasts: [],
    busy: false,
    commandBusy: false,
    spinner: null,
    queued: [],
    thinking: null,
    lastTurn: null,
    stats: createSessionStats(),
    ...initialRouteState,
    ...initialBridgeState,
    toolMode: runtime.toolMode,
    cwd,
  };
  bootProfile('engine:state-ready', { ms: (performance.now() - stateStartedAt).toFixed(1) });
  const syncContextStats = ({ allowEstimated = false } = {}) => {
    const ctx = runtime.contextStatus?.() || null;
    const hasProviderUsage = Number(state.stats.latestPromptTokens || state.stats.latestInputTokens || state.stats.inputTokens || 0) > 0;
    const used = Number(ctx?.usedTokens || ctx?.currentEstimatedTokens || 0);
    if (!allowEstimated && !hasProviderUsage && ctx?.usedSource !== 'last_api_request') return ctx;
    if (Number.isFinite(used) && used > 0) state.stats.currentContextTokens = used;
    state.stats.currentContextSource = ctx?.usedSource || null;
    state.stats.currentContextUpdatedAt = Date.now();
    return ctx;
  };
  const contextStartedAt = performance.now();
  syncContextStats();
  bootProfile('engine:context-ready', { ms: (performance.now() - contextStartedAt).toFixed(1) });
  const listeners = new Set();
  const emit = () => { for (const l of listeners) l(); };
  const set = (patch) => { state = { ...state, ...patch }; emit(); };

  const itemIndexById = new Map();
  const replaceItems = (items) => {
    const nextItems = Array.isArray(items) ? items : [];
    itemIndexById.clear();
    for (let i = 0; i < nextItems.length; i++) {
      const id = nextItems[i]?.id;
      if (id != null) itemIndexById.set(id, i);
    }
    return nextItems;
  };
  const pushItem = (item) => {
    const index = state.items.length;
    const items = [...state.items, item];
    if (item?.id != null) itemIndexById.set(item.id, index);
    set({ items });
  };
  const removeItemsByIds = (ids) => {
    const idSet = new Set((ids || []).filter((id) => id != null));
    if (idSet.size === 0) return false;
    const items = state.items.filter((item) => !idSet.has(item?.id));
    if (items.length === state.items.length) return false;
    set({ items: replaceItems(items) });
    return true;
  };
  const pushUserOrSyntheticItem = (text, id = nextId()) => {
    const synthetic = parseSyntheticAgentMessage(text);
    if (!synthetic) {
      pushItem({ kind: 'user', id, text });
      return;
    }
    const label = synthetic.label || 'notification';
    pushItem({
      kind: 'tool',
      id,
      name: synthetic.name || 'bridge',
      args: synthetic.args || {
        type: label,
        task_id: synthetic.taskId || undefined,
        description: synthetic.summary || 'agent notification',
      },
      result: synthetic.result,
      isError: synthetic.isError ?? /^(failed|error|killed|cancelled)$/i.test(label),
      expanded: false,
      count: 1,
      completedCount: 1,
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
  };
  const pushToast = (text, tone = 'info', ttlMs = 3200) => {
    const id = nextId();
    const value = String(text ?? '').trim();
    if (!value) return null;
    set({ toasts: [...state.toasts.filter((toast) => toast.id !== id), { id, text: value, tone }] });
    const timer = setTimeout(() => {
      toastTimers.delete(timer);
      if (disposed) return;
      set({ toasts: state.toasts.filter((toast) => toast.id !== id) });
    }, ttlMs);
    toastTimers.add(timer);
    timer.unref?.();
    return id;
  };
  const pushNotice = (text, tone = 'info', options = {}) => {
    const value = polishNoticeText(text);
    if (!value) return null;
    const forceTranscript = options.transcript === true;
    const forceToast = options.toast === true;
    const shortEnough = value.length <= 180 && !value.includes('\n');
    if ((forceToast || shortEnough) && !forceTranscript) {
      return pushToast(value, tone, options.ttlMs);
    }
    const id = nextId();
    pushItem({ kind: 'notice', id, text: value, tone });
    return id;
  };
  const patchItem = (id, patch) => {
    let index = itemIndexById.get(id);
    if (!Number.isInteger(index) || state.items[index]?.id !== id) {
      index = state.items.findIndex((it) => it.id === id);
      if (index >= 0) itemIndexById.set(id, index);
    }
    if (index < 0) return false;
    const current = state.items[index];
    let changed = false;
    for (const [key, value] of Object.entries(patch || {})) {
      if (!Object.is(current[key], value)) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    const items = state.items.slice();
    items[index] = { ...current, ...patch };
    set({ items });
    return true;
  };
  const bridgeJobMonitors = new Map();
  const toastTimers = new Set();
  let disposed = false;

  function clearToastTimers() {
    for (const timer of toastTimers) {
      clearTimeout(timer);
    }
    toastTimers.clear();
  }

  let unsubscribeRuntimeNotifications = null;
  let lastUserActivityAt = Date.now();
  let autoClearRunning = false;

  function clearBridgeJobMonitor(taskId) {
    const monitor = bridgeJobMonitors.get(taskId);
    if (!monitor) return;
    if (monitor.timer) clearTimeout(monitor.timer);
    bridgeJobMonitors.delete(taskId);
  }

  function clearBridgeJobMonitors() {
    for (const taskId of [...bridgeJobMonitors.keys()]) clearBridgeJobMonitor(taskId);
  }

  function updateBridgeJobCard(itemId, text, isError = false) {
    const parsed = parseBridgeJob(text);
    const current = state.items.find((it) => it.id === itemId);
    const rawDisplayText = bridgeJobResultText(text, parsed) || String(text || '').trim();
    const displayText = isError ? toolErrorDisplay(rawDisplayText, 'bridge') : rawDisplayText;
    patchItem(itemId, {
      result: displayText,
      text: displayText,
      isError,
      ...(parsed ? { args: bridgeArgsWithResultMetadata(current?.args, parsed) } : {}),
    });
    if (!parsed?.taskId) return;
    if (parsed.status && parsed.status !== 'running') {
      clearBridgeJobMonitor(parsed.taskId);
      return;
    }
    watchBridgeJob(parsed.taskId, itemId);
  }

  function watchBridgeJob(taskId, itemId) {
    if (!taskId || disposed) return;
    const existing = bridgeJobMonitors.get(taskId);
    if (existing) {
      existing.itemId = itemId;
      return;
    }
    const monitor = { itemId, startedAt: Date.now(), timer: null };
    bridgeJobMonitors.set(taskId, monitor);

    const poll = async () => {
      if (disposed || !bridgeJobMonitors.has(taskId)) return;
      if (Date.now() - monitor.startedAt > BRIDGE_JOB_MAX_POLL_MS) {
        clearBridgeJobMonitor(taskId);
        return;
      }
      try {
        const text = String(await runtime.bridgeControl({ type: 'read', task_id: taskId }) || '').trim();
        const parsed = parseBridgeJob(text);
        const nextText = text || '(empty bridge result)';
        const rawDisplayText = bridgeJobResultText(nextText, parsed) || nextText;
        const isError = /^(failed|error|timeout|cancelled|killed)$/i.test(parsed?.status || '') || /^error:/i.test(text);
        const displayText = isError ? toolErrorDisplay(rawDisplayText, 'bridge') : rawDisplayText;
        const current = state.items.find((it) => it.id === monitor.itemId);
        patchItem(monitor.itemId, {
          result: displayText,
          text: displayText,
          isError,
          ...(parsed ? { args: bridgeArgsWithResultMetadata(current?.args, parsed) } : {}),
        });
        set(bridgeStatusState());
        if (!parsed || parsed.status !== 'running') {
          clearBridgeJobMonitor(taskId);
          return;
        }
      } catch (error) {
        const errorText = toolErrorDisplay(error, 'bridge');
        patchItem(monitor.itemId, { result: errorText, text: errorText, isError: true });
        set(bridgeStatusState());
        clearBridgeJobMonitor(taskId);
        return;
      }
      monitor.timer = setTimeout(poll, BRIDGE_JOB_POLL_MS);
      monitor.timer.unref?.();
    };

    monitor.timer = setTimeout(poll, BRIDGE_JOB_POLL_MS);
    monitor.timer.unref?.();
  }

  if (typeof runtime.onNotification === 'function') {
    unsubscribeRuntimeNotifications = runtime.onNotification((event) => {
      if (disposed) return;
      const text = String(event?.content ?? event?.text ?? event ?? '').trim();
      if (!text) return;
      const parsed = parseBridgeJob(text);
      if (parsed?.taskId) {
        const existing = [...state.items].reverse().find((item) => {
          if (!item || item.kind !== 'tool' || item.name !== 'bridge') return false;
          const args = parseToolArgs(item.args);
          return args.task_id === parsed.taskId;
        });
        if (existing) {
          updateBridgeJobCard(existing.id, text, /^(failed|error|timeout|cancelled|killed)$/i.test(parsed.status));
          set(bridgeStatusState());
          return;
        }
      }
      pushUserOrSyntheticItem(text, nextId());
      set(bridgeStatusState());
    });
  }

  function groupedToolResultText(group) {
    const completed = Math.min(group.count, group.completed);
    if (group.count <= 1) return group.results.at(-1)?.text ?? '';
    if (group.errors > 0) {
      const succeeded = Math.max(0, completed - group.errors);
      const reasons = group.results
        .filter((result) => result?.isError)
        .map((result) => firstErrorLine(result?.text))
        .filter(Boolean);
      const uniqueReasons = [...new Set(reasons)].slice(0, 2);
      return [
        `${succeeded} succeeded - ${group.errors} failed${uniqueReasons[0] ? `: ${uniqueReasons[0]}` : ''}`,
        ...uniqueReasons.slice(1),
      ].join('\n');
    }
    return `Completed ${completed}/${group.count}`;
  }

  function firstErrorLine(text) {
    const clean = toolErrorDisplay(text, 'tool');
    if (clean) return clean;
    for (const line of String(text || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^(Error|\[?error|FAIL\b)/i.test(trimmed)) return trimmed;
    }
    return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  }

  function aggregateCompletionText(completed, total, { running = false } = {}) {
    const count = Math.max(0, Number(total || 0));
    const doneCount = Math.max(0, Math.min(count, Number(completed || 0)));
    if (count <= 0) return '';
    if (running && doneCount < count) return `Running ${doneCount}/${count}`;
    return `Completed ${doneCount}/${count}`;
  }

  function aggregateRawResult(calls) {
    const chunks = [];
    for (const rec of calls || []) {
      const text = String(rec?.resultText || '').replace(/\s+$/, '');
      if (!text.trim()) continue;
      const label = String(rec?.name || rec?.category || 'tool').trim() || 'tool';
      chunks.push(`${chunks.length + 1}. ${label}\n${text}`);
    }
    return chunks.join('\n\n');
  }

  function aggregateBucketForCategory(category) {
    switch (category) {
      case 'Read':
      case 'Search':
        return 'local-discovery';
      case 'Web Research':
        return 'web-research';
      case 'Memory':
        return 'memory';
      case 'Explore':
        return 'explore';
      case 'Edit':
        return 'edit';
      default:
        // Shell/Agent/Channel/Setup/Other stay as their own cards so risky or
        // semantically distinct actions do not disappear inside a discovery log.
        return null;
    }
  }

  function aggregateSummaries(aggregate) {
    return [...(aggregate?.calls?.values?.() || [])]
      .filter((r) => r.summary)
      .sort((a, b) => Number(a.summarySeq ?? 0) - Number(b.summarySeq ?? 0))
      .map((r) => r.summary);
  }

  function assignAggregateSummaryOrder(aggregate, callRec) {
    if (!aggregate || !callRec?.summary || callRec.summarySeq != null) return;
    const next = Math.max(0, Number(aggregate.nextSummarySeq || 0));
    callRec.summarySeq = next;
    aggregate.nextSummarySeq = next + 1;
  }

  function patchToolCardResult(card, message, toolGroups, done) {
    if (!card || card.done) return false;
    const callId = toolResultCallId(message) || card.callId;
    if (callId && done.has(callId)) return false;
    const rawText = toolResultText(message?.content);
    const isError = message?.isError === true || message?.toolKind === 'error' || /^\s*\[?error/i.test(rawText);
    const text = isError ? toolErrorDisplay(rawText, card?.name || 'tool') : rawText;

    // Aggregate card handling — collect semantic summaries per call
    const aggregate = card.aggregate;
    if (aggregate && card.itemId === aggregate.itemId) {
      const callRec = callId ? aggregate.calls.get(callId) : null;
      if (callRec) {
        callRec.summary = !isError ? summarizeToolResult(callRec.name, callRec.args, rawText, isError) : null;
        assignAggregateSummaryOrder(aggregate, callRec);
        callRec.isError = isError;
        callRec.resultText = text;
        callRec.resolved = true;
      }
      const allCalls = [...aggregate.calls.values()];
      const completed = allCalls.filter((r) => r.resolved).length;
      const errors = allCalls.filter((r) => r.isError).length;
      const summaries = aggregateSummaries(aggregate);
      let detailText;
      if (errors > 0 && summaries.length === 0) {
        const succeeded = completed - errors;
        detailText = `${succeeded}/${allCalls.length} succeeded - ${errors} failed`;
      } else {
        detailText = formatAggregateDetail(summaries) || aggregateCompletionText(completed, allCalls.length, { running: completed < allCalls.length });
      }
      const currentItem = state.items.find((it) => it.id === card.itemId);
      const visualCompleted = Math.max(completed, Math.min(allCalls.length, Number(currentItem?.completedCount || 0)));
      const rawResult = aggregateRawResult(allCalls);
      patchItem(card.itemId, {
        result: detailText,
        text: detailText,
        rawResult: rawResult || null,
        isError: errors > 0,
        count: allCalls.length,
        completedCount: visualCompleted,
        completedAt: Date.now(),
      });
      card.done = true;
      if (callId) done.add(callId);
      return true;
    }

    // Non-aggregate (legacy bridge-job cards, etc.)
    const group = toolGroups.get(card.itemId) || { count: 1, completed: 0, errors: 0, results: [] };
    group.completed = Math.min(group.count, group.completed + 1);
    group.errors += isError ? 1 : 0;
    group.results.push({ text, isError });
    toolGroups.set(card.itemId, group);
    const resultText = groupedToolResultText(group);
    const patch = {
      result: resultText,
      text: resultText,
      isError: group.errors > 0,
      count: group.count,
      completedCount: group.completed,
      completedAt: Date.now(),
    };
    if (group.count <= 1) {
      const parsedBridge = parseBridgeJob(rawText);
      if (parsedBridge) patch.args = bridgeArgsWithResultMetadata(state.items.find((it) => it.id === card.itemId)?.args, parsedBridge);
    }
    patchItem(card.itemId, patch);
    if (group.count <= 1) updateBridgeJobCard(card.itemId, rawText, isError);
    card.done = true;
    if (callId) done.add(callId);
    return true;
  }

  const flushToolResults = (messages, toolCards, cardByCallId, toolGroups, done, { finalize = false } = {}) => {
    const results = [];
    for (const m of messages || []) {
      if (!m || m.role !== 'tool') continue;
      const callId = toolResultCallId(m);
      results.push({ message: m, callId, used: false });
      if (!callId || done.has(callId)) continue;
      const card = cardByCallId.get(callId);
      if (patchToolCardResult(card, m, toolGroups, done)) {
        results[results.length - 1].used = true;
      }
    }

    const openCards = (toolCards || []).filter((card) => !card.done);
    if (openCards.length === 0) return;

    const unusedResults = results.filter((result) => !result.used);
    const fallbackResults = unusedResults.slice(-openCards.length);
    for (let i = 0; i < fallbackResults.length; i++) {
      const card = openCards[i];
      const result = fallbackResults[i];
      if (!card || !result || card.done) continue;
      if (patchToolCardResult(card, result.message, toolGroups, done)) {
        if (result.callId) done.add(result.callId);
        result.used = true;
      }
    }

    if (!finalize) return;
    for (const card of toolCards || []) {
      if (card.done) continue;
      // Aggregate finalize — mark any remaining calls as done
      const aggregate = card.aggregate;
      if (aggregate && card.itemId === aggregate.itemId) {
        const allCalls = [...aggregate.calls.values()];
        const completed = allCalls.filter((r) => r.resolved).length;
        const remaining = allCalls.length - completed;
        const totalCompleted = remaining > 0 ? completed + remaining : completed;
        const errors = allCalls.filter((r) => r.isError).length;
        const summaries = aggregateSummaries(aggregate);
        const detailText = formatAggregateDetail(summaries) || aggregateCompletionText(totalCompleted, allCalls.length);
        const rawResult = aggregateRawResult(allCalls);
        patchItem(card.itemId, {
          result: detailText,
          text: detailText,
          rawResult: rawResult || null,
          isError: errors > 0,
          count: allCalls.length,
          completedCount: totalCompleted,
          completedAt: Date.now(),
        });
        for (const sibling of toolCards || []) {
          if (sibling.itemId !== card.itemId) continue;
          sibling.done = true;
          if (sibling.callId) done.add(sibling.callId);
        }
        continue;
      }
      // Non-aggregate finalize
      const group = toolGroups.get(card.itemId) || { count: 1, completed: 0, errors: 0, results: [] };
      group.completed = Math.min(group.count, group.completed + 1);
      toolGroups.set(card.itemId, group);
      const resultText = groupedToolResultText(group);
      patchItem(card.itemId, { result: resultText, text: resultText, isError: group.errors > 0, count: group.count, completedCount: group.completed, completedAt: Date.now() });
      card.done = true;
      if (card.callId) done.add(card.callId);
    }
  };

  async function runTurn(userText, options = {}) {
    const turnIndex = state.stats.turns || 0;
    const startedAt = Date.now();
    const inputBaseline = state.stats.inputTokens;
    const outputBaseline = state.stats.outputTokens;
    const submittedIds = Array.isArray(options.submittedIds) ? options.submittedIds : [];
    activePromptRestore = { text: String(userText || '').trim(), restorable: true, submittedIds, reclaimed: false };
    set({ busy: true, lastTurn: null, spinner: { active: true, verb: pickVerb(turnIndex), startedAt, responseLength: 0, inputTokens: 0, outputTokens: 0, mode: 'requesting' } });

    let assistantText = '';
    let currentAssistantId = null;
    let currentAssistantText = '';
    let thinkingText = '';
    let thinkingStartedAt = 0;
    let thinkingSegmentStartedAt = 0;
    let accumulatedThinkingMs = 0;
    let cancelled = false;
    const cardByCallId = new Map();
    const toolCards = [];
    const toolGroups = new Map();
    const resultsDone = new Set();
    const aggregateCards = new Map(); // bucket -> { itemId, categories, categoryOrder, calls, nextSummarySeq }

    const markPromptCommitted = () => {
      if (activePromptRestore) activePromptRestore.restorable = false;
    };

    const completeAggregateVisual = () => {
      for (const aggregate of aggregateCards.values()) {
        const allCalls = [...aggregate.calls.values()];
        if (allCalls.length === 0) continue;
        const errors = allCalls.filter((r) => r.isError).length;
        const summaries = aggregateSummaries(aggregate);
        const detailText = formatAggregateDetail(summaries) || aggregateCompletionText(allCalls.length, allCalls.length);
        const rawResult = aggregateRawResult(allCalls);
        patchItem(aggregate.itemId, {
          result: detailText,
          text: detailText,
          rawResult: rawResult || null,
          isError: errors > 0,
          count: allCalls.length,
          completedCount: allCalls.length,
          completedAt: Date.now(),
        });
      }
    };

    const clearAggregateContinuation = () => {
      completeAggregateVisual();
      aggregateCards.clear();
    };

    const ensureAggregateCard = (bucket) => {
      const existing = aggregateCards.get(bucket);
      if (existing) return existing;
      const itemId = nextId();
      const aggregate = {
        itemId,
        bucket,
        categories: new Map(),
        categoryOrder: [],
        calls: new Map(),
        nextSummarySeq: 0,
      };
      aggregateCards.set(bucket, aggregate);
      pushItem({
        kind: 'tool',
        id: itemId,
        name: '__aggregate__',
        args: { categoryOrder: [] },
        aggregate: true,
        categories: {},
        result: null,
        rawResult: null,
        isError: false,
        expanded: false,
        count: 0,
        completedCount: 0,
        startedAt: Date.now(),
      });
      return aggregate;
    };

    const ensureAssistant = () => {
      if (!currentAssistantId) {
        currentAssistantId = nextId();
        currentAssistantText = '';
        pushItem({ kind: 'assistant', id: currentAssistantId, text: '', streaming: true });
      }
      return currentAssistantId;
    };

    const closeAssistantSegment = () => {
      currentAssistantId = null;
      currentAssistantText = '';
    };

    const startThinkingSegment = () => {
      const now = Date.now();
      if (!thinkingStartedAt) thinkingStartedAt = now;
      if (!thinkingSegmentStartedAt) thinkingSegmentStartedAt = now;
      return now;
    };

    const closeThinkingSegment = () => {
      if (!thinkingSegmentStartedAt) return;
      const now = Date.now();
      accumulatedThinkingMs += Math.max(0, now - thinkingSegmentStartedAt);
      thinkingSegmentStartedAt = 0;
      return now;
    };

    // --- Streaming-delta batcher ---
    // onTextDelta and onReasoningDelta fire on every tiny chunk (often <10 chars).
    // Each call previously called set() → emit() → full React reconcile. We
    // batch accumulated text and flush at most once per STREAM_BATCH_INTERVAL_MS
    // (≈16ms / 60fps cap). A forced flush happens before any tool call,
    // finalization, or error so those code paths see the correct text state.
    const STREAM_BATCH_INTERVAL_MS = 16;
    let _batchTimer = null;
    let _pendingTextFlush = false;   // true when a text/spinner update is queued
    let _pendingThinkFlush = false;  // true when a thinking update is queued
    let _pendingThinkingLastEndedAt = 0;

    const flushStreamBatch = () => {
      if (_batchTimer !== null) {
        clearTimeout(_batchTimer);
        _batchTimer = null;
      }
      if (_pendingTextFlush) {
        _pendingTextFlush = false;
        const id = ensureAssistant();
        // Emit the accumulated assistant text and spinner update together so a
        // streaming batch costs one set() → one emit() → one React reconcile.
        const patch = {};
        const index = state.items.findIndex((it) => it.id === id);
        if (index >= 0) {
          const current = state.items[index];
          if (!Object.is(current.text, currentAssistantText) || current.streaming !== true) {
            const items = state.items.slice();
            items[index] = { ...current, text: currentAssistantText, streaming: true };
            patch.items = items;
          }
        }
        const responseLengthVal = assistantText.length + thinkingText.length;
        if (state.spinner) {
          patch.spinner = { ...state.spinner, responseLength: responseLengthVal, thinking: false, thinkingLastEndedAt: _pendingThinkingLastEndedAt || state.spinner.thinkingLastEndedAt, mode: 'responding' };
        }
        if (Object.keys(patch).length > 0) set(patch);
        _pendingThinkingLastEndedAt = 0;
      }
      if (_pendingThinkFlush) {
        _pendingThinkFlush = false;
        const responseLengthVal = assistantText.length + thinkingText.length;
        const thinkingElapsedMs = accumulatedThinkingMs + (thinkingSegmentStartedAt ? Math.max(0, Date.now() - thinkingSegmentStartedAt) : 0);
        const patch = { thinking: thinkingText };
        if (state.spinner) {
          patch.spinner = { ...state.spinner, responseLength: responseLengthVal, thinking: true, thinkingStartedAt, thinkingSegmentStartedAt, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingElapsedMs, thinkingLastEndedAt: 0, mode: 'thinking' };
        }
        set(patch);
      }
    };

    const scheduleStreamFlush = () => {
      if (_batchTimer !== null) return; // already scheduled; do not re-arm
      _batchTimer = setTimeout(flushStreamBatch, STREAM_BATCH_INTERVAL_MS);
      if (_batchTimer?.unref) _batchTimer.unref(); // don't prevent process exit
    };

    try {
      const { result, session } = await runtime.ask(userText, {
        drainSteering: () => drainPendingSteering(),
        onSteerMessage: (text) => {
          const value = String(text || '').trim();
          if (value) pushUserOrSyntheticItem(value);
        },
        onToolCall: async (_iter, calls) => {
          markPromptCommitted();
          if (thinkingText && state.thinking) {
            const thinkingLastEndedAt = closeThinkingSegment();
            flushStreamBatch(); // flush any buffered text/thinking before the tool card appears
            set({ thinking: null, spinner: state.spinner ? { ...state.spinner, thinking: false, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingLastEndedAt, mode: 'tool-use' } : state.spinner });
          } else if (state.spinner) {
            flushStreamBatch(); // flush any buffered text before the tool card appears
            set({ spinner: { ...state.spinner, mode: 'tool-use' } });
          }
          const batchCalls = (calls || []).filter(Boolean);
          if (batchCalls.length === 0) return;
          closeAssistantSegment();

          const touchedAggregates = new Set();
          for (let i = 0; i < batchCalls.length; i++) {
            const c = batchCalls[i];
            const name = toolCallName(c);
            const args = toolCallArgs(c);
            const category = classifyToolCategory(name, args);
            const bucket = aggregateBucketForCategory(category);
            const callId = toolCallId(c);
            const callKey = callId || `__tool_${toolCards.length}_${i}`;

            if (!bucket) {
              const itemId = nextId();
              pushItem({
                kind: 'tool',
                id: itemId,
                name,
                args,
                result: null,
                isError: false,
                expanded: false,
                count: 1,
                completedCount: 0,
                startedAt: Date.now(),
              });
              const card = { itemId, callId: callKey, done: false };
              if (callId) {
                cardByCallId.set(callId, card);
              }
              toolCards.push(card);
              continue;
            }

            const aggregateCard = ensureAggregateCard(bucket);
            if (!aggregateCard.categories.has(category)) aggregateCard.categoryOrder.push(category);
            aggregateCard.categories.set(category, (aggregateCard.categories.get(category) || 0) + 1);
            aggregateCard.calls.set(callKey, { name, args, category, summary: null, summarySeq: null, isError: false, resultText: null, resolved: false });
            touchedAggregates.add(aggregateCard);
            const card = { itemId: aggregateCard.itemId, callId: callKey, done: false, aggregate: aggregateCard };
            if (callId) {
              cardByCallId.set(callId, card);
            }
            toolCards.push(card);
          }

          for (const aggregateCard of touchedAggregates) {
            patchItem(aggregateCard.itemId, {
              args: { categoryOrder: aggregateCard.categoryOrder.slice() },
              count: aggregateCard.calls.size,
              completedCount: [...aggregateCard.calls.values()].filter((r) => r.resolved).length,
              categories: Object.fromEntries(aggregateCard.categories),
            });
          }
          await yieldToRenderer();
        },
        onToolResult: (message) => {
          flushToolResults([message], toolCards, cardByCallId, toolGroups, resultsDone);
        },
        onStageChange: (stage) => {
          if (!state.spinner) return;
          const value = String(stage || '');
          const mode = value === 'requesting'
            ? 'requesting'
            : value === 'streaming'
              ? (state.spinner.thinking ? 'thinking' : 'responding')
              : null;
          if (!mode || state.spinner.mode === mode) return;
          set({ spinner: { ...state.spinner, mode } });
        },
        onTextDelta: (chunk) => {
          const textChunk = String(chunk ?? '');
          if (!textChunk) return;
          markPromptCommitted();
          const thinkingLastEndedAt = closeThinkingSegment();
          if (state.thinking) set({ thinking: null }); // collapse thinking panel immediately, no batch delay
          if (textChunk.trim()) clearAggregateContinuation();
          assistantText += textChunk;
          ensureAssistant(); // create the assistant item in state immediately so the slot exists
          currentAssistantText += textChunk;
          // Accumulate text; fire at most one render per STREAM_BATCH_INTERVAL_MS.
          _pendingTextFlush = true;
          if (thinkingLastEndedAt) _pendingThinkingLastEndedAt = thinkingLastEndedAt;
          scheduleStreamFlush();
        },
        onReasoningDelta: (chunk) => {
          if (String(chunk ?? '')) markPromptCommitted();
          startThinkingSegment();
          thinkingText += String(chunk ?? '');
          // Accumulate reasoning text; fire at most one render per STREAM_BATCH_INTERVAL_MS.
          _pendingThinkFlush = true;
          scheduleStreamFlush();
        },
        onUsageDelta: (delta) => {
          applyUsageDelta(state.stats, delta);
          syncContextStats();
          const currentTurnInput = Math.max(0, state.stats.inputTokens - inputBaseline);
          const currentTurnOutput = Math.max(0, state.stats.outputTokens - outputBaseline);
          if (state.spinner) {
            set({ stats: { ...state.stats }, spinner: { ...state.spinner, inputTokens: currentTurnInput, outputTokens: currentTurnOutput } });
          } else {
            set({ stats: { ...state.stats } });
          }
        },
      });

      flushToolResults(session?.messages || [], toolCards, cardByCallId, toolGroups, resultsDone, { finalize: true });
      flushStreamBatch(); // force-flush any batched streaming text before finalization writes
      syncContextStats();

      const finalText = (result?.content != null && String(result.content)) || assistantText;
      if (assistantText.trim() && currentAssistantId) {
        patchItem(currentAssistantId, { text: currentAssistantText || assistantText, streaming: false });
      }
      if (finalText && !assistantText.trim()) {
        const id = ensureAssistant();
        currentAssistantText = finalText;
        patchItem(id, { text: finalText, streaming: false });
      }
      state.stats.turns = (state.stats.turns || 0) + 1;
    } catch (error) {
      flushStreamBatch(); // ensure any batched text lands before the error notice
      if (error?.name === 'SessionClosedError') {
        cancelled = true;
        if (assistantText.trim() && currentAssistantId) {
          patchItem(currentAssistantId, { text: currentAssistantText || assistantText, streaming: false });
        }
        // Finalize pending tool cards so they don't stay "Running..." forever
        // after cancellation. Without this, the spinner vanishes and TurnDone
        // shows "cancelled", but in-flight tool cards remain in a perpetual
        // pending/blinking state because the normal finalize path (line 992)
        // was skipped when the error interrupted the try block.
        flushToolResults([], toolCards, cardByCallId, toolGroups, resultsDone, { finalize: true });
      } else {
        pushItem({ kind: 'notice', id: nextId(), text: toolErrorDisplay(error, 'turn'), tone: 'error' });
      }
    } finally {
      const reclaimed = cancelled && activePromptRestore?.reclaimed === true;
      activePromptRestore = null;
      closeThinkingSegment();
      const elapsedMs = Date.now() - startedAt;
      const thinkingElapsedMs = thinkingStartedAt ? accumulatedThinkingMs : 0;
      const finalOutputTokens = Math.max(0, Number(state.spinner?.outputTokens || 0), Math.round(Number(state.spinner?.responseLength || 0) / 4));
      const turnStatus = cancelled ? 'cancelled' : 'done';
      // Pin the post-think summary into the transcript right after this turn's
      // output so it scrolls up with the answer and stays in the scrollback,
      // mirroring Claude Code. (Previously TurnDone rendered only in the
      // bottom-fixed live-status slot and vanished on the next turn.)
      if (!reclaimed) {
        pushItem({ kind: 'turndone', id: nextId(), elapsedMs, status: turnStatus, outputTokens: finalOutputTokens, thinkingElapsedMs, verb: pickDoneVerb(turnIndex) });
      }
      set({
        busy: false,
        spinner: null,
        thinking: null,
        lastTurn: null,
        stats: { ...state.stats },
        ...routeState(),
        toolMode: runtime.toolMode,
        ...bridgeStatusState(),
      });
    }
    return cancelled ? 'cancelled' : 'done';
  }

  const pending = [];
  let draining = false;
  let activePromptRestore = null;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        // Drain the WHOLE queue at once and merge into a single turn, so
        // multiple steering messages (including duplicates) are sent together
        // instead of running one isolated turn each. Anything enqueued while
        // this turn runs is picked up — again merged — on the next loop pass.
        const batch = pending.splice(0);
        const ids = new Set(batch.map((e) => e.id));
        set({ queued: state.queued.filter((q) => !ids.has(q.id)) });
        const merged = batch
          .map((entry) => entry.text)
          .filter((text) => String(text || '').trim())
          .join('\n');
        for (const entry of batch) {
          pushUserOrSyntheticItem(entry.text, entry.id);
        }
        const turnStatus = await runTurn(merged, { submittedIds: [...ids] });
        // If the user re-submits the reclaimed prompt while the cancelled turn
        // is still unwinding, enqueue() cannot start another drain because this
        // drain loop is still active. Continue when pending work appeared during
        // cancellation so the fresh submit does not get stuck in queued state.
        if (turnStatus === 'cancelled' && pending.length === 0) break;
      }
    } finally {
      draining = false;
    }
  }
  function enqueue(text) {
    const entry = { id: nextId(), text };
    pending.push(entry);
    set({ queued: [...state.queued, entry] });
    void drain();
  }

  function drainPendingSteering() {
    if (pending.length === 0) return [];
    const batch = pending.splice(0);
    const ids = new Set(batch.map((entry) => entry.id));
    set({ queued: state.queued.filter((q) => !ids.has(q.id)) });
    return batch
      .map((entry) => String(entry.text || '').trim())
      .filter(Boolean);
  }

  async function autoClearBeforeSubmit() {
    const cfg = autoClearState();
    const now = Date.now();
    const idleMs = now - lastUserActivityAt;
    if (!cfg.enabled || state.busy || pending.length > 0 || autoClearRunning || idleMs < cfg.idleMs) {
      lastUserActivityAt = now;
      return false;
    }
    autoClearRunning = true;
    try {
      await runtime.clear();
      resetStats();
      const idleLabel = formatIdleDuration(idleMs);
      const thresholdLabel = formatIdleDuration(cfg.idleMs);
      set({
        items: replaceItems([]),
        toasts: [],
        queued: [],
        thinking: null,
        spinner: null,
        lastTurn: null,
        ...routeState(),
        stats: { ...state.stats },
      });
      pushNotice(
        `auto-cleared after ${idleLabel} idle (threshold ${thresholdLabel}). Use /recall <topic> if you need older context.`,
        'info',
        { transcript: true },
      );
      return true;
    } catch (error) {
      pushNotice(`auto-clear failed: ${error?.message || error}`, 'error');
      return false;
    } finally {
      lastUserActivityAt = Date.now();
      autoClearRunning = false;
    }
  }

  function restoreQueued(currentText = '') {
    const queued = pending.splice(0);
    set({ queued: [] });
    const queuedText = queued.map((item) => item.text).filter((text) => String(text || '').trim()).join('\n');
    const combinedText = [queuedText, String(currentText || '')].filter((text) => text.trim()).join('\n');
    return { count: queued.length, text: combinedText };
  }

  const resetStats = () => {
    const fresh = createSessionStats();
    for (const k of Object.keys(fresh)) state.stats[k] = fresh[k];
  };

  return {
    getState: () => state,
    patchItem,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit: (text) => {
      const t = String(text ?? '').trim();
      if (!t || state.commandBusy) return false;
      if (state.busy) {
        enqueue(t);
        return true;
      }
      void autoClearBeforeSubmit().then(() => enqueue(t));
      return true;
    },
    restoreQueued,
    setModel: async (m) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        await runtime.setRoute({ model: m });
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    setEffort: async (value) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        await runtime.setEffort(value);
        set({ ...routeState() });
        return runtime.effort || 'auto';
      } finally {
        set({ commandBusy: false });
      }
    },
    setFast: async (value) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const enabled = await runtime.setFast(value);
        set({ ...routeState() });
        return enabled;
      } finally {
        set({ commandBusy: false });
      }
    },
    toggleFast: async () => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const enabled = await runtime.toggleFast();
        set({ ...routeState() });
        return enabled;
      } finally {
        set({ commandBusy: false });
      }
    },
    setToolMode: (m) => {
      void runtime.setToolMode(m)
        .then(() => {
          resetStats();
          set({ ...routeState(), toolMode: runtime.toolMode, stats: { ...state.stats } });
        })
        .catch((error) => pushNotice(toolErrorDisplay(error, 'tool'), 'error'));
    },
    toggleBridgeMode: () => {
      const mode = runtime.toggleBridgeMode();
      set(bridgeStatusState());
      pushNotice(`bridge mode -> ${mode}`, 'info');
      return mode;
    },
    setBridgeMode: (mode) => {
      const next = runtime.setBridgeMode(mode);
      set(bridgeStatusState());
      return next;
    },
    getAutoClear: () => autoClearState(),
    setAutoClear: (input = {}) => {
      const next = runtime.setAutoClear?.(input) || autoClearState();
      set({ autoClear: next });
      return next;
    },
    bridgeControl: async (args = {}) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.bridgeControl(args);
        const text = String(result || '').trim() || '(empty bridge result)';
        const itemId = nextId();
        pushItem({
          kind: 'tool',
          id: itemId,
          name: 'bridge',
          args,
          result: null,
          isError: false,
          expanded: false,
          count: 1,
          completedCount: 0,
          startedAt: Date.now(),
        });
        updateBridgeJobCard(itemId, text, /^error:/i.test(text));
        set(bridgeStatusState());
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    toolsStatus: (query = '') => {
      return runtime.toolsStatus?.(query) || { mode: state.toolMode, count: 0, activeCount: 0, tools: [] };
    },
    selectTools: (names) => {
      const result = runtime.selectTools?.(names) || { added: [], already: [], blocked: [], missing: [] };
      const added = result.added?.length ? `added ${result.added.join(', ')}` : '';
      const already = result.already?.length ? `already ${result.already.join(', ')}` : '';
      const blocked = result.blocked?.length ? `blocked ${result.blocked.map((row) => row.name).join(', ')}` : '';
      const missing = result.missing?.length ? `missing ${result.missing.join(', ')}` : '';
      pushNotice(
        [added, already, blocked, missing].filter(Boolean).join(' - ') || 'no tool changes',
        result.blocked?.length || result.missing?.length ? 'warn' : 'info',
      );
      return result;
    },
    setCwd: (path) => {
      const next = runtime.setCwd(path);
      set({ cwd: next });
      pushNotice(`cwd -> ${next}`, 'info');
      return next;
    },
    mcpStatus: () => {
      return runtime.mcpStatus?.() || { servers: [], configuredCount: 0, connectedCount: 0, failedCount: 0 };
    },
    reconnectMcp: async () => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.reconnectMcp?.();
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(
          `mcp reconnect: ${status?.connectedCount || 0}/${status?.configuredCount || 0} connected${status?.failedCount ? ` - ${status.failedCount} failed` : ''}`,
          status?.failedCount ? 'warn' : 'info',
        );
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    addMcpServer: async (input) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.addMcpServer?.(input);
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`mcp added: ${result?.name || input?.name || 'server'}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    removeMcpServer: async (name) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.removeMcpServer?.(name);
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`mcp removed: ${name}`, 'info');
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    setMcpServerEnabled: async (name, enabled) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.setMcpServerEnabled?.(name, enabled);
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`mcp ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    skillsStatus: () => {
      return runtime.skillsStatus?.() || { cwd: state.cwd, count: 0, skills: [] };
    },
    skillContent: (name) => {
      return runtime.skillContent?.(name);
    },
    addSkill: async (input) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.addSkill?.(input);
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`skill added: ${result?.skill?.name || input?.name || 'skill'}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    reloadSkills: async () => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.reloadSkills?.();
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`skills reload: ${status?.count || 0} available`, 'info');
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    pluginsStatus: () => {
      return runtime.pluginsStatus?.() || { count: 0, plugins: [] };
    },
    reloadPlugins: async () => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.reloadPlugins?.();
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`plugins reload: ${status?.count || 0} detected`, 'info');
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    addPlugin: async (source) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.addPlugin?.(source);
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`plugin added: ${result?.plugin?.title || result?.plugin?.name || source}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    updatePlugin: async (plugin) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.updatePlugin?.(plugin);
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`plugin updated: ${result?.plugin?.title || result?.plugin?.name || plugin?.name || plugin}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    removePlugin: async (plugin) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.removePlugin?.(plugin);
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`plugin uninstalled: ${result?.plugin?.title || result?.plugin?.name || plugin?.name || plugin}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    enablePluginMcp: async (plugin) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.enablePluginMcp?.(plugin);
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`plugin MCP enabled: ${result?.serverName || plugin?.name || 'plugin'}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    hooksStatus: () => {
      return runtime.hooksStatus?.() || { enabled: false, events: [], recent: [] };
    },
    contextStatus: () => {
      return runtime.contextStatus?.() || null;
    },
    addHookRule: (rule) => {
      const rules = runtime.addHookRule?.(rule) || [];
      pushNotice(`hook rule added (${rules.length} total)`, 'info');
      return rules;
    },
    setHookRuleEnabled: (index, enabled) => {
      const rules = runtime.setHookRuleEnabled?.(index, enabled) || [];
      pushNotice(`hook rule ${index + 1} ${enabled ? 'enabled' : 'disabled'}`, 'info');
      return rules;
    },
    deleteHookRule: (index) => {
      const rules = runtime.deleteHookRule?.(index) || [];
      pushNotice(`hook rule ${index + 1} deleted`, 'info');
      return rules;
    },
    memoryControl: async (args = {}, options = {}) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.memoryControl(args);
        const text = String(result || '').trim() || '(empty memory result)';
        if (!options.silent) {
          pushItem({ kind: 'notice', id: nextId(), text, tone: 'info' });
        }
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    recall: async (query, args = {}) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.recall(query, args);
        pushItem({ kind: 'notice', id: nextId(), text: String(result || '').trim() || '(empty recall result)', tone: 'info' });
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    compact: async () => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        return await runtime.compact();
      } finally {
        set({ commandBusy: false });
      }
    },
    abort: () => {
      if (!state.busy) return false;
      const restoreText = activePromptRestore?.restorable ? activePromptRestore.text : '';
      const aborted = runtime.abort('cli-react-abort');
      if (activePromptRestore) {
        if (restoreText && aborted !== false) {
          activePromptRestore.reclaimed = true;
          const idSet = new Set((activePromptRestore.submittedIds || []).filter((id) => id != null));
          const patch = { spinner: null, thinking: null, lastTurn: null };
          if (idSet.size > 0) {
            const items = state.items.filter((item) => !idSet.has(item?.id));
            if (items.length !== state.items.length) {
              patch.items = replaceItems(items);
            }
          }
          set(patch);
        }
        activePromptRestore.restorable = false;
      }
      return { aborted, restoreText };
    },
    listPresets: () => {
      return runtime.listPresets();
    },
    listProviderModels: (options = {}) => {
      return runtime.listProviderModels(options);
    },
    listAgents: () => {
      return runtime.listAgents?.() || [];
    },
    listWorkflows: () => {
      return runtime.listWorkflows?.() || [];
    },
    setWorkflow: async (workflowId) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = runtime.setWorkflow?.(workflowId);
        set({ ...routeState(), stats: { ...state.stats } });
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    setAgentRoute: async (agentId, opts) => {
      return await runtime.setAgentRoute?.(agentId, opts);
    },
    listProviders: () => {
      return runtime.listProviders();
    },
    getProviderSetup: () => {
      return runtime.getProviderSetup();
    },
    getUsageDashboard: async (options = {}) => {
      return await runtime.getUsageDashboard?.(options);
    },
    getOnboardingStatus: () => {
      return runtime.getOnboardingStatus?.() || { completed: true, workflowRoutes: {} };
    },
    completeOnboarding: async (payload = {}) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.completeOnboarding?.(payload);
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice('first-run setup saved', 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    loginOAuthProvider: async (provider) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        const result = await runtime.loginOAuthProvider(provider);
        pushNotice(`provider oauth ok: ${result.provider}`, 'info');
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    saveProviderApiKey: (provider, secret) => {
      const result = runtime.saveProviderApiKey(provider, secret);
      pushNotice(`provider api key saved: ${result.provider}`, 'info');
      return true;
    },
    saveOpenCodeGoUsageAuth: (opts) => {
      const result = runtime.saveOpenCodeGoUsageAuth(opts);
      pushNotice(result.workspaceId
        ? `OpenCode Go usage auth saved: ${result.workspaceId}`
        : 'OpenCode Go usage auth saved',
        'info');
      return true;
    },
    saveOpenAIUsageSessionKey: (secret) => {
      runtime.saveOpenAIUsageSessionKey(secret);
      pushNotice('OpenAI usage auth saved', 'info');
      return true;
    },
    setLocalProvider: (provider, opts) => {
      const result = runtime.setLocalProvider(provider, opts);
      pushNotice(`local provider ${result.enabled ? 'enabled' : 'disabled'}: ${result.provider}`, 'info');
      return true;
    },
    authenticateProvider: async (provider, secret) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        const result = await runtime.authenticateProvider(provider, secret);
        pushNotice(`provider auth ok: ${result.provider} (${result.type})`, 'info');
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    forgetProviderAuth: (provider) => {
      const result = runtime.forgetProviderAuth(provider);
      pushNotice(`provider auth forgotten: ${result.provider}`, 'info');
      return true;
    },
    getChannelSetup: () => {
      return runtime.getChannelSetup();
    },
    saveDiscordToken: (token) => {
      const result = runtime.saveDiscordToken(token);
      pushNotice('discord token saved', 'info');
      return result;
    },
    forgetDiscordToken: () => {
      const result = runtime.forgetDiscordToken();
      pushNotice('discord token forgotten', 'info');
      return result;
    },
    saveWebhookAuthtoken: (token) => {
      const result = runtime.saveWebhookAuthtoken(token);
      pushNotice('webhook/ngrok authtoken saved', 'info');
      return result;
    },
    forgetWebhookAuthtoken: () => {
      const result = runtime.forgetWebhookAuthtoken();
      pushNotice('webhook/ngrok authtoken forgotten', 'info');
      return result;
    },
    saveChannel: (entry) => {
      const result = runtime.saveChannel(entry);
      pushNotice(`channel saved: ${entry.name}`, 'info');
      return result;
    },
    deleteChannel: (name) => {
      const result = runtime.deleteChannel(name);
      pushNotice(`channel deleted: ${name}`, 'info');
      return result;
    },
    setWebhookConfig: (patch) => {
      const result = runtime.setWebhookConfig(patch);
      pushNotice('webhook config updated', 'info');
      return result;
    },
    saveSchedule: (entry) => {
      const result = runtime.saveSchedule(entry);
      pushNotice(`schedule saved: ${result.name}`, 'info');
      return result;
    },
    deleteSchedule: (name) => {
      const result = runtime.deleteSchedule(name);
      pushNotice(`schedule deleted: ${name}`, 'info');
      return result;
    },
    setScheduleEnabled: (name, enabled) => {
      const result = runtime.setScheduleEnabled(name, enabled);
      pushNotice(`schedule ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
      return result;
    },
    saveWebhook: (entry) => {
      const result = runtime.saveWebhook(entry);
      pushNotice(`webhook saved: ${result.name}`, 'info');
      return result;
    },
    deleteWebhook: (name) => {
      const result = runtime.deleteWebhook(name);
      pushNotice(`webhook deleted: ${name}`, 'info');
      return result;
    },
    setWebhookEnabled: (name, enabled) => {
      const result = runtime.setWebhookEnabled(name, enabled);
      pushNotice(`webhook ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
      return result;
    },
    setRoute: async (opts) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        await runtime.setRoute(opts);
        resetStats();
        set({ ...routeState(), stats: { ...state.stats } });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    pushNotice,
    clear: async () => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      clearToastTimers();
      try {
        await runtime.clear();
        resetStats();
        set({ items: replaceItems([]), toasts: [], queued: [], thinking: null, spinner: null, lastTurn: null, ...routeState(), stats: { ...state.stats } });
        lastUserActivityAt = Date.now();
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    listSessions: () => {
      return runtime.listSessions();
    },
    newSession: async () => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      clearToastTimers();
      try {
        await runtime.newSession();
        resetStats();
        set({ items: replaceItems([]), toasts: [], queued: [], thinking: null, lastTurn: null, ...routeState(), stats: { ...state.stats } });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    resume: async (id) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      clearToastTimers();
      try {
        const r = await runtime.resume(id);
        if (!r) return false;
        const items = [];
        for (const m of r.messages || []) {
          if (m.role === 'user') {
            // content may be a string OR an array of parts (text/tool-call
            // interleaving) — toolResultText coerces both to readable text so
            // array-content messages aren't silently dropped.
            const text = (typeof m.content === 'string' ? m.content : toolResultText(m.content)).trim();
            if (text) {
              const synthetic = parseSyntheticAgentMessage(text);
              if (synthetic) {
                const label = synthetic.label || 'notification';
                items.push({
                  kind: 'tool',
                  id: nextId(),
                  name: synthetic.name || 'bridge',
                  args: synthetic.args || {
                    type: label,
                    task_id: synthetic.taskId || undefined,
                    description: synthetic.summary || 'agent notification',
                  },
                  result: synthetic.result,
                  isError: synthetic.isError ?? /^(failed|error|killed|cancelled)$/i.test(label),
                  expanded: false,
                  count: 1,
                  completedCount: 1,
                  startedAt: Date.now(),
                  completedAt: Date.now(),
                });
              } else {
                items.push({ kind: 'user', id: nextId(), text });
              }
            }
          } else if (m.role === 'assistant') {
            const text = (typeof m.content === 'string' ? m.content : toolResultText(m.content)).trim();
            if (text) items.push({ kind: 'assistant', id: nextId(), text });
          }
        }
        set({
          items: replaceItems(items),
          toasts: [],
          queued: [],
          thinking: null,
          spinner: null,
          lastTurn: null,
          ...routeState(),
          stats: { ...state.stats },
        });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    dispose: async (reason = 'cli-react-exit', options = {}) => {
      if (disposed) return;
      disposed = true;
      clearToastTimers();
      try { unsubscribeRuntimeNotifications?.(); } catch {}
      unsubscribeRuntimeNotifications = null;
      clearBridgeJobMonitors();
      await runtime.close(reason, options);
      listeners.clear();
    },
  };
}
