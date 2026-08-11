// Agent shard spread: spawned worker sessions run as daemon-hosted sessions on
// OTHER session shards, so a Lead and its agents stop sharing one shard event
// loop. Default ON inside the daemon's shard pool (pid-scoped shard marker),
// where a peer shard always exists; plain/embedded processes stay in-process
// unless MIXDOG_AGENT_SHARD_SPREAD=1 opts in. =0 always opts out.
//
// Shape: the module wraps the in-process session manager with a mgr-compatible
// facade. Remote worker sessions are registered by sessionId; every agent-tool
// call site keeps addressing ONE manager, and only the ~10 session-addressed
// methods route to the remote handle. Everything else (owner notifications,
// background tasks, tag registry, worker index) stays Lead-local. When spread
// is active there is exactly ONE spawn path: a create/transport failure or an
// incompatible daemon fails the spawn — never a silent in-process downgrade.
import { randomUUID } from 'node:crypto';
import {
  attachSession,
  probeSessionHealth,
  readSessionDiscovery,
  sessionDaemonCompatibility,
} from '../session-client.mjs';
import { applySessionStatePatch } from '../session-state-patch.mjs';
import {
  AgentStallAbortError,
  partialHandoffTextFromSession,
  watchdogPartialHandoffFromError,
} from '../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';

// Grace after a submit during which an idle projection with no new assistant
// output is still treated as "turn not started yet" instead of an empty final.
const REMOTE_TURN_SETTLE_MS = 15_000;
// Idle wait slice between completion re-checks while the remote turn runs.
const REMOTE_WAIT_SLICE_MS = 1_000;

export function agentShardSpreadEnabled() {
  const raw = String(process.env.MIXDOG_AGENT_SHARD_SPREAD ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  // Default: ON only inside a shard child (production Lead runtimes), where
  // the daemon parent is guaranteed live and build-identical. The marker is
  // pid-scoped because plain env flags leak to every spawned grandchild
  // (shell tools, test runners), which must keep the in-process path.
  return process.env.MIXDOG_SESSION_SHARD_PID === String(process.pid);
}

/** Shard index of THIS process when it is a pool shard child (else null).
 *  Pid-guarded like agentShardSpreadEnabled: the shard marker envs leak into
 *  every spawned grandchild (shell tools, harnesses), and a non-shard process
 *  must not avoid a warm shard it does not actually run on. */
function ownShardIndex() {
  if (process.env.MIXDOG_SESSION_SHARD_PID !== String(process.pid)) return null;
  const n = Number(process.env.MIXDOG_SESSION_SHARD_INDEX);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Opt-in stage timing (MIXDOG_SPREAD_TIMING=1): one stderr line per remote
// create/ask with the per-stage breakdown, for spawn-overhead attribution.
const SPREAD_TIMING = /^(?:1|true|on|yes)$/i.test(String(process.env.MIXDOG_SPREAD_TIMING || ''));
function timing(line) {
  if (!SPREAD_TIMING) return;
  try { process.stderr.write(`[spread-timing] ${line}\n`); } catch { /* diagnostics */ }
}

function assistantMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && (block.type === 'text' || block.type === 'output_text'))
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

function lastAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const text = assistantMessageText(message.content).trim();
    if (text && text !== '.') return text;
  }
  return '';
}

class RemoteWorkerHandle {
  constructor({ sessionId, spec, openParams, call, log }) {
    this.sessionId = sessionId;
    this.spec = spec || {};
    this.openParams = openParams;
    this.callTransport = call;
    this.log = log;
    this.state = {};
    this.revision = -1;
    this.lastFrameAt = Date.now();
    this.listeners = new Set();
    this.linkedSignalCleanups = new Set();
    this.abortError = null;
    this.transportError = null;
    this.gone = null;
    this.released = false;
    this.resyncing = false;
    const now = new Date().toISOString();
    const preset = this.spec.preset || {};
    this.facade = {
      id: sessionId,
      remoteShardSession: true,
      agent: this.spec.agent || null,
      agentTag: this.spec.agentTag || null,
      provider: preset.provider || openParams.provider || null,
      model: preset.model || openParams.model || null,
      effort: preset.effort || null,
      fast: preset.fast === true,
      presetName: this.spec.presetName || null,
      permission: this.spec.permission || null,
      ownerSessionId: this.spec.ownerSessionId || null,
      clientHostPid: this.spec.clientHostPid || null,
      taskType: this.spec.taskType || null,
      cwd: this.spec.cwd || openParams.cwd || null,
      closed: false,
      status: 'idle',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyChange() {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* wait-loop bookkeeping only */ }
    }
  }

