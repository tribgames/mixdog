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
  loadLocalModule = () => import('../tui/session-local.mjs'),
} = {}) {
  const records = new Map();
  const recordsBySessionId = new Map();
  const agentSessionListeners = new Set();
  const agentSessionSnapshots = new Map();
  const activeAgentSessionProjections = new Set();
  const pendingAgentSessionProjections = new Map();
  const agentDispatchers = new Map();
  const agentDispatchRuns = new Map();
  let nextRuntimeId = 0;
  let closed = false;
  let localModulePromise = null;
  let prewarmPromise = null;
  let agentGraphPromise = null;
  let preparedProviderSignature = null;
  let providerPreparePromise = null;
  let unsubscribeAgentSessionPublisher = null;
  let agentSessionPublisherPromise = null;

  function localModule() {
    localModulePromise ??= Promise.resolve().then(loadLocalModule).catch((error) => {
      localModulePromise = null;
      throw error;
    });
    return localModulePromise;
  }

  function agentGraph() {
    agentGraphPromise ??= Promise.all([
      import('../runtime/agent/orchestrator/config.mjs'),
      import('../runtime/agent/orchestrator/providers/registry.mjs'),
      import('../runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs'),
    ]).then(
      ([config, registry, dispatch]) => ({ config, registry, dispatch }),
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

  function agentOwnedSession(session) {
    const owner = String(session?.owner || '').trim().toLowerCase();
    const agent = String(session?.agent || '').trim().toLowerCase();
    return Boolean(session?.id)
      && (owner === 'agent' || (agent && agent !== 'lead'));
  }

  async function projectAgentSession(session) {
    const [
      { restoreTranscriptItems },
      { getSessionProgressSnapshot },
    ] = await Promise.all([
      import('../tui/session/session-api-ext.mjs'),
      import('../runtime/agent/orchestrator/session/manager.mjs'),
    ]);
    const sessionId = String(session.id || '');
    const status = String(session.status || '').trim().toLowerCase();
    const progress = getSessionProgressSnapshot?.(sessionId) || null;
    const stage = String(progress?.stage || '').trim().toLowerCase();
    const busy = status === 'running' || status === 'queued'
      || (stage && stage !== 'idle' && stage !== 'done' && stage !== 'closed');
    return {
      sessionId,
      items: restoreTranscriptItems(
        Array.isArray(session.messages) ? session.messages : [],
        { sessionId, itemLimit: 512 },
      ),
      queued: [],
      busy,
      commandBusy: false,
      provider: session.provider || '',
      model: session.model || '',
      effort: session.effort || '',
      fast: session.fast === true,
      modelParameters: session.modelParameters || {},
      cwd: session.cwd || '',
      desktopSession: session.desktopSession || null,
      workflow: session.workflow || null,
      ownerClientHostPid: Number(session.clientHostPid) || process.pid,
    };
  }

  function publishAgentSessionState(sessionId, snapshot) {
    agentSessionSnapshots.delete(sessionId);
    agentSessionSnapshots.set(sessionId, snapshot);
    while (agentSessionSnapshots.size > 256) {
      const oldest = agentSessionSnapshots.keys().next().value;
      if (oldest === undefined) break;
      agentSessionSnapshots.delete(oldest);
    }
    for (const listener of [...agentSessionListeners]) {
      try { listener({ sessionId, snapshot }); } catch {}
    }
  }

  function scheduleAgentSessionProjection(session) {
    if (!agentOwnedSession(session) || closed) return;
    const sessionId = String(session.id);
    pendingAgentSessionProjections.set(sessionId, session);
    if (activeAgentSessionProjections.has(sessionId)) return;
    activeAgentSessionProjections.add(sessionId);
    queueMicrotask(() => {
      void (async () => {
        while (!closed) {
          const latest = pendingAgentSessionProjections.get(sessionId);
          if (!latest) break;
          pendingAgentSessionProjections.delete(sessionId);
          const snapshot = await projectAgentSession(latest);
          if (!closed) publishAgentSessionState(sessionId, snapshot);
        }
      })().catch((error) => {
        log(`agent session projection failed session=${sessionId}: ${error?.message || error}`);
      }).finally(() => {
        activeAgentSessionProjections.delete(sessionId);
        if (pendingAgentSessionProjections.has(sessionId) && !closed) {
          scheduleAgentSessionProjection(pendingAgentSessionProjections.get(sessionId));
        }
      });
    });
  }

  async function ensureAgentSessionPublisher() {
    if (unsubscribeAgentSessionPublisher) return;
    agentSessionPublisherPromise ??= import(
      '../runtime/agent/orchestrator/session/store.mjs'
    ).then((store) => {
      unsubscribeAgentSessionPublisher = store.subscribeLiveSessions(
        scheduleAgentSessionProjection,
      );
    }).finally(() => {
      agentSessionPublisherPromise = null;
    });
    await agentSessionPublisherPromise;
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

  function prewarm() {
    if (closed) return Promise.reject(new Error('session runtime host is closed'));
    prewarmPromise ??= localModule().then((module) => Promise.allSettled([
      module.preloadSessionRuntimeModule?.(),
      module.preloadAgentLoopRuntime?.(),
      module.preloadKeychainSecrets?.(),
    ])).then(() => ({ ready: true }));
    return prewarmPromise;
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
      await ensureAgentSessionPublisher();
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
      return await dispatcher({
        prompt: String(params.prompt ?? ''),
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
    prewarm,
    agentDispatch,
    async agentControl(args = {}, context = {}) {
      if (closed) throw new Error('session runtime host is closed');
      const runtime = ownerRuntime(context?.callerSessionId);
      if (!runtime?.agentControl) {
        throw new Error(`session ${context?.callerSessionId || 'unknown'} is not loaded`);
      }
      return runtime.agentControl(args);
    },
    refreshRuntimeWorkload() {
      return Promise.resolve(this.workloads);
    },
    subscribeAgentSessionStates(listener) {
      if (typeof listener !== 'function') return () => {};
      agentSessionListeners.add(listener);
      void ensureAgentSessionPublisher().catch((error) => {
        log(`agent session publisher failed (non-fatal): ${error?.message || error}`);
      });
      for (const [sessionId, snapshot] of agentSessionSnapshots) {
        try { listener({ sessionId, snapshot }); } catch {}
      }
      return () => agentSessionListeners.delete(listener);
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
      try { unsubscribeAgentSessionPublisher?.(); } catch {}
      unsubscribeAgentSessionPublisher = null;
      agentSessionListeners.clear();
      agentSessionSnapshots.clear();
      pendingAgentSessionProjections.clear();
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
