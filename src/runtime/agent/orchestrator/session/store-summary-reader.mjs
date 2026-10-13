/**
 * Read-only session summary catalog for cold desktop startup.
 *
 * The summary path intentionally avoids store.mjs, config/provider loading,
 * workers, and atomic-lock writers. A transcript read stays lightweight too
 * unless a durable turn checkpoint exists; only then does it lazily enter the
 * reconnect recovery boundary so restored panes never paint a stale prompt.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
// Leaf helpers only (no store.mjs, no workers, no config): the three-way
// present/absent/unreadable classification and the strict record parser the
// authoritative store uses, so the cold catalog cannot disagree with it.
import { probePath, readTextFile, PROBE_PRESENT, PROBE_ABSENT } from './store/fs-probe.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from './lifecycle-scan.mjs';
import { isAgentOnlySession, isRootLeadSession, sessionVisibility } from './store-summary-visibility.mjs';
import { applySummaryLogText, summaryLogPath } from './store-summary-log.mjs';
import { createStoredTranscriptCache, nextProjectionStamp } from './store-transcript-cache.mjs';
import {
  OFFLOAD_MIN_CHARS,
  projectStoredTranscriptOffThread,
  storedTranscriptWorkerRunning,
} from './store-transcript-worker.mjs';
import { projectStoredTranscript } from './store-transcript-projection.mjs';
import { dataDir, sessionHeartbeatMtimes } from './store-summary-locations.mjs';
import { desktopSession, isStoredSessionId, positiveNumber, workspaceSummary } from './store-summary-fields.mjs';
import { readArchivedAgentResult } from './store-summary-archived-agent.mjs';
import { compactionArchivePath, readCompactionArchivePage } from './compaction-archive.mjs';
import {
  readCanonicalSessionRecord as readCanonicalLifecycle,
  offerStrictSessionRecord,
  sessionStampOf,
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

// ── Stamp-keyed strict derivations ──────────────────────────────────────────
// Session metadata and catalog rows are small values derived from a strict
// parse of the whole record. They are reused only while the file still has
// the FULL stamp { dev, ino, size, mtimeNs, ctimeNs } the parsed bytes were
// proven to come from (stat → read → stat) and that stamp is past the racy
// window. Any other file — changed, replaced by another writer, unreadable —
// is read and strictly parsed again.
const STAMPED_DERIVATION_LIMIT = 2048;
const stampedDerivations = new Map(); // `${kind}|${path}` → { stamp, value }

function observeStamp(path) {
  try {
    return statSessionStamp(path);
  } catch {
    return null;
  }
}

/** `{ state, value }`: `derive(text)` for the record at `path`, or its cached
 *  result while the file is provably unchanged. */
function stampedDerivation(kind, path, derive) {
  const key = `${kind}|${path}`;
  const before = observeStamp(path);
  const cached = stampedDerivations.get(key);
  if (before && cached && sameSessionStamp(cached.stamp, before)) {
    stampedDerivations.delete(key);
    stampedDerivations.set(key, cached);
    return { state: PROBE_PRESENT, value: cached.value };
  }
  stampedDerivations.delete(key);
  const read = readTextFile(path);
  if (read.state !== PROBE_PRESENT) return { state: read.state, value: null };
  const value = derive(read.text);
  if (isSettledSessionStamp(before) && sameSessionStamp(before, observeStamp(path))) {
    stampedDerivations.set(key, { stamp: before, value });
    if (stampedDerivations.size > STAMPED_DERIVATION_LIMIT) {
      stampedDerivations.delete(stampedDerivations.keys().next().value);
    }
  }
  return { state: PROBE_PRESENT, value };
}

/** Test seam: forget every stamp-keyed derivation. */
export function clearStoredSessionDerivations() {
  stampedDerivations.clear();
}

const SESSION_SUMMARY_INDEX_VERSION = 2;

// Mirror of lifecycle-api.mjs listLeadSessions visibility: the cold catalog
// must never surface worker/agent dispatches (memory ingest chunks, judges,
// spawned agents) — the authoritative engine excludes them, so a click on
// such a row dead-ends in "Session is not available." (user report).
const LEAD_OWNERS = new Set(['cli', 'user', 'mixdog']);

