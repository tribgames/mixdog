// Agent dispatch through the inline host: one cached dispatcher per agent,
// one abort controller per running dispatch id, providers prepared before
// the first call.

export function createInlineAgentDispatch({ assertOpen, agentGraph, prepareAgentProviders }) {
  const agentDispatchers = new Map();
  const agentDispatchRuns = new Map();

  function dispatchArgs(params, signal) {
    const prompt = String(params.prompt ?? '');
    return {
      prompt,
      preset: params.preset || undefined,
      cwd: typeof params.cwd === 'string' && params.cwd ? params.cwd : undefined,
      parentSignal: signal,
      ...(Number.isFinite(Number(params.idleTimeoutMs)) && Number(params.idleTimeoutMs) > 0
        ? { idleTimeoutMs: Number(params.idleTimeoutMs) }
        : {}),
    };
  }

  async function agentDispatch(payload = {}, { signal = null } = {}) {
    assertOpen();
    const dispatchId = String(payload?.dispatchId || '');
    if (!dispatchId) throw new Error('agent dispatch id is required');
    if (agentDispatchRuns.has(dispatchId)) {
      throw new Error(`agent dispatch ${dispatchId} is already running`);
    }
    const controller = new AbortController();
    const abort = () => {
      if (controller.signal.aborted) return;
      controller.abort(signal?.reason);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    agentDispatchRuns.set(dispatchId, controller);
    try {
      assertOpen(controller.signal);
      const agent = String(payload.agent || '');
      const { dispatch } = await agentGraph();
      assertOpen(controller.signal);
      await prepareAgentProviders(controller.signal);
      assertOpen(controller.signal);
      let dispatcher = agentDispatchers.get(agent);
      if (!dispatcher) {
        dispatcher = dispatch.makeAgentDispatch({
          agent,
          ...(payload.options && typeof payload.options === 'object' ? payload.options : {}),
        });
        agentDispatchers.set(agent, dispatcher);
      }
      const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
      return await dispatcher(dispatchArgs(params, controller.signal));
    } finally {
      signal?.removeEventListener?.('abort', abort);
      agentDispatchRuns.delete(dispatchId);
    }
  }

  function abortAll(reason) {
    for (const controller of agentDispatchRuns.values()) controller.abort(new Error(reason));
    agentDispatchRuns.clear();
  }

  return { agentDispatch, abortAll };
}
