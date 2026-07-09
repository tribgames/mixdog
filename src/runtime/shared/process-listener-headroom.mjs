// Many independent singletons self-register process-level drains (exit,
// beforeExit, SIGTERM, …). Standalone scripts that import runtime modules
// directly bypass src/app.mjs, so raise the cap from a shared helper too.
export function ensureProcessListenerHeadroom(min = 64) {
  try {
    if (typeof process.getMaxListeners !== 'function' || typeof process.setMaxListeners !== 'function') return;
    const current = process.getMaxListeners();
    if (current === 0 || current >= min) return;
    process.setMaxListeners(min);
  } catch { /* ignore */ }
}

