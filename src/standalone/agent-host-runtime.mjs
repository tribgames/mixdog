// Lightweight agent host runtime (shard spread workers).
//
// A remote worker session used to boot the FULL Lead session runtime
// (TUI state machine, transcript projection, media/channel/update wiring)
// just to run manager turns — ~60-90MB resident per worker at fanout peak.
// This host exposes ONLY the daemon session-service runtime contract the
// spread adapter and desktop peeks actually use, and delegates every turn to
// the SAME orchestrator manager the in-process agent path uses — tool
// surface, permissions, role rules, caching, compaction, and persistence are
// byte-identical.
//
// Contract surface:
//   getState/subscribe            — busy/queued/turndone projection frames
//   reserveSession/resume         — durable address bind + store re-open
//   submitAsync/abort             — turn intake (busy submits queue and drain
//                                   inside the same busy window, mirroring the
//                                   in-process pending-queue semantics)
//   peekSessionMessages           — RAW messages (Lead-side result/handoff)
//   peekSessionTranscript         — desktop pane read view (lazy TUI import)
//   dispose                       — resumable release (closeSession without a
//                                   tombstone), so idle eviction never breaks
//                                   a same-tag follow-up
import { prepareAgentSession } from '../runtime/agent/orchestrator/agent-runtime/session-builder.mjs';

const PROGRESS_PUBLISH_MIN_MS = 1_000;
const TURNDONE_ITEM_CAP = 8;