  syncFacade() {
    if (!this.facade.closed) {
      const busy = this.state?.busy === true || this.state?.commandBusy === true;
      this.facade.status = busy ? 'running' : 'idle';
    }
    this.facade.updatedAt = new Date().toISOString();
  }

  /** Apply a state body from a frame OR a call result (same wire shape). */
  applyFrame(body) {
    if (!body || typeof body !== 'object') return;
    const revision = Number(body.revision);
    if (body.full !== undefined && body.full !== null) {
      this.state = body.full;
      this.revision = Number.isFinite(revision) ? revision : this.revision;
    } else if (body.patch && typeof body.patch === 'object') {
      if (Number(body.baseRevision) === this.revision) {
        this.state = applySessionStatePatch(this.state, body.patch);
        this.revision = Number.isFinite(revision) ? revision : this.revision;
      } else if (!Number.isFinite(revision) || revision > this.revision) {
        this.resync();
      }
    }
    this.lastFrameAt = Date.now();
    this.syncFacade();
    this.notifyChange();
  }

  resync() {
    if (this.resyncing || this.facade.closed) return;
    this.resyncing = true;
    void this.callTransport('session.read', {
      sessionId: this.sessionId,
      open: this.openParams,
      baseRevision: null,
    }).then((result) => {
      this.applyFrame(result);
    }).catch((error) => {
      this.log(`remote worker ${this.sessionId} resync failed: ${error?.message || error}`);
    }).finally(() => { this.resyncing = false; });
  }

  markGone(reason) {
    this.gone = String(reason || 'session unloaded');
    this.notifyChange();
  }

  failTransport(error) {
    this.transportError = error instanceof Error ? error : new Error(String(error));
    // Frames are gone with the attachment; the next ask/enqueue re-subscribes
    // through a fresh attachment instead of trusting a stale projection.
    this.released = true;
    this.notifyChange();
  }

  linkAbortSignal(signal) {
    if (!signal) return;
    if (signal.aborted) {
      this.onAbort(signal.reason);
      return;
    }
    const onAbort = () => this.onAbort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    this.linkedSignalCleanups.add(() => {
      try { signal.removeEventListener('abort', onAbort); } catch { /* once */ }
    });
  }

  clearLinkedSignals() {
    for (const cleanup of [...this.linkedSignalCleanups]) cleanup();
    this.linkedSignalCleanups.clear();
  }

  onAbort(reason) {
    if (this.abortError) return;
    this.abortError = reason instanceof Error
      ? reason
      : new Error(String(reason || 'agent remote session aborted'));
    void this.callTransport('session.abort', {
      sessionId: this.sessionId,
      options: {},
      open: this.openParams,
      baseRevision: null,
    }).catch(() => { /* the turn-wait surfaces the abort either way */ });
    this.notifyChange();
  }

