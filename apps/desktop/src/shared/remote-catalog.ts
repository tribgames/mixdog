/** A roster is unknown until an authoritative read or push supplies it.
 * Retain the latest publication for late subscribers, and let a push outrank
 * any startup read that was already in flight. Reset never publishes []:
 * reconnecting is not evidence that every session or agent disappeared. */
export function createRemoteCatalog<T>() {
  let rows: T[] | null = null;
  let revision = 0;
  let inFlight: Promise<T[] | null> | null = null;
  const listeners = new Set<(items: T[]) => void>();
  const notify = (listener: (items: T[]) => void, items: T[]): void => {
    try { listener(items); } catch { /* One visual consumer cannot break delivery. */ }
  };
  const publish = (items: T[]): void => {
    revision += 1;
    rows = items;
    for (const listener of [...listeners]) notify(listener, items);
  };
  return {
    get: (): T[] | null => rows,
    publish,
    reset(): void {
      revision += 1;
      rows = null;
      inFlight = null;
    },
    subscribe(listener: (items: T[]) => void): () => void {
      listeners.add(listener);
      if (rows !== null) notify(listener, rows);
      return () => { listeners.delete(listener); };
    },
    read(load: () => Promise<T[]>): Promise<T[] | null> {
      if (rows !== null) return Promise.resolve(rows);
      if (inFlight) return inFlight;
      const started = revision;
      const request = Promise.resolve().then(load).then((items) => {
        if (revision === started) publish(items);
        return rows;
      }).finally(() => {
        if (inFlight === request) inFlight = null;
      });
      inFlight = request;
      return request;
    },
  };
}
