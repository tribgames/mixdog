// Recall / search / dump / stats query handlers.
//
// The read-side query cluster shares the live DB handle plus a little
// facade-local state (the cold-recall log throttle and the optional trace DB
// used for recall telemetry). All of it is injected through
// createQueryHandlers({...}) so the module holds no state of its own and the
// facade keeps ownership of `db`, `_traceDb`, etc.
//
// handleSearch dispatches to one leg per request shape:
//   query-session-recall.mjs current-session browse / compaction digest
//   query-id-lookup.mjs      `#N` follow-up lookups
//   query-fan-out.mjs        array queries (parallel sub-searches)
//   query-hybrid-search.mjs  text queries (lexical + dense retrieval)
//   query-last-browse.mjs    period='last' session-grouped browse
//   query-window-browse.mjs  query-less browse inside a time window
// with query-search-plan.mjs deriving the shared flags and bounds, and
// query-raw-window.mjs / query-core-recall.mjs serving the raw and core legs
// the text/browse paths merge in.
import { createQueryMaintenanceHandlers } from './query-maintenance-handlers.mjs';
import { resolveSearchPlan } from './query-search-plan.mjs';
import { searchByIds } from './query-id-lookup.mjs';
import { fanOutSearchQueries } from './query-fan-out.mjs';
import { searchByQuery } from './query-hybrid-search.mjs';
import { browseLastSessions } from './query-last-browse.mjs';
import { readRawRowsInWindow } from './query-raw-window.mjs';
import { recallSessionRows } from './query-session-recall.mjs';
import { recallCoreRows } from './query-core-recall.mjs';
import { browseEntries } from './query-window-browse.mjs';

/** Cold-recall log throttle: one line per 10s window per memory runtime. */
function createColdRecallNote(log) {
  let lastLogAt = 0;
  return (embedding) => {
    const now = Date.now();
    if (now - lastLogAt <= 10_000) return;
    lastLogAt = now;
    const reason = embedding.state === 'timeout' ? 'bounded cold-start wait elapsed' : `embedding ${embedding.state}`;
    log(`[recall] ${reason}; returning lexical results while background warmup continues\n`);
  };
}

export function createQueryHandlers({ getDb, log, resolveProjectScope, embeddingOnDemandCanStart, getTraceDb }) {
  const noteColdRecall = createColdRecallNote(log);
  const { dumpSessionRootChunks, entryStats } = createQueryMaintenanceHandlers({ getDb });
  const recallSession = (args = {}) => recallSessionRows(getDb(), args);
  const recallCore = (query, options) => recallCoreRows(getDb(), query, options);

  async function handleSearch(args, signal) {
    const db = getDb();
    // Cooperative abort check: throw early if the caller already aborted
    // (IPC cancel handler signals the AbortController before re-entry).
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    // No pre-search drain: recall NEVER runs LLM chunking inline. Unchunked
    // rows are served directly by the raw leg (readRawRowsInWindow on the
    // query path, the chunk_root IS NULL selection in recallSessionRows) and
    // are dense-searchable via the always-on raw-embedding flush (post-ingest
    // + checkCycles tick). Chunked/scored upgrades arrive from the background
    // cycle1 sweep on its own schedule.
    // #id lookup normalization: search_memories and memory action:'search'
    // callers pass a single `id` (or an id array under that same key), not
    // the `ids` array below. Normalize once here so every dispatch path gets
    // exact-id lookup, not just callers who already knew to use `ids`.
    if (!Array.isArray(args.ids) && args.id != null) {
      args = { ...args, ids: Array.isArray(args.id) ? args.id : [args.id] };
    }
    if (args?.currentSession === true || args?.sessionId || args?.session_id) {
      return await recallSession(args);
    }
    if (Array.isArray(args.ids) && args.ids.length > 0) {
      return await searchByIds(db, args, resolveProjectScope);
    }
    if (Array.isArray(args.query)) {
      return await fanOutSearchQueries(args, signal, { search: handleSearch, log, embeddingOnDemandCanStart });
    }
    const plan = resolveSearchPlan(args, resolveProjectScope);
    // period='last': no time window and no session exclusion — 'last' is a
    // recent-session browse; with a query, filter those recent sessions by
    // topic instead of falling through to the unbounded semantic search path.
    // No boot-timestamp cap (the old cap hid every session that ran while a
    // long-lived daemon stayed up), no gap-bounded burst, no current-session
    // filter: limit/offset page through history and the grouped renderer
    // separates sessions. temporal stays unbounded (mode marker only).
    if (plan.query && plan.temporal?.mode !== 'last') {
      return await searchByQuery({
        db,
        args,
        plan,
        signal,
        log,
        embeddingOnDemandCanStart,
        noteColdRecall,
        readRawRowsInWindow,
        recallCoreRows: recallCore,
        traceDb: getTraceDb(),
      });
    }
    if (plan.temporal?.mode === 'last') {
      return await browseLastSessions({ db, args, plan, readRawRowsInWindow });
    }
    return await browseEntries(db, args, plan);
  }

  return {
    readRawRowsInWindow,
    recallSessionRows: recallSession,
    recallCoreRows: recallCore,
    handleSearch,
    dumpSessionRootChunks,
    entryStats,
  };
}
