/**
 * src/tui/engine.mjs - the engine<->React bridge (React-free).
 *
 * Runs mixdog's session manager outside React and exposes a tiny subscribable
 * store. The React/ink layer consumes it via useSyncExternalStore
 * (see hooks/useEngine.mjs).
 */
import { performance } from 'node:perf_hooks';
import { SPINNER_VERBS } from './spinner-verbs.mjs';

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
  return `${Math.round(value / 1000)}s`;
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

function toolGroupKey(name, args) {
  const normalized = normalizeToolName(name);
  switch (normalized) {
    case 'read':
    case 'view_image':
    case 'read_mcp_resource':
      return 'read';
    case 'write':
    case 'edit':
    case 'apply_patch':
      return 'update';
    case 'grep':
    case 'glob':
    case 'search':
    case 'tool_search':
      return 'search';
    case 'web_fetch':
    case 'fetch':
    case 'download_attachment':
    case 'crawl':
      return 'fetch';
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
    case 'trigger_schedule':
      return 'run';
    case 'list':
    case 'ls':
      return 'list';
    case 'memory':
    case 'remember':
    case 'save_memory':
    case 'update_memory':
    case 'recall_memory':
    case 'recall':
    case 'search_memories':
      return 'memory';
    case 'bridge':
    case 'agent':
    case 'task':
      return 'agent';
    case 'diagnostics':
    case 'open_config':
    case 'provider_status':
    case 'channel_status':
    case 'schedule_status':
    case 'schedule_control':
    case 'reload_config':
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
    case 'cwd':
    case 'setup':
      return 'setup';
    case 'request_user_input':
      return 'ask_user';
    case 'update_plan':
      return 'plan';
    case 'reply':
    case 'react':
    case 'edit_message':
    case 'activate_channel_bridge':
    case 'inject_command':
      return 'channel';
    case 'code_graph': {
      const a = parseToolArgs(args);
      const mode = String(a.mode || a.action || '').toLowerCase();
      if (mode === 'search' || mode === 'find_symbol' || mode === 'references' || mode === 'callers' || mode === 'callees') return 'search';
      if (mode === 'prewarm' || mode === 'index' || mode === 'build' || mode === 'refresh') return 'setup';
      return 'read';
    }
    default:
      return `tool:${normalized}`;
  }
}

const BRIDGE_JOB_POLL_MS = 2000;
const BRIDGE_JOB_MAX_POLL_MS = 10 * 60_000;
const yieldToRenderer = () => new Promise((resolve) => setImmediate(resolve));

