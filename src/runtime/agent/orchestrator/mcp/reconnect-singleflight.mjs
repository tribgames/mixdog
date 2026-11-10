export function createKeyedSingleflight() {
  const pending = new Map();
  return {
    run(key, task) {
      const lane = String(key || '');
      const existing = pending.get(lane);
      if (existing) return existing;
      let tracked;
      const promise = Promise.resolve().then(task);
      tracked = promise.finally(() => {
        if (pending.get(lane) === tracked) pending.delete(lane);
      });
      pending.set(lane, tracked);
      return tracked;
    },
    /** The in-flight task promise for `key`, or undefined. */
    wait(key) {
      return pending.get(String(key || ''));
    },
    has(key) {
      return pending.has(String(key || ''));
    },
    get size() {
      return pending.size;
    },
  };
}