function isLeadVisibleRow(row) {
  const owner = String(row.owner || 'user')
    .trim()
    .toLowerCase();
  if (isAgentOnlySession(row)) return false;
  if (!isRootLeadSession(row) && owner && !LEAD_OWNERS.has(owner)) return false;
  // Mirror listLeadSessions: a previewless zero-message row is an unusable
  // scratch (desktop boot leftovers, crashed first turns) — resuming it
  // shows an empty conversation, so the catalog hides it.
  if (!row.preview && row.messageCount === 0) return false;
  const sourceType = String(row.sourceType || '')
    .trim()
    .toLowerCase();
  // Mirror listLeadSessions: one-shot `mixdog exec` runs stay out of Recent.
  if (sourceType === 'exec') return false;
  const sourceName = String(row.sourceName || '')
    .trim()
    .toLowerCase();
  const agent = String(row.agent || '')
    .trim()
    .toLowerCase();
  return (
    agent === 'lead' ||
    sourceType === 'lead' ||
    sourceType === 'cli' ||
    sourceType === 'schedule' ||
    sourceType === 'webhook' ||
    (!sourceType && !sourceName && owner !== 'agent')
  );
}

function cleanText(value, maximum = 240) {
  return (
    String(value || '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
      .replace(/<mcp-instructions>[\s\S]*?<\/mcp-instructions>/gi, ' ')
      // Session-context envelope (mirror of session-text.mjs
      // stripSessionDisplayEnvelope): the "# Session / Cwd / Model /
      // Workflow" header must never become a Recent title.
      .replace(/^\s*# Session\r?\n(?:(?:Cwd|Model|Workflow):[^\r\n]*(?:\r?\n|$))+(?:\r?\n)?/i, ' ')
      .replace(/^\s*#\s*Session\s+Cwd:\s+\S+(?:\s+Model:[^\r\n]*?)?(?:\s+Workflow:\s+\S+)?\s*/i, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maximum)
  );
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : String(part?.text || part?.content || '')))
    .filter(Boolean)
    .join(' ');
}

function normalizedRow(row, heartbeatAt = 0) {
  if (!row || typeof row.id !== 'string' || !isStoredSessionId(row.id)) return null;
  return {
    id: row.id,
    updatedAt: positiveNumber(row.updatedAt, 0),
    // Conversation-activity timestamp (mirror of listLeadSessions):
    // detach/resume bookkeeping bumps updatedAt in bulk on restarts, so
    // Recent must order by lastUsedAt or every restart reshuffles rows.
    lastUsedAt: positiveNumber(row.lastUsedAt, 0),
    createdAt: positiveNumber(row.createdAt, 0),
    lastHeartbeatAt: positiveNumber(row.lastHeartbeatAt, 0),
    // Liveness comes from the .hb sidecar mtime alone: stored row fields
    // (summary index / final session save) survive completion and must not
    // keep the desktop working indicator on after the sidecar is deleted.
    heartbeatAt: positiveNumber(heartbeatAt, 0),
    closed: row.closed === true,
    status: String(row.status || (row.closed === true ? 'closed' : 'idle')),
    owner: row.owner || 'user',
    agent: row.agent || null,
    sourceType: row.sourceType || null,
    sourceName: row.sourceName || null,
    scopeKey: row.scopeKey || null,
    ownerSessionId: row.ownerSessionId || row.parentSessionId || null,
    visibility: sessionVisibility(row),
    clientHostPid: positiveNumber(row.clientHostPid, 0) || null,
    cwd: row.cwd || '',
    desktopSession: desktopSession(row.desktopSession, row.cwd),
    ...(workspaceSummary(row.workspace) ? { workspace: workspaceSummary(row.workspace) } : {}),
    provider: row.provider || null,
    model: row.model || null,
    agentTag: row.agentTag || null,
    task_id: row.task_id || row.taskId || null,
    permission: row.permission || null,
    toolPermission: row.toolPermission || null,
    messageCount: Math.max(0, Math.floor(Number(row.messageCount) || 0)),
    title: cleanText(row.title, 100),
    preview: cleanText(row.preview),
    generation: typeof row.generation === 'number' ? row.generation : 0,
    storageMtimeMs: positiveNumber(row.storageMtimeMs, 0),
    storageSize: positiveNumber(row.storageSize, 0),
    detachedReason: row.detachedReason || null,
  };
}

function leadRowsWithAgentHeartbeat(rows) {
  const agentHeartbeatByOwner = new Map();
  for (const row of rows) {
    const heartbeatAt = positiveNumber(row?.heartbeatAt, 0);
    const ownerSessionId = String(row?.ownerSessionId || '').trim();
    const owner = String(row?.owner || '')
      .trim()
      .toLowerCase();
    const agent = String(row?.agent || '')
      .trim()
      .toLowerCase();
    if (!heartbeatAt || !ownerSessionId || (owner !== 'agent' && (!agent || agent === 'lead'))) continue;
    agentHeartbeatByOwner.set(ownerSessionId, Math.max(agentHeartbeatByOwner.get(ownerSessionId) || 0, heartbeatAt));
  }
  return rows
    .filter((row) => row && isLeadVisibleRow(row))
    .map((row) => {
      const agentHeartbeatAt = agentHeartbeatByOwner.get(row.id) || 0;
      return agentHeartbeatAt > 0 ? { ...row, agentHeartbeatAt } : row;
    });
}

function rowFromSession(session, heartbeatAt = 0) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const preview =
    messages
      .filter((message) => message?.role === 'user')
      // Cold-path mirror of isSessionPreviewNoise's synthetic skips: compact
      // handoffs and runtime notices must not become session titles.
      .filter(
        (message) =>
          !/^\s*(?:a previous model worked on this task|re-attached after compaction\b|reference files:\s|\[mixdog-runtime\]|the async (?:agent|shell) task\b)/i.test(
            messageText(message.content)
          )
      )
      .map((message) => cleanText(messageText(message.content)))
      .find(Boolean) || '';
  return normalizedRow(
    {
      ...session,
      messageCount: messages.filter((message) => message?.role === 'user' || message?.role === 'assistant').length,
      preview,
    },
    heartbeatAt
  );
}

