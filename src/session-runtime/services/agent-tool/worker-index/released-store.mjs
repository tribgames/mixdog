// worker-index/released-store.mjs
// Which agent sessions their owner closed (the agent tool's `close`): session
// id → when. A closed session stays open and resumable, so a session scan
// (also after a daemon restart) would list it again; the marker is what keeps
// its rows `released` until a new turn starts on it. It lives in a file of its
// own beside the worker index, so a writer that rebuilds the index document
// (an older daemon) can never drop it. Entries expire after the tombstone TTL,
// judged on every read, not only when the file changes.
import { readFileSync, statSync } from 'node:fs';

import { parseJsonText } from '../../../../runtime/shared/atomic-file.mjs';
import { createIndexWriteQueue } from '../index-write-queue.mjs';
import { TAG_TOMBSTONE_TTL_MS } from '../worker-rows.mjs';

export const RELEASED_FILE = 'agent-workers-released.json';

/** id → epoch ms of every entry of a raw document (expired ones included). */
function parseReleased(doc) {
  const raw = doc?.released && typeof doc.released === 'object' ? doc.released : {};
  return new Map(
    Object.entries(raw)
      .map(([sessionId, at]) => [sessionId, Date.parse(String(at)) || 0])
      .filter(([sessionId]) => sessionId)
  );
}

/** The next document: unexpired entries plus the mutator's changes. */
function rewriteReleased(cur, mutator) {
  const cutoff = Date.now() - TAG_TOMBSTONE_TTL_MS;
  const entries = new Map();
  for (const [sessionId, at] of parseReleased(cur)) {
    if (at >= cutoff) entries.set(sessionId, new Date(at).toISOString());
  }
  mutator(entries);
  return { version: 1, released: Object.fromEntries(entries) };
}

/** `file` may be null (no data dir): reads are empty and writes are no-ops. */
export function createReleasedStore(file) {
  let cache = null; // { mtimeMs, size, doc, at }
  let dirty = true;
  // Unpersisted writes are read from the queue's projection.
  let projected = null; // { version, at }

  const queue = createIndexWriteQueue({
    file,
    rewrite: rewriteReleased,
    readDoc: () => {
      dirty = true;
      entries();
      return cache?.doc ?? null;
    },
    onPersisted: () => {
      dirty = true;
    },
  });

  /** id → epoch ms, as written (not yet filtered by expiry). */
  function entries() {
    const doc = queue.projection();
    if (doc) {
      if (!projected || projected.version !== queue.version()) {
        projected = { version: queue.version(), at: parseReleased(doc) };
      }
      return projected.at;
    }
    if (!file) return new Map();
    // Only a missing file is an empty store; any other read error propagates
    // (queue.write reports it and queues nothing; a reader sees it thrown).
    let st;
    try {
      st = statSync(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      cache = null;
      return new Map();
    }
    if (!dirty && cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.at;
    let parsed = null;
    let text = null;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (text !== null) {
      try {
        parsed = parseJsonText(text);
      } catch (error) {
        // Left on disk and reported; the next save moves it aside to
        // `<file>.corrupt-<ts>` (atomic-file's damaged-state recovery) instead
        // of overwriting it.
        process.stderr.write(`[released-store] ${file} is malformed (${error.message}); markers unreadable\n`);
      }
    }
    cache = { mtimeMs: st.mtimeMs, size: st.size, doc: parsed, at: parseReleased(parsed) };
    dirty = false;
    return cache.at;
  }

  return {
    /** Whether the owner closed this session less than the TTL ago. */
    isReleased: (sessionId) => entries().get(sessionId) >= Date.now() - TAG_TOMBSTONE_TTL_MS,
    mark(sessionIds) {
      const at = new Date().toISOString();
      queue.write((entriesById) => {
        for (const sessionId of sessionIds) entriesById.set(sessionId, at);
      });
    },
    clear(sessionId) {
      if (!entries().has(sessionId)) return;
      queue.write((entriesById) => {
        entriesById.delete(sessionId);
      });
    },
    flush: queue.flush,
    flushSync: queue.flushSync,
    hasUnpersisted: queue.hasUnpersisted,
    invalidate: () => {
      dirty = true;
    },
  };
}
