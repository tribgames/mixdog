/**
 * src/tui-react/engine.mjs — the engine↔React bridge (React-free).
 *
 * Runs OUR mixdog engine (agentLoop) outside React and exposes a tiny
 * subscribable store. The React/ink layer consumes it via useSyncExternalStore
 * (see hooks/useEngine.mjs) — it never imports the runtime directly, so the
 * sync-managed engine stays decoupled from the UI.
 *
 * State shape (immutable snapshots; a new object on every change so
 * useSyncExternalStore re-renders):
 *   {
 *     items:   Array<Item>,   // ordered transcript: user | assistant | tool | notice
 *     busy:    boolean,       // a turn is in flight
 *     spinner: { active, verb, startedAt } | null,
 *     stats:   SessionStats,  // token/cost accumulator (from ui/statusline.mjs)
 *     model:   string,
 *     provider:string,
 *   }
 *
 * Item kinds:
 *   { kind:'user', id, text }
 *   { kind:'assistant', id, text }            // streamed markdown
 *   { kind:'tool', id, name, args, result, isError }  // result filled when it lands
 *   { kind:'notice', id, text, tone }         // system/error/help line
 */
import { SPINNER_VERBS } from './spinner-verbs.mjs';

// Session-usage accumulator — inlined (not imported from ui/statusline.mjs) so
// engine.mjs has NO static dependency on the vendored statusline closure, which
// must stay out of the esbuild bundle. Behavior matches ui/statusline.mjs.
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

// Dynamic-import specifier for the sync-managed engine. Resolved at RUNTIME
// relative to the BUILT bundle (src/tui-react/dist/index.mjs), so it must climb
// two dirs to reach src/runtime. esbuild leaves this string specifier alone;
// the runtime/ tree is never bundled (it would fork the sync source).
const RUNTIME = '../../runtime/agent/orchestrator';
const HOST_ONLY = new Set(['diagnostics', 'open_config']);

let _idSeq = 0;
const nextId = () => `it_${++_idSeq}`;

/** Pick a spinner verb. Varies by turn count so it isn't always identical. */
function pickVerb(turn) {
  return SPINNER_VERBS[(turn * 7 + 3) % SPINNER_VERBS.length];
}

/** Normalize a tool-result message's content into printable text. */
function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).filter(Boolean).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  try { return JSON.stringify(content); } catch { return String(content); }
}

/**
 * Create an engine session. Returns a store: { getState, subscribe, submit,
 * setModel, clear, dispose }.
 *
 * @param {object} opts
 * @param {string} [opts.provider]
 * @param {string} [opts.model]
 */