// ── Session file reconcile ──────────────────────────────────────────────────
// What one `sessions/<id>.json` name contributes to the catalog, with the full
// stamp { dev, ino, size, mtimeNs, ctimeNs } it was judged at (and the
// { mtimeMs, size } fingerprint the summary index records):
//   indexed     its summary-index row (the file matches the row's fingerprint)
//   row         a row strictly parsed from the file (the index does not describe it)
//   none        parsed, but yields no row (ambiguous or foreign record)
//   unreadable  present but not statable/readable: the index row is retained
const UNREADABLE_ENTRY = Object.freeze({ kind: 'unreadable', stamp: null, mtimeMs: 0, size: 0 });

/** `stat().mtimeMs` of a bigint stat: Node's own sec * 1e3 + nsec / 1e6. */
function stampMtimeMs(stamp) {
  return Number(stamp.mtimeNs / 1_000_000_000n) * 1e3 + Number(stamp.mtimeNs % 1_000_000_000n) / 1e6;
}

/** The entry for `<storageId>.json`, or null when the file is provably gone. */
function reconcileSessionFile(directory, storageId, retained, forceRead) {
  const path = join(directory, `${storageId}.json`);
  let stamp;
  try {
    stamp = statSessionStamp(path);
  } catch (error) {
    // Provably gone: the row legitimately disappears with the file.
    return STAMP_ABSENT_CODES.has(error?.code) ? null : UNREADABLE_ENTRY;
  }
  const fingerprint = { stamp, mtimeMs: stampMtimeMs(stamp), size: Number(stamp.size) };
  if (
    !forceRead &&
    retained &&
    retained.storageMtimeMs > 0 &&
    retained.storageSize > 0 &&
    retained.storageMtimeMs === fingerprint.mtimeMs &&
    retained.storageSize === fingerprint.size
  ) {
    return { kind: 'indexed', ...fingerprint };
  }
  // A file the index does not describe (never saved by the store, or
  // saved after the index was written) is parsed once per full stamp.
  const read = stampedDerivation('row', path, (text) => {
    // Same strict authority as the store: a duplicate/ambiguous top-level
    // record or a foreign identity is not this file's session.
    const record = readTopLevelLifecycleRecord(text);
    if (isLifecycleUnreadable(record) || record.id !== storageId) return null;
    return rowFromSession(record.doc, 0);
  });
  if (read.state === PROBE_ABSENT) return null;
  // Exists and could not be read (EACCES/EIO): retain the last known row
  // rather than let a transient IO error delete it from view.
  if (read.state !== PROBE_PRESENT) return UNREADABLE_ENTRY;
  if (!read.value) return { kind: 'none', ...fingerprint };
  return {
    kind: 'row',
    row: deepFreeze({
      ...structuredClone(read.value),
      storageMtimeMs: fingerprint.mtimeMs,
      storageSize: fingerprint.size,
    }),
    ...fingerprint,
  };
}

