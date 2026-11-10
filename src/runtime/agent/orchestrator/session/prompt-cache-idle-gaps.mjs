// prompt-cache-idle-gaps.mjs — per session, the idle gaps the cache warmer
// learns from (cache-warm.mjs): from the send of the session's last real
// request (when it used the cache) to its next real request. Kept beside the
// prompt-cache touch store, never in the session record. A gap is kept as
// `{ at, ms }`, or `{ at, ms, censored: true }` when the session was still
// idle at the window it was cut at. The session's open gap (`open`: its
// start) survives a restart. Gaps older than the lookback are pruned on
// write; a deleted session's entry is dropped.
import { join } from 'node:path';
import { readJsonStateSync, writeJsonAtomicAsync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';

const PROMPT_CACHE_IDLE_GAP_FILE = 'prompt-cache-idle-gaps.json';

const validGap = (gap) => gap && Number(gap.at) > 0 && Number(gap.ms) > 0;

/**
 * An idle-gap store backed by `path` (default: the data dir's file).
 * `lookbackMs`: how long gaps are kept; `windowMs`: a gap reaching it is
 * recorded as censored there; `minMs`: shorter gaps are not kept (no
 * refresh point lies inside them).
 */
export function createIdleGapStore({
  path = () => join(resolvePluginData(), PROMPT_CACHE_IDLE_GAP_FILE),
  lookbackMs,
  windowMs,
  minMs,
  now = () => Date.now(),
  log = (line) => process.stderr.write(`[cache-warm] ${line}\n`),
} = {}) {
  let sessions = null;
  let writing = Promise.resolve();
  const filePath = () => (typeof path === 'function' ? path() : path);
  const load = () => {
    if (sessions) return sessions;
    sessions = new Map();
    const stored = readJsonStateSync(filePath(), { fallback: null });
    for (const [sessionId, entry] of Object.entries(stored?.sessions || {})) {
      const gaps = Array.isArray(entry?.gaps)
        ? entry.gaps.filter(validGap).map((gap) => {
            const item = { at: Number(gap.at), ms: Number(gap.ms) };
            if (gap.censored) item.censored = true;
            return item;
          })
        : [];
      const open = Number(entry?.open) > 0 ? Number(entry.open) : 0;
      if (gaps.length || open) sessions.set(sessionId, { open, gaps });
    }
    return sessions;
  };
  const entryOf = (sessionId) => {
    const id = String(sessionId || '');
    if (!load().has(id)) sessions.set(id, { open: 0, gaps: [] });
    return sessions.get(id);
  };
  const flush = () => {
    const since = now() - lookbackMs;
    const out = {};
    for (const [sessionId, entry] of load()) {
      entry.gaps = entry.gaps.filter((gap) => gap.at >= since);
      if (entry.open && entry.open < since) entry.open = 0;
      if (!entry.gaps.length && !entry.open) sessions.delete(sessionId);
      else out[sessionId] = { ...(entry.open ? { open: entry.open } : {}), gaps: entry.gaps };
    }
    writing = writing
      .catch(() => {})
      .then(() => writeJsonAtomicAsync(filePath(), { version: 1, sessions: out }, { compact: true }));
    return writing;
  };
  // A failed write is reported; the next flush recovers the queue and writes.
  const scheduleFlush = () =>
    void flush().catch((err) => log(`idle-gap store write failed (${filePath()}): ${err?.message || err}`));
  return {
    /** The session went idle: its last real request used the cache at `at`. */
    open(sessionId, at) {
      if (!sessionId || !(Number(at) > 0)) return;
      entryOf(sessionId).open = Number(at);
      scheduleFlush();
    },
    /** A real request arrived at `at`: close the open gap as a return, or as
     *  censored at the window when it outlasted it. Resolves the kept gap or
     *  null (none open, or too short to keep). */
    close(sessionId, at) {
      const entry = sessionId ? load().get(String(sessionId)) : null;
      if (!entry?.open) return null;
      const start = entry.open;
      entry.open = 0;
      const ms = Number(at) - start;
      let gap = null;
      if (ms >= windowMs) gap = { at: start, ms: windowMs, censored: true };
      else if (ms > minMs) gap = { at: start, ms };
      if (gap) entry.gaps.push(gap);
      scheduleFlush();
      return gap;
    },
    /** The session's kept gaps of the lookback (oldest first). */
    gaps(sessionId) {
      const since = now() - lookbackMs;
      const entry = sessionId ? load().get(String(sessionId)) : null;
      return (entry?.gaps || []).filter((gap) => gap.at >= since).map((gap) => ({ ...gap }));
    },
    /** When the session's open gap started, or 0. */
    openAt(sessionId) {
      return (sessionId && load().get(String(sessionId))?.open) || 0;
    },
    /** The session is gone (deleted): drop everything it learned. */
    forget(sessionId) {
      if (sessionId && load().delete(String(sessionId))) scheduleFlush();
    },
    /** Write pending changes now (tests, shutdown). */
    flush,
  };
}