  waitChange(timeoutMs) {
    return new Promise((resolve) => {
      let off = null;
      let timer = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        if (off) off();
        resolve();
      };
      timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      off = this.onChange(done);
    });
  }

  runtimeInfo() {
    const busy = this.state?.busy === true || this.state?.commandBusy === true;
    const hostStage = typeof this.state?.stage === 'string' && this.state.stage ? this.state.stage : null;
    return {
      stage: this.facade.closed ? 'closed' : (busy ? (hostStage || 'streaming') : 'idle'),
      lastStreamDeltaAt: this.lastFrameAt,
      controller: null,
      lastToolCall: this.state?.lastToolCall || null,
    };
  }

  queueDepth() {
    return Array.isArray(this.state?.queued) ? this.state.queued.length : 0;
  }

  async fetchMessages() {
    const result = await this.callTransport('session.read', {
      sessionId: this.sessionId,
      action: 'peekSessionMessages',
      args: [this.sessionId, {}],
      open: this.openParams,
      baseRevision: null,
    }, { callId: randomUUID() });
    const value = result?.value;
    const messages = Array.isArray(value?.messages) ? value.messages : [];
    this.facade.messages = messages;
    return messages;
  }

  async ensureWatch() {
    if (!this.released && !this.gone) return;
    const result = await this.callTransport('session.subscribe', {
      sessionId: this.sessionId,
      open: this.openParams,
      baseRevision: null,
    }, { callId: randomUUID() });
    this.released = false;
    this.gone = null;
    this.applyFrame(result);
  }

  /** Fold the askSession `context` argument into the prompt: the remote submit
   *  surface has no separate context lane, and the block mirrors the reminder
   *  framing the in-process ask path uses for caller context. */
  static promptWithContext(prompt, context) {
    const extra = String(context || '').trim();
    if (!extra) return prompt;
    return `${prompt}\n\n<system-reminder>\nCaller context:\n${extra}\n</system-reminder>`;
  }

  async ask(prompt, context, askOpts = {}) {
    if (this.facade.closed) throw new Error(`Session closed: ${this.sessionId}`);
    // A lost attachment is recoverable between turns: clear the failure and
    // let ensureWatch() re-subscribe through a fresh attachment. Only an
    // in-flight turn surfaces the transport loss as an error.
    this.transportError = null;
    this.abortError = null;
    const askStartedAt = Date.now();
    let acceptedMs = -1;
    let firstBusyMs = -1;
    let turnEndMs = -1;
    try {
      await this.ensureWatch();
      const baselineCount = this.facade.messages.length;
      const turndoneCount = (items) => (Array.isArray(items)
        ? items.reduce((sum, item) => sum + (item?.kind === 'turndone' ? 1 : 0), 0)
        : 0);
      const latestTurndoneMeta = () => {
        const items = Array.isArray(this.state?.items) ? this.state.items : [];
        for (let index = items.length - 1; index >= 0; index -= 1) {
          const item = items[index];
          if (item?.kind !== 'turndone') continue;
          const meta = {};
          if (typeof item.terminationReason === 'string' && item.terminationReason) {
            meta.terminationReason = item.terminationReason;
          }
          for (const field of ['iterations', 'toolCallsTotal', 'maxLoopIterations']) {
            if (Number.isFinite(Number(item[field]))) meta[field] = Number(item[field]);
          }
          if (typeof item.stopReason === 'string' && item.stopReason) meta.stopReason = item.stopReason;
          return meta;
        }
        return {};
      };
      const baselineTurndone = turndoneCount(this.state?.items);
      const submissionId = `agent-spread-${process.pid}-${randomUUID()}`;
      const submitted = await this.callTransport('session.submit', {
        sessionId: this.sessionId,
        prompt: RemoteWorkerHandle.promptWithContext(prompt, context),
        options: { id: submissionId },
        open: this.openParams,
        baseRevision: null,
      }, { callId: `session-submit:${this.sessionId}:${submissionId}` });
      this.applyFrame(submitted);
      if (submitted?.accepted !== true) {
        throw new Error('agent shard spread: remote submit was not accepted');
      }
      acceptedMs = Date.now() - askStartedAt;
      this.facade.status = 'running';
      const submitAt = Date.now();
      for (;;) {
        if (this.abortError) {
          try { await this.fetchMessages(); } catch { /* partial handoff best-effort */ }
          throw this.abortError;
        }
        if (this.transportError) throw this.transportError;
        if (this.gone) throw new Error(`agent shard spread: remote session unloaded (${this.gone})`);
        const busy = this.state?.busy === true || this.state?.commandBusy === true;
        if (busy && firstBusyMs < 0) firstBusyMs = Date.now() - askStartedAt;
        const queued = Array.isArray(this.state?.queued) ? this.state.queued.length : 0;
        if (!busy && queued === 0) {
          // Deterministic turn end: the runtime appends a `turndone` item with
          // the same commit that publishes busy=false. The raw-message growth +
          // settle window stays as a fallback for no-op turns that skip the
          // turndone marker (abort/reclaim paths).
          const turnEnded = turndoneCount(this.state?.items) > baselineTurndone;
          if (turnEnded && turnEndMs < 0) turnEndMs = Date.now() - askStartedAt;
          const messages = await this.fetchMessages();
          const grew = messages.length > baselineCount;
          if (turnEnded || grew || Date.now() - submitAt > REMOTE_TURN_SETTLE_MS) {
            const content = lastAssistantText(messages.slice(baselineCount));
            // Terminal metadata rides the turndone marker so the Lead-side
            // abnormal-finish classifier (iteration_cap/truncated/empty) sees
            // the same terminationReason an in-process ask would return.
            const result = { content, ...(turnEnded ? latestTurndoneMeta() : {}) };
            timing(`ask session=${this.sessionId} accepted=${acceptedMs}ms firstBusy=${firstBusyMs}ms `
              + `turnEnd=${turnEndMs}ms total=${Date.now() - askStartedAt}ms`);
            try { askOpts.onTerminalResult?.(result); } catch { /* caller callback */ }
            return result;
          }
        }
        await this.waitChange(REMOTE_WAIT_SLICE_MS);
      }
    } finally {
      this.clearLinkedSignals();
      this.syncFacade();
    }
  }

  /** Sync intake used for busy-session queueing; the daemon queues a submit
   *  that lands while the current turn is running. */
  enqueue(entry) {
    const text = typeof entry === 'string'
      ? entry
      : String(entry?.text ?? entry?.message ?? '').trim();
    if (!text) return 0;
    void (async () => {
      await this.ensureWatch();
      const submissionId = `agent-spread-queue-${process.pid}-${randomUUID()}`;
      const result = await this.callTransport('session.submit', {
        sessionId: this.sessionId,
        prompt: text,
        options: { id: submissionId },
        open: this.openParams,
        baseRevision: null,
      }, { callId: `session-submit:${this.sessionId}:${submissionId}` });
      this.applyFrame(result);
    })().catch((error) => {
      this.log(`remote worker ${this.sessionId} queued send failed: ${error?.message || error}`);
    });
    return this.queueDepth() + 1;
  }

  release() {
    if (this.released) return;
    this.released = true;
    // Drop the display projection bulk (items/transcript); raw messages stay
    // for status/result views, matching the in-process unload semantics.
    this.state = {};
    void this.callTransport('session.unsubscribe', { sessionId: this.sessionId })
      .catch(() => { /* daemon sweep reaps the subscription */ });
  }

  close() {
    this.facade.closed = true;
    this.facade.status = 'closed';
    this.clearLinkedSignals();
    this.release();
    this.notifyChange();
  }
}

