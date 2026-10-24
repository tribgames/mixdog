/**
 * Projection of the durable worker indexes (agent-workers.json,
 * lead-workers.json) into the process-global active pool: the status
 * vocabulary, the live-work evidence a working row needs, frozen idle stamps,
 * the per-file session header cache and the orphan-child prune.
 *
 * Whether a session is working is the daemon's in-memory turn activity (every
 * session runs inline there), handed in as `runningSessionIds`: a running
 * session is working whatever its durable row declares, except that an
 * explicit cancel outranks it. A declared-working row the daemon does not
 * report as in flight reads `unknown` — without the daemon's answer nothing
 * is guessed.
 *
 * Assembly order lives in store-agent-worker-pool.mjs; this module owns the
 * row-level truth each projected row carries. Every status string, index
 * field name and row key is a consumed contract and is used verbatim.
 */
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  isSettledSessionStamp,
  sameSessionStamp,
  sessionStampOf,
  statSessionStamp,
} from './store/canonical-reader.mjs';
import { readJsonProjection } from '../../../shared/pending-json-projection.mjs';
import { listStoredAgentWorkers as assembleStoredAgentWorkers } from './store-agent-worker-pool.mjs';
import { readTopLevelFields } from './store-agent-worker-header.mjs';
import {
  readPersistedWorkerHeaders,
  storedAgentWorkerHeaderCachePath,
  writePersistedWorkerHeaders,
} from './store-agent-worker-header-cache.mjs';
import {
  TAG_TOMBSTONE_TTL_MS,
  agentPaneVisible,
  findTagTombstone,
  tagTombstoneKey,
  tombstoneBlocksWork,
} from '../../../shared/agent-reap-state.mjs';
import { dataDir, storedAgentWorkerIndexPath, storedLeadWorkerIndexPath } from './store-summary-locations.mjs';
import { cleanValue, isStoredSessionId, positiveNumber } from './store-summary-fields.mjs';
import { sessionUsageTotals } from '../../../shared/session-usage-totals.mjs';

const WORKING_AGENT_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$/i;
// Confirmed cancel vs a cancel whose stop is not proven. Neither is ever
// shown as `running`, and the two must stay distinct: `cancel-unconfirmed` is
// the honest Windows git-bash-survivor answer, not a successful cancel.
const CANCELLED_AGENT_STATUS = /^(?:cancelled|canceled|killed)$/i;
// Bare `cancelling` is still working (ACTIVE_STAGES). Only an explicit
// unconfirmed/pending cancel is a distinct terminal-unconfirmed outcome.
const CANCEL_UNCONFIRMED_AGENT_STATUS = /^(?:cancel[-_\s]?(?:unconfirmed|pending))$/i;
// A turn that did not finish (error, timeout, watchdog stop, dead runtime):
// dead like a completion, but it stays visible as the failure it is.
const FAILED_AGENT_STATUS = /^(?:error|fail|failed|timeout)$/i;
// A turn that finished normally. The row rests as `idle` (or an equivalent
// done status) and is listed as `completed` for the pane window.
const COMPLETED_AGENT_STATUS = /^(?:idle|done|complete|completed|success)$/i;
const SESSION_CANCEL_FIELDS = [
  'cancelStatus',
  'status',
  'state',
  'lastStatus',
  'stage',
  'outcome',
  'terminationReason',
];
function workerOwnerSessionId(row, session) {
  return (
    cleanValue(row?.ownerSessionId || session?.ownerSessionId || row?.parentSessionId || session?.parentSessionId) ||
    null
  );
}

function workerParentSessionId(row, session) {
  return (
    cleanValue(row?.parentSessionId || session?.parentSessionId || row?.ownerSessionId || session?.ownerSessionId) ||
    null
  );
}

// Frozen idle stamps: without finishedAt the idle moment fell back to the
// MUTABLE updatedAt, so every background save advanced the dock's ordering
// stamp and idle groups kept reshuffling (user: 유휴인데 목록이 깜빡인다).
// The first observation freezes the fallback; a row seen working clears it so
// the NEXT idle moment is stamped fresh.
const stickyIdleSince = new Map(); // sessionId -> stamp
const STICKY_IDLE_CAP = 512;
function frozenIdleSince(sessionId, working, fallback) {
  if (working) {
    stickyIdleSince.delete(sessionId);
    return null;
  }
  if (stickyIdleSince.has(sessionId)) return stickyIdleSince.get(sessionId);
  const value = fallback || null;
  stickyIdleSince.set(sessionId, value);
  if (stickyIdleSince.size > STICKY_IDLE_CAP) {
    stickyIdleSince.delete(stickyIdleSince.keys().next().value);
  }
  return value;
}