/** Cached rows are shared by every listing that hands them out: frozen, so
 *  no caller can edit what the next caller sees. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** The session ids (`<id>.json`) and live sidecar ids (`<id>.hb`) of
 *  `directory`, or null when it cannot be enumerated. */
function listSessionNames(directory) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return null;
  }
  const sessionIds = [];
  const heartbeatIds = [];
  for (const filename of names) {
    if (filename.endsWith('.json')) sessionIds.push(filename.slice(0, -5));
    else if (filename.endsWith('.hb') && isStoredSessionId(filename.slice(0, -3))) {
      heartbeatIds.push(filename.slice(0, -3));
    }
  }
  return { sessionIds, heartbeatIds };
}

/** Every `.json` entry and `.hb` sidecar id of an enumerable `directory`, or
 *  null when it cannot be enumerated. */
function scanSessionEntries(directory, indexRowsById, forceRead) {
  const names = listSessionNames(directory);
  if (!names) return null;
  const entries = new Map();
  for (const storageId of names.sessionIds) {
    const entry = reconcileSessionFile(directory, storageId, indexRowsById.get(storageId), forceRead);
    if (entry) entries.set(storageId, entry);
  }
  return { entries, heartbeatIds: names.heartbeatIds };
}

/** Catalog rows of reconciled `entries`, newest activity first. */
function assembleCatalog(entries, indexRowsById, heartbeatMtimes) {
  const rows = [];
  for (const [id, entry] of entries) {
    let row = null;
    if (entry.kind === 'row') row = entry.row;
    else if (entry.kind !== 'none') row = indexRowsById.get(id);
    if (row) rows.push({ ...row, heartbeatAt: positiveNumber(heartbeatMtimes.get(id), 0) });
  }
  return leadRowsWithAgentHeartbeat(rows).sort(byRecentActivity);
}

/**
 * Read-only scan of the authoritative session files.
 * Returns `null` when the directory itself is NOT enumerable (unreadable
 * stat / readdir): that is not "no sessions", and the caller must keep the
 * authority it already has (the index rows) instead of publishing an empty
 * catalog. `indexRowsById` carries those rows so unchanged files can reuse the
 * durable summary and a single UNREADABLE file retains its last known row
 * instead of vanishing.
 */
function scanSessionFiles(heartbeatMtimes, indexRowsById, forceRead) {
  const directory = join(dataDir(), 'sessions');
  const dirProbe = probePath(directory);
  if (dirProbe.state === PROBE_ABSENT) return [];
  if (dirProbe.state !== PROBE_PRESENT) return null;
  const scan = scanSessionEntries(directory, indexRowsById, forceRead);
  return scan && assembleCatalog(scan.entries, indexRowsById, heartbeatMtimes);
}

// Newest conversation activity first (see normalizedRow's lastUsedAt note).
function byRecentActivity(left, right) {
  return (right.lastUsedAt || right.updatedAt || 0) - (left.lastUsedAt || left.updatedAt || 0);
}