// ── Shared per-process transport ─────────────────────────────────────────────
// ONE daemon attachment + handle registry per process, shared by every
// agent-tool instance AND by hidden-role dispatches, so a shard
// hosting several Lead sessions never multiplies SSE streams.
const sharedHandles = new Map(); // sessionId -> RemoteWorkerHandle
let sharedLog = () => {};
let attachment = null;
let attachmentPromise = null;

async function ensureAttachment() {
  if (attachment) return attachment;
  if (attachmentPromise) return attachmentPromise;
  attachmentPromise = (async () => {
    const discovery = readSessionDiscovery();
    if (!discovery) throw new Error('agent shard spread: no live daemon discovery');
    const health = await probeSessionHealth({ port: discovery.port, token: discovery.token });
    if (!health || Number(health.pid) !== Number(discovery.pid)) {
      throw new Error('agent shard spread: daemon health probe failed');
    }
    // A daemon older than this client cannot host agentSession creates (it
    // would silently drop the spec and build a Lead-shaped session). Refuse
    // outright — spread has ONE path, and a version-skewed daemon must never
    // receive a replacement drain from the agent path either.
    const compatibility = sessionDaemonCompatibility(health);
    if (compatibility.status !== 'compatible' && compatibility.status !== 'daemon-newer') {
      throw new Error(`agent shard spread: daemon is not compatible (${compatibility.status})`);
    }
    const transport = await attachSession({
      discovery,
      // A shard child (or embedded runtime) must never count as an external
      // lifecycle client, or the daemon would wait on its own worker fanout.
      lifecycle: false,
      cwd: process.cwd(),
      log: (line) => sharedLog(`shard-spread: ${line}`),
      onFrame: (frame) => {
        const handle = sharedHandles.get(String(frame?.sessionId || ''));
        if (!handle) return;
        if (frame.type === 'session-state') handle.applyFrame(frame);
        else if (frame.type === 'session-gone') handle.markGone(frame.reason || 'session unloaded');
      },
      onFatal: (reason) => {
        const error = new Error(`agent shard spread attachment lost (${reason})`);
        attachment = null;
        for (const handle of [...sharedHandles.values()]) handle.failTransport(error);
      },
    });
    attachment = { transport };
    return attachment;
  })().finally(() => { attachmentPromise = null; });
  return attachmentPromise;
}

