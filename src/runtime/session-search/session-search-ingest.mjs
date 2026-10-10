/**
 * Keeps the PG session-search copy (session-search-db.mjs) in step with the
 * session store: per-turn ingest, a once-per-run backfill of stored sessions,
 * and deletion. Everything is best-effort and never touches the memory runtime.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAgentOnlySession } from '../agent/orchestrator/session/store-summary-visibility.mjs';
import {
  appendSessionSearchMessages,
  deleteSessionSearchMessages,
  readSessionSearchBackfillStamps,
  readSessionSearchSessionIds,
  recordSessionSearchBackfillStamp,
} from './session-search-db.mjs';

const lastIngestedLength = new Map();
const LAST_INGESTED_LIMIT = 500;

function logFailure(what, error) {
  try {
    process.stderr.write(`[session-search] ${what} failed: ${error?.message || error}\n`);
  } catch {}
}

/** Fire-and-forget: store a completed turn's transcript. Never throws. */
export function ingestSessionTurn(session) {
  try {
    const sessionId = session?.id;
    const messages = session?.messages;
    if (!sessionId || !Array.isArray(messages) || messages.length === 0) return;
    if (isAgentOnlySession(session)) return;
    // A turn always grows the transcript; an unchanged length means nothing
    // new. This is only a shortcut: the insert itself is idempotent.
    const length = messages.length;
    if (lastIngestedLength.get(sessionId) === length) return;
    appendSessionSearchMessages(sessionId, messages).then(
      () => {
        if (lastIngestedLength.size >= LAST_INGESTED_LIMIT) lastIngestedLength.clear();
        lastIngestedLength.set(sessionId, length);
      },
      (error) => logFailure(`ingest ${sessionId}`, error)
    );
  } catch (error) {
    logFailure('ingest', error);
  }
}

/** Best-effort removal of a deleted session's search rows. Never throws. */
export async function forgetSessionSearch(sessionId) {
  lastIngestedLength.delete(sessionId);
  try {
    await deleteSessionSearchMessages(sessionId);
  } catch (error) {
    logFailure(`delete ${sessionId}`, error);
  }
}

async function loadStoreDeps() {
  const [{ getStoreDir }, { _storedSessionFromFile, STORED_SESSION_UNREADABLE }] = await Promise.all([
    import('../agent/orchestrator/session/store/paths-heartbeat.mjs'),
    import('../agent/orchestrator/session/store/serialize.mjs'),
  ]);
  return {
    dir: getStoreDir(),
    readSession: (dir, file) => {
      const session = _storedSessionFromFile(dir, file, false);
      return session && session !== STORED_SESSION_UNREADABLE ? session : null;
    },
  };
}

const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 25));

/** Ingest stored ordinary sessions whose file stamp (mtime+size) changed since
 *  the last recorded backfill, then drop the rows of sessions whose file is
 *  gone (removed by any path, not only the delete command). Sequential,
 *  yields between sessions. */
export async function backfillSessionSearch({ deps } = {}) {
  const { dir, readSession } = deps || (await loadStoreDeps());
  const stamps = await readSessionSearchBackfillStamps();
  const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  let ingested = 0;
  for (const file of files) {
    const sessionId = file.slice(0, -5);
    try {
      const st = statSync(join(dir, file));
      const stamp = `${Math.floor(st.mtimeMs)}:${st.size}`;
      if (stamps.get(sessionId) === stamp) continue;
      const session = readSession(dir, file);
      if (session?.id && !isAgentOnlySession(session)) {
        await appendSessionSearchMessages(session.id, session.messages);
        await recordSessionSearchBackfillStamp(session.id, stamp);
        ingested += 1;
      }
    } catch (error) {
      logFailure(`backfill ${sessionId}`, error);
    }
    await yieldToEventLoop();
  }
  const stored = new Set(files.map((file) => file.slice(0, -5)));
  for (const sessionId of await readSessionSearchSessionIds()) {
    if (!stored.has(sessionId)) await forgetSessionSearch(sessionId);
  }
  return ingested;
}