function parseBridgeJob(text) {
  const value = String(text || '');
  const idMatch = /^bridge job:\s*(job_[^\s]+)/m.exec(value);
  if (!idMatch) return null;
  const statusMatch = /^status:\s*([^\s(]+)/m.exec(value);
  return {
    jobId: idMatch[1],
    status: (statusMatch?.[1] || '').toLowerCase(),
  };
}

function extractBridgeJobReport(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const parsed = parseBridgeJob(value);
  if (!parsed || parsed.status !== 'done') return '';
  const split = /\n\s*\n/.exec(value);
  if (!split) return '';
  return value.slice(split.index + split[0].length).trim();
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
  const autoClearState = () => runtime.getAutoClear?.() || runtime.autoClear || { enabled: true, idleMs: 60 * 60 * 1000 };
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
  });

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
    ...routeState(),
    toolMode: runtime.toolMode,
    bridgeMode: runtime.bridgeMode,
    cwd,
  };
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
  syncContextStats();
  const listeners = new Set();
  const emit = () => { for (const l of listeners) l(); };
  const set = (patch) => { state = { ...state, ...patch }; emit(); };

  const pushItem = (item) => set({ items: [...state.items, item] });
  const pushToast = (text, tone = 'info', ttlMs = 3200) => {
    const id = nextId();
    const value = String(text ?? '').trim();
    if (!value) return null;
    set({ toasts: [...state.toasts.filter((toast) => toast.id !== id), { id, text: value, tone }] });
    const timer = setTimeout(() => {
      if (disposed) return;
      set({ toasts: state.toasts.filter((toast) => toast.id !== id) });
    }, ttlMs);
    timer.unref?.();
    return id;
  };
  const pushNotice = (text, tone = 'info', options = {}) => {
    const value = String(text ?? '').trim();
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
  const patchItem = (id, patch) =>
    set({ items: state.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  const bridgeJobMonitors = new Map();
  const injectedBridgeJobs = new Set();
  let disposed = false;
  let lastUserActivityAt = Date.now();
  let autoClearRunning = false;

  function clearBridgeJobMonitor(jobId) {
    const monitor = bridgeJobMonitors.get(jobId);
    if (!monitor) return;
    if (monitor.timer) clearTimeout(monitor.timer);
    bridgeJobMonitors.delete(jobId);
  }

  function clearBridgeJobMonitors() {
    for (const jobId of [...bridgeJobMonitors.keys()]) clearBridgeJobMonitor(jobId);
  }

  function updateBridgeJobCard(itemId, text, isError = false) {
    patchItem(itemId, { result: text, text, isError });
    const parsed = parseBridgeJob(text);
    if (!parsed?.jobId) return;
    if (parsed.status && parsed.status !== 'running') {
      clearBridgeJobMonitor(parsed.jobId);
      return;
    }
    watchBridgeJob(parsed.jobId, itemId);
  }

  function watchBridgeJob(jobId, itemId) {
    if (!jobId || disposed) return;
    const existing = bridgeJobMonitors.get(jobId);
    if (existing) {
      existing.itemId = itemId;
      return;
    }
    const monitor = { itemId, startedAt: Date.now(), timer: null };
    bridgeJobMonitors.set(jobId, monitor);

    const poll = async () => {
      if (disposed || !bridgeJobMonitors.has(jobId)) return;
      if (Date.now() - monitor.startedAt > BRIDGE_JOB_MAX_POLL_MS) {
        clearBridgeJobMonitor(jobId);
        return;
      }
      try {
        const text = String(await runtime.bridgeControl({ type: 'read', jobId }) || '').trim();
        const parsed = parseBridgeJob(text);
        const nextText = text || '(empty bridge result)';
        patchItem(monitor.itemId, { result: nextText, text: nextText, isError: /^error:/i.test(text) });
        if (!parsed || parsed.status !== 'running') {
          clearBridgeJobMonitor(jobId);
          const report = extractBridgeJobReport(text);
          if (report && !injectedBridgeJobs.has(jobId)) {
            injectedBridgeJobs.add(jobId);
            enqueue(report);
          }
          return;
        }
      } catch (error) {
        const errorText = `[error] ${error?.message || error}`;
        patchItem(monitor.itemId, { result: errorText, text: errorText, isError: true });
        clearBridgeJobMonitor(jobId);
        return;
      }
      monitor.timer = setTimeout(poll, BRIDGE_JOB_POLL_MS);
      monitor.timer.unref?.();
    };

    monitor.timer = setTimeout(poll, BRIDGE_JOB_POLL_MS);
    monitor.timer.unref?.();
  }

  function groupedToolResultText(group) {
    const completed = Math.min(group.count, group.completed);
    if (group.count <= 1) return group.results.at(-1)?.text ?? '';
    if (group.errors > 0) {
      return `${completed}/${group.count} completed · ${group.errors} error${group.errors === 1 ? '' : 's'}`;
    }
    return `${completed}/${group.count} completed`;
  }

  function patchToolCardResult(card, message, toolGroups, done) {
    if (!card || card.done) return false;
    const callId = toolResultCallId(message) || card.callId;
    if (callId && done.has(callId)) return false;
    const text = toolResultText(message?.content);
    const isError = message?.isError === true || message?.toolKind === 'error' || /^\s*\[?error/i.test(text);
    const group = toolGroups.get(card.itemId) || { count: 1, completed: 0, errors: 0, results: [] };
    group.completed = Math.min(group.count, group.completed + 1);
    group.errors += isError ? 1 : 0;
    group.results.push({ text, isError });
    toolGroups.set(card.itemId, group);
    const resultText = groupedToolResultText(group);
    patchItem(card.itemId, {
      result: resultText,
      text: resultText,
      isError: group.errors > 0,
      count: group.count,
      completedCount: group.completed,
      completedAt: Date.now(),
    });
    if (group.count <= 1) updateBridgeJobCard(card.itemId, text, isError);
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
      const group = toolGroups.get(card.itemId) || { count: 1, completed: 0, errors: 0, results: [] };
      group.completed = Math.min(group.count, group.completed + 1);
      toolGroups.set(card.itemId, group);
      const resultText = groupedToolResultText(group);
      patchItem(card.itemId, { result: resultText, text: resultText, isError: group.errors > 0, count: group.count, completedCount: group.completed, completedAt: Date.now() });
      card.done = true;
      if (card.callId) done.add(card.callId);
    }
  };

  async function runTurn(userText) {
    const turnIndex = state.stats.turns || 0;
    const startedAt = Date.now();
    const inputBaseline = state.stats.inputTokens;
    const outputBaseline = state.stats.outputTokens;
    set({ busy: true, lastTurn: null, spinner: { active: true, verb: pickVerb(turnIndex), startedAt, liveTokens: 0, inputTokens: 0, outputTokens: 0, mode: 'requesting' } });

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
    let lastToolGroupCard = null;
    let lastToolGroupKey = null;

    const clearToolGroupContinuation = () => {
      lastToolGroupCard = null;
      lastToolGroupKey = null;
    };

    const lastVisibleToolGroupCard = (groupKey) => {
      const previous = state.items[state.items.length - 1];
      if (!previous || previous.kind !== 'tool' || previous.isError) return null;
      if (toolGroupKey(previous.name, previous.args) !== groupKey) return null;
      const group = toolGroups.get(previous.id);
      if (!group) return null;
      return {
        itemId: previous.id,
        key: groupKey,
        count: Math.max(0, Number(previous.count || group.count || 0)),
        names: [previous.name].filter(Boolean),
        firstName: previous.name,
        firstArgs: previous.args,
      };
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

    try {
      const { result, session } = await runtime.ask(userText, {
        drainSteering: () => drainPendingSteering(),
        onSteerMessage: (text) => {
          const value = String(text || '').trim();
          if (value) pushItem({ kind: 'user', id: nextId(), text: value });
        },
        onToolCall: async (_iter, calls) => {
          if (thinkingText && state.thinking) {
            const thinkingLastEndedAt = closeThinkingSegment();
            set({ thinking: null, spinner: state.spinner ? { ...state.spinner, thinking: false, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingLastEndedAt, mode: 'tool-use' } : state.spinner });
          } else if (state.spinner) {
            set({ spinner: { ...state.spinner, mode: 'tool-use' } });
          }
          const batchCalls = (calls || []).filter(Boolean);
          if (batchCalls.length === 0) return;
          closeAssistantSegment();
          let activeGroupKey = null;
          let activeGroupCard = null;
          let lastKeyInBatch = null;
          let lastCardInBatch = null;
          for (let i = 0; i < batchCalls.length; i++) {
            const c = batchCalls[i];
            const name = toolCallName(c);
            const args = toolCallArgs(c);
            const groupKey = toolGroupKey(name, args);
            let groupCard = groupKey === activeGroupKey ? activeGroupCard : null;
            if (!groupCard) {
              if (i === 0 && groupKey === lastToolGroupKey && lastToolGroupCard) {
                groupCard = lastToolGroupCard;
              } else {
                groupCard = i === 0 ? lastVisibleToolGroupCard(groupKey) : null;
                if (!groupCard) {
                  const itemId = nextId();
                  groupCard = { itemId, key: groupKey, count: 0, names: [], firstName: name, firstArgs: args };
                  toolGroups.set(itemId, { count: 0, completed: 0, errors: 0, results: [] });
                  pushItem({
                    kind: 'tool',
                    id: itemId,
                    name,
                    args,
                    result: null,
                    isError: false,
                    expanded: false,
                    count: 0,
                    completedCount: 0,
                    startedAt: Date.now(),
                  });
                }
              }
              activeGroupKey = groupKey;
              activeGroupCard = groupCard;
            }
            if (!groupCard.names.includes(name)) groupCard.names.push(name);
            const callId = toolCallId(c);
            groupCard.count += 1;
            const group = toolGroups.get(groupCard.itemId) || { count: 0, completed: 0, errors: 0, results: [] };
            group.count = groupCard.count;
            toolGroups.set(groupCard.itemId, group);
            const card = { itemId: groupCard.itemId, callId, done: false };
            if (callId) cardByCallId.set(callId, card);
            toolCards.push(card);
            patchItem(groupCard.itemId, {
              name: groupCard.firstName || name,
              args: groupCard.firstArgs ?? args,
              count: groupCard.count,
              completedCount: group.completed,
            });
            lastKeyInBatch = groupKey;
            lastCardInBatch = groupCard;
          }
          if (lastKeyInBatch) {
            lastToolGroupKey = lastKeyInBatch;
            lastToolGroupCard = lastCardInBatch;
          }
          await yieldToRenderer();
        },
        onToolResult: (message) => {
          flushToolResults([message], toolCards, cardByCallId, toolGroups, resultsDone);
        },
        onTextDelta: (chunk) => {
          const textChunk = String(chunk ?? '');
          if (!textChunk) return;
          const thinkingLastEndedAt = closeThinkingSegment();
          if (state.thinking) set({ thinking: null });
          if (textChunk.trim()) clearToolGroupContinuation();
          assistantText += textChunk;
          const id = ensureAssistant();
          currentAssistantText += textChunk;
          patchItem(id, { text: currentAssistantText, streaming: true });
          const estimatedTokens = Math.round(assistantText.length / 4);
          if (state.spinner) {
            set({ spinner: { ...state.spinner, liveTokens: estimatedTokens, thinking: false, thinkingLastEndedAt: thinkingLastEndedAt || state.spinner.thinkingLastEndedAt, mode: 'responding' } });
          }
        },
        onReasoningDelta: (chunk) => {
          startThinkingSegment();
          thinkingText += String(chunk ?? '');
          const estimatedTokens = Math.round((assistantText.length + thinkingText.length) / 4);
          const thinkingElapsedMs = accumulatedThinkingMs + (thinkingSegmentStartedAt ? Math.max(0, Date.now() - thinkingSegmentStartedAt) : 0);
          if (state.spinner) {
            set({ spinner: { ...state.spinner, liveTokens: estimatedTokens, thinking: true, thinkingStartedAt, thinkingSegmentStartedAt, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingElapsedMs, thinkingLastEndedAt: 0, mode: 'thinking' } });
          }
          set({ thinking: thinkingText });
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
      if (error?.name === 'SessionClosedError') {
        cancelled = true;
        if (assistantText.trim() && currentAssistantId) {
          patchItem(currentAssistantId, { text: currentAssistantText || assistantText, streaming: false });
        }
      } else {
        pushItem({ kind: 'notice', id: nextId(), text: `[error] ${error?.message || error}`, tone: 'error' });
      }
    } finally {
      closeThinkingSegment();
      const elapsedMs = Date.now() - startedAt;
      const thinkingElapsedMs = thinkingStartedAt ? accumulatedThinkingMs : 0;
      const finalOutputTokens = Math.max(0, Number(state.spinner?.outputTokens || 0), Number(state.spinner?.liveTokens || 0));
      const turnStatus = cancelled ? 'cancelled' : 'done';
      // Pin the post-think summary into the transcript right after this turn's
      // output so it scrolls up with the answer and stays in the scrollback,
      // mirroring Claude Code. (Previously TurnDone rendered only in the
      // bottom-fixed live-status slot and vanished on the next turn.)
      pushItem({ kind: 'turndone', id: nextId(), elapsedMs, status: turnStatus, outputTokens: finalOutputTokens, thinkingElapsedMs, verb: pickDoneVerb(turnIndex) });
      set({
        busy: false,
        spinner: null,
        thinking: null,
        lastTurn: null,
        stats: { ...state.stats },
        ...routeState(),
        toolMode: runtime.toolMode,
        bridgeMode: runtime.bridgeMode,
      });
    }
  }

  const pending = [];
  let draining = false;
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
        for (const entry of batch) {
          pushItem({ kind: 'user', id: entry.id, text: entry.text });
        }
        const merged = batch
          .map((entry) => entry.text)
          .filter((text) => String(text || '').trim())
          .join('\n');
        await runTurn(merged);
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
        items: [],
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
        .catch((error) => pushNotice(`[error] ${error?.message || error}`, 'error'));
    },
    toggleBridgeMode: () => {
      const mode = runtime.toggleBridgeMode();
      set({ bridgeMode: runtime.bridgeMode });
      pushNotice(`bridge mode → ${mode}`, 'info');
      return mode;
    },
    setBridgeMode: (mode) => {
      const next = runtime.setBridgeMode(mode);
      set({ bridgeMode: runtime.bridgeMode });
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
        pushItem({ kind: 'notice', id: itemId, text, tone: 'info' });
        updateBridgeJobCard(itemId, text, /^error:/i.test(text));
        set({ bridgeMode: runtime.bridgeMode });
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
        [added, already, blocked, missing].filter(Boolean).join(' · ') || 'no tool changes',
        result.blocked?.length || result.missing?.length ? 'warn' : 'info',
      );
      return result;
    },
    setCwd: (path) => {
      const next = runtime.setCwd(path);
      set({ cwd: next });
      pushNotice(`cwd → ${next}`, 'info');
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
          `mcp reconnect: ${status?.connectedCount || 0}/${status?.configuredCount || 0} connected${status?.failedCount ? ` · ${status.failedCount} failed` : ''}`,
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
      return runtime.abort('cli-react-abort');
    },
    listPresets: () => {
      return runtime.listPresets();
    },
    listProviderModels: () => {
      return runtime.listProviderModels();
    },
    listProviders: () => {
      return runtime.listProviders();
    },
    getProviderSetup: () => {
      return runtime.getProviderSetup();
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
      try {
        await runtime.clear();
        resetStats();
        set({ items: [], toasts: [], queued: [], thinking: null, spinner: null, lastTurn: null, ...routeState(), stats: { ...state.stats } });
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
      try {
        await runtime.newSession();
        resetStats();
        set({ items: [], toasts: [], queued: [], thinking: null, lastTurn: null, ...routeState(), stats: { ...state.stats } });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    resume: async (id) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
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
            if (text) items.push({ kind: 'user', id: nextId(), text });
          } else if (m.role === 'assistant') {
            const text = (typeof m.content === 'string' ? m.content : toolResultText(m.content)).trim();
            if (text) items.push({ kind: 'assistant', id: nextId(), text });
          }
        }
        set({
          items,
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
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      clearBridgeJobMonitors();
      await runtime.close('cli-react-exit');
      listeners.clear();
    },
  };
}