// ── Summary index ───────────────────────────────────────────────────────────
// Base + delta log, parsed once per full stamp of the pair. Stamps are taken
// BEFORE the reads: a write landing mid-read changes them, and the next call
// reads again. Every session update appends to the log; when the log has only
// grown — its bytes up to what was applied last are byte-for-byte unchanged
// and the base stamp is the same — only the appended lines are applied. A
// compaction (new base, truncated log) or any other rewrite fails that check
// and reloads both. Only newline-terminated lines are applied: a line still
// being appended is picked up whole by the next call.
const NO_INDEX_ROWS = new Map();
const NEWLINE = 0x0a;
let summaryIndexCache = null;
let summaryIndexSerial = 0;

function sameOptionalStamp(left, right) {
  return (!left && !right) || sameSessionStamp(left, right);
}

/** `{ bytes, failed }`: the log, empty when absent; `failed` when it exists
 *  and could not be read (EACCES/EIO), which is never cached. */
function readLogBytes(logPath) {
  try {
    return { bytes: readFileSync(logPath), failed: false };
  } catch (error) {
    return { bytes: Buffer.alloc(0), failed: !STAMP_ABSENT_CODES.has(error?.code) };
  }
}

function freshIndex(indexPath, baseStamp, logStamp, logBytes) {
  return {
    serial: ++summaryIndexSerial,
    // The index this one extends by appended log lines, and the ids they touched.
    parentSerial: 0,
    touchedIds: null,
    indexPath,
    baseStamp,
    logStamp,
    // The log prefix applied: every byte up to and including its last newline.
    logBytes: logBytes.subarray(0, logBytes.lastIndexOf(NEWLINE) + 1),
    // `rows` null = missing, unreadable or malformed: the files are the authority.
    rows: null,
    rowsById: NO_INDEX_ROWS,
    // JSON of every row of base + log by id. Without a valid base the log's
    // rows are still recorded here: they say which sessions an index-updating
    // writer touched, even though they are not used as rows.
    signatures: new Map(),
  };
}

function loadSummaryIndex() {
  const indexPath = join(dataDir(), 'session-summaries.json');
  const baseStamp = observeStamp(indexPath);
  const logStamp = observeStamp(summaryLogPath(indexPath));
  const cached = summaryIndexCache?.indexPath === indexPath ? summaryIndexCache : null;
  if (cached && sameOptionalStamp(cached.baseStamp, baseStamp) && sameOptionalStamp(cached.logStamp, logStamp)) {
    return cached;
  }
  // The delta log (per-session updates since the last compaction) is read
  // before the base; see store-summary-log.mjs.
  const log = readLogBytes(summaryLogPath(indexPath));
  const index = freshIndex(indexPath, baseStamp, logStamp, log.bytes);
  const appliedBytes = cached?.logBytes.length ?? 0;
  if (
    !log.failed &&
    cached?.rows &&
    sameOptionalStamp(cached.baseStamp, baseStamp) &&
    index.logBytes.length >= appliedBytes &&
    index.logBytes.compare(cached.logBytes, 0, appliedBytes, 0, appliedBytes) === 0
  ) {
    const rowsById = new Map(cached.rowsById);
    const touched = new Set();
    for (const line of index.logBytes.toString('utf8', appliedBytes).split('\n')) {
      if (!line) continue;
      let op;
      try {
        op = JSON.parse(line);
      } catch {
        continue;
      }
      // Same semantics as applySummaryLogText: last writer wins per id.
      if (op?.u && typeof op.u.id === 'string') {
        const row = normalizedRow(op.u, 0);
        if (row) rowsById.set(row.id, deepFreeze(row));
        else rowsById.delete(op.u.id);
        touched.add(op.u.id);
      } else if (Array.isArray(op?.r)) {
        for (const id of op.r) {
          rowsById.delete(id);
          touched.add(id);
        }
      }
    }
    index.parentSerial = cached.serial;
    index.touchedIds = touched;
    index.rows = [...rowsById.values()];
    index.rowsById = rowsById;
    index.signatures = new Map(cached.signatures);
    for (const id of touched) {
      const row = rowsById.get(id);
      if (row) index.signatures.set(id, JSON.stringify(row));
      else index.signatures.delete(id);
    }
    summaryIndexCache = index;
    return index;
  }
  const indexRead = readTextFile(indexPath);
  let baseRows = null;
  if (indexRead.state === PROBE_PRESENT) {
    try {
      const raw = JSON.parse(indexRead.text);
      if (Number(raw?.version) === SESSION_SUMMARY_INDEX_VERSION) baseRows = Array.isArray(raw.rows) ? raw.rows : [];
    } catch {
      /* malformed sidecar: the files are the authority */
    }
  }
  const rows = applySummaryLogText({ rows: baseRows ?? [] }, index.logBytes.toString('utf8'))
    .rows.map((row) => normalizedRow(row, 0))
    .filter(Boolean)
    .map(deepFreeze);
  for (const row of rows) index.signatures.set(row.id, JSON.stringify(row));
  if (baseRows) {
    index.rows = rows;
    index.rowsById = new Map(rows.map((row) => [row.id, row]));
  }
  // A read that failed (EACCES/EIO) is not cached: the next call reads again.
  if (!log.failed && (indexRead.state === PROBE_PRESENT || indexRead.state === PROBE_ABSENT)) {
    summaryIndexCache = index;
  }
  return index;
}