async function callTransport(name, args, options = {}) {
  const active = await ensureAttachment();
  return active.transport.call(name, args, options);
}

/** Create one remote agent session on a peer shard (shared registry). */
export async function createRemoteAgentSession({ spec, provider, model, cwd }) {
  const createStartedAt = Date.now();
  const openParams = {
    cwd: cwd || process.cwd(),
    provider,
    model,
    toolMode: 'full',
    agentSession: spec,
    ...(ownShardIndex() !== null ? { avoidShardIndex: ownShardIndex() } : {}),
  };
  const created = await callTransport('session.create', openParams, {
    callId: `agent-spread-create:${process.pid}:${randomUUID()}`,
  });
  const sessionId = String(created?.sessionId || '');
  if (!sessionId) throw new Error('agent shard spread: session.create returned no sessionId');
  timing(`create session=${sessionId} agent=${spec?.agent || '?'} ms=${Date.now() - createStartedAt}`);
  const handle = new RemoteWorkerHandle({
    sessionId, spec, openParams, call: callTransport, log: sharedLog,
  });
  sharedHandles.set(sessionId, handle);
  handle.applyFrame(created);
  return handle;
}

/**
 * Ephemeral hidden-role dispatch on a peer shard (maintenance and other
 * makeAgentDispatch roles running inside a shard child). Mirrors the
 * in-process dispatch contract: parent-signal cascade, idle watchdog,
 * watchdog/salvage partial handoff, ephemeral close. The handle is removed
 * from the shared registry on completion — these sessions are never
 * re-addressed by tag or send.
 */
