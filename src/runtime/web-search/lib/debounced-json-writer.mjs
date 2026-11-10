import { writeJson } from './config.mjs';

const FLUSH_DELAY_MS = 5000;
const WARN_INTERVAL_MS = 60000;

/**
 * Debounced, best-effort persistence of one JSON state object.
 *
 * Every mutation calls `schedule(state)`; writes coalesce into one roundtrip
 * per delay window instead of an fsync per call, and `process.on('exit')`
 * still flushes on graceful shutdown. A failed write (a Windows AV/indexer can
 * hold the destination open) keeps the state dirty and retries quietly.
 * `track(state)` names the object to persist without marking it dirty.
 */
export function createDebouncedJsonWriter({ path, label }) {
  let dirty = false;
  let timer = null;
  let active = null;
  let lastWarnAt = 0;

  const arm = (delayMs) => {
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delayMs);
    timer.unref?.();
  };

  function schedule(state) {
    dirty = true;
    active = state;
    if (!timer) arm(FLUSH_DELAY_MS);
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty || !active) return;
    try {
      writeJson(path, active);
      dirty = false;
    } catch (err) {
      const now = Date.now();
      if (now - lastWarnAt > WARN_INTERVAL_MS) {
        lastWarnAt = now;
        process.stderr.write(`[${label}] flush delayed: ${err?.code || err?.message || err}\n`);
      }
      if (!timer) arm(FLUSH_DELAY_MS * 2);
    }
  }

  process.on('exit', flush);
  return {
    schedule,
    flush,
    track(state) {
      active = state;
    },
  };
}