/** Ids whose index row differs between two loads (added, changed or removed). */
function changedIndexIds(previous, next) {
  const ids = [];
  const candidates = next.parentSerial === previous.serial ? next.touchedIds : next.signatures.keys();
  for (const id of candidates) if (previous.signatures.get(id) !== next.signatures.get(id)) ids.push(id);
  if (next.parentSerial !== previous.serial) {
    for (const id of previous.signatures.keys()) if (!next.signatures.has(id)) ids.push(id);
  }
  return ids;
}

// ── Ordinary catalog ────────────────────────────────────────────────────────
// The ordinary listing keeps its last reconcile and answers an unchanged call
// from cheap stamps alone: the index pair (above), the sessions DIRECTORY and
// the handful of live `.hb` sidecars — no per-session-file filesystem work.
//
// The directory stamp changes on every create, delete and rename in it
// (including a temp-file + rename replace), and NOT on an in-place write
// (measured on NTFS; POSIX directories behave the same). So:
//  - directory stamp changed → one enumeration; names that appeared are
//    reconciled, names that vanished are dropped, names present before and
//    after keep their entry. A stamp still inside the racy window is
//    re-enumerated on every call until it settles: on a coarse-clock
//    filesystem a create/delete in the same tick would leave it unchanged;
//  - index rows changed (this process, another process, a compaction) → only
//    those ids are re-reconciled — this is what refreshes a session an
//    index-updating writer replaced under its existing name;
//  - a file replaced (rename) or rewritten in place by a writer that does not
//    update the index keeps its name and its index row: a background pass
//    (async stats, never blocking a listing) finds it, the next listing
//    re-reconciles just that file, and subscribers are told to list again.
//    A pass runs at most once per CATALOG_VERIFY_INTERVAL_MS and at the
//    latest that long after a listing.
const CATALOG_VERIFY_INTERVAL_MS = 10_000;
const CATALOG_VERIFY_BATCH = 32;
let sessionCatalog = null;
const catalogListeners = new Set();

/** `listener()` runs when a background pass finds a session file that changed
 *  without a directory or index change, i.e. when an ordinary listing would
 *  now differ from the last one. Returns the unsubscribe function. */
export function subscribeStoredSessionCatalogChanges(listener) {
  catalogListeners.add(listener);
  return () => catalogListeners.delete(listener);
}

function sameMtimes(left, right) {
  if (!right || left.size !== right.size) return false;
  for (const [id, mtimeMs] of left) if (right.get(id) !== mtimeMs) return false;
  return true;
}

/** Ordinary catalog rows, [] when the sessions directory is absent, or null
 *  when it cannot be enumerated. */
