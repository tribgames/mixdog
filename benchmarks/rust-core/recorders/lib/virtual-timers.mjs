// A virtual clock for recorders whose code under test arms timers: setTimeout / setInterval are replaced (every arming and firing is recorded, nothing
// fires until advance is called), setImmediate is counted and passed through. The real timers are kept for deadlines (realDeadline).
export const realTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setImmediate: globalThis.setImmediate, clearImmediate: globalThis.clearImmediate };

/** A deadline on the real clock for a step whose timers are virtual. */
export const realDeadline = (label, promise, ms = 60_000) => new Promise((resolve, reject) => { const timer = realTimers.setTimeout(() => reject(new Error(`${label}: no answer within ${ms} ms`)), ms); promise.then((v) => { realTimers.clearTimeout(timer); resolve(v); }, (e) => { realTimers.clearTimeout(timer); reject(e); }); });
/** A virtual clock for setTimeout / setInterval (armed and fired are recorded; nothing fires until `advance`); setImmediate is counted and passed through,
 *  `idle()` resolves once every setImmediate armed so far (and those they arm) has run, `whenArmed(test)` once a timer matching `test` has been armed. */
export function virtualTimers() {
  let now = 0; let next = 0; let immediates = 0;
  const pendingTimers = new Map();
  const armed = []; const fired = []; const idleWaiters = []; const armedWaiters = [];
  const note = (entry) => { armed.push(entry); for (const w of armedWaiters.splice(0)) { if (w.test(entry)) w.resolve(entry); else armedWaiters.push(w); } };
  const arm = (api, repeat) => (fn, ms = 1, ...args) => {
    const handle = { id: (next += 1), unref() { return this; }, ref() { return this; }, hasRef: () => true };
    note({ api, ms, atMs: now });
    pendingTimers.set(handle, { api, fn, args, due: now + ms, repeat: repeat ? ms : null, ms });
    return handle;
  };
  const clear = (handle) => { pendingTimers.delete(handle); };
  const settleImmediate = () => { immediates -= 1; if (immediates === 0) for (const resolve of idleWaiters.splice(0)) resolve(); };
  const live = new Set();
  globalThis.setTimeout = arm('setTimeout', false); globalThis.setInterval = arm('setInterval', true);
  globalThis.clearTimeout = clear; globalThis.clearInterval = clear;
  globalThis.setImmediate = (fn, ...args) => {
    note({ api: 'setImmediate', atMs: now }); immediates += 1;
    const handle = realTimers.setImmediate(() => { live.delete(handle); try { fn(...args); } finally { settleImmediate(); } });
    live.add(handle);
    return handle;
  };
  globalThis.clearImmediate = (handle) => { if (live.delete(handle)) settleImmediate(); realTimers.clearImmediate(handle); };
  return {
    armed, fired,
    elapsed: () => now,
    pending: () => [...pendingTimers.values()].map(({ api, ms, due }) => ({ api, ms, dueMs: due })),
    idle: () => (immediates === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve))),
    whenArmed: (test) => { const found = armed.find(test); return found ? Promise.resolve(found) : new Promise((resolve) => armedWaiters.push({ test, resolve })); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pendingTimers].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        const [handle, t] = due;
        now = t.due;
        if (t.repeat === null) pendingTimers.delete(handle); else t.due += t.repeat;
        fired.push({ api: t.api, ms: t.ms, atMs: now });
        t.fn(...t.args);
      }
      now = target;
    },
    restore() { Object.assign(globalThis, realTimers); },
  };
}