/** The worker's lifecycle. `status` decides; `stage` is only the runtime phase
 *  copied in by the progress sweep, so mid-work it may read idle/done/error
 *  beside a worker that is still running. Only a row with no status falls
 *  back to its stage. */
function workerLifecycle(row) {
  return cleanValue(row?.status) || cleanValue(row?.stage);
}

function failedAgentWorker(row) {
  return FAILED_AGENT_STATUS.test(workerLifecycle(row));
}

function stampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const text = cleanValue(value);
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0 && !/^\d{4}-/.test(text)) return numeric;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function workStampMs(source) {
  if (!source || typeof source !== 'object') return 0;
  return Math.max(stampMs(source.turnStartedAt), stampMs(source.startedAt));
}

function cancelStampMs(source) {
  if (!source || typeof source !== 'object') return 0;
  return Math.max(stampMs(source.cancelledAt), stampMs(source.finishedAt));
}

/** When a settled agent finished: its finish/cancel/failure stamp, else its
 *  last update. The index row decides; the session header only fills a gap. */
function finishedAtMs(row, session = null) {
  return cancelStampMs(row) || stampMs(row?.updatedAt) || cancelStampMs(session) || stampMs(session?.updatedAt);
}

/** The cancel one source (index row or session header) records, or null.
 *  An unconfirmed stop outranks a confirmed one so a stop that was never
 *  proven is not reported as success. `cancelling` alone is working and is
 *  not a cancel. */
function cancelState(source) {
  if (!source || typeof source !== 'object') return null;
  const statuses = SESSION_CANCEL_FIELDS.map((key) => cleanValue(source[key])).filter(Boolean);
  const status =
    statuses.find((value) => CANCEL_UNCONFIRMED_AGENT_STATUS.test(value)) ||
    statuses.find((value) => CANCELLED_AGENT_STATUS.test(value)) ||
    '';
  return status ? { status, at: cancelStampMs(source) } : null;
}

/** The cancel that still holds across the index row and its session header:
 *  the unconfirmed one when the sources disagree (the row first otherwise).
 *  Only demonstrably newer work — a turn/start stamp strictly after a stamped
 *  cancel — supersedes it; an unstamped cancel is never superseded. */
function effectiveCancel(row, session) {
  const rowCancel = cancelState(row);
  const sessionCancel = cancelState(session);
  const cancel =
    rowCancel && sessionCancel && CANCEL_UNCONFIRMED_AGENT_STATUS.test(sessionCancel.status)
      ? CANCEL_UNCONFIRMED_AGENT_STATUS.test(rowCancel.status)
        ? rowCancel
        : sessionCancel
      : rowCancel || sessionCancel;
  if (!cancel) return null;
  const newerWork = cancel.at > 0 && Math.max(workStampMs(row), workStampMs(session)) > cancel.at;
  return newerWork ? null : cancel;
}

/** The stage shown beside a cancel: a stage that itself names the cancel (or
 *  the `cancelling` phase) is kept, any other phase is the cancel. */
function cancelStage(cancel, declaredStage) {
  return /^cancel/i.test(declaredStage) || CANCELLED_AGENT_STATUS.test(declaredStage) ? declaredStage : cancel.status;
}

// The worker indexes were re-parsed in full on every pool listing and ancestry
// lookup, changed or not. Each keeps its last parse beside the bytes it came
// from: the file is still read every time (a few hundred KB), but an
// unchanged one — byte for byte, so no timestamp collision can serve a stale
// document — reuses that parse.
// Before the read, the full file stamp is checked under the same canonical
// policy the session headers use: a file that still has the exact settled
// { dev, ino, size, mtimeNs, ctimeNs } its bytes were proven to come from is
// not read again (each pool listing re-read the whole index synchronously).
const workerIndexCache = new Map(); // path -> { bytes, doc, stamp|null }
// The index documents an asynchronous listing read before its (synchronous)
// assembly; live only during that assembly.
let passIndexes = null; // path -> doc | null

