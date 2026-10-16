/**
 * Read-only session summary catalog for cold desktop startup.
 *
 * The summary path intentionally avoids store.mjs, config/provider loading,
 * workers, and atomic-lock writers. A transcript read stays lightweight too
 * unless a durable turn checkpoint exists; only then does it lazily enter the
 * reconnect recovery boundary so restored panes never paint a stale prompt.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// Leaf helpers only (no store.mjs, no workers, no config): the three-way
// present/absent/unreadable classification and the strict record parser the
// authoritative store uses, so the cold catalog cannot disagree with it.
import { probePath, readTextFile, PROBE_PRESENT, PROBE_ABSENT } from './store/fs-probe.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from './lifecycle-scan.mjs';
import { sessionVisibility } from './store-summary-visibility.mjs';
import {
  STAMP_ABSENT_CODES,
  catalogSessionOwnershipLinks,
  createOrdinaryCatalog,
  indexListing,
  observeStamp,
  scanSessionFiles,
  stampedDerivation,
} from './store-summary-catalog.mjs';
import { createStoredTranscriptCache, nextProjectionStamp } from './store-transcript-cache.mjs';
import {
  OFFLOAD_MIN_CHARS,
  projectStoredTranscriptOffThread,
  storedTranscriptWorkerRunning,
} from './store-transcript-worker.mjs';
import { projectStoredTranscript } from './store-transcript-projection.mjs';
import { dataDir, sessionHeartbeatMtimes } from './store-summary-locations.mjs';
import { isStoredSessionId, workspaceSummary } from './store-summary-fields.mjs';
import { readArchivedAgentResult } from './store-summary-archived-agent.mjs';
import { compactionArchivePath, readCompactionArchivePage } from './compaction-archive.mjs';
import { currentSessionCatalogDb, onSessionCatalogDbChange, sessionCatalogDb } from './catalog-db/index.mjs';
import { decodeCatalogCursor, encodeCatalogCursor, isAfterCursor } from './catalog-db/schema.mjs';
import {
  readCanonicalSessionRecord as readCanonicalLifecycle,
  offerStrictSessionRecord,
  statSessionStamp,
  sameSessionStamp,
  isSettledSessionStamp,
} from './store/canonical-reader.mjs';
// Worker-pool row projection (child + Lead indexes, heartbeat lease, cancel
// ranking) lives in store-agent-worker-rows.mjs; re-exported so prior
// importers of this module stay unchanged.
export { listStoredAgentWorkerLinks, listStoredAgentWorkers } from './store-agent-worker-rows.mjs';
export { storedAgentWorkerIndexPath } from './store-summary-locations.mjs';

// One cache per process: the daemon serves every cold pane read from it, and
// the desktop service worker keeps its own for the deep-history prefetch.
const storedTranscriptCache = createStoredTranscriptCache();

/** Test seam: forget every cached projection. */
export function clearStoredTranscriptCache() {
  storedTranscriptCache.clear();
}

/** Drop one session's cold projections: it went live, or its last view left. */
export function forgetStoredSessionTranscript(sessionId) {
  storedTranscriptCache.forget(`${String(sessionId || '').trim()}|`);
}

/** Its last view left: keep the cold projections for a revisit, within the
 *  cache's idle budget. */
export function releaseStoredSessionTranscript(sessionId) {
  storedTranscriptCache.release(`${String(sessionId || '').trim()}|`);
}

/** Test/diagnostic seam: size of the retained cold projections. */
export function storedTranscriptCacheStats() {
  return storedTranscriptCache.stats();
}

// ── Ordinary catalog ────────────────────────────────────────────────────────
// The JSON path is the catalog engine of store-summary-catalog.mjs on this
// thread: every process but the daemon, and the daemon whenever its session
// catalog DB cannot answer (gate, off-switch, backfill, rebuild, any error).
// In the daemon, the catalog DB worker runs the same engine off this thread
// and an ordinary listing is one request to it (catalog-db/index.mjs).
const ordinaryCatalog = createOrdinaryCatalog();
const catalogListeners = new Set();

function notifyCatalogListeners() {
  for (const listener of catalogListeners) {
    try {
      listener();
    } catch {
      /* a listener's failure is its own */
    }
  }
}

ordinaryCatalog.subscribe(notifyCatalogListeners);
onSessionCatalogDbChange(notifyCatalogListeners);

