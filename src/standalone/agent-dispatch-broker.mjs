import { createFairCallScheduler } from './fair-call-scheduler.mjs';
import { hashStructuredValue } from '../runtime/shared/json-metrics.mjs';

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

/** Identity of a dispatch PAYLOAD. A retry repeats it exactly; a caller that
 *  reuses a callId for different work is issuing a different call. */
function dispatchSignature(agent, params) {
  try {
    return hashStructuredValue({
      agent,
      prompt: String(params?.prompt ?? ''),
      preset: params?.preset ?? null,
      cwd: typeof params?.cwd === 'string' ? params.cwd : null,
      timeout: Number.isFinite(Number(params?.timeout)) ? Number(params.timeout) : null,
    });
  } catch { return null; }
}

/**
 * Process-singleton memory LLM broker.
 *
 * The memory process keeps PG, embeddings, and recall, and forwards only
 * cycle LLM calls here. The broker owns admission (fair scheduler), callId
 * idempotency, and cancellation; actual agent execution is delegated through
 * dispatchAgent to the recyclable session runtime worker so orchestrator and
 * provider churn never accumulates in the permanent daemon process. A
 * singleton is NOT a serial lane: every call gets its own AbortController and
 * the fair scheduler starts calls in parallel unless an operator explicitly
 * configures a finite active limit.
 */
export function createAgentDispatchBroker({
  dispatchAgent,
  log = () => {},
  activeMax = Infinity,
  queueMax = 256,
  onActivityChanged = null,
} = {}) {
  if (typeof dispatchAgent !== 'function') throw new TypeError('dispatchAgent is required');

  const scheduler = createFairCallScheduler({
    name: 'memory agent dispatch',
    activeMax,
    queueMax,
    minOwnerQueue: Math.max(8, Math.floor(queueMax / 16)),
  });
  const inFlight = new Map();
  let nextCallId = 0;
  let closed = false;

  function dispatch(params = {}, { callId = null, signal = null } = {}) {
    if (closed) return Promise.reject(new Error('memory agent dispatch broker is closed'));
    const agent = String(params.agent || '').trim();
    if (!MEMORY_AGENT_SET.has(agent)) {
      return Promise.reject(new Error(`memory agent dispatch denied for "${agent || 'unknown'}"`));
    }
    const prompt = String(params.prompt ?? '');
    if (!prompt) return Promise.reject(new Error(`agent dispatch prompt required for "${agent}"`));

    const id = String(callId || `broker-${process.pid}-${++nextCallId}`);
    const signature = dispatchSignature(agent, params);
    const existing = inFlight.get(id);
    if (existing) {
      // Scope note: a broker callId dedupes CONCURRENT duplicates only. The
      // memory client mints a fresh id per dispatch and cancels instead of
      // replaying (runtime/memory/lib/agent-ipc.mjs callAgentDispatch), so a
      // settled id carries no promise and needs no retained result.
      // Within that window a callId is still an idempotency key, not an
      // overwrite slot: answering a different payload from an unrelated
      // in-flight run is silent data loss.
      if (signature && existing.signature && existing.signature !== signature) {
        return Promise.reject(Object.assign(
          new Error(`agent dispatch callId '${id}' was reused with a different payload`),
          { code: 'ECALLIDCONFLICT' },
        ));
      }
      return existing.promise;
    }

    const controller = new AbortController();
    const abortFromCaller = () => {
      if (controller.signal.aborted) return;
      try { controller.abort(signal?.reason); } catch { try { controller.abort(); } catch {} }
    };
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener?.('abort', abortFromCaller, { once: true });

    const run = async () => {
      if (controller.signal.aborted) throw abortError(controller.signal);
      const timeout = Number(params.timeout);
      // Execution happens in the recyclable session runtime worker, not in
      // this permanent daemon process: provider/orchestrator churn from
      // memory-cycle agents returns to the OS at the worker's next memory
      // recycle instead of accumulating in daemon commit forever.
      return dispatchAgent({
        dispatchId: id,
        agent,
        options: { taskType: 'maintenance', sourceType: 'memory-cycle', brief: false },
        params: {
          prompt,
          preset: params.preset || undefined,
          cwd: typeof params.cwd === 'string' && params.cwd ? params.cwd : undefined,
          ...(Number.isFinite(timeout) && timeout > 0 ? { idleTimeoutMs: timeout } : {}),
        },
      }, { signal: controller.signal });
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
    record = { controller, promise: tracked, signature };
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
    dispatch,
    cancel,
    cancelAndWait,
    snapshot,
    close,
  };
}