function readWorkerIndexFile(path) {
  if (passIndexes?.has(path)) return passIndexes.get(path);
  // This process's own queued (not yet persisted) writes win over the file.
  const projected = readJsonProjection(path);
  if (projected) return projected;
  const before = observeStamp(path);
  const cached = workerIndexCache.get(path);
  if (before && cached?.stamp && sameSessionStamp(cached.stamp, before)) return cached.doc;
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    workerIndexCache.delete(path);
    return null;
  }
  const stamp = before && isSettledSessionStamp(before) && sameSessionStamp(before, observeStamp(path)) ? before : null;
  if (cached?.bytes.equals(bytes)) {
    cached.stamp = stamp;
    return cached.doc;
  }
  let doc = null;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    /* malformed: no rows */
  }
  workerIndexCache.set(path, { bytes, doc, stamp });
  return doc;
}

/** readWorkerIndexFile with every stat and read awaited, under the same
 *  stamp and byte-equality cache. */
async function readWorkerIndexFileAsync(path) {
  const projected = readJsonProjection(path);
  if (projected) return projected;
  const before = await observeStampAsync(path);
  const cached = workerIndexCache.get(path);
  if (before && cached?.stamp && sameSessionStamp(cached.stamp, before)) return cached.doc;
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    workerIndexCache.delete(path);
    return null;
  }
  const settled = before && isSettledSessionStamp(before);
  const stamp = settled && sameSessionStamp(before, await observeStampAsync(path)) ? before : null;
  if (cached?.bytes.equals(bytes)) {
    cached.stamp = stamp;
    return cached.doc;
  }
  let doc = null;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    /* malformed: no rows */
  }
  workerIndexCache.set(path, { bytes, doc, stamp });
  return doc;
}

function storedAgentWorkerIndex() {
  return readWorkerIndexFile(storedAgentWorkerIndexPath());
}

function storedAgentWorkerIndexRows() {
  return workerRows(storedAgentWorkerIndex());
}

/** A worker index stores its rows as a list or as an id-keyed map. */
function workerRows(parsed) {
  if (Array.isArray(parsed?.workers)) return parsed.workers;
  return parsed?.workers && typeof parsed.workers === 'object' ? Object.values(parsed.workers) : [];
}

/** Lightweight ancestry seam used to migrate pre-parentSessionId summary
 * rows. It reads only agent-workers.json and never opens session transcripts. */
export function listStoredAgentWorkerLinks() {
  return storedAgentWorkerIndexRows()
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const sessionId = cleanValue(row.sessionId);
      const parentSessionId = cleanValue(row.parentSessionId);
      const ownerSessionId = cleanValue(row.ownerSessionId || row.parentSessionId);
      if (!isStoredSessionId(sessionId) || (!parentSessionId && !ownerSessionId)) {
        return null;
      }
      return {
        sessionId,
        parentSessionId: parentSessionId || ownerSessionId,
        ownerSessionId: ownerSessionId || parentSessionId,
      };
    })
    .filter(Boolean);
}

// The agent pool only reads top-level session fields, yet each refresh used to
// JSON.parse every active worker's whole transcript (megabytes per worker,
// every catalog publish). Cache the header per full file stamp instead (see
// probeWorkerSessionHeader).
// The cache holds exactly the headers the latest pool assembly read: a fixed
// LRU cap below the index size (263 headers against 256 slots) evicted every
// entry just before its reuse, so each refresh re-parsed every worker
// transcript synchronously (~130 MB, ~1 s of blocked daemon event loop).
const workerSessionHeaderCache = new Map();
/** Assembly the cache entries were last read by; older entries are dropped. */
let headerPass = 0;
// Pool rows need identity, routing, and lifecycle metadata only. Keeping the
// rest of a session here also retained its tool catalogs and provider state.
const WORKER_HEADER_FIELDS = [
  'owner',
  'agent',
  'sourceType',
  'ownerSessionId',
  'parentSessionId',
  'title',
  'provider',
  'model',
  'effort',
  'fast',
  'autoEffort',
  'createdAt',
  'updatedAt',
  'cwd',
  'clientHostPid',
  'agentTag',
  'task_id',
  'taskId',
  'turnStartedAt',
  'startedAt',
  'cancelledAt',
  'finishedAt',
  'totalInputTokens',
  'totalOutputTokens',
  'totalToolCalls',
  ...SESSION_CANCEL_FIELDS,
];

