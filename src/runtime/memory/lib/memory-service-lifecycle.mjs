// Coordinate runtime and listener readiness without letting shutdown race
// resource acquisition. The facade retains ownership of the actual resources.
export function createMemoryServiceLifecycle({
  initialize,
  openListener,
  closeListener,
  advertisePort,
  withdraw,
  stopBackgroundWork,
  shutdown,
  onStart,
  onReady,
  onInitError,
}) {
  let initialized = false;
  let runtimeReady = null;
  let listenerReady = null;
  let starting = null;
  let stopping = null;
  let controller = null;

  function init() {
    if (stopping) return Promise.reject(new Error('memory service stopping'));
    if (starting) return starting;
    if (initialized) return Promise.resolve();
    controller = new AbortController();
    const { signal } = controller;
    onStart();
    runtimeReady = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      try {
        await initialize(signal);
        signal.throwIfAborted();
        initialized = true;
      } catch (error) {
        onInitError(error);
        throw error;
      }
    });
    listenerReady = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const port = await openListener();
      signal.throwIfAborted();
      if (port != null) advertisePort(port);
      return port;
    });
    // Attach to both branches immediately: runtime failure must be observed
    // even while the HTTP bind is still pending.
    const promise = Promise.all([runtimeReady, listenerReady])
      .then(([, port]) => {
        signal.throwIfAborted();
        onReady(port);
      })
      .catch(async (error) => {
        // Preserve the startup failure if releasing partially opened resources
        // also fails. Explicit stop() calls still receive shutdown failures.
        try {
          await stop();
        } catch {}
        throw error;
      })
      .finally(() => {
        if (starting === promise) starting = null;
      });
    starting = promise;
    return promise;
  }

  function stop() {
    if (stopping) return stopping;
    controller?.abort(new Error('memory service stopping'));
    stopping = Promise.resolve()
      .then(async () => {
        const failures = [];
        const attempt = async (cleanup) => {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        };
        await attempt(withdraw);
        const listenerClosed = attempt(closeListener);
        // Observe errors immediately, but drain the listener only after stopping
        // workers that an active HTTP request may itself be waiting for.
        // Do not await starting: its failure path awaits this shutdown. Wait for
        // the underlying resource owners instead, including any in-flight bind.
        await Promise.allSettled([runtimeReady, listenerReady]);
        await attempt(stopBackgroundWork);
        await listenerClosed;
        await attempt(shutdown);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'memory service shutdown failed');
      })
      .finally(() => {
        initialized = false;
        runtimeReady = null;
        listenerReady = null;
        starting = null;
        controller = null;
        stopping = null;
      });
    return stopping;
  }

  return {
    init,
    stop,
    getInitialized: () => initialized,
    getInitPromise: () => runtimeReady,
    isStopping: () => stopping != null,
  };
}
