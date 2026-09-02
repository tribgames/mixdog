/**
 * In-process session runtime host.
 *
 * Sessions remain independent async actors, but share the daemon's V8 isolate
 * and ESM module cache. Native helpers and explicitly bounded worker pools keep
 * CPU-heavy parsing/search work off the daemon loop.
 */
export function createInlineSessionRuntimeHost({
  cwd = process.cwd(),
  log = () => {},
  measureBootPhase = async (_phase, task) => await task(),
  loadLocalModule = () => import('../tui/session-local.mjs'),
  loadAgentGraph = () => Promise.all([
    import('../runtime/agent/orchestrator/config.mjs'),
    import('../runtime/agent/orchestrator/providers/registry.mjs'),
    import('../runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs'),
  ]).then(([config, registry, dispatch]) => ({ config, registry, dispatch })),
  warmKeychain = async () => {
    const module = await import('../lib/keychain-cjs.cjs');
    const keychain = module.default || module;
    await keychain.prewarmSecrets?.();
  },
  executeAgentControl = null,
} = {}) {
  const records = new Map();
  const recordsBySessionId = new Map();
  const agentDispatchers = new Map();
  const agentDispatchRuns = new Map();
  let nextRuntimeId = 0;
  let closed = false;
  let localModulePromise = null;
  let keychainPrewarmPromise = null;
  let agentGraphPromise = null;
  let preparedProviderSignature = null;
  let providerPreparePromise = null;

  function measured(phase, task) {
    return Promise.resolve().then(() => measureBootPhase(phase, task));
  }

  function localModule() {
    localModulePromise ??= measured(
      'session-local-import',
      () => Promise.resolve().then(loadLocalModule),
    ).catch((error) => {
      localModulePromise = null;
      throw error;
    });
    return localModulePromise;
  }

  function agentGraph() {
    agentGraphPromise ??= measured(
      'agent-dispatch-graph-import',
      () => Promise.resolve().then(loadAgentGraph),
    ).then(
      (graph) => graph,
      (error) => {
        agentGraphPromise = null;
        throw error;
      },
    );
    return agentGraphPromise;
  }

  async function prepareAgentProviders() {
    const { config, registry } = await agentGraph();
    const providers = config.loadConfig()?.providers || {};
    let signature = null;
    try { signature = JSON.stringify(providers); } catch { /* re-prepare each call */ }
    if (signature !== null && preparedProviderSignature === signature) return;
    if (providerPreparePromise) {
      await providerPreparePromise;
      if (signature !== null && preparedProviderSignature === signature) return;
      return prepareAgentProviders();
    }
    const pending = Promise.resolve()
      .then(() => registry.initProviders(providers))
      .then(() => { preparedProviderSignature = signature; });
    const tracked = pending.finally(() => {
      if (providerPreparePromise === tracked) providerPreparePromise = null;
    });
    providerPreparePromise = tracked;
    await tracked;
  }

  function forget(record) {
    if (!record || !records.delete(record.id)) return;
    for (const [sessionId, owner] of recordsBySessionId) {
      if (owner === record) recordsBySessionId.delete(sessionId);
    }
  }

  function ownerRuntime(sessionId) {
    const id = String(sessionId || '').trim();
    const known = recordsBySessionId.get(id);
    if (known) return known.runtime;
    for (const record of records.values()) {
      const current = String(record.runtime.getState?.()?.sessionId || record.runtime.id || '');
      if (!current || current !== id) continue;
      recordsBySessionId.set(id, record);
      return record.runtime;
    }
    return null;
  }

  async function create(options = {}) {
    if (closed) throw new Error('session runtime host is closed');
    const module = await localModule();
    const runtime = await module.createLocalSessionRuntime({
      ...options,
      ...(options.cwd ? {} : { cwd }),
      ...(typeof executeAgentControl === 'function' ? { executeAgentControl } : {}),
    });
    const record = {
      id: `inline-${process.pid}-${++nextRuntimeId}`,
      runtime,
    };
    records.set(record.id, record);
    const hintedSessionId = String(options.sessionId || '').trim();
    if (hintedSessionId) recordsBySessionId.set(hintedSessionId, record);

    const originalDispose = typeof runtime.dispose === 'function'
      ? runtime.dispose.bind(runtime)
      : null;
    runtime.dispose = async (...args) => {
      try {
        return await originalDispose?.(...args);
      } finally {
        forget(record);
      }
    };
    return runtime;
  }

  function prewarmKeychain() {
    if (closed) return Promise.reject(new Error('session runtime host is closed'));
    keychainPrewarmPromise ??= measured('keychain-prewarm', warmKeychain)
      .then(() => ({ ready: true }))
      .catch((error) => {
        keychainPrewarmPromise = null;
        throw error;
      });
    return keychainPrewarmPromise;
  }

  async function agentDispatch(payload = {}, { signal = null } = {}) {
    if (closed) throw new Error('session runtime host is closed');
    const dispatchId = String(payload?.dispatchId || '');
    if (!dispatchId) throw new Error('agent dispatch id is required');
    if (agentDispatchRuns.has(dispatchId)) {
      throw new Error(`agent dispatch ${dispatchId} is already running`);
    }
    const controller = new AbortController();
    const abort = () => {
      if (controller.signal.aborted) return;
      try { controller.abort(signal?.reason); } catch { try { controller.abort(); } catch {} }
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    agentDispatchRuns.set(dispatchId, controller);
    try {
      if (controller.signal.aborted) throw controller.signal.reason || new Error('agent dispatch canceled');
      const agent = String(payload.agent || '');
      const { dispatch } = await agentGraph();
      await prepareAgentProviders();
      if (controller.signal.aborted) throw controller.signal.reason || new Error('agent dispatch canceled');
      let dispatcher = agentDispatchers.get(agent);
      if (!dispatcher) {
        dispatcher = dispatch.makeAgentDispatch({
          agent,
          ...(payload.options && typeof payload.options === 'object' ? payload.options : {}),
        });
        agentDispatchers.set(agent, dispatcher);
      }
      const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
      const prompt = String(params.prompt ?? '');
      return await dispatcher({
        prompt,
        preset: params.preset || undefined,
        cwd: typeof params.cwd === 'string' && params.cwd ? params.cwd : undefined,
        parentSignal: controller.signal,
        ...(Number.isFinite(Number(params.idleTimeoutMs)) && Number(params.idleTimeoutMs) > 0
          ? { idleTimeoutMs: Number(params.idleTimeoutMs) }
          : {}),
      });
    } finally {
      signal?.removeEventListener?.('abort', abort);
      agentDispatchRuns.delete(dispatchId);
    }
  }

  return {
    create,
    prewarmKeychain,
    agentDispatch,
    async agentControl(args = {}, context = {}) {
      if (closed) throw new Error('session runtime host is closed');
      if (typeof executeAgentControl === 'function') {
        return await executeAgentControl(args, context);
      }
      throw new Error('canonical Agent control is unavailable');
    },
    notifySessionCompletion(ownerSessionId, text, meta = {}) {
      const runtime = ownerRuntime(ownerSessionId);
      return runtime?.deliverToolCompletion?.(
        String(ownerSessionId || ''),
        String(text || ''),
        meta,
      ) === true;
    },
    async agentSessionAction(sessionId, action, args = []) {
      void sessionId;
      void action;
      void args;
      throw new Error('Agent sessions are owned by the canonical session service');
    },
    refreshRuntimeWorkload() {
      return Promise.resolve(this.workloads);
    },
    subscribeAgentSessionStates(listener) {
      void listener;
      return () => {};
    },
    agentSessionState(sessionId) {
      void sessionId;
      return null;
    },
    get workloads() {
      const memory = process.memoryUsage();
      return {
        mode: 'in-process',
        refreshedAt: Date.now(),
        shardCount: 0,
        shards: [],
        worker: {
          pid: process.pid,
          runtimes: records.size,
          memory: {
            rss: memory.rss,
            heapTotal: memory.heapTotal,
            heapUsed: memory.heapUsed,
            external: memory.external,
          },
        },
      };
    },
    async close(reason = 'session runtime host closed') {
      if (closed) return;
      closed = true;
      for (const controller of agentDispatchRuns.values()) {
        try { controller.abort(new Error(reason)); } catch {}
      }
      agentDispatchRuns.clear();
      const active = [...records.values()];
      await Promise.allSettled(active.map((record) => record.runtime.dispose?.(reason)));
      records.clear();
      recordsBySessionId.clear();
    },
    get status() {
      return {
        mode: 'in-process',
        active: !closed,
        worker: {
          pid: process.pid,
          pids: [process.pid],
          runtimes: records.size,
        },
        shards: [],
        shardCount: 0,
        providerCooldown: null,
      };
    },
  };
}