// One assembly reads a session's header up to three times (reap check, row
// projection, orphan prune); each read used to stat the file again. Within an
// assembly the first answer stands, absent or unreadable included.
let passHeaders = null; // path -> header | null, live only during an assembly

function workerSessionHeaderPath(sessionId, dir = dataDir()) {
  return join(dir, 'sessions', `${sessionId}.json`);
}

// Every change to the header cache is counted, so the persisted copy is
// rewritten only when the cache it mirrors moved.
let headerCacheEdits = 0;

function cacheHeader(path, entry) {
  workerSessionHeaderCache.set(path, entry);
  headerCacheEdits += 1;
}

function dropHeader(path) {
  if (workerSessionHeaderCache.delete(path)) headerCacheEdits += 1;
}

// The header cache outlives the daemon through store-agent-worker-header-
// cache.mjs: the first awaited listing of a data directory seeds the cache
// from its file (entries already in memory win), and an awaited listing that
// changed the cache schedules a rewrite. The write waits out
// HEADER_PERSIST_DELAY_MS — off the boot path, and at most one write per
// window however often agents churn. Seeded entries pass the same full-stamp
// check as any other, so a seed never serves a header its file no longer has.
const HEADER_PERSIST_DELAY_MS = 10_000;
let seededDir = null;
let seeding = null;
// The edit count the last write left on disk, and the directory it went to:
// a count persisted for one data directory says nothing about another.
let persistedEdits = 0;
let persistedDir = null;
let persistTimer = null;
let persistTimerDir = null;
let persistWrite = null;

function seedPersistedHeaders() {
  const dir = dataDir();
  if (seededDir !== dir) {
    seededDir = dir;
    seeding = readPersistedWorkerHeaders(storedAgentWorkerHeaderCachePath(dir), WORKER_HEADER_FIELDS).then(
      (entries) => {
        for (const [sessionId, { stamp, header }] of entries) {
          const path = workerSessionHeaderPath(sessionId, dir);
          if (!workerSessionHeaderCache.has(path)) workerSessionHeaderCache.set(path, { stamp, header, pass: 0 });
        }
      }
    );
  }
  return seeding;
}

function schedulePersistHeaders() {
  const dir = dataDir();
  // A write pending for the directory this listing left is dropped: the
  // listing just forgot that directory's unread headers, so writing it now
  // would shrink its file. Its last written cache still stands.
  if (persistTimer && persistTimerDir !== dir) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistTimer || (persistedDir === dir && headerCacheEdits === persistedEdits)) return;
  persistTimerDir = dir;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistHeaders(persistTimerDir);
  }, HEADER_PERSIST_DELAY_MS);
  persistTimer.unref?.();
}

function persistHeaders(dir) {
  if (persistWrite) return persistWrite;
  const edits = headerCacheEdits;
  const entries = [];
  for (const [path, entry] of workerSessionHeaderCache) {
    const sessionId = basename(path, '.json');
    if (isStoredSessionId(sessionId) && workerSessionHeaderPath(sessionId, dir) === path) {
      entries.push([sessionId, entry]);
    }
  }
  persistWrite = writePersistedWorkerHeaders(storedAgentWorkerHeaderCachePath(dir), WORKER_HEADER_FIELDS, entries).then(
    (written) => {
      if (written) {
        persistedEdits = edits;
        persistedDir = dir;
      }
      persistWrite = null;
    }
  );
  return persistWrite;
}

/** Test/diagnostic seam: writes a scheduled header-cache persist now and
 *  resolves once no write is in flight. */
export function flushStoredAgentWorkerHeaderCache() {
  if (!persistTimer) return persistWrite || Promise.resolve();
  clearTimeout(persistTimer);
  persistTimer = null;
  return persistHeaders(persistTimerDir);
}

function readWorkerSessionHeader(sessionId) {
  const path = workerSessionHeaderPath(sessionId);
  if (passHeaders?.has(path)) return passHeaders.get(path);
  const header = probeWorkerSessionHeader(path);
  passHeaders?.set(path, header);
  return header;
}

let workerHeaderReads = 0;

