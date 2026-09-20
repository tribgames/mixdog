// runtime-liveness keeps one parent link per session because askSession swaps
// its controller at turn start.  Agent dispatch can have several independent
// cancellation sources, so collapse them before installing that one link.
// The first already-aborted source wins (in declaration order), retaining its
// original reason instead of replacing it with a generic AbortError.
export function composeAgentDispatchAbortSignal(signals) {
  const sources = (Array.isArray(signals) ? signals : []).filter((signal) => signal instanceof AbortSignal);
  if (sources.length === 0) return { signal: null, dispose: () => {} };
  const controller = new AbortController();
  const listeners = [];
  const abortFrom = (signal) => {
    if (controller.signal.aborted) return;
    try {
      controller.abort(signal.reason);
    } catch {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
  };
  for (const signal of sources) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener('abort', listener, { once: true });
    listeners.push([signal, listener]);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) {
        try {
          signal.removeEventListener('abort', listener);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
