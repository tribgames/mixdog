/**
 * The ordinary session catalog engine: summary index (base + delta log),
 * session-file reconcile, `.hb` liveness and the background verification.
 *
 * Leaf by design (no store.mjs, no config, no workers): the cold reader
 * (store-summary-reader.mjs) runs one instance on its own thread for the JSON
 * path, and the session catalog DB worker (catalog-db/worker.mjs) runs another
 * that feeds SQLite. Both therefore detect exactly the same changes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
// Leaf helpers only: the three-way present/absent/unreadable classification
// and the strict record parser the authoritative store uses, so the catalog
// cannot disagree with it.
import { probePath, readTextFile, PROBE_PRESENT, PROBE_ABSENT } from './store/fs-probe.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from './lifecycle-scan.mjs';
import { isAgentOnlySession, isRootLeadSession, sessionVisibility } from './store-summary-visibility.mjs';
import { applySummaryLogText, summaryLogPath } from './store-summary-log.mjs';
import { dataDir } from './store-summary-locations.mjs';
import {
  desktopSession,
  importKey,
  inheritedFromSessionId,
  isStoredSessionId,
  positiveNumber,
  realTurnCount,
  workspaceSummary,
} from './store-summary-fields.mjs';
import { isRealTurnMessage } from './compact/user-message-kind.mjs';
import { byActivityThenId } from './catalog-db/schema.mjs';
import {
  sessionStampOf,
  statSessionStamp,
  sameSessionStamp,
  isSettledSessionStamp,
} from './store/canonical-reader.mjs';

export const STAMP_ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** The one catalog order of every listing path (JSON and DB): newest
 *  conversation activity first (see normalizedRow's lastUsedAt note), ties by
 *  id, so a fallback and the DB never disagree on equal activity times. */
export const byCatalogOrder = byActivityThenId;

// ── Stamp-keyed strict derivations ──────────────────────────────────────────
// Session metadata and catalog rows are small values derived from a strict
// parse of the whole record. They are reused only while the file still has
// the FULL stamp { dev, ino, size, mtimeNs, ctimeNs } the parsed bytes were
// proven to come from (stat → read → stat) and that stamp is past the racy
// window. Any other file — changed, replaced by another writer, unreadable —
// is read and strictly parsed again.
const STAMPED_DERIVATION_LIMIT = 2048;
const stampedDerivations = new Map(); // `${kind}|${path}` → { stamp, value }

export function observeStamp(path) {
  try {
    return statSessionStamp(path);
  } catch {
    return null;
  }
}

/** `{ state, value }`: `derive(text)` for the record at `path`, or its cached
 *  result while the file is provably unchanged. */