function observeStamp(path) {
  try {
    return statSessionStamp(path);
  } catch {
    return null;
  }
}

// A header is reused only under the canonical full-stamp policy: the file
// still has the exact { dev, ino, size, mtimeNs, ctimeNs } its bytes were
// proven to come from (stat → read → stat), and that stamp was past the racy
// window when read. Size + mtime alone let an equal-length rewrite that kept
// its mtime serve stale ownership, status and cancel fields.
function probeWorkerSessionHeader(path) {
  // Absent and unreadable alike: no header, and no cached one kept for it.
  const before = observeStamp(path);
  if (!before) {
    dropHeader(path);
    return null;
  }
  const cached = workerSessionHeaderCache.get(path);
  if (cached && sameSessionStamp(cached.stamp, before)) {
    cached.pass = headerPass;
    return cached.header;
  }
  dropHeader(path);
  // A rewrite re-reads only this record, and only its top-level fields are
  // decoded: the transcript bytes are validated, never materialized.
  let header = null;
  try {
    header = readTopLevelFields(readFileSync(path), WORKER_HEADER_FIELDS);
  } catch {
    return null;
  }
  if (!header) return null;
  workerHeaderReads += 1;
  if (isSettledSessionStamp(before) && sameSessionStamp(before, observeStamp(path))) {
    cacheHeader(path, { stamp: before, header, pass: headerPass });
  }
  return header;
}

async function observeStampAsync(path) {
  try {
    return sessionStampOf(await stat(path, { bigint: true }));
  } catch {
    return null;
  }
}

/** probeWorkerSessionHeader with every stat and read awaited, under the
 *  same full-stamp cache policy. */
async function probeWorkerSessionHeaderAsync(path) {
  const before = await observeStampAsync(path);
  if (!before) {
    dropHeader(path);
    return null;
  }
  const cached = workerSessionHeaderCache.get(path);
  if (cached && sameSessionStamp(cached.stamp, before)) return cached.header;
  dropHeader(path);
  let header = null;
  try {
    header = readTopLevelFields(await readFile(path), WORKER_HEADER_FIELDS);
  } catch {
    return null;
  }
  if (!header) return null;
  workerHeaderReads += 1;
  if (isSettledSessionStamp(before) && sameSessionStamp(before, await observeStampAsync(path))) {
    cacheHeader(path, { stamp: before, header, pass: headerPass });
  }
  return header;
}

// Header reads in flight at once: each is a stat (and a read only when the
// file changed) on the shared libuv pool, which other file I/O also needs.
const HEADER_READ_CONCURRENCY = 4;

async function prefetchWorkerHeaders(sessionIds, headers) {
  const paths = [...new Set([...sessionIds].map((sessionId) => workerSessionHeaderPath(sessionId)))].filter(
    (path) => !headers.has(path)
  );
  let next = 0;
  const drain = async () => {
    while (next < paths.length) {
      const path = paths[next++];
      headers.set(path, await probeWorkerSessionHeaderAsync(path));
    }
  };
  await Promise.all(Array.from({ length: Math.min(HEADER_READ_CONCURRENCY, paths.length) }, drain));
}

/** Test/diagnostic seam: cached headers and the records this process read. */
export function storedAgentWorkerHeaderStats() {
  return {
    entries: workerSessionHeaderCache.size,
    reads: workerHeaderReads,
    stickyIdle: stickyIdleSince.size,
    indexes: workerIndexCache.size,
  };
}

/** Owner record of a child row that is a Lead CONVERSATION. Only such an owner
 *  lets a missing pool row mean "the Lead's lease expired"; an Agent-owned or
 *  unreadable owner keeps its child rows visible exactly as before. */
function leadConversationHeader(header) {
  if (!header || typeof header !== 'object') return false;
  const owner = cleanValue(header.owner).toLowerCase();
  const agent = cleanValue(header.agent).toLowerCase();
  return owner !== 'agent' && (agent === 'lead' || cleanValue(header.sourceType).toLowerCase() === 'lead');
}

/** Whether the daemon reports the session's turn in flight. */
function sessionRunning(sessionId, { runningSessionIds }) {
  return runningSessionIds instanceof Set && runningSessionIds.has(sessionId);
}

/** An already projected row is live work: its projected status is working
 *  only when the daemon reported it running (otherwise it reads `unknown`). */
