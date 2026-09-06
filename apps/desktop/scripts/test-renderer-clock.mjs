// Deterministic document/timer owner for presentation lifecycle tests.
class ListenerTarget {
  listeners = new Map();
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name) {
    for (const callback of [...(this.listeners.get(name) || [])]) callback({ type: name });
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((sum, entries) => sum + entries.size, 0);
  }
}

export function createRendererClock(visibility = 'visible') {
  const doc = new ListenerTarget();
  doc.visibilityState = visibility;
  const win = new ListenerTarget();
  const timers = new Map();
  const storage = new Map();
  let now = 1_000_000;
  let sequence = 0;
  const schedule = (callback, delay, repeating) => {
    const id = ++sequence;
    timers.set(id, { callback, delay, repeating, at: now + delay });
    return id;
  };
  Object.assign(win, {
    document: doc,
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
  });
  const settle = async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  };
  return {
    win, doc, timers, storage, settle,
    get now() { return now; },
    visibility(value) { doc.visibilityState = value; doc.emit('visibilitychange'); },
    async advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.repeating) timer.at += timer.delay;
        else timers.delete(id);
        timer.callback();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}