export async function dispatchHiddenAgentRemote({
  spec,
  provider,
  model,
  cwd,
  prompt,
  parentSignals = [],
  watchdogPolicy = null,
}) {
  const handle = await createRemoteAgentSession({ spec, provider, model, cwd });
  const controller = new AbortController();
  const detachers = [];
  for (const signal of parentSignals) {
    if (!(signal instanceof AbortSignal)) continue;
    if (signal.aborted) {
      try { controller.abort(signal.reason); } catch { /* already aborted */ }
      break;
    }
    const onAbort = () => {
      try { controller.abort(signal.reason); } catch { /* race */ }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    detachers.push(() => {
      try { signal.removeEventListener('abort', onAbort); } catch { /* once */ }
    });
  }
  // Remote idle watchdog: frames are the progress heartbeat (stream deltas and
  // tool updates each move lastFrameAt), mirroring the in-process dispatch's
  // no-snapshot fallback.
  let idleTimer = null;
  if (watchdogPolicy?.idleStaleMs > 0) {
    const anchorTs = Date.now();
    idleTimer = setInterval(() => {
      if (controller.signal.aborted) return;
      const last = handle.lastFrameAt || anchorTs;
      if (Date.now() - last > watchdogPolicy.idleStaleMs) {
        try {
          controller.abort(new AgentStallAbortError(
            `agent task stale (${watchdogPolicy.idleStaleMs}ms without progress)`,
          ));
        } catch { /* race */ }
      }
    }, 1000);
    idleTimer.unref?.();
  }
  handle.linkAbortSignal(controller.signal);
  const handoffStart = handle.facade.messages.length;
  try {
    const result = await handle.ask(prompt, null, {});
    return result?.content || '';
  } catch (error) {
    const salvageRequested = error?.salvagePartial === true
      || controller.signal.reason?.salvagePartial === true;
    const partial = watchdogPartialHandoffFromError(error, handle.facade, handoffStart)
      ?? (salvageRequested ? partialHandoffTextFromSession(handle.facade, handoffStart) : null);
    if (partial) return partial;
    throw error;
  } finally {
    if (idleTimer) clearInterval(idleTimer);
    for (const detach of detachers) detach();
    try { handle.close('ephemeral-done'); } catch { /* teardown */ }
    sharedHandles.delete(handle.sessionId);
  }
}

export function createAgentShardSpread({ mgr, log = null } = {}) {
  if (typeof log === 'function') sharedLog = log;
  const handles = sharedHandles;
  const createRemoteSession = createRemoteAgentSession;
  const remote = (id) => handles.get(String(id || '')) || null;

  // mgr facade: prototype delegation keeps every manager method reachable;
  // only session-addressed methods gain the remote-handle routing.
  const wrapped = Object.create(mgr);
  wrapped.getSession = (id) => {
    const handle = remote(id);
    return handle ? handle.facade : mgr.getSession(id);
  };
  wrapped.listSessions = (options = {}) => {
    const rows = mgr.listSessions?.(options) || [];
    const extras = [];
    for (const handle of handles.values()) {
      if (handle.facade.closed && options?.includeClosed !== true) continue;
      extras.push(handle.facade);
    }
    return extras.length ? [...rows, ...extras] : rows;
  };
  wrapped.askSession = (sessionId, prompt, context, onToolCall, cwdOverride, prefetch, askOpts = {}) => {
    const handle = remote(sessionId);
    if (!handle) {
      return mgr.askSession(sessionId, prompt, context, onToolCall, cwdOverride, prefetch, askOpts);
    }
    return handle.ask(prompt, context, askOpts);
  };
  wrapped.closeSession = (id, reason) => {
    const handle = remote(id);
    if (!handle) return mgr.closeSession(id, reason);
    handle.close(reason);
    return true;
  };
  wrapped.unloadSessionRuntime = (id, reason) => {
    const handle = remote(id);
    if (!handle) return mgr.unloadSessionRuntime?.(id, reason);
    handle.release(reason);
    return true;
  };
  wrapped.hideSessionFromList = (id) => {
    const handle = remote(id);
    if (!handle) return mgr.hideSessionFromList?.(id);
    return true;
  };
  wrapped.enqueuePendingMessage = (id, entry) => {
    const handle = remote(id);
    if (!handle) {
      return typeof mgr.enqueuePendingMessage === 'function'
        ? mgr.enqueuePendingMessage(id, entry)
        : 0;
    }
    return handle.enqueue(entry);
  };
  wrapped.getSessionRuntime = (id) => {
    const handle = remote(id);
    return handle ? handle.runtimeInfo() : mgr.getSessionRuntime?.(id);
  };
  wrapped.getSessionProgressSnapshot = (id) => (
    remote(id) ? null : mgr.getSessionProgressSnapshot?.(id)
  );
  wrapped.getSessionLastProgressAt = (id) => {
    const handle = remote(id);
    return handle ? handle.lastFrameAt : mgr.getSessionLastProgressAt?.(id);
  };
  wrapped.getSessionPendingMessageDepth = (id) => {
    const handle = remote(id);
    return handle ? handle.queueDepth() : mgr.getSessionPendingMessageDepth?.(id);
  };
  wrapped.linkParentSignalToSession = (id, signal) => {
    const handle = remote(id);
    if (!handle) {
      return typeof mgr.linkParentSignalToSession === 'function'
        ? mgr.linkParentSignalToSession(id, signal)
        : false;
    }
    handle.linkAbortSignal(signal);
    return true;
  };

  return {
    mgr: wrapped,
    enabled: agentShardSpreadEnabled,
    createRemoteSession,
    handles,
    /** Test/teardown seam: drop every handle and detach from the daemon. */
    async close(reason = 'agent shard spread closed') {
      for (const handle of [...handles.values()]) {
        try { handle.close(reason); } catch { /* teardown */ }
      }
      handles.clear();
      const active = attachment;
      attachment = null;
      if (active) {
        try { await active.transport.close(reason); } catch { /* teardown */ }
      }
    },
  };
}