function poolRowWorking(row) {
  return WORKING_AGENT_STATUS.test(workerLifecycle(row));
}

/** A child worker-index row projected into the pool, or null. A finished
 *  child — completed, cancelled or failed — stays listed for the pane window
 *  after its finish stamp so consumers see the outcome instead of the row
 *  vanishing; unconfirmed cancels are not dead and keep their own status. */
function projectChildWorkerRow(row, context) {
  if (!row || typeof row !== 'object') return null;
  if (cleanValue(row.agent).toLowerCase() === 'lead') return null;
  const sessionId = cleanValue(row.sessionId);
  const tag = cleanValue(row.tag);
  if (!sessionId || !tag || !isStoredSessionId(sessionId)) return null;
  // A stale done/error row does not hide a child the daemon is running. The
  // header is read before any pane-window cutoff: an expired row can still sit
  // beside a header that records a cancel-unconfirmed (possibly running)
  // process. A new row may precede its first session save (null header).
  const session = readWorkerSessionHeader(sessionId);
  const declaredStatus = cleanValue(row.status) || 'running';
  const declaredStage = cleanValue(row.stage || row.status) || 'running';
  const declaredWorking = WORKING_AGENT_STATUS.test(workerLifecycle(row) || 'running');
  // A cancel in the row (any field, stage included) or in the durable session
  // header holds until demonstrably newer work supersedes it.
  const cancel = effectiveCancel(row, session);
  // The daemon's in-memory run state is authoritative: a running session is
  // working whatever the durable row says. Only an explicit cancel outranks it.
  const working = !cancel && sessionRunning(sessionId, context);
  const completed = COMPLETED_AGENT_STATUS.test(workerLifecycle(row));
  const unconfirmedCancel = Boolean(cancel) && CANCEL_UNCONFIRMED_AGENT_STATUS.test(cancel.status);
  if (!working && !unconfirmedCancel && (cancel || !declaredWorking)) {
    // Settled: only a completed, failed or cancelled outcome is listed, and
    // only inside the pane window.
    if (!cancel && !completed && !failedAgentWorker(row)) return null;
    if (!agentPaneVisible(finishedAtMs(row, session), context.now)) return null;
  }
  let shownStatus = declaredStatus;
  let shownStage = declaredStage;
  if (cancel) {
    shownStatus = cancel.status;
    shownStage = cancelStage(cancel, declaredStage);
  } else if (working) {
    if (!declaredWorking) shownStatus = shownStage = 'running';
  } else if (declaredWorking) {
    shownStatus = shownStage = 'unknown';
  } else if (completed) {
    shownStatus = shownStage = 'completed';
  }
  return {
    tag,
    sessionId,
    // Root ownership and immediate ancestry are independent. Nested
    // descendants keep the Lead/root owner while pointing at the Agent
    // session that directly spawned them.
    ownerSessionId: workerOwnerSessionId(row, session),
    parentSessionId: workerParentSessionId(row, session),
    title: cleanValue(row.title || session?.title) || null,
    agent: cleanValue(row.agent || session?.agent) || null,
    provider: cleanValue(row.provider || session?.provider) || null,
    model: cleanValue(row.model || session?.model) || null,
    effort: cleanValue(row.effort || session?.effort) || null,
    fast: row.fast === true || session?.fast === true,
    ...(row.autoEffort === false || session?.autoEffort === false ? { autoEffort: false } : {}),
    status: shownStatus,
    stage: shownStage,
    // A live turn blocked on the user's approval (persisted by the agent
    // tool's worker index); never carried by a row that is no longer working.
    ...(working && row.awaitingUser === 'approval' ? { awaitingUser: 'approval' } : {}),
    // Why a settled failed row failed; a row working again has no failure.
    ...(!working && failedAgentWorker(row) && cleanValue(row.failureReason)
      ? { failureReason: cleanValue(row.failureReason) }
      : {}),
    startedAt: row.startedAt || row.createdAt || session?.createdAt || null,
    turnStartedAt: working ? row.turnStartedAt || null : null,
    createdAt: row.createdAt || session?.createdAt || null,
    updatedAt: row.updatedAt || session?.updatedAt || null,
    idleSince: frozenIdleSince(sessionId, working, row.finishedAt || row.updatedAt || session?.updatedAt || null),
    reapAt: row.reapAt || null,
    cwd: cleanValue(row.cwd || session?.cwd) || null,
    clientHostPid: positiveNumber(row.clientHostPid || session?.clientHostPid, 0) || null,
    taskId: cleanValue(row.task_id || row.taskId) || null,
    ...sessionUsageTotals(session),
  };
}