function ordinarySessionCatalog(index) {
  const directory = join(dataDir(), 'sessions');
  let dirStamp;
  try {
    dirStamp = statSessionStamp(directory);
  } catch (error) {
    dropSessionCatalog();
    return STAMP_ABSENT_CODES.has(error?.code) ? [] : null;
  }
  let catalog = sessionCatalog?.directory === directory ? sessionCatalog : null;
  let changed = false;
  if (!catalog) {
    const scan = scanSessionEntries(directory, index.rowsById, false);
    if (!scan) return null;
    catalog = {
      directory,
      dirStamp,
      dirSettled: isSettledSessionStamp(dirStamp),
      index,
      entries: scan.entries,
      heartbeatIds: scan.heartbeatIds,
      heartbeatMtimes: null,
      rows: null,
      dirty: new Set(),
      verifiedAt: Date.now(),
      verifying: null,
      rearm: false,
      timer: null,
    };
    sessionCatalog = catalog;
    changed = true;
  } else {
    // Files the background pass found with a new full stamp: their index row
    // can still match size + mtime (a same-length, mtime-preserving
    // replacement), so they are re-derived from the file itself.
    const forced = catalog.dirty;
    catalog.dirty = new Set();
    const ids = new Set(forced);
    if (catalog.index !== index) {
      for (const id of changedIndexIds(catalog.index, index)) ids.add(id);
      catalog.index = index;
      changed = true;
    }
    if (!catalog.dirSettled || !sameSessionStamp(catalog.dirStamp, dirStamp)) {
      const names = listSessionNames(directory);
      if (!names) {
        dropSessionCatalog();
        return null;
      }
      const present = new Set(names.sessionIds);
      for (const id of catalog.entries.keys()) {
        if (present.has(id)) continue;
        catalog.entries.delete(id);
        changed = true;
      }
      for (const id of names.sessionIds) if (!catalog.entries.has(id)) ids.add(id);
      catalog.heartbeatIds = names.heartbeatIds;
      catalog.dirStamp = dirStamp;
      catalog.dirSettled = isSettledSessionStamp(dirStamp);
    }
    for (const id of ids) {
      const entry = reconcileSessionFile(directory, id, index.rowsById.get(id), forced.has(id));
      if (entry) catalog.entries.set(id, entry);
      else catalog.entries.delete(id);
      changed = true;
    }
  }
  // Liveness: `.hb` sidecars are rewritten in place, so their mtimes are
  // probed every call (absent or unreadable contributes nothing).
  const heartbeatMtimes = new Map();
  for (const id of catalog.heartbeatIds) {
    const probe = probePath(join(directory, `${id}.hb`));
    if (probe.state === PROBE_PRESENT && probe.mtimeMs > 0) heartbeatMtimes.set(id, probe.mtimeMs);
  }
  if (!sameMtimes(heartbeatMtimes, catalog.heartbeatMtimes)) changed = true;
  catalog.heartbeatMtimes = heartbeatMtimes;
  if (changed || !catalog.rows) {
    catalog.rows = assembleCatalog(catalog.entries, index.rowsById, heartbeatMtimes).map(Object.freeze);
  }
  armCatalogVerify(catalog);
  // Rows (and everything in them) are frozen: callers share them read-only.
  return catalog.rows.slice();
}

function dropSessionCatalog() {
  if (sessionCatalog?.timer) clearTimeout(sessionCatalog.timer);
  sessionCatalog = null;
}

/** Schedules the next background pass: CATALOG_VERIFY_INTERVAL_MS after the
 *  last one started, unless one is already scheduled or running. */
function armCatalogVerify(catalog) {
  if (catalog.verifying) {
    // A listing during a pass: the next pass is scheduled when this one ends.
    catalog.rearm = true;
    return;
  }
  if (catalog.timer) return;
  const delay = Math.max(0, catalog.verifiedAt + CATALOG_VERIFY_INTERVAL_MS - Date.now());
  catalog.timer = setTimeout(() => {
    catalog.timer = null;
    if (sessionCatalog === catalog) startCatalogVerify(catalog);
  }, delay);
  catalog.timer.unref?.();
}

