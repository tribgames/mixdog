// A virtual clock for recorders whose code under test arms timers: setTimeout / setInterval are replaced (every arming and firing is recorded, nothing
// fires until advance is called), setImmediate is counted and passed through. The real timers are kept (realTimers); deadlines are `within`
// (recorder-error.mjs), which runs on the real clock.
export const realTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setImmediate: globalThis.setImmediate, clearImmediate: globalThis.clearImmediate };

/** A virtual clock for setTimeout / setInterval (armed and fired are recorded; nothing fires until `advance`); setImmediate is counted and passed through,
 *  `idle()` resolves once every setImmediate armed so far (and those they arm) has run, `whenArmed(test)` once a timer matching `test` has been armed, `nextArmed()` once the next timer of any kind is armed. */
export function virtualTimers({ ordered } = {}) {
  let now = 0; let next = 0; let immediates = 0;
  const pendingTimers = new Map();
  const armed = []; const fired = []; const advances = []; const idleWaiters = []; const armedWaiters = [];
  const note = (entry) => { armed.push(entry); for (const w of armedWaiters.splice(0)) { if (w.test(entry)) w.resolve(entry); else armedWaiters.push(w); } };
  const anyArmed = () => true;
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
    armed, fired, advances,
    elapsed: () => now,
    pending: () => [...pendingTimers.values()].map(({ api, ms, due }) => ({ api, ms, dueMs: due })),
    idle: () => (immediates === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve))),
    whenArmedAfter: (index, test) => { const found = armed.slice(index).find(test); return found ? Promise.resolve(found) : new Promise((resolve) => armedWaiters.push({ test: (entry) => armed.indexOf(entry) >= index && test(entry), resolve })); },
    nextArmed: () => new Promise((resolve) => armedWaiters.push({ test: anyArmed, resolve })),
    whenArmed: (test) => { const found = armed.find(test); return found ? Promise.resolve(found) : new Promise((resolve) => armedWaiters.push({ test, resolve })); },
    advance(ms) {
      const target = now + ms;
      // every advance is an input of the recording: its size and the virtual time after it, with the armed / fired counts before it (the position in
      // the armed and fired lists), and into the recorder's own ordered log when one is given
      const entry = { advanceMs: ms, fromMs: now, toMs: target, armedBefore: armed.length, firedBefore: fired.length };
      advances.push(entry);
      if (ordered) ordered().push({ virtualAdvance: ms, fromMs: now, toMs: target });
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