function storedLeadWorkerRows() {
  // Absent or unreadable: no resident Lead pool.
  return workerRows(readWorkerIndexFile(storedLeadWorkerIndexPath()));
}

/** A Lead-index row whose durable session turned out to be an agent's.
 *  Legacy Lead rows may predate a durable session record (no header). */
function leadRowOwnedByAgent(sessionId) {
  const header = readWorkerSessionHeader(sessionId);
  const owner = cleanValue(header?.owner).toLowerCase();
  const agent = cleanValue(header?.agent).toLowerCase();
  return owner === 'agent' || Boolean(agent && agent !== 'lead');
}

/** A Lead worker-index row projected into the pool, or null. */
function projectLeadWorkerRow(row, context) {
  const { now } = context;
  if (!row || typeof row !== 'object') return null;
  const sessionId = cleanValue(row.sessionId);
  if (!sessionId || !isStoredSessionId(sessionId)) return null;
  if (leadRowOwnedByAgent(sessionId)) return null;
  const declaredStatus = workerLifecycle(row) || 'idle';
  const declaredWorking = WORKING_AGENT_STATUS.test(declaredStatus);
  // As for child rows: an explicit cancel outranks the daemon's running report.
  const cancel = effectiveCancel(row, null);
  const working = !cancel && sessionRunning(sessionId, context);
  // Live work outlasts the pane window; a settled Lead is listed for it after
  // its finish stamp, whatever its provider reap window is.
  if (!working && !agentPaneVisible(finishedAtMs(row), now)) return null;
  let shownStatus = declaredStatus;
  if (cancel) shownStatus = cancel.status;
  else if (working) shownStatus = declaredWorking ? declaredStatus : 'running';
  else if (declaredWorking) shownStatus = 'unknown';
  return {
    tag: `lead:${sessionId}`,
    sessionId,
    ownerSessionId: sessionId,
    parentSessionId: null,
    agent: 'lead',
    provider: cleanValue(row.provider) || null,
    model: cleanValue(row.model) || null,
    effort: cleanValue(row.effort) || null,
    fast: row.fast === true,
    ...(row.autoEffort === false ? { autoEffort: false } : {}),
    status: shownStatus,
    stage: shownStatus,
    startedAt: row.startedAt || row.createdAt || null,
    turnStartedAt: working ? row.turnStartedAt || null : null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    idleSince: frozenIdleSince(sessionId, working, row.finishedAt || row.updatedAt || null),
    cwd: cleanValue(row.cwd) || null,
    clientHostPid: positiveNumber(row.clientHostPid, 0) || null,
    taskId: cleanValue(row.task_id || row.taskId) || null,
    ...sessionUsageTotals(readWorkerSessionHeader(sessionId)),
  };
}

/** A child row is a projection of its Lead. Once the Lead's row is gone (its
 *  lease was reaped, or the Lead runtime that owned it exited), leaving the
 *  child in the pool paints it as a top-level Agent-window row with no Lead
 *  above it (user report). Only a Lead CONVERSATION owner is judged — and a
 *  child that is still working always stays, so live work never disappears
 *  from the window. */
function pruneOrphanChildRows(bySessionId, { liveLeadSessionIds }) {
  for (const [sessionId, row] of [...bySessionId]) {
    if (cleanValue(row.agent).toLowerCase() === 'lead') continue;
    const ownerSessionId = cleanValue(row.ownerSessionId);
    if (!ownerSessionId || liveLeadSessionIds.has(ownerSessionId)) continue;
    if (!leadConversationHeader(readWorkerSessionHeader(ownerSessionId))) continue;
    if (poolRowWorking(row)) continue;
    bySessionId.delete(sessionId);
  }
}

/** Process-global active agent pool: the living rows (running or idle) of the
 * child and Lead indexes. No runtime starts and durable session history is
 * never projected into either pool. `runningSessionIds` is the daemon's set of
 * sessions whose turn is in flight; omitted, no row is shown as running. */
