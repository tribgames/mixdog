/** Secure transport readiness is not view readiness. One recovery request is
 * in flight per connection; changes during it coalesce into the next request.
 * A superseded connection can never complete the replacement's recovery. */
export function createRemoteViewSync(options: {
  synchronize(): Promise<unknown>;
  state(state: 'syncing' | 'connected'): void;
  error(error: unknown): void;
  interrupted(): Error;
}) {
  let generation = 0;
  let active = false;
  let requested = 0;
  let completed = 0;
  let running = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 250;
  const waiting = new Set<{ resolve(): void; reject(error: Error): void }>();
  const pump = (): void => {
    if (!active || running || retry || completed === requested) return;
    const epoch = generation;
    const revision = requested;
    running = true;
    options.state('syncing');
    void options.synchronize().then(() => {
      if (!active || epoch !== generation) return;
      completed = revision;
      retryDelay = 250;
      if (completed === requested) {
        options.state('connected');
        for (const waiter of waiting) waiter.resolve();
        waiting.clear();
      }
    }).catch((error) => {
      if (!active || epoch !== generation) return;
      options.error(error);
      retry = setTimeout(() => { retry = null; pump(); }, retryDelay);
      retryDelay = Math.min(10_000, retryDelay * 2);
    }).finally(() => {
      if (epoch !== generation) return;
      running = false;
      pump();
    });
  };
  const ready = (): Promise<void> => {
    if (!active) return Promise.reject(options.interrupted());
    if (completed === requested) return Promise.resolve();
    return new Promise((resolve, reject) => waiting.add({ resolve, reject }));
  };
  return {
    open(): void {
      active = true;
      generation += 1;
      running = false;
      requested += 1;
      completed = 0;
      pump();
    },
    request(): Promise<void> {
      requested += 1;
      pump();
      return ready();
    },
    ready,
    close(): void {
      active = false;
      generation += 1;
      running = false;
      if (retry) clearTimeout(retry);
      retry = null;
      for (const waiter of waiting) waiter.reject(options.interrupted());
      waiting.clear();
    },
  };
}
