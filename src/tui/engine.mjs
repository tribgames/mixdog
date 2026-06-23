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
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function applyUsageDelta(stats, delta = {}) {
  if (!stats || !delta) return stats;
  stats.inputTokens += num(delta.deltaInput);
  stats.outputTokens += num(delta.deltaOutput);
  stats.cachedTokens += num(delta.deltaCachedRead);
  stats.cacheWriteTokens += num(delta.deltaCacheWrite);
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
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).filter(Boolean).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  try { return JSON.stringify(content); } catch { return String(content); }
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
    toolMode: runtime.toolMode,
    cwd,
  };
  const listeners = new Set();
  const emit = () => { for (const l of listeners) l(); };
  const set = (patch) => { state = { ...state, ...patch }; emit(); };

  const pushItem = (item) => set({ items: [...state.items, item] });
  const patchItem = (id, patch) =>
    set({ items: state.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });

  const flushToolResults = (messages, cardIdsByCallId, done) => {
    for (const m of messages || []) {
      if (!m || m.role !== 'tool') continue;
      const callId = m.toolCallId ?? m.tool_call_id ?? m.id;
      if (!callId || done.has(callId)) continue;
      const itemId = cardIdsByCallId.get(callId);
      if (!itemId) continue;
      const text = toolResultText(m.content);
      const isError = m.isError === true || /^\s*\[?error/i.test(text);
      patchItem(itemId, { result: text, isError });
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
        toolMode: runtime.toolMode,
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
        set({ sessionId: runtime.id, provider: runtime.provider, model: runtime.model, stats: { ...state.stats } });
        return true;
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
    pushNotice: (text, tone = 'info') => pushItem({ kind: 'notice', id: nextId(), text, tone }),
    clear: async () => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        await runtime.clear();
        resetStats();
        set({ items: [], queued: [], thinking: null, spinner: null, lastTurn: null, sessionId: runtime.id, stats: { ...state.stats } });
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
          stats: { ...state.stats },
        });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    dispose: () => {
      runtime.close('cli-react-exit');
      listeners.clear();
    },
  };
}
