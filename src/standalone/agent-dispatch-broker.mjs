import { createFairCallScheduler } from './fair-call-scheduler.mjs';

const MEMORY_AGENTS = Object.freeze([
  'cycle1-agent',
  'cycle2-agent',
  'cycle3-agent',
]);
const MEMORY_AGENT_SET = new Set(MEMORY_AGENTS);

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(String(signal?.reason || 'agent dispatch canceled'));
}

function awaitSharedPreparation(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  let listener = null;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(abortError(signal));
    signal.addEventListener('abort', listener, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (listener) {
      try { signal.removeEventListener('abort', listener); } catch {}
    }
  });
}

/**
 * Process-singleton memory LLM broker.
 *
 * The daemon owns one provider/session/memory graph. Memory
 * process keeps PG, embeddings, and recall, and forwards only cycle LLM calls
 * here. A singleton is NOT a serial lane: every call gets its own dispatch
 * session + AbortController and the fair scheduler starts calls in parallel
 * unless an operator explicitly configures a finite active limit.
 */
export function createAgentDispatchBroker({
  loadConfig,
  initProviders,
  makeAgentDispatch,
  log = () => {},
  activeMax = Infinity,
  queueMax = 256,
  onActivityChanged = null,
} = {}) {
  if (typeof loadConfig !== 'function') throw new TypeError('loadConfig is required');
  if (typeof initProviders !== 'function') throw new TypeError('initProviders is required');
  if (typeof makeAgentDispatch !== 'function') throw new TypeError('makeAgentDispatch is required');

  const scheduler = createFairCallScheduler({
    name: 'memory agent dispatch',
    activeMax,
    queueMax,
    minOwnerQueue: Math.max(8, Math.floor(queueMax / 16)),
  });
  const inFlight = new Map();
  const dispatchers = new Map(MEMORY_AGENTS.map((agent) => [
    agent,
    makeAgentDispatch({
      agent,
      taskType: 'maintenance',
      sourceType: 'memory-cycle',
      brief: false,
    }),
  ]));
  let nextCallId = 0;
  let closed = false;
  let preparedProviderSignature = null;
  let providerPreparePromise = null;

  async function prepareProviders(signal = null) {
    const config = loadConfig();
    const providers = config?.providers || {};
    let signature = null;
    try { signature = JSON.stringify(providers); } catch {}
    if (signature !== null && preparedProviderSignature === signature) return;
    if (providerPreparePromise) {
      await awaitSharedPreparation(providerPreparePromise, signal);
      if (signature !== null && preparedProviderSignature === signature) return;
      return prepareProviders(signal);
    }
    const pending = Promise.resolve()
      // Process-global preparation is shared by every request. One caller's
      // cancellation may stop waiting but must never abort initialization
      // underneath independent calls.
      .then(() => initProviders(providers))
      .then(() => {
        preparedProviderSignature = signature;
      });
    const tracked = pending.finally(() => {
      if (providerPreparePromise === tracked) providerPreparePromise = null;
    });
    providerPreparePromise = tracked;
    await awaitSharedPreparation(tracked, signal);
  }

  async function warmup() {
    if (closed) throw new Error('memory agent dispatch broker is closed');
    await prepareProviders();
    return true;
  }

  function dispatch(params = {}, { callId = null, signal = null } = {}) {
    if (closed) return Promise.reject(new Error('memory agent dispatch broker is closed'));
    const agent = String(params.agent || '').trim();
    if (!MEMORY_AGENT_SET.has(agent)) {
      return Promise.reject(new Error(`memory agent dispatch denied for "${agent || 'unknown'}"`));
    }
    const prompt = String(params.prompt ?? '');
    if (!prompt) return Promise.reject(new Error(`agent dispatch prompt required for "${agent}"`));

    const id = String(callId || `broker-${process.pid}-${++nextCallId}`);
    const existing = inFlight.get(id);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const abortFromCaller = () => {
      if (controller.signal.aborted) return;
      try { controller.abort(signal?.reason); } catch { try { controller.abort(); } catch {} }
    };
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener?.('abort', abortFromCaller, { once: true });

    const run = async () => {
      if (controller.signal.aborted) throw abortError(controller.signal);
      await prepareProviders(controller.signal);
      if (controller.signal.aborted) throw abortError(controller.signal);
      const timeout = Number(params.timeout);
      return dispatchers.get(agent)({
        prompt,
        preset: params.preset || undefined,
        cwd: typeof params.cwd === 'string' && params.cwd ? params.cwd : undefined,
        parentSignal: controller.signal,
        ...(Number.isFinite(timeout) && timeout > 0 ? { idleTimeoutMs: timeout } : {}),
      });
    };
    const promise = scheduler.enqueue(`memory:${agent}`, run, {
      signal: controller.signal,
    });
    let record = null;
    const tracked = promise.finally(() => {
      signal?.removeEventListener?.('abort', abortFromCaller);
      if (inFlight.get(id) === record) inFlight.delete(id);
      try { onActivityChanged?.(snapshot()); } catch {}
    });
    record = { controller, promise: tracked };
    inFlight.set(id, record);
    try { onActivityChanged?.(snapshot()); } catch {}
    return tracked;
  }

  function cancel(callId, reason = 'memory agent dispatch canceled') {
    const id = String(callId || '');
    const record = inFlight.get(id);
    if (!record) return false;
    try { record.controller.abort(new Error(reason)); } catch { try { record.controller.abort(); } catch {} }
    return true;
  }

  async function cancelAndWait(callId, reason = 'memory agent dispatch canceled') {
    const id = String(callId || '');
    const record = inFlight.get(id);
    if (!record) return false;
    cancel(id, reason);
    try { await record.promise; } catch {}
    return true;
  }

  function snapshot() {
    return {
      ...scheduler.snapshot(),
      inFlight: inFlight.size,
      dispatchers: dispatchers.size,
    };
  }

  function close(reason = 'memory agent dispatch broker is closed') {
    if (closed) return;
    closed = true;
    for (const record of inFlight.values()) {
      try { record.controller.abort(new Error(reason)); } catch {}
    }
    scheduler.close(reason);
    log(`agent dispatch broker closed (${reason})`);
  }

  return {
    warmup,
    dispatch,
    cancel,
    cancelAndWait,
    snapshot,
    close,
  };
}