function startCatalogVerify(catalog) {
  if (catalog.verifying) return catalog.verifying;
  if (catalog.timer) clearTimeout(catalog.timer);
  catalog.timer = null;
  catalog.verifiedAt = Date.now();
  const verifying = verifyCatalogEntries(catalog, [...catalog.entries]).finally(() => {
    if (catalog.verifying !== verifying) return;
    catalog.verifying = null;
    if (!catalog.rearm) return;
    catalog.rearm = false;
    if (sessionCatalog === catalog) armCatalogVerify(catalog);
  });
  catalog.verifying = verifying;
  return verifying;
}

/** Marks every entry whose file no longer has the full stamp it was judged
 *  at dirty (a replacement brings a new inode and change time even when its
 *  size and mtime match). */
async function verifyCatalogEntries(catalog, snapshot) {
  for (let start = 0; start < snapshot.length; start += CATALOG_VERIFY_BATCH) {
    if (sessionCatalog !== catalog) return;
    await Promise.all(
      snapshot.slice(start, start + CATALOG_VERIFY_BATCH).map(async ([id, entry]) => {
        let changed;
        try {
          const info = await stat(join(catalog.directory, `${id}.json`), { bigint: true });
          changed = entry.kind === 'unreadable' || !sameSessionStamp(sessionStampOf(info), entry.stamp);
        } catch (error) {
          changed = entry.kind !== 'unreadable' || STAMP_ABSENT_CODES.has(error?.code);
        }
        if (changed && catalog.entries.get(id) === entry) catalog.dirty.add(id);
      })
    );
  }
  if (sessionCatalog !== catalog || catalog.dirty.size === 0) return;
  for (const listener of catalogListeners) {
    try {
      listener();
    } catch {
      /* a listener's failure is its own */
    }
  }
}

/** Run a background verification of the ordinary catalog now (or join the
 *  running one); resolves when it has finished. */
export function verifyStoredSessionCatalog() {
  return sessionCatalog ? startCatalogVerify(sessionCatalog) : Promise.resolve();
}

/** Test seam: forget the ordinary catalog and the parsed summary index. */
export function clearStoredSessionCatalog() {
  dropSessionCatalog();
  summaryIndexCache = null;
}

export function listStoredSessionSummaries(options = {}) {
  // The index is consulted on EVERY path: its rows are the authority that
  // must be retained whenever storage cannot be enumerated or an individual
  // session file cannot be read.
  const index = loadSummaryIndex();
  const indexRows = (heartbeatMtimes) =>
    index.rows &&
    leadRowsWithAgentHeartbeat(
      index.rows.map((row) => ({ ...row, heartbeatAt: positiveNumber(heartbeatMtimes.get(row.id), 0) }))
    ).sort(byRecentActivity);
  // An index that EXISTS but is unreadable (EACCES/EIO) is neither missing
  // nor empty: the scan still runs, and when IT cannot enumerate either, the
  // catalog reports nothing rather than inventing an empty truth.
  if (options.refreshFromStorage === true) {
    const heartbeatMtimes = sessionHeartbeatMtimes();
    return scanSessionFiles(heartbeatMtimes, index.rowsById, true) ?? indexRows(heartbeatMtimes) ?? [];
  }
  if (options.rebuildIfMissing === false) return indexRows(sessionHeartbeatMtimes()) ?? [];
  // A missing/malformed index leaves every file to be parsed (once per
  // stamp); a present one lets unchanged files reuse their durable summary.
  return ordinarySessionCatalog(index) ?? indexRows(sessionHeartbeatMtimes()) ?? [];
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

const STAMP_ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

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
  if (recordStat.state === PROBE_ABSENT) return readArchivedAgentResult(sessionId);
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
  const mode = options.includeMessages === true ? 'messages' : 'items';
  // Large, checkpoint-free item projections run off the daemon event loop.
  const offloadable =
    options.includeMessages !== true && checkpoint.state === PROBE_ABSENT && recordStat.size >= OFFLOAD_MIN_CHARS;
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
    produce: async (text) => {
      const stamp = readStamp;
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
      const checkpointAbsent = checkpoint.state === PROBE_ABSENT;
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
          includeMessages: options.includeMessages === true,
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
    },
  });
  // The record vanished between stat and read: same answer as an absent probe.
  if (readState === PROBE_ABSENT) return readArchivedAgentResult(sessionId);
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
