/**
 * Keeps the PG session-search copy (session-search-db.mjs) in step with the
 * session store: per-turn ingest, a once-per-run backfill of stored sessions,
 * and deletion. Everything is best-effort and never touches the memory runtime.
 *
 * A session's writes run one at a time, in the order they were issued
 * (serialized). That order is what keeps a value marked sensitive out of the
 * index: the replacement that redacts the stored rows
 * (replaceSessionSearchMessages) locks only rows that already exist, so an
 * earlier plaintext append still in flight would otherwise land after it and
 * bring the value back. A write also redacts with the values known when it
 * runs, not when it was issued.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAgentOnlySession } from '../agent/orchestrator/session/store-summary-visibility.mjs';
import { redactSensitiveText, sensitiveValuesVersion } from '../agent/orchestrator/session/sensitive-values.mjs';
import { redactSensitiveMessages } from '../agent/orchestrator/session/sensitive-projection.mjs';
import {
  appendSessionSearchMessages,
  deleteSessionSearchMessages,
  readSessionSearchBackfillStamps,
  readSessionSearchSessionIds,
  recordSessionSearchBackfillStamp,
  replaceSessionSearchMessages,
} from './session-search-db.mjs';

/** sessionId → { length, version }: the transcript length and the
 *  sensitive-values version (sensitive-values.mjs) of the last stored ingest. */
const lastIngested = new Map();
const LAST_INGESTED_LIMIT = 500;

function logFailure(what, error) {
  try {
    process.stderr.write(`[session-search] ${what} failed: ${error?.message || error}\n`);
  } catch {}
}

/** sessionId → { tail, controller }: the tail of the session's write queue
 *  (see serialized) and the lifetime its writes run under (closeSessionSearch
 *  aborts it). Present only while a write of the session is queued or running. */
const writeQueues = new Map();

/** The reason a closed session's writes stop with; never reported as a failure. */
class SessionSearchClosedError extends Error {
  constructor(sessionId) {
    super(`session search writes of ${sessionId} closed`);
    this.name = 'AbortError';
  }
}

const reportUnlessClosed = (what) => (error) => {
  if (!(error instanceof SessionSearchClosedError)) logFailure(what, error);
};

/** Runs `task(signal)` once every earlier task of `sessionId` has settled; the
 *  task's own promise is returned, so its failure reaches the caller to report.
 *  The queue moves on past a failed task: that failure is the caller's, not the
 *  next write's. `signal` is the session's write lifetime. */
function serialized(sessionId, task) {
  const queue = writeQueues.get(sessionId);
  const controller = queue && !queue.controller.signal.aborted ? queue.controller : new AbortController();
  // A write cancelled while queued never starts (rejects with the close reason).
  const run = (queue?.tail ?? Promise.resolve()).then(() => {
    controller.signal.throwIfAborted();
    return task(controller.signal);
  });
  const tail = run.then(
    () => {},
    () => {}
  );
  const entry = { tail, controller };
  writeQueues.set(sessionId, entry);
  tail.then(() => {
    if (writeQueues.get(sessionId) === entry) writeQueues.delete(sessionId);
  });
  return run;
}

/**
 * Stops the session's search writes for a runtime close: the queued ones never
 * start and the running one is cancelled — a PostgreSQL runtime install or
 * start it is waiting on included, once no other writer still waits on it
 * (createSharedAbortable). Resolves when the queue has settled, so nothing this
 * session issued writes into the data dir afterwards. The rows are derived:
 * the stored-session backfill restores what a cancelled write left out.
 */
export async function closeSessionSearch(sessionId) {
  const queue = writeQueues.get(sessionId);
  if (!queue) return;
  queue.controller.abort(new SessionSearchClosedError(sessionId));
  await queue.tail;
}

/** Stores `messages`, the transcript as it was when the turn was ingested, as
 *  the session's search rows; runs in the session's write queue. */
async function storeTranscript(sessionId, messages, signal) {
  // A turn always grows the transcript; an unchanged length means nothing
  // new. This is only a shortcut: the insert itself is idempotent.
  const length = messages.length;
  const version = sensitiveValuesVersion(sessionId);
  const last = lastIngested.get(sessionId);
  if (last?.length === length && last.version === version) return;
  // A value a sensitive fill marked is stored as a marker here too. While
  // the session has values not yet applied to its stored rows (rows made
  // before the mark, compacted ones included), the rows that hold one are
  // replaced in one transaction instead of only appending.
  const redacted = redactSensitiveMessages(sessionId, messages);
  if (version && last?.version !== version) {
    await replaceSessionSearchMessages(sessionId, messages, redacted, (text) => redactSensitiveText(sessionId, text), {
      signal,
    });
  } else {
    await appendSessionSearchMessages(sessionId, redacted, { signal });
  }
  if (lastIngested.size >= LAST_INGESTED_LIMIT) lastIngested.clear();
  lastIngested.set(sessionId, { length, version });
}

/** Fire-and-forget: store a completed turn's transcript. Never throws. */
export function ingestSessionTurn(session) {
  try {
    const sessionId = session?.id;
    const messages = session?.messages;
    if (!sessionId || !Array.isArray(messages) || messages.length === 0) return;
    if (isAgentOnlySession(session)) return;
    // The write runs after the session's earlier ones, so it keeps the
    // transcript of this call: compaction may rewrite the live array before then.
    const transcript = messages.slice();
    serialized(sessionId, (signal) => storeTranscript(sessionId, transcript, signal)).catch(
      reportUnlessClosed(`ingest ${sessionId}`)
    );
  } catch (error) {
    logFailure('ingest', error);
  }
}

/** Best-effort removal of a deleted session's search rows, after the
 *  session's pending writes. Never throws. */
export async function forgetSessionSearch(sessionId) {
  await serialized(sessionId, async (signal) => {
    lastIngested.delete(sessionId);
    await deleteSessionSearchMessages(sessionId, { signal });
  }).catch(reportUnlessClosed(`delete ${sessionId}`));
}

async function loadStoreDeps() {
  const [{ getStoreDir }, { _storedSessionFromFile, STORED_SESSION_UNREADABLE }] = await Promise.all([
    import('../agent/orchestrator/session/store/session-paths.mjs'),
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
        await serialized(session.id, async () => {
          await appendSessionSearchMessages(session.id, redactSensitiveMessages(session.id, session.messages));
          await recordSessionSearchBackfillStamp(session.id, stamp);
        });
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
