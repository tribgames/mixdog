// prompt-cache-touch-store.mjs — the durable record cache warms re-arm from
// after a restart (cache-warm.mjs): per session, the last confirmed touch of
// its cached prefix — when a call whose usage showed a read or write on it was
// sent, the tier the provider reported writing, the account that holds it and
// the prompt size. Kept beside the session records, never in them: a warm's
// touch must not move a session's own timestamps (activity, autoClear).
// Expired entries are dropped on write.
//
// Beside the touches: per session, when a warm last used the cache
// successfully (a read with no write). The idle auto-clear measures idleness
// from it (idle-auto-clear-gate.mjs) until a real request settles, so it
// outlives the touch: a later miss or an expiry drops the touch, not the use.
import { join } from 'node:path';
import { readJsonStateSync, writeJsonAtomicAsync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';

const PROMPT_CACHE_TOUCH_FILE = 'prompt-cache-touches.json';

function validTouch(value) {
  return (
    value &&
    typeof value === 'object' &&
    Number(value.touchAt) > 0 &&
    Number(value.ttlMs) > 0 &&
    Number(value.promptTokens) > 0
  );
}

// A warm use as stored: `{ at, provider, model, accountId }` — the route and
// account whose cached prefix the warm read. A bare time (written before the
// identity was recorded) keeps its time and matches no route.
function warmUseRecord(value) {
  const record = value && typeof value === 'object' ? value : { at: value };
  if (!(Number(record.at) > 0)) return null;
  return {
    at: Number(record.at),
    provider: String(record.provider || ''),
    model: String(record.model || ''),
    accountId: String(record.accountId || ''),
  };
}

/** A touch store backed by `path` (default: the data dir's file). */
export function createPromptCacheTouchStore(
  path = () => join(resolvePluginData(), PROMPT_CACHE_TOUCH_FILE),
  { log = (line) => process.stderr.write(`[cache-warm] ${line}\n`) } = {}
) {
  let touches = null;
  let warmUses = null;
  let writing = Promise.resolve();
  const filePath = () => (typeof path === 'function' ? path() : path);
  const load = () => {
    if (touches) return touches;
    touches = new Map();
    warmUses = new Map();
    const stored = readJsonStateSync(filePath(), { fallback: null });
    for (const [sessionId, touch] of Object.entries(stored?.touches || {})) {
      if (validTouch(touch)) touches.set(sessionId, { ...touch });
    }
    for (const [sessionId, use] of Object.entries(stored?.warmUses || {})) {
      const record = warmUseRecord(use);
      if (record) warmUses.set(sessionId, record);
    }
    return touches;
  };
  const uses = () => {
    load();
    return warmUses;
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
      .then(() =>
        writeJsonAtomicAsync(
          filePath(),
          { version: 1, touches: out, warmUses: Object.fromEntries(uses()) },
          { compact: true }
        )
      );
    return writing;
  };
  // A failed write is reported; the next flush recovers the queue and writes.
  const scheduleFlush = () =>
    void flush().catch((err) => log(`touch store write failed (${filePath()}): ${err?.message || err}`));
  return {
    /** The session's last confirmed touch, or null. */
    get(sessionId) {
      const touch = load().get(String(sessionId || ''));
      return touch ? { ...touch } : null;
    },
    /** The sessions holding a touch. */
    ids() {
      return [...load().keys()];
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
    /** When a warm last used the session's cache successfully, or 0. */
    lastWarmUse(sessionId) {
      return uses().get(String(sessionId || ''))?.at || 0;
    },
    /** The session's last successful warm use `{ at, provider, model,
     *  accountId }`, or null. */
    warmUse(sessionId) {
      const use = uses().get(String(sessionId || ''));
      return use ? { ...use } : null;
    },
    /** A warm read the session's cache without writing at `at`, on the
     *  route and account `{ provider, model, accountId }`. */
    recordWarmUse(sessionId, at, identity = {}) {
      const record = warmUseRecord({ ...identity, at });
      if (!sessionId || !record) return;
      uses().set(String(sessionId), record);
      scheduleFlush();
    },
    /** The session's own activity supersedes its warm use (a real request
     *  settled) or its cached conversation is gone (compaction, clear). */
    forgetWarmUse(sessionId) {
      if (uses().delete(String(sessionId || ''))) scheduleFlush();
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
