/**
 * repl/runtime-handle.mjs — lazy session-runtime ownership for the REPL: one
 * runtime is created on first use, a close that races the creation still
 * closes the runtime that eventually arrives, and nothing is handed out after
 * close.
 */
export function createRuntimeHandle({ loadRuntimeModule, providerName, model, toolMode, closeInput }) {
  const state = { runtime: null, runtimePromise: null, closed: false };

  const ensureRuntime = async () => {
    if (state.closed) throw new Error('runtime closed');
    if (state.runtime) return state.runtime;
    if (!state.runtimePromise) {
      state.runtimePromise = (async () => {
        const { createMixdogSessionRuntime } = await loadRuntimeModule();
        const next = await createMixdogSessionRuntime({ provider: providerName, model, toolMode });
        state.runtime = next;
        return next;
      })().finally(() => {
        state.runtimePromise = null;
      });
    }
    const next = await state.runtimePromise;
    if (state.closed) {
      try {
        await next.close('cli-exit');
      } catch {}
      if (state.runtime === next) state.runtime = null;
      throw new Error('runtime closed');
    }
    return next;
  };

  const closeRuntime = async (reason = 'cli-exit') => {
    if (state.closed) return;
    state.closed = true;
    try {
      closeInput();
    } catch {}
    const pendingRuntime =
      state.runtime || (state.runtimePromise ? await state.runtimePromise.catch(() => null) : null);
    if (pendingRuntime) await pendingRuntime.close(reason);
  };

  return { ensureRuntime, closeRuntime, getRuntime: () => state.runtime };
}