export async function createEngineSession({ provider: providerName = 'anthropic-oauth', model = 'claude-opus-4-8' } = {}) {
  // Silence providers' catalog-refresh stderr writes (D14 patch reads this) so
  // they can't tear through the React/ink render. Set before the runtime loads.
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';

  const reg = await import(`${RUNTIME}/providers/registry.mjs`);
  const { agentLoop } = await import(`${RUNTIME}/session/loop.mjs`);
  const { BUILTIN_TOOLS } = await import(`${RUNTIME}/tools/builtin/builtin-tools.mjs`);

  const tools = BUILTIN_TOOLS.filter((t) => !HOST_ONLY.has(t.name));

  await reg.initProviders({ [providerName]: { enabled: true } });
  const provider = reg.getProvider(providerName);
  if (!provider) {
    throw new Error(`provider "${providerName}" is not configured`);
  }

  const cwd = process.cwd();
  const messages = []; // engine conversation (role/content)

  // --- store internals ------------------------------------------------------
  let state = {
    items: [],
    busy: false,
    spinner: null,
    queued: [], // steering prompts waiting to run: { id, text } — NOT transcript items
    thinking: null, // live reasoning text for the IN-FLIGHT turn — NOT a transcript item
    lastTurn: null, // { elapsedMs, outputTokens } — the just-finished turn (for the "done" line)
    stats: createSessionStats(),
    model,
    provider: providerName,
    cwd,
  };
  const listeners = new Set();
  const emit = () => { for (const l of listeners) l(); };
  const set = (patch) => { state = { ...state, ...patch }; emit(); };

  // Mutate the items array immutably and emit.
  const pushItem = (item) => set({ items: [...state.items, item] });
  const patchItem = (id, patch) =>
    set({ items: state.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });

  // Match landed tool results (by toolCallId) to their cards.
  const flushToolResults = (cardIdsByCallId, done) => {
    for (const m of messages) {
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

  // --- one turn -------------------------------------------------------------
  // AbortController for the in-flight turn. ESC (App) calls store.abort() →
  // controller.abort(), which the ported agentLoop honors at each iteration /
  // post-tool boundary (it throws a SessionClosedError on signal.aborted). Null
  // when idle.
  let turnAbort = null;

  async function runTurn(userText) {
    messages.push({ role: 'user', content: userText });

    const turnIndex = state.stats.turns || 0;
    const startedAt = Date.now();
    turnAbort = new AbortController();
    set({ busy: true, lastTurn: null, spinner: { active: true, verb: pickVerb(turnIndex), startedAt } });

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
      const result = await agentLoop(
        provider,
        messages,
        state.model,
        tools,
        // onToolCall(iter, calls)
        async (_iter, calls) => {
          for (const c of calls || []) {
            const itemId = nextId();
            if (c?.id) cardIdsByCallId.set(c.id, itemId);
            pushItem({ kind: 'tool', id: itemId, name: c?.name || 'tool', args: c?.arguments, result: null, isError: false });
          }
          flushToolResults(cardIdsByCallId, resultsDone);
        },
        cwd,
        {
          sessionId: 'mixdog-cli-react',
          signal: turnAbort.signal,
          maxOutputTokens: 8000,
          // Enable extended thinking so the provider emits reasoning deltas.
          effort: 'high',
          onTextDelta: (chunk) => {
            // Whole-message output: accumulate the streamed text in a buffer but
            // do NOT paint it incrementally. The assistant card is created and
            // filled once, when the turn completes (below) — so the answer lands
            // as one finished block, like the other LLM CLIs. The spinner keeps
            // running until then. Tool cards still surface live (onToolCall) so
            // progress remains visible.
            assistantText += String(chunk ?? '');
          },
          onReasoningDelta: (chunk) => {
            // Extended-thinking streams into a LIVE state field (not a transcript
            // item) so it can update every delta. Transcript items go through
            // <Static> (flush-once), which can't show streaming reasoning and
            // would freeze a half-written thought into scrollback. CC keeps
            // thinking live above the spinner, then collapses it to the
            // "Thought for Ns" line (TurnDone) at turn end — mirrored here.
            thinkingText += String(chunk ?? '');
            set({ thinking: thinkingText });
          },
          onUsageDelta: (delta) => {
            applyUsageDelta(state.stats, delta);
            // stats is mutated in place; emit a shallow-new snapshot so the
            // statusline re-renders.
            set({ stats: { ...state.stats } });
          },
        },
      );

      flushToolResults(cardIdsByCallId, resultsDone);

      const finalText = (result?.content != null && String(result.content)) || assistantText;
      if (finalText) {
        ensureAssistant();
        patchItem(assistantId, { text: finalText });
      }
      messages.push({ role: 'assistant', content: result?.content ?? finalText ?? '' });
      state.stats.turns = (state.stats.turns || 0) + 1;
    } catch (error) {
      // A user ESC aborts the loop, which surfaces as an aborted signal /
      // SessionClosedError — show a quiet "Interrupted" line, not a red error.
      if (turnAbort?.signal.aborted || error?.name === 'SessionClosedError') {
        if (assistantText.trim()) { ensureAssistant(); patchItem(assistantId, { text: assistantText }); }
        pushItem({ kind: 'notice', id: nextId(), text: '⏎ Interrupted by user', tone: 'warn' });
      } else {
        pushItem({ kind: 'notice', id: nextId(), text: `[error] ${error?.message || error}`, tone: 'error' });
      }
    } finally {
      turnAbort = null;
      set({
        busy: false,
        spinner: null,
        thinking: null, // collapse live reasoning; TurnDone shows the summary line
        lastTurn: { elapsedMs: Date.now() - startedAt, outputTokens: state.stats.outputTokens || 0 },
        stats: { ...state.stats },
      });
    }
  }

  // --- submission queue (steering) ------------------------------------------
  // Lets the user enqueue follow-up prompts while a turn is in flight. Each line
  // waits in a SEPARATE queued area (state.queued), pinned above the input box —
  // never pushed into the transcript while it waits (no live-tree pollution). It
  // is promoted to a real transcript user item only when it STARTS executing
  // (dequeued in drain()), one at a time, in order. CC's steering-queue model.
  const pending = [];
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const next = pending.shift();
        // Promote the queued line to a real transcript user item at the moment
        // it starts running, and remove it from the waiting queue.
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

  // --- public store API -----------------------------------------------------
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * Submit a user line. Slash commands are handled by the UI, not here.
     * While a turn is busy the line is queued (steering) instead of dropped, so
     * this returns true for any non-empty input.
     */
    submit: (text) => {
      const t = String(text ?? '').trim();
      if (!t) return false;
      enqueue(t);
      return true;
    },
    setModel: (m) => set({ model: m }),
    /**
     * Interrupt the in-flight turn (ESC). Aborts the agent loop; the queued
     * steering prompts are intentionally KEPT (use ↑ to edit/cancel them).
     * No-op when idle. Returns true if a running turn was actually aborted.
     */
    abort: () => {
      if (turnAbort && !turnAbort.signal.aborted) {
        turnAbort.abort();
        return true;
      }
      return false;
    },
    pushNotice: (text, tone = 'info') => pushItem({ kind: 'notice', id: nextId(), text, tone }),
    clear: () => {
      messages.length = 0;
      const fresh = createSessionStats();
      for (const k of Object.keys(fresh)) state.stats[k] = fresh[k];
      set({ items: [], queued: [], thinking: null, stats: { ...state.stats } });
    },
    dispose: () => listeners.clear(),
  };
}