export function listStoredAgentWorkers({ runningSessionIds = null } = {}) {
  headerPass += 1;
  passHeaders = new Map();
  try {
    return assembleListedWorkers(runningSessionIds);
  } finally {
    passHeaders = null;
    forgetUnreadHeaders();
  }
}

// Keep what the latest assembly read, whatever the index size; forget the rest.
function forgetUnreadHeaders() {
  for (const [path, entry] of workerSessionHeaderCache) {
    if (entry.pass !== headerPass) dropHeader(path);
  }
}

/** listStoredAgentWorkers without blocking the event loop on the store: both
 *  indexes and every header the assembly can consult (each row's session,
 *  each Lead row's, and each child's owner) are read first with awaited
 *  stats and reads; the assembly then runs over what was read, with no file
 *  access left in it (any header it still asks for falls back to a read).
 *  The first listing after a restart seeds the header cache from its
 *  persisted copy, so only records changed since are read again.
 *  `runningSessionIds` may be a function, asked once the reads are done. */
export async function listStoredAgentWorkersAsync({ runningSessionIds = null } = {}) {
  const agentIndexPath = storedAgentWorkerIndexPath();
  const leadIndexPath = storedLeadWorkerIndexPath();
  const [agentIndex, leadIndex] = await Promise.all([
    readWorkerIndexFileAsync(agentIndexPath),
    readWorkerIndexFileAsync(leadIndexPath),
    seedPersistedHeaders(),
  ]);
  const headers = new Map();
  const childRows = workerRows(agentIndex);
  const sessionIds = new Set(childRows.map((row) => cleanValue(row?.sessionId)));
  for (const row of workerRows(leadIndex)) {
    const sessionId = cleanValue(row?.sessionId);
    if (sessionId && isStoredSessionId(sessionId)) sessionIds.add(sessionId);
  }
  await prefetchWorkerHeaders(sessionIds, headers);
  const owners = new Set();
  for (const row of childRows) {
    const header = headers.get(workerSessionHeaderPath(cleanValue(row?.sessionId)));
    const owner = row && typeof row === 'object' ? workerOwnerSessionId(row, header) : null;
    if (owner) owners.add(owner);
  }
  await prefetchWorkerHeaders(owners, headers);
  const running = typeof runningSessionIds === 'function' ? runningSessionIds() : runningSessionIds;
  headerPass += 1;
  for (const path of headers.keys()) {
    const entry = workerSessionHeaderCache.get(path);
    if (entry) entry.pass = headerPass;
  }
  passHeaders = headers;
  passIndexes = new Map([
    [agentIndexPath, agentIndex],
    [leadIndexPath, leadIndex],
  ]);
  try {
    return assembleListedWorkers(running);
  } finally {
    passHeaders = null;
    passIndexes = null;
    forgetUnreadHeaders();
    schedulePersistHeaders();
  }
}

function assembleListedWorkers(runningSessionIds) {
  const now = Date.now();
  const index = storedAgentWorkerIndex();
  const rows = workerRows(index);
  const byId = new Map(rows.map((row) => [cleanValue(row.sessionId), row]));
  const tombstones = new Map(
    Object.values(index?.tombstones || {})
      .filter((row) => row && stampMs(row.reapedAt) >= now - TAG_TOMBSTONE_TTL_MS)
      .map((row) => [tagTombstoneKey(row), row])
  );
  const isReaped = (sessionId) => {
    const header = readWorkerSessionHeader(sessionId) || {};
    const row = byId.get(sessionId);
    const work = {
      ...header,
      ...row,
      parentSessionId: workerParentSessionId(row, header),
      ownerSessionId: workerOwnerSessionId(row, header),
      clientHostPid: row?.clientHostPid || header.clientHostPid,
      createdAt: row?.createdAt || header.createdAt,
      turnStartedAt: row?.turnStartedAt || header.turnStartedAt,
    };
    return tombstoneBlocksWork(work, findTagTombstone(work, tombstones));
  };
  return assembleStoredAgentWorkers({
    now,
    runningSessionIds,
    storedAgentWorkerIndexRows: () => rows.filter((row) => !isReaped(cleanValue(row.sessionId))),
    projectChildWorkerRow,
    storedLeadWorkerRows,
    projectLeadWorkerRow,
    pruneOrphanChildRows,
  });
}
