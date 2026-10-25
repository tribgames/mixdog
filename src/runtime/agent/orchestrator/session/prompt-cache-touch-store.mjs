// prompt-cache-touch-store.mjs — the durable record cache warms re-arm from
// after a restart (cache-warm.mjs): per session, the last confirmed touch of
// its cached prefix — when a call whose usage showed a read or write on it was
// sent, the tier the provider reported writing, the account that holds it and
// the prompt size. Kept beside the session records, never in them: a warm's
// touch must not move a session's own timestamps (activity, autoClear).
// Expired entries are dropped on write.
import { join } from 'node:path';
import { readJsonStateSync, writeJsonAtomicAsync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';

export const PROMPT_CACHE_TOUCH_FILE = 'prompt-cache-touches.json';

function validTouch(value) {
  return (
    value &&
    typeof value === 'object' &&
    Number(value.touchAt) > 0 &&
    Number(value.ttlMs) > 0 &&
    Number(value.promptTokens) > 0
  );
}

/** A touch store backed by `path` (default: the data dir's file). */
export function createPromptCacheTouchStore(path = () => join(resolvePluginData(), PROMPT_CACHE_TOUCH_FILE)) {
  let touches = null;
  let writing = Promise.resolve();
  const filePath = () => (typeof path === 'function' ? path() : path);
  const load = () => {
    if (touches) return touches;
    touches = new Map();
    const stored = readJsonStateSync(filePath(), { fallback: null });
    for (const [sessionId, touch] of Object.entries(stored?.touches || {})) {
      if (validTouch(touch)) touches.set(sessionId, { ...touch });
    }
    return touches;
  };
  // Touches change once per real request or warm: each change is written at
  // once, the writes serialized.
  const flush = () => {
    const now = Date.now();
    const out = {};
    for (const [sessionId, touch] of load()) {
      if (touch.touchAt + touch.ttlMs > now) out[sessionId] = touch;
      else touches.delete(sessionId);
    }
    writing = writing
      .catch(() => {})
      .then(() => writeJsonAtomicAsync(filePath(), { version: 1, touches: out }, { compact: true }));
    return writing;
  };
  const scheduleFlush = () => void flush().catch(() => {});
  return {
    /** The session's last confirmed touch, or null. */
    get(sessionId) {
      const touch = load().get(String(sessionId || ''));
      return touch ? { ...touch } : null;
    },
    /** Record a confirmed touch `{ touchAt, ttlMs, accountId, promptTokens }`. */
    record(sessionId, touch) {
      if (!sessionId || !validTouch(touch)) return;
      load().set(String(sessionId), {
        touchAt: Number(touch.touchAt),
        ttlMs: Number(touch.ttlMs),
        promptTokens: Number(touch.promptTokens),
        ...(touch.accountId ? { accountId: String(touch.accountId) } : {}),
      });
      scheduleFlush();
    },
    /** The session's cached prefix is gone (compaction, clear, close, miss). */
    forget(sessionId) {
      if (load().delete(String(sessionId || ''))) scheduleFlush();
    },
    /** Write pending changes now (tests, shutdown). */
    flush,
  };
}

let defaultStore = null;
export function promptCacheTouchStore() {
  defaultStore ??= createPromptCacheTouchStore();
  return defaultStore;
}
