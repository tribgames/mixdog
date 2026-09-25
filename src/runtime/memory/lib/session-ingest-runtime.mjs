// Session ingest runtime: the ingest_session entrypoint.
//
// Owns only the per-session serialization chain and the order of one ingest
// call; the state each step needs lives in its own module under ./ingest/:
//   ordinal-state      — LRU per-session occurrence ordinals + durable high-water
//   ingest-occurrences — identity fields cache, which rows to store and under
//                        which occurrence ordinal
//   ingest-insert      — monotonic source_turn seed + ON CONFLICT insert loop
//   ingest-embed-flush — awaited own-rows flush + background backlog sweep
// The live DB handle, log sink, and parseTsToMs (owned by the transcript-ingest
// instance) are injected so the facade keeps ownership of `db`.
import { createIngestTurnAllocator } from './session-ingest.mjs';
import { resolveProjectScope } from './project-id-resolver.mjs';
import { createOrdinalStore } from './ingest/ordinal-state.mjs';
import { assignMessageOccurrences, createIdentityFieldsCache } from './ingest/ingest-occurrences.mjs';
import { insertPreparedRows, readMaxSourceTurn } from './ingest/ingest-insert.mjs';
import { createPostIngestFlush } from './ingest/ingest-embed-flush.mjs';

export function createSessionIngestRuntime({
  getDb,
  log,
  parseTsToMs,
  // Durable per-session untimestamped high-water store. Injected by the facade
  // (DB `meta` kv). Defaults to no-op so the runtime still works (in-memory
  // only) when a caller does not wire durability.
  loadOrdinalHighWater = async () => null,
  saveOrdinalHighWater = async () => {},
}) {
  const ordinals = createOrdinalStore({ loadOrdinalHighWater, saveOrdinalHighWater, log });
  const identityFields = createIdentityFieldsCache();
  const flushAfterIngest = createPostIngestFlush({ log });
  // Per-session ingest serialization. Concurrent ingest_session calls for the
  // SAME session raced on MAX(source_turn) → duplicate turn allocation. Chain
  // same-session ingests so the MAX read + insert loop for one session never
  // overlaps another for the same session. Different sessions stay parallel.
  const chains = new Map();

  async function ingestSessionMessages(args = {}) {
    const sessionId = String(args.sessionId || args.session_id || `session-${Date.now()}`).trim();
    const prev = chains.get(sessionId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => ingestOne(sessionId, args));
    const tail = run.catch(() => {});
    chains.set(sessionId, tail);
    try {
      return await run;
    } finally {
      // Best-effort GC: drop the map entry only if no later call chained after us.
      if (chains.get(sessionId) === tail) chains.delete(sessionId);
    }
  }

  async function ingestOne(sessionId, args) {
    const db = getDb();
    const messages = Array.isArray(args.messages) ? args.messages : [];
    // Recall fast-track hydrates the current session before compaction; allow
    // callers to ingest the full in-memory transcript instead of silently
    // clipping long sessions at 500 turns. Default remains conservative.
    const limit =
      args.fullTranscript === true ? messages.length : Math.max(1, Math.min(5000, Number(args.limit) || 200));
    const start = Math.max(0, messages.length - limit);
    const projectId = resolveProjectScope(typeof args.cwd === 'string' && args.cwd ? args.cwd : null);
    const turnAllocator = createIngestTurnAllocator(await readMaxSourceTurn(db, sessionId));
    const ordinalState = ordinals.touch(sessionId);
    await ordinals.ensureDurableLoaded(ordinalState, sessionId);
    const { prepared, considered } = assignMessageOccurrences({
      sessionId,
      messages,
      start,
      ordinalState,
      ordinals,
      identityFields,
    });
    const { inserted, insertedIds } = await insertPreparedRows({
      db,
      sessionId,
      messages,
      prepared,
      projectId,
      parseTsToMs,
      turnAllocator,
    });
    ordinals.persistDurable(ordinalState, sessionId);
    await flushAfterIngest(db, insertedIds, { embedWait: args.embedWait });
    return { text: `ingest_session: considered=${considered} inserted=${inserted} session=${sessionId}` };
  }

  return { ingestSessionMessages };
}