/** `listener()` runs when a background pass finds a session file that changed
 *  without a directory or index change, i.e. when an ordinary listing would
 *  now differ from the last one. Returns the unsubscribe function. */
export function subscribeStoredSessionCatalogChanges(listener) {
  catalogListeners.add(listener);
  return () => catalogListeners.delete(listener);
}

/** Run a background verification of the ordinary catalog now (or join the
 *  running one) — here and in the catalog DB worker; resolves when done. */
export async function verifyStoredSessionCatalog() {
  await Promise.all([ordinaryCatalog.verify(), currentSessionCatalogDb(dataDir())?.verifyFiles()]);
}

/** Test seam: forget the ordinary catalog and the parsed summary index. */
export function clearStoredSessionCatalog() {
  ordinaryCatalog.clear();
}

export function listStoredSessionSummaries(options = {}) {
  // The index is consulted on EVERY path: its rows are the authority that
  // must be retained whenever storage cannot be enumerated or an individual
  // session file cannot be read.
  const index = ordinaryCatalog.loadIndex();
  // An index that EXISTS but is unreadable (EACCES/EIO) is neither missing
  // nor empty: the scan still runs, and when IT cannot enumerate either, the
  // catalog reports nothing rather than inventing an empty truth.
  if (options.refreshFromStorage === true) {
    const heartbeatMtimes = sessionHeartbeatMtimes();
    return scanSessionFiles(heartbeatMtimes, index.rowsById, true) ?? indexListing(index, heartbeatMtimes) ?? [];
  }
  if (options.rebuildIfMissing === false) return indexListing(index, sessionHeartbeatMtimes()) ?? [];
  // A missing/malformed index leaves every file to be parsed (once per
  // stamp); a present one lets unchanged files reuse their durable summary.
  return ordinaryCatalog.refresh(index).rows ?? indexListing(index, sessionHeartbeatMtimes()) ?? [];
}

/** The catalog DB's answer to an ordinary listing (`{ rows, more }`), or
 *  null when this process has none or it cannot answer. No filesystem work
 *  on this thread: the worker checks storage, applies changes, answers. */
async function catalogDbListing(page) {
  const db = sessionCatalogDb(dataDir());
  if (!db) return null;
  const answer = await db.list(page);
  // While the DB answers, the JSON path's reconcile state is dead weight.
  if (answer) ordinaryCatalog.clear();
  return answer;
}

/**
 * listStoredSessionSummaries for async callers (the daemon's session views).
 * In the daemon the ordinary listing comes from the session catalog DB
 * worker; anywhere else, and whenever the DB cannot answer, it is the JSON
 * path. `refreshFromStorage` and `rebuildIfMissing: false` always take the
 * JSON/file path.
 */
export async function listStoredSessionSummariesAsync(options = {}) {
  if (options.refreshFromStorage === true || options.rebuildIfMissing === false) {
    return listStoredSessionSummaries(options);
  }
  const answer = await catalogDbListing(null);
  return answer ? answer.rows : listStoredSessionSummaries();
}

/** All persisted ownership links, including hidden and closed agents.
 * Unlike the ordinary listing, null means ownership could not be read
 * completely; accounting must not treat that as zero agents. */