export function stampedDerivation(kind, path, derive) {
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

const SESSION_SUMMARY_INDEX_VERSION = 2;

// Mirror of lifecycle-api.mjs listLeadSessions visibility: the cold catalog
// must never surface worker/agent dispatches (memory ingest chunks, judges,
// spawned agents) — the authoritative engine excludes them, so a click on
// such a row dead-ends in "Session is not available." (user report).
const LEAD_OWNERS = new Set(['cli', 'user', 'mixdog']);

export function isLeadVisibleRow(row) {
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

export function normalizedRow(row, heartbeatAt = 0) {
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
    realTurnCount: realTurnCount(row),
    title: cleanText(row.title, 100),
    preview: cleanText(row.preview),
    generation: typeof row.generation === 'number' ? row.generation : 0,
    storageMtimeMs: positiveNumber(row.storageMtimeMs, 0),
    storageSize: positiveNumber(row.storageSize, 0),
    detachedReason: row.detachedReason || null,
    importKey: importKey(row),
    inheritedFromSessionId: inheritedFromSessionId(row),
  };
}

/** Newest heartbeat of each Lead's live agents, from rows carrying `heartbeatAt`. */
export function agentHeartbeatsByOwner(rows) {
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
  return agentHeartbeatByOwner;
}

function leadRowsWithAgentHeartbeat(rows) {
  const agentHeartbeatByOwner = agentHeartbeatsByOwner(rows);
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
      realTurnCount: messages.filter(isRealTurnMessage).length,
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

/** The row an entry contributes (before liveness overlays), or null. */
function entryRow(entry, id, indexRowsById) {
  if (!entry || entry.kind === 'none') return null;
  return (entry.kind === 'row' ? entry.row : indexRowsById.get(id)) || null;
}

/** Catalog rows of reconciled `entries`, in catalog order. */
function assembleCatalog(entries, indexRowsById, heartbeatMtimes) {
  const rows = [];
  for (const [id, entry] of entries) {
    const row = entryRow(entry, id, indexRowsById);
    if (row) rows.push({ ...row, heartbeatAt: positiveNumber(heartbeatMtimes.get(id), 0) });
  }
  return leadRowsWithAgentHeartbeat(rows).sort(byCatalogOrder);
}

/** Accounting needs hidden/closed children too, not the Lead-only listing.
 * Unknown ownership must not turn a partial catalog into an exact empty sum.
 * Ordinary ids are retained with no owner so a stale worker link cannot
 * reclassify a persisted ordinary session as a child. */
export function catalogSessionOwnershipLinks({ catalog, absent }) {
  if (absent) return [];
  if (!catalog) return null;
  const links = [];
  for (const [id, entry] of catalog.entries) {
    if (entry.kind === 'unreadable' || entry.kind === 'none') return null;
    const row = entryRow(entry, id, catalog.index.rowsById);
    if (!row) return null;
    links.push({ id, ownerSessionId: isAgentOnlySession(row) ? row.ownerSessionId : null });
  }
  return links;
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
export function scanSessionFiles(heartbeatMtimes, indexRowsById, forceRead) {
  const directory = join(dataDir(), 'sessions');
  const dirProbe = probePath(directory);
  if (dirProbe.state === PROBE_ABSENT) return [];
  if (dirProbe.state !== PROBE_PRESENT) return null;
  const scan = scanSessionEntries(directory, indexRowsById, forceRead);
  return scan && assembleCatalog(scan.entries, indexRowsById, heartbeatMtimes);
}

/** Listing from the index rows alone, or null without a valid index. */
export function indexListing(index, heartbeatMtimes) {
  return (
    index.rows &&
    leadRowsWithAgentHeartbeat(
      index.rows.map((row) => ({ ...row, heartbeatAt: positiveNumber(heartbeatMtimes.get(row.id), 0) }))
    ).sort(byCatalogOrder)
  );
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

/** The summary index, extending `cached` by appended log lines when it can. */
function readSummaryIndex(cached) {
  const indexPath = join(dataDir(), 'session-summaries.json');
  const baseStamp = observeStamp(indexPath);
  const logStamp = observeStamp(summaryLogPath(indexPath));
  if (cached?.indexPath !== indexPath) cached = null;
  if (cached && sameOptionalStamp(cached.baseStamp, baseStamp) && sameOptionalStamp(cached.logStamp, logStamp)) {
    return { index: cached, cacheable: true };
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
    return { index, cacheable: true };
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
  return {
    index,
    cacheable: !log.failed && (indexRead.state === PROBE_PRESENT || indexRead.state === PROBE_ABSENT),
  };
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

function sameMtimes(left, right) {
  if (!right || left.size !== right.size) return false;
  for (const [id, mtimeMs] of left) if (right.get(id) !== mtimeMs) return false;
  return true;
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

function unlistableRefresh() {
  return { rows: null, catalog: null, fresh: false, changedIds: null, absent: false };
}

function newSessionCatalog(directory, dirStamp, index, scan) {
  return {
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
}

/** Brings an existing `catalog` up to date with the index, the directory and
 *  the `hinted` ids: `{ changed, changedIds }`, or null when the directory
 *  can no longer be enumerated. */
function reconcileKnownCatalog(catalog, directory, dirStamp, index, hinted) {
  let changed = false;
  const changedIds = new Set();
  // Files the background pass found with a new full stamp: their index row
  // can still match size + mtime (a same-length, mtime-preserving
  // replacement), so they are re-derived from the file itself.
  const forced = catalog.dirty;
  catalog.dirty = new Set();
  const ids = new Set([...forced, ...hinted]);
  if (catalog.index !== index) {
    for (const id of changedIndexIds(catalog.index, index)) ids.add(id);
    catalog.index = index;
    changed = true;
  }
  if (!catalog.dirSettled || !sameSessionStamp(catalog.dirStamp, dirStamp)) {
    const names = listSessionNames(directory);
    if (!names) return null;
    const present = new Set(names.sessionIds);
    for (const id of catalog.entries.keys()) {
      if (present.has(id)) continue;
      catalog.entries.delete(id);
      changedIds.add(id);
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
    changedIds.add(id);
    changed = true;
  }
  return { changed, changedIds };
}

/** Liveness: `.hb` sidecars are rewritten in place, so their mtimes are
 *  probed every call (absent or unreadable contributes nothing). True when
 *  they differ from the previous probe. */
function refreshHeartbeatMtimes(catalog, directory) {
  const heartbeatMtimes = new Map();
  for (const id of catalog.heartbeatIds) {
    const probe = probePath(join(directory, `${id}.hb`));
    if (probe.state === PROBE_PRESENT && probe.mtimeMs > 0) heartbeatMtimes.set(id, probe.mtimeMs);
  }
  const differs = !sameMtimes(heartbeatMtimes, catalog.heartbeatMtimes);
  catalog.heartbeatMtimes = heartbeatMtimes;
  return differs;
}

/** Marks every entry of `snapshot` whose file no longer has the full stamp it
 *  was judged at dirty (a replacement brings a new inode and change time even
 *  when its size and mtime match). Stops early once `isCurrent()` is false. */
async function markChangedEntriesDirty(catalog, snapshot, isCurrent) {
  for (let start = 0; start < snapshot.length; start += CATALOG_VERIFY_BATCH) {
    if (!isCurrent()) return;
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
}

/**
 * One ordinary catalog with its own index cache, reconcile state, background
 * pass and change listeners.
 */
export function createOrdinaryCatalog() {
  let summaryIndexCache = null;
  let sessionCatalog = null;
  // Ids a writer of this process just changed on disk (storage hints): the
  // next refresh re-reconciles them against the index row and the file.
  let hintedIds = new Set();
  const listeners = new Set();

  function loadIndex() {
    const { index, cacheable } = readSummaryIndex(summaryIndexCache);
    if (cacheable) summaryIndexCache = index;
    return index;
  }

  function dropSessionCatalog() {
    if (sessionCatalog?.timer) clearTimeout(sessionCatalog.timer);
    sessionCatalog = null;
  }

  /**
   * Reconciles the catalog against storage: `{ rows, catalog, fresh,
   * changedIds, absent }`. `rows` are the listing (assembled only when
   * `assemble`), [] when the sessions directory is absent, null when it
   * cannot be enumerated. `fresh` means the catalog was (re)built from a full
   * scan; otherwise `changedIds` are the ids whose entry was dropped or
   * re-reconciled by this call.
   */
  function refresh(index, { assemble = true } = {}) {
    const directory = join(dataDir(), 'sessions');
    let dirStamp;
    try {
      dirStamp = statSessionStamp(directory);
    } catch (error) {
      dropSessionCatalog();
      const absent = STAMP_ABSENT_CODES.has(error?.code);
      return { rows: absent ? [] : null, catalog: null, fresh: false, changedIds: null, absent };
    }
    let catalog = sessionCatalog?.directory === directory ? sessionCatalog : null;
    const fresh = !catalog;
    let changed = true;
    let changedIds = new Set();
    const hinted = hintedIds;
    hintedIds = new Set();
    if (fresh) {
      const scan = scanSessionEntries(directory, index.rowsById, false);
      if (!scan) return unlistableRefresh();
      catalog = newSessionCatalog(directory, dirStamp, index, scan);
      sessionCatalog = catalog;
    } else {
      const reconciled = reconcileKnownCatalog(catalog, directory, dirStamp, index, hinted);
      if (!reconciled) {
        dropSessionCatalog();
        return unlistableRefresh();
      }
      ({ changed, changedIds } = reconciled);
    }
    if (refreshHeartbeatMtimes(catalog, directory)) changed = true;
    if (changed) catalog.rows = null;
    if (assemble) rowsOf(catalog);
    armCatalogVerify(catalog);
    // Rows (and everything in them) are frozen: callers share them read-only.
    return { rows: assemble ? catalog.rows.slice() : null, catalog, fresh, changedIds, absent: false };
  }

  /** The (frozen) listing of a reconciled catalog, assembled on demand. */
  function rowsOf(catalog) {
    catalog.rows ||= assembleCatalog(catalog.entries, catalog.index.rowsById, catalog.heartbeatMtimes).map(
      Object.freeze
    );
    return catalog.rows;
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

  /** Background pass: marks changed entries dirty and tells the listeners. */
  async function verifyCatalogEntries(catalog, snapshot) {
    await markChangedEntriesDirty(catalog, snapshot, () => sessionCatalog === catalog);
    if (sessionCatalog !== catalog || catalog.dirty.size === 0) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  return {
    loadIndex,
    refresh,
    rowsOf,
    /** The row `id` contributes to the current catalog (before overlays). */
    entryRow: (catalog, id) => entryRow(catalog.entries.get(id), id, catalog.index.rowsById),
    current: () => sessionCatalog,
    /** `listener()` runs when a background pass finds a session file that
     *  changed without a directory or index change. Returns the unsubscribe. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Run a background verification now (or join the running one). */
    verify: () => (sessionCatalog ? startCatalogVerify(sessionCatalog) : Promise.resolve()),
    /** Storage hints: `ids` changed on disk (a save landed, a delete removed
     *  the file). The next refresh stats them and re-reads a file its index
     *  row does not describe; a gone file drops its entry. Without a catalog
     *  the next refresh is a full scan anyway. */
    hint(ids) {
      if (sessionCatalog) for (const id of ids) hintedIds.add(id);
    },
    /** Forget the catalog and the parsed summary index. */
    clear() {
      dropSessionCatalog();
      summaryIndexCache = null;
      hintedIds = new Set();
    },
  };
}