export async function createAgentHostRuntime(options = {}, overrides = {}) {
  const spec = options.agentSession && typeof options.agentSession === 'object'
    ? options.agentSession
    : null;
  if (!spec) throw new Error('agent host runtime requires an agentSession spec');
  const mgr = overrides.mgr
    || await import('../runtime/agent/orchestrator/session/manager.mjs');
  const cfgMod = overrides.cfgMod
    || await import('../runtime/agent/orchestrator/config.mjs');
  const reg = overrides.reg
    || await import('../runtime/agent/orchestrator/providers/registry.mjs');
  const prepare = overrides.prepareAgentSession || prepareAgentSession;

  const listeners = new Set();
  let disposed = false;
  let session = null;
  let reservedId = String(options.sessionId || '') || null;
  let providersReady = null;
  let currentAbort = null;
  let turnSeq = 0;
  const queue = [];
  // Ask-time cwd preserves the null sentinel ("no caller workspace context",
  // provider cache-fork suppression) — display cwd below may still fall back.
  const askCwd = spec.cwd !== undefined ? spec.cwd : (options.cwd || null);
  let state = {
    sessionId: '',
    agentSession: true,
    busy: false,
    commandBusy: false,
    queued: [],
    items: [],
    provider: spec.preset?.provider || options.provider || '',
    model: spec.preset?.model || options.model || '',
    agent: spec.agent || null,
    cwd: spec.cwd ?? options.cwd ?? '',
    progressAt: 0,
  };

  function publish() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* projection only */ }
    }
  }
  function set(patch) {
    state = { ...state, ...patch };
    publish();
  }

  function ensureProviders() {
    providersReady ??= Promise.resolve().then(() => {
      const config = cfgMod.loadConfig();
      return reg.initProviders(config.providers || {});
    });
    providersReady.catch(() => { providersReady = null; });
    return providersReady;
  }

  async function ensureSession() {
    if (session?.id) {
      const live = mgr.getSession(session.id);
      if (live && live.closed !== true) {
        session = live;
        return session;
      }
      session = null;
    }
    await ensureProviders();
    const prepared = prepare({
      ...spec,
      ...(reservedId ? { sessionId: reservedId } : {}),
    });
    session = prepared.session;
    reservedId = null;
    set({ sessionId: session.id });
    return session;
  }

  function appendTurndone(status, meta = {}) {
    turnSeq += 1;
    const items = [
      ...state.items.slice(-(TURNDONE_ITEM_CAP - 1)),
      { id: `turndone-${turnSeq}`, kind: 'turndone', status, at: Date.now(), ...meta },
    ];
    return items;
  }

  /** Wire-safe terminal fields for the Lead-side abnormal-finish classifier
   *  (render.mjs keys purely off terminationReason). */
  function terminalTurnMeta(result) {
    if (!result || typeof result !== 'object') return {};
    const meta = {};
    if (typeof result.terminationReason === 'string' && result.terminationReason) {
      meta.terminationReason = result.terminationReason;
    }
    for (const field of ['iterations', 'toolCallsTotal', 'maxLoopIterations']) {
      if (Number.isFinite(Number(result[field]))) meta[field] = Number(result[field]);
    }
    const stopReason = result.stopReason ?? result.stop_reason;
    if (typeof stopReason === 'string' && stopReason) meta.stopReason = stopReason;
    return meta;
  }

  async function runOneTurn(prompt) {
    let target;
    try {
      target = await ensureSession();
    } catch (error) {
      // Provider/prep failure must land as a terminal marker, not an
      // unhandled rejection: the Lead adapter sees turndone + empty content
      // and the raw error stays in the shard log.
      set({ items: appendTurndone('error') });
      try {
        process.stderr.write(`[agent-host] session prep failed: ${error?.message || error}\n`);
      } catch { /* diagnostics */ }
      return;
    }
    const controller = new AbortController();
    currentAbort = controller;
    try { mgr.linkParentSignalToSession?.(target.id, controller.signal); } catch { /* abort best-effort */ }
    try { await mgr.updateSessionStatus?.(target.id, 'running'); } catch { /* status best-effort */ }
    let lastProgressAt = 0;
    let stageNow = 'requesting';
    let lastToolCall = null;
    const bumpProgress = () => {
      const now = Date.now();
      if (now - lastProgressAt < PROGRESS_PUBLISH_MIN_MS) return;
      lastProgressAt = now;
      // Liveness frame: the Lead-side spread watchdog treats frame arrival as
      // progress; without it a long provider stream would look like a stall.
      set({ progressAt: now, stage: stageNow, lastToolCall });
    };
    let terminal = 'idle';
    try {
      const result = await mgr.askSession(target.id, prompt, null, null, askCwd, undefined, {
        onStreamDelta: () => { stageNow = 'streaming'; bumpProgress(); },
        onToolResult: (message) => {
          if (message?.name) lastToolCall = { name: String(message.name), at: Date.now() };
          bumpProgress();
        },
        onStageChange: (stage) => {
          if (typeof stage === 'string' && stage) stageNow = stage;
          bumpProgress();
        },
      });
      set({ items: appendTurndone('complete', terminalTurnMeta(result)), stage: 'idle' });
    } catch (error) {
      terminal = 'error';
      // Parity with the in-process path: the salvageable partial already lives
      // in session.messages; the Lead adapter collects it via
      // peekSessionMessages. Only the terminal marker carries the failure.
      set({ items: appendTurndone('error'), stage: 'idle' });
      try {
        process.stderr.write(`[agent-host] turn failed session=${target.id}: ${error?.message || error}\n`);
      } catch { /* diagnostics */ }
    } finally {
      currentAbort = null;
      try { await mgr.updateSessionStatus?.(target.id, terminal); } catch { /* status best-effort */ }
    }
  }

  let draining = null;
  function drainTurns(firstPrompt) {
    if (draining) return draining;
    draining = (async () => {
      set({ busy: true });
      try {
        let next = firstPrompt;
        while (next !== undefined && !disposed) {
          await runOneTurn(next);
          const entry = queue.shift();
          set({ queued: queue.map((row) => ({ id: row.id, text: row.text })) });
          next = entry?.text;
        }
      } finally {
        draining = null;
        set({ busy: false, stage: 'idle', lastToolCall: null });
      }
    })();
    return draining;
  }

  function sessionForPeek(id) {
    const wanted = String(id || state.sessionId || '');
    if (!wanted) return null;
    if (session?.id === wanted) return mgr.getSession(wanted) || session;
    return mgr.getSession(wanted) || mgr.loadSession?.(wanted) || null;
  }

  return {
    isAgentHostRuntime: true,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reserveSession(id) {
      const wanted = String(id || '');
      if (!wanted) return false;
      reservedId = wanted;
      set({ sessionId: wanted });
      return true;
    },
    async resume(sessionId, resumeOptions = undefined) {
      void resumeOptions;
      const wanted = String(sessionId || '');
      if (!wanted) return false;
      const resumed = await mgr.resumeSession?.(wanted, 'full', {});
      if (!resumed) return false;
      session = resumed;
      reservedId = null;
      set({ sessionId: wanted });
      return true;
    },
    async submitAsync(prompt, submitOptions = {}) {
      if (disposed) throw new Error('agent host runtime is disposed');
      const text = String(prompt ?? '');
      if (!text) return false;
      const id = String(submitOptions?.id || `agent-host-${Date.now()}-${turnSeq}`);
      if (state.busy) {
        if (queue.some((row) => row.id === id)) return true;
        queue.push({ id, text });
        set({ queued: queue.map((row) => ({ id: row.id, text: row.text })) });
        return true;
      }
      void drainTurns(text);
      return true;
    },
    submit(prompt, submitOptions = {}) {
      void this.submitAsync(prompt, submitOptions).catch(() => {});
      return true;
    },
    async abort() {
      try { currentAbort?.abort(new Error('agent host turn aborted')); } catch { /* once */ }
      return { aborted: true };
    },
    peekSessionMessages(id, opts = {}) {
      const target = sessionForPeek(id);
      if (!target) return null;
      const messages = Array.isArray(target.messages) ? target.messages : [];
      const start = Math.max(0, Math.floor(Number(opts.start) || 0));
      return {
        sessionId: String(target.id || id),
        messageCount: messages.length,
        messages: start > 0 ? messages.slice(start) : messages,
        agent: target.agent || spec.agent || null,
        status: target.closed === true ? 'closed' : (state.busy ? 'running' : 'idle'),
      };
    },
    async peekSessionTranscript(id, opts = {}) {
      const target = sessionForPeek(id);
      if (!target) return null;
      // The transcript-item restorer lives in the TUI layer; load it lazily so
      // a pure agent shard never pays the TUI module graph for turn work.
      const { restoreTranscriptItems } = await import('../tui/session/session-api-ext.mjs');
      const sessionId = String(target.id || id);
      const limit = Number(opts.transcriptItemLimit);
      return {
        sessionId,
        items: restoreTranscriptItems(target.messages, {
          sessionId,
          itemLimit: Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY,
        }),
        provider: target.provider || state.provider || '',
        model: target.model || state.model || '',
        effort: target.effort || '',
        fast: target.fast === true,
        cwd: target.cwd || state.cwd || '',
        desktopSession: null,
        workflow: null,
      };
    },
    async dispose(reason = 'agent-host-dispose') {
      if (disposed) return;
      disposed = true;
      try { currentAbort?.abort(new Error('agent host runtime disposed')); } catch { /* once */ }
      const id = session?.id || state.sessionId;
      if (id) {
        // Resumable release: detach runtime resources WITHOUT the disk
        // tombstone so idle eviction can never break a same-tag follow-up.
        try {
          mgr.closeSession?.(id, typeof reason === 'string' ? reason : 'agent-host-dispose', { tombstone: false });
        } catch { /* teardown */ }
      }
      listeners.clear();
      session = null;
    },
  };
}