export async function listStoredSessionOwnershipLinksAsync() {
  const db = sessionCatalogDb(dataDir());
  const answer = db ? await db.list(null, { ownershipLinks: true }) : null;
  if (answer) {
    ordinaryCatalog.clear();
    return answer.rows;
  }
  return catalogSessionOwnershipLinks(ordinaryCatalog.refresh(ordinaryCatalog.loadIndex(), { assemble: false }));
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 1000;

/**
 * One page of the ordinary listing: `{ sessions, nextCursor }` in catalog
 * order (newest activity first, ties by id), `limit` rows (default 50, at
 * most 1000) after the keyset `cursor` (an earlier page's `nextCursor`;
 * absent = first page). Answered like listStoredSessionSummariesAsync; from
 * the DB only the requested rows are transferred.
 */
export async function listStoredSessionSummaryPage(options = {}) {
  const requested = Math.floor(Number(options.limit));
  const limit = requested > 0 ? Math.min(requested, MAX_PAGE_LIMIT) : DEFAULT_PAGE_LIMIT;
  const after = decodeCatalogCursor(options.cursor);
  const answer = await catalogDbListing({ limit, after });
  if (answer) {
    return {
      sessions: answer.rows,
      nextCursor: answer.more && answer.rows.length ? encodeCatalogCursor(answer.rows.at(-1)) : null,
    };
  }
  // The JSON listing is already in catalog order.
  const ordered = listStoredSessionSummaries().filter((row) => isAfterCursor(row, after));
  const sessions = ordered.slice(0, limit);
  return {
    sessions,
    nextCursor: ordered.length > limit ? encodeCatalogCursor(sessions.at(-1)) : null,
  };
}

/** Exact, fail-closed existence check for a durable session address.
 * Summary indexes and desktop metadata are presentation caches; neither may
 * make a missing sessions/<id>.json record addressable again. */
export function storedSessionExists(id) {
  const sessionId = String(id || '').trim();
  if (!isStoredSessionId(sessionId)) return false;
  // The store's strict lifecycle authority: a stat when the file is this
  // process's own commit or an unchanged settled stamp, a strict read
  // otherwise. Absent, unreadable, ambiguous or foreign → false.
  // The session service asks this right before loading the session, so a
  // strict read here hands its parse over to that load (handOff).
  const lifecycle = readCanonicalLifecycle(join(dataDir(), 'sessions', `${sessionId}.json`), true, { handOff: true });
  return Boolean(lifecycle && typeof lifecycle === 'object' && lifecycle.id === sessionId);
}

/** Metadata of the strictly parsed record at `recordPath`, or null when it is
 *  absent, unreadable, ambiguous or foreign to `sessionId`. */
function readStoredSessionMetadata(recordPath, sessionId) {
  const { value } = stampedDerivation('metadata', recordPath, (text) => {
    const record = readTopLevelLifecycleRecord(text);
    if (isLifecycleUnreadable(record) || record.id !== sessionId) return null;
    return storedSessionMetadata(sessionId, record.doc);
  });
  // Callers own what they get back; the cached value stays pristine.
  return value ? structuredClone(value) : null;
}

function storedSessionMetadata(sessionId, session) {
  return {
    id: sessionId,
    sessionId,
    owner: session.owner || null,
    agent: session.agent || null,
    parentSessionId: session.parentSessionId || null,
    ownerSessionId: session.ownerSessionId || session.parentSessionId || null,
    visibility: sessionVisibility(session),
    agentTag: session.agentTag || null,
    cwd: session.cwd || '',
    ...(workspaceSummary(session.workspace) ? { workspace: workspaceSummary(session.workspace) } : {}),
    provider: session.provider || null,
    model: session.model || null,
    presetName: session.presetName || session.profileId || null,
    effort: session.effort || null,
    fast: session.fast === true,
    ...(session.autoEffort === false ? { autoEffort: false } : {}),
    modelParameters: session.modelParameters || null,
    taskType: session.taskType || null,
    permission: session.permission || null,
    permissionMode: session.permissionMode || null,
    toolPermission: session.toolPermission || null,
    schemaAllowedTools: Array.isArray(session.schemaAllowedTools) ? session.schemaAllowedTools : null,
    sourceType: session.sourceType || null,
    sourceName: session.sourceName || null,
    clientHostPid: session.clientHostPid || null,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || session.lastUsedAt || null,
    status: session.status || (session.closed === true ? 'closed' : 'idle'),
    closed: session.closed === true,
  };
}

/** A record that is gone may be a reaped agent child: its parent is resolved
 *  from metadata only (worker link, summary-index row), never by a scan. */
function readVanishedSessionTranscript(sessionId) {
  return readArchivedAgentResult(sessionId, {
    catalogRow: (id) => ordinaryCatalog.loadIndex().rowsById.get(id) || null,
  });
}

/** The two files a stored transcript projection is built from. */
function storedTranscriptInputPaths(sessionId) {
  return {
    recordPath: join(dataDir(), 'sessions', `${sessionId}.json`),
    checkpointPath: join(dataDir(), 'turn-checkpoints', `${sessionId}.json`),
    // Written after the compaction commit that names it, so its identity
    // joins the projection's.
    archivePath: compactionArchivePath(join(dataDir(), 'sessions'), sessionId),
  };
}

/** Settled identity of the files readStoredSessionTranscript projects from:
 *  the canonical record and its turn-checkpoint sidecar. Null while either is
 *  too fresh to vouch for by stat alone (isSettledSessionStamp), unreadable,
 *  or the record is absent — the caller then reads normally. */
export function storedSessionTranscriptStamp(id) {
  const sessionId = String(id || '').trim();
  if (!isStoredSessionId(sessionId)) return null;
  const { recordPath, checkpointPath, archivePath } = storedTranscriptInputPaths(sessionId);
  const settled = (path, absent) => {
    let stamp;
    try {
      stamp = statSessionStamp(path);
    } catch (error) {
      return STAMP_ABSENT_CODES.has(error?.code) ? absent : null;
    }
    if (!isSettledSessionStamp(stamp)) return null;
    return `${stamp.dev}:${stamp.ino}:${stamp.size}:${stamp.mtimeNs}:${stamp.ctimeNs}`;
  };
  const record = settled(recordPath, null);
  const checkpoint = record && settled(checkpointPath, 'absent');
  const archive = checkpoint && settled(archivePath, 'absent');
  return archive ? `${record}|${checkpoint}|${archive}` : null;
}

/** Projects the strictly parsed record `text` (read at full stamp `stamp`, or
 *  null when not provably stable) into the cached transcript value. */
async function produceStoredTranscript(text, stamp, context) {
  const { sessionId, recordPath, itemLimit, includeMessages, mode, offloadable, checkpointAbsent, timing } = context;
  // A large record with no checkpoint sidecar parses and projects on a
  // worker thread: the same pipeline, off the daemon event loop. It hands
  // no parse to the load cache (a later resume reads the file itself).
  if (offloadable && text.length >= OFFLOAD_MIN_CHARS) {
    try {
      timing.worker = storedTranscriptWorkerRunning() ? 'warm' : 'cold';
      const workerStartedAt = performance.now();
      const answer = await projectStoredTranscriptOffThread({ sessionId, text, itemLimit });
      timing.workerMs = performance.now() - workerStartedAt;
      Object.assign(timing, answer.timing);
      if (answer.unreadable) return null;
      if (stamp) readCanonicalLifecycle.rememberStrictVerdict(recordPath, stamp, answer.lifecycle);
      // Stamps are process-unique per module realm; re-issue in this one.
      answer.value.projectionStamp = nextProjectionStamp();
      return answer.value;
    } catch {
      // Worker unavailable: fall through to the in-process pipeline.
    }
  }
  const parseStartedAt = performance.now();
  const record = readTopLevelLifecycleRecord(text);
  timing.parseMs = performance.now() - parseStartedAt;
  if (isLifecycleUnreadable(record) || record.id !== sessionId) return null;
  // The same strict verdict the lifecycle authority would reach for these
  // bytes (storedSessionExists runs next when the pane's runtime loads).
  if (stamp) readCanonicalLifecycle.rememberStrictVerdict(recordPath, stamp, record);
  // Hand the parse to the session load cache BEFORE projecting: a resume
  // that runs while this projection is still being built (the daemon
  // resumes the panes it restores) claims it instead of reading the file
  // again. The projection path loads the store anyway, so loading its
  // cache first costs nothing and gives the hand-off somewhere to go on
  // the process's first read.
  let handedOver = false;
  if (stamp) {
    await import('./store/load-cache.mjs');
    handedOver = offerStrictSessionRecord(recordPath, stamp, record, text.length);
  }
  // Once handed over, the record is a runtime's mutable session. The
  // projection is then built from a private parse of the same bytes, so
  // nothing it retains aliases that session and it needs no copying. With
  // a turn checkpoint the projection recovers through loadSession, the very
  // load the hand-off serves, and projects the load cache's session
  // exactly as before; only that projection is detached.
  const projectStartedAt = performance.now();
  const value = await projectStoredTranscript(
    sessionId,
    handedOver && checkpointAbsent ? JSON.parse(text) : record.doc,
    {
      itemLimit,
      includeMessages,
      checkpointAbsent,
    }
  );
  timing.projectMs = performance.now() - projectStartedAt;
  if (!handedOver || checkpointAbsent || !value || mode !== 'items') return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** Read exactly one persisted session for a visible desktop pane. This never
 * enumerates siblings. Normal reads stay independent of runtime ownership;
 * interrupted turns conditionally use the same durable reconnect recovery as
 * resumeSession before projecting the transcript. */
export async function readStoredSessionTranscript(id, options = {}) {
  const sessionId = String(id || '').trim();
  if (!isStoredSessionId(sessionId)) return null;
  // Same strict authority as the store, and the same fail-closed rule: an
  // absent, unreadable, ambiguous or foreign record yields no transcript.
  const { recordPath, checkpointPath, archivePath } = storedTranscriptInputPaths(sessionId);
  if (options.metadataOnly === true) return readStoredSessionMetadata(recordPath, sessionId);
  // One page of the display-only compaction archive (the live head loader
  // pages it once a runtime's in-memory rows are exhausted).
  if (options.compactionArchive && typeof options.compactionArchive === 'object') {
    return readCompactionArchivePage(join(dataDir(), 'sessions'), sessionId, options.compactionArchive);
  }
  // The checkpoint sidecar shapes the projection as much as the record does,
  // so its identity joins the cache fingerprint. Only a PROVABLY absent
  // checkpoint skips recovery: an unreadable probe must not silently
  // downgrade an interrupted turn to a plain cold read.
  const startedAt = performance.now();
  // Phase durations of the parse this call ran (absent on a cache hit).
  const timing = {};
  const recordStat = probePath(recordPath);
  if (recordStat.state === PROBE_ABSENT) return readVanishedSessionTranscript(sessionId);
  if (recordStat.state !== PROBE_PRESENT) return null;
  const checkpoint = probePath(checkpointPath);
  const archive = probePath(archivePath);
  const requestedLimit = Number(options.transcriptItemLimit);
  const itemLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : Number.POSITIVE_INFINITY;
  let readState = PROBE_PRESENT;
  // Full stamp the loaded text provably came from (unchanged around the
  // read), or null. Only such a parse may serve other readers.
  let readStamp = null;
  // The strict record parse (full JSON + duplicate-key scan) is itself a
  // large share of a cold read, so it only runs when the content is new.
  const includeMessages = options.includeMessages === true;
  const mode = includeMessages ? 'messages' : 'items';
  const checkpointAbsent = checkpoint.state === PROBE_ABSENT;
  // Large, checkpoint-free item projections run off the daemon event loop.
  const offloadable = !includeMessages && checkpointAbsent && recordStat.size >= OFFLOAD_MIN_CHARS;
  const produceContext = {
    sessionId,
    recordPath,
    itemLimit,
    includeMessages,
    mode,
    offloadable,
    checkpointAbsent,
    timing,
  };
  const { value, hit, read } = await storedTranscriptCache.read({
    key: `${sessionId}|${itemLimit}|${mode}`,
    // Growing history windows of one session replace each other.
    group: `${sessionId}|${mode}`,
    fingerprint: [
      checkpoint.state,
      checkpoint.mtimeMs,
      checkpoint.ctimeMs,
      checkpoint.size,
      checkpoint.ino,
      checkpoint.dev,
      archive.state,
      archive.mtimeMs,
      archive.size,
    ].join(':'),
    fileStat: recordStat,
    loadText: async () => {
      const readStartedAt = performance.now();
      const before = observeStamp(recordPath);
      let body = null;
      if (offloadable) {
        // Reading a large record asynchronously keeps its multi-megabyte
        // UTF-8 decode-and-copy off the loop; failures are classified below.
        try {
          body = { state: PROBE_PRESENT, text: (await readFile(recordPath)).toString('utf8') };
        } catch {
          body = null;
        }
      }
      body ||= readTextFile(recordPath);
      timing.readMs = performance.now() - readStartedAt;
      readState = body.state;
      if (body.state !== PROBE_PRESENT) return null;
      readStamp = before && sameSessionStamp(before, observeStamp(recordPath)) ? before : null;
      return body.text;
    },
    produce: (text) => produceStoredTranscript(text, readStamp, produceContext),
  });
  // The record vanished between stat and read: same answer as an absent probe.
  if (readState === PROBE_ABSENT) return readVanishedSessionTranscript(sessionId);
  if (typeof options.trace === 'function') {
    options.trace({
      sessionId,
      hit,
      read,
      ms: performance.now() - startedAt,
      chars: recordStat.size,
      items: Array.isArray(value?.items) ? value.items.length : 0,
      timing,
    });
  }
  return value;
}
