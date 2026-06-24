/**
 * src/tui/engine.mjs - the engine<->React bridge (React-free).
 *
 * Runs mixdog's session manager outside React and exposes a tiny subscribable
 * store. The React/ink layer consumes it via useSyncExternalStore
 * (see hooks/useEngine.mjs).
 */
import { SPINNER_VERBS } from './spinner-verbs.mjs';

// Session-usage accumulator - inlined (not imported from ui/statusline.mjs) so
// engine.mjs has no static dependency on the vendored statusline closure.
function createSessionStats() {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, promptTokens: 0, costUsd: 0, turns: 0 };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function applyUsageDelta(stats, delta = {}) {
  if (!stats || !delta) return stats;
  stats.inputTokens += num(delta.deltaInput);
  stats.outputTokens += num(delta.deltaOutput);
  stats.cachedTokens += num(delta.deltaCachedRead);
  stats.cacheWriteTokens += num(delta.deltaCacheWrite);
  stats.promptTokens += num(delta.deltaPrompt);
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

const BRIDGE_JOB_POLL_MS = 2000;
const BRIDGE_JOB_MAX_POLL_MS = 10 * 60_000;

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

export async function createEngineSession({
  provider: providerName,
  model,
  toolMode = 'full',
} = {}) {
  // Silence provider/session diagnostics so they cannot tear through the
  // alternate-screen React/ink render.
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
  process.env.MIXDOG_QUIET_SESSION_LOG = '1';
  process.env.MIXDOG_QUIET_MCP_LOG = '1';

  const { createMixdogSessionRuntime } = await import(SESSION_RUNTIME_MODULE);
  const runtime = await createMixdogSessionRuntime({ provider: providerName, model, toolMode });
  const cwd = process.cwd();

  let state = {
    items: [],
    busy: false,
    commandBusy: false,
    spinner: null,
    queued: [],
    thinking: null,
    lastTurn: null,
    stats: createSessionStats(),
    sessionId: runtime.id,
    model: runtime.model,
    provider: runtime.provider,
    effort: runtime.effort,
    effortOptions: runtime.effortOptions,
    toolMode: runtime.toolMode,
    bridgeMode: runtime.bridgeMode,
    cwd,
  };
  const listeners = new Set();
  const emit = () => { for (const l of listeners) l(); };
  const set = (patch) => { state = { ...state, ...patch }; emit(); };

  const pushItem = (item) => set({ items: [...state.items, item] });
  const patchItem = (id, patch) =>
    set({ items: state.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  const bridgeJobMonitors = new Map();
  let disposed = false;

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

  const flushToolResults = (messages, cardIdsByCallId, done) => {
    for (const m of messages || []) {
      if (!m || m.role !== 'tool') continue;
      const callId = m.toolCallId ?? m.tool_call_id ?? m.id;
      if (!callId || done.has(callId)) continue;
      const itemId = cardIdsByCallId.get(callId);
      if (!itemId) continue;
      const text = toolResultText(m.content);
      const isError = m.isError === true || /^\s*\[?error/i.test(text);
      updateBridgeJobCard(itemId, text, isError);
      done.add(callId);
    }
  };

  async function runTurn(userText) {
    const turnIndex = state.stats.turns || 0;
    const startedAt = Date.now();
    const outputBaseline = state.stats.outputTokens;
    set({ busy: true, lastTurn: null, spinner: { active: true, verb: pickVerb(turnIndex), startedAt, liveTokens: 0, outputTokens: 0 } });

    const assistantId = nextId();
    let assistantText = '';
    let assistantShown = false;
    let thinkingText = '';
    const cardIdsByCallId = new Map();
    const resultsDone = new Set();

    const ensureAssistant = () => {
      if (!assistantShown) {
        assistantShown = true;
        pushItem({ kind: 'assistant', id: assistantId, text: '' });
      }
    };

    try {
      const { result, session } = await runtime.ask(userText, {
        onToolCall: async (_iter, calls) => {
          for (const c of calls || []) {
            const itemId = nextId();
            if (c?.id) cardIdsByCallId.set(c.id, itemId);
            pushItem({ kind: 'tool', id: itemId, name: c?.name || 'tool', args: c?.arguments, result: null, isError: false, expanded: false });
          }
        },
        onTextDelta: (chunk) => {
          assistantText += String(chunk ?? '');
          const estimatedTokens = Math.round(assistantText.length / 4);
          if (state.spinner) {
            set({ spinner: { ...state.spinner, liveTokens: estimatedTokens } });
          }
        },
        onReasoningDelta: (chunk) => {
          thinkingText += String(chunk ?? '');
          const estimatedTokens = Math.round((assistantText.length + thinkingText.length) / 4);
          if (state.spinner) {
            set({ spinner: { ...state.spinner, liveTokens: estimatedTokens } });
          }
          set({ thinking: thinkingText });
        },
        onUsageDelta: (delta) => {
          applyUsageDelta(state.stats, delta);
          const currentTurnOutput = Math.max(0, state.stats.outputTokens - outputBaseline);
          if (state.spinner) {
            set({ stats: { ...state.stats }, spinner: { ...state.spinner, outputTokens: currentTurnOutput } });
          } else {
            set({ stats: { ...state.stats } });
          }
        },
      });

      flushToolResults(session?.messages || [], cardIdsByCallId, resultsDone);

      const finalText = (result?.content != null && String(result.content)) || assistantText;
      if (finalText) {
        ensureAssistant();
        patchItem(assistantId, { text: finalText });
      }
      state.stats.turns = (state.stats.turns || 0) + 1;
    } catch (error) {
      if (error?.name === 'SessionClosedError') {
        if (assistantText.trim()) { ensureAssistant(); patchItem(assistantId, { text: assistantText }); }
        pushItem({ kind: 'notice', id: nextId(), text: 'Interrupted by user', tone: 'warn' });
      } else {
        pushItem({ kind: 'notice', id: nextId(), text: `[error] ${error?.message || error}`, tone: 'error' });
      }
    } finally {
      set({
        busy: false,
        spinner: null,
        thinking: null,
        lastTurn: { elapsedMs: Date.now() - startedAt, outputTokens: state.stats.outputTokens || 0 },
        stats: { ...state.stats },
        sessionId: runtime.id,
        provider: runtime.provider,
        model: runtime.model,
        effort: runtime.effort,
        effortOptions: runtime.effortOptions,
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
        const next = pending.shift();
        set({ queued: state.queued.filter((q) => q.id !== next.id) });
        pushItem({ kind: 'user', id: next.id, text: next.text });
        await runTurn(next.text);
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
      enqueue(t);
      return true;
    },
    setModel: async (m) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        await runtime.setRoute({ model: m });
        resetStats();
        set({ sessionId: runtime.id, provider: runtime.provider, model: runtime.model, effort: runtime.effort, effortOptions: runtime.effortOptions, stats: { ...state.stats } });
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
        set({ effort: runtime.effort, effortOptions: runtime.effortOptions });
        return runtime.effort || 'auto';
      } finally {
        set({ commandBusy: false });
      }
    },
    setToolMode: (m) => {
      void runtime.setToolMode(m)
        .then(() => {
          resetStats();
          set({ sessionId: runtime.id, toolMode: runtime.toolMode, stats: { ...state.stats } });
        })
        .catch((error) => pushItem({ kind: 'notice', id: nextId(), text: `[error] ${error?.message || error}`, tone: 'error' }));
    },
    toggleBridgeMode: () => {
      const mode = runtime.toggleBridgeMode();
      set({ bridgeMode: runtime.bridgeMode });
      pushItem({ kind: 'notice', id: nextId(), text: `bridge mode → ${mode}`, tone: 'info' });
      return mode;
    },
    setBridgeMode: (mode) => {
      const next = runtime.setBridgeMode(mode);
      set({ bridgeMode: runtime.bridgeMode });
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
    mcpStatus: () => {
      return runtime.mcpStatus?.() || { servers: [], configuredCount: 0, connectedCount: 0, failedCount: 0 };
    },
    reconnectMcp: async () => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.reconnectMcp?.();
        resetStats();
        set({ sessionId: runtime.id, stats: { ...state.stats } });
        pushItem({
          kind: 'notice',
          id: nextId(),
          text: `mcp reconnect: ${status?.connectedCount || 0}/${status?.configuredCount || 0} connected${status?.failedCount ? ` · ${status.failedCount} failed` : ''}`,
          tone: status?.failedCount ? 'warn' : 'info',
        });
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
    reloadSkills: async () => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.reloadSkills?.();
        resetStats();
        set({ sessionId: runtime.id, stats: { ...state.stats } });
        pushItem({
          kind: 'notice',
          id: nextId(),
          text: `skills reload: ${status?.count || 0} available`,
          tone: 'info',
        });
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
        set({ sessionId: runtime.id, stats: { ...state.stats } });
        pushItem({
          kind: 'notice',
          id: nextId(),
          text: `plugins reload: ${status?.count || 0} detected`,
          tone: 'info',
        });
        return status;
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
        set({ sessionId: runtime.id, stats: { ...state.stats } });
        pushItem({
          kind: 'notice',
          id: nextId(),
          text: `plugin MCP enabled: ${result?.serverName || plugin?.name || 'plugin'}`,
          tone: 'info',
        });
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    hooksStatus: () => {
      return runtime.hooksStatus?.() || { enabled: false, events: [], recent: [] };
    },
    addHookRule: (rule) => {
      const rules = runtime.addHookRule?.(rule) || [];
      pushItem({ kind: 'notice', id: nextId(), text: `hook rule added (${rules.length} total)`, tone: 'info' });
      return rules;
    },
    setHookRuleEnabled: (index, enabled) => {
      const rules = runtime.setHookRuleEnabled?.(index, enabled) || [];
      pushItem({ kind: 'notice', id: nextId(), text: `hook rule ${index + 1} ${enabled ? 'enabled' : 'disabled'}`, tone: 'info' });
      return rules;
    },
    deleteHookRule: (index) => {
      const rules = runtime.deleteHookRule?.(index) || [];
      pushItem({ kind: 'notice', id: nextId(), text: `hook rule ${index + 1} deleted`, tone: 'info' });
      return rules;
    },
    memoryControl: async (args = {}) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.memoryControl(args);
        pushItem({ kind: 'notice', id: nextId(), text: String(result || '').trim() || '(empty memory result)', tone: 'info' });
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
    loginOAuthProvider: async (provider) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        const result = await runtime.loginOAuthProvider(provider);
        pushItem({
          kind: 'notice',
          id: nextId(),
          text: `provider oauth ok: ${result.provider}`,
          tone: 'info',
        });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    saveProviderApiKey: (provider, secret) => {
      const result = runtime.saveProviderApiKey(provider, secret);
      pushItem({
        kind: 'notice',
        id: nextId(),
        text: `provider api key saved: ${result.provider}`,
        tone: 'info',
      });
      return true;
    },
    setLocalProvider: (provider, opts) => {
      const result = runtime.setLocalProvider(provider, opts);
      pushItem({
        kind: 'notice',
        id: nextId(),
        text: `local provider ${result.enabled ? 'enabled' : 'disabled'}: ${result.provider}`,
        tone: 'info',
      });
      return true;
    },
    authenticateProvider: async (provider, secret) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        const result = await runtime.authenticateProvider(provider, secret);
        pushItem({
          kind: 'notice',
          id: nextId(),
          text: `provider auth ok: ${result.provider} (${result.type})`,
          tone: 'info',
        });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    forgetProviderAuth: (provider) => {
      const result = runtime.forgetProviderAuth(provider);
      pushItem({
        kind: 'notice',
        id: nextId(),
        text: `provider auth forgotten: ${result.provider}`,
        tone: 'info',
      });
      return true;
    },
    getChannelSetup: () => {
      return runtime.getChannelSetup();
    },
    saveDiscordToken: (token) => {
      const result = runtime.saveDiscordToken(token);
      pushItem({ kind: 'notice', id: nextId(), text: 'discord token saved', tone: 'info' });
      return result;
    },
    saveWebhookAuthtoken: (token) => {
      const result = runtime.saveWebhookAuthtoken(token);
      pushItem({ kind: 'notice', id: nextId(), text: 'webhook/ngrok authtoken saved', tone: 'info' });
      return result;
    },
    saveChannel: (entry) => {
      const result = runtime.saveChannel(entry);
      pushItem({ kind: 'notice', id: nextId(), text: `channel saved: ${entry.name}`, tone: 'info' });
      return result;
    },
    deleteChannel: (name) => {
      const result = runtime.deleteChannel(name);
      pushItem({ kind: 'notice', id: nextId(), text: `channel deleted: ${name}`, tone: 'info' });
      return result;
    },
    setWebhookConfig: (patch) => {
      const result = runtime.setWebhookConfig(patch);
      pushItem({ kind: 'notice', id: nextId(), text: 'webhook config updated', tone: 'info' });
      return result;
    },
    saveSchedule: (entry) => {
      const result = runtime.saveSchedule(entry);
      pushItem({ kind: 'notice', id: nextId(), text: `schedule saved: ${result.name}`, tone: 'info' });
      return result;
    },
    deleteSchedule: (name) => {
      const result = runtime.deleteSchedule(name);
      pushItem({ kind: 'notice', id: nextId(), text: `schedule deleted: ${name}`, tone: 'info' });
      return result;
    },
    saveWebhook: (entry) => {
      const result = runtime.saveWebhook(entry);
      pushItem({ kind: 'notice', id: nextId(), text: `webhook saved: ${result.name}`, tone: 'info' });
      return result;
    },
    deleteWebhook: (name) => {
      const result = runtime.deleteWebhook(name);
      pushItem({ kind: 'notice', id: nextId(), text: `webhook deleted: ${name}`, tone: 'info' });
      return result;
    },
    setRoute: async (opts) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        await runtime.setRoute(opts);
        resetStats();
        set({ sessionId: runtime.id, provider: runtime.provider, model: runtime.model, effort: runtime.effort, effortOptions: runtime.effortOptions, stats: { ...state.stats } });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    pushNotice: (text, tone = 'info') => pushItem({ kind: 'notice', id: nextId(), text, tone }),
    clear: async () => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        await runtime.clear();
        resetStats();
        set({ items: [], queued: [], thinking: null, spinner: null, lastTurn: null, sessionId: runtime.id, effort: runtime.effort, effortOptions: runtime.effortOptions, stats: { ...state.stats } });
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
        set({ items: [], queued: [], thinking: null, lastTurn: null, sessionId: runtime.id, stats: { ...state.stats } });
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
          queued: [],
          thinking: null,
          spinner: null,
          lastTurn: null,
          sessionId: r.id,
          provider: r.provider,
          model: r.model,
          effort: runtime.effort,
          effortOptions: runtime.effortOptions,
          stats: { ...state.stats },
        });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    dispose: () => {
      disposed = true;
      clearBridgeJobMonitors();
      runtime.close('cli-react-exit');
      listeners.clear();
    },
  };
}
